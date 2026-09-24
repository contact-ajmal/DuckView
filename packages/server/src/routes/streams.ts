/**
 * Streams: Kafka, Kinesis, HTTP pushes and Postgres change data capture, into workspace tables.
 *   GET/POST /api/workspaces/:id/streams                list · create (editors; an HTTP stream's push key is returned once)
 *   GET/PATCH/DELETE /api/streams/:id                   one stream with its latest rows · edit (restarts it) · delete
 *   POST /api/streams/test {config, sasl_password?, stream_id?}   can DuckView reach the topic / stream?
 *   POST /api/streams/:id/rotate-key                    a new push key for an HTTP stream
 *   POST /api/streams/:id/push                          push events: a JSON array or object, or NDJSON; the key as
 *                                                        "Authorization: Bearer dvs_…" or "x-duckview-key" (no login)
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';

const Config = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('kafka'), brokers: z.array(z.string().max(300)).min(1).max(20), topic: z.string().min(1).max(250), group_id: z.string().max(250).nullable().optional(), from_beginning: z.boolean().optional(), ssl: z.boolean().optional(), sasl_mechanism: z.enum(['plain', 'scram-sha-256', 'scram-sha-512']).nullable().optional(), sasl_username: z.string().max(300).nullable().optional() }),
  z.object({ kind: z.literal('kinesis'), stream: z.string().min(1).max(128), region: z.string().min(1).max(40), cloud_connection_id: z.string().max(64).nullable().optional(), endpoint: z.string().max(500).nullable().optional(), start: z.enum(['LATEST', 'TRIM_HORIZON']).optional() }),
  z.object({ kind: z.literal('http') }),
  z.object({ kind: z.literal('postgres'), connection_id: z.string().max(64), table: z.string().min(1).max(200), snapshot: z.boolean().optional() }),
]);
const Body = z.object({
  name: z.string().max(120).optional(),
  config: Config,
  sasl_password: z.string().max(1000).nullable().optional(),
  format: z.enum(['json', 'text', 'debezium']).optional(),
  mode: z.enum(['append', 'mirror']).optional(),
  key_columns: z.array(z.string().max(63)).max(10).optional(),
  keep_history: z.boolean().optional(),
  target_schema: z.string().max(63).optional(),
  target_table: z.string().max(63),
  include_metadata: z.boolean().optional(),
  batch_rows: z.number().int().min(1).optional(),
  batch_seconds: z.number().int().min(1).max(300).optional(),
  enabled: z.boolean().optional(),
});

const qi = (s: string) => `"${s.replace(/"/g, '""')}"`;

export async function streamRoutes(app: FastifyInstance, ctx: AppContext) {
  app.addHook('preHandler', app.authenticate);

  app.get('/api/workspaces/:id/streams', async (req) => ({ streams: await ctx.streams.list(req.principal!, (req.params as { id: string }).id) }));
  app.post('/api/workspaces/:id/streams', async (req) => ctx.streams.create(req.principal!, (req.params as { id: string }).id, Body.parse(req.body ?? {}) as never));
  app.post('/api/streams/test', async (req) => {
    const body = z.object({ config: Config, sasl_password: z.string().max(1000).nullable().optional(), stream_id: z.string().max(64).nullable().optional() }).parse(req.body ?? {});
    return ctx.streams.test(req.principal!, body as never);
  });

  app.get('/api/streams/:id', async (req) => {
    const s = await ctx.streams.get(req.principal!, (req.params as { id: string }).id);
    // The latest rows, read as the person asking (their access policies apply).
    let latest: { columns: { name: string; type: string }[]; rows: unknown[][] } | null = null;
    try {
      const r = await ctx.queries.run(req.principal!, s.workspace_id, `SELECT * FROM ${qi(s.target_schema)}.${qi(s.target_table)}${s.include_metadata ? ' ORDER BY _ingested_at DESC' : ''} LIMIT 20`, { cache: false, countTotal: false, maxRows: 20 });
      latest = { columns: r.columns.map((c) => ({ name: c.name, type: c.type })), rows: r.rows };
    } catch {
      latest = null;
    }
    return { stream: ctx.streams.toPublic(s), consuming: ctx.streams.isRunning(s.id), latest };
  });
  app.patch('/api/streams/:id', async (req) => ({ stream: await ctx.streams.update(req.principal!, (req.params as { id: string }).id, Body.partial().parse(req.body ?? {}) as never) }));
  app.delete('/api/streams/:id', async (req) => {
    await ctx.streams.remove(req.principal!, (req.params as { id: string }).id);
    return { ok: true };
  });
  app.post('/api/streams/:id/rotate-key', async (req) => ({ push_key: await ctx.streams.rotateKey(req.principal!, (req.params as { id: string }).id) }));
}

/** Pushes authenticate with the stream's key, not a session; NDJSON and text bodies are read as strings. */
export async function streamPushRoutes(app: FastifyInstance, ctx: AppContext) {
  const bodyLimit = ctx.cfg.streams.max_push_mb * 1024 * 1024;
  app.removeContentTypeParser('text/plain');
  app.addContentTypeParser(['text/plain', 'application/x-ndjson', 'application/jsonl'], { parseAs: 'string', bodyLimit }, (_req, body, done) => done(null, body));
  const keyOf = (req: FastifyRequest) => {
    const h = req.headers.authorization;
    if (h?.startsWith('Bearer ')) return h.slice(7).trim();
    const k = req.headers['x-duckview-key'];
    return typeof k === 'string' ? k.trim() : null;
  };
  app.post('/api/streams/:id/push', { bodyLimit }, async (req, reply) => {
    const r = await ctx.streams.push((req.params as { id: string }).id, keyOf(req), req.body);
    return reply.code(202).send({ accepted: r.rows });
  });
}
