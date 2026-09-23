/**
 * Catalog notes (descriptions, tags) and lineage: the graph from sources through syncs, tables and views to saved
 * queries, dashboards (grid and Mosaic), alerts, apps and snapshots — SQL read with DuckDB's parser, CTEs excluded —
 * notes reaching Copilot and inspect_schema, and OpenLineage events for sync runs.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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
import type { Principal } from '../services/principal.js';

let dir: string;
let ctx: AppContext;
let app: Awaited<ReturnType<typeof buildApp>>['app'];
let base: string;
let jwt: string;
let viewerJwt: string;
let wsId: string;
let admin: Principal;
const events: Record<string, any>[] = [];
let receiver: http.Server;

const api = async (method: string, url: string, body?: unknown, token = jwt) => {
  const res = await fetch(base + url, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
};

beforeAll(async () => {
  initLogger({ level: 'silent', stderr: true, pretty: false });
  receiver = http.createServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { events.push({ path: req.url, auth: req.headers.authorization, ...JSON.parse(b) }); res.writeHead(201); res.end(); }); });
  await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dv-lineage-'));
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'data', 'targets.csv'), 'region,target\nEU,100\n');
  const cfg = loadConfig({ configPath: null, env: { DUCKVIEW_DATA_DIR: path.join(dir, 'data'), DUCKVIEW_FILESYSTEM_MODE: 'full', DUCKDB_TEMP_DIRECTORY: path.join(dir, 'spill'), DATABASE_URL: ':memory:', DUCKDB_MEMORY_LIMIT: '512MB', DUCKVIEW_ADMIN_EMAIL: 'admin@test.local', DUCKVIEW_ADMIN_PASSWORD: 'super-secret-pw', DUCKVIEW__duckdb__sync_scheduler_enabled: 'false', DUCKVIEW__notifications__scheduler_enabled: 'false', DUCKVIEW__apps__enabled: 'false', DUCKVIEW__lineage__openlineage_url: `http://127.0.0.1:${(receiver.address() as net.AddressInfo).port}/api/v1/lineage`, DUCKVIEW__lineage__openlineage_api_key: 'ol-key', LOG_LEVEL: 'silent' } });
  ctx = await createContext(cfg);
  admin = ctx.auth.principalFromUser((await ctx.auth.findByEmail('admin@test.local'))!, 'jwt', '127.0.0.1');
  const viewer = await ctx.auth.createLocalUser({ email: 'viewer@test.local', password: 'viewer-secret-pw', role: 'USER' });
  wsId = (await ctx.workspaces.create(admin, { name: 'Shop', active_db_path: 'shop.duckdb' })).id;
  await ctx.workspaces.setMember(admin, wsId, { subject_type: 'user', subject_id: viewer.id, role: 'VIEWER' });
  ({ app } = await buildApp(ctx));
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as net.AddressInfo).port}`;
  jwt = (await api('POST', '/api/auth/login', { email: 'admin@test.local', password: 'super-secret-pw' }, '')).json.token;
  viewerJwt = (await api('POST', '/api/auth/login', { email: 'viewer@test.local', password: 'viewer-secret-pw' }, '')).json.token;
});

afterAll(async () => {
  await app.close();
  await ctx.shutdown();
  receiver.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('lineage', () => {
  it('draws the graph from sources to consumers and emits OpenLineage events for syncs', async () => {
    // A sync loads orders; a view and everything else read it.
    const sync = await ctx.syncs.create(admin, wsId, { name: 'Load orders', source: { kind: 'sql', sql: "SELECT * FROM (VALUES (1, 'EU', 120.0), (2, 'US', 80.0)) t(id, region, amount)" }, target_table: 'orders', schedule: { kind: 'manual' } });
    const run = await ctx.syncs.run(sync.id, 'manual', admin.userId);
    expect(run.status).toBe('ok');
    const q = (sql: string) => ctx.queries.run(admin, wsId, sql, { cache: false });
    await q('CREATE VIEW order_totals AS SELECT region, sum(amount) AS total FROM orders GROUP BY region');
    await q('CREATE TABLE customers AS SELECT 1 AS id');
    const saved = await ctx.savedQueries.create(admin, wsId, { name: 'Targets vs actual', sql_text: "WITH t AS (SELECT * FROM read_csv('targets.csv')) SELECT * FROM t JOIN order_totals USING (region)" });
    const grid = await ctx.dashboards.create(admin, wsId, { name: 'Sales', kind: 'grid' });
    await ctx.dashboards.addWidget(admin, grid.id, { title: 'Revenue', widget_type: 'KPI', custom_sql: 'SELECT sum(amount) FROM orders', chart_config: {} });
    await ctx.dashboards.addWidget(admin, grid.id, { title: 'Targets', widget_type: 'TABLE', saved_query_id: saved.id, chart_config: {} });
    const mosaic = await ctx.dashboards.create(admin, wsId, { name: 'Explore', kind: 'mosaic', spec: { data: { o: { query: 'SELECT * FROM orders o JOIN customers c ON o.id = c.id' } }, plot: [{ mark: 'barY', data: { from: 'o' }, x: 'region', y: 'amount' }] } });
    const alert = (await api('POST', `/api/workspaces/${wsId}/alerts`, { name: 'Big order', sql: 'SELECT * FROM orders WHERE amount > 1000', condition: { kind: 'rows' }, schedule: { kind: 'manual' } })).json.alert;
    const appRow = await ctx.apps.create(admin, wsId, { name: 'Order app', files: { 'app.py': 'import streamlit as st\nfrom duckview.streamlit import query\nst.dataframe(query("SELECT * FROM order_totals"))\n' } });
    const snap = (await api('POST', `/api/workspaces/${wsId}/snapshots`, { target: { kind: 'dashboard', dashboard_id: grid.id }, schedule: { kind: 'manual' } })).json.snapshot;

    const g = (await api('GET', `/api/workspaces/${wsId}/lineage`, undefined, viewerJwt)).json as { nodes: { id: string; kind: string; label: string }[]; edges: { from: string; to: string; kind: string }[] };
    const has = (from: string, to: string, kind: string) => g.edges.some((e) => e.from === from && e.to === to && e.kind === kind);
    expect(has(`sync:${sync.id}`, 'table:orders', 'loads')).toBe(true);
    expect(has('table:orders', 'view:order_totals', 'reads')).toBe(true);
    expect(has('file:targets.csv', `saved_query:${saved.id}`, 'reads')).toBe(true);
    expect(has('view:order_totals', `saved_query:${saved.id}`, 'reads')).toBe(true);
    expect(has('table:orders', `dashboard:${grid.id}`, 'reads')).toBe(true);
    expect(has(`saved_query:${saved.id}`, `dashboard:${grid.id}`, 'reads')).toBe(true);
    expect(has('table:orders', `dashboard:${mosaic.id}`, 'reads')).toBe(true);
    expect(has('table:customers', `dashboard:${mosaic.id}`, 'reads')).toBe(true);
    expect(has('table:orders', `alert:${alert.id}`, 'reads')).toBe(true);
    expect(has('view:order_totals', `app:${appRow.id}`, 'mentions')).toBe(true);
    expect(has(`dashboard:${grid.id}`, `snapshot:${snap.id}`, 'renders')).toBe(true);
    // A CTE is not a table.
    expect(g.nodes.some((n) => n.label === 't')).toBe(false);
    expect(g.nodes.find((n) => n.id === 'table:orders')).toMatchObject({ kind: 'table', label: 'orders' });

    // OpenLineage: START and COMPLETE for the run, authenticated, with the output's row count.
    await new Promise((r) => setTimeout(r, 200));
    const mine = events.filter((e) => e.job?.name === 'sync.Load orders');
    expect(mine.map((e) => e.eventType)).toEqual(['START', 'COMPLETE']);
    expect(mine[1]).toMatchObject({ path: '/api/v1/lineage', auth: 'Bearer ol-key', run: { runId: run.id }, job: { namespace: 'duckview', facets: { sql: { query: expect.stringContaining('VALUES') } } }, outputs: [{ namespace: `duckview:${wsId}`, name: 'main.orders', outputFacets: { outputStatistics: { rowCount: 2 } } }] });
    expect(mine[1].schemaURL).toMatch(/openlineage\.io\/spec/);
  });

  it('keeps descriptions and tags that Copilot and agents read', async () => {
    const put = (body: Record<string, unknown>, token = jwt) => api('PUT', `/api/workspaces/${wsId}/catalog/annotations`, body, token);
    expect((await put({ object_name: 'orders', description: 'Orders placed on the web shop, one row per order', tags: ['Sales', 'bad tag!'] })).json.annotation).toMatchObject({ tags: ['sales'] });
    await put({ object_name: 'orders', column_name: 'amount', description: 'Net amount in EUR, after discounts', tags: ['currency'] });
    expect((await put({ object_name: 'orders', description: 'x' }, viewerJwt)).status).toBe(403);
    const cat = (await api('GET', `/api/workspaces/${wsId}/catalog/annotated`, undefined, viewerJwt)).json.objects as { name: string; description: string; tags: string[]; columns: { name: string; description: string | null }[] }[];
    const orders = cat.find((o) => o.name === 'orders')!;
    expect(orders).toMatchObject({ description: 'Orders placed on the web shop, one row per order', tags: ['sales'] });
    expect(orders.columns.find((c) => c.name === 'amount')!.description).toBe('Net amount in EUR, after discounts');
    // Copilot's context carries the notes.
    const snap = await ctx.copilot.buildContext(admin, wsId);
    expect(snap.notes).toMatch(/- orders — Orders placed on the web shop, one row per order \[sales\]\n  amount: Net amount in EUR, after discounts \[currency\]/);
    expect(ctx.copilot.renderContextText(snap)).toMatch(/catalog notes/);
    // So does inspect_schema.
    const env: ToolEnv = { ctx, principal: admin, via: 'rest', defaultWorkspaceId: wsId, agent: null };
    const r = await runTool(env, buildTools(ctx.cfg).find((t) => t.name === 'inspect_schema')!, { file_path_or_table: 'orders' });
    expect((r.content[0] as { text: string }).text).toMatch(/Orders placed on the web shop[\s\S]*\*\*amount\*\*: Net amount in EUR/);
    // An empty description and no tags removes the note.
    expect((await put({ object_name: 'orders', column_name: 'amount', description: '', tags: [] })).json.annotation).toBeNull();
    expect((await api('GET', `/api/workspaces/${wsId}/catalog/annotated`)).json.objects.find((o: { name: string }) => o.name === 'orders').columns.find((c: { name: string }) => c.name === 'amount').description).toBeNull();
  });
});
