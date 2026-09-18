import { eq, and, or, asc, desc, inArray, sql } from 'drizzle-orm';
import type { MetadataStore } from '../db/index.js';
import fs from 'node:fs';
import path from 'node:path';
import type { Workspace, SessionTab, EngineSettings, ChartConfig, WorkspaceFolder, WorkspaceRole, WorkspaceMember, MemberSubjectType } from '../db/schema/sqlite.js';
import { WORKSPACE_ROLES, MEMBER_SUBJECT_TYPES } from '../db/schema/sqlite.js';
import { newId } from '../security/crypto.js';
import { EngineManager, type WorkspaceEngine } from '../engine/duckdb.js';
import type { ConnectionService } from './connections.js';
import type { CloudConnectionService } from './cloud.js';
import type { LakehouseService } from './lakehouse.js';
import type { GroupService } from './groups.js';
import type { Principal } from './principal.js';
import { assertWorkspaceScope, isPlatformAdmin, maxWorkspaceRole, requireWorkspaceRole } from './principal.js';
import { badRequest, forbidden, notFound } from './errors.js';
import { isRemoteUri } from '../engine/sandbox.js';
import { liveEvents } from '../observability/events.js';

/** A workspace together with the caller's effective role on it. */
export type WorkspaceAccess = Workspace & { role: WorkspaceRole };

/** Listing shape: adds who owns it and whether it reached the caller through sharing. */
export interface WorkspaceListing extends WorkspaceAccess {
  owner: { id: string; email: string; display_name: string | null };
  shared: boolean;
  member_count: number;
}

export interface WorkspaceMemberView extends WorkspaceMember {
  /** Resolved display data for the subject (user email/name or group name). */
  name: string;
  email: string | null;
  external: boolean;
}

const STARTER_SQL = `-- Welcome to DuckView. Query files in your data directory directly:
--   SELECT * FROM 'sales.parquet' LIMIT 100;
--   SELECT * FROM read_csv('events/*.csv');
-- Or explore the built-in sample below.
SELECT
  range AS id,
  ['north','south','east','west'][1 + range % 4] AS region,
  round(random() * 1000, 2) AS revenue,
  DATE '2026-01-01' + INTERVAL (range) DAY AS day
FROM range(90);`;

export class WorkspaceService {
  /** Set after construction (the lakehouse service needs this service for engine access, so the dependency is two-way). */
  lakehouse: LakehouseService | null = null;
  private versionListeners: ((workspaceId: string, version: number) => void)[] = [];

  constructor(private readonly store: MetadataStore, private readonly engines: EngineManager, private readonly connections: ConnectionService, private readonly cloud: CloudConnectionService, private readonly groups: GroupService) {
    // A :memory: database loses every table when its engine is (re)created — idle eviction included — so
    // results computed against those tables must not outlive the engine.
    engines.onCreated = (spec) => {
      if ((spec.dbPath?.trim() || ':memory:') === ':memory:') void this.bumpVersion(spec.workspaceId, 'engine_started').catch(() => undefined);
    };
  }

  // ---------- Data epoch (cache invalidation) ----------

  onVersion(fn: (workspaceId: string, version: number) => void) {
    this.versionListeners.push(fn);
  }

  async versionOf(id: string): Promise<number> {
    const rows = await this.db.select({ v: this.s.workspaces.data_version }).from(this.s.workspaces).where(eq(this.s.workspaces.id, id)).limit(1);
    return rows[0]?.v ?? 0;
  }

  /**
   * Moves the workspace's data epoch. Every mutating statement, upload/delete, folder change, transfer and :memory:
   * engine start calls this; caches keyed on the epoch become unreachable and clients are told over the live feed.
   */
  async bumpVersion(id: string, reason: string, actorId: string | null = null): Promise<number> {
    const rows = await this.db
      .update(this.s.workspaces)
      .set({ data_version: sql`${this.s.workspaces.data_version} + 1` })
      .where(eq(this.s.workspaces.id, id))
      .returning({ v: this.s.workspaces.data_version });
    const v = rows[0]?.v;
    if (v === undefined) return 0; // workspace gone
    for (const fn of this.versionListeners) fn(id, v);
    liveEvents.publish({ type: 'workspace', at: new Date().toISOString(), user_id: actorId, workspace_id: id, data_version: v, reason });
    return v;
  }

  /** Moves the epoch of every workspace a user owns — their connections feed all of those engines. */
  async bumpOwnerWorkspaces(ownerId: string, reason: string): Promise<void> {
    const rows = await this.db.select({ id: this.s.workspaces.id }).from(this.s.workspaces).where(eq(this.s.workspaces.user_id, ownerId));
    for (const r of rows) await this.bumpVersion(r.id, reason, ownerId);
  }

  /** Aliases of the owner's lakehouse catalogs — SQL naming one of them reads remote data the epoch cannot version. */
  async lakehouseAliases(ownerId: string): Promise<string[]> {
    if (!this.lakehouse) return [];
    return (await this.lakehouse.list(ownerId)).map((c) => c.alias);
  }
  private get db() {
    return this.store.db;
  }
  private get s() {
    return this.store.schema;
  }
  get jail() {
    return this.engines.jail;
  }

  // ---------- Access resolution ----------

  /** Membership grants for the caller: direct user grants plus grants to any group they belong to. */
  private async grantsFor(p: Principal, workspaceId?: string): Promise<WorkspaceMember[]> {
    const groupIds = await this.groups.groupIdsFor(p.userId);
    const subject = or(
      and(eq(this.s.workspaceMembers.subject_type, 'user'), eq(this.s.workspaceMembers.subject_id, p.userId)),
      groupIds.length ? and(eq(this.s.workspaceMembers.subject_type, 'group'), inArray(this.s.workspaceMembers.subject_id, groupIds)) : undefined,
    );
    const where = workspaceId ? and(eq(this.s.workspaceMembers.workspace_id, workspaceId), subject) : subject;
    return this.db.select().from(this.s.workspaceMembers).where(where);
  }

  /** Effective role: primary owner and platform admins (UI sessions) are OWNER; otherwise the best grant, or null. */
  private async resolveRole(p: Principal, w: Workspace, grants?: WorkspaceMember[]): Promise<WorkspaceRole | null> {
    if (w.user_id === p.userId || isPlatformAdmin(p)) return 'OWNER';
    const g = grants ?? (await this.grantsFor(p, w.id));
    return maxWorkspaceRole(g.filter((m) => m.workspace_id === w.id).map((m) => m.role));
  }

  /** Workspaces the principal may use: own, shared with them (directly or via a team), or all for platform admins. */
  async list(p: Principal): Promise<WorkspaceListing[]> {
    const grants = await this.grantsFor(p);
    const sharedIds = [...new Set(grants.map((g) => g.workspace_id))];
    const where = isPlatformAdmin(p) ? undefined : sharedIds.length ? or(eq(this.s.workspaces.user_id, p.userId), inArray(this.s.workspaces.id, sharedIds)) : eq(this.s.workspaces.user_id, p.userId);
    const q = this.db.select().from(this.s.workspaces).orderBy(desc(this.s.workspaces.updated_at));
    let rows = where ? await q.where(where) : await q;
    if (p.workspaceScope) rows = rows.filter((w) => w.id === p.workspaceScope);
    return this.decorate(p, rows, grants);
  }

  private async decorate(p: Principal, rows: Workspace[], grants: WorkspaceMember[]): Promise<WorkspaceListing[]> {
    if (rows.length === 0) return [];
    const ownerIds = [...new Set(rows.map((w) => w.user_id))];
    const owners = await this.db.select({ id: this.s.users.id, email: this.s.users.email, display_name: this.s.users.display_name }).from(this.s.users).where(inArray(this.s.users.id, ownerIds));
    const ownerMap = new Map(owners.map((o) => [o.id, o]));
    const counts = await this.db.select({ workspace_id: this.s.workspaceMembers.workspace_id }).from(this.s.workspaceMembers).where(inArray(this.s.workspaceMembers.workspace_id, rows.map((w) => w.id)));
    const countMap = new Map<string, number>();
    for (const c of counts) countMap.set(c.workspace_id, (countMap.get(c.workspace_id) ?? 0) + 1);
    const out: WorkspaceListing[] = [];
    for (const w of rows) {
      const role = (await this.resolveRole(p, w, grants)) ?? 'VIEWER';
      const owner = ownerMap.get(w.user_id) ?? { id: w.user_id, email: 'unknown', display_name: null };
      out.push({ ...w, role, owner, shared: w.user_id !== p.userId, member_count: countMap.get(w.id) ?? 0 });
    }
    return out;
  }

  /**
   * Loads a workspace the principal may access and enforces a minimum role. Unknown or inaccessible workspaces
   * are reported as 404 (no existence leak); insufficient role is a 403 naming the required level.
   */
  async get(p: Principal, id: string, minRole: WorkspaceRole = 'VIEWER'): Promise<WorkspaceAccess> {
    assertWorkspaceScope(p, id);
    const rows = await this.db.select().from(this.s.workspaces).where(eq(this.s.workspaces.id, id)).limit(1);
    const w = rows[0];
    if (!w) throw notFound('Workspace');
    const role = await this.resolveRole(p, w);
    if (!role) throw notFound('Workspace');
    requireWorkspaceRole(role, minRole);
    return { ...w, role };
  }

  /** Full listing entry (owner, member count) for one workspace. */
  async describe(p: Principal, id: string): Promise<WorkspaceListing> {
    const w = await this.get(p, id);
    const [d] = await this.decorate(p, [w], await this.grantsFor(p, id));
    return d!;
  }

  // ---------- Sharing ----------

  async listMembers(p: Principal, id: string): Promise<WorkspaceMemberView[]> {
    await this.get(p, id); // any member may see who else has access
    const rows = await this.db.select().from(this.s.workspaceMembers).where(eq(this.s.workspaceMembers.workspace_id, id)).orderBy(asc(this.s.workspaceMembers.created_at));
    const userIds = rows.filter((r) => r.subject_type === 'user').map((r) => r.subject_id);
    const groupIds = rows.filter((r) => r.subject_type === 'group').map((r) => r.subject_id);
    const users = userIds.length ? await this.db.select({ id: this.s.users.id, email: this.s.users.email, display_name: this.s.users.display_name }).from(this.s.users).where(inArray(this.s.users.id, userIds)) : [];
    const groups = await this.groups.byIds(groupIds);
    const userMap = new Map(users.map((u) => [u.id, u]));
    const groupMap = new Map(groups.map((g) => [g.id, g]));
    const out: WorkspaceMemberView[] = [];
    for (const r of rows) {
      if (r.subject_type === 'user') {
        const u = userMap.get(r.subject_id);
        if (!u) continue; // user deleted — stale grant, hidden
        out.push({ ...r, name: u.display_name ?? u.email, email: u.email, external: false });
      } else {
        const g = groupMap.get(r.subject_id);
        if (!g) continue;
        out.push({ ...r, name: g.name, email: null, external: !!g.external_id });
      }
    }
    return out;
  }

  /** Grants (or changes) a role for a user or team. Owners only; the primary owner cannot be granted a lesser role. */
  async setMember(p: Principal, id: string, input: { subject_type: MemberSubjectType; subject_id: string; role: WorkspaceRole }): Promise<WorkspaceMemberView[]> {
    const w = await this.get(p, id, 'OWNER');
    if (!(MEMBER_SUBJECT_TYPES as readonly string[]).includes(input.subject_type)) throw badRequest('subject_type must be user or group');
    if (!(WORKSPACE_ROLES as readonly string[]).includes(input.role)) throw badRequest(`role must be one of ${WORKSPACE_ROLES.join(', ')}`);
    if (input.subject_type === 'user') {
      if (input.subject_id === w.user_id) throw badRequest('The workspace owner already has full access');
      const u = await this.db.select({ id: this.s.users.id }).from(this.s.users).where(eq(this.s.users.id, input.subject_id)).limit(1);
      if (!u[0]) throw notFound('User');
    } else if (!(await this.groups.byId(input.subject_id))) throw notFound('Team');
    const existing = await this.db
      .select()
      .from(this.s.workspaceMembers)
      .where(and(eq(this.s.workspaceMembers.workspace_id, id), eq(this.s.workspaceMembers.subject_type, input.subject_type), eq(this.s.workspaceMembers.subject_id, input.subject_id)))
      .limit(1);
    if (existing[0]) await this.db.update(this.s.workspaceMembers).set({ role: input.role }).where(eq(this.s.workspaceMembers.id, existing[0].id));
    else await this.db.insert(this.s.workspaceMembers).values({ id: newId(), workspace_id: id, subject_type: input.subject_type, subject_id: input.subject_id, role: input.role, added_by: p.userId, created_at: new Date() });
    await this.db.update(this.s.workspaces).set({ updated_at: new Date() }).where(eq(this.s.workspaces.id, id));
    return this.listMembers(p, id);
  }

  async removeMember(p: Principal, id: string, memberId: string): Promise<WorkspaceMemberView[]> {
    await this.get(p, id, 'OWNER');
    const r = await this.db.delete(this.s.workspaceMembers).where(and(eq(this.s.workspaceMembers.id, memberId), eq(this.s.workspaceMembers.workspace_id, id))).returning({ id: this.s.workspaceMembers.id });
    if (r.length === 0) throw notFound('Member');
    return this.listMembers(p, id);
  }

  /** A directly-granted member may remove their own access. Group-based access is left via the team. */
  async leave(p: Principal, id: string): Promise<void> {
    const w = await this.get(p, id);
    if (w.user_id === p.userId) throw badRequest('The owner cannot leave their own workspace — delete it or transfer it instead');
    const r = await this.db
      .delete(this.s.workspaceMembers)
      .where(and(eq(this.s.workspaceMembers.workspace_id, id), eq(this.s.workspaceMembers.subject_type, 'user'), eq(this.s.workspaceMembers.subject_id, p.userId)))
      .returning({ id: this.s.workspaceMembers.id });
    if (r.length === 0) throw forbidden('Your access comes from a team; leave the team to lose it');
    // The user's own tabs in that workspace are theirs alone; drop them so a later re-share starts clean.
    await this.db.delete(this.s.sessionTabs).where(and(eq(this.s.sessionTabs.workspace_id, id), eq(this.s.sessionTabs.user_id, p.userId)));
  }

  /** Hands the workspace to another user (they become the primary owner; the previous owner keeps OWNER via a grant). */
  async transfer(p: Principal, id: string, newOwnerId: string): Promise<WorkspaceListing> {
    const w = await this.get(p, id, 'OWNER');
    if (w.user_id !== p.userId && !isPlatformAdmin(p)) throw forbidden('Only the current owner or an administrator can transfer a workspace');
    if (newOwnerId === w.user_id) return this.describe(p, id);
    const u = await this.db.select({ id: this.s.users.id, role: this.s.users.role }).from(this.s.users).where(eq(this.s.users.id, newOwnerId)).limit(1);
    if (!u[0]) throw notFound('User');
    if (u[0].role === 'READ_ONLY') throw badRequest('A read-only user cannot own a workspace');
    await this.db.update(this.s.workspaces).set({ user_id: newOwnerId, updated_at: new Date() }).where(eq(this.s.workspaces.id, id));
    await this.db.delete(this.s.workspaceMembers).where(and(eq(this.s.workspaceMembers.workspace_id, id), eq(this.s.workspaceMembers.subject_type, 'user'), eq(this.s.workspaceMembers.subject_id, newOwnerId)));
    await this.db.insert(this.s.workspaceMembers).values({ id: newId(), workspace_id: id, subject_type: 'user', subject_id: w.user_id, role: 'OWNER', added_by: p.userId, created_at: new Date() });
    // Secrets and lakehouse catalogs are resolved from the owner — the engine must be rebuilt for the new one.
    this.engines.evict(id);
    await this.bumpVersion(id, 'transferred', p.userId);
    return this.describe(p, id);
  }

  /** Drops the grants of a deleted user (polymorphic subject — no FK cascade). Called by the admin user-delete path. */
  async purgeUserGrants(userId: string): Promise<void> {
    await this.db.delete(this.s.workspaceMembers).where(and(eq(this.s.workspaceMembers.subject_type, 'user'), eq(this.s.workspaceMembers.subject_id, userId)));
  }

  validateSettings(settings: EngineSettings): EngineSettings {
    const out: EngineSettings = {};
    if (settings.memory_limit !== undefined) {
      if (!/^\d+(\.\d+)?\s*(%|[KMGT]i?B)$/i.test(String(settings.memory_limit).trim())) throw badRequest('memory_limit must look like "8GB" or "50%"');
      out.memory_limit = String(settings.memory_limit).trim();
    }
    if (settings.threads !== undefined) {
      if (settings.threads !== 'auto' && (!Number.isInteger(settings.threads) || Number(settings.threads) < 1 || Number(settings.threads) > 1024)) throw badRequest('threads must be "auto" or a positive integer');
      out.threads = settings.threads;
    }
    if (settings.query_timeout_seconds !== undefined) {
      const t = Number(settings.query_timeout_seconds);
      if (!Number.isFinite(t) || t < 1 || t > 86400) throw badRequest('query_timeout_seconds must be between 1 and 86400');
      out.query_timeout_seconds = Math.round(t);
    }
    if (settings.temp_directory !== undefined && settings.temp_directory !== '') out.temp_directory = String(settings.temp_directory);
    if (settings.extensions !== undefined) out.extensions = [...new Set(settings.extensions.map((e) => String(e).toLowerCase().trim()).filter(Boolean))];
    if (settings.connection_ids !== undefined) out.connection_ids = settings.connection_ids.map(String);
    return out;
  }

  validateDbPath(p: string): string {
    const v = (p ?? '').trim() || ':memory:';
    if (v === ':memory:') return v;
    if (isRemoteUri(v)) {
      if (!v.toLowerCase().startsWith('md:')) throw badRequest('Only ":memory:", a .duckdb file inside the data directory, or an "md:" MotherDuck database are supported');
      return v;
    }
    if (!/\.(duckdb|ddb|db)$/i.test(v)) throw badRequest('Persistent database path must end in .duckdb');
    this.engines.jail.resolve(v); // throws SandboxViolation on escape
    return v;
  }

  async create(p: Principal, input: { name: string; active_db_path?: string; engine_settings?: EngineSettings }): Promise<Workspace> {
    const now = new Date();
    const w: Workspace = {
      id: newId(),
      user_id: p.userId,
      name: (input.name ?? '').trim() || 'Untitled workspace',
      active_db_path: this.validateDbPath(input.active_db_path ?? ':memory:'),
      engine_settings: this.validateSettings(input.engine_settings ?? {}),
      folders: [],
      data_version: 0,
      created_at: now,
      updated_at: now,
    };
    await this.db.insert(this.s.workspaces).values(w);
    await this.createTab(p, w.id, { title: 'Query 1', sql_content: STARTER_SQL });
    return w;
  }

  async update(p: Principal, id: string, patch: { name?: string; active_db_path?: string; engine_settings?: EngineSettings }): Promise<Workspace> {
    const w = await this.get(p, id, 'OWNER');
    const set: Partial<Workspace> = { updated_at: new Date() };
    if (patch.name !== undefined) set.name = patch.name.trim() || w.name;
    if (patch.active_db_path !== undefined) set.active_db_path = this.validateDbPath(patch.active_db_path);
    if (patch.engine_settings !== undefined) set.engine_settings = this.validateSettings(patch.engine_settings);
    await this.db.update(this.s.workspaces).set(set).where(eq(this.s.workspaces.id, id));
    // Engine settings changed → the cached engine is stale; next query rebuilds it.
    if (set.active_db_path !== undefined || set.engine_settings !== undefined) {
      this.engines.evict(id);
      await this.bumpVersion(id, 'settings_changed', p.userId);
    }
    return { ...w, ...set };
  }

  // ---------- Workspace folders (VS Code-style roots) ----------

  /** Adds an absolute folder to the explorer. In sandboxed mode the folder must live inside the data directory. */
  async addFolder(p: Principal, id: string, folderPath: string, name?: string): Promise<WorkspaceFolder[]> {
    const w = await this.get(p, id, 'EDITOR');
    const raw = (folderPath ?? '').trim();
    if (!raw) throw badRequest('path is required');
    const resolved = this.engines.jail.resolve(raw); // SandboxViolation outside the jail (sandboxed mode)
    let stat: fs.Stats;
    try {
      stat = fs.statSync(resolved.absolute);
    } catch {
      throw badRequest(`Folder not found: ${raw}`);
    }
    if (!stat.isDirectory()) throw badRequest(`${raw} is not a directory`);
    const abs = resolved.absolute;
    if (abs === this.engines.jail.baseDir) throw badRequest('The data directory is always part of the explorer');
    if (w.folders.some((f) => f.path === abs)) return w.folders;
    const folders: WorkspaceFolder[] = [...w.folders, { path: abs, name: (name ?? '').trim() || path.basename(abs) || abs, added_at: new Date().toISOString() }];
    await this.db.update(this.s.workspaces).set({ folders, updated_at: new Date() }).where(eq(this.s.workspaces.id, id));
    await this.bumpVersion(id, 'folder_added', p.userId);
    return folders;
  }

  async removeFolder(p: Principal, id: string, folderPath: string): Promise<WorkspaceFolder[]> {
    const w = await this.get(p, id, 'EDITOR');
    const folders = w.folders.filter((f) => f.path !== folderPath);
    if (folders.length === w.folders.length) throw notFound('Folder');
    await this.db.update(this.s.workspaces).set({ folders, updated_at: new Date() }).where(eq(this.s.workspaces.id, id));
    await this.bumpVersion(id, 'folder_removed', p.userId);
    return folders;
  }

  /** Data files from the data directory plus every added folder (absolute paths for the latter). */
  async listAllFiles(p: Principal, id: string) {
    const w = await this.get(p, id);
    const files = this.engines.jail.listFiles();
    const truncated: string[] = [];
    for (const f of w.folders) {
      try {
        const entries = this.engines.jail.listFilesIn(f.path, { maxEntries: 500 });
        if (entries.length >= 500) truncated.push(f.path);
        files.push(...entries);
      } catch {
        /* folder removed or unreadable — skipped */
      }
    }
    return { folders: w.folders, files, truncated };
  }

  async remove(p: Principal, id: string): Promise<void> {
    await this.get(p, id, 'OWNER');
    this.engines.evict(id);
    await this.db.delete(this.s.workspaces).where(eq(this.s.workspaces.id, id));
  }

  async ensureDefault(p: Principal): Promise<Workspace> {
    const existing = await this.db.select().from(this.s.workspaces).where(eq(this.s.workspaces.user_id, p.userId)).limit(1);
    if (existing[0]) return existing[0];
    return this.create(p, { name: 'Scratchpad' });
  }

  /**
   * Resolves (and lazily starts) the DuckDB engine for a workspace. Secrets and lakehouse catalogs always come from
   * the workspace *owner*, so members of a shared workspace query through the owner's connections.
   */
  async engine(p: Principal, workspaceId: string): Promise<{ workspace: WorkspaceAccess; engine: WorkspaceEngine; role: WorkspaceRole }> {
    const workspace = await this.get(p, workspaceId);
    // Workspace-linked data connections + every cloud storage connection the owner has configured.
    const lake = this.lakehouse ? await this.lakehouse.resolveEngineBits(workspace.user_id) : { secrets: [], attachments: [] };
    const secrets = [...(await this.connections.resolveSecrets(workspace.user_id, workspace.engine_settings.connection_ids ?? [])), ...(await this.cloud.resolveSecrets(workspace.user_id)), ...lake.secrets];
    const engine = await this.engines.get({ workspaceId: workspace.id, dbPath: workspace.active_db_path, settings: workspace.engine_settings, secrets, attachments: lake.attachments });
    return { workspace, engine, role: workspace.role };
  }

  // ---------- Tabs (per user, inside a possibly shared workspace) ----------

  async listTabs(p: Principal, workspaceId: string): Promise<SessionTab[]> {
    await this.get(p, workspaceId);
    return this.db
      .select()
      .from(this.s.sessionTabs)
      .where(and(eq(this.s.sessionTabs.workspace_id, workspaceId), eq(this.s.sessionTabs.user_id, p.userId)))
      .orderBy(asc(this.s.sessionTabs.order_index), asc(this.s.sessionTabs.updated_at));
  }

  async createTab(p: Principal, workspaceId: string, input: { title?: string; sql_content?: string; chart_config?: ChartConfig; engine?: string | null }): Promise<SessionTab> {
    await this.get(p, workspaceId);
    const existing = await this.db.select({ order_index: this.s.sessionTabs.order_index }).from(this.s.sessionTabs).where(and(eq(this.s.sessionTabs.workspace_id, workspaceId), eq(this.s.sessionTabs.user_id, p.userId)));
    const order = existing.reduce((m, r) => Math.max(m, r.order_index + 1), 0);
    const tab: SessionTab = {
      id: newId(),
      workspace_id: workspaceId,
      user_id: p.userId,
      title: (input.title ?? '').trim() || `Query ${order + 1}`,
      sql_content: input.sql_content ?? '',
      chart_config: input.chart_config ?? { type: 'none' },
      order_index: order,
      cursor_position: 0,
      engine: input.engine ?? null,
      updated_at: new Date(),
    };
    await this.db.insert(this.s.sessionTabs).values(tab);
    return tab;
  }

  async updateTab(p: Principal, workspaceId: string, tabId: string, patch: { title?: string; sql_content?: string; chart_config?: ChartConfig; order_index?: number; cursor_position?: number; engine?: string | null }): Promise<SessionTab> {
    await this.get(p, workspaceId);
    const set: Partial<SessionTab> = { updated_at: new Date() };
    if (patch.title !== undefined) set.title = patch.title.trim().slice(0, 120) || 'Untitled';
    if (patch.sql_content !== undefined) set.sql_content = patch.sql_content.slice(0, 500_000);
    if (patch.chart_config !== undefined) set.chart_config = patch.chart_config;
    if (patch.order_index !== undefined) set.order_index = Math.max(0, Math.floor(patch.order_index));
    if (patch.cursor_position !== undefined) set.cursor_position = Math.max(0, Math.floor(patch.cursor_position));
    if (patch.engine !== undefined) set.engine = patch.engine || null;
    const rows = await this.db
      .update(this.s.sessionTabs)
      .set(set)
      .where(and(eq(this.s.sessionTabs.id, tabId), eq(this.s.sessionTabs.workspace_id, workspaceId), eq(this.s.sessionTabs.user_id, p.userId)))
      .returning();
    if (!rows[0]) throw notFound('Tab');
    await this.db.update(this.s.workspaces).set({ updated_at: new Date() }).where(eq(this.s.workspaces.id, workspaceId));
    return rows[0];
  }

  async deleteTab(p: Principal, workspaceId: string, tabId: string): Promise<void> {
    await this.get(p, workspaceId);
    const r = await this.db
      .delete(this.s.sessionTabs)
      .where(and(eq(this.s.sessionTabs.id, tabId), eq(this.s.sessionTabs.workspace_id, workspaceId), eq(this.s.sessionTabs.user_id, p.userId)))
      .returning({ id: this.s.sessionTabs.id });
    if (r.length === 0) throw notFound('Tab');
  }
}
