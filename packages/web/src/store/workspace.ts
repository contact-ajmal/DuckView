import { create } from 'zustand';
import { api, queryStream, ApiError, type Workspace, type SessionTab, type ColumnSchema, type ChartConfig, type ApprovalChallenge, type CatalogObject, type JailEntry, type QueryResult, type LakehouseConnection, type WorkspaceRole } from '../api/client';
import { useAuth } from './auth';
import { resultCache, cacheId } from '../lib/resultCache';
import { subscribeLiveEvents } from '../lib/liveEvents';

/** Rows above this are not persisted per tab; the grid re-runs the query instead. */
const TAB_RESULT_MAX_BYTES = 2 * 1024 * 1024;

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
  /** Set when the rows were restored from this browser's cache after a reload — not re-run. */
  restoredAt?: string;
  /** Where the rows came from: DuckDB (default) or a remote lakehouse SQL engine. */
  engine?: 'duckdb' | 'databricks';
  /** Lakehouse connection the remote result was produced by (enables "Materialise into DuckDB"). */
  connectionId?: string;
  sql?: string;
}

const emptyResult = (): TabResult => ({ status: 'idle', columns: [], rows: [], rowCount: 0, durationMs: null, truncated: false, error: null, errorCode: null, challenge: null, statements: [], startedAt: null });

/** Tab engine values: null → DuckDB; "lakehouse:<connection id>" → remote SQL warehouse. */
export const lakehouseEngine = (connectionId: string) => `lakehouse:${connectionId}`;
export const engineConnectionId = (engine: string | null | undefined) => (engine?.startsWith('lakehouse:') ? engine.slice('lakehouse:'.length) : null);

export type SidePanel = 'catalog' | 'profile' | 'plan' | 'chart' | 'settings' | null;

export interface HistoryEntry { id: string; sql: string; at: string; durationMs: number; rows: number; tabTitle: string; status: 'ok' | 'error' }

const historyKey = (ws: string) => `duckview.history.${ws}`;
const overviewKey = (ws: string) => `duckview.overview.${ws}`;
function loadOverviewTarget(ws: string): string | null {
  try {
    return localStorage.getItem(overviewKey(ws));
  } catch {
    return null;
  }
}
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
  /** Lakehouse connections that can run SQL remotely (engine picker). */
  remoteEngines: LakehouseConnection[];
  loadRemoteEngines(): Promise<void>;
  setTabEngine(id: string, engine: string | null): Promise<void>;
  loadWorkspaces(): Promise<void>;
  selectWorkspace(id: string): Promise<void>;
  createWorkspace(input: { name: string; active_db_path?: string }): Promise<Workspace>;
  updateWorkspace(id: string, patch: Partial<Pick<Workspace, 'name' | 'active_db_path' | 'engine_settings'>>): Promise<void>;
  deleteWorkspace(id: string): Promise<void>;
  loadTabs(): Promise<void>;
  addTab(input?: { title?: string; sql?: string; engine?: string | null }): Promise<SessionTab | undefined>;
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
  /** Dataset selected on the Overview page, per workspace — survives navigating away and reloads. */
  overviewTarget: Record<string, string | null>;
  setOverviewTarget(workspaceId: string, target: string | null): void;
  /** Applies a new data epoch (own mutation or a teammate's, via the live feed) so cached views revalidate. */
  setDataVersion(workspaceId: string, version: number): void;
  /** Subscribes to the live feed for epoch events; idempotent. Returns an unsubscribe. */
  startLiveInvalidation(): () => void;
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
  overviewTarget: {},
  setOverviewTarget(workspaceId, target) {
    set({ overviewTarget: { ...get().overviewTarget, [workspaceId]: target } });
    try {
      if (target) localStorage.setItem(overviewKey(workspaceId), target);
      else localStorage.removeItem(overviewKey(workspaceId));
    } catch {
      /* ignore */
    }
  },

  async loadWorkspaces() {
    const r = await api.get<{ workspaces: Workspace[] }>('/api/workspaces');
    set({ workspaces: r.workspaces });
    const remembered = localStorage.getItem('duckview.workspace');
    const target = r.workspaces.find((w) => w.id === remembered) ?? r.workspaces[0];
    if (target && get().activeId !== target.id) await get().selectWorkspace(target.id);
  },
  async selectWorkspace(id) {
    localStorage.setItem('duckview.workspace', id);
    const overviewTarget = { ...get().overviewTarget };
    if (!(id in overviewTarget)) overviewTarget[id] = loadOverviewTarget(id);
    set({ activeId: id, tabs: [], activeTabId: null, catalog: null, history: loadHistory(id), overviewTarget });
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
    set({ workspaces: get().workspaces.map((w) => (w.id === id ? { ...w, ...r.workspace } : w)) });
  },
  async deleteWorkspace(id) {
    await api.del(`/api/workspaces/${id}`);
    void resultCache.clearWorkspace(id);
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
    // Bring back each tab's last result so a reload shows numbers instead of an empty grid. Clearly marked as
    // restored (with its time) and never treated as current — a re-run replaces it.
    const userId = useAuth.getState().user?.id;
    if (!userId) return;
    const restored: Record<string, TabResult> = {};
    await Promise.all(
      r.tabs.map(async (t) => {
        const e = await resultCache.get<Omit<TabResult, 'status' | 'cancel'> & { sql: string }>(cacheId(userId, ws, 'tab', t.id));
        if (e && get().activeId === ws && !get().results[t.id]) restored[t.id] = { ...emptyResult(), ...e.payload, status: 'done', restoredAt: e.computed_at, cancel: undefined };
      }),
    );
    if (Object.keys(restored).length && get().activeId === ws) set({ results: { ...restored, ...get().results } });
  },
  async addTab(input) {
    const ws = get().activeId;
    if (!ws) return undefined;
    const r = await api.post<{ tab: SessionTab }>(`/api/workspaces/${ws}/tabs`, { title: input?.title?.slice(0, 120) || `Query ${get().tabs.length + 1}`, sql_content: input?.sql ?? '', engine: input?.engine ?? null });
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
    const uid = useAuth.getState().user?.id;
    if (uid) void resultCache.remove(cacheId(uid, ws, 'tab', id));
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
    const remote = engineConnectionId(get().tabs.find((t) => t.id === tabId)?.engine);
    const base: TabResult = { ...emptyResult(), status: 'running', startedAt: Date.now(), engine: remote ? 'databricks' : 'duckdb', connectionId: remote ?? undefined, sql };
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
    if (remote) {
      // Remote SQL warehouse: one round trip through the Statement Execution API (polling happens server-side).
      const ac = new AbortController();
      update({ cancel: () => ac.abort() });
      try {
        const r = await api.post<QueryResult & { engine: 'databricks' }>(`/api/lakehouse/${remote}/query`, { sql, workspace_id: ws, max_rows: get().maxRows, dry_run: opts.dryRun }, { signal: ac.signal });
        update({ status: 'done', columns: r.columns, rows: r.rows, rowCount: r.rowCount, durationMs: r.durationMs, truncated: r.truncated, statements: [{ verb: r.statementClass, class: r.statementClass === 'SELECT' ? 'read' : 'write' }], cancel: undefined, restoredAt: undefined });
        pushHistory({ sql, durationMs: r.durationMs, rows: r.rowCount, status: 'ok' });
        persistTabResult(ws, tabId, get().results[tabId]);
      } catch (err) {
        const e = err as ApiError;
        if (e.code === 'APPROVAL_REQUIRED') update({ status: 'approval', challenge: null, error: e.message, errorCode: e.code, cancel: undefined });
        else {
          update({ status: 'error', error: e.message ?? String(err), errorCode: e.code ?? 'ERROR', cancel: undefined });
          pushHistory({ sql, durationMs: Date.now() - (base.startedAt ?? Date.now()), rows: 0, status: 'error' });
        }
      }
      return;
    }
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
            update({ status: 'done', durationMs: info.duration_ms, truncated: info.truncated, statements: info.statements, cancel: undefined, restoredAt: undefined });
            if (info.statements.some((s) => s.class !== 'read')) void get().loadCatalog(true);
            if (info.data_version !== undefined) get().setDataVersion(ws, info.data_version);
            pushHistory({ sql, durationMs: info.duration_ms, rows: get().results[tabId]?.rowCount ?? 0, status: 'ok' });
            persistTabResult(ws, tabId, get().results[tabId]);
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
  remoteEngines: [],
  async loadRemoteEngines() {
    try {
      const r = await api.get<{ connections: LakehouseConnection[] }>('/api/lakehouse-connections');
      set({ remoteEngines: r.connections.filter((c) => c.remote_sql) });
    } catch {
      set({ remoteEngines: [] });
    }
  },
  async setTabEngine(id, engine) {
    const ws = get().activeId;
    if (!ws) return;
    set({ tabs: get().tabs.map((t) => (t.id === id ? { ...t, engine } : t)) });
    await api.patch(`/api/workspaces/${ws}/tabs/${id}`, { engine }).catch(() => undefined);
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
  setDataVersion(workspaceId, version) {
    const cur = get().workspaces.find((w) => w.id === workspaceId);
    if (!cur || cur.data_version >= version) return;
    set({ workspaces: get().workspaces.map((w) => (w.id === workspaceId ? { ...w, data_version: version } : w)) });
  },
  startLiveInvalidation() {
    if (liveUnsubscribe) return liveUnsubscribe;
    liveUnsubscribe = subscribeLiveEvents((e) => {
      if (e.type !== 'workspace') return;
      // Cloud sync state changes carry no new epoch (data_version -1): refresh the workspace row instead.
      if (e.reason === 'cloud_sync') {
        api.get<{ workspace: Workspace }>(`/api/workspaces/${e.workspace_id}`).then((r) => set({ workspaces: get().workspaces.map((w) => (w.id === r.workspace.id ? { ...w, cloud_sync: r.workspace.cloud_sync, cloud_connection_id: r.workspace.cloud_connection_id, active_db_path: r.workspace.active_db_path } : w)) })).catch(() => undefined);
        return;
      }
      get().setDataVersion(e.workspace_id, e.data_version);
    });
    return () => {
      liveUnsubscribe?.();
      liveUnsubscribe = null;
    };
  },
}));

let liveUnsubscribe: (() => void) | null = null;

/** Persists a finished tab result (rows capped by size) so it can be restored after a reload. */
function persistTabResult(workspaceId: string, tabId: string, r: TabResult | undefined) {
  const userId = useAuth.getState().user?.id;
  if (!userId || !r || r.status !== 'done') return;
  const { cancel: _c, status: _s, restoredAt: _r, ...payload } = r;
  let bytes = 0;
  try {
    bytes = JSON.stringify(payload.rows).length;
  } catch {
    return;
  }
  const id = cacheId(userId, workspaceId, 'tab', tabId);
  if (bytes > TAB_RESULT_MAX_BYTES) {
    void resultCache.remove(id);
    return;
  }
  void resultCache.set({ id, user_id: userId, workspace_id: workspaceId, kind: 'tab', etag: null, computed_at: new Date().toISOString(), payload });
}

/** Wipes every cached result in this browser — on logout and on session loss. */
export function clearBrowserCache() {
  return resultCache.clearAll();
}

/**
 * What the signed-in user may do in the active workspace. Combines the platform role (READ_ONLY never edits)
 * with the workspace role from sharing (VIEWER never edits, only OWNER manages settings and members).
 * Tabs are personal and are not gated here.
 */
export function useWorkspaceAccess(): { workspace: Workspace | null; role: WorkspaceRole; canEdit: boolean; canManage: boolean; shared: boolean } {
  const platformRole = useAuth((s) => s.user?.role);
  const workspace = useWorkspace((s) => s.workspaces.find((w) => w.id === s.activeId) ?? null);
  const role: WorkspaceRole = workspace?.role ?? 'OWNER';
  const readOnlyUser = platformRole === 'READ_ONLY';
  return { workspace, role, canEdit: !readOnlyUser && role !== 'VIEWER', canManage: !readOnlyUser && role === 'OWNER', shared: !!workspace?.shared };
}
