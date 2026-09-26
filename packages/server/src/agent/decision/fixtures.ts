/**
 * Evaluation fixtures for Decision Engines: realistic DuckView requests over a small synthetic workspace, with the
 * tools and context objects a good engine must pick. Each `tools` entry is a group of acceptable alternatives (any
 * one of them satisfies it); every group must be satisfied. The same fixtures score any engine (evaluator.ts).
 */
import type { ContextObject } from '../context/types.js';
import type { Intent } from './types.js';

export interface DecisionFixture {
  request: string;
  intent?: Intent;
  page?: { kind: string; id?: string; label: string };
  tools: string[][];
  context?: string[][];
}

const now = new Date(0).toISOString();
const o = (id: string, type: ContextObject['type'], title: string, text: string): ContextObject => ({ id, type, workspaceId: 'eval', source: 'fixture', title, text, content: null, metadata: {}, timestamp: now });

/** The synthetic workspace every fixture is decided against. */
export const EVAL_CATALOG: ContextObject[] = [
  o('table:customer_orders', 'table', 'customer_orders', 'table customer_orders (~1,200,000 rows) — one row per order\n  columns: order_id INTEGER; customer_id INTEGER; order_date DATE; region VARCHAR; product VARCHAR; revenue DECIMAL(12,2); status VARCHAR'),
  o('table:customers', 'table', 'customers', 'table customers (~80,000 rows) — one row per customer\n  columns: customer_id INTEGER; email VARCHAR [pii]; name VARCHAR; country VARCHAR; segment VARCHAR; signup_date DATE'),
  o('table:subscriptions', 'table', 'subscriptions', 'table subscriptions — plans and renewals\n  columns: subscription_id INTEGER; customer_id INTEGER; plan VARCHAR; mrr DECIMAL(10,2); started_at DATE; cancelled_at DATE'),
  o('table:churn_scores', 'table', 'churn_scores', 'table churn_scores — model output\n  columns: customer_id INTEGER; churn_probability DOUBLE; scored_at TIMESTAMP'),
  o('table:player_tracking', 'table', 'player_tracking', 'table player_tracking — positions from match tracking cameras\n  columns: match_id INTEGER; player_id INTEGER; ts TIMESTAMP; x DOUBLE; y DOUBLE; speed DOUBLE'),
  o('table:matches', 'table', 'matches', 'table matches\n  columns: match_id INTEGER; venue VARCHAR; played_on DATE; home VARCHAR; away VARCHAR'),
  o('table:inventory', 'table', 'inventory', 'table inventory\n  columns: sku VARCHAR; warehouse VARCHAR; stock INTEGER; updated_at TIMESTAMP'),
  o('table:web_events', 'table', 'web_events', 'table web_events (~40,000,000 rows)\n  columns: event_id VARCHAR; user_id VARCHAR; event VARCHAR; page VARCHAR; ts TIMESTAMP'),
  o('file:exports/finance_2025.parquet', 'file', 'exports/finance_2025.parquet', "file 'exports/finance_2025.parquet'"),
  o('metric:revenue', 'metric', 'Revenue', 'metric revenue ("Revenue") — completed order revenue; simple (measure revenue); group by: metric_time, region, product, customer__segment'),
  o('metric:arr', 'metric', 'Annual recurring revenue', 'metric arr ("Annual recurring revenue") — 12 × active MRR; derived: mrr * 12; group by: metric_time, plan, customer__segment'),
  o('metric:churn_rate', 'metric', 'Churn rate', 'metric churn_rate ("Churn rate") — cancelled / active subscriptions; ratio; group by: metric_time, plan'),
  o('dashboard:d1', 'dashboard', 'Revenue overview', 'dashboard "Revenue overview" (id d1) — revenue by region and month'),
  o('dashboard:d2', 'dashboard', 'Customer health', 'dashboard "Customer health" (id d2) — churn and retention'),
  o('notebook:n1', 'notebook', 'Q3 pricing analysis', 'notebook "Q3 pricing analysis" (id n1, 14 cells)'),
  o('saved_query:q1', 'saved_query', 'Top customers', 'saved query "Top customers": SELECT customer_id, sum(revenue) FROM customer_orders GROUP BY 1 ORDER BY 2 DESC LIMIT 20'),
  o('quality_suite:s1', 'quality_suite', 'Orders checks', 'quality suite "Orders checks" on customer_orders: 6 checks, status warn'),
];

export const DECISION_FIXTURES: DecisionFixture[] = [
  { request: 'Find revenue by region', intent: 'discover', tools: [['query_metrics', 'execute_query']], context: [['metric:revenue', 'table:customer_orders']] },
  { request: 'Compare revenue by region', intent: 'analyse', tools: [['query_metrics', 'execute_query']], context: [['metric:revenue']] },
  { request: 'Create a customer churn dashboard', intent: 'build', tools: [['build_dashboard', 'create_dashboard_widget']], context: [['metric:churn_rate', 'table:churn_scores']] },
  { request: 'Why did revenue drop last month?', intent: 'investigate', tools: [['detect_anomalies'], ['query_metrics']], context: [['metric:revenue']] },
  { request: 'Find tables containing player tracking data', intent: 'discover', tools: [['search_catalog', 'search_workspace']], context: [['table:player_tracking']] },
  { request: 'Create a quality check for null customer IDs', intent: 'quality', tools: [['create_quality_suite', 'suggest_quality_checks']], context: [['table:customers', 'table:customer_orders']] },
  { request: "What's ARR?", intent: 'explain', tools: [['list_metrics', 'query_metrics']], context: [['metric:arr']] },
  { request: 'Use the semantic definition for ARR rather than calculating it yourself', tools: [['query_metrics']], context: [['metric:arr']] },
  { request: 'Create a dbt model from this', intent: 'transform', tools: [['create_dbt_model']] },
  { request: 'Build a small data app for the sales team', intent: 'build', tools: [['create_app', 'build_dashboard']] },
  { request: 'Create a notebook explaining this analysis', tools: [['create_notebook']] },
  { request: 'Export the result as parquet', tools: [['save_dataset']] },
  { request: 'Find personal data in the customers table', tools: [['scan_pii']], context: [['table:customers']] },
  { request: 'How do orders join to customers?', tools: [['find_joins']], context: [['table:customer_orders'], ['table:customers']] },
  { request: 'Turn this into a bar chart', intent: 'modify', page: { kind: 'dashboard', id: 'd1', label: 'Revenue overview' }, tools: [['update_widget', 'create_dashboard_widget']] },
  { request: "Compare this month's signups with last month", tools: [['execute_query', 'query_metrics']], context: [['table:customers', 'table:subscriptions']] },
  { request: 'Show me the SQL behind the Revenue overview dashboard', tools: [['get_dashboard']], context: [['dashboard:d1']] },
  { request: 'Profile the web events table', tools: [['profile_dataset']], context: [['table:web_events']] },
  { request: 'Clean the duplicates out of inventory', intent: 'transform', tools: [['prepare_data']], context: [['table:inventory']] },
  { request: 'Alert me when daily revenue drops below 1000', tools: [['create_alert']], context: [['metric:revenue', 'table:customer_orders']] },
  { request: 'Publish revenue by region as an API', tools: [['publish_endpoint']] },
  { request: 'Watch the orders table for schema changes', tools: [['create_watch']], context: [['table:customer_orders']] },
];
