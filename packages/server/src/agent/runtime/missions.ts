/**
 * Missions: the unit of agent work the Agent Home and the Analyst WebUI show. A mission is an agent session — its
 * intent (mode), the datasets the person chose, its tasks, plan, artifacts and approvals — with a status and a
 * progress derived from its tasks. Nothing here runs the agent: it reads and reshapes what the AgentRuntime keeps,
 * and starts tasks through it.
 *
 * Sharing never widens access. A mission shared with the workspace is visible to its members, but:
 *  - its result rows, answers and findings were computed under its owner's access. A member who is restricted by an
 *    access policy in that workspace sees the steps and the SQL, not those values, and can re-run any result as
 *    themselves (runArtifact), under their own policies;
 *  - opening an artifact in the console is checked per person (canOpen), and the console checks it again.
 */
import { and, desc, eq, inArray, or } from 'drizzle-orm';
import type { AppContext } from '../../context.js';
import type { AgentArtifact, AgentSession, AgentTask, AgentTaskStatus } from '../../db/schema/sqlite.js';
import type { Principal } from '../../services/principal.js';
import { canWrite, isPlatformAdmin } from '../../services/principal.js';
import { badRequest, forbidden, notFound } from '../../services/errors.js';
import { analyzeSql } from '../../engine/sql-guard.js';
import type { AgentMode, AgentRuntime, StartTaskInput } from './runtime.js';

export type MissionStatus = AgentTaskStatus | 'new';

export interface MissionSummary {
  id: string;
  workspace_id: string;
  title: string;
  mode: string;
  status: MissionStatus;
  /** 0–100, from the latest task's plan; 100 once it completed. */
  progress: number;
  /** The step being worked on, or the latest outcome, in words. */
  activity: string | null;
  datasets: string[];
  artifacts: { total: number; kinds: string[] };
  tasks: number;
  visibility: string;
  owner: { id: string; mine: boolean };
  archived: boolean;
  created_at: string;
  updated_at: string;
}

/** What a person may do in a workspace, from the permissions DuckView already enforces (never a second system). */
export interface Capabilities {
  workspace_id: string;
  role: 'VIEWER' | 'EDITOR' | 'OWNER';
  /** viewer, analyst, engineer or admin — how much of the console to offer. */
  persona: 'viewer' | 'analyst' | 'engineer' | 'admin';
  can_write: boolean;
  console: { data: boolean; sql: 'read' | 'write'; notebooks: 'view' | 'edit'; dashboards: 'view' | 'edit'; semantic: 'view' | 'edit'; quality: 'view' | 'edit'; dbt: boolean; apps: 'view' | 'edit'; connections: boolean; mcp: boolean; admin: boolean };
  agent: { approve: boolean; export: boolean };
}

const ACTIVE: ReadonlySet<string> = new Set(['planning', 'running', 'waiting_approval']);

export function progressOf(t: AgentTask | undefined): number {
  if (!t) return 0;
  if (t.status === 'completed') return 100;
  if (!t.plan.length) return t.status === 'planning' ? 5 : 10;
  const done = t.plan.filter((s) => s.status === 'done').length;
  const active = t.plan.some((s) => s.status === 'active') ? 0.5 : 0;
  return Math.min(95, Math.max(5, Math.round(((done + active) / t.plan.length) * 100)));
}

function activityOf(t: AgentTask | undefined): string | null {
  if (!t) return null;
  if (t.status === 'waiting_approval') return 'Waiting for approval';
  if (t.status === 'failed') return t.error ? `Failed: ${t.error.split('\n')[0]!.slice(0, 120)}` : 'Failed';
  if (t.status === 'cancelled') return 'Cancelled';
  if (t.status === 'completed') return t.answer ? t.answer.replace(/[#*`_>]/g, '').split('\n').find((l) => l.trim())?.trim().replace(/^(?:[-•]|\d+[.)])\s+/, '').slice(0, 140) ?? 'Done' : 'Done';
  return t.plan.find((s) => s.status === 'active')?.text ?? 'Working';
}

export class MissionService {
  constructor(private readonly ctx: AppContext, private readonly rt: AgentRuntime) {}
  private get db() {
    return this.ctx.store.db;
  }
  private get s() {
    return this.ctx.store.schema;
  }

  // ------------------------------------------------------------------------------------------ capabilities

  async capabilities(p: Principal, workspaceId: string): Promise<Capabilities> {
    const w = await this.ctx.workspaces.get(p, workspaceId);
    const write = canWrite(p) && w.role !== 'VIEWER';
    const admin = isPlatformAdmin(p);
    const persona: Capabilities['persona'] = admin ? 'admin' : !write ? 'viewer' : w.role === 'OWNER' ? 'engineer' : 'analyst';
    const edit = write ? ('edit' as const) : ('view' as const);
    return {
      workspace_id: workspaceId,
      role: w.role,
      persona,
      can_write: write,
      // SQL stays readable for viewers: the workbench runs their statements read-only, as it always has.
      console: { data: true, sql: write ? 'write' : 'read', notebooks: edit, dashboards: edit, semantic: edit, quality: edit, dbt: write, apps: edit, connections: write, mcp: p.scopes.includes('mcp') || p.via !== 'token', admin },
      agent: { approve: write && p.via !== 'token' && p.actorType === 'USER', export: write },
    };
  }

  // ------------------------------------------------------------------------------------------ listing

  /** The person's missions, and the ones shared with the workspace; newest first. */
  async list(p: Principal, workspaceId: string | null, opts: { status?: 'active' | 'recent' | 'archived'; limit?: number } = {}): Promise<MissionSummary[]> {
    let wsIds: string[];
    if (workspaceId) {
      await this.ctx.workspaces.get(p, workspaceId);
      wsIds = [workspaceId];
    } else wsIds = (await this.ctx.workspaces.list(p)).map((w) => w.id).filter((id) => !p.workspaceScope || id === p.workspaceScope);
    if (!wsIds.length) return [];
    const visible = or(eq(this.s.agentSessions.user_id, p.userId), eq(this.s.agentSessions.visibility, 'workspace'));
    const rows = await this.db.select().from(this.s.agentSessions).where(and(inArray(this.s.agentSessions.workspace_id, wsIds), visible, eq(this.s.agentSessions.archived, opts.status === 'archived'))).orderBy(desc(this.s.agentSessions.updated_at)).limit(Math.min(opts.limit ?? 50, 200));
    const summaries = await this.summarize(p, rows);
    if (opts.status === 'active') return summaries.filter((m) => ACTIVE.has(m.status));
    return summaries;
  }

  /** Whether an access policy restricts this person in a workspace (then others' results are not shown to them). */
  private async restrictedIn(p: Principal, workspaceId: string, memo: Map<string, boolean>): Promise<boolean> {
    if (!memo.has(workspaceId)) {
      const access = await this.ctx.workspaces.get(p, workspaceId);
      memo.set(workspaceId, !!(await this.ctx.policies.restrictionFor(p, workspaceId, access.role)));
    }
    return memo.get(workspaceId)!;
  }

  private async summarize(p: Principal, rows: AgentSession[]): Promise<MissionSummary[]> {
    if (!rows.length) return [];
    const tasks = await this.db.select().from(this.s.agentTasks).where(inArray(this.s.agentTasks.session_id, rows.map((r) => r.id)));
    const memo = new Map<string, boolean>();
    const hide = new Set<string>();
    for (const r of rows) if (r.user_id !== p.userId && (await this.restrictedIn(p, r.workspace_id, memo))) hide.add(r.id);
    return rows.map((r) => {
      const mine = tasks.filter((t) => t.session_id === r.id).sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
      const last = mine.at(-1);
      const artifacts = mine.flatMap((t) => t.artifacts).filter((a) => a.type !== 'finding');
      return {
        id: r.id,
        workspace_id: r.workspace_id,
        title: r.title,
        mode: r.mode,
        status: last?.status ?? 'new',
        progress: progressOf(last),
        // The latest answer's first line is someone else's result: not for a viewer whom a policy restricts.
        activity: hide.has(r.id) && last?.status === 'completed' ? 'Completed' : activityOf(last),
        datasets: r.datasets,
        artifacts: { total: artifacts.length, kinds: [...new Set(artifacts.map((a) => a.type))] },
        tasks: mine.length,
        visibility: r.visibility,
        owner: { id: r.user_id, mine: r.user_id === p.userId },
        archived: r.archived,
        created_at: r.created_at.toISOString(),
        updated_at: r.updated_at.toISOString(),
      };
    });
  }

  // ------------------------------------------------------------------------------------------ one mission

  /** A mission the person may see: their own, or one shared with a workspace they belong to. */
  private async visibleSession(p: Principal, id: string): Promise<AgentSession> {
    const s = (await this.db.select().from(this.s.agentSessions).where(eq(this.s.agentSessions.id, id)).limit(1))[0];
    if (!s) throw notFound('Mission');
    if (p.workspaceScope && p.workspaceScope !== s.workspace_id) throw notFound('Mission');
    if (s.user_id !== p.userId && s.visibility !== 'workspace') throw notFound('Mission');
    await this.ctx.workspaces.get(p, s.workspace_id).catch(() => {
      throw notFound('Mission');
    });
    return s;
  }

  private async own(p: Principal, id: string): Promise<AgentSession> {
    const s = await this.visibleSession(p, id);
    if (s.user_id !== p.userId) throw forbidden('Only the person who started this mission can change it');
    return s;
  }

  async get(p: Principal, id: string) {
    const s = await this.visibleSession(p, id);
    const tasks = await this.db.select().from(this.s.agentTasks).where(eq(this.s.agentTasks.session_id, id)).orderBy(this.s.agentTasks.created_at);
    const mine = s.user_id === p.userId;
    // Someone else's results were computed under their access: hide the values from a viewer whom a policy restricts.
    const access = mine ? null : await this.ctx.workspaces.get(p, s.workspace_id);
    const restricted = !mine && access && !!(await this.ctx.policies.restrictionFor(p, s.workspace_id, access.role));
    const caps = await this.capabilities(p, s.workspace_id);
    const shown = tasks.map((t) => (restricted ? redact(t) : t)).map((t) => ({ ...t, artifacts: t.artifacts.map((a) => ({ ...a, open: this.openability(a, caps) })) }));
    const discovered = [...new Set(tasks.flatMap((t) => t.artifacts).filter((a) => a.type === 'dataset').map((a) => a.title))].filter((d) => !s.datasets.includes(d));
    const [summary] = await this.summarize(p, [s]);
    return { ...summary!, page: s.page, tasks: shown, context: { explicit: s.datasets, discovered }, restricted: !!restricted, capabilities: caps };
  }

  /** Whether this person can open the artifact in the console, and why not. */
  private openability(a: AgentArtifact, c: Capabilities): { allowed: boolean; reason: string | null } {
    const deny = (reason: string) => ({ allowed: false, reason });
    switch (a.type) {
      case 'dbt_model':
        return c.console.dbt ? { allowed: true, reason: null } : deny('You can see this result, but not the dbt project it lives in.');
      case 'table':
      case 'sql':
      case 'saved_query':
        return { allowed: true, reason: c.console.sql === 'read' ? 'Opens read-only: your access to this workspace is view only.' : null };
      default:
        return { allowed: true, reason: null };
    }
  }

  // ------------------------------------------------------------------------------------------ lifecycle

  /** Starts a mission: a session with its intent and datasets, and its first task. */
  async start(p: Principal, input: { workspaceId: string; request: string; mode?: AgentMode; datasets?: string[]; title?: string | null; page?: StartTaskInput['page']; via: StartTaskInput['via']; byok?: StartTaskInput['byok'] }) {
    const session = await this.rt.createSession(p, input.workspaceId, { title: input.title?.trim() || input.request.slice(0, 80), via: input.via, page: input.page ?? null, mode: input.mode ?? 'auto', datasets: input.datasets ?? [] });
    const task = await this.rt.start(p, { workspaceId: input.workspaceId, sessionId: session.id, request: input.request, mode: input.mode, page: input.page ?? null, via: input.via, byok: input.byok, datasets: input.datasets ?? null });
    return { mission: await this.get(p, session.id), task };
  }

  /** Continues a mission: a new request, or (without one) carry on from where it stopped. */
  async resume(p: Principal, id: string, input: { request?: string | null; datasets?: string[] | null; mode?: AgentMode; via: StartTaskInput['via']; byok?: StartTaskInput['byok'] }) {
    const s = await this.own(p, id);
    const tasks = await this.db.select().from(this.s.agentTasks).where(eq(this.s.agentTasks.session_id, id)).orderBy(desc(this.s.agentTasks.created_at)).limit(1);
    if (tasks[0] && ACTIVE.has(tasks[0].status)) throw badRequest(tasks[0].status === 'waiting_approval' ? 'The mission is waiting for an approval' : 'The mission is still working');
    const request = input.request?.trim() || (tasks[0] ? `Continue the mission "${s.title}" from where it stopped${tasks[0].status === 'failed' ? ` (it failed: ${tasks[0].error ?? 'unknown error'})` : ''}.` : s.title);
    const task = await this.rt.start(p, { workspaceId: s.workspace_id, sessionId: id, request, mode: input.mode ?? (s.mode as AgentMode), via: input.via, byok: input.byok, datasets: input.datasets ?? null });
    return { mission: await this.get(p, id), task };
  }

  async cancel(p: Principal, id: string) {
    await this.own(p, id);
    const running = (await this.db.select().from(this.s.agentTasks).where(eq(this.s.agentTasks.session_id, id))).filter((t) => ACTIVE.has(t.status));
    for (const t of running) await this.rt.cancel(p, t.id);
    return this.get(p, id);
  }

  /** A copy to run again: the title, intent and datasets, no tasks. */
  async duplicate(p: Principal, id: string) {
    const s = await this.visibleSession(p, id);
    const copy = await this.rt.createSession(p, s.workspace_id, { title: `${s.title} (copy)`.slice(0, 200), via: 'ui', page: s.page, mode: s.mode as AgentMode, datasets: s.datasets });
    return this.get(p, copy.id);
  }

  async update(p: Principal, id: string, patch: { title?: string; archived?: boolean; visibility?: 'private' | 'workspace' }) {
    await this.own(p, id);
    await this.db.update(this.s.agentSessions).set({ ...(patch.title !== undefined ? { title: patch.title.trim().slice(0, 200) || 'Mission' } : {}), ...(patch.archived !== undefined ? { archived: patch.archived } : {}), ...(patch.visibility !== undefined ? { visibility: patch.visibility } : {}), updated_at: new Date() }).where(eq(this.s.agentSessions.id, id));
    return this.get(p, id);
  }

  // ------------------------------------------------------------------------------------------ artifacts

  /** Artifacts of the person's missions (and shared ones), newest first. */
  async artifacts(p: Principal, workspaceId: string | null, limit = 60) {
    const missions = await this.list(p, workspaceId, { limit: 100 });
    if (!missions.length) return [];
    const tasks = await this.db.select().from(this.s.agentTasks).where(inArray(this.s.agentTasks.session_id, missions.map((m) => m.id)));
    const byMission = new Map(missions.map((m) => [m.id, m]));
    return tasks
      .flatMap((t) => t.artifacts.filter((a) => a.type !== 'finding' && a.type !== 'dataset').map((a) => ({ ...(t.user_id === p.userId ? a : { ...a, data: a.type === 'table' ? { ...a.data, rows: [], redacted: true } : a.data }), mission: { id: t.session_id, title: byMission.get(t.session_id)?.title ?? '' }, workspace_id: t.workspace_id })))
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice(0, limit);
  }

  /** One artifact, found in a mission the person can see. */
  async artifact(p: Principal, artifactId: string) {
    const missions = await this.list(p, null, { limit: 200 });
    const tasks = missions.length ? await this.db.select().from(this.s.agentTasks).where(inArray(this.s.agentTasks.session_id, missions.map((m) => m.id))) : [];
    for (const t of tasks) {
      const a = t.artifacts.find((x) => x.id === artifactId);
      if (a) return { artifact: a, task: t };
    }
    throw notFound('Artifact');
  }

  /** Re-runs a result's SQL as this person: their access, their policies — how a shared result is seen safely. */
  async runArtifact(p: Principal, artifactId: string, maxRows = 200) {
    const { artifact, task } = await this.artifact(p, artifactId);
    const sql = typeof artifact.data?.sql === 'string' ? artifact.data.sql : null;
    if (!sql) throw badRequest('This artifact has no query to run');
    const a = analyzeSql(sql);
    if (a.isMutating) throw badRequest('Only a read-only query can be re-run');
    const r = await this.ctx.queries.run(p, task.workspace_id, sql, { maxRows: Math.min(maxRows, 1000) });
    return { columns: r.columns, rows: r.rows, row_count: r.rows.length, sql };
  }

  // ------------------------------------------------------------------------------------------ pickers

  /** Workspaces the person can reach, with their role and what they hold. */
  async workspaces(p: Principal) {
    const list = (await this.ctx.workspaces.list(p)).filter((w) => !p.workspaceScope || w.id === p.workspaceScope);
    const recent = await this.db.select({ workspace_id: this.s.agentSessions.workspace_id, at: this.s.agentSessions.updated_at }).from(this.s.agentSessions).where(eq(this.s.agentSessions.user_id, p.userId)).orderBy(desc(this.s.agentSessions.updated_at)).limit(200);
    const lastAgent = new Map<string, Date>();
    for (const r of recent) if (!lastAgent.has(r.workspace_id)) lastAgent.set(r.workspace_id, r.at);
    return list.map((w) => ({
      id: w.id,
      name: w.name,
      description: w.description ?? null,
      role: w.role,
      environment: w.tags.find((t) => /^(prod|production|staging|dev|development|test)$/i.test(t)) ?? null,
      tags: w.tags,
      shared: w.shared,
      members: w.member_count,
      last_agent_activity: lastAgent.get(w.id)?.toISOString() ?? null,
    }));
  }

  /** The datasets of a workspace the person can see: tables, views, files and semantic models, with recent and recommended ones. */
  async datasets(p: Principal, workspaceId: string, q = '') {
    const objects = await this.ctx.contextEngine.discover(p, workspaceId);
    const want = q.trim().toLowerCase();
    const all = objects
      .filter((o) => o.type === 'table' || o.type === 'view' || o.type === 'file' || o.type === 'semantic_model')
      .filter((o) => !want || o.title.toLowerCase().includes(want) || o.text.toLowerCase().includes(want))
      .map((o) => ({ name: o.title, kind: o.type, rows: (o.metadata.rows as number | null | undefined) ?? null, columns: Array.isArray((o.content as { columns?: unknown[] } | null)?.columns) ? ((o.content as { columns: unknown[] }).columns.length) : null, description: o.text.split(' — ')[1]?.split('\n')[0] ?? null, tags: (o.metadata.tags as string[] | undefined) ?? [], selectable: o.type !== 'semantic_model', relation: o.type === 'semantic_model' ? String((o.content as { relation?: string }).relation ?? '') : null }));
    // Recent: what the person's missions here used; recommended: what the semantic layer builds on.
    const sessions = await this.db.select({ datasets: this.s.agentSessions.datasets }).from(this.s.agentSessions).where(and(eq(this.s.agentSessions.user_id, p.userId), eq(this.s.agentSessions.workspace_id, workspaceId))).orderBy(desc(this.s.agentSessions.updated_at)).limit(30);
    const names = new Set(all.filter((d) => d.selectable).map((d) => d.name));
    const recent = [...new Set(sessions.flatMap((s) => s.datasets))].filter((d) => names.has(d)).slice(0, 6);
    const recommended = [...new Set(all.filter((d) => d.kind === 'semantic_model' && d.relation).map((d) => d.relation!.replace(/^main\./, '')))].filter((d) => names.has(d) && !recent.includes(d)).slice(0, 6);
    return { datasets: all.slice(0, 500), recent, recommended, total: all.length };
  }
}

/** A task as a restricted viewer of someone else's mission sees it: steps and SQL, no values. */
function redact(t: AgentTask): AgentTask {
  const hidden = 'Hidden: this was computed under the access of the person who ran it. Re-run it to see it under yours.';
  return {
    ...t,
    answer: t.answer ? hidden : null,
    artifacts: t.artifacts.filter((a) => a.type !== 'finding').map((a) => (a.type === 'table' ? { ...a, data: { ...a.data, rows: [], redacted: true } } : a)),
    steps: t.steps.map((s) => ({ ...s, summary: s.kind === 'tool' ? s.summary.replace(/[:;].*$/, '') : s.summary })),
  };
}
