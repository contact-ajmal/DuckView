/**
 * Automated insights: metric monitors and the unusual periods they find.
 *   POST /api/workspaces/:id/insights/scan {metrics?, grain?, sensitivity?, segment_by?}   every metric now, nothing saved
 *   GET  /api/workspaces/:id/insights?status=new|dismissed|all&monitor_id=&limit=          recorded insights, newest first
 *   PATCH /api/insights/:id {status}                                                        dismiss (editors) or bring back
 *   GET/POST /api/workspaces/:id/monitors                                                   list · create (editors)
 *   PATCH/DELETE /api/monitors/:id · POST /api/monitors/:id/run
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { MONITOR_GRAINS } from '../db/schema/sqlite.js';

const Schedule = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('manual') }),
  z.object({ kind: z.literal('interval'), minutes: z.number().int().min(5).max(60 * 24 * 7) }),
  z.object({ kind: z.literal('cron'), expression: z.string().min(1).max(120), timezone: z.string().max(64).optional() }),
]);
const Monitor = z.object({
  name: z.string().max(120).optional(),
  metric: z.string().min(1).max(200),
  grain: z.enum(MONITOR_GRAINS).optional(),
  segment_by: z.string().max(200).nullable().optional(),
  sensitivity: z.number().min(1).max(10).optional(),
  lookback: z.number().int().min(7).max(400).optional(),
  schedule: Schedule.optional(),
  channel_ids: z.array(z.string().max(64)).max(20).optional(),
  enabled: z.boolean().optional(),
});

export async function insightRoutes(app: FastifyInstance, ctx: AppContext) {
  app.addHook('preHandler', app.authenticate);

  app.post('/api/workspaces/:id/insights/scan', async (req) => {
    const body = z.object({ metrics: z.array(z.string().max(200)).max(25).optional(), grain: z.enum(MONITOR_GRAINS).optional(), sensitivity: z.number().min(1).max(10).optional(), segment_by: z.string().max(200).nullable().optional() }).parse(req.body ?? {});
    return ctx.insights.scan(req.principal!, (req.params as { id: string }).id, body);
  });

  app.get('/api/workspaces/:id/insights', async (req) => {
    const q = z.object({ status: z.enum(['new', 'dismissed', 'all']).optional(), monitor_id: z.string().max(64).optional(), limit: z.coerce.number().int().min(1).max(500).optional() }).parse(req.query ?? {});
    return { insights: await ctx.insights.insights(req.principal!, (req.params as { id: string }).id, q) };
  });

  app.patch('/api/insights/:id', async (req) => {
    const body = z.object({ status: z.enum(['new', 'dismissed']) }).parse(req.body ?? {});
    return { insight: await ctx.insights.setStatus(req.principal!, (req.params as { id: string }).id, body.status) };
  });

  app.get('/api/workspaces/:id/monitors', async (req) => ({ monitors: await ctx.insights.list(req.principal!, (req.params as { id: string }).id) }));
  app.post('/api/workspaces/:id/monitors', async (req) => ({ monitor: await ctx.insights.create(req.principal!, (req.params as { id: string }).id, Monitor.parse(req.body ?? {})) }));
  app.patch('/api/monitors/:id', async (req) => ({ monitor: await ctx.insights.update(req.principal!, (req.params as { id: string }).id, Monitor.partial().parse(req.body ?? {})) }));
  app.delete('/api/monitors/:id', async (req) => {
    await ctx.insights.remove(req.principal!, (req.params as { id: string }).id);
    return { ok: true };
  });
  app.post('/api/monitors/:id/run', async (req) => {
    const { id } = req.params as { id: string };
    await ctx.insights.get(req.principal!, id, 'EDITOR');
    const r = await ctx.insights.run(id, req.principal!);
    return { monitor: r.monitor, findings: r.findings, created: r.created, notified: r.notified };
  });
}
