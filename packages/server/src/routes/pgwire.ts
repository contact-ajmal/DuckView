/**
 * The Postgres protocol listener, for the Settings page:
 *   GET /api/pgwire   {enabled, host, port, tls, require_tls, user, databases} — what a BI tool needs to connect
 */
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';

export async function pgwireRoutes(app: FastifyInstance, ctx: AppContext) {
  app.addHook('preHandler', app.authenticate);
  app.get('/api/pgwire', async (req) => {
    const c = ctx.cfg.pgwire;
    const address = ctx.pgwire.address;
    const workspaces = await ctx.workspaces.list(req.principal!);
    return {
      enabled: c.enabled && !!address,
      host: c.host,
      port: address?.port ?? c.port,
      localhost_only: c.host === '127.0.0.1' || c.host === 'localhost' || c.host === '::1',
      tls: ctx.pgwire.tls,
      require_tls: c.require_tls,
      user: req.principal!.email,
      databases: workspaces.map((w) => w.name),
    };
  });
}
