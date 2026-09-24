import { useEffect, useState } from 'react';
import GridLayout, { WidthProvider, type Layout } from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import { api, type Dashboard, type DashboardWidget } from '../../api/client';
import { Logo } from '../../components/Logo';
import { WidgetBody } from './widgets';
import { MosaicSpecView } from './MosaicSpecView';

const Grid = WidthProvider(GridLayout);

/**
 * #/snapshot/dashboard/<id> — a dashboard with nothing around it, for scheduled snapshots (a headless browser
 * renders this page and captures it). <html data-snapshot> says where the render is: loading → loaded (widgets
 * fetching) → ready (Mosaic rendered) or error (data-snapshot-error holds why); the renderer also waits for the
 * network to go quiet.
 */
export function SnapshotView() {
  const id = /^#\/snapshot\/dashboard\/([^/?]+)/.exec(location.hash)?.[1] ?? null;
  const [dash, setDash] = useState<(Dashboard & { widgets: DashboardWidget[] }) | null>(null);
  const mark = (state: string, error?: string) => {
    document.documentElement.dataset.snapshot = state;
    if (error) document.documentElement.dataset.snapshotError = error;
  };
  useEffect(() => {
    mark('loading');
    if (!id) return mark('error', 'No dashboard in the address');
    api.get<{ dashboard: Dashboard & { widgets: DashboardWidget[] } }>(`/api/dashboards/${id}`).then((r) => {
      setDash(r.dashboard);
      document.title = r.dashboard.name;
      if (r.dashboard.kind !== 'mosaic') mark('loaded');
    }).catch((e) => mark('error', (e as Error).message));
  }, [id]);
  if (!dash) return <div className="p-6 text-xs text-zinc-500">Loading…</div>;
  const layout: Layout[] = dash.widgets.map((w) => {
    const l = dash.layout.find((x) => x.i === w.id);
    return l ? { ...l, static: true } : { i: w.id, x: 0, y: Infinity, w: w.widget_type === 'KPI' ? 3 : 6, h: w.widget_type === 'KPI' ? 2 : 4, static: true };
  });
  return (
    <div className="min-h-full bg-zinc-950 p-6">
      <header className="mb-4 flex items-end justify-between gap-4 border-b border-zinc-800 pb-3">
        <div>
          <h1 className="text-page font-semibold text-zinc-50">{dash.name}</h1>
          {dash.description && <p className="mt-0.5 text-xs text-zinc-400">{dash.description}</p>}
        </div>
        <div className="flex items-center gap-2 text-2xs text-zinc-500"><Logo className="h-5 w-5" /> DuckView · {new Date().toLocaleString()}</div>
      </header>
      {dash.kind === 'mosaic' ? (
        <MosaicSpecView workspaceId={dash.workspace_id} spec={dash.spec && Object.keys(dash.spec).length ? dash.spec : null} className="mosaic-dashboard" onStatus={(s) => { if (s.state === 'ready') mark(s.error ? 'error' : 'ready', s.error ?? undefined); else if (s.state === 'error') mark('error', s.error ?? 'The spec did not render'); }} />
      ) : (
        <Grid className="layout" layout={layout} cols={12} rowHeight={64} margin={[12, 12]} isDraggable={false} isResizable={false} compactType="vertical">
          {dash.widgets.map((w) => (
            <div key={w.id} className="flex flex-col overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/40">
              <header className="flex h-8 shrink-0 items-center border-b border-zinc-800 px-2.5"><span className="truncate text-xs font-semibold text-zinc-100">{w.title}</span></header>
              <div className="min-h-0 flex-1"><WidgetBody dashboardId={dash.id} widget={w} tick={0} workspaceId={dash.workspace_id} /></div>
            </div>
          ))}
        </Grid>
      )}
    </div>
  );
}
