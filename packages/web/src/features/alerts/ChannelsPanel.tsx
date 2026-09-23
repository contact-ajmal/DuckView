import { useCallback, useEffect, useState } from 'react';
import { Bell, Globe, Mail, MessageSquare, Plus, Send, Siren, Trash2, Webhook, Copy, History } from 'lucide-react';
import { api, timeAgo, type ChannelType, type NotificationChannel, type NotificationDelivery } from '../../api/client';
import { useWorkspaceAccess } from '../../store/workspace';
import { useAuth } from '../../store/auth';
import { Badge, Button, Empty, Input, Label, Modal, cn } from '../../components/ui';

export const CHANNEL_META: Record<ChannelType, { label: string; icon: React.ReactNode; hint: string }> = {
  slack: { label: 'Slack', icon: <MessageSquare className="h-4 w-4" />, hint: 'An incoming webhook: Slack → Apps → Incoming Webhooks → Add to a channel, copy the https://hooks.slack.com/… URL.' },
  teams: { label: 'Microsoft Teams', icon: <MessageSquare className="h-4 w-4" />, hint: 'A Workflows webhook ("Post to a channel when a webhook request is received") or a channel incoming webhook; messages arrive as Adaptive Cards.' },
  email: { label: 'Email', icon: <Mail className="h-4 w-4" />, hint: 'Sent through the server\'s mail settings (Settings → Integrations → Outgoing mail).' },
  pagerduty: { label: 'PagerDuty', icon: <Siren className="h-4 w-4" />, hint: 'The integration key of an Events API v2 integration on a service; alerts trigger incidents and resolve them when they clear.' },
  webhook: { label: 'Webhook', icon: <Webhook className="h-4 w-4" />, hint: 'A JSON POST to your URL, signed: X-DuckView-Signature = sha256=HMAC(secret, "<X-DuckView-Timestamp>.<body>").' },
};

/** Alerts → Channels: where alerts and scheduled snapshots of the workspace (and org-wide ones) are delivered. */
export function ChannelsPanel({ workspaceId }: { workspaceId: string }) {
  const { canEdit } = useWorkspaceAccess();
  const isAdmin = useAuth((a) => a.user?.role === 'ADMIN');
  const [channels, setChannels] = useState<NotificationChannel[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [form, setForm] = useState<{ open: boolean; scope: 'workspace' | 'org'; type: ChannelType; name: string; url: string; key: string; to: string } | null>(null);
  const [secretShown, setSecretShown] = useState<string | null>(null);
  const [history, setHistory] = useState<{ channel: NotificationChannel; rows: NotificationDelivery[] } | null>(null);
  const load = useCallback(async () => setChannels((await api.get<{ channels: NotificationChannel[] }>(`/api/workspaces/${workspaceId}/channels`)).channels), [workspaceId]);
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
    if (!form) return;
    const secret = form.type === 'pagerduty' ? { routing_key: form.key.trim() } : form.type === 'email' ? undefined : { url: form.url.trim() };
    const body = { name: form.name.trim(), type: form.type, secret, config: form.type === 'email' ? { to: form.to } : undefined };
    const r = await api.post<{ channel: NotificationChannel; signing_secret: string | null }>(form.scope === 'org' ? '/api/channels' : `/api/workspaces/${workspaceId}/channels`, body);
    setForm(null);
    if (r.signing_secret) setSecretShown(r.signing_secret);
  });
  const test = (c: NotificationChannel) => act(`test:${c.id}`, async () => {
    const r = await api.post<{ delivery: NotificationDelivery }>(`/api/channels/${c.id}/test`, {});
    if (r.delivery.status === 'error') throw new Error(`${c.name}: ${r.delivery.error}`);
  });
  const mayEdit = (c: NotificationChannel) => (c.scope === 'org' ? isAdmin : canEdit);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-zinc-500">Channels of this workspace, and org-wide ones set by administrators. Webhook URLs and keys are encrypted and never shown again.</p>
        <Button variant="primary" size="sm" disabled={!canEdit} onClick={() => setForm({ open: true, scope: 'workspace', type: 'slack', name: '', url: '', key: '', to: '' })}><Plus className="h-3.5 w-3.5" /> New channel</Button>
      </div>
      {error && <div className="rounded-md border border-red-900 bg-red-950/50 px-3 py-2 font-mono text-xs text-red-200">{error}</div>}
      {secretShown && (
        <div className="rounded-md border border-amber-900/60 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">
          Signing secret — copy it now, it is not shown again: <code className="select-all font-mono text-amber-100">{secretShown}</code>
          <Button size="sm" variant="ghost" onClick={() => void navigator.clipboard?.writeText(secretShown)}><Copy className="h-3 w-3" /></Button>
          <button className="ml-2 text-zinc-400 hover:text-zinc-200" onClick={() => setSecretShown(null)}>×</button>
        </div>
      )}
      {channels.length === 0 ? (
        <div className="border-y border-zinc-800 py-12"><Empty icon={<Bell className="h-10 w-10" />} title="No channels yet" hint="Add Slack, Teams, email, PagerDuty or a webhook — alerts and scheduled snapshots are delivered there." /></div>
      ) : (
        <div className="grid gap-2 md:grid-cols-2">
          {channels.map((c) => (
            <div key={c.id} className={cn('rounded-lg border border-zinc-800 p-3', !c.enabled && 'opacity-60')}>
              <div className="flex items-center gap-2">
                <span className="text-accent-300">{CHANNEL_META[c.type].icon}</span>
                <span className="truncate text-sm font-semibold text-zinc-100">{c.name}</span>
                <Badge>{CHANNEL_META[c.type].label}</Badge>
                {c.scope === 'org' && <Badge tone="blue" className="gap-1"><Globe className="h-3 w-3" /> org-wide</Badge>}
                {c.last_status && <Badge tone={c.last_status === 'ok' ? 'green' : 'red'} className="ml-auto">{c.last_status === 'ok' ? 'delivered' : 'failed'}</Badge>}
              </div>
              <div className="mt-1 truncate font-mono text-[11px] text-zinc-500">{c.hint ?? '—'}</div>
              <div className="mt-1 text-[10.5px] text-zinc-600">{c.last_sent_at ? `last sent ${timeAgo(c.last_sent_at)}` : 'nothing sent yet'}{c.last_error ? <span className="text-red-300"> · {c.last_error}</span> : null}</div>
              <div className="mt-2 flex items-center gap-1">
                <Button size="sm" variant="secondary" disabled={!mayEdit(c)} loading={busy === `test:${c.id}`} onClick={() => void test(c)} title="Send a test message"><Send className="h-3.5 w-3.5" /> Test</Button>
                <Button size="sm" variant="ghost" onClick={() => void api.get<{ deliveries: NotificationDelivery[] }>(`/api/channels/${c.id}/deliveries`).then((r) => setHistory({ channel: c, rows: r.deliveries }))} title="Recent deliveries"><History className="h-3.5 w-3.5" /></Button>
                <Button size="sm" variant="ghost" disabled={!mayEdit(c)} onClick={() => void act(`toggle:${c.id}`, () => api.patch(`/api/channels/${c.id}`, { enabled: !c.enabled }))}>{c.enabled ? 'Disable' : 'Enable'}</Button>
                <Button size="sm" variant="ghost" className="ml-auto text-red-300" disabled={!mayEdit(c)} onClick={() => { if (confirm(`Delete the channel "${c.name}"? Alerts that use it stop delivering there.`)) void act(`del:${c.id}`, () => api.del(`/api/channels/${c.id}`)); }}><Trash2 className="h-3.5 w-3.5" /></Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal open={!!form} onClose={() => setForm(null)} title="New channel" width="max-w-lg">
        {form && (
          <div className="space-y-3 text-xs">
            <div className="grid grid-cols-5 gap-1">
              {(Object.keys(CHANNEL_META) as ChannelType[]).map((t) => (
                <button key={t} type="button" onClick={() => setForm({ ...form, type: t })} className={cn('flex flex-col items-center gap-1 rounded-md border p-2 text-[11px]', form.type === t ? 'border-accent-500 bg-accent-600/10 text-zinc-100' : 'border-zinc-800 text-zinc-400 hover:border-zinc-600')}>{CHANNEL_META[t].icon}{CHANNEL_META[t].label}</button>
              ))}
            </div>
            <p className="text-[11px] text-zinc-500">{CHANNEL_META[form.type].hint}</p>
            <div><Label>Name</Label><Input autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={form.type === 'email' ? 'Ops mailing list' : '#data-alerts'} /></div>
            {(form.type === 'slack' || form.type === 'teams' || form.type === 'webhook') && <div><Label>Webhook URL</Label><Input type="password" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} className="font-mono" placeholder={form.type === 'slack' ? 'https://hooks.slack.com/services/…' : 'https://…'} autoComplete="off" /></div>}
            {form.type === 'pagerduty' && <div><Label>Integration key</Label><Input type="password" value={form.key} onChange={(e) => setForm({ ...form, key: e.target.value })} className="font-mono" placeholder="32 characters" autoComplete="off" /></div>}
            {form.type === 'email' && <div><Label>Recipients</Label><Input value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })} placeholder="ops@example.com, lead@example.com" /></div>}
            {isAdmin && (
              <label className="flex items-center gap-2 text-zinc-400"><input type="checkbox" className="accent-accent-500" checked={form.scope === 'org'} onChange={(e) => setForm({ ...form, scope: e.target.checked ? 'org' : 'workspace' })} /> Org-wide — usable by every workspace (administrators manage it)</label>
            )}
            {error && <div className="rounded-md border border-red-900 bg-red-950/50 px-3 py-2 font-mono text-red-200">{error}</div>}
            <div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => setForm(null)}>Cancel</Button><Button variant="primary" loading={busy === 'create'} disabled={!form.name.trim()} onClick={() => void create()}><Plus className="h-4 w-4" /> Create</Button></div>
          </div>
        )}
      </Modal>

      <Modal open={!!history} onClose={() => setHistory(null)} title={`Deliveries · ${history?.channel.name ?? ''}`} width="max-w-xl">
        <div className="max-h-96 space-y-1 overflow-auto text-xs">
          {history?.rows.length === 0 && <p className="text-zinc-500">Nothing delivered yet.</p>}
          {history?.rows.map((d) => (
            <div key={d.id} className="flex items-start gap-2 border-b border-zinc-800/60 py-1.5">
              <Badge tone={d.status === 'ok' ? 'green' : 'red'}>{d.status}</Badge>
              <div className="min-w-0 flex-1"><div className="truncate text-zinc-200">{d.title}</div><div className="text-[10.5px] text-zinc-500">{d.source} · {timeAgo(d.created_at)} · {d.attempts} attempt{d.attempts === 1 ? '' : 's'}{d.duration_ms !== null ? ` · ${d.duration_ms} ms` : ''}</div>{d.error && <div className="font-mono text-[10.5px] text-red-300">{d.error}</div>}</div>
            </div>
          ))}
        </div>
      </Modal>
    </div>
  );
}
