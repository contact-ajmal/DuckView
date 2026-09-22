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
import { buildTools, runTool, type ToolEnv } from '../agent/tools.js';
import { parseSpecText } from '../services/mosaic-spec.js';
import { appFromDashboard, appFromQueries, analyzeSpec } from '../services/app-generator.js';
import { findChrome } from '../services/apps.js';
import type { Principal } from '../services/principal.js';

let dir: string;
let ctx: AppContext;
let app: Awaited<ReturnType<typeof buildApp>>['app'];
let base: string;
/** The apps listener: apps are served from their own origin (apps.isolation, the default). */
let appsServer: Awaited<ReturnType<typeof buildApp>>['appsServer'];
let appsBase: string;
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
/** The browser's way in: a one-time handoff link from the UI, opened on the apps origin, which sets the cookie. */
const sessionCookie = async (id: string, token = jwt) => {
  const r = await api('POST', `/api/apps/${id}/session`, {}, token);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  const handoff = await fetch(String(r.json.url), { redirect: 'manual' });
  expect(handoff.status).toBe(302);
  expect(handoff.headers.get('location')).toBe(`/apps/${id}/`);
  const c = handoff.headers.get('set-cookie')!;
  expect(c).toMatch(/^dv_app=.*; Path=\/apps; HttpOnly; SameSite=Lax; Max-Age=43200$/);
  return c.split(';')[0]!;
};
/** A page load, as a browser sends it (only navigations wake a stopped app). */
const visit = (id: string, cookie: string | null, pathname = '/') => fetch(`${appsBase}/apps/${id}${pathname}`, { headers: { accept: 'text/html,application/xhtml+xml', ...(cookie ? { cookie } : {}) }, redirect: 'manual' });
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
  ({ app, appsServer } = await buildApp(ctx));
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  ctx.cfg.server.port = (app.server.address() as { port: number }).port; // what the apps origin links back to
  await appsServer!.listen({ port: 0, host: '127.0.0.1' });
  ctx.cfg.apps.port = (appsServer!.server.address() as { port: number }).port;
  appsBase = `http://127.0.0.1:${ctx.cfg.apps.port}`;
  jwt = (await api('POST', '/api/auth/login', { email: 'admin@test.local', password: 'super-secret-pw' }, '')).json.token as string;
  userJwt = (await api('POST', '/api/auth/login', { email: 'user@test.local', password: 'user-secret-pw' }, '')).json.token as string;
});

afterAll(async () => {
  await app.close();
  await appsServer?.close();
  await ctx.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('registry', () => {
  it('offers templates, creates from one, validates sources, keeps apps to workspace members', async () => {
    const t = await api('GET', '/api/apps/templates');
    expect((t.json.templates as { id: string }[]).map((x) => x.id)).toEqual(['explorer', 'blank', 'dash-explorer', 'gradio-query']);
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
    // No cookie: a page load goes to the UI to launch the app there; anything else is refused.
    for (const c of [null, 'dv_app=garbage']) {
      const r = await visit(id, c);
      expect(r.status).toBe(302);
      expect(r.headers.get('location')).toMatch(new RegExp(`/#/apps/${id}\\?launch=1$`));
    }
    expect((await fetch(`${appsBase}/apps/${id}/_stcore/health`)).status).toBe(401);
    const cookie = await sessionCookie(id);
    const redirect = await fetch(`${appsBase}/apps/${id}`, { headers: { cookie }, redirect: 'manual' });
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
    const echo = await fetch(`${appsBase}/apps/${id}/echo`, { method: 'POST', headers: { cookie, 'content-type': 'application/octet-stream' }, body: Buffer.from([1, 2, 3, 0, 255]) });
    expect(echo.headers.get('x-echo-length')).toBe('5');
    expect(Buffer.from(await echo.arrayBuffer())).toEqual(Buffer.from([1, 2, 3, 0, 255]));
    expect((await visit(id, cookie, '/nope')).status).toBe(404);
    // The cookie is bound to the user: a non-member's cookie gets a 404 page, never the app.
    const other = await sessionCookie(id, userJwt).catch(() => null);
    expect(other).toBeNull();
  });

  it('keeps apps on their own origin: single-use handoff, old links redirected, purpose JWTs are no credentials', async () => {
    const s = await api('POST', `/api/apps/${id}/session`, {});
    expect(s.headers.get('set-cookie')).toBeNull(); // nothing is set on the UI's origin
    const url = String(s.json.url);
    expect(url.startsWith(`${appsBase}/_duckview/session?app=${id}&t=`)).toBe(true);
    expect(s.json.app_url).toBe(`${appsBase}/apps/${id}/`);
    const first = await fetch(url, { redirect: 'manual' });
    expect(first.headers.get('location')).toBe(`/apps/${id}/`);
    const cookie = first.headers.get('set-cookie')!.split(';')[0]!;
    // Replayed without the cookie: back to the UI; with it (an iframe reloading): straight to the app.
    expect((await fetch(url, { redirect: 'manual' })).headers.get('location')).toMatch(new RegExp(`/#/apps/${id}\\?launch=1$`));
    expect((await fetch(url, { redirect: 'manual', headers: { cookie } })).headers.get('location')).toBe(`/apps/${id}/`);
    // A handoff for one app does not open another.
    const t = new URL(String((await api('POST', `/api/apps/${id}/session`, {})).json.url)).searchParams.get('t')!;
    expect((await fetch(`${appsBase}/_duckview/session?app=00000000-0000-0000-0000-000000000000&t=${encodeURIComponent(t)}`, { redirect: 'manual' })).headers.get('set-cookie')).toBeNull();
    // The UI's origin no longer serves apps: pages move to the apps origin, anything else is a 404.
    const old = await fetch(`${base}/apps/${id}/`, { headers: { accept: 'text/html' }, redirect: 'manual' });
    expect(old.status).toBe(302);
    expect(old.headers.get('location')).toBe(`${appsBase}/apps/${id}/`);
    expect((await fetch(`${base}/apps/${id}/_stcore/health`, { headers: { cookie } })).status).toBe(404);
    // The apps origin serves the proxy and nothing else.
    expect((await fetch(`${appsBase}/api/workspaces`, { headers: { authorization: `Bearer ${jwt}` } })).status).toBe(404);
    expect((await fetch(`${appsBase}/`)).status).toBe(404);
    // Only sign-in sessions and API tokens are credentials: the app cookie and the handoff JWT are not.
    expect((await api('GET', '/api/workspaces', undefined, decodeURIComponent(cookie.slice('dv_app='.length)))).status).toBe(401);
    expect((await api('GET', '/api/workspaces', undefined, new URL(url).searchParams.get('t')!)).status).toBe(401);
    // The in-browser app credential (purpose app-browser) reads one workspace and nothing more.
    const ab = app.jwt.sign({ purpose: 'app-browser', sub: admin.userId, ws: wsId }, { expiresIn: '5m' });
    expect((await api('POST', `/api/workspaces/${wsId}/query`, { sql: 'SELECT 1 AS one' }, ab)).status).toBe(200);
    expect((await api('POST', `/api/workspaces/${wsId}/query`, { sql: 'CREATE TABLE ab_should_not AS SELECT 1' }, ab)).status).toBe(403);
    expect((await api('POST', `/api/workspaces/${otherWsId}/query`, { sql: 'SELECT 1' }, ab)).status).toBe(403);
    expect((await api('GET', '/api/admin/users', undefined, ab)).status).toBe(403);
    expect((await api('GET', '/api/workspaces', undefined, app.jwt.sign({ purpose: 'app-browser', sub: admin.userId }, { expiresIn: '5m' }))).status).toBe(401);
  });

  it('bridges the WebSocket with the subprotocol and the visitor header', async () => {
    const cookie = await sessionCookie(id);
    const ws = new WebSocket(`${appsBase.replace('http', 'ws')}/apps/${id}/_stcore/stream`, ['streamlit', 'session-token-x'], { headers: { cookie } });
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
    const bad = new WebSocket(`${appsBase.replace('http', 'ws')}/apps/${id}/_stcore/stream`);
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
    // A tab left open keeps polling in the background: that must not undo the stop.
    const poll = await fetch(`${appsBase}/apps/${id}/_stcore/health`, { headers: { cookie, 'sec-fetch-mode': 'cors' } });
    expect(poll.status).toBe(503);
    expect((await fetch(`${appsBase}/apps/${id}/_stcore/host-config`, { headers: { cookie } })).status).toBe(503);
    await new Promise((r) => setTimeout(r, 300));
    expect((await api('GET', `/api/apps/${id}`)).json.app).toMatchObject({ status: 'stopped' });
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

describe('in-browser apps (stlite)', () => {
  it('serves a stlite page with the SDK and the viewer\'s own read-only credential; nothing runs on the server', async () => {
    const running = ctx.apps.runningCount();
    const code = 'import streamlit as st\nfrom duckview.streamlit import query\nst.write("</script><b>x</b>")\n';
    const created = await api('POST', `/api/workspaces/${wsId}/apps`, { name: 'In the browser', execution: 'browser', files: { 'app.py': code, 'requirements.txt': '# plotting\nplotly>=5\n\n-r other.txt\n' } });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    const a = created.json.app as { id: string; execution: string; status: string; running: boolean };
    expect(a).toMatchObject({ execution: 'browser', status: 'running', running: true });
    // Starting is a no-op: no process, no token.
    expect((await api('POST', `/api/apps/${a.id}/start`, {})).json.app).toMatchObject({ execution: 'browser' });
    expect(ctx.apps.runningCount()).toBe(running);
    expect((await api('POST', `/api/apps/${a.id}/always-on`, { on: true })).status).toBe(400);
    // The page.
    const cookie = await sessionCookie(a.id);
    const res = await visit(a.id, cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const html = await res.text();
    expect(html).toContain('https://cdn.jsdelivr.net/npm/@stlite/browser@1.9.1/build/stlite.js');
    expect(html).not.toContain('</script><b>'); // app code cannot break out of the embedding
    const opts = JSON.parse(/<script id="dv-app" type="application\/json">(.*?)<\/script>/s.exec(html)![1]!) as { entrypoint: string; files: Record<string, string>; requirements: string[]; env: Record<string, string> };
    expect(opts.entrypoint).toBe('app.py');
    expect(opts.files['app.py']).toBe(code);
    expect(opts.files['duckview/__init__.py']).toContain('_request_browser');
    expect(opts.files['duckview/streamlit.py']).toContain('def viewer');
    expect(opts.files).not.toHaveProperty('requirements.txt');
    expect(opts.requirements).toEqual(['plotly>=5']);
    expect(opts.env).toMatchObject({ DUCKVIEW_URL: base, DUCKVIEW_WORKSPACE: wsId, DUCKVIEW_APP_ID: a.id, DUCKVIEW_VIEWER_EMAIL: 'admin@test.local', DUCKVIEW_VIEWER_ROLE: 'OWNER' });
    // The credential is the viewer's: read the app's workspace, nothing else.
    const tok = opts.env.DUCKVIEW_TOKEN!;
    expect((await api('POST', `/api/workspaces/${wsId}/query`, { sql: 'SELECT 1 AS one' }, tok)).status).toBe(200);
    expect((await api('POST', `/api/workspaces/${wsId}/query`, { sql: 'CREATE TABLE from_browser AS SELECT 1' }, tok)).status).toBe(403);
    expect((await api('POST', `/api/workspaces/${otherWsId}/query`, { sql: 'SELECT 1' }, tok)).status).toBe(403);
    // The API answers the apps origin's preflight (the page calls it cross-origin).
    const pre = await fetch(`${base}/api/workspaces/${wsId}/query`, { method: 'OPTIONS', headers: { origin: appsBase, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe(appsBase);
    // Nothing else lives under an in-browser app.
    expect((await visit(a.id, cookie, '/_stcore/health')).status).toBe(404);
    // Published to everyone, it still reads as the viewer: a non-member is told why instead of getting a broken app.
    await api('POST', `/api/apps/${a.id}/publish`, { audience: 'org' });
    const outsider = await visit(a.id, await sessionCookie(a.id, userJwt));
    expect(outsider.status).toBe(403);
    expect(await outsider.text()).toMatch(/runs in your browser, with your own access/);
    // Switching a running server app to the browser stops its process.
    const srv = (await api('POST', `/api/workspaces/${wsId}/apps`, { name: 'Moves to the browser', files: { 'app.py': 'import streamlit as st\n' } })).json.app as { id: string };
    await api('POST', `/api/apps/${srv.id}/start`, {});
    expect(ctx.apps.target(srv.id)).not.toBeNull();
    expect((await api('PATCH', `/api/apps/${srv.id}`, { execution: 'browser' })).json.app).toMatchObject({ execution: 'browser', status: 'running' });
    expect(ctx.apps.target(srv.id)).toBeNull();
    // Off switch.
    ctx.cfg.apps.stlite.enabled = false;
    expect((await api('POST', `/api/workspaces/${wsId}/apps`, { name: 'nope', execution: 'browser' })).status).toBe(400);
    expect((await visit(a.id, cookie)).status).toBe(503);
    ctx.cfg.apps.stlite.enabled = true;
    for (const x of [a.id, srv.id]) await api('DELETE', `/api/apps/${x}`);
  });
});

describe('dash and gradio', () => {
  it('runs Dash and Gradio apps behind the same proxy: templates, per-framework checks, launch settings, prefix handling', async () => {
    const templates = (await api('GET', '/api/apps/templates')).json.templates as { id: string; kind: string }[];
    expect(templates.map((t) => `${t.id}:${t.kind}`)).toEqual(['explorer:streamlit', 'blank:streamlit', 'dash-explorer:dash', 'gradio-query:gradio']);
    // Checks per framework.
    const check = async (kind: string, code: string) => (await api('POST', '/api/apps/validate', { files: { 'app.py': code }, kind })).json as { ok: boolean; errors: string[]; warnings: string[] };
    expect((await check('dash', 'import dash\napp = dash.Dash()\n')).errors).toEqual([expect.stringMatching(/must call app.run\(\)/)]);
    expect((await check('dash', 'import streamlit as st\n')).errors).toEqual(expect.arrayContaining([expect.stringMatching(/app.py does not import dash/)]));
    expect((await check('dash', 'import dash\napp = dash.Dash()\napp.run(port=8050)\n')).warnings).toEqual([expect.stringMatching(/leave them out/)]);
    expect((await check('gradio', 'import gradio as gr\n')).errors).toEqual([expect.stringMatching(/must call demo.launch\(\)/)]);
    expect((await check('gradio', 'import gradio as gr\ndemo = gr.Blocks()\ndemo.launch(share=True)\n')).warnings).toEqual([expect.stringMatching(/never share=True/)]);
    for (const t of templates) {
      const g = (await api('POST', `/api/workspaces/${wsId}/apps/generate`, { source: { template: t.id } })).json as { kind: string; validation: { ok: boolean; errors: string[] } };
      expect(g.kind).toBe(t.kind);
      expect(g.validation, t.id).toMatchObject({ ok: true });
    }
    // Dash: served under the base path, told where through the environment.
    const dash = (await api('POST', `/api/workspaces/${wsId}/apps`, { name: 'Dash app', kind: 'dash', files: { 'app.py': 'import dash\napp = dash.Dash()\nif __name__ == "__main__":\n    app.run()\n' } })).json.app as { id: string; kind: string };
    expect(dash.kind).toBe('dash');
    expect((await api('POST', `/api/apps/${dash.id}/start`, {})).json.app).toMatchObject({ status: 'running', kind: 'dash' });
    const di = await info(await visit(dash.id, await sessionCookie(dash.id)));
    expect(di).toMatchObject({ framework: 'dash', path: `/apps/${dash.id}/`, viewer: 'admin@test.local', queryStatus: 200, mutateStatus: 403 });
    // Gradio: serves at the root — the proxy strips /apps/<id>, and GRADIO_ROOT_PATH + X-Forwarded-Host make its links right.
    const gr = (await api('POST', `/api/workspaces/${wsId}/apps`, { name: 'Gradio app', source: { template: 'gradio-query' } })).json.app as { id: string; kind: string };
    expect(gr.kind).toBe('gradio');
    expect((await api('POST', `/api/apps/${gr.id}/start`, {})).json.app).toMatchObject({ status: 'running' });
    const gc = await sessionCookie(gr.id);
    const gi = await info(await visit(gr.id, gc));
    expect(gi).toMatchObject({ framework: 'gradio', path: '/', rootPath: `/apps/${gr.id}`, forwardedHost: new URL(appsBase).host, viewer: 'admin@test.local' });
    const echo = await fetch(`${appsBase}/apps/${gr.id}/echo`, { method: 'POST', headers: { cookie: gc, 'content-type': 'text/plain' }, body: 'hello' });
    expect(await echo.text()).toBe('hello');
    // Only Streamlit runs in the browser.
    expect((await api('PATCH', `/api/apps/${gr.id}`, { execution: 'browser' })).status).toBe(400);
    expect((await api('POST', `/api/workspaces/${wsId}/apps`, { name: 'x', kind: 'dash', execution: 'browser', files: { 'app.py': 'import dash\n' } })).status).toBe(400);
    // Agents pick the framework through the template or the code's kind.
    const tools = buildTools(ctx.cfg);
    const env: ToolEnv = { ctx, principal: admin, via: 'rest', defaultWorkspaceId: wsId, agent: null };
    const made = await runTool(env, tools.find((t) => t.name === 'create_app')!, { name: 'Agent dash', source: { code: 'import dash\napp = dash.Dash()\napp.run()\n', kind: 'dash' }, run_now: false });
    expect(made.isError, JSON.stringify(made.content)).toBeFalsy();
    expect((await api('GET', `/api/apps/${(made.structuredContent as { app_id: string }).app_id}`)).json.app).toMatchObject({ kind: 'dash' });
    const refused = await runTool(env, tools.find((t) => t.name === 'create_app')!, { name: 'Bad gradio', source: { code: 'import gradio as gr\n', kind: 'gradio' } });
    expect(refused.isError).toBe(true);
    for (const x of [dash.id, gr.id, (made.structuredContent as { app_id: string }).app_id]) await api('DELETE', `/api/apps/${x}`);
  });
});

describe('generator', () => {
  const TAXI = fs.readFileSync(path.resolve(here, '../../../../examples/mosaic/nyc-yellow-taxi.yaml'), 'utf8');
  it('turns a Mosaic dashboard spec into a Streamlit app: datasets, filters, KPIs, charts, tables', async () => {
    const spec = parseSpecText(TAXI);
    const a = analyzeSpec(spec);
    expect(a.sources.map((s) => s.name)).toEqual(['trips']);
    expect(a.filters.map((f) => `${f.kind}:${f.column}`)).toEqual(['menu:vendor', 'menu:payment', 'menu:rate', 'menu:passengers', 'slider:fare', 'slider:distance']);
    const g = appFromDashboard(spec);
    expect(g.summary).toBe('1 dataset, 6 filters, 6 KPIs, 17 charts, 1 table');
    const code = g.files['app.py']!;
    expect(code).toContain('from duckview.streamlit import connect, query, viewer');
    expect(code).toContain('st.set_page_config(page_title="NYC yellow taxi · January 2026"');
    expect(code).toContain(`kpi[0].metric("trips", fmt(scalar(f"SELECT count(*) FROM {rel('trips')}{where('trips')}")))`);
    expect(code).toContain(`st.selectbox("Vendor", ["All"] + q(f"SELECT DISTINCT vendor AS v FROM {rel('trips')} ORDER BY 1 LIMIT 500")`);
    expect(code).toContain('lo4, hi4 = st.slider("Max fare $", 0, 150, (0, 150), step=5');
    expect(code).toContain(`df = q(f"SELECT hour_ts AS x, count(*) AS y FROM {rel('trips')}{where('trips')} GROUP BY 1 ORDER BY 1 LIMIT 5000")`);
    expect(code).toContain('mark_area(opacity=0.6)');
    expect(code).toContain('st.subheader("trips / hour by pickup hour, January 2026")');
    expect(code).toContain(`{bins(rel('trips'), 'fare', where('trips'))} AS x`);
    expect(code).toContain('mark_rect()'); // the hour × weekday cell chart
    expect(code).toMatch(/st\.dataframe\(q\(f"SELECT .* FROM \{rel\('trips'\)\}\{where\('trips'\)\} LIMIT 1000"\)/);
    // It compiles on whatever Python the machine has (no f-string nesting tricks).
    const check = await ctx.apps.validateSource(g.files);
    expect(check.errors, check.errors.join('; ')).toEqual([]);
  });

  it('builds a query browser from SQL, and validation catches broken code, missing imports and tokens', async () => {
    const g = appFromQueries([{ name: 'Top zones', sql: 'SELECT zone, count(*) AS n FROM trips GROUP BY 1 ORDER BY 2 DESC;' }], { name: 'Zones' });
    expect(g.files['app.py']).toContain('"Top zones": "SELECT zone, count(*) AS n FROM trips GROUP BY 1 ORDER BY 2 DESC"');
    expect((await ctx.apps.validateSource(g.files)).ok).toBe(true);
    const bad = await ctx.apps.validateSource({ 'app.py': 'import streamlit as st\nif True\n  pass\n' });
    expect(bad.ok).toBe(false);
    expect(bad.errors.join(' ')).toMatch(/does not compile|SyntaxError/);
    expect((await ctx.apps.validateSource({ 'app.py': 'print(1)\n' })).errors).toEqual(['app.py does not import streamlit']);
    expect((await ctx.apps.validateSource({ 'app.py': 'import streamlit\nKEY = "sk-abcdefghijklmnopqrstuvwxyz"\n' })).errors[0]).toMatch(/API token/);
    expect((await ctx.apps.validateSource({ 'app.py': 'import streamlit as st\nst.dataframe(df, use_container_width=True)\n' })).warnings[0]).toMatch(/width="stretch"/);
  });
});

describe('agent tools', () => {
  it('create_app from a dashboard, from code (validated), update, preview, logs, publish with approval, stop', async () => {
    const env: ToolEnv = { ctx, principal: admin, via: 'rest', defaultWorkspaceId: wsId, agent: null };
    const tools = buildTools(ctx.cfg);
    const t = (n: string) => tools.find((x) => x.name === n)!;
    expect(tools.map((x) => x.name)).toEqual(expect.arrayContaining(['list_apps', 'create_app', 'update_app', 'run_app', 'stop_app', 'get_app_logs', 'preview_app', 'publish_app']));
    // A Mosaic dashboard to build from.
    const spec = parseSpecText('meta: { title: Demo }\ndata:\n  d: { query: "SELECT n, label, n * 2 AS value FROM sdk_demo" }\nvconcat:\n  - { input: menu, label: Label, from: d, column: label }\n  - hconcat:\n      - plot: [{ mark: text, data: { from: d }, text: { count: null } }, { mark: text, text: [rows] }]\n      - plot: [{ mark: text, data: { from: d }, text: { sum: value } }, { mark: text, text: [total] }]\n  - plot: [{ mark: barY, data: { from: d }, x: label, y: { sum: value } }]\n  - { input: table, from: d }\n');
    const dash = await ctx.dashboards.create(admin, wsId, { name: 'Demo board', description: 'demo', kind: 'mosaic', spec });
    const created = await runTool(env, t('create_app'), { name: 'Board app', source: { dashboard_id: dash.id } });
    expect(created.isError, JSON.stringify(created.content)).toBeFalsy();
    const sc = created.structuredContent as { app_id: string; summary: string; app_status: string; code: string; url: string };
    expect(sc.summary).toBe('1 dataset, 1 filter, 2 KPIs, 1 chart, 1 table');
    expect(sc.app_status).toBe('running');
    expect(sc.code).toContain('kpi[1].metric("total"');
    expect((await api('GET', `/api/apps/${sc.app_id}`)).json.app).toMatchObject({ status: 'running', spec: { dashboard_id: dash.id, kind: 'mosaic' } });
    // Bad code is refused before anything is saved.
    const bad = await runTool(env, t('create_app'), { name: 'Broken', source: { code: 'import streamlit as st\nst.title(' } });
    expect(bad.isError).toBe(true);
    expect((bad.structuredContent as { status: string }).status).toBe('invalid');
    expect((await api('GET', `/api/workspaces/${wsId}/apps`)).json.apps as unknown[]).toHaveLength(1);
    // Code as written, not started.
    const fromCode = await runTool(env, t('create_app'), { name: 'Hand written', source: { code: 'import streamlit as st\nst.title("hi")\n' }, run_now: false });
    const codeId = (fromCode.structuredContent as { app_id: string; app_status: string }).app_id;
    expect((fromCode.structuredContent as { app_status: string }).app_status).toBe('stopped');
    const list = await runTool(env, t('list_apps'), {});
    expect((list.structuredContent as { apps: { name: string; status: string }[] }).apps.map((a) => `${a.name}:${a.status}`).sort()).toEqual(['Board app:running', 'Hand written:stopped']);
    // update_app re-validates, restarts the running app, and can start a stopped one.
    const upd = await runTool(env, t('update_app'), { app_id: codeId, code: 'import streamlit as st\nst.title("v2")\n', run_now: true });
    expect(upd.isError, JSON.stringify(upd.content)).toBeFalsy();
    expect((upd.structuredContent as { app_status: string }).app_status).toBe('running');
    expect((await runTool(env, t('update_app'), { app_id: codeId, code: 'nope(' })).isError).toBe(true);
    // preview without a browser (an explicit, missing chrome_path is authoritative): health + the log.
    ctx.cfg.apps.chrome_path = '/nonexistent/chrome';
    const preview = await runTool(env, t('preview_app'), { app_id: codeId, wait_ms: 3000 });
    const ps = preview.structuredContent as { status: string; health: boolean; screenshot: boolean };
    expect(ps.health).toBe(true);
    expect(ps.screenshot).toBe(false);
    expect((preview.content[0] as { text: string }).text).toMatch(/no Chrome/);
    // With a real browser (developer machines; skipped in CI): a PNG comes back as an image content block.
    ctx.cfg.apps.chrome_path = undefined;
    if (!process.env.CI && findChrome()) {
      const shot = await runTool(env, t('preview_app'), { app_id: codeId, wait_ms: 3000 });
      expect((shot.structuredContent as { screenshot: boolean }).screenshot).toBe(true);
      expect(shot.content.some((c) => c.type === 'image' && c.mimeType === 'image/png')).toBe(true);
    }
    const logs = await runTool(env, t('get_app_logs'), { app_id: codeId, lines: 5 });
    expect((logs.structuredContent as { logs: string[] }).logs.some((l) => l.includes('fake streamlit on'))).toBe(true);
    // publish: approval first.
    const dry = await runTool(env, t('publish_app'), { app_id: codeId, audience: 'org' });
    expect((dry.structuredContent as { status: string }).status).toBe('approval_required');
    expect((await api('GET', `/api/apps/${codeId}`)).json.app).toMatchObject({ visibility: 'workspace' });
    const pub = await runTool(env, t('publish_app'), { app_id: codeId, audience: 'org', dry_run: false });
    expect((pub.structuredContent as { visibility: string }).visibility).toBe('org');
    expect((await api('GET', `/api/apps/${codeId}`, undefined, userJwt)).status).toBe(200);
    // stop + run.
    await runTool(env, t('stop_app'), { app_id: codeId });
    expect((await api('GET', `/api/apps/${codeId}`)).json.app).toMatchObject({ status: 'stopped' });
    expect(((await runTool(env, t('run_app'), { app_id: codeId })).structuredContent as { app_status: string }).app_status).toBe('running');
    // Preview refuses a stopped app.
    await runTool(env, t('stop_app'), { app_id: sc.app_id });
    expect((await runTool(env, t('preview_app'), { app_id: sc.app_id })).isError).toBe(true);
    // REST: generate without saving, and the guide.
    const gen = await api('POST', `/api/workspaces/${wsId}/apps/generate`, { source: { queries: [{ name: 'q', sql: 'SELECT 1' }] } });
    expect(gen.json).toMatchObject({ summary: '1 query', validation: { ok: true } });
    expect(String((await api('GET', '/api/apps/guide')).json.guide)).toContain('duckview.streamlit');
    await runTool(env, t('stop_app'), { app_id: codeId });
    await api('DELETE', `/api/apps/${codeId}`);
    await api('DELETE', `/api/apps/${sc.app_id}`);
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
