import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { requireAdmin, isAdmin } from '../services/principal.js';
import { USER_ROLES, ACTOR_TYPES } from '../db/schema/sqlite.js';
import { redactConfig } from '../config/index.js';
import { badRequest } from '../services/errors.js';

export async function adminRoutes(app: FastifyInstance, ctx: AppContext) {
  app.addHook('preHandler', app.authenticate);

  // Audit logs: users see their own; admins see everything.
  app.get('/api/audit', async (req) => {
    const q = z.object({ actor_type: z.enum(ACTOR_TYPES).optional(), action: z.string().optional(), limit: z.coerce.number().int().optional(), offset: z.coerce.number().int().optional(), user_id: z.string().optional() }).parse(req.query ?? {});
    const admin = isAdmin(req.principal!);
    const events = await ctx.audit.list({ userId: admin ? q.user_id : req.principal!.userId, actorType: q.actor_type, action: q.action, limit: q.limit, offset: q.offset });
    return { events };
  });

  app.get('/api/admin/users', async (req) => {
    requireAdmin(req.principal!);
    return { users: await ctx.auth.listUsers() };
  });

  app.post('/api/admin/users', async (req) => {
    requireAdmin(req.principal!);
    const body = z.object({ email: z.string().email(), password: z.string(), role: z.enum(USER_ROLES).optional(), display_name: z.string().optional() }).parse(req.body);
    const u = await ctx.auth.createLocalUser({ email: body.email, password: body.password, role: body.role, displayName: body.display_name });
    ctx.audit.log({ userId: req.principal!.userId, actorType: 'USER', action: 'admin.user_create', resource: `user:${u.id}`, ip: req.ip });
    const { password_hash: _p, ...pub } = u;
    return { user: pub };
  });

  app.patch('/api/admin/users/:id', async (req) => {
    requireAdmin(req.principal!);
    const { id } = req.params as { id: string };
    const body = z.object({ role: z.enum(USER_ROLES) }).parse(req.body);
    if (id === req.principal!.userId && body.role !== 'ADMIN') throw badRequest('You cannot demote yourself');
    await ctx.auth.updateRole(id, body.role);
    ctx.audit.log({ userId: req.principal!.userId, actorType: 'USER', action: 'admin.user_role', resource: `user:${id}`, ip: req.ip });
    return { ok: true };
  });

  app.delete('/api/admin/users/:id', async (req) => {
    requireAdmin(req.principal!);
    const { id } = req.params as { id: string };
    if (id === req.principal!.userId) throw badRequest('You cannot delete yourself');
    await ctx.auth.deleteUser(id);
    await ctx.workspaces.purgeUserGrants(id);
    ctx.audit.log({ userId: req.principal!.userId, actorType: 'USER', action: 'admin.user_delete', resource: `user:${id}`, ip: req.ip });
    return { ok: true };
  });

  app.get('/api/admin/engines', async (req) => {
    requireAdmin(req.principal!);
    return { engines: ctx.engines.list() };
  });

  app.post('/api/admin/engines/:workspaceId/evict', async (req) => {
    requireAdmin(req.principal!);
    const { workspaceId } = req.params as { workspaceId: string };
    ctx.engines.evict(workspaceId);
    return { ok: true };
  });

  app.get('/api/admin/config', async (req) => {
    requireAdmin(req.principal!);
    return { config: redactConfig(ctx.cfg) };
  });
}
