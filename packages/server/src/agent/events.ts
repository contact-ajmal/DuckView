/**
 * The canonical agent event stream. Every event names its task, session, workspace and trace, and says what
 * happened — a decision, a call, an observation, a result — never the model's hidden reasoning.
 *
 * AgentEventBus publishes each event on the existing live bus (so WS /api/ws/events carries it to workspace members)
 * and to the task's own subscribers (the SSE stream of a task, the Agent MCP server waiting on a result). Events of
 * running tasks are kept in memory for late subscribers; the durable record is the task row.
 */
import { liveEvents } from '../observability/events.js';

export const AGENT_EVENT_TYPES = [
  'agent.started',
  'agent.plan.created',
  'agent.plan.updated',
  'agent.context.selected',
  'agent.tool.selected',
  'agent.tool.started',
  'agent.tool.completed',
  'agent.tool.failed',
  'agent.observation.created',
  'agent.dataset.discovered',
  'agent.approval.required',
  'agent.approval.granted',
  'agent.approval.denied',
  'agent.workspace.changed',
  'agent.artifact.created',
  'agent.answer.delta',
  'agent.answer.reset',
  'agent.completed',
  'agent.failed',
  'agent.cancelled',
] as const;
export type AgentEventType = (typeof AGENT_EVENT_TYPES)[number];

export interface AgentEvent {
  type: AgentEventType;
  /** Position in the task's stream, from 1. */
  seq: number;
  at: string;
  taskId: string;
  sessionId: string;
  workspaceId: string;
  userId: string;
  traceId: string;
  data: Record<string, unknown>;
}

/** Events that end a task's stream. */
export const TERMINAL: ReadonlySet<AgentEventType> = new Set(['agent.completed', 'agent.failed', 'agent.cancelled']);

type Listener = (e: AgentEvent) => void;

export class AgentEventBus {
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly backlog = new Map<string, AgentEvent[]>();
  private readonly seqs = new Map<string, number>();

  emit(base: Omit<AgentEvent, 'seq' | 'at'>): AgentEvent {
    const seq = (this.seqs.get(base.taskId) ?? 0) + 1;
    this.seqs.set(base.taskId, seq);
    const e: AgentEvent = { ...base, seq, at: new Date().toISOString() };
    const log = this.backlog.get(e.taskId) ?? [];
    log.push(e);
    this.backlog.set(e.taskId, log);
    for (const fn of this.listeners.get(e.taskId) ?? []) fn(e);
    // Answer deltas stay on the task stream; the workspace feed gets the milestones.
    if (e.type !== 'agent.answer.delta') liveEvents.publish({ type: 'agent', at: e.at, workspace_id: e.workspaceId, user_id: e.userId, task_id: e.taskId, session_id: e.sessionId, event: e.type, data: compact(e.data) });
    if (TERMINAL.has(e.type)) {
      // Late subscribers still get the whole stream for a minute; then the task row is the record.
      setTimeout(() => {
        this.backlog.delete(e.taskId);
        this.seqs.delete(e.taskId);
      }, 60_000).unref();
    }
    return e;
  }

  /** Subscribes to a task: replays what happened so far (after `afterSeq`), then streams. */
  subscribe(taskId: string, fn: Listener, afterSeq = 0): () => void {
    for (const e of this.backlog.get(taskId) ?? []) if (e.seq > afterSeq) fn(e);
    const set = this.listeners.get(taskId) ?? new Set<Listener>();
    set.add(fn);
    this.listeners.set(taskId, set);
    return () => {
      set.delete(fn);
      if (!set.size) this.listeners.delete(taskId);
    };
  }

  /** Events seen so far for a running (or just finished) task. */
  history(taskId: string): AgentEvent[] {
    return [...(this.backlog.get(taskId) ?? [])];
  }
}

/** Keeps the live feed light: long strings cut, rows and big payloads left to the task stream. */
function compact(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (k === 'rows' || k === 'result') continue;
    if (typeof v === 'string') out[k] = v.length > 300 ? `${v.slice(0, 300)}…` : v;
    else if (v && typeof v === 'object') {
      const s = JSON.stringify(v);
      out[k] = s.length > 1000 ? '(details on the task)' : v;
    } else out[k] = v;
  }
  return out;
}
