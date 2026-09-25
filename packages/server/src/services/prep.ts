/**
 * Data prep recipes: a source table and a list of steps (filter, keep or drop columns, rename, change type, fill
 * empty values, clean text, find and replace, add a column, split a column, remove duplicates, sort), compiled to
 * one readable SELECT with a CTE per step. The preview shows the result and how many rows each step leaves; the
 * recipe is saved as a view, a table or a dbt model.
 */
import { z } from 'zod';
import type { AppContext } from '../context.js';
import type { Principal } from './principal.js';
import { analyzeSql } from '../engine/sql-guard.js';
import { badRequest } from './errors.js';

const col = z.string().min(1).max(200);
const fragment = z.string().min(1).max(4000);
export const PrepStep = z.discriminatedUnion('op', [
  z.object({ op: z.literal('filter'), condition: fragment }),
  z.object({ op: z.literal('keep'), columns: z.array(col).min(1).max(500) }),
  z.object({ op: z.literal('drop'), columns: z.array(col).min(1).max(500) }),
  z.object({ op: z.literal('rename'), column: col, to: col }),
  z.object({ op: z.literal('cast'), column: col, type: z.string().regex(/^[A-Za-z][A-Za-z0-9_ ]*(\(\s*\d+(\s*,\s*\d+)?\s*\))?(\[\])?$/, 'A type such as INTEGER, DECIMAL(18, 2), DATE or VARCHAR') }),
  z.object({ op: z.literal('fill'), column: col, value: z.union([z.string().max(4000), z.number(), z.boolean()]) }),
  z.object({ op: z.literal('text'), column: col, fn: z.enum(['trim', 'lower', 'upper', 'collapse_spaces', 'digits_only']) }),
  z.object({ op: z.literal('replace'), column: col, find: z.string().min(1).max(4000), with: z.string().max(4000) }),
  z.object({ op: z.literal('derive'), name: col, expression: fragment }),
  z.object({ op: z.literal('split'), column: col, separator: z.string().min(1).max(20), into: z.array(col).min(1).max(20) }),
  z.object({ op: z.literal('parse_date'), column: col, format: z.string().min(1).max(100) }),
  z.object({ op: z.literal('dedupe'), columns: z.array(col).max(500).optional() }),
  z.object({ op: z.literal('sort'), by: z.array(z.object({ column: col, desc: z.boolean().optional() })).min(1).max(20) }),
]);
export type PrepStep = z.infer<typeof PrepStep>;

const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
const lit = (v: string | number | boolean) => (typeof v === 'string' ? `'${v.replace(/'/g, "''")}'` : String(v));
const relation = (name: string) => {
  const t = name.trim();
  if (/^'.*'$/.test(t) || /\(/.test(t)) return t; // a file path or a table function: as written
  return t.split('.').map((p) => q(p.replace(/^"|"$/g, ''))).join('.');
};
/** A fragment a person typed goes inside one expression: no statement separators or comments that could end it. */
function guardFragment(s: string, what: string): string {
  const stripped = s.replace(/'(?:[^']|'')*'/g, "''");
  if (/;|--|\/\*/.test(stripped)) throw badRequest(`${what} is one SQL expression (no ; or comments)`);
  return s.trim();
}

/** One sentence per step, for the recipe list and agents. */
export function describeStep(s: PrepStep): string {
  switch (s.op) {
    case 'filter': return `Keep rows where ${s.condition}`;
    case 'keep': return `Keep only ${s.columns.join(', ')}`;
    case 'drop': return `Remove ${s.columns.join(', ')}`;
    case 'rename': return `Rename ${s.column} to ${s.to}`;
    case 'cast': return `Make ${s.column} ${s.type.toUpperCase()}`;
    case 'fill': return `Fill empty ${s.column} with ${lit(s.value)}`;
    case 'text': return `${{ trim: 'Trim', lower: 'Lowercase', upper: 'Uppercase', collapse_spaces: 'Collapse spaces in', digits_only: 'Keep only digits in' }[s.fn]} ${s.column}`;
    case 'replace': return `Replace ${lit(s.find)} with ${lit(s.with)} in ${s.column}`;
    case 'derive': return `Add ${s.name} = ${s.expression}`;
    case 'split': return `Split ${s.column} on ${lit(s.separator)} into ${s.into.join(', ')}`;
    case 'parse_date': return `Read ${s.column} as a date (${s.format})`;
    case 'dedupe': return s.columns?.length ? `Remove duplicates of ${s.columns.join(', ')}` : 'Remove duplicate rows';
    case 'sort': return `Sort by ${s.by.map((b) => `${b.column}${b.desc ? ' descending' : ''}`).join(', ')}`;
  }
}

function stepSelect(s: PrepStep, prev: string): string {
  const c = 'column' in s ? q(s.column) : '';
  switch (s.op) {
    case 'filter': return `SELECT * FROM ${prev} WHERE ${guardFragment(s.condition, 'The condition')}`;
    case 'keep': return `SELECT ${s.columns.map(q).join(', ')} FROM ${prev}`;
    case 'drop': return `SELECT * EXCLUDE (${s.columns.map(q).join(', ')}) FROM ${prev}`;
    case 'rename': return `SELECT * RENAME (${c} AS ${q(s.to)}) FROM ${prev}`;
    case 'cast': return `SELECT * REPLACE (TRY_CAST(${c} AS ${s.type}) AS ${c}) FROM ${prev}`;
    case 'fill': return `SELECT * REPLACE (coalesce(${c}, ${lit(s.value)}) AS ${c}) FROM ${prev}`;
    case 'text': {
      const e = { trim: `trim(${c})`, lower: `lower(${c})`, upper: `upper(${c})`, collapse_spaces: `regexp_replace(trim(${c}), '\\s+', ' ', 'g')`, digits_only: `regexp_replace(${c}, '[^0-9]', '', 'g')` }[s.fn];
      return `SELECT * REPLACE (${e} AS ${c}) FROM ${prev}`;
    }
    case 'replace': return `SELECT * REPLACE (replace(${c}, ${lit(s.find)}, ${lit(s.with)}) AS ${c}) FROM ${prev}`;
    case 'derive': return `SELECT *, ${guardFragment(s.expression, 'The expression')} AS ${q(s.name)} FROM ${prev}`;
    case 'split': return `SELECT *, ${s.into.map((n, i) => `nullif(split_part(${c}, ${lit(s.separator)}, ${i + 1}), '') AS ${q(n)}`).join(', ')} FROM ${prev}`;
    case 'parse_date': return `SELECT * REPLACE (try_strptime(CAST(${c} AS VARCHAR), ${lit(s.format)}) AS ${c}) FROM ${prev}`;
    case 'dedupe': return s.columns?.length ? `SELECT * FROM ${prev} QUALIFY row_number() OVER (PARTITION BY ${s.columns.map(q).join(', ')}) = 1` : `SELECT DISTINCT * FROM ${prev}`;
    case 'sort': return `SELECT * FROM ${prev} ORDER BY ${s.by.map((b) => `${q(b.column)}${b.desc ? ' DESC' : ''}`).join(', ')}`;
  }
}

/** The recipe as one SELECT: a CTE per step, each commented with what it does. */
export function compileRecipe(source: string, steps: PrepStep[]): string {
  if (!source.trim()) throw badRequest('Choose the table or file to prepare');
  if (!steps.length) return `SELECT * FROM ${relation(source)}`;
  const ctes = steps.map((s, i) => `  -- ${i + 1}. ${describeStep(s).replace(/\n/g, ' ')}\n  step_${i + 1} AS (${stepSelect(s, i === 0 ? relation(source) : `step_${i}`)})`);
  const sql = `WITH\n${ctes.join(',\n')}\nSELECT * FROM step_${steps.length}`;
  const a = analyzeSql(sql);
  if (a.isMutating || a.statements.length !== 1) throw badRequest('A recipe compiles to one read-only SELECT; a step changes that');
  return sql;
}

export class PrepService {
  private ctx!: AppContext;
  bind(ctx: AppContext) {
    this.ctx = ctx;
  }

  /** The compiled SQL, the first rows of the result, and the rows left after each step. */
  async preview(p: Principal, workspaceId: string, source: string, steps: PrepStep[], limit = 100) {
    const sql = compileRecipe(source, steps);
    const rows = Math.min(Math.max(limit, 1), 1000);
    const result = await this.ctx.queries.run(p, workspaceId, `${sql}\nLIMIT ${rows}`, { maxRows: rows });
    // Rows after each step, in one pass: the source, then step 1..n.
    const counts: number[] = [];
    if (steps.length) {
      const body = sql.slice(0, sql.lastIndexOf('\nSELECT * FROM step_'));
      const r = await this.ctx.queries.run(p, workspaceId, `${body}\nSELECT ${[`(SELECT count(*) FROM ${relation(source)})`, ...steps.map((_, i) => `(SELECT count(*) FROM step_${i + 1})`)].join(', ')}`, { maxRows: 1 });
      counts.push(...(r.rows[0] ?? []).map(Number));
    } else {
      const r = await this.ctx.queries.run(p, workspaceId, `SELECT count(*) FROM ${relation(source)}`, { maxRows: 1 });
      counts.push(Number(r.rows[0]?.[0] ?? 0));
    }
    return { sql, columns: result.columns, rows: result.rows, source_rows: counts[0] ?? 0, step_rows: counts.slice(1), steps: steps.map(describeStep) };
  }

  /** Saves the result: a view (always current), a table (a copy now), or a model of a dbt project. */
  async save(p: Principal, workspaceId: string, input: { source: string; steps: PrepStep[]; name: string; as: 'view' | 'table' | 'dbt'; project_id?: string; replace?: boolean }, opts: { dryRun?: boolean } = {}) {
    const sql = compileRecipe(input.source, input.steps);
    const name = input.name.trim();
    if (input.as === 'dbt') {
      if (!input.project_id) throw badRequest('Choose the dbt project for the model');
      const r = await this.ctx.dbt.addModel(p, input.project_id, { name, sql, materialized: 'table', description: `Prepared from ${input.source}: ${input.steps.map(describeStep).join('; ')}`, overwrite: input.replace });
      return { kind: 'dbt' as const, name, path: r.path, sql: r.sql };
    }
    if (!/^[A-Za-z_][\w]*(\.[A-Za-z_][\w]*)?$/.test(name)) throw badRequest('Name the result with letters, digits and underscores (schema.name is fine)');
    const target = relation(name);
    await this.ctx.queries.run(p, workspaceId, `CREATE ${input.replace ? 'OR REPLACE ' : ''}${input.as === 'view' ? 'VIEW' : 'TABLE'} ${target} AS\n${sql}`, { dryRun: opts.dryRun });
    return { kind: input.as, name, sql };
  }
}
