/**
 * The agent marketplace: ready-made agents DuckView runs itself. Each is instructions, the read-only tools it may
 * use, the task a scheduled run is given, and a suggested schedule. Installing one creates a hosted agent in a
 * workspace; everything stays editable.
 */
import type { SyncSchedule } from '../db/schema/sqlite.js';

export interface AgentTemplate {
  id: string;
  name: string;
  category: 'Monitoring' | 'Reporting' | 'Data quality' | 'Engineering' | 'Analysis';
  description: string;
  instructions: string;
  task: string;
  tools: string[];
  schedule: SyncSchedule;
  /** What the workspace needs for the agent to be useful. */
  needs: ('metrics' | 'quality' | 'dbt' | 'syncs')[];
}

const daily = (hour: number): SyncSchedule => ({ kind: 'cron', expression: `0 ${hour} * * *` });
const monday = (hour: number): SyncSchedule => ({ kind: 'cron', expression: `0 ${hour} * * 1` });

export const AGENT_TEMPLATES: AgentTemplate[] = [
  {
    id: 'anomaly-investigator',
    name: 'Anomaly investigator',
    category: 'Monitoring',
    description: 'Checks every metric for an unusual day, then digs into what drove each change and writes a short brief.',
    instructions: `You investigate unusual changes in the workspace's metrics.
1. Call detect_anomalies (grain day) to find unusual metrics. If nothing is unusual, say so in one sentence and stop.
2. For each unusual metric (at most 3), break it down with query_metrics by its categorical dimensions for the last 14 days (list_metrics shows the dimensions) to find where the change is concentrated.
3. Write a brief: one heading per metric, what happened (numbers, versus usual), where it came from, and one suggested next check. No speculation beyond the data.`,
    task: 'What changed yesterday, and why?',
    tools: ['detect_anomalies', 'list_insights', 'list_metrics', 'query_metrics', 'execute_query', 'inspect_schema'],
    schedule: daily(7),
    needs: ['metrics'],
  },
  {
    id: 'weekly-business-review',
    name: 'Weekly business review',
    category: 'Reporting',
    description: 'Every Monday: the key metrics for last week against the week before and the four-week average, with the notable movers.',
    instructions: `You write the weekly business review from the semantic layer's metrics.
1. list_metrics, then pick up to 6 headline metrics (revenue, orders, users, conversion and the like).
2. query_metrics with group_by metric_time__week for the last 6 complete weeks.
3. For the two most important metrics, find the biggest movers with a breakdown by their main dimension.
4. Write: a 3-sentence summary, a markdown table (metric, last week, previous week, change %, 4-week average), then "Notable" bullets. Use exact numbers from the tools.`,
    task: 'Write the weekly business review for last week.',
    tools: ['list_metrics', 'query_metrics', 'detect_anomalies', 'list_insights'],
    schedule: monday(8),
    needs: ['metrics'],
  },
  {
    id: 'data-quality-auditor',
    name: 'Data quality auditor',
    category: 'Data quality',
    description: 'Reviews the quality checks and the tables without any, and proposes the checks that are missing.',
    instructions: `You audit data quality in the workspace.
1. list_quality_suites: report failing or erroring checks first, with the failing-row counts.
2. list_accessible_data: find the most important tables that have no quality suite (fact tables, tables used by dashboards).
3. For up to 3 of them, suggest_quality_checks and list the proposed checks.
Write: "Failing now", "Tables without checks", "Suggested checks" (as a list per table). Do not invent checks the tools did not propose.`,
    task: 'Audit the data quality of this workspace.',
    tools: ['list_quality_suites', 'suggest_quality_checks', 'list_accessible_data', 'inspect_schema', 'profile_dataset', 'list_dashboards'],
    schedule: daily(6),
    needs: [],
  },
  {
    id: 'pipeline-watcher',
    name: 'Pipeline watcher',
    category: 'Engineering',
    description: 'A morning summary of what broke overnight: syncs, dbt runs, quality checks, alerts and reverse syncs.',
    instructions: `You watch the workspace's data pipelines.
Call list_data_sources, list_dbt_projects (then get_dbt_run for projects whose last run failed), list_quality_suites, list_alerts and list_reverse_syncs.
Report only what needs attention: failed or stale syncs, failed dbt models and tests, failing quality checks, triggered alerts, failed reverse syncs — each with the error and the object's name. If everything is healthy, say so in one line.`,
    task: 'What needs attention in the pipelines this morning?',
    tools: ['list_data_sources', 'list_dbt_projects', 'get_dbt_project', 'get_dbt_run', 'list_quality_suites', 'list_alerts', 'list_reverse_syncs'],
    schedule: daily(7),
    needs: [],
  },
  {
    id: 'catalog-writer',
    name: 'Catalog writer',
    category: 'Engineering',
    description: 'Profiles tables and drafts plain-language descriptions of each table and column for the catalog.',
    instructions: `You document tables for the data catalog.
list_accessible_data, then for up to 5 tables (the task may name them) inspect_schema and profile_dataset.
For each table write a one-sentence description and a markdown table of columns: name, type, what it holds (inferred from names, types and the profile: ranges, distinct counts, nulls). Mark guesses with "(likely)".`,
    task: 'Draft catalog descriptions for the main tables.',
    tools: ['list_accessible_data', 'inspect_schema', 'profile_dataset', 'execute_query'],
    schedule: { kind: 'manual' },
    needs: [],
  },
  {
    id: 'dbt-reviewer',
    name: 'dbt reviewer',
    category: 'Engineering',
    description: 'Reviews the dbt projects: failing models and tests, models without tests or docs, and slow models.',
    instructions: `You review the workspace's dbt projects.
list_dbt_projects, get_dbt_project for each (at most 3), and get_dbt_run for the latest run.
Report: failures with their messages, the slowest models, models without tests, models without descriptions. Suggest concrete fixes (a test to add, a model to materialise differently).`,
    task: 'Review the dbt projects.',
    tools: ['list_dbt_projects', 'get_dbt_project', 'get_dbt_run', 'list_quality_suites'],
    schedule: monday(7),
    needs: ['dbt'],
  },
  {
    id: 'data-analyst',
    name: 'Data analyst',
    category: 'Analysis',
    description: 'Answers questions about the workspace\'s data with SQL and the metrics — for people and for other agents over A2A.',
    instructions: `You are a careful data analyst for this workspace.
Prefer the semantic layer's metrics (list_metrics, query_metrics) when they answer the question; otherwise find the tables (list_accessible_data, inspect_schema) and use execute_query with read-only DuckDB SQL, aggregating in SQL.
Answer with the numbers first, then how you got them (the metric or the SQL), then caveats. Never make numbers up.`,
    task: 'Give a one-paragraph overview of what data this workspace holds and its headline numbers.',
    tools: ['list_accessible_data', 'inspect_schema', 'profile_dataset', 'execute_query', 'explain_query', 'list_metrics', 'query_metrics', 'detect_anomalies', 'list_dashboards'],
    schedule: { kind: 'manual' },
    needs: [],
  },
];

export const templateById = (id: string) => AGENT_TEMPLATES.find((t) => t.id === id) ?? null;
