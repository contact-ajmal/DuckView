/**
 * The templates DuckView ships with. Each names the tables it reads as {{table:<name>}} (mapped to a workspace's own
 * tables at install time) and carries sample data, so it can be tried in an empty workspace.
 */
import type { TemplateBody } from '../db/schema/sqlite.js';

export interface BuiltinTemplate {
  id: string;
  name: string;
  description: string;
  category: string;
  tags: string[];
  body: TemplateBody;
}

const ecommerce: BuiltinTemplate = {
  id: 'builtin:ecommerce',
  name: 'E-commerce sales',
  description: 'Revenue, orders and average order value by month and region, the best customers, refunds, with metrics and data quality checks on the orders table.',
  category: 'Sales',
  tags: ['revenue', 'orders', 'customers'],
  body: {
    tables: [
      {
        name: 'orders',
        description: 'One row per order',
        columns: [
          { name: 'order_id', type: 'BIGINT' },
          { name: 'customer_id', type: 'INTEGER' },
          { name: 'order_date', type: 'DATE' },
          { name: 'status', type: 'VARCHAR' },
          { name: 'amount', type: 'DOUBLE' },
          { name: 'region', type: 'VARCHAR' },
        ],
        sample_sql: `SELECT i::BIGINT AS order_id,
  (1 + hash(i * 7 + 1) % 400)::INTEGER AS customer_id,
  current_date - (hash(i * 11 + 2) % 365)::INTEGER AS order_date,
  (['complete', 'complete', 'complete', 'complete', 'refunded', 'pending'])[1 + (hash(i * 13 + 3) % 6)::INTEGER] AS status,
  round(8 + (hash(i * 17 + 4) % 25000) / 100.0, 2)::DOUBLE AS amount,
  (['EU', 'US', 'APAC', 'LATAM'])[1 + (hash(i * 19 + 5) % 4)::INTEGER] AS region
FROM range(1, 6001) t(i)`,
      },
      {
        name: 'customers',
        description: 'One row per customer',
        columns: [
          { name: 'customer_id', type: 'INTEGER' },
          { name: 'name', type: 'VARCHAR' },
          { name: 'signup_date', type: 'DATE' },
          { name: 'tier', type: 'VARCHAR' },
        ],
        sample_sql: `SELECT i::INTEGER AS customer_id,
  'Customer ' || i AS name,
  current_date - (365 + hash(i * 23 + 6) % 700)::INTEGER AS signup_date,
  (['standard', 'standard', 'silver', 'gold'])[1 + (hash(i * 29 + 7) % 4)::INTEGER] AS tier
FROM range(1, 401) t(i)`,
      },
    ],
    queries: [
      { key: 'kpis', name: 'Last 30 days', description: 'Revenue, orders and average order value of completed orders in the last 30 days', sql: `SELECT sum(amount) AS revenue, count(*) AS orders, round(avg(amount), 2) AS aov
FROM {{table:orders}}
WHERE status = 'complete' AND order_date >= current_date - INTERVAL 30 DAY` },
      { key: 'revenue_by_month', name: 'Revenue by month', sql: `SELECT date_trunc('month', order_date)::DATE AS month, sum(amount) AS revenue, count(*) AS orders
FROM {{table:orders}}
WHERE status = 'complete'
GROUP BY 1
ORDER BY 1` },
      { key: 'revenue_by_region', name: 'Revenue by region', sql: `SELECT region, sum(amount) AS revenue
FROM {{table:orders}}
WHERE status = 'complete'
GROUP BY 1
ORDER BY 2 DESC` },
      { key: 'top_customers', name: 'Top customers', sql: `SELECT c.name, c.tier, count(*) AS orders, sum(o.amount) AS revenue
FROM {{table:orders}} o
JOIN {{table:customers}} c ON c.customer_id = o.customer_id
WHERE o.status = 'complete'
GROUP BY 1, 2
ORDER BY revenue DESC
LIMIT 20` },
      { key: 'refund_rate', name: 'Refund rate by month', sql: `SELECT date_trunc('month', order_date)::DATE AS month,
  round(100.0 * count(*) FILTER (WHERE status = 'refunded') / count(*), 1) AS refund_rate_pct
FROM {{table:orders}}
GROUP BY 1
ORDER BY 1` },
    ],
    dashboards: [
      {
        name: 'Sales overview',
        description: 'Revenue, orders and customers at a glance',
        widgets: [
          { title: 'Revenue (30 days)', widget_type: 'KPI', query: 'kpis', chart_config: { value: 'revenue', format: 'currency' }, w: 4, h: 2 },
          { title: 'Orders (30 days)', widget_type: 'KPI', query: 'kpis', chart_config: { value: 'orders', format: 'number' }, w: 4, h: 2 },
          { title: 'Average order value', widget_type: 'KPI', query: 'kpis', chart_config: { value: 'aov', format: 'currency' }, w: 4, h: 2 },
          { title: 'Revenue by month', widget_type: 'CHART', query: 'revenue_by_month', chart_config: { chart: 'line', x: 'month', y: ['revenue'] }, w: 8, h: 4 },
          { title: 'Revenue by region', widget_type: 'CHART', query: 'revenue_by_region', chart_config: { chart: 'bar', x: 'region', y: ['revenue'] }, w: 4, h: 4 },
          { title: 'Top customers', widget_type: 'TABLE', query: 'top_customers', chart_config: { page_size: 10 }, w: 8, h: 5 },
          { title: 'Refund rate', widget_type: 'CHART', query: 'refund_rate', chart_config: { chart: 'line', x: 'month', y: ['refund_rate_pct'] }, w: 4, h: 5 },
        ],
      },
    ],
    notebooks: [
      {
        title: 'Revenue deep dive',
        cells: [
          { type: 'markdown', source: '# Revenue deep dive\nMonthly revenue by region, and how each region grew on the month before.' },
          { type: 'sql', name: 'monthly', source: `SELECT date_trunc('month', order_date)::DATE AS month, region, sum(amount) AS revenue
FROM {{table:orders}}
WHERE status = 'complete'
GROUP BY 1, 2` },
          { type: 'sql', name: 'growth', source: `SELECT month, region, revenue,
  round(100.0 * (revenue / lag(revenue) OVER (PARTITION BY region ORDER BY month) - 1), 1) AS growth_pct
FROM monthly
ORDER BY region, month` },
        ],
      },
    ],
    semantic: `semantic_models:
  - name: orders
    table: {{table:orders}}
    description: One row per order
    default_time_dimension: order_date
    entities:
      - { name: order, type: primary, expr: order_id }
      - { name: customer, type: foreign, expr: customer_id }
    dimensions:
      - { name: order_date, type: time, granularity: day }
      - { name: region, type: categorical }
      - { name: status, type: categorical }
    measures:
      - { name: revenue, agg: sum, expr: amount }
      - { name: order_count, agg: count }
metrics:
  - { name: revenue, label: Revenue, type: simple, measure: revenue, filter: "{{ Dimension('order__status') }} = 'complete'" }
  - { name: orders, label: Orders, type: simple, measure: order_count }
  - { name: average_order_value, label: Average order value, type: ratio, numerator: revenue, denominator: orders }
`,
    quality: [
      {
        name: 'Orders checks',
        relation: '{{table:orders}}',
        checks: [
          { id: 'order_id_not_null', type: 'not_null', column: 'order_id', severity: 'error' },
          { id: 'order_id_unique', type: 'unique', column: 'order_id', severity: 'error' },
          { id: 'status_values', type: 'accepted_values', column: 'status', values: ['complete', 'refunded', 'pending', 'cancelled'], severity: 'warn' },
          { id: 'amount_positive', type: 'range', column: 'amount', min: 0, severity: 'error' },
        ],
      },
    ],
  },
};

const saas: BuiltinTemplate = {
  id: 'builtin:saas',
  name: 'SaaS subscriptions',
  description: 'Monthly recurring revenue, active subscriptions, churn and plan mix from a subscriptions table.',
  category: 'Finance',
  tags: ['mrr', 'churn', 'subscriptions'],
  body: {
    tables: [
      {
        name: 'subscriptions',
        description: 'One row per subscription; cancelled_at is empty while it is active',
        columns: [
          { name: 'subscription_id', type: 'BIGINT' },
          { name: 'customer_id', type: 'INTEGER' },
          { name: 'plan', type: 'VARCHAR' },
          { name: 'mrr', type: 'DOUBLE' },
          { name: 'started_at', type: 'DATE' },
          { name: 'cancelled_at', type: 'DATE' },
        ],
        sample_sql: `SELECT subscription_id, customer_id, plan,
  CASE plan WHEN 'Starter' THEN 29 WHEN 'Team' THEN 99 ELSE 299 END::DOUBLE AS mrr,
  started_at,
  CASE WHEN churns AND started_at + lifetime <= current_date THEN started_at + lifetime END AS cancelled_at
FROM (
  SELECT i::BIGINT AS subscription_id, i::INTEGER AS customer_id,
    (['Starter', 'Starter', 'Team', 'Team', 'Business'])[1 + (hash(i * 31 + 1) % 5)::INTEGER] AS plan,
    current_date - (hash(i * 37 + 2) % 720)::INTEGER AS started_at,
    hash(i * 41 + 3) % 4 = 0 AS churns,
    (30 + hash(i * 43 + 4) % 400)::INTEGER AS lifetime
  FROM range(1, 1501) t(i)
)`,
      },
    ],
    queries: [
      { key: 'current', name: 'Current MRR', sql: `SELECT sum(mrr) AS mrr, count(*) AS active_subscriptions, round(sum(mrr) / count(*), 2) AS arpa
FROM {{table:subscriptions}}
WHERE cancelled_at IS NULL` },
      { key: 'mrr_by_month', name: 'MRR by month', sql: `WITH months AS (
  SELECT unnest(generate_series(date_trunc('month', current_date - INTERVAL 11 MONTH), date_trunc('month', current_date), INTERVAL 1 MONTH))::DATE AS month
)
SELECT m.month, sum(s.mrr) AS mrr, count(*) AS active_subscriptions
FROM months m
JOIN {{table:subscriptions}} s ON s.started_at <= last_day(m.month) AND (s.cancelled_at IS NULL OR s.cancelled_at > last_day(m.month))
GROUP BY 1
ORDER BY 1` },
      { key: 'churn_by_month', name: 'Churn by month', sql: `SELECT date_trunc('month', cancelled_at)::DATE AS month, count(*) AS cancelled, sum(mrr) AS churned_mrr
FROM {{table:subscriptions}}
WHERE cancelled_at IS NOT NULL
GROUP BY 1
ORDER BY 1` },
      { key: 'plan_mix', name: 'Plan mix', sql: `SELECT plan, count(*) AS active_subscriptions, sum(mrr) AS mrr
FROM {{table:subscriptions}}
WHERE cancelled_at IS NULL
GROUP BY 1
ORDER BY mrr DESC` },
    ],
    dashboards: [
      {
        name: 'Subscription metrics',
        widgets: [
          { title: 'MRR', widget_type: 'KPI', query: 'current', chart_config: { value: 'mrr', format: 'currency' }, w: 4, h: 2 },
          { title: 'Active subscriptions', widget_type: 'KPI', query: 'current', chart_config: { value: 'active_subscriptions', format: 'number' }, w: 4, h: 2 },
          { title: 'Revenue per account', widget_type: 'KPI', query: 'current', chart_config: { value: 'arpa', format: 'currency' }, w: 4, h: 2 },
          { title: 'MRR by month', widget_type: 'CHART', query: 'mrr_by_month', chart_config: { chart: 'area', x: 'month', y: ['mrr'] }, w: 8, h: 4 },
          { title: 'Plan mix', widget_type: 'CHART', query: 'plan_mix', chart_config: { chart: 'pie', x: 'plan', y: ['mrr'] }, w: 4, h: 4 },
          { title: 'Churned MRR', widget_type: 'CHART', query: 'churn_by_month', chart_config: { chart: 'bar', x: 'month', y: ['churned_mrr'] }, w: 12, h: 4 },
        ],
      },
    ],
    notebooks: [],
    semantic: `semantic_models:
  - name: subscriptions
    table: {{table:subscriptions}}
    default_time_dimension: started_at
    entities:
      - { name: subscription, type: primary, expr: subscription_id }
    dimensions:
      - { name: started_at, type: time, granularity: day }
      - { name: plan, type: categorical }
    measures:
      - { name: new_mrr, agg: sum, expr: mrr }
      - { name: new_subscriptions, agg: count }
metrics:
  - { name: new_mrr, label: New MRR, type: simple, measure: new_mrr }
  - { name: new_subscriptions, label: New subscriptions, type: simple, measure: new_subscriptions }
`,
    quality: [
      {
        name: 'Subscription checks',
        relation: '{{table:subscriptions}}',
        checks: [
          { id: 'id_unique', type: 'unique', column: 'subscription_id', severity: 'error' },
          { id: 'mrr_range', type: 'range', column: 'mrr', min: 0, severity: 'error' },
          { id: 'dates_in_order', type: 'expression', expression: 'cancelled_at IS NULL OR cancelled_at >= started_at', severity: 'error' },
        ],
      },
    ],
  },
};

const web: BuiltinTemplate = {
  id: 'builtin:web-analytics',
  name: 'Web analytics',
  description: 'Daily active users, top pages, devices, countries and a signup-to-purchase funnel from an events table.',
  category: 'Product',
  tags: ['events', 'traffic', 'funnel'],
  body: {
    tables: [
      {
        name: 'events',
        description: 'One row per tracked event',
        columns: [
          { name: 'event_time', type: 'TIMESTAMP' },
          { name: 'user_id', type: 'VARCHAR' },
          { name: 'session_id', type: 'VARCHAR' },
          { name: 'event_name', type: 'VARCHAR' },
          { name: 'page', type: 'VARCHAR' },
          { name: 'country', type: 'VARCHAR' },
          { name: 'device', type: 'VARCHAR' },
        ],
        sample_sql: `SELECT CAST(current_date AS TIMESTAMP) - to_seconds((hash(i // 8 * 3 + 1) % 2592000)::BIGINT) + to_seconds((i % 8) * 40) AS event_time,
  'u' || (hash(i // 8 * 5 + 2) % 1500) AS user_id,
  's' || (i // 8) AS session_id,
  (['page_view', 'page_view', 'page_view', 'page_view', 'click', 'click', 'signup', 'purchase'])[1 + (hash(i * 7 + 3) % 8)::INTEGER] AS event_name,
  (['/', '/pricing', '/docs', '/blog', '/signup', '/checkout'])[1 + (hash(i * 11 + 4) % 6)::INTEGER] AS page,
  (['US', 'DE', 'FR', 'IN', 'BR', 'JP'])[1 + (hash(i // 8 * 13 + 5) % 6)::INTEGER] AS country,
  (['desktop', 'desktop', 'mobile', 'tablet'])[1 + (hash(i // 8 * 17 + 6) % 4)::INTEGER] AS device
FROM range(0, 20000) t(i)`,
      },
    ],
    queries: [
      { key: 'dau', name: 'Daily active users', sql: `SELECT event_time::DATE AS day, count(DISTINCT user_id) AS users, count(DISTINCT session_id) AS sessions
FROM {{table:events}}
GROUP BY 1
ORDER BY 1` },
      { key: 'top_pages', name: 'Top pages', sql: `SELECT page, count(*) AS views, count(DISTINCT user_id) AS users
FROM {{table:events}}
WHERE event_name = 'page_view'
GROUP BY 1
ORDER BY views DESC
LIMIT 20` },
      { key: 'devices', name: 'Sessions by device', sql: `SELECT device, count(DISTINCT session_id) AS sessions
FROM {{table:events}}
GROUP BY 1
ORDER BY 2 DESC` },
      { key: 'funnel', name: 'Signup funnel', sql: `SELECT step, users FROM (
  SELECT 1 AS n, 'Visited' AS step, count(DISTINCT user_id) AS users FROM {{table:events}}
  UNION ALL SELECT 2, 'Signed up', count(DISTINCT user_id) FROM {{table:events}} WHERE event_name = 'signup'
  UNION ALL SELECT 3, 'Purchased', count(DISTINCT user_id) FROM {{table:events}} WHERE event_name = 'purchase'
)
ORDER BY n` },
      { key: 'countries', name: 'Users by country', sql: `SELECT country, count(DISTINCT user_id) AS users
FROM {{table:events}}
GROUP BY 1
ORDER BY 2 DESC` },
    ],
    dashboards: [
      {
        name: 'Web traffic',
        widgets: [
          { title: 'Daily active users', widget_type: 'CHART', query: 'dau', chart_config: { chart: 'line', x: 'day', y: ['users', 'sessions'] }, w: 12, h: 4 },
          { title: 'Signup funnel', widget_type: 'CHART', query: 'funnel', chart_config: { chart: 'bar', x: 'step', y: ['users'] }, w: 4, h: 4 },
          { title: 'Devices', widget_type: 'CHART', query: 'devices', chart_config: { chart: 'pie', x: 'device', y: ['sessions'] }, w: 4, h: 4 },
          { title: 'Countries', widget_type: 'CHART', query: 'countries', chart_config: { chart: 'bar', x: 'country', y: ['users'] }, w: 4, h: 4 },
          { title: 'Top pages', widget_type: 'TABLE', query: 'top_pages', chart_config: { page_size: 10 }, w: 12, h: 5 },
        ],
      },
    ],
    notebooks: [
      {
        title: 'Traffic by page',
        cells: [
          { type: 'input', name: 'page', source: '', input: { kind: 'select', label: 'Page', value: '/pricing', options: ['/', '/pricing', '/docs', '/blog', '/signup', '/checkout'] } },
          { type: 'sql', name: 'daily', source: `SELECT event_time::DATE AS day, count(*) AS views
FROM {{table:events}}
WHERE page = {{ page }} AND event_name = 'page_view'
GROUP BY 1
ORDER BY 1` },
        ],
      },
    ],
    semantic: null,
    quality: [
      {
        name: 'Event checks',
        relation: '{{table:events}}',
        checks: [
          { id: 'time_not_null', type: 'not_null', column: 'event_time', severity: 'error' },
          { id: 'user_not_null', type: 'not_null', column: 'user_id', severity: 'error' },
          { id: 'fresh', type: 'freshness', column: 'event_time', max_age_hours: 48, severity: 'warn' },
        ],
      },
    ],
  },
};

const support: BuiltinTemplate = {
  id: 'builtin:support',
  name: 'Support tickets',
  description: 'Ticket volume, backlog, resolution time by priority and customer satisfaction by channel.',
  category: 'Operations',
  tags: ['support', 'csat', 'sla'],
  body: {
    tables: [
      {
        name: 'tickets',
        description: 'One row per ticket; resolved_at is empty while it is open',
        columns: [
          { name: 'ticket_id', type: 'BIGINT' },
          { name: 'created_at', type: 'TIMESTAMP' },
          { name: 'resolved_at', type: 'TIMESTAMP' },
          { name: 'priority', type: 'VARCHAR' },
          { name: 'channel', type: 'VARCHAR' },
          { name: 'csat', type: 'INTEGER' },
        ],
        sample_sql: `SELECT ticket_id, created_at,
  CASE WHEN created_at + to_seconds(hours * 3600) < current_date THEN created_at + to_seconds(hours * 3600) END AS resolved_at,
  priority, channel,
  CASE WHEN created_at + to_seconds(hours * 3600) < current_date THEN (1 + hash(ticket_id * 3 + 1) % 5)::INTEGER END AS csat
FROM (
  SELECT i::BIGINT AS ticket_id,
    CAST(current_date AS TIMESTAMP) - to_seconds((hash(i * 5 + 2) % 7776000)::BIGINT) AS created_at,
    (['low', 'normal', 'normal', 'high', 'urgent'])[1 + (hash(i * 7 + 3) % 5)::INTEGER] AS priority,
    (['email', 'chat', 'phone'])[1 + (hash(i * 11 + 4) % 3)::INTEGER] AS channel,
    (1 + hash(i * 13 + 5) % 96)::BIGINT AS hours
  FROM range(1, 3001) t(i)
)`,
      },
    ],
    queries: [
      { key: 'volume', name: 'Tickets by week', sql: `SELECT date_trunc('week', created_at)::DATE AS week, count(*) AS created, count(resolved_at) AS resolved
FROM {{table:tickets}}
GROUP BY 1
ORDER BY 1` },
      { key: 'backlog', name: 'Open backlog', sql: `SELECT count(*) AS open_tickets, count(*) FILTER (WHERE priority IN ('high', 'urgent')) AS open_high_priority
FROM {{table:tickets}}
WHERE resolved_at IS NULL` },
      { key: 'resolution', name: 'Resolution time by priority', sql: `SELECT priority, round(median(epoch(resolved_at - created_at) / 3600), 1) AS median_hours, count(*) AS resolved
FROM {{table:tickets}}
WHERE resolved_at IS NOT NULL
GROUP BY 1
ORDER BY median_hours` },
      { key: 'csat', name: 'Satisfaction by channel', sql: `SELECT channel, round(avg(csat), 2) AS csat, count(csat) AS ratings
FROM {{table:tickets}}
GROUP BY 1
ORDER BY 1` },
    ],
    dashboards: [
      {
        name: 'Support overview',
        widgets: [
          { title: 'Open tickets', widget_type: 'KPI', query: 'backlog', chart_config: { value: 'open_tickets', format: 'number' }, w: 6, h: 2 },
          { title: 'Open, high priority', widget_type: 'KPI', query: 'backlog', chart_config: { value: 'open_high_priority', format: 'number' }, w: 6, h: 2 },
          { title: 'Tickets by week', widget_type: 'CHART', query: 'volume', chart_config: { chart: 'line', x: 'week', y: ['created', 'resolved'] }, w: 12, h: 4 },
          { title: 'Median hours to resolve', widget_type: 'CHART', query: 'resolution', chart_config: { chart: 'bar', x: 'priority', y: ['median_hours'] }, w: 6, h: 4 },
          { title: 'Satisfaction by channel', widget_type: 'CHART', query: 'csat', chart_config: { chart: 'bar', x: 'channel', y: ['csat'] }, w: 6, h: 4 },
        ],
      },
    ],
    notebooks: [],
    semantic: null,
    quality: [
      {
        name: 'Ticket checks',
        relation: '{{table:tickets}}',
        checks: [
          { id: 'id_unique', type: 'unique', column: 'ticket_id', severity: 'error' },
          { id: 'priority_values', type: 'accepted_values', column: 'priority', values: ['low', 'normal', 'high', 'urgent'], severity: 'warn' },
          { id: 'csat_range', type: 'range', column: 'csat', min: 1, max: 5, severity: 'error' },
          { id: 'resolved_after_created', type: 'expression', expression: 'resolved_at IS NULL OR resolved_at >= created_at', severity: 'error' },
        ],
      },
    ],
  },
};

export const BUILTIN_TEMPLATES: BuiltinTemplate[] = [ecommerce, saas, web, support];
