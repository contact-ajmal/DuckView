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
let jwt: string;
let ws: string;

const api = async (method: string, url: string, body?: unknown, headers: Record<string, string> = { authorization: `Bearer ${jwt}` }) => {
  const res = await fetch(base + url, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: Record<string, any> = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json, text, headers: res.headers };
};

beforeAll(async () => {
  initLogger({ level: 'silent', stderr: true, pretty: false });
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dv-endp-')));
  const cfg = loadConfig({ configPath: null, env: { DUCKVIEW_DATA_DIR: path.join(dir, 'data'), DUCKVIEW_FILESYSTEM_MODE: 'sandboxed', DUCKDB_TEMP_DIRECTORY: path.join(dir, 'spill'), DATABASE_URL: ':memory:', DUCKDB_MEMORY_LIMIT: '1GB', DUCKVIEW_ADMIN_EMAIL: 'admin@test.local', DUCKVIEW_ADMIN_PASSWORD: 'super-secret-pw', LOG_LEVEL: 'silent' } });
  ctx = await createContext(cfg);
  ({ app } = await buildApp(ctx));
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  jwt = ((await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@test.local', password: 'super-secret-pw' }) })).json()) as { token: string }).token;
  ws = (await api('POST', '/api/workspaces', { name: 'API', active_db_path: 'api.duckdb' })).json.workspace.id;
  await api('POST', `/api/workspaces/${ws}/query`, { sql: "CREATE TABLE sales AS SELECT * FROM (VALUES ('eu', DATE '2026-01-05', 10), ('eu', DATE '2026-02-05', 20), ('us', DATE '2026-01-09', 30)) t(region, day, amount)" });
});

afterAll(async () => {
  await app?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('query endpoints', () => {
  let key: string;
  it('publishes a SELECT with typed parameters and returns its key once', async () => {
    const r = await api('POST', `/api/workspaces/${ws}/endpoints`, { name: 'Sales by region', sql: 'SELECT region, sum(amount) AS total FROM sales WHERE region = {{region}} AND day >= {{since}} GROUP BY 1', params: [{ name: 'since', type: 'date', required: false, default: '2026-01-01' }] });
    expect(r.status).toBe(200);
    expect(r.json.endpoint).toMatchObject({ slug: 'sales-by-region', public: false, has_key: true });
    expect(r.json.endpoint.params).toEqual([{ name: 'region', type: 'string', required: true, default: null }, { name: 'since', type: 'date', required: false, default: '2026-01-01' }]);
    expect(r.json.key).toMatch(/^dvq_/);
    key = r.json.key;
    expect(JSON.stringify((await api('GET', `/api/workspaces/${ws}/endpoints`)).json)).not.toContain(key);
  });

  it('answers callers with the key, as JSON or CSV', async () => {
    const r = await api('GET', '/q/sales-by-region?region=eu', undefined, { authorization: `Bearer ${key}` });
    expect(r.status).toBe(200);
    expect(r.json.rows).toEqual([{ region: 'eu', total: 30 }]);
    const since = await api('GET', '/q/sales-by-region?region=eu&since=2026-02-01', undefined, { 'x-api-key': key });
    expect(since.json.rows).toEqual([{ region: 'eu', total: 20 }]);
    const csv = await api('GET', '/q/sales-by-region?region=us&format=csv', undefined, { authorization: `Bearer ${key}` });
    expect(csv.headers.get('content-type')).toMatch(/text\/csv/);
    expect(csv.text).toBe('region,total\nus,30\n');
  });

  it('refuses callers without the key, missing or mistyped parameters, and injection', async () => {
    expect((await api('GET', '/q/sales-by-region?region=eu', undefined, {})).status).toBe(401);
    expect((await api('GET', '/q/sales-by-region?region=eu', undefined, { authorization: 'Bearer dvq_wrong' })).status).toBe(401);
    const missing = await api('GET', '/q/sales-by-region', undefined, { authorization: `Bearer ${key}` });
    expect(missing.status).toBe(400);
    expect(missing.json.message).toMatch(/Missing parameter region/);
    expect((await api('GET', '/q/sales-by-region?region=eu&since=yesterday', undefined, { authorization: `Bearer ${key}` })).status).toBe(400);
    // A quote in a string parameter is data, not SQL.
    const inj = await api('GET', `/q/sales-by-region?region=${encodeURIComponent("eu' OR '1'='1")}`, undefined, { authorization: `Bearer ${key}` });
    expect(inj.status).toBe(200);
    expect(inj.json.rows).toEqual([]);
    expect((await api('GET', '/q/nope', undefined, {})).status).toBe(404);
  });

  it('refuses statements that write, and duplicate addresses', async () => {
    expect((await api('POST', `/api/workspaces/${ws}/endpoints`, { name: 'Evil', sql: 'DELETE FROM sales' })).status).toBe(400);
    expect((await api('POST', `/api/workspaces/${ws}/endpoints`, { name: 'Sales by region', sql: 'SELECT 1' })).json.message).toMatch(/taken/);
  });

  it('serves public endpoints without a key, rate-limited', async () => {
    const r = await api('POST', `/api/workspaces/${ws}/endpoints`, { name: 'Regions', sql: 'SELECT DISTINCT region FROM sales ORDER BY 1', public: true, rate_per_minute: 2 });
    expect(r.json.key).toBeNull();
    expect((await api('GET', '/q/regions', undefined, {})).json.rows).toEqual([{ region: 'eu' }, { region: 'us' }]);
    await api('GET', '/q/regions', undefined, {});
    const limited = await api('GET', '/q/regions', undefined, {});
    expect(limited.status).toBe(429);
    const calls = (await api('GET', `/api/workspaces/${ws}/endpoints`)).json.endpoints.find((e: { slug: string }) => e.slug === 'regions').calls;
    expect(calls).toBe(2);
  });

  it('rotates the key', async () => {
    const e = (await api('GET', `/api/workspaces/${ws}/endpoints`)).json.endpoints.find((x: { slug: string }) => x.slug === 'sales-by-region');
    const r = await api('POST', `/api/endpoints/${e.id}/rotate-key`, {});
    expect((await api('GET', '/q/sales-by-region?region=eu', undefined, { authorization: `Bearer ${key}` })).status).toBe(401);
    expect((await api('GET', '/q/sales-by-region?region=eu', undefined, { authorization: `Bearer ${r.json.key}` })).status).toBe(200);
  });
});
