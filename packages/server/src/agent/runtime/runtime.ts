/**
 * AgentRuntime — runs a person's request against their workspace.
 *
 *   request → classify and route (Decision Engine)
 *     ├─ a plain move ("open the revenue dashboard") → a workspace action, no model call
 *     └─ the loop: context (Context Engine) → tools (Decision Engine) → reasoning (ReasoningModel)
 *                  → tool (registry, runTool) → observations and artifacts → replan … → answer
 *
 * Security: the agent is the person who asked, marked actorType AGENT and pinned to the session's workspace. Tools
 * run through runTool and the services, so scopes, workspace roles, row policies, column masks, the SQL guard, the
 * file jail, HITL and audit all apply exactly as for that person. When a service asks for approval (HitlBlocked), the
 * task pauses; only the person who asked, signed in to DuckView (not a token), can approve, and only then is the call
 * repeated with dry_run=false. A denial goes back to the model, which must answer without it.
 *
 * Durability: sessions, tasks (plan, steps, artifacts, actions, approval, telemetry) and observations are rows; the
 * events of a running task stream on the AgentEventBus (SSE per task, the live feed for the workspace).
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import type { AgentApprovalRecord, AgentArtifact, AgentPageRef, AgentPlanStep, AgentSession, AgentStepRecord, AgentTask, AgentTelemetry, AgentWorkspaceAction } from '../../db/schema/sqlite.js';
import { newId } from '../../security/crypto.js';
import type { Principal } from '../../services/principal.js';
import { canWrite, requireScope } from '../../services/principal.js';
import { badRequest, forbidden, notFound } from '../../services/errors.js';
import { logger } from '../../observability/logger.js';
import { tracer } from '../../observability/tracing.js';
import type { ByokModel } from '../../services/hosted-agents.js';
import { runTool, type ToolEnv } from '../tools.js';
import { toolRegistry, type ToolDescriptor } from '../registry.js';
import { AgentEventBus, type AgentEventType } from '../events.js';
import type { ContextObject } from '../context/types.js';
import { budgetFromConfig } from '../context/engine.js';
import type { ClassificationResult, Intent } from '../decision/types.js';
import { INTENTS } from '../decision/types.js';
import type { ReasoningMessage, ReasoningModel } from '../reasoning/types.js';
import { LlmReasoningModel } from '../reasoning/llm.js';
import { OPEN_IN_WORKSPACE, resolveAction } from './actions.js';
import { artifactsOf, observe } from './observe.js';
import { initialPlan, systemPrompt } from './prompt.js';

export type AgentMode = 'auto' | 'analysis' | 'investigate' | 'build' | 'explain';
const MODE_INTENT: Partial<Record<AgentMode, Intent>> = { analysis: 'analyse', investigate: 'investigate', build: 'build', explain: 'explain' };
const MAX_RESULT_CHARS = 8000;
const HISTORY_TASKS = 6;

export interface StartTaskInput {
  workspaceId: string;
  sessionId?: string | null;
  request: string;
  mode?: AgentMode;
  page?: AgentPageRef | null;
  via: 'ui' | 'mcp' | 'rest' | 'a2a';
  byok?: ByokModel | null;
}

/** What a running task holds between steps (and while it waits for an approval). */
interface TaskState {
  task: AgentTask;
  principal: Principal;
  /** Offered reading tools only (read-only account, or a viewer of this workspace). */
  readOnly: boolean;
  model: ReasoningModel;
  classification: ClassificationResult;
  messages: ReasoningMessage[];
  offered: Map<string, ToolDescriptor>;
  used: string[];
  failures: Map<string, number>;
  observations: ContextObject[];
  history: ContextObject[];
  controller: AbortController;
  toolCalls: number;
  started: number;
  pending: { tool: string; arguments: Record<string, unknown> } | null;
}

const emptyTelemetry = (engine: string): AgentTelemetry => ({ decision_engine: engine, context_objects_considered: 0, context_objects_selected: 0, context_tokens: 0, decision_ms: 0, reasoning_ms: 0, tool_calls: 0, tool_failures: 0, tool_ms: 0, llm_calls: 0, input_tokens: 0, output_tokens: 0, estimated_cost_usd: null, duration_ms: 0 });

export class AgentRuntime {
  readonly events = new AgentEventBus();
  /** Builds the reasoning model for a task (the server's model, or the person's own key); replaceable in tests. */
  modelFactory: (byok: ByokModel | null) => Promise<ReasoningModel>;
  private readonly states = new Map<string, TaskState>();
  private readonly done = new Map<string, Promise<AgentTask>>();
  private readonly resolvers = new Map<string, (t: AgentTask) => void>();

  constructor(private readonly ctx: AppContext) {
    this.modelFactory = async (byok) => new LlmReasoningModel((await ctx.copilot.serverModel(byok ?? null)).instance);
  }

  private get db() {
    return this.ctx.store.db;
  }
  private get s() {
    return this.ctx.store.schema;
  }

  // ------------------------------------------------------------------------------------------ sessions

  async createSession(p: Principal, workspaceId: string, input: { title?: string | null; via?: StartTaskInput['via']; page?: AgentPageRef | null } = {}): Promise<AgentSession> {
    this.guard(p, workspaceId);
    await this.ctx.workspaces.get(p, workspaceId);
    const now = new Date();
    const row: AgentSession = { id: newId(), workspace_id: workspaceId, user_id: p.userId, title: (input.title?.trim() || 'New session').slice(0, 200), via: input.via ?? 'ui', page: input.page ?? null, archived: false, created_at: now, updated_at: now };
    await this.db.insert(this.s.agentSessions).values(row);
    return row;
  }

  async listSessions(p: Principal, workspaceId: string, opts: { archived?: boolean; limit?: number } = {}): Promise<(AgentSession & { tasks: number; last_status: string | null })[]> {
    this.guard(p, workspaceId);
    await this.ctx.workspaces.get(p, workspaceId);
    const rows = await this.db.select().from(this.s.agentSessions).where(and(eq(this.s.agentSessions.user_id, p.userId), eq(this.s.agentSessions.workspace_id, workspaceId), eq(this.s.agentSessions.archived, opts.archived ?? false))).orderBy(desc(this.s.agentSessions.updated_at)).limit(Math.min(opts.limit ?? 100, 500));
    if (!rows.length) return [];
    const tasks = await this.db.select({ session_id: this.s.agentTasks.session_id, status: this.s.agentTasks.status, created_at: this.s.agentTasks.created_at }).from(this.s.agentTasks).where(inArray(this.s.agentTasks.session_id, rows.map((r) => r.id)));
    return rows.map((r) => {
      const mine = tasks.filter((t) => t.session_id === r.id).sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
      return { ...r, tasks: mine.length, last_status: mine[0]?.status ?? null };
    });
  }

  async getSession(p: Principal, id: string): Promise<AgentSession & { tasks: AgentTask[] }> {
    const s = (await this.db.select().from(this.s.agentSessions).where(eq(this.s.agentSessions.id, id)).limit(1))[0];
    if (!s || s.user_id !== p.userId) throw notFound('Agent session');
    this.guard(p, s.workspace_id);
    const tasks = await this.db.select().from(this.s.agentTasks).where(eq(this.s.agentTasks.session_id, id)).orderBy(this.s.agentTasks.created_at);
    return { ...s, tasks };
  }

  async updateSession(p: Principal, id: string, patch: { title?: string; archived?: boolean }): Promise<AgentSession> {
    const s = await this.getSession(p, id);
    const set = { ...(patch.title !== undefined ? { title: patch.title.trim().slice(0, 200) || s.title } : {}), ...(patch.archived !== undefined ? { archived: patch.archived } : {}), updated_at: new Date() };
    await this.db.update(this.s.agentSessions).set(set).where(eq(this.s.agentSessions.id, id));
    return { ...s, ...set };
  }

  async deleteSession(p: Principal, id: string): Promise<void> {
    const s = await this.getSession(p, id);
    for (const t of s.tasks) if (this.states.has(t.id)) this.states.get(t.id)!.controller.abort();
    await this.db.delete(this.s.agentSessions).where(eq(this.s.agentSessions.id, id));
  }

  async observations(p: Principal, sessionId: string, limit = 50) {
    await this.getSession(p, sessionId);
    return this.db.select().from(this.s.agentObservations).where(eq(this.s.agentObservations.session_id, sessionId)).orderBy(desc(this.s.agentObservations.created_at)).limit(limit);
  }

  // ------------------------------------------------------------------------------------------ tasks

  async getTask(p: Principal, id: string): Promise<AgentTask> {
    const t = (await this.db.select().from(this.s.agentTasks).where(eq(this.s.agentTasks.id, id)).limit(1))[0];
    if (!t || t.user_id !== p.userId) throw notFound('Agent task');
    return t;
  }

  /** Tasks of this person waiting for their approval (in one workspace, or all). */
  async pendingApprovals(p: Principal, workspaceId?: string | null): Promise<AgentTask[]> {
    const rows = await this.db.select().from(this.s.agentTasks).where(and(eq(this.s.agentTasks.user_id, p.userId), eq(this.s.agentTasks.status, 'waiting_approval')));
    return rows.filter((t) => !workspaceId || t.workspace_id === workspaceId);
  }

  /** Starts a task and returns it at once; the work goes on in the background (events, then the row). */
  async start(p: Principal, input: StartTaskInput): Promise<AgentTask> {
    if (!this.ctx.cfg.agent.enabled) throw forbidden('The DuckView agent is disabled on this server');
    requireScope(p, 'read');
    this.guard(p, input.workspaceId);
    const request = input.request.trim();
    if (!request) throw badRequest('request is required');
    if (request.length > 8000) throw badRequest('The request is too long (8,000 characters at most)');
    const access = await this.ctx.workspaces.get(p, input.workspaceId);
    const session = input.sessionId ? await this.getSession(p, input.sessionId) : await this.createSession(p, input.workspaceId, { title: request.slice(0, 80), via: input.via, page: input.page });
    if (session.workspace_id !== input.workspaceId) throw badRequest('The session belongs to another workspace');
    if ('tasks' in session && (session.tasks as AgentTask[]).some((t) => t.status === 'running' || t.status === 'planning' || t.status === 'waiting_approval')) throw badRequest('This session is still working on a task');
    // The model first: without one there is nothing to run (a clear error rather than a failed task).
    const model = await this.modelFactory(input.byok ?? null);
    const now = new Date();
    const task: AgentTask = { id: newId(), session_id: session.id, workspace_id: input.workspaceId, user_id: p.userId, request, mode: input.mode ?? 'auto', intent: null, status: 'planning', plan: [], steps: [], artifacts: [], actions: [], approval: null, answer: null, error: null, provider: model.provider, model: model.model, telemetry: emptyTelemetry(this.ctx.decision.name), trace_id: newId(), created_at: now, finished_at: null };
    await this.db.insert(this.s.agentTasks).values(task);
    await this.db.update(this.s.agentSessions).set({ updated_at: now, ...(input.page ? { page: input.page } : {}) }).where(eq(this.s.agentSessions.id, session.id));
    const principal: Principal = { ...p, actorType: 'AGENT', workspaceScope: input.workspaceId };
    // A workspace viewer reads only, whatever their account can do elsewhere: offer them reading tools.
    const readOnly = !canWrite(p) || access.role === 'VIEWER';
    const offered = new Map(toolRegistry(this.ctx.cfg).availableTo(readOnly ? { ...principal, scopes: principal.scopes.filter((s) => s !== 'write') } : principal).map((t) => [t.name, toolRegistry(this.ctx.cfg).descriptor(t.name)!]));
    offered.set(OPEN_IN_WORKSPACE.name, OPEN_IN_WORKSPACE);
    const state: TaskState = { task, principal, readOnly, model, classification: { intent: 'ask', confidence: 0, entities: [] }, messages: [], offered, used: [], failures: new Map(), observations: [], history: [], controller: new AbortController(), toolCalls: 0, started: performance.now(), pending: null };
    this.states.set(task.id, state);
    this.done.set(task.id, new Promise((resolve) => this.resolvers.set(task.id, resolve)));
    void this.begin(state, input).catch((err) => this.fail(state, err));
    return task;
  }

  /** The task's final row: waits while it runs (and while it waits for an approval). */
  async wait(p: Principal, taskId: string, timeoutMs?: number): Promise<AgentTask> {
    const t = await this.getTask(p, taskId);
    const pending = this.done.get(taskId);
    if (!pending) return t;
    if (!timeoutMs) return pending;
    return Promise.race([pending, new Promise<AgentTask>((resolve) => setTimeout(() => void this.getTask(p, taskId).then(resolve), timeoutMs).unref())]);
  }

  /** Starts a task and waits until it finishes or pauses for an approval. */
  async run(p: Principal, input: StartTaskInput, timeoutMs = 600_000): Promise<AgentTask> {
    const t = await this.start(p, input);
    return new Promise((resolve) => {
      let settled = false;
      const finish = async () => {
        if (settled) return;
        settled = true;
        off();
        clearTimeout(timer);
        resolve(await this.getTask(p, t.id));
      };
      const off = this.events.subscribe(t.id, (e) => {
        if (e.type === 'agent.completed' || e.type === 'agent.failed' || e.type === 'agent.cancelled' || e.type === 'agent.approval.required') void finish();
      });
      const timer = setTimeout(() => void finish(), timeoutMs);
      timer.unref();
    });
  }

  async cancel(p: Principal, taskId: string): Promise<AgentTask> {
    const t = await this.getTask(p, taskId);
    const state = this.states.get(taskId);
    if (!state) {
      if (t.status === 'waiting_approval' || t.status === 'running' || t.status === 'planning') return this.finish(null, t, { status: 'cancelled', error: 'Cancelled' });
      return t;
    }
    state.controller.abort();
    if (t.status === 'waiting_approval') return this.finish(state, state.task, { status: 'cancelled', error: 'Cancelled' });
    return t;
  }

  /**
   * The person's decision on a paused call. Only the person who asked, signed in to DuckView (not an API token or
   * an agent), and able to write, can approve: an agent can never approve its own change.
   */
  async decide(p: Principal, taskId: string, decision: 'approve' | 'deny', note?: string | null): Promise<AgentTask> {
    const t = await this.getTask(p, taskId);
    if (t.status !== 'waiting_approval' || !t.approval) throw badRequest('This task is not waiting for an approval');
    if (p.actorType !== 'USER' || p.via === 'token') throw forbidden('Approvals are given by the person, signed in to DuckView');
    if (decision === 'approve' && !canWrite(p)) throw forbidden('Your access is read-only: you cannot approve a change');
    const state = this.states.get(taskId);
    const approval: AgentApprovalRecord = { ...t.approval, decision: decision === 'approve' ? 'approved' : 'denied', decided_by: p.userId, decided_at: new Date().toISOString(), note: note?.slice(0, 500) ?? null };
    if (!state) {
      // The server restarted since the task paused: its conversation is gone, so the task ends here.
      return this.finish(null, { ...t, approval }, { status: 'failed', error: 'DuckView restarted while this task waited for approval. Ask again.' });
    }
    state.task.approval = approval;
    this.ctx.audit.log({ userId: p.userId, actorType: 'USER', action: `agent.approval.${approval.decision}`, resource: `agent_task:${taskId}`, queryText: `${approval.tool} ${approval.preview ?? ''}`.slice(0, 2000), ip: p.ip });
    this.emit(state, decision === 'approve' ? 'agent.approval.granted' : 'agent.approval.denied', { approval_id: approval.id, tool: approval.tool, note: approval.note });
    state.task.status = 'running';
    await this.save(state);
    void this.resume(state, decision).catch((err) => this.fail(state, err));
    return state.task;
  }

  // ------------------------------------------------------------------------------------------ the loop

  private async begin(state: TaskState, input: StartTaskInput): Promise<void> {
    const { task } = state;
    const span = tracer().startSpan('agent.task', { attributes: { 'duckview.task_id': task.id, 'duckview.workspace_id': task.workspace_id, 'duckview.trace_id': task.trace_id } });
    try {
      this.emit(state, 'agent.started', { request: task.request, mode: task.mode, via: input.via, provider: task.provider, model: task.model });
      const t0 = performance.now();
      const cls = await this.ctx.decision.classify({ request: task.request, page: input.page });
      const forced = MODE_INTENT[task.mode as AgentMode];
      state.classification = forced && INTENTS.includes(forced) ? { ...cls, intent: forced } : cls;
      task.intent = state.classification.intent;
      const route = await this.ctx.decision.route({ request: task.request, classification: state.classification, page: input.page });
      task.telemetry!.decision_ms += performance.now() - t0;
      this.step(state, { kind: 'route', status: 'ok', summary: `${state.classification.intent} request · ${route.reason}` });
      if (route.route === 'workspace_action' && route.action) {
        const r = await resolveAction(this.ctx, this.ctx.decision, state.principal, task.workspace_id, route.action);
        if (!('error' in r)) {
          this.addAction(state, r.action);
          this.step(state, { kind: 'action', status: 'ok', summary: r.message });
          task.plan = [{ text: 'Open it', status: 'done' }];
          await this.finish(state, task, { status: 'completed', answer: r.message });
          return;
        }
      }
      // Earlier tasks of the session: their requests and answers, and what they found.
      await this.loadHistory(state);
      task.plan = initialPlan(state.classification.intent);
      this.emit(state, 'agent.plan.created', { plan: task.plan });
      task.status = 'running';
      state.messages.push({ role: 'user', content: task.request });
      await this.save(state);
      await this.loop(state, input.page ?? null);
    } finally {
      span.end();
    }
  }

  private async resume(state: TaskState, decision: 'approve' | 'deny'): Promise<void> {
    const pending = state.pending;
    state.pending = null;
    if (pending && decision === 'approve') {
      // The same call, now with the person's approval.
      await this.callTool(state, pending.tool, { ...pending.arguments, dry_run: false }, { approved: true });
    } else if (pending) {
      state.messages.push({ role: 'user', content: `The person declined ${pending.tool}${state.task.approval?.note ? `: "${state.task.approval.note}"` : ''}. Do not try it another way; finish with what you have and say what was not done.` });
      this.step(state, { kind: 'approval', tool: pending.tool, status: 'denied', summary: `The person declined ${pending.tool}` });
    }
    await this.loop(state, null);
  }

  private async loop(state: TaskState, page: AgentPageRef | null): Promise<void> {
    const { task } = state;
    const cfg = this.ctx.cfg.agent;
    const budget = budgetFromConfig(this.ctx.cfg);
    let answer: string | null = null;
    let lastTools = '';
    for (let turn = 0; turn < cfg.max_steps * 2 + 4 && answer === null; turn++) {
      if (state.controller.signal.aborted) return void (await this.finish(state, task, { status: 'cancelled', error: 'Cancelled' }));
      // Context and tools for this step.
      const t0 = performance.now();
      const toolSel = await this.ctx.decision.selectTools({ request: task.request, tools: [...state.offered.values()], intent: state.classification.intent, max: budget.maxToolDefinitions, used: state.used });
      if (!toolSel.tools.some((t) => t.name === OPEN_IN_WORKSPACE.name)) toolSel.tools.push(OPEN_IN_WORKSPACE);
      const pack = await this.ctx.contextEngine.pack(state.principal, task.workspace_id, { request: task.request, intent: state.classification.intent, page, extra: [...state.observations, ...state.history], tools: toolSel.tools });
      task.telemetry!.decision_ms += performance.now() - t0;
      task.telemetry!.context_objects_considered = Math.max(task.telemetry!.context_objects_considered, pack.stats.considered);
      task.telemetry!.context_objects_selected = pack.stats.selected;
      task.telemetry!.context_tokens = pack.stats.tokens;
      if (turn === 0) {
        this.emit(state, 'agent.context.selected', { considered: pack.stats.considered, selected: pack.stats.selected, tokens: pack.stats.tokens, objects: pack.objects.map((o) => ({ type: o.type, title: o.title, relevance: o.relevance })), prefer_metrics: pack.semanticContext.preferMetrics, metrics: pack.semanticContext.matched });
        this.step(state, { kind: 'context', status: 'ok', summary: `Selected ${pack.stats.selected} of ${pack.stats.considered} things in the workspace${pack.semanticContext.matched.length ? ` (metric ${pack.semanticContext.matched.join(', ')})` : ''}` });
      }
      const names = toolSel.tools.map((t) => t.name).join(',');
      if (names !== lastTools) {
        lastTools = names;
        this.emit(state, 'agent.tool.selected', { tools: toolSel.tools.map((t) => t.name), considered: toolSel.considered });
      }
      const stepsLeft = Math.max(0, cfg.max_steps - state.toolCalls);
      const system = systemPrompt({ workspace: (await this.ctx.workspaces.get(state.principal, task.workspace_id)).name, user: state.principal.email, pack, tools: toolSel.tools, plan: task.plan, maxRows: budget.maxResultRows, canWrite: !state.readOnly, stepsLeft });

      // Reasoning.
      const r0 = performance.now();
      let text = '';
      let call: { name: string; arguments: Record<string, unknown> } | null = null;
      let invalid: string | null = null;
      task.telemetry!.llm_calls++;
      for await (const ev of state.model.generate({ system, messages: state.messages, tools: toolSel.tools, maxTokens: cfg.max_output_tokens, temperature: 0, signal: state.controller.signal, sessionId: task.session_id })) {
        if (ev.type === 'text') {
          text += ev.delta;
          this.emit(state, 'agent.answer.delta', { text: ev.delta });
        } else if (ev.type === 'plan') {
          task.plan = ev.steps.map((s, i) => ({ text: s, status: i === 0 ? 'active' : 'pending' }));
          this.emit(state, 'agent.plan.updated', { plan: task.plan });
        } else if (ev.type === 'tool_call') call = { name: ev.name, arguments: ev.arguments };
        else if (ev.type === 'invalid_call') invalid = ev.message;
        else if (ev.type === 'usage') {
          task.telemetry!.input_tokens += ev.inputTokens ?? 0;
          task.telemetry!.output_tokens += ev.outputTokens ?? 0;
        }
      }
      task.telemetry!.reasoning_ms += performance.now() - r0;
      if (state.controller.signal.aborted) return void (await this.finish(state, task, { status: 'cancelled', error: 'Cancelled' }));
      if (invalid) {
        if (text) this.emit(state, 'agent.answer.reset', {});
        state.messages.push({ role: 'assistant', content: text || '(an unreadable tool block)' }, { role: 'user', content: invalid });
        continue;
      }
      if (!call) {
        answer = text.trim();
        break;
      }
      if (text) this.emit(state, 'agent.answer.reset', {});
      state.messages.push({ role: 'assistant', content: `${text ? `${text}\n` : ''}\`\`\`tool\n${JSON.stringify({ name: call.name, arguments: call.arguments })}\n\`\`\`` });
      if (state.toolCalls >= cfg.max_steps) {
        state.messages.push({ role: 'user', content: 'You have used all your tool calls. Write the final answer now from what you have, with no tool block.' });
        continue;
      }
      const paused = await this.callTool(state, call.name, call.arguments);
      if (paused) return;
    }
    task.plan = task.plan.map((s) => ({ ...s, status: s.status === 'pending' || s.status === 'active' ? 'done' : s.status }));
    this.step(state, { kind: 'answer', status: 'ok', summary: 'Answered' });
    await this.finish(state, task, { status: 'completed', answer: answer || '(The agent did not write an answer.)' });
  }

  /** Runs one tool call; returns true when the task paused for an approval. */
  private async callTool(state: TaskState, name: string, rawArgs: Record<string, unknown>, opts: { approved?: boolean } = {}): Promise<boolean> {
    const { task } = state;
    const cfg = this.ctx.cfg.agent;
    const budget = budgetFromConfig(this.ctx.cfg);
    state.toolCalls++;
    // A workspace action.
    if (name === OPEN_IN_WORKSPACE.name) {
      const r = await resolveAction(this.ctx, this.ctx.decision, state.principal, task.workspace_id, { action: String(rawArgs.action ?? ''), target: typeof rawArgs.target === 'string' ? rawArgs.target : null, args: rawArgs });
      if ('error' in r) {
        this.step(state, { kind: 'action', tool: name, arguments: rawArgs, status: 'error', summary: r.error });
        state.messages.push({ role: 'user', content: `Result of open_in_workspace:\nERROR: ${r.error}` });
      } else {
        this.addAction(state, r.action);
        this.step(state, { kind: 'action', tool: name, arguments: rawArgs, status: 'ok', summary: r.message });
        state.messages.push({ role: 'user', content: `Result of open_in_workspace: ${r.message}` });
      }
      return false;
    }
    const descriptor = state.offered.get(name);
    const tool = descriptor ? toolRegistry(this.ctx.cfg).get(name) : undefined;
    if (!tool || !descriptor) {
      state.messages.push({ role: 'user', content: `ERROR: ${name} is not one of your tools. Use one of: ${[...state.offered.keys()].slice(0, 40).join(', ')}.` });
      this.step(state, { kind: 'tool', tool: name, status: 'error', summary: `${name} is not available` });
      return false;
    }
    const failures = state.failures.get(name) ?? 0;
    if (failures > cfg.max_retries) {
      state.messages.push({ role: 'user', content: `${name} has failed ${failures} times: do not call it again. Take another way or answer with what you have.` });
      this.step(state, { kind: 'tool', tool: name, status: 'skipped', summary: `${name} failed too often; not retried` });
      return false;
    }
    // The workspace is the session's, whatever the model wrote.
    const { workspace_id: _ignored, ...args } = rawArgs;
    if ('workspace_id' in tool.inputSchema) args.workspace_id = task.workspace_id;
    const env: ToolEnv = { ctx: this.ctx, principal: state.principal, defaultWorkspaceId: task.workspace_id, via: 'rest', agent: null };
    this.emit(state, 'agent.tool.started', { tool: name, title: tool.title, action_class: descriptor.semantics.action, arguments: shorten(args), retry: failures });
    const t0 = performance.now();
    const result = await runTool(env, tool, args);
    const ms = Math.round(performance.now() - t0);
    task.telemetry!.tool_ms += ms;
    task.telemetry!.tool_calls++;
    if (!state.used.includes(name)) state.used.push(name);
    const sc = (result.structuredContent ?? {}) as { status?: string; reason?: string; statements?: { preview?: string; verb?: string }[]; mutating_verbs?: string[] };
    if (sc.status === 'approval_required' && !opts.approved) {
      const approval: AgentApprovalRecord = { id: newId(), tool: name, arguments: args, action_class: descriptor.semantics.action, reason: String(sc.reason ?? 'This change needs your approval.'), verb: sc.mutating_verbs?.join(', ') || sc.statements?.[0]?.verb || null, preview: sc.statements?.map((s) => s.preview).filter(Boolean).join('\n').slice(0, 4000) || null, requested_at: new Date().toISOString() };
      state.pending = { tool: name, arguments: args };
      task.approval = approval;
      task.status = 'waiting_approval';
      this.step(state, { kind: 'approval', tool: name, arguments: shorten(args), status: 'approval_required', summary: approval.reason, duration_ms: ms });
      await this.save(state);
      this.emit(state, 'agent.approval.required', { approval_id: approval.id, tool: name, title: tool.title, action_class: approval.action_class, reason: approval.reason, verb: approval.verb, preview: approval.preview });
      return true;
    }
    const resultText = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n') || JSON.stringify(result.structuredContent ?? {});
    if (result.isError) {
      state.failures.set(name, failures + 1);
      task.telemetry!.tool_failures++;
      this.emit(state, 'agent.tool.failed', { tool: name, error: resultText.slice(0, 500), retry: failures, duration_ms: ms });
      this.step(state, { kind: 'tool', tool: name, arguments: shorten(args), status: 'error', summary: resultText.split('\n')[0]!.slice(0, 240), duration_ms: ms, retry: failures });
    } else {
      this.emit(state, 'agent.tool.completed', { tool: name, title: tool.title, summary: resultText.split('\n').find((l) => l.trim())?.slice(0, 240) ?? '', duration_ms: ms, approved: !!opts.approved });
      this.step(state, { kind: 'tool', tool: name, arguments: shorten(args), status: 'ok', summary: summarizeResult(name, result, resultText), duration_ms: ms });
      this.advancePlan(state);
    }
    // What the call taught, and what it made.
    for (const o of observe(name, args, result)) {
      const row = { id: newId(), task_id: task.id, session_id: task.session_id, workspace_id: task.workspace_id, user_id: task.user_id, kind: o.kind, subject: o.subject, text: o.text.slice(0, 2000), data: o.data, tool: name, created_at: new Date() };
      await this.db.insert(this.s.agentObservations).values(row);
      state.observations.push({ id: `observation:${row.id}`, type: 'observation', workspaceId: task.workspace_id, source: 'task', title: o.subject ?? name, text: o.text, content: o.data, metadata: { boost: 1.2, kind: o.kind }, timestamp: row.created_at.toISOString() });
      this.emit(state, 'agent.observation.created', { kind: o.kind, subject: o.subject, text: o.text.slice(0, 300), tool: name });
    }
    const made = artifactsOf(name, args, result, budget.maxResultRows);
    for (const a of made) {
      task.artifacts = [...task.artifacts, a];
      this.emit(state, 'agent.artifact.created', { artifact: a });
    }
    if (descriptor.semantics.mutation !== 'none' && !result.isError) {
      this.ctx.contextEngine.invalidate(task.workspace_id);
      if (made.some((a) => a.href)) this.emit(state, 'agent.workspace.changed', { reason: 'created', artifacts: made.filter((a) => a.href).map((a) => ({ type: a.type, title: a.title, href: a.href })) });
    }
    const hint = result.isError ? `\n\nThe call failed. Fix it and try again (attempt ${failures + 1} of ${cfg.max_retries + 1}), or take another way.` : '';
    state.messages.push({ role: 'user', content: `Result of ${name}:\n${resultText.length > MAX_RESULT_CHARS ? `${resultText.slice(0, MAX_RESULT_CHARS)}\n… (cut; ask for less)` : resultText}${hint}` });
    await this.save(state);
    return false;
  }

  // ------------------------------------------------------------------------------------------ helpers

  private async loadHistory(state: TaskState): Promise<void> {
    const { task } = state;
    const earlier = (await this.db.select().from(this.s.agentTasks).where(eq(this.s.agentTasks.session_id, task.session_id)).orderBy(desc(this.s.agentTasks.created_at)).limit(HISTORY_TASKS + 1)).filter((t) => t.id !== task.id && t.answer).reverse();
    for (const t of earlier) state.messages.push({ role: 'user', content: t.request }, { role: 'assistant', content: t.answer! });
    const obs = await this.db.select().from(this.s.agentObservations).where(eq(this.s.agentObservations.session_id, task.session_id)).orderBy(desc(this.s.agentObservations.created_at)).limit(40);
    state.history = obs.map((o) => ({ id: `observation:${o.id}`, type: 'observation', workspaceId: o.workspace_id, source: 'session', title: o.subject ?? o.tool ?? o.kind, text: o.text, content: o.data, metadata: { kind: o.kind }, timestamp: o.created_at.toISOString() }));
  }

  private advancePlan(state: TaskState): void {
    const plan = state.task.plan;
    const i = plan.findIndex((s) => s.status === 'active');
    if (i < 0 || i >= plan.length - 1) return;
    plan[i] = { ...plan[i]!, status: 'done' };
    plan[i + 1] = { ...plan[i + 1]!, status: 'active' };
    this.emit(state, 'agent.plan.updated', { plan });
  }

  private addAction(state: TaskState, a: AgentWorkspaceAction): void {
    state.task.actions = [...state.task.actions, a];
    this.emit(state, 'agent.workspace.changed', { reason: 'action', action: a });
  }

  private step(state: TaskState, s: Omit<AgentStepRecord, 'n' | 'at'>): void {
    state.task.steps = [...state.task.steps, { ...s, n: state.task.steps.length + 1, at: new Date().toISOString() }];
  }

  private emit(state: Pick<TaskState, 'task'>, type: AgentEventType, data: Record<string, unknown>): void {
    const t = state.task;
    this.events.emit({ type, taskId: t.id, sessionId: t.session_id, workspaceId: t.workspace_id, userId: t.user_id, traceId: t.trace_id, data });
  }

  private async save(state: TaskState): Promise<void> {
    const t = state.task;
    t.telemetry!.duration_ms = Math.round(performance.now() - state.started);
    await this.db.update(this.s.agentTasks).set({ status: t.status, intent: t.intent, plan: t.plan, steps: t.steps, artifacts: t.artifacts, actions: t.actions, approval: t.approval, telemetry: t.telemetry }).where(eq(this.s.agentTasks.id, t.id));
  }

  private async finish(state: TaskState | null, task: AgentTask, end: { status: 'completed' | 'failed' | 'cancelled'; answer?: string; error?: string }): Promise<AgentTask> {
    const t: AgentTask = { ...task, status: end.status, answer: end.answer ?? task.answer, error: end.error ?? null, finished_at: new Date() };
    if (state) {
      t.telemetry = { ...t.telemetry!, duration_ms: Math.round(performance.now() - state.started), decision_ms: Math.round(t.telemetry!.decision_ms), reasoning_ms: Math.round(t.telemetry!.reasoning_ms) };
      state.task = t;
    }
    await this.db.update(this.s.agentTasks).set({ status: t.status, intent: t.intent, plan: t.plan, steps: t.steps, artifacts: t.artifacts, actions: t.actions, approval: t.approval, answer: t.answer, error: t.error, telemetry: t.telemetry, finished_at: t.finished_at }).where(eq(this.s.agentTasks.id, t.id));
    const type: AgentEventType = end.status === 'completed' ? 'agent.completed' : end.status === 'cancelled' ? 'agent.cancelled' : 'agent.failed';
    this.emit({ task: t }, type, { status: t.status, answer: t.answer, error: t.error, artifacts: t.artifacts.map((a) => ({ id: a.id, type: a.type, title: a.title, href: a.href })), actions: t.actions, telemetry: t.telemetry });
    this.ctx.audit.log({ userId: t.user_id, actorType: 'AGENT', action: 'agent.task', resource: `agent_task:${t.id}`, queryText: t.request.slice(0, 2000), durationMs: t.telemetry?.duration_ms ?? null, ip: 'agent', status: t.status === 'completed' ? 'ok' : 'error', error: t.error ?? undefined });
    this.states.delete(t.id);
    this.resolvers.get(t.id)?.(t);
    this.resolvers.delete(t.id);
    setTimeout(() => this.done.delete(t.id), 60_000).unref();
    return t;
  }

  private async fail(state: TaskState, err: unknown): Promise<void> {
    const message = ((err as Error).message ?? String(err)).slice(0, 1000);
    logger().warn({ task: state.task.id, err: message }, 'Agent task failed');
    await this.finish(state, state.task, { status: state.controller.signal.aborted ? 'cancelled' : 'failed', error: state.controller.signal.aborted ? 'Cancelled' : message }).catch(() => undefined);
  }

  /** A token bound to one workspace works in that workspace only. */
  private guard(p: Principal, workspaceId: string): void {
    if (p.workspaceScope && p.workspaceScope !== workspaceId) throw forbidden('Token is scoped to a different workspace');
  }
}

function shorten(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (k === 'workspace_id') continue;
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    out[k] = s && s.length > 600 ? `${s.slice(0, 600)}…` : v;
  }
  return out;
}

function summarizeResult(tool: string, result: { structuredContent?: Record<string, unknown> }, text: string): string {
  const sc = (result.structuredContent ?? {}) as { rows?: unknown[]; columns?: { name: string }[]; row_count?: number };
  if (Array.isArray(sc.rows) && Array.isArray(sc.columns)) {
    const n = sc.row_count ?? sc.rows.length;
    return `${n.toLocaleString('en')} row${n === 1 ? '' : 's'}: ${sc.columns.map((c) => c.name).join(', ')}`.slice(0, 240);
  }
  return (text.split('\n').find((l) => l.trim() && !/^(\||```)/.test(l.trim())) ?? tool).slice(0, 240);
}
