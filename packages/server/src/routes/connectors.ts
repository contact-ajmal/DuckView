/**
 * Connector connections (warehouses, SaaS applications, Google Drive / Sheets), the Google OAuth flow that
 * signs a person's Google account in, and the administrator-managed Google OAuth client.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { requireWrite, requireAdmin } from '../services/principal.js';
import { badRequest } from '../services/errors.js';
import { logger } from '../observability/logger.js';

const Values = z.record(z.string().max(64), z.union([z.string().max(20_000), z.number(), z.boolean(), z.null()]));

export async function connectorRoutes(app: FastifyInstance, ctx: AppContext) {
  // ---- the browser comes back from Google without a bearer token: the signed state carries the user and connection.
  app.get('/api/oauth/google/callback', async (req, reply) => {
    const q = z.object({ code: z.string().optional(), state: z.string().optional(), error: z.string().optional() }).parse(req.query ?? {});
    const fail = (message: string) => reply.redirect(`/#/connections?google_error=${encodeURIComponent(message)}`);
    if (q.error) return fail(q.error);
    if (!q.code || !q.state) return fail('Missing code or state');
    let st: { purpose?: string; cid?: string; sub?: string };
    try {
      st = app.jwt.verify(q.state);
    } catch {
      return fail('The sign-in link expired — start again');
    }
    if (st.purpose !== 'google_connect' || !st.cid || !st.sub) return fail('Invalid state');
    try {
      const c = await ctx.connectors.finishGoogle({ cid: st.cid, sub: st.sub }, q.code);
      ctx.audit.log({ userId: st.sub, actorType: 'USER', action: 'connector_connection.google_connect', resource: `connector_connection:${c.id}`, ip: req.ip });
      return reply.redirect(`/#/connections?connected=${encodeURIComponent(c.id)}`);
    } catch (err) {
      logger().warn({ err: (err as Error).message }, 'Google connect failed');
      return fail((err as Error).message.split('\n')[0] ?? 'Google sign-in failed');
    }
  });

  await app.register(async (r) => {
    r.addHook('preHandler', app.authenticate);

    r.get('/api/connectors', async () => ({ connectors: ctx.connectors.catalog(), google: { configured: !!(await ctx.connectors.googleClient()) } }));

    r.get('/api/connector-connections', async (req) => ({ connections: await ctx.connectors.list(req.principal!.userId) }));
    r.post('/api/connector-connections', async (req) => {
      requireWrite(req.principal!);
      const body = z.object({ connector: z.string().max(40), name: z.string().max(120).optional().default(''), values: Values.default({}) }).parse(req.body ?? {});
      const c = await ctx.connectors.create(req.principal!.userId, body);
      ctx.audit.log({ userId: req.principal!.userId, actorType: req.principal!.actorType, action: 'connector_connection.create', resource: `connector_connection:${c.id}`, ip: req.ip });
      return { connection: c };
    });
    r.patch('/api/connector-connections/:id', async (req) => {
      requireWrite(req.principal!);
      const { id } = req.params as { id: string };
      const body = z.object({ name: z.string().max(120).optional(), values: Values.optional() }).parse(req.body ?? {});
      return { connection: await ctx.connectors.update(req.principal!.userId, id, body) };
    });
    r.delete('/api/connector-connections/:id', async (req) => {
      requireWrite(req.principal!);
      const { id } = req.params as { id: string };
      await ctx.connectors.remove(req.principal!.userId, id);
      ctx.audit.log({ userId: req.principal!.userId, actorType: req.principal!.actorType, action: 'connector_connection.delete', resource: `connector_connection:${id}`, ip: req.ip });
      return { ok: true };
    });
    r.post('/api/connector-connections/:id/test', async (req) => {
      const { id } = req.params as { id: string };
      return ctx.connectors.test(req.principal!.userId, id);
    });
    r.get('/api/connector-connections/:id/browse', async (req) => {
      const { id } = req.params as { id: string };
      const q = z.object({ path: z.string().max(2000).optional() }).parse(req.query ?? {});
      const path = q.path ? q.path.split('/').filter(Boolean).map((p) => decodeURIComponent(p)) : [];
      return ctx.connectors.browse(req.principal!.userId, id, path);
    });
    r.post('/api/connector-connections/:id/query', async (req) => {
      const { id } = req.params as { id: string };
      const body = z.object({ sql: z.string().min(1).max(50_000), limit: z.coerce.number().int().min(1).max(10_000).optional() }).parse(req.body ?? {});
      return ctx.connectors.query(req.principal!.userId, id, body.sql, { limit: body.limit });
    });

    // ---- "Connect with Google": returns the consent URL the browser navigates to.
    r.post('/api/oauth/google/start', async (req) => {
      requireWrite(req.principal!);
      if (req.principal!.actorType !== 'USER') throw badRequest('Google sign-in needs a person in a browser');
      const body = z.object({ connector: z.string().max(40), name: z.string().max(120).optional(), values: Values.optional(), connection_id: z.string().max(64).optional() }).parse(req.body ?? {});
      return ctx.connectors.beginGoogle(req.principal!.userId, body, (payload) => app.jwt.sign(payload, { expiresIn: '10m' }));
    });

    // ---- administrators: the Google OAuth client (secret write-only, stored encrypted)
    r.get('/api/admin/integrations/google', async (req) => {
      requireAdmin(req.principal!);
      return ctx.connectors.describeGoogleClient();
    });
    r.put('/api/admin/integrations/google', async (req) => {
      const body = z.object({ client_id: z.string().max(300), client_secret: z.string().max(300).nullable().optional() }).parse(req.body ?? {});
      await ctx.connectors.setGoogleClient(req.principal!, body);
      ctx.audit.log({ userId: req.principal!.userId, actorType: req.principal!.actorType, action: 'integration.google.update', resource: 'integration:google', ip: req.ip });
      return ctx.connectors.describeGoogleClient();
    });
    r.delete('/api/admin/integrations/google', async (req) => {
      await ctx.connectors.clearGoogleClient(req.principal!);
      ctx.audit.log({ userId: req.principal!.userId, actorType: req.principal!.actorType, action: 'integration.google.delete', resource: 'integration:google', ip: req.ip });
      return { ok: true };
    });
  });
}
