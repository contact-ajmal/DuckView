/**
 * The template marketplace: ready-made analytics — saved queries, dashboards, notebooks, metrics and data quality
 * checks — installed into a workspace in one step.
 *
 *  - Templates come built in (templates/builtin.ts) or are published by people from their own workspaces. A
 *    published template is private to its author until an administrator approves it for everyone (an
 *    administrator's own publish needs no review). Templates travel as JSON too (export / import).
 *  - A template names the tables it reads as {{table:<name>}}. Installing maps each to a table of the workspace
 *    (the same name by default), checks the columns it uses are there, or creates the template's sample data.
 *  - An install creates everything or nothing, and is recorded so its objects can be listed and removed later.
 *  - Publishing packages chosen objects, turning the tables they read (FROM / JOIN, the metrics' tables, the
 *    checks' relations) into placeholders, optionally with up to 500 sample rows of each.
 */
import YAML from 'yaml';
import { desc, eq, inArray, or, sql } from 'drizzle-orm';
import type { MetadataStore } from '../db/index.js';
import type { Template, TemplateBody, TemplateInstall, TemplateInstallObjects, TemplateStatus } from '../db/schema/sqlite.js';
import { newId } from '../security/crypto.js';
import type { Principal } from './principal.js';
import { isPlatformAdmin, requireAdmin, requireWrite } from './principal.js';
import type { AppContext } from '../context.js';
import { badRequest, forbidden, notFound } from './errors.js';
import { BUILTIN_TEMPLATES } from '../templates/builtin.js';
import { logger } from '../observability/logger.js';
import { analyzeSql } from '../engine/sql-guard.js';

export interface PublicTemplate {
  id: string;
  name: string;
  description: string | null;
  category: string;
  tags: string[];
  source: 'builtin' | 'organisation';
  status: TemplateStatus;
  author: string | null;
  author_id: string | null;
  installs: number;
  contents: { tables: string[]; queries: number; dashboards: number; notebooks: number; metrics: number; quality: number; sample_data: boolean };
  updated_at: string | null;
}

export interface TableCheck {
  name: string;
  target: string;
  exists: boolean;
  missing_columns: string[];
  has_sample: boolean;
}

export interface InstallInput {
  workspace_id: string;
  /** Template table → the workspace's table (schema.table allowed). */
  table_map?: Record<string, string>;
  /** Create the sample tables that are not there. */
  sample_data?: boolean;
}

export interface PublishInput {
  workspace_id: string;
  name: string;
  description?: string | null;
  category?: string | null;
  tags?: string[];
  query_ids?: string[];
  dashboard_ids?: string[];
  notebook_ids?: string[];
  quality_ids?: string[];
  semantic?: boolean;
  /** Rows of each table to ship as sample data (0 = none). */
  sample_rows?: number;
  /** org asks for everyone (an administrator's is published at once; others' wait for review). */
  visibility?: 'private' | 'org';
}

const PLACEHOLDER = /\{\{\s*table:([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_BODY = 2_000_000;

/** `schema.table` → a safely quoted identifier path. */
export function quoteRelation(target: string): string {
  const parts = target.split('.').map((x) => x.trim().replace(/^"(.*)"$/, '$1'));
  if (!parts.length || parts.length > 3 || parts.some((x) => !x || /["\0]/.test(x))) throw badRequest(`"${target}" is not a table name`);
  return parts.map((x) => (IDENT.test(x) ? x : `"${x}"`)).join('.');
}

/** Replaces {{table:x}} with the mapped relation. */
export function fillTables(text: string, map: Record<string, string>): string {
  return text.replace(PLACEHOLDER, (_m, name: string) => quoteRelation(map[name] ?? name));
}

/** Every template table the text uses. */
function usedTables(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER)].map((m) => m[1]!);
}

/** Checks a template body's shape (imports, publishes) and bounds its size. */
export function validateBody(body: unknown): TemplateBody {
  if (!body || typeof body !== 'object') throw badRequest('A template needs a body');
  const b = body as Partial<TemplateBody>;
  const arr = <T,>(x: T[] | undefined, what: string, max: number): T[] => {
    if (x === undefined) return [];
    if (!Array.isArray(x)) throw badRequest(`${what} must be a list`);
    if (x.length > max) throw badRequest(`At most ${max} ${what}`);
    return x;
  };
  const out: TemplateBody = {
    tables: arr(b.tables, 'tables', 50),
    queries: arr(b.queries, 'queries', 200),
    dashboards: arr(b.dashboards, 'dashboards', 50),
    notebooks: arr(b.notebooks, 'notebooks', 50),
    semantic: typeof b.semantic === 'string' && b.semantic.trim() ? b.semantic : null,
    quality: arr(b.quality, 'quality suites', 50),
  };
  for (const t of out.tables) if (!t || typeof t.name !== 'string' || !IDENT.test(t.name) || !Array.isArray(t.columns)) throw badRequest('Each table needs an identifier name and its columns');
  // Sample data runs at install time: one read-only SELECT, nothing else.
  for (const t of out.tables) {
    if (!t.sample_sql) continue;
    const an = analyzeSql(t.sample_sql);
    if (an.statements.length !== 1 || an.isMutating || an.overall !== 'read') throw badRequest(`The sample data of ${t.name} must be one SELECT`);
  }
  const keys = new Set<string>();
  for (const q of out.queries) {
    if (!q || typeof q.key !== 'string' || typeof q.name !== 'string' || typeof q.sql !== 'string') throw badRequest('Each query needs a key, a name and SQL');
    if (keys.has(q.key)) throw badRequest(`Query key ${q.key} is used twice`);
    keys.add(q.key);
  }
  for (const d of out.dashboards) {
    if (!d || typeof d.name !== 'string' || !Array.isArray(d.widgets)) throw badRequest('Each dashboard needs a name and widgets');
    for (const w of d.widgets) if (w.query && !keys.has(w.query)) throw badRequest(`Widget "${w.title}" uses query ${w.query}, which the template does not have`);
  }
  for (const n of out.notebooks) if (!n || typeof n.title !== 'string' || !Array.isArray(n.cells)) throw badRequest('Each notebook needs a title and cells');
  for (const q of out.quality) if (!q || typeof q.name !== 'string' || typeof q.relation !== 'string' || !Array.isArray(q.checks)) throw badRequest('Each quality suite needs a name, a relation and checks');
  // Every placeholder names a declared table.
  const declared = new Set(out.tables.map((t) => t.name));
  const texts = [...out.queries.map((q) => q.sql), ...out.dashboards.flatMap((d) => d.widgets.map((w) => w.sql ?? '')), ...out.notebooks.flatMap((n) => n.cells.map((c) => c.source)), out.semantic ?? '', ...out.quality.map((q) => q.relation), ...out.tables.map((t) => t.sample_sql ?? '')];
  const unknown = [...new Set(texts.flatMap(usedTables))].filter((t) => !declared.has(t));
  if (unknown.length) throw badRequest(`The template uses tables it does not declare: ${unknown.join(', ')}`);
  if (JSON.stringify(out).length > MAX_BODY) throw badRequest('The template is too large (limit 2 MB)');
  return out;
}

/** A value as a DuckDB literal of `type`. */
function literal(v: unknown, type: string): string {
  if (v === null || v === undefined) return `NULL::${type}`;
  if (typeof v === 'number' || typeof v === 'bigint') return Number.isFinite(Number(v)) ? `CAST(${String(v)} AS ${type})` : `NULL::${type}`;
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  const text = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return `CAST('${text.replace(/'/g, "''")}' AS ${type})`;
}

export class TemplateService {
  private ctx!: AppContext;

  constructor(private readonly store: MetadataStore) {}
  bind(ctx: AppContext) {
    this.ctx = ctx;
  }
  private get db() {
    return this.store.db;
  }
  private get s() {
    return this.store.schema;
  }

  private contents(body: TemplateBody): PublicTemplate['contents'] {
    let metrics = 0;
    try {
      metrics = body.semantic ? ((YAML.parse(body.semantic.replace(PLACEHOLDER, '$1')) as { metrics?: unknown[] })?.metrics?.length ?? 0) : 0;
    } catch {
      metrics = 0;
    }
    return { tables: body.tables.map((t) => t.name), queries: body.queries.length, dashboards: body.dashboards.length, notebooks: body.notebooks.length, metrics, quality: body.quality.length, sample_data: body.tables.length > 0 && body.tables.every((t) => !!t.sample_sql) };
  }

  private async toPublic(rows: Template[]): Promise<PublicTemplate[]> {
    const authors = rows.length ? await this.db.select({ id: this.s.users.id, email: this.s.users.email, name: this.s.users.display_name }).from(this.s.users).where(inArray(this.s.users.id, [...new Set(rows.map((r) => r.author_id))])) : [];
    const who = new Map(authors.map((a) => [a.id, a.name || a.email]));
    return rows.map((r) => ({ id: r.id, name: r.name, description: r.description, category: r.category, tags: r.tags, source: 'organisation', status: r.status, author: who.get(r.author_id) ?? null, author_id: r.author_id, installs: r.installs, contents: this.contents(r.body), updated_at: r.updated_at.toISOString() }));
  }

  /** The templates `p` can see: built-in, published, their own, and (administrators) those waiting for review. */
  async list(p: Principal, opts: { q?: string; category?: string } = {}): Promise<PublicTemplate[]> {
    const t = this.s.templates;
    const rows = await this.db.select().from(t).where(isPlatformAdmin(p) ? or(eq(t.status, 'published'), eq(t.status, 'pending'), eq(t.author_id, p.userId)) : or(eq(t.status, 'published'), eq(t.author_id, p.userId))).orderBy(desc(t.installs), desc(t.updated_at));
    const counts = await this.builtinCounts();
    const builtin: PublicTemplate[] = BUILTIN_TEMPLATES.map((b) => ({ id: b.id, name: b.name, description: b.description, category: b.category, tags: b.tags, source: 'builtin', status: 'published', author: 'DuckView', author_id: null, installs: counts.get(b.id) ?? 0, contents: this.contents(b.body), updated_at: null }));
    let all = [...builtin, ...(await this.toPublic(rows))];
    if (opts.category) all = all.filter((x) => x.category.toLowerCase() === opts.category!.toLowerCase());
    if (opts.q?.trim()) {
      const words = opts.q.toLowerCase().split(/\s+/).filter(Boolean);
      all = all.filter((x) => words.every((w) => `${x.name} ${x.description ?? ''} ${x.category} ${x.tags.join(' ')}`.toLowerCase().includes(w)));
    }
    return all;
  }

  private async builtinCounts(): Promise<Map<string, number>> {
    const ti = this.s.templateInstalls;
    const rows = await this.db.select({ id: ti.template_id, n: sql<number>`count(*)` }).from(ti).where(inArray(ti.template_id, BUILTIN_TEMPLATES.map((b) => b.id))).groupBy(ti.template_id);
    return new Map(rows.map((r) => [r.id, Number(r.n)]));
  }

  /** A template with its body, if `p` may see it. */
  async get(p: Principal, id: string): Promise<PublicTemplate & { body: TemplateBody }> {
    const b = BUILTIN_TEMPLATES.find((x) => x.id === id);
    if (b) return { ...(await this.list(p)).find((x) => x.id === id)!, body: b.body };
    const row = (await this.db.select().from(this.s.templates).where(eq(this.s.templates.id, id)).limit(1))[0];
    if (!row || (row.status !== 'published' && row.author_id !== p.userId && !(isPlatformAdmin(p) && row.status === 'pending'))) throw notFound('Template');
    return { ...(await this.toPublic([row]))[0]!, body: row.body };
  }

  // ------------------------------------------------------------------------------------------ install

  /** How the template's tables map onto the workspace: which exist, which columns are missing. */
  async check(p: Principal, id: string, workspaceId: string, tableMap: Record<string, string> = {}): Promise<TableCheck[]> {
    const t = await this.get(p, id);
    const { engine } = await this.ctx.workspaces.engine(p, workspaceId);
    const catalog = await engine.catalog();
    return t.body.tables.map((tbl) => {
      const target = (tableMap[tbl.name] || tbl.name).trim();
      const parts = target.split('.').map((x) => x.replace(/^"(.*)"$/, '$1').toLowerCase());
      const name = parts.at(-1)!;
      const schema = parts.length > 1 ? parts.at(-2) : null;
      const found = catalog.find((o) => o.name.toLowerCase() === name && (schema ? o.schema.toLowerCase() === schema : true));
      const have = new Set((found?.columns ?? []).map((c) => c.name.toLowerCase()));
      return { name: tbl.name, target, exists: !!found, missing_columns: found ? tbl.columns.map((c) => c.name).filter((c) => !have.has(c.toLowerCase())) : tbl.columns.map((c) => c.name), has_sample: !!tbl.sample_sql };
    });
  }

  async install(p: Principal, id: string, input: InstallInput): Promise<{ install: TemplateInstall; created: TemplateInstallObjects }> {
    requireWrite(p);
    const c = this.ctx;
    await c.workspaces.get(p, input.workspace_id, 'EDITOR');
    const t = await this.get(p, id);
    const map: Record<string, string> = {};
    for (const tbl of t.body.tables) map[tbl.name] = quoteRelation((input.table_map?.[tbl.name] || tbl.name).trim());
    const ws = input.workspace_id;
    const created: TemplateInstallObjects = { queries: [], dashboards: [], notebooks: [], quality: [], tables: [], semantic: false };
    let semanticBefore: string | null = null;
    try {
      // Tables: sample data for the missing ones, then everything must be there.
      let checks = await this.check(p, id, ws, map);
      for (const ch of checks.filter((x) => !x.exists)) {
        const tbl = t.body.tables.find((x) => x.name === ch.name)!;
        if (!input.sample_data || !tbl.sample_sql) continue;
        await c.queries.run(p, ws, `CREATE TABLE ${map[tbl.name]} AS ${fillTables(tbl.sample_sql, map)}`, { cache: false });
        created.tables.push(map[tbl.name]!);
      }
      if (created.tables.length) checks = await this.check(p, id, ws, map);
      const problems = checks.filter((x) => !x.exists || x.missing_columns.length).map((x) => (x.exists ? `${x.target} has no column ${x.missing_columns.join(', ')}` : `there is no table ${x.target}${x.has_sample ? ' (install with sample data, or map it to one of yours)' : ''}`));
      if (problems.length) throw badRequest(`The template cannot be installed: ${problems.join('; ')}`);

      const keyToId = new Map<string, string>();
      for (const q of t.body.queries) {
        const row = await c.savedQueries.create(p, ws, { name: q.name, folder: q.folder ?? t.name, description: q.description ?? null, sql_text: fillTables(q.sql, map), tags: ['template'] });
        keyToId.set(q.key, row.id);
        created.queries.push(row.id);
      }
      for (const d of t.body.dashboards) {
        const dash = await c.dashboards.create(p, ws, { name: d.name, description: d.description ?? null, kind: 'grid' });
        created.dashboards.push(dash.id);
        // Lay widgets out left to right, 12 columns wide.
        const layout: { i: string; x: number; y: number; w: number; h: number }[] = [];
        let x = 0;
        let y = 0;
        let rowH = 0;
        for (const w of d.widgets) {
          const { widget } = await c.dashboards.addWidget(p, dash.id, { title: w.title, widget_type: w.widget_type, saved_query_id: w.query ? keyToId.get(w.query) ?? null : null, custom_sql: w.sql ? fillTables(w.sql, map) : null, chart_config: w.chart_config ?? {} });
          const width = Math.min(Math.max(w.w ?? 6, 1), 12);
          const height = Math.min(Math.max(w.h ?? 4, 1), 20);
          if (x + width > 12) {
            x = 0;
            y += rowH;
            rowH = 0;
          }
          layout.push({ i: widget.id, x, y, w: width, h: height });
          x += width;
          rowH = Math.max(rowH, height);
        }
        if (layout.length) await c.dashboards.update(p, dash.id, { layout });
      }
      for (const n of t.body.notebooks) {
        const nb = await c.notebooks.create(p, ws, { title: n.title, cells: n.cells.map((cell) => ({ type: cell.type, name: cell.name ?? null, source: fillTables(cell.source, map), ...(cell.input ? { input: cell.input } : {}) })) });
        created.notebooks.push(nb.id);
      }
      if (t.body.semantic) {
        semanticBefore = (await c.semantic.get(p, ws)).yaml ?? '';
        await c.semantic.save(p, ws, this.mergeSemantic(semanticBefore, fillTables(t.body.semantic, map)));
        created.semantic = true;
      }
      for (const q of t.body.quality) {
        const suite = await c.quality.create(p, ws, { name: q.name, relation: fillTables(q.relation, map), checks: q.checks });
        created.quality.push(suite.id);
      }
    } catch (err) {
      await this.undo(p, ws, created, { dropTables: true, semantic: semanticBefore }).catch((e) => logger().warn({ template: id, err: (e as Error).message }, 'Could not undo a failed template install'));
      throw err;
    }
    const install: TemplateInstall = { id: newId(), template_id: t.id, template_name: t.name, workspace_id: ws, user_id: p.userId, table_map: map, objects: created, created_at: new Date() };
    await this.db.insert(this.s.templateInstalls).values(install);
    if (t.source === 'organisation') await this.db.update(this.s.templates).set({ installs: sql`${this.s.templates.installs} + 1` }).where(eq(this.s.templates.id, t.id));
    c.audit.log({ userId: p.userId, actorType: p.actorType, action: 'template.install', resource: `workspace:${ws}`, queryText: `${t.name}: ${created.queries.length} queries, ${created.dashboards.length} dashboards, ${created.notebooks.length} notebooks, ${created.quality.length} quality suites${created.semantic ? ', metrics' : ''}${created.tables.length ? `, sample tables ${created.tables.join(', ')}` : ''}`, ip: p.ip });
    return { install, created };
  }

  /** Adds the template's semantic models and metrics to the workspace's, keeping the workspace's where names clash. */
  mergeSemantic(current: string, incoming: string): string {
    if (!current.trim()) return incoming;
    const cur = (YAML.parse(current) ?? {}) as { semantic_models?: { name: string }[]; metrics?: { name: string }[] };
    const add = (YAML.parse(incoming) ?? {}) as typeof cur;
    const names = (xs?: { name: string }[]) => new Set((xs ?? []).map((x) => x.name));
    const models = names(cur.semantic_models);
    const metrics = names(cur.metrics);
    return YAML.stringify({ ...cur, semantic_models: [...(cur.semantic_models ?? []), ...(add.semantic_models ?? []).filter((m) => !models.has(m.name))], metrics: [...(cur.metrics ?? []), ...(add.metrics ?? []).filter((m) => !metrics.has(m.name))] });
  }

  private async undo(p: Principal, ws: string, o: TemplateInstallObjects, opts: { dropTables: boolean; semantic?: string | null }) {
    const c = this.ctx;
    const quiet = (x: Promise<unknown>) => x.catch(() => undefined);
    for (const id of o.quality) await quiet(c.quality.remove(p, id));
    for (const id of o.notebooks) await quiet(c.notebooks.remove(p, id));
    for (const id of o.dashboards) await quiet(c.dashboards.remove(p, id));
    for (const id of o.queries) await quiet(c.savedQueries.remove(p, ws, id));
    if (opts.semantic !== undefined && opts.semantic !== null && o.semantic) await quiet(c.semantic.save(p, ws, opts.semantic, { force: true }));
    if (opts.dropTables) for (const t of o.tables) await quiet(c.queries.run(p, ws, `DROP TABLE IF EXISTS ${t}`, { cache: false }));
  }

  async installs(p: Principal, workspaceId: string): Promise<TemplateInstall[]> {
    await this.ctx.workspaces.get(p, workspaceId);
    return this.db.select().from(this.s.templateInstalls).where(eq(this.s.templateInstalls.workspace_id, workspaceId)).orderBy(desc(this.s.templateInstalls.created_at));
  }

  /** Removes what an install created (its metrics stay: they may be in use); sample tables only with drop_tables. */
  async uninstall(p: Principal, installId: string, opts: { drop_tables?: boolean } = {}): Promise<void> {
    requireWrite(p);
    const row = (await this.db.select().from(this.s.templateInstalls).where(eq(this.s.templateInstalls.id, installId)).limit(1))[0];
    if (!row) throw notFound('Install');
    await this.ctx.workspaces.get(p, row.workspace_id, 'EDITOR');
    await this.undo(p, row.workspace_id, row.objects, { dropTables: !!opts.drop_tables });
    await this.db.delete(this.s.templateInstalls).where(eq(this.s.templateInstalls.id, installId));
    this.ctx.audit.log({ userId: p.userId, actorType: p.actorType, action: 'template.uninstall', resource: `workspace:${row.workspace_id}`, queryText: row.template_name, ip: p.ip });
  }

  // ------------------------------------------------------------------------------------------ publish

  /** Packages objects of a workspace as a template. */
  async publish(p: Principal, input: PublishInput): Promise<PublicTemplate> {
    requireWrite(p);
    const c = this.ctx;
    const ws = input.workspace_id;
    await c.workspaces.get(p, ws, 'EDITOR');
    const name = (input.name ?? '').trim().slice(0, 120);
    if (!name) throw badRequest('A template needs a name');

    const queries = await Promise.all((input.query_ids ?? []).map((id) => c.savedQueries.get(p, ws, id)));
    const dashboards = await Promise.all((input.dashboard_ids ?? []).map((id) => c.dashboards.get(p, id)));
    const notebooks = await Promise.all((input.notebook_ids ?? []).map((id) => c.notebooks.get(p, id)));
    const suites = await Promise.all((input.quality_ids ?? []).map((id) => c.quality.get(p, id)));
    for (const x of [...dashboards, ...notebooks, ...suites]) if (x.workspace_id !== ws) throw badRequest('Everything in a template comes from one workspace');
    const mosaic = dashboards.find((d) => d.kind !== 'grid');
    if (mosaic) throw badRequest(`"${mosaic.name}" is a Mosaic dashboard; templates carry grid dashboards`);
    const semantic = input.semantic ? (await c.semantic.get(p, ws)).yaml || null : null;
    if (!queries.length && !dashboards.length && !notebooks.length && !suites.length && !semantic) throw badRequest('Choose at least one query, dashboard, notebook, quality suite or the metrics');

    // Saved queries the dashboards use come along.
    const keyOf = new Map<string, string>();
    const usedKeys = new Set<string>();
    const qs: TemplateBody['queries'] = [];
    const addQuery = (q: { id: string; name: string; folder?: string | null; description?: string | null; sql_text: string }) => {
      if (keyOf.has(q.id)) return keyOf.get(q.id)!;
      let key = q.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'query';
      for (let i = 2; usedKeys.has(key); i++) key = `${key.replace(/_\d+$/, '')}_${i}`;
      usedKeys.add(key);
      keyOf.set(q.id, key);
      qs.push({ key, name: q.name, folder: q.folder || null, description: q.description ?? null, sql: q.sql_text });
      return key;
    };
    for (const q of queries) addQuery(q);
    const dash: TemplateBody['dashboards'] = [];
    for (const d of dashboards) {
      const widgets: TemplateBody['dashboards'][number]['widgets'] = [];
      const sorted = [...d.widgets].sort((a, b) => {
        const la = d.layout.find((l) => l.i === a.id);
        const lb = d.layout.find((l) => l.i === b.id);
        return (la?.y ?? 0) - (lb?.y ?? 0) || (la?.x ?? 0) - (lb?.x ?? 0);
      });
      for (const w of sorted) {
        const l = d.layout.find((x) => x.i === w.id);
        let query: string | null = null;
        if (w.saved_query_id) query = addQuery(await c.savedQueries.get(p, ws, w.saved_query_id));
        widgets.push({ title: w.title, widget_type: w.widget_type, query, sql: w.custom_sql, chart_config: w.chart_config, w: l?.w, h: l?.h });
      }
      dash.push({ name: d.name, description: d.description, widgets });
    }
    const body: TemplateBody = {
      tables: [],
      queries: qs,
      dashboards: dash,
      notebooks: notebooks.map((n) => ({ title: n.title, cells: n.cells.map((cell) => ({ type: cell.type, name: cell.name ?? null, source: cell.source, ...(cell.input ? { input: cell.input } : {}) })) })),
      semantic,
      quality: suites.map((q) => ({ name: q.name, relation: q.relation, checks: q.checks })),
    };

    // Tables: those of the workspace the objects read become placeholders.
    const { engine } = await c.workspaces.engine(p, ws);
    const catalog = (await engine.catalog()).filter((o) => o.schema !== 'information_schema' && o.schema !== 'pg_catalog');
    const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const found = new Map<string, (typeof catalog)[number]>();
    const templatize = (text: string): string => {
      let out = text;
      for (const o of catalog) {
        const n = esc(o.name);
        const ref = new RegExp(`(\\b(?:FROM|JOIN)\\s+)(?:"?${esc(o.schema)}"?\\.)?("?)${n}\\2(?![\\w"])`, 'gi');
        const next = out.replace(ref, (_m, kw: string) => `${kw}{{table:${o.name}}}`);
        if (next !== out) found.set(o.name, o);
        out = next;
      }
      return out;
    };
    for (const q of body.queries) q.sql = templatize(q.sql);
    for (const d of body.dashboards) for (const w of d.widgets) if (w.sql) w.sql = templatize(w.sql);
    for (const n of body.notebooks) for (const cell of n.cells) if (cell.type === 'sql') cell.source = templatize(cell.source);
    for (const q of body.quality) {
      const o = catalog.find((x) => x.name.toLowerCase() === q.relation.replace(/^.*\./, '').replace(/"/g, '').toLowerCase());
      if (o) {
        q.relation = `{{table:${o.name}}}`;
        found.set(o.name, o);
      }
    }
    if (body.semantic) {
      body.semantic = body.semantic.replace(/(\btable:\s*)(["']?)([A-Za-z_][\w.]*)\2/g, (m, pre: string, _q: string, t: string) => {
        const o = catalog.find((x) => x.name.toLowerCase() === t.replace(/^.*\./, '').toLowerCase());
        if (!o) return m;
        found.set(o.name, o);
        return `${pre}{{table:${o.name}}}`;
      });
    }
    const sampleRows = Math.min(Math.max(Math.round(input.sample_rows ?? 0), 0), 500);
    for (const o of found.values()) {
      if (!IDENT.test(o.name)) throw badRequest(`Table "${o.name}" needs a plain name (letters, digits, _) to go in a template`);
      let sample: string | null = null;
      if (sampleRows > 0 && o.columns.every((col) => !/STRUCT|MAP|UNION|\[\]|LIST/i.test(col.type))) {
        const cols = o.columns.map((col) => `"${col.name.replace(/"/g, '""')}"`).join(', ');
        const r = await c.queries.run(p, ws, `SELECT ${cols} FROM ${quoteRelation(`${o.schema}.${o.name}`)} LIMIT ${sampleRows}`, { cache: false, maxRows: sampleRows });
        if (r.rows.length) sample = `SELECT * FROM (VALUES\n${r.rows.map((row) => `  (${row.map((v, i) => literal(v, o.columns[i]!.type)).join(', ')})`).join(',\n')}\n) t(${cols})`;
      }
      body.tables.push({ name: o.name, columns: o.columns.map((col) => ({ name: col.name, type: col.type })), sample_sql: sample });
    }
    const valid = validateBody(body);
    const status: TemplateStatus = input.visibility === 'org' ? (isPlatformAdmin(p) ? 'published' : 'pending') : 'private';
    const now = new Date();
    const row: Template = { id: newId(), name, description: input.description?.trim().slice(0, 2000) || null, category: (input.category ?? '').trim().slice(0, 40) || 'Other', tags: [...new Set((input.tags ?? []).map((x) => String(x).trim().toLowerCase()).filter(Boolean))].slice(0, 12), author_id: p.userId, status, body: valid, installs: 0, reviewed_by: status === 'published' ? p.userId : null, created_at: now, updated_at: now };
    await this.db.insert(this.s.templates).values(row);
    c.audit.log({ userId: p.userId, actorType: p.actorType, action: 'template.publish', resource: `template:${row.id}`, queryText: `${name} (${status})`, ip: p.ip });
    return (await this.toPublic([row]))[0]!;
  }

  private async own(p: Principal, id: string): Promise<Template> {
    const row = (await this.db.select().from(this.s.templates).where(eq(this.s.templates.id, id)).limit(1))[0];
    if (!row || (row.author_id !== p.userId && !isPlatformAdmin(p))) throw notFound('Template');
    return row;
  }

  async update(p: Principal, id: string, patch: { name?: string; description?: string | null; category?: string; tags?: string[]; visibility?: 'private' | 'org' }): Promise<PublicTemplate> {
    requireWrite(p);
    const row = await this.own(p, id);
    const set: Partial<Template> = { updated_at: new Date() };
    if (patch.name !== undefined) set.name = patch.name.trim().slice(0, 120) || row.name;
    if (patch.description !== undefined) set.description = patch.description?.trim().slice(0, 2000) || null;
    if (patch.category !== undefined) set.category = patch.category.trim().slice(0, 40) || 'Other';
    if (patch.tags !== undefined) set.tags = [...new Set(patch.tags.map((x) => String(x).trim().toLowerCase()).filter(Boolean))].slice(0, 12);
    if (patch.visibility === 'private') set.status = 'private';
    if (patch.visibility === 'org' && row.status !== 'published') set.status = isPlatformAdmin(p) ? 'published' : 'pending';
    await this.db.update(this.s.templates).set(set).where(eq(this.s.templates.id, id));
    return (await this.toPublic([{ ...row, ...set }]))[0]!;
  }

  /** An administrator approves a template for everyone, or sends it back to its author. */
  async review(p: Principal, id: string, approve: boolean): Promise<PublicTemplate> {
    requireAdmin(p);
    const row = (await this.db.select().from(this.s.templates).where(eq(this.s.templates.id, id)).limit(1))[0];
    if (!row) throw notFound('Template');
    if (row.status !== 'pending') throw badRequest('This template is not waiting for review');
    const set = { status: (approve ? 'published' : 'private') as TemplateStatus, reviewed_by: p.userId, updated_at: new Date() };
    await this.db.update(this.s.templates).set(set).where(eq(this.s.templates.id, id));
    this.ctx.audit.log({ userId: p.userId, actorType: p.actorType, action: approve ? 'template.approve' : 'template.reject', resource: `template:${id}`, ip: p.ip });
    return (await this.toPublic([{ ...row, ...set }]))[0]!;
  }

  async remove(p: Principal, id: string): Promise<void> {
    requireWrite(p);
    if (id.startsWith('builtin:')) throw forbidden('Built-in templates cannot be removed');
    await this.own(p, id);
    await this.db.delete(this.s.templates).where(eq(this.s.templates.id, id));
    this.ctx.audit.log({ userId: p.userId, actorType: p.actorType, action: 'template.delete', resource: `template:${id}`, ip: p.ip });
  }

  /** The template as a file others can import. */
  async exportJson(p: Principal, id: string): Promise<Record<string, unknown>> {
    const t = await this.get(p, id);
    return { duckview_template: 1, name: t.name, description: t.description, category: t.category, tags: t.tags, body: t.body };
  }

  /** A template file becomes one of `p`'s private templates. */
  async importJson(p: Principal, file: unknown): Promise<PublicTemplate> {
    requireWrite(p);
    const f = (file ?? {}) as { duckview_template?: number; name?: string; description?: string; category?: string; tags?: string[]; body?: unknown };
    if (f.duckview_template !== 1) throw badRequest('Not a DuckView template file (duckview_template: 1)');
    const name = String(f.name ?? '').trim().slice(0, 120);
    if (!name) throw badRequest('The template has no name');
    const now = new Date();
    const row: Template = { id: newId(), name, description: typeof f.description === 'string' ? f.description.slice(0, 2000) : null, category: String(f.category ?? 'Other').slice(0, 40), tags: Array.isArray(f.tags) ? f.tags.map(String).slice(0, 12) : [], author_id: p.userId, status: 'private', body: validateBody(f.body), installs: 0, reviewed_by: null, created_at: now, updated_at: now };
    await this.db.insert(this.s.templates).values(row);
    this.ctx.audit.log({ userId: p.userId, actorType: p.actorType, action: 'template.import', resource: `template:${row.id}`, queryText: name, ip: p.ip });
    return (await this.toPublic([row]))[0]!;
  }
}
