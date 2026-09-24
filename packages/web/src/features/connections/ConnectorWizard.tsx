import { useEffect, useState } from 'react';
import { Plug, CheckCircle2, AlertTriangle, ExternalLink, KeyRound, ShieldCheck } from 'lucide-react';
import { api, type ConnectorConnection, type ConnectorSummary, type GoogleIntegration, type SourceField, type SourceType } from '../../api/client';
import { Button, Input, Label, Modal, cn } from '../../components/ui';

/**
 * Create or edit a connector connection (a warehouse, a SaaS application, Google Drive / Sheets). Field-authenticated
 * connectors collect their fields; Google ones offer "Connect with Google" (the server hands back the consent URL and
 * the browser comes back to the Connections page) or a pasted service-account key.
 */
export function ConnectorWizard({ open, source, connector, initial, googleConfigured, isAdmin, onClose, onSaved, onGoogleConfigured }: { open: boolean; source: SourceType | null; connector: ConnectorSummary | null; initial?: ConnectorConnection | null; googleConfigured: boolean; isAdmin: boolean; onClose: () => void; onSaved: (c: ConnectorConnection) => void; onGoogleConfigured?: () => void }) {
  const [name, setName] = useState('');
  // One-time Google OAuth client setup, inline for administrators so "Sign in with Google" works right away.
  const [googleReady, setGoogleReady] = useState(googleConfigured);
  const [setup, setSetup] = useState<{ client_id: string; client_secret: string; redirect_uri: string; busy: boolean; error: string | null }>({ client_id: '', client_secret: '', redirect_uri: '', busy: false, error: null });
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [busy, setBusy] = useState<'save' | 'google' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null);
  const [saved, setSaved] = useState<ConnectorConnection | null>(null);
  const [useServiceAccount, setUseServiceAccount] = useState(false);
  useEffect(() => {
    if (!open) return;
    setName(initial?.name ?? '');
    setValues(initial ? Object.fromEntries(Object.entries(initial.config).map(([k, v]) => [k, typeof v === 'boolean' ? v : v == null ? '' : String(v)])) : {});
    setError(null);
    setTest(null);
    setSaved(null);
    setUseServiceAccount(!!initial?.credential_fields.includes('service_account_key'));
    setGoogleReady(googleConfigured);
    if (open && isAdmin && !googleConfigured && connector?.auth.kind === 'google') {
      api.get<GoogleIntegration>('/api/admin/integrations/google').then((g) => setSetup((x) => ({ ...x, client_id: g.client_id ?? '', redirect_uri: g.redirect_uri, error: null }))).catch(() => undefined);
    }
  }, [open, initial, googleConfigured]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!connector) return null;
  const google = connector.auth.kind === 'google';
  const fields: SourceField[] = connector.auth.fields.filter((f) => !google || f.key !== 'service_account_key' || useServiceAccount);
  const body = () => ({ name: name.trim() || connector.label, values: Object.fromEntries(Object.entries(values).filter(([, v]) => v !== '')) });

  const save = async () => {
    setBusy('save');
    setError(null);
    try {
      const r = initial ? await api.patch<{ connection: ConnectorConnection }>(`/api/connector-connections/${initial.id}`, body()) : await api.post<{ connection: ConnectorConnection }>('/api/connector-connections', { connector: connector.id, ...body() });
      setSaved(r.connection);
      const t = await api.post<{ ok: boolean; message: string }>(`/api/connector-connections/${r.connection.id}/test`, {});
      setTest(t);
      onSaved({ ...r.connection, status: t.ok ? 'ok' : 'error', last_error: t.ok ? null : t.message });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  /** The server creates a pending connection and returns Google's consent URL; the callback lands on #/connections. */
  const connectGoogle = async () => {
    setBusy('google');
    setError(null);
    try {
      const r = await api.post<{ url: string; connection: ConnectorConnection }>('/api/oauth/google/start', { connector: connector.id, ...body(), ...(initial ? { connection_id: initial.id } : {}) });
      window.location.assign(r.url);
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  };
  const saveGoogleClient = async () => {
    setSetup((x) => ({ ...x, busy: true, error: null }));
    try {
      await api.put<GoogleIntegration>('/api/admin/integrations/google', { client_id: setup.client_id.trim(), client_secret: setup.client_secret.trim() || null });
      setGoogleReady(true);
      onGoogleConfigured?.();
    } catch (e) {
      setSetup((x) => ({ ...x, error: (e as Error).message }));
    } finally {
      setSetup((x) => ({ ...x, busy: false }));
    }
  };
  const required = fields.filter((f) => f.required && !(f.kind === 'secret' && initial?.credential_fields.includes(f.key)));
  const ready = required.every((f) => String(values[f.key] ?? '').trim());
  return (
    <Modal open={open} onClose={onClose} title={initial ? `Edit ${initial.name}` : `Connect ${connector.label}`} width="max-w-xl">
      <div className="space-y-3">
        {source && <p className="text-xs text-zinc-500">{source.blurb}{source.docs && <> <a href={source.docs} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-accent-300 hover:underline">Vendor docs <ExternalLink className="h-3 w-3" /></a></>}</p>}
        {saved ? (
          <div className={cn('flex items-start gap-2 rounded-lg border px-3 py-2 text-xs', test?.ok ? 'border-emerald-900/60 bg-emerald-950/30 text-emerald-200' : 'border-amber-900/60 bg-amber-950/30 text-amber-200')}>
            {test?.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />}
            <span>Saved <b>{saved.name}</b>. {test?.message ?? 'Testing…'} {test?.ok ? 'Browse it from the Syncs tab to schedule a load.' : 'Edit the connection to fix the credentials.'}</span>
          </div>
        ) : (
          <>
            <div className="grid gap-3 md:grid-cols-2">
              <div className={fields.length ? '' : 'md:col-span-2'}><Label>Name</Label><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={connector.label} /></div>
              {fields.map((f) => (
                <div key={f.key} className={cn(f.kind === 'boolean' ? 'flex items-center gap-2 pt-5' : '', f.kind === 'secret' && f.key === 'service_account_key' ? 'md:col-span-2' : '')}>
                  {f.kind === 'boolean' ? (
                    <label className="flex cursor-pointer items-center gap-2 text-xs text-zinc-300"><input type="checkbox" className="accent-accent-500" checked={!!values[f.key]} onChange={(e) => setValues({ ...values, [f.key]: e.target.checked })} /> {f.label}{f.hint && <span className="text-zinc-600"> — {f.hint}</span>}</label>
                  ) : f.key === 'service_account_key' ? (
                    <>
                      <Label>{f.label}</Label>
                      <textarea value={String(values[f.key] ?? '')} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} rows={4} spellCheck={false} placeholder={initial?.credential_fields.includes(f.key) ? 'unchanged' : '{ "type": "service_account", "client_email": "…", "private_key": "…" }'} className="w-full rounded-md border border-zinc-700 bg-zinc-900 p-2 font-mono text-2xs text-zinc-100 focus:border-accent-500 focus:outline-none" />
                      {f.hint && <p className="mt-0.5 text-2xs text-zinc-500">{f.hint}</p>}
                    </>
                  ) : (
                    <>
                      <Label>{f.label}{f.required ? '' : <span className="normal-case text-zinc-600"> (optional)</span>}</Label>
                      <Input type={f.kind === 'secret' ? 'password' : f.kind === 'number' ? 'number' : 'text'} value={String(values[f.key] ?? '')} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} placeholder={f.kind === 'secret' && initial?.credential_fields.includes(f.key) ? 'unchanged' : f.placeholder} className={f.kind === 'url' || f.kind === 'path' ? 'font-mono' : ''} autoComplete="off" spellCheck={false} />
                      {f.hint && <p className="mt-0.5 text-2xs text-zinc-500">{f.hint}</p>}
                    </>
                  )}
                </div>
              ))}
            </div>
            {google && (
              <div className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="primary" size="sm" onClick={() => void connectGoogle()} loading={busy === 'google'} disabled={!googleReady || !ready} title={googleReady ? "Opens Google's sign-in page" : 'Google sign-in needs the one-time setup below'}>
                    <GoogleMark /> {initial?.account_label ? `Reconnect ${initial.account_label}` : 'Sign in with Google'}
                  </Button>
                  <span className="text-zinc-400">You enter your Google e-mail and password <b>on Google's own page</b> (2-step verification included); DuckView never sees the password — Google hands back a read-only token for {connector.auth.scopes?.map((s) => s.replace('https://www.googleapis.com/auth/', '').replace('.readonly', '')).join(', ')}.</span>
                </div>
                {!googleReady && (
                  isAdmin ? (
                    <div className="space-y-2 rounded-md border border-amber-900/60 bg-amber-950/20 p-3">
                      <div className="flex items-center gap-1.5 font-semibold text-amber-200"><ShieldCheck className="h-3.5 w-3.5" /> One-time setup (administrator): register DuckView with Google</div>
                      <p className="text-zinc-400">Google only lets an app sign people in once it is registered — this takes two minutes and is done once for the whole server. Open <a className="text-accent-300 hover:underline" href="https://console.cloud.google.com/apis/credentials/oauthclient" target="_blank" rel="noreferrer">Google Cloud → Create OAuth client <ExternalLink className="inline h-3 w-3" /></a> (type <i>Web application</i>), add the redirect URI below, then paste the client id and secret here. Enable the Drive, Sheets, BigQuery and Analytics Data APIs for the project as needed.</p>
                      <div><Label>Authorised redirect URI</Label><code className="block select-all rounded bg-zinc-900 px-2 py-1 font-mono text-2xs text-zinc-200">{setup.redirect_uri || '…'}</code></div>
                      <div className="grid gap-2 md:grid-cols-2">
                        <div><Label>Client id</Label><Input value={setup.client_id} onChange={(e) => setSetup({ ...setup, client_id: e.target.value })} className="font-mono" placeholder="1234-abc.apps.googleusercontent.com" spellCheck={false} /></div>
                        <div><Label>Client secret</Label><Input type="password" value={setup.client_secret} onChange={(e) => setSetup({ ...setup, client_secret: e.target.value })} placeholder="GOCSPX-…" autoComplete="off" /></div>
                      </div>
                      {setup.error && <div className="rounded-md border border-red-900 bg-red-950/50 px-2 py-1 font-mono text-2xs text-red-200">{setup.error}</div>}
                      <div className="flex items-center gap-2">
                        <Button size="sm" variant="secondary" loading={setup.busy} disabled={!setup.client_id.trim() || !setup.client_secret.trim()} onClick={() => void saveGoogleClient()}><KeyRound className="h-3.5 w-3.5" /> Save & enable Google sign-in</Button>
                        <span className="text-zinc-500">The secret is stored encrypted and never shown again.</span>
                      </div>
                    </div>
                  ) : (
                    <p className="text-amber-300">Google sign-in is not enabled on this server yet — ask an administrator to register the Google OAuth client (Settings → Integrations, two minutes), or paste a service account key below.</p>
                  )
                )}
                <label className="flex cursor-pointer items-center gap-1.5 text-zinc-400"><input type="checkbox" className="accent-accent-500" checked={useServiceAccount} onChange={(e) => setUseServiceAccount(e.target.checked)} /> <KeyRound className="h-3 w-3" /> Server-to-server instead: use a service account key</label>
              </div>
            )}
            {!google && <p className="text-2xs text-zinc-500">Credentials are encrypted at rest, never shown again and never written to logs. The connection is tested right after saving.</p>}
            {error && <div className="rounded-md border border-red-900 bg-red-950/50 px-3 py-2 font-mono text-xs text-red-200">{error}</div>}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={onClose}>Cancel</Button>
              {(!google || useServiceAccount) && <Button variant="primary" loading={busy === 'save'} disabled={!ready} onClick={() => void save()}><Plug className="h-4 w-4" /> {initial ? 'Save & test' : 'Connect & test'}</Button>}
            </div>
          </>
        )}
        {saved && <div className="flex justify-end"><Button variant="primary" onClick={onClose}>Done</Button></div>}
      </div>
    </Modal>
  );
}

function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden>
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.76h3.57c2.08-1.92 3.27-4.74 3.27-8.09Z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.76c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z" />
      <path fill="#FBBC05" d="M5.84 14.11A6.6 6.6 0 0 1 5.5 12c0-.73.13-1.44.34-2.11V7.05H2.18A11 11 0 0 0 1 12c0 1.77.42 3.45 1.18 4.95l3.66-2.84Z" />
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.05l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38Z" />
    </svg>
  );
}
