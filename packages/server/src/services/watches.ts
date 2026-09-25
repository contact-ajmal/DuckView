/**
 * Watches on datasets: is the schema still what people built on (columns added, removed or retyped), and is the
 * data still fresh? A watch covers a table, view, file or glob of files; its schema is measured against an
 * accepted baseline, and freshness comes from the newest value of a time column, the newest file's modified time,
 * or the last successful sync or stream batch into the table. Checks run on a schedule; a change of state is
 * audited and sent to the watch's channels (and "resolved" when it recovers).
 */
import fs from 'node:fs';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import type { MetadataStore } from '../db/index.js';
import type { DataWatch, WatchSchema } from '../db/schema/sqlite.js';
import type { AppContext } from '../context.js';
import type { Principal } from './principal.js';
import { requireWrite } from './principal.js';
import { badRequest, notFound } from './errors.js';
import { newId } from '../security/crypto.js';
import { logger } from '../observability/logger.js';

export interface WatchInput {
  target?: string;
  watch_schema?: boolean;
  max_age_hours?: number | null;
  time_column?: string | null;
  check_every_minutes?: number;
  channel_ids?: string[];
  enabled?: boolean;
}

const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
const HOUR = 3_600_000;
const ago = (ms: number) => (ms < 2 * HOUR ? `${Math.round(ms / 60_000)} minutes` : ms < 72 * HOUR ? `${Math.round(ms / HOUR)} hours` : `${Math.round(ms / (24 * HOUR))} days`);

export function schemaChanges(before: WatchSchema, after: WatchSchema) {
  const b = new Map(before.map((c) => [c.name, c.type]));
  const a = new Map(after.map((c) => [c.name, c.type]));
  return {
    added: after.filter((c) => !b.has(c.name)),
    removed: before.filter((c) => !a.has(c.name)),
    retyped: before.filter((c) => a.has(c.name) && a.get(c.name) !== c.type).map((c) => ({ name: c.name, from: c.type, to: a.get(c.name)! })),
  };
}

export class WatchService {
  private ctx!: AppContext;
  private ticker: NodeJS.Timeout | null = null;
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

  async list(p: Principal, workspaceId: string): Promise<DataWatch[]> {
    await this.ctx.workspaces.get(p, workspaceId);
    return this.db.select().from(this.s.dataWatches).where(eq(this.s.dataWatches.workspace_id, workspaceId));
  }

  private async own(p: Principal, id: string, minRole: 'VIEWER' | 'EDITOR' = 'EDITOR'): Promise<DataWatch> {
    const row = (await this.db.select().from(this.s.dataWatches).where(eq(this.s.dataWatches.id, id)).limit(1))[0];
    if (!row) throw notFound('Watch');
    await this.ctx.workspaces.get(p, row.workspace_id, minRole);
    return row;
  }

  private async validate(p: Principal, workspaceId: string, input: WatchInput, current?: DataWatch) {
    const target = (input.target ?? current?.target ?? '').trim();
    if (!target) throw badRequest('Choose the table or file to watch');
    const maxAge = input.max_age_hours !== undefined ? input.max_age_hours : current?.max_age_hours ?? null;
    const watchSchema = input.watch_schema ?? current?.watch_schema ?? true;
    if (!watchSchema && !maxAge) throw badRequest('Watch the schema, the freshness, or both');
    if (maxAge != null && (maxAge < 1 || maxAge > 24 * 365)) throw badRequest('Freshness is between 1 hour and a year');
    const every = input.check_every_minutes ?? current?.check_every_minutes ?? 60;
    if (every < 5 || every > 7 * 24 * 60) throw badRequest('Check every 5 minutes to a week');
    const channels = input.channel_ids ?? current?.channel_ids ?? [];
    if (channels.length) {
      const usable = new Set((await this.ctx.notifications.list(p, workspaceId)).map((c) => c.id));
      const bad = channels.filter((c) => !usable.has(c));
      if (bad.length) throw badRequest(`Channel ${String(bad[0])} cannot be used here`);
    }
    return { target, watch_schema: watchSchema, max_age_hours: maxAge, time_column: input.time_column !== undefined ? input.time_column?.trim() || null : current?.time_column ?? null, check_every_minutes: every, channel_ids: [...new Set(channels)], enabled: input.enabled ?? current?.enabled ?? true };
  }

  async create(p: Principal, workspaceId: string, input: WatchInput): Promise<DataWatch> {
    requireWrite(p);
    await this.ctx.workspaces.get(p, workspaceId, 'EDITOR');
    const v = await this.validate(p, workspaceId, input);
    const now = new Date();
    const row: DataWatch = { id: newId(), workspace_id: workspaceId, user_id: p.userId, ...v, baseline: null, status: 'unknown', detail: null, last_seen_at: null, last_checked_at: null, created_at: now, updated_at: now };
    await this.db.insert(this.s.dataWatches).values(row);
    // The first check takes the current schema as the baseline and says whether the data is fresh.
    return this.check(p, row.id);
  }

  async update(p: Principal, id: string, input: WatchInput): Promise<DataWatch> {
    requireWrite(p);
    const cur = await this.own(p, id);
    const v = await this.validate(p, cur.workspace_id, input, cur);
    const reset = v.target !== cur.target;
    await this.db.update(this.s.dataWatches).set({ ...v, ...(reset ? { baseline: null, status: 'unknown', detail: null } : {}), updated_at: new Date() }).where(eq(this.s.dataWatches.id, id));
    return this.check(p, id);
  }

  async remove(p: Principal, id: string): Promise<void> {
    requireWrite(p);
    await this.own(p, id);
    await this.db.delete(this.s.dataWatches).where(eq(this.s.dataWatches.id, id));
  }

  /** Takes the dataset's current schema as the new baseline (after a change was expected). */
  async accept(p: Principal, id: string): Promise<DataWatch> {
    requireWrite(p);
    await this.own(p, id);
    await this.db.update(this.s.dataWatches).set({ baseline: null, updated_at: new Date() }).where(eq(this.s.dataWatches.id, id));
    return this.check(p, id);
  }

  /** When the data was last updated, by the best signal available. */
  private async lastSeen(p: Principal, w: DataWatch): Promise<{ at: Date | null; how: string }> {
    const c = this.ctx;
    const { engine } = await c.workspaces.engine(p, w.workspace_id);
    const rel = engine.resolveRelation(w.target);
    if (w.time_column) {
      const r = await c.queries.run(p, w.workspace_id, `SELECT max(${q(w.time_column)}) FROM (${rel.select}) AS _w`, { maxRows: 1, cache: false });
      const v = r.rows[0]?.[0];
      const at = v == null ? null : new Date(typeof v === 'number' ? v : String(v));
      return { at: at && !Number.isNaN(at.getTime()) ? at : null, how: `the newest ${w.time_column}` };
    }
    if (rel.kind === 'file' && rel.filePath) {
      const files = /[*?[{]/.test(rel.filePath) ? fs.globSync(rel.filePath) : [rel.filePath];
      const times = files.map((f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } }).filter(Boolean);
      return { at: times.length ? new Date(Math.max(...times)) : null, how: files.length > 1 ? `the newest of ${files.length} files` : `${path.basename(rel.filePath)} was modified` };
    }
    if (rel.kind === 'table') {
      const name = w.target.replace(/"/g, '').split('.');
      const table = name.at(-1)!;
      const schema = name.length > 1 ? name.at(-2)! : 'main';
      const s = this.s;
      const sync = (await this.db.select({ last_run: s.dataSyncs.last_run }).from(s.dataSyncs).where(and(eq(s.dataSyncs.workspace_id, w.workspace_id), eq(s.dataSyncs.target_table, table), eq(s.dataSyncs.target_schema, schema))))[0];
      if (sync?.last_run?.finished_at && sync.last_run.status === 'ok') return { at: new Date(sync.last_run.finished_at), how: 'the last successful sync' };
      const stream = (await this.db.select({ stats: s.streams.stats }).from(s.streams).where(and(eq(s.streams.workspace_id, w.workspace_id), eq(s.streams.target_table, table), eq(s.streams.target_schema, schema))))[0];
      if (stream?.stats?.last_batch_at) return { at: new Date(stream.stats.last_batch_at), how: 'the last stream batch' };
    }
    throw badRequest(`Nothing tells when ${w.target} was last updated: choose a time column`);
  }

  /** Checks one watch now; records and announces a change of state. */
  async check(p: Principal, id: string): Promise<DataWatch> {
    const c = this.ctx;
    const w = await this.own(p, id, 'VIEWER');
    const problems: string[] = [];
    let status: DataWatch['status'] = 'ok';
    let baseline = w.baseline;
    let lastSeen = w.last_seen_at;
    try {
      if (w.watch_schema) {
        const { engine } = await c.workspaces.engine(p, w.workspace_id);
        const r = await c.queries.run(p, w.workspace_id, `DESCRIBE ${engine.resolveRelation(w.target).select}`, { maxRows: 5000, cache: false });
        const now: WatchSchema = r.rows.map((row) => ({ name: String(row[0]), type: String(row[1]) }));
        if (!baseline) baseline = now;
        else {
          const d = schemaChanges(baseline, now);
          if (d.added.length || d.removed.length || d.retyped.length) {
            status = 'drift';
            problems.push(`The schema changed: ${[...d.added.map((x) => `${x.name} (${x.type}) was added`), ...d.removed.map((x) => `${x.name} was removed`), ...d.retyped.map((x) => `${x.name} changed from ${x.from} to ${x.to}`)].join('; ')}`);
          }
        }
      }
      if (w.max_age_hours) {
        const seen = await this.lastSeen(p, w);
        lastSeen = seen.at;
        if (!seen.at) {
          if (status === 'ok') status = 'stale';
          problems.push(`No data yet (by ${seen.how})`);
        } else {
          const age = Date.now() - seen.at.getTime();
          if (age > w.max_age_hours * HOUR) {
            if (status === 'ok') status = 'stale';
            problems.push(`Last updated ${ago(age)} ago by ${seen.how}; expected within ${w.max_age_hours} hours`);
          }
        }
      }
    } catch (err) {
      status = 'error';
      problems.push((err as Error).message.split('\n')[0]!);
    }
    const detail = problems.join(' · ') || null;
    const now = new Date();
    await this.db.update(this.s.dataWatches).set({ status, detail, baseline, last_seen_at: lastSeen, last_checked_at: now }).where(eq(this.s.dataWatches.id, id));
    if (status !== w.status && !(w.status === 'unknown' && status === 'ok')) await this.announce(w, status, detail);
    return { ...w, status, detail, baseline, last_seen_at: lastSeen, last_checked_at: now };
  }

  private async announce(w: DataWatch, status: DataWatch['status'], detail: string | null) {
    const c = this.ctx;
    c.audit.log({ userId: null, actorType: 'SYSTEM', action: `watch.${status}`, resource: `workspace:${w.workspace_id}`, queryText: `${w.target}: ${detail ?? status}` });
    if (!w.channel_ids.length) return;
    const recovered = status === 'ok';
    const title = recovered ? `${w.target} is back to normal` : status === 'drift' ? `The schema of ${w.target} changed` : status === 'stale' ? `${w.target} is stale` : `Could not check ${w.target}`;
    const base = c.cfg.server.public_url?.replace(/\/+$/, '');
    await c.notifications.send(w.channel_ids, { title, text: detail ?? (recovered ? 'The schema and freshness are as expected again.' : ''), severity: recovered ? 'resolved' : status === 'error' ? 'critical' : 'warning', url: base ? `${base}/#/transform/quality` : null }, 'watch', w.workspace_id).catch((err) => logger().warn({ err: (err as Error).message }, 'Watch notification failed'));
  }

  /** Scheduled checks: each enabled watch when its interval has passed, as its owner. */
  async tick(now = new Date()): Promise<string[]> {
    const c = this.ctx;
    if (c.cluster.enabled && !(await c.cluster.acquire('watches:scheduler')).self) return [];
    const due = (await this.db.select().from(this.s.dataWatches).where(eq(this.s.dataWatches.enabled, true))).filter((w) => !w.last_checked_at || now.getTime() - w.last_checked_at.getTime() >= w.check_every_minutes * 60_000);
    const checked: string[] = [];
    for (const w of due) {
      const u = await c.auth.findById(w.user_id);
      if (!u) continue;
      try {
        await this.check(c.auth.principalFromUser(u, 'jwt', '127.0.0.1'), w.id);
        checked.push(w.id);
      } catch (err) {
        logger().warn({ watch: w.id, err: (err as Error).message }, 'Watch check failed');
      }
    }
    return checked;
  }

  start(minutes = 5) {
    if (this.ticker) return;
    this.ticker = setInterval(() => void this.tick().catch((err) => logger().warn({ err: (err as Error).message }, 'Watch tick failed')), minutes * 60_000);
    this.ticker.unref();
  }
  stop() {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
  }
}
