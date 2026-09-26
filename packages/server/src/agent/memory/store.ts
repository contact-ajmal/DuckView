/**
 * The agent's structured memory: what earlier tasks found, kept for later ones. No vector store — rows with a kind,
 * a subject and a sentence, recalled through the Context Engine like any other context object (ranked, budgeted).
 *
 * Permission-aware by construction:
 *  - workspace memories (seen by every member) hold only what every member can already see in the catalog: a
 *    table's columns, which defined metric answered a kind of question. Never values from a result: access
 *    policies can show two members different rows of the same table.
 *  - user memories (seen by their author only) hold the rest: what they built, what failed, suggestions.
 * Canonical definitions are never changed from here; a suggestion only points at where a person can change them.
 */
import { and, desc, eq, or } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import type { AgentMemory, AgentTask } from '../../db/schema/sqlite.js';
import { newId } from '../../security/crypto.js';
import type { Principal } from '../../services/principal.js';
import { forbidden, notFound } from '../../services/errors.js';
import type { ContextObject } from '../context/types.js';

export interface ObservationRow { kind: string; subject: string | null; text: string; data: Record<string, unknown> | null; tool: string | null }

const MAX_PER_WORKSPACE = 500;

export class AgentMemoryStore {
  constructor(private readonly ctx: AppContext) {}
  private get db() {
    return this.ctx.store.db;
  }
  private get s() {
    return this.ctx.store.schema;
  }

  /** Distils a finished task into memories (upserting by scope, kind and subject). */
  async remember(task: AgentTask, observations: ObservationRow[]): Promise<number> {
    const drafts: { scope: 'workspace' | 'user'; kind: string; subject: string | null; text: string }[] = [];
    for (const o of observations) {
      if (o.kind === 'schema' && o.subject && o.tool === 'inspect_schema') drafts.push({ scope: 'workspace', kind: 'discovery', subject: o.subject, text: o.text.slice(0, 600) });
      if (o.kind === 'metric' && o.subject && o.tool === 'query_metrics') drafts.push({ scope: 'workspace', kind: 'discovery', subject: `metric:${o.subject}`, text: `Questions like "${task.request.slice(0, 160)}" are answered with the defined metric ${o.subject}.` });
      if (o.kind === 'error' && o.tool) drafts.push({ scope: 'user', kind: 'failure', subject: `${o.tool}:${o.subject ?? ''}`, text: o.text.slice(0, 400) });
    }
    if (task.status === 'completed') {
      for (const a of task.artifacts.filter((x) => x.href || x.type === 'saved_query')) drafts.push({ scope: 'user', kind: 'outcome', subject: `${a.type}:${a.title}`, text: `Made the ${a.type.replace('_', ' ')} "${a.title}" for "${task.request.slice(0, 160)}".` });
      // A sum or an average written by hand, with no defined metric used: the semantic layer may be missing one.
      const usedMetric = observations.some((o) => o.kind === 'metric' && o.tool === 'query_metrics');
      const sql = observations.map((o) => String(o.data?.sql ?? '')).find((q) => /\b(sum|avg|count)\s*\(/i.test(q));
      if (!usedMetric && sql && !['build', 'transform', 'create', 'modify', 'navigate'].includes(task.intent ?? '')) {
        const agg = /\b(sum|avg|count)\s*\(([^)]{1,60})\)/i.exec(sql);
        const table = /\bfrom\s+([\w."]+)/i.exec(sql)?.[1]?.replace(/"/g, '');
        if (agg && table) drafts.push({ scope: 'user', kind: 'suggestion', subject: `metric-for:${table}:${agg[0].toLowerCase()}`, text: `${agg[0]} on ${table} was computed by hand for "${task.request.slice(0, 120)}". A metric in the semantic layer would make it canonical (Data → Metrics).` });
      }
    }
    let n = 0;
    const now = new Date();
    for (const d of drafts) {
      const owner = d.scope === 'workspace' ? undefined : task.user_id;
      const existing = (await this.db.select().from(this.s.agentMemories).where(and(eq(this.s.agentMemories.workspace_id, task.workspace_id), eq(this.s.agentMemories.scope, d.scope), eq(this.s.agentMemories.kind, d.kind), d.subject ? eq(this.s.agentMemories.subject, d.subject) : eq(this.s.agentMemories.text, d.text), ...(owner ? [eq(this.s.agentMemories.user_id, owner)] : []))).limit(1))[0];
      if (existing) await this.db.update(this.s.agentMemories).set({ text: d.text, source_task_id: task.id, updated_at: now }).where(eq(this.s.agentMemories.id, existing.id));
      else await this.db.insert(this.s.agentMemories).values({ id: newId(), workspace_id: task.workspace_id, user_id: task.user_id, scope: d.scope, kind: d.kind, subject: d.subject, text: d.text, source_task_id: task.id, uses: 0, created_at: now, updated_at: now });
      n++;
    }
    if (n) await this.prune(task.workspace_id);
    return n;
  }

  /** What this person may recall in a workspace: its workspace memories and their own. */
  async visible(p: Principal, workspaceId: string, limit = 200): Promise<AgentMemory[]> {
    await this.ctx.workspaces.get(p, workspaceId);
    return this.db.select().from(this.s.agentMemories).where(and(eq(this.s.agentMemories.workspace_id, workspaceId), or(eq(this.s.agentMemories.scope, 'workspace'), eq(this.s.agentMemories.user_id, p.userId)))).orderBy(desc(this.s.agentMemories.updated_at)).limit(limit);
  }

  /** Memories as context objects, for the Context Engine to rank with everything else. */
  async recall(p: Principal, workspaceId: string): Promise<ContextObject[]> {
    return (await this.visible(p, workspaceId)).map((m) => ({ id: `memory:${m.id}`, type: 'memory', workspaceId, source: `memory:${m.scope}`, title: m.subject ?? m.kind, text: m.text, content: { id: m.id, kind: m.kind, scope: m.scope }, metadata: { boost: m.kind === 'failure' ? 0.9 : 1.1 }, timestamp: m.updated_at.toISOString() }));
  }

  /** Counts that these memories were used (they were selected into a task's context). */
  async used(ids: string[]): Promise<void> {
    for (const id of ids) {
      const m = (await this.db.select({ uses: this.s.agentMemories.uses }).from(this.s.agentMemories).where(eq(this.s.agentMemories.id, id)).limit(1))[0];
      if (m) await this.db.update(this.s.agentMemories).set({ uses: m.uses + 1 }).where(eq(this.s.agentMemories.id, id));
    }
  }

  /** Forgets one: your own, or (as a workspace owner) a workspace memory. */
  async forget(p: Principal, id: string): Promise<void> {
    const m = (await this.db.select().from(this.s.agentMemories).where(eq(this.s.agentMemories.id, id)).limit(1))[0];
    if (!m) throw notFound('Memory');
    const access = await this.ctx.workspaces.get(p, m.workspace_id);
    const mine = m.user_id === p.userId && m.scope === 'user';
    if (!mine && !(m.scope === 'workspace' && (access.role === 'OWNER' || m.user_id === p.userId))) throw forbidden('Only its author or a workspace owner can forget this');
    await this.db.delete(this.s.agentMemories).where(eq(this.s.agentMemories.id, id));
  }

  /** Keeps the most recent memories of a workspace. */
  private async prune(workspaceId: string): Promise<void> {
    const rows = await this.db.select({ id: this.s.agentMemories.id }).from(this.s.agentMemories).where(eq(this.s.agentMemories.workspace_id, workspaceId)).orderBy(desc(this.s.agentMemories.updated_at));
    for (const r of rows.slice(MAX_PER_WORKSPACE)) await this.db.delete(this.s.agentMemories).where(eq(this.s.agentMemories.id, r.id));
  }
}
