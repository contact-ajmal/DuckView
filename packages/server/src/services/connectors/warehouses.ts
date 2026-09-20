/**
 * Warehouse connectors: SQL runs remotely, the result comes back as JSON rows.
 *   - Snowflake   : SQL API v2 with a programmatic access token (or OAuth token); result partitions paged.
 *   - BigQuery    : jobs.query with a Google account (OAuth) or a service account key; pageToken paging.
 *   - Redshift    : Redshift Data API (ExecuteStatement / DescribeStatement / GetStatementResult) with AWS keys.
 *   - ClickHouse  : the HTTP interface, FORMAT JSONEachRow, basic auth.
 *   - Fabric      : OneLake Delta tables read natively by DuckDB (azure + delta extensions, service principal);
 *                   the connector browses OneLake and hands the sync a delta_scan() path.
 * Every `browse` walks database → schema → table so the sync editor can pick a table without typing SQL; `query`
 * accepts any read-only SQL and is what the remote-SQL tool uses.
 */
import { RedshiftDataClient, ExecuteStatementCommand, DescribeStatementCommand, GetStatementResultCommand, ListDatabasesCommand, ListSchemasCommand, ListTablesCommand } from '@aws-sdk/client-redshift-data';
import { ClientSecretCredential } from '@azure/identity';
import { BlobServiceClient } from '@azure/storage-blob';
import { getJson, zipRows, str, ConnectorError, type Connector, type Session, type BrowseEntry, type ReadOptions } from './types.js';

const ident = (v: unknown) => `"${str(v).replace(/"/g, '""')}"`;
const readOnly = (sql: string) => {
  if (!/^\s*(select|with|show|describe|desc|explain)\b/i.test(sql) || /;\s*\S/.test(sql)) throw new ConnectorError('Only a single read-only statement is allowed on a warehouse connection', 400);
  return sql.trim().replace(/;\s*$/, '');
};

// --------------------------------------------------------------------------------------------- Snowflake
export const snowflake: Connector = {
  id: 'snowflake',
  label: 'Snowflake',
  remote_sql: true,
  auth: {
    kind: 'fields',
    fields: [
      { key: 'account', label: 'Account identifier', kind: 'text', required: true, placeholder: 'myorg-myaccount', hint: 'The part before .snowflakecomputing.com' },
      { key: 'token', label: 'Programmatic access token', kind: 'secret', required: true, hint: 'Snowsight → user menu → Settings → Authentication → Programmatic access tokens (or an OAuth access token)' },
      { key: 'warehouse', label: 'Warehouse', kind: 'text', required: true, placeholder: 'COMPUTE_WH' },
      { key: 'database', label: 'Database', kind: 'text', placeholder: 'ANALYTICS' },
      { key: 'schema', label: 'Schema', kind: 'text', placeholder: 'PUBLIC' },
      { key: 'role', label: 'Role', kind: 'text' },
    ],
  },
  headers: (c) => ({ authorization: `Bearer ${c.token}`, 'content-type': 'application/json', accept: 'application/json', 'x-snowflake-authorization-token-type': c.token?.startsWith('eyJ') ? 'OAUTH' : 'PROGRAMMATIC_ACCESS_TOKEN', 'user-agent': 'DuckView' }),
  async test(s) {
    const rows = await collect(this.query!(s, 'SELECT current_version() AS v, current_warehouse() AS w', { limit: 1 }));
    return { ok: true, message: `Connected · Snowflake ${str(rows[0]?.V ?? rows[0]?.v)} · warehouse ${str(rows[0]?.W ?? rows[0]?.w)}` };
  },
  async browse(s, path) {
    if (path.length === 0) return (await collect(this.query!(s, 'SHOW DATABASES', {}))).map((r) => ({ name: str(r.name), type: 'database', path: [str(r.name)] }));
    if (path.length === 1) return (await collect(this.query!(s, `SHOW SCHEMAS IN DATABASE ${ident(path[0])}`, {}))).map((r) => ({ name: str(r.name), type: 'schema', path: [path[0]!, str(r.name)] }));
    const [db, schema] = path;
    const tables = (await collect(this.query!(s, `SHOW TABLES IN SCHEMA ${ident(db)}.${ident(schema)}`, {}))).map((r) => ({ name: str(r.name), type: 'table', resource: { database: db, schema, table: str(r.name) }, hint: r.rows != null ? `${r.rows} rows` : undefined }));
    const views = (await collect(this.query!(s, `SHOW VIEWS IN SCHEMA ${ident(db)}.${ident(schema)}`, {}))).map((r) => ({ name: str(r.name), type: 'view', resource: { database: db, schema, table: str(r.name) } }));
    return [...tables, ...views];
  },
  read(s, resource, opts) {
    const sql = resource.sql ? readOnly(str(resource.sql)) : `SELECT * FROM ${ident(resource.database)}.${ident(resource.schema)}.${ident(resource.table)}`;
    return this.query!(s, sql, opts);
  },
  async *query(s, sql, opts) {
    const base = `https://${str(s.config.account)}.snowflakecomputing.com/api/v2/statements`;
    const body = { statement: readOnly(sql), timeout: 600, warehouse: str(s.config.warehouse), ...(s.config.database ? { database: str(s.config.database) } : {}), ...(s.config.schema ? { schema: str(s.config.schema) } : {}), ...(s.config.role ? { role: str(s.config.role) } : {}), parameters: { MULTI_STATEMENT_COUNT: '1' } };
    let r = await getJson<SfResult>(s, base, { method: 'POST', body: JSON.stringify(body) });
    // 202 = still running: poll the handle.
    for (let i = 0; i < 300 && r.code === '333334'; i++) {
      await new Promise((res) => setTimeout(res, 1000));
      r = await getJson<SfResult>(s, `${base}/${r.statementHandle}`);
    }
    if (!r.resultSetMetaData) throw new ConnectorError(`Snowflake: ${r.message ?? 'no result set'}`);
    const columns = r.resultSetMetaData.rowType.map((c) => c.name);
    let emitted = 0;
    const partitions = r.resultSetMetaData.partitionInfo?.length ?? 1;
    for (let p = 0; p < partitions; p++) {
      const part = p === 0 ? r : await getJson<SfResult>(s, `${base}/${r.statementHandle}?partition=${p}`);
      const rows = zipRows(columns, part.data ?? []);
      yield opts.limit ? rows.slice(0, Math.max(0, opts.limit - emitted)) : rows;
      emitted += rows.length;
      if (opts.limit && emitted >= opts.limit) return;
    }
  },
  describeResource: (r) => (r.sql ? `SQL: ${str(r.sql).slice(0, 80)}` : `${str(r.database)}.${str(r.schema)}.${str(r.table)}`),
};
interface SfResult { code?: string; message?: string; statementHandle?: string; resultSetMetaData?: { rowType: { name: string }[]; partitionInfo?: unknown[] }; data?: unknown[][] }

// --------------------------------------------------------------------------------------------- BigQuery
export const bigquery: Connector = {
  id: 'bigquery',
  label: 'Google BigQuery',
  remote_sql: true,
  auth: {
    kind: 'google',
    scopes: ['https://www.googleapis.com/auth/bigquery.readonly'],
    fields: [
      { key: 'project', label: 'Project id', kind: 'text', required: true, placeholder: 'my-gcp-project' },
      { key: 'location', label: 'Location', kind: 'text', placeholder: 'US' },
      { key: 'service_account_key', label: 'Service account key (JSON) — instead of a Google account', kind: 'secret', hint: 'Paste the key file contents to authenticate server-to-server; leave empty to connect with your Google account.' },
    ],
  },
  headers: (c) => ({ authorization: `Bearer ${c.access_token}`, 'content-type': 'application/json' }),
  async test(s) {
    const r = await getJson<{ datasets?: unknown[] }>(s, `https://bigquery.googleapis.com/bigquery/v2/projects/${enc(s.config.project)}/datasets?maxResults=1`);
    return { ok: true, message: `Connected · project ${str(s.config.project)}${r.datasets?.length ? '' : ' (no datasets visible)'}` };
  },
  async browse(s, path) {
    const project = enc(s.config.project);
    if (path.length === 0) {
      const r = await getJson<{ datasets?: { datasetReference: { datasetId: string } }[] }>(s, `https://bigquery.googleapis.com/bigquery/v2/projects/${project}/datasets?maxResults=1000`);
      return (r.datasets ?? []).map((d) => ({ name: d.datasetReference.datasetId, type: 'dataset', path: [d.datasetReference.datasetId] }));
    }
    const r = await getJson<{ tables?: { tableReference: { tableId: string }; type: string; numRows?: string }[] }>(s, `https://bigquery.googleapis.com/bigquery/v2/projects/${project}/datasets/${enc(path[0])}/tables?maxResults=1000`);
    return (r.tables ?? []).map((t) => ({ name: t.tableReference.tableId, type: t.type === 'VIEW' ? 'view' : 'table', resource: { dataset: path[0], table: t.tableReference.tableId } }));
  },
  read(s, resource, opts) {
    const sql = resource.sql ? readOnly(str(resource.sql)) : `SELECT * FROM \`${str(s.config.project)}.${str(resource.dataset)}.${str(resource.table)}\``;
    return this.query!(s, sql, opts);
  },
  async *query(s, sql, opts) {
    const project = enc(s.config.project);
    let r = await getJson<BqResult>(s, `https://bigquery.googleapis.com/bigquery/v2/projects/${project}/queries`, { method: 'POST', body: JSON.stringify({ query: readOnly(sql), useLegacySql: false, timeoutMs: 60_000, maxResults: opts.limit ? Math.min(opts.limit, 10_000) : 10_000, ...(s.config.location ? { location: str(s.config.location) } : {}) }) });
    for (let i = 0; i < 300 && r.jobComplete === false; i++) {
      await new Promise((res) => setTimeout(res, 1000));
      r = await getJson<BqResult>(s, `https://bigquery.googleapis.com/bigquery/v2/projects/${project}/queries/${r.jobReference?.jobId}?maxResults=10000${r.jobReference?.location ? `&location=${enc(r.jobReference.location)}` : ''}`);
    }
    const columns = (r.schema?.fields ?? []).map((f) => f.name);
    let emitted = 0;
    for (;;) {
      const rows = (r.rows ?? []).map((row) => Object.fromEntries(columns.map((c, i) => [c, parseBq(row.f[i]?.v, r.schema!.fields[i]!)])));
      yield opts.limit ? rows.slice(0, Math.max(0, opts.limit - emitted)) : rows;
      emitted += rows.length;
      if (!r.pageToken || (opts.limit && emitted >= opts.limit)) return;
      r = await getJson<BqResult>(s, `https://bigquery.googleapis.com/bigquery/v2/projects/${project}/queries/${r.jobReference?.jobId}?pageToken=${enc(r.pageToken)}&maxResults=10000${r.jobReference?.location ? `&location=${enc(r.jobReference.location)}` : ''}`);
    }
  },
  describeResource: (r) => (r.sql ? `SQL: ${str(r.sql).slice(0, 80)}` : `${str(r.dataset)}.${str(r.table)}`),
};
interface BqResult { jobComplete?: boolean; jobReference?: { jobId: string; location?: string }; schema?: { fields: { name: string; type: string; mode?: string }[] }; rows?: { f: { v: unknown }[] }[]; pageToken?: string }
function parseBq(v: unknown, f: { type: string; mode?: string }): unknown {
  if (v == null) return null;
  if (f.mode === 'REPEATED') return v;
  switch (f.type) {
    case 'INTEGER': case 'INT64': case 'FLOAT': case 'FLOAT64': case 'NUMERIC': case 'BIGNUMERIC': return Number(v);
    case 'BOOLEAN': case 'BOOL': return v === 'true' || v === true;
    case 'TIMESTAMP': return new Date(Number(v) * 1000).toISOString();
    default: return v;
  }
}

// --------------------------------------------------------------------------------------------- Redshift
export const redshift: Connector = {
  id: 'redshift',
  label: 'Amazon Redshift',
  remote_sql: true,
  auth: {
    kind: 'fields',
    fields: [
      { key: 'region', label: 'AWS region', kind: 'text', required: true, placeholder: 'us-east-1' },
      { key: 'workgroup', label: 'Serverless workgroup', kind: 'text', placeholder: 'default', hint: 'For Redshift Serverless; leave empty for a provisioned cluster' },
      { key: 'cluster', label: 'Cluster identifier', kind: 'text', placeholder: 'my-cluster', hint: 'For a provisioned cluster' },
      { key: 'database', label: 'Database', kind: 'text', required: true, placeholder: 'dev' },
      { key: 'db_user', label: 'Database user', kind: 'text', hint: 'Provisioned clusters with temporary credentials; leave empty to use a Secrets Manager ARN or IAM identity' },
      { key: 'secret_arn', label: 'Secrets Manager secret ARN', kind: 'text', hint: 'Optional: a secret with the database credentials' },
      { key: 'access_key_id', label: 'AWS access key id', kind: 'secret', hint: 'Leave empty to use the server\'s AWS credential chain' },
      { key: 'secret_access_key', label: 'AWS secret access key', kind: 'secret' },
      { key: 'endpoint', label: 'Endpoint override', kind: 'url', hint: 'Testing only' },
    ],
  },
  headers: () => ({}),
  async test(s) {
    const rows = await collect(this.query!(s, 'SELECT version()', { limit: 1 }));
    return { ok: true, message: `Connected · ${str(Object.values(rows[0] ?? {})[0]).slice(0, 60)}` };
  },
  async browse(s, path) {
    const c = rsClient(s);
    const target = rsTarget(s);
    if (path.length === 0) {
      const r = await c.send(new ListDatabasesCommand({ ...target }));
      return (r.Databases ?? []).map((d) => ({ name: d, type: 'database', path: [d] }));
    }
    if (path.length === 1) {
      const r = await c.send(new ListSchemasCommand({ ...target, Database: path[0]! }));
      return (r.Schemas ?? []).filter((x) => !['pg_catalog', 'information_schema', 'pg_internal'].includes(x)).map((x) => ({ name: x, type: 'schema', path: [path[0]!, x] }));
    }
    const r = await c.send(new ListTablesCommand({ ...target, Database: path[0]!, SchemaPattern: path[1]! }));
    return (r.Tables ?? []).map((t) => ({ name: t.name ?? '', type: t.type === 'VIEW' ? 'view' : 'table', resource: { database: path[0], schema: path[1], table: t.name } }));
  },
  read(s, resource, opts) {
    const sql = resource.sql ? readOnly(str(resource.sql)) : `SELECT * FROM ${ident(resource.schema)}.${ident(resource.table)}`;
    return this.query!(s, sql, opts);
  },
  async *query(s, sql, opts) {
    const c = rsClient(s);
    const { Id } = await c.send(new ExecuteStatementCommand({ ...rsTarget(s), Sql: readOnly(sql) }));
    for (let i = 0; i < 600; i++) {
      const d = await c.send(new DescribeStatementCommand({ Id }));
      if (d.Status === 'FINISHED') break;
      if (d.Status === 'FAILED' || d.Status === 'ABORTED') throw new ConnectorError(`Redshift: ${d.Error ?? d.Status}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
    let token: string | undefined;
    let emitted = 0;
    do {
      const r = await c.send(new GetStatementResultCommand({ Id, NextToken: token }));
      const columns = (r.ColumnMetadata ?? []).map((m) => m.label ?? m.name ?? '');
      const rows = (r.Records ?? []).map((rec) => Object.fromEntries(columns.map((col, i) => [col, rsField(rec[i] as unknown as Record<string, unknown> | undefined)])));
      yield opts.limit ? rows.slice(0, Math.max(0, opts.limit - emitted)) : rows;
      emitted += rows.length;
      token = r.NextToken;
    } while (token && !(opts.limit && emitted >= opts.limit));
  },
  describeResource: (r) => (r.sql ? `SQL: ${str(r.sql).slice(0, 80)}` : `${str(r.schema)}.${str(r.table)}`),
};
function rsClient(s: Session): RedshiftDataClient {
  const creds = s.credentials.access_key_id ? { credentials: { accessKeyId: s.credentials.access_key_id, secretAccessKey: s.credentials.secret_access_key ?? '' } } : {};
  return new RedshiftDataClient({ region: str(s.config.region, 'us-east-1'), ...(s.config.endpoint ? { endpoint: str(s.config.endpoint) } : {}), ...creds });
}
function rsTarget(s: Session) {
  return { Database: str(s.config.database), ...(s.config.workgroup ? { WorkgroupName: str(s.config.workgroup) } : {}), ...(s.config.cluster ? { ClusterIdentifier: str(s.config.cluster) } : {}), ...(s.config.db_user ? { DbUser: str(s.config.db_user) } : {}), ...(s.config.secret_arn ? { SecretArn: str(s.config.secret_arn) } : {}) };
}
function rsField(f: Record<string, unknown> | undefined): unknown {
  if (!f) return null;
  if (f.isNull) return null;
  return f.stringValue ?? f.longValue ?? f.doubleValue ?? f.booleanValue ?? f.blobValue ?? null;
}

// --------------------------------------------------------------------------------------------- ClickHouse
export const clickhouse: Connector = {
  id: 'clickhouse',
  label: 'ClickHouse',
  remote_sql: true,
  auth: {
    kind: 'fields',
    fields: [
      { key: 'url', label: 'HTTP endpoint', kind: 'url', required: true, placeholder: 'https://abc123.us-east-1.aws.clickhouse.cloud:8443', hint: 'ClickHouse Cloud or a self-hosted server\'s HTTP port (8123 / 8443)' },
      { key: 'user', label: 'User', kind: 'text', required: true, placeholder: 'default' },
      { key: 'password', label: 'Password', kind: 'secret', required: true },
      { key: 'database', label: 'Default database', kind: 'text', placeholder: 'default' },
    ],
  },
  headers: (c, cfg) => ({ 'x-clickhouse-user': str(cfg.user, 'default'), 'x-clickhouse-key': c.password ?? '' }),
  async test(s) {
    const rows = await collect(this.query!(s, 'SELECT version() AS v', { limit: 1 }));
    return { ok: true, message: `Connected · ClickHouse ${str(rows[0]?.v)}` };
  },
  async browse(s, path) {
    if (path.length === 0) return (await collect(this.query!(s, "SELECT name FROM system.databases WHERE name NOT IN ('system', 'INFORMATION_SCHEMA', 'information_schema') ORDER BY name", {}))).map((r) => ({ name: str(r.name), type: 'database', path: [str(r.name)] }));
    return (await collect(this.query!(s, `SELECT name, engine, total_rows FROM system.tables WHERE database = ${lit(path[0])} ORDER BY name`, {}))).map((r) => ({ name: str(r.name), type: /view/i.test(str(r.engine)) ? 'view' : 'table', resource: { database: path[0], table: str(r.name) }, hint: r.total_rows != null ? `${r.total_rows} rows` : undefined }));
  },
  read(s, resource, opts) {
    const sql = resource.sql ? readOnly(str(resource.sql)) : `SELECT * FROM ${ident(resource.database)}.${ident(resource.table)}`;
    return this.query!(s, sql, opts);
  },
  async *query(s, sql, opts) {
    const q = `${readOnly(sql)}${opts.limit ? ` LIMIT ${opts.limit}` : ''} FORMAT JSONEachRow`;
    const u = new URL(str(s.config.url));
    if (s.config.database) u.searchParams.set('database', str(s.config.database));
    const res = await s.fetch(u.toString(), { method: 'POST', body: q, headers: { 'content-type': 'text/plain' } });
    const text = await res.text();
    if (!res.ok) throw new ConnectorError(`ClickHouse → ${res.status}: ${text.slice(0, 300)}`, res.status);
    const rows = text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    for (let i = 0; i < rows.length; i += 5000) yield rows.slice(i, i + 5000);
  },
  describeResource: (r) => (r.sql ? `SQL: ${str(r.sql).slice(0, 80)}` : `${str(r.database)}.${str(r.table)}`),
};
const lit = (v: unknown) => `'${str(v).replace(/'/g, "''")}'`;

// --------------------------------------------------------------------------------------------- Microsoft Fabric (OneLake)
export const fabric: Connector = {
  id: 'fabric',
  label: 'Microsoft Fabric / OneLake',
  remote_sql: false,
  auth: {
    kind: 'fields',
    fields: [
      { key: 'workspace', label: 'Fabric workspace', kind: 'text', required: true, placeholder: 'Sales Analytics', hint: 'Workspace name (or id) as it appears in Fabric' },
      { key: 'tenant_id', label: 'Entra tenant id', kind: 'text', required: true },
      { key: 'client_id', label: 'Service principal client id', kind: 'text', required: true, hint: 'An app registration given Contributor/Viewer on the workspace; tenant setting "Service principals can use Fabric APIs" must be on' },
      { key: 'client_secret', label: 'Client secret', kind: 'secret', required: true },
    ],
  },
  headers: () => ({}),
  async test(s) {
    const entries = await this.browse(s, []);
    return { ok: true, message: `Connected · ${entries.length} lakehouse/warehouse item${entries.length === 1 ? '' : 's'} in ${str(s.config.workspace)}` };
  },
  /** workspace → items (Lakehouse / Warehouse) → Tables → Delta table folders. */
  async browse(s, path) {
    const container = onelake(s).getContainerClient(str(s.config.workspace));
    if (path.length === 0) {
      const out: BrowseEntry[] = [];
      for await (const p of container.listBlobsByHierarchy('/')) if (p.kind === 'prefix' && /\.(Lakehouse|Warehouse)\/$/.test(p.name)) out.push({ name: p.name.replace(/\/$/, ''), type: 'item', path: [p.name.replace(/\/$/, '')] });
      return out;
    }
    const prefix = `${path[0]}/Tables/`;
    const out: BrowseEntry[] = [];
    for await (const p of container.listBlobsByHierarchy('/', { prefix })) if (p.kind === 'prefix') { const name = p.name.slice(prefix.length).replace(/\/$/, ''); out.push({ name, type: 'table', resource: { item: path[0], table: name } }); }
    return out;
  },
  async *read() {
    // Fabric tables are read by DuckDB itself (delta_scan over abfss://) — see fabricSql(); never through the API.
    throw new ConnectorError('Fabric tables are read by DuckDB directly', 400);
  },
  describeResource: (r) => `${str(r.item)}/Tables/${str(r.table)}`,
};
function onelake(s: Session): BlobServiceClient {
  const cred = new ClientSecretCredential(str(s.config.tenant_id), str(s.config.client_id), s.credentials.client_secret ?? '');
  return new BlobServiceClient(str(s.config.onelake_url, 'https://onelake.blob.fabric.microsoft.com'), cred);
}
/** The DuckDB side of a Fabric sync: an Azure secret for the service principal and a delta_scan over OneLake. */
export function fabricSql(config: Record<string, unknown>, creds: Record<string, string>, resource: Record<string, unknown>, secretName: string): { secret: string; select: string; extensions: string[] } {
  const q = (v: string) => `'${v.replace(/'/g, "''")}'`;
  const secret = `CREATE OR REPLACE SECRET ${secretName} (TYPE azure, PROVIDER service_principal, TENANT_ID ${q(str(config.tenant_id))}, CLIENT_ID ${q(str(config.client_id))}, CLIENT_SECRET ${q(creds.client_secret ?? '')}, ACCOUNT_NAME 'onelake', ENDPOINT 'fabric.microsoft.com', SCOPE ${q(`abfss://${str(config.workspace)}@onelake.dfs.fabric.microsoft.com/`)})`;
  const path = `abfss://${str(config.workspace)}@onelake.dfs.fabric.microsoft.com/${str(resource.item)}/Tables/${str(resource.table)}`;
  return { secret, select: `SELECT * FROM delta_scan(${q(path)})`, extensions: ['azure', 'delta'] };
}

// --------------------------------------------------------------------------------------------- helpers
export async function collect(it: AsyncIterable<Record<string, unknown>[]>): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for await (const batch of it) out.push(...batch);
  return out;
}
const enc = (v: unknown) => encodeURIComponent(str(v));
export type { ReadOptions };
