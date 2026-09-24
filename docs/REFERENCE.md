# DuckView — technical reference

> The product overview lives in the [README](../README.md). This document is the complete reference: configuration, security model, APIs, MCP tools, CLI, observability and project layout.

A hardened, stateful, native-DuckDB data platform: multi-tenant SQL workspaces with a polished UI, lakehouse connectors (AWS Glue / SageMaker Lakehouse, S3 Tables, Iceberg REST, Databricks), and an enterprise-grade **Model Context Protocol (MCP)** server plus REST/OpenAPI façade so autonomous agents (Claude, Cursor, Strands, LangGraph, LangChain, CrewAI, Bedrock AgentCore, …) can query the same sandboxed engines with human-in-the-loop safety.

```
┌──────────────── React + Vite + Tailwind v4 (zinc/violet) + Chart.js ─────────┐
│ #/  Overview     drag-and-drop ingestion · KPIs · null bars · distributions   │
│ #/query          VS Code-style explorer (any local folder + S3/R2/GCS/Azure  │
│                  + lakehouse catalogs) · schema pane · tabs · engine picker  │
│                  (DuckDB / Databricks warehouse) · saved queries · .sql io   │
│ #/connections    source catalog · databases (attached read-only) · lakehouse ·│
│                  storage · scheduled syncs with transformations + run history│
│ #/dashboards     grid dashboards (drag-and-drop KPI/chart/table/markdown,    │
│                  auto-refresh) · Mosaic dashboards (declarative spec, editor │
│                  + live preview, cross-filtered, generated from any dataset) │
│ #/settings       categorised: appearance · layout · hardware · engine ·     │
│                  storage · copilot · account · users                          │
│ #/mcp            registered agents · framework snippets · OpenAPI · tokens  │
│                  · live agent inspector                                       │
│ DuckCopilot      dockable AI drawer (Claude · ChatGPT · Gemini · DeepSeek ·    │
│                  OpenRouter · Kimi · Groq · Mistral · Grok · Ollama · Bedrock ·│
│                  Bedrock Agent · AgentCore runtime, BYOK)                     │
└──────────────┬───────────────────────────────────────────────────────────────┘
               │ REST · WS (rows, live events) · SSE (copilot, MCP) · Streamable HTTP
┌──────────────▼───────────────────────────────────────────────────────────────┐
│ Fastify 5 (TypeScript strict)                                                │
│  auth: local (scrypt) · OIDC+PKCE (+group→team sync) · SCIM · API tokens     │
│  Sharing: workspace roles OWNER/EDITOR/VIEWER for users and teams            │
│  QueryService ─ single choke point: authz → SQL guard → HITL → audit         │
│  ResultCache ─ LRU keyed on file stat + workspace data epoch · ETag/304      │
│  Mosaic ─ engine as a Mosaic connector (Arrow, exec policy) · spec dashboards│
│  Storage: jailed tree · S3/Azure SDK listings · DESCRIBE-based inspection     │
│  Exports: COPY … TO (parquet/csv/json) + streaming Arrow IPC writer          │
│  Copilot: schema/SUMMARIZE/active-SQL context → provider bridge (SSE)        │
│  Lakehouse: Iceberg ATTACH (Glue/S3 Tables/REST/UC) · Databricks SQL API     │
│  Connections: databases ATTACHed · 13 connectors (warehouses, SaaS, Google)  │
│               · scheduled syncs with validated transformations              │
│  Mosaic: exec-policed connector · materialised datasets · spec validation    │
│  Data apps: runner (subprocess·docker·k8s) · review · cookie proxy /apps/:id │
│  Copilot: 14 providers, keys write-only · usage per session and token       │
│  Agent tools: one registry → MCP (55 tools · 4 resources · 6 prompts)        │
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

# …or put these in a .env file next to package.json: `pnpm start` reads it (shell variables win), as does docker compose.
export JWT_SECRET=$(openssl rand -hex 32)
export ENCRYPTION_KEY=$(openssl rand -hex 32)   # keep it: it protects stored credentials and the Copilot key saved from Settings
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
| | `scim.enabled`, `scim.token`, `scim.on_delete` | SCIM 2.0 provisioning at `/scim/v2` (on by default, inactive until a token exists); a fixed bearer token instead of one generated in Governance → Provisioning; what a SCIM `DELETE /Users/:id` does — `deactivate` (default) or `delete`. |
| `security` | `filesystem_mode` | `full` (default, VS Code-like): add any local folder to the explorer, query files anywhere on the host, cloud sources on. `sandboxed` (multi-tenant): everything confined to `data_jail_directory`, external access off unless enabled. Relative paths always anchor to the data directory. |
| `duckdb` | `extension_directory` | Where `httpfs`/`azure`/`arrow`/`iceberg`/`delta` are installed. The image ships them pre-installed at `/app/duckdb-extensions` (`scripts/install-extensions.mjs`). |
| | `export_ttl_seconds`, `export_max_rows` | Server-side export files expire after the TTL. |
| `copilot` | `provider`, `model`, `api_key`, `base_url`, `allow_byok` | Deployment-time default for the DuckCopilot LLM bridge (prefer Settings → Copilot, which keeps the key out of files) (`anthropic`, `openai`, `gemini`, `deepseek`, `openrouter`, `kimi`, `groq`, `mistral`, `xai`, `ollama`, `custom`, the AWS providers, or `none`). A provider saved from **Settings → Copilot** by an administrator takes precedence; users may bring their own key when `allow_byok` is true. See [DuckCopilot](#duckcopilot). |
| `duckdb` | `default_memory_limit` | `80%` of host RAM or absolute (`16GB`). Per-workspace overrides in the UI. |
| | `default_threads`, `temp_directory`, `query_timeout_seconds`, `max_result_rows` | Threads/timeout are per-workspace tunable; results are hard-capped for the grid. |
| `mcp` | `default_page_size` / `max_page_size` | 50 / 200 rows per tool call; `max_cell_chars` truncates long strings. |
| | `require_confirmation_for_mutations` | HITL gate for agents. |
| `cache` | `enabled`, `max_bytes`, `max_entry_bytes` | Server-side result cache (default on, 256 MB LRU, entries ≤ 16 MB). See [Result cache](#result-cache). |
| `duckdb.default_database`, `duckdb.cloud_sync_delay_seconds` | `file` (default) or `memory`; 60 | Storage of a workspace created without an explicit database (a `<name>.duckdb` file in the data directory, or an in-memory scratch database), and the quiet period after which a cloud-backed workspace is pushed to its object. See [Persistent workspaces](#persistent-workspaces). |
| `mosaic` | `enabled`, `schema`, `max_rows`, `materialize_max_rows`, `rate_limit_per_minute` | Interactive visualization (uwdata/mosaic) endpoint; the schema (default `duckview_mosaic`) holds pre-aggregated views, source views are `<schema>_src_<hash>` in the main schema, dashboard datasets up to `materialize_max_rows` (20 M; `0` = never) are materialised in an attached in-memory database `<schema>_mem` — all dropped whenever the data epoch moves; `max_rows` (1 000 000) caps chart queries independently of the grid; the connector has its own budget of `rate_limit_per_minute` (6 000) requests **per session** — one brush over 25 charts is 25–75 requests — so `server.rate_limit_per_minute` (per IP) never throttles dashboards; the browser retries a `429` after `Retry-After`. See [Interactive exploration (Mosaic)](#interactive-exploration-mosaic) and [Mosaic dashboards](#mosaic-dashboards). |
| | `ttl_seconds`, `remote_ttl_seconds` | Lifetime of versioned entries (6 h) and of entries touching remote / lakehouse / MotherDuck sources (60 s; `0` never caches them). |
| `transform` | `scheduler_enabled`, `dbt.enabled`, `dbt.python`, `dbt.venv_dir`, `dbt.auto_install`, `dbt.package`, `dbt.allow_packages`, `dbt.timeout_seconds`, `dbt.max_project_bytes` | dbt projects: scheduled runs on/off; dbt on/off; the interpreter and virtualenv dbt Core is installed into (default `<data dir>/.duckview/dbt/venv`), installed on the first run unless `auto_install: false`; the pip requirement (`dbt-duckdb`, pin a version here); whether `dbt deps` may fetch packages; the compile timeout (300 s) and the largest project (20 MB). |
| `observability` | `metrics_enabled`, `otel.*` | Prometheus at `/metrics`; OTLP/HTTP trace export when `otel.enabled`. |

## Security model

1. **Filesystem jail (Node layer).** `DataJail` resolves every path-looking SQL string literal (`'sales.parquet'`, `read_csv('/x')`, `COPY … TO`, `ATTACH`) against `data_jail_directory`, rejects any `..` segment, home-relative paths, drive letters, null bytes, and symlinks that escape — then **rewrites relative literals to absolute jail paths** before the SQL reaches DuckDB.
2. **DuckDB hardening (engine layer).** Each engine starts with `memory_limit`, `threads`, `temp_directory`, autoinstall off; then `SET allowed_directories = [jail, spill]`, `SET enable_external_access = false`, `SET lock_configuration = true`. A literal that dodges the Node heuristic (e.g. built with `concat()`) still hits DuckDB's own `Permission Error`.
3. **Statement classification.** A quote/comment/CTE-aware lexer classifies each statement as `read` / `write` / `destructive` / `admin`. `READ_ONLY` users and tokens without `write` cannot run mutating SQL; `admin` statements (`SET`, `PRAGMA`, `ATTACH`, `INSTALL`, `LOAD`, `CALL`) require the `admin` scope for agents.
4. **Human-in-the-loop for agents.** Any mutating statement from an MCP/API-token actor is blocked with an `approval_required` challenge (the verbs, per-statement previews, and how to proceed) until it is re-issued with `dry_run: false`. `save_dataset` is gated the same way.
5. **Secrets.** Stored S3/GCS/Azure/HTTP/Postgres/MotherDuck credentials are AES-256-GCM encrypted (unique IV, auth tag, row-id as AAD) and applied via `CREATE SECRET` / `motherduck_token` only for the owning user's engine. Passwords use scrypt; API tokens are `dv_…` random strings stored as SHA-256 hashes and shown once. **LLM API keys** saved from Settings → Copilot are write-only: encrypted the same way (the platform `ENCRYPTION_KEY`; only the last four characters are kept in clear, shown to administrators), never returned by any endpoint or page, never in logs (pino redacts `authorization`, `api_key`, `password`, `token` fields on every log line) or the audit trail (which records `copilot.settings.update` and the provider, not the value), scrubbed from provider error messages (`scrubSecrets`: known key formats, bearer values and the key in use), and only ever sent to the vendor's endpoint. A rotated `ENCRYPTION_KEY` leaves the stored key *undecryptable* — the console says so and asks for it again rather than using a stale value; without an `ENCRYPTION_KEY` at all the console warns that the key will not survive a restart. Administrators can switch personal (bring-your-own) keys off for the deployment, after which every request runs on the server provider exactly as configured — no client-chosen vendor, key, endpoint or model. Personal keys, when allowed, live in the person's browser only and are sent per request.
6. **Isolation & limits.** One DuckDB instance per workspace, a fresh connection per query (so `interrupt()` on timeout/cancel is query-scoped), row caps, cell truncation, rate limiting, and a full audit trail (`actor_type` USER/AGENT, action, SQL, duration, IP, status).
7. **Workspace authorization.** Every workspace access resolves an effective role — the creator and platform admins (UI sessions only, never tokens) are OWNER; otherwise the highest of the user's direct grant and their teams' grants. Inaccessible workspaces are `404` (no existence leak); insufficient role is `403`. See [Sharing & teams](#sharing--teams).

## Layout

**Navigation.** A narrow rail on the left holds the eight places: **Home** (recent queries, datasets and dashboards, workspace status), **Data** (the explorer, with Models, Metrics, Quality, Catalog, Lineage and Access policies as tabs), **SQL** (the workbench, with Notebooks as a tab), **Dashboards** (with Alerts, Snapshots and Channels), **Apps**, **AI** (agents, tools, MCP clients, activity, approvals), **Connections** and **Settings**. The top bar shows the workspace switcher and where you are, the command bar, live status, the **AI** panel toggle and your account (theme, appearance, sign out). **⌘K / Ctrl+K** opens the command palette: go anywhere, open a dataset, saved query or dashboard, create things, switch workspace or theme. Every older link (`#/transform/…`, `#/governance/…`, `#/alerts/…`, `#/mcp`, `#/overview`) still opens the same page.

**The workbench** is IDE-shaped: a schema side bar (Explorer · Tables & views · Saved queries · History), query tabs, a run toolbar (Run / Stop, engine, execution time, rows, row limit, Save, and a ⋯ menu for import/export, *Save as dbt model* and more) above the editor, and a results pane with Results · Chart · Profile · Explain · Schema · Explore. Results sort by column (click a header), resize (drag its edge), filter, copy as tab-separated text, and export the full result as CSV, Parquet, JSON or Arrow.

Every region resizes: drag the splitters between the side bar and the main area, between the editor and the results pane, and between the side bar sections. Section headers collapse, the side bar can be hidden, and double-clicking a splitter resets it. Components can be hidden from their headers and restored under Settings → Layout; sizes and hidden components are remembered per browser.

## Themes

Six built-in themes decide both the colour system and the typeface — three dark (**Midnight** graphite with the duckbill-yellow accent, the default dark look · **Graphite** neutral/blue · **Fjord** Nord-style teal) and three light (**Daylight** white and cool gray with the duckbill-yellow accent, the default light look · **Professional** navy on grey with IBM Plex, for corporate/print contexts · **Paper** warm off-white with orange). Switch from the account menu, the command palette or Settings → Theme & fonts, where you can also override the sans/mono fonts and the UI scale independently of the theme. Every colour in the app (surfaces, tones, status, code editor, chart series/grid/tooltips) resolves through runtime CSS variables set on `<html>` — Tailwind's `@theme` tokens reference them, so opacity variants like `bg-zinc-800/60` re-theme too. Chart palettes are validated per theme for colour-vision-deficiency separation and contrast against each surface. Preference is stored in the browser (`duckview.theme`); `prefers-color-scheme` picks Midnight or Daylight on first load.

## Settings

Settings is split into categories in a left-hand nav (deep-linkable as `#/settings/<category>`): **Appearance** (themes, fonts, scale) · **Layout** (show/hide components) · **Hardware** (live gauges, resources, warm engines) · **Engine** (memory, threads, timeout, sandbox) · **Storage** (cloud connections, data connections) · **Copilot** (provider status) · **Account** · **Users** (admin).

## Result cache

Profiles (`overview`, `SUMMARIZE`), schema inspection, `EXPLAIN` plans, dashboard widget data and read-only SQL results are cached in two places:

1. **Server (shared).** An in-process LRU (`cache.max_bytes`) in front of the engine. Every member of a shared workspace, every dashboard viewer, Copilot's context hydration and the MCP `profile_dataset` / `execute_query` tools all hit the same entries.
2. **Browser (per user).** IndexedDB keeps the last copy of each profile, schema, plan, widget and the final result of every workbench tab. On the next visit the page paints from it immediately (marked *cached · profiled 3 min ago*) and revalidates in the background. Wiped on sign-out and on session loss; capped at 150 MB (LRU); a tab result above 2 MB is not persisted.

**Correctness comes from the key, not from timers.** The cache key — which is also the HTTP `ETag` — embeds:

- the absolute path, size and mtime of every local file the operation reads (extracted from the SQL's string literals or the bare target), so a file rewritten outside DuckView invalidates;
- the workspace **data epoch** (`workspaces.data_version`) for anything that can read in-database tables. The epoch moves on every non-read statement (even a failed script), `save_dataset`, uploads and deletions, folder changes, engine restart / settings change, transfer, lakehouse connection changes, and whenever a `:memory:` engine (re)starts — because that drops every table. Pure file targets do not embed it, so a `CREATE TABLE` never throws away a 10 s profile of a 400 MB CSV;
- the paging/limit options.

SQL that names an attached lakehouse alias, a remote URI (`s3://…`) or runs on a MotherDuck workspace has no version signal and is cached for `cache.remote_ttl_seconds` only. SQL using non-deterministic functions (`random()`, `now()`, `current_timestamp`, `uuid()`, …), mutations and `EXPLAIN ANALYZE` are never cached.

**Protocol.** `POST /api/workspaces/:id/overview | /profile | /explain | /query`, `POST /api/storage/inspect` and `POST /api/dashboards/:id/widgets/:wid/data` answer with `ETag: "<key>"` and `cached` / `computed_at` in the body; send `If-None-Match` to get a `304` when the key still matches (one `stat` and a hash — no DuckDB work); `refresh: true` in the body (or `X-DuckView-Refresh: 1`) recomputes and re-stores. `GET /api/workspaces` carries each workspace's `data_version`; the live feed (`WS /api/ws/events`) pushes `{type:"workspace", workspace_id, data_version, reason}` to every member when it moves, and the query WebSocket's `done` message includes it after a mutation. `DELETE /api/workspaces/:id/cache` (editor) drops the workspace's server entries *and* moves the epoch so every browser recomputes; `POST /api/admin/cache/clear` empties the server cache. Stats: `GET /api/system/live → cache`, Prometheus `duckview_cache_lookups_total{kind,result}`, `duckview_cache_bytes`, `duckview_cache_entries`.

Single-replica by design (the server cache is per process); with several replicas each keeps its own — still correct, just less warm.

## Interactive exploration (Mosaic)

The **Explore** view — on the Overview page (*Explore* button) and as a results view in the workbench — is built on [Mosaic](https://idl.uw.edu/mosaic/) (`@uwdata/vgplot` 0.31, BSD-3). Every numeric or temporal column becomes a histogram, every low-cardinality text column a bar chart, with a lazily paged table underneath; brushing any chart cross-filters all the others. Mosaic's coordinator turns interactions into SQL and, for repeated filtering, builds pixel-binned **pre-aggregated views** so brushing stays interactive on millions of rows.

DuckView runs Mosaic against the workspace engine — never DuckDB-WASM in the browser — through `POST /api/workspaces/:id/mosaic`:

| `type` | What happens |
|---|---|
| `arrow` / `json` | A single read-only statement run through the normal query pipeline (role, guard, audit, result cache with `ETag` / `If-None-Match`) with the `mosaic.max_rows` ceiling; `arrow` returns an Arrow IPC stream. |
| `exec` | Admitted only in Mosaic's own shapes, validated statement by statement: `CREATE SCHEMA IF NOT EXISTS "<schema>"`, `CREATE TABLE IF NOT EXISTS "<schema>"."preagg_<hex>" AS SELECT …`, `DROP SCHEMA IF EXISTS "<schema>" CASCADE`, `DROP TABLE IF EXISTS "<schema>"."preagg_<hex>"`, plus DuckView's **source views** `CREATE [OR REPLACE] VIEW "<schema>_src_<hex>" AS SELECT …` / `DROP VIEW IF EXISTS "<schema>_src_<hex>"` that make a file, a schema-qualified table, an ad-hoc query or a spec's inline rows addressable by one plain name (Mosaic reads every table reference as a single identifier), and **materialised datasets** `CREATE TABLE IF NOT EXISTS "<schema>_mem"."src_<hex>" AS SELECT …` / `DROP TABLE IF EXISTS …` in an in-memory database the server attaches on first use (never written to the workspace file). The wrapped SELECT must be a single read-only statement and passes the sandbox. Anything else is `403`. |

Pre-aggregates and source views are derived data, not workspace mutations: any member with read access can create them (viewers included), they never move the data epoch and are never held for agent approval. **Invalidation reuses the epoch** — when it moves, the server drops the Mosaic schema and every source view, and the views rebuild from the live event. Both are hidden from the catalog, the explorer and `list_accessible_data`; the schema is named `duckview_mosaic` rather than `mosaic` because a workspace database file called `mosaic.duckdb` would make `"mosaic"."preagg_x"` ambiguous between catalog and schema. `GET /api/mosaic/info` reports the schema and limits; `duckview_mosaic_exec_total{kind}` counts plumbing statements.

Browser side: `lib/mosaic` (a connector that decodes Arrow with Mosaic's `decodeIPC`, one coordinator per view bound to the workspace, `analyze.ts` for column roles and source views, `spec.ts` for spec preparation) and `features/explore/ExploreView.tsx`. `scripts/e2e-mosaic.mjs` drives a real Chrome through the Overview, workbench and Mosaic-dashboard scenarios (login, render, generate, save, brush, reload) over the DevTools protocol and fails on any page exception.

## Mosaic dashboards

Dashboards have a `kind`: **grid** (widgets on a drag-and-drop layout, bound to saved queries or SQL) or **mosaic** — a [Mosaic declarative specification](https://idl.uw.edu/mosaic/spec/) stored as JSON (`dashboards.spec`) and rendered live against the workspace. Pick the kind when creating one; the list badges Mosaic dashboards and summarises their plots and inputs.

A Mosaic dashboard page has three modes: **view** (everyone with access to the workspace), **edit** (editors: a YAML/JSON editor with a live preview that re-renders 600 ms after a valid change, ⌘S / *Save* to persist, format toggle) and **Generate** — pick a table, a data file or a SELECT and DuckView drafts a complete spec from its columns: a cross-filtered histogram per numeric or temporal column, a bar chart per low-cardinality text column, and the filtered rows underneath. The draft is ordinary spec text you then edit.

Specs are written exactly as in the Mosaic docs; the differences are only in where data comes from:

- `from: <name>` works directly for any table or view in the workspace's main schema. Schema-qualified names (other schemas, attached lakehouse catalogs) go through a `data` entry with a query, e.g. `{query: SELECT * FROM lake.sales.orders}`.
- `data:` entries — `{query}` / a bare SQL string, `{file: x.parquet}` (`csv`, `json` with their `read_*` options), an inline list of rows — become hidden **source views** (`<schema>_src_<hash>`, hashed on the definition so an edited dataset gets a fresh view) and every `from:` referring to them is rewritten before the spec is instantiated. Existing tables need no `data` entry; `spatial` data is not available.
- File paths are resolved inside the workspace jail like any other SQL literal.
- **Datasets are materialised.** Each `data` entry is loaded once into `<schema>_mem` (an attached in-memory DuckDB database, idempotent across reloads because the table name hashes the definition) and the view points at it, so every brush, menu or slider reads columnar memory instead of re-parsing the file — on a 3.7 M-row CSV a chart query drops from ~600 ms to ~6 ms and the first slider move answers in half a second. Datasets above `mosaic.materialize_max_rows` stay plain views (prepare says so in a warning), as does any entry with `materialize: false`. Tables referenced directly are never copied. The in-memory database is detached whenever the data epoch moves.

Everything else — `params`, selections (`crossfilter`, `intersect`, `single`…), inputs (`menu`, `search`, `slider`, `table`), `plot` with every mark, interactor and attribute, `legend`, `hconcat` / `vconcat` / spacing — is Mosaic's own and runs through the same connector endpoint, so it inherits the role model, the sandbox, the result cache and the exec policy. Specs are capped at 512 KB; `spec` is `null` on grid dashboards and a PATCH with a `spec` on one is `400`. Widgets cannot be added to a Mosaic dashboard.

**Validation is server-side and shared.** `POST /api/workspaces/:id/mosaic/prepare {spec | spec_text, bind?}` checks the structure in Mosaic's own terms (marks, attributes, interactors, legends, inputs, selection types — the vocabulary is generated from the installed vgplot by `scripts/gen-mosaic-names.mjs`, so the server never loads the browser stack), turns `data` into source-view statements, and binds every dataset SELECT and every plain `from:` table with `EXPLAIN` (no data is read) so a missing file, table or column is reported before anything renders or is saved. It answers `{ok, errors, warnings, spec, statements, sources, tables}`; the editor, the MCP tool and Copilot all go through it. Warnings flag channel objects that are not a transform (`x: {bins: col}`), which Mosaic would otherwise pass through as literals.

**Agents and Copilot.** The MCP tool `create_mosaic_dashboard` (spec or spec_text; `validate_only` to check first; `dashboard_id` to update) refuses invalid specs with the error list; the resource `duckdb://guides/mosaic-spec` and the prompt `build_mosaic_dashboard` carry the authoring rules. In DuckCopilot, **Build dashboard** (or any chat that mentions a chart or dashboard) puts the same guide in the system prompt; every ```yaml / ```json spec in a reply is validated against the workspace when the turn completes (`spec_blocks` on the `done` event) and rendered with **Create dashboard** — validated, saved and opened in one click — or **Fix with Copilot**, which sends the errors back.

A chart whose query fails after rendering (Mosaic keeps the rest of the view alive) is listed in a *chart queries failed* panel with the DuckDB message and the statement, and in the editor's status bar.

`examples/mosaic/nyc-yellow-taxi.yaml` is a complete dashboard over 3.7M TLC trips — menus and sliders, headline numbers, an hourly timeline, hour × weekday heatmap, brushable histograms, a distance/fare density raster, fare-by-payment lines, top zones and the filtered rows — all on one crossfilter selection.

API: `POST /api/workspaces/:id/dashboards {name, description?, kind?: grid|mosaic, spec?}` · `PATCH /api/dashboards/:id {spec}` (editor) · `POST /api/workspaces/:id/mosaic/prepare`. The MCP `list_dashboards` tool reports `kind` and `spec`.

## Data connections & syncs

**Connections** (`#/connections`) is the one place for every source: *Configured* (everything with health, last test; click a row or its pencil to open that connection's settings), *Add a source* (the catalog — every card opens the form of that exact source, no second provider chooser) and *Syncs* (scheduled loads into the active workspace). Agents reach the same objects through `list_data_sources`, `browse_connector`, `connector_query`, `create_data_sync`, `update_data_sync` and `run_data_sync`.

**The catalog** (`GET /api/sources/catalog`, `services/source-catalog.ts`) groups source types by family with their auth style, capabilities (browse · attach · remote SQL · sync) and fields:

| Family | Sources |
|---|---|
| Object storage | Amazon S3, Cloudflare R2, Google Cloud Storage, Azure Blob |
| Lakehouse catalogs | AWS Glue / SageMaker Lakehouse, Amazon S3 Tables, any Iceberg REST catalog (Polaris, Nessie, Tabular, Lakekeeper, Snowflake Open Catalog), Databricks (Unity Catalog + remote SQL) |
| Databases | PostgreSQL, MySQL / MariaDB, SQLite files, DuckDB files |
| Web, Drive & Sheets | HTTP / REST endpoints (CSV, JSON, Parquet, Excel over HTTPS with a bearer token or headers), **Google Drive** and **Google Sheets** through a Google account, Google Sheets shared links (no sign-in) |
| Warehouses | **Snowflake**, **Google BigQuery**, **Amazon Redshift**, **ClickHouse**, **Microsoft Fabric / OneLake** |
| SaaS applications | **Salesforce**, **HubSpot**, **Stripe**, **Google Analytics 4**, **Airtable**, **Notion** |

**Connectors** (`services/connectors/`, `connector_connections`, `/api/connectors` · `/api/connector-connections` CRUD · `/test` · `/browse?path=a/b` · `/query`) cover the warehouses, the SaaS applications and Google Drive / Sheets. Each connector module knows how to *test* a connection, *browse* what it offers one level at a time (databases → schemas → tables, bases → tables, objects, folders → files, spreadsheets → tabs …), *read* a resource as row batches and, for warehouses, run *SQL remotely*:

| Connector | Transport | Credentials | Browse → resource |
|---|---|---|---|
| Snowflake | SQL API v2 (statements, partitions, polling) | programmatic access token or OAuth token | database → schema → table / view, or `{sql}` |
| BigQuery | REST `jobs.query` with paging, typed rows | Google account (OAuth) or service-account key | dataset → table / view, or `{sql}` |
| Redshift | Data API (`ExecuteStatement` → `GetStatementResult`), no VPC access needed | AWS keys or the server's credential chain; workgroup or cluster; optional Secrets Manager ARN | database → schema → table, or `{sql}` |
| ClickHouse | HTTP interface, `FORMAT JSONEachRow` | user + password | database → table, or `{sql}` |
| Fabric / OneLake | OneLake blob listing (`@azure/storage-blob` + service principal); the table itself is read by a scratch DuckDB with `delta_scan` over `abfss://` and copied to Parquet | Entra tenant, client id, client secret | item (Lakehouse / Warehouse) → Delta table |
| Salesforce | REST, `describe`-driven SOQL with `nextRecordsUrl` paging | connected app (client-credentials flow) | queryable objects, or `{soql}` / `{object, where}` |
| HubSpot | CRM v3 objects with every property, `after` paging; custom-object schemas | private-app token | contacts, companies, deals, tickets … + custom objects |
| Stripe | `/v1/*` list endpoints, `starting_after` paging, nested objects flattened | restricted / secret key | charges, customers, invoices, subscriptions, payouts, balance transactions … |
| GA4 | Data API `runReport` (dimensions × metrics × date range, offset paging) | Google account or service account | report presets, editable resource `{dimensions, metrics, start_date, end_date}` |
| Airtable | meta bases / tables, records with `offset` paging | personal access token | base → table (optional view) |
| Notion | `search` for databases, `query` with `start_cursor`; properties flattened to plain values | internal integration secret | database |
| Google Drive | Drive v3 listing; CSV / TSV / JSON / Parquet / Excel downloaded, a Google Sheet exported as CSV | Google account | folder → file |
| Google Sheets | Drive listing + Sheets v4 `values` (first row = header, padding rows dropped) | Google account | spreadsheet → tab |

Credentials (API keys, secrets, OAuth refresh tokens, service-account keys) are AES-256-GCM encrypted with the row id as AAD, never returned by any endpoint (the API reports `credential_fields` — names only), never logged, and never reach the workspace engine: a sync **stages** the rows through the connector into a newline-delimited JSON file under `<data dir>/.duckview/sync/` (a Drive file is downloaded as is, a Fabric table is copied to Parquet by a scratch DuckDB that holds the Azure secret), loads it with `read_json_auto` / `read_csv_auto` / `read_parquet` / `read_xlsx`, and removes the file. Every connector needs `security.enable_external_access` (or full filesystem mode). Throttling (`429` / `503` with `Retry-After`) is retried with a capped back-off. Remote SQL is checked to be a single read-only statement before it is sent; on `POST /api/connector-connections/:id/query` and in the `connector_query` tool the result is capped (default 200 / 1 000 rows).

**Google account sign-in** (Drive, Sheets, BigQuery, GA4). People sign in with their Google e-mail and password **on Google's own page** (OAuth 2.0 — Google does not let third-party apps take the password itself, and 2-step verification applies); DuckView receives a read-only token. For that Google requires the app to be registered once: an administrator adds the OAuth client under **Settings → Integrations** or inline in the first Google connection wizard (`PUT /api/admin/integrations/google {client_id, client_secret}`; the secret is write-only and stored encrypted in `app_settings`, never in a config file or environment variable; the redirect URI is `<server.public_url>/api/oauth/google/callback`). *Connect with Google* in a connection wizard calls `POST /api/oauth/google/start {connector, name, values}` — the server creates a pending connection and returns Google's consent URL (`openid email` + the connector's read-only scopes, `access_type=offline`, `prompt=consent`); the state is a 10-minute JWT carrying the user and the connection, so multi-replica deployments need no session store. `GET /api/oauth/google/callback` exchanges the code, stores the refresh token encrypted on the connection, labels it with the account's e-mail and redirects to `#/connections?connected=<id>` (or `?google_error=` — never a 500). Access tokens are refreshed from the stored refresh token as needed and cached in memory until they expire. A **service-account key** (JSON) pasted in the wizard is the server-to-server alternative: an RS256 JWT-bearer grant, no OAuth client needed.

Storage and lakehouse sources keep their existing wizards and routes; **database connections** are new (`database_connections`, `/api/database-connections` CRUD · `/test` · `/browse?schema=`): the password is AES-256-GCM encrypted, the database is attached **read-only** to every engine of the owner's workspaces through DuckDB's `postgres` / `mysql` / `sqlite` extensions (or a plain `ATTACH` for a `.duckdb` file) as `alias.schema.table`, browsed schema by schema, and hot-applied to running engines (attachment fingerprint). Network databases need `security.enable_external_access` (or full filesystem mode); file databases live inside the jail. The container image pre-installs the three extensions.

**Syncs** (`data_syncs`, `data_sync_runs`) load a source into a table of a workspace on a schedule:
- *source*: `{kind: "table", schema, table, database_connection_id | catalog}` (an attached database or lakehouse table), `{kind: "connector", connection_id, resource}` (what a `browse` leaf returned — a warehouse table, a SaaS object, a Drive file, a Sheets tab — or `{sql}` on a warehouse), `{kind: "url", url, format: auto|csv|json|parquet|excel, options?}` (a shared Google Sheet is a CSV export URL: `GET /api/sources/google-sheet-url?spreadsheet_id=&gid=`), or `{kind: "sql", sql}` (any read-only SELECT);
- *target*: `target_schema.target_table`, `mode: replace | append`;
- *transformation* (optional): one SELECT over `{{raw}}` — the freshly loaded rows — whose result becomes the target. Written by a person or by an agent; **validated against the source before it is saved** (`POST /api/workspaces/:id/syncs/preview` binds source + transform with a `LIMIT`, the sync editor's *Preview* and *Draft with Copilot* use it);
- *schedule*: `manual`, `interval` (minutes) or `cron` (5-field, UTC by default); `enabled` pauses.

A run is a guarded SQL sequence on the workspace engine executed **as the workspace owner** — roles, sandbox, audit trail (`sync.run`) and data epoch apply exactly as for a person: `CREATE OR REPLACE TABLE <target>__staging AS <load>`, optionally `<target>__next AS <transform>`, then a swap (replace) or `INSERT INTO` (append); a failing load leaves the target untouched. Runs are recorded (`rows`, `duration_ms`, `error`, `triggered_by: schedule | manual | agent`) and announced on the live feed (`{type: "sync"}`), the last 200 kept per sync. The scheduler is one in-process ticker (30 s; `duckdb.sync_scheduler_enabled: false` on replicas). API: `GET/POST /api/workspaces/:id/syncs` · `GET/PATCH/DELETE /api/syncs/:id` · `POST /api/syncs/:id/run` · `GET /api/syncs/:id/runs`. Viewers see syncs and runs; editors create, run, pause and change them.

**Agents.** `list_data_sources` (every connection with health — connector connections included — the syncs of a workspace, the catalog), `browse_connector(connection_id, path?)` (walk a connector to the `resource` to sync), `connector_query(connection_id, sql, limit?)` (read-only SQL on a warehouse), `create_data_sync` (validates source and transformation, `run_now`), `update_data_sync` (attach a transformation, change the schedule, pause), `run_data_sync` (rows, duration, error, recent runs), plus the `build_data_pipeline` prompt (browse → inspect → sync → transform → validate → verify). In the sync editor, **Draft with Copilot** asks DuckCopilot for a transformation over the previewed columns and drops the SQL in.

## Data apps (Streamlit, Dash, Gradio)

**Apps** (`#/apps`) are Streamlit applications written on a workspace's tables and files, registered next to dashboards (`data_apps`: name, description, `files` — `app.py`, `requirements.txt`, helpers — `entry`, `visibility`, runtime state) and **run by DuckView**. The gallery lists a workspace's apps with their status; the editor is a Python CodeMirror pane next to a live preview (the proxied app in an iframe), with Save (⌘S — a running app restarts), Run / Stop / Restart, logs, "open in a new tab" and a Copilot hand-off that sends the file with the SDK's contract. Two starter templates: *Table explorer* (pick a table, view or data file → filter → grid → chart) and *Blank*.

**Python SDK** (`packages/sdk-python`, `pip install duckview`): `duckview.connect()` reads `DUCKVIEW_URL` / `DUCKVIEW_TOKEN` / `DUCKVIEW_WORKSPACE`; `dv.query(sql)` → pandas (or `format="records" | "polars" | "result"`), `dv.query_arrow(sql)` → pyarrow through the Arrow export (large results), `dv.tables()` / `dv.files()` / `dv.catalog()`, `dv.table("trips").where(…).order_by(…).limit(n).to_df()`, `dv.copilot(message)`, `dv.tools()` (the agent façade's OpenAPI) and `dv.call_tool(name, **args)`. `duckview.streamlit` adds `connect()` (`st.cache_resource`), `query()` (`st.cache_data`, 5 min), `datasets()` / `table_picker()` (tables, views and data files as SQL relations) and `viewer()` — the DuckView user behind the request, from the `X-DuckView-User` / `-Email` / `-Role` headers the proxy adds. The SDK only ever talks HTTP: it never opens the `.duckdb` file (the engine holds the lock).

**Runner** (`services/apps.ts` + `services/app-runtimes.ts`). With `apps.runtime: subprocess` (the default) the first start creates a shared virtualenv (`apps.venv_dir`, default `<data dir>/.duckview/apps/venv`; `apps.python` must have `venv` + `pip`) and installs `streamlit`, `pandas`, `pyarrow` and the SDK (`apps.auto_install`); an app's `requirements.txt` is installed before it starts (`apps.allow_requirements`). Sources are materialised under `<data dir>/.duckview/apps/run/<id>/` and `streamlit run` is spawned on a free port of `apps.port_range` with `--server.baseUrlPath=/apps/<id>` and a **minimal environment**: `PATH`, `HOME` (the run directory), `PYTHONPATH` (the SDK) and `DUCKVIEW_URL` / `DUCKVIEW_TOKEN` / `DUCKVIEW_WORKSPACE` — never the server's secrets or config. The token is minted for the app's creator on every start with the `read` scope, **scoped to the app's workspace**, expiring after `apps.token_ttl_hours`, and revoked when the app stops; an app can query what a viewer could and nothing else. Health is polled on `/_stcore/health` (`apps.start_timeout_seconds`), stdout/stderr go to a 500-line ring buffer (`GET /api/apps/:id/logs`), a crash before readiness marks the app `error` with the last lines, everything stops at shutdown and every row is reset to `stopped` at boot. Sources are refused when a file name escapes the directory, the entry is missing, the total exceeds `apps.max_source_bytes` or the code contains what looks like an API token.

**Runtimes** (`apps.runtime`). Each turns the same launch spec (files, entry, environment, base path) into an instance the proxy reaches over HTTP; the rest of the runner does not care which:

| Runtime | Instance | Source · token | Isolation |
|---|---|---|---|
| `subprocess` | `streamlit run` on `127.0.0.1:<apps.port_range>` | files under the run directory · environment variable | a separate process with a minimal environment |
| `docker` | `docker run --rm` of `apps.docker.image` (default `anbproject/duckview-app-runtime:latest`, built from `docker/app-runtime.Dockerfile`), named `dv-app-<id>` | a tar streamed on stdin into `/tmp/app` · `-e DUCKVIEW_TOKEN` by name, the value in the CLI's environment only | read-only root, tmpfs `/tmp`, `--cap-drop ALL`, `no-new-privileges`, uid 1001, `--pids-limit`, `--memory` / `--cpus` from `apps.resources` |
| `kubernetes` | a Pod `dv-app-<id>` in `apps.kubernetes.namespace` (default the server's), reached on its IP at `apps.kubernetes.container_port` | a ConfigMap mounted at `/app-src` · a Secret via `envFrom`; both owned by the pod | `runAsNonRoot`, read-only root, all capabilities dropped, no service-account token, `apps.resources` limits, `restartPolicy: Never`; `k8s/apps-rbac.yaml` grants the role and fences app pods with a NetworkPolicy |

Without `apps.docker.network`, each container publishes one port on `127.0.0.1` and reaches DuckView at `http://host.docker.internal:<port>`; with a network (DuckView itself in Compose, the Docker socket mounted — see `docker-compose.yml`) apps are reached by container name and call `apps.docker.duckview_url`. Pods call `http://duckview.<namespace>.svc` unless `apps.kubernetes.duckview_url` says otherwise. In both container runtimes `requirements.txt` is pip-installed into the user site at start when `apps.{docker,kubernetes}.allow_requirements` (needs egress). Containers and pods carry `duckview.app` / `duckview.server` labels; at boot a server removes the ones it left behind (and only those). A failed image pull, a missing ConfigMap or a crash surfaces as the app's `last_error`.

**Frameworks** (`kind`, `services/app-frameworks.ts`): `streamlit` (default), `dash` or `gradio`, chosen by the template (`explorer` / `blank`, `dash-explorer`, `gradio-query`) or `source: {code, kind}`, fixed at creation. Every runtime starts them the way each framework reads its settings:

| Kind | Command | Settings | Health | Proxy |
|---|---|---|---|---|
| `streamlit` | `streamlit run <entry>` | `--server.port / address / baseUrlPath` flags | `/apps/<id>/_stcore/health` | path as is; `/_stcore/stream` WebSocket bridged |
| `dash` | `python <entry>` (must call `app.run()`) | `HOST`, `PORT`, `DASH_URL_BASE_PATHNAME=/apps/<id>/` | `/apps/<id>/` | path as is |
| `gradio` | `python <entry>` (must call `demo.launch()`) | `GRADIO_SERVER_NAME`, `GRADIO_SERVER_PORT`, `GRADIO_ROOT_PATH=/apps/<id>` | `/` | `/apps/<id>` stripped; `X-Forwarded-Host` / `-Proto` so its URLs point at the apps origin |

`POST /api/apps/validate {files, kind}` checks each framework's contract (imports it; calls `app.run()` / `launch()`; warns about hard-coded host / port / `share=True`). The subprocess runtime installs Dash or Gradio into the shared virtualenv on the first app of that kind; the container image ships all three. The visitor's identity arrives in `X-DuckView-User / -Email / -Role` for every framework — `duckview.viewer_from_headers(flask.request.headers)` in Dash, `(request: gr.Request).headers` in Gradio. Only Streamlit apps can run in the browser.

**In-browser apps** (`execution: browser`, `services/app-stlite.ts`). The app's Python runs in each viewer's browser on [stlite](https://github.com/whitphx/stlite) (Streamlit on Pyodide) instead of a runtime process: the apps origin answers `/apps/<id>/` with a page that mounts `@stlite/browser` (`apps.stlite.url`, default jsDelivr 1.9.1; `apps.stlite.pyodide_url` for a self-hosted Pyodide) with the app's files, the SDK's sources (`duckview/*.py`, so no PyPI), `requirements.txt` as micropip requirements, and an environment carrying a JWT for **the viewer** — `purpose: app-browser`, `read` scope, the app's workspace only, `apps.stlite.token_ttl_minutes` (240). The API accepts it as exactly that (a read-only, workspace-scoped agent principal) and answers the apps origin's CORS preflight (`apps.public_url` joins an explicit `server.cors_origins`). Under Pyodide the SDK does HTTP with a synchronous XMLHttpRequest from stlite's worker and raises `DuckViewError` on error statuses as it does on the server; `viewer()` reads `DUCKVIEW_VIEWER_*` from the page. Such apps have no process to start, stop, keep on or evict (`start` is a no-op and `status` reads `running` whenever `apps.stlite.enabled`); a visitor who can see a published app but is not a member of its workspace gets a page explaining that it reads as them. `PATCH execution` switches an app either way (a running server process is stopped). `preview_app` works the same (the headless browser loads Pyodide).

**Scaling.** Apps scale to zero: the ticker stops apps unused for `apps.idle_stop_minutes`, and the next **page load** (a navigation — not a background poll from a tab left open) starts them again. When `apps.max_running` are running, the least recently used app idle for at least `apps.evict_idle_seconds` is stopped to make room; otherwise the start is refused. Administrators mark apps **always on** (`POST /api/apps/:id/always-on`): they start when the server does (on their creator's behalf), are never idled out or evicted, and are restarted after a crash with exponential backoff (5 s … 5 min) up to `apps.max_restarts` times in a row.

**Publishing.** `visibility: workspace` apps are for the workspace's members; `org` apps are open (read-only) to everyone signed in. With `apps.publish_requires_approval` (default on) an editor's `POST /api/apps/:id/publish {audience: "org", note}` — or `PATCH visibility`, or an agent's `publish_app` — only files a request (`publish_status: pending`); an administrator signed in to the UI (never an API token) approves or rejects it with a note (`POST /api/admin/apps/:id/review`), under **Settings → Data apps**. A code or entry change to an approved app by anyone but an administrator withdraws it to the workspace and re-queues it. Administrators publish directly; unpublishing is immediate. Audit: `app.publish.request` · `app.publish.approve` · `app.publish.reject` · `app.publish.rereview` · `app.publish.org|workspace` · `app.always_on`.

**Origin isolation** (`apps.isolation`, on by default; `apps-server.ts`). An app's code can run script in the viewer's browser — a Streamlit component renders in a same-origin `srcdoc` frame, raw HTML is one flag away — and the UI keeps its session in the browser, so apps are **never served from the UI's origin**. A second listener (`apps.port`, default `server.port + 1`; `apps.public_url` / `DUCKVIEW_APPS_PUBLIC_URL` behind a proxy, e.g. `https://apps.duckview.example.com` — a different host on the same registrable domain) serves the app proxy and nothing else. The browser gets its app cookie there through a **one-time handoff**: `POST /api/apps/:id/session` (bearer, on the UI) returns a 60-second single-use link to `/_duckview/session?app=…&t=…`, which sets the cookie on the apps origin and redirects to the app (a reload with the cookie just redirects). A visitor without the cookie is sent to the UI's `#/apps/<id>?launch=1`, which performs the handoff — so app links can be shared as they are. Old `/apps/<id>/` links on the UI origin redirect to the apps origin. Only sign-in sessions and API tokens are bearer credentials: JWTs DuckView signs for anything else (the app cookie, handoffs, OAuth and OIDC state) are refused by the API, MCP and WebSocket endpoints. `apps.isolation: false` puts the proxy back on the UI origin and logs a warning — only for servers where every app author is trusted with every viewer's account.

**Proxy** (`/apps/:id/*`, `routes/apps.ts`): browsers reach the app from an iframe or a tab where no bearer header exists, so it is authenticated by an HttpOnly, SameSite=Lax cookie scoped to `/apps` (a 12-hour JWT naming the user, set by the handoff above). Every proxied request — HTTP streamed with the reply hijacked, and the `/_stcore/stream` WebSocket bridged message for message with the client's subprotocols — is authenticated from that cookie, checked against the app (workspace member, or anyone signed in for `visibility: org`), and forwarded with the visitor's identity. A page load of a stopped app **starts it** and shows a self-refreshing page until it is up; other requests get `503`. `apps.enabled` defaults to on in full filesystem mode and off in sandboxed mode: apps execute Python next to the server, so keep them off where analysts should not run code. Audit: `app.create` · `app.start` · `app.stop` · `app.delete`; live events `{type: "app"}` fan out to the workspace.

**Generation** (`services/app-generator.ts`) — deterministic, no model involved: a **Mosaic dashboard spec** becomes an app whose datasets are SQL relations, whose `menu` / `slider` / `search` inputs become sidebar filters (composed into a WHERE per dataset), whose KPI `text` marks become `st.metric` cards, whose `barY` / `rectY` / `areaY` / `lineY` / `barX` / `dot` / `cell` marks become aggregating SQL (`GROUP BY`, `USING SAMPLE`, equal-width bins computed over the filtered range) rendered with Altair, and whose `table` inputs become `st.dataframe`; `hconcat` rows become `st.columns`. A **grid dashboard** (widgets) or a set of **saved queries / inline SQL** becomes a query browser (grid + automatic chart per query). **Copilot** drafts `app.py` from a goal in the editor (*Draft*), with the SDK guide as its contract; the result is statically checked before it lands. **Validation** (`POST /api/apps/validate`, and before every agent save): file names, the entry, size, a token scan, `import streamlit`, and `py_compile` with the apps' Python — never executing the app.

API: `GET /api/apps/templates` · `GET /api/apps/guide` · `POST /api/apps/validate` · `GET /api/apps` · `GET/POST /api/workspaces/:id/apps` (`source: {template} | {dashboard_id} | {saved_query_ids} | {queries} | {code, requirements?}`) · `POST /api/workspaces/:id/apps/generate` · `GET/PATCH/DELETE /api/apps/:id` · `POST /api/apps/:id/start|stop|restart` · `POST /api/apps/:id/preview` (headless screenshot; needs Chrome, `apps.chrome_path`) · `GET /api/apps/:id/logs` · `POST /api/apps/:id/session` · `POST /api/apps/:id/publish` · `POST /api/apps/:id/always-on` (administrators) · `GET /api/admin/apps[?publish_status=pending]` (every app without its source, with owner, workspace, instance and the runtime) · `POST /api/admin/apps/:id/review` · `POST /api/admin/apps/:id/stop`. Editors create and change apps; viewers open and start them.

**Agents** build apps the same way: `list_apps`, `create_app(name, source, description?, visibility?, run_now?)` (validated, started, returns the code and URL), `update_app(app_id, code?, requirements?, …)` (re-validated; a running app restarts and the call waits for it), `run_app` / `stop_app`, `get_app_logs`, `preview_app` (health, the rendered page's visible text and a **screenshot as an MCP image** when Chrome is installed — the REST façade returns it as `images[].data_base64`), and `publish_app(app_id, audience, dry_run)` — human-in-the-loop: `dry_run` (default) reports the change, `dry_run=false` applies it and audits `app.publish.<audience>`. The resource `duckdb://guides/data-app` is the SDK contract; the prompt `build_data_app(goal, data?)` walks an agent from connecting the data (syncs) through profiling, a Mosaic dashboard, `create_app`, `preview_app`, `update_app` to `publish_app`.

## Alerts & delivery

**Channels** (`#/alerts/channels`, `services/notifications.ts`) are where alerts and scheduled snapshots are delivered. A channel belongs to a workspace (its editors create, test and change it; viewers see it) or to the whole server (`POST /api/channels`, administrators; usable by every workspace).

| Type | Secret (encrypted, write-only) | Format |
|---|---|---|
| `slack` | incoming-webhook URL (`hooks.slack.com`) | Block Kit: header, text, fields, snapshot image, "Open in DuckView" button, context |
| `teams` | Workflows / incoming-webhook URL (`*.webhook.office.com`, `*.logic.azure.com`, Power Platform / Power Automate) | Adaptive Card 1.4 |
| `email` | — (recipients in `config.to`) | HTML + text through the server's SMTP settings; a snapshot inline (cid), attachments |
| `pagerduty` | Events API v2 integration key | `trigger` / `resolve` with `dedup_key`, links and images (`notifications.pagerduty_url` for EU accounts) |
| `webhook` | URL, and a signing secret (generated when absent, shown **once**) | JSON `{event, delivery, sent_at, title, text, severity, url, fields, dedup_key, workspace, image}`; `X-DuckView-Signature: sha256=HMAC(secret, "<X-DuckView-Timestamp>.<body>")`, `X-DuckView-Event`, `X-DuckView-Delivery` |

The API returns a masked hint instead of any secret. Every URL is called through the egress guard (`security/egress.ts`): https only, and the name must resolve to a public address — loopback, private, link-local (cloud metadata), CGNAT, multicast and reserved ranges are refused — checked inside the connection's own DNS lookup, so there is no rebinding window; `notifications.allow_private_targets` lifts this for intranet endpoints. Redirects are not followed. A delivery is retried twice on network errors, 429 and 5xx (not on 4xx or policy refusals); each series is logged (`GET /api/channels/:id/deliveries`, a month kept) and sets the channel's `last_status` / `last_error`. `POST /api/channels/:id/test` sends a test message.

**SQL alerts** (`#/alerts/alerts`, `services/alerts.ts`): a query of the workspace, a condition and a schedule (`{kind: "interval", minutes}`, `{kind: "cron", expression, timezone}` or `manual`). Conditions: `{kind: "rows"}` (it returns rows), `{kind: "no_rows"}` (it returns none — freshness checks), `{kind: "threshold", column, op, value}` (the first row's column, `> >= < <= = !=`). The query is one read-only statement (refused when saved otherwise) and runs as the alert's author with the `read` scope only (whoever changes the SQL becomes the author), returning at most `notifications.alert_max_rows` rows. Each check sets `state` — `ok`, `triggered` or `error` (`unknown` before the first) — and `last_value`; what is delivered to the alert's `channel_ids` (the workspace's channels or org-wide ones):

| From → to | Delivered | Event · severity |
|---|---|---|
| anything → `triggered` | always (and on every triggered check with `notify: "always"`) | `alert.triggered` · the alert's `severity` (`info`, `warning`, `critical`) |
| `triggered` → `ok` | when `notify_resolved` (default) | `alert.resolved` · `resolved` (PagerDuty resolves the incident) |
| anything else → `error` | once | `alert.error` · `warning` |

Messages carry the description, what the check found (a sample of up to 5 rows for `rows`), the condition, value, workspace and a link, with `dedup_key: duckview-alert-<id>`. The scheduler (`notifications.scheduler_enabled`, every 30 s) checks due alerts and moves `next_run_at` first; a changed query or condition resets the state. Checks are recorded (`GET /api/alerts/:id/events`, 90 days) when the state changes, something was delivered, or a person ran it; live events `{type: "alert"}` refresh open pages. API: `GET/POST /api/workspaces/:id/alerts` · `POST /api/workspaces/:id/alerts/preview {sql, condition}` (runs once as the caller, saves and sends nothing) · `GET/PATCH/DELETE /api/alerts/:id` · `POST /api/alerts/:id/run` (editors). Agents: `list_alerts`, `create_alert` (tries the query first), `run_alert`.

**Scheduled snapshots** (`#/alerts/snapshots`, `services/snapshots.ts`): a dashboard (grid or Mosaic) or a data app rendered by a headless browser on a schedule (cron — default `0 8 * * 1-5` — or every ≥ 15 minutes, or by hand), as a PNG or a PDF (a PNG is always kept too), `width` 640–2400 px, and delivered to channels. A dashboard is rendered by DuckView's own UI at `#/snapshot/dashboard/<id>` (the dashboard alone; `<html data-snapshot>` reports loading → loaded / ready / error) signed in as the snapshot's owner with a five-minute session that never leaves the server; the renderer waits for that state, for the network to go quiet and for fonts, then captures the full page. An app is rendered on its own origin with the app cookie (a server app is started first). One render runs at a time; `notifications.snapshot_timeout_seconds` bounds each. Files live in `<data>/.duckview/snapshots/<id>/` for `notifications.snapshot_retention_days`.

| Channel | What arrives |
|---|---|
| email | the PNG inline, the PDF attached |
| webhook | `image` (base64 + link) and `attachments` (the PDF, base64) |
| Slack · Teams · PagerDuty | the image through a signed link — `GET /api/snapshot-files/<run>/png?exp=…&sig=…`, HMAC with the server secret, valid `notifications.snapshot_link_days` — which needs `server.public_url` reachable from them; the PDF as a link in the text |

A render that fails is delivered as `snapshot.failed` with the reason (e.g. no browser). The server image ships Chromium (`CHROME_PATH`, run without its sandbox — `CHROME_NO_SANDBOX=1` — as containers cannot provide one; `--build-arg WITH_BROWSER=false` leaves it out). API: `GET/POST /api/workspaces/:id/snapshots` · `GET/PATCH/DELETE /api/snapshots/:id` · `POST /api/snapshots/:id/run` · `GET /api/snapshots/:id/runs` · `GET /api/snapshots/:id/runs/:run/file`. Agents: `snapshot_dashboard(dashboard_id | app_id)` returns the picture without saving or sending it.

**Outgoing mail**: Settings → Integrations → Outgoing mail (`GET/PUT/DELETE /api/admin/integrations/smtp`, `POST …/smtp/test {to}`) — host, port, TLS or STARTTLS, user, password (encrypted, write-only), from — overrides `notifications.smtp` in the configuration. Links in messages use `server.public_url`.

## Transformations: dbt

**dbt projects** (`#/transform/dbt`, `services/dbt.ts`, `routes/transform.ts`) — a workspace keeps dbt projects (their files: `dbt_project.yml`, models, seeds, macros, tests, YAML, `packages.yml`) and runs them in its own engine. Start from the starter project (a seed, a staging view, a table on top, descriptions and data tests) or **import a project folder** (`target/`, `dbt_packages/` and `profiles.yml` are left out; DuckView writes the profile). Editors edit, run and schedule; viewers see projects and runs and may compile.

How a run works. The workspace's DuckDB file is held by DuckView's engine, so dbt never opens it. Instead:
1. the project is written to `<data dir>/.duckview/dbt/projects/<id>/project` (dbt's `dbt_packages` and partial-parse state are kept between runs) with a `profiles.yml` pointing **dbt-duckdb** at a *shadow* database — empty tables with the workspace's schemas, tables and columns, so `is_incremental()`, `adapter.get_columns_in_relation()`, `dbt_utils.star()` and other introspection see the real structure — with `enable_external_access = false` and the configuration locked;
2. `dbt deps` (when there are packages and `transform.dbt.allow_packages`) and `dbt compile` with the selection (`--select`, `--exclude`, `--full-refresh`, the project's `--vars`) run in a scrubbed environment: no server variable reaches `env_var()`;
3. DuckView reads `target/manifest.json` and `run_results.json`, puts the workspace's catalog in place of the shadow's in the compiled SQL, and executes the selected nodes in dependency order **through the QueryService as the person running it** — the SQL guard, access policies, the audit log and the data epoch all apply: **seeds** (`read_csv` of the CSV, with `column_types` and `delimiter`), **models** — `view`, `table`, `incremental` (append, or delete + insert on `unique_key`; `--full-refresh` rebuilds), `ephemeral` (inlined by dbt) — with pre/post hooks that carry no Jinja, and **data tests** (dbt's compiled test query, `fail_calc`, `severity`, `warn_if` / `error_if`). As in `dbt build`, a node waits for the tests of the models it reads, and a failure skips everything downstream. A model switching between view and table is dropped first.

Commands: `build` (seeds, models, tests), `run`, `test`, `seed`, `compile` (nothing executed; each node's compiled SQL is shown). Each node's result carries its status (`success` · `error` · `skipped` for models and seeds; `pass` · `warn` · `fail` · `error` · `skipped` for tests), rows built, failing rows, time, message and compiled SQL; the run keeps dbt's log. After a run, **descriptions and tags** from the project's YAML become catalog notes (Copilot and `inspect_schema` read them), and **lineage** shows the project building its models and seeds (the union of recent runs), each reading its upstream models and sources. One run per project at a time; runs are announced on the live feed (`dbt` events).

**Schedules**: manually, every N minutes (≥ 5) or cron (UTC), with the command and selection to run; scheduled runs run as the project's creator (not if they have been deactivated) under `transform.scheduler_enabled`.

**Runtime**: dbt Core and dbt-duckdb are installed with pip into a virtualenv (`transform.dbt.venv_dir`, default `<data dir>/.duckview/dbt/venv`, from `transform.dbt.python`) on the first run, or ahead of time by an administrator (**Install now**, `POST /api/admin/dbt/install`); `transform.dbt.package` pins the requirement (`dbt-duckdb==1.9.4`). The Docker image has Python and venv; the first install needs network. Not run (yet): snapshots, Python models, hooks with Jinja, unit tests, custom materializations, `on-run-start` / `on-run-end`.

**Where analysts meet it.** Besides Transform → dbt: the Query workbench's **dbt model** button saves the tab's SELECT as a model (pick or create the project, name, folder, view / table / incremental, description, build now) — references to the project's own models and seeds become `ref()` (`POST /api/dbt/projects/:id/models`); a project card's **Build** runs it. **DuckCopilot** knows the workspace's projects (models, how they are built, the last run and what failed are in its context; the dbt guide joins the prompt when dbt is mentioned), writes models as SQL blocks headed `-- dbt model: models/<folder>/<name>.sql` that **Add to dbt project** saves and builds, and **Ask Copilot** on a failed run sends the error, the failing nodes and their files for a fix.

**Agents** (MCP and the REST façade) get `list_dbt_projects`, `get_dbt_project`, `create_dbt_project`, `write_dbt_files`, `create_dbt_model`, `run_dbt`, `get_dbt_run`, the resource `duckdb://guides/dbt` and the prompt `build_dbt_models`. Building creates tables, so an agent's build / run / seed first gets an approval challenge — computed from a compile of the same selection, listing each relation and whether it becomes a view, a table or an insert — and runs only when repeated with `dry_run: false` (the same human-in-the-loop rule as mutating SQL; an agent token calling `POST /api/dbt/projects/:id/runs` gets `409 APPROVAL_REQUIRED` with the challenge). Compile and test run straight away.

API: `GET /api/dbt/status` · `POST /api/admin/dbt/install` · `PATCH /api/dbt/projects/:id/files {files: {path: content | null}}` · `POST /api/dbt/projects/:id/models {name, sql, folder?, materialized?, unique_key?, description?, overwrite?}` · `GET/POST /api/workspaces/:id/dbt/projects` · `GET/PATCH/DELETE /api/dbt/projects/:id` (`{name, files, vars, target_schema, schedule, scheduled: {command, select, exclude, full_refresh}, enabled}`) · `POST /api/dbt/projects/:id/runs {command, select?, exclude?, full_refresh?, wait?}` · `GET /api/dbt/projects/:id/runs` · `GET /api/dbt/runs/:id` (log and node results). Audit: `dbt.project_create` · `dbt.project_update` · `dbt.project_delete` · `dbt.run` · `catalog.import`.

## Semantic layer (metrics)

**Metrics defined once** (`#/transform/metrics`, `services/semantic.ts`): the workspace's definitions, from hand-written YAML (editors, Transform → Metrics → Definitions) and from every dbt project that declares `semantic_models` and `metrics` (read from dbt's `target/semantic_manifest.json` after each run, removed with the project; the hand-written YAML wins a name clash). The shape is dbt's MetricFlow spec, so definitions move between the two:

```yaml
semantic_models:
  - name: orders
    table: orders                 # or sql: "select …", or model: ref('orders')
    default_time_dimension: order_date
    entities:                     # keys; a foreign entity joins to the model where it is primary / unique / natural
      - { name: order, type: primary, expr: order_id }
      - { name: customer, type: foreign, expr: customer_id }
    dimensions:
      - { name: order_date, type: time, granularity: day }
      - { name: region, type: categorical }
      - { name: size, type: categorical, expr: "case when amount >= 100 then 'large' else 'small' end" }
    measures:                     # sum · count · count_distinct · avg · min · max · median · sum_boolean
      - { name: revenue, agg: sum, expr: amount }
      - { name: order_count, agg: count }
metrics:
  - { name: total_revenue, label: Revenue, type: simple, measure: revenue, filter: "{{ Dimension('order__status') }} = 'complete'" }
  - { name: orders, type: simple, measure: order_count }
  - { name: aov, type: ratio, numerator: total_revenue, denominator: orders }
  - { name: revenue_k, type: derived, expr: rev / 1000, metrics: [{ name: total_revenue, alias: rev }] }
```

**A query** — `metrics`, `group_by`, `where`, `order_by`, `limit` — compiles to one SELECT. Group by a dimension (`region`), a time grain (`order_date__month`, or `metric_time__month` for each metric's own time dimension; hour · day · week · month · quarter · year), or a dimension of another semantic model reached through an entity (`customer__tier`; many-to-one joins only, so nothing fans out). Filters are structured (`{dimension, op, value}` with `=`, `!=`, `>`, `>=`, `<`, `<=`, `in`, `not in`, `between`, `like`, `is null`, `is not null`) or SQL with `{{ Dimension('x') }}` / `{{ TimeDimension('x', 'month') }}` templates. Each semantic model becomes a CTE that aggregates its measures at the requested grain (a metric's filter as `FILTER (WHERE …)`); metrics from several models are full-outer-joined on the dimensions; ratios (`NULLIF` on the denominator) and derived metrics are computed on top. It runs through the QueryService as the caller — SQL guard, **access policies**, result cache and audit apply.

**Saving validates**: the YAML parses, every semantic model binds and every metric compiles and binds against the engine (together with the imported definitions); problems are listed per model and metric. **Scaffold from table** drafts a semantic model — entities from `id` / `*_id` columns, time dimensions from dates and timestamps, categorical dimensions from the rest, a count and a sum per number, with metrics for each.

**Where it is used**: the Metrics explorer (pick metrics, group-by dimensions with a grain, filters → chart, table, the SQL, *Open in Query*); agents over MCP / REST (`list_metrics`, `query_metrics`; dbt semantic YAML through `write_dbt_files`); DuckCopilot, whose context lists each metric with its definition and dimensions ("compute these exactly as defined").

API: `GET/PUT /api/workspaces/:id/semantic {yaml, force?}` · `POST /api/workspaces/:id/semantic/validate {yaml}` · `POST /api/workspaces/:id/semantic/query {metrics, group_by?, where?, where_sql?, order_by?, limit?, compile_only?}` · `GET /api/workspaces/:id/semantic/dimensions?metrics=` · `POST /api/workspaces/:id/semantic/scaffold {table}`. Audit: `semantic.update`.

## Data quality

**Checks on tables** (`#/transform/quality`, Data › Quality, `services/quality.ts`). A suite is a table (`orders`, `schema.table` or `database.schema.table`) and its checks — dbt's generic tests and a few more:

| Check | Fails on |
|---|---|
| `not_null` (column) | rows where the column is null |
| `unique` (column) | values that appear more than once (counted per value, like dbt) |
| `accepted_values` (column, values) | rows with any other value (nulls allowed) |
| `range` (column, min and/or max) | rows outside the bounds |
| `relationships` (column, to, to_column) | values with no match in the other table |
| `expression` (a condition) | rows where it is false or null |
| `row_count` (min and/or max) | a table with too few or too many rows |
| `freshness` (column, max_age_hours) | a newest value older than that (naive timestamps read in the server's time zone) |
| `custom_sql` (a SELECT) | any row it returns; `{{ table }}` is the suite's table |

Each check can be limited to rows matching `where`, allow a `tolerance` of failing rows, and has a severity — `error` fails the suite, `warn` warns. Every check compiles to one SELECT of the failing rows, so a failing check shows a sample and opens in the workbench as is. A suite's status is its worst outcome: error (a check could not run) › fail › warn › pass.

**Suggest** profiles the table and proposes checks it passes today: at least one row, `not_null` for complete columns, `unique` for its own key (`id`, or `order_id` on `orders` / `stg_orders`), `accepted_values` for small text categories, `range ≥ 0` (warn) for amounts, prices, counts and durations, and `relationships` for `x_id` columns whose table exists (the same prefix preferred). **Test** runs the checks as you without saving.

**Running**: by hand (editors), from agents, or on a schedule (every N ≥ 5 minutes or cron; the transform scheduler). A suite runs as its author with the read scope only, every statement checked to be one SELECT; access policies apply as for the author. Each run is kept 90 days. When the status changes the suite's notification channels are told (`quality.fail` · `quality.warn` · `quality.error`, with the failing checks), and again when it passes (`quality.resolved`).

**Where it shows**: the Data explorer's dataset header (checks failing / passing, linking to the suite); the latest **dbt test** results of each dbt project alongside the suites; DuckCopilot's context (each suite's status and failing checks); agents over MCP / REST — `list_quality_suites`, `suggest_quality_checks`, `create_quality_suite` (without checks: the suggestions, saved and run once), `run_quality_suite`; the `data_quality_audit` prompt ends by offering to keep its findings as checks.

API: `GET/POST /api/workspaces/:id/quality/suites` (the list includes `dbt_tests`) · `POST /api/workspaces/:id/quality/preview {relation, checks}` · `POST /api/workspaces/:id/quality/suggest {relation}` · `GET/PATCH/DELETE /api/quality/suites/:id` (GET includes the latest run) · `POST /api/quality/suites/:id/run` · `GET /api/quality/suites/:id/runs` · `GET /api/quality/runs/:id`. Audit: `quality.create`, `quality.update`, `quality.delete`. Live event: `quality`.


## Reverse ETL

**Query results sent out of a workspace** (Connections › Reverse ETL, `services/reverse-etl.ts`) — by hand, from agents, or on a schedule. A reverse sync is one read-only SELECT, a destination and a mode:

| Destination | What happens |
|---|---|
| **Database table** — a Postgres, MySQL or SQLite connection of yours with *read-only* turned off | The table is created from the result when missing. DuckDB files are not a destination: they take one writer at a time, and the workspace engines may have them attached. |
| **Files** — Parquet, CSV or JSON, in the data directory or a cloud bucket (S3, R2, GCS, Azure) | *replace* overwrites the file; *append* writes a new file per run (`{date}` / `{run}` in the path, or a timestamp before the extension). |
| **HTTP API** — JSON POSTed in batches (`batch_size`, default 500) | Body `object` (`{sync, sync_id, run_id, mode, op: upsert\|delete, batch, batches, rows}`), `array` or `ndjson`; headers (Authorization, API keys) stored encrypted and never returned; an `Idempotency-Key` per batch; any non-2xx fails the run. |

| Mode | Sends |
|---|---|
| `replace` | the whole result; the destination holds exactly it |
| `append` | the whole result, added |
| `upsert` | rows new or changed since the last successful run, matched on `key_columns` (deleted and re-inserted by key in a database) |
| `mirror` | upsert, plus the keys that disappeared: deleted from the table, or sent as `op: "delete"` batches (`_deleted: true` for array / ndjson) |

**How a run works**: the query runs as the sync's author through the workspace engine — read-only, with their access policies (row filters, masks) — and is staged as Parquet; a scratch DuckDB instance attaches the destination and delivers it. Change detection keeps the keys and a hash of every row delivered (`.duckview/reverse/<id>/state.parquet`), replaced only after a successful delivery, so a failed run is retried in full next time (at-least-once for APIs). Keys must be unique and not null. Changing the query, destination, mode or keys starts change detection over, and whoever edits them becomes who it runs as (their connections must fit). Runs are kept 90 days; a failing run, and the first success after it, go to the sync's notification channels (`reverse_sync.failed` / `reverse_sync.recovered`). **Preview next run** shows how many rows would be sent and deleted, with a sample, without sending anything.

**From the workbench**: ⋯ → *Send results to…* opens a new reverse sync with the tab's SQL. **Agents** (`list_reverse_syncs`, `create_reverse_sync`, `run_reverse_sync`): data leaving the workspace needs approval — the first `run_reverse_sync` returns a challenge (rows, deletions, destination) and runs only when repeated with `dry_run: false`; a sync an agent creates has no schedule until a person sets one. DuckView AI's context lists the workspace's reverse syncs.

API: `GET/POST /api/workspaces/:id/reverse-syncs` · `GET/PATCH/DELETE /api/reverse-syncs/:id` · `GET /api/reverse-syncs/:id/plan` · `POST /api/reverse-syncs/:id/run {dry_run?}` (agent tokens: 409 `APPROVAL_REQUIRED`) · `GET /api/reverse-syncs/:id/runs`. Audit: `reverse_sync.create`, `.update`, `.delete`, `.run`. Live event: `reverse_sync`. HTTP targets follow `notifications.allow_private_targets` (https and public addresses only, unless set).


## Notebooks

**Analyses as a sequence of cells** (SQL › Notebooks, `#/notebooks/<id>`, `services/notebooks.ts`): Markdown text, **inputs** and **SQL**.

- **Cells build on each other.** Every SQL cell has a name (`df1`, `monthly`); a later cell that mentions it reads its result — `SELECT * FROM monthly WHERE revenue > 1000`. The earlier cell is added as a CTE (recursively, in dependency order), so nothing is materialised and every run is one query through the QueryService as the person running it: SQL guard, access policies, result cache and audit apply. Only cells above can be referenced; mentions inside strings, comments, quoted identifiers or after a dot (`t.monthly`) are not references. A cell that reads others must be one read-only query; cells that write (CREATE TABLE AS, INSERT) run on their own.
- **Inputs are variables.** An input cell (text, number, date or a list of options) named `region` is used as `{{ region }}` and becomes a SQL literal — numbers as numbers, dates as `DATE '…'`, everything else quoted — never raw SQL.
- **Outputs are saved** with the notebook (the first 500 rows, the row count, who ran it and when) when an editor runs a cell, so viewers, exports and agents see results without re-running. Viewers can change inputs and run cells for themselves; their outputs are not saved. A cell shows its result as a table or a chart (the workbench's chart settings).
- **Saving** is automatic (under a second after typing). Each save carries the version it started from; if someone else saved in between, the save is refused with who it was, and the notebook offers to reload their version — nobody's work is silently overwritten.
- **Run all** runs the SQL cells top to bottom and stops at the first error. ⌘/Ctrl+Enter runs the focused cell. Autocomplete knows the workspace's tables and the cells above with their columns.
- **Export as Markdown**: text cells as they are, SQL in fenced blocks, outputs as tables (first 20 rows), errors as quotes.
- **DuckView AI** sees the open notebook (cells, names, inputs, output columns) and writes SQL that fits it; *Add as cell* puts its SQL in a new cell below the focused one, *Run & inspect* runs it as a cell. **Agents**: `list_notebooks`, `get_notebook`, `create_notebook` (cells in order; runs them by default), `run_notebook`; cells that write need the usual approval (`dry_run: false`).

API: `GET/POST /api/workspaces/:id/notebooks` · `GET/PATCH/DELETE /api/notebooks/:id` (`PATCH {title?, cells?, version}` → 409 with `details.version` when stale) · `POST /api/notebooks/:id/cells/:cell/run {cells?, dry_run?}` · `POST /api/notebooks/:id/cells/:cell/compile` · `POST /api/notebooks/:id/run` · `GET /api/notebooks/:id/export.md`. Audit: `notebook.create`, `notebook.delete`, `notebook.run`.


## Comments & mentions

**Conversations next to the data** (`services/comments.ts`). A thread is a first comment on something in a workspace and its replies: a **notebook** (the whole notebook or one cell — cells show their open-thread count), a **dashboard** (grid or Mosaic), a **table** (from the Data explorer's dataset header), a saved query or a data app (API and agents).

- **Who**: anyone who can see the workspace comments, viewers included. People edit and delete their own comments; the owner deletes any; editors and the thread's author resolve and reopen threads (a new reply reopens a resolved one). Deleting a thread deletes its replies.
- **Mentions**: type `@` and pick a person — the comment stores `@their@email` and shows their name. Only people with access to the workspace (the owner, members, members of teams it is shared with; not deactivated users) can be mentioned; anything else stays plain text. A mention puts an item in their **inbox** and, when a mail server is set up (Settings → Integrations → SMTP), sends an email with a link to the thread. Everyone already in a thread gets an inbox item for each reply. Editing a comment to mention someone new tells them too.
- **Inbox**: the bell in the top bar — unread count (live), newest first, *Mark all read*; opening an item switches to its workspace, marks it read and lands on the thread (`?comment=<thread>`). Items from workspaces you no longer have access to disappear.
- **DuckView AI** sees a notebook's open threads alongside its cells; **agents**: `list_comments`, `add_comment` (mentions work the same way).

API: `GET /api/workspaces/:id/comments?target_type=notebook|dashboard|query|app|table&target_id=&anchor=` (threads with replies, `open`, `by_anchor`) · `POST /api/workspaces/:id/comments {target_type, target_id, anchor?, body}` or `{parent_id, body}` to reply · `PATCH /api/comments/:id {body}` · `POST /api/comments/:id/resolve {resolved}` · `DELETE /api/comments/:id` · `GET /api/workspaces/:id/people` · `GET /api/inbox?unread=` · `POST /api/inbox/read {ids | all}`. Audit: `comment.create`, `comment.delete`. Live events: `comment` (workspace members), `inbox` (the person).


## Version history

**Every save is kept** (`services/revisions.ts`) for notebooks, dashboards (grid layouts and widgets, or Mosaic specs), saved queries, the semantic layer's YAML and dbt projects. Saves by the same person within ten minutes update their latest version instead of adding one, so autosave and quick edits read as one step; another person's save, a named version, a restore or more than ten minutes start a new one, and nothing identical is stored twice. The latest 200 versions of each object are kept, named ones always; deleting an object deletes its history.

**History** (the clock button in a notebook's or dashboard's header, *History* in Metrics → Definitions and on a dbt project, the clock on a saved query in the workbench) lists the versions with who saved them and when. Picking one shows what restoring it would change (a line diff of the SQL, text and YAML against now). **Restore** (editors) writes it back through the owning service — validation, permissions and audit as for any save — and records a new version ("Restored version 3"), after keeping what was there; restoring the newer version undoes it. A dashboard comes back with its widgets under their old ids, so the layout still fits. **Name this version** keeps the current state under a name ("Signed off by finance").

API: `GET /api/workspaces/:id/revisions?object_type=notebook|dashboard|query|semantic|dbt&object_id=` (`semantic` uses `object_id=workspace`) · `POST /api/workspaces/:id/revisions {object_type, object_id, message}` · `GET /api/revisions/:id` (snapshot, `text`, `current`) · `POST /api/revisions/:id/restore`. Audit: `revision.name`, `revision.restore`.


## Git sync

**A workspace's definitions in a Git repository** (Settings → Git, `services/git-sync.ts`), as files people read and review in pull requests:

```
<folder>/notebooks/<title>.yml        title and cells — SQL and text as YAML block scalars
<folder>/queries/<folder>/<name>.sql  the SQL; id, name, folder, description and tags in a header comment
<folder>/dashboards/<name>.yml        layout and widgets (with their SQL), or the Mosaic spec
<folder>/metrics/semantic.yml         the semantic layer's hand-written YAML
<folder>/dbt/<project>/…              the project's files, and duckview.yml (id, vars, target schema)
```

- **Connect** (workspace owners): an `https://` repository, a branch (created on the first push when missing), an optional folder, and an access token with read/write access to contents (GitHub, GitLab, Bitbucket, Azure DevOps…). The token is stored encrypted and sent only as an `Authorization` header for that one git command — never written to disk or git config, and scrubbed from errors. `git.allow_local_repos: true` also accepts local paths and `file://` (tests; a repository on the same machine).
- **Push** (editors) writes those folders from the workspace — other files in the repository are left alone — commits as the person pushing (with their message) and pushes. The page lists what would change first. A push is refused while the repository has commits this workspace has not pulled, so nobody's work is overwritten.
- **Pull** (editors) brings in what changed in the repository since the last push or pull: each changed file updates its object through the owning service (validation, permissions, audit) and is recorded in its version history as "Pulled from Git <sha>"; a file for something this workspace does not have creates it. Files nobody changed upstream are left alone, so local edits that were not pushed yet survive. An object changed on both sides takes the repository's version and is reported as a conflict — the local version is in its history, one click from being restored. Files deleted in the repository, and objects only in this workspace, are listed, never deleted. Objects are matched by the id in the file, else by the file's path in this workspace, so several workspaces (dev and prod) can share one repository without duplicates.
- git runs with a throwaway HOME, no prompts, no system config and hooks disabled, with `git.timeout_seconds` per command (`git.binary`, default `git`; the Docker image includes it).

API: `GET/PUT/DELETE /api/workspaces/:id/git` (`PUT {repo_url, branch?, path?, token?}`) · `GET /api/workspaces/:id/git/status` · `POST /api/workspaces/:id/git/push {message?}` (409 when a pull is needed) · `POST /api/workspaces/:id/git/pull` → `{created, updated, unchanged, conflicts, deleted_upstream, only_in_workspace, errors}`. Audit: `git.configure`, `git.disconnect`, `git.push`, `git.pull`.


## Signed embeds

**A dashboard or notebook inside your own application** (Settings → Embedding, `services/embeds.ts`), with no DuckView login for its viewers.

1. A workspace owner creates an **embed key** — its secret is shown once — and optionally the sites allowed to frame it (origins; the page sends `Content-Security-Policy: frame-ancestors …`, and without a valid token `X-Frame-Options: DENY`).
2. For each page view, your **server** signs an HS256 token with the key's secret (header `kid` = the key id):
   `{ "res": "dashboard:<id>" | "notebook:<id>", "sub": "<your user>", "iat": …, "exp": …, "attrs": { "tenant": "acme" }, "params": { "region": "EU" }, "theme": "light" | "dark" }` — at most 7 days between `iat` and `exp`. Settings → Embedding shows a Node.js and a Python function that does it.
3. The iframe loads `https://<duckview>/embed/view?token=<token>`.

**What an embed can do**: load that one object — a grid dashboard's widgets, or a notebook's cells run live — and nothing else: no other object, no SQL of its own, no other API (the token is not a session). Every request is checked again (signature, expiry, key not revoked, its creator still active with access, the object in the key's workspace), so revoking a key stops all its embeds at once. Queries run as the key's creator with the read scope only. A notebook's SQL is not shown, its inputs take the token's `params`, and nothing it runs is saved. Mosaic dashboards cannot be embedded yet.

**Rows per viewer**: an access policy that applies to **embeds** (the *embeds* box in Data → Access policies, `applies_to: { embeds: true }`) filters and masks what embeds see; the token's attributes are `{{embed.<name>}}` in its row filter — `tenant = {{embed.tenant}}` shows each customer their own rows. An attribute the token does not carry is NULL, so such a filter shows nothing. When several policies apply to someone on one table, all of them apply: filters are AND-ed and the strictest mask wins.

API (owners): `GET/POST /api/workspaces/:id/embed/keys` (`POST {name, allowed_origins?}` → `{key, secret}`) · `PATCH/DELETE /api/embed/keys/:id` · `POST /api/workspaces/:id/embed/sign {key_id, resource_type, resource_id, sub?, attrs?, params?, expires_in?, theme?}` → `{token, url}`. The embed (token as `Authorization: Embed <token>` or `?token=`): `GET /api/embed/view` · `POST /api/embed/widgets/:wid/data` · `POST /api/embed/notebook/cells/:cell/run`. Audit: `embed.key_create`, `embed.key_revoke`, `embed.view`.


## DuckView AI builds dashboards and apps

**Ask for a dashboard or an app and get one** (`services/builder.ts`). "Build me a sales dashboard", "make a data app to explore orders by region" — DuckView AI answers with a short outline and a **build plan** (a ```` ```duckview-build ```` YAML block):

```yaml
build: dashboard            # or app (Streamlit, one section per item)
name: Sales overview
items:
  - { title: Revenue, kind: kpi, sql: "SELECT sum(amount) AS revenue FROM orders", format: currency }
  - { title: Revenue by month, kind: chart, chart: line, sql: "…", x: month, y: [revenue] }
  - { title: Latest orders, kind: table, sql: "… LIMIT 100" }
  - { title: Notes, kind: text, text: "Amounts in EUR." }
```

Before you see it, DuckView **runs every item's query** as you (read-only, a few rows, your access policies) and checks the columns a chart or KPI names. The reply shows a card: each item with ✓ and its row count, or the error; **Create dashboard** (or *Create app*) builds what works — KPIs in a row, charts two by two, tables and notes full width — and opens it; **Fix with AI** sends the failures back for a corrected plan. Requests that mention Mosaic, cross-filtering or brushing still get an interactive Mosaic spec.

**Agents** build in one call with `build_dashboard` (`name`, `build`, `items`; `check_only` to test first); items that fail are skipped and reported. API: `POST /api/workspaces/:id/build/check {plan}` · `POST /api/workspaces/:id/build {plan}` (the plan as YAML text or an object).

## Questions answered from metrics

**When a workspace has metric definitions, DuckView AI answers questions with them** (`services/copilot.ts`). Rather than writing SQL for "what was revenue by region last quarter?", it answers with a ```` ```duckview-metric ```` block — a query against the semantic layer:

```yaml
title: Revenue by region
metrics: [total_revenue]
group_by: [region]              # dimensions, metric_time__month (day … year), joined: <entity>__<dimension>
where: [{ dimension: channel, op: "=", value: web }]
order_by: [{ name: total_revenue, desc: true }]
limit: 10
```

The server computes each block with the semantic layer, exactly as the metrics are defined and under the asker's access policies. The reply shows a card with the numbers: one value, or a chart and a table. From the card you can **Open in Metrics** (the explorer filled in with the same query), **Add to dashboard** (a chart or KPI widget with the compiled SQL) or see the SQL. A metric or dimension that does not exist shows as an error on the card, never as a wrong number. The guide is only in the prompt when the workspace has metrics, and not for fixes or dashboard specs.

**Ask in the Metrics explorer.** Transform → Metrics has a question box. `POST /api/workspaces/:id/semantic/ask {question}` (optional `provider`, `model`, `api_key`, `base_url`, `region` for BYOK) makes one model call with the metric and dimension list. It returns `{query, title, explanation, unanswerable}`: a query that has already compiled, or the reason the metrics cannot answer. The explorer applies the query to its controls and computes it.

## Automated insights

**DuckView watches metrics for unusual values and says what drove the change** (`services/insights.ts`). The engine computes a metric per day, week or month through the semantic layer, as the person who asked (read-only, under their access policies). It then compares the **latest complete period** with the periods before it (`lookback`, default 28). The period that is still running is left out.

- **Usual value:** the median of those periods. For daily numbers with three weeks of history, it is the median of the same weekday, so quiet weekends are not flagged.
- **Usual spread:** the median absolute deviation, scaled to a standard deviation. When the history is constant, the standard deviation is used instead.
- **Unusual:** further from usual than `sensitivity` spreads (default 3).
- **Days without rows:** a sum or count is zero on those days, so a day with no orders shows up.

With **`segment_by`** (a dimension such as `region`), each change is explained by the segments that moved the most in the same direction, with their share of the change: *"Revenue was 120 on Mon, Mar 9, 2026 — 60% below the usual 300 (usual range 244–356). Most of the drop came from region = EU (−180, 100% of the change)."* The largest segments (up to 12) are also watched on their own.

**Transform → Metrics → Monitors** has three parts:

- **Check all metrics:** checks every metric with a time dimension now and saves nothing.
- **Monitors:** metric, period, explain-by dimension, how big a change to flag, a schedule, and notification channels. Each unusual period is recorded once as an **insight**, overall or per segment, and delivered to the channels.
- **Found by monitors:** the insights, each with a chart of the series and its usual range, the segments that drove it, *Open in Metrics*, *Ask AI why* (DuckView AI breaks the metric down with metric queries) and *Dismiss*.

Recent insights also appear on **Home** under *What changed*, and in DuckView AI's context.

API:

- `POST /api/workspaces/:id/insights/scan {metrics?, grain?, sensitivity?, segment_by?}`
- `GET /api/workspaces/:id/insights?status=new|dismissed|all`
- `PATCH /api/insights/:id {status}`
- `GET/POST /api/workspaces/:id/monitors`
- `PATCH/DELETE /api/monitors/:id`
- `POST /api/monitors/:id/run`

Agents: `detect_anomalies`, `list_insights`, `create_metric_monitor` (with `run_now`).

## DuckView agents and the agent marketplace

**Agents that DuckView runs itself** (`services/hosted-agents.ts`, AI → DuckView agents). A hosted agent has instructions, a task for scheduled runs, the tools it may use, a limit on tool calls per run, a schedule and channels for its reports.

The **marketplace** (`agent/templates.ts`, `GET /api/agent-templates`) has ready-made agents, installed into a workspace with one click and editable afterwards:

| Agent | Does | Default schedule |
| --- | --- | --- |
| Anomaly investigator | finds unusual metrics and breaks each change down | every morning |
| Weekly business review | the headline metrics for last week against the week before and the 4-week average | Mondays |
| Data quality auditor | failing checks, important tables without checks, the checks to add | every morning |
| Pipeline watcher | failed syncs, dbt runs, quality checks, alerts and reverse syncs | every morning |
| Catalog writer | table and column descriptions drafted from profiles | when asked |
| dbt reviewer | failing models and tests, slow models, models without tests or docs | Mondays |
| Data analyst | answers questions with the metrics or SQL | when asked |

**How a run works.** A run is a loop over the model that works with every provider DuckView supports:

1. The model gets the instructions and a list of its tools with their arguments.
2. It asks for one tool at a time with a fenced block:

   ````
   ```tool
   {"name": "execute_query", "arguments": {"sql": "SELECT …"}}
   ```
   ````

3. DuckView runs the tool from the same registry as MCP and sends the result back.
4. A reply without a tool block is the answer.

When the tool-call limit is reached, the agent is asked to answer with what it has.

- **Safety:** hosted agents get **read-only tools only**, plus `execute_query`, which runs read-only. A run acts as the agent's owner with the read scope only, is pinned to the agent's workspace (a `workspace_id` in the arguments is ignored), and runs under the owner's access policies.
- **Model:** scheduled runs use the server's model. A person who starts a run may use their own key when personal keys are allowed; it is used for that run only and never stored.
- **Records:** every step is kept (tool, arguments, a one-line result), along with the answer, the model and the tokens used. A report from a scheduled or manual run goes to the agent's channels.

API:

- `GET/POST /api/workspaces/:id/hosted-agents` (`{template}` installs one)
- `GET/PATCH/DELETE /api/hosted-agents/:id`
- `POST /api/hosted-agents/:id/run {input?, wait?}`
- `GET /api/hosted-agent-runs/:id`
- `GET /api/hosted-agent-tools`

## Governance

**Catalog** (`#/governance/catalog`, `services/lineage.ts`): descriptions and tags (lower-case, e.g. `pii`, `finance`) on tables, views and columns, written by editors, read by every member (`GET /api/workspaces/:id/catalog/annotated`, `PUT /api/workspaces/:id/catalog/annotations {object_name, column_name?, description, tags}` — an empty description and no tags removes the note). Copilot's context carries the notes ("trust these over guesses from names"), and `inspect_schema` shows them next to the columns.

**Lineage** (`#/governance/lineage`, `GET /api/workspaces/:id/lineage` → `{nodes, edges}`): built on demand from what DuckView knows — connector connections, URLs, files and database tables **load** tables through syncs; views, saved queries, dashboards (widget SQL, saved queries, Mosaic datasets and `from:` tables), alerts and sync SQL **read** tables and files, found with DuckDB's own parser (joins, subqueries and table functions such as `read_csv('…')` followed, CTE names left out); data apps **mention** known table names in their Python; snapshots **render** dashboards and apps. Picking a table draws only what feeds it and what it feeds.

**OpenLineage**: with `lineage.openlineage_url` (and `openlineage_api_key`, sent as a bearer token) every sync run posts `START` and `COMPLETE` / `FAIL` RunEvents (spec 2-0-2): job `sync.<name>` in `lineage.namespace` (with the SQL facet), the source as input, the table as output with its row count — Marquez, DataHub and OpenMetadata ingest them.

**Access policies** (`#/governance/policies`, `services/policies.ts`) — row- and column-level security per table of a workspace, managed by its owners. A policy names a table or view (`orders`, `sales.orders`, `db.sales.orders`), a **row filter** (a SQL predicate; `{{user.email}}`, `{{user.id}}`, `{{user.role}}` and `{{user.groups}}` — a list of team names — are substituted as literals), **column masks** (`null`, `redact` → `••••`, `hash` → md5, `partial` → all but the last 4 characters replaced, or an `expression`), and whom it applies to (`roles: VIEWER / EDITOR`, `users`, `groups` — teams — or `all`). Owners of the workspace (and administrators in the UI, who act as owners) are never restricted. A policy is validated against the engine when saved (table, columns, filter).

Enforcement sits where every query meets the engine: `WorkspaceService.engine()` hands a person under at least one policy a **guarded engine**. Its SQL entry points parse the statement with DuckDB's own parser (`json_serialize_sql`), replace every reference to a protected table — however it is named or aliased, in joins, subqueries, CTEs and scalar subqueries — with `(SELECT <masked columns> FROM <table> WHERE <filter>)`, and turn the tree back into SQL (`json_deserialize_sql`); the person's own predicates therefore only see permitted rows and masked values. Around that, for people under a policy: only SELECT statements; no data files or table functions (they could read what a table was loaded from) other than `range`, `generate_series` and `unnest`; no views that read a protected table (a view expands inside the engine); no time travel on a protected table; profiles, overviews, inspections, EXPLAIN and exports of a protected table run over the same subquery; any other engine method is refused, so a new code path cannot leak by forgetting a check. Result-cache keys carry the caller's restriction, so restricted and unrestricted results never mix. This covers the SQL workbench, streamed results, dashboards and widgets, Mosaic, Copilot's context, alerts and snapshots (they run as their author), in-browser apps (they read as the viewer) and agents (tokens of the same person). Server-side apps read with their author's token — an app is its author's view of the data.

**Mosaic under a policy**: Mosaic's dataset views, materialised datasets and pre-aggregates are shared objects named by the hash of their SQL, so a restricted person never reads them: their dataset objects are created by the server from the rewritten query under names salted with their restriction (`/api/mosaic/info?workspace_id=` returns `restricted` and the `suffix`) and recorded as theirs, and the browser turns pre-aggregation off for them.

People with unrestricted write access can still copy data into other tables — policies protect tables, not what writers do with them. API: `GET/POST /api/workspaces/:id/policies` · `PATCH/DELETE /api/policies/:id` (owners) · `GET /api/workspaces/:id/policies/mine` (any member: the tables, names and masked columns that apply to them — never the filters) · `POST /api/workspaces/:id/policies/preview {sql, as_user_id}` (owners: the rewritten SQL and the first 100 rows as that member sees them). Audit: `policy.create` · `policy.update` · `policy.delete` · `policy.preview`.

**Audit export** (`#/governance/audit`, administrators; `services/audit-export.ts`): the audit log streamed to **Splunk** (HTTP Event Collector: `<url>/services/collector/event`, `Authorization: Splunk <token>`, optional index / source / sourcetype), **Datadog** Logs (`https://http-intake.logs.<site>/api/v2/logs`, `DD-API-KEY`, tags), **Elasticsearch / OpenSearch** (`<url>/_bulk` with `create` and the event id as `_id`, so a resend is harmless; API key or basic auth; per-item errors fail the batch), a signed **NDJSON webhook**, or gzipped **NDJSON files** in a bucket through one of the administrator's cloud connections (`<prefix>/dt=YYYY-MM-DD/<first event>.ndjson.gz`). Each event: `id, timestamp, action, actor_type, user_id, user_email, resource, status, error, duration_ms, ip, query_text` (unless `include_sql` is off), `source: duckview`, `host`. The audit table is the source of truth: each destination keeps a cursor `(timestamp, id)`, a ticker (`audit_export.interval_seconds`, 10) exports what came after it in order, in batches (`audit_export.batch_size`, 500), only events older than 2 s (rows are written asynchronously); delivery is at least once. A failing destination backs off (10 s doubling to 10 min) with its last error shown, the others carry on; a new one starts from now, or from the beginning with `backfill`. Secrets are encrypted and write-only. API: `GET/POST /api/admin/audit-sinks` · `PATCH/DELETE /api/admin/audit-sinks/:id` · `POST /api/admin/audit-sinks/:id/test` (one synthetic event, the cursor untouched).

**SCIM provisioning** (`#/governance/provisioning`, administrators; `services/scim.ts`, `routes/scim.ts`) — SCIM 2.0 (RFC 7643/7644) at `/scim/v2` for Okta, Entra ID, OneLogin and JumpCloud: `Users` and `Groups` (list with `filter` — `attr eq "value"` clauses joined by `and`: `userName`, `externalId`, `id`, `emails.value`, `displayName` for users; `displayName`, `externalId`, `id`, `members` for groups — `startIndex`/`count` up to 200, `excludedAttributes=members`), get, `POST`, `PUT`, `PATCH` (PatchOp: `add` / `replace` / `remove`, any case, with or without a path, Entra's flattened `name.givenName` and `emails[type eq "work"].value` paths and `"True"`/`"False"` strings, `members[value eq "…"]`), `DELETE`; plus `ServiceProviderConfig`, `ResourceTypes` and `Schemas`. Bodies are `application/scim+json`; errors use the SCIM error schema with `scimType` (`uniqueness`, `invalidFilter`, `invalidValue`, `mutability`). The IdP authenticates with one bearer token: generated in the console (`POST /api/admin/scim/token`, shown once, stored as a SHA-256 hash; `DELETE` revokes; `GET /api/admin/scim` shows the status and base URL) or fixed with `auth.scim.token`. `auth.scim.enabled: false` turns the endpoint off.
- **Users** map to DuckView users: `userName` is the email (it must be an address — otherwise the primary email is used), `displayName` (or `name.formatted`, or given + family name) the display name, `externalId` is kept. A provisioned user has no password and signs in with SSO. `active: false` **deactivates**; `DELETE` deactivates too (`auth.scim.on_delete: deactivate`, the default, keeps the user's workspaces and history) or removes the user for good (`delete`). The last active administrator cannot be deactivated.
- **Groups** map to **teams linked to an IdP group** (`external_id` = the SCIM `externalId`, or `displayName` when the IdP sends none — the value an OIDC `groups` claim carries, so SSO sign-in and SCIM agree). Only linked teams are visible over SCIM. When a pushed group matches a team already linked to it — created at an SSO sign-in, or **pre-linked** by an admin (Settings → Teams → *Identity-provider group*, `POST/PATCH /api/groups {external_id}`) — that team is adopted: renamed to the IdP's name, its id, grants and history kept. Pre-linking lets an admin share workspaces with an IdP group before anyone in it has signed in. Membership follows the IdP (unknown user ids are skipped); members of a group named in `auth.oidc.admin_groups` become administrators (one-way). Deleting a group removes the team and its workspace grants.
- **Deactivation** (SCIM, or Settings → Users → *Deactivate*, `PATCH /api/admin/users/:id {disabled}`) blocks password and SSO sign-in, rejects the user's sign-in sessions and API tokens on the next request (REST, MCP and the WebSocket feeds, which are closed), and stops alerts, snapshots, syncs and server-side apps that run as the user until they are reactivated. Every SCIM change is audited as `SYSTEM` (`scim.user_create` · `scim.user_update` · `scim.user_delete` · `scim.group_create` · `scim.group_update` · `scim.group_delete`); console actions as `admin.user_deactivate` · `admin.user_reactivate` · `admin.scim_token_rotate` · `admin.scim_token_revoke`.

## Overview: the data source bar

The Overview's left panel (`features/overview/DataSourceBar.tsx`) is the workspace's data map in two sections. **Local** lists the data directory, every folder mounted from this computer (read in place, nothing copied — *Add a folder from this computer* opens the server-side folder browser) and the workspace's tables and views; a drop zone uploads files, and **Uploads go to** picks where they land: the data directory or any mounted folder (`PUT /api/workspaces/:id/folders/upload-default {path | null}`; `POST /api/workspaces/:id/files?dir=<absolute folder>` targets a mounted folder explicitly — anything outside the data directory or the mounted folders is refused). **Remote** lists every connection of the user with its health, each browsable in place: object storage (buckets → prefixes → objects), lakehouse catalogs (catalogs → schemas → tables), databases (schemas → tables) and connectors (warehouse databases → schemas → tables, application objects, Drive folders → files, spreadsheets → tabs). Selecting a file, an object or an attached table profiles it; a warehouse table, an application object, a Drive file or a Sheets tab is **imported** — the sync editor opens on the Connections page with the connection and resource filled in. *+ connect* leads to the catalog.

## Persistent workspaces

A workspace's database (`active_db_path`) lives in one of five places:

| Storage | `active_db_path` | Notes |
|---|---|---|
| **Data directory** (default) | `sales.duckdb` | A file inside the data directory; the name is the slugified workspace name, unique among files and other workspaces (`sales-2.duckdb`); a person's first workspace ("My workspace") is `<email local part>.duckdb`. Backed up with the data directory. |
| **Folder on the server** | `/mnt/analytics/team.duckdb` | Any writable folder on the host — a mounted volume, a network share. Only when `security.filesystem_mode` is `full` (in `sandboxed` mode the jail is the data directory); the folder is created if needed and must be writable for the DuckView process. |
| **Cloud storage** | `s3://bucket/team/analytics.duckdb` (also `gs://`, `r2://`, `az://`) | An object held by one of the owner's cloud connections (Settings → Storage → Cloud connections; the connection is matched by provider and bucket, or named explicitly with `cloud_connection_id`). See below. |
| **In-memory** | `:memory:` | Scratch; cleared whenever the engine restarts (the data epoch moves on every start so caches never serve stale results). The header shows an amber *memory* badge. |
| **MotherDuck** | `md:name` | Through the owner's MotherDuck token. |

New workspaces are files by default (`duckdb.default_database`); the New-workspace dialog offers all five, `GET /api/workspaces/storage-options` lists what is available (filesystem mode, data directory, cloud connections) and `GET /api/workspaces/suggest-db-path?name=` returns the file name the server would pick. Every kind can be chosen at creation, and an in-memory workspace can move to any of the persistent ones later.

**Cloud-backed databases.** DuckDB can only write a database on a local filesystem, so a cloud workspace works on a **local working copy** (`<data dir>/.duckview/cloud/<workspace id>.duckdb`, hidden from every listing) that DuckView keeps in step with the object:
- *pull* — before the engine starts, the object is downloaded when there is no local copy or the object changed since the last sync (another instance pushed) and nothing local is unsynced;
- *push* — after mutating SQL, once things have been quiet for `duckdb.cloud_sync_delay_seconds` (60); on **Sync now** (Settings → Engine → Storage, `POST /api/workspaces/:id/sync`, editors); when a workspace is persisted into the cloud; and at shutdown (`flush`). A push is a transactionally consistent snapshot — `ATTACH` a temp file + `COPY FROM DATABASE`, so the engine keeps serving — uploaded as one object (multipart for large files; Azure block blobs likewise).
- The state lives on the workspace (`cloud_sync`: last ETag, when, size, `dirty`, `last_error`), is shown by the header badge (*cloud* · *pending sync* · *sync error*) and the Storage panel, and reaches every open browser through the live feed. One DuckView instance writes a given workspace at a time: if the object changes in the cloud while this instance holds unsynced changes, the pull keeps the local copy and records the conflict in `last_error` instead of overwriting anything — *Sync now* then pushes the local state deliberately.
- Credentials never leave the server: the cloud connection's keys stay encrypted in the metadata store and are used by the SDK for the download/upload only.

**Make persistent.** An in-memory workspace becomes persistent — in the data directory, in a folder, or in the cloud — without losing anything: Settings → Engine → *Storage* → pick the target → **Make persistent** (owners only). `POST /api/workspaces/:id/persist {path?, cloud_connection_id?}` drops Mosaic's derived objects, `ATTACH`es the new file and runs DuckDB's `COPY FROM DATABASE memory TO …` while the engine is still up — every schema, table, view, sequence and macro is copied — then points the workspace at the file, restarts the engine on it, moves the data epoch and, for a cloud target, pushes the file straight away. The response says how many tables and views were carried over (`copied: false` when no engine was running). Refused when the workspace is already persistent or the target exists; audited as `workspace.persist`.

Database files are engine-owned: the file of any workspace, the cloud working copies, and DuckDB's `.wal` / `.tmp` bookkeeping never appear in the explorer, the catalog's file list or the Copilot context (opening them from another engine would mean lock conflicts). Back up the data directory (or the folder / bucket) to back up the workspaces.

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
- **Teams** are created by admins (Settings → Teams); admins and team **managers** manage membership, and anyone can leave a team. Teams linked to an IdP group (`external_id` — mirrored from SSO, provisioned over SCIM, or pre-linked by an admin) take their membership from SSO sign-in and SCIM; a pre-linked team can be shared before anyone in the group has signed in (see *SCIM provisioning*). Deleting a user or a team removes its grants.
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

An in-app assistant docked beside the workbench and the dashboard builder. Every turn is hydrated automatically with the workspace's tables/views (columns + types), the data files in the jail, the configured cloud buckets, the SQL in the active tab, and — for selected files/tables — `SUMMARIZE` statistics (min/max/distinct/null %).

**Providers.** One streaming contract, three implementations: **Claude** (official Anthropic SDK), every vendor that speaks the OpenAI chat-completions dialect — **ChatGPT / OpenAI**, **Gemini** (Google AI Studio's OpenAI endpoint), **DeepSeek**, **OpenRouter** (one key, every model as `vendor/name`), **Kimi** (Moonshot), **Groq**, **Mistral**, **Grok** (xAI), a local **Ollama**, or **any OpenAI-compatible endpoint** (Together, Fireworks, Perplexity, Azure OpenAI, vLLM, LM Studio) — and the AWS trio (**Amazon Bedrock** Converse streaming with model discovery, **Bedrock Agent**, **AgentCore runtime**, which receive the workspace context as `payload.context`). The catalog (`services/llm-catalog.ts`, `GET /api/copilot/providers`) carries each vendor's endpoint, key console link, key prefix, suggested models and quirks; the bridge retries a request without an optional parameter a vendor rejects (`stream_options`, `max_completion_tokens`).

**Where the key lives — three tiers, first one wins.**
1. **Bring your own** (per person, browser-only): Settings → Copilot → *Your own key*, or ⚙ in the drawer. Sent with each request, never stored server-side. Requires `copilot.allow_byok`.
2. **Server provider from Settings** (administrators): Settings → Copilot → *Server provider* — pick a vendor card, paste the key (the card links to the vendor's console), *Fetch models*, *Test connection*, *Save for everyone*. Stored in the metadata database encrypted with the platform key (AES-256-GCM, the last four characters kept as a hint), audited, applied immediately to everyone without a restart. *Test* lists models with the key, or runs a one-token completion for endpoints without `/models`.
3. **`copilot.*` in the config file** — the deployment-time default (env vars, Docker).

**Usage.** Every turn is recorded in `copilot_usage` (user, workspace, conversation, provider, model, action, own-key flag, input/output tokens, duration, status). Settings → Copilot → *Usage* shows the **sessions running now** (who, model, action, elapsed, characters streamed — refreshed every 5 s), token tiles for today / the window / all time, tokens per day, a by-model table and, for administrators, a by-person table and the recent turns. The drawer header shows the open conversation's tokens and each reply carries its own in/out count. Regular users see their own rows only. Prometheus keeps `duckview_copilot_tokens_total{provider,direction}`.

Actions: *Insert into tab*, *New tab*, *Run & inspect* (executes, then explains the result in business language), *Fix my query* (sends the failing SQL + DuckDB error), *Suggest questions* (top analytical questions for a selected dataset), *Build dashboard* (drafts a Mosaic spec; see [Mosaic dashboards](#mosaic-dashboards)). Conversations persist in `chat_history` with the context snapshot of each turn.

`POST /api/copilot/chat` streams SSE events (`context` → `delta`* → `done` | `error`; `done` carries `usage`, `sql_blocks`, `spec_blocks`); `GET /api/copilot/config` · `GET /api/copilot/providers` · `POST /api/copilot/models` · `GET/PUT/DELETE /api/copilot/settings` + `POST /api/copilot/settings/test` (administrators) · `GET /api/copilot/usage?days=&conversation_id=` · `GET /api/copilot/conversations` · `GET /api/copilot/messages` · `DELETE /api/copilot/conversations/:id`.

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
| `create_mosaic_dashboard(spec | spec_text, name?, description?, dashboard_id?, validate_only?, workspace_id?)` | Creates or updates an interactive Mosaic dashboard from a declarative spec (YAML/JSON). Validated structurally and every dataset/table bound with EXPLAIN before saving; errors come back as a list to fix. |
| `list_data_sources(workspace_id?)` | Every connection of the caller (storage, lakehouse, databases with aliases and health), the syncs of a workspace, and the source-type catalog. |
| `create_data_sync(name, source, target_table, target_schema?, mode?, transform_sql?, schedule?, run_now?, workspace_id?)` | A scheduled load of a table / URL / SELECT into a workspace table with an optional `{{raw}}` transformation, validated first. |
| `update_data_sync(sync_id, transform_sql?, schedule?, mode?, enabled?, name?, run_now?)` | Attach a transformation (validated), change the schedule, pause/resume. |
| `run_data_sync(sync_id)` | Run now; rows, duration, error and recent runs. |

| `browse_connector(connection_id, path?)` | Walks a warehouse, SaaS or Google connection one level at a time; leaves carry the `resource` for `create_data_sync`. |
| `connector_query(connection_id, sql, limit?)` | Read-only SQL on Snowflake, BigQuery, Redshift or ClickHouse; rows capped. |
| `snapshot_dashboard(dashboard_id \| app_id, width?)` | Renders a dashboard or data app the way a person sees it and returns the image — to check a dashboard an agent built, or to describe one. |
| `list_dbt_projects(workspace_id?)` | The workspace's dbt projects: models, schedule, last run and what failed. |
| `get_dbt_project(project_id, paths?)` | A project's files with their contents (everything up to ~60 KB, or the paths asked for). |
| `create_dbt_project(name, workspace_id?, files?, target_schema?)` | A project from the starter, or from files (`dbt_project.yml` at the root). |
| `write_dbt_files(project_id, files)` | Adds or replaces files (`{path: content}`) and deletes others (`{path: null}`). |
| `create_dbt_model(project_id, name, sql, folder?, materialized?, unique_key?, description?, overwrite?)` | A SELECT as a model: config block, `ref()` for the project's own models and seeds, description in YAML. |
| `run_dbt(project_id, command, select?, exclude?, full_refresh?, dry_run?)` | build · run · test · seed · compile, waiting for the result: every node's status, rows, failing rows and message (compile: the SQL). build / run / seed return an **approval challenge** listing what would be created or replaced until repeated with `dry_run: false`. |
| `get_dbt_run(run_id, include_log?)` | A run's nodes, error and dbt's log. |
| `list_metrics(workspace_id?)` | The semantic layer's metrics: label, description, type, source (workspace or dbt) and the dimensions each can be grouped by. |
| `query_metrics(metrics, group_by?, where?, order_by?, limit?, workspace_id?)` | Computes metrics exactly as defined — time grains, joined dimensions, filters — and returns the rows and the compiled SQL. Read-only. |
| `list_alerts` · `create_alert(name, sql, condition, every_minutes \| cron, channel_ids, …)` · `run_alert` | SQL alerts: a read-only query and a condition checked on a schedule; state changes go to Slack, Teams, email, PagerDuty or webhooks — see [Alerts & delivery](#alerts--delivery). |
| `list_apps` · `create_app(name, source, …)` · `update_app` · `run_app` · `stop_app` · `get_app_logs` · `preview_app` · `publish_app` | Streamlit data apps: generated from a dashboard, saved queries or code (validated first), run, previewed with a screenshot, published after human approval — see [Data apps](#data-apps-streamlit-dash-gradio). |

**Resources** — `duckdb://workspaces`, `duckdb://schemas/{workspace_id}` (DDL + column map + files), `duckdb://system/resources` (CPUs, RAM, DuckDB ceiling, spill disk, active engines), `duckdb://guides/mosaic-spec` (how to write a Mosaic dashboard spec), `duckdb://guides/data-app` (how to write a Streamlit data app with the SDK), `duckdb://guides/dbt` (how DuckView runs dbt projects and a workflow for agents).

**Prompts** — `data_quality_audit(table_or_path)`, `sql_optimization(sql)`, `build_mosaic_dashboard(table_or_path, goal?)`, `build_data_pipeline(source, goal?)`, `build_data_app(goal, data?)` and `build_dbt_models(goal, project_id?)` encode complete agent workflows over the tools above.

## HTTP API (summary)

| Area | Endpoints |
|---|---|
| Auth | `POST /api/auth/login` · `POST /api/auth/register` · `GET /api/auth/me` · `POST /api/auth/password` · `GET /api/auth/oidc/login` · `GET /api/auth/oidc/callback` |
| Workspaces | `GET/POST /api/workspaces` · `GET/PATCH/DELETE /api/workspaces/:id` · `POST /api/workspaces/:id/restart` · `POST /api/workspaces/:id/persist` · `POST /api/workspaces/:id/sync` · `GET /api/workspaces/storage-options` · `GET /api/workspaces/suggest-db-path` · `…/tabs` CRUD (per user; `sql_content`, `chart_config`, `cursor_position`, `order_index`) |
| Sharing | `GET/PUT /api/workspaces/:id/members` · `DELETE …/members/:memberId` · `POST …/leave` · `POST …/transfer` · `GET /api/users/directory` · `GET/POST /api/groups` · `PATCH/DELETE /api/groups/:id` · `GET/PUT /api/groups/:id/members` · `DELETE …/members/:userId` |
| Storage explorer | `GET/POST/DELETE /api/workspaces/:id/folders` (workspace folders) · `GET /api/storage/browse?workspace_id&path` (folder picker) · `GET /api/storage/local?workspace_id&path` (tree, one level) · `GET /api/storage/cloud?connection_id[&bucket&prefix]` (buckets / objects with folders via S3 `ListObjectsV2` delimiter or Azure hierarchy) · `POST /api/storage/inspect {workspace_id,target}` (`DESCRIBE … LIMIT 0` for files, `s3://`/`r2://`/`gs://`/`az://` objects, tables, `.duckdb` files, subqueries; Parquet row counts from the footer) |
| Cloud connections | `GET /api/cloud-connections/providers` · `GET/POST/PATCH/DELETE /api/cloud-connections` (S3 · R2 · GCS · Azure, AES-256-GCM at rest, applied as DuckDB `CREATE SECRET` to every engine of the owner) · `POST /api/cloud-connections/:id/test` |
| Exports | `POST /api/workspaces/:id/export {sql, format: parquet\|csv\|json\|arrow}` (native `COPY … TO` on disk, Arrow IPC via a streaming writer) · `GET /api/exports` · `GET /api/exports/:id/download` (streamed with `Content-Length`) · `DELETE /api/exports/:id` |
| BI | `…/queries` CRUD (saved queries with folders/tags) · `…/dashboards` CRUD (`kind: grid\|mosaic`, `spec`) · `GET/PATCH/DELETE /api/dashboards/:id` (layout, spec) · `POST/PATCH/DELETE /api/dashboards/:id/widgets[/:wid]` · `POST /api/dashboards/:id/widgets/:wid/data` |
| Data | `POST /api/workspaces/:id/files` (multipart upload into the jail) · `DELETE /api/workspaces/:id/files?path=` · `POST /api/workspaces/:id/overview` (KPIs, null ratios, sample, distributions) · `GET /api/workspaces/:id/catalog` |
| Query | `POST /api/workspaces/:id/query` · `/explain` · `/profile` · `/save` · `WS /api/ws/query` (auth → run/cancel; schema → rows* → done). `query`, `explain`, `profile`, `overview`, `storage/inspect` and widget data are conditional (`ETag` / `If-None-Match` → 304, `refresh: true`). |
| Cache | `DELETE /api/workspaces/:id/cache` · `POST /api/admin/cache/clear` · cache stats in `GET /api/system/live` |
| Connections | `GET /api/sources/catalog` · `GET /api/sources` · `GET /api/sources/google-sheet-url` · `GET/POST /api/database-connections` · `PATCH/DELETE /api/database-connections/:id` · `POST …/:id/test` · `GET …/:id/browse?schema=` · `GET/POST /api/workspaces/:id/syncs` · `POST /api/workspaces/:id/syncs/preview` · `GET/PATCH/DELETE /api/syncs/:id` · `POST /api/syncs/:id/run` · `GET /api/syncs/:id/runs` |
| Mosaic | `POST /api/workspaces/:id/mosaic {type: arrow\|json\|exec, sql}` · `POST /api/workspaces/:id/mosaic/prepare {spec \| spec_text, bind?}` · `GET /api/mosaic/info` |
| Live | `WS /api/ws/events` — audit rows, MCP tool invocations and session events in real time (admins: all; others: own) · `GET /api/system/live` — CPU %, RAM, `duckdb_memory()` per engine, scratch/data disk usage |
| Agents | `GET/POST/DELETE /api/tokens` · `GET /api/mcp/sessions` · `GET /api/mcp/info` (Claude Desktop / Cursor / Claude Code snippets) · `/api/agents…` (registered agents, snippets, self-test, invoke, discovery) · `GET /api/agent/openapi.json` · `GET/POST /api/agent/v1/tools[/:tool]` (REST façade) |
| Lakehouse | `GET /api/lakehouse/providers` · `/api/lakehouse-connections…` · `GET /api/lakehouse/browse` · `GET /api/lakehouse/:id/inspect` · `POST /api/lakehouse/:id/query` · `POST /api/lakehouse/:id/materialize` |
| Connections | `GET /api/connections/types` · `GET/POST/DELETE /api/connections` |
| Ops | `GET /api/system` · `GET /api/audit` · `GET/POST/PATCH/DELETE /api/admin/users` (`PATCH {role?, disabled?}`) · `GET /api/admin/scim` · `POST/DELETE /api/admin/scim/token` · `/scim/v2/{Users,Groups,ServiceProviderConfig,ResourceTypes,Schemas}` · `GET /api/admin/engines` · `POST /api/admin/engines/:id/evict` · `GET /api/admin/config` |
| Transform | `GET /api/dbt/status` · `POST /api/admin/dbt/install` · `GET/POST /api/workspaces/:id/dbt/projects` · `GET/PATCH/DELETE /api/dbt/projects/:id` · `POST /api/dbt/projects/:id/runs` · `GET /api/dbt/projects/:id/runs` · `GET /api/dbt/runs/:id` · `GET/PUT /api/workspaces/:id/semantic` · `POST …/semantic/validate` · `POST …/semantic/query` · `GET …/semantic/dimensions` · `POST …/semantic/scaffold` |
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
- **Metrics (`/metrics`):** `duckview_queries_total{actor,class,status}`, `duckview_query_duration_seconds` histogram, `duckview_query_rows_returned`, `duckview_active_queries`, `duckview_engines_active`, `duckview_mcp_connections_active{transport}`, `duckview_mcp_tool_calls_total{tool,status}`, `duckview_mcp_tool_duration_seconds`, `duckview_mcp_hitl_challenges_total`, `duckview_sandbox_violations_total{actor}`, `duckview_ws_connections_active`, `duckview_cache_lookups_total{kind,result}`, `duckview_cache_bytes`, `duckview_cache_entries`, host/DuckDB memory gauges, plus Node process defaults.
- **Traces:** `duckdb.query` and `mcp.tool.<name>` spans (`db.system`, `db.statement`, workspace, actor, statement class) via OpenTelemetry; exported over OTLP/HTTP when `observability.otel.enabled`.

## Project layout

```
packages/server/src
  config/        YAML + env loader (zod-validated)
  db/            Drizzle schemas (sqlite + pg), store factory, migrations in ../drizzle
  engine/        sandbox (DataJail), sql-guard (lexer/classifier/rewriter), duckdb (engines, overview, memory stats), results
  security/      AES-256-GCM, scrypt, token hashing
  services/      audit, auth/tokens, groups (teams + SSO sync), workspaces (membership/roles, tabs, data epoch), query (authz + HITL),
                 apps (Streamlit registry + subprocess runner), connector-connections + connectors/ (warehouses, SaaS, Google),
                 cache (result cache: keys, LRU, ETag), mosaic (connector endpoint + exec policy + spec prepare), mosaic-spec (parse, validate,
                 data → views; mosaic-names generated from vgplot), mosaic-guide (agent/Copilot authoring guide), connections, files (uploads),
                 lakehouse (Iceberg ATTACH + Databricks), databricks (UC + Statement Execution client), agents, aws (Bedrock/AgentCore bridge)
  agent/         tool registry (shared by MCP + REST), OpenAPI generator, framework snippets
  mcp/           server (registry → tools, resources, prompts), stdio, http (SSE + Streamable HTTP)
  routes/        auth (local + OIDC), workspaces (+ members), groups, query (REST + WS), files, events (WS), connections, tokens, admin, system,
                 conditional (ETag / If-None-Match / refresh glue)
  observability/ pino, prom-client, OpenTelemetry, live event bus, CPU sampler
packages/sdk-python   the `duckview` Python SDK (client, query builder, Arrow path, Streamlit helpers)
packages/web/src
  features/apps       gallery of data apps · editor (Python CodeMirror + live preview + logs)
  features/overview   drop zone · KPI badges · null-ratio bars · Chart.js distributions · sample grid
  features/workspace  schema tree (click-to-insert) · tabs with per-tab Stop · editor (cursor persisted) · streaming grid · chart · plan · profile
  features/settings   categorised left-nav: appearance (themes/fonts/scale) · layout · hardware gauges · engine tuning · storage · copilot · account · teams · users
  features/workspace  ShareDialog (members, roles, transfer, leave) next to the workbench
  lib/resultCache     IndexedDB result cache (LRU by bytes, per user, wiped on sign-out) · lib/useCached: stale-while-revalidate hook
  lib/mosaic          Mosaic connector + per-view coordinator · analyze (column roles, source views, template spec) · spec (YAML/JSON, data → views)
  features/explore    cross-filtered Explore view (vgplot) · features/dashboards: grid canvas + MosaicDashboard (editor, preview, generator)
  theme/              theme definitions (ramps, accents, tones, chart series, fonts) · store/theme.ts applies them as CSS variables
  features/mcp        registered agents (tokens, self-test, chat) · framework snippets + OpenAPI · client snippets · live inspector (WS)
  features/explorer   VS Code-style tree (data dir, folders, cloud, lakehouse) · schema panel · cloud & lakehouse wizards
```

## Tests

```bash
pnpm test        # 240 tests: jail, SQL guard, crypto, config, sharing/teams, result cache, Mosaic endpoint, and integration suites that boot real DuckDB
                 # engines, the MCP server (in-memory, SSE, Streamable HTTP), uploads, overview profiling,
                 # the live event feed, the HTTP API, WebSocket streaming, a mock Iceberg REST catalog serving
                 # real Iceberg tables (test/fixtures/iceberg), a mock Databricks workspace (Unity Catalog +
                 # Statement Execution API) and the agent façade / AWS providers against a fake AWS bridge
node scripts/smoke.mjs http://localhost:4200 admin@example.com <password>   # against a running instance
node scripts/e2e-mosaic.mjs overview-explore                               # real-browser checks (needs Chrome): overview-explore · workbench-explore · mosaic-dashboard
```
