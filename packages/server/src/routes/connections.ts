import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { requireWrite } from '../services/principal.js';
import { CONNECTION_TYPES } from '../db/schema/sqlite.js';
import { CONNECTION_FIELDS } from '../services/connections.js';

export async function connectionRoutes(app: FastifyInstance, ctx: AppContext) {
  app.addHook('preHandler', app.authenticate);

  app.get('/api/connections/types', async () => ({ types: CONNECTION_FIELDS, external_access_enabled: ctx.cfg.security.enable_external_access }));

  app.get('/api/connections', async (req) => ({ connections: await ctx.connections.list(req.principal!.userId) }));

  app.post('/api/connections', async (req) => {
    requireWrite(req.principal!);
    const body = z.object({ name: z.string().max(120), type: z.enum(CONNECTION_TYPES), credentials: z.record(z.string(), z.string()) }).parse(req.body);
    const c = await ctx.connections.create(req.principal!.userId, body);
    ctx.audit.log({ userId: req.principal!.userId, actorType: req.principal!.actorType, action: 'connection.create', resource: `connection:${c.id}`, ip: req.ip });
    return { connection: c };
  });

  app.delete('/api/connections/:id', async (req) => {
    requireWrite(req.principal!);
    const { id } = req.params as { id: string };
    await ctx.connections.remove(req.principal!.userId, id);
    ctx.audit.log({ userId: req.principal!.userId, actorType: req.principal!.actorType, action: 'connection.delete', resource: `connection:${id}`, ip: req.ip });
    return { ok: true };
  });
}
