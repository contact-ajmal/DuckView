/**
 * Automated insights: semantic-layer metrics watched for values out of their usual range.
 *
 * A metric is computed per day, week or month (metric_time) as a person would compute it — their access policies,
 * read-only. The latest complete period is compared with the periods before it: the usual value is their median
 * (for days, the median of the same weekday once there are three weeks of history), the usual spread the median
 * absolute deviation of what is left, scaled to a standard deviation. A period further than `sensitivity` spreads
 * from usual is unusual. Sums and counts are zero on periods without rows, so a day with no orders is seen.
 *
 * With segment_by, the change is explained by the segments that moved the most (their share of the change) and each
 * of the largest segments is watched on its own. A monitor runs on demand or on a schedule; each unusual period is
 * recorded once as an insight and delivered to the monitor's channels. scan() does the same for every metric with a
 * time dimension without saving anything — what DuckView AI, the Home page and agents use to say what changed.
 */
import { and, desc, eq, gte, isNotNull, lte, sql } from 'drizzle-orm';
import type { MetadataStore } from '../db/index.js';
import { MONITOR_GRAINS, type Insight, type InsightDetail, type InsightDriver, type MetricMonitor, type MonitorGrain, type MonitorLastRun, type SeriesPoint, type SyncSchedule } from '../db/schema/sqlite.js';
import { newId } from '../security/crypto.js';
import type { Principal } from './principal.js';
import { requireWrite } from './principal.js';
import type { WorkspaceService } from './workspaces.js';
import type { AuthService } from './auth.js';
import type { AuditService } from './audit.js';
import type { NotificationService, Notification } from './notifications.js';
import { SemanticCompiler, type SemanticService, type Metric } from './semantic.js';
import { nextRunAt } from './syncs.js';
import { badRequest, notFound } from './errors.js';
import { logger } from '../observability/logger.js';
import { liveEvents } from '../observability/events.js';

export interface MonitorInput {
  name?: string;
  metric?: string;
  grain?: MonitorGrain;
  segment_by?: string | null;
  sensitivity?: number;
  lookback?: number;
  schedule?: SyncSchedule;
  channel_ids?: string[];
  enabled?: boolean;
}

/** One metric (or one segment of it) in its latest complete period, against its usual range. */
export interface Finding {
  metric: string;
  label: string;
  grain: MonitorGrain;
  segment: string | null;
  status: 'anomaly' | 'normal' | 'insufficient';
  period: string | null;
  direction: 'up' | 'down' | null;
  summary: string;
  detail: InsightDetail | null;
}

export interface Detection {
  period: string;
  value: number;
  expected: number;
  low: number;
  high: number;
  score: number;
  change_pct: number | null;
  anomalous: boolean;
  direction: 'up' | 'down';
  /** Points the usual range was taken from. */
  baseline: number;
}

const MIN_BASELINE = 7;
const ZERO_FILLED = new Set(['sum', 'count', 'count_distinct', 'sum_boolean']);

// ------------------------------------------------------------------------------------------ periods

const day = (s: string) => new Date(`${s.slice(0, 10)}T00:00:00Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);

export function nextPeriod(period: string, grain: MonitorGrain): string {
  const d = day(period);
  if (grain === 'day') d.setUTCDate(d.getUTCDate() + 1);
  else if (grain === 'week') d.setUTCDate(d.getUTCDate() + 7);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  return iso(d);
}

/** The start of the period `now` falls in (weeks start on Monday, as date_trunc('week') does). */
export function periodStart(now: Date, grain: MonitorGrain): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), grain === 'month' ? 1 : now.getUTCDate()));
  if (grain === 'week') d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return iso(d);
}

export function periodLabel(period: string, grain: MonitorGrain): string {
  if (grain === 'month') return day(period).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const s = day(period).toLocaleDateString('en-US', { weekday: grain === 'day' ? 'short' : undefined, month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  return grain === 'week' ? `the week of ${s}` : s;
}

/**
 * Sorts a series, fills periods without rows with zero (sums and counts; up to `until` when given), and leaves out
 * the period `now` is in (it is not over yet) and anything after `until`.
 */
export function prepareSeries(points: SeriesPoint[], grain: MonitorGrain, opts: { zeroFill: boolean; now?: Date; until?: string }): SeriesPoint[] {
  const byPeriod = new Map<string, number | null>();
  for (const p of points) byPeriod.set(p.period.slice(0, 10), p.value === null || p.value === undefined || !Number.isFinite(Number(p.value)) ? null : Number(p.value));
  const current = periodStart(opts.now ?? new Date(), grain);
  const periods = [...byPeriod.keys()].filter((p) => p < current && (!opts.until || p <= opts.until)).sort();
  if (!periods.length) return [];
  if (!opts.zeroFill) return periods.map((p) => ({ period: p, value: byPeriod.get(p)! }));
  const out: SeriesPoint[] = [];
  const last = opts.until && opts.until > periods.at(-1)! ? opts.until : periods.at(-1)!;
  for (let p = periods[0]!, guard = 0; p <= last && guard < 5000; p = nextPeriod(p, grain), guard++) out.push({ period: p, value: byPeriod.get(p) ?? 0 });
  return out;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** Compares the last point of a series with the `lookback` points before it. Null without enough history. */
export function detect(series: SeriesPoint[], opts: { grain: MonitorGrain; sensitivity: number; lookback: number }): Detection | null {
  const pts = series.filter((p): p is { period: string; value: number } => p.value !== null);
  const current = pts.at(-1);
  if (!current) return null;
  const base = pts.slice(0, -1).slice(-opts.lookback);
  if (base.length < MIN_BASELINE) return null;
  let expected: number;
  let residuals: number[];
  const weekday = (p: string) => day(p).getUTCDay();
  if (opts.grain === 'day' && base.length >= 21) {
    // Weekly pattern: each weekday against its own median.
    const byDay = new Map<number, number[]>();
    for (const p of base) byDay.set(weekday(p.period), [...(byDay.get(weekday(p.period)) ?? []), p.value]);
    const medians = new Map([...byDay].map(([k, v]) => [k, median(v)]));
    const same = byDay.get(weekday(current.period)) ?? [];
    expected = same.length >= 3 ? medians.get(weekday(current.period))! : median(base.map((p) => p.value));
    residuals = base.map((p) => p.value - (same.length >= 3 ? medians.get(weekday(p.period))! : expected));
  } else {
    expected = median(base.map((p) => p.value));
    residuals = base.map((p) => p.value - expected);
  }
  let spread = 1.4826 * median(residuals.map(Math.abs));
  if (!(spread > 0)) {
    // Mostly constant: fall back to the standard deviation, then to a sliver of the value itself.
    const mean = residuals.reduce((a, b) => a + b, 0) / residuals.length;
    spread = Math.sqrt(residuals.reduce((a, r) => a + (r - mean) ** 2, 0) / residuals.length);
    if (!(spread > 0)) spread = Math.max(Math.abs(expected) * 0.01, 1e-9);
  }
  const score = (current.value - expected) / spread;
  const nonNegative = base.every((p) => p.value >= 0) && current.value >= 0;
  const low = expected - opts.sensitivity * spread;
  return {
    period: current.period,
    value: current.value,
    expected,
    low: nonNegative ? Math.max(0, low) : low,
    high: expected + opts.sensitivity * spread,
    score: Math.max(-999, Math.min(999, score)),
    change_pct: expected !== 0 ? (current.value - expected) / Math.abs(expected) : null,
    anomalous: Math.abs(score) >= opts.sensitivity && current.value !== expected,
    direction: current.value >= expected ? 'up' : 'down',
    baseline: base.length,
  };
}

export function fmtNumber(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return '—';
  const a = Math.abs(n);
  if (a >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (a >= 1e4) return `${(n / 1e3).toFixed(1)}K`;
  return Number.isInteger(n) ? n.toLocaleString('en-US') : n.toLocaleString('en-US', { maximumFractionDigits: a < 1 ? 3 : 2 });
}

/** "Revenue for region = EU was 120 on Mon, Feb 16, 2026 — 64% below the usual 330 (usual range 250–410)." */
export function describe(label: string, grain: MonitorGrain, d: Detection, segment: string | null, drivers: InsightDriver[] = []): string {
  const who = segment ? `${label} for ${segment}` : label;
  const pct = d.change_pct === null ? '' : `${Math.round(Math.abs(d.change_pct) * 100)}% `;
  const head = d.anomalous
    ? `${who} was ${fmtNumber(d.value)} ${grain === 'day' ? 'on' : 'in'} ${periodLabel(d.period, grain)} — ${pct}${d.direction === 'up' ? 'above' : 'below'} the usual ${fmtNumber(d.expected)} (usual range ${fmtNumber(d.low)}–${fmtNumber(d.high)}).`
    : `${who} was ${fmtNumber(d.value)} ${grain === 'day' ? 'on' : 'in'} ${periodLabel(d.period, grain)}, within the usual range (${fmtNumber(d.low)}–${fmtNumber(d.high)}).`;
  if (!d.anomalous || !drivers.length) return head;
  const top = drivers.slice(0, 2).map((x) => `${x.segment} (${x.delta > 0 ? '+' : '−'}${fmtNumber(Math.abs(x.delta))}${x.share !== null ? `, ${Math.round(x.share * 100)}% of the change` : ''})`);
  return `${head} Most of the ${d.direction === 'up' ? 'rise' : 'drop'} came from ${top.join(' and ')}.`;
}

// ------------------------------------------------------------------------------------------ service

export class InsightService {
  private ticker: NodeJS.Timeout | null = null;
  private running = new Set<string>();

  constructor(private readonly store: MetadataStore, private readonly workspaces: WorkspaceService, private readonly semantic: SemanticService, private readonly auth: AuthService, private readonly notifications: NotificationService, private readonly audit: AuditService) {}
  private get db() {
    return this.store.db;
  }
  private get s() {
    return this.store.schema;
  }

  // ------------------------------------------------------------------------------------------ detecting

  private async metricInfo(workspaceId: string, name: string): Promise<{ metric: Metric; label: string; zeroFill: boolean; compiler: SemanticCompiler }> {
    const def = await this.semantic.definition(workspaceId);
    const metric = def.metrics.find((m) => m.name === name);
    if (!metric) throw badRequest(`Unknown metric ${name}${def.metrics.length ? ` (the workspace has ${def.metrics.slice(0, 12).map((m) => m.name).join(', ')})` : ' — the workspace has no metrics yet'}`);
    const compiler = new SemanticCompiler(def);
    let zeroFill = false;
    if (metric.type === 'simple') {
      const measure = def.semantic_models.flatMap((m) => m.measures).find((x) => x.name === metric.measure);
      zeroFill = !!measure && ZERO_FILLED.has(measure.agg);
    }
    return { metric, label: metric.label || metric.name, zeroFill, compiler };
  }

  /** The metric overall, and (with segmentBy) its largest segments, each in its latest complete period. */
  async evaluate(p: Principal, workspaceId: string, o: { metric: string; grain: MonitorGrain; segment_by?: string | null; sensitivity?: number; lookback?: number; now?: Date; maxSegments?: number }): Promise<Finding[]> {
    const { label, zeroFill, compiler } = await this.metricInfo(workspaceId, o.metric);
    const dims = compiler.dimensionsFor([o.metric]).map((d) => d.name);
    if (!dims.includes('metric_time')) throw badRequest(`${o.metric} has no time dimension to watch over time (set default_time_dimension on its semantic model)`);
    if (o.segment_by && !dims.includes(o.segment_by)) throw badRequest(`${o.metric} cannot be broken down by ${o.segment_by} (it can by ${dims.filter((d) => d !== 'metric_time').slice(0, 12).join(', ') || 'nothing else'})`);
    const sensitivity = o.sensitivity ?? 3;
    const lookback = o.lookback ?? 28;
    const time = `metric_time__${o.grain}`;
    const readOnly: Principal = { ...p, scopes: p.scopes.filter((s) => s === 'read' || s === 'admin') };
    const opts = { grain: o.grain, sensitivity, lookback };
    // Newest first, so a long history is cut at the old end.
    const total = await this.semantic.query(readOnly, workspaceId, { metrics: [o.metric], group_by: [time], order_by: [{ name: time, desc: true }], limit: lookback + 3 });
    const series = prepareSeries(total.result.rows.map((r) => ({ period: String(r[0] ?? ''), value: r[1] === null ? null : Number(r[1]) })).filter((x) => x.period), o.grain, { zeroFill, now: o.now }).slice(-(lookback + 1));
    const d = detect(series, opts);
    if (!d) return [{ metric: o.metric, label, grain: o.grain, segment: null, status: 'insufficient', period: series.at(-1)?.period ?? null, direction: null, summary: `${label}: not enough history yet (${Math.max(0, series.length - 1)} complete ${o.grain}s before the latest; ${MIN_BASELINE} needed).`, detail: null }];
    const findings: Finding[] = [];
    let drivers: InsightDriver[] = [];
    const segments: Finding[] = [];
    if (o.segment_by) {
      const from = series[0]!.period;
      const seg = await this.semantic.query(readOnly, workspaceId, { metrics: [o.metric], group_by: [time, o.segment_by], where: [{ dimension: time, op: '>=', value: from }], limit: 10_000 });
      const bySeg = new Map<string, SeriesPoint[]>();
      for (const r of seg.result.rows) {
        const key = r[1] === null ? '(empty)' : String(r[1]);
        bySeg.set(key, [...(bySeg.get(key) ?? []), { period: String(r[0] ?? ''), value: r[2] === null ? null : Number(r[2]) }]);
      }
      const size = (pts: SeriesPoint[]) => pts.reduce((a, x) => a + Math.abs(x.value ?? 0), 0);
      const largest = [...bySeg].sort((a, b) => size(b[1]) - size(a[1])).slice(0, o.maxSegments ?? 12);
      const moves: InsightDriver[] = [];
      for (const [name, pts] of largest) {
        // A segment's series is cut to the same periods as the total so "latest" means the same period.
        const s = prepareSeries(pts, o.grain, { zeroFill, now: o.now, until: d.period });
        const sd = detect(s, opts);
        const segment = `${o.segment_by} = ${name}`;
        if (!sd || sd.period !== d.period) continue;
        moves.push({ segment, value: sd.value, expected: sd.expected, delta: sd.value - sd.expected, share: null });
        segments.push({ metric: o.metric, label, grain: o.grain, segment, status: sd.anomalous ? 'anomaly' : 'normal', period: sd.period, direction: sd.direction, summary: describe(label, o.grain, sd, segment), detail: { ...sd, series: s.slice(-(lookback + 1)), drivers: [], segment_by: o.segment_by } });
      }
      const change = d.value - d.expected;
      const same = moves.filter((m) => Math.sign(m.delta) === Math.sign(change) && m.delta !== 0).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
      const sum = same.reduce((a, m) => a + m.delta, 0);
      drivers = same.slice(0, 5).map((m) => ({ ...m, share: sum !== 0 ? m.delta / sum : null }));
    }
    findings.push({ metric: o.metric, label, grain: o.grain, segment: null, status: d.anomalous ? 'anomaly' : 'normal', period: d.period, direction: d.direction, summary: describe(label, o.grain, d, null, drivers), detail: { value: d.value, expected: d.expected, low: d.low, high: d.high, score: d.score, change_pct: d.change_pct, series, drivers, segment_by: o.segment_by ?? null } });
    return [...findings, ...segments.filter((f) => f.status === 'anomaly').sort((a, b) => Math.abs(b.detail!.score) - Math.abs(a.detail!.score))];
  }

  /** Every metric with a time dimension (or the ones named), unusual first. Nothing is saved. */
  async scan(p: Principal, workspaceId: string, o: { metrics?: string[]; grain?: MonitorGrain; sensitivity?: number; segment_by?: string | null; now?: Date } = {}): Promise<{ findings: Finding[]; errors: { metric: string; error: string }[] }> {
    await this.workspaces.get(p, workspaceId);
    const def = await this.semantic.definition(workspaceId);
    const compiler = new SemanticCompiler(def);
    const names = (o.metrics?.length ? o.metrics : def.metrics.map((m) => m.name)).slice(0, 25);
    const findings: Finding[] = [];
    const errors: { metric: string; error: string }[] = [];
    for (const name of names) {
      try {
        if (!o.metrics?.length && !compiler.dimensionsFor([name]).some((d) => d.name === 'metric_time')) continue;
        const segmentBy = o.segment_by && compiler.dimensionsFor([name]).some((d) => d.name === o.segment_by) ? o.segment_by : null;
        findings.push(...(await this.evaluate(p, workspaceId, { metric: name, grain: o.grain ?? 'day', sensitivity: o.sensitivity, segment_by: segmentBy, now: o.now })));
      } catch (err) {
        errors.push({ metric: name, error: ((err as Error).message ?? String(err)).split('\n')[0]!.slice(0, 300) });
      }
    }
    const rank = { anomaly: 0, normal: 1, insufficient: 2 } as const;
    findings.sort((a, b) => rank[a.status] - rank[b.status] || Math.abs(b.detail?.score ?? 0) - Math.abs(a.detail?.score ?? 0));
    return { findings, errors };
  }

  // ------------------------------------------------------------------------------------------ monitors

  private checkSchedule(input: SyncSchedule | undefined): SyncSchedule {
    const sch = input ?? { kind: 'manual' };
    if (sch.kind === 'interval' && (!Number.isFinite(sch.minutes) || sch.minutes < 5)) throw badRequest('schedule.minutes must be at least 5');
    nextRunAt(sch);
    return sch;
  }

  private async checkChannels(p: Principal, workspaceId: string, ids: string[] | undefined): Promise<string[]> {
    const wanted = [...new Set(ids ?? [])];
    if (!wanted.length) return [];
    const usable = new Set((await this.notifications.list(p, workspaceId)).map((c) => c.id));
    const bad = wanted.find((id) => !usable.has(id));
    if (bad) throw badRequest(`Channel ${bad} is not a channel of this workspace (or org-wide)`);
    return wanted;
  }

  private async checkMetric(workspaceId: string, metric: string, segmentBy: string | null): Promise<void> {
    const { compiler } = await this.metricInfo(workspaceId, metric);
    const dims = compiler.dimensionsFor([metric]).map((d) => d.name);
    if (!dims.includes('metric_time')) throw badRequest(`${metric} has no time dimension to watch over time (set default_time_dimension on its semantic model)`);
    if (segmentBy && !dims.includes(segmentBy)) throw badRequest(`${metric} cannot be broken down by ${segmentBy}`);
  }

  private shape(input: MonitorInput) {
    if (input.grain !== undefined && !MONITOR_GRAINS.includes(input.grain)) throw badRequest(`grain must be ${MONITOR_GRAINS.join(', ')}`);
    if (input.sensitivity !== undefined && !(input.sensitivity >= 1 && input.sensitivity <= 10)) throw badRequest('sensitivity must be between 1 and 10');
    if (input.lookback !== undefined && !(input.lookback >= MIN_BASELINE && input.lookback <= 400)) throw badRequest(`lookback must be between ${MIN_BASELINE} and 400 periods`);
  }

  async list(p: Principal, workspaceId: string): Promise<MetricMonitor[]> {
    await this.workspaces.get(p, workspaceId);
    const rows = await this.db.select().from(this.s.metricMonitors).where(eq(this.s.metricMonitors.workspace_id, workspaceId));
    return rows.sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(p: Principal, id: string, minRole: 'VIEWER' | 'EDITOR' = 'VIEWER'): Promise<MetricMonitor> {
    const m = (await this.db.select().from(this.s.metricMonitors).where(eq(this.s.metricMonitors.id, id)).limit(1))[0];
    if (!m) throw notFound('Metric monitor');
    await this.workspaces.get(p, m.workspace_id, minRole);
    return m;
  }

  async create(p: Principal, workspaceId: string, input: MonitorInput): Promise<MetricMonitor> {
    requireWrite(p);
    await this.workspaces.get(p, workspaceId, 'EDITOR');
    this.shape(input);
    const metric = (input.metric ?? '').trim();
    if (!metric) throw badRequest('metric is required');
    const segmentBy = input.segment_by?.trim() || null;
    await this.checkMetric(workspaceId, metric, segmentBy);
    const grain = input.grain ?? 'day';
    const schedule = this.checkSchedule(input.schedule);
    const now = new Date();
    const enabled = input.enabled ?? true;
    const row: MetricMonitor = { id: newId(), workspace_id: workspaceId, user_id: p.userId, name: (input.name ?? '').trim().slice(0, 120) || `${metric} by ${grain}`, metric, grain, segment_by: segmentBy, sensitivity: Math.round(input.sensitivity ?? 3), lookback: Math.round(input.lookback ?? 28), schedule, channel_ids: await this.checkChannels(p, workspaceId, input.channel_ids), enabled, status: 'unknown', last_run: null, next_run_at: enabled ? nextRunAt(schedule, now) : null, created_at: now, updated_at: now };
    await this.db.insert(this.s.metricMonitors).values(row);
    this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'monitor.create', resource: `monitor:${row.id}`, ip: p.ip });
    return row;
  }

  async update(p: Principal, id: string, patch: MonitorInput): Promise<MetricMonitor> {
    requireWrite(p);
    const m = await this.get(p, id, 'EDITOR');
    this.shape(patch);
    const set: Partial<MetricMonitor> = { updated_at: new Date() };
    if (patch.name !== undefined) set.name = patch.name.trim().slice(0, 120) || m.name;
    if (patch.metric !== undefined || patch.segment_by !== undefined) {
      const metric = patch.metric?.trim() || m.metric;
      const segmentBy = patch.segment_by === undefined ? m.segment_by : patch.segment_by?.trim() || null;
      await this.checkMetric(m.workspace_id, metric, segmentBy);
      Object.assign(set, { metric, segment_by: segmentBy, user_id: p.userId });
    }
    if (patch.grain !== undefined) set.grain = patch.grain;
    if (patch.sensitivity !== undefined) set.sensitivity = Math.round(patch.sensitivity);
    if (patch.lookback !== undefined) set.lookback = Math.round(patch.lookback);
    if (patch.schedule !== undefined) set.schedule = this.checkSchedule(patch.schedule);
    if (patch.channel_ids !== undefined) set.channel_ids = await this.checkChannels(p, m.workspace_id, patch.channel_ids);
    if (patch.enabled !== undefined) set.enabled = patch.enabled;
    const next = { ...m, ...set };
    if (patch.schedule !== undefined || patch.enabled !== undefined) set.next_run_at = next.enabled ? nextRunAt(next.schedule) : null;
    await this.db.update(this.s.metricMonitors).set(set).where(eq(this.s.metricMonitors.id, id));
    this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'monitor.update', resource: `monitor:${id}`, ip: p.ip });
    return { ...m, ...set };
  }

  async remove(p: Principal, id: string): Promise<void> {
    requireWrite(p);
    await this.get(p, id, 'EDITOR');
    await this.db.delete(this.s.metricMonitors).where(eq(this.s.metricMonitors.id, id));
    this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'monitor.delete', resource: `monitor:${id}`, ip: p.ip });
  }

  /** Runs a monitor now: records each new unusual period once and delivers it to the monitor's channels. */
  async run(id: string, p: Principal | null = null, now?: Date): Promise<{ monitor: MetricMonitor; findings: Finding[]; created: Insight[]; notified: number }> {
    const m = p ? await this.get(p, id) : (await this.db.select().from(this.s.metricMonitors).where(eq(this.s.metricMonitors.id, id)).limit(1))[0];
    if (!m) throw notFound('Metric monitor');
    if (this.running.has(id)) throw badRequest('This monitor is running right now');
    this.running.add(id);
    try {
      const owner = await this.auth.findActive(m.user_id);
      let findings: Finding[] = [];
      let last: MonitorLastRun;
      const created: Insight[] = [];
      try {
        if (!owner) throw new Error('The monitor\'s author no longer exists or has been deactivated.');
        findings = await this.evaluate(this.auth.principalFromUser(owner, 'jwt', 'monitor'), m.workspace_id, { metric: m.metric, grain: m.grain, segment_by: m.segment_by, sensitivity: m.sensitivity, lookback: m.lookback, now });
        for (const f of findings.filter((x) => x.status === 'anomaly')) {
          const row: Insight = { id: newId(), workspace_id: m.workspace_id, monitor_id: m.id, key: `${m.id}|${f.period}|${f.segment ?? ''}`, metric: m.metric, grain: m.grain, period: f.period!, segment: f.segment, direction: f.direction!, summary: f.summary, detail: f.detail!, status: 'new', created_at: new Date() };
          const inserted = await this.db.insert(this.s.insights).values(row).onConflictDoNothing().returning({ id: this.s.insights.id });
          if (inserted.length) created.push(row);
        }
        const overall = findings[0]!;
        const unusual = findings.filter((f) => f.status === 'anomaly');
        last = { status: unusual.length ? 'anomaly' : 'normal', summary: unusual.length ? unusual[0]!.summary : overall.summary, period: overall.period, finished_at: new Date().toISOString() };
      } catch (err) {
        last = { status: 'error', summary: ((err as Error).message ?? String(err)).split('\n')[0]!.slice(0, 300), period: null, finished_at: new Date().toISOString() };
      }
      let notified = 0;
      if (created.length && m.channel_ids.length) {
        const ws = (await this.db.select({ name: this.s.workspaces.name }).from(this.s.workspaces).where(eq(this.s.workspaces.id, m.workspace_id)).limit(1))[0];
        const sent = await this.notifications.send(m.channel_ids, this.message(m, created, ws?.name ?? null), `monitor:${m.id}`, m.workspace_id);
        notified = sent.filter((r) => r.status === 'ok').length;
      }
      await this.db.update(this.s.metricMonitors).set({ status: last.status, last_run: last }).where(eq(this.s.metricMonitors.id, id));
      if (created.length) liveEvents.publish({ type: 'insight', at: new Date().toISOString(), workspace_id: m.workspace_id, monitor_id: id, count: created.length });
      return { monitor: { ...m, status: last.status, last_run: last }, findings, created, notified };
    } finally {
      this.running.delete(id);
    }
  }

  private message(m: MetricMonitor, created: Insight[], workspace: string | null): Notification {
    const lead = created.find((i) => !i.segment) ?? created[0]!;
    return {
      title: `Unusual ${m.name}: ${lead.direction === 'up' ? 'above' : 'below'} its usual range`,
      text: created.slice(0, 6).map((i) => i.summary).join('\n\n'),
      severity: 'warning',
      event: 'insight.anomaly',
      dedupKey: `duckview-monitor-${m.id}-${lead.period}`,
      url: this.notifications.link(`/#/transform/metrics?view=monitors&insight=${lead.id}`),
      fields: [{ label: 'Metric', value: m.metric }, { label: 'Period', value: periodLabel(lead.period, m.grain) }, ...(workspace ? [{ label: 'Workspace', value: workspace }] : [])],
      workspace: workspace ? { id: m.workspace_id, name: workspace } : null,
    };
  }

  // ------------------------------------------------------------------------------------------ insights

  async insights(p: Principal, workspaceId: string, o: { status?: 'new' | 'dismissed' | 'all'; monitor_id?: string; limit?: number } = {}): Promise<Insight[]> {
    await this.workspaces.get(p, workspaceId);
    const conds = [eq(this.s.insights.workspace_id, workspaceId)];
    const status = o.status ?? 'new';
    if (status !== 'all') conds.push(eq(this.s.insights.status, status));
    if (o.monitor_id) conds.push(eq(this.s.insights.monitor_id, o.monitor_id));
    return this.db.select().from(this.s.insights).where(and(...conds)).orderBy(desc(this.s.insights.period), sql`CASE WHEN ${this.s.insights.segment} IS NULL THEN 0 ELSE 1 END`, desc(this.s.insights.created_at)).limit(Math.min(o.limit ?? 50, 500));
  }

  async setStatus(p: Principal, id: string, status: 'new' | 'dismissed'): Promise<Insight> {
    const row = (await this.db.select().from(this.s.insights).where(eq(this.s.insights.id, id)).limit(1))[0];
    if (!row) throw notFound('Insight');
    await this.workspaces.get(p, row.workspace_id, 'EDITOR');
    await this.db.update(this.s.insights).set({ status }).where(eq(this.s.insights.id, id));
    return { ...row, status };
  }

  /** For DuckView AI: the unusual periods found in the last 30 days that nobody dismissed. */
  async promptSummary(workspaceId: string): Promise<string> {
    const since = new Date(Date.now() - 30 * 86_400_000);
    const rows = await this.db.select().from(this.s.insights).where(and(eq(this.s.insights.workspace_id, workspaceId), eq(this.s.insights.status, 'new'), gte(this.s.insights.created_at, since))).orderBy(desc(this.s.insights.period)).limit(12);
    return rows.map((r) => `- ${r.metric} (${r.grain} ${r.period}${r.segment ? `, ${r.segment}` : ''}): ${r.summary}`).join('\n');
  }

  // ------------------------------------------------------------------------------------------ scheduling

  async tick(now = new Date()): Promise<string[]> {
    const due = await this.db.select().from(this.s.metricMonitors).where(and(eq(this.s.metricMonitors.enabled, true), isNotNull(this.s.metricMonitors.next_run_at), lte(this.s.metricMonitors.next_run_at, now)));
    const ran: string[] = [];
    for (const m of due) {
      await this.db.update(this.s.metricMonitors).set({ next_run_at: nextRunAt(m.schedule, now) }).where(eq(this.s.metricMonitors.id, m.id));
      try {
        await this.run(m.id);
        ran.push(m.id);
      } catch (err) {
        logger().warn({ monitor: m.id, err: (err as Error).message }, 'Metric monitor run failed');
      }
    }
    return ran;
  }

  start(intervalMs = 30_000): void {
    if (this.ticker) return;
    this.ticker = setInterval(() => void this.tick().catch((err) => logger().warn({ err: (err as Error).message }, 'Monitor scheduler tick failed')), intervalMs);
    this.ticker.unref();
  }

  stop(): void {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
  }
}
