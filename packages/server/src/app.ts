import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify, { LogController, type FastifyInstance, type FastifyBaseLogger } from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import multipart from '@fastify/multipart';
import type { AppContext } from './context.js';
import authPlugin from './routes/auth-plugin.js';
import { authRoutes } from './routes/auth.js';
import { workspaceRoutes } from './routes/workspaces.js';
import { queryRoutes, serializeError } from './routes/query.js';
import { connectionRoutes } from './routes/connections.js';
import { tokenRoutes } from './routes/tokens.js';
import { adminRoutes } from './routes/admin.js';
import { systemRoutes } from './routes/system.js';
import { fileRoutes } from './routes/files.js';
import { eventRoutes } from './routes/events.js';
import { storageRoutes } from './routes/storage.js';
import { exportRoutes } from './routes/exports.js';
import { biRoutes } from './routes/bi.js';
import { copilotRoutes } from './routes/copilot.js';
import { lakehouseRoutes } from './routes/lakehouse.js';
import { agentRoutes } from './routes/agent.js';
import { registerMcpHttp, McpSessionRegistry } from './mcp/http.js';
import { logger } from './observability/logger.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export function findWebDist(): string | null {
  const candidates = [process.env.DUCKVIEW_WEB_DIST, path.resolve(here, '../../web/dist'), path.resolve(here, '../web'), '/app/packages/web/dist'].filter((p): p is string => !!p);
  for (const c of candidates) if (fs.existsSync(path.join(c, 'index.html'))) return c;
  return null;
}

export async function buildApp(ctx: AppContext): Promise<{ app: FastifyInstance; mcpSessions: McpSessionRegistry }> {
  const { cfg } = ctx;
  const app = Fastify({
    loggerInstance: logger().child({ component: 'http' }) as unknown as FastifyBaseLogger,
    trustProxy: cfg.server.trust_proxy,
    bodyLimit: cfg.server.body_limit_bytes,
    logController: new LogController({ disableRequestLogging: cfg.server.log_level !== 'debug' && cfg.server.log_level !== 'trace' }),
    requestIdHeader: 'x-request-id',
  });

  await app.register(cors, {
    origin: cfg.server.cors_origins.length ? cfg.server.cors_origins : true,
    credentials: true,
    exposedHeaders: ['mcp-session-id', 'x-request-id'],
    allowedHeaders: ['authorization', 'content-type', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id'],
  });
  await app.register(jwt, { secret: cfg.security.jwt_secret, sign: { iss: 'duckview' }, verify: { allowedIss: 'duckview' } });
  await app.register(rateLimit, {
    global: true,
    max: cfg.server.rate_limit_per_minute,
    timeWindow: '1 minute',
    allowList: (req) => req.url === '/healthz' || req.url === '/readyz' || req.url === '/metrics' || req.url.startsWith('/mcp'),
  });
  await app.register(websocket, { options: { maxPayload: cfg.server.body_limit_bytes } });
  await app.register(multipart, { limits: { fileSize: cfg.security.max_upload_bytes, files: 20 } });
  await app.register(authPlugin, { ctx });

  // Tolerate empty JSON bodies (e.g. `curl -X DELETE -H 'content-type: application/json'`).
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const text = typeof body === 'string' ? body : body.toString();
    if (!text.trim()) return done(null, undefined);
    try {
      done(null, JSON.parse(text));
    } catch (err) {
      const e = err as Error & { statusCode?: number };
      e.statusCode = 400;
      done(e, undefined);
    }
  });

  // Security headers
  app.addHook('onSend', async (_req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'same-origin');
    if (process.env.NODE_ENV === 'production') reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  });

  app.setErrorHandler((err, req, reply) => {
    const ser = serializeError(err);
    if (ser.status >= 500) req.log.error({ err, reqId: req.id }, 'Unhandled error');
    else req.log.debug({ code: ser.code, message: ser.message }, 'Request error');
    const rl = (err as { statusCode?: number }).statusCode === 429;
    reply.code(rl ? 429 : ser.status).send({ error: rl ? 'RATE_LIMITED' : ser.code, message: ser.message, ...(ser.challenge ? { challenge: ser.challenge } : {}), ...(ser.details ? { details: ser.details } : {}), request_id: req.id });
  });

  const mcpSessions = new McpSessionRegistry();

  await app.register(async (r) => systemRoutes(r, ctx));
  await app.register(async (r) => authRoutes(r, ctx));
  await app.register(async (r) => workspaceRoutes(r, ctx));
  await app.register(async (r) => queryRoutes(r, ctx));
  await app.register(async (r) => connectionRoutes(r, ctx));
  await app.register(async (r) => tokenRoutes(r, ctx, mcpSessions));
  await app.register(async (r) => adminRoutes(r, ctx));
  await app.register(async (r) => fileRoutes(r, ctx));
  await app.register(async (r) => eventRoutes(r, ctx));
  await app.register(async (r) => storageRoutes(r, ctx));
  await app.register(async (r) => exportRoutes(r, ctx));
  await app.register(async (r) => biRoutes(r, ctx));
  await app.register(async (r) => copilotRoutes(r, ctx));
  await app.register(async (r) => lakehouseRoutes(r, ctx));
  await app.register(async (r) => agentRoutes(r, ctx));
  await app.register(async (r) => registerMcpHttp(r, ctx, mcpSessions));

  // Static SPA (built web bundle), with history fallback for non-API GETs.
  const webDist = findWebDist();
  if (webDist) {
    await app.register(fastifyStatic, { root: webDist, prefix: '/', wildcard: false, index: ['index.html'], maxAge: '1h', immutable: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api') && !req.url.startsWith('/mcp') && req.headers.accept?.includes('text/html')) {
        return reply.type('text/html').send(fs.createReadStream(path.join(webDist, 'index.html')));
      }
      return reply.code(404).send({ error: 'NOT_FOUND', message: `Route ${req.method} ${req.url} not found` });
    });
    logger().info({ webDist }, 'Serving web UI');
  } else {
    app.setNotFoundHandler((req, reply) => reply.code(404).send({ error: 'NOT_FOUND', message: `Route ${req.method} ${req.url} not found (web UI not built — run "pnpm build")` }));
  }

  return { app, mcpSessions };
}
