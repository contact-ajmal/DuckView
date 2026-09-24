/**
 * Writing query results into open table formats — Apache Iceberg (through a REST catalog) and Delta Lake (a table
 * directory, local or in a bucket) — for reverse ETL.
 *
 * Both formats accept fewer types than DuckDB, so every column goes through `castFor`: unsigned and 128-bit
 * integers widen to what the format has, JSON, intervals and other extras become text, and for Delta nested
 * values (lists, structs, maps) are written as JSON text and naive timestamps as UTC ones.
 *
 * Delta: DuckDB's delta extension appends to an existing table (INSERT INTO an attached table commits through
 * delta-kernel) but does not create one. DuckView writes a table's first commit itself — a Parquet data file and
 * _delta_log/00000000000000000000.json with the protocol, the schema and the add action — and a replace the same
 * way as the next version: remove actions for every current file, the (new) schema and the new file.
 */
import { randomUUID } from 'node:crypto';

const qi = (s: string) => `"${s.replace(/"/g, '""')}"`;

/** A column as the format can store it: the SQL to select it, and (for Delta) its schema type. */
export function castFor(format: 'iceberg' | 'delta', name: string, duckType: string): { sql: string; type: string } {
  const t = duckType.toUpperCase();
  const col = qi(name);
  const as = (to: string) => ({ sql: `CAST(${col} AS ${to}) AS ${col}`, type: to });
  const nested = /\[\]$|^STRUCT|^MAP|^UNION|\[\d+\]$/.test(t);
  if (t === 'UTINYINT') return as('SMALLINT');
  if (t === 'USMALLINT') return as('INTEGER');
  if (t === 'UINTEGER') return as('BIGINT');
  if (t === 'UBIGINT' || t === 'HUGEINT' || t === 'UHUGEINT') return as('DECIMAL(38,0)');
  if (t === 'JSON' || t === 'INTERVAL' || t.startsWith('BIT') || t.startsWith('ENUM') || t === 'VARINT' || t === 'BIGNUM') return as('VARCHAR');
  // A naive timestamp is taken as UTC (never the server's time zone).
  const utc = (expr: string) => ({ sql: `timezone('UTC', ${expr}) AS ${col}`, type: 'TIMESTAMP WITH TIME ZONE' });
  if (t === 'TIMESTAMP_NS' || t === 'TIMESTAMP_MS' || t === 'TIMESTAMP_S') return format === 'delta' ? utc(`CAST(${col} AS TIMESTAMP)`) : as('TIMESTAMP');
  if (format === 'delta') {
    if (nested) return { sql: `CAST(to_json(${col}) AS VARCHAR) AS ${col}`, type: 'VARCHAR' };
    // Delta's "timestamp" is UTC; a naive one would need the timestampNtz table feature.
    if (t === 'TIMESTAMP') return utc(col);
    // Delta has no UUID or time-of-day type.
    if (t === 'UUID' || t === 'TIME' || t === 'TIME WITH TIME ZONE') return as('VARCHAR');
  }
  return { sql: col, type: t };
}

/** A DuckDB type (after castFor) as a Delta schema type. */
export function deltaType(duckType: string): string {
  const t = duckType.toUpperCase();
  const dec = /^DECIMAL\((\d+),\s*(\d+)\)$/.exec(t);
  if (dec) return `decimal(${dec[1]},${dec[2]})`;
  const map: Record<string, string> = { TINYINT: 'byte', SMALLINT: 'short', INTEGER: 'integer', BIGINT: 'long', FLOAT: 'float', DOUBLE: 'double', BOOLEAN: 'boolean', VARCHAR: 'string', BLOB: 'binary', DATE: 'date', 'TIMESTAMP WITH TIME ZONE': 'timestamp' };
  return map[t] ?? 'string';
}

export interface DeltaFile {
  path: string;
  size: number;
  rows: number;
}

/** A commit's lines: protocol and schema when the table is new or replaced, removes, the add, and commitInfo. */
export function deltaCommit(opts: { tableId: string; columns: { name: string; type: string }[]; create: boolean; replace: boolean; remove: string[]; add: DeltaFile; now?: number }): string {
  const now = opts.now ?? Date.now();
  const lines: Record<string, unknown>[] = [{ commitInfo: { timestamp: now, operation: opts.create ? 'CREATE TABLE AS SELECT' : 'WRITE', operationParameters: { mode: opts.create || opts.replace ? 'Overwrite' : 'Append' }, engineInfo: 'DuckView', isBlindAppend: !opts.replace } }];
  if (opts.create) lines.push({ protocol: { minReaderVersion: 1, minWriterVersion: 2 } });
  if (opts.create || opts.replace) {
    const schema = { type: 'struct', fields: opts.columns.map((c) => ({ name: c.name, type: deltaType(c.type), nullable: true, metadata: {} })) };
    lines.push({ metaData: { id: opts.tableId, format: { provider: 'parquet', options: {} }, schemaString: JSON.stringify(schema), partitionColumns: [], configuration: {}, createdTime: now } });
  }
  for (const path of opts.remove) lines.push({ remove: { path, deletionTimestamp: now, dataChange: true } });
  lines.push({ add: { path: opts.add.path, partitionValues: {}, size: opts.add.size, modificationTime: now, dataChange: true, stats: JSON.stringify({ numRecords: opts.add.rows }) } });
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

/** The latest version in a _delta_log listing (commit files and checkpoints), or -1 for none. */
export function latestDeltaVersion(names: string[]): number {
  let v = -1;
  for (const n of names) {
    const m = /^(\d{20})\.(json|checkpoint(\.\d+\.\d+)?\.parquet)$/.exec(n.replace(/^.*\//, ''));
    if (m) v = Math.max(v, Number(m[1]));
  }
  return v;
}

export const deltaLogName = (version: number) => `${String(version).padStart(20, '0')}.json`;
export const newDataFile = () => `part-00000-${randomUUID()}-c000.zstd.parquet`;
