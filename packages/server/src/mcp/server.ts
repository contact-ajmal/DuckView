/**
 * DuckView MCP server: tools, resources and prompts bound to a single authenticated principal.
 * A new McpServer is built per transport session so that authorization is baked into every handler.
 * Tools come from the shared registry (agent/tools.ts) — the same definitions back the REST façade and OpenAPI.
 */
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import type { Principal } from '../services/principal.js';
import { formatBytes } from '../engine/results.js';
import { buildTools, runTool, type ToolEnv } from '../agent/tools.js';

export const MCP_SERVER_INFO = { name: 'duckview', version: '1.0.0' } as const;

export { summarizePlan } from '../agent/tools.js';

/** Registered-agent reference for a token principal (null for user sessions / plain tokens). */
export async function agentRef(ctx: AppContext, principal: Principal): Promise<ToolEnv['agent']> {
  const a = await ctx.agents.byTokenId(principal.tokenId);
  return a ? { id: a.id, name: a.name, framework: a.framework } : null;
}

export function buildMcpServer(ctx: AppContext, principal: Principal, opts: { defaultWorkspaceId?: string | null; agent?: ToolEnv['agent'] } = {}): McpServer {
  const server = new McpServer(MCP_SERVER_INFO, {
    instructions: [
      'DuckView exposes sandboxed DuckDB workspaces. Every tool needs a workspace_id — read the duckdb://workspaces resource or call list_accessible_data to discover them.',
      'Results are capped (default 50 rows, max 200) — use page/page_size for more, and prefer aggregations over dumping tables.',
      'Mutating SQL (DROP/DELETE/ALTER/UPDATE/INSERT/CREATE/COPY) is blocked until you re-issue it with dry_run=false after a human approves.',
      'File paths in SQL are relative to the workspace data directory; absolute paths outside it are rejected.',
      'Lakehouse catalogs (AWS Glue, S3 Tables, Iceberg REST, Databricks) appear as alias.schema.table — browse them with browse_storage provider=lakehouse; Databricks SQL warehouses are queried with lakehouse_query.',
    ].join(' '),
  });

  const env: ToolEnv = { ctx, principal, defaultWorkspaceId: opts.defaultWorkspaceId ?? null, via: 'mcp', agent: opts.agent ?? null };

  // ------------------------------------------------------------------ tools (shared registry)
  for (const tool of buildTools(ctx.cfg)) {
    server.registerTool(tool.name, { title: tool.title, description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations }, (args: Record<string, unknown>) => runTool(env, tool, args));
  }

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

