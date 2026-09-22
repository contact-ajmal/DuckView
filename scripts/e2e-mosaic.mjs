#!/usr/bin/env node
/**
 * Browser end-to-end check for the Mosaic Explore view and Mosaic dashboards, driven over the Chrome DevTools
 * Protocol (no Playwright).
 *   node scripts/e2e-mosaic.mjs [overview-explore|workbench-explore|mosaic-dashboard|data-apps] [screenshot.png]
 * Env: DUCKVIEW_URL (default http://localhost:4200), DUCKVIEW_ADMIN_EMAIL / DUCKVIEW_ADMIN_PASSWORD, CHROME (binary).
 * Signs in through the API, opens the app, renders the interactive profile of the Overview's dataset (or the first
 * tab's SQL), brushes a chart, and fails on any page exception, missing charts or a silent cross-filter.
 * The Overview scenario expects at least one dataset in the workspace; the dashboard scenario creates a Mosaic
 * dashboard through the UI, generates its spec from the first data file, saves it, brushes, reloads and deletes it.
 * The data-apps scenario creates a Streamlit app, has a non-admin editor request publishing it, approves it in
 * Settings → Data apps, runs it from the editor (whatever apps.runtime the server uses — with docker it checks the
 * container too) and waits for Streamlit to render the app's table and chart in the preview. The browser-app
 * scenario creates an app that runs in the viewer's browser (stlite) through the New-app dialog, waits for Pyodide
 * to render it in the editor's preview and checks that it reads as the viewer, read-only.
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
    // Third-party resources (web fonts) failing to load in a headless profile say nothing about the app.
    if (m.params.entry.url && !m.params.entry.url.startsWith(BASE)) return;
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
/**
 * Evaluates inside the first frame whose URL starts with `prefix` — the app preview lives on the apps origin, so the
 * page cannot reach into it; DevTools can, through an isolated world bound to that frame.
 */
const frameEval = async (prefix, expression) => {
  const tree = (await send('Page.getFrameTree')).result.frameTree;
  const find = (n) => (n.frame.url.startsWith(prefix) ? n.frame : (n.childFrames ?? []).map(find).find(Boolean));
  const frame = find(tree);
  if (!frame) return undefined;
  const world = await send('Page.createIsolatedWorld', { frameId: frame.id, worldName: 'e2e' });
  const r = await send('Runtime.evaluate', { expression, contextId: world.result.executionContextId, returnByValue: true, awaitPromise: true });
  return r.result?.result?.value;
};
const waitForFrame = async (prefix, expression, timeoutMs = 30000, label = expression) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await frameEval(prefix, expression).catch(() => false)) return true;
    await sleep(400);
  }
  throw new Error(`timeout waiting in the app frame for: ${label}`);
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
const authed = (url, init = {}) => fetch(`${BASE}${url}`, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${login.token}`, ...(init.headers ?? {}) } });
// React inputs ignore a plain `.value =`; set through the prototype setter and fire the event React listens to.
const setField = (selector, value, event = 'input') => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set; set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event(${JSON.stringify(event)}, { bubbles: true })); return el.value; })()`);
const clickButton = (text, which = 'first') => evaluate(`(() => { const all = [...document.querySelectorAll('button')].filter(b => b.textContent.trim() === ${JSON.stringify(text)}); const b = ${JSON.stringify(which)} === 'last' ? all.at(-1) : all[0]; if (!b) throw new Error('no button: ' + ${JSON.stringify(text)}); b.click(); return true; })()`);
let cleanup = null;
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
  else if (scenario === 'data-apps') {
    const { execFileSync } = await import('node:child_process');
    const wsList = await (await authed('/api/workspaces')).json();
    const wsId = wsList.workspaces?.[0]?.id ?? wsList[0]?.id;
    const code = 'import streamlit as st\nfrom duckview.streamlit import connect, query\n\nst.title("E2E runtime app")\ndv = connect()\ndf = query("SELECT range AS n, range * range AS sq FROM range(12)")\nst.metric("Rows", len(df))\nst.dataframe(df, hide_index=True)\nst.bar_chart(df, x="n", y="sq")\n';
    const created = await (await authed(`/api/workspaces/${wsId}/apps`, { method: 'POST', body: JSON.stringify({ name: 'E2E runtime app', description: 'phase-three check', files: { 'app.py': code, 'requirements.txt': '' } }) })).json();
    const appId = created.app.id;
    // A non-admin editor of the workspace asks to publish it.
    const editorEmail = `e2e-editor-${Date.now()}@example.com`;
    const editor = (await (await authed('/api/admin/users', { method: 'POST', body: JSON.stringify({ email: editorEmail, password: 'e2e-editor-pass-123', role: 'USER' }) })).json()).user;
    await authed(`/api/workspaces/${wsId}/members`, { method: 'PUT', body: JSON.stringify({ subject_type: 'user', subject_id: editor.id, role: 'EDITOR' }) });
    const editorToken = (await (await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: editorEmail, password: 'e2e-editor-pass-123' }) })).json()).token;
    const request = await (await fetch(`${BASE}/api/apps/${appId}/publish`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${editorToken}` }, body: JSON.stringify({ audience: 'org', note: 'for the whole team' }) })).json();
    report.details.request = { outcome: request.outcome, visibility: request.app?.visibility };
    cleanup = async () => {
      await authed(`/api/apps/${appId}`, { method: 'DELETE' });
      await authed(`/api/admin/users/${editor.id}`, { method: 'DELETE' });
    };
    // The administrator reviews it in Settings → Data apps.
    await send('Page.navigate', { url: `${BASE}/#/settings/apps` });
    await waitFor(`document.body.innerText.includes('E2E runtime app') && document.body.innerText.includes('for the whole team')`, 30000, 'publish request listed');
    report.details.settings = { runtimeCard: await evaluate(`[...document.querySelectorAll('section')].find(s => s.innerText.startsWith('RUNTIME') || s.innerText.toUpperCase().startsWith('RUNTIME'))?.innerText.slice(0, 400) ?? null`) };
    { const shot = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(out.replace('.png', '_review.png'), Buffer.from(shot.result.data, 'base64')); }
    await clickButton('Approve');
    await waitFor(`document.body.innerText.includes('Nothing waiting')`, 15000, 'request approved');
    report.details.approved = (await (await authed(`/api/apps/${appId}`)).json()).app.visibility;
    // Run it from the editor and wait for Streamlit to render inside the preview iframe.
    await send('Page.navigate', { url: `${BASE}/#/apps/${appId}` });
    await waitFor(`[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Run')`, 20000, 'editor loaded');
    report.details.audienceBadge = await evaluate(`document.body.innerText.includes('everyone')`);
    await clickButton('Run');
    const appsOrigin = new URL((await (await authed(`/api/apps/${appId}/session`, { method: 'POST', body: '{}' })).json()).app_url, BASE).origin;
    report.details.appsOrigin = appsOrigin;
    await waitForFrame(appsOrigin, `!!document.querySelector('[data-testid="stAppViewContainer"]') && document.body.innerText.includes('E2E runtime app') && !!document.querySelector('[data-testid="stMetricValue"]')`, 180000, 'streamlit rendered in the preview');
    await waitForFrame(appsOrigin, `!!document.querySelector('[data-testid="stVegaLiteChart"] canvas, [data-testid="stVegaLiteChart"] svg, .vega-embed')`, 60000, 'chart rendered');
    // Isolation: the preview is on another origin than the UI — the page cannot reach into it, nor it out.
    report.details.isolation = { uiOrigin: await evaluate('location.origin'), frameOrigin: await frameEval(appsOrigin, 'location.origin'), pageSeesFrame: await evaluate(`(() => { try { return !!document.querySelector('iframe').contentDocument; } catch { return false; } })()`), frameSeesSession: await frameEval(appsOrigin, `(() => { try { return !!localStorage.getItem('duckview.session') || !!parent.localStorage.getItem('duckview.session'); } catch { return false; } })()`) };
    await sleep(2500);
    const app = (await (await authed(`/api/apps/${appId}`)).json()).app;
    report.details.app = { status: app.status, runtime: app.runtime, runtime_ref: app.runtime_ref, visibility: app.visibility, publish_status: app.publish_status };
    report.details.rendered = await frameEval(appsOrigin, `(() => { const d = document; return { metric: d.querySelector('[data-testid="stMetricValue"]')?.textContent, chart: !!d.querySelector('[data-testid="stVegaLiteChart"]'), dataframe: !!d.querySelector('[data-testid="stDataFrame"]'), exception: d.querySelector('[data-testid="stException"]')?.innerText ?? null }; })()`);
    if (app.runtime === 'docker') {
      const inspect = JSON.parse(execFileSync('docker', ['inspect', app.runtime_ref]).toString())[0];
      report.details.container = { running: inspect.State.Running, image: inspect.Config.Image, user: inspect.Config.User, readOnly: inspect.HostConfig.ReadonlyRootfs, capDrop: inspect.HostConfig.CapDrop, tokenInArgs: /dv_[A-Za-z0-9]{10,}/.test(JSON.stringify(inspect.Config.Cmd) + JSON.stringify(inspect.Args)) };
    }
    report.details.charts = report.details.rendered.chart ? 1 : 0;
    { const shot = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(out.replace('.png', '_running.png'), Buffer.from(shot.result.data, 'base64')); }
    // A shared link to the app, opened with no app cookie: bounced through the UI (signed in) and back to the app.
    await send('Network.clearBrowserCookies');
    await send('Page.navigate', { url: `${appsOrigin}/apps/${appId}/` });
    await waitFor(`location.origin === ${JSON.stringify(appsOrigin)} && !!document.querySelector('[data-testid="stMetricValue"]')`, 60000, 'shared link opened the app');
    report.details.sharedLink = { landed: await evaluate('location.href'), metric: await evaluate(`document.querySelector('[data-testid="stMetricValue"]')?.textContent`) };
    await send('Page.navigate', { url: `${BASE}/#/apps/${appId}` });
    await sleep(1500);
    // Delete it while the preview tab is still open (its Streamlit client keeps reconnecting): nothing may survive.
    // The tab's failed reconnects (503, then 404) are expected from here on and are not counted as page errors.
    const errorsBefore = errors.length;
    await authed(`/api/apps/${appId}`, { method: 'DELETE' });
    await sleep(6000);
    report.details.reconnectErrorsIgnored = errors.splice(errorsBefore).length;
    report.details.afterDelete = { app: (await authed(`/api/apps/${appId}`)).status, containers: app.runtime === 'docker' ? execFileSync('docker', ['ps', '-aq', '--filter', `label=duckview.app=${appId}`]).toString().trim().split(/\s+/).filter(Boolean).length : null };
  }
  else if (scenario === 'browser-app') {
    const wsList = await (await authed('/api/workspaces')).json();
    const wsId = wsList.workspaces?.[0]?.id ?? wsList[0]?.id;
    // Through the New-app dialog, choosing "In the viewer's browser".
    await send('Page.navigate', { url: `${BASE}/#/apps` });
    await waitFor(`[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'New app')`, 20000, 'gallery');
    await clickButton('New app');
    await waitFor(`!!document.querySelector('input[placeholder="Sales explorer"]')`, 10000, 'new-app dialog');
    await setField('input[placeholder="Sales explorer"]', 'E2E browser app');
    await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.includes("In the viewer's browser")).click(); true`);
    await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.includes('Blank')).click(); true`);
    await clickButton('Create & open');
    await waitFor(`/#\\/apps\\/[0-9a-f-]{36}$/.test(location.hash)`, 20000, 'editor opened');
    const appId = /#\/apps\/([0-9a-f-]{36})/.exec(await evaluate('location.hash'))[1];
    cleanup = async () => { await authed(`/api/apps/${appId}`, { method: 'DELETE' }); };
    report.details.created = (await (await authed(`/api/apps/${appId}`)).json()).app.execution;
    // The code: reads the workspace as the viewer, tries to write.
    const code = 'import streamlit as st\nfrom duckview.streamlit import connect, query, viewer\n\nst.title("E2E browser app")\ndv = connect()\ndf = query("SELECT range AS n, range * range AS sq FROM range(9)")\nst.metric("Rows", len(df))\nst.caption(f"viewer {viewer()[\'email\']}")\nst.bar_chart(df, x="n", y="sq")\ntry:\n    dv.query("CREATE TABLE e2e_browser_write AS SELECT 1")\n    st.write("WRITE-ALLOWED")\nexcept Exception as e:\n    st.write(f"write refused {getattr(e, \'status\', \'?\')}")\n';
    await authed(`/api/apps/${appId}`, { method: 'PATCH', body: JSON.stringify({ files: { 'app.py': code, 'requirements.txt': '' } }) });
    await send('Page.reload');
    const appsOrigin = new URL((await (await authed(`/api/apps/${appId}/session`, { method: 'POST', body: '{}' })).json()).app_url, BASE).origin;
    const t0 = Date.now();
    await waitForFrame(appsOrigin, `document.body.innerText.includes('write refused') || document.body.innerText.includes('WRITE-ALLOWED') || !!document.querySelector('[data-testid="stException"]')`, 180000, 'stlite rendered in the preview');
    await waitForFrame(appsOrigin, `!!document.querySelector('[data-testid="stVegaLiteChart"] canvas, [data-testid="stVegaLiteChart"] svg, .vega-embed')`, 60000, 'chart rendered');
    await sleep(1500);
    report.details.bootSeconds = Math.round((Date.now() - t0) / 1000);
    report.details.rendered = await frameEval(appsOrigin, `(() => { const d = document; return { metric: d.querySelector('[data-testid="stMetricValue"]')?.textContent, text: d.body.innerText.slice(0, 400), chart: !!d.querySelector('[data-testid="stVegaLiteChart"]'), exception: d.querySelector('[data-testid="stException"]')?.innerText ?? null }; })()`);
    report.details.controls = { runButton: await evaluate(`[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Run')`), badge: await evaluate(`document.body.innerText.includes("runs in the viewer's browser")`) };
    report.details.serverProcess = (await (await authed(`/api/apps/${appId}`)).json()).app.runtime_ref;
    report.details.writeHappened = (await (await authed(`/api/workspaces/${wsId}/query`, { method: 'POST', body: JSON.stringify({ sql: "SELECT count(*) FROM information_schema.tables WHERE table_name = 'e2e_browser_write'" }) })).json()).rows?.[0]?.[0];
    report.details.charts = report.details.rendered?.chart ? 1 : 0;
  }
  else if (scenario === 'mosaic-dashboard') {
    const wsList = await (await authed('/api/workspaces')).json();
    const wsId = wsList.workspaces?.[0]?.id ?? wsList[0]?.id;
    const catalog = await (await authed(`/api/workspaces/${wsId}/catalog`)).json();
    // Prefer a file whose first column is numeric (the brush step drags across a histogram); any file otherwise.
    const files = (catalog.files ?? []).map((f) => f.path);
    const file = process.env.E2E_FILE ?? files.find((p) => /tripdata/i.test(p)) ?? files[0];
    if (!file) throw new Error('the first workspace has no data file to generate from');
    report.details.file = file;
    // 1. Create a Mosaic dashboard through the list page.
    await send('Page.navigate', { url: `${BASE}/#/dashboards` });
    await waitFor(`[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'New dashboard')`, 40000, 'dashboards list');
    await clickButton('New dashboard');
    await waitFor(`!!document.querySelector('input[placeholder="Revenue overview"]')`, 10000, 'new dashboard modal');
    const dashName = `E2E Mosaic ${Date.now()}`;
    await setField('input[placeholder="Revenue overview"]', dashName);
    await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.trim().startsWith('Mosaic')).click(); true`);
    await clickButton('Create');
    await waitFor(`new RegExp('^#/dashboards/[^/]+$').test(location.hash)`, 15000, 'navigated to the new dashboard');
    const dashId = await evaluate(`location.hash.split('/').pop()`);
    cleanup = () => authed(`/api/dashboards/${dashId}`, { method: 'DELETE' });
    report.details.dashboardId = dashId;
    // 2. Generate a spec from the first data file.
    await waitFor(`[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Generate from dataset')`, 20000, 'empty Mosaic dashboard');
    await clickButton('Generate from dataset');
    await waitFor(`[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'File')`, 10000, 'generator modal');
    await clickButton('File');
    await waitFor(`!!document.querySelector('select') && document.querySelector('select').options.length > 0`, 20000, 'file list');
    await setField('select', file, 'change');
    await clickButton('Generate', 'last'); // the header has a "Generate" button too; the modal's comes last
    await waitFor(`document.querySelectorAll('.mosaic-dashboard svg').length > 0 || !!document.querySelector('.mosaic-dashboard .text-red-200')`, 90000, 'generated dashboard rendered');
    await sleep(2500);
    report.details.plots = await evaluate(`document.querySelectorAll('.mosaic-dashboard svg').length`);
    report.details.editorOpen = await evaluate(`!!document.querySelector('.cm-editor')`);
    report.details.editorLines = await evaluate(`document.querySelectorAll('.cm-line').length`);
    report.details.tableRows = await evaluate(`document.querySelectorAll('.mosaic-dashboard tbody tr').length`);
    report.details.error = await evaluate(`document.querySelector('.mosaic-dashboard .text-red-200')?.textContent ?? null`);
    { const shot0 = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(out.replace('.png', '_editing.png'), Buffer.from(shot0.result.data, 'base64')); }
    // 3. Save, then confirm the spec is persisted through the API.
    await evaluate(`document.querySelector('button[title^="Save the spec"]').click(); true`);
    await waitFor(`document.body.textContent.includes('saved')`, 15000, 'saved indicator');
    const persisted = (await (await authed(`/api/dashboards/${dashId}`)).json()).dashboard;
    report.details.persisted = { kind: persisted.kind, hasSpec: !!persisted.spec?.vconcat, datasets: Object.keys(persisted.spec?.data ?? {}) };
    // 4. Brush the first histogram: the table (filtered by the same selection) must change.
    const box = await evaluate(`(() => { const s = document.querySelector('.mosaic-dashboard svg'); const r = s.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
    const y = box.y + box.h * 0.5;
    const x0 = box.x + box.w * 0.25, x1 = box.x + box.w * 0.45;
    const secondBefore = await evaluate(`document.querySelectorAll('.mosaic-dashboard svg')[1]?.innerHTML.length ?? 0`);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y, button: 'left', clickCount: 1 });
    for (let i = 1; i <= 8; i++) await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0 + ((x1 - x0) * i) / 8, y, button: 'left' });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x1, y, button: 'left', clickCount: 1 });
    await sleep(3000);
    report.details.brush = { secondChartChanged: (await evaluate(`document.querySelectorAll('.mosaic-dashboard svg')[1]?.innerHTML.length ?? 0`)) !== secondBefore };
    // 5. Reload: the saved spec renders on its own, editor closed.
    await send('Page.navigate', { url: `${BASE}/#/dashboards` });
    await sleep(500);
    await send('Page.navigate', { url: `${BASE}/#/dashboards/${dashId}` });
    await waitFor(`document.querySelectorAll('.mosaic-dashboard svg').length > 0`, 90000, 'reloaded dashboard rendered');
    await sleep(1500);
    report.details.reloaded = { plots: await evaluate(`document.querySelectorAll('.mosaic-dashboard svg').length`), editorOpen: await evaluate(`!!document.querySelector('.cm-editor')`), badge: await evaluate(`document.body.textContent.includes('Mosaic')`) };
    report.details.charts = report.details.reloaded.plots;
  }
  const d = report.details;
  const problems = [];
  if (!(d.charts > 0)) problems.push('no charts rendered');
  if (scenario === 'mosaic-dashboard') {
    if (!d.editorOpen) problems.push('the editor did not open after generating');
    if (!d.persisted?.hasSpec) problems.push('the spec was not persisted');
    if (d.brush && !d.brush.secondChartChanged) problems.push('brushing did not update the other charts');
    if (d.reloaded?.editorOpen) problems.push('the editor should be closed in view mode');
  }
  if (scenario === 'overview-explore' && d.brush && !d.brush.secondChartChanged) problems.push('brushing did not update the other charts');
  if (scenario === 'browser-app') {
    if (d.created !== 'browser') problems.push('the dialog did not create an in-browser app');
    if (d.rendered?.metric !== '9') problems.push(`the app did not read its data (metric ${d.rendered?.metric})`);
    if (!/viewer admin@example\.com/.test(d.rendered?.text ?? '')) problems.push('the app does not know its viewer');
    if (!/write refused 403/.test(d.rendered?.text ?? '') || d.writeHappened !== 0) problems.push(`the viewer credential was not read-only (${d.rendered?.text}, table count ${d.writeHappened})`);
    if (d.rendered?.exception) problems.push(`the app raised: ${d.rendered.exception}`);
    if (d.controls?.runButton || d.serverProcess) problems.push('an in-browser app shows server controls or has a process');
  }
  if (scenario === 'data-apps') {
    if (d.request?.outcome !== 'pending' || d.request?.visibility !== 'workspace') problems.push(`the editor's publish was not held for review (${JSON.stringify(d.request)})`);
    if (d.approved !== 'org') problems.push('approval did not publish the app');
    if (d.rendered?.metric !== '12') problems.push(`the app did not compute its data (metric ${d.rendered?.metric})`);
    if (d.rendered?.exception) problems.push(`the app raised: ${d.rendered.exception}`);
    if (d.container && (!d.container.running || !d.container.readOnly || d.container.tokenInArgs)) problems.push(`container not as expected: ${JSON.stringify(d.container)}`);
    if (d.sharedLink?.metric !== '12') problems.push(`a shared app link did not open the app: ${JSON.stringify(d.sharedLink)}`);
    if (d.isolation && (d.isolation.uiOrigin === d.isolation.frameOrigin || d.isolation.pageSeesFrame || d.isolation.frameSeesSession)) problems.push(`the app is not isolated from the UI: ${JSON.stringify(d.isolation)}`);
    if (d.afterDelete?.app !== 404 || d.afterDelete?.containers) problems.push(`the deleted app left something running: ${JSON.stringify(d.afterDelete)}`);
  }
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
  if (cleanup) await cleanup().catch(() => undefined);
  console.log(JSON.stringify(report, null, 2));
  console.log(report.ok ? `\n✓ ${scenario} passed — screenshot: ${out}` : `\n✗ ${scenario} failed`);
  ws.close();
  chrome.kill();
  process.exitCode = report.ok ? 0 : 1;
  try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 }); } catch { /* chrome still closing */ }
}
