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
let jwt: string;
let ws: string;

const api = async (method: string, url: string, body?: unknown, headers: Record<string, string> = { authorization: `Bearer ${jwt}` }) => {
  const res = await fetch(base + url, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: Record<string, any> = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json, text, headers: res.headers };
};

import { renderPack } from '../agent/context/engine.js';
import type { ContextObject } from '../agent/context/types.js';

let viewerJwt: string;
const YAML = `
semantic_models:
  - name: orders
    table: customer_orders
    default_time_dimension: order_date
    entities:
      - { name: order, type: primary, expr: order_id }
    dimensions:
      - { name: order_date, type: time, granularity: day }
      - { name: region, type: categorical }
    measures:
      - { name: revenue, agg: sum, expr: amount }
metrics:
  - { name: arr, label: Annual recurring revenue, description: Canonical ARR, type: simple, measure: revenue }
`;

beforeAll(async () => {
  initLogger({ level: 'silent', stderr: true, pretty: false });
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dv-ctxeng-')));
  const cfg = loadConfig({ configPath: null, env: { DUCKVIEW_DATA_DIR: path.join(dir, 'data'), DUCKVIEW_FILESYSTEM_MODE: 'sandboxed', DUCKDB_TEMP_DIRECTORY: path.join(dir, 'spill'), DATABASE_URL: ':memory:', DUCKDB_MEMORY_LIMIT: '1GB', DUCKVIEW_ADMIN_EMAIL: 'admin@test.local', DUCKVIEW_ADMIN_PASSWORD: 'super-secret-pw', LOG_LEVEL: 'silent' } });
  ctx = await createContext(cfg);
  ({ app } = await buildApp(ctx));
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  jwt = ((await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@test.local', password: 'super-secret-pw' }) })).json()) as { token: string }).token;
  ws = (await api('POST', '/api/workspaces', { name: 'Ctx', active_db_path: 'ctx.duckdb' })).json.workspace.id;
  for (const sql of [
    "CREATE TABLE customer_orders AS SELECT * FROM (VALUES (1, DATE '2026-01-01', 'EU', 10.0), (2, DATE '2026-01-02', 'US', 20.0)) t(order_id, order_date, region, amount)",
    'CREATE TABLE inventory (sku VARCHAR, warehouse VARCHAR, stock INTEGER)',
    'CREATE TABLE player_tracking (player_id INTEGER, x DOUBLE, y DOUBLE, speed DOUBLE)',
  ]) expect((await api('POST', `/api/workspaces/${ws}/query`, { sql })).status).toBe(200);
  expect((await api('PUT', `/api/workspaces/${ws}/semantic`, { yaml: YAML })).status).toBe(200);
  const d = await api('POST', `/api/workspaces/${ws}/dashboards`, { name: 'Revenue overview' });
  expect(d.status).toBe(200);
  await api('POST', '/api/admin/users', { email: 'viewer@test.local', password: 'viewer-secret-pw', role: 'USER' });
  viewerJwt = ((await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'viewer@test.local', password: 'viewer-secret-pw' }) })).json()) as { token: string }).token;
});

afterAll(async () => {
  await app?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const admin = async () => ctx.auth.principalFromUser((await ctx.auth.findByEmail('admin@test.local'))!, 'jwt');

describe('context engine', () => {
  it('discovers structured objects from the workspace services', async () => {
    const objs = await ctx.contextEngine.discover(await admin(), ws);
    const ids = objs.map((o) => o.id).sort();
    expect(ids).toEqual(expect.arrayContaining(['table:customer_orders', 'table:inventory', 'table:player_tracking', 'metric:arr', 'semantic_model:orders']));
    expect(ids.some((i) => i.startsWith('dashboard:'))).toBe(true);
    const t = objs.find((o) => o.id === 'table:customer_orders')!;
    expect(t.text).toContain('columns: order_id INTEGER; order_date DATE; region VARCHAR; amount DECIMAL(3,1)');
    expect(objs.find((o) => o.id === 'metric:arr')!.text).toMatch(/^metric arr \("Annual recurring revenue"\) — Canonical ARR; simple \(measure revenue\); group by: .*region/);
  });

  it('packs what is relevant within the budget, prefers the canonical metric, and pins the page', async () => {
    const pack = await ctx.contextEngine.pack(await admin(), ws, { request: 'What is ARR by region?', budget: { maxObjects: 3, maxTokens: 2000 } });
    const ids = pack.objects.map((o) => o.id);
    expect(ids.length).toBeLessThanOrEqual(3);
    expect(ids).toContain('metric:arr');
    expect(ids).not.toContain('table:inventory');
    expect(pack.semanticContext).toMatchObject({ preferMetrics: true, matched: ['arr'] });
    expect(pack.stats.considered).toBeGreaterThan(pack.stats.selected);
    expect(pack.stats.tokens).toBeLessThanOrEqual(2000);
    const text = renderPack(pack);
    expect(text).toContain('### Metrics of the semantic layer');
    expect(text).toContain('Answer with query_metrics on the defined metric');
    expect(text).toMatch(/other objects of this workspace are not shown/);

    const onPage = await ctx.contextEngine.pack(await admin(), ws, { request: 'Profile this', page: { kind: 'dataset', id: 'player_tracking', label: 'player_tracking' }, budget: { maxObjects: 2 } });
    expect(onPage.objects.map((o) => o.id)).toEqual(['page:dataset:player_tracking', 'table:player_tracking']);
    expect(onPage.semanticContext.preferMetrics).toBe(false);
  });

  it('keeps observations within their budget', async () => {
    const obs = (n: number): ContextObject => ({ id: `observation:${n}`, type: 'observation', workspaceId: ws, source: 'task', title: 'found', text: `revenue by region observation ${n}`, content: null, metadata: {}, timestamp: new Date().toISOString() });
    const pack = await ctx.contextEngine.pack(await admin(), ws, { request: 'revenue by region', extra: [obs(1), obs(2), obs(3)], budget: { maxObservations: 2, maxObjects: 20 } });
    expect(pack.objects.filter((o) => o.type === 'observation').length).toBe(2);
  });

  it('reads again after the workspace data changes, and refuses people without access', async () => {
    const p = await admin();
    await ctx.contextEngine.discover(p, ws);
    expect((await api('POST', `/api/workspaces/${ws}/query`, { sql: 'CREATE TABLE churn_scores (customer_id INTEGER, score DOUBLE)' })).status).toBe(200);
    const after = await ctx.contextEngine.discover(p, ws);
    expect(after.map((o) => o.id)).toContain('table:churn_scores');
    const viewer = ctx.auth.principalFromUser((await ctx.auth.findByEmail('viewer@test.local'))!, 'jwt');
    await expect(ctx.contextEngine.discover(viewer, ws)).rejects.toThrow();
    expect(viewerJwt).toBeTruthy();
  });

  it('puts the tables that matter first in Copilot when the catalog is large', async () => {
    const snapshot = { workspace_id: ws, tables: Array.from({ length: 60 }, (_, i) => ({ name: `t_${String(i).padStart(2, '0')}`, type: 'TABLE', columns: [{ name: 'x', type: 'INT' }] })).concat([{ name: 'player_tracking', type: 'TABLE', columns: [{ name: 'speed', type: 'DOUBLE' }] }]), files: [], buckets: [], active_sql: null };
    await (ctx.copilot as unknown as { focusTables(s: typeof snapshot, q: string, pinned: string[]): Promise<void> }).focusTables(snapshot, 'average player speed', ['t_59']);
    expect(snapshot.tables.slice(0, 2).map((t) => t.name)).toEqual(['t_59', 'player_tracking']);
    const small = { ...snapshot, tables: Array.from({ length: 5 }, (_, i) => ({ name: `t_${String(i).padStart(2, '0')}`, type: 'TABLE', columns: [{ name: 'x', type: 'INT' }] })) };
    await (ctx.copilot as unknown as { focusTables(s: typeof snapshot, q: string, pinned: string[]): Promise<void> }).focusTables(small, 'player', []);
    expect(small.tables.map((t) => t.name)).toEqual(['t_00', 't_01', 't_02', 't_03', 't_04']);
  });
});
