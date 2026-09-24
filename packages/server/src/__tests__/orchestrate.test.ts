/**
 * Orchestration over HTTP, the way Airflow, Dagster and Prefect call it: start a run (a sync, a quality suite, a
 * SQL check), wait for it or long-poll its status, failures as failures, the write scope, and runs that belong to
 * whoever started them. The Python operators and tasks (packages/sdk-python) run against the same server.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config/index.js';
import { initLogger } from '../observability/logger.js';
import { createContext, type AppContext } from '../context.js';
import { buildApp } from '../app.js';
import type { Principal } from '../services/principal.js';

let dir: string;
let ctx: AppContext;
let app: Awaited<ReturnType<typeof buildApp>>['app'];
let base: string;
let wsId: string;
let admin: Principal;
let writeToken: string;
let readToken: string;
let otherToken: string;
let syncId: string;
let suiteId: string;
const here = path.dirname(fileURLToPath(import.meta.url));

const call = async (token: string, method: string, url: string, body?: unknown) => {
  const r = await fetch(`${base}${url}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: (await r.json()) as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
};

beforeAll(async () => {
  initLogger({ level: 'silent', stderr: true, pretty: false });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dv-orchestrate-'));
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  const cfg = loadConfig({ configPath: null, env: { DUCKVIEW_DATA_DIR: path.join(dir, 'data'), DUCKDB_TEMP_DIRECTORY: path.join(dir, 'spill'), DATABASE_URL: ':memory:', DUCKDB_MEMORY_LIMIT: '512MB', DUCKVIEW_ADMIN_EMAIL: 'admin@test.local', DUCKVIEW_ADMIN_PASSWORD: 'super-secret-pw', DUCKVIEW__duckdb__sync_scheduler_enabled: 'false', DUCKVIEW__notifications__scheduler_enabled: 'false', DUCKVIEW__transform__scheduler_enabled: 'false', DUCKVIEW__apps__enabled: 'false', LOG_LEVEL: 'silent' } });
  ctx = await createContext(cfg);
  const adminUser = (await ctx.auth.findByEmail('admin@test.local'))!;
  admin = ctx.auth.principalFromUser(adminUser, 'jwt', '127.0.0.1');
  wsId = (await ctx.workspaces.create(admin, { name: 'Pipelines', active_db_path: 'pipelines.duckdb' })).id;
  await ctx.queries.run(admin, wsId, "CREATE TABLE raw_orders AS SELECT * FROM (VALUES (1, 'EU', 10.0), (2, 'US', NULL), (3, 'EU', 30.0)) t(id, region, amount)", { cache: false });
  syncId = (await ctx.syncs.create(admin, wsId, { name: 'Orders staging', source: { kind: 'sql', sql: 'SELECT * FROM raw_orders' }, target_table: 'stg_orders' })).id;
  suiteId = (await ctx.quality.create(admin, wsId, { name: 'Orders checks', relation: 'raw_orders', checks: [{ id: 'amount_nn', type: 'not_null', column: 'amount' }] as never })).id;
  writeToken = (await ctx.auth.createToken(adminUser, { name: 'airflow', scopes: ['read', 'write'] })).token;
  readToken = (await ctx.auth.createToken(adminUser, { name: 'read', scopes: ['read'] })).token;
  const other = await ctx.auth.createLocalUser({ email: 'other@test.local', password: 'other-secret-pw', role: 'USER' });
  otherToken = (await ctx.auth.createToken(other, { name: 'other', scopes: ['read', 'write'] })).token;
  ({ app } = await buildApp(ctx));
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as net.AddressInfo).port}`;
}, 120_000);

afterAll(async () => {
  await app?.close();
  await ctx?.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('orchestration API', () => {
  it('runs a sync and waits for it', async () => {
    const r = await call(writeToken, 'POST', '/api/orchestrate/runs', { kind: 'sync', id: syncId, wait: true, source: 'airflow', external_run_id: 'manual__2026-09-24' });
    expect(r.status).toBe(200);
    expect(r.json.run).toMatchObject({ kind: 'sync', label: 'Orders staging', status: 'succeeded', summary: '3 rows loaded', source: 'airflow', external_run_id: 'manual__2026-09-24', workspace_id: wsId });
    expect((await ctx.queries.run(admin, wsId, 'SELECT count(*) FROM stg_orders', { cache: false })).rows[0]).toEqual([3]);
  });

  it('starts in the background and long-polls; a failing check fails the run', async () => {
    const started = await call(writeToken, 'POST', '/api/orchestrate/runs', { kind: 'quality', id: suiteId });
    expect(started.status).toBe(202);
    expect(started.json.run.status).toBe('running');
    const done = await call(writeToken, 'GET', `/api/orchestrate/runs/${started.json.run.id}?wait=30`);
    expect(done.json.run).toMatchObject({ status: 'failed', detail: { status: 'fail', failing: [expect.objectContaining({ status: 'fail' })] } });
    // SQL checks: rows mean trouble, or no rows do.
    const bad = await call(writeToken, 'POST', '/api/orchestrate/runs', { kind: 'query', id: wsId, sql: 'SELECT * FROM raw_orders WHERE amount IS NULL', fail_if: 'rows', wait: true });
    expect(bad.json.run).toMatchObject({ status: 'failed', summary: '1 row (expected none)' });
    const good = await call(writeToken, 'POST', '/api/orchestrate/runs', { kind: 'query', id: wsId, sql: "SELECT * FROM raw_orders WHERE region = 'EU'", fail_if: 'no_rows', wait: true });
    expect(good.json.run).toMatchObject({ status: 'succeeded', summary: '2 rows' });
    const broken = await call(writeToken, 'POST', '/api/orchestrate/runs', { kind: 'query', id: wsId, sql: 'SELECT * FROM nope', wait: true });
    expect(broken.json.run.status).toBe('failed');
    expect(broken.json.run.summary).toMatch(/nope/);
  });

  it('needs the write scope, and keeps runs to their owner', async () => {
    expect((await call(readToken, 'POST', '/api/orchestrate/runs', { kind: 'sync', id: syncId })).status).toBe(403);
    expect((await call(otherToken, 'POST', '/api/orchestrate/runs', { kind: 'sync', id: syncId })).status).toBe(404);
    expect((await call(writeToken, 'POST', '/api/orchestrate/runs', { kind: 'sync', id: 'missing' })).status).toBe(404);
    const mine = (await call(writeToken, 'GET', '/api/orchestrate/runs')).json.runs as { id: string }[];
    expect(mine.length).toBeGreaterThanOrEqual(4);
    expect((await call(otherToken, 'GET', `/api/orchestrate/runs/${mine[0]!.id}`)).status).toBe(404);
  });

  it('drives the Python operators and tasks (Airflow, Dagster, Prefect) against the server', async () => {
    const script = path.resolve(here, '../../../sdk-python/tests/test_orchestrate.py');
    const out = await new Promise<{ code: number | null; text: string }>((resolve) => {
      const c = spawn('python3', [script], { env: { PATH: process.env.PATH, HOME: process.env.HOME, DUCKVIEW_URL: base, DUCKVIEW_TOKEN: writeToken, DUCKVIEW_WORKSPACE: wsId, DV_SYNC_ID: syncId, DV_SUITE_ID: suiteId } });
      let text = '';
      c.stdout.on('data', (d) => (text += d));
      c.stderr.on('data', (d) => (text += d));
      c.on('close', (code) => resolve({ code, text }));
    });
    expect(out.text).toContain('OK');
    expect(out.code, out.text).toBe(0);
  }, 120_000);
});
