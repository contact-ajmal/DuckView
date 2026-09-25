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
import { and, desc, eq, inArray, max, ne, sql } from 'drizzle-orm';
import type { MetadataStore } from '../db/index.js';
import type { EngineSettings, Workspace, WorkspaceRole, MemberSubjectType } from '../db/schema/sqlite.js';
import type { AppContext } from '../context.js';
import type { Principal } from './principal.js';
import { isPlatformAdmin, requireAdmin, requireWrite } from './principal.js';
import { badRequest, forbidden } from './errors.js';
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

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
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
    const activity = await this.db.select({ resource: a.resource, at: max(a.timestamp) }).from(a).where(and(inArray(a.resource, ids.map((id) => `workspace:${id}`)), ne(a.actor_type, 'SYSTEM'))).groupBy(a.resource);
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
    input = { ...input, engine_settings: (await c.lifecycle.checkCreate(p, { name: input.name, engine_settings: input.engine_settings as Record<string, unknown> })) as EngineSettings };
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
        started = { kind: 'template', detail: `${r.install.template_name}: ${plural(r.created.dashboards.length, 'dashboard')}, ${plural(r.created.queries.length, 'query', 'queries')}, ${plural(r.created.notebooks.length, 'notebook')}` };
      } else if (from.kind === 'clone' && source) {
        const copied = await this.clone(p, source, w);
        started = { kind: 'clone', detail: `Cloned from ${source.name}: ${plural(copied.tables, 'table')}, ${plural(copied.objects.dashboards.length, 'dashboard')}, ${plural(copied.objects.queries.length, 'query', 'queries')}, ${plural(copied.objects.notebooks.length, 'notebook')}` };
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

  /**
   * One workspace in depth, for its detail page: what it holds, whether it is healthy, where its engine runs, which
   * connections it reads through, and what happened lately. Any member may look; recent activity is for owners.
   */
  async summary(p: Principal, id: string) {
    const c = this.ctx;
    const w = await c.workspaces.get(p, id);
    const s = this.s;
    const count = async (table: typeof s.savedQueries | typeof s.dashboards | typeof s.notebooks | typeof s.dataApps | typeof s.hostedAgents | typeof s.qualitySuites | typeof s.dataSyncs) =>
      Number((await this.db.select({ n: sql<number>`count(*)` }).from(table).where(eq((table as typeof s.dashboards).workspace_id, id)))[0]?.n ?? 0);
    const [queries, dashboards, notebooks, apps, agents, suites, syncs] = await Promise.all([count(s.savedQueries), count(s.dashboards), count(s.notebooks), count(s.dataApps), count(s.hostedAgents), count(s.qualitySuites), count(s.dataSyncs)]);

    // Tables: only from a warm engine (the summary never starts one).
    const live = await c.engines.liveStats().catch(() => null);
    const warm = live?.engines.find((e) => e.workspaceId === id) ?? null;
    let tables: number | null = null;
    let views: number | null = null;
    if (warm && !w.archived_at) {
      try {
        const { engine } = await c.workspaces.engine(p, id);
        const cat = (await engine.catalog()).filter((o) => o.schema !== 'information_schema' && o.schema !== 'pg_catalog');
        tables = cat.filter((o) => o.type !== 'VIEW').length;
        views = cat.filter((o) => o.type === 'VIEW').length;
      } catch {
        /* the engine went away */
      }
    }
    const node = c.cluster.enabled ? await c.cluster.holder(`workspace:${id}`).catch(() => null) : null;

    // Health: one line per thing that can go wrong, worst first.
    type Check = { id: string; label: string; status: 'ok' | 'warn' | 'error'; detail: string };
    const checks: Check[] = [];
    checks.push(w.archived_at ? { id: 'archived', label: 'Engine', status: 'warn', detail: 'Archived: queries are refused until it is restored' } : { id: 'engine', label: 'Engine', status: 'ok', detail: warm ? `Warm, ${warm.active_queries} running` : 'Stopped; starts on the next query' });
    const missing = w.folders.filter((f) => !fs.existsSync(f.path));
    checks.push(missing.length ? { id: 'folders', label: 'Folders', status: 'error', detail: `${missing.map((f) => f.name).join(', ')} not found` } : { id: 'folders', label: 'Folders', status: 'ok', detail: w.folders.length ? `${w.folders.length} folder${w.folders.length === 1 ? '' : 's'} reachable` : 'No folders added' });
    if (w.cloud_sync) checks.push(w.cloud_sync.last_error ? { id: 'cloud', label: 'Cloud sync', status: 'error', detail: w.cloud_sync.last_error } : { id: 'cloud', label: 'Cloud sync', status: w.cloud_sync.dirty ? 'warn' : 'ok', detail: w.cloud_sync.dirty ? 'Changes not pushed yet' : w.cloud_sync.synced_at ? `Synced ${new Date(w.cloud_sync.synced_at).toISOString()}` : 'Not synced yet' });
    const failingSuites = await this.db.select({ name: s.qualitySuites.name, status: s.qualitySuites.status }).from(s.qualitySuites).where(and(eq(s.qualitySuites.workspace_id, id), inArray(s.qualitySuites.status, ['fail', 'error'])));
    if (suites) checks.push(failingSuites.length ? { id: 'quality', label: 'Data quality', status: 'error', detail: `${failingSuites.map((q) => q.name).join(', ')} failing` } : { id: 'quality', label: 'Data quality', status: 'ok', detail: `${suites} suite${suites === 1 ? '' : 's'} passing or not run` });
    if (syncs) {
      const runs = await this.db.select({ sync: s.dataSyncRuns.sync_id, status: s.dataSyncRuns.status, error: s.dataSyncRuns.error }).from(s.dataSyncRuns).where(eq(s.dataSyncRuns.workspace_id, id)).orderBy(desc(s.dataSyncRuns.started_at)).limit(200);
      const latest = new Map<string, { status: string; error: string | null }>();
      for (const r of runs) if (!latest.has(r.sync)) latest.set(r.sync, r);
      const failed = [...latest.values()].filter((r) => r.status === 'error');
      checks.push(failed.length ? { id: 'syncs', label: 'Syncs', status: 'error', detail: `${failed.length} of ${syncs} failed last time${failed[0]?.error ? `: ${failed[0].error.split('\n')[0]}` : ''}` } : { id: 'syncs', label: 'Syncs', status: 'ok', detail: `${syncs} sync${syncs === 1 ? '' : 's'}` });
    }
    const budget = (await c.usage.listBudgets(p, id).catch(() => []))[0];
    if (budget) checks.push({ id: 'budget', label: 'Budget', status: budget.percent >= 100 ? 'error' : budget.percent >= 80 ? 'warn' : 'ok', detail: `${Math.round(budget.percent)}% of ${budget.amount} this period` });
    const rank = { error: 0, warn: 1, ok: 2 } as const;
    checks.sort((a, b) => rank[a.status] - rank[b.status]);

    // Connections the workspace reads through: the owner's (secrets and catalogs come from the owner).
    const owner = w.user_id;
    const [cloud, databases, lakehouses, connectors] = await Promise.all([
      this.db.select({ id: s.cloudConnections.id, name: s.cloudConnections.name, kind: s.cloudConnections.provider }).from(s.cloudConnections).where(eq(s.cloudConnections.user_id, owner)),
      this.db.select({ id: s.databaseConnections.id, name: s.databaseConnections.name, kind: s.databaseConnections.engine, status: s.databaseConnections.status, alias: s.databaseConnections.alias }).from(s.databaseConnections).where(eq(s.databaseConnections.user_id, owner)),
      this.db.select({ id: s.lakehouseConnections.id, name: s.lakehouseConnections.name, kind: s.lakehouseConnections.provider, status: s.lakehouseConnections.status, alias: s.lakehouseConnections.alias }).from(s.lakehouseConnections).where(eq(s.lakehouseConnections.user_id, owner)),
      this.db.select({ id: s.connectorConnections.id, name: s.connectorConnections.name, kind: s.connectorConnections.connector, status: s.connectorConnections.status }).from(s.connectorConnections).where(eq(s.connectorConnections.user_id, owner)),
    ]);

    return {
      workspace: await c.workspaces.describe(p, id),
      size_bytes: this.sizeOf(w),
      counts: { tables, views, queries, dashboards, notebooks, apps, agents, quality_suites: suites, syncs, folders: w.folders.length },
      engine: { state: w.archived_at ? 'archived' : warm ? 'running' : 'idle', memory_bytes: warm?.memory_usage_bytes ?? null, memory_limit_bytes: warm?.memory_limit_bytes ?? null, threads: warm?.threads ?? null, active_queries: warm?.active_queries ?? 0, node: node ? { id: node.id, url: node.url } : null, cluster: c.cluster.enabled },
      checks,
      connections: {
        cloud: cloud.map((x) => ({ ...x, status: 'ok' as const })),
        databases,
        lakehouses,
        connectors,
        attached: w.engine_settings.connection_ids ?? [],
      },
      folders: w.folders.map((f) => ({ ...f, missing: !fs.existsSync(f.path) })),
      disk: await c.workspaces
        .listAllFiles(p, id)
        .then(({ files }) => ({ total_bytes: files.reduce((n, f) => n + f.size_bytes, 0), files: files.length, largest: [...files].sort((a, b) => b.size_bytes - a.size_bytes).slice(0, 15).map((f) => ({ path: f.path, root: f.root ?? null, kind: f.kind, size_bytes: f.size_bytes, modified_at: f.modified_at })) }))
        .catch(() => null),
    };
  }

  /** What happened in a workspace (owners and administrators). */
  async activity(p: Principal, id: string, opts: { limit?: number; offset?: number } = {}) {
    const w = await this.ctx.workspaces.get(p, id);
    if (w.role !== 'OWNER' && !isPlatformAdmin(p)) throw forbidden('Only owners see the activity of a workspace');
    const a = this.s.auditLogs;
    const rows = await this.db
      .select({ id: a.id, timestamp: a.timestamp, action: a.action, actor_type: a.actor_type, user_id: a.user_id, query_text: a.query_text, status: a.status })
      .from(a)
      .where(eq(a.resource, `workspace:${id}`))
      .orderBy(desc(a.timestamp))
      .limit(Math.min(opts.limit ?? 100, 500))
      .offset(opts.offset ?? 0);
    const ids = [...new Set(rows.map((r) => r.user_id).filter(Boolean))] as string[];
    const users = ids.length ? await this.db.select({ id: this.s.users.id, email: this.s.users.email }).from(this.s.users).where(inArray(this.s.users.id, ids)) : [];
    const emails = new Map(users.map((u) => [u.id, u.email]));
    return rows.map((r) => ({ ...r, timestamp: new Date(r.timestamp as unknown as string).toISOString(), who: r.user_id ? emails.get(r.user_id) ?? 'deleted user' : r.actor_type.toLowerCase() }));
  }

  /** Engine defaults for the wizard: the server's configuration. */
  async engineDefaults() {
    const d = this.ctx.cfg.duckdb;
    const pol = await this.ctx.lifecycle.policy();
    return { memory_limit: pol.creation.memory_limit ?? d.default_memory_limit, threads: pol.creation.threads ?? d.default_threads, query_timeout_seconds: pol.creation.query_timeout_seconds ?? d.query_timeout_seconds, memory_cap: pol.quotas.memory_limit, name_hint: pol.creation.name_hint, name_pattern: pol.creation.name_pattern, admins_only: pol.creation.admins_only };
  }
}
