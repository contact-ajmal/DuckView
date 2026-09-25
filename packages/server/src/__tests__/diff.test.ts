import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../config/index.js';
import { initLogger } from '../observability/logger.js';
import { createContext, type AppContext } from '../context.js';
import type { Principal } from '../services/principal.js';

let dir: string;
let ctx: AppContext;
let admin: Principal;
let ws: string;
const sql = (s: string) => ctx.queries.run(admin, ws, s);

beforeAll(async () => {
  initLogger({ level: 'silent', stderr: true, pretty: false });
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dv-diff-')));
  const cfg = loadConfig({ configPath: null, env: { DUCKVIEW_DATA_DIR: path.join(dir, 'data'), DUCKVIEW_FILESYSTEM_MODE: 'sandboxed', DUCKDB_TEMP_DIRECTORY: path.join(dir, 'spill'), DATABASE_URL: ':memory:', DUCKDB_MEMORY_LIMIT: '1GB', DUCKVIEW_ADMIN_EMAIL: 'admin@test.local', DUCKVIEW_ADMIN_PASSWORD: 'super-secret-pw', LOG_LEVEL: 'silent' } });
  ctx = await createContext(cfg);
  admin = ctx.auth.principalFromUser((await ctx.auth.findByEmail('admin@test.local'))!, 'jwt', '127.0.0.1');
  ws = (await ctx.workspaces.create(admin, { name: 'Diff', active_db_path: 'diff.duckdb' })).id;
  await sql("CREATE TABLE before AS SELECT * FROM (VALUES (1, 'ann', 10.0), (2, 'bob', 20.0), (3, 'cy', 30.0), (4, 'dee', 40.0)) t(id, name, amount)");
  // 1 removed, 5 added, 2 changed amount, 3 changed name and amount; a column added.
  await sql("CREATE TABLE after AS SELECT * FROM (VALUES (2, 'bob', 25.0, 'x'), (3, 'cyd', 35.0, 'y'), (4, 'dee', 40.0, 'z'), (5, 'eve', 50.0, 'w')) t(id, name, amount, note)");
});

afterAll(async () => {
  await ctx?.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('dataset diff', () => {
  it('matches rows by key: added, removed, changed, and which columns changed', async () => {
    const d = await ctx.diff.compare(admin, ws, { left: 'before', right: 'after', key: ['id'] });
    expect(d.left.rows).toBe(4);
    expect(d.right.rows).toBe(4);
    expect(d.schema.added).toEqual([{ name: 'note', type: 'VARCHAR' }]);
    expect(d.schema.removed).toEqual([]);
    expect({ added: d.added, removed: d.removed, changed: d.changed, unchanged: d.unchanged }).toEqual({ added: 1, removed: 1, changed: 2, unchanged: 1 });
    expect(d.columns).toEqual([{ name: 'amount', changed: 2 }, { name: 'name', changed: 1 }]);
    expect(d.samples.added[0]).toMatchObject({ id: 5, name: 'eve' });
    expect(d.samples.removed[0]).toMatchObject({ id: 1, name: 'ann' });
    const cy = d.samples.changed.find((c) => c.key.id === 3)!;
    expect(cy.changes).toEqual([{ column: 'name', before: 'cy', after: 'cyd' }, { column: 'amount', before: 30, after: 35 }]);
  });

  it('without a key, counts whole rows on one side only', async () => {
    const d = await ctx.diff.compare(admin, ws, { left: 'before', right: 'after' });
    expect(d.only_left).toBe(3); // ann, bob 20, cy 30
    expect(d.only_right).toBe(3); // bob 25, cyd 35, eve
    expect(d.changed).toBeNull();
  });

  it('compares a query with a table, and a table with its copy in a backup', async () => {
    const b = await ctx.lifecycle.backup(admin, ws, 'manual');
    await sql('UPDATE before SET amount = amount + 1 WHERE id = 1');
    expect(await ctx.diff.backupTables(admin, ws, b.id)).toEqual(expect.arrayContaining(['after', 'before']));
    const d = await ctx.diff.compare(admin, ws, { left: `backup:${b.id}:before`, right: 'before', key: ['id'] });
    expect({ changed: d.changed, added: d.added, removed: d.removed }).toEqual({ changed: 1, added: 0, removed: 0 });
    expect(d.samples.changed[0]!.changes).toEqual([{ column: 'amount', before: 10, after: 11 }]);
    const q = await ctx.diff.compare(admin, ws, { left: 'SELECT id, name FROM before WHERE id < 3', right: 'before', key: ['id'] });
    expect(q.added).toBe(2);
    // The backup is detached again.
    const attached = await ctx.queries.run(admin, ws, "SELECT count(*) FROM duckdb_databases() WHERE database_name LIKE '__dv_bk%'");
    expect(attached.rows[0]).toEqual([0]);
  });

  it('explains what cannot be compared', async () => {
    await expect(ctx.diff.compare(admin, ws, { left: 'before', right: 'after', key: ['note'] })).rejects.toThrow(/not on both sides/);
    await expect(ctx.diff.compare(admin, ws, { left: 'SELECT 1 AS a', right: 'SELECT 2 AS b' })).rejects.toThrow(/no column in common/);
  });
});
