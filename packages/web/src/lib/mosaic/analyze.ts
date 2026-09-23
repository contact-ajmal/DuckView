/**
 * Shared dataset analysis for Mosaic views: resolves a table/file/query into a table name the coordinator can
 * `FROM`, classifies columns for charting, and turns that into a declarative spec (the "generate from dataset"
 * template behind Mosaic dashboards). The Explore view uses the same pieces imperatively.
 */
import type { MosaicHandle } from './index';
import { fnv1a, quoteIdent } from './index';
import type { Spec } from './spec';

/** What to visualise: an in-database table, a data file (relative or absolute path) or an ad-hoc SELECT. */
export interface DataSource {
  kind: 'table' | 'file' | 'query';
  target: string;
  label?: string;
}

export interface ColumnInfo {
  name: string;
  type: string;
  role: 'numeric' | 'temporal' | 'category' | 'skip';
  distinct?: number;
}

export const MAX_CHARTS = 12;
export const MAX_CATEGORIES = 40;

const NUMERIC = /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UHUGEINT|FLOAT|REAL|DOUBLE|DECIMAL)/i;
const TEMPORAL = /^(DATE|TIMESTAMP)/i;
const CATEGORY = /^(VARCHAR|BOOLEAN|ENUM|UUID)/i;

const PLAIN_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The SELECT body a source stands for, or null when it is a plain table name Mosaic can use directly. Mosaic reads a
 * string table name as one identifier, so schema-qualified tables go through a view as well.
 */
export function sourceBody(source: DataSource): string | null {
  if (source.kind === 'table') return PLAIN_IDENT.test(source.target) ? null : `SELECT * FROM ${source.target.split('.').map(quoteIdent).join('.')}`;
  return source.kind === 'file' ? `SELECT * FROM '${source.target.replace(/'/g, "''")}'` : source.target.trim().replace(/;\s*$/, '');
}

/**
 * Makes the source addressable by a single table name: tables as they are, files and queries through a hidden
 * main-schema view (`<mosaic.schema>_src_<hash>`) that the server admits and hides from catalogs.
 */
export async function resolveSource(handle: MosaicHandle, source: DataSource): Promise<string> {
  const body = sourceBody(source);
  if (body === null) return source.target;
  const name = `${handle.info.schema}_src_${fnv1a(`${source.kind}:${source.target}`)}${handle.info.suffix ?? ''}`;
  await handle.coordinator.exec([`CREATE OR REPLACE VIEW ${quoteIdent(name)} AS ${body}`]);
  return name;
}

/** DESCRIBE plus approximate cardinality for text columns; roles decide which chart (if any) a column gets. */
export async function analyzeColumns(handle: MosaicHandle, table: string, signal?: { cancelled: boolean }): Promise<ColumnInfo[]> {
  const ref = quoteIdent(table);
  const described = (await handle.coordinator.query(`DESCRIBE SELECT * FROM ${ref}`, { type: 'json' })) as { column_name: string; column_type: string }[];
  if (signal?.cancelled) return [];
  const cols: ColumnInfo[] = described.map((d) => ({ name: d.column_name, type: d.column_type, role: NUMERIC.test(d.column_type) ? 'numeric' : TEMPORAL.test(d.column_type) ? 'temporal' : CATEGORY.test(d.column_type) ? 'category' : 'skip' }));
  const textCols = cols.filter((c) => c.role === 'category').slice(0, 16);
  if (textCols.length) {
    const q = `SELECT ${textCols.map((c) => `approx_count_distinct(${quoteIdent(c.name)}) AS ${quoteIdent(c.name)}`).join(', ')} FROM ${ref}`;
    const [row] = (await handle.coordinator.query(q, { type: 'json' })) as Record<string, number>[];
    for (const c of textCols) {
      c.distinct = Number(row?.[c.name] ?? 0);
      if (!(c.distinct > 0 && c.distinct <= MAX_CATEGORIES)) c.role = 'skip';
    }
  }
  return cols;
}

/**
 * A complete, editable Mosaic spec for a dataset: one cross-filtered histogram or bar chart per charted column in a
 * responsive grid, and the filtered rows underneath. Colours are left to the theme (`fill: accent`) so the same
 * spec renders in light and dark mode.
 */
export function templateSpec(source: DataSource, columns: ColumnInfo[], opts: { title?: string; accent?: string } = {}): Spec {
  const accent = opts.accent ?? '#8b5cf6';
  const charted = columns.filter((c) => c.role !== 'skip').slice(0, MAX_CHARTS);
  const body = sourceBody(source);
  const dataName = body === null ? source.target : 'source';
  const data: Record<string, unknown> | undefined = body === null ? undefined : source.kind === 'file' ? { source: { file: source.target } } : { source: { query: body } };
  // Fresh objects per plot: a shared reference would serialise as a YAML anchor/alias.
  const from = () => ({ from: dataName, filterBy: '$brush' });
  const common = { width: 320, height: 180, marginLeft: 44, marginRight: 12, marginTop: 8, marginBottom: 36, xLabelAnchor: 'center', xLabelArrow: false };
  const plots = charted.map((c) =>
    c.role === 'category'
      ? { plot: [{ mark: 'barX', data: from(), x: { count: null }, y: c.name, fill: accent, sort: { y: '-x', limit: MAX_CATEGORIES } }, { select: 'toggleY', as: '$brush' }], xLabel: `${c.name} (count)`, yLabel: null, xTickFormat: 's', yDomain: 'Fixed', ...common, marginLeft: 110 }
      : { plot: [{ mark: 'rectY', data: from(), x: { bin: c.name }, y: { count: null }, fill: accent, insetLeft: 0.5, insetRight: 0.5 }, { select: 'intervalX', as: '$brush' }], xDomain: 'Fixed', xLabel: c.name, yLabel: null, yTickFormat: 's', ...common },
  );
  const rows: unknown[] = [];
  for (let i = 0; i < plots.length; i += 3) rows.push({ hconcat: plots.slice(i, i + 3) });
  rows.push({ input: 'table', from: dataName, filterBy: '$brush', height: 320, rowBatch: 100 });
  return {
    meta: { title: opts.title ?? source.label ?? source.target, description: 'Generated by DuckView — brush a chart to cross-filter, click a bar to toggle, double-click to clear.' },
    ...(data ? { data } : {}),
    params: { brush: { select: 'crossfilter' } },
    vconcat: rows,
  };
}
