/**
 * Metadata store schema — PostgreSQL dialect (enterprise mode via DATABASE_URL).
 * Mirrors ./sqlite.ts exactly (names, nullability, JSON shapes).
 */
import { pgTable, text, integer, timestamp, jsonb, index, uniqueIndex } from 'drizzle-orm/pg-core';
import type { EngineSettings, ChartConfig, TokenScope, WorkspaceFolder } from './sqlite.js';
import { AUTH_PROVIDERS, USER_ROLES, CONNECTION_TYPES, ACTOR_TYPES } from './sqlite.js';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const users = pgTable(
  'users',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    password_hash: text('password_hash'),
    auth_provider: text('auth_provider', { enum: AUTH_PROVIDERS }).notNull().default('local'),
    role: text('role', { enum: USER_ROLES }).notNull().default('USER'),
    display_name: text('display_name'),
    external_id: text('external_id'),
    created_at: ts('created_at').notNull(),
  },
  (t) => [uniqueIndex('users_email_idx').on(t.email)],
);

export const workspaces = pgTable(
  'workspaces',
  {
    id: text('id').primaryKey(),
    user_id: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    active_db_path: text('active_db_path').notNull().default(':memory:'),
    engine_settings: jsonb('engine_settings').$type<EngineSettings>().notNull().default({}),
    folders: jsonb('folders').$type<WorkspaceFolder[]>().notNull().default([]),
    created_at: ts('created_at').notNull(),
    updated_at: ts('updated_at').notNull(),
  },
  (t) => [index('workspaces_user_idx').on(t.user_id)],
);

export const sessionTabs = pgTable(
  'session_tabs',
  {
    id: text('id').primaryKey(),
    workspace_id: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    sql_content: text('sql_content').notNull().default(''),
    chart_config: jsonb('chart_config').$type<ChartConfig>().notNull().default({ type: 'none' }),
    order_index: integer('order_index').notNull().default(0),
    cursor_position: integer('cursor_position').notNull().default(0),
    updated_at: ts('updated_at').notNull(),
  },
  (t) => [index('session_tabs_workspace_idx').on(t.workspace_id)],
);

export const dataConnections = pgTable(
  'data_connections',
  {
    id: text('id').primaryKey(),
    user_id: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    type: text('type', { enum: CONNECTION_TYPES }).notNull(),
    encrypted_credentials: text('encrypted_credentials').notNull(),
    iv: text('iv').notNull(),
    tag: text('tag').notNull(),
    created_at: ts('created_at').notNull(),
  },
  (t) => [index('data_connections_user_idx').on(t.user_id)],
);

export const apiTokens = pgTable(
  'api_tokens',
  {
    id: text('id').primaryKey(),
    user_id: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    workspace_id: text('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
    token_hash: text('token_hash').notNull(),
    token_prefix: text('token_prefix').notNull(),
    name: text('name').notNull(),
    scopes: jsonb('scopes').$type<TokenScope[]>().notNull().default(['read']),
    expires_at: ts('expires_at'),
    last_used_at: ts('last_used_at'),
    created_at: ts('created_at').notNull(),
  },
  (t) => [uniqueIndex('api_tokens_hash_idx').on(t.token_hash), index('api_tokens_user_idx').on(t.user_id)],
);

export const auditLogs = pgTable(
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
    timestamp: ts('timestamp').notNull(),
  },
  (t) => [index('audit_logs_ts_idx').on(t.timestamp), index('audit_logs_user_idx').on(t.user_id)],
);

// ---------------------------------------------------------------------------
// BI, cloud storage and copilot models (mirror of sqlite.ts)
// ---------------------------------------------------------------------------
import { WIDGET_TYPES, CLOUD_PROVIDERS, CHAT_ROLES, type LayoutItem, type WidgetChartConfig, type ChatContextSnapshot } from './sqlite.js';

export const savedQueries = pgTable(
  'saved_queries',
  {
    id: text('id').primaryKey(),
    workspace_id: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    user_id: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    folder: text('folder').notNull().default(''),
    description: text('description'),
    sql_text: text('sql_text').notNull(),
    tags: jsonb('tags').$type<string[]>().notNull().default([]),
    created_at: ts('created_at').notNull(),
    updated_at: ts('updated_at').notNull(),
  },
  (t) => [index('saved_queries_workspace_idx').on(t.workspace_id), index('saved_queries_user_idx').on(t.user_id)],
);

export const dashboards = pgTable(
  'dashboards',
  {
    id: text('id').primaryKey(),
    workspace_id: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    user_id: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    layout: jsonb('layout').$type<LayoutItem[]>().notNull().default([]),
    created_at: ts('created_at').notNull(),
    updated_at: ts('updated_at').notNull(),
  },
  (t) => [index('dashboards_workspace_idx').on(t.workspace_id)],
);

export const dashboardWidgets = pgTable(
  'dashboard_widgets',
  {
    id: text('id').primaryKey(),
    dashboard_id: text('dashboard_id').notNull().references(() => dashboards.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    widget_type: text('widget_type', { enum: WIDGET_TYPES }).notNull(),
    saved_query_id: text('saved_query_id').references(() => savedQueries.id, { onDelete: 'set null' }),
    custom_sql: text('custom_sql'),
    chart_config: jsonb('chart_config').$type<WidgetChartConfig>().notNull().default({}),
    refresh_interval_sec: integer('refresh_interval_sec').notNull().default(0),
    order_index: integer('order_index').notNull().default(0),
    created_at: ts('created_at').notNull(),
    updated_at: ts('updated_at').notNull(),
  },
  (t) => [index('dashboard_widgets_dashboard_idx').on(t.dashboard_id)],
);

export const cloudConnections = pgTable(
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
    created_at: ts('created_at').notNull(),
    updated_at: ts('updated_at').notNull(),
  },
  (t) => [index('cloud_connections_user_idx').on(t.user_id)],
);

export const chatHistory = pgTable(
  'chat_history',
  {
    id: text('id').primaryKey(),
    workspace_id: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    user_id: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    conversation_id: text('conversation_id').notNull(),
    role: text('role', { enum: CHAT_ROLES }).notNull(),
    content: text('content').notNull(),
    context_snapshot: jsonb('context_snapshot').$type<ChatContextSnapshot | null>(),
    timestamp: ts('timestamp').notNull(),
  },
  (t) => [index('chat_history_conversation_idx').on(t.conversation_id), index('chat_history_workspace_idx').on(t.workspace_id)],
);
