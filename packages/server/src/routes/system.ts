import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { renderMetrics, registry } from '../observability/metrics.js';
import { DuckDBInstance } from '@duckdb/node-api';
import { unauthorized } from '../services/errors.js';
import { sampleCpu, dirUsage } from '../observability/system.js';
import os from 'node:os';

let duckdbVersion: string | null = null;
async function getDuckDbVersion(): Promise<string> {
  if (duckdbVersion) return duckdbVersion;
  const inst = await DuckDBInstance.create(':memory:');
  const c = await inst.connect();
  duckdbVersion = String((await c.runAndReadAll('SELECT version()')).getRowsJson()[0]?.[0] ?? 'unknown');
  c.closeSync();
  inst.closeSync();
  return duckdbVersion;
}

export async function systemRoutes(app: FastifyInstance, ctx: AppContext) {
  // Liveness: the process is up and the event loop responds.
  app.get('/healthz', async () => ({ status: 'ok', uptime_s: Math.round(process.uptime()) }));

  // Readiness: metadata store reachable, data jail writable, DuckDB loadable.
  app.get('/readyz', async (_req, reply) => {
    const checks: Record<string, { ok: boolean; detail?: string }> = {};
    checks.metadata_store = { ok: await ctx.store.ping(), detail: ctx.store.dialect };
    try {
      const { accessSync, constants } = await import('node:fs');
      accessSync(ctx.engines.jail.baseDir, constants.R_OK | constants.W_OK);
      checks.data_directory = { ok: true, detail: ctx.engines.jail.baseDir };
    } catch (err) {
      checks.data_directory = { ok: false, detail: (err as Error).message };
    }
    try {
      checks.duckdb = { ok: true, detail: await getDuckDbVersion() };
    } catch (err) {
      checks.duckdb = { ok: false, detail: (err as Error).message };
    }
    const ok = Object.values(checks).every((c) => c.ok);
    return reply.code(ok ? 200 : 503).send({ status: ok ? 'ready' : 'not_ready', checks });
  });

  if (ctx.cfg.observability.metrics_enabled) {
    app.get('/metrics', async (req, reply) => {
      if (ctx.cfg.observability.metrics_require_auth) {
        await app.optionalAuth(req, reply);
        if (!req.principal) throw unauthorized('Metrics require authentication');
      }
      reply.header('content-type', registry.contentType);
      return renderMetrics();
    });
  }

  // Real-time gauges for the Settings page (poll every 1–2 s).
  app.get('/api/system/live', { preHandler: app.authenticate }, async () => {
    const r = ctx.engines.resources();
    const live = await ctx.engines.liveStats();
    const cpu = sampleCpu();
    const mem = process.memoryUsage();
    return {
      at: new Date().toISOString(),
      host: { cpus: r.host.cpus, cpu_percent: cpu.host_percent, load_average: os.loadavg(), memory_total_bytes: r.host.total_memory_bytes, memory_used_bytes: r.host.total_memory_bytes - r.host.free_memory_bytes, memory_free_bytes: r.host.free_memory_bytes },
      process: { cpu_percent: cpu.process_percent, rss_bytes: mem.rss, heap_used_bytes: mem.heapUsed, uptime_s: Math.round(process.uptime()) },
      duckdb: { memory_limit_bytes: live.duckdb_memory_limit_bytes, memory_usage_bytes: live.duckdb_memory_usage_bytes, temp_bytes: live.duckdb_temp_bytes, engines: live.engines, threads: r.duckdb.threads },
      scratch: { path: r.temp_disk.path, used_bytes: dirUsage(r.temp_disk.path), free_bytes: r.temp_disk.free_bytes, total_bytes: r.temp_disk.total_bytes },
      data: { path: r.data_jail.path, used_bytes: dirUsage(r.data_jail.path), free_bytes: r.data_jail.free_bytes, total_bytes: r.data_jail.total_bytes },
      cache: ctx.cache.stats(),
    };
  });

  app.get('/api/system', { preHandler: app.authenticate }, async () => {
    const r = ctx.engines.resources();
    r.duckdb.version = await getDuckDbVersion();
    return { ...r, server: { version: '1.2.0', node: process.version, started_at: ctx.startedAt.toISOString(), uptime_s: Math.round(process.uptime()), metadata_dialect: ctx.store.dialect, auth_strategy: ctx.cfg.auth.strategy, max_result_rows: ctx.cfg.duckdb.max_result_rows, query_timeout_seconds: ctx.cfg.duckdb.query_timeout_seconds } };
  });
}
