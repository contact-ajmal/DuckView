import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadConfig } from '../config/index.js';
import { initLogger } from '../observability/logger.js';
import { createContext, type AppContext } from '../context.js';
import { buildApp } from '../app.js';
import { buildMcpServer } from '../mcp/server.js';
import { lakehouseEngineBits, aliasFromName } from '../services/lakehouse.js';
import { attachToSql, secretToSql } from '../engine/duckdb.js';
import { databricksTypeToDuck, isIcebergReadable } from '../services/databricks.js';
import type { Principal } from '../services/principal.js';

const here = path.dirname(fileURLToPath(import.meta.url));
/** The fixture's Iceberg metadata embeds this absolute warehouse path (see test/fixtures/iceberg/README.md). */
const WAREHOUSE = '/tmp/duckview-iceberg-fixture/warehouse';

// ------------------------------------------------------------------ mock Iceberg REST catalog
function startMockIrc(token: string): Promise<{ url: string; close: () => void; requests: string[] }> {
  const requests: string[] = [];
  const latestMeta = (ns: string, t: string) => {
    const dir = path.join(WAREHOUSE, ns, t, 'metadata');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.metadata.json')).sort();
    return path.join(dir, files[files.length - 1]!);
  };
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      requests.push(`${req.method} ${url.pathname}`);
      const json = (code: number, body: unknown) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.headers.authorization !== `Bearer ${token}`) return json(401, { error: { message: 'bad token', type: 'NotAuthorizedException', code: 401 } });
      if (url.pathname === '/v1/config') return json(200, { defaults: {}, overrides: {} });
      if (url.pathname === '/v1/namespaces') return json(200, { namespaces: fs.readdirSync(WAREHOUSE).map((n) => [n]) });
      let m = /^\/v1\/namespaces\/([^/]+)\/tables$/.exec(url.pathname);
      if (m) return json(200, { identifiers: fs.readdirSync(path.join(WAREHOUSE, m[1]!)).map((t) => ({ namespace: [m![1]], name: t })) });
      m = /^\/v1\/namespaces\/([^/]+)\/tables\/([^/]+)$/.exec(url.pathname);
      if (m) {
        const p = latestMeta(m[1]!, m[2]!);
        return json(200, { 'metadata-location': p, metadata: JSON.parse(fs.readFileSync(p, 'utf8')), config: {} });
      }
      m = /^\/v1\/namespaces\/([^/]+)$/.exec(url.pathname);
      if (m) return json(200, { namespace: [m[1]], properties: {} });
      json(404, { error: { message: 'not found', type: 'NotFound', code: 404 } });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(srv.address() as { port: number }).port}`, close: () => srv.close(), requests }));
  });
}

// ------------------------------------------------------------------ mock Databricks workspace (Unity Catalog + Statement Execution)
function startMockDatabricks(): Promise<{ url: string; close: () => void; statements: Record<string, unknown>[]; oauthCalls: number }> {
  const statements: Record<string, unknown>[] = [];
  const state = { oauthCalls: 0 };
  const columns = [
    { name: 'order_id', type_text: 'BIGINT', type_name: 'LONG', position: 0 },
    { name: 'region', type_text: 'STRING', type_name: 'STRING', position: 1 },
    { name: 'revenue', type_text: 'DECIMAL(10,2)', type_name: 'DECIMAL', position: 2 },
    { name: 'shipped', type_text: 'BOOLEAN', type_name: 'BOOLEAN', position: 3 },
    { name: 'order_date', type_text: 'DATE', type_name: 'DATE', position: 4 },
  ];
  const allRows = Array.from({ length: 7 }, (_, i) => [String(i + 1), ['north', 'south'][i % 2]!, (100 + i * 10.5).toFixed(2), i % 2 === 0 ? 'true' : 'false', `2026-02-0${i + 1}`]);
  let polls = 0;
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      const json = (code: number, body: unknown) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (url.pathname === '/oidc/v1/token') {
        state.oauthCalls++;
        return json(200, { access_token: 'oauth-access', expires_in: 3600, token_type: 'Bearer' });
      }
      const auth = req.headers.authorization;
      if (auth !== 'Bearer dapi-good' && auth !== 'Bearer oauth-access') return json(403, { error_code: 'PERMISSION_DENIED', message: 'Invalid access token.' });
      if (url.pathname === '/api/2.1/unity-catalog/catalogs') return json(200, { catalogs: [{ name: 'main', catalog_type: 'MANAGED_CATALOG' }, { name: 'sales', catalog_type: 'MANAGED_CATALOG' }] });
      if (url.pathname === '/api/2.1/unity-catalog/schemas') return json(200, { schemas: [{ name: 'information_schema' }, { name: 'gold', full_name: `${url.searchParams.get('catalog_name')}.gold` }, { name: 'bronze' }] });
      if (url.pathname === '/api/2.1/unity-catalog/tables') {
        return json(200, {
          tables: [
            { name: 'orders', full_name: 'sales.gold.orders', table_type: 'MANAGED', data_source_format: 'DELTA', properties: { 'delta.universalFormat.enabledFormats': 'iceberg' } },
            { name: 'returns', full_name: 'sales.gold.returns', table_type: 'MANAGED', data_source_format: 'DELTA' },
            { name: 'v_daily', full_name: 'sales.gold.v_daily', table_type: 'VIEW' },
          ],
        });
      }
      if (url.pathname.startsWith('/api/2.1/unity-catalog/tables/')) {
        const full = decodeURIComponent(url.pathname.split('/').pop()!);
        if (!full.endsWith('.orders')) return json(404, { error_code: 'TABLE_DOES_NOT_EXIST', message: `Table '${full}' does not exist.` });
        return json(200, { name: 'orders', full_name: full, table_type: 'MANAGED', data_source_format: 'DELTA', properties: { 'delta.universalFormat.enabledFormats': 'iceberg' }, columns });
      }
      if (url.pathname.startsWith('/api/2.0/sql/warehouses/')) return json(200, { id: url.pathname.split('/').pop(), name: 'Serverless XS', state: 'RUNNING' });
      if (url.pathname === '/api/2.0/sql/statements' && req.method === 'POST') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          const b = JSON.parse(body) as { statement: string; row_limit?: number };
          statements.push(b);
          if (/boom/i.test(b.statement)) return json(200, { statement_id: 'st-fail', status: { state: 'FAILED', error: { error_code: 'SYNTAX_ERROR', message: 'unexpected token BOOM' } } });
          const rows = allRows.slice(0, b.row_limit ?? allRows.length);
          // First response is still PENDING (client must poll); the poll returns SUCCEEDED with the first chunk.
          polls = 0;
          (srv as unknown as { _rows: unknown[][] })._rows = rows;
          json(200, { statement_id: 'st-1', status: { state: 'PENDING' } });
        });
        return;
      }
      if (url.pathname === '/api/2.0/sql/statements/st-1' && req.method === 'GET') {
        polls++;
        const rows = (srv as unknown as { _rows: unknown[][] })._rows;
        if (polls < 2) return json(200, { statement_id: 'st-1', status: { state: 'RUNNING' } });
        const half = Math.ceil(rows.length / 2);
        return json(200, {
          statement_id: 'st-1',
          status: { state: 'SUCCEEDED' },
          manifest: { schema: { column_count: columns.length, columns }, total_row_count: rows.length, truncated: rows.length < allRows.length, total_chunk_count: rows.length > half ? 2 : 1 },
          result: { chunk_index: 0, row_offset: 0, row_count: half, data_array: rows.slice(0, half), ...(rows.length > half ? { next_chunk_index: 1 } : {}) },
        });
      }
      if (url.pathname === '/api/2.0/sql/statements/st-1/result/chunks/1') {
        const rows = (srv as unknown as { _rows: unknown[][] })._rows;
        const half = Math.ceil(rows.length / 2);
        return json(200, { chunk_index: 1, row_offset: half, row_count: rows.length - half, data_array: rows.slice(half) });
      }
      if (url.pathname.endsWith('/cancel')) return json(200, {});
      json(404, { error_code: 'NOT_FOUND', message: url.pathname });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(srv.address() as { port: number }).port}`, close: () => srv.close(), statements, get oauthCalls() { return state.oauthCalls; } }));
  });
}

let dir: string;
let ctx: AppContext;
let admin: Principal;
let wsId: string;
let app: Awaited<ReturnType<typeof buildApp>>['app'];
let base: string;
let jwt: string;
let irc: Awaited<ReturnType<typeof startMockIrc>>;
let dbx: Awaited<ReturnType<typeof startMockDatabricks>>;

const api = async (method: string, url: string, body?: unknown, token = jwt) => {
  const res = await fetch(base + url, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
};

beforeAll(async () => {
  initLogger({ level: 'silent', stderr: true, pretty: false });
  fs.rmSync(path.dirname(WAREHOUSE), { recursive: true, force: true });
  fs.mkdirSync(path.dirname(WAREHOUSE), { recursive: true });
  fs.cpSync(path.join(here, '../../test/fixtures/iceberg/warehouse'), WAREHOUSE, { recursive: true });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dv-lake-'));
  irc = await startMockIrc('good-token');
  dbx = await startMockDatabricks();
  const cfg = loadConfig({
    configPath: null,
    env: { DUCKVIEW_DATA_DIR: path.join(dir, 'data'), DUCKVIEW_FILESYSTEM_MODE: 'full', DUCKDB_TEMP_DIRECTORY: path.join(dir, 'spill'), DATABASE_URL: ':memory:', DUCKDB_MEMORY_LIMIT: '512MB', DUCKVIEW_ADMIN_EMAIL: 'admin@test.local', DUCKVIEW_ADMIN_PASSWORD: 'super-secret-pw', LOG_LEVEL: 'silent' },
  });
  ctx = await createContext(cfg);
  const user = await ctx.auth.findByEmail('admin@test.local');
  admin = ctx.auth.principalFromUser(user!, 'jwt', '127.0.0.1');
  wsId = (await ctx.workspaces.ensureDefault(admin)).id;
  await ctx.queries.run(admin, wsId, "CREATE TABLE local_regions AS SELECT * FROM (VALUES ('north', 'EMEA'), ('south', 'LATAM'), ('east', 'APAC'), ('west', 'AMER')) t(region, market)");
  ({ app } = await buildApp(ctx));
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  jwt = (await api('POST', '/api/auth/login', { email: 'admin@test.local', password: 'super-secret-pw' }, '')).json.token as string;
}, 120_000);

afterAll(async () => {
  await app.close();
  await ctx.shutdown();
  irc.close();
  dbx.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('lakehouse SQL generation', () => {
  it('renders AWS Glue attach with SigV4 via an S3 secret', () => {
    const bits = lakehouseEngineBits({ id: 'abcdef1234567890', provider: 'AWS_GLUE', alias: 'glue', config: { region: 'eu-west-1', account_id: '123456789012', catalog: 's3tablescatalog/my-bucket', aws_auth: 'keys' } }, { access_key_id: 'AKIA', secret_access_key: 'S3CR3T' });
    expect(secretToSql(bits.secrets[0]!)).toBe("CREATE OR REPLACE SECRET lh_abcdef12_s3 (TYPE S3, KEY_ID 'AKIA', SECRET 'S3CR3T', REGION 'eu-west-1')");
    expect(attachToSql(bits.attachments[0]!)).toBe("ATTACH IF NOT EXISTS '123456789012:s3tablescatalog/my-bucket' AS glue (TYPE ICEBERG, ENDPOINT_TYPE 'glue', SECRET lh_abcdef12_s3)");
    expect(bits.attachments[0]!.extensions).toEqual(['httpfs', 'iceberg']);
  });

  it('renders the default Glue catalog with the credential chain (aws extension)', () => {
    const bits = lakehouseEngineBits({ id: 'abcdef1234567890', provider: 'AWS_GLUE', alias: 'lake', config: { region: 'us-east-1', account_id: '123456789012', catalog: '', aws_auth: 'credential_chain' } }, {});
    expect(secretToSql(bits.secrets[0]!)).toBe("CREATE OR REPLACE SECRET lh_abcdef12_s3 (TYPE S3, PROVIDER credential_chain, REGION 'us-east-1')");
    expect(attachToSql(bits.attachments[0]!)).toBe("ATTACH IF NOT EXISTS '123456789012' AS lake (TYPE ICEBERG, ENDPOINT_TYPE 'glue', SECRET lh_abcdef12_s3)");
    expect(bits.attachments[0]!.extensions).toContain('aws');
  });

  it('renders S3 Tables by ARN', () => {
    const bits = lakehouseEngineBits({ id: 'id1', provider: 'AWS_S3_TABLES', alias: 's3t', config: { region: 'us-east-1', table_bucket_arn: 'arn:aws:s3tables:us-east-1:123456789012:bucket/analytics', aws_auth: 'keys' } }, { access_key_id: 'a', secret_access_key: 'b', session_token: 'c' });
    expect(secretToSql(bits.secrets[0]!)).toContain("SESSION_TOKEN 'c'");
    expect(attachToSql(bits.attachments[0]!)).toBe("ATTACH IF NOT EXISTS 'arn:aws:s3tables:us-east-1:123456789012:bucket/analytics' AS s3t (TYPE ICEBERG, ENDPOINT_TYPE 's3_tables', SECRET lh_id1_s3)");
  });

  it('renders Iceberg REST with bearer / oauth2 / none auth', () => {
    const bearer = lakehouseEngineBits({ id: 'id2', provider: 'ICEBERG_REST', alias: 'polaris', config: { endpoint: 'https://polaris.example.com/api/catalog', warehouse: 'wh', auth: 'bearer', nested_namespaces: true } }, { token: 'tok' });
    expect(secretToSql(bearer.secrets[0]!)).toBe("CREATE OR REPLACE SECRET lh_id2_irc (TYPE ICEBERG, TOKEN 'tok')");
    expect(attachToSql(bearer.attachments[0]!)).toBe("ATTACH IF NOT EXISTS 'wh' AS polaris (TYPE ICEBERG, ENDPOINT 'https://polaris.example.com/api/catalog', SECRET lh_id2_irc, SUPPORT_NESTED_NAMESPACES true)");
    const oauth = lakehouseEngineBits({ id: 'id3', provider: 'ICEBERG_REST', alias: 'snow', config: { endpoint: 'https://acct.snowflakecomputing.com/polaris/api/catalog', warehouse: 'db', auth: 'oauth2', oauth2_scope: 'PRINCIPAL_ROLE:ALL' } }, { client_id: 'cid', client_secret: 'sec' });
    expect(secretToSql(oauth.secrets[0]!)).toBe("CREATE OR REPLACE SECRET lh_id3_irc (TYPE ICEBERG, CLIENT_ID 'cid', CLIENT_SECRET 'sec', OAUTH2_SERVER_URI 'https://acct.snowflakecomputing.com/polaris/api/catalog/v1/oauth/tokens', OAUTH2_SCOPE 'PRINCIPAL_ROLE:ALL')");
    const none = lakehouseEngineBits({ id: 'id4', provider: 'ICEBERG_REST', alias: 'open', config: { endpoint: 'http://lakekeeper:8181/catalog', warehouse: 'demo', auth: 'none' } }, {});
    expect(none.secrets).toEqual([]);
    expect(attachToSql(none.attachments[0]!)).toBe("ATTACH IF NOT EXISTS 'demo' AS open (TYPE ICEBERG, ENDPOINT 'http://lakekeeper:8181/catalog', AUTHORIZATION_TYPE 'none')");
  });

  it('renders Databricks Unity Catalog IRC only when attach_iceberg is on', () => {
    const off = lakehouseEngineBits({ id: 'id5', provider: 'DATABRICKS', alias: 'dbx', config: { host: 'https://dbc-1.cloud.databricks.com', warehouse_id: 'wh1', attach_iceberg: false } }, { token: 'dapi' });
    expect(off.attachments).toEqual([]);
    const pat = lakehouseEngineBits({ id: 'id5', provider: 'DATABRICKS', alias: 'dbx', config: { host: 'https://dbc-1.cloud.databricks.com', unity_catalog: 'sales', attach_iceberg: true, databricks_auth: 'pat' } }, { token: 'dapi' });
    expect(attachToSql(pat.attachments[0]!)).toBe("ATTACH IF NOT EXISTS 'sales' AS dbx (TYPE ICEBERG, ENDPOINT 'https://dbc-1.cloud.databricks.com/api/2.1/unity-catalog/iceberg-rest', SECRET lh_id5_dbx)");
    const m2m = lakehouseEngineBits({ id: 'id5', provider: 'DATABRICKS', alias: 'dbx', config: { host: 'https://dbc-1.cloud.databricks.com', unity_catalog: 'sales', attach_iceberg: true, databricks_auth: 'oauth_m2m' } }, { client_id: 'sp', client_secret: 'pw' });
    expect(secretToSql(m2m.secrets[0]!)).toBe("CREATE OR REPLACE SECRET lh_id5_dbx (TYPE ICEBERG, CLIENT_ID 'sp', CLIENT_SECRET 'pw', OAUTH2_SERVER_URI 'https://dbc-1.cloud.databricks.com/oidc/v1/token', OAUTH2_SCOPE 'all-apis')");
  });

  it('derives aliases and maps Databricks types', () => {
    expect(aliasFromName('Prod Lakehouse (EU)')).toBe('prod_lakehouse_eu');
    expect(aliasFromName('42 tables')).toBe('lh_42_tables');
    expect(databricksTypeToDuck('DECIMAL', 'DECIMAL(10,2)')).toBe('DECIMAL(10,2)');
    expect(databricksTypeToDuck('LONG')).toBe('BIGINT');
    expect(databricksTypeToDuck('STRUCT', 'STRUCT<a:INT>')).toBe('JSON');
    expect(isIcebergReadable({ name: 't', data_source_format: 'DELTA', properties: { 'delta.universalFormat.enabledFormats': 'iceberg' } })).toBe(true);
    expect(isIcebergReadable({ name: 't', data_source_format: 'DELTA' })).toBe(false);
  });
});

describe('Iceberg REST catalog end-to-end (mock catalog, real Iceberg data)', () => {
  let connId: string;

  it('validates configuration', async () => {
    const bad = await api('POST', '/api/lakehouse-connections', { name: 'x', provider: 'AWS_S3_TABLES', config: { table_bucket_arn: 'nope' }, credentials: { access_key_id: 'a', secret_access_key: 'b' } });
    expect(bad.status).toBe(400);
    const missing = await api('POST', '/api/lakehouse-connections', { name: 'x', provider: 'ICEBERG_REST', config: { endpoint: irc.url, auth: 'bearer' }, credentials: {} });
    expect(missing.status).toBe(400);
    expect(String(missing.json.message)).toContain('token');
  });

  it('creates a connection (credentials encrypted, never returned) and tests it', async () => {
    const r = await api('POST', '/api/lakehouse-connections', { name: 'Lake', provider: 'ICEBERG_REST', alias: 'lake', config: { endpoint: irc.url, warehouse: 'wh', auth: 'bearer' }, credentials: { token: 'good-token' } });
    expect(r.status).toBe(200);
    const c = r.json.connection as Record<string, unknown>;
    connId = c.id as string;
    expect(c.alias).toBe('lake');
    expect(c.attached).toBe(true);
    expect(c.credential_fields).toEqual(['token']);
    expect(JSON.stringify(c)).not.toContain('good-token');
    const t = await api('POST', `/api/lakehouse-connections/${connId}/test`);
    expect(t.status).toBe(200);
    expect(t.json.ok).toBe(true);
    expect(t.json.schemas).toBe(1);
    const list = await api('GET', '/api/lakehouse-connections');
    expect((list.json.connections as { status: string }[])[0]!.status).toBe('ok');
  });

  it('rejects a duplicate alias', async () => {
    const r = await api('POST', '/api/lakehouse-connections', { name: 'Lake 2', provider: 'ICEBERG_REST', alias: 'lake', config: { endpoint: irc.url, auth: 'none' } });
    expect(r.status).toBe(400);
  });

  it('browses schemas and tables lazily through the attached catalog', async () => {
    const schemas = await api('GET', `/api/lakehouse/browse?connection_id=${connId}&workspace_id=${wsId}`);
    expect(schemas.status).toBe(200);
    expect(schemas.json.level).toBe('schemas');
    expect((schemas.json.entries as { name: string }[]).map((e) => e.name)).toEqual(['analytics']);
    const tables = await api('GET', `/api/lakehouse/browse?connection_id=${connId}&workspace_id=${wsId}&schema=analytics`);
    expect((tables.json.entries as { name: string; qualified: string; engine: string }[]).map((e) => [e.name, e.qualified, e.engine])).toEqual([
      ['customers', 'lake.analytics.customers', 'duckdb'],
      ['orders', 'lake.analytics.orders', 'duckdb'],
    ]);
    // Listing must not have loaded table metadata.
    expect(irc.requests.filter((r) => /\/tables\/(orders|customers)$/.test(r))).toHaveLength(0);
  });

  it('queries and joins Iceberg tables in DuckDB; the in-memory table survived the hot ATTACH', async () => {
    const r = await ctx.queries.run(admin, wsId, 'SELECT r.market, count(*) AS n, round(sum(o.revenue), 2) AS revenue FROM lake.analytics.orders o JOIN local_regions r USING (region) GROUP BY 1 ORDER BY 1');
    expect(r.rows.map((x) => [x[0], Number(x[1])])).toEqual([
      ['AMER', 25],
      ['APAC', 25],
      ['EMEA', 25],
      ['LATAM', 25],
    ]);
    const ins = await api('POST', '/api/storage/inspect', { workspace_id: wsId, target: 'lake.analytics.orders' });
    expect(ins.status).toBe(200);
    expect((ins.json.columns as { name: string; type: string }[]).map((c) => `${c.name}:${c.type}`)).toEqual(['order_id:BIGINT', 'region:VARCHAR', 'revenue:DOUBLE', 'order_date:DATE']);
  });

  it('keeps lakehouse tables out of the workspace catalog listing', async () => {
    const cat = await ctx.queries.catalog(admin, wsId);
    expect(cat.objects.map((o) => o.name)).toEqual(['local_regions']);
  });

  it('exposes the catalog through MCP browse_storage / list_accessible_data', async () => {
    const server = buildMcpServer(ctx, admin, { defaultWorkspaceId: wsId });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: 't', version: '1' });
    await client.connect(ct);
    const conns = (await client.callTool({ name: 'browse_storage', arguments: { provider: 'lakehouse' } })).structuredContent as { connections: { alias: string; attached: boolean }[] };
    expect(conns.connections[0]).toMatchObject({ alias: 'lake', attached: true });
    const tables = (await client.callTool({ name: 'browse_storage', arguments: { provider: 'lakehouse', connection_id: connId, schema: 'analytics' } })).structuredContent as { entries: { qualified: string }[] };
    expect(tables.entries.map((e) => e.qualified)).toContain('lake.analytics.orders');
    const data = (await client.callTool({ name: 'list_accessible_data', arguments: {} })).structuredContent as { lakehouses: { alias: string; attach_error: string | null }[] };
    expect(data.lakehouses).toEqual([{ id: connId, name: 'Lake', provider: 'ICEBERG_REST', alias: 'lake', attached: true, remote_sql: false, attach_error: null }]);
    const q = (await client.callTool({ name: 'execute_query', arguments: { sql: 'SELECT count(*) AS n FROM lake.analytics.customers' } })).structuredContent as { rows: unknown[][] };
    expect(Number(q.rows[0]![0])).toBe(10);
    await client.close();
  });

  it('surfaces attach failures (bad token) instead of crashing the engine', async () => {
    const r = await api('POST', '/api/lakehouse-connections', { name: 'Broken', provider: 'ICEBERG_REST', alias: 'broken', config: { endpoint: irc.url, warehouse: 'wh', auth: 'bearer' }, credentials: { token: 'wrong' } });
    const id = (r.json.connection as { id: string }).id;
    const t = await api('POST', `/api/lakehouse-connections/${id}/test`);
    expect(t.status).toBe(403);
    expect(t.json.error).toBe('LAKEHOUSE_AUTH_FAILED');
    const browse = await api('GET', `/api/lakehouse/browse?connection_id=${id}&workspace_id=${wsId}`);
    expect(browse.status).toBe(200);
    expect(String(browse.json.attach_error)).toMatch(/401|Unauthorized/);
    // The good catalog and local tables are unaffected.
    expect((await ctx.queries.run(admin, wsId, 'SELECT count(*) FROM lake.analytics.orders')).rows[0]![0]).toBe(100);
    await api('DELETE', `/api/lakehouse-connections/${id}`);
  });

  it('detaches the catalog when the connection is deleted', async () => {
    await api('DELETE', `/api/lakehouse-connections/${connId}`);
    await expect(ctx.queries.run(admin, wsId, 'SELECT count(*) FROM lake.analytics.orders')).rejects.toThrow(/lake|Catalog/i);
    expect((await ctx.queries.run(admin, wsId, 'SELECT count(*) FROM local_regions')).rows[0]![0]).toBe(4);
  });
});

describe('Databricks connector (mock Unity Catalog + Statement Execution API)', () => {
  let connId: string;

  it('creates + tests a PAT connection with a SQL warehouse', async () => {
    const r = await api('POST', '/api/lakehouse-connections', { name: 'Databricks prod', provider: 'DATABRICKS', config: { host: dbx.url, warehouse_id: 'wh-123', unity_catalog: 'sales', databricks_auth: 'pat' }, credentials: { token: 'dapi-good' } });
    expect(r.status).toBe(200);
    const c = r.json.connection as Record<string, unknown>;
    connId = c.id as string;
    expect(c.alias).toBe('databricks_prod');
    expect(c.attached).toBe(false);
    expect(c.remote_sql).toBe(true);
    const t = await api('POST', `/api/lakehouse-connections/${connId}/test`);
    expect(t.status).toBe(200);
    expect(String(t.json.message)).toMatch(/2 schema\(s\)/);
    expect(String(t.json.message)).toMatch(/RUNNING/);
  });

  it('browses Unity Catalog schemas and tables (views + UniForm flags)', async () => {
    const schemas = await api('GET', `/api/lakehouse/browse?connection_id=${connId}&workspace_id=${wsId}`);
    expect(schemas.json.level).toBe('schemas');
    expect((schemas.json.entries as { name: string }[]).map((e) => e.name)).toEqual(['bronze', 'gold']);
    const tables = await api('GET', `/api/lakehouse/browse?connection_id=${connId}&workspace_id=${wsId}&schema=gold`);
    const entries = tables.json.entries as { name: string; type: string; engine: string; qualified: string; format: string | null }[];
    expect(entries.map((e) => [e.name, e.type, e.engine, e.qualified])).toEqual([
      ['orders', 'table', 'remote', 'sales.gold.orders'],
      ['returns', 'table', 'remote', 'sales.gold.returns'],
      ['v_daily', 'view', 'remote', 'sales.gold.v_daily'],
    ]);
    const ins = await api('GET', `/api/lakehouse/${connId}/inspect?table=sales.gold.orders`);
    expect(ins.status).toBe(200);
    expect(ins.json.iceberg_readable).toBe(true);
    expect((ins.json.columns as { name: string }[]).map((c) => c.name)).toEqual(['order_id', 'region', 'revenue', 'shipped', 'order_date']);
  });

  it('runs SQL on the warehouse with polling, chunk paging and typed rows', async () => {
    const r = await api('POST', `/api/lakehouse/${connId}/query`, { sql: 'SELECT * FROM sales.gold.orders', workspace_id: wsId });
    expect(r.status).toBe(200);
    expect(r.json.engine).toBe('databricks');
    expect((r.json.columns as { name: string; type: string; kind: string }[]).map((c) => `${c.name}:${c.type}:${c.kind}`)).toEqual(['order_id:BIGINT:number', 'region:VARCHAR:string', 'revenue:DECIMAL(10,2):number', 'shipped:BOOLEAN:boolean', 'order_date:DATE:temporal']);
    const rows = r.json.rows as unknown[][];
    expect(rows).toHaveLength(7);
    expect(rows[0]).toEqual([1, 'north', 100, true, '2026-02-01']);
    expect(rows[6]![2]).toBe(163);
    expect(r.json.truncated).toBe(false);
    const capped = await api('POST', `/api/lakehouse/${connId}/query`, { sql: 'SELECT * FROM sales.gold.orders', max_rows: 3 });
    expect((capped.json.rows as unknown[][]).length).toBe(3);
    expect(capped.json.truncated).toBe(true);
    expect((dbx.statements.at(-1) as { row_limit: number }).row_limit).toBe(3);
  });

  it('reports statement failures with the Databricks error', async () => {
    const r = await api('POST', `/api/lakehouse/${connId}/query`, { sql: 'SELECT BOOM' });
    expect(r.status).toBe(422);
    expect(String(r.json.message)).toContain('unexpected token BOOM');
  });

  it('materialises a remote result into a DuckDB table that joins with local data', async () => {
    const r = await api('POST', `/api/lakehouse/${connId}/materialize`, { sql: 'SELECT * FROM sales.gold.orders', table: 'dbx_orders', workspace_id: wsId });
    expect(r.status).toBe(200);
    expect(r.json.rows).toBe(7);
    const joined = await ctx.queries.run(admin, wsId, 'SELECT r.market, count(*) AS n, sum(o.revenue) AS rev FROM dbx_orders o JOIN local_regions r USING (region) GROUP BY 1 ORDER BY 1');
    expect(joined.rows.map((x) => [x[0], Number(x[1])])).toEqual([
      ['EMEA', 4],
      ['LATAM', 3],
    ]);
    const cols = await ctx.queries.run(admin, wsId, "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'dbx_orders' ORDER BY ordinal_position");
    expect(cols.rows.map((x) => `${x[0]}:${x[1]}`)).toEqual(['order_id:BIGINT', 'region:VARCHAR', 'revenue:DECIMAL(10,2)', 'shipped:BOOLEAN', 'order_date:DATE']);
    const bad = await api('POST', `/api/lakehouse/${connId}/materialize`, { sql: 'DROP TABLE x', table: 'y', workspace_id: wsId });
    expect(bad.status).toBe(400);
  });

  it('gates non-read statements for agents behind HITL and exposes lakehouse_query over MCP', async () => {
    const user = await ctx.auth.findByEmail('admin@test.local');
    const { token } = await ctx.auth.createToken(user!, { name: 'agent', scopes: ['read', 'write', 'mcp'], workspaceId: wsId });
    const blocked = await api('POST', `/api/lakehouse/${connId}/query`, { sql: 'DELETE FROM sales.gold.orders WHERE 1=0' }, token);
    expect(blocked.status).toBe(409);
    expect(blocked.json.error).toBe('APPROVAL_REQUIRED');
    const approved = await api('POST', `/api/lakehouse/${connId}/query`, { sql: 'DELETE FROM sales.gold.orders WHERE 1=0', dry_run: false }, token);
    expect(approved.status).toBe(200);
    const readOnly = await ctx.auth.createToken(user!, { name: 'ro', scopes: ['read', 'mcp'], workspaceId: wsId });
    const forbidden = await api('POST', `/api/lakehouse/${connId}/query`, { sql: 'DELETE FROM sales.gold.orders', dry_run: false }, readOnly.token);
    expect(forbidden.status).toBe(403);

    const server = buildMcpServer(ctx, admin, { defaultWorkspaceId: wsId });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: 't', version: '1' });
    await client.connect(ct);
    const res = await client.callTool({ name: 'lakehouse_query', arguments: { connection_id: connId, sql: 'SELECT region, revenue FROM sales.gold.orders', page_size: 2 } });
    const sc = res.structuredContent as { rows: unknown[][]; engine: string; truncated: boolean };
    expect(sc.engine).toBe('databricks');
    expect(sc.rows).toHaveLength(2);
    expect(sc.truncated).toBe(true);
    const ins = (await client.callTool({ name: 'inspect_schema', arguments: { file_path_or_table: 'sales.gold.orders', connection_id: connId } })).structuredContent as { columns: unknown[]; engine: string };
    expect(ins.engine).toBe('remote');
    expect(ins.columns).toHaveLength(5);
    await client.close();
  });

  it('supports OAuth M2M service principals (token exchange once, then cached)', async () => {
    const r = await api('POST', '/api/lakehouse-connections', { name: 'Databricks SP', provider: 'DATABRICKS', config: { host: dbx.url, warehouse_id: 'wh-1', databricks_auth: 'oauth_m2m' }, credentials: { client_id: 'sp-id', client_secret: 'sp-secret' } });
    expect(r.status).toBe(200);
    const id = (r.json.connection as { id: string }).id;
    const before = dbx.oauthCalls;
    const t = await api('POST', `/api/lakehouse-connections/${id}/test`);
    expect(t.status).toBe(200);
    expect(String(t.json.message)).toMatch(/2 Unity Catalog catalog\(s\)/);
    expect(dbx.oauthCalls).toBe(before + 1);
    const cats = await api('GET', `/api/lakehouse/browse?connection_id=${id}&workspace_id=${wsId}`);
    expect(cats.json.level).toBe('catalogs');
    expect((cats.json.entries as { name: string }[]).map((e) => e.name)).toEqual(['main', 'sales']);
  });

  it('rejects bad credentials with 403', async () => {
    const r = await api('POST', '/api/lakehouse-connections', { name: 'Bad', provider: 'DATABRICKS', config: { host: dbx.url, warehouse_id: 'wh-1' }, credentials: { token: 'dapi-bad' } });
    const t = await api('POST', `/api/lakehouse-connections/${(r.json.connection as { id: string }).id}/test`);
    expect(t.status).toBe(403);
    expect(t.json.error).toBe('LAKEHOUSE_AUTH_FAILED');
  });
});

describe('sandboxed servers', () => {
  it('configure but refuse to attach lakehouse catalogs when external access is off', async () => {
    const sdir = fs.mkdtempSync(path.join(os.tmpdir(), 'dv-lake-sb-'));
    const cfg = loadConfig({ configPath: null, env: { DUCKVIEW_DATA_DIR: path.join(sdir, 'data'), DUCKVIEW_FILESYSTEM_MODE: 'sandboxed', DUCKDB_TEMP_DIRECTORY: path.join(sdir, 'spill'), DATABASE_URL: ':memory:', DUCKVIEW_ADMIN_EMAIL: 'a@test.local', DUCKVIEW_ADMIN_PASSWORD: 'super-secret-pw', LOG_LEVEL: 'silent' } });
    const sctx = await createContext(cfg);
    try {
      const u = await sctx.auth.findByEmail('a@test.local');
      const p = sctx.auth.principalFromUser(u!, 'jwt');
      const ws = await sctx.workspaces.ensureDefault(p);
      const c = await sctx.lakehouse.create(p.userId, { name: 'Lake', provider: 'ICEBERG_REST', config: { endpoint: irc.url, warehouse: 'wh', auth: 'bearer' }, credentials: { token: 'good-token' } });
      await expect(sctx.lakehouse.test(p.userId, c.id)).rejects.toMatchObject({ code: 'LAKEHOUSE_EXTERNAL_ACCESS_DISABLED' });
      const b = await sctx.lakehouse.browse(p, ws.id, c.id, {});
      expect(b.attach_error).toMatch(/external_access/);
    } finally {
      await sctx.shutdown();
      fs.rmSync(sdir, { recursive: true, force: true });
    }
  });
});
