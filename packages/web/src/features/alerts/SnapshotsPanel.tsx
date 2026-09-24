import { useCallback, useEffect, useMemo, useState } from 'react';
import { Camera, History, Pencil, Send, Trash2, Plus, LayoutDashboard, AppWindow, FileDown } from 'lucide-react';
import { api, authedBlobUrl, timeAgo, type DataApp, type Dashboard, type NotificationChannel, type ScheduledSnapshot, type SnapshotRun, type SnapshotTarget, type SyncSchedule } from '../../api/client';
import { useWorkspaceAccess } from '../../store/workspace';
import { Badge, Button, Empty, Input, Label, Modal, Select, cn, confirmAction } from '../../components/ui';
import { CHANNEL_META } from './ChannelsPanel';

const every = (s: SyncSchedule) => (s.kind === 'interval' ? (s.minutes % 60 === 0 ? `every ${s.minutes / 60} h` : `every ${s.minutes} min`) : s.kind === 'cron' ? `cron ${s.expression}${s.timezone ? ` (${s.timezone})` : ''}` : 'manual');
interface Draft { id: string | null; name: string; kind: 'dashboard' | 'app'; target: string; format: 'png' | 'pdf'; width: string; scheduleKind: 'cron' | 'interval' | 'manual'; cron: string; timezone: string; minutes: string; channel_ids: string[] }
const blank = (): Draft => ({ id: null, name: '', kind: 'dashboard', target: '', format: 'png', width: '1280', scheduleKind: 'cron', cron: '0 8 * * 1-5', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, minutes: '1440', channel_ids: [] });

/** Alerts → Snapshots: dashboards and apps rendered on a schedule and sent to channels. */
export function SnapshotsPanel({ workspaceId }: { workspaceId: string }) {
  const { canEdit } = useWorkspaceAccess();
  const [snaps, setSnaps] = useState<ScheduledSnapshot[]>([]);
  const [dashboards, setDashboards] = useState<Dashboard[]>([]);
  const [apps, setApps] = useState<DataApp[]>([]);
  const [channels, setChannels] = useState<NotificationChannel[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [runs, setRuns] = useState<{ snap: ScheduledSnapshot; rows: SnapshotRun[]; preview: string | null } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    const [s, d, a, c] = await Promise.all([
      api.get<{ snapshots: ScheduledSnapshot[] }>(`/api/workspaces/${workspaceId}/snapshots`),
      api.get<{ dashboards: Dashboard[] }>(`/api/workspaces/${workspaceId}/dashboards`),
      api.get<{ apps: DataApp[] }>(`/api/workspaces/${workspaceId}/apps`).catch(() => ({ apps: [] as DataApp[] })),
      api.get<{ channels: NotificationChannel[] }>(`/api/workspaces/${workspaceId}/channels`),
    ]);
    setSnaps(s.snapshots);
    setDashboards(d.dashboards);
    setApps(a.apps);
    setChannels(c.channels);
  }, [workspaceId]);
  useEffect(() => void load().catch((e) => setError((e as Error).message)), [load]);
  const names = useMemo(() => new Map<string, string>([...dashboards.map((d) => [d.id, d.name] as [string, string]), ...apps.map((a) => [a.id, a.name] as [string, string])]), [dashboards, apps]);
  const byId = useMemo(() => new Map(channels.map((c) => [c.id, c])), [channels]);
  const targetId = (t: SnapshotTarget) => (t.kind === 'dashboard' ? t.dashboard_id : t.app_id);

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const openRuns = async (s: ScheduledSnapshot) => {
    const r = await api.get<{ runs: SnapshotRun[] }>(`/api/snapshots/${s.id}/runs`);
    const first = r.runs.find((x) => x.status === 'ok');
    setRuns({ snap: s, rows: r.runs, preview: first && s.format === 'png' ? await authedBlobUrl(`/api/snapshots/${s.id}/runs/${first.id}/file`).catch(() => null) : null });
  };
  const save = () => act('save', async () => {
    if (!draft) return;
    const schedule: SyncSchedule = draft.scheduleKind === 'cron' ? { kind: 'cron', expression: draft.cron.trim(), ...(draft.timezone.trim() ? { timezone: draft.timezone.trim() } : {}) } : draft.scheduleKind === 'interval' ? { kind: 'interval', minutes: Math.max(15, Number(draft.minutes) || 1440) } : { kind: 'manual' };
    const body = { name: draft.name.trim() || undefined, target: draft.kind === 'dashboard' ? { kind: 'dashboard', dashboard_id: draft.target } : { kind: 'app', app_id: draft.target }, format: draft.format, width: Number(draft.width) || 1280, schedule, channel_ids: draft.channel_ids };
    if (draft.id) await api.patch(`/api/snapshots/${draft.id}`, body);
    else await api.post(`/api/workspaces/${workspaceId}/snapshots`, body);
    setDraft(null);
  });
  const sendNow = (s: ScheduledSnapshot) => act(`run:${s.id}`, async () => {
    const r = await api.post<{ run: SnapshotRun }>(`/api/snapshots/${s.id}/run`, {});
    if (r.run.status === 'error') throw new Error(`${s.name}: ${r.run.error}`);
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-zinc-500">A dashboard or app, rendered as it looks (PNG or PDF) on a schedule, and sent to channels — the Monday-morning numbers in #leadership without anyone opening DuckView.</p>
        <Button variant="primary" size="sm" disabled={!canEdit} onClick={() => setDraft(blank())}><Plus className="h-3.5 w-3.5" /> New snapshot</Button>
      </div>
      {error && !draft && <div className="rounded-md border border-red-900 bg-red-950/50 px-3 py-2 font-mono text-xs text-red-200">{error}</div>}
      {snaps.length === 0 ? (
        <div className="border-y border-zinc-800 py-12"><Empty icon={<Camera className="h-10 w-10" />} title="No scheduled snapshots" hint="Pick a dashboard or app, a schedule and channels. Email gets the image inline (and the PDF); Slack and Teams show it through a signed link." /></div>
      ) : (
        <div className="grid gap-2 md:grid-cols-2">
          {snaps.map((s) => (
            <div key={s.id} className={cn('rounded-lg border border-zinc-800 p-3', !s.enabled && 'opacity-60')}>
              <div className="flex items-center gap-2">
                {s.target.kind === 'dashboard' ? <LayoutDashboard className="h-4 w-4 text-accent-300" /> : <AppWindow className="h-4 w-4 text-accent-300" />}
                <span className="truncate text-body font-semibold text-zinc-100">{s.name}</span>
                <Badge>{s.format.toUpperCase()}</Badge>
                {s.last_status && <Badge tone={s.last_status === 'ok' ? 'green' : 'red'} className="ml-auto">{s.last_status === 'ok' ? 'sent' : 'failed'}</Badge>}
              </div>
              <div className="mt-1 text-2xs text-zinc-500">{s.target.kind} “{names.get(targetId(s.target)) ?? '?'}” · {every(s.schedule)} · {s.width}px</div>
              <div className="mt-1 flex flex-wrap gap-1 text-2xs">{s.channel_ids.length ? s.channel_ids.map((id) => byId.get(id)).filter(Boolean).map((c) => <span key={c!.id} className="inline-flex items-center gap-1 rounded border border-zinc-800 px-1.5 py-0.5 text-zinc-300">{CHANNEL_META[c!.type].icon}{c!.name}</span>) : <span className="text-amber-300">no channels</span>}</div>
              <div className="mt-1 text-2xs text-zinc-500">{s.last_run_at ? `last ${timeAgo(s.last_run_at)}` : 'never sent'}{s.next_run_at ? ` · next ${new Date(s.next_run_at).toLocaleString()}` : ''}{s.last_error ? <span className="text-red-300"> · {s.last_error}</span> : null}</div>
              <div className="mt-2 flex items-center gap-1">
                <Button size="sm" variant="secondary" disabled={!canEdit} loading={busy === `run:${s.id}`} onClick={() => void sendNow(s)} title="Render and send now"><Send className="h-3.5 w-3.5" /> Send now</Button>
                <Button size="sm" variant="ghost" onClick={() => void openRuns(s)} title="Recent renders" aria-label="Recent renders"><History className="h-3.5 w-3.5" /></Button>
                <Button size="sm" variant="ghost" disabled={!canEdit} onClick={() => setDraft({ ...blank(), id: s.id, name: s.name, kind: s.target.kind, target: targetId(s.target), format: s.format, width: String(s.width), scheduleKind: s.schedule.kind, ...(s.schedule.kind === 'cron' ? { cron: s.schedule.expression, timezone: s.schedule.timezone ?? '' } : s.schedule.kind === 'interval' ? { minutes: String(s.schedule.minutes) } : {}), channel_ids: s.channel_ids })} aria-label="Edit" title="Edit"><Pencil className="h-3.5 w-3.5" /></Button>
                <Button size="sm" variant="ghost" disabled={!canEdit} onClick={() => void act(`t:${s.id}`, () => api.patch(`/api/snapshots/${s.id}`, { enabled: !s.enabled }))}>{s.enabled ? 'Pause' : 'Resume'}</Button>
                <Button size="sm" variant="ghost" className="ml-auto text-red-300" disabled={!canEdit} onClick={async () => { if ((await confirmAction(`Delete the snapshot "${s.name}"?`))) void act(`d:${s.id}`, () => api.del(`/api/snapshots/${s.id}`)); }} aria-label="Remove" title="Remove"><Trash2 className="h-3.5 w-3.5" /></Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal open={!!draft} onClose={() => setDraft(null)} title={draft?.id ? 'Edit snapshot' : 'New snapshot'} width="max-w-xl">
        {draft && (
          <div className="space-y-3 text-xs">
            <div className="flex flex-wrap items-end gap-2">
              <div><Label>Of</Label><Select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as Draft['kind'], target: '' })}><option value="dashboard">a dashboard</option><option value="app">a data app</option></Select></div>
              <div className="min-w-0 flex-1"><Label>{draft.kind === 'dashboard' ? 'Dashboard' : 'App'}</Label><Select className="w-full" value={draft.target} onChange={(e) => setDraft({ ...draft, target: e.target.value })}><option value="">Pick one…</option>{(draft.kind === 'dashboard' ? dashboards : apps).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></div>
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-0 flex-1"><Label>Name <span className="normal-case text-zinc-500">(default: its name)</span></Label><Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Monday numbers" /></div>
              <div><Label>Format</Label><Select value={draft.format} onChange={(e) => setDraft({ ...draft, format: e.target.value as Draft['format'] })}><option value="png">PNG image</option><option value="pdf">PDF (and a PNG)</option></Select></div>
              <div><Label>Width</Label><Input className="w-24 font-mono" value={draft.width} onChange={(e) => setDraft({ ...draft, width: e.target.value })} /></div>
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <div><Label>Send</Label><Select value={draft.scheduleKind} onChange={(e) => setDraft({ ...draft, scheduleKind: e.target.value as Draft['scheduleKind'] })}><option value="cron">on a cron schedule</option><option value="interval">every …</option><option value="manual">only when sent by hand</option></Select></div>
              {draft.scheduleKind === 'cron' && <><div><Label>Cron</Label><Input className="w-36 font-mono" value={draft.cron} onChange={(e) => setDraft({ ...draft, cron: e.target.value })} /></div><div><Label>Timezone</Label><Input className="w-44 font-mono" value={draft.timezone} onChange={(e) => setDraft({ ...draft, timezone: e.target.value })} /></div></>}
              {draft.scheduleKind === 'interval' && <div><Label>Minutes (≥ 15)</Label><Input className="w-24 font-mono" value={draft.minutes} onChange={(e) => setDraft({ ...draft, minutes: e.target.value })} /></div>}
            </div>
            <div>
              <Label>Channels</Label>
              {channels.length === 0 ? <p className="text-zinc-500">No channels yet — add one under Alerts → Channels.</p> : (
                <div className="flex flex-wrap gap-1.5">
                  {channels.filter((c) => c.enabled).map((c) => (
                    <label key={c.id} className={cn('flex cursor-pointer items-center gap-1.5 rounded border px-2 py-1', draft.channel_ids.includes(c.id) ? 'border-accent-500 bg-accent-600/10 text-zinc-100' : 'border-zinc-800 text-zinc-400')}>
                      <input type="checkbox" className="accent-accent-500" checked={draft.channel_ids.includes(c.id)} onChange={(e) => setDraft({ ...draft, channel_ids: e.target.checked ? [...draft.channel_ids, c.id] : draft.channel_ids.filter((x) => x !== c.id) })} />{CHANNEL_META[c.type].icon}{c.name}
                    </label>
                  ))}
                </div>
              )}
            </div>
            <p className="text-2xs text-zinc-500">Rendered as you — what you can see. Slack, Teams and PagerDuty show the image through a signed link that expires, so the server's public URL must be reachable from them.</p>
            {error && <div className="rounded-md border border-red-900 bg-red-950/50 px-3 py-2 font-mono text-red-200">{error}</div>}
            <div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => setDraft(null)}>Cancel</Button><Button variant="primary" loading={busy === 'save'} disabled={!draft.target} onClick={() => void save()}>{draft.id ? 'Save' : 'Create snapshot'}</Button></div>
          </div>
        )}
      </Modal>

      <Modal open={!!runs} onClose={() => { if (runs?.preview) URL.revokeObjectURL(runs.preview); setRuns(null); }} title={`Renders · ${runs?.snap.name ?? ''}`} width="max-w-3xl">
        <div className="max-h-[70vh] space-y-2 overflow-auto text-xs">
          {runs?.preview && <img src={runs.preview} alt="Latest render" className="w-full rounded border border-zinc-800" />}
          {runs?.rows.length === 0 && <p className="text-zinc-500">Nothing rendered yet.</p>}
          {runs?.rows.map((r) => (
            <div key={r.id} className="flex items-start gap-2 border-b border-zinc-800/60 py-1.5">
              <Badge tone={r.status === 'ok' ? 'green' : 'red'}>{r.status}</Badge>
              <div className="min-w-0 flex-1"><div className="text-zinc-300">{timeAgo(r.created_at)} · {r.triggered_by}{r.bytes ? ` · ${Math.round(r.bytes / 1024)} KB` : ''}{r.duration_ms !== null ? ` · ${(r.duration_ms / 1000).toFixed(1)} s` : ''} · {r.delivered} channel{r.delivered === 1 ? '' : 's'}</div>{r.error && <div className="font-mono text-2xs text-red-300">{r.error}</div>}</div>
              {r.file && <Button size="sm" variant="ghost" onClick={() => void authedBlobUrl(`/api/snapshots/${r.snapshot_id}/runs/${r.id}/file`).then((u) => window.open(u, '_blank'))} title="Open the file" aria-label="Open the file"><FileDown className="h-3.5 w-3.5" /></Button>}
            </div>
          ))}
        </div>
      </Modal>
    </div>
  );
}
