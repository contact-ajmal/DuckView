/**
 * Teams (groups) — the unit workspaces are shared with besides individual users.
 *   - Admins create/rename/delete groups; admins and group MANAGERs manage membership.
 *   - Groups mirrored from an OIDC `groups` claim, provisioned over SCIM or linked by an admin carry `external_id`
 *     and have their membership rewritten on every SSO login (see syncExternal) and by SCIM; groups without one are
 *     never touched by SSO.
 */
import { eq, and, asc, inArray, isNotNull } from 'drizzle-orm';
import type { MetadataStore } from '../db/index.js';
import type { Group, GroupMember, GroupMemberRole, User } from '../db/schema/sqlite.js';
import { GROUP_MEMBER_ROLES } from '../db/schema/sqlite.js';
import { newId } from '../security/crypto.js';
import { badRequest, conflict, forbidden, notFound } from './errors.js';
import type { Principal } from './principal.js';
import { isPlatformAdmin } from './principal.js';
import { logger } from '../observability/logger.js';

export interface GroupSummary extends Group {
  member_count: number;
  /** The caller's own role in the group, when a member. */
  my_role: GroupMemberRole | null;
}

export interface GroupMemberView extends GroupMember {
  email: string;
  display_name: string | null;
}

/** Minimal user record exposed to every signed-in user so they can pick people to share with. */
export interface DirectoryUser {
  id: string;
  email: string;
  display_name: string | null;
  role: User['role'];
}

const normaliseName = (name: string) => name.trim().replace(/\s+/g, ' ').slice(0, 80);

export class GroupService {
  constructor(private readonly store: MetadataStore) {}
  private get db() {
    return this.store.db;
  }
  private get s() {
    return this.store.schema;
  }

  /** Ids of every group the user belongs to — the basis of group-based workspace access. */
  async groupIdsFor(userId: string): Promise<string[]> {
    const rows = await this.db.select({ group_id: this.s.groupMembers.group_id }).from(this.s.groupMembers).where(eq(this.s.groupMembers.user_id, userId));
    return rows.map((r) => r.group_id);
  }

  async byId(id: string): Promise<Group | null> {
    const rows = await this.db.select().from(this.s.groups).where(eq(this.s.groups.id, id)).limit(1);
    return rows[0] ?? null;
  }

  async byIds(ids: string[]): Promise<Group[]> {
    if (ids.length === 0) return [];
    return this.db.select().from(this.s.groups).where(inArray(this.s.groups.id, ids));
  }

  /** Every group with member counts — visible to all signed-in users (needed for the share picker). */
  async list(p: Principal): Promise<GroupSummary[]> {
    const groups = await this.db.select().from(this.s.groups).orderBy(asc(this.s.groups.name));
    const members = await this.db.select({ group_id: this.s.groupMembers.group_id, user_id: this.s.groupMembers.user_id, role: this.s.groupMembers.role }).from(this.s.groupMembers);
    const counts = new Map<string, number>();
    const mine = new Map<string, GroupMemberRole>();
    for (const m of members) {
      counts.set(m.group_id, (counts.get(m.group_id) ?? 0) + 1);
      if (m.user_id === p.userId) mine.set(m.group_id, m.role);
    }
    return groups.map((g) => ({ ...g, member_count: counts.get(g.id) ?? 0, my_role: mine.get(g.id) ?? null }));
  }

  /**
   * `external_id` links the team to an identity-provider group (the value its OIDC `groups` claim or SCIM
   * externalId/displayName carries). A linked team can be granted workspaces before anyone signs in; from then on
   * SSO sign-in and SCIM decide its membership.
   */
  async create(p: Principal, input: { name: string; description?: string | null; external_id?: string | null }): Promise<Group> {
    if (!isPlatformAdmin(p)) throw forbidden('Only administrators can create teams');
    const name = normaliseName(input.name);
    if (!name) throw badRequest('name is required');
    if (await this.findByName(name)) throw conflict(`A team named "${name}" already exists`);
    const external_id = await this.freeExternalId(input.external_id);
    const now = new Date();
    const g: Group = { id: newId(), name, description: input.description?.trim().slice(0, 500) || null, external_id, created_by: p.userId, created_at: now, updated_at: now };
    await this.db.insert(this.s.groups).values(g);
    return g;
  }

  async update(p: Principal, id: string, patch: { name?: string; description?: string | null; external_id?: string | null }): Promise<Group> {
    if (!isPlatformAdmin(p)) throw forbidden('Only administrators can edit teams');
    const g = await this.byId(id);
    if (!g) throw notFound('Team');
    const set: Partial<Group> = { updated_at: new Date() };
    if (patch.name !== undefined) {
      const name = normaliseName(patch.name);
      if (!name) throw badRequest('name is required');
      const clash = await this.findByName(name);
      if (clash && clash.id !== id) throw conflict(`A team named "${name}" already exists`);
      set.name = name;
    }
    if (patch.description !== undefined) set.description = patch.description?.trim().slice(0, 500) || null;
    if (patch.external_id !== undefined) set.external_id = await this.freeExternalId(patch.external_id, id);
    await this.db.update(this.s.groups).set(set).where(eq(this.s.groups.id, id));
    return { ...g, ...set };
  }

  /** Deleting a group also drops the workspace grants that pointed at it (polymorphic subject — no FK). */
  async remove(p: Principal, id: string): Promise<void> {
    if (!isPlatformAdmin(p)) throw forbidden('Only administrators can delete teams');
    const r = await this.db.delete(this.s.groups).where(eq(this.s.groups.id, id)).returning({ id: this.s.groups.id });
    if (r.length === 0) throw notFound('Team');
    await this.db.delete(this.s.workspaceMembers).where(and(eq(this.s.workspaceMembers.subject_type, 'group'), eq(this.s.workspaceMembers.subject_id, id)));
  }

  private async freeExternalId(value: string | null | undefined, exceptId?: string): Promise<string | null> {
    const ext = value?.trim().slice(0, 256) || null;
    if (!ext) return null;
    const rows = await this.db.select({ id: this.s.groups.id, name: this.s.groups.name }).from(this.s.groups).where(eq(this.s.groups.external_id, ext)).limit(1);
    if (rows[0] && rows[0].id !== exceptId) throw conflict(`The team "${rows[0].name}" is already linked to the IdP group "${ext}"`);
    return ext;
  }

  private async findByName(name: string): Promise<Group | null> {
    const rows = await this.db.select().from(this.s.groups).where(eq(this.s.groups.name, name)).limit(1);
    return rows[0] ?? null;
  }

  // ---------- membership ----------

  private async myRole(p: Principal, groupId: string): Promise<GroupMemberRole | null> {
    const rows = await this.db.select({ role: this.s.groupMembers.role }).from(this.s.groupMembers).where(and(eq(this.s.groupMembers.group_id, groupId), eq(this.s.groupMembers.user_id, p.userId))).limit(1);
    return rows[0]?.role ?? null;
  }

  private async requireManager(p: Principal, groupId: string): Promise<void> {
    if (isPlatformAdmin(p)) return;
    if ((await this.myRole(p, groupId)) !== 'MANAGER') throw forbidden('Only administrators or team managers can change membership');
  }

  async members(p: Principal, groupId: string): Promise<GroupMemberView[]> {
    if (!(await this.byId(groupId))) throw notFound('Team');
    // Members are visible to admins, managers and fellow members.
    if (!isPlatformAdmin(p) && !(await this.myRole(p, groupId))) throw forbidden('You are not a member of this team');
    const rows = await this.db
      .select({ group_id: this.s.groupMembers.group_id, user_id: this.s.groupMembers.user_id, role: this.s.groupMembers.role, added_at: this.s.groupMembers.added_at, email: this.s.users.email, display_name: this.s.users.display_name })
      .from(this.s.groupMembers)
      .innerJoin(this.s.users, eq(this.s.users.id, this.s.groupMembers.user_id))
      .where(eq(this.s.groupMembers.group_id, groupId))
      .orderBy(asc(this.s.groupMembers.role), asc(this.s.users.email)); // MANAGER sorts before MEMBER
    return rows;
  }

  async addMember(p: Principal, groupId: string, userId: string, role: GroupMemberRole = 'MEMBER'): Promise<GroupMemberView[]> {
    if (!(GROUP_MEMBER_ROLES as readonly string[]).includes(role)) throw badRequest(`role must be one of ${GROUP_MEMBER_ROLES.join(', ')}`);
    if (!(await this.byId(groupId))) throw notFound('Team');
    await this.requireManager(p, groupId);
    const user = await this.db.select({ id: this.s.users.id }).from(this.s.users).where(eq(this.s.users.id, userId)).limit(1);
    if (!user[0]) throw notFound('User');
    const existing = await this.db.select().from(this.s.groupMembers).where(and(eq(this.s.groupMembers.group_id, groupId), eq(this.s.groupMembers.user_id, userId))).limit(1);
    if (existing[0]) await this.db.update(this.s.groupMembers).set({ role }).where(and(eq(this.s.groupMembers.group_id, groupId), eq(this.s.groupMembers.user_id, userId)));
    else await this.db.insert(this.s.groupMembers).values({ group_id: groupId, user_id: userId, role, added_at: new Date() });
    await this.db.update(this.s.groups).set({ updated_at: new Date() }).where(eq(this.s.groups.id, groupId));
    return this.members(p, groupId);
  }

  async removeMember(p: Principal, groupId: string, userId: string): Promise<GroupMemberView[]> {
    if (!(await this.byId(groupId))) throw notFound('Team');
    // Anyone may leave a group themselves; otherwise manager/admin.
    if (userId !== p.userId) await this.requireManager(p, groupId);
    const r = await this.db.delete(this.s.groupMembers).where(and(eq(this.s.groupMembers.group_id, groupId), eq(this.s.groupMembers.user_id, userId))).returning({ user_id: this.s.groupMembers.user_id });
    if (r.length === 0) throw notFound('Member');
    if (userId === p.userId && !isPlatformAdmin(p)) return [];
    return this.members(p, groupId);
  }

  // ---------- SSO sync ----------

  /**
   * Mirrors the IdP group list of a user into DuckView: groups are created on first sight (name = claim value),
   * the user is added to each, and removed from any *SSO-managed* group no longer in the claim.
   */
  async syncExternal(userId: string, externalGroups: string[]): Promise<{ groups: Group[]; created: number }> {
    const wanted = [...new Set(externalGroups.map((g) => String(g).trim()).filter(Boolean))].slice(0, 200);
    let created = 0;
    const groups: Group[] = [];
    for (const ext of wanted) {
      const rows = await this.db.select().from(this.s.groups).where(eq(this.s.groups.external_id, ext)).limit(1);
      let g = rows[0];
      if (!g) {
        const now = new Date();
        // A manual group with the same display name would collide on the unique name index; suffix it.
        const base = normaliseName(ext) || ext.slice(0, 80);
        const name = (await this.findByName(base)) ? `${base} (SSO)` : base;
        g = { id: newId(), name, description: 'Synced from the identity provider', external_id: ext, created_by: null, created_at: now, updated_at: now };
        await this.db.insert(this.s.groups).values(g);
        created++;
        logger().info({ group: name, external_id: ext }, 'Created SSO-synced team');
      }
      groups.push(g);
    }
    const wantedIds = new Set(groups.map((g) => g.id));
    const managed = await this.db.select({ id: this.s.groups.id }).from(this.s.groups).where(isNotNull(this.s.groups.external_id));
    const current = await this.db.select({ group_id: this.s.groupMembers.group_id }).from(this.s.groupMembers).where(eq(this.s.groupMembers.user_id, userId));
    const currentIds = new Set(current.map((c) => c.group_id));
    const managedIds = new Set(managed.map((m) => m.id));
    for (const gid of wantedIds) if (!currentIds.has(gid)) await this.db.insert(this.s.groupMembers).values({ group_id: gid, user_id: userId, role: 'MEMBER', added_at: new Date() });
    for (const gid of currentIds) if (managedIds.has(gid) && !wantedIds.has(gid)) await this.db.delete(this.s.groupMembers).where(and(eq(this.s.groupMembers.group_id, gid), eq(this.s.groupMembers.user_id, userId)));
    return { groups, created };
  }

  // ---------- directory ----------

  /** People picker for sharing: every signed-in user may see id/email/name of other users. */
  async directory(search?: string): Promise<DirectoryUser[]> {
    const rows = await this.db.select({ id: this.s.users.id, email: this.s.users.email, display_name: this.s.users.display_name, role: this.s.users.role }).from(this.s.users).orderBy(asc(this.s.users.email));
    const q = (search ?? '').trim().toLowerCase();
    const filtered = q ? rows.filter((u) => u.email.toLowerCase().includes(q) || (u.display_name ?? '').toLowerCase().includes(q)) : rows;
    return filtered.slice(0, 200);
  }
}
