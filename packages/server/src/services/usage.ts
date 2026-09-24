/**
 * Usage & cost: what the organisation (or one person) used over a period, and what it cost at the configured rates.
 *
 *  - Compute: query time on the engines — from the workbench, dashboards, notebooks, BI tools and agents (the audit
 *    log's query rows) — and pipeline time (syncs, reverse syncs, dbt runs), priced per hour (usage.compute_per_hour).
 *  - AI: DuckCopilot turns and DuckView agent runs, their tokens priced per model (usage.model_prices over built-in
 *    list prices); turns paid with the person's own key are counted apart.
 *  - Storage: the size of each workspace's database file, priced per GB-month for the period.
 *
 * Administrators see everyone; others see their own activity and the workspaces they own. Budgets set a monthly
 * limit for the organisation or a workspace and notify channels when spend (or its month-end forecast) crosses a
 * threshold; each notification is claimed atomically, so one node sends it.
 */
import fs from 'node:fs';
import { and, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import type { MetadataStore } from '../db/index.js';
import type { UsageBudget, Workspace } from '../db/schema/sqlite.js';
import type { DuckViewConfig } from '../config/index.js';
import { newId } from '../security/crypto.js';
import type { DataJail } from '../engine/sandbox.js';
import type { Principal } from './principal.js';
import { isPlatformAdmin, requireAdmin, requireWrite } from './principal.js';
import type { WorkspaceService } from './workspaces.js';
import type { NotificationService } from './notifications.js';
import type { AuditService } from './audit.js';
import { badRequest, forbidden, notFound } from './errors.js';
import { logger } from '../observability/logger.js';

/** List prices per million tokens (input, output), matched by a substring of the model id; the longest match wins. */
export const DEFAULT_MODEL_PRICES: Record<string, { input: number; output: number }> = {
  'claude-opus': { input: 5, output: 25 },
  'claude-sonnet': { input: 3, output: 15 },
  'claude-haiku': { input: 1, output: 5 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'gpt-4.1': { input: 2, output: 8 },
  'gpt-5-mini': { input: 0.25, output: 2 },
  'gpt-5': { input: 1.25, output: 10 },
  'gemini-2.5-flash': { input: 0.3, output: 2.5 },
  'gemini-2.5-pro': { input: 1.25, output: 10 },
  'mistral-large': { input: 2, output: 6 },
};

const QUERY_ACTIONS = ['query.execute', 'query.stream', 'mosaic.exec', 'lakehouse.query'];
const DAY = 86_400_000;

export interface Cost {
  compute: number;
  ai: number;
  storage: number;
  total: number;
}
const cost = (compute: number, ai: number, storage: number): Cost => ({ compute: round(compute), ai: round(ai), storage: round(storage), total: round(compute + ai + storage) });
const round = (n: number) => Math.round(n * 10_000) / 10_000;

export interface UsageReport {
  scope: 'org' | 'self';
  range: { from: string; to: string; days: number };
  currency: string;
  rates: { compute_per_hour: number; storage_per_gb_month: number };
  totals: { queries: number; errors: number; query_seconds: number; pipeline_runs: number; pipeline_seconds: number; ai_turns: number; ai_input_tokens: number; ai_output_tokens: number; storage_bytes: number; byok_ai_cost: number; unpriced_models: string[]; cost: Cost };
  daily: { date: string; queries: number; compute_seconds: number; ai_tokens: number; cost: Cost }[];
  workspaces: { id: string; name: string; queries: number; compute_seconds: number; ai_tokens: number; storage_bytes: number; cost: Cost }[];
  users: { id: string; email: string; queries: number; compute_seconds: number; ai_tokens: number; cost: Cost }[];
  sources: { source: 'people' | 'agents' | 'pipelines'; runs: number; seconds: number; cost: number }[];
  models: { model: string; provider: string; turns: number; input_tokens: number; output_tokens: number; cost: number; byok_turns: number; priced: boolean }[];
  top_queries: { sql: string; workspace_id: string | null; runs: number; total_seconds: number; avg_ms: number; cost: number }[];
}

export interface BudgetInput {
  name?: string;
  workspace_id?: string | null;
  amount?: number;
  thresholds?: number[];
  forecast?: boolean;
  channel_ids?: string[];
}
export type BudgetStatus = UsageBudget & { amount: number; spent: number; forecast_spend: number; percent: number; period: string };

interface Filter {
  from: Date;
  to: Date;
  userId?: string | null;
  workspaceId?: string | null;
}

export class UsageService {
  private ticker: NodeJS.Timeout | null = null;

  constructor(
    private readonly cfg: DuckViewConfig,
    private readonly store: MetadataStore,
    private readonly workspaces: WorkspaceService,
    private readonly notifications: NotificationService,
    private readonly audit: AuditService,
    private readonly jail: DataJail,
  ) {}
  private get db() {
    return this.store.db;
  }
  private get s() {
    return this.store.schema;
  }

  // ------------------------------------------------------------------------------------------ pricing

  /** Price per million tokens for a model id, or null when no rate matches. */
  priceOf(model: string): { input: number; output: number } | null {
    const table = { ...DEFAULT_MODEL_PRICES, ...this.cfg.usage.model_prices };
    const id = model.toLowerCase();
    const key = Object.keys(table)
      .filter((k) => id.includes(k.toLowerCase()))
      .sort((a, b) => b.length - a.length)[0];
    return key ? table[key]! : null;
  }

  private tokenCost(model: string, input: number, output: number): number | null {
    // Local models cost nothing per token.
    if (/^(ollama|lmstudio|local)/i.test(model)) return 0;
    const p = this.priceOf(model);
    return p ? (input * p.input + output * p.output) / 1_000_000 : null;
  }

  // ------------------------------------------------------------------------------------------ storage

  /** Bytes of a workspace's database file (and its write-ahead log); in-memory and remote databases count 0. */
  storageBytes(w: Pick<Workspace, 'active_db_path'>): number {
    const db = w.active_db_path;
    if (!db || db === ':memory:' || /^[a-z0-9]+:\/\//i.test(db)) return 0;
    let abs: string;
    try {
      abs = this.jail.resolve(db).absolute;
    } catch {
      return 0;
    }
    let n = 0;
    for (const f of [abs, `${abs}.wal`]) {
      try {
        n += fs.statSync(f).size;
      } catch {
        /* not there */
      }
    }
    return n;
  }

  // ------------------------------------------------------------------------------------------ the report

  /** Usage and cost over the last `days` days (or from..to); administrators see everyone unless `mine`. */
  async report(p: Principal, opts: { days?: number; from?: Date; to?: Date; workspace_id?: string | null; mine?: boolean } = {}): Promise<UsageReport> {
    const org = isPlatformAdmin(p) && !opts.mine;
    if (opts.workspace_id) await this.workspaces.get(p, opts.workspace_id);
    const to = opts.to ?? new Date();
    const days = Math.min(Math.max(Math.round(opts.days ?? 30), 1), 366);
    const from = opts.from ?? new Date(to.getTime() - days * DAY);
    return this.compute({ from, to, userId: org ? null : p.userId, workspaceId: opts.workspace_id ?? null }, org ? 'org' : 'self');
  }

  async compute(f: Filter, scope: 'org' | 'self' = 'org'): Promise<UsageReport> {
    const s = this.s;
    const a = s.auditLogs;
    const dayExpr = (col: unknown) => (this.store.dialect === 'sqlite' ? sql<number>`cast(${col} / ${DAY} as integer)` : sql<number>`floor(extract(epoch from ${col}) / 86400)`);
    const auditWhere = and(inArray(a.action, QUERY_ACTIONS), gte(a.timestamp, f.from), lt(a.timestamp, f.to), f.userId ? eq(a.user_id, f.userId) : undefined, f.workspaceId ? eq(a.resource, `workspace:${f.workspaceId}`) : undefined);
    const num = (v: unknown) => Number(v ?? 0);

    // Queries, grouped by day × workspace × user × kind of actor (small: one row per combination).
    const groups = await this.db
      .select({ day: dayExpr(a.timestamp), resource: a.resource, user_id: a.user_id, actor: a.actor_type, n: sql<number>`count(*)`, errors: sql<number>`sum(case when ${a.status} = 'ok' then 0 else 1 end)`, ms: sql<number>`coalesce(sum(${a.duration_ms}), 0)` })
      .from(a)
      .where(auditWhere)
      .groupBy(dayExpr(a.timestamp), a.resource, a.user_id, a.actor_type);

    // Pipelines: syncs, reverse syncs and dbt runs, with their duration.
    type Run = { day: number; workspace_id: string; user_id: string | null; ms: number };
    const runs: Run[] = [];
    const inRange = (col: unknown) => and(gte(col as never, f.from), lt(col as never, f.to));
    const wsOnly = (col: unknown) => (f.workspaceId ? eq(col as never, f.workspaceId) : undefined);
    const syncRuns = await this.db.select({ started: s.dataSyncRuns.started_at, ms: s.dataSyncRuns.duration_ms, ws: s.dataSyncRuns.workspace_id, user: s.dataSyncs.user_id }).from(s.dataSyncRuns).innerJoin(s.dataSyncs, eq(s.dataSyncs.id, s.dataSyncRuns.sync_id)).where(and(inRange(s.dataSyncRuns.started_at), wsOnly(s.dataSyncRuns.workspace_id), f.userId ? eq(s.dataSyncs.user_id, f.userId) : undefined));
    const reverseRuns = await this.db.select({ started: s.reverseSyncRuns.started_at, ms: s.reverseSyncRuns.duration_ms, ws: s.reverseSyncRuns.workspace_id, user: s.reverseSyncs.user_id }).from(s.reverseSyncRuns).innerJoin(s.reverseSyncs, eq(s.reverseSyncs.id, s.reverseSyncRuns.sync_id)).where(and(inRange(s.reverseSyncRuns.started_at), wsOnly(s.reverseSyncRuns.workspace_id), f.userId ? eq(s.reverseSyncs.user_id, f.userId) : undefined));
    const dbtRuns = await this.db.select({ started: s.dbtRuns.started_at, finished: s.dbtRuns.finished_at, ws: s.dbtRuns.workspace_id, user: s.dbtProjects.user_id }).from(s.dbtRuns).innerJoin(s.dbtProjects, eq(s.dbtProjects.id, s.dbtRuns.project_id)).where(and(inRange(s.dbtRuns.started_at), wsOnly(s.dbtRuns.workspace_id), f.userId ? eq(s.dbtProjects.user_id, f.userId) : undefined));
    for (const r of [...syncRuns, ...reverseRuns]) runs.push({ day: Math.floor(r.started.getTime() / DAY), workspace_id: r.ws, user_id: r.user, ms: num(r.ms) });
    for (const r of dbtRuns) runs.push({ day: Math.floor(r.started.getTime() / DAY), workspace_id: r.ws, user_id: r.user, ms: r.finished ? r.finished.getTime() - r.started.getTime() : 0 });

    // AI: Copilot turns and agent runs.
    type Turn = { day: number; workspace_id: string; user_id: string; provider: string; model: string; input: number; output: number; byok: boolean };
    const turns: Turn[] = [];
    const cu = s.copilotUsage;
    const copilot = await this.db
      .select({ day: dayExpr(cu.created_at), ws: cu.workspace_id, user: cu.user_id, provider: cu.provider, model: cu.model, byok: cu.byok, i: sql<number>`coalesce(sum(${cu.input_tokens}), 0)`, o: sql<number>`coalesce(sum(${cu.output_tokens}), 0)`, n: sql<number>`count(*)` })
      .from(cu)
      .where(and(gte(cu.created_at, f.from), lt(cu.created_at, f.to), f.userId ? eq(cu.user_id, f.userId) : undefined, wsOnly(cu.workspace_id)))
      .groupBy(dayExpr(cu.created_at), cu.workspace_id, cu.user_id, cu.provider, cu.model, cu.byok);
    const turnCount = new Map<Turn, number>();
    for (const r of copilot) {
      const t: Turn = { day: num(r.day), workspace_id: r.ws, user_id: r.user, provider: r.provider, model: r.model, input: num(r.i), output: num(r.o), byok: !!r.byok };
      turns.push(t);
      turnCount.set(t, num(r.n));
    }
    const hr = s.hostedAgentRuns;
    const agentRuns = await this.db
      .select({ started: hr.started_at, ws: hr.workspace_id, user: s.hostedAgents.user_id, model: hr.model, i: hr.input_tokens, o: hr.output_tokens })
      .from(hr)
      .innerJoin(s.hostedAgents, eq(s.hostedAgents.id, hr.agent_id))
      .where(and(gte(hr.started_at, f.from), lt(hr.started_at, f.to), f.userId ? eq(s.hostedAgents.user_id, f.userId) : undefined, wsOnly(hr.workspace_id)));
    for (const r of agentRuns) {
      if (!r.i && !r.o) continue;
      const t: Turn = { day: Math.floor(r.started.getTime() / DAY), workspace_id: r.ws, user_id: r.user, provider: 'agent', model: r.model ?? 'unknown', input: num(r.i), output: num(r.o), byok: false };
      turns.push(t);
      turnCount.set(t, 1);
    }

    // Workspaces in scope, for names and storage.
    const wsRows = await this.db.select().from(s.workspaces).where(f.workspaceId ? eq(s.workspaces.id, f.workspaceId) : f.userId ? eq(s.workspaces.user_id, f.userId) : undefined);
    const wsName = new Map(wsRows.map((w) => [w.id, w.name]));
    const perHour = this.cfg.usage.compute_per_hour;
    const periodDays = Math.max((f.to.getTime() - f.from.getTime()) / DAY, 0);
    const storageRate = (bytes: number) => (bytes / 1e9) * this.cfg.usage.storage_per_gb_month * (periodDays / 30);
    const computeCost = (ms: number) => (ms / 3_600_000) * perHour;

    // Accumulate.
    type Acc = { queries: number; compute_ms: number; ai_tokens: number; compute: number; ai: number; storage: number; storage_bytes: number };
    const acc = (): Acc => ({ queries: 0, compute_ms: 0, ai_tokens: 0, compute: 0, ai: 0, storage: 0, storage_bytes: 0 });
    const byDay = new Map<number, Acc>();
    const byWs = new Map<string, Acc>();
    const byUser = new Map<string, Acc>();
    const get = <K,>(m: Map<K, Acc>, k: K) => m.get(k) ?? (m.set(k, acc()), m.get(k)!);
    const sources = { people: { runs: 0, ms: 0 }, agents: { runs: 0, ms: 0 }, pipelines: { runs: 0, ms: 0 } };
    let queries = 0;
    let errors = 0;
    let queryMs = 0;
    for (const g of groups) {
      const n = num(g.n);
      const ms = num(g.ms);
      const c = computeCost(ms);
      queries += n;
      errors += num(g.errors);
      queryMs += ms;
      const src = g.actor === 'AGENT' ? sources.agents : sources.people;
      src.runs += n;
      src.ms += ms;
      const ws = g.resource?.startsWith('workspace:') ? g.resource.slice('workspace:'.length) : '(lakehouse)';
      for (const x of [get(byDay, num(g.day)), get(byWs, ws), get(byUser, g.user_id ?? '(system)')]) {
        x.queries += n;
        x.compute_ms += ms;
        x.compute += c;
      }
    }
    let pipelineMs = 0;
    for (const r of runs) {
      const c = computeCost(r.ms);
      pipelineMs += r.ms;
      sources.pipelines.runs++;
      sources.pipelines.ms += r.ms;
      for (const x of [get(byDay, r.day), get(byWs, r.workspace_id), get(byUser, r.user_id ?? '(system)')]) {
        x.compute_ms += r.ms;
        x.compute += c;
      }
    }
    const models = new Map<string, UsageReport['models'][number]>();
    let aiIn = 0;
    let aiOut = 0;
    let aiTurns = 0;
    let byokCost = 0;
    const unpriced = new Set<string>();
    for (const t of turns) {
      const priced = this.tokenCost(t.model, t.input, t.output);
      if (priced === null) unpriced.add(t.model);
      const c = priced ?? 0;
      const n = turnCount.get(t) ?? 1;
      aiIn += t.input;
      aiOut += t.output;
      aiTurns += n;
      const key = `${t.provider}\u0000${t.model}`;
      const m = models.get(key) ?? { model: t.model, provider: t.provider, turns: 0, input_tokens: 0, output_tokens: 0, cost: 0, byok_turns: 0, priced: priced !== null };
      m.turns += n;
      m.input_tokens += t.input;
      m.output_tokens += t.output;
      m.cost += c;
      if (t.byok) m.byok_turns += n;
      models.set(key, m);
      // A person's own key pays for their turns: shown, not charged to the organisation.
      if (t.byok) {
        byokCost += c;
        continue;
      }
      for (const x of [get(byDay, t.day), get(byWs, t.workspace_id), get(byUser, t.user_id)]) {
        x.ai_tokens += t.input + t.output;
        x.ai += c;
      }
    }
    let storageBytes = 0;
    let storageCost = 0;
    for (const w of wsRows) {
      const bytes = this.storageBytes(w);
      if (!bytes) continue;
      const c = storageRate(bytes);
      storageBytes += bytes;
      storageCost += c;
      const x = get(byWs, w.id);
      x.storage_bytes = bytes;
      x.storage = c;
    }
    // Storage accrues evenly over the days of the period.
    const firstDay = Math.floor(f.from.getTime() / DAY);
    const lastDay = Math.floor((f.to.getTime() - 1) / DAY);
    const nDays = Math.max(lastDay - firstDay + 1, 1);
    for (let d = firstDay; d <= lastDay; d++) get(byDay, d).storage += storageCost / nDays;

    const users = await this.usersById([...byUser.keys()]);
    const tq = await this.db
      .select({ sql: a.query_text, resource: a.resource, n: sql<number>`count(*)`, ms: sql<number>`coalesce(sum(${a.duration_ms}), 0)` })
      .from(a)
      .where(and(auditWhere, sql`${a.query_text} is not null`))
      .groupBy(a.query_text, a.resource)
      .orderBy(sql`coalesce(sum(${a.duration_ms}), 0) desc`)
      .limit(10);

    // Everything of deleted people and workspaces is one row each.
    const merge = <T extends { cost: Cost }>(rows: T[], deleted: (r: T) => boolean, sum: (a: T, b: T) => T): T[] => {
      const gone = rows.filter(deleted);
      return gone.length > 1 ? [...rows.filter((r) => !deleted(r)), gone.reduce(sum)] : rows;
    };
    const addCost = (a: Cost, b: Cost) => cost(a.compute + b.compute, a.ai + b.ai, a.storage + b.storage);

    const computeTotal = [...byDay.values()].reduce((t, x) => t + x.compute, 0);
    const aiTotal = [...byDay.values()].reduce((t, x) => t + x.ai, 0);
    const iso = (d: number) => new Date(d * DAY).toISOString().slice(0, 10);
    return {
      scope,
      range: { from: f.from.toISOString(), to: f.to.toISOString(), days: Math.round(periodDays * 10) / 10 },
      currency: this.cfg.usage.currency,
      rates: { compute_per_hour: perHour, storage_per_gb_month: this.cfg.usage.storage_per_gb_month },
      totals: { queries, errors, query_seconds: round(queryMs / 1000), pipeline_runs: sources.pipelines.runs, pipeline_seconds: round(pipelineMs / 1000), ai_turns: aiTurns, ai_input_tokens: aiIn, ai_output_tokens: aiOut, storage_bytes: storageBytes, byok_ai_cost: round(byokCost), unpriced_models: [...unpriced], cost: cost(computeTotal, aiTotal, storageCost) },
      daily: [...byDay.entries()].filter(([d]) => d >= firstDay && d <= lastDay).sort(([x], [y]) => x - y).map(([d, x]) => ({ date: iso(d), queries: x.queries, compute_seconds: round(x.compute_ms / 1000), ai_tokens: x.ai_tokens, cost: cost(x.compute, x.ai, x.storage) })),
      workspaces: merge(
        [...byWs.entries()].map(([id, x]) => ({ id, name: wsName.get(id) ?? (id === '(lakehouse)' ? 'Lakehouse queries' : 'Deleted workspaces'), queries: x.queries, compute_seconds: round(x.compute_ms / 1000), ai_tokens: x.ai_tokens, storage_bytes: x.storage_bytes, cost: cost(x.compute, x.ai, x.storage) })),
        (w) => w.name === 'Deleted workspaces',
        (a, b) => ({ id: '(deleted)', name: a.name, queries: a.queries + b.queries, compute_seconds: round(a.compute_seconds + b.compute_seconds), ai_tokens: a.ai_tokens + b.ai_tokens, storage_bytes: a.storage_bytes + b.storage_bytes, cost: addCost(a.cost, b.cost) }),
      ).sort((x, y) => y.cost.total - x.cost.total || y.queries - x.queries),
      users: merge(
        [...byUser.entries()].map(([id, x]) => ({ id, email: users.get(id) ?? (id === '(system)' ? 'System' : 'Deleted users'), queries: x.queries, compute_seconds: round(x.compute_ms / 1000), ai_tokens: x.ai_tokens, cost: cost(x.compute, x.ai, 0) })),
        (u) => u.email === 'Deleted users',
        (a, b) => ({ id: '(deleted)', email: a.email, queries: a.queries + b.queries, compute_seconds: round(a.compute_seconds + b.compute_seconds), ai_tokens: a.ai_tokens + b.ai_tokens, cost: addCost(a.cost, b.cost) }),
      ).sort((x, y) => y.cost.total - x.cost.total || y.queries - x.queries),
      sources: (['people', 'agents', 'pipelines'] as const).map((k) => ({ source: k, runs: sources[k].runs, seconds: round(sources[k].ms / 1000), cost: round(computeCost(sources[k].ms)) })),
      models: [...models.values()].map((m) => ({ ...m, cost: round(m.cost) })).sort((x, y) => y.cost - x.cost || y.turns - x.turns),
      top_queries: tq.map((r) => ({ sql: (r.sql ?? '').slice(0, 2000), workspace_id: r.resource?.startsWith('workspace:') ? r.resource.slice(10) : null, runs: num(r.n), total_seconds: round(num(r.ms) / 1000), avg_ms: Math.round(num(r.ms) / Math.max(num(r.n), 1)), cost: round(computeCost(num(r.ms))) })),
    };
  }

  private async usersById(ids: string[]): Promise<Map<string, string>> {
    const real = ids.filter((i) => !i.startsWith('('));
    if (!real.length) return new Map();
    const rows = await this.db.select({ id: this.s.users.id, email: this.s.users.email }).from(this.s.users).where(inArray(this.s.users.id, real));
    return new Map(rows.map((r) => [r.id, r.email]));
  }

  /** The report as CSV: one row per day, workspace or user. */
  toCsv(r: UsageReport, by: 'day' | 'workspace' | 'user'): string {
    const esc = (v: unknown) => {
      const t = String(v ?? '');
      return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    };
    const rows: unknown[][] =
      by === 'day'
        ? [['date', 'queries', 'compute_seconds', 'ai_tokens', 'compute_cost', 'ai_cost', 'storage_cost', 'total_cost'], ...r.daily.map((d) => [d.date, d.queries, d.compute_seconds, d.ai_tokens, d.cost.compute, d.cost.ai, d.cost.storage, d.cost.total])]
        : by === 'workspace'
          ? [['workspace_id', 'workspace', 'queries', 'compute_seconds', 'ai_tokens', 'storage_bytes', 'compute_cost', 'ai_cost', 'storage_cost', 'total_cost'], ...r.workspaces.map((w) => [w.id, w.name, w.queries, w.compute_seconds, w.ai_tokens, w.storage_bytes, w.cost.compute, w.cost.ai, w.cost.storage, w.cost.total])]
          : [['user_id', 'email', 'queries', 'compute_seconds', 'ai_tokens', 'compute_cost', 'ai_cost', 'total_cost'], ...r.users.map((u) => [u.id, u.email, u.queries, u.compute_seconds, u.ai_tokens, u.cost.compute, u.cost.ai, u.cost.total])];
    return `${rows.map((row) => row.map(esc).join(',')).join('\n')}\n`;
  }

  // ------------------------------------------------------------------------------------------ budgets

  private monthStart(now: Date): Date {
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  }

  private async status(b: UsageBudget, now = new Date()): Promise<BudgetStatus> {
    const from = this.monthStart(now);
    const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    const r = await this.compute({ from, to: now, workspaceId: b.workspace_id });
    const spent = r.totals.cost.total;
    const elapsed = Math.max((now.getTime() - from.getTime()) / DAY, 1 / 24);
    const forecast = (spent / elapsed) * ((nextMonth.getTime() - from.getTime()) / DAY);
    const amount = b.amount_cents / 100;
    return { ...b, amount, spent: round(spent), forecast_spend: round(forecast), percent: amount > 0 ? Math.round((spent / amount) * 1000) / 10 : 0, period: from.toISOString().slice(0, 7) };
  }

  /** Budgets `p` may see: all for administrators; otherwise those of workspaces they can open. */
  async listBudgets(p: Principal, workspaceId?: string | null): Promise<BudgetStatus[]> {
    const b = this.s.usageBudgets;
    let rows = await this.db.select().from(b).where(workspaceId ? eq(b.workspace_id, workspaceId) : undefined);
    if (!isPlatformAdmin(p)) {
      const visible: UsageBudget[] = [];
      for (const r of rows) if (r.workspace_id && (await this.workspaces.get(p, r.workspace_id).then(() => true).catch(() => false))) visible.push(r);
      rows = visible;
    }
    return Promise.all(rows.sort((x, y) => x.name.localeCompare(y.name)).map((r) => this.status(r)));
  }

  private async checkBudget(p: Principal, input: BudgetInput, current?: UsageBudget) {
    const workspaceId = input.workspace_id !== undefined ? input.workspace_id || null : current?.workspace_id ?? null;
    // The organisation's budget is the administrators'; a workspace's, its owners'.
    if (!workspaceId) requireAdmin(p);
    else await this.workspaces.get(p, workspaceId, 'OWNER');
    const channels = input.channel_ids ?? current?.channel_ids ?? [];
    if (channels.length) {
      const usable = new Set((workspaceId ? await this.notifications.list(p, workspaceId) : await this.notifications.listOrg(p)).map((c) => c.id));
      const bad = channels.find((c) => !usable.has(c));
      if (bad) throw badRequest(`Channel ${bad} cannot be used here`);
    }
    const amount = input.amount ?? (current ? current.amount_cents / 100 : undefined);
    if (amount === undefined || !(amount > 0) || amount > 1e9) throw badRequest('amount must be a positive number');
    const thresholds = [...new Set((input.thresholds ?? current?.thresholds ?? [80, 100]).map((t) => Math.round(t)))].filter((t) => t > 0 && t <= 1000).sort((x, y) => x - y);
    if (!thresholds.length) throw badRequest('thresholds must hold at least one percentage');
    return { workspace_id: workspaceId, amount_cents: Math.round(amount * 100), thresholds, channel_ids: [...new Set(channels)], forecast: input.forecast ?? current?.forecast ?? false, name: (input.name ?? current?.name ?? '').trim().slice(0, 120) };
  }

  async createBudget(p: Principal, input: BudgetInput): Promise<BudgetStatus> {
    requireWrite(p);
    const v = await this.checkBudget(p, input);
    const now = new Date();
    const wsName = v.workspace_id ? (await this.workspaces.get(p, v.workspace_id)).name : null;
    const row: UsageBudget = { id: newId(), ...v, name: v.name || (wsName ? `${wsName} monthly budget` : 'Organisation monthly budget'), notified: '', created_by: p.userId, created_at: now, updated_at: now };
    await this.db.insert(this.s.usageBudgets).values(row);
    this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'budget.create', resource: `budget:${row.id}`, ip: p.ip });
    return this.status(row);
  }

  private async budget(id: string): Promise<UsageBudget> {
    const r = (await this.db.select().from(this.s.usageBudgets).where(eq(this.s.usageBudgets.id, id)).limit(1))[0];
    if (!r) throw notFound('Budget');
    return r;
  }

  async updateBudget(p: Principal, id: string, input: BudgetInput): Promise<BudgetStatus> {
    requireWrite(p);
    const cur = await this.budget(id);
    const v = await this.checkBudget(p, { ...input, workspace_id: cur.workspace_id }, cur);
    const set = { ...v, name: v.name || cur.name, updated_at: new Date(), notified: '' };
    await this.db.update(this.s.usageBudgets).set(set).where(eq(this.s.usageBudgets.id, id));
    this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'budget.update', resource: `budget:${id}`, ip: p.ip });
    return this.status({ ...cur, ...set });
  }

  async removeBudget(p: Principal, id: string): Promise<void> {
    requireWrite(p);
    const cur = await this.budget(id);
    if (!cur.workspace_id) requireAdmin(p);
    else await this.workspaces.get(p, cur.workspace_id, 'OWNER').catch(() => {
      throw forbidden('Only the workspace owner or an administrator can remove its budget');
    });
    await this.db.delete(this.s.usageBudgets).where(eq(this.s.usageBudgets.id, id));
    this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'budget.delete', resource: `budget:${id}`, ip: p.ip });
  }

  /** Notifies the budgets that crossed a threshold this month; returns what was sent (called by the ticker and tests). */
  async checkBudgets(now = new Date()): Promise<{ budget_id: string; threshold: number }[]> {
    const sent: { budget_id: string; threshold: number }[] = [];
    for (const b of await this.db.select().from(this.s.usageBudgets)) {
      const st = await this.status(b, now);
      const measure = b.forecast ? Math.max(st.spent, st.forecast_spend) : st.spent;
      const pct = st.amount > 0 ? (measure / st.amount) * 100 : 0;
      const [period, done] = b.notified.split(':');
      const already = new Set(period === st.period ? (done ?? '').split(',').filter(Boolean).map(Number) : []);
      const crossed = b.thresholds.filter((t) => pct >= t && !already.has(t));
      if (!crossed.length) continue;
      const next = `${st.period}:${[...already, ...crossed].sort((x, y) => x - y).join(',')}`;
      // Claim: only the node whose update lands sends it.
      const claimed = await this.db.update(this.s.usageBudgets).set({ notified: next }).where(and(eq(this.s.usageBudgets.id, b.id), eq(this.s.usageBudgets.notified, b.notified))).returning({ id: this.s.usageBudgets.id });
      if (!claimed.length) continue;
      const top = Math.max(...crossed);
      const money = (n: number) => `${n.toFixed(2)} ${this.cfg.usage.currency}`;
      const scope = b.workspace_id ? `workspace ${(await this.db.select({ name: this.s.workspaces.name }).from(this.s.workspaces).where(eq(this.s.workspaces.id, b.workspace_id)).limit(1))[0]?.name ?? b.workspace_id}` : 'the organisation';
      const over = st.spent >= st.amount;
      if (b.channel_ids.length) {
        await this.notifications
          .send(b.channel_ids, {
            title: `${b.name}: ${over ? 'over budget' : `${top}% ${b.forecast && st.spent / st.amount * 100 < top ? 'forecast' : 'reached'}`}`,
            text: `DuckView usage for ${scope} this month is ${money(st.spent)} of a ${money(st.amount)} budget (${st.percent}%). At this rate the month ends at ${money(st.forecast_spend)}.`,
            severity: over ? 'critical' : 'warning',
            url: `${this.cfg.server.public_url ?? ''}/#/settings/usage`,
            fields: [
              { label: 'Spent', value: money(st.spent) },
              { label: 'Budget', value: money(st.amount) },
              { label: 'Forecast', value: money(st.forecast_spend) },
            ],
            dedupKey: `budget:${b.id}:${st.period}`,
            event: 'budget.threshold',
          }, 'budget', b.workspace_id)
          .catch((err) => logger().warn({ budget: b.id, err: (err as Error).message }, 'Budget notification failed'));
      }
      this.audit.log({ userId: null, actorType: 'SYSTEM', action: 'budget.threshold', resource: `budget:${b.id}`, queryText: `${top}% of ${money(st.amount)} (spent ${money(st.spent)})` });
      for (const t of crossed) sent.push({ budget_id: b.id, threshold: t });
    }
    return sent;
  }

  start() {
    if (this.ticker) return;
    this.ticker = setInterval(() => void this.checkBudgets().catch((err) => logger().warn({ err: (err as Error).message }, 'Budget check failed')), this.cfg.usage.budget_check_minutes * 60_000);
    this.ticker.unref();
  }
  stop() {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
  }
}
