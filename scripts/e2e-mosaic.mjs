#!/usr/bin/env node
/**
 * Browser end-to-end check for the Mosaic Explore view, driven over the Chrome DevTools Protocol (no Playwright).
 *   node scripts/e2e-mosaic.mjs [overview-explore|workbench-explore] [screenshot.png]
 * Env: DUCKVIEW_URL (default http://localhost:4200), DUCKVIEW_ADMIN_EMAIL / DUCKVIEW_ADMIN_PASSWORD, CHROME (binary).
 * Signs in through the API, opens the app, renders the interactive profile of the Overview's dataset (or the first
 * tab's SQL), brushes a chart, and fails on any page exception, missing charts or a silent cross-filter.
 * The Overview scenario expects at least one dataset in the workspace.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const WebSocket = require(require.resolve('ws', { paths: [path.resolve(path.dirname(new URL(import.meta.url).pathname), '../packages/server')] }));

const CANDIDATES = [process.env.CHROME, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean);
const CHROME = CANDIDATES.find((c) => fs.existsSync(c));
if (!CHROME) {
  console.error('No Chrome/Chromium binary found; set CHROME=/path/to/chrome');
  process.exit(2);
}
const BASE = process.env.DUCKVIEW_URL ?? 'http://localhost:4200';
const EMAIL = process.env.DUCKVIEW_ADMIN_EMAIL ?? 'admin@example.com';
const PASSWORD = process.env.DUCKVIEW_ADMIN_PASSWORD ?? 'change-me-now';
const [scenario = 'overview-explore', out = path.join(os.tmpdir(), `duckview-e2e-${scenario}.png`)] = process.argv.slice(2);
const port = 9333 + Math.floor(Math.random() * 500);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'cdp-'));
const chrome = spawn(CHROME, [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--headless=new', '--disable-gpu', '--hide-scrollbars', '--window-size=1440,1400', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targets() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json`);
      return await r.json();
    } catch {
      await sleep(200);
    }
  }
  throw new Error('chrome did not start');
}

const login = await (await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) })).json();
if (!login.token) {
  console.error('login failed', login);
  process.exit(2);
}
const list = await targets();
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
await new Promise((r) => ws.on('open', r));
let id = 0;
const pending = new Map();
const consoleMsgs = [];
const errors = [];
ws.on('message', (raw) => {
  const m = JSON.parse(raw.toString());
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  } else if (m.method === 'Runtime.consoleAPICalled') {
    const text = m.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
    consoleMsgs.push(`[${m.params.type}] ${text}`);
  } else if (m.method === 'Runtime.exceptionThrown') {
    errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
  } else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
    errors.push(`[log] ${m.params.entry.text} ${m.params.entry.url ?? ''}`);
  }
});
const send = (method, params = {}) => new Promise((resolve) => {
  const i = ++id;
  pending.set(i, resolve);
  ws.send(JSON.stringify({ id: i, method, params }));
});
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? 'evaluate failed');
  return r.result?.result?.value;
};
const waitFor = async (expression, timeoutMs = 30000, label = expression) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await evaluate(expression)) return true;
    await sleep(250);
  }
  throw new Error(`timeout waiting for: ${label}`);
};

await send('Page.enable');
await send('Runtime.enable');
await send('Log.enable');
await send('Page.navigate', { url: `${BASE}/` });
await sleep(800);
await evaluate(`localStorage.setItem('duckview.session', ${JSON.stringify(login.token)}); 'ok'`);
await send('Page.reload');
await sleep(1500);
await waitFor(`!!document.querySelector('header nav')`, 30000, 'signed-in shell');

const report = { scenario, ok: false, details: {} };
try {
  if (scenario === 'overview-explore') {
    await send('Page.navigate', { url: `${BASE}/#/` });
    await waitFor(`!!document.querySelector('button[title*="Interactive, cross-filtered"]')`, 40000, 'overview loaded with Explore button');
    await evaluate(`document.querySelector('button[title*="Interactive, cross-filtered"]').click(); 'clicked'`);
    await waitFor(`document.querySelectorAll('.mosaic-cell svg').length > 0`, 60000, 'mosaic charts rendered');
    await sleep(2500);
    report.details.charts = await evaluate(`document.querySelectorAll('.mosaic-cell svg').length`);
    report.details.cellTitles = await evaluate(`[...document.querySelectorAll('.mosaic-cell-title span')].map(e => e.textContent)`);
    report.details.tableRows = await evaluate(`document.querySelectorAll('.mosaic-table-host tbody tr').length`);
    report.details.tableCols = await evaluate(`[...document.querySelectorAll('.mosaic-table-host thead th')].map(e => e.textContent.trim()).slice(0, 8)`);
    report.details.rectsInFirstChart = await evaluate(`document.querySelector('.mosaic-cell svg')?.querySelectorAll('rect').length ?? 0`);
    report.details.status = await evaluate(`document.querySelector('.mosaic-explore')?.textContent.slice(0, 160)`);
    // Brush: simulate a drag on the first histogram and check that the table/other charts update (row count changes).
    const box = await evaluate(`(() => { const s = document.querySelector('.mosaic-cell svg'); const r = s.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
    const y = box.y + box.h * 0.5;
    const x0 = box.x + box.w * 0.25, x1 = box.x + box.w * 0.45; // VendorID axis 1..6 → roughly 2..3, which has data
    { const shot0 = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(out.replace('.png', '_before.png'), Buffer.from(shot0.result.data, 'base64')); }
    const rowsBefore = await evaluate(`document.querySelector('.mosaic-table-host tbody')?.children.length ?? 0`);
    const secondChartBefore = await evaluate(`document.querySelectorAll('.mosaic-cell svg')[1]?.innerHTML.length ?? 0`);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y, button: 'left', clickCount: 1 });
    for (let i = 1; i <= 8; i++) await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0 + ((x1 - x0) * i) / 8, y, button: 'left' });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x1, y, button: 'left', clickCount: 1 });
    await sleep(3000);
    report.details.brush = { rowsBefore, rowsAfter: await evaluate(`document.querySelector('.mosaic-table-host tbody')?.children.length ?? 0`), firstBarTextAfter: await evaluate(`[...document.querySelectorAll('.mosaic-cell')[3].querySelectorAll('text')].map(t => t.textContent).slice(0, 6)`), secondChartChanged: (await evaluate(`document.querySelectorAll('.mosaic-cell svg')[1]?.innerHTML.length ?? 0`)) !== secondChartBefore, selectionRect: await evaluate(`!!document.querySelector('.mosaic-cell svg .selection, .mosaic-cell svg rect[fill*="var("], .mosaic-cell svg g[aria-label="selection"]')`) };
  } else if (scenario === 'workbench-explore') {
    await send('Page.navigate', { url: `${BASE}/#/query` });
    await waitFor(`[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'explore')`, 40000, 'workbench loaded');
    await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'explore').click(); 'clicked'`);
    await waitFor(`document.querySelectorAll('.mosaic-cell svg').length > 0 || !!document.querySelector('.mosaic-explore .text-red-200')`, 60000, 'explore rendered or errored');
    await sleep(2000);
    report.details.charts = await evaluate(`document.querySelectorAll('.mosaic-cell svg').length`);
    report.details.error = await evaluate(`document.querySelector('.mosaic-explore .text-red-200')?.textContent ?? null`);
    report.details.cellTitles = await evaluate(`[...document.querySelectorAll('.mosaic-cell-title span')].map(e => e.textContent)`);
  }
  const d = report.details;
  const problems = [];
  if (!(d.charts > 0)) problems.push('no charts rendered');
  if (scenario === 'overview-explore' && d.brush && !d.brush.secondChartChanged) problems.push('brushing did not update the other charts');
  if (d.error) problems.push(`view error: ${d.error}`);
  report.ok = problems.length === 0;
  if (problems.length) report.error = problems.join('; ');
} catch (e) {
  report.error = String(e.message ?? e);
} finally {
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  if (shot.result?.data) fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
  report.consoleErrors = consoleMsgs.filter((m) => m.startsWith('[error]') || m.startsWith('[warning]')).slice(0, 15);
  report.exceptions = errors.slice(0, 10);
  if (report.exceptions.length) report.ok = false;
  console.log(JSON.stringify(report, null, 2));
  console.log(report.ok ? `\n✓ ${scenario} passed — screenshot: ${out}` : `\n✗ ${scenario} failed`);
  ws.close();
  chrome.kill();
  process.exitCode = report.ok ? 0 : 1;
  try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 }); } catch { /* chrome still closing */ }
}
