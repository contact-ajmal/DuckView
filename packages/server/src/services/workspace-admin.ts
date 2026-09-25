/**
 * Workspace management: the administrators' list of every workspace (owner, storage, size, members, engine, last
 * activity, cost this month, budget, tags), bulk actions on it, and the create wizard's one call — a workspace with
 * its storage, engine, people, and a starting point (empty, a template, or a clone of another workspace).
 *
 * A clone copies the data (DuckDB's COPY FROM DATABASE, into the new workspace's file), the folders and engine
 * settings, and the objects: saved queries, dashboards and their widgets, notebooks, metrics and quality suites.
 */
import fs from 'node:fs';
import path from 'node:path';
import { eq, inArray, max, sql } from 'drizzle-orm';
import type { MetadataStore } from '../db/index.js';
import type { EngineSettings, Workspace, WorkspaceRole, MemberSubjectType } from '../db/schema/sqlite.js';
import type { AppContext } from '../context.js';
import type { Principal } from './principal.js';
import { requireAdmin, requireWrite } from './principal.js';
import { badRequest } from './errors.js';
import { normalizeTags } from './workspaces.js';
import { logger } from '../observability/logger.js';

export interface WorkspaceRow {
  id: string;
  name: string;
  description: string | null;
  tags: string[];
  color: string | null;
  owner: { id: string; email: string; name: string | null };
  storage: { kind: 'memory' | 'data' | 'folder' | 'cloud' | 'motherduck'; location: string };
  size_bytes: number | null;
  members: number;
  engine: { state: 'running' | 'idle' | 'archived'; memory_bytes: number | null; active_queries: number };
  last_activity_at: string | null;
  cost_this_month: number;
  budget: { amount: number; percent: number } | null;
  archived_at: string | null;
  created_at: string;
}

export type BulkAction = { action: 'archive' | 'restore' | 'delete' } | { action: 'transfer'; user_id: string } | { action: 'tag' | 'untag'; tags: string[] };

export interface CreateInput {
  name: string;
  description?: string | null;
  tags?: string[];
  color?: string | null;
  active_db_path?: string;
  cloud_connection_id?: string | null;
  engine_settings?: EngineSettings;
  start_from?: { kind: 'empty' } | { kind: 'template'; template_id: string } | { kind: 'clone'; workspace_id: string };
  members?: { subject_type: MemberSubjectType; subject_id: string; role: WorkspaceRole }[];
}

/** What a clone (and, later, a bundle) carries besides the data. */
export interface WorkspaceObjects {
  queries: { id: string; name: string; folder: string; description: string | null; sql_text: string; tags: string[] }[];
  dashboards: { name: string; description: string | null; kind: 'grid' | 'mosaic'; spec: unknown; layout: { i: string; x: number; y: number; w: number; h: number }[]; widgets: { id: string; title: string; widget_type: 'KPI' | 'CHART' | 'TABLE' | 'MARKDOWN'; saved_query_id: string | null; custom_sql: string | null; chart_config: Record<string, unknown>; refresh_interval_sec: number }[] }[];
  notebooks: { title: string; cells: { type: string; name?: string | null; source: string; input?: unknown }[] }[];
  semantic: string | null;
  quality: { name: string; description: string | null; relation: string; checks: unknown[] }[];
}

const monthStart = (d = new Date()) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));

export class WorkspaceAdminService {
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

  /** Every workspace in the organisation, with what an administrator needs to manage it. */
  async list(p: Principal): Promise<WorkspaceRow[]> {
    requireAdmin(p);
    const c = this.ctx;
    const rows = await this.db.select().from(this.s.workspaces);
    if (!rows.length) return [];
    const ids = rows.map((w) => w.id);
    const owners = await this.db.select({ id: this.s.users.id, email: this.s.users.email, name: this.s.users.display_name }).from(this.s.users).where(inArray(this.s.users.id, [...new Set(rows.map((w) => w.user_id))]));
    const ownerMap = new Map(owners.map((o) => [o.id, o]));
    const members = await this.db.select({ ws: this.s.workspaceMembers.workspace_id, n: sql<number>`count(*)` }).from(this.s.workspaceMembers).where(inArray(this.s.workspaceMembers.workspace_id, ids)).groupBy(this.s.workspaceMembers.workspace_id);
    const memberMap = new Map(members.map((m) => [m.ws, Number(m.n)]));
    const a = this.s.auditLogs;
    const activity = await this.db.select({ resource: a.resource, at: max(a.timestamp) }).from(a).where(inArray(a.resource, ids.map((id) => `workspace:${id}`))).groupBy(a.resource);
    const activityMap = new Map(activity.map((r) => [String(r.resource).slice('workspace:'.length), r.at]));
    const usage = await c.usage.compute({ from: monthStart(), to: new Date() }, 'org').catch((err) => {
      logger().warn({ err: (err as Error).message }, 'Workspace list: usage unavailable');
      return null;
    });
    const costMap = new Map((usage?.workspaces ?? []).map((w) => [w.id, w.cost.total]));
    const budgets = await c.usage.listBudgets(p).catch(() => []);
    const budgetMap = new Map(budgets.filter((b) => b.workspace_id).map((b) => [b.workspace_id!, { amount: b.amount, percent: b.percent }]));
    const live = await c.engines.liveStats().catch(() => null);
    const engines = new Map((live?.engines ?? []).map((e) => [e.workspaceId, e]));
    return rows
      .map((w) => {
        const o = ownerMap.get(w.user_id);
        const e = engines.get(w.id);
        const at = activityMap.get(w.id);
        const last = [at ? new Date(at as unknown as string | number | Date) : null, w.updated_at].filter(Boolean).sort((x, y) => y!.getTime() - x!.getTime())[0];
        return {
          id: w.id,
          name: w.name,
          description: w.description ?? null,
          tags: w.tags ?? [],
          color: w.color ?? null,
          owner: { id: w.user_id, email: o?.email ?? 'unknown', name: o?.name ?? null },
          storage: { kind: c.workspaces.storageOf(w), location: w.active_db_path },
          size_bytes: this.sizeOf(w),
          members: memberMap.get(w.id) ?? 0,
          engine: { state: w.archived_at ? 'archived' : e ? 'running' : 'idle', memory_bytes: e?.memory_usage_bytes ?? null, active_queries: e?.active_queries ?? 0 },
          last_activity_at: last ? last.toISOString() : null,
          cost_this_month: costMap.get(w.id) ?? 0,
          budget: budgetMap.get(w.id) ?? null,
          archived_at: w.archived_at ? w.archived_at.toISOString() : null,
          created_at: w.created_at.toISOString(),
        } satisfies WorkspaceRow;
      })
      .sort((x, y) => (y.last_activity_at ?? '').localeCompare(x.last_activity_at ?? ''));
  }

  /** The database file's size on disk (with its write-ahead log), or the last synced size of a cloud object. */
  sizeOf(w: Pick<Workspace, 'active_db_path' | 'cloud_sync'>): number | null {
    if (w.cloud_sync?.size_bytes != null) return w.cloud_sync.size_bytes;
    if (w.active_db_path === ':memory:' || /^[a-z]+:/i.test(w.active_db_path)) return null;
    try {
      const abs = this.ctx.workspaces.jail.resolve(w.active_db_path).absolute;
      let n = fs.statSync(abs).size;
      if (fs.existsSync(`${abs}.wal`)) n += fs.statSync(`${abs}.wal`).size;
      return n;
    } catch {
      return null;
    }
  }

  /** One action on several workspaces; each succeeds or fails on its own. */
  async bulk(p: Principal, ids: string[], action: BulkAction): Promise<{ id: string; ok: boolean; error?: string }[]> {
    requireAdmin(p);
    const c = this.ctx;
    const out: { id: string; ok: boolean; error?: string }[] = [];
    for (const id of [...new Set(ids)].slice(0, 500)) {
      try {
        if (action.action === 'archive' || action.action === 'restore') await c.workspaces.setArchived(p, id, action.action === 'archive');
        else if (action.action === 'delete') await c.workspaces.remove(p, id);
        else if (action.action === 'transfer') await c.workspaces.transfer(p, id, action.user_id);
        else if ('tags' in action) {
          const w = await c.workspaces.get(p, id, 'OWNER');
          const change = normalizeTags(action.tags);
          const tags = action.action === 'tag' ? [...w.tags, ...change] : w.tags.filter((t) => !change.includes(t));
          await c.workspaces.update(p, id, { tags });
        }
        c.audit.log({ userId: p.userId, actorType: p.actorType, action: `workspace.${action.action}`, resource: `workspace:${id}`, queryText: action.action === 'transfer' ? `→ user:${action.user_id}` : 'tags' in action ? action.tags.join(', ') : null, ip: p.ip });
        out.push({ id, ok: true });
      } catch (err) {
        out.push({ id, ok: false, error: (err as Error).message });
      }
    }
    return out;
  }

  /** The wizard's create: storage, engine and metadata, then the starting point, then the people. */
  async create(p: Principal, input: CreateInput): Promise<{ workspace: Workspace; started: { kind: string; detail: string } }> {
    requireWrite(p);
    const c = this.ctx;
    const from = input.start_from ?? { kind: 'empty' };
    let source: Workspace | null = null;
    if (from.kind === 'clone') {
      source = await c.workspaces.get(p, from.workspace_id, 'EDITOR');
      if (source.archived_at) throw badRequest(`${source.name} is archived. Restore it before cloning`);
      const target = input.active_db_path?.trim();
      if (!target || target === ':memory:' || /^[a-z]+:/i.test(target)) throw badRequest('A clone needs its own database file: choose a new file in the data directory or a folder');
    }
    for (const m of input.members ?? []) if (m.subject_type !== 'user' && m.subject_type !== 'group') throw badRequest('Members are users or teams');
    const w = await c.workspaces.create(p, { name: input.name, active_db_path: input.active_db_path, cloud_connection_id: input.cloud_connection_id, engine_settings: input.engine_settings, description: input.description, tags: input.tags, color: input.color });
    let started = { kind: 'empty', detail: 'An empty workspace' };
    try {
      if (from.kind === 'template') {
        const r = await c.templates.install(p, from.template_id, { workspace_id: w.id, sample_data: true });
        started = { kind: 'template', detail: `${r.install.template_name}: ${r.created.dashboards.length} dashboards, ${r.created.queries.length} queries, ${r.created.notebooks.length} notebooks` };
      } else if (from.kind === 'clone' && source) {
        const copied = await this.clone(p, source, w);
        started = { kind: 'clone', detail: `Cloned from ${source.name}: ${copied.tables} tables, ${copied.objects.dashboards.length} dashboards, ${copied.objects.queries.length} queries, ${copied.objects.notebooks.length} notebooks` };
      }
      for (const m of input.members ?? []) await c.workspaces.setMember(p, w.id, m);
    } catch (err) {
      // All or nothing: a workspace that did not start the way it was asked is removed again.
      await c.workspaces.remove(p, w.id).catch(() => undefined);
      if (w.active_db_path !== ':memory:' && !/^[a-z]+:/i.test(w.active_db_path)) {
        try {
          const abs = c.workspaces.jail.resolve(w.active_db_path).absolute;
          for (const f of [abs, `${abs}.wal`]) fs.rmSync(f, { force: true });
        } catch {
          /* nothing to clean */
        }
      }
      throw err;
    }
    c.audit.log({ userId: p.userId, actorType: p.actorType, action: 'workspace.create', resource: `workspace:${w.id}`, queryText: started.detail, ip: p.ip });
    return { workspace: (await c.workspaces.rowById(w.id)) ?? w, started };
  }

  /** Copies another workspace's data, folders, engine settings and objects into a new one. */
  private async clone(p: Principal, source: Workspace, target: Workspace): Promise<{ tables: number; objects: WorkspaceObjects }> {
    const c = this.ctx;
    const abs = c.workspaces.jail.resolve(target.active_db_path).absolute;
    if (fs.existsSync(abs)) throw badRequest(`${target.active_db_path} already exists — pick another file name`);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    // Mosaic's derived objects reference an attached in-memory database; they are rebuilt on demand.
    await c.mosaic.dropSchema(source.id).catch(() => undefined);
    const { engine } = await c.workspaces.engine(p, source.id);
    const dbName = String((await engine.runInternal('SELECT current_database() AS d', 15_000))[0]?.d ?? 'memory');
    const lit = abs.replace(/'/g, "''");
    let tables = 0;
    await engine.runInternal(`ATTACH '${lit}' AS __dv_clone`, 60_000);
    try {
      await engine.runInternal(`COPY FROM DATABASE "${dbName.replace(/"/g, '""')}" TO __dv_clone`, 30 * 60_000);
      tables = Number((await engine.runInternal("SELECT count(*) AS n FROM duckdb_tables() WHERE database_name = '__dv_clone' AND NOT internal", 15_000))[0]?.n ?? 0);
    } finally {
      await engine.runInternal('DETACH __dv_clone', 60_000).catch(() => undefined);
    }
    await this.db.update(this.s.workspaces).set({ folders: source.folders, engine_settings: { ...source.engine_settings, ...target.engine_settings }, updated_at: new Date() }).where(eq(this.s.workspaces.id, target.id));
    const objects = await this.captureObjects(p, source.id);
    await this.restoreObjects(p, target.id, objects);
    return { tables, objects };
  }

  /** Everything a workspace holds besides its data, in a form that can be recreated elsewhere. */
  async captureObjects(p: Principal, workspaceId: string): Promise<WorkspaceObjects> {
    const c = this.ctx;
    const queries = (await c.savedQueries.list(p, workspaceId)).map((q) => ({ id: q.id, name: q.name, folder: q.folder, description: q.description, sql_text: q.sql_text, tags: q.tags }));
    const dashboards: WorkspaceObjects['dashboards'] = [];
    for (const d of await c.dashboards.list(p, workspaceId)) {
      const full = await c.dashboards.get(p, d.id);
      dashboards.push({ name: full.name, description: full.description, kind: full.kind, spec: full.spec, layout: full.layout, widgets: full.widgets.map((w) => ({ id: w.id, title: w.title, widget_type: w.widget_type, saved_query_id: w.saved_query_id, custom_sql: w.custom_sql, chart_config: w.chart_config as Record<string, unknown>, refresh_interval_sec: w.refresh_interval_sec })) });
    }
    const notebooks: WorkspaceObjects['notebooks'] = [];
    for (const n of await c.notebooks.list(p, workspaceId)) {
      const full = await c.notebooks.get(p, n.id);
      notebooks.push({ title: full.title, cells: full.cells.map((cell) => ({ type: cell.type, name: cell.name ?? null, source: cell.source, ...(cell.input ? { input: cell.input } : {}) })) });
    }
    const semantic = (await c.semantic.get(p, workspaceId)).yaml || null;
    const quality = (await c.quality.list(p, workspaceId)).map((q) => ({ name: q.name, description: q.description ?? null, relation: q.relation, checks: q.checks }));
    return { queries, dashboards, notebooks, semantic, quality };
  }

  /** Recreates captured objects in a workspace; saved-query links in widgets follow their queries. */
  async restoreObjects(p: Principal, workspaceId: string, o: WorkspaceObjects): Promise<void> {
    const c = this.ctx;
    const queryIds = new Map<string, string>();
    for (const q of o.queries) queryIds.set(q.id, (await c.savedQueries.create(p, workspaceId, { name: q.name, folder: q.folder, description: q.description, sql_text: q.sql_text, tags: q.tags })).id);
    for (const d of o.dashboards) {
      const dash = await c.dashboards.create(p, workspaceId, { name: d.name, description: d.description, kind: d.kind, spec: d.spec ?? undefined });
      if (d.kind !== 'grid') continue;
      const layout: typeof d.layout = [];
      for (const w of d.widgets) {
        const { widget } = await c.dashboards.addWidget(p, dash.id, { title: w.title, widget_type: w.widget_type, saved_query_id: w.saved_query_id ? queryIds.get(w.saved_query_id) ?? null : null, custom_sql: w.custom_sql, chart_config: w.chart_config as never, refresh_interval_sec: w.refresh_interval_sec });
        const l = d.layout.find((x) => x.i === w.id);
        if (l) layout.push({ ...l, i: widget.id });
      }
      if (layout.length) await c.dashboards.update(p, dash.id, { layout });
    }
    for (const n of o.notebooks) await c.notebooks.create(p, workspaceId, { title: n.title, cells: n.cells as never });
    if (o.semantic) await c.semantic.save(p, workspaceId, o.semantic, { force: true });
    for (const q of o.quality) await c.quality.create(p, workspaceId, { name: q.name, description: q.description, relation: q.relation, checks: q.checks as never });
  }

  /** Engine defaults for the wizard: the server's configuration. */
  engineDefaults() {
    const d = this.ctx.cfg.duckdb;
    return { memory_limit: d.default_memory_limit, threads: d.default_threads, query_timeout_seconds: d.query_timeout_seconds };
  }
}
