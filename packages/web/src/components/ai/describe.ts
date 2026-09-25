/**
 * Tool calls in words. An agent's call of `execute_query {sql: "SELECT … FROM orders"}` reads as "Ran a query on
 * orders"; the raw name and arguments stay one click away (ToolStep). Unknown tools fall back to their title.
 */
type Args = Record<string, unknown>;

const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v));
/** The first table or file a statement reads. */
export function tableOf(sql: string): string | null {
  const m = /\b(?:from|join|into|update|table)\s+('([^']+)'|"([^"]+)"|([\w.]+))/i.exec(sql);
  return m ? (m[2] ?? m[3] ?? m[4] ?? null) : null;
}
const q = (s: string) => (s ? `“${s}”` : '');

const VERBS: Record<string, (a: Args) => string> = {
  execute_query: (a) => { const t = tableOf(str(a.sql)); return /^\s*(insert|update|delete|create|drop|alter|copy|merge)/i.test(str(a.sql)) ? `Changed data${t ? ` in ${t}` : ''}` : `Ran a query${t ? ` on ${t}` : ''}`; },
  explain_query: (a) => { const t = tableOf(str(a.sql)); return `Explained a query${t ? ` on ${t}` : ''}`; },
  profile_dataset: (a) => `Profiled ${str(a.target) || 'a dataset'}`,
  inspect_schema: (a) => `Read the schema of ${str(a.target) || 'a dataset'}`,
  list_accessible_data: () => 'Listed the data it can reach',
  browse_storage: (a) => `Browsed ${str(a.path) || 'storage'}`,
  save_dataset: (a) => `Saved a dataset${a.name ? ` as ${str(a.name)}` : ''}`,
  lakehouse_query: () => 'Queried a lakehouse table',
  list_dashboards: () => 'Listed the dashboards',
  create_dashboard_widget: (a) => `Added the widget ${q(str(a.title))}`,
  create_mosaic_dashboard: (a) => `Created the dashboard ${q(str(a.name))}`,
  build_dashboard: (a) => `Built the dashboard ${q(str(a.name))}`,
  snapshot_dashboard: () => 'Took a dashboard snapshot',
  list_metrics: () => 'Looked up the metrics',
  query_metrics: (a) => `Computed ${Array.isArray(a.metrics) ? (a.metrics as string[]).join(', ') : 'metrics'}`,
  detect_anomalies: (a) => `Checked ${str(a.metric) || 'a metric'} for unusual values`,
  list_insights: () => 'Read recent insights',
  run_quality_suite: () => 'Ran data quality checks',
  suggest_quality_checks: (a) => `Suggested checks for ${str(a.relation) || 'a table'}`,
  create_quality_suite: (a) => `Created the checks ${q(str(a.name))}`,
  run_data_sync: () => 'Ran a sync',
  create_data_sync: (a) => `Created the sync ${q(str(a.name))}`,
  run_dbt: (a) => `Ran dbt ${str(a.command) || 'build'}`,
  create_dbt_model: (a) => `Wrote the dbt model ${str(a.name)}`,
  run_notebook: () => 'Ran a notebook',
  create_notebook: (a) => `Created the notebook ${q(str(a.title))}`,
  create_app: (a) => `Created the app ${q(str(a.name))}`,
  publish_app: () => 'Published an app',
  create_alert: (a) => `Created the alert ${q(str(a.name))}`,
  run_alert: () => 'Checked an alert',
  ask_agent: (a) => `Asked the agent ${str(a.agent) || str(a.agent_id)}`.trim(),
  add_comment: () => 'Added a comment',
  get_usage: () => 'Looked at usage and cost',
  install_template: (a) => `Installed the template ${str(a.template_id)}`,
  list_templates: () => 'Looked through templates',
  list_saved_queries: (a) => (a.search ? `Looked for saved queries about ${q(str(a.search))}` : 'Listed the saved queries'),
  get_saved_query: (a) => `Read the saved query ${q(str(a.query))}`,
  save_query: (a) => `Saved the query ${q(str(a.name))}`,
  search_catalog: (a) => `Searched the catalog for ${q(str(a.query))}`,
  get_lineage: (a) => (a.object ? `Traced the lineage of ${str(a.object)}` : 'Read the lineage graph'),
  annotate_table: (a) => `Documented ${str(a.object)}${a.column ? `.${str(a.column)}` : ''}`,
  get_dashboard: (a) => `Opened the dashboard ${q(str(a.dashboard))}`,
  update_widget: (a) => `Changed a widget${a.title ? ` to ${q(str(a.title))}` : ''}`,
  remove_widget: () => 'Removed a widget',
  define_metric: () => 'Defined metrics',
  workspace_health: () => 'Checked the workspace health',
  list_backups: () => 'Listed the backups',
  backup_workspace: () => 'Backed up the workspace',
  create_stream: (a) => `Created the stream ${q(str(a.name))}`,
  git_status: () => 'Checked Git for changes',
  search_workspace: (a) => `Searched the workspace for ${q(str(a.query))}`,
  query_history: (a) => (a.search ? `Looked through past queries for ${q(str(a.search))}` : a.slowest ? 'Looked at the slowest past queries' : 'Looked at past queries'),
  git_commit: (a) => `Committed to Git: ${q(str(a.message))}`,
};

export function describeTool(tool: string, args: Args = {}, title?: string | null): string {
  const f = VERBS[tool];
  if (f) {
    try {
      return f(args);
    } catch {
      /* fall through */
    }
  }
  return title || tool.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

/** SQL an agent tried to run, when there is one to show or rerun. */
export const sqlOf = (args: Args): string | null => (typeof args.sql === 'string' && args.sql.trim() ? args.sql : null);

const PRESENT: Record<string, string> = { Ran: 'run', Changed: 'change', Created: 'create', Added: 'add', Built: 'build', Published: 'publish', Wrote: 'write', Installed: 'install', Explained: 'explain', Profiled: 'profile', Read: 'read', Listed: 'list', Browsed: 'browse', Saved: 'save', Queried: 'query', Took: 'take', Looked: 'look', Computed: 'compute', Checked: 'check', Suggested: 'suggest', Asked: 'ask' };

/** What a held call would do, for "An agent wants to …": "change data in orders". */
export function describeIntent(tool: string, args: Args = {}, title?: string | null): string {
  const done = describeTool(tool, args, title);
  const [first, ...rest] = done.split(' ');
  return [PRESENT[first!] ?? first!.charAt(0).toLowerCase() + first!.slice(1), ...rest].join(' ');
}
