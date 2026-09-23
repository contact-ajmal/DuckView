/**
 * SQL notebooks of a workspace.
 *   GET/POST /api/workspaces/:id/notebooks          list (members) · create (editors)
 *   GET/PATCH/DELETE /api/notebooks/:id             one notebook with its cells and outputs · save {title?, cells?, version} · delete
 *   POST /api/notebooks/:id/cells/:cell/run         {cells?, dry_run?} run one SQL cell (with the cells on screen); editors' outputs are saved
 *   POST /api/notebooks/:id/cells/:cell/compile     {cells?} the SQL it would run
 *   POST /api/notebooks/:id/run                     {dry_run?} run every SQL cell top to bottom
 *   GET  /api/notebooks/:id/export.md               the notebook as Markdown
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { NOTEBOOK_CELL_TYPES } from '../db/schema/sqlite.js';

const Cell = z.object({
  id: z.string().max(40).optional(),
  type: z.enum(NOTEBOOK_CELL_TYPES),
  name: z.string().max(63).nullable().optional(),
  source: z.string().max(200_000).default(''),
  input: z.object({ kind: z.enum(['text', 'number', 'date', 'select']), label: z.string().max(200).nullable().optional(), value: z.string().max(10_000).default(''), options: z.array(z.string().max(500)).max(200).optional() }).nullable().optional(),
  view: z.enum(['table', 'chart']).optional(),
  chart: z.object({ type: z.enum(['bar', 'line', 'area', 'scatter', 'pie', 'none']), x: z.string().optional(), y: z.array(z.string()).optional(), stacked: z.boolean().optional() }).nullable().optional(),
  // Clients echo the output they have (kept as the server stored it) or null to clear it.
  output: z.unknown().optional(),
});
const Cells = z.array(Cell).max(500);

export async function notebookRoutes(app: FastifyInstance, ctx: AppContext) {
  app.addHook('preHandler', app.authenticate);
  const nb = ctx.notebooks;

  app.get('/api/workspaces/:id/notebooks', async (req) => ({ notebooks: await nb.list(req.principal!, (req.params as { id: string }).id) }));
  app.post('/api/workspaces/:id/notebooks', async (req) => {
    const body = z.object({ title: z.string().max(200).optional(), cells: Cells.optional() }).parse(req.body ?? {});
    return { notebook: await nb.create(req.principal!, (req.params as { id: string }).id, body as never) };
  });
  app.get('/api/notebooks/:id', async (req) => ({ notebook: await nb.get(req.principal!, (req.params as { id: string }).id) }));
  app.patch('/api/notebooks/:id', async (req) => {
    const body = z.object({ title: z.string().max(200).optional(), cells: Cells.optional(), version: z.number().int().optional() }).parse(req.body ?? {});
    return { notebook: await nb.update(req.principal!, (req.params as { id: string }).id, body as never) };
  });
  app.delete('/api/notebooks/:id', async (req) => {
    await nb.remove(req.principal!, (req.params as { id: string }).id);
    return { ok: true };
  });
  app.post('/api/notebooks/:id/cells/:cell/run', async (req) => {
    const { id, cell } = req.params as { id: string; cell: string };
    const body = z.object({ cells: Cells.optional(), dry_run: z.boolean().optional() }).parse(req.body ?? {});
    return nb.runCell(req.principal!, id, cell, { cells: body.cells as never, dryRun: body.dry_run });
  });
  app.post('/api/notebooks/:id/cells/:cell/compile', async (req) => {
    const { id, cell } = req.params as { id: string; cell: string };
    const body = z.object({ cells: Cells.optional() }).parse(req.body ?? {});
    return nb.compile(req.principal!, id, cell, body.cells as never);
  });
  app.post('/api/notebooks/:id/run', async (req) => {
    const body = z.object({ dry_run: z.boolean().optional() }).parse(req.body ?? {});
    return nb.runAll(req.principal!, (req.params as { id: string }).id, { dryRun: body.dry_run });
  });
  app.get('/api/notebooks/:id/export.md', async (req, reply) => {
    const { id } = req.params as { id: string };
    const n = await nb.get(req.principal!, id);
    const md = await nb.toMarkdown(req.principal!, id);
    const file = n.title.replace(/[^\w.\- ]+/g, '_').slice(0, 80) || 'notebook';
    return reply.header('content-type', 'text/markdown; charset=utf-8').header('content-disposition', `attachment; filename="${file}.md"`).send(md);
  });
}
