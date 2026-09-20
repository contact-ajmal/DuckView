/**
 * Cloud storage connections (S3, Cloudflare R2, GCS via HMAC/S3-interop, Azure Blob).
 *  - Credentials are AES-256-GCM encrypted at rest (row id as AAD) and never returned by the API.
 *  - Browsing uses the official SDKs (ListBuckets / ListObjectsV2 with delimiter, Azure hierarchy listing).
 *  - Querying uses DuckDB httpfs/azure via CREATE SECRET, applied to every engine of the owning user.
 */
import { eq, and, desc } from 'drizzle-orm';
import { S3Client, ListBucketsCommand, ListObjectsV2Command, HeadBucketCommand, HeadObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { BlobServiceClient } from '@azure/storage-blob';
import type { MetadataStore } from '../db/index.js';
import type { CloudConnection, CloudProvider } from '../db/schema/sqlite.js';
import { CLOUD_PROVIDERS } from '../db/schema/sqlite.js';
import { CredentialCipher, newId } from '../security/crypto.js';
import type { SecretSpec } from '../engine/duckdb.js';
import { badRequest, notFound, HttpError } from './errors.js';

export type PublicCloudConnection = Omit<CloudConnection, 'encrypted_credentials' | 'iv' | 'tag'> & { fields: string[]; uri_scheme: string };

export const CLOUD_FIELDS: Record<CloudProvider, { required: string[]; optional: string[]; uri: string; hint: string }> = {
  S3: { required: ['access_key_id', 'secret_access_key'], optional: ['session_token'], uri: 's3', hint: 'AWS S3 or any S3-compatible store (MinIO, Ceph, Wasabi) — set Endpoint URL for non-AWS.' },
  R2: { required: ['access_key_id', 'secret_access_key', 'account_id'], optional: [], uri: 'r2', hint: 'Cloudflare R2 — API tokens with Object Read; the account id forms the endpoint.' },
  GCS: { required: ['access_key_id', 'secret_access_key'], optional: [], uri: 'gs', hint: 'Google Cloud Storage HMAC keys (interoperability API).' },
  AZURE: { required: ['connection_string'], optional: [], uri: 'az', hint: 'Azure Blob Storage connection string (account name + key or SAS).' },
};

export interface CloudEntry {
  name: string;
  path: string; // key or prefix inside the bucket
  uri: string; // DuckDB-readable URI
  type: 'dir' | 'file';
  kind: 'parquet' | 'csv' | 'json' | 'duckdb' | 'arrow' | 'excel' | 'other';
  size_bytes: number | null;
  modified_at: string | null;
  queryable: boolean;
}

function kindOf(name: string): CloudEntry['kind'] {
  const l = name.toLowerCase().replace(/\.(gz|zst|bz2)$/, '');
  if (l.endsWith('.parquet') || l.endsWith('.pq')) return 'parquet';
  if (l.endsWith('.csv') || l.endsWith('.tsv') || l.endsWith('.txt')) return 'csv';
  if (l.endsWith('.json') || l.endsWith('.jsonl') || l.endsWith('.ndjson')) return 'json';
  if (l.endsWith('.duckdb') || l.endsWith('.ddb')) return 'duckdb';
  if (l.endsWith('.arrow') || l.endsWith('.arrows') || l.endsWith('.feather')) return 'arrow';
  if (l.endsWith('.xlsx') || l.endsWith('.xls')) return 'excel';
  return 'other';
}

export class CloudConnectionService {
  constructor(private readonly store: MetadataStore, private readonly cipher: CredentialCipher) {}
  private get db() {
    return this.store.db;
  }
  private get s() {
    return this.store.schema;
  }

  private decrypt(c: CloudConnection): Record<string, string> {
    return this.cipher.decryptJson<Record<string, string>>({ ciphertext: c.encrypted_credentials, iv: c.iv, tag: c.tag }, c.id);
  }

  private toPublic(c: CloudConnection): PublicCloudConnection {
    const { encrypted_credentials: _e, iv: _i, tag: _t, ...rest } = c;
    let fields: string[] = [];
    try {
      fields = Object.keys(this.decrypt(c));
    } catch {
      fields = ['<undecryptable — encryption key changed?>'];
    }
    return { ...rest, fields, uri_scheme: CLOUD_FIELDS[c.provider].uri };
  }

  async list(userId: string): Promise<PublicCloudConnection[]> {
    const rows = await this.db.select().from(this.s.cloudConnections).where(eq(this.s.cloudConnections.user_id, userId)).orderBy(desc(this.s.cloudConnections.created_at));
    return rows.map((r) => this.toPublic(r));
  }

  /** Every connection a user owns, credentials still encrypted (for matching a cloud URI to a connection). */
  async listOwned(userId: string): Promise<CloudConnection[]> {
    return this.db.select().from(this.s.cloudConnections).where(eq(this.s.cloudConnections.user_id, userId)).orderBy(desc(this.s.cloudConnections.created_at));
  }

  async getOwned(userId: string, id: string): Promise<CloudConnection> {
    const rows = await this.db
      .select()
      .from(this.s.cloudConnections)
      .where(and(eq(this.s.cloudConnections.id, id), eq(this.s.cloudConnections.user_id, userId)))
      .limit(1);
    if (!rows[0]) throw notFound('Cloud connection');
    return rows[0];
  }

  async create(userId: string, input: { name: string; provider: CloudProvider; endpoint_url?: string | null; region?: string | null; bucket?: string | null; credentials: Record<string, string> }): Promise<PublicCloudConnection> {
    if (!(CLOUD_PROVIDERS as readonly string[]).includes(input.provider)) throw badRequest(`Unsupported provider: ${input.provider}`);
    const spec = CLOUD_FIELDS[input.provider];
    const creds: Record<string, string> = {};
    for (const k of [...spec.required, ...spec.optional]) {
      const v = input.credentials?.[k];
      if (v !== undefined && v !== null && String(v).trim() !== '') creds[k] = String(v).trim();
    }
    const missing = spec.required.filter((k) => !creds[k]);
    if (missing.length) throw badRequest(`Missing required fields for ${input.provider}: ${missing.join(', ')}`);
    if (input.endpoint_url && !/^https?:\/\/[^\s/]+/i.test(input.endpoint_url)) throw badRequest('endpoint_url must be an http(s) URL');
    const id = newId();
    const enc = this.cipher.encryptJson(creds, id);
    const now = new Date();
    const record: CloudConnection = {
      id,
      user_id: userId,
      name: input.name.trim() || `${input.provider.toLowerCase()} storage`,
      provider: input.provider,
      endpoint_url: input.endpoint_url?.trim().replace(/\/+$/, '') || null,
      region: input.region?.trim() || null,
      bucket: input.bucket?.trim().replace(/^\/+|\/+$/g, '') || null,
      encrypted_credentials: enc.ciphertext,
      iv: enc.iv,
      tag: enc.tag,
      created_at: now,
      updated_at: now,
    };
    await this.db.insert(this.s.cloudConnections).values(record);
    return this.toPublic(record);
  }

  async update(userId: string, id: string, patch: { name?: string; endpoint_url?: string | null; region?: string | null; bucket?: string | null; credentials?: Record<string, string> }): Promise<PublicCloudConnection> {
    const existing = await this.getOwned(userId, id);
    const set: Partial<CloudConnection> = { updated_at: new Date() };
    if (patch.name !== undefined) set.name = patch.name.trim() || existing.name;
    if (patch.endpoint_url !== undefined) set.endpoint_url = patch.endpoint_url?.trim().replace(/\/+$/, '') || null;
    if (patch.region !== undefined) set.region = patch.region?.trim() || null;
    if (patch.bucket !== undefined) set.bucket = patch.bucket?.trim().replace(/^\/+|\/+$/g, '') || null;
    if (patch.credentials && Object.keys(patch.credentials).length) {
      const merged = { ...this.decrypt(existing) };
      const spec = CLOUD_FIELDS[existing.provider];
      for (const k of [...spec.required, ...spec.optional]) {
        const v = patch.credentials[k];
        if (v !== undefined && String(v).trim() !== '') merged[k] = String(v).trim();
      }
      const enc = this.cipher.encryptJson(merged, id);
      set.encrypted_credentials = enc.ciphertext;
      set.iv = enc.iv;
      set.tag = enc.tag;
    }
    await this.db.update(this.s.cloudConnections).set(set).where(eq(this.s.cloudConnections.id, id));
    return this.toPublic({ ...existing, ...set });
  }

  async remove(userId: string, id: string): Promise<void> {
    const r = await this.db
      .delete(this.s.cloudConnections)
      .where(and(eq(this.s.cloudConnections.id, id), eq(this.s.cloudConnections.user_id, userId)))
      .returning({ id: this.s.cloudConnections.id });
    if (r.length === 0) throw notFound('Cloud connection');
  }

  /** DuckDB secrets for every cloud connection the user owns (applied at engine start). */
  async resolveSecrets(userId: string): Promise<SecretSpec[]> {
    const rows = await this.db.select().from(this.s.cloudConnections).where(eq(this.s.cloudConnections.user_id, userId));
    return rows.map((c) => this.toSecret(c));
  }

  toSecret(c: CloudConnection): SecretSpec {
    const creds = this.decrypt(c);
    const name = `cloud_${c.provider.toLowerCase()}_${c.id.slice(0, 8)}`;
    const scope = c.bucket ? `${CLOUD_FIELDS[c.provider].uri}://${c.bucket}` : undefined;
    switch (c.provider) {
      case 'S3':
        return { name, type: 'S3', values: { access_key_id: creds.access_key_id!, secret_access_key: creds.secret_access_key!, ...(creds.session_token ? { session_token: creds.session_token } : {}), ...(c.region ? { region: c.region } : {}), ...(c.endpoint_url ? { endpoint: c.endpoint_url } : {}), ...(scope ? { scope } : {}) } };
      case 'R2':
        return { name, type: 'R2', values: { access_key_id: creds.access_key_id!, secret_access_key: creds.secret_access_key!, account_id: creds.account_id!, ...(scope ? { scope } : {}) } };
      case 'GCS':
        return { name, type: 'GCS', values: { access_key_id: creds.access_key_id!, secret_access_key: creds.secret_access_key!, ...(scope ? { scope } : {}) } };
      case 'AZURE':
        return { name, type: 'AZURE', values: { connection_string: creds.connection_string!, ...(scope ? { scope } : {}) } };
    }
  }

  // ---------------------------------------------------------------- browsing

  private s3Client(c: CloudConnection): S3Client {
    const creds = this.decrypt(c);
    const base = { accessKeyId: creds.access_key_id!, secretAccessKey: creds.secret_access_key!, ...(creds.session_token ? { sessionToken: creds.session_token } : {}) };
    switch (c.provider) {
      case 'R2':
        return new S3Client({ region: 'auto', endpoint: `https://${creds.account_id}.r2.cloudflarestorage.com`, credentials: base, forcePathStyle: true });
      case 'GCS':
        return new S3Client({ region: c.region ?? 'auto', endpoint: c.endpoint_url ?? 'https://storage.googleapis.com', credentials: base, forcePathStyle: true });
      default:
        return new S3Client({ region: c.region ?? 'us-east-1', ...(c.endpoint_url ? { endpoint: c.endpoint_url, forcePathStyle: true } : {}), credentials: base });
    }
  }

  private azureClient(c: CloudConnection): BlobServiceClient {
    const creds = this.decrypt(c);
    return BlobServiceClient.fromConnectionString(creds.connection_string!);
  }

  async listBuckets(c: CloudConnection): Promise<{ name: string; created_at: string | null }[]> {
    try {
      if (c.provider === 'AZURE') {
        const out: { name: string; created_at: string | null }[] = [];
        for await (const container of this.azureClient(c).listContainers()) out.push({ name: container.name, created_at: container.properties.lastModified?.toISOString() ?? null });
        return out;
      }
      const res = await this.s3Client(c).send(new ListBucketsCommand({}));
      return (res.Buckets ?? []).map((b) => ({ name: b.Name ?? '', created_at: b.CreationDate?.toISOString() ?? null })).filter((b) => b.name);
    } catch (err) {
      // Many scoped credentials cannot list buckets; fall back to the configured bucket.
      if (c.bucket) return [{ name: c.bucket, created_at: null }];
      throw wrapCloudError(err, c);
    }
  }

  async listObjects(c: CloudConnection, bucket: string, prefix = '', opts: { maxKeys?: number; continuationToken?: string } = {}): Promise<{ bucket: string; prefix: string; entries: CloudEntry[]; next_token: string | null }> {
    const scheme = CLOUD_FIELDS[c.provider].uri;
    const norm = prefix.replace(/^\/+/, '');
    const dirPrefix = norm && !norm.endsWith('/') ? `${norm}/` : norm;
    try {
      if (c.provider === 'AZURE') {
        const container = this.azureClient(c).getContainerClient(bucket);
        const entries: CloudEntry[] = [];
        const iter = container.listBlobsByHierarchy('/', { prefix: dirPrefix }).byPage({ maxPageSize: opts.maxKeys ?? 1000, continuationToken: opts.continuationToken });
        const page = await iter.next();
        const seg = page.value?.segment;
        for (const p of seg?.blobPrefixes ?? []) {
          const name = p.name.slice(dirPrefix.length).replace(/\/$/, '');
          entries.push({ name, path: p.name, uri: `${scheme}://${bucket}/${p.name}`, type: 'dir', kind: 'other', size_bytes: null, modified_at: null, queryable: false });
        }
        for (const b of seg?.blobItems ?? []) {
          const name = b.name.slice(dirPrefix.length);
          if (!name) continue;
          const kind = kindOf(name);
          entries.push({ name, path: b.name, uri: `${scheme}://${bucket}/${b.name}`, type: 'file', kind, size_bytes: b.properties.contentLength ?? null, modified_at: b.properties.lastModified?.toISOString() ?? null, queryable: kind !== 'other' });
        }
        return { bucket, prefix: dirPrefix, entries: sortEntries(entries), next_token: page.value?.continuationToken || null };
      }
      const res = await this.s3Client(c).send(new ListObjectsV2Command({ Bucket: bucket, Prefix: dirPrefix, Delimiter: '/', MaxKeys: opts.maxKeys ?? 1000, ContinuationToken: opts.continuationToken }));
      const entries: CloudEntry[] = [];
      for (const p of res.CommonPrefixes ?? []) {
        if (!p.Prefix) continue;
        const name = p.Prefix.slice(dirPrefix.length).replace(/\/$/, '');
        entries.push({ name, path: p.Prefix, uri: `${scheme}://${bucket}/${p.Prefix}`, type: 'dir', kind: 'other', size_bytes: null, modified_at: null, queryable: false });
      }
      for (const o of res.Contents ?? []) {
        if (!o.Key || o.Key === dirPrefix) continue;
        const name = o.Key.slice(dirPrefix.length);
        const kind = kindOf(name);
        entries.push({ name, path: o.Key, uri: `${scheme}://${bucket}/${o.Key}`, type: 'file', kind, size_bytes: o.Size ?? null, modified_at: o.LastModified?.toISOString() ?? null, queryable: kind !== 'other' });
      }
      return { bucket, prefix: dirPrefix, entries: sortEntries(entries), next_token: res.IsTruncated ? (res.NextContinuationToken ?? null) : null };
    } catch (err) {
      throw wrapCloudError(err, c);
    }
  }

  // ---------------------------------------------------------------- single objects (cloud-backed workspace files)

  /** Metadata of one object, or null when it does not exist. */
  async headObject(c: CloudConnection, bucket: string, key: string): Promise<{ etag: string | null; size_bytes: number | null; modified_at: string | null } | null> {
    try {
      if (c.provider === 'AZURE') {
        const blob = this.azureClient(c).getContainerClient(bucket).getBlockBlobClient(key);
        if (!(await blob.exists())) return null;
        const props = await blob.getProperties();
        return { etag: props.etag ?? null, size_bytes: props.contentLength ?? null, modified_at: props.lastModified?.toISOString() ?? null };
      }
      const res = await this.s3Client(c).send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return { etag: res.ETag ?? null, size_bytes: res.ContentLength ?? null, modified_at: res.LastModified?.toISOString() ?? null };
    } catch (err) {
      const e = err as { name?: string; $metadata?: { httpStatusCode?: number }; statusCode?: number };
      if (e.name === 'NotFound' || e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404 || e.statusCode === 404) return null;
      throw wrapCloudError(err, c);
    }
  }

  /** Streams an object into a local file (written to a temp name, renamed when complete). */
  async downloadObject(c: CloudConnection, bucket: string, key: string, toFile: string): Promise<{ etag: string | null; size_bytes: number }> {
    const tmp = `${toFile}.download-${process.pid}`;
    try {
      let etag: string | null = null;
      if (c.provider === 'AZURE') {
        const blob = this.azureClient(c).getContainerClient(bucket).getBlockBlobClient(key);
        const res = await blob.downloadToFile(tmp);
        etag = res.etag ?? null;
      } else {
        const res = await this.s3Client(c).send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        await pipeline(res.Body as Readable, fs.createWriteStream(tmp));
        etag = res.ETag ?? null;
      }
      fs.renameSync(tmp, toFile);
      return { etag, size_bytes: fs.statSync(toFile).size };
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      throw wrapCloudError(err, c);
    }
  }

  /** Uploads a local file as one object (multipart for large files); returns the new ETag. */
  async uploadObject(c: CloudConnection, bucket: string, key: string, fromFile: string): Promise<{ etag: string | null; size_bytes: number }> {
    const size_bytes = fs.statSync(fromFile).size;
    try {
      if (c.provider === 'AZURE') {
        const blob = this.azureClient(c).getContainerClient(bucket).getBlockBlobClient(key);
        const res = await blob.uploadFile(fromFile, { blockSize: 8 * 1024 * 1024, concurrency: 4 });
        return { etag: res.etag ?? null, size_bytes };
      }
      const up = new Upload({ client: this.s3Client(c), params: { Bucket: bucket, Key: key, Body: fs.createReadStream(fromFile), ContentType: 'application/octet-stream' }, partSize: 16 * 1024 * 1024, queueSize: 4 });
      const res = (await up.done()) as { ETag?: string };
      return { etag: res.ETag ?? null, size_bytes };
    } catch (err) {
      throw wrapCloudError(err, c);
    }
  }

  /** Verifies credentials with the cheapest call available. */
  async test(c: CloudConnection): Promise<{ ok: true; buckets: number; message: string }> {
    try {
      if (c.provider === 'AZURE') {
        const buckets = await this.listBuckets(c);
        return { ok: true, buckets: buckets.length, message: `Connected · ${buckets.length} container(s)` };
      }
      if (c.bucket) {
        await this.s3Client(c).send(new HeadBucketCommand({ Bucket: c.bucket }));
        return { ok: true, buckets: 1, message: `Connected · bucket ${c.bucket} reachable` };
      }
      const buckets = await this.listBuckets(c);
      return { ok: true, buckets: buckets.length, message: `Connected · ${buckets.length} bucket(s)` };
    } catch (err) {
      throw wrapCloudError(err, c);
    }
  }
}

function sortEntries(entries: CloudEntry[]): CloudEntry[] {
  return entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.type === 'dir' ? -1 : 1));
}

function wrapCloudError(err: unknown, c: CloudConnection): HttpError {
  if (err instanceof HttpError) return err;
  const e = err as Error & { name?: string; $metadata?: { httpStatusCode?: number }; Code?: string; code?: string; statusCode?: number };
  const status = e.$metadata?.httpStatusCode ?? e.statusCode;
  const code = e.Code ?? e.code ?? e.name ?? 'CLOUD_ERROR';
  const auth = status === 401 || status === 403 || /AccessDenied|InvalidAccessKeyId|SignatureDoesNotMatch|AuthenticationFailed|AuthorizationFailure/i.test(code);
  const msg = `${c.provider} ${c.name}: ${code}${e.message ? ` — ${e.message}` : ''}`;
  return new HttpError(auth ? 403 : status === 404 ? 404 : 502, msg, auth ? 'CLOUD_AUTH_FAILED' : status === 404 ? 'CLOUD_NOT_FOUND' : 'CLOUD_ERROR');
}
