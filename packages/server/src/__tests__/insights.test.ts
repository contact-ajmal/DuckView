/**
 * Automated insights: the detector (median and robust spread, the weekday pattern, zero for days without rows, the
 * unfinished period left out), monitors that record each unusual period once with the segments that drove it and
 * deliver it to channels, a scan of every metric, the agent tools, and DuckView AI's context.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../config/index.js';
import { initLogger } from '../observability/logger.js';
import { createContext, type AppContext } from '../context.js';
import { buildTools, runTool, type ToolEnv } from '../agent/tools.js';
import { detect, prepareSeries, periodStart, describe as describeDetection } from '../services/insights.js';
import type { Principal } from '../services/principal.js';

let dir: string;
let ctx: AppContext;
let wsId: string;
let admin: Principal;
let receiver: http.Server;
let hookUrl: string;
const received: Record<string, unknown>[] = [];
// "Now" is the morning of Tuesday 2026-03-10: Monday the 9th is the latest complete day.
const NOW = new Date('2026-03-10T09:00:00Z');

const days = (from: string, n: number) => Array.from({ length: n }, (_, i) => new Date(Date.parse(`${from}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10));

beforeAll(async () => {
  initLogger({ level: 'silent', stderr: true, pretty: false });
  receiver = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => {
      received.push(JSON.parse(b || '{}'));
      res.end('ok');
    });
  });
  await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
  hookUrl = `http://127.0.0.1:${(receiver.address() as net.AddressInfo).port}/hook`;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dv-insights-'));
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  const cfg = loadConfig({ configPath: null, env: { DUCKVIEW_DATA_DIR: path.join(dir, 'data'), DUCKDB_TEMP_DIRECTORY: path.join(dir, 'spill'), DATABASE_URL: ':memory:', DUCKDB_MEMORY_LIMIT: '512MB', DUCKVIEW_ADMIN_EMAIL: 'admin@test.local', DUCKVIEW_ADMIN_PASSWORD: 'super-secret-pw', DUCKVIEW__duckdb__sync_scheduler_enabled: 'false', DUCKVIEW__notifications__scheduler_enabled: 'false', DUCKVIEW__notifications__allow_private_targets: 'true', DUCKVIEW__transform__scheduler_enabled: 'false', DUCKVIEW__apps__enabled: 'false', LOG_LEVEL: 'silent' } });
  ctx = await createContext(cfg);
  admin = ctx.auth.principalFromUser((await ctx.auth.findByEmail('admin@test.local'))!, 'jwt', '127.0.0.1');
  wsId = (await ctx.workspaces.create(admin, { name: 'Shop', active_db_path: 'shop.duckdb' })).id;
  // 35 days of orders: EU 10 a day, US 5 a day; on the last complete day (2026-03-09) EU sells 1 and US 5.
  // Nothing at all on 2026-02-20 in US (a day without rows is zero, not missing).
  const rows: string[] = [];
  let id = 0;
  for (const d of days('2026-02-03', 35)) {
    const eu = d === '2026-03-09' ? 1 : 10;
    const us = d === '2026-02-20' ? 0 : 5;
    for (let i = 0; i < eu; i++) rows.push(`(${++id}, DATE '${d}', 'EU', 20.0)`);
    for (let i = 0; i < us; i++) rows.push(`(${++id}, DATE '${d}', 'US', 20.0)`);
  }
  // Today's partial day must not count.
  rows.push(`(${++id}, DATE '2026-03-10', 'EU', 20.0)`);
  await ctx.queries.run(admin, wsId, `CREATE TABLE orders AS SELECT * FROM (VALUES ${rows.join(', ')}) t(id, order_date, region, amount)`, { cache: false });
  await ctx.semantic.save(admin, wsId, `semantic_models:
  - name: orders
    table: orders
    default_time_dimension: order_date
    dimensions:
      - { name: order_date, type: time }
      - { name: region, type: categorical }
    measures:
      - { name: revenue, agg: sum, expr: amount }
      - { name: order_count, agg: count }
      - { name: avg_amount, agg: avg, expr: amount }
metrics:
  - { name: total_revenue, label: Revenue, type: simple, measure: revenue }
  - { name: orders, type: simple, measure: order_count }
  - { name: avg_order, label: Average order, type: simple, measure: avg_amount }
`);
}, 120_000);

afterAll(async () => {
  await ctx?.shutdown();
  receiver?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('the detector', () => {
  const flat = (values: number[]) => values.map((value, i) => ({ period: days('2026-01-01', values.length)[i]!, value }));

  it('flags a value far outside the usual range, and only then', () => {
    const noisy = [100, 104, 97, 101, 99, 103, 96, 100, 102, 98];
    const spike = detect(flat([...noisy, 160]), { grain: 'day', sensitivity: 3, lookback: 28 })!;
    expect(spike).toMatchObject({ anomalous: true, direction: 'up', expected: 100 });
    expect(spike.change_pct).toBeCloseTo(0.6);
    expect(spike.low).toBeLessThan(100);
    expect(spike.high).toBeLessThan(160);
    expect(detect(flat([...noisy, 104]), { grain: 'day', sensitivity: 3, lookback: 28 })!.anomalous).toBe(false);
    // Too little history is not a verdict.
    expect(detect(flat([1, 2, 3, 50]), { grain: 'day', sensitivity: 3, lookback: 28 })).toBeNull();
    // A constant series: any move is unusual; staying put is not.
    expect(detect(flat([...Array(10).fill(5), 6]), { grain: 'day', sensitivity: 3, lookback: 28 })!.anomalous).toBe(true);
    expect(detect(flat([...Array(10).fill(5), 5]), { grain: 'day', sensitivity: 3, lookback: 28 })!.anomalous).toBe(false);
  });

  it('knows the weekly pattern of daily numbers', () => {
    // Weekends are quiet (20) and weekdays busy (100): a quiet Sunday is normal, a quiet Wednesday is not.
    const series = days('2026-01-05', 36).map((d) => ({ period: d, value: [0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay()) ? 20 + (d.charCodeAt(9) % 3) : 100 + (d.charCodeAt(9) % 5) }));
    const sunday = series.findLast((p) => new Date(`${p.period}T00:00:00Z`).getUTCDay() === 0)!;
    const upToSunday = series.slice(0, series.indexOf(sunday) + 1);
    expect(detect(upToSunday, { grain: 'day', sensitivity: 3, lookback: 28 })!.anomalous).toBe(false);
    const wednesday = series.findLast((p) => new Date(`${p.period}T00:00:00Z`).getUTCDay() === 3)!;
    const quietWednesday = [...series.slice(0, series.indexOf(wednesday)), { period: wednesday.period, value: 20 }];
    expect(detect(quietWednesday, { grain: 'day', sensitivity: 3, lookback: 28 })).toMatchObject({ anomalous: true, direction: 'down' });
  });

  it('fills days without rows with zero and leaves out the unfinished period', () => {
    const s = prepareSeries([{ period: '2026-03-01', value: 5 }, { period: '2026-03-03', value: 7 }, { period: '2026-03-10', value: 1 }], 'day', { zeroFill: true, now: NOW });
    expect(s).toEqual([{ period: '2026-03-01', value: 5 }, { period: '2026-03-02', value: 0 }, { period: '2026-03-03', value: 7 }]);
    expect(prepareSeries([{ period: '2026-03-01', value: 5 }, { period: '2026-03-03', value: 7 }], 'day', { zeroFill: false, now: NOW })).toHaveLength(2);
    expect([periodStart(NOW, 'day'), periodStart(NOW, 'week'), periodStart(NOW, 'month')]).toEqual(['2026-03-10', '2026-03-09', '2026-03-01']);
    const d = detect([...Array(10).fill(0).map((_, i) => ({ period: days('2026-02-01', 11)[i]!, value: 100 + (i % 3) })), { period: '2026-02-11', value: 20 }], { grain: 'day', sensitivity: 3, lookback: 28 })!;
    expect(describeDetection('Revenue', 'day', d, null, [{ segment: 'region = EU', value: 5, expected: 80, delta: -75, share: 0.9 }])).toBe('Revenue was 20 on Wed, Feb 11, 2026 — 80% below the usual 101 (usual range 96.55–105.45). Most of the drop came from region = EU (−75, 90% of the change).');
  });
});

describe('metric monitors', () => {
  it('records an unusual day once, with the segments that drove it, and delivers it', async () => {
    const { channel } = await ctx.notifications.create(admin, wsId, { name: 'Hook', type: 'webhook', secret: { url: hookUrl } } as never);
    const m = await ctx.insights.create(admin, wsId, { metric: 'total_revenue', grain: 'day', segment_by: 'region', channel_ids: [channel.id] });
    expect(m).toMatchObject({ name: 'total_revenue by day', sensitivity: 3, lookback: 28, status: 'unknown' });
    const r = await ctx.insights.run(m.id, admin, NOW);
    const overall = r.findings[0]!;
    // 2026-03-09: EU 1 × 20 + US 5 × 20 = 120 against the usual 300.
    expect(overall).toMatchObject({ status: 'anomaly', period: '2026-03-09', direction: 'down', segment: null });
    expect(overall.detail).toMatchObject({ value: 120, expected: 300 });
    expect(overall.detail!.drivers[0]).toMatchObject({ segment: 'region = EU', value: 20, expected: 200, delta: -180, share: 1 });
    expect(overall.summary).toMatch(/^Revenue was 120 on Mon, Mar 9, 2026 — 60% below the usual 300 .* Most of the drop came from region = EU \(−180, 100% of the change\)\.$/);
    // EU on its own is unusual too; US is not.
    expect(r.findings.map((f) => f.segment)).toEqual([null, 'region = EU']);
    expect(r.created).toHaveLength(2);
    expect(r.monitor.status).toBe('anomaly');
    expect(r.notified).toBe(1);
    expect(JSON.stringify(received.at(-1))).toMatch(/Unusual total_revenue by day: below its usual range/);
    // The zero day in US is part of the history, not skipped.
    expect(overall.detail!.series.find((p) => p.period === '2026-02-20')).toEqual({ period: '2026-02-20', value: 200 });
    // Running again finds the same day: nothing new recorded or sent.
    const again = await ctx.insights.run(m.id, admin, NOW);
    expect(again.created).toHaveLength(0);
    expect(again.notified).toBe(0);
    const recorded = await ctx.insights.insights(admin, wsId);
    expect(recorded.map((i) => [i.period, i.segment])).toEqual([['2026-03-09', null], ['2026-03-09', 'region = EU']]);
    // Dismissed insights leave the default list and DuckView AI's context.
    expect(await ctx.insights.promptSummary(wsId)).toMatch(/total_revenue \(day 2026-03-09\): Revenue was 120/);
    for (const i of recorded) await ctx.insights.setStatus(admin, i.id, 'dismissed');
    expect(await ctx.insights.insights(admin, wsId)).toHaveLength(0);
    expect(await ctx.insights.promptSummary(wsId)).toBe('');
  });

  it('says what cannot be watched', async () => {
    await expect(ctx.insights.create(admin, wsId, { metric: 'total_revenu' })).rejects.toThrow(/Unknown metric total_revenu/);
    await expect(ctx.insights.create(admin, wsId, { metric: 'orders', segment_by: 'country' })).rejects.toThrow(/cannot be broken down by country/);
    await expect(ctx.insights.create(admin, wsId, { metric: 'orders', lookback: 3 })).rejects.toThrow(/lookback/);
  });

  it('scans every metric, unusual first, and serves agents', async () => {
    const scan = await ctx.insights.scan(admin, wsId, { now: NOW });
    expect(scan.errors).toEqual([]);
    expect(scan.findings.map((f) => [f.metric, f.status])).toEqual([['total_revenue', 'anomaly'], ['orders', 'anomaly'], ['avg_order', 'normal']]);
    // Weekly: the week of Mar 2 is complete and ordinary.
    const weekly = await ctx.insights.scan(admin, wsId, { metrics: ['orders'], grain: 'week', now: NOW });
    expect(weekly.findings[0]).toMatchObject({ status: 'insufficient', period: '2026-03-02' });
    const env: ToolEnv = { ctx, principal: ctx.auth.principalFromUser((await ctx.auth.findByEmail('admin@test.local'))!, 'token'), via: 'mcp', defaultWorkspaceId: wsId, agent: null };
    const tools = buildTools(ctx.cfg);
    const call = (name: string, args: Record<string, unknown>) => runTool(env, tools.find((t) => t.name === name)!, args);
    const created = await call('create_metric_monitor', { metric: 'orders', grain: 'day', schedule: { kind: 'cron', expression: '0 7 * * *' } });
    expect(created.structuredContent).toMatchObject({ status: 'ok', monitor: { metric: 'orders', schedule: { kind: 'cron' } } });
    const listed = await call('list_insights', {});
    expect((listed.content[0] as { text: string }).text).toMatch(/monitor \*\*orders by day\*\*.*0 7 \* \* \*/);
  });
});
