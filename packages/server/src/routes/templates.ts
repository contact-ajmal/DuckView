/**
 * Template marketplace:
 *   GET    /api/templates[?q&category]                          built-in, published, your own (and, for administrators, waiting for review)
 *   GET    /api/templates/:id                                   with its contents
 *   POST   /api/templates/:id/check {workspace_id, table_map?}  which tables exist, which columns are missing
 *   POST   /api/templates/:id/install {workspace_id, table_map?, sample_data?}
 *   GET    /api/workspaces/:id/template-installs · DELETE /api/template-installs/:id[?drop_tables=1]
 *   POST   /api/templates {workspace_id, name, query_ids, dashboard_ids, notebook_ids, quality_ids, semantic, sample_rows, visibility}
 *   PATCH  /api/templates/:id · DELETE /api/templates/:id · POST /api/templates/:id/review {approve}
 *   GET    /api/templates/:id/export · POST /api/templates/import {template file}
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';

const TableMap = z.record(z.string().max(64), z.string().max(200)).optional();
const Ids = z.array(z.string().max(64)).max(100).optional();
const Publish = z.object({
  workspace_id: z.string().max(64),
  name: z.string().max(120),
  description: z.string().max(2000).nullable().optional(),
  category: z.string().max(40).nullable().optional(),
  tags: z.array(z.string().max(40)).max(12).optional(),
  query_ids: Ids,
  dashboard_ids: Ids,
  notebook_ids: Ids,
  quality_ids: Ids,
  semantic: z.boolean().optional(),
  sample_rows: z.number().int().min(0).max(500).optional(),
  visibility: z.enum(['private', 'org']).optional(),
});

export async function templateRoutes(app: FastifyInstance, ctx: AppContext) {
  app.addHook('preHandler', app.authenticate);
  const id = (req: { params: unknown }) => (req.params as { id: string }).id;
  app.get('/api/templates', async (req) => {
    const q = z.object({ q: z.string().max(200).optional(), category: z.string().max(40).optional() }).parse(req.query ?? {});
    return { templates: await ctx.templates.list(req.principal!, q) };
  });
  app.get('/api/templates/:id', async (req) => ({ template: await ctx.templates.get(req.principal!, id(req)) }));
  app.post('/api/templates/:id/check', async (req) => {
    const b = z.object({ workspace_id: z.string().max(64), table_map: TableMap }).parse(req.body ?? {});
    return { tables: await ctx.templates.check(req.principal!, id(req), b.workspace_id, b.table_map ?? {}) };
  });
  app.post('/api/templates/:id/install', async (req) => {
    const b = z.object({ workspace_id: z.string().max(64), table_map: TableMap, sample_data: z.boolean().optional() }).parse(req.body ?? {});
    return ctx.templates.install(req.principal!, id(req), b);
  });
  app.get('/api/workspaces/:id/template-installs', async (req) => ({ installs: await ctx.templates.installs(req.principal!, id(req)) }));
  app.delete('/api/template-installs/:id', async (req) => {
    const q = z.object({ drop_tables: z.enum(['1', 'true', '0', 'false']).optional() }).parse(req.query ?? {});
    await ctx.templates.uninstall(req.principal!, id(req), { drop_tables: q.drop_tables === '1' || q.drop_tables === 'true' });
    return { ok: true };
  });
  app.post('/api/templates', async (req) => ({ template: await ctx.templates.publish(req.principal!, Publish.parse(req.body ?? {})) }));
  app.patch('/api/templates/:id', async (req) => {
    const b = z.object({ name: z.string().max(120).optional(), description: z.string().max(2000).nullable().optional(), category: z.string().max(40).optional(), tags: z.array(z.string().max(40)).max(12).optional(), visibility: z.enum(['private', 'org']).optional() }).parse(req.body ?? {});
    return { template: await ctx.templates.update(req.principal!, id(req), b) };
  });
  app.delete('/api/templates/:id', async (req) => {
    await ctx.templates.remove(req.principal!, id(req));
    return { ok: true };
  });
  app.post('/api/templates/:id/review', async (req) => {
    const b = z.object({ approve: z.boolean() }).parse(req.body ?? {});
    return { template: await ctx.templates.review(req.principal!, id(req), b.approve) };
  });
  app.get('/api/templates/:id/export', async (req, reply) => {
    const file = await ctx.templates.exportJson(req.principal!, id(req));
    const name = String(file.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'template';
    return reply.header('content-disposition', `attachment; filename="${name}.duckview-template.json"`).send(file);
  });
  app.post('/api/templates/import', { bodyLimit: 4 * 1024 * 1024 }, async (req) => ({ template: await ctx.templates.importJson(req.principal!, req.body) }));
}
