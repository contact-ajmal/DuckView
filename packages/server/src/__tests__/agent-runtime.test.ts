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
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dv-agentrt-')));
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

describe('agent runtime', () => {
  it('answers through tools it was given, keeps what it learned, and shows only a selection to the model', async () => {
    script.requests = [];
    script.replies = [
      `\`\`\`plan\n- Find the orders table\n- Sum revenue by region\n\`\`\`\n${tool('execute_query', { sql: 'SELECT region, sum(revenue) AS revenue FROM customer_orders GROUP BY 1 ORDER BY 1', workspace_id: other })}`,
      'EU has **150** and US **300** in revenue (SQL: sum of `revenue` by `region` in customer_orders).',
    ];
    const t = await runTask({ request: 'Compare revenue by region' });
    expect(t.status).toBe('completed');
    expect(t.intent).toBe('analyse');
    expect(t.answer).toBe('EU has **150** and US **300** in revenue (SQL: sum of `revenue` by `region` in customer_orders).');
    expect(t.plan.map((s) => [s.text, s.status])).toEqual([['Find the orders table', 'done'], ['Sum revenue by region', 'done']]);
    expect(t.steps.map((s) => `${s.kind}:${s.status}`)).toEqual(['route:ok', 'context:ok', 'tool:ok', 'answer:ok']);
    expect(t.steps[2]!.summary).toBe('2 rows: region, revenue');
    // The model's workspace_id was replaced by the session's workspace.
    expect(t.artifacts).toEqual([expect.objectContaining({ type: 'table', tool: 'execute_query', data: expect.objectContaining({ rows: [['EU', 150], ['US', 300]], row_count: 2 }) }), expect.objectContaining({ type: 'dataset', title: 'customer_orders', data: { name: 'customer_orders', explicit: false } })]);
    expect(t.telemetry).toMatchObject({ decision_engine: 'default', tool_calls: 1, tool_failures: 0, llm_calls: 2, input_tokens: 200, output_tokens: 40 });
    expect(t.telemetry!.context_objects_selected).toBeGreaterThan(0);
    // The model saw a selection of tools and context, never the whole registry.
    const system = script.requests[0]!.system;
    const toolLines = system.split('\n').filter((l) => /^- [a-z_]+\(/.test(l));
    expect(toolLines.length).toBeLessThanOrEqual(13);
    expect(system).toContain('- execute_query(');
    expect(system).not.toContain('- publish_app(');
    expect(system).toContain('table customer_orders');
    // What it learned was stored.
    const obs = (await api('GET', `/api/agent/sessions/${t.session_id}/observations`)).json.observations;
    expect(obs[0]).toMatchObject({ kind: 'result', tool: 'execute_query', text: expect.stringMatching(/^A query returned 2 rows \(region, revenue\)/) });
  });

  it('moves the workspace without a model call for plain navigation', async () => {
    script.requests = [];
    const t = await runTask({ request: 'Open the revenue dashboard' });
    expect(t.status).toBe('completed');
    expect(t.actions).toEqual([expect.objectContaining({ action: 'open_dashboard', href: expect.stringMatching(/^#\/dashboards\//), args: { name: 'Revenue overview' } })]);
    expect(t.answer).toBe('Opened the dashboard Revenue overview.');
    expect(script.requests).toHaveLength(0);
  });

  it('repairs a failed call from the error, and continues the session with what came before', async () => {
    script.requests = [];
    script.replies = [
      tool('execute_query', { sql: 'SELECT sum(amount) FROM customer_orders' }),
      tool('execute_query', { sql: 'SELECT sum(revenue) AS total FROM customer_orders' }),
      'Total revenue is 450.',
    ];
    const first = await runTask({ request: 'What is total revenue?' });
    expect(first.status).toBe('completed');
    expect(first.steps.filter((s) => s.kind === 'tool').map((s) => s.status)).toEqual(['error', 'ok']);
    expect(first.telemetry).toMatchObject({ tool_calls: 2, tool_failures: 1 });
    expect(script.requests[1]!.messages.at(-1)!.content).toMatch(/Result of execute_query:\nERROR .*amount[\s\S]*The call failed. Fix it and try again \(attempt 1 of 3\)/);

    script.replies = ['It was 450 (from the previous answer).'];
    const next = await runTask({ request: 'And what did you find before?', session_id: first.session_id });
    expect(next.session_id).toBe(first.session_id);
    const msgs = script.requests.at(-1)!.messages.map((m) => `${m.role}:${m.content}`);
    expect(msgs.slice(0, 2)).toEqual(['user:What is total revenue?', 'assistant:Total revenue is 450.']);
    const session = (await api('GET', `/api/agent/sessions/${first.session_id}`)).json.session;
    expect(session.tasks.map((x: AgentTask) => x.request)).toEqual(['What is total revenue?', 'And what did you find before?']);
  });

  it('pauses a change for the person, runs it only once they approve, and never on a token', async () => {
    script.replies = [tool('execute_query', { sql: 'CREATE TABLE agent_made AS SELECT 1 AS x' })];
    const paused = await runTask({ request: 'Create a table agent_made with one row' });
    expect(paused.status).toBe('waiting_approval');
    expect(paused.approval).toMatchObject({ tool: 'execute_query', action_class: 'READ', preview: expect.stringContaining('CREATE TABLE agent_made') });
    expect((await api('GET', `/api/agent/approvals?workspace_id=${ws}`)).json.tasks.map((t: AgentTask) => t.id)).toContain(paused.id);
    // Not created yet.
    expect((await api('POST', `/api/workspaces/${ws}/query`, { sql: "SELECT count(*) FROM information_schema.tables WHERE table_name = 'agent_made'" })).json.rows).toEqual([[0]]);
    // A token (an agent, a script) cannot approve.
    const token = (await api('POST', '/api/tokens', { name: 'script', scopes: ['read', 'write', 'mcp'] })).json.token as string;
    expect((await api('POST', `/api/agent/tasks/${paused.id}/approval`, { decision: 'approve' }, token)).status).toBe(403);
    script.replies = ['Created agent_made.'];
    const events: AgentEvent[] = [];
    const off = ctx.agentRuntime.events.subscribe(paused.id, (e) => events.push(e));
    expect((await api('POST', `/api/agent/tasks/${paused.id}/approval`, { decision: 'approve' })).status).toBe(200);
    const done = await ctx.agentRuntime.wait(ctx.auth.principalFromUser((await ctx.auth.findByEmail('admin@test.local'))!, 'jwt'), paused.id);
    off();
    expect(done.status).toBe('completed');
    expect(done.approval).toMatchObject({ decision: 'approved', decided_by: expect.any(String) });
    expect(events.map((e) => e.type)).toContain('agent.approval.granted');
    expect((await api('POST', `/api/workspaces/${ws}/query`, { sql: 'SELECT count(*) FROM agent_made' })).json.rows).toEqual([[1]]);

    script.replies = [tool('execute_query', { sql: 'DROP TABLE inventory' }), (req) => (req.messages.at(-1)!.content.includes('The person declined execute_query: "keep it"') ? 'I did not drop inventory.' : 'wrong')];
    const p2 = await runTask({ request: 'Drop the inventory table' });
    expect(p2.status).toBe('waiting_approval');
    await api('POST', `/api/agent/tasks/${p2.id}/approval`, { decision: 'deny', note: 'keep it' });
    const d2 = await ctx.agentRuntime.wait(ctx.auth.principalFromUser((await ctx.auth.findByEmail('admin@test.local'))!, 'jwt'), p2.id);
    expect(d2).toMatchObject({ status: 'completed', answer: 'I did not drop inventory.' });
    expect((await api('POST', `/api/workspaces/${ws}/query`, { sql: 'SELECT count(*) FROM inventory' })).status).toBe(200);
  });

  it('can be cancelled while the model is working', async () => {
    let release: () => void = () => undefined;
    script.replies = [(req) => new Promise((resolve) => {
      release = () => resolve('late');
      req.signal?.addEventListener('abort', () => resolve('aborted'));
    })];
    const started = (await api('POST', '/api/agent/tasks', { workspace_id: ws, request: 'Take your time' })).json.task as AgentTask;
    for (let i = 0; i < 50 && script.replies.length; i++) await new Promise((r) => setTimeout(r, 20));
    expect((await api('POST', `/api/agent/tasks/${started.id}/cancel`)).status).toBe(200);
    release();
    const t = await ctx.agentRuntime.wait(ctx.auth.principalFromUser((await ctx.auth.findByEmail('admin@test.local'))!, 'jwt'), started.id);
    expect(t.status).toBe('cancelled');
  });

  it('streams a task as Server-Sent Events', async () => {
    script.replies = ['Streaming works.'];
    const started = (await api('POST', '/api/agent/tasks', { workspace_id: ws, request: 'Say hello' })).json.task as AgentTask;
    const res = await fetch(`${base}/api/agent/tasks/${started.id}/events`, { headers: { authorization: `Bearer ${jwt}` } });
    const body = await res.text();
    const types = [...body.matchAll(/^event: (.+)$/gm)].map((m) => m[1]);
    expect(types[0]).toBe('task');
    expect(types).toEqual(expect.arrayContaining(['agent.started', 'agent.context.selected', 'agent.answer.delta', 'agent.completed']));
    expect(types.at(-1)).toBe('agent.completed');
  });

  it('acts as the person: row policies, column masks, read-only access and token scopes still apply', async () => {
    const pol = await api('POST', `/api/workspaces/${ws}/policies`, { name: 'EU only', table_name: 'customer_orders', row_filter: "region = 'EU'", column_masks: { email: { kind: 'redact' } }, applies_to: { roles: ['VIEWER'] } });
    expect(pol.status).toBe(200);
    script.requests = [];
    script.replies = [tool('execute_query', { sql: 'SELECT count(*) AS n, min(email) AS email FROM customer_orders' }), tool('create_dashboard_widget', { dashboard_name: 'Viewer board', title: 'x', sql: 'SELECT 1', widget_type: 'KPI' }), 'Done.'];
    const t = await runTask({ request: 'How many orders are there?' }, viewerJwt);
    expect(t.status).toBe('completed');
    expect(t.artifacts[0]!.data!.rows).toEqual([[2, expect.not.stringContaining('@')]]);
    // A viewer is not offered writing tools, and cannot use them anyway.
    expect(script.requests[0]!.system).not.toContain('- create_dashboard_widget(');
    expect(t.steps.find((s) => s.tool === 'create_dashboard_widget')).toMatchObject({ status: 'error', summary: 'create_dashboard_widget is not available' });
    // A token bound to another workspace cannot start a task here.
    const scoped = (await api('POST', '/api/tokens', { name: 'other only', scopes: ['read', 'mcp'], workspace_id: other })).json.token as string;
    expect((await api('POST', '/api/agent/tasks', { workspace_id: ws, request: 'hi' }, scoped)).status).toBe(403);
    // Someone who is not a member cannot see the session of another.
    expect((await api('GET', `/api/agent/sessions/${t.session_id}`)).status).toBe(404);
  });

  it('marks what the agent changed as the agent\'s in version history', async () => {
    script.replies = [tool('save_query', { name: 'Revenue by region', sql: 'SELECT region, sum(revenue) FROM customer_orders GROUP BY 1' }), 'Saved.'];
    const t = await runTask({ request: 'Save a query of revenue by region' });
    expect(t.status).toBe('completed');
    const id = (t.artifacts.find((a) => a.type === 'saved_query')!.data as { id: string }).id;
    const revs = (await api('GET', `/api/workspaces/${ws}/revisions?object_type=query&object_id=${id}`)).json.revisions;
    expect(revs[0]).toMatchObject({ actor_type: 'AGENT' });
  });
});
