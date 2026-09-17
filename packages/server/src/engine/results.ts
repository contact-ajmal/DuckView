/**
 * Result shaping: JSON-safe rows, typed schema, cell truncation and Markdown rendering.
 */
import type { DuckDBResultReader } from '@duckdb/node-api';

export interface ColumnSchema {
  name: string;
  type: string;
  /** Coarse JS-facing category for UI/agents. */
  kind: 'number' | 'string' | 'boolean' | 'temporal' | 'json' | 'binary' | 'null';
}

export interface QueryResult {
  columns: ColumnSchema[];
  rows: unknown[][];
  rowCount: number;
  totalRows: number | null;
  truncated: boolean;
  rowsChanged: number | null;
  durationMs: number;
  statementCount: number;
  statementClass: string;
}

const INTEGER_TYPES = new Set(['TINYINT', 'SMALLINT', 'INTEGER', 'BIGINT', 'HUGEINT', 'UTINYINT', 'USMALLINT', 'UINTEGER', 'UBIGINT', 'UHUGEINT']);

export function kindOf(typeName: string): ColumnSchema['kind'] {
  const t = typeName.toUpperCase();
  if (INTEGER_TYPES.has(t) || t === 'FLOAT' || t === 'DOUBLE' || t.startsWith('DECIMAL') || t === 'REAL') return 'number';
  if (t === 'BOOLEAN') return 'boolean';
  if (t.startsWith('TIMESTAMP') || t === 'DATE' || t.startsWith('TIME') || t === 'INTERVAL') return 'temporal';
  if (t === 'BLOB' || t === 'BIT') return 'binary';
  if (t.startsWith('STRUCT') || t.startsWith('MAP') || t.endsWith('[]') || t.startsWith('UNION') || t === 'JSON' || t.startsWith('LIST') || t.startsWith('ARRAY')) return 'json';
  if (t === '"NULL"' || t === 'NULL') return 'null';
  return 'string';
}

/** Converts DuckDB JSON-safe values into UI-friendly primitives (safe bigints → number, decimals → number). */
export function normalizeValue(value: unknown, typeName: string): unknown {
  if (value === null || value === undefined) return null;
  const t = typeName.toUpperCase();
  if (typeof value === 'string' && (INTEGER_TYPES.has(t) || t.startsWith('DECIMAL'))) {
    const n = Number(value);
    if (Number.isFinite(n) && (Number.isSafeInteger(n) || t.startsWith('DECIMAL'))) return n;
    return value;
  }
  if (typeof value === 'bigint') {
    return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString();
  }
  return value;
}

export function readerToResult(reader: DuckDBResultReader, opts: { limit: number; durationMs: number; statementCount: number; statementClass: string }): QueryResult {
  const names = reader.deduplicatedColumnNames();
  const types = reader.columnTypes().map((t) => t.toString());
  const columns: ColumnSchema[] = names.map((name, i) => ({ name, type: types[i] ?? 'UNKNOWN', kind: kindOf(types[i] ?? '') }));
  const raw = reader.getRowsJson();
  const truncated = raw.length > opts.limit || !reader.done;
  const sliced = raw.slice(0, opts.limit);
  const rows = sliced.map((r) => r.map((v, i) => normalizeValue(v, types[i] ?? '')));
  return {
    columns,
    rows,
    rowCount: rows.length,
    totalRows: null,
    truncated,
    rowsChanged: reader.rowsChanged > 0 ? reader.rowsChanged : null,
    durationMs: opts.durationMs,
    statementCount: opts.statementCount,
    statementClass: opts.statementClass,
  };
}

export function truncateCell(value: unknown, maxChars: number): string {
  let s: string;
  if (value === null || value === undefined) s = 'NULL';
  else if (typeof value === 'object') s = JSON.stringify(value);
  else s = String(value);
  if (s.length > maxChars) return s.slice(0, maxChars - 1) + '…';
  return s;
}

export function toMarkdownTable(result: Pick<QueryResult, 'columns' | 'rows'>, maxCellChars = 400): string {
  if (result.columns.length === 0) return '_(no columns)_';
  const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  const header = `| ${result.columns.map((c) => esc(c.name)).join(' | ')} |`;
  const sep = `| ${result.columns.map(() => '---').join(' | ')} |`;
  const body = result.rows.map((r) => `| ${r.map((v) => esc(truncateCell(v, maxCellChars))).join(' | ')} |`);
  return [header, sep, ...body].join('\n');
}

export function rowsToObjects(result: Pick<QueryResult, 'columns' | 'rows'>): Record<string, unknown>[] {
  return result.rows.map((r) => Object.fromEntries(result.columns.map((c, i) => [c.name, r[i]])));
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
