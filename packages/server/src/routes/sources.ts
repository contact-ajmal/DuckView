/**
 * The Connections page: the source catalog, database connections (Postgres / MySQL / SQLite / DuckDB files) and
 * scheduled syncs with their run history. Object storage and lakehouse connections keep their own routes
 * (/api/cloud-connections, /api/lakehouse); this page lists all of them together.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { DATABASE_ENGINES, SYNC_MODES } from '../db/schema/sqlite.js';
import { requireWrite } from '../services/principal.js';
import { SOURCE_CATALOG, FAMILY_LABELS } from '../services/source-catalog.js';
import { googleSheetCsvUrl } from '../services/syncs.js';

const DatabaseConfig = z.object({ host: z.string().max(253).optional(), port: z.coerce.number().int().optional(), database: z.string().max(128).optional(), user: z.string().max(128).optional(), ssl: z.boolean().optional(), path: z.string().max(500).optional(), read_only: z.boolean().optional() });
const Source = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('sql'), sql: z.string().min(1).max(50_000) }),
  z.object({ kind: z.literal('table'), database_connection_id: z.string().nullable().optional(), lakehouse_connection_id: z.string().nullable().optional(), catalog: z.string().nullable().optional(), schema: z.string().min(1), table: z.string().min(1) }),
  z.object({ kind: z.literal('url'), url: z.string().min(1).max(2000), format: z.enum(['auto', 'csv', 'json', 'parquet', 'excel']).default('auto'), options: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(), connection_id: z.string().nullable().optional() }),
  z.object({ kind: z.literal('connector'), connection_id: z.string().min(1).max(64), resource: z.record(z.string().max(64), z.unknown()) }),
]);
const Schedule = z.discriminatedUnion('kind', [z.object({ kind: z.literal('manual') }), z.object({ kind: z.literal('interval'), minutes: z.coerce.number().int().min(1) }), z.object({ kind: z.literal('cron'), expression: z.string().min(5).max(100), timezone: z.string().max(64).optional() })]);
const SyncBody = z.object({ name: z.string().max(160), source: Source, target_table: z.string().max(63), target_schema: z.string().max(63).optional(), mode: z.enum(SYNC_MODES).optional(), transform_sql: z.string().max(50_000).nullable().optional(), schedule: Schedule.optional(), enabled: z.boolean().optional() });

export async function sourceRoutes(app: FastifyInstance, ctx: AppContext) {
  app.addHook('preHandler', app.authenticate);

  // ---- catalog + everything configured, in one call for the page
  app.get('/api/sources/catalog', async () => ({ families: FAMILY_LABELS, sources: SOURCE_CATALOG }));
  app.get('/api/sources', async (req) => {
    const p = req.principal!;
    const [cloud, lakehouse, databases, http, connectors] = await Promise.all([ctx.cloud.list(p.userId), ctx.lakehouse.list(p.userId), ctx.databases.list(p.userId), ctx.connections.list(p.userId), ctx.connectors.list(p.userId)]);
    return { cloud, lakehouse, databases, http: http.filter((c) => c.type === 'HTTP'), connectors, google_configured: !!(await ctx.connectors.googleClient()), mode: ctx.cfg.security.filesystem_mode, external_access: ctx.cfg.security.enable_external_access || ctx.cfg.security.filesystem_mode === 'full' };
  });
  app.get('/api/sources/google-sheet-url', async (req) => {
    const q = z.object({ spreadsheet_id: z.string().min(5).max(200), gid: z.string().max(20).optional() }).parse(req.query ?? {});
    return { url: googleSheetCsvUrl(q.spreadsheet_id, q.gid) };
  });

  // ---- database connections
  app.get('/api/database-connections', async (req) => ({ connections: await ctx.databases.list(req.principal!.userId) }));
  app.post('/api/database-connections', async (req) => {
    requireWrite(req.principal!);
    const body = z.object({ name: z.string().max(120), engine: z.enum(DATABASE_ENGINES), alias: z.string().max(63).optional(), config: DatabaseConfig.default({}), password: z.string().max(1000).nullable().optional() }).parse(req.body ?? {});
    const c = await ctx.databases.create(req.principal!.userId, body);
    // Running engines pick the new attachment up on their next use (attachment fingerprint); the epoch moves so
    // cached results and catalogs refresh.
    await ctx.workspaces.bumpOwnerWorkspaces(req.principal!.userId, 'database_connection_changed');
    ctx.audit.log({ userId: req.principal!.userId, actorType: req.principal!.actorType, action: 'database_connection.create', resource: `database_connection:${c.id}`, ip: req.ip });
    return { connection: c };
  });
  app.patch('/api/database-connections/:id', async (req) => {
    requireWrite(req.principal!);
    const { id } = req.params as { id: string };
    const body = z.object({ name: z.string().max(120).optional(), alias: z.string().max(63).optional(), config: DatabaseConfig.optional(), password: z.string().max(1000).nullable().optional() }).parse(req.body ?? {});
    const c = await ctx.databases.update(req.principal!.userId, id, body);
    await ctx.workspaces.bumpOwnerWorkspaces(req.principal!.userId, 'database_connection_changed');
    return { connection: c };
  });
  app.delete('/api/database-connections/:id', async (req) => {
    requireWrite(req.principal!);
    const { id } = req.params as { id: string };
    await ctx.databases.remove(req.principal!.userId, id);
    await ctx.workspaces.bumpOwnerWorkspaces(req.principal!.userId, 'database_connection_changed');
    ctx.audit.log({ userId: req.principal!.userId, actorType: req.principal!.actorType, action: 'database_connection.delete', resource: `database_connection:${id}`, ip: req.ip });
    return { ok: true };
  });
  app.post('/api/database-connections/:id/test', async (req) => {
    const { id } = req.params as { id: string };
    return ctx.databases.test(req.principal!.userId, id);
  });
  app.get('/api/database-connections/:id/browse', async (req) => {
    const { id } = req.params as { id: string };
    const q = z.object({ schema: z.string().max(128).optional() }).parse(req.query ?? {});
    return ctx.databases.browse(req.principal!.userId, id, q.schema ?? null);
  });

  // ---- syncs
  app.get('/api/workspaces/:id/syncs', async (req) => {
    const { id } = req.params as { id: string };
    return { syncs: await ctx.syncs.list(req.principal!, id) };
  });
  app.post('/api/workspaces/:id/syncs', async (req) => {
    const { id } = req.params as { id: string };
    const body = SyncBody.parse(req.body ?? {});
    const sync = await ctx.syncs.create(req.principal!, id, body);
    ctx.audit.log({ userId: req.principal!.userId, actorType: req.principal!.actorType, action: 'sync.create', resource: `sync:${sync.id}`, ip: req.ip });
    return { sync };
  });
  app.post('/api/workspaces/:id/syncs/preview', async (req) => {
    const { id } = req.params as { id: string };
    const body = z.object({ source: Source, transform_sql: z.string().max(50_000).nullable().optional(), limit: z.coerce.number().int().min(1).max(500).optional() }).parse(req.body ?? {});
    return ctx.syncs.preview(req.principal!, id, body.source, body.transform_sql, body.limit);
  });
  app.get('/api/syncs/:id', async (req) => {
    const { id } = req.params as { id: string };
    return { sync: await ctx.syncs.get(req.principal!, id), runs: await ctx.syncs.runs(req.principal!, id, 30) };
  });
  app.patch('/api/syncs/:id', async (req) => {
    const { id } = req.params as { id: string };
    const body = SyncBody.partial().parse(req.body ?? {});
    return { sync: await ctx.syncs.update(req.principal!, id, body) };
  });
  app.delete('/api/syncs/:id', async (req) => {
    const { id } = req.params as { id: string };
    await ctx.syncs.remove(req.principal!, id);
    ctx.audit.log({ userId: req.principal!.userId, actorType: req.principal!.actorType, action: 'sync.delete', resource: `sync:${id}`, ip: req.ip });
    return { ok: true };
  });
  app.post('/api/syncs/:id/run', async (req) => {
    const p = req.principal!;
    const { id } = req.params as { id: string };
    await ctx.syncs.get(p, id, 'EDITOR');
    requireWrite(p);
    const run = await ctx.syncs.run(id, p.actorType === 'AGENT' ? 'agent' : 'manual', p.userId);
    return { run };
  });
  app.get('/api/syncs/:id/runs', async (req) => {
    const { id } = req.params as { id: string };
    return { runs: await ctx.syncs.runs(req.principal!, id, 100) };
  });
}
