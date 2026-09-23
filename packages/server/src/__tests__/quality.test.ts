/**
 * Data quality: each check type against a table with known problems, tolerance and severity, suggestions from the
 * data, suites run by people, agents and the scheduler, notifications on a changed status and on recovery, access
 * (viewers read, editors define and run), the MCP tools, Copilot's context, and dbt test results alongside.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../config/index.js';
import { initLogger } from '../observability/logger.js';
import { createContext, type AppContext } from '../context.js';
import { buildApp } from '../app.js';
import { buildTools, runTool, type ToolEnv } from '../agent/tools.js';
import { compileCheck, quoteRelation } from '../services/quality.js';
import type { Principal } from '../services/principal.js';

const hasPython = (() => {
  try {
    execFileSync('python3', ['--version']);
    return true;
  } catch {
    return false;
  }
})();

let dir: string;
let ctx: AppContext;
let app: Awaited<ReturnType<typeof buildApp>>['app'];
let receiver: http.Server;
let hook: string;
const received: { path: string; body: Record<string, any> }[] = [];
let base: string;
let jwt: string;
let viewerJwt: string;
let wsId: string;
let admin: Principal;

const api = async (method: string, url: string, body?: unknown, token = jwt) => {
  const res = await fetch(base + url, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
};
const sql = (s: string) => ctx.queries.run(admin, wsId, s, { cache: false });

const CHECKS = [
  { id: 'ids', type: 'unique', column: 'order_id' },
  { id: 'customer', type: 'not_null', column: 'customer_id' },
  { id: 'status', type: 'accepted_values', column: 'status', values: ['complete', 'cancelled', 'pending'] },
  { id: 'amount', type: 'range', column: 'amount', min: 0 },
  { id: 'fk', type: 'relationships', column: 'customer_id', to: 'customers', to_column: 'customer_id' },
  { id: 'expr', type: 'expression', expression: "status <> 'complete' OR amount > 0", severity: 'warn' },
  { id: 'rows', type: 'row_count', min: 5, max: 100 },
  { id: 'fresh', type: 'freshness', column: 'ordered_at', max_age_hours: 48 },
  { id: 'custom', type: 'custom_sql', sql: 'SELECT * FROM {{ table }} WHERE amount > 1000' },
];

beforeAll(async () => {
  initLogger({ level: 'silent', stderr: true, pretty: false });
  receiver = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      received.push({ path: req.url!, body: JSON.parse(body || '{}') });
      res.writeHead(200);
      res.end('ok');
    });
  });
  await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
  hook = `http://127.0.0.1:${(receiver.address() as net.AddressInfo).port}`;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dv-quality-'));
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  const cfg = loadConfig({ configPath: null, env: { DUCKVIEW_DATA_DIR: path.join(dir, 'data'), DUCKDB_TEMP_DIRECTORY: path.join(dir, 'spill'), DATABASE_URL: ':memory:', DUCKDB_MEMORY_LIMIT: '512MB', DUCKVIEW_ADMIN_EMAIL: 'admin@test.local', DUCKVIEW_ADMIN_PASSWORD: 'super-secret-pw', DUCKVIEW__duckdb__sync_scheduler_enabled: 'false', DUCKVIEW__notifications__scheduler_enabled: 'false', DUCKVIEW__notifications__allow_private_targets: 'true', DUCKVIEW__transform__scheduler_enabled: 'false', DUCKVIEW__apps__enabled: 'false', DUCKVIEW__transform__dbt__venv_dir: process.env.DUCKVIEW_TEST_DBT_VENV ?? path.join(os.tmpdir(), 'duckview-test-dbt-venv'), LOG_LEVEL: 'silent' } });
  ctx = await createContext(cfg);
  admin = ctx.auth.principalFromUser((await ctx.auth.findByEmail('admin@test.local'))!, 'jwt', '127.0.0.1');
  const viewer = await ctx.auth.createLocalUser({ email: 'viewer@test.local', password: 'viewer-secret-pw', role: 'USER' });
  wsId = (await ctx.workspaces.create(admin, { name: 'Shop', active_db_path: 'shop.duckdb' })).id;
  await ctx.workspaces.setMember(admin, wsId, { subject_type: 'user', subject_id: viewer.id, role: 'VIEWER' });
  // Problems on purpose: a duplicated order id, a null and an unknown customer, a bad status, a negative and a huge
  // amount, a complete order of 0, and the newest order three days old.
  await sql(`CREATE TABLE customers AS SELECT * FROM (VALUES (1, 'gold'), (2, 'silver'), (3, 'gold')) t(customer_id, tier);
    CREATE TABLE orders AS SELECT order_id, customer_id, status, amount, now()::TIMESTAMP - to_days(d) AS ordered_at FROM (VALUES
      (1, 1, 'complete', 120.0, 10),
      (2, 2, 'complete', 80.0, 9),
      (2, 3, 'pending', 50.0, 8),
      (3, NULL, 'complete', 30.0, 7),
      (4, 9, 'complete', 2000.0, 6),
      (5, 1, 'refunded', -5.0, 5),
      (6, 2, 'complete', 0.0, 3)) t(order_id, customer_id, status, amount, d)`);
  ({ app } = await buildApp(ctx));
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as net.AddressInfo).port}`;
  jwt = (await api('POST', '/api/auth/login', { email: 'admin@test.local', password: 'super-secret-pw' }, '')).json.token;
  viewerJwt = (await api('POST', '/api/auth/login', { email: 'viewer@test.local', password: 'viewer-secret-pw' }, '')).json.token;
}, 120_000);

afterAll(async () => {
  await app?.close();
  await ctx?.shutdown();
  receiver?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('data quality', () => {
  it('quotes relations and compiles every check to one SELECT of the failing rows', () => {
    expect(quoteRelation('orders')).toBe('"orders"');
    expect(quoteRelation('analytics.orders')).toBe('"analytics"."orders"');
    expect(quoteRelation('"my db"."sch"."Order ""x"""')).toBe('"my db"."sch"."Order ""x"""');
    expect(() => quoteRelation('orders; drop table x')).toThrow(/not a table name/);
    expect(() => quoteRelation('a.b.c.d')).toThrow(/not a table name/);
    expect(compileCheck({ id: 'x', type: 'not_null', column: 'email', severity: 'error', where: "country = 'NL'" }, '"users"').failing).toBe(`SELECT * FROM "users" WHERE (country = 'NL') AND "email" IS NULL`);
    expect(compileCheck({ id: 'x', type: 'unique', column: 'id', severity: 'error' }, '"users"').failing).toMatch(/GROUP BY "id" HAVING count\(\*\) > 1/);
  });

  it('runs each check type and finds exactly the rows that break it', async () => {
    const r = await api('POST', `/api/workspaces/${wsId}/quality/preview`, { relation: 'orders', checks: CHECKS });
    expect(r.status).toBe(200);
    const by = Object.fromEntries((r.json.results as { check_id: string }[]).map((x) => [x.check_id, x])) as Record<string, any>;
    expect(by.ids).toMatchObject({ status: 'fail', failures: 1, rows: 7 });
    expect(by.ids.sample.rows).toEqual([[2, 2]]);
    expect(by.customer).toMatchObject({ status: 'fail', failures: 1 });
    expect(by.status).toMatchObject({ status: 'fail', failures: 1 });
    expect(by.status.sample.rows[0]).toContain('refunded');
    expect(by.amount).toMatchObject({ status: 'fail', failures: 1, observed: '-5.0 … 2000.0' });
    expect(by.fk).toMatchObject({ status: 'fail', failures: 1 });
    expect(by.fk.sample.rows[0][1]).toBe(9);
    // A warning, not a failure.
    expect(by.expr).toMatchObject({ status: 'warn', failures: 1 });
    expect(by.rows).toMatchObject({ status: 'pass', failures: 0, observed: '7' });
    expect(by.fresh.status).toBe('fail');
    expect(by.fresh.message).toMatch(/older than 48h/);
    expect(by.custom).toMatchObject({ status: 'fail', failures: 1 });
    expect(r.json.status).toBe('fail');
    expect(r.json.summary).toBe('1 of 9 passed, 7 failed, 1 warning.');
    // The SQL of a failing check runs as is in the workbench.
    expect((await sql(by.customer.sql)).rows).toHaveLength(1);
  });

  it('honours tolerance, where and severity, and reports checks that cannot run', async () => {
    const r = (await api('POST', `/api/workspaces/${wsId}/quality/preview`, {
      relation: 'orders',
      checks: [
        { id: 'tolerated', type: 'not_null', column: 'customer_id', tolerance: 1 },
        { id: 'scoped', type: 'range', column: 'amount', min: 0, where: "status = 'complete'" },
        { id: 'warned', type: 'accepted_values', column: 'status', values: ['complete'], severity: 'warn' },
        { id: 'broken', type: 'not_null', column: 'nope' },
      ],
    })).json;
    const by = Object.fromEntries((r.results as { check_id: string }[]).map((x) => [x.check_id, x])) as Record<string, any>;
    expect(by.tolerated).toMatchObject({ status: 'pass', failures: 1 });
    expect(by.tolerated.message).toMatch(/within the tolerance of 1/);
    expect(by.scoped).toMatchObject({ status: 'pass', rows: 5 });
    expect(by.warned).toMatchObject({ status: 'warn', failures: 2 });
    expect(by.broken.status).toBe('error');
    expect(by.broken.message).toMatch(/nope/);
    expect(r.status).toBe('error');
    // Invalid definitions and statements that write are refused.
    expect((await api('POST', `/api/workspaces/${wsId}/quality/preview`, { relation: 'orders', checks: [{ type: 'range', column: 'amount' }] })).json.message).toMatch(/set min, max or both/);
    const write = (await api('POST', `/api/workspaces/${wsId}/quality/preview`, { relation: 'orders', checks: [{ id: 'w', type: 'custom_sql', sql: 'DELETE FROM orders' }] })).json;
    expect(write.results[0]).toMatchObject({ status: 'error' });
    expect(write.results[0].message).toMatch(/only reads/);
    expect((await sql('SELECT count(*) FROM orders')).rows[0]![0]).toBe(7);
  });

  it('lets an administrator check a workspace they do not own', async () => {
    const viewer = ctx.auth.principalFromUser((await ctx.auth.findByEmail('viewer@test.local'))!, 'jwt', '127.0.0.1');
    const own = (await ctx.workspaces.create(viewer, { name: 'Viewer own', active_db_path: 'viewer-own.duckdb' })).id;
    await ctx.queries.run(viewer, own, 'CREATE TABLE t AS SELECT 1 AS a', { cache: false });
    const r = (await api('POST', `/api/workspaces/${own}/quality/preview`, { relation: 't', checks: [{ type: 'not_null', column: 'a' }] })).json;
    expect(r).toMatchObject({ status: 'pass', summary: '1 of 1 passed.' });
    // Saved, it runs as its author (the administrator) too.
    const suite = (await api('POST', `/api/workspaces/${own}/quality/suites`, { relation: 't', checks: [{ type: 'not_null', column: 'a' }] })).json.suite;
    expect((await api('POST', `/api/quality/suites/${suite.id}/run`, {})).json.run).toMatchObject({ status: 'pass' });
    await ctx.workspaces.remove(viewer, own).catch(() => undefined);
  });

  it('suggests the checks the data satisfies today', async () => {
    const checks = (await api('POST', `/api/workspaces/${wsId}/quality/suggest`, { relation: 'customers' })).json.checks as Record<string, any>[];
    expect(checks.map((c) => `${c.type}:${c.column ?? ''}`)).toEqual(['row_count:', 'not_null:customer_id', 'unique:customer_id', 'not_null:tier']);
    const orders = (await api('POST', `/api/workspaces/${wsId}/quality/suggest`, { relation: 'orders' })).json.checks as Record<string, any>[];
    expect(orders.find((c) => c.type === 'accepted_values')).toMatchObject({ column: 'status', values: ['complete', 'pending', 'refunded'] });
    expect(orders.find((c) => c.type === 'relationships')).toMatchObject({ column: 'customer_id', to: 'customers', to_column: 'customer_id' });
    // Every suggestion passes on the data it came from.
    expect((await api('POST', `/api/workspaces/${wsId}/quality/preview`, { relation: 'customers', checks })).json.status).toBe('pass');
    expect((await api('POST', `/api/workspaces/${wsId}/quality/suggest`, { relation: 'nope' })).json.message).toMatch(/No table nope/);
    // Prefixed names: stg_orders' own key is order_id, and customer_id points at stg_customers.
    await sql('CREATE TABLE stg_customers AS SELECT * FROM customers; CREATE TABLE stg_orders AS SELECT DISTINCT ON (order_id) order_id, 1 AS customer_id FROM orders');
    const stg = (await api('POST', `/api/workspaces/${wsId}/quality/suggest`, { relation: 'stg_orders' })).json.checks as Record<string, any>[];
    expect(stg.map((c) => `${c.type}:${c.column ?? ''}${c.to ? `>${c.to}` : ''}`)).toEqual(expect.arrayContaining(['unique:order_id', 'relationships:customer_id>stg_customers']));
    await sql('DROP TABLE stg_orders; DROP TABLE stg_customers');
  });

  it('saves suites, runs them, and notifies when the status changes and when it recovers', async () => {
    const channel = (await api('POST', `/api/workspaces/${wsId}/channels`, { name: 'data team', type: 'webhook', secret: { url: `${hook}/quality` } })).json.channel;
    expect((await api('POST', `/api/workspaces/${wsId}/quality/suites`, { relation: 'orders', checks: CHECKS }, viewerJwt)).status).toBe(403);
    const created = await api('POST', `/api/workspaces/${wsId}/quality/suites`, { name: 'Orders', relation: 'orders', checks: [{ id: 'customer', type: 'not_null', column: 'customer_id' }, { id: 'rows', type: 'row_count', min: 1 }], channel_ids: [channel.id], schedule: { kind: 'interval', minutes: 60 } });
    expect(created.status).toBe(200);
    const suite = created.json.suite;
    expect(suite).toMatchObject({ status: 'unknown', relation: 'orders' });
    expect(suite.next_run_at).toBeTruthy();
    // Viewers read, they do not run.
    expect((await api('POST', `/api/quality/suites/${suite.id}/run`, {}, viewerJwt)).status).toBe(403);
    expect((await api('GET', `/api/workspaces/${wsId}/quality/suites`, undefined, viewerJwt)).json.suites).toHaveLength(1);

    const first = (await api('POST', `/api/quality/suites/${suite.id}/run`, {})).json;
    expect(first).toMatchObject({ changed: true, suite: { status: 'fail' }, run: { status: 'fail', summary: '1 of 2 passed, 1 failed.', notified: 1, triggered_by: 'manual' } });
    const failing = received.filter((x) => x.path === '/quality');
    expect(failing).toHaveLength(1);
    expect(JSON.stringify(failing[0]!.body)).toMatch(/quality\.fail/);
    expect(JSON.stringify(failing[0]!.body)).toMatch(/customer_id is never null/);
    // Same status again: nothing delivered.
    expect((await api('POST', `/api/quality/suites/${suite.id}/run`, {})).json).toMatchObject({ changed: false, run: { notified: 0 } });
    // Fixed data: resolved.
    await sql('UPDATE orders SET customer_id = 3 WHERE customer_id IS NULL');
    const fixed = (await api('POST', `/api/quality/suites/${suite.id}/run`, {})).json;
    expect(fixed).toMatchObject({ changed: true, run: { status: 'pass', notified: 1 } });
    expect(JSON.stringify(received.at(-1)!.body)).toMatch(/quality\.resolved/);
    // History and the latest run.
    const runs = (await api('GET', `/api/quality/suites/${suite.id}/runs`)).json.runs;
    expect(runs.map((r: { status: string }) => r.status)).toEqual(['pass', 'fail', 'fail']);
    expect((await api('GET', `/api/quality/suites/${suite.id}`)).json.latest).toMatchObject({ status: 'pass', results: [{ check_id: 'customer', status: 'pass' }, { check_id: 'rows', status: 'pass' }] });
    expect((await api('GET', `/api/quality/runs/${runs[1].id}`)).json.run.results[0]).toMatchObject({ status: 'fail', failures: 1 });
    await sql('UPDATE orders SET customer_id = NULL WHERE order_id = 3');

    // The scheduler runs what is due.
    const ran = await ctx.quality.tick(new Date(Date.now() + 61 * 60_000));
    expect(ran).toEqual([suite.id]);
    expect((await api('GET', `/api/quality/suites/${suite.id}`)).json.suite).toMatchObject({ status: 'fail' });
    expect((await api('GET', `/api/quality/suites/${suite.id}/runs`)).json.runs[0].triggered_by).toBe('schedule');

    // Editing checks keeps the suite; bad edits are refused.
    expect((await api('PATCH', `/api/quality/suites/${suite.id}`, { checks: [{ type: 'accepted_values', column: 'status' }] })).json.message).toMatch(/values is required/);
    const edited = (await api('PATCH', `/api/quality/suites/${suite.id}`, { checks: CHECKS, schedule: { kind: 'manual' } })).json.suite;
    expect(edited.checks).toHaveLength(9);
    expect(edited.next_run_at).toBeNull();
  });

  it('serves quality to agents and to Copilot', async () => {
    const env: ToolEnv = { ctx, principal: ctx.auth.principalFromUser((await ctx.auth.findByEmail('admin@test.local'))!, 'token'), via: 'mcp', defaultWorkspaceId: wsId, agent: null };
    const tools = buildTools(ctx.cfg);
    const call = (name: string, args: Record<string, unknown>) => runTool(env, tools.find((t) => t.name === name)!, args);
    const suggested = await call('suggest_quality_checks', { table: 'customers' });
    expect((suggested.structuredContent as { checks: unknown[] }).checks).toHaveLength(4);
    // Without checks: the suggestions, saved and run once.
    const created = await call('create_quality_suite', { table: 'customers' });
    expect(created.structuredContent).toMatchObject({ status: 'ok', result: 'pass' });
    const suiteId = (created.structuredContent as { suite_id: string }).suite_id;
    expect((await call('run_quality_suite', { suite_id: suiteId })).structuredContent).toMatchObject({ result: 'pass', changed: false });
    const orders = (await ctx.quality.list(admin, wsId)).find((s) => s.name === 'Orders')!;
    expect((await call('run_quality_suite', { suite_id: orders.id })).structuredContent).toMatchObject({ result: 'fail', summary: '1 of 9 passed, 7 failed, 1 warning.' });
    const listed = await call('list_quality_suites', {});
    const suites = (listed.structuredContent as { suites: { name: string; status: string; failing: { label: string }[] }[] }).suites;
    expect(suites.map((s) => [s.name, s.status])).toEqual([['customers quality', 'pass'], ['Orders', 'fail']]);
    expect(suites[1]!.failing.map((f) => f.label)).toContain('customer_id is never null');
    expect((listed.content[0] as { text: string }).text).toMatch(/fail: order_id is unique — 1 duplicated value/);

    const snap = await ctx.copilot.buildContext(admin, wsId);
    expect(snap.quality).toMatch(/- Orders \(table orders, 9 checks\): fail/);
    expect(ctx.copilot.renderContextText(snap)).toMatch(/### Data quality checks/);
  });

  it.skipIf(!hasPython)('shows the latest dbt test results alongside', async () => {
    const files = {
      'dbt_project.yml': "name: shop_quality\nversion: '1.0'\nprofile: duckview\n",
      'models/stg_orders.sql': 'select order_id, customer_id from orders\n',
      'models/schema.yml': 'version: 2\nmodels:\n  - name: stg_orders\n    columns:\n      - name: order_id\n        data_tests: [unique]\n      - name: customer_id\n        data_tests: [not_null]\n',
    };
    const project = (await api('POST', `/api/workspaces/${wsId}/dbt/projects`, { name: 'Shop quality', files })).json.project;
    const run = (await api('POST', `/api/dbt/projects/${project.id}/runs`, { command: 'build', wait: true })).json.run;
    expect(run.status).toBe('error');
    const dbtTests = (await api('GET', `/api/workspaces/${wsId}/quality/suites`)).json.dbt_tests;
    expect(dbtTests).toHaveLength(1);
    expect(dbtTests[0]).toMatchObject({ project_name: 'Shop quality', run_id: run.id });
    expect(dbtTests[0].tests.map((t: { status: string; failures: number }) => [t.status, t.failures]).sort()).toEqual([['fail', 1], ['fail', 1]]);
  }, 900_000);
});
