/**
 * Streams: events appended continuously to a table of a workspace — from a Kafka topic (any Kafka-compatible
 * broker: Apache Kafka, Confluent, Redpanda, MSK), an Amazon Kinesis data stream, or HTTP pushes to DuckView.
 *
 * Messages arrive in micro-batches (Kafka: what the broker returns within batch_seconds; Kinesis: each poll of
 * every shard; HTTP: each request). A batch is decoded (JSON objects become columns — a non-object value lands in
 * `value`, text that is not JSON in `_raw`; format text keeps the message as `value`), written to a staged NDJSON
 * file and appended with one guarded statement as the workspace's owner, like a sync:
 *   - the first batch creates the table (types inferred from the data);
 *   - later batches add columns that appear (ALTER TABLE … ADD COLUMN) and are inserted BY NAME, each value cast
 *     to the column's type (TRY_CAST — a value that does not fit becomes NULL rather than stopping the stream).
 * With include_metadata, _key, _partition, _offset, _timestamp and _ingested_at are added.
 *
 * Delivery is at least once: Kafka offsets are committed and Kinesis checkpoints (shard → sequence number) saved
 * only after the batch is written; a restart resumes there. Batches of one stream are written one at a time.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { Kafka, logLevel, type Consumer, type SASLOptions } from 'kafkajs';
import pg from 'pg';
import { LogicalReplicationService, PgoutputPlugin, type Pgoutput } from 'pg-logical-replication';
import { KinesisClient, ListShardsCommand, GetShardIteratorCommand, GetRecordsCommand, DescribeStreamSummaryCommand, type Shard } from '@aws-sdk/client-kinesis';
import type { MetadataStore } from '../db/index.js';
import { STREAM_FORMATS, type Stream, type StreamConfig, type StreamStats, type StreamStatus } from '../db/schema/sqlite.js';
import type { DuckViewConfig } from '../config/index.js';
import type { CredentialCipher } from '../security/crypto.js';
import { newId } from '../security/crypto.js';
import type { Principal } from './principal.js';
import { requireWrite } from './principal.js';
import type { WorkspaceService } from './workspaces.js';
import type { QueryService } from './query.js';
import type { AuthService } from './auth.js';
import type { AuditService } from './audit.js';
import type { CloudConnectionService } from './cloud.js';
import type { DatabaseConnectionService } from './databases.js';
import { badRequest, notFound, unauthorized } from './errors.js';
import { sqlString } from '../engine/duckdb.js';
import { logger } from '../observability/logger.js';
import { liveEvents } from '../observability/events.js';

export interface StreamInput {
  name?: string;
  config?: StreamConfig;
  sasl_password?: string | null;
  format?: (typeof STREAM_FORMATS)[number];
  mode?: 'append' | 'mirror';
  key_columns?: string[];
  keep_history?: boolean;
  target_schema?: string;
  target_table?: string;
  include_metadata?: boolean;
  batch_rows?: number;
  batch_seconds?: number;
  enabled?: boolean;
}

/** One message as it came off the wire. */
export interface StreamRecord {
  value: string | Record<string, unknown> | unknown[] | number | boolean | null;
  /** A change from change data capture (value is the row: the new one, or the old one for a delete). */
  op?: 'c' | 'u' | 'd' | 'r';
  key?: string | null;
  partition?: string | number | null;
  offset?: string | null;
  timestamp?: string | null;
}

export type PublicStream = Omit<Stream, 'encrypted_secret' | 'iv' | 'tag' | 'key_hash'> & { secret_set: boolean; push_url: string | null };

/** The minimal Kinesis client the reader needs (tests pass a fake). */
export interface KinesisLike {
  send(command: ListShardsCommand | GetShardIteratorCommand | GetRecordsCommand | DescribeStreamSummaryCommand): Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const qi = (s: string) => `"${s.replace(/"/g, '""')}"`;
const EMPTY_STATS: StreamStats = { rows_total: 0, batches: 0, last_batch_rows: 0, last_batch_at: null, last_error: null, last_error_at: null };
const hashKey = (key: string) => crypto.createHash('sha256').update(key).digest('hex');

/** A message's JSON, or the text itself when it is not JSON. */
function parsed(v: StreamRecord['value']): unknown {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return { _raw: v };
  }
}

/** A Debezium change event (with or without the schema envelope): op and the row image, or null for a tombstone. */
export function debeziumChange(v: unknown): { op: 'c' | 'u' | 'd' | 'r'; row: Record<string, unknown>; ts: string | null } | null {
  let e = v as Record<string, unknown> | null;
  if (e && typeof e === 'object' && e.payload && typeof e.payload === 'object' && 'op' in (e.payload as object)) e = e.payload as Record<string, unknown>;
  if (!e || typeof e !== 'object' || typeof e.op !== 'string' || !['c', 'u', 'd', 'r'].includes(e.op)) return null;
  const image = (e.op === 'd' ? e.before : e.after) as Record<string, unknown> | null;
  if (!image || typeof image !== 'object') return null;
  return { op: e.op as 'c' | 'u' | 'd' | 'r', row: { ...image }, ts: typeof e.ts_ms === 'number' ? new Date(e.ts_ms).toISOString() : null };
}

/** The key columns a Debezium message key names ({"id": 1}, or with its schema envelope). */
export function keyColumnsOf(records: StreamRecord[]): string[] {
  for (const r of records) {
    if (!r.key) continue;
    let k = parsed(r.key) as Record<string, unknown> | null;
    if (k && typeof k === 'object' && k.payload && typeof k.payload === 'object') k = k.payload as Record<string, unknown>;
    if (k && typeof k === 'object' && !('_raw' in k)) return Object.keys(k).filter((c) => IDENT.test(c));
  }
  return [];
}

/**
 * Rows to write: decoded messages plus the metadata columns. With changes (a mirrored table) each row carries _op
 * (c insert, u update, d delete, r snapshot read) and _seq (its order in the batch); deletes carry the old row.
 */
export function rowsOf(records: StreamRecord[], format: 'json' | 'text' | 'debezium', includeMetadata: boolean, now = new Date(), opts: { changes?: boolean } = {}): Record<string, unknown>[] {
  const at = now.toISOString();
  const out: Record<string, unknown>[] = [];
  records.forEach((r, i) => {
    let row: Record<string, unknown>;
    let op: string | null = r.op ?? null;
    let ts = r.timestamp ?? null;
    if (r.op) row = { ...(r.value as Record<string, unknown>) };
    else if (format === 'text') row = { value: typeof r.value === 'string' ? r.value : r.value === null ? null : JSON.stringify(r.value) };
    else if (format === 'debezium') {
      const change = debeziumChange(parsed(r.value));
      if (!change) return;
      row = change.row;
      op = change.op;
      ts = change.ts ?? ts;
    } else {
      const v = parsed(r.value);
      row = v !== null && typeof v === 'object' && !Array.isArray(v) ? { ...(v as Record<string, unknown>) } : { value: v };
    }
    if (includeMetadata) Object.assign(row, { _key: r.key ?? null, _partition: r.partition === undefined || r.partition === null ? null : String(r.partition), _offset: r.offset ?? null, _timestamp: ts, _ingested_at: at });
    if (opts.changes) Object.assign(row, { _op: op ?? 'c', _seq: i });
    out.push(row);
  });
  return out;
}

/** An HTTP push body as records: a JSON array, one JSON object, or newline-delimited JSON. */
export function recordsOfPush(body: unknown): StreamRecord[] {
  if (Array.isArray(body)) return body.map((value) => ({ value: value as StreamRecord['value'] }));
  if (body !== null && typeof body === 'object') return [{ value: body as Record<string, unknown> }];
  if (typeof body === 'string') {
    const t = body.trim();
    if (!t) return [];
    try {
      return recordsOfPush(JSON.parse(t));
    } catch {
      return t.split(/\r?\n/).filter((l) => l.trim()).map((l) => ({ value: l }));
    }
  }
  return body === undefined ? [] : [{ value: body as StreamRecord['value'] }];
}

type Run = (sql: string) => Promise<{ rows: unknown[][] }>;

/** A Postgres column type (format_type) as a DuckDB type. */
export function duckdbTypeOf(pgType: string): string {
  const t = pgType.toLowerCase();
  if (t.endsWith('[]')) return `${duckdbTypeOf(t.slice(0, -2))}[]`;
  const num = /^numeric\((\d+),(\d+)\)$/.exec(t);
  if (num) return Number(num[1]) <= 38 ? `DECIMAL(${num[1]},${num[2]})` : 'DOUBLE';
  if (t === 'numeric') return 'DOUBLE';
  const map: [RegExp, string][] = [[/^smallint$/, 'SMALLINT'], [/^integer$/, 'INTEGER'], [/^bigint$/, 'BIGINT'], [/^real$/, 'FLOAT'], [/^double precision$/, 'DOUBLE'], [/^boolean$/, 'BOOLEAN'], [/^date$/, 'DATE'], [/^timestamp( \(\d\))? without time zone$/, 'TIMESTAMP'], [/^timestamp( \(\d\))? with time zone$/, 'TIMESTAMPTZ'], [/^time/, 'TIME'], [/^uuid$/, 'UUID'], [/^jsonb?$/, 'JSON'], [/^bytea$/, 'BLOB'], [/^interval$/, 'INTERVAL']];
  return map.find(([re]) => re.test(t))?.[1] ?? 'VARCHAR';
}

interface Runner {
  stop(): Promise<void>;
}

export class StreamService {
  private runners = new Map<string, Runner>();
  /** Batches of a stream are written one after another. */
  private chains = new Map<string, Promise<unknown>>();
  /** Tests replace the Kinesis client. */
  kinesisClient: (c: Extract<StreamConfig, { kind: 'kinesis' }>, creds: { accessKeyId: string; secretAccessKey: string; sessionToken?: string } | null) => KinesisLike = (c, creds) => new KinesisClient({ region: c.region, ...(c.endpoint ? { endpoint: c.endpoint } : {}), ...(creds ? { credentials: creds } : {}) });
  /** Where batches are staged (set by the context). */
  stageDir: string | null = null;
  /** How long the Kinesis reader waits after a batch before polling again (idle shards wait batch_seconds). */
  kinesisIdleMs = 1000;

  constructor(private readonly cfg: DuckViewConfig, private readonly store: MetadataStore, private readonly cipher: CredentialCipher, private readonly workspaces: WorkspaceService, private readonly queries: QueryService, private readonly auth: AuthService, private readonly cloud: CloudConnectionService, private readonly databases: DatabaseConnectionService, private readonly audit: AuditService) {}
  private get db() {
    return this.store.db;
  }
  private get s() {
    return this.store.schema;
  }

  // ------------------------------------------------------------------------------------------ definitions

  toPublic(r: Stream): PublicStream {
    const { encrypted_secret: _e, iv: _i, tag: _t, key_hash, ...rest } = r;
    return { ...rest, secret_set: !!r.encrypted_secret, push_url: r.kind === 'http' && key_hash ? `/api/streams/${r.id}/push` : null };
  }

  private checkKeys(keys: string[] | undefined): string[] {
    const list = [...new Set((keys ?? []).map((k) => k.trim()).filter(Boolean))];
    const bad = list.find((k) => !IDENT.test(k));
    if (bad) throw badRequest(`Key column ${bad} must be a plain name`);
    return list.slice(0, 10);
  }

  private checkConfig(c: StreamConfig | undefined): StreamConfig {
    if (!c) throw badRequest('config is required');
    if (c.kind === 'kafka') {
      const brokers = (c.brokers ?? []).map((b) => String(b).trim()).filter(Boolean);
      if (!brokers.length) throw badRequest('Kafka: give at least one broker (host:port)');
      for (const b of brokers) if (!/^[\w.-]+:\d{1,5}$/.test(b)) throw badRequest(`Kafka: ${b} is not host:port`);
      if (!c.topic?.trim()) throw badRequest('Kafka: topic is required');
      return { kind: 'kafka', brokers, topic: c.topic.trim(), group_id: c.group_id?.trim() || null, from_beginning: !!c.from_beginning, ssl: !!c.ssl, sasl_mechanism: c.sasl_mechanism ?? null, sasl_username: c.sasl_username?.trim() || null };
    }
    if (c.kind === 'kinesis') {
      if (!c.stream?.trim() || !c.region?.trim()) throw badRequest('Kinesis: stream and region are required');
      return { kind: 'kinesis', stream: c.stream.trim(), region: c.region.trim(), cloud_connection_id: c.cloud_connection_id || null, endpoint: c.endpoint?.trim() || null, start: c.start === 'LATEST' ? 'LATEST' : 'TRIM_HORIZON' };
    }
    if (c.kind === 'http') return { kind: 'http' };
    if (c.kind === 'postgres') {
      const table = (c.table ?? '').trim();
      if (!c.connection_id) throw badRequest('Postgres: choose a database connection');
      if (!/^[A-Za-z_][\w$]*(\.[A-Za-z_][\w$]*)?$/.test(table)) throw badRequest('Postgres: table must be a name like orders or public.orders');
      return { kind: 'postgres', connection_id: c.connection_id, table: table.includes('.') ? table : `public.${table}`, snapshot: c.snapshot !== false };
    }
    throw badRequest('config.kind must be kafka, kinesis, http or postgres');
  }

  async list(p: Principal, workspaceId: string): Promise<PublicStream[]> {
    await this.workspaces.get(p, workspaceId);
    const rows = await this.db.select().from(this.s.streams).where(eq(this.s.streams.workspace_id, workspaceId));
    return rows.sort((a, b) => a.name.localeCompare(b.name)).map((r) => this.toPublic(r));
  }

  async get(p: Principal, id: string, minRole: 'VIEWER' | 'EDITOR' = 'VIEWER'): Promise<Stream> {
    const r = (await this.db.select().from(this.s.streams).where(eq(this.s.streams.id, id)).limit(1))[0];
    if (!r) throw notFound('Stream');
    await this.workspaces.get(p, r.workspace_id, minRole);
    return r;
  }

  /** Creates a stream; an HTTP stream's push key is returned once. */
  async create(p: Principal, workspaceId: string, input: StreamInput): Promise<{ stream: PublicStream; push_key: string | null }> {
    requireWrite(p);
    await this.workspaces.get(p, workspaceId, 'EDITOR');
    if (!this.cfg.streams.enabled) throw badRequest('Streams are turned off on this server');
    const config = this.checkConfig(input.config);
    if (config.kind === 'kinesis' && config.cloud_connection_id) await this.cloud.awsCredentials(p.userId, config.cloud_connection_id);
    if (config.kind === 'postgres') await this.databases.pgClientConfig(p.userId, config.connection_id);
    const format = config.kind === 'postgres' ? 'json' : input.format === 'text' || input.format === 'debezium' ? input.format : 'json';
    // Change data capture always mirrors; so does a Debezium feed.
    const mode = config.kind === 'postgres' || format === 'debezium' ? 'mirror' : input.mode === 'mirror' ? 'mirror' : 'append';
    const keyColumns = this.checkKeys(input.key_columns);
    if (mode === 'mirror' && format === 'text') throw badRequest('A mirrored table needs JSON messages');
    if (mode === 'mirror' && format === 'json' && config.kind !== 'postgres' && !keyColumns.length) throw badRequest('Give the key columns that identify a row');
    const table = (input.target_table ?? '').trim();
    const schema = (input.target_schema ?? 'main').trim() || 'main';
    if (!IDENT.test(table) || !IDENT.test(schema)) throw badRequest('target_schema and target_table must be plain names (letters, digits, _)');
    const clash = (await this.db.select({ id: this.s.streams.id }).from(this.s.streams).where(and(eq(this.s.streams.workspace_id, workspaceId), eq(this.s.streams.target_schema, schema), eq(this.s.streams.target_table, table))).limit(1))[0];
    if (clash) throw badRequest(`Another stream already writes to ${schema}.${table}`);
    const id = newId();
    const now = new Date();
    const pushKey = config.kind === 'http' ? `dvs_${crypto.randomBytes(24).toString('base64url')}` : null;
    const enc = config.kind === 'kafka' && input.sasl_password ? this.cipher.encryptJson({ sasl_password: input.sasl_password }, id) : null;
    const row: Stream = {
      id,
      workspace_id: workspaceId,
      user_id: p.userId,
      name: (input.name ?? '').trim().slice(0, 120) || table,
      kind: config.kind,
      config,
      encrypted_secret: enc?.ciphertext ?? null,
      iv: enc?.iv ?? null,
      tag: enc?.tag ?? null,
      key_hash: pushKey ? hashKey(pushKey) : null,
      format,
      mode,
      key_columns: keyColumns,
      keep_history: mode === 'mirror' && !!input.keep_history,
      target_schema: schema,
      target_table: table,
      include_metadata: input.include_metadata ?? true,
      batch_rows: Math.min(Math.max(1, Math.round(input.batch_rows ?? 1000)), this.cfg.streams.max_batch_rows),
      batch_seconds: Math.min(Math.max(1, Math.round(input.batch_seconds ?? 5)), 300),
      enabled: input.enabled ?? true,
      status: 'stopped',
      stats: EMPTY_STATS,
      checkpoints: {},
      created_at: now,
      updated_at: now,
    };
    await this.db.insert(this.s.streams).values(row);
    this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'stream.create', resource: `stream:${id}`, ip: p.ip });
    if (row.enabled) await this.startRunner(row);
    return { stream: this.toPublic((await this.row(id))!), push_key: pushKey };
  }

  async update(p: Principal, id: string, patch: StreamInput): Promise<PublicStream> {
    requireWrite(p);
    const cur = await this.get(p, id, 'EDITOR');
    const set: Partial<Stream> = { updated_at: new Date() };
    if (patch.name !== undefined) set.name = patch.name.trim().slice(0, 120) || cur.name;
    if (patch.config !== undefined) {
      const config = this.checkConfig(patch.config);
      if (config.kind !== cur.kind) throw badRequest('A stream\'s kind cannot change; create another stream');
      if (config.kind === 'kinesis' && config.cloud_connection_id) await this.cloud.awsCredentials(p.userId, config.cloud_connection_id);
      set.config = config;
      set.user_id = p.userId;
    }
    if (patch.sasl_password !== undefined) {
      const enc = patch.sasl_password ? this.cipher.encryptJson({ sasl_password: patch.sasl_password }, id) : null;
      Object.assign(set, { encrypted_secret: enc?.ciphertext ?? null, iv: enc?.iv ?? null, tag: enc?.tag ?? null });
    }
    if (patch.format !== undefined && cur.kind !== 'postgres') set.format = patch.format === 'text' || patch.format === 'debezium' ? patch.format : 'json';
    if (patch.key_columns !== undefined) set.key_columns = this.checkKeys(patch.key_columns);
    if (patch.keep_history !== undefined) set.keep_history = (set.mode ?? cur.mode) === 'mirror' && patch.keep_history;
    if (patch.include_metadata !== undefined) set.include_metadata = patch.include_metadata;
    if (patch.batch_rows !== undefined) set.batch_rows = Math.min(Math.max(1, Math.round(patch.batch_rows)), this.cfg.streams.max_batch_rows);
    if (patch.batch_seconds !== undefined) set.batch_seconds = Math.min(Math.max(1, Math.round(patch.batch_seconds)), 300);
    if (patch.enabled !== undefined) set.enabled = patch.enabled;
    await this.db.update(this.s.streams).set(set).where(eq(this.s.streams.id, id));
    this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'stream.update', resource: `stream:${id}`, ip: p.ip });
    const next = (await this.row(id))!;
    await this.stopRunner(id);
    if (next.enabled) await this.startRunner(next);
    return this.toPublic((await this.row(id))!);
  }

  async remove(p: Principal, id: string): Promise<void> {
    requireWrite(p);
    const cur = await this.get(p, id, 'EDITOR');
    await this.stopRunner(id);
    // Change data capture: drop the replication slot, or Postgres keeps WAL for it forever.
    if (cur.config.kind === 'postgres') await this.dropSlot(cur).catch((err) => logger().warn({ stream: id, err: (err as Error).message }, 'Could not drop the replication slot'));
    await this.db.delete(this.s.streams).where(eq(this.s.streams.id, id));
    this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'stream.delete', resource: `stream:${id}`, ip: p.ip });
  }

  /** A new push key for an HTTP stream (the old one stops working). */
  async rotateKey(p: Principal, id: string): Promise<string> {
    requireWrite(p);
    const s = await this.get(p, id, 'EDITOR');
    if (s.kind !== 'http') throw badRequest('Only HTTP streams have a push key');
    const key = `dvs_${crypto.randomBytes(24).toString('base64url')}`;
    await this.db.update(this.s.streams).set({ key_hash: hashKey(key), updated_at: new Date() }).where(eq(this.s.streams.id, id));
    return key;
  }

  private async row(id: string): Promise<Stream | undefined> {
    return (await this.db.select().from(this.s.streams).where(eq(this.s.streams.id, id)).limit(1))[0];
  }

  // ------------------------------------------------------------------------------------------ writing

  /** Appends a batch to the stream's table (one batch of a stream at a time). Returns the rows written. */
  async write(streamId: string, records: StreamRecord[]): Promise<number> {
    const prev = this.chains.get(streamId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(() => this.writeNow(streamId, records));
    this.chains.set(streamId, next);
    try {
      return await next;
    } finally {
      if (this.chains.get(streamId) === next) this.chains.delete(streamId);
    }
  }

  private async ownerOf(stream: Stream): Promise<Principal> {
    const w = await this.workspaces.rowById(stream.workspace_id);
    if (!w) throw new Error('The workspace no longer exists');
    const ownerUser = await this.auth.findActive(w.user_id);
    if (!ownerUser) throw new Error('The workspace owner no longer exists or has been deactivated');
    return this.auth.principalFromUser(ownerUser, 'jwt', 'stream');
  }

  private async writeNow(streamId: string, records: StreamRecord[]): Promise<number> {
    if (!records.length) return 0;
    let stream = await this.row(streamId);
    if (!stream) throw notFound('Stream');
    const t0 = Date.now();
    try {
      const owner = await this.ownerOf(stream);
      const rows = rowsOf(records, stream.format, stream.include_metadata, new Date(), { changes: stream.mode === 'mirror' });
      if (!rows.length) return 0;
      if (stream.mode === 'mirror' && !stream.key_columns.length) {
        // Debezium: the message key names the row's key columns.
        const keys = keyColumnsOf(records);
        if (!keys.length) throw new Error('This stream keeps each row\'s latest state and needs key columns: set them, or send messages with a key');
        await this.db.update(this.s.streams).set({ key_columns: keys }).where(eq(this.s.streams.id, streamId));
        stream = { ...stream, key_columns: keys };
      }
      const dir = this.stageDir ?? path.join(process.cwd(), '.duckview', 'streams');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${stream.id}-${newId()}.jsonl`);
      fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n'));
      try {
        const run = (sql: string) => this.queries.run(owner, stream!.workspace_id, sql, { cache: false, countTotal: false, maxRows: 10_000 });
        const src = `read_json(${sqlString(file)}, format = 'newline_delimited', union_by_name = true, sample_size = -1)`;
        if (stream.target_schema !== 'main') await run(`CREATE SCHEMA IF NOT EXISTS ${qi(stream.target_schema)}`);
        if (stream.mode === 'mirror') {
          await this.applyMirror(run, stream, src);
          if (stream.keep_history) await this.appendTo(run, stream.target_schema, `${stream.target_table}__changes`, src, ['_seq']);
        } else await this.appendTo(run, stream.target_schema, stream.target_table, src, []);
      } finally {
        fs.rmSync(file, { force: true });
      }
      const fresh = (await this.row(streamId))!;
      const stats: StreamStats = { ...fresh.stats, rows_total: fresh.stats.rows_total + rows.length, batches: fresh.stats.batches + 1, last_batch_rows: rows.length, last_batch_at: new Date().toISOString() };
      await this.db.update(this.s.streams).set({ stats, ...(fresh.status === 'error' && fresh.kind === 'http' ? { status: 'running' as StreamStatus } : {}) }).where(eq(this.s.streams.id, streamId));
      liveEvents.publish({ type: 'stream', at: new Date().toISOString(), workspace_id: stream.workspace_id, stream_id: stream.id, rows: rows.length, rows_total: stats.rows_total, duration_ms: Date.now() - t0, error: null });
      return rows.length;
    } catch (err) {
      await this.recordError(stream, err);
      throw err;
    }
  }

  /** The columns of a table (lower-cased name → type); empty when it does not exist. */
  private async columnsOf(run: Run, schema: string, table: string): Promise<Map<string, string>> {
    const rows = (await run(`SELECT column_name, data_type FROM information_schema.columns WHERE table_catalog = current_database() AND table_schema = ${sqlString(schema)} AND table_name = ${sqlString(table)} ORDER BY ordinal_position`)).rows as [string, string][];
    return new Map(rows.map(([c, t]) => [c.toLowerCase(), t]));
  }

  /** Creates the table from the batch, or adds the batch's new columns; returns the batch's columns and the table's types. */
  private async ensureTable(run: Run, schema: string, table: string, src: string, exclude: string[]): Promise<{ incoming: string[]; types: Map<string, string>; created: boolean }> {
    const target = `${qi(schema)}.${qi(table)}`;
    const skip = new Set(exclude.map((c) => c.toLowerCase()));
    const incoming = (await run(`DESCRIBE SELECT * FROM ${src}`)).rows.map((r) => [String(r[0]), String(r[1])] as [string, string]).filter(([c]) => !skip.has(c.toLowerCase()));
    let types = await this.columnsOf(run, schema, table);
    if (!types.size) {
      await run(`CREATE TABLE ${target} AS SELECT ${incoming.map(([c]) => qi(c)).join(', ')} FROM ${src} LIMIT 0`);
      types = await this.columnsOf(run, schema, table);
      return { incoming: incoming.map(([c]) => c), types, created: true };
    }
    for (const [c, t] of incoming) {
      if (types.has(c.toLowerCase())) continue;
      await run(`ALTER TABLE ${target} ADD COLUMN ${qi(c)} ${t}`);
      types.set(c.toLowerCase(), t);
    }
    return { incoming: incoming.map(([c]) => c), types, created: false };
  }

  /** Appends the batch, each value cast to its column's type. */
  private async appendTo(run: Run, schema: string, table: string, src: string, exclude: string[]): Promise<void> {
    const { incoming, types } = await this.ensureTable(run, schema, table, src, exclude);
    const select = incoming.map((c) => `TRY_CAST(${qi(c)} AS ${types.get(c.toLowerCase())}) AS ${qi(c)}`).join(', ');
    await run(`INSERT INTO ${qi(schema)}.${qi(table)} BY NAME SELECT ${select} FROM ${src}`);
  }

  /** Applies changes: every key's rows are replaced by its latest change, deleted when that is a delete. */
  private async applyMirror(run: Run, stream: Stream, src: string): Promise<void> {
    const target = `${qi(stream.target_schema)}.${qi(stream.target_table)}`;
    const { incoming, types } = await this.ensureTable(run, stream.target_schema, stream.target_table, src, ['_op', '_seq']);
    const keys = stream.key_columns;
    const missing = keys.filter((k) => !types.has(k.toLowerCase()));
    if (missing.length) throw new Error(`Key column${missing.length === 1 ? '' : 's'} ${missing.join(', ')} not in the data`);
    const cast = (c: string) => `TRY_CAST(${qi(c)} AS ${types.get(c.toLowerCase())})`;
    const latest = `(SELECT * FROM ${src} QUALIFY row_number() OVER (PARTITION BY ${keys.map(qi).join(', ')} ORDER BY _seq DESC) = 1)`;
    await run(`DELETE FROM ${target} USING (SELECT DISTINCT ${keys.map((k) => `${cast(k)} AS ${qi(k)}`).join(', ')} FROM ${src}) AS __changed WHERE ${keys.map((k) => `${target}.${qi(k)} IS NOT DISTINCT FROM __changed.${qi(k)}`).join(' AND ')}`);
    await run(`INSERT INTO ${target} BY NAME SELECT ${incoming.map((c) => `${cast(c)} AS ${qi(c)}`).join(', ')} FROM ${latest} WHERE _op <> 'd'`);
  }

  /** Empties a mirrored table (a TRUNCATE at the source); the history keeps a 't' row. */
  async truncate(streamId: string): Promise<void> {
    const prev = this.chains.get(streamId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(async () => {
      const stream = await this.row(streamId);
      if (!stream) return;
      const owner = await this.ownerOf(stream);
      const run = (sql: string) => this.queries.run(owner, stream.workspace_id, sql, { cache: false, countTotal: false, maxRows: 1 });
      if ((await this.columnsOf(run, stream.target_schema, stream.target_table)).size) await run(`DELETE FROM ${qi(stream.target_schema)}.${qi(stream.target_table)}`);
      if (stream.keep_history && (await this.columnsOf(run, stream.target_schema, `${stream.target_table}__changes`)).size) await run(`INSERT INTO ${qi(stream.target_schema)}.${qi(`${stream.target_table}__changes`)} BY NAME SELECT 't' AS _op`);
    });
    this.chains.set(streamId, next);
    await next;
  }

  private async recordError(stream: Stream, err: unknown): Promise<void> {
    const message = ((err as Error).message ?? String(err)).split('\n')[0]!.slice(0, 1000);
    const fresh = (await this.row(stream.id)) ?? stream;
    await this.db.update(this.s.streams).set({ stats: { ...fresh.stats, last_error: message, last_error_at: new Date().toISOString() } }).where(eq(this.s.streams.id, stream.id));
    liveEvents.publish({ type: 'stream', at: new Date().toISOString(), workspace_id: stream.workspace_id, stream_id: stream.id, rows: 0, rows_total: fresh.stats.rows_total, duration_ms: 0, error: message });
  }

  private async setStatus(id: string, status: StreamStatus, error?: string | null): Promise<void> {
    const cur = await this.row(id);
    if (!cur) return;
    await this.db.update(this.s.streams).set({ status, ...(error ? { stats: { ...cur.stats, last_error: error.slice(0, 1000), last_error_at: new Date().toISOString() } } : {}) }).where(eq(this.s.streams.id, id));
  }

  // ------------------------------------------------------------------------------------------ HTTP pushes

  /** Appends a pushed body (JSON array, object or NDJSON) to an HTTP stream after checking its key. */
  async push(id: string, key: string | null, body: unknown): Promise<{ rows: number }> {
    const s = await this.row(id);
    // The same answer for "no such stream" and "wrong key".
    if (!s || s.kind !== 'http' || !s.key_hash || !key) throw unauthorized('Unknown stream or wrong push key');
    const a = Buffer.from(hashKey(key), 'hex');
    const b = Buffer.from(s.key_hash, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw unauthorized('Unknown stream or wrong push key');
    if (!s.enabled) throw badRequest('This stream is paused');
    const records = recordsOfPush(body);
    if (records.length > this.cfg.streams.max_batch_rows) throw badRequest(`Push at most ${this.cfg.streams.max_batch_rows} rows at once`);
    const rows = await this.write(id, records);
    return { rows };
  }

  // ------------------------------------------------------------------------------------------ consumers

  /** Checks that the source is reachable: Kafka topic partitions, Kinesis shards. Nothing is read or committed. */
  async test(p: Principal, input: { config: StreamConfig; sasl_password?: string | null; stream_id?: string | null }): Promise<{ ok: true; detail: string }> {
    const config = this.checkConfig(input.config);
    let password = input.sasl_password ?? null;
    if (!password && input.stream_id) {
      const s = await this.get(p, input.stream_id, 'EDITOR');
      password = this.secretOf(s);
    }
    if (config.kind === 'kafka') {
      const admin = this.kafka(config, password).admin();
      await admin.connect();
      try {
        const md = await admin.fetchTopicMetadata({ topics: [config.topic] });
        const t = md.topics[0];
        return { ok: true, detail: `Topic ${config.topic}: ${t?.partitions.length ?? 0} partition${t?.partitions.length === 1 ? '' : 's'}` };
      } finally {
        await admin.disconnect().catch(() => undefined);
      }
    }
    if (config.kind === 'kinesis') {
      const client = await this.kinesisFor(p.userId, config);
      const d = await client.send(new DescribeStreamSummaryCommand({ StreamName: config.stream }));
      const sum = d.StreamDescriptionSummary;
      return { ok: true, detail: `Stream ${config.stream}: ${sum?.StreamStatus ?? 'unknown'}, ${sum?.OpenShardCount ?? '?'} open shard(s)` };
    }
    if (config.kind === 'postgres') {
      const client = new pg.Client(await this.databases.pgClientConfig(p.userId, config.connection_id));
      await client.connect();
      try {
        const info = await this.pgTable(client, config.table);
        const wal = String((await client.query('SHOW wal_level')).rows[0]?.wal_level ?? '');
        const role = (await client.query('SELECT rolreplication OR rolsuper AS ok FROM pg_roles WHERE rolname = current_user')).rows[0]?.ok;
        if (wal !== 'logical') throw badRequest(`Postgres has wal_level = ${wal}; change data capture needs wal_level = logical (then restart Postgres)`);
        if (!role) throw badRequest('The connection\'s user needs the REPLICATION attribute (ALTER ROLE … WITH REPLICATION)');
        return { ok: true, detail: `${config.table}: ${info.columns.length} columns, key ${info.keys.join(', ') || '(none — give key columns)'}; wal_level logical` };
      } finally {
        await client.end().catch(() => undefined);
      }
    }
    return { ok: true, detail: 'HTTP streams receive pushes; nothing to connect to.' };
  }

  private secretOf(s: Stream): string | null {
    if (!s.encrypted_secret) return null;
    return this.cipher.decryptJson<{ sasl_password: string }>({ ciphertext: s.encrypted_secret, iv: s.iv!, tag: s.tag! }, s.id).sasl_password;
  }

  private kafka(c: Extract<StreamConfig, { kind: 'kafka' }>, password: string | null): Kafka {
    const sasl: SASLOptions | undefined = c.sasl_mechanism && c.sasl_username ? ({ mechanism: c.sasl_mechanism, username: c.sasl_username, password: password ?? '' } as SASLOptions) : undefined;
    return new Kafka({ clientId: 'duckview', brokers: c.brokers, ssl: c.ssl || undefined, sasl, logLevel: logLevel.NOTHING, connectionTimeout: 10_000, retry: { retries: 5 } });
  }

  private async kinesisFor(userId: string, c: Extract<StreamConfig, { kind: 'kinesis' }>): Promise<KinesisLike> {
    const creds = c.cloud_connection_id ? await this.cloud.awsCredentials(userId, c.cloud_connection_id) : null;
    return this.kinesisClient(c, creds ? { accessKeyId: creds.accessKeyId, secretAccessKey: creds.secretAccessKey, ...(creds.sessionToken ? { sessionToken: creds.sessionToken } : {}) } : null);
  }

  /** Starts the consumers of every enabled Kafka and Kinesis stream (at boot). */
  async startAll(): Promise<void> {
    if (!this.cfg.streams.enabled || !this.cfg.streams.consumers_enabled) return;
    const rows = await this.db.select().from(this.s.streams).where(eq(this.s.streams.enabled, true));
    for (const r of rows) await this.startRunner(r).catch((err) => logger().warn({ stream: r.id, err: (err as Error).message }, 'Stream could not start'));
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.runners.keys()].map((id) => this.stopRunner(id)));
    // Let batches being written finish before the engines close.
    await Promise.all([...this.chains.values()].map((c) => c.catch(() => undefined)));
  }

  isRunning(id: string): boolean {
    return this.runners.has(id);
  }

  private async startRunner(s: Stream): Promise<void> {
    if (s.kind === 'http') {
      await this.setStatus(s.id, 'running');
      return;
    }
    if (!this.cfg.streams.enabled || !this.cfg.streams.consumers_enabled || this.runners.has(s.id)) return;
    await this.setStatus(s.id, 'starting');
    const runner = s.kind === 'kafka' ? this.kafkaRunner(s) : s.kind === 'postgres' ? this.postgresRunner(s) : await this.kinesisRunner(s);
    this.runners.set(s.id, runner);
  }

  private async stopRunner(id: string): Promise<void> {
    const r = this.runners.get(id);
    this.runners.delete(id);
    if (r) await r.stop().catch(() => undefined);
    await this.setStatus(id, 'stopped');
  }

  private kafkaRunner(s: Stream): Runner {
    const c = s.config as Extract<StreamConfig, { kind: 'kafka' }>;
    const consumer: Consumer = this.kafka(c, this.secretOf(s)).consumer({ groupId: c.group_id || `duckview-${s.id}`, maxWaitTimeInMs: s.batch_seconds * 1000, minBytes: 256 * 1024, retry: { retries: 5 } });
    let stopped = false;
    consumer.on(consumer.events.GROUP_JOIN, () => void this.setStatus(s.id, 'running'));
    consumer.on(consumer.events.CRASH, (e) => void this.setStatus(s.id, 'error', `Kafka: ${e.payload.error.message}${e.payload.restart ? ' (restarting)' : ''}`));
    const go = async () => {
      await consumer.connect();
      await consumer.subscribe({ topic: c.topic, fromBeginning: !!c.from_beginning });
      await consumer.run({
        autoCommit: false,
        eachBatchAutoResolve: false,
        eachBatch: async ({ batch, resolveOffset, heartbeat, isRunning, isStale }) => {
          for (let i = 0; i < batch.messages.length; i += s.batch_rows) {
            if (!isRunning() || isStale()) return;
            const chunk = batch.messages.slice(i, i + s.batch_rows);
            await this.write(s.id, chunk.map((m) => ({ value: m.value ? m.value.toString('utf8') : null, key: m.key ? m.key.toString('utf8') : null, partition: batch.partition, offset: m.offset, timestamp: m.timestamp ? new Date(Number(m.timestamp)).toISOString() : null })));
            const last = chunk.at(-1)!.offset;
            resolveOffset(last);
            await consumer.commitOffsets([{ topic: batch.topic, partition: batch.partition, offset: (BigInt(last) + 1n).toString() }]);
            await heartbeat();
          }
        },
      });
    };
    go().catch((err) => {
      if (!stopped) void this.setStatus(s.id, 'error', `Kafka: ${(err as Error).message}`);
    });
    return {
      stop: async () => {
        stopped = true;
        await consumer.disconnect();
      },
    };
  }

  private async kinesisRunner(s: Stream): Promise<Runner> {
    const c = s.config as Extract<StreamConfig, { kind: 'kinesis' }>;
    let client: KinesisLike;
    try {
      client = await this.kinesisFor(s.user_id, c);
    } catch (err) {
      await this.setStatus(s.id, 'error', `Kinesis: ${(err as Error).message}`);
      return { stop: async () => undefined };
    }
    let stopped = false;
    let wake: (() => void) | null = null;
    const sleep = (ms: number) => new Promise<void>((res) => {
      const t = setTimeout(res, ms);
      wake = () => {
        clearTimeout(t);
        res();
      };
    });
    const loop = async () => {
      const iterators = new Map<string, string | null>();
      let shardsAt = 0;
      let backoff = 0;
      while (!stopped) {
        try {
          if (Date.now() - shardsAt > 60_000) {
            const shards: Shard[] = [];
            let token: string | undefined;
            do {
              const r = await client.send(new ListShardsCommand(token ? { NextToken: token } : { StreamName: c.stream }));
              shards.push(...(r.Shards ?? []));
              token = r.NextToken;
            } while (token);
            for (const sh of shards) if (!iterators.has(sh.ShardId!)) iterators.set(sh.ShardId!, null);
            shardsAt = Date.now();
          }
          const checkpoints = (await this.row(s.id))?.checkpoints ?? {};
          const records: StreamRecord[] = [];
          const reached: Record<string, string> = {};
          let behind = false;
          for (const [shard, it] of iterators) {
            if (stopped) break;
            let iterator = it;
            if (!iterator) {
              const seq = checkpoints[shard];
              const r = await client.send(new GetShardIteratorCommand({ StreamName: c.stream, ShardId: shard, ...(seq ? { ShardIteratorType: 'AFTER_SEQUENCE_NUMBER', StartingSequenceNumber: seq } : { ShardIteratorType: c.start ?? 'TRIM_HORIZON' }) }));
              iterator = r.ShardIterator ?? null;
            }
            if (!iterator) {
              iterators.delete(shard);
              continue;
            }
            const r = await client.send(new GetRecordsCommand({ ShardIterator: iterator, Limit: Math.min(s.batch_rows, 10_000) }));
            for (const rec of r.Records ?? []) {
              records.push({ value: rec.Data ? Buffer.from(rec.Data).toString('utf8') : null, key: rec.PartitionKey ?? null, partition: shard, offset: rec.SequenceNumber ?? null, timestamp: rec.ApproximateArrivalTimestamp ? new Date(rec.ApproximateArrivalTimestamp).toISOString() : null });
              if (rec.SequenceNumber) reached[shard] = rec.SequenceNumber;
            }
            if ((r.MillisBehindLatest ?? 0) > 0 && (r.Records ?? []).length) behind = true;
            // A closed shard has no next iterator once it is read to the end.
            if (r.NextShardIterator) iterators.set(shard, r.NextShardIterator);
            else iterators.delete(shard);
          }
          if (records.length) {
            for (let i = 0; i < records.length; i += s.batch_rows) await this.write(s.id, records.slice(i, i + s.batch_rows));
            const fresh = await this.row(s.id);
            if (fresh) await this.db.update(this.s.streams).set({ checkpoints: { ...fresh.checkpoints, ...reached } }).where(eq(this.s.streams.id, s.id));
          }
          const cur = await this.row(s.id);
          if (cur && cur.status !== 'running') await this.setStatus(s.id, 'running');
          backoff = 0;
          if (!behind) await sleep(records.length ? this.kinesisIdleMs : s.batch_seconds * 1000);
        } catch (err) {
          const e = err as Error & { name?: string };
          // An expired iterator is fetched again from the checkpoint.
          if (e.name === 'ExpiredIteratorException') {
            iterators.forEach((_v, k) => iterators.set(k, null));
            continue;
          }
          backoff = Math.min(backoff ? backoff * 2 : 2000, 60_000);
          await this.setStatus(s.id, 'error', `Kinesis: ${e.message}`);
          await sleep(backoff);
        }
      }
    };
    void loop();
    return {
      stop: async () => {
        stopped = true;
        (wake as (() => void) | null)?.();
      },
    };
  }

  // ------------------------------------------------------------------------------------------ Postgres CDC

  /** The replication slot and publication of a stream (one per stream). */
  slotName(s: Pick<Stream, 'id'>): string {
    return `duckview_${s.id.replace(/-/g, '').slice(0, 24)}`;
  }

  /** A source table's columns (with their DuckDB types) and key. */
  private async pgTable(client: pg.Client, table: string): Promise<{ oid: number; columns: { name: string; type: string }[]; keys: string[] }> {
    const [schema, name] = table.split('.') as [string, string];
    const rel = await client.query('SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN (\'r\', \'p\')', [schema, name]);
    if (!rel.rows[0]) throw badRequest(`Postgres has no table ${table}`);
    const oid = rel.rows[0].oid as number;
    const cols = await client.query('SELECT a.attname, format_type(a.atttypid, a.atttypmod) AS type FROM pg_attribute a WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum', [oid]);
    const pk = await client.query('SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey) WHERE i.indrelid = $1 AND i.indisprimary ORDER BY array_position(i.indkey, a.attnum)', [oid]);
    return { oid, columns: cols.rows.map((r) => ({ name: String(r.attname), type: duckdbTypeOf(String(r.type)) })), keys: pk.rows.map((r) => String(r.attname)) };
  }

  private async dropSlot(s: Stream): Promise<void> {
    const c = s.config as Extract<StreamConfig, { kind: 'postgres' }>;
    const client = new pg.Client(await this.databases.pgClientConfig(s.user_id, c.connection_id));
    await client.connect();
    try {
      const name = this.slotName(s);
      await client.query('SELECT pg_drop_replication_slot(slot_name) FROM pg_replication_slots WHERE slot_name = $1', [name]);
      await client.query(`DROP PUBLICATION IF EXISTS ${qi(name)}`);
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  /** Creates the mirrored table with the source's types (later batches are cast into them). */
  private async createTyped(s: Stream, columns: { name: string; type: string }[]): Promise<void> {
    const owner = await this.ownerOf(s);
    const run = (sql: string) => this.queries.run(owner, s.workspace_id, sql, { cache: false, countTotal: false, maxRows: 1 });
    if (s.target_schema !== 'main') await run(`CREATE SCHEMA IF NOT EXISTS ${qi(s.target_schema)}`);
    const meta = s.include_metadata ? ['_key VARCHAR', '_partition VARCHAR', '_offset VARCHAR', '_timestamp TIMESTAMPTZ', '_ingested_at TIMESTAMPTZ'] : [];
    await run(`CREATE TABLE IF NOT EXISTS ${qi(s.target_schema)}.${qi(s.target_table)} (${[...columns.map((c) => `${qi(c.name)} ${c.type}`), ...meta].join(', ')})`);
  }

  private postgresRunner(s: Stream): Runner {
    const c = s.config as Extract<StreamConfig, { kind: 'postgres' }>;
    const name = this.slotName(s);
    let stopped = false;
    let service: LogicalReplicationService | null = null;
    let retry: NodeJS.Timeout | null = null;
    let timer: NodeJS.Timeout | null = null;
    const start = async () => {
      try {
        const conn = await this.databases.pgClientConfig(s.user_id, c.connection_id);
        const client = new pg.Client(conn);
        await client.connect();
        try {
          const info = await this.pgTable(client, c.table);
          const cur = (await this.row(s.id))!;
          const keys = cur.key_columns.length ? cur.key_columns : info.keys;
          if (!keys.length) throw new Error(`${c.table} has no primary key: give key columns, and run ALTER TABLE ${c.table} REPLICA IDENTITY FULL so deletes carry them`);
          if (!cur.key_columns.length) await this.db.update(this.s.streams).set({ key_columns: keys }).where(eq(this.s.streams.id, s.id));
          const [schema, table] = c.table.split('.') as [string, string];
          if (!(await client.query('SELECT 1 FROM pg_publication WHERE pubname = $1', [name])).rowCount) await client.query(`CREATE PUBLICATION ${qi(name)} FOR TABLE ${qi(schema)}.${qi(table)}`);
          if (!(await client.query('SELECT 1 FROM pg_replication_slots WHERE slot_name = $1', [name])).rowCount) {
            // A new slot keeps every change from now on; the snapshot below may overlap it, which is harmless:
            // applying a change again leaves a key in the same state.
            await client.query('SELECT pg_create_logical_replication_slot($1, \'pgoutput\')', [name]);
            await this.db.update(this.s.streams).set({ checkpoints: {} }).where(eq(this.s.streams.id, s.id));
          }
          await this.createTyped(s, info.columns);
          if (c.snapshot !== false && (await this.row(s.id))!.checkpoints.snapshot !== 'done') {
            await this.setStatus(s.id, 'starting');
            await this.truncate(s.id);
            let last: unknown[] | null = null;
            for (;;) {
              if (stopped) return;
              const where = last ? `WHERE (${keys.map(qi).join(', ')}) > (${keys.map((_k, i) => `$${i + 1}`).join(', ')})` : '';
              const page = await client.query(`SELECT * FROM ${qi(schema)}.${qi(table)} ${where} ORDER BY ${keys.map(qi).join(', ')} LIMIT 5000`, last ?? []);
              if (!page.rows.length) break;
              await this.write(s.id, page.rows.map((row) => ({ value: row as Record<string, unknown>, op: 'r' as const })));
              const end = page.rows.at(-1) as Record<string, unknown>;
              last = keys.map((k) => end[k]);
            }
            const fresh = (await this.row(s.id))!;
            await this.db.update(this.s.streams).set({ checkpoints: { ...fresh.checkpoints, snapshot: 'done' } }).where(eq(this.s.streams.id, s.id));
          }
        } finally {
          await client.end().catch(() => undefined);
        }
        if (stopped) return;
        const svc = new LogicalReplicationService(conn, { acknowledge: { auto: false, timeoutSeconds: 0 }, flowControl: { enabled: true } });
        service = svc;
        let buffer: StreamRecord[] = [];
        let inTx = false;
        let committedLsn: string | null = null;
        let lastFlush = Date.now();
        let chain: Promise<unknown> = Promise.resolve();
        const serial = (fn: () => Promise<void>) => (chain = chain.then(fn, fn));
        const flush = async () => {
          if (!buffer.length || inTx) return;
          const batch = buffer;
          buffer = [];
          await this.write(s.id, batch);
          lastFlush = Date.now();
          if (committedLsn) {
            await svc.acknowledge(committedLsn);
            const fresh = await this.row(s.id);
            if (fresh) await this.db.update(this.s.streams).set({ checkpoints: { ...fresh.checkpoints, lsn: committedLsn } }).where(eq(this.s.streams.id, s.id));
          }
        };
        svc.on('data', (lsn: string, msg: Pgoutput.Message) =>
          serial(async () => {
            if (msg.tag === 'begin') inTx = true;
            else if (msg.tag === 'insert') buffer.push({ value: msg.new, op: 'c', offset: lsn });
            else if (msg.tag === 'update') {
              // A changed key: the old key's row goes away.
              if (msg.key) buffer.push({ value: msg.key, op: 'd', offset: lsn });
              buffer.push({ value: msg.new, op: 'u', offset: lsn });
            } else if (msg.tag === 'delete') buffer.push({ value: msg.old ?? msg.key ?? {}, op: 'd', offset: lsn });
            else if (msg.tag === 'truncate') {
              inTx = false;
              await flush();
              inTx = true;
              await this.truncate(s.id);
            } else if (msg.tag === 'commit') {
              inTx = false;
              committedLsn = lsn;
              if (buffer.length >= s.batch_rows || Date.now() - lastFlush >= s.batch_seconds * 1000) await flush();
              else if (!buffer.length) await svc.acknowledge(lsn);
            }
          }),
        );
        // Nothing pending: tell Postgres it may let go of WAL (other tables' changes keep coming).
        svc.on('heartbeat', (lsn: string, _ts: number, shouldRespond: boolean) => serial(async () => {
          if (shouldRespond && !buffer.length && !inTx) await svc.acknowledge(lsn);
        }));
        svc.on('error', (err: Error) => {
          if (stopped) return;
          void this.setStatus(s.id, 'error', `Postgres: ${err.message}`);
        });
        timer = setInterval(() => void serial(async () => {
          if (Date.now() - lastFlush >= s.batch_seconds * 1000) await flush();
        }).catch((err) => void this.setStatus(s.id, 'error', `Postgres: ${(err as Error).message}`)), 1000);
        timer.unref();
        await this.setStatus(s.id, 'running');
        svc.subscribe(new PgoutputPlugin({ protoVersion: 1, publicationNames: [name] }), name).catch((err: Error) => {
          if (stopped) return;
          void this.setStatus(s.id, 'error', `Postgres: ${err.message}`);
          if (timer) clearInterval(timer);
          retry = setTimeout(() => void start(), 15_000);
        });
      } catch (err) {
        if (stopped) return;
        await this.setStatus(s.id, 'error', `Postgres: ${(err as Error).message}`);
        retry = setTimeout(() => void start(), 15_000);
      }
    };
    void start();
    return {
      stop: async () => {
        stopped = true;
        if (retry) clearTimeout(retry);
        if (timer) clearInterval(timer);
        await service?.stop().catch(() => undefined);
      },
    };
  }
}
