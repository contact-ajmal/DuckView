/**
 * Reverse ETL: the rows of a query sent out of a workspace, on demand or on a schedule — into a table of a database
 * connection (Postgres, MySQL, SQLite — not DuckDB files, which take one writer), into an Apache Iceberg table of a
 * lakehouse catalog or a Delta Lake table (see lake-write.ts), into Parquet / CSV / JSON files (local or in a cloud
 * bucket), or as JSON batches to an HTTP API.
 *
 * A run: the query runs as the sync's author through the workspace engine (read-only, their access policies apply)
 * and is staged as Parquet; a scratch DuckDB instance reads it and delivers it.
 *   replace  the destination holds exactly this result (table dropped and re-created, file overwritten, all rows sent)
 *   append   every row is added each run (a new file per run)
 *   upsert   rows new or changed since the last successful run, matched on the key columns (update or insert)
 *   mirror   upsert, and rows whose key disappeared are deleted (sent as deletions to an API)
 * Change detection keeps, per sync, the keys and a hash of each row last delivered; it is replaced only after a
 * successful delivery, so a failed run is retried in full (at-least-once for HTTP).
 *
 * Data leaving the workspace is a write: agents get an approval challenge (what would be sent where) until they call
 * again with dry_run: false, and a sync an agent creates has no schedule until a person sets one.
 */
import fs from 'node:fs';
import path from 'node:path';
import { and, desc, eq, isNotNull, lt, lte } from 'drizzle-orm';
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import type { MetadataStore } from '../db/index.js';
import { REVERSE_MODES, type ReverseDestination, type ReverseMode, type ReverseSync, type ReverseSyncRun, type SyncSchedule } from '../db/schema/sqlite.js';
import type { DuckViewConfig } from '../config/index.js';
import { CredentialCipher, newId } from '../security/crypto.js';
import { egressPost } from '../security/egress.js';
import { analyzeSql } from '../engine/sql-guard.js';
import { attachToSql, secretToSql, sqlString, type EngineManager } from '../engine/duckdb.js';
import { castFor, deltaCommit, deltaLogName, latestDeltaVersion, newDataFile } from './lake-write.js';
import type { Principal } from './principal.js';
import { requireWrite } from './principal.js';
import type { WorkspaceService } from './workspaces.js';
import type { DatabaseConnectionService } from './databases.js';
import type { CloudConnectionService } from './cloud.js';
import type { LakehouseService } from './lakehouse.js';
import type { AuthService } from './auth.js';
import type { AuditService } from './audit.js';
import type { NotificationService } from './notifications.js';
import { HitlBlocked, type ApprovalChallenge } from './query.js';
import { nextRunAt } from './syncs.js';
import { badRequest, conflict, notFound } from './errors.js';
import { logger } from '../observability/logger.js';
import { liveEvents } from '../observability/events.js';

export interface ReverseInput {
  name?: string;
  sql?: string;
  destination?: ReverseDestination;
  mode?: ReverseMode;
  key_columns?: string[];
  /** HTTP headers (Authorization, X-Api-Key, …); write-only. null clears them. */
  headers?: Record<string, string> | null;
  schedule?: SyncSchedule;
  channel_ids?: string[];
  enabled?: boolean;
}

export type PublicReverseSync = Omit<ReverseSync, 'encrypted_secret' | 'iv' | 'tag'> & { header_names: string[] };

/** What a run would do: rows read, to write or send, to delete, and a sample. */
export interface ReversePlan {
  rows_read: number;
  to_send: number;
  to_delete: number;
  columns: string[];
  sample: Record<string, unknown>[];
  /** Change detection used the previous run's state. */
  incremental: boolean;
  destination: string;
}

const qi = (s: string) => `"${s.replace(/"/g, '""')}"`;
const HASH = '__dv_hash';
const plural = (n: number, w: string) => `${n.toLocaleString('en-US')} ${w}${n === 1 ? '' : 's'}`;
const firstLine = (err: unknown) => ((err as Error).message ?? String(err)).split('\n')[0]!.slice(0, 500);

export function describeDestination(d: ReverseDestination, names: { connection?: string | null } = {}): string {
  if (d.kind === 'database') return `${names.connection ?? 'database'} → ${d.schema ? `${d.schema}.` : ''}${d.table}`;
  if (d.kind === 'file') return `${d.format} file ${d.cloud_connection_id ? `${d.bucket ?? ''}/` : ''}${d.path}`;
  if (d.kind === 'iceberg') return `Iceberg ${names.connection ?? 'catalog'} → ${d.namespace}.${d.table}`;
  if (d.kind === 'delta') return `Delta table ${d.cloud_connection_id ? `${d.bucket ?? ''}/` : ''}${d.path}`;
  return `POST ${d.url}`;
}

export class ReverseEtlService {
  private ticker: NodeJS.Timeout | null = null;
  private running = new Set<string>();

  constructor(private readonly store: MetadataStore, private readonly cfg: DuckViewConfig, private readonly cipher: CredentialCipher, private readonly engines: EngineManager, private readonly workspaces: WorkspaceService, private readonly databases: DatabaseConnectionService, private readonly cloud: CloudConnectionService, private readonly lakehouse: LakehouseService, private readonly auth: AuthService, private readonly notifications: NotificationService, private readonly audit: AuditService) {}
  private get db() {
    return this.store.db;
  }
  private get s() {
    return this.store.schema;
  }
  private dir(id: string) {
    return path.join(this.engines.jail.baseDir, '.duckview', 'reverse', id);
  }

  private toPublic(r: ReverseSync): PublicReverseSync {
    const { encrypted_secret: _e, iv: _i, tag: _t, ...rest } = r;
    return { ...rest, header_names: Object.keys(this.headers(r)) };
  }
  private headers(r: ReverseSync): Record<string, string> {
    if (!r.encrypted_secret || !r.iv || !r.tag) return {};
    try {
      return this.cipher.decryptJson<Record<string, string>>({ ciphertext: r.encrypted_secret, iv: r.iv, tag: r.tag }, r.id);
    } catch {
      return {};
    }
  }

  // ------------------------------------------------------------------------------------------ validation

  private checkSql(sql: string | undefined): string {
    if (!sql?.trim()) throw badRequest('sql is required');
    const a = analyzeSql(sql);
    if (a.isMutating) throw badRequest(`A reverse sync only reads: ${a.mutatingVerbs.join(', ')} is not allowed`);
    if (a.statements.length !== 1) throw badRequest('A reverse sync runs one statement');
    return sql.trim().replace(/;\s*$/, '');
  }

  private async checkDestination(p: Principal, d: ReverseDestination | undefined, mode: ReverseMode, keys: string[]): Promise<ReverseDestination> {
    if (!d || !['database', 'file', 'http', 'iceberg', 'delta'].includes(d.kind)) throw badRequest('destination.kind must be database, iceberg, delta, file or http');
    if ((mode === 'upsert' || mode === 'mirror') && !keys.length) throw badRequest(`${mode} needs key_columns: the columns that identify a row`);
    if (d.kind === 'database') {
      const c = await this.databases.getOwned(p.userId, d.connection_id).catch(() => {
        throw badRequest('destination.connection_id is not one of your database connections');
      });
      // A DuckDB file takes one writer: the workspace engines may have it attached, and a second instance would corrupt it.
      if (c.engine === 'duckdb') throw badRequest('A DuckDB file cannot be a destination (it takes one writer at a time) — send to Parquet files, SQLite, Postgres or MySQL');
      if (c.config.read_only !== false) throw badRequest(`The connection "${c.name}" is read-only — turn off read-only on it (Connections) to write to it`);
      if (!d.table?.trim()) throw badRequest('destination.table is required');
      return { kind: 'database', connection_id: c.id, schema: d.schema?.trim() || null, table: d.table.trim() };
    }
    if (d.kind === 'file') {
      if (!['parquet', 'csv', 'json'].includes(d.format)) throw badRequest('destination.format must be parquet, csv or json');
      if (mode === 'upsert' || mode === 'mirror') throw badRequest('Files are replaced or appended (a new file per run); upsert and mirror need a database or an API');
      const p0 = (d.path ?? '').trim().replace(/^\/+/, d.cloud_connection_id ? '' : '/');
      if (!p0) throw badRequest('destination.path is required');
      if (d.cloud_connection_id) {
        const c = await this.cloud.getOwned(p.userId, d.cloud_connection_id).catch(() => {
          throw badRequest('destination.cloud_connection_id is not one of your cloud connections');
        });
        const bucket = d.bucket?.trim() || c.bucket;
        if (!bucket) throw badRequest('destination.bucket is required for this cloud connection');
        return { kind: 'file', format: d.format, path: p0.replace(/^\/+/, ''), cloud_connection_id: c.id, bucket };
      }
      const resolved = this.engines.jail.resolve(d.path.trim()); // SandboxViolation outside the data directory
      if (resolved.relative.startsWith('.duckview')) throw badRequest('That folder is DuckView\'s own');
      return { kind: 'file', format: d.format, path: d.path.trim(), cloud_connection_id: null, bucket: null };
    }
    if (d.kind === 'iceberg') {
      const lh = await this.lakehouse.getOwned(p.userId, d.connection_id).catch(() => {
        throw badRequest('destination.connection_id is not one of your lakehouse connections');
      });
      if (lh.provider === 'DATABRICKS') throw badRequest('Writing goes through an Iceberg REST catalog, AWS Glue or S3 Tables; Databricks tables are written in Databricks');
      const ident = /^[A-Za-z_][\w]*$/;
      const namespace = (d.namespace ?? '').trim();
      if (!namespace.split('.').every((x) => ident.test(x))) throw badRequest('destination.namespace must be a name like sales (or sales.eu)');
      if (!ident.test((d.table ?? '').trim())) throw badRequest('destination.table must be a plain name');
      if (d.storage_connection_id) await this.cloud.getOwned(p.userId, d.storage_connection_id).catch(() => {
        throw badRequest('destination.storage_connection_id is not one of your cloud connections');
      });
      return { kind: 'iceberg', connection_id: lh.id, namespace, table: d.table.trim(), storage_connection_id: d.storage_connection_id || null };
    }
    if (d.kind === 'delta') {
      if (mode === 'upsert' || mode === 'mirror') throw badRequest('A Delta table is replaced or appended to; upsert and mirror need a database or an Iceberg table');
      const p0 = (d.path ?? '').trim().replace(/\/+$/, '');
      if (!p0) throw badRequest('destination.path is required');
      if (d.cloud_connection_id) {
        const c = await this.cloud.getOwned(p.userId, d.cloud_connection_id).catch(() => {
          throw badRequest('destination.cloud_connection_id is not one of your cloud connections');
        });
        const bucket = d.bucket?.trim() || c.bucket;
        if (!bucket) throw badRequest('destination.bucket is required for this cloud connection');
        return { kind: 'delta', path: p0.replace(/^\/+/, ''), cloud_connection_id: c.id, bucket };
      }
      const resolved = this.engines.jail.resolve(p0);
      if (resolved.relative.startsWith('.duckview')) throw badRequest('That folder is DuckView\'s own');
      return { kind: 'delta', path: p0, cloud_connection_id: null, bucket: null };
    }
    let url: URL;
    try {
      url = new URL(d.url);
    } catch {
      throw badRequest('destination.url is not a URL');
    }
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && this.cfg.notifications.allow_private_targets)) throw badRequest('destination.url must be https://');
    const batch = Math.floor(Number(d.batch_size ?? 500));
    if (!(batch >= 1 && batch <= 10_000)) throw badRequest('destination.batch_size must be 1–10000');
    return { kind: 'http', url: url.toString(), batch_size: batch, payload: d.payload === 'array' || d.payload === 'ndjson' ? d.payload : 'object' };
  }

  private checkSchedule(p: Principal, s: SyncSchedule | undefined): SyncSchedule {
    const sch = s ?? { kind: 'manual' };
    if (sch.kind !== 'manual' && p.actorType === 'AGENT') throw badRequest('An agent creates a reverse sync without a schedule; a person sets one (Connections → Reverse ETL)');
    if (sch.kind === 'interval' && (!Number.isFinite(sch.minutes) || sch.minutes < 5)) throw badRequest('schedule.minutes must be at least 5');
    nextRunAt(sch);
    return sch;
  }

  private async checkChannels(p: Principal, workspaceId: string, ids: string[] | undefined): Promise<string[]> {
    const wanted = [...new Set(ids ?? [])];
    if (!wanted.length) return [];
    const usable = new Set((await this.notifications.list(p, workspaceId)).map((c) => c.id));
    const bad = wanted.find((id) => !usable.has(id));
    if (bad) throw badRequest(`Channel ${bad} is not a channel of this workspace (or org-wide)`);
    return wanted;
  }

  private checkHeaders(h: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(h)) {
      if (!/^[A-Za-z0-9-]{1,100}$/.test(k)) throw badRequest(`Header "${k}" is not a header name`);
      if (/^(host|content-length|content-type)$/i.test(k)) throw badRequest(`Header ${k} is set by DuckView`);
      if (typeof v !== 'string' || v.length > 8000 || /[\r\n]/.test(v)) throw badRequest(`Header ${k} has an invalid value`);
      out[k] = v;
    }
    return out;
  }

  // ------------------------------------------------------------------------------------------ registry

  async list(p: Principal, workspaceId: string): Promise<PublicReverseSync[]> {
    await this.workspaces.get(p, workspaceId);
    const rows = await this.db.select().from(this.s.reverseSyncs).where(eq(this.s.reverseSyncs.workspace_id, workspaceId));
    return rows.sort((a, b) => a.name.localeCompare(b.name)).map((r) => this.toPublic(r));
  }

  private async load(p: Principal, id: string, minRole: 'VIEWER' | 'EDITOR' = 'VIEWER'): Promise<ReverseSync> {
    const r = (await this.db.select().from(this.s.reverseSyncs).where(eq(this.s.reverseSyncs.id, id)).limit(1))[0];
    if (!r) throw notFound('Reverse sync');
    await this.workspaces.get(p, r.workspace_id, minRole);
    return r;
  }

  async get(p: Principal, id: string): Promise<PublicReverseSync> {
    return this.toPublic(await this.load(p, id));
  }

  async create(p: Principal, workspaceId: string, input: ReverseInput): Promise<PublicReverseSync> {
    requireWrite(p);
    await this.workspaces.get(p, workspaceId, 'EDITOR');
    const name = (input.name ?? '').trim().slice(0, 120);
    if (!name) throw badRequest('name is required');
    const sql = this.checkSql(input.sql);
    const mode = input.mode ?? 'replace';
    if (!REVERSE_MODES.includes(mode)) throw badRequest(`mode must be ${REVERSE_MODES.join(', ')}`);
    const keys = [...new Set((input.key_columns ?? []).map((k) => k.trim()).filter(Boolean))];
    const destination = await this.checkDestination(p, input.destination, mode, keys);
    const schedule = this.checkSchedule(p, input.schedule);
    const now = new Date();
    const id = newId();
    const enabled = input.enabled ?? true;
    const headers = destination.kind === 'http' && input.headers ? this.checkHeaders(input.headers) : null;
    const enc = headers && Object.keys(headers).length ? this.cipher.encryptJson(headers, id) : null;
    const row: ReverseSync = { id, workspace_id: workspaceId, user_id: p.userId, name, sql, destination, mode, key_columns: keys, encrypted_secret: enc?.ciphertext ?? null, iv: enc?.iv ?? null, tag: enc?.tag ?? null, schedule, channel_ids: await this.checkChannels(p, workspaceId, input.channel_ids), enabled, last_run: null, next_run_at: enabled ? nextRunAt(schedule, now) : null, created_at: now, updated_at: now };
    await this.db.insert(this.s.reverseSyncs).values(row);
    this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'reverse_sync.create', resource: `reverse_sync:${id}`, queryText: sql, ip: p.ip });
    return this.toPublic(row);
  }

  async update(p: Principal, id: string, patch: ReverseInput): Promise<PublicReverseSync> {
    requireWrite(p);
    const r = await this.load(p, id, 'EDITOR');
    const set: Partial<ReverseSync> = { updated_at: new Date() };
    if (patch.name !== undefined) set.name = patch.name.trim().slice(0, 120) || r.name;
    if (patch.sql !== undefined) set.sql = this.checkSql(patch.sql);
    if (patch.mode !== undefined) {
      if (!REVERSE_MODES.includes(patch.mode)) throw badRequest(`mode must be ${REVERSE_MODES.join(', ')}`);
      set.mode = patch.mode;
    }
    if (patch.key_columns !== undefined) set.key_columns = [...new Set(patch.key_columns.map((k) => k.trim()).filter(Boolean))];
    const next = { ...r, ...set };
    // What is read, where it goes and who it runs as change together: the editor's connections must fit.
    if (patch.sql !== undefined || patch.destination !== undefined || patch.mode !== undefined || patch.key_columns !== undefined) {
      set.destination = await this.checkDestination(p, patch.destination ?? r.destination, next.mode, next.key_columns);
      set.user_id = p.userId;
    }
    if (patch.headers !== undefined) {
      const headers = patch.headers ? this.checkHeaders(patch.headers) : {};
      const enc = Object.keys(headers).length ? this.cipher.encryptJson(headers, id) : null;
      Object.assign(set, { encrypted_secret: enc?.ciphertext ?? null, iv: enc?.iv ?? null, tag: enc?.tag ?? null });
    }
    if (patch.schedule !== undefined) set.schedule = this.checkSchedule(p, patch.schedule);
    if (patch.channel_ids !== undefined) set.channel_ids = await this.checkChannels(p, r.workspace_id, patch.channel_ids);
    if (patch.enabled !== undefined) set.enabled = patch.enabled;
    const merged = { ...r, ...set };
    if (patch.schedule !== undefined || patch.enabled !== undefined) set.next_run_at = merged.enabled ? nextRunAt(merged.schedule) : null;
    // A different query, destination or key starts change detection over.
    if (JSON.stringify([r.sql, r.destination, r.mode, r.key_columns]) !== JSON.stringify([merged.sql, merged.destination, merged.mode, merged.key_columns])) fs.rmSync(path.join(this.dir(id), 'state.parquet'), { force: true });
    await this.db.update(this.s.reverseSyncs).set(set).where(eq(this.s.reverseSyncs.id, id));
    this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'reverse_sync.update', resource: `reverse_sync:${id}`, ip: p.ip });
    return this.toPublic({ ...r, ...set });
  }

  async remove(p: Principal, id: string): Promise<void> {
    requireWrite(p);
    await this.load(p, id, 'EDITOR');
    await this.db.delete(this.s.reverseSyncs).where(eq(this.s.reverseSyncs.id, id));
    fs.rmSync(this.dir(id), { recursive: true, force: true });
    this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'reverse_sync.delete', resource: `reverse_sync:${id}`, ip: p.ip });
  }

  async runs(p: Principal, id: string, limit = 30): Promise<ReverseSyncRun[]> {
    await this.load(p, id);
    return this.db.select().from(this.s.reverseSyncRuns).where(eq(this.s.reverseSyncRuns.sync_id, id)).orderBy(desc(this.s.reverseSyncRuns.started_at)).limit(Math.min(limit, 200));
  }

  // ------------------------------------------------------------------------------------------ running

  /** The sync's author, read-only, as the runs use them. */
  private async runner(r: ReverseSync): Promise<Principal> {
    const owner = await this.auth.findActive(r.user_id);
    if (!owner) throw new Error('The sync\'s author no longer exists or has been deactivated');
    const p = this.auth.principalFromUser(owner, 'jwt', 'reverse-etl');
    return { ...p, scopes: p.scopes.filter((x) => x === 'read' || x === 'admin'), actorType: 'SYSTEM' };
  }

  /**
   * Runs the query into a staging file and opens a scratch engine over it with `src`, and — with key columns —
   * `cur` (rows + hash), `changed` and `gone` against the previous state.
   */
  private async stage<T>(r: ReverseSync, runId: string, fn: (conn: DuckDBConnection, info: { rows: number; columns: string[]; incremental: boolean; dir: string; staged: string }) => Promise<T>): Promise<T> {
    const dir = this.dir(r.id);
    fs.mkdirSync(dir, { recursive: true });
    const staged = path.join(dir, `stage-${runId}.parquet`);
    try {
      const { engine } = await this.workspaces.engine(await this.runner(r), r.workspace_id);
      const out = await engine.exportTo(r.sql, 'parquet', staged);
      if (out.rows > this.cfg.duckdb.export_max_rows) throw new Error(`The query returned more than duckdb.export_max_rows (${this.cfg.duckdb.export_max_rows}) rows`);
      const options: Record<string, string> = { threads: '2', memory_limit: '512MB' };
      if (this.cfg.duckdb.extension_directory) options.extension_directory = this.cfg.duckdb.extension_directory;
      const inst = await DuckDBInstance.create(':memory:', options);
      const conn = await inst.connect();
      try {
        await conn.run(`CREATE TEMP TABLE src AS SELECT * FROM read_parquet(${sqlString(staged)})`);
        const columns = ((await conn.runAndReadAll('SELECT column_name FROM (DESCRIBE src)')).getRowsJson() as string[][]).map((x) => String(x[0]));
        let incremental = false;
        if (r.key_columns.length) {
          const missing = r.key_columns.filter((k) => !columns.includes(k));
          if (missing.length) throw new Error(`The query has no column ${missing.join(', ')} (key columns); it returns ${columns.join(', ')}`);
          const keys = r.key_columns.map(qi).join(', ');
          const dup = Number((await conn.runAndReadAll(`SELECT count(*) FROM (SELECT ${keys} FROM src GROUP BY ALL HAVING count(*) > 1)`)).getRowsJson()[0]?.[0] ?? 0);
          if (dup) throw new Error(`The key columns (${r.key_columns.join(', ')}) are not unique: ${plural(dup, 'key')} appear more than once`);
          const nullKeys = Number((await conn.runAndReadAll(`SELECT count(*) FROM src WHERE ${r.key_columns.map((k) => `${qi(k)} IS NULL`).join(' OR ')}`)).getRowsJson()[0]?.[0] ?? 0);
          if (nullKeys) throw new Error(`${plural(nullKeys, 'row')} have a null key column`);
          await conn.run(`CREATE TEMP TABLE cur AS SELECT s.*, md5(CAST(to_json(s) AS VARCHAR)) AS ${HASH} FROM src AS s`);
          const state = path.join(dir, 'state.parquet');
          incremental = fs.existsSync(state) && (r.mode === 'upsert' || r.mode === 'mirror');
          if (incremental) await conn.run(`CREATE TEMP TABLE prev AS SELECT * FROM read_parquet(${sqlString(state)})`);
          else await conn.run(`CREATE TEMP TABLE prev AS SELECT ${keys}, ${HASH} FROM cur LIMIT 0`);
          const on = r.key_columns.map((k) => `p.${qi(k)} IS NOT DISTINCT FROM c.${qi(k)}`).join(' AND ');
          await conn.run(`CREATE TEMP TABLE changed AS SELECT c.* EXCLUDE (${HASH}) FROM cur AS c WHERE NOT EXISTS (SELECT 1 FROM prev AS p WHERE ${on} AND p.${HASH} = c.${HASH})`);
          await conn.run(`CREATE TEMP TABLE gone AS SELECT ${r.key_columns.map((k) => `p.${qi(k)}`).join(', ')} FROM prev AS p WHERE NOT EXISTS (SELECT 1 FROM cur AS c WHERE ${on})`);
        }
        return await fn(conn, { rows: out.rows, columns, incremental, dir, staged });
      } finally {
        conn.closeSync();
        inst.closeSync();
      }
    } finally {
      fs.rmSync(staged, { force: true });
    }
  }

  /** Which rows a run sends (`rows`) and deletes (`gone`) under the sync's mode. */
  private relations(r: ReverseSync, incremental: boolean): { send: string; del: string | null } {
    if ((r.mode === 'upsert' || r.mode === 'mirror') && r.key_columns.length) return { send: incremental ? 'changed' : 'src', del: r.mode === 'mirror' && incremental ? 'gone' : null };
    return { send: 'src', del: null };
  }

  private async count(conn: DuckDBConnection, rel: string | null): Promise<number> {
    if (!rel) return 0;
    return Number((await conn.runAndReadAll(`SELECT count(*) FROM ${rel}`)).getRowsJson()[0]?.[0] ?? 0);
  }

  private async destinationLabel(r: ReverseSync): Promise<string> {
    if (r.destination.kind === 'iceberg') {
      const lh = await this.lakehouse.getOwned(r.user_id, r.destination.connection_id).catch(() => null);
      return describeDestination(r.destination, { connection: lh?.name });
    }
    if (r.destination.kind !== 'database') return describeDestination(r.destination);
    const c = await this.databases.getOwned(r.user_id, r.destination.connection_id).catch(() => null);
    return describeDestination(r.destination, { connection: c?.name });
  }

  /** What the next run would send, without sending anything. */
  async plan(p: Principal, id: string): Promise<ReversePlan> {
    const r = await this.load(p, id);
    return this.stage(r, `plan-${newId()}`, async (conn, info) => {
      const rel = this.relations(r, info.incremental);
      const sample = (await conn.runAndReadAll(`SELECT * FROM ${rel.send} LIMIT 5`)).getRowObjectsJson() as Record<string, unknown>[];
      return { rows_read: info.rows, to_send: await this.count(conn, rel.send), to_delete: await this.count(conn, rel.del), columns: info.columns, sample, incremental: info.incremental, destination: await this.destinationLabel(r) };
    });
  }

  private async challenge(p: Principal, r: ReverseSync): Promise<ApprovalChallenge> {
    const plan = await this.plan(p, r.id);
    const what = `${plural(plan.to_send, 'row')}${plan.to_delete ? ` and ${plural(plan.to_delete, 'deletion')}` : ''}`;
    return {
      status: 'approval_required',
      reason: `Reverse sync "${r.name}" would send ${what} out of the workspace to ${plan.destination} (${r.mode}${plan.incremental ? ', changes since the last run' : ''}).`,
      statement_classes: ['write'],
      mutating_verbs: [r.destination.kind === 'http' ? 'POST' : r.mode === 'replace' ? 'REPLACE' : r.mode === 'append' ? 'INSERT' : 'UPSERT'],
      statements: [{ index: 0, verb: r.mode.toUpperCase(), class: 'write', preview: `${r.mode} ${what} → ${plan.destination}; columns ${plan.columns.join(', ')}` }],
      how_to_proceed: 'Show this to the human operator. If they approve, call run_reverse_sync again with the same sync_id and dry_run: false.',
    };
  }

  /** Runs a sync now: a person, an agent (after approval) or the scheduler. */
  async run(id: string, triggeredBy: 'manual' | 'schedule' | 'agent', p: Principal | null = null, opts: { approved?: boolean } = {}): Promise<ReverseSyncRun> {
    const r = p ? await this.load(p, id, 'EDITOR') : (await this.db.select().from(this.s.reverseSyncs).where(eq(this.s.reverseSyncs.id, id)).limit(1))[0];
    if (!r) throw notFound('Reverse sync');
    if (p && p.actorType === 'AGENT' && this.cfg.mcp.require_confirmation_for_mutations && !opts.approved) throw new HitlBlocked(await this.challenge(p, r));
    if (this.running.has(id)) throw conflict('This sync is running right now');
    this.running.add(id);
    const started = new Date();
    const run: ReverseSyncRun = { id: newId(), sync_id: id, workspace_id: r.workspace_id, status: 'running', triggered_by: triggeredBy, actor_id: p?.userId ?? null, rows_read: null, rows_sent: null, rows_deleted: null, summary: null, error: null, duration_ms: null, started_at: started, finished_at: null };
    await this.db.insert(this.s.reverseSyncRuns).values(run);
    await this.db.update(this.s.reverseSyncs).set({ last_run: { run_id: run.id, status: 'running', started_at: started.toISOString(), finished_at: null, rows: null, error: null, summary: null } }).where(eq(this.s.reverseSyncs.id, id));
    liveEvents.publish({ type: 'reverse_sync', at: started.toISOString(), workspace_id: r.workspace_id, sync_id: id, run_id: run.id, status: 'running', summary: null });
    const prevStatus = r.last_run?.status ?? null;
    try {
      const result = await this.stage(r, run.id, async (conn, info) => {
        const rel = this.relations(r, info.incremental);
        const toSend = await this.count(conn, rel.send);
        const toDelete = await this.count(conn, rel.del);
        const sent = await this.deliver(conn, r, rel, info, run.id, toSend, toDelete);
        // Only after a successful delivery: what the destination now holds, for the next run's change detection.
        if (r.key_columns.length && (r.mode === 'upsert' || r.mode === 'mirror')) {
          const tmp = path.join(info.dir, `state-${run.id}.parquet`);
          await conn.run(`COPY (SELECT ${r.key_columns.map(qi).join(', ')}, ${HASH} FROM cur) TO ${sqlString(tmp)} (FORMAT PARQUET)`);
          fs.renameSync(tmp, path.join(info.dir, 'state.parquet'));
        }
        return { rows_read: info.rows, ...sent };
      });
      const summary = `${plural(result.rows_sent, 'row')} ${r.destination.kind === 'http' ? 'sent' : 'written'}${result.rows_deleted ? `, ${plural(result.rows_deleted, 'row')} deleted` : ''}${result.rows_sent !== result.rows_read ? ` (of ${result.rows_read.toLocaleString('en-US')} read)` : ''}${result.detail ? ` — ${result.detail}` : ''}.`;
      return await this.finish(r, run, { status: 'ok', rows_read: result.rows_read, rows_sent: result.rows_sent, rows_deleted: result.rows_deleted, summary, error: null }, prevStatus);
    } catch (err) {
      return await this.finish(r, run, { status: 'error', error: firstLine(err), summary: null }, prevStatus);
    } finally {
      this.running.delete(id);
    }
  }

  private async finish(r: ReverseSync, run: ReverseSyncRun, out: Partial<ReverseSyncRun>, prevStatus: string | null): Promise<ReverseSyncRun> {
    const finished = new Date();
    const done: ReverseSyncRun = { ...run, ...out, duration_ms: finished.getTime() - run.started_at.getTime(), finished_at: finished };
    await this.db.update(this.s.reverseSyncRuns).set(done).where(eq(this.s.reverseSyncRuns.id, run.id));
    await this.db.update(this.s.reverseSyncs).set({ last_run: { run_id: run.id, status: done.status, started_at: run.started_at.toISOString(), finished_at: finished.toISOString(), rows: done.rows_sent, error: done.error, summary: done.summary } }).where(eq(this.s.reverseSyncs.id, r.id));
    this.audit.log({ userId: run.actor_id ?? r.user_id, actorType: run.triggered_by === 'agent' ? 'AGENT' : run.triggered_by === 'schedule' ? 'SYSTEM' : 'USER', action: 'reverse_sync.run', resource: `reverse_sync:${r.id}`, queryText: r.sql, durationMs: done.duration_ms ?? undefined, status: done.status === 'ok' ? 'ok' : 'error', error: done.error ?? undefined });
    const old = await this.db.select({ id: this.s.reverseSyncRuns.id }).from(this.s.reverseSyncRuns).where(and(eq(this.s.reverseSyncRuns.sync_id, r.id), lt(this.s.reverseSyncRuns.started_at, new Date(Date.now() - 90 * 86_400_000))));
    for (const o of old) await this.db.delete(this.s.reverseSyncRuns).where(eq(this.s.reverseSyncRuns.id, o.id));
    liveEvents.publish({ type: 'reverse_sync', at: finished.toISOString(), workspace_id: r.workspace_id, sync_id: r.id, run_id: run.id, status: done.status as 'ok' | 'error', summary: done.summary ?? done.error });
    // Failures (and the first success after one) go to the sync's channels.
    const failing = done.status === 'error' && prevStatus !== 'error';
    const recovered = done.status === 'ok' && prevStatus === 'error';
    if ((failing || recovered) && r.channel_ids.length) {
      const ws = (await this.db.select({ name: this.s.workspaces.name }).from(this.s.workspaces).where(eq(this.s.workspaces.id, r.workspace_id)).limit(1))[0];
      await this.notifications.send(r.channel_ids, {
        title: failing ? `Reverse sync failing: ${r.name}` : `Reverse sync working again: ${r.name}`,
        text: failing ? `The run failed: ${done.error}` : done.summary ?? '',
        severity: failing ? 'warning' : 'resolved',
        event: failing ? 'reverse_sync.failed' : 'reverse_sync.recovered',
        dedupKey: `duckview-reverse-${r.id}`,
        url: this.notifications.link(`/#/connections/reverse?sync=${r.id}`),
        fields: [{ label: 'Destination', value: await this.destinationLabel(r) }, { label: 'Mode', value: r.mode }, ...(ws ? [{ label: 'Workspace', value: ws.name }] : [])],
        workspace: ws ? { id: r.workspace_id, name: ws.name } : null,
      }, `reverse_sync:${r.id}`, r.workspace_id).catch((err) => logger().warn({ err: (err as Error).message }, 'Reverse sync notification failed'));
    }
    return done;
  }

  // ------------------------------------------------------------------------------------------ destinations

  private async deliver(conn: DuckDBConnection, r: ReverseSync, rel: { send: string; del: string | null }, info: { columns: string[] }, runId: string, toSend: number, toDelete: number): Promise<{ rows_sent: number; rows_deleted: number; detail?: string }> {
    const d = r.destination;
    if (d.kind === 'database') return this.toDatabase(conn, r, d, rel, info.columns, toSend, toDelete);
    if (d.kind === 'file') return this.toFile(conn, r, d, runId, toSend);
    if (d.kind === 'iceberg') return this.toIceberg(conn, r, d, rel, info.columns, toSend, toDelete);
    if (d.kind === 'delta') return this.toDelta(conn, r, d, runId);
    return this.toHttp(conn, r, d, rel, runId, toSend, toDelete);
  }

  private async toDatabase(conn: DuckDBConnection, r: ReverseSync, d: Extract<ReverseDestination, { kind: 'database' }>, rel: { send: string; del: string | null }, columns: string[], toSend: number, toDelete: number) {
    const c = await this.databases.getOwned(r.user_id, d.connection_id).catch(() => {
      throw new Error('The destination connection no longer exists (or belongs to someone else)');
    });
    if (c.config.read_only !== false) throw new Error(`The connection "${c.name}" is read-only`);
    const spec = this.databases.attachSpec(c);
    for (const ext of spec.extensions) {
      await conn.run(`LOAD ${ext}`).catch(async () => {
        await conn.run(`INSTALL ${ext}`);
        await conn.run(`LOAD ${ext}`);
      });
    }
    const alias = 'dv_dest';
    await conn.run(attachToSql({ ...spec, alias, options: Object.fromEntries(Object.entries(spec.options).filter(([k]) => k !== 'read_only')) }, false));
    const schema = d.schema || (c.engine === 'postgres' ? 'public' : 'main');
    const target = `${alias}.${qi(schema)}.${qi(d.table)}`;
    const exists = Number((await conn.runAndReadAll(`SELECT count(*) FROM duckdb_tables() WHERE database_name = ${sqlString(alias)} AND schema_name = ${sqlString(schema)} AND table_name = ${sqlString(d.table)}`)).getRowsJson()[0]?.[0] ?? 0) > 0;
    const cols = columns.map(qi).join(', ');
    const keyMatch = (from: string) => `(${r.key_columns.map(qi).join(', ')}) IN (SELECT ${r.key_columns.map(qi).join(', ')} FROM ${from})`;
    if (!exists || r.mode === 'replace') {
      // A new table (or a full replace) takes every row, whatever the mode.
      await conn.run('BEGIN TRANSACTION');
      if (exists) await conn.run(`DROP TABLE ${target}`);
      await conn.run(`CREATE TABLE ${target} AS SELECT ${cols} FROM src`);
      await conn.run('COMMIT');
      const n = await this.count(conn, 'src');
      return { rows_sent: n, rows_deleted: 0, detail: exists ? undefined : `created ${schema}.${d.table}` };
    }
    await conn.run('BEGIN TRANSACTION');
    try {
      if (r.mode === 'append') await conn.run(`INSERT INTO ${target} (${cols}) SELECT ${cols} FROM src`);
      else {
        if (toSend) {
          await conn.run(`DELETE FROM ${target} WHERE ${keyMatch(rel.send)}`);
          await conn.run(`INSERT INTO ${target} (${cols}) SELECT ${cols} FROM ${rel.send}`);
        }
        if (rel.del && toDelete) await conn.run(`DELETE FROM ${target} WHERE ${keyMatch(rel.del)}`);
      }
      await conn.run('COMMIT');
    } catch (err) {
      await conn.run('ROLLBACK').catch(() => undefined);
      throw err;
    }
    return { rows_sent: r.mode === 'append' ? await this.count(conn, 'src') : toSend, rows_deleted: rel.del ? toDelete : 0 };
  }

  private async loadExtension(conn: DuckDBConnection, ext: string): Promise<void> {
    await conn.run(`LOAD ${ext}`).catch(async () => {
      await conn.run(`INSTALL ${ext}`);
      await conn.run(`LOAD ${ext}`);
    });
  }

  /** src's columns as the format can store them. */
  private async castSelect(conn: DuckDBConnection, format: 'iceberg' | 'delta'): Promise<{ select: string; columns: { name: string; type: string }[] }> {
    const described = (await conn.runAndReadAll('SELECT column_name, column_type FROM (DESCRIBE src)')).getRowsJson() as string[][];
    const cols = described.map(([name, type]) => ({ name: String(name), ...castFor(format, String(name), String(type)) }));
    return { select: cols.map((c) => c.sql).join(', '), columns: cols.map((c) => ({ name: c.name, type: c.type })) };
  }

  private async toIceberg(conn: DuckDBConnection, r: ReverseSync, d: Extract<ReverseDestination, { kind: 'iceberg' }>, rel: { send: string; del: string | null }, columns: string[], toSend: number, toDelete: number) {
    const bits = await this.lakehouse.engineBitsFor(r.user_id, d.connection_id).catch(() => {
      throw new Error('The destination lakehouse connection no longer exists (or belongs to someone else)');
    });
    const attachment = bits.attachments[0];
    if (!attachment) throw new Error('This lakehouse connection has no Iceberg catalog to write to');
    for (const ext of attachment.extensions ?? ['httpfs', 'iceberg']) await this.loadExtension(conn, ext);
    for (const sec of bits.secrets) {
      const sql = secretToSql(sec);
      if (sql) await conn.run(sql);
    }
    if (d.storage_connection_id) {
      const c = await this.cloud.getOwned(r.user_id, d.storage_connection_id).catch(() => {
        throw new Error('The storage cloud connection no longer exists');
      });
      const sql = secretToSql({ ...this.cloud.toSecret(c), name: 'dv_storage' });
      if (sql) await conn.run(sql);
    }
    const alias = 'dv_ice';
    await conn.run(attachToSql({ ...attachment, alias, options: Object.fromEntries(Object.entries(attachment.options).filter(([k]) => k.toLowerCase() !== 'read_only')) }, false));
    const ns = d.namespace.split('.').map(qi).join('.');
    const target = `${alias}.${ns}.${qi(d.table)}`;
    await conn.run(`CREATE SCHEMA IF NOT EXISTS ${alias}.${ns}`);
    const exists = Number((await conn.runAndReadAll(`SELECT count(*) FROM duckdb_tables() WHERE database_name = ${sqlString(alias)} AND schema_name = ${sqlString(d.namespace)} AND table_name = ${sqlString(d.table)}`)).getRowsJson()[0]?.[0] ?? 0) > 0;
    const { select } = await this.castSelect(conn, 'iceberg');
    const cols = columns.map(qi).join(', ');
    const keyMatch = (from: string) => `(${r.key_columns.map(qi).join(', ')}) IN (SELECT ${r.key_columns.map(qi).join(', ')} FROM ${from})`;
    if (!exists || r.mode === 'replace') {
      if (exists) await conn.run(`DROP TABLE ${target}`);
      await conn.run(`CREATE TABLE ${target} AS SELECT ${select} FROM src`);
      return { rows_sent: await this.count(conn, 'src'), rows_deleted: 0, detail: exists ? `replaced ${d.namespace}.${d.table}` : `created ${d.namespace}.${d.table}` };
    }
    // One Iceberg transaction: readers see the old snapshot or the new one.
    await conn.run('BEGIN TRANSACTION');
    try {
      if (r.mode === 'append') await conn.run(`INSERT INTO ${target} (${cols}) SELECT ${select} FROM src`);
      else {
        if (toSend) {
          await conn.run(`DELETE FROM ${target} WHERE ${keyMatch(rel.send)}`);
          await conn.run(`INSERT INTO ${target} (${cols}) SELECT ${select} FROM ${rel.send}`);
        }
        if (rel.del && toDelete) await conn.run(`DELETE FROM ${target} WHERE ${keyMatch(rel.del)}`);
      }
      await conn.run('COMMIT');
    } catch (err) {
      await conn.run('ROLLBACK').catch(() => undefined);
      throw err;
    }
    return { rows_sent: r.mode === 'append' ? await this.count(conn, 'src') : toSend, rows_deleted: rel.del ? toDelete : 0 };
  }

  private async toDelta(conn: DuckDBConnection, r: ReverseSync, d: Extract<ReverseDestination, { kind: 'delta' }>, runId: string) {
    await this.loadExtension(conn, 'delta');
    const { select, columns } = await this.castSelect(conn, 'delta');
    const rows = await this.count(conn, 'src');
    // Where the table lives, and how to list its log and put a file there.
    let location: string;
    let listLog: () => Promise<string[]>;
    let put: (rel: string, fromFile: string) => Promise<void>;
    let putCommit: (name: string, body: string) => Promise<void>;
    const local = !d.cloud_connection_id;
    if (local) {
      const root = this.engines.jail.resolve(d.path).absolute;
      location = root;
      fs.mkdirSync(path.join(root, '_delta_log'), { recursive: true });
      listLog = async () => fs.readdirSync(path.join(root, '_delta_log'));
      put = async (rel2, from) => void fs.renameSync(from, path.join(root, rel2));
      // A commit file is created only if it does not exist: two writers cannot both write version N.
      putCommit = async (name, body) => fs.writeFileSync(path.join(root, '_delta_log', name), body, { flag: 'wx' });
    } else {
      const c = await this.cloud.getOwned(r.user_id, d.cloud_connection_id!).catch(() => {
        throw new Error('The destination cloud connection no longer exists (or belongs to someone else)');
      });
      const bucket = d.bucket ?? c.bucket ?? '';
      const secret = secretToSql({ ...this.cloud.toSecret(c), name: 'dv_delta_storage' });
      if (secret) await conn.run(secret);
      await this.loadExtension(conn, 'httpfs');
      const scheme = this.cloud.uriScheme(c);
      location = `${scheme}://${bucket}/${d.path}`;
      listLog = async () => {
        const names: string[] = [];
        let token: string | undefined;
        do {
          const page = await this.cloud.listObjects(c, bucket, `${d.path}/_delta_log/`, { continuationToken: token });
          names.push(...page.entries.map((e) => e.name));
          token = page.next_token ?? undefined;
        } while (token);
        return names;
      };
      put = async (rel2, from) => void (await this.cloud.uploadObject(c, bucket, `${d.path}/${rel2}`, from));
      putCommit = async (name, body) => {
        const tmp = path.join(this.dir(r.id), `commit-${runId}.json`);
        fs.writeFileSync(tmp, body);
        try {
          await this.cloud.uploadObject(c, bucket, `${d.path}/_delta_log/${name}`, tmp);
        } finally {
          fs.rmSync(tmp, { force: true });
        }
      };
    }
    const latest = latestDeltaVersion(await listLog());
    if (latest >= 0 && r.mode === 'append') {
      // Remote tables attach read-only unless asked otherwise.
      await conn.run(`ATTACH ${sqlString(location)} AS dv_delta (TYPE delta, READ_ONLY false)`);
      await conn.run(`INSERT INTO dv_delta SELECT ${select} FROM src`);
      return { rows_sent: rows, rows_deleted: 0, detail: `appended to ${d.path}` };
    }
    // A new table, or a replace: DuckView writes the commit.
    const remove = latest >= 0 ? ((await conn.runAndReadAll(`SELECT data_file FROM delta_list_files(${sqlString(location)})`)).getRowsJson() as string[][]).map((x) => String(x[0]).replace(/^file:\/\//, '').slice(location.length).replace(/^\/+/, '')) : [];
    const file = newDataFile();
    const tmp = path.join(this.dir(r.id), `${runId}-${file}`);
    await conn.run(`COPY (SELECT ${select} FROM src) TO ${sqlString(tmp)} (FORMAT parquet, COMPRESSION zstd)`);
    const size = fs.statSync(tmp).size;
    try {
      await put(file, tmp);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    const version = latest + 1;
    await putCommit(deltaLogName(version), deltaCommit({ tableId: r.id, columns, create: latest < 0, replace: latest >= 0, remove, add: { path: file, size, rows } }));
    return { rows_sent: rows, rows_deleted: 0, detail: `${latest < 0 ? 'created' : 'replaced'} ${d.path} (version ${version})` };
  }

  private async toFile(conn: DuckDBConnection, r: ReverseSync, d: Extract<ReverseDestination, { kind: 'file' }>, runId: string, toSend: number) {
    const ext = d.format === 'json' ? 'json' : d.format;
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    // append: one new file per run — {run} / {date} in the path, or a timestamp before the extension.
    let rel = d.path.replace(/\{date\}/g, stamp.slice(0, 8)).replace(/\{run\}/g, stamp);
    if (r.mode === 'append' && rel === d.path) rel = rel.replace(/(\.[A-Za-z0-9]+)?$/, (m) => `_${stamp}${m || `.${ext}`}`);
    const options = d.format === 'parquet' ? '(FORMAT PARQUET, COMPRESSION ZSTD)' : d.format === 'csv' ? '(FORMAT CSV, HEADER TRUE)' : '(FORMAT JSON, ARRAY TRUE)';
    if (!d.cloud_connection_id) {
      const target = this.engines.jail.resolve(rel).absolute;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const tmp = `${target}.dv-${runId}.tmp`;
      await conn.run(`COPY src TO ${sqlString(tmp)} ${options}`);
      fs.renameSync(tmp, target);
      return { rows_sent: toSend, rows_deleted: 0, detail: rel };
    }
    const c = await this.cloud.getOwned(r.user_id, d.cloud_connection_id).catch(() => {
      throw new Error('The destination cloud connection no longer exists (or belongs to someone else)');
    });
    const tmp = path.join(this.dir(r.id), `upload-${runId}.${ext}`);
    try {
      await conn.run(`COPY src TO ${sqlString(tmp)} ${options}`);
      await this.cloud.uploadObject(c, d.bucket ?? c.bucket ?? '', rel.replace(/^\/+/, ''), tmp);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    return { rows_sent: toSend, rows_deleted: 0, detail: `${d.bucket ?? c.bucket}/${rel.replace(/^\/+/, '')}` };
  }

  private async toHttp(conn: DuckDBConnection, r: ReverseSync, d: Extract<ReverseDestination, { kind: 'http' }>, rel: { send: string; del: string | null }, runId: string, toSend: number, toDelete: number) {
    const size = d.batch_size ?? 500;
    const headers = this.headers(r);
    const batches = Math.ceil(toSend / size) + Math.ceil(toDelete / size);
    let n = 0;
    // Rows as DuckDB's own JSON (numbers stay numbers, BIGINTs keep every digit), assembled without re-parsing.
    const post = async (op: 'upsert' | 'delete', rows: string[]) => {
      n++;
      const payload = d.payload ?? 'object';
      const marked = op === 'delete' && payload !== 'object' ? rows.map((x) => `${x.slice(0, -1)}${x.length > 2 ? ',' : ''}"_deleted":true}`) : rows;
      const body = payload === 'ndjson' ? marked.join('\n') + '\n' : payload === 'array' ? `[${marked.join(',')}]` : `{"sync":${JSON.stringify(r.name)},"sync_id":${JSON.stringify(r.id)},"run_id":${JSON.stringify(runId)},"mode":${JSON.stringify(r.mode)},"op":"${op}","batch":${n},"batches":${batches},"rows":[${rows.join(',')}]}`;
      const res = await egressPost(d.url, body, { 'content-type': payload === 'ndjson' ? 'application/x-ndjson' : 'application/json', 'user-agent': 'DuckView-ReverseETL/1', 'idempotency-key': `${runId}-${n}`, ...headers }, { allowPrivate: this.cfg.notifications.allow_private_targets, allowHttp: this.cfg.notifications.allow_private_targets, timeoutMs: this.cfg.notifications.timeout_seconds * 1000 });
      if (res.status < 200 || res.status >= 300) throw new Error(`The API answered ${res.status} to batch ${n} of ${batches}: ${res.body.slice(0, 200)}`);
    };
    const page = async (relName: string, off: number) => ((await conn.runAndReadAll(`SELECT CAST(to_json(t) AS VARCHAR) FROM (SELECT * FROM ${relName} LIMIT ${size} OFFSET ${off}) AS t`)).getRowsJson() as string[][]).map((x) => String(x[0]));
    for (let off = 0; off < toSend; off += size) await post('upsert', await page(rel.send, off));
    if (rel.del) for (let off = 0; off < toDelete; off += size) await post('delete', await page(rel.del, off));
    return { rows_sent: toSend, rows_deleted: rel.del ? toDelete : 0, detail: n ? `${plural(n, 'request')}` : 'nothing changed' };
  }

  /** For Copilot: what leaves the workspace, where to, and how the last run went. */
  async promptSummary(workspaceId: string): Promise<string> {
    const rows = await this.db.select().from(this.s.reverseSyncs).where(eq(this.s.reverseSyncs.workspace_id, workspaceId));
    const lines: string[] = [];
    for (const r of rows.slice(0, 30)) lines.push(`- ${r.name}: ${r.mode}${r.key_columns.length ? ` on ${r.key_columns.join(', ')}` : ''} → ${await this.destinationLabel(r)}; ${r.last_run ? `last run ${r.last_run.status}${r.last_run.error ? `: ${r.last_run.error}` : r.last_run.summary ? `: ${r.last_run.summary}` : ''}` : 'never run'}\n  SQL: ${r.sql.replace(/\s+/g, ' ').slice(0, 300)}`);
    return lines.join('\n');
  }

  // ------------------------------------------------------------------------------------------ scheduling

  async tick(now = new Date()): Promise<string[]> {
    const due = await this.db.select().from(this.s.reverseSyncs).where(and(eq(this.s.reverseSyncs.enabled, true), isNotNull(this.s.reverseSyncs.next_run_at), lte(this.s.reverseSyncs.next_run_at, now)));
    const ran: string[] = [];
    for (const r of due) {
      await this.db.update(this.s.reverseSyncs).set({ next_run_at: nextRunAt(r.schedule, now) }).where(eq(this.s.reverseSyncs.id, r.id));
      try {
        await this.run(r.id, 'schedule');
        ran.push(r.id);
      } catch (err) {
        logger().warn({ sync: r.id, err: (err as Error).message }, 'Reverse sync failed to start');
      }
    }
    return ran;
  }

  start(intervalMs = 30_000): void {
    if (this.ticker) return;
    this.ticker = setInterval(() => void this.tick().catch((err) => logger().warn({ err: (err as Error).message }, 'Reverse ETL scheduler tick failed')), intervalMs);
    this.ticker.unref();
  }

  stop(): void {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
  }
}
