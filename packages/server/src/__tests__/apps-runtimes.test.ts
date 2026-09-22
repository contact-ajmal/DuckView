/**
 * Data apps, phase three: the runtime tiers (a Kubernetes API server faked in-process; a real Docker daemon when one
 * is available), scale-to-zero with always-on apps, crash restarts and LRU eviction, and publish review by
 * administrators.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config/index.js';
import { initLogger } from '../observability/logger.js';
import { createContext, type AppContext } from '../context.js';
import { buildApp } from '../app.js';
import { buildTools, runTool, type ToolEnv } from '../agent/tools.js';
import { tarFiles, dockerMemory, CONTAINER_LAUNCH } from '../services/app-runtimes.js';
import type { Principal } from '../services/principal.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(here, 'fixtures', 'fake-streamlit.mjs');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Server {
  dir: string;
  ctx: AppContext;
  app: Awaited<ReturnType<typeof buildApp>>['app'];
  base: string;
  admin: Principal;
  jwt: string;
  userJwt: string;
  wsId: string;
  api(method: string, url: string, body?: unknown, token?: string): Promise<{ status: number; json: Record<string, unknown> }>;
  waitStatus(id: string, status: string, ms?: number): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

/** A server with apps on the UI's origin (apps.isolation off — the isolated default is covered in apps.test.ts). */
async function server(env: Record<string, string>, setup?: (ctx: AppContext) => void): Promise<Server> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dv-apprt-'));
  const cfg = loadConfig({
    configPath: null,
    env: { DUCKVIEW_DATA_DIR: path.join(dir, 'data'), DUCKVIEW_FILESYSTEM_MODE: 'full', DUCKDB_TEMP_DIRECTORY: path.join(dir, 'spill'), DATABASE_URL: ':memory:', DUCKDB_MEMORY_LIMIT: '512MB', DUCKVIEW_ADMIN_EMAIL: 'admin@test.local', DUCKVIEW_ADMIN_PASSWORD: 'super-secret-pw', DUCKVIEW__duckdb__sync_scheduler_enabled: 'false', DUCKVIEW__apps__start_timeout_seconds: '20', DUCKVIEW__apps__isolation: 'false', LOG_LEVEL: 'silent', ...env },
  });
  const ctx = await createContext(cfg);
  ctx.apps.command = [process.execPath, FAKE];
  setup?.(ctx);
  const admin = ctx.auth.principalFromUser((await ctx.auth.findByEmail('admin@test.local'))!, 'jwt', '127.0.0.1');
  const user = await ctx.auth.createLocalUser({ email: 'user@test.local', password: 'user-secret-pw', role: 'USER' });
  const wsId = (await ctx.workspaces.create(admin, { name: 'Apps', active_db_path: 'apps.duckdb' })).id;
  await ctx.workspaces.setMember(admin, wsId, { subject_type: 'user', subject_id: user.id, role: 'EDITOR' });
  const { app } = await buildApp(ctx);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const api: Server['api'] = async (method, url, body, token) => {
    const res = await fetch(base + url, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), authorization: `Bearer ${token ?? s.jwt}` }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  const s: Server = {
    dir, ctx, app, base, admin, wsId, api, jwt: '', userJwt: '',
    async waitStatus(id, status, ms = 20_000) {
      const t0 = Date.now();
      let last: Record<string, unknown> = {};
      while (Date.now() - t0 < ms) {
        last = (await api('GET', `/api/apps/${id}`)).json.app as Record<string, unknown>;
        if (last.status === status) return last;
        await sleep(150);
      }
      throw new Error(`app ${id} did not reach ${status} (last: ${last.status} ${last.last_error ?? ''})`);
    },
    async close() {
      await app.close();
      await ctx.shutdown();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  s.jwt = (await api('POST', '/api/auth/login', { email: 'admin@test.local', password: 'super-secret-pw' }, '')).json.token as string;
  s.userJwt = (await api('POST', '/api/auth/login', { email: 'user@test.local', password: 'user-secret-pw' }, '')).json.token as string;
  return s;
}

beforeAll(() => initLogger({ level: 'silent', stderr: true, pretty: false }));

describe('runtime helpers', () => {
  it('builds a tar that tar(1) extracts, nested paths included, and converts memory units for Docker', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dv-tar-'));
    try {
      const long = `${'d'.repeat(60)}/${'e'.repeat(60)}/page.py`; // > 100 bytes: needs the ustar prefix
      const files = { 'app.py': 'import streamlit as st\nst.title("héllo")\n', 'pages/2_Other.py': 'x = 1\n', [long]: 'y = 2\n', 'requirements.txt': '' };
      const r = spawnSync('tar', ['-xf', '-', '-C', dir], { input: tarFiles(files) });
      expect(r.status, String(r.stderr)).toBe(0);
      for (const [name, content] of Object.entries(files)) expect(fs.readFileSync(path.join(dir, name), 'utf8')).toBe(content);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    expect(dockerMemory('1Gi')).toBe('1g');
    expect(dockerMemory('512Mi')).toBe('512m');
    expect(dockerMemory('2g')).toBe('2g');
    expect(CONTAINER_LAUNCH).toContain('exec "$@"');
  });
});

describe('scaling and publish review (subprocess runtime)', () => {
  let s: Server;
  beforeAll(async () => {
    s = await server({ DUCKVIEW__apps__port_range: JSON.stringify([18721, 18740]), DUCKVIEW__apps__max_running: '2', DUCKVIEW__apps__evict_idle_seconds: '1', DUCKVIEW__apps__max_restarts: '2' });
  });
  afterAll(async () => s?.close());

  const create = async (name: string, code = 'import streamlit as st\n', token?: string) => {
    const r = await s.api('POST', `/api/workspaces/${s.wsId}/apps`, { name, files: { 'app.py': code } }, token);
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    return (r.json.app as { id: string }).id;
  };

  it('evicts the least recently used idle app when max_running is reached, never an always-on one', async () => {
    const a = await create('A');
    const b = await create('B');
    const c = await create('C');
    expect((await s.api('POST', `/api/apps/${a}/start`, {})).status).toBe(200);
    await sleep(50);
    expect((await s.api('POST', `/api/apps/${b}/start`, {})).status).toBe(200);
    // Both busy (used just now): no room, the message says why.
    s.ctx.apps.touch(a);
    s.ctx.apps.touch(b);
    const refused = await s.api('POST', `/api/apps/${c}/start`, {});
    expect(refused.status).toBe(400);
    expect(String(refused.json.message)).toMatch(/max_running.*idle for 1 s/);
    await sleep(1100);
    s.ctx.apps.touch(b); // b is in use; a is the least recently used
    const started = await s.api('POST', `/api/apps/${c}/start`, {});
    expect(started.status, JSON.stringify(started.json)).toBe(200);
    expect((await s.api('GET', `/api/apps/${a}`)).json.app).toMatchObject({ status: 'stopped' });
    expect((await s.api('GET', `/api/apps/${a}/logs`)).json.logs as string[]).toEqual(expect.arrayContaining([expect.stringContaining('stopping (evicted)')]));
    // b always on: after a second, c (idle) is evicted for a, not b.
    expect((await s.api('POST', `/api/apps/${b}/always-on`, { on: true })).json.app).toMatchObject({ always_on: true });
    await sleep(1100);
    expect((await s.api('POST', `/api/apps/${a}/start`, {})).status).toBe(200);
    expect((await s.api('GET', `/api/apps/${c}`)).json.app).toMatchObject({ status: 'stopped' });
    expect((await s.api('GET', `/api/apps/${b}`)).json.app).toMatchObject({ status: 'running', always_on: true, runtime: 'subprocess' });
    // Scale to zero spares always-on apps.
    expect(await s.ctx.apps.reapIdle(Date.now() + 3_600_000)).toEqual([a]);
    expect((await s.api('GET', `/api/apps/${b}`)).json.app).toMatchObject({ status: 'running' });
    // Only administrators signed in to the UI decide what stays on.
    expect((await s.api('POST', `/api/apps/${c}/always-on`, { on: true }, s.userJwt)).status).toBe(403);
    await s.api('POST', `/api/apps/${b}/always-on`, { on: false });
    for (const id of [a, b, c]) await s.api('DELETE', `/api/apps/${id}`);
  });

  it('restarts a crashed always-on app with backoff, gives up after max_restarts, starts always-on apps at boot', async () => {
    const id = await create('Keeper');
    await s.api('POST', `/api/apps/${id}/always-on`, { on: true });
    const running = await s.waitStatus(id, 'running');
    expect(running.always_on).toBe(true);
    // Kill the process behind DuckView's back: it comes back after the first backoff (5 s).
    const pid = (await s.ctx.store.db.select().from(s.ctx.store.schema.dataApps)).find((r) => r.id === id)!.pid!;
    expect(pid).toBeGreaterThan(0);
    process.kill(pid, 'SIGKILL');
    await s.waitStatus(id, 'error', 5000);
    expect((await s.api('GET', `/api/apps/${id}/logs`)).json.logs as string[]).toEqual(expect.arrayContaining([expect.stringContaining('restarting in 5 s (attempt 1 of 2)')]));
    await s.waitStatus(id, 'running', 15_000);
    // A manual stop cancels restarts; an app that cannot start is retried, then left in error.
    await s.api('POST', `/api/apps/${id}/stop`, {});
    await s.api('PATCH', `/api/apps/${id}`, { files: { 'app.py': '# CRASH_ON_START\nimport streamlit as st\n' } });
    s.ctx.cfg.apps.max_restarts = 0;
    await s.ctx.apps.startAlwaysOn();
    await s.waitStatus(id, 'error');
    await sleep(300);
    expect((await s.api('GET', `/api/apps/${id}/logs`)).json.logs as string[]).toEqual(expect.arrayContaining([expect.stringContaining('not restarting: 0 restarts in a row failed')]));
    s.ctx.cfg.apps.max_restarts = 2;
    // Boot: a healthy always-on app starts by itself, on its creator's behalf.
    await s.api('PATCH', `/api/apps/${id}`, { files: { 'app.py': 'import streamlit as st\n' } });
    expect(await s.ctx.apps.startAlwaysOn()).toEqual([id]);
    await s.waitStatus(id, 'running');
    await s.api('POST', `/api/apps/${id}/always-on`, { on: false });
    await s.api('DELETE', `/api/apps/${id}`);
  });

  it('holds publishing to everyone for an administrator, and sends changed code back to review', async () => {
    const outsider = await s.ctx.auth.createLocalUser({ email: 'outsider@test.local', password: 'outsider-pw-123', role: 'USER' });
    const outsiderJwt = (await s.api('POST', '/api/auth/login', { email: 'outsider@test.local', password: 'outsider-pw-123' }, '')).json.token as string;
    expect(outsider.id).toBeTruthy();
    const id = await create('Sales board', 'import streamlit as st\n', s.userJwt);
    // An editor asks; nothing changes for the rest of the org yet.
    const req = await s.api('POST', `/api/apps/${id}/publish`, { audience: 'org', note: 'for the sales team' }, s.userJwt);
    expect(req.status, JSON.stringify(req.json)).toBe(200);
    expect(req.json).toMatchObject({ outcome: 'pending', app: { visibility: 'workspace', publish_status: 'pending', publish_note: 'for the sales team' } });
    expect((await s.api('GET', `/api/apps/${id}`, undefined, outsiderJwt)).status).toBe(404);
    // PATCH visibility is the same request, not a bypass.
    expect(((await s.api('PATCH', `/api/apps/${id}`, { visibility: 'org' }, s.userJwt)).json.app as { visibility: string }).visibility).toBe('workspace');
    // Reviewing is for administrators in the UI — not editors, not admin tokens (agents).
    expect((await s.api('POST', `/api/admin/apps/${id}/review`, { decision: 'approve' }, s.userJwt)).status).toBe(403);
    expect((await s.api('GET', '/api/admin/apps', undefined, s.userJwt)).status).toBe(403);
    const adminUser = (await s.ctx.auth.findByEmail('admin@test.local'))!;
    const adminToken = (await s.ctx.auth.createToken(adminUser, { name: 'agent', scopes: ['read', 'write', 'mcp', 'admin'] })).token;
    expect((await s.api('POST', `/api/admin/apps/${id}/review`, { decision: 'approve' }, adminToken)).status).toBe(403);
    // The queue.
    const queue = await s.api('GET', '/api/admin/apps?publish_status=pending');
    expect(queue.json.apps).toEqual([expect.objectContaining({ id, name: 'Sales board', workspace_name: 'Apps', owner_email: 'user@test.local', requested_by_email: 'user@test.local', publish_status: 'pending' })]);
    expect((queue.json.apps as Record<string, unknown>[])[0]).not.toHaveProperty('files');
    expect(queue.json.runtime).toMatchObject({ runtime: 'subprocess', max_running: 2, publish_requires_approval: true });
    // Reject with a reason, then approve a new request.
    expect((await s.api('POST', `/api/admin/apps/${id}/review`, { decision: 'reject', note: 'uses raw customer emails' })).json.app).toMatchObject({ publish_status: 'rejected', visibility: 'workspace', publish_note: 'uses raw customer emails' });
    expect((await s.api('POST', `/api/admin/apps/${id}/review`, { decision: 'approve' })).status).toBe(400);
    await s.api('POST', `/api/apps/${id}/publish`, { audience: 'org' }, s.userJwt);
    expect((await s.api('POST', `/api/admin/apps/${id}/review`, { decision: 'approve' })).json.app).toMatchObject({ publish_status: 'approved', visibility: 'org' });
    expect((await s.api('GET', `/api/apps/${id}`, undefined, outsiderJwt)).status).toBe(200);
    // A metadata edit keeps the approval; a code edit by the editor withdraws it until reviewed again.
    await s.api('PATCH', `/api/apps/${id}`, { description: 'weekly numbers' }, s.userJwt);
    expect((await s.api('GET', `/api/apps/${id}`)).json.app).toMatchObject({ visibility: 'org', publish_status: 'approved' });
    await s.api('PATCH', `/api/apps/${id}`, { files: { 'app.py': 'import streamlit as st\nst.write("v2")\n' } }, s.userJwt);
    expect((await s.api('GET', `/api/apps/${id}`)).json.app).toMatchObject({ visibility: 'workspace', publish_status: 'pending', publish_note: 'The code changed after it was approved' });
    expect((await s.api('GET', `/api/apps/${id}`, undefined, outsiderJwt)).status).toBe(404);
    // An administrator's own edit and publish need no review.
    await s.api('POST', `/api/admin/apps/${id}/review`, { decision: 'approve' });
    await s.api('PATCH', `/api/apps/${id}`, { files: { 'app.py': 'import streamlit as st\nst.write("v3")\n' } });
    expect((await s.api('GET', `/api/apps/${id}`)).json.app).toMatchObject({ visibility: 'org', publish_status: 'approved' });
    // Unpublishing is immediate for editors.
    expect((await s.api('POST', `/api/apps/${id}/publish`, { audience: 'workspace' }, s.userJwt)).json).toMatchObject({ outcome: 'unpublished', app: { visibility: 'workspace', publish_status: 'none' } });
    // Agents: publish_app with dry_run=false files a request.
    const agent = s.ctx.auth.principalFromUser((await s.ctx.auth.findByEmail('user@test.local'))!, 'token', '127.0.0.1');
    const env: ToolEnv = { ctx: s.ctx, principal: agent, via: 'rest', defaultWorkspaceId: s.wsId, agent: null };
    const tool = buildTools(s.ctx.cfg).find((t) => t.name === 'publish_app')!;
    const dry = await runTool(env, tool, { app_id: id, audience: 'org' });
    expect(dry.structuredContent).toMatchObject({ status: 'approval_required', review: true });
    const sent = await runTool(env, tool, { app_id: id, audience: 'org', note: 'agent built it', dry_run: false });
    expect(sent.structuredContent).toMatchObject({ status: 'pending', outcome: 'pending', visibility: 'workspace', publish_status: 'pending' });
    expect((sent.content[0] as { text: string }).text).toMatch(/Settings → Data apps/);
    // Without review configured, editors publish at once.
    s.ctx.cfg.apps.publish_requires_approval = false;
    await s.api('POST', `/api/apps/${id}/publish`, { audience: 'workspace' }, s.userJwt);
    expect((await s.api('POST', `/api/apps/${id}/publish`, { audience: 'org' }, s.userJwt)).json).toMatchObject({ outcome: 'published', app: { visibility: 'org', publish_status: 'approved' } });
    s.ctx.cfg.apps.publish_requires_approval = true;
    // Admin stop from the console.
    await s.api('POST', `/api/apps/${id}/start`, {});
    expect((await s.api('POST', `/api/admin/apps/${id}/stop`, {}, s.userJwt)).status).toBe(403);
    expect((await s.api('POST', `/api/admin/apps/${id}/stop`, {})).json).toEqual({ ok: true });
    expect((await s.api('GET', `/api/apps/${id}`)).json.app).toMatchObject({ status: 'stopped' });
    await s.api('DELETE', `/api/apps/${id}`);
  });
});

// ------------------------------------------------------------------ Kubernetes (a fake API server)

/** Just enough of the Kubernetes API: Secrets, ConfigMaps and Pods, where a pod runs its args as a local process. */
function fakeKube(token: string) {
  type Obj = { metadata: { name: string; uid?: string; labels?: Record<string, string>; ownerReferences?: unknown[] }; [k: string]: unknown };
  const store = { pods: new Map<string, Obj>(), configmaps: new Map<string, Obj>(), secrets: new Map<string, Obj>() };
  const procs = new Map<string, { child: ChildProcess; out: string[]; listeners: Set<(s: string) => void>; ended: boolean }>();
  const calls: string[] = [];
  let uid = 0;
  const run = (pod: Obj) => {
    const spec = pod.spec as { containers: { image: string; args: string[]; env: { name: string; value: string }[]; envFrom: { secretRef: { name: string } }[] }[]; volumes: { name: string; configMap?: { name: string; items: { key: string; path: string }[] } }[] };
    const c = spec.containers[0]!;
    const name = pod.metadata.name;
    if (c.image === 'bad/image:missing') {
      pod.status = { phase: 'Pending', containerStatuses: [{ state: { waiting: { reason: 'ErrImagePull', message: 'pull access denied for bad/image' } } }] };
      return;
    }
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dv-pod-'));
    const cm = store.configmaps.get(spec.volumes.find((v) => v.configMap)!.configMap!.name)!;
    for (const item of spec.volumes.find((v) => v.configMap)!.configMap!.items) {
      fs.mkdirSync(path.dirname(path.join(cwd, item.path)), { recursive: true });
      fs.writeFileSync(path.join(cwd, item.path), (cm.data as Record<string, string>)[item.key]!);
    }
    const env: Record<string, string> = { PATH: process.env.PATH ?? '' };
    for (const e of c.env) env[e.name] = e.value;
    for (const f of c.envFrom) Object.assign(env, (store.secrets.get(f.secretRef.name)!.stringData as Record<string, string>) ?? {});
    const child = spawn(c.args[0]!, c.args.slice(1), { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const p = { child, out: [] as string[], listeners: new Set<(s: string) => void>(), ended: false };
    const emit = (d: Buffer) => { p.out.push(String(d)); for (const l of p.listeners) l(String(d)); };
    child.stdout!.on('data', emit);
    child.stderr!.on('data', emit);
    procs.set(name, p);
    pod.status = { phase: 'Running', podIP: '127.0.0.1', containerStatuses: [{ state: { running: { startedAt: new Date().toISOString() } } }] };
    child.on('exit', (code) => {
      p.ended = true;
      for (const l of p.listeners) l('\u0000end');
      const live = store.pods.get(name);
      if (live === pod) pod.status = { phase: code === 0 ? 'Succeeded' : 'Failed', containerStatuses: [{ state: { terminated: { exitCode: code ?? 137, reason: code === 0 ? 'Completed' : 'Error' } } }] };
      fs.rmSync(cwd, { recursive: true, force: true });
    });
  };
  const srv = http.createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    calls.push(`${req.method} ${url.pathname}${url.search}`);
    const send = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.headers.authorization !== `Bearer ${token}`) return send(401, { kind: 'Status', message: 'Unauthorized' });
    const m = /^\/api\/v1\/namespaces\/([^/]+)\/(pods|configmaps|secrets)(?:\/([^/]+))?(\/log)?$/.exec(url.pathname);
    if (!m || m[1] !== 'apps-ns') return send(404, { message: 'not found' });
    const kind = m[2] as keyof typeof store;
    const name = m[3];
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const map = store[kind];
      if (m[4]) {
        const p = procs.get(name!);
        if (!p) return send(404, { message: 'no log' });
        res.writeHead(200, { 'content-type': 'text/plain' });
        for (const chunk of p.out) res.write(chunk);
        if (p.ended) return res.end();
        const l = (s: string) => (s === '\u0000end' ? (p.listeners.delete(l), res.end()) : res.write(s));
        p.listeners.add(l);
        res.on('close', () => p.listeners.delete(l));
        return;
      }
      if (req.method === 'POST' && !name) {
        const obj = JSON.parse(body) as Obj;
        if (map.has(obj.metadata.name)) return send(409, { message: `${kind} "${obj.metadata.name}" already exists` });
        obj.metadata.uid = `uid-${++uid}`;
        map.set(obj.metadata.name, obj);
        if (kind === 'pods') run(obj);
        return send(201, obj);
      }
      if (req.method === 'GET' && !name) {
        const sel = url.searchParams.get('labelSelector');
        const [k, v] = (sel ?? '=').split('=');
        return send(200, { items: [...map.values()].filter((o) => !sel || o.metadata.labels?.[k!] === v) });
      }
      const obj = name ? map.get(name) : undefined;
      if (!obj) return send(404, { kind: 'Status', message: `${kind} "${name}" not found` });
      if (req.method === 'GET') return send(200, obj);
      if (req.method === 'PATCH') {
        expect(req.headers['content-type']).toBe('application/merge-patch+json');
        Object.assign(obj.metadata, (JSON.parse(body) as Obj).metadata);
        return send(200, obj);
      }
      if (req.method === 'DELETE') {
        map.delete(name!);
        if (kind === 'pods') procs.get(name!)?.child.kill('SIGTERM');
        return send(200, { kind: 'Status', status: 'Success' });
      }
      send(405, { message: 'method not allowed' });
    });
  });
  return { srv, store, calls, procs };
}

describe('kubernetes runtime', () => {
  let s: Server;
  let kube: ReturnType<typeof fakeKube>;
  beforeAll(async () => {
    const tokenFile = path.join(os.tmpdir(), `dv-kube-token-${process.pid}`);
    fs.writeFileSync(tokenFile, 'kube-sa-token\n');
    kube = fakeKube('kube-sa-token');
    await new Promise<void>((r) => kube.srv.listen(0, '127.0.0.1', r));
    const apiUrl = `http://127.0.0.1:${(kube.srv.address() as { port: number }).port}`;
    s = await server({ DUCKVIEW__apps__runtime: 'kubernetes', DUCKVIEW__apps__kubernetes__api_url: apiUrl, DUCKVIEW__apps__kubernetes__token_file: tokenFile, DUCKVIEW__apps__kubernetes__ca_file: path.join(os.tmpdir(), 'no-ca.crt'), DUCKVIEW__apps__kubernetes__namespace: 'apps-ns', DUCKVIEW__apps__kubernetes__container_port: '18760', DUCKVIEW__apps__kubernetes__command: JSON.stringify([process.execPath, FAKE]), DUCKVIEW__apps__kubernetes__labels: JSON.stringify({ team: 'data' }), DUCKVIEW__apps__resources__memory: '768Mi' });
    s.ctx.cfg.apps.kubernetes.duckview_url = s.base;
  });
  afterAll(async () => {
    await s?.close();
    kube?.srv.close();
  });

  it('runs an app as a hardened pod: source in a ConfigMap, token in a Secret, both owned by the pod', async () => {
    const r = await s.api('POST', `/api/workspaces/${s.wsId}/apps`, { name: 'Pod app', files: { 'app.py': 'import streamlit as st\n# in a pod\n', 'pages/2_More.py': 'x = 1\n' } });
    const id = (r.json.app as { id: string }).id;
    const started = await s.api('POST', `/api/apps/${id}/start`, {});
    expect(started.status, JSON.stringify(started.json)).toBe(200);
    expect(started.json.app).toMatchObject({ status: 'running', runtime: 'kubernetes', runtime_ref: `apps-ns/dv-app-${id}` });
    const name = `dv-app-${id}`;
    const pod = kube.store.pods.get(name)! as { metadata: { labels: Record<string, string> }; spec: Record<string, unknown> & { containers: Record<string, unknown>[] } };
    expect(pod.metadata.labels).toMatchObject({ 'duckview.io/app': id, 'app.kubernetes.io/managed-by': 'duckview', team: 'data' });
    expect(pod.spec).toMatchObject({ restartPolicy: 'Never', automountServiceAccountToken: false, securityContext: { runAsNonRoot: true, runAsUser: 1001 } });
    const c = pod.spec.containers[0]! as { env: { name: string; value: string }[]; args: string[]; securityContext: unknown; resources: { limits: Record<string, string> } };
    expect(c.securityContext).toEqual({ allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } });
    expect(c.resources.limits).toEqual({ cpu: '1', memory: '768Mi' });
    expect(c.args).toEqual(expect.arrayContaining(['app.py', '--server.port=18760', '--server.address=0.0.0.0', `--server.baseUrlPath=/apps/${id}`]));
    // The token is never in the pod spec, only in the Secret.
    expect(c.env.map((e) => e.name)).not.toContain('DUCKVIEW_TOKEN');
    expect(c.env.find((e) => e.name === 'DUCKVIEW_URL')!.value).toBe(s.base);
    expect(JSON.stringify(pod)).not.toMatch(/dv_[A-Za-z0-9]{16,}/);
    expect(((kube.store.secrets.get(name)!.stringData as Record<string, string>).DUCKVIEW_TOKEN)).toMatch(/^dv_/);
    expect(Object.values(kube.store.configmaps.get(name)!.data as Record<string, string>)).toEqual(['import streamlit as st\n# in a pod\n', 'x = 1\n']);
    for (const kind of ['configmaps', 'secrets'] as const) expect(kube.store[kind].get(name)!.metadata.ownerReferences).toEqual([expect.objectContaining({ kind: 'Pod', name, uid: 'uid-3' })]);
    // Through the proxy, with the pod's token working against DuckView.
    const cookie = (await fetch(`${s.base}/api/apps/${id}/session`, { method: 'POST', headers: { authorization: `Bearer ${s.jwt}`, 'content-type': 'application/json' }, body: '{}' })).headers.get('set-cookie')!.split(';')[0]!;
    const page = await (await fetch(`${s.base}/apps/${id}/`, { headers: { cookie } })).text();
    const info = JSON.parse(/<script id="info" type="application\/json">(.*?)<\/script>/.exec(page)![1]!) as Record<string, unknown>;
    expect(info).toMatchObject({ hasToken: true, queryStatus: 200, mutateStatus: 403, viewer: 'admin@test.local', source: 'import streamlit as st\n# in a pod\n' });
    // Logs stream from the pod.
    await sleep(300);
    expect((await s.api('GET', `/api/apps/${id}/logs`)).json.logs as string[]).toEqual(expect.arrayContaining([expect.stringContaining('fake streamlit on 18760'), expect.stringContaining(`pod ${name}: Running`)]));
    // Stop deletes the pod, the ConfigMap and the Secret.
    await s.api('POST', `/api/apps/${id}/stop`, {});
    expect([kube.store.pods.has(name), kube.store.configmaps.has(name), kube.store.secrets.has(name)]).toEqual([false, false, false]);
    expect((await s.api('GET', `/api/apps/${id}`)).json.app).toMatchObject({ status: 'stopped' });
    // A pod that dies is noticed; one that cannot pull its image fails with the reason and leaves nothing behind.
    await s.api('POST', `/api/apps/${id}/start`, {});
    kube.procs.get(name)!.child.kill('SIGKILL');
    const crashed = await s.waitStatus(id, 'error', 10_000);
    expect(String(crashed.last_error)).toMatch(/exited with 137/);
    s.ctx.cfg.apps.kubernetes.image = 'bad/image:missing';
    const bad = await s.api('POST', `/api/apps/${id}/start`, {});
    expect(bad.status).toBe(400);
    expect(String(bad.json.message)).toMatch(/ErrImagePull: pull access denied/);
    expect([kube.store.pods.size, kube.store.configmaps.size, kube.store.secrets.size]).toEqual([0, 0, 0]);
    s.ctx.cfg.apps.kubernetes.image = 'anbproject/duckview-app-runtime:latest';
    // Boot cleanup removes this server's leftovers (by label) and nothing else.
    await s.api('POST', `/api/apps/${id}/start`, {});
    kube.store.pods.set('someone-else', { metadata: { name: 'someone-else', labels: { 'duckview.io/server': 'other' } } });
    expect(await s.ctx.apps.runtime.cleanup()).toBe(1);
    expect([...kube.store.pods.keys()]).toEqual(['someone-else']);
    expect(kube.calls.every((c) => c.includes('/namespaces/apps-ns/'))).toBe(true);
    kube.store.pods.clear();
    await s.api('DELETE', `/api/apps/${id}`);
  });
});

// ------------------------------------------------------------------ Docker (a real daemon, when there is one)

const dockerImage = process.env.DUCKVIEW_TEST_DOCKER_IMAGE ?? 'anbproject/duckview:dev';
const hasDocker = !process.env.CI && spawnSync('docker', ['image', 'inspect', dockerImage], { stdio: 'ignore' }).status === 0;

describe.skipIf(!hasDocker)('docker runtime', () => {
  let s: Server;
  beforeAll(async () => {
    s = await server({ DUCKVIEW__apps__runtime: 'docker', DUCKVIEW__apps__port_range: JSON.stringify([18781, 18790]), DUCKVIEW__apps__docker__image: dockerImage, DUCKVIEW__apps__docker__command: JSON.stringify(['node', 'server.mjs']), DUCKVIEW__apps__resources__memory: '256Mi', DUCKVIEW__apps__start_timeout_seconds: '60' });
  });
  afterAll(async () => s?.close());

  it('runs an app in a locked-down container with the source streamed in and the token passed by name', async () => {
    // A stand-in "streamlit" written in Node (the test image has Node, not Streamlit): it honours the flags and
    // reports what the container looks like from inside.
    const serverMjs = `import http from 'node:http'; import fs from 'node:fs';
const arg = (n) => process.argv.find((a) => a.startsWith(n + '='))?.slice(n.length + 1);
const base = arg('--server.baseUrlPath');
let writable = true; try { fs.writeFileSync('/etc/x', 'x'); } catch { writable = false; }
http.createServer(async (req, res) => {
  if (req.url === base + '/_stcore/health') return res.end('ok');
  let back = null; try { back = (await fetch(process.env.DUCKVIEW_URL + '/healthz', { signal: AbortSignal.timeout(3000) })).status; } catch (e) { back = String(e.cause?.code ?? e); }
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ uid: process.getuid(), cwd: process.cwd(), files: fs.readdirSync('.').sort(), nested: fs.existsSync('pages/2_More.py'), hasToken: (process.env.DUCKVIEW_TOKEN ?? '').startsWith('dv_'), url: process.env.DUCKVIEW_URL, rootWritable: writable, back, viewer: req.headers['x-duckview-email'] }));
}).listen(Number(arg('--server.port')), arg('--server.address'), () => console.log('node app up on ' + arg('--server.port')));
process.on('SIGTERM', () => process.exit(0));`;
    const r = await s.api('POST', `/api/workspaces/${s.wsId}/apps`, { name: 'Container app', files: { 'app.py': 'import streamlit as st\n', 'server.mjs': serverMjs, 'pages/2_More.py': 'x = 1\n' } });
    const id = (r.json.app as { id: string }).id;
    const started = await s.api('POST', `/api/apps/${id}/start`, {});
    expect(started.status, JSON.stringify(started.json)).toBe(200);
    expect(started.json.app).toMatchObject({ status: 'running', runtime: 'docker', runtime_ref: `dv-app-${id}` });
    // The token never appears in the container's command line or labels.
    const inspect = JSON.parse(spawnSync('docker', ['inspect', `dv-app-${id}`]).stdout.toString())[0] as { Config: { Cmd: string[]; Labels: Record<string, string> }; HostConfig: { ReadonlyRootfs: boolean; CapDrop: string[]; SecurityOpt: string[]; Memory: number; PidsLimit: number } };
    expect(JSON.stringify(inspect.Config.Cmd)).not.toMatch(/dv_[A-Za-z0-9]{10,}/);
    expect(inspect.Config.Labels['duckview.app']).toBe(id);
    expect(inspect.HostConfig).toMatchObject({ ReadonlyRootfs: true, CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'], Memory: 256 * 1024 * 1024, PidsLimit: 256 });
    const cookie = (await fetch(`${s.base}/api/apps/${id}/session`, { method: 'POST', headers: { authorization: `Bearer ${s.jwt}`, 'content-type': 'application/json' }, body: '{}' })).headers.get('set-cookie')!.split(';')[0]!;
    const info = (await (await fetch(`${s.base}/apps/${id}/`, { headers: { cookie } })).json()) as Record<string, unknown>;
    expect(info).toMatchObject({ uid: 1001, cwd: '/tmp/app', nested: true, hasToken: true, rootWritable: false, viewer: 'admin@test.local' });
    expect(info.files).toEqual(['app.py', 'pages', 'server.mjs']);
    expect(String(info.url)).toMatch(/^http:\/\/host\.docker\.internal:\d+$/);
    expect((await s.api('GET', `/api/apps/${id}/logs`)).json.logs as string[]).toEqual(expect.arrayContaining([expect.stringContaining('node app up on 8501')]));
    await s.api('POST', `/api/apps/${id}/stop`, {});
    expect(spawnSync('docker', ['inspect', `dv-app-${id}`], { stdio: 'ignore' }).status).not.toBe(0);
    await s.api('DELETE', `/api/apps/${id}`);
  }, 120_000);
});
