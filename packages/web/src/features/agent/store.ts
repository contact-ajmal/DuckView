/**
 * The agent in the UI: the open session, its tasks as they run (from the task's event stream), the workspace moves
 * the agent makes (performed here), and the context it will be given. One session at a time; history restores older
 * ones.
 */
import { create } from 'zustand';
import { usePageContext } from '../../store/context';
import { useWorkspace } from '../../store/workspace';
import { useCopilot } from '../../store/copilot';
import { errorText, toast } from '../../components/ui';
import { agentApi, taskEvents, type AgentSession, type AgentTask, type Artifact, type WorkspaceAction } from './api';

export interface LiveTool { tool: string; title?: string; arguments?: Record<string, unknown>; action_class?: string }
export interface ContextSummary { considered: number; selected: number; objects: { type: string; title: string }[]; metrics: string[] }
export type TaskView = AgentTask & { draft?: string; live?: LiveTool | null; context?: ContextSummary | null };

const HEIGHT_KEY = 'duckview.agent.height';
const pageKey = (o: { kind: string; id?: string | null; label: string }) => `${o.kind}:${o.id ?? ''}:${o.label}`;
const readHeight = () => {
  try {
    return Number(localStorage.getItem(HEIGHT_KEY)) || 340;
  } catch {
    return 340;
  }
};

interface AgentState {
  expanded: boolean;
  height: number;
  sessionId: string | null;
  sessionTitle: string | null;
  tasks: TaskView[];
  sessions: AgentSession[];
  historyOpen: boolean;
  /** The page object the person took out of the agent's context (until the page changes). */
  pageOff: string | null;
  busy: boolean;
  focusToken: number;
  setExpanded(v: boolean): void;
  setHeight(h: number): void;
  setHistoryOpen(v: boolean): void;
  setPageOff(k: string | null): void;
  focus(): void;
  ask(workspaceId: string, request: string, mode?: string): Promise<void>;
  cancel(): Promise<void>;
  decide(taskId: string, decision: 'approve' | 'deny', note?: string): Promise<void>;
  newSession(): void;
  openSession(id: string): Promise<void>;
  /** Opens the session of a task (a deep link), switching workspace when it belongs to another. */
  openTask(taskId: string): Promise<void>;
  loadSessions(workspaceId: string): Promise<void>;
  deleteSession(id: string): Promise<void>;
  reset(): void;
}

/** Performs a move the agent made in the workspace. */
export function performAction(a: WorkspaceAction) {
  if (a.action === 'open_query') {
    const sql = String(a.args?.sql ?? '');
    void useWorkspace.getState().addTab({ title: String(a.args?.title ?? 'Agent query'), sql });
    location.hash = '#/query';
    return;
  }
  if (a.href) location.hash = a.href;
}

/** The object on screen, unless the person left it out. */
export function agentPage(off: string | null) {
  const o = usePageContext.getState().object;
  if (!o || off === pageKey(o)) return null;
  return { kind: o.kind, id: o.id ?? null, label: o.label };
}
export { pageKey };

export const useAgent = create<AgentState>((set, get) => {
  const patch = (id: string, f: (t: TaskView) => TaskView) => set({ tasks: get().tasks.map((t) => (t.id === id ? f(t) : t)) });

  /** Follows a task's events until it ends or pauses; refreshes the row at the end. */
  const follow = async (task: AgentTask) => {
    try {
      for await (const { event, data } of taskEvents(task.id, 0)) {
        if (event === 'task') continue;
        const d = data.data ?? {};
        switch (event) {
          case 'agent.plan.created':
          case 'agent.plan.updated':
            patch(task.id, (t) => ({ ...t, plan: d.plan }));
            break;
          case 'agent.context.selected':
            patch(task.id, (t) => ({ ...t, status: 'running', context: { considered: d.considered, selected: d.selected, objects: d.objects ?? [], metrics: d.metrics ?? [] } }));
            break;
          case 'agent.tool.started':
            patch(task.id, (t) => ({ ...t, status: 'running', live: { tool: d.tool, title: d.title, arguments: d.arguments, action_class: d.action_class } }));
            break;
          case 'agent.tool.completed':
          case 'agent.tool.failed':
            patch(task.id, (t) => ({ ...t, live: null, steps: [...t.steps, { n: t.steps.length + 1, kind: 'tool', at: data.at, tool: d.tool, arguments: t.live?.tool === d.tool ? t.live?.arguments : undefined, status: event === 'agent.tool.completed' ? 'ok' : 'error', summary: d.summary ?? d.error ?? '', duration_ms: d.duration_ms }] }));
            break;
          case 'agent.approval.required':
            patch(task.id, (t) => ({ ...t, live: null, status: 'waiting_approval', approval: { id: d.approval_id, tool: d.tool, arguments: t.live?.arguments ?? {}, action_class: d.action_class, reason: d.reason, verb: d.verb ?? null, preview: d.preview, requested_at: data.at } }));
            break;
          case 'agent.artifact.created':
            patch(task.id, (t) => ({ ...t, artifacts: [...t.artifacts, d.artifact as Artifact] }));
            break;
          case 'agent.workspace.changed':
            if (d.action) {
              patch(task.id, (t) => ({ ...t, actions: [...t.actions, d.action as WorkspaceAction] }));
              performAction(d.action as WorkspaceAction);
            }
            break;
          case 'agent.answer.delta':
            patch(task.id, (t) => ({ ...t, draft: (t.draft ?? '') + String(d.text ?? '') }));
            break;
          case 'agent.answer.reset':
            patch(task.id, (t) => ({ ...t, draft: '' }));
            break;
        }
      }
    } catch {
      /* the stream broke: the row below is the truth */
    }
    try {
      const fresh = await agentApi.task(task.id);
      patch(task.id, (t) => ({ ...t, ...fresh, draft: undefined, live: null }));
    } catch {
      /* the session was deleted meanwhile */
    }
    if (get().tasks.every((t) => t.status !== 'running' && t.status !== 'planning')) set({ busy: false });
  };

  return {
    expanded: false,
    height: readHeight(),
    sessionId: null,
    sessionTitle: null,
    tasks: [],
    sessions: [],
    historyOpen: false,
    pageOff: null,
    busy: false,
    focusToken: 0,
    setExpanded: (expanded) => set({ expanded }),
    setHeight: (h) => {
      const height = Math.max(180, Math.min(Math.round(h), Math.round(window.innerHeight * 0.75)));
      set({ height });
      try {
        localStorage.setItem(HEIGHT_KEY, String(height));
      } catch {
        /* storage unavailable */
      }
    },
    setHistoryOpen: (historyOpen) => set({ historyOpen }),
    setPageOff: (pageOff) => set({ pageOff }),
    focus: () => set({ focusToken: get().focusToken + 1 }),

    async ask(workspaceId, request, mode) {
      const cp = useCopilot.getState().settings;
      const byok = cp.provider && (cp.apiKey || cp.baseUrl) ? { provider: cp.provider, model: cp.model || undefined, api_key: cp.apiKey || undefined, base_url: cp.baseUrl || undefined, region: cp.region || undefined } : {};
      set({ busy: true, expanded: true });
      try {
        const task = await agentApi.start({ workspace_id: workspaceId, request, session_id: get().sessionId ?? undefined, mode, page: agentPage(get().pageOff), ...byok });
        set({ sessionId: task.session_id, sessionTitle: get().sessionTitle ?? request.slice(0, 80), tasks: [...get().tasks, { ...task, draft: '' }] });
        await follow(task);
        void get().loadSessions(workspaceId);
      } catch (e) {
        set({ busy: false });
        toast.error(errorText(e));
      }
    },

    async cancel() {
      const running = get().tasks.find((t) => t.status === 'running' || t.status === 'planning' || t.status === 'waiting_approval');
      if (!running) return;
      try {
        const t = await agentApi.cancel(running.id);
        patch(running.id, (x) => ({ ...x, ...t }));
      } catch (e) {
        toast.error(errorText(e));
      }
    },

    async decide(taskId, decision, note) {
      try {
        const t = await agentApi.decide(taskId, decision, note);
        patch(taskId, (x) => ({ ...x, ...t, draft: '' }));
        set({ busy: true });
        await follow(t);
      } catch (e) {
        toast.error(errorText(e));
      }
    },

    newSession: () => set({ sessionId: null, sessionTitle: null, tasks: [], historyOpen: false }),

    async openSession(id) {
      try {
        const s = await agentApi.session(id);
        set({ sessionId: s.id, sessionTitle: s.title, tasks: (s.tasks as AgentTask[]).map((t) => ({ ...t })), historyOpen: false, expanded: true });
        // A task still going (or waiting for approval) keeps streaming.
        for (const t of s.tasks as AgentTask[]) if (t.status === 'running' || t.status === 'planning') void follow(t);
      } catch (e) {
        toast.error(errorText(e));
      }
    },

    async openTask(taskId) {
      try {
        const t = await agentApi.task(taskId);
        const ws = useWorkspace.getState();
        if (ws.activeId !== t.workspace_id && ws.workspaces.some((w) => w.id === t.workspace_id)) {
          await ws.selectWorkspace(t.workspace_id);
          // Switching workspace resets the dock (an effect after the render): open the session after it.
          await new Promise((r) => setTimeout(r, 50));
        }
        await get().openSession(t.session_id);
      } catch (e) {
        toast.error(errorText(e));
      }
    },

    async loadSessions(workspaceId) {
      try {
        set({ sessions: await agentApi.sessions(workspaceId) });
      } catch {
        /* history stays as it was */
      }
    },

    async deleteSession(id) {
      await agentApi.deleteSession(id);
      set({ sessions: get().sessions.filter((s) => s.id !== id), ...(get().sessionId === id ? { sessionId: null, sessionTitle: null, tasks: [] } : {}) });
    },

    reset: () => set({ sessionId: null, sessionTitle: null, tasks: [], sessions: [], busy: false, historyOpen: false }),
  };
});
