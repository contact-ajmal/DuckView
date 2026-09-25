/**
 * Metadata store schema — PostgreSQL dialect (enterprise mode via DATABASE_URL).
 * Mirrors ./sqlite.ts exactly (names, nullability, JSON shapes).
 */
import { pgTable, text, integer, bigint, timestamp, jsonb, boolean, index, uniqueIndex } from 'drizzle-orm/pg-core';
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
    /** One line on what the workspace is for. */
    description: text('description'),
    /** Free-form labels for finding and grouping workspaces (lower case). */
    tags: jsonb('tags').$type<string[]>().notNull().default([]),
    /** A series colour token (1–8) shown next to the name. */
    color: text('color'),
    /** Archived workspaces are hidden from the switcher and cannot run queries until restored. */
    archived_at: ts('archived_at'),
    backup_policy: jsonb('backup_policy').$type<{ every_hours: number; keep: number } | null>(),
    last_backup_at: ts('last_backup_at'),
    idle_warned_at: ts('idle_warned_at'),
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
import { WIDGET_TYPES, DASHBOARD_KINDS, CLOUD_PROVIDERS, CHAT_ROLES, COPILOT_USAGE_STATUSES, DATABASE_ENGINES, SYNC_MODES, SYNC_RUN_STATUSES, LAKEHOUSE_PROVIDERS, LAKEHOUSE_STATUSES, AGENT_FRAMEWORKS, APP_KINDS, APP_STATUSES, APP_VISIBILITIES, APP_PUBLISH_STATUSES, APP_EXECUTIONS, CHANNEL_TYPES, DELIVERY_STATUSES, ALERT_STATES, ALERT_SEVERITIES, SNAPSHOT_FORMATS, AUDIT_SINK_TYPES, type ColumnMask, type PolicySubjects, type AlertCondition, type SnapshotTarget, type AppFiles, type LayoutItem, type WidgetChartConfig, type ChatContextSnapshot, type LakehouseConfig, type AgentConfig, type DatabaseConfig, type SyncSource, type SyncSchedule, type SyncLastRun, DBT_COMMANDS, DBT_RUN_STATUSES, type DbtSchedule, type DbtScheduledCommand, type DbtNodeResult, type DbtLastRun, QUALITY_STATUSES, type QualityCheck, type QualityCheckResult, type QualityLastRun, REVERSE_MODES, REVERSE_RUN_STATUSES, type ReverseDestination, type ReverseLastRun, type NotebookCell, COMMENT_TARGETS, INBOX_KINDS, REVISION_TYPES, MONITOR_GRAINS, MONITOR_STATUSES, INSIGHT_STATUSES, type MonitorLastRun, type InsightDetail, HOSTED_RUN_STATUSES, type HostedAgentLastRun, type HostedAgentStep, STREAM_KINDS, STREAM_FORMATS, STREAM_MODES, STREAM_STATUSES, type StreamConfig, type StreamStats, ORCHESTRATION_KINDS, ORCHESTRATION_STATUSES, TEMPLATE_STATUSES, type TemplateBody, type TemplateInstallObjects, WORKSPACE_BACKUP_KINDS } from './sqlite.js';

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

export const qualitySuites = pgTable(
  'quality_suites',
  {
    id: text('id').primaryKey(),
    workspace_id: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    user_id: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    relation: text('relation').notNull(),
    checks: jsonb('checks').$type<QualityCheck[]>().notNull().default([]),
    schedule: jsonb('schedule').$type<SyncSchedule>().notNull().default({ kind: 'manual' }),
    channel_ids: jsonb('channel_ids').$type<string[]>().notNull().default([]),
    enabled: boolean('enabled').notNull().default(true),
    status: text('status', { enum: QUALITY_STATUSES }).notNull().default('unknown'),
    last_run: jsonb('last_run').$type<QualityLastRun | null>(),
    next_run_at: ts('next_run_at'),
    created_at: ts('created_at').notNull(),
    updated_at: ts('updated_at').notNull(),
  },
  (t) => [index('quality_suites_workspace_idx').on(t.workspace_id), index('quality_suites_next_run_idx').on(t.next_run_at)],
);

export const qualityRuns = pgTable(
  'quality_runs',
  {
    id: text('id').primaryKey(),
    suite_id: text('suite_id').notNull().references(() => qualitySuites.id, { onDelete: 'cascade' }),
    workspace_id: text('workspace_id').notNull(),
    status: text('status', { enum: QUALITY_STATUSES }).notNull(),
    summary: text('summary').notNull(),
    results: jsonb('results').$type<QualityCheckResult[]>().notNull().default([]),
    triggered_by: text('triggered_by').notNull(),
    actor_id: text('actor_id'),
    notified: integer('notified').notNull().default(0),
    duration_ms: integer('duration_ms'),
    started_at: ts('started_at').notNull(),
  },
  (t) => [index('quality_runs_suite_idx').on(t.suite_id, t.started_at)],
);

export const reverseSyncs = pgTable(
  'reverse_syncs',
  {
    id: text('id').primaryKey(),
    workspace_id: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    user_id: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    sql: text('sql').notNull(),
    destination: jsonb('destination').$type<ReverseDestination>().notNull(),
    mode: text('mode', { enum: REVERSE_MODES }).notNull().default('replace'),
    key_columns: jsonb('key_columns').$type<string[]>().notNull().default([]),
    encrypted_secret: text('encrypted_secret'),
    iv: text('iv'),
    tag: text('tag'),
    schedule: jsonb('schedule').$type<SyncSchedule>().notNull().default({ kind: 'manual' }),
    channel_ids: jsonb('channel_ids').$type<string[]>().notNull().default([]),
    enabled: boolean('enabled').notNull().default(true),
    last_run: jsonb('last_run').$type<ReverseLastRun | null>(),
    next_run_at: ts('next_run_at'),
    created_at: ts('created_at').notNull(),
    updated_at: ts('updated_at').notNull(),
  },
  (t) => [index('reverse_syncs_workspace_idx').on(t.workspace_id), index('reverse_syncs_next_run_idx').on(t.next_run_at)],
);

export const reverseSyncRuns = pgTable(
  'reverse_sync_runs',
  {
    id: text('id').primaryKey(),
    sync_id: text('sync_id').notNull().references(() => reverseSyncs.id, { onDelete: 'cascade' }),
    workspace_id: text('workspace_id').notNull(),
    status: text('status', { enum: REVERSE_RUN_STATUSES }).notNull(),
    triggered_by: text('triggered_by').notNull(),
    actor_id: text('actor_id'),
    rows_read: integer('rows_read'),
    rows_sent: integer('rows_sent'),
    rows_deleted: integer('rows_deleted'),
    summary: text('summary'),
    error: text('error'),
    duration_ms: integer('duration_ms'),
    started_at: ts('started_at').notNull(),
    finished_at: ts('finished_at'),
  },
  (t) => [index('reverse_sync_runs_sync_idx').on(t.sync_id, t.started_at)],
);

export const notebooks = pgTable(
  'notebooks',
  {
    id: text('id').primaryKey(),
    workspace_id: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    user_id: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    cells: jsonb('cells').$type<NotebookCell[]>().notNull().default([]),
    version: integer('version').notNull().default(1),
    updated_by: text('updated_by'),
    created_at: ts('created_at').notNull(),
    updated_at: ts('updated_at').notNull(),
  },
  (t) => [index('notebooks_workspace_idx').on(t.workspace_id)],
);

export const comments = pgTable(
  'comments',
  {
    id: text('id').primaryKey(),
    workspace_id: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    target_type: text('target_type', { enum: COMMENT_TARGETS }).notNull(),
    target_id: text('target_id').notNull(),
    anchor: text('anchor'),
    parent_id: text('parent_id'),
    user_id: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    body: text('body').notNull(),
    mentions: jsonb('mentions').$type<string[]>().notNull().default([]),
    resolved_at: ts('resolved_at'),
    resolved_by: text('resolved_by'),
    edited_at: ts('edited_at'),
    created_at: ts('created_at').notNull(),
  },
  (t) => [index('comments_target_idx').on(t.workspace_id, t.target_type, t.target_id), index('comments_parent_idx').on(t.parent_id)],
);

export const inbox = pgTable(
  'inbox',
  {
    id: text('id').primaryKey(),
    user_id: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    workspace_id: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: INBOX_KINDS }).notNull(),
    comment_id: text('comment_id').notNull().references(() => comments.id, { onDelete: 'cascade' }),
    actor_id: text('actor_id'),
    read_at: ts('read_at'),
    created_at: ts('created_at').notNull(),
  },
  (t) => [index('inbox_user_idx').on(t.user_id, t.created_at)],
);

export const revisions = pgTable(
  'revisions',
  {
    id: text('id').primaryKey(),
    workspace_id: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    object_type: text('object_type', { enum: REVISION_TYPES }).notNull(),
    object_id: text('object_id').notNull(),
    number: integer('number').notNull(),
    snapshot: jsonb('snapshot').$type<Record<string, unknown>>().notNull(),
    message: text('message'),
    named: boolean('named').notNull().default(false),
    user_id: text('user_id'),
    created_at: ts('created_at').notNull(),
    updated_at: ts('updated_at').notNull(),
  },
  (t) => [index('revisions_object_idx').on(t.object_type, t.object_id, t.number)],
);

export const gitSyncs = pgTable(
  'git_syncs',
  {
    id: text('id').primaryKey(),
    workspace_id: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    repo_url: text('repo_url').notNull(),
    branch: text('branch').notNull().default('main'),
    path: text('path').notNull().default(''),
    encrypted_secret: text('encrypted_secret'),
    iv: text('iv'),
    tag: text('tag'),
    created_by: text('created_by'),
    last_push_sha: text('last_push_sha'),
    last_push_at: ts('last_push_at'),
    last_pull_sha: text('last_pull_sha'),
    last_pull_at: ts('last_pull_at'),
    mapping: jsonb('mapping').$type<Record<string, string>>().notNull().default({}),
    last_error: text('last_error'),
    created_at: ts('created_at').notNull(),
    updated_at: ts('updated_at').notNull(),
  },
  (t) => [uniqueIndex('git_syncs_workspace_idx').on(t.workspace_id)],
);

export const embedKeys = pgTable(
  'embed_keys',
  {
    id: text('id').primaryKey(),
    workspace_id: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    encrypted_secret: text('encrypted_secret').notNull(),
    iv: text('iv').notNull(),
    tag: text('tag').notNull(),
    allowed_origins: jsonb('allowed_origins').$type<string[]>().notNull().default([]),
    created_by: text('created_by').notNull().references(() => users.id, { onDelete: 'cascade' }),
    last_used_at: ts('last_used_at'),
    revoked_at: ts('revoked_at'),
    created_at: ts('created_at').notNull(),
  },
  (t) => [index('embed_keys_workspace_idx').on(t.workspace_id)],
);

export const metricMonitors = pgTable(
  'metric_monitors',
  {
    id: text('id').primaryKey(),
    workspace_id: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    user_id: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    metric: text('metric').notNull(),
    grain: text('grain', { enum: MONITOR_GRAINS }).notNull().default('day'),
    segment_by: text('segment_by'),
    sensitivity: integer('sensitivity').notNull().default(3),
    lookback: integer('lookback').notNull().default(28),
    schedule: jsonb('schedule').$type<SyncSchedule>().notNull().default({ kind: 'manual' }),
    channel_ids: jsonb('channel_ids').$type<string[]>().notNull().default([]),
    enabled: boolean('enabled').notNull().default(true),
    status: text('status', { enum: MONITOR_STATUSES }).notNull().default('unknown'),
    last_run: jsonb('last_run').$type<MonitorLastRun | null>(),
    next_run_at: ts('next_run_at'),
    created_at: ts('created_at').notNull(),
    updated_at: ts('updated_at').notNull(),
  },
  (t) => [index('metric_monitors_workspace_idx').on(t.workspace_id), index('metric_monitors_next_run_idx').on(t.next_run_at)],
);

export const insights = pgTable(
  'insights',
  {
    id: text('id').primaryKey(),
    workspace_id: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    monitor_id: text('monitor_id').notNull().references(() => metricMonitors.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    metric: text('metric').notNull(),
    grain: text('grain', { enum: MONITOR_GRAINS }).notNull(),
    period: text('period').notNull(),
    segment: text('segment'),
    direction: text('direction', { enum: ['up', 'down'] }).notNull(),
    summary: text('summary').notNull(),
    detail: jsonb('detail').$type<InsightDetail>().notNull(),
    status: text('status', { enum: INSIGHT_STATUSES }).notNull().default('new'),
    created_at: ts('created_at').notNull(),
  },
  (t) => [uniqueIndex('insights_key_idx').on(t.key), index('insights_workspace_idx').on(t.workspace_id, t.created_at)],
);

export const hostedAgents = pgTable(
  'hosted_agents',
  {
    id: text('id').primaryKey(),
    workspace_id: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    user_id: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description'),
    template: text('template'),
    instructions: text('instructions').notNull(),
    task: text('task').notNull(),
    tools: jsonb('tools').$type<string[]>().notNull().default([]),
    max_steps: integer('max_steps').notNull().default(8),
    schedule: jsonb('schedule').$type<SyncSchedule>().notNull().default({ kind: 'manual' }),
    channel_ids: jsonb('channel_ids').$type<string[]>().notNull().default([]),
    published: boolean('published').notNull().default(false),
    enabled: boolean('enabled').notNull().default(true),
    last_run: jsonb('last_run').$type<HostedAgentLastRun | null>(),
    next_run_at: ts('next_run_at'),
    created_at: ts('created_at').notNull(),
    updated_at: ts('updated_at').notNull(),
  },
  (t) => [index('hosted_agents_workspace_idx').on(t.workspace_id), index('hosted_agents_next_run_idx').on(t.next_run_at)],
);

export const hostedAgentRuns = pgTable(
  'hosted_agent_runs',
  {
    id: text('id').primaryKey(),
    agent_id: text('agent_id').notNull().references(() => hostedAgents.id, { onDelete: 'cascade' }),
    workspace_id: text('workspace_id').notNull(),
    status: text('status', { enum: HOSTED_RUN_STATUSES }).notNull(),
    triggered_by: text('triggered_by').notNull(),
    actor_id: text('actor_id'),
    context_id: text('context_id'),
    input: text('input').notNull(),
    output: text('output'),
    steps: jsonb('steps').$type<HostedAgentStep[]>().notNull().default([]),
    error: text('error'),
    model: text('model'),
    input_tokens: integer('input_tokens').notNull().default(0),
    output_tokens: integer('output_tokens').notNull().default(0),
    notified: integer('notified').notNull().default(0),
    started_at: ts('started_at').notNull(),
    finished_at: ts('finished_at'),
  },
  (t) => [index('hosted_agent_runs_agent_idx').on(t.agent_id, t.started_at)],
);

export const a2aRemotes = pgTable(
  'a2a_remotes',
  {
    id: text('id').primaryKey(),
    user_id: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    card_url: text('card_url').notNull(),
    endpoint: text('endpoint').notNull(),
    card: jsonb('card').$type<Record<string, unknown>>().notNull(),
    encrypted_headers: text('encrypted_headers'),
    iv: text('iv'),
    tag: text('tag'),
    last_used_at: ts('last_used_at'),
    created_at: ts('created_at').notNull(),
    updated_at: ts('updated_at').notNull(),
  },
  (t) => [index('a2a_remotes_user_idx').on(t.user_id)],
);

export const streams = pgTable(
  'streams',
  {
    id: text('id').primaryKey(),
    workspace_id: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    user_id: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    kind: text('kind', { enum: STREAM_KINDS }).notNull(),
    config: jsonb('config').$type<StreamConfig>().notNull(),
    encrypted_secret: text('encrypted_secret'),
    iv: text('iv'),
    tag: text('tag'),
    key_hash: text('key_hash'),
    format: text('format', { enum: STREAM_FORMATS }).notNull().default('json'),
    mode: text('mode', { enum: STREAM_MODES }).notNull().default('append'),
    key_columns: jsonb('key_columns').$type<string[]>().notNull().default([]),
    keep_history: boolean('keep_history').notNull().default(false),
    target_schema: text('target_schema').notNull().default('main'),
    target_table: text('target_table').notNull(),
    include_metadata: boolean('include_metadata').notNull().default(true),
    batch_rows: integer('batch_rows').notNull().default(1000),
    batch_seconds: integer('batch_seconds').notNull().default(5),
    enabled: boolean('enabled').notNull().default(true),
    status: text('status', { enum: STREAM_STATUSES }).notNull().default('stopped'),
    stats: jsonb('stats').$type<StreamStats>().notNull().default({ rows_total: 0, batches: 0, last_batch_rows: 0, last_batch_at: null, last_error: null, last_error_at: null }),
    checkpoints: jsonb('checkpoints').$type<Record<string, string>>().notNull().default({}),
    created_at: ts('created_at').notNull(),
    updated_at: ts('updated_at').notNull(),
  },
  (t) => [index('streams_workspace_idx').on(t.workspace_id), uniqueIndex('streams_target_idx').on(t.workspace_id, t.target_schema, t.target_table)],
);

export const orchestrationRuns = pgTable(
  'orchestration_runs',
  {
    id: text('id').primaryKey(),
    user_id: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    workspace_id: text('workspace_id'),
    kind: text('kind', { enum: ORCHESTRATION_KINDS }).notNull(),
    target_id: text('target_id'),
    label: text('label').notNull(),
    status: text('status', { enum: ORCHESTRATION_STATUSES }).notNull(),
    summary: text('summary'),
    detail: jsonb('detail').$type<Record<string, unknown>>().notNull().default({}),
    source: text('source').notNull().default('api'),
    external_run_id: text('external_run_id'),
    started_at: ts('started_at').notNull(),
    finished_at: ts('finished_at'),
  },
  (t) => [index('orchestration_runs_user_idx').on(t.user_id, t.started_at)],
);

export const clusterNodes = pgTable('cluster_nodes', {
  id: text('id').primaryKey(),
  url: text('url').notNull(),
  version: text('version').notNull(),
  started_at: ts('started_at').notNull(),
  heartbeat_at: ts('heartbeat_at').notNull(),
});

export const clusterLeases = pgTable(
  'cluster_leases',
  {
    key: text('key').primaryKey(),
    node_id: text('node_id').notNull(),
    acquired_at: ts('acquired_at').notNull(),
    expires_at: ts('expires_at').notNull(),
  },
  (t) => [index('cluster_leases_node_idx').on(t.node_id)],
);

export const usageBudgets = pgTable(
  'usage_budgets',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    workspace_id: text('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
    amount_cents: integer('amount_cents').notNull(),
    thresholds: jsonb('thresholds').$type<number[]>().notNull().default([80, 100]),
    forecast: boolean('forecast').notNull().default(false),
    channel_ids: jsonb('channel_ids').$type<string[]>().notNull().default([]),
    notified: text('notified').notNull().default(''),
    created_by: text('created_by').notNull(),
    created_at: ts('created_at').notNull(),
    updated_at: ts('updated_at').notNull(),
  },
  (t) => [index('usage_budgets_workspace_idx').on(t.workspace_id)],
);

export const templates = pgTable(
  'templates',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description'),
    category: text('category').notNull().default('Other'),
    tags: jsonb('tags').$type<string[]>().notNull().default([]),
    author_id: text('author_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    status: text('status', { enum: TEMPLATE_STATUSES }).notNull(),
    body: jsonb('body').$type<TemplateBody>().notNull(),
    installs: integer('installs').notNull().default(0),
    reviewed_by: text('reviewed_by'),
    created_at: ts('created_at').notNull(),
    updated_at: ts('updated_at').notNull(),
  },
  (t) => [index('templates_status_idx').on(t.status), index('templates_author_idx').on(t.author_id)],
);

export const templateInstalls = pgTable(
  'template_installs',
  {
    id: text('id').primaryKey(),
    template_id: text('template_id').notNull(),
    template_name: text('template_name').notNull(),
    workspace_id: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    user_id: text('user_id').notNull(),
    table_map: jsonb('table_map').$type<Record<string, string>>().notNull().default({}),
    objects: jsonb('objects').$type<TemplateInstallObjects>().notNull(),
    created_at: ts('created_at').notNull(),
  },
  (t) => [index('template_installs_ws_idx').on(t.workspace_id)],
);

export const workspaceBackups = pgTable(
  'workspace_backups',
  {
    id: text('id').primaryKey(),
    workspace_id: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: WORKSPACE_BACKUP_KINDS }).notNull(),
    file: text('file').notNull(),
    size_bytes: bigint('size_bytes', { mode: 'number' }).notNull().default(0),
    tables: integer('tables').notNull().default(0),
    objects: jsonb('objects').$type<{ queries: number; dashboards: number; notebooks: number; quality: number }>().notNull().default({ queries: 0, dashboards: 0, notebooks: 0, quality: 0 }),
    note: text('note'),
    created_by: text('created_by'),
    created_at: ts('created_at').notNull(),
  },
  (t) => [index('workspace_backups_ws_idx').on(t.workspace_id, t.created_at)],
);
