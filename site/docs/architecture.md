---
title: Architecture
order: 13
group: Reference
description: How the pieces fit — the React app, the Fastify server and its single query choke point, one native DuckDB engine per workspace, and the Drizzle metadata store.
---

```
┌──────────────── React + Vite + Tailwind v4 + Chart.js ────────────────────────┐
│ #/  Overview     drag-and-drop ingestion · KPIs · null bars · distributions   │
│ #/query          explorer (any local folder + S3/R2/GCS/Azure + lakehouse    │
│                  catalogs) · schema pane · tabs · engine picker · saved SQL  │
│ #/dashboards     BI builder: drag-and-drop grid, KPI/chart/table/markdown    │
│ #/settings       appearance · layout · hardware · engine · storage ·        │
│                  copilot · account · teams · users                           │
│ #/mcp            registered agents · framework snippets · OpenAPI · tokens  │
│ DuckCopilot      dockable AI drawer (Anthropic · OpenAI · Ollama · Bedrock)  │
└──────────────┬───────────────────────────────────────────────────────────────┘
               │ REST · WS (rows, live events) · SSE (copilot, MCP) · Streamable HTTP
┌──────────────▼───────────────────────────────────────────────────────────────┐
│ Fastify 5 (TypeScript strict)                                                │
│  auth: local (scrypt) · OIDC+PKCE (+group→team sync) · API tokens (scoped)   │
│  Sharing: workspace roles OWNER/EDITOR/VIEWER for users and teams            │
│  QueryService ─ single choke point: authz → SQL guard → HITL → audit         │
│  ResultCache ─ LRU keyed on file stat + workspace data epoch · ETag/304      │
│  Storage: jailed tree · S3/Azure SDK listings · DESCRIBE-based inspection     │
│  Lakehouse: Iceberg ATTACH (Glue/S3 Tables/REST/UC) · Databricks SQL API     │
│  Agent tools: one registry → MCP (10 tools · 3 resources · 2 prompts)        │
│               + REST façade /api/agent/v1/tools + OpenAPI 3.0               │
├──────────────────────────────────────────────────────────────────────────────┤
│ EngineManager ─ one DuckDB instance per workspace (LRU + idle TTL)           │
│  filesystem jail (Node) + allowed_directories/enable_external_access=off     │
│  + lock_configuration (DuckDB) · secrets + ATTACHed catalogs hot-applied     │
├──────────────────────────────────────────────────────────────────────────────┤
│ Metadata store (Drizzle): SQLite by default · PostgreSQL via DATABASE_URL    │
│  users · groups · workspaces · workspace_members · session_tabs (per user)   │
│  saved_queries · dashboards · widgets · connections (AES-256-GCM) · agents   │
│  · chat_history · tokens · audit_logs                                        │
└──────────────────────────────────────────────────────────────────────────────┘
```

## The one path every query takes

Whether it comes from the workbench, a WebSocket stream, a dashboard widget, an MCP tool or the REST façade, SQL goes through `QueryService`:

1. **Access** — `WorkspaceService.get(principal, workspace, minRole)` resolves the effective role (owner, direct grant, team grant; admins from the UI) — `404` for non-members, `403` for insufficient roles.
2. **Authorization** — scope (`read` / `write` / `admin`), platform role, workspace role, and the human-in-the-loop gate for agents.
3. **Cache** — for read-only, deterministic statements a key built from the referenced files' `size:mtime` and the workspace data epoch is checked first.
4. **Guard** — the lexer classifies statements and rewrites path literals into the jail; extension and setting policies apply.
5. **Engine** — a fresh DuckDB connection with a timeout (`interrupt()` on cancel), row caps and cell truncation.
6. **Audit** — one row per execution with actor, workspace, SQL, duration, status; a mutation also moves the data epoch and notifies members over the live feed.

## Engines

`EngineManager` keeps one `DuckDBInstance` per workspace, LRU-bounded (`max_cached_engines`) and idle-evicted (`engine_idle_ttl_seconds`). Each engine starts with memory/thread/temp settings, loads allow-listed extensions, applies the owner's cloud and lakehouse secrets and `ATTACH`es catalogs, then locks the configuration. Secrets and attachments can be re-applied to a running engine without losing in-memory tables; a `:memory:` engine that restarts moves the workspace epoch so cached results over its (now gone) tables are not served.

## Project layout

```
packages/server/src
  config/        YAML + env loader (zod-validated)
  db/            Drizzle schemas (sqlite + pg), store factory, migrations in ../drizzle
  engine/        sandbox (DataJail), sql-guard (lexer/classifier/rewriter), duckdb (engines, overview, memory), results
  security/      AES-256-GCM, scrypt, token hashing
  services/      audit, auth/tokens, groups (teams + SSO sync), workspaces (membership, tabs, data epoch),
                 query (authz + HITL), cache (keys, LRU, ETag), connections, files, storage, exports, bi,
                 chat, copilot, llm, lakehouse, databricks, agents, aws
  agent/         tool registry (shared by MCP + REST), OpenAPI generator, framework snippets
  mcp/           server (registry → tools, resources, prompts), stdio, http (SSE + Streamable HTTP)
  routes/        auth, workspaces (+ members), groups, query (REST + WS), files, events, storage, exports,
                 bi, copilot, lakehouse, agent, tokens, admin, system, conditional (ETag glue)
  observability/ pino, prom-client, OpenTelemetry, live event bus, CPU sampler
packages/web/src
  features/      overview · workspace (+ ShareDialog) · dashboards · explorer · settings (+ Teams, Cache) · mcp · copilot · auth
  store/         zustand: auth, workspace (tabs, results, epoch), copilot, layout, theme
  lib/           resultCache (IndexedDB), useCached (stale-while-revalidate), liveEvents, chart
  theme/         six themes applied as CSS variables
```

## Tests

`pnpm test` runs 174 tests: the jail, SQL guard, crypto and config units, plus integration suites that boot real DuckDB engines and the MCP server over every transport, serve real Iceberg tables through a mock REST catalog, emulate a Databricks workspace (Unity Catalog + Statement Execution API), exercise the agent façade against a fake AWS bridge, and cover sharing/teams and the result cache end to end. `scripts/smoke.mjs` verifies a running instance.
