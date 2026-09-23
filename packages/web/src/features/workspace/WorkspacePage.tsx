import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Play, Square, Plus, X, Download, ShieldAlert, Trash2, Copy, Check, FileUp, RefreshCw, Save, Wrench, FolderOpen, PanelLeft, Layers, DatabaseZap, Workflow, MoreHorizontal, Search, Send } from 'lucide-react';
import { useWorkspace, useWorkspaceAccess, lakehouseEngine, engineConnectionId } from '../../store/workspace';
import { useAuth } from '../../store/auth';
import { fetchCached } from '../../lib/useCached';
import { CacheChip } from '../../components/CacheChip';
import { useCopilot } from '../../store/copilot';
import { api, exportAndDownload, tabsToSql, sqlToTabs, type ChartConfig, type SavedQuery } from '../../api/client';
import { SqlEditor, type SqlEditorHandle } from './SqlEditor';
import { ResultsGrid, rowsToTsv } from './ResultsGrid';
import { ChartPanel } from './ChartPanel';
import { PlanView, type PlanResult } from './PlanView';
import { ProfilePanel, type ProfileResult } from './ProfilePanel';
import { ExploreView } from '../explore/ExploreView';
import { SchemaTree } from './SchemaTree';
import { SavedQueriesTree } from './SavedQueries';
import { REVERSE_DRAFT_KEY } from '../connections/ReversePanel';
import { SaveDbtModelDialog } from '../transform/SaveDbtModelDialog';
import { Explorer, type ExplorerNode } from '../explorer/Explorer';
import { SchemaPanel } from '../explorer/SchemaPanel';
import { FolderPicker } from '../explorer/FolderPicker';
import { CloudWizard } from '../explorer/CloudWizard';
import { LakehouseWizard } from '../explorer/LakehouseWizard';
import { registerCopilotHost } from '../copilot/CopilotDrawer';
import { TypePill } from '../../components/layout';
import { SplitPane, StackedPanes, usePersisted } from '../../components/panes';
import { useLayout } from '../../store/layout';
import { HideButton } from '../../components/LayoutMenu';
import { Badge, Button, Empty, IconButton, Input, Label, Menu, MenuDivider, MenuItem, Modal, Select, Tabs, cn } from '../../components/ui';

type View = 'table' | 'schema' | 'chart' | 'plan' | 'profile' | 'explore';

export function WorkspacePage() {
  const ws = useWorkspace();
  const cp = useCopilot();
  const workspace = ws.workspaces.find((w) => w.id === ws.activeId) ?? null;
  const tab = ws.tabs.find((t) => t.id === ws.activeTabId) ?? null;
  const result = tab ? ws.results[tab.id] : undefined;
  const sql = tab ? (ws.drafts[tab.id] ?? tab.sql_content) : '';
  const editor = useRef<SqlEditorHandle>(null);
  const [view, setView] = useState<View>('table');
  const [plan, setPlan] = useState<PlanResult | null>(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [profile, setProfile] = useState<ProfileResult | null>(null);
  const [profileMeta, setProfileMeta] = useState<{ fromCache: boolean; computedAt: string; serverCached: boolean; target: string } | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = usePersisted<boolean>('duckview.pane.workbench.sidebar.collapsed', false);
  const hidden = useLayout((l) => l.hidden);
  const isHidden = (id: string) => !!hidden[id];
  const [copied, setCopied] = useState(false);
  const [gridFilter, setGridFilter] = useState('');
  const [shownRows, setShownRows] = useState<unknown[][]>([]);
  const [rowsCopied, setRowsCopied] = useState(false);
  const [exporting, setExporting] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);
  const [inspect, setInspect] = useState<string | null>(null);
  const [inspectRemote, setInspectRemote] = useState<string | null>(null);
  const [wizard, setWizard] = useState(false);
  const [lakeWizard, setLakeWizard] = useState(false);
  const [materialize, setMaterialize] = useState<{ open: boolean; connectionId: string; connectionName: string; sql: string; table: string; busy: boolean; error: string | null; done: string | null }>({ open: false, connectionId: '', connectionName: '', sql: '', table: '', busy: false, error: null, done: null });
  const [picker, setPicker] = useState(false);
  const [explorerKey, setExplorerKey] = useState(0);
  const [saved, setSaved] = useState<SavedQuery[]>([]);
  const [dbtModel, setDbtModel] = useState<string | null>(null);
  const [saveModal, setSaveModal] = useState<{ open: boolean; name: string; folder: string; tags: string; description: string; existing?: SavedQuery }>({ open: false, name: '', folder: '', tags: '', description: '' });
  const importInput = useRef<HTMLInputElement>(null);
  const { canEdit: canWrite } = useWorkspaceAccess();
  const wsId = workspace?.id;

  const loadSaved = useCallback(async () => {
    if (!wsId) return;
    try {
      setSaved((await api.get<{ queries: SavedQuery[] }>(`/api/workspaces/${wsId}/queries`)).queries);
    } catch {
      setSaved([]);
    }
  }, [wsId]);
  useEffect(() => void loadSaved(), [loadSaved]);

  const run = useCallback(
    (selection: string | null, dryRun?: boolean) => {
      if (!tab) return;
      void ws.flushDraft(tab.id);
      void ws.runQuery(tab.id, selection ?? (ws.drafts[tab.id] ?? tab.sql_content), { dryRun });
      setView((v) => (v === 'plan' || v === 'profile' || v === 'schema' ? 'table' : v));
    },
    [tab, ws],
  );
  const onCursor = useCallback((c: number) => tab && ws.setCursor(tab.id, c), [tab, ws]);

  // ---- Copilot host: lets the drawer act on this workbench
  useEffect(() => {
    registerCopilotHost({
      insertSql: (s) => {
        if (!tab) return void ws.addTab({ title: 'Copilot', sql: s });
        if (!sql.trim()) ws.setDraft(tab.id, s, s.length);
        else editor.current?.insert(`\n${s}`);
      },
      newTabWithSql: (s, title) => void ws.addTab({ title: title ?? 'Copilot', sql: s }),
      runSql: async (s) => {
        const t = tab ?? (await ws.addTab({ title: 'Copilot', sql: s }));
        if (!t) return { columns: [], rows: [], rowCount: 0, error: 'no tab' };
        if (t.id === tab?.id) ws.setDraft(t.id, s, s.length);
        await ws.runQuery(t.id, s, {});
        // wait for completion
        for (let i = 0; i < 600; i++) {
          const r = useWorkspace.getState().results[t.id];
          if (r && r.status !== 'running') return r.status === 'done' ? { columns: r.columns, rows: r.rows, rowCount: r.rowCount } : { columns: [], rows: [], rowCount: 0, error: r.error ?? r.challenge?.reason ?? 'query failed' };
          await new Promise((res) => setTimeout(res, 100));
        }
        return { columns: [], rows: [], rowCount: 0, error: 'timeout waiting for result' };
      },
      activeSql: () => sql,
      activeError: () => (result?.status === 'error' ? result.error : null),
    });
    return () => registerCopilotHost(null);
  }, [tab, sql, result, ws]);

  const userId = useAuth((s) => s.user?.id ?? '');
  const explain = async (analyze: boolean, refresh = false) => {
    if (!workspace || !sql.trim()) return;
    setPlanLoading(true);
    setView('plan');
    try {
      if (analyze) setPlan(await api.post<PlanResult>(`/api/workspaces/${workspace.id}/explain`, { sql, analyze }));
      else await fetchCached<PlanResult>({ userId, workspaceId: workspace.id, kind: 'explain', target: sql, url: `/api/workspaces/${workspace.id}/explain`, body: { sql }, version: workspace.data_version }, (data) => setPlan(data), { refresh });
    } catch (e) {
      setPlan({ format: 'text', plan: null, text: `Error: ${(e as Error).message}` });
    } finally {
      setPlanLoading(false);
    }
  };
  const doProfile = async (target: string, refresh = false) => {
    if (!workspace || !target.trim()) return;
    setProfileLoading(true);
    setProfileMeta(null);
    setView('profile');
    try {
      // Cached copy first (instant), then the server's answer — a 304 leaves it untouched.
      await fetchCached<ProfileResult>({ userId, workspaceId: workspace.id, kind: 'profile', target, url: `/api/workspaces/${workspace.id}/profile`, body: { target }, version: workspace.data_version }, (data, meta) => {
        setProfile(data);
        setProfileMeta({ ...meta, target });
      }, { refresh });
    } catch (e) {
      setProfile({ summary: [], rowCount: null, columnCount: 0, sizeBytes: null, sql: '' });
      alert((e as Error).message);
    } finally {
      setProfileLoading(false);
    }
  };

  const schemaHints = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const o of ws.catalog?.objects ?? []) out[o.name] = o.columns.map((c) => c.name);
    return out;
  }, [ws.catalog]);

  const insertSnippet = (snippet: string) => {
    if (!tab) return;
    if (!sql.trim()) ws.setDraft(tab.id, snippet, snippet.length);
    else editor.current?.insert(`\n${snippet}`);
  };
  const replaceSql = (next: string) => tab && ws.setDraft(tab.id, next, next.length);

  // ---- .sql import (file picker + drag-and-drop): marker sections become tabs
  const importSqlFiles = async (files: File[]) => {
    for (const f of files) {
      if (!/\.(sql|txt)$/i.test(f.name)) continue;
      const text = await f.text();
      for (const t of sqlToTabs(text, f.name.replace(/\.(sql|txt)$/i, ''))) await ws.addTab({ title: t.title, sql: t.sql });
    }
  };
  const download = (blob: Blob, name: string) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };
  const exportTab = () => tab && download(new Blob([tabsToSql([{ title: tab.title, sql }])], { type: 'text/sql' }), `${tab.title.replace(/[^\w.-]+/g, '_')}.sql`);
  const exportAll = () => workspace && download(new Blob([tabsToSql(ws.tabs.map((t) => ({ title: t.title, sql: ws.drafts[t.id] ?? t.sql_content })))], { type: 'text/sql' }), `${workspace.name.replace(/[^\w.-]+/g, '_')}.sql`);

  const exportRows = async (fmt: 'csv' | 'parquet' | 'json' | 'arrow') => {
    if (!workspace || !tab || !sql.trim()) return;
    setExporting(fmt);
    try {
      await exportAndDownload(workspace.id, sql, fmt, tab.title);
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setExporting(null);
    }
  };

  const openSave = () => {
    if (!tab) return;
    const existing = saved.find((q) => q.name === tab.title);
    setSaveModal({ open: true, name: tab.title, folder: existing?.folder ?? '', tags: existing?.tags.join(', ') ?? '', description: existing?.description ?? '', existing });
  };
  const doSave = async () => {
    if (!wsId) return;
    const body = { name: saveModal.name, folder: saveModal.folder, description: saveModal.description || null, sql_text: sql, tags: saveModal.tags.split(',').map((t) => t.trim()).filter(Boolean) };
    try {
      if (saveModal.existing) await api.patch(`/api/workspaces/${wsId}/queries/${saveModal.existing.id}`, body);
      else await api.post(`/api/workspaces/${wsId}/queries`, body);
      setSaveModal({ ...saveModal, open: false });
      await loadSaved();
    } catch (e) {
      alert((e as Error).message);
    }
  };

  const explorerActions = useMemo(
    () => ({
      onInspect: (n: ExplorerNode) => {
        if (!n.target) return;
        setInspect(n.target);
        setInspectRemote(n.kind === 'lh-table' && n.lakehouse?.engine === 'remote' ? n.lakehouse.connectionId : null);
        setView('schema');
      },
      onQuery: (n: ExplorerNode) => {
        if (!n.target) return;
        if (n.kind === 'lh-table') return void ws.addTab({ title: n.name, sql: `SELECT *\nFROM ${n.target}\nLIMIT 100;` });
        void ws.addTab({ title: n.name, sql: n.kind === 'object' || n.fileKind !== 'duckdb' ? `SELECT *\nFROM '${n.target}'\nLIMIT 100;` : `ATTACH '${n.target}' AS attached_db (READ_ONLY);\nSHOW ALL TABLES;` });
      },
      onQueryRemote: (n: ExplorerNode) => {
        if (!n.target || !n.lakehouse) return;
        void ws.addTab({ title: n.name, sql: `SELECT *\nFROM ${n.target}\nLIMIT 100;`, engine: lakehouseEngine(n.lakehouse.connectionId) });
        void ws.loadRemoteEngines();
      },
      onMaterialize: (n: ExplorerNode) => {
        if (!n.target || !n.lakehouse) return;
        const remoteName = n.lakehouse.engine === 'duckdb' ? `${n.lakehouse.catalog ?? ''}.${n.lakehouse.schema ?? ''}.${n.name}`.replace(/^\./, '') : n.target;
        setMaterialize({ open: true, connectionId: n.lakehouse.connectionId, connectionName: n.lakehouse.alias, sql: `SELECT * FROM ${remoteName}`, table: n.name.replace(/[^A-Za-z0-9_]/g, '_'), busy: false, error: null, done: null });
      },
      onInsert: (text: string) => editor.current?.insert(text),
      onAskCopilot: (n: ExplorerNode) => {
        if (n.target) cp.setTargets([n.target]);
        cp.toggle(true);
      },
      onAddConnection: () => setWizard(true),
      onAddLakehouse: () => setLakeWizard(true),
      onAddFolder: () => setPicker(true),
      onRemoveFolder: async (path: string) => {
        if (!workspace || !confirm(`Remove ${path} from this workspace? Files are not deleted.`)) return;
        await api.del(`/api/workspaces/${workspace.id}/folders?path=${encodeURIComponent(path)}`);
        setExplorerKey((k) => k + 1);
        void ws.loadCatalog(true);
      },
      onDeleted: () => void ws.loadCatalog(true),
    }),
    [ws, cp, workspace],
  );

  useEffect(() => setPlan(null), [tab?.id]);
  useEffect(() => {
    void ws.loadRemoteEngines();
  }, [wsId]); // eslint-disable-line react-hooks/exhaustive-deps
  const tabEngine = tab ? engineConnectionId(tab.engine) : null;
  const tabEngineConn = tabEngine ? ws.remoteEngines.find((c) => c.id === tabEngine) ?? null : null;
  const runMaterialize = async () => {
    if (!wsId) return;
    setMaterialize((m) => ({ ...m, busy: true, error: null, done: null }));
    try {
      const r = await api.post<{ table: string; rows: number; truncated: boolean; duration_ms: number }>(`/api/lakehouse/${materialize.connectionId}/materialize`, { sql: materialize.sql, table: materialize.table, workspace_id: wsId });
      setMaterialize((m) => ({ ...m, busy: false, done: `Created table ${r.table} with ${r.rows.toLocaleString()} rows in ${r.duration_ms} ms${r.truncated ? ' (row cap reached)' : ''}.` }));
      void ws.loadCatalog(true);
    } catch (e) {
      setMaterialize((m) => ({ ...m, busy: false, error: (e as Error).message }));
    }
  };
  if (!workspace) return <Empty title="No workspace" hint="Create a workspace from the switcher in the top bar." />;

  const executed = result?.status === 'done';
  const chartable = !!result?.columns.length;

  const sidebarSections = [
    {
      key: 'explorer',
      title: 'Explorer',
      hideId: 'query.explorer',
      defaultHeight: 300,
      meta: (
        <button onClick={() => setExplorerKey((k) => k + 1)} className="text-zinc-500 hover:text-zinc-200" title="Refresh">
          <RefreshCw className="h-3 w-3" />
        </button>
      ),
      content: <Explorer workspaceId={workspace.id} actions={explorerActions} refreshKey={explorerKey} selected={inspect} readOnly={!canWrite} />,
    },
    {
      key: 'tables',
      title: 'Tables & views',
      hideId: 'query.tables',
      defaultHeight: 180,
      meta: (
        <span className="flex items-center gap-2">
          click to insert
          <button onClick={() => void ws.loadCatalog(true)} className={cn('text-zinc-500 hover:text-zinc-200', ws.catalogLoading && 'animate-spin')} title="Refresh">
            <RefreshCw className="h-3 w-3" />
          </button>
        </span>
      ),
      content: (
        <div className="p-2">
          <SchemaTree catalog={ws.catalog ? { objects: ws.catalog.objects, files: [] } : null} loading={ws.catalogLoading} onInsert={(ident) => editor.current?.insert(ident)} onSnippet={insertSnippet} />
        </div>
      ),
    },
    {
      key: 'saved',
      title: 'Saved queries',
      hideId: 'query.saved',
      defaultHeight: 180,
      meta: (
        <button onClick={openSave} disabled={!tab || !sql.trim() || !canWrite} className="inline-flex items-center gap-1 text-accent-300 hover:underline disabled:opacity-40">
          <Save className="h-3 w-3" /> save tab
        </button>
      ),
      content: (
        <div className="p-2">
          <SavedQueriesTree
            queries={saved}
            onOpen={(q) => (tab && !sql.trim() ? replaceSql(q.sql_text) : void ws.addTab({ title: q.name, sql: q.sql_text }))}
            onRun={async (q) => {
              const t = await ws.addTab({ title: q.name, sql: q.sql_text });
              if (t) void ws.runQuery(t.id, q.sql_text, {});
            }}
            onDelete={async (q) => {
              if (confirm(`Delete saved query "${q.name}"?`)) {
                await api.del(`/api/workspaces/${workspace.id}/queries/${q.id}`);
                await loadSaved();
              }
            }}
          />
        </div>
      ),
    },
    {
      key: 'history',
      title: 'History',
      hideId: 'query.history',
      defaultHeight: 200,
      meta: (
        <button onClick={ws.clearHistory} className="text-zinc-500 hover:text-red-300" title="Clear history">
          <Trash2 className="h-3 w-3" />
        </button>
      ),
      content:
        ws.history.length === 0 ? (
          <p className="px-4 py-3 text-[11px] text-zinc-500">Executed queries appear here.</p>
        ) : (
          <div>
            {ws.history.map((h) => (
              <button key={h.id} onClick={() => replaceSql(h.sql)} className="block w-full border-b border-zinc-800/70 px-4 py-2 text-left last:border-0 hover:bg-zinc-800/50" title={h.sql}>
                <div className="truncate font-mono text-[11px] text-zinc-200">{h.sql.replace(/\s+/g, ' ')}</div>
                <div className="mt-0.5 font-mono text-[10px] text-zinc-500">
                  {new Date(h.at).toLocaleTimeString()} · {h.status === 'ok' ? `${h.durationMs} ms · ${h.rows.toLocaleString()} rows` : <span className="text-red-300">error</span>}
                </div>
              </button>
            ))}
          </div>
        ),
    },
  ].filter((sec) => !isHidden(sec.hideId));

  const runStatus = (
    <div className="flex min-w-0 items-center gap-2 text-xs text-zinc-500" data-testid="run-status">
      {result?.status === 'running' && <span className="inline-flex items-center gap-1.5 text-zinc-300"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-500" /> Running{result.rowCount > 0 && ` · ${result.rowCount.toLocaleString()} rows`}</span>}
      {executed && (
        <span className="flex min-w-0 items-center gap-1.5 truncate">
          <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', result.restoredAt ? 'bg-zinc-600' : 'bg-emerald-500')} />
          <span className="tabular-nums text-zinc-300">{result.durationMs} ms</span>
          <span>·</span>
          <span className="tabular-nums text-zinc-300">{result.rowCount.toLocaleString()}</span> rows
          <span>·</span>
          <span className="tabular-nums text-zinc-300">{result.columns.length}</span> cols
          {result.truncated && <span className="text-amber-500">· capped at {ws.maxRows.toLocaleString()}</span>}
          {result.restoredAt && <span title="Restored from this browser after a reload — press Run (⌘↵) to re-execute.">· restored, not re-run</span>}
          {result.engine === 'databricks' && <Badge tone="amber">databricks</Badge>}
          {result.statements.filter((st) => st.class !== 'read').map((st, i) => <Badge key={i} tone={st.class === 'destructive' ? 'red' : 'violet'}>{st.verb}</Badge>)}
        </span>
      )}
      {result?.status === 'error' && <span className="inline-flex items-center gap-1.5 text-red-400"><span className="h-1.5 w-1.5 rounded-full bg-red-500" /> {result.errorCode}</span>}
      {result?.status === 'approval' && <span className="inline-flex items-center gap-1.5 text-amber-500"><ShieldAlert className="h-3.5 w-3.5" /> approval required</span>}
    </div>
  );

  const editorPane = (
    <div className="flex h-full min-h-0 flex-col bg-zinc-950">
      {/* Query tabs */}
      <div className="flex h-9 shrink-0 items-stretch border-b border-zinc-800 bg-zinc-900">
        <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto" role="tablist" aria-label="Query tabs">
          {ws.tabs.map((t) => {
            const r = ws.results[t.id];
            const active = t.id === ws.activeTabId;
            return (
              <div key={t.id} role="tab" aria-selected={active} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && ws.selectTab(t.id)} onClick={() => ws.selectTab(t.id)} onDoubleClick={() => setRenaming(t.id)} className={cn('group relative flex max-w-[220px] shrink-0 cursor-pointer items-center gap-2 border-r border-zinc-800 px-3 text-[13px]', active ? 'bg-zinc-950 text-zinc-50' : 'text-zinc-500 hover:text-zinc-200')}>
                {active && <span className="absolute inset-x-0 top-0 h-[2px] bg-accent-500" />}
                {r?.status === 'running' ? (
                  <button className="flex h-4 w-4 items-center justify-center rounded text-red-400 hover:bg-red-500/15" title="Stop this tab's query" onClick={(e) => { e.stopPropagation(); ws.cancelQuery(t.id); }}>
                    <Square className="h-2.5 w-2.5" />
                  </button>
                ) : (
                  <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', r?.status === 'error' ? 'bg-red-500' : r?.status === 'done' ? 'bg-emerald-500' : r?.status === 'approval' ? 'bg-amber-500' : 'bg-zinc-700')} />
                )}
                {renaming === t.id ? (
                  <input autoFocus defaultValue={t.title} className="w-28 bg-transparent outline-none" onBlur={(e) => { void ws.renameTab(t.id, e.target.value); setRenaming(null); }} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setRenaming(null); }} />
                ) : (
                  <span className="truncate">{t.title}</span>
                )}
                <button className={cn('rounded p-0.5 hover:bg-zinc-800', active ? 'opacity-60 hover:opacity-100' : 'opacity-0 group-hover:opacity-100')} onClick={(e) => { e.stopPropagation(); void ws.closeTab(t.id); }} aria-label={`Close ${t.title}`} title="Close tab">
                  <X className="h-3 w-3" />
                </button>
              </div>
            );
          })}
          <button className="flex shrink-0 items-center gap-1 px-3 text-xs text-zinc-500 hover:text-zinc-200" onClick={() => void ws.addTab()} title="New tab">
            <Plus className="h-3.5 w-3.5" /> New tab
          </button>
        </div>
      </div>

      {/* Run toolbar */}
      {!isHidden('query.toolbar') && (
        <div className="group/tb flex h-10 shrink-0 items-center gap-2 border-b border-zinc-800/70 px-2">
          {result?.status === 'running' ? (
            <Button size="sm" variant="danger" onClick={() => tab && ws.cancelQuery(tab.id)}>
              <Square className="h-3 w-3" /> Stop
            </Button>
          ) : (
            <Button size="sm" variant="primary" onClick={() => run(null)} disabled={!sql.trim()} title={tabEngineConn ? `Runs on ${tabEngineConn.name} (Databricks SQL warehouse)` : 'Run the editor, or the selection (⌘↵)'} data-testid="run-query">
              <Play className="h-3 w-3" /> {tabEngineConn ? `Run on ${tabEngineConn.name}` : 'Run'} <span className="ml-0.5 font-mono text-[10px] opacity-70">⌘↵</span>
            </Button>
          )}
          {(ws.remoteEngines.length > 0 || tabEngine) && tab && (
            <Select uiSize="sm" value={tab.engine ?? ''} onChange={(e) => void ws.setTabEngine(tab.id, e.target.value || null)} title="Which engine executes this tab">
              <option value="">DuckDB (local)</option>
              {ws.remoteEngines.map((c) => <option key={c.id} value={lakehouseEngine(c.id)}>Databricks · {c.name}</option>)}
              {tabEngine && !tabEngineConn && <option value={tab.engine ?? ''}>remote (connection removed)</option>}
            </Select>
          )}
          <div className="mx-1 h-4 w-px bg-zinc-800" />
          {runStatus}
          {result?.status === 'error' && (
            <Button size="sm" variant="ghost" onClick={() => { cp.toggle(true); if (wsId) void cp.send({ workspaceId: wsId, message: '', action: 'fix', activeSql: sql, errorMessage: result.error }); }}>
              <Wrench className="h-3 w-3" /> Fix with AI
            </Button>
          )}
          {executed && result.engine === 'databricks' && result.connectionId && canWrite && (
            <Button size="sm" variant="ghost" onClick={() => setMaterialize({ open: true, connectionId: result.connectionId!, connectionName: tabEngineConn?.name ?? 'warehouse', sql: result.sql ?? sql, table: (tab?.title ?? 'remote').replace(/[^A-Za-z0-9_]/g, '_').toLowerCase() || 'remote_result', busy: false, error: null, done: null })} title="Run this query on the warehouse and store the result as a DuckDB table you can join with local data">
              <DatabaseZap className="h-3 w-3" /> Materialise into DuckDB
            </Button>
          )}
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <Select uiSize="sm" value={ws.maxRows} onChange={(e) => ws.setMaxRows(Number(e.target.value))} title="Row limit for the grid" aria-label="Row limit">
              {[100, 500, 1000, 5000].map((n) => <option key={n} value={n}>{n.toLocaleString()} rows</option>)}
            </Select>
            <Button size="sm" variant="ghost" onClick={openSave} disabled={!sql.trim() || !canWrite} title="Save to the query library"><Save className="h-3.5 w-3.5" /> Save</Button>
            <Menu
              width="w-60"
              trigger={(open, toggle) => (
                <IconButton label="More query actions" onClick={toggle} active={open}>
                  <MoreHorizontal className="h-4 w-4" />
                </IconButton>
              )}
            >
              {(close) => (
                <>
                  <MenuItem icon={<Play className="h-3.5 w-3.5" />} hint="⌘↵" onClick={() => { close(); run(null); }}>Run all</MenuItem>
                  <MenuItem icon={<Workflow className="h-3.5 w-3.5" />} onClick={() => { close(); setDbtModel(sql); }}>Save as dbt model…</MenuItem>
                  <MenuItem icon={<Send className="h-3.5 w-3.5" />} onClick={() => { close(); try { sessionStorage.setItem(REVERSE_DRAFT_KEY, JSON.stringify({ sql, name: tab?.title && !/^Query \d+$/.test(tab.title) ? tab.title : '' })); } catch { /* storage unavailable */ } location.hash = '#/connections/reverse'; }}>Send results to…</MenuItem>
                  <MenuItem icon={copied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />} onClick={() => { navigator.clipboard.writeText(sql).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }); }}>Copy SQL</MenuItem>
                  <MenuItem icon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => { close(); replaceSql(''); }}>Clear editor</MenuItem>
                  <MenuDivider />
                  <MenuItem icon={<FileUp className="h-3.5 w-3.5" />} onClick={() => { close(); importInput.current?.click(); }}>Import .sql…</MenuItem>
                  <MenuItem icon={<Download className="h-3.5 w-3.5" />} onClick={() => { close(); exportTab(); }}>Export tab as .sql</MenuItem>
                  <MenuItem icon={<FolderOpen className="h-3.5 w-3.5" />} onClick={() => { close(); exportAll(); }}>Export all tabs</MenuItem>
                  <MenuDivider />
                  <MenuItem icon={<PanelLeft className="h-3.5 w-3.5" />} onClick={() => { close(); setSidebarCollapsed((c) => !c); }}>{sidebarCollapsed ? 'Show schema panel' : 'Hide schema panel'}</MenuItem>
                </>
              )}
            </Menu>
            <input ref={importInput} type="file" accept=".sql,.txt,text/plain" multiple className="hidden" onChange={async (e) => { await importSqlFiles([...(e.target.files ?? [])]); e.target.value = ''; }} />
          </div>
        </div>
      )}

      {/* Editor */}
      <div
        className={cn('relative min-h-0 flex-1 overflow-hidden', dropping && 'ring-2 ring-inset ring-accent-500')}
        onDragOver={(e) => { if ([...e.dataTransfer.items].some((i) => i.kind === 'file')) { e.preventDefault(); setDropping(true); } }}
        onDragLeave={() => setDropping(false)}
        onDrop={async (e) => { e.preventDefault(); setDropping(false); await importSqlFiles([...e.dataTransfer.files]); }}
      >
        {tab ? <SqlEditor key={tab.id} ref={editor} value={sql} initialCursor={ws.cursors[tab.id] ?? tab.cursor_position} onChange={(v, cursor) => ws.setDraft(tab.id, v, cursor)} onCursorChange={onCursor} onRun={(sel) => run(sel)} schema={schemaHints} /> : <Empty title="No tab open" action={<Button size="sm" onClick={() => void ws.addTab()}><Plus className="h-3.5 w-3.5" /> New tab</Button>} />}
        {dropping && <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-accent-500/10 text-[13px] text-zinc-100">Drop .sql files to open them as tabs</div>}
      </div>
    </div>
  );

  const resultsPane = (
    <div className="flex h-full min-h-0 flex-col border-t border-zinc-800 bg-zinc-950">
      <div className="flex h-9 shrink-0 items-center gap-3 border-b border-zinc-800 pl-3 pr-2">
        <Tabs<View>
          size="sm"
          className="border-b-0"
          value={view}
          onChange={setView}
          tabs={[
            { id: 'table', label: 'Results' },
            { id: 'chart', label: 'Chart' },
            { id: 'profile', label: 'Profile' },
            { id: 'plan', label: 'Explain' },
            { id: 'schema', label: 'Schema' },
            { id: 'explore', label: 'Explore' },
          ]}
        />
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {view === 'table' && executed && result.columns.length > 0 && (
            <>
              <div className="relative">
                <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-zinc-500" />
                <input value={gridFilter} onChange={(e) => setGridFilter(e.target.value)} placeholder="Filter rows" aria-label="Filter result rows" className="h-[26px] w-40 rounded-md border border-zinc-800 bg-zinc-950 pl-6 pr-2 text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-accent-500 focus:outline-none" />
              </div>
              {gridFilter && <span className="text-xs tabular-nums text-zinc-500">{shownRows.length.toLocaleString()} of {result.rows.length.toLocaleString()}</span>}
              <IconButton label={rowsCopied ? 'Copied' : 'Copy rows (tab-separated)'} onClick={() => { void navigator.clipboard.writeText(rowsToTsv(result.columns, shownRows)).then(() => { setRowsCopied(true); setTimeout(() => setRowsCopied(false), 1200); }); }}>
                {rowsCopied ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
              </IconButton>
            </>
          )}
          <Menu
            width="w-60"
            trigger={(open, toggle) => (
              <Button size="sm" variant="ghost" onClick={toggle} disabled={!sql.trim()} aria-expanded={open}>
                <Download className="h-3.5 w-3.5" /> {exporting ? `Exporting ${exporting}…` : 'Export'}
              </Button>
            )}
          >
            {(close) => (
              <>
                <div className="px-2 pb-1 pt-1 text-[11px] text-zinc-500">The complete result, exported on the server (not capped by the grid)</div>
                {(['csv', 'parquet', 'json', 'arrow'] as const).map((fmt) => (
                  <MenuItem key={fmt} icon={<Download className="h-3.5 w-3.5" />} onClick={() => { close(); void exportRows(fmt); }}>{fmt.toUpperCase()}</MenuItem>
                ))}
              </>
            )}
          </Menu>
        </div>
      </div>
      <div className="min-h-0 flex-1">
        {view === 'table' && (
          <>
            {result?.status === 'approval' && result.challenge && (
              <div className="m-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4">
                <div className="flex items-center gap-2 text-[13px] font-semibold text-zinc-100"><ShieldAlert className="h-4 w-4 text-amber-500" /> This statement changes data</div>
                <p className="mt-1 text-xs text-zinc-400">{result.challenge.reason}</p>
                <ul className="mt-2 space-y-1 font-mono text-[11px] text-zinc-400">{result.challenge.statements.map((st) => <li key={st.index}><Badge tone="red">{st.verb}</Badge> {st.preview}</li>)}</ul>
                <Button size="sm" variant="danger" className="mt-3" onClick={() => run(null, false)}>Approve and run</Button>
              </div>
            )}
            {result?.status === 'error' && (
              <div className="m-3 rounded-lg border border-red-500/30 bg-red-500/5 p-4">
                <div className="mb-1 text-xs font-semibold text-red-400">{result.errorCode}</div>
                <pre className="whitespace-pre-wrap font-mono text-xs text-zinc-200">{result.error}</pre>
              </div>
            )}
            {(result?.status === 'done' || result?.status === 'running') && result.columns.length > 0 && <ResultsGrid columns={result.columns} rows={result.rows} filter={gridFilter} onVisibleRows={setShownRows} />}
            {result?.status === 'done' && result.columns.length === 0 && <Empty title="Statement executed" hint="It returned no rows." />}
            {(!result || result.status === 'idle') && <Empty icon={<Play />} title="Run a query" hint="⌘/Ctrl + Enter runs the editor, or just the selection. Pick a table or file on the left to insert or preview it." />}
          </>
        )}
        {view === 'schema' && (
          <SchemaPanel
            workspaceId={workspace.id}
            target={inspect}
            remoteConnectionId={inspectRemote}
            onQuery={(q, title) => { void ws.addTab({ title, sql: q, engine: inspectRemote ? lakehouseEngine(inspectRemote) : null }); if (inspectRemote) void ws.loadRemoteEngines(); setView('table'); }}
            onProfile={(t) => void doProfile(t)}
            onAskCopilot={(t) => { cp.setTargets([t]); cp.toggle(true); }}
          />
        )}
        {view === 'chart' && tab && (chartable ? <ChartPanel columns={result!.columns} rows={result!.rows} config={tab.chart_config} onChange={(c: ChartConfig) => void ws.setChart(tab.id, c)} /> : <Empty title="Run a query to chart it" />)}
        {view === 'plan' && <PlanView plan={plan} loading={planLoading} onExplain={() => void explain(false)} onAnalyze={() => void explain(true)} />}
        {view === 'explore' && (
          // Explores the tab's SQL as it is in the editor (a single SELECT); the view is rebuilt when the SQL changes.
          <ExploreView workspaceId={workspace.id} source={sql.trim() && /^(select|with|from|pivot|unpivot)\b/i.test(sql.trim()) && !/;\s*\S/.test(sql.trim()) ? { kind: 'query', target: sql.trim(), label: tab?.title } : null} />
        )}
        {view === 'profile' && (
          <ProfilePanel
            profile={profile}
            loading={profileLoading}
            onProfile={doProfile}
            defaultTarget={ws.catalog?.files[0]?.path ?? ws.catalog?.objects[0]?.name ?? ''}
            provenance={profileMeta && <CacheChip state={profileLoading ? 'revalidating' : 'fresh'} computedAt={profileMeta.computedAt} fromCache={profileMeta.fromCache} serverCached={profileMeta.serverCached} onRefresh={() => void doProfile(profileMeta.target, true)} verb="profiled" />}
          />
        )}
      </div>
      {executed && view === 'table' && result.columns.length > 0 && !isHidden('query.columns') && (
        <div className="group/cols flex h-7 shrink-0 items-center gap-x-4 overflow-hidden border-t border-zinc-800 px-3 font-mono text-[11px]">
          {result.columns.slice(0, 12).map((c) => <span key={c.name} className="flex shrink-0 items-center gap-1.5"><span className="text-zinc-300">{c.name}</span><TypePill type={c.type} /></span>)}
          {result.columns.length > 12 && <span className="shrink-0 text-zinc-500">+{result.columns.length - 12} more</span>}
          <HideButton id="query.columns" className="ml-auto opacity-0 group-hover/cols:opacity-100" />
        </div>
      )}
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SplitPane
        direction="horizontal"
        storageKey="workbench.sidebar"
        defaultSize={264}
        min={200}
        max={640}
        minSecondary={480}
        collapsed={sidebarCollapsed || isHidden('query.sidebar')}
        onExpand={() => setSidebarCollapsed(false)}
        className="min-h-0 flex-1"
        primary={
          <div className="group/sb relative h-full overflow-hidden border-r border-zinc-800 bg-zinc-900" aria-label="Schema explorer">
            <StackedPanes storageKey="workbench.sidebar" sections={sidebarSections} />
            {sidebarSections.length === 0 && <div className="p-4 text-[11px] text-zinc-500">All side bar sections are hidden — restore them in Settings → Appearance → Layout.</div>}
          </div>
        }
        secondary={
          isHidden('query.results') ? (
            <div className="h-full">{editorPane}</div>
          ) : (
            <SplitPane direction="vertical" storageKey="workbench.editor" defaultSize={340} min={140} max={1600} minSecondary={160} className="h-full" primary={editorPane} secondary={resultsPane} />
          )
        }
      />

      <CloudWizard open={wizard} onClose={() => setWizard(false)} onCreated={() => setExplorerKey((k) => k + 1)} />
      <LakehouseWizard open={lakeWizard} onClose={() => setLakeWizard(false)} onCreated={() => { setExplorerKey((k) => k + 1); void ws.loadRemoteEngines(); }} />
      <Modal open={materialize.open} onClose={() => setMaterialize((m) => ({ ...m, open: false }))} title="Materialise into DuckDB">
        <div className="space-y-3">
          <p className="text-xs text-zinc-400">Runs the statement on <b className="text-zinc-200">{materialize.connectionName}</b> (Databricks SQL warehouse) and stores the rows as a DuckDB table in this workspace, so you can join them with local files and tables.</p>
          <div>
            <Label>Table name</Label>
            <Input value={materialize.table} onChange={(e) => setMaterialize((m) => ({ ...m, table: e.target.value }))} className="font-mono" />
          </div>
          <div>
            <Label>SQL (Databricks dialect)</Label>
            <textarea value={materialize.sql} onChange={(e) => setMaterialize((m) => ({ ...m, sql: e.target.value }))} rows={5} className="w-full rounded-md border border-zinc-700 bg-zinc-900 p-2 font-mono text-xs text-zinc-100 focus:border-accent-500 focus:outline-none" />
          </div>
          {materialize.error && <div className="rounded-md border border-red-900 bg-red-950/50 px-3 py-2 text-xs text-red-200">{materialize.error}</div>}
          {materialize.done && <div className="rounded-md border border-emerald-900 bg-emerald-950/40 px-3 py-2 text-xs text-emerald-200">{materialize.done}</div>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setMaterialize((m) => ({ ...m, open: false }))}>{materialize.done ? 'Close' : 'Cancel'}</Button>
            {materialize.done ? (
              <Button variant="primary" onClick={() => { void ws.addTab({ title: materialize.table, sql: `SELECT * FROM ${materialize.table} LIMIT 100;` }); setMaterialize((m) => ({ ...m, open: false })); }}><Layers className="h-3.5 w-3.5" /> Query it</Button>
            ) : (
              <Button variant="primary" onClick={runMaterialize} loading={materialize.busy} disabled={!materialize.table.trim() || !materialize.sql.trim()}><DatabaseZap className="h-3.5 w-3.5" /> Materialise</Button>
            )}
          </div>
        </div>
      </Modal>
      <FolderPicker
        open={picker}
        workspaceId={workspace.id}
        onClose={() => setPicker(false)}
        onPick={async (path) => {
          await api.post(`/api/workspaces/${workspace.id}/folders`, { path });
          setExplorerKey((k) => k + 1);
          void ws.loadCatalog(true);
        }}
      />

      {dbtModel !== null && wsId && <SaveDbtModelDialog workspaceId={wsId} sql={dbtModel} suggestedName={tab?.title} onClose={() => setDbtModel(null)} />}
      <Modal open={saveModal.open} onClose={() => setSaveModal({ ...saveModal, open: false })} title={saveModal.existing ? 'Update saved query' : 'Save query'}>
        <div className="space-y-3">
          <div><Label>Name</Label><Input value={saveModal.name} onChange={(e) => setSaveModal({ ...saveModal, name: e.target.value })} autoFocus /></div>
          <div className="grid grid-cols-2 gap-3">
            <div><Label>Folder</Label><Input value={saveModal.folder} onChange={(e) => setSaveModal({ ...saveModal, folder: e.target.value })} placeholder="finance/daily" className="font-mono" /></div>
            <div><Label>Tags</Label><Input value={saveModal.tags} onChange={(e) => setSaveModal({ ...saveModal, tags: e.target.value })} placeholder="revenue, kpi" /></div>
          </div>
          <div><Label>Description</Label><Input value={saveModal.description} onChange={(e) => setSaveModal({ ...saveModal, description: e.target.value })} placeholder="What this query answers" /></div>
          <pre className="max-h-32 overflow-auto rounded-md border border-zinc-800 bg-zinc-950 p-2 font-mono text-[11px] text-zinc-400">{sql}</pre>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setSaveModal({ ...saveModal, open: false })}>Cancel</Button>
            <Button variant="primary" onClick={doSave} disabled={!saveModal.name.trim()}>{saveModal.existing ? 'Update' : 'Save'}</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
