/**
 * Questions answered from the semantic layer: DuckView AI's ```duckview-metric blocks computed exactly as defined
 * (and under the asker's access policies), errors for names that do not exist, the guide only when there are
 * metrics, and the one-shot ask endpoint (a checked query, or why it cannot be answered).
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
import type { ProviderFactory, LlmProvider, LlmRequest, LlmUsage } from '../services/llm.js';
import type { Principal } from '../services/principal.js';

let dir: string;
let ctx: AppContext;
let app: Awaited<ReturnType<typeof buildApp>>['app'];
let base: string;
let jwt: string;
let wsId: string;
let emptyWs: string;
let admin: Principal;
let viewer: Principal;
const prompts: LlmRequest[] = [];

const stub: ProviderFactory = (id, opts) => {
  const p: LlmProvider = {
    id,
    model: opts.model ?? 'stub',
    async *stream(req: LlmRequest): AsyncGenerator<string, LlmUsage, void> {
      prompts.push(req);
      const q = String(req.messages.at(-1)?.content ?? '');
      if (req.system.startsWith('You turn questions into metric queries')) {
        yield /weather/i.test(q) ? '{"unanswerable": "There is no weather metric."}' : 'Sure: {"title": "Revenue by region", "explanation": "total_revenue grouped by region", "metrics": ["total_revenue"], "group_by": ["region"], "order_by": [{"name": "total_revenue", "desc": true}]}';
        return { input_tokens: 1, output_tokens: 1 };
      }
      if (/typo/.test(q)) yield 'Here:\n```duckview-metric\nmetrics: [total_revenu]\n```\n';
      else yield 'Revenue by month:\n```duckview-metric\ntitle: Revenue by month\nmetrics: [total_revenue, orders]\ngroup_by: [metric_time__month]\n```\n';
      return { input_tokens: 1, output_tokens: 1 };
    },
    async listModels() {
      return ['stub'];
    },
  };
  return p;
};

beforeAll(async () => {
  initLogger({ level: 'silent', stderr: true, pretty: false });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dv-nlmetrics-'));
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  const cfg = loadConfig({ configPath: null, env: { DUCKVIEW_DATA_DIR: path.join(dir, 'data'), DUCKDB_TEMP_DIRECTORY: path.join(dir, 'spill'), DATABASE_URL: ':memory:', DUCKDB_MEMORY_LIMIT: '512MB', DUCKVIEW_ADMIN_EMAIL: 'admin@test.local', DUCKVIEW_ADMIN_PASSWORD: 'super-secret-pw', DUCKVIEW__duckdb__sync_scheduler_enabled: 'false', DUCKVIEW__notifications__scheduler_enabled: 'false', DUCKVIEW__transform__scheduler_enabled: 'false', DUCKVIEW__apps__enabled: 'false', COPILOT_PROVIDER: 'anthropic', COPILOT_API_KEY: 'k', COPILOT_MODEL: 'stub', LOG_LEVEL: 'silent' } });
  ctx = await createContext(cfg, { providerFactory: stub });
  admin = ctx.auth.principalFromUser((await ctx.auth.findByEmail('admin@test.local'))!, 'jwt', '127.0.0.1');
  const v = await ctx.auth.createLocalUser({ email: 'viewer@test.local', password: 'viewer-secret-pw', role: 'USER' });
  viewer = ctx.auth.principalFromUser(v, 'jwt', '127.0.0.1');
  wsId = (await ctx.workspaces.create(admin, { name: 'Shop', active_db_path: 'shop.duckdb' })).id;
  emptyWs = (await ctx.workspaces.create(admin, { name: 'Empty', active_db_path: 'empty.duckdb' })).id;
  await ctx.workspaces.setMember(admin, wsId, { subject_type: 'user', subject_id: v.id, role: 'VIEWER' });
  await ctx.queries.run(admin, wsId, "CREATE TABLE orders AS SELECT * FROM (VALUES (1, DATE '2026-01-05', 'EU', 100.0), (2, DATE '2026-01-20', 'US', 50.0), (3, DATE '2026-02-02', 'EU', 30.0)) t(id, order_date, region, amount)", { cache: false });
  await ctx.semantic.save(admin, wsId, `semantic_models:
  - name: orders
    table: orders
    default_time_dimension: order_date
    dimensions:
      - { name: order_date, type: time }
      - { name: region, type: categorical }
    measures:
      - { name: revenue, agg: sum, expr: amount }
      - { name: order_count, agg: count }
metrics:
  - { name: total_revenue, label: Revenue, type: simple, measure: revenue }
  - { name: orders, type: simple, measure: order_count }
`);
  ({ app } = await buildApp(ctx));
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as net.AddressInfo).port}`;
  jwt = (await (await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@test.local', password: 'super-secret-pw' }) })).json()).token;
}, 120_000);

afterAll(async () => {
  await app?.close();
  await ctx?.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
});

const ask = async (p: Principal, ws: string, message: string) => {
  let done: Record<string, any> | null = null;
  for await (const e of ctx.copilot.stream(p, { workspaceId: ws, message } as never)) if (e.type === 'done') done = e;
  return done!;
};

describe('questions answered from metrics', () => {
  it('computes the AI\'s metric query exactly as defined', async () => {
    const done = await ask(admin, wsId, 'What was revenue by month?');
    expect(done.metric_blocks).toHaveLength(1);
    const b = done.metric_blocks[0];
    expect(b).toMatchObject({ ok: true, title: 'Revenue by month', query: { metrics: ['total_revenue', 'orders'], group_by: ['metric_time__month'] } });
    expect(b.columns.map((c: { name: string }) => c.name)).toEqual(['metric_time__month', 'total_revenue', 'orders']);
    expect(b.rows.map((r: unknown[]) => [String(r[0]).slice(0, 7), r[1], r[2]])).toEqual([['2026-01', 150, 2], ['2026-02', 30, 1]]);
    expect(b.sql).toMatch(/date_trunc\('month'/);
    expect(prompts.at(-1)!.system).toContain('## Answering with the semantic layer\'s metrics');
    // A name that does not exist is an error on the block, not a wrong number.
    const typo = await ask(admin, wsId, 'typo please');
    expect(typo.metric_blocks[0]).toMatchObject({ ok: false });
    expect(typo.metric_blocks[0].error).toMatch(/Unknown metric total_revenu/);
  });

  it('applies the asker\'s access policies, and leaves the guide out without metrics', async () => {
    await ctx.policies.create(admin, wsId, { name: 'Viewers: EU', table_name: 'orders', row_filter: "region = 'EU'", applies_to: { roles: ['VIEWER'] } });
    const done = await ask(viewer, wsId, 'What was revenue by month?');
    expect(done.metric_blocks[0].rows.map((r: unknown[]) => r[1])).toEqual([100, 30]);
    await ask(admin, emptyWs, 'What was revenue by month?');
    expect(prompts.at(-1)!.system).not.toContain('## Answering with the semantic layer\'s metrics');
  });

  it('turns a question into a checked query for the Metrics explorer', async () => {
    const r = await fetch(`${base}/api/workspaces/${wsId}/semantic/ask`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt}` }, body: JSON.stringify({ question: 'Which region brings the most revenue?' }) });
    const body = await r.json();
    expect(body).toMatchObject({ title: 'Revenue by region', unanswerable: null, query: { metrics: ['total_revenue'], group_by: ['region'], order_by: [{ name: 'total_revenue', desc: true }] } });
    expect(prompts.at(-1)!.system).toMatch(/- total_revenue \(Revenue\): sum\(amount\) over orders/);
    const no = await (await fetch(`${base}/api/workspaces/${wsId}/semantic/ask`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt}` }, body: JSON.stringify({ question: 'What is the weather?' }) })).json();
    expect(no).toMatchObject({ query: null, unanswerable: 'There is no weather metric.' });
    const none = await (await fetch(`${base}/api/workspaces/${emptyWs}/semantic/ask`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt}` }, body: JSON.stringify({ question: 'Revenue?' }) })).json();
    expect(none.unanswerable).toMatch(/no metrics yet/);
  });
});
