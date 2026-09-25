import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../config/index.js';
import { initLogger } from '../observability/logger.js';
import { createContext, type AppContext } from '../context.js';
import { buildTools, type ToolDef, type ToolEnv } from '../agent/tools.js';
import type { Principal } from '../services/principal.js';

let dir: string;
let ctx: AppContext;
let tools: Map<string, ToolDef>;
let admin: Principal;
let ws: string;

const call = async (name: string, args: Record<string, unknown>, principal: Principal = admin) => {
  const t = tools.get(name)!;
  expect(t, name).toBeTruthy();
  const env: ToolEnv = { ctx, principal, defaultWorkspaceId: ws, via: 'rest' };
  try {
    return await t.handler(env, args as never);
  } catch (err) {
    return { error: err as Error & { code?: string; challenge?: { status: string } } } as never;
  }
};

beforeAll(async () => {
  initLogger({ level: 'silent', stderr: true, pretty: false });
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dv-tools2-')));
  const cfg = loadConfig({ configPath: null, env: { DUCKVIEW_DATA_DIR: path.join(dir, 'data'), DUCKVIEW_FILESYSTEM_MODE: 'sandboxed', DUCKDB_TEMP_DIRECTORY: path.join(dir, 'spill'), DATABASE_URL: ':memory:', DUCKDB_MEMORY_LIMIT: '1GB', DUCKVIEW_ADMIN_EMAIL: 'admin@test.local', DUCKVIEW_ADMIN_PASSWORD: 'super-secret-pw', LOG_LEVEL: 'silent' } });
  ctx = await createContext(cfg);
  tools = new Map(buildTools(cfg).map((t) => [t.name, t]));
  admin = ctx.auth.principalFromUser((await ctx.auth.findByEmail('admin@test.local'))!, 'jwt', '127.0.0.1');
  ws = (await ctx.workspaces.create(admin, { name: 'Tools', active_db_path: 'tools.duckdb' })).id;
  await ctx.queries.run(admin, ws, "CREATE TABLE customers AS SELECT range AS id, 'c' || range || '@example.com' AS email, range * 10 AS lifetime_value FROM range(5)");
  await ctx.queries.run(admin, ws, 'CREATE VIEW top_customers AS SELECT * FROM customers ORDER BY lifetime_value DESC LIMIT 3');
});

afterAll(async () => {
  await ctx?.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('agent tools for saved queries, the catalog and lineage', () => {
  it('saves, lists and reads saved queries; refuses writes', async () => {
    const saved = await call('save_query', { name: 'Customer value', sql: 'SELECT id, lifetime_value FROM customers', folder: 'Sales', tags: ['finance'] });
    expect((saved.structuredContent as { columns: string[] }).columns).toEqual(['id', 'lifetime_value']);
    const bad = await call('save_query', { name: 'Evil', sql: 'DROP TABLE customers' });
    expect((bad as unknown as { error: Error }).error.message).toMatch(/read-only/);
    expect((await ctx.queries.run(admin, ws, 'SELECT count(*) FROM customers')).rows[0]).toEqual([5]); // never ran
    const list = await call('list_saved_queries', { search: 'finance' });
    expect((list.structuredContent as { queries: { name: string }[] }).queries.map((q) => q.name)).toEqual(['Customer value']);
    const one = await call('get_saved_query', { query: 'customer value' });
    expect((one.structuredContent as { query: { sql: string } }).query.sql).toBe('SELECT id, lifetime_value FROM customers');
  });

  it('documents tables and finds them by meaning', async () => {
    await call('annotate_table', { object: 'customers', column: 'email', description: 'Where we reach the customer', tags: ['pii'] });
    const found = await call('search_catalog', { query: 'pii' });
    expect((found.structuredContent as { matches: { object: string; column: string | null }[] }).matches[0]).toMatchObject({ object: 'customers', column: 'email' });
    const byMeaning = await call('search_catalog', { query: 'reach customer' });
    expect((byMeaning.structuredContent as { matches: unknown[] }).matches.length).toBeGreaterThan(0);
  });

  it('follows lineage around a table', async () => {
    const r = await call('get_lineage', { object: 'customers' });
    const s = r.structuredContent as { downstream: { to: string }[] };
    expect(s.downstream.some((d) => /top_customers|Customer value/.test(d.to))).toBe(true);
  });
});

describe('agent tools for dashboards, metrics, workspaces, streams and Git', () => {
  it('reads a dashboard, edits a widget and removes one only with approval', async () => {
    const d = await ctx.dashboards.create(admin, ws, { name: 'Sales' });
    const { widget } = await ctx.dashboards.addWidget(admin, d.id, { title: 'Customers', widget_type: 'KPI', custom_sql: 'SELECT count(*) AS n FROM customers', chart_config: { value: 'n' } });
    const got = await call('get_dashboard', { dashboard: 'sales' });
    expect((got.structuredContent as { dashboard: { widgets: { id: string }[] } }).dashboard.widgets[0]!.id).toBe(widget.id);
    await call('update_widget', { dashboard: d.id, widget_id: widget.id, title: 'Customer count' });
    expect((await ctx.dashboards.get(admin, d.id)).widgets[0]!.title).toBe('Customer count');
    const agent: Principal = { ...admin, actorType: 'AGENT' };
    const held = await call('remove_widget', { dashboard: d.id, widget_id: widget.id }, agent);
    expect((held as unknown as { error: { code: string } }).error.code).toBe('APPROVAL_REQUIRED');
    expect((await ctx.dashboards.get(admin, d.id)).widgets).toHaveLength(1);
    await call('remove_widget', { dashboard: d.id, widget_id: widget.id, dry_run: false }, agent);
    expect((await ctx.dashboards.get(admin, d.id)).widgets).toHaveLength(0);
  });

  it('defines metrics after approval', async () => {
    const yaml = 'semantic_models:\n  - name: customers\n    table: customers\n    entities: [{ name: id, type: primary }]\n    measures: [{ name: value, agg: sum, expr: lifetime_value }]\nmetrics:\n  - name: total_value\n    type: simple\n    measure: value\n';
    const agent: Principal = { ...admin, actorType: 'AGENT' };
    const held = await call('define_metric', { yaml }, agent);
    expect((held as unknown as { error: { code: string } }).error.code).toBe('APPROVAL_REQUIRED');
    const ok = await call('define_metric', { yaml, dry_run: false }, agent);
    expect((ok.structuredContent as { metrics: string[] }).metrics).toContain('total_value');
    const q = await call('query_metrics', { metrics: ['total_value'] });
    expect(JSON.stringify(q.structuredContent)).toContain('100');
  });

  it('reports health and takes and lists backups', async () => {
    const h = await call('workspace_health', {});
    expect((h.structuredContent as { checks: { id: string }[] }).checks.some((c) => c.id === 'engine')).toBe(true);
    const b = await call('backup_workspace', { note: 'before a change' });
    expect((b.structuredContent as { backup: { tables: number } }).backup.tables).toBe(1);
    const list = await call('list_backups', {});
    expect((list.structuredContent as { backups: { note: string }[] }).backups[0]!.note).toBe('before a change');
  });

  it('creates an HTTP stream after approval and says when Git is not connected', async () => {
    const agent: Principal = { ...admin, actorType: 'AGENT' };
    const held = await call('create_stream', { name: 'Events', kind: 'http', target_table: 'events' }, agent);
    expect((held as unknown as { error: { code: string } }).error.code).toBe('APPROVAL_REQUIRED');
    const s = await call('create_stream', { name: 'Events', kind: 'http', target_table: 'events', dry_run: false }, agent);
    expect((s.structuredContent as { push_key: string | null }).push_key).toBeTruthy();
    const g = await call('git_status', {});
    expect((g.structuredContent as { connected: boolean }).connected).toBe(false);
  });
});
