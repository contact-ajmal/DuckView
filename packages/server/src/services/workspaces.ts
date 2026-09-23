import { eq, and, or, asc, desc, inArray, sql } from 'drizzle-orm';
import type { MetadataStore } from '../db/index.js';
import type { PolicyService } from './policies.js';
import fs from 'node:fs';
import path from 'node:path';
import type { Workspace, SessionTab, EngineSettings, ChartConfig, WorkspaceFolder, WorkspaceRole, WorkspaceMember, MemberSubjectType, CloudSyncState } from '../db/schema/sqlite.js';
import { WORKSPACE_ROLES, MEMBER_SUBJECT_TYPES } from '../db/schema/sqlite.js';
import { newId } from '../security/crypto.js';
import { EngineManager, type WorkspaceEngine, type AttachSpec } from '../engine/duckdb.js';
import type { ConnectionService } from './connections.js';
import type { CloudConnectionService } from './cloud.js';
import type { LakehouseService } from './lakehouse.js';
import type { GroupService } from './groups.js';
import type { Principal } from './principal.js';
import { assertWorkspaceScope, isPlatformAdmin, maxWorkspaceRole, requireWorkspaceRole } from './principal.js';
import { isCloudDbUri, parseCloudUri, type WorkspaceCloudSync } from './workspace-cloud.js';
import { ensureWritableDir } from '../engine/sandbox.js';
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
  /** Database connections (Postgres/MySQL/SQLite/DuckDB files) attached to every engine of the owner's workspaces. */
  databases: { resolveAttachments(userId: string): Promise<AttachSpec[]> } | null = null;
  /** Row- and column-level security: people under a policy get a guarded engine. */
  policies: PolicyService | null = null;
  private versionListeners: ((workspaceId: string, version: number, reason: string) => void)[] = [];

  /** Cloud-backed database sync (set by the context right after construction). */
  cloudSync: WorkspaceCloudSync | null = null;

  constructor(private readonly store: MetadataStore, private readonly engines: EngineManager, private readonly connections: ConnectionService, private readonly cloud: CloudConnectionService, private readonly groups: GroupService) {
    // A :memory: database loses every table when its engine is (re)created — idle eviction included — so
    // results computed against those tables must not outlive the engine.
    engines.onCreated = (spec) => {
      if ((spec.dbPath?.trim() || ':memory:') === ':memory:') void this.bumpVersion(spec.workspaceId, 'engine_started').catch(() => undefined);
    };
  }

  // ---------- Data epoch (cache invalidation) ----------

  onVersion(fn: (workspaceId: string, version: number, reason: string) => void) {
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
    for (const fn of this.versionListeners) fn(id, v, reason);
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

  /**
   * Accepted database locations: `:memory:`; a `.duckdb` file inside the data directory, or anywhere on the host
   * when `security.filesystem_mode` is `full` (the jail is the whole filesystem then); an `md:` MotherDuck
   * database; or a cloud object (`s3://`, `gs://`, `r2://`, `az://` … `.duckdb`) held by one of the owner's cloud
   * connections, worked on through a local copy that is synced (see WorkspaceCloudSync).
   */
  validateDbPath(p: string): string {
    const v = (p ?? '').trim() || ':memory:';
    if (v === ':memory:') return v;
    if (isCloudDbUri(v)) {
      if (!/\.(duckdb|ddb|db)$/i.test(v)) throw badRequest('A cloud database must be an object ending in .duckdb (e.g. s3://bucket/team/analytics.duckdb)');
      return v;
    }
    if (isRemoteUri(v)) {
      if (!v.toLowerCase().startsWith('md:')) throw badRequest('Only ":memory:", a .duckdb file, an s3:// gs:// r2:// az:// object, or an "md:" MotherDuck database are supported');
      return v;
    }
    if (!/\.(duckdb|ddb|db)$/i.test(v)) throw badRequest('Persistent database path must end in .duckdb');
    const resolved = this.engines.jail.resolve(v); // throws SandboxViolation on escape (any absolute path is fine in full mode)
    const dir = path.dirname(resolved.absolute);
    if (!ensureWritableDir(dir)) throw badRequest(`Cannot write to ${dir}: create the folder and make it writable for the DuckView process`);
    return v;
  }

  /** Raw row without an access check — for internal listeners. */
  async rowById(id: string): Promise<Workspace | null> {
    const rows = await this.db.select().from(this.s.workspaces).where(eq(this.s.workspaces.id, id)).limit(1);
    return rows[0] ?? null;
  }

  /** What kind of place a workspace's database lives in. */
  storageOf(w: Pick<Workspace, 'active_db_path'>): 'memory' | 'data' | 'folder' | 'cloud' | 'motherduck' {
    const p = w.active_db_path;
    if (p === ':memory:') return 'memory';
    if (isCloudDbUri(p)) return 'cloud';
    if (isRemoteUri(p)) return 'motherduck';
    try {
      return this.engines.jail.resolve(p).absolute.startsWith(this.engines.jail.baseDir + path.sep) ? 'data' : 'folder';
    } catch {
      return 'folder';
    }
  }

  /** Resolves and records the cloud connection for a cloud URI (owner's connections only). */
  private async bindCloud(ownerId: string, dbPath: string, connectionId?: string | null): Promise<string | null> {
    const uri = parseCloudUri(dbPath);
    if (!uri) return null;
    if (!this.cloudSync) throw badRequest('Cloud-backed workspaces are not available');
    return (await this.cloudSync.connectionFor(ownerId, uri, connectionId)).id;
  }

  /**
   * A database file name for a workspace: the name slugified, `.duckdb`, unique among files in the data directory
   * and among other workspaces ("sales-2.duckdb" when "sales.duckdb" is taken).
   */
  async suggestDbPath(name: string): Promise<string> {
    const base = (name ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'workspace';
    const taken = new Set((await this.db.select({ p: this.s.workspaces.active_db_path }).from(this.s.workspaces)).map((r) => r.p));
    for (let i = 1; i < 1000; i++) {
      const candidate = i === 1 ? `${base}.duckdb` : `${base}-${i}.duckdb`;
      if (taken.has(candidate)) continue;
      try {
        if (fs.existsSync(this.engines.jail.resolve(candidate).absolute)) continue;
      } catch {
        continue;
      }
      return candidate;
    }
    return `${base}-${newId().slice(0, 8)}.duckdb`;
  }

  async create(p: Principal, input: { name: string; active_db_path?: string; engine_settings?: EngineSettings; cloud_connection_id?: string | null }): Promise<Workspace> {
    const now = new Date();
    const name = (input.name ?? '').trim() || 'Untitled workspace';
    // No explicit database → the configured default: a file that keeps the analyst's tables, or a scratch memory db.
    const requested = input.active_db_path?.trim();
    const dbPath = requested ? this.validateDbPath(requested) : this.engines.defaultDatabase === 'memory' ? ':memory:' : await this.suggestDbPath(name);
    const cloudConnectionId = await this.bindCloud(p.userId, dbPath, input.cloud_connection_id);
    const w: Workspace = {
      id: newId(),
      user_id: p.userId,
      name,
      active_db_path: dbPath,
      engine_settings: this.validateSettings(input.engine_settings ?? {}),
      folders: [],
      data_version: 0,
      cloud_connection_id: cloudConnectionId,
      cloud_sync: cloudConnectionId ? { etag: null, synced_at: null, size_bytes: null, dirty: false, last_error: null } : null,
      created_at: now,
      updated_at: now,
    };
    await this.db.insert(this.s.workspaces).values(w);
    await this.createTab(p, w.id, { title: 'Query 1', sql_content: STARTER_SQL });
    return w;
  }

  async update(p: Principal, id: string, patch: { name?: string; active_db_path?: string; engine_settings?: EngineSettings; cloud_connection_id?: string | null }): Promise<Workspace> {
    const w = await this.get(p, id, 'OWNER');
    const set: Partial<Workspace> = { updated_at: new Date() };
    if (patch.name !== undefined) set.name = patch.name.trim() || w.name;
    if (patch.active_db_path !== undefined) {
      set.active_db_path = this.validateDbPath(patch.active_db_path);
      if (set.active_db_path !== w.active_db_path || patch.cloud_connection_id !== undefined) {
        set.cloud_connection_id = await this.bindCloud(w.user_id, set.active_db_path, patch.cloud_connection_id ?? (set.active_db_path === w.active_db_path ? w.cloud_connection_id : null));
        set.cloud_sync = set.cloud_connection_id ? (set.active_db_path === w.active_db_path ? w.cloud_sync : { etag: null, synced_at: null, size_bytes: null, dirty: false, last_error: null }) : null;
      }
    }
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

  /** Where uploads go: one of the mounted folders, or the data directory (`null`). */
  async setUploadFolder(p: Principal, id: string, folderPath: string | null): Promise<WorkspaceFolder[]> {
    const w = await this.get(p, id, 'EDITOR');
    if (folderPath && !w.folders.some((f) => f.path === folderPath)) throw badRequest('Add the folder to the workspace first');
    const folders = w.folders.map((f) => ({ ...f, upload_default: !!folderPath && f.path === folderPath }));
    await this.db.update(this.s.workspaces).set({ folders, updated_at: new Date() }).where(eq(this.s.workspaces.id, id));
    return folders;
  }

  /** The absolute directory uploads land in for a workspace (a mounted folder flagged as default, else the data directory). */
  uploadDir(w: { folders: WorkspaceFolder[] }): string {
    return w.folders.find((f) => f.upload_default)?.path ?? this.engines.jail.baseDir;
  }

  /**
   * Absolute paths of every workspace's database file. They belong to their engines (opening one from another
   * workspace means lock conflicts), so listings never show them as data files.
   */
  async activeDatabaseFiles(): Promise<Set<string>> {
    const rows = await this.db.select({ p: this.s.workspaces.active_db_path }).from(this.s.workspaces);
    const out = new Set<string>();
    for (const r of rows) {
      if (r.p === ':memory:' || isRemoteUri(r.p) || isCloudDbUri(r.p)) continue;
      try {
        out.add(this.engines.jail.resolve(r.p).absolute);
      } catch {
        /* outside the jail (config changed) — nothing to hide */
      }
    }
    return out;
  }

  /** Data files from the data directory plus every added folder (absolute paths for the latter). */
  async listAllFiles(p: Principal, id: string) {
    const w = await this.get(p, id);
    const exclude = await this.activeDatabaseFiles();
    const files = this.engines.jail.listFiles('', 2000, exclude);
    const truncated: string[] = [];
    for (const f of w.folders) {
      try {
        const entries = this.engines.jail.listFilesIn(f.path, { maxEntries: 500, exclude });
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
    // One file per person: "<email local part>.duckdb", so several users' defaults never collide in the data dir.
    const local = p.email.split('@')[0] ?? 'workspace';
    return this.create(p, { name: 'My workspace', ...(this.engines.defaultDatabase === 'file' ? { active_db_path: await this.suggestDbPath(local) } : {}) });
  }

  /**
   * Turns an in-memory workspace into a file-backed one without losing anything: while the engine is still up,
   * every schema, table, view, sequence and macro is copied into the new file (DuckDB's COPY FROM DATABASE), then
   * the workspace points at the file and the engine restarts on it. Owners only. Mosaic's derived objects must be
   * dropped by the caller first (they reference an attached in-memory database that will not exist in the file).
   */
  async persist(p: Principal, id: string, requestedPath?: string, cloudConnectionId?: string | null): Promise<{ workspace: Workspace; path: string; tables: number; views: number; copied: boolean; cloud_sync: CloudSyncState | null }> {
    const w = await this.get(p, id, 'OWNER');
    if (w.active_db_path !== ':memory:') throw badRequest(`This workspace is already stored in ${w.active_db_path}`);
    const dbPath = requestedPath?.trim() ? this.validateDbPath(requestedPath) : await this.suggestDbPath(w.name);
    const cloud = parseCloudUri(dbPath);
    if (!cloud && isRemoteUri(dbPath)) throw badRequest('Persist into a .duckdb file (data directory, a folder, or an s3:// gs:// r2:// az:// object)');
    let connectionId: string | null = null;
    if (cloud) {
      if (!this.cloudSync) throw badRequest('Cloud-backed workspaces are not available');
      const conn = await this.cloudSync.connectionFor(w.user_id, cloud, cloudConnectionId);
      if (await this.cloud.headObject(conn, cloud.bucket, cloud.key)) throw badRequest(`${dbPath} already exists — pick another object name`);
      connectionId = conn.id;
    }
    const target = cloud ? this.cloudSync!.localPath(id) : this.engines.jail.resolve(dbPath).absolute;
    if (fs.existsSync(target)) throw badRequest(`${dbPath} already exists — pick another file name`);
    const engine = this.engines.peek(id);
    let tables = 0;
    let views = 0;
    let copied = false;
    if (engine) {
      const lit = target.replace(/'/g, "''");
      await engine.runInternal(`ATTACH '${lit}' AS __dv_persist`, 60_000);
      try {
        await engine.runInternal('COPY FROM DATABASE memory TO __dv_persist', 30 * 60_000);
        tables = Number((await engine.runInternal("SELECT count(*) AS n FROM duckdb_tables() WHERE database_name = '__dv_persist' AND NOT internal", 15_000))[0]?.n ?? 0);
        views = Number((await engine.runInternal("SELECT count(*) AS n FROM duckdb_views() WHERE database_name = '__dv_persist' AND NOT internal", 15_000))[0]?.n ?? 0);
        copied = true;
      } finally {
        await engine.runInternal('DETACH __dv_persist', 60_000).catch(() => undefined);
      }
    }
    const cloud_sync: CloudSyncState | null = cloud ? { etag: null, synced_at: null, size_bytes: null, dirty: true, last_error: null } : null;
    await this.db.update(this.s.workspaces).set({ active_db_path: dbPath, cloud_connection_id: connectionId, cloud_sync, updated_at: new Date() }).where(eq(this.s.workspaces.id, id));
    this.engines.evict(id);
    await this.bumpVersion(id, 'persisted', p.userId);
    // The file must exist before the first push; a cold workspace gets its file on the first engine start instead.
    const synced = cloud && copied ? await this.cloudSync!.push(id, 'persisted') : cloud_sync;
    return { workspace: { ...w, active_db_path: dbPath, cloud_connection_id: connectionId, cloud_sync: synced }, path: dbPath, tables, views, copied, cloud_sync: synced };
  }

  /**
   * Resolves (and lazily starts) the DuckDB engine for a workspace. Secrets and lakehouse catalogs always come from
   * the workspace *owner*, so members of a shared workspace query through the owner's connections.
   */
  async engine(p: Principal, workspaceId: string): Promise<{ workspace: WorkspaceAccess; engine: WorkspaceEngine; role: WorkspaceRole }> {
    const workspace = await this.get(p, workspaceId);
    // Workspace-linked data connections + every cloud storage connection the owner has configured.
    const lake = this.lakehouse ? await this.lakehouse.resolveEngineBits(workspace.user_id) : { secrets: [], attachments: [] };
    const dbs = this.databases ? await this.databases.resolveAttachments(workspace.user_id) : [];
    const secrets = [...(await this.connections.resolveSecrets(workspace.user_id, workspace.engine_settings.connection_ids ?? [])), ...(await this.cloud.resolveSecrets(workspace.user_id)), ...lake.secrets];
    let dbPath = workspace.active_db_path;
    if (isCloudDbUri(dbPath)) {
      if (!this.cloudSync) throw badRequest('Cloud-backed workspaces are not available');
      if (!this.engines.peek(workspace.id)) await this.cloudSync.pull(workspace);
      dbPath = this.cloudSync.localPath(workspace.id);
    }
    const engine = await this.engines.get({ workspaceId: workspace.id, dbPath, settings: workspace.engine_settings, secrets, attachments: [...lake.attachments, ...dbs] });
    const restriction = this.policies ? await this.policies.restrictionFor(p, workspace.id, workspace.role) : null;
    return { workspace, engine: restriction ? this.policies!.guard(engine, restriction) : engine, role: workspace.role };
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
