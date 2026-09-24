import { useCallback, useEffect, useState } from 'react';
import { Database, KeyRound, Pause, Play, Plus, Radio, Trash2, Webhook, Waves, FlaskConical } from 'lucide-react';
import { api, timeAgo, type CloudConnection, type DatabaseConnection, type Stream, type StreamConfig } from '../../api/client';
import { useWorkspace, useWorkspaceAccess } from '../../store/workspace';
import { subscribeLiveEvents } from '../../lib/liveEvents';
import { Badge, Button, CopyButton, Input, Label, Select, cn, confirmAction } from '../../components/ui';

type Kind = Stream['kind'];
type Draft = { name: string; kind: Kind; brokers: string; topic: string; group_id: string; from_beginning: boolean; ssl: boolean; sasl_mechanism: '' | 'plain' | 'scram-sha-256' | 'scram-sha-512'; sasl_username: string; sasl_password: string; stream: string; region: string; cloud_connection_id: string; start: 'LATEST' | 'TRIM_HORIZON'; connection_id: string; pg_table: string; snapshot: boolean; format: 'json' | 'text' | 'debezium'; mirror: boolean; key_columns: string; keep_history: boolean; target_table: string; include_metadata: boolean; batch_rows: number; batch_seconds: number };
const EMPTY: Draft = { name: '', kind: 'kafka', brokers: '', topic: '', group_id: '', from_beginning: true, ssl: false, sasl_mechanism: '', sasl_username: '', sasl_password: '', stream: '', region: 'us-east-1', cloud_connection_id: '', start: 'TRIM_HORIZON', connection_id: '', pg_table: '', snapshot: true, format: 'json', mirror: false, key_columns: '', keep_history: false, target_table: '', include_metadata: true, batch_rows: 1000, batch_seconds: 5 };
const KINDS: { id: Kind; label: string; hint: string; icon: typeof Radio }[] = [
  { id: 'kafka', label: 'Kafka', hint: 'Apache Kafka, Confluent, Redpanda, MSK', icon: Radio },
  { id: 'kinesis', label: 'Kinesis', hint: 'Amazon Kinesis Data Streams', icon: Waves },
  { id: 'http', label: 'HTTP push', hint: 'your app POSTs events to DuckView', icon: Webhook },
  { id: 'postgres', label: 'Postgres CDC', hint: 'a table\'s inserts, updates and deletes', icon: Database },
];

const configOf = (d: Draft): StreamConfig =>
  d.kind === 'kafka'
    ? { kind: 'kafka', brokers: d.brokers.split(/[,\s]+/).filter(Boolean), topic: d.topic.trim(), group_id: d.group_id.trim() || null, from_beginning: d.from_beginning, ssl: d.ssl, sasl_mechanism: d.sasl_mechanism || null, sasl_username: d.sasl_username.trim() || null }
    : d.kind === 'kinesis'
      ? { kind: 'kinesis', stream: d.stream.trim(), region: d.region.trim(), cloud_connection_id: d.cloud_connection_id || null, start: d.start }
      : d.kind === 'postgres'
        ? { kind: 'postgres', connection_id: d.connection_id, table: d.pg_table.trim(), snapshot: d.snapshot }
        : { kind: 'http' };
const describe = (c: StreamConfig) => (c.kind === 'kafka' ? `topic ${c.topic} · ${c.brokers.join(', ')}` : c.kind === 'kinesis' ? `stream ${c.stream} · ${c.region}` : c.kind === 'postgres' ? `Postgres ${c.table} (changes)` : 'HTTP pushes');
/** Postgres CDC and Debezium feeds keep each row's latest state. */
const mirrors = (d: Draft) => d.kind === 'postgres' || d.format === 'debezium' || d.mirror;

/** Connections → Streams: Kafka topics, Kinesis streams and HTTP pushes appended to workspace tables as they arrive. */
export function StreamsPanel({ workspaceId, clouds, databases }: { workspaceId: string; clouds: CloudConnection[]; databases: DatabaseConnection[] }) {
  const { canEdit } = useWorkspaceAccess();
  const ws = useWorkspace();
  const [streams, setStreams] = useState<Stream[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [latest, setLatest] = useState<{ columns: { name: string }[]; rows: unknown[][] } | null>(null);
  const [key, setKey] = useState<{ id: string; key: string } | null>(null);
  const [tested, setTested] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => setStreams((await api.get<{ streams: Stream[] }>(`/api/workspaces/${workspaceId}/streams`)).streams), [workspaceId]);
  const loadLatest = useCallback(async (id: string) => setLatest((await api.get<{ latest: { columns: { name: string }[]; rows: unknown[][] } | null }>(`/api/streams/${id}`)).latest), []);
  useEffect(() => void load().catch((e) => setError((e as Error).message)), [load]);
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null;
    return subscribeLiveEvents((e) => {
      if (e.type !== 'stream' || e.workspace_id !== workspaceId || t) return;
      t = setTimeout(() => {
        t = null;
        void load().catch(() => undefined);
        if (open === e.stream_id) void loadLatest(e.stream_id).catch(() => undefined);
      }, 800);
    });
  }, [workspaceId, load, loadLatest, open]);
  useEffect(() => {
    if (open) void loadLatest(open).catch(() => setLatest(null));
    else setLatest(null);
  }, [open, loadLatest]);

  const act = async (k: string, fn: () => Promise<unknown>) => {
    setBusy(k);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const save = (d: Draft) =>
    act('save', async () => {
      const r = await api.post<{ stream: Stream; push_key: string | null }>(`/api/workspaces/${workspaceId}/streams`, { name: d.name.trim() || undefined, config: configOf(d), sasl_password: d.sasl_password || null, format: d.kind === 'postgres' ? 'json' : d.format, mode: mirrors(d) ? 'mirror' : 'append', key_columns: d.key_columns.split(/[,\s]+/).filter(Boolean), keep_history: mirrors(d) && d.keep_history, target_table: d.target_table.trim(), include_metadata: d.include_metadata, batch_rows: d.batch_rows, batch_seconds: d.batch_seconds });
      if (r.push_key) setKey({ id: r.stream.id, key: r.push_key });
      setDraft(null);
      setTested(null);
      setOpen(r.stream.id);
      await load();
    });
  const test = (d: Draft) => act('test', async () => setTested((await api.post<{ detail: string }>('/api/streams/test', { config: configOf(d), sasl_password: d.sasl_password || null })).detail));

  const pushUrl = (s: Stream) => `${location.origin}${s.push_url}`;

  return (
    <div className="space-y-3 text-xs" data-testid="streams">
      <div className="flex items-center gap-2">
        <p className="text-zinc-400">Data kept flowing into tables as it happens: events from a Kafka topic, a Kinesis stream or your app, and the changes of a Postgres table (inserts, updates, deletes). New fields become columns; nothing is acknowledged before it is written.</p>
        {canEdit && !draft && <Button size="sm" className="ml-auto" onClick={() => { setDraft({ ...EMPTY }); setTested(null); }} data-testid="stream-new"><Plus className="h-3.5 w-3.5" /> New stream</Button>}
      </div>
      {error && <div className="rounded-md border border-red-900 bg-red-950/50 px-3 py-2 font-mono text-red-200">{error}</div>}

      {draft && (
        <div className="space-y-3 rounded-md border border-zinc-800 p-3" data-testid="stream-editor">
          <div className="flex flex-wrap gap-2">
            {KINDS.map((k) => (
              <button key={k.id} onClick={() => { setDraft({ ...draft, kind: k.id }); setTested(null); }} className={cn('flex items-center gap-2 rounded-md border px-3 py-2 text-left', draft.kind === k.id ? 'border-accent-500 bg-accent-500/10' : 'border-zinc-800 hover:border-zinc-700')} data-testid={`stream-kind-${k.id}`}>
                <k.icon className="h-4 w-4 text-zinc-400" />
                <span><span className="block text-body text-zinc-100">{k.label}</span><span className="text-2xs text-zinc-500">{k.hint}</span></span>
              </button>
            ))}
          </div>
          {draft.kind === 'kafka' && (
            <div className="flex flex-wrap gap-3">
              <div className="min-w-[16rem] flex-1"><Label>Brokers (host:port, comma-separated)</Label><Input value={draft.brokers} onChange={(e) => setDraft({ ...draft, brokers: e.target.value })} placeholder="broker-1:9092, broker-2:9092" data-testid="stream-brokers" /></div>
              <div className="w-56"><Label>Topic</Label><Input value={draft.topic} onChange={(e) => setDraft({ ...draft, topic: e.target.value })} data-testid="stream-topic" /></div>
              <div className="w-48"><Label>Consumer group (optional)</Label><Input value={draft.group_id} onChange={(e) => setDraft({ ...draft, group_id: e.target.value })} placeholder="duckview-…" /></div>
              <div><Label>Start from</Label><Select value={draft.from_beginning ? 'earliest' : 'latest'} onChange={(e) => setDraft({ ...draft, from_beginning: e.target.value === 'earliest' })}><option value="earliest">The oldest message</option><option value="latest">New messages only</option></Select></div>
              <div><Label>Security</Label><Select value={draft.sasl_mechanism} onChange={(e) => setDraft({ ...draft, sasl_mechanism: e.target.value as Draft['sasl_mechanism'] })}><option value="">No SASL</option><option value="plain">SASL PLAIN</option><option value="scram-sha-256">SCRAM-SHA-256</option><option value="scram-sha-512">SCRAM-SHA-512</option></Select></div>
              <label className="flex items-center gap-1.5 self-end pb-1.5 text-zinc-300"><input type="checkbox" className="accent-accent-500" checked={draft.ssl} onChange={(e) => setDraft({ ...draft, ssl: e.target.checked })} /> TLS</label>
              {draft.sasl_mechanism && (
                <>
                  <div className="w-48"><Label>Username</Label><Input value={draft.sasl_username} onChange={(e) => setDraft({ ...draft, sasl_username: e.target.value })} /></div>
                  <div className="w-48"><Label>Password — stored encrypted</Label><Input type="password" value={draft.sasl_password} onChange={(e) => setDraft({ ...draft, sasl_password: e.target.value })} /></div>
                </>
              )}
            </div>
          )}
          {draft.kind === 'kinesis' && (
            <div className="flex flex-wrap gap-3">
              <div className="w-56"><Label>Stream name</Label><Input value={draft.stream} onChange={(e) => setDraft({ ...draft, stream: e.target.value })} /></div>
              <div className="w-36"><Label>Region</Label><Input value={draft.region} onChange={(e) => setDraft({ ...draft, region: e.target.value })} /></div>
              <div><Label>AWS credentials</Label><Select value={draft.cloud_connection_id} onChange={(e) => setDraft({ ...draft, cloud_connection_id: e.target.value })}><option value="">The server's (environment, instance role)</option>{clouds.filter((c) => c.provider === 'S3').map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></div>
              <div><Label>Start from</Label><Select value={draft.start} onChange={(e) => setDraft({ ...draft, start: e.target.value as Draft['start'] })}><option value="TRIM_HORIZON">The oldest record</option><option value="LATEST">New records only</option></Select></div>
            </div>
          )}
          {draft.kind === 'postgres' && (
            <div className="flex flex-wrap gap-3">
              <div><Label>Postgres connection</Label><Select value={draft.connection_id} onChange={(e) => setDraft({ ...draft, connection_id: e.target.value })} data-testid="stream-pg-connection"><option value="">Choose…</option>{databases.filter((c) => c.engine === 'postgres').map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></div>
              <div className="w-56"><Label>Table</Label><Input value={draft.pg_table} onChange={(e) => setDraft({ ...draft, pg_table: e.target.value })} placeholder="public.orders" data-testid="stream-pg-table" /></div>
              <label className="flex items-center gap-1.5 self-end pb-1.5 text-zinc-300"><input type="checkbox" className="accent-accent-500" checked={draft.snapshot} onChange={(e) => setDraft({ ...draft, snapshot: e.target.checked })} /> Copy the existing rows first</label>
              <p className="basis-full text-zinc-500">Needs <code className="font-mono">wal_level = logical</code> and a user with REPLICATION. DuckView creates a publication and a replication slot for this stream, and drops them when you remove it.</p>
            </div>
          )}
          {draft.kind === 'http' && <p className="text-zinc-400">After saving you get a URL and a key. POST a JSON object, an array of objects, or newline-delimited JSON to it; each request is appended as one batch.</p>}
          <div className="flex flex-wrap gap-3">
            <div className="w-56"><Label>Into table</Label><Input value={draft.target_table} onChange={(e) => setDraft({ ...draft, target_table: e.target.value.replace(/[^\w]/g, '_') })} placeholder="events" data-testid="stream-table" /></div>
            <div className="min-w-[12rem] flex-1"><Label>Name</Label><Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder={draft.target_table || 'Orders stream'} /></div>
            {draft.kind !== 'postgres' && <div><Label>Messages are</Label><Select value={draft.format} onChange={(e) => setDraft({ ...draft, format: e.target.value as Draft['format'] })} data-testid="stream-format"><option value="json">JSON (fields → columns)</option><option value="text">Text (one value column)</option><option value="debezium">Debezium change events</option></Select></div>}
            {draft.kind !== 'postgres' && draft.format === 'json' && <label className="flex items-center gap-1.5 self-end pb-1.5 text-zinc-300" title="Each key's latest message replaces the previous one instead of adding a row"><input type="checkbox" className="accent-accent-500" checked={draft.mirror} onChange={(e) => setDraft({ ...draft, mirror: e.target.checked })} /> Keep the latest per key</label>}
            {mirrors(draft) && draft.kind !== 'postgres' && <div className="w-48"><Label>Key columns{draft.format === 'debezium' ? ' (else from the message key)' : ''}</Label><Input value={draft.key_columns} onChange={(e) => setDraft({ ...draft, key_columns: e.target.value })} placeholder="id" data-testid="stream-keys" /></div>}
            {mirrors(draft) && <label className="flex items-center gap-1.5 self-end pb-1.5 text-zinc-300" title="Every change, with _op, in <table>__changes"><input type="checkbox" className="accent-accent-500" checked={draft.keep_history} onChange={(e) => setDraft({ ...draft, keep_history: e.target.checked })} data-testid="stream-history" /> Keep a history of changes</label>}
            {draft.kind !== 'http' && <div><Label>Write every</Label><div className="flex items-center gap-1"><Input type="number" min={1} max={300} className="w-16" value={draft.batch_seconds} onChange={(e) => setDraft({ ...draft, batch_seconds: Number(e.target.value) || 1 })} /><span className="text-zinc-500">s or</span><Input type="number" min={1} className="w-20" value={draft.batch_rows} onChange={(e) => setDraft({ ...draft, batch_rows: Number(e.target.value) || 1 })} /><span className="text-zinc-500">rows</span></div></div>}
            <label className="flex items-center gap-1.5 self-end pb-1.5 text-zinc-300" title="_key, _partition, _offset, _timestamp and _ingested_at"><input type="checkbox" className="accent-accent-500" checked={draft.include_metadata} onChange={(e) => setDraft({ ...draft, include_metadata: e.target.checked })} /> Keep key, partition, offset and time</label>
          </div>
          {tested && <p className="text-emerald-300" data-testid="stream-tested">{tested}</p>}
          <div className="flex justify-end gap-2">
            {draft.kind !== 'http' && <Button variant="ghost" className="mr-auto" loading={busy === 'test'} onClick={() => void test(draft)} data-testid="stream-test"><FlaskConical className="h-3.5 w-3.5" /> Test connection</Button>}
            <Button variant="ghost" onClick={() => setDraft(null)}>Cancel</Button>
            <Button variant="primary" loading={busy === 'save'} disabled={!draft.target_table.trim()} onClick={() => void save(draft)} data-testid="stream-save">Start streaming</Button>
          </div>
        </div>
      )}

      {streams && streams.length === 0 && !draft && <p className="rounded-md border border-dashed border-zinc-800 px-3 py-4 text-zinc-400">No streams yet.</p>}
      {streams && streams.length > 0 && (
        <ul className="divide-y divide-zinc-800/70 rounded-md border border-zinc-800" data-testid="stream-list">
          {streams.map((s) => {
            const Icon = KINDS.find((k) => k.id === s.kind)!.icon;
            return (
              <li key={s.id} data-stream={s.name}>
                <div className="flex flex-wrap items-center gap-2 px-3 py-2">
                  <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => setOpen(open === s.id ? null : s.id)}>
                    <Icon className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
                    <span className="text-body text-zinc-100">{s.name}</span>
                    <span className="truncate text-zinc-500">{describe(s.config)} → {s.target_schema !== 'main' ? `${s.target_schema}.` : ''}{s.target_table}</span>
                  </button>
                  <span className={cn('flex items-center gap-1.5', s.status === 'running' ? 'text-emerald-300' : s.status === 'error' ? 'text-red-300' : 'text-zinc-400')} data-testid="stream-status"><span className={cn('h-1.5 w-1.5 rounded-full', s.status === 'running' ? 'bg-emerald-400' : s.status === 'error' ? 'bg-red-400' : s.status === 'starting' ? 'bg-amber-400' : 'bg-zinc-600')} />{s.enabled ? s.status : 'paused'}</span>
                  <span className="w-40 text-right tabular-nums text-zinc-400" data-testid="stream-rows">{s.stats.rows_total.toLocaleString()} {s.mode === 'mirror' ? 'changes' : 'rows'}{s.stats.last_batch_at ? ` · ${timeAgo(s.stats.last_batch_at)}` : ''}</span>
                  {canEdit && <Button size="sm" variant="ghost" onClick={() => void act(`toggle:${s.id}`, async () => { await api.patch(`/api/streams/${s.id}`, { enabled: !s.enabled }); await load(); })} title={s.enabled ? 'Pause' : 'Resume'}>{s.enabled ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}</Button>}
                  {canEdit && <Button size="sm" variant="ghost" onClick={async () => void act(`del:${s.id}`, async () => { if ((await confirmAction(`Stop and remove "${s.name}"? The table ${s.target_table} is kept.`))) { await api.del(`/api/streams/${s.id}`); await load(); } })} title="Remove (the table is kept)"><Trash2 className="h-3.5 w-3.5" /></Button>}
                </div>
                {s.stats.last_error && s.status === 'error' && <p className="px-3 pb-2 font-mono text-red-300">{s.stats.last_error}</p>}
                {open === s.id && (
                  <div className="space-y-2 border-t border-zinc-800/70 px-3 py-2">
                    {s.kind === 'http' && (
                      <div className="space-y-1.5" data-testid="stream-push">
                        <div className="flex items-center gap-2"><span className="w-12 text-zinc-500">URL</span><code className="min-w-0 flex-1 truncate font-mono text-zinc-200">{pushUrl(s)}</code><CopyButton text={pushUrl(s)} /></div>
                        {key?.id === s.id ? (
                          <>
                            <div className="flex items-center gap-2"><span className="w-12 text-zinc-500">Key</span><code className="min-w-0 flex-1 truncate font-mono text-amber-200" data-testid="stream-key">{key.key}</code><CopyButton text={key.key} /></div>
                            <p className="text-amber-300">Copy the key now — it is not shown again.</p>
                            <pre className="overflow-auto rounded bg-zinc-900 p-2 font-mono text-2xs text-zinc-300">{`curl -X POST '${pushUrl(s)}' \\\n  -H 'Authorization: Bearer ${key.key}' \\\n  -H 'Content-Type: application/json' \\\n  -d '[{"event": "signup", "plan": "pro"}]'`}</pre>
                          </>
                        ) : canEdit && <Button size="sm" variant="ghost" onClick={() => void act('rotate', async () => setKey({ id: s.id, key: (await api.post<{ push_key: string }>(`/api/streams/${s.id}/rotate-key`, {})).push_key }))}><KeyRound className="h-3.5 w-3.5" /> New key (the old one stops working)</Button>}
                      </div>
                    )}
                    {s.kind === 'postgres' && <p className="text-zinc-500">{s.checkpoints.snapshot === 'done' ? 'Existing rows copied' : 'Copying the existing rows…'}{s.checkpoints.lsn ? ` · replicated up to ${s.checkpoints.lsn}` : ''}</p>}
                    {(s.kind === 'kinesis') && Object.keys(s.checkpoints).length > 0 && <p className="text-zinc-500">Checkpoints: {Object.entries(s.checkpoints).map(([k, v]) => `${k} @ ${v}`).join(' · ')}</p>}
                    <p className="text-zinc-500">{s.mode === 'mirror' ? `Latest state per ${s.key_columns.join(', ') || 'key'}${s.keep_history ? ` · every change in ${s.target_table}__changes` : ''} · ` : ''}{s.stats.batches.toLocaleString()} batch{s.stats.batches === 1 ? '' : 'es'} · last {s.stats.last_batch_rows.toLocaleString()} row{s.stats.last_batch_rows === 1 ? '' : 's'} · {s.format === 'json' ? 'JSON' : s.format === 'debezium' ? 'Debezium' : 'text'}{s.include_metadata ? ' · with key, partition, offset and time' : ''}</p>
                    {latest && latest.rows.length > 0 ? (
                      <div className="max-h-64 overflow-auto rounded border border-zinc-800" data-testid="stream-latest">
                        <table className="w-full text-2xs">
                          <thead className="sticky top-0 bg-zinc-900"><tr>{latest.columns.map((c) => <th key={c.name} className="px-2 py-1 text-left font-medium text-zinc-400">{c.name}</th>)}</tr></thead>
                          <tbody>{latest.rows.map((r, i) => <tr key={i} className="border-t border-zinc-800/60">{r.map((v, j) => <td key={j} className="max-w-[16rem] truncate px-2 py-1 font-mono text-zinc-300">{v === null ? <span className="text-zinc-600">null</span> : typeof v === 'object' ? JSON.stringify(v) : String(v)}</td>)}</tr>)}</tbody>
                        </table>
                      </div>
                    ) : <p className="text-zinc-500">No rows yet.</p>}
                    <div className="flex gap-2"><Badge>{s.target_schema}.{s.target_table}</Badge><button className="text-accent-300 hover:underline" onClick={() => void ws.addTab({ title: s.target_table, sql: `SELECT * FROM ${s.target_schema === 'main' ? '' : `${s.target_schema}.`}${s.target_table} ORDER BY ${s.include_metadata ? '_ingested_at' : '1'} DESC LIMIT 100` }).then(() => (location.hash = '#/query'))}>Query it</button></div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
