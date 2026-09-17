import { eq, and, asc, desc } from 'drizzle-orm';
import type { MetadataStore } from '../db/index.js';
import type { Workspace, SessionTab, EngineSettings, ChartConfig } from '../db/schema/sqlite.js';
import { newId } from '../security/crypto.js';
import { EngineManager, type WorkspaceEngine } from '../engine/duckdb.js';
import type { ConnectionService } from './connections.js';
import type { CloudConnectionService } from './cloud.js';
import type { Principal } from './principal.js';
import { isAdmin, assertWorkspaceScope } from './principal.js';
import { badRequest, notFound } from './errors.js';
import { isRemoteUri } from '../engine/sandbox.js';

const STARTER_SQL = `-- Welcome to DuckView. Query files in your data directory directly:
--   SELECT * FROM 'sales.parquet' LIMIT 100;
--   SELECT * FROM read_csv('events/*.csv');
-- Or explore the built-in sample below.
SELECT
  range AS id,
  ['north','south','east','west'][1 + range % 4] AS region,
  round(random() * 1000, 2) AS revenue,
  DATE '2026-01-01' + INTERVAL (range) DAY AS day
FROM range(90);`;

export class WorkspaceService {
  constructor(private readonly store: MetadataStore, private readonly engines: EngineManager, private readonly connections: ConnectionService, private readonly cloud: CloudConnectionService) {}
  private get db() {
    return this.store.db;
  }
  private get s() {
    return this.store.schema;
  }
  get jail() {
    return this.engines.jail;
  }

  async list(p: Principal): Promise<Workspace[]> {
    const q = this.db.select().from(this.s.workspaces).orderBy(desc(this.s.workspaces.updated_at));
    const rows = isAdmin(p) && p.via !== 'token' ? await q : await q.where(eq(this.s.workspaces.user_id, p.userId));
    return p.workspaceScope ? rows.filter((w) => w.id === p.workspaceScope) : rows;
  }

  /** Loads a workspace the principal may access (owner, or admin via UI session). */
  async get(p: Principal, id: string): Promise<Workspace> {
    assertWorkspaceScope(p, id);
    const rows = await this.db.select().from(this.s.workspaces).where(eq(this.s.workspaces.id, id)).limit(1);
    const w = rows[0];
    if (!w) throw notFound('Workspace');
    if (w.user_id !== p.userId && !(isAdmin(p) && p.via !== 'token')) throw notFound('Workspace');
    return w;
  }

  validateSettings(settings: EngineSettings): EngineSettings {
    const out: EngineSettings = {};
    if (settings.memory_limit !== undefined) {
      if (!/^\d+(\.\d+)?\s*(%|[KMGT]i?B)$/i.test(String(settings.memory_limit).trim())) throw badRequest('memory_limit must look like "8GB" or "50%"');
      out.memory_limit = String(settings.memory_limit).trim();
    }
    if (settings.threads !== undefined) {
      if (settings.threads !== 'auto' && (!Number.isInteger(settings.threads) || Number(settings.threads) < 1 || Number(settings.threads) > 1024)) throw badRequest('threads must be "auto" or a positive integer');
      out.threads = settings.threads;
    }
    if (settings.query_timeout_seconds !== undefined) {
      const t = Number(settings.query_timeout_seconds);
      if (!Number.isFinite(t) || t < 1 || t > 86400) throw badRequest('query_timeout_seconds must be between 1 and 86400');
      out.query_timeout_seconds = Math.round(t);
    }
    if (settings.temp_directory !== undefined && settings.temp_directory !== '') out.temp_directory = String(settings.temp_directory);
    if (settings.extensions !== undefined) out.extensions = [...new Set(settings.extensions.map((e) => String(e).toLowerCase().trim()).filter(Boolean))];
    if (settings.connection_ids !== undefined) out.connection_ids = settings.connection_ids.map(String);
    return out;
  }

  validateDbPath(p: string): string {
    const v = (p ?? '').trim() || ':memory:';
    if (v === ':memory:') return v;
    if (isRemoteUri(v)) {
      if (!v.toLowerCase().startsWith('md:')) throw badRequest('Only ":memory:", a .duckdb file inside the data directory, or an "md:" MotherDuck database are supported');
      return v;
    }
    if (!/\.(duckdb|ddb|db)$/i.test(v)) throw badRequest('Persistent database path must end in .duckdb');
    this.engines.jail.resolve(v); // throws SandboxViolation on escape
    return v;
  }

  async create(p: Principal, input: { name: string; active_db_path?: string; engine_settings?: EngineSettings }): Promise<Workspace> {
    const now = new Date();
    const w: Workspace = {
      id: newId(),
      user_id: p.userId,
      name: (input.name ?? '').trim() || 'Untitled workspace',
      active_db_path: this.validateDbPath(input.active_db_path ?? ':memory:'),
      engine_settings: this.validateSettings(input.engine_settings ?? {}),
      created_at: now,
      updated_at: now,
    };
    await this.db.insert(this.s.workspaces).values(w);
    await this.createTab(p, w.id, { title: 'Query 1', sql_content: STARTER_SQL });
    return w;
  }

  async update(p: Principal, id: string, patch: { name?: string; active_db_path?: string; engine_settings?: EngineSettings }): Promise<Workspace> {
    const w = await this.get(p, id);
    const set: Partial<Workspace> = { updated_at: new Date() };
    if (patch.name !== undefined) set.name = patch.name.trim() || w.name;
    if (patch.active_db_path !== undefined) set.active_db_path = this.validateDbPath(patch.active_db_path);
    if (patch.engine_settings !== undefined) set.engine_settings = this.validateSettings(patch.engine_settings);
    await this.db.update(this.s.workspaces).set(set).where(eq(this.s.workspaces.id, id));
    // Engine settings changed → the cached engine is stale; next query rebuilds it.
    if (set.active_db_path !== undefined || set.engine_settings !== undefined) this.engines.evict(id);
    return { ...w, ...set };
  }

  async remove(p: Principal, id: string): Promise<void> {
    await this.get(p, id);
    this.engines.evict(id);
    await this.db.delete(this.s.workspaces).where(eq(this.s.workspaces.id, id));
  }

  async ensureDefault(p: Principal): Promise<Workspace> {
    const existing = await this.db.select().from(this.s.workspaces).where(eq(this.s.workspaces.user_id, p.userId)).limit(1);
    if (existing[0]) return existing[0];
    return this.create(p, { name: 'Scratchpad' });
  }

  /** Resolves (and lazily starts) the DuckDB engine for a workspace. */
  async engine(p: Principal, workspaceId: string): Promise<{ workspace: Workspace; engine: WorkspaceEngine }> {
    const workspace = await this.get(p, workspaceId);
    // Workspace-linked data connections + every cloud storage connection the owner has configured.
    const secrets = [...(await this.connections.resolveSecrets(workspace.user_id, workspace.engine_settings.connection_ids ?? [])), ...(await this.cloud.resolveSecrets(workspace.user_id))];
    const engine = await this.engines.get({ workspaceId: workspace.id, dbPath: workspace.active_db_path, settings: workspace.engine_settings, secrets });
    return { workspace, engine };
  }

  // ---------- Tabs ----------

  async listTabs(p: Principal, workspaceId: string): Promise<SessionTab[]> {
    await this.get(p, workspaceId);
    return this.db.select().from(this.s.sessionTabs).where(eq(this.s.sessionTabs.workspace_id, workspaceId)).orderBy(asc(this.s.sessionTabs.order_index), asc(this.s.sessionTabs.updated_at));
  }

  async createTab(p: Principal, workspaceId: string, input: { title?: string; sql_content?: string; chart_config?: ChartConfig }): Promise<SessionTab> {
    await this.get(p, workspaceId);
    const existing = await this.db.select({ order_index: this.s.sessionTabs.order_index }).from(this.s.sessionTabs).where(eq(this.s.sessionTabs.workspace_id, workspaceId));
    const order = existing.reduce((m, r) => Math.max(m, r.order_index + 1), 0);
    const tab: SessionTab = {
      id: newId(),
      workspace_id: workspaceId,
      title: (input.title ?? '').trim() || `Query ${order + 1}`,
      sql_content: input.sql_content ?? '',
      chart_config: input.chart_config ?? { type: 'none' },
      order_index: order,
      cursor_position: 0,
      updated_at: new Date(),
    };
    await this.db.insert(this.s.sessionTabs).values(tab);
    return tab;
  }

  async updateTab(p: Principal, workspaceId: string, tabId: string, patch: { title?: string; sql_content?: string; chart_config?: ChartConfig; order_index?: number; cursor_position?: number }): Promise<SessionTab> {
    await this.get(p, workspaceId);
    const set: Partial<SessionTab> = { updated_at: new Date() };
    if (patch.title !== undefined) set.title = patch.title.trim().slice(0, 120) || 'Untitled';
    if (patch.sql_content !== undefined) set.sql_content = patch.sql_content.slice(0, 500_000);
    if (patch.chart_config !== undefined) set.chart_config = patch.chart_config;
    if (patch.order_index !== undefined) set.order_index = Math.max(0, Math.floor(patch.order_index));
    if (patch.cursor_position !== undefined) set.cursor_position = Math.max(0, Math.floor(patch.cursor_position));
    const rows = await this.db
      .update(this.s.sessionTabs)
      .set(set)
      .where(and(eq(this.s.sessionTabs.id, tabId), eq(this.s.sessionTabs.workspace_id, workspaceId)))
      .returning();
    if (!rows[0]) throw notFound('Tab');
    await this.db.update(this.s.workspaces).set({ updated_at: new Date() }).where(eq(this.s.workspaces.id, workspaceId));
    return rows[0];
  }

  async deleteTab(p: Principal, workspaceId: string, tabId: string): Promise<void> {
    await this.get(p, workspaceId);
    const r = await this.db
      .delete(this.s.sessionTabs)
      .where(and(eq(this.s.sessionTabs.id, tabId), eq(this.s.sessionTabs.workspace_id, workspaceId)))
      .returning({ id: this.s.sessionTabs.id });
    if (r.length === 0) throw notFound('Tab');
  }
}
