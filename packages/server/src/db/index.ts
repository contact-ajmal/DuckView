/**
 * Metadata database factory.
 *
 * Both dialects expose the same table names/column shapes (see schema/sqlite.ts and schema/pg.ts).
 * The service layer is typed against the SQLite schema; at runtime the matching dialect pair
 * (driver + schema) is selected from `metadata_url`. Drizzle's query builder API is identical
 * for the subset we use (select/insert/update/delete + returning + eq/and/desc), so the cast
 * below is a deliberate, contained type-erasure — NOT a runtime lie: PG code paths always run
 * with pg-core tables.
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { drizzle as drizzleSqlite, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate as migrateSqlite } from 'drizzle-orm/better-sqlite3/migrator';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import { migrate as migratePg } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import Database from 'better-sqlite3';
import pg from 'pg';
import * as sqliteSchema from './schema/sqlite.js';
import * as pgSchema from './schema/pg.js';

export type Schema = typeof sqliteSchema;
export type Db = BetterSQLite3Database<Schema>;
export type Dialect = 'sqlite' | 'pg';

export interface MetadataStore {
  db: Db;
  schema: Schema;
  dialect: Dialect;
  migrate(): Promise<void>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

const here = path.dirname(fileURLToPath(import.meta.url));
/** drizzle/<dialect> lives at the package root, next to src/ and dist/. */
function migrationsFolder(dialect: Dialect): string {
  const candidates = [path.resolve(here, '../../drizzle', dialect), path.resolve(here, '../drizzle', dialect)];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error(`Migrations folder not found for ${dialect} (looked in ${candidates.join(', ')})`);
}

export function parseMetadataUrl(url: string): { dialect: Dialect; target: string } {
  if (url.startsWith('sqlite://')) return { dialect: 'sqlite', target: url.slice('sqlite://'.length) || 'duckview_meta.db' };
  if (url.startsWith('sqlite:')) return { dialect: 'sqlite', target: url.slice('sqlite:'.length) || 'duckview_meta.db' };
  if (url.startsWith('file:')) return { dialect: 'sqlite', target: url.slice('file:'.length) };
  if (url.startsWith('postgres://') || url.startsWith('postgresql://')) return { dialect: 'pg', target: url };
  if (url === ':memory:') return { dialect: 'sqlite', target: ':memory:' };
  throw new Error(`Unsupported metadata_url: ${url}`);
}

export async function createMetadataStore(url: string): Promise<MetadataStore> {
  const { dialect, target } = parseMetadataUrl(url);

  if (dialect === 'sqlite') {
    if (target !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
    const sqlite = new Database(target);
    // Wait for the lock first: several processes may open the same file at once (cluster nodes starting together).
    sqlite.pragma('busy_timeout = 5000');
    // Switching a new file to WAL does not wait for the lock: retry while another process sets it up.
    for (let attempt = 0; ; attempt++) {
      try {
        sqlite.pragma('journal_mode = WAL');
        break;
      } catch (err) {
        if (attempt >= 40 || !/database is locked/i.test((err as Error).message)) throw err;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100 + Math.random() * 150);
      }
    }
    sqlite.pragma('foreign_keys = ON');
    const db = drizzleSqlite(sqlite, { schema: sqliteSchema });
    return {
      db,
      schema: sqliteSchema,
      dialect,
      async migrate() {
        // Another process migrating the same file holds the write lock; its migrations are ours, so try again.
        for (let attempt = 0; ; attempt++) {
          try {
            migrateSqlite(db, { migrationsFolder: migrationsFolder('sqlite') });
            return;
          } catch (err) {
            if (attempt >= 20 || !/database is locked|SQLITE_BUSY/i.test(String((err as Error).message) + String((err as { cause?: Error }).cause?.message ?? ''))) throw err;
            await new Promise((r) => setTimeout(r, 250 + Math.random() * 250));
          }
        }
      },
      async ping() {
        try {
          sqlite.prepare('SELECT 1').get();
          return true;
        } catch {
          return false;
        }
      },
      async close() {
        sqlite.close();
      },
    };
  }

  const pool = new pg.Pool({ connectionString: target, max: 10 });
  const pgDb = drizzlePg(pool, { schema: pgSchema });
  return {
    db: pgDb as unknown as Db,
    schema: pgSchema as unknown as Schema,
    dialect,
    async migrate() {
      // One node migrates at a time (cluster nodes starting together): a session lock around the migrations.
      const client = await pool.connect();
      try {
        await client.query('SELECT pg_advisory_lock(7418220114)');
        await migratePg(pgDb, { migrationsFolder: migrationsFolder('pg') });
      } finally {
        await client.query('SELECT pg_advisory_unlock(7418220114)').catch(() => undefined);
        client.release();
      }
    },
    async ping() {
      try {
        await pgDb.execute(sql`SELECT 1`);
        return true;
      } catch {
        return false;
      }
    },
    async close() {
      await pool.end();
    },
  };
}

export * from './schema/sqlite.js';
