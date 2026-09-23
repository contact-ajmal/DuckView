/**
 * SQL alerts: a query of a workspace, checked on a schedule (every N minutes or cron), with a condition — it
 * returns rows, it returns none, or a column of its first row crosses a threshold. The alert runs as its author with
 * the read scope only (a mutating statement is refused when it is saved and again when it runs), and state changes
 * are delivered to the alert's notification channels: triggered (with the alert's severity), resolved when it
 * clears, and failing when the query errors. With notify "always" every triggered check is delivered.
 *
 * Checks are recorded when the state changes, when something was delivered, or when a person ran the alert.
 */
import { and, desc, eq, lte, lt, isNotNull } from 'drizzle-orm';
import type { MetadataStore } from '../db/index.js';
import type { Alert, AlertCondition, AlertEvent, AlertState, SyncSchedule } from '../db/schema/sqlite.js';
import { ALERT_SEVERITIES } from '../db/schema/sqlite.js';
import type { DuckViewConfig } from '../config/index.js';
import { newId } from '../security/crypto.js';
import { analyzeSql } from '../engine/sql-guard.js';
import type { Principal } from './principal.js';
import { requireWrite } from './principal.js';
import type { WorkspaceService } from './workspaces.js';
import type { QueryService } from './query.js';
import type { AuthService } from './auth.js';
import type { AuditService } from './audit.js';
import type { NotificationService, Notification } from './notifications.js';
import { nextRunAt } from './syncs.js';
import { badRequest, notFound } from './errors.js';
import { logger } from '../observability/logger.js';
import { liveEvents } from '../observability/events.js';

export interface AlertInput {
  name?: string;
  description?: string | null;
  sql?: string;
  condition?: AlertCondition;
  schedule?: SyncSchedule;
  channel_ids?: string[];
  severity?: Alert['severity'];
  notify?: Alert['notify'];
  notify_resolved?: boolean;
  enabled?: boolean;
}

export interface Evaluation {
  state: Exclude<AlertState, 'unknown'>;
  value: string | null;
  /** What the check found, in a sentence. */
  summary: string;
  columns: string[];
  rows: unknown[][];
  row_count: number;
  error: string | null;
  duration_ms: number;
}

const OPS = ['>', '>=', '<', '<=', '=', '!='] as const;

export function describeCondition(c: AlertCondition): string {
  if (c.kind === 'rows') return 'the query returns rows';
  if (c.kind === 'no_rows') return 'the query returns no rows';
  return `${c.column} ${c.op} ${c.value}`;
}

function compare(v: number, op: (typeof OPS)[number], t: number): boolean {
  switch (op) {
    case '>': return v > t;
    case '>=': return v >= t;
    case '<': return v < t;
    case '<=': return v <= t;
    case '=': return v === t;
    case '!=': return v !== t;
  }
}

/** A few rows as aligned text, for messages. */
function sampleTable(columns: string[], rows: unknown[][], maxRows = 5, maxCols = 6): string {
  if (!rows.length) return '';
  const cols = columns.slice(0, maxCols);
  const cell = (v: unknown) => (v === null || v === undefined ? '∅' : typeof v === 'object' ? JSON.stringify(v) : String(v)).slice(0, 40);
  const body = rows.slice(0, maxRows).map((r) => cols.map((_, i) => cell(r[i])));
  const widths = cols.map((c, i) => Math.max(c.length, ...body.map((r) => r[i]!.length)));
  const line = (vals: string[]) => vals.map((v, i) => v.padEnd(widths[i]!)).join('  ').trimEnd();
  return [line(cols), line(widths.map((w) => '─'.repeat(w))), ...body.map(line), ...(rows.length > maxRows ? [`… ${rows.length - maxRows} more`] : [])].join('\n');
}

export class AlertService {
  private ticker: NodeJS.Timeout | null = null;
  private running = new Set<string>();

  constructor(private readonly store: MetadataStore, private readonly cfg: DuckViewConfig, private readonly workspaces: WorkspaceService, private readonly queries: QueryService, private readonly auth: AuthService, private readonly notifications: NotificationService, private readonly audit: AuditService) {}
  private get db() {
    return this.store.db;
  }
  private get s() {
    return this.store.schema;
  }

  // ------------------------------------------------------------------------------------------ evaluation

  /** Runs the query as `runner` (read scope only) and applies the condition. Never throws for query errors. */
  async evaluate(runner: Principal, workspaceId: string, sql: string, condition: AlertCondition): Promise<Evaluation> {
    const t0 = Date.now();
    const readOnly: Principal = { ...runner, scopes: runner.scopes.filter((x) => x === 'read'), via: 'token', actorType: 'SYSTEM' };
    try {
      const r = await this.queries.run(readOnly, workspaceId, sql, { cache: false, countTotal: false, maxRows: this.cfg.notifications.alert_max_rows });
      const columns = r.columns.map((c) => c.name);
      const base = { columns, rows: r.rows, row_count: r.rowCount, error: null, duration_ms: Date.now() - t0 };
      const count = `${r.rowCount}${r.truncated ? '+' : ''}`;
      if (condition.kind === 'rows') return { ...base, state: r.rowCount > 0 ? 'triggered' : 'ok', value: count, summary: r.rowCount > 0 ? `The query returned ${count} row${r.rowCount === 1 ? '' : 's'}.` : 'The query returned no rows.' };
      if (condition.kind === 'no_rows') return { ...base, state: r.rowCount === 0 ? 'triggered' : 'ok', value: count, summary: r.rowCount === 0 ? 'The query returned no rows.' : `The query returned ${count} row${r.rowCount === 1 ? '' : 's'}.` };
      const idx = columns.findIndex((c) => c.toLowerCase() === condition.column.toLowerCase());
      if (idx < 0) throw new Error(`The query has no column "${condition.column}" (it returns ${columns.join(', ') || 'no columns'})`);
      if (!r.rows.length) throw new Error(`The query returned no rows, so there is no ${condition.column} to compare`);
      const raw = r.rows[0]![idx];
      const v = typeof raw === 'number' ? raw : Number(raw);
      if (raw === null || raw === undefined || Number.isNaN(v)) throw new Error(`${condition.column} is not a number (${String(raw)})`);
      const hit = compare(v, condition.op, condition.value);
      return { ...base, state: hit ? 'triggered' : 'ok', value: String(raw), summary: `${condition.column} is ${raw} — ${hit ? '' : 'not '}${condition.op} ${condition.value}.` };
    } catch (err) {
      const error = ((err as Error).message ?? String(err)).split('\n')[0]!.slice(0, 500);
      return { state: 'error', value: null, summary: `The alert query failed: ${error}`, columns: [], rows: [], row_count: 0, error, duration_ms: Date.now() - t0 };
    }
  }

  /** Tries a query and condition without saving anything (the editor's "Test"). */
  async preview(p: Principal, workspaceId: string, sql: string, condition: AlertCondition): Promise<Evaluation> {
    await this.workspaces.get(p, workspaceId);
    this.checkSql(sql);
    this.checkCondition(condition);
    return this.evaluate(p, workspaceId, sql, condition);
  }

  // ------------------------------------------------------------------------------------------ registry

  private checkSql(sql: string): void {
    if (!sql?.trim()) throw badRequest('sql is required');
    const a = analyzeSql(sql);
    if (a.isMutating) throw badRequest(`An alert only reads: ${a.mutatingVerbs.join(', ')} is not allowed`);
    if (a.statements.length > 1) throw badRequest('An alert runs one statement');
  }

  private checkCondition(c: AlertCondition | undefined): AlertCondition {
    if (!c || !['rows', 'no_rows', 'threshold'].includes(c.kind)) throw badRequest('condition.kind must be rows, no_rows or threshold');
    if (c.kind !== 'threshold') return { kind: c.kind };
    if (!c.column?.trim()) throw badRequest('condition.column is required for a threshold');
    if (!OPS.includes(c.op)) throw badRequest(`condition.op must be one of ${OPS.join(' ')}`);
    if (typeof c.value !== 'number' || !Number.isFinite(c.value)) throw badRequest('condition.value must be a number');
    return { kind: 'threshold', column: c.column.trim(), op: c.op, value: c.value };
  }

  private checkSchedule(s: SyncSchedule | undefined): SyncSchedule {
    const sch = s ?? { kind: 'interval', minutes: 60 };
    if (sch.kind === 'interval' && (!Number.isFinite(sch.minutes) || sch.minutes < 1)) throw badRequest('schedule.minutes must be at least 1');
    nextRunAt(sch); // validates cron expressions
    return sch;
  }

  /** Channels must be the workspace's own or org-wide. */
  private async checkChannels(p: Principal, workspaceId: string, ids: string[] | undefined): Promise<string[]> {
    const wanted = [...new Set(ids ?? [])];
    if (!wanted.length) return [];
    const usable = new Set((await this.notifications.list(p, workspaceId)).map((c) => c.id));
    const bad = wanted.find((id) => !usable.has(id));
    if (bad) throw badRequest(`Channel ${bad} is not a channel of this workspace (or org-wide)`);
    return wanted;
  }

  async list(p: Principal, workspaceId: string): Promise<Alert[]> {
    await this.workspaces.get(p, workspaceId);
    const rows = await this.db.select().from(this.s.alerts).where(eq(this.s.alerts.workspace_id, workspaceId));
    return rows.sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(p: Principal, id: string, minRole: 'VIEWER' | 'EDITOR' = 'VIEWER'): Promise<Alert> {
    const a = (await this.db.select().from(this.s.alerts).where(eq(this.s.alerts.id, id)).limit(1))[0];
    if (!a) throw notFound('Alert');
    await this.workspaces.get(p, a.workspace_id, minRole);
    return a;
  }

  async create(p: Principal, workspaceId: string, input: AlertInput): Promise<Alert> {
    requireWrite(p);
    await this.workspaces.get(p, workspaceId, 'EDITOR');
    const name = (input.name ?? '').trim().slice(0, 120);
    if (!name) throw badRequest('name is required');
    this.checkSql(input.sql ?? '');
    const condition = this.checkCondition(input.condition);
    const schedule = this.checkSchedule(input.schedule);
    if (input.severity && !ALERT_SEVERITIES.includes(input.severity)) throw badRequest(`severity must be ${ALERT_SEVERITIES.join(', ')}`);
    const now = new Date();
    const enabled = input.enabled ?? true;
    const row: Alert = { id: newId(), workspace_id: workspaceId, user_id: p.userId, name, description: input.description?.trim() || null, sql: input.sql!.trim(), condition, schedule, channel_ids: await this.checkChannels(p, workspaceId, input.channel_ids), severity: input.severity ?? 'warning', notify: input.notify === 'always' ? 'always' : 'change', notify_resolved: input.notify_resolved ?? true, enabled, state: 'unknown', last_value: null, last_error: null, last_checked_at: null, last_triggered_at: null, next_run_at: enabled ? nextRunAt(schedule, now) : null, created_at: now, updated_at: now };
    await this.db.insert(this.s.alerts).values(row);
    this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'alert.create', resource: `alert:${row.id}`, ip: p.ip });
    return row;
  }

  async update(p: Principal, id: string, patch: AlertInput): Promise<Alert> {
    requireWrite(p);
    const a = await this.get(p, id, 'EDITOR');
    const set: Partial<Alert> = { updated_at: new Date() };
    if (patch.name !== undefined) set.name = patch.name.trim().slice(0, 120) || a.name;
    if (patch.description !== undefined) set.description = patch.description?.trim() || null;
    if (patch.sql !== undefined) {
      this.checkSql(patch.sql);
      set.sql = patch.sql.trim();
      // Whoever writes the query is who it runs as.
      set.user_id = p.userId;
    }
    if (patch.condition !== undefined) set.condition = this.checkCondition(patch.condition);
    if (patch.schedule !== undefined) set.schedule = this.checkSchedule(patch.schedule);
    if (patch.channel_ids !== undefined) set.channel_ids = await this.checkChannels(p, a.workspace_id, patch.channel_ids);
    if (patch.severity !== undefined) {
      if (!ALERT_SEVERITIES.includes(patch.severity)) throw badRequest(`severity must be ${ALERT_SEVERITIES.join(', ')}`);
      set.severity = patch.severity;
    }
    if (patch.notify !== undefined) set.notify = patch.notify === 'always' ? 'always' : 'change';
    if (patch.notify_resolved !== undefined) set.notify_resolved = patch.notify_resolved;
    if (patch.enabled !== undefined) set.enabled = patch.enabled;
    const next = { ...a, ...set };
    if (patch.schedule !== undefined || patch.enabled !== undefined) set.next_run_at = next.enabled ? nextRunAt(next.schedule) : null;
    // A changed query or condition starts from a clean state.
    if (patch.sql !== undefined || patch.condition !== undefined) Object.assign(set, { state: 'unknown', last_value: null, last_error: null });
    await this.db.update(this.s.alerts).set(set).where(eq(this.s.alerts.id, id));
    this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'alert.update', resource: `alert:${id}`, ip: p.ip });
    return { ...a, ...set };
  }

  async remove(p: Principal, id: string): Promise<void> {
    requireWrite(p);
    await this.get(p, id, 'EDITOR');
    await this.db.delete(this.s.alerts).where(eq(this.s.alerts.id, id));
    this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'alert.delete', resource: `alert:${id}`, ip: p.ip });
  }

  async events(p: Principal, id: string, limit = 50): Promise<AlertEvent[]> {
    await this.get(p, id);
    return this.db.select().from(this.s.alertEvents).where(eq(this.s.alertEvents.alert_id, id)).orderBy(desc(this.s.alertEvents.created_at)).limit(Math.min(limit, 200));
  }

  // ------------------------------------------------------------------------------------------ checking

  /** Runs an alert now (a person, an agent, or the scheduler) and delivers what changed. */
  async run(id: string, triggeredBy: string, p: Principal | null = null): Promise<{ alert: Alert; evaluation: Evaluation; changed: boolean; notified: number }> {
    const a = p ? await this.get(p, id) : (await this.db.select().from(this.s.alerts).where(eq(this.s.alerts.id, id)).limit(1))[0];
    if (!a) throw notFound('Alert');
    if (this.running.has(id)) throw badRequest('This alert is being checked right now');
    this.running.add(id);
    try {
      const owner = await this.auth.findById(a.user_id);
      const evaluation: Evaluation = owner ? await this.evaluate(this.auth.principalFromUser(owner, 'token', 'alerts'), a.workspace_id, a.sql, a.condition) : { state: 'error', value: null, summary: 'The alert\'s author no longer exists', columns: [], rows: [], row_count: 0, error: 'The alert\'s author no longer exists', duration_ms: 0 };
      const prev = a.state;
      const now = new Date();
      const changed = evaluation.state !== prev;
      let deliver: 'triggered' | 'resolved' | 'error' | null = null;
      if (evaluation.state === 'triggered' && (changed || a.notify === 'always')) deliver = 'triggered';
      else if (evaluation.state === 'ok' && prev === 'triggered' && a.notify_resolved) deliver = 'resolved';
      else if (evaluation.state === 'error' && prev !== 'error') deliver = 'error';
      let notified = 0;
      if (deliver && a.channel_ids.length) {
        const ws = (await this.db.select({ name: this.s.workspaces.name }).from(this.s.workspaces).where(eq(this.s.workspaces.id, a.workspace_id)).limit(1))[0];
        const results = await this.notifications.send(a.channel_ids, this.message(a, evaluation, deliver, ws?.name ?? null), `alert:${a.id}`, a.workspace_id);
        notified = results.filter((r) => r.status === 'ok').length;
      }
      const set: Partial<Alert> = { state: evaluation.state, last_value: evaluation.value, last_error: evaluation.error, last_checked_at: now, ...(evaluation.state === 'triggered' && (changed || deliver) ? { last_triggered_at: now } : {}) };
      await this.db.update(this.s.alerts).set(set).where(eq(this.s.alerts.id, id));
      if (changed || deliver || triggeredBy !== 'schedule') {
        await this.db.insert(this.s.alertEvents).values({ id: newId(), alert_id: id, state: evaluation.state, value: evaluation.value, message: evaluation.summary.slice(0, 1000), notified, triggered_by: triggeredBy, created_at: now });
        await this.db.delete(this.s.alertEvents).where(and(eq(this.s.alertEvents.alert_id, id), lt(this.s.alertEvents.created_at, new Date(Date.now() - 90 * 86_400_000)))).catch(() => undefined);
      }
      liveEvents.publish({ type: 'alert', at: now.toISOString(), workspace_id: a.workspace_id, alert_id: id, state: evaluation.state, changed });
      return { alert: { ...a, ...set }, evaluation, changed, notified };
    } finally {
      this.running.delete(id);
    }
  }

  private message(a: Alert, e: Evaluation, kind: 'triggered' | 'resolved' | 'error', workspace: string | null): Notification {
    const title = kind === 'triggered' ? `${a.name}` : kind === 'resolved' ? `Resolved: ${a.name}` : `Alert failing: ${a.name}`;
    const sample = kind === 'triggered' ? sampleTable(e.columns, e.rows) : '';
    return {
      title,
      text: [a.description, e.summary, sample].filter(Boolean).join('\n\n'),
      severity: kind === 'triggered' ? a.severity : kind === 'resolved' ? 'resolved' : 'warning',
      event: `alert.${kind}`,
      dedupKey: `duckview-alert-${a.id}`,
      url: this.notifications.link(`/#/alerts/alerts?alert=${a.id}`),
      fields: [{ label: 'Condition', value: describeCondition(a.condition) }, ...(e.value !== null ? [{ label: 'Value', value: e.value }] : []), ...(workspace ? [{ label: 'Workspace', value: workspace }] : []), { label: 'Checked', value: new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC' }],
      workspace: workspace ? { id: a.workspace_id, name: workspace } : null,
    };
  }

  /** Checks the alerts that are due; called by the ticker and by tests. */
  async tick(now = new Date()): Promise<string[]> {
    const due = await this.db.select().from(this.s.alerts).where(and(eq(this.s.alerts.enabled, true), isNotNull(this.s.alerts.next_run_at), lte(this.s.alerts.next_run_at, now)));
    const ran: string[] = [];
    for (const a of due) {
      // Move the next check first so a slow one is not picked up again by the next tick.
      await this.db.update(this.s.alerts).set({ next_run_at: nextRunAt(a.schedule, now) }).where(eq(this.s.alerts.id, a.id));
      try {
        await this.run(a.id, 'schedule');
        ran.push(a.id);
      } catch (err) {
        logger().warn({ alert: a.id, err: (err as Error).message }, 'Alert check failed');
      }
    }
    return ran;
  }

  start(intervalMs = 30_000): void {
    if (this.ticker) return;
    this.ticker = setInterval(() => void this.tick().catch((err) => logger().warn({ err: (err as Error).message }, 'Alert scheduler tick failed')), intervalMs);
    this.ticker.unref();
  }

  stop(): void {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
  }
}
