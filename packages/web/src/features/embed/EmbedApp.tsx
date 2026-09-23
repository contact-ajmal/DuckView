import { useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import GridLayout, { WidthProvider, type Layout } from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import { Loader2 } from 'lucide-react';
import type { DashboardWidget, LayoutItem, NotebookCell, NotebookOutput } from '../../api/client';
import { applyTheme } from '../../store/theme';
import { ChartWidget, KpiWidget, MarkdownWidget, TableWidget, type WidgetData } from '../dashboards/widgets';
import { ResultsGrid } from '../workspace/ResultsGrid';
import { ChartPanel } from '../workspace/ChartPanel';

const Grid = WidthProvider(GridLayout);
type View =
  | { type: 'dashboard'; theme: 'light' | 'dark' | null; dashboard: { id: string; name: string; description: string | null; layout: LayoutItem[]; widgets: Pick<DashboardWidget, 'id' | 'title' | 'widget_type' | 'chart_config' | 'refresh_interval_sec'>[] } }
  | { type: 'notebook'; theme: 'light' | 'dark' | null; notebook: { id: string; title: string; cells: NotebookCell[] } };

const token = new URLSearchParams(location.search).get('token') ?? '';
async function call<T>(method: 'GET' | 'POST', url: string): Promise<T> {
  const res = await fetch(url, { method, headers: { authorization: `Embed ${token}`, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) }, body: method === 'POST' ? '{}' : undefined });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { message?: string }).message ?? `HTTP ${res.status}`);
  return body as T;
}

/**
 * A signed embed (/embed/view?token=…): one dashboard or notebook, read-only, no DuckView chrome or login. Every
 * request carries the token; the server decides what it may see.
 */
export function EmbedApp() {
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void call<View>('GET', '/api/embed/view').then((v) => {
      const dark = v.theme ? v.theme === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
      applyTheme({ themeId: dark ? 'midnight' : 'daylight', sans: null, mono: null, scale: 100 });
      document.title = v.type === 'dashboard' ? v.dashboard.name : v.notebook.title;
      setView(v);
    }).catch((e) => setError((e as Error).message));
  }, []);
  if (error) return <div className="flex h-screen items-center justify-center bg-zinc-950 p-6 text-center text-sm text-zinc-400" data-testid="embed-error">This view is not available: {error}</div>;
  if (!view) return <div className="flex h-screen items-center justify-center bg-zinc-950"><Loader2 className="h-5 w-5 animate-spin text-zinc-500" /></div>;
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-200" data-testid="embed">
      {view.type === 'dashboard' ? <EmbedDashboard d={view.dashboard} /> : <EmbedNotebook nb={view.notebook} />}
      <div className="px-4 pb-3 text-right text-[10px] text-zinc-600">Made with DuckView</div>
    </div>
  );
}

type EmbedWidgetDef = Extract<View, { type: 'dashboard' }>['dashboard']['widgets'][number];

function EmbedWidget({ w }: { w: EmbedWidgetDef }) {
  const [data, setData] = useState<WidgetData | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (w.widget_type === 'MARKDOWN') return;
    const load = () => void call<WidgetData>('POST', `/api/embed/widgets/${w.id}/data`).then(setData).catch((e) => setError((e as Error).message));
    load();
    if (w.refresh_interval_sec > 0) {
      const t = window.setInterval(load, Math.max(15, w.refresh_interval_sec) * 1000);
      return () => window.clearInterval(t);
    }
  }, [w.id, w.widget_type, w.refresh_interval_sec]);
  return (
    <div className="flex h-full flex-col overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900" data-widget={w.title}>
      <div className="truncate px-3 pt-2 text-xs font-medium text-zinc-400">{w.title}</div>
      <div className="min-h-0 flex-1">
        {w.widget_type === 'MARKDOWN' ? <MarkdownWidget config={w.chart_config} /> : error ? <div className="m-3 text-xs text-red-300">{error}</div> : !data ? <div className="flex h-full items-center justify-center"><Loader2 className="h-4 w-4 animate-spin text-zinc-500" /></div> : w.widget_type === 'KPI' ? <KpiWidget data={data} config={w.chart_config} /> : w.widget_type === 'CHART' ? <div className="h-full p-2"><ChartWidget data={data} config={w.chart_config} /></div> : <TableWidget data={data} config={w.chart_config} />}
      </div>
    </div>
  );
}

function EmbedDashboard({ d }: { d: Extract<View, { type: 'dashboard' }>['dashboard'] }) {
  const layout: Layout[] = useMemo(() => d.widgets.map((w) => {
    const l = d.layout.find((x) => x.i === w.id);
    return { ...(l ?? { i: w.id, x: 0, y: Infinity, w: w.widget_type === 'KPI' ? 3 : 6, h: w.widget_type === 'KPI' ? 2 : 4 }), static: true };
  }), [d]);
  return (
    <div className="p-3">
      <h1 className="px-1 pb-1 text-base font-semibold text-zinc-50">{d.name}</h1>
      {d.description && <p className="px-1 pb-2 text-xs text-zinc-500">{d.description}</p>}
      <Grid className="layout" layout={layout} cols={12} rowHeight={60} margin={[12, 12]} isDraggable={false} isResizable={false}>
        {d.widgets.map((w) => <div key={w.id}><EmbedWidget w={w} /></div>)}
      </Grid>
    </div>
  );
}

function EmbedNotebook({ nb }: { nb: Extract<View, { type: 'notebook' }>['notebook'] }) {
  const [outputs, setOutputs] = useState<Record<string, NotebookOutput | 'running'>>({});
  useEffect(() => {
    let alive = true;
    void (async () => {
      for (const c of nb.cells.filter((x) => x.type === 'sql')) {
        if (!alive) return;
        setOutputs((o) => ({ ...o, [c.id]: 'running' }));
        const r = await call<{ output: NotebookOutput }>('POST', `/api/embed/notebook/cells/${c.id}/run`).catch((e) => ({ output: { error: (e as Error).message } as NotebookOutput }));
        if (alive) setOutputs((o) => ({ ...o, [c.id]: r.output }));
      }
    })();
    return () => {
      alive = false;
    };
  }, [nb]);
  return (
    <div className="mx-auto max-w-[960px] space-y-4 px-5 py-5">
      {nb.cells.map((c) => {
        if (c.type === 'markdown') return <div key={c.id} className="text-[13.5px] leading-relaxed text-zinc-300 [&_h1]:mb-2 [&_h1]:text-xl [&_h1]:font-semibold [&_h1]:text-zinc-50 [&_h2]:text-base [&_h2]:font-semibold [&_h2]:text-zinc-100 [&_li]:ml-5 [&_p]:my-1.5 [&_ul]:list-disc"><ReactMarkdown remarkPlugins={[remarkGfm]}>{c.source}</ReactMarkdown></div>;
        if (c.type === 'input') return <div key={c.id} className="text-xs text-zinc-500">{c.input?.label || c.name}: <span className="font-medium text-zinc-200">{c.input?.value}</span></div>;
        const o = outputs[c.id];
        if (!o || o === 'running') return <div key={c.id} className="flex h-16 items-center justify-center" data-cell={c.name}><Loader2 className="h-4 w-4 animate-spin text-zinc-500" /></div>;
        if (o.error) return <div key={c.id} className="rounded-md border border-red-900/60 bg-red-950/30 px-3 py-2 text-xs text-red-200" data-cell={c.name}>{o.error.split('\n')[0]}</div>;
        if (!o.columns?.length) return null;
        return (
          <div key={c.id} data-cell={c.name} data-testid="embed-output">
            {c.view === 'chart' && c.chart ? (
              <div className="h-[320px] overflow-hidden rounded-md border border-zinc-800"><ChartPanel columns={o.columns as never} rows={o.rows} config={c.chart} onChange={() => undefined} /></div>
            ) : (
              <div className="overflow-hidden rounded-md border border-zinc-800" style={{ height: Math.min(360, 34 + o.rows.length * 28) }}><ResultsGrid columns={o.columns as never} rows={o.rows} /></div>
            )}
          </div>
        );
      })}
    </div>
  );
}
