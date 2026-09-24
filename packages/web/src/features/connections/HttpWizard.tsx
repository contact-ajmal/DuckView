import { useEffect, useState } from 'react';
import { Globe } from 'lucide-react';
import { api, type PublicConnection } from '../../api/client';
import { Button, Input, Label, Modal } from '../../components/ui';

/** An HTTP credential: a bearer token (optionally scoped to a URL prefix) applied to https:// reads and URL syncs. */
export function HttpWizard({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: (c: PublicConnection) => void }) {
  const [name, setName] = useState('');
  const [token, setToken] = useState('');
  const [scope, setScope] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setName('');
    setToken('');
    setScope('');
    setError(null);
  }, [open]);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ connection: PublicConnection }>('/api/connections', { name: name.trim() || 'HTTP API', type: 'HTTP', credentials: { bearer_token: token.trim(), ...(scope.trim() ? { scope: scope.trim() } : {}) } });
      onSaved(r.connection);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title="Connect an HTTP / REST endpoint" width="max-w-lg">
      <div className="space-y-3">
        <p className="text-xs text-zinc-500">A bearer token DuckDB sends with every <code className="font-mono">https://</code> read that matches the scope — CSV, JSON, Parquet or Excel exports of an API — and that URL syncs use on a schedule. Public endpoints need no connection: sync them straight from a URL.</p>
        <div><Label>Name</Label><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Billing API" /></div>
        <div><Label>Bearer token</Label><Input type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" placeholder="eyJ… / sk_…" /></div>
        <div><Label>Scope <span className="normal-case text-zinc-600">(optional URL prefix)</span></Label><Input value={scope} onChange={(e) => setScope(e.target.value)} className="font-mono" placeholder="https://api.example.com/" spellCheck={false} /><p className="mt-0.5 text-2xs text-zinc-500">Only requests to URLs starting with this prefix carry the token.</p></div>
        <p className="text-2xs text-zinc-500">Encrypted at rest, applied to your engines as a scoped <code className="font-mono">CREATE SECRET (TYPE http)</code>, never returned by the API.</p>
        {error && <div className="rounded-md border border-red-900 bg-red-950/50 px-3 py-2 font-mono text-xs text-red-200">{error}</div>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!token.trim()} onClick={() => void save()}><Globe className="h-4 w-4" /> Save</Button>
        </div>
      </div>
    </Modal>
  );
}
