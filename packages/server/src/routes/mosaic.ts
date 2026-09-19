/**
 * POST /api/workspaces/:id/mosaic — the Mosaic connector endpoint.
 *   { type: "arrow", sql }  → application/vnd.apache.arrow.stream (ETag / If-None-Match → 304)
 *   { type: "json",  sql }  → { columns, rows, row_count, truncated, etag, cached, computed_at }
 *   { type: "exec",  sql }  → { ok, statements, duration_ms }   (pre-aggregation plumbing only, see MosaicService)
 * POST /api/workspaces/:id/mosaic/prepare — validate a spec and turn its data definitions into source-view statements.
 * GET /api/mosaic/info — schema name and limits for the client.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { NotModified } from '../services/cache.js';
import { parseSpecText } from '../services/mosaic-spec.js';
import { badRequest } from '../services/errors.js';
import { conditionalOpts } from './conditional.js';

const Body = z.object({ type: z.enum(['arrow', 'json', 'exec']), sql: z.string().min(1), refresh: z.boolean().optional() });

export async function mosaicRoutes(app: FastifyInstance, ctx: AppContext) {
  app.addHook('preHandler', app.authenticate);

  app.get('/api/mosaic/info', async () => ({ enabled: ctx.mosaic.enabled, schema: ctx.mosaic.schema, max_rows: ctx.cfg.mosaic.max_rows }));

  app.post('/api/workspaces/:id/mosaic/prepare', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ spec: z.record(z.string(), z.unknown()).optional(), spec_text: z.string().optional(), bind: z.boolean().optional() }).parse(req.body ?? {});
    const spec = body.spec ?? (body.spec_text !== undefined ? parseSpecText(body.spec_text) : null);
    if (!spec) throw badRequest('Provide spec (object) or spec_text (YAML/JSON)');
    reply.header('cache-control', 'no-store');
    const r = await ctx.mosaic.prepare(req.principal!, id, spec, { bind: body.bind });
    return { ok: r.ok, errors: r.errors, warnings: r.warnings, spec: r.spec, statements: r.statements, sources: r.sources.map(({ name, view, kind }) => ({ name, view, kind })), tables: r.tables };
  });

  app.post('/api/workspaces/:id/mosaic', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = Body.parse(req.body);
    const c = conditionalOpts(req);
    reply.header('cache-control', 'no-store');
    if (body.type === 'exec') {
      const r = await ctx.mosaic.exec(req.principal!, id, body.sql);
      return { ok: true, ...r };
    }
    try {
      if (body.type === 'arrow') {
        const r = await ctx.mosaic.queryArrow(req.principal!, id, body.sql, c);
        if (r.meta.etag) reply.header('etag', `"${r.meta.etag}"`);
        reply.header('x-duckview-cached', r.meta.cached ? '1' : '0');
        reply.header('x-duckview-rows', String(r.rowCount));
        if (r.truncated) reply.header('x-duckview-truncated', '1');
        return reply.type('application/vnd.apache.arrow.stream').send(Buffer.from(r.bytes.buffer, r.bytes.byteOffset, r.bytes.byteLength));
      }
      const r = await ctx.mosaic.query(req.principal!, id, body.sql, c);
      if (r.etag) reply.header('etag', `"${r.etag}"`);
      return { columns: r.columns, rows: r.rows, row_count: r.rowCount, truncated: r.truncated, etag: r.etag, cached: r.cached, computed_at: r.computed_at };
    } catch (err) {
      if (err instanceof NotModified) {
        reply.code(304).header('etag', `"${err.etag}"`);
        return reply.send();
      }
      throw err;
    }
  });
}
