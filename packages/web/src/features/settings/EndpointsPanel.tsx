/**
 * Settings → This workspace → Query APIs: SELECTs published at GET /q/<slug> for other systems. Parameters come
 * from {{name}} placeholders and are typed; each endpoint has a key (shown once) unless it is public. The SQL
 * workbench's "Publish as an API…" opens the form with the tab's SQL.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { KeyRound, Plus, Trash2, Webhook } from 'lucide-react';
import { api, timeAgo } from '../../api/client';
import { DataTable } from '../../components/data';
import { Button, CopyButton, Field, IconButton, Input, Modal, Select, StatusDot, Switch, Textarea, confirmAction, toast, errorText } from '../../components/ui';

type ParamType = 'string' | 'number' | 'integer' | 'boolean' | 'date';
interface Param { name: string; type: ParamType; required: boolean; default: string | null }
interface Endpoint { id: string; name: string; slug: string; description: string | null; sql: string; params: Param[]; public: boolean; has_key: boolean; key_hint: string | null; max_rows: number; rate_per_minute: number; enabled: boolean; calls: number; last_called_at: string | null; url: string }
interface Draft { name: string; slug: string; sql: string; params: Param[]; public: boolean; rate: string; maxRows: string }

const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
const namesIn = (sql: string) => [...new Set([...sql.matchAll(PLACEHOLDER)].map((m) => m[1]!))];
export const ENDPOINT_DRAFT_KEY = 'duckview.endpointDraft';

function curlFor(e: Pick<Endpoint, 'url' | 'params' | 'public'>, key: string | null) {
  const origin = e.url.startsWith('http') ? '' : location.origin;
  const qs = e.params.filter((p) => p.required).map((p) => `${p.name}=${p.type === 'date' ? '2026-01-31' : p.type === 'string' ? 'value' : '1'}`).join('&');
  return `curl ${e.public ? '' : `-H "Authorization: Bearer ${key ?? '<key>'}" `}"${origin}${e.url}${qs ? `?${qs}` : ''}"`;
}

export function EndpointsPanel({ workspaceId, canEdit }: { workspaceId: string; canEdit: boolean }) {
  const [endpoints, setEndpoints] = useState<Endpoint[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [issued, setIssued] = useState<{ endpoint: Endpoint; key: string | null } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setEndpoints((await api.get<{ endpoints: Endpoint[] }>(`/api/workspaces/${workspaceId}/endpoints`)).endpoints);
    } catch (e) {
      setError(e);
    }
  }, [workspaceId]);
  useEffect(() => void load(), [load]);
  // Opened from the SQL workbench with the tab's SQL. The draft stays stored until the form closes, so a remount
  // while the page settles opens it again.
  useEffect(() => {
    try {
      const sql = sessionStorage.getItem(ENDPOINT_DRAFT_KEY);
      if (sql && canEdit) startDraft(sql);
    } catch {
      /* storage unavailable */
    }
  }, [canEdit]); // eslint-disable-line react-hooks/exhaustive-deps
  const closeDraft = () => {
    setDraft(null);
    try {
      sessionStorage.removeItem(ENDPOINT_DRAFT_KEY);
    } catch {
      /* storage unavailable */
    }
  };

  const startDraft = (sql = '') => setDraft({ name: '', slug: '', sql, params: namesIn(sql).map((n) => ({ name: n, type: 'string', required: true, default: null })), public: false, rate: '60', maxRows: '1000' });
  const setSql = (sql: string) => setDraft((d) => (d ? { ...d, sql, params: namesIn(sql).map((n) => d.params.find((p) => p.name === n) ?? { name: n, type: 'string', required: true, default: null }) } : d));
  const setParam = (name: string, patch: Partial<Param>) => setDraft((d) => (d ? { ...d, params: d.params.map((p) => (p.name === name ? { ...p, ...patch } : p)) } : d));
  const invalid = useMemo(() => (!draft ? null : !draft.name.trim() ? 'Name the endpoint' : !draft.sql.trim() ? 'Write the SELECT it answers with' : !(Number(draft.rate) >= 1) ? 'Allow at least 1 call a minute' : !(Number(draft.maxRows) >= 1) ? 'Return at least 1 row' : null), [draft]);

  const publish = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      const r = await api.post<{ endpoint: Endpoint; key: string | null }>(`/api/workspaces/${workspaceId}/endpoints`, { name: draft.name.trim(), slug: draft.slug.trim() || undefined, sql: draft.sql, params: draft.params.map((p) => ({ ...p, default: p.default?.trim() ? p.default.trim() : null })), public: draft.public, rate_per_minute: Number(draft.rate), max_rows: Number(draft.maxRows) });
      closeDraft();
      setIssued(r);
      await load();
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const rotate = async (e: Endpoint) => {
    if (!(await confirmAction(`Issue a new key for ${e.name}? The current key stops working at once.`, { confirmLabel: 'Issue a new key' }))) return;
    try {
      const r = await api.post<{ key: string }>(`/api/endpoints/${e.id}/rotate-key`, {});
      setIssued({ endpoint: { ...e, public: false }, key: r.key });
      await load();
    } catch (err) {
      toast.error(errorText(err));
    }
  };

  return (
    <section className="space-y-3" data-testid="endpoints">
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 text-xs text-zinc-500">Give other systems a read-only JSON or CSV answer at a stable address. Calls run as the person who published, under their access policies.</p>
        {canEdit && <Button size="sm" variant="primary" onClick={() => startDraft()} data-testid="endpoint-new"><Plus className="h-3.5 w-3.5" /> Publish a query</Button>}
      </div>
      <DataTable
        label="Query APIs"
        testid="endpoint-list"
        rows={endpoints}
        error={error}
        onRetry={() => void load()}
        rowKey={(e) => e.id}
        rowProps={(e) => ({ 'data-slug': e.slug })}
        empty="No query is published yet."
        columns={[
          { key: 'name', header: 'Name', cell: (e) => <span className="text-zinc-100">{e.name}</span> },
          { key: 'url', header: 'Address', truncate: true, cell: (e) => <span className="font-mono text-xs">{`/q/${e.slug}`}{e.params.length ? `?${e.params.map((p) => `${p.name}=`).join('&')}` : ''}</span> },
          { key: 'access', header: 'Access', cell: (e) => (e.public ? <StatusDot tone="warn">Public</StatusDot> : <StatusDot tone="ok">Key …{e.key_hint}</StatusDot>) },
          { key: 'calls', header: 'Calls', align: 'right', numeric: true, cell: (e) => e.calls.toLocaleString() },
          { key: 'last', header: 'Last call', cell: (e) => (e.last_called_at ? timeAgo(e.last_called_at) : '—') },
          {
            key: 'x',
            header: '',
            align: 'right',
            cell: (e) => (
              <span className="inline-flex gap-0.5">
                <CopyButton text={curlFor(e, null)} label="Copy a curl example" />
                {canEdit && <IconButton label={`Issue a new key for ${e.name}`} onClick={() => void rotate(e)}><KeyRound className="h-3.5 w-3.5" /></IconButton>}
                {canEdit && <IconButton label={`Unpublish ${e.name}`} onClick={() => void confirmAction(`Unpublish ${e.name}? Callers get 404 from then on.`, { confirmLabel: 'Unpublish' }).then(async (ok) => { if (ok) { await api.del(`/api/endpoints/${e.id}`); await load(); } })}><Trash2 className="h-3.5 w-3.5" /></IconButton>}
              </span>
            ),
          },
        ]}
      />

      <Modal open={draft !== null} onClose={closeDraft} title="Publish a query" width="max-w-2xl">
        {draft && (
          <div className="space-y-4" data-testid="endpoint-form">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Name" htmlFor="ep-name"><Input id="ep-name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Sales by region" data-testid="endpoint-name" /></Field>
              <Field label="Address" hint={`/q/${(draft.slug || draft.name).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || '…'}`} htmlFor="ep-slug"><Input id="ep-slug" value={draft.slug} onChange={(e) => setDraft({ ...draft, slug: e.target.value })} placeholder="from the name" className="font-mono" /></Field>
            </div>
            <Field label="SELECT" hint="Parameters are {{name}} placeholders, e.g. WHERE region = {{region}}." htmlFor="ep-sql"><Textarea id="ep-sql" mono rows={6} value={draft.sql} onChange={(e) => setSql(e.target.value)} data-testid="endpoint-sql" /></Field>
            {draft.params.length > 0 && (
              <div>
                <div className="mb-1 text-xs font-medium text-zinc-400">Parameters</div>
                <ul className="divide-y divide-zinc-800/70 border-y border-zinc-800/70">
                  {draft.params.map((p) => (
                    <li key={p.name} className="grid grid-cols-[8rem_8rem_1fr_auto] items-center gap-2 py-1.5">
                      <code className="font-mono text-xs text-zinc-200">{p.name}</code>
                      <Select uiSize="sm" aria-label={`Type of ${p.name}`} value={p.type} onChange={(e) => setParam(p.name, { type: e.target.value as ParamType })}>
                        {(['string', 'number', 'integer', 'boolean', 'date'] as const).map((t) => <option key={t} value={t}>{t}</option>)}
                      </Select>
                      <Input uiSize="sm" aria-label={`Default for ${p.name}`} value={p.default ?? ''} onChange={(e) => setParam(p.name, { default: e.target.value })} placeholder="No default" />
                      <Switch checked={p.required} onChange={(on) => setParam(p.name, { required: on })} label="Required" />
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Calls a minute, at most" htmlFor="ep-rate"><Input id="ep-rate" inputMode="numeric" value={draft.rate} onChange={(e) => setDraft({ ...draft, rate: e.target.value })} /></Field>
              <Field label="Rows, at most" htmlFor="ep-rows"><Input id="ep-rows" inputMode="numeric" value={draft.maxRows} onChange={(e) => setDraft({ ...draft, maxRows: e.target.value })} /></Field>
              <div className="flex items-end pb-1.5"><Switch checked={draft.public} onChange={(on) => setDraft({ ...draft, public: on })} label="Public (no key)" /></div>
            </div>
            {draft.public && <p className="text-xs text-amber-300">Anyone who knows the address can read what this query returns.</p>}
            <div className="flex items-center justify-end gap-2">
              <span className="min-w-0 flex-1 text-xs text-zinc-500">{invalid}</span>
              <Button variant="ghost" onClick={closeDraft}>Cancel</Button>
              <Button variant="primary" disabled={!!invalid} loading={busy} onClick={() => void publish()} data-testid="endpoint-publish"><Webhook className="h-3.5 w-3.5" /> Publish</Button>
            </div>
          </div>
        )}
      </Modal>

      <Modal open={issued !== null} onClose={() => { setIssued(null); void load(); }} title={issued?.key ? 'Copy the key now' : 'Published'} width="max-w-2xl">
        {issued && (
          <div className="space-y-3" data-testid="endpoint-issued">
            <p className="text-body text-zinc-300"><span className="font-medium text-zinc-100">{issued.endpoint.name}</span> answers at <code className="font-mono">{issued.endpoint.url.startsWith('http') ? issued.endpoint.url : `${location.origin}${issued.endpoint.url}`}</code>.</p>
            {issued.key && (
              <div>
                <div className="mb-1 text-xs text-zinc-400">Key — shown only now. Send it as <code className="font-mono">Authorization: Bearer …</code>.</div>
                <div className="flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2"><code className="min-w-0 flex-1 break-all font-mono text-xs text-zinc-100" data-testid="endpoint-key">{issued.key}</code><CopyButton text={issued.key} label="Copy the key" /></div>
              </div>
            )}
            <div>
              <div className="mb-1 text-xs text-zinc-400">Try it</div>
              <div className="flex items-start gap-2 rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2"><code className="min-w-0 flex-1 break-all font-mono text-xs text-zinc-300">{curlFor(issued.endpoint, issued.key)}</code><CopyButton text={curlFor(issued.endpoint, issued.key)} label="Copy" /></div>
            </div>
            <div className="flex justify-end"><Button variant="primary" onClick={() => { setIssued(null); void load(); }}>Done</Button></div>
          </div>
        )}
      </Modal>
    </section>
  );
}
