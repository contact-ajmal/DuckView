/**
 * Result cache: exact keys (file stat + workspace epoch), invalidation through every mutation path, non-deterministic
 * SQL bypass, remote TTL mode, ETag / 304 over HTTP, and live epoch events reaching workspace members.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { loadConfig } from '../config/index.js';
import { initLogger } from '../observability/logger.js';
import { createContext, type AppContext } from '../context.js';
import { buildApp } from '../app.js';
import { isDeterministicSql, NotModified } from '../services/cache.js';
import type { Principal } from '../services/principal.js';
import type { User } from '../db/schema/sqlite.js';

let dir: string;
let ctx: AppContext;
let app: Awaited<ReturnType<typeof buildApp>>['app'];
let base: string;
let adminU: User;
let admin: Principal;
let wsId: string;
let jwt: string;

const api = async (method: string, url: string, body?: unknown, headers: Record<string, string> = {}, token = jwt) => {
  const res = await fetch(base + url, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, etag: res.headers.get('etag'), json: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
};

beforeAll(async () => {
  initLogger({ level: 'silent', stderr: true, pretty: false });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dv-cache-'));
  const cfg = loadConfig({
    configPath: null,
    env: { DUCKVIEW_DATA_DIR: path.join(dir, 'data'), DUCKVIEW_FILESYSTEM_MODE: 'sandboxed', DUCKDB_TEMP_DIRECTORY: path.join(dir, 'spill'), DATABASE_URL: ':memory:', DUCKDB_MEMORY_LIMIT: '512MB', DUCKVIEW_ADMIN_EMAIL: 'admin@test.local', DUCKVIEW_ADMIN_PASSWORD: 'super-secret-pw', LOG_LEVEL: 'silent' },
  });
  ctx = await createContext(cfg);
  adminU = (await ctx.auth.findByEmail('admin@test.local'))!;
  admin = ctx.auth.principalFromUser(adminU, 'jwt', '127.0.0.1');
  wsId = (await ctx.workspaces.create(admin, { name: 'Cache lab', active_db_path: 'lab.duckdb' })).id; // persistent: engine restarts do not move the epoch
  await ctx.queries.run(admin, wsId, "COPY (SELECT range AS id, range * 2 AS v FROM range(1000)) TO 'nums.parquet' (FORMAT PARQUET)");
  await ctx.queries.run(admin, wsId, 'CREATE TABLE t AS SELECT range AS id FROM range(10)');
  ({ app } = await buildApp(ctx));
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  jwt = (await api('POST', '/api/auth/login', { email: 'admin@test.local', password: 'super-secret-pw' }, {}, '')).json.token as string;
});

afterAll(async () => {
  await app.close();
  await ctx.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('result cache — keys and hits', () => {
  it('serves a repeated overview from cache and the key survives unrelated mutations for file targets', async () => {
    const a = await ctx.queries.overview(admin, wsId, 'nums.parquet');
    expect(a.cached).toBe(false);
    expect(a.etag).toBeTruthy();
    const b = await ctx.queries.overview(admin, wsId, 'nums.parquet');
    expect(b.cached).toBe(true);
    expect(b.etag).toBe(a.etag);
    expect(b.row_count).toBe(1000);
    // A table mutation moves the epoch but a pure-file profile does not depend on it.
    await ctx.queries.run(admin, wsId, 'INSERT INTO t VALUES (99)');
    const c = await ctx.queries.overview(admin, wsId, 'nums.parquet');
    expect(c.cached).toBe(true);
    expect(c.etag).toBe(a.etag);
  });

  it('a file rewritten on disk changes the key even without any mutation through DuckView', async () => {
    const a = await ctx.queries.profile(admin, wsId, 'nums.parquet');
    const file = path.join(ctx.engines.jail.root, 'nums.parquet');
    const st = fs.statSync(file);
    fs.utimesSync(file, st.atime, new Date(st.mtimeMs + 5000)); // simulate an external edit (mtime moves)
    const b = await ctx.queries.profile(admin, wsId, 'nums.parquet');
    expect(b.cached).toBe(false);
    expect(b.etag).not.toBe(a.etag);
  });

  it('table queries are keyed on the workspace epoch: every mutation path invalidates them', async () => {
    const sql = 'SELECT count(*) AS n FROM t';
    const v0 = await ctx.queries.run(admin, wsId, sql);
    expect(v0.cached).toBe(false);
    expect((await ctx.queries.run(admin, wsId, sql)).cached).toBe(true);
    const expectFresh = async (label: string) => {
      const r = await ctx.queries.run(admin, wsId, sql);
      expect(r.cached, label).toBe(false);
      expect((await ctx.queries.run(admin, wsId, sql)).cached, label + ' (second call)').toBe(true);
    };
    await ctx.queries.run(admin, wsId, 'DELETE FROM t WHERE id = 99');
    await expectFresh('after DELETE');
    await ctx.queries.saveDataset(admin, wsId, { sql: 'SELECT 1 AS x', format: 'csv', target: 'one', dryRun: false });
    await expectFresh('after save_dataset');
    await ctx.files.upload(admin, wsId, { filename: 'up.csv', stream: fs.createReadStream(path.join(ctx.engines.jail.root, 'exports', 'one.csv')) });
    await expectFresh('after upload');
    await ctx.files.remove(admin, wsId, 'up.csv');
    await expectFresh('after delete');
    const folder = fs.mkdtempSync(path.join(ctx.engines.jail.root, 'mount-'));
    await ctx.workspaces.addFolder(admin, wsId, folder);
    await expectFresh('after folder add');
    await ctx.workspaces.removeFolder(admin, wsId, folder);
    await expectFresh('after folder remove');
    // A failed mutating script still moves the epoch (it may have partially applied).
    await expect(ctx.queries.run(admin, wsId, 'INSERT INTO t VALUES (1); INSERT INTO nope VALUES (1)')).rejects.toThrow();
    await expectFresh('after failed script');
  });

  it('a :memory: workspace moves its epoch when the engine (re)starts, a persistent one does not', async () => {
    const mem = await ctx.workspaces.create(admin, { name: 'mem' });
    await ctx.queries.run(admin, mem.id, 'CREATE TABLE m AS SELECT 1 AS a');
    const before = await ctx.workspaces.versionOf(mem.id);
    ctx.engines.evict(mem.id);
    await ctx.queries.run(admin, mem.id, 'SELECT 1'); // engine restarts
    expect(await ctx.workspaces.versionOf(mem.id)).toBeGreaterThan(before);
    const persistentBefore = await ctx.workspaces.versionOf(wsId);
    ctx.engines.evict(wsId);
    await ctx.queries.run(admin, wsId, 'SELECT 1');
    expect(await ctx.workspaces.versionOf(wsId)).toBe(persistentBefore);
  });

  it('never caches non-deterministic or mutating SQL; caches explain but not explain analyze', async () => {
    expect(isDeterministicSql('SELECT random()')).toBe(false);
    expect(isDeterministicSql('SELECT now(), 1')).toBe(false);
    expect(isDeterministicSql("SELECT 'random()' AS s")).toBe(true); // inside a string literal
    const r1 = await ctx.queries.run(admin, wsId, 'SELECT random() AS r');
    expect(r1.etag).toBeNull();
    const r2 = await ctx.queries.run(admin, wsId, 'SELECT random() AS r');
    expect(r2.rows[0]![0]).not.toBe(r1.rows[0]![0]);
    expect((await ctx.queries.run(admin, wsId, 'CREATE TABLE tmp_x AS SELECT 1')).etag).toBeNull();
    const e1 = await ctx.queries.explain(admin, wsId, 'SELECT * FROM t');
    const e2 = await ctx.queries.explain(admin, wsId, 'SELECT * FROM t');
    expect(e2.cached).toBe(true);
    expect(e1.etag).toBe(e2.etag);
    const a = await ctx.queries.explain(admin, wsId, 'SELECT * FROM t', true);
    expect(a.etag).toBeNull();
  });

  it('cached rows are copies, page/limit options are part of the key, and results are exact', async () => {
    const p1 = await ctx.queries.run(admin, wsId, "SELECT * FROM 'nums.parquet' ORDER BY id", { maxRows: 5, page: 1 });
    const p2 = await ctx.queries.run(admin, wsId, "SELECT * FROM 'nums.parquet' ORDER BY id", { maxRows: 5, page: 2 });
    expect(p1.rows[0]![0]).toBe(0);
    expect(p2.rows[0]![0]).toBe(5);
    expect(p1.etag).not.toBe(p2.etag);
    const again = await ctx.queries.run(admin, wsId, "SELECT * FROM 'nums.parquet' ORDER BY id", { maxRows: 5, page: 1 });
    expect(again.cached).toBe(true);
    (again.rows[0] as unknown[])[0] = 'mutated';
    expect((await ctx.queries.run(admin, wsId, "SELECT * FROM 'nums.parquet' ORDER BY id", { maxRows: 5, page: 1 })).rows[0]![0]).toBe(0);
  });

  it('refresh recomputes and re-stores; ifNoneMatch short-circuits; workspace clear drops entries', async () => {
    const a = await ctx.queries.profile(admin, wsId, 't');
    const b = await ctx.queries.profile(admin, wsId, 't', { refresh: true });
    expect(b.cached).toBe(false);
    expect(b.etag).toBe(a.etag);
    expect((await ctx.queries.profile(admin, wsId, 't')).cached).toBe(true);
    await expect(ctx.queries.profile(admin, wsId, 't', { ifNoneMatch: `"${a.etag}"` })).rejects.toBeInstanceOf(NotModified);
    const stats = ctx.cache.stats();
    expect(stats.entries).toBeGreaterThan(0);
    ctx.cache.invalidateWorkspace(wsId, { all: true });
    expect((await ctx.queries.profile(admin, wsId, 't')).cached).toBe(false);
  });

  it('respects the byte budget with LRU eviction', async () => {
    const saved = { ...ctx.cfg.cache };
    ctx.cache.clear();
    const q = (i: number) => ctx.queries.run(admin, wsId, `SELECT id, v, ${i} AS k FROM 'nums.parquet' LIMIT 500`, { maxRows: 500 });
    await q(0);
    const one = ctx.cache.stats().bytes; // measured size of one entry
    ctx.cache.clear();
    ctx.cfg.cache.max_bytes = Math.floor(one * 3.5); // room for three entries; the fourth and fifth evict the oldest
    try {
      for (let i = 0; i < 5; i++) await q(i);
      expect(ctx.cache.stats().bytes).toBeLessThanOrEqual(ctx.cfg.cache.max_bytes);
      expect(ctx.cache.stats().entries).toBe(3);
      expect((await ctx.queries.run(admin, wsId, `SELECT id, v, 0 AS k FROM 'nums.parquet' LIMIT 500`, { maxRows: 500 })).cached).toBe(false);
      expect((await ctx.queries.run(admin, wsId, `SELECT id, v, 4 AS k FROM 'nums.parquet' LIMIT 500`, { maxRows: 500 })).cached).toBe(true);
    } finally {
      Object.assign(ctx.cfg.cache, saved);
      ctx.cache.clear();
    }
  });
});

describe('result cache — HTTP', () => {
  it('overview answers with an ETag, 304 on If-None-Match, 200 after the data changed, and refresh bypasses', async () => {
    const a = await api('POST', `/api/workspaces/${wsId}/overview`, { target: 't' });
    expect(a.status).toBe(200);
    expect(a.etag).toMatch(/^"[0-9a-f]{40}"$/);
    expect(a.json.cached).toBe(false);
    const b = await api('POST', `/api/workspaces/${wsId}/overview`, { target: 't' }, { 'if-none-match': a.etag! });
    expect(b.status).toBe(304);
    expect(b.etag).toBe(a.etag);
    await api('POST', `/api/workspaces/${wsId}/query`, { sql: 'INSERT INTO t VALUES (7)' });
    const c = await api('POST', `/api/workspaces/${wsId}/overview`, { target: 't' }, { 'if-none-match': a.etag! });
    expect(c.status).toBe(200);
    expect(c.etag).not.toBe(a.etag);
    expect(c.json.cached).toBe(false);
    const d = await api('POST', `/api/workspaces/${wsId}/overview`, { target: 't', refresh: true }, { 'if-none-match': c.etag! });
    expect(d.status).toBe(200);
    expect(d.json.cached).toBe(false);
    const e = await api('POST', `/api/workspaces/${wsId}/overview`, { target: 't' });
    expect(e.json.cached).toBe(true);
  });

  it('query, profile, inspect and widget data are conditional too; listing exposes data_version', async () => {
    const q = await api('POST', `/api/workspaces/${wsId}/query`, { sql: 'SELECT id FROM t ORDER BY id' });
    expect(q.etag).toBeTruthy();
    expect((await api('POST', `/api/workspaces/${wsId}/query`, { sql: 'SELECT id FROM t ORDER BY id' }, { 'if-none-match': q.etag! })).status).toBe(304);
    const i = await api('POST', '/api/storage/inspect', { workspace_id: wsId, target: 'nums.parquet' });
    expect(i.etag).toBeTruthy();
    expect((await api('POST', '/api/storage/inspect', { workspace_id: wsId, target: 'nums.parquet' }, { 'if-none-match': i.etag! })).status).toBe(304);
    const d = (await api('POST', `/api/workspaces/${wsId}/dashboards`, { name: 'Cached board' })).json.dashboard as { id: string };
    const w = (await api('POST', `/api/dashboards/${d.id}/widgets`, { title: 'n', widget_type: 'KPI', custom_sql: 'SELECT count(*) AS n FROM t' })).json.widget as { id: string };
    const w1 = await api('POST', `/api/dashboards/${d.id}/widgets/${w.id}/data`, {});
    expect(w1.etag).toBeTruthy();
    expect((await api('POST', `/api/dashboards/${d.id}/widgets/${w.id}/data`, {}, { 'if-none-match': w1.etag! })).status).toBe(304);
    const list = await api('GET', '/api/workspaces');
    const ws = (list.json.workspaces as { id: string; data_version: number }[]).find((x) => x.id === wsId)!;
    expect(ws.data_version).toBeGreaterThan(0);
    const live = await api('GET', '/api/system/live');
    expect((live.json.cache as { entries: number }).entries).toBeGreaterThan(0);
    const cleared = await api('DELETE', `/api/workspaces/${wsId}/cache`);
    expect(cleared.status).toBe(200);
    expect((cleared.json.data_version as number)).toBeGreaterThan(ws.data_version);
  });

  it('epoch events reach members over the live feed (and not non-members)', async () => {
    const bob = await ctx.auth.createLocalUser({ email: 'bob@test.local', password: 'bob-password-1', role: 'USER' });
    const eve = await ctx.auth.createLocalUser({ email: 'eve@test.local', password: 'eve-password-1', role: 'USER' });
    await ctx.workspaces.setMember(admin, wsId, { subject_type: 'user', subject_id: bob.id, role: 'VIEWER' });
    const listen = async (email: string, password: string) => {
      const token = (await api('POST', '/api/auth/login', { email, password }, {}, '')).json.token as string;
      const sock = new WebSocket(`${base.replace('http', 'ws')}/api/ws/events`);
      const events: Record<string, unknown>[] = [];
      await new Promise<void>((resolve) => {
        sock.on('open', () => sock.send(JSON.stringify({ type: 'auth', token })));
        sock.on('message', (raw) => {
          const m = JSON.parse(raw.toString()) as Record<string, unknown>;
          if (m.type === 'ready') resolve();
          else events.push(m);
        });
      });
      return { events, close: () => sock.close() };
    };
    const b = await listen('bob@test.local', 'bob-password-1');
    const e = await listen('eve@test.local', 'eve-password-1');
    const v = await ctx.workspaces.bumpVersion(wsId, 'test', admin.userId);
    await new Promise((r) => setTimeout(r, 300));
    expect(b.events.some((m) => m.type === 'workspace' && m.workspace_id === wsId && m.data_version === v)).toBe(true);
    expect(e.events.some((m) => m.type === 'workspace')).toBe(false);
    b.close();
    e.close();
  });
});
