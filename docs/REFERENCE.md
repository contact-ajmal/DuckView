# DuckView — technical reference

> The product overview lives in the [README](../README.md). This document is the complete reference: configuration, security model, APIs, MCP tools, CLI, observability and project layout.

A hardened, stateful, native-DuckDB data platform: multi-tenant SQL workspaces with a polished UI, lakehouse connectors (AWS Glue / SageMaker Lakehouse, S3 Tables, Iceberg REST, Databricks), and an enterprise-grade **Model Context Protocol (MCP)** server plus REST/OpenAPI façade so autonomous agents (Claude, Cursor, Strands, LangGraph, LangChain, CrewAI, Bedrock AgentCore, …) can query the same sandboxed engines with human-in-the-loop safety.

```
┌──────────────── React + Vite + Tailwind v4 (zinc/violet) + Chart.js ─────────┐
│ #/  Overview     drag-and-drop ingestion · KPIs · null bars · distributions   │
│ #/query          VS Code-style explorer (any local folder + S3/R2/GCS/Azure  │
│                  + lakehouse catalogs) · schema pane · tabs · engine picker  │
│                  (DuckDB / Databricks warehouse) · saved queries · .sql io   │
│ #/dashboards     BI builder: drag-and-drop grid, KPI/chart/table/markdown,   │
│                  auto-refresh                                                 │
│ #/settings       categorised: appearance · layout · hardware · engine ·     │
│                  storage · copilot · account · users                          │
│ #/mcp            registered agents · framework snippets · OpenAPI · tokens  │
│                  · live agent inspector                                       │
│ DuckCopilot      dockable AI drawer (Anthropic · OpenAI · Ollama · Bedrock ·  │
│                  Bedrock Agent · AgentCore runtime, BYOK)                     │
└──────────────┬───────────────────────────────────────────────────────────────┘
               │ REST · WS (rows, live events) · SSE (copilot, MCP) · Streamable HTTP
┌──────────────▼───────────────────────────────────────────────────────────────┐
│ Fastify 5 (TypeScript strict)                                                │
│  auth: local (scrypt) · OIDC+PKCE (+group→team sync) · API tokens (scoped)   │
│  Sharing: workspace roles OWNER/EDITOR/VIEWER for users and teams            │
│  QueryService ─ single choke point: authz → SQL guard → HITL → audit         │
│  Storage: jailed tree · S3/Azure SDK listings · DESCRIBE-based inspection     │
│  Exports: COPY … TO (parquet/csv/json) + streaming Arrow IPC writer          │
│  Copilot: schema/SUMMARIZE/active-SQL context → provider bridge (SSE)        │
│  Lakehouse: Iceberg ATTACH (Glue/S3 Tables/REST/UC) · Databricks SQL API     │
│  Agent tools: one registry → MCP (10 tools · 3 resources · 2 prompts)        │
│               + REST façade /api/agent/v1/tools + OpenAPI 3.0               │
├──────────────────────────────────────────────────────────────────────────────┤
│ EngineManager ─ one DuckDB instance per workspace (LRU + idle TTL)           │
│  filesystem jail (Node) + allowed_directories/enable_external_access=off     │
│  + lock_configuration (DuckDB) · httpfs/azure/iceberg secrets + ATTACHed     │
│  lakehouse catalogs hot-applied                                              │
├──────────────────────────────────────────────────────────────────────────────┤
│ Metadata store (Drizzle): SQLite by default · PostgreSQL via DATABASE_URL    │
│  users · groups · group_members · workspaces · workspace_members            │
│  session_tabs (per user) · saved_queries · dashboards · widgets              │
│  cloud_connections · lakehouse_connections · data_connections (AES-256-GCM) │
│  · agents · chat_history · tokens                                            │
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
  anbproject/duckview:latest
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
| | `oidc.groups_claim`, `oidc.admin_groups`, `oidc.sync_groups` | Claim carrying the user's IdP groups (default `groups`; Entra may use `roles`). Members of any `admin_groups` entry become ADMIN on login (never demoted). With `sync_groups` (default on) IdP groups are mirrored into DuckView **teams** and the user's membership is rewritten on every login, so workspaces can be shared with `okta:finance` directly. |
| `security` | `filesystem_mode` | `full` (default, VS Code-like): add any local folder to the explorer, query files anywhere on the host, cloud sources on. `sandboxed` (multi-tenant): everything confined to `data_jail_directory`, external access off unless enabled. Relative paths always anchor to the data directory. |
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
7. **Workspace authorization.** Every workspace access resolves an effective role — the creator and platform admins (UI sessions only, never tokens) are OWNER; otherwise the highest of the user's direct grant and their teams' grants. Inaccessible workspaces are `404` (no existence leak); insufficient role is `403`. See [Sharing & teams](#sharing--teams).

## Layout

Every region resizes like an IDE: drag the splitters between the side bar and the main area, between the editor and the results pane, and between the side bar sections (Explorer · Tables & views · Saved queries · History). Section headers collapse, the side bar can be hidden, and double-clicking a splitter resets it.

Any component can be removed to declutter: hover a panel header and click its ×. Hidden components are listed under **Layout** in the header (with a count badge) for one-click restore, and Settings → Layout has a checklist of every component per page. Sizes and hidden components are remembered per browser.

## Themes

Six built-in themes decide both the colour system and the typeface — three dark (**Midnight** zinc/violet · **Graphite** neutral/blue · **Fjord** Nord-style teal) and three light (**Daylight** violet · **Professional** navy on grey with IBM Plex, for corporate/print contexts · **Paper** warm off-white with orange). Switch from the header quick-menu or Settings → Appearance, where you can also override the sans/mono fonts and the UI scale independently of the theme. Every colour in the app (surfaces, tones, status, code editor, chart series/grid/tooltips) resolves through runtime CSS variables set on `<html>` — Tailwind's `@theme` tokens reference them, so opacity variants like `bg-zinc-800/60` re-theme too. Chart palettes are validated per theme for colour-vision-deficiency separation and contrast against each surface. Preference is stored in the browser (`duckview.theme`); `prefers-color-scheme` picks Midnight or Daylight on first load.

## Settings

Settings is split into categories in a left-hand nav (deep-linkable as `#/settings/<category>`): **Appearance** (themes, fonts, scale) · **Layout** (show/hide components) · **Hardware** (live gauges, resources, warm engines) · **Engine** (memory, threads, timeout, sandbox) · **Storage** (cloud connections, data connections) · **Copilot** (provider status) · **Account** · **Users** (admin).

## Sharing & teams

Workspaces are private to their creator until shared. Share with individual people or with **teams** (groups) from the workspace switcher (**Share …**); each grant carries a role, and the highest role a person holds through any path wins. Platform admins signed in through the UI act as OWNER on every workspace; API tokens never inherit that.

| Role | Can |
|---|---|
| **Viewer** | Run read-only SQL (including attached lakehouse catalogs), view dashboards and saved queries, profile data, export results, use Copilot, keep their own tabs. |
| **Editor** | Everything a viewer can, plus mutating SQL, uploads and file deletion, workspace folders, saved queries, dashboards and widgets, `save_dataset`, materialising remote results. |
| **Owner** | Everything an editor can, plus rename / engine settings / database path, restart the engine, manage members, delete. The creator is the *primary* owner and can transfer the workspace. |

The platform role still applies on top: a `READ_ONLY` user never mutates even as an editor, and tokens are limited by their scopes. Things worth knowing:

- **Tabs are personal.** Each member has their own tabs in a shared workspace (`session_tabs.user_id`); saved queries and dashboards are the shared artefacts.
- **Members query through the owner's connections.** Secrets, cloud buckets and lakehouse catalogs are resolved from the workspace owner, so sharing a workspace shares access to what its engine can reach. Transferring a workspace rebuilds its engine with the new owner's connections.
- **Files in the data directory are workspace-wide** (and, in `filesystem_mode: full`, so are mounted folders). Per-user data isolation is on the roadmap.
- **Teams** are created by admins (Settings → Teams); admins and team **managers** manage membership, and anyone can leave a team. Teams mirrored from SSO (`external_id`) are re-synced on every login. Deleting a user or a team removes its grants.
- **Agents** see shared workspaces through `list_accessible_data` / `duckdb://workspaces` and get the member's role — a viewer's token cannot mutate even after a human "approves" with `dry_run=false`.

`GET /api/workspaces` (each entry carries `role`, `owner`, `shared`, `member_count`) · `GET /api/workspaces/:id/members` · `PUT /api/workspaces/:id/members {subject_type: user|group, subject_id, role}` · `DELETE /api/workspaces/:id/members/:memberId` · `POST /api/workspaces/:id/leave` · `POST /api/workspaces/:id/transfer {user_id}` · `GET /api/users/directory?q=` · `GET/POST /api/groups` · `PATCH/DELETE /api/groups/:id` · `GET/PUT /api/groups/:id/members` · `DELETE /api/groups/:id/members/:userId`. `GET /api/auth/me` lists the caller's teams.

## Lakehouse connectors

Connect catalogs from **Settings → Storage → Lakehouse connections** or the **Lakehouse** root of the explorer (`+`). Credentials are AES-256-GCM encrypted; secrets and `ATTACH` statements are hot-applied to your running engines (in-memory tables survive), and attached catalogs are queried as `alias.schema.table` from SQL, dashboards, Copilot and agents alike. Browsing is lazy (namespaces/tables from the REST catalog; table metadata only on `DESCRIBE`).

| Provider | How it works | Auth |
|---|---|---|
| **AWS Glue / SageMaker Lakehouse** | `ATTACH '<account>[:catalog]' (TYPE ICEBERG, ENDPOINT_TYPE glue)` — Glue's Iceberg REST endpoint, SigV4-signed. Sub-catalogs such as `s3tablescatalog/<bucket>` cover SageMaker Lakehouse / federated catalogs. | Access keys, or the server's default credential chain (IAM role, SSO profile) |
| **Amazon S3 Tables** | `ATTACH 'arn:aws:s3tables:…:bucket/<name>' (TYPE ICEBERG, ENDPOINT_TYPE s3_tables)` | same |
| **Iceberg REST catalog** | Polaris, Lakekeeper, Nessie, Snowflake Open Catalog, Tabular, Unity Catalog IRC … `ATTACH '<warehouse>' (TYPE ICEBERG, ENDPOINT …)` | Bearer token · OAuth2 client credentials (`OAUTH2_SERVER_URI`, scope) · none |
| **Databricks** | Unity Catalog REST for browsing (catalog → schema → table, formats, UniForm flag); the **SQL Statement Execution API** for running SQL on a SQL warehouse (polling, chunk paging, cancellation, typed rows); optional `ATTACH` of the catalog through the Unity Catalog Iceberg REST endpoint so UniForm/Iceberg tables run natively in DuckDB. | PAT or OAuth M2M service principal (`/oidc/v1/token`, `all-apis`) |

In the workbench a tab's **engine picker** switches between *DuckDB (local)* and any Databricks SQL warehouse; remote results land in the same grid and can be **materialised into DuckDB** (rows stream through NDJSON into a typed `CREATE TABLE`, so you can join them with local files). Agents get the same through `browse_storage(provider=lakehouse)`, `execute_query` on attached catalogs, `lakehouse_query(connection_id, sql)` for warehouses and `inspect_schema(…, connection_id)` for non-attached Databricks tables. Non-read statements sent to a warehouse by an agent are held for human approval exactly like local SQL. In `filesystem_mode: sandboxed` (external access off) catalogs can be configured but not attached; Databricks warehouses still work.

`GET /api/lakehouse/providers` · `GET/POST/PATCH/DELETE /api/lakehouse-connections[/:id]` · `POST /api/lakehouse-connections/:id/test` · `GET /api/lakehouse/browse?connection_id&workspace_id[&catalog][&schema]` · `GET /api/lakehouse/:id/inspect?table=` · `POST /api/lakehouse/:id/query {sql, max_rows?, dry_run?}` · `POST /api/lakehouse/:id/materialize {sql, table, workspace_id}`. Config: `lakehouse.statement_timeout_seconds`, `lakehouse.max_rows`, `lakehouse.materialize_max_rows`.

## Agent integrations

The **Agent & MCP hub** (`#/mcp`) registers the agents that call DuckView and gives each one a dedicated, workspace-scoped token (`read + mcp`, optionally `write` — mutations are still held for approval). Every tool call is attributed to the agent (call/error counters, "last seen", the live inspector shows the agent name and whether it came over MCP or REST). Copy-paste snippets are generated per framework with the token substituted:

| Framework | Integration |
|---|---|
| **Strands Agents** | `MCPClient(lambda: streamablehttp_client(url, headers=…))` → `Agent(tools=…)` |
| **LangGraph** / **LangChain** | `langchain-mcp-adapters` `MultiServerMCPClient` → `create_react_agent` / `create_agent` |
| **CrewAI** | `MCPServerAdapter({url, transport: "streamable-http", headers})` |
| **AgentCore Runtime** | `BedrockAgentCoreApp` entrypoint (Strands + DuckView MCP) deployable with the starter toolkit; DuckView can **invoke it back** (`InvokeAgentRuntime`, SSE or JSON) from the hub or as a Copilot backend |
| **AgentCore Gateway** | `create_gateway_target` with DuckView as an **MCP server target** or an **OpenAPI target** (API-key credential provider holding the DuckView token) |
| **Bedrock Agents (Classic)** | Action group from the generated **OpenAPI 3.0** document + a Lambda forwarder to the REST façade; invocation (`InvokeAgent`) from the hub / Copilot. Bedrock Agents Classic is closed to new customers — prefer AgentCore for new builds. |
| **Custom / HTTP** | `curl`, Python `requests`, or any MCP client config |

Both surfaces share one tool registry (`packages/server/src/agent/tools.ts`): the **MCP server** and the **REST façade** — `GET /api/agent/v1/tools` (names, descriptions, JSON-schema inputs) and `POST /api/agent/v1/tools/<tool>` (returns `{text, structured, is_error}`; invalid arguments → 400) — plus `GET /api/agent/openapi.json`. Registered-agent endpoints: `GET/POST /api/agents`, `GET/PATCH/DELETE /api/agents/:id`, `POST /api/agents/:id/rotate-token`, `GET /api/agents/:id/snippets`, `POST /api/agents/:id/test` (runs `list_accessible_data` as the agent), `POST /api/agents/:id/invoke` (SSE `delta*` → `done`), `GET /api/agents/discover?kind=bedrock_agents|agentcore_runtimes|bedrock_models&region=` (pickers, server AWS credentials), `GET /api/agents/frameworks`, `GET /api/agents/snippets?framework=`.

## DuckCopilot

An in-app assistant docked beside the workbench and the dashboard builder. Every turn is hydrated automatically with the workspace's tables/views (columns + types), the data files in the jail, the configured cloud buckets, the SQL in the active tab, and — for selected files/tables — `SUMMARIZE` statistics (min/max/distinct/null %). Providers: **Anthropic** (official SDK, streaming, default `claude-opus-5`), **OpenAI** (`gpt-4o`), **Ollama** (local, OpenAI-compatible endpoint), **Amazon Bedrock** (Converse streaming — Claude on Bedrock, model/inference-profile picker), **Bedrock Agent** (`InvokeAgent`, one session per conversation) and **AgentCore runtime** (`InvokeAgentRuntime`; the workspace context is sent as `payload.context` so your own Strands/LangGraph/CrewAI agent can use it). AWS providers use the server's default credential chain (`copilot.aws_region`, `copilot.bedrock_agent_*`, `copilot.agentcore_runtime_arn`, or bring-your-own from the drawer — including a one-click pick of any registered invokable agent). Keys are server-managed (`copilot.*`) or bring-your-own from the drawer's settings (kept in the browser, sent per request, never stored). Actions: *Insert into tab*, *New tab*, *Run & inspect* (executes, then explains the result in business language), *Fix my query* (sends the failing SQL + DuckDB error), *Suggest questions* (top analytical questions for a selected dataset). Conversations persist in `chat_history` with the context snapshot of each turn.

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
| `list_accessible_data(workspace_id?)` | Workspaces, tables/views with columns, every data file/Delta/Iceberg table in the jail, and the attached lakehouse catalogs (with attach status). |
| `save_dataset(sql, output_format, target_filename, workspace_id?, dry_run?)` | `COPY (sql) TO` parquet/csv/json inside the jail (`exports/` by default). |
| `browse_storage(provider?, path?, connection_id?, bucket?, catalog?, schema?)` | One level of the data directory, cloud connections → buckets → objects (S3/R2/GCS/Azure), or lakehouse connections → schemas → tables (with the engine each table runs on). |
| `inspect_schema(file_path_or_table, connection_id?)` | Columns/types/nullability for tables, files, remote objects, `.duckdb` files, attached lakehouse tables or a SELECT — no scan; `connection_id` reads Unity Catalog metadata for non-attached Databricks tables. |
| `lakehouse_query(connection_id, sql, page_size?, dry_run?)` | Runs SQL on a Databricks SQL warehouse; non-read statements need `dry_run=false` after approval. |
| `list_dashboards(workspace_id?)` | Dashboards with their widgets and layouts. |
| `create_dashboard_widget(dashboard_id | dashboard_name, title, sql, widget_type, chart_config?, refresh_interval_sec?)` | Builds dashboards autonomously; the SQL is validated read-only and dry-run first. |

**Resources** — `duckdb://workspaces`, `duckdb://schemas/{workspace_id}` (DDL + column map + files), `duckdb://system/resources` (CPUs, RAM, DuckDB ceiling, spill disk, active engines).

**Prompts** — `data_quality_audit(table_or_path)` and `sql_optimization(sql)` encode complete agent workflows over the tools above.

## HTTP API (summary)

| Area | Endpoints |
|---|---|
| Auth | `POST /api/auth/login` · `POST /api/auth/register` · `GET /api/auth/me` · `POST /api/auth/password` · `GET /api/auth/oidc/login` · `GET /api/auth/oidc/callback` |
| Workspaces | `GET/POST /api/workspaces` · `GET/PATCH/DELETE /api/workspaces/:id` · `POST /api/workspaces/:id/restart` · `…/tabs` CRUD (per user; `sql_content`, `chart_config`, `cursor_position`, `order_index`) |
| Sharing | `GET/PUT /api/workspaces/:id/members` · `DELETE …/members/:memberId` · `POST …/leave` · `POST …/transfer` · `GET /api/users/directory` · `GET/POST /api/groups` · `PATCH/DELETE /api/groups/:id` · `GET/PUT /api/groups/:id/members` · `DELETE …/members/:userId` |
| Storage explorer | `GET/POST/DELETE /api/workspaces/:id/folders` (workspace folders) · `GET /api/storage/browse?workspace_id&path` (folder picker) · `GET /api/storage/local?workspace_id&path` (tree, one level) · `GET /api/storage/cloud?connection_id[&bucket&prefix]` (buckets / objects with folders via S3 `ListObjectsV2` delimiter or Azure hierarchy) · `POST /api/storage/inspect {workspace_id,target}` (`DESCRIBE … LIMIT 0` for files, `s3://`/`r2://`/`gs://`/`az://` objects, tables, `.duckdb` files, subqueries; Parquet row counts from the footer) |
| Cloud connections | `GET /api/cloud-connections/providers` · `GET/POST/PATCH/DELETE /api/cloud-connections` (S3 · R2 · GCS · Azure, AES-256-GCM at rest, applied as DuckDB `CREATE SECRET` to every engine of the owner) · `POST /api/cloud-connections/:id/test` |
| Exports | `POST /api/workspaces/:id/export {sql, format: parquet\|csv\|json\|arrow}` (native `COPY … TO` on disk, Arrow IPC via a streaming writer) · `GET /api/exports` · `GET /api/exports/:id/download` (streamed with `Content-Length`) · `DELETE /api/exports/:id` |
| BI | `…/queries` CRUD (saved queries with folders/tags) · `…/dashboards` CRUD · `GET/PATCH/DELETE /api/dashboards/:id` (layout) · `POST/PATCH/DELETE /api/dashboards/:id/widgets[/:wid]` · `POST /api/dashboards/:id/widgets/:wid/data` |
| Data | `POST /api/workspaces/:id/files` (multipart upload into the jail) · `DELETE /api/workspaces/:id/files?path=` · `POST /api/workspaces/:id/overview` (KPIs, null ratios, sample, distributions) · `GET /api/workspaces/:id/catalog` |
| Query | `POST /api/workspaces/:id/query` · `/explain` · `/profile` · `/save` · `WS /api/ws/query` (auth → run/cancel; schema → rows* → done) |
| Live | `WS /api/ws/events` — audit rows, MCP tool invocations and session events in real time (admins: all; others: own) · `GET /api/system/live` — CPU %, RAM, `duckdb_memory()` per engine, scratch/data disk usage |
| Agents | `GET/POST/DELETE /api/tokens` · `GET /api/mcp/sessions` · `GET /api/mcp/info` (Claude Desktop / Cursor / Claude Code snippets) · `/api/agents…` (registered agents, snippets, self-test, invoke, discovery) · `GET /api/agent/openapi.json` · `GET/POST /api/agent/v1/tools[/:tool]` (REST façade) |
| Lakehouse | `GET /api/lakehouse/providers` · `/api/lakehouse-connections…` · `GET /api/lakehouse/browse` · `GET /api/lakehouse/:id/inspect` · `POST /api/lakehouse/:id/query` · `POST /api/lakehouse/:id/materialize` |
| Connections | `GET /api/connections/types` · `GET/POST/DELETE /api/connections` |
| Ops | `GET /api/system` · `GET /api/audit` · `GET/POST/PATCH/DELETE /api/admin/users` · `GET /api/admin/engines` · `POST /api/admin/engines/:id/evict` · `GET /api/admin/config` |
| Probes | `GET /healthz` · `GET /readyz` · `GET /metrics` |

Errors are uniform JSON: `{ error, message, request_id, challenge? }` — `403 SANDBOX_VIOLATION`, `403 FORBIDDEN` (role or scope too low), `404 NOT_FOUND` (also for workspaces the caller has no grant on), `409 APPROVAL_REQUIRED` (with the HITL challenge), `408 QUERY_TIMEOUT`, `400 SQL_ERROR` (DuckDB parser/binder errors), `429 RATE_LIMITED`.

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
  services/      audit, auth/tokens, groups (teams + SSO sync), workspaces (membership/roles, tabs), query (authz + HITL),
                 connections, files (uploads),
                 lakehouse (Iceberg ATTACH + Databricks), databricks (UC + Statement Execution client), agents, aws (Bedrock/AgentCore bridge)
  agent/         tool registry (shared by MCP + REST), OpenAPI generator, framework snippets
  mcp/           server (registry → tools, resources, prompts), stdio, http (SSE + Streamable HTTP)
  routes/        auth (local + OIDC), workspaces (+ members), groups, query (REST + WS), files, events (WS), connections, tokens, admin, system
  observability/ pino, prom-client, OpenTelemetry, live event bus, CPU sampler
packages/web/src
  features/overview   drop zone · KPI badges · null-ratio bars · Chart.js distributions · sample grid
  features/workspace  schema tree (click-to-insert) · tabs with per-tab Stop · editor (cursor persisted) · streaming grid · chart · plan · profile
  features/settings   categorised left-nav: appearance (themes/fonts/scale) · layout · hardware gauges · engine tuning · storage · copilot · account · teams · users
  features/workspace  ShareDialog (members, roles, transfer, leave) next to the workbench
  theme/              theme definitions (ramps, accents, tones, chart series, fonts) · store/theme.ts applies them as CSS variables
  features/mcp        registered agents (tokens, self-test, chat) · framework snippets + OpenAPI · client snippets · live inspector (WS)
  features/explorer   VS Code-style tree (data dir, folders, cloud, lakehouse) · schema panel · cloud & lakehouse wizards
```

## Tests

```bash
pnpm test        # 163 tests: jail, SQL guard, crypto, config, sharing/teams, and integration suites that boot real DuckDB
                 # engines, the MCP server (in-memory, SSE, Streamable HTTP), uploads, overview profiling,
                 # the live event feed, the HTTP API, WebSocket streaming, a mock Iceberg REST catalog serving
                 # real Iceberg tables (test/fixtures/iceberg), a mock Databricks workspace (Unity Catalog +
                 # Statement Execution API) and the agent façade / AWS providers against a fake AWS bridge
node scripts/smoke.mjs http://localhost:4200 admin@example.com <password>   # against a running instance
```
