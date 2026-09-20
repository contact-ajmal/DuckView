/**
 * The Connections page: the source catalog, database connections attached to workspace engines (proved with a
 * DuckDB file — the same ATTACH path Postgres/MySQL/SQLite take), scheduled syncs from SQL, URLs and attached
 * tables with transformations, the scheduler, and the agent tools.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { loadConfig } from '../config/index.js';
import { initLogger } from '../observability/logger.js';
import { createContext, type AppContext } from '../context.js';
import { buildApp } from '../app.js';
import { buildTools, runTool, type ToolEnv } from '../agent/tools.js';
import { attachTarget } from '../services/databases.js';
import { loadSelect, bindTransform, nextRunAt, googleSheetCsvUrl } from '../services/syncs.js';
import type { Principal } from '../services/principal.js';

let dir: string;
let ctx: AppContext;
let app: Awaited<ReturnType<typeof buildApp>>['app'];
let base: string;
let admin: Principal;
let jwt: string;
let wsId: string;
let web: { url: string; hits: number; close: () => void };

const api = async (method: string, url: string, body?: unknown, token = jwt) => {
  const res = await fetch(base + url, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
};

beforeAll(async () => {
  initLogger({ level: 'silent', stderr: true, pretty: false });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dv-sources-'));
  // A tiny web server: a CSV export the way an API or a shared Google Sheet would serve it.
  web = await new Promise((resolve) => {
    let hits = 0;
    const srv = http.createServer((req, res) => {
      hits++;
      if (req.url?.startsWith('/export.csv')) {
        res.writeHead(200, { 'content-type': 'text/csv' });
        return res.end('sku,qty,price\nA,2,10.5\nB,5,3\nC,0,99\n');
      }
      res.writeHead(404);
      res.end();
    });
    srv.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(srv.address() as { port: number }).port}`, get hits() { return hits; }, close: () => srv.close() }));
  });
  const cfg = loadConfig({
    configPath: null,
    env: { DUCKVIEW_DATA_DIR: path.join(dir, 'data'), DUCKVIEW_FILESYSTEM_MODE: 'full', DUCKDB_TEMP_DIRECTORY: path.join(dir, 'spill'), DATABASE_URL: ':memory:', DUCKDB_MEMORY_LIMIT: '512MB', DUCKVIEW_ADMIN_EMAIL: 'admin@test.local', DUCKVIEW_ADMIN_PASSWORD: 'super-secret-pw', DUCKVIEW__duckdb__sync_scheduler_enabled: 'false', LOG_LEVEL: 'silent' },
  });
  ctx = await createContext(cfg);
  admin = ctx.auth.principalFromUser((await ctx.auth.findByEmail('admin@test.local'))!, 'jwt', '127.0.0.1');
  wsId = (await ctx.workspaces.create(admin, { name: 'Pipelines', active_db_path: 'pipelines.duckdb' })).id;
  // A "warehouse" DuckDB file to attach as a database source.
  await ctx.queries.run(admin, wsId, "ATTACH 'warehouse.duckdb' AS wh; CREATE SCHEMA wh.sales; CREATE TABLE wh.sales.orders AS SELECT range AS id, 'c' || (range % 7) AS customer, range * 2.5 AS amount, DATE '2026-01-01' + INTERVAL (range) DAY AS day FROM range(120); CREATE VIEW wh.sales.big AS SELECT * FROM wh.sales.orders WHERE amount > 200; DETACH wh");
  ({ app } = await buildApp(ctx));
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  jwt = (await api('POST', '/api/auth/login', { email: 'admin@test.local', password: 'super-secret-pw' }, '')).json.token as string;
});

afterAll(async () => {
  await app.close();
  await ctx.shutdown();
  web.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('source catalog', () => {
  it('lists every family with what is available and what is planned', async () => {
    const r = await api('GET', '/api/sources/catalog');
    const sources = r.json.sources as { id: string; family: string; status: string; capabilities: { sync: boolean } }[];
    expect(sources.filter((s) => s.status === 'available').map((s) => s.id)).toEqual(expect.arrayContaining(['s3', 'r2', 'gcs', 'azure', 'glue', 's3tables', 'iceberg_rest', 'databricks', 'postgres', 'mysql', 'sqlite', 'duckdb', 'http', 'google_sheets']));
    expect(sources.filter((s) => s.status === 'planned').map((s) => s.id)).toEqual(expect.arrayContaining(['snowflake', 'bigquery', 'redshift', 'clickhouse', 'salesforce', 'hubspot', 'stripe']));
    expect(Object.keys(r.json.families as object)).toEqual(['storage', 'lakehouse', 'database', 'web', 'warehouse', 'saas']);
    const all = await api('GET', '/api/sources');
    expect(all.json).toMatchObject({ mode: 'full', external_access: true, cloud: [], lakehouse: [], databases: [] });
    expect((await api('GET', '/api/sources/google-sheet-url?spreadsheet_id=1AbCdEf9&gid=42')).json).toEqual({ url: 'https://docs.google.com/spreadsheets/d/1AbCdEf9/export?format=csv&gid=42' });
  });
});

describe('database connections', () => {
  it("builds the ATTACH strings DuckDB's extensions expect (secrets never in the row)", () => {
    expect(attachTarget('postgres', { host: 'db', port: 5433, database: 'app', user: 'ro', ssl: true }, 'p@ss', (p) => p)).toBe('host=db port=5433 dbname=app user=ro password=p@ss sslmode=require');
    expect(attachTarget('mysql', { host: 'db', database: 'shop', user: 'ro' }, 'x', (p) => p)).toBe('host=db port=3306 database=shop user=ro password=x');
    expect(attachTarget('sqlite', { path: 'app.sqlite' }, null, (p) => `/jail/${p}`)).toBe('/jail/app.sqlite');
  });

  it('attaches a DuckDB file read-only as alias.schema.table, browses it, tests it, and workspaces see it', async () => {
    const bad = await api('POST', '/api/database-connections', { name: 'x', engine: 'postgres', config: { host: 'db' } });
    expect(bad.status).toBe(400);
    expect((await api('POST', '/api/database-connections', { name: 'x', engine: 'duckdb', alias: 'main', config: { path: 'warehouse.duckdb' } })).status).toBe(400); // reserved alias
    expect((await api('POST', '/api/database-connections', { name: 'x', engine: 'duckdb', config: { path: 'missing.duckdb' } })).status).toBe(400);
    const r = await api('POST', '/api/database-connections', { name: 'Warehouse file', engine: 'duckdb', alias: 'wh', config: { path: 'warehouse.duckdb' } });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const c = r.json.connection as { id: string; alias: string; engine: string; status: string; has_password: boolean; needs_external_access: boolean };
    expect(c).toMatchObject({ alias: 'wh', engine: 'duckdb', status: 'unknown', has_password: false, needs_external_access: false });
    // Test + browse through a scratch instance.
    const t = await api('POST', `/api/database-connections/${c.id}/test`);
    expect(t.json).toMatchObject({ ok: true, tables: 1 });
    const schemas = await api('GET', `/api/database-connections/${c.id}/browse`);
    expect((schemas.json.entries as { name: string }[]).map((e) => e.name)).toContain('sales');
    const tables = await api('GET', `/api/database-connections/${c.id}/browse?schema=sales`);
    expect((tables.json.entries as { name: string; type: string; qualified: string }[]).map((e) => `${e.type}:${e.qualified}`)).toEqual(['table:wh.sales.orders', 'view:wh.sales.big']);
    // The owner's workspaces get it attached (hot, on the next use) and it is read-only.
    expect((await ctx.queries.run(admin, wsId, 'SELECT count(*) AS n FROM wh.sales.orders')).rows[0]![0]).toBe(120);
    await expect(ctx.queries.run(admin, wsId, "INSERT INTO wh.sales.orders VALUES (999, 'x', 1, DATE '2026-01-01')")).rejects.toThrow(/read-only|Cannot execute/i);
    const list = await api('GET', '/api/sources');
    expect((list.json.databases as { alias: string }[]).map((d) => d.alias)).toEqual(['wh']);
  });
});

describe('scheduled syncs', () => {
  it('validates sources, transformations and schedules', () => {
    expect(loadSelect({ kind: 'sql', sql: 'SELECT 1 AS a;' })).toBe('SELECT 1 AS a');
    expect(() => loadSelect({ kind: 'sql', sql: 'DROP TABLE x' })).toThrow(/read-only/);
    expect(loadSelect({ kind: 'table', schema: 'sales', table: 'orders', database_connection_id: 'c1' }, () => 'wh')).toBe('SELECT * FROM "wh"."sales"."orders"');
    expect(loadSelect({ kind: 'url', url: 'https://x/y.csv', format: 'csv', options: { header: true, delim: ';' } })).toBe("SELECT * FROM read_csv('https://x/y.csv', header=true, delim=';')");
    expect(loadSelect({ kind: 'url', url: 'https://x/y.json', format: 'json' })).toBe("SELECT * FROM read_json_auto('https://x/y.json')");
    expect(() => loadSelect({ kind: 'url', url: 'ftp://x', format: 'auto' })).toThrow(/http/);
    expect(bindTransform('SELECT sku, qty * price AS value FROM {{raw}} WHERE qty > 0', 'main.t__staging')).toBe('SELECT sku, qty * price AS value FROM main.t__staging WHERE qty > 0');
    expect(() => bindTransform('SELECT * FROM orders', 'x')).toThrow(/raw/);
    expect(() => bindTransform('DELETE FROM {{raw}}', 'x')).toThrow(/read-only/);
    expect(nextRunAt({ kind: 'manual' })).toBeNull();
    expect(nextRunAt({ kind: 'interval', minutes: 15 }, new Date('2026-01-01T00:00:00Z'))!.toISOString()).toBe('2026-01-01T00:15:00.000Z');
    expect(nextRunAt({ kind: 'cron', expression: '30 6 * * 1-5', timezone: 'UTC' }, new Date('2026-01-03T00:00:00Z'))!.toISOString()).toBe('2026-01-05T06:30:00.000Z'); // Saturday → Monday
    expect(() => nextRunAt({ kind: 'cron', expression: 'not a cron' })).toThrow(/Invalid cron/);
    expect(googleSheetCsvUrl('1AbC')).toBe('https://docs.google.com/spreadsheets/d/1AbC/export?format=csv');
  });

  it('loads a URL, transforms it, replaces or appends, records runs and reports through the API', async () => {
    const source = { kind: 'url', url: `${web.url}/export.csv`, format: 'csv' } as const;
    // Preview binds the source and the transformation without touching the workspace.
    const preview = await api('POST', `/api/workspaces/${wsId}/syncs/preview`, { source, transform_sql: 'SELECT sku, qty * price AS value FROM {{raw}} WHERE qty > 0', limit: 10 });
    expect(preview.status, JSON.stringify(preview.json)).toBe(200);
    expect((preview.json.columns as { name: string }[]).map((c) => c.name)).toEqual(['sku', 'value']);
    expect((preview.json.rows as unknown[][]).length).toBe(2);
    expect((await api('POST', `/api/workspaces/${wsId}/syncs/preview`, { source, transform_sql: 'SELECT nope FROM {{raw}}' })).status).toBeGreaterThanOrEqual(400);
    const created = await api('POST', `/api/workspaces/${wsId}/syncs`, { name: 'Inventory feed', source, target_table: 'inventory', transform_sql: 'SELECT sku, qty * price AS value FROM {{raw}} WHERE qty > 0', schedule: { kind: 'interval', minutes: 60 } });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    const sync = created.json.sync as { id: string; next_run_at: string; enabled: boolean };
    expect(sync.enabled).toBe(true);
    expect(new Date(sync.next_run_at).getTime()).toBeGreaterThan(Date.now() + 50 * 60_000);
    // Run now.
    const run = await api('POST', `/api/syncs/${sync.id}/run`, {});
    expect(run.json.run).toMatchObject({ status: 'ok', rows: 2, triggered_by: 'manual' });
    const rows = await ctx.queries.run(admin, wsId, 'SELECT sku, value FROM inventory ORDER BY sku', { cache: false });
    expect(rows.rows).toEqual([['A', 21], ['B', 15]]);
    // No staging leftovers; the catalog shows the target only.
    const cat = await ctx.queries.catalog(admin, wsId);
    expect(cat.objects.filter((o) => o.name.startsWith('inventory')).map((o) => o.name)).toEqual(['inventory']);
    // Append mode keeps adding; a failing source is a recorded error, not a crash.
    await api('PATCH', `/api/syncs/${sync.id}`, { mode: 'append' });
    await api('POST', `/api/syncs/${sync.id}/run`, {});
    expect((await ctx.queries.run(admin, wsId, 'SELECT count(*) AS n FROM inventory', { cache: false })).rows[0]![0]).toBe(4);
    await api('PATCH', `/api/syncs/${sync.id}`, { source: { kind: 'url', url: `${web.url}/missing.csv`, format: 'csv' } });
    const failed = await api('POST', `/api/syncs/${sync.id}/run`, {});
    expect(failed.json.run).toMatchObject({ status: 'error' });
    expect(String((failed.json.run as { error: string }).error)).toMatch(/404|HTTP|missing/i);
    expect((await ctx.queries.run(admin, wsId, 'SELECT count(*) AS n FROM inventory', { cache: false })).rows[0]![0]).toBe(4); // target untouched
    const detail = await api('GET', `/api/syncs/${sync.id}`);
    expect((detail.json.runs as { status: string }[]).map((r) => r.status)).toEqual(['error', 'ok', 'ok']);
    expect((detail.json.sync as { last_run: { status: string } }).last_run.status).toBe('error');
    // Validation: bad identifiers, mutating source SQL, bad cron.
    expect((await api('POST', `/api/workspaces/${wsId}/syncs`, { name: 'x', source: { kind: 'sql', sql: 'SELECT 1' }, target_table: 'bad name' })).status).toBe(400);
    expect((await api('POST', `/api/workspaces/${wsId}/syncs`, { name: 'x', source: { kind: 'sql', sql: 'DELETE FROM t' }, target_table: 't' })).status).toBe(400);
    expect((await api('POST', `/api/workspaces/${wsId}/syncs`, { name: 'x', source: { kind: 'sql', sql: 'SELECT 1' }, target_table: 't', schedule: { kind: 'cron', expression: '99 99 * * *' } })).status).toBe(400);
  });

  it('syncs a table of an attached database with the scheduler, and viewers can only look', async () => {
    const db = (await api('GET', '/api/database-connections')).json.connections as { id: string }[];
    const created = await api('POST', `/api/workspaces/${wsId}/syncs`, { name: 'Orders from warehouse', source: { kind: 'table', database_connection_id: db[0]!.id, schema: 'sales', table: 'orders' }, target_table: 'orders_copy', target_schema: 'staging', transform_sql: "SELECT customer, sum(amount) AS revenue FROM {{raw}} GROUP BY 1", schedule: { kind: 'interval', minutes: 1 } });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    const sync = created.json.sync as { id: string };
    // Make it due and let the scheduler pick it up.
    await ctx.syncs.update(admin, sync.id, { schedule: { kind: 'interval', minutes: 1 } });
    await ctx.syncs['db'].update(ctx.syncs['s'].dataSyncs).set({ next_run_at: new Date(Date.now() - 1000) }).where((await import('drizzle-orm')).eq(ctx.syncs['s'].dataSyncs.id, sync.id));
    const started = await ctx.syncs.tick();
    expect(started).toEqual([sync.id]);
    for (let i = 0; i < 100 && (await ctx.syncs.get(admin, sync.id)).last_run?.status !== 'ok'; i++) await new Promise((r) => setTimeout(r, 50));
    const after = await ctx.syncs.get(admin, sync.id);
    expect(after.last_run).toMatchObject({ status: 'ok', rows: 7 });
    expect(after.next_run_at!.getTime()).toBeGreaterThan(Date.now());
    expect((await ctx.queries.run(admin, wsId, 'SELECT count(*) AS n, round(sum(revenue)) AS r FROM staging.orders_copy', { cache: false })).rows[0]).toEqual([7, 17850]);
    expect((await ctx.syncs.tick()).length).toBe(0); // not due again yet
    // A viewer sees syncs and runs but cannot create, run or change them.
    const viewer = await ctx.auth.createLocalUser({ email: 'viewer@test.local', password: 'viewer-password', role: 'USER' });
    await ctx.workspaces.setMember(admin, wsId, { subject_type: 'user', subject_id: viewer.id, role: 'VIEWER' });
    const vjwt = (await api('POST', '/api/auth/login', { email: 'viewer@test.local', password: 'viewer-password' }, '')).json.token as string;
    expect((await api('GET', `/api/workspaces/${wsId}/syncs`, undefined, vjwt)).status).toBe(200);
    expect((await api('POST', `/api/syncs/${sync.id}/run`, {}, vjwt)).status).toBe(403);
    expect((await api('POST', `/api/workspaces/${wsId}/syncs`, { name: 'x', source: { kind: 'sql', sql: 'SELECT 1' }, target_table: 't' }, vjwt)).status).toBe(403);
    expect((await api('DELETE', `/api/syncs/${sync.id}`, undefined, vjwt)).status).toBe(403);
  });

  it('agents set up and operate pipelines through the tools, with transformations validated first', async () => {
    const env: ToolEnv = { ctx, principal: admin, via: 'rest', defaultWorkspaceId: wsId, agent: null };
    const tools = buildTools(ctx.cfg);
    const t = (n: string) => tools.find((x) => x.name === n)!;
    const listed = await runTool(env, t('list_data_sources'), { workspace_id: wsId });
    const sc = listed.structuredContent as { databases: { alias: string }[]; syncs: { name: string }[]; catalog: { id: string }[] };
    expect(sc.databases[0]!.alias).toBe('wh');
    expect(sc.syncs.map((s) => s.name)).toEqual(expect.arrayContaining(['Inventory feed', 'Orders from warehouse']));
    expect(sc.catalog.some((c) => c.id === 'postgres')).toBe(true);
    // A bad transformation is refused before anything is saved.
    const bad = await runTool(env, t('create_data_sync'), { name: 'Bad', source: { kind: 'sql', sql: 'SELECT 1 AS a' }, target_table: 'bad', transform_sql: 'SELECT nope FROM {{raw}}' });
    expect(bad.isError).toBe(true);
    const created = await runTool(env, t('create_data_sync'), { name: 'Big orders', source: { kind: 'sql', sql: 'SELECT * FROM wh.sales.big' }, target_table: 'big_orders', schedule: { kind: 'cron', expression: '0 * * * *' }, run_now: true });
    expect(created.isError).toBeFalsy();
    const csc = created.structuredContent as { sync_id: string; run: { status: string; rows: number }; columns: { name: string }[] };
    expect(csc.run).toMatchObject({ status: 'ok', rows: 39 });
    expect(csc.columns.map((c) => c.name)).toEqual(['id', 'customer', 'amount', 'day']);
    const updated = await runTool(env, t('update_data_sync'), { sync_id: csc.sync_id, transform_sql: 'SELECT customer, count(*) AS n FROM {{raw}} GROUP BY 1', run_now: true });
    expect(updated.isError).toBeFalsy();
    expect((updated.structuredContent as { run: { rows: number } }).run.rows).toBe(7);
    const ran = await runTool(env, t('run_data_sync'), { sync_id: csc.sync_id });
    expect((ran.structuredContent as { run: { status: string }; recent: unknown[] }).run.status).toBe('ok');
    expect((ran.structuredContent as { recent: unknown[] }).recent.length).toBeGreaterThanOrEqual(2);
    expect((await ctx.queries.run(admin, wsId, 'SELECT count(*) FROM big_orders', { cache: false })).rows[0]![0]).toBe(7);
  });
});
