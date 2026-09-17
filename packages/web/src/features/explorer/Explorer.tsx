import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, ChevronDown, Folder, FolderOpen, FileSpreadsheet, FileJson, Database, Box, File, Cloud, Plus, RefreshCw, Search, HardDrive, Loader2, Layers, FolderPlus, Table2 } from 'lucide-react';
import { api, formatBytes, getToken, type TreeEntry, type CloudEntry, type CloudConnection, type LocalListing, type LakehouseConnection, type LakehouseBrowse } from '../../api/client';
import { cn } from '../../components/ui';

export interface ExplorerNode {
  id: string;
  name: string;
  kind: 'local-root' | 'folder-root' | 'dir' | 'file' | 'table_dir' | 'cloud-root' | 'connection' | 'bucket' | 'prefix' | 'object' | 'lakehouse-root' | 'lakehouse' | 'lh-catalog' | 'lh-schema' | 'lh-table';
  fileKind?: string;
  /** Query target: relative local path or cloud URI. */
  target?: string;
  size?: number | null;
  queryable?: boolean;
  connectionId?: string;
  bucket?: string;
  prefix?: string;
  localPath?: string;
  provider?: string;
  uriScheme?: string;
  children?: ExplorerNode[];
  loaded?: boolean;
  loading?: boolean;
  error?: string;
  truncated?: boolean;
  /** Lakehouse position: which connection / catalog / schema this node sits in, and how a table is queried. */
  lakehouse?: { connectionId: string; alias: string; providerId: string; catalog?: string | null; schema?: string | null; engine?: 'duckdb' | 'remote'; format?: string | null; status?: string; attached?: boolean; remoteSql?: boolean };
}

export interface ExplorerActions {
  onInspect(node: ExplorerNode): void;
  onQuery(node: ExplorerNode): void;
  onInsert(text: string): void;
  onAskCopilot?(node: ExplorerNode): void;
  onAddConnection(): void;
  onAddLakehouse(): void;
  /** Table on a remote SQL warehouse (Databricks): open a tab bound to that engine. */
  onQueryRemote?(node: ExplorerNode): void;
  onMaterialize?(node: ExplorerNode): void;
  onAddFolder(): void;
  onRemoveFolder(path: string): void;
  onDeleted?(): void;
}

const fileIcon = (kind?: string, cls = 'h-3.5 w-3.5') => {
  switch (kind) {
    case 'parquet':
    case 'arrow':
      return <Box className={cn(cls, 'text-accent-300')} />;
    case 'csv':
    case 'excel':
      return <FileSpreadsheet className={cn(cls, 'text-emerald-300')} />;
    case 'json':
      return <FileJson className={cn(cls, 'text-amber-300')} />;
    case 'duckdb':
      return <Database className={cn(cls, 'text-sky-300')} />;
    case 'delta':
    case 'iceberg':
      return <Layers className={cn(cls, 'text-fuchsia-300')} />;
    default:
      return <File className={cn(cls, 'text-zinc-500')} />;
  }
};

function localEntryToNode(e: TreeEntry): ExplorerNode {
  if (e.type === 'dir') return { id: `local:${e.path}`, name: e.name, kind: 'dir', localPath: e.path, children: [], loaded: false };
  return { id: `local:${e.path}`, name: e.name, kind: e.type === 'table_dir' ? 'table_dir' : 'file', fileKind: e.kind, target: e.path, localPath: e.path, size: e.size_bytes, queryable: e.queryable };
}

function cloudEntryToNode(e: CloudEntry, connectionId: string, bucket: string, provider: string): ExplorerNode {
  if (e.type === 'dir') return { id: `cloud:${connectionId}:${bucket}:${e.path}`, name: e.name, kind: 'prefix', connectionId, bucket, prefix: e.path, provider, children: [], loaded: false };
  return { id: `cloud:${connectionId}:${bucket}:${e.path}`, name: e.name, kind: 'object', fileKind: e.kind, target: e.uri, connectionId, bucket, prefix: e.path, provider, size: e.size_bytes, queryable: e.queryable };
}

export function Explorer({ workspaceId, actions, refreshKey = 0, selected }: { workspaceId: string; actions: ExplorerActions; refreshKey?: number; selected?: string | null }) {
  const [roots, setRoots] = useState<ExplorerNode[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['local-root', 'cloud-root', 'lakehouse-root']));
  const [filter, setFilter] = useState('');
  const [menu, setMenu] = useState<{ x: number; y: number; node: ExplorerNode } | null>(null);
  const [mode, setMode] = useState<'sandboxed' | 'full'>('sandboxed');
  const ref = useRef<HTMLDivElement>(null);

  const patch = useCallback((id: string, fn: (n: ExplorerNode) => ExplorerNode) => {
    const walk = (nodes: ExplorerNode[]): ExplorerNode[] => nodes.map((n) => (n.id === id ? fn(n) : n.children ? { ...n, children: walk(n.children) } : n));
    setRoots((r) => walk(r));
  }, []);

  const loadChildren = useCallback(
    async (node: ExplorerNode) => {
      patch(node.id, (n) => ({ ...n, loading: true, error: undefined }));
      try {
        let children: ExplorerNode[] = [];
        let truncated = false;
        if (node.kind === 'local-root' || node.kind === 'folder-root' || node.kind === 'dir') {
          const r = await api.get<LocalListing>(`/api/storage/local?workspace_id=${workspaceId}&path=${encodeURIComponent(node.localPath ?? '.')}`);
          setMode(r.mode);
          children = r.entries.map(localEntryToNode);
        } else if (node.kind === 'cloud-root') {
          const r = await api.get<{ connections: CloudConnection[] }>('/api/cloud-connections');
          children = r.connections.map((c) => ({ id: `conn:${c.id}`, name: c.name, kind: 'connection', connectionId: c.id, provider: c.provider, uriScheme: c.uri_scheme, bucket: c.bucket ?? undefined, children: [], loaded: false }));
        } else if (node.kind === 'connection') {
          const r = await api.get<{ buckets: { name: string }[] }>(`/api/storage/cloud?connection_id=${node.connectionId}`);
          children = r.buckets.map((b) => ({ id: `bucket:${node.connectionId}:${b.name}`, name: b.name, kind: 'bucket', connectionId: node.connectionId, bucket: b.name, provider: node.provider, children: [], loaded: false }));
        } else if (node.kind === 'bucket' || node.kind === 'prefix') {
          const r = await api.get<{ entries: CloudEntry[]; next_token: string | null }>(`/api/storage/cloud?connection_id=${node.connectionId}&bucket=${encodeURIComponent(node.bucket!)}&prefix=${encodeURIComponent(node.prefix ?? '')}`);
          children = r.entries.map((e) => cloudEntryToNode(e, node.connectionId!, node.bucket!, node.provider ?? ''));
          truncated = !!r.next_token;
        } else if (node.kind === 'lakehouse-root') {
          const r = await api.get<{ connections: LakehouseConnection[] }>('/api/lakehouse-connections');
          children = r.connections.map((c) => ({ id: `lh:${c.id}`, name: c.name, kind: 'lakehouse', provider: c.provider, lakehouse: { connectionId: c.id, alias: c.alias, providerId: c.provider, status: c.status, attached: c.attached, remoteSql: c.remote_sql }, children: [], loaded: false }));
        } else if (node.kind === 'lakehouse' || node.kind === 'lh-catalog' || node.kind === 'lh-schema') {
          const lh = node.lakehouse!;
          const q = new URLSearchParams({ connection_id: lh.connectionId, workspace_id: workspaceId });
          if (lh.catalog) q.set('catalog', lh.catalog);
          if (lh.schema) q.set('schema', lh.schema);
          const r = await api.get<LakehouseBrowse>(`/api/lakehouse/browse?${q}`);
          if (r.attach_error && r.entries.length === 0) throw new Error(r.attach_error);
          children = r.entries.map((e) => {
            const base = { connectionId: lh.connectionId, alias: lh.alias, providerId: lh.providerId, attached: lh.attached, remoteSql: lh.remoteSql };
            if (e.type === 'catalog') return { id: `${node.id}:${e.name}`, name: e.name, kind: 'lh-catalog' as const, lakehouse: { ...base, catalog: e.name }, children: [], loaded: false };
            if (e.type === 'schema') return { id: `${node.id}:${e.name}`, name: e.name, kind: 'lh-schema' as const, lakehouse: { ...base, catalog: r.catalog, schema: e.name }, children: [], loaded: false };
            return { id: `${node.id}:${e.name}`, name: e.name, kind: 'lh-table' as const, fileKind: e.type === 'view' ? 'view' : 'iceberg', target: e.qualified, queryable: !!e.engine, lakehouse: { ...base, catalog: r.catalog, schema: r.schema, engine: e.engine, format: e.format } };
          });
        }
        patch(node.id, (n) => ({ ...n, children, loaded: true, loading: false, truncated }));
      } catch (e) {
        patch(node.id, (n) => ({ ...n, loading: false, loaded: true, error: (e as Error).message }));
      }
    },
    [workspaceId, patch],
  );

  useEffect(() => {
    let alive = true;
    (async () => {
      const local: ExplorerNode = { id: 'local-root', name: 'Data directory', kind: 'local-root', localPath: '.', children: [], loaded: false };
      let folderRoots: ExplorerNode[] = [];
      try {
        const r = await api.get<{ folders: { path: string; name: string }[] }>(`/api/workspaces/${workspaceId}/folders`);
        folderRoots = r.folders.map((f) => ({ id: `folder:${f.path}`, name: f.name, kind: 'folder-root' as const, localPath: f.path, children: [], loaded: false }));
      } catch {
        /* ignore */
      }
      const cloud: ExplorerNode = { id: 'cloud-root', name: 'Cloud storage', kind: 'cloud-root', children: [], loaded: false };
      const lake: ExplorerNode = { id: 'lakehouse-root', name: 'Lakehouse', kind: 'lakehouse-root', children: [], loaded: false };
      if (!alive) return;
      setRoots([local, ...folderRoots, cloud, lake]);
      setExpanded((e) => new Set([...e, ...folderRoots.map((f) => f.id)]));
      void loadChildren(local);
      for (const f of folderRoots) void loadChildren(f);
      void loadChildren(cloud);
      void loadChildren(lake);
    })();
    return () => {
      alive = false;
    };
  }, [workspaceId, refreshKey, loadChildren]);

  useEffect(() => {
    const close = () => setMenu(null);
    window.addEventListener('click', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('scroll', close, true);
    };
  }, []);

  const toggle = (node: ExplorerNode) => {
    const next = new Set(expanded);
    if (next.has(node.id)) next.delete(node.id);
    else {
      next.add(node.id);
      if (!node.loaded && !node.loading) void loadChildren(node);
    }
    setExpanded(next);
  };

  const q = filter.trim().toLowerCase();
  const matches = (n: ExplorerNode): boolean => !q || n.name.toLowerCase().includes(q) || (n.children?.some(matches) ?? false);

  const download = async (node: ExplorerNode) => {
    const res = await fetch(`/api/workspaces/${workspaceId}/files/download?path=${encodeURIComponent(node.localPath!)}`, { headers: { authorization: `Bearer ${getToken()}` } });
    if (!res.ok) return alert(await res.text());
    const a = document.createElement('a');
    a.href = URL.createObjectURL(await res.blob());
    a.download = node.name;
    a.click();
  };
  const remove = async (node: ExplorerNode) => {
    if (!confirm(`Delete ${node.localPath} from the data directory?`)) return;
    await api.del(`/api/workspaces/${workspaceId}/files?path=${encodeURIComponent(node.localPath!)}`);
    const parentId = node.localPath!.includes('/') ? `local:${node.localPath!.split('/').slice(0, -1).join('/')}` : 'local-root';
    const parent = find(roots, parentId);
    if (parent) void loadChildren(parent);
    actions.onDeleted?.();
  };

  const Row = ({ node, depth }: { node: ExplorerNode; depth: number }) => {
    if (!matches(node)) return null;
    const isBranch = !!node.children;
    const open = expanded.has(node.id) || (!!q && isBranch);
    const isSelected = selected && node.target === selected;
    const icon =
      node.kind === 'local-root' ? <HardDrive className="h-3.5 w-3.5 text-zinc-400" /> :
      node.kind === 'folder-root' ? (open ? <FolderOpen className="h-3.5 w-3.5 text-accent-300" /> : <Folder className="h-3.5 w-3.5 text-accent-300" />) :
      node.kind === 'cloud-root' ? <Cloud className="h-3.5 w-3.5 text-zinc-400" /> :
      node.kind === 'connection' ? <Cloud className="h-3.5 w-3.5 text-sky-300" /> :
      node.kind === 'bucket' ? <Database className="h-3.5 w-3.5 text-sky-300" /> :
      node.kind === 'lakehouse-root' ? <Layers className="h-3.5 w-3.5 text-zinc-400" /> :
      node.kind === 'lakehouse' ? <Layers className={cn('h-3.5 w-3.5', node.lakehouse?.status === 'error' ? 'text-red-300' : 'text-fuchsia-300')} /> :
      node.kind === 'lh-catalog' ? <Database className="h-3.5 w-3.5 text-fuchsia-300/80" /> :
      node.kind === 'lh-schema' ? (open ? <FolderOpen className="h-3.5 w-3.5 text-fuchsia-300/70" /> : <Folder className="h-3.5 w-3.5 text-fuchsia-300/70" />) :
      node.kind === 'lh-table' ? <Table2 className={cn('h-3.5 w-3.5', node.lakehouse?.engine === 'remote' ? 'text-amber-300' : 'text-fuchsia-300')} /> :
      node.kind === 'dir' || node.kind === 'prefix' ? (open ? <FolderOpen className="h-3.5 w-3.5 text-amber-300/80" /> : <Folder className="h-3.5 w-3.5 text-amber-300/80" />) :
      fileIcon(node.fileKind);
    return (
      <div>
        <div
          className={cn('group flex cursor-pointer items-center gap-1 rounded py-[3px] pr-1 text-xs hover:bg-zinc-800/70', isSelected && 'bg-accent-600/15')}
          style={{ paddingLeft: 4 + depth * 14 }}
          onClick={() => (isBranch ? toggle(node) : actions.onInspect(node))}
          onDoubleClick={() => !isBranch && node.queryable && (node.kind === 'lh-table' && node.lakehouse?.engine === 'remote' && actions.onQueryRemote ? actions.onQueryRemote(node) : actions.onQuery(node))}
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu({ x: e.clientX, y: e.clientY, node });
          }}
          title={node.target ?? node.localPath ?? node.name}
        >
          {isBranch ? (
            node.loading ? <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-500" /> : open ? <ChevronDown className="h-3.5 w-3.5 text-zinc-500" /> : <ChevronRight className="h-3.5 w-3.5 text-zinc-500" />
          ) : (
            <span className="w-3.5" />
          )}
          {icon}
          <span className={cn('min-w-0 flex-1 truncate', node.kind === 'local-root' || node.kind === 'cloud-root' || node.kind === 'folder-root' || node.kind === 'lakehouse-root' ? 'font-semibold uppercase tracking-wider text-[10px] text-zinc-400' : 'text-zinc-200')} title={node.localPath ?? node.name}>{node.name}</span>
          {node.kind === 'connection' && <span className="rounded border border-sky-900 bg-sky-950/40 px-1 font-mono text-[9px] text-sky-300">{node.provider}</span>}
          {node.kind === 'lakehouse' && <span className="rounded border border-fuchsia-900 bg-fuchsia-950/40 px-1 font-mono text-[9px] text-fuchsia-300" title={node.lakehouse?.attached ? `attached as ${node.lakehouse.alias}` : 'remote SQL'}>{node.provider === 'AWS_GLUE' ? 'GLUE' : node.provider === 'AWS_S3_TABLES' ? 'S3T' : node.provider === 'DATABRICKS' ? 'DBX' : 'IRC'}</span>}
          {node.kind === 'lh-table' && node.lakehouse?.engine === 'remote' && <span className="rounded border border-amber-900 bg-amber-950/40 px-1 font-mono text-[9px] text-amber-300" title="Runs on the SQL warehouse">remote</span>}
          {node.kind === 'lh-table' && node.lakehouse?.format && node.lakehouse.engine !== 'remote' && <span className="font-mono text-[9px] text-zinc-600">{node.lakehouse.format.toLowerCase()}</span>}
          {node.size != null && <span className="font-mono text-[10px] text-zinc-500">{formatBytes(node.size)}</span>}
          {node.kind === 'cloud-root' && (
            <button
              className="rounded p-0.5 text-zinc-500 opacity-0 hover:text-accent-300 group-hover:opacity-100"
              onClick={(e) => {
                e.stopPropagation();
                actions.onAddConnection();
              }}
              title="Add cloud connection"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          )}
          {node.kind === 'lakehouse-root' && (
            <button
              className="rounded p-0.5 text-zinc-500 opacity-0 hover:text-accent-300 group-hover:opacity-100"
              onClick={(e) => {
                e.stopPropagation();
                actions.onAddLakehouse();
              }}
              title="Connect a lakehouse (AWS Glue · S3 Tables · Databricks · Iceberg REST)"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          )}
          {isBranch && node.kind !== 'cloud-root' && node.kind !== 'lakehouse-root' && (
            <button
              className="rounded p-0.5 text-zinc-500 opacity-0 hover:text-zinc-200 group-hover:opacity-100"
              onClick={(e) => {
                e.stopPropagation();
                void loadChildren(node);
              }}
              title="Refresh"
            >
              <RefreshCw className="h-3 w-3" />
            </button>
          )}
        </div>
        {isBranch && open && (
          <div>
            {node.error && <div className="truncate px-2 py-1 text-[10px] text-red-300" style={{ paddingLeft: 22 + depth * 14 }} title={node.error}>{node.error}</div>}
            {node.loaded && node.children!.length === 0 && !node.error && (
              <div className="px-2 py-1 text-[10px] text-zinc-600" style={{ paddingLeft: 22 + depth * 14 }}>
                {node.kind === 'cloud-root' ? (
                  <button className="text-accent-300 hover:underline" onClick={actions.onAddConnection}>
                    + connect S3 / R2 / GCS / Azure
                  </button>
                ) : node.kind === 'lakehouse-root' ? (
                  <button className="text-accent-300 hover:underline" onClick={actions.onAddLakehouse}>
                    + connect AWS Glue / S3 Tables / Databricks / Iceberg
                  </button>
                ) : (
                  'empty'
                )}
              </div>
            )}
            {node.children!.map((c) => (
              <Row key={c.id} node={c} depth={depth + 1} />
            ))}
            {node.truncated && <div className="px-2 py-1 text-[10px] text-zinc-500" style={{ paddingLeft: 22 + depth * 14 }}>… more objects not shown (first 1000)</div>}
          </div>
        )}
      </div>
    );
  };

  const menuItems = useMemo(() => {
    if (!menu) return [];
    const n = menu.node;
    const items: { label: string; run: () => void; danger?: boolean }[] = [];
    if (n.kind === 'file' || n.kind === 'object' || n.kind === 'table_dir') {
      items.push({ label: 'Inspect schema', run: () => actions.onInspect(n) });
      if (n.queryable) items.push({ label: 'Query this file', run: () => actions.onQuery(n) });
      items.push({ label: 'Insert path at cursor', run: () => actions.onInsert(`'${n.target}'`) });
      items.push({ label: n.kind === 'object' ? 'Copy URI' : 'Copy path', run: () => void navigator.clipboard.writeText(n.target ?? '') });
      if (actions.onAskCopilot && n.queryable) items.push({ label: 'Ask DuckCopilot about this', run: () => actions.onAskCopilot!(n) });
      if (n.kind === 'file') items.push({ label: 'Download', run: () => void download(n) });
      if (n.kind === 'file' || n.kind === 'table_dir') items.push({ label: 'Delete', run: () => void remove(n), danger: true });
    }
    if (n.kind === 'dir' || n.kind === 'prefix' || n.kind === 'bucket' || n.kind === 'local-root' || n.kind === 'folder-root' || n.kind === 'connection') {
      items.push({ label: 'Refresh', run: () => void loadChildren(n) });
      if (n.kind === 'dir') items.push({ label: 'Insert glob (*.parquet)', run: () => actions.onInsert(`'${n.localPath}/*.parquet'`) });
      if (n.kind === 'prefix' && n.target === undefined) items.push({ label: 'Insert glob (*.parquet)', run: () => actions.onInsert(`'${n.uriScheme ?? (n.provider === 'R2' ? 'r2' : n.provider === 'GCS' ? 'gs' : n.provider === 'AZURE' ? 'az' : 's3')}://${n.bucket}/${n.prefix}*.parquet'`) });
    }
    if (n.kind === 'lh-table') {
      const lh = n.lakehouse!;
      items.push({ label: 'Inspect schema', run: () => actions.onInspect(n) });
      if (lh.engine === 'duckdb') items.push({ label: 'Query in DuckDB', run: () => actions.onQuery(n) });
      if (lh.engine === 'remote' && actions.onQueryRemote) items.push({ label: 'Run on SQL warehouse', run: () => actions.onQueryRemote!(n) });
      if (lh.remoteSql && actions.onMaterialize) items.push({ label: 'Materialise into DuckDB…', run: () => actions.onMaterialize!(n) });
      items.push({ label: 'Insert name at cursor', run: () => actions.onInsert(n.target ?? n.name) });
      items.push({ label: 'Copy qualified name', run: () => void navigator.clipboard.writeText(n.target ?? '') });
      if (actions.onAskCopilot && lh.engine === 'duckdb') items.push({ label: 'Ask DuckCopilot about this', run: () => actions.onAskCopilot!(n) });
    }
    if (n.kind === 'lakehouse' || n.kind === 'lh-catalog' || n.kind === 'lh-schema') items.push({ label: 'Refresh', run: () => void loadChildren(n) });
    if (n.kind === 'lakehouse' && n.lakehouse?.attached) items.push({ label: 'Insert alias at cursor', run: () => actions.onInsert(`${n.lakehouse!.alias}.`) });
    if (n.kind === 'lakehouse-root') items.push({ label: 'Connect a lakehouse…', run: actions.onAddLakehouse });
    if (n.kind === 'local-root' || n.kind === 'folder-root') items.push({ label: 'Add folder to workspace…', run: actions.onAddFolder });
    if (n.kind === 'folder-root') items.push({ label: 'Copy folder path', run: () => void navigator.clipboard.writeText(n.localPath ?? '') }, { label: 'Remove folder from workspace', run: () => actions.onRemoveFolder(n.localPath!), danger: true });
    if (n.kind === 'cloud-root') items.push({ label: 'Add cloud connection', run: actions.onAddConnection });
    return items;
  }, [menu, actions, loadChildren]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div ref={ref} className="flex h-full flex-col">
      <div className="flex items-center gap-1.5 border-b border-zinc-800 px-2 py-1.5">
        <Search className="h-3 w-3 text-zinc-500" />
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter files…" className="h-6 min-w-0 flex-1 bg-transparent text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none" />
        <button onClick={actions.onAddFolder} className="rounded p-1 text-zinc-500 hover:text-accent-300" title={mode === 'full' ? 'Add folder to workspace…' : 'Add a folder inside the data directory'}><FolderPlus className="h-3.5 w-3.5" /></button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-1">
        {roots.map((r) => (
          <Row key={r.id} node={r} depth={0} />
        ))}
      </div>
      {menu && menuItems.length > 0 && (
        <div className="fixed z-50 min-w-[180px] rounded-md border border-zinc-700 bg-zinc-900 p-1 text-xs shadow-xl" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
          {menuItems.map((it) => (
            <button
              key={it.label}
              className={cn('block w-full rounded px-2 py-1.5 text-left hover:bg-zinc-800', it.danger ? 'text-red-300' : 'text-zinc-200')}
              onClick={() => {
                setMenu(null);
                it.run();
              }}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function find(nodes: ExplorerNode[], id: string): ExplorerNode | undefined {
  for (const n of nodes) {
    if (n.id === id) return n;
    const c = n.children ? find(n.children, id) : undefined;
    if (c) return c;
  }
  return undefined;
}
