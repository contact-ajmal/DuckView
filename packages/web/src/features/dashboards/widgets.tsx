import { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Bar, Line, Scatter, Doughnut } from 'react-chartjs-2';
import type { ChartOptions } from 'chart.js';
import { ArrowUpRight, ArrowDownRight, Loader2, RefreshCw, ChevronLeft, ChevronRight, ArrowUpDown } from 'lucide-react';
import '../../lib/chart';
import { SERIES, MAX_SERIES, withAlpha, GRID, compactNumber } from '../../lib/chart';
import { api, type DashboardWidget, type ColumnSchema, type WidgetChartConfig } from '../../api/client';
import { cn } from '../../components/ui';

export interface WidgetData { columns: ColumnSchema[]; rows: unknown[][]; rowCount: number; totalRows: number | null; durationMs: number }

/** Fetches widget data on mount and on the configured interval. */
export function useWidgetData(dashboardId: string, widget: DashboardWidget, tick: number) {
  const [data, setData] = useState<WidgetData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [at, setAt] = useState<number | null>(null);
  const timer = useRef<number | null>(null);
  useEffect(() => {
    if (widget.widget_type === 'MARKDOWN') return;
    let alive = true;
    const load = async () => {
      setLoading(true);
      try {
        const r = await api.post<WidgetData>(`/api/dashboards/${dashboardId}/widgets/${widget.id}/data`, {});
        if (alive) {
          setData(r);
          setError(null);
          setAt(Date.now());
        }
      } catch (e) {
        if (alive) setError((e as Error).message);
      } finally {
        if (alive) setLoading(false);
      }
    };
    void load();
    if (widget.refresh_interval_sec > 0) timer.current = window.setInterval(load, widget.refresh_interval_sec * 1000);
    return () => {
      alive = false;
      if (timer.current) window.clearInterval(timer.current);
    };
  }, [dashboardId, widget.id, widget.custom_sql, widget.saved_query_id, widget.refresh_interval_sec, widget.widget_type, tick]);
  return { data, error, loading, at };
}

const fmt = (v: unknown, format?: WidgetChartConfig['format']) => {
  const n = typeof v === 'number' ? v : Number(v);
  if (v == null || Number.isNaN(n)) return v == null ? '—' : String(v);
  switch (format) {
    case 'currency':
      return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
    case 'percent':
      return `${(n * 100).toFixed(1)}%`;
    case 'compact':
      return compactNumber(n);
    default:
      return Number.isInteger(n) ? n.toLocaleString() : n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }
};

export function KpiWidget({ data, config }: { data: WidgetData; config: WidgetChartConfig }) {
  const cols = data.columns.map((c) => c.name);
  const vi = config.value && cols.includes(config.value) ? cols.indexOf(config.value) : data.columns.findIndex((c) => c.kind === 'number');
  const ci = config.compare && cols.includes(config.compare) ? cols.indexOf(config.compare) : -1;
  const row = data.rows[0];
  const value = row?.[vi];
  const compare = ci >= 0 ? Number(row?.[ci]) : null;
  const diff = compare != null && Number.isFinite(compare) && compare !== 0 && typeof value === 'number' ? ((value - compare) / Math.abs(compare)) * 100 : null;
  return (
    <div className="flex h-full flex-col justify-center px-4">
      <div className="truncate text-3xl font-semibold tracking-tight text-zinc-50">{fmt(value, config.format)}</div>
      {diff != null && (
        <div className={cn('mt-1 flex items-center gap-1 text-xs', diff >= 0 ? 'text-emerald-300' : 'text-red-300')}>
          {diff >= 0 ? <ArrowUpRight className="h-3.5 w-3.5" /> : <ArrowDownRight className="h-3.5 w-3.5" />}
          {Math.abs(diff).toFixed(1)}% vs {fmt(compare, config.format)}
        </div>
      )}
      {diff == null && ci < 0 && data.columns.length > 1 && <div className="mt-1 font-mono text-[10px] text-zinc-500">{data.columns[vi]?.name}</div>}
    </div>
  );
}

/** Builds Chart.js series from rows honouring x / y[] / group_by / aggregate. */
function buildSeries(data: WidgetData, config: WidgetChartConfig) {
  const cols = data.columns.map((c) => c.name);
  const x = config.x && cols.includes(config.x) ? config.x : cols[0];
  const numeric = data.columns.filter((c) => c.kind === 'number' && c.name !== x).map((c) => c.name);
  const ys = (config.y ?? []).filter((y) => cols.includes(y)).slice(0, MAX_SERIES);
  const yCols = ys.length ? ys : numeric.slice(0, 1);
  const xi = cols.indexOf(x ?? '');
  const gi = config.group_by && cols.includes(config.group_by) ? cols.indexOf(config.group_by) : -1;
  const agg = config.aggregate ?? 'none';
  const labelOf = (v: unknown) => (v == null ? '∅' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  const combine = (vals: number[]) => (agg === 'sum' ? vals.reduce((a, b) => a + b, 0) : agg === 'avg' ? vals.reduce((a, b) => a + b, 0) / vals.length : agg === 'min' ? Math.min(...vals) : agg === 'max' ? Math.max(...vals) : agg === 'count' ? vals.length : vals[vals.length - 1]!);
  const labels: string[] = [];
  const seriesMap = new Map<string, Map<string, number[]>>();
  for (const r of data.rows.slice(0, 5000)) {
    const l = labelOf(r[xi]);
    if (!labels.includes(l)) labels.push(l);
    if (gi >= 0) {
      const g = labelOf(r[gi]);
      const y = yCols[0]!;
      const v = Number(r[cols.indexOf(y)]);
      if (!seriesMap.has(g)) seriesMap.set(g, new Map());
      const m = seriesMap.get(g)!;
      m.set(l, [...(m.get(l) ?? []), Number.isFinite(v) ? v : 0]);
    } else {
      for (const y of yCols) {
        const v = Number(r[cols.indexOf(y)]);
        if (!seriesMap.has(y)) seriesMap.set(y, new Map());
        const m = seriesMap.get(y)!;
        m.set(l, [...(m.get(l) ?? []), Number.isFinite(v) ? v : 0]);
      }
    }
  }
  let names = [...seriesMap.keys()];
  let extra: Map<string, number[]> | null = null;
  if (names.length > MAX_SERIES) {
    const totals = names.map((n) => [n, [...seriesMap.get(n)!.values()].flat().reduce((a, b) => a + b, 0)] as const).sort((a, b) => b[1] - a[1]);
    const keep = totals.slice(0, MAX_SERIES - 1).map((t) => t[0]);
    extra = new Map();
    for (const n of names) {
      if (keep.includes(n)) continue;
      for (const [l, vals] of seriesMap.get(n)!) extra.set(l, [...(extra.get(l) ?? []), ...vals]);
    }
    names = keep;
  }
  const series = names.map((n) => ({ name: n, values: labels.map((l) => (seriesMap.get(n)!.has(l) ? combine(seriesMap.get(n)!.get(l)!) : 0)) }));
  if (extra) series.push({ name: 'Other', values: labels.map((l) => (extra!.has(l) ? combine(extra!.get(l)!) : 0)) });
  return { labels, series, x, yCols };
}

export function ChartWidget({ data, config }: { data: WidgetData; config: WidgetChartConfig }) {
  const { labels, series } = useMemo(() => buildSeries(data, config), [data, config]);
  const type = config.chart ?? 'bar';
  const base: ChartOptions<'bar'> = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: { legend: { display: series.length >= 2, position: 'top', align: 'end', labels: { boxWidth: 8, boxHeight: 8 } } },
    scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: 12, maxRotation: 0, autoSkip: true, font: { size: 10 } }, stacked: !!config.stacked }, y: { grid: { color: GRID }, ticks: { maxTicksLimit: 6, font: { size: 10 }, callback: (v) => compactNumber(Number(v)) }, border: { display: false }, stacked: !!config.stacked } },
  };
  const color = (i: number) => (config.colors?.[i] ?? SERIES[i % SERIES.length]) as string;
  if (!series.length) return <div className="flex h-full items-center justify-center text-xs text-zinc-500">No numeric series — pick a y column.</div>;
  switch (type) {
    case 'line':
      return <Line data={{ labels, datasets: series.map((s, i) => ({ label: s.name, data: s.values, borderColor: color(i), backgroundColor: color(i), borderWidth: 2, pointRadius: labels.length > 100 ? 0 : 2, tension: 0.25 })) }} options={base as ChartOptions<'line'>} />;
    case 'area':
      return <Line data={{ labels, datasets: series.map((s, i) => ({ label: s.name, data: s.values, borderColor: color(i), backgroundColor: withAlpha(color(i), 0.25), fill: config.stacked ? (i === 0 ? 'origin' : '-1') : 'origin', borderWidth: 2, pointRadius: 0, tension: 0.25 })) }} options={base as ChartOptions<'line'>} />;
    case 'scatter': {
      const pts = labels.map((l, i) => ({ x: Number(l), y: series[0]!.values[i]! })).filter((p) => Number.isFinite(p.x));
      return <Scatter data={{ datasets: [{ label: series[0]!.name, data: pts, backgroundColor: withAlpha(color(0), 0.7), pointRadius: 4 }] }} options={{ responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { type: 'linear', grid: { color: GRID } }, y: { grid: { color: GRID } } } }} />;
    }
    case 'pie': {
      const s = series[0]!;
      const pairs = labels.map((l, i) => ({ l, v: s.values[i]! })).sort((a, b) => b.v - a.v);
      const head = pairs.slice(0, MAX_SERIES - 1);
      const rest = pairs.slice(MAX_SERIES - 1).reduce((a, p) => a + p.v, 0);
      const slices = rest > 0 ? [...head, { l: 'Other', v: rest }] : head;
      return <Doughnut data={{ labels: slices.map((p) => p.l), datasets: [{ data: slices.map((p) => p.v), backgroundColor: slices.map((_p, i) => color(i)), borderColor: '#18181b', borderWidth: 2 }] }} options={{ responsive: true, maintainAspectRatio: false, cutout: '55%', plugins: { legend: { position: 'right', labels: { boxWidth: 8, boxHeight: 8, font: { size: 10 } } } } }} />;
    }
    default:
      return <Bar data={{ labels, datasets: series.map((s, i) => ({ label: s.name, data: s.values, backgroundColor: color(i), borderColor: '#18181b', borderWidth: 1, borderRadius: config.stacked ? 0 : 3, borderSkipped: 'bottom', maxBarThickness: 40 })) }} options={base} />;
  }
}

export function TableWidget({ data, config }: { data: WidgetData; config: WidgetChartConfig }) {
  const pageSize = config.page_size ?? 10;
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState<{ col: number; dir: 1 | -1 } | null>(null);
  const rows = useMemo(() => {
    if (!sort) return data.rows;
    const { col, dir } = sort;
    return [...data.rows].sort((a, b) => {
      const x = a[col];
      const y = b[col];
      if (x == null) return 1;
      if (y == null) return -1;
      return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))) * dir;
    });
  }, [data.rows, sort]);
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const slice = rows.slice(page * pageSize, (page + 1) * pageSize);
  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full font-mono text-[11px]">
          <thead className="sticky top-0 bg-zinc-900 text-left text-[10px] text-zinc-500">
            <tr>
              {data.columns.map((c, i) => (
                <th key={c.name} className="cursor-pointer select-none whitespace-nowrap px-2 py-1 font-normal hover:text-zinc-200" onClick={() => setSort(sort?.col === i ? (sort.dir === 1 ? { col: i, dir: -1 } : null) : { col: i, dir: 1 })}>
                  {c.name} {sort?.col === i ? (sort.dir === 1 ? '↑' : '↓') : <ArrowUpDown className="inline h-2.5 w-2.5 opacity-40" />}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {slice.map((r, i) => (
              <tr key={i} className="border-t border-zinc-800/60">
                {r.map((v, j) => (
                  <td key={j} className={cn('max-w-[220px] truncate px-2 py-1', typeof v === 'number' ? 'text-right tabular-nums text-sky-200' : 'text-zinc-300')} title={v == null ? 'NULL' : String(v)}>
                    {v == null ? <span className="text-zinc-600">NULL</span> : typeof v === 'object' ? JSON.stringify(v) : typeof v === 'number' ? v.toLocaleString() : String(v)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pages > 1 && (
        <div className="flex items-center justify-end gap-2 border-t border-zinc-800 px-2 py-1 font-mono text-[10px] text-zinc-500">
          <button onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0} className="disabled:opacity-30"><ChevronLeft className="h-3 w-3" /></button>
          {page + 1} / {pages}
          <button onClick={() => setPage((p) => Math.min(pages - 1, p + 1))} disabled={page >= pages - 1} className="disabled:opacity-30"><ChevronRight className="h-3 w-3" /></button>
        </div>
      )}
    </div>
  );
}

export function MarkdownWidget({ config }: { config: WidgetChartConfig }) {
  return (
    <div className="h-full overflow-auto px-4 py-2 text-[13px] leading-relaxed text-zinc-300 [&_h1]:mb-1 [&_h1]:text-base [&_h1]:font-semibold [&_h1]:text-zinc-50 [&_h2]:mb-1 [&_h2]:mt-2 [&_h2]:text-sm [&_h2]:font-semibold [&_h2]:text-zinc-100 [&_li]:ml-4 [&_li]:list-disc [&_p]:my-1.5 [&_code]:rounded [&_code]:bg-zinc-800 [&_code]:px-1 [&_code]:font-mono [&_code]:text-[11px] [&_a]:text-accent-300 [&_a]:underline [&_table]:my-2 [&_td]:border [&_td]:border-zinc-800 [&_td]:px-2 [&_th]:border [&_th]:border-zinc-800 [&_th]:px-2">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{config.markdown ?? '_Empty note — edit this widget to add commentary._'}</ReactMarkdown>
    </div>
  );
}

export function WidgetBody({ dashboardId, widget, tick }: { dashboardId: string; widget: DashboardWidget; tick: number }) {
  const { data, error, loading, at } = useWidgetData(dashboardId, widget, tick);
  if (widget.widget_type === 'MARKDOWN') return <MarkdownWidget config={widget.chart_config} />;
  if (error) return <div className="m-3 rounded-md border border-red-900 bg-red-950/40 p-2 font-mono text-[11px] text-red-200">{error}</div>;
  if (!data) return <div className="flex h-full items-center justify-center text-zinc-500"><Loader2 className="h-4 w-4 animate-spin" /></div>;
  return (
    <div className="relative h-full">
      {loading && <RefreshCw className="absolute right-2 top-1 z-10 h-3 w-3 animate-spin text-zinc-600" />}
      {widget.widget_type === 'KPI' && <KpiWidget data={data} config={widget.chart_config} />}
      {widget.widget_type === 'CHART' && <div className="h-full p-2"><ChartWidget data={data} config={widget.chart_config} /></div>}
      {widget.widget_type === 'TABLE' && <TableWidget data={data} config={widget.chart_config} />}
      {at && widget.refresh_interval_sec > 0 && <div className="absolute bottom-1 right-2 font-mono text-[9px] text-zinc-600">refreshed {new Date(at).toLocaleTimeString()}</div>}
    </div>
  );
}
