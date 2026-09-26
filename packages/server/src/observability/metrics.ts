import os from 'node:os';
import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';

export const registry = new Registry();
collectDefaultMetrics({ register: registry, prefix: 'duckview_' });

export const metrics = {
  queriesTotal: new Counter({
    name: 'duckview_queries_total',
    help: 'Total SQL queries executed, by actor type, statement class and status',
    labelNames: ['actor', 'class', 'status'] as const,
    registers: [registry],
  }),
  queryDuration: new Histogram({
    name: 'duckview_query_duration_seconds',
    help: 'SQL query execution latency',
    labelNames: ['actor', 'class'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
    registers: [registry],
  }),
  rowsReturned: new Histogram({
    name: 'duckview_query_rows_returned',
    help: 'Rows returned per query (after limits)',
    buckets: [1, 10, 50, 100, 500, 1000, 5000, 10000],
    registers: [registry],
  }),
  activeQueries: new Gauge({ name: 'duckview_active_queries', help: 'Queries currently executing', registers: [registry] }),
  engines: new Gauge({ name: 'duckview_engines_active', help: 'DuckDB instances currently cached', registers: [registry] }),
  mcpConnections: new Gauge({
    name: 'duckview_mcp_connections_active',
    help: 'Active MCP transports',
    labelNames: ['transport'] as const,
    registers: [registry],
  }),
  mcpToolCalls: new Counter({
    name: 'duckview_mcp_tool_calls_total',
    help: 'MCP tool invocations',
    labelNames: ['tool', 'status'] as const,
    registers: [registry],
  }),
  mcpToolDuration: new Histogram({
    name: 'duckview_mcp_tool_duration_seconds',
    help: 'MCP tool latency',
    labelNames: ['tool'] as const,
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
    registers: [registry],
  }),
  hitlChallenges: new Counter({ name: 'duckview_mcp_hitl_challenges_total', help: 'Mutating agent queries blocked pending approval', registers: [registry] }),
  sandboxViolations: new Counter({ name: 'duckview_sandbox_violations_total', help: 'Rejected path/extension/setting attempts', labelNames: ['actor'] as const, registers: [registry] }),
  wsConnections: new Gauge({ name: 'duckview_ws_connections_active', help: 'Active WebSocket streaming clients', registers: [registry] }),
  hostMemoryBytes: new Gauge({ name: 'duckview_host_memory_total_bytes', help: 'Host total memory', registers: [registry] }),
  hostMemoryFreeBytes: new Gauge({ name: 'duckview_host_memory_free_bytes', help: 'Host free memory', registers: [registry] }),
  duckdbMemoryLimitBytes: new Gauge({ name: 'duckview_duckdb_memory_limit_bytes', help: 'Configured DuckDB memory ceiling per engine', labelNames: ['workspace'] as const, registers: [registry] }),
  copilotRequests: new Counter({ name: 'duckview_copilot_requests_total', help: 'DuckCopilot turns by provider and status', labelNames: ['provider', 'status'] as const, registers: [registry] }),
  copilotDuration: new Histogram({ name: 'duckview_copilot_duration_seconds', help: 'DuckCopilot turn latency', labelNames: ['provider'] as const, buckets: [0.5, 1, 2, 5, 10, 20, 40, 80], registers: [registry] }),
  // The DuckView agent (agent/runtime): enough to compare decision engines and models without redesigning anything.
  agentTasks: new Counter({ name: 'duckview_agent_tasks_total', help: 'Agent tasks finished, by status, decision engine and origin', labelNames: ['status', 'decision_engine', 'via'] as const, registers: [registry] }),
  agentTaskDuration: new Histogram({ name: 'duckview_agent_task_duration_seconds', help: 'Agent task wall time', labelNames: ['decision_engine'] as const, buckets: [0.5, 1, 2, 5, 10, 20, 40, 80, 160, 320], registers: [registry] }),
  agentDecisionDuration: new Histogram({ name: 'duckview_agent_decision_seconds', help: 'Time spent choosing context and tools, per task', labelNames: ['decision_engine'] as const, buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5], registers: [registry] }),
  agentReasoningDuration: new Histogram({ name: 'duckview_agent_reasoning_seconds', help: 'Time spent in the reasoning model, per task', labelNames: ['provider'] as const, buckets: [0.5, 1, 2, 5, 10, 20, 40, 80, 160], registers: [registry] }),
  agentToolCalls: new Counter({ name: 'duckview_agent_tool_calls_total', help: 'Tool calls made by the agent', labelNames: ['tool', 'status'] as const, registers: [registry] }),
  agentContextObjects: new Histogram({ name: 'duckview_agent_context_objects', help: 'Context objects per task: considered and selected', labelNames: ['stage'] as const, buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 5000], registers: [registry] }),
  agentContextTokens: new Histogram({ name: 'duckview_agent_context_tokens', help: 'Estimated tokens of workspace context per task', buckets: [100, 250, 500, 1000, 2000, 4000, 8000, 16000, 32000], registers: [registry] }),
  agentLlmTokens: new Counter({ name: 'duckview_agent_llm_tokens_total', help: 'LLM tokens used by the agent', labelNames: ['provider', 'direction'] as const, registers: [registry] }),
  agentCost: new Counter({ name: 'duckview_agent_estimated_cost_usd_total', help: 'Estimated LLM cost of agent tasks (agent.pricing)', labelNames: ['provider'] as const, registers: [registry] }),
  copilotTokens: new Counter({ name: 'duckview_copilot_tokens_total', help: 'LLM tokens consumed by DuckCopilot', labelNames: ['provider', 'direction'] as const, registers: [registry] }),
  auditEvents: new Counter({ name: 'duckview_audit_events_total', help: 'Audit log entries written', labelNames: ['action', 'actor'] as const, registers: [registry] }),
  cacheLookups: new Counter({ name: 'duckview_cache_lookups_total', help: 'Result cache lookups by kind and outcome', labelNames: ['kind', 'result'] as const, registers: [registry] }),
  cacheBytes: new Gauge({ name: 'duckview_cache_bytes', help: 'Bytes held by the server result cache', registers: [registry] }),
  cacheEntries: new Gauge({ name: 'duckview_cache_entries', help: 'Entries held by the server result cache', registers: [registry] }),
  mosaicExec: new Counter({ name: 'duckview_mosaic_exec_total', help: 'Mosaic pre-aggregation plumbing statements by kind', labelNames: ['kind'] as const, registers: [registry] }),
};

metrics.hostMemoryBytes.set(os.totalmem());
setInterval(() => {
  metrics.hostMemoryBytes.set(os.totalmem());
  metrics.hostMemoryFreeBytes.set(os.freemem());
}, 10_000).unref();

export async function renderMetrics(): Promise<string> {
  return registry.metrics();
}
