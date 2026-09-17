#!/usr/bin/env node
/**
 * End-to-end smoke test against a running DuckView instance.
 *   node scripts/smoke.mjs http://localhost:4200 admin@example.com password
 * Exercises: probes, metrics, login, workspace, query (sandbox + SQL), tabs, overview, upload,
 * API token, HITL challenge, MCP Streamable HTTP initialize + tools/list + tools/call.
 */
const [base = 'http://localhost:4200', email = process.env.DUCKVIEW_ADMIN_EMAIL, password = process.env.DUCKVIEW_ADMIN_PASSWORD] = process.argv.slice(2);
if (!email || !password) {
  console.error('usage: smoke.mjs <base-url> <admin-email> <admin-password>');
  process.exit(2);
}
let failures = 0;
const ok = (name, cond, detail = '') => {
  console.log(`${cond ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// wait for readiness (up to 90s)
let ready = false;
for (let i = 0; i < 90 && !ready; i++) {
  try {
    const r = await fetch(`${base}/readyz`);
    ready = r.status === 200;
  } catch {
    /* not up yet */
  }
  if (!ready) await sleep(1000);
}
ok('readyz', ready);
if (!ready) process.exit(1);

ok('healthz', (await fetch(`${base}/healthz`)).status === 200);
const metrics = await (await fetch(`${base}/metrics`)).text();
ok('metrics exposes duckview_* series', metrics.includes('duckview_queries_total'));

const json = async (method, path, body, token) => {
  const res = await fetch(base + path, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* empty */
  }
  return { status: res.status, data };
};

const login = await json('POST', '/api/auth/login', { email, password });
ok('login', login.status === 200, login.data.message);
const jwt = login.data.token;
ok('unauthenticated request rejected', (await json('GET', '/api/workspaces')).status === 401);

const wsList = await json('GET', '/api/workspaces', undefined, jwt);
const ws = wsList.data.workspaces?.[0];
ok('default workspace exists', !!ws, ws?.name);

const q = await json('POST', `/api/workspaces/${ws.id}/query`, { sql: "SELECT 21 * 2 AS answer, 'ok' AS s" }, jwt);
ok('query executes', q.status === 200 && q.data.rows?.[0]?.[0] === 42, JSON.stringify(q.data.rows));
const fmode = (await json('GET', `/api/workspaces/${ws.id}/folders`, undefined, jwt)).data.mode;
const outside = await json('POST', `/api/workspaces/${ws.id}/query`, { sql: "SELECT length(content) > 0 AS readable FROM read_text('/etc/hosts')" }, jwt);
if (fmode === 'sandboxed') ok('sandboxed mode blocks files outside the data directory', outside.status === 403, outside.data.error);
else ok('full mode reads files anywhere on the host', outside.status === 200, outside.data.message);
ok('traversal outside the explorer root is still rejected', (await json('GET', `/api/storage/local?workspace_id=${ws.id}&path=../..`, undefined, jwt)).status === 403 || fmode === 'full');
const bad = await json('POST', `/api/workspaces/${ws.id}/query`, { sql: 'SELECT * FROM nope' }, jwt);
ok('SQL error surfaces as 400 SQL_ERROR', bad.status === 400 && bad.data.error === 'SQL_ERROR');

const tab = await json('POST', `/api/workspaces/${ws.id}/tabs`, { title: 'smoke', sql_content: 'SELECT 1' }, jwt);
ok('tab created', tab.status === 200);
const upd = await json('PATCH', `/api/workspaces/${ws.id}/tabs/${tab.data.tab?.id}`, { sql_content: 'SELECT 2', cursor_position: 3 }, jwt);
ok('tab state + cursor persisted', upd.data.tab?.cursor_position === 3);

const form = new FormData();
form.append('file', new Blob(['id,name\n1,a\n2,b\n3,c\n'], { type: 'text/csv' }), 'smoke.csv');
const up = await fetch(`${base}/api/workspaces/${ws.id}/files`, { method: 'POST', headers: { authorization: `Bearer ${jwt}` }, body: form });
ok('file upload into jail', up.status === 200);
const ov = await json('POST', `/api/workspaces/${ws.id}/overview`, { target: 'smoke.csv' }, jwt);
ok('overview profile', ov.status === 200 && ov.data.row_count === 3, `rows=${ov.data.row_count}`);
const live = await json('GET', '/api/system/live', undefined, jwt);
ok('live hardware stats', live.status === 200 && live.data.host?.memory_total_bytes > 0);

// Phase 2: explorer, schema inspection, streaming export, saved queries + dashboards
const tree = await json('GET', `/api/storage/local?workspace_id=${ws.id}`, undefined, jwt);
ok('local explorer lists the data directory', tree.status === 200 && Array.isArray(tree.data.entries) && tree.data.entries.some((e) => e.name === 'smoke.csv'));
const insp = await json('POST', '/api/storage/inspect', { workspace_id: ws.id, target: 'smoke.csv' }, jwt);
ok('schema inspector (DESCRIBE LIMIT 0)', insp.status === 200 && insp.data.columns?.length === 2 && String(insp.data.suggested_sql).includes('smoke.csv'));
const exp = await json('POST', `/api/workspaces/${ws.id}/export`, { sql: "SELECT * FROM 'smoke.csv'", format: 'parquet', filename: 'smoke' }, jwt);
ok('server-side parquet export', exp.status === 200 && exp.data.export?.rows === 3, JSON.stringify(exp.data.message ?? ''));
if (exp.data.export) {
  const dl = await fetch(`${base}${exp.data.export.download_url}`, { headers: { authorization: `Bearer ${jwt}` } });
  ok('export streams with content-length', dl.status === 200 && Number(dl.headers.get('content-length')) === exp.data.export.size_bytes);
}
const arrow = await json('POST', `/api/workspaces/${ws.id}/export`, { sql: "SELECT * FROM 'smoke.csv'", format: 'arrow' }, jwt);
ok('arrow IPC export', arrow.status === 200 && arrow.data.export?.rows === 3);
const sq = await json('POST', `/api/workspaces/${ws.id}/queries`, { name: 'Smoke', folder: 'ci', sql_text: "SELECT count(*) AS n FROM 'smoke.csv'", tags: ['ci'] }, jwt);
ok('saved query created', sq.status === 200);
const dash = await json('POST', `/api/workspaces/${ws.id}/dashboards`, { name: 'Smoke board' }, jwt);
const widget = dash.data.dashboard ? await json('POST', `/api/dashboards/${dash.data.dashboard.id}/widgets`, { title: 'Rows', widget_type: 'KPI', saved_query_id: sq.data.query?.id, chart_config: { value: 'n' } }, jwt) : { status: 0, data: {} };
ok('dashboard + KPI widget', dash.status === 200 && widget.status === 200 && widget.data.layout?.length === 1);
const wdata = widget.data.widget ? await json('POST', `/api/dashboards/${dash.data.dashboard.id}/widgets/${widget.data.widget.id}/data`, {}, jwt) : { status: 0, data: {} };
ok('widget data executes', wdata.status === 200 && wdata.data.rows?.[0]?.[0] === 3);
const cc = await json('GET', '/api/cloud-connections/providers', undefined, jwt);
ok('cloud provider catalogue', cc.status === 200 && Object.keys(cc.data.providers ?? {}).length === 4);
const lp = await json('GET', '/api/lakehouse/providers', undefined, jwt);
ok('lakehouse provider catalogue', lp.status === 200 && Object.keys(lp.data.providers ?? {}).sort().join() === 'AWS_GLUE,AWS_S3_TABLES,DATABRICKS,ICEBERG_REST');
const lhBad = await json('POST', '/api/lakehouse-connections', { name: 'x', provider: 'AWS_GLUE', config: { region: 'us-east-1', account_id: 'nope' }, credentials: { access_key_id: 'a', secret_access_key: 'b' } }, jwt);
ok('lakehouse config validation', lhBad.status === 400);
const fw = await json('GET', '/api/agents/frameworks', undefined, jwt);
ok('agent framework catalogue', fw.status === 200 && Object.keys(fw.data.frameworks ?? {}).length === 8);
const oapi = await json('GET', '/api/agent/openapi.json', undefined, jwt);
ok('OpenAPI document for agent tools', oapi.status === 200 && oapi.data.openapi === '3.0.3' && Object.keys(oapi.data.paths ?? {}).length === 11);
const reg = await json('POST', '/api/agents', { name: 'smoke-strands', framework: 'strands', workspace_id: ws.id }, jwt);
ok('agent registered with token', reg.status === 200 && String(reg.data.token).startsWith('dv_'));
const restTools = await json('GET', '/api/agent/v1/tools', undefined, reg.data.token);
ok('REST tool façade lists tools for the agent token', restTools.status === 200 && restTools.data.tools?.length === 10);
const restCall = await json('POST', '/api/agent/v1/tools/execute_query', { sql: 'SELECT 42 AS answer' }, reg.data.token);
ok('REST tool façade executes SQL', restCall.status === 200 && restCall.data.structured?.rows?.[0]?.[0] === 42, JSON.stringify(restCall.data).slice(0, 200));
const selfTest = await json('POST', `/api/agents/${reg.data.agent?.id}/test`, {}, jwt);
ok('agent self-test', selfTest.status === 200 && selfTest.data.ok === true);
await json('DELETE', `/api/agents/${reg.data.agent?.id}`, undefined, jwt);

const tok = await json('POST', '/api/tokens', { name: 'smoke-agent', scopes: ['read', 'write', 'mcp'], workspace_id: ws.id }, jwt);
ok('API token minted', tok.status === 200 && String(tok.data.token).startsWith('dv_'));
const agentToken = tok.data.token;
const hitl = await json('POST', `/api/workspaces/${ws.id}/query`, { sql: 'CREATE TABLE smoke_t AS SELECT 1 AS a' }, agentToken);
ok('agent mutation blocked with approval challenge', hitl.status === 409 && hitl.data.challenge?.status === 'approval_required');
const approved = await json('POST', `/api/workspaces/${ws.id}/query`, { sql: 'CREATE TABLE smoke_t AS SELECT 1 AS a', dry_run: false }, agentToken);
ok('agent mutation runs with dry_run=false', approved.status === 200);

// MCP Streamable HTTP
const mcp = async (body, sessionId) => {
  const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${agentToken}`, ...(sessionId ? { 'mcp-session-id': sessionId } : {}) }, body: JSON.stringify(body) });
  const text = await res.text();
  const data = text.startsWith('event:') || text.includes('\ndata:') ? JSON.parse(text.split('\n').find((l) => l.startsWith('data:')).slice(5)) : text ? JSON.parse(text) : null;
  return { status: res.status, sessionId: res.headers.get('mcp-session-id'), data };
};
const unauth = await fetch(`${base}/mcp`, { method: 'POST' });
ok('MCP rejects missing bearer', unauth.status === 401);
const init = await mcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } } });
ok('MCP initialize', init.status === 200 && init.data?.result?.serverInfo?.name === 'duckview', init.data?.error?.message);
await mcp({ jsonrpc: '2.0', method: 'notifications/initialized' }, init.sessionId);
const tools = await mcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, init.sessionId);
ok('MCP tools/list has 10 tools', tools.data?.result?.tools?.length === 10);
const cop = await json('GET', '/api/copilot/config', undefined, jwt);
ok('copilot config endpoint', cop.status === 200 && typeof cop.data.allow_byok === 'boolean');
const call = await mcp({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'execute_query', arguments: { sql: 'SELECT count(*) AS n FROM smoke_t' } } }, init.sessionId);
ok('MCP execute_query', call.data?.result?.structuredContent?.rows?.[0]?.[0] === 1, JSON.stringify(call.data?.result?.structuredContent?.rows));
const res = await mcp({ jsonrpc: '2.0', id: 4, method: 'resources/read', params: { uri: 'duckdb://system/resources' } }, init.sessionId);
ok('MCP system resource', !!res.data?.result?.contents?.[0]?.text);
await fetch(`${base}/mcp`, { method: 'DELETE', headers: { authorization: `Bearer ${agentToken}`, 'mcp-session-id': init.sessionId } });

// cleanup
if (dash.data.dashboard) await json('DELETE', `/api/dashboards/${dash.data.dashboard.id}`, undefined, jwt);
if (sq.data.query) await json('DELETE', `/api/workspaces/${ws.id}/queries/${sq.data.query.id}`, undefined, jwt);
await json('POST', `/api/workspaces/${ws.id}/query`, { sql: 'DROP TABLE smoke_t' }, jwt);
await json('DELETE', `/api/workspaces/${ws.id}/files?path=smoke.csv`, undefined, jwt);
await json('DELETE', `/api/tokens/${tok.data.record?.id}`, undefined, jwt);
await json('DELETE', `/api/workspaces/${ws.id}/tabs/${tab.data.tab?.id}`, undefined, jwt);

console.log(failures === 0 ? '\nALL SMOKE CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
