/**
 * Streams the audit log to SIEMs and buckets: Splunk (HTTP Event Collector), Datadog Logs, Elasticsearch /
 * OpenSearch (_bulk), a signed NDJSON webhook, or gzipped NDJSON files in an S3 / R2 / GCS / Azure bucket (through
 * one of the administrator's cloud connections).
 *
 * The audit table is the source of truth: each sink keeps a cursor (timestamp, id) and a ticker exports what came
 * after it, oldest first, in batches — so nothing is lost across restarts or outages (at least once: a batch whose
 * answer was lost is sent again). Only events older than a couple of seconds are exported, because audit rows are
 * written asynchronously and a late row must not fall behind a cursor. A failing sink backs off (up to ten minutes)
 * and reports its last error; the others carry on.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { and, asc, eq, gt, lte, or } from 'drizzle-orm';
import type { MetadataStore } from '../db/index.js';
import type { AuditSink, AuditSinkType } from '../db/schema/sqlite.js';
import { AUDIT_SINK_TYPES } from '../db/schema/sqlite.js';
import type { DuckViewConfig } from '../config/index.js';
import { CredentialCipher, newId } from '../security/crypto.js';
import { egressPost } from '../security/egress.js';
import type { Principal } from './principal.js';
import { isPlatformAdmin } from './principal.js';
import type { AuditService } from './audit.js';
import type { CloudConnectionService } from './cloud.js';
import { badRequest, forbidden, notFound } from './errors.js';
import { logger } from '../observability/logger.js';

type AuditRow = typeof import('../db/schema/sqlite.js').auditLogs.$inferSelect;

/** One audit event as sinks receive it. */
export interface ExportedEvent {
  id: string;
  timestamp: string;
  action: string;
  actor_type: string;
  user_id: string | null;
  user_email: string | null;
  resource: string | null;
  status: string;
  error: string | null;
  duration_ms: number | null;
  ip: string | null;
  query_text?: string | null;
  source: 'duckview';
  host: string;
}

interface SinkSecret {
  token?: string;
  api_key?: string;
  username?: string;
  password?: string;
  signing_secret?: string;
}
export interface SinkInput {
  name?: string;
  type?: AuditSinkType;
  enabled?: boolean;
  config?: Record<string, unknown>;
  secret?: SinkSecret;
  /** Start from the beginning of the audit log instead of from now. */
  backfill?: boolean;
}
export type PublicSink = Omit<AuditSink, 'encrypted_secret' | 'iv' | 'tag'> & { secret_set: boolean };

const SETTLE_MS = 2000;

export class AuditExportService {
  private ticker: NodeJS.Timeout | null = null;
  private running = false;
  private emails = new Map<string, string | null>();
  /** Uploads a file to a bucket (the cloud service; replaceable in tests). */
  upload: (userId: string, connectionId: string, bucket: string, key: string, file: string) => Promise<void>;

  constructor(private readonly store: MetadataStore, private readonly cfg: DuckViewConfig, private readonly cipher: CredentialCipher, private readonly audit: AuditService, cloud: CloudConnectionService) {
    this.upload = async (userId, connectionId, bucket, key, file) => {
      const c = await cloud.getOwned(userId, connectionId);
      await cloud.uploadObject(c, bucket, key, file);
    };
  }
  private get db() {
    return this.store.db;
  }
  private get s() {
    return this.store.schema;
  }
  private get host(): string {
    try {
      return this.cfg.server.public_url ? new URL(this.cfg.server.public_url).host : os.hostname();
    } catch {
      return os.hostname();
    }
  }

  private requireAdmin(p: Principal) {
    if (!isPlatformAdmin(p)) throw forbidden('Only an administrator signed in to DuckView manages audit export');
  }

  toPublic(s: AuditSink): PublicSink {
    const { encrypted_secret, iv: _i, tag: _t, ...rest } = s;
    return { ...rest, secret_set: !!encrypted_secret };
  }

  private secretOf(s: AuditSink): SinkSecret {
    if (!s.encrypted_secret || !s.iv || !s.tag) return {};
    return this.cipher.decryptJson<SinkSecret>({ ciphertext: s.encrypted_secret, iv: s.iv, tag: s.tag }, `audit-sink:${s.id}`);
  }

  private normalise(type: AuditSinkType, config: Record<string, unknown>, secret: SinkSecret, existing: SinkSecret | null): { config: Record<string, unknown>; secret: SinkSecret } {
    const merged: SinkSecret = { ...(existing ?? {}), ...Object.fromEntries(Object.entries(secret).filter(([, v]) => typeof v === 'string' && v)) };
    const out: Record<string, unknown> = { include_sql: config.include_sql !== false };
    const url = (required: boolean) => {
      const raw = String(config.url ?? '').trim().replace(/\/+$/, '');
      if (!raw) {
        if (required) throw badRequest('url is required');
        return;
      }
      let u: URL;
      try {
        u = new URL(raw);
      } catch {
        throw badRequest('url is not a URL');
      }
      if (!['http:', 'https:'].includes(u.protocol)) throw badRequest('url must be http(s)');
      out.url = raw;
    };
    switch (type) {
      case 'splunk':
        url(true);
        if (!merged.token) throw badRequest('Splunk: an HTTP Event Collector token is required');
        for (const k of ['index', 'source', 'sourcetype']) if (config[k]) out[k] = String(config[k]).slice(0, 100);
        break;
      case 'datadog':
        if (!merged.api_key) throw badRequest('Datadog: an API key is required');
        out.site = String(config.site ?? 'datadoghq.com').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
        if (!/^[a-z0-9.-]+$/i.test(out.site as string)) throw badRequest('Datadog: site must be like datadoghq.com or datadoghq.eu');
        if (config.tags) out.tags = String(config.tags).slice(0, 500);
        break;
      case 'elastic':
        url(true);
        out.index = String(config.index ?? 'duckview-audit').toLowerCase();
        if (!/^[a-z0-9][a-z0-9_.-]*$/.test(out.index as string)) throw badRequest('Elastic: index must be a lower-case index name');
        if (!merged.api_key && !(merged.username && merged.password)) throw badRequest('Elastic: an API key, or a username and password, is required');
        break;
      case 'webhook':
        url(true);
        if (!merged.signing_secret) merged.signing_secret = `whsec_${crypto.randomBytes(24).toString('base64url')}`;
        break;
      case 's3': {
        const conn = String(config.connection_id ?? '');
        const bucket = String(config.bucket ?? '').trim();
        if (!conn) throw badRequest('S3: pick a cloud storage connection');
        if (!bucket) throw badRequest('S3: a bucket is required');
        out.connection_id = conn;
        out.bucket = bucket;
        out.prefix = String(config.prefix ?? 'duckview/audit').replace(/^\/+|\/+$/g, '');
        break;
      }
    }
    return { config: out, secret: merged };
  }

  async list(p: Principal): Promise<PublicSink[]> {
    this.requireAdmin(p);
    return (await this.db.select().from(this.s.auditSinks)).sort((a, b) => a.name.localeCompare(b.name)).map((x) => this.toPublic(x));
  }

  private async byId(id: string): Promise<AuditSink> {
    const s = (await this.db.select().from(this.s.auditSinks).where(eq(this.s.auditSinks.id, id)).limit(1))[0];
    if (!s) throw notFound('Audit sink');
    return s;
  }

  async create(p: Principal, input: SinkInput): Promise<{ sink: PublicSink; signing_secret: string | null }> {
    this.requireAdmin(p);
    if (!input.type || !AUDIT_SINK_TYPES.includes(input.type)) throw badRequest(`type must be one of ${AUDIT_SINK_TYPES.join(', ')}`);
    const name = (input.name ?? '').trim().slice(0, 120);
    if (!name) throw badRequest('name is required');
    const id = newId();
    const n = this.normalise(input.type, input.config ?? {}, input.secret ?? {}, null);
    const enc = this.cipher.encryptJson(n.secret, `audit-sink:${id}`);
    const now = new Date();
    const row: AuditSink = { id, name, type: input.type, config: n.config, encrypted_secret: enc.ciphertext, iv: enc.iv, tag: enc.tag, enabled: input.enabled ?? true, cursor_at: input.backfill ? new Date(0) : now, cursor_id: input.backfill ? '' : null, exported: 0, last_status: null, last_error: null, last_exported_at: null, retry_after: null, failures: 0, created_by: p.userId, created_at: now, updated_at: now };
    await this.db.insert(this.s.auditSinks).values(row);
    this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'audit_sink.create', resource: `audit_sink:${id}`, ip: p.ip });
    return { sink: this.toPublic(row), signing_secret: input.type === 'webhook' && !input.secret?.signing_secret ? n.secret.signing_secret ?? null : null };
  }

  async update(p: Principal, id: string, patch: SinkInput): Promise<PublicSink> {
    this.requireAdmin(p);
    const cur = await this.byId(id);
    const set: Partial<AuditSink> = { updated_at: new Date() };
    if (patch.name !== undefined) set.name = patch.name.trim().slice(0, 120) || cur.name;
    if (patch.enabled !== undefined) {
      set.enabled = patch.enabled;
      if (patch.enabled) Object.assign(set, { retry_after: null, failures: 0 });
    }
    if (patch.config !== undefined || patch.secret !== undefined) {
      const n = this.normalise(cur.type, patch.config ?? cur.config, patch.secret ?? {}, this.secretOf(cur));
      const enc = this.cipher.encryptJson(n.secret, `audit-sink:${id}`);
      Object.assign(set, { config: n.config, encrypted_secret: enc.ciphertext, iv: enc.iv, tag: enc.tag, retry_after: null, failures: 0 });
    }
    await this.db.update(this.s.auditSinks).set(set).where(eq(this.s.auditSinks.id, id));
    this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'audit_sink.update', resource: `audit_sink:${id}`, ip: p.ip });
    return this.toPublic({ ...cur, ...set });
  }

  async remove(p: Principal, id: string): Promise<void> {
    this.requireAdmin(p);
    await this.byId(id);
    await this.db.delete(this.s.auditSinks).where(eq(this.s.auditSinks.id, id));
    this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'audit_sink.delete', resource: `audit_sink:${id}`, ip: p.ip });
  }

  /** Sends one synthetic event, without moving the cursor. */
  async test(p: Principal, id: string): Promise<{ ok: boolean; error: string | null }> {
    this.requireAdmin(p);
    const sink = await this.byId(id);
    const ev: ExportedEvent = { id: newId(), timestamp: new Date().toISOString(), action: 'audit_sink.test', actor_type: 'USER', user_id: p.userId, user_email: p.email, resource: `audit_sink:${id}`, status: 'ok', error: null, duration_ms: null, ip: p.ip ?? null, source: 'duckview', host: this.host };
    try {
      await this.send(sink, [ev]);
      return { ok: true, error: null };
    } catch (err) {
      return { ok: false, error: (err as Error).message.slice(0, 500) };
    }
  }

  // ------------------------------------------------------------------------------------------ exporting

  private async email(userId: string | null): Promise<string | null> {
    if (!userId) return null;
    if (!this.emails.has(userId)) {
      const u = (await this.db.select({ email: this.s.users.email }).from(this.s.users).where(eq(this.s.users.id, userId)).limit(1))[0];
      if (this.emails.size > 5000) this.emails.clear();
      this.emails.set(userId, u?.email ?? null);
    }
    return this.emails.get(userId) ?? null;
  }

  private async toEvent(r: AuditRow, includeSql: boolean): Promise<ExportedEvent> {
    return { id: r.id, timestamp: r.timestamp.toISOString(), action: r.action, actor_type: r.actor_type, user_id: r.user_id, user_email: await this.email(r.user_id), resource: r.resource, status: r.status, error: r.error, duration_ms: r.duration_ms, ip: r.ip_address, ...(includeSql ? { query_text: r.query_text } : {}), source: 'duckview', host: this.host };
  }

  /** Exports what each enabled sink has not received yet; called by the ticker and by tests. */
  async tick(now = new Date()): Promise<Record<string, number>> {
    if (this.running) return {};
    this.running = true;
    const done: Record<string, number> = {};
    try {
      const sinks = await this.db.select().from(this.s.auditSinks).where(eq(this.s.auditSinks.enabled, true));
      for (const sink of sinks) {
        if (sink.retry_after && sink.retry_after > now) continue;
        done[sink.id] = await this.drain(sink, now).catch(() => 0);
      }
    } finally {
      this.running = false;
    }
    return done;
  }

  private async drain(sink: AuditSink, now: Date): Promise<number> {
    const settled = new Date(now.getTime() - SETTLE_MS);
    let cursorAt = sink.cursor_at ?? sink.created_at;
    let cursorId = sink.cursor_id ?? '';
    let total = 0;
    for (let round = 0; round < 20; round++) {
      const t = this.s.auditLogs;
      const rows = await this.db.select().from(t).where(and(lte(t.timestamp, settled), or(gt(t.timestamp, cursorAt), and(eq(t.timestamp, cursorAt), gt(t.id, cursorId))))).orderBy(asc(t.timestamp), asc(t.id)).limit(this.cfg.audit_export.batch_size);
      if (!rows.length) break;
      const events = await Promise.all(rows.map((r) => this.toEvent(r, sink.config.include_sql !== false)));
      try {
        await this.send(sink, events);
      } catch (err) {
        const failures = sink.failures + 1;
        const wait = Math.min(10_000 * 2 ** (failures - 1), 600_000);
        await this.db.update(this.s.auditSinks).set({ last_status: 'error', last_error: (err as Error).message.slice(0, 500), failures, retry_after: new Date(now.getTime() + wait) }).where(eq(this.s.auditSinks.id, sink.id));
        logger().warn({ sink: sink.id, type: sink.type, err: (err as Error).message }, 'Audit export failed');
        throw err;
      }
      const last = rows[rows.length - 1]!;
      cursorAt = last.timestamp;
      cursorId = last.id;
      total += rows.length;
      sink = { ...sink, failures: 0 };
      await this.db.update(this.s.auditSinks).set({ cursor_at: cursorAt, cursor_id: cursorId, exported: (await this.byId(sink.id)).exported + rows.length, last_status: 'ok', last_error: null, last_exported_at: new Date(), failures: 0, retry_after: null }).where(eq(this.s.auditSinks.id, sink.id));
      if (rows.length < this.cfg.audit_export.batch_size) break;
    }
    return total;
  }

  private post(url: string, body: string | Buffer, headers: Record<string, string>) {
    // Administrators point sinks at their own SIEM: private addresses and plain http are allowed.
    return egressPost(url, body, headers, { allowPrivate: true, allowHttp: true, timeoutMs: 30_000 });
  }

  private async ok(res: { status: number; body: string }, what: string, accept = (s: number) => s >= 200 && s < 300): Promise<void> {
    if (!accept(res.status)) throw new Error(`${what} answered ${res.status}${res.body ? `: ${res.body.slice(0, 300)}` : ''}`);
  }

  async send(sink: AuditSink, events: ExportedEvent[]): Promise<void> {
    const secret = this.secretOf(sink);
    const c = sink.config as Record<string, string>;
    switch (sink.type) {
      case 'splunk': {
        const body = events.map((e) => JSON.stringify({ time: Date.parse(e.timestamp) / 1000, host: e.host, source: c.source || 'duckview', sourcetype: c.sourcetype || 'duckview:audit', ...(c.index ? { index: c.index } : {}), event: e })).join('\n');
        return this.ok(await this.post(`${c.url}/services/collector/event`, body, { authorization: `Splunk ${secret.token}`, 'content-type': 'application/json' }), 'Splunk');
      }
      case 'datadog': {
        const base = (this.cfg.audit_export.datadog_url ?? `https://http-intake.logs.${c.site}`).replace(/\/+$/, '');
        const body = JSON.stringify(events.map((e) => ({ ddsource: 'duckview', service: 'duckview', hostname: e.host, ddtags: ['source:duckview', `action:${e.action}`, `status:${e.status}`, ...(c.tags ? [c.tags] : [])].join(','), message: `${e.action} ${e.resource ?? ''} by ${e.user_email ?? e.actor_type}`.trim(), status: e.status === 'ok' ? 'info' : 'error', date: e.timestamp, duckview: e })));
        return this.ok(await this.post(`${base}/api/v2/logs`, body, { 'dd-api-key': secret.api_key!, 'content-type': 'application/json' }), 'Datadog', (s) => s === 202 || s === 200);
      }
      case 'elastic': {
        const body = events.map((e) => `${JSON.stringify({ create: { _index: c.index, _id: e.id } })}\n${JSON.stringify({ '@timestamp': e.timestamp, ...e })}`).join('\n') + '\n';
        const auth = secret.api_key ? `ApiKey ${secret.api_key}` : `Basic ${Buffer.from(`${secret.username}:${secret.password}`).toString('base64')}`;
        const res = await this.post(`${c.url}/_bulk`, body, { authorization: auth, 'content-type': 'application/x-ndjson' });
        await this.ok(res, 'Elasticsearch');
        // _bulk answers 200 with per-item errors; a document that already exists (a resend) is fine.
        const parsed = JSON.parse(res.body || '{}') as { errors?: boolean; items?: { create?: { status: number; error?: { type?: string; reason?: string } } }[] };
        const bad = parsed.errors ? parsed.items?.find((i) => i.create && i.create.status >= 300 && i.create.status !== 409) : undefined;
        if (bad) throw new Error(`Elasticsearch rejected a document: ${bad.create?.error?.type ?? ''} ${bad.create?.error?.reason ?? ''}`.trim());
        return;
      }
      case 'webhook': {
        const body = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
        const ts = String(Math.floor(Date.now() / 1000));
        const sig = crypto.createHmac('sha256', secret.signing_secret ?? '').update(`${ts}.${body}`).digest('hex');
        return this.ok(await this.post(c.url!, body, { 'content-type': 'application/x-ndjson', 'x-duckview-event': 'audit', 'x-duckview-timestamp': ts, 'x-duckview-signature': `sha256=${sig}` }), 'The webhook');
      }
      case 's3': {
        const first = events[0]!;
        const day = first.timestamp.slice(0, 10);
        const key = `${c.prefix ? `${c.prefix}/` : ''}dt=${day}/${first.timestamp.replace(/[:.]/g, '-')}_${first.id}.ndjson.gz`;
        const file = path.join(os.tmpdir(), `dv-audit-${newId()}.ndjson.gz`);
        fs.writeFileSync(file, zlib.gzipSync(events.map((e) => JSON.stringify(e)).join('\n') + '\n'));
        try {
          await this.upload(sink.created_by ?? '', c.connection_id!, c.bucket!, key, file);
        } finally {
          fs.rmSync(file, { force: true });
        }
        return;
      }
    }
  }

  start(): void {
    if (this.ticker || !this.cfg.audit_export.enabled) return;
    this.ticker = setInterval(() => void this.tick().catch((err) => logger().warn({ err: (err as Error).message }, 'Audit export tick failed')), this.cfg.audit_export.interval_seconds * 1000);
    this.ticker.unref();
  }

  stop(): void {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
  }
}
