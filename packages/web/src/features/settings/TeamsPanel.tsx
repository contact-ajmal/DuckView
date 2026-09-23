import { useEffect, useState } from 'react';
import { Users, Plus, Trash2, Pencil, UserPlus, Crown, KeyRound } from 'lucide-react';
import { api, timeAgo, type Group, type GroupMember, type DirectoryUser } from '../../api/client';
import { Button, Badge, Card, Input, Label, Modal, Select, cn } from '../../components/ui';
import { useAuth } from '../../store/auth';

/**
 * Teams: the groups workspaces can be shared with. Administrators create and delete teams; administrators and
 * team managers manage membership. Teams mirrored from the identity provider are marked and re-synced on login.
 */
export function TeamsPanel() {
  const auth = useAuth();
  const isAdmin = auth.user?.role === 'ADMIN';
  const [groups, setGroups] = useState<Group[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [members, setMembers] = useState<GroupMember[] | null>(null);
  const [directory, setDirectory] = useState<DirectoryUser[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState<{ open: boolean; name: string; description: string; external_id: string }>({ open: false, name: '', description: '', external_id: '' });
  const [renaming, setRenaming] = useState<{ open: boolean; id: string; name: string; description: string; external_id: string }>({ open: false, id: '', name: '', description: '', external_id: '' });
  const [addUser, setAddUser] = useState('');
  const [addRole, setAddRole] = useState<'MEMBER' | 'MANAGER'>('MEMBER');

  const refresh = async () => {
    try {
      setGroups((await api.get<{ groups: Group[] }>('/api/groups')).groups);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    void refresh();
    void api.get<{ users: DirectoryUser[] }>('/api/users/directory').then((r) => setDirectory(r.users)).catch(() => undefined);
  }, []);

  const group = groups.find((g) => g.id === selected) ?? null;
  const canManageMembers = !!group && (isAdmin || group.my_role === 'MANAGER');
  const canSeeMembers = !!group && (isAdmin || group.my_role !== null);

  useEffect(() => {
    setMembers(null);
    setError(null);
    if (!group || !canSeeMembers) return;
    void api.get<{ members: GroupMember[] }>(`/api/groups/${group.id}/members`).then((r) => setMembers(r.members)).catch((e) => setError((e as Error).message));
  }, [group?.id, canSeeMembers]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (fn: () => Promise<void>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const memberIds = new Set((members ?? []).map((m) => m.user_id));

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
      <Card
        title="Teams"
        actions={
          isAdmin ? (
            <Button size="sm" onClick={() => setCreating({ open: true, name: '', description: '', external_id: '' })}>
              <Plus className="h-3.5 w-3.5" /> New team
            </Button>
          ) : undefined
        }
      >
        {groups.length === 0 ? (
          <div className="rounded-lg border border-dashed border-zinc-800 px-3 py-6 text-center text-xs text-zinc-500">
            {isAdmin ? 'No teams yet. Create one to share workspaces with several people at once — or sign in with SSO to mirror your IdP groups.' : 'No teams yet. Ask an administrator to create one.'}
          </div>
        ) : (
          <ul className="space-y-1">
            {groups.map((g) => (
              <li key={g.id}>
                <button onClick={() => setSelected(g.id)} className={cn('flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left', selected === g.id ? 'bg-zinc-800 text-zinc-50' : 'hover:bg-zinc-900')}>
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent-600/20 text-accent-300">
                    <Users className="h-3.5 w-3.5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5 text-sm text-zinc-100">
                      <span className="truncate">{g.name}</span>
                      {g.external_id && <Badge tone="amber">SSO</Badge>}
                      {g.my_role === 'MANAGER' && <Badge tone="violet">manager</Badge>}
                      {g.my_role === 'MEMBER' && <Badge tone="zinc">member</Badge>}
                    </span>
                    <span className="block truncate text-[11px] text-zinc-500">
                      {g.member_count} member{g.member_count === 1 ? '' : 's'}
                      {g.description ? ` · ${g.description}` : ''}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card
        title={group ? group.name : 'Members'}
        actions={
          group && isAdmin ? (
            <div className="flex items-center gap-1">
              <Button size="sm" variant="ghost" onClick={() => setRenaming({ open: true, id: group.id, name: group.name, description: group.description ?? '', external_id: group.external_id ?? '' })} title="Rename">
                <Pencil className="h-3.5 w-3.5" />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                title="Delete team"
                onClick={() =>
                  void run(async () => {
                    if (!confirm(`Delete team "${group.name}"? Workspaces shared with it lose that access.`)) return;
                    await api.del(`/api/groups/${group.id}`);
                    setSelected(null);
                    await refresh();
                  })
                }
              >
                <Trash2 className="h-3.5 w-3.5 text-red-300" />
              </Button>
            </div>
          ) : undefined
        }
      >
        {!group ? (
          <div className="py-6 text-center text-xs text-zinc-500">Select a team to see its members.</div>
        ) : !canSeeMembers ? (
          <div className="py-6 text-center text-xs text-zinc-500">Members are visible to administrators, managers and members of the team.</div>
        ) : (
          <div className="space-y-3">
            {group.external_id && (
              <div className="flex items-start gap-2 rounded-lg border border-amber-900/50 bg-amber-950/30 p-2.5 text-[11px] text-amber-200">
                <KeyRound className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  Linked to the identity-provider group <span className="font-mono">{group.external_id}</span>. SSO sign-in and SCIM provisioning decide its membership; manual changes last until the IdP next syncs the member.
                </span>
              </div>
            )}
            {canManageMembers && (
              <div className="flex flex-wrap gap-2">
                <Select value={addUser} onChange={(e) => setAddUser(e.target.value)} className="min-w-[14rem] flex-1">
                  <option value="">Add a person…</option>
                  {directory
                    .filter((u) => !memberIds.has(u.id))
                    .map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.display_name ? `${u.display_name} · ${u.email}` : u.email}
                      </option>
                    ))}
                </Select>
                <Select value={addRole} onChange={(e) => setAddRole(e.target.value as 'MEMBER' | 'MANAGER')}>
                  <option value="MEMBER">Member</option>
                  <option value="MANAGER">Manager</option>
                </Select>
                <Button
                  variant="primary"
                  disabled={!addUser}
                  onClick={() =>
                    void run(async () => {
                      const r = await api.put<{ members: GroupMember[] }>(`/api/groups/${group.id}/members`, { user_id: addUser, role: addRole });
                      setMembers(r.members);
                      setAddUser('');
                      await refresh();
                    })
                  }
                >
                  <UserPlus className="h-3.5 w-3.5" /> Add
                </Button>
              </div>
            )}
            {members === null ? (
              <div className="text-xs text-zinc-500">Loading…</div>
            ) : members.length === 0 ? (
              <div className="rounded-lg border border-dashed border-zinc-800 px-3 py-4 text-center text-xs text-zinc-500">No members yet.</div>
            ) : (
              <table className="w-full text-xs">
                <thead className="text-left text-[10px] uppercase tracking-wide text-zinc-500">
                  <tr>
                    <th className="pb-2">Member</th>
                    <th className="pb-2">Role</th>
                    <th className="pb-2">Added</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {members.map((m) => (
                    <tr key={m.user_id} className="border-t border-zinc-800">
                      <td className="py-2">
                        <div className="text-zinc-200">{m.display_name ?? m.email}</div>
                        <div className="text-[10px] text-zinc-500">{m.email}</div>
                      </td>
                      <td className="py-2">
                        {canManageMembers ? (
                          <Select
                            value={m.role}
                            className="h-7 text-xs"
                            onChange={(e) =>
                              void run(async () => {
                                const r = await api.put<{ members: GroupMember[] }>(`/api/groups/${group.id}/members`, { user_id: m.user_id, role: e.target.value });
                                setMembers(r.members);
                              })
                            }
                          >
                            <option value="MEMBER">Member</option>
                            <option value="MANAGER">Manager</option>
                          </Select>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-zinc-300">
                            {m.role === 'MANAGER' && <Crown className="h-3 w-3 text-amber-300" />}
                            {m.role.toLowerCase()}
                          </span>
                        )}
                      </td>
                      <td className="py-2 text-zinc-400">{timeAgo(m.added_at)}</td>
                      <td className="py-2 text-right">
                        {(canManageMembers || m.user_id === auth.user?.id) && (
                          <button
                            className="rounded p-1 text-zinc-500 hover:bg-red-950 hover:text-red-300"
                            title={m.user_id === auth.user?.id ? 'Leave team' : 'Remove from team'}
                            onClick={() =>
                              void run(async () => {
                                const r = await api.del<{ members: GroupMember[] }>(`/api/groups/${group.id}/members/${m.user_id}`);
                                if (m.user_id === auth.user?.id && !isAdmin) setSelected(null);
                                else setMembers(r.members);
                                await refresh();
                              })
                            }
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
        {error && <div className="mt-3 rounded-md border border-red-900 bg-red-950/50 px-3 py-2 text-xs text-red-200">{error}</div>}
      </Card>

      <Modal open={creating.open} onClose={() => setCreating({ ...creating, open: false })} title="New team">
        <div className="space-y-3">
          <div>
            <Label>Name</Label>
            <Input autoFocus value={creating.name} onChange={(e) => setCreating({ ...creating, name: e.target.value })} placeholder="Analytics" />
          </div>
          <div>
            <Label>Description</Label>
            <Input value={creating.description} onChange={(e) => setCreating({ ...creating, description: e.target.value })} placeholder="Optional" />
          </div>
          {isAdmin && (
            <div>
              <Label>Identity-provider group</Label>
              <Input value={creating.external_id} onChange={(e) => setCreating({ ...creating, external_id: e.target.value })} placeholder="Optional — e.g. finance-analysts or an Entra group object id" className="font-mono" />
              <p className="mt-1 text-[11px] text-zinc-500">The value your IdP sends in the groups claim or as the SCIM group's externalId. Share workspaces with the team now; members arrive when they sign in with SSO or are provisioned.</p>
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setCreating({ ...creating, open: false })}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!creating.name.trim()}
              onClick={() =>
                void run(async () => {
                  const r = await api.post<{ group: Group }>('/api/groups', { name: creating.name, description: creating.description || null, external_id: creating.external_id.trim() || null });
                  setCreating({ open: false, name: '', description: '', external_id: '' });
                  await refresh();
                  setSelected(r.group.id);
                })
              }
            >
              Create
            </Button>
          </div>
        </div>
      </Modal>

      <Modal open={renaming.open} onClose={() => setRenaming({ ...renaming, open: false })} title="Edit team">
        <div className="space-y-3">
          <div>
            <Label>Name</Label>
            <Input autoFocus value={renaming.name} onChange={(e) => setRenaming({ ...renaming, name: e.target.value })} />
          </div>
          <div>
            <Label>Description</Label>
            <Input value={renaming.description} onChange={(e) => setRenaming({ ...renaming, description: e.target.value })} />
          </div>
          {isAdmin && (
            <div>
              <Label>Identity-provider group</Label>
              <Input value={renaming.external_id} onChange={(e) => setRenaming({ ...renaming, external_id: e.target.value })} placeholder="Not linked" className="font-mono" />
              <p className="mt-1 text-[11px] text-zinc-500">Linked teams take their membership from SSO sign-in and SCIM. Clear it to manage members by hand.</p>
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setRenaming({ ...renaming, open: false })}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!renaming.name.trim()}
              onClick={() =>
                void run(async () => {
                  await api.patch(`/api/groups/${renaming.id}`, { name: renaming.name, description: renaming.description || null, external_id: renaming.external_id.trim() || null });
                  setRenaming({ ...renaming, open: false });
                  await refresh();
                })
              }
            >
              Save
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
