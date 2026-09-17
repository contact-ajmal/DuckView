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

export type UserRole = (typeof USER_ROLES)[number];
export type AuthProvider = (typeof AUTH_PROVIDERS)[number];
export type ConnectionType = (typeof CONNECTION_TYPES)[number];
export type TokenScope = (typeof TOKEN_SCOPES)[number];
export type ActorType = (typeof ACTOR_TYPES)[number];

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
    title: text('title').notNull(),
    sql_content: text('sql_content').notNull().default(''),
    chart_config: text('chart_config', { mode: 'json' }).$type<ChartConfig>().notNull().default({ type: 'none' }),
    order_index: integer('order_index').notNull().default(0),
    cursor_position: integer('cursor_position').notNull().default(0),
    updated_at: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [index('session_tabs_workspace_idx').on(t.workspace_id)],
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

export type User = typeof users.$inferSelect;
export type Workspace = typeof workspaces.$inferSelect;
export type SessionTab = typeof sessionTabs.$inferSelect;
export type DataConnection = typeof dataConnections.$inferSelect;
export type ApiToken = typeof apiTokens.$inferSelect;
export type AuditLog = typeof auditLogs.$inferSelect;

// ---------------------------------------------------------------------------
// BI, cloud storage and copilot models
// ---------------------------------------------------------------------------

export const WIDGET_TYPES = ['KPI', 'CHART', 'TABLE', 'MARKDOWN'] as const;
export const CLOUD_PROVIDERS = ['S3', 'R2', 'GCS', 'AZURE'] as const;
export const CHAT_ROLES = ['user', 'assistant', 'system'] as const;
export type WidgetType = (typeof WIDGET_TYPES)[number];
export type CloudProvider = (typeof CLOUD_PROVIDERS)[number];
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
export type ChatMessage = typeof chatHistory.$inferSelect;
