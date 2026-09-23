/**
 * Reverse ETL: a query's rows sent to a SQLite table (replace, append, upsert, mirror), to Parquet / CSV files, and
 * to an HTTP API in batches (only changed rows, deletions, headers, a failure retried in full); access policies of
 * the author apply; agents need approval and cannot schedule; failures reach the sync's channels; the scheduler.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { loadConfig } from '../config/index.js';
import { initLogger } from '../observability/logger.js';
import { createContext, type AppContext } from '../context.js';
import { buildApp } from '../app.js';
import { buildTools, runTool, type ToolEnv } from '../agent/tools.js';
import type { Principal } from '../services/principal.js';

let dir: string;
let dataDir: string;
let ctx: AppContext;
let app: Awaited<ReturnType<typeof buildApp>>['app'];
let receiver: http.Server;
let hook: string;
let failNext = 0;
const received: { path: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
let base: string;
let jwt: string;
let editorJwt: string;
let wsId: string;
let admin: Principal;
let sqliteId: string;

const api = async (method: string, url: string, body?: unknown, token = jwt) => {
  const res = await fetch(base + url, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
};
const sql = (s: string) => ctx.queries.run(admin, wsId, s, { cache: false });
/** Reads the SQLite destination directly. */
const readSqlite = async (q: string) => {
  const inst = await DuckDBInstance.create(':memory:');
  const conn = await inst.connect();
  try {
    await conn.run('LOAD sqlite');
    await conn.run(`ATTACH '${path.join(dataDir, 'crm.sqlite')}' AS crm (TYPE sqlite, READ_ONLY)`);
    // BIGINTs come back as strings; compare them as numbers.
    return (await conn.runAndReadAll(q)).getRowsJson().map((r) => r.map((v) => (typeof v === 'string' && /^-?\d+$/.test(v) ? Number(v) : v)));
  } finally {
    conn.closeSync();
    inst.closeSync();
  }
};
const run = async (id: string, token = jwt) => (await api('POST', `/api/reverse-syncs/${id}/run`, {}, token)).json.run;
const bodies = (p: string) => received.filter((r) => r.path === p).map((r) => r.body);

beforeAll(async () => {
  initLogger({ level: 'silent', stderr: true, pretty: false });
  receiver = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      received.push({ path: req.url!, headers: req.headers, body });
      if (req.url === '/crm' && failNext > 0) {
        failNext--;
        res.writeHead(503);
        return res.end('busy');
      }
      res.writeHead(200);
      res.end('ok');
    });
  });
  await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
  hook = `http://127.0.0.1:${(receiver.address() as net.AddressInfo).port}`;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dv-reverse-'));
  dataDir = path.join(dir, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  // The destination: an empty SQLite file.
  {
    const inst = await DuckDBInstance.create(':memory:');
    const conn = await inst.connect();
    await conn.run('INSTALL sqlite');
    await conn.run('LOAD sqlite');
    await conn.run(`ATTACH '${path.join(dataDir, 'crm.sqlite')}' AS crm (TYPE sqlite)`);
    await conn.run('CREATE TABLE crm.keep (x INTEGER)');
    conn.closeSync();
    inst.closeSync();
  }
  const cfg = loadConfig({ configPath: null, env: { DUCKVIEW_DATA_DIR: dataDir, DUCKDB_TEMP_DIRECTORY: path.join(dir, 'spill'), DATABASE_URL: ':memory:', DUCKDB_MEMORY_LIMIT: '512MB', DUCKVIEW_ADMIN_EMAIL: 'admin@test.local', DUCKVIEW_ADMIN_PASSWORD: 'super-secret-pw', DUCKVIEW__duckdb__sync_scheduler_enabled: 'false', DUCKVIEW__notifications__scheduler_enabled: 'false', DUCKVIEW__notifications__allow_private_targets: 'true', DUCKVIEW__transform__scheduler_enabled: 'false', DUCKVIEW__apps__enabled: 'false', LOG_LEVEL: 'silent' } });
  ctx = await createContext(cfg);
  admin = ctx.auth.principalFromUser((await ctx.auth.findByEmail('admin@test.local'))!, 'jwt', '127.0.0.1');
  const editor = await ctx.auth.createLocalUser({ email: 'editor@test.local', password: 'editor-secret-pw', role: 'USER' });
  wsId = (await ctx.workspaces.create(admin, { name: 'Shop', active_db_path: 'shop.duckdb' })).id;
  await ctx.workspaces.setMember(admin, wsId, { subject_type: 'user', subject_id: editor.id, role: 'EDITOR' });
  await sql(`CREATE TABLE customers AS SELECT * FROM (VALUES (1, 'ada@example.com', 'gold', 'EU', 1200.5), (2, 'bob@example.com', 'silver', 'US', 300.0), (3, 'cy@example.com', 'gold', 'US', 950.25)) t(id, email, tier, region, ltv)`);
  ({ app } = await buildApp(ctx));
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as net.AddressInfo).port}`;
  jwt = (await api('POST', '/api/auth/login', { email: 'admin@test.local', password: 'super-secret-pw' }, '')).json.token;
  editorJwt = (await api('POST', '/api/auth/login', { email: 'editor@test.local', password: 'editor-secret-pw' }, '')).json.token;
  sqliteId = (await api('POST', '/api/database-connections', { name: 'CRM', engine: 'sqlite', alias: 'crm', config: { path: 'crm.sqlite', read_only: false } })).json.connection.id;
}, 120_000);

afterAll(async () => {
  await app?.close();
  await ctx?.shutdown();
  receiver?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('reverse ETL', () => {
  it('validates what it sends and where', async () => {
    const make = (body: Record<string, unknown>) => api('POST', `/api/workspaces/${wsId}/reverse-syncs`, { name: 'x', sql: 'SELECT * FROM customers', ...body });
    expect((await make({ sql: 'DELETE FROM customers', destination: { kind: 'http', url: `${hook}/x` } })).json.message).toMatch(/only reads: DELETE/);
    expect((await make({ mode: 'upsert', destination: { kind: 'http', url: `${hook}/x` } })).json.message).toMatch(/upsert needs key_columns/);
    expect((await make({ mode: 'upsert', key_columns: ['id'], destination: { kind: 'file', format: 'csv', path: 'out/c.csv' } })).json.message).toMatch(/Files are replaced or appended/);
    expect((await make({ destination: { kind: 'file', format: 'csv', path: '../../etc/c.csv' } })).status).toBe(403);
    expect((await make({ destination: { kind: 'database', connection_id: 'nope', table: 't' } })).json.message).toMatch(/not one of your database connections/);
    const ro = (await api('POST', '/api/database-connections', { name: 'CRM read-only', engine: 'sqlite', alias: 'crm_ro', config: { path: 'crm.sqlite' } })).json.connection.id;
    expect((await make({ destination: { kind: 'database', connection_id: ro, table: 't' } })).json.message).toMatch(/is read-only — turn off read-only/);
    await (await DuckDBInstance.create(path.join(dataDir, 'wh2.duckdb'))).closeSync();
    const duck = (await api('POST', '/api/database-connections', { name: 'WH', engine: 'duckdb', alias: 'wh2', config: { path: 'wh2.duckdb', read_only: false } })).json.connection.id;
    expect((await make({ destination: { kind: 'database', connection_id: duck, table: 't' } })).json.message).toMatch(/DuckDB file cannot be a destination/);
    expect((await make({ destination: { kind: 'database', connection_id: sqliteId, table: 't' } })).status).toBe(200);
    // Another user's connection is not theirs to write to.
    expect((await api('POST', `/api/workspaces/${wsId}/reverse-syncs`, { name: 'y', sql: 'SELECT 1', destination: { kind: 'database', connection_id: sqliteId, table: 't' } }, editorJwt)).json.message).toMatch(/not one of your database connections/);
    for (const s of (await api('GET', `/api/workspaces/${wsId}/reverse-syncs`)).json.syncs) await api('DELETE', `/api/reverse-syncs/${s.id}`);
  });

  it('writes a SQLite table: replace, then upsert and mirror only what changed', async () => {
    const created = (await api('POST', `/api/workspaces/${wsId}/reverse-syncs`, { name: 'Customers to CRM', sql: 'SELECT id, email, tier, ltv FROM customers', destination: { kind: 'database', connection_id: sqliteId, table: 'customer_scores' }, mode: 'mirror', key_columns: ['id'] })).json.sync;
    // The plan: everything, nothing sent yet.
    expect((await api('GET', `/api/reverse-syncs/${created.id}/plan`)).json.plan).toMatchObject({ rows_read: 3, to_send: 3, to_delete: 0, columns: ['id', 'email', 'tier', 'ltv'], incremental: false, destination: 'CRM → customer_scores' });
    const first = await run(created.id);
    expect(first).toMatchObject({ status: 'ok', rows_read: 3, rows_sent: 3, rows_deleted: 0 });
    expect(first.summary).toMatch(/created main.customer_scores/);
    expect(await readSqlite('SELECT id, email, tier FROM crm.customer_scores ORDER BY id')).toEqual([[1, 'ada@example.com', 'gold'], [2, 'bob@example.com', 'silver'], [3, 'cy@example.com', 'gold']]);
    // Nothing changed: nothing written.
    expect(await run(created.id)).toMatchObject({ status: 'ok', rows_read: 3, rows_sent: 0, rows_deleted: 0 });
    // One changed, one new, one gone.
    await sql("UPDATE customers SET tier = 'platinum' WHERE id = 1; INSERT INTO customers VALUES (4, 'di@example.com', 'bronze', 'EU', 10.0); DELETE FROM customers WHERE id = 2");
    expect((await api('GET', `/api/reverse-syncs/${created.id}/plan`)).json.plan).toMatchObject({ rows_read: 3, to_send: 2, to_delete: 1, incremental: true });
    const third = await run(created.id);
    expect(third).toMatchObject({ status: 'ok', rows_sent: 2, rows_deleted: 1 });
    expect(await readSqlite('SELECT id, tier FROM crm.customer_scores ORDER BY id')).toEqual([[1, 'platinum'], [3, 'gold'], [4, 'bronze']]);
    // Append adds every row each run; replace re-creates the table.
    await api('PATCH', `/api/reverse-syncs/${created.id}`, { mode: 'append', key_columns: [] });
    expect(await run(created.id)).toMatchObject({ status: 'ok', rows_sent: 3 });
    expect(await readSqlite('SELECT count(*) FROM crm.customer_scores')).toEqual([[6]]);
    await api('PATCH', `/api/reverse-syncs/${created.id}`, { mode: 'replace', sql: "SELECT id, email FROM customers WHERE region = 'EU'" });
    expect(await run(created.id)).toMatchObject({ status: 'ok', rows_sent: 2 });
    expect(await readSqlite('SELECT * FROM crm.customer_scores ORDER BY id')).toEqual([[1, 'ada@example.com'], [4, 'di@example.com']]);
    // Keys must identify rows.
    await api('PATCH', `/api/reverse-syncs/${created.id}`, { mode: 'upsert', key_columns: ['region'], sql: 'SELECT id, region FROM customers' });
    const dup = await run(created.id);
    expect(dup.status).toBe('error');
    expect(dup.error).toMatch(/key columns \(region\) are not unique: 1 key appear/);
    const runs = (await api('GET', `/api/reverse-syncs/${created.id}/runs`)).json.runs;
    expect(runs.map((r: { status: string }) => r.status)).toEqual(['error', 'ok', 'ok', 'ok', 'ok', 'ok']);
    await api('DELETE', `/api/reverse-syncs/${created.id}`);
  });

  it('writes Parquet and CSV files, one per run when appending', async () => {
    const pq = (await api('POST', `/api/workspaces/${wsId}/reverse-syncs`, { name: 'Scores file', sql: 'SELECT id, ltv FROM customers ORDER BY id', destination: { kind: 'file', format: 'parquet', path: 'exports/scores.parquet' } })).json.sync;
    expect(await run(pq.id)).toMatchObject({ status: 'ok', rows_sent: 3 });
    expect((await sql(`SELECT count(*), sum(ltv) FROM read_parquet('exports/scores.parquet')`)).rows[0]).toEqual([3, 2160.75]);
    const csv = (await api('POST', `/api/workspaces/${wsId}/reverse-syncs`, { name: 'Daily CSV', sql: 'SELECT id, email FROM customers ORDER BY id', destination: { kind: 'file', format: 'csv', path: 'exports/daily/customers.csv' }, mode: 'append' })).json.sync;
    await run(csv.id);
    await new Promise((r) => setTimeout(r, 1100));
    await run(csv.id);
    const files = fs.readdirSync(path.join(dataDir, 'exports', 'daily'));
    expect(files).toHaveLength(2);
    expect(files.every((f) => /^customers_\d{8}T\d{6}Z\.csv$/.test(f))).toBe(true);
    expect(fs.readFileSync(path.join(dataDir, 'exports', 'daily', files[0]!), 'utf8').split('\n')[0]).toBe('id,email');
    for (const s of [pq, csv]) await api('DELETE', `/api/reverse-syncs/${s.id}`);
  });

  it('posts JSON batches to an API: changes only, deletions, headers, and a failed run retried in full', async () => {
    const channel = (await api('POST', `/api/workspaces/${wsId}/channels`, { name: 'ops', type: 'webhook', secret: { url: `${hook}/ops` } })).json.channel;
    const s = (await api('POST', `/api/workspaces/${wsId}/reverse-syncs`, { name: 'Customers to CRM API', sql: 'SELECT id, email, tier FROM customers', destination: { kind: 'http', url: `${hook}/crm`, batch_size: 2 }, mode: 'mirror', key_columns: ['id'], headers: { Authorization: 'Bearer crm-secret' }, channel_ids: [channel.id] })).json.sync;
    expect(s.header_names).toEqual(['Authorization']);
    expect(JSON.stringify(s)).not.toMatch(/crm-secret/);
    const first = await run(s.id);
    expect(first).toMatchObject({ status: 'ok', rows_sent: 3 });
    expect(first.summary).toMatch(/2 requests/);
    const batches = received.filter((r) => r.path === '/crm');
    expect(batches).toHaveLength(2);
    expect(batches[0]!.headers.authorization).toBe('Bearer crm-secret');
    expect(batches[0]!.headers['idempotency-key']).toMatch(/-1$/);
    expect(JSON.parse(batches[0]!.body)).toMatchObject({ sync: 'Customers to CRM API', mode: 'mirror', op: 'upsert', batch: 1, batches: 2, rows: [{ id: 1, email: 'ada@example.com', tier: 'platinum' }, { id: 3, email: 'cy@example.com', tier: 'gold' }] });
    // A change and a deletion; the API fails the first attempt: nothing is remembered, the next run sends it again.
    await sql("UPDATE customers SET tier = 'gold' WHERE id = 4; DELETE FROM customers WHERE id = 3");
    received.length = 0;
    failNext = 1;
    const failed = await run(s.id);
    expect(failed.status).toBe('error');
    expect(failed.error).toMatch(/The API answered 503 to batch 1 of 2: busy/);
    expect(bodies('/ops').some((b) => /reverse_sync\.failed/.test(b))).toBe(true);
    const retried = await run(s.id);
    expect(retried).toMatchObject({ status: 'ok', rows_sent: 1, rows_deleted: 1 });
    const sent = bodies('/crm').slice(-2).map((b) => JSON.parse(b));
    expect(sent.map((b) => [b.op, b.rows])).toEqual([['upsert', [{ id: 4, email: 'di@example.com', tier: 'gold' }]], ['delete', [{ id: 3 }]]]);
    expect(bodies('/ops').some((b) => /reverse_sync\.recovered/.test(b))).toBe(true);
    // Other payload shapes.
    await api('PATCH', `/api/reverse-syncs/${s.id}`, { destination: { kind: 'http', url: `${hook}/nd`, payload: 'ndjson' }, mode: 'replace', key_columns: [] });
    await run(s.id);
    expect(bodies('/nd')[0]!.trim().split('\n').map((l) => JSON.parse(l).id)).toEqual([1, 4]);
    await api('DELETE', `/api/reverse-syncs/${s.id}`);
  });

  it('sends only what the author may see', async () => {
    await ctx.policies.create(admin, wsId, { name: 'Editors: EU, no email', table_name: 'customers', row_filter: "region = 'EU'", column_masks: { email: { kind: 'redact' } }, applies_to: { roles: ['EDITOR'] } });
    const s = (await api('POST', `/api/workspaces/${wsId}/reverse-syncs`, { name: 'Editor export', sql: 'SELECT id, email FROM customers ORDER BY id', destination: { kind: 'http', url: `${hook}/editor`, payload: 'array' } }, editorJwt)).json.sync;
    expect(await run(s.id, editorJwt)).toMatchObject({ status: 'ok', rows_sent: 2 });
    const rows = JSON.parse(bodies('/editor')[0]!);
    expect(rows.map((r: { id: number }) => r.id)).toEqual([1, 4]);
    expect(rows.every((r: { email: string }) => !r.email.includes('@'))).toBe(true);
    await api('DELETE', `/api/reverse-syncs/${s.id}`);
  });

  it('asks a person before an agent sends data out, and leaves the schedule to people', async () => {
    const env: ToolEnv = { ctx, principal: ctx.auth.principalFromUser((await ctx.auth.findByEmail('admin@test.local'))!, 'token'), via: 'mcp', defaultWorkspaceId: wsId, agent: null };
    const tools = buildTools(ctx.cfg);
    const call = (name: string, args: Record<string, unknown>) => runTool(env, tools.find((t) => t.name === name)!, args);
    const listed = await call('list_reverse_syncs', {});
    expect((listed.structuredContent as { writable_databases: { id: string }[] }).writable_databases.map((d) => d.id)).toContain(sqliteId);
    const created = await call('create_reverse_sync', { name: 'Agent sync', sql: 'SELECT id, tier FROM customers', destination: { kind: 'http', url: `${hook}/agent` } });
    const id = (created.structuredContent as { sync_id: string }).sync_id;
    expect((created.content[0] as { text: string }).text).toMatch(/would send 2 of 2 rows/);
    const blocked = await call('run_reverse_sync', { sync_id: id });
    expect(blocked.structuredContent).toMatchObject({ status: 'approval_required' });
    expect(JSON.stringify(blocked.structuredContent)).toMatch(/would send 2 rows out of the workspace to POST http/);
    expect(bodies('/agent')).toHaveLength(0);
    expect((await call('run_reverse_sync', { sync_id: id, dry_run: false })).structuredContent).toMatchObject({ status: 'ok', rows_sent: 2 });
    expect(bodies('/agent')).toHaveLength(1);
    await expect(ctx.reverse.update(env.principal, id, { schedule: { kind: 'interval', minutes: 60 } })).rejects.toThrow(/a person sets one/);
    // The scheduler runs what a person scheduled.
    await api('PATCH', `/api/reverse-syncs/${id}`, { schedule: { kind: 'interval', minutes: 60 } });
    expect(await ctx.reverse.tick(new Date(Date.now() + 61 * 60_000))).toEqual([id]);
    expect(bodies('/agent')).toHaveLength(2);
    expect((await api('GET', `/api/reverse-syncs/${id}/runs`)).json.runs[0].triggered_by).toBe('schedule');
    // DuckView AI knows what leaves the workspace.
    const snap = await ctx.copilot.buildContext(admin, wsId);
    expect(snap.reverse).toMatch(/- Agent sync: replace → POST http:\/\/127\.0\.0\.1:\d+\/agent; last run ok: 2 rows sent/);
    expect(ctx.copilot.renderContextText(snap)).toMatch(/### Reverse ETL/);
  });
});
