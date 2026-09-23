/**
 * Signed embeds: a dashboard or notebook shown inside another application, without a DuckView login.
 *
 * A workspace owner creates an embed key (its secret is shown once). The host application's backend signs a JWT
 * (HS256, header `kid` = the key id) for each page view:
 *   { "res": "dashboard:<id>" | "notebook:<id>", "sub": "<the host's user>", "exp": <unix seconds>,
 *     "attrs": { "tenant": "acme" }, "params": { "region": "EU" } }
 * and puts https://duckview.example.com/embed/view?token=<jwt> in an iframe.
 *
 * Every request of the embed carries the token and is checked again: the signature, expiry (at most 7 days after
 * iat), the key (not revoked; its creator still active with access), and that the object belongs to the key's
 * workspace. The viewer can load that one object only — a grid dashboard's widgets, or a notebook's cells run
 * live — never anything else and never SQL of their own. Queries run as the key's creator with the read scope only;
 * access policies that apply to embeds filter rows and mask columns, with the token's attributes as
 * {{embed.<name>}} in row filters. A notebook's inputs take the token's params. The page may be framed by the key's
 * allowed origins (Content-Security-Policy frame-ancestors).
 */
import crypto from 'node:crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { MetadataStore } from '../db/index.js';
import type { EmbedKey, NotebookCell, NotebookOutput } from '../db/schema/sqlite.js';
import { CredentialCipher, newId } from '../security/crypto.js';
import type { Principal } from './principal.js';
import { requireWrite } from './principal.js';
import type { WorkspaceService } from './workspaces.js';
import type { AuthService } from './auth.js';
import type { AuditService } from './audit.js';
import type { DashboardService } from './bi.js';
import type { NotebookService } from './notebooks.js';
import type { QueryService } from './query.js';
import { HttpError, badRequest, notFound } from './errors.js';

export type PublicEmbedKey = Omit<EmbedKey, 'encrypted_secret' | 'iv' | 'tag'>;
export interface EmbedClaims { res: string; sub?: string; exp: number; iat?: number; attrs?: Record<string, string | number | boolean>; params?: Record<string, string | number>; theme?: 'light' | 'dark' }
export interface EmbedContext { key: EmbedKey; claims: EmbedClaims; type: 'dashboard' | 'notebook'; id: string; principal: Principal }

const MAX_LIFETIME_S = 7 * 24 * 3600;
const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const unauthorized = (msg: string) => new HttpError(401, msg, 'EMBED_UNAUTHORIZED');

/** Signs an embed token (what a host application's backend does; DuckView uses it for "copy embed link"). */
export function signEmbedToken(keyId: string, secret: string, claims: EmbedClaims): string {
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: keyId }));
  const body = b64url(JSON.stringify(claims));
  const sig = b64url(crypto.createHmac('sha256', secret).update(`${head}.${body}`).digest());
  return `${head}.${body}.${sig}`;
}

export class EmbedService {
  constructor(private readonly store: MetadataStore, private readonly cipher: CredentialCipher, private readonly workspaces: WorkspaceService, private readonly auth: AuthService, private readonly audit: AuditService, private readonly dashboards: DashboardService, private readonly notebooks: NotebookService, private readonly queries: QueryService, private readonly publicUrl: () => string | null) {}
  private get db() {
    return this.store.db;
  }
  private get s() {
    return this.store.schema;
  }
  private toPublic(k: EmbedKey): PublicEmbedKey {
    const { encrypted_secret: _e, iv: _i, tag: _t, ...rest } = k;
    return rest;
  }
  private secret(k: EmbedKey): string {
    return this.cipher.decryptJson<{ secret: string }>({ ciphertext: k.encrypted_secret, iv: k.iv, tag: k.tag }, k.id).secret;
  }

  private checkOrigins(origins: string[] | undefined): string[] {
    return [...new Set((origins ?? []).map((o) => o.trim().replace(/\/+$/, '')).filter(Boolean))].map((o) => {
      if (!/^https?:\/\/(\*\.)?[\w.-]+(:\d+)?$/.test(o)) throw badRequest(`"${o}" is not an origin (https://app.example.com)`);
      return o;
    });
  }

  // ------------------------------------------------------------------------------------------ keys

  async list(p: Principal, workspaceId: string): Promise<PublicEmbedKey[]> {
    await this.workspaces.get(p, workspaceId, 'OWNER');
    return (await this.db.select().from(this.s.embedKeys).where(eq(this.s.embedKeys.workspace_id, workspaceId)).orderBy(desc(this.s.embedKeys.created_at))).map((k) => this.toPublic(k));
  }

  async create(p: Principal, workspaceId: string, input: { name: string; allowed_origins?: string[] }): Promise<{ key: PublicEmbedKey; secret: string }> {
    requireWrite(p);
    await this.workspaces.get(p, workspaceId, 'OWNER');
    const id = `emb_${newId().replace(/-/g, '').slice(0, 16)}`;
    const secret = `dves_${crypto.randomBytes(32).toString('base64url')}`;
    const enc = this.cipher.encryptJson({ secret }, id);
    const row: EmbedKey = { id, workspace_id: workspaceId, name: (input.name ?? '').trim().slice(0, 120) || 'Embed key', encrypted_secret: enc.ciphertext, iv: enc.iv, tag: enc.tag, allowed_origins: this.checkOrigins(input.allowed_origins), created_by: p.userId, last_used_at: null, revoked_at: null, created_at: new Date() };
    await this.db.insert(this.s.embedKeys).values(row);
    this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'embed.key_create', resource: `embed_key:${id}`, ip: p.ip });
    return { key: this.toPublic(row), secret };
  }

  async update(p: Principal, id: string, patch: { name?: string; allowed_origins?: string[] }): Promise<PublicEmbedKey> {
    requireWrite(p);
    const k = await this.load(id);
    await this.workspaces.get(p, k.workspace_id, 'OWNER');
    const set: Partial<EmbedKey> = {};
    if (patch.name !== undefined) set.name = patch.name.trim().slice(0, 120) || k.name;
    if (patch.allowed_origins !== undefined) set.allowed_origins = this.checkOrigins(patch.allowed_origins);
    await this.db.update(this.s.embedKeys).set(set).where(eq(this.s.embedKeys.id, id));
    return this.toPublic({ ...k, ...set });
  }

  async revoke(p: Principal, id: string): Promise<void> {
    requireWrite(p);
    const k = await this.load(id);
    await this.workspaces.get(p, k.workspace_id, 'OWNER');
    await this.db.update(this.s.embedKeys).set({ revoked_at: new Date() }).where(eq(this.s.embedKeys.id, id));
    this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'embed.key_revoke', resource: `embed_key:${id}`, ip: p.ip });
  }

  private async load(id: string): Promise<EmbedKey> {
    const k = (await this.db.select().from(this.s.embedKeys).where(eq(this.s.embedKeys.id, id)).limit(1))[0];
    if (!k) throw notFound('Embed key');
    return k;
  }

  /** A signed link for a key (owners): to try an embed, or for hosts that do not sign themselves. */
  async sign(p: Principal, workspaceId: string, input: { key_id: string; resource_type: 'dashboard' | 'notebook'; resource_id: string; sub?: string; attrs?: EmbedClaims['attrs']; params?: EmbedClaims['params']; expires_in?: number; theme?: 'light' | 'dark' }): Promise<{ token: string; url: string; expires_at: string }> {
    requireWrite(p);
    await this.workspaces.get(p, workspaceId, 'OWNER');
    const k = await this.load(input.key_id);
    if (k.workspace_id !== workspaceId || k.revoked_at) throw badRequest('That key is not an active key of this workspace');
    await this.resource(workspaceId, input.resource_type, input.resource_id);
    const now = Math.floor(Date.now() / 1000);
    const ttl = Math.min(Math.max(60, Math.floor(input.expires_in ?? 3600)), MAX_LIFETIME_S);
    const claims: EmbedClaims = { res: `${input.resource_type}:${input.resource_id}`, sub: input.sub || p.email, iat: now, exp: now + ttl, ...(input.attrs ? { attrs: input.attrs } : {}), ...(input.params ? { params: input.params } : {}), ...(input.theme ? { theme: input.theme } : {}) };
    const token = signEmbedToken(k.id, this.secret(k), claims);
    return { token, url: `${this.publicUrl() ?? ''}/embed/view?token=${token}`, expires_at: new Date(claims.exp * 1000).toISOString() };
  }

  // ------------------------------------------------------------------------------------------ verification

  private async resource(workspaceId: string, type: string, id: string): Promise<void> {
    if (type === 'dashboard') {
      const d = (await this.db.select({ w: this.s.dashboards.workspace_id, kind: this.s.dashboards.kind }).from(this.s.dashboards).where(eq(this.s.dashboards.id, id)).limit(1))[0];
      if (!d || d.w !== workspaceId) throw notFound('Dashboard');
      if (d.kind === 'mosaic') throw badRequest('Mosaic dashboards cannot be embedded yet — embed a grid dashboard or a notebook');
      return;
    }
    if (type === 'notebook') {
      const n = (await this.db.select({ w: this.s.notebooks.workspace_id }).from(this.s.notebooks).where(eq(this.s.notebooks.id, id)).limit(1))[0];
      if (!n || n.w !== workspaceId) throw notFound('Notebook');
      return;
    }
    throw badRequest('Only dashboards and notebooks can be embedded');
  }

  /** Checks a token and returns what it may see and who it queries as. Every embed request goes through this. */
  async verify(token: string | undefined, ip?: string): Promise<EmbedContext> {
    if (!token) throw unauthorized('This embed has no token');
    const parts = token.split('.');
    if (parts.length !== 3) throw unauthorized('The embed token is malformed');
    let head: { alg?: string; kid?: string };
    let claims: EmbedClaims;
    try {
      head = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8'));
      claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
    } catch {
      throw unauthorized('The embed token is malformed');
    }
    if (head.alg !== 'HS256' || !head.kid) throw unauthorized('The embed token must be HS256 with a kid');
    const key = (await this.db.select().from(this.s.embedKeys).where(and(eq(this.s.embedKeys.id, head.kid), isNull(this.s.embedKeys.revoked_at))).limit(1))[0];
    if (!key) throw unauthorized('The embed key is unknown or revoked');
    const expected = crypto.createHmac('sha256', this.secret(key)).update(`${parts[0]}.${parts[1]}`).digest();
    const given = Buffer.from(parts[2]!, 'base64url');
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) throw unauthorized('The embed token\'s signature does not match');
    const now = Math.floor(Date.now() / 1000);
    if (typeof claims.exp !== 'number' || claims.exp <= now) throw unauthorized('The embed token has expired');
    if (claims.exp - (typeof claims.iat === 'number' ? claims.iat : now) > MAX_LIFETIME_S) throw unauthorized('An embed token lives at most 7 days');
    if (typeof claims.iat === 'number' && claims.iat > now + 60) throw unauthorized('The embed token is not valid yet');
    const m = /^(dashboard|notebook):([\w-]{1,64})$/.exec(String(claims.res ?? ''));
    if (!m) throw unauthorized('The embed token names no dashboard or notebook (res)');
    await this.resource(key.workspace_id, m[1]!, m[2]!);
    const owner = await this.auth.findActive(key.created_by);
    if (!owner) throw unauthorized('The embed key\'s creator is no longer active');
    const base = this.auth.principalFromUser(owner, 'jwt', ip);
    const attrs = Object.fromEntries(Object.entries(claims.attrs ?? {}).filter(([k, v]) => /^[A-Za-z_]\w{0,62}$/.test(k) && ['string', 'number', 'boolean'].includes(typeof v)).map(([k, v]) => [k, typeof v === 'string' ? v.slice(0, 500) : v]));
    const principal: Principal = { ...base, scopes: ['read'], actorType: 'SYSTEM', workspaceScope: key.workspace_id, embed: { keyId: key.id, subject: String(claims.sub ?? 'anonymous').slice(0, 200), attrs } };
    // The creator must still be able to see the workspace.
    await this.workspaces.get(principal, key.workspace_id).catch(() => {
      throw unauthorized('The embed key\'s creator no longer has access to this workspace');
    });
    void this.db.update(this.s.embedKeys).set({ last_used_at: new Date() }).where(eq(this.s.embedKeys.id, key.id)).catch(() => undefined);
    return { key, claims, type: m[1] as 'dashboard' | 'notebook', id: m[2]!, principal };
  }

  /** The Content-Security-Policy frame-ancestors for an embed page (null: the token does not verify). */
  async frameAncestors(token: string | undefined): Promise<string | null> {
    try {
      const c = await this.verify(token);
      return c.key.allowed_origins.length ? c.key.allowed_origins.join(' ') : '*';
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------------------------------------ what embeds see

  /** What to draw: a dashboard's layout and widgets (without their SQL), or a notebook's cells (without outputs). */
  async view(ctx: EmbedContext) {
    this.audit.log({ userId: ctx.key.created_by, actorType: 'SYSTEM', action: 'embed.view', resource: `${ctx.type}:${ctx.id}`, queryText: `key ${ctx.key.id} · ${ctx.principal.embed!.subject}` });
    if (ctx.type === 'dashboard') {
      const d = await this.dashboards.get(ctx.principal, ctx.id);
      return { type: 'dashboard' as const, theme: ctx.claims.theme ?? null, dashboard: { id: d.id, name: d.name, description: d.description, layout: d.layout, widgets: d.widgets.map((w) => ({ id: w.id, title: w.title, widget_type: w.widget_type, chart_config: w.chart_config, refresh_interval_sec: w.refresh_interval_sec })) } };
    }
    const nb = await this.notebooks.get(ctx.principal, ctx.id);
    return { type: 'notebook' as const, theme: ctx.claims.theme ?? null, notebook: { id: nb.id, title: nb.title, cells: this.withParams(nb.cells, ctx.claims.params).map(({ output: _o, ...c }) => (c.type === 'sql' ? { ...c, source: '' } : c)) } };
  }

  /** A notebook's inputs set from the token's params (only inputs that exist). */
  private withParams(cells: NotebookCell[], params: EmbedClaims['params']): NotebookCell[] {
    if (!params) return cells;
    return cells.map((c) => (c.type === 'input' && c.name && params[c.name] !== undefined && c.input ? { ...c, input: { ...c.input, value: String(params[c.name]) } } : c));
  }

  async widgetData(ctx: EmbedContext, widgetId: string) {
    if (ctx.type !== 'dashboard') throw badRequest('This embed is not a dashboard');
    const { sql, workspace_id, widget } = await this.dashboards.widgetSql(ctx.principal, ctx.id, widgetId);
    const result = await this.queries.run(ctx.principal, workspace_id, sql, { maxRows: widget.widget_type === 'KPI' ? 10 : widget.widget_type === 'TABLE' ? 1000 : 2000, countTotal: widget.widget_type === 'TABLE' });
    const { analysis: _a, guardedSql: _g, ...rest } = result as typeof result & { guardedSql?: string };
    return { widget_id: widgetId, ...rest };
  }

  /** Runs one SQL cell of an embedded notebook live, as the embed (nothing is saved; the SQL is not returned). */
  async runCell(ctx: EmbedContext, cellId: string): Promise<{ output: NotebookOutput }> {
    if (ctx.type !== 'notebook') throw badRequest('This embed is not a notebook');
    const nb = await this.notebooks.get(ctx.principal, ctx.id);
    const cells = this.withParams(nb.cells, ctx.claims.params);
    const r = await this.notebooks.runCell(ctx.principal, ctx.id, cellId, { cells });
    return { output: { ...r.output, ran_by: null } };
  }
}
