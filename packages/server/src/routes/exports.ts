import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';

export async function exportRoutes(app: FastifyInstance, ctx: AppContext) {
  app.addHook('preHandler', app.authenticate);

  // Runs COPY … TO on the server; returns a record with a download id. Nothing is buffered in Node.
  app.post('/api/workspaces/:id/export', async (req) => {
    const { id } = req.params as { id: string };
    const body = z.object({ sql: z.string().min(1), format: z.enum(['parquet', 'csv', 'json', 'arrow']), filename: z.string().max(120).optional() }).parse(req.body);
    const record = await ctx.exports.create(req.principal!, id, body);
    const { path: _p, ...pub } = record;
    return { export: { ...pub, download_url: `/api/exports/${record.id}/download` } };
  });

  app.get('/api/exports', async (req) => ({ exports: ctx.exports.list(req.principal!).map(({ path: _p, ...r }) => ({ ...r, download_url: `/api/exports/${r.id}/download` })) }));

  app.get('/api/exports/:id/download', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { record, stream } = ctx.exports.open(req.principal!, id);
    reply.header('content-type', record.content_type);
    reply.header('content-length', String(record.size_bytes));
    reply.header('content-disposition', `attachment; filename="${record.name.replace(/"/g, '')}"`);
    reply.header('cache-control', 'no-store');
    return reply.send(stream);
  });

  app.delete('/api/exports/:id', async (req) => {
    const { id } = req.params as { id: string };
    ctx.exports.remove(req.principal!, id);
    return { ok: true };
  });
}
