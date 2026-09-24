/**
 * The template marketplace: every built-in template installs into an empty workspace with its sample data and its
 * queries, checks and metrics run; installs map tables, refuse what does not fit and undo a half install; they can be
 * removed; people publish templates from a workspace (reviewed before everyone sees them), export and import them,
 * and agents install them.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../config/index.js';
import { initLogger } from '../observability/logger.js';
import { createContext, type AppContext } from '../context.js';
import { buildApp } from '../app.js';
import type { Principal } from '../services/principal.js';
import { BUILTIN_TEMPLATES } from '../templates/builtin.js';
import { fillTables, validateBody } from '../services/templates.js';

let dir: string;
let ctx: AppContext;
let app: Awaited<ReturnType<typeof buildApp>>['app'];
let base: string;
let admin: Principal;
let author: Principal;
let other: Principal;
let authorJwt: string;
let otherJwt: string;
let adminJwt: string;

const api = async (method: string, url: string, token: string, body?: unknown) => {
  const r = await fetch(`${base}${url}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
};

beforeAll(async () => {
  initLogger({ level: 'silent', stderr: true, pretty: false });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dv-templates-'));
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  const cfg = loadConfig({ configPath: null, env: { DUCKVIEW_DATA_DIR: path.join(dir, 'data'), DUCKDB_TEMP_DIRECTORY: path.join(dir, 'spill'), DATABASE_URL: ':memory:', DUCKDB_MEMORY_LIMIT: '512MB', DUCKVIEW_ADMIN_EMAIL: 'admin@test.local', DUCKVIEW_ADMIN_PASSWORD: 'super-secret-pw', DUCKVIEW__duckdb__sync_scheduler_enabled: 'false', DUCKVIEW__notifications__scheduler_enabled: 'false', DUCKVIEW__transform__scheduler_enabled: 'false', DUCKVIEW__apps__enabled: 'false', LOG_LEVEL: 'silent' } });
  ctx = await createContext(cfg);
  admin = ctx.auth.principalFromUser((await ctx.auth.findByEmail('admin@test.local'))!, 'jwt', '127.0.0.1');
  author = ctx.auth.principalFromUser(await ctx.auth.createLocalUser({ email: 'author@test.local', password: 'author-secret-pw', role: 'USER' }), 'jwt', '127.0.0.1');
  other = ctx.auth.principalFromUser(await ctx.auth.createLocalUser({ email: 'other@test.local', password: 'other-secret-pw', role: 'USER' }), 'jwt', '127.0.0.1');
  ({ app } = await buildApp(ctx));
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as net.AddressInfo).port}`;
  const login = async (email: string, password: string) => ((await (await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) })).json()) as { token: string }).token;
  adminJwt = await login('admin@test.local', 'super-secret-pw');
  authorJwt = await login('author@test.local', 'author-secret-pw');
  otherJwt = await login('other@test.local', 'other-secret-pw');
}, 120_000);

afterAll(async () => {
  await app?.close();
  await ctx?.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
});

const run = async (p: Principal, ws: string, sql: string) => (await ctx.queries.run(p, ws, sql, { cache: false })).rows;

describe('template marketplace', () => {
  it('ships built-in templates that are well formed', () => {
    for (const t of BUILTIN_TEMPLATES) expect(() => validateBody(t.body), t.name).not.toThrow();
    expect(fillTables('SELECT * FROM {{table:orders}} JOIN {{ table:customers }}', { orders: 'sales.orders', customers: 'My Customers' })).toBe('SELECT * FROM sales.orders JOIN "My Customers"');
    expect(() => validateBody({ tables: [], queries: [{ key: 'a', name: 'a', sql: 'SELECT * FROM {{table:ghost}}' }] })).toThrow(/does not declare: ghost/);
    expect(() => validateBody({ tables: [{ name: 't', columns: [], sample_sql: 'SELECT 1; DROP TABLE users' }] })).toThrow(/must be one SELECT/);
  });

  it.each(BUILTIN_TEMPLATES.map((t) => [t.name, t.id]))('installs %s into an empty workspace with sample data', async (_name, id) => {
    const ws = (await ctx.workspaces.create(author, { name: `Try ${id}`, active_db_path: ':memory:' })).id;
    const t = BUILTIN_TEMPLATES.find((x) => x.id === id)!;
    const before = await ctx.templates.check(author, id, ws);
    expect(before.every((x) => !x.exists && x.has_sample)).toBe(true);
    const { created } = await ctx.templates.install(author, id, { workspace_id: ws, sample_data: true });
    expect(created.tables.length).toBe(t.body.tables.length);
    expect(created.queries.length).toBe(t.body.queries.length);
    expect(created.dashboards.length).toBe(t.body.dashboards.length);
    expect(created.notebooks.length).toBe(t.body.notebooks.length);
    expect(created.quality.length).toBe(t.body.quality.length);
    // Every saved query runs and returns rows.
    for (const q of await ctx.savedQueries.list(author, ws)) expect((await run(author, ws, q.sql_text)).length, q.name).toBeGreaterThan(0);
    // Dashboards carry their widgets, laid out on the grid.
    for (const d of created.dashboards) {
      const dash = await ctx.dashboards.get(author, d);
      expect(dash.widgets.length).toBeGreaterThan(0);
      expect(dash.layout.length).toBe(dash.widgets.length);
      expect(dash.layout.every((l) => l.x + l.w <= 12)).toBe(true);
    }
    // Quality suites run without errors; notebooks run.
    for (const s of created.quality) expect((await ctx.quality.run(s, 'manual', author)).run.status, `suite of ${id}`).not.toBe('error');
    for (const n of created.notebooks) expect((await ctx.notebooks.runAll(author, n)).failed, `notebook of ${id}`).toBeFalsy();
    // Metrics answer.
    if (t.body.semantic) {
      const sem = await ctx.semantic.get(author, ws);
      const metric = sem.metrics[0]!.name;
      expect((await ctx.semantic.query(author, ws, { metrics: [metric] })).result.rows.length).toBe(1);
    }
    expect((await ctx.templates.installs(author, ws)).map((i) => i.template_id)).toEqual([id]);
  }, 60_000);

  it('maps tables, refuses what does not fit and leaves nothing behind', async () => {
    const ws = (await ctx.workspaces.create(author, { name: 'Shop', active_db_path: ':memory:' })).id;
    await run(author, ws, "CREATE SCHEMA sales; CREATE TABLE sales.tickets_raw AS SELECT 1::BIGINT AS ticket_id, now()::TIMESTAMP AS created_at, NULL::TIMESTAMP AS resolved_at, 'high' AS priority, 'chat' AS channel, NULL::INTEGER AS csat");
    await run(author, ws, 'CREATE TABLE subs AS SELECT 1 AS subscription_id, 29.0 AS mrr');
    // Missing columns: nothing is created.
    const bad = await api('POST', '/api/templates/builtin:saas/install', authorJwt, { workspace_id: ws, table_map: { subscriptions: 'subs' } });
    expect(bad.status).toBe(400);
    expect(bad.json.message).toMatch(/subs has no column customer_id, plan, started_at, cancelled_at/);
    expect(await ctx.savedQueries.list(author, ws)).toEqual([]);
    const checked = await api('POST', '/api/templates/builtin:support/check', authorJwt, { workspace_id: ws, table_map: { tickets: 'sales.tickets_raw' } });
    expect(checked.json.tables).toEqual([{ name: 'tickets', target: 'sales.tickets_raw', exists: true, missing_columns: [], has_sample: true }]);
    const ok = await api('POST', '/api/templates/builtin:support/install', authorJwt, { workspace_id: ws, table_map: { tickets: 'sales.tickets_raw' } });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(ok.json.created.tables).toEqual([]);
    const backlog = (await ctx.savedQueries.list(author, ws)).find((q) => q.name === 'Open backlog')!;
    expect(backlog.sql_text).toContain('FROM sales.tickets_raw');
    expect(await run(author, ws, backlog.sql_text)).toEqual([[1, 1]]);
    // Viewers cannot install.
    await ctx.workspaces.setMember(author, ws, { subject_type: 'user', subject_id: other.userId, role: 'VIEWER' });
    expect((await api('POST', '/api/templates/builtin:web-analytics/install', otherJwt, { workspace_id: ws, sample_data: true })).status).toBe(403);
    // A failure half way (a widget that would write) undoes what was already made.
    const broken = await api('POST', '/api/templates/import', authorJwt, { duckview_template: 1, name: 'Broken', body: { tables: [{ name: 'subs', columns: [{ name: 'mrr', type: 'DOUBLE' }] }], queries: [{ key: 'a', name: 'Fine query', sql: 'SELECT sum(mrr) FROM {{table:subs}}' }], dashboards: [{ name: 'Bad board', widgets: [{ title: 'Writes', widget_type: 'TABLE', sql: 'DELETE FROM {{table:subs}}' }] }] } });
    expect(broken.status, JSON.stringify(broken.json)).toBe(200);
    const half = await api('POST', `/api/templates/${broken.json.template.id}/install`, authorJwt, { workspace_id: ws });
    expect(half.json.message).toMatch(/read-only SQL/);
    expect((await ctx.savedQueries.list(author, ws)).map((x) => x.name)).not.toContain('Fine query');
    expect((await ctx.dashboards.list(author, ws)).map((x) => x.name)).not.toContain('Bad board');
  });

  it('removes an install, and its sample tables on request', async () => {
    const ws = (await ctx.workspaces.create(author, { name: 'Remove me', active_db_path: ':memory:' })).id;
    const { install } = await ctx.templates.install(author, 'builtin:web-analytics', { workspace_id: ws, sample_data: true });
    expect((await ctx.savedQueries.list(author, ws)).length).toBe(5);
    expect((await api('DELETE', `/api/template-installs/${install.id}?drop_tables=1`, authorJwt)).status).toBe(200);
    expect(await ctx.savedQueries.list(author, ws)).toEqual([]);
    expect(await ctx.notebooks.list(author, ws)).toEqual([]);
    await expect(run(author, ws, 'SELECT count(*) FROM events')).rejects.toThrow(/events/);
    expect(await ctx.templates.installs(author, ws)).toEqual([]);
  });

  it('publishes from a workspace, is reviewed, exported, imported and installed elsewhere', async () => {
    const ws = (await ctx.workspaces.create(author, { name: 'Ops', active_db_path: ':memory:' })).id;
    await run(author, ws, "CREATE TABLE incidents AS SELECT range AS id, (['sev1', 'sev2', 'sev3'])[1 + range % 3] AS severity, current_date - range::INTEGER AS opened FROM range(80)");
    const q = await ctx.savedQueries.create(author, ws, { name: 'Incidents by severity', sql_text: 'SELECT severity, count(*) AS incidents\nFROM incidents\nGROUP BY 1 ORDER BY 1' });
    const d = await ctx.dashboards.create(author, ws, { name: 'Incident board' });
    await ctx.dashboards.addWidget(author, d.id, { title: 'By severity', widget_type: 'CHART', saved_query_id: q.id, chart_config: { chart: 'bar', x: 'severity', y: ['incidents'] } });
    await ctx.dashboards.addWidget(author, d.id, { title: 'Open', widget_type: 'KPI', custom_sql: 'SELECT count(*) AS n FROM main.incidents', chart_config: { value: 'n' } });
    const suite = await ctx.quality.create(author, ws, { name: 'Incident checks', relation: 'incidents', checks: [{ id: 'id', type: 'unique', column: 'id', severity: 'error' }] });
    const pub = await api('POST', '/api/templates', authorJwt, { workspace_id: ws, name: 'Incident tracking', description: 'Incidents by severity', category: 'Operations', tags: ['Ops'], dashboard_ids: [d.id], quality_ids: [suite.id], sample_rows: 50, visibility: 'org' });
    expect(pub.status, JSON.stringify(pub.json)).toBe(200);
    const tpl = pub.json.template;
    expect(tpl).toMatchObject({ status: 'pending', source: 'organisation', tags: ['ops'], contents: { tables: ['incidents'], queries: 1, dashboards: 1, quality: 1, sample_data: true } });
    const full = (await api('GET', `/api/templates/${tpl.id}`, authorJwt)).json.template;
    expect(full.body.queries[0].sql).toBe('SELECT severity, count(*) AS incidents\nFROM {{table:incidents}}\nGROUP BY 1 ORDER BY 1');
    expect(full.body.dashboards[0].widgets.map((w: { query: string | null; sql: string | null }) => w.query ?? w.sql)).toEqual(['incidents_by_severity', 'SELECT count(*) AS n FROM {{table:incidents}}']);
    expect(full.body.quality[0].relation).toBe('{{table:incidents}}');
    // Waiting for review: the author and administrators see it; nobody else.
    expect((await api('GET', '/api/templates', otherJwt)).json.templates.some((x: { id: string }) => x.id === tpl.id)).toBe(false);
    expect((await api('GET', `/api/templates/${tpl.id}`, otherJwt)).status).toBe(404);
    expect((await api('POST', `/api/templates/${tpl.id}/review`, authorJwt, { approve: true })).status).toBe(403);
    expect((await api('POST', `/api/templates/${tpl.id}/review`, adminJwt, { approve: true })).json.template.status).toBe('published');
    const listed = (await api('GET', '/api/templates?q=incident', otherJwt)).json.templates;
    expect(listed.map((x: { name: string }) => x.name)).toEqual(['Incident tracking']);
    // Someone else installs it with its sample rows.
    const ws2 = (await ctx.workspaces.create(other, { name: 'Other ops', active_db_path: ':memory:' })).id;
    const inst = await api('POST', `/api/templates/${tpl.id}/install`, otherJwt, { workspace_id: ws2, sample_data: true });
    expect(inst.status, JSON.stringify(inst.json)).toBe(200);
    expect(await run(other, ws2, 'SELECT count(*) FROM incidents')).toEqual([[50]]);
    const board = (await ctx.dashboards.get(other, inst.json.created.dashboards[0])).widgets;
    expect(board.map((w) => w.title)).toEqual(['By severity', 'Open']);
    expect((await api('GET', '/api/templates?q=incident', otherJwt)).json.templates[0].installs).toBe(1);
    // As a file, and back.
    const file = (await api('GET', `/api/templates/${tpl.id}/export`, otherJwt)).json;
    expect(file).toMatchObject({ duckview_template: 1, name: 'Incident tracking' });
    const imported = await api('POST', '/api/templates/import', otherJwt, { ...file, name: 'My copy' });
    expect(imported.json.template).toMatchObject({ name: 'My copy', status: 'private', author: 'other@test.local' });
    expect((await api('POST', '/api/templates/import', otherJwt, { ...file, body: { ...file.body, tables: [{ ...file.body.tables[0], sample_sql: 'SELECT 1; DROP TABLE x' }] } })).status).toBe(400);
    expect((await api('DELETE', `/api/templates/${tpl.id}`, otherJwt)).status).toBe(404);
    expect((await api('DELETE', '/api/templates/builtin:saas', adminJwt)).status).toBe(403);
  });

  it('are listed and installed by agents', async () => {
    const ws = (await ctx.workspaces.create(admin, { name: 'Agent built', active_db_path: ':memory:' })).id;
    const list = await api('POST', '/api/agent/v1/tools/list_templates', adminJwt, { q: 'subscriptions' });
    expect(String(list.json.text)).toMatch(/\*\*SaaS subscriptions\*\* \(`builtin:saas`/);
    const inst = await api('POST', '/api/agent/v1/tools/install_template', adminJwt, { template_id: 'builtin:saas', sample_data: true, workspace_id: ws });
    expect(inst.json.is_error, JSON.stringify(inst.json)).toBe(false);
    expect(String(inst.json.text)).toMatch(/Installed \*\*SaaS subscriptions\*\*: 4 saved queries, 1 dashboards/);
  });
});
