/**
 * Data quality: suites of checks on a table of a workspace — dbt's generic tests (not_null, unique, accepted_values,
 * relationships) and range, expression, row_count, freshness and custom SQL. Every check compiles to one SELECT of the
 * failing rows, the same idea as a dbt test, so what failed can be opened in the workbench as is.
 *
 * A suite runs as its author with the read scope only (like SQL alerts), on demand or on a schedule. Its status is
 * the worst outcome of its checks (error > fail > warn > pass); a changed status is delivered to its notification
 * channels, and the way back to pass as resolved. dbt test results of the workspace's projects are read alongside.
 */
import { and, desc, eq, isNotNull, lt, lte } from 'drizzle-orm';
import type { MetadataStore } from '../db/index.js';
import { QUALITY_CHECK_TYPES, type QualityCheck, type QualityCheckResult, type QualityRun, type QualityStatus, type QualitySuite, type SyncSchedule } from '../db/schema/sqlite.js';
import { newId } from '../security/crypto.js';
import { analyzeSql } from '../engine/sql-guard.js';
import type { Principal } from './principal.js';
import { requireWrite } from './principal.js';
import type { WorkspaceService } from './workspaces.js';
import type { QueryService } from './query.js';
import type { AuthService } from './auth.js';
import type { AuditService } from './audit.js';
import type { NotificationService, Notification } from './notifications.js';
import { nextRunAt } from './syncs.js';
import { badRequest, notFound } from './errors.js';
import { logger } from '../observability/logger.js';
import { liveEvents } from '../observability/events.js';

export interface SuiteInput {
  name?: string;
  description?: string | null;
  relation?: string;
  checks?: Partial<QualityCheck>[];
  schedule?: SyncSchedule;
  channel_ids?: string[];
  enabled?: boolean;
}

export interface SuiteOutcome {
  status: Exclude<QualityStatus, 'unknown'>;
  summary: string;
  results: QualityCheckResult[];
  duration_ms: number;
}

/** A dbt project's latest tests, for the quality overview. */
export interface DbtTestSummary {
  project_id: string;
  project_name: string;
  run_id: string;
  started_at: string;
  tests: { name: string; status: string; failures: number | null; message: string | null }[];
}

type RunStatus = Exclude<QualityStatus, 'unknown'>;
const RANK: Record<QualityStatus, number> = { unknown: -1, pass: 0, warn: 1, fail: 2, error: 3 };
const worst = (a: RunStatus, b: RunStatus): RunStatus => (RANK[b] > RANK[a] ? b : a);

const qi = (s: string) => `"${s.replace(/"/g, '""')}"`;
const lit = (v: unknown): string => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : `'${String(v).replace(/'/g, "''")}'`);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const firstLine = (err: unknown) => ((err as Error).message ?? String(err)).split('\n')[0]!.slice(0, 500);

/** "trips", "analytics.orders" or "db.schema.table" → the quoted relation; each part a plain or "quoted" identifier. */
export function quoteRelation(relation: string): string {
  const parts = splitRelation(relation);
  return parts.map(qi).join('.');
}

function splitRelation(relation: string): string[] {
  const parts: string[] = [];
  const re = /\s*(?:"((?:[^"]|"")+)"|([^."\s]+))\s*(\.|$)/y;
  const s = relation.trim();
  let m: RegExpExecArray | null;
  while (re.lastIndex < s.length && (m = re.exec(s))) {
    parts.push(m[1] !== undefined ? m[1].replace(/""/g, '"') : m[2]!);
    if (!m[3]) break;
  }
  if (re.lastIndex !== s.length || !parts.length || parts.length > 3) throw badRequest(`"${relation}" is not a table name (table, schema.table or database.schema.table)`);
  return parts;
}

/** A human label for a check: not_null(email), range(amount ≥ 0), … */
export function describeCheck(c: QualityCheck): string {
  if (c.description?.trim()) return c.description.trim();
  const col = c.column ?? '';
  switch (c.type) {
    case 'not_null':
      return `${col} is never null`;
    case 'unique':
      return `${col} is unique`;
    case 'accepted_values':
      return `${col} in (${(c.values ?? []).slice(0, 6).map(String).join(', ')}${(c.values ?? []).length > 6 ? ', …' : ''})`;
    case 'range':
      return c.min != null && c.max != null ? `${col} between ${c.min} and ${c.max}` : c.min != null ? `${col} ≥ ${c.min}` : `${col} ≤ ${c.max}`;
    case 'relationships':
      return `${col} exists in ${c.to}.${c.to_column}`;
    case 'expression':
      return `every row: ${c.expression}`;
    case 'row_count':
      return c.min != null && c.max != null ? `row count between ${c.min} and ${c.max}` : c.min != null ? `at least ${plural(c.min, 'row')}` : `at most ${plural(c.max ?? 0, 'row')}`;
    case 'freshness':
      return `newest ${col} within ${c.max_age_hours}h`;
    case 'custom_sql':
      return 'custom SQL returns no rows';
  }
}

/** Validates and normalises a check (ids kept, missing ones assigned). */
export function normaliseCheck(input: Partial<QualityCheck>, index: number): QualityCheck {
  const where = `Check ${index + 1}`;
  const type = input.type as QualityCheck['type'];
  if (!QUALITY_CHECK_TYPES.includes(type)) throw badRequest(`${where}: type must be one of ${QUALITY_CHECK_TYPES.join(', ')}`);
  const column = input.column?.trim() || null;
  const needsColumn = !['expression', 'row_count', 'custom_sql'].includes(type);
  if (needsColumn && !column) throw badRequest(`${where} (${type}): column is required`);
  const num = (v: unknown, name: string): number | null => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n)) throw badRequest(`${where} (${type}): ${name} must be a number`);
    return n;
  };
  const out: QualityCheck = {
    id: input.id?.trim() && /^[\w-]{1,40}$/.test(input.id.trim()) ? input.id.trim() : newId().slice(0, 12),
    type,
    column: needsColumn || type === 'row_count' ? column : null,
    severity: input.severity === 'warn' ? 'warn' : 'error',
    tolerance: Math.max(0, Math.floor(num(input.tolerance, 'tolerance') ?? 0)),
    where: input.where?.trim() || null,
    description: input.description?.trim().slice(0, 300) || null,
  };
  if (type === 'accepted_values') {
    const values = (input.values ?? []).filter((v) => v !== null && v !== undefined && String(v) !== '');
    if (!values.length) throw badRequest(`${where} (accepted_values): values is required`);
    out.values = values.slice(0, 500);
  }
  if (type === 'range' || type === 'row_count') {
    out.min = num(input.min, 'min');
    out.max = num(input.max, 'max');
    if (out.min === null && out.max === null) throw badRequest(`${where} (${type}): set min, max or both`);
    if (out.min !== null && out.max !== null && out.min > out.max) throw badRequest(`${where} (${type}): min is greater than max`);
    if (type === 'row_count') out.column = null;
  }
  if (type === 'relationships') {
    if (!input.to?.trim() || !input.to_column?.trim()) throw badRequest(`${where} (relationships): to (a table) and to_column are required`);
    splitRelation(input.to);
    out.to = input.to.trim();
    out.to_column = input.to_column.trim();
  }
  if (type === 'expression') {
    if (!input.expression?.trim()) throw badRequest(`${where} (expression): expression is required, e.g. amount >= 0`);
    out.expression = input.expression.trim();
  }
  if (type === 'freshness') {
    const h = num(input.max_age_hours, 'max_age_hours');
    if (h === null || h <= 0) throw badRequest(`${where} (freshness): max_age_hours must be greater than 0`);
    out.max_age_hours = h;
  }
  if (type === 'custom_sql') {
    if (!input.sql?.trim()) throw badRequest(`${where} (custom_sql): sql is required — a SELECT returning the failing rows`);
    out.sql = input.sql.trim().replace(/;\s*$/, '');
  }
  return out;
}

/**
 * The failing rows of a check, and what to report as observed. `relation` is quoted; the check is normalised.
 * Every statement is checked to be one read-only SELECT before it runs.
 */
export function compileCheck(c: QualityCheck, relation: string): { failing: string; observed: string | null; rows: string } {
  const filter = c.where ? `(${c.where})` : null;
  const col = c.column ? qi(c.column) : '';
  const from = (extra?: string) => `SELECT * FROM ${relation}${[filter, extra].filter(Boolean).length ? ` WHERE ${[filter, extra].filter(Boolean).join(' AND ')}` : ''}`;
  const rows = `SELECT count(*) FROM ${relation}${filter ? ` WHERE ${filter}` : ''}`;
  switch (c.type) {
    case 'not_null':
      return { failing: from(`${col} IS NULL`), observed: null, rows };
    case 'unique':
      return { failing: `SELECT ${col}, count(*) AS n_records FROM ${relation} WHERE ${[filter, `${col} IS NOT NULL`].filter(Boolean).join(' AND ')} GROUP BY ${col} HAVING count(*) > 1`, observed: null, rows };
    case 'accepted_values': {
      const allNumbers = (c.values ?? []).every((v) => typeof v === 'number');
      const lhs = allNumbers ? col : `CAST(${col} AS VARCHAR)`;
      const list = (c.values ?? []).map((v) => (allNumbers ? String(v) : lit(String(v)))).join(', ');
      return { failing: from(`${col} IS NOT NULL AND ${lhs} NOT IN (${list})`), observed: null, rows };
    }
    case 'range': {
      const out = [c.min != null ? `${col} < ${c.min}` : null, c.max != null ? `${col} > ${c.max}` : null].filter(Boolean).join(' OR ');
      return { failing: from(`(${out})`), observed: `SELECT CAST(min(${col}) AS VARCHAR) || ' … ' || CAST(max(${col}) AS VARCHAR) FROM ${relation}${filter ? ` WHERE ${filter}` : ''}`, rows };
    }
    case 'relationships': {
      const parent = quoteRelation(c.to!);
      return { failing: `SELECT c.* FROM ${relation} AS c WHERE ${[filter, `c.${col} IS NOT NULL`, `NOT EXISTS (SELECT 1 FROM ${parent} AS p WHERE p.${qi(c.to_column!)} = c.${col})`].filter(Boolean).join(' AND ')}`, observed: null, rows };
    }
    case 'expression':
      return { failing: from(`NOT coalesce((${c.expression}), FALSE)`), observed: null, rows };
    case 'row_count': {
      const bad = [c.min != null ? `count(*) < ${c.min}` : null, c.max != null ? `count(*) > ${c.max}` : null].filter(Boolean).join(' OR ');
      return { failing: `SELECT count(*) AS row_count FROM ${relation}${filter ? ` WHERE ${filter}` : ''} HAVING ${bad}`, observed: `SELECT CAST(count(*) AS VARCHAR) FROM ${relation}${filter ? ` WHERE ${filter}` : ''}`, rows };
    }
    case 'freshness': {
      const minutes = Math.max(1, Math.round((c.max_age_hours ?? 24) * 60));
      return {
        failing: `SELECT max(${col}) AS newest FROM ${relation}${filter ? ` WHERE ${filter}` : ''} HAVING max(${col}) IS NULL OR CAST(max(${col}) AS TIMESTAMP) < CAST(now() AS TIMESTAMP) - to_minutes(${minutes})`,
        observed: `SELECT CAST(max(${col}) AS VARCHAR) FROM ${relation}${filter ? ` WHERE ${filter}` : ''}`,
        rows,
      };
    }
    case 'custom_sql':
      return { failing: c.sql!.replace(/\{\{\s*(table|this)\s*\}\}/gi, relation), observed: null, rows };
  }
}

function guard(sql: string): void {
  const a = analyzeSql(sql);
  if (a.isMutating) throw new Error(`A quality check only reads: ${a.mutatingVerbs.join(', ')} is not allowed`);
  if (a.statements.length !== 1) throw new Error('A quality check is one SELECT');
}

export class QualityService {
  private ticker: NodeJS.Timeout | null = null;
  private running = new Set<string>();
  /** dbt projects, for their test results (set by the context). */
  dbt: { list(p: Principal, workspaceId: string): Promise<{ id: string; name: string }[]> } | null = null;

  constructor(private readonly store: MetadataStore, private readonly workspaces: WorkspaceService, private readonly queries: QueryService, private readonly auth: AuthService, private readonly notifications: NotificationService, private readonly audit: AuditService) {}
  private get db() {
    return this.store.db;
  }
  private get s() {
    return this.store.schema;
  }

  // ------------------------------------------------------------------------------------------ checking

  /** Runs checks as `runner` with the read scope only. Never throws for a failing check. */
  async evaluate(runner: Principal, workspaceId: string, relation: string, checks: QualityCheck[]): Promise<SuiteOutcome> {
    const t0 = Date.now();
    // Without the write scope, and every statement checked to be one SELECT. The runner keeps how it signed in and the
    // admin scope: that is how an administrator reaches workspaces they do not own.
    const readOnly: Principal = { ...runner, scopes: runner.scopes.filter((x) => x === 'read' || x === 'admin'), actorType: 'SYSTEM' };
    const run = (sql: string, maxRows: number) => this.queries.run(readOnly, workspaceId, sql, { cache: false, countTotal: false, maxRows });
    const results: QualityCheckResult[] = [];
    let quoted: string;
    try {
      quoted = quoteRelation(relation);
    } catch (err) {
      const message = firstLine(err);
      return { status: 'error', summary: message, results: checks.map((c) => ({ check_id: c.id, type: c.type, column: c.column ?? null, label: describeCheck(c), status: 'error', failures: null, rows: null, observed: null, message, sql: '', sample: null, duration_ms: 0 })), duration_ms: 0 };
    }
    for (const c of checks) {
      const t1 = Date.now();
      const label = describeCheck(c);
      let sql = '';
      try {
        const q = compileCheck(c, quoted);
        sql = q.failing;
        guard(q.failing);
        const stats = `SELECT (SELECT count(*) FROM (${q.failing}) AS f) AS failures, (${q.rows}) AS row_count, ${q.observed ? `(${q.observed})` : 'NULL'} AS observed`;
        guard(stats);
        const r = await run(stats, 1);
        const [failuresRaw, rowsRaw, observed] = (r.rows[0] ?? []) as [unknown, unknown, unknown];
        const failures = Number(failuresRaw ?? 0);
        const rows = rowsRaw === null || rowsRaw === undefined ? null : Number(rowsRaw);
        const tableLevel = ['row_count', 'freshness'].includes(c.type);
        const failed = tableLevel ? failures > 0 : failures > (c.tolerance ?? 0);
        const status: RunStatus = failed ? (c.severity === 'warn' ? 'warn' : 'fail') : 'pass';
        let sample: QualityCheckResult['sample'] = null;
        if (failures > 0) {
          const sr = await run(`SELECT * FROM (${q.failing}) AS f LIMIT 5`, 5);
          sample = { columns: sr.columns.map((x) => x.name), rows: sr.rows };
        }
        const unit = c.type === 'unique' ? 'duplicated value' : 'failing row';
        const message = c.type === 'row_count'
          ? `${plural(rows ?? 0, 'row')}${failed ? ` — expected ${label.replace(/^row count /, '')}` : ''}.`
          : c.type === 'freshness'
            ? observed == null ? `No ${c.column} values.` : `Newest ${c.column} is ${String(observed)}${failed ? `, older than ${c.max_age_hours}h` : ''}.`
            : failures === 0 ? `No ${unit}s${rows != null ? ` in ${plural(rows, 'row')}` : ''}.` : `${plural(failures, unit)}${rows ? ` of ${plural(rows, 'row')} (${((failures / rows) * 100).toFixed(failures / rows < 0.001 ? 3 : 1)}%)` : ''}${!failed ? `, within the tolerance of ${c.tolerance}` : ''}.`;
        results.push({ check_id: c.id, type: c.type, column: c.column ?? null, label, status, failures, rows, observed: observed == null ? null : String(observed), message, sql: q.failing, sample, duration_ms: Date.now() - t1 });
      } catch (err) {
        results.push({ check_id: c.id, type: c.type, column: c.column ?? null, label, status: 'error', failures: null, rows: null, observed: null, message: firstLine(err), sql, sample: null, duration_ms: Date.now() - t1 });
      }
    }
    const status = results.reduce<RunStatus>((acc, r) => worst(acc, r.status), 'pass');
    const count = (s: RunStatus) => results.filter((r) => r.status === s).length;
    const summary = !results.length
      ? 'No checks.'
      : [`${count('pass')} of ${results.length} passed`, count('fail') ? `${count('fail')} failed` : '', count('warn') ? `${plural(count('warn'), 'warning')}` : '', count('error') ? `${count('error')} could not run` : ''].filter(Boolean).join(', ') + '.';
    return { status, summary, results, duration_ms: Date.now() - t0 };
  }

  /** Tries checks without saving (the editor's "Test"), as the caller. */
  async preview(p: Principal, workspaceId: string, relation: string, checks: Partial<QualityCheck>[]): Promise<SuiteOutcome> {
    await this.workspaces.get(p, workspaceId);
    return this.evaluate(p, workspaceId, relation, checks.map(normaliseCheck));
  }

  // ------------------------------------------------------------------------------------------ suggestions

  /** Checks the data already satisfies: ids unique and not null, complete columns, small categories, non-negative numbers, joins to other tables. */
  async suggest(p: Principal, workspaceId: string, relation: string): Promise<QualityCheck[]> {
    await this.workspaces.get(p, workspaceId);
    const parts = splitRelation(relation);
    const name = parts[parts.length - 1]!;
    const schema = parts.length >= 2 ? parts[parts.length - 2]! : 'main';
    const run = (sql: string, maxRows = 1000) => this.queries.run(p, workspaceId, sql, { cache: false, countTotal: false, maxRows });
    const catalogFilter = parts.length === 3 ? `table_catalog = ${lit(parts[0])}` : 'table_catalog = current_database()';
    const cols = (await run(`SELECT column_name, data_type FROM information_schema.columns WHERE ${catalogFilter} AND table_schema = ${lit(schema)} AND table_name = ${lit(name)} ORDER BY ordinal_position`)).rows as [string, string][];
    if (!cols.length) throw badRequest(`No table ${relation}`);
    const rel = quoteRelation(relation);
    const used = cols.slice(0, 60);
    const aggs = used.flatMap(([c]) => [`count(${qi(c)})`, `count(DISTINCT ${qi(c)})`]);
    const numeric = (t: string) => /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|FLOAT|REAL|DOUBLE|DECIMAL.*)$/i.test(t);
    const mins = used.filter(([, t]) => numeric(t)).map(([c]) => `min(${qi(c)})`);
    const stats = (await run(`SELECT count(*), ${[...aggs, ...mins].join(', ')} FROM ${rel}`, 1)).rows[0] as unknown[];
    const total = Number(stats[0] ?? 0);
    const checks: QualityCheck[] = [{ id: 'row_count', type: 'row_count', min: 1, max: null, severity: 'error', tolerance: 0, column: null, where: null, description: null }];
    if (!total) return checks;
    // Other tables of the workspace, for relationships: customer_id → customers.customer_id / customers.id.
    const tables = (await run(`SELECT table_schema, table_name, column_name FROM information_schema.columns WHERE table_catalog = current_database() AND table_schema NOT IN ('information_schema', 'pg_catalog') AND table_schema NOT LIKE 'duckview_%'`, 20_000)).rows as [string, string, string][];
    // "orders", "dq_orders", "stg_orders" are all tables of order; order_id is their own key.
    const isTableOf = (table: string, stem: string) => [stem, `${stem}s`, `${stem}es`].some((n) => table.toLowerCase() === n || table.toLowerCase().endsWith(`_${n}`));
    const ownKey = (c: string) => { const stem = c.toLowerCase().replace(/_?(id|key|uuid)$/i, ''); return !!stem && isTableOf(name, stem); };
    let minIdx = 0;
    used.forEach(([c, type], i) => {
      const nonNull = Number(stats[1 + i * 2] ?? 0);
      const distinct = Number(stats[2 + i * 2] ?? 0);
      const idLike = c.toLowerCase() === 'id' || /(^|_)(id|key|uuid)$/i.test(c);
      const min = numeric(type) ? stats[1 + used.length * 2 + minIdx++] : undefined;
      const add = (x: Omit<QualityCheck, 'id' | 'severity' | 'tolerance'> & Partial<QualityCheck>) => checks.push({ id: `${x.type}_${c}`.replace(/\W+/g, '_').slice(0, 40), severity: 'error', tolerance: 0, where: null, description: null, ...x });
      if (nonNull === total) add({ type: 'not_null', column: c });
      if (idLike && distinct === nonNull && nonNull === total && (c.toLowerCase() === 'id' || ownKey(c))) add({ type: 'unique', column: c });
      if (!idLike && /^(VARCHAR|BOOLEAN)$/i.test(type) && distinct >= 1 && distinct <= 12 && nonNull >= distinct * 2) add({ type: 'accepted_values', column: c, values: [] });
      if (min !== undefined && min !== null && Number(min) >= 0 && !idLike && /amount|price|fare|cost|total|qty|quantity|count|distance|duration|age|fee|tax|tip|revenue|sales/i.test(c)) add({ type: 'range', column: c, min: 0, max: null, severity: 'warn' });
      if (idLike && c.toLowerCase() !== 'id') {
        const stem = c.toLowerCase().replace(/_?(id|key|uuid)$/i, '');
        // Prefer the table with the same prefix: stg_orders → stg_customers over customers.
        const prefix = /^(.*_)?[^_]+$/.exec(name.toLowerCase())?.[1] ?? '';
        const parent = !ownKey(c) && tables.filter(([s, t, col]) => isTableOf(t, stem) && !(s === schema && t === name) && (col.toLowerCase() === c.toLowerCase() || col.toLowerCase() === 'id')).sort((a, b) => Number(b[1].toLowerCase().startsWith(prefix)) - Number(a[1].toLowerCase().startsWith(prefix)))[0];
        if (parent) {
          const exact = tables.find(([s, t, col]) => s === parent[0] && t === parent[1] && col.toLowerCase() === c.toLowerCase());
          add({ type: 'relationships', column: c, to: parent[0] === 'main' ? parent[1] : `${parent[0]}.${parent[1]}`, to_column: (exact ?? parent)[2] });
        }
      }
    });
    // The categories as they are today.
    for (const chk of checks.filter((x) => x.type === 'accepted_values')) {
      const vals = (await run(`SELECT DISTINCT ${qi(chk.column!)} FROM ${rel} WHERE ${qi(chk.column!)} IS NOT NULL ORDER BY 1 LIMIT 12`, 12)).rows.map((r) => r[0]);
      chk.values = vals.map((v) => (typeof v === 'boolean' || typeof v === 'number' ? v : String(v)));
    }
    return checks.filter((x) => x.type !== 'accepted_values' || (x.values ?? []).length);
  }

  // ------------------------------------------------------------------------------------------ registry

  private checkSchedule(s: SyncSchedule | undefined): SyncSchedule {
    const sch = s ?? { kind: 'manual' };
    if (sch.kind === 'interval' && (!Number.isFinite(sch.minutes) || sch.minutes < 5)) throw badRequest('schedule.minutes must be at least 5');
    nextRunAt(sch);
    return sch;
  }

  private async checkChannels(p: Principal, workspaceId: string, ids: string[] | undefined): Promise<string[]> {
    const wanted = [...new Set(ids ?? [])];
    if (!wanted.length) return [];
    const usable = new Set((await this.notifications.list(p, workspaceId)).map((c) => c.id));
    const bad = wanted.find((id) => !usable.has(id));
    if (bad) throw badRequest(`Channel ${bad} is not a channel of this workspace (or org-wide)`);
    return wanted;
  }

  private checkChecks(input: Partial<QualityCheck>[] | undefined): QualityCheck[] {
    const checks = (input ?? []).slice(0, 200).map(normaliseCheck);
    const seen = new Set<string>();
    for (const c of checks) {
      while (seen.has(c.id)) c.id = `${c.id.slice(0, 34)}_${newId().slice(0, 4)}`;
      seen.add(c.id);
    }
    return checks;
  }

  async list(p: Principal, workspaceId: string): Promise<QualitySuite[]> {
    await this.workspaces.get(p, workspaceId);
    const rows = await this.db.select().from(this.s.qualitySuites).where(eq(this.s.qualitySuites.workspace_id, workspaceId));
    return rows.sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(p: Principal, id: string, minRole: 'VIEWER' | 'EDITOR' = 'VIEWER'): Promise<QualitySuite> {
    const suite = (await this.db.select().from(this.s.qualitySuites).where(eq(this.s.qualitySuites.id, id)).limit(1))[0];
    if (!suite) throw notFound('Quality suite');
    await this.workspaces.get(p, suite.workspace_id, minRole);
    return suite;
  }

  async create(p: Principal, workspaceId: string, input: SuiteInput): Promise<QualitySuite> {
    requireWrite(p);
    await this.workspaces.get(p, workspaceId, 'EDITOR');
    const relation = (input.relation ?? '').trim();
    if (!relation) throw badRequest('relation (the table to check) is required');
    splitRelation(relation);
    const name = (input.name ?? '').trim().slice(0, 120) || relation;
    const schedule = this.checkSchedule(input.schedule);
    const now = new Date();
    const enabled = input.enabled ?? true;
    const row: QualitySuite = { id: newId(), workspace_id: workspaceId, user_id: p.userId, name, description: input.description?.trim() || null, relation, checks: this.checkChecks(input.checks), schedule, channel_ids: await this.checkChannels(p, workspaceId, input.channel_ids), enabled, status: 'unknown', last_run: null, next_run_at: enabled ? nextRunAt(schedule, now) : null, created_at: now, updated_at: now };
    await this.db.insert(this.s.qualitySuites).values(row);
    this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'quality.create', resource: `quality:${row.id}`, ip: p.ip });
    return row;
  }

  async update(p: Principal, id: string, patch: SuiteInput): Promise<QualitySuite> {
    requireWrite(p);
    const suite = await this.get(p, id, 'EDITOR');
    const set: Partial<QualitySuite> = { updated_at: new Date() };
    if (patch.name !== undefined) set.name = patch.name.trim().slice(0, 120) || suite.name;
    if (patch.description !== undefined) set.description = patch.description?.trim() || null;
    if (patch.relation !== undefined) {
      splitRelation(patch.relation);
      set.relation = patch.relation.trim();
    }
    if (patch.checks !== undefined) set.checks = this.checkChecks(patch.checks);
    // Whoever changes what is checked is who it runs as.
    if (patch.relation !== undefined || patch.checks !== undefined) set.user_id = p.userId;
    if (patch.schedule !== undefined) set.schedule = this.checkSchedule(patch.schedule);
    if (patch.channel_ids !== undefined) set.channel_ids = await this.checkChannels(p, suite.workspace_id, patch.channel_ids);
    if (patch.enabled !== undefined) set.enabled = patch.enabled;
    const next = { ...suite, ...set };
    if (patch.schedule !== undefined || patch.enabled !== undefined) set.next_run_at = next.enabled ? nextRunAt(next.schedule) : null;
    await this.db.update(this.s.qualitySuites).set(set).where(eq(this.s.qualitySuites.id, id));
    this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'quality.update', resource: `quality:${id}`, ip: p.ip });
    return { ...suite, ...set };
  }

  async remove(p: Principal, id: string): Promise<void> {
    requireWrite(p);
    await this.get(p, id, 'EDITOR');
    await this.db.delete(this.s.qualitySuites).where(eq(this.s.qualitySuites.id, id));
    this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'quality.delete', resource: `quality:${id}`, ip: p.ip });
  }

  async runs(p: Principal, id: string, limit = 30): Promise<Omit<QualityRun, 'results'>[]> {
    await this.get(p, id);
    const rows = await this.db.select().from(this.s.qualityRuns).where(eq(this.s.qualityRuns.suite_id, id)).orderBy(desc(this.s.qualityRuns.started_at)).limit(Math.min(limit, 200));
    return rows.map(({ results: _r, ...rest }) => rest);
  }

  async getRun(p: Principal, runId: string): Promise<QualityRun> {
    const run = (await this.db.select().from(this.s.qualityRuns).where(eq(this.s.qualityRuns.id, runId)).limit(1))[0];
    if (!run) throw notFound('Quality run');
    await this.get(p, run.suite_id);
    return run;
  }

  /** The latest run of a suite with its results (null before the first). */
  async latest(p: Principal, id: string): Promise<QualityRun | null> {
    await this.get(p, id);
    return (await this.db.select().from(this.s.qualityRuns).where(eq(this.s.qualityRuns.suite_id, id)).orderBy(desc(this.s.qualityRuns.started_at)).limit(1))[0] ?? null;
  }

  /** Runs a suite now (a person, an agent or the scheduler), records it, and delivers a changed status. */
  async run(id: string, triggeredBy: string, p: Principal | null = null): Promise<{ suite: QualitySuite; run: QualityRun; changed: boolean }> {
    const suite = p ? await this.get(p, id) : (await this.db.select().from(this.s.qualitySuites).where(eq(this.s.qualitySuites.id, id)).limit(1))[0];
    if (!suite) throw notFound('Quality suite');
    if (this.running.has(id)) throw badRequest('This suite is running right now');
    this.running.add(id);
    try {
      const startedAt = new Date();
      const owner = await this.auth.findActive(suite.user_id);
      const outcome: SuiteOutcome = owner
        ? await this.evaluate(this.auth.principalFromUser(owner, 'jwt', 'quality'), suite.workspace_id, suite.relation, suite.checks)
        : { status: 'error', summary: 'The suite\'s author no longer exists or has been deactivated.', results: [], duration_ms: 0 };
      const prev = suite.status;
      const changed = outcome.status !== prev;
      let deliver: 'failing' | 'resolved' | null = null;
      if (outcome.status !== 'pass' && changed) deliver = 'failing';
      else if (outcome.status === 'pass' && (prev === 'fail' || prev === 'warn' || prev === 'error')) deliver = 'resolved';
      let notified = 0;
      if (deliver && suite.channel_ids.length) {
        const ws = (await this.db.select({ name: this.s.workspaces.name }).from(this.s.workspaces).where(eq(this.s.workspaces.id, suite.workspace_id)).limit(1))[0];
        const sent = await this.notifications.send(suite.channel_ids, this.message(suite, outcome, deliver, ws?.name ?? null), `quality:${suite.id}`, suite.workspace_id);
        notified = sent.filter((r) => r.status === 'ok').length;
      }
      const run: QualityRun = { id: newId(), suite_id: id, workspace_id: suite.workspace_id, status: outcome.status, summary: outcome.summary, results: outcome.results, triggered_by: triggeredBy, actor_id: p?.userId ?? null, notified, duration_ms: outcome.duration_ms, started_at: startedAt };
      await this.db.insert(this.s.qualityRuns).values(run);
      const set: Partial<QualitySuite> = { status: outcome.status, last_run: { run_id: run.id, status: outcome.status, summary: outcome.summary, finished_at: new Date().toISOString() } };
      await this.db.update(this.s.qualitySuites).set(set).where(eq(this.s.qualitySuites.id, id));
      // Keep 90 days of history.
      await this.db.delete(this.s.qualityRuns).where(and(eq(this.s.qualityRuns.suite_id, id), lt(this.s.qualityRuns.started_at, new Date(Date.now() - 90 * 86_400_000)))).catch(() => undefined);
      liveEvents.publish({ type: 'quality', at: new Date().toISOString(), workspace_id: suite.workspace_id, suite_id: id, status: outcome.status, changed });
      return { suite: { ...suite, ...set }, run, changed };
    } finally {
      this.running.delete(id);
    }
  }

  private message(suite: QualitySuite, o: SuiteOutcome, kind: 'failing' | 'resolved', workspace: string | null): Notification {
    const bad = o.results.filter((r) => r.status !== 'pass');
    const lines = bad.slice(0, 10).map((r) => `• ${r.status.toUpperCase()} ${r.label} — ${r.message}`);
    return {
      title: kind === 'resolved' ? `Data quality passing again: ${suite.name}` : `Data quality ${o.status === 'warn' ? 'warning' : o.status === 'error' ? 'checks could not run' : 'failing'}: ${suite.name}`,
      text: [suite.description, o.summary, lines.join('\n'), bad.length > 10 ? `… ${bad.length - 10} more` : ''].filter(Boolean).join('\n\n'),
      severity: kind === 'resolved' ? 'resolved' : o.status === 'fail' ? 'critical' : 'warning',
      event: kind === 'resolved' ? 'quality.resolved' : `quality.${o.status}`,
      dedupKey: `duckview-quality-${suite.id}`,
      url: this.notifications.link(`/#/transform/quality?suite=${suite.id}`),
      fields: [{ label: 'Table', value: suite.relation }, { label: 'Status', value: o.status }, ...(workspace ? [{ label: 'Workspace', value: workspace }] : [])],
      workspace: workspace ? { id: suite.workspace_id, name: workspace } : null,
    };
  }

  // ------------------------------------------------------------------------------------------ overview

  /** The latest dbt test outcomes of each of the workspace's projects. */
  async dbtTests(p: Principal, workspaceId: string): Promise<DbtTestSummary[]> {
    if (!this.dbt) return [];
    const projects = await this.dbt.list(p, workspaceId).catch(() => []);
    const out: DbtTestSummary[] = [];
    for (const project of projects) {
      const recent = await this.db.select().from(this.s.dbtRuns).where(eq(this.s.dbtRuns.project_id, project.id)).orderBy(desc(this.s.dbtRuns.started_at)).limit(15);
      const withTests = recent.find((r) => r.results.some((n) => n.resource_type === 'test'));
      if (!withTests) continue;
      out.push({ project_id: project.id, project_name: project.name, run_id: withTests.id, started_at: withTests.started_at.toISOString(), tests: withTests.results.filter((n) => n.resource_type === 'test').map((n) => ({ name: n.name, status: n.status, failures: n.failures, message: n.message })) });
    }
    return out;
  }

  /** For Copilot: each suite's status and what is failing. */
  async promptSummary(workspaceId: string): Promise<string> {
    const suites = await this.db.select().from(this.s.qualitySuites).where(eq(this.s.qualitySuites.workspace_id, workspaceId));
    if (!suites.length) return '';
    const lines: string[] = [];
    for (const s of suites.slice(0, 30)) {
      lines.push(`- ${s.name} (table ${s.relation}, ${s.checks.length} checks): ${s.status === 'unknown' ? 'not run yet' : `${s.status} — ${s.last_run?.summary ?? ''}`}`);
      if (s.status === 'fail' || s.status === 'warn' || s.status === 'error') {
        const run = s.last_run ? (await this.db.select().from(this.s.qualityRuns).where(eq(this.s.qualityRuns.id, s.last_run.run_id)).limit(1))[0] : undefined;
        for (const r of (run?.results ?? []).filter((x) => x.status !== 'pass').slice(0, 8)) lines.push(`  - ${r.status}: ${r.label} — ${r.message}`);
      }
    }
    return lines.join('\n');
  }

  // ------------------------------------------------------------------------------------------ scheduling

  async tick(now = new Date()): Promise<string[]> {
    const due = await this.db.select().from(this.s.qualitySuites).where(and(eq(this.s.qualitySuites.enabled, true), isNotNull(this.s.qualitySuites.next_run_at), lte(this.s.qualitySuites.next_run_at, now)));
    const ran: string[] = [];
    for (const suite of due) {
      await this.db.update(this.s.qualitySuites).set({ next_run_at: nextRunAt(suite.schedule, now) }).where(eq(this.s.qualitySuites.id, suite.id));
      try {
        await this.run(suite.id, 'schedule');
        ran.push(suite.id);
      } catch (err) {
        logger().warn({ suite: suite.id, err: (err as Error).message }, 'Quality suite run failed');
      }
    }
    return ran;
  }

  start(intervalMs = 30_000): void {
    if (this.ticker) return;
    this.ticker = setInterval(() => void this.tick().catch((err) => logger().warn({ err: (err as Error).message }, 'Quality scheduler tick failed')), intervalMs);
    this.ticker.unref();
  }

  stop(): void {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
  }
}
