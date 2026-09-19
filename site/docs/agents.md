---
title: Agents, MCP & Copilot
order: 8
group: Guide
description: The MCP server (stdio, SSE, Streamable HTTP), the REST/OpenAPI façade, registered agents with per-framework snippets, human-in-the-loop approval, and DuckCopilot.
---

DuckView treats agents as first-class users. **One tool registry** backs three surfaces, so they can never drift:

- **MCP server** — stdio, legacy SSE and Streamable HTTP; 10 tools, 3 resources, 2 guided prompts.
- **REST façade** — `GET /api/agent/v1/tools` (names, descriptions, JSON-schema inputs) and `POST /api/agent/v1/tools/<tool>` (returns `{text, structured, is_error}`; invalid arguments → 400).
- **OpenAPI 3.0** — `GET /api/agent/openapi.json`, generated on the fly for Bedrock Agents action groups and AgentCore Gateway targets.

## Transports

| Mode | How |
|---|---|
| stdio | `duckview mcp --token dv_… [--workspace <id>]` (or `DUCKVIEW_API_TOKEN`) — stdout is JSON-RPC only, logs go to stderr |
| SSE (2024-11-05) | `GET /mcp/sse` + `POST /mcp/messages?sessionId=…` with `Authorization: Bearer dv_…` |
| Streamable HTTP (2025-03-26) | `POST/GET/DELETE /mcp` with `Authorization: Bearer dv_…` and `mcp-session-id` |

Tokens need the `mcp` scope (plus `write` for mutations and `admin` for administrative SQL). A token may be pinned to one workspace; otherwise pass `workspace_id` to tools or `?workspace_id=` on connect.

```bash
claude mcp add --transport http duckview http://localhost:4200/mcp --header "Authorization: Bearer dv_…"
```

## Tools

| Tool | Purpose |
|---|---|
| `execute_query(sql, workspace_id?, page_size?, page?, dry_run?)` | Runs SQL; returns a Markdown table + typed JSON (`columns`, `rows`, `total_rows`, `truncated`, `rows_changed`). Hard cap 200 rows per call, long strings truncated. Mutations need `dry_run=false`. Read-only results are served from the [result cache](cache.html). |
| `profile_dataset(table_or_path, workspace_id?)` | `SUMMARIZE` stats: types, min/max, approx distinct, null %, quartiles, row count, footprint. |
| `explain_query(sql, workspace_id?, analyze?)` | Physical plan as JSON tree + ASCII with cardinality estimates; `analyze=true` adds measured timings (read-only SQL only). |
| `list_accessible_data(workspace_id?)` | Workspaces (own and shared), tables/views with columns, every data file / Delta / Iceberg table in the jail, and attached lakehouse catalogs. |
| `save_dataset(sql, output_format, target_filename, workspace_id?, dry_run?)` | `COPY (sql) TO` parquet/csv/json inside the jail (`exports/` by default). |
| `browse_storage(provider?, path?, connection_id?, bucket?, catalog?, schema?)` | One level of the data directory, cloud connections → buckets → objects, or lakehouse connections → schemas → tables. |
| `inspect_schema(file_path_or_table, connection_id?)` | Columns/types/nullability for tables, files, remote objects, `.duckdb` files, attached lakehouse tables or a SELECT — no scan. |
| `lakehouse_query(connection_id, sql, page_size?, dry_run?)` | SQL on a Databricks SQL warehouse; non-read statements need `dry_run=false` after approval. |
| `list_dashboards(workspace_id?)` | Dashboards with their widgets and layouts. |
| `create_dashboard_widget(dashboard_id \| dashboard_name, title, sql, widget_type, chart_config?, refresh_interval_sec?)` | Builds dashboards autonomously; the SQL is validated read-only and dry-run first. |

**Resources** — `duckdb://workspaces`, `duckdb://schemas/{workspace_id}` (DDL + column map + files), `duckdb://system/resources` (CPUs, RAM, DuckDB ceiling, spill disk, active engines).

**Prompts** — `data_quality_audit(table_or_path)` and `sql_optimization(sql)` encode complete agent workflows over the tools above.

## Human-in-the-loop

Any mutating statement from an MCP / API-token actor returns an `approval_required` challenge — the verbs, per-statement previews and how to proceed — instead of executing. The agent shows it to the human; if approved, it calls the tool again with the identical SQL and `dry_run: false`. Members of a shared workspace with **viewer** access cannot mutate even then.

## Registered agents

The **Agent & MCP hub** registers the agents that call DuckView and gives each one a dedicated, workspace-scoped token (`read + mcp`, optionally `write` — mutations are still held for approval). Every tool call is attributed to the agent (call/error counters, "last seen", the live inspector shows the agent name and whether it came over MCP or REST). Copy-paste snippets are generated per framework with the token substituted:

| Framework | Integration |
|---|---|
| **Strands Agents** | `MCPClient(lambda: streamablehttp_client(url, headers=…))` → `Agent(tools=…)` |
| **LangGraph** / **LangChain** | `langchain-mcp-adapters` `MultiServerMCPClient` → `create_react_agent` / `create_agent` |
| **CrewAI** | `MCPServerAdapter({url, transport: "streamable-http", headers})` |
| **AgentCore Runtime** | `BedrockAgentCoreApp` entrypoint deployable with the starter toolkit; DuckView can invoke it back (`InvokeAgentRuntime`) from the hub or as a Copilot backend |
| **AgentCore Gateway** | DuckView as an MCP server target or an OpenAPI target (API-key credential provider holding the DuckView token) |
| **Bedrock Agents (Classic)** | Action group from the generated OpenAPI document + a Lambda forwarder to the REST façade |
| **Custom / HTTP** | `curl`, Python `requests`, or any MCP client config |

Endpoints: `GET/POST /api/agents`, `GET/PATCH/DELETE /api/agents/:id`, `POST /api/agents/:id/rotate-token`, `GET /api/agents/:id/snippets`, `POST /api/agents/:id/test`, `POST /api/agents/:id/invoke` (SSE), `GET /api/agents/discover?kind=…`, `GET /api/agents/frameworks`.

## DuckCopilot

An in-app assistant docked beside the workbench and the dashboard builder. Every turn is hydrated with the workspace's tables and views (columns + types), the data files in the jail, the configured cloud buckets, the SQL in the active tab and — for selected files or tables — `SUMMARIZE` statistics.

| Provider | Notes |
|---|---|
| **Anthropic** | Official SDK, streaming, `claude-opus-5` by default |
| **OpenAI** · **Ollama** | `gpt-4o`, or any local model over the OpenAI-compatible endpoint |
| **Amazon Bedrock** | Converse streaming with model / inference-profile discovery |
| **Bedrock Agent** · **AgentCore runtime** | Route the drawer to your deployed agent; DuckView passes the workspace context along as `payload.context` |

Keys are server-managed (`copilot.*`) or bring-your-own from the drawer (kept in the browser, sent per request, never stored). Actions: *Insert into tab*, *New tab*, *Run & inspect* (executes, then explains the result in business language), *Fix my query*, *Suggest questions*. Conversations persist with the context snapshot of each turn.

`POST /api/copilot/chat` streams SSE events (`context` → `delta`* → `done` | `error`); `GET /api/copilot/config`, `POST /api/copilot/models`, `GET /api/copilot/conversations`, `GET /api/copilot/messages`, `DELETE /api/copilot/conversations/:id`.
