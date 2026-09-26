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
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildAgentMcpServer } from '../agent/mcp-agent.js';
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
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dv-missions-')));
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

const waitDone = async (missionId: string) => {
  for (let i = 0; i < 200; i++) {
    const m = (await api('GET', `/api/agent/missions/${missionId}`)).json.mission;
    if (m && !['running', 'planning'].includes(m.status)) return m;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('mission did not finish');
};

describe('missions', () => {
  let missionId: string;

  it('starts a mission on chosen datasets, tells chosen from discovered, and leaves charts and findings', async () => {
    script.requests = [];
    script.replies = [
      tool('execute_query', { sql: 'SELECT region, sum(revenue) AS revenue FROM customer_orders GROUP BY 1 ORDER BY 1' }),
      tool('execute_query', { sql: 'SELECT count(*) AS n FROM inventory' }),
      '- EU has 150 in revenue\n- US has 300 in revenue',
    ];
    const r = await api('POST', '/api/agent/missions', { workspace_id: ws, request: 'Compare revenue by region', mode: 'analyse', datasets: ['customer_orders'] });
    expect(r.status).toBe(200);
    missionId = r.json.mission.id;
    expect(r.json.mission).toMatchObject({ mode: 'analyse', datasets: ['customer_orders'], context: { explicit: ['customer_orders'] } });
    const m = await waitDone(missionId);
    expect(m).toMatchObject({ status: 'completed', progress: 100, activity: 'EU has 150 in revenue', context: { explicit: ['customer_orders'], discovered: ['inventory'] } });
    // The model was told which datasets the person chose.
    expect(script.requests[0]!.system).toMatch(/### Datasets the person chose \(work with these first\)\n- table customer_orders/);
    const artifacts = m.tasks[0].artifacts as { type: string; title: string; data: Record<string, any>; open: { allowed: boolean } }[];
    expect(artifacts.map((a) => a.type)).toEqual(['table', 'table', 'dataset', 'finding']);
    expect(artifacts[0]!.data.chart).toEqual({ kind: 'bar', x: 'region', y: ['revenue'] });
    expect(artifacts[3]!.data.items).toEqual(['EU has 150 in revenue', 'US has 300 in revenue']);
    expect(artifacts[0]!.open).toEqual({ allowed: true, reason: null });
  });

  it('refuses datasets the person cannot see', async () => {
    const bad = await api('POST', '/api/agent/missions', { workspace_id: ws, request: 'x', datasets: ['secret_table'] });
    expect(bad.status).toBe(400);
    expect(bad.json.message).toMatch(/no table, view or file called "secret_table"/);
    expect((await api('POST', '/api/agent/missions', { workspace_id: other, request: 'x', datasets: ['customer_orders'] })).status).toBe(400);
    expect((await api('POST', '/api/agent/missions', { workspace_id: ws, request: 'x' }, viewerJwt)).status).not.toBe(403);
  });

  it('serves the Agent Home in one call, and capabilities from the existing permissions', async () => {
    const home = (await api('GET', `/api/agent/home?workspace_id=${ws}`)).json;
    expect(home.workspace_id).toBe(ws);
    expect(home.workspaces.map((w: { name: string }) => w.name).sort()).toEqual(['Other', 'Sales']);
    expect(home.recent.map((m: { id: string }) => m.id)).toContain(missionId);
    expect(home.capabilities).toMatchObject({ role: 'OWNER', persona: 'admin', can_write: true, console: { dbt: true, sql: 'write' } });
    const viewerHome = (await api('GET', '/api/agent/home', undefined, viewerJwt)).json;
    expect(viewerHome.workspaces.map((w: { name: string }) => w.name)).toEqual(['Sales']);
    expect(viewerHome.capabilities).toMatchObject({ role: 'VIEWER', persona: 'viewer', can_write: false, console: { dbt: false, sql: 'read', dashboards: 'view' }, agent: { approve: false } });
    const ds = (await api('GET', `/api/agent/workspaces/${ws}/datasets?q=order`)).json;
    expect(ds.datasets.map((d: { name: string }) => d.name)).toEqual(['customer_orders']);
    expect((await api('GET', `/api/agent/workspaces/${ws}/datasets`)).json.recent).toEqual(['customer_orders']);
    expect((await api('GET', `/api/agent/workspaces/${other}/datasets`, undefined, viewerJwt)).status).toBe(404);
  });

  it('shares a mission without widening access: a restricted viewer sees steps, not values, and re-runs as themselves', async () => {
    // Not shared yet: invisible to the viewer.
    expect((await api('GET', `/api/agent/missions/${missionId}`, undefined, viewerJwt)).status).toBe(404);
    expect((await api('PATCH', `/api/agent/missions/${missionId}`, { visibility: 'workspace' })).status).toBe(200);
    expect((await api('POST', `/api/workspaces/${ws}/policies`, { name: 'EU only', table_name: 'customer_orders', row_filter: "region = 'EU'", applies_to: { roles: ['VIEWER'] } })).status).toBe(200);
    const seen = (await api('GET', `/api/agent/missions/${missionId}`, undefined, viewerJwt)).json.mission;
    expect(seen.restricted).toBe(true);
    expect(seen.tasks[0].answer).toMatch(/^Hidden:/);
    const table = seen.tasks[0].artifacts.find((a: { type: string }) => a.type === 'table');
    expect(table.data).toMatchObject({ rows: [], redacted: true, sql: expect.stringContaining('customer_orders') });
    expect(seen.tasks[0].artifacts.some((a: { type: string }) => a.type === 'finding')).toBe(false);
    expect(seen.activity).toBe('Completed');
    const listed = (await api('GET', `/api/agent/missions?workspace_id=${ws}`, undefined, viewerJwt)).json.missions.find((x: { id: string }) => x.id === missionId);
    expect(listed.activity).toBe('Completed');
    const rerun = (await api('POST', `/api/agent/artifacts/${table.id}/run`, {}, viewerJwt)).json.result;
    expect(rerun.rows).toEqual([['EU', 150]]);
    // Theirs to read, not to change.
    expect((await api('POST', `/api/agent/missions/${missionId}/messages`, { request: 'more' }, viewerJwt)).status).toBe(403);
    expect((await api('PATCH', `/api/agent/missions/${missionId}`, { title: 'x' }, viewerJwt)).status).toBe(403);
    expect((await api('GET', '/api/agent/artifacts', undefined, viewerJwt)).json.artifacts.find((a: { id: string }) => a.id === table.id).data.rows).toEqual([]);
  });

  it('continues, duplicates, archives and cancels', async () => {
    script.replies = ['EU is ahead.'];
    const cont = await api('POST', `/api/agent/missions/${missionId}/messages`, { request: 'Which region is ahead?' });
    expect(cont.status).toBe(200);
    const m = await waitDone(missionId);
    expect(m.tasks).toHaveLength(2);
    const copy = (await api('POST', `/api/agent/missions/${missionId}/duplicate`)).json.mission;
    expect(copy).toMatchObject({ title: 'Compare revenue by region (copy)', mode: 'analyse', datasets: ['customer_orders'], status: 'new', tasks: [] });
    expect((await api('PATCH', `/api/agent/missions/${copy.id}`, { archived: true })).json.mission.archived).toBe(true);
    expect((await api('GET', `/api/agent/missions?status=archived&workspace_id=${ws}`)).json.missions.map((x: { id: string }) => x.id)).toEqual([copy.id]);
    script.replies = [(req) => new Promise((resolve) => req.signal?.addEventListener('abort', () => resolve('stopped')))];
    const slow = (await api('POST', '/api/agent/missions', { workspace_id: ws, request: 'Take your time' })).json.mission;
    expect((await api('GET', '/api/agent/missions?status=active')).json.missions.map((x: { id: string }) => x.id)).toContain(slow.id);
    const cancelled = (await api('POST', `/api/agent/missions/${slow.id}/cancel`)).json.mission;
    expect(['cancelled', 'running']).toContain(cancelled.status);
    expect((await waitDone(slow.id)).status).toBe('cancelled');
  });

  it('runs missions over the Agent MCP server with the same runtime', async () => {
    const admin = ctx.auth.principalFromUser((await ctx.auth.findByEmail('admin@test.local'))!, 'token');
    const server = buildAgentMcpServer(ctx, { ...admin, actorType: 'AGENT', scopes: ['read', 'write', 'mcp'] }, { defaultWorkspaceId: ws });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: 't', version: '0' });
    await client.connect(ct);
    script.replies = ['- Orders are in customer_orders'];
    const started = (await client.callTool({ name: 'start_mission', arguments: { request: 'Explore the orders', mode: 'explore', datasets: ['customer_orders'] } })).structuredContent as Record<string, any>;
    const got = (await client.callTool({ name: 'get_mission', arguments: { mission_id: started.missionId, wait_seconds: 10 } })).structuredContent as Record<string, any>;
    expect(got).toMatchObject({ status: 'completed', progress: 100, mode: 'explore', context: { explicit: ['customer_orders'] }, findings: ['Orders are in customer_orders'] });
    script.replies = ['Still customer_orders.'];
    const resumed = (await client.callTool({ name: 'resume_mission', arguments: { mission_id: started.missionId, request: 'Anything else?' } })).structuredContent as Record<string, any>;
    expect(resumed).toMatchObject({ status: 'completed', answer: 'Still customer_orders.' });
    await client.close();
  });
});
