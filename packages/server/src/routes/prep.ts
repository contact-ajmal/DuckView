/**
 * Data prep recipes: POST /api/workspaces/:id/prep/preview (compiled SQL, first rows, rows after each step) ·
 * POST /api/workspaces/:id/prep/save (as a view, a table or a dbt model).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { PrepStep } from '../services/prep.js';

const Recipe = z.object({ source: z.string().min(1).max(1000), steps: z.array(PrepStep).max(100) });

export async function prepRoutes(app: FastifyInstance, ctx: AppContext) {
  app.addHook('preHandler', app.authenticate);
  app.post('/api/workspaces/:id/prep/preview', async (req) => {
    const body = Recipe.extend({ limit: z.number().int().min(1).max(1000).optional() }).parse(req.body ?? {});
    return ctx.prep.preview(req.principal!, (req.params as { id: string }).id, body.source, body.steps, body.limit);
  });
  app.post('/api/workspaces/:id/prep/save', async (req) => {
    const body = Recipe.extend({ name: z.string().min(1).max(200), as: z.enum(['view', 'table', 'dbt']), project_id: z.string().optional(), replace: z.boolean().optional() }).parse(req.body ?? {});
    return ctx.prep.save(req.principal!, (req.params as { id: string }).id, body);
  });
}
