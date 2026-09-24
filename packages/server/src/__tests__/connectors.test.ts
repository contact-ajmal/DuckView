/**
 * Connector connections: warehouses (Snowflake, BigQuery, Redshift, ClickHouse), SaaS applications (Salesforce,
 * HubSpot, Stripe, GA4, Airtable, Notion) and Google Drive / Sheets through a Google account — each proved against
 * a mock of the vendor's HTTP API: test, browse, sync into DuckDB with pagination, the OAuth round trip, the
 * administrator-managed Google client, credential secrecy and the agent tools.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { loadConfig } from '../config/index.js';
import { initLogger } from '../observability/logger.js';
import { createContext, type AppContext } from '../context.js';
import { buildApp } from '../app.js';
import { buildTools, runTool, type ToolEnv } from '../agent/tools.js';
import { googleEndpoints } from '../services/connectors/google-auth.js';
import { fabricSql } from '../services/connectors/warehouses.js';
import { notionValue } from '../services/connectors/saas.js';
import { flatten, zipRows, boundFetch } from '../services/connectors/types.js';
import type { Principal } from '../services/principal.js';

let dir: string;
let ctx: AppContext;
let app: Awaited<ReturnType<typeof buildApp>>['app'];
let base: string;
let admin: Principal;
let jwt: string;
let userJwt: string;
let wsId: string;
let mock: { url: string; hits: string[]; close: () => void };

const api = async (method: string, url: string, body?: unknown, token = jwt) => {
  const res = await fetch(base + url, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
};
const readBody = (req: http.IncomingMessage) => new Promise<string>((resolve) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => resolve(b)); });
const sql = async (q: string) => (await ctx.queries.run(admin, wsId, q, { cache: false, countTotal: false })).rows;
const count = async (table: string) => Number((await sql(`SELECT count(*) FROM ${table}`))[0]![0]);

/** The mock speaks for every vendor: the service rewrites https://<host>/<path> to <mock>/<host>/<path>. */
function vendorApi(req: http.IncomingMessage, body: string): { status?: number; json?: unknown; text?: string; headers?: Record<string, string> } {
  const u = new URL(req.url!, 'http://mock');
  const [, host, ...rest] = u.pathname.split('/');
  const p = '/' + rest.join('/');
  const auth = req.headers.authorization ?? '';
  const q = u.searchParams;
  switch (host) {
    // ---- Stripe: bearer secret key, list endpoints with starting_after
    case 'api.stripe.com':
      if (auth !== 'Bearer sk_test_secret123') return { status: 401, json: { error: { message: 'Invalid API Key' } } };
      if (p === '/v1/account') return { json: { id: 'acct_1', settings: { dashboard: { display_name: 'Acme' } } } };
      if (p === '/v1/charges') {
        const after = q.get('starting_after');
        if (!after) return { json: { data: [{ id: 'ch_1', amount: 1000, currency: 'usd', customer: 'cus_1', metadata: { order: '7' } }, { id: 'ch_2', amount: 2500, currency: 'usd', customer: 'cus_2', metadata: {} }], has_more: true } };
        return { json: { data: [{ id: 'ch_3', amount: 300, currency: 'eur', customer: null, metadata: {} }], has_more: false } };
      }
      return { status: 404, json: { error: { message: `no ${p}` } } };
    // ---- HubSpot: private-app token, properties then objects with `after`
    case 'api.hubapi.com':
      if (auth !== 'Bearer pat-na1-hub') return { status: 401, json: { message: 'bad token' } };
      if (p === '/crm/v3/objects/contacts' && q.get('limit') === '1') return { json: { results: [], total: 2 } };
      if (p === '/crm/v3/schemas') return { json: { results: [{ name: 'pets', objectTypeId: '2-123', labels: { plural: 'Pets' } }] } };
      if (p === '/crm/v3/properties/contacts') return { json: { results: [{ name: 'email' }, { name: 'firstname' }, { name: 'lifecyclestage' }] } };
      if (p === '/crm/v3/objects/contacts') {
        expect(q.get('properties')).toBe('email,firstname,lifecyclestage');
        if (!q.get('after')) return { json: { results: [{ id: '1', properties: { email: 'a@x.io', firstname: 'Ann', lifecyclestage: 'lead' }, createdAt: '2026-01-01T00:00:00Z' }], paging: { next: { after: 'p2' } } } };
        return { json: { results: [{ id: '2', properties: { email: 'b@x.io', firstname: 'Bo', lifecyclestage: 'customer' }, createdAt: '2026-01-02T00:00:00Z' }] } };
      }
      return { status: 404, json: {} };
    // ---- Airtable: PAT, meta bases/tables, records with offset
    case 'api.airtable.com':
      if (auth !== 'Bearer pat.air') return { status: 401, json: { error: 'AUTHENTICATION_REQUIRED' } };
      if (p === '/v0/meta/bases') return { json: { bases: [{ id: 'appBase1', name: 'CRM' }] } };
      if (p === '/v0/meta/bases/appBase1/tables') return { json: { tables: [{ id: 'tblLeads', name: 'Leads', fields: [{ name: 'Name' }, { name: 'Score' }] }] } };
      if (p === '/v0/appBase1/tblLeads') {
        if (!q.get('offset')) return { json: { records: [{ id: 'rec1', createdTime: '2026-02-01T00:00:00Z', fields: { Name: 'Lead 1', Score: 10 } }, { id: 'rec2', createdTime: '2026-02-01T00:00:00Z', fields: { Name: 'Lead 2', Score: 20 } }], offset: 'next' } };
        return { json: { records: [{ id: 'rec3', createdTime: '2026-02-02T00:00:00Z', fields: { Name: 'Lead 3', Score: 30 } }] } };
      }
      return { status: 404, json: {} };
    // ---- Notion: integration token, search databases, query with start_cursor
    case 'api.notion.com':
      if (auth !== 'Bearer ntn_secret') return { status: 401, json: { message: 'API token is invalid.' } };
      if (p === '/v1/users/me') return { json: { name: 'DuckView bot' } };
      if (p === '/v1/search') return { json: { results: [{ id: 'db-1', title: [{ plain_text: 'Tasks' }] }] } };
      if (p === '/v1/databases/db-1/query') {
        const cursor = (JSON.parse(body || '{}') as { start_cursor?: string }).start_cursor;
        const page = (id: string, name: string, done: boolean) => ({ id, created_time: '2026-03-01T00:00:00Z', last_edited_time: '2026-03-02T00:00:00Z', url: `https://notion.so/${id}`, properties: { Name: { type: 'title', title: [{ plain_text: name }] }, Done: { type: 'checkbox', checkbox: done }, Owner: { type: 'select', select: { name: 'Ann' } }, Tags: { type: 'multi_select', multi_select: [{ name: 'a' }, { name: 'b' }] }, Due: { type: 'date', date: { start: '2026-03-10' } }, Effort: { type: 'number', number: 3 } } });
        if (!cursor) return { json: { results: [page('pg1', 'Write docs', false)], has_more: true, next_cursor: 'c2' } };
        return { json: { results: [page('pg2', 'Ship', true)], has_more: false, next_cursor: null } };
      }
      return { status: 404, json: {} };
    // ---- Salesforce (the instance URL points at the mock directly)
    case 'sf.local':
      if (p === '/services/oauth2/token') {
        const form = new URLSearchParams(body);
        if (form.get('client_secret') !== 'sf-secret' || form.get('grant_type') !== 'client_credentials') return { status: 400, json: { error: 'invalid_client' } };
        return { json: { access_token: 'sf-access', instance_url: 'https://sf.local' } };
      }
      if (auth !== 'Bearer sf-access') return { status: 401, json: [{ message: 'Session expired' }] };
      if (p === '/services/data/v60.0/') return { json: { identity: 'x' } };
      if (p === '/services/data/v60.0/limits') return { json: { DailyApiRequests: { Max: 15000, Remaining: 14990 } } };
      if (p === '/services/data/v60.0/sobjects') return { json: { sobjects: [{ name: 'Account', label: 'Account', queryable: true, custom: false }, { name: 'Widget__c', label: 'Widget', queryable: true, custom: true }, { name: 'Hidden', label: 'x', queryable: false, custom: false }] } };
      if (p === '/services/data/v60.0/sobjects/Account/describe') return { json: { fields: [{ name: 'Id', type: 'id' }, { name: 'Name', type: 'string' }, { name: 'BillingAddress', type: 'address' }, { name: 'AnnualRevenue', type: 'currency' }] } };
      if (p === '/services/data/v60.0/query') {
        expect(q.get('q')).toBe('SELECT Id, Name, AnnualRevenue FROM Account');
        return { json: { records: [{ attributes: { type: 'Account' }, Id: '001', Name: 'Acme', AnnualRevenue: 1e6 }], done: false, nextRecordsUrl: '/services/data/v60.0/query/01g-2000' } };
      }
      if (p === '/services/data/v60.0/query/01g-2000') return { json: { records: [{ attributes: { type: 'Account' }, Id: '002', Name: 'Globex', AnnualRevenue: null }], done: true } };
      return { status: 404, json: {} };
    // ---- Snowflake SQL API v2
    case 'acme-x1.snowflakecomputing.com': {
      if (auth !== 'Bearer snow-pat') return { status: 401, json: { message: 'Invalid token' } };
      const stmt = (JSON.parse(body || '{}') as { statement?: string }).statement ?? '';
      const result = (cols: string[], rows: unknown[][]) => ({ json: { statementHandle: 'h1', resultSetMetaData: { rowType: cols.map((name) => ({ name })), partitionInfo: [{}] }, data: rows } });
      if (/current_version/i.test(stmt)) return result(['V', 'W'], [['9.1.0', 'COMPUTE_WH']]);
      if (/^SHOW DATABASES/i.test(stmt)) return result(['name'], [['ANALYTICS']]);
      if (/^SHOW SCHEMAS/i.test(stmt)) return result(['name'], [['PUBLIC']]);
      if (/^SHOW TABLES/i.test(stmt)) return result(['name', 'rows'], [['ORDERS', 2]]);
      if (/^SHOW VIEWS/i.test(stmt)) return result(['name'], []);
      if (/FROM "ANALYTICS"."PUBLIC"."ORDERS"/.test(stmt) || /FROM ANALYTICS.PUBLIC.ORDERS/i.test(stmt)) return result(['ORDER_ID', 'TOTAL'], [[1, 10.5], [2, 20]]);
      if (/DROP|DELETE|INSERT/i.test(stmt)) return { status: 422, json: { message: 'should never be sent' } };
      return { status: 400, json: { message: `unexpected statement ${stmt}` } };
    }
    // ---- BigQuery + Google token endpoint (service account JWT bearer) + GA4 + Drive + Sheets + userinfo
    case 'oauth2.googleapis.com': {
      const form = new URLSearchParams(body);
      if (form.get('grant_type') === 'urn:ietf:params:oauth:grant-type:jwt-bearer') return { json: { access_token: 'sa-token', expires_in: 3600 } };
      if (form.get('grant_type') === 'authorization_code') {
        if (form.get('code') !== 'good-code' || form.get('client_secret') !== 'goog-secret') return { status: 400, json: { error: 'invalid_grant' } };
        return { json: { access_token: 'user-token-1', refresh_token: 'refresh-abc', expires_in: 3600, scope: 'openid email' } };
      }
      if (form.get('grant_type') === 'refresh_token') {
        if (form.get('refresh_token') !== 'refresh-abc') return { status: 400, json: { error: 'invalid_grant' } };
        return { json: { access_token: 'user-token-2', expires_in: 3600 } };
      }
      return { status: 400, json: { error: 'unsupported' } };
    }
    case 'www.googleapis.com':
      if (p === '/oauth2/v3/userinfo') return auth === 'Bearer user-token-1' ? { json: { email: 'analyst@example.com' } } : { status: 401, json: {} };
      if (!['Bearer user-token-1', 'Bearer user-token-2', 'Bearer sa-token'].includes(auth)) return { status: 401, json: { error: { message: 'Invalid Credentials' } } };
      if (p === '/drive/v3/about') return { json: { user: { emailAddress: 'analyst@example.com' } } };
      if (p === '/drive/v3/files') {
        const query = q.get('q') ?? '';
        if (query.includes("mimeType = 'application/vnd.google-apps.spreadsheet'")) return { json: { files: [{ id: 'sheet1', name: 'Budget', mimeType: 'application/vnd.google-apps.spreadsheet', modifiedTime: '2026-04-01T00:00:00Z' }] } };
        if (query.includes("'root' in parents")) return { json: { files: [{ id: 'folder1', name: 'Reports', mimeType: 'application/vnd.google-apps.folder' }, { id: 'csv1', name: 'sales.csv', mimeType: 'text/csv', size: '40' }, { id: 'img', name: 'logo.png', mimeType: 'image/png' }] } };
        return { json: { files: [] } };
      }
      if (p === '/drive/v3/files/csv1' && q.get('alt') === 'media') return { text: 'region,amount\nEU,10\nUS,20\n', headers: { 'content-type': 'text/csv' } };
      if (p === '/drive/v3/files/sheet1/export') return { text: 'a,b\n1,2\n', headers: { 'content-type': 'text/csv' } };
      return { status: 404, json: {} };
    case 'sheets.googleapis.com':
      if (auth !== 'Bearer user-token-2' && auth !== 'Bearer user-token-1') return { status: 401, json: {} };
      if (p === '/v4/spreadsheets/sheet1') return { json: { properties: { title: 'Budget' }, sheets: [{ properties: { sheetId: 0, title: 'Q1', gridProperties: { rowCount: 3 } } }, { properties: { sheetId: 1, title: 'Notes' } }] } };
      if (p === "/v4/spreadsheets/sheet1/values/'Q1'") return { json: { values: [['Category', 'Amount', ''], ['Rent', 1200, 'x'], ['Food', 400.5, ''], []] } };
      return { status: 404, json: {} };
    case 'bigquery.googleapis.com':
      if (auth !== 'Bearer sa-token') return { status: 401, json: { error: { message: 'Invalid Credentials' } } };
      if (p === '/bigquery/v2/projects/my-proj/datasets') return { json: { datasets: [{ datasetReference: { datasetId: 'sales' } }] } };
      if (p === '/bigquery/v2/projects/my-proj/datasets/sales/tables') return { json: { tables: [{ tableReference: { tableId: 'orders' }, type: 'TABLE' }, { tableReference: { tableId: 'v_daily' }, type: 'VIEW' }] } };
      if (p === '/bigquery/v2/projects/my-proj/queries' && req.method === 'POST') {
        const query = (JSON.parse(body) as { query: string }).query;
        expect(query).toMatch(/SELECT/);
        return { json: { jobComplete: true, jobReference: { jobId: 'j1', location: 'US' }, schema: { fields: [{ name: 'day', type: 'DATE' }, { name: 'n', type: 'INTEGER' }, { name: 'ok', type: 'BOOLEAN' }, { name: 'ts', type: 'TIMESTAMP' }] }, rows: [{ f: [{ v: '2026-01-01' }, { v: '3' }, { v: 'true' }, { v: '1767225600.5' }] }], pageToken: 'pt' } };
      }
      if (p === '/bigquery/v2/projects/my-proj/queries/j1') return { json: { jobComplete: true, jobReference: { jobId: 'j1' }, schema: { fields: [{ name: 'day', type: 'DATE' }, { name: 'n', type: 'INTEGER' }, { name: 'ok', type: 'BOOLEAN' }, { name: 'ts', type: 'TIMESTAMP' }] }, rows: [{ f: [{ v: '2026-01-02' }, { v: '5' }, { v: 'false' }, { v: null }] }] } };
      return { status: 404, json: {} };
    case 'analyticsdata.googleapis.com':
      if (auth !== 'Bearer sa-token') return { status: 401, json: {} };
      if (p === '/v1beta/properties/123/metadata') return { json: { dimensions: [{}, {}], metrics: [{}] } };
      if (p === '/v1beta/properties/123:runReport') {
        const b = JSON.parse(body) as { dimensions: { name: string }[]; metrics: { name: string }[]; offset: number };
        expect(b.dimensions.map((d) => d.name)).toEqual(['date']);
        return { json: { rows: [{ dimensionValues: [{ value: '20260101' }], metricValues: [{ value: '10' }, { value: '7' }] }, { dimensionValues: [{ value: '20260102' }], metricValues: [{ value: '12' }, { value: '9' }] }], rowCount: 2 } };
      }
      return { status: 404, json: {} };
    // ---- ClickHouse HTTP (the configured URL points at the mock's /clickhouse.local)
    case 'clickhouse.local': {
      if (req.headers['x-clickhouse-user'] !== 'default' || req.headers['x-clickhouse-key'] !== 'ch-pass') return { status: 403, text: 'Authentication failed' };
      if (/system\.databases/.test(body)) return { text: '{"name":"analytics"}\n' };
      if (/system\.tables/.test(body)) return { text: '{"name":"events","engine":"MergeTree","total_rows":2}\n' };
      if (/version\(\)/.test(body)) return { text: '{"v":"25.3"}\n' };
      if (/FROM "analytics"\."events"/.test(body)) return { text: '{"id":1,"kind":"click"}\n{"id":2,"kind":"view"}\n' };
      return { status: 400, text: `unexpected ${body}` };
    }
    // ---- Redshift Data API (AWS JSON 1.1 protocol; the endpoint override points here)
    case 'redshift.local': {
      const target = String(req.headers['x-amz-target'] ?? '');
      const b = JSON.parse(body || '{}') as Record<string, unknown>;
      if (!String(req.headers.authorization).includes('AKIATEST')) return { status: 403, json: { __type: 'AccessDenied' } };
      if (target.endsWith('ListDatabases')) return { json: { Databases: ['dev'] } };
      if (target.endsWith('ListSchemas')) return { json: { Schemas: ['public', 'pg_catalog'] } };
      if (target.endsWith('ListTables')) return { json: { Tables: [{ name: 'orders', type: 'TABLE' }] } };
      if (target.endsWith('ExecuteStatement')) { expect(b.WorkgroupName).toBe('wg'); return { json: { Id: 'stmt-1' } }; }
      if (target.endsWith('DescribeStatement')) return { json: { Status: 'FINISHED' } };
      if (target.endsWith('GetStatementResult')) return b.NextToken ? { json: { ColumnMetadata: [{ label: 'id' }, { label: 'total' }], Records: [[{ longValue: 2 }, { doubleValue: 20.25 }]] } } : { json: { ColumnMetadata: [{ label: 'id' }, { label: 'total' }], Records: [[{ longValue: 1 }, { isNull: true }]], NextToken: 'n2' } };
      return { status: 400, json: { __type: 'Unknown' } };
    }
    default:
      return { status: 404, json: { error: `unknown host ${host}` } };
  }
}

beforeAll(async () => {
  initLogger({ level: 'silent', stderr: true, pretty: false });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dv-connectors-'));
  mock = await new Promise((resolve) => {
    const hits: string[] = [];
    const srv = http.createServer(async (req, res) => {
      hits.push(`${req.method} ${req.url}`);
      const body = await readBody(req);
      let out: ReturnType<typeof vendorApi>;
      try {
        out = vendorApi(req, body);
      } catch (err) {
        out = { status: 500, json: { error: (err as Error).message } };
      }
      res.writeHead(out.status ?? 200, { 'content-type': out.text !== undefined ? 'text/plain' : 'application/json', ...(out.headers ?? {}) });
      res.end(out.text !== undefined ? out.text : JSON.stringify(out.json ?? {}));
    });
    srv.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(srv.address() as { port: number }).port}`, hits, close: () => srv.close() }));
  });
  const cfg = loadConfig({
    configPath: null,
    env: { DUCKVIEW_DATA_DIR: path.join(dir, 'data'), DUCKVIEW_FILESYSTEM_MODE: 'full', DUCKDB_TEMP_DIRECTORY: path.join(dir, 'spill'), DATABASE_URL: ':memory:', DUCKDB_MEMORY_LIMIT: '512MB', DUCKVIEW_ADMIN_EMAIL: 'admin@test.local', DUCKVIEW_ADMIN_PASSWORD: 'super-secret-pw', DUCKVIEW__duckdb__sync_scheduler_enabled: 'false', DUCKVIEW_PUBLIC_URL: 'https://duckview.example.com', LOG_LEVEL: 'silent' },
  });
  ctx = await createContext(cfg);
  // Every vendor host is served by the mock; Google's token/userinfo endpoints too.
  ctx.connectors.rewriteUrl = (u) => { if (u.startsWith(mock.url)) return u; const x = new URL(u); return `${mock.url}/${x.host}${x.pathname}${x.search}`; };
  googleEndpoints.token = `${mock.url}/oauth2.googleapis.com/token`;
  googleEndpoints.userinfo = `${mock.url}/www.googleapis.com/oauth2/v3/userinfo`;
  admin = ctx.auth.principalFromUser((await ctx.auth.findByEmail('admin@test.local'))!, 'jwt', '127.0.0.1');
  await ctx.auth.createLocalUser({ email: 'user@test.local', password: 'user-secret-pw', role: 'USER' });
  wsId = (await ctx.workspaces.create(admin, { name: 'Connectors', active_db_path: 'connectors.duckdb' })).id;
  ({ app } = await buildApp(ctx));
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  jwt = (await api('POST', '/api/auth/login', { email: 'admin@test.local', password: 'super-secret-pw' }, '')).json.token as string;
  userJwt = (await api('POST', '/api/auth/login', { email: 'user@test.local', password: 'user-secret-pw' }, '')).json.token as string;
});

afterAll(async () => {
  await app.close();
  await ctx.shutdown();
  mock.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Creates a connection, checks it, and syncs one resource into `table`; returns the connection id. */
async function connectAndSync(connector: string, values: Record<string, unknown>, resource: Record<string, unknown>, table: string, transform?: string): Promise<{ id: string; rows: number }> {
  const r = await api('POST', '/api/connector-connections', { connector, name: `${connector} test`, values });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  const id = (r.json.connection as { id: string }).id;
  const t = await api('POST', `/api/connector-connections/${id}/test`);
  expect(t.json, JSON.stringify(t.json)).toMatchObject({ ok: true });
  const s = await api('POST', `/api/workspaces/${wsId}/syncs`, { name: `${connector} sync`, source: { kind: 'connector', connection_id: id, resource }, target_table: table, transform_sql: transform ?? null });
  expect(s.status, JSON.stringify(s.json)).toBe(200);
  const run = await api('POST', `/api/syncs/${(s.json.sync as { id: string }).id}/run`);
  const rr = run.json.run as { status: string; rows: number; error: string | null };
  expect(rr.error).toBeNull();
  expect(rr.status).toBe('ok');
  return { id, rows: rr.rows };
}

describe('registry and secrecy', () => {
  it('lists the 13 connectors with their auth kinds and never returns credentials', async () => {
    const r = await api('GET', '/api/connectors');
    const connectors = r.json.connectors as { id: string; auth: { kind: string; scopes?: string[] }; remote_sql: boolean }[];
    expect(connectors.map((c) => c.id)).toEqual(['snowflake', 'bigquery', 'redshift', 'clickhouse', 'fabric', 'salesforce', 'hubspot', 'stripe', 'ga4', 'airtable', 'notion', 'github', 'jira', 'zendesk', 'shopify', 'intercom', 'linear', 'pipedrive', 'mailchimp', 'google_drive', 'google_sheets']);
    expect(connectors.filter((c) => c.auth.kind === 'google').map((c) => c.id)).toEqual(['bigquery', 'ga4', 'google_drive', 'google_sheets']);
    expect(connectors.filter((c) => c.remote_sql).map((c) => c.id)).toEqual(['snowflake', 'bigquery', 'redshift', 'clickhouse']);
    expect(r.json.google).toEqual({ configured: false });
    const bad = await api('POST', '/api/connector-connections', { connector: 'stripe', name: 'x', values: {} });
    expect(bad.status).toBe(400);
    expect(bad.json.message).toMatch(/Secret key/);
    expect((await api('POST', '/api/connector-connections', { connector: 'nope', values: {} })).status).toBe(400);
    expect((await api('POST', '/api/connector-connections', { connector: 'google_sheets', values: {} })).json.message).toMatch(/Connect with Google/);
  });

  it('keeps API keys encrypted, out of every response and out of the metadata row', async () => {
    const { id } = await connectAndSync('stripe', { api_key: 'sk_test_secret123' }, { resource: 'charges' }, 'stripe_charges');
    const list = JSON.stringify((await api('GET', '/api/connector-connections')).json);
    expect(list).not.toContain('sk_test_secret123');
    expect(list).toContain('"credential_fields":["api_key"]');
    const all = JSON.stringify((await api('GET', '/api/sources')).json);
    expect(all).not.toContain('sk_test_secret123');
    expect(all).toContain('"connectors":[');
    const row = (await ctx.store.db.select().from(ctx.store.schema.connectorConnections)).find((c) => c.id === id)!;
    expect(JSON.stringify(row)).not.toContain('sk_test_secret123');
    expect(row.encrypted_credentials.length).toBeGreaterThan(20);
    // Other users cannot see or use it.
    expect((await api('GET', '/api/connector-connections', undefined, userJwt)).json.connections).toEqual([]);
    expect((await api('POST', `/api/connector-connections/${id}/test`, undefined, userJwt)).status).toBe(404);
    // A wrong key is reported by the vendor and recorded on the connection.
    const wrong = await api('POST', '/api/connector-connections', { connector: 'stripe', name: 'wrong', values: { api_key: 'sk_test_bad' } });
    const t = await api('POST', `/api/connector-connections/${(wrong.json.connection as { id: string }).id}/test`);
    expect(t.json).toMatchObject({ ok: false });
    expect(String(t.json.message)).toMatch(/401/);
    const listed = ((await api('GET', '/api/connector-connections')).json.connections as { name: string; status: string; last_error: string }[]).find((c) => c.name === 'wrong')!;
    expect(listed.status).toBe('error');
    expect(listed.last_error).toMatch(/Invalid API Key/);
    // Rotating the key: values with the secret replace it, other fields are kept.
    const upd = await api('PATCH', `/api/connector-connections/${id}`, { name: 'Stripe prod', values: { api_key: 'sk_test_secret123' } });
    expect(upd.json.connection).toMatchObject({ name: 'Stripe prod', credential_fields: ['api_key'] });
  });
});

describe('SaaS connectors sync page by page into DuckDB', () => {
  it('Stripe: charges across two pages, nested objects flattened', async () => {
    expect(await count('stripe_charges')).toBe(3);
    expect(await sql(`SELECT id, amount, currency, "metadata.order" FROM stripe_charges ORDER BY id`)).toEqual([['ch_1', 1000, 'usd', '7'], ['ch_2', 2500, 'usd', null], ['ch_3', 300, 'eur', null]]);
    const id = ((await api('GET', '/api/connector-connections')).json.connections as { id: string; connector: string }[]).find((c) => c.connector === 'stripe')!.id;
    const b = await api('GET', `/api/connector-connections/${id}/browse`);
    expect((b.json.entries as { name: string }[]).map((e) => e.name)).toContain('subscriptions');
  });

  it('HubSpot: contacts with every property, custom objects listed', async () => {
    const { id, rows } = await connectAndSync('hubspot', { token: 'pat-na1-hub' }, { object: 'contacts' }, 'hs_contacts');
    expect(rows).toBe(2);
    expect(await sql('SELECT id, email, firstname, lifecyclestage FROM hs_contacts ORDER BY id')).toEqual([['1', 'a@x.io', 'Ann', 'lead'], ['2', 'b@x.io', 'Bo', 'customer']]);
    const b = await api('GET', `/api/connector-connections/${id}/browse`);
    expect((b.json.entries as { name: string; type: string }[]).find((e) => e.type === 'custom object')).toMatchObject({ name: 'Pets' });
  });

  it('Airtable: bases → tables → records, preview honours the limit', async () => {
    const r = await api('POST', '/api/connector-connections', { connector: 'airtable', name: 'Air', values: { token: 'pat.air' } });
    const id = (r.json.connection as { id: string }).id;
    const bases = await api('GET', `/api/connector-connections/${id}/browse`);
    expect(bases.json.entries).toEqual([{ name: 'CRM', type: 'base', path: ['appBase1'], hint: 'appBase1' }]);
    const tables = await api('GET', `/api/connector-connections/${id}/browse?path=appBase1`);
    const leaf = (tables.json.entries as { resource: Record<string, unknown> }[])[0]!;
    expect(leaf.resource).toEqual({ base: 'appBase1', table: 'tblLeads', table_name: 'Leads' });
    const preview = await api('POST', `/api/workspaces/${wsId}/syncs/preview`, { source: { kind: 'connector', connection_id: id, resource: leaf.resource }, limit: 2 });
    expect(preview.status, JSON.stringify(preview.json)).toBe(200);
    expect((preview.json.rows as unknown[]).length).toBe(2);
    expect((preview.json.columns as { name: string }[]).map((c) => c.name)).toEqual(['id', 'createdTime', 'Name', 'Score']);
    const s = await api('POST', `/api/workspaces/${wsId}/syncs`, { name: 'leads', source: { kind: 'connector', connection_id: id, resource: leaf.resource }, target_table: 'air_leads', transform_sql: 'SELECT Name AS lead, Score * 2 AS score2 FROM {{raw}}' });
    const run = (await api('POST', `/api/syncs/${(s.json.sync as { id: string }).id}/run`)).json.run as { status: string; rows: number };
    expect(run).toMatchObject({ status: 'ok', rows: 3 });
    expect(await sql('SELECT lead, score2 FROM air_leads ORDER BY score2')).toEqual([['Lead 1', 20], ['Lead 2', 40], ['Lead 3', 60]]);
  });

  it('Notion: databases via search, properties flattened to columns', async () => {
    const { rows } = await connectAndSync('notion', { token: 'ntn_secret' }, { database_id: 'db-1', name: 'Tasks' }, 'notion_tasks');
    expect(rows).toBe(2);
    expect(await sql('SELECT id, "Name", "Done", "Owner", "Due", "Effort", "Tags" FROM notion_tasks ORDER BY id')).toEqual([['pg1', 'Write docs', false, 'Ann', '2026-03-10', 3, ['a', 'b']], ['pg2', 'Ship', true, 'Ann', '2026-03-10', 3, ['a', 'b']]]);
    expect(notionValue({ type: 'formula', formula: { type: 'string', string: 'x' } })).toBe('x');
    expect(notionValue({ type: 'people', people: [{ id: 'u1', name: 'Ann' }] })).toEqual(['Ann']);
    expect(notionValue({ type: 'rich_text', rich_text: [{ plain_text: 'a' }, { plain_text: 'b' }] })).toBe('ab');
  });

  it('Salesforce: connected-app token, describe-driven SOQL, nextRecordsUrl paging', async () => {
    const { id, rows } = await connectAndSync('salesforce', { instance_url: `${mock.url}/sf.local`, client_id: 'cid', client_secret: 'sf-secret' }, { object: 'Account' }, 'sf_accounts');
    expect(rows).toBe(2);
    expect(await sql('SELECT Id, Name, AnnualRevenue FROM sf_accounts ORDER BY Id')).toEqual([['001', 'Acme', 1000000], ['002', 'Globex', null]]);
    const b = await api('GET', `/api/connector-connections/${id}/browse`);
    expect((b.json.entries as { name: string; type: string }[]).map((e) => `${e.type}:${e.name}`)).toEqual(['object:Account', 'custom object:Widget__c']);
    // The token is fetched once and reused across calls.
    expect(mock.hits.filter((h) => h.includes('/sf.local/services/oauth2/token')).length).toBe(1);
  });
});

describe('warehouses', () => {
  it('Snowflake: SQL API statements, browse databases → schemas → tables, remote SQL tool, read-only guard', async () => {
    const { id, rows } = await connectAndSync('snowflake', { account: 'acme-x1', token: 'snow-pat', warehouse: 'COMPUTE_WH' }, { database: 'ANALYTICS', schema: 'PUBLIC', table: 'ORDERS' }, 'sf_orders');
    expect(rows).toBe(2);
    expect(await sql('SELECT ORDER_ID, TOTAL FROM sf_orders ORDER BY 1')).toEqual([[1, 10.5], [2, 20]]);
    expect((await api('GET', `/api/connector-connections/${id}/browse`)).json.entries).toEqual([{ name: 'ANALYTICS', type: 'database', path: ['ANALYTICS'] }]);
    expect((await api('GET', `/api/connector-connections/${id}/browse?path=ANALYTICS/PUBLIC`)).json.entries).toEqual([{ name: 'ORDERS', type: 'table', resource: { database: 'ANALYTICS', schema: 'PUBLIC', table: 'ORDERS' }, hint: '2 rows' }]);
    const q = await api('POST', `/api/connector-connections/${id}/query`, { sql: 'SELECT * FROM ANALYTICS.PUBLIC.ORDERS', limit: 1 });
    expect(q.json).toMatchObject({ connection: 'snowflake test', rows: [{ ORDER_ID: 1, TOTAL: 10.5 }] });
    const bad = await api('POST', `/api/connector-connections/${id}/query`, { sql: 'DROP TABLE ANALYTICS.PUBLIC.ORDERS' });
    expect(bad.status).toBe(400);
    expect(String(bad.json.message)).toMatch(/read-only|SELECT/i);
    // A SQL resource is a sync source too (validated as read-only when saved).
    const s = await api('POST', `/api/workspaces/${wsId}/syncs`, { name: 'orders sql', source: { kind: 'connector', connection_id: id, resource: { sql: 'DELETE FROM ANALYTICS.PUBLIC.ORDERS' } }, target_table: 'x' });
    expect(s.status).toBe(400);
  });

  it('BigQuery with a service account key: datasets → tables, typed rows across pages', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const key = JSON.stringify({ client_email: 'svc@my-proj.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), token_uri: `${mock.url}/oauth2.googleapis.com/token` });
    const { id, rows } = await connectAndSync('bigquery', { project: 'my-proj', service_account_key: key }, { dataset: 'sales', table: 'orders' }, 'bq_orders');
    expect(rows).toBe(2);
    expect(await sql('SELECT day, n, ok, ts FROM bq_orders ORDER BY day')).toEqual([['2026-01-01', 3, true, '2026-01-01 00:00:00.5'], ['2026-01-02', 5, false, null]]);
    const c = ((await api('GET', '/api/connector-connections')).json.connections as { id: string; account_label: string; credential_fields: string[] }[]).find((x) => x.id === id)!;
    expect(c.account_label).toBe('svc@my-proj.iam.gserviceaccount.com');
    expect(c.credential_fields).toEqual(['service_account_key']);
    expect((await api('GET', `/api/connector-connections/${id}/browse?path=sales`)).json.entries).toEqual([{ name: 'orders', type: 'table', resource: { dataset: 'sales', table: 'orders' } }, { name: 'v_daily', type: 'view', resource: { dataset: 'sales', table: 'v_daily' } }]);
  });

  it('ClickHouse over HTTP: JSONEachRow rows, browse databases → tables', async () => {
    const { id, rows } = await connectAndSync('clickhouse', { url: `${mock.url}/clickhouse.local`, user: 'default', password: 'ch-pass' }, { database: 'analytics', table: 'events' }, 'ch_events');
    expect(rows).toBe(2);
    expect(await sql('SELECT id, kind FROM ch_events ORDER BY id')).toEqual([[1, 'click'], [2, 'view']]);
    expect((await api('GET', `/api/connector-connections/${id}/browse?path=analytics`)).json.entries).toEqual([{ name: 'events', type: 'table', resource: { database: 'analytics', table: 'events' }, hint: '2 rows' }]);
  });

  it('Redshift Data API: statement lifecycle, typed fields, NextToken paging', async () => {
    const { id, rows } = await connectAndSync('redshift', { region: 'us-east-1', workgroup: 'wg', database: 'dev', access_key_id: 'AKIATEST', secret_access_key: 'shhh', endpoint: `${mock.url}/redshift.local` }, { schema: 'public', table: 'orders' }, 'rs_orders');
    expect(rows).toBe(2);
    expect(await sql('SELECT id, total FROM rs_orders ORDER BY id')).toEqual([[1, null], [2, 20.25]]);
    expect((await api('GET', `/api/connector-connections/${id}/browse?path=dev`)).json.entries).toEqual([{ name: 'public', type: 'schema', path: ['dev', 'public'] }]);
    const listed = ((await api('GET', '/api/connector-connections')).json.connections as { id: string; credential_fields: string[] }[]).find((x) => x.id === id)!;
    expect(listed.credential_fields.sort()).toEqual(['access_key_id', 'secret_access_key']);
  });

  it('Fabric: the DuckDB side is an Azure service-principal secret plus delta_scan over OneLake', () => {
    const f = fabricSql({ workspace: 'Sales', tenant_id: 't', client_id: 'c' }, { client_secret: "s'q" }, { item: 'Lake.Lakehouse', table: 'orders' }, 'dv_fabric_x');
    expect(f.secret).toContain("CLIENT_SECRET 's''q'");
    expect(f.secret).toContain("ACCOUNT_NAME 'onelake'");
    expect(f.select).toBe("SELECT * FROM delta_scan('abfss://Sales@onelake.dfs.fabric.microsoft.com/Lake.Lakehouse/Tables/orders')");
    expect(f.extensions).toEqual(['azure', 'delta']);
  });

  it('GA4 with a service account: report presets, dimensions × metrics as columns', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const key = JSON.stringify({ client_email: 'ga@my-proj.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), token_uri: `${mock.url}/oauth2.googleapis.com/token` });
    const { id, rows } = await connectAndSync('ga4', { property_id: '123', service_account_key: key }, { dimensions: ['date'], metrics: ['sessions', 'activeUsers'] }, 'ga_sessions');
    expect(rows).toBe(2);
    expect(await sql('SELECT date, sessions, activeUsers FROM ga_sessions ORDER BY date')).toEqual([['20260101', 10, 7], ['20260102', 12, 9]]);
    const presets = (await api('GET', `/api/connector-connections/${id}/browse`)).json.entries as { name: string; resource: { dimensions: string[] } }[];
    expect(presets.map((p) => p.name)).toContain('Traffic by source / medium');
  });
});

describe('Google account (OAuth) for Drive and Sheets', () => {
  it('administrators register the OAuth client; the secret is write-only', async () => {
    expect((await api('GET', '/api/admin/integrations/google', undefined, userJwt)).status).toBe(403);
    expect((await api('PUT', '/api/admin/integrations/google', { client_id: 'x', client_secret: 'y' }, userJwt)).status).toBe(403);
    const before = await api('GET', '/api/admin/integrations/google');
    expect(before.json).toMatchObject({ configured: false, redirect_uri: 'https://duckview.example.com/api/oauth/google/callback' });
    const start = await api('POST', '/api/oauth/google/start', { connector: 'google_sheets', name: 'My sheets' });
    expect(start.status).toBe(400);
    expect(String(start.json.message)).toMatch(/Settings → Integrations/);
    const put = await api('PUT', '/api/admin/integrations/google', { client_id: '123.apps.googleusercontent.com', client_secret: 'goog-secret' });
    expect(put.status, JSON.stringify(put.json)).toBe(200);
    expect(put.json).toMatchObject({ configured: true, client_id: '123.apps.googleusercontent.com' });
    expect(JSON.stringify(put.json)).not.toContain('goog-secret');
    const row = (await ctx.store.db.select().from(ctx.store.schema.appSettings))[0]!;
    expect(JSON.stringify(row)).not.toContain('goog-secret');
    // Updating the id alone keeps the stored secret.
    expect((await api('PUT', '/api/admin/integrations/google', { client_id: '123.apps.googleusercontent.com' })).json).toMatchObject({ configured: true });
    expect((await api('GET', '/api/connectors')).json.google).toEqual({ configured: true });
  });

  it('Connect with Google: consent URL, callback stores the refresh token, tabs sync with the header row', async () => {
    const start = await api('POST', '/api/oauth/google/start', { connector: 'google_sheets', name: 'My sheets' });
    expect(start.status, JSON.stringify(start.json)).toBe(200);
    const url = new URL(start.json.url as string);
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe('123.apps.googleusercontent.com');
    expect(url.searchParams.get('redirect_uri')).toBe('https://duckview.example.com/api/oauth/google/callback');
    expect(url.searchParams.get('scope')).toBe('openid email https://www.googleapis.com/auth/spreadsheets.readonly https://www.googleapis.com/auth/drive.readonly');
    expect(url.searchParams.get('access_type')).toBe('offline');
    const pending = start.json.connection as { id: string; status: string; last_error: string };
    expect(pending).toMatchObject({ status: 'unknown', last_error: 'Waiting for Google sign-in' });
    const state = url.searchParams.get('state')!;
    // A tampered state and a bad code both bounce back to the page with an error, never a 500.
    const tampered = await fetch(`${base}/api/oauth/google/callback?code=good-code&state=${state}x`, { redirect: 'manual' });
    expect(tampered.status).toBe(302);
    expect(tampered.headers.get('location')).toMatch(/google_error=/);
    const badCode = await fetch(`${base}/api/oauth/google/callback?code=bad&state=${state}`, { redirect: 'manual' });
    expect(badCode.headers.get('location')).toMatch(/google_error=/);
    // The real callback (no bearer token: the browser arrives from Google).
    const cb = await fetch(`${base}/api/oauth/google/callback?code=good-code&state=${state}`, { redirect: 'manual' });
    expect(cb.status).toBe(302);
    expect(cb.headers.get('location')).toBe(`/#/connections?connected=${pending.id}`);
    const c = ((await api('GET', '/api/connector-connections')).json.connections as { id: string; status: string; account_label: string; credential_fields: string[]; auth_kind: string }[]).find((x) => x.id === pending.id)!;
    expect(c).toMatchObject({ status: 'ok', account_label: 'analyst@example.com', auth_kind: 'google' });
    expect(c.credential_fields).toEqual(['refresh_token']);
    expect(JSON.stringify(c)).not.toContain('refresh-abc');
    // Access tokens are refreshed from the stored refresh token when needed (the cached one is used first).
    const t = await api('POST', `/api/connector-connections/${pending.id}/test`);
    expect(t.json).toMatchObject({ ok: true });
    expect(String(t.json.message)).toMatch(/1 spreadsheet/);
    const sheets = await api('GET', `/api/connector-connections/${pending.id}/browse`);
    expect(sheets.json.entries).toEqual([{ name: 'Budget', type: 'spreadsheet', path: ['sheet1'], hint: 'modified 2026-04-01' }]);
    const tabs = (await api('GET', `/api/connector-connections/${pending.id}/browse?path=sheet1`)).json.entries as { name: string; resource: Record<string, unknown> }[];
    expect(tabs.map((x) => x.name)).toEqual(['Q1', 'Notes']);
    const s = await api('POST', `/api/workspaces/${wsId}/syncs`, { name: 'budget', source: { kind: 'connector', connection_id: pending.id, resource: tabs[0]!.resource }, target_table: 'budget_q1' });
    const run = (await api('POST', `/api/syncs/${(s.json.sync as { id: string }).id}/run`)).json.run as { status: string; rows: number; error: string | null };
    expect(run.error).toBeNull();
    expect(run.rows).toBe(2); // the padding row is dropped
    expect(await sql('SELECT "Category", "Amount", column_3 FROM budget_q1 ORDER BY "Category"')).toEqual([['Food', 400.5, null], ['Rent', 1200, 'x']]);
    // Force a refresh: expire the cached token.
    ctx.connectors['tokens'].clear();
    expect((await api('POST', `/api/connector-connections/${pending.id}/test`)).json).toMatchObject({ ok: true });
    expect(mock.hits.some((h) => h.includes('/oauth2.googleapis.com/token'))).toBe(true);
  });

  it('Google Drive: folders and data files, a CSV downloaded and read by DuckDB', async () => {
    const start = await api('POST', '/api/oauth/google/start', { connector: 'google_drive' });
    const state = new URL(start.json.url as string).searchParams.get('state')!;
    const id = (start.json.connection as { id: string }).id;
    await fetch(`${base}/api/oauth/google/callback?code=good-code&state=${state}`, { redirect: 'manual' });
    const root = (await api('GET', `/api/connector-connections/${id}/browse`)).json.entries as { name: string; type: string; resource?: Record<string, unknown> }[];
    expect(root.map((e) => `${e.type}:${e.name}`)).toEqual(['folder:Reports', 'file:sales.csv']); // the PNG is not data
    const s = await api('POST', `/api/workspaces/${wsId}/syncs`, { name: 'sales', source: { kind: 'connector', connection_id: id, resource: root[1]!.resource }, target_table: 'drive_sales' });
    expect(s.status, JSON.stringify(s.json)).toBe(200);
    const run = (await api('POST', `/api/syncs/${(s.json.sync as { id: string }).id}/run`)).json.run as { status: string; rows: number; error: string | null };
    expect(run.error).toBeNull();
    expect(await sql('SELECT region, amount FROM drive_sales ORDER BY region')).toEqual([['EU', 10], ['US', 20]]);
    // Nothing staged is left behind, and the staging folder is hidden from the explorer.
    const stage = path.join(dir, 'data', '.duckview', 'sync');
    expect(fs.existsSync(stage) ? fs.readdirSync(stage) : []).toEqual([]);
  });
});

describe('agent tools', () => {
  it('list_data_sources shows connector connections; browse_connector and connector_query work end to end', async () => {
    const env: ToolEnv = { ctx, principal: admin, via: 'rest', defaultWorkspaceId: wsId, agent: null };
    const tools = buildTools(ctx.cfg);
    const t = (name: string) => tools.find((x) => x.name === name)!;
    expect(tools.map((x) => x.name)).toEqual(expect.arrayContaining(['browse_connector', 'connector_query']));
    const list = await runTool(env, t('list_data_sources'), { workspace_id: wsId });
    const sc = list.structuredContent as { connectors: { connector: string; remote_sql: boolean; status: string }[] };
    expect(sc.connectors.map((c) => c.connector)).toEqual(expect.arrayContaining(['stripe', 'snowflake', 'google_sheets']));
    const snow = sc.connectors.find((c) => c.connector === 'snowflake') as unknown as { id: string };
    const browse = await runTool(env, t('browse_connector'), { connection_id: snow.id, path: ['ANALYTICS', 'PUBLIC'] });
    expect((browse.structuredContent as { entries: { resource: unknown }[] }).entries[0]!.resource).toEqual({ database: 'ANALYTICS', schema: 'PUBLIC', table: 'ORDERS' });
    const q = await runTool(env, t('connector_query'), { connection_id: snow.id, sql: 'SELECT * FROM ANALYTICS.PUBLIC.ORDERS' });
    expect((q.structuredContent as { rows: unknown[] }).rows).toHaveLength(2);
    expect((q.content[0] as { text: string }).text).toContain('| ORDER_ID | TOTAL |');
    const stripeConn = sc.connectors.find((c) => c.connector === 'stripe' && c.status === 'ok') as unknown as { id: string };
    const noSql = await runTool(env, t('connector_query'), { connection_id: stripeConn.id, sql: 'SELECT 1' });
    expect(noSql.isError).toBe(true);
    const created = await runTool(env, t('create_data_sync'), { name: 'agent stripe', source: { kind: 'connector', connection_id: stripeConn.id, resource: { resource: 'charges' } }, target_table: 'agent_charges', transform_sql: 'SELECT id, amount / 100.0 AS dollars FROM {{raw}}', run_now: true });
    expect(created.isError, JSON.stringify(created.content)).toBeFalsy();
    expect(await sql('SELECT sum(dollars) FROM agent_charges')).toEqual([[38]]);
  });
});

describe('helpers', () => {
  it('flattens one level, zips columns, retries throttling with Retry-After', async () => {
    expect(flatten({ a: 1, b: { c: 2, d: { e: 3 } }, f: [1] })).toEqual({ a: 1, 'b.c': 2, 'b.d': { e: 3 }, f: [1] });
    expect(zipRows(['x', 'y'], [[1, 2], [3, 4]])).toEqual([{ x: 1, y: 2 }, { x: 3, y: 4 }]);
    let calls = 0;
    const srv = http.createServer((_req, res) => { calls++; if (calls < 3) { res.writeHead(429, { 'retry-after': '0' }); return res.end(); } res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const f = boundFetch({ 'x-test': '1' });
    const res = await f(`http://127.0.0.1:${(srv.address() as { port: number }).port}/`);
    expect(await res.json()).toEqual({ ok: true });
    expect(calls).toBe(3);
    srv.close();
  });
});
