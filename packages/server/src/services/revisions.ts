/**
 * Version history for what people write in a workspace: notebooks, dashboards (grid layouts and widgets, or Mosaic
 * specs), saved queries, the semantic layer's YAML and dbt projects.
 *
 * Every save calls record(): the object's state is read back and stored as a snapshot. Saves by the same person
 * within ten minutes update that person's latest revision instead of adding one (autosave does not flood the
 * history); a named version, a restore or a Git pull always starts a new one, and identical states are not stored
 * twice. Restoring writes the old state back through the owning service (permissions, validation, audit) and is
 * itself a new revision, so a restore can be undone.
 */
import { and, desc, eq, lt } from 'drizzle-orm';
import YAML from 'yaml';
import type { MetadataStore } from '../db/index.js';
import { REVISION_TYPES, type Revision, type RevisionType } from '../db/schema/sqlite.js';
import { newId } from '../security/crypto.js';
import type { Principal } from './principal.js';
import { requireWrite } from './principal.js';
import type { WorkspaceService } from './workspaces.js';
import type { AuditService } from './audit.js';
import { badRequest, notFound } from './errors.js';

const MERGE_WINDOW_MS = 10 * 60_000;
const KEEP = 200;

export type RevisionSummary = Omit<Revision, 'snapshot'> & { author: string | null };

/** What a revision reads like, for diffs: SQL and text as they are, structure as YAML. */
export function revisionText(type: RevisionType, s: Record<string, unknown>): string {
  switch (type) {
    case 'notebook': {
      const cells = (s.cells as { type: string; name?: string | null; source: string; input?: { kind: string; value: string } | null }[]) ?? [];
      return [`# ${s.title as string}`, ...cells.map((c) => (c.type === 'sql' ? `-- [sql] ${c.name}\n${c.source}` : c.type === 'input' ? `-- [input] ${c.name} (${c.input?.kind}) = ${c.input?.value ?? ''}` : `-- [text]\n${c.source}`))].join('\n\n') + '\n';
    }
    case 'query':
      return `-- ${s.name as string}${s.folder ? ` (${s.folder as string})` : ''}${s.description ? `\n-- ${s.description as string}` : ''}\n${s.sql_text as string}\n`;
    case 'semantic':
      return String(s.yaml ?? '');
    case 'dbt': {
      const files = (s.files as Record<string, string>) ?? {};
      return Object.keys(files).sort().map((f) => `==> ${f} <==\n${files[f]}`).join('\n\n') + '\n';
    }
    case 'dashboard':
      return YAML.stringify(s, { lineWidth: 0 });
  }
}

export class RevisionService {
  /** Writes an old state back (set by the context: the services that own each type). */
  restorers: Partial<Record<RevisionType, (p: Principal, workspaceId: string, objectId: string, snapshot: Record<string, unknown>) => Promise<void>>> = {};

  /** Objects being restored: the owning service's own save must not merge the restore into an older revision. */
  private restoring = new Set<string>();

  constructor(private readonly store: MetadataStore, private readonly workspaces: WorkspaceService, private readonly audit: AuditService) {}
  private get db() {
    return this.store.db;
  }
  private get s() {
    return this.store.schema;
  }

  /** The object's current state, read from the metadata store (null when it no longer exists). */
  async snapshot(workspaceId: string, type: RevisionType, id: string): Promise<Record<string, unknown> | null> {
    switch (type) {
      case 'notebook': {
        const nb = (await this.db.select().from(this.s.notebooks).where(eq(this.s.notebooks.id, id)).limit(1))[0];
        return nb ? { title: nb.title, cells: nb.cells.map(({ output: _o, ...c }) => c) } : null;
      }
      case 'dashboard': {
        const d = (await this.db.select().from(this.s.dashboards).where(eq(this.s.dashboards.id, id)).limit(1))[0];
        if (!d) return null;
        const widgets = await this.db.select().from(this.s.dashboardWidgets).where(eq(this.s.dashboardWidgets.dashboard_id, id));
        return { name: d.name, description: d.description, kind: d.kind, layout: d.layout, spec: d.spec, widgets: widgets.sort((a, b) => a.order_index - b.order_index).map(({ created_at: _c, updated_at: _u, dashboard_id: _d, ...w }) => w) };
      }
      case 'query': {
        const q = (await this.db.select().from(this.s.savedQueries).where(eq(this.s.savedQueries.id, id)).limit(1))[0];
        return q ? { name: q.name, folder: q.folder, description: q.description, sql_text: q.sql_text, tags: q.tags } : null;
      }
      case 'semantic': {
        const row = (await this.db.select().from(this.s.semanticLayers).where(and(eq(this.s.semanticLayers.workspace_id, workspaceId), eq(this.s.semanticLayers.source, 'workspace'))).limit(1))[0];
        return row ? { yaml: row.yaml ?? '' } : null;
      }
      case 'dbt': {
        const pr = (await this.db.select().from(this.s.dbtProjects).where(eq(this.s.dbtProjects.id, id)).limit(1))[0];
        return pr ? { name: pr.name, files: pr.files, vars: pr.vars, target_schema: pr.target_schema } : null;
      }
    }
  }

  /** Records the object's state after a save. Never throws: history must not break saving. */
  async record(actor: string | null | Pick<Principal, 'userId' | 'actorType'>, workspaceId: string, type: RevisionType, id: string, opts: { message?: string | null; named?: boolean } = {}): Promise<Revision | null> {
    const userId = typeof actor === 'string' || actor === null ? actor : actor.userId;
    const actorType = typeof actor === 'string' || actor === null ? 'USER' : actor.actorType;
    if (this.restoring.has(`${type}:${id}`) && !opts.message) return null;
    try {
      const snapshot = await this.snapshot(workspaceId, type, id);
      if (!snapshot) return null;
      const latest = (await this.db.select().from(this.s.revisions).where(and(eq(this.s.revisions.object_type, type), eq(this.s.revisions.object_id, id))).orderBy(desc(this.s.revisions.number)).limit(1))[0];
      const now = new Date();
      if (latest && JSON.stringify(latest.snapshot) === JSON.stringify(snapshot) && !opts.named) return latest;
      // The same person still editing: their latest revision follows along.
      if (latest && !opts.named && !opts.message && !latest.named && !latest.message && latest.user_id === userId && (latest.actor_type ?? 'USER') === actorType && now.getTime() - latest.updated_at.getTime() < MERGE_WINDOW_MS) {
        await this.db.update(this.s.revisions).set({ snapshot, updated_at: now }).where(eq(this.s.revisions.id, latest.id));
        return { ...latest, snapshot, updated_at: now };
      }
      const row: Revision = { id: newId(), workspace_id: workspaceId, object_type: type, object_id: id, number: (latest?.number ?? 0) + 1, snapshot, message: opts.message?.trim().slice(0, 300) || null, named: !!opts.named, user_id: userId, actor_type: actorType, created_at: now, updated_at: now };
      await this.db.insert(this.s.revisions).values(row);
      // Keep the latest KEEP, and every named version.
      const old = await this.db.select({ id: this.s.revisions.id, named: this.s.revisions.named }).from(this.s.revisions).where(and(eq(this.s.revisions.object_type, type), eq(this.s.revisions.object_id, id), lt(this.s.revisions.number, row.number - KEEP + 1)));
      for (const o of old) if (!o.named) await this.db.delete(this.s.revisions).where(eq(this.s.revisions.id, o.id));
      return row;
    } catch {
      return null;
    }
  }

  /** Forgets an object's history (it was deleted). */
  async forget(type: RevisionType, id: string): Promise<void> {
    await this.db.delete(this.s.revisions).where(and(eq(this.s.revisions.object_type, type), eq(this.s.revisions.object_id, id))).catch(() => undefined);
  }

  private check(type: string): RevisionType {
    if (!REVISION_TYPES.includes(type as RevisionType)) throw badRequest(`object_type must be ${REVISION_TYPES.join(', ')}`);
    return type as RevisionType;
  }

  async list(p: Principal, workspaceId: string, type: string, id: string): Promise<RevisionSummary[]> {
    await this.workspaces.get(p, workspaceId);
    const t = this.check(type);
    const rows = await this.db.select().from(this.s.revisions).where(and(eq(this.s.revisions.workspace_id, workspaceId), eq(this.s.revisions.object_type, t), eq(this.s.revisions.object_id, id))).orderBy(desc(this.s.revisions.number)).limit(KEEP + 50);
    const users = await this.db.select({ id: this.s.users.id, email: this.s.users.email, display_name: this.s.users.display_name }).from(this.s.users);
    const name = new Map(users.map((u) => [u.id, u.display_name ?? u.email]));
    return rows.map(({ snapshot: _s, ...r }) => ({ ...r, author: r.user_id ? name.get(r.user_id) ?? null : null }));
  }

  /** One revision with its snapshot, its text, and the current state's text (to diff against). */
  async get(p: Principal, revisionId: string): Promise<{ revision: Revision; text: string; current: string | null }> {
    const r = (await this.db.select().from(this.s.revisions).where(eq(this.s.revisions.id, revisionId)).limit(1))[0];
    if (!r) throw notFound('Revision');
    await this.workspaces.get(p, r.workspace_id);
    const cur = await this.snapshot(r.workspace_id, r.object_type, r.object_id);
    return { revision: r, text: revisionText(r.object_type, r.snapshot), current: cur ? revisionText(r.object_type, cur) : null };
  }

  /** Names the current state ("Before the Q3 rework"). */
  async name(p: Principal, workspaceId: string, type: string, id: string, message: string): Promise<Revision> {
    requireWrite(p);
    await this.workspaces.get(p, workspaceId, 'EDITOR');
    if (!message.trim()) throw badRequest('Give the version a name');
    const r = await this.record(p.userId, workspaceId, this.check(type), id, { message, named: true });
    if (!r) throw notFound('Object');
    this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'revision.name', resource: `${type}:${id}`, ip: p.ip });
    return r;
  }

  /** Writes a revision's state back and records it as a new revision. */
  async restore(p: Principal, revisionId: string): Promise<Revision | null> {
    requireWrite(p);
    const r = (await this.db.select().from(this.s.revisions).where(eq(this.s.revisions.id, revisionId)).limit(1))[0];
    if (!r) throw notFound('Revision');
    await this.workspaces.get(p, r.workspace_id, 'EDITOR');
    const restorer = this.restorers[r.object_type];
    if (!restorer) throw badRequest(`${r.object_type} cannot be restored`);
    // What is there now stays in the history (not merged into the restore).
    await this.record(p.userId, r.workspace_id, r.object_type, r.object_id, { message: 'Before restoring' });
    await this.as(p.userId, r.workspace_id, r.object_type, r.object_id, `Restored version ${r.number}`, () => restorer(p, r.workspace_id, r.object_id, r.snapshot));
    this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'revision.restore', resource: `${r.object_type}:${r.object_id}`, queryText: `version ${r.number}`, ip: p.ip });
    return (await this.db.select().from(this.s.revisions).where(and(eq(this.s.revisions.object_type, r.object_type), eq(this.s.revisions.object_id, r.object_id))).orderBy(desc(this.s.revisions.number)).limit(1))[0] ?? null;
  }

  /**
   * Runs a change (a restore, a Git pull) with the owning service's own recording held back, then records the
   * result as one new revision with this message — so it never merges into someone's in-progress version.
   */
  async as<T>(userId: string | null, workspaceId: string, type: RevisionType, id: string, message: string, fn: () => Promise<T>): Promise<T> {
    const key = `${type}:${id}`;
    this.restoring.add(key);
    try {
      return await fn();
    } finally {
      this.restoring.delete(key);
      await this.record(userId, workspaceId, type, id, { message });
    }
  }
}
