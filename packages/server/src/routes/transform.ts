/**
 * Transformations: dbt projects of a workspace, their runs, and the dbt runtime.
 *   GET  /api/dbt/status                                  dbt Core / dbt-duckdb installed? versions
 *   POST /api/admin/dbt/install                           install now (administrators; otherwise on first run)
 *   GET/POST /api/workspaces/:id/dbt/projects             list (members) · create (editors; a starter when no files)
 *   GET/PATCH/DELETE /api/dbt/projects/:id                one project with its files · edit · delete
 *   POST /api/dbt/projects/:id/runs                       {command, select?, exclude?, full_refresh?, wait?, dry_run?}
 *   PATCH /api/dbt/projects/:id/files                     {files: {path: content | null}} (null deletes)
 *   POST /api/dbt/projects/:id/models                     {name, sql, folder?, materialized?, unique_key?, description?}
 *   GET  /api/dbt/projects/:id/runs · GET /api/dbt/runs/:id
 * Semantic layer (metrics) of a workspace:
 *   GET/PUT /api/workspaces/:id/semantic                   definitions (merged sources) · save the hand-written YAML
 *   POST .../semantic/validate · .../semantic/query · .../semantic/scaffold · GET .../semantic/dimensions?metrics=
 * Data quality suites of a workspace:
 *   GET/POST /api/workspaces/:id/quality/suites               list (with dbt tests) · create (editors)
 *   POST /api/workspaces/:id/quality/preview · .../quality/suggest   try checks unsaved · checks the data satisfies today
 *   GET/PATCH/DELETE /api/quality/suites/:id                  one suite with its latest run · edit · delete
 *   POST /api/quality/suites/:id/run · GET .../runs · GET /api/quality/runs/:id
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { DBT_COMMANDS, QUALITY_CHECK_TYPES } from '../db/schema/sqlite.js';
import { forbidden } from '../services/errors.js';
import { isPlatformAdmin } from '../services/principal.js';
import { FILTER_OPS, parseDefinition } from '../services/semantic.js';

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

  // Agent tokens: build / run / seed answer 409 APPROVAL_REQUIRED with a challenge until repeated with dry_run: false.
  app.post('/api/dbt/projects/:id/runs', async (req) => {
    const body = Command.extend({ wait: z.boolean().optional(), dry_run: z.boolean().optional() }).parse(req.body ?? {});
    const { run, done } = await ctx.dbt.start(req.principal!, (req.params as { id: string }).id, body, req.principal!.actorType === 'AGENT' ? 'agent' : 'manual', { approved: body.dry_run === false });
    return { run: body.wait ? await done : run };
  });

  app.patch('/api/dbt/projects/:id/files', async (req) => {
    const body = z.object({ files: z.record(z.string().min(1).max(300), z.string().nullable()) }).parse(req.body ?? {});
    return { project: await ctx.dbt.writeFiles(req.principal!, (req.params as { id: string }).id, body.files) };
  });

  /** A SELECT (from the workbench or Copilot) as a model of the project; references to its models become ref(). */
  app.post('/api/dbt/projects/:id/models', async (req) => {
    const body = z.object({ name: z.string().min(1).max(63), sql: z.string().min(1).max(200_000), folder: z.string().max(200).nullable().optional(), materialized: z.enum(['view', 'table', 'incremental']).optional(), unique_key: z.string().max(200).nullable().optional(), description: z.string().max(4000).nullable().optional(), overwrite: z.boolean().optional() }).parse(req.body ?? {});
    const r = await ctx.dbt.addModel(req.principal!, (req.params as { id: string }).id, body);
    return { project: r.project, path: r.path, sql: r.sql, refs: r.refs };
  });

  app.get('/api/dbt/projects/:id/runs', async (req) => {
    const q = z.object({ limit: z.coerce.number().int().min(1).max(200).optional() }).parse(req.query ?? {});
    return { runs: await ctx.dbt.runs(req.principal!, (req.params as { id: string }).id, q.limit) };
  });

  // ---------------------------------------------------------------- semantic layer (metrics)
  const MetricQuery = z.object({
    metrics: z.array(z.string().min(1).max(120)).min(1).max(30),
    group_by: z.array(z.string().min(1).max(200)).max(10).optional(),
    where: z.array(z.object({ dimension: z.string().min(1).max(200), op: z.enum(FILTER_OPS), value: z.unknown().optional() })).max(20).optional(),
    where_sql: z.string().max(4000).nullable().optional(),
    order_by: z.array(z.object({ name: z.string().min(1).max(200), desc: z.boolean().optional() })).max(10).optional(),
    limit: z.number().int().min(1).max(1_000_000).optional(),
  });

  app.get('/api/workspaces/:id/semantic', async (req) => ctx.semantic.get(req.principal!, (req.params as { id: string }).id));

  app.put('/api/workspaces/:id/semantic', async (req) => {
    const body = z.object({ yaml: z.string().max(2_000_000), force: z.boolean().optional() }).parse(req.body ?? {});
    return ctx.semantic.save(req.principal!, (req.params as { id: string }).id, body.yaml, { force: body.force });
  });

  /** Parses and checks YAML against the engine without saving: {ok, problems}. */
  app.post('/api/workspaces/:id/semantic/validate', async (req) => {
    const { id } = req.params as { id: string };
    const body = z.object({ yaml: z.string().max(2_000_000) }).parse(req.body ?? {});
    await ctx.workspaces.get(req.principal!, id);
    try {
      const def = parseDefinition(body.yaml);
      const problems = await ctx.semantic.validate(req.principal!, id, def);
      return { ok: problems.length === 0, problems, models: def.semantic_models.length, metrics: def.metrics.length };
    } catch (err) {
      const e = err as Error & { details?: { problems?: string[] } };
      return { ok: false, problems: e.details?.problems ?? [e.message], models: 0, metrics: 0 };
    }
  });

  app.post('/api/workspaces/:id/semantic/query', async (req) => {
    const { id } = req.params as { id: string };
    const body = MetricQuery.extend({ compile_only: z.boolean().optional() }).parse(req.body ?? {});
    if (body.compile_only) return { sql: (await ctx.semantic.compile(req.principal!, id, body)).sql };
    const r = await ctx.semantic.query(req.principal!, id, body);
    return { sql: r.sql, metrics: r.metrics, group_by: r.group_by, columns: r.result.columns, rows: r.result.rows, row_count: r.result.rowCount, truncated: r.result.truncated, duration_ms: r.result.durationMs };
  });

  app.get('/api/workspaces/:id/semantic/dimensions', async (req) => {
    const q = z.object({ metrics: z.string().optional() }).parse(req.query ?? {});
    return { dimensions: await ctx.semantic.dimensions(req.principal!, (req.params as { id: string }).id, (q.metrics ?? '').split(',').map((m) => m.trim()).filter(Boolean)) };
  });

  app.post('/api/workspaces/:id/semantic/scaffold', async (req) => {
    const body = z.object({ table: z.string().min(1).max(200) }).parse(req.body ?? {});
    return { yaml: await ctx.semantic.scaffold(req.principal!, (req.params as { id: string }).id, body.table) };
  });

  // ---------------------------------------------------------------- data quality
  const Check = z.object({
    id: z.string().max(40).optional(),
    type: z.enum(QUALITY_CHECK_TYPES),
    column: z.string().max(200).nullable().optional(),
    values: z.array(z.union([z.string().max(500), z.number(), z.boolean()])).max(500).optional(),
    min: z.number().nullable().optional(),
    max: z.number().nullable().optional(),
    to: z.string().max(300).nullable().optional(),
    to_column: z.string().max(200).nullable().optional(),
    expression: z.string().max(4000).nullable().optional(),
    sql: z.string().max(100_000).nullable().optional(),
    max_age_hours: z.number().positive().nullable().optional(),
    where: z.string().max(4000).nullable().optional(),
    severity: z.enum(['warn', 'error']).optional(),
    tolerance: z.number().int().min(0).optional(),
    description: z.string().max(300).nullable().optional(),
  });
  const Suite = z.object({ name: z.string().max(120).optional(), description: z.string().max(2000).nullable().optional(), relation: z.string().min(1).max(300), checks: z.array(Check).max(200).optional(), schedule: Schedule.optional(), channel_ids: z.array(z.string().max(64)).max(20).optional(), enabled: z.boolean().optional() });

  app.get('/api/workspaces/:id/quality/suites', async (req) => {
    const { id } = req.params as { id: string };
    return { suites: await ctx.quality.list(req.principal!, id), dbt_tests: await ctx.quality.dbtTests(req.principal!, id) };
  });

  app.post('/api/workspaces/:id/quality/suites', async (req) => ({ suite: await ctx.quality.create(req.principal!, (req.params as { id: string }).id, Suite.parse(req.body ?? {})) }));

  app.post('/api/workspaces/:id/quality/preview', async (req) => {
    const body = z.object({ relation: z.string().min(1).max(300), checks: z.array(Check).min(1).max(200) }).parse(req.body ?? {});
    return ctx.quality.preview(req.principal!, (req.params as { id: string }).id, body.relation, body.checks);
  });

  app.post('/api/workspaces/:id/quality/suggest', async (req) => {
    const body = z.object({ relation: z.string().min(1).max(300) }).parse(req.body ?? {});
    return { checks: await ctx.quality.suggest(req.principal!, (req.params as { id: string }).id, body.relation) };
  });

  app.get('/api/quality/suites/:id', async (req) => {
    const { id } = req.params as { id: string };
    return { suite: await ctx.quality.get(req.principal!, id), latest: await ctx.quality.latest(req.principal!, id) };
  });

  app.patch('/api/quality/suites/:id', async (req) => ({ suite: await ctx.quality.update(req.principal!, (req.params as { id: string }).id, Suite.partial().parse(req.body ?? {})) }));

  app.delete('/api/quality/suites/:id', async (req) => {
    await ctx.quality.remove(req.principal!, (req.params as { id: string }).id);
    return { ok: true };
  });

  /** Runs the suite now (editors) and delivers a changed status. */
  app.post('/api/quality/suites/:id/run', async (req) => {
    const { id } = req.params as { id: string };
    await ctx.quality.get(req.principal!, id, 'EDITOR');
    const r = await ctx.quality.run(id, req.principal!.actorType === 'AGENT' ? 'agent' : 'manual', req.principal!);
    return { suite: r.suite, run: r.run, changed: r.changed };
  });

  app.get('/api/quality/suites/:id/runs', async (req) => {
    const q = z.object({ limit: z.coerce.number().int().min(1).max(200).optional() }).parse(req.query ?? {});
    return { runs: await ctx.quality.runs(req.principal!, (req.params as { id: string }).id, q.limit) };
  });

  app.get('/api/quality/runs/:id', async (req) => ({ run: await ctx.quality.getRun(req.principal!, (req.params as { id: string }).id) }));

  app.get('/api/dbt/runs/:id', async (req) => ({ run: await ctx.dbt.getRun(req.principal!, (req.params as { id: string }).id) }));
}
