/**
 * Scheduled snapshots: a dashboard or a data app rendered by a headless browser on a schedule, as PNG or PDF, kept
 * under <data>/.duckview/snapshots and delivered to notification channels.
 *
 * A dashboard is rendered by DuckView's own UI (#/snapshot/dashboard/<id>, nothing around it) signed in as the
 * snapshot's owner with a five-minute session that never leaves the server; an app is rendered through its own
 * origin with the app cookie, as the data-app preview does. Chat channels cannot receive files through incoming
 * webhooks, so Slack / Teams / PagerDuty get a signed, expiring link to the image (server.public_url must be
 * reachable); email gets the PNG inline and the PDF attached; webhooks get the bytes.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { and, desc, eq, isNotNull, lt, lte } from 'drizzle-orm';
import type { MetadataStore } from '../db/index.js';
import type { Snapshot, SnapshotFormat, SnapshotRun, SnapshotTarget, SyncSchedule, User } from '../db/schema/sqlite.js';
import { SNAPSHOT_FORMATS } from '../db/schema/sqlite.js';
import type { DuckViewConfig } from '../config/index.js';
import { newId } from '../security/crypto.js';
import type { Principal } from './principal.js';
import { requireWrite } from './principal.js';
import type { WorkspaceService } from './workspaces.js';
import type { DashboardService } from './bi.js';
import type { DataAppService } from './apps.js';
import type { AuthService } from './auth.js';
import type { AuditService } from './audit.js';
import type { NotificationService, Notification } from './notifications.js';
import { findChrome, withHeadless } from './headless.js';
import { nextRunAt } from './syncs.js';
import { badRequest, notFound } from './errors.js';
import { logger } from '../observability/logger.js';

export interface SnapshotInput {
  name?: string;
  target?: SnapshotTarget;
  format?: SnapshotFormat;
  width?: number;
  schedule?: SyncSchedule;
  channel_ids?: string[];
  enabled?: boolean;
}

export interface Rendering {
  png: Buffer;
  pdf: Buffer | null;
  title: string;
}

export class SnapshotService {
  private ticker: NodeJS.Timeout | null = null;
  /** One browser at a time: renders queue up. */
  private queue: Promise<unknown> = Promise.resolve();
  private lastCleanup = 0;
  /** Signs a short sign-in session for the owner (set by the routes); the UI renders dashboards with it. */
  signUserSession: ((user: User) => string) | null = null;

  constructor(private readonly store: MetadataStore, private readonly cfg: DuckViewConfig, private readonly workspaces: WorkspaceService, private readonly dashboards: DashboardService, private readonly apps: DataAppService, private readonly auth: AuthService, private readonly notifications: NotificationService, private readonly audit: AuditService) {}
  private get db() {
    return this.store.db;
  }
  private get s() {
    return this.store.schema;
  }
  private get dir(): string {
    return path.join(this.cfg.security.data_jail_directory, '.duckview', 'snapshots');
  }

  // ------------------------------------------------------------------------------------------ registry

  private async checkTarget(p: Principal, workspaceId: string, t: SnapshotTarget | undefined): Promise<{ target: SnapshotTarget; title: string }> {
    if (t?.kind === 'dashboard' && t.dashboard_id) {
      const d = await this.dashboards.get(p, t.dashboard_id);
      if (d.workspace_id !== workspaceId) throw badRequest('The dashboard belongs to another workspace');
      return { target: { kind: 'dashboard', dashboard_id: d.id }, title: d.name };
    }
    if (t?.kind === 'app' && t.app_id) {
      const a = await this.apps.get(p, t.app_id);
      if (a.workspace_id !== workspaceId) throw badRequest('The app belongs to another workspace');
      return { target: { kind: 'app', app_id: a.id }, title: a.name };
    }
    throw badRequest('target must be {kind: "dashboard", dashboard_id} or {kind: "app", app_id}');
  }

  private checkSchedule(s: SyncSchedule | undefined): SyncSchedule {
    const sch = s ?? { kind: 'cron', expression: '0 8 * * 1-5' };
    if (sch.kind === 'interval' && (!Number.isFinite(sch.minutes) || sch.minutes < 15)) throw badRequest('A snapshot runs at most every 15 minutes');
    nextRunAt(sch);
    return sch;
  }

  private async checkChannels(p: Principal, workspaceId: string, ids: string[] | undefined): Promise<string[]> {
    const wanted = [...new Set(ids ?? [])];
    if (!wanted.length) return [];
    const usable = new Set((await this.notifications.list(p, workspaceId)).map((c) => c.id));
    const bad = wanted.find((id) => !usable.has(id));
    if (bad) throw badRequest(`Channel ${bad} is not a channel of this workspace (or org-wide)`);
    return wanted;
  }

  async list(p: Principal, workspaceId: string): Promise<Snapshot[]> {
    await this.workspaces.get(p, workspaceId);
    const rows = await this.db.select().from(this.s.snapshots).where(eq(this.s.snapshots.workspace_id, workspaceId));
    return rows.sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(p: Principal, id: string, minRole: 'VIEWER' | 'EDITOR' = 'VIEWER'): Promise<Snapshot> {
    const s = (await this.db.select().from(this.s.snapshots).where(eq(this.s.snapshots.id, id)).limit(1))[0];
    if (!s) throw notFound('Snapshot');
    await this.workspaces.get(p, s.workspace_id, minRole);
    return s;
  }

  async create(p: Principal, workspaceId: string, input: SnapshotInput): Promise<Snapshot> {
    requireWrite(p);
    await this.workspaces.get(p, workspaceId, 'EDITOR');
    const { target, title } = await this.checkTarget(p, workspaceId, input.target);
    const format = input.format ?? 'png';
    if (!SNAPSHOT_FORMATS.includes(format)) throw badRequest('format must be png or pdf');
    const schedule = this.checkSchedule(input.schedule);
    const now = new Date();
    const enabled = input.enabled ?? true;
    const row: Snapshot = { id: newId(), workspace_id: workspaceId, user_id: p.userId, name: (input.name ?? '').trim().slice(0, 120) || title, target, format, width: Math.min(Math.max(input.width ?? 1280, 640), 2400), schedule, channel_ids: await this.checkChannels(p, workspaceId, input.channel_ids), enabled, last_status: null, last_error: null, last_run_at: null, next_run_at: enabled ? nextRunAt(schedule, now) : null, created_at: now, updated_at: now };
    await this.db.insert(this.s.snapshots).values(row);
    this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'snapshot.create', resource: `snapshot:${row.id}`, ip: p.ip });
    return row;
  }

  async update(p: Principal, id: string, patch: SnapshotInput): Promise<Snapshot> {
    requireWrite(p);
    const cur = await this.get(p, id, 'EDITOR');
    const set: Partial<Snapshot> = { updated_at: new Date() };
    if (patch.name !== undefined) set.name = patch.name.trim().slice(0, 120) || cur.name;
    if (patch.target !== undefined) {
      set.target = (await this.checkTarget(p, cur.workspace_id, patch.target)).target;
      set.user_id = p.userId;
    }
    if (patch.format !== undefined) {
      if (!SNAPSHOT_FORMATS.includes(patch.format)) throw badRequest('format must be png or pdf');
      set.format = patch.format;
    }
    if (patch.width !== undefined) set.width = Math.min(Math.max(patch.width, 640), 2400);
    if (patch.schedule !== undefined) set.schedule = this.checkSchedule(patch.schedule);
    if (patch.channel_ids !== undefined) set.channel_ids = await this.checkChannels(p, cur.workspace_id, patch.channel_ids);
    if (patch.enabled !== undefined) set.enabled = patch.enabled;
    const next = { ...cur, ...set };
    if (patch.schedule !== undefined || patch.enabled !== undefined) set.next_run_at = next.enabled ? nextRunAt(next.schedule) : null;
    await this.db.update(this.s.snapshots).set(set).where(eq(this.s.snapshots.id, id));
    this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'snapshot.update', resource: `snapshot:${id}`, ip: p.ip });
    return { ...cur, ...set };
  }

  async remove(p: Principal, id: string): Promise<void> {
    requireWrite(p);
    await this.get(p, id, 'EDITOR');
    await this.db.delete(this.s.snapshots).where(eq(this.s.snapshots.id, id));
    fs.rmSync(path.join(this.dir, id), { recursive: true, force: true });
    this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'snapshot.delete', resource: `snapshot:${id}`, ip: p.ip });
  }

  async runs(p: Principal, id: string, limit = 30): Promise<SnapshotRun[]> {
    await this.get(p, id);
    return this.db.select().from(this.s.snapshotRuns).where(eq(this.s.snapshotRuns.snapshot_id, id)).orderBy(desc(this.s.snapshotRuns.created_at)).limit(Math.min(limit, 200));
  }

  /** A run's file, for someone who may see the snapshot. */
  async file(p: Principal, id: string, runId: string): Promise<{ path: string; contentType: string; filename: string }> {
    const snap = await this.get(p, id);
    const run = (await this.db.select().from(this.s.snapshotRuns).where(and(eq(this.s.snapshotRuns.id, runId), eq(this.s.snapshotRuns.snapshot_id, id))).limit(1))[0];
    if (!run?.file) throw notFound('Snapshot file');
    return this.fileInfo(snap, run);
  }

  private fileInfo(snap: Snapshot, run: SnapshotRun): { path: string; contentType: string; filename: string } {
    const full = path.join(this.dir, run.file!);
    if (!full.startsWith(this.dir + path.sep) || !fs.existsSync(full)) throw notFound('Snapshot file');
    const ext = path.extname(full).slice(1);
    return { path: full, contentType: ext === 'pdf' ? 'application/pdf' : 'image/png', filename: `${snap.name.replace(/[^\w.-]+/g, '_')}-${run.created_at.toISOString().slice(0, 10)}.${ext}` };
  }

  // ------------------------------------------------------------------------------------------ signed links

  private sign(runId: string, file: string, exp: number): string {
    return crypto.createHmac('sha256', this.cfg.security.jwt_secret).update(`snapshot:${runId}:${file}:${exp}`).digest('base64url');
  }

  /** A link that works without signing in until it expires (for chat channels that fetch the image). */
  signedUrl(run: SnapshotRun, kind: 'png' | 'pdf'): string | null {
    const base = this.cfg.server.public_url?.replace(/\/+$/, '');
    if (!base || !run.file) return null;
    const exp = Math.floor(Date.now() / 1000) + this.cfg.notifications.snapshot_link_days * 86_400;
    return `${base}/api/snapshot-files/${run.id}/${kind}?exp=${exp}&sig=${this.sign(run.id, kind, exp)}`;
  }

  async signedFile(runId: string, kind: string, exp: number, sig: string): Promise<{ path: string; contentType: string; filename: string } | null> {
    if (!['png', 'pdf'].includes(kind) || !Number.isFinite(exp) || exp < Date.now() / 1000) return null;
    const want = this.sign(runId, kind, exp);
    if (want.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(sig))) return null;
    const run = (await this.db.select().from(this.s.snapshotRuns).where(eq(this.s.snapshotRuns.id, runId)).limit(1))[0];
    if (!run?.file) return null;
    const snap = (await this.db.select().from(this.s.snapshots).where(eq(this.s.snapshots.id, run.snapshot_id)).limit(1))[0];
    if (!snap) return null;
    const png = run.file.replace(/\.pdf$/, '.png');
    const r = { ...run, file: kind === 'pdf' ? run.file.replace(/\.png$/, '.pdf') : png };
    try {
      return this.fileInfo(snap, r);
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------------------------------------ rendering

  /** Renders a snapshot's target as `owner` (queued: one browser at a time). */
  render(snap: Snapshot, owner: User): Promise<Rendering> {
    const job = this.queue.then(() => this.renderNow(snap, owner));
    this.queue = job.catch(() => undefined);
    return job;
  }

  private async renderNow(snap: Snapshot, owner: User): Promise<Rendering> {
    const chrome = findChrome(this.cfg.apps.chrome_path);
    if (!chrome) throw new Error('No Chrome / Chromium on this server — install one or set apps.chrome_path (CHROME_PATH)');
    const p = this.auth.principalFromUser(owner, 'jwt', 'snapshots');
    const timeout = this.cfg.notifications.snapshot_timeout_seconds * 1000;
    const wantPdf = snap.format === 'pdf';
    if (snap.target.kind === 'app') {
      const app = await this.apps.get(p, snap.target.app_id);
      if (app.execution !== 'browser') await this.apps.start(p, app.id);
      const shot = await this.apps.screenshot(app, owner.id, this.apps.proxyUrl, { width: snap.width, height: 900, wait_ms: timeout, fullPage: true, pdf: wantPdf });
      if (!shot) throw new Error('No Chrome / Chromium on this server');
      return { png: shot.png, pdf: shot.pdf, title: app.name };
    }
    const dash = await this.dashboards.get(p, snap.target.dashboard_id);
    if (!this.signUserSession) throw new Error('Snapshots are not ready yet (the server is starting)');
    const session = this.signUserSession(owner);
    const ui = this.apps.internalUrl.replace(/\/+$/, '');
    return withHeadless({ chromePath: chrome, width: snap.width, height: 900, budgetMs: timeout + 30_000 }, async (page) => {
      // Sign the UI in with a short session, then open the dashboard alone (a full load: the query string changes).
      await page.navigate(`${ui}/`);
      await page.waitFor('document.readyState === "complete"', 20_000, 'the UI to load');
      await page.evaluate(`localStorage.setItem('duckview.session', ${JSON.stringify(session)}), true`);
      await page.navigate(`${ui}/?snapshot=${Date.now()}#/snapshot/dashboard/${dash.id}`);
      await page.waitFor(`['loaded', 'ready', 'error'].includes(document.documentElement.dataset.snapshot)`, timeout, 'the dashboard to load');
      if (dash.kind === 'mosaic') await page.waitFor(`['ready', 'error'].includes(document.documentElement.dataset.snapshot)`, timeout, 'the Mosaic spec to render');
      const failed = await page.evaluate<string>(`document.documentElement.dataset.snapshot === 'error' ? (document.documentElement.dataset.snapshotError || 'the dashboard did not render') : ''`);
      if (failed) throw new Error(failed);
      await page.waitNetworkIdle(1500, timeout);
      await page.evaluate('document.fonts ? Promise.race([document.fonts.ready.then(() => true), new Promise((r) => setTimeout(() => r(true), 3000))]) : true');
      await new Promise((r) => setTimeout(r, 800)); // charts animate in
      await page.evaluate(`localStorage.removeItem('duckview.session'), true`);
      const png = await page.screenshot({ fullPage: true, maxHeight: 8000 });
      const pdf = wantPdf ? await page.pdf() : null;
      return { png, pdf, title: dash.name };
    });
  }

  // ------------------------------------------------------------------------------------------ running

  /** Renders and delivers now (the scheduler, a person, an agent). Never throws for rendering errors. */
  async run(id: string, triggeredBy: string, p: Principal | null = null): Promise<{ snapshot: Snapshot; run: SnapshotRun }> {
    const snap = p ? await this.get(p, id) : (await this.db.select().from(this.s.snapshots).where(eq(this.s.snapshots.id, id)).limit(1))[0];
    if (!snap) throw notFound('Snapshot');
    const t0 = Date.now();
    const runId = newId();
    let rendering: Rendering | null = null;
    let error: string | null = null;
    let file: string | null = null;
    let bytes: number | null = null;
    try {
      const owner = await this.auth.findActive(snap.user_id);
      if (!owner) throw new Error('The snapshot\'s owner no longer exists or has been deactivated');
      rendering = await this.render(snap, owner);
      const folder = path.join(this.dir, snap.id);
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(path.join(folder, `${runId}.png`), rendering.png);
      if (rendering.pdf) fs.writeFileSync(path.join(folder, `${runId}.pdf`), rendering.pdf);
      file = path.join(snap.id, `${runId}.${snap.format === 'pdf' && rendering.pdf ? 'pdf' : 'png'}`);
      bytes = (rendering.pdf ?? rendering.png).length;
    } catch (err) {
      error = ((err as Error).message ?? String(err)).split('\n')[0]!.slice(0, 500);
      logger().warn({ snapshot: id, err: error }, 'Snapshot did not render');
    }
    const now = new Date();
    const run: SnapshotRun = { id: runId, snapshot_id: id, status: error ? 'error' : 'ok', error, format: snap.format, file, bytes, delivered: 0, triggered_by: triggeredBy, duration_ms: Date.now() - t0, created_at: now };
    await this.db.insert(this.s.snapshotRuns).values(run);
    if (snap.channel_ids.length) {
      const ws = (await this.db.select({ name: this.s.workspaces.name }).from(this.s.workspaces).where(eq(this.s.workspaces.id, snap.workspace_id)).limit(1))[0];
      const results = await this.notifications.send(snap.channel_ids, this.message(snap, run, rendering, error, ws?.name ?? null), `snapshot:${snap.id}`, snap.workspace_id);
      run.delivered = results.filter((r) => r.status === 'ok').length;
      await this.db.update(this.s.snapshotRuns).set({ delivered: run.delivered }).where(eq(this.s.snapshotRuns.id, runId));
    }
    const set: Partial<Snapshot> = { last_status: run.status, last_error: error, last_run_at: now };
    await this.db.update(this.s.snapshots).set(set).where(eq(this.s.snapshots.id, id));
    return { snapshot: { ...snap, ...set }, run };
  }

  private message(snap: Snapshot, run: SnapshotRun, r: Rendering | null, error: string | null, workspace: string | null): Notification {
    const when = run.created_at.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
    const what = snap.target.kind === 'dashboard' ? 'Dashboard' : 'App';
    const link = this.notifications.link(snap.target.kind === 'dashboard' ? `/#/dashboards/${snap.target.dashboard_id}` : `/#/apps/${snap.target.app_id}`);
    const base: Notification = { title: snap.name, text: '', severity: 'info', event: 'snapshot.delivered', url: link, workspace: workspace ? { id: snap.workspace_id, name: workspace } : null, fields: [{ label: what, value: r?.title ?? snap.name }, ...(workspace ? [{ label: 'Workspace', value: workspace }] : []), { label: 'Rendered', value: when }] };
    if (error || !r) return { ...base, title: `Snapshot failed: ${snap.name}`, text: `The scheduled snapshot could not be rendered: ${error}`, severity: 'warning', event: 'snapshot.failed' };
    const pngUrl = this.signedUrl(run, 'png');
    const pdfUrl = r.pdf ? this.signedUrl(run, 'pdf') : null;
    const stamp = run.created_at.toISOString().slice(0, 10);
    const safe = snap.name.replace(/[^\w.-]+/g, '_');
    return {
      ...base,
      text: `${what} "${r.title}" as of ${when}.${pdfUrl ? `\nPDF: ${pdfUrl}` : ''}${!pngUrl && this.cfg.server.public_url === undefined ? '\n(Set server.public_url for the picture to show in chat channels.)' : ''}`,
      image: { data: r.png, filename: `${safe}-${stamp}.png`, contentType: 'image/png', url: pngUrl },
      attachments: r.pdf ? [{ filename: `${safe}-${stamp}.pdf`, content: r.pdf, contentType: 'application/pdf' }] : [],
    };
  }

  /** Runs the snapshots that are due and removes old files; called by the ticker and by tests. */
  async tick(now = new Date()): Promise<string[]> {
    const due = await this.db.select().from(this.s.snapshots).where(and(eq(this.s.snapshots.enabled, true), isNotNull(this.s.snapshots.next_run_at), lte(this.s.snapshots.next_run_at, now)));
    const ran: string[] = [];
    for (const s of due) {
      // Claimed atomically: with several nodes (cluster mode) only the one whose update lands runs it.
      const claimed = await this.db.update(this.s.snapshots).set({ next_run_at: nextRunAt(s.schedule, now) }).where(and(eq(this.s.snapshots.id, s.id), eq(this.s.snapshots.next_run_at, s.next_run_at!))).returning({ id: this.s.snapshots.id });
      if (!claimed.length) continue;
      try {
        await this.run(s.id, 'schedule');
        ran.push(s.id);
      } catch (err) {
        logger().warn({ snapshot: s.id, err: (err as Error).message }, 'Snapshot run failed');
      }
    }
    if (now.getTime() - this.lastCleanup > 3_600_000) {
      this.lastCleanup = now.getTime();
      await this.cleanup(now).catch(() => undefined);
    }
    return ran;
  }

  /** Deletes runs and files older than notifications.snapshot_retention_days. */
  async cleanup(now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - this.cfg.notifications.snapshot_retention_days * 86_400_000);
    const old = await this.db.select().from(this.s.snapshotRuns).where(lt(this.s.snapshotRuns.created_at, cutoff));
    for (const r of old) {
      for (const ext of ['png', 'pdf']) fs.rmSync(path.join(this.dir, r.snapshot_id, `${r.id}.${ext}`), { force: true });
    }
    await this.db.delete(this.s.snapshotRuns).where(lt(this.s.snapshotRuns.created_at, cutoff));
    return old.length;
  }

  start(intervalMs = 30_000): void {
    if (this.ticker) return;
    this.ticker = setInterval(() => void this.tick().catch((err) => logger().warn({ err: (err as Error).message }, 'Snapshot scheduler tick failed')), intervalMs);
    this.ticker.unref();
  }

  stop(): void {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
  }
}
