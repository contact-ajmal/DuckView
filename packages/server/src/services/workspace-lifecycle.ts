/**
 * The long life of a workspace: backups and restores, bundles (export and import), the organisation's workspace
 * policy (quotas, the idle policy, who may create workspaces and how they are named), and the scheduler that
 * takes scheduled backups and applies the idle policy.
 *
 * A bundle (.duckview) is one DuckDB database file: the workspace's tables (COPY FROM DATABASE) plus a
 * __duckview.manifest table holding its settings and objects (queries, dashboards, notebooks, metrics, quality
 * suites). A backup is a bundle kept under <data directory>/.duckview/backups/<workspace>/.
 */
import fs from 'node:fs';
import path from 'node:path';
import { and, asc, desc, eq, gte, inArray, isNull, max, ne, sql } from 'drizzle-orm';
import type { MetadataStore } from '../db/index.js';
import type { Workspace, WorkspaceBackup } from '../db/schema/sqlite.js';
import type { AppContext } from '../context.js';
import type { Principal } from './principal.js';
import { isPlatformAdmin, requireAdmin, requireWrite } from './principal.js';
import { HttpError, badRequest, forbidden, notFound } from './errors.js';
import { newId } from '../security/crypto.js';
import { resolveMemoryLimit } from '../engine/duckdb.js';
import { logger } from '../observability/logger.js';
import type { WorkspaceObjects } from './workspace-admin.js';

export interface WorkspacePolicy {
  quotas: { storage_bytes: number | null; memory_limit: string | null; query_seconds_per_day: number | null };
  idle: { warn_days: number | null; archive_days: number | null; channel_ids: string[] };
  creation: { admins_only: boolean; name_pattern: string | null; name_hint: string | null; memory_limit: string | null; threads: number | null; query_timeout_seconds: number | null };
}
export const DEFAULT_POLICY: WorkspacePolicy = {
  quotas: { storage_bytes: null, memory_limit: null, query_seconds_per_day: null },
  idle: { warn_days: null, archive_days: null, channel_ids: [] },
  creation: { admins_only: false, name_pattern: null, name_hint: null, memory_limit: null, threads: null, query_timeout_seconds: null },
};
const POLICY_KEY = 'workspace_policy';
const BUNDLE_FORMAT = 'duckview-bundle/1';
const QUERY_ACTIONS = ['query.execute', 'query.stream'];
const DAY = 86_400_000;

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const isLocalFile = (p: string) => p !== ':memory:' && !/^[a-z0-9]+:/i.test(p);

export class WorkspaceLifecycleService {
  private ctx!: AppContext;
  private ticker: NodeJS.Timeout | null = null;
  private policyCache: { at: number; value: WorkspacePolicy } | null = null;
  private usedCache = new Map<string, { at: number; seconds: number }>();
  constructor(private readonly store: MetadataStore) {}
  bind(ctx: AppContext) {
    this.ctx = ctx;
  }
  private get db() {
    return this.store.db;
  }
  private get s() {
    return this.store.schema;
  }

  // ------------------------------------------------------------------------------------------ policy

  async policy(): Promise<WorkspacePolicy> {
    if (this.policyCache && Date.now() - this.policyCache.at < 10_000) return this.policyCache.value;
    const row = (await this.db.select().from(this.s.appSettings).where(eq(this.s.appSettings.key, POLICY_KEY)).limit(1))[0];
    const v = (row?.value ?? {}) as Partial<WorkspacePolicy>;
    const value: WorkspacePolicy = { quotas: { ...DEFAULT_POLICY.quotas, ...v.quotas }, idle: { ...DEFAULT_POLICY.idle, ...v.idle }, creation: { ...DEFAULT_POLICY.creation, ...v.creation } };
    this.policyCache = { at: Date.now(), value };
    return value;
  }

  async setPolicy(p: Principal, input: WorkspacePolicy): Promise<WorkspacePolicy> {
    requireAdmin(p);
    const q = input.quotas;
    if (q.memory_limit) resolveMemoryLimit(q.memory_limit); // throws on nonsense
    if (input.creation.memory_limit) resolveMemoryLimit(input.creation.memory_limit);
    if (input.creation.name_pattern) {
      try {
        new RegExp(input.creation.name_pattern);
      } catch {
        throw badRequest('The naming rule is not a valid regular expression');
      }
    }
    const { warn_days, archive_days } = input.idle;
    if (warn_days && archive_days && warn_days >= archive_days) throw badRequest('Warn before archiving: the warning must come in fewer days than the archive');
    if (input.idle.channel_ids.length) {
      const usable = new Set((await this.ctx.notifications.listOrg(p)).map((c) => c.id));
      const bad = input.idle.channel_ids.find((c) => !usable.has(c));
      if (bad) throw badRequest(`Channel ${bad} cannot be used here`);
    }
    const row = { key: POLICY_KEY, value: input as unknown as Record<string, unknown>, encrypted_value: null, iv: null, tag: null, updated_by: p.userId, updated_at: new Date() };
    const existing = (await this.db.select({ key: this.s.appSettings.key }).from(this.s.appSettings).where(eq(this.s.appSettings.key, POLICY_KEY)).limit(1))[0];
    if (existing) await this.db.update(this.s.appSettings).set(row).where(eq(this.s.appSettings.key, POLICY_KEY));
    else await this.db.insert(this.s.appSettings).values(row);
    this.policyCache = null;
    this.ctx.audit.log({ userId: p.userId, actorType: p.actorType, action: 'workspace.policy_update', resource: 'workspace_policy', ip: p.ip });
    return this.policy();
  }

  /** Creation rules: who may create a workspace, how it is named, and engine defaults. */
  async checkCreate(p: Principal, input: { name: string; engine_settings?: Record<string, unknown> }): Promise<Record<string, unknown>> {
    const pol = (await this.policy()).creation;
    if (pol.admins_only && !isPlatformAdmin(p)) throw forbidden('Only administrators create workspaces here. Ask one to create it for you');
    if (pol.name_pattern && !new RegExp(pol.name_pattern).test(input.name.trim())) throw badRequest(`Workspace names must follow the naming rule${pol.name_hint ? `: ${pol.name_hint}` : ` (${pol.name_pattern})`}`);
    const e = { ...(input.engine_settings ?? {}) };
    if (e.memory_limit === undefined && pol.memory_limit) e.memory_limit = pol.memory_limit;
    if (e.threads === undefined && pol.threads) e.threads = pol.threads;
    if (e.query_timeout_seconds === undefined && pol.query_timeout_seconds) e.query_timeout_seconds = pol.query_timeout_seconds;
    return e;
  }

  /** The memory limit an engine may have: the workspace's, capped by the organisation's quota. */
  async capMemory(limit: string | undefined): Promise<string | undefined> {
    const cap = (await this.policy()).quotas.memory_limit;
    if (!cap) return limit;
    if (!limit) return cap;
    try {
      return resolveMemoryLimit(limit).bytes > resolveMemoryLimit(cap).bytes ? cap : limit;
    } catch {
      return cap;
    }
  }

  /** Query seconds used today (UTC) in a workspace; cached for 30 seconds. */
  async secondsToday(workspaceId: string): Promise<number> {
    const hit = this.usedCache.get(workspaceId);
    if (hit && Date.now() - hit.at < 30_000) return hit.seconds;
    const a = this.s.auditLogs;
    const since = new Date(Math.floor(Date.now() / DAY) * DAY);
    const r = await this.db.select({ ms: sql<number>`coalesce(sum(${a.duration_ms}), 0)` }).from(a).where(and(eq(a.resource, `workspace:${workspaceId}`), inArray(a.action, QUERY_ACTIONS), gte(a.timestamp, since)));
    const seconds = Number(r[0]?.ms ?? 0) / 1000;
    this.usedCache.set(workspaceId, { at: Date.now(), seconds });
    return seconds;
  }

  /** Before a query: the daily query-time quota, and (for statements that write) the storage quota. */
  async checkQuery(workspaceId: string, mutating: boolean): Promise<void> {
    const q = (await this.policy()).quotas;
    if (q.query_seconds_per_day) {
      const used = await this.secondsToday(workspaceId);
      if (used >= q.query_seconds_per_day) throw new HttpError(429, `This workspace used its ${q.query_seconds_per_day.toLocaleString()} seconds of query time for today. It resets at midnight UTC; an administrator can raise the quota`, 'QUOTA');
    }
    if (mutating && q.storage_bytes) {
      const w = await this.ctx.workspaces.rowById(workspaceId);
      const size = w ? this.ctx.workspaceAdmin.sizeOf(w) : null;
      if (size != null && size >= q.storage_bytes) throw new HttpError(403, `This workspace is over its storage quota (${(size / 1e9).toFixed(2)} of ${(q.storage_bytes / 1e9).toFixed(2)} GB). Drop tables or ask an administrator to raise the quota; reading still works`, 'QUOTA');
    }
  }

  /** Where a workspace stands against the quotas (for its detail page). */
  async quotaStatus(p: Principal, workspaceId: string) {
    const w = await this.ctx.workspaces.get(p, workspaceId);
    const q = (await this.policy()).quotas;
    return {
      storage: { used_bytes: this.ctx.workspaceAdmin.sizeOf(w), limit_bytes: q.storage_bytes },
      query_seconds: { used: Math.round(await this.secondsToday(workspaceId)), limit: q.query_seconds_per_day },
      memory: { limit: q.memory_limit },
    };
  }

  // ------------------------------------------------------------------------------------------ bundles

  private backupDir(workspaceId: string) {
    return path.join(this.ctx.workspaces.jail.baseDir, '.duckview', 'backups', workspaceId);
  }

  /** Writes a workspace's data and objects into one bundle file. */
  async writeBundle(p: Principal, w: Workspace, target: string): Promise<{ tables: number; objects: WorkspaceObjects }> {
    const c = this.ctx;
    if (w.archived_at) throw badRequest(`${w.name} is archived. Restore it first`);
    if (fs.existsSync(target)) throw badRequest(`${target} already exists`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const objects = await c.workspaceAdmin.captureObjects(p, w.id);
    await c.mosaic.dropSchema(w.id).catch(() => undefined);
    const { engine } = await c.workspaces.engine(p, w.id);
    const dbName = String((await engine.runInternal('SELECT current_database() AS d', 15_000))[0]?.d ?? 'memory');
    const manifest: Record<string, string> = {
      format: BUNDLE_FORMAT,
      created_at: new Date().toISOString(),
      workspace: JSON.stringify({ name: w.name, description: w.description, tags: w.tags, color: w.color, engine_settings: w.engine_settings, folders: w.folders }),
      objects: JSON.stringify(objects),
    };
    let tables = 0;
    await engine.runInternal(`ATTACH ${lit(target)} AS __dv_bundle`, 60_000);
    try {
      await engine.runInternal(`COPY FROM DATABASE "${dbName.replace(/"/g, '""')}" TO __dv_bundle`, 60 * 60_000);
      tables = Number((await engine.runInternal("SELECT count(*) AS n FROM duckdb_tables() WHERE database_name = '__dv_bundle' AND NOT internal", 15_000))[0]?.n ?? 0);
      await engine.runInternal('CREATE SCHEMA __dv_bundle.__duckview', 15_000);
      await engine.runInternal('CREATE TABLE __dv_bundle.__duckview.manifest (key VARCHAR, value VARCHAR)', 15_000);
      await engine.runInternal(`INSERT INTO __dv_bundle.__duckview.manifest VALUES ${Object.entries(manifest).map(([k, v]) => `(${lit(k)}, ${lit(v)})`).join(', ')}`, 60_000);
    } catch (err) {
      await engine.runInternal('DETACH __dv_bundle', 60_000).catch(() => undefined);
      fs.rmSync(target, { force: true });
      fs.rmSync(`${target}.wal`, { force: true });
      throw err;
    }
    await engine.runInternal('DETACH __dv_bundle', 60_000);
    return { tables, objects };
  }

  /** After a bundle became a workspace's database: its manifest, then the manifest schema is dropped. */
  private async takeManifest(p: Principal, workspaceId: string): Promise<{ workspace: Partial<Workspace>; objects: WorkspaceObjects }> {
    const { engine } = await this.ctx.workspaces.engine(p, workspaceId);
    let rows: Record<string, unknown>[];
    try {
      rows = await engine.runInternal('SELECT key, value FROM __duckview.manifest', 15_000);
    } catch {
      throw badRequest('This is not a DuckView bundle: it has no manifest');
    }
    const m = new Map(rows.map((r) => [String(r.key), String(r.value)]));
    if (m.get('format') !== BUNDLE_FORMAT) throw badRequest(`Unsupported bundle format ${m.get('format') ?? '(none)'}`);
    await engine.runInternal('DROP SCHEMA __duckview CASCADE', 15_000);
    await engine.runInternal('CHECKPOINT', 60_000).catch(() => undefined);
    return { workspace: JSON.parse(m.get('workspace') ?? '{}'), objects: JSON.parse(m.get('objects') ?? '{}') };
  }

  /** Streams a fresh bundle of a workspace to the caller, then removes the temporary file. */
  async exportBundle(p: Principal, workspaceId: string): Promise<{ file: string; name: string; tables: number }> {
    const w = await this.ctx.workspaces.get(p, workspaceId, 'OWNER');
    const file = path.join(this.ctx.workspaces.jail.baseDir, '.duckview', 'exports', `${w.id}-${Date.now()}.duckview`);
    const r = await this.writeBundle(p, w, file);
    this.ctx.audit.log({ userId: p.userId, actorType: p.actorType, action: 'workspace.export', resource: `workspace:${w.id}`, queryText: `${r.tables} tables`, ip: p.ip });
    return { file, name: `${w.name.replace(/[^\w.-]+/g, '-').replace(/^-|-$/g, '') || 'workspace'}.duckview`, tables: r.tables };
  }

  /** A new workspace from a bundle file on the server (an upload lands in a temporary file first). */
  async importBundle(p: Principal, bundleFile: string, input: { name?: string; active_db_path?: string }): Promise<Workspace> {
    requireWrite(p);
    const c = this.ctx;
    const src = c.workspaces.jail.resolve(bundleFile).absolute;
    if (!fs.existsSync(src) || !fs.statSync(src).isFile()) throw notFound('Bundle file');
    const name = input.name?.trim() || path.basename(src).replace(/\.duckview$/i, '');
    await this.checkCreate(p, { name });
    const dbPath = input.active_db_path?.trim() || (await c.workspaces.suggestDbPath(name));
    if (!isLocalFile(dbPath)) throw badRequest('An imported workspace is stored in a database file on the server');
    const target = c.workspaces.jail.resolve(dbPath).absolute;
    if (fs.existsSync(target)) throw badRequest(`${dbPath} already exists — pick another file name`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(src, target);
    let w: Workspace | null = null;
    try {
      w = await c.workspaces.create(p, { name, active_db_path: dbPath });
      const { workspace: meta, objects } = await this.takeManifest(p, w.id);
      await c.workspaces.update(p, w.id, { description: meta.description ?? null, tags: meta.tags ?? [], color: meta.color ?? null, ...(meta.engine_settings ? { engine_settings: meta.engine_settings } : {}) });
      if (meta.folders?.length) await this.db.update(this.s.workspaces).set({ folders: meta.folders }).where(eq(this.s.workspaces.id, w.id));
      await c.workspaceAdmin.restoreObjects(p, w.id, objects);
    } catch (err) {
      if (w) await c.workspaces.remove(p, w.id).catch(() => undefined);
      c.engines.evict(w?.id ?? '');
      await c.engines.released().catch(() => undefined);
      for (const f of [target, `${target}.wal`]) fs.rmSync(f, { force: true });
      throw err;
    }
    c.audit.log({ userId: p.userId, actorType: p.actorType, action: 'workspace.import', resource: `workspace:${w.id}`, queryText: path.basename(src), ip: p.ip });
    return (await c.workspaces.rowById(w.id))!;
  }

  // ------------------------------------------------------------------------------------------ backups

  async listBackups(p: Principal, workspaceId: string): Promise<(WorkspaceBackup & { exists: boolean })[]> {
    await this.ctx.workspaces.get(p, workspaceId, 'OWNER');
    const rows = await this.db.select().from(this.s.workspaceBackups).where(eq(this.s.workspaceBackups.workspace_id, workspaceId)).orderBy(desc(this.s.workspaceBackups.created_at));
    return rows.map((r) => ({ ...r, exists: fs.existsSync(r.file) }));
  }

  async backup(p: Principal, workspaceId: string, kind: WorkspaceBackup['kind'] = 'manual', note: string | null = null): Promise<WorkspaceBackup> {
    const w = await this.ctx.workspaces.get(p, workspaceId, 'OWNER');
    const now = new Date();
    const file = path.join(this.backupDir(w.id), `${now.toISOString().replace(/[:.]/g, '-')}-${kind}.duckview`);
    const r = await this.writeBundle(p, w, file);
    const row: WorkspaceBackup = {
      id: newId(),
      workspace_id: w.id,
      kind,
      file,
      size_bytes: fs.statSync(file).size,
      tables: r.tables,
      objects: { queries: r.objects.queries.length, dashboards: r.objects.dashboards.length, notebooks: r.objects.notebooks.length, quality: r.objects.quality.length },
      note: note?.trim().slice(0, 200) || null,
      created_by: p.userId,
      created_at: now,
    };
    await this.db.insert(this.s.workspaceBackups).values(row);
    await this.db.update(this.s.workspaces).set({ last_backup_at: now }).where(eq(this.s.workspaces.id, w.id));
    this.ctx.audit.log({ userId: p.userId, actorType: p.actorType, action: 'workspace.backup', resource: `workspace:${w.id}`, queryText: `${kind}: ${r.tables} tables`, ip: p.ip });
    if (kind === 'scheduled') await this.prune(w.id, w.backup_policy?.keep ?? 7);
    return row;
  }

  /** Keeps the newest `keep` scheduled backups. */
  private async prune(workspaceId: string, keep: number) {
    const b = this.s.workspaceBackups;
    const rows = await this.db.select().from(b).where(and(eq(b.workspace_id, workspaceId), eq(b.kind, 'scheduled'))).orderBy(desc(b.created_at));
    for (const r of rows.slice(Math.max(1, keep))) {
      fs.rmSync(r.file, { force: true });
      await this.db.delete(b).where(eq(b.id, r.id));
    }
  }

  async deleteBackup(p: Principal, workspaceId: string, backupId: string): Promise<void> {
    await this.ctx.workspaces.get(p, workspaceId, 'OWNER');
    const b = this.s.workspaceBackups;
    const row = (await this.db.select().from(b).where(and(eq(b.id, backupId), eq(b.workspace_id, workspaceId))).limit(1))[0];
    if (!row) throw notFound('Backup');
    fs.rmSync(row.file, { force: true });
    await this.db.delete(b).where(eq(b.id, backupId));
  }

  async setBackupPolicy(p: Principal, workspaceId: string, policy: { every_hours: number; keep: number } | null): Promise<void> {
    await this.ctx.workspaces.get(p, workspaceId, 'OWNER');
    if (policy && (policy.every_hours < 1 || policy.every_hours > 24 * 90 || policy.keep < 1 || policy.keep > 365)) throw badRequest('Back up every 1 hour to 90 days, keeping 1 to 365 copies');
    await this.db.update(this.s.workspaces).set({ backup_policy: policy }).where(eq(this.s.workspaces.id, workspaceId));
  }

  /**
   * Puts a workspace back to a backup: a safety backup of the current state first, then the backup's data
   * replaces the database file; with `objects`, its queries, dashboards, notebooks, metrics and suites replace
   * the current ones too.
   */
  async restore(p: Principal, workspaceId: string, backupId: string, opts: { objects?: boolean } = {}): Promise<{ safety: WorkspaceBackup; tables: number }> {
    const c = this.ctx;
    const w = await c.workspaces.get(p, workspaceId, 'OWNER');
    if (!isLocalFile(w.active_db_path)) throw badRequest('Restoring is available for workspaces stored in a database file on the server');
    if (c.cluster.enabled) throw badRequest('Restoring is not available in a cluster yet: export and import a bundle instead');
    const b = this.s.workspaceBackups;
    const row = (await this.db.select().from(b).where(and(eq(b.id, backupId), eq(b.workspace_id, workspaceId))).limit(1))[0];
    if (!row) throw notFound('Backup');
    if (!fs.existsSync(row.file)) throw badRequest('The backup file is gone from the server');
    const safety = await this.backup(p, workspaceId, 'pre_restore', `Before restoring the backup of ${row.created_at.toISOString().slice(0, 16).replace('T', ' ')} UTC`);
    const target = c.workspaces.jail.resolve(w.active_db_path).absolute;
    c.workspaces.evict(workspaceId);
    await c.engines.released(30_000);
    fs.copyFileSync(row.file, target);
    fs.rmSync(`${target}.wal`, { force: true });
    const { objects } = await this.takeManifest(p, workspaceId);
    if (opts.objects) {
      const quiet = (x: Promise<unknown>) => x.catch(() => undefined);
      for (const q of await c.savedQueries.list(p, workspaceId)) await quiet(c.savedQueries.remove(p, workspaceId, q.id));
      for (const d of await c.dashboards.list(p, workspaceId)) await quiet(c.dashboards.remove(p, d.id));
      for (const n of await c.notebooks.list(p, workspaceId)) await quiet(c.notebooks.remove(p, n.id));
      for (const s of await c.quality.list(p, workspaceId)) await quiet(c.quality.remove(p, s.id));
      await c.workspaceAdmin.restoreObjects(p, workspaceId, objects);
    }
    await c.workspaces.bumpVersion(workspaceId, 'restored', p.userId);
    c.audit.log({ userId: p.userId, actorType: p.actorType, action: 'workspace.restore_backup', resource: `workspace:${workspaceId}`, queryText: `${row.created_at.toISOString()}${opts.objects ? ' with objects' : ''}`, ip: p.ip });
    return { safety, tables: row.tables };
  }

  // ------------------------------------------------------------------------------------------ scheduler

  private async ownerPrincipal(w: Workspace): Promise<Principal | null> {
    const u = await this.ctx.auth.findById(w.user_id);
    return u ? this.ctx.auth.principalFromUser(u, 'jwt', '127.0.0.1') : null;
  }

  /** Scheduled backups and the idle policy; returns what it did (for tests and logs). */
  async tick(now = new Date()): Promise<{ backups: string[]; warned: string[]; archived: string[] }> {
    const c = this.ctx;
    const out = { backups: [] as string[], warned: [] as string[], archived: [] as string[] };
    if (c.cluster.enabled && !(await c.cluster.acquire('lifecycle:scheduler')).self) return out;
    const all = await this.db.select().from(this.s.workspaces).where(isNull(this.s.workspaces.archived_at)).orderBy(asc(this.s.workspaces.created_at));

    for (const w of all.filter((x) => x.backup_policy)) {
      const due = !w.last_backup_at || now.getTime() - w.last_backup_at.getTime() >= w.backup_policy!.every_hours * 3_600_000;
      if (!due) continue;
      try {
        const p = await this.ownerPrincipal(w);
        if (p) {
          await this.backup(p, w.id, 'scheduled');
          out.backups.push(w.id);
        }
      } catch (err) {
        logger().warn({ workspace: w.id, err: (err as Error).message }, 'Scheduled backup failed');
      }
    }

    const idle = (await this.policy()).idle;
    if (idle.warn_days || idle.archive_days) {
      const a = this.s.auditLogs;
      const ids = all.map((w) => w.id);
      // People and agents count as activity; the policy's own warnings do not.
      const activity = ids.length ? await this.db.select({ resource: a.resource, at: max(a.timestamp) }).from(a).where(and(inArray(a.resource, ids.map((id) => `workspace:${id}`)), ne(a.actor_type, 'SYSTEM'))).groupBy(a.resource) : [];
      const last = new Map(activity.map((r) => [String(r.resource).slice('workspace:'.length), new Date(r.at as unknown as string | number | Date)]));
      for (const w of all) {
        const seen = [last.get(w.id), w.created_at].filter(Boolean).sort((x, y) => y!.getTime() - x!.getTime())[0]!;
        const days = (now.getTime() - seen.getTime()) / DAY;
        if (idle.archive_days && days >= idle.archive_days) {
          await this.db.update(this.s.workspaces).set({ archived_at: now, updated_at: now }).where(eq(this.s.workspaces.id, w.id));
          c.workspaces.evict(w.id);
          c.audit.log({ userId: null, actorType: 'SYSTEM', action: 'workspace.idle_archive', resource: `workspace:${w.id}`, queryText: `Idle for ${Math.floor(days)} days` });
          await this.notify(idle.channel_ids, `${w.name} was archived`, `Nobody used ${w.name} for ${Math.floor(days)} days, so it was archived. Restore it from Administration → Workspaces.`, w.id);
          out.archived.push(w.id);
        } else if (idle.warn_days && days >= idle.warn_days && (!w.idle_warned_at || w.idle_warned_at.getTime() < seen.getTime())) {
          await this.db.update(this.s.workspaces).set({ idle_warned_at: now }).where(eq(this.s.workspaces.id, w.id));
          c.audit.log({ userId: null, actorType: 'SYSTEM', action: 'workspace.idle_warning', resource: `workspace:${w.id}`, queryText: `Idle for ${Math.floor(days)} days` });
          await this.notify(idle.channel_ids, `${w.name} has been idle for ${Math.floor(days)} days`, idle.archive_days ? `It will be archived after ${idle.archive_days} days without use. Open it, or run a query, to keep it active.` : 'Open it, or run a query, to keep it active.', w.id);
          out.warned.push(w.id);
        }
      }
    }
    return out;
  }

  private async notify(channelIds: string[], title: string, text: string, workspaceId: string) {
    if (!channelIds.length) return;
    const base = this.ctx.cfg.server.public_url?.replace(/\/+$/, '');
    await this.ctx.notifications.send(channelIds, { title, text, severity: 'warning', url: base ? `${base}/#/workspaces/${workspaceId}` : null }, 'workspace_policy', null).catch((err) => logger().warn({ err: (err as Error).message }, 'Workspace policy notification failed'));
  }

  start(minutes = 10) {
    if (this.ticker) return;
    this.ticker = setInterval(() => void this.tick().catch((err) => logger().warn({ err: (err as Error).message }, 'Workspace lifecycle tick failed')), minutes * 60_000);
    this.ticker.unref();
  }
  stop() {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
  }
}
