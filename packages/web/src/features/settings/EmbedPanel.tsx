import { useCallback, useEffect, useState } from 'react';
import { Code2, KeyRound, Link2, Plus } from 'lucide-react';
import { api, timeAgo, type Dashboard, type NotebookSummary } from '../../api/client';
import { useWorkspaceAccess } from '../../store/workspace';
import { Button, CopyButton, Input, Label, Select, Spinner, cn } from '../../components/ui';

interface EmbedKey { id: string; name: string; allowed_origins: string[]; created_at: string; last_used_at: string | null; revoked_at: string | null }

const nodeSnippet = (kid: string) => `import crypto from 'node:crypto';

// On your server, for each page view (never in the browser):
function duckviewEmbedUrl(resource, user, attrs, params) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'HS256', typ: 'JWT', kid: '${kid}' });
  const body = b64({ res: resource, sub: user, iat: now, exp: now + 600, attrs, params });
  const sig = crypto.createHmac('sha256', process.env.DUCKVIEW_EMBED_SECRET).update(head + '.' + body).digest('base64url');
  return '${location.origin}/embed/view?token=' + head + '.' + body + '.' + sig;
}

// <iframe src={duckviewEmbedUrl('dashboard:<id>', user.email, { tenant: user.tenant })} />`;
const pySnippet = (kid: string) => `import base64, hashlib, hmac, json, os, time

def duckview_embed_url(resource, user, attrs=None, params=None):
    b64 = lambda o: base64.urlsafe_b64encode(json.dumps(o).encode()).rstrip(b"=").decode()
    now = int(time.time())
    head = b64({"alg": "HS256", "typ": "JWT", "kid": "${kid}"})
    body = b64({"res": resource, "sub": user, "iat": now, "exp": now + 600, "attrs": attrs or {}, "params": params or {}})
    sig = hmac.new(os.environ["DUCKVIEW_EMBED_SECRET"].encode(), f"{head}.{body}".encode(), hashlib.sha256).digest()
    return f"${location.origin}/embed/view?token={head}.{body}." + base64.urlsafe_b64encode(sig).rstrip(b"=").decode()`;

/** Settings › Embedding: keys that let another application show a dashboard or notebook, and a link to try one. */
export function EmbedPanel({ workspaceId }: { workspaceId: string }) {
  const { canManage } = useWorkspaceAccess();
  const [keys, setKeys] = useState<EmbedKey[] | null>(null);
  const [form, setForm] = useState({ name: '', origins: '' });
  const [created, setCreated] = useState<{ key: EmbedKey; secret: string } | null>(null);
  const [lang, setLang] = useState<'node' | 'python'>('node');
  const [dashboards, setDashboards] = useState<Dashboard[]>([]);
  const [notebooks, setNotebooks] = useState<NotebookSummary[]>([]);
  const [trial, setTrial] = useState({ key_id: '', resource: '', attrs: '{ "tenant": "acme" }', params: '{}' });
  const [link, setLink] = useState<{ url: string; expires_at: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await api.get<{ keys: EmbedKey[] }>(`/api/workspaces/${workspaceId}/embed/keys`);
    setKeys(r.keys);
    setTrial((t) => ({ ...t, key_id: t.key_id || r.keys.find((k) => !k.revoked_at)?.id || '' }));
  }, [workspaceId]);
  useEffect(() => {
    if (!canManage) return;
    void load().catch((e) => setError((e as Error).message));
    void api.get<{ dashboards: Dashboard[] }>(`/api/workspaces/${workspaceId}/dashboards`).then((r) => setDashboards(r.dashboards.filter((d) => d.kind !== 'mosaic'))).catch(() => undefined);
    void api.get<{ notebooks: NotebookSummary[] }>(`/api/workspaces/${workspaceId}/notebooks`).then((r) => setNotebooks(r.notebooks)).catch(() => undefined);
  }, [workspaceId, canManage, load]);
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

  if (!canManage) return <p className="text-xs text-zinc-500">Only the workspace owner manages embedding.</p>;
  return (
    <div className="max-w-4xl space-y-6 text-xs" data-testid="embed-panel">
      <p className="text-zinc-500">Show a dashboard or notebook inside your own application — no DuckView login for its users. Your server signs a short-lived link with a key's secret, naming what to show and who is looking; access policies that apply to <b className="text-zinc-300">embeds</b> can filter each viewer's rows with the attributes you sign (<code className="font-mono text-zinc-300">{'{{embed.tenant}}'}</code>). Mosaic dashboards cannot be embedded yet.</p>
      {error && <div className="rounded-md border border-red-900 bg-red-950/50 px-3 py-2 font-mono text-red-200">{error}</div>}

      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-zinc-100">Keys</h2>
        {keys === null ? <Spinner /> : keys.length > 0 && (
          <div className="divide-y divide-zinc-800 border-y border-zinc-800" data-testid="embed-keys">
            {keys.map((k) => (
              <div key={k.id} className={cn('flex flex-wrap items-center gap-x-4 gap-y-1 py-2', k.revoked_at && 'opacity-50')}>
                <KeyRound className="h-3.5 w-3.5 text-zinc-500" />
                <span className="font-medium text-zinc-100">{k.name}</span>
                <code className="font-mono text-zinc-400">{k.id}</code>
                <span className="text-zinc-500">{k.allowed_origins.length ? k.allowed_origins.join(', ') : 'any site may frame it'}</span>
                <span className="text-zinc-500">{k.revoked_at ? `revoked ${timeAgo(k.revoked_at)}` : k.last_used_at ? `used ${timeAgo(k.last_used_at)}` : 'not used yet'}</span>
                {!k.revoked_at && <Button size="sm" variant="ghost" className="ml-auto text-red-300" onClick={() => { if (confirm(`Revoke "${k.name}"? Every embed signed with it stops working at once.`)) void act('revoke', async () => { await api.del(`/api/embed/keys/${k.id}`); await load(); }); }}>Revoke</Button>}
              </div>
            ))}
          </div>
        )}
        <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void act('create', async () => { setCreated(await api.post<{ key: EmbedKey; secret: string }>(`/api/workspaces/${workspaceId}/embed/keys`, { name: form.name, allowed_origins: form.origins.split(/[\s,]+/).filter(Boolean) })); setForm({ name: '', origins: '' }); await load(); }); }}>
          <div className="w-52"><Label>Name</Label><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Customer portal" data-testid="embed-key-name" /></div>
          <div className="min-w-64 flex-1"><Label>Sites that may show it <span className="text-zinc-600">(origins; empty = any)</span></Label><Input className="font-mono" value={form.origins} onChange={(e) => setForm({ ...form, origins: e.target.value })} placeholder="https://app.example.com" /></div>
          <Button type="submit" variant="primary" disabled={!form.name.trim()} loading={busy === 'create'} data-testid="embed-key-create"><Plus className="h-3.5 w-3.5" /> Create key</Button>
        </form>
        {created && (
          <div className="space-y-2 rounded-md border border-amber-900/60 bg-amber-950/20 p-3" data-testid="embed-secret">
            <p className="text-amber-100">Copy the secret of <b>{created.key.name}</b> into your server's configuration now (e.g. <code className="font-mono">DUCKVIEW_EMBED_SECRET</code>) — it is not shown again.</p>
            <div className="flex items-center gap-2"><code className="break-all rounded bg-zinc-950 px-2 py-1 font-mono text-zinc-100">{created.secret}</code><CopyButton text={created.secret} /></div>
            <div className="flex items-center gap-2 pt-1"><Code2 className="h-3.5 w-3.5 text-zinc-500" /><span className="text-zinc-400">Sign links on your server:</span><Select uiSize="sm" value={lang} onChange={(e) => setLang(e.target.value as 'node' | 'python')}><option value="node">Node.js</option><option value="python">Python</option></Select><CopyButton text={lang === 'node' ? nodeSnippet(created.key.id) : pySnippet(created.key.id)} /></div>
            <pre className="max-h-64 overflow-auto rounded bg-zinc-950 p-2 font-mono text-[11px] text-zinc-300">{lang === 'node' ? nodeSnippet(created.key.id) : pySnippet(created.key.id)}</pre>
          </div>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-zinc-100">Try an embed</h2>
        <div className="grid gap-2 md:grid-cols-[180px_minmax(0,1fr)]">
          <div><Label>Key</Label><Select value={trial.key_id} onChange={(e) => setTrial({ ...trial, key_id: e.target.value })} className="w-full"><option value="">Choose…</option>{(keys ?? []).filter((k) => !k.revoked_at).map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}</Select></div>
          <div><Label>Show</Label><Select value={trial.resource} onChange={(e) => setTrial({ ...trial, resource: e.target.value })} className="w-full" data-testid="embed-resource"><option value="">Choose a dashboard or notebook…</option><optgroup label="Dashboards">{dashboards.map((d) => <option key={d.id} value={`dashboard:${d.id}`}>{d.name}</option>)}</optgroup><optgroup label="Notebooks">{notebooks.map((n) => <option key={n.id} value={`notebook:${n.id}`}>{n.title}</option>)}</optgroup></Select></div>
          <div><Label>Attributes <span className="text-zinc-600">(JSON)</span></Label><Input className="font-mono" value={trial.attrs} onChange={(e) => setTrial({ ...trial, attrs: e.target.value })} /></div>
          <div><Label>Notebook inputs <span className="text-zinc-600">(JSON)</span></Label><Input className="font-mono" value={trial.params} onChange={(e) => setTrial({ ...trial, params: e.target.value })} /></div>
        </div>
        <Button disabled={!trial.key_id || !trial.resource} loading={busy === 'sign'} data-testid="embed-sign" onClick={() => void act('sign', async () => {
          const [type, id] = trial.resource.split(':');
          const parse = (s: string, what: string) => { try { return s.trim() ? JSON.parse(s) : undefined; } catch { throw new Error(`${what} is not JSON`); } };
          setLink(await api.post<{ url: string; expires_at: string }>(`/api/workspaces/${workspaceId}/embed/sign`, { key_id: trial.key_id, resource_type: type, resource_id: id, attrs: parse(trial.attrs, 'Attributes'), params: parse(trial.params, 'Inputs'), expires_in: 3600 }));
        })}><Link2 className="h-3.5 w-3.5" /> Get a link (1 hour)</Button>
        {link && (
          <div className="space-y-2" data-testid="embed-link">
            {(() => { const u = link.url.startsWith('/') ? `${location.origin}${link.url}` : link.url; const iframe = `<iframe src="${u}" width="100%" height="600" style="border:0"></iframe>`; return (<>
              <div className="flex items-center gap-2"><code className="min-w-0 flex-1 truncate rounded bg-zinc-950 px-2 py-1 font-mono text-zinc-300" title={u}>{u}</code><CopyButton text={u} /></div>
              <div className="flex items-center gap-2"><code className="min-w-0 flex-1 truncate rounded bg-zinc-950 px-2 py-1 font-mono text-zinc-400">{iframe}</code><CopyButton text={iframe} /></div>
              <iframe title="Embed preview" src={u} className="h-[420px] w-full rounded-md border border-zinc-800 bg-white" data-testid="embed-preview" />
            </>); })()}
            <p className="text-zinc-500">Expires {new Date(link.expires_at).toLocaleString()}.</p>
          </div>
        )}
      </section>
    </div>
  );
}
