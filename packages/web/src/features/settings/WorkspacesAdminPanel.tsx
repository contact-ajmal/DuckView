/**
 * Administration → Workspaces: every workspace in the organisation — owner, storage, size, members, engine, last
 * activity, cost this month, budget and tags — with filters and bulk actions (archive, restore, tag, transfer,
 * delete), and New workspace.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Archive, ArchiveRestore, Plus, Tag as TagIcon, Trash2, UserRoundCog, X } from 'lucide-react';
import { api, formatBytes, timeAgo, type User, type WorkspaceRow } from '../../api/client';
import { DataTable, type Column } from '../../components/data';
import { Tag } from '../../components/layout';
import { Button, Field, Modal, Select, StatusDot, confirmAction, promptAction, toast, errorText } from '../../components/ui';
import { useWorkspace } from '../../store/workspace';
import { CreateWorkspaceWizard } from '../workspace/CreateWorkspaceWizard';

const STORAGE_LABEL: Record<WorkspaceRow['storage']['kind'], string> = { memory: 'In memory', data: 'Data directory', folder: 'Folder', cloud: 'Cloud', motherduck: 'MotherDuck' };
const money = (n: number) => n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: n < 10 ? 2 : 0 });

export function WorkspacesAdminPanel() {
  const ws = useWorkspace();
  const [rows, setRows] = useState<WorkspaceRow[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [owner, setOwner] = useState('');
  const [storage, setStorage] = useState('');
  const [tag, setTag] = useState('');
  const [state, setState] = useState<'active' | 'running' | 'idle' | 'archived' | 'all'>('active');
  const [creating, setCreating] = useState(false);
  const [transfer, setTransfer] = useState<{ users: User[]; to: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setRows((await api.get<{ workspaces: WorkspaceRow[] }>('/api/admin/workspaces')).workspaces);
    } catch (e) {
      setError(e);
    }
  }, []);
  useEffect(() => void load(), [load]);

  const owners = useMemo(() => [...new Map((rows ?? []).map((r) => [r.owner.id, r.owner])).values()].sort((a, b) => a.email.localeCompare(b.email)), [rows]);
  const tags = useMemo(() => [...new Set((rows ?? []).flatMap((r) => r.tags))].sort(), [rows]);
  const shown = useMemo(
    () =>
      rows?.filter(
        (r) =>
          (!owner || r.owner.id === owner) &&
          (!storage || r.storage.kind === storage) &&
          (!tag || r.tags.includes(tag)) &&
          (state === 'all' || (state === 'active' ? r.engine.state !== 'archived' : r.engine.state === state)),
      ) ?? null,
    [rows, owner, storage, tag, state],
  );

  const bulk = async (action: string, extra: Record<string, unknown> = {}, verb: string) => {
    setBusy(true);
    try {
      const r = await api.post<{ results: { id: string; ok: boolean; error?: string }[] }>('/api/admin/workspaces/bulk', { ids: selected, action, ...extra });
      const failed = r.results.filter((x) => !x.ok);
      if (failed.length) toast.error(`${verb} ${r.results.length - failed.length} of ${r.results.length}. ${failed[0]!.error ?? ''}`);
      else toast.success(`${verb} ${r.results.length} workspace${r.results.length === 1 ? '' : 's'}`);
      setSelected([]);
      await load();
      await ws.loadWorkspaces();
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const names = () => (rows ?? []).filter((r) => selected.includes(r.id)).map((r) => r.name);
  const askTag = async (untag: boolean) => {
    const t = await promptAction(untag ? 'Remove a tag' : 'Add a tag', { label: 'Tags, separated by commas', placeholder: 'finance, q3', confirmLabel: untag ? 'Remove' : 'Add' });
    if (t) await bulk(untag ? 'untag' : 'tag', { tags: t.split(',').map((x) => x.trim()).filter(Boolean) }, untag ? 'Untagged' : 'Tagged');
  };
  const askDelete = async () => {
    const n = selected.length;
    const typed = await promptAction(`Delete ${n === 1 ? names()[0] : `${n} workspaces`}?`, { body: 'Their queries, dashboards, notebooks and settings are removed. Database files stay on disk.', label: `Type ${n === 1 ? 'the name' : `delete ${n}`} to confirm`, confirmLabel: 'Delete' });
    if (typed === null) return;
    if (typed !== (n === 1 ? names()[0] : `delete ${n}`)) return void toast.error('The confirmation did not match; nothing was deleted');
    await bulk('delete', {}, 'Deleted');
  };
  const openTransfer = async () => setTransfer({ users: (await api.get<{ users: User[] }>('/api/admin/users')).users.filter((u) => u.role !== 'READ_ONLY' && !u.disabled), to: '' });

  const columns: Column<WorkspaceRow>[] = [
    {
      key: 'name',
      header: 'Name',
      sortValue: (r) => r.name,
      cell: (r) => (
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            {r.color && <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: `var(--series-${r.color})` }} aria-hidden />}
            <span className="truncate font-medium text-zinc-100">{r.name}</span>
          </div>
          {r.description && <div className="truncate text-2xs text-zinc-500" title={r.description}>{r.description}</div>}
        </div>
      ),
    },
    { key: 'owner', header: 'Owner', sortValue: (r) => r.owner.email, truncate: true, cell: (r) => <span title={r.owner.email}>{r.owner.name ?? r.owner.email}</span> },
    { key: 'storage', header: 'Storage', sortValue: (r) => r.storage.kind, cell: (r) => <div className="min-w-0"><div>{STORAGE_LABEL[r.storage.kind]}</div><div className="truncate font-mono text-2xs text-zinc-500" title={r.storage.location}>{r.storage.location}</div></div> },
    { key: 'size', header: 'Size', align: 'right', numeric: true, sortValue: (r) => r.size_bytes ?? -1, cell: (r) => (r.size_bytes != null ? formatBytes(r.size_bytes) : '—') },
    { key: 'members', header: 'Members', align: 'right', numeric: true, sortValue: (r) => r.members, cell: (r) => r.members },
    { key: 'engine', header: 'Engine', sortValue: (r) => r.engine.state, cell: (r) => <StatusDot tone={r.engine.state === 'running' ? (r.engine.active_queries ? 'busy' : 'ok') : 'idle'}>{r.engine.state === 'running' ? (r.engine.active_queries ? `Running ${r.engine.active_queries}` : r.engine.memory_bytes != null ? `Warm · ${formatBytes(r.engine.memory_bytes)}` : 'Warm') : r.engine.state === 'archived' ? 'Archived' : 'Stopped'}</StatusDot> },
    { key: 'activity', header: 'Last activity', sortValue: (r) => r.last_activity_at ?? '', cell: (r) => (r.last_activity_at ? <span title={new Date(r.last_activity_at).toLocaleString()}>{timeAgo(r.last_activity_at)}</span> : '—') },
    { key: 'cost', header: 'Cost this month', align: 'right', numeric: true, sortValue: (r) => r.cost_this_month, cell: (r) => money(r.cost_this_month) },
    { key: 'budget', header: 'Budget', align: 'right', numeric: true, sortValue: (r) => r.budget?.percent ?? -1, cell: (r) => (r.budget ? <span className={r.budget.percent >= 100 ? 'text-red-400' : r.budget.percent >= 80 ? 'text-amber-300' : undefined}>{Math.round(r.budget.percent)}% of {money(r.budget.amount)}</span> : <span className="text-zinc-500">None</span>) },
    { key: 'tags', header: 'Tags', cell: (r) => <div className="flex flex-wrap gap-1">{r.tags.map((t) => <Tag key={t}>{t}</Tag>)}</div> },
  ];

  return (
    <section className="space-y-3" data-testid="workspaces-admin">
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Owner" htmlFor="wa-owner">
          <Select id="wa-owner" uiSize="sm" value={owner} onChange={(e) => setOwner(e.target.value)}>
            <option value="">Anyone</option>
            {owners.map((o) => <option key={o.id} value={o.id}>{o.email}</option>)}
          </Select>
        </Field>
        <Field label="Storage" htmlFor="wa-storage">
          <Select id="wa-storage" uiSize="sm" value={storage} onChange={(e) => setStorage(e.target.value)}>
            <option value="">Any</option>
            {Object.entries(STORAGE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
        </Field>
        <Field label="Tag" htmlFor="wa-tag">
          <Select id="wa-tag" uiSize="sm" value={tag} onChange={(e) => setTag(e.target.value)}>
            <option value="">Any</option>
            {tags.map((t) => <option key={t} value={t}>{t}</option>)}
          </Select>
        </Field>
        <Field label="State" htmlFor="wa-state">
          <Select id="wa-state" uiSize="sm" value={state} onChange={(e) => setState(e.target.value as typeof state)} data-testid="wa-state">
            <option value="active">Not archived</option>
            <option value="running">Engine warm</option>
            <option value="idle">Engine stopped</option>
            <option value="archived">Archived</option>
            <option value="all">All</option>
          </Select>
        </Field>
        <span className="flex-1" />
        <Button variant="primary" onClick={() => setCreating(true)}><Plus className="h-3.5 w-3.5" /> New workspace</Button>
      </div>

      <DataTable
        label="Workspaces"
        testid="workspaces-table"
        rows={shown}
        rowKey={(r) => r.id}
        columns={columns}
        columnPicker="admin-workspaces"
        search={(r) => `${r.name} ${r.description ?? ''} ${r.owner.email} ${r.tags.join(' ')} ${r.storage.location}`}
        searchPlaceholder="Filter workspaces"
        selected={selected}
        onSelectedChange={setSelected}
        error={error}
        onRetry={() => void load()}
        rowProps={(r) => ({ 'data-name': r.name })}
        initialSort={{ key: 'activity', desc: true }}
        empty={rows && rows.length ? 'No workspace matches these filters.' : 'No workspaces yet.'}
        toolbar={
          selected.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5" data-testid="wa-bulk">
              <span className="text-xs text-zinc-400">{selected.length} selected</span>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void confirmAction(`Archive ${selected.length === 1 ? names()[0] : `${selected.length} workspaces`}? They leave the workspace switcher and stop running queries until restored.`, { confirmLabel: 'Archive' }).then((ok) => { if (ok) void bulk('archive', {}, 'Archived'); })}><Archive className="h-3.5 w-3.5" /> Archive</Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void bulk('restore', {}, 'Restored')}><ArchiveRestore className="h-3.5 w-3.5" /> Restore</Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void askTag(false)}><TagIcon className="h-3.5 w-3.5" /> Tag</Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void askTag(true)}><X className="h-3.5 w-3.5" /> Untag</Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void openTransfer()}><UserRoundCog className="h-3.5 w-3.5" /> Transfer</Button>
              <Button size="sm" variant="danger" disabled={busy} onClick={() => void askDelete()}><Trash2 className="h-3.5 w-3.5" /> Delete</Button>
            </div>
          ) : undefined
        }
      />

      <Modal open={transfer !== null} onClose={() => setTransfer(null)} title={`Transfer ${selected.length === 1 ? names()[0] : `${selected.length} workspaces`}`} width="max-w-md">
        {transfer && (
          <div className="space-y-4">
            <Field label="New owner" hint="The current owner keeps access as an owner." htmlFor="wa-to">
              <Select id="wa-to" value={transfer.to} onChange={(e) => setTransfer({ ...transfer, to: e.target.value })} className="w-full">
                <option value="">Choose a person…</option>
                {transfer.users.map((u) => <option key={u.id} value={u.id}>{u.display_name ? `${u.display_name} · ${u.email}` : u.email}</option>)}
              </Select>
            </Field>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setTransfer(null)}>Cancel</Button>
              <Button variant="primary" disabled={!transfer.to || busy} onClick={() => { const to = transfer.to; setTransfer(null); void bulk('transfer', { user_id: to }, 'Transferred'); }}>Transfer</Button>
            </div>
          </div>
        )}
      </Modal>
      <CreateWorkspaceWizard open={creating} onClose={() => { setCreating(false); void load(); }} />
    </section>
  );
}
