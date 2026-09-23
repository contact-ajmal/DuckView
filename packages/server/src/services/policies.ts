/**
 * Row- and column-level security. A policy names a table of a workspace, a row filter (a SQL predicate that may use
 * {{user.email}}, {{user.id}}, {{user.role}} and {{user.groups}}) and column masks (null, redact, hash, partial,
 * or an expression), and the people it applies to (workspace roles, users, teams, or everyone but the owners).
 *
 * Enforcement sits where every query meets the engine: for a person under at least one policy,
 * WorkspaceService.engine() hands out a guarded engine. Its SQL entry points parse the statement with DuckDB's own
 * parser (json_serialize_sql), swap every reference to a protected table for a filtered, masked subquery, and turn
 * the tree back into SQL (json_deserialize_sql) — so the user's joins, aggregates and predicates only ever see the
 * permitted rows and masked values. Around that:
 *  - only SELECT statements (anything else does not serialise, and is refused);
 *  - no data files or table functions (they could read what a table was loaded from), except range / generate_series /
 *    unnest;
 *  - no views that read a protected table (a view expands inside the engine, past the rewrite);
 *  - profiles, overviews, inspections and exports of a protected table run over the same subquery;
 *  - every other engine method is refused, so a new code path cannot leak by forgetting a check;
 *  - result-cache keys include the caller's restriction, so restricted and unrestricted results never mix.
 * Owners of a workspace (and administrators signed in to the UI, who act as owners) are never restricted.
 */
import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { MetadataStore } from '../db/index.js';
import type { AccessPolicy, ColumnMask, PolicySubjects, WorkspaceRole } from '../db/schema/sqlite.js';
import { MASK_KINDS } from '../db/schema/sqlite.js';
import type { WorkspaceEngine } from '../engine/duckdb.js';
import { newId } from '../security/crypto.js';
import type { Principal } from './principal.js';
import { requireWrite } from './principal.js';
import type { WorkspaceService } from './workspaces.js';
import type { GroupService } from './groups.js';
import type { AuditService } from './audit.js';
import { badRequest, forbidden, notFound } from './errors.js';

export interface PolicyInput {
  name?: string;
  description?: string | null;
  table_name?: string;
  row_filter?: string | null;
  column_masks?: Record<string, ColumnMask>;
  applies_to?: PolicySubjects;
  enabled?: boolean;
}

/** Who is asking, as policies see them. */
export interface PolicySubject {
  id: string;
  email: string;
  role: WorkspaceRole | 'EMBED';
  groups: { id: string; name: string }[];
  /** A signed embed's attributes. */
  attrs?: Record<string, string | number | boolean>;
}

/** The policies that apply to one person in one workspace. */
export interface Restriction {
  subject: PolicySubject;
  policies: AccessPolicy[];
  /** Stable for the same policies and person: part of result-cache keys. */
  scope: string;
}

const ALLOWED_TABLE_FUNCTIONS = new Set(['range', 'generate_series', 'unnest']);
const FILE_LIKE = /[/\\]|\.(parquet|csv|tsv|json|jsonl|ndjson|txt|xlsx|arrow|feather|gz|zst|duckdb|db)$|^[a-z0-9]+:\/\//i;
const qi = (s: string) => `"${s.replace(/"/g, '""')}"`;
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** Splits "db.schema.table" / "schema.table" / "table" (quotes allowed). */
export function parseTableName(raw: string): { catalog: string | null; schema: string | null; table: string } {
  const parts: string[] = [];
  const re = /\s*(?:"((?:[^"]|"")*)"|([^."\s]+))\s*(\.|$)/y;
  let m: RegExpExecArray | null;
  let pos = 0;
  while (pos < raw.length && (m = re.exec(raw))) {
    parts.push(m[1] !== undefined ? m[1].replace(/""/g, '"') : m[2]!);
    pos = re.lastIndex;
    if (!m[3]) break;
  }
  if (!parts.length || parts.length > 3 || pos < raw.trim().length) throw badRequest(`"${raw}" is not a table name (table, schema.table or database.schema.table)`);
  const [table, schema = null, catalog = null] = parts.reverse();
  return { catalog, schema, table: table! };
}

export class PolicyService {
  /** Serialised trees and catalog lookups, per engine, for a few seconds (queries come in bursts). */
  private memo = new Map<string, { at: number; value: unknown }>();
  /**
   * Mosaic objects (dataset views, materialised tables) created for one restriction scope: readable by that scope
   * only. Shared Mosaic objects — made from unfiltered data — are never readable under a policy.
   */
  private scoped = new Map<string, string>();

  constructor(private readonly store: MetadataStore, private readonly workspaces: WorkspaceService, private readonly groups: GroupService, private readonly audit: AuditService, private readonly mosaicSchema = 'duckview_mosaic') {}

  private objectKey(catalog: string, name: string): string {
    return `${catalog.toLowerCase()}|${name.toLowerCase()}`;
  }
  /** Records a Mosaic object as built for a restriction scope (its contents are that scope's rows). */
  registerScoped(catalog: string, name: string, scope: string): void {
    this.scoped.set(this.objectKey(catalog, name), scope);
  }
  scopeOf(catalog: string, name: string): string | undefined {
    return this.scoped.get(this.objectKey(catalog, name));
  }
  /** The suffix Mosaic appends to object names for a scope (hex, so the exec shapes still match). */
  static suffix(scope: string): string {
    return scope.slice(0, 8);
  }
  /**
   * The database or schema a reference points into. A two-part name ("x"."t") parses as schema.table but DuckDB
   * resolves it to catalog x when there is such a database — so both fields count; "main" is the default.
   */
  private container(ref: { catalog_name: string; schema_name: string }): string {
    const c = (ref.catalog_name || ref.schema_name || '').toLowerCase();
    return c === 'main' ? '' : c;
  }
  private isMosaicDerived(ref: { catalog_name: string; schema_name: string; table_name: string }): boolean {
    const m = this.mosaicSchema.toLowerCase();
    const parts = [ref.catalog_name.toLowerCase(), ref.schema_name.toLowerCase()];
    return ref.table_name.toLowerCase().startsWith(`${m}_src_`) || parts.includes(`${m}_mem`) || parts.includes(m);
  }
  private get db() {
    return this.store.db;
  }
  private get s() {
    return this.store.schema;
  }

  // ------------------------------------------------------------------------------------------ registry

  private async requireOwner(p: Principal, workspaceId: string): Promise<void> {
    await this.workspaces.get(p, workspaceId, 'OWNER');
  }

  async list(p: Principal, workspaceId: string): Promise<AccessPolicy[]> {
    await this.requireOwner(p, workspaceId);
    return this.byWorkspace(workspaceId);
  }

  private async byWorkspace(workspaceId: string): Promise<AccessPolicy[]> {
    const rows = await this.db.select().from(this.s.accessPolicies).where(eq(this.s.accessPolicies.workspace_id, workspaceId));
    return rows.sort((a, b) => a.table_name.localeCompare(b.table_name) || a.name.localeCompare(b.name));
  }

  async get(p: Principal, id: string): Promise<AccessPolicy> {
    const row = (await this.db.select().from(this.s.accessPolicies).where(eq(this.s.accessPolicies.id, id)).limit(1))[0];
    if (!row) throw notFound('Policy');
    await this.requireOwner(p, row.workspace_id);
    return row;
  }

  private normaliseMasks(masks: Record<string, ColumnMask> | undefined): Record<string, ColumnMask> {
    const out: Record<string, ColumnMask> = {};
    for (const [col, m] of Object.entries(masks ?? {})) {
      if (!col.trim()) continue;
      if (!m || !MASK_KINDS.includes(m.kind)) throw badRequest(`Mask of ${col}: kind must be one of ${MASK_KINDS.join(', ')}`);
      if (m.kind === 'expression') {
        if (!m.sql?.trim()) throw badRequest(`Mask of ${col}: an expression is required`);
        out[col.trim()] = { kind: 'expression', sql: m.sql.trim() };
      } else out[col.trim()] = { kind: m.kind };
    }
    return out;
  }

  private normaliseSubjects(a: PolicySubjects | undefined): PolicySubjects {
    const s = a ?? { roles: ['VIEWER'] };
    const out: PolicySubjects = {};
    if (s.all) out.all = true;
    if (s.embeds) out.embeds = true;
    if (s.roles?.length) {
      const bad = s.roles.find((r) => r !== 'VIEWER' && r !== 'EDITOR');
      if (bad) throw badRequest(`applies_to.roles: ${bad} — owners are never restricted; use VIEWER or EDITOR`);
      out.roles = [...new Set(s.roles)];
    }
    if (s.users?.length) out.users = [...new Set(s.users)];
    if (s.groups?.length) out.groups = [...new Set(s.groups)];
    if (!out.all && !out.embeds && !out.roles && !out.users && !out.groups) throw badRequest('applies_to must name roles, users, teams, embeds, or all');
    return out;
  }

  /** Checks the table, the columns and the filter against the workspace's engine (as the owner). */
  private async validate(p: Principal, workspaceId: string, row: Pick<AccessPolicy, 'table_name' | 'row_filter' | 'column_masks'>): Promise<void> {
    const { engine } = await this.workspaces.engine(p, workspaceId);
    const cols = await this.columnsOf(engine, row.table_name, false);
    if (!cols.length) throw badRequest(`No table or view "${row.table_name}" in this workspace`);
    const names = new Set(cols.map((c) => c.name.toLowerCase()));
    const missing = Object.keys(row.column_masks).find((c) => !names.has(c.toLowerCase()));
    if (missing) throw badRequest(`"${row.table_name}" has no column "${missing}"`);
    const sample: PolicySubject = { id: '00000000-0000-0000-0000-000000000000', email: 'someone@example.com', role: 'VIEWER', groups: [{ id: 'g', name: 'team' }] };
    const sql = `SELECT * FROM (${this.protectedSelect(row as AccessPolicy, cols, sample)}) LIMIT 0`;
    try {
      await engine.runInternal(sql, 30_000);
    } catch (err) {
      throw badRequest(`The policy does not run: ${(err as Error).message.split('\n')[0]}`);
    }
  }

  async create(p: Principal, workspaceId: string, input: PolicyInput): Promise<AccessPolicy> {
    requireWrite(p);
    await this.requireOwner(p, workspaceId);
    const table = (input.table_name ?? '').trim();
    parseTableName(table);
    const now = new Date();
    const row: AccessPolicy = { id: newId(), workspace_id: workspaceId, name: (input.name ?? '').trim().slice(0, 120) || `${table} policy`, description: input.description?.trim() || null, table_name: table, row_filter: input.row_filter?.trim() || null, column_masks: this.normaliseMasks(input.column_masks), applies_to: this.normaliseSubjects(input.applies_to), enabled: input.enabled ?? true, created_by: p.userId, created_at: now, updated_at: now };
    if (!row.row_filter && !Object.keys(row.column_masks).length) throw badRequest('A policy needs a row filter, a column mask, or both');
    await this.validate(p, workspaceId, row);
    await this.db.insert(this.s.accessPolicies).values(row);
    this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'policy.create', resource: `policy:${row.id}`, ip: p.ip });
    return row;
  }

  async update(p: Principal, id: string, patch: PolicyInput): Promise<AccessPolicy> {
    requireWrite(p);
    const cur = await this.get(p, id);
    const set: Partial<AccessPolicy> = { updated_at: new Date() };
    if (patch.name !== undefined) set.name = patch.name.trim().slice(0, 120) || cur.name;
    if (patch.description !== undefined) set.description = patch.description?.trim() || null;
    if (patch.table_name !== undefined) {
      parseTableName(patch.table_name.trim());
      set.table_name = patch.table_name.trim();
    }
    if (patch.row_filter !== undefined) set.row_filter = patch.row_filter?.trim() || null;
    if (patch.column_masks !== undefined) set.column_masks = this.normaliseMasks(patch.column_masks);
    if (patch.applies_to !== undefined) set.applies_to = this.normaliseSubjects(patch.applies_to);
    if (patch.enabled !== undefined) set.enabled = patch.enabled;
    const next = { ...cur, ...set };
    if (!next.row_filter && !Object.keys(next.column_masks).length) throw badRequest('A policy needs a row filter, a column mask, or both');
    if (patch.table_name !== undefined || patch.row_filter !== undefined || patch.column_masks !== undefined) await this.validate(p, cur.workspace_id, next);
    await this.db.update(this.s.accessPolicies).set(set).where(eq(this.s.accessPolicies.id, id));
    this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'policy.update', resource: `policy:${id}`, ip: p.ip });
    return next;
  }

  async remove(p: Principal, id: string): Promise<void> {
    requireWrite(p);
    await this.get(p, id);
    await this.db.delete(this.s.accessPolicies).where(eq(this.s.accessPolicies.id, id));
    this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'policy.delete', resource: `policy:${id}`, ip: p.ip });
  }

  // ------------------------------------------------------------------------------------------ who is restricted

  /** The policies that apply to `p` in a workspace where they have `role`, or null when none do. */
  async restrictionFor(p: Principal, workspaceId: string, role: WorkspaceRole): Promise<Restriction | null> {
    // A signed embed is restricted by the policies for embeds (and for everyone), whoever made its key.
    if (p.embed) {
      const applies = (await this.byWorkspace(workspaceId)).filter((x) => x.enabled && (x.applies_to.all || x.applies_to.embeds));
      if (!applies.length) return null;
      const subject: PolicySubject = { id: `embed:${p.embed.subject}`, email: p.embed.subject, role: 'EMBED', groups: [], attrs: p.embed.attrs };
      const scope = crypto.createHash('sha256').update(JSON.stringify([subject, applies.map((x) => [x.id, x.updated_at.getTime()])])).digest('hex').slice(0, 24);
      return { subject, policies: applies, scope };
    }
    if (role === 'OWNER') return null;
    const all = (await this.byWorkspace(workspaceId)).filter((x) => x.enabled);
    if (!all.length) return null;
    const groupIds = await this.groups.groupIdsFor(p.userId);
    const applies = all.filter((x) => x.applies_to.all || x.applies_to.roles?.includes(role as 'VIEWER' | 'EDITOR') || x.applies_to.users?.includes(p.userId) || x.applies_to.groups?.some((g) => groupIds.includes(g)));
    if (!applies.length) return null;
    const groups = (await this.groups.byIds(groupIds)).map((g) => ({ id: g.id, name: g.name }));
    const subject: PolicySubject = { id: p.userId, email: p.email, role, groups };
    const scope = crypto.createHash('sha256').update(JSON.stringify([subject, applies.map((x) => [x.id, x.updated_at.getTime()])])).digest('hex').slice(0, 24);
    return { subject, policies: applies, scope };
  }

  /** What a member of the workspace may know about their own restrictions (no filter text). */
  async mine(p: Principal, workspaceId: string): Promise<{ restricted: boolean; tables: { table: string; name: string; description: string | null; rows_filtered: boolean; masked_columns: string[] }[] }> {
    const w = await this.workspaces.get(p, workspaceId);
    const r = await this.restrictionFor(p, workspaceId, w.role);
    return { restricted: !!r, tables: (r?.policies ?? []).map((x) => ({ table: x.table_name, name: x.name, description: x.description, rows_filtered: !!x.row_filter, masked_columns: Object.keys(x.column_masks) })) };
  }

  // ------------------------------------------------------------------------------------------ the rewrite

  private remember<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
    const hit = this.memo.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return Promise.resolve(hit.value as T);
    return fn().then((value) => {
      if (this.memo.size > 500) this.memo.clear();
      this.memo.set(key, { at: Date.now(), value });
      return value;
    });
  }

  private async serialize(engine: WorkspaceEngine, sql: string): Promise<{ error?: boolean; error_message?: string; statements?: { node: unknown; named_param_map: unknown }[] }> {
    const rows = await engine.runInternal(`SELECT json_serialize_sql(${lit(sql)}) AS j`, 30_000);
    // u64 "no location" markers exceed JS integers: they are dropped (locations only matter for error messages).
    return JSON.parse(String(rows[0]?.j ?? '{}').replace(/"query_location":\s*\d{17,}/g, '"query_location":0'));
  }

  private async columnsOf(engine: WorkspaceEngine, tableName: string, memo = true): Promise<{ name: string; type: string }[]> {
    const t = parseTableName(tableName);
    const load = async () => {
      const where = [`table_name = ${lit(t.table)}`, t.schema ? `schema_name = ${lit(t.schema)}` : `schema_name = 'main'`, t.catalog ? `database_name = ${lit(t.catalog)}` : `database_name = current_database()`];
      const rows = await engine.runInternal(`SELECT column_name, data_type FROM duckdb_columns() WHERE ${where.join(' AND ')} ORDER BY column_index`, 30_000);
      return rows.map((r) => ({ name: String(r.column_name), type: String(r.data_type) }));
    };
    return memo ? this.remember(`cols:${engine.workspaceId}:${tableName}`, 5000, load) : load();
  }

  private placeholder(filter: string, s: PolicySubject): string {
    return filter
      .replace(/\{\{\s*user\.(email|id|role|groups)\s*\}\}/g, (_, k: string) => (k === 'groups' ? `[${s.groups.map((g) => lit(g.name)).join(', ')}]::VARCHAR[]` : lit(k === 'email' ? s.email : k === 'id' ? s.id : s.role)))
      // A signed attribute; one the token does not carry is NULL (so a filter on it matches nothing).
      .replace(/\{\{\s*embed\.([A-Za-z_][\w]*)\s*\}\}/g, (_, k: string) => {
        const v = s.attrs?.[k];
        return v === undefined || v === null ? 'NULL' : typeof v === 'number' ? String(v) : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : lit(String(v));
      });
  }

  private maskExpr(col: { name: string; type: string }, m: ColumnMask | undefined): string {
    const c = qi(col.name);
    if (!m) return c;
    switch (m.kind) {
      case 'null':
        return `CAST(NULL AS ${col.type}) AS ${c}`;
      case 'redact':
        return `CASE WHEN ${c} IS NULL THEN NULL ELSE '••••' END AS ${c}`;
      case 'hash':
        return `CASE WHEN ${c} IS NULL THEN NULL ELSE md5(CAST(${c} AS VARCHAR)) END AS ${c}`;
      case 'partial':
        return `CASE WHEN ${c} IS NULL THEN NULL ELSE repeat('•', greatest(length(CAST(${c} AS VARCHAR)) - 4, 0)) || right(CAST(${c} AS VARCHAR), 4) END AS ${c}`;
      case 'expression':
        return `(${m.sql}) AS ${c}`;
    }
  }

  /** The subquery that replaces a protected table: its columns (masked) and its rows (filtered). */
  protectedSelect(p: AccessPolicy, cols: { name: string; type: string }[], s: PolicySubject): string {
    const t = parseTableName(p.table_name);
    const from = [t.catalog, t.schema, t.table].filter((x): x is string => !!x).map(qi).join('.');
    const masks = new Map(Object.entries(p.column_masks).map(([k, v]) => [k.toLowerCase(), v]));
    const list = cols.map((c) => this.maskExpr(c, masks.get(c.name.toLowerCase()))).join(', ');
    return `SELECT ${list} FROM ${from}${p.row_filter ? ` WHERE (${this.placeholder(p.row_filter, s)})` : ''}`;
  }

  /**
   * Whether a reference can mean the policy's table, resolving names the way DuckDB does: no catalog is the current
   * database, and a two-part name is schema.table in it — or catalog.table (schema main) of an attached database.
   */
  private matches(policy: AccessPolicy, ref: { catalog_name: string; schema_name: string; table_name: string }, currentDb: string): boolean {
    const t = parseTableName(policy.table_name);
    if (t.table.toLowerCase() !== ref.table_name.toLowerCase()) return false;
    const want = { cat: (t.catalog ?? currentDb).toLowerCase(), sch: (t.schema ?? 'main').toLowerCase() };
    const cur = currentDb.toLowerCase();
    const cands = ref.catalog_name ? [{ cat: ref.catalog_name.toLowerCase(), sch: (ref.schema_name || 'main').toLowerCase() }] : ref.schema_name ? [{ cat: cur, sch: ref.schema_name.toLowerCase() }, { cat: ref.schema_name.toLowerCase(), sch: 'main' }] : [{ cat: cur, sch: 'main' }];
    return cands.some((c) => c.cat === want.cat && c.sch === want.sch);
  }

  private currentDatabase(engine: WorkspaceEngine): Promise<string> {
    return this.remember(`db:${engine.workspaceId}`, 60_000, async () => String((await engine.runInternal('SELECT current_database() AS d', 10_000))[0]?.d ?? ''));
  }

  /** Views of the workspace that read (directly or through other views) a protected table. */
  private async taintedViews(engine: WorkspaceEngine, r: Restriction): Promise<Set<string>> {
    return this.remember(`views:${engine.workspaceId}:${r.scope}`, 5000, async () => {
      const views = await engine.runInternal(`SELECT schema_name, view_name, sql FROM duckdb_views() WHERE NOT internal AND database_name = current_database()`, 30_000);
      const refs = new Map<string, string[]>();
      for (const v of views) {
        const key = `${String(v.schema_name).toLowerCase()}.${String(v.view_name).toLowerCase()}`;
        const body = /\bAS\s+((?:SELECT|WITH|FROM|VALUES|\()[\s\S]*)$/i.exec(String(v.sql))?.[1]?.replace(/;\s*$/, '');
        const tree = body ? await this.serialize(engine, body).catch(() => null) : null;
        if (!tree || tree.error) {
          refs.set(key, ['*unreadable*']);
          continue;
        }
        const found: string[] = [];
        walk(tree.statements, (n) => {
          if (n.type === 'BASE_TABLE') found.push(`${String(n.schema_name || 'main').toLowerCase()}.${String(n.table_name).toLowerCase()}`);
        });
        refs.set(key, found);
      }
      const protectedKeys = new Set(r.policies.map((x) => { const t = parseTableName(x.table_name); return `${(t.schema ?? 'main').toLowerCase()}.${t.table.toLowerCase()}`; }));
      const tainted = new Set<string>();
      let grew = true;
      while (grew) {
        grew = false;
        for (const [view, deps] of refs) if (!tainted.has(view) && deps.some((d) => d === '*unreadable*' || protectedKeys.has(d) || tainted.has(d))) { tainted.add(view); grew = true; }
      }
      return tainted;
    });
  }

  /** Rewrites a statement for a restricted person, or refuses it. */
  async rewrite(engine: WorkspaceEngine, sql: string, r: Restriction): Promise<string> {
    const tree = await this.serialize(engine, sql);
    if (tree.error) {
      if (/only select/i.test(tree.error_message ?? '')) throw forbidden('Access policies apply to you in this workspace: only SELECT queries are allowed');
      throw badRequest(tree.error_message ?? 'The query could not be parsed');
    }
    const tainted = await this.taintedViews(engine, r);
    const currentDb = await this.currentDatabase(engine);
    const subqueries = new Map<string, unknown>();
    const replacement = async (n: Record<string, unknown>): Promise<Record<string, unknown> | null> => {
      const ref = { catalog_name: String(n.catalog_name ?? ''), schema_name: String(n.schema_name ?? ''), table_name: String(n.table_name ?? '') };
      const owner = this.scopeOf(this.container(ref), ref.table_name);
      if (owner !== undefined) {
        if (owner === r.scope) return null; // built from this person's rows
        throw forbidden(`Access policies apply to you in this workspace: ${ref.table_name} was built for someone else`);
      }
      if (this.isMosaicDerived(ref)) throw forbidden('Access policies apply to you in this workspace: shared Mosaic objects (pre-aggregates, materialised datasets) are not available');
      // Every policy that applies to this person on this table counts: filters are AND-ed, masks merged.
      const policy = combinePolicies(r.policies.filter((x) => this.matches(x, ref, currentDb)));
      if (policy) {
        if (n.at_clause) throw forbidden(`${ref.table_name} is protected by an access policy: time travel (AT) is not allowed`);
        let sub = subqueries.get(policy.id);
        if (!sub) {
          const cols = await this.columnsOf(engine, policy.table_name);
          const t = await this.serialize(engine, this.protectedSelect(policy, cols, r.subject));
          if (t.error || !t.statements?.[0]) throw badRequest(`Access policy "${policy.name}" does not run: ${t.error_message ?? 'no statement'}`);
          sub = t.statements[0];
          subqueries.set(policy.id, sub);
        }
        return { type: 'SUBQUERY', alias: n.alias || ref.table_name, sample: n.sample ?? null, query_location: 0, subquery: structuredClone(sub), column_name_alias: n.column_name_alias ?? [] };
      }
      if (FILE_LIKE.test(ref.table_name) && !ref.schema_name) throw forbidden(`Access policies apply to you in this workspace: read tables, not files (${ref.table_name})`);
      if (tainted.has(`${(ref.schema_name || 'main').toLowerCase()}.${ref.table_name.toLowerCase()}`)) throw forbidden(`Access policies apply to you in this workspace: the view ${ref.table_name} reads a protected table — query the table itself`);
      return null;
    };
    const visit = async (node: unknown): Promise<void> => {
      if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) {
          const v = node[i];
          if (isNode(v, 'BASE_TABLE')) { const rep = await replacement(v); if (rep) { node[i] = rep; continue; } }
          checkFunction(v);
          await visit(v);
        }
      } else if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
          if (isNode(v, 'BASE_TABLE')) { const rep = await replacement(v); if (rep) { (node as Record<string, unknown>)[k] = rep; continue; } }
          checkFunction(v);
          await visit(v);
        }
      }
    };
    await visit(tree.statements);
    const rows = await engine.runInternal(`SELECT json_deserialize_sql(${lit(JSON.stringify({ error: false, statements: tree.statements }))}) AS s`, 30_000);
    return String(rows[0]?.s ?? '');
  }

  /** A relation target (table name, file, or query) for profiles and inspections, rewritten or refused. */
  async rewriteTarget(engine: WorkspaceEngine, target: string, r: Restriction): Promise<string> {
    const t = target.trim();
    if (/^(select|with|from|values|\()/i.test(t)) return this.rewrite(engine, t, r);
    const rel = engine.resolveRelation(t);
    if (rel.kind === 'file' || rel.kind === 'remote') throw forbidden('Access policies apply to you in this workspace: read tables, not files');
    return this.rewrite(engine, `SELECT * FROM ${rel.relation}`, r);
  }

  /** The engine as a restricted person may use it. */
  guard(engine: WorkspaceEngine, r: Restriction): WorkspaceEngine {
    const self = this;
    const passthrough = new Set(['workspaceId', 'jail', 'catalog', 'lakehouseTree', 'memoryStats', 'version', 'hasExtension', 'activeQueryCount', 'attachErrors', 'memoryLimit', 'threads', 'tempDirectory', 'externalAccess', 'fingerprint', 'createdAt', 'runInternal', 'resolveRelation', 'applySecrets', 'applyAttachments', 'retryAttachment']);
    return new Proxy(engine, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof prop !== 'string') return value;
        switch (prop) {
          case 'execute':
            return async (sql: string, opts?: unknown) => target.execute(await self.rewrite(target, sql, r), opts as never);
          case 'stream':
            return async (sql: string, handlers: unknown, opts?: unknown) => target.stream(await self.rewrite(target, sql, r), handlers as never, opts as never);
          case 'explain':
            return async (sql: string, opts?: unknown) => target.explain(await self.rewrite(target, sql, r), opts as never);
          case 'exportTo':
            return async (sql: string, format: unknown, out: string, opts?: unknown) => target.exportTo(await self.rewrite(target, sql, r), format as never, out, opts as never);
          case 'summarize':
          case 'overview':
          case 'inspect':
            return async (t: string, opts?: unknown) => (target[prop] as (t: string, o?: unknown) => Promise<unknown>).call(target, await self.rewriteTarget(target, t, r), opts);
        }
        if (typeof value !== 'function' || passthrough.has(prop)) return typeof value === 'function' ? value.bind(target) : value;
        return () => {
          throw forbidden(`Access policies apply to you in this workspace: ${prop} is not available`);
        };
      },
    });
  }
}

function isNode(v: unknown, type: string): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v) && (v as { type?: unknown }).type === type;
}

function checkFunction(v: unknown): void {
  if (isNode(v, 'TABLE_FUNCTION')) {
    const name = String(((v as { function?: { function_name?: string } }).function?.function_name ?? '')).toLowerCase();
    if (!ALLOWED_TABLE_FUNCTIONS.has(name)) throw forbidden(`Access policies apply to you in this workspace: the table function ${name}() is not available`);
  }
}

/** Visits every object node of a serialised tree. */
function walk(node: unknown, fn: (n: Record<string, unknown>) => void): void {
  if (Array.isArray(node)) for (const v of node) walk(v, fn);
  else if (node && typeof node === 'object') {
    fn(node as Record<string, unknown>);
    for (const v of Object.values(node)) walk(v, fn);
  }
}

/** How strict a mask is, for two policies masking one column: the stricter wins. */
const MASK_STRICTNESS: Record<string, number> = { null: 5, redact: 4, hash: 3, partial: 2, expression: 1 };

/**
 * One effective policy from all the policies that apply to a person on a table (null when none): a row passes only
 * if it passes every filter, and a column masked by several policies gets the strictest of their masks.
 */
export function combinePolicies(policies: AccessPolicy[]): AccessPolicy | null {
  if (!policies.length) return null;
  if (policies.length === 1) return policies[0]!;
  const filters = policies.map((x) => x.row_filter).filter((f): f is string => !!f);
  const masks: Record<string, ColumnMask> = {};
  for (const x of policies) {
    for (const [col, m] of Object.entries(x.column_masks)) {
      const cur = Object.entries(masks).find(([c]) => c.toLowerCase() === col.toLowerCase());
      if (!cur) masks[col] = m;
      else if ((MASK_STRICTNESS[m.kind] ?? 0) > (MASK_STRICTNESS[cur[1].kind] ?? 0)) masks[cur[0]] = m;
    }
  }
  return { ...policies[0]!, id: policies.map((x) => x.id).join('+'), name: policies.map((x) => x.name).join(' + '), row_filter: filters.length ? filters.map((f) => `(${f})`).join(' AND ') : null, column_masks: masks };
}
