import { useEffect, useState } from 'react';
import { Play, Loader2 } from 'lucide-react';
import { api, type DashboardWidget, type SavedQuery, type WidgetChartConfig, type ColumnSchema } from '../../api/client';
import { Button, Input, Label, Modal, Select, cn, toast } from '../../components/ui';

type WidgetType = DashboardWidget['widget_type'];
export interface WidgetDraft { title: string; widget_type: WidgetType; saved_query_id: string | null; custom_sql: string; chart_config: WidgetChartConfig; refresh_interval_sec: number }

const REFRESH = [
  [0, 'Manual'],
  [30, 'Every 30s'],
  [60, 'Every minute'],
  [300, 'Every 5 min'],
  [900, 'Every 15 min'],
  [3600, 'Hourly'],
] as const;

export function WidgetEditor({ open, onClose, onSave, workspaceId, initial, savedQueries }: { open: boolean; onClose: () => void; onSave: (d: WidgetDraft) => Promise<void>; workspaceId: string; initial?: DashboardWidget | null; savedQueries: SavedQuery[] }) {
  const [d, setD] = useState<WidgetDraft>({ title: '', widget_type: 'CHART', saved_query_id: null, custom_sql: '', chart_config: { chart: 'bar' }, refresh_interval_sec: 0 });
  const [source, setSource] = useState<'saved' | 'sql'>('sql');
  const [columns, setColumns] = useState<ColumnSchema[]>([]);
  const [preview, setPreview] = useState<{ rows: number; error?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (initial) {
      setD({ title: initial.title, widget_type: initial.widget_type, saved_query_id: initial.saved_query_id, custom_sql: initial.custom_sql ?? '', chart_config: initial.chart_config ?? {}, refresh_interval_sec: initial.refresh_interval_sec });
      setSource(initial.saved_query_id ? 'saved' : 'sql');
    } else {
      setD({ title: '', widget_type: 'CHART', saved_query_id: null, custom_sql: '', chart_config: { chart: 'bar' }, refresh_interval_sec: 0 });
      setSource(savedQueries.length ? 'saved' : 'sql');
    }
    setColumns([]);
    setPreview(null);
  }, [open, initial, savedQueries.length]);

  const sql = source === 'saved' ? (savedQueries.find((q) => q.id === d.saved_query_id)?.sql_text ?? '') : d.custom_sql;
  const cfg = d.chart_config;
  const setCfg = (patch: WidgetChartConfig) => setD({ ...d, chart_config: { ...cfg, ...patch } });

  const runPreview = async () => {
    if (!sql.trim()) return;
    setBusy(true);
    try {
      const r = await api.post<{ columns: ColumnSchema[]; rowCount: number }>(`/api/workspaces/${workspaceId}/query`, { sql, max_rows: 50 });
      setColumns(r.columns);
      setPreview({ rows: r.rowCount });
      if (!cfg.x && r.columns[0]) setCfg({ x: r.columns[0].name, y: cfg.y ?? r.columns.filter((c) => c.kind === 'number').slice(0, 1).map((c) => c.name) });
      if (d.widget_type === 'KPI' && !cfg.value) setCfg({ value: r.columns.find((c) => c.kind === 'number')?.name });
    } catch (e) {
      setPreview({ rows: 0, error: (e as Error).message });
      setColumns([]);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (open && sql.trim() && d.widget_type !== 'MARKDOWN') void runPreview();
  }, [open, d.saved_query_id, source]); // eslint-disable-line react-hooks/exhaustive-deps

  const numeric = columns.filter((c) => c.kind === 'number').map((c) => c.name);
  const names = columns.map((c) => c.name);
  const valid = d.title.trim() && (d.widget_type === 'MARKDOWN' || sql.trim());

  return (
    <Modal open={open} onClose={onClose} title={initial ? 'Edit widget' : 'Add widget'} width="max-w-3xl">
      <div className="grid gap-4 md:grid-cols-[1fr_280px]">
        <div className="space-y-3">
          <div className="grid grid-cols-[1fr_160px] gap-3">
            <div><Label>Title</Label><Input value={d.title} onChange={(e) => setD({ ...d, title: e.target.value })} autoFocus placeholder="Revenue by region" /></div>
            <div>
              <Label>Type</Label>
              <Select value={d.widget_type} onChange={(e) => setD({ ...d, widget_type: e.target.value as WidgetType })} className="w-full">
                {(['KPI', 'CHART', 'TABLE', 'MAP', 'MARKDOWN'] as WidgetType[]).map((t) => <option key={t} value={t}>{t}</option>)}
              </Select>
            </div>
          </div>
          {d.widget_type === 'MARKDOWN' ? (
            <div>
              <Label>Markdown</Label>
              <textarea value={cfg.markdown ?? ''} onChange={(e) => setCfg({ markdown: e.target.value })} rows={12} className="w-full rounded-md border border-zinc-700 bg-zinc-900 p-2 font-mono text-xs text-zinc-100 focus:border-accent-500 focus:outline-none" placeholder="## Executive summary&#10;- Revenue is up **12%** MoM…" />
            </div>
          ) : (
            <>
              <div>
                <div className="flex items-center justify-between">
                  <Label>Data source</Label>
                  <div className="flex rounded-md border border-zinc-800 p-0.5 text-2xs">
                    {(['saved', 'sql'] as const).map((s) => <button key={s} onClick={() => setSource(s)} className={cn('rounded px-2 py-0.5', source === s ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500')}>{s === 'saved' ? 'Saved query' : 'SQL'}</button>)}
                  </div>
                </div>
                {source === 'saved' ? (
                  <Select value={d.saved_query_id ?? ''} onChange={(e) => setD({ ...d, saved_query_id: e.target.value || null })} className="w-full">
                    <option value="">— choose a saved query —</option>
                    {savedQueries.map((q) => <option key={q.id} value={q.id}>{q.folder ? `${q.folder}/` : ''}{q.name}</option>)}
                  </Select>
                ) : (
                  <textarea value={d.custom_sql} onChange={(e) => setD({ ...d, custom_sql: e.target.value })} rows={7} spellCheck={false} className="w-full rounded-md border border-zinc-700 bg-zinc-950 p-2 font-mono text-xs text-zinc-100 focus:border-accent-500 focus:outline-none" placeholder="SELECT region, sum(revenue) AS revenue FROM 'sales.parquet' GROUP BY 1 ORDER BY 2 DESC" />
                )}
              </div>
              <div className="flex items-center gap-2">
                <Button size="sm" onClick={runPreview} loading={busy} disabled={!sql.trim()}><Play className="h-3.5 w-3.5" /> Preview columns</Button>
                {preview && !preview.error && <span className="font-mono text-2xs text-zinc-500">{preview.rows} rows · {columns.map((c) => c.name).join(', ')}</span>}
                {preview?.error && <span className="truncate font-mono text-2xs text-red-300" title={preview.error}>{preview.error}</span>}
              </div>
            </>
          )}
        </div>

        <div className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
          <div className="text-2xs font-semibold text-zinc-500">Configuration</div>
          {d.widget_type === 'CHART' && (
            <>
              <div><Label>Chart</Label><Select value={cfg.chart ?? 'bar'} onChange={(e) => setCfg({ chart: e.target.value as WidgetChartConfig['chart'] })} className="w-full">{['bar', 'line', 'area', 'scatter', 'pie'].map((c) => <option key={c} value={c}>{c}</option>)}</Select></div>
              <div><Label>X axis</Label><Select value={cfg.x ?? ''} onChange={(e) => setCfg({ x: e.target.value })} className="w-full"><option value="">auto (first column)</option>{names.map((n) => <option key={n} value={n}>{n}</option>)}</Select></div>
              <div>
                <Label>Y series</Label>
                <div className="flex flex-wrap gap-1">
                  {numeric.length === 0 && <span className="text-2xs text-zinc-500">preview to detect numeric columns</span>}
                  {numeric.map((n) => {
                    const on = (cfg.y ?? []).includes(n);
                    return <button key={n} onClick={() => setCfg({ y: on ? (cfg.y ?? []).filter((y) => y !== n) : [...(cfg.y ?? []), n] })} className={cn('rounded border px-2 py-0.5 text-2xs', on ? 'border-accent-500 bg-accent-600/20 text-accent-100' : 'border-zinc-700 text-zinc-400')}>{n}</button>;
                  })}
                </div>
              </div>
              <div><Label>Group by (series breakdown)</Label><Select value={cfg.group_by ?? ''} onChange={(e) => setCfg({ group_by: e.target.value || undefined })} className="w-full"><option value="">none</option>{names.map((n) => <option key={n} value={n}>{n}</option>)}</Select></div>
              <div className="grid grid-cols-2 gap-2">
                <div><Label>Aggregate</Label><Select value={cfg.aggregate ?? 'none'} onChange={(e) => setCfg({ aggregate: e.target.value as WidgetChartConfig['aggregate'] })} className="w-full">{['none', 'sum', 'avg', 'min', 'max', 'count'].map((a) => <option key={a} value={a}>{a}</option>)}</Select></div>
                <label className="flex items-end gap-1.5 pb-2 text-xs text-zinc-400"><input type="checkbox" checked={!!cfg.stacked} onChange={(e) => setCfg({ stacked: e.target.checked })} className="accent-accent-500" /> stacked</label>
              </div>
            </>
          )}
          {d.widget_type === 'KPI' && (
            <>
              <div><Label>Value column</Label><Select value={cfg.value ?? ''} onChange={(e) => setCfg({ value: e.target.value || undefined })} className="w-full"><option value="">auto (first numeric)</option>{names.map((n) => <option key={n} value={n}>{n}</option>)}</Select></div>
              <div><Label>Compare to (for % diff)</Label><Select value={cfg.compare ?? ''} onChange={(e) => setCfg({ compare: e.target.value || undefined })} className="w-full"><option value="">none</option>{names.map((n) => <option key={n} value={n}>{n}</option>)}</Select></div>
              <div><Label>Format</Label><Select value={cfg.format ?? 'number'} onChange={(e) => setCfg({ format: e.target.value as WidgetChartConfig['format'] })} className="w-full">{['number', 'compact', 'currency', 'percent'].map((f) => <option key={f} value={f}>{f}</option>)}</Select></div>
              <p className="text-2xs text-zinc-500">The query should return one row, e.g. <code className="font-mono">SELECT sum(x) AS total, lag_value AS previous …</code></p>
            </>
          )}
          {d.widget_type === 'MAP' && (
            <>
              <p className="text-2xs text-zinc-500">Points from latitude and longitude, or countries coloured by a value. Columns named lat/lon or country are found by themselves.</p>
              <div className="grid grid-cols-2 gap-2">
                <div><Label>Latitude</Label><Select value={cfg.lat ?? ''} onChange={(e) => setCfg({ lat: e.target.value || undefined })} className="w-full" aria-label="Latitude column"><option value="">auto</option>{names.map((n) => <option key={n} value={n}>{n}</option>)}</Select></div>
                <div><Label>Longitude</Label><Select value={cfg.lon ?? ''} onChange={(e) => setCfg({ lon: e.target.value || undefined })} className="w-full" aria-label="Longitude column"><option value="">auto</option>{names.map((n) => <option key={n} value={n}>{n}</option>)}</Select></div>
              </div>
              <div><Label>Or a country column</Label><Select value={cfg.region ?? ''} onChange={(e) => setCfg({ region: e.target.value || undefined })} className="w-full" aria-label="Country column"><option value="">auto</option>{names.map((n) => <option key={n} value={n}>{n}</option>)}</Select></div>
              <div><Label>Value</Label><Select value={cfg.value ?? ''} onChange={(e) => setCfg({ value: e.target.value || undefined })} className="w-full" aria-label="Value column"><option value="">auto (first number)</option>{numeric.map((n) => <option key={n} value={n}>{n}</option>)}</Select></div>
              <div><Label>Label</Label><Select value={cfg.label ?? ''} onChange={(e) => setCfg({ label: e.target.value || undefined })} className="w-full" aria-label="Label column"><option value="">auto</option>{names.map((n) => <option key={n} value={n}>{n}</option>)}</Select></div>
            </>
          )}
          {d.widget_type === 'TABLE' && <div><Label>Rows per page</Label><Input type="number" min={1} max={500} value={cfg.page_size ?? 10} onChange={(e) => setCfg({ page_size: Number(e.target.value) })} /></div>}
          {d.widget_type !== 'MARKDOWN' && (
            <div><Label>Auto-refresh</Label><Select value={d.refresh_interval_sec} onChange={(e) => setD({ ...d, refresh_interval_sec: Number(e.target.value) })} className="w-full">{REFRESH.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></div>
          )}
        </div>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" loading={saving} disabled={!valid} onClick={async () => { setSaving(true); try { await onSave({ ...d, saved_query_id: source === 'saved' ? d.saved_query_id : null, custom_sql: source === 'sql' ? d.custom_sql : '' }); onClose(); } catch (e) { toast.error(e); } finally { setSaving(false); } }}>
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null} {initial ? 'Save' : 'Add widget'}
        </Button>
      </div>
    </Modal>
  );
}
