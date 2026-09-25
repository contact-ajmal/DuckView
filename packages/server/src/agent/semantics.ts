/**
 * Machine-readable semantics for every tool of the registry: what it is for, what it needs, what it produces and how
 * risky it is. MCP (`_meta`), the REST façade, OpenAPI (`x-duckview`), the Decision Engine, the agent runtime and the
 * UI read them from here, through `semanticsOf(tool)`.
 *
 * Nothing has to be written twice: every tool gets complete semantics derived from its name, annotations and input
 * schema, and the entries below only refine what derivation cannot know (a publish is a PUBLISH, what a tool
 * produces, the words people use for it). A tool added to the registry without an entry still works.
 */
import type { ToolDef } from './tools.js';

/** How a call can change the world — the HITL class. Enforcement stays in the services (HitlBlocked). */
export const ACTION_CLASSES = ['READ', 'LOW_RISK_WRITE', 'HIGH_RISK_WRITE', 'EXTERNAL_SIDE_EFFECT', 'PUBLISH', 'DATA_EXPORT'] as const;
export type ActionClass = (typeof ACTION_CLASSES)[number];

export const TOOL_CATEGORIES = ['query', 'catalog', 'profile', 'semantic', 'dashboard', 'notebook', 'app', 'quality', 'dbt', 'sync', 'reverse_etl', 'stream', 'alert', 'insight', 'governance', 'workspace', 'git', 'agent', 'lakehouse', 'connector', 'template', 'endpoint', 'prep', 'collaboration', 'usage'] as const;
export type ToolCategory = (typeof TOOL_CATEGORIES)[number];

export interface ToolSemantics {
  category: ToolCategory;
  action: ActionClass;
  /** none: never changes anything; conditional: depends on the arguments (SQL); always: every successful call does. */
  mutation: 'none' | 'conditional' | 'always';
  /** What the tool can do, as short tags (sql, analytics, data_read, visualise, schedule…). */
  capabilities: string[];
  /** What must exist for it to work (workspace, dataset, dashboard, dbt_project…). */
  requires: string[];
  /** What a call yields (query_result, schema, profile, dashboard, sql, list…). */
  produces: string[];
  /** Words people use for this job that are not in the name or description. */
  keywords: string[];
  /** Offered to the model on every step (discovery and reading), whatever the request. */
  core: boolean;
}

type Refinement = Partial<ToolSemantics>;

const CATEGORY_BY_NAME: [RegExp, ToolCategory][] = [
  [/lakehouse/, 'lakehouse'],
  [/connector|data_sources|browse_storage/, 'connector'],
  [/dbt/, 'dbt'],
  [/metric|anomal|insight/, 'semantic'],
  [/quality/, 'quality'],
  [/reverse/, 'reverse_etl'],
  [/sync/, 'sync'],
  [/stream/, 'stream'],
  [/alert/, 'alert'],
  [/dashboard|widget/, 'dashboard'],
  [/notebook/, 'notebook'],
  [/app/, 'app'],
  [/pii|lineage|catalog|annotate/, 'governance'],
  [/git/, 'git'],
  [/agent/, 'agent'],
  [/template/, 'template'],
  [/endpoint/, 'endpoint'],
  [/comment/, 'collaboration'],
  [/usage/, 'usage'],
  [/backup|health|workspace/, 'workspace'],
  [/profile/, 'profile'],
  [/schema|joins|diff/, 'catalog'],
];

const REFINE: Record<string, Refinement> = {
  execute_query: { category: 'query', action: 'READ', mutation: 'conditional', capabilities: ['sql', 'analytics', 'data_read', 'aggregate'], produces: ['query_result', 'sql'], keywords: ['run', 'select', 'count', 'total', 'sum', 'average', 'group', 'compare', 'trend', 'top', 'filter', 'revenue', 'how many'], core: true },
  profile_dataset: { capabilities: ['profile', 'statistics', 'data_read'], produces: ['profile'], requires: ['workspace', 'dataset'], keywords: ['summarize', 'distribution', 'nulls', 'min', 'max', 'understand', 'analyse', 'analyze', 'explore', 'describe'] },
  explain_query: { category: 'query', capabilities: ['sql', 'performance'], produces: ['plan'], keywords: ['slow', 'optimise', 'optimize', 'plan', 'performance', 'why slow'] },
  list_accessible_data: { category: 'catalog', capabilities: ['discover', 'catalog'], produces: ['list', 'schema'], keywords: ['tables', 'datasets', 'files', 'what data', 'available'], core: true },
  save_dataset: { category: 'query', action: 'DATA_EXPORT', mutation: 'always', capabilities: ['export', 'materialise'], produces: ['file'], keywords: ['export', 'parquet', 'csv', 'download', 'write file'] },
  browse_storage: { capabilities: ['discover', 'files', 'cloud'], produces: ['list'], keywords: ['bucket', 's3', 'folder', 'files', 'glue', 'iceberg'] },
  inspect_schema: { category: 'catalog', capabilities: ['schema', 'discover'], produces: ['schema'], requires: ['workspace', 'dataset'], keywords: ['columns', 'types', 'structure', 'fields', 'describe'], core: true },
  lakehouse_query: { action: 'READ', mutation: 'conditional', capabilities: ['sql', 'remote'], produces: ['query_result'], keywords: ['databricks', 'warehouse'] },
  list_dashboards: { capabilities: ['discover'], produces: ['list'], keywords: ['reports', 'boards'] },
  create_dashboard_widget: { capabilities: ['visualise', 'chart', 'create'], produces: ['dashboard', 'widget', 'chart'], keywords: ['chart', 'graph', 'plot', 'kpi', 'bar chart', 'line chart', 'visualise', 'visualize', 'add to dashboard'] },
  create_mosaic_dashboard: { capabilities: ['visualise', 'interactive', 'create'], produces: ['dashboard', 'chart'], keywords: ['interactive', 'cross filter', 'crossfilter', 'brush', 'explore visually'] },
  list_data_sources: { capabilities: ['discover', 'connections'], produces: ['list'], keywords: ['connections', 'sources', 'databases', 'postgres', 'snowflake', 'bigquery'] },
  create_data_sync: { action: 'LOW_RISK_WRITE', capabilities: ['ingest', 'schedule'], produces: ['sync'], keywords: ['import', 'load', 'ingest', 'copy from', 'replicate'] },
  update_data_sync: { requires: ['sync'], capabilities: ['ingest', 'schedule'], produces: ['sync'] },
  run_data_sync: { requires: ['sync'], capabilities: ['ingest'], produces: ['sync_run'], keywords: ['refresh', 'reload'] },
  browse_connector: { capabilities: ['discover', 'remote'], produces: ['list'], requires: ['connection'] },
  connector_query: { capabilities: ['sql', 'remote', 'data_read'], produces: ['query_result'], requires: ['connection'], keywords: ['snowflake', 'bigquery', 'redshift', 'clickhouse', 'warehouse'] },
  list_apps: { capabilities: ['discover'], produces: ['list'], keywords: ['streamlit', 'dash', 'gradio'] },
  create_app: { capabilities: ['build', 'create'], produces: ['app'], keywords: ['data app', 'streamlit', 'application', 'tool', 'interactive app'] },
  update_app: { requires: ['app'], produces: ['app'] },
  run_app: { requires: ['app'], produces: ['app'] },
  stop_app: { requires: ['app'], produces: ['app'] },
  get_app_logs: { requires: ['app'], produces: ['logs'] },
  preview_app: { requires: ['app'], produces: ['image'] },
  publish_app: { action: 'PUBLISH', requires: ['app'], produces: ['app'], keywords: ['share', 'publish', 'release'] },
  list_alerts: { produces: ['list'] },
  create_alert: { action: 'EXTERNAL_SIDE_EFFECT', capabilities: ['monitor', 'notify', 'schedule'], produces: ['alert'], keywords: ['notify', 'when', 'threshold', 'slack', 'email', 'alert me'] },
  run_alert: { action: 'EXTERNAL_SIDE_EFFECT', requires: ['alert'], produces: ['alert_state'] },
  snapshot_dashboard: { capabilities: ['render', 'visualise'], produces: ['image'], requires: ['dashboard'], keywords: ['screenshot', 'picture', 'png', 'look at'] },
  list_dbt_projects: { produces: ['list'], keywords: ['models', 'transformations'] },
  get_dbt_project: { requires: ['dbt_project'], produces: ['files'] },
  create_dbt_project: { produces: ['dbt_project'] },
  write_dbt_files: { requires: ['dbt_project'], produces: ['dbt_project'] },
  create_dbt_model: { requires: ['dbt_project'], capabilities: ['transform', 'model'], produces: ['dbt_model', 'sql'], keywords: ['model', 'transformation', 'staging', 'mart'] },
  run_dbt: { action: 'HIGH_RISK_WRITE', requires: ['dbt_project'], capabilities: ['transform', 'build'], produces: ['dbt_run'], keywords: ['build', 'run models', 'test models'] },
  get_dbt_run: { produces: ['dbt_run'] },
  list_metrics: { category: 'semantic', capabilities: ['semantic', 'discover', 'metrics'], produces: ['list', 'metric'], keywords: ['kpi', 'measure', 'definition', 'arr', 'mrr', 'revenue', 'churn', 'semantic layer', 'canonical'], core: true },
  query_metrics: { category: 'semantic', capabilities: ['semantic', 'analytics', 'data_read', 'metrics'], produces: ['query_result', 'sql'], requires: ['workspace', 'metric'], keywords: ['kpi', 'measure', 'arr', 'mrr', 'revenue', 'by region', 'by month', 'over time', 'trend', 'compare', 'canonical'] },
  list_quality_suites: { produces: ['list'], keywords: ['checks', 'tests', 'data quality'] },
  suggest_quality_checks: { capabilities: ['quality', 'profile'], produces: ['quality_checks'], requires: ['workspace', 'dataset'], keywords: ['quality', 'null', 'duplicates', 'validate', 'checks', 'tests', 'problems', 'issues'] },
  create_quality_suite: { action: 'LOW_RISK_WRITE', capabilities: ['quality', 'schedule'], produces: ['quality_suite'], keywords: ['quality check', 'null check', 'unique', 'not null', 'validate', 'test'] },
  run_quality_suite: { action: 'LOW_RISK_WRITE', requires: ['quality_suite'], produces: ['quality_result'] },
  list_reverse_syncs: { produces: ['list'] },
  create_reverse_sync: { action: 'LOW_RISK_WRITE', capabilities: ['activate'], produces: ['reverse_sync'], keywords: ['push to', 'send to', 'salesforce', 'hubspot', 'webhook'] },
  run_reverse_sync: { action: 'EXTERNAL_SIDE_EFFECT', requires: ['reverse_sync'], produces: ['reverse_sync_run'], keywords: ['send data', 'push', 'activate'] },
  list_notebooks: { produces: ['list'] },
  get_notebook: { requires: ['notebook'], produces: ['notebook'] },
  create_notebook: { capabilities: ['document', 'create', 'analytics'], produces: ['notebook'], keywords: ['write up', 'explain', 'analysis', 'report', 'document', 'narrative', 'story'] },
  run_notebook: { requires: ['notebook'], produces: ['notebook'] },
  list_comments: { produces: ['list'] },
  add_comment: { action: 'LOW_RISK_WRITE', produces: ['comment'], keywords: ['note', 'mention', 'reply'] },
  build_dashboard: { category: 'dashboard', capabilities: ['visualise', 'build', 'create'], produces: ['dashboard', 'app'], keywords: ['dashboard', 'executive', 'overview', 'report', 'build me', 'kpis', 'app'] },
  detect_anomalies: { category: 'insight', capabilities: ['analytics', 'anomaly', 'investigate'], produces: ['insight'], requires: ['workspace', 'metric'], keywords: ['anomaly', 'anomalies', 'unusual', 'spike', 'drop', 'outlier', 'why', 'investigate', 'decline'] },
  list_insights: { category: 'insight', produces: ['insight', 'list'], keywords: ['findings', 'unusual', 'changes'] },
  create_metric_monitor: { category: 'insight', action: 'EXTERNAL_SIDE_EFFECT', capabilities: ['monitor', 'schedule'], produces: ['monitor'], keywords: ['watch', 'monitor', 'track'] },
  list_streams: { produces: ['list'] },
  get_usage: { produces: ['usage'], keywords: ['cost', 'spend', 'tokens'] },
  list_templates: { produces: ['list'], keywords: ['starter', 'example'] },
  install_template: { produces: ['dashboard', 'notebook', 'metric'] },
  list_agents: { produces: ['list'] },
  ask_agent: { action: 'EXTERNAL_SIDE_EFFECT', produces: ['answer'], keywords: ['delegate', 'other agent', 'a2a'] },
  list_saved_queries: { category: 'query', capabilities: ['discover', 'reuse'], produces: ['list', 'sql'], keywords: ['saved', 'library', 'existing query'] },
  get_saved_query: { category: 'query', produces: ['sql'] },
  save_query: { category: 'query', capabilities: ['save'], produces: ['saved_query', 'sql'], keywords: ['save', 'keep', 'bookmark'] },
  query_history: { category: 'query', capabilities: ['discover', 'history'], produces: ['list', 'sql'], keywords: ['past', 'previous', 'history', 'who ran', 'failed queries', 'slow queries'] },
  search_workspace: { category: 'catalog', capabilities: ['discover', 'search'], produces: ['list'], keywords: ['find', 'search', 'where', 'related', 'look for', 'which table'], core: true },
  diff_tables: { category: 'catalog', capabilities: ['compare', 'data_read'], produces: ['diff'], keywords: ['compare', 'difference', 'changed', 'versus', 'vs', 'before after'] },
  scan_pii: { capabilities: ['privacy', 'discover'], produces: ['findings'], keywords: ['personal data', 'pii', 'gdpr', 'sensitive', 'email', 'privacy'] },
  find_joins: { category: 'catalog', capabilities: ['relationships', 'discover'], produces: ['relationships', 'sql'], keywords: ['join', 'relationship', 'foreign key', 'related tables', 'connect', 'link'] },
  prepare_data: { action: 'HIGH_RISK_WRITE', mutation: 'conditional', capabilities: ['transform', 'clean'], produces: ['sql', 'query_result'], keywords: ['clean', 'dedupe', 'duplicates', 'reshape', 'fix types', 'trim', 'prepare', 'wrangle'] },
  tag_pii: { produces: ['annotation'] },
  protect_pii: { action: 'HIGH_RISK_WRITE', produces: ['policy'], keywords: ['mask', 'hide', 'protect'] },
  list_watches: { category: 'quality', produces: ['list'] },
  create_watch: { category: 'quality', action: 'LOW_RISK_WRITE', capabilities: ['monitor', 'schedule'], produces: ['watch'], keywords: ['schema drift', 'freshness', 'stale', 'watch'] },
  check_watch: { category: 'quality', produces: ['watch'] },
  list_endpoints: { produces: ['list'] },
  publish_endpoint: { action: 'PUBLISH', produces: ['endpoint'], keywords: ['api', 'endpoint', 'expose', 'http'] },
  search_catalog: { capabilities: ['discover', 'search', 'catalog'], produces: ['list'], keywords: ['find table', 'column', 'description', 'tag', 'related', 'which table'], core: true },
  get_lineage: { capabilities: ['lineage'], produces: ['lineage'], keywords: ['depends', 'upstream', 'downstream', 'comes from', 'impact'] },
  annotate_table: { produces: ['annotation'], keywords: ['document', 'describe', 'description', 'tag'] },
  get_dashboard: { requires: ['dashboard'], produces: ['dashboard'] },
  update_widget: { requires: ['dashboard'], produces: ['widget', 'chart'], keywords: ['change chart', 'bar chart', 'line chart', 'filter', 'modify'] },
  remove_widget: { action: 'HIGH_RISK_WRITE', requires: ['dashboard'], produces: ['dashboard'] },
  define_metric: { category: 'semantic', action: 'HIGH_RISK_WRITE', capabilities: ['semantic', 'define'], produces: ['metric'], keywords: ['define', 'metric', 'kpi', 'measure', 'semantic'] },
  workspace_health: { produces: ['health'], keywords: ['size', 'quota', 'storage', 'status'] },
  list_backups: { produces: ['list'] },
  backup_workspace: { action: 'LOW_RISK_WRITE', produces: ['backup'], keywords: ['snapshot', 'save state'] },
  create_stream: { action: 'HIGH_RISK_WRITE', produces: ['stream'], keywords: ['kafka', 'kinesis', 'real time', 'events'] },
  git_status: { produces: ['changes'] },
  git_commit: { action: 'EXTERNAL_SIDE_EFFECT', produces: ['commit'], keywords: ['push', 'version', 'commit'] },
};

const WORD = /[a-z0-9]+/g;

/** Semantics derived from the tool alone: its name, annotations and inputs. */
export function deriveSemantics(tool: Pick<ToolDef, 'name' | 'annotations' | 'inputSchema'>): ToolSemantics {
  const name = tool.name;
  const readOnly = tool.annotations.readOnlyHint === true;
  const destructive = tool.annotations.destructiveHint === true;
  const category = CATEGORY_BY_NAME.find(([re]) => re.test(name))?.[1] ?? 'workspace';
  const action: ActionClass = readOnly ? 'READ' : destructive ? 'HIGH_RISK_WRITE' : /^publish_/.test(name) ? 'PUBLISH' : 'LOW_RISK_WRITE';
  const inputs = Object.keys(tool.inputSchema);
  const requires = ['workspace'].filter(() => inputs.includes('workspace_id'));
  const verb = name.split('_')[0]!;
  const noun = name.split('_').slice(1).join('_') || name;
  const produces = verb === 'list' ? ['list'] : [noun];
  const capabilities = [readOnly ? 'data_read' : 'create', ...(inputs.includes('sql') ? ['sql'] : [])];
  return { category, action, mutation: readOnly ? 'none' : inputs.includes('dry_run') && destructive ? 'conditional' : 'always', capabilities, requires, produces, keywords: [], core: false };
}

const cache = new WeakMap<object, ToolSemantics>();

/** The tool's complete semantics: derived, then refined. */
export function semanticsOf(tool: Pick<ToolDef, 'name' | 'annotations' | 'inputSchema'>): ToolSemantics {
  const hit = cache.get(tool);
  if (hit) return hit;
  const base = deriveSemantics(tool);
  const r = REFINE[tool.name] ?? {};
  const s: ToolSemantics = { ...base, ...r, requires: r.requires ?? base.requires, capabilities: [...new Set([...(r.capabilities ?? base.capabilities)])], produces: r.produces ?? base.produces, keywords: r.keywords ?? [] };
  // A read-only tool is never classed as a write, whatever a refinement says.
  if (tool.annotations.readOnlyHint === true) s.action = 'READ';
  if (s.action === 'READ' && s.mutation === 'always') s.mutation = 'none';
  cache.set(tool, s);
  return s;
}

/** Tools named in the refinements, for the completeness test. */
export const REFINED_TOOLS = Object.keys(REFINE);

/** Lower-case words of a text, for lexical matching. */
export function words(text: string): string[] {
  return text.toLowerCase().match(WORD) ?? [];
}
