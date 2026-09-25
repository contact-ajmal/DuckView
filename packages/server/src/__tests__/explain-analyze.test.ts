import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../config/index.js';
import { initLogger } from '../observability/logger.js';
import { createContext, type AppContext } from '../context.js';
import type { Principal } from '../services/principal.js';

let dir: string;
let ctx: AppContext;
let admin: Principal;
let ws: string;

beforeAll(async () => {
  initLogger({ level: 'silent', stderr: true, pretty: false });
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dv-plan-')));
  const cfg = loadConfig({ configPath: null, env: { DUCKVIEW_DATA_DIR: path.join(dir, 'data'), DUCKVIEW_FILESYSTEM_MODE: 'sandboxed', DUCKDB_TEMP_DIRECTORY: path.join(dir, 'spill'), DATABASE_URL: ':memory:', DUCKDB_MEMORY_LIMIT: '1GB', DUCKVIEW_ADMIN_EMAIL: 'admin@test.local', DUCKVIEW_ADMIN_PASSWORD: 'super-secret-pw', LOG_LEVEL: 'silent' } });
  ctx = await createContext(cfg);
  admin = ctx.auth.principalFromUser((await ctx.auth.findByEmail('admin@test.local'))!, 'jwt', '127.0.0.1');
  ws = (await ctx.workspaces.create(admin, { name: 'Plan', active_db_path: 'plan.duckdb' })).id;
  await ctx.queries.run(admin, ws, 'CREATE TABLE t AS SELECT range AS id, range % 7 AS g FROM range(50000)');
});

afterAll(async () => {
  await ctx?.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('explain analyze', () => {
  it('returns the measured plan as a tree with times, rows and totals', async () => {
    const r = (await ctx.queries.explain(admin, ws, 'SELECT g, count(*) FROM t WHERE id > 10 GROUP BY g', true)) as unknown as { format: string; plan: { name: string; extra_info: Record<string, unknown>; children: unknown[] }[]; text: string; summary: { latency_s: number; rows_scanned: number } };
    expect(r.format).toBe('json');
    expect(Array.isArray(r.plan)).toBe(true);
    const all: { name: string; extra_info: Record<string, unknown> }[] = [];
    const walk = (ns: typeof r.plan) => ns.forEach((n) => { all.push(n); walk(n.children as typeof r.plan); });
    walk(r.plan);
    expect(all.some((n) => /SCAN/.test(n.name))).toBe(true);
    expect(all.every((n) => typeof n.extra_info.Timing === 'number')).toBe(true);
    const scan = all.find((n) => /SCAN/.test(n.name))!;
    expect(Number(scan.extra_info['Actual Rows'])).toBeGreaterThan(40_000);
    expect(r.summary.rows_scanned).toBeGreaterThanOrEqual(50_000);
    expect(r.text).toMatch(/rows/);
  });

  it('still refuses to analyze statements that write', async () => {
    await expect(ctx.queries.explain(admin, ws, 'DELETE FROM t', true)).rejects.toThrow(/mutating/);
  });
});
