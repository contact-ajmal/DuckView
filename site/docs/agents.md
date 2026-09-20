---
title: Agents, MCP & Copilot
order: 12
group: Guide
description: The MCP server (stdio, SSE, Streamable HTTP), the REST/OpenAPI façade, registered agents with per-framework snippets, human-in-the-loop approval, and DuckCopilot.
---

DuckView treats agents as first-class users. **One tool registry** backs three surfaces, so they can never drift:

- **MCP server** — stdio, legacy SSE and Streamable HTTP; 25 tools, 4 resources, 5 guided prompts.
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
| `create_mosaic_dashboard(spec \| spec_text, name?, description?, dashboard_id?, validate_only?, workspace_id?)` | Creates or updates an interactive Mosaic dashboard from a declarative spec (YAML/JSON). Validated structurally and every dataset/table bound with EXPLAIN before saving; errors come back as a list to fix. |
| `list_data_sources(workspace_id?)` | Every connection with health (connector connections included), the syncs of a workspace, the source-type catalog. |
| `browse_connector(connection_id, path?)` | Walks a warehouse, SaaS or Google connection one level at a time; leaves carry the `resource` for `create_data_sync`. |
| `connector_query(connection_id, sql, limit?)` | Read-only SQL on Snowflake, BigQuery, Redshift or ClickHouse; rows capped. |
| `create_data_sync(name, source, target_table, …, transform_sql?, schedule?, run_now?)` | Scheduled load of a table / connector resource / URL / SELECT into a workspace table with an optional `{{raw}}` transformation, validated first. |
| `update_data_sync(sync_id, transform_sql?, schedule?, mode?, enabled?, run_now?)` | Attach a transformation, change the schedule, pause/resume. |
| `run_data_sync(sync_id)` | Run now; rows, duration, error, recent runs. |
| `list_apps` · `create_app(name, source, …)` · `update_app` · `run_app` · `stop_app` · `get_app_logs` · `preview_app` · `publish_app` | Streamlit [data apps](apps.html): generated from a dashboard, saved queries or code (validated first), run, previewed with a screenshot, published after human approval. |

**Resources** — `duckdb://workspaces`, `duckdb://schemas/{workspace_id}` (DDL + column map + files), `duckdb://system/resources` (CPUs, RAM, DuckDB ceiling, spill disk, active engines), `duckdb://guides/mosaic-spec` (how to write a Mosaic dashboard spec).

**Prompts** — `data_quality_audit(table_or_path)`, `sql_optimization(sql)`, `build_mosaic_dashboard(table_or_path, goal?)` and `build_data_pipeline(source, goal?)` encode complete agent workflows over the tools above.

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

Providers: Claude, ChatGPT / OpenAI, Gemini, DeepSeek, OpenRouter, Kimi, Groq, Mistral, Grok, a local Ollama, any OpenAI-compatible endpoint, and Amazon Bedrock / Bedrock Agent / AgentCore. **Settings → Copilot** is the console: pick a vendor card, paste a key (linked to the vendor's console), *Test connection*, *Save for everyone* — stored encrypted, applied immediately, overriding `copilot.*` in the config file; people can also bring their own key (kept in the browser, sent per request, never stored). The **Usage** panel lists the sessions running now and tokens per day, model and person. Actions: *Insert into tab*, *New tab*, *Run & inspect* (executes, then explains the result in business language), *Fix my query*, *Suggest questions*, *Build dashboard* (drafts a Mosaic dashboard spec, validated against your data and created in one click — see [Mosaic dashboards](mosaic.html)). Conversations persist with the context snapshot of each turn.

`POST /api/copilot/chat` streams SSE events (`context` → `delta`* → `done` | `error`); `GET /api/copilot/config` · `GET /api/copilot/providers` · `POST /api/copilot/models` · `GET/PUT/DELETE /api/copilot/settings` + `POST /api/copilot/settings/test` (administrators) · `GET /api/copilot/usage` · `GET /api/copilot/conversations` · `GET /api/copilot/messages` · `DELETE /api/copilot/conversations/:id`.
