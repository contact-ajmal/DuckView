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
import type { SyncSource, SyncSchedule, QualityCheck } from '../db/schema/sqlite.js';
import { describeCheck } from '../services/quality.js';
import type { AppSource } from '../services/apps.js';
import { framework } from '../services/app-frameworks.js';

export type ToolContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
export type ToolResult = { content: ToolContent[]; structuredContent?: Record<string, unknown>; isError?: boolean };

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
        // What people wrote about it (catalog notes).
        const notes = (await env.ctx.lineage.annotations(env.principal, ws).catch(() => [])).filter((n) => n.object_name.toLowerCase() === file_path_or_table.trim().toLowerCase());
        const table = notes.find((n) => !n.column_name);
        const cols = notes.filter((n) => n.column_name);
        if (table?.description || table?.tags.length) md.splice(1, 0, `${table.description ?? ''}${table.tags.length ? ` _tags: ${table.tags.join(', ')}_` : ''}`.trim());
        if (cols.length) md.push(`\nColumn notes:\n${cols.map((c) => `- **${c.column_name}**: ${c.description ?? ''}${c.tags.length ? ` _(${c.tags.join(', ')})_` : ''}`).join('\n')}`);
        md.push(`\nSuggested query:\n\`\`\`sql\n${r.suggested_sql}\n\`\`\``);
        return { content: [text(md.join('\n'))], structuredContent: { status: 'ok', ...r, annotations: notes.map((n) => ({ column: n.column_name, description: n.description, tags: n.tags })) } };
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
      description: 'Every configured connection of the caller — object storage (S3/R2/GCS/Azure), lakehouse catalogs, databases (Postgres/MySQL/SQLite/DuckDB files, attached as alias.schema.table), and connector connections (Snowflake, BigQuery, Redshift, ClickHouse, Fabric, Salesforce, HubSpot, Stripe, GA4, Airtable, Notion, Google Drive, Google Sheets; browse them with browse_connector, warehouses also answer connector_query) — with health, plus the syncs of a workspace and the catalog of source types DuckView supports.',
      inputSchema: { workspace_id: z.string().optional().describe('List the syncs of this workspace too') },
      annotations: { readOnlyHint: true, openWorldHint: false },
      async handler(env, { workspace_id }) {
        const p = env.principal;
        const [cloud, lakehouse, databases, connectors] = await Promise.all([env.ctx.cloud.list(p.userId), env.ctx.lakehouse.list(p.userId), env.ctx.databases.list(p.userId), env.ctx.connectors.list(p.userId)]);
        const ws = workspace_id ?? env.defaultWorkspaceId ?? null;
        const syncs = ws ? await env.ctx.syncs.list(p, ws) : [];
        const lines = [
          ...cloud.map((c) => `- storage **${c.name}** (${c.provider}${c.bucket ? ` · ${c.bucket}` : ''}) — files as ${c.uri_scheme}://…`),
          ...lakehouse.map((c) => `- lakehouse **${c.name}** (${c.provider}, alias \`${c.alias}\`, ${c.status}) — ${c.example_sql}`),
          ...databases.map((c) => `- database **${c.name}** (${c.engine}, alias \`${c.alias}\`, ${c.status}${c.last_error ? `: ${c.last_error}` : ''}) — ${c.example_sql}`),
          ...connectors.map((c) => `- ${c.connector_label} **${c.name}** (\`${c.id}\`${c.account_label ? ` · ${c.account_label}` : ''}, ${c.status}${c.last_error ? `: ${c.last_error}` : ''}) — browse_connector${c.remote_sql ? ' · connector_query' : ''}; sync with source {kind:"connector", connection_id, resource}`),
        ];
        const syncLines = syncs.map((s) => `- sync **${s.name}** (\`${s.id}\`) → ${s.target_schema}.${s.target_table} · ${s.schedule.kind === 'manual' ? 'manual' : s.schedule.kind === 'interval' ? `every ${s.schedule.minutes} min` : `cron ${s.schedule.expression}`} · ${s.enabled ? 'enabled' : 'paused'} · last ${s.last_run ? `${s.last_run.status}${s.last_run.rows != null ? ` (${s.last_run.rows} rows)` : ''}` : 'never'}`);
        return {
          content: [text(`**Connections** (${lines.length})\n${lines.join('\n') || '_(none — add one under Connections)_'}${ws ? `\n\n**Syncs in workspace ${ws}** (${syncs.length})\n${syncLines.join('\n') || '_(none)_'}` : ''}\n\nSource types available: ${SOURCE_CATALOG.filter((s) => s.status === 'available').map((s) => s.label).join(', ')}.`)],
          structuredContent: { status: 'ok', cloud: cloud.map((c) => ({ id: c.id, name: c.name, provider: c.provider, bucket: c.bucket, uri_scheme: c.uri_scheme })), lakehouse: lakehouse.map((c) => ({ id: c.id, name: c.name, provider: c.provider, alias: c.alias, status: c.status })), databases: databases.map((c) => ({ id: c.id, name: c.name, engine: c.engine, alias: c.alias, status: c.status, last_error: c.last_error })), connectors: connectors.map((c) => ({ id: c.id, name: c.name, connector: c.connector, account: c.account_label, status: c.status, last_error: c.last_error, remote_sql: c.remote_sql })), syncs: syncs.map((s) => ({ id: s.id, name: s.name, target: `${s.target_schema}.${s.target_table}`, source: s.source, schedule: s.schedule, mode: s.mode, enabled: s.enabled, has_transform: !!s.transform_sql, last_run: s.last_run, next_run_at: s.next_run_at })), catalog: SOURCE_CATALOG.map((s) => ({ id: s.id, family: s.family, label: s.label, status: s.status, capabilities: s.capabilities })) },
        };
      },
    }),

    define({
      name: 'create_data_sync',
      title: 'Create data sync',
      description: 'Sets up a scheduled load of a source into a workspace table: source.kind "table" (a table of an attached database or lakehouse: schema + table + database_connection_id or catalog alias), "url" (CSV/JSON/Parquet/Excel over HTTPS, e.g. a Google Sheets CSV export), "connector" (connection_id of a connector connection + the resource object a browse_connector leaf returned, or {sql} for a warehouse) or "sql" (any read-only SELECT). Optional transform_sql is a SELECT over {{raw}} (the loaded rows) whose result becomes the target; it is validated against the source before saving. schedule: {kind:"manual"} | {kind:"interval", minutes} | {kind:"cron", expression, timezone?}. Pass run_now to load immediately.',
      inputSchema: {
        workspace_id: z.string().optional(),
        name: z.string().min(1).max(160),
        source: z.record(z.string(), z.unknown()).describe('{kind:"table", schema, table, database_connection_id?|catalog?} | {kind:"url", url, format?} | {kind:"connector", connection_id, resource} | {kind:"sql", sql}'),
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

    // ---------------------------------------------------------------- connectors (warehouses, SaaS, Google)
    define({
      name: 'browse_connector',
      title: 'Browse connector',
      description: 'Walks what a connector connection offers, one level at a time: Snowflake/ClickHouse databases → schemas → tables, BigQuery datasets → tables, Redshift schemas → tables, Fabric items → tables, Salesforce/HubSpot objects, Stripe resources, GA4 report presets, Airtable bases → tables, Notion databases, Drive folders → files, Sheets spreadsheets → tabs. Leaves carry the `resource` to pass to create_data_sync as source {kind:"connector", connection_id, resource}; folders carry a `path` to browse deeper.',
      inputSchema: { connection_id: z.string().describe('A connector connection id from list_data_sources'), path: z.array(z.string()).optional().describe('The `path` of a non-leaf entry from a previous call') },
      annotations: { readOnlyHint: true, openWorldHint: true },
      async handler(env, { connection_id, path: p }) {
        const r = await env.ctx.connectors.browse(env.principal.userId, connection_id, p ?? []);
        const lines = r.entries.slice(0, 200).map((e) => `- ${e.type} **${e.name}**${e.hint ? ` — ${e.hint}` : ''}${e.resource ? ` · resource ${JSON.stringify(e.resource)}` : e.path ? ` · path ${JSON.stringify(e.path)}` : ''}`);
        return { content: [text(`**${r.connection.name}** (${r.connection.connector})${r.path.length ? ` / ${r.path.join(' / ')}` : ''}: ${r.entries.length} entr${r.entries.length === 1 ? 'y' : 'ies'}\n${lines.join('\n')}${r.entries.length > 200 ? '\n…' : ''}`)], structuredContent: { status: 'ok', connection: r.connection, path: r.path, entries: r.entries } };
      },
    }),

    define({
      name: 'connector_query',
      title: 'Query warehouse connector',
      description: 'Runs a read-only SQL statement on a warehouse connection (Snowflake, BigQuery, Redshift, ClickHouse) and returns the rows (capped). To keep a result in DuckDB, create_data_sync with source {kind:"connector", connection_id, resource:{sql}}.',
      inputSchema: { connection_id: z.string(), sql: z.string().min(1).max(50_000), limit: z.number().int().min(1).max(10_000).optional().describe('Default 200') },
      annotations: { readOnlyHint: true, openWorldHint: true },
      async handler(env, { connection_id, sql, limit }) {
        const r = await env.ctx.connectors.query(env.principal.userId, connection_id, sql, { limit: limit ?? 200 });
        const cols = r.rows[0] ? Object.keys(r.rows[0]) : [];
        return { content: [text(`${r.rows.length} row${r.rows.length === 1 ? '' : 's'} from **${r.connection}**${r.truncated ? ' (truncated)' : ''}${cols.length ? `\n\n${toMarkdownTable({ columns: cols.map((n) => ({ name: n, type: 'VARCHAR', kind: 'string' as const })), rows: r.rows.slice(0, 50).map((row) => cols.map((c) => row[c])) }, 80)}` : ''}`)], structuredContent: { status: 'ok', connection: r.connection, columns: cols, rows: r.rows, truncated: r.truncated } };
      },
    }),

    // ---------------------------------------------------------------- data apps (Streamlit)
    define({
      name: 'list_apps',
      title: 'List data apps',
      description: 'The Streamlit data apps of a workspace: status (stopped / installing / starting / running / error), URL, visibility, who created them, last start and error. Apps are Python programs DuckView runs on the workspace\'s data; see the resource duckdb://guides/data-app for how they are written.',
      inputSchema: { workspace_id: z.string().optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
      async handler(env, { workspace_id }) {
        const ws = resolveWorkspace(env, workspace_id);
        const apps = await env.ctx.apps.list(env.principal, ws);
        const lines = apps.map((a) => `- **${a.name}** (\`${a.id}\`) · ${a.status}${a.running ? '' : ''} · ${a.visibility === 'org' ? 'everyone signed in' : 'workspace members'} · ${a.url}${a.last_error ? ` · ⚠ ${a.last_error}` : ''}`);
        return { content: [text(`**Data apps** (${apps.length})${env.ctx.apps.enabled ? '' : ' — disabled on this server (apps.enabled)'}\n${lines.join('\n') || '_(none — create_app builds one from a dashboard, saved queries or code)_'}`)], structuredContent: { status: 'ok', enabled: env.ctx.apps.enabled, apps: apps.map((a) => ({ id: a.id, name: a.name, status: a.status, url: a.url, visibility: a.visibility, entry: a.entry, description: a.description, last_started_at: a.last_started_at, last_error: a.last_error, spec: a.spec })) } };
      },
    }),

    define({
      name: 'create_app',
      title: 'Create data app',
      description: 'Creates a Streamlit data app on the workspace\'s data. source: {dashboard_id} generates the app deterministically from a Mosaic dashboard (its datasets, filters, KPIs, charts and tables) or a grid dashboard (its widgets); {saved_query_ids} / {queries: [{name, sql}]} build a query browser; {template: "explorer" | "blank" (Streamlit) | "dash-explorer" (Dash) | "gradio-query" (Gradio)} starts from a template; {code, requirements?, kind?} takes app.py as written (kind: "streamlit" — the default —, "dash" or "gradio") (read duckdb://guides/data-app first). The code is checked before it is saved — it must compile, import streamlit and carry no token — and the app can be started right away (run_now) so preview_app can look at it. execution "browser" runs it in each viewer\'s browser instead (stlite / Pyodide: no server process, the viewer\'s own read-only access; pure-Python requirements only).',
      inputSchema: {
        name: z.string().min(1).max(120),
        source: z.record(z.string(), z.unknown()).describe('{dashboard_id} | {saved_query_ids: [...]} | {queries: [{name, sql}]} | {template} | {code, requirements?, kind?: "streamlit" | "dash" | "gradio"}'),
        description: z.string().max(2000).optional(),
        visibility: z.enum(['workspace', 'org']).optional().describe('Who can open it: workspace members (default) or everyone signed in'),
        execution: z.enum(['server', 'browser']).optional().describe('Where the Python runs: "server" (default) or "browser" (stlite in each viewer\'s browser)'),
        run_now: z.boolean().optional().describe('Start the app after creating it (default true)'),
        workspace_id: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      async handler(env, { name, source, description, visibility, execution, run_now, workspace_id }) {
        const ws = resolveWorkspace(env, workspace_id);
        const g = await env.ctx.apps.generate(env.principal, ws, source as unknown as AppSource, { name, description: description ?? null });
        const check = await env.ctx.apps.validateSource(g.files, 'app.py', g.kind);
        if (!check.ok) return { content: [text(`The app was not saved — fix these and try again:\n${check.errors.map((e) => `- ${e}`).join('\n')}`)], structuredContent: { status: 'invalid', errors: check.errors, warnings: check.warnings }, isError: true };
        const app = await env.ctx.apps.create(env.principal, ws, { name, description: description ?? g.description, files: g.files, spec: g.spec, visibility, execution, kind: g.kind });
        let started: { status: string; last_error: string | null } | null = null;
        let startError: string | null = null;
        if (run_now !== false && env.ctx.apps.enabled) {
          try {
            started = await env.ctx.apps.start(env.principal, app.id);
          } catch (err) {
            startError = (err as Error).message;
          }
        }
        const logs = env.ctx.apps.logs(app.id).slice(-8);
        return {
          content: [text(`Created app **${app.name}** (\`${app.id}\`) from ${g.summary}; open it at ${app.url}.${check.warnings.length ? `\nWarnings: ${check.warnings.join('; ')}` : ''}${started ? `\nStatus: ${started.status}.` : startError ? `\nIt did not start: ${startError}\n\nLog:\n${logs.join('\n')}` : ''}\n\nNext: preview_app to see it, update_app to change the code, publish_app to make it visible to everyone.`)],
          structuredContent: { status: startError ? 'error' : 'ok', app_id: app.id, workspace_id: ws, name: app.name, url: app.url, summary: g.summary, app_status: started?.status ?? (startError ? 'error' : 'stopped'), start_error: startError, warnings: check.warnings, files: Object.keys(g.files), code: g.files['app.py'] },
          isError: !!startError,
        };
      },
    }),

    define({
      name: 'update_app',
      title: 'Update data app',
      description: 'Changes an app: new code (app.py) and/or requirements.txt — checked like create_app — name or description. A running app restarts with the new code; pass run_now to start a stopped one.',
      inputSchema: { app_id: z.string(), code: z.string().max(2_000_000).optional(), requirements: z.string().max(20_000).optional(), name: z.string().max(120).optional(), description: z.string().max(2000).nullable().optional(), run_now: z.boolean().optional() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      async handler(env, { app_id, code, requirements, name, description, run_now }) {
        const existing = await env.ctx.apps.get(env.principal, app_id, 'EDITOR');
        const files = code !== undefined || requirements !== undefined ? { ...existing.files, ...(code !== undefined ? { [existing.entry]: code } : {}), ...(requirements !== undefined ? { 'requirements.txt': requirements } : {}) } : undefined;
        if (files) {
          const check = await env.ctx.apps.validateSource(files, existing.entry, existing.kind);
          if (!check.ok) return { content: [text(`Not saved — fix these first:\n${check.errors.map((e) => `- ${e}`).join('\n')}`)], structuredContent: { status: 'invalid', errors: check.errors, warnings: check.warnings }, isError: true };
        }
        const app = await env.ctx.apps.update(env.principal, app_id, { files, name, description });
        let error: string | null = null;
        if (run_now && !env.ctx.apps.status(app_id)) {
          try {
            await env.ctx.apps.start(env.principal, app_id);
          } catch (err) {
            error = (err as Error).message;
          }
        }
        const status = env.ctx.apps.status(app_id) ?? (await env.ctx.apps.get(env.principal, app_id)).status;
        return { content: [text(`Updated **${app.name}**${files ? ' with new code' : ''} · status ${status}${error ? ` · start failed: ${error}` : ''}.`)], structuredContent: { status: error ? 'error' : 'ok', app_id, app_status: status, error }, isError: !!error };
      },
    }),

    define({
      name: 'run_app',
      title: 'Run data app',
      description: 'Starts an app (creates the Python environment on the very first start) and waits until it answers its health check; returns the URL and the last log lines.',
      inputSchema: { app_id: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      async handler(env, { app_id }) {
        const app = await env.ctx.apps.start(env.principal, app_id);
        if (app.execution === 'browser') return { content: [text(`**${app.name}** runs in each viewer's browser — there is nothing to start; it is ready at ${app.url} (preview_app loads it in a headless browser).`)], structuredContent: { status: 'ok', app_id, app_status: app.status, execution: 'browser', url: app.url, logs: [] } };
        return { content: [text(`**${app.name}** is ${app.status} at ${app.url}.\n\n${env.ctx.apps.logs(app_id).slice(-5).join('\n')}`)], structuredContent: { status: 'ok', app_id, app_status: app.status, url: app.url, logs: env.ctx.apps.logs(app_id).slice(-20) } };
      },
    }),

    define({
      name: 'stop_app',
      title: 'Stop data app',
      description: 'Stops a running app and revokes its token.',
      inputSchema: { app_id: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      async handler(env, { app_id }) {
        await env.ctx.apps.stop(env.principal, app_id);
        return { content: [text(`Stopped \`${app_id}\`.`)], structuredContent: { status: 'ok', app_id, app_status: 'stopped' } };
      },
    }),

    define({
      name: 'get_app_logs',
      title: 'Get app logs',
      description: 'The last lines of an app\'s stdout/stderr (install steps, Streamlit output, tracebacks) with its status — the place to look when an app errors.',
      inputSchema: { app_id: z.string(), lines: z.number().int().min(1).max(500).optional().describe('Default 100') },
      annotations: { readOnlyHint: true, openWorldHint: false },
      async handler(env, { app_id, lines }) {
        const app = await env.ctx.apps.get(env.principal, app_id);
        const status = env.ctx.apps.status(app_id) ?? app.status;
        const logs = env.ctx.apps.logs(app_id).slice(-(lines ?? 100));
        return { content: [text(`**${app.name}** · ${status}${app.last_error ? ` · ${app.last_error}` : ''}\n\n\`\`\`\n${logs.join('\n') || '(no log lines)'}\n\`\`\``)], structuredContent: { status: 'ok', app_id, app_status: status, last_error: app.last_error, logs } };
      },
    }),

    define({
      name: 'preview_app',
      title: 'Preview data app',
      description: 'Looks at a running app the way a person would: a headless browser opens it, waits for Streamlit to finish rendering, and returns the visible text plus a screenshot (image) when a Chrome/Chromium is installed on the server — otherwise the text-only health, page state and recent logs. Use it after create_app / update_app to check that charts render and nothing errors.',
      inputSchema: { app_id: z.string(), wait_ms: z.number().int().min(1000).max(60_000).optional().describe('How long to wait for the render (default 25 s)') },
      annotations: { readOnlyHint: true, openWorldHint: false },
      async handler(env, { app_id, wait_ms }) {
        const row = await env.ctx.apps.get(env.principal, app_id);
        const app = env.ctx.apps.toPublic(row);
        const inBrowser = row.execution === 'browser';
        if (!inBrowser && !env.ctx.apps.target(app_id)) return { content: [text(`**${app.name}** is ${env.ctx.apps.status(app_id) ?? app.status}${app.last_error ? `: ${app.last_error}` : ''} — run_app first.`)], structuredContent: { status: 'not_running', app_id, app_status: env.ctx.apps.status(app_id) ?? app.status, last_error: app.last_error }, isError: true };
        // An in-browser app has no server to check: the headless browser loading it is the health check.
        const health = inBrowser ? env.ctx.apps.browserReady : await fetch(`http://${env.ctx.apps.target(app_id)!.host}:${env.ctx.apps.target(app_id)!.port}${framework(row.kind).healthPath(`/apps/${app_id}`)}`).then((r) => r.ok).catch(() => false);
        const logs = env.ctx.apps.logs(app_id).slice(-15);
        const tracebacks = logs.filter((l) => /Traceback|Error/.test(l));
        let shot: { png: Buffer; text: string } | null = null;
        try {
          shot = await env.ctx.apps.screenshot(row, env.principal.userId, env.ctx.apps.proxyUrl, { wait_ms });
        } catch (err) {
          logs.push(`preview: ${(err as Error).message}`);
        }
        const content: ToolContent[] = [text(`**${app.name}** at ${app.url} · health ${health ? 'ok' : 'FAILED'}${tracebacks.length ? `\n\n⚠ Errors in the log:\n${tracebacks.join('\n')}` : ''}${shot ? `\n\nVisible text:\n${shot.text.slice(0, 3000)}` : '\n\n(no Chrome/Chromium on this server — set apps.chrome_path for screenshots; text below is the log)\n' + logs.join('\n')}`)];
        if (shot) content.push({ type: 'image', data: shot.png.toString('base64'), mimeType: 'image/png' });
        const exception = shot ? /Traceback|Error:|KeyError|NameError|SyntaxError/.test(shot.text) : tracebacks.length > 0;
        return { content, structuredContent: { status: health && !exception ? 'ok' : 'error', app_id, url: app.url, health, screenshot: !!shot, text: shot?.text ?? null, errors: tracebacks, logs }, isError: !health };
      },
    }),

    define({
      name: 'publish_app',
      title: 'Publish data app',
      description: 'Makes an app visible beyond the workspace (audience "org": everyone signed in to DuckView) or back to "workspace". Publishing is a human-approved step: dry_run (default true) reports what would change; pass dry_run=false after approval. On servers with publish review (apps.publish_requires_approval) an agent\'s publish becomes a request an administrator approves in DuckView — the result says "pending".',
      inputSchema: { app_id: z.string(), audience: z.enum(['workspace', 'org']), note: z.string().max(1000).optional().describe('What the app is for, shown to the reviewer.'), dry_run: z.boolean().optional().describe('Default true. Set false once approved.') },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      async handler(env, { app_id, audience, note, dry_run }) {
        const app = await env.ctx.apps.get(env.principal, app_id, 'EDITOR');
        const review = audience === 'org' && env.ctx.cfg.apps.publish_requires_approval;
        if (dry_run !== false) {
          return { content: [text(`APPROVAL REQUIRED\n\nPublishing **${app.name}** to ${audience === 'org' ? 'everyone signed in to this DuckView' : 'the workspace\'s members only'} (currently: ${app.visibility}${app.publish_status === 'pending' ? ', a publish request is pending' : ''}).${review ? ' This server also has administrators review publish requests: after dry_run=false the app stays with the workspace until one approves it.' : ''} Call publish_app again with dry_run=false once a person has approved.`)], structuredContent: { status: 'approval_required', app_id, from: app.visibility, to: audience, review, url: `/apps/${app.id}/` } };
        }
        const { app: updated, outcome } = await env.ctx.apps.publish(env.principal, app_id, audience, note);
        const message = outcome === 'pending' ? `Publish request for **${updated.name}** sent: an administrator approves it under Settings → Data apps; until then it stays visible to workspace members only (${updated.url}).` : `**${updated.name}** is now visible to ${audience === 'org' ? 'everyone signed in' : 'workspace members'}: ${updated.url}`;
        return { content: [text(message)], structuredContent: { status: outcome === 'pending' ? 'pending' : 'ok', outcome, app_id, visibility: updated.visibility, publish_status: updated.publish_status, url: updated.url } };
      },
    }),

    define({
      name: 'list_alerts',
      title: 'List SQL alerts',
      description: 'The workspace\'s SQL alerts: query, condition, schedule, state (ok / triggered / error / unknown), last value and the channels they notify — plus the notification channels (Slack, Teams, email, PagerDuty, webhooks) an alert can use.',
      inputSchema: { workspace_id: z.string().optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
      async handler(env, { workspace_id }) {
        const ws = resolveWorkspace(env, workspace_id);
        const alerts = await env.ctx.alerts.list(env.principal, ws);
        const channels = await env.ctx.notifications.list(env.principal, ws);
        const lines = alerts.map((a) => `- **${a.name}** (\`${a.id}\`) · ${a.state}${a.last_value !== null ? ` (${a.last_value})` : ''} · ${a.condition.kind === 'threshold' ? `${a.condition.column} ${a.condition.op} ${a.condition.value}` : a.condition.kind} · ${a.schedule.kind === 'interval' ? `every ${a.schedule.minutes} min` : a.schedule.kind === 'cron' ? a.schedule.expression : 'manual'}${a.enabled ? '' : ' · disabled'}`);
        return { content: [text(`${alerts.length} alert${alerts.length === 1 ? '' : 's'}:\n${lines.join('\n') || '(none)'}\n\nChannels: ${channels.map((c) => `${c.name} [${c.type}] \`${c.id}\``).join(', ') || '(none — create one under Alerts → Channels)'}`)], structuredContent: { alerts: alerts.map((a) => ({ id: a.id, name: a.name, state: a.state, last_value: a.last_value, condition: a.condition, schedule: a.schedule, enabled: a.enabled, channel_ids: a.channel_ids })), channels: channels.map((c) => ({ id: c.id, name: c.name, type: c.type, scope: c.scope })) } };
      },
    }),

    define({
      name: 'create_alert',
      title: 'Create SQL alert',
      description: 'Creates an alert: a read-only SQL query checked on a schedule, with a condition — {kind:"rows"} (returns rows), {kind:"no_rows"} (returns none, e.g. data freshness) or {kind:"threshold", column, op, value} (the first row\'s column compared with a number). When the state changes it notifies channel_ids (see list_alerts). With test_first (default true) the query is tried once and the result is shown; nothing is saved when it fails.',
      inputSchema: {
        name: z.string().min(1).max(120),
        sql: z.string().max(100_000),
        condition: z.union([z.object({ kind: z.literal('rows') }), z.object({ kind: z.literal('no_rows') }), z.object({ kind: z.literal('threshold'), column: z.string(), op: z.enum(['>', '>=', '<', '<=', '=', '!=']), value: z.number() })]),
        every_minutes: z.number().int().min(1).optional().describe('Check interval (default 60)'),
        cron: z.string().optional().describe('Cron expression instead of every_minutes, e.g. "0 8 * * 1-5"'),
        timezone: z.string().optional(),
        channel_ids: z.array(z.string()).optional(),
        severity: z.enum(['info', 'warning', 'critical']).optional(),
        description: z.string().max(2000).optional(),
        test_first: z.boolean().optional(),
        workspace_id: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      async handler(env, { name, sql, condition, every_minutes, cron, timezone, channel_ids, severity, description, test_first, workspace_id }) {
        const ws = resolveWorkspace(env, workspace_id);
        if (test_first !== false) {
          const e = await env.ctx.alerts.preview(env.principal, ws, sql, condition);
          if (e.state === 'error') return { content: [text(`Not saved — the query failed: ${e.error}`)], structuredContent: { status: 'error', error: e.error }, isError: true };
        }
        const alert = await env.ctx.alerts.create(env.principal, ws, { name, sql, condition, description: description ?? null, schedule: cron ? { kind: 'cron', expression: cron, timezone } : { kind: 'interval', minutes: every_minutes ?? 60 }, channel_ids, severity });
        const first = await env.ctx.alerts.run(alert.id, 'agent', env.principal);
        return { content: [text(`Created alert **${alert.name}** (\`${alert.id}\`): ${first.evaluation.summary} State: ${first.alert.state}${first.notified ? `, ${first.notified} channel${first.notified === 1 ? '' : 's'} notified` : ''}. ${alert.channel_ids.length ? '' : 'It has no channels yet — add channel_ids with the Alerts page or update it.'}`)], structuredContent: { status: 'ok', alert_id: alert.id, state: first.alert.state, value: first.evaluation.value, notified: first.notified, next_run_at: alert.next_run_at } };
      },
    }),

    define({
      name: 'run_alert',
      title: 'Check SQL alert now',
      description: 'Runs an alert\'s query now, updates its state and notifies its channels if the state changed; returns what it found.',
      inputSchema: { alert_id: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      async handler(env, { alert_id }) {
        await env.ctx.alerts.get(env.principal, alert_id, 'EDITOR');
        const r = await env.ctx.alerts.run(alert_id, 'agent', env.principal);
        return { content: [text(`**${r.alert.name}**: ${r.evaluation.summary} State ${r.alert.state}${r.changed ? ' (changed)' : ''}${r.notified ? `, ${r.notified} notified` : ''}.`)], structuredContent: { status: r.evaluation.state === 'error' ? 'error' : 'ok', alert_id, state: r.alert.state, changed: r.changed, value: r.evaluation.value, notified: r.notified, error: r.evaluation.error }, isError: r.evaluation.state === 'error' };
      },
    }),

    define({
      name: 'snapshot_dashboard',
      title: 'Snapshot dashboard or app',
      description: 'Renders a dashboard (or a data app) the way a person sees it — a headless browser on the server — and returns the picture, so you can check a dashboard you built or describe one. Nothing is saved or sent; scheduled delivery to Slack / Teams / email is set up under Alerts → Snapshots.',
      inputSchema: { dashboard_id: z.string().optional(), app_id: z.string().optional(), width: z.number().int().min(640).max(2400).optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
      async handler(env, { dashboard_id, app_id, width }) {
        if (!dashboard_id === !app_id) return { content: [text('Pass dashboard_id or app_id.')], structuredContent: { status: 'error' }, isError: true };
        const user = await env.ctx.auth.findById(env.principal.userId);
        if (!user) return { content: [text('Unknown user')], isError: true };
        const target = dashboard_id ? { kind: 'dashboard' as const, dashboard_id } : { kind: 'app' as const, app_id: app_id! };
        const owner = dashboard_id ? await env.ctx.dashboards.get(env.principal, dashboard_id) : await env.ctx.apps.get(env.principal, app_id!);
        try {
          const r = await env.ctx.snapshots.render({ id: 'adhoc', workspace_id: owner.workspace_id, user_id: user.id, name: owner.name, target, format: 'png', width: width ?? 1280, schedule: { kind: 'manual' }, channel_ids: [], enabled: false, last_status: null, last_error: null, last_run_at: null, next_run_at: null, created_at: new Date(), updated_at: new Date() }, user);
          return { content: [text(`**${r.title}** rendered (${Math.round(r.png.length / 1024)} KB PNG).`), { type: 'image', data: r.png.toString('base64'), mimeType: 'image/png' }], structuredContent: { status: 'ok', title: r.title, bytes: r.png.length } };
        } catch (err) {
          return { content: [text(`Could not render: ${(err as Error).message}`)], structuredContent: { status: 'error', error: (err as Error).message }, isError: true };
        }
      },
    }),

    // ---------------------------------------------------------------- dbt projects (Transform)
    define({
      name: 'list_dbt_projects',
      title: 'List dbt projects',
      description: 'The dbt projects of a workspace (Transform → dbt): their models and seeds, schedule, and the last run with what failed. DuckView compiles projects with dbt Core (dbt-duckdb) and runs them in the workspace engine; read duckdb://guides/dbt for what is supported.',
      inputSchema: { workspace_id: z.string().optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
      async handler(env, { workspace_id }) {
        const ws = resolveWorkspace(env, workspace_id);
        const projects = await env.ctx.dbt.list(env.principal, ws);
        const full = await Promise.all(projects.map((p) => env.ctx.dbt.get(env.principal, p.id)));
        const rows = full.map((p) => {
          const models = Object.keys(p.files).filter((f) => /^models\/.+\.sql$/i.test(f));
          return { id: p.id, name: p.name, target_schema: p.target_schema, models: models.map((m) => m.split('/').pop()!.replace(/\.sql$/i, '')), files: Object.keys(p.files).length, schedule: p.schedule, scheduled: p.scheduled, enabled: p.enabled, last_run: p.last_run };
        });
        return { content: [text(rows.length ? rows.map((r) => `- **${r.name}** (\`${r.id}\`) · ${r.models.length} models: ${r.models.join(', ')} · last run: ${r.last_run ? `${r.last_run.command} ${r.last_run.status}${r.last_run.summary ? ` (${r.last_run.summary})` : ''}` : 'never'}`).join('\n') : 'No dbt projects in this workspace. create_dbt_project starts one.')], structuredContent: { status: 'ok', workspace_id: ws, projects: rows } };
      },
    }),

    define({
      name: 'get_dbt_project',
      title: 'Read dbt project files',
      description: 'Lists the files of a dbt project and returns their contents (all of them when the project is small, else the paths you ask for).',
      inputSchema: { project_id: z.string(), paths: z.array(z.string()).optional().describe('Files to return; default: everything up to ~60 KB') },
      annotations: { readOnlyHint: true, openWorldHint: false },
      async handler(env, { project_id, paths }) {
        const p = await env.ctx.dbt.get(env.principal, project_id);
        const names = Object.keys(p.files).sort();
        let budget = 60_000;
        const wanted = paths?.length ? paths.filter((x) => x in p.files) : names.filter((n) => !n.endsWith('.gitkeep'));
        const shown: Record<string, string> = {};
        for (const n of wanted) {
          const c = p.files[n] ?? '';
          if (!paths?.length && c.length > budget) continue;
          shown[n] = c;
          budget -= c.length;
        }
        const body = Object.entries(shown).map(([n, c]) => `### ${n}\n\`\`\`${n.endsWith('.sql') ? 'sql' : /\.ya?ml$/.test(n) ? 'yaml' : ''}\n${c}\n\`\`\``).join('\n\n');
        return { content: [text(`**${p.name}** — ${names.length} files: ${names.join(', ')}\n\n${body}`)], structuredContent: { status: 'ok', project_id: p.id, name: p.name, target_schema: p.target_schema, vars: p.vars, paths: names, files: shown } };
      },
    }),

    define({
      name: 'create_dbt_project',
      title: 'Create dbt project',
      description: 'Creates a dbt project in a workspace — from the starter (a seed, a staging view, a table and tests) when no files are given, or from files ({path: content}, with dbt_project.yml at the root; DuckView writes profiles.yml).',
      inputSchema: { name: z.string().min(1).max(120), workspace_id: z.string().optional(), files: z.record(z.string(), z.string()).optional(), target_schema: z.string().max(63).optional() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      async handler(env, { name, workspace_id, files, target_schema }) {
        const ws = resolveWorkspace(env, workspace_id);
        const p = await env.ctx.dbt.create(env.principal, ws, { name, files, target_schema });
        return { content: [text(`Created dbt project **${p.name}** (\`${p.id}\`) with ${Object.keys(p.files).length} files: ${Object.keys(p.files).join(', ')}. Run it with run_dbt.`)], structuredContent: { status: 'ok', project_id: p.id, paths: Object.keys(p.files) } };
      },
    }),

    define({
      name: 'write_dbt_files',
      title: 'Write dbt project files',
      description: 'Adds or replaces files of a dbt project ({path: content}) and deletes others ({path: null}): models (.sql with Jinja: ref, source, config, is_incremental), YAML (descriptions, sources, data tests), seeds (.csv), macros. Nothing runs until run_dbt; compile first to check.',
      inputSchema: { project_id: z.string(), files: z.record(z.string(), z.string().nullable()) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      async handler(env, { project_id, files }) {
        const p = await env.ctx.dbt.writeFiles(env.principal, project_id, files);
        const changed = Object.entries(files).map(([n, c]) => `${c === null ? 'deleted' : 'wrote'} ${n}`);
        return { content: [text(`**${p.name}**: ${changed.join(', ')}.`)], structuredContent: { status: 'ok', project_id: p.id, paths: Object.keys(p.files) } };
      },
    }),

    define({
      name: 'create_dbt_model',
      title: 'Create dbt model from SQL',
      description: 'Turns a SELECT into a model of a dbt project: models/<folder>/<name>.sql with a config block (view, table or incremental with unique_key), references to the project\'s own models and seeds rewritten to ref(), and the description in YAML. Test the SELECT with execute_query first.',
      inputSchema: { project_id: z.string(), name: z.string().min(1).max(63), sql: z.string().min(1).max(200_000), folder: z.string().max(200).optional().describe('e.g. marts or staging'), materialized: z.enum(['view', 'table', 'incremental']).optional(), unique_key: z.string().max(200).optional(), description: z.string().max(4000).optional(), overwrite: z.boolean().optional() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      async handler(env, { project_id, ...input }) {
        const r = await env.ctx.dbt.addModel(env.principal, project_id, input);
        return { content: [text(`Wrote \`${r.path}\`${r.refs.length ? ` (ref() for ${r.refs.join(', ')})` : ''}:\n\`\`\`sql\n${r.sql}\`\`\`\nRun it with run_dbt {command: "build", select: "${input.name}"}.`)], structuredContent: { status: 'ok', project_id, path: r.path, sql: r.sql, refs: r.refs } };
      },
    }),

    define({
      name: 'run_dbt',
      title: 'Run dbt',
      description: 'Runs a dbt command on a project and waits for it: build (seeds, models, tests in order; failures skip what is downstream), run (models), test, seed, or compile (nothing executed — returns each node\'s compiled SQL). select / exclude use dbt syntax (model+, tag:x, path:models/marts). build, run and seed create or replace tables, so for agents they first return an approval challenge listing what would be built; after a person approves, call again with dry_run: false.',
      inputSchema: { project_id: z.string(), command: z.enum(['build', 'run', 'test', 'seed', 'compile']), select: z.string().max(2000).optional(), exclude: z.string().max(2000).optional(), full_refresh: z.boolean().optional(), dry_run: z.boolean().optional() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      async handler(env, { project_id, command, select, exclude, full_refresh, dry_run }) {
        const { done } = await env.ctx.dbt.start(env.principal, project_id, { command, select, exclude, full_refresh }, env.principal.actorType === 'AGENT' ? 'agent' : 'manual', { approved: dry_run === false });
        const run = await done;
        const results = run.results ?? [];
        const lines = results.map((r) => `- ${r.status.toUpperCase()} ${r.resource_type} **${r.relation ?? r.name}**${r.materialized ? ` (${r.materialized})` : ''}${r.rows != null ? ` · ${r.rows} rows` : ''}${r.failures ? ` · ${r.failures} failing rows` : ''}${r.message ? ` — ${r.message}` : ''}`);
        const sql = command === 'compile' ? results.filter((r) => r.sql).slice(0, 10).map((r) => `### ${r.name}\n\`\`\`sql\n${r.sql}\n\`\`\``).join('\n') : '';
        return {
          content: [text(`dbt ${command}${select ? ` --select ${select}` : ''} → **${run.status}**${run.summary ? ` (${run.summary})` : ''} in ${((run.duration_ms ?? 0) / 1000).toFixed(1)} s${run.error ? `\n\nError: ${run.error}` : ''}\n\n${lines.join('\n')}${sql ? `\n\n${sql}` : ''}`)],
          structuredContent: { status: run.status === 'ok' ? 'ok' : 'error', run_id: run.id, summary: run.summary, error: run.error, results: results.map(({ sql: s, ...r }) => ({ ...r, sql: command === 'compile' ? s : undefined })) },
          isError: run.status !== 'ok',
        };
      },
    }),

    define({
      name: 'get_dbt_run',
      title: 'Get dbt run',
      description: 'A dbt run\'s outcome: every node with its status, rows, failing rows and message, the error, and (include_log) the tail of dbt\'s log.',
      inputSchema: { run_id: z.string(), include_log: z.boolean().optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
      async handler(env, { run_id, include_log }) {
        const run = await env.ctx.dbt.getRun(env.principal, run_id);
        const lines = run.results.map((r) => `- ${r.status.toUpperCase()} ${r.resource_type} **${r.relation ?? r.name}**${r.message ? ` — ${r.message}` : ''}`);
        return { content: [text(`dbt ${run.command} (${run.triggered_by}) → **${run.status}**${run.summary ? ` (${run.summary})` : ''}${run.error ? `\nError: ${run.error}` : ''}\n${lines.join('\n')}${include_log && run.log ? `\n\n\`\`\`\n${run.log.slice(-6000)}\n\`\`\`` : ''}`)], structuredContent: { status: 'ok', run: { ...run, log: include_log ? run.log?.slice(-20_000) : undefined } } };
      },
    }),
    // ---------------------------------------------------------------- semantic layer (metrics)
    define({
      name: 'list_metrics',
      title: 'List metrics',
      description: 'The metrics defined in the workspace\'s semantic layer (hand-written or from dbt): name, label, description, how each is computed and the dimensions it can be grouped by (metric_time with a grain such as metric_time__month, categorical dimensions, and <entity>__<dimension> across joins). Prefer these definitions over writing the aggregation yourself; query them with query_metrics.',
      inputSchema: { workspace_id: z.string().optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
      async handler(env, { workspace_id }) {
        const ws = resolveWorkspace(env, workspace_id);
        const r = await env.ctx.semantic.get(env.principal, ws);
        const lines = r.metrics.map((m) => `- **${m.name}**${m.label ? ` (${m.label})` : ''} · ${m.type}${m.description ? ` — ${m.description}` : ''}${m.error ? ` · ERROR ${m.error}` : ''}\n  dimensions: ${m.dimensions.join(', ') || '(none)'}`);
        return { content: [text(lines.length ? `${lines.length} metric${lines.length === 1 ? '' : 's'}:\n${lines.join('\n')}` : 'No metrics defined yet (Transform → Metrics, or semantic models and metrics in a dbt project).')], structuredContent: { status: 'ok', workspace_id: ws, metrics: r.metrics.map((m) => ({ name: m.name, label: m.label, description: m.description, type: m.type, source: m.source, dimensions: m.dimensions, error: m.error })), semantic_models: r.semantic_models.map((m) => ({ name: m.name, table: m.label, dimensions: m.dimensions.map((d) => d.name), measures: m.measures.map((x) => x.name), entities: m.entities.map((e) => e.name) })) } };
      },
    }),

    define({
      name: 'query_metrics',
      title: 'Query metrics',
      description: 'Computes semantic-layer metrics exactly as defined: metrics, group_by (dimensions; time grains as metric_time__day|week|month|quarter|year or <time_dim>__<grain>; joined dimensions as <entity>__<dimension>), where filters ({dimension, op, value} with op =, !=, >, >=, <, <=, in, not in, between, like, is null, is not null), order_by and limit. Returns the rows and the SQL it compiled to. Read-only.',
      inputSchema: {
        metrics: z.array(z.string()).min(1).max(30),
        group_by: z.array(z.string()).max(10).optional(),
        where: z.array(z.object({ dimension: z.string(), op: z.enum(['=', '!=', '>', '>=', '<', '<=', 'in', 'not in', 'between', 'like', 'is null', 'is not null']), value: z.unknown().optional() })).max(20).optional(),
        order_by: z.array(z.object({ name: z.string(), desc: z.boolean().optional() })).max(10).optional(),
        limit: z.number().int().min(1).max(10_000).optional(),
        workspace_id: z.string().optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      async handler(env, { workspace_id, ...q }) {
        const ws = resolveWorkspace(env, workspace_id);
        const r = await env.ctx.semantic.query(env.principal, ws, q);
        return {
          content: [text(`${r.result.rowCount} row${r.result.rowCount === 1 ? '' : 's'} — ${r.metrics.map((m) => m.label ?? m.name).join(', ')}${r.group_by.length ? ` by ${r.group_by.join(', ')}` : ''}\n\n${toMarkdownTable(r.result, 60)}\n\nSQL:\n\`\`\`sql\n${r.sql}\n\`\`\``)],
          structuredContent: { status: 'ok', columns: r.result.columns.map((c) => c.name), rows: r.result.rows, row_count: r.result.rowCount, truncated: r.result.truncated, sql: r.sql },
        };
      },
    }),
    // ---------------------------------------------------------------- data quality
    define({
      name: 'list_quality_suites',
      title: 'List data quality checks',
      description: 'The data quality suites of the workspace — checks on a table (not_null, unique, accepted_values, range, relationships, expression, row_count, freshness, custom_sql) — with each suite\'s status (pass, warn, fail, error) and the checks failing in its latest run, plus the latest dbt test results of the workspace\'s dbt projects. Check this before trusting a table or when data looks wrong.',
      inputSchema: { workspace_id: z.string().optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
      async handler(env, { workspace_id }) {
        const ws = resolveWorkspace(env, workspace_id);
        const suites = await env.ctx.quality.list(env.principal, ws);
        const lines: string[] = [];
        const structured = [];
        for (const s of suites) {
          const latest = s.last_run ? await env.ctx.quality.latest(env.principal, s.id) : null;
          const failing = (latest?.results ?? []).filter((r) => r.status !== 'pass').map((r) => ({ check_id: r.check_id, label: r.label, status: r.status, failures: r.failures, message: r.message, sql: r.sql }));
          lines.push(`- **${s.name}** (\`${s.id}\`) on ${s.relation}: ${s.status}${s.last_run ? ` — ${s.last_run.summary}` : ' (not run yet)'}${failing.map((f) => `\n  - ${f.status}: ${f.label} — ${f.message}`).join('')}`);
          structured.push({ id: s.id, name: s.name, relation: s.relation, status: s.status, checks: s.checks.length, summary: s.last_run?.summary ?? null, last_run_at: s.last_run?.finished_at ?? null, failing });
        }
        const dbt = await env.ctx.quality.dbtTests(env.principal, ws);
        for (const d of dbt) {
          const bad = d.tests.filter((t) => t.status !== 'pass');
          lines.push(`- dbt project **${d.project_name}**: ${d.tests.length - bad.length} of ${d.tests.length} tests passed${bad.map((t) => `\n  - ${t.status}: ${t.name}${t.failures ? ` (${t.failures} failing rows)` : ''}`).join('')}`);
        }
        return { content: [text(lines.length ? lines.join('\n') : 'No data quality checks yet. Create a suite with create_quality_suite (suggest_quality_checks proposes checks from the data).')], structuredContent: { status: 'ok', workspace_id: ws, suites: structured, dbt_tests: dbt } };
      },
    }),

    define({
      name: 'suggest_quality_checks',
      title: 'Suggest data quality checks',
      description: 'Profiles a table and proposes checks it satisfies today: at least one row, not_null for complete columns, unique ids, accepted_values for small categories, non-negative amounts, and relationships to tables the id columns point at. Nothing is saved; pass the checks (edited as needed) to create_quality_suite.',
      inputSchema: { table: z.string().describe('table, schema.table or database.schema.table'), workspace_id: z.string().optional() },
      annotations: { readOnlyHint: true, openWorldHint: false },
      async handler(env, { table, workspace_id }) {
        const ws = resolveWorkspace(env, workspace_id);
        const checks = await env.ctx.quality.suggest(env.principal, ws, table);
        return { content: [text(`${checks.length} suggested check${checks.length === 1 ? '' : 's'} for ${table}:\n${checks.map((c) => `- ${c.type}: ${describeCheck(c)}${c.severity === 'warn' ? ' (warn)' : ''}`).join('\n')}`)], structuredContent: { status: 'ok', table, checks } };
      },
    }),

    define({
      name: 'create_quality_suite',
      title: 'Create data quality checks',
      description: 'Saves a suite of data quality checks on a table and runs it once. Each check: {type, column?, severity: "error"|"warn", tolerance?, where?} plus by type — accepted_values: values; range: min and/or max; relationships: to (table), to_column; expression: a condition every row must satisfy; row_count: min and/or max; freshness: column, max_age_hours; custom_sql: a SELECT returning the failing rows ({{ table }} is the table). Leave checks out to use the suggested ones. Optionally a schedule (every_minutes ≥ 5 or cron) and channel_ids to notify when the status changes (see list_alerts for channels).',
      inputSchema: {
        table: z.string(),
        name: z.string().max(120).optional(),
        checks: z.array(z.record(z.string(), z.unknown())).max(200).optional(),
        every_minutes: z.number().int().min(5).optional(),
        cron: z.string().optional(),
        timezone: z.string().optional(),
        channel_ids: z.array(z.string()).optional(),
        description: z.string().max(2000).optional(),
        workspace_id: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      async handler(env, { table, name, checks, every_minutes, cron, timezone, channel_ids, description, workspace_id }) {
        const ws = resolveWorkspace(env, workspace_id);
        const wanted = checks?.length ? (checks as Partial<QualityCheck>[]) : await env.ctx.quality.suggest(env.principal, ws, table);
        const suite = await env.ctx.quality.create(env.principal, ws, { name: name ?? `${table} quality`, relation: table, description: description ?? null, checks: wanted, schedule: cron ? { kind: 'cron', expression: cron, timezone } : every_minutes ? { kind: 'interval', minutes: every_minutes } : { kind: 'manual' }, channel_ids });
        const r = await env.ctx.quality.run(suite.id, 'agent', env.principal);
        const bad = r.run.results.filter((x) => x.status !== 'pass');
        return { content: [text(`Created **${suite.name}** (\`${suite.id}\`) with ${suite.checks.length} checks on ${table}. First run: ${r.run.status} — ${r.run.summary}${bad.map((x) => `\n- ${x.status}: ${x.label} — ${x.message}`).join('')}`)], structuredContent: { status: 'ok', suite_id: suite.id, run_id: r.run.id, result: r.run.status, summary: r.run.summary, checks: suite.checks } };
      },
    }),

    define({
      name: 'run_quality_suite',
      title: 'Run data quality checks',
      description: 'Runs a data quality suite now, records the run and notifies its channels if its status changed. Returns each check\'s outcome, failing-row counts, a sample of failing rows and the SQL that finds them.',
      inputSchema: { suite_id: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      async handler(env, { suite_id }) {
        await env.ctx.quality.get(env.principal, suite_id, 'EDITOR');
        const r = await env.ctx.quality.run(suite_id, 'agent', env.principal);
        const lines = r.run.results.map((x) => `- ${x.status}: ${x.label} — ${x.message}${x.status !== 'pass' && x.sql ? `\n  \`${x.sql.replace(/\s+/g, ' ').slice(0, 300)}\`` : ''}`);
        return { content: [text(`**${r.suite.name}**: ${r.run.status}${r.changed ? ' (changed)' : ''} — ${r.run.summary}${r.run.notified ? ` ${r.run.notified} channel(s) notified.` : ''}\n${lines.join('\n')}`)], structuredContent: { status: 'ok', suite_id, run_id: r.run.id, result: r.run.status, changed: r.changed, summary: r.run.summary, results: r.run.results.map(({ sample, ...x }) => ({ ...x, sample_rows: sample?.rows.slice(0, 3) ?? [] })) } };
      },
    }),
  ];
}

export const TOOL_NAMES = ['execute_query', 'profile_dataset', 'explain_query', 'list_accessible_data', 'save_dataset', 'browse_storage', 'inspect_schema', 'lakehouse_query', 'list_dashboards', 'create_dashboard_widget', 'create_mosaic_dashboard', 'list_data_sources', 'create_data_sync', 'update_data_sync', 'run_data_sync', 'browse_connector', 'connector_query', 'list_apps', 'create_app', 'update_app', 'run_app', 'stop_app', 'get_app_logs', 'preview_app', 'publish_app', 'list_alerts', 'create_alert', 'run_alert', 'snapshot_dashboard', 'list_dbt_projects', 'get_dbt_project', 'create_dbt_project', 'write_dbt_files', 'create_dbt_model', 'run_dbt', 'get_dbt_run', 'list_metrics', 'query_metrics', 'list_quality_suites', 'suggest_quality_checks', 'create_quality_suite', 'run_quality_suite'] as const;
