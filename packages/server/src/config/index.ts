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
      /** 'sandboxed' (multi-tenant: file access confined to data_jail_directory) or 'full' (single-user: whole host filesystem). */
      filesystem_mode: z.enum(['sandboxed', 'full']).default('sandboxed'),
      allow_arbitrary_extensions: z.coerce.boolean().default(false),
      allowed_extensions: z.array(z.string()).default(['parquet', 'json', 'icu', 'httpfs', 'iceberg', 'delta', 'motherduck', 'postgres', 'spatial', 'excel']),
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
  copilot: z
    .object({
      enabled: z.coerce.boolean().default(true),
      /** Server-managed default provider. Users may still bring their own key when allow_byok is true. */
      provider: z.enum(['anthropic', 'openai', 'ollama', 'none']).default('none'),
      model: z.string().optional(),
      api_key: z.string().optional(),
      /** OpenAI-compatible or Ollama base URL (e.g. http://ollama:11434). */
      base_url: z.string().optional(),
      allow_byok: z.coerce.boolean().default(true),
      max_context_tables: z.coerce.number().int().min(1).default(40),
      include_summaries: z.coerce.boolean().default(true),
      max_output_tokens: z.coerce.number().int().min(256).default(4096),
      temperature: z.coerce.number().min(0).max(2).default(0.2),
      history_limit: z.coerce.number().int().min(1).default(20),
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
  if (cfg.security.filesystem_mode === 'full' && env.NODE_ENV === 'production' && !env.DUCKVIEW_ALLOW_FULL_FS) {
    throw new Error('security.filesystem_mode=full exposes the whole host filesystem; set DUCKVIEW_ALLOW_FULL_FS=1 to confirm this is a single-user deployment');
  }
  if (cfg.duckdb.extension_directory) cfg.duckdb.extension_directory = path.resolve(cfg.duckdb.extension_directory);
  cfg.duckdb.temp_directory = path.resolve(cfg.duckdb.temp_directory);

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
    auth: { ...cfg.auth, oidc: { ...cfg.auth.oidc, client_secret: cfg.auth.oidc.client_secret ? '***' : undefined }, bootstrap_admin: { email: cfg.auth.bootstrap_admin.email, password: cfg.auth.bootstrap_admin.password ? '***' : undefined } },
    database: { ...cfg.database, metadata_url: cfg.database.metadata_url.replace(/\/\/([^:]+):[^@]+@/, '//$1:***@') },
  };
}
