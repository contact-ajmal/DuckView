/**
 * Queries published as HTTP endpoints.
 *   Management (signed in): GET/POST /api/workspaces/:id/endpoints · PATCH/DELETE /api/endpoints/:id ·
 *   POST /api/endpoints/:id/rotate-key
 *   Callers (the endpoint's key, or none when public): GET /q/:slug?param=…[&format=csv]
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { ENDPOINT_PARAM_TYPES } from '../db/schema/sqlite.js';

const Param = z.object({ name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), type: z.enum(ENDPOINT_PARAM_TYPES), required: z.boolean(), default: z.string().max(1000).nullable(), description: z.string().max(300).nullable().optional() });
const Body = z.object({ name: z.string().max(120).optional(), slug: z.string().max(60).optional(), description: z.string().max(1000).nullable().optional(), sql: z.string().max(100_000).optional(), params: z.array(Param).max(50).optional(), public: z.boolean().optional(), max_rows: z.number().int().optional(), rate_per_minute: z.number().int().optional(), enabled: z.boolean().optional() });

export async function endpointAdminRoutes(app: FastifyInstance, ctx: AppContext) {
  app.addHook('preHandler', app.authenticate);
  app.get('/api/workspaces/:id/endpoints', async (req) => ({ endpoints: await ctx.endpoints.list(req.principal!, (req.params as { id: string }).id) }));
  app.post('/api/workspaces/:id/endpoints', async (req) => ctx.endpoints.create(req.principal!, (req.params as { id: string }).id, Body.parse(req.body ?? {})));
  app.patch('/api/endpoints/:id', async (req) => ctx.endpoints.update(req.principal!, (req.params as { id: string }).id, Body.parse(req.body ?? {})));
  app.post('/api/endpoints/:id/rotate-key', async (req) => ctx.endpoints.rotateKey(req.principal!, (req.params as { id: string }).id));
  app.delete('/api/endpoints/:id', async (req) => {
    await ctx.endpoints.remove(req.principal!, (req.params as { id: string }).id);
    return { ok: true };
  });
}

const keyOf = (req: FastifyRequest) => {
  const auth = req.headers.authorization;
  if (auth?.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  const h = req.headers['x-api-key'];
  return (Array.isArray(h) ? h[0] : h) ?? null;
};
const csvCell = (v: unknown) => {
  if (v == null) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export async function endpointPublicRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/q/:slug', async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const query = Object.fromEntries(Object.entries((req.query ?? {}) as Record<string, unknown>).filter(([k, v]) => k !== 'format' && typeof v === 'string')) as Record<string, string>;
    const format = (req.query as { format?: string }).format === 'csv' ? 'csv' : 'json';
    const { endpoint, result } = await ctx.endpoints.call(slug, keyOf(req), query, req.ip);
    reply.header('cache-control', 'no-store');
    if (format === 'csv') {
      reply.header('content-type', 'text/csv; charset=utf-8');
      reply.header('content-disposition', `inline; filename="${endpoint.slug}.csv"`);
      return [result.columns.map((c) => csvCell(c.name)).join(','), ...result.rows.map((r) => r.map(csvCell).join(','))].join('\n') + '\n';
    }
    return {
      endpoint: endpoint.slug,
      columns: result.columns.map((c) => ({ name: c.name, type: c.type })),
      rows: result.rows.map((r) => Object.fromEntries(result.columns.map((c, i) => [c.name, r[i]]))),
      row_count: result.rows.length,
      truncated: result.truncated,
    };
  });
}
