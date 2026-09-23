/**
 * Catalog and lineage of a workspace.
 *
 * Catalog: descriptions and tags on tables and columns (editors write them; everyone who can see the workspace reads
 * them; Copilot and the agents' inspect_schema carry them into prompts).
 *
 * Lineage: a graph built on demand from what DuckView already knows — where tables come from (connector
 * connections, files, URLs and databases, through syncs) and what reads them (views, saved queries, dashboards and
 * their widgets or Mosaic datasets, alerts, snapshots, data apps). SQL is read with DuckDB's own parser
 * (json_serialize_sql), so CTEs, subqueries and joins are followed exactly; data apps are Python, so their edges are
 * "mentions" of known table names in the code.
 *
 * OpenLineage: when lineage.openlineage_url is set, every sync run emits START and COMPLETE / FAIL run events
 * (inputs: its source; output: its table, with the table's schema and row count) — Marquez, DataHub and
 * OpenMetadata ingest them.
 */
import { and, eq, isNull } from 'drizzle-orm';
import type { MetadataStore } from '../db/index.js';
import type { CatalogAnnotation, DataSync, SyncSource } from '../db/schema/sqlite.js';
import type { DuckViewConfig } from '../config/index.js';
import type { WorkspaceEngine, CatalogObject } from '../engine/duckdb.js';
import { newId } from '../security/crypto.js';
import type { Principal } from './principal.js';
import { requireWrite } from './principal.js';
import type { WorkspaceService } from './workspaces.js';
import type { AuditService } from './audit.js';
import type { DbtService } from './dbt.js';
import { badRequest } from './errors.js';
import { liveEvents } from '../observability/events.js';
import { logger } from '../observability/logger.js';

export type LineageKind = 'source' | 'file' | 'sync' | 'dbt' | 'table' | 'view' | 'saved_query' | 'dashboard' | 'app' | 'alert' | 'snapshot';
export interface LineageNode {
  id: string;
  kind: LineageKind;
  label: string;
  /** Where to open it in DuckView. */
  href?: string;
  detail?: string;
  description?: string | null;
  tags?: string[];
}
export interface LineageEdge {
  from: string;
  to: string;
  /** reads (SQL), loads (a sync), builds (a dbt project), renders (snapshot), mentions (app code) */
  kind: 'reads' | 'loads' | 'builds' | 'renders' | 'mentions';
}

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const FILE_FUNCS = new Set(['read_parquet', 'parquet_scan', 'read_csv', 'read_csv_auto', 'read_json', 'read_json_auto', 'read_ndjson', 'read_ndjson_auto', 'read_xlsx', 'st_read', 'iceberg_scan', 'delta_scan']);
const FILE_LIKE = /[/\\]|\.(parquet|csv|tsv|json|jsonl|ndjson|txt|xlsx|arrow|feather|gz|zst)$|^[a-z0-9]+:\/\//i;

/** Tables and files a statement reads, from DuckDB's parse tree (CTE names excluded). */
export async function sqlReferences(engine: WorkspaceEngine, sql: string): Promise<{ tables: string[]; files: string[] }> {
  const rows = await engine.runInternal(`SELECT json_serialize_sql(${lit(sql)}) AS j`, 30_000);
  const tree = JSON.parse(String(rows[0]?.j ?? '{}').replace(/"query_location":\s*\d{17,}/g, '"query_location":0')) as { error?: boolean; statements?: unknown[] };
  if (tree.error || !tree.statements) return { tables: [], files: [] };
  const ctes = new Set<string>();
  const tables = new Set<string>();
  const files = new Set<string>();
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!n || typeof n !== 'object') return;
    const o = n as Record<string, unknown>;
    const map = (o.cte_map as { map?: { key: string }[] } | undefined)?.map;
    if (map) for (const e of map) ctes.add(String(e.key).toLowerCase());
    if (o.type === 'BASE_TABLE') {
      const name = String(o.table_name ?? '');
      const schema = String(o.schema_name ?? '');
      if (FILE_LIKE.test(name) && !schema) files.add(name);
      else tables.add(schema && schema !== 'main' ? `${schema}.${name}` : name);
    } else if (o.type === 'TABLE_FUNCTION') {
      const fn = o.function as { function_name?: string; children?: { value?: { value?: unknown } }[] } | undefined;
      const arg = fn?.children?.[0]?.value?.value;
      if (fn?.function_name && FILE_FUNCS.has(fn.function_name.toLowerCase()) && typeof arg === 'string') files.add(arg);
    }
    for (const v of Object.values(o)) walk(v);
  };
  walk(tree.statements);
  return { tables: [...tables].filter((t) => !ctes.has(t.toLowerCase())), files: [...files] };
}

export class LineageService {
  /** Set by the context: dbt projects appear in the graph. */
  dbt: DbtService | null = null;
  constructor(private readonly store: MetadataStore, private readonly cfg: DuckViewConfig, private readonly workspaces: WorkspaceService, private readonly audit: AuditService) {
    if (cfg.lineage.openlineage_url) liveEvents.subscribe((e) => { if (e.type === 'sync') void this.emitSync(e.sync_id, e.run_id, e.status, e.rows, e.error).catch((err) => logger().warn({ err: (err as Error).message }, 'OpenLineage event not sent')); });
  }
  private get db() {
    return this.store.db;
  }
  private get s() {
    return this.store.schema;
  }

  // ------------------------------------------------------------------------------------------ annotations

  async annotations(p: Principal, workspaceId: string): Promise<CatalogAnnotation[]> {
    await this.workspaces.get(p, workspaceId);
    return this.db.select().from(this.s.catalogAnnotations).where(eq(this.s.catalogAnnotations.workspace_id, workspaceId));
  }

  /** Sets (or clears, with an empty description and no tags) the description and tags of a table or a column. */
  async annotate(p: Principal, workspaceId: string, input: { object_name: string; column_name?: string | null; description?: string | null; tags?: string[] }): Promise<CatalogAnnotation | null> {
    requireWrite(p);
    await this.workspaces.get(p, workspaceId, 'EDITOR');
    const object = input.object_name.trim();
    if (!object) throw badRequest('object_name is required');
    const column = input.column_name?.trim() || null;
    const tags = [...new Set((input.tags ?? []).map((t) => t.trim().toLowerCase()).filter((t) => /^[a-z0-9][a-z0-9_:-]{0,39}$/.test(t)))].slice(0, 20);
    const description = input.description?.trim().slice(0, 4000) || null;
    const where = and(eq(this.s.catalogAnnotations.workspace_id, workspaceId), eq(this.s.catalogAnnotations.object_name, object), column ? eq(this.s.catalogAnnotations.column_name, column) : isNull(this.s.catalogAnnotations.column_name));
    const existing = (await this.db.select().from(this.s.catalogAnnotations).where(where).limit(1))[0];
    if (!description && !tags.length) {
      if (existing) await this.db.delete(this.s.catalogAnnotations).where(eq(this.s.catalogAnnotations.id, existing.id));
      return null;
    }
    const row: CatalogAnnotation = { id: existing?.id ?? newId(), workspace_id: workspaceId, object_name: object, column_name: column, description, tags, updated_by: p.userId, updated_at: new Date() };
    if (existing) await this.db.update(this.s.catalogAnnotations).set(row).where(eq(this.s.catalogAnnotations.id, existing.id));
    else await this.db.insert(this.s.catalogAnnotations).values(row);
    this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'catalog.annotate', resource: `workspace:${workspaceId}:${object}${column ? `.${column}` : ''}`, ip: p.ip });
    return row;
  }

  /**
   * Notes that come from code (dbt's YAML): written for every object the run built, one audit event for the batch.
   * The caller already holds EDITOR on the workspace.
   */
  async importNotes(p: Principal, workspaceId: string, notes: { object_name: string; column_name: string | null; description: string | null; tags: string[] }[], source: string): Promise<number> {
    let n = 0;
    for (const note of notes) {
      const column = note.column_name?.trim() || null;
      const tags = [...new Set(note.tags.map((t) => String(t).trim().toLowerCase()).filter((t) => /^[a-z0-9][a-z0-9_:-]{0,39}$/.test(t)))].slice(0, 20);
      const description = note.description?.trim().slice(0, 4000) || null;
      if (!description && !tags.length) continue;
      const where = and(eq(this.s.catalogAnnotations.workspace_id, workspaceId), eq(this.s.catalogAnnotations.object_name, note.object_name), column ? eq(this.s.catalogAnnotations.column_name, column) : isNull(this.s.catalogAnnotations.column_name));
      const existing = (await this.db.select().from(this.s.catalogAnnotations).where(where).limit(1))[0];
      const row: CatalogAnnotation = { id: existing?.id ?? newId(), workspace_id: workspaceId, object_name: note.object_name, column_name: column, description: description ?? existing?.description ?? null, tags: [...new Set([...(existing?.tags ?? []), ...tags])].slice(0, 20), updated_by: p.userId, updated_at: new Date() };
      if (existing) await this.db.update(this.s.catalogAnnotations).set(row).where(eq(this.s.catalogAnnotations.id, existing.id));
      else await this.db.insert(this.s.catalogAnnotations).values(row);
      n++;
    }
    if (n) this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'catalog.import', resource: `workspace:${workspaceId}`, queryText: `${n} notes from ${source}`, ip: p.ip });
    return n;
  }

  /** The engine's catalog with descriptions and tags attached (what Copilot and agents are told). */
  async catalog(p: Principal, workspaceId: string): Promise<(CatalogObject & { description: string | null; tags: string[]; columns: (CatalogObject['columns'][number] & { description: string | null; tags: string[] })[] })[]> {
    const { engine } = await this.workspaces.engine(p, workspaceId);
    const [objects, notes] = await Promise.all([engine.catalog(), this.annotations(p, workspaceId)]);
    const key = (o: string, c: string | null) => `${o.toLowerCase()}|${(c ?? '').toLowerCase()}`;
    const byKey = new Map(notes.map((n) => [key(n.object_name, n.column_name), n]));
    return objects.map((o) => {
      const name = o.schema === 'main' ? o.name : `${o.schema}.${o.name}`;
      const t = byKey.get(key(name, null));
      return { ...o, description: t?.description ?? null, tags: t?.tags ?? [], columns: o.columns.map((c) => { const n = byKey.get(key(name, c.name)); return { ...c, description: n?.description ?? null, tags: n?.tags ?? [] }; }) };
    });
  }

  /** Short catalog notes for prompts: "orders — Orders placed on the web shop [pii] · email: customer email". */
  async notesForPrompt(workspaceId: string): Promise<string> {
    const notes = await this.db.select().from(this.s.catalogAnnotations).where(eq(this.s.catalogAnnotations.workspace_id, workspaceId));
    if (!notes.length) return '';
    const byObject = new Map<string, CatalogAnnotation[]>();
    for (const n of notes) byObject.set(n.object_name, [...(byObject.get(n.object_name) ?? []), n]);
    return [...byObject.entries()].map(([o, list]) => {
      const t = list.find((x) => !x.column_name);
      const cols = list.filter((x) => x.column_name).map((x) => `${x.column_name}: ${x.description ?? ''}${x.tags.length ? ` [${x.tags.join(', ')}]` : ''}`.trim());
      return `- ${o}${t?.description ? ` — ${t.description}` : ''}${t?.tags.length ? ` [${t.tags.join(', ')}]` : ''}${cols.length ? `\n  ${cols.join('\n  ')}` : ''}`;
    }).join('\n');
  }

  // ------------------------------------------------------------------------------------------ lineage

  async graph(p: Principal, workspaceId: string): Promise<{ nodes: LineageNode[]; edges: LineageEdge[] }> {
    const { engine } = await this.workspaces.engine(p, workspaceId);
    const objects = await engine.catalog();
    const notes = await this.annotations(p, workspaceId);
    const nodes = new Map<string, LineageNode>();
    const edges: LineageEdge[] = [];
    const seen = new Set<string>();
    const edge = (from: string, to: string, kind: LineageEdge['kind']) => {
      const k = `${from}>${to}>${kind}`;
      if (from !== to && !seen.has(k)) { seen.add(k); edges.push({ from, to, kind }); }
    };
    const known = new Map<string, string>(); // lower-case name (and schema.name) → node id
    for (const o of objects) {
      if (o.name.startsWith(this.cfg.mosaic.schema) || o.schema === this.cfg.mosaic.schema) continue;
      const name = o.schema === 'main' ? o.name : `${o.schema}.${o.name}`;
      const id = `${o.type === 'VIEW' ? 'view' : 'table'}:${name}`;
      const note = notes.find((n) => !n.column_name && n.object_name.toLowerCase() === name.toLowerCase());
      nodes.set(id, { id, kind: o.type === 'VIEW' ? 'view' : 'table', label: name, detail: o.estimated_rows !== null ? `${o.estimated_rows.toLocaleString()} rows · ${o.column_count} columns` : `${o.column_count} columns`, description: note?.description ?? null, tags: note?.tags ?? [], href: `#/query?table=${encodeURIComponent(name)}` });
      known.set(name.toLowerCase(), id);
      known.set(`${o.schema}.${o.name}`.toLowerCase(), id);
    }
    const reads = async (sql: string | null | undefined, to: string) => {
      if (!sql?.trim()) return;
      const refs = await sqlReferences(engine, sql).catch(() => ({ tables: [], files: [] }));
      for (const t of refs.tables) {
        const id = known.get(t.toLowerCase());
        if (id) edge(id, to, 'reads');
      }
      for (const f of refs.files) {
        const id = `file:${f}`;
        if (!nodes.has(id)) nodes.set(id, { id, kind: 'file', label: f.split('/').pop() ?? f, detail: f });
        edge(id, to, 'reads');
      }
    };
    // Views read tables.
    for (const o of objects) if (o.type === 'VIEW' && o.sql) {
      const name = o.schema === 'main' ? o.name : `${o.schema}.${o.name}`;
      const id = known.get(name.toLowerCase());
      const body = /\bAS\s+((?:SELECT|WITH|FROM|VALUES|\()[\s\S]*)$/i.exec(o.sql)?.[1]?.replace(/;\s*$/, '');
      if (id && body) await reads(body, id);
    }
    // Syncs load tables from sources.
    const syncs = await this.db.select().from(this.s.dataSyncs).where(eq(this.s.dataSyncs.workspace_id, workspaceId));
    for (const s of syncs) {
      const id = `sync:${s.id}`;
      nodes.set(id, { id, kind: 'sync', label: s.name, detail: `${s.mode} · ${s.schedule.kind === 'cron' ? s.schedule.expression : s.schedule.kind === 'interval' ? `every ${s.schedule.minutes} min` : 'manual'}`, href: '#/connections' });
      const target = `${s.target_schema && s.target_schema !== 'main' ? `${s.target_schema}.` : ''}${s.target_table}`;
      const tid = known.get(target.toLowerCase()) ?? `table:${target}`;
      if (!nodes.has(tid)) nodes.set(tid, { id: tid, kind: 'table', label: target, detail: 'not created yet' });
      edge(id, tid, 'loads');
      const src = await this.sourceNode(s.source);
      if (src) {
        if (!nodes.has(src.id)) nodes.set(src.id, src);
        edge(src.id, id, 'reads');
      } else if (s.source.kind === 'sql') await reads(s.source.sql, id);
      if (s.transform_sql) await reads(s.transform_sql.replace(/\{\{\s*source\s*\}\}/g, 'source'), id);
    }
    // dbt projects build models and seeds (from their last run), which read their upstream models and sources.
    if (this.dbt) {
      for (const { project, built } of await this.dbt.lineageOf(workspaceId)) {
        const id = `dbt:${project.id}`;
        nodes.set(id, { id, kind: 'dbt', label: project.name, detail: `dbt · ${built.length} built · ${project.schedule.kind === 'cron' ? project.schedule.expression : project.schedule.kind === 'interval' ? `every ${project.schedule.minutes} min` : 'manual'}`, href: `#/transform/dbt/${project.id}` });
        for (const b of built) {
          const tid = known.get(b.relation.toLowerCase()) ?? `table:${b.relation}`;
          if (!nodes.has(tid)) nodes.set(tid, { id: tid, kind: 'table', label: b.relation, detail: 'not created yet' });
          edge(id, tid, 'builds');
          for (const u of b.upstream) {
            const uid = known.get(u.toLowerCase());
            if (uid) edge(uid, tid, 'reads');
          }
        }
      }
    }
    // Saved queries, dashboards (widgets and Mosaic specs).
    const saved = await this.db.select().from(this.s.savedQueries).where(eq(this.s.savedQueries.workspace_id, workspaceId));
    for (const q of saved) {
      const id = `saved_query:${q.id}`;
      nodes.set(id, { id, kind: 'saved_query', label: q.name, href: '#/query' });
      await reads(q.sql_text, id);
    }
    const dashboards = await this.db.select().from(this.s.dashboards).where(eq(this.s.dashboards.workspace_id, workspaceId));
    for (const d of dashboards) {
      const id = `dashboard:${d.id}`;
      nodes.set(id, { id, kind: 'dashboard', label: d.name, detail: d.kind === 'mosaic' ? 'Mosaic' : 'grid', href: `#/dashboards/${d.id}` });
      if (d.kind === 'mosaic' && d.spec) {
        const spec = d.spec as { data?: Record<string, unknown> };
        for (const def of Object.values(spec.data ?? {})) {
          const q = typeof def === 'string' ? def : (def as { query?: string; file?: string; table?: string })?.query ?? null;
          const file = (def as { file?: string })?.file;
          const table = (def as { table?: string })?.table;
          if (q) await reads(q, id);
          if (file) await reads(`SELECT * FROM ${lit(file)}`, id);
          if (table && known.get(table.toLowerCase())) edge(known.get(table.toLowerCase())!, id, 'reads');
        }
        for (const m of JSON.stringify(spec).matchAll(/"from":"([A-Za-z_][\w.]*)"/g)) { const t = known.get(m[1]!.toLowerCase()); if (t) edge(t, id, 'reads'); }
      } else {
        const widgets = await this.db.select().from(this.s.dashboardWidgets).where(eq(this.s.dashboardWidgets.dashboard_id, d.id));
        for (const w of widgets) {
          if (w.saved_query_id) edge(`saved_query:${w.saved_query_id}`, id, 'reads');
          await reads(w.custom_sql, id);
        }
      }
    }
    // Alerts and snapshots.
    const alerts = await this.db.select().from(this.s.alerts).where(eq(this.s.alerts.workspace_id, workspaceId));
    for (const a of alerts) {
      const id = `alert:${a.id}`;
      nodes.set(id, { id, kind: 'alert', label: a.name, detail: a.state, href: `#/alerts/alerts?alert=${a.id}` });
      await reads(a.sql, id);
    }
    // Data apps: Python — a mention of a known table name in the code.
    const apps = await this.db.select().from(this.s.dataApps).where(eq(this.s.dataApps.workspace_id, workspaceId));
    for (const a of apps) {
      const id = `app:${a.id}`;
      nodes.set(id, { id, kind: 'app', label: a.name, detail: a.kind, href: `#/apps/${a.id}` });
      const code = Object.entries(a.files).filter(([f]) => f.endsWith('.py')).map(([, c]) => c).join('\n');
      for (const [name, tid] of known) {
        if (name.includes('.') && known.get(name.split('.').pop()!) === tid) continue;
        const re = new RegExp(`(?:\\bFROM|\\bJOIN|["'\`])\\s*"?${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"?(?:\\b|["'\`])`, 'i');
        if (re.test(code)) edge(tid, id, 'mentions');
      }
    }
    const snaps = await this.db.select().from(this.s.snapshots).where(eq(this.s.snapshots.workspace_id, workspaceId));
    for (const s of snaps) {
      const id = `snapshot:${s.id}`;
      nodes.set(id, { id, kind: 'snapshot', label: s.name, detail: s.format.toUpperCase(), href: '#/alerts/snapshots' });
      edge(s.target.kind === 'dashboard' ? `dashboard:${s.target.dashboard_id}` : `app:${s.target.app_id}`, id, 'renders');
    }
    // Edges only between nodes that exist.
    const out = edges.filter((e) => nodes.has(e.from) && nodes.has(e.to));
    return { nodes: [...nodes.values()], edges: out };
  }

  private async sourceNode(src: SyncSource): Promise<LineageNode | null> {
    if (src.kind === 'connector') {
      const c = (await this.db.select({ name: this.s.connectorConnections.name, connector: this.s.connectorConnections.connector }).from(this.s.connectorConnections).where(eq(this.s.connectorConnections.id, src.connection_id)).limit(1))[0];
      const resource = Object.values(src.resource ?? {}).filter((v) => typeof v === 'string').join('/');
      return { id: `source:${src.connection_id}:${resource}`, kind: 'source', label: `${c?.name ?? 'connection'}${resource ? ` · ${resource}` : ''}`, detail: c?.connector ?? 'connector', href: '#/connections' };
    }
    if (src.kind === 'url') return { id: `file:${src.url}`, kind: 'file', label: src.url.split('/').pop() || src.url, detail: src.url };
    if (src.kind === 'table') return { id: `source:table:${src.catalog ?? ''}.${src.schema}.${src.table}`, kind: 'source', label: `${src.schema}.${src.table}`, detail: 'database table', href: '#/connections' };
    return null;
  }

  // ------------------------------------------------------------------------------------------ OpenLineage

  private async emitSync(syncId: string, runId: string, status: 'running' | 'ok' | 'error', rows: number | null, error: string | null): Promise<void> {
    const sync = (await this.db.select().from(this.s.dataSyncs).where(eq(this.s.dataSyncs.id, syncId)).limit(1))[0];
    if (!sync) return;
    await this.post(this.syncEvent(sync, runId, status, rows, error));
  }

  /** An OpenLineage RunEvent for a sync run (spec 2-0-2). */
  syncEvent(sync: DataSync, runId: string, status: 'running' | 'ok' | 'error', rows: number | null, error: string | null): Record<string, unknown> {
    const ns = this.cfg.lineage.namespace;
    const producer = 'https://github.com/contact-ajmal/DuckView';
    const schemaURL = 'https://openlineage.io/spec/2-0-2/OpenLineage.json#/$defs/RunEvent';
    const src = sync.source;
    const input = src.kind === 'url' ? { namespace: new URL(src.url).origin, name: new URL(src.url).pathname } : src.kind === 'table' ? { namespace: `${ns}:database`, name: `${src.catalog ? `${src.catalog}.` : ''}${src.schema}.${src.table}` } : src.kind === 'connector' ? { namespace: `${ns}:connector:${src.connection_id}`, name: Object.values(src.resource ?? {}).filter((v) => typeof v === 'string').join('/') || 'resource' } : null;
    const output = { namespace: `${ns}:${sync.workspace_id}`, name: `${sync.target_schema}.${sync.target_table}`, ...(status === 'ok' && rows !== null ? { outputFacets: { outputStatistics: { _producer: producer, _schemaURL: 'https://openlineage.io/spec/facets/1-0-2/OutputStatisticsOutputDatasetFacet.json', rowCount: rows } } } : {}) };
    return {
      eventType: status === 'running' ? 'START' : status === 'ok' ? 'COMPLETE' : 'FAIL',
      eventTime: new Date().toISOString(),
      producer,
      schemaURL,
      run: { runId: uuidOf(runId), ...(error ? { facets: { errorMessage: { _producer: producer, _schemaURL: 'https://openlineage.io/spec/facets/1-0-1/ErrorMessageRunFacet.json', message: error, programmingLanguage: 'SQL' } } } : {}) },
      job: { namespace: ns, name: `sync.${sync.name}`, facets: src.kind === 'sql' || sync.transform_sql ? { sql: { _producer: producer, _schemaURL: 'https://openlineage.io/spec/facets/1-1-0/SQLJobFacet.json', query: src.kind === 'sql' ? src.sql : sync.transform_sql } } : {} },
      inputs: input ? [input] : [],
      outputs: [output],
    };
  }

  private async post(event: Record<string, unknown>): Promise<void> {
    const url = this.cfg.lineage.openlineage_url;
    if (!url) return;
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(this.cfg.lineage.openlineage_api_key ? { authorization: `Bearer ${this.cfg.lineage.openlineage_api_key}` } : {}) }, body: JSON.stringify(event), signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`OpenLineage endpoint answered ${res.status}`);
  }
}

/** OpenLineage wants UUIDs; DuckView ids are UUIDs already, anything else is folded into one. */
function uuidOf(id: string): string {
  if (/^[0-9a-f-]{36}$/i.test(id)) return id;
  const h = Buffer.from(id).toString('hex').padEnd(32, '0').slice(0, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
