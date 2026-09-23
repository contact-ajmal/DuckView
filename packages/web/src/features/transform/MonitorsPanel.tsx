import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, BellRing, Play, Plus, Sparkles, Trash2, TrendingDown, TrendingUp, X } from 'lucide-react';
import { api, timeAgo, type Insight, type InsightDetail, type InsightFinding, type MetricMonitor, type MonitorGrain, type NotificationChannel, type SemanticLayer, type SyncSchedule } from '../../api/client';
import { useWorkspaceAccess } from '../../store/workspace';
import { useCopilot } from '../../store/copilot';
import { Badge, Button, Input, Label, Select, cn } from '../../components/ui';
import { CHANNEL_META } from '../alerts/ChannelsPanel';
import { metricsLink } from '../copilot/CopilotDrawer';

const GRAINS: MonitorGrain[] = ['day', 'week', 'month'];
const SCHEDULES = [
  { id: 'daily', label: 'Every morning (7:00)', schedule: (): SyncSchedule => ({ kind: 'cron', expression: '0 7 * * *', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }) },
  { id: 'hourly', label: 'Every hour', schedule: (): SyncSchedule => ({ kind: 'interval', minutes: 60 }) },
  { id: 'weekly', label: 'Mondays (7:00)', schedule: (): SyncSchedule => ({ kind: 'cron', expression: '0 7 * * 1', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }) },
  { id: 'manual', label: 'By hand', schedule: (): SyncSchedule => ({ kind: 'manual' }) },
] as const;
const every = (s: SyncSchedule) => (s.kind === 'interval' ? (s.minutes % 60 === 0 ? `every ${s.minutes / 60} h` : `every ${s.minutes} min`) : s.kind === 'cron' ? `cron ${s.expression}` : 'by hand');

const fmt = (n: number | null | undefined) => (n === null || n === undefined || !Number.isFinite(n) ? '—' : Math.abs(n) >= 1e4 ? Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n) : n.toLocaleString('en-US', { maximumFractionDigits: 2 }));

/** The metric over time, its usual range as a band, and the period it is about marked. */
export function InsightChart({ detail, className }: { detail: InsightDetail; className?: string }) {
  const pts = detail.series.filter((p) => p.value !== null) as { period: string; value: number }[];
  if (pts.length < 2) return null;
  const W = 320;
  const H = 72;
  const values = [...pts.map((p) => p.value), detail.low, detail.high];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const y = (v: number) => H - 6 - ((v - min) / (max - min || 1)) * (H - 12);
  const x = (i: number) => 4 + (i / (pts.length - 1)) * (W - 8);
  const last = pts.at(-1)!;
  const unusual = last.value < detail.low || last.value > detail.high;
  // The chart stretches to its box; the marker is drawn over it so it stays round.
  return (
    <div className={cn('relative', className)}>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-[72px] w-full" preserveAspectRatio="none" role="img" aria-label={`${pts.length} periods; usual range ${fmt(detail.low)} to ${fmt(detail.high)}; latest ${fmt(last.value)}`}>
        <rect x={0} y={y(detail.high)} width={W} height={Math.max(1, y(detail.low) - y(detail.high))} className="fill-zinc-700/25" />
        <polyline points={pts.map((p, i) => `${x(i)},${y(p.value)}`).join(' ')} fill="none" className="stroke-accent-400" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
      </svg>
      <span className={cn('pointer-events-none absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full', unusual ? 'bg-amber-400' : 'bg-accent-400')} style={{ left: `${(x(pts.length - 1) / W) * 100}%`, top: `${(y(last.value) / H) * 72}px` }} />
    </div>
  );
}

function askWhy(workspaceId: string, f: { label?: string; metric: string; summary: string; segment: string | null; grain: MonitorGrain }) {
  const c = useCopilot.getState();
  c.toggle(true);
  void c.send({ workspaceId, message: `Why did this happen? ${f.summary} Break ${f.metric} down by its dimensions for that ${f.grain}${f.segment ? ` (and within ${f.segment})` : ''} and say what changed.` });
}

/** One unusual period (or a scan's finding): what happened, the chart, what drove it, and what to do next. */
export function InsightCard({ workspaceId, item, onDismiss }: { workspaceId: string; item: (Insight | InsightFinding) & { label?: string }; onDismiss?: () => void }) {
  const d = item.detail;
  const seg = item.segment?.match(/^(.+?) = (.*)$/);
  const q = { metrics: [item.metric], group_by: [`metric_time__${item.grain}`], ...(seg ? { where: [{ dimension: seg[1], op: '=', value: seg[2] }] } : {}) };
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-950" data-testid="insight-card">
      <div className="flex items-start gap-2 px-3 pt-2.5">
        {item.direction === 'up' ? <TrendingUp className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" /> : <TrendingDown className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />}
        <p className="min-w-0 flex-1 text-[13px] leading-snug text-zinc-200" data-testid="insight-summary">{item.summary}</p>
      </div>
      {d && <div className="mt-1 px-3"><InsightChart detail={d} /></div>}
      {d && d.drivers.length > 0 && (
        <ul className="mx-3 mt-1 space-y-0.5 text-[11px] text-zinc-400" data-testid="insight-drivers">
          {d.drivers.slice(0, 4).map((x) => (
            <li key={x.segment} className="flex gap-2"><span className="min-w-0 flex-1 truncate">{x.segment}</span><span className="font-mono tabular-nums">{fmt(x.expected)} → {fmt(x.value)}</span>{x.share !== null && <span className="w-10 text-right tabular-nums text-zinc-500">{Math.round(x.share * 100)}%</span>}</li>
          ))}
        </ul>
      )}
      <div className="mt-2 flex items-center gap-1 border-t border-zinc-800/80 px-2 py-1">
        <a href={metricsLink(q)} className="rounded px-1.5 py-0.5 text-[11px] text-accent-200 hover:bg-accent-600/20">Open in Metrics</a>
        <button onClick={() => askWhy(workspaceId, item)} className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-zinc-300 hover:bg-zinc-800" data-testid="insight-ask"><Sparkles className="h-3 w-3" /> Ask AI why</button>
        {onDismiss && <button onClick={onDismiss} className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300" data-testid="insight-dismiss"><X className="h-3 w-3" /> Dismiss</button>}
      </div>
    </div>
  );
}

type Draft = { name: string; metric: string; grain: MonitorGrain; segment_by: string; sensitivity: number; schedule: (typeof SCHEDULES)[number]['id']; channel_ids: string[] };

/** Transform → Metrics → Monitors: metrics watched for unusual values, what they found, and a check of every metric now. */
export function MonitorsPanel({ workspaceId, layer }: { workspaceId: string; layer: SemanticLayer }) {
  const access = useWorkspaceAccess();
  const canEdit = access.canEdit;
  const [monitors, setMonitors] = useState<MetricMonitor[]>([]);
  const [insights, setInsights] = useState<Insight[]>([]);
  const [channels, setChannels] = useState<NotificationChannel[]>([]);
  const [scan, setScan] = useState<{ findings: InsightFinding[]; errors: { metric: string; error: string }[] } | null>(null);
  const [scanGrain, setScanGrain] = useState<MonitorGrain>('day');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const timed = useMemo(() => layer.metrics.filter((m) => !m.error && m.dimensions.includes('metric_time')), [layer]);
  const timeDims = useMemo(() => new Set(layer.semantic_models.flatMap((m) => m.dimensions.filter((d) => d.type === 'time').map((d) => d.name))), [layer]);
  const segmentsFor = (metric: string) => (layer.metrics.find((m) => m.name === metric)?.dimensions ?? []).filter((d) => d !== 'metric_time' && !timeDims.has(d.split('__').at(-1)!));

  const load = useCallback(async () => {
    try {
      const [m, i] = await Promise.all([api.get<{ monitors: MetricMonitor[] }>(`/api/workspaces/${workspaceId}/monitors`), api.get<{ insights: Insight[] }>(`/api/workspaces/${workspaceId}/insights?status=new&limit=50`)]);
      setMonitors(m.monitors);
      setInsights(i.insights);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [workspaceId]);
  useEffect(() => void load(), [load]);
  useEffect(() => void api.get<{ channels: NotificationChannel[] }>(`/api/workspaces/${workspaceId}/channels`).then((r) => setChannels(r.channels)).catch(() => undefined), [workspaceId]);
  useEffect(() => {
    const id = new URLSearchParams(location.hash.split('?')[1] ?? '').get('insight');
    if (id) setTimeout(() => document.querySelector(`[data-insight="${id}"]`)?.scrollIntoView({ block: 'center' }), 300);
  }, [insights.length]);

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const runScan = () => act('scan', async () => setScan(await api.post(`/api/workspaces/${workspaceId}/insights/scan`, { grain: scanGrain })));
  const save = (d: Draft) =>
    act('save', async () => {
      const { monitor } = await api.post<{ monitor: MetricMonitor }>(`/api/workspaces/${workspaceId}/monitors`, { name: d.name.trim() || undefined, metric: d.metric, grain: d.grain, segment_by: d.segment_by || null, sensitivity: d.sensitivity, schedule: SCHEDULES.find((s) => s.id === d.schedule)!.schedule(), channel_ids: d.channel_ids });
      await api.post(`/api/monitors/${monitor.id}/run`, {});
      setDraft(null);
      await load();
    });

  if (!timed.length)
    return <p className="rounded-md border border-zinc-800 px-3 py-4 text-zinc-400">Monitors watch metrics over time, so they need a metric whose semantic model has a <span className="font-mono">default_time_dimension</span>. Add one in Definitions.</p>;

  return (
    <div className="space-y-4" data-testid="monitors">
      {error && <div className="rounded-md border border-red-900 bg-red-950/50 px-3 py-2 font-mono text-red-200">{error}</div>}

      <section className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-[13px] font-medium text-zinc-200">What changed</h3>
          <span className="text-zinc-500">Each metric's latest complete</span>
          <Select uiSize="sm" value={scanGrain} onChange={(e) => setScanGrain(e.target.value as MonitorGrain)} aria-label="Period">{GRAINS.map((g) => <option key={g} value={g}>{g}</option>)}</Select>
          <span className="text-zinc-500">against its usual range</span>
          <Button size="sm" className="ml-auto" loading={busy === 'scan'} onClick={() => void runScan()} data-testid="insights-scan"><Activity className="h-3.5 w-3.5" /> Check all metrics</Button>
        </div>
        {scan && (
          <div className="space-y-2" data-testid="scan-results">
            {scan.findings.filter((f) => f.status === 'anomaly').map((f, i) => <InsightCard key={`${f.metric}-${f.segment}-${i}`} workspaceId={workspaceId} item={f} />)}
            <ul className="divide-y divide-zinc-800/70 rounded-md border border-zinc-800">
              {scan.findings.filter((f) => f.status !== 'anomaly').map((f, i) => (
                <li key={`${f.metric}-${i}`} className="flex items-center gap-2 px-3 py-1.5 text-zinc-400"><span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', f.status === 'normal' ? 'bg-emerald-500' : 'bg-zinc-600')} /><span className="min-w-0 flex-1">{f.summary}</span></li>
              ))}
              {scan.errors.map((e) => <li key={e.metric} className="px-3 py-1.5 text-red-300">{e.metric}: {e.error}</li>)}
              {!scan.findings.length && !scan.errors.length && <li className="px-3 py-1.5 text-zinc-500">No metric could be checked.</li>}
            </ul>
          </div>
        )}
      </section>

      <section className="space-y-2">
        <div className="flex items-center gap-2">
          <h3 className="text-[13px] font-medium text-zinc-200">Monitors</h3>
          <span className="text-zinc-500">check on a schedule, keep what they find, and tell a channel</span>
          {canEdit && !draft && <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setDraft({ name: '', metric: timed[0]!.name, grain: 'day', segment_by: '', sensitivity: 3, schedule: 'daily', channel_ids: [] })} data-testid="monitor-new"><Plus className="h-3.5 w-3.5" /> New monitor</Button>}
        </div>
        {draft && (
          <div className="space-y-3 rounded-md border border-zinc-800 p-3" data-testid="monitor-editor">
            <div className="flex flex-wrap gap-3">
              <div><Label>Metric</Label><Select value={draft.metric} onChange={(e) => setDraft({ ...draft, metric: e.target.value, segment_by: '' })} data-testid="monitor-metric">{timed.map((m) => <option key={m.name} value={m.name}>{m.label || m.name}</option>)}</Select></div>
              <div><Label>Per</Label><Select value={draft.grain} onChange={(e) => setDraft({ ...draft, grain: e.target.value as MonitorGrain })} data-testid="monitor-grain">{GRAINS.map((g) => <option key={g} value={g}>{g}</option>)}</Select></div>
              <div><Label>Explain changes by</Label><Select value={draft.segment_by} onChange={(e) => setDraft({ ...draft, segment_by: e.target.value })} data-testid="monitor-segment"><option value="">(nothing)</option>{segmentsFor(draft.metric).map((d) => <option key={d} value={d}>{d}</option>)}</Select></div>
              <div><Label>Flag</Label><Select value={draft.sensitivity} onChange={(e) => setDraft({ ...draft, sensitivity: Number(e.target.value) })}><option value={2}>Smaller changes</option><option value={3}>Clear changes</option><option value={5}>Only big changes</option></Select></div>
              <div><Label>Check</Label><Select value={draft.schedule} onChange={(e) => setDraft({ ...draft, schedule: e.target.value as Draft['schedule'] })}>{SCHEDULES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</Select></div>
              <div className="min-w-[12rem] flex-1"><Label>Name</Label><Input value={draft.name} placeholder={`${draft.metric} by ${draft.grain}`} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></div>
            </div>
            <div>
              <Label>Tell when something is unusual</Label>
              {channels.filter((c) => c.enabled).length === 0 ? <p className="py-1.5 text-zinc-500">No channels yet — add one under Dashboards › Channels. Findings still appear here.</p> : (
                <div className="flex flex-wrap gap-1.5">
                  {channels.filter((c) => c.enabled).map((c) => (
                    <label key={c.id} className={cn('flex h-[var(--control-h)] cursor-pointer items-center gap-1.5 rounded-md border px-2', draft.channel_ids.includes(c.id) ? 'border-accent-500 text-zinc-100' : 'border-zinc-800 text-zinc-400')}>
                      <input type="checkbox" className="accent-accent-500" checked={draft.channel_ids.includes(c.id)} onChange={(e) => setDraft({ ...draft, channel_ids: e.target.checked ? [...draft.channel_ids, c.id] : draft.channel_ids.filter((x) => x !== c.id) })} />{CHANNEL_META[c.type].icon}{c.name}
                    </label>
                  ))}
                </div>
              )}
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setDraft(null)}>Cancel</Button>
              <Button variant="primary" loading={busy === 'save'} onClick={() => void save(draft)} data-testid="monitor-save">Save and check now</Button>
            </div>
          </div>
        )}
        {monitors.length === 0 && !draft ? <p className="text-zinc-500">No monitors yet.</p> : (
          <ul className="divide-y divide-zinc-800/70 rounded-md border border-zinc-800">
            {monitors.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center gap-2 px-3 py-2" data-monitor={m.name}>
                <span className={cn('h-2 w-2 shrink-0 rounded-full', m.status === 'anomaly' ? 'bg-amber-400' : m.status === 'normal' ? 'bg-emerald-500' : m.status === 'error' ? 'bg-red-500' : 'bg-zinc-600')} title={m.status} />
                <span className="font-medium text-zinc-200">{m.name}</span>
                <span className="text-zinc-500">{m.metric} per {m.grain}{m.segment_by ? ` · by ${m.segment_by}` : ''} · {every(m.schedule)}{m.channel_ids.length ? <> · <BellRing className="inline h-3 w-3" /> {m.channel_ids.length}</> : null}</span>
                {!m.enabled && <Badge>paused</Badge>}
                <span className="ml-auto flex items-center gap-1">
                  {m.last_run && <span className="text-zinc-500" title={m.last_run.summary}>{timeAgo(m.last_run.finished_at)}</span>}
                  {canEdit && <Button size="sm" variant="ghost" loading={busy === `run:${m.id}`} onClick={() => void act(`run:${m.id}`, async () => { await api.post(`/api/monitors/${m.id}/run`, {}); await load(); })} title="Check now" data-testid="monitor-run"><Play className="h-3.5 w-3.5" /></Button>}
                  {canEdit && <Button size="sm" variant="ghost" onClick={() => void act(`pause:${m.id}`, async () => { await api.patch(`/api/monitors/${m.id}`, { enabled: !m.enabled }); await load(); })}>{m.enabled ? 'Pause' : 'Resume'}</Button>}
                  {canEdit && <Button size="sm" variant="ghost" onClick={() => void act(`del:${m.id}`, async () => { await api.del(`/api/monitors/${m.id}`); await load(); })} title="Delete the monitor and what it found" data-testid="monitor-delete"><Trash2 className="h-3.5 w-3.5" /></Button>}
                </span>
                {m.last_run && <p className={cn('basis-full pl-4', m.last_run.status === 'error' ? 'text-red-300' : 'text-zinc-400')}>{m.last_run.summary}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>

      {insights.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-[13px] font-medium text-zinc-200">Found by monitors</h3>
          <div className="grid gap-2 lg:grid-cols-2" data-testid="insights-feed">
            {insights.map((i) => (
              <div key={i.id} data-insight={i.id}>
                <InsightCard workspaceId={workspaceId} item={i} onDismiss={canEdit ? () => void act(`dismiss:${i.id}`, async () => { await api.patch(`/api/insights/${i.id}`, { status: 'dismissed' }); await load(); }) : undefined} />
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
