/**
 * SCIM 2.0 at /scim/v2 — Users, Groups and the discovery documents — plus the admin endpoints that manage the
 * provisioning token. The IdP authenticates with that token, not a user session; responses are
 * application/scim+json and errors use the SCIM error schema.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import type { AppContext } from '../context.js';
import { HttpError, forbidden } from '../services/errors.js';
import { isPlatformAdmin } from '../services/principal.js';
import { SCIM_ERROR, SCIM_GROUP, SCIM_LIST, SCIM_USER, scimError, type ListParams } from '../services/scim.js';

const SCIM_TYPE = 'application/scim+json; charset=utf-8';

function baseUrl(ctx: AppContext, req: FastifyRequest): string {
  const origin = ctx.cfg.server.public_url?.replace(/\/+$/, '') ?? `${req.protocol}://${req.headers.host}`;
  return `${origin}/scim/v2`;
}

function listParams(req: FastifyRequest): ListParams {
  const q = (req.query ?? {}) as Record<string, string | undefined>;
  const int = (v: string | undefined) => (v !== undefined && /^\d+$/.test(v) ? Number(v) : undefined);
  const excluded = (q.excludedAttributes ?? '').split(',').map((s) => s.trim().toLowerCase());
  return { filter: q.filter, startIndex: int(q.startIndex), count: int(q.count), excludeMembers: excluded.includes('members') };
}

export async function scimRoutes(app: FastifyInstance, ctx: AppContext) {
  // IdPs send application/scim+json; parse it like JSON.
  app.addContentTypeParser(['application/scim+json'], { parseAs: 'string' }, (_req, body, done) => {
    const text = typeof body === 'string' ? body : body.toString();
    if (!text.trim()) return done(null, undefined);
    try {
      done(null, JSON.parse(text));
    } catch {
      done(scimError(400, 'The request body is not valid JSON', 'invalidSyntax'), undefined);
    }
  });

  app.setErrorHandler((err, req, reply) => {
    const status = err instanceof HttpError ? err.statusCode : err instanceof ZodError ? 400 : ((err as { statusCode?: number }).statusCode ?? 500);
    const scimType = err instanceof HttpError ? (err.details as { scimType?: string } | undefined)?.scimType : err instanceof ZodError ? 'invalidValue' : undefined;
    if (status >= 500) req.log.error({ err }, 'SCIM request failed');
    reply
      .code(status)
      .type(SCIM_TYPE)
      .send({ schemas: [SCIM_ERROR], status: String(status), ...(scimType ? { scimType } : {}), detail: status >= 500 ? 'Internal error' : (err as Error).message });
  });

  // Every SCIM call needs the provisioning token.
  const requireScim = async (req: FastifyRequest, reply: FastifyReply) => {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '');
    if (!(await ctx.scim.verify(m?.[1]?.trim() ?? ''))) {
      reply.header('WWW-Authenticate', 'Bearer realm="duckview-scim"');
      throw scimError(401, ctx.cfg.auth.scim.enabled ? 'A valid SCIM bearer token is required' : 'SCIM provisioning is disabled');
    }
    reply.type(SCIM_TYPE);
  };

  const audit = (req: FastifyRequest, action: string, resource: string, detail?: string) =>
    ctx.audit.log({ userId: null, actorType: 'SYSTEM', action: `scim.${action}`, resource, queryText: detail, ip: req.ip });

  await app.register(async (r) => {
    r.addHook('preHandler', requireScim);
    const P = '/scim/v2';
    type Body = Record<string, unknown>;
    type Id = { id: string };

    r.get(`${P}/ServiceProviderConfig`, async (req) => ({
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
      documentationUri: 'https://github.com/contact-ajmal/DuckView/blob/main/docs/REFERENCE.md#scim-provisioning',
      patch: { supported: true },
      bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter: { supported: true, maxResults: 200 },
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: false },
      authenticationSchemes: [{ type: 'oauthbearertoken', name: 'Bearer token', description: 'The SCIM token from Governance → Provisioning', primary: true }],
      meta: { resourceType: 'ServiceProviderConfig', location: `${baseUrl(ctx, req)}/ServiceProviderConfig` },
    }));

    r.get(`${P}/ResourceTypes`, async (req) => {
      const base = baseUrl(ctx, req);
      const types = [
        { schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'], id: 'User', name: 'User', endpoint: '/Users', schema: SCIM_USER, meta: { resourceType: 'ResourceType', location: `${base}/ResourceTypes/User` } },
        { schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'], id: 'Group', name: 'Group', endpoint: '/Groups', schema: SCIM_GROUP, meta: { resourceType: 'ResourceType', location: `${base}/ResourceTypes/Group` } },
      ];
      return { schemas: [SCIM_LIST], totalResults: types.length, startIndex: 1, itemsPerPage: types.length, Resources: types };
    });

    r.get(`${P}/Schemas`, async () => {
      const attr = (name: string, type = 'string', extra: Record<string, unknown> = {}) => ({ name, type, multiValued: false, required: false, caseExact: false, mutability: 'readWrite', returned: 'default', uniqueness: 'none', ...extra });
      const schemas = [
        { id: SCIM_USER, name: 'User', description: 'A DuckView user', attributes: [attr('userName', 'string', { required: true, uniqueness: 'server' }), attr('displayName'), attr('name', 'complex'), attr('emails', 'complex', { multiValued: true }), attr('active', 'boolean'), attr('externalId'), attr('groups', 'complex', { multiValued: true, mutability: 'readOnly' })] },
        { id: SCIM_GROUP, name: 'Group', description: 'A DuckView team', attributes: [attr('displayName', 'string', { required: true }), attr('externalId'), attr('members', 'complex', { multiValued: true })] },
      ];
      return { schemas: [SCIM_LIST], totalResults: schemas.length, startIndex: 1, itemsPerPage: schemas.length, Resources: schemas };
    });

    // ---- Users ----
    r.get(`${P}/Users`, async (req) => ctx.scim.listUsers(baseUrl(ctx, req), listParams(req)));
    r.get(`${P}/Users/:id`, async (req) => ctx.scim.getUser(baseUrl(ctx, req), (req.params as Id).id));
    r.post(`${P}/Users`, async (req, reply) => {
      const user = await ctx.scim.createUser(baseUrl(ctx, req), (req.body ?? {}) as Body);
      audit(req, 'user_create', `user:${String(user.id)}`, String(user.userName));
      return reply.code(201).header('location', String((user.meta as Body).location)).send(user);
    });
    r.put(`${P}/Users/:id`, async (req) => {
      const { id } = req.params as Id;
      const user = await ctx.scim.replaceUser(baseUrl(ctx, req), id, (req.body ?? {}) as Body);
      audit(req, 'user_update', `user:${id}`, `active=${String(user.active)}`);
      return user;
    });
    r.patch(`${P}/Users/:id`, async (req) => {
      const { id } = req.params as Id;
      const user = await ctx.scim.patchUser(baseUrl(ctx, req), id, (req.body ?? {}) as Body);
      audit(req, 'user_update', `user:${id}`, `active=${String(user.active)}`);
      return user;
    });
    r.delete(`${P}/Users/:id`, async (req, reply) => {
      const { id } = req.params as Id;
      await ctx.scim.deleteUser(id);
      audit(req, 'user_delete', `user:${id}`, ctx.cfg.auth.scim.on_delete);
      return reply.code(204).send();
    });

    // ---- Groups ----
    r.get(`${P}/Groups`, async (req) => ctx.scim.listGroups(baseUrl(ctx, req), listParams(req)));
    r.get(`${P}/Groups/:id`, async (req) => ctx.scim.getGroup(baseUrl(ctx, req), (req.params as Id).id, listParams(req).excludeMembers));
    r.post(`${P}/Groups`, async (req, reply) => {
      const group = await ctx.scim.createGroup(baseUrl(ctx, req), (req.body ?? {}) as Body);
      audit(req, 'group_create', `group:${String(group.id)}`, String(group.displayName));
      return reply.code(201).header('location', String((group.meta as Body).location)).send(group);
    });
    r.put(`${P}/Groups/:id`, async (req) => {
      const { id } = req.params as Id;
      const group = await ctx.scim.replaceGroup(baseUrl(ctx, req), id, (req.body ?? {}) as Body);
      audit(req, 'group_update', `group:${id}`);
      return group;
    });
    r.patch(`${P}/Groups/:id`, async (req) => {
      const { id } = req.params as Id;
      const group = await ctx.scim.patchGroup(baseUrl(ctx, req), id, (req.body ?? {}) as Body);
      audit(req, 'group_update', `group:${id}`);
      return group;
    });
    r.delete(`${P}/Groups/:id`, async (req, reply) => {
      const { id } = req.params as Id;
      await ctx.scim.deleteGroup(id);
      audit(req, 'group_delete', `group:${id}`);
      return reply.code(204).send();
    });
  });
}

/** Admin console: the provisioning token (status, generate/rotate — shown once — and revoke). */
export async function scimAdminRoutes(app: FastifyInstance, ctx: AppContext) {
  app.addHook('preHandler', app.authenticate);
  const requireAdmin = (req: FastifyRequest) => {
    if (!isPlatformAdmin(req.principal!)) throw forbidden('Only administrators can manage SCIM provisioning');
  };
  app.get('/api/admin/scim', async (req) => {
    requireAdmin(req);
    return { ...(await ctx.scim.tokenStatus()), endpoint: baseUrl(ctx, req) };
  });
  app.post('/api/admin/scim/token', async (req) => {
    requireAdmin(req);
    if (ctx.cfg.auth.scim.token) throw forbidden('The SCIM token is set in configuration (auth.scim.token)');
    const token = await ctx.scim.rotateToken(req.principal!.userId);
    ctx.audit.log({ userId: req.principal!.userId, actorType: 'USER', action: 'admin.scim_token_rotate', resource: 'scim', ip: req.ip });
    return { token, ...(await ctx.scim.tokenStatus()), endpoint: baseUrl(ctx, req) };
  });
  app.delete('/api/admin/scim/token', async (req) => {
    requireAdmin(req);
    await ctx.scim.revokeToken();
    ctx.audit.log({ userId: req.principal!.userId, actorType: 'USER', action: 'admin.scim_token_revoke', resource: 'scim', ip: req.ip });
    return { ok: true };
  });
}
