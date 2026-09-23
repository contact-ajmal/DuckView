import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { GROUP_MEMBER_ROLES } from '../db/schema/sqlite.js';

/** Teams (groups) and the user directory used by the share pickers. */
export async function groupRoutes(app: FastifyInstance, ctx: AppContext) {
  app.addHook('preHandler', app.authenticate);

  // People picker: any signed-in user may look up colleagues by email/name.
  app.get('/api/users/directory', async (req) => {
    const q = z.object({ q: z.string().max(200).optional() }).parse(req.query ?? {});
    return { users: await ctx.groups.directory(q.q) };
  });

  app.get('/api/groups', async (req) => ({ groups: await ctx.groups.list(req.principal!) }));

  app.post('/api/groups', async (req) => {
    const body = z.object({ name: z.string().min(1).max(80), description: z.string().max(500).nullable().optional(), external_id: z.string().max(256).nullable().optional() }).parse(req.body);
    const g = await ctx.groups.create(req.principal!, body);
    ctx.audit.log({ userId: req.principal!.userId, actorType: req.principal!.actorType, action: 'group.create', resource: `group:${g.id}`, ip: req.ip });
    return { group: g };
  });

  app.patch('/api/groups/:id', async (req) => {
    const { id } = req.params as { id: string };
    const body = z.object({ name: z.string().min(1).max(80).optional(), description: z.string().max(500).nullable().optional(), external_id: z.string().max(256).nullable().optional() }).parse(req.body ?? {});
    const g = await ctx.groups.update(req.principal!, id, body);
    ctx.audit.log({ userId: req.principal!.userId, actorType: req.principal!.actorType, action: 'group.update', resource: `group:${id}`, ip: req.ip });
    return { group: g };
  });

  app.delete('/api/groups/:id', async (req) => {
    const { id } = req.params as { id: string };
    await ctx.groups.remove(req.principal!, id);
    ctx.audit.log({ userId: req.principal!.userId, actorType: req.principal!.actorType, action: 'group.delete', resource: `group:${id}`, ip: req.ip });
    return { ok: true };
  });

  app.get('/api/groups/:id/members', async (req) => {
    const { id } = req.params as { id: string };
    return { members: await ctx.groups.members(req.principal!, id) };
  });

  app.put('/api/groups/:id/members', async (req) => {
    const { id } = req.params as { id: string };
    const body = z.object({ user_id: z.string().min(1), role: z.enum(GROUP_MEMBER_ROLES).optional() }).parse(req.body);
    const members = await ctx.groups.addMember(req.principal!, id, body.user_id, body.role ?? 'MEMBER');
    ctx.audit.log({ userId: req.principal!.userId, actorType: req.principal!.actorType, action: 'group.member_add', resource: `group:${id}`, queryText: `user:${body.user_id} ${body.role ?? 'MEMBER'}`, ip: req.ip });
    return { members };
  });

  app.delete('/api/groups/:id/members/:userId', async (req) => {
    const { id, userId } = req.params as { id: string; userId: string };
    const members = await ctx.groups.removeMember(req.principal!, id, userId);
    ctx.audit.log({ userId: req.principal!.userId, actorType: req.principal!.actorType, action: 'group.member_remove', resource: `group:${id}`, queryText: `user:${userId}`, ip: req.ip });
    return { members };
  });
}
