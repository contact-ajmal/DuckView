import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../config/index.js';
import { initLogger } from '../observability/logger.js';
import { createContext, type AppContext } from '../context.js';
import { buildApp } from '../app.js';

let dir: string;
let ctx: AppContext;
let app: Awaited<ReturnType<typeof buildApp>>['app'];
let base: string;
let adminJwt: string;
let userJwt: string;
let ws: string;

const api = async (method: string, url: string, token: string, body?: unknown) => {
  const res = await fetch(base + url, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
};
const login = async (email: string, password: string) => ((await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) })).json()) as { token: string }).token;
const settle = () => new Promise((r) => setTimeout(r, 150)); // audit rows are written asynchronously

beforeAll(async () => {
  initLogger({ level: 'silent', stderr: true, pretty: false });
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dv-hist-')));
  const cfg = loadConfig({ configPath: null, env: { DUCKVIEW_DATA_DIR: path.join(dir, 'data'), DUCKVIEW_FILESYSTEM_MODE: 'sandboxed', DUCKDB_TEMP_DIRECTORY: path.join(dir, 'spill'), DATABASE_URL: ':memory:', DUCKDB_MEMORY_LIMIT: '1GB', DUCKVIEW_ADMIN_EMAIL: 'admin@test.local', DUCKVIEW_ADMIN_PASSWORD: 'super-secret-pw', LOG_LEVEL: 'silent' } });
  ctx = await createContext(cfg);
  ({ app } = await buildApp(ctx));
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  adminJwt = await login('admin@test.local', 'super-secret-pw');
  const u = await ctx.auth.createLocalUser({ email: 'analyst@test.local', password: 'analyst-pass-123', role: 'USER' });
  userJwt = await login('analyst@test.local', 'analyst-pass-123');
  ws = (await api('POST', '/api/workspaces', adminJwt, { name: 'Hist', active_db_path: 'hist.duckdb', members: [{ subject_type: 'user', subject_id: u.id, role: 'EDITOR' }] })).json.workspace.id;
  const run = (sql: string, t = adminJwt) => api('POST', `/api/workspaces/${ws}/query`, t, { sql });
  await run('CREATE TABLE sales AS SELECT range AS id, range % 3 AS region FROM range(100)');
  await run('SELECT count(*) FROM sales');
  await run('SELECT count(*) FROM sales');
  await run('SELECT region, count(*) FROM sales GROUP BY 1');
  await run('SELECT * FROM nowhere');
  await run('SELECT 42 AS answer', userJwt);
  await settle();
});

afterAll(async () => {
  await app?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('query history', () => {
  it('lists my runs, newest first, with duration and errors', async () => {
    const r = await api('GET', `/api/workspaces/${ws}/history`, adminJwt);
    expect(r.json.who).toBe('me');
    const runs = r.json.runs as { sql: string; status: string; error: string | null; duration_ms: number | null; who: string }[];
    expect(runs[0]!.sql).toBe('SELECT * FROM nowhere');
    expect(runs[0]!.status).toBe('error');
    expect(runs[0]!.error).toMatch(/nowhere/);
    expect(runs.some((x) => x.sql === 'SELECT 42 AS answer')).toBe(false); // someone else's
    expect(runs.every((x) => x.who === 'admin@test.local')).toBe(true);
  });

  it('searches, keeps failures, and groups identical statements', async () => {
    const found = await api('GET', `/api/workspaces/${ws}/history?q=group%20by`, adminJwt);
    expect((found.json.runs as { sql: string }[]).map((x) => x.sql)).toEqual(['SELECT region, count(*) FROM sales GROUP BY 1']);
    // Underscores are literal, not wildcards.
    const under = await api('GET', `/api/workspaces/${ws}/history?q=nowhere_`, adminJwt);
    expect((under.json.runs as unknown[]).length).toBe(0);
    const errors = await api('GET', `/api/workspaces/${ws}/history?status=error`, adminJwt);
    expect((errors.json.runs as unknown[]).length).toBe(1);
    const grouped = await api('GET', `/api/workspaces/${ws}/history?group=1&q=select%20count(*)`, adminJwt);
    expect(grouped.json.groups).toEqual([expect.objectContaining({ sql: 'SELECT count(*) FROM sales', runs: 2, errors: 0 })]);
  });

  it('lets owners see everyone, and keeps others to their own', async () => {
    const all = await api('GET', `/api/workspaces/${ws}/history?who=everyone`, adminJwt);
    expect((all.json.runs as { sql: string; who: string }[]).find((x) => x.sql === 'SELECT 42 AS answer')?.who).toBe('analyst@test.local');
    const theirs = await api('GET', `/api/workspaces/${ws}/history?who=everyone`, userJwt);
    expect(theirs.json.who).toBe('me');
    expect((theirs.json.runs as { sql: string }[]).map((x) => x.sql)).toEqual(['SELECT 42 AS answer']);
  });
});
