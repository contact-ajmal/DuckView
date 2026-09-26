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
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

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

let token: string;
let scopedOther: string;
let noMcp: string;

async function connect(path: string, tok: string) {
  const client = new Client({ name: 'external-agent', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}${path}`), { requestInit: { headers: { authorization: `Bearer ${tok}` } } }));
  return client;
}

beforeAll(async () => {
  initLogger({ level: 'silent', stderr: true, pretty: false });
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dv-agentmcp-')));
  const cfg = loadConfig({ configPath: null, env: { DUCKVIEW_DATA_DIR: path.join(dir, 'data'), DUCKVIEW_FILESYSTEM_MODE: 'sandboxed', DUCKDB_TEMP_DIRECTORY: path.join(dir, 'spill'), DATABASE_URL: ':memory:', DUCKDB_MEMORY_LIMIT: '1GB', DUCKVIEW_ADMIN_EMAIL: 'admin@test.local', DUCKVIEW_ADMIN_PASSWORD: 'super-secret-pw', DUCKVIEW__apps__enabled: 'false', LOG_LEVEL: 'silent' } });
  ctx = await createContext(cfg);
  ctx.agentRuntime.modelFactory = async () => new LlmReasoningModel(scriptedProvider);
  const admin = ctx.auth.principalFromUser((await ctx.auth.findByEmail('admin@test.local'))!, 'jwt', '127.0.0.1');
  ws = (await ctx.workspaces.create(admin, { name: 'Sales', active_db_path: 'sales.duckdb' })).id;
  other = (await ctx.workspaces.create(admin, { name: 'Other', active_db_path: 'other.duckdb' })).id;
  await ctx.queries.run(admin, ws, "CREATE TABLE customer_orders AS SELECT * FROM (VALUES ('EU', 100.0), ('US', 300.0)) t(region, revenue)", { cache: false });
  ({ app } = await buildApp(ctx));
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  jwt = ((await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@test.local', password: 'super-secret-pw' }) })).json()) as { token: string }).token;
  token = (await api('POST', '/api/tokens', { name: 'claude', scopes: ['read', 'write', 'mcp'], workspace_id: ws })).json.token;
  scopedOther = (await api('POST', '/api/tokens', { name: 'other', scopes: ['read', 'mcp'], workspace_id: other })).json.token;
  noMcp = (await api('POST', '/api/tokens', { name: 'rest only', scopes: ['read'] })).json.token;
  void viewerJwt;
});

afterAll(async () => {
  await app?.close();
  await ctx?.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('Agent MCP server (/mcp/agent)', () => {
  it('needs a token with the mcp scope, and offers the high-level agent tools', async () => {
    expect((await fetch(`${base}/mcp/agent`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(401);
    await expect(connect('/mcp/agent', noMcp)).rejects.toThrow();
    const client = await connect('/mcp/agent', token);
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(['analyse_dataset', 'ask_data_agent', 'build_dashboard', 'create_analysis', 'create_data_app', 'explain_data', 'get_agent_task', 'get_mission', 'investigate_data', 'list_agent_sessions', 'resume_mission', 'start_mission']);
    await client.close();
    // The low-level MCP server is unchanged beside it.
    const low = await connect('/mcp', token);
    expect((await low.listTools()).tools.map((t) => t.name)).toContain('execute_query');
    await low.close();
  });

  it('runs a task in the token\'s workspace, streams progress, and returns the structured contract', async () => {
    script.replies = [tool('execute_query', { sql: 'SELECT region, sum(revenue) AS revenue FROM customer_orders GROUP BY 1 ORDER BY 1' }), 'EU 100, US 300.'];
    const client = await connect('/mcp/agent', token);
    const progress: string[] = [];
    const r = await client.callTool({ name: 'ask_data_agent', arguments: { request: 'Revenue by region' } }, undefined, { onprogress: (p) => progress.push(String(p.message ?? '')) });
    const c = r.structuredContent as Record<string, any>;
    expect(c).toMatchObject({ status: 'completed', answer: 'EU 100, US 300.', workspaceId: ws, approval: null });
    expect(c.artifacts[0]).toMatchObject({ type: 'table', data: { columns: ['region', 'revenue'], rows: [['EU', 100], ['US', 300]], sql: expect.stringContaining('customer_orders') } });
    expect(c.steps).toEqual([{ tool: 'execute_query', status: 'ok', summary: '2 rows: region, revenue' }]);
    expect(progress.some((m) => /^Running Execute SQL/.test(m))).toBe(true);
    expect(progress.some((m) => /Selected \d+ of \d+ things/.test(m))).toBe(true);
    // Continue the session: earlier requests and answers come along.
    script.requests = [];
    script.replies = ['It was EU 100 and US 300.'];
    const again = (await client.callTool({ name: 'ask_data_agent', arguments: { request: 'Remind me', session_id: c.sessionId } })).structuredContent as Record<string, any>;
    expect(again.sessionId).toBe(c.sessionId);
    expect(script.requests[0]!.messages.slice(0, 2).map((m) => m.content)).toEqual(['Revenue by region', 'EU 100, US 300.']);
    await client.close();
  });

  it('keeps a token to its workspace', async () => {
    const client = await connect('/mcp/agent', scopedOther);
    const r = await client.callTool({ name: 'ask_data_agent', arguments: { request: 'hi', workspace_id: ws } });
    expect(r.isError).toBe(true);
    expect((r.content as { text: string }[])[0]!.text).toMatch(/scoped to a different workspace/);
    await client.close();
  });

  it('pauses a change until a person approves it in DuckView; the client can only wait', async () => {
    script.replies = [tool('execute_query', { sql: 'CREATE TABLE made_by_mcp AS SELECT 1 AS x' })];
    const client = await connect('/mcp/agent', token);
    const r = (await client.callTool({ name: 'ask_data_agent', arguments: { request: 'Create the table made_by_mcp' } })).structuredContent as Record<string, any>;
    expect(r).toMatchObject({ status: 'waiting_approval', approval: { tool: 'execute_query', approveIn: `#/?agent_task=${r.taskId}` } });
    // The token cannot approve its own change.
    expect((await api('POST', `/api/agent/tasks/${r.taskId}/approval`, { decision: 'approve' }, token)).status).toBe(403);
    script.replies = ['Made it.'];
    expect((await api('POST', `/api/agent/tasks/${r.taskId}/approval`, { decision: 'approve' })).status).toBe(200);
    const done = (await client.callTool({ name: 'get_agent_task', arguments: { task_id: r.taskId, wait_seconds: 20 } })).structuredContent as Record<string, any>;
    expect(done).toMatchObject({ status: 'completed', answer: 'Made it.' });
    expect((await api('POST', `/api/workspaces/${ws}/query`, { sql: 'SELECT count(*) FROM made_by_mcp' })).json.rows).toEqual([[1]]);
    const sessions = (await client.callTool({ name: 'list_agent_sessions', arguments: {} })).structuredContent as { sessions: { title: string }[] };
    expect(sessions.sessions.map((s) => s.title)).toContain('Create the table made_by_mcp');
    await client.close();
  });
});
