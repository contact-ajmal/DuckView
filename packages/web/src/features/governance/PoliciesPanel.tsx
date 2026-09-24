import { ResultPreview } from '../../components/data';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { EyeOff, Filter, Pencil, Plus, ShieldCheck, Trash2, UserSearch } from 'lucide-react';
import { api, timeAgo, type AccessPolicy, type CatalogObject, type ColumnMask, type MaskKind, type MyRestrictions, type WorkspaceMember } from '../../api/client';
import { Badge, Button, Empty, Input, Label, Modal, Select, cn, confirmAction } from '../../components/ui';

const MASKS: { id: MaskKind | ''; label: string; example: string }[] = [
  { id: '', label: 'visible', example: 'ana@acme.com' },
  { id: 'partial', label: 'last 4 only', example: '••••••••.com' },
  { id: 'redact', label: 'redacted', example: '••••' },
  { id: 'hash', label: 'hashed', example: 'md5 of the value' },
  { id: 'null', label: 'hidden (null)', example: 'NULL' },
  { id: 'expression', label: 'expression…', example: 'your SQL' },
];

interface Draft { id: string | null; name: string; description: string; table: string; filter: string; masks: Record<string, ColumnMask>; roles: ('VIEWER' | 'EDITOR')[]; users: string[]; groups: string[]; all: boolean; embeds: boolean }
const blank = (): Draft => ({ id: null, name: '', description: '', table: '', filter: '', masks: {}, roles: ['VIEWER'], users: [], groups: [], all: false, embeds: false });

/** Governance → Access policies: who sees which rows and columns of a workspace's tables (owners manage them). */
export function PoliciesPanel({ workspaceId, isOwner }: { workspaceId: string; isOwner: boolean }) {
  const [policies, setPolicies] = useState<AccessPolicy[]>([]);
  const [mine, setMine] = useState<MyRestrictions | null>(null);
  const [objects, setObjects] = useState<CatalogObject[]>([]);
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [preview, setPreview] = useState<{ user: string; sql: string; result: { sql: string; columns: { name: string }[]; rows: unknown[][]; restricted: boolean } | null } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setMine(await api.get<MyRestrictions>(`/api/workspaces/${workspaceId}/policies/mine`));
    if (!isOwner) return;
    const [p, c, m] = await Promise.all([
      api.get<{ policies: AccessPolicy[] }>(`/api/workspaces/${workspaceId}/policies`),
      api.get<{ objects: CatalogObject[] }>(`/api/workspaces/${workspaceId}/catalog`),
      api.get<{ members: WorkspaceMember[] }>(`/api/workspaces/${workspaceId}/members`),
    ]);
    setPolicies(p.policies);
    setObjects(c.objects.filter((o) => !o.name.startsWith('duckview_mosaic')));
    setMembers(m.members);
  }, [workspaceId, isOwner]);
  useEffect(() => void load().catch((e) => setError((e as Error).message)), [load]);
  const tableName = (o: CatalogObject) => (o.schema === 'main' ? o.name : `${o.schema}.${o.name}`);
  const columns = useMemo(() => objects.find((o) => tableName(o) === draft?.table)?.columns ?? [], [objects, draft?.table]);
  const userMembers = members.filter((m) => m.subject_type === 'user' && m.role !== 'OWNER');
  const groupMembers = members.filter((m) => m.subject_type === 'group');
  const nameOf = (id: string) => members.find((m) => m.subject_id === id)?.email ?? members.find((m) => m.subject_id === id)?.name ?? id.slice(0, 8);

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
  const save = () => act('save', async () => {
    if (!draft) return;
    const body = { name: draft.name.trim() || undefined, description: draft.description.trim() || null, table_name: draft.table, row_filter: draft.filter.trim() || null, column_masks: draft.masks, applies_to: draft.all ? { all: true } : { roles: draft.roles, users: draft.users, groups: draft.groups, ...(draft.embeds ? { embeds: true } : {}) } };
    if (draft.id) await api.patch(`/api/policies/${draft.id}`, body);
    else await api.post(`/api/workspaces/${workspaceId}/policies`, body);
    setDraft(null);
  });
  const subjects = (p: AccessPolicy) => (p.applies_to.all ? 'everyone but owners' : [...(p.applies_to.embeds ? ['embeds'] : []), ...(p.applies_to.roles ?? []).map((r) => `${r.toLowerCase()}s`), ...(p.applies_to.users ?? []).map(nameOf), ...(p.applies_to.groups ?? []).map((g) => `team ${nameOf(g)}`)].join(', '));

  if (!isOwner) {
    return (
      <div className="space-y-3 text-xs">
        <p className="text-zinc-500">The owners of this workspace decide who sees which rows and columns. What applies to you:</p>
        {!mine ? <p className="text-zinc-500">Loading…</p> : !mine.restricted ? <div className="rounded-lg border border-zinc-800 p-4 text-zinc-300">No access policy applies to you here — you see every row and column your role allows.</div> : (
          <div className="space-y-2">{mine.tables.map((t) => (
            <div key={`${t.table}:${t.name}`} className="rounded-lg border border-zinc-800 p-3">
              <div className="flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-accent-300" /><span className="font-mono text-zinc-100">{t.table}</span><span className="text-zinc-500">· {t.name}</span></div>
              {t.description && <p className="mt-1 text-zinc-400">{t.description}</p>}
              <p className="mt-1 text-zinc-500">{t.rows_filtered ? 'You see some of its rows.' : 'You see all of its rows.'}{t.masked_columns.length ? ` Masked for you: ${t.masked_columns.join(', ')}.` : ''}</p>
            </div>
          ))}<p className="text-2xs text-zinc-500">Under a policy you can run SELECT queries only, on tables (not data files or views over protected tables).</p></div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-zinc-500">Row filters and column masks per table, for viewers, editors, people or teams — enforced on every query, dashboard, app, alert, export and agent call. Owners always see everything.</p>
        <div className="flex gap-1">
          <Button size="sm" variant="secondary" disabled={!userMembers.length} onClick={() => setPreview({ user: userMembers[0]?.subject_id ?? '', sql: `SELECT * FROM ${policies[0]?.table_name ?? tableName(objects[0] ?? { schema: 'main', name: 'my_table' } as CatalogObject)} LIMIT 20`, result: null })}><UserSearch className="h-3.5 w-3.5" /> Preview as…</Button>
          <Button size="sm" variant="primary" onClick={() => setDraft(blank())}><Plus className="h-3.5 w-3.5" /> New policy</Button>
        </div>
      </div>
      {error && !draft && <div className="rounded-md border border-red-900 bg-red-950/50 px-3 py-2 font-mono text-xs text-red-200">{error}</div>}
      {policies.length === 0 ? (
        <div className="border-y border-zinc-800 py-12"><Empty icon={<ShieldCheck className="h-10 w-10" />} title="No access policies" hint="“Viewers see their own region's customers, with emails masked” — a table, a filter using {{user.email}} or {{user.groups}}, and the columns to mask." /></div>
      ) : (
        <div className="space-y-2">
          {policies.map((p) => (
            <div key={p.id} className={cn('rounded-lg border border-zinc-800 p-3 text-xs', !p.enabled && 'opacity-60')}>
              <div className="flex flex-wrap items-center gap-2">
                <ShieldCheck className="h-4 w-4 text-accent-300" />
                <span className="text-body font-semibold text-zinc-100">{p.name}</span>
                <span className="font-mono text-zinc-400">{p.table_name}</span>
                {!p.enabled && <Badge>off</Badge>}
                <span className="ml-auto text-2xs text-zinc-500">for {subjects(p)} · {timeAgo(p.updated_at)}</span>
              </div>
              {p.description && <p className="mt-1 text-zinc-400">{p.description}</p>}
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {p.row_filter && <span className="inline-flex items-center gap-1 rounded border border-zinc-800 px-1.5 py-0.5 font-mono text-2xs text-zinc-300"><Filter className="h-3 w-3" /> {p.row_filter}</span>}
                {Object.entries(p.column_masks).map(([c, m]) => <span key={c} className="inline-flex items-center gap-1 rounded border border-zinc-800 px-1.5 py-0.5 text-2xs text-zinc-300"><EyeOff className="h-3 w-3" /> {c}: {m.kind}</span>)}
              </div>
              <div className="mt-2 flex items-center gap-1">
                <Button size="sm" variant="ghost" onClick={() => setDraft({ id: p.id, name: p.name, description: p.description ?? '', table: p.table_name, filter: p.row_filter ?? '', masks: p.column_masks, roles: p.applies_to.roles ?? [], users: p.applies_to.users ?? [], groups: p.applies_to.groups ?? [], all: !!p.applies_to.all, embeds: !!p.applies_to.embeds })}><Pencil className="h-3.5 w-3.5" /> Edit</Button>
                <Button size="sm" variant="ghost" onClick={() => void act(`t:${p.id}`, () => api.patch(`/api/policies/${p.id}`, { enabled: !p.enabled }))}>{p.enabled ? 'Turn off' : 'Turn on'}</Button>
                <Button size="sm" variant="ghost" className="ml-auto text-red-300" onClick={async () => { if ((await confirmAction(`Delete the policy "${p.name}"? The people it restricts will see the whole table.`))) void act(`d:${p.id}`, () => api.del(`/api/policies/${p.id}`)); }}><Trash2 className="h-3.5 w-3.5" /></Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal open={!!draft} onClose={() => setDraft(null)} title={draft?.id ? 'Edit access policy' : 'New access policy'} width="max-w-2xl">
        {draft && (
          <div className="space-y-3 text-xs">
            <div className="grid gap-3 md:grid-cols-2">
              <div><Label>Table</Label><Select className="w-full" value={draft.table} onChange={(e) => setDraft({ ...draft, table: e.target.value, masks: {} })}><option value="">Pick a table…</option>{objects.map((o) => <option key={`${o.schema}.${o.name}`} value={tableName(o)}>{tableName(o)} {o.type === 'VIEW' ? '(view)' : ''}</option>)}</Select></div>
              <div><Label>Name</Label><Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="EU sales only" /></div>
            </div>
            <div><Label>Row filter <span className="normal-case text-zinc-600">(SQL; empty: every row)</span></Label><textarea value={draft.filter} onChange={(e) => setDraft({ ...draft, filter: e.target.value })} rows={2} spellCheck={false} placeholder="region = 'EU'  ·  owner_email = {{user.email}}  ·  list_contains({{user.groups}}, team)" className="w-full rounded-md border border-zinc-800 bg-zinc-950 p-2 font-mono text-xs text-zinc-200 focus:border-accent-500 focus:outline-none" /><p className="mt-0.5 text-2xs text-zinc-500">Placeholders: <code>{'{{user.email}}'}</code> <code>{'{{user.id}}'}</code> <code>{'{{user.role}}'}</code> <code>{'{{user.groups}}'}</code> (a list of team names).</p></div>
            {columns.length > 0 && (
              <div>
                <Label>Columns</Label>
                <div className="grid max-h-56 gap-1 overflow-auto rounded-md border border-zinc-800 p-2 md:grid-cols-2">
                  {columns.map((c) => {
                    const m = draft.masks[c.name];
                    return (
                      <div key={c.name} className="flex items-center gap-2">
                        <span className="w-32 truncate font-mono text-zinc-300" title={c.type}>{c.name}</span>
                        <Select className="h-7 flex-1 py-0 text-2xs" value={m?.kind ?? ''} onChange={(e) => { const k = e.target.value as MaskKind | ''; const next = { ...draft.masks }; if (!k) delete next[c.name]; else next[c.name] = k === 'expression' ? { kind: 'expression', sql: `left(CAST("${c.name}" AS VARCHAR), 1) || '…'` } : { kind: k }; setDraft({ ...draft, masks: next }); }}>{MASKS.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</Select>
                        {m?.kind === 'expression' && <Input className="h-7 w-40 font-mono text-2xs" value={m.sql} onChange={(e) => setDraft({ ...draft, masks: { ...draft.masks, [c.name]: { kind: 'expression', sql: e.target.value } } })} />}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            <div>
              <Label>Applies to</Label>
              <label className="mr-3 inline-flex items-center gap-1.5 text-zinc-300"><input type="checkbox" className="accent-accent-500" checked={draft.all} onChange={(e) => setDraft({ ...draft, all: e.target.checked })} /> everyone but the owners</label>
              {!draft.all && <label className="mr-3 inline-flex items-center gap-1.5 text-zinc-300" title="Viewers of signed embeds; use {{embed.<attribute>}} in the row filter"><input type="checkbox" className="accent-accent-500" checked={draft.embeds} onChange={(e) => setDraft({ ...draft, embeds: e.target.checked })} /> embeds</label>}
              {!draft.all && (
                <div className="mt-1 space-y-1.5">
                  <div className="flex gap-3">{(['VIEWER', 'EDITOR'] as const).map((r) => <label key={r} className="inline-flex items-center gap-1.5 text-zinc-300"><input type="checkbox" className="accent-accent-500" checked={draft.roles.includes(r)} onChange={(e) => setDraft({ ...draft, roles: e.target.checked ? [...draft.roles, r] : draft.roles.filter((x) => x !== r) })} /> {r.toLowerCase()}s</label>)}</div>
                  {userMembers.length > 0 && <div className="flex flex-wrap gap-1">{userMembers.map((m) => <label key={m.subject_id} className={cn('inline-flex cursor-pointer items-center gap-1 rounded border px-1.5 py-0.5', draft.users.includes(m.subject_id) ? 'border-accent-500 text-zinc-100' : 'border-zinc-800 text-zinc-400')}><input type="checkbox" className="accent-accent-500" checked={draft.users.includes(m.subject_id)} onChange={(e) => setDraft({ ...draft, users: e.target.checked ? [...draft.users, m.subject_id] : draft.users.filter((x) => x !== m.subject_id) })} />{m.email ?? m.name}</label>)}</div>}
                  {groupMembers.length > 0 && <div className="flex flex-wrap gap-1">{groupMembers.map((m) => <label key={m.subject_id} className={cn('inline-flex cursor-pointer items-center gap-1 rounded border px-1.5 py-0.5', draft.groups.includes(m.subject_id) ? 'border-accent-500 text-zinc-100' : 'border-zinc-800 text-zinc-400')}><input type="checkbox" className="accent-accent-500" checked={draft.groups.includes(m.subject_id)} onChange={(e) => setDraft({ ...draft, groups: e.target.checked ? [...draft.groups, m.subject_id] : draft.groups.filter((x) => x !== m.subject_id) })} />team {m.name}</label>)}</div>}
                </div>
              )}
            </div>
            <div><Label>Description <span className="normal-case text-zinc-600">(shown to the people it restricts)</span></Label><Input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} placeholder="Customer PII is limited to your own region" /></div>
            {error && <div className="rounded-md border border-red-900 bg-red-950/50 px-3 py-2 font-mono text-red-200">{error}</div>}
            <div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => setDraft(null)}>Cancel</Button><Button variant="primary" loading={busy === 'save'} disabled={!draft.table || (!draft.filter.trim() && !Object.keys(draft.masks).length)} onClick={() => void save()}>{draft.id ? 'Save' : 'Create policy'}</Button></div>
          </div>
        )}
      </Modal>

      <Modal open={!!preview} onClose={() => setPreview(null)} title="Preview as a member" width="max-w-3xl">
        {preview && (
          <div className="space-y-2 text-xs">
            <div className="flex items-end gap-2">
              <div><Label>As</Label><Select value={preview.user} onChange={(e) => setPreview({ ...preview, user: e.target.value, result: null })}>{userMembers.map((m) => <option key={m.subject_id} value={m.subject_id}>{m.email ?? m.name} ({m.role.toLowerCase()})</option>)}</Select></div>
              <div className="flex-1"><Label>Query</Label><Input className="font-mono" value={preview.sql} onChange={(e) => setPreview({ ...preview, sql: e.target.value })} /></div>
              <Button variant="primary" size="sm" loading={busy === 'preview'} onClick={() => void act('preview', async () => setPreview({ ...preview, result: await api.post(`/api/workspaces/${workspaceId}/policies/preview`, { sql: preview.sql, as_user_id: preview.user }) }))}>Run</Button>
            </div>
            {error && <div className="rounded-md border border-red-900 bg-red-950/50 px-3 py-2 font-mono text-red-200">{error}</div>}
            {preview.result && (
              <>
                <p className="text-zinc-500">{preview.result.restricted ? 'Policies apply — the query ran as:' : 'No policy applies to this member.'}</p>
                {preview.result.restricted && <pre className="max-h-24 overflow-auto whitespace-pre-wrap rounded bg-zinc-950 p-2 font-mono text-2xs text-zinc-400">{preview.result.sql}</pre>}
                <ResultPreview maxHeight="max-h-72" label="What this member sees" columns={preview.result.columns} rows={preview.result.rows} />
              </>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
