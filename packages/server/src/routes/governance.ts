/**
 * Governance: access policies (row- and column-level security) of a workspace — managed by its owners — what a member
 * may know about their own restrictions, and a preview of a query as another member would see it.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { MASK_KINDS } from '../db/schema/sqlite.js';
import { badRequest } from '../services/errors.js';

const Mask = z.union([z.object({ kind: z.enum(MASK_KINDS.filter((k) => k !== 'expression') as ['null', 'redact', 'hash', 'partial']) }), z.object({ kind: z.literal('expression'), sql: z.string().max(2000) })]);
const PolicyBody = z.object({
  name: z.string().max(120).optional(),
  description: z.string().max(2000).nullable().optional(),
  table_name: z.string().max(300),
  row_filter: z.string().max(5000).nullable().optional(),
  column_masks: z.record(z.string().max(200), Mask).optional(),
  applies_to: z.object({ all: z.boolean().optional(), roles: z.array(z.enum(['VIEWER', 'EDITOR'])).optional(), users: z.array(z.string().max(64)).max(500).optional(), groups: z.array(z.string().max(64)).max(200).optional() }).optional(),
  enabled: z.boolean().optional(),
});

export async function governanceRoutes(app: FastifyInstance, ctx: AppContext) {
  app.addHook('preHandler', app.authenticate);
  const pol = ctx.policies;
  app.get('/api/workspaces/:id/policies', async (req) => ({ policies: await pol.list(req.principal!, (req.params as { id: string }).id) }));
  app.post('/api/workspaces/:id/policies', async (req) => ({ policy: await pol.create(req.principal!, (req.params as { id: string }).id, PolicyBody.parse(req.body ?? {})) }));
  app.get('/api/workspaces/:id/policies/mine', async (req) => pol.mine(req.principal!, (req.params as { id: string }).id));
  app.patch('/api/policies/:id', async (req) => ({ policy: await pol.update(req.principal!, (req.params as { id: string }).id, PolicyBody.partial().parse(req.body ?? {})) }));
  app.delete('/api/policies/:id', async (req) => {
    await pol.remove(req.principal!, (req.params as { id: string }).id);
    return { ok: true };
  });
  /** Owners: runs a query as a member would see it (the rewritten SQL and the first rows). */
  app.post('/api/workspaces/:id/policies/preview', async (req) => {
    const { id } = req.params as { id: string };
    const body = z.object({ sql: z.string().max(100_000), as_user_id: z.string().max(64) }).parse(req.body ?? {});
    await pol.list(req.principal!, id); // owners only
    const user = await ctx.auth.findById(body.as_user_id);
    if (!user) throw badRequest('Unknown user');
    const as = ctx.auth.principalFromUser(user, 'token', req.ip);
    const role = (await ctx.workspaces.get(as, id).catch(() => null))?.role;
    if (!role) throw badRequest(`${user.email} is not a member of this workspace`);
    const r = await pol.restrictionFor(as, id, role);
    const { engine } = await ctx.workspaces.engine(req.principal!, id);
    const sql = r ? await pol.rewrite(engine, body.sql, r) : body.sql;
    const result = await engine.execute(sql, { maxRows: 100 });
    ctx.audit.log({ userId: req.principal!.userId, actorType: req.principal!.actorType, action: 'policy.preview', resource: `workspace:${id}`, queryText: body.sql, ip: req.ip });
    return { as: { id: user.id, email: user.email, role }, restricted: !!r, policies: (r?.policies ?? []).map((x) => ({ id: x.id, name: x.name, table: x.table_name })), sql, columns: result.columns, rows: result.rows, row_count: result.rowCount };
  });

  // ---------------------------------------------------------------- catalog & lineage
  app.get('/api/workspaces/:id/catalog/annotated', async (req) => ({ objects: await ctx.lineage.catalog(req.principal!, (req.params as { id: string }).id) }));
  app.put('/api/workspaces/:id/catalog/annotations', async (req) => {
    const body = z.object({ object_name: z.string().max(300), column_name: z.string().max(200).nullable().optional(), description: z.string().max(4000).nullable().optional(), tags: z.array(z.string().max(40)).max(20).optional() }).parse(req.body ?? {});
    return { annotation: await ctx.lineage.annotate(req.principal!, (req.params as { id: string }).id, body) };
  });
  app.get('/api/workspaces/:id/lineage', async (req) => ctx.lineage.graph(req.principal!, (req.params as { id: string }).id));
}
