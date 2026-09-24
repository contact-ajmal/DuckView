/**
 * DuckView configuration loader.
 *
 * Resolution order (later wins):
 *   1. Built-in defaults
 *   2. duckview.config.yaml (path: $DUCKVIEW_CONFIG, ./duckview.config.yaml, /etc/duckview/duckview.config.yaml)
 *      - `${VAR}` and `${VAR:-default}` placeholders are expanded from process.env
 *   3. Well-known ENV overrides (JWT_SECRET, ENCRYPTION_KEY, DUCKVIEW_DATA_DIR, DATABASE_URL, PORT, ...)
 *   4. Generic ENV overrides: DUCKVIEW__<section>__<key> (e.g. DUCKVIEW__DUCKDB__MAX_RESULT_ROWS=1000)
 *
 * The final object is validated with zod; the process refuses to start on invalid config.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

const LogLevel = z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);

export const ConfigSchema = z.object({
  server: z
    .object({
      port: z.coerce.number().int().min(1).max(65535).default(4200),
      host: z.string().default('0.0.0.0'),
      log_level: LogLevel.default('info'),
      public_url: z.string().url().optional(),
      cors_origins: z.array(z.string()).default([]),
      trust_proxy: z.coerce.boolean().default(false),
      body_limit_bytes: z.coerce.number().int().default(4 * 1024 * 1024),
      rate_limit_per_minute: z.coerce.number().int().default(600),
    })
    .default({}),
  security: z
    .object({
      jwt_secret: z.string().min(16).optional(),
      jwt_expires_in: z.string().default('12h'),
      encryption_key: z
        .string()
        .regex(/^[0-9a-fA-F]{64}$/, 'encryption_key must be a 32-byte hex string (64 hex chars)')
        .optional(),
      data_jail_directory: z.string().default('./data'),
      /**
       * 'full' (default, single-user): any local folder can be added to the explorer and DuckDB may read files anywhere
       * the process can; cloud/remote sources are enabled. 'sandboxed' (multi-tenant): everything is confined to
       * data_jail_directory and external access is off unless enable_external_access is set.
       */
      filesystem_mode: z.enum(['sandboxed', 'full']).default('full'),
      allow_arbitrary_extensions: z.coerce.boolean().default(false),
      allowed_extensions: z.array(z.string()).default(['parquet', 'json', 'icu', 'httpfs', 'aws', 'azure', 'iceberg', 'delta', 'motherduck', 'postgres', 'spatial', 'excel']),
      blocked_extensions: z.array(z.string()).default(['shellfs', 'python', 'jemalloc']),
      enable_external_access: z.coerce.boolean().default(false),
      lock_configuration: z.coerce.boolean().default(true),
      allow_registration: z.coerce.boolean().default(false),
      max_upload_bytes: z.coerce.number().int().min(1024).default(2 * 1024 * 1024 * 1024),
      allowed_upload_extensions: z.array(z.string()).default(['parquet', 'csv', 'tsv', 'txt', 'json', 'jsonl', 'ndjson', 'gz', 'zst', 'duckdb', 'xlsx', 'arrow', 'feather']),
      password_min_length: z.coerce.number().int().min(8).default(10),
    })
    .default({}),
  database: z
    .object({
      metadata_url: z.string().default('sqlite://duckview_meta.db'),
      run_migrations: z.coerce.boolean().default(true),
    })
    .default({}),
  auth: z
    .object({
      strategy: z.enum(['local', 'oidc']).default('local'),
      oidc: z
        .object({
          issuer_url: z.string().optional(),
          client_id: z.string().optional(),
          client_secret: z.string().optional(),
          redirect_uri: z.string().optional(),
          scopes: z.string().default('openid email profile'),
          admin_emails: z.array(z.string()).default([]),
          /** ID-token / userinfo claim carrying the user's IdP groups (Okta "groups", Entra "groups" or "roles", Keycloak "groups"). */
          groups_claim: z.string().default('groups'),
          /** IdP groups whose members are promoted to ADMIN on login (never demotes). */
          admin_groups: z.array(z.string()).default([]),
          /** Mirror IdP groups into DuckView teams (external_id = claim value) so workspaces can be shared with them. */
          sync_groups: z.coerce.boolean().default(true),
        })
        .default({}),
      /** SCIM 2.0 provisioning at /scim/v2 (Okta, Entra ID, OneLogin, JumpCloud…), authenticated by a bearer token. */
      scim: z
        .object({
          enabled: z.coerce.boolean().default(true),
          /** A fixed bearer token for infrastructure-as-code setups; otherwise generate one from Governance → Provisioning. */
          token: z.string().optional(),
          /** What DELETE /Users/:id does: deactivate (keeps the user's workspaces and history) or delete for good. */
          on_delete: z.enum(['deactivate', 'delete']).default('deactivate'),
        })
        .default({}),
      bootstrap_admin: z
        .object({
          email: z.string().email().optional(),
          password: z.string().optional(),
        })
        .default({}),
    })
    .default({}),
  duckdb: z
    .object({
      default_memory_limit: z.string().default('80%'),
      default_threads: z.union([z.literal('auto'), z.coerce.number().int().min(1)]).default('auto'),
      temp_directory: z.string().default(path.join(os.tmpdir(), 'duckview_spill')),
      query_timeout_seconds: z.coerce.number().int().min(1).default(60),
      max_result_rows: z.coerce.number().int().min(1).default(5000),
      max_cached_engines: z.coerce.number().int().min(1).default(32),
      engine_idle_ttl_seconds: z.coerce.number().int().min(10).default(1800),
      preload_extensions: z.array(z.string()).default([]),
      /** Where DuckDB installs/loads extensions (httpfs, azure, arrow, iceberg, delta). Pre-populated in the container image. */
      extension_directory: z.string().optional(),
      export_ttl_seconds: z.coerce.number().int().min(30).default(3600),
      export_max_rows: z.coerce.number().int().min(1).default(50_000_000),
      /**
       * Storage of a workspace created without an explicit database: `file` (a <name>.duckdb file in the data
       * directory — tables, views and macros survive restarts) or `memory` (a scratch database that is cleared when
       * the engine restarts). Every workspace can still be created either way, and an in-memory one can be made
       * persistent later without losing its tables.
       */
      default_database: z.enum(['file', 'memory']).default('file'),
      /** Quiet period after the last mutating statement before a cloud-backed workspace is pushed to its object. */
      cloud_sync_delay_seconds: z.coerce.number().int().min(5).default(60),
      /** Run scheduled data syncs from this process (turn off on replicas that should not run them). */
      sync_scheduler_enabled: z.coerce.boolean().default(true),
    })
    .default({}),
  cache: z
    .object({
      /** Server-side result cache for profiles, schema inspection, plans, widget data and read-only queries. */
      enabled: z.coerce.boolean().default(true),
      /** Total budget for cached results (LRU by bytes of JSON). */
      max_bytes: z.coerce.number().int().min(0).default(256 * 1024 * 1024),
      /** Results larger than this are never cached. */
      max_entry_bytes: z.coerce.number().int().min(1024).default(16 * 1024 * 1024),
      /** Lifetime of entries whose inputs are versioned (local files + workspace data epoch). */
      ttl_seconds: z.coerce.number().int().min(10).default(6 * 3600),
      /** Lifetime of entries that touch remote/lakehouse sources (no version signal); 0 disables caching them. */
      remote_ttl_seconds: z.coerce.number().int().min(0).default(60),
    })
    .default({}),
  mosaic: z
    .object({
      /** Mosaic (uwdata/mosaic) interactive visualization endpoint. */
      enabled: z.coerce.boolean().default(true),
      /**
       * Database schema that holds Mosaic's pre-aggregated materialized views and DuckView's source views; hidden
       * from catalogs. Deliberately not "mosaic": a workspace database file called mosaic.duckdb would make
       * "mosaic"."preagg_x" ambiguous between catalog and schema.
       */
      schema: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).default('duckview_mosaic'),
      /** Row cap for Mosaic result queries (pixel-binned rasters can be large; the grid cap does not apply). */
      max_rows: z.coerce.number().int().min(1000).default(1_000_000),
      /**
       * Dashboard datasets (spec `data` entries: files, queries, inline rows) up to this many rows are materialised
       * once into an attached in-memory database ("<schema>_mem") instead of being re-read from the file on every
       * interaction — a 3.7M-row CSV goes from ~600 ms to ~6 ms per chart query. Larger datasets, and entries with
       * `materialize: false`, are served as views. 0 disables materialisation.
       */
      materialize_max_rows: z.coerce.number().int().min(0).default(20_000_000),
      /**
       * Own rate limit for the connector endpoint, per session (token) rather than per IP: one brush on a dashboard
       * with 25 charts is 25–75 small requests, which would exhaust server.rate_limit_per_minute in a few
       * interactions. 0 disables the limit for this endpoint.
       */
      rate_limit_per_minute: z.coerce.number().int().min(0).default(6000),
    })
    .default({}),
  mcp: z
    .object({
      default_page_size: z.coerce.number().int().min(1).default(50),
      max_page_size: z.coerce.number().int().min(1).default(200),
      max_cell_chars: z.coerce.number().int().min(16).default(400),
      require_confirmation_for_mutations: z.coerce.boolean().default(true),
      sse_heartbeat_seconds: z.coerce.number().int().min(5).default(25),
    })
    .default({}),
  lakehouse: z
    .object({
      enabled: z.coerce.boolean().default(true),
      /** Remote statement (Databricks SQL warehouse) wall-clock limit before cancellation. */
      statement_timeout_seconds: z.coerce.number().int().min(5).default(120),
      poll_interval_ms: z.coerce.number().int().min(100).default(1000),
      /** Row cap for interactive remote queries shown in the grid. */
      max_rows: z.coerce.number().int().min(1).default(10_000),
      /** Row cap when materialising a remote result into a DuckDB table. */
      materialize_max_rows: z.coerce.number().int().min(1).default(2_000_000),
    })
    .default({}),
  copilot: z
    .object({
      enabled: z.coerce.boolean().default(true),
      /**
       * Deployment-time default provider (env vars / Docker). A provider set from Settings → Copilot by an
       * administrator takes precedence. Users may still bring their own key when allow_byok is true.
       */
      provider: z.enum(['anthropic', 'openai', 'gemini', 'deepseek', 'openrouter', 'kimi', 'groq', 'mistral', 'xai', 'ollama', 'custom', 'bedrock', 'bedrock_agent', 'agentcore', 'none']).default('none'),
      model: z.string().optional(),
      api_key: z.string().optional(),
      /** OpenAI-compatible or Ollama base URL (e.g. http://ollama:11434). */
      base_url: z.string().optional(),
      /** AWS providers (bedrock, bedrock_agent, agentcore) — credentials come from the default AWS credential chain. */
      aws_region: z.string().optional(),
      bedrock_agent_id: z.string().optional(),
      bedrock_agent_alias_id: z.string().optional(),
      agentcore_runtime_arn: z.string().optional(),
      allow_byok: z.coerce.boolean().default(true),
      max_context_tables: z.coerce.number().int().min(1).default(40),
      include_summaries: z.coerce.boolean().default(true),
      max_output_tokens: z.coerce.number().int().min(256).default(4096),
      temperature: z.coerce.number().min(0).max(2).default(0.2),
      history_limit: z.coerce.number().int().min(1).default(20),
    })
    .default({}),
  /**
   * Data apps: Streamlit applications built on a workspace's data, run by DuckView next to the server and served
   * under /apps/<id>/. Apps execute Python — keep this off on servers where analysts should not run code.
   */
  apps: z
    .object({
      /** Default: on in full filesystem mode, off in sandboxed mode (resolved after parsing). */
      enabled: z.coerce.boolean().optional(),
      /**
       * Where apps run: `subprocess` (a shared virtualenv next to the server), `docker` (one hardened container per
       * app, from apps.docker.image) or `kubernetes` (one Pod per app, through the API server).
       */
      runtime: z.enum(['subprocess', 'docker', 'kubernetes']).default('subprocess'),
      /** Python interpreter used to create the apps virtualenv (needs venv + pip). */
      python: z.string().default('python3'),
      /** Where the shared virtualenv lives; default <data dir>/.duckview/apps/venv. */
      venv_dir: z.string().optional(),
      /** Create the virtualenv and install streamlit / pandas / pyarrow + the DuckView SDK on first start. */
      auto_install: z.coerce.boolean().default(true),
      /** Install each app's requirements.txt into the shared virtualenv before it starts. */
      allow_requirements: z.coerce.boolean().default(true),
      /** Command that runs an app (the entry file and --server.* flags are appended). Overridable for tests. */
      command: z.array(z.string()).optional(),
      max_running: z.coerce.number().int().min(1).default(5),
      idle_stop_minutes: z.coerce.number().int().min(1).default(30),
      port_range: z.tuple([z.coerce.number().int().min(1024), z.coerce.number().int().max(65535)]).default([8601, 8700]),
      start_timeout_seconds: z.coerce.number().int().min(10).default(180),
      /** Token minted for an app (read-only, scoped to its workspace) is rotated on every start and expires after this. */
      token_ttl_hours: z.coerce.number().int().min(1).default(24),
      /** Maximum size of an app's source files, in bytes. */
      max_source_bytes: z.coerce.number().int().min(1024).default(512 * 1024),
      /** Chrome / Chromium binary for headless previews (preview_app); auto-detected when unset. */
      chrome_path: z.string().optional(),
      /**
       * Serve apps from their own origin: a second listener (apps.port, default server.port + 1), so an app's code —
       * which may run script in the viewer's browser — can never read the DuckView UI's session. Turn off only where
       * every app author is trusted with every viewer's account.
       */
      isolation: z.coerce.boolean().default(true),
      /** Port of the apps listener (isolation); default server.port + 1. */
      port: z.coerce.number().int().min(1).max(65535).optional(),
      /**
       * Public URL of the apps listener behind a reverse proxy, e.g. https://apps.duckview.example.com — a different
       * host on the same registrable domain as the UI (its cookie must reach iframes of the UI). Default: the UI's
       * scheme and host with apps.port.
       */
      public_url: z.string().url().optional(),
      /**
       * Apps that run in the viewer's browser (stlite: Streamlit on Pyodide). Nothing runs on the server; the app
       * reads the workspace with the viewer's own access (a short-lived, read-only credential for that workspace).
       */
      stlite: z
        .object({
          enabled: z.coerce.boolean().default(true),
          /** Where @stlite/browser's build lives (stlite.js / stlite.css): the CDN, or a self-hosted copy. */
          url: z.string().default('https://cdn.jsdelivr.net/npm/@stlite/browser@1.9.1/build'),
          /** A self-hosted Pyodide (…/pyodide.js); default stlite's CDN choice. */
          pyodide_url: z.string().optional(),
          /** Lifetime of the viewer's read-only credential handed to the page. */
          token_ttl_minutes: z.coerce.number().int().min(5).default(240),
        })
        .default({}),
      /** Publishing an app to everyone signed in ("org") waits for an administrator's approval. */
      publish_requires_approval: z.coerce.boolean().default(true),
      /** When max_running is reached, stop the least recently used app idle for at least this long instead of refusing. */
      evict_idle_seconds: z.coerce.number().int().min(0).default(120),
      /** Always-on apps that crash are restarted this many times in a row (with backoff) before they are left in error. */
      max_restarts: z.coerce.number().int().min(0).default(5),
      /** Per-app limits for the container runtimes (Docker --cpus / --memory, Kubernetes limits). */
      resources: z.object({ cpu: z.string().default('1'), memory: z.string().default('1Gi') }).default({}),
      docker: z
        .object({
          binary: z.string().default('docker'),
          /** Image with Python, Streamlit, pandas, pyarrow and the DuckView SDK (docker/app-runtime.Dockerfile). */
          image: z.string().default('anbproject/duckview-app-runtime:latest'),
          /** Command inside the image that runs an app (the entry file and --server.* flags are appended). */
          command: z.array(z.string()).default(['streamlit', 'run']),
          /**
           * A Docker network to attach apps to (DuckView itself in a container on that network): apps are reached by
           * container name, nothing is published on the host. Unset: each app publishes a port on 127.0.0.1.
           */
          network: z.string().optional(),
          /** DuckView's URL as seen from an app container; default http://host.docker.internal:<port> (or http://duckview:<port> on a network). */
          duckview_url: z.string().optional(),
          /** Let apps pip-install their requirements.txt at start (needs egress to PyPI). */
          allow_requirements: z.coerce.boolean().default(true),
          pids_limit: z.coerce.number().int().min(16).default(256),
        })
        .default({}),
      kubernetes: z
        .object({
          /** API server; default the in-cluster service (https://kubernetes.default.svc) with the pod's service account. */
          api_url: z.string().optional(),
          token_file: z.string().default('/var/run/secrets/kubernetes.io/serviceaccount/token'),
          ca_file: z.string().default('/var/run/secrets/kubernetes.io/serviceaccount/ca.crt'),
          /** Namespace for app pods; default the server's own namespace. */
          namespace: z.string().optional(),
          image: z.string().default('anbproject/duckview-app-runtime:latest'),
          image_pull_policy: z.enum(['Always', 'IfNotPresent', 'Never']).default('IfNotPresent'),
          command: z.array(z.string()).default(['streamlit', 'run']),
          container_port: z.coerce.number().int().min(1).max(65535).default(8501),
          /** DuckView's URL from an app pod; default http://duckview.<namespace>.svc (the k8s/service.yaml Service). */
          duckview_url: z.string().optional(),
          allow_requirements: z.coerce.boolean().default(true),
          node_selector: z.record(z.string(), z.string()).optional(),
          /** Extra labels on app pods (e.g. to match a NetworkPolicy). */
          labels: z.record(z.string(), z.string()).optional(),
        })
        .default({}),
    })
    .default({}),
  /** Streaming the audit log to SIEMs and buckets (sinks are set up by administrators in the console). */
  audit_export: z
    .object({
      enabled: z.coerce.boolean().default(true),
      /** How often sinks are fed, and how many events at most per request. */
      interval_seconds: z.coerce.number().int().min(2).default(10),
      batch_size: z.coerce.number().int().min(1).max(5000).default(500),
      /** Datadog intake base URL override (tests, proxies); default https://http-intake.logs.<site>. */
      datadog_url: z.string().optional(),
    })
    .default({}),
  /** Lineage: OpenLineage events for sync runs, sent to Marquez / DataHub / OpenMetadata / any OpenLineage HTTP endpoint. */
  lineage: z
    .object({
      /** e.g. http://marquez:5000/api/v1/lineage — unset: no events. */
      openlineage_url: z.string().optional(),
      openlineage_api_key: z.string().optional(),
      /** The namespace DuckView's jobs and datasets live in. */
      namespace: z.string().default('duckview'),
    })
    .default({}),
  /** Transformations: dbt projects compiled by dbt Core (dbt-duckdb) and run in the workspace's engine. */
  transform: z
    .object({
      /** Runs scheduled dbt projects (and, later, other transformations). */
      scheduler_enabled: z.coerce.boolean().default(true),
      dbt: z
        .object({
          enabled: z.coerce.boolean().default(true),
          /** Interpreter used to create the dbt virtualenv (needs venv + pip). */
          python: z.string().default('python3'),
          /** Where dbt Core lives; default <data dir>/.duckview/dbt/venv. */
          venv_dir: z.string().optional(),
          /** Create the virtualenv and pip-install `package` on the first run. */
          auto_install: z.coerce.boolean().default(true),
          /** The pip requirement installed, e.g. "dbt-duckdb==1.9.4" to pin a version. */
          package: z.string().default('dbt-duckdb'),
          /** Allow `dbt deps` (packages.yml / dependencies.yml from dbt Hub or git). */
          allow_packages: z.coerce.boolean().default(true),
          /** A compile (and deps) is stopped after this long. */
          timeout_seconds: z.coerce.number().int().min(10).default(300),
          /** Largest project accepted, all files together (seeds included). */
          max_project_bytes: z.coerce.number().int().min(1024).default(20 * 1024 * 1024),
        })
        .default({}),
    })
    .default({}),
  /** Git sync: a workspace's notebooks, queries, dashboards, metrics and dbt projects kept in a Git repository. */
  git: z
    .object({
      enabled: z.coerce.boolean().default(true),
      /** The git executable. */
      binary: z.string().default('git'),
      /** Accept file:// and plain paths as repositories (tests, a repository on the same machine). Off: https only. */
      allow_local_repos: z.coerce.boolean().default(false),
      /** A clone, fetch or push is stopped after this long. */
      timeout_seconds: z.coerce.number().int().min(5).default(120),
    })
    .default({}),
  /**
   * Cluster mode: several DuckView nodes behind a load balancer, sharing the metadata store (Postgres) and the data
   * directory (a shared volume). Each workspace's DuckDB file is opened by one node — the one holding its lease —
   * and the others forward engine work to it; scheduled jobs run once; live events reach every node.
   */
  cluster: z
    .object({
      enabled: z.coerce.boolean().default(false),
      /** This node's id (default: generated at start). */
      node_id: z.string().default(''),
      /** How the other nodes reach this one, e.g. http://10.0.0.5:4200 (a pod IP; not the public URL). */
      advertise_url: z.string().default(''),
      /** Shared secret for node-to-node calls; the same on every node, at least 32 characters. */
      secret: z.string().default(''),
      heartbeat_seconds: z.coerce.number().int().min(1).max(300).default(10),
      /** A node that has not renewed its leases for this long loses them. */
      lease_seconds: z.coerce.number().int().min(3).max(3600).default(30),
    })
    .default({}),
  /** The PostgreSQL wire protocol: BI tools and drivers connect to workspaces as if they were Postgres databases. */
  pgwire: z
    .object({
      enabled: z.coerce.boolean().default(false),
      /** Listen address: localhost by default; 0.0.0.0 to accept other machines (then configure TLS). */
      host: z.string().default('127.0.0.1'),
      port: z.coerce.number().int().min(0).max(65535).default(5433),
      /** PEM files for TLS (sslmode=require); without them passwords travel in clear text. */
      tls_cert: z.string().default(''),
      tls_key: z.string().default(''),
      /** Refuse clients that do not upgrade to TLS (only with a certificate). */
      require_tls: z.coerce.boolean().default(false),
      max_connections: z.coerce.number().int().min(1).max(10_000).default(100),
      /** Rows returned per statement at most. */
      max_rows: z.coerce.number().int().min(1).max(100_000_000).default(1_000_000),
    })
    .default({}),
  /** Streams: Kafka topics, Kinesis streams and HTTP pushes appended continuously to workspace tables. */
  streams: z
    .object({
      enabled: z.coerce.boolean().default(true),
      /** Run the Kafka and Kinesis consumers in this process; turn off on replicas that should not consume. */
      consumers_enabled: z.coerce.boolean().default(true),
      /** The largest batch written at once (rows). */
      max_batch_rows: z.coerce.number().int().min(1).max(1_000_000).default(50_000),
      /** The largest HTTP push accepted (MB). */
      max_push_mb: z.coerce.number().int().min(1).max(100).default(10),
    })
    .default({}),
  /** Agent2Agent (A2A): published DuckView agents answer other agents; people and agents ask remote A2A agents. */
  a2a: z
    .object({
      enabled: z.coerce.boolean().default(true),
      /** Let remote agents live on private / loopback addresses (an intranet agent; tests). Off: public hosts, https. */
      allow_private_targets: z.coerce.boolean().default(false),
      /** A remote agent's answer is waited for this long. */
      timeout_seconds: z.coerce.number().int().min(5).max(900).default(180),
    })
    .default({}),
  /** Delivery of alerts and scheduled snapshots: Slack, Microsoft Teams, email, PagerDuty and webhooks. */
  notifications: z
    .object({
      enabled: z.coerce.boolean().default(true),
      /** Let webhooks reach private / loopback addresses (an intranet endpoint; tests). Off: public targets only. */
      allow_private_targets: z.coerce.boolean().default(false),
      timeout_seconds: z.coerce.number().int().min(1).max(120).default(10),
      /** Check due alerts (and, later, snapshots) from this process; turn off on replicas that should not. */
      scheduler_enabled: z.coerce.boolean().default(true),
      /** Rows an alert query may return (the first ones are quoted in the message). */
      alert_max_rows: z.coerce.number().int().min(1).max(10_000).default(100),
      /** Scheduled snapshots: how long rendered files are kept, and how long a shared link to one works. */
      snapshot_retention_days: z.coerce.number().int().min(1).default(30),
      snapshot_link_days: z.coerce.number().int().min(1).max(90).default(7),
      /** How long a dashboard or app may take to render. */
      snapshot_timeout_seconds: z.coerce.number().int().min(10).default(90),
      /** PagerDuty Events API v2 endpoint (EU accounts: https://events.eu.pagerduty.com/v2/enqueue). */
      pagerduty_url: z.string().default('https://events.pagerduty.com/v2/enqueue'),
      /** Outgoing mail; administrators can also set it from Settings → Integrations (that one wins). */
      smtp: z
        .object({
          host: z.string().optional(),
          port: z.coerce.number().int().min(1).max(65535).default(587),
          /** true: TLS from the start (port 465); false: STARTTLS when the server offers it. */
          secure: z.coerce.boolean().default(false),
          user: z.string().optional(),
          password: z.string().optional(),
          from: z.string().optional(),
        })
        .default({}),
    })
    .default({}),
  observability: z
    .object({
      metrics_enabled: z.coerce.boolean().default(true),
      metrics_require_auth: z.coerce.boolean().default(false),
      otel: z
        .object({
          enabled: z.coerce.boolean().default(false),
          service_name: z.string().default('duckview'),
          exporter_otlp_endpoint: z.string().optional(),
          console_exporter: z.coerce.boolean().default(false),
        })
        .default({}),
    })
    .default({}),
});

export type DuckViewConfig = z.infer<typeof ConfigSchema> & {
  security: { jwt_secret: string; encryption_key: string; data_jail_directory: string };
  apps: z.infer<typeof ConfigSchema>['apps'] & { enabled: boolean; venv_dir: string };
  transform: z.infer<typeof ConfigSchema>['transform'] & { dbt: z.infer<typeof ConfigSchema>['transform']['dbt'] & { venv_dir: string } };
  /** true when secrets were auto-generated for this process (dev only). */
  ephemeralSecrets: boolean;
  configPath: string | null;
};

/** Expands `${VAR}` and `${VAR:-default}` (nesting allowed) using process.env. Unset vars without default become "". */
export function expandEnvPlaceholders(input: string, env: NodeJS.ProcessEnv = process.env): string {
  // Innermost-first: a placeholder whose default contains no further `${` is resolved, then repeat.
  const inner = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-((?:[^{}]|\{[^{}]*\})*))?\}/g;
  let out = input;
  for (let i = 0; i < 16; i++) {
    const next = out.replace(inner, (_m, name: string, def?: string) => {
      const v = env[name];
      if (v !== undefined && v !== '') return v;
      return def ?? '';
    });
    if (next === out) break;
    out = next;
  }
  return out;
}

function findConfigFile(): string | null {
  const candidates = [
    process.env.DUCKVIEW_CONFIG,
    path.resolve(process.cwd(), 'duckview.config.yaml'),
    path.resolve(process.cwd(), 'duckview.config.yml'),
    '/etc/duckview/duckview.config.yaml',
  ].filter((p): p is string => !!p);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

type Raw = Record<string, unknown>;

function setDeep(obj: Raw, keys: string[], value: unknown) {
  let cur: Raw = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i]!;
    if (typeof cur[k] !== 'object' || cur[k] === null) cur[k] = {};
    cur = cur[k] as Raw;
  }
  cur[keys[keys.length - 1]!] = value;
}

function coerceEnvValue(v: string): unknown {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v.startsWith('[') || v.startsWith('{')) {
    try {
      return JSON.parse(v);
    } catch {
      /* fallthrough */
    }
  }
  return v;
}

/** Well-known short env names → config path. */
const WELL_KNOWN_ENV: Record<string, string[]> = {
  PORT: ['server', 'port'],
  DUCKVIEW_PORT: ['server', 'port'],
  HOST: ['server', 'host'],
  DUCKVIEW_HOST: ['server', 'host'],
  LOG_LEVEL: ['server', 'log_level'],
  DUCKVIEW_PUBLIC_URL: ['server', 'public_url'],
  DUCKVIEW_APPS_PUBLIC_URL: ['apps', 'public_url'],
  DUCKVIEW_APPS_PORT: ['apps', 'port'],
  DUCKVIEW_CORS_ORIGINS: ['server', 'cors_origins'],
  JWT_SECRET: ['security', 'jwt_secret'],
  ENCRYPTION_KEY: ['security', 'encryption_key'],
  DUCKVIEW_DATA_DIR: ['security', 'data_jail_directory'],
  DUCKVIEW_ALLOW_ARBITRARY_EXTENSIONS: ['security', 'allow_arbitrary_extensions'],
  DUCKVIEW_ENABLE_EXTERNAL_ACCESS: ['security', 'enable_external_access'],
  DUCKVIEW_ALLOW_REGISTRATION: ['security', 'allow_registration'],
  DATABASE_URL: ['database', 'metadata_url'],
  METADATA_URL: ['database', 'metadata_url'],
  AUTH_STRATEGY: ['auth', 'strategy'],
  OIDC_ISSUER: ['auth', 'oidc', 'issuer_url'],
  OIDC_CLIENT_ID: ['auth', 'oidc', 'client_id'],
  OIDC_CLIENT_SECRET: ['auth', 'oidc', 'client_secret'],
  OIDC_REDIRECT_URI: ['auth', 'oidc', 'redirect_uri'],
  OIDC_GROUPS_CLAIM: ['auth', 'oidc', 'groups_claim'],
  DUCKVIEW_ADMIN_EMAIL: ['auth', 'bootstrap_admin', 'email'],
  DUCKVIEW_ADMIN_PASSWORD: ['auth', 'bootstrap_admin', 'password'],
  DUCKDB_MEMORY_LIMIT: ['duckdb', 'default_memory_limit'],
  DUCKDB_THREADS: ['duckdb', 'default_threads'],
  DUCKDB_TEMP_DIRECTORY: ['duckdb', 'temp_directory'],
  DUCKDB_QUERY_TIMEOUT_SECONDS: ['duckdb', 'query_timeout_seconds'],
  DUCKDB_MAX_RESULT_ROWS: ['duckdb', 'max_result_rows'],
  DUCKVIEW_FILESYSTEM_MODE: ['security', 'filesystem_mode'],
  DUCKDB_EXTENSION_DIRECTORY: ['duckdb', 'extension_directory'],
  COPILOT_PROVIDER: ['copilot', 'provider'],
  COPILOT_MODEL: ['copilot', 'model'],
  COPILOT_API_KEY: ['copilot', 'api_key'],
  COPILOT_BASE_URL: ['copilot', 'base_url'],
  ANTHROPIC_API_KEY: ['copilot', 'api_key'],
  COPILOT_AWS_REGION: ['copilot', 'aws_region'],
  COPILOT_BEDROCK_AGENT_ID: ['copilot', 'bedrock_agent_id'],
  COPILOT_BEDROCK_AGENT_ALIAS_ID: ['copilot', 'bedrock_agent_alias_id'],
  COPILOT_AGENTCORE_RUNTIME_ARN: ['copilot', 'agentcore_runtime_arn'],
  LAKEHOUSE_STATEMENT_TIMEOUT_SECONDS: ['lakehouse', 'statement_timeout_seconds'],
  LAKEHOUSE_MAX_ROWS: ['lakehouse', 'max_rows'],
  OTEL_EXPORTER_OTLP_ENDPOINT: ['observability', 'otel', 'exporter_otlp_endpoint'],
  OTEL_SERVICE_NAME: ['observability', 'otel', 'service_name'],
  DUCKVIEW_OTEL_ENABLED: ['observability', 'otel', 'enabled'],
};

function applyEnvOverrides(raw: Raw, env: NodeJS.ProcessEnv) {
  for (const [name, keys] of Object.entries(WELL_KNOWN_ENV)) {
    const v = env[name];
    if (v !== undefined && v !== '') {
      const lastKey = keys[keys.length - 1];
      const val = lastKey === 'cors_origins' ? v.split(',').map((s) => s.trim()).filter(Boolean) : coerceEnvValue(v);
      setDeep(raw, keys, val);
    }
  }
  // Generic DUCKVIEW__section__key[__subkey]
  for (const [name, v] of Object.entries(env)) {
    if (!name.startsWith('DUCKVIEW__') || v === undefined) continue;
    const keys = name
      .slice('DUCKVIEW__'.length)
      .split('__')
      .map((k) => k.toLowerCase());
    if (keys.length >= 2) setDeep(raw, keys, coerceEnvValue(v));
  }
}

/** `${VAR:-}` placeholders expand to "" — treat that as "not set" so optional fields fall back to defaults. */
function stripEmptyStrings(obj: Raw) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === '' || v === null) delete obj[k];
    else if (typeof v === 'object' && !Array.isArray(v)) stripEmptyStrings(v as Raw);
  }
}

let cached: DuckViewConfig | null = null;

export interface LoadOptions {
  env?: NodeJS.ProcessEnv;
  configPath?: string | null;
  /** When true, does not throw if secrets are missing (generates ephemeral ones). Defaults to NODE_ENV !== 'production'. */
  allowEphemeralSecrets?: boolean;
}

export function loadConfig(opts: LoadOptions = {}): DuckViewConfig {
  const env = opts.env ?? process.env;
  const configPath = opts.configPath === undefined ? findConfigFile() : opts.configPath;
  let raw: Raw = {};
  if (configPath) {
    const text = expandEnvPlaceholders(fs.readFileSync(configPath, 'utf8'), env);
    raw = (parseYaml(text) as Raw) ?? {};
  }
  applyEnvOverrides(raw, env);
  stripEmptyStrings(raw);

  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid DuckView configuration${configPath ? ` (${configPath})` : ''}:\n${issues}`);
  }
  const cfg = parsed.data;

  const isProd = env.NODE_ENV === 'production';
  const allowEphemeral = opts.allowEphemeralSecrets ?? !isProd;
  let ephemeralSecrets = false;
  if (!cfg.security.jwt_secret) {
    if (!allowEphemeral) throw new Error('security.jwt_secret (JWT_SECRET) is required in production');
    cfg.security.jwt_secret = crypto.randomBytes(48).toString('hex');
    ephemeralSecrets = true;
  }
  if (!cfg.security.encryption_key) {
    if (!allowEphemeral) throw new Error('security.encryption_key (ENCRYPTION_KEY) is required in production');
    cfg.security.encryption_key = crypto.randomBytes(32).toString('hex');
    ephemeralSecrets = true;
  }
  cfg.security.data_jail_directory = path.resolve(cfg.security.data_jail_directory);
  if (cfg.duckdb.extension_directory) cfg.duckdb.extension_directory = path.resolve(cfg.duckdb.extension_directory);
  cfg.duckdb.temp_directory = path.resolve(cfg.duckdb.temp_directory);
  // Data apps run Python: on by default only where analysts already own the machine's filesystem.
  if (cfg.apps.enabled === undefined) cfg.apps.enabled = cfg.security.filesystem_mode === 'full';
  cfg.apps.venv_dir = path.resolve(cfg.apps.venv_dir ?? path.join(cfg.security.data_jail_directory, '.duckview', 'apps', 'venv'));
  cfg.apps.port ??= cfg.server.port + 1;
  cfg.transform.dbt.venv_dir = path.resolve(cfg.transform.dbt.venv_dir ?? path.join(cfg.security.data_jail_directory, '.duckview', 'dbt', 'venv'));
  if (cfg.apps.public_url) cfg.apps.public_url = cfg.apps.public_url.replace(/\/+$/, '');

  if (cfg.auth.strategy === 'oidc') {
    const o = cfg.auth.oidc;
    if (!o.issuer_url || !o.client_id || !o.client_secret) {
      throw new Error('auth.strategy=oidc requires auth.oidc.issuer_url, client_id and client_secret');
    }
  }

  return { ...cfg, ephemeralSecrets, configPath } as DuckViewConfig;
}

export function getConfig(): DuckViewConfig {
  if (!cached) cached = loadConfig();
  return cached;
}

export function setConfig(cfg: DuckViewConfig) {
  cached = cfg;
}

/** Redacts secrets for display in logs / admin UI. */
export function redactConfig(cfg: DuckViewConfig): Record<string, unknown> {
  return {
    ...cfg,
    security: { ...cfg.security, jwt_secret: '***', encryption_key: '***' },
    copilot: { ...cfg.copilot, api_key: cfg.copilot.api_key ? '***' : undefined },
    auth: { ...cfg.auth, oidc: { ...cfg.auth.oidc, client_secret: cfg.auth.oidc.client_secret ? '***' : undefined }, bootstrap_admin: { email: cfg.auth.bootstrap_admin.email, password: cfg.auth.bootstrap_admin.password ? '***' : undefined }, scim: { ...cfg.auth.scim, token: cfg.auth.scim.token ? '***' : undefined } },
    database: { ...cfg.database, metadata_url: cfg.database.metadata_url.replace(/\/\/([^:]+):[^@]+@/, '//$1:***@') },
  };
}
