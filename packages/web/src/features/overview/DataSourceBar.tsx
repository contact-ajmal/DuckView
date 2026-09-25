import { useCallback, useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { Folder, FolderOpen, FolderSearch, Database, Table2, Eye, Trash2, X, ChevronDown, ChevronRight, Cloud, Layers, Boxes, Globe, Warehouse, HardDrive, Plug, Loader2, RefreshCw, ArrowDownToLine, FileText, Sheet, Plus, Search, Pin, PinOff, History, MoreHorizontal, SquareTerminal, Copy, Pencil, UploadCloud, Star } from 'lucide-react';
import { api, formatBytes, timeAgo, type JailEntry, type CloudConnection, type CloudEntry, type LakehouseConnection, type LakehouseBrowse, type DatabaseConnection, type DatabaseEntry, type ConnectorConnection, type BrowseEntry, type SourceType } from '../../api/client';
import { useWorkspace } from '../../store/workspace';
import { useAuth } from '../../store/auth';
import { ContextMenu, Empty, Button, IconButton, Input, MenuDivider, MenuItem, StatusDot as Dot, cn, confirmAction, promptAction, toast, errorText } from '../../components/ui';
import { LocationBrowser, type BrowserLocation } from '../../components/data';
import { AddSourceDialog, type AddSourceTab } from './AddSourceDialog';
import { ConnectionWizards, useSourceCatalog, wizardFor, type ConnectionWizard } from '../connections/SourceCatalog';

/**
 * Data → Sources: everything the workspace reads, in two levels.
 *
 * - Local: the data directory, the folders added from the server's disk (each with its health and file count),
 *   and the workspace's own tables.
 * - Remote: every connection this person set up (object storage, lakehouse catalogs, databases, warehouses,
 *   applications, Google Drive and Sheets), each with its health, browsable in place.
 *
 * Around it: one Add source button, a search across all sources, and pinned and recent datasets. Files have
 * hover actions (query, more) and a right-click menu (open, query, copy path, reveal, rename, pin, delete).
 * Selecting a file, an object or an attached table profiles it; a warehouse table, an application object, a
 * Drive file or a Sheets tab is imported into the workspace with a sync.
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
  google_configured?: boolean;
}
interface Folders {
  folders: { path: string; name: string; upload_default?: boolean; missing?: boolean }[];
  data_directory: string;
  upload_dir: string;
  mode: string;
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
  /** When the connection was last tested. */
  tested?: string | null;
  /** Roots that open in the location browser (buckets). */
  browse?: BrowserLocation;
}

/** File kinds are told apart by shape, not colour. */
const KIND_ICON = (kind: string) => (kind === 'parquet' ? <Boxes className="h-3.5 w-3.5 shrink-0 text-zinc-500" /> : kind === 'excel' ? <Sheet className="h-3.5 w-3.5 shrink-0 text-zinc-500" /> : kind === 'duckdb' ? <Database className="h-3.5 w-3.5 shrink-0 text-zinc-500" /> : <FileText className="h-3.5 w-3.5 shrink-0 text-zinc-500" />);
const sqlLiteral = (s: string) => `'${s.replace(/'/g, "''")}'`;
const baseName = (p: string) => p.replace(/\/$/, '').split('/').pop() || p;
const dirName = (p: string) => p.replace(/\/[^/]*$/, '') || '/';

/** Pinned and recently opened datasets, per workspace, in this browser. */
function useShelf(workspaceId: string) {
  const key = `duckview.sources.${workspaceId}`;
  const read = (): { pinned: string[]; recent: string[] } => {
    try {
      return { pinned: [], recent: [], ...JSON.parse(localStorage.getItem(key) ?? '{}') };
    } catch {
      return { pinned: [], recent: [] };
    }
  };
  const [shelf, setShelf] = useState(read);
  useEffect(() => setShelf(read()), [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = (next: { pinned: string[]; recent: string[] }) => {
    setShelf(next);
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      /* storage unavailable */
    }
  };
  return {
    ...shelf,
    visit: (t: string) => save({ ...shelf, recent: [t, ...shelf.recent.filter((x) => x !== t)].slice(0, 6) }),
    togglePin: (t: string) => save({ ...shelf, pinned: shelf.pinned.includes(t) ? shelf.pinned.filter((x) => x !== t) : [...shelf.pinned, t] }),
    forget: (t: string) => save({ pinned: shelf.pinned.filter((x) => x !== t), recent: shelf.recent.filter((x) => x !== t) }),
  };
}

type Menu = { at: { x: number; y: number }; kind: 'file'; file: JailEntry } | { at: { x: number; y: number }; kind: 'folder'; root: string } | null;

export function DataSourceBar({ workspaceId, target, onSelect: select, onImport, onQuery, onFiles, uploads, canWrite }: DataSourceBarProps) {
  const ws = useWorkspace();
  const isAdmin = useAuth((s) => s.user?.role === 'ADMIN');
  const shelf = useShelf(workspaceId);
  const { connectors: connectorCatalog } = useSourceCatalog();
  const [dragging, setDragging] = useState(false);
  const [browser, setBrowser] = useState<{ mode: 'folder' | 'files'; start?: BrowserLocation; title: string } | null>(null);
  const [adding, setAdding] = useState<AddSourceTab | null>(null);
  const [wizard, setWizard] = useState<ConnectionWizard | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [folders, setFolders] = useState<Folders | null>(null);
  const [sources, setSources] = useState<Sources | null>(null);
  const [showLocal, setShowLocal] = useState(true);
  const [showRemote, setShowRemote] = useState(true);
  const [query, setQuery] = useState('');
  const [menu, setMenu] = useState<Menu>(null);
  const [reveal, setReveal] = useState<string | null>(null);

  const loadFolders = useCallback(async () => setFolders(await api.get<Folders>(`/api/workspaces/${workspaceId}/folders`)), [workspaceId]);
  const loadSources = useCallback(async () => setSources(await api.get<Sources>('/api/sources')), []);
  useEffect(() => { void loadFolders().catch(() => undefined); void loadSources().catch(() => undefined); }, [loadFolders, loadSources]);

  const onSelect = (t: string) => {
    shelf.visit(t);
    select(t);
  };
  const files = ws.catalog?.files ?? [];
  const objects = ws.catalog?.objects ?? [];
  const q = query.trim().toLowerCase();
  const hit = (s: string) => !q || s.toLowerCase().includes(q);
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
  const absolute = (f: JailEntry) => (f.root || f.path.startsWith('/') ? f.path : `${folders?.data_directory ?? ''}/${f.path}`);
  const refresh = () => { void ws.loadCatalog(true); void loadSources(); void loadFolders(); };

  const addFolder = async (folderPath: string) => {
    const r = await api.post<{ folders: { path: string; name: string }[] }>(`/api/workspaces/${workspaceId}/folders`, { path: folderPath });
    const added = r.folders.find((f) => f.path === folderPath) ?? r.folders[r.folders.length - 1];
    await ws.loadCatalog(true);
    await loadFolders();
    toast.success(`Added ${added?.name ?? baseName(folderPath)}`);
    const fresh = useWorkspace.getState().catalog?.files ?? [];
    const first = added ? fresh.find((f) => f.root === added.path) : undefined;
    if (first) onSelect(first.path);
  };
  const removeFolder = async (root: string) => {
    if (!(await confirmAction(`Remove ${baseName(root)} from this workspace? The folder and its files stay on disk.`, { confirmLabel: 'Remove' }))) return;
    await api.del(`/api/workspaces/${workspaceId}/folders?path=${encodeURIComponent(root)}`);
    await ws.loadCatalog(true);
    await loadFolders();
    toast.success(`Removed ${baseName(root)}`);
  };
  const removeFile = async (f: JailEntry) => {
    if (!(await confirmAction(`Delete ${f.path} from the data directory?`))) return;
    try {
      await api.del(`/api/workspaces/${workspaceId}/files?path=${encodeURIComponent(f.path)}`);
      shelf.forget(f.path);
      await ws.loadCatalog(true);
      toast.success(`Deleted ${baseName(f.path)}`);
    } catch (e) {
      toast.error(errorText(e));
    }
  };
  const renameFile = async (f: JailEntry) => {
    const name = await promptAction(`Rename ${baseName(f.path)}`, { label: 'New name', defaultValue: baseName(f.path), confirmLabel: 'Rename' });
    if (!name || name === baseName(f.path)) return;
    try {
      const r = await api.patch<{ path: string }>(`/api/workspaces/${workspaceId}/files`, { path: f.path, name });
      shelf.forget(f.path);
      await ws.loadCatalog(true);
      const next = f.root ? `${dirName(f.path)}/${name}` : r.path;
      if (target === f.path) onSelect(next);
      toast.success(`Renamed to ${name}`);
    } catch (e) {
      toast.error(errorText(e));
    }
  };
  const setUploadDir = async (p: string | null) => {
    await api.put(`/api/workspaces/${workspaceId}/folders/upload-default`, { path: p });
    await loadFolders();
  };
  const queryFile = (path: string) => onQuery(`SELECT *\nFROM ${sqlLiteral(path)}\nLIMIT 100;`);
  const copy = (text: string) => void navigator.clipboard.writeText(text).then(() => toast.success('Copied'), () => toast.error('Could not copy'));
  const openMenu = (e: ReactMouseEvent, m: { kind: 'file'; file: JailEntry } | { kind: 'folder'; root: string }) => {
    e.preventDefault();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({ ...m, at: e.type === 'contextmenu' ? { x: e.clientX, y: e.clientY } : { x: r.left, y: r.bottom + 4 } } as Menu);
  };
  const chooseSource = (s: SourceType) => {
    setAdding(null);
    const w = wizardFor(s, connectorCatalog);
    if (w === 'sheet') location.hash = '#/connections/syncs?new=1';
    else if (w) setWizard(w);
  };
  const useConnection = (id: string) => {
    setAdding(null);
    setShowRemote(true);
    const root = remoteRoots.find((r) => r.id === id);
    if (root?.browse) setBrowser({ mode: 'files', start: root.browse, title: `Browse ${root.name}` });
    else setReveal(id);
  };

  // A file dropped anywhere on the sidebar is uploaded.
  const dropProps = canWrite
    ? {
        onDragOver: (e: React.DragEvent) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragging(true); } },
        onDragLeave: (e: React.DragEvent) => { if (!e.currentTarget.contains(e.relatedTarget as globalThis.Node | null)) setDragging(false); },
        onDrop: (e: React.DragEvent) => { e.preventDefault(); setDragging(false); if (e.dataTransfer.files.length) onFiles([...e.dataTransfer.files]); },
      }
    : {};

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
        id: `cloud:${c.id}`, name: c.name, hint: `${c.provider}${c.bucket ? ` · ${c.bucket}` : ''}`, icon: <Cloud className="h-3.5 w-3.5 text-sky-300" />, status: 'ok', browse: { kind: 'cloud', connectionId: c.id, bucket: c.bucket ?? undefined, prefix: '' },
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
      roots.push({ id: `lake:${l.id}`, name: l.name, hint: `${l.provider.toLowerCase().replace('_', ' ')} · ${l.attached ? `attached as ${l.alias}` : 'remote SQL'}`, icon: <Layers className="h-3.5 w-3.5 text-fuchsia-300" />, status: l.status, error: l.last_error, tested: l.last_tested_at, load: browse(null, null) });
    }
    for (const d of sources.databases) {
      roots.push({
        id: `db:${d.id}`, name: d.name, hint: `${d.engine} · ${d.alias}`, icon: <Database className="h-3.5 w-3.5 text-emerald-300" />, status: d.status, error: d.last_error, tested: d.last_tested_at,
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
      roots.push({ id: `conn:${c.id}`, name: c.name, hint: `${c.connector_label}${c.account_label ? ` · ${c.account_label}` : ''}`, icon, status: c.status, error: c.last_error, tested: c.last_tested_at, load: browse([]) });
    }
    return roots;
  }, [sources, workspaceId]);

  const visibleRoots = remoteRoots.filter((r) => hit(`${r.name} ${r.hint ?? ''}`));
  const nothing = !!folders && !!sources && files.length === 0 && objects.length === 0 && (folders.folders.length ?? 0) === 0 && remoteRoots.length === 0;
  const label = (t: string) => {
    const f = files.find((x) => x.path === t);
    if (f) return { name: baseName(f.path), icon: KIND_ICON(f.kind) };
    if (/^[a-z0-9]+:\/\//i.test(t)) return { name: baseName(t), icon: <Cloud className="h-3.5 w-3.5 shrink-0 text-zinc-500" /> };
    return { name: t, icon: <Table2 className="h-3.5 w-3.5 shrink-0 text-zinc-500" /> };
  };
  const shelfRow = (t: string, pinned: boolean) => {
    const l = label(t);
    return (
      <div key={`${pinned ? 'p' : 'r'}:${t}`} className={cn('group flex items-center gap-2 rounded-md px-2 py-[5px]', target === t ? 'bg-zinc-800/70 text-zinc-50' : 'hover:bg-zinc-800/50')}>
        {l.icon}
        <button className="min-w-0 flex-1 truncate text-left font-mono text-xs text-zinc-100" onClick={() => onSelect(t)} title={t}>{l.name}</button>
        {pinned && <IconButton label={`Unpin ${l.name}`} className="h-5 w-5 opacity-0 group-hover:opacity-100 focus-visible:opacity-100" onClick={() => shelf.togglePin(t)}><PinOff className="h-3 w-3" /></IconButton>}
      </div>
    );
  };
  const pinned = shelf.pinned.filter(hit);
  const recent = shelf.recent.filter((t) => !shelf.pinned.includes(t) && hit(t)).slice(0, 4);

  return (
    <div className="relative flex min-h-full flex-col" data-testid="sources" {...dropProps}>
      {dragging && (
        <div className="pointer-events-none absolute inset-1 z-10 flex flex-col items-center justify-center gap-1 rounded-md border border-dashed border-accent-500 bg-zinc-950/90 text-xs text-zinc-200">
          <UploadCloud className="h-5 w-5 text-accent-400" />
          Drop to upload to {folders && folders.upload_dir !== folders.data_directory ? folders.folders.find((f) => f.path === folders.upload_dir)?.name ?? 'the folder' : 'the data directory'}
        </div>
      )}
      <div className="flex h-9 shrink-0 items-center gap-1 px-3">
        <h2 className="flex-1 text-xs font-semibold text-zinc-300">Sources</h2>
        <IconButton label="Refresh sources" className="h-6 w-6" onClick={refresh}><RefreshCw className="h-3 w-3" /></IconButton>
        {canWrite && <Button size="sm" variant="ghost" onClick={() => setAdding('local')} data-testid="sources-add"><Plus className="h-3.5 w-3.5" /> Add source</Button>}
      </div>
      <div className="relative px-3 pb-2">
        <Search className="pointer-events-none absolute left-5 top-1/2 h-3 w-3 -translate-y-[calc(50%+4px)] text-zinc-500" />
        <Input uiSize="sm" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search all sources" aria-label="Search all sources" className="pl-6" data-testid="sources-search" />
      </div>

      {uploads.length > 0 && (
        <div className="space-y-1 px-3 pb-2">
          {uploads.map((u) => (
            <div key={u.name} className="rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-2xs">
              <div className="flex justify-between text-zinc-300"><span className="truncate">{u.name}</span><span className={u.error ? 'text-red-300' : 'text-zinc-500'}>{u.error ? 'failed' : `${u.pct}%`}</span></div>
              {u.error ? <div className="mt-0.5 text-red-300">{u.error}</div> : <div className="mt-1 h-1 overflow-hidden rounded bg-zinc-800"><div className="h-full bg-accent-500 transition-all" style={{ width: `${u.pct}%` }} /></div>}
            </div>
          ))}
        </div>
      )}

      {nothing && !q && (
        <div className="border-t border-zinc-800/70 px-3 py-6" data-testid="sources-empty">
          <Empty icon={<FolderSearch />} title="Add a folder or connect a bucket" hint="Folders are read in place; buckets and databases are browsed where they live." action={canWrite ? <div className="flex flex-wrap justify-center gap-2"><Button size="sm" onClick={() => setBrowser({ mode: 'folder', title: 'Add a folder to this workspace' })}><Folder className="h-3.5 w-3.5" /> Add a folder</Button><Button size="sm" variant="ghost" onClick={() => setAdding('remote')}><Cloud className="h-3.5 w-3.5" /> Connect a bucket</Button></div> : undefined} />
        </div>
      )}

      {(pinned.length > 0 || recent.length > 0) && (
        <div className="space-y-2 border-t border-zinc-800/70 px-3 py-2" data-testid="sources-shelf">
          {pinned.length > 0 && (
            <div>
              <h3 className="flex items-center gap-1.5 px-1 pb-0.5 text-2xs font-medium text-zinc-500"><Star className="h-3 w-3" /> Pinned</h3>
              {pinned.map((t) => shelfRow(t, true))}
            </div>
          )}
          {recent.length > 0 && (
            <div>
              <h3 className="flex items-center gap-1.5 px-1 pb-0.5 text-2xs font-medium text-zinc-500"><History className="h-3 w-3" /> Recent</h3>
              {recent.map((t) => shelfRow(t, false))}
            </div>
          )}
        </div>
      )}

      {/* ---------------------------------------------------------------- LOCAL */}
      <SectionHeader icon={<HardDrive className="h-3.5 w-3.5" />} label="Local" count={files.length + objects.length} open={showLocal} onToggle={() => setShowLocal((v) => !v)} hint={folders?.data_directory} />
      <div className={cn('px-3 pb-3', !showLocal && 'hidden')} data-testid="sources-local">
        <div className="space-y-px">
          {groups.map(([root, all]) => {
            const isFolder = root !== '';
            const meta = folders?.folders.find((f) => f.path === root);
            const name = isFolder ? meta?.name ?? baseName(root) : 'Data directory';
            const items = all.filter((f) => hit(f.root ? f.path.slice(f.root.length + 1) : f.path));
            if (q && !items.length && !hit(name)) return null;
            const open = q ? true : !collapsed.has(root || '__data');
            const isUploadDir = folders ? (isFolder ? folders.upload_dir === root : folders.upload_dir === folders.data_directory) : false;
            const health = meta?.missing ? 'error' : 'ok';
            return (
              <div key={root || '__data'} data-testid="source-group" data-root={root || 'data'}>
                <div className="group/root flex items-center gap-1 rounded px-1 py-1 hover:bg-zinc-800/40" onContextMenu={(e) => openMenu(e, { kind: 'folder', root: root || folders?.data_directory || '' })}>
                  <button onClick={() => toggle(root || '__data')} className="flex min-w-0 flex-1 items-center gap-1.5 text-left" title={meta?.missing ? `${root} was not found — it may have been moved or unmounted` : root || folders?.data_directory || 'The workspace data directory'} aria-expanded={open}>
                    {open ? <ChevronDown className="h-3 w-3 text-zinc-500" /> : <ChevronRight className="h-3 w-3 text-zinc-500" />}
                    {isFolder ? (open ? <FolderOpen className="h-3.5 w-3.5 text-zinc-500" /> : <Folder className="h-3.5 w-3.5 text-zinc-500" />) : <Database className="h-3.5 w-3.5 text-zinc-500" />}
                    <span className="truncate text-xs font-medium text-zinc-300">{name}</span>
                    {isUploadDir && <span className="shrink-0 text-2xs text-zinc-500" title="Uploads land here">uploads</span>}
                    <span className="ml-auto flex shrink-0 items-center gap-1.5">
                      <Dot tone={health === 'error' ? 'error' : 'ok'} />
                      <span className="font-mono text-2xs text-zinc-500">{all.length}{ws.catalog?.truncated_folders?.includes(root) ? '+' : ''}</span>
                    </span>
                  </button>
                  <IconButton label={`More actions for ${name}`} className="h-5 w-5 opacity-0 group-hover/root:opacity-100 focus-visible:opacity-100" onClick={(e) => openMenu(e, { kind: 'folder', root: root || folders?.data_directory || '' })}><MoreHorizontal className="h-3 w-3" /></IconButton>
                </div>
                {open && meta?.missing && <div className="ml-5 py-1 text-2xs text-red-300">Folder not found. Remove it, or mount it again.</div>}
                {open && !meta?.missing && all.length === 0 && <div className="ml-5 py-1 text-2xs text-zinc-500">No data files here yet{isFolder ? '' : '. Drop one on this panel'}.</div>}
                {open && items.map((f) => {
                  const display = f.root ? f.path.slice(f.root.length + 1) : f.path;
                  return (
                    <div key={f.path} data-testid="source-file" data-path={f.path} onContextMenu={(e) => openMenu(e, { kind: 'file', file: f })} className={cn('group ml-3 flex items-center gap-2 rounded-md px-2 py-[5px]', target === f.path ? 'bg-zinc-800/70 text-zinc-50' : 'hover:bg-zinc-800/50')}>
                      {KIND_ICON(f.kind)}
                      <button className="flex min-w-0 flex-1 items-baseline gap-2 text-left" onClick={() => onSelect(f.path)} title={`${f.path} · ${f.kind} · ${formatBytes(f.size_bytes)} · modified ${timeAgo(f.modified_at)}`}>
                        <span className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-100">{display}</span>
                        {shelf.pinned.includes(f.path) && <Pin className="h-3 w-3 shrink-0 text-zinc-500" aria-label="Pinned" />}
                        <span className="shrink-0 font-mono text-2xs text-zinc-400 group-focus-within:hidden group-hover:hidden">{formatBytes(f.size_bytes)}</span>
                      </button>
                      <span className="hidden shrink-0 items-center group-focus-within:flex group-hover:flex">
                        <IconButton label={`Query ${display}`} className="h-5 w-5" onClick={() => queryFile(f.path)}><SquareTerminal className="h-3 w-3" /></IconButton>
                        <IconButton label={`More actions for ${display}`} className="h-5 w-5" onClick={(e) => openMenu(e, { kind: 'file', file: f })} data-testid="source-file-more"><MoreHorizontal className="h-3 w-3" /></IconButton>
                      </span>
                    </div>
                  );
                })}
              </div>
            );
          })}
          {objects.length > 0 && (() => {
            const tables = objects.map((o) => ({ o, name: o.schema === 'main' ? o.name : `${o.schema}.${o.name}` })).filter((t) => hit(t.name));
            if (q && !tables.length) return null;
            const open = q ? true : !collapsed.has('__tables');
            return (
              <div>
                <button onClick={() => toggle('__tables')} className="flex w-full items-center gap-1.5 rounded px-1 py-1 text-left hover:bg-zinc-800/40" aria-expanded={open}>
                  {open ? <ChevronDown className="h-3 w-3 text-zinc-500" /> : <ChevronRight className="h-3 w-3 text-zinc-500" />}
                  <Table2 className="h-3.5 w-3.5 text-zinc-500" />
                  <span className="truncate text-xs font-medium text-zinc-300">Workspace tables</span>
                  <span className="ml-auto font-mono text-2xs text-zinc-500">{objects.length}</span>
                </button>
                {open && tables.map(({ o, name }) => (
                  <div key={name} className={cn('group ml-3 flex items-center gap-2 rounded-md px-2 py-[5px]', target === name ? 'bg-zinc-800/70 text-zinc-50' : 'hover:bg-zinc-800/50')}>
                    {o.type === 'VIEW' ? <Eye className="h-3.5 w-3.5 shrink-0 text-zinc-500" /> : <Table2 className="h-3.5 w-3.5 shrink-0 text-zinc-500" />}
                    <button onClick={() => onSelect(name)} title={`${o.type.toLowerCase()} · ${o.column_count} columns${o.estimated_rows != null ? ` · ~${o.estimated_rows.toLocaleString()} rows` : ''}`} className="flex min-w-0 flex-1 items-baseline gap-2 text-left">
                      <span className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-100">{name}</span>
                      {o.estimated_rows != null && <span className="shrink-0 font-mono text-2xs text-zinc-500 group-focus-within:hidden group-hover:hidden">{o.estimated_rows.toLocaleString()}</span>}
                    </button>
                    <span className="hidden shrink-0 items-center group-focus-within:flex group-hover:flex">
                      <IconButton label={`Query ${name}`} className="h-5 w-5" onClick={() => onQuery(`SELECT *\nFROM ${name}\nLIMIT 100;`)}><SquareTerminal className="h-3 w-3" /></IconButton>
                      <IconButton label={shelf.pinned.includes(name) ? `Unpin ${name}` : `Pin ${name}`} className="h-5 w-5" onClick={() => shelf.togglePin(name)}>{shelf.pinned.includes(name) ? <PinOff className="h-3 w-3" /> : <Pin className="h-3 w-3" />}</IconButton>
                    </span>
                  </div>
                ))}
              </div>
            );
          })()}
          {q && !groups.some(([, all]) => all.some((f) => hit(f.path))) && !objects.some((o) => hit(o.name)) && <p className="px-1 py-1 text-2xs text-zinc-500">Nothing local matches “{query}”.</p>}
        </div>
      </div>

      {/* ---------------------------------------------------------------- REMOTE */}
      <SectionHeader icon={<Plug className="h-3.5 w-3.5" />} label="Remote" count={remoteRoots.length} open={showRemote} onToggle={() => setShowRemote((v) => !v)} action={canWrite ? <button onClick={() => setAdding('remote')} className="text-2xs text-zinc-500 hover:text-zinc-200">Connect</button> : undefined} />
      <div className={cn('px-3 pb-3', !showRemote && 'hidden')} data-testid="sources-remote">
        {!sources && <div className="py-2 text-2xs text-zinc-500"><Loader2 className="mr-1 inline h-3 w-3 animate-spin" /> Loading connections…</div>}
        {sources && remoteRoots.length === 0 && (
          <div className="py-1 text-2xs leading-relaxed text-zinc-500">
            No remote sources. {canWrite ? <button onClick={() => setAdding('remote')} className="text-accent-300 hover:underline">Connect</button> : 'Connect'} a bucket, database, warehouse or SaaS app to browse it here.
          </div>
        )}
        {sources && !sources.external_access && remoteRoots.length > 0 && <div className="mb-2 rounded-md border border-amber-900/60 bg-amber-950/30 px-2 py-1 text-2xs text-amber-200">External access is off on this server: remote files can be browsed but not profiled.</div>}
        {q && remoteRoots.length > 0 && !visibleRoots.length && <p className="px-1 py-1 text-2xs text-zinc-500">No connection matches “{query}”.</p>}
        <div className="space-y-px">
          {visibleRoots.map((root) => <RemoteTree key={root.id} node={root} depth={0} target={target} onSelect={onSelect} onImport={onImport} onQuery={onQuery} reveal={reveal} onBrowse={(n) => n.browse && setBrowser({ mode: 'files', start: n.browse, title: `Browse ${n.name}` })} />)}
        </div>
      </div>

      <ContextMenu at={menu?.at ?? null} onClose={() => setMenu(null)} label={menu?.kind === 'file' ? `Actions for ${baseName(menu.file.path)}` : 'Folder actions'}>
        {menu?.kind === 'file' && (() => {
          const f = menu.file;
          const inData = !f.root && !f.path.startsWith('/');
          return (
            <>
              <MenuItem icon={<Eye className="h-3.5 w-3.5" />} onClick={() => onSelect(f.path)}>Open</MenuItem>
              <MenuItem icon={<SquareTerminal className="h-3.5 w-3.5" />} onClick={() => queryFile(f.path)}>Query in SQL</MenuItem>
              <MenuItem icon={shelf.pinned.includes(f.path) ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />} onClick={() => shelf.togglePin(f.path)}>{shelf.pinned.includes(f.path) ? 'Unpin' : 'Pin'}</MenuItem>
              <MenuDivider />
              <MenuItem icon={<Copy className="h-3.5 w-3.5" />} onClick={() => copy(absolute(f))}>Copy path</MenuItem>
              <MenuItem icon={<FolderSearch className="h-3.5 w-3.5" />} onClick={() => setBrowser({ mode: 'files', start: { kind: 'local', path: dirName(absolute(f)) }, title: `In ${baseName(dirName(absolute(f)))}` })}>Reveal in browser</MenuItem>
              {canWrite && <MenuItem icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => void renameFile(f)}>Rename…</MenuItem>}
              {canWrite && inData && (<><MenuDivider /><MenuItem icon={<Trash2 className="h-3.5 w-3.5" />} danger onClick={() => void removeFile(f)}>Delete file…</MenuItem></>)}
            </>
          );
        })()}
        {menu?.kind === 'folder' && (() => {
          const root = menu.root;
          const isData = root === folders?.data_directory;
          return (
            <>
              <MenuItem icon={<FolderSearch className="h-3.5 w-3.5" />} onClick={() => setBrowser({ mode: 'files', start: { kind: 'local', path: root }, title: `In ${isData ? 'the data directory' : baseName(root)}` })}>Reveal in browser</MenuItem>
              <MenuItem icon={<Copy className="h-3.5 w-3.5" />} onClick={() => copy(root)}>Copy path</MenuItem>
              {canWrite && folders && folders.upload_dir !== root && <MenuItem icon={<ArrowDownToLine className="h-3.5 w-3.5" />} onClick={() => void setUploadDir(isData ? null : root)}>Upload new files here</MenuItem>}
              {canWrite && !isData && (<><MenuDivider /><MenuItem icon={<X className="h-3.5 w-3.5" />} danger onClick={() => void removeFolder(root)}>Remove from workspace…</MenuItem></>)}
            </>
          );
        })()}
      </ContextMenu>

      <AddSourceDialog
        open={adding !== null}
        tab={adding ?? 'local'}
        onTab={setAdding}
        onClose={() => setAdding(null)}
        canWrite={canWrite}
        sources={sources}
        folders={folders}
        onAddFolder={() => { setAdding(null); setBrowser({ mode: 'folder', title: 'Add a folder to this workspace' }); }}
        onOpenFile={() => { setAdding(null); setBrowser({ mode: 'files', title: 'Open a file' }); }}
        onFiles={onFiles}
        onUploadDir={(p) => void setUploadDir(p)}
        onUseConnection={useConnection}
        onChooseSource={chooseSource}
      />
      <ConnectionWizards wizard={wizard} onClose={() => setWizard(null)} onSaved={() => { void loadSources(); toast.success('Connected'); }} googleConfigured={!!sources?.google_configured} isAdmin={isAdmin} onGoogleConfigured={() => void loadSources()} />
      <LocationBrowser
        open={browser !== null}
        workspaceId={workspaceId}
        mode={browser?.mode ?? 'folder'}
        remote={browser?.mode === 'files'}
        start={browser?.start}
        title={browser?.title}
        confirmLabel={browser?.mode === 'folder' ? undefined : 'Open'}
        onClose={() => setBrowser(null)}
        onPick={async ([path]) => {
          if (!path) return;
          if (browser?.mode === 'folder') await addFolder(path);
          else onSelect(path);
        }}
      />
    </div>
  );
}

function SectionHeader({ icon, label, count, action, open, onToggle, hint }: { icon: ReactNode; label: string; count: number; action?: ReactNode; open: boolean; onToggle: () => void; hint?: string }) {
  return (
    <div className="flex h-8 items-center gap-1.5 border-t border-zinc-800/70 px-3">
      <button onClick={onToggle} className="flex min-w-0 flex-1 items-center gap-1.5 text-left" title={hint} aria-expanded={open}>
        {open ? <ChevronDown className="h-3 w-3 text-zinc-500" /> : <ChevronRight className="h-3 w-3 text-zinc-500" />}
        <span className="text-zinc-500">{icon}</span>
        <span className="text-xs font-semibold text-zinc-300">{label}</span>
        <span className="text-2xs tabular-nums text-zinc-500">{count}</span>
      </button>
      {action}
    </div>
  );
}

/** A lazily loaded remote tree node: connections, buckets, schemas, tables… */
function RemoteTree({ node, depth, target, onSelect, onImport, onQuery, reveal, onBrowse }: { node: Node; depth: number; target: string | null; onSelect: (t: string) => void; onImport: DataSourceBarProps['onImport']; onQuery: (sql: string) => void; reveal?: string | null; onBrowse?: (n: Node) => void }) {
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState<Node[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const expand = async (force?: boolean) => {
    if (!node.load) return;
    const next = force ?? !open;
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
  // "Your connections" in Add source: open this root and bring it into view.
  const rowRef = useCallback((el: HTMLDivElement | null) => {
    if (el && reveal === node.id) el.scrollIntoView({ block: 'nearest' });
  }, [reveal, node.id]);
  useEffect(() => {
    if (reveal === node.id) void expand(true);
  }, [reveal]); // eslint-disable-line react-hooks/exhaustive-deps
  const selected = node.select && 'target' in node.select && node.select.target === target;
  const act = () => {
    if (!node.select) return;
    if ('target' in node.select) onSelect(node.select.target);
    else if ('import' in node.select) onImport(node.select.import);
    else if ('query' in node.select) onQuery(node.select.query);
  };
  const health = node.status === 'error' ? 'error' : node.status === 'ok' ? 'ok' : 'idle';
  return (
    <div data-testid={depth === 0 ? 'remote-root' : undefined} data-name={depth === 0 ? node.name : undefined}>
      <div ref={rowRef} className={cn('group flex items-center gap-1.5 rounded-md py-1 pr-1', selected ? 'bg-zinc-800' : 'hover:bg-zinc-800/50', reveal === node.id && 'ring-1 ring-inset ring-zinc-700')} style={{ paddingLeft: 4 + depth * 12 }}>
        {node.load ? (
          <button onClick={() => void expand()} className="shrink-0 text-zinc-500 hover:text-zinc-200" aria-label={open ? `Collapse ${node.name}` : `Expand ${node.name}`} aria-expanded={open}>{loading ? <Loader2 className="h-3 w-3 animate-spin" /> : open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}</button>
        ) : <span className="w-3 shrink-0" />}
        <span className="shrink-0">{node.icon}</span>
        <button onClick={() => (node.select ? act() : void expand())} className="min-w-0 flex-1 text-left" title={node.error ?? node.hint ?? node.name}>
          <div className={cn('truncate text-xs', depth === 0 ? 'font-medium text-zinc-100' : 'font-mono text-zinc-200')}>{node.name}</div>
          {node.hint && <div className="truncate font-mono text-2xs text-zinc-500">{node.hint}{depth === 0 && node.tested ? ` · tested ${timeAgo(node.tested)}` : ''}</div>}
        </button>
        {depth === 0 && node.browse && onBrowse && <IconButton label={`Browse ${node.name}`} className="h-5 w-5 opacity-0 group-hover:opacity-100 focus-visible:opacity-100" onClick={() => onBrowse(node)} data-testid="remote-browse"><FolderSearch className="h-3 w-3" /></IconButton>}
        {depth === 0 && <span title={node.status === 'error' ? node.error ?? 'Failing' : node.status === 'ok' ? 'Connected' : 'Not tested yet'}><Dot tone={health} /></span>}
        {node.select && 'import' in node.select && <button onClick={act} className="rounded px-1 py-0.5 text-2xs text-accent-300 opacity-0 hover:underline group-hover:opacity-100" title="Load into the workspace with a sync"><ArrowDownToLine className="mr-0.5 inline h-3 w-3" />import</button>}
      </div>
      {open && (
        <div>
          {error && <div className="rounded-md border border-red-900/60 bg-red-950/30 px-2 py-1 font-mono text-2xs text-red-200" style={{ marginLeft: 16 + depth * 12 }}>{error}</div>}
          {!loading && !error && children?.length === 0 && <div className="py-1 text-2xs text-zinc-500" style={{ paddingLeft: 22 + depth * 12 }}>Nothing here.</div>}
          {children?.map((c) => <RemoteTree key={c.id} node={c} depth={depth + 1} target={target} onSelect={onSelect} onImport={onImport} onQuery={onQuery} />)}
        </div>
      )}
    </div>
  );
}
