/**
 * Transformations: dbt projects of a workspace, their runs, and the dbt runtime.
 *   GET  /api/dbt/status                                  dbt Core / dbt-duckdb installed? versions
 *   POST /api/admin/dbt/install                           install now (administrators; otherwise on first run)
 *   GET/POST /api/workspaces/:id/dbt/projects             list (members) · create (editors; a starter when no files)
 *   GET/PATCH/DELETE /api/dbt/projects/:id                one project with its files · edit · delete
 *   POST /api/dbt/projects/:id/runs                       {command, select?, exclude?, full_refresh?, wait?}
 *   GET  /api/dbt/projects/:id/runs · GET /api/dbt/runs/:id
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { DBT_COMMANDS } from '../db/schema/sqlite.js';
import { forbidden } from '../services/errors.js';
import { isPlatformAdmin } from '../services/principal.js';

const Schedule = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('manual') }),
  z.object({ kind: z.literal('interval'), minutes: z.number().int().min(5).max(60 * 24 * 7) }),
  z.object({ kind: z.literal('cron'), expression: z.string().min(1).max(120), timezone: z.string().max(64).optional() }),
]);
const Command = z.object({ command: z.enum(DBT_COMMANDS), select: z.string().max(2000).nullable().optional(), exclude: z.string().max(2000).nullable().optional(), full_refresh: z.boolean().optional() });
const Files = z.record(z.string().min(1).max(300), z.string());
const Project = z.object({ name: z.string().min(1).max(120), files: Files.optional(), vars: z.record(z.string(), z.unknown()).optional(), target_schema: z.string().max(63).optional(), schedule: Schedule.optional(), scheduled: Command.optional() });

export async function transformRoutes(app: FastifyInstance, ctx: AppContext) {
  app.addHook('preHandler', app.authenticate);

  app.get('/api/dbt/status', async () => ctx.dbt.status());

  app.post('/api/admin/dbt/install', async (req, reply) => {
    if (!isPlatformAdmin(req.principal!)) throw forbidden('Only administrators can install dbt');
    ctx.audit.log({ userId: req.principal!.userId, actorType: 'USER', action: 'admin.dbt_install', resource: 'dbt', ip: req.ip });
    void ctx.dbt.install().catch(() => undefined);
    return reply.code(202).send(await ctx.dbt.status());
  });

  app.get('/api/workspaces/:id/dbt/projects', async (req) => ({ projects: await ctx.dbt.list(req.principal!, (req.params as { id: string }).id) }));

  app.post('/api/workspaces/:id/dbt/projects', async (req) => {
    const body = Project.parse(req.body);
    return { project: await ctx.dbt.create(req.principal!, (req.params as { id: string }).id, body) };
  });

  app.get('/api/dbt/projects/:id', async (req) => ({ project: await ctx.dbt.get(req.principal!, (req.params as { id: string }).id) }));

  app.patch('/api/dbt/projects/:id', async (req) => {
    const body = Project.partial().extend({ enabled: z.boolean().optional() }).parse(req.body ?? {});
    return { project: await ctx.dbt.update(req.principal!, (req.params as { id: string }).id, body) };
  });

  app.delete('/api/dbt/projects/:id', async (req) => {
    await ctx.dbt.remove(req.principal!, (req.params as { id: string }).id);
    return { ok: true };
  });

  app.post('/api/dbt/projects/:id/runs', async (req) => {
    const body = Command.extend({ wait: z.boolean().optional() }).parse(req.body ?? {});
    const { run, done } = await ctx.dbt.start(req.principal!, (req.params as { id: string }).id, body, req.principal!.actorType === 'AGENT' ? 'agent' : 'manual');
    return { run: body.wait ? await done : run };
  });

  app.get('/api/dbt/projects/:id/runs', async (req) => {
    const q = z.object({ limit: z.coerce.number().int().min(1).max(200).optional() }).parse(req.query ?? {});
    return { runs: await ctx.dbt.runs(req.principal!, (req.params as { id: string }).id, q.limit) };
  });

  app.get('/api/dbt/runs/:id', async (req) => ({ run: await ctx.dbt.getRun(req.principal!, (req.params as { id: string }).id) }));
}
