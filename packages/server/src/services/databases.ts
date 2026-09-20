/**
 * Database connections: PostgreSQL, MySQL, SQLite files and other DuckDB files, attached read-only to every engine
 * of the owner's workspaces (`ATTACH … AS <alias> (TYPE postgres, READ_ONLY)`) so they are queried as
 * alias.schema.table, browsed schema by schema, and loaded on a schedule. Passwords are AES-256-GCM encrypted
 * like every other credential; the network ones need security.enable_external_access (file ones do not).
 */
import { eq, and, desc } from 'drizzle-orm';
import { DuckDBInstance } from '@duckdb/node-api';
import type { MetadataStore } from '../db/index.js';
import type { DatabaseConnection, DatabaseConfig, DatabaseEngine } from '../db/schema/sqlite.js';
import { DATABASE_ENGINES } from '../db/schema/sqlite.js';
import type { DuckViewConfig } from '../config/index.js';
import { CredentialCipher, newId } from '../security/crypto.js';
import { attachToSql, sqlString, type AttachSpec, type EngineManager } from '../engine/duckdb.js';
import { badRequest, notFound } from './errors.js';
import { logger } from '../observability/logger.js';

export type PublicDatabaseConnection = Omit<DatabaseConnection, 'encrypted_credentials' | 'iv' | 'tag'> & { has_password: boolean; example_sql: string; needs_external_access: boolean };

export interface DatabaseEntry {
  name: string;
  type: 'schema' | 'table' | 'view';
  qualified?: string;
  rows?: number | null;
}

const EXTENSIONS: Record<DatabaseEngine, string[]> = { postgres: ['postgres'], mysql: ['mysql'], sqlite: ['sqlite'], duckdb: [] };
const NETWORK: Record<DatabaseEngine, boolean> = { postgres: true, mysql: true, sqlite: false, duckdb: false };

/** The ATTACH target string DuckDB's scanner extensions expect. */
export function attachTarget(engine: DatabaseEngine, cfg: DatabaseConfig, password: string | null, resolvePath: (p: string) => string): string {
  switch (engine) {
    case 'postgres': {
      const parts = [`host=${cfg.host ?? 'localhost'}`, `port=${cfg.port ?? 5432}`, `dbname=${cfg.database ?? ''}`, `user=${cfg.user ?? ''}`];
      if (password) parts.push(`password=${password}`);
      if (cfg.ssl) parts.push('sslmode=require');
      return parts.join(' ');
    }
    case 'mysql': {
      const parts = [`host=${cfg.host ?? 'localhost'}`, `port=${cfg.port ?? 3306}`, `database=${cfg.database ?? ''}`, `user=${cfg.user ?? ''}`];
      if (password) parts.push(`password=${password}`);
      if (cfg.ssl) parts.push('ssl_mode=required');
      return parts.join(' ');
    }
    case 'sqlite':
    case 'duckdb':
      return resolvePath(cfg.path ?? '');
  }
}

export class DatabaseConnectionService {
  constructor(private readonly store: MetadataStore, private readonly cipher: CredentialCipher, private readonly engines: EngineManager, private readonly cfg: DuckViewConfig) {}
  private get db() {
    return this.store.db;
  }
  private get s() {
    return this.store.schema;
  }
  private decrypt(c: DatabaseConnection): { password?: string } {
    return this.cipher.decryptJson<{ password?: string }>({ ciphertext: c.encrypted_credentials, iv: c.iv, tag: c.tag }, c.id);
  }
  private toPublic(c: DatabaseConnection): PublicDatabaseConnection {
    const { encrypted_credentials: _e, iv: _i, tag: _t, ...rest } = c;
    let has_password = false;
    try {
      has_password = !!this.decrypt(c).password;
    } catch {
      /* rotated key */
    }
    return { ...rest, has_password, example_sql: `SELECT * FROM ${c.alias}.${c.engine === 'postgres' ? 'public' : 'main'}.<table> LIMIT 100`, needs_external_access: NETWORK[c.engine] };
  }

  async list(userId: string): Promise<PublicDatabaseConnection[]> {
    const rows = await this.db.select().from(this.s.databaseConnections).where(eq(this.s.databaseConnections.user_id, userId)).orderBy(desc(this.s.databaseConnections.created_at));
    return rows.map((r) => this.toPublic(r));
  }

  async getOwned(userId: string, id: string): Promise<DatabaseConnection> {
    const rows = await this.db.select().from(this.s.databaseConnections).where(and(eq(this.s.databaseConnections.id, id), eq(this.s.databaseConnections.user_id, userId))).limit(1);
    if (!rows[0]) throw notFound('Database connection');
    return rows[0];
  }

  private validate(engine: DatabaseEngine, alias: string, config: DatabaseConfig): { alias: string; config: DatabaseConfig } {
    if (!DATABASE_ENGINES.includes(engine)) throw badRequest(`engine must be one of ${DATABASE_ENGINES.join(', ')}`);
    const a = alias.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(a)) throw badRequest('alias must be a plain identifier (letters, digits, underscore)');
    if (['main', 'memory', 'temp', 'system', 'duckview_mosaic', 'duckview_mosaic_mem'].includes(a.toLowerCase())) throw badRequest(`"${a}" is reserved`);
    const out: DatabaseConfig = { read_only: config.read_only ?? true };
    if (NETWORK[engine]) {
      if (!config.host?.trim()) throw badRequest('host is required');
      if (!config.database?.trim()) throw badRequest('database is required');
      if (!config.user?.trim()) throw badRequest('user is required');
      out.host = config.host.trim();
      out.port = config.port ? Number(config.port) : undefined;
      if (out.port !== undefined && !(out.port > 0 && out.port < 65536)) throw badRequest('port must be 1–65535');
      out.database = config.database.trim();
      out.user = config.user.trim();
      out.ssl = !!config.ssl;
    } else {
      if (!config.path?.trim()) throw badRequest('path is required');
      const resolved = this.engines.jail.resolve(config.path.trim()); // SandboxViolation outside the jail
      if (!resolved.exists) throw badRequest(`${config.path} does not exist`);
      out.path = config.path.trim();
    }
    return { alias: a, config: out };
  }

  async create(userId: string, input: { name: string; engine: DatabaseEngine; alias?: string; config: DatabaseConfig; password?: string | null }): Promise<PublicDatabaseConnection> {
    const name = (input.name ?? '').trim();
    if (!name) throw badRequest('name is required');
    const { alias, config } = this.validate(input.engine, input.alias?.trim() || suggestAlias(input.engine, name), input.config ?? {});
    const taken = await this.db.select({ id: this.s.databaseConnections.id }).from(this.s.databaseConnections).where(and(eq(this.s.databaseConnections.user_id, userId), eq(this.s.databaseConnections.alias, alias))).limit(1);
    if (taken[0]) throw badRequest(`alias "${alias}" is already used by another database connection`);
    if (NETWORK[input.engine] && !input.password) throw badRequest('password is required');
    const id = newId();
    const enc = this.cipher.encryptJson({ password: input.password ?? '' }, id);
    const now = new Date();
    const row: DatabaseConnection = { id, user_id: userId, name, engine: input.engine, alias, config, encrypted_credentials: enc.ciphertext, iv: enc.iv, tag: enc.tag, status: 'unknown', last_error: null, last_tested_at: null, created_at: now, updated_at: now };
    await this.db.insert(this.s.databaseConnections).values(row);
    return this.toPublic(row);
  }

  async update(userId: string, id: string, patch: { name?: string; alias?: string; config?: DatabaseConfig; password?: string | null }): Promise<PublicDatabaseConnection> {
    const c = await this.getOwned(userId, id);
    const set: Partial<DatabaseConnection> = { updated_at: new Date() };
    if (patch.name !== undefined) set.name = patch.name.trim() || c.name;
    if (patch.alias !== undefined || patch.config !== undefined) {
      const v = this.validate(c.engine, patch.alias ?? c.alias, { ...c.config, ...(patch.config ?? {}) });
      set.alias = v.alias;
      set.config = v.config;
    }
    if (patch.password) {
      const enc = this.cipher.encryptJson({ password: patch.password }, id);
      set.encrypted_credentials = enc.ciphertext;
      set.iv = enc.iv;
      set.tag = enc.tag;
    }
    await this.db.update(this.s.databaseConnections).set(set).where(eq(this.s.databaseConnections.id, id));
    return this.toPublic({ ...c, ...set });
  }

  async remove(userId: string, id: string): Promise<void> {
    await this.getOwned(userId, id);
    await this.db.delete(this.s.databaseConnections).where(eq(this.s.databaseConnections.id, id));
  }

  /** Engine attachments for every database connection a user owns. */
  async resolveAttachments(userId: string): Promise<AttachSpec[]> {
    const rows = await this.db.select().from(this.s.databaseConnections).where(eq(this.s.databaseConnections.user_id, userId));
    const out: AttachSpec[] = [];
    for (const c of rows) {
      try {
        out.push(this.attachSpec(c));
      } catch (err) {
        logger().warn({ id: c.id, err: (err as Error).message }, 'Skipping database connection');
      }
    }
    return out;
  }

  attachSpec(c: DatabaseConnection): AttachSpec {
    const password = this.decrypt(c).password || null;
    const target = attachTarget(c.engine, c.config, password, (p) => this.engines.jail.resolve(p).absolute);
    return { alias: c.alias, target, options: { type: c.engine, ...(c.config.read_only !== false ? { read_only: true } : {}) }, extensions: EXTENSIONS[c.engine] };
  }

  /** Tries the attachment on a scratch instance and records the outcome. */
  async test(userId: string, id: string): Promise<{ ok: boolean; message: string; tables: number }> {
    const c = await this.getOwned(userId, id);
    const started = Date.now();
    try {
      const tables = await this.withScratch(c, async (run) => {
        const r = await run(`SELECT count(*) AS n FROM duckdb_tables() WHERE database_name = ${sqlString(c.alias)}`);
        return Number(r[0]?.n ?? 0);
      });
      await this.db.update(this.s.databaseConnections).set({ status: 'ok', last_error: null, last_tested_at: new Date() }).where(eq(this.s.databaseConnections.id, id));
      return { ok: true, message: `Connected in ${Date.now() - started} ms · ${tables} table${tables === 1 ? '' : 's'} visible`, tables };
    } catch (err) {
      const message = (err as Error).message.split('\n')[0] ?? 'failed';
      await this.db.update(this.s.databaseConnections).set({ status: 'error', last_error: message, last_tested_at: new Date() }).where(eq(this.s.databaseConnections.id, id));
      return { ok: false, message, tables: 0 };
    }
  }

  /** Schemas of the attached database, or the tables and views of one schema. */
  async browse(userId: string, id: string, schema?: string | null): Promise<{ connection: { id: string; name: string; engine: DatabaseEngine; alias: string }; level: 'schemas' | 'tables'; schema: string | null; entries: DatabaseEntry[] }> {
    const c = await this.getOwned(userId, id);
    const entries = await this.withScratch(c, async (run) => {
      if (!schema) {
        const r = await run(`SELECT schema_name FROM duckdb_schemas() WHERE database_name = ${sqlString(c.alias)} AND NOT internal AND schema_name NOT IN ('information_schema', 'pg_catalog') ORDER BY 1`);
        return r.map((x) => ({ name: String(x.schema_name), type: 'schema' as const }));
      }
      const t = await run(`SELECT table_name AS name, 'table' AS type, estimated_size AS rows FROM duckdb_tables() WHERE database_name = ${sqlString(c.alias)} AND schema_name = ${sqlString(schema)} AND NOT internal
        UNION ALL SELECT view_name, 'view', NULL FROM duckdb_views() WHERE database_name = ${sqlString(c.alias)} AND schema_name = ${sqlString(schema)} AND NOT internal ORDER BY 2, 1`);
      return t.map((x) => ({ name: String(x.name), type: x.type as 'table' | 'view', qualified: `${c.alias}.${schema}.${String(x.name)}`, rows: x.rows == null ? null : Number(x.rows) }));
    });
    return { connection: { id: c.id, name: c.name, engine: c.engine, alias: c.alias }, level: schema ? 'tables' : 'schemas', schema: schema ?? null, entries };
  }

  /** A short-lived DuckDB instance with the connection attached — for testing and browsing without a workspace. */
  private async withScratch<T>(c: DatabaseConnection, fn: (run: (sql: string) => Promise<Record<string, unknown>[]>) => Promise<T>): Promise<T> {
    if (NETWORK[c.engine] && !this.cfg.security.enable_external_access && this.cfg.security.filesystem_mode !== 'full') throw badRequest(`${c.engine} connections need security.enable_external_access=true (sandboxed mode blocks network databases)`);
    const options: Record<string, string> = { threads: '2', memory_limit: '256MB' };
    if (this.cfg.duckdb.extension_directory) options.extension_directory = this.cfg.duckdb.extension_directory;
    const inst = await DuckDBInstance.create(':memory:', options);
    const conn = await inst.connect();
    const timer = setTimeout(() => conn.interrupt(), 60_000);
    try {
      const spec = this.attachSpec(c);
      for (const ext of spec.extensions) {
        await conn.run(`LOAD ${ext}`).catch(async () => {
          await conn.run(`INSTALL ${ext}`);
          await conn.run(`LOAD ${ext}`);
        });
      }
      await conn.run(attachToSql(spec, false));
      return await fn(async (sql) => (await conn.runAndReadAll(sql)).getRowObjectsJson() as Record<string, unknown>[]);
    } finally {
      clearTimeout(timer);
      conn.closeSync();
      inst.closeSync();
    }
  }
}

export function suggestAlias(engine: DatabaseEngine, name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30);
  return slug && /^[a-z_]/.test(slug) ? slug : `${engine}_${slug || 'db'}`;
}
