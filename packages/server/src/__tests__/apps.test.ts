/**
 * Data apps: the registry, the subprocess runner (a fake `streamlit` that honours the same flags), the cookie
 * session, the HTTP proxy and WebSocket bridge, the app's read-only workspace-scoped token, auto-start on visit,
 * restart on edit, idle reaping, visibility, and the Python SDK against the running server.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
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
let userJwt: string;
let wsId: string;
let otherWsId: string;
const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(here, 'fixtures', 'fake-streamlit.mjs');

const api = async (method: string, url: string, body?: unknown, token = jwt) => {
  const res = await fetch(base + url, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as Record<string, unknown>, headers: res.headers };
};
const sessionCookie = async (id: string, token = jwt) => {
  const r = await api('POST', `/api/apps/${id}/session`, {}, token);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  const c = r.headers.get('set-cookie')!;
  expect(c).toMatch(/^dv_app=.*; Path=\/apps; HttpOnly; SameSite=Lax; Max-Age=43200$/);
  return c.split(';')[0]!;
};
const visit = (id: string, cookie: string | null, pathname = '/') => fetch(`${base}/apps/${id}${pathname}`, { headers: cookie ? { cookie } : {}, redirect: 'manual' });
const info = async (res: Response) => {
  const text = await res.text();
  const m = /<script id="info" type="application\/json">(.*?)<\/script>/.exec(text);
  if (!m) throw new Error(`not the app page (${res.status}): ${text.slice(0, 300)}`);
  return JSON.parse(m[1]!) as Record<string, unknown>;
};
const waitRunning = async (id: string, ms = 20_000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const r = await api('GET', `/api/apps/${id}`);
    const a = r.json.app as { status: string; last_error: string | null };
    if (a.status === 'running') return a;
    if (a.status === 'error') throw new Error(`app errored: ${a.last_error}`);
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('app did not start');
};

beforeAll(async () => {
  initLogger({ level: 'silent', stderr: true, pretty: false });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dv-apps-'));
  const cfg = loadConfig({
    configPath: null,
    env: { DUCKVIEW_DATA_DIR: path.join(dir, 'data'), DUCKVIEW_FILESYSTEM_MODE: 'full', DUCKDB_TEMP_DIRECTORY: path.join(dir, 'spill'), DATABASE_URL: ':memory:', DUCKDB_MEMORY_LIMIT: '512MB', DUCKVIEW_ADMIN_EMAIL: 'admin@test.local', DUCKVIEW_ADMIN_PASSWORD: 'super-secret-pw', DUCKVIEW__duckdb__sync_scheduler_enabled: 'false', DUCKVIEW__apps__port_range: JSON.stringify([18601, 18620]), DUCKVIEW__apps__idle_stop_minutes: '1', DUCKVIEW__apps__start_timeout_seconds: '20', LOG_LEVEL: 'silent' },
  });
  ctx = await createContext(cfg);
  ctx.apps.command = [process.execPath, FAKE];
  admin = ctx.auth.principalFromUser((await ctx.auth.findByEmail('admin@test.local'))!, 'jwt', '127.0.0.1');
  await ctx.auth.createLocalUser({ email: 'user@test.local', password: 'user-secret-pw', role: 'USER' });
  wsId = (await ctx.workspaces.create(admin, { name: 'Apps', active_db_path: 'apps.duckdb' })).id;
  otherWsId = (await ctx.workspaces.create(admin, { name: 'Private', active_db_path: 'private.duckdb' })).id;
  await ctx.queries.run(admin, wsId, "CREATE TABLE sdk_demo AS SELECT range AS n, 'r' || range AS label FROM range(5)", { cache: false, countTotal: false });
  ({ app } = await buildApp(ctx));
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  jwt = (await api('POST', '/api/auth/login', { email: 'admin@test.local', password: 'super-secret-pw' }, '')).json.token as string;
  userJwt = (await api('POST', '/api/auth/login', { email: 'user@test.local', password: 'user-secret-pw' }, '')).json.token as string;
});

afterAll(async () => {
  await app.close();
  await ctx.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('registry', () => {
  it('offers templates, creates from one, validates sources, keeps apps to workspace members', async () => {
    const t = await api('GET', '/api/apps/templates');
    expect((t.json.templates as { id: string }[]).map((x) => x.id)).toEqual(['explorer', 'blank']);
    expect(t.json.enabled).toBe(true);
    const r = await api('POST', `/api/workspaces/${wsId}/apps`, { name: 'Explorer', description: 'first app' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const a = r.json.app as { id: string; status: string; url: string; files: Record<string, string>; entry: string; visibility: string; source_bytes: number };
    expect(a).toMatchObject({ status: 'stopped', url: `/apps/${a.id}/`, entry: 'app.py', visibility: 'workspace' });
    expect(a.files['app.py']).toContain('from duckview.streamlit import');
    expect(a.source_bytes).toBeGreaterThan(100);
    expect((await api('GET', `/api/workspaces/${wsId}/apps`)).json.apps).toHaveLength(1);
    // Validation: file names, entry, secrets, size.
    expect((await api('POST', `/api/workspaces/${wsId}/apps`, { name: 'bad', files: { '../x.py': 'x' }, entry: '../x.py' })).status).toBe(400);
    expect((await api('POST', `/api/workspaces/${wsId}/apps`, { name: 'bad', files: { 'main.py': 'x' } })).json.message).toMatch(/entry file "app.py" is missing/);
    expect((await api('POST', `/api/workspaces/${wsId}/apps`, { name: 'bad', files: { 'app.py': 'TOKEN = "dv_abcdefghijklmnopqrstuvwxyz0123"' } })).json.message).toMatch(/API token/);
    expect((await api('POST', `/api/workspaces/${wsId}/apps`, { name: 'bad', files: { 'app.py': 'x'.repeat(600_000) } })).json.message).toMatch(/limit/);
    // Other users: not a member → 404, and the workspace list is theirs alone.
    expect((await api('GET', `/api/apps/${a.id}`, undefined, userJwt)).status).toBe(404);
    expect((await api('GET', `/api/workspaces/${wsId}/apps`, undefined, userJwt)).status).toBe(404);
    expect((await api('GET', '/api/apps', undefined, userJwt)).json.apps).toEqual([]);
    expect((await api('GET', '/api/apps')).json.apps).toHaveLength(1);
  });
});

describe('runner and proxy', () => {
  let id: string;
  it('starts the app with a minimal environment and a read-only, workspace-scoped token', async () => {
    id = ((await api('GET', `/api/workspaces/${wsId}/apps`)).json.apps as { id: string }[])[0]!.id;
    process.env.OTHER_WORKSPACE = otherWsId; // the fake reads it to probe another workspace (inherited through PATH-only env? no — passed below)
    const before = (await ctx.auth.listTokens(admin.userId)).length;
    const r = await api('POST', `/api/apps/${id}/start`, {});
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect((r.json.app as { status: string }).status).toBe('running');
    expect((r.json.logs as string[]).some((l) => l.includes('fake streamlit on'))).toBe(true);
    const tokens = await ctx.auth.listTokens(admin.userId);
    expect(tokens.length).toBe(before + 1);
    const minted = tokens.find((t) => t.name === 'app:Explorer')!;
    expect(minted.scopes).toEqual(['read']);
    expect(minted.workspace_id).toBe(wsId);
    expect(minted.expires_at).not.toBeNull();
  });

  it('proxies HTTP only with the session cookie, forwards the visitor, passes bodies through', async () => {
    expect((await visit(id, null)).status).toBe(401);
    expect((await visit(id, 'dv_app=garbage')).status).toBe(401);
    const cookie = await sessionCookie(id);
    const redirect = await fetch(`${base}/apps/${id}`, { headers: { cookie }, redirect: 'manual' });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get('location')).toBe(`/apps/${id}/`);
    const res = await visit(id, cookie);
    expect(res.status).toBe(200);
    const i = await info(res);
    expect(i.url).toBe(base);
    expect(i.workspace).toBe(wsId);
    expect(i.hasToken).toBe(true);
    expect(i.tokenPrefix).toBe('dv_');
    expect(i.secretLeak).toEqual([]);
    expect(i.viewer).toBe('admin@test.local');
    expect(i.role).toBe('OWNER');
    expect(i.queryStatus).toBe(200);
    expect(i.queryRows).toBe(1);
    expect(i.mutateStatus).toBe(403); // read scope
    expect(i.source).toContain('import streamlit');
    const echo = await fetch(`${base}/apps/${id}/echo`, { method: 'POST', headers: { cookie, 'content-type': 'application/octet-stream' }, body: Buffer.from([1, 2, 3, 0, 255]) });
    expect(echo.headers.get('x-echo-length')).toBe('5');
    expect(Buffer.from(await echo.arrayBuffer())).toEqual(Buffer.from([1, 2, 3, 0, 255]));
    expect((await visit(id, cookie, '/nope')).status).toBe(404);
    // The cookie is bound to the user: a non-member's cookie gets a 404 page, never the app.
    const other = await sessionCookie(id, userJwt).catch(() => null);
    expect(other).toBeNull();
  });

  it('bridges the WebSocket with the subprotocol and the visitor header', async () => {
    const cookie = await sessionCookie(id);
    const ws = new WebSocket(`${base.replace('http', 'ws')}/apps/${id}/_stcore/stream`, ['streamlit', 'session-token-x'], { headers: { cookie } });
    const messages: string[] = [];
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => ws.send('ping'));
      ws.on('message', (d) => { messages.push(String(d)); if (messages.length === 2) resolve(); });
      ws.on('error', reject);
      setTimeout(() => reject(new Error('ws timeout')), 5000);
    });
    expect(ws.protocol).toBe('streamlit');
    expect(JSON.parse(messages[0]!)).toMatchObject({ hello: true, protocol: 'streamlit', user: admin.userId, protocols: 'streamlit,session-token-x' });
    expect(messages[1]).toBe('echo:ping');
    ws.close();
    // Without a cookie the socket is refused.
    const bad = new WebSocket(`${base.replace('http', 'ws')}/apps/${id}/_stcore/stream`);
    const code = await new Promise<number>((resolve) => { bad.on('close', (c) => resolve(c)); bad.on('error', () => resolve(-1)); });
    expect(code).toBe(1008);
  });

  it('restarts when the code changes, auto-starts on a visit, reaps idle apps and revokes their tokens', async () => {
    const cookie = await sessionCookie(id);
    const upd = await api('PATCH', `/api/apps/${id}`, { files: { 'app.py': 'import streamlit as st\n# v2\n', 'requirements.txt': '' } });
    expect(upd.status, JSON.stringify(upd.json)).toBe(200);
    await waitRunning(id);
    expect((await info(await visit(id, cookie))).source).toContain('# v2');
    // Stop, then visit: the proxy starts it and shows a waiting page until it is up.
    expect((await api('POST', `/api/apps/${id}/stop`, {})).json).toEqual({ ok: true });
    expect((await api('GET', `/api/apps/${id}`)).json.app).toMatchObject({ status: 'stopped', running: false });
    const waiting = await visit(id, cookie);
    expect(waiting.status).toBe(503);
    expect(await waiting.text()).toMatch(/Starting Explorer/);
    await waitRunning(id);
    expect((await visit(id, cookie)).status).toBe(200);
    // Idle: nothing used it for longer than apps.idle_stop_minutes.
    const stopped = await ctx.apps.reapIdle(Date.now() + 2 * 60_000);
    expect(stopped).toEqual([id]);
    expect((await api('GET', `/api/apps/${id}`)).json.app).toMatchObject({ status: 'stopped' });
    expect((await ctx.auth.listTokens(admin.userId)).filter((t) => t.name === 'app:Explorer')).toEqual([]);
    expect((await api('GET', `/api/apps/${id}/logs`)).json.logs as string[]).toEqual(expect.arrayContaining([expect.stringContaining('stopping (idle)')]));
  });

  it('reports a crash with the log, refuses when disabled, honours org visibility', async () => {
    const crash = (await api('POST', `/api/workspaces/${wsId}/apps`, { name: 'Crasher', files: { 'app.py': '# CRASH_ON_START\n' } })).json.app as { id: string };
    const r = await api('POST', `/api/apps/${crash.id}/start`, {});
    expect(r.status).toBe(400);
    expect(String(r.json.message)).toMatch(/exited before it was ready/);
    expect((await api('GET', `/api/apps/${crash.id}`)).json.app).toMatchObject({ status: 'error' });
    expect((await api('GET', `/api/apps/${crash.id}/logs`)).json.logs as string[]).toEqual(expect.arrayContaining([expect.stringContaining('Traceback: boom')]));
    // A non-member sees an org-visible app (read only) but cannot edit it.
    expect((await api('GET', `/api/apps/${id}`, undefined, userJwt)).status).toBe(404);
    await api('PATCH', `/api/apps/${id}`, { visibility: 'org' });
    expect((await api('GET', `/api/apps/${id}`, undefined, userJwt)).status).toBe(200);
    expect((await api('GET', '/api/apps', undefined, userJwt)).json.apps).toHaveLength(1);
    expect((await api('PATCH', `/api/apps/${id}`, { name: 'hijack' }, userJwt)).status).toBe(404);
    const c = await sessionCookie(id, userJwt);
    const res = await visit(id, c);
    expect([200, 503]).toContain(res.status);
    await waitRunning(id);
    expect((await info(await visit(id, c))).viewer).toBe('user@test.local');
    await api('PATCH', `/api/apps/${id}`, { visibility: 'workspace' });
    // Disabled: nothing starts and the proxy says so.
    ctx.cfg.apps.enabled = false;
    expect((await api('POST', `/api/apps/${crash.id}/start`, {})).status).toBe(403);
    expect((await visit(id, await sessionCookie(id))).status).toBe(503);
    ctx.cfg.apps.enabled = true;
    await api('DELETE', `/api/apps/${crash.id}`);
    expect((await api('GET', `/api/workspaces/${wsId}/apps`)).json.apps).toHaveLength(1);
  });

  it('stops every app at shutdown-style stop and cleans the run directory on delete', async () => {
    const runDir = path.join(dir, 'data', '.duckview', 'apps', 'run', id);
    expect(fs.existsSync(path.join(runDir, 'app.py'))).toBe(true);
    await api('DELETE', `/api/apps/${id}`);
    expect(fs.existsSync(runDir)).toBe(false);
    expect(ctx.apps.runningCount()).toBe(0);
  });
});

describe('python sdk', () => {
  it('queries, browses the catalog, builds SQL and respects the read-only token (pandas/pyarrow when installed)', async () => {
    const py = spawnSync('python3', ['--version']);
    if (py.status !== 0) return; // no python on this machine
    const user = (await ctx.auth.findByEmail('admin@test.local'))!;
    const minted = await ctx.auth.createToken(user, { name: 'sdk', scopes: ['read'], workspaceId: wsId });
    // Async: the server answering the SDK lives in this very process.
    const r = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
      const c = spawn('python3', [path.resolve(here, '../../../sdk-python/tests/test_sdk.py')], { env: { PATH: process.env.PATH, HOME: process.env.HOME, DUCKVIEW_URL: base, DUCKVIEW_TOKEN: minted.token, DUCKVIEW_WORKSPACE: wsId } });
      let stdout = '';
      let stderr = '';
      c.stdout.on('data', (d) => (stdout += d));
      c.stderr.on('data', (d) => (stderr += d));
      c.on('exit', (status) => resolve({ status, stdout, stderr }));
    });
    expect(r.status, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout.trim().split('\n').pop()!) as Record<string, unknown>;
    expect(out.me).toBe('admin@test.local');
    expect(out.records).toEqual([{ a: 1, b: 'x', d: '2026-01-02' }]);
    expect(out.kinds).toEqual(['number']);
    expect(out.count).toBe(5);
    expect(out.tables).toContain('sdk_demo');
    expect(out.builder_sql).toBe('SELECT * FROM sdk_demo WHERE (n >= 2) ORDER BY n DESC LIMIT 2');
    expect(out.builder).toEqual([{ n: 4, label: 'r4' }, { n: 3, label: 'r3' }]);
    expect(out.builder_count).toBe(2);
    expect(out.mutation).toBe('FORBIDDEN');
    if (out.pandas) expect(out.pandas).toMatchObject({ a: 1, dtype_ts: expect.stringContaining('datetime64') });
    if (out.arrow) expect(out.arrow).toEqual({ rows: 3, cols: ['n'] });
  });
});
