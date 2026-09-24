/**
 * Scheduled syncs: load a source — a table of an attached database or lakehouse, a URL (CSV/JSON/Parquet/Excel over
 * HTTPS, a shared Google Sheet), a connector resource (a warehouse table or query, a SaaS object, a Drive file, a
 * Sheets tab — staged to a file under <data>/.duckview/sync by the connector service), or any SELECT — into a
 * table of a workspace, on a schedule (interval or cron) or on
 * demand, optionally through a transformation step written by a person or by an agent.
 *
 * A run is one guarded SQL sequence on the workspace engine, executed as the sync's owner (so roles, the sandbox,
 * the audit trail and the data epoch all apply exactly as for a person typing it):
 *   1. CREATE OR REPLACE TABLE <target>__staging AS <load select>
 *   2. transform (optional): CREATE OR REPLACE TABLE <target>__next AS <transform with {{raw}} = staging>
 *   3. swap: replace → drop old target, rename; append → INSERT INTO target SELECT * FROM next (create if missing)
 * Every run is recorded (rows, duration, error) and announced on the live feed. The scheduler is one in-process
 * ticker; syncs of a workspace run one at a time.
 */
import fs from 'node:fs';
import path from 'node:path';
import { and, desc, eq, lte } from 'drizzle-orm';
import cronParser from 'cron-parser';
import type { MetadataStore } from '../db/index.js';
import type { DataSync, DataSyncRun, SyncSource, SyncSchedule, SyncMode, SyncLastRun } from '../db/schema/sqlite.js';
import { SYNC_MODES } from '../db/schema/sqlite.js';
import { newId } from '../security/crypto.js';
import type { Principal } from './principal.js';
import { requireWrite } from './principal.js';
import type { WorkspaceService } from './workspaces.js';
import type { QueryService } from './query.js';
import type { AuthService } from './auth.js';
import type { AuditService } from './audit.js';
import type { ConnectorConnectionService } from './connector-connections.js';
import { badRequest, notFound } from './errors.js';
import { analyzeSql } from '../engine/sql-guard.js';
import { sqlString } from '../engine/duckdb.js';
import { logger } from '../observability/logger.js';
import { liveEvents } from '../observability/events.js';

export interface SyncInput {
  name: string;
  source: SyncSource;
  target_table: string;
  target_schema?: string;
  mode?: SyncMode;
  transform_sql?: string | null;
  schedule?: SyncSchedule;
  enabled?: boolean;
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const q = (id: string) => `"${id.replace(/"/g, '""')}"`;

/** Google Sheets export URL for a spreadsheet id (+ optional gid). */
export function googleSheetCsvUrl(spreadsheetId: string, gid?: string | null): string {
  return `https://docs.google.com/spreadsheets/d/${encodeURIComponent(spreadsheetId)}/export?format=csv${gid ? `&gid=${encodeURIComponent(gid)}` : ''}`;
}

/** The SELECT that reads the source (validated as a single read-only statement). */
export function loadSelect(source: SyncSource, aliasOf?: (dbConnectionId: string) => string | null): string {
  switch (source.kind) {
    case 'sql': {
      const sql = source.sql.trim().replace(/;\s*$/, '');
      const a = analyzeSql(sql);
      if (a.statements.length !== 1 || a.isMutating) throw badRequest('The source SQL must be a single read-only SELECT');
      return sql;
    }
    case 'table': {
      const alias = source.database_connection_id ? aliasOf?.(source.database_connection_id) : source.catalog;
      if (!alias) throw badRequest('The table source needs a database connection or a catalog alias');
      if (!IDENT.test(alias) || !IDENT.test(source.schema) || !IDENT.test(source.table)) throw badRequest('catalog, schema and table must be plain identifiers');
      return `SELECT * FROM ${q(alias)}.${q(source.schema)}.${q(source.table)}`;
    }
    case 'url': {
      if (!/^https?:\/\//i.test(source.url)) throw badRequest('The URL must start with http:// or https://');
      const url = sqlString(source.url);
      const opts = Object.entries(source.options ?? {})
        .filter(([k]) => /^[a-z_]+$/i.test(k))
        .map(([k, v]) => `, ${k}=${typeof v === 'string' ? sqlString(v) : String(v)}`)
        .join('');
      switch (source.format) {
        case 'csv':
          return `SELECT * FROM read_csv(${url}${opts})`;
        case 'json':
          return `SELECT * FROM read_json_auto(${url}${opts})`;
        case 'parquet':
          return `SELECT * FROM read_parquet(${url}${opts})`;
        case 'excel':
          return `SELECT * FROM read_xlsx(${url}${opts})`;
        default:
          return `SELECT * FROM ${url}`;
      }
    }
    case 'connector': {
      if (!source.connection_id || typeof source.connection_id !== 'string') throw badRequest('The connector source needs a connection_id');
      if (!source.resource || typeof source.resource !== 'object' || Array.isArray(source.resource)) throw badRequest('The connector source needs a resource (what to read: a table, an object, a file …)');
      if (typeof source.resource.sql === 'string') {
        const a = analyzeSql(source.resource.sql);
        if (a.statements.length !== 1 || a.isMutating) throw badRequest('The remote SQL must be a single read-only SELECT');
      }
      // Rows are staged to a file by the connector service at run time (see DataSyncService.resolveLoad).
      return `SELECT * FROM read_json_auto('<staged ${source.connection_id}>')`;
    }
  }
}

/** The SELECT of a transform with {{raw}} bound to a relation. */
export function bindTransform(transformSql: string, raw: string): string {
  const sql = transformSql.trim().replace(/;\s*$/, '');
  if (!/\{\{\s*raw\s*\}\}/.test(sql)) throw badRequest('The transformation must read from {{raw}} (the freshly loaded rows), e.g. SELECT … FROM {{raw}}');
  const bound = sql.replace(/\{\{\s*raw\s*\}\}/g, raw);
  const a = analyzeSql(bound);
  if (a.statements.length !== 1 || a.isMutating) throw badRequest('The transformation must be a single read-only SELECT');
  return bound;
}

export function nextRunAt(schedule: SyncSchedule, from = new Date()): Date | null {
  switch (schedule.kind) {
    case 'manual':
      return null;
    case 'interval':
      return new Date(from.getTime() + schedule.minutes * 60_000);
    case 'cron':
      try {
        return cronParser.parseExpression(schedule.expression, { currentDate: from, tz: schedule.timezone || 'UTC' }).next().toDate();
      } catch (err) {
        throw badRequest(`Invalid cron expression: ${(err as Error).message}`);
      }
  }
}

export class DataSyncService {
  private ticker: NodeJS.Timeout | null = null;
  private running = new Set<string>();
  /** Alias lookup for table sources; set by the context. */
  aliasOf: (userId: string, dbConnectionId: string) => Promise<string | null> = async () => null;
  /** Connector connections (warehouses, SaaS, Google) and where their rows are staged; set by the context. */
  connectors: ConnectorConnectionService | null = null;
  stageDir: string | null = null;

  constructor(private readonly store: MetadataStore, private readonly workspaces: WorkspaceService, private readonly queries: QueryService, private readonly auth: AuthService, private readonly audit: AuditService) {}
  private get db() {
    return this.store.db;
  }
  private get s() {
    return this.store.schema;
  }

  // ------------------------------------------------------------------ CRUD

  private validate(input: Partial<SyncInput>, existing?: DataSync): Partial<DataSync> {
    const out: Partial<DataSync> = {};
    if (input.name !== undefined) {
      out.name = input.name.trim().slice(0, 160);
      if (!out.name) throw badRequest('name is required');
    }
    if (input.target_table !== undefined) {
      if (!IDENT.test(input.target_table)) throw badRequest('target_table must be a plain identifier');
      if (/__(staging|next)$/.test(input.target_table)) throw badRequest('target_table may not end in __staging or __next');
      out.target_table = input.target_table;
    }
    if (input.target_schema !== undefined) {
      if (!IDENT.test(input.target_schema)) throw badRequest('target_schema must be a plain identifier');
      out.target_schema = input.target_schema;
    }
    if (input.mode !== undefined) {
      if (!SYNC_MODES.includes(input.mode)) throw badRequest(`mode must be ${SYNC_MODES.join(' or ')}`);
      out.mode = input.mode;
    }
    if (input.source !== undefined) {
      if (!input.source || typeof input.source !== 'object' || !['sql', 'table', 'url', 'connector'].includes((input.source as { kind: string }).kind)) throw badRequest('source.kind must be sql, table, url or connector');
      loadSelect(input.source, () => 'x'); // shape and read-only checks (alias resolution happens at run time)
      out.source = input.source;
    }
    if (input.transform_sql !== undefined) {
      if (input.transform_sql && input.transform_sql.trim()) {
        bindTransform(input.transform_sql, 'raw');
        out.transform_sql = input.transform_sql.trim();
      } else out.transform_sql = null;
    }
    if (input.schedule !== undefined) {
      const sch = input.schedule;
      if (!sch || !['manual', 'interval', 'cron'].includes(sch.kind)) throw badRequest('schedule.kind must be manual, interval or cron');
      if (sch.kind === 'interval' && !(Number.isFinite(sch.minutes) && sch.minutes >= 1)) throw badRequest('schedule.minutes must be ≥ 1');
      if (sch.kind === 'cron' && !sch.expression?.trim()) throw badRequest('schedule.expression is required');
      out.schedule = sch;
      out.next_run_at = (input.enabled ?? existing?.enabled ?? true) ? nextRunAt(sch) : null;
    }
    if (input.enabled !== undefined) {
      out.enabled = input.enabled;
      out.next_run_at = input.enabled ? nextRunAt(out.schedule ?? existing?.schedule ?? { kind: 'manual' }) : null;
    }
    return out;
  }

  async create(p: Principal, workspaceId: string, input: SyncInput): Promise<DataSync> {
    requireWrite(p);
    await this.workspaces.get(p, workspaceId, 'EDITOR');
    const v = this.validate({ target_schema: 'main', mode: 'replace', schedule: { kind: 'manual' }, enabled: true, ...input });
    const now = new Date();
    const row: DataSync = { id: newId(), workspace_id: workspaceId, user_id: p.userId, name: v.name!, source: v.source!, target_schema: v.target_schema ?? 'main', target_table: v.target_table!, mode: v.mode ?? 'replace', transform_sql: v.transform_sql ?? null, schedule: v.schedule ?? { kind: 'manual' }, enabled: v.enabled ?? true, last_run: null, next_run_at: v.next_run_at ?? null, created_by: p.userId, created_at: now, updated_at: now };
    await this.db.insert(this.s.dataSyncs).values(row);
    return row;
  }

  async get(p: Principal, id: string, minRole: 'VIEWER' | 'EDITOR' = 'VIEWER'): Promise<DataSync> {
    const rows = await this.db.select().from(this.s.dataSyncs).where(eq(this.s.dataSyncs.id, id)).limit(1);
    if (!rows[0]) throw notFound('Sync');
    await this.workspaces.get(p, rows[0].workspace_id, minRole); // 404 for non-members, 403 below the role
    return rows[0];
  }

  async list(p: Principal, workspaceId: string): Promise<DataSync[]> {
    await this.workspaces.get(p, workspaceId);
    return this.db.select().from(this.s.dataSyncs).where(eq(this.s.dataSyncs.workspace_id, workspaceId)).orderBy(desc(this.s.dataSyncs.updated_at));
  }

  async update(p: Principal, id: string, patch: Partial<SyncInput>): Promise<DataSync> {
    requireWrite(p);
    const existing = await this.get(p, id, 'EDITOR');
    const set = { ...this.validate(patch, existing), updated_at: new Date() };
    await this.db.update(this.s.dataSyncs).set(set).where(eq(this.s.dataSyncs.id, id));
    return { ...existing, ...set };
  }

  async remove(p: Principal, id: string): Promise<void> {
    requireWrite(p);
    await this.get(p, id, 'EDITOR');
    await this.db.delete(this.s.dataSyncs).where(eq(this.s.dataSyncs.id, id));
  }

  async runs(p: Principal, id: string, limit = 30): Promise<DataSyncRun[]> {
    await this.get(p, id);
    return this.db.select().from(this.s.dataSyncRuns).where(eq(this.s.dataSyncRuns.sync_id, id)).orderBy(desc(this.s.dataSyncRuns.started_at)).limit(limit);
  }

  /** A peek at the source (first rows) and, when given, the transformed shape — without touching the target. */
  async preview(p: Principal, workspaceId: string, source: SyncSource, transformSql?: string | null, limit = 50) {
    const w = await this.workspaces.get(p, workspaceId);
    const n = Math.max(1, Math.min(limit, 500));
    const { load, cleanup } = await this.resolveLoad(w.user_id, source, { limit: n });
    try {
      const sql = transformSql?.trim() ? bindTransform(transformSql, `(${load})`) : load;
      const r = await this.queries.run(p, workspaceId, `SELECT * FROM (${sql}) AS _preview LIMIT ${n}`, { cache: false, countTotal: false, maxRows: 500 });
      return { columns: r.columns, rows: r.rows, sql };
    } finally {
      cleanup();
    }
  }

  /**
   * The load SELECT with a database connection's alias resolved for the owner — or, for a connector source, the
   * rows staged to a file (removed by `cleanup`).
   */
  private async resolveLoad(ownerId: string, source: SyncSource, opts: { limit?: number } = {}): Promise<{ load: string; cleanup: () => void }> {
    if (source.kind === 'connector') {
      if (!this.connectors || !this.stageDir) throw badRequest('Connector sources are not available on this server');
      loadSelect(source); // shape checks
      const c = await this.connectors.getOwned(ownerId, source.connection_id).catch(() => null);
      if (!c) throw badRequest('The connection of this sync no longer exists');
      const staged = await this.connectors.stage(c, source.resource, path.join(this.stageDir, `${newId()}`), { limit: opts.limit });
      return { load: staged.select, cleanup: () => staged.files.forEach((f) => fs.rmSync(f, { force: true })) };
    }
    const alias = source.kind === 'table' && source.database_connection_id ? await this.aliasOf(ownerId, source.database_connection_id) : null;
    if (source.kind === 'table' && source.database_connection_id && !alias) throw badRequest('The database connection of this sync no longer exists');
    return { load: loadSelect(source, () => alias), cleanup: () => undefined };
  }

  // ------------------------------------------------------------------ running

  /** Runs a sync now as its owner. Concurrent runs of the same sync are refused. */
  async run(id: string, triggeredBy: 'schedule' | 'manual' | 'agent', actorId: string | null): Promise<DataSyncRun> {
    const rows = await this.db.select().from(this.s.dataSyncs).where(eq(this.s.dataSyncs.id, id)).limit(1);
    const sync = rows[0];
    if (!sync) throw notFound('Sync');
    if (this.running.has(id)) throw badRequest('This sync is already running');
    const w = await this.workspaces.rowById(sync.workspace_id);
    if (!w) throw notFound('Workspace');
    const ownerUser = await this.auth.findActive(w.user_id);
    if (!ownerUser) throw badRequest('The workspace owner no longer exists or has been deactivated');
    const owner = this.auth.principalFromUser(ownerUser, 'jwt', 'scheduler');
    const run: DataSyncRun = { id: newId(), sync_id: id, workspace_id: sync.workspace_id, status: 'running', triggered_by: triggeredBy, actor_id: actorId, rows: null, duration_ms: null, error: null, started_at: new Date(), finished_at: null };
    await this.db.insert(this.s.dataSyncRuns).values(run);
    await this.db.update(this.s.dataSyncs).set({ last_run: toLast(run) }).where(eq(this.s.dataSyncs.id, id));
    liveEvents.publish({ type: 'sync', at: run.started_at.toISOString(), workspace_id: sync.workspace_id, sync_id: id, run_id: run.id, status: 'running', rows: null, duration_ms: null, error: null });
    this.running.add(id);
    const t0 = performance.now();
    let cleanup = () => undefined as void;
    try {
      const resolved = await this.resolveLoad(w.user_id, sync.source);
      const load = resolved.load;
      cleanup = resolved.cleanup;
      const schema = q(sync.target_schema);
      const target = `${schema}.${q(sync.target_table)}`;
      const staging = `${schema}.${q(`${sync.target_table}__staging`)}`;
      const next = `${schema}.${q(`${sync.target_table}__next`)}`;
      const exec = (sql: string) => this.queries.run(owner, sync.workspace_id, sql, { cache: false, countTotal: false, maxRows: 1 });
      if (sync.target_schema !== 'main') await exec(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
      await exec(`CREATE OR REPLACE TABLE ${staging} AS ${load}`);
      const produced = sync.transform_sql ? next : staging;
      if (sync.transform_sql) await exec(`CREATE OR REPLACE TABLE ${next} AS ${bindTransform(sync.transform_sql, staging)}`);
      const count = Number((await this.queries.run(owner, sync.workspace_id, `SELECT count(*) AS n FROM ${produced}`, { cache: false, countTotal: false })).rows[0]?.[0] ?? 0);
      if (sync.mode === 'append') {
        await exec(`CREATE TABLE IF NOT EXISTS ${target} AS SELECT * FROM ${produced} LIMIT 0`);
        await exec(`INSERT INTO ${target} SELECT * FROM ${produced}`);
        await exec(`DROP TABLE ${produced}`);
        if (sync.transform_sql) await exec(`DROP TABLE IF EXISTS ${staging}`);
      } else {
        await exec(`DROP TABLE IF EXISTS ${target}`);
        await exec(`ALTER TABLE ${produced} RENAME TO ${q(sync.target_table)}`);
        if (sync.transform_sql) await exec(`DROP TABLE IF EXISTS ${staging}`);
      }
      const done: DataSyncRun = { ...run, status: 'ok', rows: count, duration_ms: Math.round(performance.now() - t0), finished_at: new Date() };
      await this.finish(sync, done);
      this.audit.log({ userId: actorId ?? w.user_id, actorType: triggeredBy === 'agent' ? 'AGENT' : 'USER', action: 'sync.run', resource: `sync:${id}`, durationMs: done.duration_ms ?? 0, ip: 'scheduler' });
      return done;
    } catch (err) {
      const message = ((err as Error).message ?? String(err)).split('\n').slice(0, 3).join(' ').slice(0, 2000);
      const failed: DataSyncRun = { ...run, status: 'error', error: message, duration_ms: Math.round(performance.now() - t0), finished_at: new Date() };
      await this.finish(sync, failed);
      this.audit.log({ userId: actorId ?? w.user_id, actorType: triggeredBy === 'agent' ? 'AGENT' : 'USER', action: 'sync.run', resource: `sync:${id}`, durationMs: failed.duration_ms ?? 0, ip: 'scheduler', status: 'error', error: message });
      return failed;
    } finally {
      cleanup();
      this.running.delete(id);
    }
  }

  private async finish(sync: DataSync, run: DataSyncRun): Promise<void> {
    await this.db.update(this.s.dataSyncRuns).set({ status: run.status, rows: run.rows, duration_ms: run.duration_ms, error: run.error, finished_at: run.finished_at }).where(eq(this.s.dataSyncRuns.id, run.id));
    const next = sync.enabled ? nextRunAt(sync.schedule) : null;
    await this.db.update(this.s.dataSyncs).set({ last_run: toLast(run), next_run_at: next }).where(eq(this.s.dataSyncs.id, sync.id));
    liveEvents.publish({ type: 'sync', at: (run.finished_at ?? new Date()).toISOString(), workspace_id: sync.workspace_id, sync_id: sync.id, run_id: run.id, status: run.status, rows: run.rows, duration_ms: run.duration_ms, error: run.error });
    // Keep history bounded.
    const old = await this.db.select({ id: this.s.dataSyncRuns.id }).from(this.s.dataSyncRuns).where(eq(this.s.dataSyncRuns.sync_id, sync.id)).orderBy(desc(this.s.dataSyncRuns.started_at)).limit(1000).offset(200);
    for (const r of old) await this.db.delete(this.s.dataSyncRuns).where(eq(this.s.dataSyncRuns.id, r.id));
  }

  // ------------------------------------------------------------------ scheduler

  /** Runs due syncs; called by the ticker and by tests. */
  async tick(now = new Date()): Promise<string[]> {
    const due = await this.db.select().from(this.s.dataSyncs).where(and(eq(this.s.dataSyncs.enabled, true), lte(this.s.dataSyncs.next_run_at, now)));
    const started: string[] = [];
    for (const sync of due) {
      if (this.running.has(sync.id)) continue;
      // Move next_run_at first so a slow run is not picked up again by the next tick.
      // Claimed atomically: with several nodes (cluster mode) only the one whose update lands runs it.
      const claimed = await this.db.update(this.s.dataSyncs).set({ next_run_at: nextRunAt(sync.schedule, now) }).where(and(eq(this.s.dataSyncs.id, sync.id), eq(this.s.dataSyncs.next_run_at, sync.next_run_at!))).returning({ id: this.s.dataSyncs.id });
      if (!claimed.length) continue;
      started.push(sync.id);
      void this.run(sync.id, 'schedule', null).catch((err) => logger().warn({ sync: sync.id, err: (err as Error).message }, 'Scheduled sync failed'));
    }
    return started;
  }

  start(intervalMs = 30_000): void {
    if (this.ticker) return;
    this.ticker = setInterval(() => void this.tick().catch((err) => logger().warn({ err: (err as Error).message }, 'Sync scheduler tick failed')), intervalMs);
    this.ticker.unref();
  }
  stop(): void {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
  }
}

const toLast = (r: DataSyncRun): SyncLastRun => ({ run_id: r.id, status: r.status, started_at: r.started_at.toISOString(), finished_at: r.finished_at?.toISOString() ?? null, rows: r.rows, duration_ms: r.duration_ms, error: r.error });
