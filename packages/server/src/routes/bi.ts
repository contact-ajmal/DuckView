import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { WIDGET_TYPES } from '../db/schema/sqlite.js';

const ChartConfig = z
  .object({
    chart: z.enum(['bar', 'line', 'area', 'scatter', 'pie']).optional(),
    x: z.string().optional(),
    y: z.array(z.string()).optional(),
    group_by: z.string().optional(),
    aggregate: z.enum(['sum', 'avg', 'min', 'max', 'count', 'none']).optional(),
    stacked: z.boolean().optional(),
    value: z.string().optional(),
    compare: z.string().optional(),
    format: z.enum(['number', 'currency', 'percent', 'compact']).optional(),
    page_size: z.number().int().min(1).max(500).optional(),
    markdown: z.string().max(50_000).optional(),
    colors: z.array(z.string()).max(8).optional(),
  })
  .strict();

const Layout = z.array(z.object({ i: z.string(), x: z.number(), y: z.number(), w: z.number(), h: z.number(), minW: z.number().optional(), minH: z.number().optional() }));

export async function biRoutes(app: FastifyInstance, ctx: AppContext) {
  app.addHook('preHandler', app.authenticate);

  // ---- saved queries
  app.get('/api/workspaces/:id/queries', async (req) => {
    const { id } = req.params as { id: string };
    return { queries: await ctx.savedQueries.list(req.principal!, id) };
  });
  app.post('/api/workspaces/:id/queries', async (req) => {
    const { id } = req.params as { id: string };
    const body = z.object({ name: z.string().min(1), folder: z.string().optional(), description: z.string().nullable().optional(), sql_text: z.string().min(1), tags: z.array(z.string()).optional() }).parse(req.body);
    const q = await ctx.savedQueries.create(req.principal!, id, body);
    ctx.audit.log({ userId: req.principal!.userId, actorType: req.principal!.actorType, action: 'saved_query.create', resource: `saved_query:${q.id}`, ip: req.ip });
    return { query: q };
  });
  app.patch('/api/workspaces/:id/queries/:qid', async (req) => {
    const { id, qid } = req.params as { id: string; qid: string };
    const body = z.object({ name: z.string().min(1).optional(), folder: z.string().optional(), description: z.string().nullable().optional(), sql_text: z.string().min(1).optional(), tags: z.array(z.string()).optional() }).parse(req.body ?? {});
    return { query: await ctx.savedQueries.update(req.principal!, id, qid, body) };
  });
  app.delete('/api/workspaces/:id/queries/:qid', async (req) => {
    const { id, qid } = req.params as { id: string; qid: string };
    await ctx.savedQueries.remove(req.principal!, id, qid);
    return { ok: true };
  });

  // ---- dashboards
  app.get('/api/workspaces/:id/dashboards', async (req) => {
    const { id } = req.params as { id: string };
    return { dashboards: await ctx.dashboards.list(req.principal!, id) };
  });
  app.post('/api/workspaces/:id/dashboards', async (req) => {
    const { id } = req.params as { id: string };
    const body = z.object({ name: z.string(), description: z.string().nullable().optional() }).parse(req.body ?? {});
    const d = await ctx.dashboards.create(req.principal!, id, body);
    ctx.audit.log({ userId: req.principal!.userId, actorType: req.principal!.actorType, action: 'dashboard.create', resource: `dashboard:${d.id}`, ip: req.ip });
    return { dashboard: d };
  });
  app.get('/api/dashboards/:id', async (req) => {
    const { id } = req.params as { id: string };
    return { dashboard: await ctx.dashboards.get(req.principal!, id) };
  });
  app.patch('/api/dashboards/:id', async (req) => {
    const { id } = req.params as { id: string };
    const body = z.object({ name: z.string().optional(), description: z.string().nullable().optional(), layout: Layout.optional() }).parse(req.body ?? {});
    return { dashboard: await ctx.dashboards.update(req.principal!, id, body) };
  });
  app.delete('/api/dashboards/:id', async (req) => {
    const { id } = req.params as { id: string };
    await ctx.dashboards.remove(req.principal!, id);
    ctx.audit.log({ userId: req.principal!.userId, actorType: req.principal!.actorType, action: 'dashboard.delete', resource: `dashboard:${id}`, ip: req.ip });
    return { ok: true };
  });

  // ---- widgets
  const WidgetBody = z.object({
    title: z.string().min(1),
    widget_type: z.enum(WIDGET_TYPES),
    saved_query_id: z.string().nullable().optional(),
    custom_sql: z.string().nullable().optional(),
    chart_config: ChartConfig.optional(),
    refresh_interval_sec: z.number().int().min(0).optional(),
    order_index: z.number().int().min(0).optional(),
  });
  app.post('/api/dashboards/:id/widgets', async (req) => {
    const { id } = req.params as { id: string };
    const body = WidgetBody.parse(req.body);
    return ctx.dashboards.addWidget(req.principal!, id, body);
  });
  app.patch('/api/dashboards/:id/widgets/:wid', async (req) => {
    const { id, wid } = req.params as { id: string; wid: string };
    const body = WidgetBody.partial().parse(req.body ?? {});
    return { widget: await ctx.dashboards.updateWidget(req.principal!, id, wid, body) };
  });
  app.delete('/api/dashboards/:id/widgets/:wid', async (req) => {
    const { id, wid } = req.params as { id: string; wid: string };
    return { layout: await ctx.dashboards.removeWidget(req.principal!, id, wid) };
  });

  // Runs a widget's query (read-only, capped) — used by the dashboard renderer and auto-refresh loops.
  app.post('/api/dashboards/:id/widgets/:wid/data', async (req) => {
    const { id, wid } = req.params as { id: string; wid: string };
    const body = z.object({ max_rows: z.number().int().min(1).max(5000).optional() }).parse(req.body ?? {});
    const { sql, workspace_id, widget } = await ctx.dashboards.widgetSql(req.principal!, id, wid);
    const result = await ctx.queries.run(req.principal!, workspace_id, sql, { maxRows: body.max_rows ?? (widget.widget_type === 'KPI' ? 10 : widget.widget_type === 'TABLE' ? 1000 : 2000), countTotal: widget.widget_type === 'TABLE' });
    const { analysis: _a, guardedSql: _g, ...rest } = result as typeof result & { guardedSql?: string };
    return { widget_id: wid, ...rest };
  });
}
