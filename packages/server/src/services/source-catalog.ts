/**
 * The catalog behind the Connections page: every kind of data source DuckView can connect to, grouped by family,
 * with what the wizard needs (fields, auth style, docs) and what the source can do (browse, attach, remote SQL,
 * scheduled sync). Warehouses, SaaS applications and Google Drive / Sheets go through connector modules (connectors/).
 */
export type SourceFamily = 'storage' | 'lakehouse' | 'database' | 'web' | 'warehouse' | 'saas';

export interface SourceField {
  key: string;
  label: string;
  kind: 'text' | 'secret' | 'number' | 'url' | 'path' | 'boolean' | 'select';
  required?: boolean;
  placeholder?: string;
  options?: string[];
  hint?: string;
}

export interface SourceType {
  id: string;
  family: SourceFamily;
  label: string;
  vendor: string;
  blurb: string;
  /** Which existing connection family stores it, and the value that family expects (provider / engine / type). */
  backend: { family: 'cloud'; provider: 'S3' | 'R2' | 'GCS' | 'AZURE' } | { family: 'lakehouse'; provider: 'AWS_GLUE' | 'AWS_S3_TABLES' | 'ICEBERG_REST' | 'DATABRICKS' } | { family: 'database'; engine: 'postgres' | 'mysql' | 'sqlite' | 'duckdb' } | { family: 'http'; type: 'HTTP' } | { family: 'connector'; connector: string } | { family: 'planned' };
  auth: 'keys' | 'token' | 'password' | 'file' | 'connection_string' | 'none' | 'oauth';
  capabilities: { browse: boolean; attach: boolean; remote_sql: boolean; sync: boolean };
  fields: SourceField[];
  docs?: string;
  status: 'available' | 'planned';
  /** How to refer to it from SQL once connected. */
  example_sql?: string;
}

const dbFields = (port: number): SourceField[] => [
  { key: 'host', label: 'Host', kind: 'text', required: true, placeholder: 'db.internal' },
  { key: 'port', label: 'Port', kind: 'number', placeholder: String(port) },
  { key: 'database', label: 'Database', kind: 'text', required: true },
  { key: 'user', label: 'User', kind: 'text', required: true },
  { key: 'password', label: 'Password', kind: 'secret', required: true },
  { key: 'ssl', label: 'Require SSL', kind: 'boolean' },
  { key: 'read_only', label: 'Attach read-only', kind: 'boolean', hint: 'On by default: a source is queried, not written to.' },
];

export const SOURCE_CATALOG: SourceType[] = [
  // ---- object storage (files: Parquet, CSV, JSON, Delta, Iceberg tables in buckets)
  { id: 's3', family: 'storage', label: 'Amazon S3', vendor: 'AWS', blurb: 'Parquet, CSV, JSON, Delta and Iceberg files in buckets; browsed in the explorer and queried by URI.', backend: { family: 'cloud', provider: 'S3' }, auth: 'keys', capabilities: { browse: true, attach: false, remote_sql: false, sync: true }, fields: [], status: 'available', example_sql: "SELECT * FROM 's3://bucket/path/*.parquet'" },
  { id: 'r2', family: 'storage', label: 'Cloudflare R2', vendor: 'Cloudflare', blurb: 'S3-compatible object storage on Cloudflare.', backend: { family: 'cloud', provider: 'R2' }, auth: 'keys', capabilities: { browse: true, attach: false, remote_sql: false, sync: true }, fields: [], status: 'available', example_sql: "SELECT * FROM 'r2://bucket/events/*.json'" },
  { id: 'gcs', family: 'storage', label: 'Google Cloud Storage', vendor: 'Google', blurb: 'GCS through HMAC (interoperability) keys.', backend: { family: 'cloud', provider: 'GCS' }, auth: 'keys', capabilities: { browse: true, attach: false, remote_sql: false, sync: true }, fields: [], status: 'available', example_sql: "SELECT * FROM 'gs://bucket/data.parquet'" },
  { id: 'azure', family: 'storage', label: 'Azure Blob Storage', vendor: 'Microsoft', blurb: 'Containers and blobs through a connection string.', backend: { family: 'cloud', provider: 'AZURE' }, auth: 'connection_string', capabilities: { browse: true, attach: false, remote_sql: false, sync: true }, fields: [], status: 'available', example_sql: "SELECT * FROM 'az://container/path/*.csv'" },
  // ---- lakehouse catalogs
  { id: 'glue', family: 'lakehouse', label: 'AWS Glue / SageMaker Lakehouse', vendor: 'AWS', blurb: 'Iceberg tables through Glue\'s Iceberg REST endpoint (SigV4); federated and S3 Tables catalogs.', backend: { family: 'lakehouse', provider: 'AWS_GLUE' }, auth: 'keys', capabilities: { browse: true, attach: true, remote_sql: false, sync: true }, fields: [], status: 'available', example_sql: 'SELECT * FROM glue.sales.orders' },
  { id: 's3tables', family: 'lakehouse', label: 'Amazon S3 Tables', vendor: 'AWS', blurb: 'Table buckets by ARN.', backend: { family: 'lakehouse', provider: 'AWS_S3_TABLES' }, auth: 'keys', capabilities: { browse: true, attach: true, remote_sql: false, sync: true }, fields: [], status: 'available' },
  { id: 'iceberg_rest', family: 'lakehouse', label: 'Iceberg REST catalog', vendor: 'Apache Iceberg', blurb: 'Polaris, Nessie, Tabular, Lakekeeper, Snowflake Open Catalog — any REST catalog (bearer or OAuth2 client credentials).', backend: { family: 'lakehouse', provider: 'ICEBERG_REST' }, auth: 'token', capabilities: { browse: true, attach: true, remote_sql: false, sync: true }, fields: [], status: 'available' },
  { id: 'databricks', family: 'lakehouse', label: 'Databricks', vendor: 'Databricks', blurb: 'Unity Catalog browsing, Iceberg-readable tables in DuckDB, and remote SQL on a SQL warehouse.', backend: { family: 'lakehouse', provider: 'DATABRICKS' }, auth: 'token', capabilities: { browse: true, attach: true, remote_sql: true, sync: true }, fields: [], status: 'available' },
  // ---- operational databases (DuckDB scanner extensions, attached read-only as alias.schema.table)
  { id: 'postgres', family: 'database', label: 'PostgreSQL', vendor: 'PostgreSQL', blurb: 'Attached through DuckDB\'s postgres extension: browse schemas, query tables as pg.schema.table, schedule loads.', backend: { family: 'database', engine: 'postgres' }, auth: 'password', capabilities: { browse: true, attach: true, remote_sql: false, sync: true }, fields: dbFields(5432), status: 'available', docs: 'https://duckdb.org/docs/extensions/postgres', example_sql: 'SELECT * FROM pg.public.orders LIMIT 100' },
  { id: 'mysql', family: 'database', label: 'MySQL / MariaDB', vendor: 'MySQL', blurb: 'Attached through DuckDB\'s mysql extension.', backend: { family: 'database', engine: 'mysql' }, auth: 'password', capabilities: { browse: true, attach: true, remote_sql: false, sync: true }, fields: dbFields(3306), status: 'available', docs: 'https://duckdb.org/docs/extensions/mysql', example_sql: 'SELECT * FROM mysql.shop.customers' },
  { id: 'sqlite', family: 'database', label: 'SQLite', vendor: 'SQLite', blurb: 'A SQLite file on the server, attached through the sqlite extension.', backend: { family: 'database', engine: 'sqlite' }, auth: 'file', capabilities: { browse: true, attach: true, remote_sql: false, sync: true }, fields: [{ key: 'path', label: 'File path', kind: 'path', required: true, placeholder: 'app.sqlite' }, { key: 'read_only', label: 'Attach read-only', kind: 'boolean' }], status: 'available', docs: 'https://duckdb.org/docs/extensions/sqlite' },
  { id: 'duckdb', family: 'database', label: 'DuckDB file', vendor: 'DuckDB', blurb: 'Another .duckdb file (a warehouse, an export) attached read-only.', backend: { family: 'database', engine: 'duckdb' }, auth: 'file', capabilities: { browse: true, attach: true, remote_sql: false, sync: true }, fields: [{ key: 'path', label: 'File path', kind: 'path', required: true, placeholder: 'warehouse.duckdb' }, { key: 'read_only', label: 'Attach read-only', kind: 'boolean' }], status: 'available' },
  // ---- web / API
  { id: 'http', family: 'web', label: 'HTTP / REST endpoint', vendor: 'Any', blurb: 'CSV, JSON or Parquet served over HTTPS — an API export, a public dataset — with an optional bearer token or header; loaded on a schedule.', backend: { family: 'http', type: 'HTTP' }, auth: 'token', capabilities: { browse: false, attach: false, remote_sql: false, sync: true }, fields: [{ key: 'bearer_token', label: 'Bearer token', kind: 'secret' }, { key: 'extra_http_headers', label: 'Extra headers (JSON)', kind: 'text', placeholder: '{"X-API-Key": "…"}' }], status: 'available', example_sql: "SELECT * FROM read_json_auto('https://api.example.com/export.json')" },
  { id: 'google_drive', family: 'web', label: 'Google Drive', vendor: 'Google', blurb: 'Sign in with your Google account: browse folders, sync CSV / JSON / Parquet / Excel files and Google Sheets.', backend: { family: 'connector', connector: 'google_drive' }, auth: 'oauth', capabilities: { browse: true, attach: false, remote_sql: false, sync: true }, fields: [], status: 'available' },
  { id: 'google_sheets', family: 'web', label: 'Google Sheets', vendor: 'Google', blurb: 'Sign in with your Google account: pick a spreadsheet and a tab, private sheets included.', backend: { family: 'connector', connector: 'google_sheets' }, auth: 'oauth', capabilities: { browse: true, attach: false, remote_sql: false, sync: true }, fields: [], status: 'available' },
  { id: 'google_sheets_link', family: 'web', label: 'Google Sheet (shared link)', vendor: 'Google', blurb: 'A sheet shared with "anyone with the link" (or published to the web), loaded as CSV on a schedule — no sign-in.', backend: { family: 'http', type: 'HTTP' }, auth: 'none', capabilities: { browse: false, attach: false, remote_sql: false, sync: true }, fields: [{ key: 'spreadsheet_id', label: 'Spreadsheet id', kind: 'text', required: true, hint: 'From the sheet URL: docs.google.com/spreadsheets/d/<id>/…' }, { key: 'gid', label: 'Sheet gid', kind: 'text', placeholder: '0' }], status: 'available' },
  // ---- warehouses: remote SQL through each vendor's HTTP API, rows staged into DuckDB by a sync
  { id: 'snowflake', family: 'warehouse', label: 'Snowflake', vendor: 'Snowflake', blurb: 'SQL API v2: browse databases, schemas and tables; run SQL on a warehouse and land the result in DuckDB.', backend: { family: 'connector', connector: 'snowflake' }, auth: 'token', capabilities: { browse: true, attach: false, remote_sql: true, sync: true }, fields: [], status: 'available', docs: 'https://docs.snowflake.com/en/developer-guide/sql-api/authenticating' },
  { id: 'bigquery', family: 'warehouse', label: 'Google BigQuery', vendor: 'Google', blurb: 'Datasets and tables through the BigQuery API — your Google account or a service account key.', backend: { family: 'connector', connector: 'bigquery' }, auth: 'oauth', capabilities: { browse: true, attach: false, remote_sql: true, sync: true }, fields: [], status: 'available', docs: 'https://cloud.google.com/bigquery/docs/reference/rest' },
  { id: 'redshift', family: 'warehouse', label: 'Amazon Redshift', vendor: 'AWS', blurb: 'Redshift Data API (no VPC access needed): schemas, tables and SQL on a cluster or serverless workgroup.', backend: { family: 'connector', connector: 'redshift' }, auth: 'keys', capabilities: { browse: true, attach: false, remote_sql: true, sync: true }, fields: [], status: 'available', docs: 'https://docs.aws.amazon.com/redshift/latest/mgmt/data-api.html' },
  { id: 'clickhouse', family: 'warehouse', label: 'ClickHouse', vendor: 'ClickHouse', blurb: 'HTTP interface: databases and tables, SQL with JSONEachRow results.', backend: { family: 'connector', connector: 'clickhouse' }, auth: 'password', capabilities: { browse: true, attach: false, remote_sql: true, sync: true }, fields: [], status: 'available', docs: 'https://clickhouse.com/docs/interfaces/http' },
  { id: 'fabric', family: 'warehouse', label: 'Microsoft Fabric / OneLake', vendor: 'Microsoft', blurb: 'Delta tables of Lakehouse and Warehouse items read from OneLake with a service principal.', backend: { family: 'connector', connector: 'fabric' }, auth: 'oauth', capabilities: { browse: true, attach: false, remote_sql: false, sync: true }, fields: [], status: 'available', docs: 'https://learn.microsoft.com/fabric/onelake/onelake-access-api' },
  // ---- SaaS applications: objects pulled page by page on a schedule
  { id: 'salesforce', family: 'saas', label: 'Salesforce', vendor: 'Salesforce', blurb: 'Any queryable object (or a SOQL query) through the REST API with a connected app.', backend: { family: 'connector', connector: 'salesforce' }, auth: 'oauth', capabilities: { browse: true, attach: false, remote_sql: false, sync: true }, fields: [], status: 'available', docs: 'https://help.salesforce.com/s/articleView?id=sf.remoteaccess_oauth_client_credentials_flow.htm' },
  { id: 'hubspot', family: 'saas', label: 'HubSpot', vendor: 'HubSpot', blurb: 'Contacts, companies, deals, tickets and custom objects with all their properties.', backend: { family: 'connector', connector: 'hubspot' }, auth: 'token', capabilities: { browse: true, attach: false, remote_sql: false, sync: true }, fields: [], status: 'available', docs: 'https://developers.hubspot.com/docs/api/private-apps' },
  { id: 'stripe', family: 'saas', label: 'Stripe', vendor: 'Stripe', blurb: 'Charges, customers, invoices, subscriptions, payouts, balance transactions …', backend: { family: 'connector', connector: 'stripe' }, auth: 'token', capabilities: { browse: true, attach: false, remote_sql: false, sync: true }, fields: [], status: 'available', docs: 'https://docs.stripe.com/keys' },
  { id: 'ga4', family: 'saas', label: 'Google Analytics 4', vendor: 'Google', blurb: 'Reports (dimensions × metrics × date range) through the Data API — your Google account or a service account.', backend: { family: 'connector', connector: 'ga4' }, auth: 'oauth', capabilities: { browse: true, attach: false, remote_sql: false, sync: true }, fields: [], status: 'available', docs: 'https://developers.google.com/analytics/devguides/reporting/data/v1' },
  { id: 'airtable', family: 'saas', label: 'Airtable', vendor: 'Airtable', blurb: 'Bases and tables through the REST API with a personal access token.', backend: { family: 'connector', connector: 'airtable' }, auth: 'token', capabilities: { browse: true, attach: false, remote_sql: false, sync: true }, fields: [], status: 'available', docs: 'https://airtable.com/developers/web/guides/personal-access-tokens' },
  { id: 'notion', family: 'saas', label: 'Notion', vendor: 'Notion', blurb: 'Databases shared with an internal integration, properties flattened to columns.', backend: { family: 'connector', connector: 'notion' }, auth: 'token', capabilities: { browse: true, attach: false, remote_sql: false, sync: true }, fields: [], status: 'available', docs: 'https://developers.notion.com/docs/create-a-notion-integration' },
];

export const FAMILY_LABELS: Record<SourceFamily, { label: string; blurb: string }> = {
  storage: { label: 'Object storage', blurb: 'Files in buckets — queried in place, browsed in the explorer.' },
  lakehouse: { label: 'Lakehouse catalogs', blurb: 'Iceberg and Unity catalogs attached as alias.schema.table.' },
  database: { label: 'Databases', blurb: 'Operational databases attached read-only through DuckDB extensions.' },
  web: { label: 'Web, Drive & Sheets', blurb: 'Endpoints, Google Drive files and Sheets loaded on a schedule.' },
  warehouse: { label: 'Warehouses', blurb: 'Cloud warehouses browsed and queried remotely; results staged into DuckDB by syncs.' },
  saas: { label: 'SaaS applications', blurb: 'Business applications pulled object by object on a schedule.' },
};

export const sourceType = (id: string) => SOURCE_CATALOG.find((s) => s.id === id) ?? null;
