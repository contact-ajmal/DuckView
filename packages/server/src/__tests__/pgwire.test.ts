/**
 * The Postgres wire protocol, driven by real clients: node-postgres (simple and extended protocols, named prepared
 * statements, typed parameters, errors that leave the session usable) and — when installed — psql. Workspaces by
 * name, passwords and API tokens, access policies applied to what a viewer reads, and the helpers underneath.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import pg from 'pg';
import { loadConfig } from '../config/index.js';
import { initLogger } from '../observability/logger.js';
import { createContext, type AppContext } from '../context.js';
import { bindParams, paramLiteral, pgText, sessionTag, rewriteForDuckDB } from '../services/pgwire.js';
import type { Principal } from '../services/principal.js';

let dir: string;
let ctx: AppContext;
let admin: Principal;
let port: number;
let viewerToken: string;
let readToken: string;
const psql = (() => {
  try {
    execFileSync('psql', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const client = async (opts: { user?: string; password?: string; database?: string } = {}) => {
  const c = new pg.Client({ host: '127.0.0.1', port, user: opts.user ?? 'admin@test.local', password: opts.password ?? 'super-secret-pw', database: opts.database ?? 'Shop' });
  await c.connect();
  return c;
};

beforeAll(async () => {
  initLogger({ level: 'silent', stderr: true, pretty: false });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dv-pgwire-'));
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  const cfg = loadConfig({ configPath: null, env: { DUCKVIEW_DATA_DIR: path.join(dir, 'data'), DUCKDB_TEMP_DIRECTORY: path.join(dir, 'spill'), DATABASE_URL: ':memory:', DUCKDB_MEMORY_LIMIT: '512MB', DUCKVIEW_ADMIN_EMAIL: 'admin@test.local', DUCKVIEW_ADMIN_PASSWORD: 'super-secret-pw', DUCKVIEW__duckdb__sync_scheduler_enabled: 'false', DUCKVIEW__notifications__scheduler_enabled: 'false', DUCKVIEW__transform__scheduler_enabled: 'false', DUCKVIEW__apps__enabled: 'false', DUCKVIEW__pgwire__enabled: 'true', DUCKVIEW__pgwire__port: '0', LOG_LEVEL: 'silent' } });
  ctx = await createContext(cfg);
  port = ctx.pgwire.address!.port;
  const adminUser = (await ctx.auth.findByEmail('admin@test.local'))!;
  admin = ctx.auth.principalFromUser(adminUser, 'jwt', '127.0.0.1');
  const ws = await ctx.workspaces.create(admin, { name: 'Shop', active_db_path: 'shop.duckdb' });
  await ctx.workspaces.create(admin, { name: 'Other', active_db_path: 'other.duckdb' });
  await ctx.queries.run(admin, ws.id, "CREATE TABLE orders AS SELECT * FROM (VALUES (1, 'EU', 100.50, DATE '2026-09-01', true), (2, 'US', 50.00, DATE '2026-09-02', false), (3, 'EU', 30.25, DATE '2026-09-03', true)) t(id, region, amount, day, paid)", { cache: false });
  const viewer = await ctx.auth.createLocalUser({ email: 'viewer@test.local', password: 'viewer-secret-pw', role: 'USER' });
  await ctx.workspaces.setMember(admin, ws.id, { subject_type: 'user', subject_id: viewer.id, role: 'VIEWER' });
  await ctx.policies.create(admin, ws.id, { name: 'Viewers: EU', table_name: 'orders', row_filter: "region = 'EU'", applies_to: { roles: ['VIEWER'] } });
  viewerToken = (await ctx.auth.createToken(viewer, { name: 'bi', scopes: ['read'] })).token;
  readToken = (await ctx.auth.createToken(adminUser, { name: 'bi-read', scopes: ['read'], workspaceId: ws.id })).token;
}, 120_000);

afterAll(async () => {
  await ctx?.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('helpers', () => {
  it('binds parameters outside strings, identifiers, comments and dollar quotes', () => {
    const lit = (n: number) => `<${n}>`;
    expect(bindParams("SELECT $1, '$2', \"$3\", $$ $4 $$, $tag$ $5 $tag$ -- $6\n, /* $7 */ $10", lit)).toBe("SELECT <1>, '$2', \"$3\", $$ $4 $$, $tag$ $5 $tag$ -- $6\n, /* $7 */ <10>");
    expect(paramLiteral("O'Brien", 25)).toBe("'O''Brien'");
    expect(paramLiteral('42', 23)).toBe('42');
    expect(paramLiteral('42; DROP TABLE x', 23)).toBe("'42; DROP TABLE x'");
    expect(paramLiteral('2026-01-01', 1082)).toBe("'2026-01-01'::DATE");
    expect(paramLiteral('true', 16)).toBe('TRUE');
    expect(paramLiteral(null, 25)).toBe('NULL');
    expect(pgText(true)).toBe('t');
    expect(pgText(['a', 'b"c', null])).toBe('{"a","b\\"c",NULL}');
    expect([sessionTag('SET extra_float_digits = 3'), sessionTag('begin'), sessionTag('END'), sessionTag('SELECT 1')]).toEqual(['SET', 'BEGIN', 'COMMIT', null]);
    expect(rewriteForDuckDB('SHOW transaction_isolation', 'v1.5.5')).toEqual({ answer: { column: 'transaction_isolation', value: 'read committed' } });
    expect(rewriteForDuckDB('select version()', 'v1.5.5')).toEqual({ sql: "select 'PostgreSQL 15.0 (DuckView, DuckDB v1.5.5)'" });
  });
});

describe('node-postgres', () => {
  it('connects to a workspace by name and runs simple and parameterized queries', async () => {
    const c = await client();
    const one = await c.query('SELECT 1 AS one, \'x\' AS s, 2.5::DOUBLE AS d, NULL AS n, [1, 2] AS l');
    expect(one.rows).toEqual([{ one: 1, s: 'x', d: 2.5, n: null, l: [1, 2] }]);
    expect(one.fields.map((f) => f.dataTypeID)).toEqual([23, 25, 701, 23, 1007]);
    const p = await c.query('SELECT id, region, amount, day, paid FROM orders WHERE region = $1 AND amount > $2 ORDER BY id', ['EU', 20]);
    expect(p.rows.map((r) => [r.id, r.region, r.amount, r.paid])).toEqual([[1, 'EU', '100.50', true], [3, 'EU', '30.25', true]]);
    expect(p.rows[0].day).toBeInstanceOf(Date);
    // A named prepared statement, run twice with different values.
    const named = async (v: string) => (await c.query({ name: 'by_region', text: 'SELECT count(*)::INTEGER AS n FROM orders WHERE region = $1', values: [v] })).rows[0].n;
    expect([await named('EU'), await named('US')]).toEqual([2, 1]);
    const many = await c.query('SELECT range AS i FROM range(5000)');
    expect(many.rowCount).toBe(5000);
    await c.end();
  });

  it('answers what drivers ask, and stays usable after an error', async () => {
    const c = await client();
    expect((await c.query('SELECT version() AS v')).rows[0].v).toMatch(/^PostgreSQL 15\.0 \(DuckView, DuckDB v1\.5/);
    expect((await c.query('SHOW server_version')).rows).toEqual([{ server_version: '15.0' }]);
    await c.query('SET application_name = \'tableau\'');
    await c.query('BEGIN');
    await c.query('COMMIT');
    await expect(c.query('SELEC 1')).rejects.toMatchObject({ code: '42601' });
    await expect(c.query('SELECT * FROM no_such_table')).rejects.toMatchObject({ code: '42P01' });
    await expect(c.query('SELECT * FROM orders WHERE id = $1', ['not a number'])).rejects.toBeTruthy();
    expect((await c.query('SELECT count(*)::INTEGER AS n FROM orders')).rows[0].n).toBe(3);
    expect((await c.query("SELECT count(*)::INTEGER AS n FROM pg_catalog.pg_namespace")).rows[0].n).toBeGreaterThan(0);
    // Writes go through like in the workbench (an administrator may write).
    const ins = await c.query('CREATE TABLE notes AS SELECT 1 AS id');
    expect(ins.command).toBe('CREATE');
    const up = await c.query('INSERT INTO notes VALUES (2), (3)');
    expect(up.rowCount).toBe(2);
    await c.end();
  });

  it('authenticates with passwords or API tokens, and applies access policies', async () => {
    await expect(client({ password: 'wrong' })).rejects.toMatchObject({ code: '28P01' });
    await expect(client({ database: 'Nope' })).rejects.toMatchObject({ code: '3D000' });
    const viewer = await client({ user: 'viewer@test.local', password: viewerToken });
    expect((await viewer.query('SELECT region, count(*)::INTEGER AS n FROM orders GROUP BY 1 ORDER BY 1')).rows).toEqual([{ region: 'EU', n: 2 }]);
    await expect(viewer.query('DELETE FROM orders')).rejects.toBeTruthy();
    await viewer.end();
    // A token bound to one workspace opens it without naming it, and reads only.
    const bi = await client({ user: 'anything', password: readToken, database: '' });
    expect((await bi.query('SELECT count(*)::INTEGER AS n FROM orders')).rows[0].n).toBe(3);
    await expect(bi.query('DROP TABLE orders')).rejects.toBeTruthy();
    await bi.end();
    await expect(client({ password: readToken, database: 'Other' })).rejects.toMatchObject({ code: '3D000' });
  });
});

describe.skipIf(!psql)('psql', () => {
  it('runs queries from the command line', async () => {
    // Asynchronously: the server answers from this same process.
    const { stdout } = await promisify(execFile)('psql', ['-h', '127.0.0.1', '-p', String(port), '-U', 'admin@test.local', '-d', 'Shop', '-At', '-c', "SELECT region || ':' || count(*) FROM orders GROUP BY region ORDER BY region"], { env: { ...process.env, PGPASSWORD: 'super-secret-pw', PGCONNECT_TIMEOUT: '5' } });
    expect(stdout.trim().split('\n')).toEqual(['EU:2', 'US:1']);
  });
});
