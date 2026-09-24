/**
 * Cluster mode. Node-to-node (the shared secret in x-duckview-cluster; anything else is a 404):
 *   POST /internal/cluster/engine {workspace_id, method, args}   run an engine method on a workspace this node holds
 *   POST /internal/cluster/stream {workspace_id, sql, opts}      a streamed query, as newline-delimited JSON
 *   POST /internal/cluster/events {events}                       live events from another node
 *   POST /internal/cluster/evict {workspace_id}                  close a workspace's engine (its settings changed)
 *   POST /internal/cluster/streams/stop {stream_id, to}          stop a stream consumer and hand its lease to `to`
 * Administrators:
 *   GET  /api/admin/cluster                                      nodes, their heartbeats and what each holds
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { CLUSTER_HEADER } from '../services/cluster.js';
import { REMOTE_METHODS, errorJson } from '../engine/remote.js';
import { requireAdmin } from '../services/principal.js';
import type { LiveEvent } from '../observability/events.js';

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? (Number.isSafeInteger(Number(x)) ? Number(x) : x.toString()) : x));

export async function clusterInternalRoutes(app: FastifyInstance, ctx: AppContext) {
  // Only nodes of this cluster: without the secret these routes do not exist.
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!ctx.cluster.authorized(req.headers[CLUSTER_HEADER])) return reply.code(404).send({ error: 'NOT_FOUND', message: `Route ${req.method} ${req.url} not found` });
  });

  /** An abort signal that fires when the calling node goes away mid-query. */
  const abortOnClose = (req: FastifyRequest) => {
    const c = new AbortController();
    req.raw.on('close', () => {
      if (!req.raw.complete || req.raw.destroyed) c.abort();
    });
    req.socket.on('close', () => c.abort());
    return c.signal;
  };

  app.post('/internal/cluster/engine', async (req, reply) => {
    const body = z.object({ workspace_id: z.string().max(64), method: z.string().max(40), args: z.array(z.unknown()).max(8) }).parse(req.body ?? {});
    let payload: unknown;
    try {
      if (!REMOTE_METHODS.has(body.method)) throw new Error(`Engine method ${body.method} cannot be called remotely`);
      const engine = await ctx.workspaces.localEngine(body.workspace_id);
      const args = [...body.args];
      if (body.method === 'execute') args[1] = { ...((args[1] as object) ?? {}), signal: abortOnClose(req) };
      if (body.method === 'exportTo') args[3] = { ...((args[3] as object) ?? {}), signal: abortOnClose(req) };
      const fn = (engine as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[body.method]!;
      payload = { result: await fn.apply(engine, args) };
    } catch (err) {
      payload = { error: errorJson(err) };
    }
    return reply.type('application/json').send(json(payload));
  });

  app.post('/internal/cluster/stream', async (req, reply) => {
    const body = z.object({ workspace_id: z.string().max(64), sql: z.string().max(1_000_000), opts: z.record(z.string(), z.unknown()).optional() }).parse(req.body ?? {});
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, { 'content-type': 'application/x-ndjson' });
    const write = (v: unknown) => raw.write(`${json(v)}\n`);
    try {
      const engine = await ctx.workspaces.localEngine(body.workspace_id);
      const done = await engine.stream(body.sql, { onSchema: (schema) => void write({ schema }), onRows: (rows) => void write({ rows }) }, { ...(body.opts ?? {}), signal: abortOnClose(req) } as never);
      write({ done });
    } catch (err) {
      write({ error: errorJson(err) });
    }
    raw.end();
    return reply;
  });

  app.post('/internal/cluster/events', async (req) => {
    const body = z.object({ from: z.string().max(80), events: z.array(z.record(z.string(), z.unknown())).max(10_000) }).parse(req.body ?? {});
    ctx.cluster.receive(body.events as unknown as LiveEvent[]);
    return { ok: true };
  });

  app.post('/internal/cluster/streams/stop', async (req) => {
    const body = z.object({ stream_id: z.string().max(64), to: z.string().max(80) }).parse(req.body ?? {});
    await ctx.streams.stopLocal(body.stream_id, body.to);
    return { ok: true };
  });

  app.post('/internal/cluster/evict', async (req) => {
    const body = z.object({ workspace_id: z.string().max(64) }).parse(req.body ?? {});
    ctx.engines.evict(body.workspace_id);
    return { ok: true };
  });
}

export async function clusterAdminRoutes(app: FastifyInstance, ctx: AppContext) {
  app.addHook('preHandler', app.authenticate);
  app.get('/api/admin/cluster', async (req) => {
    requireAdmin(req.principal!);
    return ctx.cluster.status();
  });
}
