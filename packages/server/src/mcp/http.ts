/**
 * Network MCP transports (Fastify plugin):
 *   GET  /mcp/sse        → legacy HTTP+SSE stream (spec 2024-11-05)
 *   POST /mcp/messages   → client→server messages for the SSE session
 *   POST|GET|DELETE /mcp → Streamable HTTP (spec 2025-03-26)
 * All require `Authorization: Bearer <dv_ api token>` (or a UI JWT) with the `mcp` scope.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { AppContext } from '../context.js';
import type { Principal } from '../services/principal.js';
import { buildMcpServer, agentRef } from './server.js';
import { metrics } from '../observability/metrics.js';
import { logger } from '../observability/logger.js';
import { liveEvents } from '../observability/events.js';
import { principalFromBearer } from '../routes/auth-plugin.js';

interface SessionRecord {
  id: string;
  transport: 'sse' | 'streamable-http';
  principal: Principal;
  workspaceId: string | null;
  startedAt: Date;
  lastActivity: Date;
  ip: string;
  close(): Promise<void>;
}

export class McpSessionRegistry {
  private sessions = new Map<string, SessionRecord>();
  add(s: SessionRecord) {
    this.sessions.set(s.id, s);
    metrics.mcpConnections.inc({ transport: s.transport });
    liveEvents.publish({ type: 'mcp_session', at: new Date().toISOString(), user_id: s.principal.userId, user: s.principal.email, action: 'connect', transport: s.transport, session_id: s.id });
  }
  get(id: string) {
    return this.sessions.get(id);
  }
  touch(id: string) {
    const s = this.sessions.get(id);
    if (s) s.lastActivity = new Date();
  }
  remove(id: string) {
    const s = this.sessions.get(id);
    if (s) {
      this.sessions.delete(id);
      metrics.mcpConnections.dec({ transport: s.transport });
      liveEvents.publish({ type: 'mcp_session', at: new Date().toISOString(), user_id: s.principal.userId, user: s.principal.email, action: 'disconnect', transport: s.transport, session_id: s.id });
    }
  }
  list(userId?: string) {
    return [...this.sessions.values()]
      .filter((s) => !userId || s.principal.userId === userId)
      .map((s) => ({ id: s.id, transport: s.transport, user: s.principal.email, user_id: s.principal.userId, token_id: s.principal.tokenId ?? null, workspace_id: s.workspaceId, started_at: s.startedAt.toISOString(), last_activity: s.lastActivity.toISOString(), ip: s.ip }));
  }
  async closeAll() {
    await Promise.allSettled([...this.sessions.values()].map((s) => s.close()));
    this.sessions.clear();
  }
}

async function authenticate(ctx: AppContext, req: FastifyRequest): Promise<Principal | null> {
  const header = req.headers.authorization ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(header);
  const raw = m?.[1]?.trim() ?? (typeof (req.query as Record<string, string>)?.token === 'string' ? (req.query as Record<string, string>).token! : '');
  if (!raw) return null;
  const p = await principalFromBearer(ctx, req.server, raw, req.ip);
  if (!p || !p.scopes.includes('mcp')) return null;
  return p.via === 'jwt' ? { ...p, actorType: 'AGENT' } : p;
}

export async function registerMcpHttp(app: FastifyInstance, ctx: AppContext, registry: McpSessionRegistry) {
  const requirePrincipal = async (req: FastifyRequest, reply: FastifyReply): Promise<Principal | null> => {
    const p = await authenticate(ctx, req);
    if (!p) {
      reply.code(401).header('WWW-Authenticate', 'Bearer realm="duckview-mcp"').send({ error: 'UNAUTHORIZED', message: 'A bearer API token with the mcp scope is required' });
      return null;
    }
    return p;
  };

  const workspaceFor = (req: FastifyRequest, p: Principal) => (typeof (req.query as Record<string, string>)?.workspace_id === 'string' ? (req.query as Record<string, string>).workspace_id! : p.workspaceScope ?? null);

  // ---- Legacy SSE ----
  app.get('/mcp/sse', async (req, reply) => {
    const principal = await requirePrincipal(req, reply);
    if (!principal) return;
    const workspaceId = workspaceFor(req, principal);
    reply.hijack();
    const res = reply.raw;
    res.setHeader('X-Accel-Buffering', 'no');
    const transport = new SSEServerTransport('/mcp/messages', res);
    const server = buildMcpServer(ctx, principal, { defaultWorkspaceId: workspaceId ?? (await ctx.agents.byTokenId(principal.tokenId))?.workspace_id ?? null, agent: await agentRef(ctx, principal) });
    const id = transport.sessionId;
    const heartbeat = setInterval(() => {
      try {
        res.write(`: ping ${Date.now()}\n\n`);
      } catch {
        /* closed */
      }
    }, ctx.cfg.mcp.sse_heartbeat_seconds * 1000);
    registry.add({ id, transport: 'sse', principal, workspaceId, startedAt: new Date(), lastActivity: new Date(), ip: req.ip, close: async () => transport.close() });
    ctx.audit.log({ userId: principal.userId, actorType: 'AGENT', action: 'mcp.connect', resource: 'transport:sse', ip: req.ip });
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearInterval(heartbeat);
      registry.remove(id);
      ctx.audit.log({ userId: principal.userId, actorType: 'AGENT', action: 'mcp.disconnect', resource: 'transport:sse', ip: req.ip });
      // server.close() re-enters transport.close() → onclose; the flag above makes that a no-op.
      server.close().catch(() => undefined);
    };
    transport.onclose = cleanup;
    res.on('close', cleanup);
    (app as unknown as { sseTransports: Map<string, SSEServerTransport> }).sseTransports.set(id, transport);
    res.on('close', () => (app as unknown as { sseTransports: Map<string, SSEServerTransport> }).sseTransports.delete(id));
    await server.connect(transport);
  });

  (app as unknown as { sseTransports: Map<string, SSEServerTransport> }).sseTransports = new Map();

  app.post('/mcp/messages', async (req, reply) => {
    const principal = await requirePrincipal(req, reply);
    if (!principal) return;
    const sessionId = String((req.query as Record<string, string>)?.sessionId ?? '');
    const session = registry.get(sessionId);
    const transport = (app as unknown as { sseTransports: Map<string, SSEServerTransport> }).sseTransports.get(sessionId);
    if (!session || !transport) return reply.code(404).send({ error: 'NOT_FOUND', message: 'Unknown MCP session' });
    if (session.principal.userId !== principal.userId) return reply.code(403).send({ error: 'FORBIDDEN', message: 'Session belongs to another principal' });
    registry.touch(sessionId);
    reply.hijack();
    await transport.handlePostMessage(req.raw, reply.raw, req.body);
  });

  // ---- Streamable HTTP ----
  const streamable = new Map<string, StreamableHTTPServerTransport>();
  const handleStreamable = async (req: FastifyRequest, reply: FastifyReply) => {
    const principal = await requirePrincipal(req, reply);
    if (!principal) return;
    const sessionHeader = req.headers['mcp-session-id'];
    const sessionId = Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader;
    let transport = sessionId ? streamable.get(sessionId) : undefined;
    if (transport) {
      const s = registry.get(sessionId!);
      if (s && s.principal.userId !== principal.userId) return reply.code(403).send({ error: 'FORBIDDEN', message: 'Session belongs to another principal' });
      registry.touch(sessionId!);
    } else {
      if (req.method !== 'POST') return reply.code(400).send({ error: 'BAD_REQUEST', message: 'No active MCP session; initialise with a POST first' });
      const workspaceId = workspaceFor(req, principal);
      const t = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          streamable.set(id, t);
          registry.add({ id, transport: 'streamable-http', principal, workspaceId, startedAt: new Date(), lastActivity: new Date(), ip: req.ip, close: async () => t.close() });
          ctx.audit.log({ userId: principal.userId, actorType: 'AGENT', action: 'mcp.connect', resource: 'transport:streamable-http', ip: req.ip });
        },
        onsessionclosed: (id) => {
          streamable.delete(id);
          registry.remove(id);
          ctx.audit.log({ userId: principal.userId, actorType: 'AGENT', action: 'mcp.disconnect', resource: 'transport:streamable-http', ip: req.ip });
        },
      });
      const server = buildMcpServer(ctx, principal, { defaultWorkspaceId: workspaceId ?? (await ctx.agents.byTokenId(principal.tokenId))?.workspace_id ?? null, agent: await agentRef(ctx, principal) });
      let closed = false;
      t.onclose = () => {
        if (closed) return;
        closed = true;
        if (t.sessionId) {
          streamable.delete(t.sessionId);
          registry.remove(t.sessionId);
        }
        server.close().catch(() => undefined);
      };
      await server.connect(t);
      transport = t;
    }
    reply.hijack();
    try {
      await transport.handleRequest(req.raw, reply.raw, req.body);
    } catch (err) {
      logger().error({ err }, 'MCP streamable transport error');
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { 'content-type': 'application/json' });
        reply.raw.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null }));
      }
    }
  };
  app.post('/mcp', handleStreamable);
  app.get('/mcp', handleStreamable);
  app.delete('/mcp', handleStreamable);

  app.addHook('onClose', async () => {
    await registry.closeAll();
  });
}
