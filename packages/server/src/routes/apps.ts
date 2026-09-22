/**
 * Data apps: the registry API, and the proxy that serves a running Streamlit app under /apps/<id>/ (HTTP and the
 * /_stcore/stream WebSocket). The browser reaches the proxy from an iframe or a plain tab, where no bearer header
 * exists, so the UI first calls POST /api/apps/:id/session with its token and receives a short-lived, HttpOnly
 * cookie scoped to /apps; every proxied request is authenticated from that cookie, checked against the app's
 * workspace, and forwarded with the visitor's identity in X-DuckView-* headers.
 */
import http from 'node:http';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import WebSocket from 'ws';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import type { DataApp } from '../db/schema/sqlite.js';
import { APP_VISIBILITIES, APP_PUBLISH_STATUSES, APP_EXECUTIONS } from '../db/schema/sqlite.js';
import { DataAppService } from '../services/apps.js';
import { stlitePage, sdkFiles } from '../services/app-stlite.js';
import { DATA_APP_GUIDE } from '../services/app-generator.js';
import { isPlatformAdmin, type Principal } from '../services/principal.js';
import { forbidden } from '../services/errors.js';
import { newId } from '../security/crypto.js';
import { logger } from '../observability/logger.js';

export const COOKIE = 'dv_app';
const Files = z.record(z.string().max(200), z.string().max(2_000_000));
const Source = z.union([
  z.object({ template: z.string().max(40) }),
  z.object({ dashboard_id: z.string().max(64) }),
  z.object({ queries: z.array(z.object({ name: z.string().max(120), sql: z.string().max(50_000) })).max(50) }),
  z.object({ saved_query_ids: z.array(z.string().max(64)).max(50) }),
  z.object({ code: z.string().max(2_000_000), requirements: z.string().max(20_000).nullable().optional() }),
]);
const AppBody = z.object({ name: z.string().max(120), description: z.string().max(2000).nullable().optional(), files: Files.optional(), entry: z.string().max(200).optional(), spec: z.record(z.string(), z.unknown()).nullable().optional(), visibility: z.enum(APP_VISIBILITIES).optional(), execution: z.enum(APP_EXECUTIONS).optional(), source: Source.optional() });
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'cookie', 'authorization']);

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

export async function appRoutes(app: FastifyInstance, ctx: AppContext) {
  const secure = !!ctx.cfg.server.public_url?.startsWith('https://');
  ctx.apps.signSession = (userId) => app.jwt.sign({ purpose: 'app', sub: userId }, { expiresIn: '10m' });

  // ---------------------------------------------------------------- registry API (bearer)
  await app.register(async (r) => {
    r.addHook('preHandler', app.authenticate);
    r.get('/api/apps/templates', async () => ({ templates: ctx.apps.templates(), enabled: ctx.apps.enabled, runtime: ctx.cfg.apps.runtime, publish_requires_approval: ctx.cfg.apps.publish_requires_approval, browser: ctx.apps.browserReady }));
    r.get('/api/apps/guide', async () => ({ guide: DATA_APP_GUIDE }));
    /** Static checks of app sources (compile, imports, secrets) — the editor's "Check" and agents' safety net. */
    r.post('/api/apps/validate', async (req) => {
      const body = z.object({ files: Files, entry: z.string().max(200).optional() }).parse(req.body ?? {});
      return ctx.apps.validateSource(body.files, body.entry ?? 'app.py');
    });
    /** Generates files without saving them (the New-app dialog's preview of a dashboard-derived app). */
    r.post('/api/workspaces/:id/apps/generate', async (req) => {
      const { id } = req.params as { id: string };
      const body = z.object({ source: Source, name: z.string().max(120).optional(), description: z.string().max(2000).nullable().optional() }).parse(req.body ?? {});
      const g = await ctx.apps.generate(req.principal!, id, body.source, { name: body.name, description: body.description });
      return { ...g, validation: await ctx.apps.validateSource(g.files) };
    });
    r.get('/api/apps', async (req) => ({ apps: await ctx.apps.listAll(req.principal!), enabled: ctx.apps.enabled }));
    r.get('/api/workspaces/:id/apps', async (req) => {
      const { id } = req.params as { id: string };
      return { apps: await ctx.apps.list(req.principal!, id), enabled: ctx.apps.enabled };
    });
    r.post('/api/workspaces/:id/apps', async (req) => {
      const { id } = req.params as { id: string };
      const body = AppBody.parse(req.body ?? {});
      if (body.source) {
        const g = await ctx.apps.generate(req.principal!, id, body.source, { name: body.name || undefined, description: body.description });
        return { app: await ctx.apps.create(req.principal!, id, { ...body, name: body.name || g.name, description: body.description ?? g.description, files: body.files ?? g.files, spec: body.spec ?? g.spec }), summary: g.summary };
      }
      return { app: await ctx.apps.create(req.principal!, id, body) };
    });
    r.get('/api/apps/:id', async (req) => {
      const { id } = req.params as { id: string };
      const a = await ctx.apps.get(req.principal!, id);
      return { app: ctx.apps.toPublic(a), logs: ctx.apps.logs(id) };
    });
    r.patch('/api/apps/:id', async (req) => {
      const { id } = req.params as { id: string };
      const body = AppBody.partial().parse(req.body ?? {});
      return { app: await ctx.apps.update(req.principal!, id, body) };
    });
    r.delete('/api/apps/:id', async (req) => {
      const { id } = req.params as { id: string };
      await ctx.apps.remove(req.principal!, id);
      return { ok: true };
    });
    r.post('/api/apps/:id/start', async (req) => {
      const { id } = req.params as { id: string };
      return { app: await ctx.apps.start(req.principal!, id), logs: ctx.apps.logs(id) };
    });
    r.post('/api/apps/:id/stop', async (req) => {
      const { id } = req.params as { id: string };
      await ctx.apps.stop(req.principal!, id);
      return { ok: true };
    });
    r.post('/api/apps/:id/restart', async (req) => {
      const { id } = req.params as { id: string };
      await ctx.apps.stop(req.principal!, id, 'restart');
      return { app: await ctx.apps.start(req.principal!, id), logs: ctx.apps.logs(id) };
    });
    /** Who sees the app: "workspace", or "org" (everyone signed in) — a request for review unless an administrator publishes. */
    r.post('/api/apps/:id/publish', async (req) => {
      const { id } = req.params as { id: string };
      const body = z.object({ audience: z.enum(APP_VISIBILITIES), note: z.string().max(1000).nullable().optional() }).parse(req.body ?? {});
      return ctx.apps.publish(req.principal!, id, body.audience, body.note);
    });
    r.post('/api/apps/:id/always-on', async (req) => {
      const { id } = req.params as { id: string };
      const body = z.object({ on: z.boolean() }).parse(req.body ?? {});
      return { app: await ctx.apps.setAlwaysOn(req.principal!, id, body.on) };
    });
    // Administrators: every app on the server, the runtime, and publish requests to review.
    r.get('/api/admin/apps', async (req) => {
      const q = z.object({ publish_status: z.enum(APP_PUBLISH_STATUSES).optional() }).parse(req.query ?? {});
      return { apps: await ctx.apps.adminList(req.principal!, q), runtime: ctx.apps.runtimeInfo() };
    });
    r.post('/api/admin/apps/:id/review', async (req) => {
      const { id } = req.params as { id: string };
      const body = z.object({ decision: z.enum(['approve', 'reject']), note: z.string().max(1000).nullable().optional() }).parse(req.body ?? {});
      return { app: await ctx.apps.review(req.principal!, id, body.decision, body.note) };
    });
    r.post('/api/admin/apps/:id/stop', async (req) => {
      const { id } = req.params as { id: string };
      if (!isPlatformAdmin(req.principal!)) throw forbidden('Administrator role required');
      await ctx.apps.stop(req.principal!, id, 'manual');
      return { ok: true };
    });
    /** A headless screenshot of the running app (needs Chrome on the server). */
    r.post('/api/apps/:id/preview', async (req, reply) => {
      const { id } = req.params as { id: string };
      const a = await ctx.apps.get(req.principal!, id);
      if (a.execution !== 'browser' && !ctx.apps.target(id)) return reply.code(409).send({ error: 'NOT_RUNNING', message: 'Start the app first' });
      const shot = await ctx.apps.screenshot(a, req.principal!.userId, ctx.apps.proxyUrl);
      if (!shot) return reply.code(501).send({ error: 'NO_BROWSER', message: 'No Chrome / Chromium on this server (apps.chrome_path)' });
      return { text: shot.text, png_base64: shot.png.toString('base64') };
    });
    r.get('/api/apps/:id/logs', async (req) => {
      const { id } = req.params as { id: string };
      const a = await ctx.apps.get(req.principal!, id);
      return { status: ctx.apps.status(id) ?? a.status, logs: ctx.apps.logs(id) };
    });
    /** Hands the browser a cookie for /apps so iframes and plain tabs can reach the proxy without a bearer header. */
    r.post('/api/apps/:id/session', async (req, reply) => {
      const { id } = req.params as { id: string };
      const p = req.principal!;
      if (p.actorType !== 'USER') return reply.code(400).send({ error: 'BAD_REQUEST', message: 'App sessions are for people in a browser' });
      await ctx.apps.get(p, id);
      if (!ctx.cfg.apps.isolation) {
        reply.header('set-cookie', appCookie(app, p.userId, secure));
        return { url: `/apps/${id}/`, app_url: `/apps/${id}/` };
      }
      // Isolated: the cookie belongs to the apps origin, so the browser picks it up there with a one-time handoff.
      const base = appsBase(req, ctx);
      const t = app.jwt.sign({ purpose: 'app-handoff', sub: p.userId, app: id, jti: newId() }, { expiresIn: '60s' });
      return { url: `${base}/_duckview/session?app=${encodeURIComponent(id)}&t=${encodeURIComponent(t)}`, app_url: `${base}/apps/${id}/` };
    });
  });

  if (!ctx.cfg.apps.isolation) {
    await app.register(async (r) => registerAppProxy(r, ctx, { signIn: (_req, reply) => deny(reply, 401, 'Sign in to DuckView to open this app') }));
    return;
  }
  // Isolated: apps live on their own origin; old links on the UI's origin are sent there.
  const elsewhere = async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    if (req.method === 'GET' && isNavigation(req)) return reply.redirect(`${appsBase(req, ctx)}/apps/${encodeURIComponent(id)}/`);
    return reply.code(404).send({ error: 'NOT_FOUND', message: `Apps are served from ${appsBase(req, ctx)}` });
  };
  app.get('/apps/:id', elsewhere);
  app.all('/apps/:id/*', elsewhere);
}

/**
 * The proxy that serves running apps under /apps/<id>/ (HTTP and the /_stcore/stream WebSocket), authenticated by
 * the /apps cookie. Mounted on the apps listener (isolation, the default) or on the UI's (apps.isolation: false).
 */
export async function registerAppProxy(r: FastifyInstance, ctx: AppContext, opts: { signIn: (req: FastifyRequest, reply: FastifyReply, id: string) => unknown }) {
  // Bodies pass through untouched (Streamlit uploads are multipart; its API is JSON/protobuf).
  r.removeAllContentTypeParsers();
  r.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  r.get('/apps/:id', async (req, reply) => reply.redirect(`/apps/${(req.params as { id: string }).id}/`));

  r.route({
    method: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD'],
    url: '/apps/:id/*',
    handler: async (req, reply) => {
      const { id } = req.params as { id: string };
      const p = await visitor(r, ctx, req);
      if (!p) return opts.signIn(req, reply, id);
      let a;
      try {
        a = await ctx.apps.get(p, id);
      } catch {
        return deny(reply, 404, 'No such app, or you are not a member of its workspace');
      }
      if (!ctx.apps.enabled) return deny(reply, 503, 'Data apps are disabled on this server');
      if (a.execution === 'browser') return browserApp(r, ctx, req, reply, a, p);
      const target = ctx.apps.target(id);
      if (!target) {
        // Not up: a person opening the page starts it (scale from zero) and the page retries. Background requests
        // — a Streamlit tab left open polling /_stcore/health after a stop — never do, or a stop would not stick.
        const st = ctx.apps.status(id);
        const navigation = isNavigation(req);
        if (!navigation) return reply.code(503).header('retry-after', '2').type('text/plain').send('app not running');
        if (!st) void ctx.apps.start(p, id).catch((err) => logger().warn({ app: id, err: (err as Error).message }, 'App auto-start failed'));
        const fresh = await ctx.apps.get(p, id).catch(() => a);
        const failed = fresh.status === 'error' && !st;
        return reply.code(failed ? 500 : 503).header('retry-after', '2').type('text/html').send(page(failed ? `${a.name} failed to start` : `Starting ${a.name}…`, failed ? fresh.last_error ?? 'See the app log in DuckView.' : 'Installing or booting the app; this page refreshes by itself.', !failed));
      }
      ctx.apps.touch(id);
      const role = (await ctx.workspaces.get(p, a.workspace_id).catch(() => null))?.role ?? 'VIEWER';
      return proxy(req, reply, target, p, role);
    },
  });

  r.get('/apps/:id/_stcore/stream', { websocket: true }, (socket, req) => {
    const { id } = req.params as { id: string };
    void (async () => {
      const p = await visitor(r, ctx, req);
      if (!p) return socket.close(1008, 'unauthorized');
      let a;
      try {
        a = await ctx.apps.get(p, id);
      } catch {
        return socket.close(1008, 'forbidden');
      }
      const target = ctx.apps.target(id);
      if (!target) return socket.close(1013, 'app not running');
      const role = (await ctx.workspaces.get(p, a.workspace_id).catch(() => null))?.role ?? 'VIEWER';
      bridge(socket, req, target, p, role, () => ctx.apps.touch(id));
    })().catch((err) => {
      logger().warn({ err: (err as Error).message }, 'App websocket failed');
      try {
        socket.close(1011);
      } catch {
        /* closed */
      }
    });
  });
}

/**
 * An in-browser app: the stlite page, with the viewer's own read-only credential for the app's workspace (the app
 * reads as the person looking at it — so someone who is not a member of the workspace gets an explanation).
 */
async function browserApp(r: FastifyInstance, ctx: AppContext, req: FastifyRequest, reply: FastifyReply, a: DataApp, p: Principal) {
  if (((req.params as Record<string, string>)['*'] ?? '') !== '' || req.method !== 'GET') return reply.code(404).type('text/plain').send('not found');
  if (!ctx.apps.browserReady) return deny(reply, 503, 'In-browser apps are disabled on this server');
  const member = await ctx.workspaces.get(p, a.workspace_id).catch(() => null);
  if (!member) return reply.code(403).type('text/html').send(page(`${a.name} runs in your browser, with your own access`, 'It reads its workspace as you, and you are not a member of that workspace — ask its owner to share it with you.'));
  const s = ctx.cfg.apps.stlite;
  const token = r.jwt.sign({ purpose: 'app-browser', sub: p.userId, ws: a.workspace_id }, { expiresIn: `${s.token_ttl_minutes}m` });
  const env = { DUCKVIEW_URL: apiBase(req, ctx), DUCKVIEW_TOKEN: token, DUCKVIEW_WORKSPACE: a.workspace_id, DUCKVIEW_APP_ID: a.id, DUCKVIEW_VIEWER_ID: p.userId, DUCKVIEW_VIEWER_EMAIL: p.email, DUCKVIEW_VIEWER_ROLE: member.role ?? 'VIEWER' };
  reply.header('cache-control', 'no-store');
  return reply.type('text/html; charset=utf-8').send(stlitePage({ app: a, sdk: sdkFiles(DataAppService.sdkDir()), env, stliteUrl: s.url, pyodideUrl: s.pyodide_url }));
}

/** DuckView's API as the browser reaches it from an app page (the UI's origin). */
function apiBase(req: FastifyRequest, ctx: AppContext): string {
  if (!ctx.cfg.apps.isolation) return `${req.protocol}://${req.host}`;
  return (ctx.cfg.server.public_url ?? `${req.protocol}://${hostPart(req.hostname)}:${ctx.cfg.server.port}`).replace(/\/+$/, '');
}

/** A person opening a page (not a script polling in the background). */
export const isNavigation = (req: FastifyRequest) => req.method === 'GET' && (req.headers['sec-fetch-mode'] === 'navigate' || /text\/html/.test(String(req.headers.accept ?? '')));

/** Where browsers reach the apps listener: apps.public_url, or the UI's scheme and host on apps.port. */
export function appsBase(req: FastifyRequest, ctx: AppContext): string {
  return ctx.cfg.apps.public_url ?? `${req.protocol}://${hostPart(req.hostname)}:${ctx.cfg.apps.port}`;
}

/** The /apps cookie: a 12-hour JWT naming the visitor, only good for the proxy. */
export function appCookie(app: FastifyInstance, userId: string, secure: boolean): string {
  const token = app.jwt.sign({ purpose: 'app', sub: userId }, { expiresIn: '12h' });
  return `${COOKIE}=${encodeURIComponent(token)}; Path=/apps; HttpOnly; SameSite=Lax; Max-Age=43200${secure ? '; Secure' : ''}`;
}

/** The visitor behind a proxied request, from the /apps cookie. */
export async function visitor(app: FastifyInstance, ctx: AppContext, req: FastifyRequest): Promise<Principal | null> {
  const raw = readCookie(req.headers.cookie, COOKIE);
  if (!raw) return null;
  try {
    const claims = app.jwt.verify<{ purpose?: string; sub?: string }>(raw);
    if (claims.purpose !== 'app' || !claims.sub) return null;
    const user = await ctx.auth.findById(claims.sub);
    if (!user) return null;
    return ctx.auth.principalFromUser(user, 'jwt', req.ip);
  } catch {
    return null;
  }
}

const deny = (reply: FastifyReply, status: number, message: string) => reply.code(status).type('text/html').send(page(message, status === 401 ? 'Open the app from DuckView to sign in.' : ''));

/** Forwards one HTTP request to the app's Streamlit server, streaming the answer straight to the socket. */
function proxy(req: FastifyRequest, reply: FastifyReply, { host, port }: { host: string; port: number }, p: Principal, role: string): Promise<void> {
  return new Promise((resolve) => {
    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && !HOP.has(k.toLowerCase())) headers[k] = v;
    headers.host = `${hostPart(host)}:${port}`;
    headers['x-duckview-user'] = p.userId;
    headers['x-duckview-email'] = p.email;
    headers['x-duckview-role'] = role;
    headers['x-forwarded-proto'] = req.protocol;
    headers['x-forwarded-for'] = req.ip;
    reply.hijack();
    const raw = reply.raw;
    const upstream = http.request({ host, port, method: req.method, path: req.raw.url, headers }, (res) => {
      const out: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(res.headers)) if (v !== undefined && !['connection', 'keep-alive', 'transfer-encoding'].includes(k)) out[k] = v;
      raw.writeHead(res.statusCode ?? 502, out);
      res.pipe(raw);
      res.on('end', resolve);
      res.on('error', () => { raw.destroy(); resolve(); });
    });
    upstream.on('error', (err) => {
      if (!raw.headersSent) {
        raw.writeHead(502, { 'content-type': 'text/html' });
        raw.end(page('The app is not answering', err.message));
      } else raw.destroy();
      resolve();
    });
    req.raw.on('close', () => upstream.destroy());
    const body = req.body as Buffer | undefined;
    if (body && body.length) upstream.end(body);
    else upstream.end();
  });
}

/** Pipes a browser WebSocket to the app's, both ways, with the visitor's headers on the upstream handshake. */
function bridge(client: WebSocket, req: FastifyRequest, { host, port }: { host: string; port: number }, p: Principal, role: string, touch: () => void): void {
  const protocols = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const headers: Record<string, string> = { 'x-duckview-user': p.userId, 'x-duckview-email': p.email, 'x-duckview-role': role, 'x-forwarded-for': req.ip };
  for (const k of ['user-agent', 'accept-language', 'origin']) if (req.headers[k]) headers[k] = String(req.headers[k]);
  const upstream = new WebSocket(`ws://${hostPart(host)}:${port}${req.raw.url}`, protocols, { headers, perMessageDeflate: false });
  const queue: { data: WebSocket.RawData; binary: boolean }[] = [];
  upstream.on('open', () => {
    for (const m of queue) upstream.send(m.data, { binary: m.binary });
    queue.length = 0;
  });
  client.on('message', (data, isBinary) => {
    touch();
    if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
    else if (upstream.readyState === WebSocket.CONNECTING) queue.push({ data, binary: isBinary });
  });
  upstream.on('message', (data, isBinary) => {
    if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
  });
  const closeBoth = (code?: number, reason?: Buffer | string) => {
    const c = code && code >= 1000 && code < 5000 && code !== 1005 && code !== 1006 ? code : 1000;
    try {
      if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) client.close(c, reason ? String(reason).slice(0, 120) : undefined);
    } catch {
      /* closed */
    }
    try {
      if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.close(c);
    } catch {
      /* closed */
    }
  };
  client.on('close', (code, reason) => closeBoth(code, reason));
  upstream.on('close', (code, reason) => closeBoth(code, reason));
  client.on('error', () => closeBoth(1011));
  upstream.on('error', (err) => {
    logger().debug({ err: err.message }, 'App upstream websocket error');
    closeBoth(1011);
  });
}

/** An IPv6 pod address needs brackets in a URL or Host header. */
export const hostPart = (host: string) => (host.includes(':') ? `[${host}]` : host);

export function page(title: string, detail: string, refresh = false): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>${refresh ? '<meta http-equiv="refresh" content="2">' : ''}<style>body{font-family:system-ui,sans-serif;background:#0b0b0e;color:#e4e4e7;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}main{max-width:32rem;text-align:center}h1{font-size:1.1rem;font-weight:600}p{color:#a1a1aa;font-size:.9rem}.dot{display:inline-block;width:.6rem;height:.6rem;border-radius:50%;background:#8b5cf6;animation:pulse 1s infinite alternate}@keyframes pulse{to{opacity:.2}}</style></head><body><main>${refresh ? '<div class="dot"></div>' : ''}<h1>${esc(title)}</h1><p>${esc(detail)}</p></main></body></html>`;
}
