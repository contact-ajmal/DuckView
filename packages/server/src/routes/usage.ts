/**
 * Usage & cost:
 *   GET    /api/usage?days=30[&workspace_id][&mine=1]         the report (administrators: everyone, unless mine)
 *   GET    /api/usage/export.csv?by=day|workspace|user&days   the same, as CSV
 *   GET    /api/usage/budgets[?workspace_id]                  budgets with this month's spend and forecast
 *   POST   /api/usage/budgets {name?, workspace_id?, amount, thresholds?, forecast?, channel_ids?}
 *   PATCH  /api/usage/budgets/:id · DELETE /api/usage/budgets/:id
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';

const Report = z.object({ days: z.coerce.number().int().min(1).max(366).optional(), workspace_id: z.string().max(64).optional(), mine: z.enum(['1', 'true', '0', 'false']).optional() });
const Budget = z.object({
  name: z.string().max(120).optional(),
  workspace_id: z.string().max(64).nullable().optional(),
  amount: z.number().positive().max(1e9).optional(),
  thresholds: z.array(z.number().int().min(1).max(1000)).max(10).optional(),
  forecast: z.boolean().optional(),
  channel_ids: z.array(z.string().max(64)).max(20).optional(),
});

export async function usageRoutes(app: FastifyInstance, ctx: AppContext) {
  app.addHook('preHandler', app.authenticate);
  const report = (req: { principal?: unknown; query: unknown }) => {
    const q = Report.parse(req.query ?? {});
    return ctx.usage.report(req.principal as never, { days: q.days, workspace_id: q.workspace_id, mine: q.mine === '1' || q.mine === 'true' });
  };
  app.get('/api/usage', async (req) => report(req));
  app.get('/api/usage/export.csv', async (req, reply) => {
    const by = z.object({ by: z.enum(['day', 'workspace', 'user']).default('day') }).parse(req.query ?? {}).by;
    const r = await report(req);
    return reply
      .type('text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="duckview-usage-by-${by}-${r.range.to.slice(0, 10)}.csv"`)
      .send(ctx.usage.toCsv(r, by));
  });
  app.get('/api/usage/budgets', async (req) => {
    const q = z.object({ workspace_id: z.string().max(64).optional() }).parse(req.query ?? {});
    return { budgets: await ctx.usage.listBudgets(req.principal!, q.workspace_id) };
  });
  app.post('/api/usage/budgets', async (req) => ({ budget: await ctx.usage.createBudget(req.principal!, Budget.parse(req.body ?? {})) }));
  app.patch('/api/usage/budgets/:id', async (req) => ({ budget: await ctx.usage.updateBudget(req.principal!, (req.params as { id: string }).id, Budget.omit({ workspace_id: true }).parse(req.body ?? {})) }));
  app.delete('/api/usage/budgets/:id', async (req) => {
    await ctx.usage.removeBudget(req.principal!, (req.params as { id: string }).id);
    return { ok: true };
  });
}
