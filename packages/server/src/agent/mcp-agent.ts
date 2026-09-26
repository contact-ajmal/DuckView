/**
 * The Agent MCP server (/mcp/agent): DuckView's agent for any MCP client — Claude, Cursor, Claude Code, another
 * agent. Where /mcp exposes the low-level tools (execute_query, inspect_schema…), this exposes whole tasks: the
 * client asks, DuckView's agent selects context and tools, works in the workspace, and returns an answer with
 * artifacts, workspace actions and observations.
 *
 * Nothing is duplicated: each tool starts a task on the AgentRuntime, which uses the same registry, services and
 * security as everything else. The caller's token decides who the agent is (its scopes, its workspace binding);
 * changes that need approval pause the task until the person approves it in DuckView — a client cannot approve.
 *
 * Stateful: pass session_id to continue a session (earlier requests, answers and findings are reused), and the
 * task's progress arrives as MCP progress notifications when the client sends a progressToken.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import type { Principal } from '../services/principal.js';
import type { AgentTask } from '../db/schema/sqlite.js';
import { HttpError } from '../services/errors.js';
import type { AgentEvent } from './events.js';
import type { AgentMode, StartTaskInput } from './runtime/runtime.js';

export const AGENT_MCP_INFO = { name: 'duckview-agent', version: '1.2.0' } as const;

/** The high-level tools, for Settings → Agents and the docs. */
export const AGENT_MCP_TOOLS = [
  { name: 'ask_data_agent', title: 'Ask the data agent', description: 'Ask DuckView\'s agent anything about a workspace: it finds the data and metrics, runs what it needs and answers, with the artifacts it made.' },
  { name: 'analyse_dataset', title: 'Analyse a dataset', description: 'Understand a table or file: its shape, distributions, quality and what stands out.' },
  { name: 'investigate_data', title: 'Investigate a change', description: 'Why did a number move? Finds the metric, compares periods and breaks the change down.' },
  { name: 'build_dashboard', title: 'Build a dashboard', description: 'Builds a dashboard in the workspace for a goal, from checked queries and defined metrics.' },
  { name: 'create_data_app', title: 'Create a data app', description: 'Builds a small data app in the workspace for a goal.' },
  { name: 'explain_data', title: 'Explain', description: 'Explains a table, a metric, a dashboard or a query in plain language.' },
  { name: 'create_analysis', title: 'Create an analysis', description: 'Analyses chosen datasets for a question and returns charts, tables and findings.' },
  { name: 'start_mission', title: 'Start a mission', description: 'Starts a mission: an intent (analyse, build, investigate, automate, explore, explain), the datasets to work on, and a request. Returns at once; follow it with get_mission.' },
  { name: 'get_mission', title: 'Get a mission', description: 'A mission\'s status, progress, plan, findings and artifacts; can wait for it to finish.' },
  { name: 'resume_mission', title: 'Resume a mission', description: 'Continues a mission with a new request, or carries on from where it stopped.' },
  { name: 'get_agent_task', title: 'Get an agent task', description: 'A task\'s status, answer and artifacts — for tasks that wait for a person\'s approval.' },
  { name: 'list_agent_sessions', title: 'List agent sessions', description: 'Your agent sessions in a workspace, newest first.' },
] as const;

/** A task as MCP clients receive it: stable, structured, without internals. */
export function taskContract(t: AgentTask, publicUrl: string | null) {
  return {
    taskId: t.id,
    sessionId: t.session_id,
    workspaceId: t.workspace_id,
    status: t.status,
    answer: t.answer,
    error: t.error,
    plan: t.plan.map((s) => ({ step: s.text, status: s.status })),
    steps: t.steps.filter((s) => s.kind === 'tool' || s.kind === 'action' || s.kind === 'approval').map((s) => ({ tool: s.tool ?? null, status: s.status, summary: s.summary })),
    artifacts: t.artifacts.map((a) => ({ id: a.id, type: a.type, title: a.title, url: a.href && publicUrl ? `${publicUrl}/${a.href}` : a.href ?? null, data: a.type === 'table' ? { columns: (a.data?.columns as { name: string }[] | undefined)?.map((c) => c.name) ?? [], rows: a.data?.rows ?? [], row_count: a.data?.row_count ?? null, sql: a.data?.sql ?? null } : a.data ?? null })),
    actions: t.actions.map((a) => ({ action: a.action, target: a.target ?? null, url: a.href && publicUrl ? `${publicUrl}/${a.href}` : a.href ?? null })),
    approval: t.status === 'waiting_approval' && t.approval ? { tool: t.approval.tool, reason: t.approval.reason, preview: t.approval.preview, approveIn: publicUrl ? `${publicUrl}/#/?agent_task=${t.id}` : `#/?agent_task=${t.id}` } : null,
    telemetry: t.telemetry ? { toolCalls: t.telemetry.tool_calls, durationMs: t.telemetry.duration_ms, inputTokens: t.telemetry.input_tokens, outputTokens: t.telemetry.output_tokens } : null,
  };
}

function render(c: ReturnType<typeof taskContract>): string {
  const lines: string[] = [];
  if (c.status === 'waiting_approval' && c.approval) lines.push(`WAITING FOR APPROVAL: ${c.approval.reason}${c.approval.preview ? `\n\n\`\`\`\n${c.approval.preview}\n\`\`\`` : ''}\n\nA person must approve this in DuckView (${c.approval.approveIn}). Then call get_agent_task with taskId ${c.taskId}.`);
  if (c.answer) lines.push(c.answer);
  if (c.status === 'failed' || c.status === 'cancelled') lines.push(`The task ${c.status}${c.error ? `: ${c.error}` : ''}.`);
  if (c.artifacts.length) lines.push(`Artifacts:\n${c.artifacts.map((a) => `- ${a.type}: ${a.title}${a.url ? ` (${a.url})` : ''}`).join('\n')}`);
  lines.push(`(task ${c.taskId}, session ${c.sessionId} — pass session_id to continue)`);
  return lines.join('\n\n');
}

const SENTENCE: Partial<Record<AgentEvent['type'], (d: Record<string, unknown>) => string>> = {
  'agent.plan.created': (d) => `Plan: ${((d.plan as { text: string }[]) ?? []).map((s) => s.text).join(' → ')}`,
  'agent.context.selected': (d) => `Selected ${d.selected} of ${d.considered} things in the workspace`,
  'agent.tool.started': (d) => `Running ${d.title ?? d.tool}`,
  'agent.tool.completed': (d) => `${d.title ?? d.tool}: ${d.summary ?? 'done'}`,
  'agent.tool.failed': (d) => `${d.tool} failed; trying another way`,
  'agent.approval.required': (d) => `Waiting for approval: ${d.reason}`,
  'agent.artifact.created': (d) => `Made ${(d.artifact as { type: string; title: string }).type} ${(d.artifact as { title: string }).title}`,
};

export function buildAgentMcpServer(ctx: AppContext, principal: Principal, opts: { defaultWorkspaceId?: string | null } = {}): McpServer {
  const server = new McpServer(AGENT_MCP_INFO, {
    instructions: [
      'DuckView\'s data agent. Each tool runs a task in a DuckView workspace as you (your token\'s access): the agent picks the data, metrics and tools, and returns an answer with artifacts (tables, SQL, dashboards…), workspace actions and a status.',
      'Pass session_id from a previous result to continue that session. Changes that need approval pause the task (status waiting_approval): a person approves in DuckView, then get_agent_task returns the result.',
      'For low-level tools (SQL, schemas, files), connect to /mcp instead.',
    ].join(' '),
  });
  const publicUrl = ctx.cfg.server.public_url?.replace(/\/+$/, '') ?? null;
  const workspace = (id?: string | null) => {
    const ws = id || opts.defaultWorkspaceId || principal.workspaceScope;
    if (!ws) throw new HttpError(400, 'workspace_id is required (no default workspace for this connection)', 'BAD_REQUEST');
    return ws;
  };

  type Extra = { _meta?: { progressToken?: string | number }; sendNotification: (n: { method: 'notifications/progress'; params: { progressToken: string | number; progress: number; message?: string } }) => Promise<void>; signal?: AbortSignal };
  const runTask = async (input: Omit<StartTaskInput, 'via'>, extra: Extra) => waitFor((await ctx.agentRuntime.start(principal, { ...input, via: 'mcp' })).id, extra);
  const waitFor = async (taskId: string, extra: Extra) => {
    const rt = ctx.agentRuntime;
    const started = { id: taskId };
    const token = extra._meta?.progressToken;
    let n = 0;
    const final = await new Promise<AgentTask>((resolve) => {
      const off = rt.events.subscribe(started.id, (e) => {
        const say = SENTENCE[e.type];
        if (token !== undefined && say) void extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: ++n, message: say(e.data).slice(0, 300) } }).catch(() => undefined);
        if (e.type === 'agent.completed' || e.type === 'agent.failed' || e.type === 'agent.cancelled' || e.type === 'agent.approval.required') {
          off();
          void rt.getTask(principal, started.id).then(resolve);
        }
      });
      extra.signal?.addEventListener('abort', () => void rt.cancel(principal, started.id).catch(() => undefined));
    });
    const c = taskContract(final, publicUrl);
    return { content: [{ type: 'text' as const, text: render(c) }], structuredContent: c as unknown as Record<string, unknown>, isError: final.status === 'failed' };
  };
  const fail = (err: unknown) => ({ content: [{ type: 'text' as const, text: `ERROR: ${(err as Error).message}` }], isError: true });
  const common = { workspace_id: z.string().optional().describe('The workspace (optional when the connection has a default)'), session_id: z.string().optional().describe('Continue this session') };
  const task = (build: (a: Record<string, unknown>) => { request: string; mode: AgentMode }) => async (a: Record<string, unknown>, extra: Extra) => {
    try {
      const { request, mode } = build(a);
      return await runTask({ workspaceId: workspace(a.workspace_id as string | undefined), sessionId: (a.session_id as string | undefined) ?? null, request, mode, page: null }, extra);
    } catch (err) {
      return fail(err);
    }
  };
  const meta = (name: string) => AGENT_MCP_TOOLS.find((t) => t.name === name)!;
  const annotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

  server.registerTool('ask_data_agent', { title: meta('ask_data_agent').title, description: meta('ask_data_agent').description, inputSchema: { request: z.string().min(1).max(8000), mode: z.enum(['auto', 'analysis', 'investigate', 'build', 'explain']).optional(), ...common }, annotations }, task((a) => ({ request: String(a.request), mode: (a.mode as AgentMode) ?? 'auto' })) as never);
  server.registerTool('analyse_dataset', { title: meta('analyse_dataset').title, description: meta('analyse_dataset').description, inputSchema: { dataset: z.string().min(1), question: z.string().max(2000).optional(), ...common }, annotations }, task((a) => ({ request: `Analyse ${a.dataset}${a.question ? `: ${a.question}` : ': its shape, distributions, quality and what stands out'}`, mode: 'analysis' })) as never);
  server.registerTool('investigate_data', { title: meta('investigate_data').title, description: meta('investigate_data').description, inputSchema: { question: z.string().min(1).max(4000), ...common }, annotations }, task((a) => ({ request: String(a.question), mode: 'investigate' })) as never);
  server.registerTool('build_dashboard', { title: meta('build_dashboard').title, description: meta('build_dashboard').description, inputSchema: { goal: z.string().min(1).max(4000), ...common }, annotations }, task((a) => ({ request: `Build a dashboard: ${a.goal}`, mode: 'build' })) as never);
  server.registerTool('create_data_app', { title: meta('create_data_app').title, description: meta('create_data_app').description, inputSchema: { goal: z.string().min(1).max(4000), ...common }, annotations }, task((a) => ({ request: `Build a data app: ${a.goal}`, mode: 'build' })) as never);
  server.registerTool('explain_data', { title: meta('explain_data').title, description: meta('explain_data').description, inputSchema: { subject: z.string().min(1).max(4000), ...common }, annotations: { ...annotations, readOnlyHint: true } }, task((a) => ({ request: `Explain ${a.subject}`, mode: 'explain' })) as never);
  const MissionMode = z.enum(['auto', 'analyse', 'build', 'investigate', 'automate', 'explore', 'explain']).optional();
  const Datasets = z.array(z.string().min(1)).max(50).optional().describe('Tables, views or files to work on (the agent may find others)');
  const missionContract = (mm: Awaited<ReturnType<typeof ctx.agentRuntime.missions.get>>) => ({
    missionId: mm.id, title: mm.title, status: mm.status, progress: mm.progress, activity: mm.activity, mode: mm.mode, workspaceId: mm.workspace_id,
    context: mm.context,
    findings: mm.tasks.flatMap((t) => t.artifacts.filter((a) => a.type === 'finding').flatMap((a) => (a.data?.items as string[] | undefined) ?? [])),
    tasks: mm.tasks.map((t) => taskContract(t, publicUrl)),
  });
  const renderMission = (c: ReturnType<typeof missionContract>) => `${c.title} — ${c.status} (${c.progress}%)${c.activity ? `: ${c.activity}` : ''}${c.findings.length ? `\n\nFindings:\n${c.findings.map((f) => `- ${f}`).join('\n')}` : ''}\n\n(mission ${c.missionId})`;
  server.registerTool('create_analysis', { title: meta('create_analysis').title, description: meta('create_analysis').description, inputSchema: { question: z.string().min(1).max(4000), datasets: Datasets, workspace_id: common.workspace_id }, annotations: { ...annotations, readOnlyHint: true } }, (async (a: { question: string; datasets?: string[]; workspace_id?: string }, extra: Extra) => {
    try {
      const ws = workspace(a.workspace_id);
      const { mission } = await ctx.agentRuntime.missions.start(principal, { workspaceId: ws, request: a.question, mode: 'analyse', datasets: a.datasets, via: 'mcp' });
      const task = mission.tasks.at(-1)!;
      return await waitFor(task.id, extra);
    } catch (err) {
      return fail(err);
    }
  }) as never);
  server.registerTool('start_mission', { title: meta('start_mission').title, description: meta('start_mission').description, inputSchema: { request: z.string().min(1).max(8000), mode: MissionMode, datasets: Datasets, title: z.string().max(200).optional(), workspace_id: common.workspace_id }, annotations }, (async (a: { request: string; mode?: AgentMode; datasets?: string[]; title?: string; workspace_id?: string }) => {
    try {
      const { mission } = await ctx.agentRuntime.missions.start(principal, { workspaceId: workspace(a.workspace_id), request: a.request, mode: a.mode, datasets: a.datasets, title: a.title, via: 'mcp' });
      const c = missionContract(mission);
      return { content: [{ type: 'text' as const, text: renderMission(c) }], structuredContent: c as unknown as Record<string, unknown> };
    } catch (err) {
      return fail(err);
    }
  }) as never);
  server.registerTool('get_mission', { title: meta('get_mission').title, description: meta('get_mission').description, inputSchema: { mission_id: z.string().min(1), wait_seconds: z.number().int().min(0).max(600).optional() }, annotations: { readOnlyHint: true } }, (async (a: { mission_id: string; wait_seconds?: number }) => {
    try {
      let mission = await ctx.agentRuntime.missions.get(principal, a.mission_id);
      const last = mission.tasks.at(-1);
      if (a.wait_seconds && last && (last.status === 'running' || last.status === 'planning')) {
        await ctx.agentRuntime.wait(principal, last.id, a.wait_seconds * 1000).catch(() => undefined);
        mission = await ctx.agentRuntime.missions.get(principal, a.mission_id);
      }
      const c = missionContract(mission);
      return { content: [{ type: 'text' as const, text: renderMission(c) }], structuredContent: c as unknown as Record<string, unknown> };
    } catch (err) {
      return fail(err);
    }
  }) as never);
  server.registerTool('resume_mission', { title: meta('resume_mission').title, description: meta('resume_mission').description, inputSchema: { mission_id: z.string().min(1), request: z.string().max(8000).optional() }, annotations }, (async (a: { mission_id: string; request?: string }, extra: Extra) => {
    try {
      const { task } = await ctx.agentRuntime.missions.resume(principal, a.mission_id, { request: a.request ?? null, via: 'mcp' });
      return await waitFor(task.id, extra);
    } catch (err) {
      return fail(err);
    }
  }) as never);

  server.registerTool('get_agent_task', { title: meta('get_agent_task').title, description: meta('get_agent_task').description, inputSchema: { task_id: z.string().min(1), wait_seconds: z.number().int().min(0).max(600).optional().describe('Wait this long for it to finish') }, annotations: { readOnlyHint: true } }, (async (a: { task_id: string; wait_seconds?: number }) => {
    try {
      const t = a.wait_seconds ? await ctx.agentRuntime.wait(principal, a.task_id, a.wait_seconds * 1000) : await ctx.agentRuntime.getTask(principal, a.task_id);
      const c = taskContract(t, publicUrl);
      return { content: [{ type: 'text' as const, text: render(c) }], structuredContent: c as unknown as Record<string, unknown> };
    } catch (err) {
      return fail(err);
    }
  }) as never);
  server.registerTool('list_agent_sessions', { title: meta('list_agent_sessions').title, description: meta('list_agent_sessions').description, inputSchema: { workspace_id: common.workspace_id }, annotations: { readOnlyHint: true } }, (async (a: { workspace_id?: string }) => {
    try {
      const sessions = await ctx.agentRuntime.listSessions(principal, workspace(a.workspace_id));
      const list = sessions.map((s) => ({ sessionId: s.id, title: s.title, tasks: s.tasks, lastStatus: s.last_status, updatedAt: s.updated_at.toISOString() }));
      return { content: [{ type: 'text' as const, text: list.map((s) => `- ${s.title} (${s.sessionId}, ${s.tasks} tasks, ${s.lastStatus ?? 'empty'})`).join('\n') || '(no sessions yet)' }], structuredContent: { sessions: list } };
    } catch (err) {
      return fail(err);
    }
  }) as never);
  return server;
}
