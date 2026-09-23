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
 * to render it in the editor's preview and checks that it reads as the viewer, read-only. The frameworks scenario
 * runs a real Dash app (a callback queries DuckView) and the Gradio template (a click runs SQL through the queue)
 * behind the proxy, in the editor's cross-origin preview. The alert-channels scenario (server started with
 * DUCKVIEW__notifications__allow_private_targets=true) creates a webhook channel in Alerts → Channels, sends a test
 * and checks the delivery and its signature against a receiver the script runs. The sql-alerts scenario (same server
 * setting) builds a threshold alert in the dialog, tests it, checks it, and drives it through triggered and resolved
 * while the receiver collects the webhooks. The snapshots scenario (same setting) schedules a grid dashboard in the
 * dialog, sends it now, and renders a Mosaic dashboard; both pictures are saved next to the screenshot. The
 * access-policies scenario creates a row filter and a mask in Governance, previews it as a viewer, then signs in as
 * that viewer and opens a Mosaic dashboard over the protected table: only the permitted region may show. The
 * catalog-lineage scenario describes a table in Governance → Catalog and traces it in Governance → Lineage.
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
  else if (scenario === 'frameworks') {
    const wsList = await (await authed('/api/workspaces')).json();
    const wsId = wsList.workspaces?.[0]?.id ?? wsList[0]?.id;
    const dashCode = 'import duckview\nimport plotly.express as px\nfrom dash import Dash, Input, Output, dcc, html, dash_table\nfrom flask import request\n\ndv = duckview.connect()\napp = Dash(__name__, title="E2E dash")\napp.layout = html.Div([html.H2("E2E dash"), dcc.Slider(3, 12, 1, value=6, id="n"), html.Div(id="who"), dcc.Graph(id="g"), dash_table.DataTable(id="t")])\n\n\n@app.callback(Output("g", "figure"), Output("t", "data"), Output("who", "children"), Input("n", "value"))\ndef show(n):\n    df = dv.query(f"SELECT range AS x, range * range AS y FROM range({int(n)})")\n    who = duckview.viewer_from_headers(request.headers)["email"]\n    return px.bar(df, x="x", y="y"), df.to_dict("records"), f"rows {len(df)} viewer {who}"\n\n\nif __name__ == "__main__":\n    app.run()\n';
    const dash = (await (await authed(`/api/workspaces/${wsId}/apps`, { method: 'POST', body: JSON.stringify({ name: 'E2E dash', source: { code: dashCode, kind: 'dash' } }) })).json()).app;
    const grad = (await (await authed(`/api/workspaces/${wsId}/apps`, { method: 'POST', body: JSON.stringify({ name: 'E2E gradio', source: { template: 'gradio-query' } }) })).json()).app;
    cleanup = async () => { for (const a of [dash, grad]) await authed(`/api/apps/${a.id}`, { method: 'DELETE' }); };
    const appsOrigin = new URL((await (await authed(`/api/apps/${dash.id}/session`, { method: 'POST', body: '{}' })).json()).app_url, BASE).origin;
    const open = async (a) => {
      await send('Page.navigate', { url: `${BASE}/#/apps/${a.id}` });
      await waitFor(`[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Run')`, 20000, `${a.name} editor`);
      await clickButton('Run');
    };
    // Dash: the callback runs through the proxy, queries DuckView and names the viewer.
    await open(dash);
    await waitForFrame(appsOrigin, `document.body.innerText.includes('rows 6 viewer admin@example.com') && !!document.querySelector('.js-plotly-plot .bars, .js-plotly-plot .trace')`, 240000, 'dash rendered its callback');
    report.details.dash = await frameEval(appsOrigin, `({ path: location.pathname, text: document.body.innerText.slice(0, 200), plot: !!document.querySelector('.js-plotly-plot'), rows: document.querySelectorAll('.dash-spreadsheet tbody tr, .dash-table-container tr').length })`);
    report.details.dashBadge = await evaluate(`document.body.innerText.includes('Dash')`);
    { const shot = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(out.replace('.png', '_dash.png'), Buffer.from(shot.result.data, 'base64')); }
    // Gradio: served at its root behind the stripped prefix; a click queues the SQL and the answer comes back.
    await open(grad);
    await waitForFrame(appsOrigin, `!!document.querySelector('gradio-app') && [...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Run')`, 240000, 'gradio rendered');
    await frameEval(appsOrigin, `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Run').click(), true`);
    await waitForFrame(appsOrigin, `document.body.innerText.includes('asked by admin@example.com')`, 60000, 'gradio answered');
    await sleep(800);
    report.details.gradio = await frameEval(appsOrigin, `({ path: location.pathname, status: [...document.querySelectorAll('.prose, .md')].map(e => e.innerText).find(t => t.includes('asked by')) ?? null, answer: document.body.innerText.includes('42') })`);
    report.details.charts = report.details.dash?.plot ? 1 : 0;
  }
  else if (scenario === 'alert-channels') {
    const http = await import('node:http');
    const crypto = await import('node:crypto');
    const got = [];
    const receiver = http.createServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { got.push({ headers: req.headers, body: b }); res.end('ok'); }); });
    await new Promise((r) => receiver.listen(0, '127.0.0.1', r));
    const hookUrl = `http://127.0.0.1:${receiver.address().port}/duckview`;
    let channelId = null;
    cleanup = async () => { receiver.close(); if (channelId) await authed(`/api/channels/${channelId}`, { method: 'DELETE' }); };
    await send('Page.navigate', { url: `${BASE}/#/alerts/channels` });
    await waitFor(`[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'New channel')`, 20000, 'alerts page');
    await clickButton('New channel');
    await evaluate(`[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Webhook').click(); true`);
    await setField('input[placeholder="#data-alerts"]', 'E2E webhook');
    await setField('input[placeholder="https://…"]', hookUrl);
    await clickButton('Create');
    await waitFor(`document.body.innerText.includes('Signing secret')`, 15000, 'signing secret shown once');
    const secret = await evaluate(`document.querySelector('code.select-all')?.textContent`);
    const wsList = await (await authed('/api/workspaces')).json();
    const wsId = wsList.workspaces?.[0]?.id ?? wsList[0]?.id;
    channelId = (await (await authed(`/api/workspaces/${wsId}/channels`)).json()).channels.find((c) => c.name === 'E2E webhook')?.id ?? null;
    await evaluate(`[...document.querySelectorAll('div.rounded-lg')].find(d => d.innerText.includes('E2E webhook')).querySelector('button[title="Send a test message"]').click(); true`);
    await waitFor(`[...document.querySelectorAll('div.rounded-lg')].find(d => d.innerText.includes('E2E webhook'))?.innerText.includes('delivered')`, 20000, 'delivered badge');
    await sleep(500);
    const w = got.at(-1);
    const body = w ? JSON.parse(w.body) : null;
    report.details.delivery = { received: got.length, event: body?.event, title: body?.title, signatureValid: !!w && w.headers['x-duckview-signature'] === `sha256=${crypto.createHmac('sha256', secret).update(`${w.headers['x-duckview-timestamp']}.${w.body}`).digest('hex')}`, secretShownOnce: !!secret && !(await (await authed(`/api/workspaces/${wsId}/channels`)).text()).includes(secret) };
    report.details.charts = 1;
  }
  else if (scenario === 'sql-alerts') {
    const http = await import('node:http');
    const got = [];
    const receiver = http.createServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { got.push(JSON.parse(b)); res.end('ok'); }); });
    await new Promise((r) => receiver.listen(0, '127.0.0.1', r));
    const wsList = await (await authed('/api/workspaces')).json();
    const wsId = wsList.workspaces?.[0]?.id ?? wsList[0]?.id;
    const q = (sql) => authed(`/api/workspaces/${wsId}/query`, { method: 'POST', body: JSON.stringify({ sql }) });
    await q('CREATE OR REPLACE TABLE e2e_alert_orders AS SELECT * FROM (VALUES (1, 30.0), (2, 40.0)) t(id, amount)');
    const channel = (await (await authed(`/api/workspaces/${wsId}/channels`, { method: 'POST', body: JSON.stringify({ name: 'E2E alert hook', type: 'webhook', secret: { url: `http://127.0.0.1:${receiver.address().port}/a` } }) })).json()).channel;
    cleanup = async () => {
      receiver.close();
      const alerts = (await (await authed(`/api/workspaces/${wsId}/alerts`)).json()).alerts;
      for (const a of alerts.filter((x) => x.name === 'E2E revenue')) await authed(`/api/alerts/${a.id}`, { method: 'DELETE' });
      await authed(`/api/channels/${channel.id}`, { method: 'DELETE' });
      await q('DROP TABLE IF EXISTS e2e_alert_orders');
    };
    await send('Page.navigate', { url: `${BASE}/#/alerts/alerts` });
    await waitFor(`[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'New alert')`, 20000, 'alerts tab');
    await clickButton('New alert');
    await setField('input[placeholder="Orders below plan"]', 'E2E revenue');
    await setField('textarea', 'SELECT sum(amount) AS total FROM e2e_alert_orders');
    await evaluate(`(() => { const inputs = [...document.querySelectorAll('input.font-mono')]; const set = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); }; set(inputs[0], 'total'); set(inputs[1], '100'); return true; })()`);
    await evaluate(`[...document.querySelectorAll('label')].find(l => l.textContent.includes('E2E alert hook')).querySelector('input').click(); true`);
    await clickButton('Test');
    await waitFor(`document.body.innerText.includes('Would stay quiet')`, 20000, 'preview says quiet');
    report.details.preview = await evaluate(`[...document.querySelectorAll('div')].find(d => d.textContent.startsWith('Would stay quiet'))?.textContent`);
    await clickButton('Create alert');
    await waitFor(`document.body.innerText.includes('E2E revenue') && !document.body.innerText.includes('Create alert')`, 15000, 'alert created');
    const card = `[...document.querySelectorAll('div.rounded-lg')].find(d => d.innerText.includes('E2E revenue'))`;
    const check = async (label) => {
      await evaluate(`${card}.querySelector('button[title^="Check now"]').click(); true`);
      await waitFor(`${card}?.innerText.includes(${JSON.stringify(label)})`, 20000, `state ${label}`);
    };
    await check('ok · 70');
    await q('INSERT INTO e2e_alert_orders VALUES (3, 90.0)');
    await check('triggered · 160');
    { const shot = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(out.replace('.png', '_triggered.png'), Buffer.from(shot.result.data, 'base64')); }
    await q('DELETE FROM e2e_alert_orders WHERE id = 3');
    await check('ok · 70');
    await sleep(500);
    report.details.webhooks = got.map((g) => `${g.event}:${g.title}`);
    report.details.charts = 1;
  }
  else if (scenario === 'snapshots') {
    const http = await import('node:http');
    const got = [];
    const receiver = http.createServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { got.push(JSON.parse(b)); res.end('ok'); }); });
    await new Promise((r) => receiver.listen(0, '127.0.0.1', r));
    const wsList = await (await authed('/api/workspaces')).json();
    const wsId = wsList.workspaces?.[0]?.id ?? wsList[0]?.id;
    const j = async (method, url, body) => (await authed(url, { method, body: body ? JSON.stringify(body) : undefined })).json();
    await j('POST', `/api/workspaces/${wsId}/query`, { sql: "CREATE OR REPLACE TABLE e2e_snap_sales AS SELECT * FROM (VALUES ('North', 120), ('South', 80), ('East', 150), ('West', 60)) t(region, sales)" });
    const grid = (await j('POST', `/api/workspaces/${wsId}/dashboards`, { name: 'E2E snapshot board', description: 'rendered by the scheduler', kind: 'grid' })).dashboard;
    await j('POST', `/api/dashboards/${grid.id}/widgets`, { title: 'Total sales', widget_type: 'KPI', custom_sql: 'SELECT sum(sales) AS total FROM e2e_snap_sales', chart_config: {} });
    await j('POST', `/api/dashboards/${grid.id}/widgets`, { title: 'By region', widget_type: 'TABLE', custom_sql: 'SELECT region, sales FROM e2e_snap_sales ORDER BY sales DESC', chart_config: {} });
    const mosaic = (await j('POST', `/api/workspaces/${wsId}/dashboards`, { name: 'E2E mosaic snapshot', kind: 'mosaic', spec: { meta: { title: 'Sales' }, data: { s: { query: 'SELECT region, sales FROM e2e_snap_sales' } }, plot: [{ mark: 'barY', data: { from: 's' }, x: 'region', y: 'sales', fill: 'steelblue' }], width: 600, height: 280 } })).dashboard;
    const channel = (await j('POST', `/api/workspaces/${wsId}/channels`, { name: 'E2E snapshot hook', type: 'webhook', secret: { url: `http://127.0.0.1:${receiver.address().port}/s` } })).channel;
    cleanup = async () => {
      receiver.close();
      for (const sn of (await j('GET', `/api/workspaces/${wsId}/snapshots`)).snapshots) if (sn.name.startsWith('E2E')) await authed(`/api/snapshots/${sn.id}`, { method: 'DELETE' });
      for (const d of [grid, mosaic]) await authed(`/api/dashboards/${d.id}`, { method: 'DELETE' });
      await authed(`/api/channels/${channel.id}`, { method: 'DELETE' });
      await j('POST', `/api/workspaces/${wsId}/query`, { sql: 'DROP TABLE IF EXISTS e2e_snap_sales' });
    };
    await send('Page.navigate', { url: `${BASE}/#/alerts/snapshots` });
    await waitFor(`[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'New snapshot')`, 20000, 'snapshots tab');
    await clickButton('New snapshot');
    await evaluate(`(() => { const sel = [...document.querySelectorAll('select')].find(s => [...s.options].some(o => o.textContent === 'E2E snapshot board')); const v = [...sel.options].find(o => o.textContent === 'E2E snapshot board').value; Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, v); sel.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await evaluate(`[...document.querySelectorAll('label')].find(l => l.textContent.includes('E2E snapshot hook')).querySelector('input').click(); true`);
    await clickButton('Create snapshot');
    await waitFor(`[...document.querySelectorAll('div.rounded-lg')].some(d => d.innerText.includes('E2E snapshot board'))`, 15000, 'snapshot created');
    const card = `[...document.querySelectorAll('div.rounded-lg')].find(d => d.innerText.includes('E2E snapshot board'))`;
    const t0 = Date.now();
    await evaluate(`${card}.querySelector('button[title="Render and send now"]').click(); true`);
    await waitFor(`!${card}?.innerText.includes('never sent')`, 120000, 'snapshot sent');
    report.details.gridSeconds = Math.round((Date.now() - t0) / 1000);
    report.details.gridCard = await evaluate(`${card}.innerText.slice(0, 300)`);
    const g = got.at(-1);
    if (g?.image?.base64) fs.writeFileSync(out.replace('.png', '_grid.png'), Buffer.from(g.image.base64, 'base64'));
    report.details.gridDelivery = g ? { event: g.event, title: g.title, bytes: g.image ? Buffer.from(g.image.base64, 'base64').length : 0 } : null;
    // Mosaic: through the API.
    const ms = (await j('POST', `/api/workspaces/${wsId}/snapshots`, { name: 'E2E mosaic', target: { kind: 'dashboard', dashboard_id: mosaic.id }, schedule: { kind: 'manual' }, channel_ids: [channel.id] })).snapshot;
    const mr = await j('POST', `/api/snapshots/${ms.id}/run`, {});
    report.details.mosaicRun = { status: mr.run?.status, error: mr.run?.error, delivered: mr.run?.delivered };
    const m = got.at(-1);
    if (m?.image?.base64 && m.title === 'E2E mosaic') fs.writeFileSync(out.replace('.png', '_mosaic.png'), Buffer.from(m.image.base64, 'base64'));
    report.details.charts = 1;
  }
  else if (scenario === 'access-policies') {
    const wsList = await (await authed('/api/workspaces')).json();
    const remembered = await evaluate(`localStorage.getItem('duckview.workspace')`);
    const ws = (wsList.workspaces ?? wsList).find((w) => w.id === remembered) ?? (wsList.workspaces ?? wsList)[0];
    const j = async (method, url, body, token) => (await fetch(`${BASE}${url}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token ?? login.token}` }, body: body ? JSON.stringify(body) : undefined })).json();
    await j('POST', `/api/workspaces/${ws.id}/query`, { sql: "CREATE OR REPLACE TABLE e2e_rls_customers AS SELECT * FROM (VALUES ('EU', 120.0, '111-11-1111'), ('EU', 80.0, '222-22-2222'), ('US', 300.0, '333-33-3333'), ('APAC', 50.0, '444-44-4444')) t(region, revenue, ssn)" });
    const email = `e2e-viewer-${Date.now()}@example.com`;
    const viewer = (await j('POST', '/api/admin/users', { email, password: 'e2e-viewer-pass-123', role: 'USER' })).user;
    await j('PUT', `/api/workspaces/${ws.id}/members`, { subject_type: 'user', subject_id: viewer.id, role: 'VIEWER' });
    const dash = (await j('POST', `/api/workspaces/${ws.id}/dashboards`, { name: 'E2E RLS board', kind: 'mosaic', spec: { data: { c: { query: 'SELECT region, revenue, ssn FROM e2e_rls_customers' } }, vconcat: [{ plot: [{ mark: 'barY', data: { from: 'c' }, x: 'region', y: { sum: 'revenue' }, fill: 'steelblue' }], width: 500, height: 220 }, { input: 'table', from: 'c', height: 200 }] } })).dashboard;
    cleanup = async () => {
      for (const p of (await j('GET', `/api/workspaces/${ws.id}/policies`)).policies ?? []) if (p.table_name === 'e2e_rls_customers') await j('DELETE', `/api/policies/${p.id}`);
      await j('DELETE', `/api/dashboards/${dash.id}`);
      await j('DELETE', `/api/admin/users/${viewer.id}`);
      await j('POST', `/api/workspaces/${ws.id}/query`, { sql: 'DROP TABLE IF EXISTS e2e_rls_customers' });
    };
    // 1. The owner writes the policy in Governance.
    await send('Page.navigate', { url: `${BASE}/#/governance/policies` });
    await waitFor(`[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'New policy')`, 20000, 'governance page');
    await clickButton('New policy');
    report.details.tableOptions = await evaluate(`[...document.querySelectorAll('select')].map(s => [...s.options].map(o => o.value).slice(0, 12))`);
    await waitFor(`[...document.querySelectorAll('select')].some(s => [...s.options].some(o => o.value === 'e2e_rls_customers'))`, 10000, 'the table in the picker');
    await evaluate(`(() => { const sel = [...document.querySelectorAll('select')].find(s => [...s.options].some(o => o.value === 'e2e_rls_customers')); const setV = (el, v) => { Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, v); el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); }; setV(sel, 'e2e_rls_customers'); return true; })()`);
    await setField('input[placeholder="EU sales only"]', 'E2E EU only');
    await evaluate(`(() => { const t = document.querySelector('textarea'); const setV = (el, v) => { Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, v); el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); }; setV(t, "region = 'EU'"); return true; })()`);
    await waitFor(`[...document.querySelectorAll('span.font-mono')].some(s => s.textContent === 'ssn')`, 10000, 'columns listed');
    await evaluate(`(() => { const row = [...document.querySelectorAll('span.font-mono')].find(s => s.textContent === 'ssn').parentElement; const sel = row.querySelector('select'); const setV = (el, v) => { Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, v); el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); }; setV(sel, 'null'); return true; })()`);
    await clickButton('Create policy');
    await waitFor(`document.body.innerText.includes('E2E EU only') && !document.body.innerText.includes('Create policy')`, 15000, 'policy created');
    // 2. Preview as the viewer.
    await clickButton('Preview as…');
    await evaluate(`(() => { const sel = [...document.querySelectorAll('select')].find(s => [...s.options].some(o => o.textContent.startsWith(${JSON.stringify(email)}))); const v = [...sel.options].find(o => o.textContent.startsWith(${JSON.stringify(email)})).value; const setV = (el, v) => { Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, v); el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); }; setV(sel, v); return true; })()`);
    await setField('input.font-mono', 'SELECT region, ssn FROM e2e_rls_customers ORDER BY revenue');
    await clickButton('Run');
    await waitFor(`document.body.innerText.includes('Policies apply')`, 15000, 'preview ran');
    report.details.preview = await evaluate(`[...document.querySelectorAll('table tbody tr')].map(r => r.innerText.replace(/\s+/g, ' ').trim())`);
    { const shot = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(out.replace('.png', '_preview.png'), Buffer.from(shot.result.data, 'base64')); }
    // 3. The viewer's own session: the dashboard over the protected table.
    const viewerToken = (await (await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'e2e-viewer-pass-123' }) })).json()).token;
    report.details.viewerInfo = await j('GET', `/api/mosaic/info?workspace_id=${ws.id}`, null, viewerToken);
    await evaluate(`localStorage.setItem('duckview.session', ${JSON.stringify(viewerToken)}); true`);
    await send('Page.navigate', { url: `${BASE}/?as=viewer#/dashboards/${dash.id}` });
    await waitFor(`document.querySelectorAll('.mosaic-dashboard svg rect, svg rect').length > 0 && document.querySelectorAll('table tbody tr').length > 0`, 60000, 'viewer dashboard rendered');
    await sleep(2500);
    report.details.viewerDashboard = await evaluate(`({ axis: [...document.querySelectorAll('svg g[aria-label="x-axis tick label"] text, svg text')].map(t => t.textContent).filter(t => /^(EU|US|APAC)$/.test(t)), tableRows: [...document.querySelectorAll('table tbody tr')].map(r => r.innerText.replace(/\s+/g, ' ').trim()), error: document.body.innerText.match(/error|forbidden|not available/i)?.[0] ?? null })`);
    { const shot = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(out.replace('.png', '_viewer.png'), Buffer.from(shot.result.data, 'base64')); }
    await send('Page.navigate', { url: `${BASE}/?as=viewer2#/governance/policies` });
    await waitFor(`document.body.innerText.includes('What applies to you')`, 20000, 'viewer governance page');
    report.details.viewerGovernance = await evaluate(`document.body.innerText.includes('Masked for you: ssn')`);
    await evaluate(`localStorage.setItem('duckview.session', ${JSON.stringify(login.token)}); true`);
    report.details.charts = 1;
  }
  else if (scenario === 'catalog-lineage') {
    const wsList = await (await authed('/api/workspaces')).json();
    const remembered = await evaluate(`localStorage.getItem('duckview.workspace')`);
    const ws = (wsList.workspaces ?? wsList).find((w) => w.id === remembered) ?? (wsList.workspaces ?? wsList)[0];
    const j = async (method, url, body) => (await authed(url, { method, body: body ? JSON.stringify(body) : undefined })).json();
    const sync = (await j('POST', `/api/workspaces/${ws.id}/syncs`, { name: 'E2E load', source: { kind: 'sql', sql: "SELECT * FROM (VALUES ('EU', 10), ('US', 20)) t(region, n)" }, target_table: 'e2e_lin_orders', schedule: { kind: 'manual' } })).sync;
    await j('POST', `/api/syncs/${sync.id}/run`, {});
    await j('POST', `/api/workspaces/${ws.id}/query`, { sql: 'CREATE OR REPLACE VIEW e2e_lin_totals AS SELECT region, sum(n) AS n FROM e2e_lin_orders GROUP BY region' });
    const dash = (await j('POST', `/api/workspaces/${ws.id}/dashboards`, { name: 'E2E lineage board', kind: 'grid' })).dashboard;
    await j('POST', `/api/dashboards/${dash.id}/widgets`, { title: 'Totals', widget_type: 'TABLE', custom_sql: 'SELECT * FROM e2e_lin_totals', chart_config: {} });
    cleanup = async () => {
      await j('DELETE', `/api/dashboards/${dash.id}`);
      await j('DELETE', `/api/syncs/${sync.id}`);
      await j('PUT', `/api/workspaces/${ws.id}/catalog/annotations`, { object_name: 'e2e_lin_orders', description: '', tags: [] });
      await j('POST', `/api/workspaces/${ws.id}/query`, { sql: 'DROP VIEW IF EXISTS e2e_lin_totals; DROP TABLE IF EXISTS e2e_lin_orders' });
    };
    await send('Page.navigate', { url: `${BASE}/#/governance/catalog` });
    await waitFor(`[...document.querySelectorAll('span.font-mono')].some(s => s.textContent === 'e2e_lin_orders')`, 20000, 'catalog lists the table');
    await evaluate(`[...document.querySelectorAll('span.font-mono')].find(s => s.textContent === 'e2e_lin_orders').closest('div.min-w-0').querySelector('button').click(); true`);
    await waitFor(`!!document.querySelector('input[placeholder^="What this table is"]')`, 5000, 'description editor');
    await setField('input[placeholder^="What this table is"]', 'Orders loaded by the E2E sync');
    await setField('input[placeholder="tags: pii, finance"]', 'sales');
    await clickButton('Save');
    await waitFor(`document.body.innerText.includes('Orders loaded by the E2E sync')`, 10000, 'description saved');
    report.details.annotation = (await j('GET', `/api/workspaces/${ws.id}/catalog/annotated`)).objects.find((o) => o.name === 'e2e_lin_orders');
    await send('Page.navigate', { url: `${BASE}/#/governance/lineage` });
    await waitFor(`document.querySelectorAll('svg[aria-label="Lineage graph"] g').length > 0`, 30000, 'lineage graph');
    await evaluate(`(() => { const sel = [...document.querySelectorAll('select')].find(s => [...s.options].some(o => o.value === 'table:e2e_lin_orders')); Object.getOwnPropertyDescriptor(Object.getPrototypeOf(sel), 'value').set.call(sel, 'table:e2e_lin_orders'); sel.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await sleep(600);
    report.details.traced = await evaluate(`[...document.querySelectorAll('svg[aria-label="Lineage graph"] g[data-node]')].map(g => g.querySelector('text')?.textContent)`);
    report.details.charts = 1;
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
  if (scenario === 'catalog-lineage') {
    if (d.annotation?.description !== 'Orders loaded by the E2E sync' || !d.annotation?.tags?.includes('sales')) problems.push(`annotation not saved: ${JSON.stringify(d.annotation)}`);
    for (const want of ['E2E load', 'e2e_lin_orders', 'e2e_lin_totals', 'E2E lineage board']) if (!d.traced?.includes(want)) problems.push(`the trace misses ${want}: ${JSON.stringify(d.traced)}`);
  }
  if (scenario === 'access-policies') {
    if (JSON.stringify((d.preview ?? []).map((r) => r.replace(/\s+/g, ' '))) !== JSON.stringify(['EU NULL', 'EU NULL'])) problems.push(`preview wrong: ${JSON.stringify(d.preview)}`);
    if (!d.viewerInfo?.restricted) problems.push('mosaic info not restricted for the viewer');
    if (d.viewerDashboard?.axis?.some((t) => t !== 'EU') || !d.viewerDashboard?.axis?.includes('EU')) problems.push(`the viewer's chart shows other regions: ${JSON.stringify(d.viewerDashboard)}`);
    if (d.viewerDashboard?.tableRows?.some((r) => /\d{3}-\d{2}-\d{4}|US|APAC/.test(r))) problems.push(`the viewer's table leaks: ${JSON.stringify(d.viewerDashboard.tableRows)}`);
    if (!d.viewerGovernance) problems.push('the viewer does not see what restricts them');
  }
  if (scenario === 'snapshots') {
    if (d.gridDelivery?.event !== 'snapshot.delivered' || !(d.gridDelivery?.bytes > 10000)) problems.push(`grid snapshot not delivered: ${JSON.stringify(d.gridDelivery)} ${d.gridCard}`);
    if (d.mosaicRun?.status !== 'ok' || d.mosaicRun?.delivered !== 1) problems.push(`mosaic snapshot failed: ${JSON.stringify(d.mosaicRun)}`);
  }
  if (scenario === 'sql-alerts') {
    if (!/total is 70 — not > 100/.test(d.preview ?? '')) problems.push(`preview wrong: ${d.preview}`);
    if (JSON.stringify(d.webhooks) !== JSON.stringify(['alert.triggered:E2E revenue', 'alert.resolved:Resolved: E2E revenue'])) problems.push(`webhooks wrong: ${JSON.stringify(d.webhooks)}`);
  }
  if (scenario === 'alert-channels') {
    if (d.delivery?.received !== 1 || d.delivery?.event !== 'channel.test' || !d.delivery?.signatureValid || !d.delivery?.secretShownOnce) problems.push(`webhook channel delivery wrong: ${JSON.stringify(d.delivery)}`);
  }
  if (scenario === 'frameworks') {
    if (!/rows 6 viewer admin@example\.com/.test(d.dash?.text ?? '')) problems.push(`the Dash callback did not answer: ${JSON.stringify(d.dash)}`);
    if (!/1 rows · asked by admin@example\.com/.test(d.gradio?.status ?? '') || !d.gradio?.answer) problems.push(`Gradio did not answer: ${JSON.stringify(d.gradio)}`);
  }
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
