/**
 * The semantic layer: metrics defined once per workspace, queried the same way from the Metrics explorer, dashboards,
 * agents (MCP) and Copilot.
 *
 * Definitions come from hand-written YAML (source "workspace") and from dbt projects (source "dbt:<id>", read from
 * dbt's target/semantic_manifest.json after every run). The shape follows dbt's MetricFlow spec, so definitions
 * can be copied between the two:
 *   semantic_models: name, table | sql | model (ref('x')), default_time_dimension, entities (primary · unique ·
 *     natural · foreign, with expr), dimensions (categorical · time, expr, granularity), measures (sum · count ·
 *     count_distinct · avg · min · max · median · sum_boolean, expr)
 *   metrics: simple (a measure, optional filter) · ratio (numerator / denominator metrics) · derived (an expression
 *     over other metrics, with aliases)
 *
 * A query — metrics, group by (dimensions, `metric_time`, `<dim>__<grain>`, `<entity>__<dim>` across a join),
 * filters, order, limit — compiles to one SELECT: per semantic model a CTE that aggregates its measures at the
 * requested grain (joining other models through shared entities, many-to-one only), full-outer-joined on the
 * dimensions, with ratios and derived metrics computed on top. It runs through the QueryService as the caller, so
 * the SQL guard, access policies, cache and audit apply.
 */
import YAML from 'yaml';
import { and, eq } from 'drizzle-orm';
import type { MetadataStore } from '../db/index.js';
import type { SemanticLayerRow } from '../db/schema/sqlite.js';
import type { WorkspaceService } from './workspaces.js';
import type { QueryService } from './query.js';
import type { AuditService } from './audit.js';
import type { Principal } from './principal.js';
import { requireWrite } from './principal.js';
import { badRequest, HttpError } from './errors.js';
import { newId } from '../security/crypto.js';
import type { QueryResult } from '../engine/results.js';

export const AGGS = ['sum', 'count', 'count_distinct', 'avg', 'min', 'max', 'median', 'sum_boolean'] as const;
export type Agg = (typeof AGGS)[number];
export const GRAINS = ['hour', 'day', 'week', 'month', 'quarter', 'year'] as const;
export type Grain = (typeof GRAINS)[number];
export const FILTER_OPS = ['=', '!=', '>', '>=', '<', '<=', 'in', 'not in', 'between', 'like', 'is null', 'is not null'] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

export interface Entity { name: string; type: 'primary' | 'unique' | 'natural' | 'foreign'; expr: string }
export interface Dimension { name: string; type: 'categorical' | 'time'; expr: string; granularity?: Grain | null; description?: string | null; label?: string | null }
export interface Measure { name: string; agg: Agg; expr: string; description?: string | null; agg_time_dimension?: string | null }
export interface SemanticModel { name: string; relation: string; label: string; description?: string | null; default_time_dimension?: string | null; entities: Entity[]; dimensions: Dimension[]; measures: Measure[]; source: string }
interface MetricBase { name: string; label?: string | null; description?: string | null; filter?: string | null; source: string }
export type Metric = MetricBase & ({ type: 'simple'; measure: string } | { type: 'ratio'; numerator: string; denominator: string } | { type: 'derived'; expr: string; inputs: { name: string; alias: string | null }[] });
export interface Definition { semantic_models: SemanticModel[]; metrics: Metric[]; warnings?: string[] }

export interface MetricQuery {
  metrics: string[];
  group_by?: string[];
  where?: { dimension: string; op: FilterOp; value?: unknown }[];
  /** Extra SQL condition; dimensions may be referenced as {{ Dimension('name') }}. */
  where_sql?: string | null;
  order_by?: { name: string; desc?: boolean }[];
  limit?: number;
}

const IDENT = /^[A-Za-z_][\w]*$/;
const qi = (s: string) => `"${s.replace(/"/g, '""')}"`;
const lit = (v: unknown): string => (v === null || v === undefined ? 'NULL' : typeof v === 'number' || typeof v === 'bigint' ? String(v) : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : `'${String(v).replace(/'/g, "''")}'`);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const nameOf = (v: unknown): string | null => str(v) ?? str((v as { name?: unknown } | null)?.name);
/** A column name as SQL; anything else is an expression kept as written. */
const exprOr = (expr: unknown, name: string) => str(expr) ?? qi(name);

function relationOf(m: Record<string, unknown>): { relation: string; label: string } {
  const sql = str(m.sql);
  if (sql) return { relation: `(${sql.replace(/;\s*$/, '')})`, label: 'SQL' };
  const raw = str(m.table) ?? str(m.model);
  if (!raw) throw badRequest(`semantic model ${String(m.name)}: give table, model or sql`);
  const ref = /^ref\(\s*['"]([\w.]+)['"]\s*\)$/.exec(raw);
  const t = ref ? ref[1]! : raw;
  if (/^"/.test(t)) return { relation: t, label: t.replace(/"/g, '') };
  if (!/^[\w$]+(\.[\w$]+){0,2}$/.test(t)) throw badRequest(`semantic model ${String(m.name)}: table must be a name like orders or sales.orders`);
  return { relation: t.split('.').map(qi).join('.'), label: t };
}

function filterOf(v: unknown): string | null {
  if (!v) return null;
  if (typeof v === 'string') return v.trim() || null;
  if (Array.isArray(v)) return v.map(filterOf).filter(Boolean).map((f) => `(${f})`).join(' AND ') || null;
  const wf = (v as { where_filters?: { where_sql_template?: string }[] }).where_filters;
  if (Array.isArray(wf)) return wf.map((w) => w.where_sql_template).filter((x): x is string => !!x).map((f) => `(${f})`).join(' AND ') || null;
  return null;
}

/** Parses the native YAML (MetricFlow-compatible) into definitions; throws 400 with every problem found. */
export function parseDefinition(text: string, source = 'workspace'): Definition {
  let doc: unknown;
  try {
    doc = YAML.parse(text || '') ?? {};
  } catch (err) {
    throw badRequest(`Invalid YAML: ${(err as Error).message}`);
  }
  if (typeof doc !== 'object' || Array.isArray(doc)) throw badRequest('The semantic layer is a YAML mapping with semantic_models and metrics');
  const d = doc as { semantic_models?: unknown; metrics?: unknown };
  const problems: string[] = [];
  const models: SemanticModel[] = [];
  for (const raw of (Array.isArray(d.semantic_models) ? d.semantic_models : []) as Record<string, unknown>[]) {
    const name = str(raw?.name);
    if (!name || !IDENT.test(name)) {
      problems.push(`semantic model ${JSON.stringify(raw?.name)}: the name must be an identifier`);
      continue;
    }
    try {
      const { relation, label } = relationOf(raw);
      const defaults = (raw.defaults ?? {}) as { agg_time_dimension?: string };
      const entities = ((raw.entities ?? []) as Record<string, unknown>[]).map((e) => {
        const en = str(e.name);
        if (!en || !IDENT.test(en)) throw badRequest(`semantic model ${name}: entity names are identifiers`);
        const type = (str(e.type) ?? 'primary') as Entity['type'];
        if (!['primary', 'unique', 'natural', 'foreign'].includes(type)) throw badRequest(`semantic model ${name}: entity ${en} type must be primary, unique, natural or foreign`);
        return { name: en, type, expr: exprOr(e.expr, en) };
      });
      const dimensions = ((raw.dimensions ?? []) as Record<string, unknown>[]).map((x) => {
        const dn = str(x.name);
        if (!dn || !IDENT.test(dn)) throw badRequest(`semantic model ${name}: dimension names are identifiers`);
        const type = (str(x.type) ?? 'categorical') as Dimension['type'];
        if (type !== 'categorical' && type !== 'time') throw badRequest(`semantic model ${name}: dimension ${dn} type must be categorical or time`);
        const granularity = (str(x.granularity) ?? str((x.type_params as { time_granularity?: string } | undefined)?.time_granularity)) as Grain | null;
        return { name: dn, type, expr: exprOr(x.expr, dn), granularity: granularity && (GRAINS as readonly string[]).includes(granularity) ? granularity : null, description: str(x.description), label: str(x.label) };
      });
      const measures = ((raw.measures ?? []) as Record<string, unknown>[]).map((x) => {
        const mn = str(x.name);
        if (!mn || !IDENT.test(mn)) throw badRequest(`semantic model ${name}: measure names are identifiers`);
        let agg = (str(x.agg) ?? 'sum').toLowerCase();
        if (agg === 'average') agg = 'avg';
        if (!(AGGS as readonly string[]).includes(agg)) throw badRequest(`semantic model ${name}: measure ${mn} agg must be one of ${AGGS.join(', ')}`);
        return { name: mn, agg: agg as Agg, expr: str(x.expr) ?? (agg === 'count' ? '1' : qi(mn)), description: str(x.description), agg_time_dimension: str(x.agg_time_dimension) };
      });
      models.push({ name, relation, label, description: str(raw.description), default_time_dimension: str(raw.default_time_dimension) ?? str(defaults.agg_time_dimension) ?? dimensions.find((x) => x.type === 'time')?.name ?? null, entities, dimensions, measures, source });
    } catch (err) {
      problems.push((err as Error).message);
    }
  }
  const metrics: Metric[] = [];
  for (const raw of (Array.isArray(d.metrics) ? d.metrics : []) as Record<string, unknown>[]) {
    const name = str(raw?.name);
    if (!name || !IDENT.test(name)) {
      problems.push(`metric ${JSON.stringify(raw?.name)}: the name must be an identifier`);
      continue;
    }
    const tp = (raw.type_params ?? {}) as Record<string, unknown>;
    const base = { name, label: str(raw.label), description: str(raw.description), filter: filterOf(raw.filter), source };
    const type = str(raw.type) ?? (raw.numerator || tp.numerator ? 'ratio' : raw.expr || tp.expr ? 'derived' : 'simple');
    if (type === 'simple') {
      const measure = nameOf(raw.measure) ?? nameOf(tp.measure);
      if (!measure) problems.push(`metric ${name}: a simple metric names a measure`);
      else metrics.push({ ...base, type: 'simple', measure, filter: [base.filter, filterOf((tp.measure as { filter?: unknown } | undefined)?.filter)].filter(Boolean).map((f) => `(${f})`).join(' AND ') || null });
    } else if (type === 'ratio') {
      const numerator = nameOf(raw.numerator) ?? nameOf(tp.numerator);
      const denominator = nameOf(raw.denominator) ?? nameOf(tp.denominator);
      if (!numerator || !denominator) problems.push(`metric ${name}: a ratio names a numerator and a denominator metric`);
      else metrics.push({ ...base, type: 'ratio', numerator, denominator });
    } else if (type === 'derived') {
      const expr = str(raw.expr) ?? str(tp.expr);
      const inputs = ((raw.metrics ?? tp.metrics ?? []) as unknown[]).map((m) => ({ name: nameOf(m) ?? '', alias: str((m as { alias?: unknown })?.alias) })).filter((m) => m.name);
      if (!expr) problems.push(`metric ${name}: a derived metric has an expr`);
      else metrics.push({ ...base, type: 'derived', expr, inputs });
    } else problems.push(`metric ${name}: type ${type} is not supported (simple, ratio, derived)`);
  }
  if (problems.length) throw new HttpError(400, `The semantic layer has ${problems.length} problem${problems.length === 1 ? '' : 's'}: ${problems.join('; ')}`, 'BAD_REQUEST', { problems });
  return { semantic_models: models, metrics };
}

/** dbt's target/semantic_manifest.json → definitions; `rebind` maps dbt's relation names to the workspace's. */
export function fromDbtManifest(manifest: { semantic_models?: Record<string, unknown>[]; metrics?: Record<string, unknown>[] }, source: string, rebind: (relation: string) => string): Definition {
  const warnings: string[] = [];
  const models: SemanticModel[] = [];
  for (const sm of manifest.semantic_models ?? []) {
    const rel = (sm.node_relation ?? {}) as { relation_name?: string; alias?: string; schema_name?: string };
    const relation = rebind(rel.relation_name ?? `${qi(rel.schema_name ?? 'main')}.${qi(rel.alias ?? String(sm.name))}`);
    try {
      const parsed = parseDefinition(YAML.stringify({ semantic_models: [{ ...sm, table: undefined, model: undefined, sql: `select * from ${relation}` }] }), source).semantic_models[0]!;
      models.push({ ...parsed, relation, label: `${rel.schema_name && rel.schema_name !== 'main' ? `${rel.schema_name}.` : ''}${rel.alias ?? sm.name}` });
    } catch (err) {
      warnings.push(`semantic model ${String(sm.name)}: ${(err as Error).message}`);
    }
  }
  const metrics: Metric[] = [];
  for (const m of manifest.metrics ?? []) {
    if (m.type === 'cumulative' || m.type === 'conversion') {
      warnings.push(`metric ${String(m.name)}: ${String(m.type)} metrics are not supported yet`);
      continue;
    }
    try {
      metrics.push(...parseDefinition(YAML.stringify({ metrics: [m] }), source).metrics);
    } catch (err) {
      warnings.push(`metric ${String(m.name)}: ${(err as Error).message}`);
    }
  }
  return { semantic_models: models, metrics, warnings };
}

interface Resolved { sql: string; join: { model: SemanticModel; entity: string } | null }

/** Compiles metric queries against a set of definitions. */
export class SemanticCompiler {
  private readonly models = new Map<string, SemanticModel>();
  private readonly metrics = new Map<string, Metric>();
  private readonly measureModel = new Map<string, { model: SemanticModel; measure: Measure }>();

  constructor(readonly def: Definition) {
    for (const m of def.semantic_models) this.models.set(m.name, m);
    for (const m of def.metrics) this.metrics.set(m.name, m);
    for (const model of def.semantic_models) for (const measure of model.measures) if (!this.measureModel.has(measure.name)) this.measureModel.set(measure.name, { model, measure });
  }

  metric(name: string): Metric {
    const m = this.metrics.get(name);
    if (!m) throw badRequest(`Unknown metric ${name}`);
    return m;
  }

  /** The simple metrics a metric is built from. */
  leaves(name: string, seen = new Set<string>()): Metric[] {
    if (seen.has(name)) throw badRequest(`Metric ${name} refers to itself`);
    seen.add(name);
    const m = this.metric(name);
    if (m.type === 'simple') return [m];
    const inputs = m.type === 'ratio' ? [m.numerator, m.denominator] : m.inputs.length ? m.inputs.map((i) => i.name) : this.namesIn(m.expr).filter((n) => this.metrics.has(n));
    return inputs.flatMap((i) => this.leaves(i, new Set(seen)));
  }

  private namesIn(expr: string): string[] {
    return [...expr.replace(/'(?:[^']|'')*'/g, '').matchAll(/\b[A-Za-z_]\w*\b/g)].map((x) => x[0]);
  }

  modelOf(leaf: Metric): { model: SemanticModel; measure: Measure } {
    if (leaf.type !== 'simple') throw new Error('not a simple metric');
    const mm = this.measureModel.get(leaf.measure);
    if (!mm) throw badRequest(`Metric ${leaf.name}: unknown measure ${leaf.measure}`);
    return mm;
  }

  /** Models reachable from `m` in one many-to-one hop: they have a primary / unique / natural entity `m` also has. */
  joinable(m: SemanticModel): { model: SemanticModel; entity: string }[] {
    const out: { model: SemanticModel; entity: string }[] = [];
    for (const e of m.entities) {
      for (const n of this.models.values()) {
        if (n.name === m.name) continue;
        if (n.entities.some((ne) => ne.name === e.name && ne.type !== 'foreign')) out.push({ model: n, entity: e.name });
      }
    }
    return out;
  }

  private splitGrain(ref: string): { base: string; grain: Grain | null } {
    const m = /^(.*)__(hour|day|week|month|quarter|year)$/.exec(ref);
    return m ? { base: m[1]!, grain: m[2] as Grain } : { base: ref, grain: null };
  }

  /** Resolves a dimension reference from the point of view of model `m` (alias "m", joins "j_<model>"). */
  resolve(m: SemanticModel, ref: string, timeDimension?: string | null): Resolved & { type: 'categorical' | 'time' } {
    const { base, grain } = this.splitGrain(ref.trim());
    const own = (model: SemanticModel, alias: string, dim: string, join: Resolved['join']) => {
      const d = model.dimensions.find((x) => x.name === dim);
      // Day and coarser grains are dates; hour stays a timestamp.
      if (d) return { sql: grain && d.type === 'time' ? (grain === 'hour' ? `date_trunc('hour', ${alias}.${qi(`__d_${d.name}`)})` : `CAST(date_trunc('${grain}', ${alias}.${qi(`__d_${d.name}`)}) AS DATE)`) : `${alias}.${qi(`__d_${d.name}`)}`, join, type: d.type };
      const e = model.entities.find((x) => x.name === dim);
      if (e) return { sql: `${alias}.${qi(`__e_${e.name}`)}`, join, type: 'categorical' as const };
      return null;
    };
    if (base === 'metric_time') {
      const t = timeDimension ?? m.default_time_dimension;
      if (!t) throw badRequest(`metric_time: semantic model ${m.name} has no time dimension (set default_time_dimension)`);
      const r = own(m, 'm', t, null);
      if (!r) throw badRequest(`metric_time: ${m.name} has no dimension ${t}`);
      return r;
    }
    const parts = base.split(/__|\./);
    if (parts.length === 2) {
      const [left, dim] = parts as [string, string];
      // model.dim / entity__dim on the model itself.
      if (left === m.name || m.entities.some((e) => e.name === left && e.type !== 'foreign')) {
        const r = own(m, 'm', dim, null);
        if (r) return r;
      }
      for (const j of this.joinable(m)) {
        if (j.model.name !== left && j.entity !== left) continue;
        const r = own(j.model, qi(`j_${j.model.name}`), dim, j);
        if (r) return r;
      }
      throw badRequest(`Dimension ${ref} cannot be reached from semantic model ${m.name}`);
    }
    const mine = own(m, 'm', base, null);
    if (mine) return mine;
    const found = this.joinable(m).map((j) => own(j.model, qi(`j_${j.model.name}`), base, j)).filter((x): x is NonNullable<typeof x> => !!x);
    if (found.length === 1) return found[0]!;
    if (found.length > 1) throw badRequest(`Dimension ${ref} is ambiguous from ${m.name}; qualify it as <entity>__${base}`);
    throw badRequest(`Dimension ${ref} cannot be reached from semantic model ${m.name}`);
  }

  /** Replaces {{ Dimension('x') }}, {{ TimeDimension('x', 'grain') }} and {{ Entity('x') }} with resolved SQL. */
  private template(m: SemanticModel, sql: string, joins: Map<string, Resolved['join']>): string {
    return sql
      .replace(/\{\{\s*TimeDimension\(\s*['"]([\w]+)['"]\s*(?:,\s*['"](\w+)['"]\s*)?\)\s*\}\}/g, (_a, dim: string, grain?: string) => this.use(m, grain ? `${dim}__${grain}` : dim, joins))
      .replace(/\{\{\s*(?:Dimension|Entity)\(\s*['"]([\w.]+)['"]\s*\)\s*\}\}/g, (_a, dim: string) => this.use(m, dim, joins));
  }

  private use(m: SemanticModel, ref: string, joins: Map<string, Resolved['join']>, time?: string | null): string {
    const r = this.resolve(m, ref, time);
    if (r.join) joins.set(r.join.model.name, r.join);
    return r.sql;
  }

  private wrapper(model: SemanticModel): string {
    const cols = [...model.dimensions.map((d) => `${d.expr} AS ${qi(`__d_${d.name}`)}`), ...model.entities.map((e) => `${e.expr} AS ${qi(`__e_${e.name}`)}`), ...model.measures.map((x) => `${x.expr} AS ${qi(`__m_${x.name}`)}`)];
    return `(SELECT *${cols.length ? `, ${cols.join(', ')}` : ''} FROM ${model.relation})`;
  }

  private agg(measure: Measure, filter: string | null): string {
    const col = `m.${qi(`__m_${measure.name}`)}`;
    const f = filter ? ` FILTER (WHERE ${filter})` : '';
    switch (measure.agg) {
      case 'count':
        return `count(${col})${f}`;
      case 'count_distinct':
        return `count(DISTINCT ${col})${f}`;
      case 'sum_boolean':
        return `sum(CAST(${col} AS INTEGER))${f}`;
      default:
        return `${measure.agg}(${col})${f}`;
    }
  }

  private condition(m: SemanticModel, w: NonNullable<MetricQuery['where']>[number], joins: Map<string, Resolved['join']>): string {
    const col = this.use(m, w.dimension, joins);
    const op = w.op.toLowerCase() as FilterOp;
    if (op === 'is null' || op === 'is not null') return `${col} ${op.toUpperCase()}`;
    if (op === 'in' || op === 'not in') {
      const vals = Array.isArray(w.value) ? w.value : [w.value];
      if (!vals.length) return op === 'in' ? 'FALSE' : 'TRUE';
      return `${col} ${op.toUpperCase()} (${vals.map(lit).join(', ')})`;
    }
    if (op === 'between') {
      const [a, b] = Array.isArray(w.value) ? w.value : [];
      return `${col} BETWEEN ${lit(a)} AND ${lit(b)}`;
    }
    if (!(FILTER_OPS as readonly string[]).includes(op)) throw badRequest(`Unsupported filter operator ${w.op}`);
    return `${col} ${op === 'like' ? 'LIKE' : op} ${lit(w.value)}`;
  }

  compile(q: MetricQuery, maxLimit = 10_000): { sql: string; metrics: Metric[]; group_by: string[] } {
    if (!q.metrics?.length) throw badRequest('Ask for at least one metric');
    const requested = [...new Set(q.metrics)].map((n) => this.metric(n));
    const groupBy = [...new Set(q.group_by ?? [])];
    for (const g of groupBy) if (!/^[\w.]+$/.test(g)) throw badRequest(`Invalid dimension ${g}`);
    const leaves = new Map<string, Metric>();
    for (const m of requested) for (const l of this.leaves(m.name)) leaves.set(l.name, l);
    // One CTE per semantic model.
    const byModel = new Map<string, { model: SemanticModel; leaves: { metric: Metric; measure: Measure }[] }>();
    for (const leaf of leaves.values()) {
      const { model, measure } = this.modelOf(leaf);
      if (!byModel.has(model.name)) byModel.set(model.name, { model, leaves: [] });
      byModel.get(model.name)!.leaves.push({ metric: leaf, measure });
    }
    const ctes: string[] = [];
    let i = 0;
    for (const { model, leaves: ls } of byModel.values()) {
      const joins = new Map<string, Resolved['join']>();
      const time = ls.map((l) => l.measure.agg_time_dimension).find(Boolean) ?? model.default_time_dimension;
      const dims = groupBy.map((g) => `${this.use(model, g, joins, time)} AS ${qi(g)}`);
      const aggs = ls.map((l) => `${this.agg(l.measure, l.metric.filter ? this.template(model, l.metric.filter, joins) : null)} AS ${qi(`__leaf_${l.metric.name}`)}`);
      const conds = (q.where ?? []).map((w) => this.condition(model, w, joins));
      if (q.where_sql?.trim()) conds.push(`(${this.template(model, q.where_sql, joins)})`);
      const joinSql = [...joins.values()].map((j) => `LEFT JOIN ${this.wrapper(j!.model)} AS ${qi(`j_${j!.model.name}`)} ON m.${qi(`__e_${j!.entity}`)} = ${qi(`j_${j!.model.name}`)}.${qi(`__e_${j!.entity}`)}`).join('\n  ');
      ctes.push(`${qi(`q${i++}`)} AS (\n  SELECT ${[...dims, ...aggs].join(', ')}\n  FROM ${this.wrapper(model)} AS m${joinSql ? `\n  ${joinSql}` : ''}${conds.length ? `\n  WHERE ${conds.join(' AND ')}` : ''}${dims.length ? '\n  GROUP BY ALL' : ''}\n)`);
    }
    const expr = (name: string): string => {
      const m = this.metric(name);
      if (m.type === 'simple') return qi(`__leaf_${m.name}`);
      if (m.type === 'ratio') return `(${expr(m.numerator)}) / NULLIF((${expr(m.denominator)}), 0)`;
      const aliases = new Map(m.inputs.map((x) => [x.alias ?? x.name, x.name]));
      return `(${m.expr.replace(/'(?:[^']|'')*'|\b[A-Za-z_]\w*\b/g, (tok) => {
        if (tok.startsWith("'")) return tok;
        const target = aliases.get(tok) ?? (this.metrics.has(tok) ? tok : null);
        return target ? `(${expr(target)})` : tok;
      })})`;
    };
    const names = [...byModel.keys()].map((_n, k) => qi(`q${k}`));
    const from = names.length === 1 ? names[0]! : groupBy.length ? names.slice(1).reduce((acc, n) => `${acc} FULL OUTER JOIN ${n} USING (${groupBy.map(qi).join(', ')})`, names[0]!) : names.join(' CROSS JOIN ');
    const select = [...groupBy.map(qi), ...requested.map((m) => `${expr(m.name)} AS ${qi(m.name)}`)];
    const order = (q.order_by?.length ? q.order_by : groupBy.some((g) => /metric_time|__(hour|day|week|month|quarter|year)$/.test(g)) ? [{ name: groupBy.find((g) => /metric_time|__(hour|day|week|month|quarter|year)$/.test(g))!, desc: false }] : groupBy.length ? [{ name: requested[0]!.name, desc: true }] : [])
      .map((o) => {
        if (!groupBy.includes(o.name) && !requested.some((m) => m.name === o.name)) throw badRequest(`order_by ${o.name} is neither a requested metric nor a group-by dimension`);
        return `${qi(o.name)} ${o.desc ? 'DESC' : 'ASC'} NULLS LAST`;
      });
    const limit = Math.min(Math.max(1, q.limit ?? 1000), maxLimit);
    const sql = `WITH ${ctes.join(',\n')}\nSELECT ${select.join(', ')}\nFROM ${from}${order.length ? `\nORDER BY ${order.join(', ')}` : ''}\nLIMIT ${limit}`;
    return { sql, metrics: requested, group_by: groupBy };
  }

  /** Dimensions every requested metric can be grouped by (plus metric_time when they all have a time dimension). */
  dimensionsFor(metricNames: string[]): { name: string; type: 'categorical' | 'time'; description: string | null; model: string }[] {
    const leafModels = [...new Set((metricNames.length ? metricNames : [...this.metrics.keys()]).flatMap((n) => this.leaves(n)).map((l) => this.modelOf(l).model))];
    const per = leafModels.map((m) => {
      const out = new Map<string, { name: string; type: 'categorical' | 'time'; description: string | null; model: string }>();
      if (m.default_time_dimension) out.set('metric_time', { name: 'metric_time', type: 'time', description: 'Each metric\'s time dimension', model: m.name });
      for (const d of m.dimensions) {
        out.set(d.name, { name: d.name, type: d.type, description: d.description ?? null, model: m.name });
        // Also as <entity>__<dimension>, the name other models reach it by.
        for (const e of m.entities) if (e.type !== 'foreign') out.set(`${e.name}__${d.name}`, { name: `${e.name}__${d.name}`, type: d.type, description: d.description ?? null, model: m.name });
      }
      for (const j of this.joinable(m)) for (const d of j.model.dimensions) out.set(`${j.entity}__${d.name}`, { name: `${j.entity}__${d.name}`, type: d.type, description: d.description ?? null, model: j.model.name });
      return out;
    });
    if (!per.length) return [];
    return [...per[0]!.values()].filter((d) => per.every((p) => p.has(d.name)));
  }
}

const NUMERIC = /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|FLOAT|REAL|DOUBLE|DECIMAL.*|NUMERIC.*)$/i;
const TEMPORAL = /^(DATE|TIMESTAMP.*|DATETIME)$/i;

export class SemanticService {
  constructor(
    private readonly store: MetadataStore,
    private readonly workspaces: WorkspaceService,
    private readonly queries: QueryService,
    private readonly audit: AuditService,
    private readonly maxRows: number,
  ) {}
  private get db() {
    return this.store.db;
  }
  private get s() {
    return this.store.schema;
  }

  private async rows(workspaceId: string): Promise<SemanticLayerRow[]> {
    return this.db.select().from(this.s.semanticLayers).where(eq(this.s.semanticLayers.workspace_id, workspaceId));
  }

  /** Every source merged; the hand-written YAML wins a name clash with an import. */
  async definition(workspaceId: string): Promise<Definition & { sources: { source: string; models: number; metrics: number; updated_at: string }[] }> {
    const rows = (await this.rows(workspaceId)).sort((a, b) => (a.source === 'workspace' ? -1 : b.source === 'workspace' ? 1 : a.source.localeCompare(b.source)));
    const models = new Map<string, SemanticModel>();
    const metrics = new Map<string, Metric>();
    const warnings: string[] = [];
    for (const r of rows) {
      const d = r.definition as unknown as Definition;
      for (const m of d.semantic_models ?? []) {
        if (models.has(m.name)) warnings.push(`semantic model ${m.name} from ${r.source} is shadowed by ${models.get(m.name)!.source}`);
        else models.set(m.name, m);
      }
      for (const m of d.metrics ?? []) {
        if (metrics.has(m.name)) warnings.push(`metric ${m.name} from ${r.source} is shadowed by ${metrics.get(m.name)!.source}`);
        else metrics.set(m.name, m);
      }
      warnings.push(...(d.warnings ?? []).map((w) => `${r.source}: ${w}`));
    }
    return { semantic_models: [...models.values()], metrics: [...metrics.values()], warnings, sources: rows.map((r) => ({ source: r.source, models: ((r.definition as unknown as Definition).semantic_models ?? []).length, metrics: ((r.definition as unknown as Definition).metrics ?? []).length, updated_at: r.updated_at.toISOString() })) };
  }

  async get(p: Principal, workspaceId: string) {
    await this.workspaces.get(p, workspaceId);
    const def = await this.definition(workspaceId);
    const yaml = (await this.rows(workspaceId)).find((r) => r.source === 'workspace')?.yaml ?? '';
    const compiler = new SemanticCompiler(def);
    const metrics = def.metrics.map((m) => {
      let dimensions: string[] = [];
      let error: string | null = null;
      try {
        dimensions = compiler.dimensionsFor([m.name]).map((d) => d.name);
      } catch (err) {
        error = (err as Error).message;
      }
      return { ...m, dimensions, error };
    });
    return { yaml, semantic_models: def.semantic_models, metrics, sources: def.sources, warnings: def.warnings ?? [] };
  }

  /** Checks definitions against the engine: every model binds, every metric compiles and binds. */
  async validate(p: Principal, workspaceId: string, def: Definition): Promise<string[]> {
    const errors: string[] = [];
    const compiler = new SemanticCompiler(def);
    const probe = async (sql: string) => this.queries.run(p, workspaceId, `SELECT * FROM (${sql}) AS probe LIMIT 0`, { cache: false, countTotal: false, maxRows: 1 });
    for (const m of def.semantic_models) {
      try {
        await probe(`SELECT * FROM ${compiler['wrapper'](m)} AS m`);
      } catch (err) {
        errors.push(`semantic model ${m.name}: ${firstLine(err)}`);
      }
    }
    for (const m of def.metrics) {
      try {
        await probe(compiler.compile({ metrics: [m.name] }).sql.replace(/\nLIMIT \d+$/, ''));
      } catch (err) {
        errors.push(`metric ${m.name}: ${firstLine(err)}`);
      }
    }
    return errors;
  }

  async save(p: Principal, workspaceId: string, yaml: string, opts: { force?: boolean } = {}) {
    requireWrite(p);
    await this.workspaces.get(p, workspaceId, 'EDITOR');
    const def = parseDefinition(yaml, 'workspace');
    // Validate what queries will see: this YAML together with the imported sources.
    const merged = await this.definition(workspaceId);
    const all: Definition = { semantic_models: [...def.semantic_models, ...merged.semantic_models.filter((m) => m.source !== 'workspace' && !def.semantic_models.some((x) => x.name === m.name))], metrics: [...def.metrics, ...merged.metrics.filter((m) => m.source !== 'workspace' && !def.metrics.some((x) => x.name === m.name))] };
    const errors = await this.validate(p, workspaceId, all);
    if (errors.length && !opts.force) throw new HttpError(400, `The definitions do not run: ${errors.join('; ')}`, 'BAD_REQUEST', { problems: errors });
    await this.upsert(workspaceId, 'workspace', def, yaml, p.userId);
    this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'semantic.update', resource: `workspace:${workspaceId}`, queryText: `${def.semantic_models.length} models, ${def.metrics.length} metrics`, ip: p.ip });
    return this.get(p, workspaceId);
  }

  private async upsert(workspaceId: string, source: string, def: Definition, yaml: string | null, userId: string | null) {
    const existing = (await this.db.select().from(this.s.semanticLayers).where(and(eq(this.s.semanticLayers.workspace_id, workspaceId), eq(this.s.semanticLayers.source, source))).limit(1))[0];
    const row = { workspace_id: workspaceId, source, yaml, definition: def as unknown as Record<string, unknown>, updated_by: userId, updated_at: new Date() };
    if (existing) await this.db.update(this.s.semanticLayers).set(row).where(eq(this.s.semanticLayers.id, existing.id));
    else await this.db.insert(this.s.semanticLayers).values({ id: newId(), ...row });
  }

  /** Stores (or, when the project has none, removes) the semantic models and metrics a dbt run produced. */
  async importDbt(workspaceId: string, projectId: string, manifest: Parameters<typeof fromDbtManifest>[0] | null, rebind: (relation: string) => string, userId: string | null): Promise<Definition | null> {
    const source = `dbt:${projectId}`;
    if (!manifest || (!(manifest.semantic_models ?? []).length && !(manifest.metrics ?? []).length)) {
      await this.db.delete(this.s.semanticLayers).where(and(eq(this.s.semanticLayers.workspace_id, workspaceId), eq(this.s.semanticLayers.source, source)));
      return null;
    }
    const def = fromDbtManifest(manifest, source, rebind);
    await this.upsert(workspaceId, source, def, null, userId);
    return def;
  }

  async removeSource(workspaceId: string, source: string) {
    await this.db.delete(this.s.semanticLayers).where(and(eq(this.s.semanticLayers.workspace_id, workspaceId), eq(this.s.semanticLayers.source, source)));
  }

  async compile(p: Principal, workspaceId: string, q: MetricQuery) {
    await this.workspaces.get(p, workspaceId);
    return new SemanticCompiler(await this.definition(workspaceId)).compile(q, this.maxRows);
  }

  async query(p: Principal, workspaceId: string, q: MetricQuery): Promise<{ sql: string; result: QueryResult; metrics: { name: string; label: string | null; description: string | null }[]; group_by: string[] }> {
    const c = await this.compile(p, workspaceId, q);
    const result = await this.queries.run(p, workspaceId, c.sql, { cache: true, countTotal: false, maxRows: this.maxRows });
    return { sql: c.sql, result, metrics: c.metrics.map((m) => ({ name: m.name, label: m.label ?? null, description: m.description ?? null })), group_by: c.group_by };
  }

  async dimensions(p: Principal, workspaceId: string, metrics: string[]) {
    await this.workspaces.get(p, workspaceId);
    return new SemanticCompiler(await this.definition(workspaceId)).dimensionsFor(metrics);
  }

  /** A starting point for a table: entities from id columns, time dimensions, categorical dimensions, sums and a count. */
  async scaffold(p: Principal, workspaceId: string, table: string): Promise<string> {
    await this.workspaces.get(p, workspaceId);
    const [schema, name] = table.includes('.') ? (table.split('.', 2) as [string, string]) : ['main', table];
    const cols = (await this.queries.run(p, workspaceId, `SELECT column_name, data_type FROM information_schema.columns WHERE table_catalog = current_database() AND table_schema = ${lit(schema)} AND table_name = ${lit(name)} ORDER BY ordinal_position`, { cache: false, countTotal: false, maxRows: 1000 })).rows as [string, string][];
    if (!cols.length) throw badRequest(`No table ${table}`);
    const model = name.replace(/\W+/g, '_');
    const single = model.replace(/s$/, '');
    const entities: Record<string, unknown>[] = [];
    const dimensions: Record<string, unknown>[] = [];
    const measures: Record<string, unknown>[] = [{ name: `${model}_count`, agg: 'count', description: `Number of ${model} rows` }];
    const metrics: Record<string, unknown>[] = [{ name: `${model}_count`, label: `${model.replace(/_/g, ' ')} count`, type: 'simple', measure: `${model}_count` }];
    for (const [c, type] of cols) {
      if (!IDENT.test(c)) continue;
      if (c === 'id') entities.push({ name: single, type: 'primary', expr: 'id' });
      else if (/_id$/.test(c)) entities.push({ name: c.replace(/_id$/, ''), type: c === `${single}_id` ? 'primary' : 'foreign', expr: c });
      else if (TEMPORAL.test(type)) dimensions.push({ name: c, type: 'time', granularity: /^DATE$/i.test(type) ? 'day' : 'hour' });
      else if (NUMERIC.test(type)) {
        measures.push({ name: `${c}_sum`, agg: 'sum', expr: c });
        metrics.push({ name: `total_${c}`, label: `Total ${c.replace(/_/g, ' ')}`, type: 'simple', measure: `${c}_sum` });
      } else dimensions.push({ name: c, type: 'categorical' });
    }
    return YAML.stringify({ semantic_models: [{ name: model, table, description: `One row per ${single}`, ...(dimensions.some((d) => d.type === 'time') ? { default_time_dimension: dimensions.find((d) => d.type === 'time')!.name } : {}), entities, dimensions, measures }], metrics });
  }

  /** The metric catalog for Copilot: what each metric means, how it is computed, how it can be sliced. */
  async promptSummary(workspaceId: string): Promise<string> {
    const def = await this.definition(workspaceId).catch(() => null);
    if (!def || !def.metrics.length) return '';
    const compiler = new SemanticCompiler(def);
    const lines: string[] = [];
    for (const m of def.metrics.slice(0, 60)) {
      let how = '';
      try {
        if (m.type === 'simple') {
          const { model, measure } = compiler.modelOf(m);
          how = `${measure.agg}(${measure.expr}) over ${model.label}${m.filter ? ` where ${m.filter}` : ''}`;
        } else if (m.type === 'ratio') how = `${m.numerator} / ${m.denominator}`;
        else how = m.expr;
      } catch {
        how = '(invalid)';
      }
      let dims = '';
      try {
        dims = compiler.dimensionsFor([m.name]).map((d) => d.name).slice(0, 20).join(', ');
      } catch {
        /* unreachable measure */
      }
      lines.push(`- ${m.name}${m.label ? ` (${m.label})` : ''}: ${how}${m.description ? ` — ${m.description}` : ''}${dims ? `; by ${dims}` : ''}`);
    }
    return lines.join('\n');
  }
}

function firstLine(err: unknown): string {
  return ((err as Error).message ?? String(err)).split('\n')[0]!.slice(0, 400);
}
