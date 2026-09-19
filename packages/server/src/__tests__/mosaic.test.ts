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
      'CREATE TABLE IF NOT EXISTS "duckview_mosaic_mem"."evil" AS SELECT 1',
      'CREATE TABLE IF NOT EXISTS "other"."src_ab12" AS SELECT 1',
      'CREATE TABLE "duckview_mosaic_mem"."src_ab12" AS SELECT 1',
      'DROP TABLE IF EXISTS "duckview_mosaic_mem"."trips"',
      "ATTACH ':memory:' AS duckview_mosaic_mem",
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
    const memAttached = async () => Number((await ctx.queries.run(admin, wsId, "SELECT count(*) AS n FROM duckdb_databases() WHERE database_name = 'duckview_mosaic_mem'", { cache: false })).rows[0]![0]);
    expect((await post(tokens.admin, wsId, { type: 'exec', sql: 'CREATE TABLE IF NOT EXISTS "duckview_mosaic_mem"."src_ee01" AS SELECT * FROM trips' })).status).toBe(200);
    expect(await memAttached()).toBe(1);
    await ctx.queries.run(admin, wsId, 'INSERT INTO trips VALUES (99999, 1, \'1\', 1.0)');
    // The drop runs off the epoch listener: schema first, then each source view, then the in-memory database.
    for (let i = 0; i < 40 && ((await has()) !== 0 || (await views()) !== 0 || (await memAttached()) !== 0); i++) await new Promise((r) => setTimeout(r, 50));
    expect(await has()).toBe(0);
    expect(await views()).toBe(0);
    expect(await memAttached()).toBe(0);
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

describe('Mosaic specs — prepare, validate, and the agent tool', () => {
  const prepare = async (token: string, body: unknown) => {
    const res = await fetch(`${base}/api/workspaces/${wsId}/mosaic/prepare`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    return { status: res.status, payload: (await res.json()) as { ok: boolean; errors: string[]; warnings: string[]; spec: Record<string, unknown>; statements: string[]; sources: { name: string; view: string; kind: string }[]; tables: string[]; message?: string } };
  };
  const good = {
    meta: { title: 'Trips' },
    data: { nums: { file: 'nums.parquet' }, byhour: { query: 'SELECT hour, count(*) AS n FROM trips GROUP BY 1' }, notes: [{ label: 'a', v: 1 }, { label: 'b', v: 2 }] },
    params: { brush: { select: 'crossfilter' } },
    vconcat: [
      { hconcat: [{ input: 'menu', from: 'trips', column: 'dow', as: '$dow' }, { input: 'slider', as: '$min', min: 0, max: 10 }] },
      { plot: [{ mark: 'rectY', data: { from: 'nums', filterBy: '$brush' }, x: { bin: 'v' }, y: { count: null } }, { select: 'intervalX', as: '$brush' }], xDomain: 'Fixed', width: 400 },
      { plot: [{ mark: 'lineY', data: { from: 'byhour' }, x: 'hour', y: 'n' }, { legend: 'color' }] },
      { plot: [{ mark: 'barY', data: { from: 'notes' }, x: 'label', y: 'v' }] },
      { input: 'table', from: 'trips', filterBy: '$brush' },
    ],
  };

  it('prepares a valid spec: datasets are materialised in the in-memory db behind prefixed source views, plain tables are bound, from: is rewritten', async () => {
    const r = await prepare(tokens.viewer, { spec: good });
    expect(r.status).toBe(200);
    expect(r.payload.ok, r.payload.errors.join('; ')).toBe(true);
    expect(r.payload.sources.map((s) => [s.name, s.kind])).toEqual([['nums', 'parquet'], ['byhour', 'query'], ['notes', 'objects']]);
    // Two statements per dataset: the materialised table and the view Mosaic addresses it by.
    expect(r.payload.statements).toHaveLength(6);
    expect(r.payload.statements.filter((st) => /^CREATE TABLE IF NOT EXISTS "duckview_mosaic_mem"\."src_[0-9a-f]{8}" AS /.test(st))).toHaveLength(3);
    expect(r.payload.statements.filter((st) => /^CREATE OR REPLACE VIEW "duckview_mosaic_src_[0-9a-f]{8}" AS SELECT \* FROM "duckview_mosaic_mem"\."src_[0-9a-f]{8}"$/.test(st))).toHaveLength(3);
    expect(r.payload.tables).toEqual(['trips']);
    const text = JSON.stringify(r.payload.spec);
    expect(text).not.toContain('"from":"nums"');
    expect(text).toContain(`"from":"${r.payload.sources[0]!.view}"`);
    expect(r.payload.spec.data).toBeUndefined();
    // …and the statements are exactly what the exec endpoint admits, so the browser can run them as they are; the
    // in-memory database is attached on first use.
    for (const st of r.payload.statements) expect((await post(tokens.viewer, wsId, { type: 'exec', sql: st })).status).toBe(200);
    const q = await post(tokens.viewer, wsId, { type: 'json', sql: `SELECT max(v) AS m FROM "${r.payload.sources[0]!.view}"` });
    expect((q.payload as { rows: unknown[][] }).rows[0]![0]).toBe(1998);
    const mem = await ctx.queries.run(admin, wsId, "SELECT database_name, table_name FROM duckdb_tables() WHERE database_name = 'duckview_mosaic_mem' ORDER BY 2", { cache: false });
    expect(mem.rows).toHaveLength(3);
    // Neither the in-memory tables nor the views reach the catalogs.
    const cat = await ctx.queries.catalog(admin, wsId);
    expect(cat.objects.some((o) => o.database === 'duckview_mosaic_mem' || o.name.startsWith('src_') || o.name.startsWith('duckview_mosaic_src_'))).toBe(false);
    // Opting out keeps a plain view over the source; a cap demotes big datasets with a warning.
    const plain = await prepare(tokens.admin, { spec: { data: { nums: { file: 'nums.parquet', materialize: false } }, plot: [{ mark: 'dot', data: { from: 'nums' }, x: 'id', y: 'v' }] } });
    expect(plain.payload.statements).toHaveLength(1);
    expect(plain.payload.statements[0]).toMatch(/^CREATE OR REPLACE VIEW "duckview_mosaic_src_[0-9a-f]{8}" AS SELECT \* FROM read_parquet\('nums.parquet'\)$/);
    ctx.cfg.mosaic.materialize_max_rows = 100;
    try {
      const capped = await prepare(tokens.admin, { spec: { data: { nums: { file: 'nums.parquet' } }, plot: [{ mark: 'dot', data: { from: 'nums' }, x: 'id', y: 'v' }] } });
      expect(capped.payload.ok).toBe(true);
      expect(capped.payload.statements).toHaveLength(1);
      expect(capped.payload.warnings[0]).toMatch(/1,000 rows exceed mosaic.materialize_max_rows/);
    } finally {
      ctx.cfg.mosaic.materialize_max_rows = 20_000_000;
    }
    // YAML text works too.
    const y = await prepare(tokens.admin, { spec_text: 'plot:\n  - mark: dot\n    data: { from: trips }\n    x: hour\n    y: fare\n' });
    expect(y.payload.ok).toBe(true);
  });

  it('reports structural errors in Mosaic terms, binding errors per dataset/table, and warnings for likely typos', async () => {
    const bad = await prepare(tokens.admin, { spec: { vconcat: [{ plot: [{ mark: 'nope', data: { from: 'trips' } }, { select: 'wobble' }], bogus: 1 }, { input: 'dial' }, { legend: 'shape' }], params: { s: { select: 'many' } } } });
    expect(bad.payload.ok).toBe(false);
    expect(bad.payload.errors.join('\n')).toMatch(/unrecognized mark type "nope"/);
    expect(bad.payload.errors.join('\n')).toMatch(/unrecognized interactor "wobble"/);
    expect(bad.payload.errors.join('\n')).toMatch(/unrecognized plot attribute "bogus"/);
    expect(bad.payload.errors.join('\n')).toMatch(/unrecognized input type "dial"/);
    expect(bad.payload.errors.join('\n')).toMatch(/unrecognized legend type "shape"/);
    expect(bad.payload.errors.join('\n')).toMatch(/unrecognized param type "many"/);
    const binding = await prepare(tokens.admin, { spec: { data: { x: { file: 'missing.parquet' }, q: { query: 'SELECT nope FROM trips' } }, vconcat: [{ plot: [{ mark: 'dot', data: { from: 'x' }, x: 'a', y: 'b' }] }, { plot: [{ mark: 'dot', data: { from: 'q' }, x: 'a', y: 'b' }] }, { plot: [{ mark: 'dot', data: { from: 'ghost' }, x: 'a', y: 'b' }] }] } });
    expect(binding.payload.ok).toBe(false);
    expect(binding.payload.errors.some((e) => e.startsWith('data.x:'))).toBe(true);
    expect(binding.payload.errors.some((e) => e.startsWith('data.q:') && /nope/i.test(e))).toBe(true);
    expect(binding.payload.errors.some((e) => e.startsWith('from: ghost:'))).toBe(true);
    const typo = await prepare(tokens.admin, { spec: { plot: [{ mark: 'rectY', data: { from: 'trips' }, x: { bins: 'hour' }, y: { count: null } }] } });
    expect(typo.payload.ok).toBe(true);
    expect(typo.payload.warnings[0]).toMatch(/bins/);
    const empty = await prepare(tokens.admin, { spec: { meta: { title: 'x' } } });
    expect(empty.payload.errors[0]).toMatch(/no content/);
    const mutating = await prepare(tokens.admin, { spec: { data: { evil: { query: 'DELETE FROM trips' } }, plot: [{ mark: 'dot', data: { from: 'evil' } }] } });
    expect(mutating.payload.ok).toBe(false);
    expect(mutating.payload.errors[0]).toMatch(/read-only/);
    expect((await ctx.queries.run(admin, wsId, 'SELECT count(*) AS n FROM trips')).rows[0]![0]).toBeGreaterThan(0);
    // Access: outsiders never see the workspace; bad input is 400.
    expect((await prepare(tokens.outsider, { spec: good })).status).toBe(404);
    expect((await prepare(tokens.admin, {})).status).toBe(400);
    expect((await prepare(tokens.admin, { spec_text: 'plot: [' })).status).toBe(400);
  });

  it('create_mosaic_dashboard validates, creates, updates and refuses — with errors an agent can act on', async () => {
    const env: ToolEnv = { ctx, principal: admin, via: 'rest', defaultWorkspaceId: wsId, agent: null };
    const tool = buildTools(ctx.cfg).find((t) => t.name === 'create_mosaic_dashboard')!;
    const yaml = 'meta: { title: Nums by value }\ndata:\n  nums: { file: nums.parquet }\nparams:\n  brush: { select: crossfilter }\nplot:\n  - mark: rectY\n    data: { from: nums, filterBy: $brush }\n    x: { bin: v }\n    y: { count: null }\n  - select: intervalX\n    as: $brush\nxDomain: Fixed\n';
    const checked = await runTool(env, tool, { spec_text: yaml, validate_only: true });
    expect(checked.isError).toBeFalsy();
    expect((checked.structuredContent as { status: string }).status).toBe('valid');
    const created = await runTool(env, tool, { spec_text: yaml });
    expect(created.isError).toBeFalsy();
    const sc = created.structuredContent as { status: string; dashboard_id: string; name: string; url: string };
    expect(sc).toMatchObject({ status: 'ok', name: 'Nums by value', url: `/#/dashboards/${sc.dashboard_id}` });
    const stored = await ctx.dashboards.get(admin, sc.dashboard_id);
    expect(stored.kind).toBe('mosaic');
    expect((stored.spec as { meta: { title: string } }).meta.title).toBe('Nums by value');
    // Update in place.
    const updated = await runTool(env, tool, { dashboard_id: sc.dashboard_id, name: 'Renamed', spec: { ...(stored.spec as object), meta: { title: 'v2' } } });
    expect((updated.structuredContent as { status: string; dashboard_id: string }).dashboard_id).toBe(sc.dashboard_id);
    expect((await ctx.dashboards.get(admin, sc.dashboard_id)).name).toBe('Renamed');
    // Invalid specs are refused with the error list, nothing is created.
    const before = (await ctx.dashboards.list(admin, wsId)).length;
    const bad = await runTool(env, tool, { name: 'Bad', spec: { plot: [{ mark: 'nope', data: { from: 'trips' } }] } });
    expect(bad.isError).toBe(true);
    expect((bad.structuredContent as { status: string; errors: string[] }).errors[0]).toMatch(/unrecognized mark type/);
    expect(bad.content[0]!.text).toContain('duckdb://guides/mosaic-spec');
    expect((await ctx.dashboards.list(admin, wsId)).length).toBe(before);
    // A grid dashboard cannot be turned into a Mosaic one this way, and a viewer cannot create dashboards.
    const grid = await ctx.dashboards.create(admin, wsId, { name: 'Grid' });
    const wrong = await runTool(env, tool, { dashboard_id: grid.id, spec_text: yaml });
    expect(wrong.isError).toBe(true);
    const viewerEnv: ToolEnv = { ctx, principal: viewer, via: 'rest', defaultWorkspaceId: wsId, agent: null };
    const denied = await runTool(viewerEnv, tool, { spec_text: yaml });
    expect(denied.isError).toBe(true);
    // The validate-only path is open to viewers though.
    expect((await runTool(viewerEnv, tool, { spec_text: yaml, validate_only: true })).isError).toBeFalsy();
  });
});
