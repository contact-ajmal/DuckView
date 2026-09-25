/**
 * Query history, server side: every statement run in a workspace (the workbench, notebooks, dashboards, agents),
 * from the audit log — searchable, filtered by who ran it and how it ended, sorted by time or duration, and
 * optionally grouped by statement (runs, errors, average and total time).
 *
 * People see their own history; owners and administrators may also see everyone's, and agents'.
 */
import { and, desc, eq, inArray, ne, sql, type SQL } from 'drizzle-orm';
import type { MetadataStore } from '../db/index.js';
import type { WorkspaceService } from './workspaces.js';
import type { Principal } from './principal.js';
import { isPlatformAdmin } from './principal.js';

export const QUERY_ACTIONS = ['query.execute', 'query.stream'];

export interface HistoryFilter {
  q?: string;
  who?: 'me' | 'everyone' | 'agents';
  status?: 'all' | 'ok' | 'error';
  sort?: 'recent' | 'slowest';
  group?: boolean;
  limit?: number;
  offset?: number;
}
export interface HistoryRun { id: string; sql: string; at: string; duration_ms: number | null; status: string; error: string | null; who: string; actor_type: string }
export interface HistoryGroup { sql: string; runs: number; errors: number; last_at: string; avg_ms: number; total_ms: number; who: string[] }

export class QueryHistoryService {
  constructor(private readonly store: MetadataStore, private readonly workspaces: WorkspaceService) {}
  private get db() {
    return this.store.db;
  }
  private get s() {
    return this.store.schema;
  }

  async list(p: Principal, workspaceId: string, f: HistoryFilter = {}): Promise<{ who: 'me' | 'everyone' | 'agents'; runs?: HistoryRun[]; groups?: HistoryGroup[] }> {
    const w = await this.workspaces.get(p, workspaceId);
    const canSeeAll = w.role === 'OWNER' || isPlatformAdmin(p);
    const who = canSeeAll ? f.who ?? 'me' : 'me';
    const a = this.s.auditLogs;
    const conds: SQL[] = [eq(a.resource, `workspace:${workspaceId}`), inArray(a.action, QUERY_ACTIONS)];
    if (who === 'me') conds.push(eq(a.user_id, p.userId), ne(a.actor_type, 'AGENT'));
    else if (who === 'agents') conds.push(eq(a.actor_type, 'AGENT'));
    if (f.status === 'ok') conds.push(eq(a.status, 'ok'));
    else if (f.status === 'error') conds.push(ne(a.status, 'ok'));
    const q = f.q?.trim().toLowerCase();
    // Explicit ESCAPE: SQLite has no default escape character, so `_` and `%` would stay wildcards otherwise.
    if (q) conds.push(sql`lower(${a.query_text}) like ${`%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`} escape '\\'`);
    const where = and(...conds);
    const limit = Math.min(Math.max(f.limit ?? 100, 1), 500);

    if (f.group) {
      const rows = await this.db
        .select({ sql: a.query_text, runs: sql<number>`count(*)`, errors: sql<number>`sum(case when ${a.status} = 'ok' then 0 else 1 end)`, last: sql<number>`max(${a.timestamp})`, avg: sql<number>`avg(${a.duration_ms})`, total: sql<number>`sum(${a.duration_ms})` })
        .from(a)
        .where(where)
        .groupBy(a.query_text)
        .orderBy(f.sort === 'slowest' ? desc(sql`sum(${a.duration_ms})`) : desc(sql`max(${a.timestamp})`))
        .limit(limit)
        .offset(f.offset ?? 0);
      return { who, groups: rows.filter((r) => r.sql).map((r) => ({ sql: r.sql!, runs: Number(r.runs), errors: Number(r.errors ?? 0), last_at: toIso(r.last), avg_ms: Math.round(Number(r.avg ?? 0)), total_ms: Math.round(Number(r.total ?? 0)), who: [] })) };
    }

    const rows = await this.db
      .select({ id: a.id, sql: a.query_text, at: a.timestamp, duration_ms: a.duration_ms, status: a.status, error: a.error, user_id: a.user_id, actor_type: a.actor_type })
      .from(a)
      .where(where)
      .orderBy(f.sort === 'slowest' ? desc(a.duration_ms) : desc(a.timestamp))
      .limit(limit)
      .offset(f.offset ?? 0);
    const ids = [...new Set(rows.map((r) => r.user_id).filter(Boolean))] as string[];
    const users = ids.length ? await this.db.select({ id: this.s.users.id, email: this.s.users.email }).from(this.s.users).where(inArray(this.s.users.id, ids)) : [];
    const email = new Map(users.map((u) => [u.id, u.email]));
    return {
      who,
      runs: rows.map((r) => ({ id: r.id, sql: r.sql ?? '', at: toIso(r.at), duration_ms: r.duration_ms, status: r.status, error: r.error, who: r.user_id ? email.get(r.user_id) ?? 'deleted user' : r.actor_type.toLowerCase(), actor_type: r.actor_type })),
    };
  }
}

function toIso(v: unknown): string {
  return (v instanceof Date ? v : new Date(typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : (v as string | number))).toISOString();
}
