/**
 * QueryService — the single choke point for executing SQL on behalf of a principal.
 * REST, WebSocket and MCP all go through here so that authorization, sandboxing,
 * HITL policy, audit logging and metrics are applied uniformly.
 */
import path from 'node:path';
import type { DuckViewConfig } from '../config/index.js';
import type { WorkspaceService } from './workspaces.js';
import type { AuditService } from './audit.js';
import type { Principal } from './principal.js';
import { canWrite, requireScope } from './principal.js';
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
  constructor(private readonly cfg: DuckViewConfig, private readonly workspaces: WorkspaceService, private readonly audit: AuditService) {}

  private authorize(p: Principal, analysis: SqlAnalysis, opts: RunOptions): void {
    requireScope(p, 'read');
    if (analysis.isMutating) {
      if (!canWrite(p)) {
        throw forbidden(p.role === 'READ_ONLY' ? 'Read-only users cannot run mutating SQL' : 'This token lacks the write scope required for mutating SQL');
      }
      if (analysis.overall === 'admin' && p.actorType === 'AGENT' && !p.scopes.includes('admin')) {
        throw forbidden('Administrative statements (SET/PRAGMA/ATTACH/INSTALL/LOAD/CALL) require an admin-scoped token');
      }
      if (p.actorType === 'AGENT' && this.cfg.mcp.require_confirmation_for_mutations && opts.dryRun !== false) {
        metrics.hitlChallenges.inc();
        throw new HitlBlocked(buildChallenge(analysis));
      }
    }
  }

  async run(p: Principal, workspaceId: string, sql: string, opts: RunOptions = {}): Promise<QueryResult & { analysis: SqlAnalysis }> {
    if (!sql || !sql.trim()) throw badRequest('sql is required');
    const analysis = analyzeSql(sql);
    const start = performance.now();
    const actor = p.actorType === 'AGENT' ? 'agent' : 'user';
    try {
      this.authorize(p, analysis, opts);
      const { engine } = await this.workspaces.engine(p, workspaceId);
      const result = await engine.execute(sql, { maxRows: opts.maxRows, page: opts.page, countTotal: opts.countTotal, signal: opts.signal, timeoutMs: opts.timeoutMs, actor });
      this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'query.execute', resource: `workspace:${workspaceId}`, queryText: sql, durationMs: result.durationMs, ip: p.ip, status: 'ok' });
      return result;
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
      this.authorize(p, analysis, opts);
      const { engine } = await this.workspaces.engine(p, workspaceId);
      const out = await engine.stream(sql, handlers, { maxRows: opts.maxRows, signal: opts.signal, timeoutMs: opts.timeoutMs, actor: 'user' });
      this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'query.stream', resource: `workspace:${workspaceId}`, queryText: sql, durationMs: out.durationMs, ip: p.ip, status: 'ok' });
      return out;
    } catch (err) {
      this.recordFailure(p, workspaceId, sql, start, err, 'user');
      throw err;
    }
  }

  async explain(p: Principal, workspaceId: string, sql: string, analyze = false) {
    requireScope(p, 'read');
    const { engine } = await this.workspaces.engine(p, workspaceId);
    const start = performance.now();
    try {
      const plan = await engine.explain(sql, { analyze });
      this.audit.log({ userId: p.userId, actorType: p.actorType, action: analyze ? 'query.explain_analyze' : 'query.explain', resource: `workspace:${workspaceId}`, queryText: sql, durationMs: performance.now() - start, ip: p.ip });
      return plan;
    } catch (err) {
      this.recordFailure(p, workspaceId, sql, start, err, p.actorType === 'AGENT' ? 'agent' : 'user', 'query.explain');
      throw err;
    }
  }

  async profile(p: Principal, workspaceId: string, target: string) {
    requireScope(p, 'read');
    const { engine } = await this.workspaces.engine(p, workspaceId);
    const start = performance.now();
    try {
      const out = await engine.summarize(target);
      this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'dataset.profile', resource: `workspace:${workspaceId}`, queryText: out.sql, durationMs: performance.now() - start, ip: p.ip });
      return out;
    } catch (err) {
      this.recordFailure(p, workspaceId, target, start, err, p.actorType === 'AGENT' ? 'agent' : 'user', 'dataset.profile');
      throw err;
    }
  }

  async overview(p: Principal, workspaceId: string, target: string) {
    requireScope(p, 'read');
    const { engine } = await this.workspaces.engine(p, workspaceId);
    const start = performance.now();
    try {
      const out = await engine.overview(target);
      this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'dataset.overview', resource: `workspace:${workspaceId}`, queryText: target, durationMs: out.duration_ms, ip: p.ip });
      return out;
    } catch (err) {
      this.recordFailure(p, workspaceId, target, start, err, p.actorType === 'AGENT' ? 'agent' : 'user', 'dataset.overview');
      throw err;
    }
  }

  async catalog(p: Principal, workspaceId: string): Promise<{ objects: CatalogObject[]; files: JailEntry[] }> {
    requireScope(p, 'read');
    const { engine } = await this.workspaces.engine(p, workspaceId);
    const [objects, files] = await Promise.all([engine.catalog(), Promise.resolve(this.workspaces.jail.listFiles())]);
    return { objects, files };
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
