import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadConfig } from '../config/index.js';
import { initLogger } from '../observability/logger.js';
import { createContext, type AppContext } from '../context.js';
import { buildApp } from '../app.js';
import { buildMcpServer } from '../mcp/server.js';
import { liveEvents, type LiveEvent } from '../observability/events.js';
import { extractAgentText, type AwsBridge } from '../services/aws.js';
import type { Principal } from '../services/principal.js';

/** Fake AWS: records what it was asked and streams canned replies. */
const calls: { kind: string; args: Record<string, unknown> }[] = [];
const fakeAws: AwsBridge = {
  async *converseStream(req) {
    calls.push({ kind: 'converse', args: { region: req.region, model: req.model, system: req.system, messages: req.messages } });
    yield 'Bedrock says: ';
    yield '```sql\nSELECT 1;\n```';
    return { input_tokens: 11, output_tokens: 7 };
  },
  async *invokeBedrockAgent(opts) {
    calls.push({ kind: 'bedrock_agent', args: { ...opts } });
    yield 'Hello from ';
    yield `agent ${opts.agentId} (session ${opts.sessionId})`;
  },
  async *invokeAgentCore(opts) {
    calls.push({ kind: 'agentcore', args: { ...opts } });
    yield `AgentCore ${opts.runtimeArn.split('/').pop()} got: ${String(opts.payload.prompt)}`;
  },
  async listModels(region) {
    return [`us.anthropic.claude-sonnet-4-5-20250929-v1:0@${region}`];
  },
  async listBedrockAgents() {
    return [{ id: 'AGENT1', name: 'sales-analyst', status: 'PREPARED', aliases: [{ id: 'ALIAS1', name: 'prod' }] }];
  },
  async listAgentRuntimes() {
    return [{ arn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/strands_agent-abc123', id: 'strands_agent-abc123', name: 'strands_agent', status: 'READY' }];
  },
};

let dir: string;
let ctx: AppContext;
let admin: Principal;
let wsId: string;
let app: Awaited<ReturnType<typeof buildApp>>['app'];
let base: string;
let jwt: string;

const api = async (method: string, url: string, body?: unknown, token = jwt) => {
  const res = await fetch(base + url, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
};

async function sse(url: string, body: Record<string, unknown>, token = jwt) {
  const res = await fetch(base + url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  const text = await res.text();
  return {
    status: res.status,
    events: text
      .split('\n\n')
      .filter((b) => b.trim())
      .map((b) => ({ event: /^event: (.+)$/m.exec(b)?.[1] ?? 'message', data: JSON.parse(/^data: (.+)$/m.exec(b)?.[1] ?? '{}') as Record<string, unknown> })),
  };
}

beforeAll(async () => {
  initLogger({ level: 'silent', stderr: true, pretty: false });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dv-agents-'));
  const cfg = loadConfig({
    configPath: null,
    env: { DUCKVIEW_DATA_DIR: path.join(dir, 'data'), DUCKVIEW_FILESYSTEM_MODE: 'sandboxed', DUCKDB_TEMP_DIRECTORY: path.join(dir, 'spill'), DATABASE_URL: ':memory:', DUCKDB_MEMORY_LIMIT: '512MB', DUCKVIEW_ADMIN_EMAIL: 'admin@test.local', DUCKVIEW_ADMIN_PASSWORD: 'super-secret-pw', COPILOT_PROVIDER: 'bedrock', COPILOT_AWS_REGION: 'eu-central-1', LOG_LEVEL: 'silent' },
  });
  ctx = await createContext(cfg, { awsBridge: fakeAws });
  const user = await ctx.auth.findByEmail('admin@test.local');
  admin = ctx.auth.principalFromUser(user!, 'jwt', '127.0.0.1');
  wsId = (await ctx.workspaces.ensureDefault(admin)).id;
  await ctx.queries.run(admin, wsId, "COPY (SELECT range AS id, 'r' || range AS name FROM range(50)) TO 'orders.parquet' (FORMAT PARQUET)");
  await ctx.queries.run(admin, wsId, 'CREATE TABLE t_agents AS SELECT 1 AS a');
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

describe('registered agents', () => {
  let agentId: string;
  let agentToken: string;

  it('lists frameworks with integration metadata', async () => {
    const r = await api('GET', '/api/agents/frameworks');
    const fw = r.json.frameworks as Record<string, { title: string; transport: string }>;
    expect(Object.keys(fw).sort()).toEqual(['agentcore_gateway', 'agentcore_runtime', 'bedrock_agent', 'crewai', 'custom', 'langchain', 'langgraph', 'strands']);
    expect(fw.strands!.transport).toBe('mcp');
    expect(fw.bedrock_agent!.transport).toBe('rest');
  });

  it('registers a Strands agent and mints a workspace-scoped read+mcp token', async () => {
    const r = await api('POST', '/api/agents', { name: 'Sales analyst', framework: 'strands', workspace_id: wsId, description: 'Answers revenue questions' });
    expect(r.status).toBe(200);
    agentToken = r.json.token as string;
    expect(agentToken.startsWith('dv_')).toBe(true);
    const a = r.json.agent as Record<string, unknown>;
    agentId = a.id as string;
    expect(a.token_scopes).toEqual(['read', 'mcp']);
    expect(a.allow_mutations).toBe(false);
    expect(a.workspace_id).toBe(wsId);
    expect(a.framework_title).toBe('Strands Agents');
    expect(a.can_invoke).toBe(false);
    const list = await api('GET', '/api/agents');
    expect((list.json.agents as { id: string; token_prefix: string }[])[0]).toMatchObject({ id: agentId });
    expect((list.json.agents as { token_prefix: string }[])[0]!.token_prefix).toBe(agentToken.slice(0, (list.json.agents as { token_prefix: string }[])[0]!.token_prefix.length));
  });

  it('renders framework snippets with the MCP URL and workspace substituted', async () => {
    const r = await api('GET', `/api/agents/${agentId}/snippets`);
    const sn = r.json.snippets as { id: string; code: string; language: string }[];
    expect(sn[0]!.id).toBe('strands');
    expect(sn[0]!.code).toContain(`streamablehttp_client(\n    "${base}/mcp"`);
    expect(sn[0]!.code).toContain(`Workspace ${wsId}`);
    expect(sn[0]!.code).toContain('Bearer <TOKEN>'); // token is never persisted server-side
    expect(r.json.openapi_url).toBe(`${base}/api/agent/openapi.json`);
  });

  it('serves the REST tool façade to the agent token (attributed, HITL-gated)', async () => {
    const seen: LiveEvent[] = [];
    const unsub = liveEvents.subscribe((e) => seen.push(e));
    const list = await api('GET', '/api/agent/v1/tools', undefined, agentToken);
    expect(list.status).toBe(200);
    const tools = list.json.tools as { name: string; input_schema: { properties: Record<string, unknown>; required?: string[] } }[];
    expect(tools).toHaveLength(90);
    const exec = tools.find((t) => t.name === 'execute_query')!;
    expect(exec.input_schema.required).toEqual(['sql']);
    expect(Object.keys(exec.input_schema.properties)).toContain('dry_run');

    const q = await api('POST', '/api/agent/v1/tools/execute_query', { sql: "SELECT count(*) AS n FROM 'orders.parquet'" }, agentToken);
    expect(q.status).toBe(200);
    expect(q.json.is_error).toBe(false);
    expect((q.json.structured as { rows: unknown[][] }).rows[0]![0]).toBe(50);
    expect(String(q.json.text)).toContain('| n |');

    const noWs = await api('POST', '/api/agent/v1/tools/list_accessible_data', {}, agentToken); // default workspace comes from the agent
    expect((noWs.json.structured as { workspace_id: string }).workspace_id).toBe(wsId);

    const bad = await api('POST', '/api/agent/v1/tools/execute_query', { page_size: 'lots' }, agentToken);
    expect(bad.status).toBe(400);
    expect(String((bad.json.structured as { message: string }).message)).toMatch(/Invalid arguments for execute_query: sql/);

    // A read-only agent cannot mutate at all; with write rights the statement is held for human approval.
    const mut = await api('POST', '/api/agent/v1/tools/execute_query', { sql: 'CREATE TABLE evil AS SELECT 1' }, agentToken);
    expect(mut.status).toBe(200);
    expect(mut.json.is_error).toBe(true);
    expect(String(mut.json.text)).toMatch(/write/i);

    const missing = await api('POST', '/api/agent/v1/tools/nope', {}, agentToken);
    expect(missing.status).toBe(404);
    unsub();
    const toolEvents = seen.filter((e): e is Extract<LiveEvent, { type: 'mcp_tool' }> => e.type === 'mcp_tool');
    expect(toolEvents.length).toBeGreaterThanOrEqual(3);
    expect(toolEvents[0]).toMatchObject({ via: 'rest', agent: { id: agentId, name: 'Sales analyst', framework: 'strands' } });
  });

  it('counts calls per agent and the self-test runs as the agent', async () => {
    const t = await api('POST', `/api/agents/${agentId}/test`);
    expect(t.status).toBe(200);
    expect(t.json.ok).toBe(true);
    expect(String(t.json.text)).toContain('**Workspaces**');
    await ctx.agents.flush();
    const a = (await api('GET', `/api/agents/${agentId}`)).json.agent as { call_count: number; error_count: number; last_seen_at: string | null };
    expect(a.call_count).toBeGreaterThanOrEqual(5);
    expect(a.error_count).toBeGreaterThanOrEqual(1);
    expect(a.last_seen_at).not.toBeNull();
  });

  it('requires the mcp scope on the façade', async () => {
    const user = await ctx.auth.findByEmail('admin@test.local');
    const { token } = await ctx.auth.createToken(user!, { name: 'plain', scopes: ['read'] });
    const r = await api('GET', '/api/agent/v1/tools', undefined, token);
    expect(r.status).toBe(403);
    expect((await api('GET', '/api/agent/v1/tools', undefined, 'dv_nope')).status).toBe(401);
  });

  it('attributes MCP sessions opened with the agent token', async () => {
    const principal = (await ctx.auth.verifyToken(agentToken))!;
    const seen: LiveEvent[] = [];
    const unsub = liveEvents.subscribe((e) => seen.push(e));
    const agent = await ctx.agents.byTokenId(principal.tokenId);
    const server = buildMcpServer(ctx, principal, { agent: { id: agent!.id, name: agent!.name, framework: agent!.framework } });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: 't', version: '1' });
    await client.connect(ct);
    const r = (await client.callTool({ name: 'execute_query', arguments: { sql: 'SELECT a FROM t_agents' } })).structuredContent as { rows: unknown[][] };
    expect(r.rows).toEqual([[1]]);
    await client.close();
    unsub();
    expect(seen.find((e) => e.type === 'mcp_tool')).toMatchObject({ via: 'mcp', agent: { name: 'Sales analyst' } });
  });

  it('publishes an OpenAPI 3.0 document Bedrock action groups can consume', async () => {
    const r = await api('GET', '/api/agent/openapi.json');
    expect(r.status).toBe(200);
    expect(r.json.openapi).toBe('3.0.3');
    const paths = r.json.paths as Record<string, { post?: { operationId: string; description: string; requestBody: { content: { 'application/json': { schema: { properties: Record<string, unknown>; required?: string[] } } } } } }>;
    const names = Object.keys(paths).filter((p) => p !== '/api/agent/v1/tools').map((p) => p.split('/').pop());
    expect(names.sort()).toEqual(['add_comment', 'annotate_table', 'ask_agent', 'backup_workspace', 'browse_connector', 'browse_storage', 'build_dashboard', 'check_watch', 'connector_query', 'create_alert', 'create_app', 'create_dashboard_widget', 'create_data_sync', 'create_dbt_model', 'create_dbt_project', 'create_metric_monitor', 'create_mosaic_dashboard', 'create_notebook', 'create_quality_suite', 'create_reverse_sync', 'create_stream', 'create_watch', 'define_metric', 'detect_anomalies', 'diff_tables', 'execute_query', 'explain_query', 'find_joins', 'get_app_logs', 'get_dashboard', 'get_dbt_project', 'get_dbt_run', 'get_lineage', 'get_notebook', 'get_saved_query', 'get_usage', 'git_commit', 'git_status', 'inspect_schema', 'install_template', 'lakehouse_query', 'list_accessible_data', 'list_agents', 'list_alerts', 'list_apps', 'list_backups', 'list_comments', 'list_dashboards', 'list_data_sources', 'list_dbt_projects', 'list_endpoints', 'list_insights', 'list_metrics', 'list_notebooks', 'list_quality_suites', 'list_reverse_syncs', 'list_saved_queries', 'list_streams', 'list_templates', 'list_watches', 'prepare_data', 'preview_app', 'profile_dataset', 'protect_pii', 'publish_app', 'publish_endpoint', 'query_history', 'query_metrics', 'remove_widget', 'run_alert', 'run_app', 'run_data_sync', 'run_dbt', 'run_notebook', 'run_quality_suite', 'run_reverse_sync', 'save_dataset', 'save_query', 'scan_pii', 'search_catalog', 'search_workspace', 'snapshot_dashboard', 'stop_app', 'suggest_quality_checks', 'tag_pii', 'update_app', 'update_data_sync', 'update_widget', 'workspace_health', 'write_dbt_files']);
    const exec = paths['/api/agent/v1/tools/execute_query']!.post!;
    expect(exec.operationId).toBe('execute_query');
    expect(exec.description.length).toBeGreaterThan(20);
    expect(exec.requestBody.content['application/json'].schema.required).toEqual(['sql']);
    expect(Object.keys(exec.requestBody.content['application/json'].schema.properties)).toEqual(['sql', 'workspace_id', 'page_size', 'page', 'dry_run']);
    expect((r.json.components as { securitySchemes: Record<string, { scheme: string }> }).securitySchemes.bearerAuth!.scheme).toBe('bearer');
    expect((r.json.servers as { url: string }[])[0]!.url).toBe(base);
  });

  it('toggles mutation rights (token scopes follow) and rotates tokens', async () => {
    const u = await api('PATCH', `/api/agents/${agentId}`, { allow_mutations: true });
    expect((u.json.agent as { token_scopes: string[] }).token_scopes.sort()).toEqual(['mcp', 'read', 'write']);
    const rot = await api('POST', `/api/agents/${agentId}/rotate-token`, { expires_in_days: 30 });
    expect(rot.status).toBe(200);
    const newToken = rot.json.token as string;
    expect(newToken).not.toBe(agentToken);
    expect((await api('GET', '/api/agent/v1/tools', undefined, agentToken)).status).toBe(401);
    expect((await api('GET', '/api/agent/v1/tools', undefined, newToken)).status).toBe(200);
    expect((rot.json.agent as { token_scopes: string[] }).token_scopes.sort()).toEqual(['mcp', 'read', 'write']);
    agentToken = newToken;
    const held = await api('POST', '/api/agent/v1/tools/execute_query', { sql: 'CREATE TABLE evil AS SELECT 1' }, agentToken);
    expect(held.status).toBe(200);
    expect((held.json.structured as { status: string }).status).toBe('approval_required');
    expect(held.json.is_error).toBe(false);
  });

  it('cannot invoke agents that run on the caller side', async () => {
    const r = await sse(`/api/agents/${agentId}/invoke`, { prompt: 'hi' });
    expect(r.events.at(-1)!.event).toBe('error');
    expect(String(r.events.at(-1)!.data.message)).toMatch(/cannot invoke/i);
  });

  it('invokes a Bedrock Agent (Classic) and an AgentCore runtime with workspace context', async () => {
    const bedrock = (await api('POST', '/api/agents', { name: 'Classic', framework: 'bedrock_agent', config: { region: 'us-east-1', agent_id: 'AGENT1', agent_alias_id: 'ALIAS1' } })).json.agent as { id: string; can_invoke: boolean };
    expect(bedrock.can_invoke).toBe(true);
    const r1 = await sse(`/api/agents/${bedrock.id}/invoke`, { prompt: 'How many orders?', workspace_id: wsId, include_context: true });
    expect(r1.events.map((e) => e.event)).toEqual(['delta', 'delta', 'done']);
    expect(r1.events.map((e) => e.data.text).join('')).toContain('Hello from agent AGENT1');
    const bcall = calls.find((c) => c.kind === 'bedrock_agent')!;
    expect(String(bcall.args.inputText)).toContain('<duckview_context>');
    expect(String(bcall.args.inputText)).toContain('t_agents');
    expect(String(r1.events.at(-1)!.data.session_id).length).toBeGreaterThan(33);

    const badArn = await api('POST', '/api/agents', { name: 'x', framework: 'agentcore_runtime', config: { runtime_arn: 'nope' } });
    expect(badArn.status).toBe(400);
    const core = (await api('POST', '/api/agents', { name: 'Core', framework: 'agentcore_runtime', workspace_id: wsId, config: { runtime_arn: 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/strands_agent-abc123' } })).json.agent as { id: string; config: { region: string } };
    expect(core.config.region).toBe('us-east-1'); // derived from the ARN
    const r2 = await sse(`/api/agents/${core.id}/invoke`, { prompt: 'Summarise revenue', session_id: 'duckview-session-fixed-0000000000000000000' });
    expect(r2.events[0]!.data.text).toBe('AgentCore strands_agent-abc123 got: Summarise revenue');
    expect(calls.find((c) => c.kind === 'agentcore')!.args.sessionId).toBe('duckview-session-fixed-0000000000000000000');
  });

  it('discovers AWS agents, runtimes and models for the pickers', async () => {
    expect((await api('GET', '/api/agents/discover?kind=bedrock_agents&region=us-east-1')).json.agents).toEqual([{ id: 'AGENT1', name: 'sales-analyst', status: 'PREPARED', aliases: [{ id: 'ALIAS1', name: 'prod' }] }]);
    expect(((await api('GET', '/api/agents/discover?kind=agentcore_runtimes&region=us-east-1')).json.runtimes as unknown[]).length).toBe(1);
    expect((await api('GET', '/api/agents/discover?kind=bedrock_models&region=us-east-1')).json.models).toEqual(['us.anthropic.claude-sonnet-4-5-20250929-v1:0@us-east-1']);
  });

  it('deleting the agent revokes its token', async () => {
    const r = await api('DELETE', `/api/agents/${agentId}`);
    expect(r.status).toBe(200);
    expect((await api('GET', '/api/agent/v1/tools', undefined, agentToken)).status).toBe(401);
  });
});

describe('Copilot on AWS', () => {
  it('uses Bedrock Converse as the server-managed provider', async () => {
    const cfg = await api('GET', '/api/copilot/config');
    expect(cfg.json.server_provider).toBe('bedrock');
    expect(cfg.json.has_server_key).toBe(true);
    expect((cfg.json.server_aws as { region: string }).region).toBe('eu-central-1');
    const r = await sse('/api/copilot/chat', { workspace_id: wsId, message: 'count rows' });
    expect(r.events[0]!.event).toBe('context');
    expect(r.events[0]!.data.provider).toBe('bedrock');
    expect(r.events.at(-1)!.event).toBe('done');
    expect((r.events.at(-1)!.data.usage as { input_tokens: number }).input_tokens).toBe(11);
    expect(r.events.at(-1)!.data.sql_blocks).toEqual(['SELECT 1;']);
    const call = calls.filter((c) => c.kind === 'converse').at(-1)!;
    expect(call.args.region).toBe('eu-central-1');
    expect(call.args.model).toBe('us.anthropic.claude-sonnet-4-5-20250929-v1:0');
    expect(String(call.args.system)).toContain('t_agents');
    const models = await api('POST', '/api/copilot/models', { provider: 'bedrock' });
    expect(models.json.models).toEqual(['us.anthropic.claude-sonnet-4-5-20250929-v1:0@eu-central-1']);
  });

  it('lets users bring their own AgentCore runtime / Bedrock agent as the Copilot backend', async () => {
    const r = await sse('/api/copilot/chat', { workspace_id: wsId, message: 'what sells best?', provider: 'agentcore', runtime_arn: 'arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/my_agent-xyz' });
    expect(r.events[0]!.data.provider).toBe('agentcore');
    expect(r.events[0]!.data.model).toBe('my_agent-xyz');
    expect(r.events.find((e) => e.event === 'delta')!.data.text).toBe('AgentCore my_agent-xyz got: what sells best?');
    const call = calls.filter((c) => c.kind === 'agentcore').at(-1)!;
    expect(call.args.region).toBe('us-west-2');
    expect(String((call.args.payload as { context: string }).context)).toContain('t_agents');
    expect(String(call.args.sessionId)).toContain(String(r.events[0]!.data.conversation_id));

    const r2 = await sse('/api/copilot/chat', { workspace_id: wsId, message: 'hi', provider: 'bedrock_agent', region: 'us-east-1', agent_id: 'AGENT1', agent_alias_id: 'ALIAS1' });
    expect(r2.events.at(-1)!.event).toBe('done');
    const missing = await sse('/api/copilot/chat', { workspace_id: wsId, message: 'hi', provider: 'bedrock_agent', region: 'us-east-1' });
    expect(missing.events.at(-1)!.data.code).toBe('COPILOT_AGENT_REQUIRED');
  });

  it('extracts text from common AgentCore payload shapes', () => {
    expect(extractAgentText('plain')).toBe('plain');
    expect(extractAgentText({ result: { content: [{ text: 'a' }, { text: 'b' }] } })).toBe('ab');
    expect(extractAgentText({ event: { contentBlockDelta: { delta: { text: 'd' } } } })).toBe('d');
    expect(extractAgentText({ output: { message: { content: [{ text: 'x' }] } } })).toBe('x');
    expect(extractAgentText({ unrelated: 1 })).toBe('');
  });
});
