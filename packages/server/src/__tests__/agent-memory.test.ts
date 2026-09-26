import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../config/index.js';
import { initLogger } from '../observability/logger.js';
import { createContext, type AppContext } from '../context.js';
import { buildApp } from '../app.js';
import { LlmReasoningModel } from '../agent/reasoning/llm.js';
import type { LlmProvider, LlmRequest, LlmUsage } from '../services/llm.js';
import type { AgentEvent } from '../agent/events.js';
import type { AgentTask } from '../db/schema/sqlite.js';

let dir: string;
let ctx: AppContext;
let app: Awaited<ReturnType<typeof buildApp>>['app'];
let base: string;
let jwt: string;
let viewerJwt: string;
let ws: string;
let other: string;

const api = async (method: string, url: string, body?: unknown, token = jwt) => {
  const res = await fetch(base + url, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: Record<string, any> = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json, text };
};

/** A model that replies from a script, in order, and remembers what it was asked. */
const script = {
  replies: [] as (string | ((req: LlmRequest) => string | Promise<string>))[],
  requests: [] as LlmRequest[],
};
const scriptedProvider: LlmProvider = {
  id: 'openai',
  model: 'scripted-1',
  async *stream(req: LlmRequest): AsyncGenerator<string, LlmUsage, void> {
    script.requests.push({ ...req, messages: req.messages.map((m) => ({ ...m })) });
    const next = script.replies.shift();
    if (next === undefined) throw new Error('The script ran out of replies');
    const text = typeof next === 'function' ? await next(req) : next;
    for (let i = 0; i < text.length; i += 7) yield text.slice(i, i + 7);
    return { input_tokens: 100, output_tokens: 20 };
  },
  listModels: async () => ['scripted-1'],
};
const tool = (name: string, args: Record<string, unknown>) => `\`\`\`tool\n${JSON.stringify({ name, arguments: args })}\n\`\`\``;

async function runTask(body: Record<string, unknown>, token = jwt): Promise<AgentTask> {
  const r = await api('POST', '/api/agent/tasks', { workspace_id: ws, wait: true, ...body }, token);
  expect([r.status, r.text.slice(0, 300)]).toEqual([200, expect.any(String)]);
  return r.json.task;
}

beforeAll(async () => {
  initLogger({ level: 'silent', stderr: true, pretty: false });
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dv-agentmem-')));
  const cfg = loadConfig({ configPath: null, env: { DUCKVIEW_DATA_DIR: path.join(dir, 'data'), DUCKVIEW_FILESYSTEM_MODE: 'sandboxed', DUCKDB_TEMP_DIRECTORY: path.join(dir, 'spill'), DATABASE_URL: ':memory:', DUCKDB_MEMORY_LIMIT: '1GB', DUCKVIEW_ADMIN_EMAIL: 'admin@test.local', DUCKVIEW_ADMIN_PASSWORD: 'super-secret-pw', DUCKVIEW__apps__enabled: 'false', LOG_LEVEL: 'silent' } });
  ctx = await createContext(cfg);
  ctx.agentRuntime.modelFactory = async () => new LlmReasoningModel(scriptedProvider);
  const admin = ctx.auth.principalFromUser((await ctx.auth.findByEmail('admin@test.local'))!, 'jwt', '127.0.0.1');
  const viewer = await ctx.auth.createLocalUser({ email: 'viewer@test.local', password: 'viewer-secret-pw', role: 'USER' });
  ws = (await ctx.workspaces.create(admin, { name: 'Sales', active_db_path: 'sales.duckdb' })).id;
  other = (await ctx.workspaces.create(admin, { name: 'Other', active_db_path: 'other.duckdb' })).id;
  await ctx.workspaces.setMember(admin, ws, { subject_type: 'user', subject_id: viewer.id, role: 'VIEWER' });
  const run = (sql: string) => ctx.queries.run(admin, ws, sql, { cache: false });
  await run("CREATE TABLE customer_orders AS SELECT * FROM (VALUES (1, DATE '2026-01-05', 'EU', 'ana@acme.com', 100.0), (2, DATE '2026-01-06', 'EU', 'bo@acme.com', 50.0), (3, DATE '2026-02-01', 'US', 'cy@acme.com', 300.0)) t(order_id, order_date, region, email, revenue)");
  await run('CREATE TABLE inventory (sku VARCHAR, stock INTEGER)');
  ({ app } = await buildApp(ctx));
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const login = async (email: string, password: string) => ((await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) })).json()) as { token: string }).token;
  jwt = await login('admin@test.local', 'super-secret-pw');
  viewerJwt = await login('viewer@test.local', 'viewer-secret-pw');
  expect((await api('POST', `/api/workspaces/${ws}/dashboards`, { name: 'Revenue overview' })).status).toBe(200);
});

afterAll(async () => {
  await app?.close();
  await ctx?.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
});

type Memory = { id: string; scope: string; kind: string; subject: string | null; text: string; user_id: string; uses: number };

describe('agent memory', () => {
  it('keeps what a task found: shared schema facts, private failures and suggestions, never result values', async () => {
    script.replies = [
      tool('inspect_schema', { file_path_or_table: 'customer_orders' }),
      tool('execute_query', { sql: 'SELECT sum(amount) FROM customer_orders' }),
      tool('execute_query', { sql: "SELECT sum(revenue) AS total FROM customer_orders WHERE email = 'ana@acme.com'" }),
      'Total is 100.',
    ];
    const t = await runTask({ request: 'What is revenue for ana?' });
    expect(t.status).toBe('completed');
    const mine = (await api('GET', `/api/agent/memory?workspace_id=${ws}`)).json.memories as Memory[];
    const kinds = mine.map((m) => `${m.scope}:${m.kind}:${m.subject}`).sort();
    expect(kinds).toEqual(['user:failure:execute_query:', 'user:suggestion:metric-for:customer_orders:sum(revenue)', 'workspace:discovery:customer_orders']);
    expect(mine.find((m) => m.kind === 'discovery')!.text).toMatch(/^customer_orders has columns order_id INTEGER, order_date DATE, region VARCHAR, email VARCHAR, revenue DECIMAL/);
    // Nothing from a result is kept for the workspace.
    for (const m of mine.filter((x) => x.scope === 'workspace')) expect(m.text).not.toMatch(/ana@acme|100/);
    // A viewer of the workspace sees the shared fact, not the author's private memories.
    const theirs = (await api('GET', `/api/agent/memory?workspace_id=${ws}`, undefined, viewerJwt)).json.memories as Memory[];
    expect(theirs.map((m) => `${m.scope}:${m.kind}`)).toEqual(['workspace:discovery']);
  });

  it('recalls memories into the next task\'s context, and counts their use', async () => {
    script.requests = [];
    script.replies = ['orders are in customer_orders.'];
    const t = await runTask({ request: 'Which columns does customer_orders have?' });
    expect(t.status).toBe('completed');
    expect(script.requests[0]!.system).toContain('### What earlier work in this workspace found');
    expect(script.requests[0]!.system).toMatch(/- customer_orders has columns order_id INTEGER/);
    const shared = ((await api('GET', `/api/agent/memory?workspace_id=${ws}`)).json.memories as Memory[]).find((m) => m.kind === 'discovery')!;
    expect(shared.uses).toBeGreaterThanOrEqual(1);
  });

  it('lets the author or a workspace owner forget, and nobody else', async () => {
    const shared = ((await api('GET', `/api/agent/memory?workspace_id=${ws}`)).json.memories as Memory[]).find((m) => m.kind === 'discovery')!;
    expect((await api('DELETE', `/api/agent/memory/${shared.id}`, undefined, viewerJwt)).status).toBe(403);
    expect((await api('DELETE', `/api/agent/memory/${shared.id}`)).status).toBe(200);
    expect(((await api('GET', `/api/agent/memory?workspace_id=${ws}`)).json.memories as Memory[]).some((m) => m.id === shared.id)).toBe(false);
  });

  it('reports telemetry by decision engine and model, with an estimated cost and Prometheus metrics', async () => {
    ctx.cfg.agent.pricing = { scripted: { input: 3, output: 15 } };
    script.replies = ['Nothing to do.'];
    const t = await runTask({ request: 'Say something' });
    expect(t.telemetry!.estimated_cost_usd).toBe(0.0006);
    const tel = (await api('GET', '/api/agent/telemetry?days=1')).json;
    expect(tel.tasks).toBeGreaterThanOrEqual(3);
    expect(tel.groups[0]).toMatchObject({ decision_engine: 'default', provider: 'openai', model: 'scripted-1' });
    expect(tel.groups[0].avg_context_considered).toBeGreaterThan(0);
    expect((await api('GET', '/api/agent/telemetry?all=1', undefined, viewerJwt)).status).toBe(403);
    const { registry } = await import('../observability/metrics.js');
    const text = await registry.metrics();
    expect(text).toMatch(/duckview_agent_tasks_total\{status="completed",decision_engine="default",via="ui"\} \d+/);
    expect(text).toMatch(/duckview_agent_tool_calls_total\{tool="execute_query",status="error"\} \d+/);
    expect(text).toMatch(/duckview_agent_estimated_cost_usd_total\{provider="openai"\} 0\.0006/);
  });
});

