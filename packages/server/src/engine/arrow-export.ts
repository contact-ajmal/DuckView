/**
 * Node-side Arrow IPC (stream format) writer for DuckDB results.
 * Used when the DuckDB `arrow` extension is not available (offline / external access disabled).
 * Rows are converted chunk-by-chunk, so memory stays bounded regardless of result size.
 */
import fs from 'node:fs';
import type { DuckDBResult } from '@duckdb/node-api';
import { RecordBatchStreamWriter, RecordBatch, Schema, Field, Utf8, Int8, Int16, Int32, Int64, Uint8, Uint16, Uint32, Uint64, Float32, Float64, Bool, DateMillisecond, TimestampMillisecond, TimestampMicrosecond, makeData, Struct, vectorFromArray, tableToIPC, Table, type DataType } from 'apache-arrow';
import type { ColumnSchema } from './results.js';

function arrowType(duck: string): { type: DataType; convert: (v: unknown) => unknown } {
  const t = duck.toUpperCase();
  const num = (v: unknown) => (v == null ? null : Number(v));
  const big = (v: unknown) => (v == null ? null : typeof v === 'bigint' ? v : BigInt(String(v)));
  switch (true) {
    case t === 'TINYINT':
      return { type: new Int8(), convert: num };
    case t === 'SMALLINT':
      return { type: new Int16(), convert: num };
    case t === 'INTEGER':
      return { type: new Int32(), convert: num };
    case t === 'BIGINT':
      return { type: new Int64(), convert: big };
    case t === 'UTINYINT':
      return { type: new Uint8(), convert: num };
    case t === 'USMALLINT':
      return { type: new Uint16(), convert: num };
    case t === 'UINTEGER':
      return { type: new Uint32(), convert: num };
    case t === 'UBIGINT':
      return { type: new Uint64(), convert: big };
    case t === 'FLOAT' || t === 'REAL':
      return { type: new Float32(), convert: num };
    case t === 'DOUBLE' || t.startsWith('DECIMAL') || t === 'HUGEINT' || t === 'UHUGEINT':
      return { type: new Float64(), convert: num };
    case t === 'BOOLEAN':
      return { type: new Bool(), convert: (v) => (v == null ? null : Boolean(v)) };
    case t === 'DATE':
      return { type: new DateMillisecond(), convert: (v) => (v == null ? null : new Date(String(v))) };
    case t.startsWith('TIMESTAMP'):
      return { type: t.includes('_NS') || t.includes('_US') ? new TimestampMicrosecond() : new TimestampMillisecond(), convert: (v) => (v == null ? null : new Date(String(v).replace(' ', 'T').replace(/(\+\d\d)$/, '$1:00'))) };
    default:
      // VARCHAR, UUID, BLOB, INTERVAL, LIST/STRUCT/MAP/JSON → UTF-8 (nested values serialised as JSON)
      return { type: new Utf8(), convert: (v) => (v == null ? null : typeof v === 'object' ? JSON.stringify(v) : String(v)) };
  }
}

/** Streams a DuckDB result into an Arrow IPC stream file. Returns the row count. */
export async function writeArrowStream(result: DuckDBResult, filePath: string): Promise<number> {
  const names = result.deduplicatedColumnNames();
  const types = result.columnTypes().map((t) => arrowType(t.toString()));
  const schema = new Schema(names.map((n, i) => new Field(n, types[i]!.type, true)));
  const out = fs.createWriteStream(filePath);
  const writer = new RecordBatchStreamWriter();
  writer.pipe(out);
  let rows = 0;
  try {
    for await (const chunk of result.yieldRowsJson()) {
      const n = chunk.length;
      if (n === 0) continue;
      const vectors = names.map((_name, c) => {
        const conv = types[c]!.convert;
        const values = new Array(n);
        for (let r = 0; r < n; r++) values[r] = conv(chunk[r]![c]);
        return vectorFromArray(values, types[c]!.type);
      });
      const data = makeData({ type: new Struct(schema.fields), length: n, nullCount: 0, children: vectors.map((v) => v.data[0]!) });
      writer.write(new RecordBatch(schema, data));
      rows += n;
    }
    if (rows === 0) {
      const data = makeData({ type: new Struct(schema.fields), length: 0, nullCount: 0, children: names.map((_n, c) => vectorFromArray([], types[c]!.type).data[0]!) });
      writer.write(new RecordBatch(schema, data));
    }
  } finally {
    writer.close();
    await new Promise<void>((resolve, reject) => {
      out.on('finish', () => resolve());
      out.on('error', reject);
    });
  }
  return rows;
}

/**
 * Encodes an already-materialised result (columns + JSON-safe rows, as held by the result cache) as an Arrow IPC
 * stream — the wire format Mosaic clients decode. Small aggregate results dominate that workload, so a row-wise
 * conversion is fine; rasters of ~1e5 rows take a few milliseconds.
 */
export function resultToArrowIPC(columns: ColumnSchema[], rows: unknown[][]): Uint8Array {
  const types = columns.map((c) => arrowType(c.type));
  const schema = new Schema(columns.map((c, i) => new Field(c.name, types[i]!.type, true)));
  const n = rows.length;
  const vectors = columns.map((_c, i) => {
    const conv = types[i]!.convert;
    const values = new Array(n);
    for (let r = 0; r < n; r++) values[r] = conv(rows[r]![i]);
    return vectorFromArray(values, types[i]!.type);
  });
  const data = makeData({ type: new Struct(schema.fields), length: n, nullCount: 0, children: vectors.map((v) => v.data[0]!) });
  return tableToIPC(new Table(schema, [new RecordBatch(schema, data)]), 'stream');
}
