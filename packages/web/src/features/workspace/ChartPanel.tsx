import { useMemo } from 'react';
import { Bar, Line, Scatter, Doughnut } from 'react-chartjs-2';
import type { ChartOptions } from 'chart.js';
import '../../lib/chart';
import { MAX_SERIES, withAlpha, useChartTheme } from '../../lib/chart';
import type { ChartConfig, ColumnSchema } from '../../api/client';
import { Label, Select, Empty } from '../../components/ui';
import { BarChart3 } from 'lucide-react';

const MAX_POINTS = 2000;

export function ChartPanel({ columns, rows, config, onChange }: { columns: ColumnSchema[]; rows: unknown[][]; config: ChartConfig; onChange: (c: ChartConfig) => void }) {
  const ct = useChartTheme();
  const SERIES = ct.series;
  const GRID = ct.grid;
  const numeric = columns.filter((c) => c.kind === 'number').map((c) => c.name);
  const dims = columns.map((c) => c.name);
  const x = config.x && dims.includes(config.x) ? config.x : dims[0];
  const chosen = (config.y ?? []).filter((y) => numeric.includes(y)).slice(0, MAX_SERIES);
  const ys = chosen.length ? chosen : numeric.filter((n) => n !== x).slice(0, 1);

  const { labels, series } = useMemo(() => {
    const xi = columns.findIndex((c) => c.name === x);
    const slice = rows.slice(0, MAX_POINTS);
    const labels = slice.map((r) => (r[xi] == null ? '∅' : typeof r[xi] === 'object' ? JSON.stringify(r[xi]) : String(r[xi])));
    const series = ys.map((y) => {
      const yi = columns.findIndex((c) => c.name === y);
      return { name: y, values: slice.map((r) => (typeof r[yi] === 'number' ? (r[yi] as number) : Number(r[yi]) || 0)) };
    });
    return { labels, series };
  }, [columns, rows, x, ys.join('|')]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleY = (name: string) => {
    const set = new Set(ys);
    if (set.has(name)) set.delete(name);
    else if (set.size < MAX_SERIES) set.add(name);
    onChange({ ...config, y: [...set] });
  };

  if (!columns.length) return <Empty icon={<BarChart3 className="h-8 w-8" />} title="No result to chart" hint="Run a query, then pick an X column and one or more numeric series." />;

  const base: ChartOptions<'bar'> = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: { legend: { display: series.length >= 2, position: 'top', align: 'end' } },
    scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: 16, maxRotation: 0, autoSkip: true } }, y: { grid: { color: GRID }, ticks: { maxTicksLimit: 7 }, border: { display: false }, stacked: !!config.stacked } },
  };
  (base.scales!.x as { stacked?: boolean }).stacked = !!config.stacked;

  const render = () => {
    if (!x || !ys.length) return <Empty icon={<BarChart3 className="h-8 w-8" />} title="Pick a numeric series to chart" hint="Charts need at least one numeric column. Aggregate in SQL (count, sum, avg) if your result has none." />;
    switch (config.type) {
      case 'line':
        return <Line data={{ labels, datasets: series.map((s, i) => ({ label: s.name, data: s.values, borderColor: SERIES[i], backgroundColor: SERIES[i], borderWidth: 2, pointRadius: labels.length > 200 ? 0 : 2, pointHoverRadius: 5, tension: 0.25 })) }} options={base as ChartOptions<'line'>} />;
      case 'area':
        return <Line data={{ labels, datasets: series.map((s, i) => ({ label: s.name, data: s.values, borderColor: SERIES[i], backgroundColor: withAlpha(SERIES[i]!, 0.25), fill: config.stacked ? (i === 0 ? 'origin' : '-1') : 'origin', borderWidth: 2, pointRadius: 0, pointHoverRadius: 5, tension: 0.25 })) }} options={base as ChartOptions<'line'>} />;
      case 'scatter': {
        const xi = columns.findIndex((c) => c.name === x);
        const yi = columns.findIndex((c) => c.name === ys[0]);
        const pts = rows.slice(0, MAX_POINTS).map((r) => ({ x: Number(r[xi]), y: Number(r[yi]) })).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
        return <Scatter data={{ datasets: [{ label: `${ys[0]} vs ${x}`, data: pts, backgroundColor: withAlpha(SERIES[0]!, 0.7), borderColor: ct.border, borderWidth: 1, pointRadius: 4, pointHoverRadius: 6 }] }} options={{ ...(base as ChartOptions<'scatter'>), scales: { x: { type: 'linear', grid: { color: GRID }, title: { display: true, text: x } }, y: { grid: { color: GRID }, title: { display: true, text: ys[0] } } }, plugins: { legend: { display: false } } }} />;
      }
      case 'pie': {
        const s = series[0]!;
        const pairs = labels.map((l, i) => ({ l, v: s.values[i] ?? 0 })).sort((a, b) => b.v - a.v);
        const head = pairs.slice(0, MAX_SERIES - 1);
        const rest = pairs.slice(MAX_SERIES - 1).reduce((a, p) => a + p.v, 0);
        const slices = rest > 0 ? [...head, { l: 'Other', v: rest }] : head;
        return <Doughnut data={{ labels: slices.map((p) => p.l), datasets: [{ data: slices.map((p) => p.v), backgroundColor: slices.map((_p, i) => SERIES[i]), borderColor: ct.border, borderWidth: 2, hoverOffset: 6 }] }} options={{ responsive: true, maintainAspectRatio: false, cutout: '55%', plugins: { legend: { position: 'right' } } }} />;
      }
      default:
        return <Bar data={{ labels, datasets: series.map((s, i) => ({ label: s.name, data: s.values, backgroundColor: SERIES[i], borderColor: ct.border, borderWidth: 1, borderRadius: config.stacked ? 0 : 4, borderSkipped: 'bottom', maxBarThickness: 48 })) }} options={base} />;
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-end gap-3 border-b border-zinc-800 px-3 py-2">
        <div>
          <Label>Type</Label>
          <Select value={config.type} onChange={(e) => onChange({ ...config, type: e.target.value as ChartConfig['type'] })}>
            {(['none', 'bar', 'line', 'area', 'scatter', 'pie'] as const).map((t) => (
              <option key={t} value={t}>
                {t === 'none' ? 'auto (bar)' : t}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <Label>X</Label>
          <Select value={x ?? ''} onChange={(e) => onChange({ ...config, x: e.target.value })}>
            {dims.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </Select>
        </div>
        <div className="min-w-0 flex-1">
          <Label>Series (numeric, max {MAX_SERIES})</Label>
          <div className="flex flex-wrap gap-1">
            {numeric.length === 0 && <span className="text-xs text-zinc-500">No numeric columns</span>}
            {numeric.map((n) => {
              const i = ys.indexOf(n);
              return (
                <button key={n} onClick={() => toggleY(n)} className={`flex items-center gap-1.5 rounded border px-2 py-1 text-xs ${i >= 0 ? 'border-zinc-600 bg-zinc-800 text-zinc-100' : 'border-zinc-800 text-zinc-400 hover:bg-zinc-800'}`}>
                  <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: i >= 0 ? SERIES[i] : ct.tooltipBorder }} />
                  {n}
                </button>
              );
            })}
          </div>
        </div>
        {(config.type === 'bar' || config.type === 'area') && ys.length > 1 && (
          <label className="flex items-center gap-1.5 text-xs text-zinc-400">
            <input type="checkbox" checked={!!config.stacked} onChange={(e) => onChange({ ...config, stacked: e.target.checked })} className="accent-accent-500" /> stacked
          </label>
        )}
      </div>
      <div className="relative min-h-0 flex-1 p-3">{render()}</div>
      {rows.length > MAX_POINTS && <div className="border-t border-zinc-800 px-3 py-1 text-2xs text-zinc-500">Charting the first {MAX_POINTS.toLocaleString()} of {rows.length.toLocaleString()} rows — aggregate in SQL for a complete picture.</div>}
    </div>
  );
}
