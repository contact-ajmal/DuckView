/**
 * Notification channels: where alerts and scheduled snapshots are delivered — Slack (incoming webhook), Microsoft
 * Teams (Workflows / incoming webhook, Adaptive Card), email (SMTP), PagerDuty (Events API v2) and signed
 * webhooks. A channel belongs to a workspace (its editors manage it) or to the whole server (administrators).
 *
 * Secrets — webhook URLs, the PagerDuty routing key, a webhook's signing secret — are encrypted at rest and never
 * returned; the API shows a masked hint. Every URL is called through the egress guard (public addresses only,
 * unless notifications.allow_private_targets). Deliveries are retried on network errors, 429 and 5xx, and each
 * attempt series is logged per channel.
 */
import crypto from 'node:crypto';
import { and, desc, eq, isNull, lt, or, inArray } from 'drizzle-orm';
import nodemailer from 'nodemailer';
import type { MetadataStore } from '../db/index.js';
import type { NotificationChannel, NotificationDelivery, ChannelType } from '../db/schema/sqlite.js';
import { CHANNEL_TYPES } from '../db/schema/sqlite.js';
import type { DuckViewConfig } from '../config/index.js';
import { CredentialCipher, newId } from '../security/crypto.js';
import { egressPost, EgressError } from '../security/egress.js';
import type { Principal } from './principal.js';
import { isPlatformAdmin, requireWrite } from './principal.js';
import type { WorkspaceService } from './workspaces.js';
import type { AuditService } from './audit.js';
import { badRequest, forbidden, notFound } from './errors.js';
import { logger } from '../observability/logger.js';

export type Severity = 'info' | 'warning' | 'critical' | 'resolved';

/** What any producer (alerts, snapshots, a test) hands to a channel. */
export interface Notification {
  title: string;
  /** Plain text (line breaks kept); each renderer escapes it for its format. */
  text: string;
  severity: Severity;
  /** A link back into DuckView. */
  url?: string | null;
  fields?: { label: string; value: string }[];
  /** A picture (a snapshot): attached to emails and webhooks; Slack / Teams / PagerDuty show it from `url`. */
  image?: { data: Buffer; filename: string; contentType: string; url?: string | null } | null;
  attachments?: { filename: string; content: Buffer; contentType: string }[];
  /** Groups trigger / resolve of the same condition (PagerDuty incidents, webhook consumers). */
  dedupKey?: string | null;
  /** The event name webhooks receive, e.g. alert.triggered. */
  event?: string;
  workspace?: { id: string; name: string } | null;
}

export type PublicChannel = Omit<NotificationChannel, 'encrypted_secret' | 'iv' | 'tag'> & { scope: 'workspace' | 'org'; secret_set: boolean; hint: string | null };

interface ChannelSecret {
  url?: string;
  routing_key?: string;
  signing_secret?: string;
}
export interface ChannelInput {
  name?: string;
  type?: ChannelType;
  enabled?: boolean;
  /** email: { to: string[] } */
  config?: Record<string, unknown>;
  /** Write-only: { url } (Slack, Teams, webhook), { routing_key } (PagerDuty), { signing_secret } (webhook, optional). */
  secret?: ChannelSecret;
}

export interface SmtpSettings {
  host: string;
  port: number;
  secure: boolean;
  user: string | null;
  password: string | null;
  from: string;
}

const SMTP_KEY = 'smtp';
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const SLACK_HOSTS = ['hooks.slack.com', 'hooks.slack-gov.com'];
const TEAMS_HOSTS = /(^|\.)(webhook\.office\.com|logic\.azure\.com|environment\.api\.powerplatform\.com|powerautomate\.com)$/i;

export class NotificationService {
  constructor(private readonly store: MetadataStore, private readonly cfg: DuckViewConfig, private readonly cipher: CredentialCipher, private readonly workspaces: WorkspaceService, private readonly audit: AuditService) {}
  private get db() {
    return this.store.db;
  }
  private get s() {
    return this.store.schema;
  }
  private get n() {
    return this.cfg.notifications;
  }

  // ------------------------------------------------------------------------------------------ channels

  toPublic(c: NotificationChannel): PublicChannel {
    const { encrypted_secret, iv: _iv, tag: _tag, ...rest } = c;
    return { ...rest, scope: c.workspace_id ? 'workspace' : 'org', secret_set: !!encrypted_secret, hint: (c.config as { hint?: string }).hint ?? null };
  }

  private secretOf(c: NotificationChannel): ChannelSecret {
    if (!c.encrypted_secret || !c.iv || !c.tag) return {};
    return this.cipher.decryptJson<ChannelSecret>({ ciphertext: c.encrypted_secret, iv: c.iv, tag: c.tag }, `channel:${c.id}`);
  }

  /** Validates type-specific settings; returns the stored config and the secret to encrypt. */
  private normalise(type: ChannelType, config: Record<string, unknown>, secret: ChannelSecret, existing: ChannelSecret | null): { config: Record<string, unknown>; secret: ChannelSecret | null; generated: string | null } {
    const out: Record<string, unknown> = {};
    const merged: ChannelSecret = { ...(existing ?? {}), ...Object.fromEntries(Object.entries(secret).filter(([, v]) => typeof v === 'string' && v.trim())) };
    let generated: string | null = null;
    const checkUrl = (url: string | undefined, hosts: (host: string) => boolean, what: string) => {
      if (!url) throw badRequest(`${what}: the webhook URL is required`);
      let u: URL;
      try {
        u = new URL(url.trim());
      } catch {
        throw badRequest(`${what}: not a URL`);
      }
      if (u.protocol !== 'https:' && !this.n.allow_private_targets) throw badRequest(`${what}: the URL must be https://`);
      if (!this.n.allow_private_targets && !hosts(u.hostname)) throw badRequest(`${what}: ${u.hostname} is not a ${what} webhook host`);
      merged.url = u.toString();
      out.hint = `${u.host}/…${u.pathname.slice(-4)}`;
    };
    switch (type) {
      case 'slack':
        checkUrl(merged.url, (h) => SLACK_HOSTS.includes(h), 'Slack');
        break;
      case 'teams':
        checkUrl(merged.url, (h) => TEAMS_HOSTS.test(h), 'Teams');
        break;
      case 'webhook':
        checkUrl(merged.url, () => true, 'Webhook');
        if (!merged.signing_secret) merged.signing_secret = generated = `whsec_${crypto.randomBytes(24).toString('base64url')}`;
        break;
      case 'pagerduty':
        if (!merged.routing_key || !/^[A-Za-z0-9]{20,64}$/.test(merged.routing_key.trim())) throw badRequest('PagerDuty: an integration (routing) key of the Events API v2 is required');
        merged.routing_key = merged.routing_key.trim();
        out.hint = `…${merged.routing_key.slice(-4)}`;
        break;
      case 'email': {
        const to = (Array.isArray(config.to) ? config.to : String(config.to ?? '').split(/[,;\s]+/)).map((x) => String(x).trim()).filter(Boolean);
        if (!to.length) throw badRequest('Email: at least one recipient is required');
        if (to.length > 50) throw badRequest('Email: at most 50 recipients');
        const bad = to.find((x) => !EMAIL.test(x));
        if (bad) throw badRequest(`Email: "${bad}" is not an address`);
        const unique = [...new Set(to)];
        out.to = unique;
        out.hint = unique.length === 1 ? unique[0] : `${unique[0]} +${unique.length - 1}`;
        return { config: out, secret: null, generated: null };
      }
    }
    return { config: out, secret: merged, generated };
  }

  async list(p: Principal, workspaceId: string): Promise<PublicChannel[]> {
    await this.workspaces.get(p, workspaceId);
    const rows = await this.db.select().from(this.s.notificationChannels).where(or(eq(this.s.notificationChannels.workspace_id, workspaceId), isNull(this.s.notificationChannels.workspace_id)));
    return rows.sort((a, b) => Number(!a.workspace_id) - Number(!b.workspace_id) || a.name.localeCompare(b.name)).map((c) => this.toPublic(c));
  }

  async listOrg(p: Principal): Promise<PublicChannel[]> {
    if (p.actorType !== 'USER' && !isPlatformAdmin(p)) throw forbidden('Org-wide channels are listed for people signed in');
    const rows = await this.db.select().from(this.s.notificationChannels).where(isNull(this.s.notificationChannels.workspace_id));
    return rows.sort((a, b) => a.name.localeCompare(b.name)).map((c) => this.toPublic(c));
  }

  /** A channel the principal may see (edit: workspace editors, or administrators for org-wide channels). */
  async get(p: Principal, id: string, edit = false): Promise<NotificationChannel> {
    const c = (await this.db.select().from(this.s.notificationChannels).where(eq(this.s.notificationChannels.id, id)).limit(1))[0];
    if (!c) throw notFound('Channel');
    if (c.workspace_id) await this.workspaces.get(p, c.workspace_id, edit ? 'EDITOR' : 'VIEWER');
    else if (edit && !isPlatformAdmin(p)) throw forbidden('Only administrators manage org-wide channels');
    return c;
  }

  async create(p: Principal, workspaceId: string | null, input: ChannelInput): Promise<{ channel: PublicChannel; signing_secret: string | null }> {
    requireWrite(p);
    if (workspaceId) await this.workspaces.get(p, workspaceId, 'EDITOR');
    else if (!isPlatformAdmin(p)) throw forbidden('Only administrators create org-wide channels');
    const name = (input.name ?? '').trim().slice(0, 120);
    if (!name) throw badRequest('name is required');
    if (!input.type || !CHANNEL_TYPES.includes(input.type)) throw badRequest(`type must be one of ${CHANNEL_TYPES.join(', ')}`);
    const id = newId();
    const norm = this.normalise(input.type, input.config ?? {}, input.secret ?? {}, null);
    const enc = norm.secret ? this.cipher.encryptJson(norm.secret, `channel:${id}`) : null;
    const now = new Date();
    const row: NotificationChannel = { id, workspace_id: workspaceId, name, type: input.type, config: norm.config, encrypted_secret: enc?.ciphertext ?? null, iv: enc?.iv ?? null, tag: enc?.tag ?? null, enabled: input.enabled ?? true, created_by: p.userId, last_status: null, last_error: null, last_sent_at: null, created_at: now, updated_at: now };
    await this.db.insert(this.s.notificationChannels).values(row);
    this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'channel.create', resource: `channel:${id}`, ip: p.ip });
    return { channel: this.toPublic(row), signing_secret: norm.generated };
  }

  async update(p: Principal, id: string, patch: ChannelInput): Promise<PublicChannel> {
    requireWrite(p);
    const c = await this.get(p, id, true);
    if (patch.type && patch.type !== c.type) throw badRequest('The type of a channel cannot change — create another one');
    const set: Partial<NotificationChannel> = { updated_at: new Date() };
    if (patch.name !== undefined) set.name = patch.name.trim().slice(0, 120) || c.name;
    if (patch.enabled !== undefined) set.enabled = patch.enabled;
    if (patch.config !== undefined || patch.secret !== undefined) {
      const norm = this.normalise(c.type, patch.config ?? (c.config as Record<string, unknown>), patch.secret ?? {}, this.secretOf(c));
      set.config = norm.config;
      if (norm.secret) {
        const enc = this.cipher.encryptJson(norm.secret, `channel:${id}`);
        Object.assign(set, { encrypted_secret: enc.ciphertext, iv: enc.iv, tag: enc.tag });
      }
    }
    await this.db.update(this.s.notificationChannels).set(set).where(eq(this.s.notificationChannels.id, id));
    this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'channel.update', resource: `channel:${id}`, ip: p.ip });
    return this.toPublic({ ...c, ...set });
  }

  async remove(p: Principal, id: string): Promise<void> {
    requireWrite(p);
    await this.get(p, id, true);
    await this.db.delete(this.s.notificationChannels).where(eq(this.s.notificationChannels.id, id));
    this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'channel.delete', resource: `channel:${id}`, ip: p.ip });
  }

  async deliveries(p: Principal, id: string, limit = 20): Promise<NotificationDelivery[]> {
    await this.get(p, id);
    return this.db.select().from(this.s.notificationDeliveries).where(eq(this.s.notificationDeliveries.channel_id, id)).orderBy(desc(this.s.notificationDeliveries.created_at)).limit(Math.min(limit, 100));
  }

  /** Sends a test message (editors of the channel). */
  async test(p: Principal, id: string): Promise<NotificationDelivery> {
    const c = await this.get(p, id, true);
    const ws = c.workspace_id ? await this.workspaces.get(p, c.workspace_id).catch(() => null) : null;
    return this.deliver(c, { title: `Test from DuckView: ${c.name}`, text: `This ${c.type} channel is set up — alerts and scheduled snapshots${ws ? ` of ${ws.name}` : ''} will arrive here.\nSent by ${p.email}.`, severity: 'info', event: 'channel.test', url: this.link('/#/alerts'), fields: [{ label: 'Channel', value: c.name }, { label: 'Scope', value: ws ? `workspace ${ws.name}` : 'org-wide' }], workspace: ws ? { id: ws.id, name: ws.name } : null }, 'test');
  }

  /**
   * Delivers to channels by id — the producer's workspace's channels or org-wide ones; anything else is skipped.
   * Never throws: failures are recorded on the channel and returned.
   */
  async send(channelIds: string[], msg: Notification, source: string, workspaceId: string | null): Promise<NotificationDelivery[]> {
    if (!channelIds.length) return [];
    const rows = await this.db.select().from(this.s.notificationChannels).where(inArray(this.s.notificationChannels.id, channelIds));
    const usable = rows.filter((c) => c.enabled && (!c.workspace_id || c.workspace_id === workspaceId));
    return Promise.all(usable.map((c) => this.deliver(c, msg, source)));
  }

  /** A DuckView URL for links in messages (server.public_url when set). */
  link(path: string): string | null {
    const base = this.cfg.server.public_url?.replace(/\/+$/, '');
    return base ? `${base}${path}` : null;
  }

  // ------------------------------------------------------------------------------------------ delivery

  async deliver(c: NotificationChannel, msg: Notification, source: string): Promise<NotificationDelivery> {
    const t0 = Date.now();
    let attempts = 0;
    let error: string | null = null;
    if (!this.n.enabled) error = 'Notifications are disabled on this server (notifications.enabled)';
    else {
      for (;;) {
        attempts++;
        try {
          await this.transmit(c, msg);
          error = null;
          break;
        } catch (err) {
          error = (err as Error).message.slice(0, 500);
          const retryable = !(err instanceof EgressError) && !(err instanceof PermanentError) && attempts < 3;
          if (!retryable) break;
          await new Promise((r) => setTimeout(r, attempts === 1 ? 300 : 1200));
        }
      }
    }
    const now = new Date();
    const row: NotificationDelivery = { id: newId(), channel_id: c.id, source, title: msg.title.slice(0, 300), status: error ? 'error' : 'ok', error, attempts, duration_ms: Date.now() - t0, created_at: now };
    await this.db.insert(this.s.notificationDeliveries).values(row);
    await this.db.update(this.s.notificationChannels).set({ last_status: row.status, last_error: error, last_sent_at: now }).where(eq(this.s.notificationChannels.id, c.id));
    // Keep a month of history.
    await this.db.delete(this.s.notificationDeliveries).where(and(eq(this.s.notificationDeliveries.channel_id, c.id), lt(this.s.notificationDeliveries.created_at, new Date(Date.now() - 30 * 86_400_000)))).catch(() => undefined);
    if (error) logger().warn({ channel: c.id, type: c.type, source, err: error }, 'Notification not delivered');
    return row;
  }

  private post(url: string, body: string, headers: Record<string, string> = {}) {
    return egressPost(url, body, { 'content-type': 'application/json', 'user-agent': 'DuckView-Notifications/1', ...headers }, { allowPrivate: this.n.allow_private_targets, timeoutMs: this.n.timeout_seconds * 1000 });
  }

  private async expect(res: { status: number; body: string }, ok: (status: number) => boolean, what: string): Promise<void> {
    if (ok(res.status)) return;
    const message = `${what} answered ${res.status}${res.body ? `: ${res.body.slice(0, 200)}` : ''}`;
    if (res.status === 429 || res.status >= 500) throw new Error(message);
    throw new PermanentError(message);
  }

  private async transmit(c: NotificationChannel, msg: Notification): Promise<void> {
    const secret = this.secretOf(c);
    switch (c.type) {
      case 'slack':
        return this.expect(await this.post(secret.url!, JSON.stringify(slackMessage(msg))), (s) => s >= 200 && s < 300, 'Slack');
      case 'teams':
        return this.expect(await this.post(secret.url!, JSON.stringify(teamsMessage(msg))), (s) => s >= 200 && s < 300, 'Teams');
      case 'pagerduty':
        return this.expect(await this.post(this.n.pagerduty_url, JSON.stringify(pagerDutyEvent(msg, secret.routing_key!))), (s) => s === 202 || s === 200, 'PagerDuty');
      case 'webhook': {
        const delivery = newId();
        const body = JSON.stringify(webhookPayload(msg, delivery));
        const ts = String(Math.floor(Date.now() / 1000));
        const signature = crypto.createHmac('sha256', secret.signing_secret ?? '').update(`${ts}.${body}`).digest('hex');
        return this.expect(await this.post(secret.url!, body, { 'x-duckview-event': msg.event ?? 'notification', 'x-duckview-delivery': delivery, 'x-duckview-timestamp': ts, 'x-duckview-signature': `sha256=${signature}` }), (s) => s >= 200 && s < 300, 'The webhook');
      }
      case 'email':
        return this.sendEmail((c.config as { to?: string[] }).to ?? [], msg);
    }
  }

  // ------------------------------------------------------------------------------------------ email

  async smtp(): Promise<SmtpSettings | null> {
    const r = (await this.db.select().from(this.s.appSettings).where(eq(this.s.appSettings.key, SMTP_KEY)).limit(1))[0];
    if (r) {
      const v = r.value as { host?: string; port?: number; secure?: boolean; user?: string | null; from?: string };
      let password: string | null = null;
      if (r.encrypted_value && r.iv && r.tag) password = this.cipher.decrypt({ ciphertext: r.encrypted_value, iv: r.iv, tag: r.tag }, SMTP_KEY);
      if (v.host && v.from) return { host: v.host, port: v.port ?? 587, secure: !!v.secure, user: v.user ?? null, password, from: v.from };
    }
    const c = this.n.smtp;
    if (c.host && c.from) return { host: c.host, port: c.port, secure: c.secure, user: c.user ?? null, password: c.password ?? null, from: c.from };
    return null;
  }

  async describeSmtp(p: Principal): Promise<{ configured: boolean; source: 'console' | 'config' | null; host: string | null; port: number | null; secure: boolean; user: string | null; from: string | null; password_set: boolean }> {
    if (!isPlatformAdmin(p)) throw forbidden('Administrator role required');
    const r = (await this.db.select().from(this.s.appSettings).where(eq(this.s.appSettings.key, SMTP_KEY)).limit(1))[0];
    const s = await this.smtp();
    return { configured: !!s, source: r ? 'console' : s ? 'config' : null, host: s?.host ?? null, port: s?.port ?? null, secure: s?.secure ?? false, user: s?.user ?? null, from: s?.from ?? null, password_set: !!s?.password };
  }

  async setSmtp(p: Principal, input: { host: string; port?: number; secure?: boolean; user?: string | null; password?: string | null; from: string }): Promise<void> {
    if (!isPlatformAdmin(p)) throw forbidden('Administrator role required');
    const host = input.host.trim();
    const from = input.from.trim();
    if (!host) throw badRequest('host is required');
    if (!EMAIL.test(from.replace(/^.*<(.+)>\s*$/, '$1'))) throw badRequest('from must be an address (or "Name <address>")');
    const existing = (await this.db.select().from(this.s.appSettings).where(eq(this.s.appSettings.key, SMTP_KEY)).limit(1))[0];
    let enc: { ciphertext: string; iv: string; tag: string } | null = null;
    if (input.password?.trim()) enc = this.cipher.encrypt(input.password, SMTP_KEY);
    else if (input.password === undefined && existing?.encrypted_value && existing.iv && existing.tag) enc = { ciphertext: existing.encrypted_value, iv: existing.iv, tag: existing.tag };
    const row = { key: SMTP_KEY, value: { host, port: input.port ?? 587, secure: !!input.secure, user: input.user?.trim() || null, from }, encrypted_value: enc?.ciphertext ?? null, iv: enc?.iv ?? null, tag: enc?.tag ?? null, updated_by: p.userId, updated_at: new Date() };
    if (existing) await this.db.update(this.s.appSettings).set(row).where(eq(this.s.appSettings.key, SMTP_KEY));
    else await this.db.insert(this.s.appSettings).values(row);
    this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'admin.smtp_update', resource: 'settings:smtp', ip: p.ip });
  }

  async clearSmtp(p: Principal): Promise<void> {
    if (!isPlatformAdmin(p)) throw forbidden('Administrator role required');
    await this.db.delete(this.s.appSettings).where(eq(this.s.appSettings.key, SMTP_KEY));
  }

  async testSmtp(p: Principal, to: string): Promise<void> {
    if (!isPlatformAdmin(p)) throw forbidden('Administrator role required');
    if (!EMAIL.test(to)) throw badRequest('to must be an address');
    try {
      await this.sendEmail([to], { title: 'DuckView email works', text: `Outgoing mail is set up. Alerts and snapshots sent to email channels will come from this address.\nTested by ${p.email}.`, severity: 'info', url: this.link('/#/alerts') });
    } catch (err) {
      throw badRequest(`The mail server refused: ${(err as Error).message}`);
    }
  }

  private async sendEmail(to: string[], msg: Notification): Promise<void> {
    const s = await this.smtp();
    if (!s) throw new PermanentError('No mail server: an administrator sets SMTP under Settings → Integrations (or notifications.smtp)');
    const transport = nodemailer.createTransport({ host: s.host, port: s.port, secure: s.secure, auth: s.user ? { user: s.user, pass: s.password ?? '' } : undefined, connectionTimeout: this.n.timeout_seconds * 1000, greetingTimeout: this.n.timeout_seconds * 1000, socketTimeout: this.n.timeout_seconds * 3000, tls: { rejectUnauthorized: !this.n.allow_private_targets } });
    const cid = msg.image ? `snapshot-${crypto.randomBytes(6).toString('hex')}@duckview` : null;
    try {
      await transport.sendMail({
        from: s.from,
        to,
        subject: `${msg.severity === 'resolved' ? '[resolved] ' : msg.severity === 'critical' ? '[critical] ' : ''}${msg.title}`,
        text: `${msg.text}\n\n${(msg.fields ?? []).map((f) => `${f.label}: ${f.value}`).join('\n')}${msg.url ? `\n\nOpen in DuckView: ${msg.url}` : ''}`,
        html: emailHtml(msg, cid),
        attachments: [...(msg.image && cid ? [{ filename: msg.image.filename, content: msg.image.data, contentType: msg.image.contentType, cid }] : []), ...(msg.attachments ?? []).map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType }))],
        headers: msg.dedupKey ? { 'X-DuckView-Dedup-Key': msg.dedupKey } : undefined,
      });
    } finally {
      transport.close();
    }
  }
}

/** Not worth retrying (bad credentials, 4xx, no mail server). */
class PermanentError extends Error {}

// ------------------------------------------------------------------------------------------ renderers

const SEVERITY_EMOJI: Record<Severity, string> = { info: 'ℹ️', warning: '⚠️', critical: '🚨', resolved: '✅' };
const slackEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function slackMessage(msg: Notification): Record<string, unknown> {
  const blocks: Record<string, unknown>[] = [
    { type: 'header', text: { type: 'plain_text', text: `${SEVERITY_EMOJI[msg.severity]} ${msg.title}`.slice(0, 150), emoji: true } },
    { type: 'section', text: { type: 'mrkdwn', text: slackEscape(msg.text).slice(0, 2900) || ' ' } },
  ];
  if (msg.fields?.length) blocks.push({ type: 'section', fields: msg.fields.slice(0, 10).map((f) => ({ type: 'mrkdwn', text: `*${slackEscape(f.label)}*\n${slackEscape(f.value)}`.slice(0, 2000) })) });
  if (msg.image?.url) blocks.push({ type: 'image', image_url: msg.image.url, alt_text: msg.title.slice(0, 200) });
  if (msg.url) blocks.push({ type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Open in DuckView' }, url: msg.url }] });
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `DuckView${msg.workspace ? ` · ${slackEscape(msg.workspace.name)}` : ''} · ${msg.severity}` }] });
  return { text: `${SEVERITY_EMOJI[msg.severity]} ${msg.title}`, blocks };
}

export function teamsMessage(msg: Notification): Record<string, unknown> {
  const color = msg.severity === 'critical' ? 'Attention' : msg.severity === 'warning' ? 'Warning' : msg.severity === 'resolved' ? 'Good' : 'Accent';
  const body: Record<string, unknown>[] = [
    { type: 'TextBlock', text: msg.title, weight: 'Bolder', size: 'Medium', wrap: true, color },
    { type: 'TextBlock', text: msg.text, wrap: true },
  ];
  if (msg.fields?.length) body.push({ type: 'FactSet', facts: msg.fields.slice(0, 20).map((f) => ({ title: f.label, value: f.value })) });
  if (msg.image?.url) body.push({ type: 'Image', url: msg.image.url, altText: msg.title });
  body.push({ type: 'TextBlock', text: `DuckView${msg.workspace ? ` · ${msg.workspace.name}` : ''} · ${msg.severity}`, isSubtle: true, size: 'Small', wrap: true });
  return {
    type: 'message',
    attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', contentUrl: null, content: { $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', type: 'AdaptiveCard', version: '1.4', body, actions: msg.url ? [{ type: 'Action.OpenUrl', title: 'Open in DuckView', url: msg.url }] : [] } }],
  };
}

export function pagerDutyEvent(msg: Notification, routingKey: string): Record<string, unknown> {
  const resolve = msg.severity === 'resolved';
  return {
    routing_key: routingKey,
    event_action: resolve ? 'resolve' : 'trigger',
    ...(msg.dedupKey ? { dedup_key: msg.dedupKey.slice(0, 255) } : {}),
    ...(resolve
      ? {}
      : {
          payload: { summary: msg.title.slice(0, 1024), source: msg.workspace ? `duckview:${msg.workspace.name}` : 'duckview', severity: msg.severity === 'critical' ? 'critical' : msg.severity === 'warning' ? 'warning' : 'info', component: msg.workspace?.name, class: msg.event, custom_details: { text: msg.text, ...Object.fromEntries((msg.fields ?? []).map((f) => [f.label, f.value])) } },
          links: msg.url ? [{ href: msg.url, text: 'Open in DuckView' }] : [],
          images: msg.image?.url ? [{ src: msg.image.url, alt: msg.title }] : [],
        }),
    client: 'DuckView',
  };
}

export function webhookPayload(msg: Notification, delivery: string): Record<string, unknown> {
  return {
    event: msg.event ?? 'notification',
    delivery,
    sent_at: new Date().toISOString(),
    title: msg.title,
    text: msg.text,
    severity: msg.severity,
    url: msg.url ?? null,
    fields: msg.fields ?? [],
    dedup_key: msg.dedupKey ?? null,
    workspace: msg.workspace ?? null,
    image: msg.image ? { filename: msg.image.filename, content_type: msg.image.contentType, url: msg.image.url ?? null, base64: msg.image.data.toString('base64') } : null,
    attachments: (msg.attachments ?? []).map((a) => ({ filename: a.filename, content_type: a.contentType, base64: a.content.toString('base64') })),
  };
}

const htmlEscape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);

export function emailHtml(msg: Notification, cid: string | null): string {
  const color = msg.severity === 'critical' ? '#dc2626' : msg.severity === 'warning' ? '#d97706' : msg.severity === 'resolved' ? '#16a34a' : '#7c3aed';
  const fields = (msg.fields ?? []).map((f) => `<tr><td style="padding:4px 12px 4px 0;color:#71717a;white-space:nowrap">${htmlEscape(f.label)}</td><td style="padding:4px 0;color:#18181b">${htmlEscape(f.value)}</td></tr>`).join('');
  return `<!doctype html><html><body style="margin:0;background:#f4f4f5;font-family:-apple-system,Segoe UI,Roboto,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px">
<table role="presentation" width="640" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:10px;border-top:4px solid ${color}">
<tr><td style="padding:20px 24px 8px;font-size:18px;font-weight:600;color:#18181b">${htmlEscape(msg.title)}</td></tr>
<tr><td style="padding:0 24px 12px;font-size:14px;line-height:1.5;color:#3f3f46;white-space:pre-line">${htmlEscape(msg.text)}</td></tr>
${fields ? `<tr><td style="padding:0 24px 12px"><table style="font-size:13px">${fields}</table></td></tr>` : ''}
${cid ? `<tr><td style="padding:0 24px 16px"><img src="cid:${cid}" alt="${htmlEscape(msg.title)}" style="max-width:100%;border:1px solid #e4e4e7;border-radius:6px"></td></tr>` : ''}
${msg.url ? `<tr><td style="padding:0 24px 20px"><a href="${htmlEscape(msg.url)}" style="display:inline-block;background:${color};color:#fff;text-decoration:none;padding:8px 14px;border-radius:6px;font-size:13px">Open in DuckView</a></td></tr>` : ''}
<tr><td style="padding:12px 24px;border-top:1px solid #f4f4f5;font-size:11px;color:#a1a1aa">DuckView${msg.workspace ? ` · ${htmlEscape(msg.workspace.name)}` : ''} · ${msg.severity}</td></tr>
</table></td></tr></table></body></html>`;
}
