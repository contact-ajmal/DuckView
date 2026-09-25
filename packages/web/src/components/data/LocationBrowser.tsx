/**
 * The location browser: choose a folder or files on the server's disk, or in a cloud bucket, the way a desktop file
 * dialog does. Places and remote volumes on the left, back/forward/up and an editable path, list or icon view,
 * a preview of the selected file's columns, New folder, and — when DuckView runs on this computer — the operating
 * system's own dialog. Replaces the old folder-only picker everywhere a path is chosen.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { ArrowLeft, ArrowRight, ArrowUp, Box, Cloud, Database, File, FileJson, FileSpreadsheet, Folder, FolderPlus, HardDrive, Home, LayoutGrid, Layers, List, MonitorUp, RefreshCw, Search, Server } from 'lucide-react';
import { api, formatBytes, type CloudConnection, type CloudEntry, type InspectResult } from '../../api/client';
import { Button, IconButton, Input, Modal, cn } from '../ui';
import { Checkbox } from '../ui/forms';
import { InlineError, Skeleton, errorText, promptAction, toast } from '../ui/feedback';

type Where = { kind: 'local'; path?: string } | { kind: 'cloud'; connectionId: string; bucket?: string; prefix: string };
interface Entry { name: string; path: string; uri: string; type: 'dir' | 'file' | 'table_dir' | 'bucket'; kind: string; size_bytes: number | null; modified_at: string | null; queryable: boolean }
interface Listing { where: Where; path: string; display: string; parent: Where | null; writable: boolean; entries: Entry[]; next_token?: string | null }
interface Place { name: string; path: string; kind: 'data' | 'home' | 'folder' | 'volume' }
interface Places { mode: 'sandboxed' | 'full'; places: Place[]; workspace_folders: { name: string; path: string }[]; native_dialog: { available: boolean; reason: string | null } }
interface LocalListing { path: string; parent: string | null; writable: boolean; entries: { name: string; path: string; type: 'dir' | 'file' | 'table_dir'; kind: string; size_bytes: number | null; modified_at: string; queryable: boolean }[] }
type SortKey = 'name' | 'modified' | 'size' | 'kind';

export interface LocationBrowserProps {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
  /** Choose one folder, or one or more files. */
  mode: 'folder' | 'files';
  multiple?: boolean;
  /** Offer the cloud connections as remote volumes (picks are then DuckDB URIs such as s3://bucket/key). */
  remote?: boolean;
  title?: string;
  /** The primary button, e.g. "Add this folder"; defaults to "Select". */
  confirmLabel?: string;
  /** Receives absolute paths (local) or URIs (remote). Throwing keeps the dialog open and shows the error. */
  onPick: (paths: string[]) => Promise<void> | void;
}

const placeIcon = { data: Database, home: Home, folder: Folder, volume: HardDrive } as const;

function EntryIcon({ e, large }: { e: Entry; large?: boolean }) {
  const cls = large ? 'h-8 w-8' : 'h-3.5 w-3.5';
  if (e.type === 'bucket') return <Cloud className={cn(cls, 'text-sky-400')} />;
  if (e.type === 'dir') return <Folder className={cn(cls, 'text-accent-400')} />;
  if (e.type === 'table_dir') return <Layers className={cn(cls, 'text-emerald-400')} />;
  const Icon = e.kind === 'csv' || e.kind === 'excel' ? FileSpreadsheet : e.kind === 'json' ? FileJson : e.kind === 'duckdb' ? Database : e.kind === 'parquet' || e.kind === 'arrow' ? Box : File;
  return <Icon className={cn(cls, e.queryable ? 'text-sky-400' : 'text-zinc-500')} />;
}

const kindLabel = (e: Entry) => (e.type === 'bucket' ? 'Bucket' : e.type === 'dir' ? 'Folder' : e.type === 'table_dir' ? `${e.kind === 'delta' ? 'Delta' : 'Iceberg'} table` : e.kind === 'other' ? (e.name.includes('.') ? e.name.split('.').pop()!.toUpperCase() + ' file' : 'File') : e.kind === 'duckdb' ? 'DuckDB database' : `${e.kind.toUpperCase()} data`);
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const sameWhere = (a: Where | null, b: Where | null) => JSON.stringify(a) === JSON.stringify(b);
const isDir = (e: Entry) => e.type !== 'file';

export function LocationBrowser({ open, onClose, workspaceId, mode, multiple = false, remote = true, title, confirmLabel, onPick }: LocationBrowserProps) {
  const [places, setPlaces] = useState<Places | null>(null);
  const [clouds, setClouds] = useState<CloudConnection[]>([]);
  const [listing, setListing] = useState<Listing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [history, setHistory] = useState<{ stack: Where[]; at: number }>({ stack: [], at: -1 });
  const [pathText, setPathText] = useState('');
  const [query, setQuery] = useState('');
  const [view, setView] = useState<'list' | 'icons'>('list');
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'name', desc: false });
  const [hidden, setHidden] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [active, setActive] = useState(0);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ uri: string; result: InspectResult | null; error: string | null } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const anchor = useRef<number>(0);
  const seq = useRef(0);

  const fetchListing = useCallback(
    async (where: Where): Promise<Listing> => {
      if (where.kind === 'local') {
        const r = await api.get<LocalListing>(`/api/storage/locate?workspace_id=${workspaceId}${where.path ? `&path=${encodeURIComponent(where.path)}` : ''}${hidden ? '&hidden=1' : ''}`);
        return { where: { kind: 'local', path: r.path }, path: r.path, display: r.path, parent: r.parent ? { kind: 'local', path: r.parent } : null, writable: r.writable, entries: r.entries.map((e) => ({ ...e, uri: e.path })) };
      }
      const conn = clouds.find((c) => c.id === where.connectionId);
      const scheme = conn?.uri_scheme ?? 's3';
      if (!where.bucket) {
        const r = await api.get<{ buckets: { name: string; created_at: string | null }[] }>(`/api/storage/cloud?connection_id=${where.connectionId}`);
        return { where, path: '', display: `${conn?.name ?? 'Remote'}`, parent: null, writable: false, entries: r.buckets.map((b) => ({ name: b.name, path: b.name, uri: `${scheme}://${b.name}`, type: 'bucket', kind: 'other', size_bytes: null, modified_at: b.created_at, queryable: false })) };
      }
      const r = await api.get<{ entries: CloudEntry[]; next_token: string | null }>(`/api/storage/cloud?connection_id=${where.connectionId}&bucket=${encodeURIComponent(where.bucket)}&prefix=${encodeURIComponent(where.prefix)}`);
      const trimmed = where.prefix.replace(/\/$/, '');
      const parentPrefix = trimmed.includes('/') ? trimmed.slice(0, trimmed.lastIndexOf('/') + 1) : '';
      const parent: Where | null = where.prefix ? { ...where, prefix: parentPrefix } : conn?.bucket ? null : { kind: 'cloud', connectionId: where.connectionId, prefix: '' };
      return { where, path: where.prefix, display: `${scheme}://${where.bucket}/${where.prefix}`, parent, writable: false, entries: r.entries.map((e) => ({ ...e, type: e.type })), next_token: r.next_token };
    },
    [workspaceId, hidden, clouds],
  );

  const go = useCallback(
    async (where: Where, push = true) => {
      const n = ++seq.current;
      setLoading(true);
      setError(null);
      try {
        const l = await fetchListing(where);
        if (n !== seq.current) return;
        setListing(l);
        setPathText(l.display);
        setSelected([]);
        setActive(0);
        setQuery('');
        setPreview(null);
        if (push)
          setHistory((h) => {
            if (sameWhere(h.stack[h.at] ?? null, l.where)) return h;
            const stack = [...h.stack.slice(0, h.at + 1), l.where];
            return { stack, at: stack.length - 1 };
          });
      } catch (e) {
        if (n === seq.current) setError(e);
      } finally {
        if (n === seq.current) setLoading(false);
      }
    },
    [fetchListing],
  );

  useEffect(() => {
    if (!open) return;
    setHistory({ stack: [], at: -1 });
    setListing(null);
    void api.get<Places>(`/api/storage/places?workspace_id=${workspaceId}`).then(setPlaces, setError);
    if (remote) void api.get<{ connections: CloudConnection[] }>('/api/cloud-connections').then((r) => setClouds(r.connections), () => setClouds([]));
    void go({ kind: 'local' });
  }, [open, workspaceId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Show hidden files: reload the same folder.
  useEffect(() => {
    if (open && listing?.where.kind === 'local') void go(listing.where, false);
  }, [hidden]); // eslint-disable-line react-hooks/exhaustive-deps

  const entries = useMemo(() => {
    if (!listing) return [];
    const q = query.trim().toLowerCase();
    const rows = q ? listing.entries.filter((e) => e.name.toLowerCase().includes(q)) : [...listing.entries];
    const dir = sort.desc ? -1 : 1;
    rows.sort((a, b) => {
      if (isDir(a) !== isDir(b)) return isDir(a) ? -1 : 1;
      const v = sort.key === 'modified' ? (a.modified_at ?? '').localeCompare(b.modified_at ?? '') : sort.key === 'size' ? (a.size_bytes ?? -1) - (b.size_bytes ?? -1) : sort.key === 'kind' ? kindLabel(a).localeCompare(kindLabel(b)) : a.name.localeCompare(b.name, undefined, { numeric: true });
      return v * dir || a.name.localeCompare(b.name, undefined, { numeric: true });
    });
    return rows;
  }, [listing, query, sort]);

  const selectedEntries = entries.filter((e) => selected.includes(e.uri));
  const single = selectedEntries.length === 1 ? selectedEntries[0] : null;

  // Preview the one selected data file (columns and row count).
  useEffect(() => {
    if (!single || single.type === 'dir' || single.type === 'bucket' || !single.queryable) return setPreview(null);
    let live = true;
    setPreview({ uri: single.uri, result: null, error: null });
    api.post<InspectResult>('/api/storage/inspect', { workspace_id: workspaceId, target: single.uri }).then(
      (r) => live && setPreview({ uri: single.uri, result: r, error: null }),
      (e) => live && setPreview({ uri: single.uri, result: null, error: errorText(e) }),
    );
    return () => {
      live = false;
    };
  }, [single?.uri, workspaceId]); // eslint-disable-line react-hooks/exhaustive-deps

  const where = listing?.where ?? null;
  const back = history.at > 0 ? history.stack[history.at - 1] : null;
  const forward = history.at < history.stack.length - 1 ? history.stack[history.at + 1] : null;
  const goBack = () => back && (setHistory((h) => ({ ...h, at: h.at - 1 })), void go(back, false));
  const goForward = () => forward && (setHistory((h) => ({ ...h, at: h.at + 1 })), void go(forward, false));
  const goUp = () => listing?.parent && void go(listing.parent);

  const openEntry = (e: Entry) => {
    if (!where) return;
    if (e.type === 'bucket' && where.kind === 'cloud') return void go({ kind: 'cloud', connectionId: where.connectionId, bucket: e.name, prefix: '' });
    if (e.type === 'dir') return void go(where.kind === 'cloud' ? { ...where, prefix: e.path } : { kind: 'local', path: e.path });
    if (mode === 'files' || e.type === 'table_dir') void finish([e.uri]);
  };

  const finish = async (paths: string[]) => {
    if (!paths.length) return;
    setBusy(true);
    setError(null);
    try {
      await onPick(paths);
      onClose();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const navigatePath = (text: string) => {
    const t = text.trim();
    const m = /^([a-z0-9]+):\/\/([^/]+)\/?(.*)$/i.exec(t);
    if (m) {
      const [, scheme = '', bucket = '', rest = ''] = m;
      const conn = clouds.find((c) => c.uri_scheme.toLowerCase() === scheme.toLowerCase() && (!c.bucket || c.bucket === bucket)) ?? clouds.find((c) => c.uri_scheme.toLowerCase() === scheme.toLowerCase());
      if (!conn) return setError(new Error(`No cloud connection for ${scheme}:// — add one in Sources first.`));
      return void go({ kind: 'cloud', connectionId: conn.id, bucket, prefix: rest && !rest.endsWith('/') ? `${rest}/` : rest });
    }
    void go({ kind: 'local', path: t });
  };

  const newFolder = async () => {
    if (!listing || listing.where.kind !== 'local') return;
    const name = await promptAction('New folder', { label: 'Name', placeholder: 'untitled folder', confirmLabel: 'Create' });
    if (!name?.trim()) return;
    try {
      const r = await api.post<{ path: string }>('/api/storage/mkdir', { workspace_id: workspaceId, parent: listing.path, name: name.trim() });
      await go(listing.where, false);
      setSelected([r.path]);
      toast.success(`Created ${name.trim()}`);
    } catch (e) {
      toast.error(errorText(e));
    }
  };

  const systemDialog = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ paths: string[]; cancelled: boolean }>('/api/storage/native-pick', { kind: mode, multiple, title });
      setBusy(false);
      if (r.cancelled) return;
      await finish(r.paths);
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };

  const click = (e: Entry, i: number, ev: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }) => {
    setActive(i);
    const canMulti = multiple && mode === 'files';
    if (canMulti && ev.shiftKey) {
      const [a, b] = [Math.min(anchor.current, i), Math.max(anchor.current, i)];
      return setSelected(entries.slice(a, b + 1).filter((x) => !isDir(x) || x.type === 'table_dir').map((x) => x.uri));
    }
    anchor.current = i;
    if (canMulti && (ev.metaKey || ev.ctrlKey)) return setSelected((s) => (s.includes(e.uri) ? s.filter((x) => x !== e.uri) : [...s, e.uri]));
    setSelected([e.uri]);
  };

  const onListKey = (ev: ReactKeyboardEvent) => {
    const cols = view === 'icons' ? Math.max(1, Math.floor((listRef.current?.clientWidth ?? 600) / 112)) : 1;
    const moveTo = (i: number) => {
      const n = Math.max(0, Math.min(entries.length - 1, i));
      setActive(n);
      if (entries[n]) setSelected([entries[n].uri]);
      listRef.current?.querySelector<HTMLElement>(`[data-index="${n}"]`)?.scrollIntoView({ block: 'nearest' });
    };
    if (ev.key === 'ArrowDown' && !ev.metaKey) moveTo(active + cols);
    else if (ev.key === 'ArrowUp' && ev.metaKey) goUp();
    else if (ev.key === 'ArrowUp') moveTo(active - cols);
    else if (ev.key === 'ArrowRight' && view === 'icons') moveTo(active + 1);
    else if (ev.key === 'ArrowLeft' && view === 'icons') moveTo(active - 1);
    else if (ev.key === 'Home') moveTo(0);
    else if (ev.key === 'End') moveTo(entries.length - 1);
    else if (ev.key === 'Enter' && entries[active]) openEntry(entries[active]);
    else if (ev.key === 'Backspace') goUp();
    else if (ev.key === '[' && ev.metaKey) goBack();
    else if (ev.key === ']' && ev.metaKey) goForward();
    else if (ev.key === 'a' && (ev.metaKey || ev.ctrlKey) && multiple && mode === 'files') setSelected(entries.filter((x) => x.type === 'file').map((x) => x.uri));
    else return;
    ev.preventDefault();
  };

  // What the primary button chooses.
  const chosen: string[] =
    mode === 'folder'
      ? single && isDir(single) && single.type !== 'bucket'
        ? [single.uri]
        : listing && !(where?.kind === 'cloud' && !where.bucket)
          ? [where?.kind === 'cloud' ? listing.display : listing.path]
          : []
      : selectedEntries.filter((e) => e.type === 'file' || e.type === 'table_dir').map((e) => e.uri);
  const chosenName = mode === 'folder' ? (single && isDir(single) ? single.name : listing?.display.replace(/\/$/, '').split('/').pop() || listing?.display) : chosen.length > 1 ? `${chosen.length} files` : selectedEntries[0]?.name;

  const sidebarItem = (key: string, label: string, Icon: typeof Folder, target: Where, current: boolean, titleText?: string) => (
    <li key={key}>
      <button type="button" onClick={() => void go(target)} title={titleText ?? label} aria-current={current ? 'location' : undefined} className={cn('flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs', current ? 'bg-zinc-800/80 text-zinc-50' : 'text-zinc-300 hover:bg-zinc-900')}>
        <Icon className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
        <span className="truncate">{label}</span>
      </button>
    </li>
  );
  const localAt = (p: string) => where?.kind === 'local' && listing?.path === p;
  const header = (key: SortKey, label: string, cls = '') => (
    <button type="button" className={cn('flex items-center gap-1 text-left hover:text-zinc-200', cls)} onClick={() => setSort((s) => ({ key, desc: s.key === key ? !s.desc : false }))} aria-sort={sort.key === key ? (sort.desc ? 'descending' : 'ascending') : undefined}>
      {label}
      {sort.key === key && <span aria-hidden>{sort.desc ? '↓' : '↑'}</span>}
    </button>
  );

  return (
    <Modal open={open} onClose={onClose} title={title ?? (mode === 'folder' ? 'Choose a folder' : multiple ? 'Choose files' : 'Choose a file')} width="max-w-5xl">
      <div className="flex h-[min(620px,70vh)] flex-col gap-2" data-testid="location-browser">
        {/* Toolbar: history, path, search, view */}
        <div className="flex items-center gap-1">
          <IconButton label="Back" onClick={goBack} disabled={!back}><ArrowLeft className="h-3.5 w-3.5" /></IconButton>
          <IconButton label="Forward" onClick={goForward} disabled={!forward}><ArrowRight className="h-3.5 w-3.5" /></IconButton>
          <IconButton label="Up one level" onClick={goUp} disabled={!listing?.parent} data-testid="lb-up"><ArrowUp className="h-3.5 w-3.5" /></IconButton>
          <form className="min-w-0 flex-1" onSubmit={(e) => { e.preventDefault(); navigatePath(pathText); }}>
            <Input value={pathText} onChange={(e) => setPathText(e.target.value)} aria-label="Location" className="font-mono text-xs" placeholder="/path/to/folder or s3://bucket/prefix" data-testid="lb-path" />
          </form>
          <div className="relative w-44 max-md:hidden">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Filter this folder" placeholder="Filter" className="pl-7" data-testid="lb-filter" />
          </div>
          <IconButton label="Refresh" onClick={() => where && void go(where, false)}><RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} /></IconButton>
          <IconButton label={view === 'list' ? 'Show as icons' : 'Show as list'} onClick={() => setView((v) => (v === 'list' ? 'icons' : 'list'))} data-testid="lb-view">{view === 'list' ? <LayoutGrid className="h-3.5 w-3.5" /> : <List className="h-3.5 w-3.5" />}</IconButton>
        </div>

        <div className="flex min-h-0 flex-1 overflow-hidden rounded-md border border-zinc-800">
          {/* Places and remote volumes */}
          <nav aria-label="Places" className="w-48 shrink-0 space-y-3 overflow-y-auto border-r border-zinc-800 p-2 max-md:hidden" data-testid="lb-places">
            <div>
              <h3 className="px-2 pb-1 text-2xs font-medium text-zinc-500">On this server</h3>
              <ul className="space-y-px">
                {places?.places.filter((p) => p.kind !== 'volume').map((p) => sidebarItem(p.path, p.name, placeIcon[p.kind], { kind: 'local', path: p.path }, localAt(p.path), p.path))}
                {!places && <Skeleton lines={3} className="px-2" />}
              </ul>
            </div>
            {places?.places.some((p) => p.kind === 'volume') && (
              <div>
                <h3 className="px-2 pb-1 text-2xs font-medium text-zinc-500">Volumes</h3>
                <ul className="space-y-px">{places.places.filter((p) => p.kind === 'volume').map((p) => sidebarItem(p.path, p.name, placeIcon.volume, { kind: 'local', path: p.path }, localAt(p.path), p.path))}</ul>
              </div>
            )}
            {!!places?.workspace_folders.length && (
              <div>
                <h3 className="px-2 pb-1 text-2xs font-medium text-zinc-500">Workspace folders</h3>
                <ul className="space-y-px">{places.workspace_folders.map((f) => sidebarItem(`wf:${f.path}`, f.name, Folder, { kind: 'local', path: f.path }, localAt(f.path), f.path))}</ul>
              </div>
            )}
            {remote && (
              <div>
                <h3 className="px-2 pb-1 text-2xs font-medium text-zinc-500">Remote</h3>
                <ul className="space-y-px">
                  {clouds.map((c) => sidebarItem(`c:${c.id}`, c.name, Cloud, { kind: 'cloud', connectionId: c.id, bucket: c.bucket ?? undefined, prefix: '' }, where?.kind === 'cloud' && where.connectionId === c.id, `${c.provider}${c.bucket ? ` · ${c.bucket}` : ''}`))}
                  {!clouds.length && <li className="px-2 text-2xs text-zinc-500">No cloud connections. Add one in Sources.</li>}
                </ul>
              </div>
            )}
          </nav>

          {/* Folder contents */}
          <div className="flex min-w-0 flex-1 flex-col">
            {view === 'list' && (
              <div className="grid grid-cols-[minmax(0,1fr)_10rem_5.5rem_8rem] gap-3 border-b border-zinc-800 bg-zinc-900/60 px-3 py-1.5 text-2xs text-zinc-500 max-md:grid-cols-[minmax(0,1fr)_5.5rem]">
                {header('name', 'Name')}
                {header('modified', 'Modified', 'max-md:hidden')}
                {header('size', 'Size', 'justify-end')}
                {header('kind', 'Kind', 'max-md:hidden')}
              </div>
            )}
            <div
              ref={listRef}
              role="listbox"
              aria-label={listing ? `Contents of ${listing.display}` : 'Folder contents'}
              aria-multiselectable={multiple && mode === 'files'}
              aria-activedescendant={entries[active] ? `lb-item-${active}` : undefined}
              tabIndex={0}
              onKeyDown={onListKey}
              className={cn('min-h-0 flex-1 overflow-y-auto focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent-500', view === 'icons' && 'grid auto-rows-min grid-cols-[repeat(auto-fill,minmax(104px,1fr))] gap-1 p-2')}
              data-testid="lb-list"
            >
              {loading && !listing && <Skeleton lines={8} className="p-3" />}
              {error != null && !listing && <InlineError error={error} onRetry={() => void go(where ?? { kind: 'local' })} className="m-3" />}
              {listing && entries.length === 0 && (
                <p className="p-6 text-center text-xs text-zinc-500">{query ? `Nothing here matches “${query}”.` : mode === 'folder' ? 'This folder is empty. You can still choose it.' : 'This folder is empty.'}</p>
              )}
              {entries.map((e, i) => {
                const sel = selected.includes(e.uri);
                const disabled = mode === 'folder' && e.type === 'file';
                const common = {
                  id: `lb-item-${i}`,
                  role: 'option' as const,
                  'aria-selected': sel,
                  'data-index': i,
                  'data-testid': 'lb-entry',
                  'data-name': e.name,
                  title: e.uri,
                  onClick: (ev: React.MouseEvent) => click(e, i, ev),
                  onDoubleClick: () => openEntry(e),
                };
                return view === 'list' ? (
                  <div key={e.uri} {...common} className={cn('grid cursor-default grid-cols-[minmax(0,1fr)_10rem_5.5rem_8rem] items-center gap-3 border-b border-zinc-800/70 px-3 py-1.5 text-xs max-md:grid-cols-[minmax(0,1fr)_5.5rem]', sel ? 'bg-zinc-800/80 text-zinc-50' : 'text-zinc-300 hover:bg-zinc-900', i === active && 'ring-1 ring-inset ring-zinc-700', disabled && 'text-zinc-500')}>
                    <span className="flex min-w-0 items-center gap-2"><EntryIcon e={e} /><span className="truncate">{e.name}</span></span>
                    <span className="truncate text-zinc-500 max-md:hidden">{when(e.modified_at)}</span>
                    <span className="text-right tabular-nums text-zinc-500">{e.size_bytes != null ? formatBytes(e.size_bytes) : '—'}</span>
                    <span className="truncate text-zinc-500 max-md:hidden">{kindLabel(e)}</span>
                  </div>
                ) : (
                  <div key={e.uri} {...common} className={cn('flex cursor-default flex-col items-center gap-1 rounded p-2 text-center text-xs', sel ? 'bg-zinc-800/80 text-zinc-50' : 'text-zinc-300 hover:bg-zinc-900', i === active && 'ring-1 ring-zinc-700', disabled && 'text-zinc-500')}>
                    <EntryIcon e={e} large />
                    <span className="line-clamp-2 break-all">{e.name}</span>
                  </div>
                );
              })}
              {listing?.next_token && <p className="p-3 text-center text-2xs text-zinc-500">Showing the first {listing.entries.length} objects. Type a longer prefix in the path to narrow it.</p>}
            </div>
          </div>

          {/* Preview of the selection */}
          <aside aria-label="Preview" className="w-64 shrink-0 overflow-y-auto border-l border-zinc-800 p-3 text-xs max-lg:hidden" data-testid="lb-preview">
            {single ? (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <EntryIcon e={single} />
                  <span className="min-w-0 break-all font-medium text-zinc-100">{single.name}</span>
                </div>
                <dl className="grid grid-cols-[4.5rem_1fr] gap-x-2 gap-y-1">
                  <dt className="text-zinc-500">Kind</dt>
                  <dd className="text-zinc-300">{kindLabel(single)}</dd>
                  {single.size_bytes != null && (<><dt className="text-zinc-500">Size</dt><dd className="tabular-nums text-zinc-300">{formatBytes(single.size_bytes)}</dd></>)}
                  <dt className="text-zinc-500">Modified</dt>
                  <dd className="text-zinc-300">{when(single.modified_at)}</dd>
                </dl>
                {preview?.uri === single.uri && (
                  <div className="border-t border-zinc-800 pt-3">
                    {!preview.result && !preview.error && <Skeleton lines={4} />}
                    {preview.error && <p className="text-zinc-500">{preview.error.split('\n')[0]}</p>}
                    {preview.result && (
                      <>
                        <p className="mb-1.5 text-zinc-400">
                          {preview.result.columns.length} columns{preview.result.row_count != null && <> · <span className="tabular-nums">{preview.result.row_count.toLocaleString()}</span> rows</>}
                        </p>
                        <ul className="space-y-0.5" data-testid="lb-columns">
                          {preview.result.columns.slice(0, 30).map((c) => (
                            <li key={c.name} className="flex justify-between gap-2 font-mono text-2xs"><span className="truncate text-zinc-300">{c.name}</span><span className="shrink-0 text-zinc-500">{c.type.toLowerCase()}</span></li>
                          ))}
                          {preview.result.columns.length > 30 && <li className="text-2xs text-zinc-500">and {preview.result.columns.length - 30} more</li>}
                        </ul>
                      </>
                    )}
                  </div>
                )}
              </div>
            ) : selectedEntries.length > 1 ? (
              <p className="text-zinc-400">{selectedEntries.length} items selected<span className="block tabular-nums text-zinc-500">{formatBytes(selectedEntries.reduce((n, e) => n + (e.size_bytes ?? 0), 0))}</span></p>
            ) : (
              <p className="text-zinc-500">{listing ? `${listing.entries.length} item${listing.entries.length === 1 ? '' : 's'} in this ${where?.kind === 'cloud' && !where.bucket ? 'account' : 'folder'}.` : ''} Select a file to see its columns.</p>
            )}
          </aside>
        </div>

        {places?.mode === 'sandboxed' && where?.kind === 'local' && <p className="text-2xs text-zinc-500">This server is sandboxed: only folders inside its data directory can be used.</p>}
        {error != null && listing && <InlineError error={error} className="py-1" />}

        {/* Footer */}
        <div className="flex flex-wrap items-center gap-2">
          {where?.kind === 'local' && listing?.writable && (
            <Button size="sm" variant="ghost" onClick={() => void newFolder()} data-testid="lb-new-folder"><FolderPlus className="h-3.5 w-3.5" /> New folder</Button>
          )}
          {where?.kind === 'local' && <Checkbox label="Show hidden" checked={hidden} onChange={(e) => setHidden(e.target.checked)} />}
          {places?.native_dialog.available && (
            <Button size="sm" variant="ghost" onClick={() => void systemDialog()} disabled={busy} title="Open your computer's own file dialog (DuckView runs on this computer)" data-testid="lb-native">
              <MonitorUp className="h-3.5 w-3.5" /> Use system dialog
            </Button>
          )}
          {where?.kind === 'cloud' && <span className="flex items-center gap-1 text-2xs text-zinc-500"><Server className="h-3 w-3" /> Remote: read-only here</span>}
          {/* Truncated from the start, so the folder's own name stays visible. */}
          <span className="min-w-0 flex-1 truncate text-right font-mono text-2xs text-zinc-500 [direction:rtl]" title={chosen.join('\n')}><bdi>{chosen.length === 1 ? chosen[0] : ''}</bdi></span>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!chosen.length} onClick={() => void finish(chosen)} data-testid="lb-choose">
            {confirmLabel ?? (mode === 'folder' ? `Choose ${chosenName ? `“${chosenName}”` : 'folder'}` : `Choose ${chosenName ?? 'files'}`)}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
