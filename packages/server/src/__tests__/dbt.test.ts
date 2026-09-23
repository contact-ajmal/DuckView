/**
 * dbt projects with real dbt Core + dbt-duckdb: the starter builds (seed, views, table, tests), docs become catalog
 * notes, incremental models append and merge on unique_key, a failing test skips what is downstream, compile errors
 * surface, selection narrows the run, env_var() cannot read the server's environment, viewers cannot build,
 * lineage shows what a project builds, and the scheduler starts due runs.
 *
 * dbt is installed on first use into DUCKVIEW_TEST_DBT_VENV (default: a cached venv in the temp directory), which
 * needs python3 and network the first time.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../config/index.js';
import { initLogger } from '../observability/logger.js';
import { createContext, type AppContext } from '../context.js';
import { buildApp } from '../app.js';
import { evalCondition } from '../services/dbt.js';
import { buildTools, runTool, type ToolEnv } from '../agent/tools.js';
import type { Principal } from '../services/principal.js';

const hasPython = (() => {
  try {
    execFileSync('python3', ['--version']);
    return true;
  } catch {
    return false;
  }
})();

let dir: string;
let ctx: AppContext;
let app: Awaited<ReturnType<typeof buildApp>>['app'];
let base: string;
let jwt: string;
let viewerJwt: string;
let wsId: string;
let admin: Principal;

const api = async (method: string, url: string, body?: unknown, token = jwt) => {
  const res = await fetch(base + url, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
};
const sql = async (q: string) => (await ctx.queries.run(admin, wsId, q, { cache: false })).rows;

describe('dbt condition', () => {
  it('evaluates warn_if / error_if like dbt', () => {
    expect(evalCondition('!=0', 0)).toBe(false);
    expect(evalCondition('!=0', 2)).toBe(true);
    expect(evalCondition('>10', 10)).toBe(false);
    expect(evalCondition('>= 10', 10)).toBe(true);
  });
});

describe.skipIf(!hasPython)('dbt projects', () => {
  beforeAll(async () => {
    initLogger({ level: 'silent', stderr: true, pretty: false });
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dv-dbt-'));
    fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
    process.env.DV_TEST_SERVER_SECRET = 'do-not-leak';
    const cfg = loadConfig({ configPath: null, env: { DUCKVIEW_DATA_DIR: path.join(dir, 'data'), DUCKDB_TEMP_DIRECTORY: path.join(dir, 'spill'), DATABASE_URL: ':memory:', DUCKDB_MEMORY_LIMIT: '512MB', DUCKVIEW_ADMIN_EMAIL: 'admin@test.local', DUCKVIEW_ADMIN_PASSWORD: 'super-secret-pw', DUCKVIEW__duckdb__sync_scheduler_enabled: 'false', DUCKVIEW__notifications__scheduler_enabled: 'false', DUCKVIEW__transform__scheduler_enabled: 'false', DUCKVIEW__apps__enabled: 'false', DUCKVIEW__transform__dbt__venv_dir: process.env.DUCKVIEW_TEST_DBT_VENV ?? path.join(os.tmpdir(), 'duckview-test-dbt-venv'), LOG_LEVEL: 'silent' } });
    ctx = await createContext(cfg);
    admin = ctx.auth.principalFromUser((await ctx.auth.findByEmail('admin@test.local'))!, 'jwt', '127.0.0.1');
    const viewer = await ctx.auth.createLocalUser({ email: 'viewer@test.local', password: 'viewer-secret-pw', role: 'USER' });
    wsId = (await ctx.workspaces.create(admin, { name: 'Shop', active_db_path: 'shop.duckdb' })).id;
    await ctx.workspaces.setMember(admin, wsId, { subject_type: 'user', subject_id: viewer.id, role: 'VIEWER' });
    ({ app } = await buildApp(ctx));
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(app.server.address() as net.AddressInfo).port}`;
    jwt = (await api('POST', '/api/auth/login', { email: 'admin@test.local', password: 'super-secret-pw' }, '')).json.token;
    viewerJwt = (await api('POST', '/api/auth/login', { email: 'viewer@test.local', password: 'viewer-secret-pw' }, '')).json.token;
  }, 900_000);

  afterAll(async () => {
    await app?.close();
    await ctx?.shutdown();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  let projectId: string;
  let files: Record<string, string>;
  const run = async (body: Record<string, unknown>, token = jwt) => api('POST', `/api/dbt/projects/${projectId}/runs`, { wait: true, ...body }, token);
  const save = async (extra: Record<string, string>) => {
    files = { ...files, ...extra };
    expect((await api('PATCH', `/api/dbt/projects/${projectId}`, { files })).status).toBe(200);
  };

  it('builds the starter: seed, models, tests, catalog notes', async () => {
    const created = await api('POST', `/api/workspaces/${wsId}/dbt/projects`, { name: 'Shop models' });
    expect(created.status).toBe(200);
    projectId = created.json.project.id;
    files = created.json.project.files;
    expect(Object.keys(files)).toEqual(expect.arrayContaining(['dbt_project.yml', 'models/marts/region_totals.sql', 'seeds/regions.csv']));

    const r = (await run({ command: 'build' })).json.run;
    expect(r.error).toBeNull();
    expect(r.status).toBe('ok');
    const by = (name: string) => r.results.find((x: { name: string }) => x.name === name);
    expect(by('regions')).toMatchObject({ resource_type: 'seed', status: 'success', rows: 3 });
    expect(by('stg_numbers')).toMatchObject({ resource_type: 'model', materialized: 'view', status: 'success' });
    expect(by('region_totals')).toMatchObject({ materialized: 'table', status: 'success', rows: 3, depends_on: expect.arrayContaining(['stg_numbers', 'regions']) });
    expect(r.results.filter((x: { resource_type: string; status: string }) => x.resource_type === 'test' && x.status === 'pass')).toHaveLength(4);
    // Seeds before models, tests after what they test.
    const order = r.results.map((x: { name: string }) => x.name);
    expect(order.indexOf('regions')).toBeLessThan(order.indexOf('region_totals'));
    expect(await sql('SELECT region_name, orders FROM region_totals ORDER BY 1')).toEqual([['Asia Pacific', 10], ['Europe', 10], ['United States', 10]]);
    expect(r.summary).toMatch(/3 ok · 4 tests passed/);
    // The project's docs are catalog notes now.
    const cat = (await api('GET', `/api/workspaces/${wsId}/catalog/annotated`)).json.objects as { name: string; description: string | null; tags: string[]; columns: { name: string; description: string | null }[] }[];
    const totals = cat.find((o) => o.name === 'region_totals')!;
    expect(totals).toMatchObject({ description: 'Orders and revenue per region.', tags: ['finance'] });
    expect(totals.columns.find((c) => c.name === 'region_name')!.description).toBe('Region name, from the regions seed');
    // History and live status.
    expect((await api('GET', `/api/dbt/projects/${projectId}/runs`)).json.runs[0]).toMatchObject({ id: r.id, status: 'ok', command: 'build' });
    expect((await api('GET', `/api/dbt/projects/${projectId}`)).json.project.last_run).toMatchObject({ run_id: r.id, status: 'ok' });
    expect((await api('GET', `/api/dbt/runs/${r.id}`)).json.run.log).toMatch(/Found \d+ models?/);
  }, 900_000);

  it('runs incremental models with and without a full refresh', async () => {
    await sql("CREATE TABLE raw_orders AS SELECT * FROM (VALUES (1, 'EU', 10.0), (2, 'US', 20.0)) t(id, region, amount)");
    await save({
      'models/staging/sources.yml': 'version: 2\nsources:\n  - name: raw\n    schema: main\n    tables:\n      - name: raw_orders\n',
      'models/orders_inc.sql': "{{ config(materialized='incremental', unique_key='id') }}\nselect id, region, amount from {{ source('raw', 'raw_orders') }}\n{% if is_incremental() %}where id >= (select max(id) from {{ this }}){% endif %}\n",
    });
    const first = (await run({ command: 'run', select: 'orders_inc' })).json.run;
    expect(first.results).toMatchObject([{ name: 'orders_inc', status: 'success', rows: 2 }]);
    // New rows and a changed row with the highest id: the incremental run sees is_incremental() and merges on id.
    await sql("UPDATE raw_orders SET amount = 25.0 WHERE id = 2; INSERT INTO raw_orders VALUES (3, 'EU', 30.0)");
    const second = (await run({ command: 'run', select: 'orders_inc' })).json.run;
    expect(second.results[0]).toMatchObject({ status: 'success', rows: 2 });
    expect(second.results[0].sql).toMatch(/where id >= \(select max\(id\) from "shop"\."main"\."orders_inc"\)/);
    expect(await sql('SELECT id, amount FROM orders_inc ORDER BY id')).toEqual([[1, 10], [2, 25], [3, 30]]);
    // A full refresh rebuilds from scratch.
    const full = (await run({ command: 'run', select: 'orders_inc', full_refresh: true })).json.run;
    expect(full.results[0]).toMatchObject({ status: 'success', rows: 3 });
    expect(full.results[0].sql).not.toMatch(/max\(id\)/);
  }, 600_000);

  it('skips downstream models when a test fails, and reports compile errors', async () => {
    await save({
      'models/marts/region_report.sql': "select * from {{ ref('region_totals') }} where revenue > 0\n",
      'tests/too_many_orders.sql': "select * from {{ ref('region_totals') }} where orders > 5\n",
    });
    const r = (await run({ command: 'build', select: 'region_totals+' })).json.run;
    expect(r.status).toBe('error');
    const by = (name: string) => r.results.find((x: { name: string }) => x.name === name);
    expect(by('region_totals').status).toBe('success');
    expect(by('too_many_orders')).toMatchObject({ resource_type: 'test', status: 'fail', failures: 3, message: '3 failing rows' });
    expect(by('region_report')).toMatchObject({ status: 'skipped' });
    expect(r.summary).toMatch(/1 failed/);
    // As a warning the run passes and the downstream model builds.
    await save({ 'tests/too_many_orders.sql': "{{ config(severity='warn') }}\nselect * from {{ ref('region_totals') }} where orders > 5\n" });
    const warned = (await run({ command: 'build', select: 'region_totals+' })).json.run;
    expect(warned.status).toBe('ok');
    expect(warned.results.find((x: { name: string }) => x.name === 'too_many_orders').status).toBe('warn');
    expect(warned.results.find((x: { name: string }) => x.name === 'region_report').status).toBe('success');

    // A broken ref fails at compile time with dbt's message.
    await save({ 'models/broken.sql': "select * from {{ ref('does_not_exist') }}\n" });
    const broken = (await run({ command: 'build' })).json.run;
    expect(broken.status).toBe('error');
    expect(broken.error).toMatch(/dbt compile failed: .*does_not_exist/);
    const { 'models/broken.sql': _gone, ...rest } = files;
    files = rest;
    await api('PATCH', `/api/dbt/projects/${projectId}`, { files });
  }, 600_000);

  it('narrows runs, compiles without secrets, and keeps viewers read-only', async () => {
    const one = (await run({ command: 'run', select: 'stg_numbers' })).json.run;
    expect(one.results.map((x: { name: string }) => x.name)).toEqual(['stg_numbers']);
    await save({ 'models/leak.sql': "select '{{ env_var(\"DV_TEST_SERVER_SECRET\", \"none\") }}' as s\n" });
    const compiled = (await run({ command: 'compile', select: 'leak' })).json.run;
    expect(compiled.results[0]).toMatchObject({ name: 'leak', status: 'compiled' });
    expect(compiled.results[0].sql).toContain("'none'");
    expect(compiled.results[0].sql).not.toContain('do-not-leak');
    // Viewers see projects and may compile, but not build.
    expect((await api('GET', `/api/workspaces/${wsId}/dbt/projects`, undefined, viewerJwt)).json.projects).toHaveLength(1);
    expect((await run({ command: 'build' }, viewerJwt)).status).toBe(403);
    expect((await api('PATCH', `/api/dbt/projects/${projectId}`, { name: 'x' }, viewerJwt)).status).toBe(403);
    // Only project files are accepted.
    expect((await api('PATCH', `/api/dbt/projects/${projectId}`, { files: { ...files, 'profiles.yml': 'x: 1' } })).status).toBe(400);
    expect((await api('PATCH', `/api/dbt/projects/${projectId}`, { files: { ...files, '../escape.sql': 'select 1' } })).status).toBe(400);
  }, 600_000);

  it('turns a SELECT into a model, with ref() for the project\'s own models', async () => {
    const r = await api('POST', `/api/dbt/projects/${projectId}/models`, { name: 'big_regions', sql: 'SELECT region_name, revenue FROM region_totals WHERE revenue > 100;', folder: 'marts', materialized: 'table', description: 'Regions with revenue over 100' });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ path: 'models/marts/big_regions.sql', refs: ['region_totals'] });
    expect(r.json.sql).toBe("{{ config(materialized='table') }}\n\nSELECT region_name, revenue FROM {{ ref('region_totals') }} WHERE revenue > 100\n");
    expect(r.json.project.files['models/marts/big_regions.yml']).toMatch(/description: "Regions with revenue over 100"/);
    files = r.json.project.files;
    expect((await api('POST', `/api/dbt/projects/${projectId}/models`, { name: 'big_regions', sql: 'select 1', folder: 'marts' })).status).toBe(409);
    const built = (await run({ command: 'build', select: 'big_regions' })).json.run;
    expect(built.results[0]).toMatchObject({ name: 'big_regions', status: 'success', materialized: 'table', depends_on: ['region_totals'] });
    // PATCH files: add and delete in one go.
    const patched = await api('PATCH', `/api/dbt/projects/${projectId}/files`, { files: { 'macros/cents.sql': '{% macro cents(c) %}({{ c }} * 100)::BIGINT{% endmacro %}\n', 'models/leak.sql': null } });
    expect(Object.keys(patched.json.project.files)).toEqual(expect.arrayContaining(['macros/cents.sql']));
    expect(Object.keys(patched.json.project.files)).not.toContain('models/leak.sql');
    files = patched.json.project.files;
  }, 600_000);

  it('lets agents work on dbt through the tools, building only after approval', async () => {
    const agent = ctx.auth.principalFromUser((await ctx.auth.findByEmail('admin@test.local'))!, 'token', '127.0.0.1');
    expect(agent.actorType).toBe('AGENT');
    const env: ToolEnv = { ctx, principal: agent, via: 'mcp', defaultWorkspaceId: wsId, agent: null };
    const tools = buildTools(ctx.cfg);
    const call = (name: string, args: Record<string, unknown>) => runTool(env, tools.find((t) => t.name === name)!, args);
    const listed = await call('list_dbt_projects', {});
    expect((listed.structuredContent as { projects: { id: string; models: string[] }[] }).projects[0]).toMatchObject({ id: projectId, models: expect.arrayContaining(['region_totals', 'big_regions']) });
    const read = await call('get_dbt_project', { project_id: projectId, paths: ['models/marts/region_totals.sql'] });
    expect((read.structuredContent as { files: Record<string, string> }).files['models/marts/region_totals.sql']).toMatch(/ref\('stg_numbers'\)/);
    const model = await call('create_dbt_model', { project_id: projectId, name: 'agent_totals', sql: 'select region_name, {{ cents("revenue") }} as revenue_cents from region_totals', folder: 'marts' });
    expect(model.isError).toBeFalsy();
    // Compile needs no approval; build does, listing what it would create.
    const compiled = await call('run_dbt', { project_id: projectId, command: 'compile', select: 'agent_totals' });
    expect((compiled.structuredContent as { results: { sql: string }[] }).results[0].sql).toMatch(/\(revenue \* 100\)::BIGINT/);
    const blocked = await call('run_dbt', { project_id: projectId, command: 'build', select: 'agent_totals' });
    expect(blocked.structuredContent).toMatchObject({ status: 'approval_required', mutating_verbs: ['CREATE VIEW'], statements: [{ preview: 'CREATE VIEW agent_totals (view)' }] });
    expect(await sql("SELECT count(*) FROM information_schema.tables WHERE table_name = 'agent_totals'")).toEqual([[0]]);
    const approved = await call('run_dbt', { project_id: projectId, command: 'build', select: 'agent_totals', dry_run: false });
    expect(approved.structuredContent).toMatchObject({ status: 'ok' });
    expect(await sql('SELECT min(revenue_cents) > 0 FROM agent_totals')).toEqual([[true]]);
    const runId = (approved.structuredContent as { run_id: string }).run_id;
    const got = await call('get_dbt_run', { run_id: runId, include_log: true });
    expect((got.content[0] as { text: string }).text).toMatch(/agent_totals/);
    expect((await ctx.dbt.getRun(admin, runId)).triggered_by).toBe('agent');
    const written = await call('write_dbt_files', { project_id: projectId, files: { 'models/marts/agent_totals.sql': null } });
    expect((written.structuredContent as { paths: string[] }).paths).not.toContain('models/marts/agent_totals.sql');
    // Over REST an agent token gets the same challenge.
    const token = (await ctx.auth.createToken((await ctx.auth.findByEmail('admin@test.local'))!, { name: 'agent', scopes: ['read', 'write', 'mcp'] })).token;
    const rest = await api('POST', `/api/dbt/projects/${projectId}/runs`, { command: 'run', select: 'stg_numbers', wait: true }, token);
    expect(rest.status).toBe(409);
    expect(rest.json).toMatchObject({ error: 'APPROVAL_REQUIRED', challenge: { status: 'approval_required' } });
    expect((await api('POST', `/api/dbt/projects/${projectId}/runs`, { command: 'run', select: 'stg_numbers', wait: true, dry_run: false }, token)).json.run.status).toBe('ok');
  }, 600_000);

  it('gives Copilot the projects, their models and what failed', async () => {
    await save({ 'models/broken_two.sql': 'select no_such_column from {{ ref(\'stg_numbers\') }}\n' });
    const failed = (await run({ command: 'run', select: 'broken_two' })).json.run;
    expect(failed.status).toBe('error');
    const snap = await ctx.copilot.buildContext(admin, wsId);
    expect(snap.dbt).toMatch(/\*\*Shop models\*\*/);
    expect(snap.dbt).toMatch(/region_totals \[table\]/);
    expect(snap.dbt).toMatch(/error: broken_two — .*no_such_column/);
    expect(ctx.copilot.renderContextText(snap)).toMatch(/### dbt projects of this workspace/);
    const { 'models/broken_two.sql': _gone, ...rest } = files;
    files = rest;
    await api('PATCH', `/api/dbt/projects/${projectId}`, { files });
  }, 600_000);

  it('shows what the project builds in lineage, and schedules runs', async () => {
    const g = (await api('GET', `/api/workspaces/${wsId}/lineage`)).json as { nodes: { id: string; kind: string }[]; edges: { from: string; to: string; kind: string }[] };
    expect(g.nodes.find((n) => n.id === `dbt:${projectId}`)).toMatchObject({ kind: 'dbt' });
    expect(g.edges).toEqual(expect.arrayContaining([{ from: `dbt:${projectId}`, to: 'table:region_totals', kind: 'builds' }, { from: 'view:stg_numbers', to: 'table:region_totals', kind: 'reads' }]));

    const p = (await api('PATCH', `/api/dbt/projects/${projectId}`, { schedule: { kind: 'interval', minutes: 60 }, scheduled: { command: 'run', select: 'stg_numbers' } })).json.project;
    expect(new Date(p.next_run_at).getTime()).toBeGreaterThan(Date.now());
    expect(await ctx.dbt.tick(new Date(Date.now() + 2 * 3600_000))).toEqual([projectId]);
    for (let i = 0; i < 600 && (await api('GET', `/api/dbt/projects/${projectId}`)).json.project.last_run.status === 'running'; i++) await new Promise((r) => setTimeout(r, 200));
    const runs = (await api('GET', `/api/dbt/projects/${projectId}/runs`)).json.runs;
    expect(runs[0]).toMatchObject({ triggered_by: 'schedule', command: 'run', select: 'stg_numbers', status: 'ok' });
  }, 600_000);
});
