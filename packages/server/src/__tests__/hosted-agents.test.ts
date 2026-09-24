/**
 * Hosted agents: the marketplace templates (every tool they name is one a hosted agent may use), installing and
 * checking agents, the tool loop over the server's model (a tool per turn, results back, a final answer), read-only
 * runs pinned to the agent's workspace, the step budget, reports delivered to channels, and scheduled runs.
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
import type { ProviderFactory, LlmProvider, LlmRequest, LlmUsage } from '../services/llm.js';
import { hostedToolCatalog, parseToolCall } from '../services/hosted-agents.js';
import { AGENT_TEMPLATES } from '../agent/templates.js';
import type { Principal } from '../services/principal.js';

let dir: string;
let ctx: AppContext;
let wsId: string;
let otherWs: string;
let admin: Principal;
let receiver: http.Server;
let hookUrl: string;
const received: Record<string, unknown>[] = [];
const prompts: LlmRequest[] = [];
/** What the model does on its first turn in the current test; with loop it asks for a tool every turn. */
let script: { first: string; loop?: boolean } = { first: '' };

const tool = (name: string, args: Record<string, unknown>) => `Let me check.\n\`\`\`tool\n${JSON.stringify({ name, arguments: args })}\n\`\`\``;

const stub: ProviderFactory = (id, opts) => {
  const p: LlmProvider = {
    id,
    model: opts.model ?? 'stub',
    async *stream(req: LlmRequest): AsyncGenerator<string, LlmUsage, void> {
      prompts.push(req);
      const last = String(req.messages.at(-1)?.content ?? '');
      if (last.startsWith('You have used all your tool calls')) yield 'Final: I ran out of tool calls.';
      else if (script.loop) yield tool('list_accessible_data', {});
      else if (req.messages.length === 1) yield script.first;
      else if (last.startsWith('Result of execute_query')) yield `Total revenue is ${/\b(\d{2,})\b/.exec(last)?.[1] ?? '?'}.\n\n${last.includes('ERROR') ? 'The statement was refused.' : ''}`;
      else yield `Done. Last result:\n${last.slice(0, 300)}`;
      return { input_tokens: 10, output_tokens: 5 };
    },
    async listModels() {
      return ['stub'];
    },
  };
  return p;
};

beforeAll(async () => {
  initLogger({ level: 'silent', stderr: true, pretty: false });
  receiver = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => {
      received.push(JSON.parse(b || '{}'));
      res.end('ok');
    });
  });
  await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
  hookUrl = `http://127.0.0.1:${(receiver.address() as net.AddressInfo).port}/hook`;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dv-hosted-'));
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  const cfg = loadConfig({ configPath: null, env: { DUCKVIEW_DATA_DIR: path.join(dir, 'data'), DUCKDB_TEMP_DIRECTORY: path.join(dir, 'spill'), DATABASE_URL: ':memory:', DUCKDB_MEMORY_LIMIT: '512MB', DUCKVIEW_ADMIN_EMAIL: 'admin@test.local', DUCKVIEW_ADMIN_PASSWORD: 'super-secret-pw', DUCKVIEW__duckdb__sync_scheduler_enabled: 'false', DUCKVIEW__notifications__scheduler_enabled: 'false', DUCKVIEW__notifications__allow_private_targets: 'true', DUCKVIEW__transform__scheduler_enabled: 'false', DUCKVIEW__apps__enabled: 'false', COPILOT_PROVIDER: 'anthropic', COPILOT_API_KEY: 'k', COPILOT_MODEL: 'stub', LOG_LEVEL: 'silent' } });
  ctx = await createContext(cfg, { providerFactory: stub });
  admin = ctx.auth.principalFromUser((await ctx.auth.findByEmail('admin@test.local'))!, 'jwt', '127.0.0.1');
  wsId = (await ctx.workspaces.create(admin, { name: 'Shop', active_db_path: 'shop.duckdb' })).id;
  otherWs = (await ctx.workspaces.create(admin, { name: 'Other', active_db_path: 'other.duckdb' })).id;
  await ctx.queries.run(admin, wsId, "CREATE TABLE orders AS SELECT * FROM (VALUES (1, 'EU', 100.0), (2, 'US', 50.0), (3, 'EU', 30.0)) t(id, region, amount)", { cache: false });
  await ctx.queries.run(admin, otherWs, 'CREATE TABLE secrets AS SELECT 424242 AS code', { cache: false });
}, 120_000);

afterAll(async () => {
  await ctx?.shutdown();
  receiver?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('the marketplace', () => {
  it('only names tools a hosted agent may use', () => {
    const allowed = new Set(hostedToolCatalog(ctx.cfg).map((t) => t.name));
    for (const t of AGENT_TEMPLATES) expect(t.tools.filter((n) => !allowed.has(n)), t.id).toEqual([]);
    expect(allowed.has('execute_query')).toBe(true);
    expect(allowed.has('create_alert')).toBe(false);
    expect(ctx.hostedAgents.templates().find((t) => t.id === 'data-analyst')!.tool_titles.length).toBeGreaterThan(3);
  });

  it('installs a template and refuses tools that write', async () => {
    const a = await ctx.hostedAgents.install(admin, wsId, 'pipeline-watcher', { schedule: { kind: 'manual' } });
    expect(a).toMatchObject({ name: 'Pipeline watcher', template: 'pipeline-watcher', max_steps: 8, published: false, next_run_at: null });
    await expect(ctx.hostedAgents.create(admin, wsId, { name: 'Writer', instructions: 'x', tools: ['execute_query', 'create_alert'] })).rejects.toThrow(/read-only tools only; not available: create_alert/);
    await expect(ctx.hostedAgents.install(admin, wsId, 'nope')).rejects.toThrow(/No agent template nope/);
    expect(parseToolCall('```tool\n{"name": "x", "arguments": {"a": 1}}\n```')).toEqual({ name: 'x', arguments: { a: 1 } });
    expect(parseToolCall('```tool\n{oops}\n```')).toMatchObject({ error: expect.stringMatching(/not valid JSON/) });
    expect(parseToolCall('Just an answer.')).toBeNull();
  });
});

describe('runs', () => {
  it('uses a tool, reads the result and answers; the report goes to the channels', async () => {
    const { channel } = await ctx.notifications.create(admin, wsId, { name: 'Hook', type: 'webhook', secret: { url: hookUrl } } as never);
    const a = await ctx.hostedAgents.install(admin, wsId, 'data-analyst', { channel_ids: [channel.id] });
    script = { first: tool('execute_query', { sql: 'SELECT sum(amount)::INTEGER AS total FROM orders' }) };
    const run = await ctx.hostedAgents.run(a.id, { p: admin, input: 'What is total revenue?', wait: true });
    expect(run).toMatchObject({ status: 'completed', input: 'What is total revenue?', input_tokens: 20, output_tokens: 10, notified: 1 });
    expect(run.output).toMatch(/^Total revenue is 180\./);
    expect(run.steps).toEqual([expect.objectContaining({ tool: 'execute_query', ok: true, summary: '1 row: total' })]);
    // The prompt carries the instructions and only the agent's tools, with their arguments.
    const system = prompts.at(-1)!.system;
    expect(system).toContain('You are "Data analyst"');
    expect(system).toMatch(/- execute_query\(sql: string/);
    expect(system).not.toContain('- create_alert(');
    expect(JSON.stringify(received.at(-1))).toMatch(/Total revenue is 180/);
    const stored = await ctx.hostedAgents.getRun(admin, run.id);
    expect(stored.output).toBe(run.output);
    expect((await ctx.hostedAgents.get(admin, a.id)).last_run).toMatchObject({ run_id: run.id, status: 'completed' });
  });

  it('is read-only and stays in its workspace', async () => {
    const a = await ctx.hostedAgents.install(admin, wsId, 'data-analyst', { name: 'Analyst 2' });
    script = { first: tool('execute_query', { sql: 'DELETE FROM orders' }) };
    const run = await ctx.hostedAgents.run(a.id, { p: admin, wait: true });
    expect(run.steps[0]).toMatchObject({ tool: 'execute_query', ok: false });
    expect((await ctx.queries.run(admin, wsId, 'SELECT count(*) FROM orders', { cache: false })).rows[0]).toEqual([3]);
    // Another workspace named in the arguments is ignored: the table is not there.
    script = { first: tool('execute_query', { sql: 'SELECT code FROM secrets', workspace_id: otherWs }) };
    const escaped = await ctx.hostedAgents.run(a.id, { p: admin, wait: true });
    expect(escaped.steps[0]).toMatchObject({ ok: false });
    expect(escaped.output).not.toContain('424242');
    // A tool it was not given is refused.
    script = { first: tool('list_alerts', {}) };
    const notMine = await ctx.hostedAgents.run(a.id, { p: admin, wait: true });
    expect(notMine.steps[0]).toMatchObject({ tool: 'list_alerts', ok: false });
    expect(notMine.output).toMatch(/is not one of your tools/);
  });

  it('stops asking for tools at its step budget', async () => {
    const a = await ctx.hostedAgents.create(admin, wsId, { name: 'Looper', instructions: 'Keep looking.', tools: ['list_accessible_data'], max_steps: 2 });
    script = { first: '', loop: true };
    const run = await ctx.hostedAgents.run(a.id, { p: admin, wait: true });
    expect(run.steps).toHaveLength(2);
    expect(run.output).toBe('Final: I ran out of tool calls.');
  });

  it('runs on its schedule', async () => {
    const a = await ctx.hostedAgents.create(admin, wsId, { name: 'Every hour', instructions: 'Say hi.', task: 'Say hi to the team.', tools: ['list_accessible_data'], schedule: { kind: 'interval', minutes: 60 } });
    script = { first: 'Hi team.' };
    const ran = await ctx.hostedAgents.tick(new Date(Date.now() + 2 * 3600_000));
    expect(ran).toContain(a.id);
    let runs = await ctx.hostedAgents.runs(admin, a.id);
    for (let i = 0; i < 50 && runs[0]?.status === 'running'; i++) {
      await new Promise((r) => setTimeout(r, 50));
      runs = await ctx.hostedAgents.runs(admin, a.id);
    }
    expect(runs[0]).toMatchObject({ status: 'completed', triggered_by: 'schedule', input: 'Say hi to the team.', output: 'Hi team.' });
  });
});
