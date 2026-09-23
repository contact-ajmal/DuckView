/**
 * Build plans: parsing, checking each item's SQL (columns, read-only, numeric KPIs), building a laid-out grid
 * dashboard from what passes (the rest reported), a Streamlit app from the same plan, the agent tool, and DuckView AI
 * answering "build me a dashboard" with a checked plan (the build guide in its prompt only then).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../config/index.js';
import { initLogger } from '../observability/logger.js';
import { createContext, type AppContext } from '../context.js';
import { buildTools, runTool, type ToolEnv } from '../agent/tools.js';
import { parseBuildPlan } from '../services/builder.js';
import type { ProviderFactory, LlmProvider, LlmRequest, LlmUsage } from '../services/llm.js';
import type { Principal } from '../services/principal.js';

let dir: string;
let ctx: AppContext;
let wsId: string;
let admin: Principal;
const prompts: LlmRequest[] = [];

const PLAN = `build: dashboard
name: Sales overview
description: Orders at a glance
items:
  - { title: Revenue, kind: kpi, sql: "SELECT sum(amount) AS revenue FROM orders", format: currency }
  - { title: Orders, kind: kpi, sql: "SELECT count(*) AS orders FROM orders" }
  - title: Revenue by region
    kind: chart
    chart: bar
    sql: |
      SELECT region, sum(amount) AS revenue
      FROM orders GROUP BY 1 ORDER BY 1
    x: region
    y: [revenue]
  - { title: Broken, kind: chart, sql: "SELECT region FROM orders", x: region, y: [nope] }
  - { title: Latest orders, kind: table, sql: "SELECT * FROM orders ORDER BY id DESC LIMIT 100" }
  - { title: Notes, kind: text, text: "Amounts in EUR." }
`;

const stub: ProviderFactory = (id, opts) => {
  const p: LlmProvider = {
    id,
    model: opts.model ?? 'stub',
    async *stream(req: LlmRequest): AsyncGenerator<string, LlmUsage, void> {
      prompts.push(req);
      yield 'Here is a dashboard with revenue, orders and a regional breakdown.\n\n```duckview-build\n';
      yield PLAN;
      yield '```\n';
      return { input_tokens: 10, output_tokens: 20 };
    },
    async listModels() {
      return ['stub'];
    },
  };
  return p;
};

beforeAll(async () => {
  initLogger({ level: 'silent', stderr: true, pretty: false });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dv-builder-'));
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  const cfg = loadConfig({ configPath: null, env: { DUCKVIEW_DATA_DIR: path.join(dir, 'data'), DUCKDB_TEMP_DIRECTORY: path.join(dir, 'spill'), DATABASE_URL: ':memory:', DUCKDB_MEMORY_LIMIT: '512MB', DUCKVIEW_ADMIN_EMAIL: 'admin@test.local', DUCKVIEW_ADMIN_PASSWORD: 'super-secret-pw', DUCKVIEW__duckdb__sync_scheduler_enabled: 'false', DUCKVIEW__notifications__scheduler_enabled: 'false', DUCKVIEW__transform__scheduler_enabled: 'false', DUCKVIEW__apps__enabled: 'false', COPILOT_PROVIDER: 'anthropic', COPILOT_API_KEY: 'k', COPILOT_MODEL: 'stub', LOG_LEVEL: 'silent' } });
  ctx = await createContext(cfg, { providerFactory: stub });
  admin = ctx.auth.principalFromUser((await ctx.auth.findByEmail('admin@test.local'))!, 'jwt', '127.0.0.1');
  wsId = (await ctx.workspaces.create(admin, { name: 'Shop', active_db_path: 'shop.duckdb' })).id;
  await ctx.queries.run(admin, wsId, "CREATE TABLE orders AS SELECT * FROM (VALUES (1, 'EU', 100.0), (2, 'US', 50.0), (3, 'EU', 30.0)) t(id, region, amount)", { cache: false });
}, 120_000);

afterAll(async () => {
  await ctx?.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('build plans', () => {
  it('parses plans and says what is wrong', () => {
    expect(parseBuildPlan(PLAN).items.map((i) => i.kind)).toEqual(['kpi', 'kpi', 'chart', 'chart', 'table', 'text']);
    expect(parseBuildPlan(PLAN).items[2]!.sql).toBe('SELECT region, sum(amount) AS revenue\nFROM orders GROUP BY 1 ORDER BY 1');
    expect(() => parseBuildPlan('build: poster\nname: x\nitems: []')).toThrow(/build must be dashboard or app/);
    expect(() => parseBuildPlan('build: dashboard\nname: x\nitems: []')).toThrow(/no items/);
    expect(() => parseBuildPlan('build: dashboard\nname: x\nitems: [{ title: a, kind: gauge }]')).toThrow(/kind must be/);
    expect(() => parseBuildPlan('build: dashboard\nname: x\nitems: [{ title: a, kind: kpi }]')).toThrow(/sql is required/);
  });

  it('checks every item against the workspace', async () => {
    const c = await ctx.builder.check(admin, wsId, parseBuildPlan(`build: dashboard
name: t
items:
  - { title: ok, kind: kpi, sql: "SELECT sum(amount) AS v FROM orders" }
  - { title: text kpi, kind: kpi, sql: "SELECT 'x' AS v" }
  - { title: writes, kind: table, sql: "DELETE FROM orders" }
  - { title: typo, kind: table, sql: "SELECT * FROM ordersx" }
  - { title: wrong x, kind: chart, sql: "SELECT region, 1 AS n FROM orders", x: country, y: [n] }
`));
    expect(c.items.map((i) => [i.title, i.ok])).toEqual([['ok', true], ['text kpi', false], ['writes', false], ['typo', false], ['wrong x', false]]);
    expect(c.items[1]!.error).toMatch(/numeric column/);
    expect(c.items[2]!.error).toMatch(/read-only/);
    expect(c.items[3]!.error).toMatch(/ordersx/);
    expect(c.items[4]!.error).toBe('the query has no column country (it returns region, n)');
    expect(c.ok).toBe(false);
    expect((await ctx.queries.run(admin, wsId, 'SELECT count(*) FROM orders', { cache: false })).rows[0]).toEqual([3]);
  });

  it('builds a laid-out dashboard from what works, and reports the rest', async () => {
    const r = await ctx.builder.create(admin, wsId, parseBuildPlan(PLAN));
    expect(r).toMatchObject({ build: 'dashboard', name: 'Sales overview', created: ['Revenue', 'Orders', 'Revenue by region', 'Latest orders', 'Notes'], skipped: [{ title: 'Broken' }] });
    const d = await ctx.dashboards.get(admin, r.id);
    const byTitle = Object.fromEntries(d.widgets.map((w) => [w.title, w]));
    expect(byTitle.Revenue).toMatchObject({ widget_type: 'KPI', chart_config: { value: 'revenue', format: 'currency' } });
    expect(byTitle['Revenue by region']).toMatchObject({ widget_type: 'CHART', chart_config: { chart: 'bar', x: 'region', y: ['revenue'] } });
    expect(byTitle['Latest orders']!.widget_type).toBe('TABLE');
    expect(byTitle.Notes).toMatchObject({ widget_type: 'MARKDOWN', chart_config: { markdown: 'Amounts in EUR.' } });
    const at = (t: string) => d.layout.find((l) => l.i === byTitle[t]!.id)!;
    expect([at('Revenue'), at('Orders')].map((l) => [l.x, l.y, l.w])).toEqual([[0, 0, 6], [6, 0, 6]]);
    expect([at('Revenue by region').y, at('Revenue by region').w]).toEqual([2, 6]);
    expect([at('Latest orders').w, at('Notes').w]).toEqual([12, 12]);
    expect(at('Latest orders').y).toBeGreaterThan(at('Revenue by region').y);
    // The widgets really answer.
    const data = await ctx.queries.run(admin, wsId, byTitle.Revenue!.custom_sql!, { cache: false });
    expect(data.rows).toEqual([[180]]);
  });

  it('builds a data app from the same kind of plan, and serves agents', async () => {
    const app = await ctx.builder.create(admin, wsId, parseBuildPlan(PLAN.replace('build: dashboard', 'build: app')));
    expect(app.build).toBe('app');
    const stored = await ctx.apps.get(admin, app.id);
    expect(stored.files['app.py']).toContain('Revenue by region');
    expect(stored.files['app.py']).toContain('SELECT region, sum(amount) AS revenue');
    const env: ToolEnv = { ctx, principal: ctx.auth.principalFromUser((await ctx.auth.findByEmail('admin@test.local'))!, 'token'), via: 'mcp', defaultWorkspaceId: wsId, agent: null };
    const tools = buildTools(ctx.cfg);
    const call = (name: string, args: Record<string, unknown>) => runTool(env, tools.find((t) => t.name === name)!, args);
    const checked = await call('build_dashboard', { name: 'Agent board', items: [{ title: 'Total', kind: 'kpi', sql: 'SELECT sum(amount) AS total FROM orders' }, { title: 'Bad', kind: 'table', sql: 'SELECT * FROM nope' }], check_only: true });
    expect((checked.content[0] as { text: string }).text).toMatch(/- ok Total \(1 rows: total\)\n- FAILS Bad — .*nope/);
    const built = await call('build_dashboard', { name: 'Agent board', items: [{ title: 'Total', kind: 'kpi', sql: 'SELECT sum(amount) AS total FROM orders' }] });
    expect(built.structuredContent).toMatchObject({ status: 'ok', build: 'dashboard', created: ['Total'] });
  });

  it('lets DuckView AI answer "build me a dashboard" with a checked plan', async () => {
    const events = [];
    for await (const e of ctx.copilot.stream(admin, { workspaceId: wsId, message: 'Build me a sales dashboard for the orders table' } as never)) events.push(e);
    const done = events.find((e) => e.type === 'done') as { build_blocks: { check: { name: string; ok: boolean; items: { title: string; ok: boolean }[] } }[] };
    expect(done.build_blocks).toHaveLength(1);
    expect(done.build_blocks[0]!.check).toMatchObject({ name: 'Sales overview', ok: false });
    expect(done.build_blocks[0]!.check.items.filter((i) => !i.ok).map((i) => i.title)).toEqual(['Broken']);
    expect(prompts.at(-1)!.system).toContain('## Building dashboards and data apps');
    expect(prompts.at(-1)!.system).not.toContain('Writing a DuckView Mosaic dashboard spec');
    // An ordinary question does not get the build guide.
    for await (const _e of ctx.copilot.stream(admin, { workspaceId: wsId, message: 'How many orders are there?' } as never)) void _e;
    expect(prompts.at(-1)!.system).not.toContain('## Building dashboards and data apps');
  });
});
