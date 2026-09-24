import { useEffect, useState } from 'react';
import { Bar } from 'react-chartjs-2';
import { UploadCloud, ArrowRight, ArrowUpRight, Search } from 'lucide-react';
import { useCopilot } from '../../store/copilot';
import { DataSourceBar } from './DataSourceBar';
import '../../lib/chart';
import { withAlpha, compactNumber, useChartTheme } from '../../lib/chart';
import { uploadFiles, formatBytes, type OverviewResult, type OverviewColumn } from '../../api/client';
import { useCached } from '../../lib/useCached';
import { CacheChip } from '../../components/CacheChip';
import { ExploreView, type ExploreSource } from '../explore/ExploreView';
import { Sparkles } from 'lucide-react';
import { useWorkspace, useWorkspaceAccess } from '../../store/workspace';
import { ResultsGrid } from '../workspace/ResultsGrid';
import { TypePill } from '../../components/layout';
import { SplitPane } from '../../components/panes';
import { useLayout } from '../../store/layout';
import { Button, Empty, Spinner, Stat, Tabs, cn } from '../../components/ui';
import { quoteIdent } from '../workspace/SchemaTree';
import { QualityChip } from '../transform/QualityChip';
import { CommentsControl } from '../comments/CommentsPanel';
import { DataTable } from '../../components/data';
import { usePageObject } from '../../store/context';


function Distribution({ col }: { col: OverviewColumn }) {
  const ct = useChartTheme();
  const ACCENT = ct.accent;
  const GRID = ct.grid;
  const d = col.distribution;
  if (!d) {
    const highCard = col.approx_unique != null && col.approx_unique > 100;
    return <div className="flex h-28 items-center justify-center px-3 text-center font-mono text-2xs text-zinc-600">{highCard ? `≈${col.approx_unique!.toLocaleString()} distinct · too many values to bucket` : 'no distribution'}</div>;
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

/** Maps the Overview's target kinds onto what the Explore view understands. */
function exploreSource(kind: string, target: string): ExploreSource {
  return { kind: kind === 'table' ? 'table' : kind === 'query' ? 'query' : 'file', target };
}

type DataTab = 'overview' | 'schema' | 'preview' | 'profile' | 'explore' | 'sql';

export function OverviewPage() {
  const ws = useWorkspace();
  const cp = useCopilot();
  const [dtab, setDtab] = useState<DataTab>('overview');
  const [previewFilter, setPreviewFilter] = useState('');
  const { canEdit: canWrite } = useWorkspaceAccess();
  const [uploads, setUploads] = useState<{ name: string; pct: number; error?: string }[]>([]);
  const wsId = ws.activeId;
  const hidden = useLayout((l) => l.hidden);
  const dataVersion = ws.workspaces.find((w) => w.id === wsId)?.data_version;
  // The selection lives in the store (persisted per workspace): moving to Query and back keeps the same dataset on
  // screen, and the profile only changes when a different file is picked (or its data actually changes).
  const target = wsId ? ws.overviewTarget[wsId] ?? null : null;
  usePageObject(target ? { kind: 'dataset', id: target, label: target.split('/').pop() ?? target } : null);
  const setTarget = (t: string | null) => wsId && ws.setOverviewTarget(wsId, t);
  // #/data?table=orders (links from comments and the inbox) opens that table.
  useEffect(() => {
    const t = new URLSearchParams(location.hash.split('?')[1] ?? '').get('table');
    if (t && wsId && t !== target) ws.setOverviewTarget(wsId, t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsId]);

  // Cached in this browser and on the server; a hit paints instantly and is confirmed with a 304 behind the scenes.
  const ov = useCached<OverviewResult>({ workspaceId: wsId, kind: 'overview', target, url: `/api/workspaces/${wsId}/overview`, body: { target }, version: dataVersion });
  const overview = ov.data;
  const loading = ov.state === 'loading' || ov.state === 'restoring' || ov.state === 'revalidating';
  const error = ov.state === 'error' ? ov.error : null;

  useEffect(() => {
    if (!ws.catalog || !wsId) return;
    const first = ws.catalog.files[0]?.path ?? ws.catalog.objects[0]?.name ?? null;
    if (!target) {
      if (first) setTarget(first);
      return;
    }
    // A remembered selection that no longer exists (file deleted, folder removed, table dropped) falls back to the first
    // dataset. Remote objects (s3://…) and attached tables (alias.schema.table) live outside the catalog and are kept.
    const isQuery = /^(select|with|from)\b/i.test(target);
    const isRemote = /^[a-z][a-z0-9+.-]*:\/\//i.test(target) || /^[A-Za-z_][\w]*\.[A-Za-z_][\w]*\.[A-Za-z_][\w]*$/.test(target);
    const exists = isQuery || isRemote || ws.catalog.files.some((f) => f.path === target) || ws.catalog.objects.some((o) => o.name === target || `${o.schema}.${o.name}` === target);
    if (!exists) setTarget(first);
  }, [ws.catalog, target, wsId]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const snippets = overview
    ? [
        { label: 'First 100 rows', sql: `SELECT * FROM ${relation} LIMIT 100;` },
        { label: 'Row count', sql: `SELECT count(*) AS rows FROM ${relation};` },
        { label: 'Column types', sql: `DESCRIBE SELECT * FROM ${relation};` },
        { label: 'Summary statistics', sql: `SUMMARIZE SELECT * FROM ${relation};` },
        { label: 'Duplicate rows', sql: `SELECT count(*) - count(DISTINCT *) AS duplicate_rows FROM ${relation};` },
        ...overview.columns.filter((c) => c.kind === 'string').slice(0, 3).map((c) => ({ label: `Top values of ${c.name}`, sql: `SELECT ${quoteIdent(c.name)}, count(*) AS n FROM ${relation} GROUP BY 1 ORDER BY 2 DESC LIMIT 20;` })),
      ]
    : [];
  const attention = overview ? [...overview.columns].filter((c) => c.null_percentage > 0).sort((x, y) => y.null_percentage - x.null_percentage).slice(0, 6) : [];
  const displayName = overview ? (selectedFile?.root ? `${selectedFile.root.split('/').filter(Boolean).pop()}/${overview.target.slice(selectedFile.root.length + 1)}` : overview.target) : target ?? '';

  return (
    <SplitPane
      direction="horizontal"
      storageKey="overview.sidebar"
      defaultSize={272}
      min={220}
      max={640}
      minSecondary={480}
      collapsed={!!hidden['overview.sidebar']}
      className="h-full"
      primary={
      <aside className="h-full overflow-auto border-r border-zinc-800 bg-zinc-900" aria-label="Sources">
        {wsId && (
          <DataSourceBar
            workspaceId={wsId}
            target={target}
            onSelect={setTarget}
            onImport={(draft) => {
              sessionStorage.setItem('duckview.syncDraft', JSON.stringify(draft));
              location.hash = '#/connections/syncs?new=1';
            }}
            onQuery={openInQuery}
            onFiles={(f) => void onFiles(f)}
            uploads={uploads}
            canWrite={canWrite}
          />
        )}
      </aside>
      }
      secondary={
      <main className="@container flex h-full min-w-0 flex-col">
        {!target ? (
          <Empty icon={<UploadCloud />} title="Add a dataset to get started" hint="Drop a Parquet, CSV or JSON file on Sources, or connect a database or bucket. DuckView profiles it on the spot: size, types, nulls, distributions and a sample." action={<a href="#/connections" className="text-xs text-accent-300 hover:underline">Connect a source</a>} />
        ) : loading && !overview ? (
          <div className="flex h-full items-center justify-center gap-2 text-body text-zinc-400">
            <Spinner /> Profiling {target}…
          </div>
        ) : error ? (
          <div className="m-5 rounded-lg border border-red-500/30 bg-red-500/5 p-4 font-mono text-xs text-red-300">{error}</div>
        ) : overview ? (
          <>
            <div className="shrink-0 px-5 pt-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h1 className="truncate font-mono text-title font-semibold text-zinc-50" title={overview.target} data-testid="dataset-name">{displayName}</h1>
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500">
                    <span>{selectedFile ? selectedFile.kind : overview.kind === 'table' ? 'table' : overview.kind}</span>
                    {overview.size_bytes != null && <span>{formatBytes(overview.size_bytes)}</span>}
                    <span>{overview.row_count.toLocaleString()} rows · {overview.column_count} columns</span>
                    <span className="inline-flex items-center gap-1">query as <code className="rounded bg-zinc-900 px-1 font-mono text-2xs text-zinc-300">{relation}</code></span>
                    {loading && <Spinner className="h-3 w-3" />}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {overview.kind === 'table' && ws.activeId && <QualityChip workspaceId={ws.activeId} relation={overview.target} />}
                  {overview.kind === 'table' && ws.activeId && <CommentsControl key={overview.target} workspaceId={ws.activeId} targetType="table" targetId={overview.target} targetLabel={overview.target} />}
                  <CacheChip state={ov.state} computedAt={ov.computedAt} fromCache={ov.fromCache} serverCached={ov.serverCached} onRefresh={ov.refresh} verb="profiled" />
                  <Button size="sm" variant="ghost" onClick={() => { if (target) cp.setTargets([target]); cp.toggle(true); }}><Sparkles className="h-3.5 w-3.5" /> Ask AI</Button>
                  <Button size="sm" variant="primary" onClick={() => openInQuery(`SELECT * FROM ${relation} LIMIT 100;`)}>Open in SQL <ArrowRight className="h-3.5 w-3.5" /></Button>
                </div>
              </div>
              <Tabs<DataTab>
                className="mt-3"
                value={dtab}
                onChange={setDtab}
                tabs={[
                  { id: 'overview', label: 'Overview' },
                  { id: 'schema', label: 'Schema', count: overview.column_count },
                  { id: 'preview', label: 'Preview' },
                  { id: 'profile', label: 'Profile' },
                  { id: 'explore', label: 'Explore' },
                  { id: 'sql', label: 'SQL' },
                ]}
              />
            </div>

            <div className={cn('min-h-0 flex-1', dtab === 'preview' || dtab === 'explore' ? 'overflow-hidden' : 'overflow-auto px-5 py-4')}>
              {dtab === 'overview' && (
                <div className="space-y-6" data-testid="dataset-overview">
                  {!hidden['overview.kpis'] && (
                    <div className="grid grid-cols-2 gap-x-8 gap-y-4 border-b border-zinc-800 pb-5 @2xl:grid-cols-3 @4xl:grid-cols-5">
                      <Stat label="Rows" value={overview.row_count.toLocaleString()} sub={`counted in ${overview.duration_ms} ms`} />
                      <Stat label="Columns" value={overview.column_count} sub={kindCounts ? `${kindCounts.numeric} numeric · ${kindCounts.text} text · ${kindCounts.temporal} time` : undefined} />
                      <Stat label="Null cells" value={<span className={overview.null_cell_ratio > 0.2 ? 'text-red-400' : overview.null_cell_ratio > 0 ? 'text-amber-500' : undefined}>{(overview.null_cell_ratio * 100).toFixed(overview.null_cell_ratio > 0 && overview.null_cell_ratio < 0.01 ? 2 : 1)}%</span>} sub="of all values" />
                      <Stat label="Duplicate rows" value={overview.duplicate_rows == null ? '—' : overview.duplicate_rows.toLocaleString()} sub={overview.duplicate_rows == null ? 'skipped above 2M rows' : 'exact duplicates'} />
                      <Stat label="Size" value={overview.size_bytes != null ? formatBytes(overview.size_bytes) : '—'} sub={overview.size_bytes != null && overview.row_count ? `≈${formatBytes(overview.size_bytes / overview.row_count)} per row` : undefined} />
                    </div>
                  )}
                  <div className="grid gap-8 @4xl:grid-cols-2">
                    <section>
                      <h2 className="mb-2 text-body font-semibold text-zinc-100">Columns with missing values</h2>
                      {attention.length === 0 ? (
                        <p className="text-xs text-zinc-500">Every column is complete.</p>
                      ) : (
                        <ul className="divide-y divide-zinc-800/70 border-y border-zinc-800">
                          {attention.map((c) => (
                            <li key={c.name} className="flex items-center gap-3 py-1.5 text-xs">
                              <span className="min-w-0 flex-1 truncate font-mono text-zinc-200">{c.name}</span>
                              <TypePill type={c.type} />
                              <span className="h-1.5 w-24 overflow-hidden rounded-full bg-zinc-800"><span className="block h-full rounded-full" style={{ width: `${Math.min(100, c.null_percentage)}%`, background: nullTone(c.null_percentage) }} /></span>
                              <span className="w-12 text-right tabular-nums text-zinc-400">{c.null_percentage.toFixed(c.null_percentage < 1 ? 1 : 0)}%</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </section>
                    <section>
                      <h2 className="mb-2 text-body font-semibold text-zinc-100">Columns</h2>
                      <ul className="grid grid-cols-2 gap-x-6 border-y border-zinc-800 py-1 text-xs @5xl:grid-cols-3">
                        {overview.columns.slice(0, 18).map((c) => (
                          <li key={c.name} className="flex min-w-0 items-center justify-between gap-2 py-1">
                            <span className="truncate font-mono text-zinc-200">{c.name}</span>
                            <TypePill type={c.type} />
                          </li>
                        ))}
                      </ul>
                      {overview.columns.length > 18 && <button className="mt-1.5 text-xs text-zinc-500 hover:text-zinc-200" onClick={() => setDtab('schema')}>All {overview.columns.length} columns in Schema</button>}
                    </section>
                  </div>
                  {!hidden['overview.sample'] && (
                    <section>
                      <div className="mb-2 flex items-center justify-between">
                        <h2 className="text-body font-semibold text-zinc-100">Sample</h2>
                        <button className="text-xs text-zinc-500 hover:text-zinc-200" onClick={() => setDtab('preview')}>Open preview</button>
                      </div>
                      <div className="h-64 overflow-hidden rounded-md border border-zinc-800">
                        <ResultsGrid columns={overview.sample.columns} rows={overview.sample.rows.slice(0, 20)} />
                      </div>
                    </section>
                  )}
                </div>
              )}

              {dtab === 'schema' && (
                <DataTable
                  label="Columns"
                  rows={overview.columns}
                  rowKey={(c) => c.name}
                  columns={[
                    { key: 'c0', header: '#', width: 'w-10', cell: (c) => <span className="text-zinc-600">{overview.columns.indexOf(c) + 1}</span> },
                    { key: 'column', header: 'Column', sortValue: (c) => c.name, cell: (c) => <><button className="text-zinc-100 hover:text-accent-300" onClick={() => openInQuery(`SELECT ${quoteIdent(c.name)}, count(*) AS n FROM ${relation} GROUP BY 1 ORDER BY 2 DESC LIMIT 20;`)} title="Value counts in SQL">
                            {c.name}
                          </button></> },
                    { key: 'type', header: 'Type', cell: (c) => <><TypePill type={c.type} /></> },
                    { key: 'nulls', header: 'Nulls', align: 'right', cell: (c) => <><div className="flex items-center justify-end gap-2">
                            <div className="h-1.5 w-12 overflow-hidden rounded-full bg-zinc-800"><div className="h-full rounded-full" style={{ width: `${Math.min(100, c.null_percentage)}%`, background: nullTone(c.null_percentage) }} /></div>
                            <span className="w-10 text-right tabular-nums text-zinc-400">{c.null_percentage.toFixed(c.null_percentage > 0 && c.null_percentage < 1 ? 1 : 0)}%</span>
                          </div></> },
                    { key: 'distinct', header: 'Distinct ≈', align: 'right', cell: (c) => <span className="tabular-nums text-zinc-400">{c.approx_unique?.toLocaleString() ?? '—'}</span> },
                    { key: 'min', header: 'Min', truncate: true, cell: (c) => <span className="max-w-[180px] truncate text-zinc-400">{c.min ?? '—'}</span> },
                    { key: 'max', header: 'Max', truncate: true, cell: (c) => <span className="max-w-[180px] truncate text-zinc-400">{c.max ?? '—'}</span> },
                    { key: 'avg', header: 'Avg', align: 'right', cell: (c) => <span className="tabular-nums text-zinc-400">{c.avg != null ? Number(c.avg).toLocaleString(undefined, { maximumFractionDigits: 3 }) : '—'}</span> },
                  ]}
                />
              )}

              {dtab === 'preview' && (
                <div className="flex h-full flex-col">
                  <div className="flex h-9 shrink-0 items-center gap-2 border-b border-zinc-800 px-5 text-xs text-zinc-500">
                    First {overview.sample.rows.length} rows
                    <div className="relative ml-auto">
                      <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-zinc-500" />
                      <input value={previewFilter} onChange={(e) => setPreviewFilter(e.target.value)} placeholder="Filter rows" aria-label="Filter preview rows" className="h-[26px] w-44 rounded-md border border-zinc-800 bg-zinc-950 pl-6 pr-2 text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-accent-500 focus:outline-none" />
                    </div>
                    <Button size="sm" variant="ghost" onClick={() => openInQuery(`SELECT * FROM ${relation} LIMIT 1000;`)}>Query all rows <ArrowUpRight className="h-3 w-3" /></Button>
                  </div>
                  <div className="min-h-0 flex-1"><ResultsGrid columns={overview.sample.columns} rows={overview.sample.rows} filter={previewFilter} /></div>
                </div>
              )}

              {dtab === 'profile' && (
                <div className="grid gap-x-6 gap-y-5 @2xl:grid-cols-2 @5xl:grid-cols-3" data-testid="dataset-profile">
                  {overview.columns.map((c) => (
                    <div key={c.name} className="min-w-0">
                      <div className="mb-1 flex items-center justify-between gap-2">
                        <span className="truncate font-mono text-xs text-zinc-100">{c.name}</span>
                        <TypePill type={c.type} />
                      </div>
                      <Distribution col={c} />
                    </div>
                  ))}
                </div>
              )}

              {dtab === 'explore' && target && <ExploreView workspaceId={wsId!} source={exploreSource(overview.kind, target)} />}

              {dtab === 'sql' && (
                <ul className="max-w-4xl divide-y divide-zinc-800/70 border-y border-zinc-800">
                  {snippets.map((sn) => (
                    <li key={sn.label} className="flex items-center gap-4 py-2">
                      <div className="min-w-0 flex-1">
                        <div className="text-body text-zinc-100">{sn.label}</div>
                        <code className="block truncate font-mono text-xs text-zinc-500">{sn.sql}</code>
                      </div>
                      <Button size="sm" variant="ghost" onClick={() => openInQuery(sn.sql)}>Open in SQL <ArrowUpRight className="h-3 w-3" /></Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        ) : null}
      </main>
      }
    />
  );
}
