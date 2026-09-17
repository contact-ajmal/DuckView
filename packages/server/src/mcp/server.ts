/**
 * DuckView MCP server: tools, resources and prompts bound to a single authenticated principal.
 * A new McpServer is built per transport session so that authorization is baked into every handler.
 */
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import type { Principal } from '../services/principal.js';
import { HitlBlocked } from '../services/query.js';
import { SandboxViolation } from '../engine/sandbox.js';
import { QueryTimeoutError } from '../engine/duckdb.js';
import { toMarkdownTable, truncateCell, formatBytes, type QueryResult } from '../engine/results.js';
import { metrics } from '../observability/metrics.js';
import { withSpan } from '../observability/tracing.js';
import { HttpError } from '../services/errors.js';
import { liveEvents, summarizeArgs } from '../observability/events.js';

export const MCP_SERVER_INFO = { name: 'duckview', version: '1.0.0' } as const;

type ToolResult = { content: { type: 'text'; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };

function text(t: string): { type: 'text'; text: string } {
  return { type: 'text', text: t };
}

function errorResult(err: unknown): ToolResult {
  if (err instanceof HitlBlocked) {
    return { content: [text(`APPROVAL REQUIRED\n\n${err.challenge.reason}\n\n${err.challenge.how_to_proceed}\n\n\`\`\`json\n${JSON.stringify(err.challenge, null, 2)}\n\`\`\``)], structuredContent: err.challenge as unknown as Record<string, unknown>, isError: false };
  }
  const e = err as Error & { code?: string; statusCode?: number };
  let code = e.code ?? 'ERROR';
  if (err instanceof SandboxViolation) code = 'SANDBOX_VIOLATION';
  else if (err instanceof QueryTimeoutError) code = 'QUERY_TIMEOUT';
  else if (err instanceof HttpError) code = err.code;
  const payload = { status: 'error', code, message: e.message ?? String(err) };
  return { content: [text(`ERROR (${code}): ${payload.message}`)], structuredContent: payload, isError: true };
}

function truncateRows(result: QueryResult, maxCellChars: number): unknown[][] {
  return result.rows.map((r) => r.map((v) => (typeof v === 'string' && v.length > maxCellChars ? truncateCell(v, maxCellChars) : typeof v === 'object' && v !== null && JSON.stringify(v).length > maxCellChars ? truncateCell(v, maxCellChars) : v)));
}

export function buildMcpServer(ctx: AppContext, principal: Principal, opts: { defaultWorkspaceId?: string | null } = {}): McpServer {
  const server = new McpServer(MCP_SERVER_INFO, {
    instructions: [
      'DuckView exposes sandboxed DuckDB workspaces. Every tool needs a workspace_id — read the duckdb://workspaces resource or call list_accessible_data to discover them.',
      'Results are capped (default 50 rows, max 200) — use page/page_size for more, and prefer aggregations over dumping tables.',
      'Mutating SQL (DROP/DELETE/ALTER/UPDATE/INSERT/CREATE/COPY) is blocked until you re-issue it with dry_run=false after a human approves.',
      'File paths in SQL are relative to the workspace data directory; absolute paths outside it are rejected.',
    ].join(' '),
  });

  const mcpCfg = ctx.cfg.mcp;
  const resolveWorkspace = (id?: string | null) => {
    const ws = id || opts.defaultWorkspaceId || principal.workspaceScope;
    if (!ws) throw new HttpError(400, 'workspace_id is required (no default workspace bound to this session)', 'BAD_REQUEST');
    return ws;
  };

  const instrument = async (tool: string, args: Record<string, unknown>, fn: () => Promise<ToolResult>): Promise<ToolResult> => {
    const stop = metrics.mcpToolDuration.startTimer({ tool });
    const started = performance.now();
    const publish = (status: 'ok' | 'error' | 'approval_required') =>
      liveEvents.publish({
        type: 'mcp_tool',
        at: new Date().toISOString(),
        user_id: principal.userId,
        user: principal.email,
        tool,
        status,
        duration_ms: Math.round(performance.now() - started),
        workspace_id: (typeof args.workspace_id === 'string' ? args.workspace_id : null) ?? opts.defaultWorkspaceId ?? principal.workspaceScope ?? null,
        args,
        summary: summarizeArgs(args),
      });
    try {
      const r = await withSpan(`mcp.tool.${tool}`, { 'duckview.tool': tool, 'duckview.user_id': principal.userId }, fn);
      const status = r.isError ? 'error' : (r.structuredContent as { status?: string } | undefined)?.status === 'approval_required' ? 'approval_required' : 'ok';
      metrics.mcpToolCalls.inc({ tool, status });
      publish(status);
      return r;
    } catch (err) {
      const r = errorResult(err);
      const status = err instanceof HitlBlocked ? 'approval_required' : 'error';
      metrics.mcpToolCalls.inc({ tool, status });
      publish(status);
      return r;
    } finally {
      stop();
    }
  };

  // ------------------------------------------------------------------ tools
  server.registerTool(
    'execute_query',
    {
      title: 'Execute SQL',
      description:
        'Run DuckDB SQL in a workspace. Returns a Markdown table plus typed JSON (columns, rows, total_rows). ' +
        `Output is hard-capped at ${mcpCfg.max_page_size} rows per call (default ${mcpCfg.default_page_size}); long strings are truncated. ` +
        'Mutating statements require dry_run=false after human approval.',
      inputSchema: {
        sql: z.string().min(1).describe('DuckDB SQL. File paths are relative to the workspace data directory.'),
        workspace_id: z.string().optional().describe('Workspace to run in (defaults to the token/session workspace).'),
        page_size: z.number().int().min(1).max(mcpCfg.max_page_size).optional().describe(`Rows per page (default ${mcpCfg.default_page_size}, max ${mcpCfg.max_page_size}).`),
        page: z.number().int().min(1).optional().describe('1-based page for large SELECT results.'),
        dry_run: z.boolean().optional().describe('Default true. Set to false ONLY after a human has approved a mutating statement.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    async ({ sql, workspace_id, page_size, page, dry_run }) =>
      instrument('execute_query', { sql, workspace_id, page_size, page, dry_run }, async () => {
        const ws = resolveWorkspace(workspace_id);
        const limit = Math.min(page_size ?? mcpCfg.default_page_size, mcpCfg.max_page_size);
        const result = await ctx.queries.run(principal, ws, sql, { maxRows: limit, page: page ?? 1, countTotal: true, dryRun: dry_run });
        const rows = truncateRows(result, mcpCfg.max_cell_chars);
        const shaped = { columns: result.columns, rows };
        const md = toMarkdownTable(shaped, mcpCfg.max_cell_chars);
        const meta = {
          status: 'ok',
          workspace_id: ws,
          statement_class: result.statementClass,
          row_count: result.rowCount,
          total_rows: result.totalRows,
          truncated: result.truncated,
          page: page ?? 1,
          page_size: limit,
          rows_changed: result.rowsChanged,
          duration_ms: result.durationMs,
        };
        const note = result.truncated ? `\n\n_Showing ${result.rowCount} of ${result.totalRows ?? 'many'} rows — request page ${(page ?? 1) + 1} or add a WHERE/LIMIT/aggregation._` : '';
        const changed = result.rowsChanged != null ? `\n\n_${result.rowsChanged} row(s) affected._` : '';
        return {
          content: [text(`${md}${note}${changed}\n\n\`\`\`json\n${JSON.stringify({ ...meta, schema: result.columns }, null, 2)}\n\`\`\``)],
          structuredContent: { ...meta, columns: result.columns, rows },
        };
      }),
  );

  server.registerTool(
    'profile_dataset',
    {
      title: 'Profile dataset',
      description: 'Statistical profile (DuckDB SUMMARIZE) of a table, view, data file path, or SELECT: per-column type, min/max, approx distinct, null %, quartiles, plus row count and footprint.',
      inputSchema: {
        table_or_path: z.string().min(1).describe("Table/view name, relative file path (e.g. 'sales.parquet'), or a SELECT statement."),
        workspace_id: z.string().optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ table_or_path, workspace_id }) =>
      instrument('profile_dataset', { table_or_path, workspace_id }, async () => {
        const ws = resolveWorkspace(workspace_id);
        const out = await ctx.queries.profile(principal, ws, table_or_path);
        const columns = out.summary.map((s) => ({
          column: s.column_name,
          type: s.column_type,
          null_percentage: s.null_percentage,
          approx_unique: s.approx_unique,
          min: s.min,
          max: s.max,
          avg: s.avg,
          std: s.std,
          q25: s.q25,
          q50: s.q50,
          q75: s.q75,
        }));
        const md = toMarkdownTable({ columns: ['column', 'type', 'null_percentage', 'approx_unique', 'min', 'max', 'avg', 'q50'].map((n) => ({ name: n, type: 'VARCHAR', kind: 'string' as const })), rows: columns.map((c) => [c.column, c.type, c.null_percentage, c.approx_unique, c.min, c.max, c.avg, c.q50]) }, 60);
        const header = `**${table_or_path}** — ${out.rowCount ?? '?'} rows × ${out.columnCount} columns${out.sizeBytes != null ? ` · ${formatBytes(out.sizeBytes)} on disk` : ''}`;
        return {
          content: [text(`${header}\n\n${md}`)],
          structuredContent: { status: 'ok', target: table_or_path, row_count: out.rowCount, column_count: out.columnCount, size_bytes: out.sizeBytes, columns },
        };
      }),
  );

  server.registerTool(
    'explain_query',
    {
      title: 'Explain query plan',
      description: 'Returns the DuckDB physical execution plan (JSON tree + ASCII) with cardinality estimates. Set analyze=true to actually run the query and get measured timings per operator (read-only SQL only).',
      inputSchema: { sql: z.string().min(1), workspace_id: z.string().optional(), analyze: z.boolean().optional().describe('Execute and report real timings (EXPLAIN ANALYZE).') },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ sql, workspace_id, analyze }) =>
      instrument('explain_query', { sql, workspace_id, analyze }, async () => {
        const ws = resolveWorkspace(workspace_id);
        const plan = await ctx.queries.explain(principal, ws, sql, analyze ?? false);
        const summary = plan.format === 'json' ? summarizePlan(plan.plan) : [];
        return {
          content: [text(`\`\`\`\n${plan.text}\n\`\`\`${summary.length ? `\n\nOperators (est. cardinality): ${summary.join(' → ')}` : ''}`)],
          structuredContent: { status: 'ok', format: plan.format, plan: plan.plan, text: plan.text, operators: summary },
        };
      }),
  );

  server.registerTool(
    'list_accessible_data',
    {
      title: 'List accessible data',
      description: 'Lists every table and view in the workspace (with columns) and every data file (Parquet/CSV/JSON/DuckDB/Delta/Iceberg) inside the sandboxed data directory. Also lists the workspaces you may use.',
      inputSchema: { workspace_id: z.string().optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ workspace_id }) =>
      instrument('list_accessible_data', { workspace_id }, async () => {
        const wsList = await ctx.workspaces.list(principal);
        const ws = workspace_id || opts.defaultWorkspaceId || principal.workspaceScope || wsList[0]?.id;
        if (!ws) return { content: [text('No workspaces available. Create one in the DuckView UI first.')], structuredContent: { status: 'ok', workspaces: [], objects: [], files: [] } };
        const { objects, files } = await ctx.queries.catalog(principal, ws);
        const lines: string[] = [];
        lines.push(`**Workspaces**: ${wsList.map((w) => `${w.name} (\`${w.id}\`${w.id === ws ? ', active' : ''})`).join(', ') || 'none'}`);
        lines.push('', `**Tables & views in workspace \`${ws}\`** (${objects.length})`);
        for (const o of objects) lines.push(`- ${o.type === 'VIEW' ? 'view' : 'table'} \`${o.schema}.${o.name}\`${o.estimated_rows != null ? ` ~${o.estimated_rows} rows` : ''}: ${o.columns.map((c) => `${c.name} ${c.type}`).join(', ')}`);
        lines.push('', `**Files in data directory** (${files.length})`);
        for (const f of files) lines.push(`- \`${f.path}\` (${f.kind}, ${formatBytes(f.size_bytes)}) → \`SELECT * FROM '${f.path}'\``);
        return {
          content: [text(lines.join('\n'))],
          structuredContent: { status: 'ok', workspace_id: ws, workspaces: wsList.map((w) => ({ id: w.id, name: w.name, db_path: w.active_db_path })), objects, files },
        };
      }),
  );

  server.registerTool(
    'save_dataset',
    {
      title: 'Save dataset',
      description: 'Materialises a SELECT to a file inside the sandboxed data directory (COPY ... TO). Formats: parquet (zstd), csv, json. Requires dry_run=false after human approval.',
      inputSchema: {
        sql: z.string().min(1).describe('A single SELECT statement.'),
        output_format: z.enum(['parquet', 'csv', 'json']),
        target_filename: z.string().min(1).describe("Relative filename, e.g. 'exports/top_customers.parquet'. Bare names go to exports/."),
        workspace_id: z.string().optional(),
        dry_run: z.boolean().optional().describe('Default true. Set false once approved.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ sql, output_format, target_filename, workspace_id, dry_run }) =>
      instrument('save_dataset', { sql, output_format, target_filename, workspace_id, dry_run }, async () => {
        const ws = resolveWorkspace(workspace_id);
        const out = await ctx.queries.saveDataset(principal, ws, { sql, format: output_format, target: target_filename, dryRun: dry_run });
        return {
          content: [text(`Saved **${out.path}** (${out.format}, ${out.rows_written} rows, ${formatBytes(out.size_bytes)}) in ${out.duration_ms} ms. Query it with \`SELECT * FROM '${out.path}'\`.`)],
          structuredContent: { status: 'ok', ...out },
        };
      }),
  );

  server.registerTool(
    'browse_storage',
    {
      title: 'Browse storage',
      description: 'Lists one directory level of the workspace data directory (provider "local", default) or of a cloud bucket (provider "cloud" with connection_id; omit bucket to list buckets). Cloud connections are listed with provider "cloud" and no connection_id.',
      inputSchema: {
        provider: z.enum(['local', 'cloud']).optional().describe('local (default) or cloud'),
        path: z.string().optional().describe('local: directory path relative to the data directory; cloud: object prefix inside the bucket'),
        connection_id: z.string().optional().describe('cloud connection id (see provider=cloud without an id)'),
        bucket: z.string().optional().describe('cloud bucket / container'),
        workspace_id: z.string().optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ provider, path: p, connection_id, bucket, workspace_id }) =>
      instrument('browse_storage', { provider, path: p, connection_id, bucket, workspace_id }, async () => {
        if (provider === 'cloud') {
          if (!connection_id) {
            const conns = await ctx.cloud.list(principal.userId);
            const lines = conns.map((c) => `- ${c.name} (\`${c.id}\`, ${c.provider}, ${c.uri_scheme}://${c.bucket ?? '<any bucket>'})`);
            return { content: [text(`**Cloud connections** (${conns.length})\n${lines.join('\n') || '_(none configured)_'}`)], structuredContent: { status: 'ok', connections: conns.map((c) => ({ id: c.id, name: c.name, provider: c.provider, bucket: c.bucket, uri_scheme: c.uri_scheme })) } };
          }
          if (!bucket) {
            const r = await ctx.storage.cloudBuckets(principal, connection_id);
            return { content: [text(`**Buckets on ${r.connection.name}**\n${r.buckets.map((b) => `- ${b.name}`).join('\n') || '_(none)_'}${r.queryable ? '' : '\n\n_External access is disabled on this server: objects can be listed but not queried._'}`)], structuredContent: { status: 'ok', ...r } };
          }
          const r = await ctx.storage.cloudObjects(principal, connection_id, bucket, p ?? '');
          const lines = r.entries.map((e) => (e.type === 'dir' ? `- 📁 ${e.name}/` : `- ${e.name} (${formatBytes(e.size_bytes ?? 0)}) → \`${e.uri}\``));
          return { content: [text(`**${r.connection.provider} ${bucket}/${r.prefix}** (${r.entries.length} entries${r.next_token ? ', truncated' : ''})\n${lines.join('\n') || '_(empty)_'}`)], structuredContent: { status: 'ok', ...r } };
        }
        const ws = resolveWorkspace(workspace_id);
        const r = await ctx.storage.local(principal, ws, p ?? '.');
        const lines = r.entries.map((e) => (e.type === 'file' ? `- ${e.name} (${e.kind}, ${formatBytes(e.size_bytes ?? 0)})${e.queryable ? ` → \`SELECT * FROM '${e.path}'\`` : ''}` : `- 📁 ${e.name}/${e.type === 'table_dir' ? ` (${e.kind} table)` : ''}`));
        return { content: [text(`**${r.mode === 'full' ? r.absolute : r.path === '.' ? 'data directory' : r.path}** (${r.entries.length} entries)\n${lines.join('\n') || '_(empty)_'}`)], structuredContent: { status: 'ok', ...r } };
      }),
  );

  server.registerTool(
    'inspect_schema',
    {
      title: 'Inspect schema',
      description: "Column names, DuckDB types and nullability for a table/view, a local data file, a remote object (s3://, r2://, gs://, az://), a .duckdb file (all tables) or a SELECT — without scanning the data (DESCRIBE … LIMIT 0). Parquet row counts come from the footer.",
      inputSchema: { file_path_or_table: z.string().min(1), workspace_id: z.string().optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ file_path_or_table, workspace_id }) =>
      instrument('inspect_schema', { file_path_or_table, workspace_id }, async () => {
        const ws = resolveWorkspace(workspace_id);
        const r = await ctx.storage.inspect(principal, ws, file_path_or_table);
        const md: string[] = [`**${r.target}** (${r.kind}${r.row_count != null ? ` · ${r.row_count.toLocaleString()} rows via ${r.row_count_source}` : ''}${r.size_bytes != null ? ` · ${formatBytes(r.size_bytes)}` : ''})`];
        if (r.tables?.length) for (const t of r.tables) md.push(`\n_${t.schema}.${t.name}_\n| column | type | nullable |\n| --- | --- | --- |\n${t.columns.map((c) => `| ${c.name} | ${c.type} | ${c.nullable ? 'yes' : 'no'} |`).join('\n')}`);
        else md.push(`| column | type | nullable |\n| --- | --- | --- |\n${r.columns.map((c) => `| ${c.name} | ${c.type} | ${c.nullable ? 'yes' : 'no'} |`).join('\n')}`);
        md.push(`\nSuggested query:\n\`\`\`sql\n${r.suggested_sql}\n\`\`\``);
        return { content: [text(md.join('\n'))], structuredContent: { status: 'ok', ...r } };
      }),
  );

  server.registerTool(
    'list_dashboards',
    {
      title: 'List dashboards',
      description: 'Lists BI dashboards (and their widgets) in a workspace, or across all accessible workspaces when workspace_id is omitted.',
      inputSchema: { workspace_id: z.string().optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ workspace_id }) =>
      instrument('list_dashboards', { workspace_id }, async () => {
        const list = workspace_id ? await ctx.dashboards.list(principal, workspace_id) : await ctx.dashboards.listAll(principal);
        const detailed = await Promise.all(list.map((d) => ctx.dashboards.get(principal, d.id)));
        const lines = detailed.map((d) => `- **${d.name}** (\`${d.id}\`, workspace \`${d.workspace_id}\`) — ${d.widgets.length} widget(s): ${d.widgets.map((w) => `${w.title} [${w.widget_type}]`).join(', ') || 'none'}`);
        return { content: [text(`**Dashboards** (${detailed.length})\n${lines.join('\n') || '_(none)_'}`)], structuredContent: { status: 'ok', dashboards: detailed.map((d) => ({ id: d.id, name: d.name, description: d.description, workspace_id: d.workspace_id, layout: d.layout, widgets: d.widgets.map((w) => ({ id: w.id, title: w.title, widget_type: w.widget_type, custom_sql: w.custom_sql, saved_query_id: w.saved_query_id, chart_config: w.chart_config, refresh_interval_sec: w.refresh_interval_sec })) })) } };
      }),
  );

  server.registerTool(
    'create_dashboard_widget',
    {
      title: 'Create dashboard widget',
      description: 'Adds a widget to a dashboard (creates the dashboard when dashboard_id is omitted and dashboard_name is given). widget_type KPI expects chart_config.value; CHART expects chart_config.chart + x + y[]; TABLE needs nothing; MARKDOWN uses chart_config.markdown. The SQL is validated (read-only) and executed once to confirm it runs.',
      inputSchema: {
        dashboard_id: z.string().optional(),
        dashboard_name: z.string().optional().describe('Create a new dashboard with this name when dashboard_id is omitted'),
        workspace_id: z.string().optional(),
        title: z.string().min(1),
        sql: z.string().min(1).describe('Read-only SQL for the widget (ignored for MARKDOWN)'),
        widget_type: z.enum(['KPI', 'CHART', 'TABLE', 'MARKDOWN']),
        chart_config: z.record(z.string(), z.unknown()).optional(),
        refresh_interval_sec: z.number().int().min(0).max(86400).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ dashboard_id, dashboard_name, workspace_id, title, sql, widget_type, chart_config, refresh_interval_sec }) =>
      instrument('create_dashboard_widget', { dashboard_id, dashboard_name, workspace_id, title, sql, widget_type, chart_config, refresh_interval_sec }, async () => {
        let dashId = dashboard_id;
        let ws = workspace_id;
        if (!dashId) {
          if (!dashboard_name) throw new HttpError(400, 'Provide dashboard_id, or dashboard_name to create a new dashboard', 'BAD_REQUEST');
          ws = resolveWorkspace(ws);
          dashId = (await ctx.dashboards.create(principal, ws, { name: dashboard_name })).id;
        } else ws = (await ctx.dashboards.get(principal, dashId)).workspace_id;
        if (widget_type !== 'MARKDOWN') {
          // Dry-run the SQL so agents get immediate feedback on broken queries.
          await ctx.queries.run(principal, ws, sql, { maxRows: 5, dryRun: true });
        }
        const cfg = (chart_config ?? {}) as Record<string, unknown>;
        const { widget, layout } = await ctx.dashboards.addWidget(principal, dashId, {
          title,
          widget_type,
          custom_sql: widget_type === 'MARKDOWN' ? null : sql,
          chart_config: widget_type === 'MARKDOWN' ? { markdown: String(cfg.markdown ?? sql) } : cfg,
          refresh_interval_sec: refresh_interval_sec ?? 0,
        });
        return { content: [text(`Added **${widget.title}** (${widget.widget_type}) to dashboard \`${dashId}\`. Open it at /#/dashboards/${dashId}.`)], structuredContent: { status: 'ok', dashboard_id: dashId, workspace_id: ws, widget: { id: widget.id, title: widget.title, widget_type: widget.widget_type, chart_config: widget.chart_config }, layout } };
      }),
  );

  // -------------------------------------------------------------- resources
  server.registerResource(
    'workspaces',
    'duckdb://workspaces',
    { title: 'Workspaces', description: 'Workspaces this principal may query (id, name, database path, engine settings).', mimeType: 'application/json' },
    async (uri) => {
      const list = await ctx.workspaces.list(principal);
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(list.map((w) => ({ id: w.id, name: w.name, active_db_path: w.active_db_path, engine_settings: w.engine_settings })), null, 2) }] };
    },
  );

  server.registerResource(
    'schemas',
    new ResourceTemplate('duckdb://schemas/{workspace_id}', {
      list: async () => {
        const list = await ctx.workspaces.list(principal);
        return { resources: list.map((w) => ({ uri: `duckdb://schemas/${w.id}`, name: `Schema: ${w.name}`, mimeType: 'text/markdown' })) };
      },
    }),
    { title: 'Workspace schema map', description: 'DDL and column map of all tables/views attached to a workspace, plus data files in the sandbox.', mimeType: 'text/markdown' },
    async (uri, { workspace_id }) => {
      const ws = String(workspace_id);
      const { objects, files } = await ctx.queries.catalog(principal, ws);
      const md: string[] = [`# Schema for workspace ${ws}`, ''];
      for (const o of objects) {
        md.push(`## ${o.type} ${o.database}.${o.schema}.${o.name}`);
        md.push('', '| column | type | nullable |', '| --- | --- | --- |', ...o.columns.map((c) => `| ${c.name} | ${c.type} | ${c.nullable ? 'yes' : 'no'} |`));
        if (o.sql) md.push('', '```sql', o.sql, '```');
        md.push('');
      }
      md.push('## Data files', '', ...(files.length ? files.map((f) => `- \`${f.path}\` — ${f.kind}, ${formatBytes(f.size_bytes)}`) : ['_(none)_']));
      return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: md.join('\n') }, { uri: uri.href + '#json', mimeType: 'application/json', text: JSON.stringify({ objects, files }, null, 2) }] };
    },
  );

  server.registerResource(
    'system-resources',
    'duckdb://system/resources',
    { title: 'System resources', description: 'Host CPU count, RAM, DuckDB memory ceiling, thread count, temp-spill disk space and active engines.', mimeType: 'application/json' },
    async (uri) => {
      const r = ctx.engines.resources();
      const md = [
        `CPUs: ${r.host.cpus}`,
        `Host RAM: ${formatBytes(r.host.total_memory_bytes)} total / ${formatBytes(r.host.free_memory_bytes)} free`,
        `DuckDB memory ceiling: ${r.duckdb.memory_limit} (${formatBytes(r.duckdb.memory_limit_bytes)}), threads: ${r.duckdb.threads}`,
        `Temp spill dir: ${r.temp_disk.path} (${r.temp_disk.free_bytes != null ? formatBytes(r.temp_disk.free_bytes) + ' free' : 'n/a'})`,
        `External access: ${r.duckdb.external_access ? 'enabled' : 'disabled'}, config locked: ${r.duckdb.configuration_locked}`,
        `Active engines: ${r.engines_active}`,
      ].join('\n');
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify({ ...r, summary: md }, null, 2) }] };
    },
  );

  // ---------------------------------------------------------------- prompts
  server.registerPrompt(
    'data_quality_audit',
    {
      title: 'Data quality audit',
      description: 'Guided workflow: inspect a table/file schema, run distribution and integrity checks, and produce an anomaly report.',
      argsSchema: { table_or_path: z.string().describe('Table, view or relative file path to audit'), workspace_id: z.string().optional().describe('Workspace id') },
    },
    ({ table_or_path, workspace_id }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `You are auditing the data quality of \`${table_or_path}\`${workspace_id ? ` in workspace \`${workspace_id}\`` : ''} using the DuckView MCP tools.

Follow this plan and keep each tool result small (aggregate, never dump rows):
1. Call \`profile_dataset\` on \`${table_or_path}\` to get types, null %, approx distinct and quartiles.
2. Call \`execute_query\` for structural checks: exact row count, duplicate rows (GROUP BY all columns HAVING count(*)>1 LIMIT 20), candidate primary keys (columns where approx_unique ≈ row count).
3. For each numeric column: check for negative values where implausible, outliers beyond q75 + 3·IQR, and constant columns.
4. For each temporal column: min/max range, gaps or future dates, and rows-per-period skew (date_trunc by month).
5. For each text column: empty strings vs NULL, leading/trailing whitespace (col <> trim(col)), inconsistent casing, top-10 values and long-tail cardinality.
6. Cross-column integrity: referential-style checks between obviously related columns (ids, codes), and totals that should reconcile.

Deliver an **Anomaly Report** in Markdown with sections: Overview (rows, columns, footprint), Findings (severity: high/medium/low, column, evidence query, affected row count, suggested fix), and a final "Data readiness" verdict. Do not modify any data.`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'sql_optimization',
    {
      title: 'SQL optimisation',
      description: 'Guided workflow: explain a slow query, diagnose the plan, and recommend projection/partition/index/rewrite changes.',
      argsSchema: { sql: z.string().describe('The slow SQL statement'), workspace_id: z.string().optional().describe('Workspace id') },
    },
    ({ sql, workspace_id }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Optimise this DuckDB query${workspace_id ? ` (workspace \`${workspace_id}\`)` : ''}:

\`\`\`sql
${sql}
\`\`\`

Procedure:
1. Call \`explain_query\` (analyze=false) and read the physical plan: identify full scans, hash joins with large build sides, sorts, and any operator whose estimated cardinality is orders of magnitude above the final result.
2. Call \`list_accessible_data\` / read \`duckdb://schemas/{workspace_id}\` to confirm column types and whether sources are Parquet (columnar, supports projection & row-group pruning), CSV (no pushdown), or in-memory tables.
3. If safe, call \`explain_query\` with analyze=true to obtain measured operator timings and confirm the bottleneck.
4. Propose concrete changes, ranked by expected impact, choosing from: projection pruning (select only needed columns), predicate pushdown (filter before join/aggregate, sargable predicates), join order or pre-aggregation, converting CSV → Parquet via \`save_dataset\` (with sensible sort/partition keys for zone-map pruning), Hive-style partitioning for large scans, materialising hot intermediate results, adjusting DuckDB settings (threads/memory) only if the plan shows spilling, and creating indexes (ART) only for highly selective point lookups on in-database tables.
5. Rewrite the query, run \`explain_query\` on the rewrite, and compare estimated cardinalities / timings against the original.

Output: a short diagnosis, the rewritten SQL, a before/after plan comparison table, and any \`save_dataset\` or DDL commands the human should approve. Never execute mutating statements without approval.`,
          },
        },
      ],
    }),
  );

  return server;
}

/** Flattens a DuckDB JSON plan into "OPERATOR(~rows)" labels, depth-first. */
export function summarizePlan(plan: unknown): string[] {
  const out: string[] = [];
  const visit = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    const n = node as { name?: string; extra_info?: Record<string, unknown>; children?: unknown[] };
    const card = n.extra_info?.['Estimated Cardinality'] ?? n.extra_info?.['estimated_cardinality'];
    if (n.name) out.push(`${n.name}${card != null ? `(~${card})` : ''}`);
    for (const c of n.children ?? []) visit(c);
  };
  if (Array.isArray(plan)) plan.forEach(visit);
  else visit(plan);
  return out;
}
