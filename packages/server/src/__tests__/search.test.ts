import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../config/index.js';
import { initLogger } from '../observability/logger.js';
import { createContext, type AppContext } from '../context.js';
import type { Principal } from '../services/principal.js';

let dir: string;
let ctx: AppContext;
let admin: Principal;
let ws: string;

beforeAll(async () => {
  initLogger({ level: 'silent', stderr: true, pretty: false });
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dv-search-')));
  const cfg = loadConfig({ configPath: null, env: { DUCKVIEW_DATA_DIR: path.join(dir, 'data'), DUCKVIEW_FILESYSTEM_MODE: 'sandboxed', DUCKDB_TEMP_DIRECTORY: path.join(dir, 'spill'), DATABASE_URL: ':memory:', DUCKDB_MEMORY_LIMIT: '1GB', DUCKVIEW_ADMIN_EMAIL: 'admin@test.local', DUCKVIEW_ADMIN_PASSWORD: 'super-secret-pw', LOG_LEVEL: 'silent' } });
  ctx = await createContext(cfg);
  admin = ctx.auth.principalFromUser((await ctx.auth.findByEmail('admin@test.local'))!, 'jwt', '127.0.0.1');
  ws = (await ctx.workspaces.create(admin, { name: 'Search', active_db_path: 'search.duckdb' })).id;
  await ctx.queries.run(admin, ws, 'CREATE TABLE orders AS SELECT range AS order_id, range * 2.5 AS revenue, range % 3 AS region_id FROM range(10)');
  await ctx.queries.run(admin, ws, "CREATE TABLE customers AS SELECT range AS id, 'x' AS contact_email FROM range(3)");
  await ctx.lineage.annotate(admin, ws, { object_name: 'customers', description: 'Everyone who ever bought from us', tags: ['crm'] });
  await ctx.lineage.annotate(admin, ws, { object_name: 'customers', column_name: 'contact_email', tags: ['pii'] });
  fs.writeFileSync(path.join(dir, 'data', 'revenue_2026.csv'), 'a\n1\n');
  await ctx.savedQueries.create(admin, ws, { name: 'Weekly totals', sql_text: 'SELECT sum(revenue) FROM orders', tags: [] });
  const d = await ctx.dashboards.create(admin, ws, { name: 'Board pack' });
  await ctx.dashboards.addWidget(admin, d.id, { title: 'Net revenue', widget_type: 'KPI', custom_sql: 'SELECT sum(revenue) AS n FROM orders', chart_config: { value: 'n' } });
  await ctx.notebooks.create(admin, ws, { title: 'Churn study', cells: [{ type: 'markdown', source: 'Why customers leave' }] });
});

afterAll(async () => {
  await ctx?.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('workspace search', () => {
  it('finds a word everywhere it appears, names first', async () => {
    const hits = await ctx.search.search(admin, ws, 'revenue');
    const kinds = hits.map((h) => `${h.kind}:${h.title}:${h.match}`);
    expect(kinds).toContain('column:revenue:name');
    expect(kinds).toContain('file:revenue_2026.csv:name');
    expect(kinds).toContain('query:Weekly totals:content');
    expect(kinds).toContain('dashboard:Board pack:description'); // a widget is titled "Net revenue"
    expect(hits.findIndex((h) => h.match === 'name')).toBeLessThan(hits.findIndex((h) => h.match === 'content'));
  });

  it('finds tables by description and tag, columns by tag, notebooks by their cells', async () => {
    expect((await ctx.search.search(admin, ws, 'bought')).map((h) => h.title)).toEqual(['customers']);
    expect((await ctx.search.search(admin, ws, 'pii')).map((h) => `${h.kind}:${h.id}`)).toEqual(['column:customers.contact_email']);
    const nb = await ctx.search.search(admin, ws, 'customers leave');
    expect(nb[0]).toMatchObject({ kind: 'notebook', title: 'Churn study', match: 'content' });
    expect(nb[0]!.snippet).toContain('customers leave');
  });

  it('needs every word, and narrows by kind', async () => {
    expect(await ctx.search.search(admin, ws, 'revenue banana')).toEqual([]);
    const onlyTables = await ctx.search.search(admin, ws, 'o', { kinds: ['table'] });
    expect(onlyTables.every((h) => h.kind === 'table')).toBe(true);
  });
});
