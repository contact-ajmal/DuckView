import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { requireWrite } from '../services/principal.js';
import { CLOUD_PROVIDERS } from '../db/schema/sqlite.js';
import { CLOUD_FIELDS } from '../services/cloud.js';

export async function storageRoutes(app: FastifyInstance, ctx: AppContext) {
  app.addHook('preHandler', app.authenticate);

  // ---- local filesystem tree (jailed; absolute paths allowed only in filesystem_mode=full)
  app.get('/api/storage/local', async (req) => {
    const q = z.object({ workspace_id: z.string().min(1), path: z.string().optional() }).parse(req.query ?? {});
    return ctx.storage.local(req.principal!, q.workspace_id, q.path ?? '.');
  });

  // ---- cloud storage tree
  app.get('/api/storage/cloud', async (req) => {
    const q = z.object({ connection_id: z.string().min(1), bucket: z.string().optional(), prefix: z.string().optional(), token: z.string().optional() }).parse(req.query ?? {});
    if (!q.bucket) return ctx.storage.cloudBuckets(req.principal!, q.connection_id);
    return ctx.storage.cloudObjects(req.principal!, q.connection_id, q.bucket, q.prefix ?? '', q.token);
  });

  // ---- folder picker (directories only)
  app.get('/api/storage/browse', async (req) => {
    const q = z.object({ workspace_id: z.string().min(1), path: z.string().optional() }).parse(req.query ?? {});
    return ctx.storage.browse(req.principal!, q.workspace_id, q.path);
  });

  // ---- workspace folders (VS Code-style "Add folder to workspace")
  app.get('/api/workspaces/:id/folders', async (req) => {
    const { id } = req.params as { id: string };
    const w = await ctx.workspaces.get(req.principal!, id);
    return { folders: w.folders, data_directory: ctx.workspaces.jail.baseDir, mode: ctx.cfg.security.filesystem_mode };
  });
  app.post('/api/workspaces/:id/folders', async (req) => {
    requireWrite(req.principal!);
    const { id } = req.params as { id: string };
    const body = z.object({ path: z.string().min(1), name: z.string().max(120).optional() }).parse(req.body);
    const folders = await ctx.workspaces.addFolder(req.principal!, id, body.path, body.name);
    ctx.audit.log({ userId: req.principal!.userId, actorType: req.principal!.actorType, action: 'workspace.folder_add', resource: `folder:${body.path}`, ip: req.ip });
    return { folders };
  });
  app.delete('/api/workspaces/:id/folders', async (req) => {
    requireWrite(req.principal!);
    const { id } = req.params as { id: string };
    const q = z.object({ path: z.string().min(1) }).parse(req.query ?? {});
    const folders = await ctx.workspaces.removeFolder(req.principal!, id, q.path);
    ctx.audit.log({ userId: req.principal!.userId, actorType: req.principal!.actorType, action: 'workspace.folder_remove', resource: `folder:${q.path}`, ip: req.ip });
    return { folders };
  });

  // ---- instant schema inspection (DESCRIBE … LIMIT 0)
  app.post('/api/storage/inspect', async (req) => {
    const body = z.object({ workspace_id: z.string().min(1), target: z.string().min(1) }).parse(req.body);
    return ctx.storage.inspect(req.principal!, body.workspace_id, body.target);
  });

  // ---- cloud connection wizard backend
  app.get('/api/cloud-connections/providers', async () => ({ providers: CLOUD_FIELDS, external_access_enabled: ctx.storage.externalAccess }));

  app.get('/api/cloud-connections', async (req) => ({ connections: await ctx.cloud.list(req.principal!.userId) }));

  const Body = z.object({
    name: z.string().max(120),
    provider: z.enum(CLOUD_PROVIDERS),
    endpoint_url: z.string().max(500).nullable().optional(),
    region: z.string().max(60).nullable().optional(),
    bucket: z.string().max(255).nullable().optional(),
    credentials: z.record(z.string(), z.string()),
  });

  app.post('/api/cloud-connections', async (req) => {
    requireWrite(req.principal!);
    const body = Body.parse(req.body);
    const c = await ctx.cloud.create(req.principal!.userId, body);
    ctx.audit.log({ userId: req.principal!.userId, actorType: req.principal!.actorType, action: 'cloud_connection.create', resource: `cloud:${c.id}`, ip: req.ip });
    // Running engines receive the secret on their next query (hot-applied; in-memory tables are preserved).
    return { connection: c };
  });

  app.patch('/api/cloud-connections/:id', async (req) => {
    requireWrite(req.principal!);
    const { id } = req.params as { id: string };
    const body = Body.partial().omit({ provider: true }).parse(req.body ?? {});
    const c = await ctx.cloud.update(req.principal!.userId, id, body);
    ctx.audit.log({ userId: req.principal!.userId, actorType: req.principal!.actorType, action: 'cloud_connection.update', resource: `cloud:${id}`, ip: req.ip });
    return { connection: c };
  });

  app.delete('/api/cloud-connections/:id', async (req) => {
    requireWrite(req.principal!);
    const { id } = req.params as { id: string };
    await ctx.cloud.remove(req.principal!.userId, id);
    ctx.audit.log({ userId: req.principal!.userId, actorType: req.principal!.actorType, action: 'cloud_connection.delete', resource: `cloud:${id}`, ip: req.ip });
    return { ok: true };
  });

  app.post('/api/cloud-connections/:id/test', async (req) => {
    const { id } = req.params as { id: string };
    const c = await ctx.cloud.getOwned(req.principal!.userId, id);
    const result = await ctx.cloud.test(c);
    ctx.audit.log({ userId: req.principal!.userId, actorType: req.principal!.actorType, action: 'cloud_connection.test', resource: `cloud:${id}`, ip: req.ip });
    return { ...result, queryable: ctx.storage.externalAccess, uri_example: `${CLOUD_FIELDS[c.provider].uri}://${c.bucket ?? 'bucket'}/path/file.parquet` };
  });
}
