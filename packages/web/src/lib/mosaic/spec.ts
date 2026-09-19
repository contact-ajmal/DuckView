/**
 * Mosaic declarative specs (https://idl.uw.edu/mosaic/spec/) inside DuckView.
 *
 * A spec's `data` block normally instantiates to `CREATE TABLE … AS SELECT …` / `loadParquet(...)` statements that
 * Mosaic runs against its own DuckDB. DuckView's engine belongs to a workspace, so instead every dataset becomes a
 * hidden, epoch-scoped source view in the main schema (`<mosaic.schema>_src_<hash>`) — the only CREATE shape the
 * server admits from a browser — and each `from:` reference is rewritten to that view. Tables and views that already
 * exist in the workspace need no `data` entry at all: `from: trips` just works.
 *
 * Both JSON and YAML are accepted as text; specs are stored as JSON objects.
 */
import YAML from 'yaml';
import { createTable, loadCSV, loadJSON, loadObjects, loadParquet } from '@uwdata/mosaic-sql';
import { fnv1a } from './index';

export type { Spec } from './summary';
import type { Spec } from './summary';

export interface PreparedSource {
  /** Dataset name as written in the spec. */
  name: string;
  /** Main-schema view that stands in for it. */
  view: string;
  kind: 'query' | 'parquet' | 'csv' | 'json' | 'objects';
}

export interface PreparedSpec {
  /** The spec with `data` removed and every `from:` pointing at a source view. */
  spec: Spec;
  /** `CREATE OR REPLACE VIEW` statements to run (through the coordinator) before rendering. */
  statements: string[];
  sources: PreparedSource[];
}

export class SpecError extends Error {}

/** Parses spec text — JSON when it starts with `{`, YAML otherwise. */
export function parseSpecText(text: string): Spec {
  const t = text.trim();
  if (!t) throw new SpecError('The spec is empty');
  let value: unknown;
  if (t.startsWith('{')) {
    try {
      value = JSON.parse(t);
    } catch (e) {
      throw new SpecError(`Invalid JSON: ${(e as Error).message}`);
    }
  } else {
    try {
      value = YAML.parse(t, { prettyErrors: true });
    } catch (e) {
      throw new SpecError(`Invalid YAML: ${(e as Error).message}`);
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SpecError('A spec must be a mapping/object at the top level');
  return value as Spec;
}

export function specToText(spec: Spec, format: 'yaml' | 'json'): string {
  return format === 'json' ? JSON.stringify(spec, null, 2) : YAML.stringify(spec, { lineWidth: 0, aliasDuplicateObjects: false });
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function fileExtension(file: unknown): string | null {
  if (typeof file !== 'string') return null;
  const idx = file.lastIndexOf('.');
  return idx > 0 ? file.slice(idx + 1).toLowerCase() : null;
}

/** Turns one `data` entry into the CREATE OR REPLACE VIEW statement standing in for it (or null for an existing table). */
function sourceStatement(name: string, def: unknown, view: string): { sql: string; kind: PreparedSource['kind'] } | null {
  const opt = { view: true, replace: true } as const;
  if (typeof def === 'string') return { sql: String(createTable(view, def.trim().replace(/;\s*$/, ''), opt)), kind: 'query' };
  if (Array.isArray(def)) {
    if (!def.length || !isObject(def[0])) throw new SpecError(`data.${name}: inline data must be a non-empty list of objects`);
    return { sql: String(loadObjects(view, def as Record<string, unknown>[], opt)), kind: 'objects' };
  }
  if (!isObject(def)) throw new SpecError(`data.${name}: expected a query string, a list of rows or a definition object`);
  const { type: declared, file, query, data, temp: _temp, view: _view, replace: _replace, ...options } = def as Record<string, unknown>;
  const type = (typeof declared === 'string' && declared) || fileExtension(file) || 'table';
  const fileName = typeof file === 'string' ? file : null;
  switch (type) {
    case 'table':
      if (typeof query === 'string' && query.trim()) return { sql: String(createTable(view, query.trim().replace(/;\s*$/, ''), opt)), kind: 'query' };
      return null; // an existing table in the workspace
    case 'parquet':
      if (!fileName) throw new SpecError(`data.${name}: parquet data needs a file`);
      return { sql: String(loadParquet(view, fileName, { ...options, ...opt })), kind: 'parquet' };
    case 'csv':
      if (!fileName) throw new SpecError(`data.${name}: csv data needs a file`);
      return { sql: String(loadCSV(view, fileName, { ...options, ...opt })), kind: 'csv' };
    case 'json':
      if (Array.isArray(data)) return { sql: String(loadObjects(view, data as Record<string, unknown>[], { ...options, ...opt })), kind: 'objects' };
      if (!fileName) throw new SpecError(`data.${name}: json data needs a file or inline data`);
      return { sql: String(loadJSON(view, fileName, { ...options, ...opt })), kind: 'json' };
    case 'spatial':
      throw new SpecError(`data.${name}: spatial data is not available in DuckView dashboards`);
    default:
      throw new SpecError(`data.${name}: unknown data type "${type}"`);
  }
}

/** Rewrites every `from: <dataset>` reference (marks, inputs, tables) to the view that stands in for it. */
function rewriteFrom(node: unknown, map: Map<string, string>): unknown {
  if (Array.isArray(node)) return node.map((n) => rewriteFrom(n, map));
  if (!isObject(node)) return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === 'from' && typeof v === 'string' && map.has(v)) out[k] = map.get(v);
    else out[k] = rewriteFrom(v, map);
  }
  return out;
}

/**
 * Prepares a spec for a workspace: dataset definitions become source-view statements, references are rewritten.
 * `viewPrefix` is `<mosaic.schema>_src_` (from /api/mosaic/info).
 */
export function prepareSpec(spec: Spec, viewPrefix: string): PreparedSpec {
  const { data, ...rest } = spec;
  const statements: string[] = [];
  const sources: PreparedSource[] = [];
  const map = new Map<string, string>();
  if (data !== undefined) {
    if (!isObject(data)) throw new SpecError('`data` must be a mapping of dataset name → definition');
    for (const [name, def] of Object.entries(data)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new SpecError(`data.${name}: dataset names must be plain identifiers`);
      // The view name hashes the definition, so an edited dataset gets a fresh view and an unchanged one is reused.
      const view = `${viewPrefix}${fnv1a(`${name}\n${JSON.stringify(def)}`)}`;
      const st = sourceStatement(name, def, view);
      if (!st) continue;
      statements.push(st.sql);
      sources.push({ name, view, kind: st.kind });
      map.set(name, view);
    }
  }
  return { spec: rewriteFrom(rest, map) as Spec, statements, sources };
}
