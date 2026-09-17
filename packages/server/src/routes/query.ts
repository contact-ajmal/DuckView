import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { HitlBlocked } from '../services/query.js';
import { SandboxViolation } from '../engine/sandbox.js';
import { QueryTimeoutError, QueryCancelledError } from '../engine/duckdb.js';
import { HttpError } from '../services/errors.js';
import { metrics } from '../observability/metrics.js';
import type { Principal } from '../services/principal.js';
import { logger } from '../observability/logger.js';
import type { JwtClaims } from './auth-plugin.js';

const QueryBody = z.object({
  sql: z.string().min(1),
  max_rows: z.number().int().min(1).optional(),
  page: z.number().int().min(1).optional(),
  count_total: z.boolean().optional(),
  dry_run: z.boolean().optional(),
});

export async function queryRoutes(app: FastifyInstance, ctx: AppContext) {
  app.post('/api/workspaces/:id/query', { preHandler: app.authenticate }, async (req) => {
    const { id } = req.params as { id: string };
    const body = QueryBody.parse(req.body);
    const result = await ctx.queries.run(req.principal!, id, body.sql, { maxRows: body.max_rows, page: body.page, countTotal: body.count_total, dryRun: body.dry_run });
    const { analysis, guardedSql: _g, ...rest } = result as typeof result & { guardedSql?: string };
    return { ...rest, statements: analysis.statements.map((s) => ({ verb: s.verb, class: s.class })) };
  });

  app.post('/api/workspaces/:id/explain', { preHandler: app.authenticate }, async (req) => {
    const { id } = req.params as { id: string };
    const body = z.object({ sql: z.string().min(1), analyze: z.boolean().optional() }).parse(req.body);
    return ctx.queries.explain(req.principal!, id, body.sql, body.analyze ?? false);
  });

  app.post('/api/workspaces/:id/profile', { preHandler: app.authenticate }, async (req) => {
    const { id } = req.params as { id: string };
    const body = z.object({ target: z.string().min(1) }).parse(req.body);
    return ctx.queries.profile(req.principal!, id, body.target);
  });

  app.get('/api/workspaces/:id/catalog', { preHandler: app.authenticate }, async (req) => {
    const { id } = req.params as { id: string };
    return ctx.queries.catalog(req.principal!, id);
  });

  app.post('/api/workspaces/:id/save', { preHandler: app.authenticate }, async (req) => {
    const { id } = req.params as { id: string };
    const body = z.object({ sql: z.string().min(1), format: z.enum(['parquet', 'csv', 'json']), target: z.string().min(1) }).parse(req.body);
    return ctx.queries.saveDataset(req.principal!, id, { ...body, dryRun: false });
  });

  // ---------------- WebSocket streaming ----------------
  // Protocol: client sends {type:'auth', token} first, then {type:'run', id, workspace_id, sql, max_rows?}
  // or {type:'cancel', id}. Server streams schema → rows* → done | error.
  app.get('/api/ws/query', { websocket: true }, (socket, req) => {
    let principal: Principal | null = null;
    const inflight = new Map<string, AbortController>();
    metrics.wsConnections.inc();
    const send = (msg: Record<string, unknown>) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
    };

    socket.on('message', async (raw) => {
      let msg: { type: string; id?: string; token?: string; workspace_id?: string; sql?: string; max_rows?: number; dry_run?: boolean };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return send({ type: 'error', code: 'BAD_MESSAGE', message: 'Invalid JSON' });
      }
      if (msg.type === 'auth') {
        const token = String(msg.token ?? '');
        try {
          if (token.startsWith('dv_')) principal = await ctx.auth.verifyToken(token, req.ip);
          else {
            const claims = app.jwt.verify<JwtClaims>(token);
            const user = await ctx.auth.findById(claims.sub);
            principal = user ? ctx.auth.principalFromUser(user, 'jwt', req.ip) : null;
          }
        } catch {
          principal = null;
        }
        if (!principal) {
          send({ type: 'error', code: 'UNAUTHORIZED', message: 'Invalid token' });
          return socket.close(4401, 'unauthorized');
        }
        return send({ type: 'ready', user: principal.email });
      }
      if (!principal) return send({ type: 'error', code: 'UNAUTHORIZED', message: 'Send an auth message first' });
      if (msg.type === 'cancel' && msg.id) {
        inflight.get(msg.id)?.abort();
        return;
      }
      if (msg.type === 'run') {
        const id = String(msg.id ?? '');
        const ac = new AbortController();
        inflight.set(id, ac);
        try {
          const out = await ctx.queries.stream(
            principal,
            String(msg.workspace_id ?? ''),
            String(msg.sql ?? ''),
            {
              onSchema: (columns) => send({ type: 'schema', id, columns }),
              onRows: (rows) => send({ type: 'rows', id, rows }),
            },
            { maxRows: msg.max_rows, signal: ac.signal, dryRun: msg.dry_run },
          );
          send({ type: 'done', id, row_count: out.rowCount, duration_ms: out.durationMs, truncated: out.truncated, statements: out.analysis.statements.map((s) => ({ verb: s.verb, class: s.class })) });
        } catch (err) {
          send({ type: 'error', id, ...serializeError(err) });
        } finally {
          inflight.delete(id);
        }
      }
    });
    socket.on('close', () => {
      for (const ac of inflight.values()) ac.abort();
      metrics.wsConnections.dec();
    });
    socket.on('error', (err) => logger().warn({ err }, 'WebSocket error'));
  });
}

export function serializeError(err: unknown): { code: string; message: string; status: number; challenge?: unknown; details?: unknown } {
  if (err instanceof HitlBlocked) return { code: 'APPROVAL_REQUIRED', message: err.message, status: 409, challenge: err.challenge };
  if (err instanceof SandboxViolation) return { code: 'SANDBOX_VIOLATION', message: err.message, status: 403 };
  if (err instanceof QueryTimeoutError) return { code: 'QUERY_TIMEOUT', message: err.message, status: 408 };
  if (err instanceof QueryCancelledError) return { code: 'QUERY_CANCELLED', message: err.message, status: 499 };
  if (err instanceof HttpError) return { code: err.code, message: err.message, status: err.statusCode, details: err.details };
  if (err instanceof z.ZodError) return { code: 'VALIDATION_ERROR', message: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '), status: 400, details: err.issues };
  const e = err as Error & { statusCode?: number; code?: string };
  // DuckDB errors are user-facing SQL errors, not server faults.
  const isDuck = /^(Parser|Binder|Catalog|Conversion|Invalid Input|Constraint|IO|Permission|Out of Memory|Not implemented|Syntax|Dependency|Serialization|Transaction|Internal) Error/i.test(e?.message ?? '');
  if (isDuck) return { code: 'SQL_ERROR', message: e.message, status: 400 };
  return { code: e?.code ?? 'INTERNAL_ERROR', message: e?.message ?? 'Internal error', status: e?.statusCode && e.statusCode >= 400 ? e.statusCode : 500 };
}
