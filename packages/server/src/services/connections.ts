import { eq, and, desc } from 'drizzle-orm';
import type { MetadataStore } from '../db/index.js';
import type { ConnectionType, DataConnection } from '../db/schema/sqlite.js';
import { CONNECTION_TYPES } from '../db/schema/sqlite.js';
import { CredentialCipher, newId } from '../security/crypto.js';
import type { SecretSpec } from '../engine/duckdb.js';
import { badRequest, notFound } from './errors.js';

export type PublicConnection = Omit<DataConnection, 'encrypted_credentials' | 'iv' | 'tag'> & { fields: string[] };

/** Fields accepted per connection type (anything else is rejected — never store arbitrary blobs). */
export const CONNECTION_FIELDS: Record<ConnectionType, { required: string[]; optional: string[] }> = {
  MOTHERDUCK: { required: ['token'], optional: [] },
  S3: { required: ['access_key_id', 'secret_access_key'], optional: ['region', 'endpoint', 'session_token', 'url_style', 'use_ssl', 'scope'] },
  GCS: { required: ['access_key_id', 'secret_access_key'], optional: ['scope'] },
  AZURE: { required: ['connection_string'], optional: ['scope'] },
  HTTP: { required: ['bearer_token'], optional: ['scope'] },
  POSTGRES: { required: ['host', 'database', 'user', 'password'], optional: ['port'] },
};

export class ConnectionService {
  constructor(private readonly store: MetadataStore, private readonly cipher: CredentialCipher) {}
  private get db() {
    return this.store.db;
  }
  private get s() {
    return this.store.schema;
  }

  private toPublic(c: DataConnection): PublicConnection {
    const { encrypted_credentials: _e, iv: _i, tag: _t, ...rest } = c;
    let fields: string[] = [];
    try {
      fields = Object.keys(this.cipher.decryptJson<Record<string, string>>({ ciphertext: c.encrypted_credentials, iv: c.iv, tag: c.tag }, c.id));
    } catch {
      fields = ['<undecryptable — encryption key changed?>'];
    }
    return { ...rest, fields };
  }

  async list(userId: string): Promise<PublicConnection[]> {
    const rows = await this.db.select().from(this.s.dataConnections).where(eq(this.s.dataConnections.user_id, userId)).orderBy(desc(this.s.dataConnections.created_at));
    return rows.map((r) => this.toPublic(r));
  }

  async create(userId: string, input: { name: string; type: ConnectionType; credentials: Record<string, string> }): Promise<PublicConnection> {
    if (!(CONNECTION_TYPES as readonly string[]).includes(input.type)) throw badRequest(`Unsupported connection type: ${input.type}`);
    const spec = CONNECTION_FIELDS[input.type];
    const creds: Record<string, string> = {};
    for (const k of [...spec.required, ...spec.optional]) {
      const v = input.credentials[k];
      if (v !== undefined && v !== null && String(v) !== '') creds[k] = String(v);
    }
    const missing = spec.required.filter((k) => !creds[k]);
    if (missing.length) throw badRequest(`Missing required fields for ${input.type}: ${missing.join(', ')}`);
    const id = newId();
    const enc = this.cipher.encryptJson(creds, id); // AAD binds ciphertext to this row id
    const record: DataConnection = {
      id,
      user_id: userId,
      name: input.name.trim() || input.type.toLowerCase(),
      type: input.type,
      encrypted_credentials: enc.ciphertext,
      iv: enc.iv,
      tag: enc.tag,
      created_at: new Date(),
    };
    await this.db.insert(this.s.dataConnections).values(record);
    return this.toPublic(record);
  }

  async remove(userId: string, id: string): Promise<void> {
    const r = await this.db
      .delete(this.s.dataConnections)
      .where(and(eq(this.s.dataConnections.id, id), eq(this.s.dataConnections.user_id, userId)))
      .returning({ id: this.s.dataConnections.id });
    if (r.length === 0) throw notFound('Connection');
  }

  /** Decrypts connections for engine start. Only the owner's connections are ever resolved. */
  async resolveSecrets(userId: string, ids: string[]): Promise<SecretSpec[]> {
    if (ids.length === 0) return [];
    const rows = await this.db.select().from(this.s.dataConnections).where(eq(this.s.dataConnections.user_id, userId));
    const out: SecretSpec[] = [];
    for (const c of rows) {
      if (!ids.includes(c.id)) continue;
      const values = this.cipher.decryptJson<Record<string, string>>({ ciphertext: c.encrypted_credentials, iv: c.iv, tag: c.tag }, c.id);
      out.push({ name: `dv_${c.name.replace(/[^A-Za-z0-9_]/g, '_')}_${c.id.slice(0, 8)}`, type: c.type, values });
    }
    return out;
  }
}
