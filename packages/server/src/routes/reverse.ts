/**
 * Reverse ETL: query results sent out of a workspace to a database table, files or an HTTP API.
 *   GET/POST /api/workspaces/:id/reverse-syncs          list (members) · create (editors)
 *   GET/PATCH/DELETE /api/reverse-syncs/:id             one sync (headers never returned) · edit · delete
 *   GET  /api/reverse-syncs/:id/plan                     what the next run would send, without sending it
 *   POST /api/reverse-syncs/:id/run {dry_run?}           run now (editors); agent tokens get 409 APPROVAL_REQUIRED until dry_run: false
 *   GET  /api/reverse-syncs/:id/runs
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { REVERSE_MODES } from '../db/schema/sqlite.js';

const Schedule = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('manual') }),
  z.object({ kind: z.literal('interval'), minutes: z.number().int().min(5).max(60 * 24 * 7) }),
  z.object({ kind: z.literal('cron'), expression: z.string().min(1).max(120), timezone: z.string().max(64).optional() }),
]);
const Destination = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('database'), connection_id: z.string().max(64), schema: z.string().max(128).nullable().optional(), table: z.string().min(1).max(128) }),
  z.object({ kind: z.literal('file'), format: z.enum(['parquet', 'csv', 'json']), path: z.string().min(1).max(1024), cloud_connection_id: z.string().max(64).nullable().optional(), bucket: z.string().max(255).nullable().optional() }),
  z.object({ kind: z.literal('http'), url: z.string().min(1).max(2048), batch_size: z.number().int().min(1).max(10_000).optional(), payload: z.enum(['array', 'object', 'ndjson']).optional() }),
]);
const Body = z.object({
  name: z.string().min(1).max(120),
  sql: z.string().min(1).max(100_000),
  destination: Destination,
  mode: z.enum(REVERSE_MODES).optional(),
  key_columns: z.array(z.string().min(1).max(128)).max(10).optional(),
  headers: z.record(z.string(), z.string()).nullable().optional(),
  schedule: Schedule.optional(),
  channel_ids: z.array(z.string().max(64)).max(20).optional(),
  enabled: z.boolean().optional(),
});

export async function reverseRoutes(app: FastifyInstance, ctx: AppContext) {
  app.addHook('preHandler', app.authenticate);

  app.get('/api/workspaces/:id/reverse-syncs', async (req) => ({ syncs: await ctx.reverse.list(req.principal!, (req.params as { id: string }).id) }));
  app.post('/api/workspaces/:id/reverse-syncs', async (req) => ({ sync: await ctx.reverse.create(req.principal!, (req.params as { id: string }).id, Body.parse(req.body ?? {})) }));
  app.get('/api/reverse-syncs/:id', async (req) => ({ sync: await ctx.reverse.get(req.principal!, (req.params as { id: string }).id) }));
  app.patch('/api/reverse-syncs/:id', async (req) => ({ sync: await ctx.reverse.update(req.principal!, (req.params as { id: string }).id, Body.partial().parse(req.body ?? {})) }));
  app.delete('/api/reverse-syncs/:id', async (req) => {
    await ctx.reverse.remove(req.principal!, (req.params as { id: string }).id);
    return { ok: true };
  });
  app.get('/api/reverse-syncs/:id/plan', async (req) => ({ plan: await ctx.reverse.plan(req.principal!, (req.params as { id: string }).id) }));
  app.post('/api/reverse-syncs/:id/run', async (req) => {
    const body = z.object({ dry_run: z.boolean().optional() }).parse(req.body ?? {});
    const p = req.principal!;
    return { run: await ctx.reverse.run((req.params as { id: string }).id, p.actorType === 'AGENT' ? 'agent' : 'manual', p, { approved: body.dry_run === false }) };
  });
  app.get('/api/reverse-syncs/:id/runs', async (req) => {
    const q = z.object({ limit: z.coerce.number().int().min(1).max(200).optional() }).parse(req.query ?? {});
    return { runs: await ctx.reverse.runs(req.principal!, (req.params as { id: string }).id, q.limit) };
  });
}
