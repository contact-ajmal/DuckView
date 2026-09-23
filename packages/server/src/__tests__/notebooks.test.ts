/**
 * SQL notebooks: cells that read earlier cells by name (CTEs, recursively), inputs as literals, saving with versions
 * (a stale save is refused), outputs saved for editors only, run all stopping at the first error, access policies,
 * Markdown export, the agent tools (with approval for cells that write) and Copilot's context.
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
import { buildTools, runTool, type ToolEnv } from '../agent/tools.js';
import { compileCell, referencedNames } from '../services/notebooks.js';
import type { NotebookCell } from '../db/schema/sqlite.js';
import type { Principal } from '../services/principal.js';

let dir: string;
let ctx: AppContext;
let app: Awaited<ReturnType<typeof buildApp>>['app'];
let base: string;
let jwt: string;
let viewerJwt: string;
let wsId: string;
let admin: Principal;

const api = async (method: string, url: string, body?: unknown, token = jwt) => {
  const res = await fetch(base + url, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: Record<string, any> = {};
  try {
    json = JSON.parse(text);
  } catch {
    json = { text };
  }
  return { status: res.status, json };
};

const CELLS = [
  { id: 'intro', type: 'markdown', source: '# Revenue by region\n\nOrders from **2026**.' },
  { id: 'region', type: 'input', name: 'region', input: { kind: 'select', label: 'Region', value: 'EU', options: ['EU', 'US'] } },
  { id: 'min_amount', type: 'input', name: 'min_amount', input: { kind: 'number', value: '40' } },
  { id: 'c1', type: 'sql', name: 'orders_2026', source: 'SELECT * FROM orders WHERE amount >= {{ min_amount }}' },
  { id: 'c2', type: 'sql', name: 'by_region', source: "SELECT region, sum(amount) AS revenue, count(*) AS n FROM orders_2026 GROUP BY region ORDER BY region" },
  { id: 'c3', type: 'sql', name: 'picked', source: 'SELECT * FROM by_region WHERE region = {{ region }}' },
];

beforeAll(async () => {
  initLogger({ level: 'silent', stderr: true, pretty: false });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dv-notebooks-'));
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  const cfg = loadConfig({ configPath: null, env: { DUCKVIEW_DATA_DIR: path.join(dir, 'data'), DUCKDB_TEMP_DIRECTORY: path.join(dir, 'spill'), DATABASE_URL: ':memory:', DUCKDB_MEMORY_LIMIT: '512MB', DUCKVIEW_ADMIN_EMAIL: 'admin@test.local', DUCKVIEW_ADMIN_PASSWORD: 'super-secret-pw', DUCKVIEW__duckdb__sync_scheduler_enabled: 'false', DUCKVIEW__notifications__scheduler_enabled: 'false', DUCKVIEW__transform__scheduler_enabled: 'false', DUCKVIEW__apps__enabled: 'false', LOG_LEVEL: 'silent' } });
  ctx = await createContext(cfg);
  admin = ctx.auth.principalFromUser((await ctx.auth.findByEmail('admin@test.local'))!, 'jwt', '127.0.0.1');
  const viewer = await ctx.auth.createLocalUser({ email: 'viewer@test.local', password: 'viewer-secret-pw', role: 'USER' });
  wsId = (await ctx.workspaces.create(admin, { name: 'Shop', active_db_path: 'shop.duckdb' })).id;
  await ctx.workspaces.setMember(admin, wsId, { subject_type: 'user', subject_id: viewer.id, role: 'VIEWER' });
  await ctx.queries.run(admin, wsId, `CREATE TABLE orders AS SELECT * FROM (VALUES (1, 'EU', 120.0), (2, 'US', 80.0), (3, 'EU', 50.0), (4, 'US', 200.0), (5, 'EU', 30.0)) t(id, region, amount)`, { cache: false });
  ({ app } = await buildApp(ctx));
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as net.AddressInfo).port}`;
  jwt = (await api('POST', '/api/auth/login', { email: 'admin@test.local', password: 'super-secret-pw' }, '')).json.token;
  viewerJwt = (await api('POST', '/api/auth/login', { email: 'viewer@test.local', password: 'viewer-secret-pw' }, '')).json.token;
}, 120_000);

afterAll(async () => {
  await app?.close();
  await ctx?.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('notebooks', () => {
  it('compiles a cell with the cells it reads as CTEs and inputs as literals', () => {
    const cells = CELLS as NotebookCell[];
    const { sql, refs } = compileCell(cells, 'c3');
    expect(refs).toEqual(['orders_2026', 'by_region']);
    expect(sql).toBe(`WITH "orders_2026" AS (\nSELECT * FROM orders WHERE amount >= 40\n),\n"by_region" AS (\nSELECT region, sum(amount) AS revenue, count(*) AS n FROM orders_2026 GROUP BY region ORDER BY region\n)\nSELECT * FROM by_region WHERE region = 'EU'`);
    // Names inside strings, comments, quoted identifiers or after a dot are not references.
    expect(referencedNames("SELECT 'by_region', x.by_region FROM t -- by_region\n/* by_region */", ['by_region'])).toEqual([]);
    expect(referencedNames('select * from BY_REGION', ['by_region'])).toEqual(['by_region']);
    // A cell's own WITH is merged; an input value never becomes SQL.
    const own = compileCell([...cells, { id: 'c4', type: 'sql', name: 'x', source: 'WITH t AS (SELECT * FROM picked) SELECT * FROM t' }] as NotebookCell[], 'c4');
    expect(own.sql).toMatch(/^WITH "orders_2026" AS \([\s\S]*"picked" AS \([\s\S]*\),\nt AS \(SELECT \* FROM picked\) SELECT \* FROM t$/);
    const evil = cells.map((c) => (c.id === 'region' ? { ...c, input: { kind: 'text' as const, value: "EU' OR 1=1 --" } } : c));
    expect(compileCell(evil, 'c3').sql).toMatch(/region = 'EU'' OR 1=1 --'$/);
    expect(() => compileCell([{ id: 'a', type: 'sql', name: 'a', source: 'SELECT {{ nope }}' }] as NotebookCell[], 'a')).toThrow(/No input named nope/);
    expect(() => compileCell([{ id: 'w', type: 'sql', name: 'w', source: 'CREATE TABLE z AS SELECT 1' }, { id: 'r', type: 'sql', name: 'r', source: 'SELECT * FROM w' }] as NotebookCell[], 'r')).toThrow(/w is not one read-only query/);
  });

  it('creates, saves with versions, and refuses a stale save', async () => {
    expect((await api('POST', `/api/workspaces/${wsId}/notebooks`, { title: 'x' }, viewerJwt)).status).toBe(403);
    const created = (await api('POST', `/api/workspaces/${wsId}/notebooks`, { title: 'Revenue', cells: CELLS })).json.notebook;
    expect(created).toMatchObject({ title: 'Revenue', version: 1 });
    expect(created.cells.map((c: { name?: string }) => c.name ?? null)).toEqual([null, 'region', 'min_amount', 'orders_2026', 'by_region', 'picked']);
    expect((await api('PATCH', `/api/notebooks/${created.id}`, { cells: [...CELLS, { type: 'sql', name: 'picked', source: 'SELECT 1' }] })).json.message).toMatch(/already called picked/);
    const saved = (await api('PATCH', `/api/notebooks/${created.id}`, { title: 'Revenue 2026', version: 1 })).json.notebook;
    expect(saved.version).toBe(2);
    const stale = await api('PATCH', `/api/notebooks/${created.id}`, { title: 'Mine', version: 1 });
    expect(stale.status).toBe(409);
    expect(stale.json.message).toMatch(/admin@test.local saved this notebook after you opened it/);
    expect(stale.json.details).toMatchObject({ version: 2 });
    expect((await api('GET', `/api/workspaces/${wsId}/notebooks`, undefined, viewerJwt)).json.notebooks[0]).toMatchObject({ title: 'Revenue 2026', cell_count: 6, sql_cells: 3 });
  });

  it('runs cells, saves editors\' outputs, and runs everything in order', async () => {
    const id = (await api('GET', `/api/workspaces/${wsId}/notebooks`)).json.notebooks[0].id;
    const r = (await api('POST', `/api/notebooks/${id}/cells/c3/run`, {})).json;
    expect(r.refs).toEqual(['orders_2026', 'by_region']);
    expect(r.output).toMatchObject({ row_count: 1, error: null, rows: [['EU', 170, 2]] });
    expect(r.saved).toBe(true);
    expect((await api('GET', `/api/notebooks/${id}`)).json.notebook.cells.find((c: { id: string }) => c.id === 'c3').output.rows).toEqual([['EU', 170, 2]]);
    // With the inputs on screen (unsaved): US; viewers run, their outputs are not saved.
    const onScreen = CELLS.map((c) => (c.id === 'region' ? { ...c, input: { ...c.input!, value: 'US' } } : c));
    const v = (await api('POST', `/api/notebooks/${id}/cells/c3/run`, { cells: onScreen }, viewerJwt)).json;
    expect(v.output.rows).toEqual([['US', 280, 2]]);
    expect(v.saved).toBe(false);
    expect((await api('GET', `/api/notebooks/${id}`)).json.notebook.cells.find((c: { id: string }) => c.id === 'c3').output.rows).toEqual([['EU', 170, 2]]);
    // Saving the notebook keeps outputs the client echoes, never ones it invents.
    const nb = (await api('GET', `/api/notebooks/${id}`)).json.notebook;
    const forged = nb.cells.map((c: Record<string, any>) => (c.id === 'c2' ? { ...c, output: { rows: [['fake']] } } : c));
    const after = (await api('PATCH', `/api/notebooks/${id}`, { cells: forged, version: nb.version })).json.notebook;
    expect(after.cells.find((c: { id: string }) => c.id === 'c2').output).toBeNull();
    expect(after.cells.find((c: { id: string }) => c.id === 'c3').output.rows).toEqual([['EU', 170, 2]]);
    // Run all: every SQL cell, stopping at the first error.
    const all = (await api('POST', `/api/notebooks/${id}/run`, {})).json;
    expect(all).toMatchObject({ ran: 3, failed: null });
    expect(all.outputs.c2.rows).toEqual([['EU', 170, 2], ['US', 280, 2]]);
    await api('PATCH', `/api/notebooks/${id}`, { cells: [...after.cells.slice(0, 4), { id: 'bad', type: 'sql', name: 'bad', source: 'SELECT nope FROM orders' }, ...after.cells.slice(4)] });
    const broken = (await api('POST', `/api/notebooks/${id}/run`, {})).json;
    expect(broken).toMatchObject({ ran: 2, failed: 'bad' });
    expect(broken.outputs.bad.error).toMatch(/nope/);
  });

  it('applies access policies inside referenced cells', async () => {
    const id = (await api('GET', `/api/workspaces/${wsId}/notebooks`)).json.notebooks[0].id;
    await ctx.policies.create(admin, wsId, { name: 'Viewers: EU', table_name: 'orders', row_filter: "region = 'EU'", applies_to: { roles: ['VIEWER'] } });
    const v = (await api('POST', `/api/notebooks/${id}/cells/c2/run`, {}, viewerJwt)).json;
    expect(v.output.rows).toEqual([['EU', 170, 2]]);
  });

  it('exports Markdown', async () => {
    const id = (await api('GET', `/api/workspaces/${wsId}/notebooks`)).json.notebooks[0].id;
    const md = await api('GET', `/api/notebooks/${id}/export.md`);
    expect(md.json.text).toMatch(/^<!-- DuckView notebook "Revenue 2026"/);
    expect(md.json.text).toContain('# Revenue by region');
    expect(md.json.text).toContain('- **Region** (`{{ region }}`): EU');
    expect(md.json.text).toContain('```sql\n-- by_region\nSELECT region');
    expect(md.json.text).toContain('-- picked\nSELECT * FROM by_region WHERE region = {{ region }}\n```\n\n| region | revenue | n |\n| --- | --- | --- |\n| EU | 170 | 2 |');
    expect(md.json.text).toMatch(/> Error: .*nope/);
  });

  it('serves notebooks to agents, with approval for cells that write, and to Copilot', async () => {
    const env: ToolEnv = { ctx, principal: ctx.auth.principalFromUser((await ctx.auth.findByEmail('admin@test.local'))!, 'token'), via: 'mcp', defaultWorkspaceId: wsId, agent: null };
    const tools = buildTools(ctx.cfg);
    const call = (name: string, args: Record<string, unknown>) => runTool(env, tools.find((t) => t.name === name)!, args);
    const created = await call('create_notebook', { title: 'Agent analysis', cells: [{ type: 'markdown', source: 'Orders per region' }, { type: 'sql', name: 'per_region', source: 'SELECT region, count(*) AS n FROM orders GROUP BY 1 ORDER BY 1' }, { type: 'sql', name: 'top', source: 'SELECT * FROM per_region ORDER BY n DESC LIMIT 1' }] });
    expect(created.structuredContent).toMatchObject({ status: 'ok', failed: null });
    const nbId = (created.structuredContent as { notebook_id: string }).notebook_id;
    const read = await call('get_notebook', { notebook_id: nbId });
    expect((read.content[0] as { text: string }).text).toMatch(/\[sql [\w-]+\] top\n```sql\nSELECT \* FROM per_region[\s\S]*1 rows\n\| region \| n \|\n\| EU \| 3 \|/);
    expect(((await call('list_notebooks', {})).structuredContent as { notebooks: { title: string }[] }).notebooks.map((n) => n.title)).toContain('Agent analysis');
    // A cell that writes needs a person's approval.
    await ctx.notebooks.update(admin, nbId, { cells: [...(await ctx.notebooks.get(admin, nbId)).cells, { type: 'sql', name: 'snap', source: 'CREATE OR REPLACE TABLE orders_snapshot AS SELECT * FROM orders' }] });
    const blocked = await call('run_notebook', { notebook_id: nbId });
    expect(blocked.structuredContent).toMatchObject({ status: 'approval_required' });
    expect((await call('run_notebook', { notebook_id: nbId, dry_run: false })).structuredContent).toMatchObject({ status: 'ok', ran: 3 });
    expect((await ctx.queries.run(admin, wsId, 'SELECT count(*) FROM orders_snapshot', { cache: false })).rows[0]).toEqual([5]);
    // Copilot sees the notebook on screen.
    const snap = await ctx.copilot.buildContext(admin, wsId, { notebookId: nbId });
    expect(snap.notebook).toMatch(/Notebook "Agent analysis"[\s\S]*- sql cell top: SELECT \* FROM per_region ORDER BY n DESC LIMIT 1 → 1 rows \(region VARCHAR, n BIGINT\)/);
    expect(ctx.copilot.renderContextText(snap)).toMatch(/### The notebook open on screen/);
  });
});
