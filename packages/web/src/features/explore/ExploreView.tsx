import { useEffect, useRef, useState } from 'react';
import { Loader2, Sparkles, RefreshCw } from 'lucide-react';
import { createMosaic, type MosaicHandle } from '../../lib/mosaic';
import { analyzeColumns, resolveSource, MAX_CATEGORIES, MAX_CHARTS, type ColumnInfo, type DataSource } from '../../lib/mosaic/analyze';
import { useWorkspace } from '../../store/workspace';
import { Empty, cn } from '../../components/ui';

/** What to explore: an in-database table, a data file (relative or absolute path) or an ad-hoc SELECT. */
export type ExploreSource = DataSource;

const CHART_HEIGHT = 170;

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/**
 * Interactive, cross-filtered profile of a dataset powered by Mosaic: one histogram per numeric or temporal
 * column, a bar chart per low-cardinality text column, and a lazily loaded table underneath. Brushing any chart
 * filters every other one — computed in the workspace engine through Mosaic's pre-aggregated views, so it stays
 * interactive on millions of rows.
 */
export function ExploreView({ workspaceId, source, className }: { workspaceId: string; source: ExploreSource | null; className?: string }) {
  const container = useRef<HTMLDivElement>(null);
  const tableHost = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [columns, setColumns] = useState<ColumnInfo[]>([]);
  const [nonce, setNonce] = useState(0);
  // A moved data epoch drops the pre-aggregates server-side; rebuilding the view starts a fresh coordinator.
  const dataVersion = useWorkspace((s) => s.workspaces.find((w) => w.id === workspaceId)?.data_version);

  useEffect(() => {
    if (!source || !container.current) {
      setState('idle');
      return;
    }
    let handle: MosaicHandle | null = null;
    let cancelled = false;
    const host = container.current;
    const tableEl = tableHost.current;
    host.replaceChildren();
    tableEl?.replaceChildren();
    setState('loading');
    setError(null);

    (async () => {
      handle = await createMosaic(workspaceId);
      if (cancelled) return;
      const { api } = handle;

      // 1. A single table name Mosaic can FROM: tables as they are, files and queries through a hidden source view.
      const ref = await resolveSource(handle, source);
      if (cancelled) return;

      // 2. Column roles: DESCRIBE plus approximate cardinality for text columns.
      const signal = { get cancelled() { return cancelled; } };
      const cols = await analyzeColumns(handle, ref, signal);
      if (cancelled) return;
      const charted = cols.filter((c) => c.role !== 'skip').slice(0, MAX_CHARTS);
      setColumns(cols);

      // 3. Linked charts. One crossfilter selection: brushing a chart filters all the others (and the table), not itself.
      const brush = api.Selection.crossfilter();
      const accent = cssVar('--color-accent-500', '#8b5cf6');
      const grid = document.createElement('div');
      grid.className = 'mosaic-grid';
      const cellWidth = Math.max(260, Math.floor((host.clientWidth - 16 * 2) / 3));
      for (const c of charted) {
        const cell = document.createElement('div');
        cell.className = 'mosaic-cell';
        const title = document.createElement('div');
        title.className = 'mosaic-cell-title';
        const nameEl = document.createElement('span');
        nameEl.textContent = c.name;
        const typeEl = document.createElement('em');
        typeEl.textContent = `${c.type}${c.distinct ? ` · ${c.distinct} values` : ''}`;
        title.append(nameEl, typeEl);
        cell.appendChild(title);
        const data = api.from(ref, { filterBy: brush });
        const common = [api.width(cellWidth), api.height(CHART_HEIGHT), api.marginLeft(44), api.marginRight(12), api.marginTop(8), api.marginBottom(28), api.style({ color: cssVar('--color-zinc-400', '#a1a1aa') })];
        let el: HTMLElement;
        if (c.role === 'category') {
          el = api.plot(api.barX(data, { x: api.count(), y: c.name, fill: accent, sort: { y: '-x', limit: MAX_CATEGORIES } }), api.toggleY({ as: brush }), api.xLabel('count'), api.yLabel(null), api.xTickFormat('s'), api.yDomain(api.Fixed), ...common, api.marginLeft(110)) as HTMLElement;
        } else {
          el = api.plot(api.rectY(data, { x: api.bin(c.name), y: api.count(), fill: accent, insetLeft: 0.5, insetRight: 0.5 }), api.intervalX({ as: brush }), api.xDomain(api.Fixed), api.xLabel(null), api.yLabel(null), api.yTickFormat('s'), ...common) as HTMLElement;
        }
        cell.appendChild(el);
        grid.appendChild(cell);
      }
      host.appendChild(grid);

      // 4. The rows themselves, filtered by the same selection and paged as you scroll.
      if (tableEl) {
        const t = api.table({ from: ref, filterBy: brush, height: 320, rowBatch: 100, width: Math.max(320, host.clientWidth - 2) }) as HTMLElement;
        tableEl.appendChild(t);
      }
      if (!cancelled) setState('ready');
    })().catch((e) => {
      if (cancelled) return;
      setError((e as Error).message);
      setState('error');
    });

    return () => {
      cancelled = true;
      handle?.dispose();
      host.replaceChildren();
      tableEl?.replaceChildren();
    };
  }, [workspaceId, source?.kind, source?.target, dataVersion, nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!source) return <Empty icon={<Sparkles className="h-8 w-8" />} title="Pick a dataset to explore" hint="Select a file or table — every column becomes a linked chart. Brush one to filter the rest." />;

  const skipped = columns.filter((c) => c.role === 'skip');
  return (
    <div className={cn('mosaic-explore flex h-full min-h-0 flex-col', className)}>
      <div className="flex shrink-0 items-center gap-2 border-b border-zinc-800 px-3 py-1.5 text-2xs text-zinc-400">
        <Sparkles className="h-3.5 w-3.5 text-accent-300" />
        <span className="truncate font-mono text-zinc-200">{source.label ?? source.target}</span>
        <span className="text-zinc-500">·</span>
        <span>brush a chart to cross-filter · click a bar to toggle · double-click to clear</span>
        {state === 'loading' && <Loader2 className="ml-1 h-3.5 w-3.5 animate-spin text-accent-300" />}
        {skipped.length > 0 && state === 'ready' && <span className="ml-auto text-zinc-500" title={skipped.map((c) => `${c.name} (${c.type})`).join(', ')}>{skipped.length} column{skipped.length === 1 ? '' : 's'} not charted</span>}
        <button onClick={() => setNonce((n) => n + 1)} className="rounded p-1 text-zinc-500 hover:text-zinc-200" title="Rebuild">
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      </div>
      {state === 'error' && <div className="m-3 rounded-md border border-red-900 bg-red-950/50 px-3 py-2 font-mono text-xs text-red-200">{error}</div>}
      <div className="min-h-0 flex-1 overflow-auto p-3">
        <div ref={container} />
        <div ref={tableHost} className="mosaic-table-host mt-3" />
      </div>
    </div>
  );
}
