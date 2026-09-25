import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { UploadCloud, Folder, FolderOpen, FolderPlus, Database, Table2, Eye, Trash2, X, ChevronDown, ChevronRight, Cloud, Layers, Boxes, Globe, Warehouse, HardDrive, Plug, Loader2, RefreshCw, CheckCircle2, AlertTriangle, ArrowDownToLine, FileText, Sheet, Settings2 } from 'lucide-react';
import { api, formatBytes, type JailEntry, type CloudConnection, type CloudEntry, type LakehouseConnection, type LakehouseBrowse, type DatabaseConnection, type DatabaseEntry, type ConnectorConnection, type BrowseEntry } from '../../api/client';
import { useWorkspace } from '../../store/workspace';
import { cn, confirmAction } from '../../components/ui';
import { LocationBrowser } from '../../components/data';

/**
 * The Overview's data source bar: LOCAL (the data directory, folders mounted from this computer, the workspace's
 * tables — with a pick of where uploads go) and REMOTE (every connection this user configured: object storage,
 * lakehouse catalogs, databases, warehouses, applications and Google Drive / Sheets — each browsable in place).
 * Selecting a file, an object or an attached table profiles it; a warehouse table, an application object, a Drive
 * file or a Sheets tab is imported into the workspace with a sync.
 */
export interface DataSourceBarProps {
  workspaceId: string;
  target: string | null;
  onSelect: (target: string) => void;
  /** A connector resource to load into the workspace (opens the sync editor on the Connections page). */
  onImport: (input: { connection_id: string; resource: Record<string, unknown>; name: string }) => void;
  /** Opens the Query page with this SQL (remote-only lakehouse tables). */
  onQuery: (sql: string) => void;
  onFiles: (files: File[]) => void;
  uploads: { name: string; pct: number; error?: string }[];
  canWrite: boolean;
}

interface Sources {
  cloud: CloudConnection[];
  lakehouse: LakehouseConnection[];
  databases: DatabaseConnection[];
  connectors: ConnectorConnection[];
  external_access: boolean;
}

/** One lazily loaded level of a remote tree. */
interface Node {
  id: string;
  name: string;
  hint?: string;
  icon: ReactNode;
  /** Leaves: what selecting does. */
  select?: { target: string } | { import: { connection_id: string; resource: Record<string, unknown>; name: string } } | { query: string };
  /** Branches: how to load children. */
  load?: () => Promise<Node[]>;
  status?: 'ok' | 'error' | 'unknown';
  error?: string | null;
}

/** File kinds are told apart by shape, not colour. */
const KIND_ICON = (kind: string) => (kind === 'parquet' ? <Boxes className="h-3.5 w-3.5 shrink-0 text-zinc-500" /> : kind === 'excel' ? <Sheet className="h-3.5 w-3.5 shrink-0 text-zinc-500" /> : kind === 'duckdb' ? <Database className="h-3.5 w-3.5 shrink-0 text-zinc-500" /> : <FileText className="h-3.5 w-3.5 shrink-0 text-zinc-500" />);

export function DataSourceBar({ workspaceId, target, onSelect, onImport, onQuery, onFiles, uploads, canWrite }: DataSourceBarProps) {
  const ws = useWorkspace();
  const [dragging, setDragging] = useState(false);
  const [picker, setPicker] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [folders, setFolders] = useState<{ folders: { path: string; name: string; upload_default?: boolean }[]; data_directory: string; upload_dir: string; mode: string } | null>(null);
  const [sources, setSources] = useState<Sources | null>(null);
  const [locationMenu, setLocationMenu] = useState(false);
  const [showLocal, setShowLocal] = useState(true);
  const [showRemote, setShowRemote] = useState(true);
  const fileInput = useRef<HTMLInputElement>(null);

  const loadFolders = useCallback(async () => setFolders(await api.get(`/api/workspaces/${workspaceId}/folders`)), [workspaceId]);
  const loadSources = useCallback(async () => setSources(await api.get<Sources>('/api/sources')), []);
  useEffect(() => { void loadFolders().catch(() => undefined); void loadSources().catch(() => undefined); }, [loadFolders, loadSources]);

  const files = ws.catalog?.files ?? [];
  const objects = ws.catalog?.objects ?? [];
  const groups = useMemo(() => {
    const byRoot = new Map<string, JailEntry[]>();
    for (const f of files) {
      const key = f.root ?? '';
      if (!byRoot.has(key)) byRoot.set(key, []);
      byRoot.get(key)!.push(f);
    }
    for (const f of folders?.folders ?? []) if (!byRoot.has(f.path)) byRoot.set(f.path, []);
    return [...byRoot.entries()].sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)));
  }, [files, folders]);
  const toggle = (key: string) => setCollapsed((c) => { const n = new Set(c); if (n.has(key)) n.delete(key); else n.add(key); return n; });

  const addFolder = async (folderPath: string) => {
    const r = await api.post<{ folders: { path: string; name: string }[] }>(`/api/workspaces/${workspaceId}/folders`, { path: folderPath });
    const added = r.folders.find((f) => f.path === folderPath) ?? r.folders[r.folders.length - 1];
    await ws.loadCatalog(true);
    await loadFolders();
    const fresh = useWorkspace.getState().catalog?.files ?? [];
    const first = added ? fresh.find((f) => f.root === added.path) : undefined;
    if (first) onSelect(first.path);
  };
  const removeFolder = async (root: string) => {
    if (!(await confirmAction(`Remove ${root} from this workspace? Files are not deleted.`))) return;
    await api.del(`/api/workspaces/${workspaceId}/folders?path=${encodeURIComponent(root)}`);
    await ws.loadCatalog(true);
    await loadFolders();
  };
  const removeFile = async (f: JailEntry) => {
    if (!(await confirmAction(`Delete ${f.path} from the data directory?`))) return;
    await api.del(`/api/workspaces/${workspaceId}/files?path=${encodeURIComponent(f.path)}`);
    await ws.loadCatalog(true);
  };
  const setUploadDir = async (p: string | null) => {
    await api.put(`/api/workspaces/${workspaceId}/folders/upload-default`, { path: p });
    await loadFolders();
    setLocationMenu(false);
  };
  const uploadLabel = folders ? (folders.upload_dir === folders.data_directory ? 'Data directory' : folders.folders.find((f) => f.path === folders.upload_dir)?.name ?? folders.upload_dir) : '…';

  // ---- remote trees, one root per connection
  const remoteRoots = useMemo<Node[]>(() => {
    if (!sources) return [];
    const roots: Node[] = [];
    for (const c of sources.cloud) {
      const listObjects = (bucket: string, prefix: string) => async (): Promise<Node[]> => {
        const r = await api.get<{ entries: CloudEntry[]; next_token: string | null }>(`/api/storage/cloud?connection_id=${c.id}&bucket=${encodeURIComponent(bucket)}&prefix=${encodeURIComponent(prefix)}`);
        return r.entries.map((e) => (e.type === 'dir' ? { id: `${c.id}:${bucket}:${e.path}`, name: e.name, icon: <Folder className="h-3.5 w-3.5 text-sky-300" />, load: listObjects(bucket, e.path) } : { id: `${c.id}:${bucket}:${e.path}`, name: e.name, hint: e.size_bytes != null ? formatBytes(e.size_bytes) : undefined, icon: KIND_ICON(e.kind), select: e.queryable ? { target: e.uri } : undefined }));
      };
      roots.push({
        id: `cloud:${c.id}`, name: c.name, hint: `${c.provider}${c.bucket ? ` · ${c.bucket}` : ''}`, icon: <Cloud className="h-3.5 w-3.5 text-sky-300" />, status: 'ok',
        load: async () => {
          if (c.bucket) return listObjects(c.bucket, '')();
          const r = await api.get<{ buckets: { name: string }[] }>(`/api/storage/cloud?connection_id=${c.id}`);
          return r.buckets.map((b) => ({ id: `${c.id}:${b.name}`, name: b.name, icon: <HardDrive className="h-3.5 w-3.5 text-sky-300" />, load: listObjects(b.name, '') }));
        },
      });
    }
    for (const l of sources.lakehouse) {
      const browse = (catalog?: string | null, schema?: string | null) => async (): Promise<Node[]> => {
        const q = new URLSearchParams({ connection_id: l.id, workspace_id: workspaceId });
        if (catalog) q.set('catalog', catalog);
        if (schema) q.set('schema', schema);
        const r = await api.get<LakehouseBrowse>(`/api/lakehouse/browse?${q}`);
        if (r.attach_error && !r.entries.length) throw new Error(r.attach_error);
        return r.entries.map((e) => (e.type === 'catalog' ? { id: `${l.id}:${e.name}`, name: e.name, icon: <Layers className="h-3.5 w-3.5 text-fuchsia-300" />, load: browse(e.name, null) } : e.type === 'schema' ? { id: `${l.id}:${r.catalog}:${e.name}`, name: e.name, icon: <Folder className="h-3.5 w-3.5 text-fuchsia-300" />, load: browse(r.catalog, e.name) } : { id: `${l.id}:${r.catalog}:${r.schema}:${e.name}`, name: e.name, hint: e.format ?? e.type, icon: e.type === 'view' ? <Eye className="h-3.5 w-3.5 text-sky-300" /> : <Table2 className="h-3.5 w-3.5 text-fuchsia-300" />, select: e.engine === 'duckdb' && e.qualified ? { target: e.qualified } : e.qualified ? { query: `SELECT * FROM ${e.qualified} LIMIT 100` } : undefined }));
      };
      roots.push({ id: `lake:${l.id}`, name: l.name, hint: `${l.provider.toLowerCase().replace('_', ' ')} · ${l.attached ? `attached as ${l.alias}` : 'remote SQL'}`, icon: <Layers className="h-3.5 w-3.5 text-fuchsia-300" />, status: l.status, error: l.last_error, load: browse(null, null) });
    }
    for (const d of sources.databases) {
      roots.push({
        id: `db:${d.id}`, name: d.name, hint: `${d.engine} · ${d.alias}`, icon: <Database className="h-3.5 w-3.5 text-emerald-300" />, status: d.status, error: d.last_error,
        load: async () => {
          const r = await api.get<{ entries: DatabaseEntry[] }>(`/api/database-connections/${d.id}/browse`);
          return r.entries.map((s) => ({ id: `${d.id}:${s.name}`, name: s.name, icon: <Folder className="h-3.5 w-3.5 text-emerald-300" />, load: async () => (await api.get<{ entries: DatabaseEntry[] }>(`/api/database-connections/${d.id}/browse?schema=${encodeURIComponent(s.name)}`)).entries.map((t) => ({ id: `${d.id}:${s.name}:${t.name}`, name: t.name, hint: t.rows != null ? `~${t.rows.toLocaleString()} rows` : t.type, icon: t.type === 'view' ? <Eye className="h-3.5 w-3.5 text-sky-300" /> : <Table2 className="h-3.5 w-3.5 text-emerald-300" />, select: { target: t.qualified ?? `${d.alias}.${s.name}.${t.name}` } })) }));
        },
      });
    }
    for (const c of sources.connectors) {
      const browse = (path: string[]) => async (): Promise<Node[]> => {
        const r = await api.get<{ entries: BrowseEntry[] }>(`/api/connector-connections/${c.id}/browse${path.length ? `?path=${path.map(encodeURIComponent).join('/')}` : ''}`);
        return r.entries.map((e, i) => (e.path ? { id: `${c.id}:${e.path.join('/')}`, name: e.name, hint: e.hint, icon: <Folder className="h-3.5 w-3.5 text-zinc-500" />, load: browse(e.path) } : { id: `${c.id}:leaf:${i}:${e.name}`, name: e.name, hint: e.hint ?? e.type, icon: /file|sheet|tab|report/.test(e.type) ? <FileText className="h-3.5 w-3.5 text-zinc-500" /> : <Table2 className="h-3.5 w-3.5 text-zinc-500" />, select: e.resource ? { import: { connection_id: c.id, resource: e.resource, name: e.name } } : undefined }));
      };
      const icon = /google/.test(c.connector) ? <Globe className="h-3.5 w-3.5 text-zinc-500" /> : c.remote_sql || c.connector === 'fabric' ? <Warehouse className="h-3.5 w-3.5 text-zinc-500" /> : <Boxes className="h-3.5 w-3.5 text-zinc-500" />;
      roots.push({ id: `conn:${c.id}`, name: c.name, hint: `${c.connector_label}${c.account_label ? ` · ${c.account_label}` : ''}`, icon, status: c.status, error: c.last_error, load: browse([]) });
    }
    return roots;
  }, [sources, workspaceId]);

  return (
    <div className="flex min-h-full flex-col">
      <div className="flex h-9 shrink-0 items-center justify-between px-3">
        <h2 className="text-xs font-semibold text-zinc-300">Sources</h2>
        <button onClick={() => { void ws.loadCatalog(true); void loadSources(); void loadFolders(); }} className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200" title="Refresh sources" aria-label="Refresh sources"><RefreshCw className="h-3 w-3" /></button>
      </div>
      {/* ---------------------------------------------------------------- LOCAL */}
      <SectionHeader icon={<HardDrive className="h-3.5 w-3.5" />} label="Local" count={files.length + objects.length} open={showLocal} onToggle={() => setShowLocal((v) => !v)} hint={folders?.data_directory} />
      <div className={cn('px-3 pb-3', !showLocal && 'hidden')}>
        <div
          className={cn('flex cursor-pointer items-center gap-2 rounded-md border border-dashed px-2.5 py-2 transition-colors', dragging ? 'border-accent-500 bg-accent-500/10' : 'border-zinc-700 hover:border-zinc-500', !canWrite && 'pointer-events-none opacity-50')}
          title="Parquet, CSV, JSON, DuckDB or Excel files"
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => { e.preventDefault(); setDragging(false); onFiles([...e.dataTransfer.files]); }}
          onClick={() => fileInput.current?.click()}
        >
          <UploadCloud className={cn('h-3.5 w-3.5 shrink-0', dragging ? 'text-accent-400' : 'text-zinc-500')} />
          <div className="text-xs text-zinc-400"><span className="font-medium text-zinc-200">Add files</span> — drop or browse</div>
          <input ref={fileInput} type="file" multiple className="hidden" onChange={(e) => onFiles([...(e.target.files ?? [])])} />
        </div>
        {canWrite && folders && (
          <div className="relative mt-2 flex items-center gap-1 text-2xs">
            <span className="text-zinc-500">Uploads go to</span>
            <button onClick={() => setLocationMenu((v) => !v)} className="inline-flex min-w-0 items-center gap-1 rounded border border-zinc-800 px-1.5 py-0.5 font-mono text-zinc-200 hover:border-zinc-600" title={folders.upload_dir}>
              <Settings2 className="h-3 w-3 text-accent-300" /> <span className="truncate">{uploadLabel}</span> <ChevronDown className="h-3 w-3 text-zinc-500" />
            </button>
            {locationMenu && (
              <div className="absolute left-0 top-6 z-20 w-full rounded-lg border border-zinc-700 bg-zinc-900 p-1 shadow-xl">
                <button onClick={() => void setUploadDir(null)} className={cn('flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-zinc-800', folders.upload_dir === folders.data_directory && 'text-accent-200')}><Database className="h-3 w-3" /> <span className="min-w-0 flex-1 truncate">Data directory</span><span className="truncate font-mono text-2xs text-zinc-500">{folders.data_directory}</span></button>
                {folders.folders.map((f) => <button key={f.path} onClick={() => void setUploadDir(f.path)} className={cn('flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-zinc-800', folders.upload_dir === f.path && 'text-accent-200')}><Folder className="h-3 w-3" /> <span className="min-w-0 flex-1 truncate">{f.name}</span><span className="truncate font-mono text-2xs text-zinc-500">{f.path}</span></button>)}
                <button onClick={() => { setLocationMenu(false); setPicker(true); }} className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-accent-300 hover:bg-zinc-800"><FolderPlus className="h-3 w-3" /> Choose another folder on this computer…</button>
              </div>
            )}
          </div>
        )}
        {uploads.length > 0 && (
          <div className="mt-2 space-y-1">
            {uploads.map((u) => (
              <div key={u.name} className="rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-2xs">
                <div className="flex justify-between text-zinc-300"><span className="truncate">{u.name}</span><span className={u.error ? 'text-red-300' : 'text-zinc-500'}>{u.error ? 'failed' : `${u.pct}%`}</span></div>
                {u.error ? <div className="mt-0.5 text-red-300">{u.error}</div> : <div className="mt-1 h-1 overflow-hidden rounded bg-zinc-800"><div className="h-full bg-accent-500 transition-all" style={{ width: `${u.pct}%` }} /></div>}
              </div>
            ))}
          </div>
        )}
        <div className="mt-2 space-y-px">
          {groups.map(([root, items]) => {
            const isFolder = root !== '';
            const open = !collapsed.has(root || '__data');
            const meta = folders?.folders.find((f) => f.path === root);
            const label = isFolder ? meta?.name ?? root.split('/').filter(Boolean).pop() ?? root : 'Data directory';
            const isUploadDir = folders ? (isFolder ? folders.upload_dir === root : folders.upload_dir === folders.data_directory) : false;
            return (
              <div key={root || '__data'}>
                <div className="group/root flex items-center gap-1 rounded px-1 py-1">
                  <button onClick={() => toggle(root || '__data')} className="flex min-w-0 flex-1 items-center gap-1 text-left" title={root || folders?.data_directory || 'The workspace data directory'}>
                    {open ? <ChevronDown className="h-3 w-3 text-zinc-500" /> : <ChevronRight className="h-3 w-3 text-zinc-500" />}
                    {isFolder ? (open ? <FolderOpen className="h-3.5 w-3.5 text-zinc-500" /> : <Folder className="h-3.5 w-3.5 text-zinc-500" />) : <Database className="h-3.5 w-3.5 text-zinc-500" />}
                    <span className="truncate text-xs font-medium text-zinc-300">{label}</span>
                    {isUploadDir && <span className="text-2xs text-zinc-500" title="Uploads land here">· uploads</span>}
                    <span className="ml-auto font-mono text-2xs text-zinc-500">{items.length}{ws.catalog?.truncated_folders?.includes(root) ? '+' : ''}</span>
                  </button>
                  {isFolder && canWrite && <button onClick={() => void removeFolder(root)} className="rounded p-0.5 text-zinc-500 opacity-0 hover:text-red-300 group-hover/root:opacity-100" title="Remove folder from workspace"><X className="h-3 w-3" /></button>}
                </div>
                {open && isFolder && <div className="ml-5 truncate font-mono text-2xs text-zinc-500" title={root}>{root}</div>}
                {open && items.length === 0 && <div className="ml-5 py-1 text-2xs text-zinc-500">No data files here yet{isFolder ? '' : ' — drop one above'}.</div>}
                {open && items.map((f) => {
                  const display = f.root ? f.path.slice(f.root.length + 1) : f.path;
                  return (
                    <div key={f.path} className={cn('group ml-3 flex items-center gap-2 rounded-md px-2 py-[5px]', target === f.path ? 'bg-zinc-800/70 text-zinc-50' : 'hover:bg-zinc-800/50')}>
                      {KIND_ICON(f.kind)}
                      <button className="flex min-w-0 flex-1 items-baseline gap-2 text-left" onClick={() => onSelect(f.path)} title={`${f.path} · ${f.kind} · ${formatBytes(f.size_bytes)}`}>
                        <span className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-100">{display}</span>
                        <span className="shrink-0 font-mono text-2xs text-zinc-400 group-hover:hidden">{formatBytes(f.size_bytes)}</span>
                      </button>
                      {canWrite && !f.root && <button className="rounded p-0.5 text-zinc-500 opacity-0 hover:text-red-300 group-hover:opacity-100" onClick={() => void removeFile(f)} title="Delete file"><Trash2 className="h-3 w-3" /></button>}
                    </div>
                  );
                })}
              </div>
            );
          })}
          {canWrite && (
            <button onClick={() => setPicker(true)} className="ml-1 mt-1 inline-flex items-center gap-1.5 rounded px-1 py-1 text-2xs text-accent-300 hover:underline" title="Read a folder from this computer in place — nothing is copied">
              <FolderPlus className="h-3.5 w-3.5" /> Add a folder from this computer
            </button>
          )}
          {objects.length > 0 && (
            <div>
              <button onClick={() => toggle('__tables')} className="flex w-full items-center gap-1 rounded px-1 py-1 text-left">
                {!collapsed.has('__tables') ? <ChevronDown className="h-3 w-3 text-zinc-500" /> : <ChevronRight className="h-3 w-3 text-zinc-500" />}
                <Table2 className="h-3.5 w-3.5 text-zinc-500" />
                <span className="truncate text-xs font-medium text-zinc-300">Workspace tables</span>
                <span className="ml-auto font-mono text-2xs text-zinc-500">{objects.length}</span>
              </button>
              {!collapsed.has('__tables') && objects.map((o) => {
                const name = o.schema === 'main' ? o.name : `${o.schema}.${o.name}`;
                return (
                  <button key={name} onClick={() => onSelect(name)} title={`${o.type.toLowerCase()} · ${o.column_count} columns${o.estimated_rows != null ? ` · ~${o.estimated_rows.toLocaleString()} rows` : ''}`} className={cn('ml-3 flex w-[calc(100%-0.75rem)] items-center gap-2 rounded-md px-2 py-[5px] text-left', target === name ? 'bg-zinc-800 text-zinc-50' : 'hover:bg-zinc-800/50')}>
                    {o.type === 'VIEW' ? <Eye className="h-3.5 w-3.5 shrink-0 text-zinc-500" /> : <Table2 className="h-3.5 w-3.5 shrink-0 text-zinc-500" />}
                    <span className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-100">{name}</span>
                    {o.estimated_rows != null && <span className="shrink-0 font-mono text-2xs text-zinc-500">{o.estimated_rows.toLocaleString()}</span>}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* ---------------------------------------------------------------- REMOTE */}
      <SectionHeader icon={<Plug className="h-3.5 w-3.5" />} label="Remote" count={remoteRoots.length} open={showRemote} onToggle={() => setShowRemote((v) => !v)} action={<a href="#/connections/catalog" className="text-2xs text-zinc-500 hover:text-zinc-200">Connect</a>} />
      <div className={cn('px-3 pb-3', !showRemote && 'hidden')}>
        {!sources && <div className="py-2 text-2xs text-zinc-500"><Loader2 className="mr-1 inline h-3 w-3 animate-spin" /> Loading connections…</div>}
        {sources && remoteRoots.length === 0 && (
          <div className="py-1 text-2xs leading-relaxed text-zinc-500">
            No remote sources. <a href="#/connections/catalog" className="text-accent-300 hover:underline">Connect</a> a bucket, database, warehouse or SaaS app to browse it here.
          </div>
        )}
        {sources && !sources.external_access && remoteRoots.length > 0 && <div className="mb-2 rounded-md border border-amber-900/60 bg-amber-950/30 px-2 py-1 text-2xs text-amber-200">External access is off on this server: remote files can be browsed but not profiled.</div>}
        <div className="space-y-px">
          {remoteRoots.map((root) => <RemoteTree key={root.id} node={root} depth={0} target={target} onSelect={onSelect} onImport={onImport} onQuery={onQuery} />)}
        </div>

      </div>
      <LocationBrowser open={picker} workspaceId={workspaceId} mode="folder" remote={false} title="Add a folder to this workspace" onClose={() => setPicker(false)} onPick={async ([path]) => { if (path) await addFolder(path); }} />
    </div>
  );
}

function SectionHeader({ icon, label, count, action, open, onToggle, hint }: { icon: ReactNode; label: string; count: number; action?: ReactNode; open: boolean; onToggle: () => void; hint?: string }) {
  return (
    <div className="flex h-8 items-center gap-1.5 border-t border-zinc-800/70 px-3">
      <button onClick={onToggle} className="flex min-w-0 flex-1 items-center gap-1.5 text-left" title={hint}>
        {open ? <ChevronDown className="h-3 w-3 text-zinc-500" /> : <ChevronRight className="h-3 w-3 text-zinc-500" />}
        <span className="text-zinc-500">{icon}</span>
        <span className="text-xs font-semibold text-zinc-300">{label}</span>
        <span className="text-2xs tabular-nums text-zinc-500">{count}</span>
      </button>
      {action}
    </div>
  );
}

function StatusDot({ status }: { status?: 'ok' | 'error' | 'unknown' }) {
  if (status === 'ok') return <CheckCircle2 className="h-3 w-3 shrink-0 text-emerald-400" />;
  if (status === 'error') return <AlertTriangle className="h-3 w-3 shrink-0 text-red-300" />;
  return <span className="h-2 w-2 shrink-0 rounded-full bg-zinc-600" />;
}

/** A lazily loaded remote tree node: connections, buckets, schemas, tables… */
function RemoteTree({ node, depth, target, onSelect, onImport, onQuery }: { node: Node; depth: number; target: string | null; onSelect: (t: string) => void; onImport: DataSourceBarProps['onImport']; onQuery: (sql: string) => void }) {
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState<Node[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const expand = async () => {
    if (!node.load) return;
    const next = !open;
    setOpen(next);
    if (next && children === null) {
      setLoading(true);
      setError(null);
      try {
        setChildren(await node.load());
      } catch (e) {
        setError((e as Error).message);
        setChildren([]);
      } finally {
        setLoading(false);
      }
    }
  };
  const selected = node.select && 'target' in node.select && node.select.target === target;
  const act = () => {
    if (!node.select) return;
    if ('target' in node.select) onSelect(node.select.target);
    else if ('import' in node.select) onImport(node.select.import);
    else if ('query' in node.select) onQuery(node.select.query);
  };
  return (
    <div>
      <div className={cn('group flex items-center gap-1.5 rounded-md py-1 pr-1', selected ? 'bg-zinc-800' : 'hover:bg-zinc-800/50')} style={{ paddingLeft: 4 + depth * 12 }}>
        {node.load ? (
          <button onClick={() => void expand()} className="shrink-0 text-zinc-500 hover:text-zinc-200" title={open ? 'Collapse' : 'Browse'}>{loading ? <Loader2 className="h-3 w-3 animate-spin" /> : open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}</button>
        ) : <span className="w-3 shrink-0" />}
        <span className="shrink-0">{node.icon}</span>
        <button onClick={() => (node.select ? act() : void expand())} className="min-w-0 flex-1 text-left" title={node.error ?? node.hint ?? node.name}>
          <div className={cn('truncate text-xs', depth === 0 ? 'font-medium text-zinc-100' : 'font-mono text-zinc-200')}>{node.name}</div>
          {node.hint && <div className="truncate font-mono text-2xs text-zinc-500">{node.hint}</div>}
        </button>
        {depth === 0 && <StatusDot status={node.status} />}
        {node.select && 'import' in node.select && <button onClick={act} className="rounded px-1 py-0.5 text-2xs text-accent-300 opacity-0 hover:underline group-hover:opacity-100" title="Load into the workspace with a sync"><ArrowDownToLine className="mr-0.5 inline h-3 w-3" />import</button>}
      </div>
      {open && (
        <div>
          {error && <div className="ml-6 rounded-md border border-red-900/60 bg-red-950/30 px-2 py-1 font-mono text-2xs text-red-200" style={{ marginLeft: 16 + depth * 12 }}>{error}</div>}
          {!loading && !error && children?.length === 0 && <div className="py-1 text-2xs text-zinc-500" style={{ paddingLeft: 22 + depth * 12 }}>Nothing here.</div>}
          {children?.map((c) => <RemoteTree key={c.id} node={c} depth={depth + 1} target={target} onSelect={onSelect} onImport={onImport} onQuery={onQuery} />)}
        </div>
      )}
    </div>
  );
}

