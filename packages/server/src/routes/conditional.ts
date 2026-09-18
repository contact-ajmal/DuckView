/**
 * HTTP glue for the result cache: conditional requests and ETag headers.
 *   - `If-None-Match: "<etag>"` → the service short-circuits to 304 when the key still matches;
 *   - `X-DuckView-Refresh: 1` (or `refresh: true` in the body) recomputes and re-stores;
 *   - every cacheable response carries `ETag` plus `cached` / `computed_at` in the JSON body.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { NotModified, type CacheMeta } from '../services/cache.js';

export interface ConditionalOpts {
  ifNoneMatch: string | null;
  refresh: boolean;
}

export function conditionalOpts(req: FastifyRequest): ConditionalOpts {
  const h = req.headers['if-none-match'];
  const body = (req.body ?? {}) as { refresh?: unknown };
  return {
    ifNoneMatch: typeof h === 'string' && h.trim() ? h.trim() : null,
    refresh: req.headers['x-duckview-refresh'] === '1' || body.refresh === true,
  };
}

/** Runs a cacheable handler; answers 304 on NotModified, otherwise stamps the ETag and returns the payload. */
export async function conditional<T extends CacheMeta>(req: FastifyRequest, reply: FastifyReply, fn: (opts: ConditionalOpts) => Promise<T>): Promise<T | undefined> {
  const opts = conditionalOpts(req);
  try {
    const out = await fn(opts);
    reply.header('cache-control', 'no-store');
    if (out.etag) reply.header('etag', `"${out.etag}"`);
    return out;
  } catch (err) {
    if (err instanceof NotModified) {
      reply.code(304).header('etag', `"${err.etag}"`).header('cache-control', 'no-store');
      await reply.send();
      return undefined;
    }
    throw err;
  }
}
