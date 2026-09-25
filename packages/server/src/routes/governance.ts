/**
 * Governance: access policies (row- and column-level security) of a workspace — managed by its owners — what a member
 * may know about their own restrictions, and a preview of a query as another member would see it.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { MASK_KINDS, AUDIT_SINK_TYPES } from '../db/schema/sqlite.js';
import { badRequest } from '../services/errors.js';

const Mask = z.union([z.object({ kind: z.enum(MASK_KINDS.filter((k) => k !== 'expression') as ['null', 'redact', 'hash', 'partial']) }), z.object({ kind: z.literal('expression'), sql: z.string().max(2000) })]);
const PolicyBody = z.object({
  name: z.string().max(120).optional(),
  description: z.string().max(2000).nullable().optional(),
  table_name: z.string().max(300),
  row_filter: z.string().max(5000).nullable().optional(),
  column_masks: z.record(z.string().max(200), Mask).optional(),
  applies_to: z.object({ all: z.boolean().optional(), embeds: z.boolean().optional(), roles: z.array(z.enum(['VIEWER', 'EDITOR'])).optional(), users: z.array(z.string().max(64)).max(500).optional(), groups: z.array(z.string().max(64)).max(200).optional() }).optional(),
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
  // ---- watches: schema drift and freshness of a dataset
  const Watch = z.object({ target: z.string().min(1).max(2000).optional(), watch_schema: z.boolean().optional(), max_age_hours: z.number().int().min(1).max(8760).nullable().optional(), time_column: z.string().max(200).nullable().optional(), check_every_minutes: z.number().int().min(5).max(10080).optional(), channel_ids: z.array(z.string().max(64)).max(20).optional(), enabled: z.boolean().optional() });
  app.get('/api/workspaces/:id/watches', async (req) => ({ watches: await ctx.watches.list(req.principal!, (req.params as { id: string }).id) }));
  app.post('/api/workspaces/:id/watches', async (req) => ({ watch: await ctx.watches.create(req.principal!, (req.params as { id: string }).id, Watch.parse(req.body ?? {})) }));
  app.patch('/api/watches/:id', async (req) => ({ watch: await ctx.watches.update(req.principal!, (req.params as { id: string }).id, Watch.parse(req.body ?? {})) }));
  app.delete('/api/watches/:id', async (req) => {
    await ctx.watches.remove(req.principal!, (req.params as { id: string }).id);
    return { ok: true };
  });
  app.post('/api/watches/:id/check', async (req) => ({ watch: await ctx.watches.check(req.principal!, (req.params as { id: string }).id) }));
  app.post('/api/watches/:id/accept', async (req) => ({ watch: await ctx.watches.accept(req.principal!, (req.params as { id: string }).id) }));

  // ---- personal data: find it, tag it in the catalog, mask it with a policy
  const PII_KINDS = ['email', 'phone', 'card', 'iban', 'national_id', 'ip', 'birth_date', 'address', 'person_name'] as const;
  app.post('/api/workspaces/:id/pii/scan', async (req) => {
    const body = z.object({ tables: z.array(z.string().max(300)).max(500).optional(), sample: z.number().int().min(20).max(5000).optional() }).parse(req.body ?? {});
    return { findings: await ctx.pii.scan(req.principal!, (req.params as { id: string }).id, body) };
  });
  app.post('/api/workspaces/:id/pii/tag', async (req) => {
    const body = z.object({ items: z.array(z.object({ object: z.string().min(1), column: z.string().min(1), kind: z.enum(PII_KINDS) })).min(1).max(1000) }).parse(req.body ?? {});
    return { tagged: await ctx.pii.tag(req.principal!, (req.params as { id: string }).id, body.items) };
  });
  app.post('/api/workspaces/:id/pii/protect', async (req) => {
    const body = z.object({ table: z.string().min(1).max(300), columns: z.record(z.string(), z.enum(['null', 'redact', 'hash', 'partial'])) }).parse(req.body ?? {});
    return { policy: await ctx.pii.protect(req.principal!, (req.params as { id: string }).id, body.table, body.columns) };
  });

  // ---- how tables join: declared foreign keys and relationships inferred from names, confirmed on the data
  app.get('/api/workspaces/:id/joins', async (req) => {
    const qs = z.object({ tables: z.string().max(20_000).optional() }).parse(req.query ?? {});
    return ctx.joins.discover(req.principal!, (req.params as { id: string }).id, { tables: qs.tables ? qs.tables.split(',').map((t) => t.trim()).filter(Boolean) : undefined });
  });

  app.get('/api/workspaces/:id/lineage', async (req) => ctx.lineage.graph(req.principal!, (req.params as { id: string }).id));

  // ---------------------------------------------------------------- audit export (administrators)
  const SinkBody = z.object({ name: z.string().max(120), type: z.enum(AUDIT_SINK_TYPES), enabled: z.boolean().optional(), config: z.record(z.string(), z.unknown()).optional(), secret: z.object({ token: z.string().max(500).optional(), api_key: z.string().max(500).optional(), username: z.string().max(200).optional(), password: z.string().max(500).optional(), signing_secret: z.string().max(200).optional() }).optional(), backfill: z.boolean().optional() });
  const ax = ctx.auditExport;
  app.get('/api/admin/audit-sinks', async (req) => ({ sinks: await ax.list(req.principal!) }));
  app.post('/api/admin/audit-sinks', async (req) => ax.create(req.principal!, SinkBody.parse(req.body ?? {})));
  app.patch('/api/admin/audit-sinks/:id', async (req) => ({ sink: await ax.update(req.principal!, (req.params as { id: string }).id, SinkBody.partial().parse(req.body ?? {})) }));
  app.delete('/api/admin/audit-sinks/:id', async (req) => {
    await ax.remove(req.principal!, (req.params as { id: string }).id);
    return { ok: true };
  });
  app.post('/api/admin/audit-sinks/:id/test', async (req) => ax.test(req.principal!, (req.params as { id: string }).id));
}
