import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tableFromIPC } from 'apache-arrow';
import { loadConfig } from '../config/index.js';
import { initLogger } from '../observability/logger.js';
import { createContext, type AppContext } from '../context.js';
import { buildApp } from '../app.js';
import { DataJail, SandboxViolation } from '../engine/sandbox.js';
import { secretToSql } from '../engine/duckdb.js';
import type { Principal } from '../services/principal.js';

let dir: string;
let ctx: AppContext;
let admin: Principal;
let wsId: string;
let app: Awaited<ReturnType<typeof buildApp>>['app'];
let base: string;
let jwt: string;

const api = async (method: string, url: string, body?: unknown, token = jwt) => {
  const res = await fetch(base + url, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
};

beforeAll(async () => {
  initLogger({ level: 'silent', stderr: true, pretty: false });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dv-p2-'));
  const cfg = loadConfig({
    configPath: null,
    env: { DUCKVIEW_DATA_DIR: path.join(dir, 'data'), DUCKDB_TEMP_DIRECTORY: path.join(dir, 'spill'), DATABASE_URL: ':memory:', DUCKDB_MEMORY_LIMIT: '1GB', DUCKVIEW_ADMIN_EMAIL: 'admin@test.local', DUCKVIEW_ADMIN_PASSWORD: 'super-secret-pw', LOG_LEVEL: 'silent' },
  });
  ctx = await createContext(cfg);
  const user = await ctx.auth.findByEmail('admin@test.local');
  admin = ctx.auth.principalFromUser(user!, 'jwt', '127.0.0.1');
  const ws = await ctx.workspaces.ensureDefault(admin);
  wsId = ws.id;
  fs.mkdirSync(path.join(dir, 'data', 'lake', 'raw'), { recursive: true });
  await ctx.queries.run(admin, wsId, "COPY (SELECT range AS id, 'r' || range AS name, range * 1.5 AS amount, DATE '2026-01-01' + INTERVAL (range % 30) DAY AS d, range % 3 = 0 AS flag FROM range(5000)) TO 'lake/sales.parquet' (FORMAT PARQUET)");
  await ctx.queries.run(admin, wsId, "COPY (SELECT range AS id, 'u' || range AS email FROM range(100)) TO 'lake/raw/users.csv' (FORMAT CSV, HEADER)");
  await ctx.queries.run(admin, wsId, "ATTACH 'warehouse.duckdb' AS wh; CREATE TABLE wh.dim_region (id INTEGER, name VARCHAR NOT NULL); INSERT INTO wh.dim_region VALUES (1, 'north'); DETACH wh");
  await ctx.queries.run(admin, wsId, 'CREATE TABLE t_local AS SELECT 1 AS a, 2 AS b');
  fs.writeFileSync(path.join(dir, 'data', 'lake', 'notes.txt'), 'hello');
  fs.writeFileSync(path.join(dir, 'data', '.hidden'), 'x');
  ({ app } = await buildApp(ctx));
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const login = await api('POST', '/api/auth/login', { email: 'admin@test.local', password: 'super-secret-pw' }, '');
  jwt = login.json.token as string;
  await ctx.auth.createLocalUser({ email: 'other@test.local', password: 'other-pass-123', role: 'USER' });
});

afterAll(async () => {
  await app.close();
  await ctx.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('DataJail explorer + full filesystem mode', () => {
  it('lists one level, folders first, hidden files skipped, non-data files flagged', () => {
    const root = ctx.workspaces.jail.listDir('.');
    expect(root.entries.map((e) => e.name)).toEqual(['lake', 'warehouse.duckdb']);
    expect(root.entries[0]).toMatchObject({ type: 'dir', queryable: false });
    const lake = ctx.workspaces.jail.listDir('lake');
    expect(lake.entries.map((e) => `${e.type}:${e.name}:${e.kind}:${e.queryable}`)).toEqual(['dir:raw:other:false', 'file:notes.txt:other:true', 'file:sales.parquet:parquet:true']);
    expect(() => ctx.workspaces.jail.listDir('../')).toThrow(SandboxViolation);
    expect(() => ctx.workspaces.jail.listDir('/etc')).toThrow(SandboxViolation);
  });
  it('full mode: root is the filesystem root but relative paths still anchor to the data dir', () => {
    const jail = new DataJail(path.parse(dir).root, path.join(dir, 'data'));
    expect(jail.isFullFilesystem).toBe(true);
    expect(jail.resolve('lake/sales.parquet').absolute).toBe(path.join(fs.realpathSync(dir), 'data', 'lake', 'sales.parquet'));
    expect(jail.resolve('lake/sales.parquet').relative).toBe('lake/sales.parquet');
    expect(jail.resolve(os.tmpdir()).absolute).toBe(fs.realpathSync(os.tmpdir()));
    expect(jail.listDir(fs.realpathSync(os.tmpdir())).absolute).toBe(fs.realpathSync(os.tmpdir()));
    expect(() => jail.resolve('../x')).toThrow(SandboxViolation); // traversal stays forbidden even in full mode
  });
  it('config refuses full mode in production without explicit opt-in', () => {
    expect(() => loadConfig({ configPath: null, env: { NODE_ENV: 'production', JWT_SECRET: 'x'.repeat(32), ENCRYPTION_KEY: 'a'.repeat(64), DUCKVIEW_FILESYSTEM_MODE: 'full' } })).toThrow(/single-user/);
    expect(loadConfig({ configPath: null, env: { NODE_ENV: 'production', JWT_SECRET: 'x'.repeat(32), ENCRYPTION_KEY: 'a'.repeat(64), DUCKVIEW_FILESYSTEM_MODE: 'full', DUCKVIEW_ALLOW_FULL_FS: '1' } }).security.filesystem_mode).toBe('full');
  });
});

describe('secretToSql', () => {
  it('S3 with a custom endpoint strips the scheme and forces path style / ssl', () => {
    const sql = secretToSql({ name: 'minio', type: 'S3', values: { access_key_id: 'AK', secret_access_key: 'SK', endpoint: 'http://minio:9000', scope: 's3://lake' } })!;
    expect(sql).toContain("TYPE S3");
    expect(sql).toContain("ENDPOINT 'minio:9000'");
    expect(sql).toContain("URL_STYLE 'path'");
    expect(sql).toContain('USE_SSL false');
    expect(sql).toContain("REGION 'us-east-1'");
    expect(sql).toContain("SCOPE 's3://lake'");
  });
  it('AWS S3 keeps virtual-hosted style and no endpoint', () => {
    const sql = secretToSql({ name: 'aws', type: 'S3', values: { access_key_id: 'AK', secret_access_key: 'SK', region: 'eu-west-1' } })!;
    expect(sql).not.toContain('ENDPOINT');
    expect(sql).not.toContain('URL_STYLE');
    expect(sql).toContain("REGION 'eu-west-1'");
  });
  it('R2 / GCS / Azure', () => {
    expect(secretToSql({ name: 'r2', type: 'R2', values: { access_key_id: 'a', secret_access_key: 'b', account_id: 'acct' } })).toBe("CREATE OR REPLACE SECRET r2 (TYPE R2, KEY_ID 'a', SECRET 'b', ACCOUNT_ID 'acct')");
    expect(secretToSql({ name: 'g', type: 'GCS', values: { access_key_id: 'a', secret_access_key: 'b', scope: 'gs://b' } })).toBe("CREATE OR REPLACE SECRET g (TYPE GCS, KEY_ID 'a', SECRET 'b', SCOPE 'gs://b')");
    expect(secretToSql({ name: 'az', type: 'AZURE', values: { connection_string: "x;y='z'" } })).toBe("CREATE OR REPLACE SECRET az (TYPE AZURE, CONNECTION_STRING 'x;y=''z''')");
  });
});

describe('storage explorer API', () => {
  it('walks the local tree', async () => {
    const root = await api('GET', `/api/storage/local?workspace_id=${wsId}`);
    expect(root.status).toBe(200);
    expect(root.json.mode).toBe('sandboxed');
    expect((root.json.entries as { name: string }[]).map((e) => e.name)).toEqual(['lake', 'warehouse.duckdb']);
    const raw = await api('GET', `/api/storage/local?workspace_id=${wsId}&path=lake/raw`);
    expect((raw.json.entries as { name: string; kind: string }[])[0]).toMatchObject({ name: 'users.csv', kind: 'csv' });
    expect((await api('GET', `/api/storage/local?workspace_id=${wsId}&path=../..`)).status).toBe(403);
    expect((await api('GET', `/api/storage/local?workspace_id=${wsId}&path=/etc`)).status).toBe(403);
  });
  it('inspects parquet without scanning (row count from footer)', async () => {
    const r = await api('POST', '/api/storage/inspect', { workspace_id: wsId, target: 'lake/sales.parquet' });
    expect(r.status).toBe(200);
    expect(r.json.kind).toBe('file');
    expect((r.json.columns as { name: string; type: string; nullable: boolean }[]).map((c) => `${c.name}:${c.type}`)).toEqual(['id:BIGINT', 'name:VARCHAR', 'amount:DECIMAL(21,1)', 'd:TIMESTAMP', 'flag:BOOLEAN']);
    expect(r.json.row_count).toBe(5000);
    expect(r.json.row_count_source).toBe('parquet_metadata');
    expect(r.json.suggested_sql).toContain("FROM 'lake/sales.parquet'");
  });
  it('inspects csv, tables, subqueries and .duckdb files', async () => {
    const csv = await api('POST', '/api/storage/inspect', { workspace_id: wsId, target: 'lake/raw/users.csv' });
    expect((csv.json.columns as { name: string }[]).map((c) => c.name)).toEqual(['id', 'email']);
    expect(csv.json.row_count).toBeNull();
    const tbl = await api('POST', '/api/storage/inspect', { workspace_id: wsId, target: 't_local' });
    expect(tbl.json.kind).toBe('table');
    expect(tbl.json.row_count_source).toBe('catalog');
    const q = await api('POST', '/api/storage/inspect', { workspace_id: wsId, target: "SELECT id, name FROM 'lake/sales.parquet' WHERE id < 10" });
    expect(q.json.kind).toBe('query');
    expect((q.json.columns as unknown[]).length).toBe(2);
    const db = await api('POST', '/api/storage/inspect', { workspace_id: wsId, target: 'warehouse.duckdb' });
    expect(db.json.kind).toBe('database');
    const tables = db.json.tables as { name: string; columns: { name: string; nullable: boolean }[] }[];
    expect(tables[0]!.name).toBe('dim_region');
    expect(tables[0]!.columns.find((c) => c.name === 'name')?.nullable).toBe(false);
    expect(db.json.suggested_sql).toContain("ATTACH 'warehouse.duckdb'");
  });
  it('refuses remote objects and escapes cleanly', async () => {
    const r = await api('POST', '/api/storage/inspect', { workspace_id: wsId, target: 's3://bucket/x.parquet' });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('EXTERNAL_ACCESS_DISABLED');
    expect((await api('POST', '/api/storage/inspect', { workspace_id: wsId, target: '/etc/passwd' })).status).toBe(403);
    expect((await api('POST', '/api/storage/inspect', { workspace_id: wsId, target: 'lake/missing.parquet' })).status).toBe(400);
  });
});

describe('streaming exports', () => {
  const sql = "SELECT id, name, amount, d, flag FROM 'lake/sales.parquet' ORDER BY id";
  it('parquet / csv / json via COPY TO, streamed with content-length', async () => {
    for (const format of ['parquet', 'csv', 'json'] as const) {
      const r = await api('POST', `/api/workspaces/${wsId}/export`, { sql, format, filename: 'sales' });
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      const e = r.json.export as { id: string; rows: number; size_bytes: number; engine: string; name: string; download_url: string };
      expect(e.rows).toBe(5000);
      expect(e.engine).toBe('duckdb');
      expect(e.name).toBe(`sales.${format}`);
      const dl = await fetch(base + e.download_url, { headers: { authorization: `Bearer ${jwt}` } });
      expect(dl.status).toBe(200);
      expect(Number(dl.headers.get('content-length'))).toBe(e.size_bytes);
      expect(dl.headers.get('content-disposition')).toContain(`sales.${format}`);
      const buf = Buffer.from(await dl.arrayBuffer());
      expect(buf.length).toBe(e.size_bytes);
      if (format === 'csv') expect(buf.toString('utf8').split('\n')[0]).toBe('id,name,amount,d,flag');
      if (format === 'json') expect(JSON.parse(buf.toString('utf8').split('\n')[0]!)).toMatchObject({ id: 0, name: 'r0' });
    }
  });
  it('arrow IPC via the streaming fallback writer, readable by Arrow JS', async () => {
    const r = await api('POST', `/api/workspaces/${wsId}/export`, { sql, format: 'arrow' });
    const e = r.json.export as { id: string; rows: number; engine: string; download_url: string; content_type: string };
    expect(e.rows).toBe(5000);
    expect(e.engine).toBe('node-arrow');
    expect(e.content_type).toContain('arrow.stream');
    const dl = await fetch(base + e.download_url, { headers: { authorization: `Bearer ${jwt}` } });
    const table = tableFromIPC(new Uint8Array(await dl.arrayBuffer()));
    expect(table.numRows).toBe(5000);
    expect(table.schema.fields.map((f) => `${f.name}:${f.type}`)).toEqual(['id:Int64', 'name:Utf8', 'amount:Float64', 'd:Timestamp<MILLISECOND>', 'flag:Bool']);
    const row = table.get(4999)!.toJSON() as Record<string, unknown>;
    expect(row.id).toBe(4999n);
    expect(row.name).toBe('r4999');
    expect(row.amount).toBe(7498.5);
  });
  it('rejects mutating SQL, lists and deletes exports', async () => {
    expect((await api('POST', `/api/workspaces/${wsId}/export`, { sql: 'DROP TABLE t_local', format: 'csv' })).status).toBe(400);
    expect((await api('POST', `/api/workspaces/${wsId}/export`, { sql: "SELECT * FROM '/etc/passwd'", format: 'csv' })).status).toBe(403);
    const list = await api('GET', '/api/exports');
    const exportsList = list.json.exports as { id: string }[];
    expect(exportsList.length).toBeGreaterThanOrEqual(4);
    expect((await api('DELETE', `/api/exports/${exportsList[0]!.id}`)).status).toBe(200);
    expect((await fetch(`${base}/api/exports/${exportsList[0]!.id}/download`, { headers: { authorization: `Bearer ${jwt}` } })).status).toBe(404);
    // another user cannot download mine
    const otherJwt = (await api('POST', '/api/auth/login', { email: 'other@test.local', password: 'other-pass-123' }, '')).json.token as string;
    expect(otherJwt).toBeTruthy();
    expect((await fetch(`${base}/api/exports/${exportsList[1]!.id}/download`, { headers: { authorization: `Bearer ${otherJwt}` } })).status).toBe(404);
  });
});

describe('cloud connections', () => {
  let connId: string;
  it('creates with validated fields, stores encrypted, never returns secrets', async () => {
    expect((await api('POST', '/api/cloud-connections', { name: 'bad', provider: 'R2', credentials: { access_key_id: 'a' } })).status).toBe(400);
    const r = await api('POST', '/api/cloud-connections', { name: 'minio-local', provider: 'S3', endpoint_url: 'http://127.0.0.1:1', region: 'us-east-1', bucket: 'lake', credentials: { access_key_id: 'AKIA', secret_access_key: 'shh', ignored: 'x' } });
    expect(r.status).toBe(200);
    const c = r.json.connection as { id: string; fields: string[]; uri_scheme: string; endpoint_url: string };
    connId = c.id;
    expect(c.fields.sort()).toEqual(['access_key_id', 'secret_access_key']);
    expect(c.uri_scheme).toBe('s3');
    expect(JSON.stringify(r.json)).not.toContain('shh');
    const row = (await ctx.store.db.select().from(ctx.store.schema.cloudConnections))[0]!;
    expect(row.encrypted_credentials).not.toContain('shh');
    const secrets = await ctx.cloud.resolveSecrets(admin.userId);
    expect(secrets[0]).toMatchObject({ type: 'S3', values: { endpoint: 'http://127.0.0.1:1', scope: 's3://lake', secret_access_key: 'shh' } });
  });
  it('maps unreachable endpoints to a clean CLOUD_ERROR and listing falls back to the configured bucket', async () => {
    const t = await api('POST', `/api/cloud-connections/${connId}/test`);
    expect([502, 403]).toContain(t.status);
    expect(String(t.json.error)).toMatch(/CLOUD_/);
    const b = await api('GET', `/api/storage/cloud?connection_id=${connId}`);
    expect(b.status).toBe(200);
    expect(b.json.buckets).toEqual([{ name: 'lake', created_at: null }]);
    expect(b.json.queryable).toBe(false);
    const o = await api('GET', `/api/storage/cloud?connection_id=${connId}&bucket=lake&prefix=raw/`);
    expect([502, 403]).toContain(o.status);
  }, 30_000);
  it('updates credentials by merge and deletes', async () => {
    const u = await api('PATCH', `/api/cloud-connections/${connId}`, { credentials: { session_token: 'tok' }, region: 'eu-west-1' });
    expect((u.json.connection as { fields: string[] }).fields.sort()).toEqual(['access_key_id', 'secret_access_key', 'session_token']);
    const secrets = await ctx.cloud.resolveSecrets(admin.userId);
    expect(secrets[0]!.values).toMatchObject({ session_token: 'tok', region: 'eu-west-1', secret_access_key: 'shh' });
    expect((await api('DELETE', `/api/cloud-connections/${connId}`)).status).toBe(200);
    expect((await api('GET', '/api/cloud-connections')).json.connections).toEqual([]);
  });
  it('engine still starts when a cloud secret exists but external access is off', async () => {
    const r = await api('POST', '/api/cloud-connections', { name: 'r2', provider: 'R2', bucket: 'b', credentials: { access_key_id: 'a', secret_access_key: 'b', account_id: 'acct' } });
    const q = await api('POST', `/api/workspaces/${wsId}/query`, { sql: 'SELECT 1 AS ok' });
    expect(q.status).toBe(200);
    await api('DELETE', `/api/cloud-connections/${(r.json.connection as { id: string }).id}`);
  });
});

describe('saved queries, dashboards, widgets, chat history', () => {
  let queryId: string;
  let dashId: string;
  let widgetId: string;
  it('saved query CRUD with folders and tags', async () => {
    const c = await api('POST', `/api/workspaces/${wsId}/queries`, { name: 'Sales by day', folder: '/finance/daily/', sql_text: "SELECT d, sum(amount) AS total FROM 'lake/sales.parquet' GROUP BY 1 ORDER BY 1", tags: ['Finance', 'daily', 'finance'] });
    expect(c.status).toBe(200);
    const q = c.json.query as { id: string; folder: string; tags: string[] };
    queryId = q.id;
    expect(q.folder).toBe('finance/daily');
    expect(q.tags).toEqual(['finance', 'daily']);
    const u = await api('PATCH', `/api/workspaces/${wsId}/queries/${queryId}`, { description: 'Daily revenue' });
    expect((u.json.query as { description: string }).description).toBe('Daily revenue');
    expect(((await api('GET', `/api/workspaces/${wsId}/queries`)).json.queries as unknown[]).length).toBe(1);
    expect((await api('POST', `/api/workspaces/${wsId}/queries`, { name: '', sql_text: 'SELECT 1' })).status).toBe(400);
  });
  it('dashboard + widget lifecycle with layout maintenance and data execution', async () => {
    const d = await api('POST', `/api/workspaces/${wsId}/dashboards`, { name: 'Revenue', description: 'Exec view' });
    expect(d.status).toBe(200);
    dashId = (d.json.dashboard as { id: string }).id;
    const kpi = await api('POST', `/api/dashboards/${dashId}/widgets`, { title: 'Total revenue', widget_type: 'KPI', custom_sql: "SELECT sum(amount) AS total FROM 'lake/sales.parquet'", chart_config: { value: 'total', format: 'currency' } });
    expect(kpi.status).toBe(200);
    widgetId = (kpi.json.widget as { id: string }).id;
    expect(kpi.json.layout).toEqual([{ i: widgetId, x: 0, y: 0, w: 3, h: 2 }]);
    const chart = await api('POST', `/api/dashboards/${dashId}/widgets`, { title: 'By day', widget_type: 'CHART', saved_query_id: queryId, chart_config: { chart: 'line', x: 'd', y: ['total'] }, refresh_interval_sec: 30 });
    expect((chart.json.layout as unknown[]).length).toBe(2);
    expect((chart.json.layout as { y: number }[])[1]!.y).toBe(2);
    expect((await api('POST', `/api/dashboards/${dashId}/widgets`, { title: 'bad', widget_type: 'CHART' })).status).toBe(400);
    expect((await api('POST', `/api/dashboards/${dashId}/widgets`, { title: 'bad', widget_type: 'TABLE', custom_sql: 'DROP TABLE t_local' })).status).toBe(400);
    expect((await api('POST', `/api/dashboards/${dashId}/widgets`, { title: 'bad', widget_type: 'CHART', saved_query_id: 'nope' })).status).toBe(400);
    const data = await api('POST', `/api/dashboards/${dashId}/widgets/${widgetId}/data`);
    expect(data.status).toBe(200);
    expect((data.json.rows as number[][])[0]![0]).toBe(18746250); // 1.5 * Σ range(5000)
    const chartData = await api('POST', `/api/dashboards/${dashId}/widgets/${(chart.json.widget as { id: string }).id}/data`);
    expect((chartData.json.rows as unknown[]).length).toBe(30);
    const full = await api('GET', `/api/dashboards/${dashId}`);
    expect((full.json.dashboard as { widgets: unknown[] }).widgets.length).toBe(2);
    const lay = await api('PATCH', `/api/dashboards/${dashId}`, { layout: [{ i: widgetId, x: 20, y: 0, w: 30, h: 2 }, { i: 'ghost', x: 0, y: 0, w: 1, h: 1 }] });
    expect((lay.json.dashboard as { layout: unknown[] }).layout).toEqual([{ i: widgetId, x: 11, y: 0, w: 12, h: 2 }]);
    const rm = await api('DELETE', `/api/dashboards/${dashId}/widgets/${widgetId}`);
    expect(rm.json.layout).toEqual([]);
    // deleting the saved query nulls the widget reference instead of failing
    expect((await api('DELETE', `/api/workspaces/${wsId}/queries/${queryId}`)).status).toBe(200);
    const after = await api('GET', `/api/dashboards/${dashId}`);
    expect((after.json.dashboard as { widgets: { saved_query_id: string | null }[] }).widgets[0]!.saved_query_id).toBeNull();
    expect((await api('DELETE', `/api/dashboards/${dashId}`)).status).toBe(200);
    expect((await api('GET', `/api/dashboards/${dashId}`)).status).toBe(404);
  });
  it('other users cannot see my dashboards', async () => {
    const d = await api('POST', `/api/workspaces/${wsId}/dashboards`, { name: 'Private' });
    const otherJwt = (await api('POST', '/api/auth/login', { email: 'other@test.local', password: 'other-pass-123' }, '')).json.token as string;
    expect(otherJwt).toBeTruthy();
    expect((await api('GET', `/api/dashboards/${(d.json.dashboard as { id: string }).id}`, undefined, otherJwt)).status).toBe(404);
  });
  it('chat history persists turns with context snapshots', async () => {
    await ctx.chat.append(admin, wsId, 'conv-1', 'user', 'How many sales?', { workspace_id: wsId, tables: [{ name: 't_local', type: 'TABLE', columns: [{ name: 'a', type: 'INTEGER' }] }], files: ['lake/sales.parquet'], buckets: [], active_sql: null });
    await ctx.chat.append(admin, wsId, 'conv-1', 'assistant', "SELECT count(*) FROM 'lake/sales.parquet'");
    const msgs = await ctx.chat.messages(admin, wsId, 'conv-1');
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(msgs[0]!.context_snapshot?.files).toEqual(['lake/sales.parquet']);
    const convs = await ctx.chat.conversations(admin, wsId);
    expect(convs[0]).toMatchObject({ id: 'conv-1', title: 'How many sales?', messages: 2 });
    await ctx.chat.clear(admin, wsId, 'conv-1');
    expect(await ctx.chat.messages(admin, wsId, 'conv-1')).toEqual([]);
  });
});

describe('cloud secrets with httpfs (external access on)', () => {
  it('loads httpfs from the extension directory, creates the secret, and fails only at the network layer', async () => {
    const extDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dv-ext-'));
    const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'dv-p2x-'));
    const cfg = loadConfig({
      configPath: null,
      env: { DUCKVIEW_DATA_DIR: path.join(d2, 'data'), DUCKDB_TEMP_DIRECTORY: path.join(d2, 'spill'), DATABASE_URL: ':memory:', DUCKDB_MEMORY_LIMIT: '512MB', DUCKVIEW_ADMIN_EMAIL: 'x@test.local', DUCKVIEW_ADMIN_PASSWORD: 'super-secret-pw', DUCKVIEW_ENABLE_EXTERNAL_ACCESS: 'true', DUCKDB_EXTENSION_DIRECTORY: extDir, LOG_LEVEL: 'silent' },
    });
    const c2 = await createContext(cfg);
    try {
      const u = await c2.auth.findByEmail('x@test.local');
      const p = c2.auth.principalFromUser(u!, 'jwt');
      const ws = await c2.workspaces.ensureDefault(p);
      // Pre-install httpfs the way the container image does (needs network once; skip gracefully offline).
      try {
        const { engine } = await c2.workspaces.engine(p, ws.id);
        await engine['instance'].connect().then(async (conn: { run: (s: string) => Promise<unknown>; closeSync: () => void }) => {
          await conn.run('INSTALL httpfs');
          conn.closeSync();
        });
      } catch (err) {
        console.warn('skipping httpfs test (offline?):', (err as Error).message.split('\n')[0]);
        return;
      }
      await c2.cloud.create(p.userId, { name: 'fake-minio', provider: 'S3', endpoint_url: 'http://127.0.0.1:1', bucket: 'lake', credentials: { access_key_id: 'AK', secret_access_key: 'SK' } });
      c2.engines.evict(ws.id);
      const { engine } = await c2.workspaces.engine(p, ws.id);
      expect(await engine.hasExtension('httpfs')).toBe(true);
      const secrets = await c2.queries.run(p, ws.id, "SELECT name, type FROM duckdb_secrets() WHERE type = 's3'");
      expect(secrets.rows.length).toBe(1);
      expect(String(secrets.rows[0]![0])).toMatch(/^cloud_s3_/);
      // The secret is wired; the endpoint is a closed port, so the failure is a connection error — not a missing secret/extension.
      await expect(c2.queries.run(p, ws.id, "SELECT * FROM 's3://lake/x.parquet'")).rejects.toThrow(/Connection|connect|refused|IO Error|HTTP/i);
      // Node-side jail still applies to local paths even with external access on
      await expect(c2.queries.run(p, ws.id, "SELECT * FROM read_csv('/etc/hosts')")).rejects.toBeInstanceOf(SandboxViolation);
    } finally {
      await c2.shutdown();
      fs.rmSync(d2, { recursive: true, force: true });
      fs.rmSync(extDir, { recursive: true, force: true });
    }
  }, 120_000);
});
