/**
 * Saved queries, dashboards and widgets (BI builder persistence).
 */
import { eq, and, asc, desc } from 'drizzle-orm';
import type { MetadataStore } from '../db/index.js';
import type { SavedQuery, Dashboard, DashboardWidget, LayoutItem, WidgetChartConfig, WidgetType, WorkspaceRole, DashboardKind } from '../db/schema/sqlite.js';
import { WIDGET_TYPES, DASHBOARD_KINDS } from '../db/schema/sqlite.js';
import { newId } from '../security/crypto.js';
import type { WorkspaceService } from './workspaces.js';
import type { Principal } from './principal.js';
import { requireWrite, isAdmin } from './principal.js';
import { badRequest, notFound } from './errors.js';
import { analyzeSql } from '../engine/sql-guard.js';

export class SavedQueryService {
  /** Version history (set by the context). */
  revisions: { record(userId: string | null, workspaceId: string, type: 'notebook' | 'dashboard' | 'query' | 'semantic' | 'dbt', id: string, opts?: { message?: string | null }): Promise<unknown>; forget(type: 'notebook' | 'dashboard' | 'query' | 'semantic' | 'dbt', id: string): Promise<void> } | null = null;
  constructor(private readonly store: MetadataStore, private readonly workspaces: WorkspaceService) {}
  private get db() {
    return this.store.db;
  }
  private get s() {
    return this.store.schema;
  }

  async list(p: Principal, workspaceId: string): Promise<SavedQuery[]> {
    await this.workspaces.get(p, workspaceId);
    return this.db.select().from(this.s.savedQueries).where(eq(this.s.savedQueries.workspace_id, workspaceId)).orderBy(asc(this.s.savedQueries.folder), asc(this.s.savedQueries.name));
  }

  async get(p: Principal, workspaceId: string, id: string): Promise<SavedQuery> {
    await this.workspaces.get(p, workspaceId);
    const rows = await this.db
      .select()
      .from(this.s.savedQueries)
      .where(and(eq(this.s.savedQueries.id, id), eq(this.s.savedQueries.workspace_id, workspaceId)))
      .limit(1);
    if (!rows[0]) throw notFound('Saved query');
    return rows[0];
  }

  private normalise(input: { name?: string; folder?: string; description?: string | null; sql_text?: string; tags?: string[] }) {
    const out: Partial<SavedQuery> = {};
    if (input.name !== undefined) {
      const n = input.name.trim();
      if (!n) throw badRequest('name is required');
      out.name = n.slice(0, 160);
    }
    if (input.folder !== undefined) out.folder = input.folder.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').replace(/\.\./g, '').slice(0, 200);
    if (input.description !== undefined) out.description = input.description?.trim().slice(0, 2000) || null;
    if (input.sql_text !== undefined) {
      if (!input.sql_text.trim()) throw badRequest('sql_text is required');
      out.sql_text = input.sql_text.slice(0, 500_000);
    }
    if (input.tags !== undefined) out.tags = [...new Set(input.tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean))].slice(0, 30);
    return out;
  }

  async create(p: Principal, workspaceId: string, input: { name: string; folder?: string; description?: string | null; sql_text: string; tags?: string[] }): Promise<SavedQuery> {
    requireWrite(p);
    await this.workspaces.get(p, workspaceId, 'EDITOR');
    const now = new Date();
    const n = this.normalise(input);
    const q: SavedQuery = { id: newId(), workspace_id: workspaceId, user_id: p.userId, name: n.name!, folder: n.folder ?? '', description: n.description ?? null, sql_text: n.sql_text!, tags: n.tags ?? [], created_at: now, updated_at: now };
    await this.db.insert(this.s.savedQueries).values(q);
    await this.revisions?.record(p.userId, workspaceId, 'query', q.id);
    return q;
  }

  async update(p: Principal, workspaceId: string, id: string, patch: { name?: string; folder?: string; description?: string | null; sql_text?: string; tags?: string[] }): Promise<SavedQuery> {
    requireWrite(p);
    await this.workspaces.get(p, workspaceId, 'EDITOR');
    const existing = await this.get(p, workspaceId, id);
    const set = { ...this.normalise(patch), updated_at: new Date() };
    await this.db.update(this.s.savedQueries).set(set).where(eq(this.s.savedQueries.id, id));
    await this.revisions?.record(p.userId, workspaceId, 'query', id);
    return { ...existing, ...set };
  }

  async remove(p: Principal, workspaceId: string, id: string): Promise<void> {
    requireWrite(p);
    await this.workspaces.get(p, workspaceId, 'EDITOR');
    await this.get(p, workspaceId, id);
    await this.db.delete(this.s.savedQueries).where(eq(this.s.savedQueries.id, id));
    await this.revisions?.forget('query', id);
  }
}

export interface WidgetInput {
  title?: string;
  widget_type?: WidgetType;
  saved_query_id?: string | null;
  custom_sql?: string | null;
  chart_config?: WidgetChartConfig;
  refresh_interval_sec?: number;
  order_index?: number;
}

export class DashboardService {
  /** Version history (set by the context). */
  revisions: { record(userId: string | null, workspaceId: string, type: 'notebook' | 'dashboard' | 'query' | 'semantic' | 'dbt', id: string, opts?: { message?: string | null }): Promise<unknown>; forget(type: 'notebook' | 'dashboard' | 'query' | 'semantic' | 'dbt', id: string): Promise<void> } | null = null;
  private async rec(userId: string, id: string): Promise<void> {
    if (!this.revisions) return;
    const d = (await this.db.select({ workspace_id: this.s.dashboards.workspace_id }).from(this.s.dashboards).where(eq(this.s.dashboards.id, id)).limit(1))[0];
    if (d) await this.revisions.record(userId, d.workspace_id, 'dashboard', id);
  }
  constructor(private readonly store: MetadataStore, private readonly workspaces: WorkspaceService) {}
  private get db() {
    return this.store.db;
  }
  private get s() {
    return this.store.schema;
  }

  async list(p: Principal, workspaceId: string): Promise<Dashboard[]> {
    await this.workspaces.get(p, workspaceId);
    return this.db.select().from(this.s.dashboards).where(eq(this.s.dashboards.workspace_id, workspaceId)).orderBy(desc(this.s.dashboards.updated_at));
  }

  /** Loads a dashboard the principal may access (through its workspace); `minRole` gates edits to EDITOR+. */
  async get(p: Principal, id: string, minRole: WorkspaceRole = 'VIEWER'): Promise<Dashboard & { widgets: DashboardWidget[] }> {
    const rows = await this.db.select().from(this.s.dashboards).where(eq(this.s.dashboards.id, id)).limit(1);
    const d = rows[0];
    if (!d) throw notFound('Dashboard');
    await this.workspaces.get(p, d.workspace_id, minRole); // authorisation via workspace membership / admin
    const widgets = await this.db.select().from(this.s.dashboardWidgets).where(eq(this.s.dashboardWidgets.dashboard_id, id)).orderBy(asc(this.s.dashboardWidgets.order_index), asc(this.s.dashboardWidgets.created_at));
    return { ...d, widgets };
  }

  /** A Mosaic spec must be a JSON object of bounded size; its contents are validated when rendered (parseSpec). */
  validateSpec(spec: unknown): Record<string, unknown> | null {
    if (spec === null || spec === undefined) return null;
    if (typeof spec !== 'object' || Array.isArray(spec)) throw badRequest('spec must be a JSON object (a Mosaic declarative specification)');
    const text = JSON.stringify(spec);
    if (text.length > 512_000) throw badRequest('spec is too large (limit 512 KB)');
    return spec as Record<string, unknown>;
  }

  async create(p: Principal, workspaceId: string, input: { name: string; description?: string | null; kind?: DashboardKind; spec?: unknown }): Promise<Dashboard> {
    requireWrite(p);
    await this.workspaces.get(p, workspaceId, 'EDITOR');
    const kind = input.kind ?? 'grid';
    if (!(DASHBOARD_KINDS as readonly string[]).includes(kind)) throw badRequest(`kind must be one of ${DASHBOARD_KINDS.join(', ')}`);
    const now = new Date();
    const d: Dashboard = { id: newId(), workspace_id: workspaceId, user_id: p.userId, name: (input.name ?? '').trim().slice(0, 160) || 'Untitled dashboard', description: input.description?.trim().slice(0, 2000) || null, layout: [], kind, spec: kind === 'mosaic' ? this.validateSpec(input.spec) ?? {} : null, created_at: now, updated_at: now };
    await this.db.insert(this.s.dashboards).values(d);
    await this.rec(p.userId, d.id);
    return d;
  }

  async update(p: Principal, id: string, patch: { name?: string; description?: string | null; layout?: LayoutItem[]; spec?: unknown }): Promise<Dashboard> {
    requireWrite(p);
    const d = await this.get(p, id, 'EDITOR');
    const set: Partial<Dashboard> = { updated_at: new Date() };
    if (patch.name !== undefined) set.name = patch.name.trim().slice(0, 160) || d.name;
    if (patch.description !== undefined) set.description = patch.description?.trim().slice(0, 2000) || null;
    if (patch.layout !== undefined) set.layout = this.validateLayout(patch.layout, d.widgets.map((w) => w.id));
    if (patch.spec !== undefined) {
      if (d.kind !== 'mosaic') throw badRequest('Only Mosaic dashboards carry a spec');
      set.spec = this.validateSpec(patch.spec) ?? {};
    }
    await this.db.update(this.s.dashboards).set(set).where(eq(this.s.dashboards.id, id));
    await this.rec(p.userId, id);
    const { widgets: _w, ...plain } = d;
    return { ...plain, ...set };
  }

  private validateLayout(layout: LayoutItem[], widgetIds: string[]): LayoutItem[] {
    const ids = new Set(widgetIds);
    return layout
      .filter((l) => l && ids.has(String(l.i)))
      .map((l) => ({ i: String(l.i), x: clampInt(l.x, 0, 11), y: clampInt(l.y, 0, 10_000), w: clampInt(l.w, 1, 12), h: clampInt(l.h, 1, 200), ...(l.minW ? { minW: clampInt(l.minW, 1, 12) } : {}), ...(l.minH ? { minH: clampInt(l.minH, 1, 200) } : {}) }));
  }

  async remove(p: Principal, id: string): Promise<void> {
    requireWrite(p);
    await this.get(p, id, 'EDITOR');
    await this.db.delete(this.s.dashboards).where(eq(this.s.dashboards.id, id));
    await this.revisions?.forget('dashboard', id);
  }

  private validateWidget(input: WidgetInput, existing?: DashboardWidget): Partial<DashboardWidget> {
    const out: Partial<DashboardWidget> = {};
    if (input.title !== undefined) out.title = input.title.trim().slice(0, 160) || 'Untitled';
    if (input.widget_type !== undefined) {
      if (!(WIDGET_TYPES as readonly string[]).includes(input.widget_type)) throw badRequest(`widget_type must be one of ${WIDGET_TYPES.join(', ')}`);
      out.widget_type = input.widget_type;
    }
    if (input.saved_query_id !== undefined) out.saved_query_id = input.saved_query_id || null;
    if (input.custom_sql !== undefined) {
      const sql = input.custom_sql?.trim() || null;
      if (sql) {
        const a = analyzeSql(sql);
        if (a.isMutating) throw badRequest('Widgets may only run read-only SQL');
      }
      out.custom_sql = sql;
    }
    if (input.chart_config !== undefined) out.chart_config = input.chart_config ?? {};
    if (input.refresh_interval_sec !== undefined) out.refresh_interval_sec = clampInt(input.refresh_interval_sec, 0, 86_400);
    if (input.order_index !== undefined) out.order_index = clampInt(input.order_index, 0, 10_000);
    const type = out.widget_type ?? existing?.widget_type;
    const hasSource = (out.saved_query_id ?? existing?.saved_query_id) || (out.custom_sql ?? existing?.custom_sql);
    if (type && type !== 'MARKDOWN' && !hasSource) throw badRequest('Widget needs a saved_query_id or custom_sql');
    return out;
  }

  async addWidget(p: Principal, dashboardId: string, input: WidgetInput & { title: string; widget_type: WidgetType }): Promise<{ widget: DashboardWidget; layout: LayoutItem[] }> {
    requireWrite(p);
    const d = await this.get(p, dashboardId, 'EDITOR');
    if (d.kind !== 'grid') throw badRequest('Widgets belong to grid dashboards; a Mosaic dashboard is described by its spec');
    if (input.saved_query_id) {
      const q = await this.db.select({ id: this.s.savedQueries.id }).from(this.s.savedQueries).where(and(eq(this.s.savedQueries.id, input.saved_query_id), eq(this.s.savedQueries.workspace_id, d.workspace_id))).limit(1);
      if (!q[0]) throw badRequest('saved_query_id does not belong to this workspace');
    }
    const v = this.validateWidget(input);
    const now = new Date();
    const w: DashboardWidget = {
      id: newId(),
      dashboard_id: dashboardId,
      title: v.title ?? 'Untitled',
      widget_type: v.widget_type!,
      saved_query_id: v.saved_query_id ?? null,
      custom_sql: v.custom_sql ?? null,
      chart_config: v.chart_config ?? {},
      refresh_interval_sec: v.refresh_interval_sec ?? 0,
      order_index: v.order_index ?? d.widgets.length,
      created_at: now,
      updated_at: now,
    };
    await this.db.insert(this.s.dashboardWidgets).values(w);
    // Append to the layout below existing content (12-col grid; KPI 3x2, others 6x4).
    const maxY = d.layout.reduce((m, l) => Math.max(m, l.y + l.h), 0);
    const size = w.widget_type === 'KPI' ? { w: 3, h: 2 } : w.widget_type === 'MARKDOWN' ? { w: 4, h: 3 } : { w: 6, h: 4 };
    const layout = [...d.layout, { i: w.id, x: 0, y: maxY, ...size }];
    await this.db.update(this.s.dashboards).set({ layout, updated_at: now }).where(eq(this.s.dashboards.id, dashboardId));
    await this.rec(p.userId, dashboardId);
    return { widget: w, layout };
  }

  async updateWidget(p: Principal, dashboardId: string, widgetId: string, patch: WidgetInput): Promise<DashboardWidget> {
    requireWrite(p);
    const d = await this.get(p, dashboardId, 'EDITOR');
    const existing = d.widgets.find((w) => w.id === widgetId);
    if (!existing) throw notFound('Widget');
    if (patch.saved_query_id) {
      const q = await this.db.select({ id: this.s.savedQueries.id }).from(this.s.savedQueries).where(and(eq(this.s.savedQueries.id, patch.saved_query_id), eq(this.s.savedQueries.workspace_id, d.workspace_id))).limit(1);
      if (!q[0]) throw badRequest('saved_query_id does not belong to this workspace');
    }
    const set = { ...this.validateWidget(patch, existing), updated_at: new Date() };
    await this.db.update(this.s.dashboardWidgets).set(set).where(eq(this.s.dashboardWidgets.id, widgetId));
    await this.db.update(this.s.dashboards).set({ updated_at: new Date() }).where(eq(this.s.dashboards.id, dashboardId));
    await this.rec(p.userId, dashboardId);
    return { ...existing, ...set };
  }

  async removeWidget(p: Principal, dashboardId: string, widgetId: string): Promise<LayoutItem[]> {
    requireWrite(p);
    const d = await this.get(p, dashboardId, 'EDITOR');
    if (!d.widgets.some((w) => w.id === widgetId)) throw notFound('Widget');
    await this.db.delete(this.s.dashboardWidgets).where(eq(this.s.dashboardWidgets.id, widgetId));
    const layout = d.layout.filter((l) => l.i !== widgetId);
    await this.db.update(this.s.dashboards).set({ layout, updated_at: new Date() }).where(eq(this.s.dashboards.id, dashboardId));
    await this.rec(p.userId, dashboardId);
    return layout;
  }

  /** Resolves the SQL a widget should run (saved query wins over custom SQL). */
  async widgetSql(p: Principal, dashboardId: string, widgetId: string): Promise<{ widget: DashboardWidget; sql: string; workspace_id: string }> {
    const d = await this.get(p, dashboardId);
    const w = d.widgets.find((x) => x.id === widgetId);
    if (!w) throw notFound('Widget');
    if (w.widget_type === 'MARKDOWN') throw badRequest('Markdown widgets have no query');
    let sql = w.custom_sql ?? '';
    if (w.saved_query_id) {
      const q = await this.db.select().from(this.s.savedQueries).where(eq(this.s.savedQueries.id, w.saved_query_id)).limit(1);
      if (q[0]) sql = q[0].sql_text;
    }
    if (!sql.trim()) throw badRequest('Widget has no SQL');
    return { widget: w, sql, workspace_id: d.workspace_id };
  }

  /** Admins may list every dashboard (for the MCP list_dashboards tool this stays per-principal). */
  async listAll(p: Principal): Promise<Dashboard[]> {
    if (!isAdmin(p) || p.via === 'token') {
      const wss = await this.workspaces.list(p);
      const out: Dashboard[] = [];
      for (const w of wss) out.push(...(await this.list(p, w.id)));
      return out;
    }
    return this.db.select().from(this.s.dashboards).orderBy(desc(this.s.dashboards.updated_at));
  }
}

function clampInt(v: unknown, min: number, max: number): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}
