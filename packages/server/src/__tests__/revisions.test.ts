/**
 * Version history: a revision per save, merged while the same person keeps editing, split by another person, a
 * named version or time; restoring notebooks, dashboards (widgets under their old ids), saved queries, the semantic
 * layer and dbt projects; readable text for diffs; who may restore; history forgotten with the object.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { loadConfig } from '../config/index.js';
import { initLogger } from '../observability/logger.js';
import { createContext, type AppContext } from '../context.js';
import { buildApp } from '../app.js';
import type { Principal } from '../services/principal.js';

let dir: string;
let ctx: AppContext;
let app: Awaited<ReturnType<typeof buildApp>>['app'];
let base: string;
const tokens: Record<string, string> = {};
let wsId: string;
let admin: Principal;
let editor: Principal;

const api = async (method: string, url: string, body?: unknown, who = 'admin') => {
  const res = await fetch(base + url, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), authorization: `Bearer ${tokens[who]}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
};
const history = async (type: string, id: string) => (await api('GET', `/api/workspaces/${wsId}/revisions?object_type=${type}&object_id=${id}`)).json.revisions as { id: string; number: number; message: string | null; named: boolean; author: string }[];
/** Pretends the latest revision was saved long ago, so the next save starts a new one. */
const age = async (type: 'notebook' | 'dashboard' | 'query' | 'semantic' | 'dbt', id: string) => {
  const s = ctx.store.schema;
  const rows = await ctx.store.db.select().from(s.revisions).where(eq(s.revisions.object_id, id));
  for (const r of rows.filter((x) => x.object_type === type)) await ctx.store.db.update(s.revisions).set({ updated_at: new Date(Date.now() - 60 * 60_000) }).where(eq(s.revisions.id, r.id));
};

beforeAll(async () => {
  initLogger({ level: 'silent', stderr: true, pretty: false });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dv-revisions-'));
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  const cfg = loadConfig({ configPath: null, env: { DUCKVIEW_DATA_DIR: path.join(dir, 'data'), DUCKDB_TEMP_DIRECTORY: path.join(dir, 'spill'), DATABASE_URL: ':memory:', DUCKDB_MEMORY_LIMIT: '512MB', DUCKVIEW_ADMIN_EMAIL: 'admin@test.local', DUCKVIEW_ADMIN_PASSWORD: 'super-secret-pw', DUCKVIEW__duckdb__sync_scheduler_enabled: 'false', DUCKVIEW__notifications__scheduler_enabled: 'false', DUCKVIEW__transform__scheduler_enabled: 'false', DUCKVIEW__apps__enabled: 'false', LOG_LEVEL: 'silent' } });
  ctx = await createContext(cfg);
  admin = ctx.auth.principalFromUser((await ctx.auth.findByEmail('admin@test.local'))!, 'jwt', '127.0.0.1');
  const ed = await ctx.auth.createLocalUser({ email: 'editor@test.local', password: 'editor-secret-pw', role: 'USER' });
  const vi = await ctx.auth.createLocalUser({ email: 'viewer@test.local', password: 'viewer-secret-pw', role: 'USER' });
  editor = ctx.auth.principalFromUser(ed, 'jwt', '127.0.0.1');
  wsId = (await ctx.workspaces.create(admin, { name: 'Shop', active_db_path: 'shop.duckdb' })).id;
  await ctx.workspaces.setMember(admin, wsId, { subject_type: 'user', subject_id: ed.id, role: 'EDITOR' });
  await ctx.workspaces.setMember(admin, wsId, { subject_type: 'user', subject_id: vi.id, role: 'VIEWER' });
  await ctx.queries.run(admin, wsId, "CREATE TABLE orders AS SELECT * FROM (VALUES (1, 'EU', 10.0), (2, 'US', 20.0)) t(id, region, amount)", { cache: false });
  ({ app } = await buildApp(ctx));
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as net.AddressInfo).port}`;
  for (const [who, email, pw] of [['admin', 'admin@test.local', 'super-secret-pw'], ['editor', 'editor@test.local', 'editor-secret-pw'], ['viewer', 'viewer@test.local', 'viewer-secret-pw']]) tokens[who!] = (await (await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: pw }) })).json()).token;
}, 120_000);

afterAll(async () => {
  await app?.close();
  await ctx?.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('version history', () => {
  it('records notebook saves, merging one person\'s edits and splitting on others, names and time', async () => {
    const nb = await ctx.notebooks.create(admin, wsId, { title: 'Revenue', cells: [{ id: 'c1', type: 'sql', name: 'df1', source: 'SELECT 1' }] });
    await ctx.notebooks.update(admin, nb.id, { cells: [{ id: 'c1', type: 'sql', name: 'df1', source: 'SELECT 2' }] });
    await ctx.notebooks.update(admin, nb.id, { cells: [{ id: 'c1', type: 'sql', name: 'df1', source: 'SELECT 3' }] });
    expect((await history('notebook', nb.id)).map((r) => r.number)).toEqual([1]);
    // Another person: a new revision.
    await ctx.notebooks.update(editor, nb.id, { title: 'Revenue by region' });
    // A named version, then more edits: named versions are never merged into.
    expect((await api('POST', `/api/workspaces/${wsId}/revisions`, { object_type: 'notebook', object_id: nb.id, message: 'Reviewed with finance' }, 'editor')).status).toBe(200);
    await ctx.notebooks.update(editor, nb.id, { cells: [{ id: 'c1', type: 'sql', name: 'df1', source: 'SELECT 4' }] });
    // Later, the same person again: a new revision.
    await age('notebook', nb.id);
    await ctx.notebooks.update(editor, nb.id, { cells: [{ id: 'c1', type: 'sql', name: 'df1', source: 'SELECT 5' }] });
    const h = await history('notebook', nb.id);
    expect(h.map((r) => [r.number, r.message, r.named])).toEqual([[5, null, false], [4, null, false], [3, 'Reviewed with finance', true], [2, null, false], [1, null, false]]);
    expect(h[4]!.author).not.toBe('editor@test.local');
    expect(h[1]!.author).toBe('editor@test.local');
    // Text for diffs, next to the current state.
    const first = (await api('GET', `/api/revisions/${h[4]!.id}`)).json;
    expect(first.text).toBe('# Revenue\n\n-- [sql] df1\nSELECT 3\n');
    expect(first.current).toBe('# Revenue by region\n\n-- [sql] df1\nSELECT 5\n');
    // Restore version 1: the notebook comes back; the state before and the restore are both in the history.
    expect((await api('POST', `/api/revisions/${h[4]!.id}/restore`, {}, 'viewer')).status).toBe(403);
    const restored = (await api('POST', `/api/revisions/${h[4]!.id}/restore`, {}, 'editor')).json.revision;
    expect(restored).toMatchObject({ number: 6, message: 'Restored version 1' });
    const now = await ctx.notebooks.get(admin, nb.id);
    expect([now.title, now.cells[0]!.source]).toEqual(['Revenue', 'SELECT 3']);
    // Undoing the restore is one more restore.
    await api('POST', `/api/revisions/${h[0]!.id}/restore`, {}, 'editor');
    expect((await ctx.notebooks.get(admin, nb.id)).cells[0]!.source).toBe('SELECT 5');
    // Deleting the notebook forgets its history.
    await ctx.notebooks.remove(admin, nb.id);
    expect(await history('notebook', nb.id)).toEqual([]);
  });

  it('restores a dashboard with its widgets under their old ids', async () => {
    const d = await ctx.dashboards.create(admin, wsId, { name: 'Sales' });
    const a = (await ctx.dashboards.addWidget(admin, d.id, { title: 'Total', widget_type: 'KPI', custom_sql: 'SELECT sum(amount) FROM orders' })).widget;
    const b = (await ctx.dashboards.addWidget(admin, d.id, { title: 'By region', widget_type: 'TABLE', custom_sql: 'SELECT region, sum(amount) FROM orders GROUP BY 1' })).widget;
    await api('POST', `/api/workspaces/${wsId}/revisions`, { object_type: 'dashboard', object_id: d.id, message: 'Two widgets' });
    await ctx.dashboards.removeWidget(admin, d.id, b.id);
    await ctx.dashboards.updateWidget(admin, d.id, a.id, { title: 'Revenue' });
    await ctx.dashboards.update(admin, d.id, { name: 'Sales (new)' });
    const named = (await history('dashboard', d.id)).find((r) => r.named)!;
    const rev = (await api('GET', `/api/revisions/${named.id}`)).json;
    expect(rev.text).toMatch(/name: Sales\n[\s\S]*title: By region/);
    expect(rev.current).toMatch(/name: Sales \(new\)/);
    expect(rev.current).not.toMatch(/By region/);
    await api('POST', `/api/revisions/${named.id}/restore`, {});
    const back = await ctx.dashboards.get(admin, d.id);
    expect(back.name).toBe('Sales');
    expect(back.widgets.map((w) => [w.id, w.title]).sort()).toEqual([[a.id, 'Total'], [b.id, 'By region']].sort());
    expect(back.layout.map((l) => l.i).sort()).toEqual([a.id, b.id].sort());
  });

  it('restores saved queries, the semantic layer and dbt projects', async () => {
    const q = await ctx.savedQueries.create(admin, wsId, { name: 'EU orders', sql_text: "SELECT * FROM orders WHERE region = 'EU'" });
    await age('query', q.id);
    await ctx.savedQueries.update(admin, wsId, q.id, { sql_text: 'SELECT * FROM orders' });
    const qh = await history('query', q.id);
    expect(qh).toHaveLength(2);
    expect((await api('GET', `/api/revisions/${qh[1]!.id}`)).json.text).toBe("-- EU orders\nSELECT * FROM orders WHERE region = 'EU'\n");
    await api('POST', `/api/revisions/${qh[1]!.id}/restore`, {});
    expect((await ctx.savedQueries.get(admin, wsId, q.id)).sql_text).toBe("SELECT * FROM orders WHERE region = 'EU'");

    const v1 = 'semantic_models:\n  - name: orders\n    table: orders\n    measures:\n      - { name: revenue, agg: sum, expr: amount }\nmetrics:\n  - { name: revenue, type: simple, measure: revenue }\n';
    await ctx.semantic.save(admin, wsId, v1);
    await age('semantic', 'workspace');
    await ctx.semantic.save(admin, wsId, v1.replace('agg: sum', 'agg: avg'));
    const sh = await history('semantic', 'workspace');
    expect(sh).toHaveLength(2);
    await api('POST', `/api/revisions/${sh[1]!.id}/restore`, {});
    expect((await ctx.semantic.get(admin, wsId)).yaml).toBe(v1);

    const project = await ctx.dbt.create(admin, wsId, { name: 'Shop', files: { 'dbt_project.yml': "name: shop\nversion: '1.0'\nprofile: duckview\n", 'models/a.sql': 'select 1 as x\n' } });
    await age('dbt', project.id);
    await ctx.dbt.writeFiles(admin, project.id, { 'models/a.sql': 'select 2 as x\n', 'models/b.sql': 'select 3 as y\n' });
    const dh = await history('dbt', project.id);
    expect((await api('GET', `/api/revisions/${dh[0]!.id}`)).json.text).toMatch(/==> models\/a\.sql <==\nselect 2 as x\n\n\n==> models\/b\.sql <==/);
    await api('POST', `/api/revisions/${dh[1]!.id}/restore`, {});
    const files = (await ctx.dbt.get(admin, project.id)).files;
    expect(files['models/a.sql']).toBe('select 1 as x\n');
    expect(files['models/b.sql']).toBeUndefined();
  });
});
