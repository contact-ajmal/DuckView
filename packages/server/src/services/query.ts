/**
 * QueryService — the single choke point for executing SQL on behalf of a principal.
 * REST, WebSocket and MCP all go through here so that authorization, sandboxing,
 * HITL policy, audit logging and metrics are applied uniformly.
 */
import path from 'node:path';
import type { DuckViewConfig } from '../config/index.js';
import type { WorkspaceRole } from '../db/schema/sqlite.js';
import type { WorkspaceService } from './workspaces.js';
import type { AuditService } from './audit.js';
import { unwrap, type ResultCache, type CacheOutcome, type CacheMeta } from './cache.js';
import type { Principal } from './principal.js';
import { canWrite, requireScope, roleAtLeast } from './principal.js';
import { SandboxViolation, type JailEntry } from '../engine/sandbox.js';
import { analyzeSql, stripTrailingSemicolon, type SqlAnalysis } from '../engine/sql-guard.js';
import { QueryTimeoutError, type CatalogObject } from '../engine/duckdb.js';
import type { QueryResult, ColumnSchema } from '../engine/results.js';
import { metrics } from '../observability/metrics.js';
import { badRequest, forbidden, HttpError } from './errors.js';

export interface RunOptions {
  maxRows?: number;
  page?: number;
  countTotal?: boolean;
  /** Agents must pass dry_run=false to run mutating SQL (HITL). Humans in the UI are exempt. */
  dryRun?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Read-only, deterministic statements are served from the result cache unless `cache: false`. */
  cache?: boolean;
  /** Recompute even when a cached result exists (the fresh result is stored). */
  refresh?: boolean;
  /** Client ETag; when it still matches, `run` resolves to `{ notModified: true }` without executing anything. */
  ifNoneMatch?: string | null;
}


export interface ApprovalChallenge {
  status: 'approval_required';
  reason: string;
  statement_classes: string[];
  mutating_verbs: string[];
  statements: { index: number; verb: string; class: string; preview: string }[];
  how_to_proceed: string;
}

export class HitlBlocked extends Error {
  readonly code = 'APPROVAL_REQUIRED';
  constructor(readonly challenge: ApprovalChallenge) {
    super(challenge.reason);
    this.name = 'HitlBlocked';
  }
}

export function buildChallenge(analysis: SqlAnalysis): ApprovalChallenge {
  return {
    status: 'approval_required',
    reason: `This SQL contains mutating statement(s) (${analysis.mutatingVerbs.join(', ')}). Execution was blocked pending explicit confirmation.`,
    statement_classes: [...new Set(analysis.statements.map((s) => s.class))],
    mutating_verbs: analysis.mutatingVerbs,
    statements: analysis.statements.map((s) => ({ index: s.index, verb: s.verb, class: s.class, preview: s.sql.slice(0, 240) })),
    how_to_proceed: 'Show the statement(s) to the human operator. If they approve, call execute_query again with the identical `sql` and `dry_run: false`.',
  };
}

export class QueryService {
  constructor(private readonly cfg: DuckViewConfig, private readonly workspaces: WorkspaceService, private readonly audit: AuditService, private readonly cache: ResultCache) {}

  /** Any statement that is not a pure read moves the workspace's data epoch — even when it failed halfway. */
  private async noteMutation(p: Principal, workspaceId: string, analysis: SqlAnalysis) {
    if (analysis.isMutating) await this.workspaces.bumpVersion(workspaceId, `sql:${analysis.mutatingVerbs.join(',').toLowerCase() || 'admin'}`, p.userId).catch(() => undefined);
  }

  private authorize(p: Principal, analysis: SqlAnalysis, opts: RunOptions, role: WorkspaceRole): void {
    requireScope(p, 'read');
    if (analysis.isMutating) {
      if (!canWrite(p)) {
        throw forbidden(p.role === 'READ_ONLY' ? 'Read-only users cannot run mutating SQL' : 'This token lacks the write scope required for mutating SQL');
      }
      if (!roleAtLeast(role, 'EDITOR')) throw forbidden('You have view-only access to this workspace; mutating SQL needs edit access');
      if (analysis.overall === 'admin' && p.actorType === 'AGENT' && !p.scopes.includes('admin')) {
        throw forbidden('Administrative statements (SET/PRAGMA/ATTACH/INSTALL/LOAD/CALL) require an admin-scoped token');
      }
      if (p.actorType === 'AGENT' && this.cfg.mcp.require_confirmation_for_mutations && opts.dryRun !== false) {
        metrics.hitlChallenges.inc();
        throw new HitlBlocked(buildChallenge(analysis));
      }
    }
  }

  /**
   * Executes SQL. Read-only, deterministic statements over local data are served from the result cache — the key
   * embeds the files they read and the workspace epoch, so a hit is exact. Throws NotModified when `ifNoneMatch`
   * still matches (HTTP layer → 304).
   */
  async run(p: Principal, workspaceId: string, sql: string, opts: RunOptions = {}): Promise<QueryResult & { analysis: SqlAnalysis } & CacheMeta> {
    if (!sql || !sql.trim()) throw badRequest('sql is required');
    const analysis = analyzeSql(sql);
    const start = performance.now();
    const actor = p.actorType === 'AGENT' ? 'agent' : 'user';
    try {
      // Cheap access check first so a forbidden or HITL-blocked statement never spins up an engine.
      const { role } = await this.workspaces.get(p, workspaceId);
      this.authorize(p, analysis, opts, role);
      const execute = async () => {
        const { engine } = await this.workspaces.engine(p, workspaceId);
        try {
          return await engine.execute(sql, { maxRows: opts.maxRows, page: opts.page, countTotal: opts.countTotal, signal: opts.signal, timeoutMs: opts.timeoutMs, actor });
        } finally {
          await this.noteMutation(p, workspaceId, analysis);
        }
      };
      const cacheable = opts.cache !== false && !analysis.isMutating;
      const outcome: CacheOutcome<QueryResult & { analysis: SqlAnalysis; guardedSql: string }> = cacheable
        ? await this.cache.through(p, workspaceId, 'query', sql, { maxRows: opts.maxRows ?? null, page: opts.page ?? 1, countTotal: !!opts.countTotal }, { ifNoneMatch: opts.ifNoneMatch, refresh: opts.refresh }, execute)
        : { status: 'bypass', etag: null, value: await execute(), cached: false, computed_at: new Date().toISOString() };
      const durationMs = outcome.status === 'not_modified' ? 0 : outcome.value.durationMs;
      this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'query.execute', resource: `workspace:${workspaceId}`, queryText: sql, durationMs, ip: p.ip, status: 'ok' });
      const out = unwrap(outcome);
      // Cached values are shared objects — never hand callers a reference they could mutate.
      return out.cached ? { ...out, rows: out.rows.map((r) => [...r]) } : out;
    } catch (err) {
      this.recordFailure(p, workspaceId, sql, start, err, actor);
      throw err;
    }
  }

  async stream(
    p: Principal,
    workspaceId: string,
    sql: string,
    handlers: { onSchema: (c: ColumnSchema[]) => void; onRows: (rows: unknown[][]) => void | Promise<void> },
    opts: RunOptions = {},
  ) {
    if (!sql || !sql.trim()) throw badRequest('sql is required');
    const analysis = analyzeSql(sql);
    const start = performance.now();
    try {
      const { role } = await this.workspaces.get(p, workspaceId);
      this.authorize(p, analysis, opts, role);
      const { engine } = await this.workspaces.engine(p, workspaceId);
      let out;
      try {
        out = await engine.stream(sql, handlers, { maxRows: opts.maxRows, signal: opts.signal, timeoutMs: opts.timeoutMs, actor: 'user' });
      } finally {
        await this.noteMutation(p, workspaceId, analysis);
      }
      this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'query.stream', resource: `workspace:${workspaceId}`, queryText: sql, durationMs: out.durationMs, ip: p.ip, status: 'ok' });
      return out;
    } catch (err) {
      this.recordFailure(p, workspaceId, sql, start, err, 'user');
      throw err;
    }
  }

  async explain(p: Principal, workspaceId: string, sql: string, analyze = false, opts: { refresh?: boolean; ifNoneMatch?: string | null } = {}) {
    requireScope(p, 'read');
    const start = performance.now();
    try {
      const compute = async () => {
        const { engine } = await this.workspaces.engine(p, workspaceId);
        return engine.explain(sql, { analyze });
      };
      // EXPLAIN ANALYZE executes the query for timings — those are the point, so it is never cached.
      const o = analyze ? { status: 'bypass' as const, etag: null, value: await compute(), cached: false, computed_at: new Date().toISOString() } : await this.cache.through(p, workspaceId, 'explain', sql, null, opts, compute);
      this.audit.log({ userId: p.userId, actorType: p.actorType, action: analyze ? 'query.explain_analyze' : 'query.explain', resource: `workspace:${workspaceId}`, queryText: sql, durationMs: performance.now() - start, ip: p.ip });
      return unwrap(o);
    } catch (err) {
      this.recordFailure(p, workspaceId, sql, start, err, p.actorType === 'AGENT' ? 'agent' : 'user', 'query.explain');
      throw err;
    }
  }

  async profile(p: Principal, workspaceId: string, target: string, opts: { refresh?: boolean; ifNoneMatch?: string | null } = {}) {
    requireScope(p, 'read');
    const start = performance.now();
    try {
      const o = await this.cache.through(p, workspaceId, 'profile', target, null, opts, async () => {
        const { engine } = await this.workspaces.engine(p, workspaceId);
        return engine.summarize(target);
      });
      this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'dataset.profile', resource: `workspace:${workspaceId}`, queryText: o.status === 'not_modified' ? target : o.value.sql, durationMs: performance.now() - start, ip: p.ip });
      return unwrap(o);
    } catch (err) {
      this.recordFailure(p, workspaceId, target, start, err, p.actorType === 'AGENT' ? 'agent' : 'user', 'dataset.profile');
      throw err;
    }
  }

  async overview(p: Principal, workspaceId: string, target: string, opts: { refresh?: boolean; ifNoneMatch?: string | null } = {}) {
    requireScope(p, 'read');
    const start = performance.now();
    try {
      const o = await this.cache.through(p, workspaceId, 'overview', target, null, opts, async () => {
        const { engine } = await this.workspaces.engine(p, workspaceId);
        return engine.overview(target);
      });
      this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'dataset.overview', resource: `workspace:${workspaceId}`, queryText: target, durationMs: o.status === 'not_modified' ? 0 : o.value.duration_ms, ip: p.ip });
      return unwrap(o);
    } catch (err) {
      this.recordFailure(p, workspaceId, target, start, err, p.actorType === 'AGENT' ? 'agent' : 'user', 'dataset.overview');
      throw err;
    }
  }

  async catalog(p: Principal, workspaceId: string): Promise<{ objects: CatalogObject[]; files: JailEntry[]; truncated_folders: string[] }> {
    requireScope(p, 'read');
    const { engine } = await this.workspaces.engine(p, workspaceId);
    const [objects, all] = await Promise.all([engine.catalog(), this.workspaces.listAllFiles(p, workspaceId)]);
    return { objects, files: all.files, truncated_folders: all.truncated };
  }

  /** COPY (sql) TO '<jail>/<target>' (FORMAT ...). Always writes inside the jail. */
  async saveDataset(p: Principal, workspaceId: string, input: { sql: string; format: 'parquet' | 'csv' | 'json'; target: string; dryRun?: boolean }) {
    requireScope(p, 'read');
    if (!canWrite(p)) throw forbidden('Saving datasets requires the write scope');
    const inner = analyzeSql(input.sql);
    if (inner.statements.length !== 1 || inner.isMutating) throw badRequest('save_dataset accepts exactly one read-only SELECT statement');
    const fmt = input.format.toLowerCase();
    if (!['parquet', 'csv', 'json'].includes(fmt)) throw badRequest('output_format must be parquet, csv or json');
    let target = input.target.trim().replace(/\\/g, '/');
    if (!target) throw badRequest('target_filename is required');
    if (!path.posix.extname(target)) target += `.${fmt}`;
    await this.workspaces.get(p, workspaceId, 'EDITOR');
    const { engine } = await this.workspaces.engine(p, workspaceId);
    const resolved = engine.jail.resolve(target); // SandboxViolation on escape
    const exportsDir = path.posix.join('exports');
    const finalRel = resolved.relative.includes('/') ? resolved.relative : path.posix.join(exportsDir, resolved.relative);
    const finalAbs = engine.jail.resolve(finalRel).absolute;
    const options = fmt === 'parquet' ? "(FORMAT PARQUET, COMPRESSION ZSTD)" : fmt === 'csv' ? '(FORMAT CSV, HEADER TRUE)' : '(FORMAT JSON, ARRAY FALSE)';
    const copySql = `COPY (${stripTrailingSemicolon(input.sql)}) TO '${finalAbs.replace(/'/g, "''")}' ${options}`;
    if (p.actorType === 'AGENT' && this.cfg.mcp.require_confirmation_for_mutations && input.dryRun !== false) {
      metrics.hitlChallenges.inc();
      const a = analyzeSql(copySql);
      const ch = buildChallenge(a);
      ch.reason = `save_dataset writes ${finalRel} to the data directory. Confirm with dry_run=false to proceed.`;
      throw new HitlBlocked(ch);
    }
    const start = performance.now();
    try {
      const { mkdirSync } = await import('node:fs');
      mkdirSync(path.dirname(finalAbs), { recursive: true });
      const res = await engine.execute(copySql, { maxRows: 1, actor: p.actorType === 'AGENT' ? 'agent' : 'user' });
      await this.workspaces.bumpVersion(workspaceId, 'dataset_saved', p.userId).catch(() => undefined);
      const rowsWritten = Number(res.rows[0]?.[0] ?? res.rowsChanged ?? 0);
      this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'dataset.save', resource: `file:${finalRel}`, queryText: copySql, durationMs: res.durationMs, ip: p.ip });
      const { statSync } = await import('node:fs');
      return { path: finalRel, absolute_path: finalAbs, format: fmt, rows_written: rowsWritten, size_bytes: statSync(finalAbs).size, duration_ms: res.durationMs };
    } catch (err) {
      this.recordFailure(p, workspaceId, copySql, start, err, p.actorType === 'AGENT' ? 'agent' : 'user', 'dataset.save');
      throw err;
    }
  }

  private recordFailure(p: Principal, workspaceId: string, sql: string, start: number, err: unknown, actor: 'user' | 'agent', action = 'query.execute') {
    const e = err as Error & { code?: string };
    let status: 'error' | 'blocked' | 'timeout' = 'error';
    if (err instanceof SandboxViolation) {
      status = 'blocked';
      metrics.sandboxViolations.inc({ actor });
    } else if (err instanceof HitlBlocked) status = 'blocked';
    else if (err instanceof QueryTimeoutError) status = 'timeout';
    else if (err instanceof HttpError && err.statusCode === 403) status = 'blocked';
    this.audit.log({ userId: p.userId, actorType: p.actorType, action, resource: `workspace:${workspaceId}`, queryText: sql, durationMs: performance.now() - start, ip: p.ip, status, error: e?.message ?? String(err) });
  }
}
