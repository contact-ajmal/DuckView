import { useEffect, useMemo, useState } from 'react';
import { Users, UserRound, Trash2, ShieldCheck, Link2, LogOut, ArrowRightLeft } from 'lucide-react';
import { api, type Workspace, type WorkspaceMember, type WorkspaceRole, type Group, type DirectoryUser } from '../../api/client';
import { Button, Badge, Input, Label, Modal, Select, cn, confirmAction } from '../../components/ui';
import { useAuth } from '../../store/auth';
import { useWorkspace } from '../../store/workspace';
import { resultCache } from '../../lib/resultCache';

const ROLE_HELP: Record<WorkspaceRole, string> = {
  VIEWER: 'Run read-only SQL, view dashboards and saved queries, keep their own tabs.',
  EDITOR: 'Everything a viewer can, plus mutating SQL, uploads, folders, saved queries and dashboards.',
  OWNER: 'Everything an editor can, plus settings, sharing and deleting the workspace.',
};
const ROLE_TONE: Record<WorkspaceRole, 'zinc' | 'blue' | 'violet'> = { VIEWER: 'zinc', EDITOR: 'blue', OWNER: 'violet' };

/**
 * Manage who can use a workspace. Owners add people or teams with a role; everyone else sees the member list and
 * can leave (when their access is a direct grant). Members query through the owner's cloud/lakehouse connections,
 * which the dialog says out loud because it is the one non-obvious consequence of sharing.
 */
export function ShareDialog({ open, onClose, workspace }: { open: boolean; onClose: () => void; workspace: Workspace | null }) {
  const auth = useAuth();
  const ws = useWorkspace();
  const canManage = workspace?.role === 'OWNER' && auth.user?.role !== 'READ_ONLY';
  const isPrimaryOwner = workspace?.user_id === auth.user?.id;
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [users, setUsers] = useState<DirectoryUser[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [subject, setSubject] = useState<string>(''); // "user:<id>" | "group:<id>"
  const [role, setRole] = useState<WorkspaceRole>('VIEWER');
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transferTo, setTransferTo] = useState('');

  useEffect(() => {
    if (!open || !workspace) return;
    setError(null);
    setSubject('');
    setTransferTo('');
    void api.get<{ members: WorkspaceMember[] }>(`/api/workspaces/${workspace.id}/members`).then((r) => setMembers(r.members)).catch((e) => setError((e as Error).message));
    if (canManage) {
      void api.get<{ users: DirectoryUser[] }>('/api/users/directory').then((r) => setUsers(r.users)).catch(() => setUsers([]));
      void api.get<{ groups: Group[] }>('/api/groups').then((r) => setGroups(r.groups)).catch(() => setGroups([]));
    }
  }, [open, workspace?.id, canManage]); // eslint-disable-line react-hooks/exhaustive-deps

  const granted = useMemo(() => new Set(members.map((m) => `${m.subject_type}:${m.subject_id}`)), [members]);
  const q = search.trim().toLowerCase();
  const userOptions = users.filter((u) => u.id !== workspace?.user_id && !granted.has(`user:${u.id}`) && (!q || u.email.toLowerCase().includes(q) || (u.display_name ?? '').toLowerCase().includes(q)));
  const groupOptions = groups.filter((g) => !granted.has(`group:${g.id}`) && (!q || g.name.toLowerCase().includes(q)));

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const add = () =>
    run(async () => {
      if (!workspace || !subject) return;
      const [subject_type, subject_id] = subject.split(':') as ['user' | 'group', string];
      const r = await api.put<{ members: WorkspaceMember[] }>(`/api/workspaces/${workspace.id}/members`, { subject_type, subject_id, role });
      setMembers(r.members);
      setSubject('');
      setSearch('');
      void ws.loadWorkspaces();
    });

  const changeRole = (m: WorkspaceMember, next: WorkspaceRole) =>
    run(async () => {
      if (!workspace) return;
      const r = await api.put<{ members: WorkspaceMember[] }>(`/api/workspaces/${workspace.id}/members`, { subject_type: m.subject_type, subject_id: m.subject_id, role: next });
      setMembers(r.members);
    });

  const remove = (m: WorkspaceMember) =>
    run(async () => {
      if (!workspace) return;
      const r = await api.del<{ members: WorkspaceMember[] }>(`/api/workspaces/${workspace.id}/members/${m.id}`);
      setMembers(r.members);
      void ws.loadWorkspaces();
    });

  const leave = () =>
    run(async () => {
      if (!workspace || !(await confirmAction(`Leave "${workspace.name}"? Your tabs in it are discarded.`))) return;
      await api.post(`/api/workspaces/${workspace.id}/leave`);
      void resultCache.clearWorkspace(workspace.id);
      onClose();
      await ws.loadWorkspaces();
    });

  const transfer = () =>
    run(async () => {
      if (!workspace || !transferTo) return;
      const target = users.find((u) => u.id === transferTo);
      if (!(await confirmAction(`Transfer "${workspace.name}" to ${target?.email ?? 'this user'}? They become the owner; you keep owner access as a member, and the engine restarts with their connections.`))) return;
      await api.post(`/api/workspaces/${workspace.id}/transfer`, { user_id: transferTo });
      onClose();
      await ws.loadWorkspaces();
    });

  if (!workspace) return null;
  const ownerLabel = workspace.owner.display_name ? `${workspace.owner.display_name} · ${workspace.owner.email}` : workspace.owner.email;
  const myDirectGrant = members.find((m) => m.subject_type === 'user' && m.subject_id === auth.user?.id);

  return (
    <Modal open={open} onClose={onClose} title={`Share “${workspace.name}”`} width="max-w-2xl">
      <div className="space-y-4">
        <div className="flex items-start gap-3 rounded-lg border border-zinc-800 bg-zinc-950/60 p-3 text-xs">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-accent-300" />
          <div className="space-y-1 text-zinc-400">
            <div>
              Owner: <span className="text-zinc-200">{ownerLabel}</span>
              {isPrimaryOwner && <span className="text-zinc-500"> (you)</span>}
            </div>
            <div>Members query through the owner's cloud and lakehouse connections. Files in the data directory are visible to every member; tabs stay personal.</div>
          </div>
        </div>

        {canManage && (
          <div className="rounded-lg border border-zinc-800 p-3">
            <Label>Add people or teams</Label>
            <div className="flex flex-wrap gap-2">
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search by name, email or team…" className="min-w-[12rem] flex-1" />
              <Select value={subject} onChange={(e) => setSubject(e.target.value)} className="min-w-[14rem] flex-1">
                <option value="">Choose…</option>
                {groupOptions.length > 0 && (
                  <optgroup label="Teams">
                    {groupOptions.map((g) => (
                      <option key={g.id} value={`group:${g.id}`}>
                        {g.name} · {g.member_count} member{g.member_count === 1 ? '' : 's'}{g.external_id ? ' · SSO' : ''}
                      </option>
                    ))}
                  </optgroup>
                )}
                {userOptions.length > 0 && (
                  <optgroup label="People">
                    {userOptions.slice(0, 50).map((u) => (
                      <option key={u.id} value={`user:${u.id}`}>
                        {u.display_name ? `${u.display_name} · ${u.email}` : u.email}{u.role === 'READ_ONLY' ? ' · read-only user' : ''}
                      </option>
                    ))}
                  </optgroup>
                )}
              </Select>
              <Select value={role} onChange={(e) => setRole(e.target.value as WorkspaceRole)} title={ROLE_HELP[role]}>
                <option value="VIEWER">Viewer</option>
                <option value="EDITOR">Editor</option>
                <option value="OWNER">Owner</option>
              </Select>
              <Button variant="primary" onClick={add} disabled={!subject} loading={busy}>
                <Link2 className="h-3.5 w-3.5" /> Share
              </Button>
            </div>
            <div className="mt-2 text-2xs text-zinc-500">{ROLE_HELP[role]}</div>
          </div>
        )}

        <div>
          <Label>Who has access</Label>
          {members.length === 0 ? (
            <div className="border-y border-zinc-800 px-3 py-4 text-center text-xs text-zinc-500">Only the owner{workspace.role === 'OWNER' && auth.user?.role === 'ADMIN' && !isPrimaryOwner ? ' (and administrators)' : ''} can use this workspace.</div>
          ) : (
            <ul className="divide-y divide-zinc-800 rounded-lg border border-zinc-800">
              {members.map((m) => (
                <li key={m.id} className="flex items-center gap-3 px-3 py-2 text-xs">
                  <span className={cn('flex h-7 w-7 shrink-0 items-center justify-center rounded-full', m.subject_type === 'group' ? 'bg-accent-600/20 text-accent-300' : 'bg-zinc-800 text-zinc-300')}>
                    {m.subject_type === 'group' ? <Users className="h-3.5 w-3.5" /> : <UserRound className="h-3.5 w-3.5" />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 truncate text-zinc-100">
                      {m.name}
                      {m.subject_type === 'group' && <Badge tone={m.external ? 'amber' : 'zinc'}>{m.external ? 'SSO team' : 'team'}</Badge>}
                      {m.subject_type === 'user' && m.subject_id === auth.user?.id && <span className="text-zinc-500">(you)</span>}
                    </div>
                    {m.email && <div className="truncate text-2xs text-zinc-500">{m.email}</div>}
                  </div>
                  {canManage ? (
                    <Select value={m.role} disabled={busy} className="h-7 text-xs" onChange={(e) => void changeRole(m, e.target.value as WorkspaceRole)}>
                      <option value="VIEWER">Viewer</option>
                      <option value="EDITOR">Editor</option>
                      <option value="OWNER">Owner</option>
                    </Select>
                  ) : (
                    <Badge tone={ROLE_TONE[m.role]}>{m.role.toLowerCase()}</Badge>
                  )}
                  {canManage && (
                    <button className="rounded p-1 text-zinc-500 hover:bg-red-950 hover:text-red-300" onClick={() => void remove(m)} title="Remove access" disabled={busy}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        {canManage && isPrimaryOwner && (
          <div className="rounded-lg border border-zinc-800 p-3">
            <Label>Transfer ownership</Label>
            <div className="flex gap-2">
              <Select value={transferTo} onChange={(e) => setTransferTo(e.target.value)} className="flex-1">
                <option value="">Choose the new owner…</option>
                {users.filter((u) => u.id !== auth.user?.id && u.role !== 'READ_ONLY').map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.display_name ? `${u.display_name} · ${u.email}` : u.email}
                  </option>
                ))}
              </Select>
              <Button onClick={transfer} disabled={!transferTo} loading={busy}>
                <ArrowRightLeft className="h-3.5 w-3.5" /> Transfer
              </Button>
            </div>
          </div>
        )}

        {error && <div className="rounded-md border border-red-900 bg-red-950/50 px-3 py-2 text-xs text-red-200">{error}</div>}

        <div className="flex items-center justify-between">
          {workspace.shared && myDirectGrant ? (
            <Button variant="ghost" onClick={leave} loading={busy}>
              <LogOut className="h-3.5 w-3.5" /> Leave workspace
            </Button>
          ) : workspace.shared ? (
            <span className="text-2xs text-zinc-500">Your access comes from a team — leave the team to lose it.</span>
          ) : (
            <span />
          )}
          <Button variant="ghost" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    </Modal>
  );
}
