import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import GridLayout, { WidthProvider, type Layout } from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import { LayoutDashboard, Plus, Pencil, Trash2, RefreshCw, GripVertical, Settings2, Check, ArrowLeft, Lock, Unlock, Sparkles, MoreHorizontal, Camera } from 'lucide-react';
import { api, timeAgo, type Dashboard, type DashboardKind, type DashboardWidget, type LayoutItem, type SavedQuery } from '../../api/client';
import { describeSpec } from '../../lib/mosaic/summary';

// The Mosaic page brings the spec parser, YAML and the editor modes with it — loaded only when such a dashboard opens.
const MosaicDashboard = lazy(() => import('./MosaicDashboard').then((m) => ({ default: m.MosaicDashboard })));
import { useWorkspace, useWorkspaceAccess } from '../../store/workspace';
import { useCopilot } from '../../store/copilot';
import { WidgetBody } from './widgets';
import { WidgetEditor, type WidgetDraft } from './WidgetEditor';
import { PageHeader } from '../../components/layout';
import { Button, Empty, IconButton, Input, Label, Menu, MenuDivider, MenuItem, Modal, cn, confirmAction, toast } from '../../components/ui';
import { CommentsControl } from '../comments/CommentsPanel';
import { HistoryButton } from '../history/HistoryDrawer';

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
  return id ? <DashboardRoute id={id} /> : <DashboardList />;
}

/** Grid and Mosaic dashboards share the URL space; the kind decides which page renders. */
function DashboardRoute({ id }: { id: string }) {
  const [kind, setKind] = useState<DashboardKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setKind(null);
    api.get<{ dashboard: Dashboard }>(`/api/dashboards/${id}`).then((r) => setKind(r.dashboard.kind)).catch((e) => setError((e as Error).message));
  }, [id]);
  if (error) return <div className="m-6 rounded-lg border border-red-900 bg-red-950/40 p-4 text-xs text-red-200">{error}</div>;
  if (!kind) return <div className="p-6 text-xs text-zinc-500">Loading…</div>;
  return kind === 'mosaic' ? <Suspense fallback={<div className="p-6 text-xs text-zinc-500">Loading…</div>}><MosaicDashboard id={id} /></Suspense> : <DashboardCanvas id={id} />;
}

function DashboardList() {
  const ws = useWorkspace();
  const access = useWorkspaceAccess();
  const [list, setList] = useState<Dashboard[]>([]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [kind, setKind] = useState<DashboardKind>('grid');
  const [filter, setFilter] = useState('');
  const wsId = ws.activeId;
  // #/dashboards?new=1 (Home, the command palette) opens the new-dashboard dialog.
  useEffect(() => {
    if (/[?&]new=1/.test(location.hash) && access.canEdit) {
      setCreating(true);
      history.replaceState(null, '', location.pathname + '#/dashboards');
    }
  }, [access.canEdit]);
  const load = useCallback(async () => {
    if (!wsId) return;
    setList((await api.get<{ dashboards: Dashboard[] }>(`/api/workspaces/${wsId}/dashboards`)).dashboards);
  }, [wsId]);
  useEffect(() => void load(), [load]);
  const q = filter.trim().toLowerCase();
  const shown = [...list].filter((d) => !q || `${d.name} ${d.description ?? ''}`.toLowerCase().includes(q)).sort((x, y) => y.updated_at.localeCompare(x.updated_at));
  return (
    <div className="h-full overflow-auto">
    <div className="mx-auto max-w-[1180px] space-y-4 px-6 py-5">
      <PageHeader
        title="Dashboards"
        actions={
          <>
            {list.length > 0 && <Input uiSize="sm" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter dashboards" aria-label="Filter dashboards" className="w-52" />}
            {access.canEdit && <Button variant="primary" onClick={() => setCreating(true)}><Plus className="h-3.5 w-3.5" /> New dashboard</Button>}
          </>
        }
      />
      {list.length === 0 ? (
        <div className="border-y border-zinc-800 py-14"><Empty icon={<LayoutDashboard />} title="No dashboards yet" hint="A grid dashboard holds KPIs, charts and tables from saved queries; a Mosaic dashboard is interactive and cross-filtered." action={access.canEdit ? <Button size="sm" onClick={() => setCreating(true)}><Plus className="h-3.5 w-3.5" /> New dashboard</Button> : undefined} /></div>
      ) : (
        <table className="w-full table-fixed text-body" data-testid="dashboard-list">
          <thead>
            <tr className="border-b border-zinc-800 text-left text-xs text-zinc-500">
              <th className="py-2 pr-4 font-normal">Name</th>
              <th className="w-28 py-2 pr-4 font-normal @max-2xl:hidden">Type</th>
              <th className="w-40 py-2 pr-4 font-normal @max-3xl:hidden">Contents</th>
              <th className="w-32 py-2 font-normal">Updated</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((d) => (
              <tr key={d.id} className="cursor-pointer border-b border-zinc-800/70 hover:bg-zinc-900" onClick={() => (location.hash = `#/dashboards/${d.id}`)}>
                <td className="py-2.5 pr-4">
                  <a href={`#/dashboards/${d.id}`} className="block truncate font-medium text-zinc-100" onClick={(e) => e.stopPropagation()}>{d.name}</a>
                  {d.description && <div className="truncate text-xs text-zinc-500">{d.description}</div>}
                </td>
                <td className="py-2.5 pr-4 text-xs text-zinc-400 @max-2xl:hidden"><span className="inline-flex items-center gap-1.5">{d.kind === 'mosaic' ? <Sparkles className="h-3.5 w-3.5 text-zinc-500" /> : <LayoutDashboard className="h-3.5 w-3.5 text-zinc-500" />}{d.kind === 'mosaic' ? 'Mosaic' : 'Grid'}</span></td>
                <td className="py-2.5 pr-4 text-xs text-zinc-500 @max-3xl:hidden">{d.kind === 'mosaic' ? mosaicSummary(d) : `${d.layout.length} widget${d.layout.length === 1 ? '' : 's'}`}</td>
                <td className="py-2.5 text-xs text-zinc-500" title={new Date(d.updated_at).toLocaleString()}>{timeAgo(d.updated_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Modal open={creating} onClose={() => setCreating(false)} title="New dashboard">
        <div className="space-y-3">
          <div><Label>Name</Label><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Revenue overview" /></div>
          <div><Label>Description</Label><Input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Weekly exec view" /></div>
          <div>
            <Label>Type</Label>
            <div className="grid grid-cols-2 gap-2">
              {([
                ['grid', 'Grid', 'Widgets on a drag-and-drop grid: KPIs, charts, tables, notes — from saved queries or SQL.', <LayoutDashboard key="g" className="h-4 w-4" />],
                ['mosaic', 'Mosaic', 'Interactive, cross-filtered charts from a declarative spec — brush, toggle and zoom over millions of rows.', <Sparkles key="m" className="h-4 w-4" />],
              ] as const).map(([k, label, hint, icon]) => (
                <button key={k} type="button" onClick={() => setKind(k)} className={cn('rounded-lg border p-3 text-left', kind === k ? 'border-accent-500 bg-accent-500/10' : 'border-zinc-800 hover:border-zinc-600')}>
                  <div className="flex items-center gap-1.5 text-body font-semibold text-zinc-100">{icon} {label}</div>
                  <div className="mt-1 text-2xs leading-snug text-zinc-500">{hint}</div>
                </button>
              ))}
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setCreating(false)}>Cancel</Button>
            <Button variant="primary" disabled={!name.trim()} onClick={async () => { const r = await api.post<{ dashboard: Dashboard }>(`/api/workspaces/${wsId}/dashboards`, { name, description: desc || null, kind }); setCreating(false); setName(''); setDesc(''); setKind('grid'); location.hash = `#/dashboards/${r.dashboard.id}`; }}>Create</Button>
          </div>
        </div>
      </Modal>
    </div>
    </div>
  );
}

function mosaicSummary(d: Dashboard): string {
  const s = describeSpec(d.spec);
  if (!s.plots && !s.inputs) return 'empty spec';
  return `${s.plots} plot${s.plots === 1 ? '' : 's'}${s.inputs ? ` · ${s.inputs} input${s.inputs === 1 ? '' : 's'}` : ''}`;
}

function DashboardCanvas({ id }: { id: string }) {
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
  const { canEdit: canWrite } = useWorkspaceAccess();
  // Epoch of the dashboard's workspace (may differ from the active one when opened by link): drives revalidation.
  const dataVersion = useWorkspace((s) => s.workspaces.find((w) => w.id === dash?.workspace_id)?.data_version);

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
    if (!(await confirmAction(`Remove widget "${w.title}"?`))) return;
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
    <div className="flex h-full min-h-0 flex-col overflow-auto">
      <div className="sticky top-0 z-20 flex min-h-12 flex-wrap items-center justify-between gap-3 border-b border-zinc-800 bg-zinc-950/95 px-6 py-2 backdrop-blur">
        <div className="flex min-w-0 items-center gap-2">
          <a href="#/dashboards" className="rounded p-1 text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200" title="All dashboards" aria-label="All dashboards"><ArrowLeft className="h-4 w-4" /></a>
          {renaming ? (
            <form className="flex items-center gap-2" onSubmit={async (e) => { e.preventDefault(); await api.patch(`/api/dashboards/${id}`, { name }); setRenaming(false); await load(); }}>
              <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} className="w-72 font-semibold" />
              <Button size="sm" variant="primary" type="submit"><Check className="h-3.5 w-3.5" /> Save</Button>
            </form>
          ) : (
            <div className="min-w-0">
              <h1 className="flex items-center gap-2 truncate text-title font-semibold text-zinc-50">
                {dash.name}
                {canWrite && <button onClick={() => setRenaming(true)} className="text-zinc-600 hover:text-zinc-200" title="Rename" aria-label="Rename dashboard"><Pencil className="h-3.5 w-3.5" /></button>}
              </h1>
              {dash.description && <p className="truncate text-xs text-zinc-500">{dash.description}</p>}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <Button size="sm" variant="ghost" onClick={() => setTick((t) => t + 1)} title="Refresh all widgets"><RefreshCw className="h-3.5 w-3.5" /> Refresh</Button>
          <CommentsControl workspaceId={dash.workspace_id} targetType="dashboard" targetId={dash.id} targetLabel={dash.name} />
          <HistoryButton workspaceId={dash.workspace_id} objectType="dashboard" objectId={dash.id} title={dash.name} onRestored={() => void load().then(() => setTick((t) => t + 1))} />
          <Button size="sm" variant="ghost" onClick={() => cp.toggle()} title="Ask AI about this dashboard"><Sparkles className="h-3.5 w-3.5" /> Ask AI</Button>
          {canWrite && (
            <>
              <Button size="sm" variant={edit ? 'primary' : 'secondary'} onClick={() => setEdit(!edit)} title={edit ? 'Lock layout' : 'Edit layout'}>{edit ? <Unlock className="h-3.5 w-3.5" /> : <Lock className="h-3.5 w-3.5" />} {edit ? 'Done' : 'Edit'}</Button>
              <Button size="sm" onClick={() => setEditor({ open: true, widget: null })}><Plus className="h-3.5 w-3.5" /> Add widget</Button>
              <Menu
                width="w-48"
                trigger={(open, toggle) => (
                  <IconButton label="More dashboard actions" onClick={toggle} active={open}><MoreHorizontal className="h-4 w-4" /></IconButton>
                )}
              >
                {(close) => (
                  <>
                    <MenuItem icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => { close(); setRenaming(true); }}>Rename</MenuItem>
                    <MenuItem icon={<Camera className="h-3.5 w-3.5" />} onClick={() => { close(); location.hash = '#/alerts/snapshots'; }}>Schedule a snapshot…</MenuItem>
                    <MenuDivider />
                    <MenuItem danger icon={<Trash2 className="h-3.5 w-3.5" />} onClick={async () => { close(); if ((await confirmAction(`Delete dashboard "${dash.name}"?`))) { await api.del(`/api/dashboards/${id}`); toast.success(`Deleted ${dash.name}`); location.hash = '#/dashboards'; } }}>Delete dashboard</MenuItem>
                  </>
                )}
              </Menu>
            </>
          )}
        </div>
      </div>
      <div className="px-4 py-4">

      {dash.widgets.length === 0 ? (
        <div className="py-16"><Empty icon={<LayoutDashboard />} title="This dashboard is empty" hint="Add a KPI, chart, table or note, from a saved query or SQL." action={canWrite ? <Button size="sm" onClick={() => setEditor({ open: true, widget: null })}><Plus className="h-3.5 w-3.5" /> Add widget</Button> : undefined} /></div>
      ) : (
        <Grid className={cn('layout', edit && 'editing')} layout={layout} cols={12} rowHeight={64} margin={[12, 12]} isDraggable={edit} isResizable={edit} draggableHandle=".widget-drag" onLayoutChange={onLayoutChange} compactType="vertical">
          {dash.widgets.map((w) => (
            <div key={w.id} className={cn('flex flex-col overflow-hidden rounded-lg border bg-zinc-950', edit ? 'border-accent-500/50 border-dashed' : 'border-zinc-800')}>
              <header className="flex h-8 shrink-0 items-center gap-1.5 px-3">
                {edit && <GripVertical className="widget-drag h-3.5 w-3.5 cursor-grab text-zinc-500" />}
                <span className="truncate text-xs font-semibold text-zinc-200">{w.title}</span>
                {w.refresh_interval_sec > 0 && <span className="font-mono text-2xs text-zinc-600" title="Auto-refresh">↻ {w.refresh_interval_sec}s</span>}
                {edit && (
                  <span className="ml-auto flex items-center gap-1">
                    <button onClick={() => setEditor({ open: true, widget: w })} className="rounded p-0.5 text-zinc-500 hover:text-zinc-100" title="Configure"><Settings2 className="h-3.5 w-3.5" /></button>
                    <button onClick={() => void removeWidget(w)} className="rounded p-0.5 text-zinc-500 hover:text-red-300" title="Remove"><Trash2 className="h-3.5 w-3.5" /></button>
                  </span>
                )}
              </header>
              <div className="min-h-0 flex-1"><WidgetBody dashboardId={id} widget={w} tick={tick} workspaceId={dash.workspace_id} version={dataVersion} /></div>
            </div>
          ))}
        </Grid>
      )}

      </div>
      <WidgetEditor open={editor.open} onClose={() => setEditor({ open: false, widget: null })} onSave={saveWidget} workspaceId={dash.workspace_id} initial={editor.widget} savedQueries={saved} />
    </div>
  );
}
