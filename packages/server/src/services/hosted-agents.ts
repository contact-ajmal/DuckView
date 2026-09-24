/**
 * Hosted agents: agents DuckView runs itself — installed from the marketplace (agent/templates.ts) or written from
 * scratch — with instructions, a task, the tools they may use, a schedule and channels for their reports.
 *
 * A run is a loop over the server's model (a person starting a run may bring their own key for it; scheduled runs
 * never use one): the model sees its
 * instructions and the tools, asks for one tool at a time with a fenced ```tool block ({"name", "arguments"}),
 * gets the result back, and ends with an answer that has no tool block. That works with every provider DuckView
 * supports. Tools come from the same registry as MCP, limited to read-only ones (and SQL, which runs read-only);
 * the run acts as the agent's owner with the read scope only, pinned to the agent's workspace, under their access
 * policies. Each step is recorded; a finished report goes to the agent's channels.
 */
import { and, desc, eq, isNotNull, lt, lte } from 'drizzle-orm';
import type { MetadataStore } from '../db/index.js';
import type { HostedAgent, HostedAgentLastRun, HostedAgentRun, HostedAgentStep, SyncSchedule } from '../db/schema/sqlite.js';
import type { DuckViewConfig } from '../config/index.js';
import { newId } from '../security/crypto.js';
import type { Principal } from './principal.js';
import { requireWrite } from './principal.js';
import type { WorkspaceService } from './workspaces.js';
import type { AuthService } from './auth.js';
import type { AuditService } from './audit.js';
import type { NotificationService, Notification } from './notifications.js';
import type { LlmMessage, LlmProvider, ProviderId } from './llm.js';
import { nextRunAt } from './syncs.js';
import { badRequest, notFound } from './errors.js';
import { logger } from '../observability/logger.js';
import { liveEvents } from '../observability/events.js';
import { buildTools, runTool, type ToolDef, type ToolEnv } from '../agent/tools.js';
import { toolInputJsonSchema } from '../agent/openapi.js';
import { AGENT_TEMPLATES, templateById, type AgentTemplate } from '../agent/templates.js';
import type { AppContext } from '../context.js';

/** A person's own model settings for a run they start (never stored). */
export type ByokModel = { provider?: ProviderId; model?: string; apiKey?: string; baseUrl?: string; region?: string };

export interface HostedAgentInput {
  name?: string;
  description?: string | null;
  instructions?: string;
  task?: string;
  tools?: string[];
  max_steps?: number;
  schedule?: SyncSchedule;
  channel_ids?: string[];
  published?: boolean;
  enabled?: boolean;
}

/** SQL runs as the owner with the read scope only, so these are safe although they could write for others. */
const READ_ONLY_SQL = new Set(['execute_query']);
const TOOL_BLOCK = /```tool[ \t]*\n([\s\S]*?)```/;
const MAX_RESULT_CHARS = 8000;

/** Tools a hosted agent may be given: the registry's read-only tools and read-only SQL. */
export function hostedToolCatalog(cfg: DuckViewConfig): ToolDef[] {
  return buildTools(cfg).filter((t) => t.annotations.readOnlyHint === true || READ_ONLY_SQL.has(t.name));
}

/** "name(a: string, b?: number) — description", for the prompt. */
export function describeTool(t: ToolDef): string {
  const schema = toolInputJsonSchema(t) as { properties?: Record<string, { type?: string; enum?: unknown[] }>; required?: string[] };
  const args = Object.entries(schema.properties ?? {}).map(([k, v]) => `${k}${schema.required?.includes(k) ? '' : '?'}: ${v.enum ? v.enum.map((x) => JSON.stringify(x)).join('|') : v.type ?? 'any'}`);
  return `- ${t.name}(${args.join(', ')}) — ${t.description.split('\n')[0]!.slice(0, 400)}`;
}

/** The first ```tool block of a reply: {name, arguments}, or an error to send back to the model. */
export function parseToolCall(text: string): { name: string; arguments: Record<string, unknown> } | { error: string } | null {
  const m = TOOL_BLOCK.exec(text);
  if (!m) return null;
  try {
    const raw = JSON.parse(m[1]!.trim()) as { name?: unknown; tool?: unknown; arguments?: unknown; args?: unknown };
    const name = String(raw.name ?? raw.tool ?? '');
    if (!name) return { error: 'The tool block needs "name".' };
    const args = (raw.arguments ?? raw.args ?? {}) as Record<string, unknown>;
    return { name, arguments: typeof args === 'object' && args && !Array.isArray(args) ? args : {} };
  } catch (err) {
    return { error: `The tool block is not valid JSON (${(err as Error).message}). Send {"name": "...", "arguments": {...}}.` };
  }
}

/** A line that says what a tool returned — not a table header or a code fence. */
export function summarize(result: string): string {
  const lines = result.split('\n').map((l) => l.trim()).filter(Boolean);
  return (lines.find((l) => !/^(\||```|[{}\["]|[-:| ]+$)/.test(l)) ?? lines[0] ?? '').slice(0, 240);
}

export function agentSystemPrompt(agent: Pick<HostedAgent, 'name' | 'instructions'>, tools: ToolDef[], opts: { workspace: string; maxSteps: number }): string {
  return `You are "${agent.name}", an agent that DuckView (a DuckDB analytics workspace) runs for its users, working in the workspace "${opts.workspace}". Today is ${new Date().toISOString().slice(0, 10)}.

${agent.instructions.trim()}

## Tools
You can use these tools (read-only; the workspace is chosen for you, leave workspace_id out):
${tools.map(describeTool).join('\n')}

To use a tool, reply with ONLY one fenced block and nothing after it:
\`\`\`tool
{"name": "<tool>", "arguments": { ... }}
\`\`\`
The result comes back in the next message. Use at most ${opts.maxSteps} tools, one at a time. When you have what you need, reply with the final answer in markdown and no tool block. Use only numbers the tools returned.`;
}

export class HostedAgentService {
  private ctx!: AppContext;
  private ticker: NodeJS.Timeout | null = null;
  private running = new Set<string>();
  /** Runs in flight, for wait(). */
  private pending = new Map<string, Promise<HostedAgentRun>>();
  /** The server's model (set by the context from DuckView AI). */
  model: { serverModel(byok?: ByokModel | null): Promise<{ instance: LlmProvider }> } | null = null;

  constructor(private readonly cfg: DuckViewConfig, private readonly store: MetadataStore, private readonly workspaces: WorkspaceService, private readonly auth: AuthService, private readonly notifications: NotificationService, private readonly audit: AuditService) {}
  bind(ctx: AppContext) {
    this.ctx = ctx;
  }
  private get db() {
    return this.store.db;
  }
  private get s() {
    return this.store.schema;
  }

  // ------------------------------------------------------------------------------------------ marketplace

  templates(): (AgentTemplate & { tool_titles: string[] })[] {
    const byName = new Map(buildTools(this.cfg).map((t) => [t.name, t.title]));
    return AGENT_TEMPLATES.map((t) => ({ ...t, tool_titles: t.tools.map((n) => byName.get(n) ?? n) }));
  }

  /** Creates a hosted agent from a template; anything in `overrides` replaces the template's value. */
  async install(p: Principal, workspaceId: string, templateId: string, overrides: HostedAgentInput = {}): Promise<HostedAgent> {
    const t = templateById(templateId);
    if (!t) throw badRequest(`No agent template ${templateId} (there are ${AGENT_TEMPLATES.map((x) => x.id).join(', ')})`);
    return this.create(p, workspaceId, { name: t.name, description: t.description, instructions: t.instructions, task: t.task, tools: t.tools, schedule: t.schedule, ...overrides }, t.id);
  }

  // ------------------------------------------------------------------------------------------ agents

  private checkTools(tools: string[] | undefined): string[] {
    const allowed = new Set(hostedToolCatalog(this.cfg).map((t) => t.name));
    const list = [...new Set(tools ?? [])];
    if (!list.length) throw badRequest('Give the agent at least one tool');
    const bad = list.filter((n) => !allowed.has(n));
    if (bad.length) throw badRequest(`Hosted agents can use read-only tools only; not available: ${bad.join(', ')}`);
    return list;
  }

  private checkSchedule(input: SyncSchedule | undefined): SyncSchedule {
    const sch = input ?? { kind: 'manual' };
    if (sch.kind === 'interval' && (!Number.isFinite(sch.minutes) || sch.minutes < 15)) throw badRequest('schedule.minutes must be at least 15');
    nextRunAt(sch);
    return sch;
  }

  private async checkChannels(p: Principal, workspaceId: string, ids: string[] | undefined): Promise<string[]> {
    const wanted = [...new Set(ids ?? [])];
    if (!wanted.length) return [];
    const usable = new Set((await this.notifications.list(p, workspaceId)).map((c) => c.id));
    const bad = wanted.find((id) => !usable.has(id));
    if (bad) throw badRequest(`Channel ${bad} is not a channel of this workspace (or org-wide)`);
    return wanted;
  }

  async list(p: Principal, workspaceId: string): Promise<HostedAgent[]> {
    await this.workspaces.get(p, workspaceId);
    const rows = await this.db.select().from(this.s.hostedAgents).where(eq(this.s.hostedAgents.workspace_id, workspaceId));
    return rows.sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(p: Principal, id: string, minRole: 'VIEWER' | 'EDITOR' = 'VIEWER'): Promise<HostedAgent> {
    const a = (await this.db.select().from(this.s.hostedAgents).where(eq(this.s.hostedAgents.id, id)).limit(1))[0];
    if (!a) throw notFound('Agent');
    await this.workspaces.get(p, a.workspace_id, minRole);
    return a;
  }

  async create(p: Principal, workspaceId: string, input: HostedAgentInput, template: string | null = null): Promise<HostedAgent> {
    requireWrite(p);
    await this.workspaces.get(p, workspaceId, 'EDITOR');
    const name = (input.name ?? '').trim().slice(0, 120);
    if (!name) throw badRequest('name is required');
    const instructions = (input.instructions ?? '').trim();
    if (!instructions) throw badRequest('instructions are required');
    const schedule = this.checkSchedule(input.schedule);
    const now = new Date();
    const enabled = input.enabled ?? true;
    const row: HostedAgent = {
      id: newId(),
      workspace_id: workspaceId,
      user_id: p.userId,
      name,
      description: input.description?.trim() || null,
      template,
      instructions: instructions.slice(0, 20_000),
      task: (input.task ?? '').trim().slice(0, 4000) || 'Do your job for today.',
      tools: this.checkTools(input.tools),
      max_steps: Math.min(Math.max(1, Math.round(input.max_steps ?? 8)), 20),
      schedule,
      channel_ids: await this.checkChannels(p, workspaceId, input.channel_ids),
      published: input.published ?? false,
      enabled,
      last_run: null,
      next_run_at: enabled ? nextRunAt(schedule, now) : null,
      created_at: now,
      updated_at: now,
    };
    await this.db.insert(this.s.hostedAgents).values(row);
    this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'hosted_agent.create', resource: `hosted_agent:${row.id}`, ip: p.ip });
    return row;
  }

  async update(p: Principal, id: string, patch: HostedAgentInput): Promise<HostedAgent> {
    requireWrite(p);
    const a = await this.get(p, id, 'EDITOR');
    const set: Partial<HostedAgent> = { updated_at: new Date() };
    if (patch.name !== undefined) set.name = patch.name.trim().slice(0, 120) || a.name;
    if (patch.description !== undefined) set.description = patch.description?.trim() || null;
    if (patch.instructions !== undefined) set.instructions = patch.instructions.trim().slice(0, 20_000) || a.instructions;
    if (patch.task !== undefined) set.task = patch.task.trim().slice(0, 4000) || a.task;
    if (patch.tools !== undefined) set.tools = this.checkTools(patch.tools);
    if (patch.max_steps !== undefined) set.max_steps = Math.min(Math.max(1, Math.round(patch.max_steps)), 20);
    // Whoever changes what the agent does is who it runs as.
    if (patch.instructions !== undefined || patch.tools !== undefined || patch.task !== undefined) set.user_id = p.userId;
    if (patch.schedule !== undefined) set.schedule = this.checkSchedule(patch.schedule);
    if (patch.channel_ids !== undefined) set.channel_ids = await this.checkChannels(p, a.workspace_id, patch.channel_ids);
    if (patch.published !== undefined) set.published = patch.published;
    if (patch.enabled !== undefined) set.enabled = patch.enabled;
    const next = { ...a, ...set };
    if (patch.schedule !== undefined || patch.enabled !== undefined) set.next_run_at = next.enabled ? nextRunAt(next.schedule) : null;
    await this.db.update(this.s.hostedAgents).set(set).where(eq(this.s.hostedAgents.id, id));
    this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'hosted_agent.update', resource: `hosted_agent:${id}`, ip: p.ip });
    return { ...a, ...set };
  }

  async remove(p: Principal, id: string): Promise<void> {
    requireWrite(p);
    await this.get(p, id, 'EDITOR');
    await this.db.delete(this.s.hostedAgents).where(eq(this.s.hostedAgents.id, id));
    this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'hosted_agent.delete', resource: `hosted_agent:${id}`, ip: p.ip });
  }

  async runs(p: Principal, id: string, limit = 20): Promise<HostedAgentRun[]> {
    await this.get(p, id);
    return this.db.select().from(this.s.hostedAgentRuns).where(eq(this.s.hostedAgentRuns.agent_id, id)).orderBy(desc(this.s.hostedAgentRuns.started_at)).limit(Math.min(limit, 100));
  }

  async getRun(p: Principal, runId: string): Promise<HostedAgentRun> {
    const run = (await this.db.select().from(this.s.hostedAgentRuns).where(eq(this.s.hostedAgentRuns.id, runId)).limit(1))[0];
    if (!run) throw notFound('Agent run');
    await this.get(p, run.agent_id);
    return run;
  }

  // ------------------------------------------------------------------------------------------ running

  /**
   * Starts a run. With wait, resolves when it is finished; otherwise returns the run as soon as it is recorded
   * (poll getRun). `p` must be able to see the agent; the run itself acts as the agent's owner (or `actAs`),
   * read-only. Scheduled and manual runs of an agent take turns; calls from other agents (actAs) run side by side.
   */
  async run(id: string, opts: { p?: Principal | null; input?: string | null; triggeredBy?: string; wait?: boolean; signal?: AbortSignal; byok?: ByokModel | null; actAs?: Principal | null; contextId?: string | null; onStep?: (run: HostedAgentRun, step: HostedAgentStep) => void } = {}): Promise<HostedAgentRun> {
    const agent = opts.p ? await this.get(opts.p, id) : (await this.db.select().from(this.s.hostedAgents).where(eq(this.s.hostedAgents.id, id)).limit(1))[0];
    if (!agent) throw notFound('Agent');
    const exclusive = !opts.actAs;
    if (exclusive && this.running.has(id)) throw badRequest('This agent is running right now');
    const run: HostedAgentRun = { id: newId(), agent_id: id, workspace_id: agent.workspace_id, status: 'running', triggered_by: opts.triggeredBy ?? 'manual', actor_id: opts.p?.userId ?? null, context_id: opts.contextId ?? null, input: (opts.input?.trim() || agent.task).slice(0, 8000), output: null, steps: [], error: null, model: null, input_tokens: 0, output_tokens: 0, notified: 0, started_at: new Date(), finished_at: null };
    await this.db.insert(this.s.hostedAgentRuns).values(run);
    if (exclusive) this.running.add(id);
    const done = this.execute(agent, run, { signal: opts.signal, byok: opts.p ? opts.byok : null, actAs: opts.actAs ?? null, onStep: opts.onStep }).finally(() => {
      if (exclusive) this.running.delete(id);
      this.pending.delete(run.id);
    });
    this.pending.set(run.id, done);
    if (opts.wait) return done;
    done.catch((err) => logger().warn({ agent: id, err: (err as Error).message }, 'Hosted agent run failed'));
    return run;
  }

  /** A run's final state: waits for it when it is still going. */
  async wait(runId: string): Promise<HostedAgentRun> {
    const p = this.pending.get(runId);
    if (p) return p;
    const run = (await this.db.select().from(this.s.hostedAgentRuns).where(eq(this.s.hostedAgentRuns.id, runId)).limit(1))[0];
    if (!run) throw notFound('Agent run');
    return run;
  }

  /**
   * Runs as the agent's owner — or, with actAs, as whoever asked (A2A callers, other agents): read-only either way,
   * so a caller never sees more than their own access allows.
   */
  private async execute(agent: HostedAgent, run: HostedAgentRun, o: { signal?: AbortSignal; byok?: ByokModel | null; actAs?: Principal | null; onStep?: (run: HostedAgentRun, step: HostedAgentStep) => void }): Promise<HostedAgentRun> {
    const { signal, byok } = o;
    const save = (set: Partial<HostedAgentRun>) => this.db.update(this.s.hostedAgentRuns).set(set).where(eq(this.s.hostedAgentRuns.id, run.id));
    const steps: HostedAgentStep[] = [];
    let usage = { input: 0, output: 0 };
    let final: Partial<HostedAgentRun>;
    try {
      if (!this.model) throw new Error('DuckView AI is not available on this server');
      let base: Principal;
      if (o.actAs) base = o.actAs;
      else {
        const owner = await this.auth.findActive(agent.user_id);
        if (!owner) throw new Error('The agent\'s owner no longer exists or has been deactivated.');
        base = this.auth.principalFromUser(owner, 'jwt', 'hosted-agent');
      }
      const principal: Principal = { ...base, scopes: ['read'], workspaceScope: agent.workspace_id, actorType: 'AGENT' };
      const ws = await this.workspaces.get(principal, agent.workspace_id);
      const catalog = new Map(hostedToolCatalog(this.cfg).map((t) => [t.name, t]));
      const tools = agent.tools.map((n) => catalog.get(n)).filter((t): t is ToolDef => !!t);
      const { instance } = await this.model.serverModel(byok);
      await save({ model: instance.model });
      const env: ToolEnv = { ctx: this.ctx, principal, defaultWorkspaceId: agent.workspace_id, via: 'rest', agent: null };
      const system = agentSystemPrompt(agent, tools, { workspace: ws.name, maxSteps: agent.max_steps });
      const messages: LlmMessage[] = [{ role: 'user', content: run.input }];
      let answer: string | null = null;
      for (let turn = 0; turn <= agent.max_steps + 1 && answer === null; turn++) {
        if (signal?.aborted) throw new Error('Stopped');
        let text = '';
        const gen = instance.stream({ system, messages, model: instance.model, maxTokens: 2000, temperature: 0, signal, conversationId: run.id });
        let n = await gen.next();
        for (; !n.done; n = await gen.next()) text += n.value;
        usage = { input: usage.input + (n.value?.input_tokens ?? 0), output: usage.output + (n.value?.output_tokens ?? 0) };
        const call = parseToolCall(text);
        if (!call) {
          answer = text.trim();
          break;
        }
        messages.push({ role: 'assistant', content: text });
        if (steps.length >= agent.max_steps) {
          messages.push({ role: 'user', content: 'You have used all your tool calls. Write the final answer now from what you have, with no tool block.' });
          continue;
        }
        if ('error' in call) {
          messages.push({ role: 'user', content: call.error });
          continue;
        }
        const tool = tools.find((t) => t.name === call.name);
        const started = performance.now();
        let resultText: string;
        let summary: string | null = null;
        let ok = false;
        if (!tool) resultText = `ERROR: ${call.name} is not one of your tools (${tools.map((t) => t.name).join(', ')}).`;
        else {
          const { workspace_id: _ignored, ...args } = call.arguments;
          const r = await runTool(env, tool, args);
          ok = !r.isError;
          resultText = r.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n') || JSON.stringify(r.structuredContent ?? {});
          const sc = r.structuredContent as { rows?: unknown[]; columns?: { name: string }[] } | undefined;
          if (ok && Array.isArray(sc?.rows) && Array.isArray(sc?.columns)) summary = `${sc.rows.length} row${sc.rows.length === 1 ? '' : 's'}: ${sc.columns.map((c) => c.name).join(', ')}`;
        }
        if (resultText.length > MAX_RESULT_CHARS) resultText = `${resultText.slice(0, MAX_RESULT_CHARS)}\n… (cut; ask for less)`;
        steps.push({ tool: call.name, arguments: call.arguments, ok, summary: summary ?? summarize(resultText), duration_ms: Math.round(performance.now() - started) });
        messages.push({ role: 'user', content: `Result of ${call.name}:\n${resultText}` });
        await save({ steps: [...steps] });
        o.onStep?.(run, steps.at(-1)!);
        liveEvents.publish({ type: 'hosted_agent', at: new Date().toISOString(), workspace_id: agent.workspace_id, agent_id: agent.id, run_id: run.id, status: 'running', step: steps.length });
      }
      final = { status: 'completed', output: answer || '(The agent did not write an answer.)' };
    } catch (err) {
      final = { status: 'failed', error: signal?.aborted ? 'Stopped' : ((err as Error).message ?? String(err)).slice(0, 1000) };
    }
    const finished: HostedAgentRun = { ...run, ...final, steps, input_tokens: usage.input, output_tokens: usage.output, finished_at: new Date() };
    if ((run.triggered_by === 'schedule' || run.triggered_by === 'manual') && agent.channel_ids.length) {
      const ws = (await this.db.select({ name: this.s.workspaces.name }).from(this.s.workspaces).where(eq(this.s.workspaces.id, agent.workspace_id)).limit(1))[0];
      const sent = await this.notifications.send(agent.channel_ids, this.message(agent, finished, ws?.name ?? null), `hosted_agent:${agent.id}`, agent.workspace_id).catch(() => []);
      finished.notified = sent.filter((r) => r.status === 'ok').length;
    }
    await save({ status: finished.status, output: finished.output, error: finished.error, steps, input_tokens: finished.input_tokens, output_tokens: finished.output_tokens, notified: finished.notified, finished_at: finished.finished_at });
    const last: HostedAgentLastRun = { run_id: run.id, status: finished.status, summary: (finished.status === 'completed' ? finished.output ?? '' : finished.error ?? '').replace(/\s+/g, ' ').slice(0, 240), finished_at: finished.finished_at!.toISOString() };
    await this.db.update(this.s.hostedAgents).set({ last_run: last }).where(eq(this.s.hostedAgents.id, agent.id));
    await this.db.delete(this.s.hostedAgentRuns).where(and(eq(this.s.hostedAgentRuns.agent_id, agent.id), lt(this.s.hostedAgentRuns.started_at, new Date(Date.now() - 90 * 86_400_000)))).catch(() => undefined);
    liveEvents.publish({ type: 'hosted_agent', at: new Date().toISOString(), workspace_id: agent.workspace_id, agent_id: agent.id, run_id: run.id, status: finished.status, step: steps.length });
    this.audit.log({ userId: agent.user_id, actorType: 'AGENT', action: 'hosted_agent.run', resource: `hosted_agent:${agent.id}`, queryText: run.input.slice(0, 2000), durationMs: finished.finished_at!.getTime() - run.started_at.getTime(), ip: run.triggered_by });
    return finished;
  }

  private message(agent: HostedAgent, run: HostedAgentRun, workspace: string | null): Notification {
    const ok = run.status === 'completed';
    return {
      title: ok ? agent.name : `${agent.name} could not finish`,
      text: ok ? (run.output ?? '').slice(0, 3500) : `The run failed: ${run.error}`,
      severity: ok ? 'info' : 'warning',
      event: ok ? 'agent.report' : 'agent.failed',
      dedupKey: `duckview-agent-${agent.id}-${run.id}`,
      url: this.notifications.link(`/#/mcp/hosted?agent=${agent.id}&run=${run.id}`),
      fields: [{ label: 'Agent', value: agent.name }, { label: 'Tools used', value: String(run.steps.length) }, ...(workspace ? [{ label: 'Workspace', value: workspace }] : [])],
      workspace: workspace ? { id: agent.workspace_id, name: workspace } : null,
    };
  }

  // ------------------------------------------------------------------------------------------ scheduling

  async tick(now = new Date()): Promise<string[]> {
    const due = await this.db.select().from(this.s.hostedAgents).where(and(eq(this.s.hostedAgents.enabled, true), isNotNull(this.s.hostedAgents.next_run_at), lte(this.s.hostedAgents.next_run_at, now)));
    const ran: string[] = [];
    for (const a of due) {
      // Claimed atomically: with several nodes (cluster mode) only the one whose update lands runs it.
      const claimed = await this.db.update(this.s.hostedAgents).set({ next_run_at: nextRunAt(a.schedule, now) }).where(and(eq(this.s.hostedAgents.id, a.id), eq(this.s.hostedAgents.next_run_at, a.next_run_at!))).returning({ id: this.s.hostedAgents.id });
      if (!claimed.length) continue;
      try {
        await this.run(a.id, { triggeredBy: 'schedule' });
        ran.push(a.id);
      } catch (err) {
        logger().warn({ agent: a.id, err: (err as Error).message }, 'Hosted agent could not start');
      }
    }
    return ran;
  }

  start(intervalMs = 30_000): void {
    if (this.ticker) return;
    this.ticker = setInterval(() => void this.tick().catch((err) => logger().warn({ err: (err as Error).message }, 'Hosted agent scheduler tick failed')), intervalMs);
    this.ticker.unref();
  }

  stop(): void {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
  }
}
