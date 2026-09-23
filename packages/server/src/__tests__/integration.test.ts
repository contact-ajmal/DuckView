import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { loadConfig } from '../config/index.js';
import { initLogger } from '../observability/logger.js';
import { createContext, type AppContext } from '../context.js';
import { buildMcpServer } from '../mcp/server.js';
import { buildApp } from '../app.js';
import { QueryTimeoutError } from '../engine/duckdb.js';
import { SandboxViolation } from '../engine/sandbox.js';
import { HitlBlocked } from '../services/query.js';
import type { Principal } from '../services/principal.js';

let dir: string;
let ctx: AppContext;
let admin: Principal;

beforeAll(async () => {
  initLogger({ level: 'silent', stderr: true, pretty: false });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dv-int-'));
  const cfg = loadConfig({
    configPath: null,
    env: {
      DUCKVIEW_DATA_DIR: path.join(dir, 'data'), DUCKVIEW_FILESYSTEM_MODE: 'sandboxed',
      DUCKDB_TEMP_DIRECTORY: path.join(dir, 'spill'),
      DATABASE_URL: ':memory:',
      DUCKDB_QUERY_TIMEOUT_SECONDS: '2',
      DUCKDB_MAX_RESULT_ROWS: '100',
      DUCKDB_MEMORY_LIMIT: '1GB',
      DUCKVIEW_ADMIN_EMAIL: 'admin@test.local',
      DUCKVIEW_ADMIN_PASSWORD: 'super-secret-pw',
      LOG_LEVEL: 'silent',
    },
  });
  ctx = await createContext(cfg);
  const user = await ctx.auth.findByEmail('admin@test.local');
  admin = ctx.auth.principalFromUser(user!, 'jwt', '127.0.0.1');
  // seed a parquet file inside the jail via the engine itself
  const ws = await ctx.workspaces.ensureDefault(admin);
  await ctx.queries.run(admin, ws.id, "COPY (SELECT range AS id, 'r' || range AS name, range * 1.5 AS amount FROM range(1000)) TO 'seed.parquet' (FORMAT PARQUET)");
});

afterAll(async () => {
  await ctx.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('engine + query service', () => {
  it('reads relative files via path rewriting and caps rows', async () => {
    const ws = await ctx.workspaces.ensureDefault(admin);
    const r = await ctx.queries.run(admin, ws.id, "SELECT * FROM 'seed.parquet' ORDER BY id", { maxRows: 10, countTotal: true });
    expect(r.rowCount).toBe(10);
    expect(r.totalRows).toBe(1000);
    expect(r.truncated).toBe(true);
    expect(r.columns.map((c) => c.name)).toEqual(['id', 'name', 'amount']);
    expect(r.columns[2]!.kind).toBe('number');
    expect(r.rows[0]).toEqual([0, 'r0', 0]);
  });
  it('paginates', async () => {
    const ws = await ctx.workspaces.ensureDefault(admin);
    const r = await ctx.queries.run(admin, ws.id, "SELECT id FROM 'seed.parquet' ORDER BY id", { maxRows: 10, page: 3 });
    expect(r.rows[0]).toEqual([20]);
  });
  it('blocks reads outside the jail at both layers', async () => {
    const ws = await ctx.workspaces.ensureDefault(admin);
    await expect(ctx.queries.run(admin, ws.id, "SELECT * FROM read_csv('/etc/hosts')")).rejects.toBeInstanceOf(SandboxViolation);
    await expect(ctx.queries.run(admin, ws.id, "SELECT * FROM read_csv('../../../../etc/hosts')")).rejects.toBeInstanceOf(SandboxViolation);
    // A literal that dodges the Node heuristic still hits DuckDB's allowed_directories.
    await expect(ctx.queries.run(admin, ws.id, "SELECT * FROM read_csv(concat(chr(47), 'etc', chr(47), 'hosts'))")).rejects.toThrow(/Permission Error|file system operations are disabled/i);
  });
  it('rejects hardened settings even though the config is locked', async () => {
    const ws = await ctx.workspaces.ensureDefault(admin);
    await expect(ctx.queries.run(admin, ws.id, 'SET enable_external_access = true')).rejects.toBeInstanceOf(SandboxViolation);
    await expect(ctx.queries.run(admin, ws.id, "SET TimeZone='UTC'")).rejects.toThrow(/locked/);
  });
  it('runs multi-statement scripts and returns the last result', async () => {
    const ws = await ctx.workspaces.ensureDefault(admin);
    const r = await ctx.queries.run(admin, ws.id, "CREATE TABLE t1 AS SELECT * FROM 'seed.parquet'; SELECT count(*) AS n FROM t1");
    expect(r.rows[0]).toEqual([1000]);
    expect(r.statementCount).toBe(2);
  });
  it('interrupts on timeout', async () => {
    const ws = await ctx.workspaces.ensureDefault(admin);
    await expect(ctx.queries.run(admin, ws.id, 'SELECT count(*) FROM range(4000000000) a, range(1000) b')).rejects.toBeInstanceOf(QueryTimeoutError);
  }, 15_000);
  it('explains, profiles, catalogs', async () => {
    const ws = await ctx.workspaces.ensureDefault(admin);
    const plan = await ctx.queries.explain(admin, ws.id, "SELECT name, sum(amount) FROM 'seed.parquet' GROUP BY 1");
    expect(plan.format).toBe('json');
    expect(plan.text).toContain('HASH_GROUP_BY');
    const prof = await ctx.queries.profile(admin, ws.id, 'seed.parquet');
    expect(prof.rowCount).toBe(1000);
    expect(prof.summary.find((s) => s.column_name === 'id')?.max).toBe('999');
    expect(prof.sizeBytes).toBeGreaterThan(0);
    const cat = await ctx.queries.catalog(admin, ws.id);
    expect(cat.files.map((f) => f.path)).toContain('seed.parquet');
    expect(cat.objects.find((o) => o.name === 't1')?.columns.length).toBe(3);
  });
  it('enforces read-only role and HITL for agents', async () => {
    const ws = await ctx.workspaces.ensureDefault(admin);
    const ro = await ctx.auth.createLocalUser({ email: 'ro@test.local', password: 'readonly-pass', role: 'READ_ONLY' });
    const roP = ctx.auth.principalFromUser(ro, 'jwt');
    // Not a member: the workspace does not exist as far as they are concerned, whatever the statement.
    await expect(ctx.queries.run(roP, ws.id, 'DROP TABLE t1')).rejects.toThrow(/not found/);
    await expect(ctx.queries.run(roP, ws.id, 'SELECT 1')).rejects.toThrow(/not found/);
    // Shared with them (even as EDITOR): the READ_ONLY platform role still forbids mutations.
    await ctx.workspaces.setMember(admin, ws.id, { subject_type: 'user', subject_id: ro.id, role: 'EDITOR' });
    await expect(ctx.queries.run(roP, ws.id, 'DROP TABLE t1')).rejects.toThrow(/read-only/i);
    expect((await ctx.queries.run(roP, ws.id, 'SELECT 1')).rows).toEqual([[1]]);
    const agent: Principal = { ...admin, via: 'token', actorType: 'AGENT', scopes: ['read', 'write', 'mcp'] };
    await expect(ctx.queries.run(agent, ws.id, 'DELETE FROM t1 WHERE id < 10')).rejects.toBeInstanceOf(HitlBlocked);
    const ok = await ctx.queries.run(agent, ws.id, 'DELETE FROM t1 WHERE id < 10', { dryRun: false });
    expect(ok.rowsChanged).toBe(10);
    await expect(ctx.queries.run(agent, ws.id, "SET TimeZone='UTC'", { dryRun: false })).rejects.toThrow(/admin-scoped/);
  });
  it('save_dataset writes inside exports/', async () => {
    const ws = await ctx.workspaces.ensureDefault(admin);
    const out = await ctx.queries.saveDataset(admin, ws.id, { sql: "SELECT * FROM 'seed.parquet' WHERE id < 5", format: 'csv', target: 'tiny', dryRun: false });
    expect(out.path).toBe('exports/tiny.csv');
    expect(fs.existsSync(path.join(ctx.engines.jail.root, 'exports', 'tiny.csv'))).toBe(true);
    await expect(ctx.queries.saveDataset(admin, ws.id, { sql: 'SELECT 1', format: 'csv', target: '../x.csv', dryRun: false })).rejects.toBeInstanceOf(SandboxViolation);
  });
  it('encrypts connection credentials at rest', async () => {
    const c = await ctx.connections.create(admin.userId, { name: 'my s3', type: 'S3', credentials: { access_key_id: 'AKIA', secret_access_key: 'shh', region: 'eu-west-1' } });
    expect(c.fields.sort()).toEqual(['access_key_id', 'region', 'secret_access_key']);
    const row = (await ctx.store.db.select().from(ctx.store.schema.dataConnections))[0]!;
    expect(row.encrypted_credentials).not.toContain('shh');
    const secrets = await ctx.connections.resolveSecrets(admin.userId, [c.id]);
    expect(secrets[0]!.values.secret_access_key).toBe('shh');
    expect(await ctx.connections.resolveSecrets('someone-else', [c.id])).toEqual([]);
  });
});

describe('MCP server (in-memory transport)', () => {
  let client: Client;
  let wsId: string;
  beforeAll(async () => {
    const ws = await ctx.workspaces.ensureDefault(admin);
    wsId = ws.id;
    const agent: Principal = { ...admin, via: 'token', actorType: 'AGENT', scopes: ['read', 'write', 'mcp'] };
    const server = buildMcpServer(ctx, agent, { defaultWorkspaceId: wsId });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    client = new Client({ name: 'test', version: '0' });
    await client.connect(ct);
  });
  it('lists tools, resources, prompts', async () => {
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(['browse_connector', 'browse_storage', 'connector_query', 'create_alert', 'create_app', 'create_dashboard_widget', 'create_data_sync', 'create_dbt_model', 'create_dbt_project', 'create_mosaic_dashboard', 'create_quality_suite', 'create_reverse_sync', 'execute_query', 'explain_query', 'get_app_logs', 'get_dbt_project', 'get_dbt_run', 'inspect_schema', 'lakehouse_query', 'list_accessible_data', 'list_alerts', 'list_apps', 'list_dashboards', 'list_data_sources', 'list_dbt_projects', 'list_metrics', 'list_quality_suites', 'list_reverse_syncs', 'preview_app', 'profile_dataset', 'publish_app', 'query_metrics', 'run_alert', 'run_app', 'run_data_sync', 'run_dbt', 'run_quality_suite', 'run_reverse_sync', 'save_dataset', 'snapshot_dashboard', 'stop_app', 'suggest_quality_checks', 'update_app', 'update_data_sync', 'write_dbt_files']);
    const res = (await client.listResources()).resources.map((r) => r.uri);
    expect(res).toContain('duckdb://workspaces');
    expect(res).toContain('duckdb://system/resources');
    expect((await client.listResourceTemplates()).resourceTemplates[0]!.uriTemplate).toBe('duckdb://schemas/{workspace_id}');
    expect((await client.listPrompts()).prompts.map((p) => p.name).sort()).toEqual(['build_data_app', 'build_data_pipeline', 'build_dbt_models', 'build_mosaic_dashboard', 'data_quality_audit', 'sql_optimization']);
  });
  it('execute_query returns markdown + structured content with limits', async () => {
    const r = await client.callTool({ name: 'execute_query', arguments: { sql: "SELECT * FROM 'seed.parquet' ORDER BY id", page_size: 5 } });
    const sc = r.structuredContent as { row_count: number; total_rows: number; truncated: boolean; columns: { name: string }[] };
    expect(sc.row_count).toBe(5);
    expect(sc.total_rows).toBe(1000);
    expect(sc.truncated).toBe(true);
    const text = (r.content as { text: string }[])[0]!.text;
    expect(text).toContain('| id | name | amount |');
    expect(text).toContain('Showing 5 of 1000');
    const big = await client.callTool({ name: 'execute_query', arguments: { sql: "SELECT repeat('x', 5000) AS s" } });
    expect(((big.structuredContent as { rows: string[][] }).rows[0]![0] as string).length).toBeLessThanOrEqual(401);
  });
  it('blocks mutating SQL with an approval challenge until dry_run=false', async () => {
    const r = await client.callTool({ name: 'execute_query', arguments: { sql: 'DROP TABLE t1' } });
    const sc = r.structuredContent as { status: string; mutating_verbs: string[] };
    expect(sc.status).toBe('approval_required');
    expect(sc.mutating_verbs).toEqual(['DROP']);
    const ok = await client.callTool({ name: 'execute_query', arguments: { sql: 'CREATE TABLE t2 AS SELECT 1 AS a', dry_run: false } });
    expect((ok.structuredContent as { status: string }).status).toBe('ok');
  });
  it('sandbox errors come back as tool errors, not transport failures', async () => {
    const r = await client.callTool({ name: 'execute_query', arguments: { sql: "SELECT * FROM '/etc/passwd'" } });
    expect(r.isError).toBe(true);
    expect((r.structuredContent as { code: string }).code).toBe('SANDBOX_VIOLATION');
  });
  it('profile_dataset, explain_query, list_accessible_data, resources', async () => {
    const p = await client.callTool({ name: 'profile_dataset', arguments: { table_or_path: 'seed.parquet' } });
    expect((p.structuredContent as { row_count: number }).row_count).toBe(1000);
    const e = await client.callTool({ name: 'explain_query', arguments: { sql: "SELECT count(*) FROM 'seed.parquet'" } });
    expect((e.structuredContent as { operators: string[] }).operators.join(' ')).toMatch(/AGGREGATE|SCAN/);
    const l = await client.callTool({ name: 'list_accessible_data', arguments: {} });
    expect((l.structuredContent as { files: { path: string }[] }).files.map((f) => f.path)).toContain('seed.parquet');
    const schema = await client.readResource({ uri: `duckdb://schemas/${wsId}` });
    expect(schema.contents[0]!.text).toContain('t2');
    const sys = await client.readResource({ uri: 'duckdb://system/resources' });
    const j = JSON.parse(sys.contents[0]!.text as string);
    expect(j.host.cpus).toBeGreaterThan(0);
    expect(j.duckdb.memory_limit_bytes).toBe(1e9);
    const prompt = await client.getPrompt({ name: 'sql_optimization', arguments: { sql: 'SELECT 1' } });
    expect(prompt.messages[0]!.content).toMatchObject({ type: 'text' });
  });
  it('save_dataset requires approval, then writes', async () => {
    const r = await client.callTool({ name: 'save_dataset', arguments: { sql: 'SELECT 1 AS a', output_format: 'parquet', target_filename: 'one' } });
    expect((r.structuredContent as { status: string }).status).toBe('approval_required');
    const ok = await client.callTool({ name: 'save_dataset', arguments: { sql: 'SELECT 1 AS a', output_format: 'parquet', target_filename: 'one', dry_run: false } });
    expect((ok.structuredContent as { path: string }).path).toBe('exports/one.parquet');
  });
});

describe('HTTP API + network MCP', () => {
  let app: Awaited<ReturnType<typeof buildApp>>['app'];
  let base: string;
  let jwt: string;
  let apiToken: string;
  let wsId: string;
  beforeAll(async () => {
    ({ app } = await buildApp(ctx));
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address() as { port: number };
    base = `http://127.0.0.1:${addr.port}`;
  });
  afterAll(async () => {
    await app.close();
  });
  const api = async (method: string, url: string, body?: unknown, token = jwt) => {
    const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  it('probes and metrics', async () => {
    expect((await fetch(base + '/healthz')).status).toBe(200);
    const ready = await (await fetch(base + '/readyz')).json();
    expect(ready.status).toBe('ready');
    const m = await (await fetch(base + '/metrics')).text();
    expect(m).toContain('duckview_queries_total');
    expect(m).toContain('duckview_query_duration_seconds_bucket');
  });
  it('login, workspaces, query, tokens', async () => {
    expect((await api('POST', '/api/auth/login', { email: 'admin@test.local', password: 'nope' }, '')).status).toBe(401);
    const login = await api('POST', '/api/auth/login', { email: 'admin@test.local', password: 'super-secret-pw' }, '');
    expect(login.status).toBe(200);
    jwt = login.json.token as string;
    expect((await api('GET', '/api/workspaces', undefined, '')).status).toBe(401);
    const list = await api('GET', '/api/workspaces');
    wsId = (list.json.workspaces as { id: string }[])[0]!.id;
    const q = await api('POST', `/api/workspaces/${wsId}/query`, { sql: "SELECT count(*) AS n FROM 'seed.parquet'" });
    expect(q.status).toBe(200);
    expect((q.json.rows as unknown[][])[0]).toEqual([1000]);
    const bad = await api('POST', `/api/workspaces/${wsId}/query`, { sql: 'SELECT * FROM nope' });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toBe('SQL_ERROR');
    const jailed = await api('POST', `/api/workspaces/${wsId}/query`, { sql: "SELECT * FROM '/etc/passwd'" });
    expect(jailed.status).toBe(403);
    const tab = await api('POST', `/api/workspaces/${wsId}/tabs`, { title: 'T', sql_content: 'SELECT 2' });
    expect(tab.status).toBe(200);
    const upd = await api('PATCH', `/api/workspaces/${wsId}/tabs/${(tab.json.tab as { id: string }).id}`, { chart_config: { type: 'bar', x: 'a', y: ['b'] } });
    expect((upd.json.tab as { chart_config: { type: string } }).chart_config.type).toBe('bar');
    const tok = await api('POST', '/api/tokens', { name: 'agent', scopes: ['read', 'write', 'mcp'], workspace_id: wsId, expires_in_days: 30 });
    expect(tok.status).toBe(200);
    apiToken = tok.json.token as string;
    expect(apiToken.startsWith('dv_')).toBe(true);
    // token can query but is workspace-scoped and HITL-gated
    const tq = await api('POST', `/api/workspaces/${wsId}/query`, { sql: 'SELECT 1' }, apiToken);
    expect(tq.status).toBe(200);
    const th = await api('POST', `/api/workspaces/${wsId}/query`, { sql: 'DROP TABLE t2' }, apiToken);
    expect(th.status).toBe(409);
    expect((th.json.challenge as { status: string }).status).toBe('approval_required');
    const audit = await api('GET', '/api/audit?actor_type=AGENT&limit=5');
    expect((audit.json.events as unknown[]).length).toBeGreaterThan(0);
    const info = await api('GET', '/api/mcp/info');
    expect((info.json.tools as string[]).length).toBe(45);
  });
  it('MCP over Streamable HTTP with bearer token', async () => {
    expect((await fetch(base + '/mcp', { method: 'POST' })).status).toBe(401);
    const transport = new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { authorization: `Bearer ${apiToken}` } } });
    const client = new Client({ name: 't', version: '0' });
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.length).toBe(45);
    const r = await client.callTool({ name: 'execute_query', arguments: { sql: 'SELECT 42 AS answer' } });
    expect((r.structuredContent as { rows: unknown[][] }).rows[0]).toEqual([42]);
    const sessions = await api('GET', '/api/mcp/sessions');
    expect((sessions.json.sessions as { transport: string }[]).some((s) => s.transport === 'streamable-http')).toBe(true);
    await client.close();
  });
  it('MCP over legacy SSE with bearer token', async () => {
    const transport = new SSEClientTransport(new URL(base + '/mcp/sse'), {
      eventSourceInit: { fetch: (url, init) => fetch(url, { ...init, headers: { ...(init?.headers as Record<string, string>), authorization: `Bearer ${apiToken}` } }) },
      requestInit: { headers: { authorization: `Bearer ${apiToken}` } },
    });
    const client = new Client({ name: 't', version: '0' });
    await client.connect(transport);
    const r = await client.readResource({ uri: 'duckdb://workspaces' });
    expect(JSON.parse(r.contents[0]!.text as string)[0].id).toBe(wsId);
    await client.close();
  });
  it('overview profiler returns KPIs, null ratios, sample and distributions', async () => {
    const r = await api('POST', `/api/workspaces/${wsId}/overview`, { target: 'seed.parquet' });
    expect(r.status).toBe(200);
    const o = r.json as { row_count: number; column_count: number; duplicate_rows: number; null_cell_ratio: number; sample: { rows: unknown[][] }; columns: { name: string; distribution: { kind: string; bins: unknown[] } | null }[] };
    expect(o.row_count).toBe(1000);
    expect(o.column_count).toBe(3);
    expect(o.duplicate_rows).toBe(0);
    expect(o.null_cell_ratio).toBe(0);
    expect(o.sample.rows.length).toBe(50);
    expect(o.columns.find((c) => c.name === 'id')?.distribution?.kind).toBe('histogram');
    expect(o.columns.find((c) => c.name === 'id')?.distribution?.bins.length).toBe(16);
    // near-unique text columns get no top-N (no signal, expensive) …
    expect(o.columns.find((c) => c.name === 'name')?.distribution).toBeNull();
    // … but real categoricals do, and SELECT targets work too
    const cat = await api('POST', `/api/workspaces/${wsId}/overview`, { target: "SELECT CASE WHEN id % 2 = 0 THEN 'even' ELSE 'odd' END AS parity, id FROM 'seed.parquet'" });
    const parity = (cat.json as { columns: { name: string; distribution: { kind: string; bins: { label: string; count: number }[] } | null }[] }).columns.find((c) => c.name === 'parity');
    expect(parity?.distribution?.kind).toBe('categories');
    expect(parity?.distribution?.bins.map((b) => b.count).sort()).toEqual([500, 500]);
    const bad = await api('POST', `/api/workspaces/${wsId}/overview`, { target: '/etc/passwd' });
    expect(bad.status).toBe(403);
  });
  it('drag-and-drop upload lands inside the jail and is queryable', async () => {
    const form = new FormData();
    form.append('file', new Blob(['a,b\n1,x\n2,y\n'], { type: 'text/csv' }), 'uploaded.csv');
    const res = await fetch(`${base}/api/workspaces/${wsId}/files?dir=incoming`, { method: 'POST', headers: { authorization: `Bearer ${jwt}` }, body: form });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { files: { path: string; kind: string; size_bytes: number }[] };
    expect(j.files[0]).toMatchObject({ path: 'incoming/uploaded.csv', kind: 'csv' });
    const q = await api('POST', `/api/workspaces/${wsId}/query`, { sql: "SELECT count(*) FROM 'incoming/uploaded.csv'" });
    expect((q.json.rows as unknown[][])[0]).toEqual([2]);
    // traversal in the dir param and disallowed extensions are rejected
    const evil = new FormData();
    evil.append('file', new Blob(['x']), 'evil.csv');
    expect((await fetch(`${base}/api/workspaces/${wsId}/files?dir=../..`, { method: 'POST', headers: { authorization: `Bearer ${jwt}` }, body: evil })).status).toBe(403);
    const exe = new FormData();
    exe.append('file', new Blob(['x']), 'payload.exe');
    expect((await fetch(`${base}/api/workspaces/${wsId}/files`, { method: 'POST', headers: { authorization: `Bearer ${jwt}` }, body: exe })).status).toBe(400);
    const dl = await fetch(`${base}/api/workspaces/${wsId}/files/download?path=incoming/uploaded.csv`, { headers: { authorization: `Bearer ${jwt}` } });
    expect(dl.status).toBe(200);
    expect(dl.headers.get('content-disposition')).toContain('uploaded.csv');
    expect(await dl.text()).toBe('a,b\n1,x\n2,y\n');
    expect((await fetch(`${base}/api/workspaces/${wsId}/files/download?path=../seed.parquet`, { headers: { authorization: `Bearer ${jwt}` } })).status).toBe(403);
    const del = await api('DELETE', `/api/workspaces/${wsId}/files?path=incoming/uploaded.csv`);
    expect(del.status).toBe(200);
    expect((await api('DELETE', `/api/workspaces/${wsId}/files?path=../seed.parquet`)).status).toBe(403);
  });
  it('persists cursor position with tab state', async () => {
    const tabs = await api('GET', `/api/workspaces/${wsId}/tabs`);
    const tab = (tabs.json.tabs as { id: string }[])[0]!;
    const upd = await api('PATCH', `/api/workspaces/${wsId}/tabs/${tab.id}`, { sql_content: 'SELECT 42', cursor_position: 6 });
    expect((upd.json.tab as { cursor_position: number }).cursor_position).toBe(6);
    const again = await api('GET', `/api/workspaces/${wsId}/tabs`);
    expect((again.json.tabs as { id: string; cursor_position: number }[]).find((t) => t.id === tab.id)?.cursor_position).toBe(6);
  });
  it('live system stats expose gauges', async () => {
    const r = await api('GET', '/api/system/live');
    expect(r.status).toBe(200);
    const j = r.json as { host: { cpu_percent: number; memory_total_bytes: number }; duckdb: { memory_limit_bytes: number; engines: unknown[] }; scratch: { path: string } };
    expect(j.host.memory_total_bytes).toBeGreaterThan(0);
    expect(j.duckdb.memory_limit_bytes).toBe(1e9);
    expect(j.duckdb.engines.length).toBeGreaterThan(0);
  });
  it('live events feed streams audit + MCP tool events', async () => {
    const { default: WebSocket } = await import('ws');
    const ws = new WebSocket(base.replace('http', 'ws') + '/api/ws/events');
    const received: Record<string, unknown>[] = [];
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token: jwt })));
      ws.on('message', async (d) => {
        const m = JSON.parse(d.toString());
        received.push(m);
        if (m.type === 'ready') {
          // trigger an MCP tool call over streamable HTTP with the agent token
          const transport = new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { authorization: `Bearer ${apiToken}` } } });
          const client = new Client({ name: 't', version: '0' });
          await client.connect(transport);
          await client.callTool({ name: 'execute_query', arguments: { sql: 'SELECT 7 AS seven' } });
          await client.close();
        }
        if (received.some((e) => e.type === 'mcp_tool') && received.some((e) => e.type === 'audit')) {
          ws.close();
          resolve();
        }
      });
      ws.on('error', reject);
      setTimeout(() => reject(new Error('timeout waiting for live events')), 10_000);
    });
    const tool = received.find((e) => e.type === 'mcp_tool') as { tool: string; status: string; summary: string };
    expect(tool.tool).toBe('execute_query');
    expect(tool.status).toBe('ok');
    expect(tool.summary).toContain('SELECT 7');
  });
  it('WebSocket streaming', async () => {
    const { default: WebSocket } = await import('ws');
    const ws = new WebSocket(base.replace('http', 'ws') + '/api/ws/query');
    const messages: Record<string, unknown>[] = [];
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token: jwt })));
      ws.on('message', (d) => {
        const m = JSON.parse(d.toString());
        messages.push(m);
        if (m.type === 'ready') ws.send(JSON.stringify({ type: 'run', id: 'q1', workspace_id: wsId, sql: "SELECT id FROM 'seed.parquet' ORDER BY id", max_rows: 50 }));
        if (m.type === 'done' || m.type === 'error') {
          ws.close();
          resolve();
        }
      });
      ws.on('error', reject);
    });
    const types = messages.map((m) => m.type);
    expect(types[0]).toBe('ready');
    expect(types).toContain('schema');
    expect(types).toContain('rows');
    const done = messages.find((m) => m.type === 'done') as { row_count: number; truncated: boolean };
    expect(done.row_count).toBe(50);
    expect(done.truncated).toBe(true);
  });
});
