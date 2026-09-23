/**
 * Build plans: what DuckView AI (or an agent) proposes when asked to build a dashboard or a data app.
 *
 *   build: dashboard | app
 *   name: Sales overview
 *   description: …
 *   items:
 *     - { title: Revenue, kind: kpi, sql: "SELECT sum(amount) AS revenue FROM orders", format: currency }
 *     - { title: Revenue by month, kind: chart, chart: line, sql: "…", x: month, y: [revenue] }
 *     - { title: Top customers, kind: table, sql: "…" }
 *     - { title: Notes, kind: text, text: "Numbers are in EUR." }
 *
 * check() runs every item's SQL as the person asking (read-only, a few rows, their access policies) and verifies
 * the columns a chart or KPI names; create() builds what passed — a grid dashboard laid out by kind (KPIs in a row,
 * charts two by two, tables full width) or a Streamlit app with one section per item — and says what it skipped.
 */
import YAML from 'yaml';
import type { WidgetChartConfig, WidgetType, LayoutItem } from '../db/schema/sqlite.js';
import { analyzeSql } from '../engine/sql-guard.js';
import type { Principal } from './principal.js';
import type { QueryService } from './query.js';
import type { DashboardService } from './bi.js';
import type { DataAppService } from './apps.js';
import { appFromQueries } from './app-generator.js';
import { badRequest } from './errors.js';

export const BUILD_KINDS = ['kpi', 'chart', 'table', 'text'] as const;
export interface BuildItem {
  title: string;
  kind: (typeof BUILD_KINDS)[number];
  sql?: string;
  chart?: 'bar' | 'line' | 'area' | 'scatter' | 'pie';
  x?: string;
  y?: string[];
  format?: 'number' | 'currency' | 'percent' | 'compact';
  text?: string;
}
export interface BuildPlan { build: 'dashboard' | 'app'; name: string; description: string | null; items: BuildItem[] }
export interface ItemCheck { title: string; kind: BuildItem['kind']; ok: boolean; error: string | null; columns: string[]; row_count: number | null }
export interface BuildCheck { build: 'dashboard' | 'app'; name: string; ok: boolean; items: ItemCheck[] }

const NUMERIC = /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|FLOAT|REAL|DOUBLE|DECIMAL.*)$/i;

/** Parses and normalises a plan (YAML or JSON text, or an object). Throws a readable error. */
export function parseBuildPlan(input: string | Record<string, unknown>): BuildPlan {
  const raw = (typeof input === 'string' ? YAML.parse(input) : input) as Record<string, unknown> | null;
  if (!raw || typeof raw !== 'object') throw badRequest('A build plan is a YAML object with build, name and items');
  const build = raw.build === 'app' ? 'app' : raw.build === 'dashboard' ? 'dashboard' : null;
  if (!build) throw badRequest('build must be dashboard or app');
  const name = String(raw.name ?? '').trim().slice(0, 120);
  if (!name) throw badRequest('The plan needs a name');
  const items = Array.isArray(raw.items) ? raw.items : [];
  if (!items.length) throw badRequest('The plan has no items');
  if (items.length > 40) throw badRequest('A plan has at most 40 items');
  return {
    build,
    name,
    description: raw.description ? String(raw.description).slice(0, 2000) : null,
    items: items.map((it, i) => {
      const o = (it ?? {}) as Record<string, unknown>;
      const kind = String(o.kind ?? o.type ?? '').toLowerCase() as BuildItem['kind'];
      if (!BUILD_KINDS.includes(kind)) throw badRequest(`Item ${i + 1}: kind must be ${BUILD_KINDS.join(', ')}`);
      const title = String(o.title ?? `Item ${i + 1}`).slice(0, 120);
      if (kind === 'text') return { title, kind, text: String(o.text ?? o.markdown ?? '') };
      const sql = String(o.sql ?? '').trim().replace(/;\s*$/, '');
      if (!sql) throw badRequest(`Item ${i + 1} (${title}): sql is required`);
      const y = Array.isArray(o.y) ? o.y.map(String) : o.y ? [String(o.y)] : undefined;
      const chart = ['bar', 'line', 'area', 'scatter', 'pie'].includes(String(o.chart)) ? (o.chart as BuildItem['chart']) : kind === 'chart' ? 'bar' : undefined;
      const format = ['number', 'currency', 'percent', 'compact'].includes(String(o.format)) ? (o.format as BuildItem['format']) : undefined;
      return { title, kind, sql, ...(chart ? { chart } : {}), ...(o.x ? { x: String(o.x) } : {}), ...(y ? { y } : {}), ...(format ? { format } : {}) };
    }),
  };
}

export class BuilderService {
  constructor(private readonly queries: QueryService, private readonly dashboards: DashboardService, private readonly apps: DataAppService) {}

  /** Runs each item's SQL (read-only, a few rows) and checks the columns it names. */
  async check(p: Principal, workspaceId: string, plan: BuildPlan): Promise<BuildCheck> {
    const items: ItemCheck[] = [];
    const readOnly: Principal = { ...p, scopes: p.scopes.filter((s) => s === 'read' || s === 'admin') };
    for (const it of plan.items) {
      if (it.kind === 'text') {
        items.push({ title: it.title, kind: it.kind, ok: true, error: null, columns: [], row_count: null });
        continue;
      }
      try {
        const a = analyzeSql(it.sql!);
        if (a.isMutating || a.statements.length !== 1) throw new Error('must be one read-only query');
        const r = await this.queries.run(readOnly, workspaceId, it.sql!, { maxRows: 50, countTotal: false, cache: true });
        const cols = r.columns.map((c) => c.name);
        const has = (c: string) => cols.some((x) => x.toLowerCase() === c.toLowerCase());
        const missing = [it.x, ...(it.y ?? [])].filter((c): c is string => !!c && !has(c));
        if (missing.length) throw new Error(`the query has no column ${missing.join(', ')} (it returns ${cols.join(', ')})`);
        if (it.kind === 'chart' && !it.x && cols.length < 2) throw new Error('a chart needs an x column and a value column');
        if (it.kind === 'kpi' && !r.columns.some((c) => NUMERIC.test(c.type))) throw new Error('a KPI needs a numeric column');
        items.push({ title: it.title, kind: it.kind, ok: true, error: null, columns: cols, row_count: r.rowCount });
      } catch (err) {
        items.push({ title: it.title, kind: it.kind, ok: false, error: ((err as Error).message ?? String(err)).split('\n')[0]!.slice(0, 300), columns: [], row_count: null });
      }
    }
    return { build: plan.build, name: plan.name, ok: items.every((i) => i.ok), items };
  }

  /** Builds what passes the checks; the rest is reported, not created. */
  async create(p: Principal, workspaceId: string, plan: BuildPlan): Promise<{ build: 'dashboard' | 'app'; id: string; name: string; url: string; created: string[]; skipped: { title: string; error: string }[] }> {
    const check = await this.check(p, workspaceId, plan);
    const good = plan.items.filter((_, i) => check.items[i]!.ok);
    const skipped = check.items.filter((i) => !i.ok).map((i) => ({ title: i.title, error: i.error ?? 'failed' }));
    if (!good.some((i) => i.kind !== 'text')) throw badRequest(`Nothing to build: ${skipped.map((s) => `${s.title} — ${s.error}`).join('; ') || 'no items with data'}`);
    if (plan.build === 'app') {
      const g = appFromQueries(good.filter((i) => i.kind !== 'text').map((i) => ({ name: i.title, sql: i.sql! })), { name: plan.name, description: plan.description });
      const app = await this.apps.create(p, workspaceId, { name: plan.name, description: plan.description, files: g.files, kind: 'streamlit' });
      return { build: 'app', id: app.id, name: app.name, url: `#/apps?app=${app.id}`, created: good.map((i) => i.title), skipped };
    }
    const d = await this.dashboards.create(p, workspaceId, { name: plan.name, description: plan.description, kind: 'grid' });
    const layout: LayoutItem[] = [];
    let y = 0;
    let rowX = 0;
    let rowH = 0;
    const place = (id: string, w: number, h: number) => {
      if (rowX + w > 12) {
        y += rowH;
        rowX = 0;
        rowH = 0;
      }
      layout.push({ i: id, x: rowX, y, w, h });
      rowX += w;
      rowH = Math.max(rowH, h);
    };
    // KPIs first, then charts, then tables and text, in the plan's order within each.
    const order = [...good.filter((i) => i.kind === 'kpi'), ...good.filter((i) => i.kind === 'chart'), ...good.filter((i) => i.kind === 'table' || i.kind === 'text')];
    const kpis = order.filter((i) => i.kind === 'kpi').length;
    for (const it of order) {
      const idx = plan.items.indexOf(it);
      const cols = check.items[idx]!.columns;
      const type: WidgetType = it.kind === 'kpi' ? 'KPI' : it.kind === 'chart' ? 'CHART' : it.kind === 'table' ? 'TABLE' : 'MARKDOWN';
      const chart_config: WidgetChartConfig = it.kind === 'kpi' ? { value: it.y?.[0] ?? cols.find((c) => c !== it.x) ?? cols[0], ...(it.format ? { format: it.format } : {}) } : it.kind === 'chart' ? { chart: it.chart ?? 'bar', x: it.x ?? cols[0], y: it.y?.length ? it.y : cols.filter((c) => c !== (it.x ?? cols[0])).slice(0, 3) } : it.kind === 'table' ? { page_size: 20 } : { markdown: it.text ?? '' };
      const { widget } = await this.dashboards.addWidget(p, d.id, { title: it.title, widget_type: type, custom_sql: it.kind === 'text' ? null : it.sql!, chart_config });
      if (it.kind === 'kpi') place(widget.id, Math.max(3, Math.floor(12 / Math.min(4, kpis))), 2);
      else if (it.kind === 'chart') place(widget.id, 6, 4);
      else if (it.kind === 'table') place(widget.id, 12, 5);
      else place(widget.id, 12, 2);
    }
    await this.dashboards.update(p, d.id, { layout });
    return { build: 'dashboard', id: d.id, name: d.name, url: `#/dashboards/${d.id}`, created: good.map((i) => i.title), skipped };
  }
}

/** For DuckView AI: how to answer "build me a dashboard / an app". */
export const BUILD_GUIDE = `## Building dashboards and data apps
When the user asks you to build (create, make, set up) a dashboard, report or data app, answer with a short plan in words and then ONE fenced block whose language is \`duckview-build\` — YAML with:
build: dashboard   (or app — a Streamlit data app with one section per item)
name: <a short title>
description: <one sentence>
items:            # 3–8 items; KPIs first
  - { title: <label>, kind: kpi, sql: <SELECT returning one row with a numeric column>, format: number|currency|percent|compact }
  - { title: <label>, kind: chart, chart: bar|line|area|scatter|pie, sql: <SELECT>, x: <column>, y: [<numeric column>, ...] }
  - { title: <label>, kind: table, sql: <SELECT … LIMIT 100> }
  - { title: <label>, kind: text, text: <markdown note> }
Rules: every sql is ONE read-only DuckDB SELECT over the tables in the context (exact names, quoted if needed); aggregate in SQL (GROUP BY, date_trunc for time); alias every computed column; x and y name columns the query returns; use the semantic layer's metric definitions when they exist. Put multi-line SQL in YAML block scalars (sql: |). DuckView runs each query before anything is created and shows the user which items work; they create it with one click.`;
