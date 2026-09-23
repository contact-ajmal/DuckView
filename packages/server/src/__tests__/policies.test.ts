/**
 * Row- and column-level security: filtered rows and masked columns for the people a policy applies to, owners
 * unaffected, and the ways around it that must not work — aliases, schemas, CTEs, subqueries, joins, predicates on
 * masked columns, views, data files, table functions, writes, profiles, the result cache, agents.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../config/index.js';
import { initLogger } from '../observability/logger.js';
import { createContext, type AppContext } from '../context.js';
import { buildApp } from '../app.js';
import { buildTools, runTool, type ToolEnv } from '../agent/tools.js';
import type { Principal } from '../services/principal.js';

let dir: string;
let ctx: AppContext;
let app: Awaited<ReturnType<typeof buildApp>>['app'];
let base: string;
let jwt: string;
let viewerJwt: string;
let editorJwt: string;
let teamJwt: string;
let wsId: string;
let admin: Principal;
let viewerId: string;
let editorId: string;

const api = async (method: string, url: string, body?: unknown, token = jwt) => {
  const res = await fetch(base + url, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
};
const q = async (sql: string, token: string) => api('POST', `/api/workspaces/${wsId}/query`, { sql }, token);
const rows = async (sql: string, token: string) => {
  const r = await q(sql, token);
  expect(r.status, `${sql} → ${JSON.stringify(r.json).slice(0, 300)}`).toBe(200);
  return r.json.rows as unknown[][];
};

beforeAll(async () => {
  initLogger({ level: 'silent', stderr: true, pretty: false });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dv-policies-'));
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'data', 'customers.csv'), 'id,ssn\n1,111-11-1111\n');
  const cfg = loadConfig({ configPath: null, env: { DUCKVIEW_DATA_DIR: path.join(dir, 'data'), DUCKVIEW_FILESYSTEM_MODE: 'full', DUCKDB_TEMP_DIRECTORY: path.join(dir, 'spill'), DATABASE_URL: ':memory:', DUCKDB_MEMORY_LIMIT: '512MB', DUCKVIEW_ADMIN_EMAIL: 'admin@test.local', DUCKVIEW_ADMIN_PASSWORD: 'super-secret-pw', DUCKVIEW__duckdb__sync_scheduler_enabled: 'false', DUCKVIEW__notifications__scheduler_enabled: 'false', DUCKVIEW__apps__enabled: 'false', LOG_LEVEL: 'silent' } });
  ctx = await createContext(cfg);
  admin = ctx.auth.principalFromUser((await ctx.auth.findByEmail('admin@test.local'))!, 'jwt', '127.0.0.1');
  const viewer = await ctx.auth.createLocalUser({ email: 'viewer@test.local', password: 'viewer-secret-pw', role: 'USER' });
  const editor = await ctx.auth.createLocalUser({ email: 'editor@test.local', password: 'editor-secret-pw', role: 'USER' });
  const teamUser = await ctx.auth.createLocalUser({ email: 'team@test.local', password: 'team-secret-pw', role: 'USER' });
  viewerId = viewer.id;
  editorId = editor.id;
  wsId = (await ctx.workspaces.create(admin, { name: 'CRM', active_db_path: 'crm.duckdb' })).id;
  await ctx.workspaces.setMember(admin, wsId, { subject_type: 'user', subject_id: viewer.id, role: 'VIEWER' });
  await ctx.workspaces.setMember(admin, wsId, { subject_type: 'user', subject_id: editor.id, role: 'EDITOR' });
  const team = await ctx.groups.create(admin, { name: 'emea-sales' });
  await ctx.groups.addMember(admin, team.id, teamUser.id);
  await ctx.workspaces.setMember(admin, wsId, { subject_type: 'group', subject_id: team.id, role: 'VIEWER' });
  const run = (sql: string) => ctx.queries.run(admin, wsId, sql, { cache: false });
  await run(`CREATE TABLE customers AS SELECT * FROM (VALUES (1, 'ana@acme.com', 'EU', '111-11-1111', 100.0, 'viewer@test.local'), (2, 'bo@acme.com', 'EU', '222-22-2222', 200.0, 'someone@else'), (3, 'cy@acme.com', 'US', '333-33-3333', 300.0, 'viewer@test.local'), (4, 'di@acme.com', 'US', '444-44-4444', 400.0, 'someone@else')) t(id, email, region, ssn, revenue, owner_email)`);
  await run(`CREATE TABLE products AS SELECT range AS id, 'p' || range AS name FROM range(3)`);
  await run(`CREATE VIEW all_customers AS SELECT * FROM customers`);
  await run(`CREATE VIEW product_names AS SELECT name FROM products`);
  ({ app } = await buildApp(ctx));
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as net.AddressInfo).port}`;
  const login = async (email: string, password: string) => (await api('POST', '/api/auth/login', { email, password }, '')).json.token as string;
  jwt = await login('admin@test.local', 'super-secret-pw');
  viewerJwt = await login('viewer@test.local', 'viewer-secret-pw');
  editorJwt = await login('editor@test.local', 'editor-secret-pw');
  teamJwt = await login('team@test.local', 'team-secret-pw');
});

afterAll(async () => {
  await app.close();
  await ctx.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('access policies', () => {
  it('are managed by owners and validated against the workspace', async () => {
    const make = (body: Record<string, unknown>, token = jwt) => api('POST', `/api/workspaces/${wsId}/policies`, body, token);
    expect((await make({ table_name: 'customers', row_filter: "region = 'EU'" }, editorJwt)).status).toBe(403);
    expect((await api('GET', `/api/workspaces/${wsId}/policies`, undefined, viewerJwt)).status).toBe(403);
    expect((await make({ table_name: 'nope', row_filter: 'true' })).json.message).toMatch(/No table or view "nope"/);
    expect((await make({ table_name: 'customers', column_masks: { nope: { kind: 'null' } } })).json.message).toMatch(/no column "nope"/);
    expect((await make({ table_name: 'customers', row_filter: 'no_such_col = 1' })).json.message).toMatch(/does not run/);
    expect((await make({ table_name: 'customers' })).json.message).toMatch(/row filter, a column mask/);
    expect((await make({ table_name: 'customers', row_filter: 'true', applies_to: { roles: ['OWNER'] } })).status).toBe(400);
    const p = await make({ name: 'EU only, PII masked', table_name: 'customers', row_filter: "region = 'EU'", column_masks: { email: { kind: 'partial' }, ssn: { kind: 'null' } }, applies_to: { roles: ['VIEWER'] } });
    expect(p.status, JSON.stringify(p.json)).toBe(200);
    expect(p.json.policy).toMatchObject({ table_name: 'customers', applies_to: { roles: ['VIEWER'] }, enabled: true });
    expect((await api('GET', `/api/workspaces/${wsId}/policies`)).json.policies).toHaveLength(1);
    // Members learn what restricts them, not how.
    const mine = await api('GET', `/api/workspaces/${wsId}/policies/mine`, undefined, viewerJwt);
    expect(mine.json).toEqual({ restricted: true, tables: [{ table: 'customers', name: 'EU only, PII masked', description: null, rows_filtered: true, masked_columns: ['email', 'ssn'] }] });
    expect((await api('GET', `/api/workspaces/${wsId}/policies/mine`, undefined, editorJwt)).json).toEqual({ restricted: false, tables: [] });
  });

  it('filters rows and masks columns for viewers, never for owners or unaffected editors', async () => {
    expect(await rows('SELECT count(*) FROM customers', jwt)).toEqual([[4]]);
    expect(await rows('SELECT count(*) FROM customers', editorJwt)).toEqual([[4]]);
    expect(await rows('SELECT count(*) FROM customers', viewerJwt)).toEqual([[2]]);
    expect(await rows('SELECT id, email, ssn, revenue FROM customers ORDER BY id', viewerJwt)).toEqual([[1, '••••••••.com', null, 100], [2, '•••••••.com', null, 200]]);
    expect(await rows('SELECT email, ssn FROM customers WHERE id = 1', jwt)).toEqual([['ana@acme.com', '111-11-1111']]);
  });

  it('holds against the usual ways around it', async () => {
    const one = async (sql: string) => (await rows(sql, viewerJwt))[0]![0];
    // Names, aliases, joins, subqueries, CTEs, scalar subqueries, set operations.
    expect(await one('SELECT count(*) FROM main.customers')).toBe(2);
    expect(await one('SELECT count(*) FROM "customers" AS c')).toBe(2);
    expect(await one('SELECT count(*) FROM customers a JOIN customers b ON a.id = b.id')).toBe(2);
    expect(await one('SELECT count(*) FROM (SELECT * FROM customers)')).toBe(2);
    expect(await one('WITH x AS (SELECT * FROM customers) SELECT count(*) FROM x')).toBe(2);
    expect(await one('WITH customers AS (SELECT * FROM customers) SELECT count(*) FROM customers')).toBe(2);
    expect(await one('SELECT (SELECT max(ssn) FROM customers)')).toBeNull();
    expect(await one('SELECT count(*) FROM (SELECT id FROM customers UNION ALL SELECT id FROM customers)')).toBe(4);
    expect(await one("SELECT max(revenue) FROM customers WHERE region = 'US'")).toBeNull();
    expect(await one('SELECT sum(revenue) FROM customers')).toBe(300);
    expect(await one('SELECT count(*) FROM products WHERE id IN (SELECT id FROM customers)')).toBe(2); // ids 1 and 2 are visible
    // Predicates on masked values see the masked values.
    expect(await one("SELECT count(*) FROM customers WHERE ssn = '111-11-1111'")).toBe(0);
    expect(await one("SELECT count(*) FROM customers WHERE email LIKE 'ana%'")).toBe(0);
    // Qualified with the database name: the same table.
    const db = String((await rows('SELECT current_database()', jwt))[0]![0]);
    expect(await one(`SELECT count(*) FROM "${db}".main.customers`)).toBe(2);
    expect(await one(`SELECT count(*) FROM "${db}".customers`)).toBe(2);
    // Refused: views over the protected table, files, table functions, writes, time travel.
    const refused = async (sql: string, re: RegExp, token = viewerJwt) => {
      const r = await q(sql, token);
      expect(r.status, sql).toBe(403);
      expect(r.json.message, sql).toMatch(re);
    };
    await refused('SELECT * FROM all_customers', /view all_customers reads a protected table/);
    await refused("SELECT * FROM 'customers.csv'", /read tables, not files/);
    await refused("SELECT * FROM read_csv('customers.csv')", /read_csv\(\) is not available/);
    await refused("SELECT * FROM query('SELECT * FROM customers')", /query\(\) is not available/);
    await refused("SELECT * FROM query_table('customers')", /query_table\(\) is not available/);
    await refused('SELECT 1; DELETE FROM customers', /view-only access|only SELECT queries/);
    // Unprotected objects stay usable, including views over them and allowed table functions.
    expect(await rows('SELECT count(*) FROM product_names', viewerJwt)).toEqual([[3]]);
    expect(await rows('SELECT count(*) FROM range(5)', viewerJwt)).toEqual([[5]]);
  });

  it('keeps the result cache apart, and covers profiles, overviews and streamed results', async () => {
    const sql = 'SELECT count(*) AS n, max(ssn) AS m FROM customers';
    const cached = (token: string) => api('POST', `/api/workspaces/${wsId}/query`, { sql }, token);
    expect((await cached(jwt)).json.rows).toEqual([[4, '444-44-4444']]);
    expect((await cached(viewerJwt)).json.rows).toEqual([[2, null]]);
    expect((await cached(jwt)).json.rows).toEqual([[4, '444-44-4444']]);
    expect((await cached(viewerJwt)).json.rows).toEqual([[2, null]]);
    // Profiles and overviews of the protected table describe the permitted rows only.
    const viewerP = ctx.auth.principalFromUser((await ctx.auth.findById(viewerId))!, 'jwt', '127.0.0.1');
    const prof = await ctx.queries.profile(viewerP, wsId, 'customers');
    expect(prof.rowCount).toBe(2);
    expect(JSON.stringify(prof.summary)).not.toMatch(/444-44-4444|333-33-3333|di@acme/);
    const ov = await ctx.queries.overview(viewerP, wsId, 'customers');
    expect(JSON.stringify(ov)).not.toMatch(/333-33-3333|cy@acme|444/);
    // The streaming path goes through the same guard.
    const streamed: unknown[][] = [];
    await ctx.queries.stream(viewerP, wsId, 'SELECT id FROM customers ORDER BY id', { onSchema: () => undefined, onRows: (r) => { streamed.push(...r); } });
    expect(streamed).toEqual([[1], [2]]);
    // EXPLAIN ANALYZE executes: it runs the rewritten statement too.
    const plan = await ctx.queries.explain(viewerP, wsId, 'SELECT * FROM customers', false);
    expect(JSON.stringify(plan)).not.toContain('444-44-4444');
  });

  it('uses the viewer\'s identity in filters, applies to teams and to agents', async () => {
    await api('POST', `/api/workspaces/${wsId}/policies`, { name: 'Own accounts', table_name: 'customers', row_filter: 'owner_email = {{user.email}}', applies_to: { users: [editorId] } });
    // Editor: now restricted to rows they own (none) — and to reading.
    expect(await rows('SELECT count(*) FROM customers', editorJwt)).toEqual([[0]]);
    const w = await q('CREATE TABLE x AS SELECT 1', editorJwt);
    expect(w.status).toBe(403);
    expect(w.json.message).toMatch(/only SELECT/);
    // Viewer: both policies that name them apply? The second names the editor only — unchanged.
    expect(await rows('SELECT count(*) FROM customers', viewerJwt)).toEqual([[2]]);
    // Teams: membership through a group.
    const team = (await ctx.groups.list(admin)).find((g) => g.name === 'emea-sales')!;
    await api('POST', `/api/workspaces/${wsId}/policies`, { name: 'Team sees its region', table_name: 'customers', row_filter: "list_contains({{user.groups}}, 'emea-sales') AND region = 'EU'", applies_to: { groups: [team.id] } });
    expect(await rows('SELECT count(*) FROM customers', teamJwt)).toEqual([[2]]);
    // Agents (tokens of the same person) are restricted the same way.
    const viewerUser = (await ctx.auth.findById(viewerId))!;
    const token = await ctx.auth.createToken(viewerUser, { name: 'agent', scopes: ['read', 'mcp'] });
    const agent = await ctx.auth.verifyToken(token.token);
    const env: ToolEnv = { ctx, principal: agent!, via: 'rest', defaultWorkspaceId: wsId, agent: null };
    const r = await runTool(env, buildTools(ctx.cfg).find((t) => t.name === 'execute_query')!, { sql: 'SELECT count(*) AS n, max(ssn) AS s FROM customers' });
    expect(r.structuredContent).toMatchObject({ rows: [[2, null]] });
    // Owners can preview a query as a member.
    const pre = await api('POST', `/api/workspaces/${wsId}/policies/preview`, { sql: 'SELECT id, email FROM customers ORDER BY id', as_user_id: viewerId });
    expect(pre.json).toMatchObject({ as: { email: 'viewer@test.local', role: 'VIEWER' }, restricted: true, rows: [[1, '••••••••.com'], [2, '•••••••.com']] });
    expect(pre.json.sql).toMatch(/region = 'EU'/);
    // Turning a policy off lifts it.
    const all = (await api('GET', `/api/workspaces/${wsId}/policies`)).json.policies as { id: string; name: string }[];
    for (const p of all) await api('PATCH', `/api/policies/${p.id}`, { enabled: false });
    expect(await rows('SELECT count(*) FROM customers', viewerJwt)).toEqual([[4]]);
    for (const p of all) await api('DELETE', `/api/policies/${p.id}`);
  });

  it('gives restricted people their own Mosaic objects and never the shared ones', async () => {
    const p = await api('POST', `/api/workspaces/${wsId}/policies`, { name: 'EU only for Mosaic', table_name: 'customers', row_filter: "region = 'EU'", column_masks: { ssn: { kind: 'null' } }, applies_to: { roles: ['VIEWER'] } });
    expect(p.status, JSON.stringify(p.json)).toBe(200);
    const spec = { data: { c: { query: 'SELECT region, revenue, ssn FROM customers' } }, plot: [{ mark: 'barY', data: { from: 'c' }, x: 'region', y: { sum: 'revenue' } }] };
    const prep = async (token: string) => (await api('POST', `/api/workspaces/${wsId}/mosaic/prepare`, { spec }, token)).json as { ok: boolean; statements: string[]; sources: { view: string }[] };
    const exec = (sql: string, token: string) => api('POST', `/api/workspaces/${wsId}/mosaic`, { type: 'exec', sql }, token);
    const mq = (sql: string, token: string) => api('POST', `/api/workspaces/${wsId}/mosaic`, { type: 'json', sql }, token);
    // Info: restricted for the viewer, not for the owner.
    expect((await api('GET', `/api/mosaic/info?workspace_id=${wsId}`, undefined, viewerJwt)).json).toMatchObject({ restricted: true, suffix: expect.stringMatching(/^[0-9a-f]{8}$/) });
    expect((await api('GET', `/api/mosaic/info?workspace_id=${wsId}`)).json).toMatchObject({ restricted: false, suffix: '' });
    // The owner's objects: unsalted, built from every row.
    const own = await prep(jwt);
    expect(own.ok).toBe(true);
    for (const st of own.statements) expect((await exec(st, jwt)).status).toBe(200);
    const ownView = own.sources[0]!.view;
    expect((await mq(`SELECT count(*) AS n FROM "${ownView}"`, jwt)).json).toBeTruthy();
    // The viewer cannot read them — by view or by materialised table.
    const denied = await mq(`SELECT count(*) AS n FROM "${ownView}"`, viewerJwt);
    expect(denied.status).toBe(403);
    const tableOf = (stmts: string[]) => /"duckview_mosaic_mem"\."(src_[0-9a-f]+)"/.exec(stmts.join('\n'))?.[1];
    const ownTable = tableOf(own.statements);
    if (ownTable) expect((await mq(`SELECT count(*) AS n FROM "duckview_mosaic_mem"."${ownTable}"`, viewerJwt)).status).toBe(403);
    // The viewer's own: salted names, their rows, their masks.
    const mine = await prep(viewerJwt);
    expect(mine.ok).toBe(true);
    const myView = mine.sources[0]!.view;
    expect(myView).not.toBe(ownView);
    for (const st of mine.statements) {
      const r = await exec(st, viewerJwt);
      expect(r.status, JSON.stringify(r.json)).toBe(200);
    }
    const got = await mq(`SELECT count(*) AS n, max(ssn) AS s, sum(revenue) AS r FROM "${myView}"`, viewerJwt);
    expect(got.status, JSON.stringify(got.json)).toBe(200);
    expect(got.json.rows).toEqual([[2, null, 300]]);
    // Pre-aggregation is shared by design: refused.
    const pre = await exec('CREATE TABLE IF NOT EXISTS "duckview_mosaic"."preagg_abc123" AS SELECT region, sum(revenue) AS s FROM customers GROUP BY region', viewerJwt);
    expect(pre.status).toBe(403);
    // Someone else under a policy cannot read the viewer's objects.
    await api('POST', `/api/workspaces/${wsId}/policies`, { name: 'Team', table_name: 'customers', row_filter: 'true', applies_to: { all: true } });
    expect((await mq(`SELECT count(*) AS n FROM "${myView}"`, teamJwt)).status).toBe(403);
    for (const x of (await api('GET', `/api/workspaces/${wsId}/policies`)).json.policies as { id: string }[]) await api('DELETE', `/api/policies/${x.id}`);
  });

  it('applies every policy that matches a table, not just the first', async () => {
    const make = (body: Record<string, unknown>) => api('POST', `/api/workspaces/${wsId}/policies`, body, jwt);
    const a = (await make({ name: 'A: EU only', table_name: 'customers', row_filter: "region = 'EU'", column_masks: { email: { kind: 'partial' } }, applies_to: { roles: ['VIEWER'] } })).json.policy;
    const b = (await make({ name: 'B: own rows', table_name: 'customers', row_filter: 'owner_email = {{user.email}}', column_masks: { email: { kind: 'null' } }, applies_to: { roles: ['VIEWER'] } })).json.policy;
    // Both filters: EU and owned by the viewer — one row; the stricter mask (null) wins over partial.
    expect(await rows('SELECT id, email FROM customers ORDER BY id', viewerJwt)).toEqual([[1, null]]);
    await api('DELETE', `/api/policies/${a.id}`);
    expect(await rows('SELECT id FROM customers ORDER BY id', viewerJwt)).toEqual([[1], [3]]);
    await api('DELETE', `/api/policies/${b.id}`);
  });
});
