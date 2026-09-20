---
title: HTTP API, CLI & observability
order: 9
group: Reference
description: Every endpoint group, the uniform error shape, the duckview CLI, Prometheus metrics and OpenTelemetry traces.
---

## HTTP API

All API routes live under `/api` and take `Authorization: Bearer <jwt>` (UI sessions) or `Authorization: Bearer dv_…` (API tokens).

| Area | Endpoints |
|---|---|
| Auth | `POST /api/auth/login` · `POST /api/auth/register` · `GET /api/auth/me` · `POST /api/auth/password` · `GET /api/auth/oidc/login` · `GET /api/auth/oidc/callback` |
| Workspaces | `GET/POST /api/workspaces` · `GET/PATCH/DELETE /api/workspaces/:id` · `POST /api/workspaces/:id/restart` · `…/tabs` CRUD (per user) |
| Sharing | `GET/PUT /api/workspaces/:id/members` · `DELETE …/members/:memberId` · `POST …/leave` · `POST …/transfer` · `GET /api/users/directory` · `GET/POST /api/groups` · `PATCH/DELETE /api/groups/:id` · `GET/PUT /api/groups/:id/members` · `DELETE …/members/:userId` |
| Storage explorer | `GET/POST/DELETE /api/workspaces/:id/folders` · `GET /api/storage/browse` · `GET /api/storage/local` · `GET /api/storage/cloud` · `POST /api/storage/inspect` |
| Cloud connections | `GET /api/cloud-connections/providers` · `GET/POST/PATCH/DELETE /api/cloud-connections` · `POST /api/cloud-connections/:id/test` |
| Exports | `POST /api/workspaces/:id/export {sql, format: parquet\|csv\|json\|arrow}` · `GET /api/exports` · `GET /api/exports/:id/download` · `DELETE /api/exports/:id` |
| BI | `…/queries` CRUD · `…/dashboards` CRUD (`kind: grid\|mosaic`, `spec`) · `GET/PATCH/DELETE /api/dashboards/:id` (layout, spec) · `POST/PATCH/DELETE /api/dashboards/:id/widgets[/:wid]` · `POST /api/dashboards/:id/widgets/:wid/data` |
| Connections | `GET /api/sources/catalog` · `GET /api/sources` · `GET/POST /api/database-connections` · `PATCH/DELETE /api/database-connections/:id` · `POST …/:id/test` · `GET …/:id/browse` · `GET/POST /api/workspaces/:id/syncs` · `POST …/syncs/preview` · `GET/PATCH/DELETE /api/syncs/:id` · `POST /api/syncs/:id/run` · `GET /api/syncs/:id/runs` |
| Mosaic | `POST /api/workspaces/:id/mosaic {type: arrow\|json\|exec, sql}` (Arrow IPC / JSON reads with ETag; admitted plumbing statements) · `POST /api/workspaces/:id/mosaic/prepare {spec \| spec_text}` (validate + bind a spec) · `GET /api/mosaic/info` |
| Data | `POST /api/workspaces/:id/files` (multipart upload) · `DELETE /api/workspaces/:id/files?path=` · `POST /api/workspaces/:id/overview` · `GET /api/workspaces/:id/catalog` |
| Query | `POST /api/workspaces/:id/query` · `/explain` · `/profile` · `/save` · `WS /api/ws/query` (auth → run/cancel; schema → rows* → done) |
| Cache | `query`, `explain`, `profile`, `overview`, `storage/inspect` and widget data are conditional (`ETag` / `If-None-Match` → 304, `refresh: true`) · `DELETE /api/workspaces/:id/cache` · `POST /api/admin/cache/clear` |
| Live | `WS /api/ws/events` — audit rows, MCP tool invocations, session and workspace-epoch events in real time · `GET /api/system/live` — CPU, RAM, `duckdb_memory()` per engine, disk usage, cache stats |
| Agents | `GET/POST/DELETE /api/tokens` · `GET /api/mcp/sessions` · `GET /api/mcp/info` · `/api/agents…` · `GET /api/agent/openapi.json` · `GET/POST /api/agent/v1/tools[/:tool]` |
| Lakehouse | `GET /api/lakehouse/providers` · `/api/lakehouse-connections…` · `GET /api/lakehouse/browse` · `GET /api/lakehouse/:id/inspect` · `POST /api/lakehouse/:id/query` · `POST /api/lakehouse/:id/materialize` |
| Copilot | `POST /api/copilot/chat` (SSE) · `GET /api/copilot/config` · `GET /api/copilot/providers` · `POST /api/copilot/models` · `GET/PUT/DELETE /api/copilot/settings` + `POST /api/copilot/settings/test` (admin) · `GET /api/copilot/usage` · `GET /api/copilot/conversations` · `GET /api/copilot/messages` · `DELETE /api/copilot/conversations/:id` |
| Ops | `GET /api/system` · `GET /api/audit` · `GET/POST/PATCH/DELETE /api/admin/users` · `GET /api/admin/engines` · `POST /api/admin/engines/:id/evict` · `GET /api/admin/config` |
| Probes | `GET /healthz` · `GET /readyz` · `GET /metrics` |

### Errors

Uniform JSON: `{ error, message, request_id, challenge? }`.

| Status | `error` | When |
|---|---|---|
| 400 | `SQL_ERROR`, `BAD_REQUEST`, `VALIDATION_ERROR` | DuckDB parser/binder errors, bad input |
| 403 | `SANDBOX_VIOLATION`, `FORBIDDEN` | Path or extension outside policy; role or scope too low |
| 404 | `NOT_FOUND` | Also for workspaces the caller has no grant on |
| 408 | `QUERY_TIMEOUT` | Interrupted at the workspace timeout |
| 409 | `APPROVAL_REQUIRED` | Agent mutation held for a human (with the challenge) |
| 429 | `RATE_LIMITED` | Global and per-route limits |

## CLI

```
duckview serve [--port] [--host]
duckview mcp [--token dv_…|--user email] [--workspace id]
duckview migrate
duckview create-user --email … --password … [--role ADMIN|USER|READ_ONLY]
duckview create-token --email … --name … [--scopes read,write,mcp] [--workspace id] [--days n]
duckview config
```

In the image the binary is `/app/server/dist/cli.js`, so `docker exec duckview node /app/server/dist/cli.js create-user --email …`.

## Observability

- **Logs:** pino structured JSON (pretty in dev TTYs), `x-request-id` propagated.
- **Metrics (`/metrics`):** `duckview_queries_total{actor,class,status}`, `duckview_query_duration_seconds`, `duckview_query_rows_returned`, `duckview_active_queries`, `duckview_engines_active`, `duckview_mcp_connections_active{transport}`, `duckview_mcp_tool_calls_total{tool,status}`, `duckview_mcp_tool_duration_seconds`, `duckview_mcp_hitl_challenges_total`, `duckview_sandbox_violations_total{actor}`, `duckview_ws_connections_active`, `duckview_cache_lookups_total{kind,result}`, `duckview_cache_bytes`, `duckview_cache_entries`, `duckview_copilot_*`, host/DuckDB memory gauges, plus Node process defaults.
- **Traces:** `duckdb.query` and `mcp.tool.<name>` spans (`db.system`, `db.statement`, workspace, actor, statement class) via OpenTelemetry; exported over OTLP/HTTP when `observability.otel.enabled`.
- **Probes:** `/healthz` (liveness) and `/readyz` (metadata store, data directory, DuckDB).
