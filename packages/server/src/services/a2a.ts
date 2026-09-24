/**
 * Agent2Agent (A2A, protocol 0.3): DuckView's agents talk to other agents, both ways.
 *
 * Server. A published hosted agent is an A2A agent: its Agent Card (public, as A2A clients fetch cards before they
 * authenticate) at /a2a/agents/:id/.well-known/agent-card.json names one skill, and its JSON-RPC endpoint
 * /a2a/agents/:id takes message/send, message/stream (SSE), tasks/get and tasks/cancel with a DuckView API token
 * (Bearer). A task is a run of the agent, acting as the caller — read-only, their workspaces, their access
 * policies. DuckView's own card at /.well-known/agent-card.json describes the server; its authenticated extended
 * card (agent/getAuthenticatedExtendedCard) lists the published agents the caller can reach, each with its URL.
 *
 * Client. A person registers remote A2A agents by the URL of their card (auth headers kept encrypted) and asks
 * them from DuckView or through the ask_agent tool. Calls go through the egress guard: https and public addresses
 * unless a2a.allow_private_targets.
 */
import { and, eq } from 'drizzle-orm';
import type { MetadataStore } from '../db/index.js';
import type { A2aRemote, HostedAgent, HostedAgentRun } from '../db/schema/sqlite.js';
import type { DuckViewConfig } from '../config/index.js';
import type { CredentialCipher } from '../security/crypto.js';
import { newId } from '../security/crypto.js';
import { egressRequest } from '../security/egress.js';
import type { Principal } from './principal.js';
import { requireScope } from './principal.js';
import type { WorkspaceService } from './workspaces.js';
import type { AuditService } from './audit.js';
import type { HostedAgentService } from './hosted-agents.js';
import { badRequest, notFound, HttpError } from './errors.js';

export const A2A_VERSION = '0.3.0';

export type A2APart = { kind: 'text'; text: string } | { kind: 'data'; data: Record<string, unknown> } | { kind: 'file'; file: { name?: string; mimeType?: string; uri?: string; bytes?: string } };
export interface A2AMessage { kind: 'message'; role: 'user' | 'agent'; parts: A2APart[]; messageId: string; contextId?: string; taskId?: string; metadata?: Record<string, unknown> }
export type A2AState = 'submitted' | 'working' | 'input-required' | 'completed' | 'canceled' | 'failed' | 'rejected' | 'auth-required' | 'unknown';
export interface A2ATask { kind: 'task'; id: string; contextId: string; status: { state: A2AState; message?: A2AMessage; timestamp: string }; artifacts?: { artifactId: string; name?: string; description?: string; parts: A2APart[] }[]; history?: A2AMessage[]; metadata?: Record<string, unknown> }
export interface AgentCard {
  protocolVersion: string;
  name: string;
  description: string;
  url: string;
  preferredTransport: 'JSONRPC';
  version: string;
  provider?: { organization: string; url: string };
  documentationUrl?: string;
  capabilities: { streaming: boolean; pushNotifications: boolean; stateTransitionHistory: boolean };
  securitySchemes?: Record<string, unknown>;
  security?: Record<string, string[]>[];
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: { id: string; name: string; description: string; tags: string[]; examples?: string[] }[];
  supportsAuthenticatedExtendedCard?: boolean;
}

/** JSON-RPC error codes: the standard ones and A2A's. */
export const RPC = { parse: -32700, invalidRequest: -32600, methodNotFound: -32601, invalidParams: -32602, internal: -32603, taskNotFound: -32001, taskNotCancelable: -32002, unsupported: -32004 } as const;
export class RpcError extends Error {
  constructor(public readonly code: number, message: string, public readonly data?: unknown) {
    super(message);
  }
}

const SECURITY = { securitySchemes: { duckview: { type: 'http', scheme: 'bearer', description: 'A DuckView API token (AI → New API token) with the read scope, of someone who can see the agent\'s workspace.' } }, security: [{ duckview: [] }] };

/** The text a person or a model reads from a message's parts (data parts as JSON). */
export function partsText(parts: A2APart[] | undefined): string {
  return (parts ?? []).map((p) => (p.kind === 'text' ? p.text : p.kind === 'data' ? `\`\`\`json\n${JSON.stringify(p.data, null, 2)}\n\`\`\`` : p.file?.name ? `[file ${p.file.name}]` : '')).filter(Boolean).join('\n\n');
}

const STATE: Record<HostedAgentRun['status'], A2AState> = { running: 'working', completed: 'completed', failed: 'failed' };

/** A hosted agent's run as an A2A task: the answer as an artifact (markdown), the steps as data. */
export function taskOf(run: HostedAgentRun, opts: { canceled?: boolean; historyLength?: number } = {}): A2ATask {
  const contextId = run.context_id ?? run.id;
  const state: A2AState = opts.canceled || (run.status === 'failed' && run.error === 'Stopped') ? 'canceled' : STATE[run.status];
  const user: A2AMessage = { kind: 'message', role: 'user', parts: [{ kind: 'text', text: run.input }], messageId: `${run.id}-in`, contextId, taskId: run.id };
  const reply: A2AMessage | undefined = run.output ? { kind: 'message', role: 'agent', parts: [{ kind: 'text', text: run.output }], messageId: `${run.id}-out`, contextId, taskId: run.id } : run.error ? { kind: 'message', role: 'agent', parts: [{ kind: 'text', text: run.error }], messageId: `${run.id}-err`, contextId, taskId: run.id } : undefined;
  const history = [user, ...(reply ? [reply] : [])];
  return {
    kind: 'task',
    id: run.id,
    contextId,
    status: { state, ...(state !== 'working' && reply ? { message: reply } : {}), timestamp: (run.finished_at ?? run.started_at).toISOString() },
    ...(run.output ? { artifacts: [{ artifactId: `${run.id}-answer`, name: 'answer', parts: [{ kind: 'text' as const, text: run.output }, { kind: 'data' as const, data: { steps: run.steps.map((s) => ({ tool: s.tool, arguments: s.arguments, ok: s.ok, summary: s.summary })), model: run.model, input_tokens: run.input_tokens, output_tokens: run.output_tokens } }] }] } : {}),
    history: opts.historyLength === 0 ? [] : history,
  };
}

export class A2AService {
  /** Runs in flight, for tasks/cancel. */
  private controllers = new Map<string, AbortController>();

  constructor(private readonly cfg: DuckViewConfig, private readonly store: MetadataStore, private readonly cipher: CredentialCipher, private readonly workspaces: WorkspaceService, private readonly hosted: HostedAgentService, private readonly audit: AuditService) {}
  private get db() {
    return this.store.db;
  }
  private get s() {
    return this.store.schema;
  }

  // ------------------------------------------------------------------------------------------ cards

  serverCard(base: string): AgentCard {
    return {
      protocolVersion: A2A_VERSION,
      name: 'DuckView',
      description: 'A DuckDB analytics workspace. Its published agents answer questions about data, metrics, anomalies, data quality and pipelines. Authenticate with a DuckView API token; the extended card lists the agents you can reach.',
      url: `${base}/a2a`,
      preferredTransport: 'JSONRPC',
      version: '1.0.0',
      provider: { organization: 'DuckView', url: base },
      documentationUrl: `${base}/#/mcp/hosted`,
      capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: false },
      ...SECURITY,
      defaultInputModes: ['text/plain', 'application/json'],
      defaultOutputModes: ['text/markdown', 'application/json'],
      skills: [{ id: 'published-agents', name: 'DuckView agents', description: 'Runs one of this server\'s published agents: name it with metadata.agent (its id or name) on the message, or call the agent\'s own URL from the extended card.', tags: ['data', 'analytics', 'sql', 'metrics'] }],
      supportsAuthenticatedExtendedCard: true,
    };
  }

  agentCard(base: string, agent: HostedAgent): AgentCard {
    return {
      protocolVersion: A2A_VERSION,
      name: agent.name,
      description: agent.description ?? agent.instructions.split('\n')[0]!.slice(0, 300),
      url: `${base}/a2a/agents/${agent.id}`,
      preferredTransport: 'JSONRPC',
      version: agent.updated_at.toISOString().slice(0, 10),
      provider: { organization: 'DuckView', url: base },
      capabilities: { streaming: true, pushNotifications: false, stateTransitionHistory: false },
      ...SECURITY,
      defaultInputModes: ['text/plain', 'application/json'],
      defaultOutputModes: ['text/markdown', 'application/json'],
      skills: [{ id: agent.template ?? 'agent', name: agent.name, description: agent.description ?? 'A DuckView agent.', tags: ['duckview', ...(agent.template ? [agent.template] : [])], examples: [agent.task] }],
    };
  }

  /** A published agent, found without authentication (for its card). */
  async publishedAgent(id: string): Promise<HostedAgent> {
    const a = (await this.db.select().from(this.s.hostedAgents).where(and(eq(this.s.hostedAgents.id, id), eq(this.s.hostedAgents.published, true))).limit(1))[0];
    if (!a || !this.cfg.a2a.enabled) throw notFound('Agent');
    return a;
  }

  /** The published agents the caller can reach (workspaces they are a member of). */
  async reachable(p: Principal): Promise<HostedAgent[]> {
    const rows = await this.db.select().from(this.s.hostedAgents).where(eq(this.s.hostedAgents.published, true));
    const out: HostedAgent[] = [];
    for (const a of rows) if (await this.workspaces.get(p, a.workspace_id).then(() => true, () => false)) out.push(a);
    return out.filter((a) => !p.workspaceScope || a.workspace_id === p.workspaceScope);
  }

  // ------------------------------------------------------------------------------------------ JSON-RPC

  /** Which agent a request to the server-level endpoint means: metadata.agent (id or name). */
  private async pick(p: Principal, params: { message?: A2AMessage; metadata?: Record<string, unknown> }): Promise<HostedAgent> {
    const want = String(params.metadata?.agent ?? params.message?.metadata?.agent ?? '').trim();
    const agents = await this.reachable(p);
    if (!want) {
      if (agents.length === 1) return agents[0]!;
      throw new RpcError(RPC.invalidParams, `Name the agent with metadata.agent (one of: ${agents.map((a) => a.name).join(', ') || 'none published for you'})`);
    }
    const a = agents.find((x) => x.id === want) ?? agents.find((x) => x.name.toLowerCase() === want.toLowerCase());
    if (!a) throw new RpcError(RPC.invalidParams, `No published agent ${want} you can reach`);
    return a;
  }

  private async checkAccess(p: Principal, agent: HostedAgent): Promise<void> {
    requireScope(p, 'read');
    if (!agent.published) throw new RpcError(RPC.invalidRequest, 'This agent is not published');
    if (p.workspaceScope && p.workspaceScope !== agent.workspace_id) throw new HttpError(403, 'This token is scoped to another workspace', 'FORBIDDEN');
    await this.workspaces.get(p, agent.workspace_id);
  }

  private async runOf(p: Principal, taskId: string): Promise<HostedAgentRun> {
    const run = (await this.db.select().from(this.s.hostedAgentRuns).where(eq(this.s.hostedAgentRuns.id, String(taskId))).limit(1))[0];
    // Tasks are the caller's own.
    if (!run || run.actor_id !== p.userId || run.triggered_by !== 'a2a') throw new RpcError(RPC.taskNotFound, 'Task not found');
    return run;
  }

  /**
   * One JSON-RPC call. `agentId` is set for an agent's own endpoint; null for the server endpoint. For
   * message/stream, `emit` receives each event (the caller writes them as SSE) and the method resolves at the end.
   */
  async handle(p: Principal, base: string, agentId: string | null, method: string, params: Record<string, unknown>, emit?: (result: unknown) => void): Promise<unknown> {
    if (!this.cfg.a2a.enabled) throw new RpcError(RPC.unsupported, 'A2A is turned off on this server');
    switch (method) {
      case 'agent/getAuthenticatedExtendedCard': {
        const card = this.serverCard(base);
        const agents = await this.reachable(p);
        return { ...card, skills: agents.map((a) => ({ id: a.id, name: a.name, description: `${a.description ?? ''} — its own endpoint: ${base}/a2a/agents/${a.id}`.trim(), tags: ['duckview', ...(a.template ? [a.template] : [])], examples: [a.task] })) };
      }
      case 'message/send':
      case 'message/stream': {
        const message = params.message as A2AMessage | undefined;
        if (!message || !Array.isArray(message.parts)) throw new RpcError(RPC.invalidParams, 'params.message with parts is required');
        const text = partsText(message.parts).trim();
        if (!text) throw new RpcError(RPC.invalidParams, 'The message has no text or data');
        if (message.taskId) throw new RpcError(RPC.unsupported, 'DuckView tasks finish in one turn; send a new message (same contextId) instead of continuing a task');
        const agent = agentId ? await this.publishedAgent(agentId) : await this.pick(p, params as { message?: A2AMessage; metadata?: Record<string, unknown> });
        await this.checkAccess(p, agent);
        const contextId = message.contextId || newId();
        const controller = new AbortController();
        const blocking = method === 'message/stream' || (params.configuration as { blocking?: boolean } | undefined)?.blocking !== false;
        const historyLength = (params.configuration as { historyLength?: number } | undefined)?.historyLength;
        const started = await this.hosted.run(agent.id, {
          p,
          actAs: p,
          input: text,
          triggeredBy: 'a2a',
          contextId,
          signal: controller.signal,
          wait: false,
          onStep: emit ? (run, step) => emit({ kind: 'status-update', taskId: run.id, contextId, status: { state: 'working', message: { kind: 'message', role: 'agent', parts: [{ kind: 'text', text: `${step.tool}: ${step.summary}` }], messageId: newId(), contextId, taskId: run.id }, timestamp: new Date().toISOString() }, final: false }) : undefined,
        });
        this.controllers.set(started.id, controller);
        this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'a2a.message', resource: `hosted_agent:${agent.id}`, queryText: text.slice(0, 2000), ip: p.ip });
        if (emit) emit({ ...taskOf(started), status: { state: 'submitted', timestamp: new Date().toISOString() } });
        if (!blocking) return taskOf(started, { historyLength });
        const finished = await this.hosted.wait(started.id);
        this.controllers.delete(started.id);
        const task = taskOf(finished, { canceled: controller.signal.aborted, historyLength });
        if (emit) {
          if (task.artifacts?.[0]) emit({ kind: 'artifact-update', taskId: task.id, contextId, artifact: task.artifacts[0], append: false, lastChunk: true });
          emit({ kind: 'status-update', taskId: task.id, contextId, status: task.status, final: true });
        }
        return task;
      }
      case 'tasks/get': {
        const run = await this.runOf(p, String(params.id ?? ''));
        return taskOf(run, { historyLength: params.historyLength as number | undefined });
      }
      case 'tasks/cancel': {
        const run = await this.runOf(p, String(params.id ?? ''));
        const c = this.controllers.get(run.id);
        if (run.status !== 'running' || !c) throw new RpcError(RPC.taskNotCancelable, `Task is ${STATE[run.status]}`);
        c.abort();
        return taskOf(await this.hosted.wait(run.id), { canceled: true });
      }
      case 'tasks/resubscribe':
      case 'tasks/pushNotificationConfig/set':
      case 'tasks/pushNotificationConfig/get':
        throw new RpcError(RPC.unsupported, `${method} is not supported`);
      default:
        throw new RpcError(RPC.methodNotFound, `Method ${method} not found`);
    }
  }

  // ------------------------------------------------------------------------------------------ remote agents

  private egress(maxBytes = 1024 * 1024) {
    return { allowPrivate: this.cfg.a2a.allow_private_targets, timeoutMs: this.cfg.a2a.timeout_seconds * 1000, maxBytes, setting: 'a2a.allow_private_targets' };
  }

  /** Fetches and checks an Agent Card. A URL without a card path gets /.well-known/agent-card.json. */
  async fetchCard(url: string, headers: Record<string, string> = {}): Promise<{ card: AgentCard; card_url: string }> {
    let u: URL;
    try {
      u = new URL(url.trim());
    } catch {
      throw badRequest('Give the URL of the agent (or of its agent card)');
    }
    const candidates = /\.json$/.test(u.pathname) ? [u.toString()] : [new URL('.well-known/agent-card.json', u.toString().replace(/\/?$/, '/')).toString(), new URL('.well-known/agent.json', u.toString().replace(/\/?$/, '/')).toString()];
    let last = '';
    for (const c of candidates) {
      try {
        const r = await egressRequest('GET', c, null, { accept: 'application/json', 'user-agent': 'DuckView-A2A/1', ...headers }, this.egress(256 * 1024));
        if (r.status !== 200) {
          last = `${c}: HTTP ${r.status}`;
          continue;
        }
        const card = JSON.parse(r.body) as AgentCard;
        if (!card?.name || !card.url) throw new Error('not an agent card (it needs name and url)');
        new URL(card.url);
        return { card: { ...card, skills: Array.isArray(card.skills) ? card.skills : [] }, card_url: c };
      } catch (err) {
        last = `${c}: ${(err as Error).message}`;
      }
    }
    throw badRequest(`Could not read an agent card — ${last}`);
  }

  private publicRemote(r: A2aRemote) {
    const { encrypted_headers: _e, iv: _i, tag: _t, ...rest } = r;
    return { ...rest, headers_set: !!r.encrypted_headers };
  }

  async listRemotes(p: Principal) {
    const rows = await this.db.select().from(this.s.a2aRemotes).where(eq(this.s.a2aRemotes.user_id, p.userId));
    return rows.sort((a, b) => a.name.localeCompare(b.name)).map((r) => this.publicRemote(r));
  }

  private async remote(p: Principal, id: string): Promise<A2aRemote> {
    const r = (await this.db.select().from(this.s.a2aRemotes).where(and(eq(this.s.a2aRemotes.id, id), eq(this.s.a2aRemotes.user_id, p.userId))).limit(1))[0];
    if (!r) throw notFound('Remote agent');
    return r;
  }

  private headersOf(r: A2aRemote): Record<string, string> {
    return r.encrypted_headers ? this.cipher.decryptJson<{ headers: Record<string, string> }>({ ciphertext: r.encrypted_headers, iv: r.iv!, tag: r.tag! }, r.id).headers : {};
  }

  async addRemote(p: Principal, input: { url: string; headers?: Record<string, string> | null; name?: string | null }) {
    requireScope(p, 'read');
    const headers = Object.fromEntries(Object.entries(input.headers ?? {}).filter(([k, v]) => k.trim() && typeof v === 'string' && v.trim()));
    const { card, card_url } = await this.fetchCard(input.url, headers);
    const id = newId();
    const enc = Object.keys(headers).length ? this.cipher.encryptJson({ headers }, id) : null;
    const now = new Date();
    const row: A2aRemote = { id, user_id: p.userId, name: (input.name?.trim() || card.name).slice(0, 120), card_url, endpoint: card.url, card: card as unknown as Record<string, unknown>, encrypted_headers: enc?.ciphertext ?? null, iv: enc?.iv ?? null, tag: enc?.tag ?? null, last_used_at: null, created_at: now, updated_at: now };
    await this.db.insert(this.s.a2aRemotes).values(row);
    this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'a2a.remote.add', resource: `a2a_remote:${id}`, ip: p.ip });
    return this.publicRemote(row);
  }

  async refreshRemote(p: Principal, id: string) {
    const r = await this.remote(p, id);
    const { card } = await this.fetchCard(r.card_url, this.headersOf(r));
    await this.db.update(this.s.a2aRemotes).set({ card: card as unknown as Record<string, unknown>, endpoint: card.url, updated_at: new Date() }).where(eq(this.s.a2aRemotes.id, id));
    return this.publicRemote({ ...r, card: card as unknown as Record<string, unknown>, endpoint: card.url });
  }

  async removeRemote(p: Principal, id: string) {
    await this.remote(p, id);
    await this.db.delete(this.s.a2aRemotes).where(eq(this.s.a2aRemotes.id, id));
    this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'a2a.remote.delete', resource: `a2a_remote:${id}`, ip: p.ip });
  }

  private async rpc(r: A2aRemote, method: string, params: Record<string, unknown>): Promise<unknown> {
    const res = await egressRequest('POST', r.endpoint, JSON.stringify({ jsonrpc: '2.0', id: newId(), method, params }), { 'content-type': 'application/json', accept: 'application/json', 'user-agent': 'DuckView-A2A/1', ...this.headersOf(r) }, this.egress());
    if (res.status === 401 || res.status === 403) throw badRequest(`${r.name} refused the call (HTTP ${res.status}) — check the auth headers`);
    let body: { result?: unknown; error?: { code: number; message: string } };
    try {
      body = JSON.parse(res.body);
    } catch {
      throw badRequest(`${r.name} did not answer with JSON-RPC (HTTP ${res.status})`);
    }
    if (body.error) throw badRequest(`${r.name}: ${body.error.message} (${body.error.code})`);
    return body.result;
  }

  /** Sends a message to a remote agent and waits for its answer (polling tasks/get while it works). */
  async ask(p: Principal, id: string, text: string, opts: { contextId?: string | null } = {}): Promise<{ text: string; state: A2AState; task_id: string | null; context_id: string | null }> {
    requireScope(p, 'read');
    const r = await this.remote(p, id);
    const message: A2AMessage = { kind: 'message', role: 'user', parts: [{ kind: 'text', text }], messageId: newId(), ...(opts.contextId ? { contextId: opts.contextId } : {}) };
    let result = (await this.rpc(r, 'message/send', { message, configuration: { blocking: true, acceptedOutputModes: ['text/plain', 'text/markdown', 'application/json'] } })) as A2ATask | A2AMessage;
    const deadline = Date.now() + this.cfg.a2a.timeout_seconds * 1000;
    while (result?.kind === 'task' && ['submitted', 'working'].includes(result.status.state) && Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, 1500));
      result = (await this.rpc(r, 'tasks/get', { id: result.id })) as A2ATask;
    }
    await this.db.update(this.s.a2aRemotes).set({ last_used_at: new Date() }).where(eq(this.s.a2aRemotes.id, id));
    this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'a2a.ask', resource: `a2a_remote:${id}`, queryText: text.slice(0, 2000), ip: p.ip });
    if (!result) throw badRequest(`${r.name} answered with nothing`);
    if (result.kind === 'message') return { text: partsText(result.parts), state: 'completed', task_id: result.taskId ?? null, context_id: result.contextId ?? null };
    const answer = [...(result.artifacts ?? []).map((a) => partsText(a.parts.filter((x) => x.kind === 'text'))), result.status.state !== 'completed' || !result.artifacts?.length ? partsText(result.status.message?.parts) : ''].filter(Boolean).join('\n\n');
    return { text: answer || `(No answer; the task is ${result.status.state}.)`, state: result.status.state, task_id: result.id, context_id: result.contextId };
  }
}
