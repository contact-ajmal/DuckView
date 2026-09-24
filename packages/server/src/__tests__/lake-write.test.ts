/**
 * Writing back to open table formats: the type casts, Delta commits (a table DuckView creates, appends through
 * DuckDB's delta extension, a replace that removes the old files — read back by delta_scan, i.e. delta-kernel), and
 * — with DUCKVIEW_TEST_ICEBERG set (an Iceberg REST catalog, with MinIO for its storage) — an Iceberg table
 * created, appended to and mirrored (updates and deletes by key) through a lakehouse connection.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { loadConfig } from '../config/index.js';
import { initLogger } from '../observability/logger.js';
import { createContext, type AppContext } from '../context.js';
import { castFor, deltaType, deltaCommit, latestDeltaVersion } from '../services/lake-write.js';
import type { Principal } from '../services/principal.js';

let dir: string;
let ctx: AppContext;
let wsId: string;
let admin: Principal;
/** e.g. http://localhost:8181 — an Iceberg REST catalog whose warehouse is s3://warehouse/ on MinIO at DUCKVIEW_TEST_ICEBERG_S3. */
const ICEBERG = process.env.DUCKVIEW_TEST_ICEBERG;
const ICEBERG_S3 = process.env.DUCKVIEW_TEST_ICEBERG_S3 ?? 'http://localhost:9000';

const q = async (sql: string) => (await ctx.queries.run(admin, wsId, sql, { cache: false })).rows;
/** Reads with a fresh DuckDB, the way another tool would. */
async function outside(sql: string, setup: string[] = []): Promise<unknown[][]> {
  const inst = await DuckDBInstance.create(':memory:');
  const conn = await inst.connect();
  try {
    for (const s of setup) await conn.run(s);
    return (await conn.runAndReadAll(sql)).getRowsJson() as unknown[][];
  } finally {
    conn.closeSync();
    inst.closeSync();
  }
}

beforeAll(async () => {
  initLogger({ level: 'silent', stderr: true, pretty: false });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dv-lake-write-'));
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  const cfg = loadConfig({ configPath: null, env: { DUCKVIEW_DATA_DIR: path.join(dir, 'data'), DUCKDB_TEMP_DIRECTORY: path.join(dir, 'spill'), DATABASE_URL: ':memory:', DUCKDB_MEMORY_LIMIT: '512MB', DUCKVIEW_ADMIN_EMAIL: 'admin@test.local', DUCKVIEW_ADMIN_PASSWORD: 'super-secret-pw', DUCKVIEW__duckdb__sync_scheduler_enabled: 'false', DUCKVIEW__notifications__scheduler_enabled: 'false', DUCKVIEW__transform__scheduler_enabled: 'false', DUCKVIEW__apps__enabled: 'false', LOG_LEVEL: 'silent' } });
  ctx = await createContext(cfg);
  admin = ctx.auth.principalFromUser((await ctx.auth.findByEmail('admin@test.local'))!, 'jwt', '127.0.0.1');
  wsId = (await ctx.workspaces.create(admin, { name: 'Lake', active_db_path: 'lake.duckdb' })).id;
  await ctx.queries.run(admin, wsId, "CREATE TABLE orders AS SELECT * FROM (VALUES (1, 'EU', 100.5, TIMESTAMP '2026-09-01 10:00:00', [1, 2], 7::UBIGINT), (2, 'US', 50.0, TIMESTAMP '2026-09-02 11:30:00', [3], 8::UBIGINT)) t(id, region, amount, placed_at, tags, big)", { cache: false });
}, 120_000);

afterAll(async () => {
  await ctx?.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('types and commits', () => {
  it('casts to what each format stores', () => {
    expect(castFor('delta', 'u', 'UBIGINT')).toEqual({ sql: 'CAST("u" AS DECIMAL(38,0)) AS "u"', type: 'DECIMAL(38,0)' });
    expect(castFor('delta', 'ts', 'TIMESTAMP')).toEqual({ sql: 'timezone(\'UTC\', "ts") AS "ts"', type: 'TIMESTAMP WITH TIME ZONE' });
    expect(castFor('iceberg', 'ts', 'TIMESTAMP').sql).toBe('"ts"');
    expect(castFor('delta', 'l', 'INTEGER[]')).toEqual({ sql: 'CAST(to_json("l") AS VARCHAR) AS "l"', type: 'VARCHAR' });
    expect(castFor('iceberg', 'l', 'INTEGER[]').sql).toBe('"l"');
    expect(castFor('iceberg', 'j', 'JSON').type).toBe('VARCHAR');
    expect([deltaType('DECIMAL(10,2)'), deltaType('BIGINT'), deltaType('TIMESTAMP WITH TIME ZONE'), deltaType('VARCHAR')]).toEqual(['decimal(10,2)', 'long', 'timestamp', 'string']);
    expect(latestDeltaVersion(['00000000000000000000.json', '00000000000000000010.checkpoint.parquet', '00000000000000000011.json', '_last_checkpoint'])).toBe(11);
    const lines = deltaCommit({ tableId: 't', columns: [{ name: 'a', type: 'BIGINT' }], create: true, replace: false, remove: [], add: { path: 'p.parquet', size: 10, rows: 2 }, now: 1 }).trim().split('\n').map((l) => Object.keys(JSON.parse(l))[0]);
    expect(lines).toEqual(['commitInfo', 'protocol', 'metaData', 'add']);
  });
});

describe('Delta Lake', () => {
  it('creates a table, appends through DuckDB, and replaces with a new version', async () => {
    const sync = await ctx.reverse.create(admin, wsId, { name: 'Orders to Delta', sql: 'SELECT * FROM orders', destination: { kind: 'delta', path: 'lake/orders' }, mode: 'replace' });
    const table = path.join(dir, 'data', 'lake', 'orders');
    const run1 = await ctx.reverse.run(sync.id, 'manual', admin);
    expect(run1).toMatchObject({ status: 'ok' });
    expect(run1.summary).toMatch(/2 rows written — created lake\/orders \(version 0\)/);
    const read = () => outside(`SELECT id, region, amount::DOUBLE, placed_at::VARCHAR, tags, big FROM delta_scan('${table}') ORDER BY id`, ['LOAD delta', "SET TimeZone = 'UTC'"]);
    expect(await read()).toEqual([[1, 'EU', 100.5, '2026-09-01 10:00:00+00', '[1,2]', '7'], [2, 'US', 50, '2026-09-02 11:30:00+00', '[3]', '8']]);
    // Append: DuckDB writes version 1.
    await ctx.queries.run(admin, wsId, "INSERT INTO orders VALUES (3, 'EU', 25.0, TIMESTAMP '2026-09-03 09:00:00', [], 9)", { cache: false });
    await ctx.reverse.update(admin, sync.id, { mode: 'append', sql: 'SELECT * FROM orders WHERE id = 3' });
    expect((await ctx.reverse.run(sync.id, 'manual', admin)).status).toBe('ok');
    expect((await read()).map((r) => r[0])).toEqual([1, 2, 3]);
    // Replace: version 2 removes every earlier file.
    await ctx.reverse.update(admin, sync.id, { mode: 'replace', sql: 'SELECT * FROM orders WHERE region = \'EU\'' });
    const run3 = await ctx.reverse.run(sync.id, 'manual', admin);
    expect(run3.summary).toMatch(/replaced lake\/orders \(version 2\)/);
    expect((await read()).map((r) => r[0])).toEqual([1, 3]);
    expect(fs.readdirSync(path.join(table, '_delta_log')).sort()).toEqual(['00000000000000000000.json', '00000000000000000001.json', '00000000000000000002.json']);
    await expect(ctx.reverse.create(admin, wsId, { name: 'x', sql: 'SELECT 1 AS id', destination: { kind: 'delta', path: 'lake/y' }, mode: 'upsert', key_columns: ['id'] })).rejects.toThrow(/replaced or appended/);
  });
});

describe.skipIf(!ICEBERG)('an Iceberg catalog and a bucket (MinIO)', () => {
  it('creates, appends to and mirrors a table of a REST catalog', async () => {
    const lh = await ctx.lakehouse.create(admin.userId, { name: 'Test catalog', provider: 'ICEBERG_REST', alias: 'test_ice', config: { endpoint: ICEBERG!, auth: 'none', warehouse: '' }, credentials: {} });
    const storage = await ctx.cloud.create(admin.userId, { name: 'MinIO', provider: 'S3', endpoint_url: ICEBERG_S3, region: 'us-east-1', bucket: 'warehouse', credentials: { access_key_id: 'admin', secret_access_key: 'password' } });
    const ns = `dv_test_${Date.now()}`;
    await q("CREATE OR REPLACE TABLE ice_orders AS SELECT * FROM (VALUES (1, 'EU', 100.5, TIMESTAMP '2026-09-01 10:00:00', [1, 2], 7::UBIGINT), (2, 'US', 50.0, TIMESTAMP '2026-09-02 11:30:00', [3], 8::UBIGINT), (3, 'EU', 25.0, TIMESTAMP '2026-09-03 09:00:00', [], 9::UBIGINT)) t(id, region, amount, placed_at, tags, big)");
    const sync = await ctx.reverse.create(admin, wsId, { name: 'Orders to Iceberg', sql: 'SELECT id, region, amount, placed_at, tags, big FROM ice_orders', destination: { kind: 'iceberg', connection_id: lh.id, namespace: ns, table: 'orders', storage_connection_id: storage.id }, mode: 'mirror', key_columns: ['id'] });
    const first = await ctx.reverse.run(sync.id, 'manual', admin);
    expect(first.error).toBeNull();
    expect(first.summary).toMatch(new RegExp(`3 rows written — created ${ns}.orders`));
    const endpoint = new URL(ICEBERG_S3);
    const read = () => outside(`SELECT id, region, amount::DOUBLE FROM ice.${ns}.orders ORDER BY id`, ['LOAD httpfs', 'LOAD iceberg', `CREATE SECRET (TYPE S3, KEY_ID 'admin', SECRET 'password', REGION 'us-east-1', ENDPOINT '${endpoint.host}', USE_SSL false, URL_STYLE 'path')`, `ATTACH '' AS ice (TYPE ICEBERG, ENDPOINT '${ICEBERG}', AUTHORIZATION_TYPE 'none')`]);
    expect(await read()).toEqual([[1, 'EU', 100.5], [2, 'US', 50], [3, 'EU', 25]]);
    // Mirror: a changed row, a new row and a deleted row — only those are sent.
    await q("UPDATE ice_orders SET amount = 99.0 WHERE id = 1");
    await q("DELETE FROM ice_orders WHERE id = 2");
    await q("INSERT INTO ice_orders VALUES (4, 'US', 5.0, TIMESTAMP '2026-09-04 08:00:00', [4], 10)");
    const second = await ctx.reverse.run(sync.id, 'manual', admin);
    expect(second.error).toBeNull();
    expect(second.summary).toMatch(/^2 rows written, 1 row deleted/);
    expect(await read()).toEqual([[1, 'EU', 99], [3, 'EU', 25], [4, 'US', 5]]);
    // Append adds; replace starts over.
    await ctx.reverse.update(admin, sync.id, { mode: 'replace', key_columns: [], sql: "SELECT id, region, amount FROM ice_orders WHERE region = 'US'" });
    expect((await ctx.reverse.run(sync.id, 'manual', admin)).summary).toMatch(new RegExp(`replaced ${ns}.orders`));
    expect(await read()).toEqual([[4, 'US', 5]]);
    await outside(`DROP TABLE ice.${ns}.orders`, ['LOAD httpfs', 'LOAD iceberg', `CREATE SECRET (TYPE S3, KEY_ID 'admin', SECRET 'password', REGION 'us-east-1', ENDPOINT '${endpoint.host}', USE_SSL false, URL_STYLE 'path')`, `ATTACH '' AS ice (TYPE ICEBERG, ENDPOINT '${ICEBERG}', AUTHORIZATION_TYPE 'none')`]).catch(() => undefined);
  }, 120_000);

  it('writes a Delta table into a bucket', async () => {
    const storage = await ctx.cloud.create(admin.userId, { name: 'MinIO for Delta', provider: 'S3', endpoint_url: ICEBERG_S3, region: 'us-east-1', bucket: 'warehouse', credentials: { access_key_id: 'admin', secret_access_key: 'password' } });
    const key = `delta/dv_test_${Date.now()}/orders`;
    const sync = await ctx.reverse.create(admin, wsId, { name: 'Orders to Delta in S3', sql: 'SELECT id, region FROM orders ORDER BY id LIMIT 2', destination: { kind: 'delta', path: key, cloud_connection_id: storage.id, bucket: 'warehouse' }, mode: 'replace' });
    expect((await ctx.reverse.run(sync.id, 'manual', admin)).summary).toMatch(/created .* \(version 0\)/);
    await ctx.reverse.update(admin, sync.id, { mode: 'append', sql: "SELECT 9 AS id, 'XX' AS region" });
    const second = await ctx.reverse.run(sync.id, 'manual', admin);
    expect(second.error).toBeNull();
    const endpoint = new URL(ICEBERG_S3);
    expect(await outside(`SELECT id, region FROM delta_scan('s3://warehouse/${key}') ORDER BY id`, ['LOAD httpfs', 'LOAD delta', `CREATE SECRET (TYPE S3, KEY_ID 'admin', SECRET 'password', REGION 'us-east-1', ENDPOINT '${endpoint.host}', USE_SSL false, URL_STYLE 'path')`])).toEqual([[1, 'EU'], [2, 'US'], [9, 'XX']]);
  }, 120_000);
});
