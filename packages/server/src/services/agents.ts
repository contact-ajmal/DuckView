/**
 * Registered agents: named integrations (Strands, LangGraph, LangChain, CrewAI, AgentCore Runtime/Gateway,
 * Bedrock Agents Classic, custom) that call DuckView over MCP or the REST tool façade.
 *
 *  - Registering an agent mints a dedicated API token (read + mcp [+ write]) scoped to a workspace; revoking the
 *    token disables the agent. Tool calls are attributed to the agent (call/error counters, live inspector).
 *  - Agents hosted on AWS (Bedrock Agents, AgentCore Runtime) can be invoked back from DuckView — the Copilot
 *    drawer can chat with them, and the hub has a "test invoke" button.
 */
import { eq, and, desc, sql } from 'drizzle-orm';
import type { DuckViewConfig } from '../config/index.js';
import type { MetadataStore } from '../db/index.js';
import type { Agent, AgentFramework, AgentConfig, TokenScope } from '../db/schema/sqlite.js';
import { AGENT_FRAMEWORKS } from '../db/schema/sqlite.js';
import { newId } from '../security/crypto.js';
import type { AuthService } from './auth.js';
import type { WorkspaceService } from './workspaces.js';
import type { AuditService } from './audit.js';
import type { Principal } from './principal.js';
import { requireScope } from './principal.js';
import { badRequest, notFound, forbidden, HttpError } from './errors.js';
import { defaultAwsBridge, newSessionId, type AwsBridge } from './aws.js';
import { FRAMEWORK_META, snippetsFor, renderSnippet, type Snippet } from '../agent/snippets.js';
import { buildTools, runTool, type ToolEnv } from '../agent/tools.js';
import type { AppContext } from '../context.js';

export type PublicAgent = Agent & { token_prefix: string | null; token_scopes: TokenScope[]; token_revoked: boolean; framework_title: string; can_invoke: boolean };

export class AgentService {
  private ctx!: AppContext;
  private byToken = new Map<string, { agent: Agent | null; at: number }>();
  private pendingTouch = new Map<string, { calls: number; errors: number }>();
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(private readonly cfg: DuckViewConfig, private readonly store: MetadataStore, private readonly auth: AuthService, private readonly workspaces: WorkspaceService, private readonly audit: AuditService, private readonly aws: AwsBridge = defaultAwsBridge) {}

  bind(ctx: AppContext) {
    this.ctx = ctx;
  }

  private get db() {
    return this.store.db;
  }
  private get s() {
    return this.store.schema;
  }

  frameworks() {
    return FRAMEWORK_META;
  }

  private async toPublic(a: Agent): Promise<PublicAgent> {
    const tok = a.token_id ? await this.auth.getTokenRecord(a.token_id) : null;
    const canInvoke = (a.framework === 'bedrock_agent' && !!a.config.agent_id && !!a.config.agent_alias_id) || (a.framework === 'agentcore_runtime' && !!a.config.runtime_arn);
    return { ...a, token_prefix: tok?.token_prefix ?? null, token_scopes: tok?.scopes ?? [], token_revoked: !tok, framework_title: FRAMEWORK_META[a.framework].title, can_invoke: canInvoke };
  }

  async list(userId: string): Promise<PublicAgent[]> {
    const rows = await this.db.select().from(this.s.agents).where(eq(this.s.agents.user_id, userId)).orderBy(desc(this.s.agents.created_at));
    return Promise.all(rows.map((r) => this.toPublic(r)));
  }

  async getOwned(userId: string, id: string): Promise<Agent> {
    const rows = await this.db
      .select()
      .from(this.s.agents)
      .where(and(eq(this.s.agents.id, id), eq(this.s.agents.user_id, userId)))
      .limit(1);
    if (!rows[0]) throw notFound('Agent');
    return rows[0];
  }

  async get(userId: string, id: string): Promise<PublicAgent> {
    return this.toPublic(await this.getOwned(userId, id));
  }

  private scopesFor(allowMutations: boolean): TokenScope[] {
    return allowMutations ? ['read', 'write', 'mcp'] : ['read', 'mcp'];
  }

  private validateConfig(framework: AgentFramework, c: AgentConfig): AgentConfig {
    const str = (k: keyof AgentConfig) => (typeof c[k] === 'string' ? (c[k] as string).trim() : '');
    const out: AgentConfig = { region: str('region'), notes: str('notes').slice(0, 2000) };
    if (framework === 'bedrock_agent') {
      out.agent_id = str('agent_id');
      out.agent_alias_id = str('agent_alias_id');
      if ((out.agent_id || out.agent_alias_id) && !out.region) throw badRequest('AWS region is required to invoke a Bedrock agent');
    }
    if (framework === 'agentcore_runtime') {
      out.runtime_arn = str('runtime_arn');
      out.qualifier = str('qualifier');
      if (out.runtime_arn && !/^arn:aws[a-z-]*:bedrock-agentcore:[a-z0-9-]+:\d{12}:runtime\/[A-Za-z0-9_-]+$/.test(out.runtime_arn)) throw badRequest('runtime_arn must look like arn:aws:bedrock-agentcore:<region>:<account>:runtime/<name-id>');
      if (out.runtime_arn && !out.region) out.region = out.runtime_arn.split(':')[3];
    }
    if (framework === 'agentcore_gateway') out.gateway_url = str('gateway_url');
    return out;
  }

  async create(p: Principal, input: { name: string; framework: AgentFramework; description?: string | null; workspace_id?: string | null; allow_mutations?: boolean; config?: AgentConfig; expires_in_days?: number | null }): Promise<{ agent: PublicAgent; token: string }> {
    if (p.via === 'token' && !p.scopes.includes('admin')) throw forbidden('API tokens cannot register agents');
    if (!(AGENT_FRAMEWORKS as readonly string[]).includes(input.framework)) throw badRequest(`Unknown framework: ${input.framework}`);
    const user = await this.auth.findById(p.userId);
    if (!user) throw forbidden('User not found');
    const name = input.name.trim();
    if (!name) throw badRequest('name is required');
    if (input.workspace_id) await this.workspaces.get(p, input.workspace_id);
    const allow = !!input.allow_mutations && user.role !== 'READ_ONLY';
    const expiresAt = input.expires_in_days ? new Date(Date.now() + input.expires_in_days * 86_400_000) : null;
    const { token, record } = await this.auth.createToken(user, { name: `agent:${name}`, scopes: this.scopesFor(allow), workspaceId: input.workspace_id ?? null, expiresAt });
    const now = new Date();
    const agent: Agent = { id: newId(), user_id: p.userId, name, framework: input.framework, description: input.description?.trim() || null, workspace_id: input.workspace_id ?? null, token_id: record.id, allow_mutations: allow, config: this.validateConfig(input.framework, input.config ?? {}), call_count: 0, error_count: 0, last_seen_at: null, created_at: now, updated_at: now };
    await this.db.insert(this.s.agents).values(agent);
    this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'agent.create', resource: `agent:${agent.id}`, ip: p.ip });
    return { agent: await this.toPublic(agent), token };
  }

  async update(p: Principal, id: string, patch: { name?: string; description?: string | null; workspace_id?: string | null; allow_mutations?: boolean; config?: AgentConfig }): Promise<PublicAgent> {
    const existing = await this.getOwned(p.userId, id);
    const set: Partial<Agent> = { updated_at: new Date() };
    if (patch.name !== undefined) set.name = patch.name.trim() || existing.name;
    if (patch.description !== undefined) set.description = patch.description?.trim() || null;
    if (patch.workspace_id !== undefined) {
      if (patch.workspace_id) await this.workspaces.get(p, patch.workspace_id);
      set.workspace_id = patch.workspace_id || null;
    }
    if (patch.config !== undefined) set.config = this.validateConfig(existing.framework, { ...existing.config, ...patch.config });
    if (patch.allow_mutations !== undefined) {
      const user = await this.auth.findById(p.userId);
      set.allow_mutations = !!patch.allow_mutations && user?.role !== 'READ_ONLY';
      if (existing.token_id) await this.auth.setTokenScopes(existing.token_id, this.scopesFor(set.allow_mutations));
    }
    if (set.workspace_id !== undefined && existing.token_id) {
      await this.db.update(this.s.apiTokens).set({ workspace_id: set.workspace_id }).where(eq(this.s.apiTokens.id, existing.token_id));
    }
    await this.db.update(this.s.agents).set(set).where(eq(this.s.agents.id, id));
    this.byToken.clear();
    return this.toPublic({ ...existing, ...set });
  }

  async rotateToken(p: Principal, id: string, expiresInDays?: number | null): Promise<{ agent: PublicAgent; token: string }> {
    if (p.via === 'token' && !p.scopes.includes('admin')) throw forbidden('API tokens cannot rotate agent tokens');
    const existing = await this.getOwned(p.userId, id);
    const user = await this.auth.findById(p.userId);
    if (!user) throw forbidden('User not found');
    if (existing.token_id) await this.auth.revokeToken(p.userId, existing.token_id).catch(() => undefined);
    const expiresAt = expiresInDays ? new Date(Date.now() + expiresInDays * 86_400_000) : null;
    const { token, record } = await this.auth.createToken(user, { name: `agent:${existing.name}`, scopes: this.scopesFor(existing.allow_mutations), workspaceId: existing.workspace_id, expiresAt });
    await this.db.update(this.s.agents).set({ token_id: record.id, updated_at: new Date() }).where(eq(this.s.agents.id, id));
    this.byToken.clear();
    this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'agent.rotate_token', resource: `agent:${id}`, ip: p.ip });
    return { agent: await this.toPublic({ ...existing, token_id: record.id }), token };
  }

  async remove(p: Principal, id: string): Promise<void> {
    const existing = await this.getOwned(p.userId, id);
    if (existing.token_id) await this.auth.revokeToken(p.userId, existing.token_id).catch(() => undefined);
    await this.db.delete(this.s.agents).where(eq(this.s.agents.id, id));
    this.byToken.clear();
    this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'agent.delete', resource: `agent:${id}`, ip: p.ip });
  }

  /** Agent bound to an API token (30 s cache) — used to attribute tool calls. */
  async byTokenId(tokenId: string | undefined): Promise<Agent | null> {
    if (!tokenId) return null;
    const hit = this.byToken.get(tokenId);
    if (hit && Date.now() - hit.at < 30_000) return hit.agent;
    const rows = await this.db.select().from(this.s.agents).where(eq(this.s.agents.token_id, tokenId)).limit(1);
    const agent = rows[0] ?? null;
    this.byToken.set(tokenId, { agent, at: Date.now() });
    return agent;
  }

  async envFor(principal: Principal, via: ToolEnv['via'], defaultWorkspaceId?: string | null): Promise<ToolEnv> {
    const agent = await this.byTokenId(principal.tokenId);
    return { ctx: this.ctx, principal, via, defaultWorkspaceId: defaultWorkspaceId ?? agent?.workspace_id ?? null, agent: agent ? { id: agent.id, name: agent.name, framework: agent.framework } : null };
  }

  /** Counter bump, batched to one UPDATE per agent per second. */
  touch(agentId: string, status: 'ok' | 'error' | 'approval_required') {
    const cur = this.pendingTouch.get(agentId) ?? { calls: 0, errors: 0 };
    cur.calls += 1;
    if (status === 'error') cur.errors += 1;
    this.pendingTouch.set(agentId, cur);
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => void this.flush(), 1000);
      this.flushTimer.unref();
    }
  }

  async flush(): Promise<void> {
    this.flushTimer = null;
    const batch = [...this.pendingTouch.entries()];
    this.pendingTouch.clear();
    for (const [id, c] of batch) {
      await this.db
        .update(this.s.agents)
        .set({ call_count: sql`${this.s.agents.call_count} + ${c.calls}`, error_count: sql`${this.s.agents.error_count} + ${c.errors}`, last_seen_at: new Date() })
        .where(eq(this.s.agents.id, id))
        .catch(() => undefined);
    }
  }

  snippets(a: Agent, vars: { baseUrl: string; token?: string | null }): Snippet[] {
    const mcpUrl = `${vars.baseUrl}/mcp`;
    const subs = { TOKEN: vars.token ?? null, MCP_URL: mcpUrl, BASE_URL: vars.baseUrl, WORKSPACE_ID: a.workspace_id, REGION: a.config.region, AGENT_ID: a.config.agent_id, AGENT_ALIAS_ID: a.config.agent_alias_id, RUNTIME_ARN: a.config.runtime_arn };
    return snippetsFor(a.framework).map((sn) => ({ ...sn, code: renderSnippet(sn.code, subs), notes: sn.notes ? renderSnippet(sn.notes, subs) : undefined }));
  }

  /** Runs list_accessible_data as the agent (its token's principal) to prove the token, scope and workspace work. */
  async selfTest(p: Principal, id: string): Promise<{ ok: boolean; text: string; structured?: Record<string, unknown> }> {
    const agent = await this.getOwned(p.userId, id);
    if (!agent.token_id) throw new HttpError(409, 'The agent token was revoked — rotate it first', 'AGENT_TOKEN_REVOKED');
    const rec = await this.auth.getTokenRecord(agent.token_id);
    if (!rec) throw new HttpError(409, 'The agent token was revoked — rotate it first', 'AGENT_TOKEN_REVOKED');
    const principal = await this.auth.principalFromTokenRecord(rec, p.ip);
    if (!principal) throw forbidden('Token owner not found');
    const tool = buildTools(this.cfg).find((t) => t.name === 'list_accessible_data')!;
    const env: ToolEnv = { ctx: this.ctx, principal, via: 'rest', defaultWorkspaceId: agent.workspace_id, agent: { id: agent.id, name: agent.name, framework: agent.framework } };
    const r = await runTool(env, tool, agent.workspace_id ? { workspace_id: agent.workspace_id } : {});
    return { ok: !r.isError, text: r.content.map((c) => (c.type === 'text' ? c.text : `[image ${c.mimeType}]`)).join('\n'), structured: r.structuredContent };
  }

  /** Streams a reply from an AWS-hosted agent (Bedrock Agents Classic or AgentCore Runtime). */
  async *invoke(p: Principal, id: string, input: { prompt: string; context?: string; sessionId?: string; signal?: AbortSignal }): AsyncGenerator<string, { session_id: string }, void> {
    requireScope(p, 'read');
    const agent = await this.getOwned(p.userId, id);
    const sessionId = input.sessionId ?? newSessionId();
    const started = performance.now();
    try {
      if (agent.framework === 'bedrock_agent') {
        if (!agent.config.agent_id || !agent.config.agent_alias_id || !agent.config.region) throw badRequest('Set region, agent id and alias id on this agent to invoke it');
        const inputText = input.context ? `${input.prompt}\n\n<duckview_context>\n${input.context}\n</duckview_context>` : input.prompt;
        for await (const chunk of this.aws.invokeBedrockAgent({ region: agent.config.region, agentId: agent.config.agent_id, agentAliasId: agent.config.agent_alias_id, sessionId, inputText, signal: input.signal })) yield chunk;
      } else if (agent.framework === 'agentcore_runtime') {
        if (!agent.config.runtime_arn || !agent.config.region) throw badRequest('Set the AgentCore runtime ARN (and region) on this agent to invoke it');
        for await (const chunk of this.aws.invokeAgentCore({ region: agent.config.region, runtimeArn: agent.config.runtime_arn, qualifier: agent.config.qualifier || undefined, sessionId, payload: { prompt: input.prompt, ...(input.context ? { context: input.context } : {}) }, signal: input.signal })) yield chunk;
      } else {
        throw badRequest(`${FRAMEWORK_META[agent.framework].title} agents run on your side and call DuckView — DuckView cannot invoke them. Use a Bedrock Agent or AgentCore Runtime registration to chat with a hosted agent.`);
      }
      this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'agent.invoke', resource: `agent:${id}`, queryText: input.prompt.slice(0, 2000), durationMs: performance.now() - started, ip: p.ip });
    } catch (err) {
      this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'agent.invoke', resource: `agent:${id}`, queryText: input.prompt.slice(0, 2000), durationMs: performance.now() - started, ip: p.ip, status: 'error', error: (err as Error).message });
      throw err;
    }
    return { session_id: sessionId };
  }

  /** Pickers for the registration form. */
  async discover(kind: 'bedrock_agents' | 'agentcore_runtimes' | 'bedrock_models', region: string) {
    if (!region) throw badRequest('region is required');
    if (kind === 'bedrock_agents') return { agents: await this.aws.listBedrockAgents(region) };
    if (kind === 'agentcore_runtimes') return { runtimes: await this.aws.listAgentRuntimes(region) };
    return { models: await this.aws.listModels(region) };
  }
}
