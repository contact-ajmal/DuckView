import { create } from 'zustand';
import { api, queryStream, ApiError, type Workspace, type SessionTab, type ColumnSchema, type ChartConfig, type ApprovalChallenge, type CatalogObject, type JailEntry } from '../api/client';

export interface TabResult {
  status: 'idle' | 'running' | 'done' | 'error' | 'approval';
  columns: ColumnSchema[];
  rows: unknown[][];
  rowCount: number;
  durationMs: number | null;
  truncated: boolean;
  error: string | null;
  errorCode: string | null;
  challenge: ApprovalChallenge | null;
  statements: { verb: string; class: string }[];
  startedAt: number | null;
  cancel?: () => void;
}

const emptyResult = (): TabResult => ({ status: 'idle', columns: [], rows: [], rowCount: 0, durationMs: null, truncated: false, error: null, errorCode: null, challenge: null, statements: [], startedAt: null });

export type SidePanel = 'catalog' | 'profile' | 'plan' | 'chart' | 'settings' | null;

export interface HistoryEntry { id: string; sql: string; at: string; durationMs: number; rows: number; tabTitle: string; status: 'ok' | 'error' }

const historyKey = (ws: string) => `duckview.history.${ws}`;
function loadHistory(ws: string | null): HistoryEntry[] {
  if (!ws) return [];
  try {
    return JSON.parse(localStorage.getItem(historyKey(ws)) ?? '[]') as HistoryEntry[];
  } catch {
    return [];
  }
}

interface WorkspaceState {
  workspaces: Workspace[];
  activeId: string | null;
  tabs: SessionTab[];
  activeTabId: string | null;
  results: Record<string, TabResult>;
  drafts: Record<string, string>;
  cursors: Record<string, number>;
  catalog: { objects: CatalogObject[]; files: JailEntry[]; truncated_folders?: string[] } | null;
  catalogLoading: boolean;
  history: HistoryEntry[];
  clearHistory(): void;
  sidePanel: SidePanel;
  maxRows: number;
  loadWorkspaces(): Promise<void>;
  selectWorkspace(id: string): Promise<void>;
  createWorkspace(input: { name: string; active_db_path?: string }): Promise<Workspace>;
  updateWorkspace(id: string, patch: Partial<Pick<Workspace, 'name' | 'active_db_path' | 'engine_settings'>>): Promise<void>;
  deleteWorkspace(id: string): Promise<void>;
  loadTabs(): Promise<void>;
  addTab(input?: { title?: string; sql?: string }): Promise<SessionTab | undefined>;
  selectTab(id: string): void;
  closeTab(id: string): Promise<void>;
  renameTab(id: string, title: string): Promise<void>;
  setDraft(id: string, sql: string, cursor?: number): void;
  setCursor(id: string, cursor: number): void;
  flushDraft(id: string): Promise<void>;
  setChart(id: string, chart: ChartConfig): Promise<void>;
  runQuery(tabId: string, sql: string, opts?: { dryRun?: boolean }): Promise<void>;
  cancelQuery(tabId: string): void;
  loadCatalog(force?: boolean): Promise<void>;
  setSidePanel(p: SidePanel): void;
  setMaxRows(n: number): void;
}

const flushTimers: Record<string, number> = {};

export const useWorkspace = create<WorkspaceState>((set, get) => ({
  workspaces: [],
  activeId: null,
  tabs: [],
  activeTabId: null,
  results: {},
  drafts: {},
  cursors: {},
  catalog: null,
  catalogLoading: false,
  history: [],
  clearHistory() {
    const ws = get().activeId;
    if (ws) localStorage.removeItem(historyKey(ws));
    set({ history: [] });
  },
  sidePanel: 'catalog',
  maxRows: 1000,

  async loadWorkspaces() {
    const r = await api.get<{ workspaces: Workspace[] }>('/api/workspaces');
    set({ workspaces: r.workspaces });
    const remembered = localStorage.getItem('duckview.workspace');
    const target = r.workspaces.find((w) => w.id === remembered) ?? r.workspaces[0];
    if (target && get().activeId !== target.id) await get().selectWorkspace(target.id);
  },
  async selectWorkspace(id) {
    localStorage.setItem('duckview.workspace', id);
    set({ activeId: id, tabs: [], activeTabId: null, catalog: null, history: loadHistory(id) });
    await get().loadTabs();
    void get().loadCatalog(true);
  },
  async createWorkspace(input) {
    const r = await api.post<{ workspace: Workspace }>('/api/workspaces', input);
    set({ workspaces: [r.workspace, ...get().workspaces] });
    await get().selectWorkspace(r.workspace.id);
    return r.workspace;
  },
  async updateWorkspace(id, patch) {
    const r = await api.patch<{ workspace: Workspace }>(`/api/workspaces/${id}`, patch);
    set({ workspaces: get().workspaces.map((w) => (w.id === id ? r.workspace : w)) });
  },
  async deleteWorkspace(id) {
    await api.del(`/api/workspaces/${id}`);
    const remaining = get().workspaces.filter((w) => w.id !== id);
    set({ workspaces: remaining });
    if (get().activeId === id) {
      if (remaining[0]) await get().selectWorkspace(remaining[0].id);
      else await get().loadWorkspaces();
    }
  },
  async loadTabs() {
    const ws = get().activeId;
    if (!ws) return;
    const r = await api.get<{ tabs: SessionTab[] }>(`/api/workspaces/${ws}/tabs`);
    const remembered = localStorage.getItem(`duckview.tab.${ws}`);
    const active = r.tabs.find((t) => t.id === remembered) ?? r.tabs[0] ?? null;
    set({ tabs: r.tabs, activeTabId: active?.id ?? null });
    if (r.tabs.length === 0) await get().addTab();
  },
  async addTab(input) {
    const ws = get().activeId;
    if (!ws) return undefined;
    const r = await api.post<{ tab: SessionTab }>(`/api/workspaces/${ws}/tabs`, { title: input?.title?.slice(0, 120) || `Query ${get().tabs.length + 1}`, sql_content: input?.sql ?? '' });
    set({ tabs: [...get().tabs, r.tab], activeTabId: r.tab.id });
    localStorage.setItem(`duckview.tab.${ws}`, r.tab.id);
    return r.tab;
  },
  selectTab(id) {
    const ws = get().activeId;
    if (ws) localStorage.setItem(`duckview.tab.${ws}`, id);
    set({ activeTabId: id });
  },
  async closeTab(id) {
    const ws = get().activeId;
    if (!ws) return;
    await api.del(`/api/workspaces/${ws}/tabs/${id}`);
    const tabs = get().tabs.filter((t) => t.id !== id);
    const results = { ...get().results };
    delete results[id];
    set({ tabs, results, activeTabId: get().activeTabId === id ? (tabs[tabs.length - 1]?.id ?? null) : get().activeTabId });
    if (tabs.length === 0) await get().addTab();
  },
  async renameTab(id, title) {
    const ws = get().activeId;
    if (!ws) return;
    const r = await api.patch<{ tab: SessionTab }>(`/api/workspaces/${ws}/tabs/${id}`, { title });
    set({ tabs: get().tabs.map((t) => (t.id === id ? r.tab : t)) });
  },
  setDraft(id, sql, cursor) {
    set({ drafts: { ...get().drafts, [id]: sql }, ...(cursor !== undefined ? { cursors: { ...get().cursors, [id]: cursor } } : {}) });
    window.clearTimeout(flushTimers[id]);
    flushTimers[id] = window.setTimeout(() => void get().flushDraft(id), 800);
  },
  setCursor(id, cursor) {
    set({ cursors: { ...get().cursors, [id]: cursor } });
    window.clearTimeout(flushTimers[id]);
    flushTimers[id] = window.setTimeout(() => void get().flushDraft(id), 1500);
  },
  async flushDraft(id) {
    const ws = get().activeId;
    if (!ws) return;
    const tab = get().tabs.find((t) => t.id === id);
    if (!tab) return;
    const sql = get().drafts[id] ?? tab.sql_content;
    const cursor = get().cursors[id] ?? tab.cursor_position;
    if (tab.sql_content === sql && tab.cursor_position === cursor) return;
    try {
      const r = await api.patch<{ tab: SessionTab }>(`/api/workspaces/${ws}/tabs/${id}`, { sql_content: sql, cursor_position: cursor });
      set({ tabs: get().tabs.map((t) => (t.id === id ? { ...r.tab, sql_content: sql, cursor_position: cursor } : t)) });
    } catch {
      /* keep draft; retry on next edit */
    }
  },
  async setChart(id, chart) {
    const ws = get().activeId;
    if (!ws) return;
    set({ tabs: get().tabs.map((t) => (t.id === id ? { ...t, chart_config: chart } : t)) });
    await api.patch(`/api/workspaces/${ws}/tabs/${id}`, { chart_config: chart }).catch(() => undefined);
  },
  async runQuery(tabId, sql, opts = {}) {
    const ws = get().activeId;
    if (!ws || !sql.trim()) return;
    get().results[tabId]?.cancel?.();
    const base: TabResult = { ...emptyResult(), status: 'running', startedAt: Date.now() };
    set({ results: { ...get().results, [tabId]: base } });
    const update = (patch: Partial<TabResult>) => set({ results: { ...get().results, [tabId]: { ...(get().results[tabId] ?? base), ...patch } } });
    const pushHistory = (h: { sql: string; durationMs: number; rows: number; status: 'ok' | 'error' }) => {
      const tab = get().tabs.find((t) => t.id === tabId);
      const entry: HistoryEntry = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, at: new Date().toISOString(), tabTitle: tab?.title ?? '', ...h };
      const history = [entry, ...get().history.filter((e) => e.sql !== h.sql)].slice(0, 50);
      set({ history });
      try {
        localStorage.setItem(historyKey(ws), JSON.stringify(history));
      } catch {
        /* quota */
      }
    };
    let buffered: unknown[][] = [];
    let flushScheduled = false;
    const flush = () => {
      flushScheduled = false;
      if (!buffered.length) return;
      const cur = get().results[tabId];
      if (!cur) return;
      const rows = cur.rows.concat(buffered);
      buffered = [];
      update({ rows, rowCount: rows.length });
    };
    try {
      const { cancel } = await queryStream.run(
        { workspaceId: ws, sql, maxRows: get().maxRows, dryRun: opts.dryRun },
        {
          onSchema: (columns) => update({ columns }),
          onRows: (rows) => {
            buffered.push(...rows);
            if (!flushScheduled) {
              flushScheduled = true;
              requestAnimationFrame(flush);
            }
          },
          onDone: (info) => {
            flush();
            update({ status: 'done', durationMs: info.duration_ms, truncated: info.truncated, statements: info.statements, cancel: undefined });
            if (info.statements.some((s) => s.class !== 'read')) void get().loadCatalog(true);
            pushHistory({ sql, durationMs: info.duration_ms, rows: get().results[tabId]?.rowCount ?? 0, status: 'ok' });
          },
          onError: (err) => {
            flush();
            if (err.code === 'APPROVAL_REQUIRED') update({ status: 'approval', challenge: err.challenge ?? null, error: err.message, errorCode: err.code, cancel: undefined });
            else {
              update({ status: 'error', error: err.message, errorCode: err.code, cancel: undefined });
              pushHistory({ sql, durationMs: Date.now() - (base.startedAt ?? Date.now()), rows: 0, status: 'error' });
            }
          },
        },
      );
      update({ cancel });
    } catch (err) {
      const e = err as ApiError;
      update({ status: 'error', error: e.message ?? String(err), errorCode: e.code ?? 'ERROR' });
    }
  },
  cancelQuery(tabId) {
    get().results[tabId]?.cancel?.();
  },
  async loadCatalog(force = false) {
    const ws = get().activeId;
    if (!ws || (get().catalogLoading && !force)) return;
    set({ catalogLoading: true });
    try {
      const r = await api.get<{ objects: CatalogObject[]; files: JailEntry[]; truncated_folders?: string[] }>(`/api/workspaces/${ws}/catalog`);
      if (get().activeId === ws) set({ catalog: r });
    } catch {
      /* ignore */
    } finally {
      set({ catalogLoading: false });
    }
  },
  setSidePanel(p) {
    set({ sidePanel: p });
  },
  setMaxRows(n) {
    set({ maxRows: n });
  },
}));
