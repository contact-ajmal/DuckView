import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { loadConfig } from '../config/index.js';
import { initLogger } from '../observability/logger.js';
import { createContext, type AppContext } from '../context.js';
import { buildApp } from '../app.js';
import { DEFAULT_POLICY, type WorkspacePolicy } from '../services/workspace-lifecycle.js';
import type { Principal } from '../services/principal.js';

let dir: string;
let ctx: AppContext;
let app: Awaited<ReturnType<typeof buildApp>>['app'];
let base: string;
let adminJwt: string;
let userJwt: string;
let admin: Principal;

const api = async (method: string, url: string, token: string, body?: unknown) => {
  const res = await fetch(base + url, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: Record<string, any> = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json, res };
};
const login = async (email: string, password: string) => ((await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) })).json()) as { token: string }).token;
const sqlq = (ws: string, sql: string, token = adminJwt) => api('POST', `/api/workspaces/${ws}/query`, token, { sql });
const policy = (patch: (p: WorkspacePolicy) => void) => {
  const p: WorkspacePolicy = JSON.parse(JSON.stringify(DEFAULT_POLICY));
  patch(p);
  return api('PUT', '/api/admin/workspace-policy', adminJwt, p);
};

beforeAll(async () => {
  initLogger({ level: 'silent', stderr: true, pretty: false });
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dv-wsl-')));
  const cfg = loadConfig({
    configPath: null,
    env: { DUCKVIEW_DATA_DIR: path.join(dir, 'data'), DUCKVIEW_FILESYSTEM_MODE: 'sandboxed', DUCKDB_TEMP_DIRECTORY: path.join(dir, 'spill'), DATABASE_URL: ':memory:', DUCKDB_MEMORY_LIMIT: '1GB', DUCKVIEW_ADMIN_EMAIL: 'admin@test.local', DUCKVIEW_ADMIN_PASSWORD: 'super-secret-pw', LOG_LEVEL: 'silent' },
  });
  ctx = await createContext(cfg);
  ({ app } = await buildApp(ctx));
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  adminJwt = await login('admin@test.local', 'super-secret-pw');
  admin = ctx.auth.principalFromUser((await ctx.auth.findByEmail('admin@test.local'))!, 'jwt', '127.0.0.1');
  await ctx.auth.createLocalUser({ email: 'analyst@test.local', password: 'analyst-pass-123', role: 'USER' });
  userJwt = await login('analyst@test.local', 'analyst-pass-123');
});

afterAll(async () => {
  await app?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('backups', () => {
  let ws: string;
  it('backs up and restores data, keeping current objects unless asked, with a safety backup first', async () => {
    ws = (await api('POST', '/api/workspaces', adminJwt, { name: 'Ledger', active_db_path: 'ledger.duckdb' })).json.workspace.id;
    await sqlq(ws, 'CREATE TABLE entries AS SELECT range AS id FROM range(3)');
    await api('POST', `/api/workspaces/${ws}/queries`, adminJwt, { name: 'Count', sql_text: 'SELECT count(*) FROM entries' });
    const b = await api('POST', `/api/workspaces/${ws}/backups`, adminJwt, { note: 'before the import' });
    expect(b.status).toBe(200);
    expect(b.json.backup).toMatchObject({ kind: 'manual', tables: 1, objects: { queries: 1 }, note: 'before the import' });
    expect(b.json.backup.file).toContain(`${path.sep}.duckview${path.sep}backups${path.sep}`);

    await sqlq(ws, 'INSERT INTO entries SELECT range + 100 FROM range(10)');
    await api('POST', `/api/workspaces/${ws}/queries`, adminJwt, { name: 'Later', sql_text: 'SELECT 2' });
    const r = await api('POST', `/api/workspaces/${ws}/backups/${b.json.backup.id}/restore`, adminJwt, {});
    expect(r.status).toBe(200);
    expect(r.json.safety.kind).toBe('pre_restore');
    expect((await sqlq(ws, 'SELECT count(*) AS n FROM entries')).json.rows[0].map(Number)).toEqual([3]);
    // The manifest never shows up as a table.
    expect((await sqlq(ws, "SELECT count(*) FROM duckdb_schemas() WHERE schema_name = '__duckview'")).json.rows[0].map(Number)).toEqual([0]);
    expect((await ctx.savedQueries.list(admin, ws)).map((q) => q.name).sort()).toEqual(['Count', 'Later']);

    // With objects: the backup's queries replace the current ones.
    await api('POST', `/api/workspaces/${ws}/backups/${b.json.backup.id}/restore`, adminJwt, { objects: true });
    expect((await ctx.savedQueries.list(admin, ws)).map((q) => q.name)).toEqual(['Count']);
    const list = await api('GET', `/api/workspaces/${ws}/backups`, adminJwt);
    expect(list.json.backups.map((x: { kind: string }) => x.kind)).toEqual(['pre_restore', 'pre_restore', 'manual']);
    // Owners only.
    expect((await api('GET', `/api/workspaces/${ws}/backups`, userJwt)).status).toBe(404);
  });

  it('takes scheduled backups when due and keeps the newest', async () => {
    await api('PUT', `/api/workspaces/${ws}/backup-policy`, adminJwt, { policy: { every_hours: 1, keep: 1 } });
    await ctx.store.db.update(ctx.store.schema.workspaces).set({ last_backup_at: new Date(Date.now() - 2 * 3_600_000) }).where(eq(ctx.store.schema.workspaces.id, ws));
    expect((await ctx.lifecycle.tick()).backups).toContain(ws);
    expect((await ctx.lifecycle.tick()).backups).not.toContain(ws); // not due again yet
    await ctx.store.db.update(ctx.store.schema.workspaces).set({ last_backup_at: new Date(Date.now() - 2 * 3_600_000) }).where(eq(ctx.store.schema.workspaces.id, ws));
    await ctx.lifecycle.tick();
    const scheduled = (await api('GET', `/api/workspaces/${ws}/backups`, adminJwt)).json.backups.filter((x: { kind: string }) => x.kind === 'scheduled');
    expect(scheduled).toHaveLength(1);
    expect(fs.existsSync(scheduled[0].file)).toBe(true);
  });
});

describe('bundles', () => {
  it('exports a workspace as one file and imports it, by path or upload', async () => {
    const src = (await api('POST', '/api/workspaces', adminJwt, { name: 'Portable', description: 'Moves between servers', tags: ['travel'], active_db_path: 'portable.duckdb' })).json.workspace.id;
    await sqlq(src, 'CREATE TABLE trips AS SELECT range AS id FROM range(4)');
    await api('POST', `/api/workspaces/${src}/queries`, adminJwt, { name: 'Trips', sql_text: 'SELECT * FROM trips' });
    const res = await fetch(`${base}/api/workspaces/${src}/bundle`, { headers: { authorization: `Bearer ${adminJwt}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain('Portable.duckview');
    const bytes = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(path.join(dir, 'data', 'portable-copy.duckview'), bytes);
    // The temporary file is gone once the download finished.
    for (let i = 0; i < 20 && fs.readdirSync(path.join(dir, 'data', '.duckview', 'exports')).length; i++) await new Promise((r) => setTimeout(r, 50));
    expect(fs.readdirSync(path.join(dir, 'data', '.duckview', 'exports'))).toHaveLength(0);

    const byPath = await api('POST', '/api/workspaces/import', adminJwt, { path: 'portable-copy.duckview', name: 'Portable again' });
    expect(byPath.status).toBe(200);
    expect(byPath.json.workspace).toMatchObject({ name: 'Portable again', description: 'Moves between servers', tags: ['travel'] });
    const id = byPath.json.workspace.id;
    expect((await sqlq(id, 'SELECT count(*) FROM trips')).json.rows[0].map(Number)).toEqual([4]);
    expect((await ctx.savedQueries.list(admin, id)).map((q) => q.name)).toEqual(['Trips']);

    const form = new FormData();
    form.append('name', 'Portable uploaded');
    form.append('file', new Blob([bytes]), 'portable.duckview');
    const up = await fetch(`${base}/api/workspaces/import`, { method: 'POST', headers: { authorization: `Bearer ${adminJwt}` }, body: form });
    expect(up.status).toBe(200);
    const upId = ((await up.json()) as { workspace: { id: string } }).workspace.id;
    expect((await sqlq(upId, 'SELECT count(*) FROM trips')).json.rows[0].map(Number)).toEqual([4]);
  });

  it('refuses a file that is not a bundle and leaves nothing behind', async () => {
    const before = (await api('GET', '/api/admin/workspaces', adminJwt)).json.workspaces.length;
    const other = (await api('POST', '/api/workspaces', adminJwt, { name: 'Plain', active_db_path: 'plain.duckdb' })).json.workspace.id;
    await sqlq(other, 'CREATE TABLE x AS SELECT 1');
    ctx.engines.evict(other);
    await ctx.engines.released();
    fs.copyFileSync(path.join(dir, 'data', 'plain.duckdb'), path.join(dir, 'data', 'not-a-bundle.duckview'));
    const r = await api('POST', '/api/workspaces/import', adminJwt, { path: 'not-a-bundle.duckview', name: 'Nope' });
    expect(r.status).toBe(400);
    expect(r.json.message).toMatch(/not a DuckView bundle/);
    expect((await api('GET', '/api/admin/workspaces', adminJwt)).json.workspaces.length).toBe(before + 1);
    expect(fs.existsSync(path.join(dir, 'data', 'nope.duckdb'))).toBe(false);
  });
});

describe('workspace policy', () => {
  it('is for administrators, and validated', async () => {
    expect((await api('GET', '/api/admin/workspace-policy', userJwt)).status).toBe(403);
    expect((await policy((p) => { p.idle.warn_days = 10; p.idle.archive_days = 5; })).status).toBe(400);
    expect((await policy((p) => { p.creation.name_pattern = '(['; })).status).toBe(400);
  });

  it('applies creation rules and engine defaults', async () => {
    await policy((p) => { p.creation.name_pattern = '^[a-z][a-z0-9-]*$'; p.creation.name_hint = 'lower case, digits and dashes'; p.creation.threads = 2; });
    const bad = await api('POST', '/api/workspaces', adminJwt, { name: 'Bad Name' });
    expect(bad.status).toBe(400);
    expect(bad.json.message).toMatch(/lower case, digits and dashes/);
    const ok = await api('POST', '/api/workspaces', adminJwt, { name: 'team-a', active_db_path: 'team-a.duckdb' });
    expect(ok.json.workspace.engine_settings.threads).toBe(2);
    await policy((p) => { p.creation.admins_only = true; });
    expect((await api('POST', '/api/workspaces', userJwt, { name: 'Mine' })).status).toBe(403);
    await policy(() => undefined);
  });

  it('enforces quotas: memory cap, storage for writes, query time per day', async () => {
    const ws = (await api('POST', '/api/workspaces', adminJwt, { name: 'Quota', active_db_path: 'quota.duckdb', engine_settings: { memory_limit: '900MB' } })).json.workspace.id;
    await policy((p) => { p.quotas.memory_limit = '200MB'; });
    const mem = await sqlq(ws, "SELECT current_setting('memory_limit') AS m");
    expect(String(mem.json.rows[0][0])).toMatch(/19\d\.\d MiB|200\.0 MB/);

    await sqlq(ws, 'CREATE TABLE t AS SELECT 1 AS a');
    await policy((p) => { p.quotas.storage_bytes = 1; });
    const write = await sqlq(ws, 'INSERT INTO t VALUES (2)');
    expect(write.status).toBe(403);
    expect(write.json.message).toMatch(/storage quota/);
    expect((await sqlq(ws, 'SELECT count(*) FROM t')).status).toBe(200);

    await policy((p) => { p.quotas.query_seconds_per_day = 5; });
    await ctx.store.db.insert(ctx.store.schema.auditLogs).values({ id: `q-${Date.now()}`, user_id: null, actor_type: 'USER', action: 'query.execute', resource: `workspace:${ws}`, query_text: 'SELECT 1', duration_ms: 6000, ip_address: null, status: 'ok', error: null, timestamp: new Date() });
    (ctx.lifecycle as unknown as { usedCache: Map<string, unknown> }).usedCache.clear();
    const slow = await sqlq(ws, 'SELECT 1');
    expect(slow.status).toBe(429);
    expect(slow.json.message).toMatch(/query time for today/);
    const status = await api('GET', `/api/workspaces/${ws}/quota`, adminJwt);
    expect(status.json.query_seconds.used).toBeGreaterThanOrEqual(6);
    await policy(() => undefined);
  });

  it('warns about idle workspaces, then archives them', async () => {
    const w = await ctx.workspaces.create(admin, { name: 'Forgotten', active_db_path: 'forgotten.duckdb' });
    await policy((p) => { p.idle.warn_days = 3; p.idle.archive_days = 10; });
    const s = ctx.store.schema.workspaces;
    await ctx.store.db.update(s).set({ created_at: new Date(Date.now() - 4 * 86_400_000) }).where(eq(s.id, w.id));
    const first = await ctx.lifecycle.tick();
    expect(first.warned).toContain(w.id);
    expect(first.archived).not.toContain(w.id);
    expect((await ctx.lifecycle.tick()).warned).not.toContain(w.id); // warned once
    await ctx.store.db.update(s).set({ created_at: new Date(Date.now() - 11 * 86_400_000) }).where(eq(s.id, w.id));
    expect((await ctx.lifecycle.tick()).archived).toContain(w.id);
    expect((await ctx.workspaces.rowById(w.id))!.archived_at).toBeTruthy();
    await policy(() => undefined);
  });
});
