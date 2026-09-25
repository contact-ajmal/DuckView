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

import { stem } from '../services/joins.js';
import { buildTools, runTool, type ToolEnv } from '../agent/tools.js';

beforeAll(async () => {
  initLogger({ level: 'silent', stderr: true, pretty: false });
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dv-joins-')));
  const cfg = loadConfig({ configPath: null, env: { DUCKVIEW_DATA_DIR: path.join(dir, 'data'), DUCKVIEW_FILESYSTEM_MODE: 'sandboxed', DUCKDB_TEMP_DIRECTORY: path.join(dir, 'spill'), DATABASE_URL: ':memory:', DUCKDB_MEMORY_LIMIT: '1GB', DUCKVIEW_ADMIN_EMAIL: 'admin@test.local', DUCKVIEW_ADMIN_PASSWORD: 'super-secret-pw', LOG_LEVEL: 'silent' } });
  ctx = await createContext(cfg);
  ({ app } = await buildApp(ctx));
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  jwt = ((await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@test.local', password: 'super-secret-pw' }) })).json()) as { token: string }).token;
  ws = (await api('POST', '/api/workspaces', { name: 'Joins', active_db_path: 'joins.duckdb' })).json.workspace.id;
  for (const sql of [
    'CREATE TABLE customers (id INTEGER PRIMARY KEY, name VARCHAR)',
    "INSERT INTO customers VALUES (1, 'Ada'), (2, 'Bo'), (3, 'Cy')",
    // 4 has no customer: one orphan.
    'CREATE TABLE orders AS SELECT * FROM (VALUES (10, 1, 5.0), (11, 1, 7.5), (12, 2, 3.0), (13, 4, 1.0)) t(order_id, customer_id, amount)',
    'CREATE TABLE products (product_id INTEGER PRIMARY KEY, title VARCHAR)',
    "INSERT INTO products VALUES (100, 'Pen'), (101, 'Ink')",
    'CREATE TABLE order_lines (order_id INTEGER, product_id INTEGER REFERENCES products (product_id), qty INTEGER)',
    'INSERT INTO order_lines VALUES (10, 100, 1), (10, 101, 2), (11, 100, 1)',
    // Same name, unrelated values: not a relationship.
    'CREATE TABLE audit (customer_id INTEGER)',
    'INSERT INTO audit VALUES (900), (901)',
  ]) expect((await api('POST', `/api/workspaces/${ws}/query`, { sql })).status).toBe(200);
});

afterAll(async () => {
  await app?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('join discovery', () => {
  it('stems table names', () => {
    expect(['customers', 'dim_customer', 'stg_categories', 'addresses', 'status'].map(stem)).toEqual(['customer', 'customer', 'category', 'address', 'statu']);
  });

  it('finds declared keys and relationships confirmed on the data, pointing at the unique side', async () => {
    const r = await api('GET', `/api/workspaces/${ws}/joins`);
    expect(r.status).toBe(200);
    const rels = (r.json.relationships as Record<string, unknown>[]).map((x) => `${x.from_table}.${x.from_column}>${x.to_table}.${x.to_column} ${x.source} ${x.cardinality} ${x.coverage} ${x.orphans} ${x.confidence}`);
    expect(rels).toEqual([
      'order_lines.product_id>products.product_id declared many-to-one 1 0 high',
      'order_lines.order_id>orders.order_id inferred many-to-one 1 0 high',
      'orders.customer_id>customers.id inferred many-to-one 0.667 1 medium',
    ]);
    expect(r.json.relationships[2].sql).toBe('SELECT *\nFROM "orders" AS a\nJOIN "customers" AS b ON a."customer_id" = b."id"\nLIMIT 100');
    expect((r.json.tables as { name: string; columns: string[] }[]).map((t) => `${t.name}:${t.columns.join(',')}`)).toEqual(['customers:id', 'order_lines:order_id,product_id', 'orders:customer_id,order_id', 'products:product_id']);
  });

  it('limits to relationships touching the named tables, and the agent tool reports them', async () => {
    const r = await api('GET', `/api/workspaces/${ws}/joins?tables=customers`);
    expect((r.json.relationships as { from_table: string }[]).map((x) => x.from_table)).toEqual(['orders']);
    const env: ToolEnv = { ctx, principal: ctx.auth.principalFromUser((await ctx.auth.findByEmail('admin@test.local'))!, 'token'), via: 'mcp', defaultWorkspaceId: ws, agent: null };
    const tool = buildTools(ctx.cfg).find((t) => t.name === 'find_joins')!;
    const out = await runTool(env, tool, { tables: ['customers'] });
    expect((out.content[0] as { text: string }).text).toBe('**Relationships** (1, 2 checked on the data)\n- `orders.customer_id` → `customers.id`: many-to-one, 67% of values match, 1 unmatched (medium)');
  });
});
