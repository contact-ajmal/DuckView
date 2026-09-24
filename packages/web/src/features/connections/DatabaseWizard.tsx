import { useEffect, useState } from 'react';
import { Database, CheckCircle2, AlertTriangle, ExternalLink } from 'lucide-react';
import { api, type DatabaseConnection, type DatabaseEngine, type SourceType } from '../../api/client';
import { Button, Input, Label, Modal, cn } from '../../components/ui';

/** Create or edit a database connection (PostgreSQL, MySQL, SQLite file, DuckDB file) from its catalog entry. */
export function DatabaseWizard({ open, source, initial, onClose, onSaved }: { open: boolean; source: SourceType | null; initial?: DatabaseConnection | null; onClose: () => void; onSaved: (c: DatabaseConnection) => void }) {
  const engine = (initial?.engine ?? (source?.backend.family === 'database' ? source.backend.engine : 'postgres')) as DatabaseEngine;
  const [name, setName] = useState('');
  const [alias, setAlias] = useState('');
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null);
  const [saved, setSaved] = useState<DatabaseConnection | null>(null);
  useEffect(() => {
    if (!open) return;
    setName(initial?.name ?? '');
    setAlias(initial?.alias ?? '');
    setValues(initial ? { ...(initial.config as Record<string, string | boolean>), read_only: initial.config.read_only !== false } : { read_only: true });
    setError(null);
    setTest(null);
    setSaved(null);
  }, [open, initial]);
  const fields = source?.fields ?? [];
  const suggestedAlias = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30) || engine;
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const config = { host: str(values.host), port: values.port ? Number(values.port) : undefined, database: str(values.database), user: str(values.user), ssl: !!values.ssl, path: str(values.path), read_only: values.read_only !== false };
      const body = { name, engine, alias: alias || undefined, config, password: str(values.password) || null };
      const r = initial ? await api.patch<{ connection: DatabaseConnection }>(`/api/database-connections/${initial.id}`, { name, alias: alias || undefined, config, password: str(values.password) || null }) : await api.post<{ connection: DatabaseConnection }>('/api/database-connections', body);
      setSaved(r.connection);
      const t = await api.post<{ ok: boolean; message: string }>(`/api/database-connections/${r.connection.id}/test`, {});
      setTest(t);
      onSaved({ ...r.connection, status: t.ok ? 'ok' : 'error', last_error: t.ok ? null : t.message });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title={initial ? `Edit ${initial.name}` : `Connect ${source?.label ?? 'a database'}`} width="max-w-xl">
      <div className="space-y-3">
        {source && <p className="text-xs text-zinc-500">{source.blurb}{source.docs && <> <a href={source.docs} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-accent-300 hover:underline">DuckDB docs <ExternalLink className="h-3 w-3" /></a></>}</p>}
        {saved ? (
          <div className={cn('flex items-start gap-2 rounded-lg border px-3 py-2 text-xs', test?.ok ? 'border-emerald-900/60 bg-emerald-950/30 text-emerald-200' : 'border-amber-900/60 bg-amber-950/30 text-amber-200')}>
            {test?.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />}
            <span>Saved as <code className="font-mono">{saved.alias}</code>. {test?.message ?? 'Testing…'} Query it as <code className="font-mono">{saved.example_sql}</code>.</span>
          </div>
        ) : (
          <>
            <div className="grid gap-3 md:grid-cols-2">
              <div><Label>Name</Label><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Production Postgres" /></div>
              <div><Label>Alias <span className="normal-case text-zinc-600">(SQL prefix)</span></Label><Input value={alias} onChange={(e) => setAlias(e.target.value)} className="font-mono" placeholder={suggestedAlias} /></div>
              {fields.map((f) => (
                <div key={f.key} className={f.kind === 'boolean' ? 'flex items-center gap-2 pt-5' : ''}>
                  {f.kind === 'boolean' ? (
                    <label className="flex cursor-pointer items-center gap-2 text-xs text-zinc-300"><input type="checkbox" className="accent-accent-500" checked={values[f.key] !== false && values[f.key] !== undefined ? !!values[f.key] : false} onChange={(e) => setValues({ ...values, [f.key]: e.target.checked })} /> {f.label}{f.hint && <span className="text-zinc-600"> — {f.hint}</span>}</label>
                  ) : (
                    <>
                      <Label>{f.label}{f.required ? '' : <span className="normal-case text-zinc-600"> (optional)</span>}</Label>
                      <Input type={f.kind === 'secret' ? 'password' : f.kind === 'number' ? 'number' : 'text'} value={String(values[f.key] ?? '')} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} placeholder={f.kind === 'secret' && initial?.has_password ? 'unchanged' : f.placeholder} className={f.kind === 'path' || f.kind === 'url' ? 'font-mono' : ''} autoComplete="off" />
                      {f.hint && <p className="mt-0.5 text-2xs text-zinc-500">{f.hint}</p>}
                    </>
                  )}
                </div>
              ))}
            </div>
            {error && <div className="rounded-md border border-red-900 bg-red-950/50 px-3 py-2 font-mono text-xs text-red-200">{error}</div>}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={onClose}>Cancel</Button>
              <Button variant="primary" loading={busy} disabled={!name.trim()} onClick={() => void save()}><Database className="h-4 w-4" /> {initial ? 'Save & test' : 'Connect & test'}</Button>
            </div>
          </>
        )}
        {saved && <div className="flex justify-end"><Button variant="primary" onClick={onClose}>Done</Button></div>}
      </div>
    </Modal>
  );
}
const str = (v: string | boolean | undefined) => (typeof v === 'string' ? v.trim() || undefined : undefined);
