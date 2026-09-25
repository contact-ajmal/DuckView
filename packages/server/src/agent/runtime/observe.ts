/**
 * From a tool result to what the agent keeps: structured observations (facts it learned — a table's columns, a
 * query's shape, the metric it used, an error) and artifacts (things the person can open: a result table, SQL, a
 * dashboard, a notebook…). Observations are separate from raw output: they are what later steps and later tasks see.
 */
import type { AgentArtifact, AgentArtifactType } from '../../db/schema/sqlite.js';
import type { ToolResult } from '../tools.js';
import { newId } from '../../security/crypto.js';

export interface ObservationDraft {
  kind: 'schema' | 'result' | 'metric' | 'relationship' | 'quality' | 'artifact' | 'error' | 'note';
  subject: string | null;
  text: string;
  data: Record<string, unknown> | null;
}

type SC = Record<string, unknown> & { columns?: { name: string; type?: string }[]; rows?: unknown[][]; row_count?: number; total_rows?: number; sql?: string };

const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v));
const cols = (sc: SC) => (Array.isArray(sc.columns) ? sc.columns.map((c) => (typeof c === 'string' ? c : c.name)) : []);
const firstLine = (r: ToolResult) => (r.content.find((c) => c.type === 'text') as { text: string } | undefined)?.text.split('\n').find((l) => l.trim() && !/^(\||```|[-:| ]+$)/.test(l.trim()))?.trim().slice(0, 240) ?? '';

/** What a successful or failed call taught the agent. */
export function observe(tool: string, args: Record<string, unknown>, result: ToolResult): ObservationDraft[] {
  const sc = (result.structuredContent ?? {}) as SC;
  if (result.isError) return [{ kind: 'error', subject: str(args.file_path_or_table ?? args.table ?? args.table_or_path ?? args.dashboard ?? '') || null, text: `${tool} failed: ${str(sc.message ?? firstLine(result)).slice(0, 400)}`, data: { code: sc.code ?? null } }];
  switch (tool) {
    case 'inspect_schema': {
      const subject = str(args.file_path_or_table);
      const c = Array.isArray(sc.columns) ? (sc.columns as { name: string; type: string }[]) : [];
      return [{ kind: 'schema', subject, text: `${subject} has columns ${c.map((x) => `${x.name} ${x.type}`).join(', ').slice(0, 800)}`, data: { columns: c } }];
    }
    case 'profile_dataset': {
      const subject = str(args.table_or_path);
      return [{ kind: 'schema', subject, text: `Profiled ${subject}: ${firstLine(result)}`, data: null }];
    }
    case 'execute_query':
    case 'connector_query':
    case 'lakehouse_query': {
      const n = sc.row_count ?? sc.total_rows ?? sc.rows?.length ?? 0;
      return [{ kind: 'result', subject: null, text: `A query returned ${n} row${n === 1 ? '' : 's'} (${cols(sc).join(', ')})${sc.rows?.length ? `; first row: ${JSON.stringify(sc.rows[0]).slice(0, 200)}` : ''}`, data: { sql: str(args.sql).slice(0, 2000), columns: cols(sc), row_count: n } }];
    }
    case 'query_metrics': {
      const metrics = (args.metrics as string[] | undefined) ?? [];
      return [{ kind: 'metric', subject: metrics.join(', '), text: `Used the canonical metric${metrics.length === 1 ? '' : 's'} ${metrics.join(', ')}${Array.isArray(args.group_by) && args.group_by.length ? ` by ${(args.group_by as string[]).join(', ')}` : ''}: ${sc.rows?.length ?? 0} rows`, data: { metrics, group_by: args.group_by ?? [], sql: sc.sql ?? null } }];
    }
    case 'list_metrics':
      return [{ kind: 'metric', subject: null, text: `Metrics defined: ${firstLine(result)}`.slice(0, 400), data: null }];
    case 'find_joins':
      return [{ kind: 'relationship', subject: Array.isArray(args.tables) ? (args.tables as string[]).join(', ') : null, text: firstLine(result), data: null }];
    case 'suggest_quality_checks':
    case 'run_quality_suite':
    case 'list_quality_suites':
      return [{ kind: 'quality', subject: str(args.table ?? args.suite_id) || null, text: firstLine(result), data: null }];
    default:
      return [{ kind: 'note', subject: null, text: `${tool}: ${firstLine(result)}`.slice(0, 300), data: null }];
  }
}

/** Things a call made or found that the person can open. */
export function artifactsOf(tool: string, args: Record<string, unknown>, result: ToolResult, maxRows: number): AgentArtifact[] {
  if (result.isError) return [];
  const sc = (result.structuredContent ?? {}) as SC & Record<string, any>;
  const now = new Date().toISOString();
  const a = (type: AgentArtifactType, title: string, extra: Partial<AgentArtifact> = {}): AgentArtifact => ({ id: newId(), type, title, tool, created_at: now, href: null, ...extra });
  switch (tool) {
    case 'execute_query':
    case 'query_metrics':
    case 'connector_query':
    case 'lakehouse_query': {
      const sql = str(sc.sql ?? args.sql);
      if (!Array.isArray(sc.columns)) return [];
      const title = tool === 'query_metrics' ? `${((args.metrics as string[]) ?? []).join(', ')}${Array.isArray(args.group_by) && args.group_by.length ? ` by ${(args.group_by as string[]).join(', ')}` : ''}` : 'Query result';
      return [a('table', title, { data: { sql, columns: sc.columns, rows: (sc.rows ?? []).slice(0, maxRows), row_count: sc.row_count ?? sc.total_rows ?? sc.rows?.length ?? 0, truncated: (sc.rows?.length ?? 0) > maxRows } })];
    }
    case 'create_dashboard_widget':
    case 'build_dashboard':
    case 'create_mosaic_dashboard': {
      const id = str(sc.dashboard_id ?? sc.dashboard?.id ?? sc.id);
      if (!id) return [];
      return [a('dashboard', str(sc.dashboard_name ?? sc.dashboard?.name ?? sc.name ?? args.dashboard_name ?? args.name ?? 'Dashboard'), { href: `#/dashboards/${id}`, data: { id } })];
    }
    case 'update_widget': {
      const id = str(sc.dashboard_id);
      return id ? [a('chart', str(args.title ?? 'Widget'), { href: `#/dashboards/${id}`, data: { id, widget_id: args.widget_id } })] : [];
    }
    case 'create_notebook': {
      const id = str(sc.notebook_id ?? sc.id ?? sc.notebook?.id);
      return id ? [a('notebook', str(args.title ?? 'Notebook'), { href: `#/notebooks/${id}`, data: { id } })] : [];
    }
    case 'create_app': {
      const id = str(sc.app_id ?? sc.id ?? sc.app?.id);
      return id ? [a('app', str(args.name ?? 'Data app'), { href: `#/apps/${id}`, data: { id } })] : [];
    }
    case 'create_quality_suite': {
      const id = str(sc.suite_id ?? sc.id ?? sc.suite?.id);
      return [a('quality_suite', str(args.name ?? `Checks on ${str(args.table)}`), { href: '#/transform/quality', data: { id: id || null, table: args.table } })];
    }
    case 'create_dbt_model':
      return [a('dbt_model', str(args.name), { href: '#/transform/dbt', data: { path: sc.path ?? null, sql: sc.sql ?? null, project_id: args.project_id } })];
    case 'define_metric':
      return [a('metric', 'Metrics', { href: '#/transform/metrics', data: {} })];
    case 'save_query': {
      const id = str(sc.query_id ?? sc.id ?? sc.query?.id);
      return [a('saved_query', str(args.name), { data: { id: id || null, sql: args.sql } })];
    }
    case 'save_dataset':
      return [a('file', str(sc.path ?? args.target_filename ?? 'Export'), { data: { path: sc.path ?? null } })];
    default:
      return [];
  }
}
