import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { AppContext } from '../context.js';
import type { Principal } from '../services/principal.js';
import { unauthorized } from '../services/errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal | null;
  }
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    optionalAuth: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export interface JwtClaims {
  sub: string;
  email: string;
  role: string;
}

async function resolvePrincipal(ctx: AppContext, req: FastifyRequest): Promise<Principal | null> {
  const header = req.headers.authorization ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(header);
  const raw = m?.[1]?.trim();
  if (!raw) return null;
  if (raw.startsWith('dv_')) return ctx.auth.verifyToken(raw, req.ip);
  try {
    const claims = req.server.jwt.verify<JwtClaims>(raw);
    const user = await ctx.auth.findById(claims.sub);
    if (!user) return null;
    return ctx.auth.principalFromUser(user, 'jwt', req.ip);
  } catch {
    return null;
  }
}

export default fp(async function authPlugin(app: FastifyInstance, opts: { ctx: AppContext }) {
  app.decorateRequest('principal', null);
  app.decorate('authenticate', async (req: FastifyRequest) => {
    req.principal = await resolvePrincipal(opts.ctx, req);
    if (!req.principal) throw unauthorized('Authentication required');
  });
  app.decorate('optionalAuth', async (req: FastifyRequest) => {
    req.principal = await resolvePrincipal(opts.ctx, req);
  });
});
