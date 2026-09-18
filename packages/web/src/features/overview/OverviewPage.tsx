import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bar } from 'react-chartjs-2';
import { UploadCloud, Table2, Eye, FileSpreadsheet, FileJson, Database, Box, Folder, FolderPlus, FolderOpen, Trash2, ArrowRight, ArrowUpRight, RefreshCw, ChevronDown, ChevronRight, X } from 'lucide-react';
import { FolderPicker } from '../explorer/FolderPicker';
import '../../lib/chart';
import { withAlpha, compactNumber, useChartTheme } from '../../lib/chart';
import { api, uploadFiles, formatBytes, type OverviewResult, type OverviewColumn, type JailEntry } from '../../api/client';
import { useWorkspace, useWorkspaceAccess } from '../../store/workspace';
import { ResultsGrid } from '../workspace/ResultsGrid';
import { Eyebrow, PageTitle, SideCard, Panel, TypePill, Tag } from '../../components/layout';
import { SplitPane } from '../../components/panes';
import { useLayout } from '../../store/layout';
import { HideButton } from '../../components/LayoutMenu';
import { Empty, Spinner, cn } from '../../components/ui';
import { quoteIdent } from '../workspace/SchemaTree';

const fileIcon = (kind: string, cls = 'h-4 w-4') => {
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
    default:
      return <Folder className={cn(cls, 'text-zinc-400')} />;
  }
};

function Kpi({ label, value, sub, sql, onSql, tone }: { label: string; value: React.ReactNode; sub?: React.ReactNode; sql?: string; onSql?: (sql: string) => void; tone?: 'warn' | 'bad' }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 px-5 py-4">
      <div className="flex items-center justify-between">
        <div className="text-[12px] text-zinc-400">{label}</div>
        {sql && onSql && (
          <button onClick={() => onSql(sql)} className="inline-flex items-center gap-0.5 font-mono text-[10px] text-zinc-500 hover:text-accent-300" title={sql}>
            SQL <ArrowUpRight className="h-3 w-3" />
          </button>
        )}
      </div>
      <div className={cn('mt-1 text-3xl font-semibold tracking-tight', tone === 'bad' ? 'text-red-300' : tone === 'warn' ? 'text-amber-200' : 'text-zinc-50')}>{value}</div>
      {sub && <div className="mt-1 font-mono text-[11px] text-zinc-500">{sub}</div>}
    </div>
  );
}

function Distribution({ col }: { col: OverviewColumn }) {
  const ct = useChartTheme();
  const ACCENT = ct.accent;
  const GRID = ct.grid;
  const d = col.distribution;
  if (!d) {
    const highCard = col.approx_unique != null && col.approx_unique > 100;
    return <div className="flex h-28 items-center justify-center px-3 text-center font-mono text-[11px] text-zinc-600">{highCard ? `≈${col.approx_unique!.toLocaleString()} distinct · too many values to bucket` : 'no distribution'}</div>;
  }
  const labels = d.kind === 'categories' ? [...d.bins.map((b) => b.label), ...(d.other > 0 ? ['Other'] : [])] : d.bins.map((b) => b.label);
  const data = d.kind === 'categories' ? [...d.bins.map((b) => b.count), ...(d.other > 0 ? [d.other] : [])] : d.bins.map((b) => b.count);
  const horizontal = d.kind === 'categories';
  return (
    <div className="h-28">
      <Bar
        data={{ labels, datasets: [{ data, backgroundColor: labels.map((l) => (l === 'Other' ? ct.muted : withAlpha(ACCENT, 0.85))), borderColor: ct.border, borderWidth: 1, borderRadius: 3, borderSkipped: horizontal ? 'left' : 'bottom', categoryPercentage: d.kind === 'histogram' ? 1 : 0.8, barPercentage: d.kind === 'histogram' ? 0.95 : 0.9 }] }}
        options={{
          indexAxis: horizontal ? 'y' : 'x',
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                title: (items) => {
                  const i = items[0]?.dataIndex ?? 0;
                  if (d.kind === 'histogram') {
                    const b = d.bins[i];
                    return b ? `${b.label} – ${b.hi.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : '';
                  }
                  return String(labels[i]);
                },
                label: (item) => ` ${Number(item.raw).toLocaleString()} rows`,
              },
            },
          },
          scales: {
            x: { display: !horizontal, grid: { display: false }, ticks: { maxTicksLimit: 6, maxRotation: 0, font: { size: 9, family: 'JetBrains Mono, monospace' } }, border: { display: false } },
            y: horizontal ? { grid: { display: false }, ticks: { font: { size: 9, family: 'JetBrains Mono, monospace' }, callback: (v) => String(labels[Number(v)] ?? '').slice(0, 14) }, border: { display: false } } : { grid: { color: GRID }, ticks: { maxTicksLimit: 3, font: { size: 9 }, callback: (v) => compactNumber(Number(v)) }, border: { display: false } },
          },
        }}
      />
    </div>
  );
}

export function OverviewPage() {
  const ws = useWorkspace();
  const { canEdit: canWrite } = useWorkspaceAccess();
  const [target, setTarget] = useState<string | null>(null);
  const [overview, setOverview] = useState<OverviewResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [uploads, setUploads] = useState<{ name: string; pct: number; error?: string }[]>([]);
  const [picker, setPicker] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const fileInput = useRef<HTMLInputElement>(null);
  const wsId = ws.activeId;
  const hidden = useLayout((l) => l.hidden);

  const load = useCallback(
    async (t: string) => {
      if (!wsId) return;
      setLoading(true);
      setError(null);
      try {
        setOverview(await api.post<OverviewResult>(`/api/workspaces/${wsId}/overview`, { target: t }));
      } catch (e) {
        setOverview(null);
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [wsId],
  );

  useEffect(() => {
    if (!ws.catalog || target) return;
    const first = ws.catalog.files[0]?.path ?? ws.catalog.objects[0]?.name ?? null;
    if (first) setTarget(first);
  }, [ws.catalog, target]);
  useEffect(() => {
    setTarget(null);
    setOverview(null);
  }, [wsId]);
  useEffect(() => {
    if (target) void load(target);
  }, [target, load]);

  const onFiles = async (files: File[]) => {
    if (!wsId || !files.length) return;
    for (const f of files) {
      setUploads((u) => [...u.filter((x) => x.name !== f.name), { name: f.name, pct: 0 }]);
      try {
        const r = await uploadFiles(wsId, [f], { onProgress: (pct) => setUploads((u) => u.map((x) => (x.name === f.name ? { ...x, pct } : x))) });
        setUploads((u) => u.filter((x) => x.name !== f.name));
        await ws.loadCatalog(true);
        if (r.files[0]) setTarget(r.files[0].path);
      } catch (e) {
        setUploads((u) => u.map((x) => (x.name === f.name ? { ...x, error: (e as Error).message } : x)));
      }
    }
  };

  /** Mounts a folder into the workspace, refreshes the dataset list and profiles the first data file in it. */
  const addFolder = async (folderPath: string) => {
    if (!wsId) return;
    const r = await api.post<{ folders: { path: string; name: string }[] }>(`/api/workspaces/${wsId}/folders`, { path: folderPath });
    // The server canonicalises the path (realpath) and appends new folders, so the last entry is the one just added.
    const added = r.folders.find((f) => f.path === folderPath) ?? r.folders[r.folders.length - 1];
    await ws.loadCatalog(true);
    const fresh = useWorkspace.getState().catalog?.files ?? [];
    const first = added ? fresh.find((f) => f.root === added.path) : undefined;
    if (first) setTarget(first.path);
    else if (added) alert(`Added ${added.name}, but no data files (parquet/csv/json/duckdb/xlsx) were found in it.`);
  };
  const removeFolder = async (root: string) => {
    if (!wsId || !confirm(`Remove ${root} from this workspace? Files are not deleted.`)) return;
    await api.del(`/api/workspaces/${wsId}/folders?path=${encodeURIComponent(root)}`);
    await ws.loadCatalog(true);
    if (target && target.startsWith(root + '/')) setTarget(null);
  };

  const removeFile = async (f: JailEntry) => {
    if (!wsId || !confirm(`Delete ${f.path} from the data directory?`)) return;
    await api.del(`/api/workspaces/${wsId}/files?path=${encodeURIComponent(f.path)}`);
    await ws.loadCatalog(true);
    if (target === f.path) setTarget(null);
  };

  /** Opens the Query tab with `sql` appended to the active editor. */
  const openInQuery = (sql: string) => {
    const tab = ws.tabs.find((t) => t.id === ws.activeTabId);
    if (tab) {
      const cur = (ws.drafts[tab.id] ?? tab.sql_content).trim();
      const next = cur ? `${cur}\n\n${sql}` : sql;
      ws.setDraft(tab.id, next, next.length);
    }
    location.hash = '#/query';
  };

  const files = ws.catalog?.files ?? [];
  const objects = ws.catalog?.objects ?? [];
  const groups = useMemo(() => {
    const byRoot = new Map<string, JailEntry[]>();
    for (const f of files) {
      const key = f.root ?? '';
      if (!byRoot.has(key)) byRoot.set(key, []);
      byRoot.get(key)!.push(f);
    }
    return [...byRoot.entries()].sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)));
  }, [files]);
  const relation = overview ? (overview.kind === 'file' ? `'${overview.target}'` : overview.kind === 'query' ? `(${overview.target})` : overview.target) : '';
  const nullTone = (pct: number) => (pct > 20 ? 'var(--status-serious)' : pct > 0 ? 'var(--status-warning)' : 'var(--series-1)');
  const kindCounts = overview
    ? overview.columns.reduce(
        (acc, c) => {
          acc[c.kind === 'number' ? 'numeric' : c.kind === 'temporal' ? 'temporal' : c.kind === 'string' ? 'text' : 'other']++;
          return acc;
        },
        { numeric: 0, text: 0, temporal: 0, other: 0 },
      )
    : null;
  const selectedFile = files.find((f) => f.path === target);

  return (
    <SplitPane
      direction="horizontal"
      storageKey="overview.sidebar"
      defaultSize={290}
      min={220}
      max={640}
      minSecondary={480}
      collapsed={!!hidden['overview.sidebar']}
      className="h-full p-5"
      primary={
      <aside className="flex h-full flex-col gap-4 overflow-auto pr-2">
        <SideCard
          title="Your datasets"
          hideId="overview.sidebar"
          meta={
            <span className="flex items-center gap-2">
              <span>{files.length + objects.length}</span>
              {canWrite && (
                <button onClick={() => setPicker(true)} className="inline-flex items-center gap-1 text-accent-300 hover:underline" title="Add a folder from this computer to the workspace">
                  <FolderPlus className="h-3 w-3" /> add folder
                </button>
              )}
            </span>
          }
        >
          <div
            className={cn('flex cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed px-3 py-5 text-center transition-colors', dragging ? 'border-accent-500 bg-accent-600/10' : 'border-zinc-700 hover:border-zinc-500', !canWrite && 'pointer-events-none opacity-50')}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              void onFiles([...e.dataTransfer.files]);
            }}
            onClick={() => fileInput.current?.click()}
          >
            <UploadCloud className={cn('mb-2 h-5 w-5', dragging ? 'text-accent-300' : 'text-zinc-500')} />
            <div className="text-xs text-zinc-200">
              <span className="font-semibold">Drop files</span> or click to browse
            </div>
            <div className="mt-1 font-mono text-[10px] text-zinc-500">parquet · csv · tsv · json · ndjson · duckdb · xlsx</div>
            <input ref={fileInput} type="file" multiple className="hidden" onChange={(e) => void onFiles([...(e.target.files ?? [])])} />
          </div>
          {canWrite && (
            <button onClick={() => setPicker(true)} className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg border border-zinc-800 px-3 py-2 text-xs text-zinc-300 hover:border-zinc-600 hover:text-zinc-50">
              <FolderPlus className="h-3.5 w-3.5 text-accent-300" /> Add folder from this computer
            </button>
          )}
          {uploads.length > 0 && (
            <div className="mt-2 space-y-1">
              {uploads.map((u) => (
                <div key={u.name} className="rounded-md border border-zinc-800 bg-zinc-900 px-2 py-1.5 text-[11px]">
                  <div className="flex justify-between text-zinc-300">
                    <span className="truncate">{u.name}</span>
                    <span className={u.error ? 'text-red-300' : 'text-zinc-500'}>{u.error ? 'failed' : `${u.pct}%`}</span>
                  </div>
                  {u.error ? <div className="mt-0.5 text-red-300">{u.error}</div> : <div className="mt-1 h-1 overflow-hidden rounded bg-zinc-800"><div className="h-full bg-accent-500 transition-all" style={{ width: `${u.pct}%` }} /></div>}
                </div>
              ))}
            </div>
          )}
          <div className="mt-3 space-y-0.5">
            {groups.map(([root, items]) => {
              const isFolder = root !== '';
              const open = !collapsed.has(root);
              const label = isFolder ? root.split('/').filter(Boolean).pop() ?? root : 'Data directory';
              return (
                <div key={root || '__data'}>
                  <div className="group/root flex items-center gap-1 rounded px-1 py-1">
                    <button
                      onClick={() => {
                        const next = new Set(collapsed);
                        if (next.has(root)) next.delete(root);
                        else next.add(root);
                        setCollapsed(next);
                      }}
                      className="flex min-w-0 flex-1 items-center gap-1 text-left"
                      title={root || 'Files uploaded to the workspace data directory'}
                    >
                      {open ? <ChevronDown className="h-3 w-3 text-zinc-500" /> : <ChevronRight className="h-3 w-3 text-zinc-500" />}
                      {isFolder ? (open ? <FolderOpen className="h-3.5 w-3.5 text-accent-300" /> : <Folder className="h-3.5 w-3.5 text-accent-300" />) : <Database className="h-3.5 w-3.5 text-zinc-400" />}
                      <span className="truncate text-[10px] font-semibold uppercase tracking-wider text-zinc-400">{label}</span>
                      <span className="font-mono text-[10px] text-zinc-600" title={ws.catalog?.truncated_folders?.includes(root) ? 'Showing the first 500 data files (4 levels deep). Use the Explorer on the Query page to browse everything.' : undefined}>
                        {items.length}{ws.catalog?.truncated_folders?.includes(root) ? '+' : ''}
                      </span>
                    </button>
                    {isFolder && canWrite && (
                      <button onClick={() => void removeFolder(root)} className="rounded p-0.5 text-zinc-600 opacity-0 hover:text-red-300 group-hover/root:opacity-100" title="Remove folder from workspace">
                        <X className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                  {open &&
                    items.map((f) => {
                      const display = f.root ? f.path.slice(f.root.length + 1) : f.path;
                      return (
                        <div key={f.path} className={cn('group ml-3 flex items-center gap-2 rounded-md px-2 py-1.5', target === f.path ? 'bg-accent-600/15' : 'hover:bg-zinc-800/60')}>
                          <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', target === f.path ? 'bg-emerald-400' : 'bg-zinc-700')} />
                          <button className="min-w-0 flex-1 text-left" onClick={() => setTarget(f.path)} title={f.path}>
                            <div className="truncate font-mono text-xs text-zinc-100">{display}</div>
                            <div className="truncate font-mono text-[10px] text-zinc-500">
                              {f.kind.toUpperCase()} · {formatBytes(f.size_bytes)}
                            </div>
                          </button>
                          {canWrite && !f.root && (
                            <button className="rounded p-0.5 text-zinc-600 opacity-0 hover:text-red-300 group-hover:opacity-100" onClick={() => void removeFile(f)} title="Delete file">
                              <Trash2 className="h-3 w-3" />
                            </button>
                          )}
                        </div>
                      );
                    })}
                </div>
              );
            })}
            {objects.map((o) => {
              const name = o.schema === 'main' ? o.name : `${o.schema}.${o.name}`;
              return (
                <button key={name} onClick={() => setTarget(name)} className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left', target === name ? 'bg-accent-600/15' : 'hover:bg-zinc-800/60')}>
                  {o.type === 'VIEW' ? <Eye className="h-3.5 w-3.5 text-sky-300" /> : <Table2 className="h-3.5 w-3.5 text-accent-300" />}
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-xs text-zinc-100">{name}</div>
                    <div className="font-mono text-[10px] text-zinc-500">
                      {o.type} · {o.column_count} cols{o.estimated_rows != null ? ` · ~${o.estimated_rows.toLocaleString()} rows` : ''}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
          <p className="mt-3 text-[11px] leading-snug text-zinc-500">Uploaded files live in the data directory; added folders are read in place by DuckDB.</p>
        </SideCard>
        {wsId && <FolderPicker open={picker} workspaceId={wsId} onClose={() => setPicker(false)} onPick={addFolder} />}

      </aside>
      }
      secondary={
      <main className="h-full min-w-0 overflow-auto pl-3">
        {!target ? (
          <div className="flex h-full items-center justify-center rounded-xl border border-dashed border-zinc-800">
            <Empty icon={<UploadCloud className="h-10 w-10" />} title="Ingest a dataset to get started" hint="Drop a Parquet, CSV or JSON file onto the left panel. DuckView profiles it instantly: row/column counts, null ratios, a sample and distributions." />
          </div>
        ) : loading && !overview ? (
          <div className="flex h-full items-center justify-center gap-2 text-sm text-zinc-400">
            <Spinner /> Profiling {target}…
          </div>
        ) : error ? (
          <div className="rounded-xl border border-red-900 bg-red-950/40 p-4 font-mono text-xs text-red-200">{error}</div>
        ) : overview ? (
          <div className="space-y-5">
            <div>
              <Eyebrow>Overview · auto-generated on load</Eyebrow>
              <div className="mt-1 flex flex-wrap items-end justify-between gap-3">
                <div className="min-w-0">
                  <PageTitle className="truncate font-mono" title={overview.target}>{selectedFile?.root ? `${selectedFile.root.split('/').filter(Boolean).pop()}/${overview.target.slice(selectedFile.root.length + 1)}` : overview.target}</PageTitle>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <Tag>{selectedFile ? selectedFile.kind.toUpperCase() : overview.kind.toUpperCase()}</Tag>
                    {overview.size_bytes != null && <Tag>{formatBytes(overview.size_bytes)}</Tag>}
                    <Tag>{overview.kind === 'file' ? 'native file scan' : overview.kind === 'table' ? 'in-database' : 'subquery'}</Tag>
                    <span className="ml-1 font-mono text-[11px] text-zinc-500">
                      query it as <Tag className="text-zinc-300">{relation}</Tag>
                    </span>
                    {loading && <Spinner className="h-3.5 w-3.5" />}
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <span className="font-mono text-[11px] text-zinc-500">overview suite finished in {overview.duration_ms} ms</span>
                  <button onClick={() => openInQuery(`SELECT * FROM ${relation} LIMIT 100;`)} className="inline-flex items-center gap-1.5 rounded-md border border-accent-600/60 bg-accent-600/20 px-3 py-1.5 text-xs font-medium text-accent-100 hover:bg-accent-600/30">
                    Open Query tool <ArrowRight className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            </div>

            {!hidden['overview.kpis'] && <div className="group/kpi relative grid grid-cols-1 gap-4 md:grid-cols-3">
              <HideButton id="overview.kpis" className="absolute -top-5 right-0 opacity-0 group-hover/kpi:opacity-100" />
              <Kpi label="Total rows" value={overview.row_count.toLocaleString()} sub={`COUNT(*) · ${overview.duration_ms} ms suite`} sql={`SELECT count(*) AS rows FROM ${relation};`} onSql={openInQuery} />
              <Kpi label="Total columns" value={overview.column_count} sub={kindCounts ? `${kindCounts.numeric} numeric · ${kindCounts.text} text · ${kindCounts.temporal} temporal · ${kindCounts.other} other` : undefined} sql={`DESCRIBE SELECT * FROM ${relation};`} onSql={openInQuery} />
              <Kpi
                label="Data quality"
                value={`${(overview.null_cell_ratio * 100).toFixed(2)}% null`}
                tone={overview.null_cell_ratio > 0.2 ? 'bad' : overview.null_cell_ratio > 0 || (overview.duplicate_rows ?? 0) > 0 ? 'warn' : undefined}
                sub={`${overview.duplicate_rows == null ? 'duplicates skipped (>2M rows)' : `${overview.duplicate_rows.toLocaleString()} duplicate rows`}${overview.size_bytes != null && overview.row_count ? ` · ≈${formatBytes(overview.size_bytes / overview.row_count)}/row` : ''}`}
                sql={`SELECT count(*) - count(DISTINCT *) AS duplicate_rows FROM ${relation};`}
                onSql={openInQuery}
              />
            </div>}

            {!hidden['overview.schema'] && <Panel
              hideId="overview.schema"
              title="Schema"
              meta={`profiled with SUMMARIZE in ${overview.duration_ms} ms`}
              bodyClassName="p-0"
              actions={
                <div className="flex items-center gap-3 font-mono text-[11px]">
                  <button className="inline-flex items-center gap-0.5 text-zinc-400 hover:text-accent-300" onClick={() => openInQuery(`DESCRIBE SELECT * FROM ${relation};`)}>
                    DESCRIBE <ArrowUpRight className="h-3 w-3" />
                  </button>
                  <button className="inline-flex items-center gap-0.5 text-zinc-400 hover:text-accent-300" onClick={() => openInQuery(`SUMMARIZE SELECT * FROM ${relation};`)}>
                    SUMMARIZE <ArrowUpRight className="h-3 w-3" />
                  </button>
                </div>
              }
            >
              <table className="w-full font-mono text-xs">
                <thead className="text-left text-[11px] text-zinc-500">
                  <tr className="border-b border-zinc-800">
                    <th className="px-4 py-2 font-normal">#</th>
                    <th className="px-2 py-2 font-normal">column</th>
                    <th className="px-2 py-2 font-normal">type</th>
                    <th className="px-2 py-2 text-right font-normal">nulls</th>
                    <th className="px-2 py-2 text-right font-normal">distinct ≈</th>
                    <th className="px-2 py-2 font-normal">min</th>
                    <th className="px-2 py-2 font-normal">max</th>
                    <th className="px-4 py-2 text-right font-normal">avg</th>
                  </tr>
                </thead>
                <tbody>
                  {overview.columns.map((c, i) => (
                    <tr key={c.name} className="border-b border-zinc-800/60 last:border-0 hover:bg-zinc-800/30">
                      <td className="px-4 py-2 text-zinc-600">{i + 1}</td>
                      <td className="px-2 py-2">
                        <button className="text-zinc-100 hover:text-accent-300" onClick={() => openInQuery(`SELECT ${quoteIdent(c.name)}, count(*) AS n FROM ${relation} GROUP BY 1 ORDER BY 2 DESC LIMIT 20;`)} title="Open value counts in the Query tool">
                          {c.name}
                        </button>
                      </td>
                      <td className="px-2 py-2">
                        <TypePill type={c.type} />
                      </td>
                      <td className="px-2 py-2">
                        <div className="flex items-center justify-end gap-2">
                          <div className="h-1.5 w-14 overflow-hidden rounded bg-zinc-800">
                            <div className="h-full rounded" style={{ width: `${Math.min(100, c.null_percentage)}%`, background: nullTone(c.null_percentage) }} />
                          </div>
                          <span className="w-10 text-right text-zinc-300">{c.null_percentage.toFixed(c.null_percentage > 0 && c.null_percentage < 1 ? 1 : 0)}%</span>
                        </div>
                      </td>
                      <td className="px-2 py-2 text-right text-zinc-300">{c.approx_unique?.toLocaleString() ?? '—'}</td>
                      <td className="max-w-[180px] truncate px-2 py-2 text-zinc-300" title={c.min ?? ''}>{c.min ?? '—'}</td>
                      <td className="max-w-[180px] truncate px-2 py-2 text-zinc-300" title={c.max ?? ''}>{c.max ?? '—'}</td>
                      <td className="px-4 py-2 text-right text-zinc-300">{c.avg != null ? Number(c.avg).toLocaleString(undefined, { maximumFractionDigits: 3 }) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>}

            {!hidden['overview.distributions'] && <Panel hideId="overview.distributions" title="Distributions" meta="equi-width histograms · top values · time buckets">
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {overview.columns.map((c) => (
                  <div key={c.name} className="rounded-lg border border-zinc-800/80 bg-zinc-950/60 p-3">
                    <div className="mb-2 flex items-center justify-between gap-2">
                      <span className="truncate font-mono text-xs text-zinc-100">{c.name}</span>
                      <TypePill type={c.type} />
                    </div>
                    <Distribution col={c} />
                  </div>
                ))}
              </div>
            </Panel>}

            {!hidden['overview.sample'] && <Panel hideId="overview.sample" title="Sample" meta={`first ${overview.sample.rows.length} rows`} bodyClassName="p-0" actions={<button className="inline-flex items-center gap-0.5 font-mono text-[11px] text-zinc-400 hover:text-accent-300" onClick={() => openInQuery(`SELECT * FROM ${relation} LIMIT 100;`)}>SELECT * <ArrowUpRight className="h-3 w-3" /></button>}>
              <div className="h-80 overflow-hidden rounded-b-xl">
                <ResultsGrid columns={overview.sample.columns} rows={overview.sample.rows} />
              </div>
            </Panel>}
          </div>
        ) : null}
      </main>
      }
    />
  );
}
