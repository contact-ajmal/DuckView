/**
 * Metadata store schema — PostgreSQL dialect (enterprise mode via DATABASE_URL).
 * Mirrors ./sqlite.ts exactly (names, nullability, JSON shapes).
 */
import { pgTable, text, integer, timestamp, jsonb, boolean, index, uniqueIndex } from 'drizzle-orm/pg-core';
import type { EngineSettings, ChartConfig, TokenScope, WorkspaceFolder, CloudSyncState } from './sqlite.js';
import { AUTH_PROVIDERS, USER_ROLES, CONNECTION_TYPES, ACTOR_TYPES, WORKSPACE_ROLES, GROUP_MEMBER_ROLES, MEMBER_SUBJECT_TYPES } from './sqlite.js';

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
    /** Deactivated (SCIM active=false or by an admin): no sign-in, no tokens, no scheduled work runs as them. */
    disabled: boolean('disabled').notNull().default(false),
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
    /** Monotonic data epoch: bumped on every mutation, file/folder change and :memory: engine (re)start. Cache keys embed it. */
    data_version: integer('data_version').notNull().default(0),
    cloud_connection_id: text('cloud_connection_id'),
    cloud_sync: jsonb('cloud_sync').$type<CloudSyncState | null>(),
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
    user_id: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    sql_content: text('sql_content').notNull().default(''),
    chart_config: jsonb('chart_config').$type<ChartConfig>().notNull().default({ type: 'none' }),
    order_index: integer('order_index').notNull().default(0),
    cursor_position: integer('cursor_position').notNull().default(0),
    engine: text('engine'),
    updated_at: ts('updated_at').notNull(),
  },
  (t) => [index('session_tabs_workspace_idx').on(t.workspace_id), index('session_tabs_user_idx').on(t.workspace_id, t.user_id)],
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
// Teams and workspace sharing
// ---------------------------------------------------------------------------

export const groups = pgTable(
  'groups',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description'),
    external_id: text('external_id'),
    created_by: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    created_at: ts('created_at').notNull(),
    updated_at: ts('updated_at').notNull(),
  },
  (t) => [uniqueIndex('groups_name_idx').on(t.name), uniqueIndex('groups_external_idx').on(t.external_id)],
);

export const groupMembers = pgTable(
  'group_members',
  {
    group_id: text('group_id').notNull().references(() => groups.id, { onDelete: 'cascade' }),
    user_id: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    role: text('role', { enum: GROUP_MEMBER_ROLES }).notNull().default('MEMBER'),
    added_at: ts('added_at').notNull(),
  },
  (t) => [uniqueIndex('group_members_pk').on(t.group_id, t.user_id), index('group_members_user_idx').on(t.user_id)],
);

export const workspaceMembers = pgTable(
  'workspace_members',
  {
    id: text('id').primaryKey(),
    workspace_id: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    subject_type: text('subject_type', { enum: MEMBER_SUBJECT_TYPES }).notNull(),
    subject_id: text('subject_id').notNull(),
    role: text('role', { enum: WORKSPACE_ROLES }).notNull().default('VIEWER'),
    added_by: text('added_by').references(() => users.id, { onDelete: 'set null' }),
    created_at: ts('created_at').notNull(),
  },
  (t) => [uniqueIndex('workspace_members_subject_idx').on(t.workspace_id, t.subject_type, t.subject_id), index('workspace_members_lookup_idx').on(t.subject_type, t.subject_id)],
);

// ---------------------------------------------------------------------------
// BI, cloud storage and copilot models (mirror of sqlite.ts)
// ---------------------------------------------------------------------------
import { WIDGET_TYPES, DASHBOARD_KINDS, CLOUD_PROVIDERS, CHAT_ROLES, COPILOT_USAGE_STATUSES, DATABASE_ENGINES, SYNC_MODES, SYNC_RUN_STATUSES, LAKEHOUSE_PROVIDERS, LAKEHOUSE_STATUSES, AGENT_FRAMEWORKS, APP_KINDS, APP_STATUSES, APP_VISIBILITIES, APP_PUBLISH_STATUSES, APP_EXECUTIONS, CHANNEL_TYPES, DELIVERY_STATUSES, ALERT_STATES, ALERT_SEVERITIES, SNAPSHOT_FORMATS, AUDIT_SINK_TYPES, type ColumnMask, type PolicySubjects, type AlertCondition, type SnapshotTarget, type AppFiles, type LayoutItem, type WidgetChartConfig, type ChatContextSnapshot, type LakehouseConfig, type AgentConfig, type DatabaseConfig, type SyncSource, type SyncSchedule, type SyncLastRun, DBT_COMMANDS, DBT_RUN_STATUSES, type DbtSchedule, type DbtScheduledCommand, type DbtNodeResult, type DbtLastRun } from './sqlite.js';

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
    kind: text('kind', { enum: DASHBOARD_KINDS }).notNull().default('grid'),
    spec: jsonb('spec').$type<Record<string, unknown> | null>(),
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

export const lakehouseConnections = pgTable(
  'lakehouse_connections',
  {
    id: text('id').primaryKey(),
    user_id: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    provider: text('provider', { enum: LAKEHOUSE_PROVIDERS }).notNull(),
    alias: text('alias').notNull(),
    config: jsonb('config').$type<LakehouseConfig>().notNull().default({}),
    encrypted_credentials: text('encrypted_credentials').notNull(),
    iv: text('iv').notNull(),
    tag: text('tag').notNull(),
    status: text('status', { enum: LAKEHOUSE_STATUSES }).notNull().default('unknown'),
    last_error: text('last_error'),
    last_tested_at: ts('last_tested_at'),
    created_at: ts('created_at').notNull(),
    updated_at: ts('updated_at').notNull(),
  },
  (t) => [index('lakehouse_connections_user_idx').on(t.user_id), uniqueIndex('lakehouse_connections_alias_idx').on(t.user_id, t.alias)],
);

export const agents = pgTable(
  'agents',
  {
    id: text('id').primaryKey(),
    user_id: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    framework: text('framework', { enum: AGENT_FRAMEWORKS }).notNull(),
    description: text('description'),
    workspace_id: text('workspace_id').references(() => workspaces.id, { onDelete: 'set null' }),
    token_id: text('token_id').references(() => apiTokens.id, { onDelete: 'set null' }),
    allow_mutations: boolean('allow_mutations').notNull().default(false),
    config: jsonb('config').$type<AgentConfig>().notNull().default({}),
    call_count: integer('call_count').notNull().default(0),
    error_count: integer('error_count').notNull().default(0),
    last_seen_at: ts('last_seen_at'),
    created_at: ts('created_at').notNull(),
    updated_at: ts('updated_at').notNull(),
  },
  (t) => [index('agents_user_idx').on(t.user_id), index('agents_token_idx').on(t.token_id)],
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

export const copilotSettings = pgTable('copilot_settings', {
  id: text('id').primaryKey(),
  provider: text('provider').notNull(),
  model: text('model'),
  base_url: text('base_url'),
  encrypted_api_key: text('encrypted_api_key'),
  iv: text('iv'),
  tag: text('tag'),
  key_hint: text('key_hint'),
  aws_region: text('aws_region'),
  bedrock_agent_id: text('bedrock_agent_id'),
  bedrock_agent_alias_id: text('bedrock_agent_alias_id'),
  agentcore_runtime_arn: text('agentcore_runtime_arn'),
  allow_byok: boolean('allow_byok'),
  updated_by: text('updated_by').references(() => users.id, { onDelete: 'set null' }),
  updated_at: ts('updated_at').notNull(),
});

export const copilotUsage = pgTable(
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
    byok: boolean('byok').notNull().default(false),
    input_tokens: integer('input_tokens'),
    output_tokens: integer('output_tokens'),
    duration_ms: integer('duration_ms').notNull(),
    status: text('status', { enum: COPILOT_USAGE_STATUSES }).notNull(),
    created_at: ts('created_at').notNull(),
  },
  (t) => [index('copilot_usage_user_idx').on(t.user_id), index('copilot_usage_created_idx').on(t.created_at), index('copilot_usage_conversation_idx').on(t.conversation_id)],
);

export const databaseConnections = pgTable(
  'database_connections',
  {
    id: text('id').primaryKey(),
    user_id: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    engine: text('engine', { enum: DATABASE_ENGINES }).notNull(),
    alias: text('alias').notNull(),
    config: jsonb('config').$type<DatabaseConfig>().notNull().default({}),
    encrypted_credentials: text('encrypted_credentials').notNull(),
    iv: text('iv').notNull(),
    tag: text('tag').notNull(),
    status: text('status', { enum: LAKEHOUSE_STATUSES }).notNull().default('unknown'),
    last_error: text('last_error'),
    last_tested_at: ts('last_tested_at'),
    created_at: ts('created_at').notNull(),
    updated_at: ts('updated_at').notNull(),
  },
  (t) => [index('database_connections_user_idx').on(t.user_id), uniqueIndex('database_connections_alias_idx').on(t.user_id, t.alias)],
);

export const dataSyncs = pgTable(
  'data_syncs',
  {
    id: text('id').primaryKey(),
    workspace_id: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    user_id: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    source: jsonb('source').$type<SyncSource>().notNull(),
    target_schema: text('target_schema').notNull().default('main'),
    target_table: text('target_table').notNull(),
    mode: text('mode', { enum: SYNC_MODES }).notNull().default('replace'),
    transform_sql: text('transform_sql'),
    schedule: jsonb('schedule').$type<SyncSchedule>().notNull().default({ kind: 'manual' }),
    enabled: boolean('enabled').notNull().default(true),
    last_run: jsonb('last_run').$type<SyncLastRun | null>(),
    next_run_at: ts('next_run_at'),
    created_by: text('created_by'),
    created_at: ts('created_at').notNull(),
    updated_at: ts('updated_at').notNull(),
  },
  (t) => [index('data_syncs_workspace_idx').on(t.workspace_id), index('data_syncs_next_run_idx').on(t.next_run_at)],
);

export const dataSyncRuns = pgTable(
  'data_sync_runs',
  {
    id: text('id').primaryKey(),
    sync_id: text('sync_id').notNull().references(() => dataSyncs.id, { onDelete: 'cascade' }),
    workspace_id: text('workspace_id').notNull(),
    status: text('status', { enum: SYNC_RUN_STATUSES }).notNull(),
    triggered_by: text('triggered_by').notNull(),
    actor_id: text('actor_id'),
    rows: integer('rows'),
    duration_ms: integer('duration_ms'),
    error: text('error'),
    started_at: ts('started_at').notNull(),
    finished_at: ts('finished_at'),
  },
  (t) => [index('data_sync_runs_sync_idx').on(t.sync_id, t.started_at)],
);

export const dataApps = pgTable(
  'data_apps',
  {
    id: text('id').primaryKey(),
    workspace_id: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    user_id: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    kind: text('kind', { enum: APP_KINDS }).notNull().default('streamlit'),
    entry: text('entry').notNull().default('app.py'),
    files: jsonb('files').$type<AppFiles>().notNull().default({}),
    spec: jsonb('spec').$type<Record<string, unknown> | null>(),
    visibility: text('visibility', { enum: APP_VISIBILITIES }).notNull().default('workspace'),
    status: text('status', { enum: APP_STATUSES }).notNull().default('stopped'),
    /** Where the Python runs: on the server (a runtime process) or in the viewer's browser (stlite / Pyodide). */
    execution: text('execution', { enum: APP_EXECUTIONS }).notNull().default('server'),
    /** Kept running: started at boot, never stopped for idleness, restarted after a crash. */
    always_on: boolean('always_on').notNull().default(false),
    /** The runtime that last ran the app (subprocess, docker, kubernetes). */
    runtime: text('runtime'),
    publish_status: text('publish_status', { enum: APP_PUBLISH_STATUSES }).notNull().default('none'),
    publish_requested_by: text('publish_requested_by'),
    publish_requested_at: ts('publish_requested_at'),
    publish_reviewed_by: text('publish_reviewed_by'),
    publish_reviewed_at: ts('publish_reviewed_at'),
    publish_note: text('publish_note'),
    port: integer('port'),
    pid: integer('pid'),
    last_error: text('last_error'),
    last_started_at: ts('last_started_at'),
    last_used_at: ts('last_used_at'),
    created_at: ts('created_at').notNull(),
    updated_at: ts('updated_at').notNull(),
  },
  (t) => [index('data_apps_workspace_idx').on(t.workspace_id)],
);

export const connectorConnections = pgTable(
  'connector_connections',
  {
    id: text('id').primaryKey(),
    user_id: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    connector: text('connector').notNull(),
    name: text('name').notNull(),
    config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
    encrypted_credentials: text('encrypted_credentials').notNull(),
    iv: text('iv').notNull(),
    tag: text('tag').notNull(),
    account_label: text('account_label'),
    status: text('status', { enum: LAKEHOUSE_STATUSES }).notNull().default('unknown'),
    last_error: text('last_error'),
    last_tested_at: ts('last_tested_at'),
    created_at: ts('created_at').notNull(),
    updated_at: ts('updated_at').notNull(),
  },
  (t) => [index('connector_connections_user_idx').on(t.user_id)],
);

export const notificationChannels = pgTable(
  'notification_channels',
  {
    id: text('id').primaryKey(),
    workspace_id: text('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    type: text('type', { enum: CHANNEL_TYPES }).notNull(),
    config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
    encrypted_secret: text('encrypted_secret'),
    iv: text('iv'),
    tag: text('tag'),
    enabled: boolean('enabled').notNull().default(true),
    created_by: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    last_status: text('last_status', { enum: DELIVERY_STATUSES }),
    last_error: text('last_error'),
    last_sent_at: ts('last_sent_at'),
    created_at: ts('created_at').notNull(),
    updated_at: ts('updated_at').notNull(),
  },
  (t) => [index('notification_channels_workspace_idx').on(t.workspace_id)],
);

export const notificationDeliveries = pgTable(
  'notification_deliveries',
  {
    id: text('id').primaryKey(),
    channel_id: text('channel_id').notNull().references(() => notificationChannels.id, { onDelete: 'cascade' }),
    source: text('source').notNull(),
    title: text('title').notNull(),
    status: text('status', { enum: DELIVERY_STATUSES }).notNull(),
    error: text('error'),
    attempts: integer('attempts').notNull().default(1),
    duration_ms: integer('duration_ms'),
    created_at: ts('created_at').notNull(),
  },
  (t) => [index('notification_deliveries_channel_idx').on(t.channel_id, t.created_at)],
);

export const alerts = pgTable(
  'alerts',
  {
    id: text('id').primaryKey(),
    workspace_id: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    user_id: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    sql: text('sql').notNull(),
    condition: jsonb('condition').$type<AlertCondition>().notNull(),
    schedule: jsonb('schedule').$type<SyncSchedule>().notNull(),
    channel_ids: jsonb('channel_ids').$type<string[]>().notNull().default([]),
    severity: text('severity', { enum: ALERT_SEVERITIES }).notNull().default('warning'),
    notify: text('notify', { enum: ['change', 'always'] }).notNull().default('change'),
    notify_resolved: boolean('notify_resolved').notNull().default(true),
    enabled: boolean('enabled').notNull().default(true),
    state: text('state', { enum: ALERT_STATES }).notNull().default('unknown'),
    last_value: text('last_value'),
    last_error: text('last_error'),
    last_checked_at: ts('last_checked_at'),
    last_triggered_at: ts('last_triggered_at'),
    next_run_at: ts('next_run_at'),
    created_at: ts('created_at').notNull(),
    updated_at: ts('updated_at').notNull(),
  },
  (t) => [index('alerts_workspace_idx').on(t.workspace_id), index('alerts_next_run_idx').on(t.next_run_at)],
);

export const alertEvents = pgTable(
  'alert_events',
  {
    id: text('id').primaryKey(),
    alert_id: text('alert_id').notNull().references(() => alerts.id, { onDelete: 'cascade' }),
    state: text('state', { enum: ALERT_STATES }).notNull(),
    value: text('value'),
    message: text('message'),
    notified: integer('notified').notNull().default(0),
    triggered_by: text('triggered_by').notNull().default('schedule'),
    created_at: ts('created_at').notNull(),
  },
  (t) => [index('alert_events_alert_idx').on(t.alert_id, t.created_at)],
);

export const snapshots = pgTable(
  'snapshots',
  {
    id: text('id').primaryKey(),
    workspace_id: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    user_id: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    target: jsonb('target').$type<SnapshotTarget>().notNull(),
    format: text('format', { enum: SNAPSHOT_FORMATS }).notNull().default('png'),
    width: integer('width').notNull().default(1280),
    schedule: jsonb('schedule').$type<SyncSchedule>().notNull(),
    channel_ids: jsonb('channel_ids').$type<string[]>().notNull().default([]),
    enabled: boolean('enabled').notNull().default(true),
    last_status: text('last_status', { enum: DELIVERY_STATUSES }),
    last_error: text('last_error'),
    last_run_at: ts('last_run_at'),
    next_run_at: ts('next_run_at'),
    created_at: ts('created_at').notNull(),
    updated_at: ts('updated_at').notNull(),
  },
  (t) => [index('snapshots_workspace_idx').on(t.workspace_id), index('snapshots_next_run_idx').on(t.next_run_at)],
);

export const snapshotRuns = pgTable(
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
    created_at: ts('created_at').notNull(),
  },
  (t) => [index('snapshot_runs_snapshot_idx').on(t.snapshot_id, t.created_at)],
);

export const accessPolicies = pgTable(
  'access_policies',
  {
    id: text('id').primaryKey(),
    workspace_id: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    table_name: text('table_name').notNull(),
    row_filter: text('row_filter'),
    column_masks: jsonb('column_masks').$type<Record<string, ColumnMask>>().notNull().default({}),
    applies_to: jsonb('applies_to').$type<PolicySubjects>().notNull().default({ roles: ['VIEWER'] }),
    enabled: boolean('enabled').notNull().default(true),
    created_by: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    created_at: ts('created_at').notNull(),
    updated_at: ts('updated_at').notNull(),
  },
  (t) => [index('access_policies_workspace_idx').on(t.workspace_id)],
);

export const catalogAnnotations = pgTable(
  'catalog_annotations',
  {
    id: text('id').primaryKey(),
    workspace_id: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    object_name: text('object_name').notNull(),
    column_name: text('column_name'),
    description: text('description'),
    tags: jsonb('tags').$type<string[]>().notNull().default([]),
    updated_by: text('updated_by').references(() => users.id, { onDelete: 'set null' }),
    updated_at: ts('updated_at').notNull(),
  },
  (t) => [index('catalog_annotations_workspace_idx').on(t.workspace_id, t.object_name)],
);

export const auditSinks = pgTable('audit_sinks', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  type: text('type', { enum: AUDIT_SINK_TYPES }).notNull(),
  config: jsonb('config').$type<Record<string, unknown>>().notNull().default({}),
  encrypted_secret: text('encrypted_secret'),
  iv: text('iv'),
  tag: text('tag'),
  enabled: boolean('enabled').notNull().default(true),
  cursor_at: ts('cursor_at'),
  cursor_id: text('cursor_id'),
  exported: integer('exported').notNull().default(0),
  last_status: text('last_status', { enum: DELIVERY_STATUSES }),
  last_error: text('last_error'),
  last_exported_at: ts('last_exported_at'),
  retry_after: ts('retry_after'),
  failures: integer('failures').notNull().default(0),
  created_by: text('created_by').references(() => users.id, { onDelete: 'set null' }),
  created_at: ts('created_at').notNull(),
  updated_at: ts('updated_at').notNull(),
});

export const appSettings = pgTable('app_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').$type<Record<string, unknown>>().notNull().default({}),
  encrypted_value: text('encrypted_value'),
  iv: text('iv'),
  tag: text('tag'),
  updated_by: text('updated_by'),
  updated_at: ts('updated_at').notNull(),
});

export const dbtProjects = pgTable(
  'dbt_projects',
  {
    id: text('id').primaryKey(),
    workspace_id: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    user_id: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    files: jsonb('files').$type<Record<string, string>>().notNull(),
    vars: jsonb('vars').$type<Record<string, unknown>>().notNull().default({}),
    target_schema: text('target_schema').notNull().default('main'),
    schedule: jsonb('schedule').$type<DbtSchedule>().notNull().default({ kind: 'manual' }),
    scheduled: jsonb('scheduled').$type<DbtScheduledCommand>().notNull().default({ command: 'build' }),
    enabled: boolean('enabled').notNull().default(true),
    next_run_at: ts('next_run_at'),
    last_run: jsonb('last_run').$type<DbtLastRun | null>(),
    created_at: ts('created_at').notNull(),
    updated_at: ts('updated_at').notNull(),
  },
  (t) => [index('dbt_projects_workspace_idx').on(t.workspace_id), index('dbt_projects_next_run_idx').on(t.next_run_at)],
);

export const dbtRuns = pgTable(
  'dbt_runs',
  {
    id: text('id').primaryKey(),
    project_id: text('project_id').notNull().references(() => dbtProjects.id, { onDelete: 'cascade' }),
    workspace_id: text('workspace_id').notNull(),
    user_id: text('user_id'),
    command: text('command', { enum: DBT_COMMANDS }).notNull(),
    select: text('select'),
    exclude: text('exclude'),
    full_refresh: boolean('full_refresh').notNull().default(false),
    triggered_by: text('triggered_by').notNull(),
    status: text('status', { enum: DBT_RUN_STATUSES }).notNull(),
    summary: text('summary'),
    error: text('error'),
    log: text('log'),
    results: jsonb('results').$type<DbtNodeResult[]>().notNull().default([]),
    duration_ms: integer('duration_ms'),
    started_at: ts('started_at').notNull(),
    finished_at: ts('finished_at'),
  },
  (t) => [index('dbt_runs_project_idx').on(t.project_id, t.started_at)],
);

export const semanticLayers = pgTable(
  'semantic_layers',
  {
    id: text('id').primaryKey(),
    workspace_id: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    source: text('source').notNull(),
    yaml: text('yaml'),
    definition: jsonb('definition').$type<Record<string, unknown>>().notNull(),
    updated_by: text('updated_by'),
    updated_at: ts('updated_at').notNull(),
  },
  (t) => [uniqueIndex('semantic_layers_source_idx').on(t.workspace_id, t.source)],
);
