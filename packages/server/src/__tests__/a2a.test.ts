/**
 * Agent2Agent: DuckView's public Agent Card and published agents' cards, JSON-RPC over HTTP with an API token
 * (message/send, message/stream as SSE, tasks/get, tasks/cancel, the extended card), runs that act as the caller
 * under their access policies, and the client side — a remote agent registered by its card (here DuckView itself),
 * asked from the API and through the list_agents / ask_agent tools.
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
import { buildTools, runTool, type ToolEnv } from '../agent/tools.js';
import type { ProviderFactory, LlmProvider, LlmRequest, LlmUsage } from '../services/llm.js';
import type { Principal } from '../services/principal.js';
import type { HostedAgent } from '../db/schema/sqlite.js';

let dir: string;
let ctx: AppContext;
let app: Awaited<ReturnType<typeof buildApp>>['app'];
let base: string;
let wsId: string;
let admin: Principal;
let adminToken: string;
let viewerToken: string;
let outsiderToken: string;
let agent: HostedAgent;

const tool = (name: string, args: Record<string, unknown>) => `\`\`\`tool\n${JSON.stringify({ name, arguments: args })}\n\`\`\``;
const stub: ProviderFactory = (id, opts) => {
  const p: LlmProvider = {
    id,
    model: opts.model ?? 'stub',
    async *stream(req: LlmRequest): AsyncGenerator<string, LlmUsage, void> {
      const first = String(req.messages[0]?.content ?? '');
      const last = String(req.messages.at(-1)?.content ?? '');
      if (/slowly/.test(first)) await new Promise((r) => setTimeout(r, 400));
      if (last.startsWith('Result of execute_query')) yield `Total revenue is ${/\b(\d{2,})\b/.exec(last)?.[1] ?? '?'}.`;
      else if (last.startsWith('Result of')) yield tool('list_accessible_data', {});
      else if (/slowly/.test(first)) yield tool('list_accessible_data', {});
      else yield tool('execute_query', { sql: 'SELECT sum(amount)::INTEGER AS total FROM orders' });
      return { input_tokens: 1, output_tokens: 1 };
    },
    async listModels() {
      return ['stub'];
    },
  };
  return p;
};

const rpc = async (url: string, token: string | null, method: string, params: Record<string, unknown>) => {
  const r = await fetch(`${base}${url}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 7, method, params }) });
  return { status: r.status, headers: r.headers, body: (await r.json()) as { id: number; result?: Record<string, any>; error?: { code: number; message: string } } };
};
const msg = (text: string, extra: Record<string, unknown> = {}) => ({ message: { kind: 'message', role: 'user', messageId: `m-${Math.random()}`, parts: [{ kind: 'text', text }], ...extra } });

beforeAll(async () => {
  initLogger({ level: 'silent', stderr: true, pretty: false });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dv-a2a-'));
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  const cfg = loadConfig({ configPath: null, env: { DUCKVIEW_DATA_DIR: path.join(dir, 'data'), DUCKDB_TEMP_DIRECTORY: path.join(dir, 'spill'), DATABASE_URL: ':memory:', DUCKDB_MEMORY_LIMIT: '512MB', DUCKVIEW_ADMIN_EMAIL: 'admin@test.local', DUCKVIEW_ADMIN_PASSWORD: 'super-secret-pw', DUCKVIEW__duckdb__sync_scheduler_enabled: 'false', DUCKVIEW__notifications__scheduler_enabled: 'false', DUCKVIEW__transform__scheduler_enabled: 'false', DUCKVIEW__apps__enabled: 'false', DUCKVIEW__a2a__allow_private_targets: 'true', DUCKVIEW__a2a__timeout_seconds: '20', COPILOT_PROVIDER: 'anthropic', COPILOT_API_KEY: 'k', COPILOT_MODEL: 'stub', LOG_LEVEL: 'silent' } });
  ctx = await createContext(cfg, { providerFactory: stub });
  const adminUser = (await ctx.auth.findByEmail('admin@test.local'))!;
  admin = ctx.auth.principalFromUser(adminUser, 'jwt', '127.0.0.1');
  wsId = (await ctx.workspaces.create(admin, { name: 'Shop', active_db_path: 'shop.duckdb' })).id;
  await ctx.queries.run(admin, wsId, "CREATE TABLE orders AS SELECT * FROM (VALUES (1, 'EU', 100.0), (2, 'US', 50.0), (3, 'EU', 30.0)) t(id, region, amount)", { cache: false });
  const viewer = await ctx.auth.createLocalUser({ email: 'viewer@test.local', password: 'viewer-secret-pw', role: 'USER' });
  const outsider = await ctx.auth.createLocalUser({ email: 'outsider@test.local', password: 'outsider-secret-pw', role: 'USER' });
  await ctx.workspaces.setMember(admin, wsId, { subject_type: 'user', subject_id: viewer.id, role: 'VIEWER' });
  await ctx.policies.create(admin, wsId, { name: 'Viewers: EU', table_name: 'orders', row_filter: "region = 'EU'", applies_to: { roles: ['VIEWER'] } });
  adminToken = (await ctx.auth.createToken(adminUser, { name: 'a2a', scopes: ['read', 'mcp'] })).token;
  viewerToken = (await ctx.auth.createToken(viewer, { name: 'a2a', scopes: ['read'] })).token;
  outsiderToken = (await ctx.auth.createToken(outsider, { name: 'a2a', scopes: ['read'] })).token;
  agent = await ctx.hostedAgents.install(admin, wsId, 'data-analyst', { name: 'Revenue analyst' });
  ({ app } = await buildApp(ctx));
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as net.AddressInfo).port}`;
}, 120_000);

afterAll(async () => {
  await app?.close();
  await ctx?.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('DuckView as an A2A agent', () => {
  it('publishes cards: the server\'s always, an agent\'s once it is published', async () => {
    const card = await (await fetch(`${base}/.well-known/agent-card.json`)).json();
    expect(card).toMatchObject({ protocolVersion: '0.3.0', name: 'DuckView', url: `${base}/a2a`, preferredTransport: 'JSONRPC', capabilities: { streaming: true }, supportsAuthenticatedExtendedCard: true, security: [{ duckview: [] }] });
    expect((await fetch(`${base}/.well-known/agent.json`)).status).toBe(200);
    expect((await fetch(`${base}/a2a/agents/${agent.id}/.well-known/agent-card.json`)).status).toBe(404);
    agent = await ctx.hostedAgents.update(admin, agent.id, { published: true });
    const own = await (await fetch(`${base}/a2a/agents/${agent.id}/.well-known/agent-card.json`)).json();
    expect(own).toMatchObject({ name: 'Revenue analyst', url: `${base}/a2a/agents/${agent.id}`, skills: [{ id: 'data-analyst', name: 'Revenue analyst' }] });
  });

  it('answers message/send with a finished task, and needs a token', async () => {
    const anon = await rpc(`/a2a/agents/${agent.id}`, null, 'message/send', msg('What is total revenue?'));
    expect(anon.status).toBe(401);
    expect(anon.headers.get('www-authenticate')).toMatch(/^Bearer/);
    const r = await rpc(`/a2a/agents/${agent.id}`, adminToken, 'message/send', msg('What is total revenue?', { contextId: 'ctx-1' }));
    expect(r.body.id).toBe(7);
    const task = r.body.result!;
    expect(task).toMatchObject({ kind: 'task', contextId: 'ctx-1', status: { state: 'completed', message: { role: 'agent', parts: [{ kind: 'text', text: 'Total revenue is 180.' }] } } });
    expect(task.artifacts[0].parts[0]).toEqual({ kind: 'text', text: 'Total revenue is 180.' });
    expect(task.artifacts[0].parts[1].data.steps).toEqual([expect.objectContaining({ tool: 'execute_query', ok: true })]);
    expect(task.history.map((m: { role: string }) => m.role)).toEqual(['user', 'agent']);
    // The task can be read back by its caller only.
    expect((await rpc(`/a2a/agents/${agent.id}`, adminToken, 'tasks/get', { id: task.id })).body.result).toMatchObject({ id: task.id, status: { state: 'completed' } });
    expect((await rpc(`/a2a/agents/${agent.id}`, viewerToken, 'tasks/get', { id: task.id })).body.error).toMatchObject({ code: -32001 });
    expect((await rpc(`/a2a/agents/${agent.id}`, adminToken, 'tasks/unknown', {})).body.error).toMatchObject({ code: -32601 });
  });

  it('acts as the caller: their access policies, their workspaces', async () => {
    const r = await rpc(`/a2a/agents/${agent.id}`, viewerToken, 'message/send', msg('What is total revenue?'));
    expect(r.body.result!.status.message.parts[0].text).toBe('Total revenue is 130.');
    const outsider = await rpc(`/a2a/agents/${agent.id}`, outsiderToken, 'message/send', msg('What is total revenue?'));
    expect(outsider.body.error).toBeTruthy();
    expect(outsider.body.result).toBeUndefined();
  });

  it('routes the server endpoint by metadata.agent, and lists reachable agents in the extended card', async () => {
    const ext = await rpc('/a2a', viewerToken, 'agent/getAuthenticatedExtendedCard', {});
    expect(ext.body.result!.skills).toEqual([expect.objectContaining({ id: agent.id, name: 'Revenue analyst' })]);
    expect((await rpc('/a2a', outsiderToken, 'agent/getAuthenticatedExtendedCard', {})).body.result!.skills).toEqual([]);
    const r = await rpc('/a2a', adminToken, 'message/send', { ...msg('What is total revenue?'), metadata: { agent: 'revenue analyst' } });
    expect(r.body.result!.status.state).toBe('completed');
    // Two callers at once both get an answer.
    const both = await Promise.all([rpc(`/a2a/agents/${agent.id}`, adminToken, 'message/send', msg('What is total revenue?')), rpc(`/a2a/agents/${agent.id}`, viewerToken, 'message/send', msg('What is total revenue?'))]);
    expect(both.map((x) => x.body.result?.status.message.parts[0].text)).toEqual(['Total revenue is 180.', 'Total revenue is 130.']);
  });

  it('streams a task as server-sent events', async () => {
    const res = await fetch(`${base}/a2a/agents/${agent.id}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'message/stream', params: msg('What is total revenue?') }) });
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    const events = (await res.text()).split('\n\n').filter((b) => b.startsWith('data: ')).map((b) => JSON.parse(b.slice(6)).result);
    expect(events.map((e) => (e.kind === 'task' ? `task:${e.status.state}` : e.kind === 'status-update' ? `status:${e.status.state}${e.final ? ':final' : ''}` : e.kind))).toEqual(['task:submitted', 'status:working', 'artifact-update', 'status:completed:final']);
    expect(events[2].artifact.parts[0].text).toBe('Total revenue is 180.');
  });

  it('runs in the background when not blocking, and cancels', async () => {
    const r = await rpc(`/a2a/agents/${agent.id}`, adminToken, 'message/send', { ...msg('Look around slowly.'), configuration: { blocking: false } });
    expect(r.body.result!.status.state).toBe('working');
    await new Promise((res) => setTimeout(res, 100));
    const c = await rpc(`/a2a/agents/${agent.id}`, adminToken, 'tasks/cancel', { id: r.body.result!.id });
    expect(c.body.result!.status.state).toBe('canceled');
    expect((await rpc(`/a2a/agents/${agent.id}`, adminToken, 'tasks/cancel', { id: r.body.result!.id })).body.error).toMatchObject({ code: -32002 });
  });
});

describe('DuckView as an A2A client', () => {
  it('registers a remote agent by its card and asks it; agents do the same with ask_agent', async () => {
    // DuckView itself, as the remote agent; the token is kept encrypted and never returned.
    const remote = await ctx.a2a.addRemote(admin, { url: `${base}/a2a/agents/${agent.id}`, headers: { Authorization: `Bearer ${adminToken}` } });
    expect(remote).toMatchObject({ name: 'Revenue analyst', endpoint: `${base}/a2a/agents/${agent.id}`, headers_set: true });
    expect(JSON.stringify(remote)).not.toContain(adminToken);
    const answer = await ctx.a2a.ask(admin, remote.id, 'What is total revenue?');
    expect(answer).toMatchObject({ state: 'completed', text: 'Total revenue is 180.' });
    await expect(ctx.a2a.addRemote(admin, { url: `${base}/nothing-here` })).rejects.toThrow(/Could not read an agent card/);
    // Another person cannot use it.
    const viewer = ctx.auth.principalFromUser((await ctx.auth.findByEmail('viewer@test.local'))!, 'jwt', '127.0.0.1');
    await expect(ctx.a2a.ask(viewer, remote.id, 'hi')).rejects.toThrow(/not found/i);

    const env: ToolEnv = { ctx, principal: ctx.auth.principalFromUser((await ctx.auth.findByEmail('admin@test.local'))!, 'token'), via: 'mcp', defaultWorkspaceId: wsId, agent: null };
    const tools = buildTools(ctx.cfg);
    const call = (name: string, args: Record<string, unknown>) => runTool(env, tools.find((t) => t.name === name)!, args);
    const listed = (await call('list_agents', {})).content[0] as { text: string };
    expect(listed.text).toMatch(/DuckView agent \*\*Revenue analyst\*\*/);
    expect(listed.text).toMatch(/remote A2A agent \*\*Revenue analyst\*\*/);
    const hosted = await call('ask_agent', { agent: agent.id, message: 'What is total revenue?' });
    expect(hosted.structuredContent).toMatchObject({ status: 'ok', agent: { kind: 'hosted' }, answer: 'Total revenue is 180.' });
    const viaRemote = await call('ask_agent', { agent: remote.id, message: 'What is total revenue?' });
    expect(viaRemote.structuredContent).toMatchObject({ status: 'ok', agent: { kind: 'remote' }, answer: 'Total revenue is 180.' });
  });
});
