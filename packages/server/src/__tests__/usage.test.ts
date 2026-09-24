/**
 * Usage & cost: queries and their time by person, agent and workspace, AI tokens priced per model (own keys apart,
 * unknown models flagged), storage, the rates from configuration, what non-administrators see, CSV exports, and
 * budgets that notify a channel once per threshold and month.
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
import { newId } from '../security/crypto.js';
import type { Principal } from '../services/principal.js';

let dir: string;
let ctx: AppContext;
let app: Awaited<ReturnType<typeof buildApp>>['app'];
let base: string;
let admin: Principal;
let analyst: Principal;
let agent: Principal;
let wsId: string;
let analystWs: string;
let adminJwt: string;
let analystJwt: string;
let receiver: http.Server;
let hook: string;
const received: Record<string, unknown>[] = [];

const api = async (method: string, url: string, token: string, body?: unknown) => {
  const r = await fetch(`${base}${url}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const textBody = await r.text();
  let json: Record<string, any> = {}; // eslint-disable-line @typescript-eslint/no-explicit-any
  try {
    json = JSON.parse(textBody);
  } catch {
    /* CSV */
  }
  return { status: r.status, json, text: textBody, type: r.headers.get('content-type') ?? '' };
};

beforeAll(async () => {
  initLogger({ level: 'silent', stderr: true, pretty: false });
  receiver = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      received.push(JSON.parse(body || '{}'));
      res.end('ok');
    });
  });
  await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
  hook = `http://127.0.0.1:${(receiver.address() as net.AddressInfo).port}`;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dv-usage-'));
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  const cfg = loadConfig({ configPath: null, env: { DUCKVIEW_DATA_DIR: path.join(dir, 'data'), DUCKDB_TEMP_DIRECTORY: path.join(dir, 'spill'), DATABASE_URL: ':memory:', DUCKDB_MEMORY_LIMIT: '512MB', DUCKVIEW_ADMIN_EMAIL: 'admin@test.local', DUCKVIEW_ADMIN_PASSWORD: 'super-secret-pw', DUCKVIEW__duckdb__sync_scheduler_enabled: 'false', DUCKVIEW__notifications__scheduler_enabled: 'false', DUCKVIEW__notifications__allow_private_targets: 'true', DUCKVIEW__transform__scheduler_enabled: 'false', DUCKVIEW__apps__enabled: 'false', DUCKVIEW__usage__compute_per_hour: '3600', DUCKVIEW__usage__storage_per_gb_month: '30', DUCKVIEW__usage__currency: 'EUR', LOG_LEVEL: 'silent' } });
  // A price for a model the built-in list does not know.
  cfg.usage.model_prices = { 'house-model': { input: 10, output: 0 } };
  ctx = await createContext(cfg);
  const adminUser = (await ctx.auth.findByEmail('admin@test.local'))!;
  admin = ctx.auth.principalFromUser(adminUser, 'jwt', '127.0.0.1');
  const analystUser = await ctx.auth.createLocalUser({ email: 'analyst@test.local', password: 'analyst-secret-pw', role: 'USER' });
  analyst = ctx.auth.principalFromUser(analystUser, 'jwt', '127.0.0.1');
  agent = { ...admin, via: 'token', actorType: 'AGENT' };
  wsId = (await ctx.workspaces.create(admin, { name: 'Sales', active_db_path: 'sales.duckdb' })).id;
  analystWs = (await ctx.workspaces.create(analyst, { name: 'Analyst sandbox', active_db_path: ':memory:' })).id;
  await ctx.queries.run(admin, wsId, 'CREATE TABLE orders AS SELECT range AS id, range * 1.5 AS amount FROM range(50000)', { cache: false });
  for (let i = 0; i < 3; i++) await ctx.queries.run(admin, wsId, 'SELECT sum(amount) FROM orders', { cache: false });
  await ctx.queries.run(agent, wsId, 'SELECT count(*) FROM orders', { cache: false });
  await ctx.queries.run(admin, wsId, 'SELECT * FROM no_such_table', { cache: false }).catch(() => undefined);
  await ctx.queries.run(analyst, analystWs, 'SELECT 42', { cache: false });
  // AI turns: a priced model, one on the person's own key, one without a price, one with a configured price.
  const turn = (user: string, ws: string, model: string, input: number, output: number, byok = false) => ({ id: newId(), user_id: user, workspace_id: ws, conversation_id: 'c', message_id: newId(), provider: 'anthropic', model, action: 'chat', byok, input_tokens: input, output_tokens: output, duration_ms: 1000, status: 'ok' as const, created_at: new Date() });
  await ctx.store.db.insert(ctx.store.schema.copilotUsage).values([turn(adminUser.id, wsId, 'claude-sonnet-4-5', 1_000_000, 100_000), turn(adminUser.id, wsId, 'claude-haiku-4-5', 1_000_000, 0, true), turn(analystUser.id, analystWs, 'mystery-model-7', 5000, 5000), turn(analystUser.id, analystWs, 'house-model-2', 100_000, 0)]);
  ({ app } = await buildApp(ctx));
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as net.AddressInfo).port}`;
  const login = async (email: string, password: string) => ((await (await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) })).json()) as { token: string }).token;
  adminJwt = await login('admin@test.local', 'super-secret-pw');
  analystJwt = await login('analyst@test.local', 'analyst-secret-pw');
}, 120_000);

afterAll(async () => {
  await app?.close();
  await ctx?.shutdown();
  receiver?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('usage & cost', () => {
  it('adds up queries, compute, AI and storage for the organisation', async () => {
    const r = await ctx.usage.report(admin, { days: 7 });
    expect(r.scope).toBe('org');
    expect(r.currency).toBe('EUR');
    // 1 create + 3 sums + 1 agent + 1 failure (admin) + 1 (analyst)
    expect(r.totals.queries).toBe(7);
    expect(r.totals.errors).toBe(1);
    // 3600 per hour: one unit per second of query time.
    expect(r.totals.cost.compute).toBeCloseTo(r.totals.query_seconds, 2);
    // Sonnet: 1M in × 3 + 0.1M out × 15 = 4.5; house model: 0.1M × 10 = 1; the mystery model has no price.
    expect(r.totals.cost.ai).toBeCloseTo(5.5, 4);
    expect(r.totals.byok_ai_cost).toBeCloseTo(1, 4);
    expect(r.totals.unpriced_models).toEqual(['mystery-model-7']);
    expect(r.models.find((m) => m.model === 'claude-haiku-4-5')).toMatchObject({ byok_turns: 1, cost: 1 });
    // The Sales database file is priced per GB-month for the 7 days.
    const sales = r.workspaces.find((w) => w.id === wsId)!;
    expect(sales.name).toBe('Sales');
    expect(sales.storage_bytes).toBeGreaterThan(100_000);
    expect(sales.cost.storage).toBeCloseTo((sales.storage_bytes / 1e9) * 30 * (7 / 30), 4);
    expect(sales.queries).toBe(6);
    expect(sales.cost.ai).toBeCloseTo(4.5, 4);
    expect(r.users.map((u) => u.email).sort()).toEqual(['admin@test.local', 'analyst@test.local']);
    expect(r.sources.find((x) => x.source === 'agents')!.runs).toBe(1);
    expect(r.sources.find((x) => x.source === 'people')!.runs).toBe(6);
    expect(r.top_queries[0]!.runs).toBeGreaterThanOrEqual(1);
    expect(r.top_queries.some((q) => q.sql === 'SELECT sum(amount) FROM orders' && q.runs === 3)).toBe(true);
    // Every day of the period has a row; they add up to the total.
    expect(r.daily.length).toBeGreaterThanOrEqual(7);
    expect(r.daily.reduce((t, d) => t + d.cost.total, 0)).toBeCloseTo(r.totals.cost.total, 3);
  });

  it('shows others only their own usage, and exports CSV', async () => {
    const mine = await api('GET', '/api/usage?days=30', analystJwt);
    expect(mine.json.scope).toBe('self');
    expect(mine.json.totals.queries).toBe(1);
    expect(mine.json.users.map((u: { email: string }) => u.email)).toEqual(['analyst@test.local']);
    expect(mine.json.workspaces.map((w: { id: string }) => w.id)).toEqual([analystWs]);
    // Another person's workspace is not theirs to report on.
    expect((await api('GET', `/api/usage?workspace_id=${wsId}`, analystJwt)).status).toBe(404);
    const csv = await api('GET', '/api/usage/export.csv?by=workspace&days=7', adminJwt);
    expect(csv.type).toMatch(/text\/csv/);
    expect(csv.text.split('\n')[0]).toBe('workspace_id,workspace,queries,compute_seconds,ai_tokens,storage_bytes,compute_cost,ai_cost,storage_cost,total_cost');
    expect(csv.text).toContain(`${wsId},Sales,6,`);
    // Agents ask for it as a tool.
    const tool = await api('POST', '/api/agent/v1/tools/get_usage', adminJwt, { days: 7 });
    expect(tool.json.is_error, tool.text).toBe(false);
    expect(String(tool.json.text)).toMatch(/Organisation usage, last 7 days/);
  });

  it('notifies a channel once per budget threshold and month', async () => {
    const channel = (await ctx.notifications.create(admin, null, { name: 'Finance hook', type: 'webhook', secret: { url: `${hook}/budget` } })).channel;
    // Only administrators set the organisation's budget; owners set their workspace's.
    expect((await api('POST', '/api/usage/budgets', analystJwt, { amount: 10 })).status).toBe(403);
    expect((await api('POST', '/api/usage/budgets', analystJwt, { amount: 10, workspace_id: wsId })).status).toBe(404);
    const own = await api('POST', '/api/usage/budgets', analystJwt, { amount: 1000, workspace_id: analystWs });
    expect(own.status, JSON.stringify(own.json)).toBe(200);
    const org = await api('POST', '/api/usage/budgets', adminJwt, { amount: 8, thresholds: [50, 100, 500], channel_ids: [channel.id] });
    expect(org.status, JSON.stringify(org.json)).toBe(200);
    expect(org.json.budget).toMatchObject({ name: 'Organisation monthly budget', amount: 8, thresholds: [50, 100, 500] });
    expect(org.json.budget.spent).toBeGreaterThan(5.5);
    const sent = await ctx.usage.checkBudgets();
    expect(sent.filter((x) => x.budget_id === org.json.budget.id).map((x) => x.threshold)).toEqual([50]);
    await new Promise((r) => setTimeout(r, 300));
    const msg = received.find((m) => (m as { event?: string }).event === 'budget.threshold') as { title: string; text: string } | undefined;
    expect(msg?.title).toBe('Organisation monthly budget: 50% reached');
    expect(msg?.text).toMatch(/of a 8\.00 EUR budget/);
    // Not again this month.
    expect(await ctx.usage.checkBudgets()).toEqual([]);
    // The analyst sees their workspace's budget, not the organisation's.
    const theirs = await api('GET', '/api/usage/budgets', analystJwt);
    expect(theirs.json.budgets.map((b: { workspace_id: string }) => b.workspace_id)).toEqual([analystWs]);
    // Lowering the amount starts over: 100% is crossed now.
    await api('PATCH', `/api/usage/budgets/${org.json.budget.id}`, adminJwt, { amount: 5 });
    expect((await ctx.usage.checkBudgets()).map((x) => x.threshold)).toEqual([50, 100]);
    expect((await api('DELETE', `/api/usage/budgets/${org.json.budget.id}`, analystJwt)).status).toBe(403);
    expect((await api('DELETE', `/api/usage/budgets/${org.json.budget.id}`, adminJwt)).status).toBe(200);
  });
});
