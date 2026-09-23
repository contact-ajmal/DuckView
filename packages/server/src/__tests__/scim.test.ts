/**
 * SCIM 2.0 provisioning: the token, Users (Okta- and Entra-style requests, filters, deactivation cutting off
 * sessions and API tokens), Groups adopting a team an admin pre-linked to the IdP group — so workspace grants made
 * before anyone signed in take effect — and deprovisioning.
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
import type { Principal } from '../services/principal.js';

let dir: string;
let ctx: AppContext;
let app: Awaited<ReturnType<typeof buildApp>>['app'];
let base: string;
let jwt: string;
let scimToken: string;
let wsId: string;
let admin: Principal;

const api = async (method: string, url: string, body?: unknown, token = jwt, type = 'application/json') => {
  const res = await fetch(base + url, { method, headers: { ...(body !== undefined ? { 'content-type': type } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, type: res.headers.get('content-type') ?? '', json: (text ? JSON.parse(text) : {}) as Record<string, any> };
};
const scim = (method: string, url: string, body?: unknown) => api(method, `/scim/v2${url}`, body, scimToken, 'application/scim+json');
const PATCH_OP = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';

beforeAll(async () => {
  initLogger({ level: 'silent', stderr: true, pretty: false });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dv-scim-'));
  const cfg = loadConfig({ configPath: null, env: { DUCKVIEW_DATA_DIR: path.join(dir, 'data'), DUCKDB_TEMP_DIRECTORY: path.join(dir, 'spill'), DATABASE_URL: ':memory:', DUCKDB_MEMORY_LIMIT: '512MB', DUCKVIEW_ADMIN_EMAIL: 'admin@test.local', DUCKVIEW_ADMIN_PASSWORD: 'super-secret-pw', DUCKVIEW__duckdb__sync_scheduler_enabled: 'false', DUCKVIEW__notifications__scheduler_enabled: 'false', DUCKVIEW__apps__enabled: 'false', DUCKVIEW__auth__oidc__admin_groups: '["platform-admins"]', LOG_LEVEL: 'silent' } });
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  ctx = await createContext(cfg);
  admin = ctx.auth.principalFromUser((await ctx.auth.findByEmail('admin@test.local'))!, 'jwt', '127.0.0.1');
  wsId = (await ctx.workspaces.create(admin, { name: 'Finance', active_db_path: 'finance.duckdb' })).id;
  ({ app } = await buildApp(ctx));
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as net.AddressInfo).port}`;
  jwt = (await api('POST', '/api/auth/login', { email: 'admin@test.local', password: 'super-secret-pw' }, '')).json.token;
});

afterAll(async () => {
  await app.close();
  await ctx.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('SCIM provisioning', () => {
  it('needs the token an admin generates', async () => {
    expect((await api('GET', '/scim/v2/Users', undefined, 'nope')).json).toMatchObject({ schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'], status: '401' });
    expect((await api('GET', '/scim/v2/Users', undefined, jwt)).status).toBe(401); // a session is not a SCIM credential
    expect((await api('GET', '/api/admin/scim')).json).toMatchObject({ enabled: true, source: null, endpoint: `${base}/scim/v2` });
    const minted = (await api('POST', '/api/admin/scim/token')).json;
    scimToken = minted.token;
    expect(scimToken).toMatch(/^dvscim_/);
    expect(minted).toMatchObject({ source: 'console', prefix: scimToken.slice(0, 11) });
    const spc = await scim('GET', '/ServiceProviderConfig');
    expect(spc.type).toMatch(/application\/scim\+json/);
    expect(spc.json).toMatchObject({ patch: { supported: true }, filter: { supported: true } });
    expect((await scim('GET', '/ResourceTypes')).json.Resources.map((r: { id: string }) => r.id)).toEqual(['User', 'Group']);
  });

  it('provisions, updates and deactivates users', async () => {
    // Okta-style create.
    const created = await scim('POST', '/Users', { schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], userName: 'Ada@Example.com', name: { givenName: 'Ada', familyName: 'Lovelace' }, emails: [{ primary: true, value: 'ada@example.com', type: 'work' }], externalId: '00u1', active: true });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ userName: 'ada@example.com', displayName: 'Ada Lovelace', externalId: '00u1', active: true, meta: { resourceType: 'User', location: `${base}/scim/v2/Users/${created.json.id}` } });
    const adaId = created.json.id as string;
    expect(await ctx.auth.findById(adaId)).toMatchObject({ auth_provider: 'oidc', password_hash: null, role: 'USER' });
    // A second create for the same person is a uniqueness conflict.
    expect((await scim('POST', '/Users', { userName: 'ada@example.com' })).json).toMatchObject({ status: '409', scimType: 'uniqueness' });
    // Filters the IdPs use to find a user before creating one.
    const found = (await scim('GET', '/Users?filter=' + encodeURIComponent('userName eq "ADA@example.com"'))).json;
    expect(found).toMatchObject({ totalResults: 1, Resources: [{ id: adaId }] });
    expect((await scim('GET', '/Users?filter=' + encodeURIComponent('externalId eq "00u1"'))).json.totalResults).toBe(1);
    expect((await scim('GET', '/Users?filter=' + encodeURIComponent('title sw "x"'))).json).toMatchObject({ status: '400', scimType: 'invalidFilter' });
    expect((await scim('GET', '/Users?startIndex=2&count=1')).json).toMatchObject({ totalResults: 2, startIndex: 2, itemsPerPage: 1 });
    // Entra-style PATCH: capitalised ops, flattened paths.
    const patched = await scim('PATCH', `/Users/${adaId}`, { schemas: [PATCH_OP], Operations: [{ op: 'Replace', path: 'displayName', value: 'Ada L.' }, { op: 'Add', value: { 'name.givenName': 'Augusta' } }] });
    expect(patched.json.displayName).toBe('Ada L.');

    // Deactivation cuts off a local user's sign-in, session and API token at once.
    const bob = await ctx.auth.createLocalUser({ email: 'bob@test.local', password: 'bob-secret-pw', role: 'USER' });
    const bobJwt = (await api('POST', '/api/auth/login', { email: 'bob@test.local', password: 'bob-secret-pw' }, '')).json.token as string;
    const bobToken = (await api('POST', '/api/tokens', { name: 'ci', scopes: ['read'] }, bobJwt)).json.token as string;
    expect((await api('GET', '/api/auth/me', undefined, bobJwt)).status).toBe(200);
    expect((await api('GET', '/api/workspaces', undefined, bobToken)).status).toBe(200);
    const off = await scim('PATCH', `/Users/${bob.id}`, { schemas: [PATCH_OP], Operations: [{ op: 'Replace', path: 'active', value: 'False' }] });
    expect(off.json.active).toBe(false);
    expect((await api('GET', '/api/auth/me', undefined, bobJwt)).status).toBe(401);
    expect((await api('GET', '/api/workspaces', undefined, bobToken)).status).toBe(401);
    expect((await api('POST', '/api/auth/login', { email: 'bob@test.local', password: 'bob-secret-pw' }, '')).status).toBe(403);
    // Okta reactivates with a PUT of the whole resource.
    const on = await scim('PUT', `/Users/${bob.id}`, { userName: 'bob@test.local', active: true, name: { givenName: 'Bob', familyName: 'B' } });
    expect(on.json).toMatchObject({ active: true, displayName: 'Bob B' });
    expect((await api('GET', '/api/auth/me', undefined, bobJwt)).status).toBe(200);

    // The admin console can deactivate too, but not yourself; SCIM cannot deactivate the last active admin.
    expect((await api('PATCH', `/api/admin/users/${admin.userId}`, { disabled: true })).status).toBe(400);
    expect((await api('PATCH', `/api/admin/users/${bob.id}`, { disabled: true })).status).toBe(200);
    expect((await ctx.auth.findById(bob.id))!.disabled).toBe(true);
    await api('PATCH', `/api/admin/users/${bob.id}`, { disabled: false });
    expect((await scim('PATCH', `/Users/${admin.userId}`, { schemas: [PATCH_OP], Operations: [{ op: 'replace', value: { active: false } }] })).json).toMatchObject({ status: '400', detail: expect.stringMatching(/last active administrator/) });

    // DELETE deactivates by default (auth.scim.on_delete = deactivate): the user and their history stay.
    expect((await scim('DELETE', `/Users/${bob.id}`)).status).toBe(204);
    expect((await ctx.auth.findById(bob.id))!.disabled).toBe(true);
    // Every SCIM change is audited as the platform.
    await new Promise((r) => setTimeout(r, 50));
    expect(await ctx.audit.list({ action: 'scim.user_delete' })).toMatchObject([{ actor_type: 'SYSTEM', resource: `user:${bob.id}`, query_text: 'deactivate' }]);
  });

  it('adopts a pre-linked team so earlier workspace grants take effect, and syncs membership', async () => {
    // Before anyone from the IdP signs in, an admin links a team to the IdP group and shares the workspace with it.
    const team = (await api('POST', '/api/groups', { name: 'Finance analysts', external_id: 'grp-finance' })).json.group;
    expect(team.external_id).toBe('grp-finance');
    expect((await api('POST', '/api/groups', { name: 'Other', external_id: 'grp-finance' })).status).toBe(409);
    await ctx.workspaces.setMember(admin, wsId, { subject_type: 'group', subject_id: team.id, role: 'EDITOR' });
    // A hand-made team with no link is not a SCIM group.
    await api('POST', '/api/groups', { name: 'Hand made' });

    const carol = (await scim('POST', '/Users', { userName: 'carol@example.com', displayName: 'Carol' })).json;
    const dan = (await scim('POST', '/Users', { userName: 'dan@example.com', displayName: 'Dan' })).json;
    const asUser = async (id: string) => ctx.auth.principalFromUser((await ctx.auth.findById(id))!, 'jwt');
    await expect(ctx.workspaces.get(await asUser(carol.id), wsId)).rejects.toThrow();

    // Entra pushes the group with its object id as externalId: DuckView adopts the linked team.
    const g = await scim('POST', '/Groups', { schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'], displayName: 'Finance', externalId: 'grp-finance', members: [{ value: carol.id }] });
    expect(g.status).toBe(201);
    expect(g.json).toMatchObject({ id: team.id, displayName: 'Finance', externalId: 'grp-finance', members: [{ value: carol.id, display: 'carol@example.com' }] });
    expect((await ctx.workspaces.get(await asUser(carol.id), wsId)).role).toBe('EDITOR');

    // Membership changes: add Dan, remove Carol with the filtered path form.
    await scim('PATCH', `/Groups/${team.id}`, { schemas: [PATCH_OP], Operations: [{ op: 'Add', path: 'members', value: [{ value: dan.id }] }] });
    await scim('PATCH', `/Groups/${team.id}`, { schemas: [PATCH_OP], Operations: [{ op: 'Remove', path: `members[value eq "${carol.id}"]` }] });
    const now = (await scim('GET', `/Groups/${team.id}`)).json;
    expect(now.members.map((m: { value: string }) => m.value)).toEqual([dan.id]);
    await expect(ctx.workspaces.get(await asUser(carol.id), wsId)).rejects.toThrow();
    expect((await ctx.workspaces.get(await asUser(dan.id), wsId)).role).toBe('EDITOR');
    // The user resource lists the groups.
    expect((await scim('GET', `/Users/${dan.id}`)).json.groups).toMatchObject([{ value: team.id, display: 'Finance' }]);

    // Lookups: by displayName (Entra), with members excluded, and the membership check filter.
    const list = (await scim('GET', '/Groups?excludedAttributes=members&filter=' + encodeURIComponent('displayName eq "finance"'))).json;
    expect(list).toMatchObject({ totalResults: 1, Resources: [{ id: team.id }] });
    expect(list.Resources[0].members).toBeUndefined();
    expect((await scim('GET', '/Groups?filter=' + encodeURIComponent(`id eq "${team.id}" and members eq "${carol.id}"`))).json.totalResults).toBe(0);
    expect((await scim('GET', '/Groups')).json.Resources.map((r: { displayName: string }) => r.displayName)).toEqual(['Finance']);

    // Okta PUT replaces the members; an admin group promotes its members (one-way, like SSO sign-in).
    const admins = (await scim('POST', '/Groups', { displayName: 'platform-admins', members: [] })).json;
    expect(admins.externalId).toBe('platform-admins');
    await scim('PUT', `/Groups/${admins.id}`, { displayName: 'platform-admins', members: [{ value: carol.id }, { value: 'no-such-user' }] });
    expect((await ctx.auth.findById(carol.id))!.role).toBe('ADMIN');
    expect((await scim('GET', `/Groups/${admins.id}`)).json.members).toHaveLength(1);

    // Deleting the group removes the team and its grants.
    expect((await scim('DELETE', `/Groups/${team.id}`)).status).toBe(204);
    expect(await ctx.groups.byId(team.id)).toBeNull();
    await expect(ctx.workspaces.get(await asUser(dan.id), wsId)).rejects.toThrow();
    expect((await scim('GET', `/Groups/${team.id}`)).json.status).toBe('404');
  });

  it('stops accepting a revoked token', async () => {
    expect((await api('DELETE', '/api/admin/scim/token')).status).toBe(200);
    expect((await scim('GET', '/Users')).status).toBe(401);
  });
});
