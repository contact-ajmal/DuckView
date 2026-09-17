import { useCallback, useEffect, useRef, useState } from 'react';
import GridLayout, { WidthProvider, type Layout } from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import { LayoutDashboard, Plus, Pencil, Trash2, RefreshCw, GripVertical, Settings2, Check, ArrowLeft, Bot, Lock, Unlock } from 'lucide-react';
import { api, type Dashboard, type DashboardWidget, type LayoutItem, type SavedQuery } from '../../api/client';
import { useWorkspace } from '../../store/workspace';
import { useAuth } from '../../store/auth';
import { useCopilot } from '../../store/copilot';
import { WidgetBody } from './widgets';
import { WidgetEditor, type WidgetDraft } from './WidgetEditor';
import { Eyebrow, PageTitle, Panel } from '../../components/layout';
import { Button, Empty, Input, Label, Modal, cn } from '../../components/ui';

const Grid = WidthProvider(GridLayout);

function useHashId(): string | null {
  const parse = () => /^#\/dashboards\/([^/?]+)/.exec(location.hash)?.[1] ?? null;
  const [id, setId] = useState<string | null>(parse);
  useEffect(() => {
    const on = () => setId(parse());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return id;
}

export function DashboardsPage() {
  const id = useHashId();
  return id ? <DashboardCanvas id={id} /> : <DashboardList />;
}

function DashboardList() {
  const ws = useWorkspace();
  const auth = useAuth();
  const [list, setList] = useState<Dashboard[]>([]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const wsId = ws.activeId;
  const load = useCallback(async () => {
    if (!wsId) return;
    setList((await api.get<{ dashboards: Dashboard[] }>(`/api/workspaces/${wsId}/dashboards`)).dashboards);
  }, [wsId]);
  useEffect(() => void load(), [load]);
  return (
    <div className="mx-auto max-w-6xl space-y-5 p-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Eyebrow>Business intelligence</Eyebrow>
          <PageTitle>Dashboards</PageTitle>
          <p className="mt-1 text-xs text-zinc-500">KPI cards, charts, tables and notes on a drag-and-drop grid, bound to saved queries or SQL, with auto-refresh.</p>
        </div>
        {auth.user?.role !== 'READ_ONLY' && (
          <Button variant="primary" onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> New dashboard</Button>
        )}
      </div>
      {list.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-800 py-16"><Empty icon={<LayoutDashboard className="h-10 w-10" />} title="No dashboards yet" hint="Create one and add widgets from your saved queries — or ask an MCP agent to build one with create_dashboard_widget." /></div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {list.map((d) => (
            <a key={d.id} href={`#/dashboards/${d.id}`} className="group rounded-xl border border-zinc-800 bg-zinc-900/40 p-4 hover:border-zinc-600">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-zinc-50">{d.name}</div>
                  <div className="mt-0.5 line-clamp-2 text-xs text-zinc-500">{d.description || 'No description'}</div>
                </div>
                <LayoutDashboard className="h-4 w-4 shrink-0 text-accent-400" />
              </div>
              <div className="mt-3 font-mono text-[10px] text-zinc-500">{d.layout.length} widget{d.layout.length === 1 ? '' : 's'} · updated {new Date(d.updated_at).toLocaleString()}</div>
            </a>
          ))}
        </div>
      )}
      <Modal open={creating} onClose={() => setCreating(false)} title="New dashboard">
        <div className="space-y-3">
          <div><Label>Name</Label><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Revenue overview" /></div>
          <div><Label>Description</Label><Input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Weekly exec view" /></div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setCreating(false)}>Cancel</Button>
            <Button variant="primary" disabled={!name.trim()} onClick={async () => { const r = await api.post<{ dashboard: Dashboard }>(`/api/workspaces/${wsId}/dashboards`, { name, description: desc || null }); setCreating(false); setName(''); setDesc(''); location.hash = `#/dashboards/${r.dashboard.id}`; }}>Create</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function DashboardCanvas({ id }: { id: string }) {
  const auth = useAuth();
  const cp = useCopilot();
  const [dash, setDash] = useState<(Dashboard & { widgets: DashboardWidget[] }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [edit, setEdit] = useState(false);
  const [editor, setEditor] = useState<{ open: boolean; widget: DashboardWidget | null }>({ open: false, widget: null });
  const [saved, setSaved] = useState<SavedQuery[]>([]);
  const [tick, setTick] = useState(0);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState('');
  const layoutTimer = useRef<number | null>(null);
  const canWrite = auth.user?.role !== 'READ_ONLY';

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ dashboard: Dashboard & { widgets: DashboardWidget[] } }>(`/api/dashboards/${id}`);
      setDash(r.dashboard);
      setName(r.dashboard.name);
      setSaved((await api.get<{ queries: SavedQuery[] }>(`/api/workspaces/${r.dashboard.workspace_id}/queries`)).queries);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id]);
  useEffect(() => void load(), [load]);

  const onLayoutChange = (layout: Layout[]) => {
    if (!dash || !edit) return;
    const items: LayoutItem[] = layout.map((l) => ({ i: l.i, x: l.x, y: l.y, w: l.w, h: l.h }));
    setDash({ ...dash, layout: items });
    if (layoutTimer.current) window.clearTimeout(layoutTimer.current);
    layoutTimer.current = window.setTimeout(() => void api.patch(`/api/dashboards/${id}`, { layout: items }).catch(() => undefined), 600);
  };

  const saveWidget = async (d: WidgetDraft) => {
    const body = { title: d.title, widget_type: d.widget_type, saved_query_id: d.saved_query_id, custom_sql: d.custom_sql || null, chart_config: d.chart_config, refresh_interval_sec: d.refresh_interval_sec };
    if (editor.widget) await api.patch(`/api/dashboards/${id}/widgets/${editor.widget.id}`, body);
    else await api.post(`/api/dashboards/${id}/widgets`, body);
    await load();
  };
  const removeWidget = async (w: DashboardWidget) => {
    if (!confirm(`Remove widget "${w.title}"?`)) return;
    await api.del(`/api/dashboards/${id}/widgets/${w.id}`);
    await load();
  };

  if (error) return <div className="m-6 rounded-lg border border-red-900 bg-red-950/40 p-4 text-xs text-red-200">{error}</div>;
  if (!dash) return <div className="p-6 text-xs text-zinc-500">Loading…</div>;
  const layout: Layout[] = dash.widgets.map((w) => {
    const l = dash.layout.find((x) => x.i === w.id);
    return l ? { ...l, minW: 2, minH: 2 } : { i: w.id, x: 0, y: Infinity, w: w.widget_type === 'KPI' ? 3 : 6, h: w.widget_type === 'KPI' ? 2 : 4, minW: 2, minH: 2 };
  });

  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto p-5">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <a href="#/dashboards" className="mb-1 inline-flex items-center gap-1 text-[11px] text-zinc-500 hover:text-zinc-200"><ArrowLeft className="h-3 w-3" /> All dashboards</a>
          {renaming ? (
            <form className="flex items-center gap-2" onSubmit={async (e) => { e.preventDefault(); await api.patch(`/api/dashboards/${id}`, { name }); setRenaming(false); await load(); }}>
              <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} className="h-9 w-72 text-lg font-semibold" />
              <Button size="sm" variant="primary" type="submit"><Check className="h-3.5 w-3.5" /></Button>
            </form>
          ) : (
            <PageTitle className="flex items-center gap-2">
              {dash.name}
              {canWrite && <button onClick={() => setRenaming(true)} className="text-zinc-500 hover:text-zinc-200" title="Rename"><Pencil className="h-4 w-4" /></button>}
            </PageTitle>
          )}
          {dash.description && <p className="mt-0.5 text-xs text-zinc-500">{dash.description}</p>}
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={() => setTick((t) => t + 1)} title="Refresh all widgets"><RefreshCw className="h-3.5 w-3.5" /> Refresh</Button>
          <Button size="sm" variant="ghost" onClick={() => cp.toggle()} title="DuckCopilot"><Bot className="h-3.5 w-3.5" /></Button>
          {canWrite && (
            <>
              <Button size="sm" variant={edit ? 'primary' : 'secondary'} onClick={() => setEdit(!edit)} title={edit ? 'Lock layout' : 'Edit layout'}>{edit ? <Unlock className="h-3.5 w-3.5" /> : <Lock className="h-3.5 w-3.5" />} {edit ? 'Editing' : 'Edit'}</Button>
              <Button size="sm" variant="primary" onClick={() => setEditor({ open: true, widget: null })}><Plus className="h-3.5 w-3.5" /> Add widget</Button>
              <Button size="sm" variant="danger" onClick={async () => { if (confirm(`Delete dashboard "${dash.name}"?`)) { await api.del(`/api/dashboards/${id}`); location.hash = '#/dashboards'; } }} title="Delete dashboard"><Trash2 className="h-3.5 w-3.5" /></Button>
            </>
          )}
        </div>
      </div>

      {dash.widgets.length === 0 ? (
        <Panel><Empty icon={<LayoutDashboard className="h-10 w-10" />} title="Empty dashboard" hint="Add a KPI, chart, table or markdown widget. Bind it to a saved query or paste SQL." /></Panel>
      ) : (
        <Grid className={cn('layout', edit && 'editing')} layout={layout} cols={12} rowHeight={64} margin={[12, 12]} isDraggable={edit} isResizable={edit} draggableHandle=".widget-drag" onLayoutChange={onLayoutChange} compactType="vertical">
          {dash.widgets.map((w) => (
            <div key={w.id} className={cn('flex flex-col overflow-hidden rounded-xl border bg-zinc-900/40', edit ? 'border-accent-700/60' : 'border-zinc-800')}>
              <header className="flex h-8 shrink-0 items-center gap-1.5 border-b border-zinc-800 px-2.5">
                {edit && <GripVertical className="widget-drag h-3.5 w-3.5 cursor-grab text-zinc-500" />}
                <span className="truncate text-xs font-semibold text-zinc-100">{w.title}</span>
                <span className="rounded border border-zinc-800 px-1 font-mono text-[9px] text-zinc-500">{w.widget_type}</span>
                {w.refresh_interval_sec > 0 && <span className="font-mono text-[9px] text-zinc-600" title="Auto-refresh">↻ {w.refresh_interval_sec}s</span>}
                {edit && (
                  <span className="ml-auto flex items-center gap-1">
                    <button onClick={() => setEditor({ open: true, widget: w })} className="rounded p-0.5 text-zinc-500 hover:text-zinc-100" title="Configure"><Settings2 className="h-3.5 w-3.5" /></button>
                    <button onClick={() => void removeWidget(w)} className="rounded p-0.5 text-zinc-500 hover:text-red-300" title="Remove"><Trash2 className="h-3.5 w-3.5" /></button>
                  </span>
                )}
              </header>
              <div className="min-h-0 flex-1"><WidgetBody dashboardId={id} widget={w} tick={tick} /></div>
            </div>
          ))}
        </Grid>
      )}

      <WidgetEditor open={editor.open} onClose={() => setEditor({ open: false, widget: null })} onSave={saveWidget} workspaceId={dash.workspace_id} initial={editor.widget} savedQueries={saved} />
    </div>
  );
}
