import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { LAKEHOUSE_PROVIDERS } from '../db/schema/sqlite.js';
import { requireWrite } from '../services/principal.js';

const ConfigSchema = z
  .object({
    region: z.string().optional(),
    account_id: z.string().optional(),
    catalog: z.string().optional(),
    table_bucket_arn: z.string().optional(),
    aws_auth: z.enum(['keys', 'credential_chain']).optional(),
    endpoint: z.string().optional(),
    warehouse: z.string().optional(),
    auth: z.enum(['bearer', 'oauth2', 'none']).optional(),
    oauth2_server_uri: z.string().optional(),
    oauth2_scope: z.string().optional(),
    nested_namespaces: z.boolean().optional(),
    host: z.string().optional(),
    warehouse_id: z.string().optional(),
    unity_catalog: z.string().optional(),
    databricks_auth: z.enum(['pat', 'oauth_m2m']).optional(),
    attach_iceberg: z.boolean().optional(),
  })
  .strict();

export async function lakehouseRoutes(app: FastifyInstance, ctx: AppContext) {
  app.addHook('preHandler', app.authenticate);

  app.get('/api/lakehouse/providers', async () => ctx.lakehouse.providers());

  app.get('/api/lakehouse-connections', async (req) => ({ connections: await ctx.lakehouse.list(req.principal!.userId) }));

  app.post('/api/lakehouse-connections', async (req) => {
    requireWrite(req.principal!);
    const body = z
      .object({
        name: z.string().max(120).default(''),
        provider: z.enum(LAKEHOUSE_PROVIDERS),
        alias: z.string().max(63).nullable().optional(),
        config: ConfigSchema.default({}),
        credentials: z.record(z.string(), z.string()).default({}),
      })
      .parse(req.body);
    const connection = await ctx.lakehouse.create(req.principal!.userId, body);
    ctx.audit.log({ userId: req.principal!.userId, actorType: req.principal!.actorType, action: 'lakehouse.create', resource: `lakehouse:${connection.id}`, ip: req.ip });
    return { connection };
  });

  app.patch('/api/lakehouse-connections/:id', async (req) => {
    requireWrite(req.principal!);
    const { id } = req.params as { id: string };
    const body = z.object({ name: z.string().max(120).optional(), alias: z.string().max(63).optional(), config: ConfigSchema.optional(), credentials: z.record(z.string(), z.string()).optional() }).parse(req.body ?? {});
    const connection = await ctx.lakehouse.update(req.principal!.userId, id, body);
    ctx.audit.log({ userId: req.principal!.userId, actorType: req.principal!.actorType, action: 'lakehouse.update', resource: `lakehouse:${id}`, ip: req.ip });
    return { connection };
  });

  app.delete('/api/lakehouse-connections/:id', async (req) => {
    requireWrite(req.principal!);
    const { id } = req.params as { id: string };
    await ctx.lakehouse.remove(req.principal!.userId, id);
    ctx.audit.log({ userId: req.principal!.userId, actorType: req.principal!.actorType, action: 'lakehouse.delete', resource: `lakehouse:${id}`, ip: req.ip });
    return { ok: true };
  });

  app.post('/api/lakehouse-connections/:id/test', async (req) => {
    const { id } = req.params as { id: string };
    return ctx.lakehouse.test(req.principal!.userId, id);
  });

  /** Lazy tree: ?connection_id&workspace_id[&catalog][&schema] → catalogs | schemas | tables. */
  app.get('/api/lakehouse/browse', async (req) => {
    const q = z.object({ connection_id: z.string(), workspace_id: z.string(), catalog: z.string().optional(), schema: z.string().optional() }).parse(req.query);
    return ctx.lakehouse.browse(req.principal!, q.workspace_id, q.connection_id, { catalog: q.catalog ?? null, schema: q.schema ?? null });
  });

  app.get('/api/lakehouse/:id/inspect', async (req) => {
    const { id } = req.params as { id: string };
    const q = z.object({ table: z.string().min(1) }).parse(req.query);
    return ctx.lakehouse.inspectRemote(req.principal!, id, q.table);
  });

  /** Executes SQL on a Databricks SQL warehouse; rows come back in the same shape as /api/workspaces/:id/query. */
  app.post('/api/lakehouse/:id/query', async (req) => {
    const { id } = req.params as { id: string };
    const body = z.object({ sql: z.string().min(1), workspace_id: z.string().optional(), max_rows: z.number().int().min(1).optional(), dry_run: z.boolean().optional() }).parse(req.body);
    const ac = new AbortController();
    req.raw.on('close', () => ac.abort());
    return ctx.lakehouse.query(req.principal!, id, body.sql, { maxRows: body.max_rows, dryRun: body.dry_run, signal: ac.signal, workspaceId: body.workspace_id });
  });

  app.post('/api/lakehouse/:id/materialize', async (req) => {
    const { id } = req.params as { id: string };
    const body = z.object({ sql: z.string().min(1), table: z.string().min(1).max(128), workspace_id: z.string(), max_rows: z.number().int().min(1).optional() }).parse(req.body);
    return ctx.lakehouse.materialize(req.principal!, body.workspace_id, id, { sql: body.sql, table: body.table, maxRows: body.max_rows });
  });
}
