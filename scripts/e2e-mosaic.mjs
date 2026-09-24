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
 * catalog-lineage scenario describes a table in Governance → Catalog and traces it in Governance → Lineage. The
 * audit-export scenario adds a Splunk destination (a receiver the script runs), tests it, and waits for the
 * server's exporter to deliver a query event. The scim-provisioning scenario generates a SCIM token in Governance →
 * Provisioning, links a new team to an IdP group in Settings → Teams and shares the workspace with it, provisions a
 * user and the group over SCIM (the team is adopted), and deactivates the user in Settings → Users. The dbt-project
 * scenario installs dbt Core when the server lacks it, creates the starter project in Transform, builds it, edits a
 * model in the editor, saves and runs only that model, and checks its compiled SQL and catalog note. The dbt-copilot
 * scenario saves a workbench SELECT as a dbt model (Query → dbt model) and has DuckCopilot (a mock LLM through BYOK)
 * write a model that "Add to dbt project" saves and builds; the prompt must carry the workspace's dbt projects.
 * The semantic-metrics scenario scaffolds semantic definitions from a table in Transform → Metrics, saves them, and
 * computes a metric by month in the explorer; the metric must equal the hand-written SQL.
 * The data-quality scenario opens Data → Quality, has DuckView suggest checks for a clean table, saves and runs them
 * (passing), breaks the data, runs again from the page (failing, with the failing rows shown and opened in SQL), and
 * reads the quality status in the Data explorer's dataset header.
 * The reverse-etl scenario starts from a workbench query (⋯ → Send results to…), sends it to a local HTTP receiver in
 * upsert mode from Connections → Reverse ETL, runs it (every row), previews the next run (nothing changed), changes a
 * row and runs again (only that row).
 * The notebooks scenario creates a notebook from SQL → Notebooks, runs the starter cell, adds a SQL cell that reads
 * the first cell by name, an input and a cell that uses it, runs everything, reloads (outputs and title were saved),
 * and exports it as Markdown.
 * The comments scenario comments on a notebook cell, @mentions a colleague picked from the suggestions, checks their
 * inbox; the colleague replies (API), the reply arrives in the bell live, opening it lands on the thread, and
 * resolving it clears the cell's count.
 * The version-history scenario names a version of a notebook, changes it, opens History, reads the diff, restores
 * the named version and checks the cell and the history.
 * The git-sync scenario (server started with DUCKVIEW__git__allow_local_repos=true) connects a local bare repository in
 * Settings → Git, pushes the workspace, edits a notebook in a clone and pulls the change back.
 * The embeds scenario creates an embed key in Settings → Embedding, signs a link for one tenant, checks the preview
 * shows only that tenant's revenue, opens the embed page itself (no DuckView chrome) and a second tenant's link.
 * The ai-build scenario asks DuckView AI (a mock model through BYOK) to build a dashboard: the reply's build plan is
 * checked (one item fails), created with one click, and the dashboard has the working widgets with real numbers.
 * The ai-metrics scenario asks DuckView AI a question the semantic layer answers (a metric card with the numbers),
 * opens it in the Metrics explorer, and asks the explorer's question box (the answer applied to the controls).
 * The insights scenario checks every metric for an unusual latest day in Transform → Metrics → Monitors, creates a
 * monitor that explains the drop by region, and finds the insight on the monitor feed and on Home.
 * The hosted-agents scenario installs "Data analyst" from the agent marketplace (AI → DuckView agents) and runs it
 * with a question: the (mock) model asks for SQL, gets the result and answers; the steps and the report show.
 * The a2a scenario checks DuckView's Agent Card, publishes a hosted agent for other agents, registers a (mock)
 * remote A2A agent by its card with an auth header, and asks it a question from AI → DuckView agents.
 * (The server must allow private A2A targets: DUCKVIEW__a2a__allow_private_targets=true.)
 * The streams scenario creates an HTTP push stream in Connections → Streams and pushes events to it with its key,
 * then a Kafka stream (a Kafka-compatible broker at E2E_KAFKA, default localhost:19092 — e.g. a Redpanda
 * container): test the connection, start it, and watch the rows arrive.
 * The cdc scenario mirrors a Postgres table (E2E_PG_CDC, default postgres://cdc:cdcpass@localhost:55432/shop — a
 * Postgres with wal_level = logical) through a Postgres CDC stream: the existing rows, then an update and a delete
 * made in Postgres, with the history of changes; removing the stream drops its replication slot.
 * The saas-sources scenario finds the GitHub, Jira, Zendesk, Shopify, Intercom, Linear, Pipedrive and Mailchimp
 * sources in Connections → Add a source and opens their forms (the vendor APIs themselves are covered by server
 * tests against mocks).
 * The lake-write scenario sends query results to a Delta Lake table in the data directory (created, then read back
 * with delta_scan) and — with an Iceberg REST catalog at E2E_ICEBERG (default http://localhost:8181, MinIO at
 * localhost:9000) — to an Iceberg table, both from the reverse ETL editor.
 * The pgwire scenario opens Settings → SQL clients & BI tools and connects over the Postgres protocol with psql and
 * node-postgres (the server must run with DUCKVIEW__pgwire__enabled=true).
 * The orchestration scenario mints a write token, starts a sync over the orchestration API as Airflow would and a
 * failing SQL check through the Python SDK, then finds both runs in Settings → Orchestration.
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
// A DevTools call that never answers (a wedged headless tab) fails the scenario instead of hanging it.
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const i = ++id;
  const timer = setTimeout(() => {
    pending.delete(i);
    reject(new Error(`DevTools did not answer ${method} within 90 s`));
  }, 90_000);
  pending.set(i, (v) => {
    clearTimeout(timer);
    resolve(v);
  });
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
  if (process.env.E2E_TRACE) console.error(`[e2e] waiting for: ${String(label).slice(0, 80)}`);
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
await waitFor(`!!document.querySelector('nav[aria-label="Primary"]')`, 30000, 'signed-in shell');

const report = { scenario, ok: false, details: {} };
// Scenarios run back to back can hit the API rate limit: wait as told and try again.
const authed = async (url, init = {}) => {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(`${BASE}${url}`, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${login.token}`, ...(init.headers ?? {}) } });
    if (r.status !== 429 || attempt >= 5) return r;
    await new Promise((res) => setTimeout(res, (Number(r.headers.get('retry-after')) || 5) * 1000 + 250));
  }
};
// React inputs ignore a plain `.value =`; set through the prototype setter and fire the event React listens to.
const setField = (selector, value, event = 'input') => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set; set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event(${JSON.stringify(event)}, { bubbles: true })); return el.value; })()`);
const clickButton = (text, which = 'first') => evaluate(`(() => { const all = [...document.querySelectorAll('button')].filter(b => b.textContent.trim() === ${JSON.stringify(text)}); const b = ${JSON.stringify(which)} === 'last' ? all.at(-1) : all[0]; if (!b) throw new Error('no button: ' + ${JSON.stringify(text)}); b.click(); return true; })()`);
let cleanup = null;
try {
  if (scenario === 'overview-explore') {
    // Data › Explorer: the dataset opens on Overview; its Explore tab holds the cross-filtered Mosaic view.
    await send('Page.navigate', { url: `${BASE}/#/data` });
    await waitFor(`!!document.querySelector('[data-testid="dataset-name"]') && [...document.querySelectorAll('[role=tab]')].some(b => b.textContent.trim() === 'Explore')`, 40000, 'dataset loaded with its Explore tab');
    await evaluate(`[...document.querySelectorAll('[role=tab]')].find(b => b.textContent.trim() === 'Explore').click(); 'clicked'`);
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
    await waitFor(`[...document.querySelectorAll('[role=tab]')].some(b => b.textContent.trim() === 'Explore')`, 40000, 'workbench loaded');
    // Explore works on the active tab's query: give it one, whatever the tabs held before.
    await waitFor(`!!document.querySelector('.cm-content')`, 20000, 'editor');
    await evaluate(`(() => { const el = document.querySelector('.cm-content'); el.focus(); document.execCommand('selectAll'); document.execCommand('insertText', false, "SELECT * FROM 'green_tripdata_2026-02.parquet'"); return true; })()`);
    await sleep(500);
    await evaluate(`[...document.querySelectorAll('[role=tab]')].find(b => b.textContent.trim() === 'Explore').click(); 'clicked'`);
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
    await waitFor(`[...document.querySelectorAll('select')].some(s => [...s.options].some(o => o.textContent === 'E2E snapshot board'))`, 15000, 'the dashboard in the picker');
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
  else if (scenario === 'semantic-metrics') {
    const j = async (method, url, body) => (await authed(url, { method, body: body ? JSON.stringify(body) : undefined })).json();
    const wsId = await evaluate(`localStorage.getItem('duckview.workspace')`);
    const q = (sql) => j('POST', `/api/workspaces/${wsId}/query`, { sql });
    const before = (await j('GET', `/api/workspaces/${wsId}/semantic`)).yaml ?? '';
    cleanup = async () => {
      await j('PUT', `/api/workspaces/${wsId}/semantic`, { yaml: before, force: true });
      await q('DROP TABLE IF EXISTS sem_orders');
    };
    await q(`CREATE OR REPLACE TABLE sem_orders AS SELECT range AS order_id, range % 4 AS customer_id, DATE '2026-01-01' + CAST(range * 3 AS INTEGER) AS order_date, CASE WHEN range % 2 = 0 THEN 'EU' ELSE 'US' END AS region, CAST(range * 10 AS DOUBLE) AS amount FROM range(1, 41)`);
    // 1. Definitions: scaffold from the table, save.
    await send('Page.navigate', { url: `${BASE}/#/transform/metrics` });
    await waitFor(`!!document.querySelector('[data-testid="metrics-define"]')`, 20000, 'metrics tab');
    await evaluate(`document.querySelector('[data-testid="metrics-define"]').click(); true`);
    await waitFor(`[...(document.querySelector('[data-testid="metrics-scaffold-table"]')?.options ?? [])].some(o => o.value === 'sem_orders')`, 20000, 'tables listed');
    await evaluate(`(() => { const sel = document.querySelector('[data-testid="metrics-scaffold-table"]'); Object.getOwnPropertyDescriptor(Object.getPrototypeOf(sel), 'value').set.call(sel, 'sem_orders'); sel.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await evaluate(`document.querySelector('[data-testid="metrics-scaffold"]').click(); true`);
    await waitFor(`document.querySelector('.cm-content')?.innerText.includes('table: sem_orders')`, 10000, 'scaffold in the editor');
    await evaluate(`document.querySelector('[data-testid="metrics-save"]').click(); true`);
    // Saved when the API lists the scaffolded metric (the page may already show other models of the workspace).
    for (let i = 0; i < 80; i++) {
      report.details.saved = (await j('GET', `/api/workspaces/${wsId}/semantic`)).metrics.map((m) => m.name);
      if (report.details.saved.includes('total_amount')) break;
      await sleep(250);
    }
    // 2. Explore: total amount by order date per month, EU only.
    await evaluate(`document.querySelector('[data-testid="metrics-explore"]').click(); true`);
    await waitFor(`!!document.querySelector('label[data-metric="total_amount"] input')`, 10000, 'metric listed');
    await evaluate(`(() => { for (const l of document.querySelectorAll('label[data-metric] input')) if (l.checked) l.click(); document.querySelector('label[data-metric="total_amount"] input').click(); return true; })()`);
    await waitFor(`[...(document.querySelector('[data-testid="metrics-groupby"]')?.options ?? [])].some(o => o.value === 'order_date')`, 10000, 'dimensions loaded');
    await evaluate(`(() => { const sel = document.querySelector('[data-testid="metrics-groupby"]'); Object.getOwnPropertyDescriptor(Object.getPrototypeOf(sel), 'value').set.call(sel, 'order_date'); sel.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await waitFor(`!!document.querySelector('[data-testid="metrics-grain"]')`, 5000, 'grain picker');
    await evaluate(`document.querySelector('[data-testid="metrics-run"]').click(); true`);
    await waitFor(`document.querySelector('[data-testid="metrics-result"]')?.innerText.includes('by order_date__month')`, 30000, 'metric computed');
    await sleep(800);
    report.details.ui = { header: await evaluate(`document.querySelector('[data-testid="metrics-result"]').innerText.split('\\n')[0]`), canvas: await evaluate(`!!document.querySelector('canvas')`) };
    const api = await j('POST', `/api/workspaces/${wsId}/semantic/query`, { metrics: ['total_amount'], group_by: ['order_date__month'] });
    report.details.api = api.rows?.map((r) => [String(r[0]).slice(0, 7), r[1]]);
    report.details.expected = ((await q("SELECT strftime(date_trunc('month', order_date), '%Y-%m') AS m, sum(amount) FROM sem_orders GROUP BY 1 ORDER BY 1")).rows ?? []);
    report.details.charts = 1;
  }
  else if (scenario === 'data-quality') {
    const j = async (method, url, body) => (await authed(url, { method, body: body ? JSON.stringify(body) : undefined })).json();
    const wsId = await evaluate(`localStorage.getItem('duckview.workspace')`);
    const q = (sql) => j('POST', `/api/workspaces/${wsId}/query`, { sql });
    const setInput = (sel, value) => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    cleanup = async () => {
      for (const s of (await j('GET', `/api/workspaces/${wsId}/quality/suites`)).suites ?? []) if (s.relation === 'dq_orders') await j('DELETE', `/api/quality/suites/${s.id}`);
      // The query tab "Open failing rows in SQL" opened.
      for (const t of (await j('GET', `/api/workspaces/${wsId}/tabs`)).tabs ?? []) if (t.title.startsWith('Failing: ')) await authed(`/api/workspaces/${wsId}/tabs/${t.id}`, { method: 'DELETE' });
      await q('DROP TABLE IF EXISTS dq_orders');
      await q('DROP TABLE IF EXISTS dq_customers');
    };
    await cleanup();
    await q(`CREATE TABLE dq_customers AS SELECT range AS customer_id, 'c' || range AS name FROM range(1, 11)`);
    await q(`CREATE TABLE dq_orders AS SELECT range AS order_id, 1 + range % 10 AS customer_id, CASE WHEN range % 3 = 0 THEN 'complete' WHEN range % 3 = 1 THEN 'pending' ELSE 'cancelled' END AS status, CAST(range * 7 % 500 AS DOUBLE) AS amount FROM range(1, 201)`);
    // 1. Suggest checks for the clean table, save and run: passing.
    await send('Page.navigate', { url: `${BASE}/#/transform/quality` });
    await waitFor(`!!document.querySelector('[data-testid="new-quality-suite"]')`, 20000, 'quality page');
    await evaluate(`document.querySelector('[data-testid="new-quality-suite"]').click(); true`);
    await waitFor(`!!document.querySelector('[data-testid="quality-table"]')`, 5000, 'editor');
    await setInput('[data-testid="quality-table"]', 'dq_orders');
    await evaluate(`document.querySelector('[data-testid="suggest-checks"]').click(); true`);
    await waitFor(`document.querySelectorAll('[data-check-row]').length >= 4`, 20000, 'suggested checks');
    report.details.suggested = await evaluate(`[...document.querySelectorAll('[data-check-row]')].map(r => r.dataset.checkRow)`);
    await evaluate(`document.querySelector('[data-testid="test-checks"]').click(); true`);
    await waitFor(`!!document.querySelector('[data-testid="quality-preview"]')`, 20000, 'test result');
    report.details.preview = await evaluate(`document.querySelector('[data-testid="quality-preview"]').innerText`);
    await evaluate(`document.querySelector('[data-testid="save-checks"]').click(); true`);
    await waitFor(`!document.querySelector('[data-testid="quality-editor"]') && document.querySelector('[data-testid="quality-status"]')?.innerText === 'Passing'`, 30000, 'saved and passing');
    report.details.first = await evaluate(`document.querySelector('[data-testid="quality-summary"]').innerText`);
    // 2. Break the data and run from the page: failing, with the rows that break it.
    await q(`INSERT INTO dq_orders VALUES (201, NULL, 'refunded', 12.5), (202, 77, 'complete', 3.0), (5, 3, 'pending', 10.0)`);
    await evaluate(`document.querySelector('[data-testid="run-quality"]').click(); true`);
    await waitFor(`document.querySelector('[data-testid="quality-status"]')?.innerText === 'Failing'`, 30000, 'failing after the data broke');
    report.details.second = await evaluate(`document.querySelector('[data-testid="quality-summary"]').innerText`);
    report.details.failing = await evaluate(`[...document.querySelectorAll('[data-check][data-status="fail"]')].map(r => r.innerText.split('\\n').join(' | '))`);
    await evaluate(`document.querySelector('[data-check][data-status="fail"] button').click(); true`);
    await waitFor(`!!document.querySelector('[data-check][data-status="fail"] table')`, 5000, 'failing rows shown');
    report.details.sample = await evaluate(`document.querySelector('[data-check][data-status="fail"] table').innerText.replace(/\\s+/g, ' ')`);
    await sleep(400);
    { const shot = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(out.replace('.png', '_suite.png'), Buffer.from(shot.result.data, 'base64')); }
    await evaluate(`[...document.querySelectorAll('[data-check][data-status="fail"] button')].find(b => b.innerText.includes('Open failing rows'))?.click(); true`);
    await waitFor(`location.hash.startsWith('#/query') && document.querySelector('.cm-content')?.innerText.includes('dq_orders')`, 15000, 'failing rows in SQL');
    report.details.openedSql = await evaluate(`document.querySelector('.cm-content').innerText`);
    // 3. The table's status in the Data explorer.
    const suite = ((await j('GET', `/api/workspaces/${wsId}/quality/suites`)).suites ?? []).find((s) => s.relation === 'dq_orders');
    report.details.api = { status: suite?.status, summary: suite?.last_run?.summary };
    await send('Page.navigate', { url: `${BASE}/#/data` });
    await waitFor(`!!document.querySelector('[data-testid="dataset-name"]') || document.body.innerText.includes('Sources')`, 20000, 'data explorer');
    await evaluate(`document.querySelector('[aria-label="Refresh sources"]')?.click(); true`);
    const pickTable = `(() => { const b = [...document.querySelectorAll('button[title^="table ·"]')].find(e => e.innerText.trim().split('\\n')[0].trim() === 'dq_orders'); b?.click(); return !!b; })()`;
    await waitFor(`${pickTable} || (() => { const t = [...document.querySelectorAll('button')].find(e => /^Tables/.test(e.innerText.trim())); if (t && !document.querySelector('button[title^="table ·"]')) t.click(); return false; })()`, 20000, 'dq_orders in the sources');
    await waitFor(`document.querySelector('[data-testid="dataset-name"]')?.innerText.includes('dq_orders') && !!document.querySelector('[data-testid="quality-chip"]')`, 20000, 'quality status in the dataset header');
    report.details.chip = await evaluate(`document.querySelector('[data-testid="quality-chip"]').innerText`);
    report.details.charts = 1;
  }
  else if (scenario === 'reverse-etl') {
    const http = await import('node:http');
    const j = async (method, url, body) => (await authed(url, { method, body: body ? JSON.stringify(body) : undefined })).json();
    const wsId = await evaluate(`localStorage.getItem('duckview.workspace')`);
    const q = (sql) => j('POST', `/api/workspaces/${wsId}/query`, { sql });
    const got = [];
    const receiver = http.createServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { got.push({ auth: req.headers.authorization, body: JSON.parse(b) }); res.end('ok'); }); });
    await new Promise((r) => receiver.listen(0, '127.0.0.1', r));
    let tabId = null;
    cleanup = async () => {
      receiver.close();
      for (const s of (await j('GET', `/api/workspaces/${wsId}/reverse-syncs`)).syncs ?? []) if (s.name.startsWith('E2E')) await j('DELETE', `/api/reverse-syncs/${s.id}`);
      if (tabId) await authed(`/api/workspaces/${wsId}/tabs/${tabId}`, { method: 'DELETE' });
      await q('DROP TABLE IF EXISTS e2e_rev_scores');
    };
    await q(`CREATE OR REPLACE TABLE e2e_rev_scores AS SELECT range AS id, 'user' || range || '@example.com' AS email, (range * 37) % 100 AS score FROM range(1, 26)`);
    tabId = (await j('POST', `/api/workspaces/${wsId}/tabs`, { title: 'E2E scores', sql_content: 'SELECT id, email, score FROM e2e_rev_scores' })).tab?.id;
    // 1. From the workbench: ⋯ → Send results to…
    await send('Page.navigate', { url: `${BASE}/#/query` });
    await sleep(500);
    await send('Page.reload', {});
    await waitFor(`[...document.querySelectorAll('span.truncate')].some(s => s.textContent === 'E2E scores')`, 20000, 'tab listed');
    await evaluate(`[...document.querySelectorAll('span.truncate')].find(s => s.textContent === 'E2E scores').closest('div').click(); true`);
    await sleep(500);
    await evaluate(`document.querySelector('button[aria-label="More query actions"]').click(); true`);
    await waitFor(`[...document.querySelectorAll('[role=menuitem]')].some(b => b.textContent.includes('Send results to'))`, 5000, 'query menu');
    await evaluate(`[...document.querySelectorAll('[role=menuitem]')].find(b => b.textContent.includes('Send results to')).click(); true`);
    await waitFor(`location.hash.startsWith('#/connections/reverse') && !!document.querySelector('[data-testid="reverse-editor"]')`, 15000, 'reverse editor with the query');
    report.details.handedSql = await evaluate(`document.querySelector('[data-testid="reverse-sql"]').value`);
    report.details.handedName = await evaluate(`document.querySelector('[data-testid="reverse-name"]').value`);
    // 2. An HTTP API, upsert on id, with a header.
    const setVal = (sel, v) => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(v)}); el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); return true; })()`);
    await setVal('[data-testid="reverse-name"]', 'E2E scores to CRM');
    await evaluate(`document.querySelector('[data-kind="http"]').click(); true`);
    await waitFor(`!!document.querySelector('[data-testid="reverse-url"]')`, 5000, 'http fields');
    await setVal('[data-testid="reverse-url"]', `http://127.0.0.1:${receiver.address().port}/scores`);
    await setVal('input[aria-label="Header value"]', 'Bearer e2e-token');
    await setVal('[data-testid="reverse-mode"]', 'upsert');
    await waitFor(`!!document.querySelector('[data-testid="reverse-keys"]')`, 5000, 'key field');
    await setVal('[data-testid="reverse-keys"]', 'id');
    await evaluate(`document.querySelector('[data-testid="save-reverse"]').click(); true`);
    await waitFor(`!document.querySelector('[data-testid="reverse-editor"]') && !!document.querySelector('[data-reverse="E2E scores to CRM"]')`, 15000, 'sync listed');
    // 3. Run: every row.
    await evaluate(`document.querySelector('[data-reverse="E2E scores to CRM"] [data-testid="run-reverse"]').click(); true`);
    await waitFor(`/25 rows sent/.test(document.querySelector('[data-reverse="E2E scores to CRM"] [data-testid="reverse-last-run"]')?.innerText ?? '')`, 30000, 'first run');
    report.details.first = await evaluate(`document.querySelector('[data-reverse="E2E scores to CRM"] [data-testid="reverse-last-run"]').innerText`);
    // 4. Preview the next run: nothing changed.
    await evaluate(`document.querySelector('[data-reverse="E2E scores to CRM"] button[aria-label="More actions"]').click(); true`);
    await waitFor(`[...document.querySelectorAll('[role=menuitem]')].some(b => b.textContent.includes('Preview next run'))`, 5000, 'row menu');
    await evaluate(`[...document.querySelectorAll('[role=menuitem]')].find(b => b.textContent.includes('Preview next run')).click(); true`);
    await waitFor(`!!document.querySelector('[data-testid="reverse-plan"]')`, 20000, 'plan');
    report.details.plan = await evaluate(`document.querySelector('[data-testid="reverse-plan"] p').innerText`);
    await evaluate(`[...document.querySelectorAll('[data-testid="reverse-plan"] button')].find(b => b.textContent.trim() === 'Close').click(); true`);
    // 5. One row changes: only it is sent.
    await q('UPDATE e2e_rev_scores SET score = 999 WHERE id = 7');
    await evaluate(`document.querySelector('[data-reverse="E2E scores to CRM"] [data-testid="run-reverse"]').click(); true`);
    await waitFor(`/^1 row sent/.test(document.querySelector('[data-reverse="E2E scores to CRM"] [data-testid="reverse-last-run"]')?.innerText ?? '')`, 30000, 'second run');
    await sleep(400);
    { const shot = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(out.replace('.png', '_reverse.png'), Buffer.from(shot.result.data, 'base64')); }
    report.details.received = got.map((g) => ({ auth: g.auth, op: g.body.op, n: g.body.rows.length, first: g.body.rows[0] }));
    report.details.charts = 1;
  }
  else if (scenario === 'notebooks') {
    const j = async (method, url, body) => (await authed(url, { method, body: body ? JSON.stringify(body) : undefined })).json();
    const wsId = await evaluate(`localStorage.getItem('duckview.workspace')`);
    cleanup = async () => {
      for (const n of (await j('GET', `/api/workspaces/${wsId}/notebooks`)).notebooks ?? []) if (n.title.startsWith('E2E')) await j('DELETE', `/api/notebooks/${n.id}`);
    };
    await cleanup();
    const setVal = (sel, v) => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(v)}); el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); return true; })()`);
    const typeInto = async (cell, text) => {
      await evaluate(`document.querySelector('[data-cell="${cell}"] .cm-content').focus(); true`);
      await send('Input.insertText', { text });
    };
    const outputOf = (cell) => `document.querySelector('[data-cell="${cell}"] [data-testid="cell-output"]')?.innerText ?? document.querySelector('[data-cell="${cell}"] [data-testid="cell-error"]')?.innerText ?? ''`;
    // 1. A new notebook: the starter cell runs.
    await send('Page.navigate', { url: `${BASE}/#/notebooks` });
    await waitFor(`!!document.querySelector('[data-testid="new-notebook"]')`, 20000, 'notebooks page');
    await evaluate(`document.querySelector('[data-testid="new-notebook"]').click(); true`);
    await waitFor(`!!document.querySelector('[data-cell="df1"] [data-testid="run-cell"]')`, 15000, 'new notebook with a starter cell');
    await setVal('[data-testid="notebook-title"]', 'E2E notebook');
    await evaluate(`document.querySelector('[data-cell="df1"] [data-testid="run-cell"]').click(); true`);
    await waitFor(`/answer/.test(${outputOf('df1')}) && /42/.test(${outputOf('df1')})`, 20000, 'starter cell output');
    // 2. A SQL cell that reads df1 by name.
    await evaluate(`document.querySelector('[data-cell="df1"]').nextElementSibling.querySelector('[data-add="sql"]').click(); true`);
    await waitFor(`!!document.querySelector('[data-cell="df2"] .cm-content')`, 5000, 'second SQL cell');
    await typeInto('df2', 'SELECT answer * 2 AS doubled FROM df1');
    await evaluate(`document.querySelector('[data-cell="df2"] [data-testid="run-cell"]').click(); true`);
    await waitFor(`/doubled/.test(${outputOf('df2')}) && /84/.test(${outputOf('df2')})`, 20000, 'df2 reads df1');
    // 3. An input, and a cell that uses it; run everything.
    await evaluate(`document.querySelector('[data-cell="df2"]').nextElementSibling.querySelector('[data-add="input"]').click(); true`);
    await waitFor(`!!document.querySelector('[data-cell="param1"] [data-testid="input-value"]')`, 5000, 'input cell');
    await setVal('[data-cell="param1"] select[aria-label="Input kind"]', 'number');
    await setVal('[data-cell="param1"] [data-testid="input-value"]', '10');
    await evaluate(`document.querySelector('[data-cell="param1"]').nextElementSibling.querySelector('[data-add="sql"]').click(); true`);
    await waitFor(`!!document.querySelector('[data-cell="df3"] .cm-content')`, 5000, 'third SQL cell');
    await typeInto('df3', 'SELECT doubled * {{ param1 }} AS scaled FROM df2');
    await evaluate(`document.querySelector('[data-testid="run-all"]').click(); true`);
    await waitFor(`/scaled/.test(${outputOf('df3')}) && /840/.test(${outputOf('df3')})`, 30000, 'run all');
    await waitFor(`document.querySelector('[data-testid="save-state"]')?.innerText === 'Saved'`, 10000, 'saved');
    { const shot = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(out.replace('.png', '_notebook.png'), Buffer.from(shot.result.data, 'base64')); }
    // 4. Reload: title, cells and outputs are kept.
    await send('Page.reload', {});
    await waitFor(`document.querySelector('[data-testid="notebook-title"]')?.value === 'E2E notebook' && /840/.test(${outputOf('df3')})`, 20000, 'kept after reload');
    report.details.cells = await evaluate(`[...document.querySelectorAll('[data-cell]')].map(c => c.dataset.cell + ':' + c.dataset.cellType)`);
    // 5. Markdown export.
    const nb = ((await j('GET', `/api/workspaces/${wsId}/notebooks`)).notebooks ?? []).find((n) => n.title === 'E2E notebook');
    report.details.markdown = await (await authed(`/api/notebooks/${nb.id}/export.md`)).text();
    report.details.charts = 1;
  }
  else if (scenario === 'comments') {
    const j = async (method, url, body) => (await authed(url, { method, body: body ? JSON.stringify(body) : undefined })).json();
    const wsId = await evaluate(`localStorage.getItem('duckview.workspace')`);
    const email = 'e2e-colleague@example.com';
    let colleague = null;
    cleanup = async () => {
      for (const n of (await j('GET', `/api/workspaces/${wsId}/notebooks`)).notebooks ?? []) if (n.title.startsWith('E2E')) await j('DELETE', `/api/notebooks/${n.id}`);
      const users = (await j('GET', '/api/admin/users')).users ?? [];
      for (const u of users) if (u.email === email) await j('DELETE', `/api/admin/users/${u.id}`);
    };
    await cleanup();
    colleague = (await j('POST', '/api/admin/users', { email, password: 'colleague-secret-pw', role: 'USER', display_name: 'E2E Colleague' })).user;
    await j('PUT', `/api/workspaces/${wsId}/members`, { subject_type: 'user', subject_id: colleague.id, role: 'EDITOR' });
    const nb = (await j('POST', `/api/workspaces/${wsId}/notebooks`, { title: 'E2E comments', cells: [{ id: 'c1', type: 'sql', name: 'totals', source: 'SELECT 42 AS total' }] })).notebook;
    const colleagueToken = (await (await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'colleague-secret-pw' }) })).json()).token;
    const asColleague = async (method, url, body) => (await fetch(`${BASE}${url}`, { method, headers: { authorization: `Bearer ${colleagueToken}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })).json();
    // 1. Comment on the cell, mentioning the colleague from the suggestions.
    await send('Page.navigate', { url: `${BASE}/#/notebooks/${nb.id}` });
    await waitFor(`!!document.querySelector('[data-cell="totals"] [data-testid="cell-comment"]')`, 20000, 'notebook with a cell');
    await evaluate(`document.querySelector('[data-cell="totals"] [data-testid="cell-comment"]').click(); true`);
    await waitFor(`!!document.querySelector('[data-testid="comments-panel"] [data-testid="comment-input"]')`, 5000, 'comments panel');
    await evaluate(`document.querySelector('[data-testid="comments-panel"] [data-testid="comment-input"]').focus(); true`);
    await send('Input.insertText', { text: 'Is 42 right? @e2e-coll' });
    await waitFor(`[...document.querySelectorAll('[data-testid="mention-list"] [role=option]')].some(o => o.innerText.includes('${email}'))`, 5000, 'mention suggestions');
    await evaluate(`[...document.querySelectorAll('[data-testid="mention-list"] [role=option]')].find(o => o.innerText.includes('${email}')).dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); true`);
    await send('Input.insertText', { text: 'can you check?' });
    report.details.draft = await evaluate(`document.querySelector('[data-testid="comments-panel"] [data-testid="comment-input"]').value`);
    await evaluate(`document.querySelector('[data-testid="comments-panel"] [data-testid="comment-submit"]').click(); true`);
    await waitFor(`!!document.querySelector('[data-testid="comments-panel"] [data-thread]')`, 10000, 'thread posted');
    report.details.rendered = await evaluate(`document.querySelector('[data-testid="comments-panel"] [data-thread]').innerText`);
    await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); true`);
    await waitFor(`document.querySelector('[data-cell="totals"] [data-testid="cell-comments"]')?.innerText.trim() === '1'`, 10000, 'cell comment count');
    const inbox = await asColleague('GET', '/api/inbox');
    report.details.colleagueInbox = inbox.items?.map((i) => `${i.kind}:${i.target_label}:${i.comment.anchor}`);
    // 2. The colleague replies; the bell shows it live; opening it lands on the thread.
    const thread = inbox.items?.[0]?.comment?.thread_id;
    await asColleague('POST', `/api/workspaces/${wsId}/comments`, { parent_id: thread, body: 'Yes — it is the answer.' });
    await waitFor(`document.querySelector('[data-testid="inbox-unread"]')?.innerText === '1'`, 15000, 'unread reply in the bell');
    await send('Page.navigate', { url: `${BASE}/#/notebooks` });
    await waitFor(`!!document.querySelector('[data-testid="notebook-list"]')`, 10000, 'away from the notebook');
    await evaluate(`document.querySelector('[data-testid="inbox-bell"]').click(); true`);
    await waitFor(`!!document.querySelector('[data-testid="inbox"] [data-inbox="reply"]')`, 5000, 'inbox open');
    report.details.inboxRow = await evaluate(`document.querySelector('[data-testid="inbox"] [data-inbox="reply"]').innerText.replace(/\\s+/g, ' ')`);
    await evaluate(`document.querySelector('[data-testid="inbox"] [data-inbox="reply"]').click(); true`);
    await waitFor(`location.hash.startsWith('#/notebooks/${nb.id}') && !!document.querySelector('[data-testid="comments-panel"] [data-thread="${thread}"]')`, 15000, 'landed on the thread');
    await sleep(400);
    { const shot = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(out.replace('.png', '_comments.png'), Buffer.from(shot.result.data, 'base64')); }
    report.details.threadText = await evaluate(`document.querySelector('[data-thread="${thread}"]').innerText.replace(/\\s+/g, ' ')`);
    report.details.unreadAfter = await evaluate(`document.querySelector('[data-testid="inbox-unread"]')?.innerText ?? '0'`);
    // 3. Resolve: the count on the cell goes away.
    await evaluate(`document.querySelector('[data-thread="${thread}"] [data-testid="resolve"]').click(); true`);
    await waitFor(`!document.querySelector('[data-cell="totals"] [data-testid="cell-comments"]')`, 10000, 'count cleared after resolving');
    report.details.charts = 1;
  }
  else if (scenario === 'version-history') {
    const j = async (method, url, body) => (await authed(url, { method, body: body ? JSON.stringify(body) : undefined })).json();
    const wsId = await evaluate(`localStorage.getItem('duckview.workspace')`);
    cleanup = async () => {
      for (const n of (await j('GET', `/api/workspaces/${wsId}/notebooks`)).notebooks ?? []) if (n.title.startsWith('E2E')) await j('DELETE', `/api/notebooks/${n.id}`);
    };
    await cleanup();
    const nb = (await j('POST', `/api/workspaces/${wsId}/notebooks`, { title: 'E2E history', cells: [{ id: 'c1', type: 'sql', name: 'revenue', source: "SELECT sum(amount) AS revenue FROM (VALUES (10), (20)) t(amount)" }] })).notebook;
    await j('POST', `/api/workspaces/${wsId}/revisions`, { object_type: 'notebook', object_id: nb.id, message: 'Signed off' });
    await j('PATCH', `/api/notebooks/${nb.id}`, { cells: [{ id: 'c1', type: 'sql', name: 'revenue', source: "SELECT sum(amount) * 1.2 AS revenue FROM (VALUES (10), (20)) t(amount)" }] });
    await send('Page.navigate', { url: `${BASE}/#/notebooks/${nb.id}` });
    await waitFor(`!!document.querySelector('[data-testid="history-button"]') && document.querySelector('[data-cell="revenue"] .cm-content')?.innerText.includes('1.2')`, 20000, 'notebook with the change');
    await evaluate(`document.querySelector('[data-testid="history-button"]').click(); true`);
    await waitFor(`[...document.querySelectorAll('[data-testid="history"] [data-revision]')].some(b => b.innerText.includes('Signed off'))`, 10000, 'history listed');
    report.details.versions = await evaluate(`[...document.querySelectorAll('[data-testid="history"] [data-revision]')].map(b => b.innerText.split('\\n')[0])`);
    await evaluate(`[...document.querySelectorAll('[data-testid="history"] [data-revision]')].find(b => b.innerText.includes('Signed off')).click(); true`);
    await waitFor(`!!document.querySelector('[data-testid="revision-diff"]')`, 10000, 'diff');
    report.details.diff = await evaluate(`[...document.querySelectorAll('[data-testid="revision-diff"] div')].map(d => d.innerText).filter(t => /^[+-] /.test(t))`);
    await sleep(300);
    { const shot = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(out.replace('.png', '_history.png'), Buffer.from(shot.result.data, 'base64')); }
    await evaluate(`document.querySelector('[data-testid="restore-revision"]').click(); true`);
    await waitFor(`!!document.querySelector('[data-testid="confirm-ok"]')`, 5000, 'restore confirmation');
    report.details.confirmTitle = await evaluate(`document.querySelector('#dv-confirm-title').textContent`);
    await evaluate(`document.querySelector('[data-testid="confirm-ok"]').click(); true`);
    await waitFor(`[...document.querySelectorAll('[data-testid="history"] [data-revision]')].some(b => b.innerText.includes('Restored version'))`, 10000, 'restore recorded');
    report.details.after = await evaluate(`[...document.querySelectorAll('[data-testid="history"] [data-revision]')].map(b => b.innerText.split('\\n')[0])`);
    await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); true`);
    await waitFor(`!document.querySelector('[data-cell="revenue"] .cm-content')?.innerText.includes('1.2')`, 10000, 'cell restored on screen');
    report.details.cell = await evaluate(`document.querySelector('[data-cell="revenue"] .cm-content').innerText`);
    report.details.charts = 1;
  }
  else if (scenario === 'git-sync') {
    const { execFileSync } = await import('node:child_process');
    const j = async (method, url, body) => (await authed(url, { method, body: body ? JSON.stringify(body) : undefined })).json();
    const wsId = await evaluate(`localStorage.getItem('duckview.workspace')`);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dv-e2e-git-'));
    const bare = path.join(tmp, 'repo.git');
    const gitc = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'Reviewer', GIT_AUTHOR_EMAIL: 'reviewer@example.com', GIT_COMMITTER_NAME: 'Reviewer', GIT_COMMITTER_EMAIL: 'reviewer@example.com' } });
    gitc(tmp, 'init', '-q', '--bare', '-b', 'main', bare);
    cleanup = async () => {
      await j('DELETE', `/api/workspaces/${wsId}/git`);
      for (const n of (await j('GET', `/api/workspaces/${wsId}/notebooks`)).notebooks ?? []) if (n.title.startsWith('E2E')) await j('DELETE', `/api/notebooks/${n.id}`);
      fs.rmSync(tmp, { recursive: true, force: true });
    };
    await j('DELETE', `/api/workspaces/${wsId}/git`);
    for (const n of (await j('GET', `/api/workspaces/${wsId}/notebooks`)).notebooks ?? []) if (n.title.startsWith('E2E')) await j('DELETE', `/api/notebooks/${n.id}`);
    const nb = (await j('POST', `/api/workspaces/${wsId}/notebooks`, { title: 'E2E git notebook', cells: [{ id: 'c1', type: 'sql', name: 'answer', source: 'SELECT 42 AS answer' }] })).notebook;
    const setVal = (sel, v) => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(v)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    // 1. Connect.
    await send('Page.navigate', { url: `${BASE}/#/settings/git` });
    await waitFor(`!!document.querySelector('[data-testid="git-url"]')`, 20000, 'git settings');
    await setVal('[data-testid="git-url"]', bare);
    await setVal('[data-testid="git-path"]', 'e2e-dv');
    await evaluate(`document.querySelector('[data-testid="git-save"]').click(); true`);
    await waitFor(`[...document.querySelectorAll('[data-testid="git-changes"] li')].some(l => l.innerText.includes('e2e-dv/notebooks/e2e-git-notebook.yml'))`, 30000, 'changes to push');
    report.details.pending = await evaluate(`[...document.querySelectorAll('[data-testid="git-changes"] li')].filter(l => l.innerText.includes('e2e-git')).map(l => l.innerText.replace(/\\s+/g, ' '))`);
    // 2. Push.
    await setVal('[data-testid="git-message"]', 'E2E export');
    await evaluate(`document.querySelector('[data-testid="git-push"]').click(); true`);
    await waitFor(`/^Pushed [0-9a-f]{7}/.test(document.querySelector('[data-testid="git-notice"]')?.innerText ?? '')`, 30000, 'pushed');
    const clone = path.join(tmp, 'clone');
    gitc(tmp, 'clone', '-q', bare, clone);
    report.details.log = gitc(clone, 'log', '--format=%s').trim();
    const file = path.join(clone, 'e2e-dv/notebooks/e2e-git-notebook.yml');
    report.details.file = fs.readFileSync(file, 'utf8');
    // 3. A change in Git, pulled back.
    fs.writeFileSync(file, report.details.file.replace('SELECT 42 AS answer', 'SELECT 43 AS answer'));
    gitc(clone, 'commit', '-qam', 'Answer is 43');
    gitc(clone, 'push', '-q', 'origin', 'main');
    await evaluate(`document.querySelector('[data-testid="git-pull"]').click(); true`);
    await waitFor(`!!document.querySelector('[data-testid="git-pull-result"]')`, 30000, 'pulled');
    await sleep(300);
    { const shot = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(out.replace('.png', '_git.png'), Buffer.from(shot.result.data, 'base64')); }
    report.details.pull = await evaluate(`document.querySelector('[data-testid="git-pull-result"]').innerText.replace(/\\s+/g, ' ')`);
    report.details.after = (await j('GET', `/api/notebooks/${nb.id}`)).notebook.cells[0].source;
    report.details.charts = 1;
  }
  else if (scenario === 'embeds') {
    const j = async (method, url, body) => (await authed(url, { method, body: body ? JSON.stringify(body) : undefined })).json();
    const wsId = await evaluate(`localStorage.getItem('duckview.workspace')`);
    const q = (sql) => j('POST', `/api/workspaces/${wsId}/query`, { sql });
    cleanup = async () => {
      for (const k of (await j('GET', `/api/workspaces/${wsId}/embed/keys`)).keys ?? []) if (k.name.startsWith('E2E') && !k.revoked_at) await j('DELETE', `/api/embed/keys/${k.id}`);
      for (const d of (await j('GET', `/api/workspaces/${wsId}/dashboards`)).dashboards ?? []) if (d.name.startsWith('E2E embed')) await j('DELETE', `/api/dashboards/${d.id}`);
      for (const p of (await j('GET', `/api/workspaces/${wsId}/policies`)).policies ?? []) if (p.name.startsWith('E2E')) await j('DELETE', `/api/policies/${p.id}`);
      await q('DROP TABLE IF EXISTS e2e_embed_orders');
    };
    await cleanup();
    await q(`CREATE TABLE e2e_embed_orders AS SELECT * FROM (VALUES (1, 'acme', 100.0), (2, 'acme', 50.0), (3, 'globex', 70.0)) t(id, tenant, amount)`);
    await j('POST', `/api/workspaces/${wsId}/policies`, { name: 'E2E embeds: own tenant', table_name: 'e2e_embed_orders', row_filter: 'tenant = {{embed.tenant}}', applies_to: { embeds: true } });
    const dash = (await j('POST', `/api/workspaces/${wsId}/dashboards`, { name: 'E2E embed portal', kind: 'grid' })).dashboard;
    await j('POST', `/api/dashboards/${dash.id}/widgets`, { title: 'Your revenue', widget_type: 'KPI', custom_sql: 'SELECT sum(amount) AS revenue FROM e2e_embed_orders', chart_config: {} });
    const setVal = (sel, v) => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(v)}); el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); return true; })()`);
    // 1. A key.
    await send('Page.navigate', { url: `${BASE}/#/settings/embedding` });
    await waitFor(`!!document.querySelector('[data-testid="embed-key-name"]')`, 20000, 'embedding settings');
    await setVal('[data-testid="embed-key-name"]', 'E2E portal');
    await evaluate(`document.querySelector('[data-testid="embed-key-create"]').click(); true`);
    await waitFor(`/dves_/.test(document.querySelector('[data-testid="embed-secret"]')?.innerText ?? '')`, 10000, 'secret shown once');
    report.details.snippet = await evaluate(`document.querySelector('[data-testid="embed-secret"] pre').innerText.includes("createHmac('sha256'")`);
    // 2. Try it for acme.
    await waitFor(`[...(document.querySelector('[data-testid="embed-resource"]')?.options ?? [])].some(o => o.value === 'dashboard:${dash.id}')`, 10000, 'dashboards listed');
    await setVal('[data-testid="embed-resource"]', `dashboard:${dash.id}`);
    await evaluate(`document.querySelector('[data-testid="embed-sign"]').click(); true`);
    await waitFor(`!!document.querySelector('[data-testid="embed-preview"]')?.contentDocument?.querySelector('[data-widget="Your revenue"]')?.innerText.match(/150/)`, 30000, 'preview shows acme revenue');
    report.details.preview = await evaluate(`document.querySelector('[data-testid="embed-preview"]').contentDocument.querySelector('[data-widget="Your revenue"]').innerText.replace(/\\s+/g, ' ')`);
    const url = await evaluate(`document.querySelector('[data-testid="embed-link"] code').getAttribute('title')`);
    await sleep(300);
    { const shot = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(out.replace('.png', '_settings.png'), Buffer.from(shot.result.data, 'base64')); }
    // 3. The embed page itself: the dashboard, no shell.
    await send('Page.navigate', { url });
    await waitFor(`!!document.querySelector('[data-testid="embed"] [data-widget="Your revenue"]')?.innerText.match(/150/)`, 30000, 'embed page');
    report.details.shell = await evaluate(`!!document.querySelector('nav[aria-label="Primary"]')`);
    await sleep(300);
    { const shot = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(out.replace('.png', '_embed.png'), Buffer.from(shot.result.data, 'base64')); }
    // 4. Another tenant.
    const key = ((await j('GET', `/api/workspaces/${wsId}/embed/keys`)).keys ?? []).find((k) => k.name === 'E2E portal');
    const globex = await j('POST', `/api/workspaces/${wsId}/embed/sign`, { key_id: key.id, resource_type: 'dashboard', resource_id: dash.id, attrs: { tenant: 'globex' } });
    await send('Page.navigate', { url: globex.url.startsWith('/') ? `${BASE}${globex.url}` : globex.url.replace(/^https?:\/\/[^/]+/, BASE) });
    await waitFor(`!!document.querySelector('[data-testid="embed"] [data-widget="Your revenue"]')?.innerText.match(/70/)`, 30000, 'second tenant');
    report.details.globex = await evaluate(`document.querySelector('[data-widget="Your revenue"]').innerText.replace(/\\s+/g, ' ')`);
    // Back into the app for the cleanup's API calls.
    await send('Page.navigate', { url: `${BASE}/#/` });
    report.details.charts = 1;
  }
  else if (scenario === 'ai-build') {
    const http = await import('node:http');
    const j = async (method, url, body) => (await authed(url, { method, body: body ? JSON.stringify(body) : undefined })).json();
    const wsId = await evaluate(`localStorage.getItem('duckview.workspace')`);
    const q = (sql) => j('POST', `/api/workspaces/${wsId}/query`, { sql });
    const plan = ['build: dashboard', 'name: E2E sales overview', 'items:', '  - { title: Revenue, kind: kpi, sql: "SELECT sum(amount) AS revenue FROM e2e_build_orders", format: number }', '  - { title: Orders, kind: kpi, sql: "SELECT count(*) AS orders FROM e2e_build_orders" }', '  - { title: Revenue by region, kind: chart, chart: bar, sql: "SELECT region, sum(amount) AS revenue FROM e2e_build_orders GROUP BY 1 ORDER BY 1", x: region, y: [revenue] }', '  - { title: Margin, kind: kpi, sql: "SELECT sum(margin) AS m FROM e2e_build_orders" }'].join('\n');
    const answer = `Here is a sales dashboard.\n\n\`\`\`duckview-build\n${plan}\n\`\`\`\n`;
    const prompts = [];
    const llm = http.createServer((req, res) => {
      let b = '';
      req.on('data', (d) => (b += d));
      req.on('end', () => {
        if (!req.url.includes('chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"models":[],"data":[]}'); return; }
        prompts.push(JSON.parse(b));
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const piece of answer.match(/[\s\S]{1,40}/g)) res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', model: 'mock', choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', model: 'mock', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 20 } })}\n\n`);
        res.end('data: [DONE]\n\n');
      });
    });
    await new Promise((r) => llm.listen(0, '127.0.0.1', r));
    cleanup = async () => {
      llm.close();
      await evaluate(`localStorage.removeItem('duckview.copilot.settings'); true`).catch(() => undefined);
      for (const d of (await j('GET', `/api/workspaces/${wsId}/dashboards`)).dashboards ?? []) if (d.name.startsWith('E2E sales overview')) await j('DELETE', `/api/dashboards/${d.id}`);
      await q('DROP TABLE IF EXISTS e2e_build_orders');
    };
    await q(`CREATE OR REPLACE TABLE e2e_build_orders AS SELECT * FROM (VALUES (1, 'EU', 100.0), (2, 'US', 50.0), (3, 'EU', 30.0)) t(id, region, amount)`);
    await evaluate(`localStorage.setItem('duckview.copilot.settings', JSON.stringify({ provider: 'ollama', model: 'mock', apiKey: '', baseUrl: 'http://127.0.0.1:${llm.address().port}' })); true`);
    await send('Page.navigate', { url: `${BASE}/#/` });
    await send('Page.reload', {});
    await waitFor(`!!document.querySelector('[data-testid="ai-toggle"]')`, 20000, 'app reloaded');
    await evaluate(`document.querySelector('[data-testid="ai-toggle"]').click(); true`);
    await waitFor(`!!document.querySelector('textarea[placeholder^="Ask about your data"]:not([disabled])')`, 15000, 'AI ready');
    await setField('textarea[placeholder^="Ask about your data"]', 'Build me a sales dashboard for the e2e orders');
    await evaluate(`document.querySelector('button[title="Send"]').click(); true`);
    await waitFor(`[...document.querySelectorAll('[data-testid="build-card"] [data-build-item]')].length === 4`, 30000, 'build card with checked items');
    await sleep(300);
    { const shot = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(out.replace('.png', '_card.png'), Buffer.from(shot.result.data, 'base64')); }
    report.details.card = await evaluate(`document.querySelector('[data-testid="build-card"]').innerText.replace(/\\s+/g, ' ')`);
    report.details.guide = prompts.some((p) => (p.messages ?? []).some((m) => m.role === 'system' && String(m.content).includes('## Building dashboards and data apps')));
    await evaluate(`document.querySelector('[data-testid="build-create"]').click(); true`);
    await waitFor(`location.hash.startsWith('#/dashboards/') && [...document.querySelectorAll('.react-grid-item')].length === 3`, 30000, 'dashboard created');
    await waitFor(`document.body.innerText.includes('180')`, 20000, 'revenue shown');
    await sleep(500);
    report.details.widgets = await evaluate(`[...document.querySelectorAll('.react-grid-item')].map(w => w.innerText.split('\\n')[0])`);
    { const shot = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(out.replace('.png', '_dashboard.png'), Buffer.from(shot.result.data, 'base64')); }
    report.details.charts = 1;
  }
  else if (scenario === 'cluster') {
    // This server runs alone: the page explains how to run several nodes.
    await send('Page.navigate', { url: `${BASE}/#/settings/cluster` });
    await waitFor(`!!document.querySelector('[data-testid="cluster-panel"]')`, 20000, 'cluster panel (single node)');
    report.details.single = await evaluate(`document.querySelector('[data-testid="cluster-panel"]').dataset.cluster`);
    // Two more nodes sharing a metadata store and a data directory, as a cluster.
    const { spawn: spawnNode } = await import('node:child_process');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dv-e2e-cluster-'));
    fs.mkdirSync(path.join(tmp, 'data'));
    const cli = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../packages/server/dist/cli.js');
    const nodes = [['e2e-node-1', 4291], ['e2e-node-2', 4292]].map(([id, p]) => ({ id, url: `http://127.0.0.1:${p}`, proc: spawnNode(process.execPath, [cli, 'serve'], { stdio: ['ignore', 'ignore', fs.openSync(path.join(tmp, `${id}.log`), 'a')], env: { PATH: process.env.PATH, HOME: process.env.HOME, PORT: String(p), HOST: '127.0.0.1', DUCKVIEW_DATA_DIR: path.join(tmp, 'data'), DUCKDB_TEMP_DIRECTORY: path.join(tmp, `spill-${id}`), DATABASE_URL: `sqlite://${path.join(tmp, 'meta.db')}`, JWT_SECRET: 'e2e-cluster-jwt-secret-0123456789', ENCRYPTION_KEY: 'cd'.repeat(32), DUCKVIEW_ADMIN_EMAIL: EMAIL, DUCKVIEW_ADMIN_PASSWORD: PASSWORD, DUCKVIEW__apps__enabled: 'false', DUCKVIEW__cluster__enabled: 'true', DUCKVIEW__cluster__node_id: id, DUCKVIEW__cluster__secret: 'e2e-cluster-secret-0123456789abcdef-0123', DUCKVIEW__cluster__advertise_url: `http://127.0.0.1:${p}`, DUCKVIEW__cluster__heartbeat_seconds: '2', LOG_LEVEL: 'warn' } }) }));
    cleanup = async () => {
      for (const n of nodes) n.proc.kill('SIGTERM');
      await sleep(1500);
      fs.rmSync(tmp, { recursive: true, force: true });
    };
    const ready = async (n) => {
      for (let i = 0; i < 120; i++) {
        if ((await fetch(`${n.url}/readyz`).catch(() => null))?.ok) return;
        await sleep(250);
      }
      throw new Error(`${n.id} did not start: ${fs.readFileSync(path.join(tmp, `${n.id}.log`), 'utf8').slice(-600)}`);
    };
    // One after the other: the first creates the metadata store.
    await ready(nodes[0]);
    await ready(nodes[1]);
    const token = (await (await fetch(`${nodes[0].url}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) })).json()).token;
    const on = async (n, method, url, body) => (await fetch(`${n.url}${url}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined })).json();
    const wsc = (await on(nodes[0], 'POST', '/api/workspaces', { name: 'E2E cluster', active_db_path: 'cluster.duckdb' })).workspace ?? {};
    const wsid = wsc.id;
    await on(nodes[0], 'POST', `/api/workspaces/${wsid}/query`, { sql: "CREATE TABLE sales AS SELECT * FROM (VALUES ('EU', 12.5), ('US', 7.5), ('EU', 5.0)) t(region, amount)" });
    // Node 2 has not opened the file: its query runs on node 1.
    report.details.forwarded = (await on(nodes[1], 'POST', `/api/workspaces/${wsid}/query`, { sql: 'SELECT region, sum(amount) FROM sales GROUP BY 1 ORDER BY 1' })).rows;
    // The page, served by node 2.
    await send('Page.navigate', { url: `${nodes[1].url}/` });
    await sleep(800);
    await evaluate(`localStorage.setItem('duckview.session', ${JSON.stringify(token)}); 'ok'`);
    await send('Page.reload');
    await waitFor(`!!document.querySelector('nav[aria-label="Primary"]')`, 30000, 'signed in on node 2');
    await evaluate(`location.hash = '#/settings/cluster'; 'ok'`);
    await waitFor(`document.querySelectorAll('[data-testid="cluster-nodes"] tbody tr[data-alive="true"]').length === 2`, 30000, 'two live nodes listed');
    report.details.nodes = await evaluate(`[...document.querySelectorAll('[data-testid="cluster-nodes"] tbody tr')].map(r => [r.dataset.node, r.cells[5].textContent])`);
    report.details.header = await evaluate(`document.querySelector('[data-testid="cluster-panel"] p').textContent`);
    report.details.wsPrefix = String(wsid).slice(0, 8);
    report.details.charts = 1;
  }
  else if (scenario === 'usage-cost') {
    const j = async (method, url, body) => (await authed(url, { method, body: body ? JSON.stringify(body) : undefined })).json();
    const wsId = await evaluate(`localStorage.getItem('duckview.workspace')`);
    // Some work to count.
    for (let i = 0; i < 3; i++) await j('POST', `/api/workspaces/${wsId}/query`, { sql: 'SELECT sum(range) FROM range(2000000)' });
    const api = await j('GET', '/api/usage?days=7');
    report.details.apiQueries = api.totals?.queries;
    const budgetName = `E2E budget ${Date.now()}`;
    cleanup = async () => {
      for (const b of (await j('GET', '/api/usage/budgets')).budgets ?? []) if (b.name.startsWith('E2E budget')) await j('DELETE', `/api/usage/budgets/${b.id}`);
    };
    await send('Page.navigate', { url: `${BASE}/#/settings/usage` });
    await waitFor(`!!document.querySelector('[data-testid="usage-total"]')`, 30000, 'usage totals');
    await waitFor(`document.querySelectorAll('[data-testid="usage-chart"] rect').length > 5`, 10000, 'daily chart');
    report.details.total = await evaluate(`document.querySelector('[data-testid="usage-total"]').textContent`);
    report.details.workspaceRows = await evaluate(`document.querySelectorAll('[data-testid="usage-workspaces"] tbody tr').length`);
    // 7 days.
    await evaluate(`[...document.querySelectorAll('[role=tab], button')].find(b => b.textContent.trim() === '7 days').click(); 'ok'`);
    await waitFor(`document.querySelector('[data-testid="usage-panel"]').innerText.includes('last 7 days')`, 10000, '7-day range');
    // A budget, through the form.
    await clickButton('Add budget');
    await waitFor(`!!document.querySelector('[data-testid="budget-form"]')`, 5000, 'budget form');
    await setField('input[name="budget-name"]', budgetName);
    await setField('input[name="budget-amount"]', '1');
    await setField('input[name="budget-thresholds"]', '1, 100');
    await clickButton('Add budget', 'last');
    await waitFor(`!document.querySelector('[data-testid="budget-form"]') && !!document.querySelector('[data-budget="${budgetName}"]')`, 10000, 'budget listed');
    report.details.budget = await evaluate(`document.querySelector('[data-budget="${budgetName}"]').innerText.replace(/\\s+/g, ' ')`);
    const csv = await (await authed('/api/usage/export.csv?by=day&days=7')).text();
    report.details.csvHeader = csv.split('\n')[0];
    report.details.charts = 1;
  }
  else if (scenario === 'templates') {
    const j = async (method, url, body) => (await authed(url, { method, body: body ? JSON.stringify(body) : undefined })).json();
    const remembered = await evaluate(`localStorage.getItem('duckview.workspace')`);
    const tmp = (await j('POST', '/api/workspaces', { name: `E2E templates ${Date.now()}`, active_db_path: ':memory:' })).workspace;
    cleanup = async () => {
      await evaluate(`localStorage.setItem('duckview.workspace', ${JSON.stringify(remembered)}); 'ok'`);
      await j('DELETE', `/api/workspaces/${tmp.id}`);
    };
    await evaluate(`localStorage.setItem('duckview.workspace', ${JSON.stringify(tmp.id)}); 'ok'`);
    await send('Page.reload');
    await waitFor(`!!document.querySelector('nav[aria-label="Primary"]')`, 30000, 'signed in');
    await sleep(800);
    await evaluate(`location.hash = '#/templates'; 'ok'`);
    await waitFor(`document.querySelectorAll('[data-testid="template-grid"] [data-template]').length >= 4`, 30000, 'template gallery');
    report.details.cards = await evaluate(`[...document.querySelectorAll('[data-testid="template-grid"] [data-template]')].map(b => b.dataset.template)`);
    await evaluate(`document.querySelector('[data-template="E-commerce sales"]').click(); 'ok'`);
    await waitFor(`!!document.querySelector('[data-testid="template-drawer"]') && document.querySelector('[data-testid="template-drawer"]').innerText.includes('Will be created with sample data')`, 15000, 'table check');
    report.details.drawer = await evaluate(`[...document.querySelectorAll('[data-testid="template-drawer"] [data-table]')].map(d => d.innerText.split('\\n').slice(0, 3).join(' | '))`);
    await evaluate(`[...document.querySelectorAll('[data-testid="template-drawer"] button')].find(b => b.textContent.startsWith('Install into')).click(); 'ok'`);
    await waitFor(`!!document.querySelector('[data-testid="template-installed"]')`, 60000, 'installed');
    await clickButton('Open the dashboard');
    await waitFor(`document.querySelectorAll('.react-grid-item').length === 7 && document.querySelectorAll('.react-grid-item canvas').length >= 3`, 40000, 'dashboard widgets rendered');
    await sleep(1500);
    report.details.widgets = await evaluate(`[...document.querySelectorAll('.react-grid-item')].map(w => w.innerText.split('\\n')[0])`);
    { const shot = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(out.replace('.png', '_dashboard.png'), Buffer.from(shot.result.data, 'base64')); }
    const inst = await j('GET', `/api/workspaces/${tmp.id}/template-installs`);
    report.details.installs = (inst.installs ?? []).map((i) => [i.template_name, i.objects.queries.length, i.objects.tables]);
    await send('Page.navigate', { url: `${BASE}/#/templates` });
    await waitFor(`!!document.querySelector('[data-testid="template-installs"]')`, 15000, 'installed list');
    report.details.charts = 1;
  }
  else if (scenario === 'ui-foundation') {
    // Menus, the confirmation dialog and toasts: by keyboard and by mouse.
    const wsId = await evaluate(`localStorage.getItem('duckview.workspace')`);
    const dash = (await (await authed(`/api/workspaces/${wsId}/dashboards`, { method: 'POST', body: JSON.stringify({ name: `E2E confirm ${Date.now()}` }) })).json()).dashboard;
    cleanup = async () => { await authed(`/api/dashboards/${dash.id}`, { method: 'DELETE' }); };
    const key = async (k, code = k) => { await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: { Enter: 13, Escape: 27, ArrowDown: 40, Tab: 9 }[k], ...(k === 'Enter' ? { text: '\r' } : {}) }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code }); await sleep(150); };
    await evaluate(`location.hash = '#/dashboards/${dash.id}'; 'ok'`);
    await waitFor(`!!document.querySelector('[aria-label="More dashboard actions"]')`, 20000, 'dashboard header');
    // Keyboard: open the menu from its button, move with the arrows, Escape returns to the button.
    await evaluate(`document.querySelector('[aria-label="More dashboard actions"]').focus(); 'ok'`);
    await key('Enter');
    report.details.menuOpened = await evaluate(`document.querySelectorAll('[role=menu]').length`);
    await waitFor(`document.activeElement?.getAttribute('role') === 'menuitem'`, 3000, 'first menu item focused');
    report.details.menuFirst = await evaluate(`document.activeElement.textContent.trim()`);
    await key('ArrowDown');
    report.details.menuSecond = await evaluate(`document.activeElement.textContent.trim()`);
    await key('Escape');
    report.details.focusBack = await evaluate(`document.activeElement?.getAttribute('aria-label')`);
    // The confirmation: Cancel has focus for a destructive action; Escape keeps the dashboard.
    await evaluate(`document.querySelector('[aria-label="More dashboard actions"]').click(); 'ok'`);
    await waitFor(`[...document.querySelectorAll('[role=menuitem]')].some(b => b.textContent.includes('Delete dashboard'))`, 3000, 'menu open');
    await evaluate(`[...document.querySelectorAll('[role=menuitem]')].find(b => b.textContent.includes('Delete dashboard')).click(); 'ok'`);
    await waitFor(`!!document.querySelector('[data-testid="confirm-dialog"]')`, 3000, 'confirm dialog');
    await sleep(300);
    report.details.dialog = await evaluate(`({ title: document.querySelector('#dv-confirm-title').textContent, focused: document.activeElement?.textContent.trim(), ok: document.querySelector('[data-testid="confirm-ok"]').textContent.trim(), role: document.querySelector('[data-testid="confirm-dialog"]').getAttribute('role') })`);
    { const shot = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(out.replace('.png', '_confirm.png'), Buffer.from(shot.result.data, 'base64')); }
    // Tab stays inside the dialog.
    await key('Tab'); await key('Tab'); await key('Tab');
    report.details.trapped = await evaluate(`!!document.activeElement?.closest('[data-testid="confirm-dialog"]')`);
    await key('Escape');
    await waitFor(`!document.querySelector('[data-testid="confirm-dialog"]')`, 3000, 'dialog closed');
    report.details.afterCancel = (await authed(`/api/dashboards/${dash.id}`)).status;
    // Confirm: deleted, and a toast says so.
    await evaluate(`document.querySelector('[aria-label="More dashboard actions"]').click(); 'ok'`);
    await waitFor(`[...document.querySelectorAll('[role=menuitem]')].some(b => b.textContent.includes('Delete dashboard'))`, 3000, 'menu open again');
    await evaluate(`[...document.querySelectorAll('[role=menuitem]')].find(b => b.textContent.includes('Delete dashboard')).click(); 'ok'`);
    await waitFor(`!!document.querySelector('[data-testid="confirm-ok"]')`, 3000, 'confirm again');
    await evaluate(`document.querySelector('[data-testid="confirm-ok"]').click(); 'ok'`);
    await waitFor(`!!document.querySelector('[data-toast="success"]')`, 5000, 'success toast');
    report.details.toast = await evaluate(`document.querySelector('[data-toast="success"]').innerText.split('\\n')[0]`);
    report.details.afterDelete = (await authed(`/api/dashboards/${dash.id}`)).status;
    report.details.charts = 1;
  }
  else if (scenario === 'shell') {
    // Where am I: the open object in the breadcrumb; Settings in three groups; narrow screens.
    const wsId = await evaluate(`localStorage.getItem('duckview.workspace')`);
    const dash = (await (await authed(`/api/workspaces/${wsId}/dashboards`, { method: 'POST', body: JSON.stringify({ name: `E2E shell ${Date.now()}` }) })).json()).dashboard;
    cleanup = async () => { await send('Emulation.clearDeviceMetricsOverride'); await authed(`/api/dashboards/${dash.id}`, { method: 'DELETE' }); };
    await evaluate(`location.hash = '#/dashboards/${dash.id}'; 'ok'`);
    await waitFor(`document.querySelector('[data-testid="page-object"]')?.textContent === ${JSON.stringify(dash.name)}`, 15000, 'dashboard in the breadcrumb');
    report.details.crumb = await evaluate(`document.querySelector('[data-testid="page-object"]').parentElement.innerText.split('\\n').map(x => x.trim()).filter(x => x && x !== '/').join(' | ')`);
    await evaluate(`location.hash = '#/settings/usage'; 'ok'`);
    await waitFor(`!!document.querySelector('nav[aria-label="Settings"]')`, 10000, 'settings');
    await waitFor(`!document.querySelector('[data-testid="page-object"]')`, 5000, 'object cleared on another page');
    report.details.groups = await evaluate(`[...document.querySelectorAll('nav[aria-label="Settings"] > div > div:first-child')].map(d => d.textContent)`);
    report.details.rail = await evaluate(`[...document.querySelectorAll('nav[aria-label="Primary"] a')].map(a => a.textContent.trim()).filter(Boolean)`);
    { const shot = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(out.replace('.png', '_settings.png'), Buffer.from(shot.result.data, 'base64')); }
    // Narrow: the settings nav becomes a picker; below 640 the rail hides behind a menu button.
    await send('Emulation.setDeviceMetricsOverride', { width: 900, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(500);
    report.details.narrowSettings = await evaluate(`({ nav: getComputedStyle(document.querySelector('nav[aria-label="Settings"]')).display, picker: !!document.querySelector('select[aria-label="Settings page"]')?.offsetParent })`);
    await send('Emulation.setDeviceMetricsOverride', { width: 600, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(500);
    report.details.phoneRail = await evaluate(`getComputedStyle(document.querySelector('nav[aria-label="Primary"]')).display`);
    await evaluate(`document.querySelector('[aria-label="Open navigation"]').click(); 'ok'`);
    await waitFor(`!!document.querySelector('nav[aria-label="Sections"]')`, 3000, 'navigation drawer');
    report.details.drawer = await evaluate(`[...document.querySelectorAll('nav[aria-label="Sections"] a')].map(a => a.querySelector('span span').textContent)`);
    { const shot = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(out.replace('.png', '_phone.png'), Buffer.from(shot.result.data, 'base64')); }
    await evaluate(`[...document.querySelectorAll('nav[aria-label="Sections"] a')].find(a => a.textContent.startsWith('Agents')).click(); 'ok'`);
    await waitFor(`location.hash === '#/agents' && !document.querySelector('nav[aria-label="Sections"]')`, 5000, 'navigated from the drawer');
    await send('Emulation.clearDeviceMetricsOverride');
    await waitFor(`[...document.querySelectorAll('[role=tab]')].some(t => t.textContent.startsWith('Activity') && t.getAttribute('aria-selected') === 'true')`, 10000, 'agents open on activity');
    report.details.charts = 1;
  }
  else if (scenario === 'sql-workspace') {
    // The workbench: a failing query explains itself and points at the line; keyboard shortcuts.
    const wsId = await evaluate(`localStorage.getItem('duckview.workspace')`);
    const before = new Set(((await (await authed(`/api/workspaces/${wsId}/tabs`)).json()).tabs ?? []).map((t) => t.id));
    cleanup = async () => {
      // Leave the page first: an open workbench saves its tabs back.
      await send('Page.navigate', { url: 'about:blank' });
      await sleep(500);
      for (const t of (await (await authed(`/api/workspaces/${wsId}/tabs`)).json()).tabs ?? []) if (!before.has(t.id)) await authed(`/api/workspaces/${wsId}/tabs/${t.id}`, { method: 'DELETE' });
    };
    const key = async (k, modifiers = 0, code = k) => { await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, modifiers, windowsVirtualKeyCode: { Enter: 13, Escape: 27, s: 83 }[k], ...(k === 'Enter' && !modifiers ? { text: '\r' } : {}) }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, modifiers }); await sleep(200); };
    const META = 4;
    await evaluate(`location.hash = '#/query'; 'ok'`);
    await waitFor(`[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'New tab')`, 20000, 'workbench');
    await clickButton('New tab');
    await waitFor(`!!document.querySelector('.cm-content')`, 10000, 'editor');
    await sleep(500);
    await evaluate(`document.querySelector('.cm-content').focus(); 'ok'`);
    await send('Input.insertText', { text: 'SELECT 1 AS a,\nFROM nowhere_at_all' });
    await sleep(300);
    await evaluate(`document.querySelector('[data-testid="run-query"]').click(); 'ok'`);
    await waitFor(`!!document.querySelector('[data-testid="query-error"]')`, 20000, 'error panel');
    report.details.errorPanel = await evaluate(`({ title: document.querySelector('[data-testid="query-error"] h3').textContent, goto: [...document.querySelectorAll('[data-testid="query-error"] button')].map(b => b.textContent.trim()) })`);
    await evaluate(`[...document.querySelectorAll('[data-testid="query-error"] button')].find(b => b.textContent.startsWith('Go to line')).click(); 'ok'`);
    await sleep(300);
    report.details.selection = await evaluate(`window.getSelection().toString()`);
    // ⌘S opens Save; Escape closes it.
    await key('s', META, 'KeyS');
    await waitFor(`!!document.querySelector('[role="dialog"][aria-label="Save query"]')`, 5000, 'save dialog from ⌘S');
    report.details.saveFocus = await evaluate(`document.activeElement?.tagName`);
    await key('Escape');
    await waitFor(`!document.querySelector('[role="dialog"]')`, 3000, 'save dialog closed');
    // The shortcuts sheet.
    await evaluate(`document.querySelector('[aria-label="More query actions"]').click(); 'ok'`);
    await waitFor(`[...document.querySelectorAll('[role=menuitem]')].some(b => b.textContent.includes('Keyboard shortcuts'))`, 3000, 'menu');
    await evaluate(`[...document.querySelectorAll('[role=menuitem]')].find(b => b.textContent.includes('Keyboard shortcuts')).click(); 'ok'`);
    await waitFor(`!!document.querySelector('[data-testid="shortcuts"]')`, 3000, 'shortcuts');
    report.details.shortcuts = await evaluate(`[...document.querySelectorAll('[data-testid="shortcuts"] dt')].map(d => d.textContent)`);
    { const shot = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(out.replace('.png', '_shortcuts.png'), Buffer.from(shot.result.data, 'base64')); }
    await key('Escape');
    report.details.charts = 1;
  }
  else if (scenario === 'data-explorer') {
    // A dataset, then one of its columns in depth, then where the table comes from.
    const wsId = await evaluate(`localStorage.getItem('duckview.workspace')`);
    const q = async (sql) => (await authed(`/api/workspaces/${wsId}/query`, { method: 'POST', body: JSON.stringify({ sql }) })).json();
    await q("CREATE OR REPLACE TABLE e2e_explorer AS SELECT range AS id, (['north', 'south', 'south', 'east'])[1 + range % 4] AS region, CASE WHEN range % 10 = 0 THEN NULL ELSE range * 2.5 END AS amount FROM range(200)");
    cleanup = async () => { await q('DROP TABLE IF EXISTS e2e_explorer'); };
    await evaluate(`location.hash = '#/data?table=e2e_explorer'; 'ok'`);
    await waitFor(`document.querySelector('[data-testid="dataset-name"]')?.textContent === 'e2e_explorer'`, 30000, 'dataset overview');
    report.details.object = await evaluate(`document.querySelector('[data-testid="page-object"]')?.textContent`);
    await waitFor(`[...document.querySelectorAll('[data-testid="dataset-overview"] button[title="Column details"]')].some(b => b.textContent === 'region')`, 10000, 'column list');
    await evaluate(`[...document.querySelectorAll('[data-testid="dataset-overview"] button[title="Column details"]')].find(b => b.textContent === 'region').click(); 'ok'`);
    await waitFor(`!!document.querySelector('[data-testid="column-detail"]')`, 5000, 'column detail');
    report.details.column = await evaluate(`({ stats: [...document.querySelectorAll('[data-testid="column-detail"] dt')].map(d => d.textContent), values: [...document.querySelectorAll('[data-testid="column-detail"] li span:first-child')].map(s => s.textContent).slice(0, 3) })`);
    { const shot = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(out.replace('.png', '_column.png'), Buffer.from(shot.result.data, 'base64')); }
    await evaluate(`document.querySelector('[data-testid="column-detail"]').closest('[role=dialog]').querySelector('[aria-label="Close"]').click(); 'ok'`);
    await waitFor(`!document.querySelector('[data-testid="column-detail"]')`, 3000, 'detail closed');
    await clickButton('Lineage');
    await waitFor(`location.hash.startsWith('#/governance/lineage?focus=e2e_explorer')`, 5000, 'lineage link');
    report.details.lineageHash = await evaluate(`location.hash`);
    report.details.charts = 1;
  }
  else if (scenario === 'ai-context') {
    // The AI sees what is on screen: a dashboard's widgets go with the question, unless the chip is removed.
    const http = await import('node:http');
    const wsId = await evaluate(`localStorage.getItem('duckview.workspace')`);
    const j = async (method, url, body) => (await authed(url, { method, body: body ? JSON.stringify(body) : undefined })).json();
    const prompts = [];
    const llm = http.createServer((req, res) => {
      let b = '';
      req.on('data', (d) => (b += d));
      req.on('end', () => {
        if (!req.url.includes('chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"models":[],"data":[]}'); return; }
        prompts.push(JSON.parse(b));
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', model: 'mock', choices: [{ index: 0, delta: { content: 'The dashboard has one widget.' }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', model: 'mock', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`);
        res.end('data: [DONE]\n\n');
      });
    });
    await new Promise((r) => llm.listen(0, '127.0.0.1', r));
    const dash = (await j('POST', `/api/workspaces/${wsId}/dashboards`, { name: `E2E AI context ${Date.now()}` })).dashboard;
    await j('POST', `/api/dashboards/${dash.id}/widgets`, { title: 'Orders this week', widget_type: 'KPI', custom_sql: 'SELECT 42 AS orders', chart_config: { value: 'orders' } });
    cleanup = async () => {
      llm.close();
      await evaluate(`localStorage.removeItem('duckview.copilot.settings'); true`).catch(() => undefined);
      await j('DELETE', `/api/dashboards/${dash.id}`);
    };
    await evaluate(`localStorage.setItem('duckview.copilot.settings', JSON.stringify({ provider: 'ollama', model: 'mock', apiKey: '', baseUrl: 'http://127.0.0.1:${llm.address().port}' })); true`);
    await send('Page.reload', {});
    await waitFor(`!!document.querySelector('nav[aria-label="Primary"]')`, 30000, 'signed in');
    await evaluate(`location.hash = '#/dashboards/${dash.id}'; 'ok'`);
    await waitFor(`document.querySelector('[data-testid="page-object"]')?.textContent === ${JSON.stringify(dash.name)}`, 15000, 'dashboard open');
    // ⌘J opens the assistant.
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'j', code: 'KeyJ', modifiers: 4, windowsVirtualKeyCode: 74 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'j', code: 'KeyJ', modifiers: 4 });
    await waitFor(`!!document.querySelector('aside[aria-label="DuckView AI"]')`, 5000, 'AI panel from ⌘J');
    await waitFor(`!!document.querySelector('textarea[placeholder^="Ask about your data"]:not([disabled])')`, 15000, 'copilot ready');
    report.details.chip = await evaluate(`document.querySelector('[data-testid="ai-context-page"]')?.textContent`);
    const ask = async (text) => {
      const before = prompts.length;
      await setField('textarea[placeholder^="Ask about your data"]', text);
      await evaluate(`document.querySelector('button[title="Send"]').click(); true`);
      for (let i = 0; i < 100 && prompts.length === before; i++) await sleep(100);
      await waitFor(`![...document.querySelectorAll('aside[aria-label="DuckView AI"] button')].some(b => b.title === 'Stop')`, 15000, 'answer finished');
      const p = prompts.at(-1);
      return (p?.messages ?? []).filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    };
    const withPage = await ask('What does this show?');
    report.details.withPage = { onScreen: withPage.includes('On screen now'), dashboard: withPage.includes(`Dashboard "${dash.name}"`), widget: withPage.includes('kpi "Orders this week": SELECT 42 AS orders') };
    await evaluate(`document.querySelector('[data-testid="ai-context-page"] button').click(); true`);
    const withoutPage = await ask('And in general?');
    report.details.withoutPage = withoutPage.includes('On screen now');
    // ⌘K: anything typed can be asked.
    await evaluate(`document.querySelector('header button[aria-label="Search or run a command"]').click(); 'ok'`);
    await waitFor(`!!document.querySelector('[role="dialog"] input')`, 5000, 'palette');
    await setField('[role="dialog"] input', 'how many widgets are here');
    await waitFor(`[...document.querySelectorAll('[role="dialog"] [role="option"], [role="dialog"] button')].some(b => b.textContent.includes('Ask AI: how many widgets are here'))`, 5000, 'ask entry');
    const n = prompts.length;
    await evaluate(`[...document.querySelectorAll('[role="dialog"] [role="option"], [role="dialog"] button')].find(b => b.textContent.includes('Ask AI: how many widgets are here')).click(); true`);
    for (let i = 0; i < 100 && prompts.length === n; i++) await sleep(100);
    report.details.fromPalette = prompts.length > n && JSON.stringify(prompts.at(-1).messages.at(-1)).includes('how many widgets are here');
    report.details.charts = 1;
  }
  else if (scenario === 'agent-approvals') {
    // An agent tries to change data: the call is held, the owner hears about it, and can run it themselves.
    const wsId = await evaluate(`localStorage.getItem('duckview.workspace')`);
    const j = async (method, url, body) => (await authed(url, { method, body: body ? JSON.stringify(body) : undefined })).json();
    await j('POST', `/api/workspaces/${wsId}/query`, { sql: 'CREATE OR REPLACE TABLE e2e_approval AS SELECT range AS id FROM range(5)' });
    const minted = await j('POST', '/api/tokens', { name: `e2e approvals ${Date.now()}`, scopes: ['read', 'write', 'mcp'] });
    const tabsBefore = new Set(((await j('GET', `/api/workspaces/${wsId}/tabs`)).tabs ?? []).map((t) => t.id));
    cleanup = async () => {
      // Leave the page first: an open workbench saves its tabs back.
      await send('Page.navigate', { url: 'about:blank' });
      await sleep(500);
      await j('DELETE', `/api/tokens/${minted.record?.id ?? minted.token_id ?? minted.id}`);
      await j('POST', `/api/workspaces/${wsId}/query`, { sql: 'DROP TABLE IF EXISTS e2e_approval' });
      for (const t of (await j('GET', `/api/workspaces/${wsId}/tabs`)).tabs ?? []) if (!tabsBefore.has(t.id)) await j('DELETE', `/api/workspaces/${wsId}/tabs/${t.id}`);
    };
    await evaluate(`location.hash = '#/'; 'ok'`);
    await sleep(1500);
    const held = await (await fetch(`${BASE}/api/agent/v1/tools/execute_query`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${minted.token}` }, body: JSON.stringify({ sql: 'DELETE FROM e2e_approval WHERE id = 1', workspace_id: wsId }) })).json();
    report.details.held = held.structured?.status ?? held.text?.slice(0, 40);
    await waitFor(`Number(document.querySelector('[data-testid="inbox-unread"]')?.textContent ?? 0) >= 1`, 10000, 'inbox badge');
    await evaluate(`document.querySelector('[data-testid="inbox-bell"]').click(); 'ok'`);
    await waitFor(`!!document.querySelector('[data-inbox="approval"]')`, 5000, 'approval in the inbox');
    report.details.inbox = await evaluate(`document.querySelector('[data-inbox="approval"]').innerText.split('\\n')[0]`);
    await evaluate(`document.querySelector('[data-inbox="approval"]').click(); 'ok'`);
    await waitFor(`location.hash === '#/agents/approvals' && !!document.querySelector('[data-testid="approvals"] [data-testid="approval-card"]')`, 10000, 'approval card');
    report.details.card = await evaluate(`document.querySelector('[data-testid="approvals"] [data-testid="approval-card"]').innerText.split('\\n').slice(0, 4).join(' | ')`);
    { const shot = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(out.replace('.png', '_approval.png'), Buffer.from(shot.result.data, 'base64')); }
    await clickButton('Run it myself in SQL');
    await waitFor(`location.hash === '#/query' && document.querySelector('.cm-content')?.innerText.includes('DELETE FROM e2e_approval')`, 10000, 'SQL tab with the held statement');
    // Nothing ran on the agent's behalf.
    report.details.rows = (await j('POST', `/api/workspaces/${wsId}/query`, { sql: 'SELECT count(*) FROM e2e_approval' })).rows?.[0]?.[0];
    report.details.charts = 1;
  }
  else if (scenario === 'visual-qa') {
    // Every main page, in a dark and a light theme and at laptop width: screenshots, plus an accessibility audit —
    // controls without a name, fields without a label, text below WCAG AA contrast, content wider than the window.
    const audit = `(() => {
      const cv = document.createElement('canvas'); cv.width = cv.height = 1; const cx = cv.getContext('2d', { willReadFrequently: true });
      const rgba = (c) => { cx.clearRect(0, 0, 1, 1); cx.fillStyle = '#000'; cx.fillStyle = c; cx.fillRect(0, 0, 1, 1); const d = cx.getImageData(0, 0, 1, 1).data; let al = 1; const four = /^rgba\\(([^,]+),([^,]+),([^,]+),([^)]+)\\)/.exec(c); const slash = /\\/\\s*([0-9.]+%?)\\s*\\)\\s*$/.exec(c); if (four) al = parseFloat(four[4]); else if (slash) al = slash[1].endsWith('%') ? parseFloat(slash[1]) / 100 : parseFloat(slash[1]); if (c === 'transparent') al = 0; return [d[0], d[1], d[2], al]; };
      const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
      const vis = (el) => { const r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1 || r.bottom < 0 || r.top > innerHeight) return false; const cs = getComputedStyle(el); return cs.visibility !== 'hidden' && cs.display !== 'none'; };
      const opacity = (el) => { let o = 1; for (let e = el; e && e !== document.documentElement; e = e.parentElement) o *= parseFloat(getComputedStyle(e).opacity); return o; };
      const bgOf = (el) => { const layers = []; for (let e = el; e; e = e.parentElement) { const c = rgba(getComputedStyle(e).backgroundColor); if (c[3] > 0) { layers.push(c); if (c[3] >= 0.99) break; } } let out = rgba(getComputedStyle(document.body).backgroundColor); for (const c of layers.reverse()) out = [0, 1, 2].map((i) => c[i] * c[3] + out[i] * (1 - c[3])).concat(1); return out; };
      const name = (el) => (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').trim();
      const unnamed = [...document.querySelectorAll('button, a[href], [role=button], [role=tab], [role=menuitem]')].filter(vis).filter((el) => !name(el) && !el.closest('[aria-hidden=true]')).map((el) => el.outerHTML.slice(0, 140));
      const labelled = (el) => el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || (el.id && document.querySelector('label[for="' + CSS.escape(el.id) + '"]')) || el.closest('label') || el.getAttribute('title');
      const unlabeled = [...document.querySelectorAll('input:not([type=hidden]), select, textarea')].filter((el) => vis(el) && !el.closest('.cm-editor')).filter((el) => !labelled(el)).map((el) => el.outerHTML.slice(0, 140));
      const texts = [...document.querySelectorAll('body *')].filter((el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 1) && vis(el) && !el.closest('svg, .cm-editor, [aria-hidden=true], canvas') && opacity(el) > 0.99).slice(0, 800);
      const low = [];
      for (const el of texts) {
        const cs = getComputedStyle(el); const fg = rgba(cs.color); const bg = bgOf(el);
        const f = [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3]));
        const l1 = lum(f), l2 = lum(bg); const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
        const size = parseFloat(cs.fontSize); const large = size >= 24 || (size >= 18.66 && parseInt(cs.fontWeight) >= 700);
        if (ratio < (large ? 3 : 4.5)) low.push({ text: el.textContent.trim().slice(0, 40), ratio: Math.round(ratio * 100) / 100, cls: String(el.className).slice(0, 80) });
      }
      return { unnamed, unlabeled, contrast: { checked: texts.length, low: low.length, worst: low.sort((a, b) => a.ratio - b.ratio).slice(0, 6) }, overflow: document.documentElement.scrollWidth > innerWidth + 1 };
    })()`;
    const pages = ['#/', '#/data', '#/query', '#/dashboards', '#/apps', '#/agents', '#/connections', '#/transform/metrics', '#/governance/catalog', '#/templates', '#/settings/usage', '#/settings/users'];
    const runs = [{ theme: 'midnight', width: 1440 }, { theme: 'daylight', width: 1440 }, { theme: 'midnight', width: 1024 }];
    const dir = out.replace(/\.png$/, '');
    fs.mkdirSync(dir, { recursive: true });
    const results = [];
    cleanup = async () => { await evaluate(`localStorage.removeItem('duckview.theme'); 'ok'`); await send('Emulation.clearDeviceMetricsOverride'); };
    for (const r of runs) {
      await send('Emulation.setDeviceMetricsOverride', { width: r.width, height: 1000, deviceScaleFactor: 1, mobile: false });
      await evaluate(`localStorage.setItem('duckview.theme', JSON.stringify({ themeId: '${r.theme}' })); 'ok'`);
      await send('Page.reload', {});
      await waitFor(`!!document.querySelector('nav[aria-label="Primary"]')`, 30000, 'shell');
      for (const pg of pages) {
        await evaluate(`location.hash = '${pg}'; 'ok'`);
        await sleep(pg === '#/data' || pg === '#/query' ? 3500 : 2200);
        const res = await evaluate(audit);
        results.push({ theme: r.theme, width: r.width, page: pg, unnamed: res.unnamed.length, unlabeled: res.unlabeled.length, low: res.contrast.low, overflow: res.overflow, examples: { unnamed: res.unnamed.slice(0, 2), unlabeled: res.unlabeled.slice(0, 2), contrast: res.contrast.worst.slice(0, 3) } });
        const shot = await send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(`${dir}/${r.theme}-${r.width}-${pg.replace(/[#/]+/g, '_').replace(/^_|_$/g, '') || 'home'}.png`, Buffer.from(shot.result.data, 'base64'));
      }
    }
    report.details.pages = results.map((x) => `${x.theme}@${x.width} ${x.page}: ${x.unnamed} unnamed · ${x.unlabeled} unlabeled · ${x.low} low-contrast${x.overflow ? ' · OVERFLOW' : ''}`);
    report.details.problems = results.filter((x) => x.unnamed || x.unlabeled || x.low || x.overflow).map((x) => ({ at: `${x.theme}@${x.width} ${x.page}`, ...x.examples }));
    report.details.screenshots = dir;
    report.details.charts = 1;
  }
  else if (scenario === 'orchestration') {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const j = async (method, url, body) => (await authed(url, { method, body: body ? JSON.stringify(body) : undefined })).json();
    const wsId = await evaluate(`localStorage.getItem('duckview.workspace')`);
    const q = (sql) => j('POST', `/api/workspaces/${wsId}/query`, { sql });
    await q("CREATE OR REPLACE TABLE e2e_orch_raw AS SELECT * FROM (VALUES (1, 10.0), (2, -5.0)) t(id, amount)");
    const sync = (await j('POST', `/api/workspaces/${wsId}/syncs`, { name: 'E2E orchestrated sync', source: { kind: 'sql', sql: 'SELECT * FROM e2e_orch_raw' }, target_table: 'e2e_orch_stg' })).sync;
    const minted = await j('POST', '/api/tokens', { name: 'E2E orchestrator', scopes: ['read', 'write'] });
    cleanup = async () => {
      if (sync?.id) await j('DELETE', `/api/syncs/${sync.id}`);
      if (minted?.record?.id) await j('DELETE', `/api/tokens/${minted.record.id}`);
      await q('DROP TABLE IF EXISTS e2e_orch_raw');
      await q('DROP TABLE IF EXISTS e2e_orch_stg');
    };
    // As Airflow would: start, then long-poll.
    const as = (method, url, body) => fetch(`${BASE}${url}`, { method, headers: { authorization: `Bearer ${minted.token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());
    const started = await as('POST', '/api/orchestrate/runs', { kind: 'sync', id: sync.id, source: 'airflow', external_run_id: 'scheduled__e2e' });
    const done = await as('GET', `/api/orchestrate/runs/${started.run.id}?wait=30`);
    report.details.airflow = `${done.run.status}: ${done.run.summary}`;
    // The Python SDK: a SQL check that finds bad rows fails.
    try {
      await promisify(execFile)('python3', ['-c', "import sys; sys.path.insert(0, 'packages/sdk-python'); from duckview.orchestrate import run, RunFailed\ntry:\n    run('query', sys.argv[1], sql='SELECT * FROM e2e_orch_raw WHERE amount < 0', fail_if='rows')\n    print('passed')\nexcept RunFailed as e:\n    print('failed:', e.run['summary'])", wsId], { env: { ...process.env, DUCKVIEW_URL: BASE, DUCKVIEW_TOKEN: minted.token } }).then(({ stdout }) => (report.details.python = stdout.trim()));
    } catch (err) {
      report.details.python = `error: ${err.stderr ?? err.message}`;
    }
    await send('Page.navigate', { url: `${BASE}/#/` });
    await waitFor(`!!document.querySelector('[data-testid="ai-toggle"]')`, 20000, 'app');
    await evaluate(`location.hash = '#/settings/orchestration'; true`);
    await waitFor(`document.querySelectorAll('[data-testid="orchestration-runs"] tbody tr').length >= 2`, 20000, 'runs listed');
    report.details.rows = await evaluate(`[...document.querySelectorAll('[data-testid="orchestration-runs"] tbody tr')].slice(0, 2).map(r => r.dataset.runStatus + ' | ' + [...r.querySelectorAll('td')].slice(1, 5).map(td => td.innerText.trim()).join(' | '))`);
    report.details.snippet = await evaluate(`document.querySelector('[data-testid="orchestration-snippet"]').innerText.includes(${JSON.stringify(sync.id)})`);
    await sleep(300);
    { const shot = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(out.replace('.png', '_orchestration.png'), Buffer.from(shot.result.data, 'base64')); }
    report.details.charts = 1;
  }
  else if (scenario === 'pgwire') {
    const { createRequire } = await import('node:module');
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const require = createRequire(new URL('../packages/server/package.json', import.meta.url));
    const pg = require('pg');
    const j = async (method, url, body) => (await authed(url, { method, body: body ? JSON.stringify(body) : undefined })).json();
    const wsId = await evaluate(`localStorage.getItem('duckview.workspace')`);
    const q = (sql) => j('POST', `/api/workspaces/${wsId}/query`, { sql });
    cleanup = async () => {
      await q('DROP TABLE IF EXISTS e2e_pg_orders');
    };
    await q("CREATE OR REPLACE TABLE e2e_pg_orders AS SELECT * FROM (VALUES (1, 'EU', 19.90), (2, 'US', 5.00), (3, 'EU', 7.50)) t(id, region, amount)");
    const info = await j('GET', '/api/pgwire');
    if (!info.enabled) throw new Error('The Postgres protocol listener is off (restart with DUCKVIEW__pgwire__enabled=true)');
    const workspace = (await j('GET', '/api/workspaces')).workspaces?.find((w) => w.id === wsId)?.name ?? info.databases[0];
    await send('Page.navigate', { url: `${BASE}/#/` });
    await waitFor(`!!document.querySelector('[data-testid="ai-toggle"]')`, 20000, 'app');
    await evaluate(`location.hash = '#/settings/sql-clients'; true`);
    await waitFor(`!!document.querySelector('[data-testid="pgwire-fields"]')`, 15000, 'panel');
    report.details.fields = await evaluate(`[...document.querySelectorAll('[data-testid="pgwire-fields"] dd')].map(d => d.firstChild?.textContent?.trim() ?? '')`);
    await sleep(300);
    { const shot = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(out.replace('.png', '_pgwire.png'), Buffer.from(shot.result.data, 'base64')); }
    // psql, with the account's password.
    try {
      const { stdout } = await promisify(execFile)('psql', ['-h', '127.0.0.1', '-p', String(info.port), '-U', EMAIL, '-d', workspace, '-At', '-c', "SELECT region || '=' || sum(amount) FROM e2e_pg_orders GROUP BY region ORDER BY region"], { env: { ...process.env, PGPASSWORD: PASSWORD, PGCONNECT_TIMEOUT: '10' } });
      report.details.psql = stdout.trim().split('\n');
    } catch (err) {
      report.details.psql = err.code === 'ENOENT' ? 'skipped: psql not installed' : `error: ${err.stderr ?? err.message}`;
    }
    // node-postgres: the extended protocol, with parameters.
    const c = new pg.Client({ host: '127.0.0.1', port: info.port, user: EMAIL, password: PASSWORD, database: workspace });
    await c.connect();
    report.details.driver = (await c.query('SELECT id, amount FROM e2e_pg_orders WHERE region = $1 AND amount > $2 ORDER BY id', ['EU', 10])).rows;
    report.details.version = (await c.query('SELECT version() AS v')).rows[0].v;
    await c.end();
    report.details.charts = 1;
  }
  else if (scenario === 'lake-write') {
    const j = async (method, url, body) => (await authed(url, { method, body: body ? JSON.stringify(body) : undefined })).json();
    const wsId = await evaluate(`localStorage.getItem('duckview.workspace')`);
    const q = (sql) => j('POST', `/api/workspaces/${wsId}/query`, { sql });
    const dataDir = (await (await fetch(`${BASE}/readyz`)).json()).checks?.data_directory?.detail;
    const deltaRel = `lake/e2e_orders_${Date.now()}`;
    const iceberg = process.env.E2E_ICEBERG ?? 'http://localhost:8181';
    const icebergUp = await fetch(`${iceberg}/v1/config`).then((r) => r.ok, () => false);
    const made = { lake: null, cloud: null };
    cleanup = async () => {
      for (const x of (await j('GET', `/api/workspaces/${wsId}/reverse-syncs`)).syncs ?? []) if (x.name.startsWith('E2E lake')) await j('DELETE', `/api/reverse-syncs/${x.id}`);
      if (made.lake) await j('DELETE', `/api/lakehouse-connections/${made.lake}`);
      if (made.cloud) await j('DELETE', `/api/cloud-connections/${made.cloud}`);
      await q('DROP TABLE IF EXISTS e2e_lake_orders');
      if (dataDir) fs.rmSync(`${dataDir}/${deltaRel}`, { recursive: true, force: true });
      // The parent folder too, when this left it empty.
      if (dataDir) try { fs.rmdirSync(`${dataDir}/lake`); } catch { /* not empty, or gone */ }
    };
    const created = await q("CREATE OR REPLACE TABLE e2e_lake_orders AS SELECT * FROM (VALUES (1, 'EU', 120.5, TIMESTAMP '2026-09-01 10:00:00'), (2, 'US', 80.0, TIMESTAMP '2026-09-02 12:00:00'), (3, 'EU', 45.25, TIMESTAMP '2026-09-03 08:30:00')) t(id, region, amount, placed_at)");
    if (created.error) throw new Error(created.message);
    if (icebergUp) {
      made.lake = (await j('POST', '/api/lakehouse-connections', { name: 'E2E lake catalog', provider: 'ICEBERG_REST', alias: 'e2e_ice', config: { endpoint: iceberg, auth: 'none', warehouse: '' }, credentials: {} })).connection?.id ?? null;
      made.cloud = (await j('POST', '/api/cloud-connections', { name: 'E2E lake storage', provider: 'S3', endpoint_url: process.env.E2E_ICEBERG_S3 ?? 'http://localhost:9000', region: 'us-east-1', bucket: 'warehouse', credentials: { access_key_id: 'admin', secret_access_key: 'password' } })).connection?.id ?? null;
    }
    await send('Page.navigate', { url: `${BASE}/#/` });
    await waitFor(`!!document.querySelector('[data-testid="ai-toggle"]')`, 20000, 'app');
    await evaluate(`location.hash = '#/connections/reverse'; true`);
    await waitFor(`!!document.querySelector('[data-testid="new-reverse-sync"]')`, 20000, 'reverse tab');
    const setVal = (sel, v) => evaluate(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(v)}); el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); return true; })()`);
    const lastRun = (name) => `document.querySelector('[data-reverse="${name}"] [data-testid="reverse-last-run"]')?.innerText ?? ''`;
    // 1. Delta Lake, in the data directory.
    await evaluate(`document.querySelector('[data-testid="new-reverse-sync"]').click(); true`);
    await waitFor(`!!document.querySelector('[data-testid="reverse-editor"]')`, 5000, 'editor');
    await setVal('[data-testid="reverse-name"]', 'E2E lake Delta');
    await setVal('[data-testid="reverse-sql"]', 'SELECT * FROM e2e_lake_orders');
    await evaluate(`document.querySelector('[data-kind="delta"]').click(); true`);
    await waitFor(`!!document.querySelector('[data-testid="reverse-delta-path"]')`, 5000, 'delta fields');
    await setVal('[data-testid="reverse-delta-path"]', deltaRel);
    await evaluate(`document.querySelector('[data-testid="save-reverse"]').click(); true`);
    await waitFor(`!!document.querySelector('[data-reverse="E2E lake Delta"]')`, 15000, 'delta sync listed');
    await evaluate(`document.querySelector('[data-reverse="E2E lake Delta"] [data-testid="run-reverse"]').click(); true`);
    await waitFor(`/rows written/.test(${lastRun('E2E lake Delta')})`, 30000, 'delta run');
    report.details.delta = await evaluate(lastRun('E2E lake Delta'));
    const scanned = await q(`SELECT count(*)::INTEGER AS n, sum(amount)::DOUBLE AS total FROM delta_scan('${dataDir}/${deltaRel}')`);
    report.details.deltaRead = scanned.rows ?? scanned.message;
    // 2. Apache Iceberg, through the lakehouse connection.
    if (icebergUp && made.lake) {
      const ns = `e2e_${Date.now()}`;
      await send('Page.reload', {});
      await waitFor(`!!document.querySelector('[data-testid="new-reverse-sync"]')`, 20000, 'reverse tab again');
      await evaluate(`document.querySelector('[data-testid="new-reverse-sync"]').click(); true`);
      await waitFor(`!!document.querySelector('[data-testid="reverse-editor"]')`, 5000, 'editor');
      await setVal('[data-testid="reverse-name"]', 'E2E lake Iceberg');
      await setVal('[data-testid="reverse-sql"]', 'SELECT * FROM e2e_lake_orders');
      await evaluate(`document.querySelector('[data-kind="iceberg"]').click(); true`);
      await waitFor(`!!document.querySelector('[data-testid="reverse-lake"] option[value="${made.lake}"]')`, 5000, 'catalog listed');
      await setVal('[data-testid="reverse-lake"]', made.lake);
      await setVal('[data-testid="reverse-namespace"]', ns);
      await setVal('[data-testid="reverse-iceberg-table"]', 'orders');
      await setVal('select[aria-label="Storage credentials"]', made.cloud);
      await evaluate(`document.querySelector('[data-testid="save-reverse"]').click(); true`);
      await waitFor(`!!document.querySelector('[data-reverse="E2E lake Iceberg"]')`, 15000, 'iceberg sync listed');
      await evaluate(`document.querySelector('[data-reverse="E2E lake Iceberg"] [data-testid="run-reverse"]').click(); true`);
      await waitFor(`/rows written|error|failed/i.test(${lastRun('E2E lake Iceberg')})`, 60000, 'iceberg run');
      report.details.iceberg = await evaluate(lastRun('E2E lake Iceberg'));
      const read = await q(`SELECT count(*)::INTEGER AS n FROM e2e_ice.${ns}.orders`);
      report.details.icebergRead = read.rows ?? read.message;
    } else report.details.iceberg = `skipped: no Iceberg catalog at ${iceberg}`;
    await sleep(300);
    { const shot = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(out.replace('.png', '_lake.png'), Buffer.from(shot.result.data, 'base64')); }
    report.details.charts = 1;
  }
  else if (scenario === 'saas-sources') {
    const ids = ['github', 'jira', 'zendesk', 'shopify', 'intercom', 'linear', 'pipedrive', 'mailchimp'];
    await send('Page.navigate', { url: `${BASE}/#/` });
    await waitFor(`!!document.querySelector('[data-testid="ai-toggle"]')`, 20000, 'app');
    await evaluate(`location.hash = '#/connections/catalog'; true`);
    await waitFor(`!!document.querySelector('[data-source="github"]')`, 20000, 'catalog');
    report.details.cards = await evaluate(`${JSON.stringify(ids)}.filter(id => !!document.querySelector('[data-source="' + id + '"]'))`);
    await setField('input[placeholder^="Search sources"]', 'jira');
    await waitFor(`!!document.querySelector('[data-source="jira"]') && !document.querySelector('[data-source="github"]')`, 5000, 'search');
    await evaluate(`document.querySelector('[data-source="jira"]').click(); true`);
    await waitFor(`/API token/.test(document.body.innerText) && /Site URL/.test(document.body.innerText)`, 10000, 'jira form');
    report.details.jiraForm = await evaluate(`['Site URL', 'Atlassian account email', 'API token'].every(t => document.body.innerText.includes(t))`);
    await sleep(400);
    { const shot = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(out.replace('.png', '_jira.png'), Buffer.from(shot.result.data, 'base64')); }
    report.details.charts = 1;
  }
  else if (scenario === 'cdc') {
    const { createRequire } = await import('node:module');
    const require = createRequire(new URL('../packages/server/package.json', import.meta.url));
    const pg = require('pg');
    const j = async (method, url, body) => (await authed(url, { method, body: body ? JSON.stringify(body) : undefined })).json();
    const wsId = await evaluate(`localStorage.getItem('duckview.workspace')`);
    const q = (sql) => j('POST', `/api/workspaces/${wsId}/query`, { sql });
    const url = new URL(process.env.E2E_PG_CDC ?? 'postgres://cdc:cdcpass@localhost:55432/shop');
    const src = new pg.Client({ connectionString: url.toString() });
    try {
      await src.connect();
    } catch (err) {
      report.details.skipped = `no Postgres at ${url.host} (${err.message})`;
    }
    if (!report.details.skipped) {
      const table = `e2e_customers_${Date.now()}`;
      await src.query(`CREATE TABLE ${table} (id int PRIMARY KEY, name text, plan text, mrr numeric(8,2))`);
      await src.query(`INSERT INTO ${table} VALUES (1, 'Acme', 'pro', 99.00), (2, 'Globex', 'free', 0), (3, 'Initech', 'team', 49.50)`);
      const conn = await j('POST', '/api/database-connections', { name: 'E2E CDC source', engine: 'postgres', config: { host: url.hostname, port: Number(url.port), database: url.pathname.slice(1), user: url.username }, password: decodeURIComponent(url.password) });
      const connId = conn.connection?.id ?? conn.id;
      const before = new Set(((await j('GET', `/api/workspaces/${wsId}/streams`)).streams ?? []).map((x) => x.id));
      cleanup = async () => {
        for (const x of (await j('GET', `/api/workspaces/${wsId}/streams`)).streams ?? []) if (!before.has(x.id)) await j('DELETE', `/api/streams/${x.id}`);
        await j('DELETE', `/api/database-connections/${connId}`);
        await q('DROP TABLE IF EXISTS e2e_customers');
        await q('DROP TABLE IF EXISTS e2e_customers__changes');
        await src.query(`DROP TABLE IF EXISTS ${table}`).catch(() => undefined);
        await src.end().catch(() => undefined);
      };
      await q('DROP TABLE IF EXISTS e2e_customers');
      await q('DROP TABLE IF EXISTS e2e_customers__changes');
      await send('Page.navigate', { url: `${BASE}/#/` });
      await waitFor(`!!document.querySelector('[data-testid="ai-toggle"]')`, 20000, 'app');
      await evaluate(`location.hash = '#/connections/streams'; true`);
      await waitFor(`!!document.querySelector('[data-testid="stream-new"]')`, 20000, 'streams tab');
      await evaluate(`document.querySelector('[data-testid="stream-new"]').click(); true`);
      await evaluate(`document.querySelector('[data-testid="stream-kind-postgres"]').click(); true`);
      await waitFor(`!!document.querySelector('[data-testid="stream-pg-connection"] option[value="${connId}"]')`, 10000, 'connection listed');
      await setField('[data-testid="stream-pg-connection"]', connId, 'change');
      await setField('[data-testid="stream-pg-table"]', table);
      await setField('[data-testid="stream-table"]', 'e2e_customers');
      await evaluate(`document.querySelector('[data-testid="stream-history"]').click(); true`);
      await evaluate(`document.querySelector('[data-testid="stream-test"]').click(); true`);
      await waitFor(`!!document.querySelector('[data-testid="stream-tested"]')`, 20000, 'connection tested');
      report.details.tested = await evaluate(`document.querySelector('[data-testid="stream-tested"]').innerText`);
      await evaluate(`document.querySelector('[data-testid="stream-save"]').click(); true`);
      await waitFor(`document.querySelectorAll('[data-stream="e2e_customers"] [data-testid="stream-latest"] tbody tr').length === 3`, 30000, 'snapshot rows');
      await waitFor(`document.querySelector('[data-stream="e2e_customers"] [data-testid="stream-status"]')?.innerText === 'running'`, 20000, 'running');
      // Changes made in Postgres arrive.
      await src.query(`UPDATE ${table} SET plan = 'team', mrr = 49.50 WHERE id = 2`);
      await src.query(`DELETE FROM ${table} WHERE id = 3`);
      await waitFor(`document.querySelectorAll('[data-stream="e2e_customers"] [data-testid="stream-latest"] tbody tr').length === 2`, 30000, 'delete mirrored');
      await sleep(1500);
      report.details.mirror = (await q('SELECT id, name, plan, mrr::DOUBLE AS mrr FROM e2e_customers ORDER BY id')).rows;
      report.details.history = (await q('SELECT _op, count(*)::INTEGER FROM e2e_customers__changes GROUP BY 1 ORDER BY 1')).rows;
      report.details.detail = await evaluate(`document.querySelector('[data-stream="e2e_customers"]').innerText.split('\\n').slice(0, 5).join(' | ')`);
      { const shot = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(out.replace('.png', '_cdc.png'), Buffer.from(shot.result.data, 'base64')); }
      // Removing the stream drops the slot.
      const streams = (await j('GET', `/api/workspaces/${wsId}/streams`)).streams;
      const st = streams.find((x) => x.target_table === 'e2e_customers');
      await j('DELETE', `/api/streams/${st.id}`);
      report.details.slotsLeft = (await src.query(`SELECT count(*)::int AS n FROM pg_replication_slots WHERE slot_name LIKE 'duckview_${st.id.replace(/-/g, '').slice(0, 24)}%'`)).rows[0].n;
    }
    report.details.charts = 1;
  }
  else if (scenario === 'streams') {
    const { createRequire } = await import('node:module');
    const require = createRequire(new URL('../packages/server/package.json', import.meta.url));
    const { Kafka, logLevel } = require('kafkajs');
    const j = async (method, url, body) => (await authed(url, { method, body: body ? JSON.stringify(body) : undefined })).json();
    const wsId = await evaluate(`localStorage.getItem('duckview.workspace')`);
    const q = (sql) => j('POST', `/api/workspaces/${wsId}/query`, { sql });
    const before = new Set(((await j('GET', `/api/workspaces/${wsId}/streams`)).streams ?? []).map((x) => x.id));
    cleanup = async () => {
      for (const x of (await j('GET', `/api/workspaces/${wsId}/streams`)).streams ?? []) if (!before.has(x.id)) await j('DELETE', `/api/streams/${x.id}`);
      await q('DROP TABLE IF EXISTS e2e_clicks');
      await q('DROP TABLE IF EXISTS e2e_kafka_orders');
    };
    await q('DROP TABLE IF EXISTS e2e_clicks');
    await q('DROP TABLE IF EXISTS e2e_kafka_orders');
    await send('Page.navigate', { url: `${BASE}/#/` });
    await waitFor(`!!document.querySelector('[data-testid="ai-toggle"]')`, 20000, 'app');
    await evaluate(`location.hash = '#/connections/streams'; true`);
    await waitFor(`!!document.querySelector('[data-testid="stream-new"]')`, 20000, 'streams tab');
    // 1. An HTTP push stream.
    await evaluate(`document.querySelector('[data-testid="stream-new"]').click(); true`);
    await evaluate(`document.querySelector('[data-testid="stream-kind-http"]').click(); true`);
    await setField('[data-testid="stream-table"]', 'e2e_clicks');
    await evaluate(`document.querySelector('[data-testid="stream-save"]').click(); true`);
    await waitFor(`!!document.querySelector('[data-testid="stream-key"]')`, 15000, 'push key shown');
    const key = await evaluate(`document.querySelector('[data-testid="stream-key"]').innerText`);
    const pushUrl = await evaluate(`document.querySelector('[data-testid="stream-push"] code').innerText`);
    const pushed = await fetch(pushUrl, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify([{ page: '/home', ms: 120 }, { page: '/pricing', ms: 340 }, { page: '/docs', ms: 80 }]) });
    report.details.push = pushed.status;
    await waitFor(`[...document.querySelectorAll('[data-stream="e2e_clicks"] [data-testid="stream-rows"]')].some(e => e.innerText.startsWith('3 rows'))`, 15000, 'rows counted live');
    await waitFor(`document.querySelectorAll('[data-stream="e2e_clicks"] [data-testid="stream-latest"] tbody tr').length === 3`, 10000, 'latest rows');
    report.details.http = await evaluate(`document.querySelector('[data-stream="e2e_clicks"] [data-testid="stream-rows"]').innerText`);
    report.details.wrongKey = (await fetch(pushUrl, { method: 'POST', headers: { authorization: 'Bearer dvs_nope', 'content-type': 'application/json' }, body: '[]' })).status;
    // 2. A Kafka stream.
    const brokers = (process.env.E2E_KAFKA ?? 'localhost:19092').split(',');
    const topic = `e2e-orders-${Date.now()}`;
    const kafka = new Kafka({ clientId: 'e2e', brokers, logLevel: logLevel.NOTHING, connectionTimeout: 3000, retry: { retries: 1 } });
    let kafkaUp = true;
    try {
      const admin = kafka.admin();
      await admin.connect();
      await admin.createTopics({ topics: [{ topic, numPartitions: 1 }], waitForLeaders: true });
      await admin.disconnect();
      const producer = kafka.producer();
      await producer.connect();
      await producer.send({ topic, messages: [1, 2, 3, 4].map((i) => ({ key: `o${i}`, value: JSON.stringify({ order_id: i, amount: i * 25, status: i % 2 ? 'paid' : 'refunded' }) })) });
      await producer.disconnect();
    } catch (err) {
      kafkaUp = false;
      report.details.kafka = `skipped: no broker at ${brokers.join(',')} (${err.message})`;
    }
    if (kafkaUp) {
      await evaluate(`document.querySelector('[data-testid="stream-new"]').click(); true`);
      await evaluate(`document.querySelector('[data-testid="stream-kind-kafka"]').click(); true`);
      await setField('[data-testid="stream-brokers"]', brokers.join(', '));
      await setField('[data-testid="stream-topic"]', topic);
      await setField('[data-testid="stream-table"]', 'e2e_kafka_orders');
      await evaluate(`document.querySelector('[data-testid="stream-test"]').click(); true`);
      await waitFor(`!!document.querySelector('[data-testid="stream-tested"]')`, 20000, 'connection tested');
      report.details.tested = await evaluate(`document.querySelector('[data-testid="stream-tested"]').innerText`);
      await evaluate(`document.querySelector('[data-testid="stream-save"]').click(); true`);
      await waitFor(`[...document.querySelectorAll('[data-stream="e2e_kafka_orders"] [data-testid="stream-rows"]')].some(e => e.innerText.startsWith('4 rows'))`, 45000, 'kafka rows');
      await waitFor(`document.querySelector('[data-stream="e2e_kafka_orders"] [data-testid="stream-status"]')?.innerText === 'running'`, 20000, 'kafka running');
      report.details.kafka = await evaluate(`document.querySelector('[data-stream="e2e_kafka_orders"]').innerText.split('\\n').slice(0, 4).join(' | ')`);
      const sums = await q('SELECT status, sum(amount)::INTEGER AS total FROM e2e_kafka_orders GROUP BY 1 ORDER BY 1');
      report.details.sums = sums.rows;
    }
    await sleep(500);
    { const shot = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(out.replace('.png', '_streams.png'), Buffer.from(shot.result.data, 'base64')); }
    report.details.charts = 1;
  }
  else if (scenario === 'a2a') {
    const http = await import('node:http');
    const j = async (method, url, body) => (await authed(url, { method, body: body ? JSON.stringify(body) : undefined })).json();
    const wsId = await evaluate(`localStorage.getItem('duckview.workspace')`);
    const beforeAgents = new Set(((await j('GET', `/api/workspaces/${wsId}/hosted-agents`)).agents ?? []).map((a) => a.id));
    const beforeRemotes = new Set(((await j('GET', '/api/a2a/remotes')).remotes ?? []).map((r) => r.id));
    // A remote agent: its card, and JSON-RPC that needs the right bearer token.
    const remote = http.createServer((req, res) => {
      const port = remote.address().port;
      if (req.method === 'GET' && req.url === '/.well-known/agent-card.json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ protocolVersion: '0.3.0', name: 'E2E forecaster', description: 'Forecasts the weather for a city.', url: `http://127.0.0.1:${port}/rpc`, preferredTransport: 'JSONRPC', version: '1', capabilities: { streaming: false }, defaultInputModes: ['text/plain'], defaultOutputModes: ['text/plain'], skills: [{ id: 'forecast', name: 'Forecast', description: 'Weather for a city', tags: ['weather'], examples: ['Weather in Lisbon?'] }] }));
        return;
      }
      let b = '';
      req.on('data', (d) => (b += d));
      req.on('end', () => {
        if (req.headers.authorization !== 'Bearer e2e-secret') { res.writeHead(401); res.end('{}'); return; }
        const body = JSON.parse(b);
        const text = body.params.message.parts.map((p) => p.text ?? '').join(' ');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { kind: 'task', id: 't1', contextId: body.params.message.contextId ?? 'c1', status: { state: 'completed', timestamp: new Date().toISOString() }, artifacts: [{ artifactId: 'a1', parts: [{ kind: 'text', text: `**Sunny**, 24 °C — you asked: ${text}` }] }] } }));
      });
    });
    await new Promise((r) => remote.listen(0, '127.0.0.1', r));
    cleanup = async () => {
      remote.close();
      for (const a of (await j('GET', `/api/workspaces/${wsId}/hosted-agents`)).agents ?? []) if (!beforeAgents.has(a.id)) await j('DELETE', `/api/hosted-agents/${a.id}`);
      for (const r of (await j('GET', '/api/a2a/remotes')).remotes ?? []) if (!beforeRemotes.has(r.id)) await j('DELETE', `/api/a2a/remotes/${r.id}`);
    };
    // DuckView's own card is public.
    report.details.card = (await (await fetch(`${BASE}/.well-known/agent-card.json`)).json()).name;
    // A hosted agent, published.
    await j('POST', `/api/workspaces/${wsId}/hosted-agents`, { template: 'data-analyst', name: 'E2E analyst', schedule: { kind: 'manual' } });
    await send('Page.navigate', { url: `${BASE}/#/` });
    await waitFor(`!!document.querySelector('[data-testid="ai-toggle"]')`, 20000, 'app');
    await evaluate(`location.hash = '#/mcp/hosted'; true`);
    await waitFor(`!!document.querySelector('[data-agent="E2E analyst"]')`, 20000, 'agent listed');
    await evaluate(`document.querySelector('[data-agent="E2E analyst"]').click(); true`);
    await waitFor(`document.querySelector('[data-testid="hosted-detail"] h3')?.innerText.startsWith('E2E analyst')`, 10000, 'agent selected');
    await evaluate(`document.querySelector('[data-testid="hosted-publish"]').click(); true`);
    await waitFor(`[...document.querySelectorAll('[data-testid="a2a-published"] li')].some(li => li.innerText.includes('E2E analyst'))`, 10000, 'published');
    report.details.published = await evaluate(`[...document.querySelectorAll('[data-testid="a2a-published"] li')].find(li => li.innerText.includes('E2E analyst')).innerText.replace(/\\s+/g, ' ')`);
    const agentId = ((await j('GET', `/api/workspaces/${wsId}/hosted-agents`)).agents ?? []).find((a) => a.name === 'E2E analyst').id;
    const own = await fetch(`${BASE}/a2a/agents/${agentId}/.well-known/agent-card.json`);
    report.details.agentCard = own.status === 200 ? (await own.json()).name : own.status;
    // A remote agent, added by its URL with an auth header, then asked.
    await evaluate(`document.querySelector('[data-testid="a2a-add"]').click(); true`);
    await setField('[data-testid="a2a-url"]', `http://127.0.0.1:${remote.address().port}`);
    await setField('[data-testid="a2a-header"]', 'Bearer e2e-secret');
    await evaluate(`document.querySelector('[data-testid="a2a-save"]').click(); true`);
    await waitFor(`!!document.querySelector('[data-remote="E2E forecaster"]')`, 15000, 'remote added');
    report.details.skills = await evaluate(`document.querySelector('[data-remote="E2E forecaster"]').innerText.includes('Forecast')`);
    await setField('[data-remote="E2E forecaster"] [data-testid="a2a-ask-input"]', 'Weather in Lisbon?');
    await evaluate(`document.querySelector('[data-remote="E2E forecaster"] [data-testid="a2a-ask"]').click(); true`);
    await waitFor(`!!document.querySelector('[data-remote="E2E forecaster"] [data-testid="a2a-answer"]')`, 20000, 'answer');
    report.details.answer = await evaluate(`document.querySelector('[data-remote="E2E forecaster"] [data-testid="a2a-answer"]').innerText`);
    await evaluate(`document.querySelector('[data-testid="a2a"]').scrollIntoView(); true`);
    await sleep(300);
    { const shot = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(out.replace('.png', '_a2a.png'), Buffer.from(shot.result.data, 'base64')); }
    report.details.charts = 1;
  }
  else if (scenario === 'hosted-agents') {
    const http = await import('node:http');
    const j = async (method, url, body) => (await authed(url, { method, body: body ? JSON.stringify(body) : undefined })).json();
    const wsId = await evaluate(`localStorage.getItem('duckview.workspace')`);
    const q = (sql) => j('POST', `/api/workspaces/${wsId}/query`, { sql });
    const beforeIds = new Set(((await j('GET', `/api/workspaces/${wsId}/hosted-agents`)).agents ?? []).map((a) => a.id));
    // The model: asks for one query, then answers from its result.
    const llm = http.createServer((req, res) => {
      let b = '';
      req.on('data', (d) => (b += d));
      req.on('end', () => {
        if (!req.url.includes('chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"models":[],"data":[]}'); return; }
        const body = JSON.parse(b);
        const last = String((body.messages ?? []).at(-1)?.content ?? '');
        const answer = last.startsWith('Result of execute_query')
          ? `There are **${/\b(\d+)\b/.exec(last.split('\n').slice(1).join('\n'))?.[1] ?? '?'} orders** in e2e_agent_orders, counted with SQL.`
          : 'I will count them.\n```tool\n{"name": "execute_query", "arguments": {"sql": "SELECT count(*) AS n FROM e2e_agent_orders"}}\n```';
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const piece of answer.match(/[\s\S]{1,40}/g)) res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', model: 'mock', choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', model: 'mock', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 20 } })}\n\n`);
        res.end('data: [DONE]\n\n');
      });
    });
    await new Promise((r) => llm.listen(0, '127.0.0.1', r));
    cleanup = async () => {
      llm.close();
      await evaluate(`localStorage.removeItem('duckview.copilot.settings'); true`).catch(() => undefined);
      for (const a of (await j('GET', `/api/workspaces/${wsId}/hosted-agents`)).agents ?? []) if (!beforeIds.has(a.id)) await j('DELETE', `/api/hosted-agents/${a.id}`);
      await q('DROP TABLE IF EXISTS e2e_agent_orders');
    };
    const made = await q('CREATE OR REPLACE TABLE e2e_agent_orders AS SELECT range AS id FROM range(37)');
    if (made.error) throw new Error(`table not created: ${made.message}`);
    await evaluate(`localStorage.setItem('duckview.copilot.settings', JSON.stringify({ provider: 'ollama', model: 'mock', apiKey: '', baseUrl: 'http://127.0.0.1:${llm.address().port}' })); true`);
    await send('Page.navigate', { url: `${BASE}/#/` });
    await send('Page.reload', {});
    await waitFor(`!!document.querySelector('[data-testid="ai-toggle"]')`, 20000, 'app reloaded');
    await evaluate(`location.hash = '#/mcp/hosted'; true`);
    await waitFor(`!!document.querySelector('[data-template="data-analyst"] [data-testid="template-install"]')`, 20000, 'marketplace');
    report.details.templates = await evaluate(`document.querySelectorAll('[data-testid="marketplace"] [data-template]').length`);
    await evaluate(`document.querySelector('[data-template="data-analyst"] [data-testid="template-install"]').click(); true`);
    await waitFor(`!!document.querySelector('[data-testid="hosted-detail"] [data-testid="hosted-run"]') && document.querySelector('[data-testid="hosted-detail"] h3')?.innerText === 'Data analyst'`, 15000, 'installed');
    await setField('[data-testid="hosted-input"]', 'How many orders are in e2e_agent_orders?');
    await evaluate(`document.querySelector('[data-testid="hosted-run"]').click(); true`);
    await waitFor(`document.querySelector('[data-testid="hosted-run-view"]')?.dataset.status === 'completed'`, 60000, 'run finished');
    await sleep(300);
    report.details.steps = await evaluate(`[...document.querySelectorAll('[data-testid="hosted-steps"] li[data-tool]')].map(li => li.dataset.tool)`);
    report.details.stepSentences = await evaluate(`[...document.querySelectorAll('[data-testid="hosted-steps"] [data-testid="tool-sentence"]')].map(s => s.textContent)`);
    report.details.output = await evaluate(`document.querySelector('[data-testid="hosted-output"]')?.innerText ?? ''`);
    { const shot = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(out.replace('.png', '_run.png'), Buffer.from(shot.result.data, 'base64')); }
    report.details.charts = 1;
  }
  else if (scenario === 'insights') {
    const j = async (method, url, body) => (await authed(url, { method, body: body ? JSON.stringify(body) : undefined })).json();
    const wsId = await evaluate(`localStorage.getItem('duckview.workspace')`);
    const q = (sql) => j('POST', `/api/workspaces/${wsId}/query`, { sql });
    const before = (await j('GET', `/api/workspaces/${wsId}/semantic`)).yaml ?? '';
    cleanup = async () => {
      for (const m of (await j('GET', `/api/workspaces/${wsId}/monitors`)).monitors ?? []) if (m.metric.startsWith('e2e_')) await j('DELETE', `/api/monitors/${m.id}`);
      await j('PUT', `/api/workspaces/${wsId}/semantic`, { yaml: before, force: true });
      await q('DROP TABLE IF EXISTS e2e_daily_orders');
    };
    // 35 days up to yesterday (UTC): EU 10 orders a day and US 5, but yesterday EU only 1.
    const made = await q(`CREATE OR REPLACE TABLE e2e_daily_orders AS
      SELECT ((now() AT TIME ZONE 'UTC')::DATE - d::INTEGER) AS order_date, r.region, 20.0 AS amount
      FROM range(1, 36) t(d), (VALUES ('EU', 10), ('US', 5)) r(region, n), range(0, 10) k(i)
      WHERE i < CASE WHEN d = 1 AND r.region = 'EU' THEN 1 ELSE r.n END`);
    if (made.error) throw new Error(`table not created: ${made.message}`);
    const saved = await j('PUT', `/api/workspaces/${wsId}/semantic`, { yaml: 'semantic_models:\n  - name: e2e_daily_orders\n    table: e2e_daily_orders\n    default_time_dimension: order_date\n    dimensions:\n      - { name: order_date, type: time }\n      - { name: region, type: categorical }\n    measures:\n      - { name: e2e_amount, agg: sum, expr: amount }\n      - { name: e2e_count, agg: count }\nmetrics:\n  - { name: e2e_revenue, label: E2E revenue, type: simple, measure: e2e_amount }\n  - { name: e2e_orders, label: E2E orders, type: simple, measure: e2e_count }\n', force: true });
    if (!saved.metrics) throw new Error(`definitions not saved: ${JSON.stringify(saved).slice(0, 200)}`);
    await send('Page.navigate', { url: `${BASE}/#/transform/metrics?view=monitors` });
    await waitFor(`!!document.querySelector('[data-testid="insights-scan"]')`, 20000, 'monitors view');
    // 1. Check every metric now.
    await evaluate(`document.querySelector('[data-testid="insights-scan"]').click(); true`);
    await waitFor(`document.querySelectorAll('[data-testid="scan-results"] [data-testid="insight-card"]').length >= 2`, 20000, 'scan findings');
    report.details.scan = await evaluate(`[...document.querySelectorAll('[data-testid="scan-results"] [data-testid="insight-summary"]')].map(e => e.innerText)`);
    // 2. A monitor that explains changes by region.
    await evaluate(`document.querySelector('[data-testid="monitor-new"]').click(); true`);
    await waitFor(`!!document.querySelector('[data-testid="monitor-segment"] option[value="region"]')`, 10000, 'segment options');
    await setField('[data-testid="monitor-segment"]', 'region', 'change');
    await evaluate(`document.querySelector('[data-testid="monitor-save"]').click(); true`);
    await waitFor(`!!document.querySelector('[data-monitor="e2e_revenue by day"]') && !!document.querySelector('[data-testid="insights-feed"] [data-testid="insight-drivers"]')`, 30000, 'monitor and its insight');
    await sleep(400);
    report.details.monitor = await evaluate(`document.querySelector('[data-monitor="e2e_revenue by day"]').innerText.replace(/\\s+/g, ' ')`);
    report.details.drivers = await evaluate(`document.querySelector('[data-testid="insights-feed"] [data-testid="insight-drivers"]').innerText.replace(/\\s+/g, ' ')`);
    report.details.feed = await evaluate(`document.querySelectorAll('[data-testid="insights-feed"] [data-testid="insight-card"]').length`);
    { const shot = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(out.replace('.png', '_monitors.png'), Buffer.from(shot.result.data, 'base64')); }
    // 3. Home shows what changed.
    await send('Page.navigate', { url: `${BASE}/#/` });
    await waitFor(`!!document.querySelector('[data-testid="home-insights"] [data-testid="insight-card"]')`, 20000, 'home insights');
    report.details.home = await evaluate(`document.querySelector('[data-testid="home-insights"] [data-testid="insight-summary"]').innerText`);
    // 4. Dismissing takes it off the feed.
    await send('Page.navigate', { url: `${BASE}/#/transform/metrics?view=monitors` });
    await waitFor(`!!document.querySelector('[data-testid="insights-feed"] [data-testid="insight-dismiss"]')`, 20000, 'feed');
    const n = await evaluate(`document.querySelectorAll('[data-testid="insights-feed"] [data-testid="insight-card"]').length`);
    await evaluate(`document.querySelector('[data-testid="insights-feed"] [data-testid="insight-dismiss"]').click(); true`);
    await waitFor(`document.querySelectorAll('[data-testid="insights-feed"] [data-testid="insight-card"]').length === ${n - 1}`, 10000, 'dismissed');
    report.details.charts = 1;
  }
  else if (scenario === 'ai-metrics') {
    const http = await import('node:http');
    const j = async (method, url, body) => (await authed(url, { method, body: body ? JSON.stringify(body) : undefined })).json();
    const wsId = await evaluate(`localStorage.getItem('duckview.workspace')`);
    const q = (sql) => j('POST', `/api/workspaces/${wsId}/query`, { sql });
    const before = (await j('GET', `/api/workspaces/${wsId}/semantic`)).yaml ?? '';
    const chatAnswer = 'Revenue by region:\n\n```duckview-metric\ntitle: E2E revenue by region\nmetrics: [e2e_revenue]\ngroup_by: [region]\norder_by: [{ name: region }]\n```\n';
    const askAnswer = '{"title": "E2E orders by region", "explanation": "e2e_orders grouped by region", "metrics": ["e2e_orders"], "group_by": ["region"], "order_by": [{"name": "region"}]}';
    const llm = http.createServer((req, res) => {
      let b = '';
      req.on('data', (d) => (b += d));
      req.on('end', () => {
        if (!req.url.includes('chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"models":[],"data":[]}'); return; }
        const body = JSON.parse(b);
        const system = String((body.messages ?? []).find((m) => m.role === 'system')?.content ?? '');
        const answer = system.startsWith('You turn questions into metric queries') ? askAnswer : chatAnswer;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const piece of answer.match(/[\s\S]{1,40}/g)) res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', model: 'mock', choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', model: 'mock', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 20 } })}\n\n`);
        res.end('data: [DONE]\n\n');
      });
    });
    await new Promise((r) => llm.listen(0, '127.0.0.1', r));
    cleanup = async () => {
      llm.close();
      await evaluate(`localStorage.removeItem('duckview.copilot.settings'); true`).catch(() => undefined);
      await j('PUT', `/api/workspaces/${wsId}/semantic`, { yaml: before, force: true });
      await q('DROP TABLE IF EXISTS e2e_metric_orders');
    };
    await q(`CREATE OR REPLACE TABLE e2e_metric_orders AS SELECT * FROM (VALUES (1, 'EU', 100.0), (2, 'US', 50.0), (3, 'EU', 30.0)) t(id, region, amount)`);
    const saved = await j('PUT', `/api/workspaces/${wsId}/semantic`, { yaml: 'semantic_models:\n  - name: e2e_metric_orders\n    table: e2e_metric_orders\n    dimensions:\n      - { name: region, type: categorical }\n    measures:\n      - { name: e2e_amount, agg: sum, expr: amount }\n      - { name: e2e_count, agg: count }\nmetrics:\n  - { name: e2e_revenue, label: Revenue, type: simple, measure: e2e_amount }\n  - { name: e2e_orders, label: Orders, type: simple, measure: e2e_count }\n', force: true });
    if (!saved.metrics) throw new Error(`definitions not saved: ${JSON.stringify(saved).slice(0, 200)}`);
    await evaluate(`localStorage.setItem('duckview.copilot.settings', JSON.stringify({ provider: 'ollama', model: 'mock', apiKey: '', baseUrl: 'http://127.0.0.1:${llm.address().port}' })); true`);
    await send('Page.navigate', { url: `${BASE}/#/` });
    await send('Page.reload', {});
    await waitFor(`!!document.querySelector('[data-testid="ai-toggle"]')`, 20000, 'app reloaded');
    // 1. A question in the AI panel, answered from the metrics.
    await evaluate(`document.querySelector('[data-testid="ai-toggle"]').click(); true`);
    await waitFor(`!!document.querySelector('textarea[placeholder^="Ask about your data"]:not([disabled])')`, 15000, 'AI ready');
    await setField('textarea[placeholder^="Ask about your data"]', 'What is e2e revenue by region?');
    await evaluate(`document.querySelector('button[title="Send"]').click(); true`);
    await waitFor(`/from metrics/.test(document.querySelector('[data-testid="metric-card"]')?.innerText ?? '')`, 30000, 'metric card');
    await sleep(300);
    { const shot = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(out.replace('.png', '_card.png'), Buffer.from(shot.result.data, 'base64')); }
    report.details.card = await evaluate(`[...document.querySelectorAll('[data-testid="metric-card"] tbody tr')].map(r => r.innerText.replace(/\\s+/g, ' ').trim())`);
    // 2. Open it in the Metrics explorer.
    await evaluate(`document.querySelector('[data-testid="metric-open"]').click(); true`);
    await waitFor(`location.hash.startsWith('#/transform/metrics') && document.body.innerText.includes('130')`, 20000, 'explorer shows it');
    report.details.explorer = await evaluate(`document.body.innerText.includes('e2e_revenue') && document.body.innerText.includes('130') && document.body.innerText.includes('50')`);
    // 3. The explorer's question box.
    await evaluate(`document.querySelector('[data-testid="ai-toggle"]').click(); true`);
    await setField('[data-testid="metrics-ask"]', 'How many orders per region?');
    await evaluate(`document.querySelector('[data-testid="metrics-ask-go"]').click(); true`);
    await waitFor(`/E2E orders by region/.test(document.querySelector('[data-testid="metrics-answer"]')?.innerText ?? '')`, 20000, 'answer applied');
    await waitFor(`!!document.querySelector('label[data-metric="e2e_orders"] input')?.checked`, 10000, 'orders picked');
    await sleep(800);
    report.details.asked = await evaluate(`document.querySelector('[data-testid="metrics-result"]')?.innerText.split('\\n')[0] ?? ''`);
    { const shot = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(out.replace('.png', '_explorer.png'), Buffer.from(shot.result.data, 'base64')); }
    report.details.charts = 1;
  }
  else if (scenario === 'dbt-copilot') {
    const http = await import('node:http');
    const j = async (method, url, body) => (await authed(url, { method, body: body ? JSON.stringify(body) : undefined })).json();
    const wsId = await evaluate(`localStorage.getItem('duckview.workspace')`);
    const q = (sql) => j('POST', `/api/workspaces/${wsId}/query`, { sql });
    // A mock OpenAI-compatible LLM (BYOK "ollama") that answers with a dbt model and records the prompt it got.
    const prompts = [];
    const answer = "Here is a mart model:\n\n```sql\n-- dbt model: models/marts/revenue_bands.sql\nselect case when amount >= 200 then 'large' else 'small' end as band, count(*) as orders, sum(amount) as revenue\nfrom {{ ref('stg_numbers') }}\ngroup by 1\n```\n\nAdd it to the project and build it.";
    const llm = http.createServer((req, res) => {
      let b = '';
      req.on('data', (d) => (b += d));
      req.on('end', () => {
        if (!req.url.includes('chat/completions')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"models":[],"data":[]}'); return; }
        prompts.push(JSON.parse(b));
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const piece of answer.match(/[\s\S]{1,40}/g)) res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', model: 'mock', choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', model: 'mock', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 20 } })}\n\n`);
        res.end('data: [DONE]\n\n');
      });
    });
    await new Promise((r) => llm.listen(0, '127.0.0.1', r));
    let tabId = null;
    const cleanupDbt = async () => {
      llm.close();
      for (const p of (await j('GET', `/api/workspaces/${wsId}/dbt/projects`)).projects ?? []) if (p.name === 'E2E dbt copilot') await authed(`/api/dbt/projects/${p.id}`, { method: 'DELETE' });
      await q('DROP TABLE IF EXISTS big_regions; DROP VIEW IF EXISTS revenue_bands; DROP TABLE IF EXISTS region_totals; DROP VIEW IF EXISTS stg_numbers; DROP TABLE IF EXISTS regions');
      if (tabId) await authed(`/api/workspaces/${wsId}/tabs/${tabId}`, { method: 'DELETE' });
      await evaluate(`localStorage.removeItem('duckview.copilot.settings'); true`);
    };
    for (const p of (await j('GET', `/api/workspaces/${wsId}/dbt/projects`)).projects ?? []) if (p.name === 'E2E dbt copilot') await authed(`/api/dbt/projects/${p.id}`, { method: 'DELETE' });
    cleanup = cleanupDbt;
    const project = (await j('POST', `/api/workspaces/${wsId}/dbt/projects`, { name: 'E2E dbt copilot' })).project;
    report.details.starter = (await j('POST', `/api/dbt/projects/${project.id}/runs`, { command: 'build', wait: true })).run?.status;
    // 1. Query workbench → "dbt model": a SELECT becomes a model of the project and is built.
    tabId = (await j('POST', `/api/workspaces/${wsId}/tabs`, { title: 'E2E dbt tab', sql_content: 'SELECT region_name, revenue FROM region_totals WHERE revenue > 100' })).tab?.id;
    await send('Page.navigate', { url: `${BASE}/#/query` });
    await sleep(500);
    await send('Page.reload', {});
    await waitFor(`[...document.querySelectorAll('span.truncate')].some(s => s.textContent === 'E2E dbt tab')`, 20000, 'tab listed');
    await evaluate(`[...document.querySelectorAll('span.truncate')].find(s => s.textContent === 'E2E dbt tab').closest('div').click(); true`);
    await sleep(500);
    // Save as dbt model lives in the run toolbar's ⋯ menu.
    await evaluate(`document.querySelector('button[aria-label="More query actions"]').click(); true`);
    await waitFor(`[...document.querySelectorAll('[role=menuitem]')].some(b => b.textContent.includes('Save as dbt model'))`, 5000, 'query menu');
    await evaluate(`[...document.querySelectorAll('[role=menuitem]')].find(b => b.textContent.includes('Save as dbt model')).click(); true`);
    await waitFor(`!!document.querySelector('[data-testid="dbt-model-name"]')`, 5000, 'dbt model dialog');
    await waitFor(`[...(document.querySelector('[data-testid="dbt-model-project"]')?.options ?? [])].some(o => o.value === ${JSON.stringify(project.id)})`, 10000, 'projects loaded');
    await evaluate(`(() => { const sel = document.querySelector('[data-testid="dbt-model-project"]'); Object.getOwnPropertyDescriptor(Object.getPrototypeOf(sel), 'value').set.call(sel, ${JSON.stringify(project.id)}); sel.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await setField('[data-testid="dbt-model-name"]', 'big_regions');
    await clickButton('Save model');
    await waitFor(`location.hash.includes(${JSON.stringify(project.id)}) && !!document.querySelector('tr[data-node="big_regions"]') && document.querySelector('[data-testid="dbt-run"]').innerText.includes('ok')`, 300000, 'workbench model built');
    const files = (await j('GET', `/api/dbt/projects/${project.id}`)).project.files;
    report.details.workbenchModel = files['models/marts/big_regions.sql'] ?? null;
    // 2. Copilot writes a dbt model; "Add to dbt project" saves and builds it.
    await evaluate(`localStorage.setItem('duckview.copilot.settings', JSON.stringify({ provider: 'ollama', model: 'mock', apiKey: '', baseUrl: 'http://127.0.0.1:${llm.address().port}' })); true`);
    await send('Page.reload', {});
    await waitFor(`!!document.querySelector('[data-testid="ai-toggle"]')`, 20000, 'app reloaded');
    await evaluate(`document.querySelector('[data-testid="ai-toggle"]').click(); true`);
    await waitFor(`!!document.querySelector('textarea[placeholder^="Ask about your data"]:not([disabled])')`, 15000, 'copilot ready');
    await setField('textarea[placeholder^="Ask about your data"]', 'Write a dbt model that bands orders by amount');
    await evaluate(`document.querySelector('button[title="Send"]').click(); true`);
    await waitFor(`[...document.querySelectorAll('[data-testid="copilot-dbt-model"]')].some(b => b.textContent.includes('Add to dbt project'))`, 30000, 'dbt block in the answer');
    await evaluate(`[...document.querySelectorAll('[data-testid="copilot-dbt-model"]')].find(b => b.textContent.includes('Add to dbt project')).click(); true`);
    await waitFor(`document.querySelector('[data-testid="dbt-model-name"]')?.value === 'revenue_bands'`, 5000, 'name from the header');
    await waitFor(`[...(document.querySelector('[data-testid="dbt-model-project"]')?.options ?? [])].some(o => o.value === ${JSON.stringify(project.id)})`, 10000, 'projects loaded');
    await evaluate(`(() => { const sel = document.querySelector('[data-testid="dbt-model-project"]'); Object.getOwnPropertyDescriptor(Object.getPrototypeOf(sel), 'value').set.call(sel, ${JSON.stringify(project.id)}); sel.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await clickButton('Save model');
    await waitFor(`!!document.querySelector('tr[data-node="revenue_bands"]') && document.querySelector('[data-testid="dbt-run"]').innerText.includes('ok')`, 300000, 'copilot model built');
    report.details.copilotRows = ((await q('SELECT band, orders FROM revenue_bands ORDER BY band')).rows ?? []);
    const system = prompts[0]?.messages?.find((m) => m.role === 'system')?.content ?? '';
    report.details.prompt = { dbtContext: system.includes('### dbt projects of this workspace') && system.includes('E2E dbt copilot'), guide: system.includes('# dbt in DuckView') };
    report.details.charts = 1;
  }
  else if (scenario === 'dbt-project') {
    const j = async (method, url, body) => (await authed(url, { method, body: body ? JSON.stringify(body) : undefined })).json();
    const wsId = await evaluate(`localStorage.getItem('duckview.workspace')`);
    const q = (sql) => j('POST', `/api/workspaces/${wsId}/query`, { sql });
    const cleanupDbt = async () => {
      for (const p of (await j('GET', `/api/workspaces/${wsId}/dbt/projects`)).projects ?? []) if (p.name === 'E2E dbt') await authed(`/api/dbt/projects/${p.id}`, { method: 'DELETE' });
      await q('DROP TABLE IF EXISTS region_totals; DROP VIEW IF EXISTS stg_numbers; DROP TABLE IF EXISTS regions');
    };
    await cleanupDbt();
    cleanup = cleanupDbt;
    // 1. Transform → dbt; install dbt Core when the server does not have it yet.
    await send('Page.navigate', { url: `${BASE}/#/transform/dbt` });
    await waitFor(`[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'New project')`, 20000, 'dbt tab');
    await waitFor(`!!document.querySelector('[data-testid="dbt-version"]') || [...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Install now')`, 20000, 'dbt status');
    if (!(await evaluate(`!!document.querySelector('[data-testid="dbt-version"]')`))) {
      await clickButton('Install now');
      await waitFor(`!!document.querySelector('[data-testid="dbt-version"]')`, 900000, 'dbt installed');
    }
    report.details.version = await evaluate(`document.querySelector('[data-testid="dbt-version"]').textContent`);
    // 2. A project from the starter.
    await clickButton('New project');
    await setField('input[placeholder="Sales models"]', 'E2E dbt');
    await clickButton('Create');
    await waitFor(`document.querySelector('[data-testid="dbt-project-name"]')?.textContent === 'E2E dbt'`, 15000, 'project opened');
    // 3. Build it.
    await clickButton('Run');
    await waitFor(`!!document.querySelector('tr[data-node="region_totals"]') && document.querySelector('[data-testid="dbt-run"]').innerText.includes('ok')`, 300000, 'build finished');
    report.details.build = await evaluate(`[...document.querySelectorAll('tr[data-node]')].map(tr => tr.dataset.node + ':' + tr.children[2].innerText.trim())`);
    // 4. Edit a model in the editor (select all, type), save and run just that model.
    await evaluate(`[...document.querySelectorAll('button[data-file]')].find(b => b.dataset.file === 'models/marts/region_totals.sql').click(); true`);
    await waitFor(`document.querySelector('.cm-content')?.innerText.includes('region_name')`, 5000, 'model in the editor');
    await evaluate(`document.querySelector('.cm-content').focus(); true`);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: process.platform === 'darwin' ? 4 : 2, commands: ['selectAll'] });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: process.platform === 'darwin' ? 4 : 2 });
    await send('Input.insertText', { text: "select r.region_name, count(*) as orders, sum(n.amount) as revenue, round(avg(n.amount), 2) as avg_amount\nfrom {{ ref('stg_numbers') }} n\njoin {{ ref('regions') }} r using (region_code)\ngroup by 1\n" });
    await waitFor(`document.body.innerText.includes('unsaved')`, 5000, 'edited');
    await setField('input[placeholder^="--select"]', 'region_totals');
    await evaluate(`(() => { const sel = document.querySelector('[data-testid="dbt-command"]'); Object.getOwnPropertyDescriptor(Object.getPrototypeOf(sel), 'value').set.call(sel, 'run'); sel.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await clickButton('Save & run');
    await waitFor(`document.querySelector('[data-testid="dbt-run"]').innerText.includes('dbt run --select region_totals') && document.querySelector('[data-testid="dbt-run"]').innerText.includes('ok')`, 300000, 'model rebuilt');
    report.details.columns = ((await q("SELECT column_name FROM information_schema.columns WHERE table_name = 'region_totals' ORDER BY ordinal_position")).rows ?? []).map((r) => r[0]);
    // 5. Its compiled SQL is one click away.
    await evaluate(`document.querySelector('tr[data-node="region_totals"]').click(); true`);
    await waitFor(`[...document.querySelectorAll('[data-testid="dbt-run"] pre')].some(p => p.textContent.includes('avg_amount'))`, 5000, 'compiled SQL shown');
    report.details.compiledShown = true;
    // 6. The catalog carries the model's description.
    report.details.note = ((await j('GET', `/api/workspaces/${wsId}/catalog/annotated`)).objects ?? []).find((o) => o.name === 'region_totals')?.description ?? null;
    report.details.charts = 1;
  }
  else if (scenario === 'scim-provisioning') {
    const j = async (method, url, body) => (await authed(url, { method, body: body ? JSON.stringify(body) : undefined })).json();
    let scimToken = '';
    const scim = async (method, url, body) => {
      const r = await fetch(`${BASE}/scim/v2${url}`, { method, headers: { 'content-type': 'application/scim+json', authorization: `Bearer ${scimToken}` }, body: body ? JSON.stringify(body) : undefined });
      return r.status === 204 ? {} : r.json();
    };
    const cleanupScim = async () => {
      for (const u of (await j('GET', '/api/admin/users')).users ?? []) if (u.email === 'e2e-scim@example.com') await authed(`/api/admin/users/${u.id}`, { method: 'DELETE' });
      for (const g of (await j('GET', '/api/groups')).groups ?? []) if (g.external_id === 'e2e-grp-finance' || g.name === 'E2E Finance') await authed(`/api/groups/${g.id}`, { method: 'DELETE' });
      await authed('/api/admin/scim/token', { method: 'DELETE' });
    };
    await cleanupScim();
    cleanup = cleanupScim;
    // 1. Governance → Provisioning: generate the token.
    await send('Page.navigate', { url: `${BASE}/#/governance/provisioning` });
    await waitFor(`!!document.querySelector('[data-testid="scim-endpoint"]')`, 20000, 'provisioning tab');
    await clickButton('Generate token');
    await waitFor(`!!document.querySelector('[data-testid="scim-token"]')`, 10000, 'token shown');
    scimToken = await evaluate(`document.querySelector('[data-testid="scim-token"]').textContent`);
    report.details.endpoint = await evaluate(`document.querySelector('[data-testid="scim-endpoint"]').textContent`);
    // 2. Settings → Teams: a team linked to the IdP group, shared with the workspace before anyone exists.
    await send('Page.navigate', { url: `${BASE}/#/settings/teams` });
    await waitFor(`[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'New team')`, 20000, 'teams panel');
    await clickButton('New team');
    await waitFor(`!!document.querySelector('input[placeholder^="Optional — e.g."]')`, 5000, 'IdP field');
    await setField('input[placeholder="Analytics"]', 'E2E Finance');
    await setField('input[placeholder^="Optional — e.g."]', 'e2e-grp-finance');
    await clickButton('Create');
    await waitFor(`document.body.innerText.includes('Linked to the identity-provider group')`, 10000, 'linked team created');
    const team = ((await j('GET', '/api/groups')).groups ?? []).find((g) => g.name === 'E2E Finance');
    const wsList = await j('GET', '/api/workspaces');
    const wsId = (await evaluate(`localStorage.getItem('duckview.workspace')`)) ?? (wsList.workspaces ?? wsList)[0].id;
    await j('PUT', `/api/workspaces/${wsId}/members`, { subject_type: 'group', subject_id: team.id, role: 'VIEWER' });
    // 3. The IdP provisions a user and pushes the group: the pre-linked team is adopted.
    const user = await scim('POST', '/Users', { schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], userName: 'e2e-scim@example.com', name: { givenName: 'Scim', familyName: 'User' }, active: true });
    const group = await scim('POST', '/Groups', { schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'], displayName: 'E2E Finance', externalId: 'e2e-grp-finance', members: [{ value: user.id }] });
    report.details.scim = { user: user.userName, adopted: group.id === team?.id, members: (group.members ?? []).length };
    const shared = (await j('GET', `/api/workspaces/${wsId}/members`)).members ?? [];
    report.details.scim.grant = shared.some((m) => m.subject_id === team?.id);
    // 4. The provisioning tab lists the linked team with its member.
    await send('Page.navigate', { url: `${BASE}/#/governance/provisioning` });
    await waitFor(`!!document.querySelector('tr[data-team="E2E Finance"]')`, 20000, 'linked team listed');
    report.details.linkedRow = await evaluate(`document.querySelector('tr[data-team="E2E Finance"]').innerText.replace(/\\s+/g, ' ')`);
    report.details.tokenStatus = await evaluate(`document.querySelector('[data-testid="scim-token-status"]')?.textContent ?? ''`);
    // 5. Settings → Users: deactivate the provisioned user; the IdP sees active=false.
    await send('Page.navigate', { url: `${BASE}/#/settings/users` });
    await waitFor(`!!document.querySelector('tr[data-user="e2e-scim@example.com"]')`, 20000, 'user listed');
    await evaluate(`[...document.querySelector('tr[data-user="e2e-scim@example.com"]').querySelectorAll('button')].find(b => b.textContent.trim() === 'Deactivate').click(); true`);
    await waitFor(`document.querySelector('tr[data-user="e2e-scim@example.com"]').innerText.includes('Reactivate')`, 10000, 'deactivated');
    report.details.afterDeactivate = (await scim('GET', `/Users/${user.id}`)).active;
    report.details.charts = 1;
  }
  else if (scenario === 'audit-export') {
    const http = await import('node:http');
    const got = [];
    const receiver = http.createServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { got.push({ auth: req.headers.authorization, lines: b.split('\n').filter(Boolean).map((l) => JSON.parse(l)) }); res.end('{"text":"Success","code":0}'); }); });
    await new Promise((r) => receiver.listen(0, '127.0.0.1', r));
    cleanup = async () => {
      receiver.close();
      for (const s of (await (await authed('/api/admin/audit-sinks')).json()).sinks ?? []) if (s.name === 'E2E Splunk') await authed(`/api/admin/audit-sinks/${s.id}`, { method: 'DELETE' });
    };
    await send('Page.navigate', { url: `${BASE}/#/governance/audit` });
    await waitFor(`[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Add destination')`, 20000, 'audit tab');
    await clickButton('Add destination');
    await setField('input[placeholder="Splunk"]', 'E2E Splunk');
    await setField('input[placeholder="https://…"]', `http://127.0.0.1:${receiver.address().port}`);
    await setField('input[type="password"]', 'e2e-hec-token');
    await clickButton('Start streaming');
    await waitFor(`[...document.querySelectorAll('div.rounded-lg')].some(d => d.innerText.includes('E2E Splunk'))`, 15000, 'destination listed');
    await evaluate(`[...document.querySelectorAll('div.rounded-lg')].find(d => d.innerText.includes('E2E Splunk')).querySelector('button').click(); true`);
    const t0 = Date.now();
    while (!got.some((g) => g.lines.some((l) => l.event?.action === 'audit_sink.test')) && Date.now() - t0 < 15000) await sleep(300);
    const wsList = await (await authed('/api/workspaces')).json();
    const wsId = (wsList.workspaces ?? wsList)[0].id;
    await authed(`/api/workspaces/${wsId}/query`, { method: 'POST', body: JSON.stringify({ sql: "SELECT 'e2e-audit-marker' AS m" }) });
    const t1 = Date.now();
    while (!got.some((g) => g.lines.some((l) => l.event?.query_text?.includes('e2e-audit-marker'))) && Date.now() - t1 < 40000) await sleep(500);
    report.details.exportSeconds = Math.round((Date.now() - t1) / 1000);
    report.details.audit = { test: got.some((g) => g.lines.some((l) => l.event?.action === 'audit_sink.test')), streamed: got.some((g) => g.lines.some((l) => l.event?.query_text?.includes('e2e-audit-marker'))), auth: got[0]?.auth ?? null };
    await send('Page.reload');
    await waitFor(`[...document.querySelectorAll('div.rounded-lg')].find(d => d.innerText.includes('E2E Splunk'))?.innerText.includes('streaming')`, 20000, 'streaming badge');
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
  if (scenario === 'semantic-metrics') {
    if (!d.saved?.includes('total_amount') || !d.saved?.includes('sem_orders_count')) problems.push(`scaffold not saved: ${JSON.stringify(d.saved)}`);
    if (!/Total amount by order_date__month/.test(d.ui?.header ?? '') || !d.ui?.canvas) problems.push(`explorer result: ${JSON.stringify(d.ui)}`);
    if (JSON.stringify(d.api) !== JSON.stringify(d.expected)) problems.push(`metric != SQL: ${JSON.stringify(d.api)} vs ${JSON.stringify(d.expected)}`);
  }
  if (scenario === 'cluster') {
    if (d.single !== 'off') problems.push(`single node page: ${d.single}`);
    if (JSON.stringify(d.forwarded) !== JSON.stringify([['EU', 17.5], ['US', 7.5]])) problems.push(`forwarded query: ${JSON.stringify(d.forwarded)}`);
    const one = (d.nodes ?? []).find((n) => n[0] === 'e2e-node-1');
    if (!one || !one[1].includes(`workspace ${d.wsPrefix}`)) problems.push(`nodes: ${JSON.stringify(d.nodes)}`);
    if (!/2 of 2 nodes answering\. This page was served by e2e-node-2/.test(d.header ?? '')) problems.push(`header: ${d.header}`);
  }
  if (scenario === 'usage-cost') {
    if (!(d.apiQueries >= 3)) problems.push(`api queries: ${d.apiQueries}`);
    if (!/\d/.test(d.total ?? '')) problems.push(`total: ${d.total}`);
    if (!(d.workspaceRows >= 1)) problems.push('no workspace rows');
    if (!/E2E budget \d+ Organisation · notifies at 1, 100%/.test(d.budget ?? '')) problems.push(`budget: ${d.budget}`);
    if (d.csvHeader !== 'date,queries,compute_seconds,ai_tokens,compute_cost,ai_cost,storage_cost,total_cost') problems.push(`csv: ${d.csvHeader}`);
  }
  if (scenario === 'templates') {
    for (const n of ['E-commerce sales', 'SaaS subscriptions', 'Web analytics', 'Support tickets']) if (!(d.cards ?? []).includes(n)) problems.push(`missing card ${n}`);
    if ((d.drawer ?? []).length !== 2) problems.push(`drawer: ${JSON.stringify(d.drawer)}`);
    if (JSON.stringify(d.widgets) !== JSON.stringify(['Revenue (30 days)', 'Orders (30 days)', 'Average order value', 'Revenue by month', 'Revenue by region', 'Top customers', 'Refund rate'])) problems.push(`widgets: ${JSON.stringify(d.widgets)}`);
    if (JSON.stringify(d.installs) !== JSON.stringify([['E-commerce sales', 5, ['orders', 'customers']]])) problems.push(`installs: ${JSON.stringify(d.installs)}`);
  }
  if (scenario === 'ui-foundation') {
    if (d.menuFirst !== 'Rename' || d.menuSecond !== 'Schedule a snapshot…') problems.push(`menu keys: ${d.menuFirst} / ${d.menuSecond}`);
    if (d.focusBack !== 'More dashboard actions') problems.push(`focus after Escape: ${d.focusBack}`);
    if (!/^Delete dashboard "E2E confirm \d+"\?$/.test(d.dialog?.title ?? '') || d.dialog?.focused !== 'Cancel' || d.dialog?.ok !== 'Delete' || d.dialog?.role !== 'alertdialog') problems.push(`dialog: ${JSON.stringify(d.dialog)}`);
    if (!d.trapped) problems.push('focus left the dialog');
    if (d.afterCancel !== 200) problems.push(`cancel deleted it (${d.afterCancel})`);
    if (!/^Deleted E2E confirm \d+$/.test(d.toast ?? '') || d.afterDelete !== 404) problems.push(`delete: ${d.toast} ${d.afterDelete}`);
  }
  if (scenario === 'shell') {
    if (!/Dashboards \| .*E2E shell \d+/.test(d.crumb ?? '')) problems.push(`crumb: ${d.crumb}`);
    if (JSON.stringify(d.groups) !== JSON.stringify(['Your account', `Workspace ${d.groups?.[1]?.slice(10)}`, 'Administration']) || !String(d.groups?.[1]).startsWith('Workspace ')) problems.push(`groups: ${JSON.stringify(d.groups)}`);
    if (!(d.rail ?? []).includes('Agents') || (d.rail ?? []).includes('AI')) problems.push(`rail: ${JSON.stringify(d.rail)}`);
    if (d.narrowSettings?.nav !== 'none' || !d.narrowSettings?.picker) problems.push(`narrow settings: ${JSON.stringify(d.narrowSettings)}`);
    if (d.phoneRail !== 'none') problems.push(`rail on a phone: ${d.phoneRail}`);
    if ((d.drawer ?? []).length !== 8) problems.push(`drawer: ${JSON.stringify(d.drawer)}`);
  }
  if (scenario === 'sql-workspace') {
    if (d.errorPanel?.title !== 'The query failed' || !(d.errorPanel?.goto ?? []).includes('Go to line 2') || !(d.errorPanel?.goto ?? []).includes('Fix with AI')) problems.push(`error panel: ${JSON.stringify(d.errorPanel)}`);
    if (!/FROM nowhere_at_all/.test(d.selection ?? '')) problems.push(`go to line selected: ${JSON.stringify(d.selection)}`);
    if (d.saveFocus !== 'INPUT') problems.push(`save dialog focus: ${d.saveFocus}`);
    if ((d.shortcuts ?? []).length !== 6) problems.push(`shortcuts: ${JSON.stringify(d.shortcuts)}`);
  }
  if (scenario === 'data-explorer') {
    if (d.object !== 'e2e_explorer') problems.push(`page object: ${d.object}`);
    if (JSON.stringify(d.column?.stats?.slice(0, 2)) !== JSON.stringify(['Missing', 'Distinct values'])) problems.push(`column stats: ${JSON.stringify(d.column)}`);
    if (d.column?.values?.[0] !== 'south') problems.push(`most common value: ${JSON.stringify(d.column?.values)}`);
  }
  if (scenario === 'ai-context') {
    if (!String(d.chip ?? '').includes('E2E AI context')) problems.push(`chip: ${d.chip}`);
    if (!d.withPage?.onScreen || !d.withPage?.dashboard || !d.withPage?.widget) problems.push(`prompt with the page: ${JSON.stringify(d.withPage)}`);
    if (d.withoutPage !== false) problems.push('the removed page still went to the AI');
    if (!d.fromPalette) problems.push('⌘K did not ask the AI');
  }
  if (scenario === 'agent-approvals') {
    if (d.held !== 'approval_required') problems.push(`held: ${d.held}`);
    if (!/wants to change data in e2e_approval/.test(d.inbox ?? '')) problems.push(`inbox: ${d.inbox}`);
    if (!/wants to change data in e2e_approval/.test(d.card ?? '') || !/DELETE/.test(d.card ?? '')) problems.push(`card: ${d.card}`);
    if (d.rows !== 5) problems.push(`the held DELETE ran (${d.rows} rows)`);
  }
  if (scenario === 'visual-qa') {
    const bad = (d.pages ?? []).filter((l) => !/: 0 unnamed · 0 unlabeled · 0 low-contrast$/.test(l));
    if (bad.length) problems.push(`accessibility: ${bad.join('; ')}`);
  }
  if (scenario === 'orchestration') {
    if (d.airflow !== 'succeeded: 2 rows loaded') problems.push(`airflow: ${d.airflow}`);
    if (d.python !== 'failed: 1 row (expected none)') problems.push(`python: ${d.python}`);
    if (JSON.stringify(d.rows) !== JSON.stringify(['failed | API | query | SELECT * FROM e2e_orch_raw WHERE amount < 0 | 1 row (expected none)', 'succeeded | Airflow | sync | E2E orchestrated sync | 2 rows loaded'])) problems.push(`rows: ${JSON.stringify(d.rows)}`);
    if (!d.snippet) problems.push('the snippet does not use the sync id');
  }
  if (scenario === 'pgwire') {
    if (!/^\d+$/.test(String((d.fields ?? [])[1] ?? ''))) problems.push(`fields: ${JSON.stringify(d.fields)}`);
    if (!String(d.psql).startsWith('skipped') && JSON.stringify(d.psql) !== JSON.stringify(['EU=27.40', 'US=5.00'])) problems.push(`psql: ${JSON.stringify(d.psql)}`);
    if (JSON.stringify(d.driver) !== JSON.stringify([{ id: 1, amount: '19.90' }])) problems.push(`driver: ${JSON.stringify(d.driver)}`);
    if (!/^PostgreSQL 15\.0 \(DuckView/.test(d.version ?? '')) problems.push(`version: ${d.version}`);
  }
  if (scenario === 'lake-write') {
    if (!/3 rows written — created lake\/e2e_orders_\d+ \(version 0\)/.test(d.delta ?? '')) problems.push(`delta: ${d.delta}`);
    if (JSON.stringify(d.deltaRead) !== JSON.stringify([[3, 245.75]])) problems.push(`delta read: ${JSON.stringify(d.deltaRead)}`);
    if (!String(d.iceberg ?? '').startsWith('skipped')) {
      if (!/3 rows written — created e2e_\d+\.orders/.test(d.iceberg ?? '')) problems.push(`iceberg: ${d.iceberg}`);
      if (JSON.stringify(d.icebergRead) !== JSON.stringify([[3]])) problems.push(`iceberg read: ${JSON.stringify(d.icebergRead)}`);
    }
  }
  if (scenario === 'saas-sources') {
    if ((d.cards ?? []).length !== 8) problems.push(`cards: ${JSON.stringify(d.cards)}`);
    if (!d.jiraForm) problems.push('the Jira form is missing fields');
  }
  if (scenario === 'cdc' && !d.skipped) {
    if (!/4 columns, key id; wal_level logical/.test(d.tested ?? '')) problems.push(`tested: ${d.tested}`);
    if (JSON.stringify(d.mirror) !== JSON.stringify([[1, 'Acme', 'pro', 99], [2, 'Globex', 'team', 49.5]])) problems.push(`mirror: ${JSON.stringify(d.mirror)}`);
    if (JSON.stringify(d.history) !== JSON.stringify([['d', 1], ['r', 3], ['u', 1]])) problems.push(`history: ${JSON.stringify(d.history)}`);
    if (d.slotsLeft !== 0) problems.push(`replication slot not dropped (${d.slotsLeft})`);
  }
  if (scenario === 'streams') {
    if (d.push !== 202) problems.push(`push: ${d.push}`);
    if (d.wrongKey !== 401) problems.push(`wrong key: ${d.wrongKey}`);
    if (!/^3 rows/.test(d.http ?? '')) problems.push(`http: ${d.http}`);
    if (!String(d.kafka ?? '').startsWith('skipped')) {
      if (!/1 partition/.test(d.tested ?? '')) problems.push(`tested: ${d.tested}`);
      if (JSON.stringify(d.sums) !== JSON.stringify([['paid', 100], ['refunded', 150]])) problems.push(`sums: ${JSON.stringify(d.sums)}`);
    }
  }
  if (scenario === 'a2a') {
    if (d.card !== 'DuckView') problems.push(`card: ${d.card}`);
    if (!/E2E analyst .*\/a2a\/agents\//.test(d.published ?? '')) problems.push(`published: ${d.published}`);
    if (d.agentCard !== 'E2E analyst') problems.push(`agent card: ${d.agentCard}`);
    if (!d.skills) problems.push('remote skills not shown');
    if (!/Sunny, 24 °C — you asked: Weather in Lisbon\?/.test(d.answer ?? '')) problems.push(`answer: ${d.answer}`);
  }
  if (scenario === 'hosted-agents') {
    if ((d.templates ?? 0) < 7) problems.push(`marketplace: ${d.templates} templates`);
    if (JSON.stringify(d.steps) !== JSON.stringify(['execute_query'])) problems.push(`steps: ${JSON.stringify(d.steps)}`);
    if (!/^Ran a query on /.test(d.stepSentences?.[0] ?? '')) problems.push(`step in words: ${JSON.stringify(d.stepSentences)}`);
    if (!/There are 37 orders in e2e_agent_orders/.test(d.output ?? '')) problems.push(`output: ${d.output}`);
  }
  if (scenario === 'insights') {
    if (!(d.scan ?? []).some((t) => /^E2E revenue was 120 on .* — 60% below the usual 300/.test(t))) problems.push(`scan: ${JSON.stringify(d.scan)}`);
    if (!/per day · by region/.test(d.monitor ?? '') || !/Most of the drop came from region = EU/.test(d.monitor ?? '')) problems.push(`monitor: ${d.monitor}`);
    if (!/region = EU 200 → 20 100%/.test(d.drivers ?? '')) problems.push(`drivers: ${d.drivers}`);
    if (d.feed !== 2) problems.push(`feed: ${d.feed} cards (expected the total and EU)`);
    if (!/^E2E revenue was 120/.test(d.home ?? '')) problems.push(`home: ${d.home}`);
  }
  if (scenario === 'ai-metrics') {
    if (JSON.stringify(d.card) !== JSON.stringify(['EU 130', 'US 50'])) problems.push(`card: ${JSON.stringify(d.card)}`);
    if (!d.explorer) problems.push('the explorer did not show the query');
    if (!/Orders by region/i.test(d.asked ?? '')) problems.push(`asked: ${d.asked}`);
  }
  if (scenario === 'ai-build') {
    if (!d.guide) problems.push('the build guide was not in the prompt');
    if (!/3 of 4 work/.test(d.card ?? '') || !/Margin kpi .*margin/.test(d.card ?? '')) problems.push(`card: ${d.card}`);
    if (JSON.stringify([...(d.widgets ?? [])].sort()) !== JSON.stringify(['Orders', 'Revenue', 'Revenue by region'])) problems.push(`widgets: ${JSON.stringify(d.widgets)}`);
  }
  if (scenario === 'embeds') {
    if (!d.snippet) problems.push('no signing snippet');
    if (!/150/.test(d.preview ?? '') || /250|220/.test(d.preview ?? '')) problems.push(`preview: ${d.preview}`);
    if (d.shell !== false) problems.push('the embed page shows the DuckView shell');
    if (!/70/.test(d.globex ?? '') || /150/.test(d.globex ?? '')) problems.push(`second tenant: ${d.globex}`);
  }
  if (scenario === 'git-sync') {
    if (!(d.pending ?? []).some((x) => /^added e2e-dv\/notebooks\/e2e-git-notebook\.yml$/.test(x))) problems.push(`pending: ${JSON.stringify(d.pending)}`);
    if (d.log !== 'E2E export') problems.push(`log: ${d.log}`);
    if (!/title: E2E git notebook/.test(d.file ?? '') || !/SELECT 42 AS answer/.test(d.file ?? '')) problems.push(`file: ${d.file}`);
    if (!/Updated notebooks\/e2e-git-notebook\.yml/.test(d.pull ?? '')) problems.push(`pull: ${d.pull}`);
    if (d.after !== 'SELECT 43 AS answer') problems.push(`after pull: ${d.after}`);
  }
  if (scenario === 'version-history') {
    if (!(d.versions ?? []).includes('Signed off')) problems.push(`versions: ${JSON.stringify(d.versions)}`);
    if (JSON.stringify(d.diff) !== JSON.stringify(['- SELECT sum(amount) * 1.2 AS revenue FROM (VALUES (10), (20)) t(amount)', '+ SELECT sum(amount) AS revenue FROM (VALUES (10), (20)) t(amount)'])) problems.push(`diff: ${JSON.stringify(d.diff)}`);
    if (!/Restored version \d+/.test((d.after ?? [])[0] ?? '')) problems.push(`after: ${JSON.stringify(d.after)}`);
    if (!/SELECT sum\(amount\) AS revenue/.test(d.cell ?? '')) problems.push(`cell: ${d.cell}`);
  }
  if (scenario === 'comments') {
    if (!/^Is 42 right\? @e2e-colleague@example\.com can you check\?$/.test(d.draft ?? '')) problems.push(`mention not inserted: ${d.draft}`);
    if (!/@E2E Colleague/.test(d.rendered ?? '')) problems.push(`mention not rendered as a name: ${d.rendered}`);
    if (JSON.stringify(d.colleagueInbox) !== JSON.stringify(['mention:E2E comments:c1'])) problems.push(`colleague inbox: ${JSON.stringify(d.colleagueInbox)}`);
    if (!/E2E Colleague replied on E2E comments/.test(d.inboxRow ?? '')) problems.push(`inbox row: ${d.inboxRow}`);
    if (!/Yes — it is the answer\./.test(d.threadText ?? '')) problems.push(`thread: ${d.threadText}`);
    if (d.unreadAfter !== '0') problems.push(`still unread: ${d.unreadAfter}`);
  }
  if (scenario === 'notebooks') {
    if (JSON.stringify(d.cells) !== JSON.stringify(['df1:sql', 'df2:sql', 'param1:input', 'df3:sql']) && !(d.cells ?? []).join(',').endsWith('df1:sql,df2:sql,param1:input,df3:sql')) problems.push(`cells: ${JSON.stringify(d.cells)}`);
    if (!/```sql\n-- df3\nSELECT doubled \* \{\{ param1 \}\} AS scaled FROM df2\n```\n\n\| scaled \|\n\| --- \|\n\| 840 \|/.test(d.markdown ?? '')) problems.push(`markdown: ${d.markdown}`);
  }
  if (scenario === 'reverse-etl') {
    if (d.handedSql !== 'SELECT id, email, score FROM e2e_rev_scores' || d.handedName !== 'E2E scores') problems.push(`workbench hand-over: ${d.handedName} / ${d.handedSql}`);
    if (!/^25 rows sent/.test(d.first ?? '')) problems.push(`first run: ${d.first}`);
    if (!/Would send 0 of 25 rows/.test(d.plan ?? '')) problems.push(`plan: ${d.plan}`);
    const rows = (d.received ?? []).reduce((a, r) => a + r.n, 0);
    if (rows !== 26 || d.received?.some((r) => r.auth !== 'Bearer e2e-token')) problems.push(`received: ${JSON.stringify(d.received)}`);
    if (JSON.stringify(d.received?.at(-1)?.first) !== JSON.stringify({ id: 7, email: 'user7@example.com', score: 999 })) problems.push(`changed row: ${JSON.stringify(d.received?.at(-1))}`);
  }
  if (scenario === 'data-quality') {
    for (const want of ['row_count', 'not_null', 'unique', 'accepted_values', 'relationships']) if (!d.suggested?.includes(want)) problems.push(`no ${want} suggested: ${JSON.stringify(d.suggested)}`);
    if (!/passed\./.test(d.preview ?? '') || /failed/.test(d.preview ?? '')) problems.push(`suggestions did not pass on their own data: ${d.preview}`);
    if (!/^(\d+) of \1 passed\.$/.test(d.first ?? '')) problems.push(`first run: ${d.first}`);
    if (!/failed/.test(d.second ?? '')) problems.push(`second run: ${d.second}`);
    for (const want of ['customer_id is never null', 'order_id is unique', 'status in', 'customer_id exists in dq_customers.customer_id']) if (!d.failing?.some((f) => f.includes(want))) problems.push(`not failing: ${want} (${JSON.stringify(d.failing)})`);
    if (!/dq_orders/.test(d.openedSql ?? '')) problems.push(`failing rows not opened in SQL: ${d.openedSql}`);
    if (d.api?.status !== 'fail') problems.push(`api status: ${JSON.stringify(d.api)}`);
    if (!/Checks failing/.test(d.chip ?? '')) problems.push(`dataset header chip: ${d.chip}`);
  }
  if (scenario === 'dbt-copilot') {
    if (d.starter !== 'ok') problems.push(`starter build: ${d.starter}`);
    if (!/\{\{ ref\('region_totals'\) \}\}/.test(d.workbenchModel ?? '')) problems.push(`workbench model not saved with ref(): ${d.workbenchModel}`);
    if (JSON.stringify(d.copilotRows) !== JSON.stringify([['large', 15], ['small', 15]])) problems.push(`copilot model rows: ${JSON.stringify(d.copilotRows)}`);
    if (!d.prompt?.dbtContext || !d.prompt?.guide) problems.push(`copilot prompt lacks dbt context: ${JSON.stringify(d.prompt)}`);
  }
  if (scenario === 'dbt-project') {
    if (!/dbt Core \d/.test(d.version ?? '')) problems.push(`dbt not installed: ${d.version}`);
    for (const want of ['regions:success', 'stg_numbers:success', 'region_totals:success']) if (!d.build?.includes(want)) problems.push(`build missing ${want}: ${JSON.stringify(d.build)}`);
    if ((d.build ?? []).filter((b) => b.endsWith(':pass')).length !== 4) problems.push(`tests did not all pass: ${JSON.stringify(d.build)}`);
    if (!d.columns?.includes('avg_amount')) problems.push(`the edited model was not rebuilt: ${JSON.stringify(d.columns)}`);
    if (d.note !== 'Orders and revenue per region.') problems.push(`catalog note missing: ${d.note}`);
  }
  if (scenario === 'scim-provisioning') {
    if (!/\/scim\/v2$/.test(d.endpoint ?? '')) problems.push(`endpoint wrong: ${d.endpoint}`);
    if (!d.scim?.adopted || d.scim?.members !== 1 || !d.scim?.grant) problems.push(`the pre-linked team was not adopted: ${JSON.stringify(d.scim)}`);
    if (!/E2E Finance e2e-grp-finance 1/.test(d.linkedRow ?? '')) problems.push(`linked team row wrong: ${d.linkedRow}`);
    if (!/^dvscim_/.test(d.tokenStatus ?? '')) problems.push(`token status wrong: ${d.tokenStatus}`);
    if (d.afterDeactivate !== false) problems.push('deactivating in Settings did not reach SCIM');
  }
  if (scenario === 'audit-export') {
    if (!d.audit?.test || !d.audit?.streamed || d.audit?.auth !== 'Splunk e2e-hec-token') problems.push(`audit export: ${JSON.stringify(d.audit)}`);
  }
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
