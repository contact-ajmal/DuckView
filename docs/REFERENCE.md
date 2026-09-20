# DuckView — technical reference

> The product overview lives in the [README](../README.md). This document is the complete reference: configuration, security model, APIs, MCP tools, CLI, observability and project layout.

A hardened, stateful, native-DuckDB data platform: multi-tenant SQL workspaces with a polished UI, lakehouse connectors (AWS Glue / SageMaker Lakehouse, S3 Tables, Iceberg REST, Databricks), and an enterprise-grade **Model Context Protocol (MCP)** server plus REST/OpenAPI façade so autonomous agents (Claude, Cursor, Strands, LangGraph, LangChain, CrewAI, Bedrock AgentCore, …) can query the same sandboxed engines with human-in-the-loop safety.

```
┌──────────────── React + Vite + Tailwind v4 (zinc/violet) + Chart.js ─────────┐
│ #/  Overview     drag-and-drop ingestion · KPIs · null bars · distributions   │
│ #/query          VS Code-style explorer (any local folder + S3/R2/GCS/Azure  │
│                  + lakehouse catalogs) · schema pane · tabs · engine picker  │
│                  (DuckDB / Databricks warehouse) · saved queries · .sql io   │
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
│  auth: local (scrypt) · OIDC+PKCE (+group→team sync) · API tokens (scoped)   │
│  Sharing: workspace roles OWNER/EDITOR/VIEWER for users and teams            │
│  QueryService ─ single choke point: authz → SQL guard → HITL → audit         │
│  ResultCache ─ LRU keyed on file stat + workspace data epoch · ETag/304      │
│  Mosaic ─ engine as a Mosaic connector (Arrow, exec policy) · spec dashboards│
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

Every region resizes like an IDE: drag the splitters between the side bar and the main area, between the editor and the results pane, and between the side bar sections (Explorer · Tables & views · Saved queries · History). Section headers collapse, the side bar can be hidden, and double-clicking a splitter resets it.

Any component can be removed to declutter: hover a panel header and click its ×. Hidden components are listed under **Layout** in the header (with a count badge) for one-click restore, and Settings → Layout has a checklist of every component per page. Sizes and hidden components are remembered per browser.

## Themes

Six built-in themes decide both the colour system and the typeface — three dark (**Midnight** zinc/violet · **Graphite** neutral/blue · **Fjord** Nord-style teal) and three light (**Daylight** violet · **Professional** navy on grey with IBM Plex, for corporate/print contexts · **Paper** warm off-white with orange). Switch from the header quick-menu or Settings → Appearance, where you can also override the sans/mono fonts and the UI scale independently of the theme. Every colour in the app (surfaces, tones, status, code editor, chart series/grid/tooltips) resolves through runtime CSS variables set on `<html>` — Tailwind's `@theme` tokens reference them, so opacity variants like `bg-zinc-800/60` re-theme too. Chart palettes are validated per theme for colour-vision-deficiency separation and contrast against each surface. Preference is stored in the browser (`duckview.theme`); `prefers-color-scheme` picks Midnight or Daylight on first load.

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

**Resources** — `duckdb://workspaces`, `duckdb://schemas/{workspace_id}` (DDL + column map + files), `duckdb://system/resources` (CPUs, RAM, DuckDB ceiling, spill disk, active engines), `duckdb://guides/mosaic-spec` (how to write a Mosaic dashboard spec).

**Prompts** — `data_quality_audit(table_or_path)`, `sql_optimization(sql)` and `build_mosaic_dashboard(table_or_path, goal?)` encode complete agent workflows over the tools above.

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
| Mosaic | `POST /api/workspaces/:id/mosaic {type: arrow\|json\|exec, sql}` · `POST /api/workspaces/:id/mosaic/prepare {spec \| spec_text, bind?}` · `GET /api/mosaic/info` |
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
                 cache (result cache: keys, LRU, ETag), mosaic (connector endpoint + exec policy + spec prepare), mosaic-spec (parse, validate,
                 data → views; mosaic-names generated from vgplot), mosaic-guide (agent/Copilot authoring guide), connections, files (uploads),
                 lakehouse (Iceberg ATTACH + Databricks), databricks (UC + Statement Execution client), agents, aws (Bedrock/AgentCore bridge)
  agent/         tool registry (shared by MCP + REST), OpenAPI generator, framework snippets
  mcp/           server (registry → tools, resources, prompts), stdio, http (SSE + Streamable HTTP)
  routes/        auth (local + OIDC), workspaces (+ members), groups, query (REST + WS), files, events (WS), connections, tokens, admin, system,
                 conditional (ETag / If-None-Match / refresh glue)
  observability/ pino, prom-client, OpenTelemetry, live event bus, CPU sampler
packages/web/src
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
pnpm test        # 204 tests: jail, SQL guard, crypto, config, sharing/teams, result cache, Mosaic endpoint, and integration suites that boot real DuckDB
                 # engines, the MCP server (in-memory, SSE, Streamable HTTP), uploads, overview profiling,
                 # the live event feed, the HTTP API, WebSocket streaming, a mock Iceberg REST catalog serving
                 # real Iceberg tables (test/fixtures/iceberg), a mock Databricks workspace (Unity Catalog +
                 # Statement Execution API) and the agent façade / AWS providers against a fake AWS bridge
node scripts/smoke.mjs http://localhost:4200 admin@example.com <password>   # against a running instance
node scripts/e2e-mosaic.mjs overview-explore                               # real-browser checks (needs Chrome): overview-explore · workbench-explore · mosaic-dashboard
```
