/**
 * The semantic layer: YAML definitions (MetricFlow-style), validation against the engine, metric queries — time
 * grains, joins through entities, filters, ratios, derived metrics, metrics from two semantic models — access
 * policies applying to metric queries, scaffolding from a table, the MCP tools, Copilot's context, and semantic
 * models and metrics imported from a dbt project.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { loadConfig } from '../config/index.js';
import { initLogger } from '../observability/logger.js';
import { createContext, type AppContext } from '../context.js';
import { buildApp } from '../app.js';
import { buildTools, runTool, type ToolEnv } from '../agent/tools.js';
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
let base: string;
let jwt: string;
let viewerJwt: string;
let wsId: string;
let admin: Principal;

const api = async (method: string, url: string, body?: unknown, token = jwt) => {
  const res = await fetch(base + url, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
};
const query = (body: Record<string, unknown>, token = jwt) => api('POST', `/api/workspaces/${wsId}/semantic/query`, body, token);

const DEFINITIONS = `
semantic_models:
  - name: orders
    table: orders
    description: One row per order
    default_time_dimension: order_date
    entities:
      - { name: order, type: primary, expr: order_id }
      - { name: customer, type: foreign, expr: customer_id }
    dimensions:
      - { name: order_date, type: time, granularity: day }
      - { name: region, type: categorical }
      - { name: status, type: categorical }
      - { name: size, type: categorical, expr: "case when amount >= 100 then 'large' else 'small' end" }
    measures:
      - { name: revenue, agg: sum, expr: amount }
      - { name: order_count, agg: count }
      - { name: buyers, agg: count_distinct, expr: customer_id }
  - name: customers
    table: customers
    entities:
      - { name: customer, type: primary, expr: customer_id }
    dimensions:
      - { name: tier, type: categorical, description: Loyalty tier }
      - { name: signup_date, type: time }
    default_time_dimension: signup_date
    measures:
      - { name: customer_count, agg: count }
metrics:
  - name: total_revenue
    label: Revenue
    description: Revenue of completed orders
    type: simple
    measure: revenue
    filter: "{{ Dimension('order__status') }} = 'complete'"
  - { name: orders, label: Orders, type: simple, measure: order_count }
  - { name: aov, label: Average order value, type: ratio, numerator: total_revenue, denominator: orders }
  - name: revenue_k
    type: derived
    expr: rev / 1000
    metrics: [{ name: total_revenue, alias: rev }]
  - { name: customers, label: Customers, type: simple, measure: customer_count }
  - { name: revenue_per_customer, type: derived, expr: total_revenue / customers }
`;

beforeAll(async () => {
  initLogger({ level: 'silent', stderr: true, pretty: false });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dv-semantic-'));
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  const cfg = loadConfig({ configPath: null, env: { DUCKVIEW_DATA_DIR: path.join(dir, 'data'), DUCKDB_TEMP_DIRECTORY: path.join(dir, 'spill'), DATABASE_URL: ':memory:', DUCKDB_MEMORY_LIMIT: '512MB', DUCKVIEW_ADMIN_EMAIL: 'admin@test.local', DUCKVIEW_ADMIN_PASSWORD: 'super-secret-pw', DUCKVIEW__duckdb__sync_scheduler_enabled: 'false', DUCKVIEW__notifications__scheduler_enabled: 'false', DUCKVIEW__transform__scheduler_enabled: 'false', DUCKVIEW__apps__enabled: 'false', DUCKVIEW__transform__dbt__venv_dir: process.env.DUCKVIEW_TEST_DBT_VENV ?? path.join(os.tmpdir(), 'duckview-test-dbt-venv'), LOG_LEVEL: 'silent' } });
  ctx = await createContext(cfg);
  admin = ctx.auth.principalFromUser((await ctx.auth.findByEmail('admin@test.local'))!, 'jwt', '127.0.0.1');
  const viewer = await ctx.auth.createLocalUser({ email: 'viewer@test.local', password: 'viewer-secret-pw', role: 'USER' });
  wsId = (await ctx.workspaces.create(admin, { name: 'Shop', active_db_path: 'shop.duckdb' })).id;
  await ctx.workspaces.setMember(admin, wsId, { subject_type: 'user', subject_id: viewer.id, role: 'VIEWER' });
  await ctx.queries.run(admin, wsId, `CREATE TABLE customers AS SELECT * FROM (VALUES (1, 'gold', DATE '2025-06-01'), (2, 'silver', DATE '2025-07-01'), (3, 'gold', DATE '2026-01-05')) t(customer_id, tier, signup_date);
    CREATE TABLE orders AS SELECT * FROM (VALUES
      (1, 1, DATE '2026-01-03', 'EU', 120.0, 'complete'),
      (2, 2, DATE '2026-01-20', 'US', 80.0, 'complete'),
      (3, 1, DATE '2026-02-02', 'EU', 50.0, 'complete'),
      (4, 3, DATE '2026-02-15', 'US', 200.0, 'cancelled'),
      (5, 3, DATE '2026-02-20', 'EU', 30.0, 'complete')) t(order_id, customer_id, order_date, region, amount, status)`, { cache: false });
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

describe('semantic layer', () => {
  it('validates definitions against the engine before saving them', async () => {
    const bad = await api('PUT', `/api/workspaces/${wsId}/semantic`, { yaml: DEFINITIONS.replace('expr: amount', 'expr: amount_eur') });
    expect(bad.status).toBe(400);
    expect(bad.json.details.problems.join(' ')).toMatch(/semantic model orders: .*amount_eur/);
    expect((await api('PUT', `/api/workspaces/${wsId}/semantic`, { yaml: 'metrics:\n  - { name: x, type: simple, measure: nope }\n' })).json.details.problems.join(' ')).toMatch(/metric x: .*unknown measure nope/);
    expect((await api('PUT', `/api/workspaces/${wsId}/semantic`, { yaml: 'metrics: [{ name: "bad name" }]' })).json.message).toMatch(/must be an identifier/);
    expect((await api('POST', `/api/workspaces/${wsId}/semantic/validate`, { yaml: DEFINITIONS })).json).toMatchObject({ ok: true, models: 2, metrics: 6 });
    // Viewers read and query, they do not define.
    expect((await api('PUT', `/api/workspaces/${wsId}/semantic`, { yaml: DEFINITIONS }, viewerJwt)).status).toBe(403);
    const saved = await api('PUT', `/api/workspaces/${wsId}/semantic`, { yaml: DEFINITIONS });
    expect(saved.status).toBe(200);
    expect(saved.json.metrics.find((m: { name: string }) => m.name === 'total_revenue')).toMatchObject({ label: 'Revenue', source: 'workspace', dimensions: expect.arrayContaining(['metric_time', 'region', 'size', 'customer__tier']) });
  });

  it('computes metrics by time grain, across a join, with filters, ratios and derived metrics', async () => {
    const monthly = (await query({ metrics: ['total_revenue', 'orders'], group_by: ['metric_time__month'] })).json;
    expect(monthly.columns.map((c: { name: string }) => c.name)).toEqual(['metric_time__month', 'total_revenue', 'orders']);
    expect(monthly.rows.map((r: unknown[]) => [String(r[0]).slice(0, 7), r[1], r[2]])).toEqual([['2026-01', 200, 2], ['2026-02', 80, 3]]);
    // A dimension of another semantic model, reached through the customer entity; a structured filter.
    const byTier = (await query({ metrics: ['total_revenue'], group_by: ['customer__tier'], where: [{ dimension: 'region', op: 'in', value: ['EU'] }], order_by: [{ name: 'customer__tier' }] })).json;
    expect(byTier.rows).toEqual([['gold', 200]]);
    // Ratio and derived metrics, and a computed dimension.
    const ratio = (await query({ metrics: ['aov', 'revenue_k'], group_by: ['size'], order_by: [{ name: 'size' }] })).json;
    expect(ratio.rows[0]).toEqual(['large', 60, 0.12]);
    expect(ratio.rows[1][0]).toBe('small');
    expect(ratio.rows[1][1]).toBeCloseTo(160 / 3, 9);
    expect(ratio.rows[1][2]).toBeCloseTo(0.16, 9);
    // Metrics from two semantic models, joined on the shared dimension.
    const mixed = (await query({ metrics: ['revenue_per_customer', 'customers', 'orders'], group_by: ['customer__tier'], order_by: [{ name: 'customer__tier' }] })).json;
    expect(mixed.rows).toEqual([['gold', 100, 2, 4], ['silver', 80, 1, 1]]);
    expect(mixed.sql).toMatch(/FULL OUTER JOIN/);
    // Nothing to group by: one row.
    expect((await query({ metrics: ['total_revenue', 'customers'] })).json.rows).toEqual([[280, 3]]);
    // compile_only returns the SQL; errors are explicit.
    expect((await query({ metrics: ['orders'], group_by: ['region'], compile_only: true })).json.sql).toMatch(/GROUP BY ALL/);
    expect((await query({ metrics: ['orders'], group_by: ['nope'] })).json.message).toMatch(/Dimension nope cannot be reached from semantic model orders/);
    expect((await query({ metrics: ['nope'] })).json.message).toMatch(/Unknown metric nope/);
    // What a set of metrics can be grouped by.
    const dims = (await api('GET', `/api/workspaces/${wsId}/semantic/dimensions?metrics=total_revenue,customers`)).json.dimensions.map((d: { name: string }) => d.name);
    expect(dims).toEqual(expect.arrayContaining(['metric_time', 'customer__tier']));
    expect(dims).not.toContain('region');
  });

  it('applies access policies to metric queries', async () => {
    await ctx.policies.create(admin, wsId, { name: 'EU only', table_name: 'orders', row_filter: "region = 'EU'", applies_to: { roles: ['VIEWER'] } });
    expect((await query({ metrics: ['total_revenue'] })).json.rows).toEqual([[280]]);
    expect((await query({ metrics: ['total_revenue'] }, viewerJwt)).json.rows).toEqual([[200]]);
  });

  it('scaffolds definitions from a table', async () => {
    const y = (await api('POST', `/api/workspaces/${wsId}/semantic/scaffold`, { table: 'orders' })).json.yaml as string;
    const doc = YAML.parse(y);
    expect(doc.semantic_models[0]).toMatchObject({ name: 'orders', table: 'orders', default_time_dimension: 'order_date' });
    expect(doc.semantic_models[0].entities).toEqual(expect.arrayContaining([{ name: 'order', type: 'primary', expr: 'order_id' }, { name: 'customer', type: 'foreign', expr: 'customer_id' }]));
    expect(doc.metrics.map((m: { name: string }) => m.name)).toEqual(['orders_count', 'total_amount']);
    expect((await api('POST', `/api/workspaces/${wsId}/semantic/validate`, { yaml: y })).json.ok).toBe(true);
  });

  it('serves metrics to agents and to Copilot', async () => {
    const env: ToolEnv = { ctx, principal: ctx.auth.principalFromUser((await ctx.auth.findByEmail('admin@test.local'))!, 'token'), via: 'mcp', defaultWorkspaceId: wsId, agent: null };
    const tools = buildTools(ctx.cfg);
    const call = (name: string, args: Record<string, unknown>) => runTool(env, tools.find((t) => t.name === name)!, args);
    const listed = await call('list_metrics', {});
    expect((listed.structuredContent as { metrics: { name: string }[] }).metrics.map((m) => m.name)).toEqual(expect.arrayContaining(['total_revenue', 'aov', 'customers']));
    const q = await call('query_metrics', { metrics: ['total_revenue'], group_by: ['region'], order_by: [{ name: 'region' }] });
    expect((q.structuredContent as { rows: unknown[][] }).rows).toEqual([['EU', 200], ['US', 80]]);
    expect((q.content[0] as { text: string }).text).toMatch(/SQL:/);
    const snap = await ctx.copilot.buildContext(admin, wsId);
    expect(snap.metrics).toMatch(/- total_revenue \(Revenue\): sum\(amount\) over orders where .*status.* — Revenue of completed orders; by metric_time/);
    expect(ctx.copilot.renderContextText(snap)).toMatch(/### Metrics defined in the semantic layer/);
  });

  it.skipIf(!hasPython)('imports semantic models and metrics from a dbt project', async () => {
    const files = {
      'dbt_project.yml': "name: shop_metrics\nversion: '1.0'\nprofile: duckview\n",
      'models/fct_orders.sql': "select order_id, customer_id, order_date, region, amount from orders where status = 'complete'\n",
      'models/metricflow_time_spine.sql': "select range::date as date_day from range(date '2020-01-01', date '2030-01-01', interval 1 day)\n",
      'models/semantic.yml': `version: 2
models:
  - name: metricflow_time_spine
    time_spine:
      standard_granularity_column: date_day
    columns:
      - name: date_day
        granularity: day
semantic_models:
  - name: fct_orders
    model: ref('fct_orders')
    defaults:
      agg_time_dimension: order_date
    entities:
      - { name: dbt_order, type: primary, expr: order_id }
      - { name: dbt_customer, type: foreign, expr: customer_id }
    dimensions:
      - { name: order_date, type: time, type_params: { time_granularity: day } }
      - { name: region, type: categorical }
    measures:
      - { name: dbt_revenue, agg: sum, expr: amount }
metrics:
  - name: dbt_eu_revenue
    label: EU revenue (dbt)
    type: simple
    type_params:
      measure: dbt_revenue
    filter: "{{ Dimension('dbt_order__region') }} = 'EU'"
`,
    };
    const project = (await api('POST', `/api/workspaces/${wsId}/dbt/projects`, { name: 'Shop metrics', files })).json.project;
    const run = (await api('POST', `/api/dbt/projects/${project.id}/runs`, { command: 'build', wait: true })).json.run;
    expect(run.status).toBe('ok');
    const sem = (await api('GET', `/api/workspaces/${wsId}/semantic`)).json;
    expect(sem.sources.map((s: { source: string }) => s.source)).toEqual(expect.arrayContaining(['workspace', `dbt:${project.id}`]));
    expect(sem.metrics.find((m: { name: string }) => m.name === 'dbt_eu_revenue')).toMatchObject({ label: 'EU revenue (dbt)', source: `dbt:${project.id}` });
    expect((await query({ metrics: ['dbt_eu_revenue'], group_by: ['metric_time__month'] })).json.rows.map((r: unknown[]) => r[1])).toEqual([120, 80]);
    // Deleting the project removes what it defined.
    await api('DELETE', `/api/dbt/projects/${project.id}`);
    expect((await api('GET', `/api/workspaces/${wsId}/semantic`)).json.metrics.some((m: { name: string }) => m.name === 'dbt_eu_revenue')).toBe(false);
  }, 900_000);
});
