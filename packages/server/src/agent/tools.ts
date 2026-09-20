/**
 * The DuckView agent tool registry — one definition per tool, consumed by:
 *   - the MCP server (mcp/server.ts) for Claude Desktop / Cursor / Claude Code / Strands / LangChain / CrewAI clients,
 *   - the REST façade (routes/agent.ts) for Bedrock Agents action groups, AgentCore Gateway OpenAPI targets and
 *     any plain-HTTP agent,
 *   - the generated OpenAPI 3.0 document (agent/openapi.ts).
 *
 * Every handler runs under an authenticated principal; authorization (scopes, workspace scope, HITL for mutations)
 * lives in the services, so the three surfaces cannot drift apart.
 */
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
import { describeSpec, parseSpecText } from '../services/mosaic-spec.js';
import { SOURCE_CATALOG } from '../services/source-catalog.js';
import type { SyncSource, SyncSchedule } from '../db/schema/sqlite.js';

export type ToolResult = { content: { type: 'text'; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolEnv {
  ctx: AppContext;
  principal: Principal;
  defaultWorkspaceId?: string | null;
  /** How the call arrived — shown in the live inspector. */
  via: 'mcp' | 'rest';
  /** Registered agent (when the token belongs to one). */
  agent?: { id: string; name: string; framework: string } | null;
}

export interface ToolDef<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  inputSchema: S;
  annotations: ToolAnnotations;
  handler(env: ToolEnv, args: z.infer<z.ZodObject<S>>): Promise<ToolResult>;
}

export function text(t: string): { type: 'text'; text: string } {
  return { type: 'text', text: t };
}

export function errorResult(err: unknown): ToolResult {
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

export function resolveWorkspace(env: ToolEnv, id?: string | null): string {
  const ws = id || env.defaultWorkspaceId || env.principal.workspaceScope;
  if (!ws) throw new HttpError(400, 'workspace_id is required (no default workspace bound to this session)', 'BAD_REQUEST');
  return ws;
}

/** Runs a tool with metrics, tracing, live-inspector events and error shaping shared by every surface. */
export async function runTool(env: ToolEnv, tool: ToolDef, args: Record<string, unknown>): Promise<ToolResult> {
  const stop = metrics.mcpToolDuration.startTimer({ tool: tool.name });
  const started = performance.now();
  const publish = (status: 'ok' | 'error' | 'approval_required') =>
    liveEvents.publish({
      type: 'mcp_tool',
      at: new Date().toISOString(),
      user_id: env.principal.userId,
      user: env.principal.email,
      tool: tool.name,
      status,
      duration_ms: Math.round(performance.now() - started),
      workspace_id: (typeof args.workspace_id === 'string' ? args.workspace_id : null) ?? env.defaultWorkspaceId ?? env.principal.workspaceScope ?? null,
      args,
      summary: summarizeArgs(args),
      via: env.via,
      agent: env.agent ? { id: env.agent.id, name: env.agent.name, framework: env.agent.framework } : null,
    });
  try {
    const parsedResult = z.object(tool.inputSchema).safeParse(args);
    if (!parsedResult.success) throw new HttpError(400, `Invalid arguments for ${tool.name}: ${parsedResult.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`, 'BAD_REQUEST');
    const parsed = parsedResult.data;
    const r = await withSpan(`${env.via === 'rest' ? 'agent' : 'mcp'}.tool.${tool.name}`, { 'duckview.tool': tool.name, 'duckview.user_id': env.principal.userId, 'duckview.via': env.via }, () => tool.handler(env, parsed));
    const status = r.isError ? 'error' : (r.structuredContent as { status?: string } | undefined)?.status === 'approval_required' ? 'approval_required' : 'ok';
    metrics.mcpToolCalls.inc({ tool: tool.name, status });
    publish(status);
    if (env.agent) env.ctx.agents?.touch(env.agent.id, status);
    return r;
  } catch (err) {
    const r = errorResult(err);
    const status = err instanceof HitlBlocked ? 'approval_required' : 'error';
    metrics.mcpToolCalls.inc({ tool: tool.name, status });
    publish(status);
    if (env.agent) env.ctx.agents?.touch(env.agent.id, status);
    return r;
  } finally {
    stop();
  }
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

function define<S extends z.ZodRawShape>(t: ToolDef<S>): ToolDef {
  return t as unknown as ToolDef;
}

export function buildTools(cfg: AppContext['cfg']): ToolDef[] {
  const mcpCfg = cfg.mcp;
  return [
    define({
      name: 'execute_query',
      title: 'Execute SQL',
      description:
        'Run DuckDB SQL in a workspace. Returns a Markdown table plus typed JSON (columns, rows, total_rows). ' +
        `Output is hard-capped at ${mcpCfg.max_page_size} rows per call (default ${mcpCfg.default_page_size}); long strings are truncated. ` +
        'Attached lakehouse catalogs (AWS Glue / S3 Tables / Iceberg REST / Databricks UniForm) are queried as alias.schema.table. ' +
        'Mutating statements require dry_run=false after human approval.',
      inputSchema: {
        sql: z.string().min(1).describe('DuckDB SQL. File paths are relative to the workspace data directory.'),
        workspace_id: z.string().optional().describe('Workspace to run in (defaults to the token/session workspace).'),
        page_size: z.number().int().min(1).max(mcpCfg.max_page_size).optional().describe(`Rows per page (default ${mcpCfg.default_page_size}, max ${mcpCfg.max_page_size}).`),
        page: z.number().int().min(1).optional().describe('1-based page for large SELECT results.'),
        dry_run: z.boolean().optional().describe('Default true. Set to false ONLY after a human has approved a mutating statement.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      async handler(env, { sql, workspace_id, page_size, page, dry_run }) {
        const ws = resolveWorkspace(env, workspace_id);
        const limit = Math.min(page_size ?? mcpCfg.default_page_size, mcpCfg.max_page_size);
        const result = await env.ctx.queries.run(env.principal, ws, sql, { maxRows: limit, page: page ?? 1, countTotal: true, dryRun: dry_run });
        const rows = truncateRows(result, mcpCfg.max_cell_chars);
        const shaped = { columns: result.columns, rows };
        const md = toMarkdownTable(shaped, mcpCfg.max_cell_chars);
        const meta = { status: 'ok', workspace_id: ws, statement_class: result.statementClass, row_count: result.rowCount, total_rows: result.totalRows, truncated: result.truncated, page: page ?? 1, page_size: limit, rows_changed: result.rowsChanged, duration_ms: result.durationMs };
        const note = result.truncated ? `\n\n_Showing ${result.rowCount} of ${result.totalRows ?? 'many'} rows — request page ${(page ?? 1) + 1} or add a WHERE/LIMIT/aggregation._` : '';
        const changed = result.rowsChanged != null ? `\n\n_${result.rowsChanged} row(s) affected._` : '';
        return { content: [text(`${md}${note}${changed}\n\n\`\`\`json\n${JSON.stringify({ ...meta, schema: result.columns }, null, 2)}\n\`\`\``)], structuredContent: { ...meta, columns: result.columns, rows } };
      },
    }),

    define({
      name: 'profile_dataset',
      title: 'Profile dataset',
      description: 'Statistical profile (DuckDB SUMMARIZE) of a table, view, data file path, lakehouse table (alias.schema.table) or SELECT: per-column type, min/max, approx distinct, null %, quartiles, plus row count and footprint.',
      inputSchema: {
        table_or_path: z.string().min(1).describe("Table/view name, relative file path (e.g. 'sales.parquet'), lakehouse table, or a SELECT statement."),
        workspace_id: z.string().optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      async handler(env, { table_or_path, workspace_id }) {
        const ws = resolveWorkspace(env, workspace_id);
        const out = await env.ctx.queries.profile(env.principal, ws, table_or_path);
        const columns = out.summary.map((s) => ({ column: s.column_name, type: s.column_type, null_percentage: s.null_percentage, approx_unique: s.approx_unique, min: s.min, max: s.max, avg: s.avg, std: s.std, q25: s.q25, q50: s.q50, q75: s.q75 }));
        const md = toMarkdownTable({ columns: ['column', 'type', 'null_percentage', 'approx_unique', 'min', 'max', 'avg', 'q50'].map((n) => ({ name: n, type: 'VARCHAR', kind: 'string' as const })), rows: columns.map((c) => [c.column, c.type, c.null_percentage, c.approx_unique, c.min, c.max, c.avg, c.q50]) }, 60);
        const header = `**${table_or_path}** — ${out.rowCount ?? '?'} rows × ${out.columnCount} columns${out.sizeBytes != null ? ` · ${formatBytes(out.sizeBytes)} on disk` : ''}`;
        return { content: [text(`${header}\n\n${md}`)], structuredContent: { status: 'ok', target: table_or_path, row_count: out.rowCount, column_count: out.columnCount, size_bytes: out.sizeBytes, columns } };
      },
    }),

    define({
      name: 'explain_query',
      title: 'Explain query plan',
      description: 'Returns the DuckDB physical execution plan (JSON tree + ASCII) with cardinality estimates. Set analyze=true to actually run the query and get measured timings per operator (read-only SQL only).',
      inputSchema: { sql: z.string().min(1), workspace_id: z.string().optional(), analyze: z.boolean().optional().describe('Execute and report real timings (EXPLAIN ANALYZE).') },
      annotations: { readOnlyHint: true, openWorldHint: false },
      async handler(env, { sql, workspace_id, analyze }) {
        const ws = resolveWorkspace(env, workspace_id);
        const plan = await env.ctx.queries.explain(env.principal, ws, sql, analyze ?? false);
        const summary = plan.format === 'json' ? summarizePlan(plan.plan) : [];
        return { content: [text(`\`\`\`\n${plan.text}\n\`\`\`${summary.length ? `\n\nOperators (est. cardinality): ${summary.join(' → ')}` : ''}`)], structuredContent: { status: 'ok', format: plan.format, plan: plan.plan, text: plan.text, operators: summary } };
      },
    }),

    define({
      name: 'list_accessible_data',
      title: 'List accessible data',
      description: 'Lists every table and view in the workspace (with columns), every data file (Parquet/CSV/JSON/DuckDB/Delta/Iceberg) inside the data directory and mounted folders, the attached lakehouse catalogs (query as alias.schema.table; browse them with browse_storage provider=lakehouse) and the workspaces you may use.',
      inputSchema: { workspace_id: z.string().optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
      async handler(env, { workspace_id }) {
        const wsList = await env.ctx.workspaces.list(env.principal);
        const ws = workspace_id || env.defaultWorkspaceId || env.principal.workspaceScope || wsList[0]?.id;
        if (!ws) return { content: [text('No workspaces available. Create one in the DuckView UI first.')], structuredContent: { status: 'ok', workspaces: [], objects: [], files: [], lakehouses: [] } };
        const { objects, files } = await env.ctx.queries.catalog(env.principal, ws);
        const lakehouses = await env.ctx.lakehouse.list(env.principal.userId);
        const engine = env.ctx.engines.peek(ws);
        const lines: string[] = [];
        lines.push(`**Workspaces**: ${wsList.map((w) => `${w.name} (\`${w.id}\`${w.id === ws ? ', active' : ''})`).join(', ') || 'none'}`);
        lines.push('', `**Tables & views in workspace \`${ws}\`** (${objects.length})`);
        for (const o of objects) lines.push(`- ${o.type === 'VIEW' ? 'view' : 'table'} \`${o.schema}.${o.name}\`${o.estimated_rows != null ? ` ~${o.estimated_rows} rows` : ''}: ${o.columns.map((c) => `${c.name} ${c.type}`).join(', ')}`);
        lines.push('', `**Files in data directory** (${files.length})`);
        for (const f of files) lines.push(`- \`${f.path}\` (${f.kind}, ${formatBytes(f.size_bytes)}) → \`SELECT * FROM '${f.path}'\``);
        if (lakehouses.length) {
          lines.push('', `**Lakehouse catalogs** (${lakehouses.length})`);
          for (const l of lakehouses) {
            const err = engine?.attachErrors.get(l.alias);
            lines.push(`- ${l.name} (\`${l.id}\`, ${l.provider})${l.attached ? ` attached as \`${l.alias}\` → \`SELECT * FROM ${l.alias}.<schema>.<table>\`` : ''}${l.remote_sql ? ' · remote SQL via lakehouse_query' : ''}${err ? ` · ⚠ not attached: ${err}` : ''}`);
          }
        }
        return {
          content: [text(lines.join('\n'))],
          structuredContent: { status: 'ok', workspace_id: ws, workspaces: wsList.map((w) => ({ id: w.id, name: w.name, db_path: w.active_db_path })), objects, files, lakehouses: lakehouses.map((l) => ({ id: l.id, name: l.name, provider: l.provider, alias: l.alias, attached: l.attached, remote_sql: l.remote_sql, attach_error: engine?.attachErrors.get(l.alias) ?? null })) },
        };
      },
    }),

    define({
      name: 'save_dataset',
      title: 'Save dataset',
      description: 'Materialises a SELECT to a file inside the data directory (COPY ... TO). Formats: parquet (zstd), csv, json. Requires dry_run=false after human approval.',
      inputSchema: {
        sql: z.string().min(1).describe('A single SELECT statement.'),
        output_format: z.enum(['parquet', 'csv', 'json']),
        target_filename: z.string().min(1).describe("Relative filename, e.g. 'exports/top_customers.parquet'. Bare names go to exports/."),
        workspace_id: z.string().optional(),
        dry_run: z.boolean().optional().describe('Default true. Set false once approved.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      async handler(env, { sql, output_format, target_filename, workspace_id, dry_run }) {
        const ws = resolveWorkspace(env, workspace_id);
        const out = await env.ctx.queries.saveDataset(env.principal, ws, { sql, format: output_format, target: target_filename, dryRun: dry_run });
        return { content: [text(`Saved **${out.path}** (${out.format}, ${out.rows_written} rows, ${formatBytes(out.size_bytes)}) in ${out.duration_ms} ms. Query it with \`SELECT * FROM '${out.path}'\`.`)], structuredContent: { status: 'ok', ...out } };
      },
    }),

    define({
      name: 'browse_storage',
      title: 'Browse storage',
      description:
        'Lists one level of a storage tree. provider "local" (default): a directory of the workspace data directory. provider "cloud": connections (no connection_id), buckets (connection_id only) or objects (connection_id + bucket [+ path]). ' +
        'provider "lakehouse": lakehouse connections (no connection_id), then schemas (connection_id [+ catalog for Databricks without a fixed Unity Catalog]) and tables (connection_id + schema). Table entries carry the fully qualified name and whether to query them with execute_query (engine=duckdb) or lakehouse_query (engine=remote).',
      inputSchema: {
        provider: z.enum(['local', 'cloud', 'lakehouse']).optional().describe('local (default), cloud or lakehouse'),
        path: z.string().optional().describe('local: directory path relative to the data directory; cloud: object prefix inside the bucket'),
        connection_id: z.string().optional().describe('cloud or lakehouse connection id'),
        bucket: z.string().optional().describe('cloud bucket / container'),
        catalog: z.string().optional().describe('lakehouse: Databricks catalog when the connection has no fixed Unity Catalog'),
        schema: z.string().optional().describe('lakehouse: schema/namespace to list tables of'),
        workspace_id: z.string().optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
      async handler(env, { provider, path: p, connection_id, bucket, catalog, schema, workspace_id }) {
        const { ctx, principal } = env;
        if (provider === 'lakehouse') {
          if (!connection_id) {
            const conns = await ctx.lakehouse.list(principal.userId);
            const lines = conns.map((c) => `- ${c.name} (\`${c.id}\`, ${c.provider}${c.attached ? `, attached as \`${c.alias}\`` : ''}${c.remote_sql ? ', remote SQL' : ''}, status ${c.status})`);
            return { content: [text(`**Lakehouse connections** (${conns.length})\n${lines.join('\n') || '_(none configured)_'}`)], structuredContent: { status: 'ok', connections: conns.map((c) => ({ id: c.id, name: c.name, provider: c.provider, alias: c.alias, attached: c.attached, remote_sql: c.remote_sql, status: c.status })) } };
          }
          const ws = resolveWorkspace(env, workspace_id);
          const r = await ctx.lakehouse.browse(principal, ws, connection_id, { catalog: catalog ?? null, schema: schema ?? null });
          const lines = r.entries.map((e) => (e.type === 'table' || e.type === 'view' ? `- ${e.type} \`${e.qualified}\`${e.format ? ` (${e.format})` : ''}${e.engine === 'duckdb' ? ' → execute_query' : e.engine === 'remote' ? ' → lakehouse_query' : ''}` : `- ${e.type} ${e.name}`));
          const head = `**${r.connection.name}** · ${r.level}${r.catalog ? ` · ${r.catalog}` : ''}${r.schema ? `.${r.schema}` : ''} (${r.entries.length})${r.attach_error ? `\n\n⚠ not attached in DuckDB: ${r.attach_error}` : ''}`;
          return { content: [text(`${head}\n${lines.join('\n') || '_(empty)_'}`)], structuredContent: { status: 'ok', ...r } };
        }
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
        const ws = resolveWorkspace(env, workspace_id);
        const r = await ctx.storage.local(principal, ws, p ?? '.');
        const lines = r.entries.map((e) => (e.type === 'file' ? `- ${e.name} (${e.kind}, ${formatBytes(e.size_bytes ?? 0)})${e.queryable ? ` → \`SELECT * FROM '${e.path}'\`` : ''}` : `- 📁 ${e.name}/${e.type === 'table_dir' ? ` (${e.kind} table)` : ''}`));
        return { content: [text(`**${r.mode === 'full' ? r.absolute : r.path === '.' ? 'data directory' : r.path}** (${r.entries.length} entries)\n${lines.join('\n') || '_(empty)_'}`)], structuredContent: { status: 'ok', ...r } };
      },
    }),

    define({
      name: 'inspect_schema',
      title: 'Inspect schema',
      description: "Column names, DuckDB types and nullability for a table/view, a local data file, a remote object (s3://, r2://, gs://, az://), a .duckdb file (all tables), an attached lakehouse table (alias.schema.table) or a SELECT — without scanning the data (DESCRIBE … LIMIT 0). For Databricks tables that are not attached, pass connection_id and the catalog.schema.table name to read Unity Catalog metadata.",
      inputSchema: { file_path_or_table: z.string().min(1), workspace_id: z.string().optional(), connection_id: z.string().optional().describe('Databricks lakehouse connection id for remote (non-attached) tables') },
      annotations: { readOnlyHint: true, openWorldHint: false },
      async handler(env, { file_path_or_table, workspace_id, connection_id }) {
        if (connection_id) {
          const r = await env.ctx.lakehouse.inspectRemote(env.principal, connection_id, file_path_or_table);
          const md = `**${r.target}** (remote${r.format ? ` · ${r.format}` : ''}${r.iceberg_readable ? ' · Iceberg-readable' : ''})\n| column | type | nullable |\n| --- | --- | --- |\n${r.columns.map((c) => `| ${c.name} | ${c.type} | ${c.nullable ? 'yes' : 'no'} |`).join('\n')}\n\nSuggested query (lakehouse_query):\n\`\`\`sql\n${r.suggested_sql}\n\`\`\``;
          return { content: [text(md)], structuredContent: { status: 'ok', ...r } };
        }
        const ws = resolveWorkspace(env, workspace_id);
        const r = await env.ctx.storage.inspect(env.principal, ws, file_path_or_table);
        const md: string[] = [`**${r.target}** (${r.kind}${r.row_count != null ? ` · ${r.row_count.toLocaleString()} rows via ${r.row_count_source}` : ''}${r.size_bytes != null ? ` · ${formatBytes(r.size_bytes)}` : ''})`];
        if (r.tables?.length) for (const t of r.tables) md.push(`\n_${t.schema}.${t.name}_\n| column | type | nullable |\n| --- | --- | --- |\n${t.columns.map((c) => `| ${c.name} | ${c.type} | ${c.nullable ? 'yes' : 'no'} |`).join('\n')}`);
        else md.push(`| column | type | nullable |\n| --- | --- | --- |\n${r.columns.map((c) => `| ${c.name} | ${c.type} | ${c.nullable ? 'yes' : 'no'} |`).join('\n')}`);
        md.push(`\nSuggested query:\n\`\`\`sql\n${r.suggested_sql}\n\`\`\``);
        return { content: [text(md.join('\n'))], structuredContent: { status: 'ok', ...r } };
      },
    }),

    define({
      name: 'lakehouse_query',
      title: 'Run SQL on a lakehouse warehouse',
      description: `Executes SQL remotely on a Databricks SQL warehouse (lakehouse connection with remote SQL) and returns the rows (capped at ${cfg.lakehouse.max_rows}). Use execute_query for attached catalogs instead — it runs in DuckDB and can join with local data. Non-read statements need dry_run=false after human approval.`,
      inputSchema: {
        connection_id: z.string().min(1).describe('Lakehouse connection id (see browse_storage provider=lakehouse)'),
        sql: z.string().min(1).describe('Databricks SQL (Spark SQL dialect)'),
        page_size: z.number().int().min(1).max(mcpCfg.max_page_size).optional().describe(`Rows to return (default ${mcpCfg.default_page_size}, max ${mcpCfg.max_page_size})`),
        dry_run: z.boolean().optional().describe('Default true. Set to false ONLY after a human approved a mutating statement.'),
        workspace_id: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      async handler(env, { connection_id, sql, page_size, dry_run, workspace_id }) {
        const limit = Math.min(page_size ?? mcpCfg.default_page_size, mcpCfg.max_page_size);
        const result = await env.ctx.lakehouse.query(env.principal, connection_id, sql, { maxRows: limit, dryRun: dry_run, workspaceId: workspace_id ?? env.defaultWorkspaceId ?? undefined });
        const rows = truncateRows(result, mcpCfg.max_cell_chars);
        const md = toMarkdownTable({ columns: result.columns, rows }, mcpCfg.max_cell_chars);
        const meta = { status: 'ok', engine: 'databricks', connection_id, row_count: result.rowCount, total_rows: result.totalRows, truncated: result.truncated, duration_ms: result.durationMs, statement_id: result.statement_id };
        return { content: [text(`${md}${result.truncated ? `\n\n_Truncated to ${result.rowCount} rows — aggregate or add a WHERE clause._` : ''}\n\n\`\`\`json\n${JSON.stringify({ ...meta, schema: result.columns }, null, 2)}\n\`\`\``)], structuredContent: { ...meta, columns: result.columns, rows } };
      },
    }),

    define({
      name: 'list_dashboards',
      title: 'List dashboards',
      description: 'Lists dashboards in a workspace, or across all accessible workspaces when workspace_id is omitted. kind "grid" dashboards carry widgets; kind "mosaic" dashboards carry a declarative Mosaic spec.',
      inputSchema: { workspace_id: z.string().optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
      async handler(env, { workspace_id }) {
        const list = workspace_id ? await env.ctx.dashboards.list(env.principal, workspace_id) : await env.ctx.dashboards.listAll(env.principal);
        const detailed = await Promise.all(list.map((d) => env.ctx.dashboards.get(env.principal, d.id)));
        const lines = detailed.map((d) => d.kind === 'mosaic' ? `- **${d.name}** (\`${d.id}\`, workspace \`${d.workspace_id}\`) — Mosaic spec${d.spec && Object.keys(d.spec).length ? '' : ' (empty)'}` : `- **${d.name}** (\`${d.id}\`, workspace \`${d.workspace_id}\`) — ${d.widgets.length} widget(s): ${d.widgets.map((w) => `${w.title} [${w.widget_type}]`).join(', ') || 'none'}`);
        return { content: [text(`**Dashboards** (${detailed.length})\n${lines.join('\n') || '_(none)_'}`)], structuredContent: { status: 'ok', dashboards: detailed.map((d) => ({ id: d.id, name: d.name, description: d.description, workspace_id: d.workspace_id, kind: d.kind, layout: d.layout, spec: d.spec, widgets: d.widgets.map((w) => ({ id: w.id, title: w.title, widget_type: w.widget_type, custom_sql: w.custom_sql, saved_query_id: w.saved_query_id, chart_config: w.chart_config, refresh_interval_sec: w.refresh_interval_sec })) })) } };
      },
    }),

    define({
      name: 'create_dashboard_widget',
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
      async handler(env, { dashboard_id, dashboard_name, workspace_id, title, sql, widget_type, chart_config, refresh_interval_sec }) {
        let dashId = dashboard_id;
        let ws = workspace_id;
        if (!dashId) {
          if (!dashboard_name) throw new HttpError(400, 'Provide dashboard_id, or dashboard_name to create a new dashboard', 'BAD_REQUEST');
          ws = resolveWorkspace(env, ws);
          dashId = (await env.ctx.dashboards.create(env.principal, ws, { name: dashboard_name })).id;
        } else {
          const existing = await env.ctx.dashboards.get(env.principal, dashId);
          if (existing.kind !== 'grid') throw new HttpError(400, 'Widgets belong to grid dashboards; this one is a Mosaic dashboard (edit its spec instead)', 'BAD_REQUEST');
          ws = existing.workspace_id;
        }
        if (widget_type !== 'MARKDOWN') {
          // Dry-run the SQL so agents get immediate feedback on broken queries.
          await env.ctx.queries.run(env.principal, ws, sql, { maxRows: 5, dryRun: true });
        }
        const cfgW = (chart_config ?? {}) as Record<string, unknown>;
        const { widget, layout } = await env.ctx.dashboards.addWidget(env.principal, dashId, {
          title,
          widget_type,
          custom_sql: widget_type === 'MARKDOWN' ? null : sql,
          chart_config: widget_type === 'MARKDOWN' ? { markdown: String(cfgW.markdown ?? sql) } : cfgW,
          refresh_interval_sec: refresh_interval_sec ?? 0,
        });
        return { content: [text(`Added **${widget.title}** (${widget.widget_type}) to dashboard \`${dashId}\`. Open it at /#/dashboards/${dashId}.`)], structuredContent: { status: 'ok', dashboard_id: dashId, workspace_id: ws, widget: { id: widget.id, title: widget.title, widget_type: widget.widget_type, chart_config: widget.chart_config }, layout } };
      },
    }),

    define({
      name: 'create_mosaic_dashboard',
      title: 'Create Mosaic dashboard',
      description: 'Creates (or, with dashboard_id, updates) an interactive Mosaic dashboard from a declarative spec (YAML or JSON, see resource duckdb://guides/mosaic-spec). The spec is validated structurally and every dataset/table is bound in the workspace with EXPLAIN before anything is saved; errors come back as a list to fix. Pass validate_only to check a spec without saving.',
      inputSchema: {
        workspace_id: z.string().optional(),
        name: z.string().optional().describe('Dashboard name (required when creating)'),
        description: z.string().optional(),
        dashboard_id: z.string().optional().describe('Update the spec of this existing Mosaic dashboard instead of creating one'),
        spec: z.record(z.string(), z.unknown()).optional().describe('The spec as a JSON object'),
        spec_text: z.string().optional().describe('The spec as YAML or JSON text (alternative to spec)'),
        validate_only: z.boolean().optional().describe('Validate and report, do not save'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      async handler(env, { workspace_id, name, description, dashboard_id, spec, spec_text, validate_only }) {
        const parsed = spec ?? (spec_text !== undefined ? parseSpecText(spec_text) : null);
        if (!parsed) throw new HttpError(400, 'Provide spec (object) or spec_text (YAML/JSON)', 'BAD_REQUEST');
        let ws = workspace_id;
        if (dashboard_id) {
          const existing = await env.ctx.dashboards.get(env.principal, dashboard_id);
          if (existing.kind !== 'mosaic') throw new HttpError(400, 'That dashboard is a grid dashboard; use create_dashboard_widget for it', 'BAD_REQUEST');
          ws = existing.workspace_id;
        } else ws = resolveWorkspace(env, ws);
        const prepared = await env.ctx.mosaic.prepare(env.principal, ws, parsed);
        const summary = describeSpec(parsed);
        const report = `${summary.plots} plot(s), ${summary.inputs} input(s), ${summary.datasets} dataset(s)${prepared.tables.length ? `, tables: ${prepared.tables.join(', ')}` : ''}`;
        if (!prepared.ok) {
          return { content: [text(`**Spec rejected** (${report}).\n\nErrors:\n${prepared.errors.map((e) => `- ${e}`).join('\n')}${prepared.warnings.length ? `\n\nWarnings:\n${prepared.warnings.map((w) => `- ${w}`).join('\n')}` : ''}\n\nFix the spec and call again. The authoring guide is the resource \`duckdb://guides/mosaic-spec\`.`)], structuredContent: { status: 'invalid', errors: prepared.errors, warnings: prepared.warnings, workspace_id: ws }, isError: true };
        }
        if (validate_only) return { content: [text(`Spec is valid (${report}).${prepared.warnings.length ? `\n\nWarnings:\n${prepared.warnings.map((w) => `- ${w}`).join('\n')}` : ''}`)], structuredContent: { status: 'valid', warnings: prepared.warnings, workspace_id: ws, sources: prepared.sources.map((s) => ({ name: s.name, kind: s.kind })), tables: prepared.tables } };
        const dashboard = dashboard_id
          ? await env.ctx.dashboards.update(env.principal, dashboard_id, { spec: parsed, ...(name ? { name } : {}), ...(description !== undefined ? { description } : {}) })
          : await env.ctx.dashboards.create(env.principal, ws, { name: name ?? summary.title ?? 'Mosaic dashboard', description: description ?? null, kind: 'mosaic', spec: parsed });
        env.ctx.audit.log({ userId: env.principal.userId, actorType: env.principal.actorType, action: dashboard_id ? 'dashboard.update' : 'dashboard.create', resource: `dashboard:${dashboard.id}`, ip: env.principal.ip });
        return { content: [text(`${dashboard_id ? 'Updated' : 'Created'} Mosaic dashboard **${dashboard.name}** (\`${dashboard.id}\`; ${report}). Open it at /#/dashboards/${dashboard.id}.${prepared.warnings.length ? `\n\nWarnings:\n${prepared.warnings.map((w) => `- ${w}`).join('\n')}` : ''}`)], structuredContent: { status: 'ok', dashboard_id: dashboard.id, workspace_id: ws, name: dashboard.name, url: `/#/dashboards/${dashboard.id}`, warnings: prepared.warnings } };
      },
    }),

    // ---------------------------------------------------------------- data connections & syncs
    define({
      name: 'list_data_sources',
      title: 'List data sources',
      description: 'Every configured connection of the caller — object storage (S3/R2/GCS/Azure), lakehouse catalogs, databases (Postgres/MySQL/SQLite/DuckDB files, attached as alias.schema.table) and HTTP endpoints — with health, plus the syncs of a workspace and the catalog of source types DuckView supports.',
      inputSchema: { workspace_id: z.string().optional().describe('List the syncs of this workspace too') },
      annotations: { readOnlyHint: true, openWorldHint: false },
      async handler(env, { workspace_id }) {
        const p = env.principal;
        const [cloud, lakehouse, databases] = await Promise.all([env.ctx.cloud.list(p.userId), env.ctx.lakehouse.list(p.userId), env.ctx.databases.list(p.userId)]);
        const ws = workspace_id ?? env.defaultWorkspaceId ?? null;
        const syncs = ws ? await env.ctx.syncs.list(p, ws) : [];
        const lines = [
          ...cloud.map((c) => `- storage **${c.name}** (${c.provider}${c.bucket ? ` · ${c.bucket}` : ''}) — files as ${c.uri_scheme}://…`),
          ...lakehouse.map((c) => `- lakehouse **${c.name}** (${c.provider}, alias \`${c.alias}\`, ${c.status}) — ${c.example_sql}`),
          ...databases.map((c) => `- database **${c.name}** (${c.engine}, alias \`${c.alias}\`, ${c.status}${c.last_error ? `: ${c.last_error}` : ''}) — ${c.example_sql}`),
        ];
        const syncLines = syncs.map((s) => `- sync **${s.name}** (\`${s.id}\`) → ${s.target_schema}.${s.target_table} · ${s.schedule.kind === 'manual' ? 'manual' : s.schedule.kind === 'interval' ? `every ${s.schedule.minutes} min` : `cron ${s.schedule.expression}`} · ${s.enabled ? 'enabled' : 'paused'} · last ${s.last_run ? `${s.last_run.status}${s.last_run.rows != null ? ` (${s.last_run.rows} rows)` : ''}` : 'never'}`);
        return {
          content: [text(`**Connections** (${lines.length})\n${lines.join('\n') || '_(none — add one under Connections)_'}${ws ? `\n\n**Syncs in workspace ${ws}** (${syncs.length})\n${syncLines.join('\n') || '_(none)_'}` : ''}\n\nSource types available: ${SOURCE_CATALOG.filter((s) => s.status === 'available').map((s) => s.label).join(', ')}.`)],
          structuredContent: { status: 'ok', cloud: cloud.map((c) => ({ id: c.id, name: c.name, provider: c.provider, bucket: c.bucket, uri_scheme: c.uri_scheme })), lakehouse: lakehouse.map((c) => ({ id: c.id, name: c.name, provider: c.provider, alias: c.alias, status: c.status })), databases: databases.map((c) => ({ id: c.id, name: c.name, engine: c.engine, alias: c.alias, status: c.status, last_error: c.last_error })), syncs: syncs.map((s) => ({ id: s.id, name: s.name, target: `${s.target_schema}.${s.target_table}`, source: s.source, schedule: s.schedule, mode: s.mode, enabled: s.enabled, has_transform: !!s.transform_sql, last_run: s.last_run, next_run_at: s.next_run_at })), catalog: SOURCE_CATALOG.map((s) => ({ id: s.id, family: s.family, label: s.label, status: s.status, capabilities: s.capabilities })) },
        };
      },
    }),

    define({
      name: 'create_data_sync',
      title: 'Create data sync',
      description: 'Sets up a scheduled load of a source into a workspace table: source.kind "table" (a table of an attached database or lakehouse: schema + table + database_connection_id or catalog alias), "url" (CSV/JSON/Parquet/Excel over HTTPS, e.g. a Google Sheets CSV export) or "sql" (any read-only SELECT). Optional transform_sql is a SELECT over {{raw}} (the loaded rows) whose result becomes the target; it is validated against the source before saving. schedule: {kind:"manual"} | {kind:"interval", minutes} | {kind:"cron", expression, timezone?}. Pass run_now to load immediately.',
      inputSchema: {
        workspace_id: z.string().optional(),
        name: z.string().min(1).max(160),
        source: z.record(z.string(), z.unknown()).describe('{kind:"table", schema, table, database_connection_id?|catalog?} | {kind:"url", url, format?} | {kind:"sql", sql}'),
        target_table: z.string().min(1).max(63),
        target_schema: z.string().max(63).optional(),
        mode: z.enum(['replace', 'append']).optional(),
        transform_sql: z.string().max(50_000).optional(),
        schedule: z.record(z.string(), z.unknown()).optional(),
        run_now: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      async handler(env, { workspace_id, name, source, target_table, target_schema, mode, transform_sql, schedule, run_now }) {
        const ws = resolveWorkspace(env, workspace_id);
        const src = source as unknown as SyncSource;
        // Prove the source and the transformation before anything is saved: a LIMIT 0 pass binds every column.
        const preview = await env.ctx.syncs.preview(env.principal, ws, src, transform_sql ?? null, 1);
        const sync = await env.ctx.syncs.create(env.principal, ws, { name, source: src, target_table, target_schema, mode, transform_sql: transform_sql ?? null, schedule: (schedule as SyncSchedule | undefined) ?? { kind: 'manual' } });
        const run = run_now ? await env.ctx.syncs.run(sync.id, 'agent', env.principal.userId) : null;
        return {
          content: [text(`Created sync **${sync.name}** (\`${sync.id}\`) → ${sync.target_schema}.${sync.target_table}, ${sync.schedule.kind === 'manual' ? 'run on demand' : sync.schedule.kind === 'interval' ? `every ${sync.schedule.minutes} min` : `cron ${sync.schedule.expression}`}. Columns: ${preview.columns.map((c) => `${c.name} ${c.type}`).join(', ')}.${run ? `\n\nFirst run: ${run.status}${run.rows != null ? ` · ${run.rows} rows` : ''}${run.error ? ` · ${run.error}` : ''} in ${run.duration_ms} ms.` : ''}`)],
          structuredContent: { status: 'ok', sync_id: sync.id, workspace_id: ws, target: `${sync.target_schema}.${sync.target_table}`, columns: preview.columns, run: run ? { id: run.id, status: run.status, rows: run.rows, duration_ms: run.duration_ms, error: run.error } : null },
          isError: run?.status === 'error',
        };
      },
    }),

    define({
      name: 'update_data_sync',
      title: 'Update data sync',
      description: 'Changes a sync: the transformation (validated against the current source), the schedule, the mode, or pauses/resumes it. Use this to attach a transformation an agent has written — transform_sql is a SELECT over {{raw}}.',
      inputSchema: {
        sync_id: z.string(),
        transform_sql: z.string().max(50_000).nullable().optional(),
        schedule: z.record(z.string(), z.unknown()).optional(),
        mode: z.enum(['replace', 'append']).optional(),
        enabled: z.boolean().optional(),
        name: z.string().max(160).optional(),
        run_now: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      async handler(env, { sync_id, transform_sql, schedule, mode, enabled, name, run_now }) {
        const existing = await env.ctx.syncs.get(env.principal, sync_id, 'EDITOR');
        if (transform_sql !== undefined && transform_sql) await env.ctx.syncs.preview(env.principal, existing.workspace_id, existing.source, transform_sql, 1);
        const sync = await env.ctx.syncs.update(env.principal, sync_id, { transform_sql, schedule: schedule as SyncSchedule | undefined, mode, enabled, name });
        const run = run_now ? await env.ctx.syncs.run(sync.id, 'agent', env.principal.userId) : null;
        return { content: [text(`Updated sync **${sync.name}**${transform_sql !== undefined ? transform_sql ? ' with a transformation' : ' (transformation removed)' : ''}.${run ? ` Run: ${run.status}${run.rows != null ? ` · ${run.rows} rows` : ''}${run.error ? ` · ${run.error}` : ''}.` : ''}`)], structuredContent: { status: 'ok', sync_id: sync.id, enabled: sync.enabled, schedule: sync.schedule, has_transform: !!sync.transform_sql, run: run ? { id: run.id, status: run.status, rows: run.rows, error: run.error } : null }, isError: run?.status === 'error' };
      },
    }),

    define({
      name: 'run_data_sync',
      title: 'Run data sync',
      description: 'Runs a sync now and reports rows loaded, duration and any error; also returns the last runs.',
      inputSchema: { sync_id: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      async handler(env, { sync_id }) {
        await env.ctx.syncs.get(env.principal, sync_id, 'EDITOR');
        const run = await env.ctx.syncs.run(sync_id, 'agent', env.principal.userId);
        const runs = await env.ctx.syncs.runs(env.principal, sync_id, 5);
        return { content: [text(`Sync ${run.status}${run.rows != null ? ` · ${run.rows} rows` : ''} in ${run.duration_ms} ms${run.error ? `\n\nError: ${run.error}` : ''}`)], structuredContent: { status: run.status === 'ok' ? 'ok' : 'error', run: { id: run.id, status: run.status, rows: run.rows, duration_ms: run.duration_ms, error: run.error }, recent: runs.map((r) => ({ id: r.id, status: r.status, rows: r.rows, duration_ms: r.duration_ms, started_at: r.started_at, triggered_by: r.triggered_by })) }, isError: run.status !== 'ok' };
      },
    }),
  ];
}

export const TOOL_NAMES = ['execute_query', 'profile_dataset', 'explain_query', 'list_accessible_data', 'save_dataset', 'browse_storage', 'inspect_schema', 'lakehouse_query', 'list_dashboards', 'create_dashboard_widget', 'create_mosaic_dashboard', 'list_data_sources', 'create_data_sync', 'update_data_sync', 'run_data_sync'] as const;
