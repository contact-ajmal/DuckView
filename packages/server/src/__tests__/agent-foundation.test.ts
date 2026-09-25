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

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildMcpServer } from '../mcp/server.js';
import { toolRegistry } from '../agent/registry.js';
import { ACTION_CLASSES, REFINED_TOOLS, TOOL_CATEGORIES, deriveSemantics, semanticsOf } from '../agent/semantics.js';
import { parsePlan, parseToolCall, safePrefixLength, visibleText } from '../agent/reasoning/protocol.js';
import { LlmReasoningModel } from '../agent/reasoning/llm.js';
import type { ReasoningEvent } from '../agent/reasoning/types.js';
import { AgentEventBus, type AgentEvent } from '../agent/events.js';
import { liveEvents } from '../observability/events.js';
import type { LlmProvider, LlmRequest, LlmUsage } from '../services/llm.js';
import type { Principal } from '../services/principal.js';

beforeAll(async () => {
  initLogger({ level: 'silent', stderr: true, pretty: false });
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dv-agentf-')));
  const cfg = loadConfig({ configPath: null, env: { DUCKVIEW_DATA_DIR: path.join(dir, 'data'), DUCKVIEW_FILESYSTEM_MODE: 'sandboxed', DUCKDB_TEMP_DIRECTORY: path.join(dir, 'spill'), DATABASE_URL: ':memory:', DUCKDB_MEMORY_LIMIT: '1GB', DUCKVIEW_ADMIN_EMAIL: 'admin@test.local', DUCKVIEW_ADMIN_PASSWORD: 'super-secret-pw', LOG_LEVEL: 'silent' } });
  ctx = await createContext(cfg);
  ({ app } = await buildApp(ctx));
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  jwt = ((await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@test.local', password: 'super-secret-pw' }) })).json()) as { token: string }).token;
  ws = (await api('POST', '/api/workspaces', { name: 'Agent', active_db_path: 'agent.duckdb' })).json.workspace.id;
});

afterAll(async () => {
  await app?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A provider that replays a scripted reply in small chunks. */
function scripted(reply: string, usage: LlmUsage = { input_tokens: 12, output_tokens: 7 }): LlmProvider {
  return {
    id: 'openai',
    model: 'scripted',
    async *stream(_req: LlmRequest): AsyncGenerator<string, LlmUsage, void> {
      for (let i = 0; i < reply.length; i += 5) yield reply.slice(i, i + 5);
      return usage;
    },
    listModels: async () => ['scripted'],
  };
}
async function collect(it: AsyncIterable<ReasoningEvent>) {
  const out: ReasoningEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe('tool semantics', () => {
  it('every tool has complete, valid semantics, and refinements name real tools', () => {
    const reg = toolRegistry(ctx.cfg);
    const names = new Set(reg.names());
    expect(REFINED_TOOLS.filter((n) => !names.has(n))).toEqual([]);
    for (const t of reg.all()) {
      const s = semanticsOf(t);
      expect(TOOL_CATEGORIES).toContain(s.category);
      expect(ACTION_CLASSES).toContain(s.action);
      expect(s.produces.length).toBeGreaterThan(0);
      expect(s.capabilities.length).toBeGreaterThan(0);
      // Safety invariants: a read-only tool is READ and never mutates; a write tool is never classed READ unless conditional.
      if (t.annotations.readOnlyHint) expect([s.action, s.mutation]).toEqual(['READ', 'none']);
      else if (s.action === 'READ') expect(s.mutation).toBe('conditional');
      if (/^publish_/.test(t.name)) expect(s.action).toBe('PUBLISH');
    }
    expect(semanticsOf(reg.get('execute_query')!)).toMatchObject({ category: 'query', action: 'READ', mutation: 'conditional', core: true });
    expect(semanticsOf(reg.get('run_reverse_sync')!).action).toBe('EXTERNAL_SIDE_EFFECT');
    expect(semanticsOf(reg.get('query_metrics')!).requires).toEqual(['workspace', 'metric']);
  });

  it('derives semantics for a tool nobody described', () => {
    expect(deriveSemantics({ name: 'publish_thing', annotations: { readOnlyHint: false }, inputSchema: { workspace_id: {} as never } })).toMatchObject({ action: 'PUBLISH', requires: ['workspace'], mutation: 'always', produces: ['thing'] });
    expect(deriveSemantics({ name: 'list_widgets', annotations: { readOnlyHint: true }, inputSchema: {} })).toMatchObject({ category: 'dashboard', action: 'READ', mutation: 'none', produces: ['list'], requires: [] });
  });

  it('offers a read-only principal reading tools and SQL only', async () => {
    const reg = toolRegistry(ctx.cfg);
    const admin = ctx.auth.principalFromUser((await ctx.auth.findByEmail('admin@test.local'))!, 'jwt');
    const reader: Principal = { ...admin, scopes: ['read'] };
    const offered = reg.availableTo(reader).map((t) => t.name);
    expect(offered).toContain('execute_query');
    expect(offered).toContain('inspect_schema');
    expect(offered).not.toContain('create_dashboard_widget');
    expect(offered).not.toContain('publish_app');
    expect(reg.availableTo(admin).length).toBe(reg.all().length);
  });

  it('is served the same way by REST, OpenAPI, the UI catalog and MCP', async () => {
    const ui = await api('GET', '/api/agent/tools');
    expect(ui.status).toBe(200);
    const q = ui.json.tools.find((t: { name: string }) => t.name === 'query_metrics');
    expect(q).toMatchObject({ title: 'Query metrics', semantics: { category: 'semantic', action: 'READ' } });
    expect(q.summary.length).toBeLessThanOrEqual(300);
    const openapi = await api('GET', '/api/agent/openapi.json');
    expect(openapi.json.paths['/api/agent/v1/tools/publish_app'].post['x-duckview']).toMatchObject({ action: 'PUBLISH', category: 'app' });
    const admin = ctx.auth.principalFromUser((await ctx.auth.findByEmail('admin@test.local'))!, 'token');
    const server = buildMcpServer(ctx, { ...admin, actorType: 'AGENT', scopes: ['read', 'write', 'mcp'] }, { defaultWorkspaceId: ws });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: 't', version: '0' });
    await client.connect(ct);
    const listed = (await client.listTools()).tools.find((t) => t.name === 'find_joins')!;
    expect(listed._meta?.['duckview/semantics']).toMatchObject({ category: 'catalog', action: 'READ', produces: ['relationships', 'sql'] });
    await client.close();
  });
});

describe('reasoning protocol', () => {
  it('reads tool calls, plans and the visible answer', () => {
    expect(parseToolCall('```tool\n{"name": "inspect_schema", "arguments": {"file_path_or_table": "orders"}}\n```')).toEqual({ name: 'inspect_schema', arguments: { file_path_or_table: 'orders' } });
    expect(parseToolCall('```tool\n{oops}\n```')).toMatchObject({ error: expect.stringMatching(/not valid JSON/) });
    expect(parsePlan('```plan\n1. Find the revenue metric\n- Query it by region\n```')).toEqual(['Find the revenue metric', 'Query it by region']);
    expect(visibleText('Here it is.\n```plan\n- a\n```\nDone.')).toBe('Here it is.\n\nDone.');
    expect(safePrefixLength('Checking the schema ``')).toBe('Checking the schema '.length);
    expect(safePrefixLength('Look: ```sql\nSELECT 1\n``` and more')).toBe('Look: ```sql\nSELECT 1\n``` and more'.length);
  });

  it('streams an answer, and turns a tool reply into a plan and a call with nothing visible', async () => {
    const answer = await collect(new LlmReasoningModel(scripted('Revenue is **120** in EU.')).generate({ system: 's', messages: [{ role: 'user', content: 'q' }], tools: [], maxTokens: 100 }));
    expect(answer.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta).join('')).toBe('Revenue is **120** in EU.');
    expect(answer.at(-1)).toEqual({ type: 'usage', inputTokens: 12, outputTokens: 7 });
    const call = await collect(new LlmReasoningModel(scripted('```plan\n- Look at orders\n- Sum by region\n```\n```tool\n{"name": "execute_query", "arguments": {"sql": "SELECT 1"}}\n```')).generate({ system: 's', messages: [], tools: [], maxTokens: 100 }));
    expect(call.map((e) => e.type)).toEqual(['plan', 'tool_call', 'usage']);
    expect(call[1]).toEqual({ type: 'tool_call', name: 'execute_query', arguments: { sql: 'SELECT 1' } });
    const bad = await collect(new LlmReasoningModel(scripted('```tool\n{"arguments": {}}\n```')).generate({ system: 's', messages: [], tools: [], maxTokens: 100 }));
    expect(bad[0]).toEqual({ type: 'invalid_call', message: 'The tool block needs "name".' });
  });
});

describe('agent event bus', () => {
  it('numbers events per task, replays them to late subscribers, and feeds the live bus without answer deltas', () => {
    const bus = new AgentEventBus();
    const live: string[] = [];
    const off = liveEvents.subscribe((e) => { if (e.type === 'agent' && e.task_id === 't1') live.push(e.event); });
    const base = { taskId: 't1', sessionId: 's1', workspaceId: ws, userId: 'u1', traceId: 'tr' };
    bus.emit({ ...base, type: 'agent.started', data: { request: 'x' } });
    bus.emit({ ...base, type: 'agent.answer.delta', data: { text: 'hi' } });
    const seen: AgentEvent[] = [];
    const unsub = bus.subscribe('t1', (e) => seen.push(e), 1);
    bus.emit({ ...base, type: 'agent.completed', data: { rows: [[1]], answer: 'y'.repeat(400) } });
    unsub();
    off();
    expect(seen.map((e) => [e.seq, e.type])).toEqual([[2, 'agent.answer.delta'], [3, 'agent.completed']]);
    expect(live).toEqual(['agent.started', 'agent.completed']);
    expect(bus.history('t1').length).toBe(3);
  });
});
