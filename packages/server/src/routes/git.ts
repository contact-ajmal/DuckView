/**
 * Git sync of a workspace.
 *   GET/PUT/DELETE /api/workspaces/:id/git     the connection (token write-only) · connect (owners) · disconnect
 *   GET  /api/workspaces/:id/git/status        what a push would change; whether to pull first (editors)
 *   POST /api/workspaces/:id/git/push {message?} · POST /api/workspaces/:id/git/pull
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';

export async function gitRoutes(app: FastifyInstance, ctx: AppContext) {
  app.addHook('preHandler', app.authenticate);
  const id = (req: { params: unknown }) => (req.params as { id: string }).id;
  app.get('/api/workspaces/:id/git', async (req) => ({ git: await ctx.git.get(req.principal!, id(req)), enabled: ctx.cfg.git.enabled }));
  app.put('/api/workspaces/:id/git', async (req) => {
    const b = z.object({ repo_url: z.string().min(1).max(1000), branch: z.string().max(100).optional(), path: z.string().max(300).optional(), token: z.string().max(1000).nullable().optional() }).parse(req.body ?? {});
    return { git: await ctx.git.configure(req.principal!, id(req), b) };
  });
  app.delete('/api/workspaces/:id/git', async (req) => {
    await ctx.git.disconnect(req.principal!, id(req));
    return { ok: true };
  });
  app.get('/api/workspaces/:id/git/status', async (req) => ctx.git.status(req.principal!, id(req)));
  app.post('/api/workspaces/:id/git/push', async (req) => ctx.git.push(req.principal!, id(req), z.object({ message: z.string().max(500).nullable().optional() }).parse(req.body ?? {}).message));
  app.post('/api/workspaces/:id/git/pull', async (req) => ctx.git.pull(req.principal!, id(req)));
}
