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
import { mapProviderError, scrubSecrets } from '../services/llm.js';
import { eq } from 'drizzle-orm';
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
  if (id === 'ollama' || id === 'custom' || (id === 'openai' && opts.baseUrl)) return defaultProviderFactory(id, opts); // real OpenAI-compatible path for the mock-server tests
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
      const last = req.messages.at(-1)?.content ?? '';
      const chunks = last.includes('Design an interactive Mosaic dashboard')
        ? [`Guide: ${req.system.includes('Writing a DuckView Mosaic dashboard spec') ? 'yes' : 'no'}\n`, last.includes('broken') ? 'Here:\n```yaml\nplot:\n  - mark: nope\n    data: { from: t_copilot }\n```\n' : 'Here:\n```yaml\nmeta: { title: Orders }\ndata:\n  orders: { file: orders.parquet }\nplot:\n  - mark: rectY\n    data: { from: orders }\n    x: { bin: amount }\n    y: { count: null }\n```\n- Brush to filter.\n']
        : [`Context: tables=${names.join(',')}; files=${(req.system.match(/^- '([^']+)'$/gm) ?? []).length}; buckets=${req.system.includes('### Cloud storage buckets') ? 'yes' : 'no'}; active=${req.system.includes('SQL in the active editor tab') ? 'yes' : 'no'}; history=${req.messages.length}; summaries=${req.system.includes('Selected dataset schemas') ? 'yes' : 'no'}\n`, 'Here is the query:\n```sql\nSELECT count(*) AS n FROM t_copilot;\n```\n', 'Done.'];
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
      if (req.url === '/strict/models' || req.url === '/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ object: 'list', data: [{ id: 'vendor-large' }, { id: 'vendor-small' }] }));
      }
      if (req.url === '/v1/chat/completions' || req.url === '/chat/completions' || req.url === '/strict/chat/completions') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          const parsed = JSON.parse(body);
          requests.push(parsed);
          // A vendor that rejects OpenAI-only parameters: the bridge must retry without them.
          if (req.url?.startsWith('/strict') && (parsed.stream_options || parsed.max_completion_tokens)) {
            res.writeHead(400, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ error: { message: `Unrecognized request argument supplied: ${parsed.stream_options ? 'stream_options' : 'max_completion_tokens'}`, type: 'invalid_request_error' } }));
          }
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
  it('dashboard action: the spec guide reaches the model, and every spec in the reply is validated against the workspace', async () => {
    const r = await sse({ workspace_id: wsId, message: 'orders by amount', action: 'dashboard', targets: ['orders.parquet'] });
    expect(r.status).toBe(200);
    const full = r.events.filter((e) => e.event === 'delta').map((e) => e.data.text).join('');
    expect(full).toContain('Guide: yes');
    const done = r.events.at(-1)!.data as { spec_blocks: { ok: boolean | null; title: string | null; errors: string[] }[] };
    expect(done.spec_blocks).toHaveLength(1);
    expect(done.spec_blocks[0]).toMatchObject({ ok: true, title: 'Orders', errors: [] });
    expect(seen.at(-1)!.messages.at(-1)!.content).toContain('Datasets: orders.parquet');
    const broken = await sse({ workspace_id: wsId, message: 'broken please', action: 'dashboard' });
    const d2 = broken.events.at(-1)!.data as { spec_blocks: { ok: boolean | null; errors: string[] }[] };
    expect(d2.spec_blocks[0]!.ok).toBe(false);
    expect(d2.spec_blocks[0]!.errors[0]).toMatch(/unrecognized mark type "nope"/);
    // Plain chat that mentions a chart also gets the guide; unrelated chat does not.
    await sse({ workspace_id: wsId, message: 'chart the orders by name' });
    expect(seen.at(-1)!.system).toContain('Writing a DuckView Mosaic dashboard spec');
    await sse({ workspace_id: wsId, message: 'How many orders?' });
    expect(seen.at(-1)!.system).not.toContain('Writing a DuckView Mosaic dashboard spec');
  });
  it('any OpenAI-compatible vendor works through a preset (custom base URL), and unsupported parameters are retried without', async () => {
    const mock = await startMockLlm();
    try {
      const r = await sse({ workspace_id: wsId, message: 'ping', provider: 'custom', base_url: `${mock.url}/strict`, api_key: 'vendor-key', model: 'vendor-large' });
      expect(r.events[0]!.data).toMatchObject({ provider: 'custom', model: 'vendor-large' });
      expect(r.events.filter((e) => e.event === 'delta').map((e) => e.data.text).join('')).toContain('Mock reply');
      // First attempt carried stream_options (rejected), the retry did not and used max_tokens.
      const attempts = mock.requests as { stream_options?: unknown; max_tokens?: number; max_completion_tokens?: number }[];
      expect(attempts.length).toBeGreaterThanOrEqual(2);
      expect(attempts[0]!.stream_options).toBeTruthy();
      expect(attempts.at(-1)!.stream_options).toBeUndefined();
      expect(attempts.at(-1)!.max_tokens).toBeGreaterThan(0);
      // Presets with a fixed endpoint need no base URL; a key that does not match the vendor's format is refused early.
      const models = await api('POST', '/api/copilot/models', { provider: 'custom', base_url: mock.url, api_key: 'k' });
      expect(models.json).toMatchObject({ models: ['vendor-large', 'vendor-small'] });
      const cat = await api('GET', '/api/copilot/providers');
      const ids = (cat.json.providers as { id: string; keyUrl: string | null; baseUrl: string | null }[]).map((p) => p.id);
      expect(ids).toEqual(expect.arrayContaining(['anthropic', 'openai', 'gemini', 'deepseek', 'openrouter', 'kimi', 'groq', 'mistral', 'xai', 'ollama', 'custom', 'bedrock']));
      expect((cat.json.providers as { id: string; baseUrl: string | null }[]).find((p) => p.id === 'openrouter')!.baseUrl).toBe('https://openrouter.ai/api/v1');
    } finally {
      mock.close();
    }
  });
  it('administrators set the server-managed provider from Settings; it overrides the config file and is stored encrypted', async () => {
    const before = await api('GET', '/api/copilot/config');
    expect(before.json).toMatchObject({ server_provider: 'anthropic', server_source: 'config', can_manage: true });
    // Validation: wrong key format, missing base URL for a custom endpoint, missing region for Bedrock.
    expect((await api('PUT', '/api/copilot/settings', { provider: 'anthropic', api_key: 'sk-or-wrong' })).status).toBe(400);
    expect((await api('PUT', '/api/copilot/settings', { provider: 'custom', api_key: 'k', model: 'm' })).status).toBe(400);
    expect((await api('PUT', '/api/copilot/settings', { provider: 'bedrock' })).status).toBe(400);
    const set = await api('PUT', '/api/copilot/settings', { provider: 'openrouter', api_key: 'sk-or-v1-abcdef1234', model: 'openai/gpt-4.1' });
    expect(set.status).toBe(200);
    expect(set.json.settings).toMatchObject({ provider: 'openrouter', model: 'openai/gpt-4.1', has_key: true, key_hint: '1234', updated_by_email: 'admin@test.local' });
    expect(JSON.stringify(set.json)).not.toContain('abcdef');
    const after = await api('GET', '/api/copilot/config');
    expect(after.json).toMatchObject({ server_provider: 'openrouter', server_model: 'openai/gpt-4.1', server_source: 'settings', has_server_key: true, server_key_hint: '1234' });
    // Chat now runs on the stored provider and key (the stub echoes the provider id; the key reached the factory).
    const r = await sse({ workspace_id: wsId, message: 'hi' });
    expect(r.events[0]!.data).toMatchObject({ provider: 'openrouter', model: 'openai/gpt-4.1' });
    expect(r.events.at(-1)!.event).toBe('done');
    // Stored in the metadata database, ciphertext only.
    const row = (await ctx.copilotAdmin['db'].select().from(ctx.copilotAdmin['s'].copilotSettings))[0]!;
    expect(row.encrypted_api_key).toBeTruthy();
    expect(row.encrypted_api_key).not.toContain('abcdef');
    // Re-saving without a key keeps the key on file; changing the model only.
    const keep = await api('PUT', '/api/copilot/settings', { provider: 'openrouter', model: 'anthropic/claude-sonnet-4.5' });
    expect(keep.json.settings).toMatchObject({ has_key: true, key_hint: '1234', model: 'anthropic/claude-sonnet-4.5' });
    // Test endpoint uses the key on file through the provider (stub lists models).
    const test = await api('POST', '/api/copilot/settings/test', { provider: 'openrouter' });
    expect(test.json).toMatchObject({ ok: true, models: ['stub-model', 'stub-large'] });
    // Non-admins cannot read, change or test the server provider — but see it in config.
    const u = await ctx.auth.createLocalUser({ email: 'analyst@test.local', password: 'analyst-password', role: 'USER' });
    const ujwt = (await api('POST', '/api/auth/login', { email: 'analyst@test.local', password: 'analyst-password' }, '')).json.token as string;
    expect((await api('GET', '/api/copilot/settings', undefined, ujwt)).status).toBe(403);
    expect((await api('PUT', '/api/copilot/settings', { provider: 'openai', api_key: 'sk-x' }, ujwt)).status).toBe(403);
    expect((await api('POST', '/api/copilot/settings/test', { provider: 'openrouter' }, ujwt)).status).toBe(403);
    expect((await api('GET', '/api/copilot/config', undefined, ujwt)).json).toMatchObject({ server_provider: 'openrouter', can_manage: false });
    void u;
    // Clearing returns to the config file.
    expect((await api('DELETE', '/api/copilot/settings')).json).toMatchObject({ ok: true, source: 'config' });
    expect((await api('GET', '/api/copilot/config')).json).toMatchObject({ server_provider: 'anthropic', server_source: 'config' });
  });
  it('tracks usage per turn and reports totals, per-model/user breakdowns and streams in flight', async () => {
    const conv = (await sse({ workspace_id: wsId, message: 'count things' })).events[0]!.data.conversation_id as string;
    await sse({ workspace_id: wsId, conversation_id: conv, message: 'and more' });
    const c = await api('GET', `/api/copilot/usage?conversation_id=${conv}`);
    expect(c.json.conversation).toMatchObject({ requests: 2, input_tokens: 246, output_tokens: 90, errors: 0 });
    const report = await api('GET', '/api/copilot/usage?days=7');
    const j = report.json as { scope: string; today: { requests: number; input_tokens: number }; window: { requests: number }; by_model: { provider: string; model: string; requests: number }[]; by_user: { email: string; requests: number }[]; by_day: { day: string }[]; active: unknown[]; recent: { status: string }[] };
    expect(j.scope).toBe('all');
    expect(j.today.requests).toBeGreaterThanOrEqual(2);
    expect(j.today.input_tokens).toBeGreaterThanOrEqual(246);
    expect(j.by_model.some((m) => m.provider === 'anthropic' && m.model === 'claude-opus-5')).toBe(true);
    expect(j.by_user[0]).toMatchObject({ email: 'admin@test.local' });
    expect(j.by_day.length).toBeGreaterThanOrEqual(1);
    expect(j.active).toEqual([]);
    expect(j.recent.some((r) => r.status === 'error')).toBe(true); // the earlier BYOK-without-key turn was recorded as an error
    // A non-admin only sees their own rows.
    const ujwt = (await api('POST', '/api/auth/login', { email: 'analyst@test.local', password: 'analyst-password' }, '')).json.token as string;
    const mine = (await api('GET', '/api/copilot/usage', undefined, ujwt)).json as { scope: string; window: { requests: number }; by_user: unknown[] };
    expect(mine).toMatchObject({ scope: 'self', window: { requests: 0 }, by_user: [] });
    // Streams in flight are visible while a turn runs (the stub streams three chunks; peek between them).
    const streamer = ctx.copilot.stream(admin, { workspaceId: wsId, message: 'slow' });
    await streamer.next(); // context event: the stream is registered
    await streamer.next(); // first delta
    expect(ctx.copilotAdmin.activeStreams(admin)).toHaveLength(1);
    expect(ctx.copilotAdmin.activeStreams(admin)[0]).toMatchObject({ user_email: 'admin@test.local', provider: 'anthropic', action: 'chat' });
    for await (const _ of streamer) void _;
    expect(ctx.copilotAdmin.activeStreams(admin)).toHaveLength(0);
  });
  it('keys never leave the server: not in any response, scrubbed from provider errors, admin-only hint, undecryptable after key rotation, personal keys switchable off', async () => {
    const KEY = 'sk-or-v1-supersecret-key-value-42';
    await api('PUT', '/api/copilot/settings', { provider: 'openrouter', api_key: KEY, model: 'openrouter/free' });
    // Every endpoint that talks about the provider: no key material anywhere.
    for (const url of ['/api/copilot/config', '/api/copilot/settings', '/api/copilot/providers', '/api/copilot/usage']) expect(JSON.stringify((await api('GET', url)).json)).not.toContain('supersecret');
    const cfgAdmin = (await api('GET', '/api/copilot/config')).json as { server_key_hint: string | null; server_key_status: string; ephemeral_encryption_key: boolean };
    expect(cfgAdmin.server_key_hint).toBe('e-42');
    expect(cfgAdmin.server_key_status).toBe('ok');
    const ujwt = (await api('POST', '/api/auth/login', { email: 'analyst@test.local', password: 'analyst-password' }, '')).json.token as string;
    const cfgUser = (await api('GET', '/api/copilot/config', undefined, ujwt)).json as { server_key_hint: string | null; ephemeral_encryption_key: boolean };
    expect(cfgUser.server_key_hint).toBeNull(); // not even the last four characters for non-admins
    expect(cfgUser.ephemeral_encryption_key).toBe(false);
    // The audit trail records the change, not the key.
    const audit = await api('GET', '/api/audit?limit=20');
    expect(JSON.stringify(audit.json)).toContain('copilot.settings.update');
    expect(JSON.stringify(audit.json)).not.toContain('supersecret');
    // Provider error messages that echo a credential are scrubbed before they reach a client or the audit log.
    expect(scrubSecrets(`Incorrect API key provided: ${KEY}. Also sk-proj-abcdefghijklmnop and Bearer abc.def.ghi-12345 and AIzaSyD-1234567890abcdefghijklmn`, [KEY])).toBe('Incorrect API key provided: [redacted]. Also sk-proj-[redacted] and Bearer [redacted] and AIza[redacted]');
    expect(mapProviderError(new Error(`boom ${KEY}`), [KEY]).message).not.toContain('supersecret');
    // A rotated platform encryption key leaves the stored key unreadable — reported as such, never as a stale value.
    const row = (await ctx.copilotAdmin['db'].select().from(ctx.copilotAdmin['s'].copilotSettings))[0]!;
    await ctx.copilotAdmin['db'].update(ctx.copilotAdmin['s'].copilotSettings).set({ tag: Buffer.from('0'.repeat(16)).toString('base64') }).where(eq(ctx.copilotAdmin['s'].copilotSettings.id, row.id));
    ctx.copilotAdmin['cached'] = undefined;
    const rotated = (await api('GET', '/api/copilot/settings')).json as { settings: { has_key: boolean; key_status: string } };
    expect(rotated.settings).toMatchObject({ has_key: false, key_status: 'undecryptable' });
    expect((await api('GET', '/api/copilot/config')).json).toMatchObject({ server_key_status: 'undecryptable', has_server_key: false });
    // Pasting the key again repairs it.
    await api('PUT', '/api/copilot/settings', { provider: 'openrouter', api_key: KEY, model: 'openrouter/free' });
    expect((await api('GET', '/api/copilot/settings')).json).toMatchObject({ settings: { has_key: true, key_status: 'ok' } });
    // Personal keys can be switched off for the deployment: BYOK requests then run on the server provider.
    expect((await api('PUT', '/api/copilot/settings/byok', { allow: false })).json).toEqual({ allow_byok: false });
    expect((await api('GET', '/api/copilot/config', undefined, ujwt)).json).toMatchObject({ allow_byok: false, allow_byok_config: true });
    const forced = await sse({ workspace_id: wsId, message: 'hi', provider: 'openai', api_key: 'sk-mine', model: 'gpt-4o' });
    expect(forced.events[0]!.data).toMatchObject({ provider: 'openrouter', model: 'openrouter/free' });
    expect((await api('PUT', '/api/copilot/settings/byok', { allow: null })).json).toEqual({ allow_byok: true });
    expect((await api('PUT', '/api/copilot/settings/byok', { allow: false }, ujwt)).status).toBe(403);
    await api('DELETE', '/api/copilot/settings');
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
  it('serves the Mosaic spec guide as a resource and a guided dashboard prompt', async () => {
    const res = await client.readResource({ uri: 'duckdb://guides/mosaic-spec' });
    expect((res.contents[0] as { text: string }).text).toContain('create_mosaic_dashboard');
    const prompts = (await client.listPrompts()).prompts.map((p) => p.name).sort();
    expect(prompts).toEqual(['build_data_app', 'build_data_pipeline', 'build_dbt_models', 'build_mosaic_dashboard', 'data_quality_audit', 'sql_optimization']);
    const prompt = await client.getPrompt({ name: 'build_mosaic_dashboard', arguments: { table_or_path: 'orders.parquet', goal: 'revenue by customer' } });
    expect((prompt.messages[0]!.content as { text: string }).text).toContain('validate_only');
  });
  it('exposes thirty-eight tools', async () => {
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(['add_comment', 'annotate_table', 'ask_agent', 'backup_workspace', 'browse_connector', 'browse_storage', 'build_dashboard', 'connector_query', 'create_alert', 'create_app', 'create_dashboard_widget', 'create_data_sync', 'create_dbt_model', 'create_dbt_project', 'create_metric_monitor', 'create_mosaic_dashboard', 'create_notebook', 'create_quality_suite', 'create_reverse_sync', 'create_stream', 'define_metric', 'detect_anomalies', 'execute_query', 'explain_query', 'get_app_logs', 'get_dashboard', 'get_dbt_project', 'get_dbt_run', 'get_lineage', 'get_notebook', 'get_saved_query', 'get_usage', 'git_commit', 'git_status', 'inspect_schema', 'install_template', 'lakehouse_query', 'list_accessible_data', 'list_agents', 'list_alerts', 'list_apps', 'list_backups', 'list_comments', 'list_dashboards', 'list_data_sources', 'list_dbt_projects', 'list_insights', 'list_metrics', 'list_notebooks', 'list_quality_suites', 'list_reverse_syncs', 'list_saved_queries', 'list_streams', 'list_templates', 'preview_app', 'profile_dataset', 'publish_app', 'query_history', 'query_metrics', 'remove_widget', 'run_alert', 'run_app', 'run_data_sync', 'run_dbt', 'run_notebook', 'run_quality_suite', 'run_reverse_sync', 'save_dataset', 'save_query', 'search_catalog', 'search_workspace', 'snapshot_dashboard', 'stop_app', 'suggest_quality_checks', 'update_app', 'update_data_sync', 'update_widget', 'workspace_health', 'write_dbt_files']);
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
