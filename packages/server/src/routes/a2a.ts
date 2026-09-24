/**
 * Agent2Agent (A2A).
 *   GET  /.well-known/agent-card.json (and agent.json)          DuckView's Agent Card (public)
 *   GET  /a2a/agents/:id/.well-known/agent-card.json            a published agent's card (public)
 *   POST /a2a · POST /a2a/agents/:id                            JSON-RPC 2.0 with a DuckView API token (Bearer):
 *        message/send, message/stream (SSE), tasks/get, tasks/cancel, agent/getAuthenticatedExtendedCard
 *   GET  /api/a2a                                               for the UI: DuckView's card URL and your reachable agents
 *   GET/POST /api/a2a/remotes {url, headers?, name?}            remote agents you registered · add one by its card
 *   POST /api/a2a/remotes/:id/refresh · DELETE /api/a2a/remotes/:id
 *   POST /api/a2a/remotes/:id/ask {message, context_id?}        ask a remote agent and wait for its answer
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { RPC, RpcError } from '../services/a2a.js';
import { HttpError } from '../services/errors.js';

const baseOf = (ctx: AppContext, req: FastifyRequest) => ctx.cfg.server.public_url?.replace(/\/+$/, '') ?? `${req.protocol}://${req.headers.host}`;

export async function a2aPublicRoutes(app: FastifyInstance, ctx: AppContext) {
  const serverCard = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!ctx.cfg.a2a.enabled) return reply.code(404).send({ error: 'NOT_FOUND', message: 'A2A is turned off' });
    return ctx.a2a.serverCard(baseOf(ctx, req));
  };
  app.get('/.well-known/agent-card.json', serverCard);
  app.get('/.well-known/agent.json', serverCard);
  const agentCard = async (req: FastifyRequest) => ctx.a2a.agentCard(baseOf(ctx, req), await ctx.a2a.publishedAgent((req.params as { id: string }).id));
  app.get('/a2a/agents/:id/.well-known/agent-card.json', agentCard);
  app.get('/a2a/agents/:id/.well-known/agent.json', agentCard);
  app.get('/a2a/agents/:id/agent-card.json', agentCard);

  // JSON-RPC: the token is checked here so a missing one is a 401 with a Bearer challenge, as A2A clients expect.
  const rpc = async (req: FastifyRequest, reply: FastifyReply) => {
    const agentId = (req.params as { id?: string }).id ?? null;
    const body = (req.body ?? {}) as { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };
    const id = body.id ?? null;
    const fail = (code: number, message: string, data?: unknown) => reply.send({ jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } });
    if (!req.principal) return reply.code(401).header('www-authenticate', 'Bearer realm="duckview"').send({ jsonrpc: '2.0', id, error: { code: RPC.invalidRequest, message: 'Authentication required: a DuckView API token as Bearer' } });
    if (body.jsonrpc !== '2.0' || typeof body.method !== 'string') return fail(RPC.invalidRequest, 'A JSON-RPC 2.0 request with a method is required');
    const base = baseOf(ctx, req);
    const params = body.params && typeof body.params === 'object' ? body.params : {};
    const asError = (err: unknown) => (err instanceof RpcError ? { code: err.code, message: err.message } : err instanceof HttpError ? { code: err.statusCode === 404 ? RPC.invalidParams : err.statusCode === 403 ? RPC.invalidRequest : RPC.internal, message: err.message } : { code: RPC.internal, message: (err as Error).message ?? String(err) });
    if (body.method === 'message/stream') {
      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      const send = (payload: unknown) => raw.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id, ...(payload as object) })}\n\n`);
      try {
        await ctx.a2a.handle(req.principal, base, agentId, body.method, params, (result) => send({ result }));
      } catch (err) {
        send({ error: asError(err) });
      }
      raw.end();
      return reply;
    }
    try {
      return reply.send({ jsonrpc: '2.0', id, result: await ctx.a2a.handle(req.principal, base, agentId, body.method, params) });
    } catch (err) {
      const e = asError(err);
      return fail(e.code, e.message);
    }
  };
  app.post('/a2a', { preHandler: app.optionalAuth }, rpc);
  app.post('/a2a/agents/:id', { preHandler: app.optionalAuth }, rpc);
}

export async function a2aRoutes(app: FastifyInstance, ctx: AppContext) {
  app.addHook('preHandler', app.authenticate);

  app.get('/api/a2a', async (req) => {
    const base = baseOf(ctx, req);
    const agents = await ctx.a2a.reachable(req.principal!);
    return { enabled: ctx.cfg.a2a.enabled, card_url: `${base}/.well-known/agent-card.json`, endpoint: `${base}/a2a`, agents: agents.map((a) => ({ id: a.id, name: a.name, workspace_id: a.workspace_id, card_url: `${base}/a2a/agents/${a.id}/.well-known/agent-card.json`, endpoint: `${base}/a2a/agents/${a.id}` })) };
  });
  app.get('/api/a2a/remotes', async (req) => ({ remotes: await ctx.a2a.listRemotes(req.principal!) }));
  app.post('/api/a2a/remotes', async (req) => {
    const body = z.object({ url: z.string().min(1).max(2048), headers: z.record(z.string().max(200), z.string().max(4000)).nullable().optional(), name: z.string().max(120).nullable().optional() }).parse(req.body ?? {});
    return { remote: await ctx.a2a.addRemote(req.principal!, body) };
  });
  app.post('/api/a2a/remotes/:id/refresh', async (req) => ({ remote: await ctx.a2a.refreshRemote(req.principal!, (req.params as { id: string }).id) }));
  app.delete('/api/a2a/remotes/:id', async (req) => {
    await ctx.a2a.removeRemote(req.principal!, (req.params as { id: string }).id);
    return { ok: true };
  });
  app.post('/api/a2a/remotes/:id/ask', async (req) => {
    const body = z.object({ message: z.string().min(1).max(20_000), context_id: z.string().max(200).nullable().optional() }).parse(req.body ?? {});
    return ctx.a2a.ask(req.principal!, (req.params as { id: string }).id, body.message, { contextId: body.context_id });
  });
}
