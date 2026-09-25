import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../config/index.js';
import { initLogger } from '../observability/logger.js';
import { createContext, type AppContext } from '../context.js';
import { buildApp } from '../app.js';

let dir: string;
let ctx: AppContext;
let app: Awaited<ReturnType<typeof buildApp>>['app'];
let base: string;
let adminJwt: string;
let userJwt: string;
let userId: string;

const api = async (method: string, url: string, token: string, body?: unknown) => {
  const res = await fetch(base + url, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, json: (text ? JSON.parse(text) : {}) as Record<string, any> };
};
const login = async (email: string, password: string) => ((await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) })).json()) as { token: string }).token;

beforeAll(async () => {
  initLogger({ level: 'silent', stderr: true, pretty: false });
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dv-wsa-')));
  const cfg = loadConfig({
    configPath: null,
    env: { DUCKVIEW_DATA_DIR: path.join(dir, 'data'), DUCKVIEW_FILESYSTEM_MODE: 'sandboxed', DUCKDB_TEMP_DIRECTORY: path.join(dir, 'spill'), DATABASE_URL: ':memory:', DUCKDB_MEMORY_LIMIT: '1GB', DUCKVIEW_ADMIN_EMAIL: 'admin@test.local', DUCKVIEW_ADMIN_PASSWORD: 'super-secret-pw', LOG_LEVEL: 'silent' },
  });
  ctx = await createContext(cfg);
  ({ app } = await buildApp(ctx));
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  adminJwt = await login('admin@test.local', 'super-secret-pw');
  userId = (await ctx.auth.createLocalUser({ email: 'analyst@test.local', password: 'analyst-pass-123', role: 'USER' })).id;
  userJwt = await login('analyst@test.local', 'analyst-pass-123');
});

afterAll(async () => {
  await app?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('workspace management', () => {
  let source: string;
  it('creates a workspace with a description, tags, a colour and members', async () => {
    const r = await api('POST', '/api/workspaces', adminJwt, { name: 'Sales', description: 'Revenue and pipeline', tags: ['Finance', ' finance', 'EU Region'], color: '3', active_db_path: 'sales.duckdb', members: [{ subject_type: 'user', subject_id: userId, role: 'EDITOR' }] });
    expect(r.status).toBe(200);
    expect(r.json.workspace).toMatchObject({ name: 'Sales', description: 'Revenue and pipeline', tags: ['finance', 'eu-region'], color: '3', member_count: 1 });
    expect(r.json.started.kind).toBe('empty');
    source = r.json.workspace.id;
    await api('POST', `/api/workspaces/${source}/query`, adminJwt, { sql: 'CREATE TABLE orders AS SELECT range AS id, range * 10 AS amount FROM range(5)' });
  });

  it('clones data, folders and objects into a new file, relinking widgets to their queries', async () => {
    const q = await api('POST', `/api/workspaces/${source}/queries`, adminJwt, { name: 'Total', sql_text: 'SELECT sum(amount) AS total FROM orders' });
    expect(q.status).toBe(200);
    const queryId = (q.json.query ?? q.json.saved_query ?? q.json).id;
    const d = await ctx.dashboards.create(ctx.auth.principalFromUser((await ctx.auth.findByEmail('admin@test.local'))!, 'jwt', '127.0.0.1'), source, { name: 'Overview' });
    const admin = ctx.auth.principalFromUser((await ctx.auth.findByEmail('admin@test.local'))!, 'jwt', '127.0.0.1');
    await ctx.dashboards.addWidget(admin, d.id, { title: 'Total', widget_type: 'KPI', saved_query_id: queryId });
    await ctx.notebooks.create(admin, source, { title: 'Notes', cells: [{ type: 'sql', source: 'SELECT 1' }] });

    // A clone into memory is refused, and leaves nothing behind.
    const before = (await api('GET', '/api/admin/workspaces', adminJwt)).json.workspaces.length;
    const bad = await api('POST', '/api/workspaces', adminJwt, { name: 'Bad clone', active_db_path: ':memory:', start_from: { kind: 'clone', workspace_id: source } });
    expect(bad.status).toBe(400);
    expect((await api('GET', '/api/admin/workspaces', adminJwt)).json.workspaces.length).toBe(before);

    const r = await api('POST', '/api/workspaces', adminJwt, { name: 'Sales copy', active_db_path: 'sales-copy.duckdb', start_from: { kind: 'clone', workspace_id: source } });
    expect(r.status).toBe(200);
    expect(r.json.started.detail).toMatch(/Cloned from Sales: 1 tables, 1 dashboards, 1 queries, 1 notebooks/);
    const clone = r.json.workspace.id;
    const rows = await api('POST', `/api/workspaces/${clone}/query`, adminJwt, { sql: 'SELECT count(*) AS n, sum(amount) AS s FROM orders' });
    expect(rows.json.rows[0].map(Number)).toEqual([5, 100]);
    const dashes = await ctx.dashboards.list(admin, clone);
    const full = await ctx.dashboards.get(admin, dashes[0]!.id);
    const cloneQueries = await ctx.savedQueries.list(admin, clone);
    expect(full.widgets[0]!.saved_query_id).toBe(cloneQueries[0]!.id);
    expect(full.widgets[0]!.saved_query_id).not.toBe(queryId);
    expect(full.layout[0]!.i).toBe(full.widgets[0]!.id);
    // The source is untouched.
    expect((await ctx.savedQueries.list(admin, source)).length).toBe(1);
  });

  it('starts from a template with its sample data', async () => {
    const r = await api('POST', '/api/workspaces', adminJwt, { name: 'Shop', active_db_path: 'shop.duckdb', start_from: { kind: 'template', template_id: 'builtin:ecommerce' } });
    expect(r.status).toBe(200);
    expect(r.json.started.kind).toBe('template');
    expect(r.json.started.detail).toMatch(/dashboards/);
  });

  it('lists every workspace for administrators only, with owner, storage, size, members and engine', async () => {
    expect((await api('GET', '/api/admin/workspaces', userJwt)).status).toBe(403);
    const r = await api('GET', '/api/admin/workspaces', adminJwt);
    const sales = r.json.workspaces.find((w: { id: string }) => w.id === source);
    expect(sales).toMatchObject({ name: 'Sales', owner: { email: 'admin@test.local' }, storage: { kind: 'data', location: 'sales.duckdb' }, members: 1, engine: { state: 'running' }, tags: ['finance', 'eu-region'] });
    expect(sales.size_bytes).toBeGreaterThan(0);
    expect(typeof sales.cost_this_month).toBe('number');
    expect(sales.last_activity_at).toBeTruthy();
  });

  it('archives: hidden from the switcher, no queries, then restored', async () => {
    const a = await api('POST', '/api/admin/workspaces/bulk', adminJwt, { ids: [source], action: 'archive' });
    expect(a.json.results).toEqual([{ id: source, ok: true }]);
    expect((await api('GET', '/api/workspaces', adminJwt)).json.workspaces.some((w: { id: string }) => w.id === source)).toBe(false);
    expect((await api('GET', '/api/workspaces?archived=1', adminJwt)).json.workspaces.some((w: { id: string }) => w.id === source)).toBe(true);
    const q = await api('POST', `/api/workspaces/${source}/query`, adminJwt, { sql: 'SELECT 1' });
    expect(q.status).toBe(400);
    expect(q.json.message).toMatch(/archived/);
    expect((await api('GET', '/api/admin/workspaces', adminJwt)).json.workspaces.find((w: { id: string }) => w.id === source).engine.state).toBe('archived');
    await api('POST', `/api/workspaces/${source}/archive`, adminJwt, { archived: false });
    expect((await api('POST', `/api/workspaces/${source}/query`, adminJwt, { sql: 'SELECT 1 AS x' })).status).toBe(200);
  });

  it('tags, transfers and deletes in bulk, reporting each workspace', async () => {
    const list = (await api('GET', '/api/admin/workspaces', adminJwt)).json.workspaces as { id: string; name: string }[];
    const copy = list.find((w) => w.name === 'Sales copy')!.id;
    const t = await api('POST', '/api/admin/workspaces/bulk', adminJwt, { ids: [source, copy, 'nope'], action: 'tag', tags: ['q3'] });
    expect(t.json.results.map((r: { ok: boolean }) => r.ok)).toEqual([true, true, false]);
    expect((await ctx.workspaces.rowById(copy))!.tags).toEqual(['q3']);
    await api('POST', '/api/admin/workspaces/bulk', adminJwt, { ids: [copy], action: 'untag', tags: ['q3'] });
    expect((await ctx.workspaces.rowById(copy))!.tags).toEqual([]);
    expect((await api('POST', '/api/admin/workspaces/bulk', adminJwt, { ids: [copy], action: 'transfer' })).status).toBe(400);
    await api('POST', '/api/admin/workspaces/bulk', adminJwt, { ids: [copy], action: 'transfer', user_id: userId });
    expect((await ctx.workspaces.rowById(copy))!.user_id).toBe(userId);
    expect((await api('POST', '/api/admin/workspaces/bulk', userJwt, { ids: [copy], action: 'delete' })).status).toBe(403);
    await api('POST', '/api/admin/workspaces/bulk', adminJwt, { ids: [copy], action: 'delete' });
    expect(await ctx.workspaces.rowById(copy)).toBeNull();
  });

  it('summarises one workspace: counts, health (worst first), engine, connections; activity for owners', async () => {
    fs.mkdirSync(path.join(dir, 'data', 'gone'), { recursive: true });
    await api('POST', `/api/workspaces/${source}/folders`, adminJwt, { path: 'gone' });
    fs.rmSync(path.join(dir, 'data', 'gone'), { recursive: true });
    await api('POST', `/api/workspaces/${source}/query`, adminJwt, { sql: 'SELECT 1' });
    const r = await api('GET', `/api/workspaces/${source}/summary`, userJwt);
    expect(r.status).toBe(200);
    expect(r.json.counts).toMatchObject({ tables: 1, queries: 1, dashboards: 1, notebooks: 1, folders: 1 });
    expect(r.json.engine.state).toBe('running');
    expect(r.json.checks[0]).toMatchObject({ id: 'folders', status: 'error' });
    expect(r.json.checks.find((c: { id: string }) => c.id === 'engine').status).toBe('ok');
    expect(r.json.folders[0].missing).toBe(true);
    expect(r.json.connections).toHaveProperty('databases');
    expect((await api('GET', `/api/workspaces/${source}/activity`, userJwt)).status).toBe(403);
    const act = await api('GET', `/api/workspaces/${source}/activity`, adminJwt);
    expect(act.json.events.some((e: { action: string; who: string }) => e.action === 'workspace.create' && e.who === 'admin@test.local')).toBe(true);
  });
});
