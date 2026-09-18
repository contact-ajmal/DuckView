/**
 * Workspace sharing and teams: membership resolution (direct + group), role enforcement across SQL, files,
 * saved queries, dashboards and agent tools, per-user tabs, transfer/leave, SSO group sync and cleanup on delete.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../config/index.js';
import { initLogger } from '../observability/logger.js';
import { createContext, type AppContext } from '../context.js';
import { buildApp } from '../app.js';
import { buildTools, runTool, type ToolEnv } from '../agent/tools.js';
import { extractGroups } from '../routes/auth.js';
import type { Principal } from '../services/principal.js';
import type { User } from '../db/schema/sqlite.js';

let dir: string;
let ctx: AppContext;
let app: Awaited<ReturnType<typeof buildApp>>['app'];
let base: string;

let adminU: User, aliceU: User, bobU: User, carolU: User, roU: User;
let admin: Principal, alice: Principal, bob: Principal, carol: Principal, ro: Principal;
let wsId: string; // alice's workspace
const tokens: Record<string, string> = {};

const api = async (method: string, url: string, body?: unknown, token?: string) => {
  const res = await fetch(base + url, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
};
const login = async (email: string, password: string) => (await api('POST', '/api/auth/login', { email, password })).json.token as string;

beforeAll(async () => {
  initLogger({ level: 'silent', stderr: true, pretty: false });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dv-share-'));
  const cfg = loadConfig({
    configPath: null,
    env: { DUCKVIEW_DATA_DIR: path.join(dir, 'data'), DUCKVIEW_FILESYSTEM_MODE: 'sandboxed', DUCKDB_TEMP_DIRECTORY: path.join(dir, 'spill'), DATABASE_URL: ':memory:', DUCKDB_MEMORY_LIMIT: '512MB', DUCKVIEW_ADMIN_EMAIL: 'admin@test.local', DUCKVIEW_ADMIN_PASSWORD: 'super-secret-pw', LOG_LEVEL: 'silent' },
  });
  ctx = await createContext(cfg);
  adminU = (await ctx.auth.findByEmail('admin@test.local'))!;
  aliceU = await ctx.auth.createLocalUser({ email: 'alice@test.local', password: 'alice-password', role: 'USER', displayName: 'Alice' });
  bobU = await ctx.auth.createLocalUser({ email: 'bob@test.local', password: 'bob-password-1', role: 'USER', displayName: 'Bob' });
  carolU = await ctx.auth.createLocalUser({ email: 'carol@test.local', password: 'carol-password', role: 'USER' });
  roU = await ctx.auth.createLocalUser({ email: 'ro@test.local', password: 'readonly-pass', role: 'READ_ONLY' });
  const pr = (u: User) => ctx.auth.principalFromUser(u, 'jwt', '127.0.0.1');
  [admin, alice, bob, carol, ro] = [adminU, aliceU, bobU, carolU, roU].map(pr);
  wsId = (await ctx.workspaces.create(alice, { name: 'Alice analytics' })).id;
  await ctx.queries.run(alice, wsId, 'CREATE TABLE sales AS SELECT range AS id, range * 10 AS amount FROM range(50)');
  ({ app } = await buildApp(ctx));
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  tokens.admin = await login('admin@test.local', 'super-secret-pw');
  tokens.alice = await login('alice@test.local', 'alice-password');
  tokens.bob = await login('bob@test.local', 'bob-password-1');
  tokens.carol = await login('carol@test.local', 'carol-password');
  tokens.ro = await login('ro@test.local', 'readonly-pass');
});

afterAll(async () => {
  await app.close();
  await ctx.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('workspace membership', () => {
  it('is private until shared: non-members get 404, owners are OWNER, admins see everything', async () => {
    await expect(ctx.workspaces.get(bob, wsId)).rejects.toThrow(/not found/);
    expect((await ctx.workspaces.get(alice, wsId)).role).toBe('OWNER');
    expect((await ctx.workspaces.get(admin, wsId)).role).toBe('OWNER');
    expect((await ctx.workspaces.list(bob)).map((w) => w.id)).not.toContain(wsId);
    expect((await ctx.workspaces.list(admin)).map((w) => w.id)).toContain(wsId);
    // Admin tokens do not inherit the platform-admin override.
    const adminToken: Principal = { ...admin, via: 'token', actorType: 'AGENT' };
    await expect(ctx.workspaces.get(adminToken, wsId)).rejects.toThrow(/not found/);
  });

  it('only owners can share; grants show up in the listing with owner and role', async () => {
    await expect(ctx.workspaces.setMember(bob, wsId, { subject_type: 'user', subject_id: bobU.id, role: 'EDITOR' })).rejects.toThrow(/not found/);
    const members = await ctx.workspaces.setMember(alice, wsId, { subject_type: 'user', subject_id: bobU.id, role: 'VIEWER' });
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({ subject_type: 'user', subject_id: bobU.id, role: 'VIEWER', email: 'bob@test.local', name: 'Bob' });
    const listing = await ctx.workspaces.list(bob);
    const shared = listing.find((w) => w.id === wsId)!;
    expect(shared).toMatchObject({ role: 'VIEWER', shared: true, member_count: 1, owner: { email: 'alice@test.local', display_name: 'Alice' } });
    // Bob cannot escalate himself; the owner cannot be granted a lesser role.
    await expect(ctx.workspaces.setMember(bob, wsId, { subject_type: 'user', subject_id: bobU.id, role: 'OWNER' })).rejects.toThrow(/edit|manage|view/i);
    await expect(ctx.workspaces.setMember(alice, wsId, { subject_type: 'user', subject_id: aliceU.id, role: 'VIEWER' })).rejects.toThrow(/already has full access/);
  });

  it('VIEWER: read-only SQL works, mutations / uploads / saved queries / dashboards / folders are refused', async () => {
    const r = await ctx.queries.run(bob, wsId, 'SELECT count(*) AS n FROM sales');
    expect(r.rows).toEqual([[50]]);
    await expect(ctx.queries.run(bob, wsId, 'DELETE FROM sales WHERE id = 1')).rejects.toThrow(/view-only/);
    await expect(ctx.queries.saveDataset(bob, wsId, { sql: 'SELECT 1', format: 'csv', target: 'x', dryRun: false })).rejects.toThrow(/edit access/);
    await expect(ctx.savedQueries.create(bob, wsId, { name: 'q', sql_text: 'SELECT 1' })).rejects.toThrow(/edit access/);
    await expect(ctx.dashboards.create(bob, wsId, { name: 'd' })).rejects.toThrow(/edit access/);
    await expect(ctx.workspaces.addFolder(bob, wsId, dir)).rejects.toThrow(/edit access/);
    await expect(ctx.workspaces.update(bob, wsId, { name: 'hijack' })).rejects.toThrow(/manage/);
    await expect(ctx.workspaces.remove(bob, wsId)).rejects.toThrow(/manage/);
    // Reads of shared artefacts are fine.
    const q = await ctx.savedQueries.create(alice, wsId, { name: 'totals', sql_text: 'SELECT sum(amount) FROM sales' });
    expect((await ctx.savedQueries.list(bob, wsId)).map((x) => x.id)).toContain(q.id);
    const d = await ctx.dashboards.create(alice, wsId, { name: 'Sales' });
    expect((await ctx.dashboards.get(bob, d.id)).name).toBe('Sales');
    await expect(ctx.dashboards.update(bob, d.id, { name: 'nope' })).rejects.toThrow(/edit access/);
  });

  it('EDITOR: mutations, saved queries and dashboards work; settings and sharing stay OWNER-only', async () => {
    await ctx.workspaces.setMember(alice, wsId, { subject_type: 'user', subject_id: bobU.id, role: 'EDITOR' });
    expect((await ctx.workspaces.get(bob, wsId)).role).toBe('EDITOR');
    const del = await ctx.queries.run(bob, wsId, 'DELETE FROM sales WHERE id = 0');
    expect(del.rowsChanged).toBe(1);
    const q = await ctx.savedQueries.create(bob, wsId, { name: 'bobs', sql_text: 'SELECT 1' });
    expect(q.user_id).toBe(bobU.id);
    const d = await ctx.dashboards.create(bob, wsId, { name: 'Bob board' });
    await ctx.dashboards.addWidget(bob, d.id, { title: 'n', widget_type: 'KPI', custom_sql: 'SELECT count(*) AS n FROM sales' });
    expect((await ctx.dashboards.get(alice, d.id)).widgets).toHaveLength(1);
    await expect(ctx.workspaces.update(bob, wsId, { name: 'renamed by bob' })).rejects.toThrow(/manage/);
    await expect(ctx.workspaces.setMember(bob, wsId, { subject_type: 'user', subject_id: carolU.id, role: 'VIEWER' })).rejects.toThrow(/manage/);
  });

  it('co-OWNER grants can manage sharing but the primary owner is unaffected', async () => {
    await ctx.workspaces.setMember(alice, wsId, { subject_type: 'user', subject_id: bobU.id, role: 'OWNER' });
    const members = await ctx.workspaces.setMember(bob, wsId, { subject_type: 'user', subject_id: carolU.id, role: 'VIEWER' });
    expect(members.map((m) => m.subject_id).sort()).toEqual([bobU.id, carolU.id].sort());
    expect((await ctx.workspaces.get(carol, wsId)).role).toBe('VIEWER');
    const carolGrant = members.find((m) => m.subject_id === carolU.id)!;
    await ctx.workspaces.removeMember(bob, wsId, carolGrant.id);
    await expect(ctx.workspaces.get(carol, wsId)).rejects.toThrow(/not found/);
    await ctx.workspaces.setMember(alice, wsId, { subject_type: 'user', subject_id: bobU.id, role: 'VIEWER' });
  });

  it('tabs are per user inside a shared workspace', async () => {
    const aliceTabs = await ctx.workspaces.listTabs(alice, wsId);
    expect(aliceTabs.length).toBeGreaterThan(0);
    expect(aliceTabs.every((t) => t.user_id === aliceU.id)).toBe(true);
    expect(await ctx.workspaces.listTabs(bob, wsId)).toEqual([]);
    const t = await ctx.workspaces.createTab(bob, wsId, { title: 'Bob scratch', sql_content: 'SELECT 2' });
    expect(t.user_id).toBe(bobU.id);
    expect((await ctx.workspaces.listTabs(bob, wsId)).map((x) => x.id)).toEqual([t.id]);
    expect((await ctx.workspaces.listTabs(alice, wsId)).map((x) => x.id)).not.toContain(t.id);
    await expect(ctx.workspaces.updateTab(alice, wsId, t.id, { title: 'stolen' })).rejects.toThrow(/Tab not found/);
    await expect(ctx.workspaces.deleteTab(alice, wsId, t.id)).rejects.toThrow(/Tab not found/);
  });

  it('leave removes a direct grant and its tabs; owners cannot leave', async () => {
    await ctx.workspaces.leave(bob, wsId);
    await expect(ctx.workspaces.get(bob, wsId)).rejects.toThrow(/not found/);
    await expect(ctx.workspaces.leave(alice, wsId)).rejects.toThrow(/owner cannot leave/);
    await ctx.workspaces.setMember(alice, wsId, { subject_type: 'user', subject_id: bobU.id, role: 'VIEWER' });
    expect(await ctx.workspaces.listTabs(bob, wsId)).toEqual([]);
  });
});

describe('teams (groups)', () => {
  let analystsId: string;

  it('admins create teams; members are visible to admins, managers and members', async () => {
    await expect(ctx.groups.create(alice, { name: 'Analysts' })).rejects.toThrow(/administrators/);
    const g = await ctx.groups.create(admin, { name: '  Analysts  ', description: 'Data team' });
    analystsId = g.id;
    expect(g.name).toBe('Analysts');
    await expect(ctx.groups.create(admin, { name: 'analysts' })).resolves.toBeTruthy(); // names are case-sensitive but distinct
    await ctx.groups.addMember(admin, analystsId, carolU.id, 'MANAGER');
    await expect(ctx.groups.members(bob, analystsId)).rejects.toThrow(/not a member/);
    // Carol (manager) can add Bob; Bob (member) cannot add others.
    const members = await ctx.groups.addMember(carol, analystsId, bobU.id);
    expect(members.map((m) => [m.email, m.role])).toEqual([['carol@test.local', 'MANAGER'], ['bob@test.local', 'MEMBER']]);
    await expect(ctx.groups.addMember(bob, analystsId, aliceU.id)).rejects.toThrow(/team managers/);
    const listing = await ctx.groups.list(bob);
    expect(listing.find((x) => x.id === analystsId)).toMatchObject({ member_count: 2, my_role: 'MEMBER' });
  });

  it('a workspace shared with a team reaches every member; the best of direct/group grants wins', async () => {
    const teamWs = await ctx.workspaces.create(alice, { name: 'Team space' });
    await ctx.workspaces.setMember(alice, teamWs.id, { subject_type: 'group', subject_id: analystsId, role: 'EDITOR' });
    expect((await ctx.workspaces.get(bob, teamWs.id)).role).toBe('EDITOR');
    expect((await ctx.workspaces.get(carol, teamWs.id)).role).toBe('EDITOR');
    // Direct VIEWER + group EDITOR → EDITOR; direct OWNER + group EDITOR → OWNER.
    await ctx.workspaces.setMember(alice, teamWs.id, { subject_type: 'user', subject_id: bobU.id, role: 'VIEWER' });
    expect((await ctx.workspaces.get(bob, teamWs.id)).role).toBe('EDITOR');
    await ctx.workspaces.setMember(alice, teamWs.id, { subject_type: 'user', subject_id: carolU.id, role: 'OWNER' });
    expect((await ctx.workspaces.get(carol, teamWs.id)).role).toBe('OWNER');
    const view = await ctx.workspaces.listMembers(bob, teamWs.id);
    expect(view.find((m) => m.subject_type === 'group')).toMatchObject({ name: 'Analysts', external: false, role: 'EDITOR' });
    // Group access cannot be "left" directly.
    await ctx.workspaces.leave(bob, teamWs.id); // removes the direct VIEWER grant …
    expect((await ctx.workspaces.get(bob, teamWs.id)).role).toBe('EDITOR'); // … but the team still grants access
    await expect(ctx.workspaces.leave(bob, teamWs.id)).rejects.toThrow(/leave the team/);
    // Leaving the team removes it.
    await ctx.groups.removeMember(bob, analystsId, bobU.id);
    await expect(ctx.workspaces.get(bob, teamWs.id)).rejects.toThrow(/not found/);
    await ctx.groups.addMember(carol, analystsId, bobU.id);
    // Deleting the team drops its grants.
    const throwaway = await ctx.groups.create(admin, { name: 'Temp' });
    await ctx.workspaces.setMember(alice, teamWs.id, { subject_type: 'group', subject_id: throwaway.id, role: 'VIEWER' });
    await ctx.groups.remove(admin, throwaway.id);
    expect((await ctx.workspaces.listMembers(alice, teamWs.id)).some((m) => m.subject_id === throwaway.id)).toBe(false);
  });

  it('SSO sync mirrors IdP groups, re-syncs membership and leaves manual teams alone', async () => {
    const first = await ctx.groups.syncExternal(carolU.id, ['okta:data-eng', 'okta:finance']);
    expect(first.created).toBe(2);
    expect(first.groups.map((g) => g.external_id).sort()).toEqual(['okta:data-eng', 'okta:finance']);
    // A manual team with the same display name gets a suffix rather than a collision.
    await ctx.groups.create(admin, { name: 'okta:platform' });
    const second = await ctx.groups.syncExternal(carolU.id, ['okta:data-eng', 'okta:platform']);
    expect(second.created).toBe(1);
    expect(second.groups.find((g) => g.external_id === 'okta:platform')!.name).toBe('okta:platform (SSO)');
    const carolGroups = await ctx.groups.byIds(await ctx.groups.groupIdsFor(carolU.id));
    const ext = carolGroups.filter((g) => g.external_id).map((g) => g.external_id).sort();
    expect(ext).toEqual(['okta:data-eng', 'okta:platform']); // finance removed, Analysts (manual) kept
    expect(carolGroups.some((g) => g.id === analystsId)).toBe(true);
    // Claim parsing: arrays, scalars, absent vs. empty.
    expect(extractGroups({ groups: ['a', ' b '] }, 'groups')).toEqual(['a', 'b']);
    expect(extractGroups({ groups: 'a, b c' }, 'groups')).toEqual(['a', 'b', 'c']);
    expect(extractGroups({ groups: [] }, 'groups')).toEqual([]);
    expect(extractGroups({}, 'groups')).toBeNull();
    // admin_groups promote on login (never demote).
    const cfg = ctx.cfg;
    cfg.auth.oidc.admin_groups = ['okta:admins'];
    const u = await ctx.auth.upsertOidcUser({ email: 'sso@test.local', externalId: 'sub-1', groups: ['okta:admins'] });
    expect(u.role).toBe('ADMIN');
    const again = await ctx.auth.upsertOidcUser({ email: 'sso@test.local', externalId: 'sub-1', groups: [] });
    expect(again.role).toBe('ADMIN');
    cfg.auth.oidc.admin_groups = [];
  });
});

describe('transfer and cleanup', () => {
  it('transfers ownership, keeps the previous owner as a co-owner and rebuilds the engine', async () => {
    const w = await ctx.workspaces.create(alice, { name: 'Handover' });
    await ctx.queries.run(alice, w.id, 'CREATE TABLE scratch AS SELECT 1 AS x');
    await expect(ctx.workspaces.transfer(alice, w.id, roU.id)).rejects.toThrow(/read-only user cannot own/);
    const after = await ctx.workspaces.transfer(alice, w.id, bobU.id);
    expect(after.owner.email).toBe('bob@test.local');
    expect(after.role).toBe('OWNER'); // alice keeps OWNER via a grant
    expect((await ctx.workspaces.get(bob, w.id)).role).toBe('OWNER');
    expect(ctx.engines.peek(w.id)).toBeUndefined(); // secrets/catalogs come from the owner → engine evicted
    expect((await ctx.workspaces.list(alice)).find((x) => x.id === w.id)).toMatchObject({ shared: true, role: 'OWNER' });
  });

  it('deleting a user purges their grants', async () => {
    const tmp = await ctx.auth.createLocalUser({ email: 'tmp@test.local', password: 'temporary-pw1', role: 'USER' });
    await ctx.workspaces.setMember(alice, wsId, { subject_type: 'user', subject_id: tmp.id, role: 'VIEWER' });
    const r = await api('DELETE', `/api/admin/users/${tmp.id}`, undefined, tokens.admin);
    expect(r.status).toBe(200);
    expect((await ctx.workspaces.listMembers(alice, wsId)).some((m) => m.subject_id === tmp.id)).toBe(false);
    const raw = await ctx.store.db.select().from(ctx.store.schema.workspaceMembers);
    expect(raw.some((m) => m.subject_id === tmp.id)).toBe(false);
  });
});

describe('HTTP API', () => {
  it('exposes listing metadata, members, directory and teams', async () => {
    const list = await api('GET', '/api/workspaces', undefined, tokens.bob);
    const shared = (list.json.workspaces as { id: string; role: string; shared: boolean; owner: { email: string } }[]).find((w) => w.id === wsId)!;
    expect(shared).toMatchObject({ role: 'VIEWER', shared: true, owner: { email: 'alice@test.local' } });
    const one = await api('GET', `/api/workspaces/${wsId}`, undefined, tokens.bob);
    expect(one.json.workspace).toMatchObject({ role: 'VIEWER', member_count: 1 });
    const members = await api('GET', `/api/workspaces/${wsId}/members`, undefined, tokens.bob);
    expect((members.json.members as unknown[]).length).toBe(1);
    const dirRes = await api('GET', '/api/users/directory?q=car', undefined, tokens.bob);
    expect((dirRes.json.users as { email: string }[]).map((u) => u.email)).toEqual(['carol@test.local']);
    const groups = await api('GET', '/api/groups', undefined, tokens.carol);
    expect((groups.json.groups as { name: string }[]).some((g) => g.name === 'Analysts')).toBe(true);
    // Read-only users get no auto-created scratchpad but can still use what is shared with them (own tabs included).
    const roList = await api('GET', '/api/workspaces', undefined, tokens.ro);
    expect(roList.json.workspaces).toEqual([]);
    await ctx.workspaces.setMember(alice, wsId, { subject_type: 'user', subject_id: roU.id, role: 'VIEWER' });
    const tab = await api('POST', `/api/workspaces/${wsId}/tabs`, { title: 'ro tab' }, tokens.ro);
    expect(tab.status).toBe(200);
  });

  it('enforces roles over HTTP with the right status codes', async () => {
    expect((await api('PUT', `/api/workspaces/${wsId}/members`, { subject_type: 'user', subject_id: carolU.id, role: 'EDITOR' }, tokens.bob)).status).toBe(403);
    expect((await api('PATCH', `/api/workspaces/${wsId}`, { name: 'x' }, tokens.bob)).status).toBe(403);
    expect((await api('POST', `/api/workspaces/${wsId}/restart`, {}, tokens.bob)).status).toBe(403);
    expect((await api('GET', `/api/workspaces/${wsId}`, undefined, tokens.carol)).status).toBe(404);
    const q = await api('POST', `/api/workspaces/${wsId}/query`, { sql: 'DROP TABLE sales' }, tokens.bob);
    expect(q.status).toBe(403);
    expect(q.json.message).toMatch(/view-only/);
    const share = await api('PUT', `/api/workspaces/${wsId}/members`, { subject_type: 'user', subject_id: carolU.id, role: 'EDITOR' }, tokens.alice);
    expect(share.status).toBe(200);
    expect((await api('POST', `/api/workspaces/${wsId}/queries`, { name: 'c', sql_text: 'SELECT 1' }, tokens.carol)).status).toBe(200);
    expect((await api('POST', `/api/workspaces/${wsId}/leave`, {}, tokens.carol)).status).toBe(200);
    expect((await api('GET', `/api/workspaces/${wsId}`, undefined, tokens.carol)).status).toBe(404);
    expect((await api('POST', '/api/groups', { name: 'Nope' }, tokens.alice)).status).toBe(403);
  });

  it('agent tools see shared workspaces and inherit the member role', async () => {
    const { token } = await ctx.auth.createToken(bobU, { name: 'bot', scopes: ['read', 'write', 'mcp'] });
    const p = (await ctx.auth.verifyToken(token))!;
    const env: ToolEnv = { ctx, principal: p, via: 'rest', defaultWorkspaceId: null, agent: null };
    const tools = buildTools(ctx.cfg);
    const listed = await runTool(env, tools.find((t) => t.name === 'list_accessible_data')!, { workspace_id: wsId });
    expect(listed.isError).toBeFalsy();
    expect(listed.content[0]!.text).toContain('sales');
    // Bob is VIEWER here: even after human approval (dry_run=false) the role blocks the mutation.
    const blocked = await runTool(env, tools.find((t) => t.name === 'execute_query')!, { workspace_id: wsId, sql: 'DELETE FROM sales WHERE id = 5', dry_run: false });
    expect(blocked.isError).toBe(true);
    expect(blocked.content[0]!.text).toMatch(/view-only/);
    const widget = await runTool(env, tools.find((t) => t.name === 'create_dashboard_widget')!, { workspace_id: wsId, dashboard_name: 'Agent board', title: 'n', sql: 'SELECT 1 AS n', widget_type: 'KPI' });
    expect(widget.isError).toBe(true);
    expect(widget.content[0]!.text).toMatch(/edit access/);
  });
});
