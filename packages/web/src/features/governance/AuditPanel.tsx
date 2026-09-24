import { useCallback, useEffect, useState } from 'react';
import { Plus, Send, Trash2, Radio, Copy } from 'lucide-react';
import { api, timeAgo, type AuditEvent, type AuditSink, type AuditSinkType, type CloudConnection } from '../../api/client';
import { Badge, Button, Input, Label, Modal, Select, cn, confirmAction } from '../../components/ui';

const TYPES: Record<AuditSinkType, { label: string; hint: string }> = {
  splunk: { label: 'Splunk', hint: 'HTTP Event Collector: the Splunk URL (https://splunk.example.com:8088) and a HEC token.' },
  datadog: { label: 'Datadog', hint: 'Logs intake of your Datadog site (datadoghq.com, datadoghq.eu, us5.datadoghq.com…) with an API key.' },
  elastic: { label: 'Elastic / OpenSearch', hint: 'The cluster URL and an index; an API key, or a username and password. Documents are created with the event id, so a resend is harmless.' },
  webhook: { label: 'Webhook (NDJSON)', hint: 'A POST of newline-delimited JSON, signed like channel webhooks (X-DuckView-Signature).' },
  s3: { label: 'Bucket (S3 / R2 / GCS / Azure)', hint: 'Gzipped NDJSON files under <prefix>/dt=YYYY-MM-DD/, through one of your cloud storage connections.' },
};

interface Draft { type: AuditSinkType; name: string; url: string; token: string; site: string; tags: string; index: string; username: string; password: string; connection: string; bucket: string; prefix: string; include_sql: boolean; backfill: boolean }
const blank = (): Draft => ({ type: 'splunk', name: '', url: '', token: '', site: 'datadoghq.com', tags: '', index: 'duckview-audit', username: '', password: '', connection: '', bucket: '', prefix: 'duckview/audit', include_sql: true, backfill: false });

/** Governance → Audit: recent events, and (administrators) where the audit log is streamed. */
export function AuditPanel({ isAdmin }: { isAdmin: boolean }) {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [sinks, setSinks] = useState<AuditSink[]>([]);
  const [clouds, setClouds] = useState<CloudConnection[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setEvents((await api.get<{ events: AuditEvent[] }>('/api/audit?limit=50')).events);
    if (isAdmin) {
      setSinks((await api.get<{ sinks: AuditSink[] }>('/api/admin/audit-sinks')).sinks);
      setClouds((await api.get<{ connections: CloudConnection[] }>('/api/cloud-connections').catch(() => ({ connections: [] }))).connections);
    }
  }, [isAdmin]);
  useEffect(() => void load().catch((e) => setError((e as Error).message)), [load]);
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
  const create = () => act('create', async () => {
    if (!draft) return;
    const d = draft;
    const config: Record<string, unknown> = { include_sql: d.include_sql, ...(d.type === 'splunk' || d.type === 'elastic' || d.type === 'webhook' ? { url: d.url.trim() } : {}), ...(d.type === 'datadog' ? { site: d.site, tags: d.tags } : {}), ...(d.type === 'elastic' ? { index: d.index } : {}), ...(d.type === 's3' ? { connection_id: d.connection, bucket: d.bucket, prefix: d.prefix } : {}) };
    const secret = d.type === 'splunk' ? { token: d.token } : d.type === 'datadog' ? { api_key: d.token } : d.type === 'elastic' ? (d.token ? { api_key: d.token } : { username: d.username, password: d.password }) : undefined;
    const r = await api.post<{ sink: AuditSink; signing_secret: string | null }>('/api/admin/audit-sinks', { name: d.name.trim() || TYPES[d.type].label, type: d.type, config, secret, backfill: d.backfill });
    setDraft(null);
    if (r.signing_secret) setSecret(r.signing_secret);
  });

  return (
    <div className="space-y-4 text-xs">
      {error && <div className="rounded-md border border-red-900 bg-red-950/50 px-3 py-2 font-mono text-red-200">{error}</div>}
      {isAdmin && (
        <section className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-zinc-500">Stream the audit log to a SIEM or a bucket. Each destination keeps its place in the log, so nothing is lost across restarts or outages (a batch may arrive twice after a failure).</p>
            <Button size="sm" variant="primary" onClick={() => setDraft(blank())}><Plus className="h-3.5 w-3.5" /> Add destination</Button>
          </div>
          {secret && <div className="rounded-md border border-amber-900/60 bg-amber-950/30 px-3 py-2 text-amber-200">Signing secret — copy it now: <code className="select-all font-mono text-amber-100">{secret}</code> <button onClick={() => void navigator.clipboard?.writeText(secret)}><Copy className="inline h-3 w-3" /></button> <button className="ml-2 text-zinc-400" onClick={() => setSecret(null)}>×</button></div>}
          {sinks.length === 0 ? <p className="border-y border-zinc-800 p-4 text-zinc-500">No destinations — the audit log stays in DuckView (below, and in its database).</p> : (
            <div className="grid gap-2 md:grid-cols-2">
              {sinks.map((s) => (
                <div key={s.id} className={cn('rounded-lg border border-zinc-800 p-3', !s.enabled && 'opacity-60')}>
                  <div className="flex items-center gap-2"><Radio className="h-4 w-4 text-accent-300" /><span className="font-semibold text-zinc-100">{s.name}</span><Badge>{TYPES[s.type].label}</Badge>{s.last_status && <Badge tone={s.last_status === 'ok' ? 'green' : 'red'} className="ml-auto">{s.last_status === 'ok' ? 'streaming' : 'failing'}</Badge>}</div>
                  <div className="mt-1 text-2xs text-zinc-500">{s.exported.toLocaleString()} events sent{s.last_exported_at ? ` · last ${timeAgo(s.last_exported_at)}` : ''}{s.cursor_at ? ` · up to ${new Date(s.cursor_at).toLocaleString()}` : ''}{s.retry_after && s.last_status === 'error' ? ` · retrying ${timeAgo(s.retry_after)}` : ''}</div>
                  {s.last_error && <div className="mt-1 font-mono text-2xs text-red-300">{s.last_error}</div>}
                  <div className="mt-2 flex gap-1">
                    <Button size="sm" variant="secondary" loading={busy === `t:${s.id}`} onClick={() => void act(`t:${s.id}`, async () => { const r = await api.post<{ ok: boolean; error: string | null }>(`/api/admin/audit-sinks/${s.id}/test`, {}); if (!r.ok) throw new Error(`${s.name}: ${r.error}`); })}><Send className="h-3.5 w-3.5" /> Test</Button>
                    <Button size="sm" variant="ghost" onClick={() => void act(`e:${s.id}`, () => api.patch(`/api/admin/audit-sinks/${s.id}`, { enabled: !s.enabled }))}>{s.enabled ? 'Pause' : 'Resume'}</Button>
                    <Button size="sm" variant="ghost" className="ml-auto text-red-300" onClick={async () => { if ((await confirmAction(`Stop streaming to "${s.name}"?`))) void act(`d:${s.id}`, () => api.del(`/api/admin/audit-sinks/${s.id}`)); }}><Trash2 className="h-3.5 w-3.5" /></Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
      <section>
        <h3 className="mb-1.5 text-2xs font-semibold text-zinc-500">{isAdmin ? 'Recent events' : 'Your recent activity'}</h3>
        <div className="max-h-[28rem] overflow-auto rounded-lg border border-zinc-800">
          <table className="w-full text-left text-2xs">
            <thead className="sticky top-0 bg-zinc-900 text-zinc-500"><tr><th className="px-2 py-1">When</th><th className="px-2 py-1">Action</th><th className="px-2 py-1">Actor</th><th className="px-2 py-1">Resource</th><th className="px-2 py-1">Status</th></tr></thead>
            <tbody>{events.map((e) => <tr key={e.id} className="border-t border-zinc-800/60"><td className="whitespace-nowrap px-2 py-1 text-zinc-500">{timeAgo(e.timestamp)}</td><td className="px-2 py-1 font-mono text-zinc-200">{e.action}</td><td className="px-2 py-1 text-zinc-400">{e.actor_type.toLowerCase()}</td><td className="max-w-xs truncate px-2 py-1 font-mono text-zinc-500" title={e.query_text ?? e.resource ?? ''}>{e.resource}</td><td className="px-2 py-1"><Badge tone={e.status === 'ok' ? 'zinc' : 'red'}>{e.status}</Badge></td></tr>)}</tbody>
          </table>
        </div>
      </section>

      <Modal open={!!draft} onClose={() => setDraft(null)} title="Stream the audit log to…" width="max-w-lg">
        {draft && (
          <div className="space-y-3">
            <div className="grid grid-cols-5 gap-1">{(Object.keys(TYPES) as AuditSinkType[]).map((t) => <button key={t} type="button" onClick={() => setDraft({ ...draft, type: t })} className={cn('rounded-md border px-1.5 py-1.5 text-2xs', draft.type === t ? 'border-accent-500 bg-accent-600/10 text-zinc-100' : 'border-zinc-800 text-zinc-400')}>{TYPES[t].label}</button>)}</div>
            <p className="text-2xs text-zinc-500">{TYPES[draft.type].hint}</p>
            <div><Label>Name</Label><Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder={TYPES[draft.type].label} /></div>
            {(draft.type === 'splunk' || draft.type === 'elastic' || draft.type === 'webhook') && <div><Label>URL</Label><Input className="font-mono" value={draft.url} onChange={(e) => setDraft({ ...draft, url: e.target.value })} placeholder="https://…" /></div>}
            {draft.type === 'datadog' && <div className="grid grid-cols-2 gap-2"><div><Label>Site</Label><Input value={draft.site} onChange={(e) => setDraft({ ...draft, site: e.target.value })} /></div><div><Label>Tags</Label><Input value={draft.tags} onChange={(e) => setDraft({ ...draft, tags: e.target.value })} placeholder="env:prod" /></div></div>}
            {draft.type === 'elastic' && <div><Label>Index</Label><Input className="font-mono" value={draft.index} onChange={(e) => setDraft({ ...draft, index: e.target.value })} /></div>}
            {(draft.type === 'splunk' || draft.type === 'datadog' || draft.type === 'elastic') && <div><Label>{draft.type === 'splunk' ? 'HEC token' : 'API key'}{draft.type === 'elastic' ? ' (or a user below)' : ''}</Label><Input type="password" value={draft.token} onChange={(e) => setDraft({ ...draft, token: e.target.value })} autoComplete="off" /></div>}
            {draft.type === 'elastic' && !draft.token && <div className="grid grid-cols-2 gap-2"><div><Label>User</Label><Input value={draft.username} onChange={(e) => setDraft({ ...draft, username: e.target.value })} /></div><div><Label>Password</Label><Input type="password" value={draft.password} onChange={(e) => setDraft({ ...draft, password: e.target.value })} /></div></div>}
            {draft.type === 's3' && <div className="grid grid-cols-3 gap-2"><div><Label>Connection</Label><Select className="w-full" value={draft.connection} onChange={(e) => setDraft({ ...draft, connection: e.target.value })}><option value="">Pick…</option>{clouds.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.provider})</option>)}</Select></div><div><Label>Bucket</Label><Input value={draft.bucket} onChange={(e) => setDraft({ ...draft, bucket: e.target.value })} /></div><div><Label>Prefix</Label><Input className="font-mono" value={draft.prefix} onChange={(e) => setDraft({ ...draft, prefix: e.target.value })} /></div></div>}
            <label className="flex items-center gap-2 text-zinc-400"><input type="checkbox" className="accent-accent-500" checked={draft.include_sql} onChange={(e) => setDraft({ ...draft, include_sql: e.target.checked })} /> Include the SQL of queries</label>
            <label className="flex items-center gap-2 text-zinc-400"><input type="checkbox" className="accent-accent-500" checked={draft.backfill} onChange={(e) => setDraft({ ...draft, backfill: e.target.checked })} /> Send the existing log too (otherwise: from now on)</label>
            {error && <div className="rounded-md border border-red-900 bg-red-950/50 px-3 py-2 font-mono text-red-200">{error}</div>}
            <div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => setDraft(null)}>Cancel</Button><Button variant="primary" loading={busy === 'create'} onClick={() => void create()}>Start streaming</Button></div>
          </div>
        )}
      </Modal>
    </div>
  );
}
