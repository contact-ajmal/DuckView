---
title: Configuration
order: 3
group: Guide
description: duckview.config.yaml, environment overrides and every setting that matters — security, database, auth, DuckDB, MCP, lakehouse, Copilot, cache and observability.
---

## How configuration is resolved

`duckview.config.yaml` is loaded from `$DUCKVIEW_CONFIG`, `./duckview.config.yaml`, or `/etc/duckview/duckview.config.yaml`. Values may reference environment variables with `${VAR}` / `${VAR:-default}` (nesting allowed). Later sources win:

1. Built-in defaults
2. The YAML file
3. Well-known short names (`PORT`, `JWT_SECRET`, `ENCRYPTION_KEY`, `DUCKVIEW_DATA_DIR`, `DATABASE_URL`, `OIDC_*`, `DUCKDB_MEMORY_LIMIT`, …)
4. Generic overrides `DUCKVIEW__<SECTION>__<KEY>` — for example `DUCKVIEW__DUCKDB__MAX_RESULT_ROWS=1000`

The final object is validated with zod; the process refuses to start on invalid configuration. The effective, redacted config is available with `duckview config` and `GET /api/admin/config`.

## security

| Setting | Notes |
|---|---|
| `jwt_secret`, `encryption_key` | Required in `NODE_ENV=production`; ephemeral (with a warning) in development. `encryption_key` is a 32-byte hex string. |
| `data_jail_directory` | Every DuckDB file read/write is confined here (`DUCKVIEW_DATA_DIR`). |
| `filesystem_mode` | `full` (default, VS Code-like): add any local folder to the explorer, query files anywhere on the host, cloud sources on. `sandboxed` (multi-tenant): everything confined to the data directory, external access off unless enabled. |
| `enable_external_access` | `false` blocks S3/GCS/HTTP/MotherDuck and extension installs in sandboxed mode. |
| `lock_configuration` | DuckDB refuses `SET`/`PRAGMA` on hardened settings from any connection. |
| `allowed_extensions` / `blocked_extensions` / `allow_arbitrary_extensions` | `INSTALL`/`LOAD` allow-list; the blocked list always applies. |
| `allow_registration`, `password_min_length` | Self-service sign-up (off by default) and password policy. |
| `max_upload_bytes`, `allowed_upload_extensions` | Upload limits. |

## database

`metadata_url` — `sqlite://duckview_meta.db` (default) or `postgres://user:pass@host:5432/db`; `run_migrations` (default true) applies migrations at start.

## auth

| Setting | Notes |
|---|---|
| `strategy` | `local` or `oidc` (Authorization Code + PKCE, stateless signed `state`). |
| `oidc.issuer_url`, `client_id`, `client_secret`, `redirect_uri`, `scopes` | Standard OIDC client settings; the redirect defaults to `<public_url>/api/auth/oidc/callback`. |
| `oidc.admin_emails` | Promotes SSO users to ADMIN. |
| `oidc.groups_claim` | Claim carrying the user's IdP groups (default `groups`; Entra may use `roles`). |
| `oidc.admin_groups` | IdP groups whose members become ADMIN on login (never demoted). |
| `oidc.sync_groups` | Mirror IdP groups into DuckView teams on every login (default on). See [Sharing & teams](sharing.html). |
| `bootstrap_admin.email` / `password` | Created on first start when no users exist. |

## duckdb

| Setting | Notes |
|---|---|
| `default_memory_limit` | `80%` of host RAM or absolute (`16GB`). Per-workspace overrides in Settings → Engine. |
| `default_threads`, `query_timeout_seconds` | Per-workspace tunable. |
| `temp_directory` | Spill directory. |
| `max_result_rows` | Hard cap for UI result grids (default 5 000). |
| `max_cached_engines`, `engine_idle_ttl_seconds` | Engine LRU size and idle eviction (default 32 / 30 min). |
| `default_database` | Storage of a workspace created without an explicit database: `file` (default — a `<name>.duckdb` in the data directory that survives restarts) or `memory` (scratch). |
| `extension_directory`, `preload_extensions` | Where extensions live (pre-populated in the image) and which to load at start. |
| `export_ttl_seconds`, `export_max_rows` | Server-side export files expire after the TTL. |

## mcp

`default_page_size` / `max_page_size` (50 / 200 rows per tool call), `max_cell_chars` (truncation), `require_confirmation_for_mutations` (the HITL gate, default on), `sse_heartbeat_seconds`.

## lakehouse

`enabled`, `statement_timeout_seconds` (Databricks warehouse statements, default 120), `max_rows` (rows returned to the grid from a warehouse), `materialize_max_rows` (rows pulled into a DuckDB table).

## copilot

`provider` (`anthropic` | `openai` | `gemini` | `deepseek` | `openrouter` | `kimi` | `groq` | `mistral` | `xai` | `ollama` | `custom` | `bedrock` | `bedrock_agent` | `agentcore` | `none`) — the deployment-time default; a provider saved from Settings → Copilot by an administrator takes precedence — `model`, `api_key`, `base_url` (Ollama / OpenAI-compatible), `aws_region`, `bedrock_agent_id`, `bedrock_agent_alias_id`, `agentcore_runtime_arn`, `allow_byok` (users may bring their own key), `max_context_tables`, `include_summaries`, `max_output_tokens`, `temperature`.

## cache

| Setting | Notes |
|---|---|
| `enabled` | Server-side result cache (default on). |
| `max_bytes` | LRU budget (default 256 MB). |
| `max_entry_bytes` | Results above this are never cached (default 16 MB). |
| `ttl_seconds` | Lifetime of versioned entries — local files + workspace data epoch (default 6 h). |
| `remote_ttl_seconds` | Lifetime of entries touching remote / lakehouse / MotherDuck sources (default 60 s; `0` never caches them). |

See [Result cache](cache.html) for how keys are built.

## mosaic

| Setting | Notes |
|---|---|
| `enabled` | The Mosaic connector endpoint behind the Explore view and Mosaic dashboards (default on). |
| `schema` | Schema for Mosaic's pre-aggregated tables (default `duckview_mosaic`); source views are `<schema>_src_<hash>` in the main schema. Both are dropped when the data epoch moves and hidden from catalogs. |
| `max_rows` | Row ceiling for chart queries, independent of the grid cap (default 1 000 000). |
| `materialize_max_rows` | Dashboard datasets up to this many rows are materialised once into an attached in-memory database so interactions read memory instead of re-parsing files (default 20 000 000; `0` = always views). |
| `rate_limit_per_minute` | The connector's own budget, per session rather than per IP (default 6 000; `0` = unlimited). A brush over 25 charts is 25–75 requests, so the global `server.rate_limit_per_minute` no longer throttles dashboards. |

See [Interactive exploration & Mosaic dashboards](mosaic.html).

## observability

`metrics_enabled`, `metrics_require_auth` (Prometheus at `/metrics`), `otel.enabled`, `otel.service_name`, `otel.exporter_otlp_endpoint`, `otel.console_exporter`.

## Example

```yaml
server:
  port: ${PORT:-4200}
  public_url: "${DUCKVIEW_PUBLIC_URL:-}"
security:
  jwt_secret: "${JWT_SECRET}"
  encryption_key: "${ENCRYPTION_KEY}"
  data_jail_directory: "${DUCKVIEW_DATA_DIR:-./data}"
  filesystem_mode: "${DUCKVIEW_FILESYSTEM_MODE:-full}"
database:
  metadata_url: "${DATABASE_URL:-sqlite://duckview_meta.db}"
auth:
  strategy: "${AUTH_STRATEGY:-local}"
  oidc:
    groups_claim: "${OIDC_GROUPS_CLAIM:-groups}"
    admin_groups: []
    sync_groups: true
duckdb:
  default_memory_limit: "${DUCKDB_MEMORY_LIMIT:-80%}"
  query_timeout_seconds: ${DUCKDB_QUERY_TIMEOUT_SECONDS:-60}
cache:
  max_bytes: ${DUCKVIEW_CACHE_MAX_BYTES:-268435456}
```
