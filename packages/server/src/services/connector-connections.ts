/**
 * Connector connections: a Snowflake / BigQuery / Redshift / ClickHouse / Fabric warehouse, a Salesforce / HubSpot /
 * Stripe / GA4 / Airtable / Notion application, or a Google Drive / Sheets account. Credentials (API keys, secrets,
 * OAuth refresh tokens, service-account keys) are AES-256-GCM encrypted at rest and never leave the process: the API
 * only ever reports which fields are on file. Google accounts connect through OAuth with a client that an
 * administrator registers in Settings → Integrations (stored encrypted in app_settings, never in config files).
 */
import fs from 'node:fs';
import path from 'node:path';
import { eq, and, desc } from 'drizzle-orm';
import { DuckDBInstance } from '@duckdb/node-api';
import type { MetadataStore } from '../db/index.js';
import type { ConnectorConnection } from '../db/schema/sqlite.js';
import type { DuckViewConfig } from '../config/index.js';
import { CredentialCipher, newId } from '../security/crypto.js';
import { badRequest, notFound } from './errors.js';
import { requireAdmin, type Principal } from './principal.js';
import { CONNECTORS, connectorById, boundFetch, ConnectorError, type Connector, type Session, type BrowseEntry, type ReadOptions } from './connectors/index.js';
import { authorizationUrl, exchangeCode, refreshAccessToken, serviceAccountToken, type GoogleOAuthClient } from './connectors/google-auth.js';
import { salesforceToken } from './connectors/saas.js';
import { fabricSql } from './connectors/warehouses.js';
import { driveDownload } from './connectors/google.js';
import { sqlString } from '../engine/duckdb.js';
import { logger } from '../observability/logger.js';

export type PublicConnectorConnection = Omit<ConnectorConnection, 'encrypted_credentials' | 'iv' | 'tag'> & {
  connector_label: string;
  auth_kind: 'fields' | 'google';
  /** Which credential fields are on file (names only). */
  credential_fields: string[];
  remote_sql: boolean;
};

export interface ConnectorSummary {
  id: string;
  label: string;
  auth: Connector['auth'];
  remote_sql: boolean;
}

const GOOGLE_CLIENT_KEY = 'google_oauth';
const TOKEN_SLACK_MS = 60_000;

export class ConnectorConnectionService {
  /** Short-lived access tokens by connection id (Google OAuth, service accounts, Salesforce). */
  private tokens = new Map<string, { access_token: string; expires_at: number }>();
  /** Test seam: rewrites every outgoing URL (mock vendor APIs). */
  rewriteUrl: ((url: string) => string) | null = null;

  constructor(private readonly store: MetadataStore, private readonly cipher: CredentialCipher, private readonly cfg: DuckViewConfig) {}
  private get db() {
    return this.store.db;
  }
  private get s() {
    return this.store.schema;
  }

  /** The connector registry as the UI and agents see it. */
  catalog(): ConnectorSummary[] {
    return CONNECTORS.map((c) => ({ id: c.id, label: c.label, auth: c.auth, remote_sql: c.remote_sql }));
  }

  private decrypt(c: ConnectorConnection): Record<string, string> {
    return this.cipher.decryptJson<Record<string, string>>({ ciphertext: c.encrypted_credentials, iv: c.iv, tag: c.tag }, c.id);
  }
  private encrypt(id: string, creds: Record<string, string>) {
    const enc = this.cipher.encryptJson(creds, id); // AAD binds the ciphertext to this row
    return { encrypted_credentials: enc.ciphertext, iv: enc.iv, tag: enc.tag };
  }
  toPublic(c: ConnectorConnection): PublicConnectorConnection {
    const { encrypted_credentials: _e, iv: _i, tag: _t, ...rest } = c;
    const connector = connectorById(c.connector);
    let credential_fields: string[] = [];
    try {
      credential_fields = Object.keys(this.decrypt(c)).filter((k) => k !== 'expires_at' && k !== 'access_token');
    } catch {
      credential_fields = ['<undecryptable — encryption key changed?>'];
    }
    return { ...rest, connector_label: connector?.label ?? c.connector, auth_kind: connector?.auth.kind ?? 'fields', credential_fields, remote_sql: connector?.remote_sql ?? false };
  }

  async list(userId: string): Promise<PublicConnectorConnection[]> {
    const rows = await this.db.select().from(this.s.connectorConnections).where(eq(this.s.connectorConnections.user_id, userId)).orderBy(desc(this.s.connectorConnections.created_at));
    return rows.map((r) => this.toPublic(r));
  }

  async getOwned(userId: string, id: string): Promise<ConnectorConnection> {
    const rows = await this.db.select().from(this.s.connectorConnections).where(and(eq(this.s.connectorConnections.id, id), eq(this.s.connectorConnections.user_id, userId))).limit(1);
    if (!rows[0]) throw notFound('Connection');
    return rows[0];
  }

  /** Splits the wizard's field values into non-secret config and credentials, checking required fields. */
  private split(connector: Connector, values: Record<string, unknown>, existing?: { config: Record<string, unknown>; creds: Record<string, string> }): { config: Record<string, unknown>; creds: Record<string, string> } {
    const config: Record<string, unknown> = { ...(existing?.config ?? {}) };
    const creds: Record<string, string> = { ...(existing?.creds ?? {}) };
    for (const f of connector.auth.fields) {
      const v = values[f.key];
      if (f.kind === 'secret') {
        if (typeof v === 'string' && v.trim()) creds[f.key] = v.trim();
        else if (v === null) delete creds[f.key];
        if (f.required && !creds[f.key]) throw badRequest(`${f.label} is required`);
        continue;
      }
      if (v === undefined) {
        if (f.required && config[f.key] === undefined) throw badRequest(`${f.label} is required`);
        continue;
      }
      if (f.kind === 'boolean') config[f.key] = !!v;
      else if (f.kind === 'number') config[f.key] = v === '' || v === null ? undefined : Number(v);
      else {
        const t = typeof v === 'string' ? v.trim() : v == null ? '' : String(v);
        if (f.required && !t) throw badRequest(`${f.label} is required`);
        if (f.kind === 'url' && t && !/^https?:\/\//i.test(t)) throw badRequest(`${f.label} must start with http:// or https://`);
        config[f.key] = t || undefined;
      }
    }
    return { config, creds };
  }

  /** Creates a field-authenticated connection, or a Google one with a service-account key. */
  async create(userId: string, input: { connector: string; name: string; values: Record<string, unknown> }): Promise<PublicConnectorConnection> {
    const connector = connectorById(input.connector);
    if (!connector) throw badRequest(`Unknown connector "${input.connector}"`);
    const name = (input.name ?? '').trim() || connector.label;
    const { config, creds } = this.split(connector, input.values ?? {});
    if (connector.auth.kind === 'google' && !creds.service_account_key) throw badRequest('Google connections start with "Connect with Google" (or a service account key)');
    this.requireExternalAccess();
    const id = newId();
    const now = new Date();
    const row: ConnectorConnection = { id, user_id: userId, connector: connector.id, name, config, ...this.encrypt(id, creds), account_label: creds.service_account_key ? serviceAccountEmail(creds.service_account_key) : null, status: 'unknown', last_error: null, last_tested_at: null, created_at: now, updated_at: now };
    await this.db.insert(this.s.connectorConnections).values(row);
    return this.toPublic(row);
  }

  async update(userId: string, id: string, patch: { name?: string; values?: Record<string, unknown> }): Promise<PublicConnectorConnection> {
    const c = await this.getOwned(userId, id);
    const connector = connectorById(c.connector)!;
    const set: Partial<ConnectorConnection> = { updated_at: new Date() };
    if (patch.name !== undefined) set.name = patch.name.trim() || c.name;
    if (patch.values) {
      let existingCreds: Record<string, string> = {};
      try {
        existingCreds = this.decrypt(c);
      } catch {
        /* rotated key: start over */
      }
      const { config, creds } = this.split(connector, patch.values, { config: c.config, creds: existingCreds });
      set.config = config;
      Object.assign(set, this.encrypt(id, creds));
      this.tokens.delete(id);
    }
    await this.db.update(this.s.connectorConnections).set(set).where(eq(this.s.connectorConnections.id, id));
    return this.toPublic({ ...c, ...set });
  }

  async remove(userId: string, id: string): Promise<void> {
    await this.getOwned(userId, id);
    await this.db.delete(this.s.connectorConnections).where(eq(this.s.connectorConnections.id, id));
    this.tokens.delete(id);
  }

  private requireExternalAccess() {
    if (!this.cfg.security.enable_external_access && this.cfg.security.filesystem_mode !== 'full') throw badRequest('Connectors reach external services: set security.enable_external_access=true (sandboxed mode blocks network access)');
  }

  // ------------------------------------------------------------------------------------------ Google OAuth client
  /** The OAuth client administrators register; the secret stays encrypted in app_settings. */
  async googleClient(): Promise<GoogleOAuthClient | null> {
    const rows = await this.db.select().from(this.s.appSettings).where(eq(this.s.appSettings.key, GOOGLE_CLIENT_KEY)).limit(1);
    const r = rows[0];
    if (!r || !r.encrypted_value || !r.iv || !r.tag) return null;
    const client_id = String((r.value as { client_id?: string } | null)?.client_id ?? '');
    try {
      return { client_id, client_secret: this.cipher.decrypt({ ciphertext: r.encrypted_value, iv: r.iv, tag: r.tag }, GOOGLE_CLIENT_KEY) };
    } catch {
      return null;
    }
  }
  async describeGoogleClient(): Promise<{ configured: boolean; client_id: string | null; redirect_uri: string; updated_at: Date | null; updated_by: string | null }> {
    const rows = await this.db.select().from(this.s.appSettings).where(eq(this.s.appSettings.key, GOOGLE_CLIENT_KEY)).limit(1);
    const r = rows[0];
    const client = await this.googleClient();
    return { configured: !!client, client_id: (r?.value as { client_id?: string } | null)?.client_id ?? null, redirect_uri: this.googleRedirectUri(), updated_at: r?.updated_at ?? null, updated_by: r?.updated_by ?? null };
  }
  async setGoogleClient(p: Principal, input: { client_id: string; client_secret?: string | null }): Promise<void> {
    requireAdmin(p);
    const client_id = input.client_id.trim();
    if (!client_id) throw badRequest('client_id is required');
    const rows = await this.db.select().from(this.s.appSettings).where(eq(this.s.appSettings.key, GOOGLE_CLIENT_KEY)).limit(1);
    const existing = rows[0];
    let enc: { ciphertext: string; iv: string; tag: string } | null = null;
    if (input.client_secret?.trim()) enc = this.cipher.encrypt(input.client_secret.trim(), GOOGLE_CLIENT_KEY);
    else if (existing?.encrypted_value && existing.iv && existing.tag) enc = { ciphertext: existing.encrypted_value, iv: existing.iv, tag: existing.tag };
    if (!enc) throw badRequest('client_secret is required');
    const row = { key: GOOGLE_CLIENT_KEY, value: { client_id }, encrypted_value: enc.ciphertext, iv: enc.iv, tag: enc.tag, updated_by: p.userId, updated_at: new Date() };
    if (existing) await this.db.update(this.s.appSettings).set(row).where(eq(this.s.appSettings.key, GOOGLE_CLIENT_KEY));
    else await this.db.insert(this.s.appSettings).values(row);
    this.tokens.clear();
  }
  async clearGoogleClient(p: Principal): Promise<void> {
    requireAdmin(p);
    await this.db.delete(this.s.appSettings).where(eq(this.s.appSettings.key, GOOGLE_CLIENT_KEY));
  }
  googleRedirectUri(): string {
    return `${(this.cfg.server.public_url ?? `http://localhost:${this.cfg.server.port}`).replace(/\/+$/, '')}/api/oauth/google/callback`;
  }

  /**
   * Step 1 of "Connect with Google": a pending connection row, and the Google consent URL. The caller signs
   * `{ purpose: 'google_connect', cid, sub }` into the state so the callback needs no session store.
   */
  async beginGoogle(userId: string, input: { connector: string; name?: string; values?: Record<string, unknown>; connection_id?: string }, sign: (payload: Record<string, unknown>) => string): Promise<{ connection: PublicConnectorConnection; url: string }> {
    const connector = connectorById(input.connector);
    if (!connector || connector.auth.kind !== 'google') throw badRequest(`${input.connector} does not authenticate with a Google account`);
    const client = await this.googleClient();
    if (!client) throw badRequest('An administrator needs to add the Google OAuth client under Settings → Integrations first');
    this.requireExternalAccess();
    let row: ConnectorConnection;
    if (input.connection_id) {
      row = await this.getOwned(userId, input.connection_id);
    } else {
      const { config } = this.split(connector, { ...(input.values ?? {}), service_account_key: undefined });
      const id = newId();
      const now = new Date();
      row = { id, user_id: userId, connector: connector.id, name: (input.name ?? '').trim() || connector.label, config, ...this.encrypt(id, {}), account_label: null, status: 'unknown', last_error: 'Waiting for Google sign-in', last_tested_at: null, created_at: now, updated_at: now };
      await this.db.insert(this.s.connectorConnections).values(row);
    }
    const state = sign({ purpose: 'google_connect', cid: row.id, sub: userId });
    return { connection: this.toPublic(row), url: authorizationUrl(client, this.googleRedirectUri(), connector.auth.scopes ?? [], state) };
  }

  /** Step 2: the callback exchanged its code; store the refresh token and label the connection with the account. */
  async finishGoogle(state: { cid: string; sub: string }, code: string): Promise<ConnectorConnection> {
    const client = await this.googleClient();
    if (!client) throw badRequest('Google integration is not configured');
    const c = await this.getOwned(state.sub, state.cid);
    const tokens = await exchangeCode(client, this.googleRedirectUri(), code);
    let creds: Record<string, string> = {};
    try {
      creds = this.decrypt(c);
    } catch {
      /* fresh */
    }
    if (!tokens.refresh_token && !creds.refresh_token) throw badRequest('Google did not return a refresh token — remove DuckView from the account\'s third-party access and connect again');
    const next: Record<string, string> = { ...creds, refresh_token: tokens.refresh_token ?? creds.refresh_token!, access_token: tokens.access_token, expires_at: String(tokens.expires_at) };
    delete next.service_account_key;
    const set: Partial<ConnectorConnection> = { ...this.encrypt(c.id, next), account_label: tokens.email ?? c.account_label, status: 'ok', last_error: null, last_tested_at: new Date(), updated_at: new Date() };
    await this.db.update(this.s.connectorConnections).set(set).where(eq(this.s.connectorConnections.id, c.id));
    this.tokens.set(c.id, { access_token: tokens.access_token, expires_at: tokens.expires_at });
    return { ...c, ...set };
  }

  // ------------------------------------------------------------------------------------------ sessions
  /** A live session: decrypted credentials with a fresh access token where the connector needs one. */
  async session(c: ConnectorConnection): Promise<Session> {
    const connector = connectorById(c.connector);
    if (!connector) throw badRequest(`Unknown connector "${c.connector}"`);
    this.requireExternalAccess();
    let creds: Record<string, string>;
    try {
      creds = this.decrypt(c);
    } catch {
      throw badRequest('The stored credentials cannot be decrypted (encryption key changed) — enter them again');
    }
    const token = await this.accessToken(c, connector, creds);
    if (token) creds = { ...creds, access_token: token };
    const bound = boundFetch(connector.headers(creds, c.config));
    const rewrite = this.rewriteUrl;
    return { config: c.config, credentials: creds, fetch: rewrite ? (url, init) => bound(rewrite(url), init) : bound };
  }

  private async accessToken(c: ConnectorConnection, connector: Connector, creds: Record<string, string>): Promise<string | null> {
    const cached = this.tokens.get(c.id);
    if (cached && cached.expires_at - TOKEN_SLACK_MS > Date.now()) return cached.access_token;
    let fresh: { access_token: string; expires_at: number } | null = null;
    if (connector.auth.kind === 'google') {
      if (creds.service_account_key) fresh = await serviceAccountToken(creds.service_account_key, connector.auth.scopes ?? []);
      else if (creds.refresh_token) {
        const client = await this.googleClient();
        if (!client) throw badRequest('Google integration is not configured');
        fresh = await refreshAccessToken(client, creds.refresh_token);
      } else throw new ConnectorError('This connection has not finished Google sign-in', 401);
    } else if (connector.id === 'salesforce') fresh = await salesforceToken(c.config, creds);
    if (fresh) this.tokens.set(c.id, fresh);
    return fresh?.access_token ?? null;
  }

  async test(userId: string, id: string): Promise<{ ok: boolean; message: string }> {
    const c = await this.getOwned(userId, id);
    const connector = connectorById(c.connector)!;
    const started = Date.now();
    try {
      const r = await connector.test(await this.session(c));
      await this.db.update(this.s.connectorConnections).set({ status: 'ok', last_error: null, last_tested_at: new Date() }).where(eq(this.s.connectorConnections.id, id));
      return { ok: true, message: `${r.message} · ${Date.now() - started} ms` };
    } catch (err) {
      const message = ((err as Error).message ?? 'failed').split('\n')[0]!.slice(0, 500);
      await this.db.update(this.s.connectorConnections).set({ status: 'error', last_error: message, last_tested_at: new Date() }).where(eq(this.s.connectorConnections.id, id));
      logger().warn({ id, connector: c.connector, err: message }, 'Connector test failed');
      return { ok: false, message };
    }
  }

  async browse(userId: string, id: string, path: string[]): Promise<{ connection: { id: string; name: string; connector: string }; path: string[]; entries: BrowseEntry[] }> {
    const c = await this.getOwned(userId, id);
    const connector = connectorById(c.connector)!;
    const entries = await connector.browse(await this.session(c), path);
    return { connection: { id: c.id, name: c.name, connector: c.connector }, path, entries };
  }

  /** Row batches for a resource (a sync's source, a preview). */
  async read(c: ConnectorConnection, resource: Record<string, unknown>, opts: ReadOptions = {}): Promise<AsyncIterable<Record<string, unknown>[]>> {
    const connector = connectorById(c.connector)!;
    const s = await this.session(c);
    if (typeof resource.sql === 'string' && resource.sql.trim() && connector.query) return connector.query(s, resource.sql, opts);
    return connector.read(s, resource, opts);
  }

  /** Remote SQL on a warehouse connection (agents, the sync editor). */
  async query(userId: string, id: string, sql: string, opts: ReadOptions = {}): Promise<{ connection: string; rows: Record<string, unknown>[]; truncated: boolean }> {
    const c = await this.getOwned(userId, id);
    const connector = connectorById(c.connector)!;
    if (!connector.query) throw badRequest(`${connector.label} does not run SQL remotely — sync a resource instead`);
    const limit = opts.limit ?? 1000;
    const rows: Record<string, unknown>[] = [];
    for await (const batch of connector.query(await this.session(c), sql, { ...opts, limit })) {
      rows.push(...batch);
      if (rows.length >= limit) break;
    }
    return { connection: c.name, rows: rows.slice(0, limit), truncated: rows.length > limit };
  }

  connector(id: string): Connector | null {
    return connectorById(id);
  }

  /**
   * Stages a resource for a sync: rows are pulled through the connector into a newline-delimited JSON file (a Drive
   * file is downloaded as is, a Fabric Delta table is copied to Parquet by a scratch DuckDB holding the Azure
   * secret) and the SELECT that reads the staged file is returned. `stagePath` has no extension; the caller
   * removes the files afterwards. Credentials never reach the workspace engine.
   */
  async stage(c: ConnectorConnection, resource: Record<string, unknown>, stagePath: string, opts: ReadOptions = {}): Promise<{ select: string; files: string[]; rows: number | null }> {
    const connector = connectorById(c.connector);
    if (!connector) throw badRequest(`Unknown connector "${c.connector}"`);
    fs.mkdirSync(path.dirname(stagePath), { recursive: true });
    if (connector.id === 'fabric') {
      const file = `${stagePath}.parquet`;
      await this.fabricToParquet(c, resource, file, opts);
      return { select: `SELECT * FROM read_parquet(${sqlString(file)})`, files: [file], rows: null };
    }
    if (connector.id === 'google_drive') {
      const s = await this.session(c);
      const tmp = `${stagePath}.download`;
      const kind = await driveDownload(s, resource, tmp);
      const ext = { csv: 'csv', json: 'json', parquet: 'parquet', excel: 'xlsx' }[kind];
      const file = `${stagePath}.${ext}`;
      fs.renameSync(tmp, file);
      const reader = { csv: 'read_csv_auto', json: 'read_json_auto', parquet: 'read_parquet', excel: 'read_xlsx' }[kind];
      return { select: `SELECT * FROM ${reader}(${sqlString(file)})${opts.limit ? ` LIMIT ${opts.limit}` : ''}`, files: [file], rows: null };
    }
    const file = `${stagePath}.ndjson`;
    const rows = await writeNdjson(file, await this.read(c, resource, opts), opts.limit);
    if (rows === 0) return { select: 'SELECT NULL::VARCHAR AS _empty WHERE false', files: [file], rows: 0 };
    return { select: `SELECT * FROM read_json_auto(${sqlString(file)}, sample_size = -1, maximum_object_size = 67108864)`, files: [file], rows };
  }

  /** Copies a Fabric Delta table to Parquet through a scratch DuckDB (azure + delta extensions, service principal secret). */
  private async fabricToParquet(c: ConnectorConnection, resource: Record<string, unknown>, file: string, opts: ReadOptions): Promise<void> {
    this.requireExternalAccess();
    let creds: Record<string, string>;
    try {
      creds = this.decrypt(c);
    } catch {
      throw badRequest('The stored credentials cannot be decrypted (encryption key changed) — enter them again');
    }
    const { secret, select, extensions } = fabricSql(c.config, creds, resource, `dv_fabric_${c.id.replace(/[^A-Za-z0-9_]/g, '_')}`);
    const options: Record<string, string> = { threads: '4', memory_limit: '1GB' };
    if (this.cfg.duckdb.extension_directory) options.extension_directory = this.cfg.duckdb.extension_directory;
    const inst = await DuckDBInstance.create(':memory:', options);
    const conn = await inst.connect();
    const timer = setTimeout(() => conn.interrupt(), 30 * 60_000);
    try {
      for (const ext of extensions) {
        await conn.run(`LOAD ${ext}`).catch(async () => {
          await conn.run(`INSTALL ${ext}`);
          await conn.run(`LOAD ${ext}`);
        });
      }
      await conn.run(secret);
      await conn.run(`COPY (${select}${opts.limit ? ` LIMIT ${opts.limit}` : ''}) TO ${sqlString(file)} (FORMAT parquet)`);
    } finally {
      clearTimeout(timer);
      conn.closeSync();
      inst.closeSync();
    }
  }
}

/** Streams row batches to a newline-delimited JSON file; returns the number of rows written. */
export async function writeNdjson(file: string, batches: AsyncIterable<Record<string, unknown>[]>, limit?: number): Promise<number> {
  const out = fs.createWriteStream(file);
  let n = 0;
  const replacer = (_k: string, v: unknown) => (typeof v === 'bigint' ? (Number.isSafeInteger(Number(v)) ? Number(v) : v.toString()) : v);
  try {
    for await (const batch of batches) {
      let chunk = '';
      for (const row of batch) {
        if (limit && n >= limit) break;
        chunk += JSON.stringify(row, replacer) + '\n';
        n++;
      }
      if (chunk && !out.write(chunk)) await new Promise<void>((resolve) => out.once('drain', resolve));
      if (limit && n >= limit) break;
    }
  } finally {
    await new Promise<void>((resolve, reject) => out.end((err?: Error | null) => (err ? reject(err) : resolve())));
  }
  return n;
}

function serviceAccountEmail(keyJson: string): string | null {
  try {
    return (JSON.parse(keyJson) as { client_email?: string }).client_email ?? null;
  } catch {
    return null;
  }
}
