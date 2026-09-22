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
  /** Absent on sign-in sessions; every other JWT DuckView signs names what it is for. */
  purpose?: string;
  /** purpose "app-browser": the workspace the read-only credential is limited to. */
  ws?: string;
}

/**
 * The principal behind a bearer credential: an API token (dv_…), a sign-in session JWT, or the short-lived
 * read-only JWT an in-browser data app runs with (purpose "app-browser": read scope, one workspace, acting as an
 * agent). JWTs signed for anything else — the /apps cookie, OAuth and OIDC state — are never credentials.
 */
export async function principalFromBearer(ctx: AppContext, server: FastifyInstance, raw: string, ip?: string): Promise<Principal | null> {
  if (!raw) return null;
  if (raw.startsWith('dv_')) return ctx.auth.verifyToken(raw, ip);
  let claims: JwtClaims;
  try {
    claims = server.jwt.verify<JwtClaims>(raw);
  } catch {
    return null;
  }
  if (claims.purpose && claims.purpose !== 'app-browser') return null;
  const user = claims.sub ? await ctx.auth.findById(claims.sub) : null;
  if (!user) return null;
  const p = ctx.auth.principalFromUser(user, claims.purpose ? 'token' : 'jwt', ip);
  if (!claims.purpose) return p;
  if (!claims.ws) return null;
  return { ...p, scopes: p.scopes.filter((s) => s === 'read'), workspaceScope: claims.ws, actorType: 'AGENT' };
}

async function resolvePrincipal(ctx: AppContext, req: FastifyRequest): Promise<Principal | null> {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '');
  const raw = m?.[1]?.trim();
  return raw ? principalFromBearer(ctx, req.server, raw, req.ip) : null;
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
