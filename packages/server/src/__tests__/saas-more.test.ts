/**
 * The GitHub, Jira, Zendesk, Shopify, Intercom, Linear, Pipedrive and Mailchimp connectors against a mock of each
 * API (the service rewrites https://<host>/<path> to the mock): authentication, browsing, every page of a resource
 * synced into a table, and the per-vendor shaping (Jira field names, Pipedrive custom fields, GitHub's pull
 * requests left out of issues, Linear's nested objects).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../config/index.js';
import { initLogger } from '../observability/logger.js';
import { createContext, type AppContext } from '../context.js';
import { buildApp } from '../app.js';
import { nextLink, adfText } from '../services/connectors/saas-more.js';
import type { Principal } from '../services/principal.js';

let dir: string;
let ctx: AppContext;
let app: Awaited<ReturnType<typeof buildApp>>['app'];
let base: string;
let admin: Principal;
let jwt: string;
let wsId: string;
let mock: { url: string; close: () => void };

const api = async (method: string, url: string, body?: unknown) => {
  const res = await fetch(base + url, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), authorization: `Bearer ${jwt}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
};
const sql = async (q: string) => (await ctx.queries.run(admin, wsId, q, { cache: false, countTotal: false })).rows;
const b64 = (s: string) => `Basic ${Buffer.from(s).toString('base64')}`;
type Out = { status?: number; json?: unknown; headers?: Record<string, string> };

function vendor(req: http.IncomingMessage, body: string): Out {
  const u = new URL(req.url!, 'http://mock');
  const [, host, ...rest] = u.pathname.split('/');
  const p = '/' + rest.join('/');
  const q = u.searchParams;
  const h = req.headers;
  const deny = { status: 401, json: { message: 'Bad credentials' } };
  switch (host) {
    case 'api.github.com': {
      if (h.authorization !== 'Bearer ghp_ok') return deny;
      if (p === '/user') return { json: { login: 'octo' } };
      if (p === '/user/repos') return { json: [{ full_name: 'acme/app', private: true, description: 'The app' }] };
      if (p === '/repos/acme/app/issues') {
        if (q.get('page') === '2') return { json: [{ number: 3, title: 'Third', state: 'open', user: { login: 'bo' }, labels: [], assignees: [], url: 'x', html_url: 'https://github.com/acme/app/issues/3' }] };
        return {
          json: [
            { number: 1, title: 'First', state: 'closed', user: { login: 'ann', avatar_url: 'x' }, labels: [{ name: 'bug' }], assignees: [{ login: 'ann' }], url: 'x', html_url: 'https://github.com/acme/app/issues/1' },
            { number: 2, title: 'A PR', state: 'open', user: { login: 'ann' }, labels: [], assignees: [], pull_request: { url: 'x' } },
          ],
          headers: { link: '<https://api.github.com/repos/acme/app/issues?per_page=100&state=all&page=2>; rel="next", <https://api.github.com/repos/acme/app/issues?page=2>; rel="last"' },
        };
      }
      return { status: 404, json: {} };
    }
    case 'acme.atlassian.net': {
      if (h.authorization !== b64('me@acme.com:jira_tok')) return deny;
      if (p === '/rest/api/3/myself') return { json: { displayName: 'Me' } };
      if (p === '/rest/api/3/project/search') return { json: { values: [{ key: 'APP', name: 'App' }], isLast: true } };
      if (p === '/rest/api/3/field') return { json: [{ id: 'summary', name: 'Summary' }, { id: 'status', name: 'Status' }, { id: 'assignee', name: 'Assignee' }, { id: 'description', name: 'Description' }, { id: 'customfield_10016', name: 'Story Points' }, { id: 'labels', name: 'Labels' }] };
      if (p === '/rest/api/3/search/jql') {
        const b = JSON.parse(body) as { jql: string; nextPageToken?: string };
        if (b.jql !== 'project = "APP" ORDER BY created ASC') return { status: 400, json: { errorMessages: [`bad jql ${b.jql}`] } };
        const issue = (n: number, extra: object) => ({ id: String(1000 + n), key: `APP-${n}`, fields: { summary: `Issue ${n}`, status: { name: n === 1 ? 'Done' : 'To Do', id: '3' }, assignee: n === 1 ? { displayName: 'Ann', accountId: 'a1' } : null, labels: ['x'], ...extra } });
        if (!b.nextPageToken) return { json: { issues: [issue(1, { customfield_10016: 5, description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello ' }, { type: 'text', text: 'world' }] }] } })], nextPageToken: 'p2', isLast: false } };
        return { json: { issues: [issue(2, { customfield_10016: 3 })], isLast: true } };
      }
      return { status: 404, json: {} };
    }
    case 'acme.zendesk.com': {
      if (h.authorization !== b64('agent@acme.com/token:zd_tok')) return deny;
      if (p === '/api/v2/users/me.json') return { json: { user: { name: 'Agent', role: 'admin' } } };
      if (p === '/api/v2/tickets.json') {
        if (q.get('page[after]') === 'c2') return { json: { tickets: [{ id: 3, subject: 'C', status: 'solved', via: { channel: 'web' } }], meta: { has_more: false }, links: { next: null } } };
        return { json: { tickets: [{ id: 1, subject: 'A', status: 'open', via: { channel: 'email' } }, { id: 2, subject: 'B', status: 'pending', via: { channel: 'web' } }], meta: { has_more: true }, links: { next: 'https://acme.zendesk.com/api/v2/tickets.json?page[size]=100&page[after]=c2' } } };
      }
      return { status: 404, json: {} };
    }
    case 'acme.myshopify.com': {
      if (h['x-shopify-access-token'] !== 'shpat_ok') return deny;
      if (p === '/admin/api/2025-01/shop.json') return { json: { shop: { name: 'Acme Store', currency: 'EUR' } } };
      if (p === '/admin/api/2025-01/orders.json') {
        if (q.get('status') !== 'any') return { status: 400, json: {} };
        if (q.get('page_info') === 'n2') return { json: { orders: [{ id: 12, total_price: '5.00', customer: { email: 'c@x' }, line_items: [] }] } };
        return { json: { orders: [{ id: 11, total_price: '20.50', customer: { email: 'b@x' }, line_items: [{ sku: 'A' }] }] }, headers: { link: '<https://acme.myshopify.com/admin/api/2025-01/orders.json?limit=250&page_info=n2&status=any>; rel="next"' } };
      }
      return { status: 404, json: {} };
    }
    case 'api.eu.intercom.io': {
      if (h.authorization !== 'Bearer ic_tok') return deny;
      if (p === '/me') return { json: { name: 'Bot', app: { name: 'Acme EU' } } };
      if (p === '/contacts') {
        if (q.get('starting_after') === 'k2') return { json: { data: [{ id: 'c3', email: 'c@x', role: 'lead', location: { country: 'PT', type: 'location' } }], pages: {} } };
        return { json: { data: [{ id: 'c1', email: 'a@x', role: 'user', location: { country: 'FR', type: 'location' } }, { id: 'c2', email: 'b@x', role: 'user', location: { country: 'DE', type: 'location' } }], pages: { next: { starting_after: 'k2' } } } };
      }
      return { status: 404, json: {} };
    }
    case 'api.linear.app': {
      if (h.authorization !== 'lin_api_ok') return deny;
      const { query, variables } = JSON.parse(body) as { query: string; variables: { after?: string | null } };
      if (query.includes('viewer')) return { json: { data: { viewer: { name: 'Lin' }, organization: { name: 'Acme' } } } };
      const node = (n: number) => ({ id: `i${n}`, identifier: `ENG-${n}`, title: `T${n}`, priority: n, state: { name: 'Todo', type: 'unstarted' }, assignee: n === 1 ? { name: 'Ann' } : null, team: { key: 'ENG' }, labels: { nodes: [{ name: 'bug' }] } });
      if (!variables.after) return { json: { data: { issues: { nodes: [node(1)], pageInfo: { hasNextPage: true, endCursor: 'cur1' } } } } };
      return { json: { data: { issues: { nodes: [node(2)], pageInfo: { hasNextPage: false, endCursor: null } } } } };
    }
    case 'acme.pipedrive.com': {
      if (h['x-api-token'] !== 'pd_tok') return deny;
      if (p === '/api/v1/users/me') return { json: { data: { name: 'Pip', company_name: 'Acme' } } };
      if (p === '/api/v1/dealFields') return { json: { data: [{ key: 'title', name: 'Title' }, { key: 'a'.repeat(40), name: 'Region' }] } };
      if (p === '/api/v1/deals') {
        if (q.get('start') === '0') return { json: { data: [{ id: 1, title: 'Big', value: 1000, user_id: { id: 7, name: 'Pip' }, ['a'.repeat(40)]: 'EMEA' }], additional_data: { pagination: { more_items_in_collection: true, next_start: 1 } } } };
        return { json: { data: [{ id: 2, title: 'Small', value: 10, user_id: { id: 7, name: 'Pip' }, ['a'.repeat(40)]: 'APAC' }], additional_data: { pagination: { more_items_in_collection: false } } } };
      }
      return { status: 404, json: {} };
    }
    case 'us21.api.mailchimp.com': {
      if (h.authorization !== b64('duckview:mc_key-us21')) return deny;
      if (p === '/3.0/') return { json: { account_name: 'Acme' } };
      if (p === '/3.0/lists') return { json: { lists: [{ id: 'L1', name: 'Newsletter', stats: { member_count: 3 } }] } };
      if (p === '/3.0/lists/L1/members') {
        const off = Number(q.get('offset'));
        const all = [{ id: 'm1', email_address: 'a@x', status: 'subscribed', merge_fields: { FNAME: 'Ann' }, _links: [] }, { id: 'm2', email_address: 'b@x', status: 'unsubscribed', merge_fields: { FNAME: 'Bo' }, _links: [] }, { id: 'm3', email_address: 'c@x', status: 'subscribed', merge_fields: { FNAME: 'Cy' }, _links: [] }];
        return { json: { members: off === 0 ? all.slice(0, 2) : all.slice(2), total_items: 3 } };
      }
      return { status: 404, json: {} };
    }
    default:
      return { status: 404, json: { error: `unknown host ${host}` } };
  }
}

beforeAll(async () => {
  initLogger({ level: 'silent', stderr: true, pretty: false });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dv-saas-more-'));
  mock = await new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const out = vendor(req, body);
        res.writeHead(out.status ?? 200, { 'content-type': 'application/json', ...(out.headers ?? {}) });
        res.end(JSON.stringify(out.json ?? {}));
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(srv.address() as { port: number }).port}`, close: () => srv.close() }));
  });
  const cfg = loadConfig({ configPath: null, env: { DUCKVIEW_DATA_DIR: path.join(dir, 'data'), DUCKVIEW_FILESYSTEM_MODE: 'full', DUCKDB_TEMP_DIRECTORY: path.join(dir, 'spill'), DATABASE_URL: ':memory:', DUCKDB_MEMORY_LIMIT: '512MB', DUCKVIEW_ADMIN_EMAIL: 'admin@test.local', DUCKVIEW_ADMIN_PASSWORD: 'super-secret-pw', DUCKVIEW__duckdb__sync_scheduler_enabled: 'false', LOG_LEVEL: 'silent' } });
  ctx = await createContext(cfg);
  ctx.connectors.rewriteUrl = (u) => {
    if (u.startsWith(mock.url)) return u;
    const x = new URL(u);
    return `${mock.url}/${x.host}${x.pathname}${x.search}`;
  };
  admin = ctx.auth.principalFromUser((await ctx.auth.findByEmail('admin@test.local'))!, 'jwt', '127.0.0.1');
  wsId = (await ctx.workspaces.create(admin, { name: 'SaaS', active_db_path: 'saas.duckdb' })).id;
  ({ app } = await buildApp(ctx));
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  jwt = ((await (await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@test.local', password: 'super-secret-pw' }) })).json()) as { token: string }).token;
});

afterAll(async () => {
  await app?.close();
  await ctx?.shutdown();
  mock?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Connects, tests, optionally browses, and syncs one resource into a table. */
async function connect(connector: string, values: Record<string, unknown>): Promise<{ id: string; message: string }> {
  const r = await api('POST', '/api/connector-connections', { connector, name: `${connector} test`, values });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  const id = (r.json.connection as { id: string }).id;
  const t = await api('POST', `/api/connector-connections/${id}/test`);
  expect(t.json, JSON.stringify(t.json)).toMatchObject({ ok: true });
  return { id, message: String(t.json.message) };
}
async function sync(id: string, resource: Record<string, unknown>, table: string): Promise<void> {
  const s = await api('POST', `/api/workspaces/${wsId}/syncs`, { name: `${table} sync`, source: { kind: 'connector', connection_id: id, resource }, target_table: table });
  expect(s.status, JSON.stringify(s.json)).toBe(200);
  const run = (await api('POST', `/api/syncs/${(s.json.sync as { id: string }).id}/run`)).json.run as { status: string; error: string | null };
  expect(run.error).toBeNull();
  expect(run.status).toBe('ok');
}

describe('helpers', () => {
  it('reads Link headers and Atlassian documents', () => {
    expect(nextLink('<https://x/a?page=2>; rel="next", <https://x/a?page=9>; rel="last"')).toBe('https://x/a?page=2');
    expect(nextLink('<https://x/a?page=1>; rel="prev"')).toBeNull();
    expect(adfText({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'c' }] }] })).toBe('ab\nc');
  });
});

describe('connectors', () => {
  it('lists the new sources in the catalog', async () => {
    const cat = (await api('GET', '/api/sources/catalog')).json as { sources?: { id: string; status: string }[] };
    const ids = (cat.sources ?? []).map((s) => s.id);
    expect(ids).toEqual(expect.arrayContaining(['github', 'jira', 'zendesk', 'shopify', 'intercom', 'linear', 'pipedrive', 'mailchimp']));
  });

  it('GitHub: repositories, issues without pull requests, every page', async () => {
    expect((await api('POST', '/api/connector-connections', { connector: 'github', name: 'bad', values: { token: 'nope' } })).status).toBe(200);
    const { id, message } = await connect('github', { token: 'ghp_ok' });
    expect(message).toMatch(/^Connected\ as\ octo · \d+ ms$/);
    const repos = (await api('GET', `/api/connector-connections/${id}/browse`)).json.entries as { name: string; path: string[] }[];
    expect(repos[0]).toMatchObject({ name: 'acme/app', path: ['acme/app'] });
    await sync(id, { repo: 'acme/app', resource: 'issues' }, 'gh_issues');
    expect(await sql('SELECT number, title, "user.login", labels, html_url FROM gh_issues ORDER BY number')).toEqual([[1, 'First', 'ann', ['bug'], 'https://github.com/acme/app/issues/1'], [3, 'Third', 'bo', [], 'https://github.com/acme/app/issues/3']]);
    expect((await sql("SELECT count(*) FROM information_schema.columns WHERE table_name = 'gh_issues' AND column_name IN ('url', 'user.avatar_url')"))[0]![0]).toBe(0);
  });

  it('Jira: issues with fields named as in Jira', async () => {
    const { id, message } = await connect('jira', { site_url: 'https://acme.atlassian.net', email: 'me@acme.com', api_token: 'jira_tok' });
    expect(message).toMatch(/^Connected\ as\ Me · \d+ ms$/);
    await sync(id, { project: 'APP' }, 'jira_issues');
    expect(await sql('SELECT key, "Summary", "Status", "Assignee", "Story Points", "Description", "Labels" FROM jira_issues ORDER BY key')).toEqual([['APP-1', 'Issue 1', 'Done', 'Ann', 5, 'Hello world', ['x']], ['APP-2', 'Issue 2', 'To Do', null, 3, null, ['x']]]);
  });

  it('Zendesk: tickets through cursor pages', async () => {
    const { id } = await connect('zendesk', { subdomain: 'acme', email: 'agent@acme.com', api_token: 'zd_tok' });
    await sync(id, { resource: 'tickets' }, 'zd_tickets');
    expect(await sql('SELECT id, subject, status, "via.channel" FROM zd_tickets ORDER BY id')).toEqual([[1, 'A', 'open', 'email'], [2, 'B', 'pending', 'web'], [3, 'C', 'solved', 'web']]);
  });

  it('Shopify: orders of every status, Link-header pages', async () => {
    const { id, message } = await connect('shopify', { shop: 'acme.myshopify.com', access_token: 'shpat_ok' });
    expect(message).toMatch(/^Connected\ ·\ Acme\ Store\ \(EUR\) · \d+ ms$/);
    await sync(id, { resource: 'orders' }, 'shop_orders');
    expect(await sql('SELECT id, total_price, "customer.email" FROM shop_orders ORDER BY id')).toEqual([[11, '20.50', 'b@x'], [12, '5.00', 'c@x']]);
  });

  it('Intercom: an EU workspace, contacts after a cursor', async () => {
    const { id, message } = await connect('intercom', { access_token: 'ic_tok', region: 'eu' });
    expect(message).toMatch(/^Connected\ ·\ Acme\ EU · \d+ ms$/);
    await sync(id, { resource: 'contacts' }, 'ic_contacts');
    expect(await sql('SELECT id, email, "location.country" FROM ic_contacts ORDER BY id')).toEqual([['c1', 'a@x', 'FR'], ['c2', 'b@x', 'DE'], ['c3', 'c@x', 'PT']]);
    expect((await sql("SELECT count(*) FROM information_schema.columns WHERE table_name = 'ic_contacts' AND column_name = 'location.type'"))[0]![0]).toBe(0);
  });

  it('Linear: issues over GraphQL with nested objects flattened', async () => {
    const { id, message } = await connect('linear', { api_key: 'lin_api_ok' });
    expect(message).toMatch(/^Connected\ as\ Lin\ ·\ Acme · \d+ ms$/);
    await sync(id, { resource: 'issues' }, 'lin_issues');
    expect(await sql('SELECT identifier, "state.name", "assignee.name", "team.key", labels FROM lin_issues ORDER BY identifier')).toEqual([['ENG-1', 'Todo', 'Ann', 'ENG', ['bug']], ['ENG-2', 'Todo', null, 'ENG', ['bug']]]);
  });

  it('Pipedrive: deals with custom fields by name', async () => {
    const { id } = await connect('pipedrive', { company_domain: 'acme', api_token: 'pd_tok' });
    await sync(id, { resource: 'deals' }, 'pd_deals');
    expect(await sql('SELECT id, title, value, user_id, "Region" FROM pd_deals ORDER BY id')).toEqual([[1, 'Big', 1000, 'Pip', 'EMEA'], [2, 'Small', 10, 'Pip', 'APAC']]);
  });

  it('Mailchimp: audience members, offset pages, the host from the key', async () => {
    const { id, message } = await connect('mailchimp', { api_key: 'mc_key-us21' });
    expect(message).toMatch(/^Connected\ ·\ Acme · \d+ ms$/);
    const entries = (await api('GET', `/api/connector-connections/${id}/browse`)).json.entries as { name: string; resource: Record<string, unknown> }[];
    expect(entries[0]).toMatchObject({ name: 'Newsletter · members', resource: { resource: 'members', list_id: 'L1' } });
    await sync(id, entries[0]!.resource, 'mc_members');
    expect(await sql('SELECT email_address, status, "merge_fields.FNAME" FROM mc_members ORDER BY email_address')).toEqual([['a@x', 'subscribed', 'Ann'], ['b@x', 'unsubscribed', 'Bo'], ['c@x', 'subscribed', 'Cy']]);
    const bad = await api('POST', '/api/connector-connections', { connector: 'mailchimp', name: 'no dc', values: { api_key: 'nodc' } });
    const t = await api('POST', `/api/connector-connections/${(bad.json.connection as { id: string }).id}/test`);
    expect(JSON.stringify(t.json)).toMatch(/data center/);
  });
});
