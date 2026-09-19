/**
 * Mosaic connector endpoint: Arrow/JSON reads through the query pipeline (row cap, ETag/304, read-only), the exec
 * policy (only Mosaic's pre-aggregation shapes and DuckView source views; never mutations, never the epoch), roles,
 * catalog hiding of the Mosaic schema, and epoch-driven schema drops.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tableFromIPC } from 'apache-arrow';
import { loadConfig } from '../config/index.js';
import { initLogger } from '../observability/logger.js';
import { createContext, type AppContext } from '../context.js';
import { buildApp } from '../app.js';
import { buildTools, runTool, type ToolEnv } from '../agent/tools.js';
import type { Principal } from '../services/principal.js';
import type { User } from '../db/schema/sqlite.js';

let dir: string;
let ctx: AppContext;
let app: Awaited<ReturnType<typeof buildApp>>['app'];
let base: string;
let admin: Principal;
let adminU: User;
let viewerU: User;
let viewer: Principal;
let outsiderU: User;
let wsId: string;
const tokens: Record<string, string> = {};

const post = async (token: string, ws: string, body: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(`${base}/api/workspaces/${ws}/mosaic`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers }, body: JSON.stringify(body) });
  const ct = res.headers.get('content-type') ?? '';
  const payload = res.status === 304 ? null : ct.includes('arrow') ? new Uint8Array(await res.arrayBuffer()) : await res.json();
  return { status: res.status, etag: res.headers.get('etag'), contentType: ct, cached: res.headers.get('x-duckview-cached'), payload };
};
const login = async (email: string, password: string) => ((await (await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) })).json()) as { token: string }).token;

beforeAll(async () => {
  initLogger({ level: 'silent', stderr: true, pretty: false });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dv-mosaic-'));
  const cfg = loadConfig({
    configPath: null,
    env: { DUCKVIEW_DATA_DIR: path.join(dir, 'data'), DUCKVIEW_FILESYSTEM_MODE: 'sandboxed', DUCKDB_TEMP_DIRECTORY: path.join(dir, 'spill'), DATABASE_URL: ':memory:', DUCKDB_MEMORY_LIMIT: '512MB', DUCKVIEW_ADMIN_EMAIL: 'admin@test.local', DUCKVIEW_ADMIN_PASSWORD: 'super-secret-pw', LOG_LEVEL: 'silent' },
  });
  ctx = await createContext(cfg);
  adminU = (await ctx.auth.findByEmail('admin@test.local'))!;
  admin = ctx.auth.principalFromUser(adminU, 'jwt', '127.0.0.1');
  viewerU = await ctx.auth.createLocalUser({ email: 'viewer@test.local', password: 'viewer-password', role: 'READ_ONLY' });
  viewer = ctx.auth.principalFromUser(viewerU, 'jwt', '127.0.0.1');
  outsiderU = await ctx.auth.createLocalUser({ email: 'outsider@test.local', password: 'outsider-password', role: 'USER' });
  wsId = (await ctx.workspaces.create(admin, { name: 'Mosaic lab', active_db_path: 'mosaic.duckdb' })).id;
  await ctx.queries.run(admin, wsId, 'CREATE TABLE trips AS SELECT range AS id, (range % 24) AS hour, (range % 7)::VARCHAR AS dow, (range * 1.5) AS fare FROM range(20000)');
  await ctx.queries.run(admin, wsId, "COPY (SELECT range AS id, range * 2 AS v FROM range(1000)) TO 'nums.parquet' (FORMAT PARQUET)");
  await ctx.workspaces.setMember(admin, wsId, { subject_type: 'user', subject_id: viewerU.id, role: 'VIEWER' });
  ({ app } = await buildApp(ctx));
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  tokens.admin = await login('admin@test.local', 'super-secret-pw');
  tokens.viewer = await login('viewer@test.local', 'viewer-password');
  tokens.outsider = await login('outsider@test.local', 'outsider-password');
});

afterAll(async () => {
  await app.close();
  await ctx.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('Mosaic connector — reads', () => {
  it('answers arrow requests with a decodable IPC stream, an ETag and 304 on revalidation', async () => {
    const a = await post(tokens.admin, wsId, { type: 'arrow', sql: 'SELECT hour, count(*) AS n, avg(fare) AS fare FROM trips GROUP BY 1 ORDER BY 1' });
    expect(a.status).toBe(200);
    expect(a.contentType).toContain('application/vnd.apache.arrow.stream');
    const t = tableFromIPC(a.payload as Uint8Array);
    expect(t.schema.fields.map((f) => f.name)).toEqual(['hour', 'n', 'fare']);
    expect(t.numRows).toBe(24);
    expect(Number(t.getChild('n')!.get(0))).toBe(Math.ceil(20000 / 24));
    expect(a.etag).toMatch(/^"[0-9a-f]{40}"$/);
    const b = await post(tokens.admin, wsId, { type: 'arrow', sql: 'SELECT hour, count(*) AS n, avg(fare) AS fare FROM trips GROUP BY 1 ORDER BY 1' }, { 'if-none-match': a.etag! });
    expect(b.status).toBe(304);
    const c = await post(tokens.admin, wsId, { type: 'arrow', sql: 'SELECT hour, count(*) AS n, avg(fare) AS fare FROM trips GROUP BY 1 ORDER BY 1' });
    expect(c.cached).toBe('1');
  });

  it('json requests return typed columns and rows; the grid row cap does not apply', async () => {
    const r = await post(tokens.admin, wsId, { type: 'json', sql: 'SELECT id FROM trips ORDER BY id' });
    expect(r.status).toBe(200);
    const j = r.payload as { columns: { name: string }[]; rows: unknown[][]; row_count: number; truncated: boolean };
    expect(j.columns[0]!.name).toBe('id');
    expect(j.row_count).toBe(20000); // duckdb.max_result_rows is 5 000; mosaic.max_rows is 1 000 000
    expect(j.truncated).toBe(false);
  });

  it('rejects mutating or multi-statement SQL on the read path', async () => {
    expect((await post(tokens.admin, wsId, { type: 'arrow', sql: 'DELETE FROM trips' })).status).toBe(400);
    expect((await post(tokens.admin, wsId, { type: 'arrow', sql: 'SELECT 1; SELECT 2' })).status).toBe(400);
  });

  it('applies the sandbox and roles like every other query', async () => {
    const esc = await post(tokens.admin, wsId, { type: 'arrow', sql: "SELECT * FROM '../../etc/passwd'" });
    expect(esc.status).toBe(403);
    expect((esc.payload as { error: string }).error).toBe('SANDBOX_VIOLATION');
    expect((await post(tokens.outsider, wsId, { type: 'arrow', sql: 'SELECT 1' })).status).toBe(404);
    const v = await post(tokens.viewer, wsId, { type: 'arrow', sql: 'SELECT count(*) AS n FROM trips' });
    expect(v.status).toBe(200);
    expect(Number(tableFromIPC(v.payload as Uint8Array).getChild('n')!.get(0))).toBe(20000);
  });
});

describe('Mosaic connector — exec policy', () => {
  const preagg = 'CREATE SCHEMA IF NOT EXISTS "duckview_mosaic";\nCREATE TABLE IF NOT EXISTS "duckview_mosaic"."preagg_1a2b3c" AS SELECT "hour", count(*) AS "n" FROM "trips" GROUP BY "hour"';

  it('admits Mosaic pre-aggregation statements — for viewers too — and the result is queryable', async () => {
    const r = await post(tokens.viewer, wsId, { type: 'exec', sql: preagg });
    expect(r.status).toBe(200);
    expect((r.payload as { statements: number }).statements).toBe(2);
    const q = await post(tokens.viewer, wsId, { type: 'arrow', sql: 'SELECT sum("n") AS total FROM "duckview_mosaic"."preagg_1a2b3c"' });
    expect(Number(tableFromIPC(q.payload as Uint8Array).getChild('total')!.get(0))).toBe(20000);
  });

  it('admits DuckView source views (main schema, prefixed) over files and queries — paths jailed — and drop statements', async () => {
    expect((await post(tokens.admin, wsId, { type: 'exec', sql: 'DROP SCHEMA IF EXISTS "duckview_mosaic" CASCADE' })).status).toBe(200);
    // Viewers build source views too: it is how Explore and Mosaic dashboards turn a file into a table name.
    const v = await post(tokens.viewer, wsId, { type: 'exec', sql: `CREATE OR REPLACE VIEW "duckview_mosaic_src_ff01" AS SELECT * FROM 'nums.parquet'` });
    expect(v.status).toBe(200);
    const q = await post(tokens.viewer, wsId, { type: 'arrow', sql: 'SELECT max(v) AS m FROM "duckview_mosaic_src_ff01"' });
    expect(Number(tableFromIPC(q.payload as Uint8Array).getChild('m')!.get(0))).toBe(1998);
    const q2 = await post(tokens.admin, wsId, { type: 'exec', sql: `CREATE VIEW "duckview_mosaic_src_ff03" AS SELECT hour, count(*) AS n FROM trips GROUP BY 1` });
    expect(q2.status).toBe(200);
    // Inline spec data is a parenthesised UNION of literal rows.
    const inline = await post(tokens.admin, wsId, { type: 'exec', sql: `CREATE OR REPLACE VIEW "duckview_mosaic_src_ff04" AS (SELECT 1 AS "label", 'a' AS "v") UNION ALL (SELECT 2 AS "label", 'b' AS "v")` });
    expect(inline.status).toBe(200);
    const escape = await post(tokens.admin, wsId, { type: 'exec', sql: `CREATE OR REPLACE VIEW "duckview_mosaic_src_ff02" AS SELECT * FROM '../../etc/passwd'` });
    expect(escape.status).toBe(403);
    // Source views never show up in the catalogs (the prefix hides them), the underlying tables do.
    const cat = await ctx.queries.catalog(admin, wsId);
    expect(cat.objects.some((o) => o.name.startsWith('duckview_mosaic_src_'))).toBe(false);
    expect(cat.objects.some((o) => o.name === 'trips')).toBe(true);
    expect((await post(tokens.admin, wsId, { type: 'exec', sql: 'DROP VIEW IF EXISTS "duckview_mosaic_src_ff03"' })).status).toBe(200);
    expect((await post(tokens.admin, wsId, { type: 'exec', sql: 'DROP TABLE IF EXISTS "duckview_mosaic"."preagg_1a2b3c"' })).status).toBe(200);
    expect((await post(tokens.admin, wsId, { type: 'exec', sql: 'DROP SCHEMA IF EXISTS "duckview_mosaic" CASCADE' })).status).toBe(200);
  });

  it('rejects everything that is not Mosaic plumbing', async () => {
    const bad = [
      'CREATE TABLE evil AS SELECT 1',
      'DROP TABLE trips',
      'CREATE TABLE IF NOT EXISTS "other"."preagg_1" AS SELECT 1',
      'CREATE TABLE IF NOT EXISTS "duckview_mosaic"."notpreagg" AS SELECT 1',
      'CREATE TABLE IF NOT EXISTS "duckview_mosaic"."preagg_1" AS DELETE FROM trips',
      'CREATE TABLE IF NOT EXISTS "duckview_mosaic"."preagg_1" AS SELECT 1; DROP TABLE trips',
      'CREATE VIEW "duckview_mosaic"."src_ff01" AS SELECT 1',
      'CREATE VIEW "src_ff01" AS SELECT 1',
      'CREATE VIEW "duckview_mosaic_src_zz" AS SELECT 1',
      'CREATE OR REPLACE VIEW "duckview_mosaic_src_ff01" AS DELETE FROM trips',
      'DROP VIEW IF EXISTS "trips"',
      "SET threads = 1",
      'INSERT INTO trips VALUES (1, 1, \'1\', 1)',
      'DROP SCHEMA IF EXISTS "main" CASCADE',
    ];
    for (const sql of bad) {
      const r = await post(tokens.admin, wsId, { type: 'exec', sql });
      expect(r.status, sql).toBe(403);
    }
    expect((await ctx.queries.run(admin, wsId, 'SELECT count(*) AS n FROM trips')).rows[0]![0]).toBe(20000);
  });

  it('never moves the data epoch, and the Mosaic schema stays out of every catalog', async () => {
    const before = await ctx.workspaces.versionOf(wsId);
    await post(tokens.admin, wsId, { type: 'exec', sql: preagg });
    expect(await ctx.workspaces.versionOf(wsId)).toBe(before);
    const cat = await ctx.queries.catalog(admin, wsId);
    expect(cat.objects.some((o) => o.schema === 'duckview_mosaic')).toBe(false);
    expect(cat.objects.some((o) => o.name === 'trips')).toBe(true);
    const env: ToolEnv = { ctx, principal: admin, via: 'rest', defaultWorkspaceId: wsId, agent: null };
    const listed = await runTool(env, buildTools(ctx.cfg).find((t) => t.name === 'list_accessible_data')!, { workspace_id: wsId });
    expect(listed.content[0]!.text).not.toContain('preagg_');
    // The raw catalog still has it — the hiding is deliberate, not accidental.
    const raw = await ctx.queries.run(admin, wsId, "SELECT count(*) AS n FROM duckdb_tables() WHERE schema_name = 'duckview_mosaic'");
    expect(raw.rows[0]![0]).toBe(1);
  });

  it('drops the schema and the source views whenever the data epoch moves', async () => {
    const has = async () => Number((await ctx.queries.run(admin, wsId, "SELECT count(*) AS n FROM duckdb_schemas() WHERE schema_name = 'duckview_mosaic'", { cache: false })).rows[0]![0]);
    const views = async () => Number((await ctx.queries.run(admin, wsId, "SELECT count(*) AS n FROM duckdb_views() WHERE view_name LIKE 'duckview_mosaic_src_%'", { cache: false })).rows[0]![0]);
    expect(await has()).toBe(1);
    expect((await post(tokens.admin, wsId, { type: 'exec', sql: `CREATE OR REPLACE VIEW "duckview_mosaic_src_ee01" AS SELECT * FROM trips` })).status).toBe(200);
    expect(await views()).toBeGreaterThan(0);
    await ctx.queries.run(admin, wsId, 'INSERT INTO trips VALUES (99999, 1, \'1\', 1.0)');
    // The drop runs off the epoch listener: schema first, then each source view.
    for (let i = 0; i < 40 && ((await has()) !== 0 || (await views()) !== 0); i++) await new Promise((r) => setTimeout(r, 50));
    expect(await has()).toBe(0);
    expect(await views()).toBe(0);
    // …and Mosaic simply recreates it on the next interaction.
    expect((await post(tokens.admin, wsId, { type: 'exec', sql: preagg })).status).toBe(200);
    expect(await has()).toBe(1);
  });

  it('exposes its settings and honours mosaic.enabled', async () => {
    const info = await (await fetch(`${base}/api/mosaic/info`, { headers: { authorization: `Bearer ${tokens.admin}` } })).json();
    expect(info).toMatchObject({ enabled: true, schema: 'duckview_mosaic', max_rows: 1_000_000 });
    ctx.cfg.mosaic.enabled = false;
    try {
      expect((await post(tokens.admin, wsId, { type: 'arrow', sql: 'SELECT 1' })).status).toBe(403);
      expect((await post(tokens.admin, wsId, { type: 'exec', sql: preagg })).status).toBe(403);
    } finally {
      ctx.cfg.mosaic.enabled = true;
    }
  });
});

describe('Mosaic dashboards — kind and spec', () => {
  const dash = async (token: string, method: string, url: string, body?: unknown) => {
    const res = await fetch(`${base}${url}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, payload: (await res.json()) as { dashboard?: { id: string; kind: string; spec: unknown; name: string }; dashboards?: { id: string; kind: string }[]; error?: string; message?: string } };
  };
  const spec = { meta: { title: 'Trips by hour' }, data: { trips: { query: 'SELECT * FROM trips' } }, plot: [{ mark: 'rectY', data: { from: 'trips' }, x: { bin: 'hour' }, y: { count: null } }] };

  it('creates grid dashboards by default and Mosaic dashboards with a spec; the spec is validated and bounded', async () => {
    const grid = await dash(tokens.admin, 'POST', `/api/workspaces/${wsId}/dashboards`, { name: 'Plain' });
    expect(grid.status).toBe(200);
    expect(grid.payload.dashboard).toMatchObject({ kind: 'grid', spec: null });
    const mosaic = await dash(tokens.admin, 'POST', `/api/workspaces/${wsId}/dashboards`, { name: 'Hours', kind: 'mosaic', spec });
    expect(mosaic.status).toBe(200);
    expect(mosaic.payload.dashboard).toMatchObject({ kind: 'mosaic', spec });
    const empty = await dash(tokens.admin, 'POST', `/api/workspaces/${wsId}/dashboards`, { name: 'Blank', kind: 'mosaic' });
    expect(empty.payload.dashboard!.spec).toEqual({});
    expect((await dash(tokens.admin, 'POST', `/api/workspaces/${wsId}/dashboards`, { name: 'Bad', kind: 'other' })).status).toBe(400);
    expect((await dash(tokens.admin, 'POST', `/api/workspaces/${wsId}/dashboards`, { name: 'Bad', kind: 'mosaic', spec: [1, 2] })).status).toBe(400);
    const huge = await dash(tokens.admin, 'POST', `/api/workspaces/${wsId}/dashboards`, { name: 'Huge', kind: 'mosaic', spec: { blob: 'x'.repeat(600_000) } });
    expect(huge.status).toBe(400);
    expect(huge.payload.message).toMatch(/too large/);
    // The listing carries the kind so the UI can badge and route.
    const list = await dash(tokens.admin, 'GET', `/api/workspaces/${wsId}/dashboards`);
    expect(list.payload.dashboards!.find((d) => d.id === mosaic.payload.dashboard!.id)?.kind).toBe('mosaic');
  });

  it('updates the spec for editors only, rejects a spec on grid dashboards, and viewers can read it', async () => {
    const created = (await dash(tokens.admin, 'POST', `/api/workspaces/${wsId}/dashboards`, { name: 'Editable', kind: 'mosaic', spec })).payload.dashboard!;
    const next = { ...spec, meta: { title: 'v2' } };
    const up = await dash(tokens.admin, 'PATCH', `/api/dashboards/${created.id}`, { spec: next });
    expect(up.status).toBe(200);
    expect(up.payload.dashboard!.spec).toEqual(next);
    const grid = (await dash(tokens.admin, 'POST', `/api/workspaces/${wsId}/dashboards`, { name: 'Grid' })).payload.dashboard!;
    expect((await dash(tokens.admin, 'PATCH', `/api/dashboards/${grid.id}`, { spec })).status).toBe(400);
    const seen = await dash(tokens.viewer, 'GET', `/api/dashboards/${created.id}`);
    expect(seen.status).toBe(200);
    expect(seen.payload.dashboard!.spec).toEqual(next);
    expect((await dash(tokens.viewer, 'PATCH', `/api/dashboards/${created.id}`, { spec })).status).toBe(403);
    expect((await dash(tokens.outsider, 'GET', `/api/dashboards/${created.id}`)).status).toBe(404);
    // Widgets are a grid concept.
    expect((await dash(tokens.admin, 'POST', `/api/dashboards/${created.id}/widgets`, { title: 'x', widget_type: 'TABLE', custom_sql: 'SELECT 1' })).status).toBe(400);
    // Agents see the kind and the spec.
    const env: ToolEnv = { ctx, principal: admin, via: 'rest', defaultWorkspaceId: wsId, agent: null };
    const listed = await runTool(env, buildTools(ctx.cfg).find((t) => t.name === 'list_dashboards')!, { workspace_id: wsId });
    const mine = (listed.structuredContent as { dashboards: { id: string; kind: string; spec: unknown }[] }).dashboards.find((d) => d.id === created.id);
    expect(mine?.kind).toBe('mosaic');
    expect(mine?.spec).toEqual(next);
    expect(listed.content[0]!.text).toContain('Mosaic spec');
  });
});
