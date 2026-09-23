/**
 * Signed embeds: keys (owners only, secret shown once); tokens signed as a host application would; per-tenant rows
 * through access policies for embeds ({{embed.tenant}}); what an embed can and cannot load; notebooks run live with
 * the token's params and without their SQL; tampered, expired, over-long, revoked and misdirected tokens; framing.
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
import { signEmbedToken } from '../services/embeds.js';
import type { Principal } from '../services/principal.js';

let dir: string;
let ctx: AppContext;
let app: Awaited<ReturnType<typeof buildApp>>['app'];
let base: string;
let jwt: string;
let viewerJwt: string;
let wsId: string;
let otherWs: string;
let admin: Principal;
let keyId: string;
let secret: string;
let dashId: string;
let widgetId: string;
let nbId: string;

const api = async (method: string, url: string, body?: unknown, auth = `Bearer ${jwt}`, headers: Record<string, string> = {}) => {
  const res = await fetch(base + url, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(auth ? { authorization: auth } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: Record<string, any> = {};
  try {
    json = JSON.parse(text);
  } catch {
    json = { text };
  }
  return { status: res.status, json, headers: res.headers };
};
const now = () => Math.floor(Date.now() / 1000);
const token = (claims: Record<string, unknown>, k = keyId, s = secret) => signEmbedToken(k, s, { exp: now() + 600, iat: now(), ...claims } as never);
const embed = (method: string, url: string, t: string) => api(method, url, method === 'POST' ? {} : undefined, `Embed ${t}`);

beforeAll(async () => {
  initLogger({ level: 'silent', stderr: true, pretty: false });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dv-embeds-'));
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  const cfg = loadConfig({ configPath: null, env: { DUCKVIEW_DATA_DIR: path.join(dir, 'data'), DUCKDB_TEMP_DIRECTORY: path.join(dir, 'spill'), DATABASE_URL: ':memory:', DUCKDB_MEMORY_LIMIT: '512MB', DUCKVIEW_ADMIN_EMAIL: 'admin@test.local', DUCKVIEW_ADMIN_PASSWORD: 'super-secret-pw', DUCKVIEW__duckdb__sync_scheduler_enabled: 'false', DUCKVIEW__notifications__scheduler_enabled: 'false', DUCKVIEW__transform__scheduler_enabled: 'false', DUCKVIEW__apps__enabled: 'false', DUCKVIEW_PUBLIC_URL: 'https://duckview.example.com', LOG_LEVEL: 'silent' } });
  ctx = await createContext(cfg);
  admin = ctx.auth.principalFromUser((await ctx.auth.findByEmail('admin@test.local'))!, 'jwt', '127.0.0.1');
  const viewer = await ctx.auth.createLocalUser({ email: 'viewer@test.local', password: 'viewer-secret-pw', role: 'USER' });
  wsId = (await ctx.workspaces.create(admin, { name: 'Portal', active_db_path: 'portal.duckdb' })).id;
  otherWs = (await ctx.workspaces.create(admin, { name: 'Other', active_db_path: 'other.duckdb' })).id;
  await ctx.workspaces.setMember(admin, wsId, { subject_type: 'user', subject_id: viewer.id, role: 'VIEWER' });
  await ctx.queries.run(admin, wsId, "CREATE TABLE orders AS SELECT * FROM (VALUES (1, 'acme', 'EU', 100.0), (2, 'acme', 'US', 50.0), (3, 'globex', 'EU', 70.0), (4, 'globex', 'US', 30.0)) t(id, tenant, region, amount)", { cache: false });
  // Each customer sees their own orders only.
  await ctx.policies.create(admin, wsId, { name: 'Embeds: own tenant', table_name: 'orders', row_filter: 'tenant = {{embed.tenant}}', applies_to: { embeds: true } });
  dashId = (await ctx.dashboards.create(admin, wsId, { name: 'Customer portal' })).id;
  widgetId = (await ctx.dashboards.addWidget(admin, dashId, { title: 'Revenue', widget_type: 'KPI', custom_sql: 'SELECT sum(amount) AS revenue FROM orders' })).widget.id;
  nbId = (await ctx.notebooks.create(admin, wsId, { title: 'Region report', cells: [{ id: 'm', type: 'markdown', source: '# Your orders' }, { id: 'r', type: 'input', name: 'region', input: { kind: 'text', value: 'EU' } }, { id: 'q', type: 'sql', name: 'orders_in_region', source: 'SELECT id, amount FROM orders WHERE region = {{ region }} ORDER BY id' }, { id: 'w', type: 'sql', name: 'wipe', source: 'DELETE FROM orders' }] })).id;
  ({ app } = await buildApp(ctx));
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as net.AddressInfo).port}`;
  jwt = (await api('POST', '/api/auth/login', { email: 'admin@test.local', password: 'super-secret-pw' }, '')).json.token;
  viewerJwt = (await api('POST', '/api/auth/login', { email: 'viewer@test.local', password: 'viewer-secret-pw' }, '')).json.token;
}, 120_000);

afterAll(async () => {
  await app?.close();
  await ctx?.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('signed embeds', () => {
  it('lets owners create keys whose secret is shown once', async () => {
    expect((await api('POST', `/api/workspaces/${wsId}/embed/keys`, { name: 'x' }, `Bearer ${viewerJwt}`)).status).toBe(403);
    expect((await api('POST', `/api/workspaces/${wsId}/embed/keys`, { name: 'x', allowed_origins: ['not an origin'] })).json.message).toMatch(/is not an origin/);
    const r = (await api('POST', `/api/workspaces/${wsId}/embed/keys`, { name: 'Customer portal', allowed_origins: ['https://portal.example.com'] })).json;
    expect(r.secret).toMatch(/^dves_/);
    expect(r.key).toMatchObject({ name: 'Customer portal', allowed_origins: ['https://portal.example.com'] });
    keyId = r.key.id;
    secret = r.secret;
    expect(JSON.stringify((await api('GET', `/api/workspaces/${wsId}/embed/keys`)).json)).not.toContain(secret);
  });

  it('shows each tenant its own rows, and only the one dashboard', async () => {
    const acme = token({ res: `dashboard:${dashId}`, sub: 'jane@acme.test', attrs: { tenant: 'acme' } });
    const view = (await embed('GET', '/api/embed/view', acme)).json;
    expect(view).toMatchObject({ type: 'dashboard', dashboard: { id: dashId, name: 'Customer portal', widgets: [{ id: widgetId, title: 'Revenue', widget_type: 'KPI' }] } });
    expect(JSON.stringify(view)).not.toContain('SELECT');
    expect((await embed('POST', `/api/embed/widgets/${widgetId}/data`, acme)).json.rows).toEqual([[150]]);
    expect((await embed('POST', `/api/embed/widgets/${widgetId}/data`, token({ res: `dashboard:${dashId}`, attrs: { tenant: 'globex' } }))).json.rows).toEqual([[100]]);
    // No tenant signed: the filter matches nothing.
    expect((await embed('POST', `/api/embed/widgets/${widgetId}/data`, token({ res: `dashboard:${dashId}` }))).json.rows).toEqual([[null]]);
    // The policy API takes embeds as a subject too.
    const viaApi = (await api('POST', `/api/workspaces/${wsId}/policies`, { name: 'Embeds: no US', table_name: 'orders', row_filter: "region <> 'US'", applies_to: { embeds: true } })).json.policy;
    expect(viaApi.applies_to).toEqual({ embeds: true });
    expect((await embed('POST', `/api/embed/widgets/${widgetId}/data`, acme)).json.rows).toEqual([[100]]);
    await api('DELETE', `/api/policies/${viaApi.id}`);
    // Members are unaffected by the embed policy.
    expect((await api('POST', `/api/dashboards/${dashId}/widgets/${widgetId}/data`, {}, `Bearer ${viewerJwt}`)).json.rows).toEqual([[250]]);
    // A widget of another dashboard is not reachable through this token.
    const other = await ctx.dashboards.create(admin, wsId, { name: 'Internal' });
    const secretWidget = (await ctx.dashboards.addWidget(admin, other.id, { title: 'All', widget_type: 'KPI', custom_sql: 'SELECT count(*) FROM orders' })).widget.id;
    expect((await embed('POST', `/api/embed/widgets/${secretWidget}/data`, acme)).status).toBe(404);
    // The embed is not a session: the rest of the API refuses it.
    expect((await api('GET', `/api/workspaces/${wsId}/notebooks`, undefined, `Embed ${acme}`)).status).toBe(401);
  });

  it('runs a notebook live with the token\'s params, without showing its SQL or letting it write', async () => {
    const t = token({ res: `notebook:${nbId}`, attrs: { tenant: 'globex' }, params: { region: 'US' } });
    const view = (await embed('GET', '/api/embed/view', t)).json;
    expect(view.notebook.cells.map((c: { type: string; source: string }) => [c.type, c.source])).toEqual([['markdown', '# Your orders'], ['input', ''], ['sql', ''], ['sql', '']]);
    expect(view.notebook.cells[1].input.value).toBe('US');
    const out = (await embed('POST', '/api/embed/notebook/cells/q/run', t)).json.output;
    expect(out).toMatchObject({ rows: [[4, 30]], error: null, ran_by: null });
    expect((await embed('POST', '/api/embed/notebook/cells/w/run', t)).json.output.error).toBeTruthy();
    expect((await ctx.queries.run(admin, wsId, 'SELECT count(*) FROM orders', { cache: false })).rows[0]).toEqual([4]);
    // Nothing an embed ran is saved into the notebook.
    expect((await ctx.notebooks.get(admin, nbId)).cells.find((c) => c.id === 'q')!.output ?? null).toBeNull();
  });

  it('refuses tokens that are tampered, expired, too long-lived, revoked or aimed elsewhere', async () => {
    const good = token({ res: `dashboard:${dashId}`, attrs: { tenant: 'acme' } });
    const [h, b] = good.split('.');
    const forgedBody = Buffer.from(JSON.stringify({ res: `dashboard:${dashId}`, exp: now() + 600, attrs: { tenant: 'globex' } })).toString('base64url');
    expect((await embed('GET', '/api/embed/view', `${h}.${forgedBody}.${good.split('.')[2]}`)).json.message).toMatch(/signature does not match/);
    expect((await embed('GET', '/api/embed/view', token({ res: `dashboard:${dashId}` }, keyId, 'wrong-secret'))).status).toBe(401);
    expect((await embed('GET', '/api/embed/view', token({ res: `dashboard:${dashId}`, exp: now() - 5 }))).json.message).toMatch(/expired/);
    expect((await embed('GET', '/api/embed/view', token({ res: `dashboard:${dashId}`, exp: now() + 8 * 86400 }))).json.message).toMatch(/at most 7 days/);
    expect((await embed('GET', '/api/embed/view', token({ res: 'workspace:everything' }))).json.message).toMatch(/names no dashboard or notebook/);
    expect((await embed('GET', '/api/embed/view', `${h}.${b}`)).status).toBe(401);
    expect((await api('GET', '/api/embed/view', undefined, '')).json.message).toMatch(/no token/);
    // An object of another workspace is not this key's to show.
    const foreign = (await ctx.dashboards.create(admin, otherWs, { name: 'Elsewhere' })).id;
    expect((await embed('GET', '/api/embed/view', token({ res: `dashboard:${foreign}` }))).status).toBe(404);
    const mosaic = (await ctx.dashboards.create(admin, wsId, { name: 'Mosaic', kind: 'mosaic' })).id;
    expect((await embed('GET', '/api/embed/view', token({ res: `dashboard:${mosaic}` }))).json.message).toMatch(/Mosaic dashboards cannot be embedded yet/);
    // Signed by DuckView for owners.
    const signed = (await api('POST', `/api/workspaces/${wsId}/embed/sign`, { key_id: keyId, resource_type: 'dashboard', resource_id: dashId, attrs: { tenant: 'acme' }, expires_in: 900 })).json;
    expect(signed.url).toMatch(/^https:\/\/duckview\.example\.com\/embed\/view\?token=/);
    expect((await embed('POST', `/api/embed/widgets/${widgetId}/data`, signed.token)).json.rows).toEqual([[150]]);
    // Framing: the key's origins for a valid token; never otherwise.
    const page = await api('GET', `/embed/view?token=${good}`, undefined, '', { accept: 'text/html' });
    expect(page.headers.get('content-security-policy')).toBe('frame-ancestors https://portal.example.com');
    expect(page.headers.get('x-frame-options')).toBeNull();
    expect((await api('GET', '/embed/view?token=nope', undefined, '', { accept: 'text/html' })).headers.get('x-frame-options')).toBe('DENY');
    // Revoked: every token of the key stops working at once.
    await api('DELETE', `/api/embed/keys/${keyId}`);
    expect((await embed('GET', '/api/embed/view', good)).json.message).toMatch(/unknown or revoked/);
  });
});
