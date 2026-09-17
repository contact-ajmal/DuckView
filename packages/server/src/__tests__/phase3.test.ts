import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadConfig } from '../config/index.js';
import { initLogger } from '../observability/logger.js';
import { createContext, type AppContext } from '../context.js';
import { buildApp } from '../app.js';
import { buildMcpServer } from '../mcp/server.js';
import { defaultProviderFactory, type ProviderFactory, type LlmProvider, type LlmRequest, type LlmUsage } from '../services/llm.js';
import { extractSqlBlocks } from '../services/copilot.js';
import type { Principal } from '../services/principal.js';

let dir: string;
let ctx: AppContext;
let admin: Principal;
let wsId: string;
let app: Awaited<ReturnType<typeof buildApp>>['app'];
let base: string;
let jwt: string;
const seen: LlmRequest[] = [];

/** Stub provider: echoes what it received so tests can assert context hydration. */
const stubFactory: ProviderFactory = (id, opts) => {
  if (id === 'ollama' || (id === 'openai' && opts.baseUrl)) return defaultProviderFactory(id, opts); // real OpenAI-compatible path for the mock-server test
  const provider: LlmProvider = {
    id,
    model: opts.model ?? 'stub-model',
    async *stream(req: LlmRequest): AsyncGenerator<string, LlmUsage, void> {
      seen.push(req);
      if (!opts.apiKey) throw Object.assign(new Error('no key'), { status: 401 });
      const tables = /- table (\S+)\(/g;
      const names: string[] = [];
      let m: RegExpExecArray | null;
      while ((m = tables.exec(req.system))) names.push(m[1]!);
      const chunks = [`Context: tables=${names.join(',')}; files=${(req.system.match(/^- '([^']+)'$/gm) ?? []).length}; buckets=${req.system.includes('### Cloud storage buckets') ? 'yes' : 'no'}; active=${req.system.includes('SQL in the active editor tab') ? 'yes' : 'no'}; history=${req.messages.length}; summaries=${req.system.includes('Selected dataset schemas') ? 'yes' : 'no'}\n`, 'Here is the query:\n```sql\nSELECT count(*) AS n FROM t_copilot;\n```\n', 'Done.'];
      for (const c of chunks) yield c;
      return { input_tokens: 123, output_tokens: 45 };
    },
    async listModels() {
      return ['stub-model', 'stub-large'];
    },
  };
  return provider;
};

/** Minimal OpenAI-compatible mock (chat completions SSE + Ollama /api/tags). */
function startMockLlm(): Promise<{ url: string; close: () => void; requests: unknown[] }> {
  const requests: unknown[] = [];
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      if (req.url === '/api/tags') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ models: [{ name: 'llama3.1:8b' }, { name: 'qwen2.5-coder' }] }));
      }
      if (req.url === '/v1/chat/completions') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          requests.push(JSON.parse(body));
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          const chunk = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}) => `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'llama3.1', choices: [{ index: 0, delta, finish_reason: null }], ...extra })}\n\n`;
          res.write(chunk({ role: 'assistant', content: '' }));
          res.write(chunk({ content: 'Mock ' }));
          res.write(chunk({ content: 'reply ```sql\nSELECT 1;\n```' }));
          res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'llama3.1', choices: [], usage: { prompt_tokens: 50, completion_tokens: 7 } })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    srv.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(srv.address() as { port: number }).port}`, close: () => srv.close(), requests }));
  });
}

async function sse(body: Record<string, unknown>, token = jwt): Promise<{ status: number; events: { event: string; data: Record<string, unknown> }[] }> {
  const res = await fetch(`${base}/api/copilot/chat`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  const text = await res.text();
  const events = text
    .split('\n\n')
    .filter((b) => b.trim())
    .map((b) => {
      const ev = /^event: (.+)$/m.exec(b)?.[1] ?? 'message';
      const data = JSON.parse(/^data: (.+)$/m.exec(b)?.[1] ?? '{}');
      return { event: ev, data };
    });
  return { status: res.status, events };
}

const api = async (method: string, url: string, body?: unknown, token = jwt) => {
  const res = await fetch(base + url, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
};

beforeAll(async () => {
  initLogger({ level: 'silent', stderr: true, pretty: false });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dv-p3-'));
  const cfg = loadConfig({
    configPath: null,
    env: { DUCKVIEW_DATA_DIR: path.join(dir, 'data'), DUCKVIEW_FILESYSTEM_MODE: 'sandboxed', DUCKDB_TEMP_DIRECTORY: path.join(dir, 'spill'), DATABASE_URL: ':memory:', DUCKDB_MEMORY_LIMIT: '512MB', DUCKVIEW_ADMIN_EMAIL: 'admin@test.local', DUCKVIEW_ADMIN_PASSWORD: 'super-secret-pw', COPILOT_PROVIDER: 'anthropic', COPILOT_API_KEY: 'server-key', COPILOT_MODEL: 'claude-opus-5', LOG_LEVEL: 'silent' },
  });
  ctx = await createContext(cfg, { providerFactory: stubFactory });
  const user = await ctx.auth.findByEmail('admin@test.local');
  admin = ctx.auth.principalFromUser(user!, 'jwt', '127.0.0.1');
  wsId = (await ctx.workspaces.ensureDefault(admin)).id;
  await ctx.queries.run(admin, wsId, "COPY (SELECT range AS id, 'r' || range AS name, range * 2.5 AS amount FROM range(200)) TO 'orders.parquet' (FORMAT PARQUET)");
  await ctx.queries.run(admin, wsId, 'CREATE TABLE t_copilot AS SELECT 1 AS a');
  await ctx.cloud.create(admin.userId, { name: 'lake', provider: 'S3', bucket: 'my-lake', credentials: { access_key_id: 'a', secret_access_key: 'b' } });
  ({ app } = await buildApp(ctx));
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  jwt = (await api('POST', '/api/auth/login', { email: 'admin@test.local', password: 'super-secret-pw' }, '')).json.token as string;
});

afterAll(async () => {
  await app.close();
  await ctx.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('DuckCopilot', () => {
  it('adding a cloud connection did not restart the in-memory engine (table created earlier still exists)', async () => {
    const r = await ctx.queries.run(admin, wsId, 'SELECT a FROM t_copilot');
    expect(r.rows).toEqual([[1]]);
  });
  it('reports its configuration', async () => {
    const r = await api('GET', '/api/copilot/config');
    expect(r.json).toMatchObject({ enabled: true, allow_byok: true, server_provider: 'anthropic', server_model: 'claude-opus-5', has_server_key: true, can_use: true });
  });
  it('streams context → deltas → done with hydrated schema, files, buckets and active SQL', async () => {
    const r = await sse({ workspace_id: wsId, message: 'How many orders?', active_sql: 'SELECT 1', targets: ['orders.parquet'] });
    expect(r.status).toBe(200);
    expect(r.events.map((e) => e.event)).toEqual(['context', 'delta', 'delta', 'delta', 'done']);
    const c = r.events[0]!.data;
    expect(c).toMatchObject({ provider: 'anthropic', model: 'claude-opus-5', tables: 1, files: 1, buckets: 1, targets: ['orders.parquet'] });
    const full = r.events.filter((e) => e.event === 'delta').map((e) => e.data.text).join('');
    expect(full).toContain('tables=t_copilot;');
    expect(full).toContain('files=1;');
    expect(full).toContain('buckets=yes;');
    expect(full).toContain('active=yes;');
    expect(full).toContain('summaries=yes');
    expect(full).toContain('history=1');
    const done = r.events.at(-1)!.data;
    expect(done.sql_blocks).toEqual(['SELECT count(*) AS n FROM t_copilot;']);
    expect(done.usage).toEqual({ input_tokens: 123, output_tokens: 45 });
    // context sent to the model includes SUMMARIZE stats for the target and the S3 bucket
    const sys = seen.at(-1)!.system;
    expect(sys).toContain('#### orders.parquet');
    expect(sys).toMatch(/- amount DECIMAL[^\n]*nulls 0\.0%/);
    expect(sys).toContain('s3://my-lake');
    expect(sys).toContain("- 'orders.parquet'");
    // persisted with a context snapshot on the user turn
    const conv = c.conversation_id as string;
    const msgs = await api('GET', `/api/copilot/messages?workspace_id=${wsId}&conversation_id=${conv}`);
    const list = msgs.json.messages as { role: string; content: string; context: { tables: number; targets: string[] } | null }[];
    expect(list.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(list[0]!.context).toMatchObject({ tables: 1, targets: ['orders.parquet'] });
    expect(list[1]!.content).toContain('SELECT count(*)');
    // second turn carries the history
    const r2 = await sse({ workspace_id: wsId, conversation_id: conv, message: 'and by name?' });
    expect(r2.events.filter((e) => e.event === 'delta').map((e) => e.data.text).join('')).toContain('history=3');
    const convs = await api('GET', `/api/copilot/conversations?workspace_id=${wsId}`);
    expect((convs.json.conversations as { id: string; messages: number; title: string }[])[0]).toMatchObject({ id: conv, messages: 4, title: 'How many orders?' });
  });
  it('actions compose the user turn: fix, explain, suggest', async () => {
    await sse({ workspace_id: wsId, message: '', action: 'fix', active_sql: 'SELEC 1', error_message: 'Parser Error: syntax error at or near "1"' });
    expect(seen.at(-1)!.messages.at(-1)!.content).toMatch(/Diagnose the DuckDB error[\s\S]*Parser Error[\s\S]*SELEC 1/);
    await sse({ workspace_id: wsId, message: 'explain', action: 'explain', active_sql: 'SELECT 1 AS x', result_preview: { columns: [{ name: 'x', type: 'INTEGER' }], rows: [[1]], rowCount: 1 } });
    expect(seen.at(-1)!.messages.at(-1)!.content).toMatch(/plain business language[\s\S]*Result preview \(1 rows\):\nx\n1/);
    const s = await sse({ workspace_id: wsId, message: '', action: 'suggest', targets: ['orders.parquet'] });
    expect(s.events.at(-1)!.event).toBe('done');
    expect(seen.at(-1)!.messages.at(-1)!.content).toMatch(/5 most insightful[\s\S]*Datasets: orders\.parquet/);
  });
  it('BYOK overrides the server provider and errors are streamed as events', async () => {
    const r = await sse({ workspace_id: wsId, message: 'hi', provider: 'openai', api_key: 'byok-key', model: 'gpt-4o' });
    expect(r.events[0]!.data).toMatchObject({ provider: 'openai', model: 'gpt-4o' });
    const bad = await sse({ workspace_id: wsId, message: 'hi', provider: 'openai' }); // BYOK provider without key → the stub throws 401-like
    expect(bad.events.at(-1)!.event).toBe('error');
    expect(bad.events.at(-1)!.data.code).toMatch(/COPILOT_/);
    const models = await api('POST', '/api/copilot/models', { provider: 'anthropic' });
    expect(models.json.models).toEqual(['stub-model', 'stub-large']);
    expect((await api('GET', `/api/copilot/config`, undefined, '')).status).toBe(401);
  });
  it('real OpenAI-compatible streaming path (Ollama mock): SSE parsed by the openai SDK, usage captured, models listed', async () => {
    const mock = await startMockLlm();
    try {
      const r = await sse({ workspace_id: wsId, message: 'ping', provider: 'ollama', base_url: mock.url, model: 'llama3.1' });
      expect(r.events[0]!.data).toMatchObject({ provider: 'ollama', model: 'llama3.1' });
      expect(r.events.filter((e) => e.event === 'delta').map((e) => e.data.text).join('')).toBe('Mock reply ```sql\nSELECT 1;\n```');
      expect(r.events.at(-1)!.data).toMatchObject({ usage: { input_tokens: 50, output_tokens: 7 }, sql_blocks: ['SELECT 1;'] });
      const sent = mock.requests[0] as { model: string; stream: boolean; messages: { role: string; content: string }[] };
      expect(sent.model).toBe('llama3.1');
      expect(sent.stream).toBe(true);
      expect(sent.messages[0]!.role).toBe('system');
      expect(sent.messages[0]!.content).toContain('DuckCopilot');
      const models = await api('POST', '/api/copilot/models', { provider: 'ollama', base_url: mock.url });
      expect(models.json.models).toEqual(['llama3.1:8b', 'qwen2.5-coder']);
    } finally {
      mock.close();
    }
  });
  it('maps an unreachable provider to a clean error event', async () => {
    const r = await sse({ workspace_id: wsId, message: 'ping', provider: 'ollama', base_url: 'http://127.0.0.1:1' });
    expect(r.events.at(-1)!.event).toBe('error');
    expect(String(r.events.at(-1)!.data.code)).toMatch(/COPILOT_PROVIDER/);
  });
  it('extractSqlBlocks ignores non-SQL fences', () => {
    expect(extractSqlBlocks('```json\n{"a":1}\n```\n```sql\nSELECT 1;\n```\n```\nSELECT 2\n```')).toEqual(['SELECT 1;', 'SELECT 2']);
  });
});

describe('MCP: browse_storage, inspect_schema, list_dashboards, create_dashboard_widget', () => {
  let client: Client;
  beforeAll(async () => {
    const agent: Principal = { ...admin, via: 'token', actorType: 'AGENT', scopes: ['read', 'write', 'mcp'] };
    const server = buildMcpServer(ctx, agent, { defaultWorkspaceId: wsId });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    client = new Client({ name: 't', version: '0' });
    await client.connect(ct);
  });
  it('exposes ten tools', async () => {
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(['browse_storage', 'create_dashboard_widget', 'execute_query', 'explain_query', 'inspect_schema', 'lakehouse_query', 'list_accessible_data', 'list_dashboards', 'profile_dataset', 'save_dataset']);
  });
  it('browse_storage local + cloud connection listing', async () => {
    const local = await client.callTool({ name: 'browse_storage', arguments: {} });
    const sc = local.structuredContent as { entries: { name: string; kind: string }[] };
    expect(sc.entries.map((e) => e.name)).toContain('orders.parquet');
    const cloud = await client.callTool({ name: 'browse_storage', arguments: { provider: 'cloud' } });
    expect((cloud.structuredContent as { connections: { provider: string; bucket: string }[] }).connections[0]).toMatchObject({ provider: 'S3', bucket: 'my-lake' });
    const esc = await client.callTool({ name: 'browse_storage', arguments: { path: '../..' } });
    expect(esc.isError).toBe(true);
  });
  it('inspect_schema on a file and a table', async () => {
    const f = await client.callTool({ name: 'inspect_schema', arguments: { file_path_or_table: 'orders.parquet' } });
    const sc = f.structuredContent as { columns: { name: string }[]; row_count: number; suggested_sql: string };
    expect(sc.columns.map((c) => c.name)).toEqual(['id', 'name', 'amount']);
    expect(sc.row_count).toBe(200);
    expect((f.content as { text: string }[])[0]!.text).toContain('| amount |');
    const t = await client.callTool({ name: 'inspect_schema', arguments: { file_path_or_table: 't_copilot' } });
    expect((t.structuredContent as { kind: string }).kind).toBe('table');
  });
  it('create_dashboard_widget builds a dashboard an agent can list; bad SQL is rejected', async () => {
    const created = await client.callTool({ name: 'create_dashboard_widget', arguments: { dashboard_name: 'Agent board', title: 'Order count', sql: "SELECT count(*) AS n FROM 'orders.parquet'", widget_type: 'KPI', chart_config: { value: 'n' } } });
    expect(created.isError).toBeFalsy();
    const sc = created.structuredContent as { dashboard_id: string; widget: { id: string; widget_type: string }; layout: unknown[] };
    expect(sc.widget.widget_type).toBe('KPI');
    expect(sc.layout.length).toBe(1);
    const chart = await client.callTool({ name: 'create_dashboard_widget', arguments: { dashboard_id: sc.dashboard_id, title: 'By name', sql: "SELECT name, sum(amount) AS total FROM 'orders.parquet' GROUP BY 1 ORDER BY 2 DESC LIMIT 10", widget_type: 'CHART', chart_config: { chart: 'bar', x: 'name', y: ['total'] }, refresh_interval_sec: 60 } });
    expect(chart.isError).toBeFalsy();
    const bad = await client.callTool({ name: 'create_dashboard_widget', arguments: { dashboard_id: sc.dashboard_id, title: 'nope', sql: 'SELECT * FROM missing_table', widget_type: 'TABLE' } });
    expect(bad.isError).toBe(true);
    const mut = await client.callTool({ name: 'create_dashboard_widget', arguments: { dashboard_id: sc.dashboard_id, title: 'nope', sql: 'DROP TABLE t_copilot', widget_type: 'TABLE' } });
    expect((mut.structuredContent as { status: string }).status).toMatch(/approval_required|error/);
    const list = await client.callTool({ name: 'list_dashboards', arguments: {} });
    const boards = (list.structuredContent as { dashboards: { name: string; widgets: { title: string }[] }[] }).dashboards;
    expect(boards.find((b) => b.name === 'Agent board')?.widgets.map((w) => w.title)).toEqual(['Order count', 'By name']);
    // and the widget really runs through the HTTP data endpoint
    const data = await api('POST', `/api/dashboards/${sc.dashboard_id}/widgets/${sc.widget.id}/data`);
    expect((data.json.rows as number[][])[0]![0]).toBe(200);
  });
});
