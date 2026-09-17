/**
 * DuckDB engine management.
 *
 * One DuckDBInstance per workspace (lazily created, LRU-cached, idle-evicted). Each query runs on a
 * fresh connection so that `interrupt()` (timeouts / cancellation) is scoped to that query and
 * concurrent queries in the same workspace do not serialise.
 *
 * Hardening sequence (applied once per instance, before any user SQL):
 *   1. startup options: memory_limit, threads, temp_directory, extension autoload/autoinstall off
 *   2. optional: LOAD allow-listed extensions, CREATE SECRET from decrypted DataConnections
 *   3. SET allowed_directories = [jail, temp]   (only honoured by DuckDB when external access is off)
 *   4. SET enable_external_access = <config>    (false by default)
 *   5. SET lock_configuration = true            (no further SET/PRAGMA on any connection)
 */
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { DuckDBInstance, type DuckDBConnection, type DuckDBResultReader } from '@duckdb/node-api';
import { writeArrowStream } from './arrow-export.js';
import type { DuckViewConfig } from '../config/index.js';
import type { EngineSettings } from '../db/schema/sqlite.js';
import { DataJail, SandboxViolation, isRemoteUri, looksLikePath } from './sandbox.js';
import { guardSql, isWrappableSelect, stripTrailingSemicolon, type SqlAnalysis } from './sql-guard.js';
import { readerToResult, type QueryResult, normalizeValue, type ColumnSchema, kindOf } from './results.js';
import { metrics } from '../observability/metrics.js';
import { withSpan } from '../observability/tracing.js';
import { logger } from '../observability/logger.js';

export class QueryTimeoutError extends Error {
  readonly code = 'QUERY_TIMEOUT';
  constructor(readonly timeoutMs: number) {
    super(`Query exceeded the ${Math.round(timeoutMs / 1000)}s timeout and was interrupted`);
    this.name = 'QueryTimeoutError';
  }
}

export class QueryCancelledError extends Error {
  readonly code = 'QUERY_CANCELLED';
  constructor() {
    super('Query was cancelled');
    this.name = 'QueryCancelledError';
  }
}

export interface SecretSpec {
  name: string;
  type: 'MOTHERDUCK' | 'S3' | 'R2' | 'POSTGRES' | 'GCS' | 'AZURE' | 'HTTP' | 'ICEBERG';
  values: Record<string, string>;
}

/** A catalog attached to the engine (ATTACH … AS alias (TYPE ICEBERG, …)) — lakehouse connections. */
export interface AttachSpec {
  alias: string;
  target: string;
  /** ATTACH options; booleans render bare, strings are quoted. TYPE is always ICEBERG for now. */
  options: Record<string, string | boolean>;
  /** Extensions that must be loaded before attaching (iceberg, httpfs, aws…). */
  extensions: string[];
}

export type ExportFormat = 'parquet' | 'csv' | 'json' | 'arrow';
export const EXPORT_EXTENSIONS: Record<ExportFormat, string> = { parquet: 'parquet', csv: 'csv', json: 'json', arrow: 'arrows' };

export interface InspectResult {
  target: string;
  kind: 'table' | 'file' | 'remote' | 'query' | 'database';
  columns: { name: string; type: string; nullable: boolean }[];
  /** Exact for Parquet (footer metadata) and in-database tables; null when unknown without a scan. */
  row_count: number | null;
  row_count_source: 'parquet_metadata' | 'catalog' | 'count' | null;
  size_bytes: number | null;
  /** For .duckdb files: every table with its columns. */
  tables?: { name: string; schema: string; columns: { name: string; type: string; nullable: boolean }[] }[];
  suggested_sql: string;
}

export interface EngineSpec {
  workspaceId: string;
  /** ':memory:' | path inside jail | 'md:...' */
  dbPath: string;
  settings: EngineSettings;
  secrets: SecretSpec[];
  /** Lakehouse catalogs to attach (hot-applied like secrets). */
  attachments?: AttachSpec[];
}

export interface ExecuteOptions {
  maxRows?: number;
  timeoutMs?: number;
  /** Compute total row count with a wrapped COUNT(*) (read queries only). */
  countTotal?: boolean;
  /** 1-based page for read queries; applied via LIMIT/OFFSET on a wrapped subquery. */
  page?: number;
  signal?: AbortSignal;
  actor?: 'user' | 'agent' | 'system';
}

export interface CatalogObject {
  database: string;
  schema: string;
  name: string;
  type: 'TABLE' | 'VIEW';
  estimated_rows: number | null;
  column_count: number;
  sql: string | null;
  columns: { name: string; type: string; nullable: boolean }[];
}

export interface EngineResources {
  host: { cpus: number; total_memory_bytes: number; free_memory_bytes: number; platform: string; load_average: number[] };
  duckdb: { version: string; memory_limit: string; memory_limit_bytes: number; threads: number; temp_directory: string; external_access: boolean; configuration_locked: boolean };
  temp_disk: { path: string; free_bytes: number | null; total_bytes: number | null };
  data_jail: { path: string; free_bytes: number | null; total_bytes: number | null };
  engines_active: number;
}

export function sqlString(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

export function resolveMemoryLimit(spec: string | undefined): { display: string; bytes: number } {
  const total = os.totalmem();
  const s = (spec ?? '80%').trim();
  const pct = /^(\d+(?:\.\d+)?)\s*%$/.exec(s);
  if (pct) {
    const bytes = Math.floor((total * Number(pct[1])) / 100);
    return { display: `${Math.floor(bytes / 1048576)}MB`, bytes };
  }
  const m = /^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB|KIB|MIB|GIB|TIB)?$/i.exec(s);
  if (m) {
    const n = Number(m[1]);
    const unit = (m[2] ?? 'B').toUpperCase();
    const mult: Record<string, number> = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12, KIB: 1024, MIB: 1024 ** 2, GIB: 1024 ** 3, TIB: 1024 ** 4 };
    const bytes = Math.floor(n * (mult[unit] ?? 1));
    return { display: s, bytes };
  }
  throw new Error(`Invalid memory limit "${spec}" — use e.g. "8GB" or "80%"`);
}

export function resolveThreads(spec: number | 'auto' | undefined): number {
  const max = os.availableParallelism?.() ?? os.cpus().length;
  if (spec === undefined || spec === 'auto') return max;
  return Math.max(1, Math.min(Number(spec) || max, max));
}

function diskFree(p: string): { free_bytes: number | null; total_bytes: number | null } {
  try {
    const st = fs.statfsSync(p);
    return { free_bytes: Number(st.bavail) * Number(st.bsize), total_bytes: Number(st.blocks) * Number(st.bsize) };
  } catch {
    return { free_bytes: null, total_bytes: null };
  }
}

function fileSize(p: string | null): number | null {
  if (!p || /[*?\[\]{}]/.test(p)) return null;
  try {
    return fs.statSync(p).size;
  } catch {
    return null;
  }
}

function fmtNum(n: number): string {
  if (Math.abs(n) >= 1e6 || (Math.abs(n) < 1e-3 && n !== 0)) return n.toExponential(1);
  return Number.isInteger(n) ? String(n) : n.toFixed(Math.abs(n) < 10 ? 2 : 1);
}

export interface OverviewColumn {
  name: string;
  type: string;
  kind: ColumnSchema['kind'];
  null_percentage: number;
  approx_unique: number | null;
  min: string | null;
  max: string | null;
  avg: number | null;
  q50: string | null;
  distribution:
    | { kind: 'histogram'; bins: { lo: number; hi: number; label: string; count: number }[] }
    | { kind: 'categories'; bins: { label: string; count: number }[]; other: number }
    | { kind: 'timeline'; unit: string; bins: { label: string; count: number }[] }
    | null;
}

export interface OverviewResult {
  target: string;
  kind: 'table' | 'file' | 'remote' | 'query';
  row_count: number;
  column_count: number;
  size_bytes: number | null;
  null_cell_ratio: number;
  duplicate_rows: number | null;
  columns: OverviewColumn[];
  sample: { columns: ColumnSchema[]; rows: unknown[][] };
  duration_ms: number;
}

/** Identity of the engine process: database path + resource settings. Changing these requires a restart. */
export function fingerprint(spec: EngineSpec): string {
  return JSON.stringify([spec.dbPath, spec.settings]);
}
/** Secrets can be hot-applied to a running engine (CREATE OR REPLACE SECRET) without losing in-memory state. */
export function secretsFingerprint(secrets: SecretSpec[]): string {
  return JSON.stringify(secrets.map((s) => [s.name, s.type, Object.entries(s.values).sort()]));
}
export function attachmentsFingerprint(attachments: AttachSpec[] | undefined): string {
  return JSON.stringify((attachments ?? []).map((a) => [a.alias, a.target, Object.entries(a.options).sort()]));
}

/** Renders ATTACH for a lakehouse catalog. Exported for tests. */
export function attachToSql(a: AttachSpec, ifNotExists = true): string {
  const alias = a.alias.replace(/[^A-Za-z0-9_]/g, '_');
  const opts = Object.entries(a.options)
    .filter(([, v]) => v !== undefined && v !== '' && v !== false)
    .map(([k, v]) => (v === true ? `${k.toUpperCase()} true` : k.toUpperCase() === 'SECRET' ? `SECRET ${String(v).replace(/[^A-Za-z0-9_]/g, '_')}` : `${k.toUpperCase()} ${sqlString(String(v))}`));
  return `ATTACH${ifNotExists ? ' IF NOT EXISTS' : ''} ${sqlString(a.target)} AS ${alias} (TYPE ICEBERG${opts.length ? ', ' + opts.join(', ') : ''})`;
}

export class WorkspaceEngine {
  private instance!: DuckDBInstance;
  readonly memoryLimit: { display: string; bytes: number };
  readonly threads: number;
  readonly tempDirectory: string;
  readonly externalAccess: boolean;
  readonly fingerprint: string;
  secretsFingerprint: string;
  attachmentsFingerprint: string;
  /** alias → last ATTACH error (empty when attached fine). Surfaced by the lakehouse explorer. */
  readonly attachErrors = new Map<string, string>();
  lastUsed = Date.now();
  readonly createdAt = Date.now();
  private closed = false;
  private active = new Set<DuckDBConnection>();

  private constructor(readonly spec: EngineSpec, private readonly cfg: DuckViewConfig, readonly jail: DataJail) {
    this.memoryLimit = resolveMemoryLimit(spec.settings.memory_limit ?? cfg.duckdb.default_memory_limit);
    this.threads = resolveThreads(spec.settings.threads ?? cfg.duckdb.default_threads);
    this.tempDirectory = spec.settings.temp_directory ? jail.resolve(spec.settings.temp_directory).absolute : cfg.duckdb.temp_directory;
    this.externalAccess = cfg.security.enable_external_access || cfg.security.filesystem_mode === 'full';
    this.fingerprint = fingerprint(spec);
    this.secretsFingerprint = secretsFingerprint(spec.secrets);
    this.attachmentsFingerprint = attachmentsFingerprint(spec.attachments);
  }

  static async open(spec: EngineSpec, cfg: DuckViewConfig, jail: DataJail): Promise<WorkspaceEngine> {
    const eng = new WorkspaceEngine(spec, cfg, jail);
    await eng.init();
    return eng;
  }

  get workspaceId() {
    return this.spec.workspaceId;
  }

  private resolveDbPath(): string {
    const p = this.spec.dbPath?.trim() || ':memory:';
    if (p === ':memory:' || p === '') return ':memory:';
    if (isRemoteUri(p)) {
      if (!p.toLowerCase().startsWith('md:')) throw new SandboxViolation(`Unsupported remote database path: ${p}`, p);
      if (!this.externalAccess) throw new SandboxViolation('MotherDuck (md:) workspaces require security.enable_external_access=true', p);
      return p;
    }
    const resolved = this.jail.resolve(p);
    fs.mkdirSync(path.dirname(resolved.absolute), { recursive: true });
    return resolved.absolute;
  }

  private async init(): Promise<void> {
    fs.mkdirSync(this.tempDirectory, { recursive: true });
    const dbPath = this.resolveDbPath();
    const options: Record<string, string> = {
      memory_limit: this.memoryLimit.display,
      threads: String(this.threads),
      temp_directory: this.tempDirectory,
      autoinstall_known_extensions: this.externalAccess ? 'true' : 'false',
      autoload_known_extensions: 'true',
      allow_unsigned_extensions: 'false',
    };
    if (this.cfg.duckdb.extension_directory) options.extension_directory = this.cfg.duckdb.extension_directory;
    // Enabling external access is only possible at startup ("Cannot enable external access while database is running");
    // disabling it is done later via SET so allowed_directories can be registered first.
    if (this.externalAccess) options.enable_external_access = 'true';
    const md = this.spec.secrets.find((s) => s.type === 'MOTHERDUCK');
    if (md?.values.token) options.motherduck_token = md.values.token;

    this.instance = await DuckDBInstance.create(dbPath, options);
    const conn = await this.instance.connect();
    try {
      // 2. extensions (before lock; requires external access for INSTALL of non-bundled ones)
      const implied: string[] = [];
      if (this.externalAccess) {
        if (this.spec.secrets.some((x) => x.type === 'S3' || x.type === 'R2' || x.type === 'GCS' || x.type === 'HTTP')) implied.push('httpfs');
        if (this.spec.secrets.some((x) => x.type === 'AZURE')) implied.push('azure');
        if (this.spec.secrets.some((x) => x.type === 'ICEBERG')) implied.push('iceberg');
        if (this.spec.secrets.some((x) => x.type === 'S3' && x.values.provider === 'credential_chain')) implied.push('aws');
        for (const a of this.spec.attachments ?? []) implied.push(...a.extensions);
      }
      const wanted = [...new Set([...this.cfg.duckdb.preload_extensions, ...(this.spec.settings.extensions ?? []), ...implied])];
      for (const ext of wanted) {
        const name = ext.toLowerCase();
        if (this.cfg.security.blocked_extensions.includes(name)) throw new SandboxViolation(`Extension "${name}" is blocked by policy`, name);
        if (!this.cfg.security.allow_arbitrary_extensions && !this.cfg.security.allowed_extensions.includes(name)) {
          throw new SandboxViolation(`Extension "${name}" is not allow-listed`, name);
        }
        try {
          if (this.externalAccess) await conn.run(`INSTALL ${name}`);
          await conn.run(`LOAD ${name}`);
        } catch (err) {
          logger().warn({ ext: name, err: (err as Error).message, workspace: this.spec.workspaceId }, 'Failed to load DuckDB extension');
        }
      }
      // secrets
      for (const secret of this.spec.secrets) {
        if (!this.externalAccess && secret.type !== 'POSTGRES' && secret.type !== 'MOTHERDUCK') {
          logger().warn({ secret: secret.name, type: secret.type, workspace: this.spec.workspaceId }, 'Cloud secret skipped: security.enable_external_access is false');
          continue;
        }
        const stmt = secretToSql(secret);
        if (stmt) {
          try {
            await conn.run(stmt);
          } catch (err) {
            logger().warn({ secret: secret.name, err: (err as Error).message }, 'Failed to create DuckDB secret');
          }
        }
      }
      // lakehouse catalogs (need the iceberg extension + secrets above)
      for (const a of this.spec.attachments ?? []) await this.attachOne(conn, a);
      // 3–5. hardening
      if (!this.externalAccess) {
        const allowed = [this.jail.root, this.tempDirectory, ...(this.cfg.duckdb.extension_directory ? [this.cfg.duckdb.extension_directory] : [])].map(sqlString).join(', ');
        await conn.run(`SET allowed_directories = [${allowed}]`);
        await conn.run(`SET enable_external_access = false`);
      }
      if (this.cfg.security.lock_configuration) await conn.run(`SET lock_configuration = true`);
    } finally {
      conn.closeSync();
    }
    metrics.duckdbMemoryLimitBytes.set({ workspace: this.spec.workspaceId }, this.memoryLimit.bytes);
    logger().info({ workspace: this.spec.workspaceId, dbPath, memory: this.memoryLimit.display, threads: this.threads, externalAccess: this.externalAccess }, 'DuckDB engine ready');
  }

  /**
   * Applies a new secret set to the running instance (secrets are instance-global in DuckDB and are not
   * affected by lock_configuration). Returns false when the change cannot be applied in place — e.g. a
   * provider extension is not loaded yet, or a MotherDuck token changed (startup option) — so the caller restarts.
   */
  async applySecrets(secrets: SecretSpec[]): Promise<boolean> {
    const before = this.spec.secrets;
    const mdChanged = secretsFingerprint(before.filter((x) => x.type === 'MOTHERDUCK')) !== secretsFingerprint(secrets.filter((x) => x.type === 'MOTHERDUCK'));
    if (mdChanged) return false;
    const needsHttpfs = this.externalAccess && secrets.some((x) => x.type === 'S3' || x.type === 'R2' || x.type === 'GCS' || x.type === 'HTTP');
    const needsAzure = this.externalAccess && secrets.some((x) => x.type === 'AZURE');
    const needsIceberg = this.externalAccess && secrets.some((x) => x.type === 'ICEBERG');
    const needsAws = this.externalAccess && secrets.some((x) => x.type === 'S3' && x.values.provider === 'credential_chain');
    try {
      await this.withConnection(async (conn) => {
        if (needsHttpfs && !(await this.hasExtension('httpfs'))) await conn.run('LOAD httpfs');
        if (needsAzure && !(await this.hasExtension('azure'))) await conn.run('LOAD azure');
        if (needsIceberg && !(await this.hasExtension('iceberg'))) await conn.run('LOAD iceberg');
        if (needsAws && !(await this.hasExtension('aws'))) await conn.run('LOAD aws');
        const keep = new Set(secrets.map((x) => x.name.replace(/[^A-Za-z0-9_]/g, '_')));
        for (const old of before) {
          const n = old.name.replace(/[^A-Za-z0-9_]/g, '_');
          if (!keep.has(n) && old.type !== 'MOTHERDUCK') await conn.run(`DROP SECRET IF EXISTS ${n}`);
        }
        for (const secret of secrets) {
          if (!this.externalAccess && secret.type !== 'POSTGRES' && secret.type !== 'MOTHERDUCK') continue;
          const stmt = secretToSql(secret);
          if (stmt) await conn.run(stmt);
        }
      }, 15_000);
    } catch (err) {
      logger().warn({ err: (err as Error).message, workspace: this.spec.workspaceId }, 'Could not hot-apply secrets; engine will restart');
      return false;
    }
    (this.spec as { secrets: SecretSpec[] }).secrets = secrets;
    this.secretsFingerprint = secretsFingerprint(secrets);
    return true;
  }

  private async attachOne(conn: DuckDBConnection, a: AttachSpec): Promise<void> {
    if (!this.externalAccess) {
      this.attachErrors.set(a.alias, 'security.enable_external_access is false: lakehouse catalogs cannot be attached in sandboxed mode');
      logger().warn({ alias: a.alias, workspace: this.spec.workspaceId }, 'Lakehouse attachment skipped: external access disabled');
      return;
    }
    try {
      for (const ext of a.extensions) {
        if (!(await this.hasExtension(ext))) await conn.run(`LOAD ${ext}`).catch(async () => { await conn.run(`INSTALL ${ext}`); await conn.run(`LOAD ${ext}`); });
      }
      await conn.run(attachToSql(a));
      this.attachErrors.delete(a.alias);
    } catch (err) {
      const msg = (err as Error).message.split('\n')[0] ?? String(err);
      this.attachErrors.set(a.alias, msg);
      logger().warn({ alias: a.alias, err: msg, workspace: this.spec.workspaceId }, 'Failed to attach lakehouse catalog');
    }
  }

  /** Attaches/detaches lakehouse catalogs on the running instance; false when a restart is needed. */
  async applyAttachments(attachments: AttachSpec[]): Promise<boolean> {
    const before = this.spec.attachments ?? [];
    const key = (a: AttachSpec) => JSON.stringify([a.alias, a.target, Object.entries(a.options).sort()]);
    const nextKeys = new Set(attachments.map(key));
    const prevKeys = new Set(before.map(key));
    try {
      await this.withConnection(async (conn) => {
        for (const old of before) if (!nextKeys.has(key(old))) {
          await conn.run(`DETACH DATABASE IF EXISTS ${old.alias.replace(/[^A-Za-z0-9_]/g, '_')}`).catch(() => undefined);
          this.attachErrors.delete(old.alias);
        }
        for (const a of attachments) if (!prevKeys.has(key(a))) await this.attachOne(conn, a);
      }, 60_000);
    } catch (err) {
      logger().warn({ err: (err as Error).message, workspace: this.spec.workspaceId }, 'Could not hot-apply lakehouse attachments; engine will restart');
      return false;
    }
    (this.spec as { attachments?: AttachSpec[] }).attachments = attachments;
    this.attachmentsFingerprint = attachmentsFingerprint(attachments);
    return true;
  }

  /** Re-tries a failed attachment (e.g. after credentials were fixed). Returns the error message or null. */
  async retryAttachment(alias: string): Promise<string | null> {
    const a = (this.spec.attachments ?? []).find((x) => x.alias === alias);
    if (!a) return 'not configured on this engine';
    await this.withConnection((conn) => this.attachOne(conn, a), 60_000);
    return this.attachErrors.get(alias) ?? null;
  }

  /**
   * Runs trusted, server-generated SQL (no guard) and returns rows as JSON objects. Used for catalog
   * introspection of attached lakehouses and materialisation into temp-dir files — never for user SQL.
   */
  async runInternal(sql: string, timeoutMs = 60_000): Promise<Record<string, unknown>[]> {
    return this.withConnection(async (conn) => (await conn.runAndReadAll(sql)).getRowObjectsJson() as Record<string, unknown>[], timeoutMs);
  }

  /** Schemas and tables of an attached lakehouse catalog (lazy on the REST side: no table metadata is loaded). */
  async lakehouseTree(alias: string, schema?: string): Promise<{ schemas: string[]; tables: { schema: string; name: string }[] }> {
    const a = alias.replace(/[^A-Za-z0-9_]/g, '_');
    const err = this.attachErrors.get(alias);
    if (err) throw new Error(`Catalog "${alias}" is not attached: ${err}`);
    return this.withConnection(async (conn) => {
      const schemas = (await conn.runAndReadAll(`SELECT schema_name FROM duckdb_schemas() WHERE database_name = ${sqlString(a)} AND NOT internal ORDER BY 1`)).getRowObjectsJson().map((r) => String(r.schema_name));
      if (schema === undefined) return { schemas, tables: [] };
      const tables = (await conn.runAndReadAll(`SELECT schema_name, table_name FROM duckdb_tables() WHERE database_name = ${sqlString(a)} AND schema_name = ${sqlString(schema)} AND NOT internal ORDER BY 2`)).getRowObjectsJson().map((r) => ({ schema: String(r.schema_name), name: String(r.table_name) }));
      return { schemas, tables };
    }, 60_000);
  }

  /** Guard + rewrite SQL for this engine's jail. Throws SandboxViolation. */
  guard(sql: string) {
    return guardSql(sql, {
      jail: this.jail,
      allowRemote: this.externalAccess,
      allowedExtensions: this.cfg.security.allow_arbitrary_extensions ? null : this.cfg.security.allowed_extensions,
      blockedExtensions: this.cfg.security.blocked_extensions,
    });
  }

  private async withConnection<T>(fn: (conn: DuckDBConnection) => Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
    if (this.closed) throw new Error('Engine is closed');
    this.lastUsed = Date.now();
    const conn = await this.instance.connect();
    this.active.add(conn);
    let timedOut = false;
    let cancelled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      conn.interrupt();
    }, timeoutMs);
    const onAbort = () => {
      cancelled = true;
      conn.interrupt();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return await fn(conn);
    } catch (err) {
      if (timedOut) throw new QueryTimeoutError(timeoutMs);
      if (cancelled) throw new QueryCancelledError();
      throw err;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      this.active.delete(conn);
      try {
        conn.closeSync();
      } catch {
        /* ignore */
      }
    }
  }

  /** Executes (possibly multi-statement) SQL; returns the last statement's result, capped at maxRows. */
  async execute(rawSql: string, opts: ExecuteOptions = {}): Promise<QueryResult & { analysis: SqlAnalysis; guardedSql: string }> {
    const maxRows = Math.max(1, Math.min(opts.maxRows ?? this.cfg.duckdb.max_result_rows, this.cfg.duckdb.max_result_rows));
    const timeoutMs = opts.timeoutMs ?? (this.spec.settings.query_timeout_seconds ?? this.cfg.duckdb.query_timeout_seconds) * 1000;
    const guarded = this.guard(rawSql);
    const actor = opts.actor ?? 'user';
    const cls = guarded.analysis.overall;
    return withSpan('duckdb.query', { 'db.system': 'duckdb', 'duckview.workspace_id': this.spec.workspaceId, 'duckview.actor': actor, 'duckview.statement_class': cls, 'db.statement': rawSql.slice(0, 2000) }, async () => {
      metrics.activeQueries.inc();
      const start = performance.now();
      const stop = metrics.queryDuration.startTimer({ actor, class: cls });
      try {
        const result = await this.withConnection(
          async (conn) => {
            const statements = guarded.analysis.statements;
            let reader: DuckDBResultReader | null = null;
            if (statements.length <= 1) {
              let sql = guarded.sql;
              const page = opts.page ?? 1;
              if (page > 1 && isWrappableSelect(sql)) {
                sql = `SELECT * FROM (${stripTrailingSemicolon(sql)}) AS _dv_page LIMIT ${maxRows} OFFSET ${(page - 1) * maxRows}`;
              }
              reader = await conn.streamAndReadUntil(sql, maxRows + 1);
            } else {
              const extracted = await conn.extractStatements(guarded.sql);
              for (let i = 0; i < extracted.count; i++) {
                const prepared = await extracted.prepare(i);
                try {
                  if (i === extracted.count - 1) reader = await prepared.streamAndReadUntil(maxRows + 1);
                  else await prepared.run();
                } finally {
                  prepared.destroySync();
                }
              }
            }
            if (!reader) throw new Error('No statement to execute');
            const durationMs = performance.now() - start;
            const res = readerToResult(reader, { limit: maxRows, durationMs, statementCount: Math.max(1, statements.length), statementClass: cls });
            if (opts.countTotal && statements.length === 1 && isWrappableSelect(guarded.sql)) {
              try {
                const cr = await conn.runAndReadAll(`SELECT count(*) AS n FROM (${stripTrailingSemicolon(guarded.sql)}) AS _dv_count`);
                const n = cr.getRowsJson()[0]?.[0];
                res.totalRows = n === undefined ? null : Number(n);
              } catch {
                res.totalRows = null;
              }
            } else if (!res.truncated && (opts.page ?? 1) === 1) {
              res.totalRows = res.rowCount;
            }
            res.durationMs = Math.round(performance.now() - start);
            return res;
          },
          timeoutMs,
          opts.signal,
        );
        metrics.queriesTotal.inc({ actor, class: cls, status: 'ok' });
        metrics.rowsReturned.observe(result.rowCount);
        return { ...result, analysis: guarded.analysis, guardedSql: guarded.sql };
      } catch (err) {
        const status = err instanceof QueryTimeoutError ? 'timeout' : err instanceof QueryCancelledError ? 'cancelled' : 'error';
        metrics.queriesTotal.inc({ actor, class: cls, status });
        throw err;
      } finally {
        stop();
        metrics.activeQueries.dec();
      }
    });
  }

  /** Streams rows chunk-by-chunk (WebSocket path). The callback receives JSON-safe row arrays. */
  async stream(
    rawSql: string,
    handlers: { onSchema: (columns: ColumnSchema[]) => void; onRows: (rows: unknown[][]) => void | Promise<void> },
    opts: ExecuteOptions = {},
  ): Promise<{ rowCount: number; durationMs: number; truncated: boolean; analysis: SqlAnalysis }> {
    const maxRows = Math.max(1, Math.min(opts.maxRows ?? this.cfg.duckdb.max_result_rows, this.cfg.duckdb.max_result_rows));
    const timeoutMs = opts.timeoutMs ?? (this.spec.settings.query_timeout_seconds ?? this.cfg.duckdb.query_timeout_seconds) * 1000;
    const guarded = this.guard(rawSql);
    const actor = opts.actor ?? 'user';
    const cls = guarded.analysis.overall;
    const start = performance.now();
    metrics.activeQueries.inc();
    const stop = metrics.queryDuration.startTimer({ actor, class: cls });
    try {
      const out = await this.withConnection(
        async (conn) => {
          const statements = guarded.analysis.statements;
          // Run all but the last statement to completion, then stream the last.
          if (statements.length > 1) {
            const extracted = await conn.extractStatements(guarded.sql);
            for (let i = 0; i < extracted.count - 1; i++) {
              const p = await extracted.prepare(i);
              try {
                await p.run();
              } finally {
                p.destroySync();
              }
            }
          }
          const lastSql = statements.length > 1 ? statements[statements.length - 1]!.sql : guarded.sql;
          const result = await conn.stream(statements.length > 1 ? this.guard(lastSql).sql : lastSql);
          const types = result.columnTypes().map((t) => t.toString());
          const columns: ColumnSchema[] = result.deduplicatedColumnNames().map((name, i) => ({ name, type: types[i] ?? 'UNKNOWN', kind: kindOf(types[i] ?? '') }));
          handlers.onSchema(columns);
          let count = 0;
          let truncated = false;
          for await (const chunk of result.yieldRowsJson()) {
            const remaining = maxRows - count;
            const rows = chunk.length > remaining ? chunk.slice(0, remaining) : chunk;
            await handlers.onRows(rows.map((r) => r.map((v, i) => normalizeValue(v, types[i] ?? ''))));
            count += rows.length;
            if (count >= maxRows) {
              truncated = chunk.length > remaining || true;
              break;
            }
          }
          return { rowCount: count, truncated, durationMs: Math.round(performance.now() - start), analysis: guarded.analysis };
        },
        timeoutMs,
        opts.signal,
      );
      metrics.queriesTotal.inc({ actor, class: cls, status: 'ok' });
      metrics.rowsReturned.observe(out.rowCount);
      return out;
    } catch (err) {
      const status = err instanceof QueryTimeoutError ? 'timeout' : err instanceof QueryCancelledError ? 'cancelled' : 'error';
      metrics.queriesTotal.inc({ actor, class: cls, status });
      throw err;
    } finally {
      stop();
      metrics.activeQueries.dec();
    }
  }

  async explain(rawSql: string, opts: { analyze?: boolean; timeoutMs?: number } = {}): Promise<{ format: 'json' | 'text'; plan: unknown; text: string }> {
    const guarded = this.guard(rawSql);
    if (guarded.analysis.statements.length !== 1) throw new Error('EXPLAIN requires exactly one statement');
    const inner = stripTrailingSemicolon(guarded.sql).replace(/^\s*EXPLAIN(\s+ANALYZE)?\s*(\([^)]*\))?\s*/i, '');
    if (opts.analyze && guarded.analysis.isMutating) throw new Error('EXPLAIN ANALYZE executes the statement; refusing for mutating SQL');
    const timeoutMs = opts.timeoutMs ?? this.cfg.duckdb.query_timeout_seconds * 1000;
    return this.withConnection(
      async (conn) => {
        if (opts.analyze) {
          const r = await conn.runAndReadAll(`EXPLAIN ANALYZE ${inner}`);
          const text = r.getRowsJson().map((row) => String(row[1] ?? '')).join('\n');
          return { format: 'text' as const, plan: null, text };
        }
        try {
          const r = await conn.runAndReadAll(`EXPLAIN (FORMAT json) ${inner}`);
          const raw = String(r.getRowsJson()[0]?.[1] ?? '[]');
          const t = await conn.runAndReadAll(`EXPLAIN ${inner}`);
          const text = t.getRowsJson().map((row) => String(row[1] ?? '')).join('\n');
          return { format: 'json' as const, plan: JSON.parse(raw), text };
        } catch {
          const r = await conn.runAndReadAll(`EXPLAIN ${inner}`);
          const text = r.getRowsJson().map((row) => String(row[1] ?? '')).join('\n');
          return { format: 'text' as const, plan: null, text };
        }
      },
      timeoutMs,
    );
  }

  /** Resolves a user-supplied target (table, quoted identifier, file path, remote URI, or SELECT) into a guarded SELECT. */
  resolveRelation(target: string): { select: string; selectFallback?: string; relation: string; filePath: string | null; kind: 'table' | 'file' | 'remote' | 'query' } {
    const t = target.trim();
    if (!t) throw new SandboxViolation('Empty profile target', t);
    if (/^(select|with|from|pivot|unpivot)\b/i.test(t)) {
      const relation = `(${stripTrailingSemicolon(t)})`;
      return { select: this.guard(`SELECT * FROM ${relation} AS _dv_q`).sql, relation, filePath: null, kind: 'query' };
    }
    if (looksLikePath(t) || isRemoteUri(t)) {
      if (isRemoteUri(t)) {
        if (!this.externalAccess) throw new SandboxViolation(`Remote data sources are disabled by policy: ${t}`, t);
        return { select: `SELECT * FROM ${sqlString(t)}`, relation: sqlString(t), filePath: null, kind: 'remote' };
      }
      const filePath = this.jail.resolve(t, { allowGlob: true }).absolute;
      if (/\.xlsx?$/i.test(filePath)) {
        // Excel needs the explicit reader; `selectFallback` re-reads every cell as text when typed parsing fails
        // (e.g. locale decimals like '66,9').
        return { select: `SELECT * FROM read_xlsx(${sqlString(filePath)})`, selectFallback: `SELECT * FROM read_xlsx(${sqlString(filePath)}, all_varchar = true)`, relation: `read_xlsx(${sqlString(filePath)})`, filePath, kind: 'file' };
      }
      return { select: `SELECT * FROM ${sqlString(filePath)}`, relation: sqlString(filePath), filePath, kind: 'file' };
    }
    if (/^[A-Za-z_][A-Za-z0-9_$]*(\.[A-Za-z_][A-Za-z0-9_$]*){0,2}$/.test(t) || /^"[^"]+"(\."[^"]+")*$/.test(t)) {
      return { select: `SELECT * FROM ${t}`, relation: t, filePath: null, kind: 'table' };
    }
    throw new SandboxViolation(`Unrecognised profile target: ${t}`, t);
  }

  /** Runs `fn(select)`; when it fails on a typed-parse error and a lenient fallback exists, retries with it. */
  private async withReaderFallback<T>(rel: { select: string; selectFallback?: string }, fn: (select: string) => Promise<T>): Promise<T> {
    try {
      return await fn(rel.select);
    } catch (err) {
      if (rel.selectFallback && /Could not convert|Failed to parse|Conversion Error|Invalid Input Error/i.test((err as Error).message)) {
        logger().warn({ err: (err as Error).message.split('\n')[0] }, 'Typed spreadsheet read failed; retrying with all_varchar');
        return fn(rel.selectFallback);
      }
      throw err;
    }
  }

  /** SUMMARIZE a table, view, file path or subquery. */
  async summarize(target: string, opts: { timeoutMs?: number } = {}): Promise<{ summary: Record<string, unknown>[]; rowCount: number | null; columnCount: number; sizeBytes: number | null; sql: string }> {
    const timeoutMs = opts.timeoutMs ?? this.cfg.duckdb.query_timeout_seconds * 1000;
    const rel = this.resolveRelation(target);
    return this.withConnection(
      (conn) =>
        this.withReaderFallback(rel, async (select) => {
          const sql = `SUMMARIZE ${select}`;
          const r = await conn.runAndReadAll(sql);
          const summary = r.getRowObjectsJson() as Record<string, unknown>[];
          let rowCount: number | null = null;
          try {
            const c = await conn.runAndReadAll(`SELECT count(*) AS n FROM (${select}) AS _dv_profile`);
            rowCount = Number(c.getRowsJson()[0]?.[0] ?? 0);
          } catch {
            /* ignore */
          }
          return { summary, rowCount, columnCount: summary.length, sizeBytes: fileSize(rel.filePath), sql };
        }),
      timeoutMs,
    );
  }

  /**
   * Overview profile for the landing page: KPIs, per-column null ratios, a sample, and distributions
   * (equi-width histograms for numerics, top-N for categoricals, time buckets for temporals).
   */
  async overview(target: string, opts: { sampleRows?: number; maxColumns?: number; timeoutMs?: number } = {}): Promise<OverviewResult> {
    const timeoutMs = opts.timeoutMs ?? this.cfg.duckdb.query_timeout_seconds * 1000;
    const sampleRows = Math.min(opts.sampleRows ?? 50, 500);
    const maxColumns = opts.maxColumns ?? 12;
    const rel = this.resolveRelation(target);
    const { filePath, kind } = rel;
    const start = performance.now();
    return this.withConnection(
      (conn) => this.withReaderFallback(rel, async (select) => {
        const summary = (await conn.runAndReadAll(`SUMMARIZE ${select}`)).getRowObjectsJson() as Record<string, unknown>[];
        const rowCount = Number((await conn.runAndReadAll(`SELECT count(*) FROM (${select}) AS _dv`)).getRowsJson()[0]?.[0] ?? 0);
        const sampleReader = await conn.runAndReadAll(`SELECT * FROM (${select}) AS _dv LIMIT ${sampleRows}`);
        const sample = readerToResult(sampleReader, { limit: sampleRows, durationMs: 0, statementCount: 1, statementClass: 'read' });
        let distinctRows: number | null = null;
        if (rowCount <= 2_000_000) {
          try {
            distinctRows = Number((await conn.runAndReadAll(`SELECT count(*) FROM (SELECT DISTINCT * FROM (${select}) AS _dv) AS _dv2`)).getRowsJson()[0]?.[0] ?? 0);
          } catch {
            distinctRows = null;
          }
        }
        const columns: OverviewColumn[] = summary.map((s) => ({
          name: String(s.column_name),
          type: String(s.column_type),
          kind: kindOf(String(s.column_type)),
          null_percentage: Number(s.null_percentage ?? 0),
          approx_unique: s.approx_unique == null ? null : Number(s.approx_unique),
          min: s.min == null ? null : String(s.min),
          max: s.max == null ? null : String(s.max),
          avg: s.avg == null ? null : Number(s.avg),
          q50: s.q50 == null ? null : String(s.q50),
          distribution: null,
        }));
        const nullCells = columns.reduce((acc, c) => acc + (c.null_percentage / 100) * rowCount, 0);
        for (const col of columns.slice(0, maxColumns)) {
          const q = `"${col.name.replace(/"/g, '""')}"`;
          try {
            if (col.kind === 'number') {
              const mm = (await conn.runAndReadAll(`SELECT min(${q})::DOUBLE, max(${q})::DOUBLE FROM (${select}) AS _dv`)).getRowsJson()[0] ?? [];
              const mn = Number(mm[0]);
              const mx = Number(mm[1]);
              if (!Number.isFinite(mn) || !Number.isFinite(mx)) continue;
              const bins = 16;
              if (mx === mn) {
                col.distribution = { kind: 'histogram', bins: [{ label: String(mn), lo: mn, hi: mn, count: rowCount - Math.round((col.null_percentage / 100) * rowCount) }] };
                continue;
              }
              const rows = (await conn.runAndReadAll(`SELECT least(${bins - 1}, floor((${q}::DOUBLE - ${mn}) / ${mx - mn} * ${bins}))::INT AS b, count(*) AS n FROM (${select}) AS _dv WHERE ${q} IS NOT NULL GROUP BY 1 ORDER BY 1`)).getRowsJson();
              const counts = new Map(rows.map((r) => [Number(r[0]), Number(r[1])]));
              const width = (mx - mn) / bins;
              col.distribution = {
                kind: 'histogram',
                bins: Array.from({ length: bins }, (_v, i) => ({ lo: mn + i * width, hi: mn + (i + 1) * width, label: fmtNum(mn + i * width), count: counts.get(i) ?? 0 })),
              };
            } else if (col.kind === 'temporal' && !col.type.toUpperCase().startsWith('TIME ') && col.type.toUpperCase() !== 'TIME' && col.type.toUpperCase() !== 'INTERVAL') {
              const span = (await conn.runAndReadAll(`SELECT date_diff('day', min(${q})::TIMESTAMP, max(${q})::TIMESTAMP) FROM (${select}) AS _dv`)).getRowsJson()[0]?.[0];
              const days = Number(span ?? 0);
              const unit = days <= 62 ? 'day' : days <= 730 ? 'week' : days <= 3650 ? 'month' : 'year';
              const rows = (await conn.runAndReadAll(`SELECT date_trunc('${unit}', ${q}::TIMESTAMP)::VARCHAR AS b, count(*) AS n FROM (${select}) AS _dv WHERE ${q} IS NOT NULL GROUP BY 1 ORDER BY 1 LIMIT 200`)).getRowsJson();
              col.distribution = { kind: 'timeline', unit, bins: rows.map((r) => ({ label: String(r[0]).slice(0, unit === 'day' || unit === 'week' ? 10 : 7), count: Number(r[1]) })) };
            } else if (col.kind === 'string' || col.kind === 'boolean') {
              // A top-N of a near-unique column (ids, timestamps-as-text) carries no signal; skip the scan.
              if (col.kind === 'string' && col.approx_unique != null && col.approx_unique > 100 && col.approx_unique > rowCount * 0.5) continue;
              const rows = (await conn.runAndReadAll(`SELECT ${q}::VARCHAR AS v, count(*) AS n FROM (${select}) AS _dv WHERE ${q} IS NOT NULL GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 10`)).getRowsJson();
              const top = rows.map((r) => ({ label: String(r[0]).slice(0, 40), count: Number(r[1]) }));
              const covered = top.reduce((a, b) => a + b.count, 0);
              const nonNull = rowCount - Math.round((col.null_percentage / 100) * rowCount);
              col.distribution = { kind: 'categories', bins: top, other: Math.max(0, nonNull - covered) };
            }
          } catch {
            col.distribution = null;
          }
        }
        return {
          target,
          kind,
          row_count: rowCount,
          column_count: columns.length,
          size_bytes: fileSize(filePath),
          null_cell_ratio: rowCount && columns.length ? nullCells / (rowCount * columns.length) : 0,
          duplicate_rows: distinctRows == null ? null : Math.max(0, rowCount - distinctRows),
          columns,
          sample: { columns: sample.columns, rows: sample.rows },
          duration_ms: Math.round(performance.now() - start),
        };
      }),
      timeoutMs,
    );
  }

  /** Actual memory held by this engine's buffer manager (duckdb_memory()), plus temp spill usage. */
  async memoryStats(): Promise<{ memory_usage_bytes: number; temporary_storage_bytes: number; tags: { tag: string; memory_usage_bytes: number; temporary_storage_bytes: number }[] }> {
    return this.withConnection(async (conn) => {
      const rows = (await conn.runAndReadAll('SELECT tag, memory_usage_bytes, temporary_storage_bytes FROM duckdb_memory()')).getRowsJson();
      const tags = rows.map((r) => ({ tag: String(r[0]), memory_usage_bytes: Number(r[1]), temporary_storage_bytes: Number(r[2]) }));
      return { memory_usage_bytes: tags.reduce((a, t) => a + t.memory_usage_bytes, 0), temporary_storage_bytes: tags.reduce((a, t) => a + t.temporary_storage_bytes, 0), tags };
    }, 5000);
  }

  /** True if the extension is currently loaded in this instance. */
  async hasExtension(name: string): Promise<boolean> {
    try {
      return await this.withConnection(async (conn) => {
        const r = await conn.runAndReadAll(`SELECT loaded FROM duckdb_extensions() WHERE extension_name = ${sqlString(name)}`);
        return Boolean(r.getRowsJson()[0]?.[0]);
      }, 5000);
    } catch {
      // duckdb_extensions() scans the extension directory, which the sandbox may forbid → treat as "not loaded".
      return false;
    }
  }

  /**
   * Schema inspection without scanning the data: DESCRIBE … LIMIT 0 (Parquet/CSV/JSON/remote objects read only
   * headers/footers), catalog lookups for tables, and a read-only ATTACH for .duckdb files.
   */
  async inspect(target: string, opts: { timeoutMs?: number } = {}): Promise<InspectResult> {
    const timeoutMs = opts.timeoutMs ?? this.cfg.duckdb.query_timeout_seconds * 1000;
    const t = target.trim();
    const isDuckFile = /\.(duckdb|ddb|db)$/i.test(t) && !isRemoteUri(t) && (looksLikePath(t) || /[\\/]/.test(t) || fs.existsSync(this.jail.resolve(t).absolute));
    if (isDuckFile) {
      const abs = this.jail.resolve(t).absolute;
      const alias = `_dv_inspect_${Date.now().toString(36)}`;
      return this.withConnection(
        async (conn) => {
          await conn.run(`ATTACH ${sqlString(abs)} AS ${alias} (READ_ONLY)`);
          try {
            const rows = (await conn.runAndReadAll(`SELECT table_schema, table_name, column_name, data_type, is_nullable FROM information_schema.columns WHERE table_catalog = ${sqlString(alias)} ORDER BY table_schema, table_name, ordinal_position`)).getRowObjectsJson();
            const tables = new Map<string, InspectResult['tables'] extends (infer U)[] | undefined ? U : never>();
            for (const r of rows) {
              const key = `${r.table_schema}.${r.table_name}`;
              if (!tables.has(key)) tables.set(key, { name: String(r.table_name), schema: String(r.table_schema), columns: [] });
              tables.get(key)!.columns.push({ name: String(r.column_name), type: String(r.data_type), nullable: String(r.is_nullable).toUpperCase() === 'YES' });
            }
            const list = [...tables.values()];
            const first = list[0];
            return {
              target: t,
              kind: 'database' as const,
              columns: first?.columns ?? [],
              row_count: null,
              row_count_source: null,
              size_bytes: fileSize(abs),
              tables: list,
              suggested_sql: `ATTACH '${this.jail.relativeTo(abs)}' AS attached_db (READ_ONLY);\nSELECT * FROM attached_db.${first ? (first.schema === 'main' ? first.name : `${first.schema}.${first.name}`) : 'table_name'} LIMIT 100;`,
            };
          } finally {
            await conn.run(`DETACH ${alias}`).catch(() => undefined);
          }
        },
        timeoutMs,
      );
    }
    const rel = this.resolveRelation(t);
    const { relation, filePath, kind } = rel;
    return this.withConnection(
      (conn) => this.withReaderFallback(rel, async (select) => {
        const desc = (await conn.runAndReadAll(`DESCRIBE ${select.replace(/;\s*$/, '')} LIMIT 0`)).getRowObjectsJson();
        const columns = desc.map((r) => ({ name: String(r.column_name), type: String(r.column_type), nullable: String(r['null'] ?? 'YES').toUpperCase() === 'YES' }));
        let rowCount: number | null = null;
        let source: InspectResult['row_count_source'] = null;
        const uri = kind === 'file' ? filePath! : kind === 'remote' ? relation.slice(1, -1).replace(/''/g, "'") : null;
        if (uri && /\.parquet$/i.test(uri)) {
          try {
            const m = (await conn.runAndReadAll(`SELECT sum(num_rows) FROM parquet_file_metadata(${sqlString(uri)})`)).getRowsJson()[0]?.[0];
            if (m != null) {
              rowCount = Number(m);
              source = 'parquet_metadata';
            }
          } catch {
            /* not parquet-readable */
          }
        } else if (kind === 'table') {
          try {
            const parts = relation.replace(/"/g, '').split('.');
            const name = parts[parts.length - 1]!;
            const est = (await conn.runAndReadAll(`SELECT estimated_size FROM duckdb_tables() WHERE table_name = ${sqlString(name)} LIMIT 1`)).getRowsJson()[0]?.[0];
            if (est != null) {
              rowCount = Number(est);
              source = 'catalog';
            }
          } catch {
            /* view or missing */
          }
        }
        const display = kind === 'file' ? (/\.xlsx?$/i.test(filePath!) ? `read_xlsx('${this.jail.relativeTo(filePath!)}'${select === rel.selectFallback ? ', all_varchar = true' : ''})` : `'${this.jail.relativeTo(filePath!)}'`) : relation;
        return { target: t, kind, columns, row_count: rowCount, row_count_source: source, size_bytes: fileSize(filePath), suggested_sql: `SELECT *\nFROM ${display}\nLIMIT 100;` };
      }),
      timeoutMs,
    );
  }

  /**
   * Exports a read query to a file on disk via native COPY … TO (Parquet/CSV/JSON) or a streaming Arrow IPC writer.
   * `outPath` is a trusted server-chosen location inside an allowed directory; only the inner SQL is user-supplied.
   */
  async exportTo(rawSql: string, format: ExportFormat, outPath: string, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<{ rows: number; bytes: number; engine: 'duckdb' | 'node-arrow' }> {
    const guarded = this.guard(rawSql);
    if (guarded.analysis.statements.length !== 1 || guarded.analysis.isMutating) throw new SandboxViolation('Exports accept exactly one read-only statement', rawSql);
    const inner = stripTrailingSemicolon(guarded.sql);
    const timeoutMs = opts.timeoutMs ?? Math.max(this.cfg.duckdb.query_timeout_seconds, 600) * 1000;
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const escapedOut = sqlString(outPath);
    return this.withConnection(
      async (conn) => {
        if (format === 'arrow') {
          if (await this.hasExtension('arrow')) {
            const r = await conn.runAndReadAll(`COPY (${inner}) TO ${escapedOut} (FORMAT ARROW)`);
            return { rows: Number(r.getRowsJson()[0]?.[0] ?? 0), bytes: fs.statSync(outPath).size, engine: 'duckdb' as const };
          }
          const result = await conn.stream(inner);
          const rows = await writeArrowStream(result, outPath);
          return { rows, bytes: fs.statSync(outPath).size, engine: 'node-arrow' as const };
        }
        const options = format === 'parquet' ? '(FORMAT PARQUET, COMPRESSION ZSTD)' : format === 'csv' ? '(FORMAT CSV, HEADER TRUE)' : '(FORMAT JSON, ARRAY FALSE)';
        const r = await conn.runAndReadAll(`COPY (${inner}) TO ${escapedOut} ${options}`);
        return { rows: Number(r.getRowsJson()[0]?.[0] ?? 0), bytes: fs.statSync(outPath).size, engine: 'duckdb' as const };
      },
      timeoutMs,
      opts.signal,
    );
  }

  async catalog(): Promise<CatalogObject[]> {
    // Attached lakehouse catalogs are browsed lazily elsewhere (lakehouseTree); listing their columns here would
    // fetch remote table metadata for every table.
    const excluded = (this.spec.attachments ?? []).map((a) => sqlString(a.alias.replace(/[^A-Za-z0-9_]/g, '_')));
    const notLakehouse = excluded.length ? ` AND database_name NOT IN (${excluded.join(', ')})` : '';
    return this.withConnection(async (conn) => {
      const t = await conn.runAndReadAll(`
        SELECT database_name, schema_name, table_name AS name, 'TABLE' AS type, estimated_size, column_count, sql
        FROM duckdb_tables() WHERE NOT internal${notLakehouse}
        UNION ALL
        SELECT database_name, schema_name, view_name AS name, 'VIEW' AS type, NULL, column_count, sql
        FROM duckdb_views() WHERE NOT internal${notLakehouse}
        ORDER BY 1, 2, 3`);
      const c = await conn.runAndReadAll(`SELECT database_name, schema_name, table_name, column_name, data_type, is_nullable, column_index FROM duckdb_columns() WHERE NOT internal${notLakehouse} ORDER BY column_index`);
      const cols = new Map<string, CatalogObject['columns']>();
      for (const row of c.getRowObjectsJson()) {
        const key = `${row.database_name}.${row.schema_name}.${row.table_name}`;
        if (!cols.has(key)) cols.set(key, []);
        cols.get(key)!.push({ name: String(row.column_name), type: String(row.data_type), nullable: Boolean(row.is_nullable) });
      }
      return t.getRowObjectsJson().map((row) => {
        const database = String(row.database_name);
        const schema = String(row.schema_name);
        const name = String(row.name);
        return {
          database,
          schema,
          name,
          type: row.type === 'VIEW' ? 'VIEW' : 'TABLE',
          estimated_rows: row.estimated_size === null || row.estimated_size === undefined ? null : Number(row.estimated_size),
          column_count: Number(row.column_count ?? 0),
          sql: row.sql === undefined ? null : (row.sql as string | null),
          columns: cols.get(`${database}.${schema}.${name}`) ?? [],
        } satisfies CatalogObject;
      });
    }, 15_000);
  }

  async version(): Promise<string> {
    return this.withConnection(async (conn) => String((await conn.runAndReadAll('SELECT version() AS v')).getRowsJson()[0]?.[0] ?? 'unknown'), 5000);
  }

  get activeQueryCount() {
    return this.active.size;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const c of this.active) {
      try {
        c.interrupt();
      } catch {
        /* ignore */
      }
    }
    try {
      this.instance.closeSync();
    } catch {
      /* ignore */
    }
    metrics.duckdbMemoryLimitBytes.remove({ workspace: this.spec.workspaceId });
  }
}

export function secretToSql(secret: SecretSpec): string | null {
  const v = secret.values;
  const name = secret.name.replace(/[^A-Za-z0-9_]/g, '_');
  const kv = (pairs: [string, string | undefined][]) =>
    pairs
      .filter((p): p is [string, string] => !!p[1])
      .map(([k, val]) => `${k} ${sqlString(val)}`)
      .join(', ');
  const scope = v.scope ? `, SCOPE ${sqlString(v.scope)}` : '';
  // Custom endpoints (MinIO, R2-via-S3, Ceph): DuckDB wants host[:port] without scheme, plus USE_SSL / URL_STYLE.
  const endpoint = (raw?: string) => {
    if (!raw) return { host: undefined, ssl: undefined as boolean | undefined };
    const m = /^(https?):\/\/(.+?)\/?$/i.exec(raw.trim());
    return m ? { host: m[2], ssl: m[1]!.toLowerCase() === 'https' } : { host: raw.trim().replace(/\/+$/, ''), ssl: undefined };
  };
  switch (secret.type) {
    case 'S3': {
      if (v.provider === 'credential_chain') {
        // aws extension: env vars, ~/.aws profiles, instance/task roles (SSO, STS) — no static keys stored.
        const extra = kv([
          ['REGION', v.region],
          ['CHAIN', v.chain],
          ['PROFILE', v.profile],
        ]);
        return `CREATE OR REPLACE SECRET ${name} (TYPE S3, PROVIDER credential_chain${extra ? ', ' + extra : ''}${scope})`;
      }
      const ep = endpoint(v.endpoint);
      const urlStyle = v.url_style ?? (ep.host ? 'path' : undefined);
      const ssl = v.use_ssl !== undefined ? v.use_ssl !== 'false' : ep.ssl;
      return `CREATE OR REPLACE SECRET ${name} (TYPE S3, ${kv([
        ['KEY_ID', v.access_key_id],
        ['SECRET', v.secret_access_key],
        ['REGION', v.region || (ep.host ? 'us-east-1' : undefined)],
        ['ENDPOINT', ep.host],
        ['SESSION_TOKEN', v.session_token],
        ['URL_STYLE', urlStyle],
      ])}${ssl === false ? ', USE_SSL false' : ''}${scope})`;
    }
    case 'R2':
      return `CREATE OR REPLACE SECRET ${name} (TYPE R2, ${kv([
        ['KEY_ID', v.access_key_id],
        ['SECRET', v.secret_access_key],
        ['ACCOUNT_ID', v.account_id],
      ])}${scope})`;
    case 'GCS':
      return `CREATE OR REPLACE SECRET ${name} (TYPE GCS, ${kv([
        ['KEY_ID', v.access_key_id],
        ['SECRET', v.secret_access_key],
      ])}${scope})`;
    case 'AZURE':
      return `CREATE OR REPLACE SECRET ${name} (TYPE AZURE, ${kv([['CONNECTION_STRING', v.connection_string]])}${scope})`;
    case 'HTTP':
      return `CREATE OR REPLACE SECRET ${name} (TYPE HTTP, ${kv([['BEARER_TOKEN', v.bearer_token]])}${scope})`;
    case 'ICEBERG':
      // Bearer token (PATs, Unity Catalog, Lakekeeper…) or OAuth2 client credentials (Polaris, Snowflake Open Catalog, Databricks M2M).
      if (v.token) return `CREATE OR REPLACE SECRET ${name} (TYPE ICEBERG, ${kv([['TOKEN', v.token]])})`;
      return `CREATE OR REPLACE SECRET ${name} (TYPE ICEBERG, ${kv([
        ['CLIENT_ID', v.client_id],
        ['CLIENT_SECRET', v.client_secret],
        ['OAUTH2_SERVER_URI', v.oauth2_server_uri],
        ['OAUTH2_SCOPE', v.oauth2_scope],
      ])})`;
    case 'POSTGRES':
      return `CREATE OR REPLACE SECRET ${name} (TYPE POSTGRES, ${kv([
        ['HOST', v.host],
        ['PORT', v.port],
        ['DATABASE', v.database],
        ['USER', v.user],
        ['PASSWORD', v.password],
      ])})`;
    case 'MOTHERDUCK':
      return null; // applied as motherduck_token startup option
    default:
      return null;
  }
}

/** LRU + idle-TTL cache of WorkspaceEngines. */
export class EngineManager {
  private engines = new Map<string, WorkspaceEngine>();
  private pending = new Map<string, Promise<WorkspaceEngine>>();
  private sweeper: NodeJS.Timeout;
  readonly jail: DataJail;

  constructor(private readonly cfg: DuckViewConfig) {
    this.jail = cfg.security.filesystem_mode === 'full' ? new DataJail(path.parse(cfg.security.data_jail_directory).root, cfg.security.data_jail_directory) : new DataJail(cfg.security.data_jail_directory);
    fs.mkdirSync(cfg.duckdb.temp_directory, { recursive: true });
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref();
  }

  async get(spec: EngineSpec): Promise<WorkspaceEngine> {
    const existing = this.engines.get(spec.workspaceId);
    if (existing) {
      if (existing.fingerprint === fingerprint(spec)) {
        existing.lastUsed = Date.now();
        const secretsOk = existing.secretsFingerprint === secretsFingerprint(spec.secrets) || (await existing.applySecrets(spec.secrets));
        const attachOk = secretsOk && (existing.attachmentsFingerprint === attachmentsFingerprint(spec.attachments) || (await existing.applyAttachments(spec.attachments ?? [])));
        if (secretsOk && attachOk) return existing;
      }
      this.evict(spec.workspaceId);
    }
    const inflight = this.pending.get(spec.workspaceId);
    if (inflight) return inflight;
    const p = (async () => {
      this.enforceCapacity();
      const eng = await WorkspaceEngine.open(spec, this.cfg, this.jail);
      this.engines.set(spec.workspaceId, eng);
      metrics.engines.set(this.engines.size);
      return eng;
    })().finally(() => this.pending.delete(spec.workspaceId));
    this.pending.set(spec.workspaceId, p);
    return p;
  }

  peek(workspaceId: string): WorkspaceEngine | undefined {
    return this.engines.get(workspaceId);
  }

  all(): WorkspaceEngine[] {
    return [...this.engines.values()];
  }

  evict(workspaceId: string): void {
    const e = this.engines.get(workspaceId);
    if (e) {
      e.close();
      this.engines.delete(workspaceId);
      metrics.engines.set(this.engines.size);
    }
  }

  private enforceCapacity() {
    while (this.engines.size >= this.cfg.duckdb.max_cached_engines) {
      let oldest: WorkspaceEngine | null = null;
      for (const e of this.engines.values()) if (e.activeQueryCount === 0 && (!oldest || e.lastUsed < oldest.lastUsed)) oldest = e;
      if (!oldest) break;
      this.evict(oldest.workspaceId);
    }
  }

  private sweep() {
    const ttl = this.cfg.duckdb.engine_idle_ttl_seconds * 1000;
    const now = Date.now();
    for (const e of [...this.engines.values()]) {
      if (e.activeQueryCount === 0 && now - e.lastUsed > ttl) this.evict(e.workspaceId);
    }
  }

  resources(): EngineResources {
    const mem = resolveMemoryLimit(this.cfg.duckdb.default_memory_limit);
    return {
      host: { cpus: os.availableParallelism?.() ?? os.cpus().length, total_memory_bytes: os.totalmem(), free_memory_bytes: os.freemem(), platform: `${os.platform()} ${os.arch()}`, load_average: os.loadavg() },
      duckdb: {
        version: 'see /api/system',
        memory_limit: mem.display,
        memory_limit_bytes: mem.bytes,
        threads: resolveThreads(this.cfg.duckdb.default_threads),
        temp_directory: this.cfg.duckdb.temp_directory,
        external_access: this.cfg.security.enable_external_access || this.cfg.security.filesystem_mode === 'full',
        configuration_locked: this.cfg.security.lock_configuration,
      },
      temp_disk: { path: this.cfg.duckdb.temp_directory, ...diskFree(this.cfg.duckdb.temp_directory) },
      data_jail: { path: this.jail.root, ...diskFree(this.jail.root) },
      engines_active: this.engines.size,
    };
  }

  /** Real-time stats for the Settings gauges. */
  async liveStats(): Promise<{
    engines: { workspaceId: string; dbPath: string; memory_limit_bytes: number; memory_usage_bytes: number; temporary_storage_bytes: number; active_queries: number; threads: number }[];
    duckdb_memory_usage_bytes: number;
    duckdb_memory_limit_bytes: number;
    duckdb_temp_bytes: number;
  }> {
    const engines = await Promise.all(
      [...this.engines.values()].map(async (e) => {
        let mem = { memory_usage_bytes: 0, temporary_storage_bytes: 0 };
        try {
          mem = await e.memoryStats();
        } catch {
          /* engine busy or closed */
        }
        return { workspaceId: e.workspaceId, dbPath: e.spec.dbPath, memory_limit_bytes: e.memoryLimit.bytes, memory_usage_bytes: mem.memory_usage_bytes, temporary_storage_bytes: mem.temporary_storage_bytes, active_queries: e.activeQueryCount, threads: e.threads };
      }),
    );
    return {
      engines,
      duckdb_memory_usage_bytes: engines.reduce((a, e) => a + e.memory_usage_bytes, 0),
      duckdb_memory_limit_bytes: engines.length ? Math.max(...engines.map((e) => e.memory_limit_bytes)) : resolveMemoryLimit(this.cfg.duckdb.default_memory_limit).bytes,
      duckdb_temp_bytes: engines.reduce((a, e) => a + e.temporary_storage_bytes, 0),
    };
  }

  list(): { workspaceId: string; memoryLimit: string; threads: number; activeQueries: number; lastUsed: string; createdAt: string; dbPath: string }[] {
    return [...this.engines.values()].map((e) => ({
      workspaceId: e.workspaceId,
      memoryLimit: e.memoryLimit.display,
      threads: e.threads,
      activeQueries: e.activeQueryCount,
      lastUsed: new Date(e.lastUsed).toISOString(),
      createdAt: new Date(e.createdAt).toISOString(),
      dbPath: e.spec.dbPath,
    }));
  }

  closeAll(): void {
    clearInterval(this.sweeper);
    for (const id of [...this.engines.keys()]) this.evict(id);
  }
}
