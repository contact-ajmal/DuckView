/**
 * The apps listener: data apps on an origin of their own (apps.isolation, the default). An app's code can run script
 * in the viewer's browser — a Streamlit component, raw HTML — and on the UI's origin that script could read the
 * signed-in session. Here it cannot: the UI keeps its session on its own origin, and this listener serves nothing
 * but the app proxy, authenticated by its own HttpOnly cookie.
 *
 * The browser gets that cookie through a one-time handoff: the UI asks POST /api/apps/:id/session (bearer) for a
 * 60-second, single-use JWT and opens /_duckview/session?app=…&t=… here, which sets the cookie and redirects to the
 * app. A visitor without the cookie is sent to the UI (#/apps/<id>?launch=1), which does the handoff — so links to
 * apps can be shared as they are.
 */
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import jwt from '@fastify/jwt';
import websocket from '@fastify/websocket';
import type { AppContext } from './context.js';
import { registerAppProxy, appCookie, visitor, isNavigation, page, hostPart } from './routes/apps.js';

export async function buildAppsServer(ctx: AppContext): Promise<FastifyInstance> {
  const cfg = ctx.cfg;
  // Apps hold long-lived connections (Streamlit's WebSocket, Gradio's event streams): a shutdown must not wait for them.
  const app = Fastify({ trustProxy: cfg.server.trust_proxy, bodyLimit: cfg.server.body_limit_bytes, forceCloseConnections: true });
  await app.register(jwt, { secret: cfg.security.jwt_secret, sign: { iss: 'duckview' }, verify: { allowedIss: 'duckview' } });
  await app.register(websocket, { options: { maxPayload: cfg.server.body_limit_bytes } });

  const uiBase = (req: FastifyRequest) => (cfg.server.public_url ?? `${req.protocol}://${hostPart(req.hostname)}:${cfg.server.port}`).replace(/\/+$/, '');
  const secure = (req: FastifyRequest) => req.protocol === 'https' || !!cfg.apps.public_url?.startsWith('https://');

  // Handoff tokens are single-use: remembered until they expire.
  const used = new Map<string, number>();
  app.get('/_duckview/session', async (req, reply) => {
    const q = req.query as { app?: string; t?: string };
    const id = String(q.app ?? '');
    if (!/^[A-Za-z0-9-]{1,64}$/.test(id)) return reply.code(400).type('text/html').send(page('Bad link', 'Open the app from DuckView.'));
    // A reload of the same link (an iframe remounting) is fine while the cookie is there.
    if (await visitor(app, ctx, req)) return reply.redirect(`/apps/${id}/`);
    let claims: { purpose?: string; sub?: string; app?: string; jti?: string; exp?: number };
    try {
      claims = app.jwt.verify(String(q.t ?? ''));
    } catch {
      return reply.redirect(`${uiBase(req)}/#/apps/${id}?launch=1`);
    }
    const now = Date.now() / 1000;
    for (const [k, exp] of used) if (exp < now) used.delete(k);
    if (claims.purpose !== 'app-handoff' || claims.app !== id || !claims.sub || !claims.jti || used.has(claims.jti)) return reply.redirect(`${uiBase(req)}/#/apps/${id}?launch=1`);
    used.set(claims.jti, claims.exp ?? now + 60);
    reply.header('set-cookie', appCookie(app, claims.sub, secure(req)));
    reply.header('cache-control', 'no-store');
    reply.header('referrer-policy', 'no-referrer');
    return reply.redirect(`/apps/${id}/`);
  });

  app.get('/healthz', async () => ({ status: 'ok' }));

  await app.register(async (r) =>
    registerAppProxy(r, ctx, {
      signIn: (req: FastifyRequest, reply: FastifyReply, id: string) =>
        isNavigation(req) ? reply.redirect(`${uiBase(req)}/#/apps/${id}?launch=1`) : reply.code(401).type('text/html').send(page('Sign in to DuckView to open this app', 'Open the app from DuckView to sign in.')),
    }),
  );
  app.setNotFoundHandler((_req, reply) => reply.code(404).type('text/plain').send('Not found — this origin serves DuckView data apps only.'));

  app.addHook('onListen', () => {
    const addr = app.server.address();
    if (addr && typeof addr === 'object') ctx.apps.proxyUrl = `http://127.0.0.1:${addr.port}`;
  });
  return app;
}
