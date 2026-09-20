import { useEffect, useState } from 'react';
import { CheckCircle2, ExternalLink, KeyRound, Trash2 } from 'lucide-react';
import { api, timeAgo, type GoogleIntegration } from '../../api/client';
import { Button, Badge, Card, Input, Label } from '../../components/ui';

/**
 * Settings → Integrations: the Google OAuth client that lets people connect Google Drive, Sheets, BigQuery and
 * Analytics with their own account. The secret is write-only: entered once, encrypted, never shown again.
 */
export function IntegrationsPanel({ isAdmin }: { isAdmin: boolean }) {
  const [google, setGoogle] = useState<GoogleIntegration | null>(null);
  const [clientId, setClientId] = useState('');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const load = () => api.get<GoogleIntegration>('/api/admin/integrations/google').then((g) => { setGoogle(g); setClientId(g.client_id ?? ''); }).catch(() => setGoogle(null));
  useEffect(() => { if (isAdmin) void load(); }, [isAdmin]);
  if (!isAdmin) return <Card title="Integrations"><p className="text-xs text-zinc-500">Administrators configure sign-in integrations here. To connect Google Drive, Sheets, BigQuery or Analytics with your Google account, use the Connections page — if "Connect with Google" is disabled there, ask an administrator to register the OAuth client.</p></Card>;
  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const g = await api.put<GoogleIntegration>('/api/admin/integrations/google', { client_id: clientId.trim(), client_secret: secret.trim() || null });
      setGoogle(g);
      setSecret('');
      setMsg({ ok: true, text: 'Saved. The secret is encrypted and will not be shown again.' });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-4">
      <Card title="Google account sign-in">
        <p className="mb-3 text-xs text-zinc-500">Lets analysts connect <b className="text-zinc-300">Google Drive, Google Sheets, BigQuery and Google Analytics</b> by signing in with their Google account (read-only scopes; refresh tokens are stored encrypted per connection). Register an OAuth client once in Google Cloud and paste it here — it never goes into a config file.</p>
        <ol className="mb-4 list-decimal space-y-1 pl-5 text-[11px] text-zinc-400">
          <li>Google Cloud Console → APIs & Services → <a className="text-accent-300 hover:underline" href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer">Credentials <ExternalLink className="inline h-3 w-3" /></a> → Create credentials → OAuth client ID → Web application.</li>
          <li>Authorised redirect URI: <code className="select-all rounded bg-zinc-900 px-1 font-mono text-zinc-200">{google?.redirect_uri ?? '…'}</code> (from <code className="font-mono">server.public_url</code>).</li>
          <li>Enable the APIs you need: Google Drive API, Google Sheets API, BigQuery API, Google Analytics Data API. Add test users while the consent screen is in testing.</li>
        </ol>
        <div className="grid max-w-2xl gap-3 md:grid-cols-2">
          <div><Label>Client id</Label><Input value={clientId} onChange={(e) => setClientId(e.target.value)} className="font-mono" placeholder="1234567890-abc.apps.googleusercontent.com" spellCheck={false} /></div>
          <div><Label>Client secret {google?.configured && <span className="normal-case text-zinc-600">(stored · leave empty to keep)</span>}</Label><Input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={google?.configured ? '••••••••' : 'GOCSPX-…'} autoComplete="off" /></div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button variant="primary" size="sm" loading={busy} disabled={!clientId.trim() || (!google?.configured && !secret.trim())} onClick={() => void save()}><KeyRound className="h-3.5 w-3.5" /> Save</Button>
          {google?.configured && <Badge tone="green"><CheckCircle2 className="mr-1 inline h-3 w-3" /> configured{google.updated_at ? ` · ${timeAgo(google.updated_at)}` : ''}</Badge>}
          {google?.configured && <Button variant="ghost" size="sm" className="text-red-300" onClick={async () => { if (confirm('Remove the Google OAuth client? Existing Google connections stop refreshing their tokens.')) { await api.del('/api/admin/integrations/google'); await load(); } }}><Trash2 className="h-3.5 w-3.5" /> Remove</Button>}
          {msg && <span className={msg.ok ? 'text-xs text-emerald-300' : 'text-xs text-red-300'}>{msg.text}</span>}
        </div>
        <p className="mt-3 text-[11px] text-zinc-500">Server-to-server alternative: a connection can use a <b>service account key</b> instead (pasted in the connection wizard, encrypted the same way) — no OAuth client needed.</p>
      </Card>
    </div>
  );
}
