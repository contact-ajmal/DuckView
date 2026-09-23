import { useCallback, useEffect, useState } from 'react';
import { ArrowUpRight, Eye, MoreHorizontal, Pause, Pencil, Play, Plus, Send, Trash2, X } from 'lucide-react';
import { api, timeAgo, type CloudConnection, type DatabaseConnection, type NotificationChannel, type ReverseDestination, type ReverseMode, type ReversePlan, type ReverseRun, type ReverseSync, type SyncSchedule } from '../../api/client';
import { useWorkspaceAccess } from '../../store/workspace';
import { subscribeLiveEvents } from '../../lib/liveEvents';
import { Button, Empty, IconButton, Input, Label, Menu, MenuDivider, MenuItem, Modal, Select, StatusDot, cn } from '../../components/ui';
import { CHANNEL_META } from '../alerts/ChannelsPanel';

/** Set by the SQL workbench ("Send results to…") and picked up here. */
export const REVERSE_DRAFT_KEY = 'duckview.reverse.draft';

const MODES: { id: ReverseMode; label: string; hint: string }[] = [
  { id: 'replace', label: 'Replace', hint: 'The destination holds exactly the query result' },
  { id: 'append', label: 'Append', hint: 'Every row is added on each run (a new file per run)' },
  { id: 'upsert', label: 'Upsert', hint: 'Only rows new or changed since the last run, matched on the key' },
  { id: 'mirror', label: 'Mirror', hint: 'Upsert, and rows that disappeared are deleted' },
];
const every = (s: SyncSchedule) => (s.kind === 'interval' ? (s.minutes % 60 === 0 ? `every ${s.minutes / 60} h` : `every ${s.minutes} min`) : s.kind === 'cron' ? s.expression : 'by hand');
const runTone = (s?: string) => (s === 'ok' ? 'ok' : s === 'error' ? 'error' : s === 'running' ? 'busy' : 'idle');

interface Draft {
  id: string | null;
  name: string;
  sql: string;
  kind: ReverseDestination['kind'];
  connection_id: string;
  schema: string;
  table: string;
  format: 'parquet' | 'csv' | 'json';
  path: string;
  cloud_connection_id: string;
  bucket: string;
  url: string;
  batch_size: string;
  payload: 'object' | 'array' | 'ndjson';
  headers: { name: string; value: string }[];
  /** Existing header names (values are write-only); replaced only when edited. */
  keptHeaders: string[];
  headersEdited: boolean;
  mode: ReverseMode;
  keys: string;
  scheduleKind: 'manual' | 'interval' | 'cron';
  minutes: string;
  cron: string;
  channel_ids: string[];
}
const blank = (sql = '', name = ''): Draft => ({ id: null, name, sql, kind: 'database', connection_id: '', schema: '', table: '', format: 'parquet', path: 'exports/', cloud_connection_id: '', bucket: '', url: 'https://', batch_size: '500', payload: 'object', headers: [{ name: 'Authorization', value: '' }], keptHeaders: [], headersEdited: false, mode: 'replace', keys: '', scheduleKind: 'manual', minutes: '60', cron: '0 6 * * *', channel_ids: [] });
const fromSync = (s: ReverseSync): Draft => {
  const d = s.destination;
  return {
    ...blank(s.sql, s.name), id: s.id, kind: d.kind, mode: s.mode, keys: s.key_columns.join(', '), channel_ids: s.channel_ids,
    ...(d.kind === 'database' ? { connection_id: d.connection_id, schema: d.schema ?? '', table: d.table } : {}),
    ...(d.kind === 'file' ? { format: d.format, path: d.path, cloud_connection_id: d.cloud_connection_id ?? '', bucket: d.bucket ?? '' } : {}),
    ...(d.kind === 'http' ? { url: d.url, batch_size: String(d.batch_size ?? 500), payload: d.payload ?? 'object' } : {}),
    headers: [], keptHeaders: s.header_names,
    scheduleKind: s.schedule.kind, minutes: s.schedule.kind === 'interval' ? String(s.schedule.minutes) : '60', cron: s.schedule.kind === 'cron' ? s.schedule.expression : '0 6 * * *',
  };
};
const destinationOf = (d: Draft): ReverseDestination => (d.kind === 'database' ? { kind: 'database', connection_id: d.connection_id, schema: d.schema.trim() || null, table: d.table.trim() } : d.kind === 'file' ? { kind: 'file', format: d.format, path: d.path.trim(), cloud_connection_id: d.cloud_connection_id || null, bucket: d.bucket.trim() || null } : { kind: 'http', url: d.url.trim(), batch_size: Number(d.batch_size) || 500, payload: d.payload });

/** Connections › Reverse ETL: query results sent out — to a database table, files, or an HTTP API. */
export function ReversePanel({ workspaceId, databases, clouds }: { workspaceId: string; databases: DatabaseConnection[]; clouds: CloudConnection[] }) {
  const { canEdit } = useWorkspaceAccess();
  const [syncs, setSyncs] = useState<ReverseSync[] | null>(null);
  const [channels, setChannels] = useState<NotificationChannel[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [open, setOpen] = useState<string | null>(() => /[?&]sync=([\w-]+)/.exec(location.hash)?.[1] ?? null);
  const [runs, setRuns] = useState<ReverseRun[]>([]);
  const [plan, setPlan] = useState<{ id: string; plan: ReversePlan } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => setSyncs((await api.get<{ syncs: ReverseSync[] }>(`/api/workspaces/${workspaceId}/reverse-syncs`)).syncs), [workspaceId]);
  useEffect(() => void load().catch((e) => setError((e as Error).message)), [load]);
  useEffect(() => void api.get<{ channels: NotificationChannel[] }>(`/api/workspaces/${workspaceId}/channels`).then((r) => setChannels(r.channels)).catch(() => undefined), [workspaceId]);
  useEffect(() => {
    if (!open) return setRuns([]);
    void api.get<{ runs: ReverseRun[] }>(`/api/reverse-syncs/${open}/runs?limit=20`).then((r) => setRuns(r.runs)).catch(() => undefined);
  }, [open, syncs]);
  useEffect(() => subscribeLiveEvents((e) => { if (e.type === 'reverse_sync' && e.workspace_id === workspaceId) void load().catch(() => undefined); }), [workspaceId, load]);
  // A query handed over from the workbench.
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(REVERSE_DRAFT_KEY);
      if (!raw || !canEdit) return;
      sessionStorage.removeItem(REVERSE_DRAFT_KEY);
      const { sql, name } = JSON.parse(raw) as { sql: string; name?: string };
      setDraft({ ...blank(sql, name ?? ''), connection_id: databases.find((d) => d.config.read_only === false && d.engine !== 'duckdb')?.id ?? '' });
    } catch {
      /* storage unavailable */
    }
  }, [canEdit, databases]);

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
  const dbName = (id: string) => databases.find((d) => d.id === id)?.name ?? 'database';
  const describe = (d: ReverseDestination) => (d.kind === 'database' ? `${dbName(d.connection_id)} → ${d.schema ? `${d.schema}.` : ''}${d.table}` : d.kind === 'file' ? `${d.format} · ${d.cloud_connection_id ? `${d.bucket}/` : ''}${d.path}` : d.url.replace(/^https?:\/\//, 'POST '));

  return (
    <div className="space-y-3" data-testid="reverse-panel">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-xs text-zinc-500">Query results sent out of this workspace — into a database table, as files, or to an API — by hand or on a schedule. Upsert and mirror send only what changed.</p>
        <Button className="ml-auto" size="sm" variant="primary" disabled={!canEdit} onClick={() => setDraft({ ...blank(), connection_id: databases.find((d) => d.config.read_only === false && d.engine !== 'duckdb')?.id ?? '' })} data-testid="new-reverse-sync"><Plus className="h-3.5 w-3.5" /> New reverse sync</Button>
      </div>
      {error && !draft && <div className="rounded-md border border-red-900 bg-red-950/50 px-3 py-2 font-mono text-xs text-red-200">{error}</div>}
      {syncs && syncs.length === 0 ? (
        <div className="border-y border-zinc-800 py-12"><Empty icon={<Send />} title="Nothing sent out yet" hint="Push customer scores into your CRM's database, drop a nightly Parquet file in a bucket, or post changed rows to an API. In the SQL workbench, ⋯ → Send results to… starts one from any query." /></div>
      ) : (
        <div className="@container border-y border-zinc-800">
          <div className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1.6fr)_90px_minmax(0,1.4fr)_104px] items-center gap-3 border-b border-zinc-800 px-1 py-1.5 text-xs text-zinc-500 @max-3xl:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_104px]">
            <span>Name</span><span>Destination</span><span className="@max-3xl:hidden">Mode</span><span className="@max-3xl:hidden">Last run</span><span className="sr-only">Actions</span>
          </div>
          {(syncs ?? []).map((s) => (
            <div key={s.id} className="border-b border-zinc-800/70 last:border-0" data-reverse={s.name}>
              <div className={cn('grid cursor-pointer grid-cols-[minmax(0,1.2fr)_minmax(0,1.6fr)_90px_minmax(0,1.4fr)_104px] items-center gap-3 px-1 py-2 hover:bg-zinc-900/60 @max-3xl:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_104px]', !s.enabled && 'opacity-60')} onClick={() => setOpen(open === s.id ? null : s.id)}>
                <span className="flex min-w-0 items-center gap-2"><StatusDot tone={runTone(s.last_run?.status)} /><span className="truncate text-[13px] text-zinc-100">{s.name}</span></span>
                <span className="truncate font-mono text-[11.5px] text-zinc-400" title={describe(s.destination)}>{describe(s.destination)}</span>
                <span className="text-xs text-zinc-400 @max-3xl:hidden">{s.mode}{s.key_columns.length ? <span className="text-zinc-600"> · {s.key_columns.join(', ')}</span> : null}</span>
                <span className={cn('truncate text-xs @max-3xl:hidden', s.last_run?.status === 'error' ? 'text-red-300' : 'text-zinc-500')} title={s.last_run?.error ?? s.last_run?.summary ?? ''} data-testid="reverse-last-run">{s.last_run ? `${s.last_run.status === 'error' ? s.last_run.error : s.last_run.summary ?? s.last_run.status} · ${timeAgo(s.last_run.finished_at ?? s.last_run.started_at)}` : `never run · ${every(s.schedule)}`}</span>
                <span className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                  <Button size="sm" disabled={!canEdit} loading={busy === `run:${s.id}`} onClick={() => void act(`run:${s.id}`, async () => { setOpen(s.id); await api.post(`/api/reverse-syncs/${s.id}/run`, {}); })} data-testid="run-reverse"><Play className="h-3.5 w-3.5" /> Run</Button>
                  <Menu trigger={(_, toggle) => <IconButton label="More actions" onClick={toggle}><MoreHorizontal className="h-4 w-4" /></IconButton>}>
                    {(close) => (
                      <>
                        <MenuItem icon={<Eye className="h-3.5 w-3.5" />} onClick={() => { close(); void act(`plan:${s.id}`, async () => setPlan({ id: s.id, plan: (await api.get<{ plan: ReversePlan }>(`/api/reverse-syncs/${s.id}/plan`)).plan })); }}>Preview next run</MenuItem>
                        <MenuItem icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => { close(); setDraft(fromSync(s)); }}>Edit</MenuItem>
                        <MenuItem icon={<Pause className="h-3.5 w-3.5" />} onClick={() => { close(); void act('toggle', () => api.patch(`/api/reverse-syncs/${s.id}`, { enabled: !s.enabled })); }}>{s.enabled ? 'Pause schedule' : 'Resume schedule'}</MenuItem>
                        <MenuDivider />
                        <MenuItem danger icon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => { close(); if (confirm(`Delete "${s.name}"? What was already sent stays where it is.`)) void act('del', () => api.del(`/api/reverse-syncs/${s.id}`)); }}>Delete</MenuItem>
                      </>
                    )}
                  </Menu>
                </span>
              </div>
              {open === s.id && (
                <div className="space-y-2 px-1 pb-3 pl-6 text-xs">
                  <pre className="max-h-24 overflow-auto whitespace-pre-wrap rounded-md bg-zinc-950 px-2 py-1.5 font-mono text-[11px] text-zinc-400">{s.sql}</pre>
                  <p className="text-zinc-500">{MODES.find((m) => m.id === s.mode)?.hint}{s.key_columns.length ? ` (key: ${s.key_columns.join(', ')})` : ''} · {every(s.schedule)}{s.next_run_at && s.enabled ? `, next ${new Date(s.next_run_at).toLocaleString()}` : ''}{s.header_names.length ? ` · headers ${s.header_names.join(', ')}` : ''}</p>
                  {runs.length > 0 && (
                    <div className="divide-y divide-zinc-800/70 border-y border-zinc-800/70" data-testid="reverse-runs">
                      {runs.map((r) => (
                        <div key={r.id} className="flex items-center gap-3 py-1.5">
                          <StatusDot tone={runTone(r.status)} />
                          <span className="w-36 shrink-0 text-zinc-500">{new Date(r.started_at).toLocaleString()}</span>
                          <span className={cn('min-w-0 flex-1 truncate', r.status === 'error' ? 'text-red-300' : 'text-zinc-300')}>{r.status === 'error' ? r.error : r.summary ?? r.status}</span>
                          <span className="shrink-0 text-zinc-600">{r.triggered_by}{r.duration_ms != null ? ` · ${(r.duration_ms / 1000).toFixed(1)} s` : ''}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <Modal open={!!plan} onClose={() => setPlan(null)} title="Next run" width="max-w-2xl">
        {plan && (
          <div className="space-y-3 text-xs" data-testid="reverse-plan">
            <p className="text-zinc-300">Would send <b>{plan.plan.to_send.toLocaleString()}</b> of {plan.plan.rows_read.toLocaleString()} rows{plan.plan.to_delete ? <> and <b>{plan.plan.to_delete.toLocaleString()}</b> deletions</> : null} to <span className="font-mono">{plan.plan.destination}</span>{plan.plan.incremental ? ' — the changes since the last run.' : '.'}</p>
            {plan.plan.sample.length > 0 && (
              <div className="overflow-x-auto rounded-md border border-zinc-800">
                <table className="w-full font-mono text-[11px]">
                  <thead className="bg-zinc-900/60 text-left text-zinc-500"><tr>{plan.plan.columns.map((c) => <th key={c} className="whitespace-nowrap px-2 py-1 font-normal">{c}</th>)}</tr></thead>
                  <tbody>{plan.plan.sample.map((row, i) => <tr key={i} className="border-t border-zinc-800/70">{plan.plan.columns.map((c) => <td key={c} className="max-w-[220px] truncate whitespace-nowrap px-2 py-1 text-zinc-300">{row[c] == null ? <span className="text-zinc-600">null</span> : String(row[c])}</td>)}</tr>)}</tbody>
                </table>
              </div>
            )}
            <div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => setPlan(null)}>Close</Button><Button variant="primary" disabled={!canEdit} loading={busy === `run:${plan.id}`} onClick={() => void act(`run:${plan.id}`, async () => { await api.post(`/api/reverse-syncs/${plan.id}/run`, {}); setOpen(plan.id); setPlan(null); })}><Play className="h-3.5 w-3.5" /> Run now</Button></div>
          </div>
        )}
      </Modal>

      {draft && <ReverseEditor workspaceId={workspaceId} draft={draft} setDraft={setDraft} databases={databases} clouds={clouds} channels={channels} onSaved={(id) => { setDraft(null); setOpen(id); void load(); }} />}
    </div>
  );
}

function ReverseEditor({ workspaceId, draft, setDraft, databases, clouds, channels, onSaved }: { workspaceId: string; draft: Draft; setDraft: (d: Draft | null) => void; databases: DatabaseConnection[]; clouds: CloudConnection[]; channels: NotificationChannel[]; onSaved: (id: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const writable = databases.filter((d) => d.config.read_only === false && d.engine !== 'duckdb');
  const set = (p: Partial<Draft>) => setDraft({ ...draft, ...p });
  const keyed = draft.mode === 'upsert' || draft.mode === 'mirror';
  const modes = MODES.filter((m) => draft.kind !== 'file' || m.id === 'replace' || m.id === 'append');
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const headers = draft.kind === 'http' && (draft.headersEdited || !draft.id) ? Object.fromEntries(draft.headers.filter((h) => h.name.trim() && h.value).map((h) => [h.name.trim(), h.value])) : undefined;
      const body = { name: draft.name.trim(), sql: draft.sql, destination: destinationOf(draft), mode: draft.mode, key_columns: keyed ? draft.keys.split(',').map((k) => k.trim()).filter(Boolean) : [], schedule: draft.scheduleKind === 'interval' ? { kind: 'interval', minutes: Math.max(5, Number(draft.minutes) || 60) } : draft.scheduleKind === 'cron' ? { kind: 'cron', expression: draft.cron.trim(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone } : { kind: 'manual' }, channel_ids: draft.channel_ids, ...(headers !== undefined ? { headers } : {}) };
      const r = draft.id ? await api.patch<{ sync: ReverseSync }>(`/api/reverse-syncs/${draft.id}`, body) : await api.post<{ sync: ReverseSync }>(`/api/workspaces/${workspaceId}/reverse-syncs`, body);
      onSaved(r.sync.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const ready = draft.name.trim() && draft.sql.trim() && (draft.kind === 'database' ? draft.connection_id && draft.table.trim() : draft.kind === 'file' ? draft.path.trim() : /^https?:\/\/./.test(draft.url)) && (!keyed || draft.keys.trim());

  return (
    <Modal open onClose={() => setDraft(null)} title={draft.id ? 'Edit reverse sync' : 'New reverse sync'} width="max-w-2xl">
      <div className="space-y-4 text-xs" data-testid="reverse-editor">
        <div><Label>Name</Label><Input autoFocus={!draft.name} value={draft.name} onChange={(e) => set({ name: e.target.value })} placeholder="Customer scores to CRM" data-testid="reverse-name" /></div>
        <div><Label>Rows to send <span className="text-zinc-600">(one read-only SELECT; your access policies apply)</span></Label><textarea value={draft.sql} onChange={(e) => set({ sql: e.target.value })} spellCheck={false} rows={4} data-testid="reverse-sql" className="w-full rounded-md border border-zinc-800 bg-zinc-950 p-2 font-mono text-[12px] text-zinc-200 focus:border-accent-500 focus:outline-none" /></div>

        <div>
          <Label>Send to</Label>
          <div role="radiogroup" className="mb-2 inline-flex rounded-md border border-zinc-800 p-0.5">
            {([['database', 'Database table'], ['file', 'Files'], ['http', 'HTTP API']] as const).map(([k, l]) => (
              <button key={k} role="radio" aria-checked={draft.kind === k} onClick={() => set({ kind: k, mode: k === 'file' && keyed ? 'replace' : draft.mode })} data-kind={k} className={cn('rounded px-2.5 py-1 text-xs', draft.kind === k ? 'bg-zinc-800 text-zinc-50' : 'text-zinc-400 hover:text-zinc-100')}>{l}</button>
            ))}
          </div>
          {draft.kind === 'database' && (
            writable.length === 0 ? <p className="text-zinc-500">No database connection accepts writes yet. Add a Postgres, MySQL or SQLite connection and turn off “read-only” <a className="text-accent-300 hover:underline" href="#/connections/sources">under Configured</a>.</p> : (
              <div className="flex flex-wrap gap-2">
                <Select value={draft.connection_id} onChange={(e) => set({ connection_id: e.target.value })} aria-label="Database connection" data-testid="reverse-connection"><option value="">Choose a connection…</option>{writable.map((d) => <option key={d.id} value={d.id}>{d.name} ({d.engine})</option>)}</Select>
                <Input className="w-32 font-mono" value={draft.schema} onChange={(e) => set({ schema: e.target.value })} placeholder={databases.find((d) => d.id === draft.connection_id)?.engine === 'postgres' ? 'public' : 'main'} aria-label="Schema" />
                <Input className="min-w-40 flex-1 font-mono" value={draft.table} onChange={(e) => set({ table: e.target.value })} placeholder="table (created if missing)" aria-label="Table" data-testid="reverse-table" />
              </div>
            )
          )}
          {draft.kind === 'file' && (
            <div className="flex flex-wrap gap-2">
              <Select value={draft.format} onChange={(e) => set({ format: e.target.value as Draft['format'] })} aria-label="Format"><option value="parquet">Parquet</option><option value="csv">CSV</option><option value="json">JSON</option></Select>
              <Select value={draft.cloud_connection_id} onChange={(e) => set({ cloud_connection_id: e.target.value, bucket: clouds.find((c) => c.id === e.target.value)?.bucket ?? '' })} aria-label="Where"><option value="">Data directory</option>{clouds.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.provider})</option>)}</Select>
              {draft.cloud_connection_id && <Input className="w-36 font-mono" value={draft.bucket} onChange={(e) => set({ bucket: e.target.value })} placeholder="bucket" aria-label="Bucket" />}
              <Input className="min-w-48 flex-1 font-mono" value={draft.path} onChange={(e) => set({ path: e.target.value })} placeholder="exports/scores.parquet" aria-label="Path" data-testid="reverse-path" />
            </div>
          )}
          {draft.kind === 'http' && (
            <div className="space-y-2">
              <div className="flex flex-wrap gap-2">
                <Input className="min-w-64 flex-1 font-mono" value={draft.url} onChange={(e) => set({ url: e.target.value })} placeholder="https://api.example.com/v1/contacts/batch" aria-label="URL" data-testid="reverse-url" />
                <Select value={draft.payload} onChange={(e) => set({ payload: e.target.value as Draft['payload'] })} aria-label="Body" title="object: {op, batch, rows:[…]} · array: [rows] · ndjson: one row per line"><option value="object">JSON object</option><option value="array">JSON array</option><option value="ndjson">NDJSON</option></Select>
                <Input className="w-24 font-mono" value={draft.batch_size} onChange={(e) => set({ batch_size: e.target.value })} aria-label="Rows per request" title="Rows per request" />
              </div>
              <div className="space-y-1.5">
                {draft.id && !draft.headersEdited && draft.keptHeaders.length > 0 ? (
                  <p className="text-zinc-500">Headers kept: <span className="font-mono">{draft.keptHeaders.join(', ')}</span> (values hidden) · <button className="text-accent-300 hover:underline" onClick={() => set({ headersEdited: true, headers: draft.keptHeaders.map((n) => ({ name: n, value: '' })) })}>Replace</button></p>
                ) : (
                  <>
                    {draft.headers.map((h, i) => (
                      <div key={i} className="flex gap-2">
                        <Input uiSize="sm" className="w-40 font-mono" value={h.name} onChange={(e) => set({ headersEdited: true, headers: draft.headers.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} placeholder="Header" aria-label="Header name" />
                        <Input uiSize="sm" type="password" className="min-w-40 flex-1 font-mono" value={h.value} onChange={(e) => set({ headersEdited: true, headers: draft.headers.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })} placeholder="Bearer … (stored encrypted)" aria-label="Header value" />
                        <IconButton label="Remove header" onClick={() => set({ headersEdited: true, headers: draft.headers.filter((_, j) => j !== i) })}><X className="h-3.5 w-3.5" /></IconButton>
                      </div>
                    ))}
                    <button className="text-accent-300 hover:underline" onClick={() => set({ headersEdited: true, headers: [...draft.headers, { name: '', value: '' }] })}>Add header</button>
                  </>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-end gap-2">
          <div><Label>Mode</Label><Select value={draft.mode} onChange={(e) => set({ mode: e.target.value as ReverseMode })} data-testid="reverse-mode">{modes.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</Select></div>
          {keyed && <div className="min-w-40 flex-1"><Label>Key columns</Label><Input className="font-mono" value={draft.keys} onChange={(e) => set({ keys: e.target.value })} placeholder="id" data-testid="reverse-keys" /></div>}
          <p className="basis-full text-zinc-500">{MODES.find((m) => m.id === draft.mode)?.hint}.</p>
        </div>

        <div className="flex flex-wrap items-end gap-2 border-t border-zinc-800 pt-3">
          <div><Label>Run</Label><Select value={draft.scheduleKind} onChange={(e) => set({ scheduleKind: e.target.value as Draft['scheduleKind'] })}><option value="manual">By hand</option><option value="interval">Every …</option><option value="cron">On a cron schedule</option></Select></div>
          {draft.scheduleKind === 'interval' && <div><Label>Minutes</Label><Input className="w-24 font-mono" value={draft.minutes} onChange={(e) => set({ minutes: e.target.value })} /></div>}
          {draft.scheduleKind === 'cron' && <div><Label>Cron</Label><Input className="w-40 font-mono" value={draft.cron} onChange={(e) => set({ cron: e.target.value })} /></div>}
          <div className="min-w-0 flex-1">
            <Label>Tell when it fails</Label>
            {channels.filter((c) => c.enabled).length === 0 ? <p className="py-1.5 text-zinc-500">No channels yet — add one under Dashboards › Channels.</p> : (
              <div className="flex flex-wrap gap-1.5">
                {channels.filter((c) => c.enabled).map((c) => (
                  <label key={c.id} className={cn('flex h-[var(--control-h)] cursor-pointer items-center gap-1.5 rounded-md border px-2', draft.channel_ids.includes(c.id) ? 'border-accent-500 text-zinc-100' : 'border-zinc-800 text-zinc-400')}>
                    <input type="checkbox" className="accent-accent-500" checked={draft.channel_ids.includes(c.id)} onChange={(e) => set({ channel_ids: e.target.checked ? [...draft.channel_ids, c.id] : draft.channel_ids.filter((x) => x !== c.id) })} />{CHANNEL_META[c.type].icon}{c.name}
                  </label>
                ))}
              </div>
            )}
          </div>
        </div>

        {error && <div className="rounded-md border border-red-900 bg-red-950/50 px-3 py-2 font-mono text-red-200">{error}</div>}
        <div className="flex items-center justify-end gap-2">
          <span className="mr-auto text-zinc-500">Nothing is sent until it runs.</span>
          <Button variant="ghost" onClick={() => setDraft(null)}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!ready} onClick={() => void save()} data-testid="save-reverse">{draft.id ? 'Save' : 'Create'} <ArrowUpRight className="h-3.5 w-3.5" /></Button>
        </div>
      </div>
    </Modal>
  );
}
