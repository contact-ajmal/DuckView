/**
 * Workspace databases outside the data directory: cloud-backed (s3:// object worked on through a synced local copy)
 * and, in full filesystem mode, any folder on the host.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { loadConfig } from '../config/index.js';
import { initLogger } from '../observability/logger.js';
import { createContext, type AppContext } from '../context.js';
import { buildApp } from '../app.js';
import type { Principal } from '../services/principal.js';

let dir: string;
let ctx: AppContext;
let app: Awaited<ReturnType<typeof buildApp>>['app'];
let base: string;
let admin: Principal;
let jwt: string;
let mock: { url: string; objects: Map<string, Buffer>; calls: string[]; close: () => void };

/** Minimal path-style S3: HEAD / GET / PUT objects, ETag = md5. Enough for the SDK's single-part upload path. */
function startMockS3(): Promise<typeof mock> {
  const objects = new Map<string, Buffer>();
  const calls: string[] = [];
  const etag = (b: Buffer) => `"${createHash('md5').update(b).digest('hex')}"`;
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const key = decodeURIComponent((req.url ?? '/').split('?')[0]!.replace(/^\//, ''));
      calls.push(`${req.method} ${key}`);
      if (req.method === 'HEAD' || req.method === 'GET') {
        const b = objects.get(key);
        if (!b) {
          res.writeHead(404);
          return res.end();
        }
        res.writeHead(200, { 'content-length': b.length, etag: etag(b), 'last-modified': new Date().toUTCString(), 'content-type': 'application/octet-stream' });
        return req.method === 'HEAD' ? res.end() : res.end(b);
      }
      if (req.method === 'PUT') {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          const b = Buffer.concat(chunks);
          objects.set(key, b);
          res.writeHead(200, { etag: etag(b) });
          res.end();
        });
        return;
      }
      res.writeHead(501);
      res.end();
    });
    srv.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(srv.address() as { port: number }).port}`, objects, calls, close: () => srv.close() }));
  });
}

const api = async (method: string, url: string, body?: unknown, token = jwt) => {
  const res = await fetch(base + url, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
};

beforeAll(async () => {
  initLogger({ level: 'silent', stderr: true, pretty: false });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dv-cloudws-'));
  mock = await startMockS3();
  const cfg = loadConfig({
    configPath: null,
    env: { DUCKVIEW_DATA_DIR: path.join(dir, 'data'), DUCKVIEW_FILESYSTEM_MODE: 'sandboxed', DUCKDB_TEMP_DIRECTORY: path.join(dir, 'spill'), DATABASE_URL: ':memory:', DUCKDB_MEMORY_LIMIT: '512MB', DUCKVIEW_ADMIN_EMAIL: 'admin@test.local', DUCKVIEW_ADMIN_PASSWORD: 'super-secret-pw', DUCKVIEW__duckdb__cloud_sync_delay_seconds: '5', LOG_LEVEL: 'silent' },
  });
  ctx = await createContext(cfg);
  admin = ctx.auth.principalFromUser((await ctx.auth.findByEmail('admin@test.local'))!, 'jwt', '127.0.0.1');
  await ctx.cloud.create(admin.userId, { name: 'lake (mock S3)', provider: 'S3', endpoint_url: mock.url, region: 'us-east-1', bucket: 'lake', credentials: { access_key_id: 'AKIA', secret_access_key: 'shh' } });
  ({ app } = await buildApp(ctx));
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  jwt = (await api('POST', '/api/auth/login', { email: 'admin@test.local', password: 'super-secret-pw' }, '')).json.token as string;
});

afterAll(async () => {
  await app.close();
  await ctx.shutdown();
  mock.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('cloud-backed workspaces', () => {
  it('offers storage options and validates cloud URIs against the owner\'s connections', async () => {
    const opts = await api('GET', '/api/workspaces/storage-options');
    expect(opts.json).toMatchObject({ mode: 'sandboxed', default_database: 'file' });
    expect((opts.json.cloud_connections as { bucket: string; uri_scheme: string }[])[0]).toMatchObject({ bucket: 'lake', uri_scheme: 's3' });
    expect((await api('POST', '/api/workspaces', { name: 'x', active_db_path: 's3://lake/team/notes.txt' })).status).toBe(400);
    const nobucket = await api('POST', '/api/workspaces', { name: 'x', active_db_path: 's3://other-bucket/a.duckdb' });
    expect(nobucket.status).toBe(400);
    expect(String(nobucket.json.message)).toMatch(/No s3:\/\/ cloud connection for bucket "other-bucket"/);
    expect((await api('POST', '/api/workspaces', { name: 'x', active_db_path: 'gs://lake/a.duckdb' })).status).toBe(400); // wrong provider for the only connection
    expect((await api('POST', '/api/workspaces', { name: 'x', active_db_path: '/tmp/outside.duckdb' })).status).toBeGreaterThanOrEqual(400); // sandboxed: no folders outside the data dir
  });

  it('works on a local copy, pushes after changes, and a fresh instance pulls the object back', async () => {
    const created = await api('POST', '/api/workspaces', { name: 'Team analytics', active_db_path: 's3://lake/team/analytics.duckdb' });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    const w = created.json.workspace as { id: string; active_db_path: string; cloud_connection_id: string | null; cloud_sync: { dirty: boolean } | null };
    expect(w.active_db_path).toBe('s3://lake/team/analytics.duckdb');
    expect(w.cloud_connection_id).toBeTruthy();
    expect(ctx.workspaces.storageOf(w)).toBe('cloud');
    // First query: nothing in the cloud yet, the engine starts on an empty local copy under .duckview/cloud.
    await ctx.queries.run(admin, w.id, 'CREATE TABLE facts AS SELECT range AS id, range * 3 AS v FROM range(2000)');
    const local = path.join(dir, 'data', '.duckview', 'cloud', `${w.id}.duckdb`);
    expect(fs.existsSync(local)).toBe(true);
    // The mutation marked it dirty; the working copy is never listed as a data file.
    for (let i = 0; i < 20 && !(await ctx.workspaces.rowById(w.id))!.cloud_sync?.dirty; i++) await new Promise((r) => setTimeout(r, 25));
    expect((await ctx.workspaces.rowById(w.id))!.cloud_sync).toMatchObject({ dirty: true, etag: null });
    expect((await ctx.queries.catalog(admin, w.id)).files.some((f) => f.path.includes('.duckview'))).toBe(false);
    // Sync now: a consistent snapshot lands in the bucket while the engine keeps running.
    const synced = await api('POST', `/api/workspaces/${w.id}/sync`, {});
    expect(synced.status, JSON.stringify(synced.json)).toBe(200);
    const state = synced.json.cloud_sync as { etag: string; dirty: boolean; size_bytes: number; synced_at: string };
    expect(state.dirty).toBe(false);
    expect(state.etag).toMatch(/^"/);
    expect(state.size_bytes).toBeGreaterThan(10_000);
    expect(mock.objects.has('lake/team/analytics.duckdb')).toBe(true);
    expect((await ctx.queries.run(admin, w.id, 'SELECT count(*) AS n FROM facts')).rows[0]![0]).toBe(2000); // still serving
    // A "new instance": no engine, no local copy — the first query pulls the object and the data is there.
    ctx.engines.evict(w.id);
    fs.rmSync(local, { force: true });
    fs.rmSync(`${local}.wal`, { force: true });
    mock.calls.length = 0;
    expect((await ctx.queries.run(admin, w.id, 'SELECT sum(v) AS s FROM facts')).rows[0]![0]).toBe(5997000);
    expect(mock.calls).toContain('GET lake/team/analytics.duckdb');
    // In sync → a restart does not download again.
    ctx.engines.evict(w.id);
    mock.calls.length = 0;
    await ctx.queries.run(admin, w.id, 'SELECT 1');
    expect(mock.calls.filter((c) => c.startsWith('GET'))).toEqual([]);
    // The scheduled push: 5 s after the last change.
    await ctx.queries.run(admin, w.id, "INSERT INTO facts VALUES (99999, 1)");
    await new Promise((r) => setTimeout(r, 6500));
    const after = (await ctx.workspaces.rowById(w.id))!.cloud_sync!;
    expect(after.dirty).toBe(false);
    expect(after.etag).not.toBe(state.etag);
  });

  it('never overwrites local changes with a remote change silently; an explicit sync resolves it', async () => {
    const w = (await ctx.workspaces.create(admin, { name: 'Contested', active_db_path: 's3://lake/contested.duckdb' }));
    await ctx.queries.run(admin, w.id, 'CREATE TABLE mine AS SELECT 1 AS a');
    await ctx.cloudSync.push(w.id, 'test');
    await ctx.queries.run(admin, w.id, 'INSERT INTO mine VALUES (2)'); // dirty again
    for (let i = 0; i < 20 && !(await ctx.workspaces.rowById(w.id))!.cloud_sync?.dirty; i++) await new Promise((r) => setTimeout(r, 25));
    mock.objects.set('lake/contested.duckdb', Buffer.from('someone else wrote this')); // a different instance pushed
    ctx.engines.evict(w.id);
    expect((await ctx.queries.run(admin, w.id, 'SELECT count(*) AS n FROM mine')).rows[0]![0]).toBe(2); // ours, intact
    const st = (await ctx.workspaces.rowById(w.id))!.cloud_sync!;
    expect(st.last_error).toMatch(/changed in the cloud/);
    const resolved = await ctx.cloudSync.push(w.id, 'manual');
    expect(resolved.last_error).toBeNull();
    expect(mock.objects.get('lake/contested.duckdb')!.length).toBeGreaterThan(1000);
  });

  it('persists an in-memory workspace straight into the cloud, tables included', async () => {
    const mem = await ctx.workspaces.create(admin, { name: 'Scratch to cloud', active_db_path: ':memory:' });
    await ctx.queries.run(admin, mem.id, 'CREATE TABLE keep AS SELECT 7 AS seven');
    const r = await api('POST', `/api/workspaces/${mem.id}/persist`, { path: 's3://lake/archive/scratch.duckdb' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json).toMatchObject({ ok: true, path: 's3://lake/archive/scratch.duckdb', copied: true, tables: 1 });
    expect((r.json.cloud_sync as { dirty: boolean; etag: string | null }).dirty).toBe(false);
    expect(mock.objects.has('lake/archive/scratch.duckdb')).toBe(true);
    ctx.engines.evict(mem.id);
    expect((await ctx.queries.run(admin, mem.id, 'SELECT seven FROM keep')).rows[0]![0]).toBe(7);
    // Taken object → refused.
    const other = await ctx.workspaces.create(admin, { name: 'Other', active_db_path: ':memory:' });
    expect((await api('POST', `/api/workspaces/${other.id}/persist`, { path: 's3://lake/archive/scratch.duckdb' })).status).toBe(400);
  });
});

describe('any folder on the host (full filesystem mode)', () => {
  it('stores a workspace database in an arbitrary writable folder', async () => {
    const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'dv-fullws-'));
    const cfg = loadConfig({ configPath: null, env: { DUCKVIEW_DATA_DIR: path.join(d2, 'data'), DUCKVIEW_FILESYSTEM_MODE: 'full', DUCKDB_TEMP_DIRECTORY: path.join(d2, 'spill'), DATABASE_URL: ':memory:', DUCKDB_MEMORY_LIMIT: '512MB', DUCKVIEW_ADMIN_EMAIL: 'admin@test.local', DUCKVIEW_ADMIN_PASSWORD: 'super-secret-pw', LOG_LEVEL: 'silent' } });
    const c2 = await createContext(cfg);
    try {
      const p = c2.auth.principalFromUser((await c2.auth.findByEmail('admin@test.local'))!, 'jwt', '127.0.0.1');
      const folder = path.join(d2, 'mounted-volume', 'analytics');
      const w = await c2.workspaces.create(p, { name: 'On a volume', active_db_path: path.join(folder, 'team.duckdb') });
      expect(c2.workspaces.storageOf(w)).toBe('folder');
      await c2.queries.run(p, w.id, 'CREATE TABLE t AS SELECT 5 AS five');
      expect(fs.existsSync(path.join(folder, 'team.duckdb'))).toBe(true);
      c2.engines.evict(w.id);
      expect((await c2.queries.run(p, w.id, 'SELECT five FROM t')).rows[0]![0]).toBe(5);
      // An unwritable location is refused up front.
      await expect(c2.workspaces.create(p, { name: 'nope', active_db_path: '/proc/nowhere/x.duckdb' })).rejects.toThrow(/Cannot write/);
    } finally {
      await c2.shutdown();
      fs.rmSync(d2, { recursive: true, force: true });
    }
  });
});
