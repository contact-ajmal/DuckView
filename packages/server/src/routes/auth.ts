import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { toPublicUser } from '../services/auth.js';
import { badRequest, forbidden, HttpError } from '../services/errors.js';
import { logger } from '../observability/logger.js';

const LoginBody = z.object({ email: z.string().email(), password: z.string().min(1) });
const RegisterBody = z.object({ email: z.string().email(), password: z.string().min(1), display_name: z.string().max(120).optional() });

export async function authRoutes(app: FastifyInstance, ctx: AppContext) {
  const { cfg } = ctx;

  const signSession = (user: { id: string; email: string; role: string }) => app.jwt.sign({ sub: user.id, email: user.email, role: user.role }, { expiresIn: cfg.security.jwt_expires_in });

  app.get('/api/auth/config', async () => ({
    strategy: cfg.auth.strategy,
    registration_enabled: cfg.security.allow_registration,
    oidc_login_url: cfg.auth.strategy === 'oidc' ? '/api/auth/oidc/login' : null,
    needs_bootstrap: (await ctx.auth.countUsers()) === 0,
  }));

  app.post('/api/auth/login', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const body = LoginBody.parse(req.body);
    const user = await ctx.auth.login(body.email, body.password);
    ctx.audit.log({ userId: user.id, actorType: 'USER', action: 'auth.login', ip: req.ip });
    return { token: signSession(user), user: toPublicUser(user) };
  });

  app.post('/api/auth/register', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const body = RegisterBody.parse(req.body);
    const first = (await ctx.auth.countUsers()) === 0;
    if (!first && !cfg.security.allow_registration) throw forbidden('Self-registration is disabled');
    const user = await ctx.auth.createLocalUser({ email: body.email, password: body.password, role: first ? 'ADMIN' : 'USER', displayName: body.display_name });
    ctx.audit.log({ userId: user.id, actorType: 'USER', action: first ? 'auth.bootstrap_admin' : 'auth.register', ip: req.ip });
    return { token: signSession(user), user: toPublicUser(user) };
  });

  app.get('/api/auth/me', { preHandler: app.authenticate }, async (req) => {
    const p = req.principal!;
    const user = await ctx.auth.findById(p.userId);
    if (!user) throw new HttpError(401, 'User no longer exists', 'UNAUTHORIZED');
    return { user: toPublicUser(user), principal: { via: p.via, scopes: p.scopes, workspace_scope: p.workspaceScope ?? null } };
  });

  app.post('/api/auth/password', { preHandler: app.authenticate }, async (req) => {
    const p = req.principal!;
    if (p.via !== 'jwt') throw forbidden('Password changes require an interactive session');
    const body = z.object({ current_password: z.string(), new_password: z.string() }).parse(req.body);
    const user = await ctx.auth.findById(p.userId);
    if (!user) throw new HttpError(401, 'User no longer exists', 'UNAUTHORIZED');
    await ctx.auth.login(user.email, body.current_password);
    await ctx.auth.changePassword(user.id, body.new_password);
    ctx.audit.log({ userId: user.id, actorType: 'USER', action: 'auth.password_change', ip: req.ip });
    return { ok: true };
  });

  app.post('/api/auth/logout', { preHandler: app.authenticate }, async (req) => {
    ctx.audit.log({ userId: req.principal!.userId, actorType: 'USER', action: 'auth.logout', ip: req.ip });
    return { ok: true };
  });

  // ---------------- OIDC (Authorization Code + PKCE) ----------------
  if (cfg.auth.strategy === 'oidc') {
    const oidc = await import('openid-client');
    const o = cfg.auth.oidc;
    let configuration: import('openid-client').Configuration | null = null;
    const getConfiguration = async () => {
      if (!configuration) configuration = await oidc.discovery(new URL(o.issuer_url!), o.client_id!, o.client_secret!);
      return configuration;
    };
    const redirectUri = () => o.redirect_uri ?? `${cfg.server.public_url ?? `http://localhost:${cfg.server.port}`}/api/auth/oidc/callback`;

    app.get('/api/auth/oidc/login', async (req, reply) => {
      const config = await getConfiguration();
      const codeVerifier = oidc.randomPKCECodeVerifier();
      const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
      const nonce = oidc.randomState();
      // Stateless, signed state so multi-replica deployments need no shared session store.
      const state = app.jwt.sign({ cv: codeVerifier, nonce, purpose: 'oidc' }, { expiresIn: '10m' });
      const url = oidc.buildAuthorizationUrl(config, { redirect_uri: redirectUri(), scope: o.scopes, code_challenge: codeChallenge, code_challenge_method: 'S256', state, nonce });
      return reply.redirect(url.href);
    });

    app.get('/api/auth/oidc/callback', async (req, reply) => {
      const config = await getConfiguration();
      const current = new URL(req.url, redirectUri());
      const stateParam = current.searchParams.get('state');
      if (!stateParam) throw badRequest('Missing state');
      let st: { cv: string; nonce: string; purpose: string };
      try {
        st = app.jwt.verify(stateParam);
      } catch {
        throw badRequest('Invalid or expired OIDC state');
      }
      if (st.purpose !== 'oidc') throw badRequest('Invalid OIDC state');
      const tokens = await oidc.authorizationCodeGrant(config, current, { pkceCodeVerifier: st.cv, expectedState: stateParam, expectedNonce: st.nonce, idTokenExpected: true });
      const claims = tokens.claims();
      if (!claims?.sub) throw badRequest('ID token missing subject');
      let email = typeof claims.email === 'string' ? claims.email : undefined;
      let name = typeof claims.name === 'string' ? claims.name : undefined;
      if (!email) {
        try {
          const info = await oidc.fetchUserInfo(config, tokens.access_token, claims.sub);
          email = info.email;
          name = name ?? info.name;
        } catch (err) {
          logger().warn({ err }, 'OIDC userinfo fetch failed');
        }
      }
      if (!email) throw badRequest('OIDC provider did not return an email claim');
      const user = await ctx.auth.upsertOidcUser({ email, externalId: claims.sub, displayName: name ?? null });
      ctx.audit.log({ userId: user.id, actorType: 'USER', action: 'auth.login_oidc', ip: req.ip });
      const token = signSession(user);
      return reply.redirect(`/#/auth/callback?token=${encodeURIComponent(token)}`);
    });
  }
}
