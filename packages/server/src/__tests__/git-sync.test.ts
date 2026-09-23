/**
 * Git sync against a bare repository on disk: push writes readable files and commits as the person pushing;
 * nothing to push is a no-op; a push is refused while the repository has unpulled commits; pull updates changed
 * objects (recorded as revisions) and creates new ones; another workspace pulls everything in (dashboards with fresh
 * widget ids); URL and token handling.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { loadConfig } from '../config/index.js';
import { initLogger } from '../observability/logger.js';
import { createContext, type AppContext } from '../context.js';
import { buildApp } from '../app.js';
import type { Principal } from '../services/principal.js';

let dir: string;
let bare: string;
let clone: string;
let ctx: AppContext;
let app: Awaited<ReturnType<typeof buildApp>>['app'];
let base: string;
let jwt: string;
let wsId: string;
let otherWs: string;
let admin: Principal;
const ids: Record<string, string> = {};

const api = async (method: string, url: string, body?: unknown) => {
  const res = await fetch(base + url, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), authorization: `Bearer ${jwt}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
};
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: 'Reviewer', GIT_AUTHOR_EMAIL: 'reviewer@example.com', GIT_COMMITTER_NAME: 'Reviewer', GIT_COMMITTER_EMAIL: 'reviewer@example.com', GIT_CONFIG_NOSYSTEM: '1', HOME: dir }, encoding: 'utf8' });

beforeAll(async () => {
  initLogger({ level: 'silent', stderr: true, pretty: false });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dv-git-'));
  bare = path.join(dir, 'analytics.git');
  git(dir, 'init', '-q', '--bare', '-b', 'main', bare);
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  const cfg = loadConfig({ configPath: null, env: { DUCKVIEW_DATA_DIR: path.join(dir, 'data'), DUCKDB_TEMP_DIRECTORY: path.join(dir, 'spill'), DATABASE_URL: ':memory:', DUCKDB_MEMORY_LIMIT: '512MB', DUCKVIEW_ADMIN_EMAIL: 'admin@test.local', DUCKVIEW_ADMIN_PASSWORD: 'super-secret-pw', DUCKVIEW__duckdb__sync_scheduler_enabled: 'false', DUCKVIEW__notifications__scheduler_enabled: 'false', DUCKVIEW__transform__scheduler_enabled: 'false', DUCKVIEW__apps__enabled: 'false', DUCKVIEW__git__allow_local_repos: 'true', DUCKVIEW__git__timeout_seconds: '20', LOG_LEVEL: 'silent' } });
  ctx = await createContext(cfg);
  admin = ctx.auth.principalFromUser((await ctx.auth.findByEmail('admin@test.local'))!, 'jwt', '127.0.0.1');
  wsId = (await ctx.workspaces.create(admin, { name: 'Analytics', active_db_path: 'analytics.duckdb' })).id;
  otherWs = (await ctx.workspaces.create(admin, { name: 'Staging', active_db_path: 'staging.duckdb' })).id;
  await ctx.queries.run(admin, wsId, "CREATE TABLE orders AS SELECT * FROM (VALUES (1, 'EU', 10.0), (2, 'US', 20.0)) t(id, region, amount)", { cache: false });
  await ctx.queries.run(admin, otherWs, "CREATE TABLE orders AS SELECT * FROM (VALUES (1, 'EU', 10.0)) t(id, region, amount)", { cache: false });
  ids.nb = (await ctx.notebooks.create(admin, wsId, { title: 'Revenue review', cells: [{ id: 'c1', type: 'markdown', source: '# Revenue\nBy region.' }, { id: 'c2', type: 'sql', name: 'by_region', source: 'SELECT region, sum(amount) AS revenue\nFROM orders\nGROUP BY 1' }] })).id;
  ids.q = (await ctx.savedQueries.create(admin, wsId, { name: 'EU orders', folder: 'finance/daily', description: 'Orders in Europe', sql_text: "SELECT * FROM orders WHERE region = 'EU'", tags: ['eu', 'orders'] })).id;
  ids.d = (await ctx.dashboards.create(admin, wsId, { name: 'Sales' })).id;
  ids.w = (await ctx.dashboards.addWidget(admin, ids.d, { title: 'Total', widget_type: 'KPI', custom_sql: 'SELECT sum(amount) FROM orders' })).widget.id;
  await ctx.semantic.save(admin, wsId, 'semantic_models:\n  - name: orders\n    table: orders\n    measures:\n      - { name: revenue, agg: sum, expr: amount }\nmetrics:\n  - { name: revenue, type: simple, measure: revenue }\n');
  ids.dbt = (await ctx.dbt.create(admin, wsId, { name: 'Shop models', files: { 'dbt_project.yml': "name: shop\nversion: '1.0'\nprofile: duckview\n", 'models/stg_orders.sql': 'select * from orders\n' } })).id;
  ({ app } = await buildApp(ctx));
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as net.AddressInfo).port}`;
  jwt = (await (await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@test.local', password: 'super-secret-pw' }) })).json()).token;
}, 120_000);

afterAll(async () => {
  await app?.close();
  await ctx?.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('git sync', () => {
  it('checks where it syncs to', async () => {
    expect((await api('PUT', `/api/workspaces/${wsId}/git`, { repo_url: 'https://user:secret@github.com/acme/analytics.git' })).json.message).toMatch(/token field, not in the URL/);
    expect((await api('PUT', `/api/workspaces/${wsId}/git`, { repo_url: 'ssh://git@github.com/acme/a.git' })).status).toBe(400);
    expect((await api('PUT', `/api/workspaces/${wsId}/git`, { repo_url: bare, path: '../escape' })).json.message).toMatch(/inside the repository/);
    expect((await api('GET', `/api/workspaces/${wsId}/git/status`)).status).toBe(404);
    const g = (await api('PUT', `/api/workspaces/${wsId}/git`, { repo_url: bare, branch: 'main', path: 'duckview' })).json.git;
    expect(g).toMatchObject({ repo_url: bare, branch: 'main', path: 'duckview', has_token: false });
  });

  it('pushes the workspace as readable files, once', async () => {
    const status = (await api('GET', `/api/workspaces/${wsId}/git/status`)).json;
    expect(status).toMatchObject({ remote_sha: null, needs_pull: false });
    expect(status.changes.map((c: { path: string }) => c.path).sort()).toEqual(['duckview/dashboards/sales.yml', 'duckview/dbt/shop-models/dbt_project.yml', 'duckview/dbt/shop-models/duckview.yml', 'duckview/dbt/shop-models/models/stg_orders.sql', 'duckview/metrics/semantic.yml', 'duckview/notebooks/revenue-review.yml', 'duckview/queries/finance/daily/eu-orders.sql']);
    const pushed = (await api('POST', `/api/workspaces/${wsId}/git/push`, { message: 'First export' })).json;
    expect(pushed).toMatchObject({ pushed: true, files: 7 });
    expect((await api('POST', `/api/workspaces/${wsId}/git/push`, {})).json).toMatchObject({ pushed: false, sha: pushed.sha });
    // What a reviewer sees.
    clone = path.join(dir, 'clone');
    git(dir, 'clone', '-q', bare, clone);
    expect(git(clone, 'log', '--format=%an <%ae> %s').trim()).toMatch(/^.+ <admin@test\.local> First export$/);
    const nb = fs.readFileSync(path.join(clone, 'duckview/notebooks/revenue-review.yml'), 'utf8');
    expect(nb).toContain('source: |-\n      SELECT region, sum(amount) AS revenue\n      FROM orders\n      GROUP BY 1');
    expect(YAML.parse(nb)).toMatchObject({ duckview: 'notebook', id: ids.nb, title: 'Revenue review' });
    expect(fs.readFileSync(path.join(clone, 'duckview/queries/finance/daily/eu-orders.sql'), 'utf8')).toBe(`-- duckview: query\n-- id: ${ids.q}\n-- name: EU orders\n-- folder: finance/daily\n-- description: Orders in Europe\n-- tags: eu, orders\n\nSELECT * FROM orders WHERE region = 'EU'\n`);
    expect(YAML.parse(fs.readFileSync(path.join(clone, 'duckview/dashboards/sales.yml'), 'utf8')).widgets[0]).toMatchObject({ id: ids.w, title: 'Total', custom_sql: 'SELECT sum(amount) FROM orders' });
  });

  it('refuses to push over commits it has not pulled, then pulls them in as revisions', async () => {
    // A reviewer edits the notebook's SQL and adds a query in the repository.
    const nbFile = path.join(clone, 'duckview/notebooks/revenue-review.yml');
    fs.writeFileSync(nbFile, fs.readFileSync(nbFile, 'utf8').replace('GROUP BY 1', 'GROUP BY 1\n      ORDER BY revenue DESC'));
    fs.writeFileSync(path.join(clone, 'duckview/queries/us-orders.sql'), "-- name: US orders\n\nSELECT * FROM orders WHERE region = 'US'\n");
    git(clone, 'add', '-A');
    git(clone, 'commit', '-q', '-m', 'Sort by revenue; add US orders');
    git(clone, 'push', '-q', 'origin', 'main');
    await ctx.savedQueries.update(admin, wsId, ids.q, { description: 'Orders in the EU' });
    const blocked = await api('POST', `/api/workspaces/${wsId}/git/push`, {});
    expect(blocked.status).toBe(409);
    expect(blocked.json.message).toMatch(/has commits this workspace has not pulled .* pull first/);
    expect((await api('GET', `/api/workspaces/${wsId}/git/status`)).json.needs_pull).toBe(true);
    const pulled = (await api('POST', `/api/workspaces/${wsId}/git/pull`, {})).json;
    expect(pulled).toMatchObject({ updated: ['notebooks/revenue-review.yml'], created: ['queries/us-orders.sql'], conflicts: [], only_in_workspace: [], errors: [] });
    expect((await ctx.notebooks.get(admin, ids.nb)).cells[1]!.source).toBe('SELECT region, sum(amount) AS revenue\nFROM orders\nGROUP BY 1\nORDER BY revenue DESC');
    const us = (await ctx.savedQueries.list(admin, wsId)).find((q) => q.name === 'US orders')!;
    expect(us.sql_text).toBe("SELECT * FROM orders WHERE region = 'US'");
    const history = (await api('GET', `/api/workspaces/${wsId}/revisions?object_type=notebook&object_id=${ids.nb}`)).json.revisions;
    expect(history[0].message).toBe(`Pulled from Git ${pulled.sha.slice(0, 7)}`);
    // The local edit (not in the repository) was kept; now the push goes through, with the new query's id.
    expect((await ctx.savedQueries.get(admin, wsId, ids.q)).description).toBe('Orders in the EU');
    const pushed = (await api('POST', `/api/workspaces/${wsId}/git/push`, {})).json;
    expect(pushed.pushed).toBe(true);
    git(clone, 'pull', '-q');
    expect(fs.readFileSync(path.join(clone, 'duckview/queries/us-orders.sql'), 'utf8')).toMatch(new RegExp(`^-- duckview: query\\n-- id: ${us.id}\\n`));
    expect(fs.readFileSync(path.join(clone, 'duckview/queries/finance/daily/eu-orders.sql'), 'utf8')).toContain('-- description: Orders in the EU');
  });

  it('brings everything into another workspace', async () => {
    await api('PUT', `/api/workspaces/${otherWs}/git`, { repo_url: bare, path: 'duckview' });
    const pulled = (await api('POST', `/api/workspaces/${otherWs}/git/pull`, {})).json;
    expect(pulled.created.sort()).toEqual(['dashboards/sales.yml', 'dbt/shop-models', 'notebooks/revenue-review.yml', 'queries/finance/daily/eu-orders.sql', 'queries/us-orders.sql']);
    expect(pulled.updated).toEqual(['metrics/semantic.yml']);
    expect(pulled.errors).toEqual([]);
    const d = (await ctx.dashboards.list(admin, otherWs))[0]!;
    const full = await ctx.dashboards.get(admin, d.id);
    expect(full.widgets.map((w) => w.title)).toEqual(['Total']);
    expect(full.widgets[0]!.id).not.toBe(ids.w);
    expect(full.layout.map((l) => l.i)).toEqual([full.widgets[0]!.id]);
    expect((await ctx.dbt.list(admin, otherWs))[0]!.name).toBe('Shop models');
    expect((await ctx.semantic.get(admin, otherWs)).metrics.map((m) => m.name)).toEqual(['revenue']);
    // Pulling again changes nothing.
    expect((await api('POST', `/api/workspaces/${otherWs}/git/pull`, {})).json).toMatchObject({ created: [], updated: [] });
    // This workspace pushes (the files now carry its own ids); the first one pulls that back without duplicates.
    expect((await api('POST', `/api/workspaces/${otherWs}/git/push`, { message: 'From staging' })).json.pushed).toBe(true);
    const back = (await api('POST', `/api/workspaces/${wsId}/git/pull`, {})).json;
    expect(back).toMatchObject({ created: [], errors: [] });
    expect((await ctx.notebooks.list(admin, wsId)).length).toBe(1);
    expect((await ctx.savedQueries.list(admin, wsId)).length).toBe(2);
  });

  it('reports a conflict when both sides changed, keeping the local version in history', async () => {
    git(clone, 'pull', '-q');
    const nbFile = path.join(clone, 'duckview/notebooks/revenue-review.yml');
    fs.writeFileSync(nbFile, fs.readFileSync(nbFile, 'utf8').replace('title: Revenue review', 'title: Revenue review (repo)'));
    git(clone, 'commit', '-qam', 'Rename in the repo');
    git(clone, 'push', '-q', 'origin', 'main');
    await ctx.notebooks.update(admin, ids.nb, { title: 'Revenue review (local)' });
    const r = (await api('POST', `/api/workspaces/${wsId}/git/pull`, {})).json;
    expect(r).toMatchObject({ updated: ['notebooks/revenue-review.yml'], conflicts: ['notebooks/revenue-review.yml'] });
    expect((await ctx.notebooks.get(admin, ids.nb)).title).toBe('Revenue review (repo)');
    const h = (await api('GET', `/api/workspaces/${wsId}/revisions?object_type=notebook&object_id=${ids.nb}`)).json.revisions;
    const local = h.find((x: { message: string | null }) => !x.message);
    expect((await api('GET', `/api/revisions/${local.id}`)).json.text).toMatch(/^# Revenue review \(local\)/);
  });

  it('keeps tokens out of errors and settings', async () => {
    const g = (await api('PUT', `/api/workspaces/${otherWs}/git`, { repo_url: 'https://127.0.0.1:9/acme/analytics.git', token: 'ghp_supersecrettoken123' })).json.git;
    expect(g.has_token).toBe(true);
    expect(JSON.stringify(g)).not.toContain('ghp_supersecret');
    const r = await api('POST', `/api/workspaces/${otherWs}/git/pull`, {});
    expect(r.status).toBe(400);
    expect(r.json.message).toMatch(/^git fetch: /);
    expect(r.json.message).not.toContain('ghp_supersecret');
    expect((await api('GET', `/api/workspaces/${otherWs}/git`)).json.git.last_error).toMatch(/^git fetch/);
  });
});
