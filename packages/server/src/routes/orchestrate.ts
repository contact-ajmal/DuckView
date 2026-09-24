/**
 * Orchestration (Airflow, Dagster, Prefect, cron, CI):
 *   POST /api/orchestrate/runs {kind, id, …, wait?}        start a run (write scope); wait: true answers when it is done
 *   GET  /api/orchestrate/runs/:id?wait=30                 its status: running | succeeded | failed (long-polls up to 60 s)
 *   GET  /api/orchestrate/runs                             your recent runs
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { ORCHESTRATION_KINDS } from '../db/schema/sqlite.js';

const Body = z.object({
  kind: z.enum(ORCHESTRATION_KINDS),
  id: z.string().min(1).max(64),
  command: z.enum(['build', 'run', 'test', 'seed', 'compile']).nullable().optional(),
  select: z.string().max(2000).nullable().optional(),
  exclude: z.string().max(2000).nullable().optional(),
  full_refresh: z.boolean().optional(),
  sql: z.string().max(100_000).nullable().optional(),
  fail_if: z.enum(['rows', 'no_rows']).nullable().optional(),
  input: z.string().max(8000).nullable().optional(),
  fail_on_warn: z.boolean().optional(),
  fail_on_trigger: z.boolean().optional(),
  fail_on_anomaly: z.boolean().optional(),
  source: z.string().max(40).nullable().optional(),
  external_run_id: z.string().max(250).nullable().optional(),
  wait: z.boolean().optional(),
});

export async function orchestrateRoutes(app: FastifyInstance, ctx: AppContext) {
  app.addHook('preHandler', app.authenticate);
  app.post('/api/orchestrate/runs', async (req, reply) => {
    const { wait, ...input } = Body.parse(req.body ?? {});
    const run = await ctx.orchestrate.start(req.principal!, input, { wait });
    return reply.code(wait ? 200 : 202).send({ run });
  });
  app.get('/api/orchestrate/runs/:id', async (req) => {
    const q = z.object({ wait: z.coerce.number().min(0).max(60).optional() }).parse(req.query ?? {});
    const { id } = req.params as { id: string };
    return { run: q.wait ? await ctx.orchestrate.wait(req.principal!, id, q.wait) : await ctx.orchestrate.get(req.principal!, id) };
  });
  app.get('/api/orchestrate/runs', async (req) => {
    const q = z.object({ limit: z.coerce.number().int().min(1).max(500).optional() }).parse(req.query ?? {});
    return { runs: await ctx.orchestrate.list(req.principal!, q.limit) };
  });
}
