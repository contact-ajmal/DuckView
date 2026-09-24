import { useCallback, useEffect, useMemo, useState } from 'react';
import { BellRing, Pencil, Play, Plus, Trash2, History, FlaskConical } from 'lucide-react';
import { api, timeAgo, type AlertCondition, type AlertEvaluation, type AlertEventRow, type NotificationChannel, type SqlAlert, type SyncSchedule } from '../../api/client';
import { useWorkspaceAccess } from '../../store/workspace';
import { subscribeLiveEvents } from '../../lib/liveEvents';
import { Badge, Button, Empty, Input, Label, Modal, Select, cn, confirmAction } from '../../components/ui';
import { CHANNEL_META } from './ChannelsPanel';

const STATE_TONE = { unknown: 'zinc', ok: 'green', triggered: 'red', error: 'amber' } as const;
const describe = (c: AlertCondition) => (c.kind === 'rows' ? 'returns rows' : c.kind === 'no_rows' ? 'returns no rows' : `${c.column} ${c.op} ${c.value}`);
const every = (s: SyncSchedule) => (s.kind === 'interval' ? (s.minutes % 60 === 0 ? `every ${s.minutes / 60} h` : `every ${s.minutes} min`) : s.kind === 'cron' ? `cron ${s.expression}${s.timezone ? ` (${s.timezone})` : ''}` : 'manual');

interface Draft { id: string | null; name: string; description: string; sql: string; kind: AlertCondition['kind']; column: string; op: '>' | '>=' | '<' | '<=' | '=' | '!='; value: string; scheduleKind: 'interval' | 'cron' | 'manual'; minutes: string; cron: string; timezone: string; channel_ids: string[]; severity: SqlAlert['severity']; notify: SqlAlert['notify']; notify_resolved: boolean }
const blank = (): Draft => ({ id: null, name: '', description: '', sql: 'SELECT count(*) AS n FROM my_table WHERE …', kind: 'threshold', column: 'n', op: '>', value: '0', scheduleKind: 'interval', minutes: '60', cron: '0 8 * * 1-5', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, channel_ids: [], severity: 'warning', notify: 'change', notify_resolved: true });
const fromAlert = (a: SqlAlert): Draft => ({ ...blank(), id: a.id, name: a.name, description: a.description ?? '', sql: a.sql, kind: a.condition.kind, ...(a.condition.kind === 'threshold' ? { column: a.condition.column, op: a.condition.op, value: String(a.condition.value) } : {}), scheduleKind: a.schedule.kind, ...(a.schedule.kind === 'interval' ? { minutes: String(a.schedule.minutes) } : a.schedule.kind === 'cron' ? { cron: a.schedule.expression, timezone: a.schedule.timezone ?? '' } : {}), channel_ids: a.channel_ids, severity: a.severity, notify: a.notify, notify_resolved: a.notify_resolved });
const conditionOf = (d: Draft): AlertCondition => (d.kind === 'threshold' ? { kind: 'threshold', column: d.column.trim(), op: d.op, value: Number(d.value) } : { kind: d.kind });
const scheduleOf = (d: Draft): SyncSchedule => (d.scheduleKind === 'interval' ? { kind: 'interval', minutes: Math.max(1, Number(d.minutes) || 60) } : d.scheduleKind === 'cron' ? { kind: 'cron', expression: d.cron.trim(), ...(d.timezone.trim() ? { timezone: d.timezone.trim() } : {}) } : { kind: 'manual' });

/** Alerts → Alerts: SQL checked on a schedule; state changes go to channels. */
export function AlertsPanel({ workspaceId }: { workspaceId: string }) {
  const { canEdit } = useWorkspaceAccess();
  const [alerts, setAlerts] = useState<SqlAlert[]>([]);
  const [channels, setChannels] = useState<NotificationChannel[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [preview, setPreview] = useState<AlertEvaluation | null>(null);
  const [history, setHistory] = useState<{ alert: SqlAlert; rows: AlertEventRow[] } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const focus = /[?&]alert=([0-9a-f-]{36})/.exec(location.hash)?.[1] ?? null;
  const load = useCallback(async () => {
    const [a, c] = await Promise.all([api.get<{ alerts: SqlAlert[] }>(`/api/workspaces/${workspaceId}/alerts`), api.get<{ channels: NotificationChannel[] }>(`/api/workspaces/${workspaceId}/channels`)]);
    setAlerts(a.alerts);
    setChannels(c.channels);
  }, [workspaceId]);
  useEffect(() => void load().catch((e) => setError((e as Error).message)), [load]);
  useEffect(() => subscribeLiveEvents((e) => { if (e.type === 'alert' && e.workspace_id === workspaceId) void load().catch(() => undefined); }), [workspaceId, load]);
  const byId = useMemo(() => new Map(channels.map((c) => [c.id, c])), [channels]);

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
  const save = () => act('save', async () => {
    if (!draft) return;
    const body = { name: draft.name.trim(), description: draft.description.trim() || null, sql: draft.sql, condition: conditionOf(draft), schedule: scheduleOf(draft), channel_ids: draft.channel_ids, severity: draft.severity, notify: draft.notify, notify_resolved: draft.notify_resolved };
    if (draft.id) await api.patch(`/api/alerts/${draft.id}`, body);
    else await api.post(`/api/workspaces/${workspaceId}/alerts`, body);
    setDraft(null);
  });
  const test = () => act('test', async () => {
    if (!draft) return;
    setPreview((await api.post<{ evaluation: AlertEvaluation }>(`/api/workspaces/${workspaceId}/alerts/preview`, { sql: draft.sql, condition: conditionOf(draft) })).evaluation);
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-zinc-500">A query checked on a schedule, read-only, as its author. When its state changes — triggered, resolved, failing — its channels are told.</p>
        <Button variant="primary" size="sm" disabled={!canEdit} onClick={() => { setPreview(null); setDraft(blank()); }}><Plus className="h-3.5 w-3.5" /> New alert</Button>
      </div>
      {error && !draft && <div className="rounded-md border border-red-900 bg-red-950/50 px-3 py-2 font-mono text-xs text-red-200">{error}</div>}
      {alerts.length === 0 ? (
        <div className="border-y border-zinc-800 py-12"><Empty icon={<BellRing className="h-10 w-10" />} title="No alerts yet" hint="“Tell #ops when yesterday's orders drop below 1,000”, “page on-call when the sync table is stale” — a query and a condition." /></div>
      ) : (
        <div className="space-y-2">
          {alerts.map((a) => (
            <div key={a.id} className={cn('rounded-lg border p-3', a.id === focus ? 'border-accent-500' : 'border-zinc-800', !a.enabled && 'opacity-60')}>
              <div className="flex flex-wrap items-center gap-2">
                <BellRing className={cn('h-4 w-4', a.state === 'triggered' ? 'text-red-400' : 'text-accent-300')} />
                <span className="text-body font-semibold text-zinc-100">{a.name}</span>
                <Badge tone={STATE_TONE[a.state]}>{a.state}{a.last_value !== null ? ` · ${a.last_value}` : ''}</Badge>
                <Badge>{a.severity}</Badge>
                {!a.enabled && <Badge>disabled</Badge>}
                <span className="ml-auto text-2xs text-zinc-500">{describe(a.condition)} · {every(a.schedule)}</span>
              </div>
              {a.description && <p className="mt-1 text-2xs text-zinc-400">{a.description}</p>}
              <pre className="mt-1.5 max-h-16 overflow-hidden whitespace-pre-wrap rounded bg-zinc-950 px-2 py-1 font-mono text-2xs text-zinc-400">{a.sql}</pre>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-2xs text-zinc-500">
                {a.channel_ids.length ? a.channel_ids.map((id) => byId.get(id)).filter(Boolean).map((c) => <span key={c!.id} className="inline-flex items-center gap-1 rounded border border-zinc-800 px-1.5 py-0.5 text-zinc-300">{CHANNEL_META[c!.type].icon}{c!.name}</span>) : <span className="text-amber-300">no channels — nobody is told</span>}
                <span>· {a.last_checked_at ? `checked ${timeAgo(a.last_checked_at)}` : 'never checked'}{a.next_run_at ? ` · next ${new Date(a.next_run_at).toLocaleString()}` : ''}</span>
                {a.last_error && <span className="font-mono text-red-300">· {a.last_error}</span>}
              </div>
              <div className="mt-2 flex items-center gap-1">
                <Button size="sm" variant="secondary" disabled={!canEdit} loading={busy === `run:${a.id}`} onClick={() => void act(`run:${a.id}`, () => api.post(`/api/alerts/${a.id}/run`, {}))} title="Check now (notifies if the state changes)"><Play className="h-3.5 w-3.5" /> Check now</Button>
                <Button size="sm" variant="ghost" onClick={() => void api.get<{ events: AlertEventRow[] }>(`/api/alerts/${a.id}/events`).then((r) => setHistory({ alert: a, rows: r.events }))} title="History" aria-label="History"><History className="h-3.5 w-3.5" /></Button>
                <Button size="sm" variant="ghost" disabled={!canEdit} onClick={() => { setPreview(null); setDraft(fromAlert(a)); }} title="Edit" aria-label="Edit"><Pencil className="h-3.5 w-3.5" /></Button>
                <Button size="sm" variant="ghost" disabled={!canEdit} onClick={() => void act(`toggle:${a.id}`, () => api.patch(`/api/alerts/${a.id}`, { enabled: !a.enabled }))}>{a.enabled ? 'Pause' : 'Resume'}</Button>
                <Button size="sm" variant="ghost" className="ml-auto text-red-300" disabled={!canEdit} onClick={async () => { if ((await confirmAction(`Delete the alert "${a.name}"?`))) void act(`del:${a.id}`, () => api.del(`/api/alerts/${a.id}`)); }} aria-label="Remove" title="Remove"><Trash2 className="h-3.5 w-3.5" /></Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal open={!!draft} onClose={() => setDraft(null)} title={draft?.id ? 'Edit alert' : 'New alert'} width="max-w-2xl">
        {draft && (
          <div className="space-y-3 text-xs">
            <div className="grid gap-3 md:grid-cols-2">
              <div><Label>Name</Label><Input autoFocus value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Orders below plan" /></div>
              <div><Label>Description <span className="normal-case text-zinc-500">(in the message)</span></Label><Input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} placeholder="What to do when it fires" /></div>
            </div>
            <div><Label>Query <span className="normal-case text-zinc-500">(read-only, one statement)</span></Label><textarea value={draft.sql} onChange={(e) => setDraft({ ...draft, sql: e.target.value })} spellCheck={false} rows={5} className="w-full rounded-md border border-zinc-800 bg-zinc-950 p-2 font-mono text-xs text-zinc-200 focus:border-accent-500 focus:outline-none" /></div>
            <div className="flex flex-wrap items-end gap-2">
              <div><Label>Alert when</Label><Select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as Draft['kind'] })}><option value="threshold">a value crosses a threshold</option><option value="rows">the query returns rows</option><option value="no_rows">the query returns no rows</option></Select></div>
              {draft.kind === 'threshold' && (
                <>
                  <div><Label>Column <span className="normal-case text-zinc-500">(first row)</span></Label><Input className="w-40 font-mono" value={draft.column} onChange={(e) => setDraft({ ...draft, column: e.target.value })} /></div>
                  <div><Label>is</Label><Select value={draft.op} onChange={(e) => setDraft({ ...draft, op: e.target.value as Draft['op'] })}>{(['>', '>=', '<', '<=', '=', '!='] as const).map((o) => <option key={o} value={o}>{o}</option>)}</Select></div>
                  <div><Label>Value</Label><Input className="w-28 font-mono" value={draft.value} onChange={(e) => setDraft({ ...draft, value: e.target.value })} /></div>
                </>
              )}
              <Button size="sm" variant="secondary" loading={busy === 'test'} onClick={() => void test()} title="Run the query once as you — nothing is saved or sent"><FlaskConical className="h-3.5 w-3.5" /> Test</Button>
            </div>
            {preview && <div className={cn('rounded-md border px-3 py-2', preview.state === 'error' ? 'border-red-900 bg-red-950/40 text-red-200' : preview.state === 'triggered' ? 'border-amber-900/60 bg-amber-950/30 text-amber-200' : 'border-emerald-900/60 bg-emerald-950/30 text-emerald-200')}><b>{preview.state === 'triggered' ? 'Would fire' : preview.state === 'ok' ? 'Would stay quiet' : 'Fails'}:</b> {preview.summary} <span className="text-zinc-500">({preview.duration_ms} ms)</span></div>}
            <div className="flex flex-wrap items-end gap-2">
              <div><Label>Check</Label><Select value={draft.scheduleKind} onChange={(e) => setDraft({ ...draft, scheduleKind: e.target.value as Draft['scheduleKind'] })}><option value="interval">every …</option><option value="cron">on a cron schedule</option><option value="manual">only when run by hand</option></Select></div>
              {draft.scheduleKind === 'interval' && <div><Label>Minutes</Label><Input className="w-24 font-mono" value={draft.minutes} onChange={(e) => setDraft({ ...draft, minutes: e.target.value })} /></div>}
              {draft.scheduleKind === 'cron' && <><div><Label>Cron</Label><Input className="w-40 font-mono" value={draft.cron} onChange={(e) => setDraft({ ...draft, cron: e.target.value })} /></div><div><Label>Timezone</Label><Input className="w-44 font-mono" value={draft.timezone} onChange={(e) => setDraft({ ...draft, timezone: e.target.value })} /></div></>}
              <div><Label>Severity</Label><Select value={draft.severity} onChange={(e) => setDraft({ ...draft, severity: e.target.value as Draft['severity'] })}><option value="info">info</option><option value="warning">warning</option><option value="critical">critical</option></Select></div>
              <div><Label>Notify</Label><Select value={draft.notify} onChange={(e) => setDraft({ ...draft, notify: e.target.value as Draft['notify'] })}><option value="change">when it starts firing</option><option value="always">on every check while firing</option></Select></div>
            </div>
            <label className="flex items-center gap-2 text-zinc-400"><input type="checkbox" className="accent-accent-500" checked={draft.notify_resolved} onChange={(e) => setDraft({ ...draft, notify_resolved: e.target.checked })} /> Also tell the channels when it clears</label>
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
            {error && <div className="rounded-md border border-red-900 bg-red-950/50 px-3 py-2 font-mono text-red-200">{error}</div>}
            <div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => setDraft(null)}>Cancel</Button><Button variant="primary" loading={busy === 'save'} disabled={!draft.name.trim() || !draft.sql.trim()} onClick={() => void save()}>{draft.id ? 'Save' : 'Create alert'}</Button></div>
          </div>
        )}
      </Modal>

      <Modal open={!!history} onClose={() => setHistory(null)} title={`History · ${history?.alert.name ?? ''}`} width="max-w-xl">
        <div className="max-h-96 space-y-1 overflow-auto text-xs">
          {history?.rows.length === 0 && <p className="text-zinc-500">No state changes yet.</p>}
          {history?.rows.map((e) => (
            <div key={e.id} className="flex items-start gap-2 border-b border-zinc-800/60 py-1.5">
              <Badge tone={STATE_TONE[e.state]}>{e.state}</Badge>
              <div className="min-w-0 flex-1"><div className="text-zinc-200">{e.message}</div><div className="text-2xs text-zinc-500">{timeAgo(e.created_at)} · {e.triggered_by}{e.notified ? ` · ${e.notified} channel${e.notified === 1 ? '' : 's'} told` : ''}</div></div>
            </div>
          ))}
        </div>
      </Modal>
    </div>
  );
}
