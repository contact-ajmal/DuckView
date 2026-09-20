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
import { APP_VISIBILITIES } from '../db/schema/sqlite.js';
import type { Principal } from '../services/principal.js';
import { logger } from '../observability/logger.js';

const COOKIE = 'dv_app';
const Files = z.record(z.string().max(200), z.string().max(2_000_000));
const AppBody = z.object({ name: z.string().max(120), description: z.string().max(2000).nullable().optional(), files: Files.optional(), entry: z.string().max(200).optional(), spec: z.record(z.string(), z.unknown()).nullable().optional(), visibility: z.enum(APP_VISIBILITIES).optional() });
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

  /** The visitor behind a proxied request, from the /apps cookie. */
  async function visitor(req: FastifyRequest): Promise<Principal | null> {
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

  // ---------------------------------------------------------------- registry API (bearer)
  await app.register(async (r) => {
    r.addHook('preHandler', app.authenticate);
    r.get('/api/apps/templates', async () => ({ templates: ctx.apps.templates(), enabled: ctx.apps.enabled, runtime: ctx.cfg.apps.runtime }));
    r.get('/api/apps', async (req) => ({ apps: await ctx.apps.listAll(req.principal!), enabled: ctx.apps.enabled }));
    r.get('/api/workspaces/:id/apps', async (req) => {
      const { id } = req.params as { id: string };
      return { apps: await ctx.apps.list(req.principal!, id), enabled: ctx.apps.enabled };
    });
    r.post('/api/workspaces/:id/apps', async (req) => {
      const { id } = req.params as { id: string };
      const body = AppBody.parse(req.body ?? {});
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
      const token = app.jwt.sign({ purpose: 'app', sub: p.userId }, { expiresIn: '12h' });
      reply.header('set-cookie', `${COOKIE}=${encodeURIComponent(token)}; Path=/apps; HttpOnly; SameSite=Lax; Max-Age=43200${secure ? '; Secure' : ''}`);
      return { url: `/apps/${id}/` };
    });
  });

  // ---------------------------------------------------------------- proxy (cookie)
  await app.register(async (r) => {
    // Bodies pass through untouched (Streamlit uploads are multipart; its API is JSON/protobuf).
    r.removeAllContentTypeParsers();
    r.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

    const deny = (reply: FastifyReply, status: number, message: string) => reply.code(status).type('text/html').send(page(message, status === 401 ? 'Open the app from DuckView to sign in.' : ''));

    r.get('/apps/:id', async (req, reply) => reply.redirect(`/apps/${(req.params as { id: string }).id}/`));

    r.route({
      method: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD'],
      url: '/apps/:id/*',
      handler: async (req, reply) => {
        const { id } = req.params as { id: string };
        const p = await visitor(req);
        if (!p) return deny(reply, 401, 'Sign in to DuckView to open this app');
        let a;
        try {
          a = await ctx.apps.get(p, id);
        } catch {
          return deny(reply, 404, 'No such app, or you are not a member of its workspace');
        }
        if (!ctx.apps.enabled) return deny(reply, 503, 'Data apps are disabled on this server');
        const target = ctx.apps.target(id);
        if (!target) {
          // Not up: start it (once) and let the browser retry.
          const st = ctx.apps.status(id);
          if (!st) void ctx.apps.start(p, id).catch((err) => logger().warn({ app: id, err: (err as Error).message }, 'App auto-start failed'));
          const fresh = await ctx.apps.get(p, id).catch(() => a);
          const failed = fresh.status === 'error' && !st;
          return reply.code(failed ? 500 : 503).header('retry-after', '2').type('text/html').send(page(failed ? `${a.name} failed to start` : `Starting ${a.name}…`, failed ? fresh.last_error ?? 'See the app log in DuckView.' : 'Installing or booting the app; this page refreshes by itself.', !failed));
        }
        ctx.apps.touch(id);
        const role = (await ctx.workspaces.get(p, a.workspace_id).catch(() => null))?.role ?? 'VIEWER';
        return proxy(req, reply, target.port, p, role);
      },
    });

    r.get('/apps/:id/_stcore/stream', { websocket: true }, (socket, req) => {
      const { id } = req.params as { id: string };
      void (async () => {
        const p = await visitor(req);
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
        bridge(socket, req, target.port, p, role, () => ctx.apps.touch(id));
      })().catch((err) => {
        logger().warn({ err: (err as Error).message }, 'App websocket failed');
        try {
          socket.close(1011);
        } catch {
          /* closed */
        }
      });
    });
  });
}

/** Forwards one HTTP request to the app's Streamlit server, streaming the answer straight to the socket. */
function proxy(req: FastifyRequest, reply: FastifyReply, port: number, p: Principal, role: string): Promise<void> {
  return new Promise((resolve) => {
    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && !HOP.has(k.toLowerCase())) headers[k] = v;
    headers.host = `127.0.0.1:${port}`;
    headers['x-duckview-user'] = p.userId;
    headers['x-duckview-email'] = p.email;
    headers['x-duckview-role'] = role;
    headers['x-forwarded-proto'] = req.protocol;
    headers['x-forwarded-for'] = req.ip;
    reply.hijack();
    const raw = reply.raw;
    const upstream = http.request({ host: '127.0.0.1', port, method: req.method, path: req.raw.url, headers }, (res) => {
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
function bridge(client: WebSocket, req: FastifyRequest, port: number, p: Principal, role: string, touch: () => void): void {
  const protocols = String(req.headers['sec-websocket-protocol'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const headers: Record<string, string> = { 'x-duckview-user': p.userId, 'x-duckview-email': p.email, 'x-duckview-role': role, 'x-forwarded-for': req.ip };
  for (const k of ['user-agent', 'accept-language', 'origin']) if (req.headers[k]) headers[k] = String(req.headers[k]);
  const upstream = new WebSocket(`ws://127.0.0.1:${port}${req.raw.url}`, protocols, { headers, perMessageDeflate: false });
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

function page(title: string, detail: string, refresh = false): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>${refresh ? '<meta http-equiv="refresh" content="2">' : ''}<style>body{font-family:system-ui,sans-serif;background:#0b0b0e;color:#e4e4e7;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}main{max-width:32rem;text-align:center}h1{font-size:1.1rem;font-weight:600}p{color:#a1a1aa;font-size:.9rem}.dot{display:inline-block;width:.6rem;height:.6rem;border-radius:50%;background:#8b5cf6;animation:pulse 1s infinite alternate}@keyframes pulse{to{opacity:.2}}</style></head><body><main>${refresh ? '<div class="dot"></div>' : ''}<h1>${esc(title)}</h1><p>${esc(detail)}</p></main></body></html>`;
}
