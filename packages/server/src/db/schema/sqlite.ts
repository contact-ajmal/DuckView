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
    created_at: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [uniqueIndex('users_email_idx').on(t.email)],
);

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

export type SavedQuery = typeof savedQueries.$inferSelect;
export type Dashboard = typeof dashboards.$inferSelect;
export type DashboardWidget = typeof dashboardWidgets.$inferSelect;
export type CloudConnection = typeof cloudConnections.$inferSelect;
export type LakehouseConnection = typeof lakehouseConnections.$inferSelect;
export type Agent = typeof agents.$inferSelect;
export type ChatMessage = typeof chatHistory.$inferSelect;
