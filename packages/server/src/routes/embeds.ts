/**
 * Signed embeds.
 * Owners (signed in):
 *   GET/POST /api/workspaces/:id/embed/keys          list · create {name, allowed_origins?} → {key, secret} (shown once)
 *   PATCH/DELETE /api/embed/keys/:id                 rename / change origins · revoke
 *   POST /api/workspaces/:id/embed/sign              {key_id, resource_type, resource_id, sub?, attrs?, params?, expires_in?, theme?} → {token, url}
 * The embed itself (no login; the token on every request as `Authorization: Embed <token>` or ?token=):
 *   GET  /api/embed/view                             what to draw
 *   POST /api/embed/widgets/:wid/data                a dashboard widget's rows
 *   POST /api/embed/notebook/cells/:cell/run         a notebook cell's rows
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';

const Attrs = z.record(z.string().max(63), z.union([z.string().max(500), z.number(), z.boolean()])).optional();

export async function embedAdminRoutes(app: FastifyInstance, ctx: AppContext) {
  app.addHook('preHandler', app.authenticate);
  const e = ctx.embeds;
  app.get('/api/workspaces/:id/embed/keys', async (req) => ({ keys: await e.list(req.principal!, (req.params as { id: string }).id) }));
  app.post('/api/workspaces/:id/embed/keys', async (req) => e.create(req.principal!, (req.params as { id: string }).id, z.object({ name: z.string().max(120), allowed_origins: z.array(z.string().max(300)).max(50).optional() }).parse(req.body ?? {})));
  app.patch('/api/embed/keys/:id', async (req) => ({ key: await e.update(req.principal!, (req.params as { id: string }).id, z.object({ name: z.string().max(120).optional(), allowed_origins: z.array(z.string().max(300)).max(50).optional() }).parse(req.body ?? {})) }));
  app.delete('/api/embed/keys/:id', async (req) => {
    await e.revoke(req.principal!, (req.params as { id: string }).id);
    return { ok: true };
  });
  app.post('/api/workspaces/:id/embed/sign', async (req) => {
    const b = z.object({ key_id: z.string().max(64), resource_type: z.enum(['dashboard', 'notebook']), resource_id: z.string().max(64), sub: z.string().max(200).optional(), attrs: Attrs, params: z.record(z.string().max(63), z.union([z.string().max(1000), z.number()])).optional(), expires_in: z.number().int().optional(), theme: z.enum(['light', 'dark']).optional() }).parse(req.body ?? {});
    return e.sign(req.principal!, (req.params as { id: string }).id, b);
  });
}

const tokenOf = (req: FastifyRequest) => {
  const h = req.headers.authorization;
  if (h?.startsWith('Embed ')) return h.slice(6).trim();
  return (req.query as { token?: string })?.token;
};

export async function embedPublicRoutes(app: FastifyInstance, ctx: AppContext) {
  const e = ctx.embeds;
  app.get('/api/embed/view', async (req) => e.view(await e.verify(tokenOf(req), req.ip)));
  app.post('/api/embed/widgets/:wid/data', async (req) => e.widgetData(await e.verify(tokenOf(req), req.ip), (req.params as { wid: string }).wid));
  app.post('/api/embed/notebook/cells/:cell/run', async (req) => e.runCell(await e.verify(tokenOf(req), req.ip), (req.params as { cell: string }).cell));
}
