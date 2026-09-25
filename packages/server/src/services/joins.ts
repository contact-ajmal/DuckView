/**
 * How a workspace's tables join: foreign keys declared in DuckDB, and relationships inferred from column names
 * (orders.customer_id → customers.id, the same *_id column in two tables) that are then confirmed on the data —
 * how many of the values on the many side are found on the other side, and whether that side is unique.
 */
import type { AppContext } from '../context.js';
import type { Principal } from './principal.js';

export interface Relationship {
  from_table: string;
  from_column: string;
  to_table: string;
  to_column: string;
  /** declared: a FOREIGN KEY constraint; inferred: matching names, confirmed on the values. */
  source: 'declared' | 'inferred';
  cardinality: 'many-to-one' | 'one-to-one' | 'many-to-many';
  /** Share of the distinct non-null values on the from side found on the to side. */
  coverage: number;
  /** Distinct from-side values with no match (rows that would drop out of an inner join). */
  orphans: number;
  confidence: 'high' | 'medium';
  sql: string;
}
export interface JoinMap {
  tables: { name: string; type: 'TABLE' | 'VIEW'; rows: number | null; columns: string[] }[];
  relationships: Relationship[];
  checked: number;
}

const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
const rel = (name: string) => name.split('.').map(q).join('.');
const KEYISH = /(_id|_key|_code|_uuid|_sk|_no|_number)$/i;
const family = (type: string) => (/INT|DECIMAL|NUMERIC|DOUBLE|FLOAT|REAL|HUGEINT/i.test(type) ? 'number' : /CHAR|TEXT|STRING|UUID/i.test(type) ? 'text' : /DATE|TIME/i.test(type) ? 'time' : 'other');
/** customers, dim_customer, stg_customers → customer. */
export function stem(table: string): string {
  let s = (table.split('.').pop() ?? table).toLowerCase().replace(/^(dim|fct|fact|stg|raw|src|int|tbl)_/, '');
  if (s.endsWith('ies')) s = `${s.slice(0, -3)}y`;
  else if (/(ses|xes|ches|shes)$/.test(s)) s = s.slice(0, -2);
  else if (s.endsWith('s') && !s.endsWith('ss')) s = s.slice(0, -1);
  return s;
}

export class JoinService {
  private ctx!: AppContext;
  bind(ctx: AppContext) {
    this.ctx = ctx;
  }

  async discover(p: Principal, workspaceId: string, opts: { tables?: string[]; max_checks?: number } = {}): Promise<JoinMap> {
    const c = this.ctx;
    const all = (await c.lineage.catalog(p, workspaceId)).filter((o) => o.schema !== 'information_schema' && o.schema !== 'pg_catalog' && !o.name.startsWith('duckdb_'));
    const full = (o: { schema: string; name: string }) => (o.schema === 'main' ? o.name : `${o.schema}.${o.name}`);
    const wanted = opts.tables?.length ? new Set(opts.tables.map((t) => t.toLowerCase().replace(/^main\./, ''))) : null;
    // With a list, relationships touching those tables (to any other table); without, the whole workspace.
    const focus = (name: string) => !wanted || wanted.has(name.toLowerCase()) || wanted.has((name.split('.').pop() ?? '').toLowerCase());
    const objects = all.slice(0, 120).map((o) => ({ name: full(o), type: o.type, rows: o.estimated_rows, columns: o.columns }));
    const byName = new Map(objects.map((o) => [o.name.toLowerCase(), o]));
    const found = new Map<string, Relationship>();
    const pairKey = (a: string, ac: string, b: string, bc: string) => [`${a}.${ac}`, `${b}.${bc}`].map((s) => s.toLowerCase()).sort().join('~');

    // Declared foreign keys.
    try {
      const r = await c.queries.run(p, workspaceId, "SELECT schema_name, table_name, constraint_column_names, referenced_table, referenced_column_names FROM duckdb_constraints() WHERE constraint_type = 'FOREIGN KEY'", { maxRows: 1000 });
      for (const [schema, table, cols, refTable, refCols] of r.rows as [string, string, string[], string, string[]][]) {
        const from = schema === 'main' ? table : `${schema}.${table}`;
        const to = byName.get(String(refTable).toLowerCase()) ? String(refTable) : schema === 'main' ? String(refTable) : `${schema}.${refTable}`;
        if (!focus(from) && !focus(to)) continue;
        const fc = cols?.[0];
        const tc = refCols?.[0];
        if (!fc || !tc) continue;
        found.set(pairKey(from, fc, to, tc), { from_table: from, from_column: fc, to_table: to, to_column: tc, source: 'declared', cardinality: 'many-to-one', coverage: 1, orphans: 0, confidence: 'high', sql: joinSql(from, fc, to, tc) });
      }
    } catch {
      /* an engine without duckdb_constraints: inferred only */
    }

    // Candidates from names: x.customer_id → customers.id, and the same key-like column in two tables.
    const candidates: [string, string, string, string][] = [];
    for (const a of objects) {
      for (const b of objects) {
        if (a === b || (!focus(a.name) && !focus(b.name))) continue;
        const s = stem(b.name);
        for (const ac of a.columns) {
          const an = ac.name.toLowerCase();
          for (const bc of b.columns) {
            const bn = bc.name.toLowerCase();
            if (family(ac.type) !== family(bc.type) || family(ac.type) === 'other' || family(ac.type) === 'time') continue;
            const byStem = (an === `${s}_id` || an === `${s}_key` || an === `${s}_code` || an === `${s}id`) && (bn === 'id' || bn === an || bn === 'key' || bn === 'code');
            const sameKey = an === bn && KEYISH.test(an) && a.name < b.name;
            if (byStem || sameKey) candidates.push([a.name, ac.name, b.name, bc.name]);
          }
        }
      }
    }
    const limit = Math.min(Math.max(opts.max_checks ?? 150, 1), 500);
    let checked = 0;
    for (const [a, ac, b, bc] of candidates) {
      const key = pairKey(a, ac, b, bc);
      if (found.has(key)) continue;
      if (checked >= limit) break;
      checked++;
      try {
        const sql = `WITH av AS (SELECT CAST(${q(ac)} AS VARCHAR) AS v FROM ${rel(a)} WHERE ${q(ac)} IS NOT NULL), bv AS (SELECT CAST(${q(bc)} AS VARCHAR) AS v FROM ${rel(b)} WHERE ${q(bc)} IS NOT NULL), ad AS (SELECT DISTINCT v FROM av), bd AS (SELECT DISTINCT v FROM bv)
SELECT (SELECT count(*) FROM av), (SELECT count(*) FROM ad), (SELECT count(*) FROM bv), (SELECT count(*) FROM bd), (SELECT count(*) FROM ad SEMI JOIN bd USING (v))`;
        const r = await c.queries.run(p, workspaceId, sql, { maxRows: 1 });
        const [aRows, aDistinct, bRows, bDistinct, matched] = (r.rows[0] ?? []).map(Number) as [number, number, number, number, number];
        if (!aDistinct || !bDistinct || !matched) continue;
        const aUnique = aRows === aDistinct;
        const bUnique = bRows === bDistinct;
        // The many side points at the unique side; with the same column in both, turn it round when needed.
        const flip = !bUnique && aUnique;
        const [ft, fc, tt, tc] = flip ? [b, bc, a, ac] : [a, ac, b, bc];
        const fromDistinct = flip ? bDistinct : aDistinct;
        const coverage = matched / fromDistinct;
        if (coverage < 0.5) continue;
        const cardinality: Relationship['cardinality'] = aUnique && bUnique ? 'one-to-one' : aUnique || bUnique ? 'many-to-one' : 'many-to-many';
        found.set(key, { from_table: ft, from_column: fc, to_table: tt, to_column: tc, source: 'inferred', cardinality, coverage: Math.round(coverage * 1000) / 1000, orphans: fromDistinct - matched, confidence: coverage >= 0.95 && cardinality !== 'many-to-many' ? 'high' : 'medium', sql: joinSql(ft, fc, tt, tc) });
      } catch {
        /* unreadable table (a view over a missing file…) */
      }
    }
    const relationships = [...found.values()].sort((x, y) => (x.source === y.source ? (x.confidence === y.confidence ? x.from_table.localeCompare(y.from_table) || x.from_column.localeCompare(y.from_column) : x.confidence === 'high' ? -1 : 1) : x.source === 'declared' ? -1 : 1));
    const involved = new Map<string, Set<string>>();
    for (const r of relationships) {
      if (!involved.has(r.from_table)) involved.set(r.from_table, new Set());
      if (!involved.has(r.to_table)) involved.set(r.to_table, new Set());
      involved.get(r.from_table)!.add(r.from_column);
      involved.get(r.to_table)!.add(r.to_column);
    }
    const tables = [...involved].map(([name, cols]) => {
      const o = byName.get(name.toLowerCase());
      return { name, type: o?.type ?? ('TABLE' as const), rows: o?.rows ?? null, columns: [...cols].sort() };
    }).sort((x, y) => x.name.localeCompare(y.name));
    return { tables, relationships, checked };
  }
}

function joinSql(from: string, fc: string, to: string, tc: string): string {
  const fa = 'a';
  const ta = 'b';
  return `SELECT *\nFROM ${rel(from)} AS ${fa}\nJOIN ${rel(to)} AS ${ta} ON ${fa}.${q(fc)} = ${ta}.${q(tc)}\nLIMIT 100`;
}
