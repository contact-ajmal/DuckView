/**
 * Comments, mentions and the inbox.
 *   GET  /api/workspaces/:id/comments?target_type=&target_id=&anchor=   threads with replies, open counts per anchor
 *   POST /api/workspaces/:id/comments   {target_type, target_id, anchor?, parent_id?, body}   (@someone@example.com mentions)
 *   PATCH /api/comments/:id {body} · POST /api/comments/:id/resolve {resolved} · DELETE /api/comments/:id
 *   GET  /api/workspaces/:id/people     who can be mentioned
 *   GET  /api/inbox?unread=1 · POST /api/inbox/read {ids? | all?}
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { COMMENT_TARGETS } from '../db/schema/sqlite.js';

export async function commentRoutes(app: FastifyInstance, ctx: AppContext) {
  app.addHook('preHandler', app.authenticate);
  const cs = ctx.comments;

  app.get('/api/workspaces/:id/comments', async (req) => {
    const q = z.object({ target_type: z.enum(COMMENT_TARGETS), target_id: z.string().min(1).max(200), anchor: z.string().max(200).optional() }).parse(req.query ?? {});
    return cs.list(req.principal!, (req.params as { id: string }).id, q.target_type, q.target_id, q.anchor !== undefined ? { anchor: q.anchor || null } : {});
  });
  app.post('/api/workspaces/:id/comments', async (req) => {
    // A reply names only its thread (parent_id); a new thread names what it is about.
    const body = z.object({ target_type: z.enum(COMMENT_TARGETS).optional(), target_id: z.string().min(1).max(200).optional(), anchor: z.string().max(200).nullable().optional(), parent_id: z.string().max(64).nullable().optional(), body: z.string().min(1).max(10_000) }).parse(req.body ?? {});
    return { comment: await cs.add(req.principal!, (req.params as { id: string }).id, body) };
  });
  app.patch('/api/comments/:id', async (req) => ({ comment: await cs.edit(req.principal!, (req.params as { id: string }).id, z.object({ body: z.string().min(1).max(10_000) }).parse(req.body ?? {}).body) }));
  app.post('/api/comments/:id/resolve', async (req) => ({ comment: await cs.resolve(req.principal!, (req.params as { id: string }).id, z.object({ resolved: z.boolean().default(true) }).parse(req.body ?? {}).resolved) }));
  app.delete('/api/comments/:id', async (req) => {
    await cs.remove(req.principal!, (req.params as { id: string }).id);
    return { ok: true };
  });
  app.get('/api/workspaces/:id/people', async (req) => ({ people: await cs.people(req.principal!, (req.params as { id: string }).id) }));
  app.get('/api/inbox', async (req) => {
    const q = z.object({ unread: z.coerce.boolean().optional(), limit: z.coerce.number().int().min(1).max(200).optional() }).parse(req.query ?? {});
    return cs.inboxFor(req.principal!, q);
  });
  app.post('/api/inbox/read', async (req) => {
    const body = z.object({ ids: z.array(z.string().max(64)).max(500).optional(), all: z.boolean().optional() }).parse(req.body ?? {});
    return { marked: await cs.markRead(req.principal!, body.all ? 'all' : body.ids ?? []) };
  });
}
