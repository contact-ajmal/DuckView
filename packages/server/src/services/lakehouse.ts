/**
 * Lakehouse connections: Iceberg catalogs that DuckDB attaches natively (AWS Glue / SageMaker Lakehouse, S3 Tables,
 * any Iceberg REST catalog, Databricks Unity Catalog via its Iceberg REST endpoint) and Databricks SQL warehouses
 * (remote execution through the Statement Execution API, with one-click materialisation into DuckDB).
 *
 *  - Credentials are AES-256-GCM encrypted at rest (row id as AAD) and never returned by the API.
 *  - Attached catalogs are queryable as  alias.schema.table  in every workspace of the owner; secrets + ATTACH are
 *    hot-applied to running engines (no restart, no loss of in-memory tables).
 *  - Browsing is lazy: DuckDB lists namespaces/tables from the REST catalog without loading table metadata.
 */
import { eq, and, desc } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import type { DuckViewConfig } from '../config/index.js';
import type { MetadataStore } from '../db/index.js';
import type { LakehouseConnection, LakehouseProvider, LakehouseConfig } from '../db/schema/sqlite.js';
import { LAKEHOUSE_PROVIDERS } from '../db/schema/sqlite.js';
import { CredentialCipher, newId } from '../security/crypto.js';
import { attachToSql, secretToSql, sqlString, type AttachSpec, type SecretSpec, type EngineManager } from '../engine/duckdb.js';
import type { QueryResult } from '../engine/results.js';
import { badRequest, notFound, forbidden, HttpError } from './errors.js';
import type { WorkspaceService } from './workspaces.js';
import type { AuditService } from './audit.js';
import type { Principal } from './principal.js';
import { requireScope, canWrite } from './principal.js';
import { DatabricksClient, isIcebergReadable, type UcTable } from './databricks.js';
import { logger } from '../observability/logger.js';
import { liveEvents } from '../observability/events.js';

export type PublicLakehouseConnection = Omit<LakehouseConnection, 'encrypted_credentials' | 'iv' | 'tag'> & {
  credential_fields: string[];
  /** true when DuckDB attaches this catalog (query as alias.schema.table). */
  attached: boolean;
  /** true when SQL can be executed remotely (Databricks SQL warehouse). */
  remote_sql: boolean;
  example_sql: string;
};

export interface LakehouseEntry {
  name: string;
  type: 'catalog' | 'schema' | 'table' | 'view';
  /** Fully-qualified name to use in SQL. */
  qualified?: string;
  /** duckdb → query with DuckDB (attached catalog); remote → run on the connection's SQL warehouse. */
  engine?: 'duckdb' | 'remote';
  format?: string | null;
  comment?: string | null;
}

export interface LakehouseBrowse {
  connection: { id: string; name: string; provider: LakehouseProvider; alias: string };
  level: 'catalogs' | 'schemas' | 'tables';
  catalog: string | null;
  schema: string | null;
  entries: LakehouseEntry[];
  attach_error: string | null;
}

export const LAKEHOUSE_PROVIDER_META: Record<LakehouseProvider, { title: string; blurb: string; docs: string; attachable: boolean; remote_sql: boolean }> = {
  AWS_GLUE: { title: 'AWS Glue / SageMaker Lakehouse', blurb: 'Iceberg tables registered in the Glue Data Catalog (incl. SageMaker Lakehouse catalogs), attached through the Glue Iceberg REST endpoint with SigV4.', docs: 'https://duckdb.org/docs/stable/core_extensions/iceberg/amazon_sagemaker_lakehouse', attachable: true, remote_sql: false },
  AWS_S3_TABLES: { title: 'Amazon S3 Tables', blurb: 'A table bucket (Iceberg-native S3 Tables), attached by ARN with SigV4.', docs: 'https://duckdb.org/docs/stable/core_extensions/iceberg/amazon_s3_tables', attachable: true, remote_sql: false },
  ICEBERG_REST: { title: 'Iceberg REST catalog', blurb: 'Polaris, Lakekeeper, Nessie, Snowflake Open Catalog, Tabular, Unity Catalog IRC — bearer token or OAuth2 client credentials.', docs: 'https://duckdb.org/docs/stable/core_extensions/iceberg/iceberg_rest_catalogs', attachable: true, remote_sql: false },
  DATABRICKS: { title: 'Databricks', blurb: 'Browse Unity Catalog, run SQL on a SQL warehouse and materialise results into DuckDB; UniForm/Iceberg tables can also be attached for native DuckDB queries.', docs: 'https://docs.databricks.com/api/workspace/statementexecution', attachable: true, remote_sql: true },
};

const ALIAS_RE = /^[a-z_][a-z0-9_]{0,62}$/;
const RESERVED_ALIASES = new Set(['main', 'memory', 'system', 'temp', 'information_schema', 'pg_catalog']);

export function aliasFromName(name: string): string {
  const a = name
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  const base = /^[a-z_]/.test(a) ? a : `lh_${a}`;
  return base || 'lakehouse';
}

/** Which credential keys a provider/auth mode needs. */
export function credentialFieldsFor(provider: LakehouseProvider, cfg: LakehouseConfig): { required: string[]; optional: string[] } {
  switch (provider) {
    case 'AWS_GLUE':
    case 'AWS_S3_TABLES':
      return cfg.aws_auth === 'credential_chain' ? { required: [], optional: [] } : { required: ['access_key_id', 'secret_access_key'], optional: ['session_token'] };
    case 'ICEBERG_REST':
      return cfg.auth === 'oauth2' ? { required: ['client_id', 'client_secret'], optional: [] } : cfg.auth === 'none' ? { required: [], optional: [] } : { required: ['token'], optional: [] };
    case 'DATABRICKS':
      return cfg.databricks_auth === 'oauth_m2m' ? { required: ['client_id', 'client_secret'], optional: [] } : { required: ['token'], optional: [] };
  }
}

function validateConfig(provider: LakehouseProvider, c: LakehouseConfig): LakehouseConfig {
  const out: LakehouseConfig = {};
  const str = (k: keyof LakehouseConfig) => (typeof c[k] === 'string' ? (c[k] as string).trim() : '');
  switch (provider) {
    case 'AWS_GLUE': {
      out.region = str('region');
      out.account_id = str('account_id');
      out.catalog = str('catalog').replace(/^\/+|\/+$/g, '');
      out.aws_auth = c.aws_auth === 'credential_chain' ? 'credential_chain' : 'keys';
      if (!out.region) throw badRequest('AWS region is required');
      if (!/^\d{12}$/.test(out.account_id)) throw badRequest('AWS account id must be the 12-digit account number');
      break;
    }
    case 'AWS_S3_TABLES': {
      out.region = str('region');
      out.table_bucket_arn = str('table_bucket_arn');
      out.aws_auth = c.aws_auth === 'credential_chain' ? 'credential_chain' : 'keys';
      const m = /^arn:aws[a-z-]*:s3tables:([a-z0-9-]+):(\d{12}):bucket\/[a-z0-9._-]+$/.exec(out.table_bucket_arn);
      if (!m) throw badRequest('table_bucket_arn must look like arn:aws:s3tables:<region>:<account>:bucket/<name>');
      if (!out.region) out.region = m[1]!;
      break;
    }
    case 'ICEBERG_REST': {
      out.endpoint = str('endpoint').replace(/\/+$/, '');
      out.warehouse = str('warehouse');
      out.auth = c.auth === 'oauth2' ? 'oauth2' : c.auth === 'none' ? 'none' : 'bearer';
      out.oauth2_server_uri = str('oauth2_server_uri');
      out.oauth2_scope = str('oauth2_scope');
      out.nested_namespaces = !!c.nested_namespaces;
      out.region = str('region');
      if (!/^https?:\/\/[^\s/]+/i.test(out.endpoint)) throw badRequest('endpoint must be an http(s) URL (e.g. https://polaris.example.com/api/catalog)');
      break;
    }
    case 'DATABRICKS': {
      const host = str('host').replace(/\/+$/, '');
      out.host = /^https?:\/\//i.test(host) ? host : host ? `https://${host}` : '';
      // Accept a pasted HTTP path (/sql/1.0/warehouses/<id>) and reduce it to the id.
      out.warehouse_id = str('warehouse_id').replace(/^.*\/warehouses\//, '').trim();
      out.unity_catalog = str('unity_catalog');
      out.databricks_auth = c.databricks_auth === 'oauth_m2m' ? 'oauth_m2m' : 'pat';
      out.attach_iceberg = !!c.attach_iceberg && !!out.unity_catalog;
      if (!/^https?:\/\/[^\s/]+$/i.test(out.host)) throw badRequest('host must be the workspace URL, e.g. https://dbc-1234-abcd.cloud.databricks.com');
      if (/^\d{10,}$/.test(out.warehouse_id)) throw badRequest(`"${out.warehouse_id}" looks like the numeric workspace id (the ?o=… value in Databricks URLs), not a SQL warehouse id. Use the 16-character hex id from the warehouse's Connection details (last segment of /sql/1.0/warehouses/<id>), or click Find.`);
      if (out.warehouse_id && !/^[A-Za-z0-9_-]{4,64}$/.test(out.warehouse_id)) throw badRequest(`"${out.warehouse_id}" is not a valid SQL warehouse id`);
      if (!out.warehouse_id && !out.attach_iceberg) throw badRequest('Provide a SQL warehouse id, or a Unity Catalog name with "attach Iceberg" to query natively');
      break;
    }
  }
  return out;
}

/** Secrets + ATTACH statements for a connection. Pure; exported for tests. */
export function lakehouseEngineBits(c: Pick<LakehouseConnection, 'id' | 'provider' | 'alias' | 'config'>, creds: Record<string, string>): { secrets: SecretSpec[]; attachments: AttachSpec[] } {
  const short = c.id.replace(/[^A-Za-z0-9]/g, '').slice(0, 8);
  const cfg = c.config;
  switch (c.provider) {
    case 'AWS_GLUE':
    case 'AWS_S3_TABLES': {
      const secretName = `lh_${short}_s3`;
      const values: Record<string, string> = cfg.aws_auth === 'credential_chain' ? { provider: 'credential_chain', region: cfg.region ?? '' } : { access_key_id: creds.access_key_id ?? '', secret_access_key: creds.secret_access_key ?? '', ...(creds.session_token ? { session_token: creds.session_token } : {}), region: cfg.region ?? '' };
      const secrets: SecretSpec[] = [{ name: secretName, type: 'S3', values }];
      const extensions = ['httpfs', 'iceberg', ...(cfg.aws_auth === 'credential_chain' ? ['aws'] : [])];
      if (c.provider === 'AWS_GLUE') {
        const target = cfg.catalog ? `${cfg.account_id}:${cfg.catalog}` : String(cfg.account_id ?? '');
        return { secrets, attachments: [{ alias: c.alias, target, options: { endpoint_type: 'glue', secret: secretName }, extensions }] };
      }
      return { secrets, attachments: [{ alias: c.alias, target: String(cfg.table_bucket_arn ?? ''), options: { endpoint_type: 's3_tables', secret: secretName }, extensions }] };
    }
    case 'ICEBERG_REST': {
      const options: Record<string, string | boolean> = { endpoint: cfg.endpoint ?? '' };
      const secrets: SecretSpec[] = [];
      if (cfg.auth === 'none') options.authorization_type = 'none';
      else {
        const secretName = `lh_${short}_irc`;
        options.secret = secretName;
        if (cfg.auth === 'oauth2') secrets.push({ name: secretName, type: 'ICEBERG', values: { client_id: creds.client_id ?? '', client_secret: creds.client_secret ?? '', oauth2_server_uri: cfg.oauth2_server_uri || `${cfg.endpoint}/v1/oauth/tokens`, ...(cfg.oauth2_scope ? { oauth2_scope: cfg.oauth2_scope } : {}) } });
        else secrets.push({ name: secretName, type: 'ICEBERG', values: { token: creds.token ?? '' } });
      }
      if (cfg.nested_namespaces) options.support_nested_namespaces = true;
      if (cfg.region) options.default_region = cfg.region;
      return { secrets, attachments: [{ alias: c.alias, target: cfg.warehouse ?? '', options, extensions: ['httpfs', 'iceberg'] }] };
    }
    case 'DATABRICKS': {
      if (!cfg.attach_iceberg || !cfg.unity_catalog) return { secrets: [], attachments: [] };
      const secretName = `lh_${short}_dbx`;
      const secret: SecretSpec =
        cfg.databricks_auth === 'oauth_m2m'
          ? { name: secretName, type: 'ICEBERG', values: { client_id: creds.client_id ?? '', client_secret: creds.client_secret ?? '', oauth2_server_uri: `${cfg.host}/oidc/v1/token`, oauth2_scope: 'all-apis' } }
          : { name: secretName, type: 'ICEBERG', values: { token: creds.token ?? '' } };
      return { secrets: [secret], attachments: [{ alias: c.alias, target: cfg.unity_catalog, options: { endpoint: `${cfg.host}/api/2.1/unity-catalog/iceberg-rest`, secret: secretName }, extensions: ['httpfs', 'iceberg'] }] };
    }
  }
}

const READ_ONLY_RE = /^\s*(select|with|show|describe|desc|explain|values|table)\b/i;

export class LakehouseService {
  workspaces!: WorkspaceService;
  audit!: AuditService;

  constructor(private readonly cfg: DuckViewConfig, private readonly store: MetadataStore, private readonly cipher: CredentialCipher, private readonly engines: EngineManager) {}

  bind(workspaces: WorkspaceService, audit: AuditService) {
    this.workspaces = workspaces;
    this.audit = audit;
    workspaces.lakehouse = this;
  }

  private get db() {
    return this.store.db;
  }
  private get s() {
    return this.store.schema;
  }

  get externalAccess(): boolean {
    return this.cfg.security.enable_external_access || this.cfg.security.filesystem_mode === 'full';
  }

  private decrypt(c: LakehouseConnection): Record<string, string> {
    return this.cipher.decryptJson<Record<string, string>>({ ciphertext: c.encrypted_credentials, iv: c.iv, tag: c.tag }, c.id);
  }

  toPublic(c: LakehouseConnection): PublicLakehouseConnection {
    const { encrypted_credentials: _e, iv: _i, tag: _t, ...rest } = c;
    let fields: string[] = [];
    try {
      fields = Object.keys(this.decrypt(c));
    } catch {
      fields = ['<undecryptable — encryption key changed?>'];
    }
    const attached = c.provider !== 'DATABRICKS' || !!c.config.attach_iceberg;
    const remote = c.provider === 'DATABRICKS' && !!c.config.warehouse_id;
    const example = attached ? `SELECT * FROM ${c.alias}.<schema>.<table> LIMIT 100;` : `-- runs on the Databricks SQL warehouse\nSELECT * FROM ${c.config.unity_catalog || '<catalog>'}.<schema>.<table> LIMIT 100;`;
    return { ...rest, credential_fields: fields, attached, remote_sql: remote, example_sql: example };
  }

  providers() {
    return { providers: LAKEHOUSE_PROVIDER_META, external_access_enabled: this.externalAccess };
  }

  async list(userId: string): Promise<PublicLakehouseConnection[]> {
    const rows = await this.db.select().from(this.s.lakehouseConnections).where(eq(this.s.lakehouseConnections.user_id, userId)).orderBy(desc(this.s.lakehouseConnections.created_at));
    return rows.map((r) => this.toPublic(r));
  }

  async getOwned(userId: string, id: string): Promise<LakehouseConnection> {
    const rows = await this.db
      .select()
      .from(this.s.lakehouseConnections)
      .where(and(eq(this.s.lakehouseConnections.id, id), eq(this.s.lakehouseConnections.user_id, userId)))
      .limit(1);
    if (!rows[0]) throw notFound('Lakehouse connection');
    return rows[0];
  }

  private async assertAliasFree(userId: string, alias: string, exceptId?: string) {
    if (!ALIAS_RE.test(alias)) throw badRequest('alias must be lowercase letters, digits and underscores (max 63), starting with a letter');
    if (RESERVED_ALIASES.has(alias)) throw badRequest(`alias "${alias}" is reserved`);
    const rows = await this.db.select({ id: this.s.lakehouseConnections.id }).from(this.s.lakehouseConnections).where(and(eq(this.s.lakehouseConnections.user_id, userId), eq(this.s.lakehouseConnections.alias, alias)));
    if (rows.some((r) => r.id !== exceptId)) throw badRequest(`alias "${alias}" is already used by another lakehouse connection`);
  }

  async create(userId: string, input: { name: string; provider: LakehouseProvider; alias?: string | null; config: LakehouseConfig; credentials: Record<string, string> }): Promise<PublicLakehouseConnection> {
    if (!(LAKEHOUSE_PROVIDERS as readonly string[]).includes(input.provider)) throw badRequest(`Unsupported lakehouse provider: ${input.provider}`);
    const name = (input.name ?? '').trim() || LAKEHOUSE_PROVIDER_META[input.provider].title;
    const config = validateConfig(input.provider, input.config ?? {});
    const alias = (input.alias ?? '').trim().toLowerCase() || aliasFromName(name);
    await this.assertAliasFree(userId, alias);
    const spec = credentialFieldsFor(input.provider, config);
    const creds: Record<string, string> = {};
    for (const k of [...spec.required, ...spec.optional]) {
      const v = input.credentials?.[k];
      if (v !== undefined && v !== null && String(v).trim() !== '') creds[k] = String(v).trim();
    }
    const missing = spec.required.filter((k) => !creds[k]);
    if (missing.length) throw badRequest(`Missing required credentials for ${input.provider}: ${missing.join(', ')}`);
    const id = newId();
    const enc = this.cipher.encryptJson(creds, id);
    const now = new Date();
    const record: LakehouseConnection = { id, user_id: userId, name, provider: input.provider, alias, config, encrypted_credentials: enc.ciphertext, iv: enc.iv, tag: enc.tag, status: 'unknown', last_error: null, last_tested_at: null, created_at: now, updated_at: now };
    await this.db.insert(this.s.lakehouseConnections).values(record);
    await this.workspaces?.bumpOwnerWorkspaces(userId, 'lakehouse_added');
    return this.toPublic(record);
  }

  async update(userId: string, id: string, patch: { name?: string; alias?: string; config?: LakehouseConfig; credentials?: Record<string, string> }): Promise<PublicLakehouseConnection> {
    const existing = await this.getOwned(userId, id);
    const set: Partial<LakehouseConnection> = { updated_at: new Date(), status: 'unknown', last_error: null };
    if (patch.name !== undefined) set.name = patch.name.trim() || existing.name;
    if (patch.alias !== undefined) {
      const alias = patch.alias.trim().toLowerCase();
      await this.assertAliasFree(userId, alias, id);
      set.alias = alias;
    }
    if (patch.config !== undefined) set.config = validateConfig(existing.provider, { ...existing.config, ...patch.config });
    if (patch.credentials && Object.keys(patch.credentials).length) {
      const merged = { ...this.decrypt(existing) };
      const spec = credentialFieldsFor(existing.provider, set.config ?? existing.config);
      for (const k of [...spec.required, ...spec.optional]) {
        const v = patch.credentials[k];
        if (v !== undefined && String(v).trim() !== '') merged[k] = String(v).trim();
      }
      const enc = this.cipher.encryptJson(merged, id);
      set.encrypted_credentials = enc.ciphertext;
      set.iv = enc.iv;
      set.tag = enc.tag;
    }
    await this.db.update(this.s.lakehouseConnections).set(set).where(eq(this.s.lakehouseConnections.id, id));
    await this.workspaces?.bumpOwnerWorkspaces(userId, 'lakehouse_changed');
    return this.toPublic({ ...existing, ...set });
  }

  async remove(userId: string, id: string): Promise<void> {
    const r = await this.db
      .delete(this.s.lakehouseConnections)
      .where(and(eq(this.s.lakehouseConnections.id, id), eq(this.s.lakehouseConnections.user_id, userId)))
      .returning({ id: this.s.lakehouseConnections.id });
    if (r.length === 0) throw notFound('Lakehouse connection');
    // Results computed through the attached catalog (or its alias) must not outlive the connection.
    await this.workspaces?.bumpOwnerWorkspaces(userId, 'lakehouse_removed');
  }

  /** Secrets + attachments for every connection the user owns (merged into each workspace engine spec). */
  async resolveEngineBits(userId: string): Promise<{ secrets: SecretSpec[]; attachments: AttachSpec[] }> {
    const rows = await this.db.select().from(this.s.lakehouseConnections).where(eq(this.s.lakehouseConnections.user_id, userId));
    const out = { secrets: [] as SecretSpec[], attachments: [] as AttachSpec[] };
    for (const c of rows) {
      try {
        const bits = lakehouseEngineBits(c, this.decrypt(c));
        out.secrets.push(...bits.secrets);
        out.attachments.push(...bits.attachments);
      } catch (err) {
        logger().warn({ id: c.id, err: (err as Error).message }, 'Skipping undecryptable lakehouse connection');
      }
    }
    return out;
  }

  private databricks(c: LakehouseConnection): DatabricksClient {
    const creds = this.decrypt(c);
    return new DatabricksClient(c.config.host ?? '', c.config.databricks_auth === 'oauth_m2m' ? { client_id: creds.client_id, client_secret: creds.client_secret } : { token: creds.token }, { timeoutMs: this.cfg.lakehouse.statement_timeout_seconds * 1000, pollIntervalMs: this.cfg.lakehouse.poll_interval_ms });
  }

  /**
   * Verifies the connection: attaches the catalog in a throwaway DuckDB instance and counts its schemas; for Databricks,
   * lists Unity Catalog schemas and checks the warehouse state. Persists status/last_error.
   */
  async test(userId: string, id: string): Promise<{ ok: boolean; message: string; schemas: number; example_sql: string }> {
    const c = await this.getOwned(userId, id);
    const messages: string[] = [];
    let schemas = 0;
    try {
      if (c.provider === 'DATABRICKS') {
        const client = this.databricks(c);
        if (c.config.unity_catalog) {
          const list = await client.listSchemas(c.config.unity_catalog);
          schemas = list.length;
          messages.push(`Unity Catalog "${c.config.unity_catalog}" · ${schemas} schema(s)`);
        } else {
          const cats = await client.listCatalogs();
          messages.push(`${cats.length} Unity Catalog catalog(s) visible`);
        }
        if (c.config.warehouse_id) {
          const wh = await client.warehouse(c.config.warehouse_id);
          messages.push(`warehouse ${wh.name ?? wh.id} ${wh.state ?? 'reachable'}`);
        }
      }
      const bits = lakehouseEngineBits(c, this.decrypt(c));
      if (bits.attachments.length) {
        if (!this.externalAccess) throw new HttpError(409, 'External access is disabled on this server (security.enable_external_access=false); the catalog can be configured but not attached.', 'LAKEHOUSE_EXTERNAL_ACCESS_DISABLED');
        schemas = await this.probeAttach(bits);
        messages.push(`attached in DuckDB as "${c.alias}" · ${schemas} schema(s)`);
      }
      const now = new Date();
      await this.db.update(this.s.lakehouseConnections).set({ status: 'ok', last_error: null, last_tested_at: now, updated_at: now }).where(eq(this.s.lakehouseConnections.id, id));
      // Engines that already tried (and failed) this alias get another go with the same spec.
      for (const e of this.engines.all()) if (e.attachErrors.has(c.alias)) void e.retryAttachment(c.alias).catch(() => undefined);
      return { ok: true, message: `Connected · ${messages.join(' · ')}`, schemas, example_sql: this.toPublic(c).example_sql };
    } catch (err) {
      const msg = err instanceof HttpError ? err.message : ((err as Error).message ?? String(err)).split('\n')[0]!;
      const now = new Date();
      await this.db.update(this.s.lakehouseConnections).set({ status: 'error', last_error: msg.slice(0, 2000), last_tested_at: now, updated_at: now }).where(eq(this.s.lakehouseConnections.id, id));
      if (err instanceof HttpError) throw err;
      throw new HttpError(/403|401|Forbidden|Unauthorized|AccessDenied|InvalidAccessKeyId|SignatureDoesNotMatch/i.test(msg) ? 403 : 502, `${LAKEHOUSE_PROVIDER_META[c.provider].title}: ${msg}`, /403|401|Forbidden|Unauthorized|AccessDenied/i.test(msg) ? 'LAKEHOUSE_AUTH_FAILED' : 'LAKEHOUSE_ERROR');
    }
  }

  private async probeAttach(bits: { secrets: SecretSpec[]; attachments: AttachSpec[] }): Promise<number> {
    const options: Record<string, string> = { autoinstall_known_extensions: 'true', autoload_known_extensions: 'true', threads: '2', memory_limit: '256MB' };
    if (this.cfg.duckdb.extension_directory) options.extension_directory = this.cfg.duckdb.extension_directory;
    const inst = await DuckDBInstance.create(':memory:', options);
    const conn = await inst.connect();
    const timer = setTimeout(() => conn.interrupt(), 60_000);
    try {
      const exts = new Set(bits.attachments.flatMap((a) => a.extensions));
      for (const ext of exts) {
        await conn.run(`LOAD ${ext}`).catch(async () => {
          await conn.run(`INSTALL ${ext}`);
          await conn.run(`LOAD ${ext}`);
        });
      }
      for (const s of bits.secrets) {
        const sql = secretToSql(s);
        if (sql) await conn.run(sql);
      }
      let schemas = 0;
      for (const a of bits.attachments) {
        await conn.run(attachToSql(a, false));
        const r = await conn.runAndReadAll(`SELECT count(*) AS n FROM duckdb_schemas() WHERE database_name = ${sqlString(a.alias)} AND NOT internal`);
        schemas += Number(r.getRowsJson()[0]?.[0] ?? 0);
      }
      return schemas;
    } finally {
      clearTimeout(timer);
      try {
        conn.closeSync();
      } catch {
        /* ignore */
      }
      inst.closeSync();
    }
  }

  // ---------------------------------------------------------------- browsing

  async browse(p: Principal, workspaceId: string, id: string, opts: { catalog?: string | null; schema?: string | null }): Promise<LakehouseBrowse> {
    requireScope(p, 'read');
    const c = await this.getOwned(p.userId, id);
    const base = { connection: { id: c.id, name: c.name, provider: c.provider, alias: c.alias }, attach_error: null as string | null };
    if (c.provider === 'DATABRICKS') {
      const client = this.databricks(c);
      const catalog = c.config.unity_catalog || opts.catalog || null;
      let attachError: string | null = null;
      if (c.config.attach_iceberg) {
        const { engine } = await this.workspaces.engine(p, workspaceId);
        attachError = engine.attachErrors.get(c.alias) ?? null;
      }
      if (!catalog) {
        const cats = await client.listCatalogs();
        return { ...base, level: 'catalogs', catalog: null, schema: null, entries: cats.map((x) => ({ name: x.name, type: 'catalog', comment: x.comment ?? null })), attach_error: attachError };
      }
      if (!opts.schema) {
        const schemas = await client.listSchemas(catalog);
        return { ...base, level: 'schemas', catalog, schema: null, entries: schemas.map((x) => ({ name: x.name, type: 'schema', comment: x.comment ?? null })), attach_error: attachError };
      }
      const tables = await client.listTables(catalog, opts.schema);
      const attached = !!c.config.attach_iceberg && catalog === c.config.unity_catalog && !attachError;
      const remote = !!c.config.warehouse_id;
      const entries: LakehouseEntry[] = tables.map((t: UcTable) => {
        const viaDuck = attached && isIcebergReadable(t) && t.table_type !== 'VIEW';
        const engine: LakehouseEntry['engine'] | undefined = viaDuck ? 'duckdb' : remote ? 'remote' : undefined;
        return { name: t.name, type: t.table_type === 'VIEW' ? 'view' : 'table', qualified: viaDuck ? `${c.alias}.${quoteIdent(opts.schema!)}.${quoteIdent(t.name)}` : `${quoteIdent(catalog)}.${quoteIdent(opts.schema!)}.${quoteIdent(t.name)}`, engine, format: t.data_source_format ?? null, comment: t.comment ?? null };
      });
      return { ...base, level: 'tables', catalog, schema: opts.schema, entries, attach_error: attachError };
    }
    const { engine } = await this.workspaces.engine(p, workspaceId);
    const attachError = engine.attachErrors.get(c.alias) ?? null;
    if (attachError) return { ...base, level: opts.schema ? 'tables' : 'schemas', catalog: c.alias, schema: opts.schema ?? null, entries: [], attach_error: attachError };
    const tree = await engine.lakehouseTree(c.alias, opts.schema ?? undefined);
    if (!opts.schema) return { ...base, level: 'schemas', catalog: c.alias, schema: null, entries: tree.schemas.map((name) => ({ name, type: 'schema' })), attach_error: null };
    return { ...base, level: 'tables', catalog: c.alias, schema: opts.schema, entries: tree.tables.map((t) => ({ name: t.name, type: 'table', qualified: `${c.alias}.${quoteIdent(t.schema)}.${quoteIdent(t.name)}`, engine: 'duckdb', format: 'ICEBERG' })), attach_error: null };
  }

  /**
   * Lists SQL warehouses so the wizard can pick one. Credentials come from a saved connection (id) or are passed
   * once for a connection being created (never stored).
   */
  async listWarehouses(userId: string, input: { connection_id?: string; host?: string; databricks_auth?: 'pat' | 'oauth_m2m'; credentials?: Record<string, string> }) {
    let client: DatabricksClient;
    if (input.connection_id) {
      const c = await this.getOwned(userId, input.connection_id);
      if (c.provider !== 'DATABRICKS') throw badRequest('Not a Databricks connection');
      client = this.databricks(c);
    } else {
      const host = (input.host ?? '').trim();
      if (!host) throw badRequest('host is required');
      const creds = input.credentials ?? {};
      client = new DatabricksClient(host, input.databricks_auth === 'oauth_m2m' ? { client_id: creds.client_id, client_secret: creds.client_secret } : { token: creds.token }, { timeoutMs: 30_000 });
    }
    return { warehouses: await client.listWarehouses() };
  }

  /** Column list for a Databricks table that is not attached in DuckDB (Unity Catalog metadata). */
  async inspectRemote(p: Principal, id: string, fullName: string) {
    requireScope(p, 'read');
    const c = await this.getOwned(p.userId, id);
    if (c.provider !== 'DATABRICKS') throw badRequest('Remote inspection is only available for Databricks connections; attached catalogs use /api/storage/inspect');
    const t = await this.databricks(c).getTable(fullName.replace(/`/g, ''));
    const columns = (t.columns ?? []).sort((a, b) => (a.position ?? 0) - (b.position ?? 0)).map((col) => ({ name: col.name, type: col.type_text || col.type_name, nullable: col.nullable ?? true }));
    return { target: fullName, kind: 'remote' as const, engine: 'remote' as const, format: t.data_source_format ?? null, table_type: t.table_type ?? null, iceberg_readable: isIcebergReadable(t), columns, row_count: null, row_count_source: null, size_bytes: null, suggested_sql: `SELECT * FROM ${fullName} LIMIT 100` };
  }

  // ---------------------------------------------------------------- remote SQL

  private assertRemoteAllowed(p: Principal, c: LakehouseConnection, sql: string, dryRun?: boolean) {
    if (!c.config.warehouse_id) throw badRequest(`Connection "${c.name}" has no SQL warehouse configured; query attached tables with DuckDB instead`);
    const readOnly = READ_ONLY_RE.test(sql);
    if (!readOnly && !canWrite(p)) throw forbidden('Only read statements may be sent to the warehouse with your role/scopes');
    if (!readOnly && p.actorType === 'AGENT' && this.cfg.mcp.require_confirmation_for_mutations && dryRun !== false) {
      throw new HttpError(409, `This statement is not a read-only query; a human must approve it. Re-issue with dry_run=false after approval.`, 'APPROVAL_REQUIRED');
    }
  }

  /** Executes SQL on the connection's Databricks SQL warehouse and returns rows in DuckView's result shape. */
  async query(p: Principal, id: string, sql: string, opts: { maxRows?: number; dryRun?: boolean; signal?: AbortSignal; workspaceId?: string } = {}): Promise<QueryResult & { engine: 'databricks'; statement_id: string }> {
    requireScope(p, 'read');
    const c = await this.getOwned(p.userId, id);
    if (c.provider !== 'DATABRICKS') throw badRequest('Remote SQL execution is only available for Databricks connections');
    const text = sql.trim();
    if (!text) throw badRequest('sql is required');
    this.assertRemoteAllowed(p, c, text, opts.dryRun);
    const rowLimit = Math.max(1, Math.min(opts.maxRows ?? this.cfg.lakehouse.max_rows, this.cfg.lakehouse.max_rows));
    const started = performance.now();
    liveEvents.publish({ type: 'query', at: new Date().toISOString(), user_id: p.userId, actor: p.actorType, workspace_id: opts.workspaceId ?? '', status: 'started', sql: text.slice(0, 2000) });
    try {
      const r = await this.databricks(c).execute(text, { warehouseId: c.config.warehouse_id!, rowLimit, signal: opts.signal, catalog: c.config.unity_catalog || undefined });
      this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'lakehouse.query', resource: `lakehouse:${c.id}`, queryText: text.slice(0, 4000), durationMs: r.durationMs, ip: p.ip });
      liveEvents.publish({ type: 'query', at: new Date().toISOString(), user_id: p.userId, actor: p.actorType, workspace_id: opts.workspaceId ?? '', status: 'done', sql: text.slice(0, 2000), duration_ms: r.durationMs });
      return { columns: r.columns, rows: r.rows, rowCount: r.rowCount, totalRows: r.totalRows, truncated: r.truncated, rowsChanged: null, durationMs: r.durationMs, statementCount: 1, statementClass: READ_ONLY_RE.test(text) ? 'SELECT' : 'STATEMENT', engine: 'databricks', statement_id: r.statementId };
    } catch (err) {
      const e = err as Error;
      this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'lakehouse.query', resource: `lakehouse:${c.id}`, queryText: text.slice(0, 4000), durationMs: performance.now() - started, ip: p.ip, status: 'error', error: e.message });
      liveEvents.publish({ type: 'query', at: new Date().toISOString(), user_id: p.userId, actor: p.actorType, workspace_id: opts.workspaceId ?? '', status: 'error', sql: text.slice(0, 2000), duration_ms: performance.now() - started });
      throw err;
    }
  }

  /**
   * Runs a remote SELECT and materialises the result as a DuckDB table in the workspace so it can be joined with
   * local data. Rows stream through a newline-delimited JSON file in the engine's temp directory.
   */
  async materialize(p: Principal, workspaceId: string, id: string, input: { sql: string; table: string; maxRows?: number }): Promise<{ table: string; rows: number; columns: { name: string; type: string }[]; truncated: boolean; duration_ms: number }> {
    requireScope(p, 'read');
    if (!canWrite(p)) throw forbidden('Materialising tables requires the write scope');
    const c = await this.getOwned(p.userId, id);
    if (c.provider !== 'DATABRICKS' || !c.config.warehouse_id) throw badRequest('Materialisation needs a Databricks connection with a SQL warehouse');
    const table = input.table.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(table)) throw badRequest('table must be a simple identifier (letters, digits, underscores)');
    const text = input.sql.trim();
    if (!READ_ONLY_RE.test(text)) throw badRequest('Only SELECT statements can be materialised');
    await this.workspaces.get(p, workspaceId, 'EDITOR');
    const { engine } = await this.workspaces.engine(p, workspaceId);
    const started = performance.now();
    const rowLimit = Math.max(1, Math.min(input.maxRows ?? this.cfg.lakehouse.materialize_max_rows, this.cfg.lakehouse.materialize_max_rows));
    const r = await this.databricks(c).execute(text, { warehouseId: c.config.warehouse_id, rowLimit, catalog: c.config.unity_catalog || undefined, timeoutMs: this.cfg.lakehouse.statement_timeout_seconds * 1000 });
    const dir = path.join(engine.tempDirectory, 'lakehouse');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${newId()}.ndjson`);
    const ws = fs.createWriteStream(file);
    const names = r.columns.map((col) => col.name);
    for (const row of r.rows) {
      const obj: Record<string, unknown> = {};
      row.forEach((v, i) => (obj[names[i]!] = v));
      ws.write(JSON.stringify(obj) + '\n');
    }
    await new Promise<void>((res, rej) => ws.end((err?: Error | null) => (err ? rej(err) : res())));
    try {
      const colSpec = r.columns.map((col) => `${sqlString(col.name)}: ${sqlString(col.type)}`).join(', ');
      const qt = `"${table.replace(/"/g, '""')}"`;
      if (r.rows.length === 0) {
        await engine.runInternal(`CREATE OR REPLACE TABLE ${qt} (${r.columns.map((col) => `"${col.name.replace(/"/g, '""')}" ${col.type}`).join(', ')})`);
      } else {
        await engine.runInternal(`CREATE OR REPLACE TABLE ${qt} AS SELECT * FROM read_json(${sqlString(file)}, format = 'newline_delimited', columns = {${colSpec}})`, this.cfg.lakehouse.statement_timeout_seconds * 1000);
      }
    } finally {
      fs.rmSync(file, { force: true });
    }
    const durationMs = Math.round(performance.now() - started);
    this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'lakehouse.materialize', resource: `table:${table}`, queryText: text.slice(0, 4000), durationMs, ip: p.ip });
    await this.workspaces.bumpVersion(workspaceId, 'materialized', p.userId).catch(() => undefined);
    return { table, rows: r.rows.length, columns: r.columns.map((col) => ({ name: col.name, type: col.type })), truncated: r.truncated, duration_ms: durationMs };
  }
}

function quoteIdent(s: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(s) ? s : `"${s.replace(/"/g, '""')}"`;
}
