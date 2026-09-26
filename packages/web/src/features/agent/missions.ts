/**
 * The Agent Home and mission state. The workspace the agent works in is the console's active workspace (one source,
 * so "Open in Console" lands in the same place); the datasets, the intent and the open mission live here. A running
 * task is followed through its event stream: activity reads as sentences, and the mission is fetched again on each
 * milestone (the server's row is the truth).
 */
import { create } from 'zustand';
import { useWorkspace } from '../../store/workspace';
import { useCopilot } from '../../store/copilot';
import { describeTool } from '../../components/ai';
import { errorText, toast } from '../../components/ui';
import { goToConsole } from './surface';
import { agentApi, missionApi, taskEvents, type AgentHomeData, type Mission, type MissionMode, type WorkspaceAction } from './api';

export interface LiveLine { id: number; text: string; state: 'done' | 'active' | 'warn' | 'error' }

const DATASETS_KEY = (ws: string) => `duckview.agent.datasets.${ws}`;
const readDatasets = (ws: string | null): string[] => {
  if (!ws) return [];
  try {
    const v = JSON.parse(localStorage.getItem(DATASETS_KEY(ws)) ?? '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
};

interface MissionState {
  home: AgentHomeData | null;
  homeError: unknown;
  datasets: string[];
  mode: MissionMode;
  /** An object the person was looking at when they called the agent (⌘I), offered as context. */
  carried: { kind: string; id?: string | null; label: string } | null;
  mission: Mission | null;
  missionError: unknown;
  live: LiveLine[];
  draft: string;
  following: string | null;
  loadHome(): Promise<void>;
  setDatasets(d: string[]): void;
  setMode(m: MissionMode): void;
  setCarried(c: MissionState['carried']): void;
  start(request: string): Promise<void>;
  open(id: string): Promise<void>;
  send(request: string): Promise<void>;
  cancel(): Promise<void>;
  decide(taskId: string, decision: 'approve' | 'deny'): Promise<void>;
  update(patch: { title?: string; archived?: boolean; visibility?: 'private' | 'workspace' }): Promise<void>;
  duplicate(): Promise<void>;
  closeMission(): void;
}

/** The person's own model settings, when they use them (the same ones Copilot uses). */
function byok() {
  const s = useCopilot.getState().settings;
  return s.provider && (s.apiKey || s.baseUrl) ? { provider: s.provider, model: s.model || undefined, api_key: s.apiKey || undefined, base_url: s.baseUrl || undefined, region: s.region || undefined } : {};
}

/** Performs a move the agent made, or opens an artifact, in the console. */
export function openInConsole(a: WorkspaceAction) {
  if (a.action === 'open_query' && goToConsole('#/query', { sql: String(a.args?.sql ?? ''), title: String(a.args?.title ?? 'Agent query') })) return;
  if (a.action !== 'open_query' && a.href && goToConsole(a.href)) return;
  if (a.action === 'open_query') {
    void useWorkspace.getState().addTab({ title: String(a.args?.title ?? 'Agent query'), sql: String(a.args?.sql ?? '') });
    location.hash = '#/query';
    return;
  }
  if (a.href) location.hash = a.href;
}

let lineId = 0;

export const useMissions = create<MissionState>((set, get) => {
  const line = (text: string, state: LiveLine['state'] = 'done') => set({ live: [...get().live.map((l) => (l.state === 'active' && state !== 'warn' ? { ...l, state: 'done' as const } : l)), { id: ++lineId, text, state }] });
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  const refresh = (id: string) => {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => void missionApi.get(id).then((m) => get().mission?.id === id && set({ mission: m })).catch(() => undefined), 150);
  };

  /** Follows a task until it ends or pauses; the mission is refreshed along the way and at the end. */
  const follow = async (missionId: string, taskId: string) => {
    if (get().following === taskId) return;
    set({ following: taskId, draft: '' });
    try {
      for await (const { event, data } of taskEvents(taskId, 0)) {
        if (get().following !== taskId) break;
        const d = data?.data ?? {};
        switch (event) {
          case 'agent.started':
            line('Understood the request');
            break;
          case 'agent.context.selected': {
            const explicit = (d.explicit as string[] | undefined) ?? [];
            if (explicit.length) line(`Working on ${explicit.join(', ')}`);
            line(`Selected ${d.selected} of ${d.considered} things in the workspace${(d.metrics as string[] | undefined)?.length ? ` · metric ${(d.metrics as string[]).join(', ')}` : ''}`);
            break;
          }
          case 'agent.plan.created':
          case 'agent.plan.updated':
            refresh(missionId);
            break;
          case 'agent.tool.started':
            line(`${describeTool(String(d.tool), (d.arguments as Record<string, unknown>) ?? {}, d.title as string)}…`, 'active');
            break;
          case 'agent.tool.completed':
            set({ live: get().live.map((l) => (l.state === 'active' ? { ...l, text: `${l.text.replace(/…$/, '')}${d.summary ? ` · ${String(d.summary).slice(0, 80)}` : ''}`, state: 'done' } : l)) });
            refresh(missionId);
            break;
          case 'agent.tool.failed':
            set({ live: get().live.map((l) => (l.state === 'active' ? { ...l, text: `${l.text.replace(/…$/, '')} failed; trying another way`, state: 'error' } : l)) });
            break;
          case 'agent.dataset.discovered':
            line(`Found ${d.dataset}`);
            break;
          case 'agent.artifact.created':
            if ((d.artifact as { type?: string })?.type !== 'dataset') line(`Made ${String((d.artifact as { title?: string })?.title ?? 'a result')}`);
            refresh(missionId);
            break;
          case 'agent.approval.required':
            line('Waiting for your approval', 'warn');
            refresh(missionId);
            break;
          case 'agent.workspace.changed':
            if (d.action) openInConsole(d.action as WorkspaceAction);
            break;
          case 'agent.answer.delta':
            set({ draft: get().draft + String(d.text ?? '') });
            break;
          case 'agent.answer.reset':
            set({ draft: '' });
            break;
          case 'agent.completed':
            line('Done');
            break;
          case 'agent.failed':
            line(`Stopped: ${String(d.error ?? 'failed')}`, 'error');
            break;
          case 'agent.cancelled':
            line('Cancelled', 'error');
            break;
        }
      }
    } catch {
      /* the stream broke; the mission below is the truth */
    }
    if (get().following === taskId) set({ following: null, draft: '' });
    if (get().mission?.id === missionId) set({ mission: await missionApi.get(missionId).catch(() => get().mission) });
    void get().loadHome();
  };

  return {
    home: null,
    homeError: null,
    datasets: readDatasets(useWorkspace.getState().activeId),
    mode: 'analyse',
    carried: null,
    mission: null,
    missionError: null,
    live: [],
    draft: '',
    following: null,

    async loadHome() {
      try {
        const ws = useWorkspace.getState().activeId;
        const home = await missionApi.home(ws);
        set({ home, homeError: null });
      } catch (e) {
        set({ homeError: e });
      }
    },
    setDatasets(datasets) {
      set({ datasets });
      const ws = useWorkspace.getState().activeId;
      try {
        if (ws) localStorage.setItem(DATASETS_KEY(ws), JSON.stringify(datasets));
      } catch {
        /* storage unavailable */
      }
    },
    setMode: (mode) => set({ mode }),
    setCarried: (carried) => set({ carried }),

    async start(request) {
      const ws = useWorkspace.getState().activeId;
      if (!ws) return;
      try {
        const r = await missionApi.start({ workspace_id: ws, request, mode: get().mode, datasets: get().datasets, page: get().carried ?? undefined, ...byok() });
        set({ mission: r.mission, live: [], missionError: null, carried: null });
        location.hash = `#/agent/missions/${r.mission.id}`;
        await follow(r.mission.id, r.task.id);
      } catch (e) {
        toast.error(errorText(e));
      }
    },

    async open(id) {
      if (get().mission?.id !== id) set({ mission: null, live: [], missionError: null });
      try {
        const m = await missionApi.get(id);
        set({ mission: m });
        const last = m.tasks.at(-1);
        if (last && (last.status === 'running' || last.status === 'planning')) void follow(id, last.id);
      } catch (e) {
        set({ missionError: e });
      }
    },

    async send(request) {
      const m = get().mission;
      if (!m) return;
      try {
        const r = await missionApi.message(m.id, { request, ...byok() });
        set({ mission: r.mission, live: [] });
        await follow(m.id, r.task.id);
      } catch (e) {
        toast.error(errorText(e));
      }
    },

    async cancel() {
      const m = get().mission;
      if (!m) return;
      try {
        set({ mission: await missionApi.cancel(m.id), following: null });
      } catch (e) {
        toast.error(errorText(e));
      }
    },

    async decide(taskId, decision) {
      const m = get().mission;
      try {
        await agentApi.decide(taskId, decision);
        if (m) {
          line(decision === 'approve' ? 'Approved; carrying on' : 'Declined; finishing without it');
          await follow(m.id, taskId);
        }
      } catch (e) {
        toast.error(errorText(e));
      }
    },

    async update(patch) {
      const m = get().mission;
      if (!m) return;
      try {
        set({ mission: await missionApi.update(m.id, patch) });
        if (patch.visibility) toast.success(patch.visibility === 'workspace' ? 'Shared with the workspace' : 'Made private');
        if (patch.archived !== undefined) toast.success(patch.archived ? 'Archived' : 'Restored');
      } catch (e) {
        toast.error(errorText(e));
      }
    },

    async duplicate() {
      const m = get().mission;
      if (!m) return;
      try {
        const copy = await missionApi.duplicate(m.id);
        toast.success('Duplicated');
        location.hash = `#/agent/missions/${copy.id}`;
      } catch (e) {
        toast.error(errorText(e));
      }
    },

    closeMission: () => set({ mission: null, live: [], following: null, draft: '' }),
  };
});

/** Keeps the chosen datasets per workspace: switching workspace brings back that workspace's choice. */
useWorkspace.subscribe((s, prev) => {
  if (s.activeId !== prev.activeId) {
    useMissions.setState({ datasets: readDatasets(s.activeId) });
    void useMissions.getState().loadHome();
  }
});
