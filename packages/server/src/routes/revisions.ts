/**
 * Version history.
 *   GET  /api/workspaces/:id/revisions?object_type=notebook|dashboard|query|semantic|dbt&object_id=   newest first
 *   POST /api/workspaces/:id/revisions {object_type, object_id, message}   name the current state
 *   GET  /api/revisions/:id            the snapshot, its text and the current state's text (for a diff)
 *   POST /api/revisions/:id/restore    write it back (editors); recorded as a new revision
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';

export async function revisionRoutes(app: FastifyInstance, ctx: AppContext) {
  app.addHook('preHandler', app.authenticate);
  app.get('/api/workspaces/:id/revisions', async (req) => {
    const q = z.object({ object_type: z.string().max(20), object_id: z.string().min(1).max(200) }).parse(req.query ?? {});
    return { revisions: await ctx.revisions.list(req.principal!, (req.params as { id: string }).id, q.object_type, q.object_id) };
  });
  app.post('/api/workspaces/:id/revisions', async (req) => {
    const b = z.object({ object_type: z.string().max(20), object_id: z.string().min(1).max(200), message: z.string().min(1).max(300) }).parse(req.body ?? {});
    return { revision: await ctx.revisions.name(req.principal!, (req.params as { id: string }).id, b.object_type, b.object_id, b.message) };
  });
  app.get('/api/revisions/:id', async (req) => ctx.revisions.get(req.principal!, (req.params as { id: string }).id));
  app.post('/api/revisions/:id/restore', async (req) => ({ revision: await ctx.revisions.restore(req.principal!, (req.params as { id: string }).id) }));
}
