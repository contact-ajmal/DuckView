/**
 * Queries as an API. A read-only SELECT is published at GET /q/<slug>: callers pass parameters in the query string
 * ({{name}} placeholders in the SQL, typed and inserted as literals), and get the rows back as JSON (or CSV with
 * ?format=csv). Each endpoint has its own key (sent as `Authorization: Bearer <key>` or `x-api-key`), shown once,
 * unless it is public. Calls run as the endpoint's owner with the read scope, under their access policies, are
 * rate-limited per endpoint, and are audited.
 */
import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { MetadataStore } from '../db/index.js';
import type { EndpointParam, QueryEndpoint } from '../db/schema/sqlite.js';
import type { AppContext } from '../context.js';
import type { Principal } from './principal.js';
import { requireWrite } from './principal.js';
import { HttpError, badRequest, forbidden, notFound } from './errors.js';
import { newId } from '../security/crypto.js';
import { analyzeSql } from '../engine/sql-guard.js';

export type PublicEndpoint = Omit<QueryEndpoint, 'key_hash'> & { url: string; has_key: boolean };
export interface EndpointInput {
  name?: string;
  slug?: string;
  description?: string | null;
  sql?: string;
  params?: EndpointParam[];
  public?: boolean;
  max_rows?: number;
  rate_per_minute?: number;
  enabled?: boolean;
}

const hashKey = (key: string) => crypto.createHash('sha256').update(key).digest('hex');
const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/** The {{names}} a statement uses, in order of first appearance. */
export function placeholders(sql: string): string[] {
  return [...new Set([...sql.matchAll(PLACEHOLDER)].map((m) => m[1]!))];
}

/** A caller's value as a SQL literal of the parameter's type; refuses anything that is not that type. */
export function literalFor(p: EndpointParam, raw: string): string {
  const v = raw.trim();
  switch (p.type) {
    case 'integer':
      if (!/^-?\d{1,18}$/.test(v)) throw badRequest(`${p.name} must be a whole number`);
      return v;
    case 'number':
      if (!/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(v)) throw badRequest(`${p.name} must be a number`);
      return v;
    case 'boolean':
      if (!/^(true|false|1|0)$/i.test(v)) throw badRequest(`${p.name} must be true or false`);
      return /^(true|1)$/i.test(v) ? 'TRUE' : 'FALSE';
    case 'date':
      if (!/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?$/.test(v) || Number.isNaN(Date.parse(v))) throw badRequest(`${p.name} must be a date like 2026-01-31`);
      return v.length > 10 ? `TIMESTAMP '${v.replace('T', ' ')}'` : `DATE '${v}'`;
    default:
      if (v.length > 1000) throw badRequest(`${p.name} is too long`);
      return `'${raw.replace(/'/g, "''")}'`;
  }
}

export class EndpointService {
  private ctx!: AppContext;
  private buckets = new Map<string, { tokens: number; at: number }>();
  constructor(private readonly store: MetadataStore) {}
  bind(ctx: AppContext) {
    this.ctx = ctx;
  }
  private get db() {
    return this.store.db;
  }
  private get s() {
    return this.store.schema;
  }

  private toPublic(e: QueryEndpoint): PublicEndpoint {
    const { key_hash, ...rest } = e;
    const base = this.ctx.cfg.server.public_url?.replace(/\/+$/, '') ?? '';
    return { ...rest, url: `${base}/q/${e.slug}`, has_key: !!key_hash };
  }

  async list(p: Principal, workspaceId: string): Promise<PublicEndpoint[]> {
    await this.ctx.workspaces.get(p, workspaceId);
    return (await this.db.select().from(this.s.queryEndpoints).where(eq(this.s.queryEndpoints.workspace_id, workspaceId))).map((e) => this.toPublic(e));
  }

  private async own(p: Principal, id: string): Promise<QueryEndpoint> {
    const row = (await this.db.select().from(this.s.queryEndpoints).where(eq(this.s.queryEndpoints.id, id)).limit(1))[0];
    if (!row) throw notFound('Endpoint');
    await this.ctx.workspaces.get(p, row.workspace_id, 'EDITOR');
    return row;
  }

  /** Checks the SQL is one read-only statement whose {{placeholders}} are all declared (undeclared ones are added as strings). */
  private async validate(p: Principal, workspaceId: string, input: EndpointInput, current?: QueryEndpoint) {
    const sql = (input.sql ?? current?.sql ?? '').trim().replace(/;+\s*$/, '');
    if (!sql) throw badRequest('An endpoint needs a SELECT');
    const a = analyzeSql(sql.replace(PLACEHOLDER, 'NULL'));
    if (a.statements.length !== 1 || a.isMutating) throw badRequest('An endpoint is one read-only SELECT');
    const declared = input.params ?? current?.params ?? [];
    const names = placeholders(sql);
    const params: EndpointParam[] = names.map((n) => declared.find((d) => d.name === n) ?? { name: n, type: 'string', required: true, default: null });
    for (const prm of params) if (prm.default != null) literalFor(prm, prm.default);
    // It must run: every parameter at its default, or a harmless value of its type.
    const sample = sql.replace(PLACEHOLDER, (_m, n: string) => {
      const prm = params.find((x) => x.name === n)!;
      return prm.default != null ? literalFor(prm, prm.default) : prm.type === 'date' ? "DATE '2000-01-01'" : prm.type === 'boolean' ? 'TRUE' : prm.type === 'string' ? "''" : '0';
    });
    await this.ctx.queries.run(p, workspaceId, `SELECT * FROM (${sample}) AS _e LIMIT 0`, { cache: false, maxRows: 1 });
    const name = (input.name ?? current?.name ?? '').trim().slice(0, 120);
    if (!name) throw badRequest('Give the endpoint a name');
    const slug = (input.slug ?? current?.slug ?? name).trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
    if (!slug) throw badRequest('The address needs letters or digits');
    const clash = (await this.db.select({ id: this.s.queryEndpoints.id }).from(this.s.queryEndpoints).where(eq(this.s.queryEndpoints.slug, slug)).limit(1))[0];
    if (clash && clash.id !== current?.id) throw badRequest(`The address /q/${slug} is taken; choose another`);
    const maxRows = input.max_rows ?? current?.max_rows ?? 1000;
    const rate = input.rate_per_minute ?? current?.rate_per_minute ?? 60;
    if (maxRows < 1 || maxRows > 100_000) throw badRequest('Return between 1 and 100,000 rows');
    if (rate < 1 || rate > 6000) throw badRequest('Allow between 1 and 6,000 calls a minute');
    return { name, slug, sql, params, description: input.description !== undefined ? input.description?.trim() || null : current?.description ?? null, public: input.public ?? current?.public ?? false, max_rows: maxRows, rate_per_minute: rate, enabled: input.enabled ?? current?.enabled ?? true };
  }

  async create(p: Principal, workspaceId: string, input: EndpointInput): Promise<{ endpoint: PublicEndpoint; key: string | null }> {
    requireWrite(p);
    await this.ctx.workspaces.get(p, workspaceId, 'EDITOR');
    const v = await this.validate(p, workspaceId, input);
    const key = v.public ? null : `dvq_${crypto.randomBytes(24).toString('base64url')}`;
    const now = new Date();
    const row: QueryEndpoint = { id: newId(), workspace_id: workspaceId, user_id: p.userId, ...v, key_hash: key ? hashKey(key) : null, key_hint: key ? key.slice(-4) : null, calls: 0, last_called_at: null, created_at: now, updated_at: now };
    await this.db.insert(this.s.queryEndpoints).values(row);
    this.ctx.audit.log({ userId: p.userId, actorType: p.actorType, action: 'endpoint.publish', resource: `workspace:${workspaceId}`, queryText: `/q/${row.slug}${row.public ? ' (public)' : ''}`, ip: p.ip });
    return { endpoint: this.toPublic(row), key };
  }

  async update(p: Principal, id: string, input: EndpointInput): Promise<{ endpoint: PublicEndpoint; key: string | null }> {
    requireWrite(p);
    const cur = await this.own(p, id);
    const v = await this.validate(p, cur.workspace_id, input, cur);
    // Leaving public mode needs a key; the new key is returned once.
    const key = !v.public && !cur.key_hash ? `dvq_${crypto.randomBytes(24).toString('base64url')}` : null;
    const set = { ...v, ...(key ? { key_hash: hashKey(key), key_hint: key.slice(-4) } : {}), updated_at: new Date() };
    await this.db.update(this.s.queryEndpoints).set(set).where(eq(this.s.queryEndpoints.id, id));
    return { endpoint: this.toPublic({ ...cur, ...set }), key };
  }

  async rotateKey(p: Principal, id: string): Promise<{ key: string }> {
    requireWrite(p);
    await this.own(p, id);
    const key = `dvq_${crypto.randomBytes(24).toString('base64url')}`;
    await this.db.update(this.s.queryEndpoints).set({ key_hash: hashKey(key), key_hint: key.slice(-4), public: false, updated_at: new Date() }).where(eq(this.s.queryEndpoints.id, id));
    return { key };
  }

  async remove(p: Principal, id: string): Promise<void> {
    requireWrite(p);
    await this.own(p, id);
    await this.db.delete(this.s.queryEndpoints).where(eq(this.s.queryEndpoints.id, id));
  }

  /** A call from outside: the key, the rate limit, the parameters, then the query as the endpoint's owner. */
  async call(slug: string, key: string | null, query: Record<string, string>, ip: string) {
    const c = this.ctx;
    const e = (await this.db.select().from(this.s.queryEndpoints).where(eq(this.s.queryEndpoints.slug, slug)).limit(1))[0];
    if (!e || !e.enabled) throw notFound('Endpoint');
    if (!e.public) {
      if (!key || !e.key_hash) throw new HttpError(401, 'This endpoint needs its key: Authorization: Bearer <key>', 'UNAUTHORIZED');
      const a = Buffer.from(hashKey(key));
      const b = Buffer.from(e.key_hash);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new HttpError(401, 'That key does not open this endpoint', 'UNAUTHORIZED');
    }
    // A token bucket per endpoint.
    const now = Date.now();
    const bucket = this.buckets.get(e.id) ?? { tokens: e.rate_per_minute, at: now };
    bucket.tokens = Math.min(e.rate_per_minute, bucket.tokens + ((now - bucket.at) / 60_000) * e.rate_per_minute);
    bucket.at = now;
    if (bucket.tokens < 1) {
      this.buckets.set(e.id, bucket);
      throw new HttpError(429, `Too many calls: this endpoint allows ${e.rate_per_minute} a minute`, 'RATE_LIMITED');
    }
    bucket.tokens -= 1;
    this.buckets.set(e.id, bucket);
    const sql = e.sql.replace(PLACEHOLDER, (_m, n: string) => {
      const prm = e.params.find((x) => x.name === n)!;
      const raw = query[n] ?? prm.default;
      if (raw == null || raw === '') {
        if (prm.required) throw badRequest(`Missing parameter ${n}`);
        return 'NULL';
      }
      return literalFor(prm, raw);
    });
    const owner = await c.auth.findActive(e.user_id);
    if (!owner) throw forbidden('The owner of this endpoint no longer has access');
    // The owner's authority, narrowed to reading.
    const p: Principal = { ...c.auth.principalFromUser(owner, 'token', ip), scopes: ['read'] };
    const r = await c.queries.run(p, e.workspace_id, sql, { maxRows: e.max_rows });
    await this.db.update(this.s.queryEndpoints).set({ calls: e.calls + 1, last_called_at: new Date() }).where(eq(this.s.queryEndpoints.id, e.id));
    c.audit.log({ userId: owner.id, actorType: 'USER', action: 'endpoint.call', resource: `workspace:${e.workspace_id}`, queryText: `/q/${e.slug}`, ip, durationMs: r.durationMs });
    return { endpoint: e, result: r };
  }
}
