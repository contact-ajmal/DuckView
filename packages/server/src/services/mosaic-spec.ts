/**
 * Mosaic declarative specs (https://idl.uw.edu/mosaic/spec/) on the server: parsing (JSON or YAML), structural
 * validation against the Mosaic vocabulary, and "preparation" — turning the spec's `data` definitions into the
 * source-view statements DuckView admits (`CREATE OR REPLACE VIEW "<schema>_src_<hash>" AS …`) and rewriting every
 * `from:` reference to those views. The browser renders the prepared spec; agents and Copilot get the same
 * validation before a dashboard is saved.
 *
 * Validation mirrors @uwdata/mosaic-spec's parser (unknown marks, attributes, interactors, legends, inputs, transforms
 * and selection types are errors; a component must be exactly one of plot/mark/legend/input/hconcat/vconcat/
 * hspace/vspace) without loading it: mosaic-core drags DuckDB-WASM along, which has no place in the server image.
 */
import YAML from 'yaml';
import { createHash } from 'node:crypto';
import { createTable, loadCSV, loadJSON, loadObjects, loadParquet } from '@uwdata/mosaic-sql';
import { MOSAIC_NAMES } from './mosaic-names.js';
import { badRequest } from './errors.js';

export type Spec = Record<string, unknown>;

export interface PreparedSource {
  name: string;
  /** Main-schema view Mosaic addresses the dataset by. */
  view: string;
  kind: 'query' | 'parquet' | 'csv' | 'json' | 'objects';
  /** The SELECT behind the dataset (what gets bound/validated). */
  body: string;
  /** Materialised once into the in-memory database (fast interactions) rather than re-read through a view. */
  materialize: boolean;
  /** `"<memDb>"."src_<hash>"` — the in-memory table when materialised. */
  table: string;
}

export interface PrepareOptions {
  /** `<mosaic.schema>_src_` */
  viewPrefix: string;
  /** Attached in-memory database for materialised datasets (`<mosaic.schema>_mem`). */
  memDb: string;
  /** Default for datasets that do not say `materialize:` themselves. */
  materialize: boolean;
  /** Appended to object hashes (hex): per access-policy scope. */
  salt?: string;
}

export interface PreparedSpec {
  spec: Spec;
  statements: string[];
  sources: PreparedSource[];
  /** Plain `from:` names that are not declared datasets — expected to exist in the workspace. */
  tables: string[];
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** FNV-1a hex, identical to the browser's, so both sides name the same view for the same definition. */
export function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Parses spec text — JSON when it starts with `{`, YAML otherwise. */
export function parseSpecText(text: string): Spec {
  const t = text.trim();
  if (!t) throw badRequest('The spec is empty');
  let value: unknown;
  if (t.startsWith('{')) {
    try {
      value = JSON.parse(t);
    } catch (e) {
      throw badRequest(`Invalid JSON: ${(e as Error).message}`);
    }
  } else {
    try {
      value = YAML.parse(t, { prettyErrors: true });
    } catch (e) {
      throw badRequest(`Invalid YAML: ${(e as Error).message}`);
    }
  }
  if (!isObject(value)) throw badRequest('A spec must be a mapping/object at the top level');
  return value;
}

export const specToYaml = (spec: Spec) => YAML.stringify(spec, { lineWidth: 0, aliasDuplicateObjects: false });

function fileExtension(file: unknown): string | null {
  if (typeof file !== 'string') return null;
  const idx = file.lastIndexOf('.');
  return idx > 0 ? file.slice(idx + 1).toLowerCase() : null;
}

/** One `data` entry → the SELECT standing in for it (as a CREATE VIEW statement to reuse Mosaic's generators), or null for a table that already exists. */
function sourceStatement(name: string, def: unknown, view: string): { sql: string; kind: PreparedSource['kind']; materialize: boolean | null } | null {
  const opt = { view: true, replace: true } as const;
  const trimSql = (q: string) => q.trim().replace(/;\s*$/, '');
  if (typeof def === 'string') return { sql: String(createTable(view, trimSql(def), opt)), kind: 'query', materialize: null };
  if (Array.isArray(def)) {
    if (!def.length || !isObject(def[0])) throw badRequest(`data.${name}: inline data must be a non-empty list of objects`);
    return { sql: String(loadObjects(view, def as Record<string, unknown>[], opt)), kind: 'objects', materialize: null };
  }
  if (!isObject(def)) throw badRequest(`data.${name}: expected a query string, a list of rows or a definition object`);
  // `materialize` is DuckView's own option; it must not reach the read_* parameter list.
  const { type: declared, file, query, data, temp: _t, view: _v, replace: _r, materialize: mat, ...options } = def;
  const materialize = typeof mat === 'boolean' ? mat : null;
  const r = sourceStatementFor(name, view, { declared, file, query, data, options, opt });
  return r && { ...r, materialize };
}

function sourceStatementFor(name: string, view: string, { declared, file, query, data, options, opt }: { declared: unknown; file: unknown; query: unknown; data: unknown; options: Record<string, unknown>; opt: { view: true; replace: true } }): { sql: string; kind: PreparedSource['kind'] } | null {
  const trimSql = (q: string) => q.trim().replace(/;\s*$/, '');
  const type = (typeof declared === 'string' && declared) || fileExtension(file) || 'table';
  const fileName = typeof file === 'string' ? file : null;
  switch (type) {
    case 'table':
      if (typeof query === 'string' && query.trim()) return { sql: String(createTable(view, trimSql(query), opt)), kind: 'query' };
      return null;
    case 'parquet':
      if (!fileName) throw badRequest(`data.${name}: parquet data needs a file`);
      return { sql: String(loadParquet(view, fileName, { ...options, ...opt })), kind: 'parquet' };
    case 'csv':
      if (!fileName) throw badRequest(`data.${name}: csv data needs a file`);
      return { sql: String(loadCSV(view, fileName, { ...options, ...opt })), kind: 'csv' };
    case 'json':
      if (Array.isArray(data)) return { sql: String(loadObjects(view, data as Record<string, unknown>[], { ...options, ...opt })), kind: 'objects' };
      if (!fileName) throw badRequest(`data.${name}: json data needs a file or inline data`);
      return { sql: String(loadJSON(view, fileName, { ...options, ...opt })), kind: 'json' };
    case 'spatial':
      throw badRequest(`data.${name}: spatial data is not available in DuckView dashboards`);
    default:
      throw badRequest(`data.${name}: unknown data type "${type}"`);
  }
}

/** Rewrites every `from: <dataset>` reference to its view, collecting plain table references on the way. */
function rewriteFrom(node: unknown, map: Map<string, string>, tables: Set<string>): unknown {
  if (Array.isArray(node)) return node.map((n) => rewriteFrom(n, map, tables));
  if (!isObject(node)) return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    if (k === 'from' && typeof v === 'string') {
      if (map.has(v)) out[k] = map.get(v);
      else {
        if (!v.startsWith('$')) tables.add(v);
        out[k] = v;
      }
    } else out[k] = rewriteFrom(v, map, tables);
  }
  return out;
}

/**
 * The statements that stand a source up, exactly in the shapes the exec policy admits: a materialised dataset is
 * `CREATE TABLE IF NOT EXISTS "<memDb>"."src_<hash>" AS …` (idempotent across reloads — the hash covers the
 * definition) plus a main-schema view over it; otherwise one `CREATE OR REPLACE VIEW … AS <body>`.
 */
export function sourceStatements(src: PreparedSource): string[] {
  return src.materialize ? [`CREATE TABLE IF NOT EXISTS ${src.table} AS ${src.body}`, `CREATE OR REPLACE VIEW "${src.view}" AS SELECT * FROM ${src.table}`] : [`CREATE OR REPLACE VIEW "${src.view}" AS ${src.body}`];
}

/** Data definitions → source statements; `from:` rewritten. */
export function prepareSpec(spec: Spec, opts: PrepareOptions): PreparedSpec {
  const { data, ...rest } = spec;
  const sources: PreparedSource[] = [];
  const map = new Map<string, string>();
  if (data !== undefined) {
    if (!isObject(data)) throw badRequest('`data` must be a mapping of dataset name → definition');
    for (const [name, def] of Object.entries(data)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw badRequest(`data.${name}: dataset names must be plain identifiers`);
      // A salt (the caller's access-policy scope) keeps restricted callers' objects apart from everyone else's.
      const hash = `${fnv1a(`${name}\n${JSON.stringify(def)}`)}${opts.salt ?? ''}`;
      const view = `${opts.viewPrefix}${hash}`;
      const st = sourceStatement(name, def, view);
      if (!st) continue;
      const body = st.sql.slice(st.sql.indexOf(' AS ') + 4);
      sources.push({ name, view, kind: st.kind, body, materialize: st.materialize ?? opts.materialize, table: `"${opts.memDb}"."src_${hash}"` });
      map.set(name, view);
    }
  }
  const tables = new Set<string>();
  const prepared = rewriteFrom(rest, map, tables) as Spec;
  return { spec: prepared, statements: sources.flatMap(sourceStatements), sources, tables: [...tables] };
}

// ------------------------------------------------------------------------------------------------ structure

const COMPONENTS = ['plot', 'mark', 'legend', 'input', 'hconcat', 'vconcat', 'hspace', 'vspace'] as const;

class SpecErrors {
  errors: string[] = [];
  warnings: string[] = [];
  add(msg: string, at: string) {
    this.errors.push(at ? `${at}: ${msg}` : msg);
  }
  warn(msg: string, at: string) {
    this.warnings.push(at ? `${at}: ${msg}` : msg);
  }
}

const CHANNELS = new Set(['x', 'y', 'x1', 'x2', 'y1', 'y2', 'fill', 'stroke', 'r', 'z', 'text', 'href', 'title', 'fx', 'fy', 'opacity', 'fillOpacity', 'strokeOpacity', 'length', 'rotate', 'symbol']);

function checkMark(mark: Record<string, unknown>, at: string, errs: SpecErrors) {
  const { mark: name, data, ...options } = mark;
  if (typeof name !== 'string' || !MOSAIC_NAMES.marks.has(name as never)) errs.add(`unrecognized mark type "${String(name)}"`, at);
  if (data !== undefined && data !== null && !Array.isArray(data)) {
    if (!isObject(data)) errs.add('mark data must be {from: …} or an inline list of rows', at);
    else if (data.from === undefined) errs.add('mark data needs a `from` (dataset or table name)', at);
    else if (typeof data.from !== 'string') errs.add('`from` must be a dataset or table name', at);
  }
  for (const [key, value] of Object.entries(options)) {
    // A channel given as an object is an expression ({sql}) or a transform ({bin: col}, {count}); Mosaic passes
    // anything else through as a literal, which is almost always a typo — worth a warning, not an error.
    if (CHANNELS.has(key) && isObject(value) && !('sql' in value) && !('agg' in value)) {
      const keys = Object.keys(value);
      if (!keys.some((k) => MOSAIC_NAMES.transforms.has(k as never))) errs.warn(`${key}: {${keys.join(', ')}} is not a transform (bin, count, avg, sum, dateMonth, …) or {sql: …}; it will be passed through as a literal`, at);
    }
  }
}

function checkPlot(plot: Record<string, unknown>, at: string, errs: SpecErrors) {
  const { plot: entries, ...attrs } = plot;
  if (!Array.isArray(entries)) errs.add('`plot` must be a list of marks, interactors and legends', at);
  else
    entries.forEach((entry, i) => {
      const here = `${at}.plot[${i}]`;
      if (!isObject(entry)) return errs.add('plot entries must be objects', here);
      if (typeof entry.mark === 'string') checkMark(entry, here, errs);
      else if (typeof entry.legend === 'string') {
        if (!MOSAIC_NAMES.legends.has(`${entry.legend}Legend` as never)) errs.add(`unrecognized legend type "${entry.legend}"`, here);
      } else if (typeof entry.select === 'string') {
        if (!MOSAIC_NAMES.interactors.has(entry.select as never)) errs.add(`unrecognized interactor "${entry.select}"`, here);
      } else errs.add('invalid plot entry (needs mark, select or legend)', here);
    });
  for (const key of Object.keys(attrs)) if (!MOSAIC_NAMES.attributes.has(key as never)) errs.add(`unrecognized plot attribute "${key}"`, at);
}

function checkComponent(node: unknown, at: string, errs: SpecErrors) {
  if (!isObject(node)) return errs.add('a component must be an object', at);
  const keys = COMPONENTS.filter((k) => node[k] !== undefined && node[k] !== null);
  if (keys.length !== 1) return errs.add(`a component needs exactly one of ${COMPONENTS.join(', ')}${keys.length ? ` (found ${keys.join(', ')})` : ''}`, at);
  const kind = keys[0]!;
  switch (kind) {
    case 'plot':
      return checkPlot(node, at, errs);
    case 'mark':
      return checkMark(node, at, errs);
    case 'legend':
      if (!MOSAIC_NAMES.legends.has(`${String(node.legend)}Legend` as never)) errs.add(`unrecognized legend type "${String(node.legend)}"`, at);
      return;
    case 'input':
      if (!MOSAIC_NAMES.inputs.has(String(node.input) as never)) errs.add(`unrecognized input type "${String(node.input)}"`, at);
      return;
    case 'hconcat':
    case 'vconcat':
      if (!Array.isArray(node[kind])) return errs.add(`\`${kind}\` must be a list of components`, at);
      (node[kind] as unknown[]).forEach((child, i) => checkComponent(child, `${at}.${kind}[${i}]`, errs));
      return;
    case 'hspace':
    case 'vspace':
      if (typeof node[kind] !== 'number') errs.add(`\`${kind}\` must be a number of pixels`, at);
      return;
  }
}

/** Structural problems in a spec, in Mosaic's own terms (`errors` empty when the spec would parse), plus warnings. */
export function validateSpecStructure(spec: Spec): { errors: string[]; warnings: string[] } {
  const errs = new SpecErrors();
  const { meta, config, data, params, plotDefaults, ...root } = spec;
  if (meta !== undefined && !isObject(meta)) errs.add('`meta` must be an object', '');
  if (config !== undefined && !isObject(config)) errs.add('`config` must be an object', '');
  if (data !== undefined && !isObject(data)) errs.add('`data` must be a mapping of dataset name → definition', '');
  if (params !== undefined) {
    if (!isObject(params)) errs.add('`params` must be a mapping of name → param or selection', '');
    else
      for (const [name, def] of Object.entries(params)) {
        if (isObject(def) && def.select !== undefined && def.select !== 'value' && !MOSAIC_NAMES.selections.has(String(def.select) as never)) errs.add(`unrecognized param type "${String(def.select)}"`, `params.${name}`);
      }
  }
  if (plotDefaults !== undefined) {
    if (!isObject(plotDefaults)) errs.add('`plotDefaults` must be an object of plot attributes', '');
    else for (const key of Object.keys(plotDefaults)) if (!MOSAIC_NAMES.attributes.has(key as never)) errs.add(`unrecognized plot attribute "${key}"`, 'plotDefaults');
  }
  if (Object.keys(root).length === 0) errs.add('the spec has no content: add a plot, input, hconcat or vconcat', '');
  else checkComponent(root, 'spec', errs);
  return { errors: errs.errors, warnings: errs.warnings };
}

/** A short summary of a spec (plots, inputs, datasets) for tool results and lists. */
export function describeSpec(spec: Spec | null | undefined): { title: string | null; datasets: number; plots: number; inputs: number } {
  let plots = 0;
  let inputs = 0;
  const walk = (n: unknown) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!isObject(n)) return;
    if ('plot' in n || 'mark' in n) plots++;
    if ('input' in n) inputs++;
    for (const v of Object.values(n)) walk(v);
  };
  if (!spec) return { title: null, datasets: 0, plots: 0, inputs: 0 };
  const { data, meta, ...rest } = spec;
  walk(rest);
  return { title: isObject(meta) && typeof meta.title === 'string' ? meta.title : null, datasets: isObject(data) ? Object.keys(data).length : 0, plots, inputs };
}

/** Stable digest of a spec, for ETags and change detection. */
export const specDigest = (spec: Spec) => createHash('sha1').update(JSON.stringify(spec)).digest('hex').slice(0, 16);
