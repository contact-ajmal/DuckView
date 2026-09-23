import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Play, Square, Plus, X, Download, ShieldAlert, Trash2, Copy, Check, FileUp, RefreshCw, Save, Bot, Wrench, FolderOpen, PanelLeft, Layers, DatabaseZap, Workflow } from 'lucide-react';
import { useWorkspace, useWorkspaceAccess, lakehouseEngine, engineConnectionId } from '../../store/workspace';
import { useAuth } from '../../store/auth';
import { fetchCached } from '../../lib/useCached';
import { CacheChip } from '../../components/CacheChip';
import { useCopilot } from '../../store/copilot';
import { api, exportAndDownload, tabsToSql, sqlToTabs, type ChartConfig, type SavedQuery } from '../../api/client';
import { SqlEditor, type SqlEditorHandle } from './SqlEditor';
import { ResultsGrid } from './ResultsGrid';
import { ChartPanel } from './ChartPanel';
import { PlanView, type PlanResult } from './PlanView';
import { ProfilePanel, type ProfileResult } from './ProfilePanel';
import { ExploreView } from '../explore/ExploreView';
import { SchemaTree } from './SchemaTree';
import { SavedQueriesTree } from './SavedQueries';
import { SaveDbtModelDialog } from '../transform/SaveDbtModelDialog';
import { Explorer, type ExplorerNode } from '../explorer/Explorer';
import { SchemaPanel } from '../explorer/SchemaPanel';
import { FolderPicker } from '../explorer/FolderPicker';
import { CloudWizard } from '../explorer/CloudWizard';
import { LakehouseWizard } from '../explorer/LakehouseWizard';
import { registerCopilotHost } from '../copilot/CopilotDrawer';
import { Eyebrow, PageTitle, Panel, TypePill } from '../../components/layout';
import { SplitPane, StackedPanes, usePersisted } from '../../components/panes';
import { useLayout } from '../../store/layout';
import { HideButton } from '../../components/LayoutMenu';
import { Badge, Button, Empty, Input, Label, Modal, Select, cn } from '../../components/ui';

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

  const editorPane = (
    <Panel bodyClassName="flex min-h-0 flex-1 flex-col p-0" className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-stretch border-b border-zinc-800">
        <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto">
          {ws.tabs.map((t) => {
            const r = ws.results[t.id];
            const active = t.id === ws.activeTabId;
            return (
              <div key={t.id} onClick={() => ws.selectTab(t.id)} onDoubleClick={() => setRenaming(t.id)} className={cn('group flex max-w-[240px] shrink-0 cursor-pointer items-center gap-2 border-r border-zinc-800 px-3.5 py-2 text-xs', active ? 'bg-zinc-800/60 text-zinc-50' : 'text-zinc-400 hover:text-zinc-200')}>
                {r?.status === 'running' ? (
                  <button className="flex h-4 w-4 items-center justify-center rounded bg-red-900/60 text-red-200 hover:bg-red-800" title="Stop this tab's query" onClick={(e) => { e.stopPropagation(); ws.cancelQuery(t.id); }}>
                    <Square className="h-2.5 w-2.5" />
                  </button>
                ) : (
                  <span className={cn('h-1.5 w-1.5 rounded-full', r?.status === 'error' ? 'bg-red-400' : r?.status === 'done' ? 'bg-emerald-400' : r?.status === 'approval' ? 'bg-amber-400' : 'bg-zinc-600')} />
                )}
                {renaming === t.id ? (
                  <input autoFocus defaultValue={t.title} className="w-28 bg-transparent outline-none" onBlur={(e) => { void ws.renameTab(t.id, e.target.value); setRenaming(null); }} onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setRenaming(null); }} />
                ) : (
                  <span className="truncate">{t.title}</span>
                )}
                {r?.status === 'done' && r.durationMs != null && <span className="font-mono text-[10px] text-zinc-500">{r.durationMs} ms</span>}
                <button className="rounded p-0.5 opacity-0 hover:bg-zinc-700 group-hover:opacity-100" onClick={(e) => { e.stopPropagation(); void ws.closeTab(t.id); }} title="Close tab">
                  <X className="h-3 w-3" />
                </button>
              </div>
            );
          })}
          <button className="flex items-center gap-1 px-3 text-xs text-zinc-500 hover:text-zinc-200" onClick={() => void ws.addTab()}>
            <Plus className="h-3.5 w-3.5" /> New tab
          </button>
        </div>
      </div>

      <div
        className={cn('relative m-2 min-h-0 flex-1 overflow-hidden rounded-lg border bg-zinc-950', dropping ? 'border-accent-500' : 'border-zinc-800')}
        onDragOver={(e) => { if ([...e.dataTransfer.items].some((i) => i.kind === 'file')) { e.preventDefault(); setDropping(true); } }}
        onDragLeave={() => setDropping(false)}
        onDrop={async (e) => { e.preventDefault(); setDropping(false); await importSqlFiles([...e.dataTransfer.files]); }}
      >
        {tab ? <SqlEditor key={tab.id} ref={editor} value={sql} initialCursor={ws.cursors[tab.id] ?? tab.cursor_position} onChange={(v, cursor) => ws.setDraft(tab.id, v, cursor)} onCursorChange={onCursor} onRun={(sel) => run(sel)} schema={schemaHints} /> : <Empty title="No tab" />}
        {dropping && <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-accent-600/10 text-sm text-accent-100">Drop .sql files to open them as tabs</div>}
      </div>

      {!isHidden('query.toolbar') && <div className="group/tb flex shrink-0 flex-wrap items-center gap-3 border-t border-zinc-800 px-3 py-2">
        {result?.status === 'running' ? (
          <button onClick={() => tab && ws.cancelQuery(tab.id)} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-red-800 bg-red-950/50 px-3 text-xs font-medium text-red-200 hover:bg-red-900/60">
            <Square className="h-3.5 w-3.5" /> Stop
          </button>
        ) : (
          <button onClick={() => run(null)} disabled={!sql.trim()} className={cn('inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-xs font-medium disabled:opacity-40', tabEngine ? 'border-amber-700/70 bg-amber-600/20 text-amber-100 hover:bg-amber-600/30' : 'border-accent-600/70 bg-accent-600/25 text-accent-100 hover:bg-accent-600/40')} title={tabEngineConn ? `Runs on ${tabEngineConn.name} (Databricks SQL warehouse)` : 'Runs in DuckDB'}>
            <Play className="h-3.5 w-3.5" /> {tabEngineConn ? `Run on ${tabEngineConn.name}` : 'Run'} <kbd className="ml-1 rounded border border-zinc-700 bg-zinc-900 px-1 font-mono text-[10px] text-zinc-400">⌘↵</kbd>
          </button>
        )}
        {(ws.remoteEngines.length > 0 || tabEngine) && tab && (
          <Select value={tab.engine ?? ''} onChange={(e) => void ws.setTabEngine(tab.id, e.target.value || null)} className="h-7 text-[11px]" title="Which engine executes this tab">
            <option value="">DuckDB (local)</option>
            {ws.remoteEngines.map((c) => <option key={c.id} value={lakehouseEngine(c.id)}>Databricks · {c.name}</option>)}
            {tabEngine && !tabEngineConn && <option value={tab.engine ?? ''}>remote (connection removed)</option>}
          </Select>
        )}
        <button onClick={() => run(null)} disabled={!sql.trim() || result?.status === 'running'} className="text-xs text-zinc-300 hover:text-zinc-50 disabled:opacity-40">Run all</button>
        <button onClick={() => replaceSql('')} className="text-xs text-zinc-300 hover:text-zinc-50">Clear</button>
        <button onClick={openSave} disabled={!sql.trim() || !canWrite} className="inline-flex items-center gap-1 text-xs text-zinc-300 hover:text-zinc-50 disabled:opacity-40"><Save className="h-3.5 w-3.5" /> Save</button>
        <button onClick={() => setDbtModel(sql)} disabled={!sql.trim() || !canWrite} className="inline-flex items-center gap-1 text-xs text-zinc-300 hover:text-zinc-50 disabled:opacity-40" title="Save this SELECT as a model of a dbt project (Transform → dbt)"><Workflow className="h-3.5 w-3.5" /> dbt model</button>
        <div className="min-w-0 font-mono text-[11px] text-zinc-500">
          {result?.status === 'running' && <span className="text-accent-300">● running… {result.rowCount > 0 && `${result.rowCount.toLocaleString()} rows`}</span>}
          {executed && (
            <span>
              <span className={result.restoredAt ? 'text-zinc-500' : 'text-emerald-400'}>●</span> <span className="text-zinc-200">{result.durationMs} ms</span> · <span className="text-zinc-200">{result.rowCount.toLocaleString()}</span> rows · <span className="text-zinc-200">{result.columns.length}</span> cols
              {result.restoredAt && <span className="text-zinc-500" title="Restored from this browser after a reload — press Run (⌘↵) to re-execute."> · result from {new Date(result.restoredAt).toLocaleTimeString()}, not re-run</span>}
              {result.truncated && <span className="text-amber-300"> · capped at {ws.maxRows.toLocaleString()}</span>}
              {result.engine === 'databricks' && <Badge tone="amber" className="ml-1.5">databricks</Badge>}
              {result.statements.map((s, i) => <Badge key={i} tone={s.class === 'read' ? 'zinc' : s.class === 'destructive' ? 'red' : 'violet'} className="ml-1.5">{s.verb}</Badge>)}
              {result.engine === 'databricks' && result.connectionId && canWrite && (
                <button onClick={() => setMaterialize({ open: true, connectionId: result.connectionId!, connectionName: tabEngineConn?.name ?? 'warehouse', sql: result.sql ?? sql, table: (tab?.title ?? 'remote').replace(/[^A-Za-z0-9_]/g, '_').toLowerCase() || 'remote_result', busy: false, error: null, done: null })} className="ml-2 inline-flex items-center gap-1 rounded border border-fuchsia-800 bg-fuchsia-950/40 px-1.5 py-0.5 text-[10px] text-fuchsia-200 hover:bg-fuchsia-900/50" title="Run this query on the warehouse and store the result as a DuckDB table you can join with local data">
                  <DatabaseZap className="h-3 w-3" /> Materialise into DuckDB
                </button>
              )}
            </span>
          )}
          {result?.status === 'error' && (
            <span className="text-red-300">
              ● {result.errorCode}
              <button onClick={() => { cp.toggle(true); if (wsId) void cp.send({ workspaceId: wsId, message: '', action: 'fix', activeSql: sql, errorMessage: result.error }); }} className="ml-2 inline-flex items-center gap-1 rounded border border-amber-800 bg-amber-950/40 px-1.5 py-0.5 text-[10px] text-amber-200 hover:bg-amber-900/50">
                <Wrench className="h-3 w-3" /> Fix with Copilot
              </button>
            </span>
          )}
        </div>
        <div className="ml-auto flex items-center gap-3 text-xs text-zinc-400">
          <Select value={ws.maxRows} onChange={(e) => ws.setMaxRows(Number(e.target.value))} className="h-7 text-[11px]" title="Row limit for the grid">
            {[100, 500, 1000, 5000].map((n) => <option key={n} value={n}>{n.toLocaleString()} rows</option>)}
          </Select>
          <button className="inline-flex items-center gap-1 hover:text-zinc-100" onClick={() => { navigator.clipboard.writeText(sql).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }); }}>
            {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />} Copy
          </button>
          <HideButton id="query.toolbar" className="opacity-0 group-hover/tb:opacity-100" />
        </div>
      </div>}
    </Panel>
  );

  const resultsPane = (
    <Panel
      hideId="query.results"
      bodyClassName="flex min-h-0 flex-1 flex-col p-0"
      className="flex h-full min-h-0 flex-col"
      title={
        <span className="flex flex-wrap items-center gap-2">
          <span className="whitespace-nowrap">Results {tab && <span className="text-zinc-500">· {tab.title}</span>}</span>
          <span className="flex rounded-md border border-zinc-800 p-0.5 font-normal">
            {(['table', 'schema', 'chart', 'plan', 'profile', 'explore'] as View[]).map((v) => <button key={v} onClick={() => setView(v)} className={cn('rounded px-2.5 py-0.5 text-[11px] capitalize', view === v ? 'bg-zinc-800 text-zinc-50' : 'text-zinc-400 hover:text-zinc-200')} title={v === 'explore' ? 'Interactive cross-filtered charts of this query (Mosaic)' : undefined}>{v}</button>)}
          </span>
        </span>
      }
      actions={
        <div className="flex items-center gap-3 font-mono text-[11px] text-zinc-400">
          <span className="text-zinc-600" title="Full result exported server-side via COPY TO and streamed from disk">Download</span>
          {(['csv', 'parquet', 'json', 'arrow'] as const).map((fmt) => (
            <button key={fmt} disabled={!sql.trim() || !!exporting} onClick={() => void exportRows(fmt)} className="inline-flex items-center gap-1 uppercase hover:text-zinc-100 disabled:opacity-40" title={`Export the complete result as ${fmt} (not capped by the grid)`}>
              <Download className="h-3 w-3" /> {exporting === fmt ? '…' : fmt}
            </button>
          ))}
        </div>
      }
    >
      <div className="min-h-0 flex-1">
        {view === 'table' && (
          <>
            {result?.status === 'approval' && result.challenge && (
              <div className="m-3 rounded-lg border border-amber-800 bg-amber-950/40 p-4">
                <div className="flex items-center gap-2 text-sm font-semibold text-amber-200"><ShieldAlert className="h-4 w-4" /> Approval required</div>
                <p className="mt-1 text-xs text-amber-100/80">{result.challenge.reason}</p>
                <ul className="mt-2 space-y-1 font-mono text-[11px] text-amber-100/70">{result.challenge.statements.map((s) => <li key={s.index}><Badge tone="red">{s.verb}</Badge> {s.preview}</li>)}</ul>
                <button onClick={() => run(null, false)} className="mt-3 inline-flex h-8 items-center gap-1.5 rounded-md border border-red-800 bg-red-950/60 px-3 text-xs font-medium text-red-100 hover:bg-red-900/70">Approve & execute</button>
              </div>
            )}
            {result?.status === 'error' && (
              <div className="m-3 rounded-lg border border-red-900 bg-red-950/40 p-4 font-mono text-xs text-red-200">
                <div className="mb-1 font-sans text-[11px] font-semibold uppercase tracking-wide text-red-400">{result.errorCode}</div>
                <pre className="whitespace-pre-wrap">{result.error}</pre>
              </div>
            )}
            {(result?.status === 'done' || result?.status === 'running') && result.columns.length > 0 && <ResultsGrid columns={result.columns} rows={result.rows} />}
            {result?.status === 'done' && result.columns.length === 0 && <Empty title="Statement executed" hint="No result set returned." />}
            {(!result || result.status === 'idle') && <Empty icon={<Play className="h-8 w-8" />} title="Run a query" hint="⌘/Ctrl + Enter runs the editor contents, or just the selection. Click a file in the Explorer to preview its schema; double-click to query it. Drag the splitters to resize any panel." />}
          </>
        )}
        {view === 'schema' && (
          <SchemaPanel
            workspaceId={workspace.id}
            target={inspect}
            remoteConnectionId={inspectRemote}
            onQuery={(s, title) => { void ws.addTab({ title, sql: s, engine: inspectRemote ? lakehouseEngine(inspectRemote) : null }); if (inspectRemote) void ws.loadRemoteEngines(); setView('table'); }}
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
      {executed && result.columns.length > 0 && !isHidden('query.columns') && (
        <div className="group/cols flex shrink-0 flex-wrap gap-x-5 gap-y-1 border-t border-zinc-800 px-4 py-1.5 font-mono text-[11px]">
          {result.columns.slice(0, 12).map((c) => <span key={c.name} className="flex items-center gap-1.5"><span className="text-zinc-200">{c.name}</span><TypePill type={c.type} /></span>)}
          {result.columns.length > 12 && <span className="text-zinc-500">+{result.columns.length - 12} more</span>}
          <HideButton id="query.columns" className="ml-auto opacity-0 group-hover/cols:opacity-100" />
        </div>
      )}
    </Panel>
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      {!isHidden('query.header') && <div className="group/ph flex shrink-0 flex-wrap items-center justify-between gap-3 px-5 pb-3 pt-4">
        <div className="flex items-center gap-3">
          <button onClick={() => setSidebarCollapsed((c) => !c)} className={cn('rounded-md border p-1.5', sidebarCollapsed ? 'border-zinc-800 text-zinc-500 hover:text-zinc-200' : 'border-zinc-800 bg-zinc-900/70 text-zinc-300')} title={sidebarCollapsed ? 'Show side bar' : 'Hide side bar'}>
            <PanelLeft className="h-4 w-4" />
          </button>
          <div>
            <Eyebrow>Query tool</Eyebrow>
            <PageTitle className="text-xl">SQL workbench</PageTitle>
          </div>
        </div>
        <div className="flex items-center gap-3 text-xs text-zinc-400">
          <button className="inline-flex items-center gap-1 hover:text-zinc-100" onClick={() => importInput.current?.click()} title="Import .sql (tabs demarcated by -- @duckview-tab: open as separate tabs)">
            <FileUp className="h-3.5 w-3.5" /> Import .sql
          </button>
          <input ref={importInput} type="file" accept=".sql,.txt,text/plain" multiple className="hidden" onChange={async (e) => { await importSqlFiles([...(e.target.files ?? [])]); e.target.value = ''; }} />
          <button className="inline-flex items-center gap-1 hover:text-zinc-100" onClick={exportTab} title="Download this tab as .sql">
            <Download className="h-3.5 w-3.5" /> Export tab
          </button>
          <button className="inline-flex items-center gap-1 hover:text-zinc-100" onClick={exportAll} title="Download every tab as one .sql file with -- @duckview-tab markers">
            <FolderOpen className="h-3.5 w-3.5" /> Export all
          </button>
          <button className={cn('inline-flex items-center gap-1 rounded-md border px-2 py-1', cp.open ? 'border-accent-600/60 bg-accent-600/20 text-accent-100' : 'border-zinc-800 hover:text-zinc-100')} onClick={() => cp.toggle()} title="DuckCopilot">
            <Bot className="h-3.5 w-3.5" /> Copilot
          </button>
          <HideButton id="query.header" className="opacity-0 group-hover/ph:opacity-100" />
        </div>
      </div>}

      <SplitPane
        direction="horizontal"
        storageKey="workbench.sidebar"
        defaultSize={290}
        min={200}
        max={640}
        minSecondary={480}
        collapsed={sidebarCollapsed || isHidden('query.sidebar')}
        onExpand={() => setSidebarCollapsed(false)}
        className={cn('min-h-0 flex-1 px-5 pb-4', isHidden('query.header') && 'pt-4')}
        primary={
          <div className="group/sb relative h-full overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/40">
            <StackedPanes storageKey="workbench.sidebar" sections={sidebarSections} />
            {sidebarSections.length === 0 && <div className="p-4 text-[11px] text-zinc-500">All side bar sections are hidden — restore them from Layout in the header.</div>}
          </div>
        }
        secondary={
          isHidden('query.results') ? (
            <div className="h-full pl-1">{editorPane}</div>
          ) : (
            <SplitPane direction="vertical" storageKey="workbench.editor" defaultSize={300} min={140} max={1600} minSecondary={160} className="h-full pl-1" primary={editorPane} secondary={resultsPane} />
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
