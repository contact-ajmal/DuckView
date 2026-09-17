# DuckView Enterprise

A hardened, stateful, native-DuckDB data platform: multi-tenant SQL workspaces with a polished dark UI, and an enterprise-grade **Model Context Protocol (MCP)** server so autonomous agents (Claude, Cursor, …) can query the same sandboxed engines with human-in-the-loop safety.

```
┌──────────────── React + Vite + Tailwind v4 (zinc/violet) + Chart.js ─────────┐
│ #/  Overview     drag-and-drop ingestion · KPIs · null bars · distributions   │
│ #/query          VS Code-style explorer (local + S3/R2/GCS/Azure) · schema    │
│                  drawer · tabs · saved-query library · .sql import/export     │
│ #/dashboards     BI builder: drag-and-drop grid, KPI/chart/table/markdown,   │
│                  auto-refresh                                                 │
│ #/settings       live gauges · engine tuning · cloud connections · users      │
│ #/mcp            tokens · client snippets · live agent inspector             │
│ DuckCopilot      dockable AI drawer (Anthropic · OpenAI · Ollama, BYOK)       │
└──────────────┬───────────────────────────────────────────────────────────────┘
               │ REST · WS (rows, live events) · SSE (copilot, MCP) · Streamable HTTP
┌──────────────▼───────────────────────────────────────────────────────────────┐
│ Fastify 5 (TypeScript strict)                                                │
│  auth: local (scrypt) · OIDC+PKCE · API tokens (sha256, scoped)              │
│  QueryService ─ single choke point: authz → SQL guard → HITL → audit         │
│  Storage: jailed tree · S3/Azure SDK listings · DESCRIBE-based inspection     │
│  Exports: COPY … TO (parquet/csv/json) + streaming Arrow IPC writer          │
│  Copilot: schema/SUMMARIZE/active-SQL context → provider bridge (SSE)        │
│  MCP: 9 tools · 3 resources · 2 prompts  (stdio | /mcp/sse | /mcp)           │
├──────────────────────────────────────────────────────────────────────────────┤
│ EngineManager ─ one DuckDB instance per workspace (LRU + idle TTL)           │
│  filesystem jail (Node) + allowed_directories/enable_external_access=off     │
│  + lock_configuration (DuckDB) · httpfs/azure secrets hot-applied            │
├──────────────────────────────────────────────────────────────────────────────┤
│ Metadata store (Drizzle): SQLite by default · PostgreSQL via DATABASE_URL    │
│  users · workspaces · session_tabs · saved_queries · dashboards · widgets    │
│  cloud_connections · data_connections (AES-256-GCM) · chat_history · tokens  │
└──────────────────────────────────────────────────────────────────────────────┘
```

## Quick start

```bash
pnpm install
pnpm build

export JWT_SECRET=$(openssl rand -hex 32)
export ENCRYPTION_KEY=$(openssl rand -hex 32)
export DUCKVIEW_DATA_DIR=./data                 # the filesystem jail
export DUCKVIEW_ADMIN_EMAIL=admin@example.com   # bootstrap admin (first start only)
export DUCKVIEW_ADMIN_PASSWORD=change-me-now

pnpm start          # → http://localhost:4200
```

Drop Parquet/CSV/JSON files (or Delta/Iceberg directories) into `./data` and query them by relative path:

```sql
SELECT region, sum(revenue) FROM 'sales.parquet' GROUP BY 1;
SELECT * FROM read_csv('events/*.csv');
```

Development (hot reload for both packages, web on :5173 proxying to :4200):

```bash
pnpm dev
```

### Docker / Compose

```bash
cp .env.example .env            # JWT_SECRET, ENCRYPTION_KEY, admin credentials, POSTGRES_PASSWORD
docker compose up --build                     # DuckView with SQLite metadata; ./data mounted at /data
docker compose --profile postgres up --build  # optional PostgreSQL metadata (set DATABASE_URL in .env)
docker compose --profile ollama up            # + local Ollama for DuckCopilot
docker compose --profile observability up     # + Prometheus on :9090
```

The image (`node:20-bookworm-slim`, multi-stage, runs as `duckuser:duckgroup`) declares two volumes: `/data` (the filesystem jail) and `/app/meta` (SQLite metadata when no `DATABASE_URL` is set). Standalone:

```bash
docker run -p 4200:4200 -v $PWD/data:/data -v duckview-meta:/app/meta \
  -e JWT_SECRET=… -e ENCRYPTION_KEY=… -e DUCKVIEW_ADMIN_EMAIL=… -e DUCKVIEW_ADMIN_PASSWORD=… \
  duckview/enterprise:latest
```

### CI/CD

- `.github/workflows/ci.yml` — typecheck, unit + integration tests, build, then `scripts/smoke.mjs` against the built server and against a freshly built image.
- `.github/workflows/docker-publish.yml` — on a `v*` tag: multi-architecture build (`linux/amd64`, `linux/arm64`) with Buildx/QEMU, push to Docker Hub (`DOCKERHUB_USERNAME` / `DOCKERHUB_TOKEN` secrets, optional `DOCKERHUB_IMAGE` variable), SBOM + provenance, smoke-test of the pushed tag.
- `scripts/smoke.mjs <url> <admin-email> <password>` — 22 end-to-end checks: probes, metrics, auth, sandbox, SQL errors, tab/cursor state, upload, overview, live stats, tokens, HITL, and a full MCP Streamable HTTP handshake.

### Kubernetes

```bash
cp k8s/secret.example.yaml k8s/secret.yaml   # fill in, or wire ExternalSecrets/SealedSecrets
kubectl apply -k k8s/
```

The Deployment ships liveness (`/healthz`), readiness/startup (`/readyz`), non-root + read-only rootfs, an `emptyDir` spill volume, a PVC for `/data`, `ClientIP` session affinity (keeps SSE streams pinned) and Prometheus scrape annotations (`k8s/servicemonitor.yaml` for the Operator).

## Configuration

`duckview.config.yaml` is loaded from `$DUCKVIEW_CONFIG`, `./duckview.config.yaml`, or `/etc/duckview/duckview.config.yaml`. Values may reference environment variables with `${VAR}` / `${VAR:-default}` (nesting allowed). Any key can also be overridden with `DUCKVIEW__<SECTION>__<KEY>` (e.g. `DUCKVIEW__DUCKDB__MAX_RESULT_ROWS=1000`), and well-known short names (`PORT`, `JWT_SECRET`, `ENCRYPTION_KEY`, `DUCKVIEW_DATA_DIR`, `DATABASE_URL`, `OIDC_*`, `DUCKDB_MEMORY_LIMIT`, …) are honoured. The effective, redacted config is available via `duckview config` and `GET /api/admin/config`.

Key settings:

| Section | Setting | Notes |
|---|---|---|
| `security` | `data_jail_directory` | Every DuckDB file read/write is confined here. |
| | `enable_external_access` | `false` (default) blocks S3/GCS/HTTP/MotherDuck and extension installs. Set `true` to use remote sources — local files stay jailed by the Node guard. |
| | `lock_configuration` | DuckDB refuses `SET`/`PRAGMA` on hardened settings from any connection. |
| | `allowed_extensions` / `blocked_extensions` | `INSTALL`/`LOAD` allow-list; `allow_arbitrary_extensions: true` disables the allow-list (blocked list still applies). |
| | `jwt_secret`, `encryption_key` | Required in `NODE_ENV=production`; ephemeral (with a warning) in dev. |
| `database` | `metadata_url` | `sqlite://duckview_meta.db` or `postgres://…`; migrations run at start. |
| `auth` | `strategy` | `local` or `oidc` (Authorization Code + PKCE, stateless signed `state`). `oidc.admin_emails` promotes SSO users to ADMIN. |
| `security` | `filesystem_mode` | `sandboxed` (multi-tenant, default) or `full` (single-user: the explorer and DuckDB may read the whole host; production requires `DUCKVIEW_ALLOW_FULL_FS=1`). Relative paths still anchor to the data directory. |
| `duckdb` | `extension_directory` | Where `httpfs`/`azure`/`arrow`/`iceberg`/`delta` are installed. The image ships them pre-installed at `/app/duckdb-extensions` (`scripts/install-extensions.mjs`). |
| | `export_ttl_seconds`, `export_max_rows` | Server-side export files expire after the TTL. |
| `copilot` | `provider`, `model`, `api_key`, `base_url`, `allow_byok` | DuckCopilot LLM bridge (`anthropic` / `openai` / `ollama`); users may bring their own key when `allow_byok` is true. |
| `duckdb` | `default_memory_limit` | `80%` of host RAM or absolute (`16GB`). Per-workspace overrides in the UI. |
| | `default_threads`, `temp_directory`, `query_timeout_seconds`, `max_result_rows` | Threads/timeout are per-workspace tunable; results are hard-capped for the grid. |
| `mcp` | `default_page_size` / `max_page_size` | 50 / 200 rows per tool call; `max_cell_chars` truncates long strings. |
| | `require_confirmation_for_mutations` | HITL gate for agents. |
| `observability` | `metrics_enabled`, `otel.*` | Prometheus at `/metrics`; OTLP/HTTP trace export when `otel.enabled`. |

## Security model

1. **Filesystem jail (Node layer).** `DataJail` resolves every path-looking SQL string literal (`'sales.parquet'`, `read_csv('/x')`, `COPY … TO`, `ATTACH`) against `data_jail_directory`, rejects any `..` segment, home-relative paths, drive letters, null bytes, and symlinks that escape — then **rewrites relative literals to absolute jail paths** before the SQL reaches DuckDB.
2. **DuckDB hardening (engine layer).** Each engine starts with `memory_limit`, `threads`, `temp_directory`, autoinstall off; then `SET allowed_directories = [jail, spill]`, `SET enable_external_access = false`, `SET lock_configuration = true`. A literal that dodges the Node heuristic (e.g. built with `concat()`) still hits DuckDB's own `Permission Error`.
3. **Statement classification.** A quote/comment/CTE-aware lexer classifies each statement as `read` / `write` / `destructive` / `admin`. `READ_ONLY` users and tokens without `write` cannot run mutating SQL; `admin` statements (`SET`, `PRAGMA`, `ATTACH`, `INSTALL`, `LOAD`, `CALL`) require the `admin` scope for agents.
4. **Human-in-the-loop for agents.** Any mutating statement from an MCP/API-token actor is blocked with an `approval_required` challenge (the verbs, per-statement previews, and how to proceed) until it is re-issued with `dry_run: false`. `save_dataset` is gated the same way.
5. **Secrets.** Stored S3/GCS/Azure/HTTP/Postgres/MotherDuck credentials are AES-256-GCM encrypted (unique IV, auth tag, row-id as AAD) and applied via `CREATE SECRET` / `motherduck_token` only for the owning user's engine. Passwords use scrypt; API tokens are `dv_…` random strings stored as SHA-256 hashes and shown once.
6. **Isolation & limits.** One DuckDB instance per workspace, a fresh connection per query (so `interrupt()` on timeout/cancel is query-scoped), row caps, cell truncation, rate limiting, and a full audit trail (`actor_type` USER/AGENT, action, SQL, duration, IP, status).

## DuckCopilot

An in-app assistant docked beside the workbench and the dashboard builder. Every turn is hydrated automatically with the workspace's tables/views (columns + types), the data files in the jail, the configured cloud buckets, the SQL in the active tab, and — for selected files/tables — `SUMMARIZE` statistics (min/max/distinct/null %). Providers: **Anthropic** (official SDK, streaming, default `claude-opus-5`), **OpenAI** (`gpt-4o`) and **Ollama** (local, OpenAI-compatible endpoint). Keys are server-managed (`copilot.*`) or bring-your-own from the drawer's settings (kept in the browser, sent per request, never stored). Actions: *Insert into tab*, *New tab*, *Run & inspect* (executes, then explains the result in business language), *Fix my query* (sends the failing SQL + DuckDB error), *Suggest questions* (top analytical questions for a selected dataset). Conversations persist in `chat_history` with the context snapshot of each turn.

`POST /api/copilot/chat` streams SSE events (`context` → `delta`* → `done` | `error`); `GET /api/copilot/config`, `POST /api/copilot/models`, `GET /api/copilot/conversations`, `GET /api/copilot/messages`, `DELETE /api/copilot/conversations/:id`.

## MCP server

**Transports**

| Mode | How |
|---|---|
| stdio | `duckview mcp --token dv_… [--workspace <id>]` (or `DUCKVIEW_API_TOKEN`) — stdout is JSON-RPC only, logs go to stderr |
| SSE (2024-11-05) | `GET /mcp/sse` + `POST /mcp/messages?sessionId=…` with `Authorization: Bearer dv_…` |
| Streamable HTTP (2025-03-26) | `POST/GET/DELETE /mcp` with `Authorization: Bearer dv_…` and `mcp-session-id` |

Tokens need the `mcp` scope (plus `write` for mutations and `admin` for administrative SQL). A token may be pinned to one workspace; otherwise pass `workspace_id` to tools or `?workspace_id=` on connect.

```bash
claude mcp add --transport http duckview http://localhost:4200/mcp --header "Authorization: Bearer dv_…"
```

**Tools**

| Tool | Purpose |
|---|---|
| `execute_query(sql, workspace_id?, page_size?, page?, dry_run?)` | Runs SQL; returns a Markdown table + typed JSON (`columns`, `rows`, `total_rows`, `truncated`, `rows_changed`). Hard cap 200 rows/call, long strings truncated. Mutations need `dry_run=false`. |
| `profile_dataset(table_or_path, workspace_id?)` | `SUMMARIZE` stats: types, min/max, approx distinct, null %, quartiles, row count, footprint. |
| `explain_query(sql, workspace_id?, analyze?)` | Physical plan as JSON tree + ASCII with cardinality estimates; `analyze=true` adds measured timings (read-only SQL only). |
| `list_accessible_data(workspace_id?)` | Workspaces, tables/views with columns, and every data file/Delta/Iceberg table in the jail. |
| `save_dataset(sql, output_format, target_filename, workspace_id?, dry_run?)` | `COPY (sql) TO` parquet/csv/json inside the jail (`exports/` by default). |
| `browse_storage(provider?, path?, connection_id?, bucket?)` | One level of the data directory, or cloud connections → buckets → objects (S3/R2/GCS/Azure). |
| `inspect_schema(file_path_or_table)` | Columns/types/nullability for tables, files, remote objects, `.duckdb` files or a SELECT — no scan. |
| `list_dashboards(workspace_id?)` | Dashboards with their widgets and layouts. |
| `create_dashboard_widget(dashboard_id | dashboard_name, title, sql, widget_type, chart_config?, refresh_interval_sec?)` | Builds dashboards autonomously; the SQL is validated read-only and dry-run first. |

**Resources** — `duckdb://workspaces`, `duckdb://schemas/{workspace_id}` (DDL + column map + files), `duckdb://system/resources` (CPUs, RAM, DuckDB ceiling, spill disk, active engines).

**Prompts** — `data_quality_audit(table_or_path)` and `sql_optimization(sql)` encode complete agent workflows over the tools above.

## HTTP API (summary)

| Area | Endpoints |
|---|---|
| Auth | `POST /api/auth/login` · `POST /api/auth/register` · `GET /api/auth/me` · `POST /api/auth/password` · `GET /api/auth/oidc/login` · `GET /api/auth/oidc/callback` |
| Workspaces | `GET/POST /api/workspaces` · `GET/PATCH/DELETE /api/workspaces/:id` · `POST /api/workspaces/:id/restart` · `…/tabs` CRUD (`sql_content`, `chart_config`, `cursor_position`, `order_index`) |
| Storage explorer | `GET /api/storage/local?workspace_id&path` (jailed tree, one level) · `GET /api/storage/cloud?connection_id[&bucket&prefix]` (buckets / objects with folders via S3 `ListObjectsV2` delimiter or Azure hierarchy) · `POST /api/storage/inspect {workspace_id,target}` (`DESCRIBE … LIMIT 0` for files, `s3://`/`r2://`/`gs://`/`az://` objects, tables, `.duckdb` files, subqueries; Parquet row counts from the footer) |
| Cloud connections | `GET /api/cloud-connections/providers` · `GET/POST/PATCH/DELETE /api/cloud-connections` (S3 · R2 · GCS · Azure, AES-256-GCM at rest, applied as DuckDB `CREATE SECRET` to every engine of the owner) · `POST /api/cloud-connections/:id/test` |
| Exports | `POST /api/workspaces/:id/export {sql, format: parquet\|csv\|json\|arrow}` (native `COPY … TO` on disk, Arrow IPC via a streaming writer) · `GET /api/exports` · `GET /api/exports/:id/download` (streamed with `Content-Length`) · `DELETE /api/exports/:id` |
| BI | `…/queries` CRUD (saved queries with folders/tags) · `…/dashboards` CRUD · `GET/PATCH/DELETE /api/dashboards/:id` (layout) · `POST/PATCH/DELETE /api/dashboards/:id/widgets[/:wid]` · `POST /api/dashboards/:id/widgets/:wid/data` |
| Data | `POST /api/workspaces/:id/files` (multipart upload into the jail) · `DELETE /api/workspaces/:id/files?path=` · `POST /api/workspaces/:id/overview` (KPIs, null ratios, sample, distributions) · `GET /api/workspaces/:id/catalog` |
| Query | `POST /api/workspaces/:id/query` · `/explain` · `/profile` · `/save` · `WS /api/ws/query` (auth → run/cancel; schema → rows* → done) |
| Live | `WS /api/ws/events` — audit rows, MCP tool invocations and session events in real time (admins: all; others: own) · `GET /api/system/live` — CPU %, RAM, `duckdb_memory()` per engine, scratch/data disk usage |
| Agents | `GET/POST/DELETE /api/tokens` · `GET /api/mcp/sessions` · `GET /api/mcp/info` (Claude Desktop / Cursor / Claude Code snippets) |
| Connections | `GET /api/connections/types` · `GET/POST/DELETE /api/connections` |
| Ops | `GET /api/system` · `GET /api/audit` · `GET/POST/PATCH/DELETE /api/admin/users` · `GET /api/admin/engines` · `POST /api/admin/engines/:id/evict` · `GET /api/admin/config` |
| Probes | `GET /healthz` · `GET /readyz` · `GET /metrics` |

Errors are uniform JSON: `{ error, message, request_id, challenge? }` — `403 SANDBOX_VIOLATION`, `409 APPROVAL_REQUIRED` (with the HITL challenge), `408 QUERY_TIMEOUT`, `400 SQL_ERROR` (DuckDB parser/binder errors), `429 RATE_LIMITED`.

## CLI

```
duckview serve [--port] [--host]
duckview mcp [--token dv_…|--user email] [--workspace id]
duckview migrate
duckview create-user --email … --password … [--role ADMIN|USER|READ_ONLY]
duckview create-token --email … --name … [--scopes read,write,mcp] [--workspace id] [--days n]
duckview config
```

## Observability

- **Logs:** pino structured JSON (pretty in dev TTYs), `x-request-id` propagated.
- **Metrics (`/metrics`):** `duckview_queries_total{actor,class,status}`, `duckview_query_duration_seconds` histogram, `duckview_query_rows_returned`, `duckview_active_queries`, `duckview_engines_active`, `duckview_mcp_connections_active{transport}`, `duckview_mcp_tool_calls_total{tool,status}`, `duckview_mcp_tool_duration_seconds`, `duckview_mcp_hitl_challenges_total`, `duckview_sandbox_violations_total{actor}`, `duckview_ws_connections_active`, host/DuckDB memory gauges, plus Node process defaults.
- **Traces:** `duckdb.query` and `mcp.tool.<name>` spans (`db.system`, `db.statement`, workspace, actor, statement class) via OpenTelemetry; exported over OTLP/HTTP when `observability.otel.enabled`.

## Project layout

```
packages/server/src
  config/        YAML + env loader (zod-validated)
  db/            Drizzle schemas (sqlite + pg), store factory, migrations in ../drizzle
  engine/        sandbox (DataJail), sql-guard (lexer/classifier/rewriter), duckdb (engines, overview, memory stats), results
  security/      AES-256-GCM, scrypt, token hashing
  services/      audit, auth/tokens, connections, files (uploads), workspaces/tabs, query (authz + HITL)
  mcp/           server (tools/resources/prompts), stdio, http (SSE + Streamable HTTP)
  routes/        auth (local + OIDC), workspaces, query (REST + WS), files, events (WS), connections, tokens, admin, system
  observability/ pino, prom-client, OpenTelemetry, live event bus, CPU sampler
packages/web/src
  features/overview   drop zone · KPI badges · null-ratio bars · Chart.js distributions · sample grid
  features/workspace  schema tree (click-to-insert) · tabs with per-tab Stop · editor (cursor persisted) · streaming grid · chart · plan · profile
  features/settings   SVG gauges (host RAM, DuckDB allocation, CPU, scratch) · engine tuning · connections · users · account
  features/mcp        tokens · Claude Desktop / Cursor / Claude Code snippets · live inspector (WS)
```

## Tests

```bash
pnpm test        # 103 tests: jail, SQL guard, crypto, config, and an integration suite that boots real DuckDB
                 # engines, the MCP server (in-memory, SSE, Streamable HTTP), uploads, overview profiling,
                 # the live event feed, the HTTP API and WebSocket streaming
node scripts/smoke.mjs http://localhost:4200 admin@example.com <password>   # against a running instance
```
