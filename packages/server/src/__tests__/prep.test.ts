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

import { compileRecipe } from '../services/prep.js';
import { buildTools, runTool, type ToolEnv } from '../agent/tools.js';

beforeAll(async () => {
  initLogger({ level: 'silent', stderr: true, pretty: false });
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dv-prep-')));
  const cfg = loadConfig({ configPath: null, env: { DUCKVIEW_DATA_DIR: path.join(dir, 'data'), DUCKVIEW_FILESYSTEM_MODE: 'sandboxed', DUCKDB_TEMP_DIRECTORY: path.join(dir, 'spill'), DATABASE_URL: ':memory:', DUCKDB_MEMORY_LIMIT: '1GB', DUCKVIEW_ADMIN_EMAIL: 'admin@test.local', DUCKVIEW_ADMIN_PASSWORD: 'super-secret-pw', LOG_LEVEL: 'silent' } });
  ctx = await createContext(cfg);
  ({ app } = await buildApp(ctx));
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  jwt = ((await (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@test.local', password: 'super-secret-pw' }) })).json()) as { token: string }).token;
  ws = (await api('POST', '/api/workspaces', { name: 'Prep', active_db_path: 'prep.duckdb' })).json.workspace.id;
  await api('POST', `/api/workspaces/${ws}/query`, { sql: "CREATE TABLE raw_people AS SELECT * FROM (VALUES (1, '  Ada  LOVELACE ', '10/12/1815', 'London, UK', NULL), (2, 'bo', '01/02/1990', 'Paris, FR', 'x'), (2, 'bo', '01/02/1990', 'Paris, FR', 'x'), (3, 'Cy', 'soon', 'Rome', 'y'), (4, NULL, '05/06/2001', 'Oslo, NO', 'z')) t(id, name, born, city, junk)" });
});

afterAll(async () => {
  await app?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const steps = [
  { op: 'drop', columns: ['junk'] },
  { op: 'dedupe' },
  { op: 'filter', condition: 'name IS NOT NULL' },
  { op: 'text', column: 'name', fn: 'collapse_spaces' },
  { op: 'text', column: 'name', fn: 'lower' },
  { op: 'parse_date', column: 'born', format: '%d/%m/%Y' },
  { op: 'split', column: 'city', separator: ', ', into: ['town', 'country'] },
  { op: 'fill', column: 'country', value: '??' },
  { op: 'rename', column: 'born', to: 'born_at' },
  { op: 'derive', name: 'name_length', expression: 'length(name)' },
  { op: 'sort', by: [{ column: 'id', desc: true }] },
];

describe('data prep recipes', () => {
  it('compiles a recipe to one SELECT with a commented CTE per step, and refuses fragments that end the statement', () => {
    const sql = compileRecipe('raw_people', [{ op: 'filter', condition: "name <> 'x;y'" }, { op: 'cast', column: 'id', type: 'BIGINT' }]);
    expect(sql).toBe(`WITH\n  -- 1. Keep rows where name <> 'x;y'\n  step_1 AS (SELECT * FROM "raw_people" WHERE name <> 'x;y'),\n  -- 2. Make id BIGINT\n  step_2 AS (SELECT * REPLACE (TRY_CAST("id" AS BIGINT) AS "id") FROM step_1)\nSELECT * FROM step_2`);
    expect(() => compileRecipe('raw_people', [{ op: 'filter', condition: '1=1); DROP TABLE raw_people; --' }])).toThrow(/one SQL expression/);
    expect(() => compileRecipe('raw_people', [{ op: 'derive', name: 'x', expression: '1 /* hi */' }])).toThrow(/one SQL expression/);
  });

  it('previews the result and the rows left after each step', async () => {
    const r = await api('POST', `/api/workspaces/${ws}/prep/preview`, { source: 'raw_people', steps });
    expect(r.status).toBe(200);
    expect(r.json.columns.map((c: { name: string }) => c.name)).toEqual(['id', 'name', 'born_at', 'city', 'town', 'country', 'name_length']);
    expect(r.json.rows.map((row: unknown[]) => [row[0], row[1], String(row[2]).slice(0, 10), row[4], row[5], row[6]])).toEqual([
      [3, 'cy', 'null', 'Rome', '??', 2],
      [2, 'bo', '1990-02-01', 'Paris', 'FR', 2],
      [1, 'ada lovelace', '1815-12-10', 'London', 'UK', 12],
    ]);
    expect(r.json.source_rows).toBe(5);
    expect(r.json.step_rows).toEqual([5, 4, 3, 3, 3, 3, 3, 3, 3, 3, 3]);
    expect(r.json.steps[1]).toBe('Remove duplicate rows');
  });

  it('saves as a view or a table, and the agent tool previews, then waits for approval to write', async () => {
    const v = await api('POST', `/api/workspaces/${ws}/prep/save`, { source: 'raw_people', steps, name: 'people_clean', as: 'view' });
    expect(v.status).toBe(200);
    const n = await api('POST', `/api/workspaces/${ws}/query`, { sql: 'SELECT count(*) AS n FROM people_clean' });
    expect(n.json.rows).toEqual([[3]]);
    expect((await api('POST', `/api/workspaces/${ws}/prep/save`, { source: 'raw_people', steps, name: 'people_clean', as: 'view' })).status).toBeGreaterThanOrEqual(400);
    expect((await api('POST', `/api/workspaces/${ws}/prep/save`, { source: 'raw_people', steps, name: 'people_clean', as: 'view', replace: true })).status).toBe(200);
    expect((await api('POST', `/api/workspaces/${ws}/prep/save`, { source: 'raw_people', steps, name: 'bad name', as: 'table' })).status).toBe(400);

    const env: ToolEnv = { ctx, principal: ctx.auth.principalFromUser((await ctx.auth.findByEmail('admin@test.local'))!, 'token'), via: 'mcp', defaultWorkspaceId: ws, agent: null };
    const tool = buildTools(ctx.cfg).find((t) => t.name === 'prepare_data')!;
    const preview = await runTool(env, tool, { source: 'raw_people', steps: steps.slice(0, 2) });
    expect((preview.content[0] as { text: string }).text).toMatch(/^5 rows in raw_people\n1\. Remove junk → 5 rows\n2\. Remove duplicate rows → 4 rows/);
    const saved = await runTool(env, tool, { source: 'raw_people', steps: steps.slice(0, 2), save_as: { name: 'people_dedup', as: 'table' }, dry_run: false });
    expect((saved.content[0] as { text: string }).text).toBe('Created the table people_dedup.');
    expect((await api('POST', `/api/workspaces/${ws}/query`, { sql: 'SELECT count(*) FROM people_dedup' })).json.rows).toEqual([[4]]);
  });
});
