/**
 * Metadata store schema — SQLite dialect (default, zero-ops local mode).
 * Keep column names/semantics identical to ./pg.ts; the service layer is written once against this shape.
 */
import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const USER_ROLES = ['ADMIN', 'USER', 'READ_ONLY'] as const;
export const AUTH_PROVIDERS = ['local', 'oidc', 'saml'] as const;
export const CONNECTION_TYPES = ['MOTHERDUCK', 'S3', 'POSTGRES', 'GCS', 'AZURE', 'HTTP'] as const;
export const TOKEN_SCOPES = ['read', 'write', 'admin', 'mcp'] as const;
export const ACTOR_TYPES = ['USER', 'AGENT', 'SYSTEM'] as const;
/** Access level on a shared workspace. OWNER manages sharing/settings, EDITOR mutates data, VIEWER runs read-only SQL. */
export const WORKSPACE_ROLES = ['OWNER', 'EDITOR', 'VIEWER'] as const;
export const GROUP_MEMBER_ROLES = ['MANAGER', 'MEMBER'] as const;
export const MEMBER_SUBJECT_TYPES = ['user', 'group'] as const;

export type UserRole = (typeof USER_ROLES)[number];
export type AuthProvider = (typeof AUTH_PROVIDERS)[number];
export type ConnectionType = (typeof CONNECTION_TYPES)[number];
export type TokenScope = (typeof TOKEN_SCOPES)[number];
export type ActorType = (typeof ACTOR_TYPES)[number];
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];
export type GroupMemberRole = (typeof GROUP_MEMBER_ROLES)[number];
export type MemberSubjectType = (typeof MEMBER_SUBJECT_TYPES)[number];

export interface EngineSettings {
  memory_limit?: string; // e.g. "8GB" | "50%"
  threads?: number | 'auto';
  query_timeout_seconds?: number;
  temp_directory?: string;
  /** Extensions to LOAD before the configuration is locked. Must be in the allow-list. */
  extensions?: string[];
  /** Data connection ids whose secrets are applied (CREATE SECRET) at engine start. */
  connection_ids?: string[];
}

/** A local folder mounted into the explorer (VS Code-style workspace folder). */
export interface WorkspaceFolder {
  path: string; // absolute, canonical
  name: string;
  added_at: string;
  /** Uploads land here instead of the data directory (one folder at most). */
  upload_default?: boolean;
}

export interface ChartConfig {
  type: 'bar' | 'line' | 'area' | 'scatter' | 'pie' | 'none';
  x?: string;
  y?: string[];
  stacked?: boolean;
}

export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    password_hash: text('password_hash'),
    auth_provider: text('auth_provider', { enum: AUTH_PROVIDERS }).notNull().default('local'),
    role: text('role', { enum: USER_ROLES }).notNull().default('USER'),
    display_name: text('display_name'),
    external_id: text('external_id'),
    /** Deactivated (SCIM active=false or by an admin): no sign-in, no tokens, no scheduled work runs as them. */
    disabled: integer('disabled', { mode: 'boolean' }).notNull().default(false),
    created_at: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [uniqueIndex('users_email_idx').on(t.email)],
);

/** Where a cloud-backed workspace stands relative to its object: last pushed ETag, when, size, unsynced changes, last problem. */
export interface CloudSyncState {
  etag: string | null;
  synced_at: string | null;
  size_bytes: number | null;
  /** Local changes not yet pushed. */
  dirty: boolean;
  last_error: string | null;
  /** Milliseconds the last push took. */
  last_push_ms?: number;
}

export const workspaces = sqliteTable(
  'workspaces',
  {
    id: text('id').primaryKey(),
    user_id: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    active_db_path: text('active_db_path').notNull().default(':memory:'),
    engine_settings: text('engine_settings', { mode: 'json' }).$type<EngineSettings>().notNull().default({}),
    folders: text('folders', { mode: 'json' }).$type<WorkspaceFolder[]>().notNull().default([]),
    /** Monotonic data epoch: bumped on every mutation, file/folder change and :memory: engine (re)start. Cache keys embed it. */
    data_version: integer('data_version').notNull().default(0),
    /** For cloud-backed databases (active_db_path is s3:// gs:// r2:// az://): the owner's connection that holds the file. */
    cloud_connection_id: text('cloud_connection_id'),
    /** Sync bookkeeping of the local working copy against the cloud object. */
    cloud_sync: text('cloud_sync', { mode: 'json' }).$type<CloudSyncState | null>(),
    created_at: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updated_at: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [index('workspaces_user_idx').on(t.user_id)],
);

export const sessionTabs = sqliteTable(
  'session_tabs',
  {
    id: text('id').primaryKey(),
    workspace_id: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    /** Tabs are per user inside a (possibly shared) workspace. Backfilled to the workspace owner for pre-sharing rows. */
    user_id: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    sql_content: text('sql_content').notNull().default(''),
    chart_config: text('chart_config', { mode: 'json' }).$type<ChartConfig>().notNull().default({ type: 'none' }),
    order_index: integer('order_index').notNull().default(0),
    cursor_position: integer('cursor_position').notNull().default(0),
    /** null = DuckDB (local). "lakehouse:<connection_id>" runs the tab on a remote SQL engine (e.g. a Databricks SQL warehouse). */
    engine: text('engine'),
    updated_at: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [index('session_tabs_workspace_idx').on(t.workspace_id), index('session_tabs_user_idx').on(t.workspace_id, t.user_id)],
);

export const dataConnections = sqliteTable(
  'data_connections',
  {
    id: text('id').primaryKey(),
    user_id: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    type: text('type', { enum: CONNECTION_TYPES }).notNull(),
    encrypted_credentials: text('encrypted_credentials').notNull(),
    iv: text('iv').notNull(),
    tag: text('tag').notNull(),
    created_at: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [index('data_connections_user_idx').on(t.user_id)],
);

export const apiTokens = sqliteTable(
  'api_tokens',
  {
    id: text('id').primaryKey(),
    user_id: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    workspace_id: text('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
    token_hash: text('token_hash').notNull(),
    token_prefix: text('token_prefix').notNull(),
    name: text('name').notNull(),
    scopes: text('scopes', { mode: 'json' }).$type<TokenScope[]>().notNull().default(['read']),
    expires_at: integer('expires_at', { mode: 'timestamp_ms' }),
    last_used_at: integer('last_used_at', { mode: 'timestamp_ms' }),
    created_at: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [uniqueIndex('api_tokens_hash_idx').on(t.token_hash), index('api_tokens_user_idx').on(t.user_id)],
);

export const auditLogs = sqliteTable(
  'audit_logs',
  {
    id: text('id').primaryKey(),
    user_id: text('user_id'),
    actor_type: text('actor_type', { enum: ACTOR_TYPES }).notNull(),
    action: text('action').notNull(),
    resource: text('resource'),
    query_text: text('query_text'),
    duration_ms: integer('duration_ms'),
    ip_address: text('ip_address'),
    status: text('status').notNull().default('ok'),
    error: text('error'),
    timestamp: integer('timestamp', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [index('audit_logs_ts_idx').on(t.timestamp), index('audit_logs_user_idx').on(t.user_id)],
);

// ---------------------------------------------------------------------------
// Teams and workspace sharing
// ---------------------------------------------------------------------------

export const groups = sqliteTable(
  'groups',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description'),
    /** Identity-provider group name/id when the group is mirrored from an OIDC `groups` claim (managed by SSO sync). */
    external_id: text('external_id'),
    created_by: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    created_at: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updated_at: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [uniqueIndex('groups_name_idx').on(t.name), uniqueIndex('groups_external_idx').on(t.external_id)],
);

export const groupMembers = sqliteTable(
  'group_members',
  {
    group_id: text('group_id').notNull().references(() => groups.id, { onDelete: 'cascade' }),
    user_id: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    role: text('role', { enum: GROUP_MEMBER_ROLES }).notNull().default('MEMBER'),
    added_at: integer('added_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [uniqueIndex('group_members_pk').on(t.group_id, t.user_id), index('group_members_user_idx').on(t.user_id)],
);

/** A grant on a workspace for a user or a group. The workspace's `user_id` is always its primary OWNER. */
export const workspaceMembers = sqliteTable(
  'workspace_members',
  {
    id: text('id').primaryKey(),
    workspace_id: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    subject_type: text('subject_type', { enum: MEMBER_SUBJECT_TYPES }).notNull(),
    /** users.id or groups.id (polymorphic — cleaned up by the services when the subject is deleted). */
    subject_id: text('subject_id').notNull(),
    role: text('role', { enum: WORKSPACE_ROLES }).notNull().default('VIEWER'),
    added_by: text('added_by').references(() => users.id, { onDelete: 'set null' }),
    created_at: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [uniqueIndex('workspace_members_subject_idx').on(t.workspace_id, t.subject_type, t.subject_id), index('workspace_members_lookup_idx').on(t.subject_type, t.subject_id)],
);

export type User = typeof users.$inferSelect;
export type Workspace = typeof workspaces.$inferSelect;
export type Group = typeof groups.$inferSelect;
export type GroupMember = typeof groupMembers.$inferSelect;
export type WorkspaceMember = typeof workspaceMembers.$inferSelect;
export type SessionTab = typeof sessionTabs.$inferSelect;
export type DataConnection = typeof dataConnections.$inferSelect;
export type ApiToken = typeof apiTokens.$inferSelect;
export type AuditLog = typeof auditLogs.$inferSelect;

// ---------------------------------------------------------------------------
// BI, cloud storage and copilot models
// ---------------------------------------------------------------------------

export const WIDGET_TYPES = ['KPI', 'CHART', 'TABLE', 'MARKDOWN'] as const;
/** grid: widget grid (Chart.js); mosaic: a declarative Mosaic spec rendered with cross-filtering. */
export const DASHBOARD_KINDS = ['grid', 'mosaic'] as const;
export type DashboardKind = (typeof DASHBOARD_KINDS)[number];
export const CLOUD_PROVIDERS = ['S3', 'R2', 'GCS', 'AZURE'] as const;
export const LAKEHOUSE_PROVIDERS = ['AWS_GLUE', 'AWS_S3_TABLES', 'ICEBERG_REST', 'DATABRICKS'] as const;
export const LAKEHOUSE_STATUSES = ['unknown', 'ok', 'error'] as const;
export const AGENT_FRAMEWORKS = ['strands', 'langgraph', 'langchain', 'crewai', 'agentcore_runtime', 'agentcore_gateway', 'bedrock_agent', 'custom'] as const;
export const CHAT_ROLES = ['user', 'assistant', 'system'] as const;
export type WidgetType = (typeof WIDGET_TYPES)[number];
export type CloudProvider = (typeof CLOUD_PROVIDERS)[number];
export type LakehouseProvider = (typeof LAKEHOUSE_PROVIDERS)[number];
export type LakehouseStatus = (typeof LAKEHOUSE_STATUSES)[number];
export type AgentFramework = (typeof AGENT_FRAMEWORKS)[number];

/** Per-agent settings; the AWS fields let DuckView invoke the agent (Copilot "ask my agent", test button). */
export interface AgentConfig {
  region?: string;
  /** Bedrock Agents (Classic) */
  agent_id?: string;
  agent_alias_id?: string;
  /** AgentCore Runtime */
  runtime_arn?: string;
  qualifier?: string;
  /** AgentCore Gateway (informational) */
  gateway_url?: string;
  notes?: string;
}

/** Non-secret connection settings; which keys apply depends on the provider (see services/lakehouse.ts). */
export interface LakehouseConfig {
  /** AWS Glue / SageMaker Lakehouse / S3 Tables */
  region?: string;
  account_id?: string;
  /** Glue sub-catalog (e.g. "s3tablescatalog/my-table-bucket" or a federated catalog id). Empty = the account's default catalog. */
  catalog?: string;
  table_bucket_arn?: string;
  aws_auth?: 'keys' | 'credential_chain';
  /** Generic Iceberg REST catalog (Polaris, Lakekeeper, Nessie, Snowflake Open Catalog, Unity Catalog IRC …) */
  endpoint?: string;
  warehouse?: string;
  auth?: 'bearer' | 'oauth2' | 'none';
  oauth2_server_uri?: string;
  oauth2_scope?: string;
  nested_namespaces?: boolean;
  /** Databricks */
  host?: string;
  warehouse_id?: string;
  unity_catalog?: string;
  databricks_auth?: 'pat' | 'oauth_m2m';
  /** Attach the Unity Catalog Iceberg REST endpoint so UniForm/Iceberg tables are queryable in DuckDB directly. */
  attach_iceberg?: boolean;
}
export type ChatRole = (typeof CHAT_ROLES)[number];

/** Grid position of a widget (react-grid-layout semantics: 12-column grid). */
export interface LayoutItem {
  i: string; // widget id
  x: number;
  y: number;
  w: number;
  h: number;
  minW?: number;
  minH?: number;
}

export interface WidgetChartConfig {
  chart?: 'bar' | 'line' | 'area' | 'scatter' | 'pie';
  x?: string;
  y?: string[];
  group_by?: string;
  aggregate?: 'sum' | 'avg' | 'min' | 'max' | 'count' | 'none';
  stacked?: boolean;
  /** KPI: column holding the value, optional column holding the comparison value. */
  value?: string;
  compare?: string;
  format?: 'number' | 'currency' | 'percent' | 'compact';
  /** TABLE: page size. */
  page_size?: number;
  /** MARKDOWN: content. */
  markdown?: string;
  colors?: string[];
}

export interface ChatContextSnapshot {
  workspace_id: string;
  tables: { name: string; type: string; columns: { name: string; type: string }[] }[];
  files: string[];
  buckets: string[];
  active_sql: string | null;
  summaries?: Record<string, { column: string; type: string; min: string | null; max: string | null; approx_unique: number | null; null_percentage: number }[]>;
  /** The workspace's catalog notes: descriptions and tags people wrote on tables and columns. */
  notes?: string;
  /** The workspace's dbt projects: models, last run, failures. */
  dbt?: string;
  model?: string;
  provider?: string;
}

export const savedQueries = sqliteTable(
  'saved_queries',
  {
    id: text('id').primaryKey(),
    workspace_id: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    user_id: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    folder: text('folder').notNull().default(''),
    description: text('description'),
    sql_text: text('sql_text').notNull(),
    tags: text('tags', { mode: 'json' }).$type<string[]>().notNull().default([]),
    created_at: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updated_at: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [index('saved_queries_workspace_idx').on(t.workspace_id), index('saved_queries_user_idx').on(t.user_id)],
);

export const dashboards = sqliteTable(
  'dashboards',
  {
    id: text('id').primaryKey(),
    workspace_id: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    user_id: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    layout: text('layout', { mode: 'json' }).$type<LayoutItem[]>().notNull().default([]),
    kind: text('kind', { enum: DASHBOARD_KINDS }).notNull().default('grid'),
    /** Mosaic declarative spec (JSON object) for kind = mosaic; data definitions may reference workspace files/queries. */
    spec: text('spec', { mode: 'json' }).$type<Record<string, unknown> | null>(),
    created_at: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updated_at: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [index('dashboards_workspace_idx').on(t.workspace_id)],
);

export const dashboardWidgets = sqliteTable(
  'dashboard_widgets',
  {
    id: text('id').primaryKey(),
    dashboard_id: text('dashboard_id').notNull().references(() => dashboards.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    widget_type: text('widget_type', { enum: WIDGET_TYPES }).notNull(),
    saved_query_id: text('saved_query_id').references(() => savedQueries.id, { onDelete: 'set null' }),
    custom_sql: text('custom_sql'),
    chart_config: text('chart_config', { mode: 'json' }).$type<WidgetChartConfig>().notNull().default({}),
    refresh_interval_sec: integer('refresh_interval_sec').notNull().default(0),
    order_index: integer('order_index').notNull().default(0),
    created_at: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updated_at: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [index('dashboard_widgets_dashboard_idx').on(t.dashboard_id)],
);

export const cloudConnections = sqliteTable(
  'cloud_connections',
  {
    id: text('id').primaryKey(),
    user_id: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    provider: text('provider', { enum: CLOUD_PROVIDERS }).notNull(),
    endpoint_url: text('endpoint_url'),
    region: text('region'),
    bucket: text('bucket'),
    encrypted_credentials: text('encrypted_credentials').notNull(),
    iv: text('iv').notNull(),
    tag: text('tag').notNull(),
    created_at: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updated_at: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [index('cloud_connections_user_idx').on(t.user_id)],
);

export const lakehouseConnections = sqliteTable(
  'lakehouse_connections',
  {
    id: text('id').primaryKey(),
    user_id: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    provider: text('provider', { enum: LAKEHOUSE_PROVIDERS }).notNull(),
    /** DuckDB catalog alias the lakehouse is attached as (query as alias.schema.table). */
    alias: text('alias').notNull(),
    config: text('config', { mode: 'json' }).$type<LakehouseConfig>().notNull().default({}),
    encrypted_credentials: text('encrypted_credentials').notNull(),
    iv: text('iv').notNull(),
    tag: text('tag').notNull(),
    status: text('status', { enum: LAKEHOUSE_STATUSES }).notNull().default('unknown'),
    last_error: text('last_error'),
    last_tested_at: integer('last_tested_at', { mode: 'timestamp_ms' }),
    created_at: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updated_at: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [index('lakehouse_connections_user_idx').on(t.user_id), uniqueIndex('lakehouse_connections_alias_idx').on(t.user_id, t.alias)],
);

export const agents = sqliteTable(
  'agents',
  {
    id: text('id').primaryKey(),
    user_id: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    framework: text('framework', { enum: AGENT_FRAMEWORKS }).notNull(),
    description: text('description'),
    /** Default workspace for the agent's tool calls (also the token's workspace scope). */
    workspace_id: text('workspace_id').references(() => workspaces.id, { onDelete: 'set null' }),
    /** The API token minted for this agent; revoking it disables the agent. */
    token_id: text('token_id').references(() => apiTokens.id, { onDelete: 'set null' }),
    allow_mutations: integer('allow_mutations', { mode: 'boolean' }).notNull().default(false),
    config: text('config', { mode: 'json' }).$type<AgentConfig>().notNull().default({}),
    call_count: integer('call_count').notNull().default(0),
    error_count: integer('error_count').notNull().default(0),
    last_seen_at: integer('last_seen_at', { mode: 'timestamp_ms' }),
    created_at: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updated_at: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [index('agents_user_idx').on(t.user_id), index('agents_token_idx').on(t.token_id)],
);

export const chatHistory = sqliteTable(
  'chat_history',
  {
    id: text('id').primaryKey(),
    workspace_id: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    user_id: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    conversation_id: text('conversation_id').notNull(),
    role: text('role', { enum: CHAT_ROLES }).notNull(),
    content: text('content').notNull(),
    context_snapshot: text('context_snapshot', { mode: 'json' }).$type<ChatContextSnapshot | null>(),
    timestamp: integer('timestamp', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [index('chat_history_conversation_idx').on(t.conversation_id), index('chat_history_workspace_idx').on(t.workspace_id)],
);

/** Server-managed DuckCopilot provider, set from Settings by an administrator (overrides copilot.* in the config file). */
export const copilotSettings = sqliteTable('copilot_settings', {
  id: text('id').primaryKey(), // always 'default'
  provider: text('provider').notNull(),
  model: text('model'),
  base_url: text('base_url'),
  /** AES-256-GCM (CredentialCipher); null for providers without a key. */
  encrypted_api_key: text('encrypted_api_key'),
  iv: text('iv'),
  tag: text('tag'),
  /** Last four characters of the key, so the UI can show which key is on file. */
  key_hint: text('key_hint'),
  aws_region: text('aws_region'),
  bedrock_agent_id: text('bedrock_agent_id'),
  bedrock_agent_alias_id: text('bedrock_agent_alias_id'),
  agentcore_runtime_arn: text('agentcore_runtime_arn'),
  /** Deployment-wide override of copilot.allow_byok; null keeps the configured value. */
  allow_byok: integer('allow_byok', { mode: 'boolean' }),
  updated_by: text('updated_by').references(() => users.id, { onDelete: 'set null' }),
  updated_at: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

export const COPILOT_USAGE_STATUSES = ['ok', 'error', 'cancelled'] as const;

// ---- Data connections page: databases, scheduled syncs

export const DATABASE_ENGINES = ['postgres', 'mysql', 'sqlite', 'duckdb'] as const;
export type DatabaseEngine = (typeof DATABASE_ENGINES)[number];
export interface DatabaseConfig {
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  /** Postgres/MySQL: sslmode / ssl on. */
  ssl?: boolean;
  /** sqlite / duckdb: path of the database file (jailed like every other path). */
  path?: string;
  /** Attach read-only (default true — a source is not something to write into by accident). */
  read_only?: boolean;
}

/** An external database attached to every engine of the owner's workspaces as `alias.schema.table`. */
export const databaseConnections = sqliteTable(
  'database_connections',
  {
    id: text('id').primaryKey(),
    user_id: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    engine: text('engine', { enum: DATABASE_ENGINES }).notNull(),
    alias: text('alias').notNull(),
    config: text('config', { mode: 'json' }).$type<DatabaseConfig>().notNull().default({}),
    /** AES-256-GCM: { password } (empty for file databases). */
    encrypted_credentials: text('encrypted_credentials').notNull(),
    iv: text('iv').notNull(),
    tag: text('tag').notNull(),
    status: text('status', { enum: LAKEHOUSE_STATUSES }).notNull().default('unknown'),
    last_error: text('last_error'),
    last_tested_at: integer('last_tested_at', { mode: 'timestamp_ms' }),
    created_at: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updated_at: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [index('database_connections_user_idx').on(t.user_id), uniqueIndex('database_connections_alias_idx').on(t.user_id, t.alias)],
);

/** A SaaS / warehouse / Google connection handled by a connector module (services/connectors). */
export const connectorConnections = sqliteTable(
  'connector_connections',
  {
    id: text('id').primaryKey(),
    user_id: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    connector: text('connector').notNull(),
    name: text('name').notNull(),
    /** Non-secret settings (account, region, instance URL, property id …). */
    config: text('config', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
    /** AES-256-GCM JSON: secret fields, or OAuth tokens { refresh_token, access_token, expires_at, email }. */
    encrypted_credentials: text('encrypted_credentials').notNull(),
    iv: text('iv').notNull(),
    tag: text('tag').notNull(),
    /** For OAuth connections: the account that authorised it. */
    account_label: text('account_label'),
    status: text('status', { enum: LAKEHOUSE_STATUSES }).notNull().default('unknown'),
    last_error: text('last_error'),
    last_tested_at: integer('last_tested_at', { mode: 'timestamp_ms' }),
    created_at: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updated_at: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [index('connector_connections_user_idx').on(t.user_id)],
);

export const APP_KINDS = ['streamlit', 'dash', 'gradio'] as const;
export type AppKind = (typeof APP_KINDS)[number];
export const APP_STATUSES = ['stopped', 'installing', 'starting', 'running', 'error'] as const;
export type AppStatus = (typeof APP_STATUSES)[number];
export const APP_VISIBILITIES = ['workspace', 'org'] as const;
export type AppVisibility = (typeof APP_VISIBILITIES)[number];
/** Publishing to everyone ("org") can wait for an administrator: none → pending → approved | rejected. */
export const APP_EXECUTIONS = ['server', 'browser'] as const;
export type AppExecution = (typeof APP_EXECUTIONS)[number];
export const APP_PUBLISH_STATUSES = ['none', 'pending', 'approved', 'rejected'] as const;
export type AppPublishStatus = (typeof APP_PUBLISH_STATUSES)[number];
/** Source files of an app by relative path (app.py, requirements.txt, helpers …). */
export type AppFiles = Record<string, string>;

/**
 * Data apps: Streamlit applications built on a workspace's data. The source lives here (materialised to disk when
 * the app runs); the runner records the process state so the gallery and the proxy know what is up.
 */
export const dataApps = sqliteTable(
  'data_apps',
  {
    id: text('id').primaryKey(),
    workspace_id: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    user_id: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    kind: text('kind', { enum: APP_KINDS }).notNull().default('streamlit'),
    entry: text('entry').notNull().default('app.py'),
    files: text('files', { mode: 'json' }).$type<AppFiles>().notNull().default({}),
    /** How the app was generated (a dashboard id, saved queries, a Copilot prompt) — informational. */
    spec: text('spec', { mode: 'json' }).$type<Record<string, unknown> | null>(),
    visibility: text('visibility', { enum: APP_VISIBILITIES }).notNull().default('workspace'),
    status: text('status', { enum: APP_STATUSES }).notNull().default('stopped'),
    /** Where the Python runs: on the server (a runtime process) or in the viewer's browser (stlite / Pyodide). */
    execution: text('execution', { enum: APP_EXECUTIONS }).notNull().default('server'),
    /** Kept running: started at boot, never stopped for idleness, restarted after a crash. */
    always_on: integer('always_on', { mode: 'boolean' }).notNull().default(false),
    /** The runtime that last ran the app (subprocess, docker, kubernetes). */
    runtime: text('runtime'),
    publish_status: text('publish_status', { enum: APP_PUBLISH_STATUSES }).notNull().default('none'),
    publish_requested_by: text('publish_requested_by'),
    publish_requested_at: integer('publish_requested_at', { mode: 'timestamp_ms' }),
    publish_reviewed_by: text('publish_reviewed_by'),
    publish_reviewed_at: integer('publish_reviewed_at', { mode: 'timestamp_ms' }),
    publish_note: text('publish_note'),
    port: integer('port'),
    pid: integer('pid'),
    last_error: text('last_error'),
    last_started_at: integer('last_started_at', { mode: 'timestamp_ms' }),
    last_used_at: integer('last_used_at', { mode: 'timestamp_ms' }),
    created_at: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updated_at: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [index('data_apps_workspace_idx').on(t.workspace_id)],
);

export const CHANNEL_TYPES = ['slack', 'teams', 'email', 'pagerduty', 'webhook'] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];
export const DELIVERY_STATUSES = ['ok', 'error'] as const;

/** Where alerts and scheduled snapshots are delivered: a workspace's channel, or an org-wide one (workspace_id null). */
export const notificationChannels = sqliteTable(
  'notification_channels',
  {
    id: text('id').primaryKey(),
    workspace_id: text('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    type: text('type', { enum: CHANNEL_TYPES }).notNull(),
    /** Non-secret settings: email recipients, PagerDuty severity mapping, a masked hint of the URL. */
    config: text('config', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
    /** AES-256-GCM JSON: { url } for Slack / Teams / webhooks, { routing_key } for PagerDuty, { signing_secret } for webhooks. */
    encrypted_secret: text('encrypted_secret'),
    iv: text('iv'),
    tag: text('tag'),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    created_by: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    last_status: text('last_status', { enum: DELIVERY_STATUSES }),
    last_error: text('last_error'),
    last_sent_at: integer('last_sent_at', { mode: 'timestamp_ms' }),
    created_at: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updated_at: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [index('notification_channels_workspace_idx').on(t.workspace_id)],
);

/** One attempt to deliver a notification (kept for the channel's history). */
export const notificationDeliveries = sqliteTable(
  'notification_deliveries',
  {
    id: text('id').primaryKey(),
    channel_id: text('channel_id').notNull().references(() => notificationChannels.id, { onDelete: 'cascade' }),
    /** test · alert:<id> · snapshot:<id> */
    source: text('source').notNull(),
    title: text('title').notNull(),
    status: text('status', { enum: DELIVERY_STATUSES }).notNull(),
    error: text('error'),
    attempts: integer('attempts').notNull().default(1),
    duration_ms: integer('duration_ms'),
    created_at: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [index('notification_deliveries_channel_idx').on(t.channel_id, t.created_at)],
);

export const ALERT_STATES = ['unknown', 'ok', 'triggered', 'error'] as const;
export type AlertState = (typeof ALERT_STATES)[number];
export const ALERT_SEVERITIES = ['info', 'warning', 'critical'] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];
/** rows: the query returns rows · no_rows: it returns none · threshold: a column of the first row compared with a value */
export type AlertCondition = { kind: 'rows' } | { kind: 'no_rows' } | { kind: 'threshold'; column: string; op: '>' | '>=' | '<' | '<=' | '=' | '!='; value: number };

/** A query checked on a schedule; state changes are delivered to notification channels. */
export const alerts = sqliteTable(
  'alerts',
  {
    id: text('id').primaryKey(),
    workspace_id: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    /** The alert runs as this user, read-only. */
    user_id: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    sql: text('sql').notNull(),
    condition: text('condition', { mode: 'json' }).$type<AlertCondition>().notNull(),
    schedule: text('schedule', { mode: 'json' }).$type<SyncSchedule>().notNull(),
    channel_ids: text('channel_ids', { mode: 'json' }).$type<string[]>().notNull().default([]),
    severity: text('severity', { enum: ALERT_SEVERITIES }).notNull().default('warning'),
    /** change: when the state changes (and when it clears) · always: on every triggered check */
    notify: text('notify', { enum: ['change', 'always'] }).notNull().default('change'),
    notify_resolved: integer('notify_resolved', { mode: 'boolean' }).notNull().default(true),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    state: text('state', { enum: ALERT_STATES }).notNull().default('unknown'),
    last_value: text('last_value'),
    last_error: text('last_error'),
    last_checked_at: integer('last_checked_at', { mode: 'timestamp_ms' }),
    last_triggered_at: integer('last_triggered_at', { mode: 'timestamp_ms' }),
    next_run_at: integer('next_run_at', { mode: 'timestamp_ms' }),
    created_at: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updated_at: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [index('alerts_workspace_idx').on(t.workspace_id), index('alerts_next_run_idx').on(t.next_run_at)],
);

/** Each check of an alert: its state, the value it saw, and how many channels were told. */
export const alertEvents = sqliteTable(
  'alert_events',
  {
    id: text('id').primaryKey(),
    alert_id: text('alert_id').notNull().references(() => alerts.id, { onDelete: 'cascade' }),
    state: text('state', { enum: ALERT_STATES }).notNull(),
    value: text('value'),
    message: text('message'),
    notified: integer('notified').notNull().default(0),
    triggered_by: text('triggered_by').notNull().default('schedule'),
    created_at: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [index('alert_events_alert_idx').on(t.alert_id, t.created_at)],
);

export type SnapshotTarget = { kind: 'dashboard'; dashboard_id: string } | { kind: 'app'; app_id: string };
export const SNAPSHOT_FORMATS = ['png', 'pdf'] as const;
export type SnapshotFormat = (typeof SNAPSHOT_FORMATS)[number];

/** A dashboard or data app rendered on a schedule (PNG or PDF) and delivered to notification channels. */
export const snapshots = sqliteTable(
  'snapshots',
  {
    id: text('id').primaryKey(),
    workspace_id: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    /** Rendered as this user (what they can see). */
    user_id: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    target: text('target', { mode: 'json' }).$type<SnapshotTarget>().notNull(),
    format: text('format', { enum: SNAPSHOT_FORMATS }).notNull().default('png'),
    width: integer('width').notNull().default(1280),
    schedule: text('schedule', { mode: 'json' }).$type<SyncSchedule>().notNull(),
    channel_ids: text('channel_ids', { mode: 'json' }).$type<string[]>().notNull().default([]),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    last_status: text('last_status', { enum: DELIVERY_STATUSES }),
    last_error: text('last_error'),
    last_run_at: integer('last_run_at', { mode: 'timestamp_ms' }),
    next_run_at: integer('next_run_at', { mode: 'timestamp_ms' }),
    created_at: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updated_at: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [index('snapshots_workspace_idx').on(t.workspace_id), index('snapshots_next_run_idx').on(t.next_run_at)],
);

/** One rendering: the file it produced (under <data>/.duckview/snapshots) and how many channels got it. */
export const snapshotRuns = sqliteTable(
  'snapshot_runs',
  {
    id: text('id').primaryKey(),
    snapshot_id: text('snapshot_id').notNull().references(() => snapshots.id, { onDelete: 'cascade' }),
    status: text('status', { enum: DELIVERY_STATUSES }).notNull(),
    error: text('error'),
    format: text('format', { enum: SNAPSHOT_FORMATS }).notNull(),
    file: text('file'),
    bytes: integer('bytes'),
    delivered: integer('delivered').notNull().default(0),
    triggered_by: text('triggered_by').notNull().default('schedule'),
    duration_ms: integer('duration_ms'),
    created_at: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [index('snapshot_runs_snapshot_idx').on(t.snapshot_id, t.created_at)],
);

export const MASK_KINDS = ['null', 'redact', 'hash', 'partial', 'expression'] as const;
export type MaskKind = (typeof MASK_KINDS)[number];
export type ColumnMask = { kind: Exclude<MaskKind, 'expression'> } | { kind: 'expression'; sql: string };
/** Who a policy restricts: workspace roles, users, teams — or everyone but the workspace's owners. */
export interface PolicySubjects {
  all?: boolean;
  roles?: ('VIEWER' | 'EDITOR')[];
  users?: string[];
  groups?: string[];
}

/**
 * Row- and column-level security on a table (or view) of a workspace: people it applies to read it through a
 * filtered, masked subquery. Owners of the workspace are never restricted.
 */
export const accessPolicies = sqliteTable(
  'access_policies',
  {
    id: text('id').primaryKey(),
    workspace_id: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    /** The table as queries name it: "orders", "sales.orders" or "db.sales.orders". */
    table_name: text('table_name').notNull(),
    /** A SQL predicate with {{user.email}}, {{user.id}}, {{user.role}}, {{user.groups}} placeholders; null: all rows. */
    row_filter: text('row_filter'),
    column_masks: text('column_masks', { mode: 'json' }).$type<Record<string, ColumnMask>>().notNull().default({}),
    applies_to: text('applies_to', { mode: 'json' }).$type<PolicySubjects>().notNull().default({ roles: ['VIEWER'] }),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    created_by: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    created_at: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updated_at: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [index('access_policies_workspace_idx').on(t.workspace_id)],
);

/** What people know about a table (column null) or a column of a workspace: a description and tags (pii, …). */
export const catalogAnnotations = sqliteTable(
  'catalog_annotations',
  {
    id: text('id').primaryKey(),
    workspace_id: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    /** As queries name it: "orders" or "sales.orders". */
    object_name: text('object_name').notNull(),
    column_name: text('column_name'),
    description: text('description'),
    tags: text('tags', { mode: 'json' }).$type<string[]>().notNull().default([]),
    updated_by: text('updated_by').references(() => users.id, { onDelete: 'set null' }),
    updated_at: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [index('catalog_annotations_workspace_idx').on(t.workspace_id, t.object_name)],
);

export const AUDIT_SINK_TYPES = ['splunk', 'datadog', 'elastic', 'webhook', 's3'] as const;
export type AuditSinkType = (typeof AUDIT_SINK_TYPES)[number];

/** Where the audit log is streamed (administrators): a SIEM or a bucket. Exported in order, at least once. */
export const auditSinks = sqliteTable('audit_sinks', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  type: text('type', { enum: AUDIT_SINK_TYPES }).notNull(),
  /** url, index / source / sourcetype, Datadog site and tags, cloud connection + bucket + prefix, include_sql. */
  config: text('config', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
  /** AES-256-GCM JSON: { token } (Splunk HEC), { api_key } (Datadog), { api_key | username + password } (Elastic), { signing_secret } (webhook). */
  encrypted_secret: text('encrypted_secret'),
  iv: text('iv'),
  tag: text('tag'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  /** The last exported event: (timestamp, id). Null: from the sink's creation on. */
  cursor_at: integer('cursor_at', { mode: 'timestamp_ms' }),
  cursor_id: text('cursor_id'),
  exported: integer('exported').notNull().default(0),
  last_status: text('last_status', { enum: DELIVERY_STATUSES }),
  last_error: text('last_error'),
  last_exported_at: integer('last_exported_at', { mode: 'timestamp_ms' }),
  retry_after: integer('retry_after', { mode: 'timestamp_ms' }),
  failures: integer('failures').notNull().default(0),
  created_by: text('created_by').references(() => users.id, { onDelete: 'set null' }),
  created_at: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updated_at: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

/** Platform-wide settings set from the console (e.g. the Google OAuth client), secrets encrypted. */
export const appSettings = sqliteTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
  encrypted_value: text('encrypted_value'),
  iv: text('iv'),
  tag: text('tag'),
  updated_by: text('updated_by'),
  updated_at: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

/** Where a sync reads from. */
export type SyncSource =
  | { kind: 'sql'; sql: string }
  | { kind: 'connector'; connection_id: string; resource: Record<string, unknown> }
  | { kind: 'table'; database_connection_id?: string | null; lakehouse_connection_id?: string | null; catalog?: string | null; schema: string; table: string }
  | { kind: 'url'; url: string; format: 'auto' | 'csv' | 'json' | 'parquet' | 'excel'; options?: Record<string, string | number | boolean>; connection_id?: string | null };
export type SyncSchedule = { kind: 'manual' } | { kind: 'interval'; minutes: number } | { kind: 'cron'; expression: string; timezone?: string };
export const SYNC_MODES = ['replace', 'append'] as const;
export type SyncMode = (typeof SYNC_MODES)[number];
export const SYNC_RUN_STATUSES = ['running', 'ok', 'error'] as const;
export interface SyncLastRun {
  run_id: string;
  status: (typeof SYNC_RUN_STATUSES)[number];
  started_at: string;
  finished_at: string | null;
  rows: number | null;
  duration_ms: number | null;
  error: string | null;
}

/** dbt: what a run does, and a node's outcome in it (dbt's own status names). */
export const DBT_COMMANDS = ['build', 'run', 'test', 'seed', 'compile'] as const;
export type DbtCommand = (typeof DBT_COMMANDS)[number];
export const DBT_RUN_STATUSES = ['running', 'ok', 'error'] as const;
export type DbtSchedule = { kind: 'manual' } | { kind: 'interval'; minutes: number } | { kind: 'cron'; expression: string; timezone?: string };
export interface DbtScheduledCommand { command: DbtCommand; select?: string | null; exclude?: string | null; full_refresh?: boolean }
export interface DbtNodeResult {
  unique_id: string;
  name: string;
  resource_type: 'model' | 'seed' | 'test' | 'snapshot' | 'analysis' | 'operation';
  /** model / seed: success · error · skipped; test: pass · warn · fail · error · skipped; compile: compiled. */
  status: 'success' | 'error' | 'skipped' | 'pass' | 'warn' | 'fail' | 'compiled';
  materialized: string | null;
  relation: string | null;
  rows: number | null;
  /** Tests: failing rows. */
  failures: number | null;
  duration_ms: number;
  message: string | null;
  sql: string | null;
  depends_on: string[];
}
export interface DbtLastRun { run_id: string; status: (typeof DBT_RUN_STATUSES)[number]; command: DbtCommand; started_at: string; finished_at: string | null; summary: string | null }

/** A scheduled load of a source into a table of a workspace, with an optional transformation step. */
export const dataSyncs = sqliteTable(
  'data_syncs',
  {
    id: text('id').primaryKey(),
    workspace_id: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    user_id: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    source: text('source', { mode: 'json' }).$type<SyncSource>().notNull(),
    target_schema: text('target_schema').notNull().default('main'),
    target_table: text('target_table').notNull(),
    mode: text('mode', { enum: SYNC_MODES }).notNull().default('replace'),
    /** A SELECT over `{{raw}}` (the freshly loaded rows) whose result becomes the target table; null = load as is. */
    transform_sql: text('transform_sql'),
    schedule: text('schedule', { mode: 'json' }).$type<SyncSchedule>().notNull().default({ kind: 'manual' }),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    last_run: text('last_run', { mode: 'json' }).$type<SyncLastRun | null>(),
    next_run_at: integer('next_run_at', { mode: 'timestamp_ms' }),
    created_by: text('created_by'),
    created_at: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updated_at: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [index('data_syncs_workspace_idx').on(t.workspace_id), index('data_syncs_next_run_idx').on(t.next_run_at)],
);

export const dataSyncRuns = sqliteTable(
  'data_sync_runs',
  {
    id: text('id').primaryKey(),
    sync_id: text('sync_id').notNull().references(() => dataSyncs.id, { onDelete: 'cascade' }),
    workspace_id: text('workspace_id').notNull(),
    status: text('status', { enum: SYNC_RUN_STATUSES }).notNull(),
    triggered_by: text('triggered_by').notNull(), // schedule | manual | agent
    actor_id: text('actor_id'),
    rows: integer('rows'),
    duration_ms: integer('duration_ms'),
    error: text('error'),
    started_at: integer('started_at', { mode: 'timestamp_ms' }).notNull(),
    finished_at: integer('finished_at', { mode: 'timestamp_ms' }),
  },
  (t) => [index('data_sync_runs_sync_idx').on(t.sync_id, t.started_at)],
);

/** One row per DuckCopilot turn: who, where, which model, how many tokens. */
export const copilotUsage = sqliteTable(
  'copilot_usage',
  {
    id: text('id').primaryKey(),
    user_id: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    workspace_id: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    conversation_id: text('conversation_id').notNull(),
    message_id: text('message_id').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    action: text('action').notNull(),
    /** Key source: the server-managed one or the user's own. */
    byok: integer('byok', { mode: 'boolean' }).notNull().default(false),
    input_tokens: integer('input_tokens'),
    output_tokens: integer('output_tokens'),
    duration_ms: integer('duration_ms').notNull(),
    status: text('status', { enum: COPILOT_USAGE_STATUSES }).notNull(),
    created_at: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [index('copilot_usage_user_idx').on(t.user_id), index('copilot_usage_created_idx').on(t.created_at), index('copilot_usage_conversation_idx').on(t.conversation_id)],
);

export type SavedQuery = typeof savedQueries.$inferSelect;
export type Dashboard = typeof dashboards.$inferSelect;
export type DashboardWidget = typeof dashboardWidgets.$inferSelect;
export type CloudConnection = typeof cloudConnections.$inferSelect;
export type LakehouseConnection = typeof lakehouseConnections.$inferSelect;
export type Agent = typeof agents.$inferSelect;
export type ChatMessage = typeof chatHistory.$inferSelect;
export type CopilotSettingsRow = typeof copilotSettings.$inferSelect;
export type DatabaseConnection = typeof databaseConnections.$inferSelect;
export type ConnectorConnection = typeof connectorConnections.$inferSelect;
export type DataApp = typeof dataApps.$inferSelect;
export type AppSetting = typeof appSettings.$inferSelect;
export type DataSync = typeof dataSyncs.$inferSelect;
export type DataSyncRun = typeof dataSyncRuns.$inferSelect;
export type CopilotUsageRow = typeof copilotUsage.$inferSelect;
export type NotificationChannel = typeof notificationChannels.$inferSelect;
export type NotificationDelivery = typeof notificationDeliveries.$inferSelect;
export type Alert = typeof alerts.$inferSelect;
export type AlertEvent = typeof alertEvents.$inferSelect;
export type Snapshot = typeof snapshots.$inferSelect;
export type SnapshotRun = typeof snapshotRuns.$inferSelect;
export type AccessPolicy = typeof accessPolicies.$inferSelect;
export type CatalogAnnotation = typeof catalogAnnotations.$inferSelect;
export type AuditSink = typeof auditSinks.$inferSelect;

/** A dbt project of a workspace: its files (models, tests, seeds, macros, YAML) and how it is scheduled. */
export const dbtProjects = sqliteTable(
  'dbt_projects',
  {
    id: text('id').primaryKey(),
    workspace_id: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    user_id: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    files: text('files', { mode: 'json' }).$type<Record<string, string>>().notNull(),
    /** --vars passed to dbt. */
    vars: text('vars', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
    /** The schema models without a custom schema are built in (dbt's target schema). */
    target_schema: text('target_schema').notNull().default('main'),
    schedule: text('schedule', { mode: 'json' }).$type<DbtSchedule>().notNull().default({ kind: 'manual' }),
    scheduled: text('scheduled', { mode: 'json' }).$type<DbtScheduledCommand>().notNull().default({ command: 'build' }),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    next_run_at: integer('next_run_at', { mode: 'timestamp_ms' }),
    last_run: text('last_run', { mode: 'json' }).$type<DbtLastRun | null>(),
    created_at: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updated_at: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [index('dbt_projects_workspace_idx').on(t.workspace_id), index('dbt_projects_next_run_idx').on(t.next_run_at)],
);

export const dbtRuns = sqliteTable(
  'dbt_runs',
  {
    id: text('id').primaryKey(),
    project_id: text('project_id').notNull().references(() => dbtProjects.id, { onDelete: 'cascade' }),
    workspace_id: text('workspace_id').notNull(),
    user_id: text('user_id'),
    command: text('command', { enum: DBT_COMMANDS }).notNull(),
    select: text('select'),
    exclude: text('exclude'),
    full_refresh: integer('full_refresh', { mode: 'boolean' }).notNull().default(false),
    triggered_by: text('triggered_by').notNull(), // manual | schedule | agent
    status: text('status', { enum: DBT_RUN_STATUSES }).notNull(),
    summary: text('summary'),
    error: text('error'),
    log: text('log'),
    results: text('results', { mode: 'json' }).$type<DbtNodeResult[]>().notNull().default([]),
    duration_ms: integer('duration_ms'),
    started_at: integer('started_at', { mode: 'timestamp_ms' }).notNull(),
    finished_at: integer('finished_at', { mode: 'timestamp_ms' }),
  },
  (t) => [index('dbt_runs_project_idx').on(t.project_id, t.started_at)],
);
export type DbtProject = typeof dbtProjects.$inferSelect;
export type DbtRun = typeof dbtRuns.$inferSelect;
