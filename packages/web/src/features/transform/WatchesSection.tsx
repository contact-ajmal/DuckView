/**
 * Quality → Watches: is a dataset still shaped the way people built on it, and still fresh? Each watch reports
 * schema drift (columns added, removed or retyped since the accepted schema) and staleness (older than expected by
 * a time column, the file's modified time or the last sync), and tells its channels when that changes.
 */
import { useCallback, useEffect, useState } from 'react';
import { Binoculars, CheckCheck, Pause, Play, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { api, timeAgo } from '../../api/client';
import { DataTable } from '../../components/data';
import { Button, Checkbox, Field, IconButton, Input, Modal, Select, StatusDot, confirmAction, toast, errorText } from '../../components/ui';
import { useWorkspace } from '../../store/workspace';

interface Watch { id: string; target: string; watch_schema: boolean; max_age_hours: number | null; time_column: string | null; check_every_minutes: number; channel_ids: string[]; enabled: boolean; status: 'unknown' | 'ok' | 'drift' | 'stale' | 'error'; detail: string | null; last_seen_at: string | null; last_checked_at: string | null }
interface Channel { id: string; name: string; type: string }
const STATUS: Record<Watch['status'], [tone: 'ok' | 'warn' | 'error' | 'idle', text: string]> = { ok: ['ok', 'As expected'], drift: ['warn', 'Schema changed'], stale: ['warn', 'Stale'], error: ['error', 'Could not check'], unknown: ['idle', 'Not checked'] };
const EVERY = [[15, 'Every 15 minutes'], [60, 'Every hour'], [360, 'Every 6 hours'], [1440, 'Every day']] as const;

export function WatchesSection({ workspaceId, canEdit }: { workspaceId: string; canEdit: boolean }) {
  const ws = useWorkspace();
  const [watches, setWatches] = useState<Watch[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [draft, setDraft] = useState<{ target: string; schema: boolean; fresh: boolean; hours: string; column: string; every: number; channels: string[] } | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setWatches((await api.get<{ watches: Watch[] }>(`/api/workspaces/${workspaceId}/watches`)).watches);
    } catch (e) {
      setError(e);
    }
  }, [workspaceId]);
  useEffect(() => void load(), [load]);
  const openNew = async () => {
    setDraft({ target: '', schema: true, fresh: false, hours: '24', column: '', every: 60, channels: [] });
    setChannels((await api.get<{ channels: Channel[] }>(`/api/workspaces/${workspaceId}/channels`).catch(() => ({ channels: [] }))).channels);
  };
  const act = async (key: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(key);
    try {
      await fn();
      if (done) toast.success(done);
      await load();
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(null);
    }
  };
  const save = () => act('save', async () => {
    const d = draft!;
    const r = await api.post<{ watch: Watch }>(`/api/workspaces/${workspaceId}/watches`, { target: d.target.trim(), watch_schema: d.schema, max_age_hours: d.fresh ? Number(d.hours) : null, time_column: d.fresh && d.column.trim() ? d.column.trim() : null, check_every_minutes: d.every, channel_ids: d.channels });
    setDraft(null);
    toast.success(`Watching ${r.watch.target}: ${STATUS[r.watch.status][1].toLowerCase()}`);
  });
  const datasets = [...(ws.catalog?.objects ?? []).map((o) => (o.schema === 'main' ? o.name : `${o.schema}.${o.name}`)), ...(ws.catalog?.files ?? []).map((f) => f.path)];
  const invalid = draft && (!draft.target.trim() ? 'Choose a table or file' : !draft.schema && !draft.fresh ? 'Watch the schema, the freshness, or both' : draft.fresh && !(Number(draft.hours) >= 1) ? 'Freshness is at least 1 hour' : null);

  return (
    <section className="space-y-3 border-t border-zinc-800 pt-5" data-testid="watches">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="text-title font-semibold text-zinc-100">Watches</h2>
          <p className="text-xs text-zinc-500">Know when a table's columns change or its data stops arriving.</p>
        </div>
        {canEdit && <Button size="sm" onClick={() => void openNew()} data-testid="watch-new"><Plus className="h-3.5 w-3.5" /> Watch a dataset</Button>}
      </div>
      <DataTable
        label="Watches"
        testid="watch-list"
        rows={watches}
        error={error}
        onRetry={() => void load()}
        rowKey={(w) => w.id}
        rowProps={(w) => ({ 'data-target': w.target })}
        empty="No watches yet. Watch the tables dashboards and syncs depend on."
        columns={[
          { key: 'target', header: 'Dataset', cell: (w) => <span className="font-mono">{w.target}</span> },
          { key: 'what', header: 'Watching', cell: (w) => [w.watch_schema && 'schema', w.max_age_hours && `fresh within ${w.max_age_hours} h`].filter(Boolean).join(', ') },
          { key: 'status', header: 'State', cell: (w) => <StatusDot tone={w.enabled ? STATUS[w.status][0] : 'idle'}>{w.enabled ? STATUS[w.status][1] : 'Paused'}</StatusDot> },
          { key: 'detail', header: 'Found', truncate: true, cell: (w) => <span className="text-zinc-400" title={w.detail ?? ''}>{w.detail ?? (w.last_seen_at ? `Updated ${timeAgo(w.last_seen_at)}` : '—')}</span> },
          { key: 'checked', header: 'Checked', cell: (w) => (w.last_checked_at ? timeAgo(w.last_checked_at) : '—') },
          {
            key: 'x',
            header: '',
            align: 'right',
            cell: (w) => (
              <span className="inline-flex gap-0.5">
                {w.status === 'drift' && canEdit && <Button size="sm" variant="ghost" loading={busy === `accept:${w.id}`} onClick={() => void act(`accept:${w.id}`, () => api.post(`/api/watches/${w.id}/accept`), 'The new schema is now the expected one')} title="The change was expected: take today's columns as the schema to watch" data-testid="watch-accept"><CheckCheck className="h-3.5 w-3.5" /> Accept</Button>}
                <IconButton label={`Check ${w.target} now`} onClick={() => void act(`check:${w.id}`, () => api.post(`/api/watches/${w.id}/check`))} data-testid="watch-check"><RefreshCw className={busy === `check:${w.id}` ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} /></IconButton>
                {canEdit && <IconButton label={w.enabled ? `Pause ${w.target}` : `Resume ${w.target}`} onClick={() => void act(`toggle:${w.id}`, () => api.patch(`/api/watches/${w.id}`, { enabled: !w.enabled }))}>{w.enabled ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}</IconButton>}
                {canEdit && <IconButton label={`Stop watching ${w.target}`} onClick={() => void confirmAction(`Stop watching ${w.target}?`, { confirmLabel: 'Stop watching' }).then((ok) => { if (ok) void act(`del:${w.id}`, () => api.del(`/api/watches/${w.id}`)); })}><Trash2 className="h-3.5 w-3.5" /></IconButton>}
              </span>
            ),
          },
        ]}
      />
      <Modal open={draft !== null} onClose={() => setDraft(null)} title="Watch a dataset" width="max-w-lg">
        {draft && (
          <div className="space-y-4">
            <Field label="Table, view or file" hint="A glob such as exports/*.parquet watches a set of files." htmlFor="watch-target">
              <Input id="watch-target" list="watch-datasets" value={draft.target} onChange={(e) => setDraft({ ...draft, target: e.target.value })} className="font-mono" placeholder="orders" data-testid="watch-target" />
              <datalist id="watch-datasets">{datasets.map((d) => <option key={d} value={d} />)}</datalist>
            </Field>
            <Checkbox label="Its schema" hint="Today's columns are remembered; you hear when one is added, removed or changes type." checked={draft.schema} onChange={(e) => setDraft({ ...draft, schema: e.target.checked })} />
            <Checkbox label="Its freshness" hint="Stale when the newest data is older than this." checked={draft.fresh} onChange={(e) => setDraft({ ...draft, fresh: e.target.checked })} data-testid="watch-fresh" />
            {draft.fresh && (
              <div className="grid gap-3 pl-6 sm:grid-cols-2">
                <Field label="Expected within" hint="Hours" htmlFor="watch-hours"><Input id="watch-hours" inputMode="numeric" value={draft.hours} onChange={(e) => setDraft({ ...draft, hours: e.target.value })} data-testid="watch-hours" /></Field>
                <Field label="Time column" hint="Optional for files and synced tables" htmlFor="watch-col"><Input id="watch-col" value={draft.column} onChange={(e) => setDraft({ ...draft, column: e.target.value })} className="font-mono" placeholder="updated_at" data-testid="watch-column" /></Field>
              </div>
            )}
            <Field label="Check" htmlFor="watch-every">
              <Select id="watch-every" value={draft.every} onChange={(e) => setDraft({ ...draft, every: Number(e.target.value) })}>{EVERY.map(([m, l]) => <option key={m} value={m}>{l}</option>)}</Select>
            </Field>
            {channels.length > 0 && (
              <div>
                <div className="mb-1 text-xs font-medium text-zinc-400">Tell</div>
                <div className="flex flex-wrap gap-x-4 gap-y-1">{channels.map((c) => <Checkbox key={c.id} label={`${c.name} · ${c.type.toLowerCase()}`} checked={draft.channels.includes(c.id)} onChange={(e) => setDraft({ ...draft, channels: e.target.checked ? [...draft.channels, c.id] : draft.channels.filter((x) => x !== c.id) })} />)}</div>
              </div>
            )}
            <div className="flex items-center justify-end gap-2">
              <span className="min-w-0 flex-1 text-xs text-zinc-500">{invalid}</span>
              <Button variant="ghost" onClick={() => setDraft(null)}>Cancel</Button>
              <Button variant="primary" disabled={!!invalid} loading={busy === 'save'} onClick={() => void save()} data-testid="watch-save"><Binoculars className="h-3.5 w-3.5" /> Watch</Button>
            </div>
          </div>
        )}
      </Modal>
    </section>
  );
}
