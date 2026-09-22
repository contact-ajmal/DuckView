/**
 * Data apps: Streamlit applications built on a workspace's data, registered next to dashboards and run by DuckView.
 *
 * The source lives in the metadata store and is handed to a runtime (app-runtimes.ts: a subprocess from a shared
 * virtualenv, a Docker container, or a Kubernetes pod) when the app starts, with a minimal environment: no server
 * secrets, only DUCKVIEW_URL / DUCKVIEW_TOKEN / DUCKVIEW_WORKSPACE, where the token is read-only, scoped to the app's
 * workspace, minted for the app's creator on every start and revoked when it stops. Health is polled on Streamlit's
 * /_stcore/health, logs are kept in a ring buffer, and every row is reset to `stopped` when the server boots.
 *
 * Scaling: apps scale to zero — a ticker stops idle ones and the proxy starts them on the next visit; when
 * apps.max_running is reached the least recently used idle app is evicted; `always_on` apps start with the server,
 * are never stopped for idleness and are restarted (with backoff) after a crash.
 *
 * Publishing: an app is visible to its workspace; making it visible to everyone signed in ("org") waits for an
 * administrator when apps.publish_requires_approval is set, and a code change to an approved app sends it back to
 * review.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import type { MetadataStore } from '../db/index.js';
import type { DataApp, AppFiles, AppStatus, AppVisibility, AppPublishStatus } from '../db/schema/sqlite.js';
import { APP_VISIBILITIES } from '../db/schema/sqlite.js';
import type { DuckViewConfig } from '../config/index.js';
import { newId } from '../security/crypto.js';
import type { Principal } from './principal.js';
import { requireWrite, isPlatformAdmin } from './principal.js';
import type { WorkspaceService } from './workspaces.js';
import type { AuthService } from './auth.js';
import type { AuditService } from './audit.js';
import { badRequest, notFound, forbidden } from './errors.js';
import type { DashboardService, SavedQueryService } from './bi.js';
import { appFromDashboard, appFromQueries } from './app-generator.js';
import { logger } from '../observability/logger.js';
import { liveEvents } from '../observability/events.js';
import { createRuntime, SubprocessRuntime, type AppRuntime, type Exit, type Instance } from './app-runtimes.js';

export type PublicApp = Omit<DataApp, 'pid'> & { url: string; source_bytes: number; running: boolean; runtime_ref: string | null };
/** One row of the administrators' view: the app without its source, with its owner and workspace. */
export type AdminApp = Omit<PublicApp, 'files'> & { owner_email: string | null; workspace_name: string | null; requested_by_email: string | null; last_used_ms: number | null };
export type StopReason = 'manual' | 'idle' | 'restart' | 'delete' | 'shutdown' | 'evicted';
export interface AppInput {
  name: string;
  description?: string | null;
  files?: AppFiles;
  entry?: string;
  spec?: Record<string, unknown> | null;
  visibility?: AppVisibility;
}
export interface AppTemplate {
  id: string;
  label: string;
  blurb: string;
  files: AppFiles;
}
/** Where an app's code comes from: a template, a dashboard, saved queries / inline SQL, or code as written. */
export type AppSource = { template: string } | { dashboard_id: string } | { queries: { name: string; sql: string }[] } | { saved_query_ids: string[] } | { code: string; requirements?: string | null };
export interface Generated {
  files: AppFiles;
  spec: Record<string, unknown>;
  name: string;
  description: string | null;
  summary: string;
}

interface Proc {
  /** null while the runtime is still launching it. */
  inst: Instance | null;
  tokenId: string | null;
  ownerId: string;
  logs: string[];
  startedAt: number;
  lastUsed: number;
  healthy: boolean;
  alwaysOn: boolean;
  stopping: boolean;
}

const LOG_LINES = 500;
const SAFE_FILE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*(\/[A-Za-z0-9_][A-Za-z0-9_.-]*)*$/;

/** Starter apps offered by the gallery. */
export const APP_TEMPLATES: AppTemplate[] = [
  {
    id: 'explorer',
    label: 'Table explorer',
    blurb: 'Pick a table, filter it, chart a column — the app every workspace can start from.',
    files: {
      'app.py': `import streamlit as st
from duckview.streamlit import connect, query, table_picker, viewer

st.set_page_config(page_title="Explorer", layout="wide")
st.title("Explorer")
dv = connect()

rel = table_picker(dv)          # a table, a view or a data file of the workspace (the SQL relation to read it)
if not rel:
    st.stop()

limit = st.sidebar.slider("Rows", 100, 10_000, 1_000, step=100)
where = st.sidebar.text_input("Filter (SQL WHERE)", placeholder="fare_amount > 10")
sql = f"SELECT * FROM {rel}" + (f" WHERE {where}" if where.strip() else "") + f" LIMIT {limit}"
df = query(sql)

st.caption(f"{len(df):,} rows · viewing as {viewer()['email'] or 'anonymous'}")
st.dataframe(df, width="stretch", hide_index=True)

numeric = [c for c in df.columns if str(df[c].dtype).startswith(("int", "float"))]
if numeric:
    col = st.selectbox("Chart", numeric)
    st.bar_chart(df[col].value_counts().sort_index().head(50))
`,
      'requirements.txt': '',
    },
  },
  {
    id: 'blank',
    label: 'Blank',
    blurb: 'A connection and a query; write the rest.',
    files: {
      'app.py': `import streamlit as st
from duckview.streamlit import connect, query

st.title("My data app")
dv = connect()
df = query("SELECT 42 AS answer")
st.dataframe(df)
`,
      'requirements.txt': '',
    },
  },
];

export class DataAppService {
  private procs = new Map<string, Proc>();
  private ticker: NodeJS.Timeout | null = null;
  /** Consecutive crash restarts of always-on apps, and the pending timer. */
  private restarts = new Map<string, { count: number; timer: NodeJS.Timeout | null }>();
  /** Apps being deleted: nothing may start them meanwhile. */
  private removing = new Set<string>();
  readonly runtime: AppRuntime;
  /** Where apps reach this server; set after listen (tests bind port 0). */
  internalUrl: string;
  /** Where the app proxy listens (the apps listener, or this server with isolation off); set after listen. */
  proxyUrl: string;
  /** Overridable for tests (a fake "streamlit"). */
  command: string[] | null;
  /** Signs the /apps session cookie for a user (set by the routes; used for headless previews). */
  signSession: ((userId: string) => string) | null = null;
  private bi: { dashboards: DashboardService; savedQueries: SavedQueryService } | null = null;

  constructor(private readonly store: MetadataStore, private readonly cfg: DuckViewConfig, private readonly workspaces: WorkspaceService, private readonly auth: AuthService, private readonly audit: AuditService) {
    this.internalUrl = `http://127.0.0.1:${cfg.server.port}`;
    this.proxyUrl = cfg.apps.isolation ? `http://127.0.0.1:${cfg.apps.port}` : this.internalUrl;
    this.command = cfg.apps.command ?? null;
    this.runtime = createRuntime(cfg, {
      command: () => this.command,
      sdkDir: () => DataAppService.sdkDir(),
      usedPorts: () => new Set([...this.procs.values()].flatMap((p) => (p.inst && p.inst.host === '127.0.0.1' ? [p.inst.port] : []))),
      runDir: (id) => this.runDir(id),
      internalPort: () => Number(new URL(this.internalUrl).port) || cfg.server.port,
    });
  }
  private get db() {
    return this.store.db;
  }
  private get s() {
    return this.store.schema;
  }
  get enabled(): boolean {
    return this.cfg.apps.enabled;
  }

  /** Boot: nothing is running yet, whatever the rows say. */
  async init(): Promise<void> {
    await this.db.update(this.s.dataApps).set({ status: 'stopped', port: null, pid: null }).where(eq(this.s.dataApps.status, 'running'));
    await this.db.update(this.s.dataApps).set({ status: 'stopped', port: null, pid: null }).where(eq(this.s.dataApps.status, 'starting'));
    await this.db.update(this.s.dataApps).set({ status: 'stopped', port: null, pid: null }).where(eq(this.s.dataApps.status, 'installing'));
    if (this.enabled) {
      const n = await this.runtime.cleanup().catch((err) => {
        logger().warn({ runtime: this.runtime.name, err: (err as Error).message }, 'Could not clean up app instances of a previous run');
        return 0;
      });
      if (n) logger().info({ runtime: this.runtime.name, removed: n }, 'Removed app instances left by a previous run');
    }
    if (!this.ticker) {
      this.ticker = setInterval(() => void this.reapIdle().catch(() => undefined), 60_000);
      this.ticker.unref();
    }
  }

  /** Once the server listens (apps call back into it): start the always-on apps. */
  async startAlwaysOn(): Promise<string[]> {
    if (!this.enabled) return [];
    const rows = await this.db.select({ id: this.s.dataApps.id }).from(this.s.dataApps).where(eq(this.s.dataApps.always_on, true));
    for (const r of rows) void this.startAsOwner(r.id);
    return rows.map((r) => r.id);
  }

  /** Starts an app on its creator's behalf (boot, crash restarts). */
  private async startAsOwner(id: string): Promise<void> {
    const row = (await this.db.select().from(this.s.dataApps).where(eq(this.s.dataApps.id, id)).limit(1))[0];
    if (!row || !row.always_on || this.procs.has(id)) return;
    const owner = await this.auth.findById(row.user_id);
    if (!owner) return;
    try {
      await this.start(this.auth.principalFromUser(owner, 'jwt', 'always-on'), id);
    } catch (err) {
      logger().warn({ app: id, err: (err as Error).message }, 'Always-on app did not start');
      this.scheduleRestart(id);
    }
  }

  private scheduleRestart(id: string): void {
    const r = this.restarts.get(id) ?? { count: 0, timer: null };
    if (r.timer) return;
    if (r.count >= this.cfg.apps.max_restarts) {
      this.log(id, `not restarting: ${r.count} restarts in a row failed (apps.max_restarts)`);
      return;
    }
    const delay = Math.min(5_000 * 2 ** r.count, 300_000);
    r.count++;
    this.log(id, `restarting in ${Math.round(delay / 1000)} s (attempt ${r.count} of ${this.cfg.apps.max_restarts})`);
    r.timer = setTimeout(() => {
      r.timer = null;
      void this.startAsOwner(id);
    }, delay);
    r.timer.unref();
    this.restarts.set(id, r);
  }

  private clearRestarts(id: string): void {
    const r = this.restarts.get(id);
    if (r?.timer) clearTimeout(r.timer);
    this.restarts.delete(id);
  }

  bind(bi: { dashboards: DashboardService; savedQueries: SavedQueryService }): void {
    this.bi = bi;
  }

  // ------------------------------------------------------------------ generation & validation

  /** Turns a source into files (+ the spec that records where they came from). */
  async generate(p: Principal, workspaceId: string, source: AppSource, opts: { name?: string; description?: string | null } = {}): Promise<Generated> {
    if ('template' in source) {
      const t = APP_TEMPLATES.find((x) => x.id === source.template);
      if (!t) throw badRequest(`Unknown template "${source.template}" (${APP_TEMPLATES.map((x) => x.id).join(', ')})`);
      return { files: { ...t.files }, spec: { template: t.id }, name: opts.name ?? t.label, description: opts.description ?? null, summary: t.label };
    }
    if ('code' in source) {
      return { files: { 'app.py': source.code, 'requirements.txt': source.requirements ?? '' }, spec: { source: 'code' }, name: opts.name ?? 'App', description: opts.description ?? null, summary: 'code as written' };
    }
    if ('dashboard_id' in source) {
      if (!this.bi) throw badRequest('Dashboards are not available');
      const d = await this.bi.dashboards.get(p, source.dashboard_id);
      if (d.workspace_id !== workspaceId) throw badRequest('The dashboard belongs to another workspace');
      if (d.kind === 'mosaic' && d.spec) {
        const g = appFromDashboard(d.spec, { name: opts.name ?? d.name, description: opts.description ?? d.description });
        return { files: g.files, spec: { dashboard_id: d.id, kind: 'mosaic' }, name: opts.name ?? d.name, description: opts.description ?? d.description, summary: g.summary };
      }
      const queries: { name: string; sql: string }[] = [];
      for (const w of d.widgets) {
        const sql = w.custom_sql ?? (w.saved_query_id ? (await this.bi.savedQueries.get(p, workspaceId, w.saved_query_id).catch(() => null))?.sql_text : null);
        if (sql) queries.push({ name: w.title, sql });
      }
      if (!queries.length) throw badRequest('The dashboard has no widgets with SQL to build from');
      const g = appFromQueries(queries, { name: opts.name ?? d.name, description: opts.description ?? d.description });
      return { files: g.files, spec: { dashboard_id: d.id, kind: 'grid' }, name: opts.name ?? d.name, description: opts.description ?? d.description, summary: g.summary };
    }
    if ('saved_query_ids' in source) {
      if (!this.bi) throw badRequest('Saved queries are not available');
      const queries: { name: string; sql: string }[] = [];
      for (const id of source.saved_query_ids) {
        const q = await this.bi.savedQueries.get(p, workspaceId, id);
        queries.push({ name: q.name, sql: q.sql_text });
      }
      if (!queries.length) throw badRequest('saved_query_ids is empty');
      const g = appFromQueries(queries, opts);
      return { files: g.files, spec: { saved_query_ids: source.saved_query_ids }, name: opts.name ?? g.summary, description: opts.description ?? null, summary: g.summary };
    }
    if (!source.queries?.length) throw badRequest('queries is empty');
    const g = appFromQueries(source.queries, opts);
    return { files: g.files, spec: { queries: source.queries.map((q) => q.name) }, name: opts.name ?? (source.queries.length === 1 ? source.queries[0]!.name : 'Queries'), description: opts.description ?? null, summary: g.summary };
  }

  /**
   * Static checks before code from an agent (or the editor's "Check") is saved: the entry compiles (py_compile
   * with the apps' Python, when there is one), imports streamlit, and carries no token. Never executes the app.
   */
  async validateSource(files: AppFiles, entry = 'app.py'): Promise<{ ok: boolean; errors: string[]; warnings: string[] }> {
    const errors: string[] = [];
    const warnings: string[] = [];
    try {
      this.validateFiles(files, entry);
    } catch (err) {
      errors.push((err as Error).message);
    }
    const code = files[entry] ?? '';
    if (code && !/^\s*(import|from)\s+streamlit\b/m.test(code)) errors.push(`${entry} does not import streamlit`);
    if (/use_container_width/.test(code)) warnings.push('use_container_width is deprecated in Streamlit ≥ 1.46 — use width="stretch"');
    const venvPy = SubprocessRuntime.venvPython(this.cfg);
    const py = fs.existsSync(venvPy) ? venvPy : this.cfg.apps.python;
    if (code && py) {
      fs.mkdirSync(this.cfg.duckdb.temp_directory, { recursive: true });
      const dir = fs.mkdtempSync(path.join(this.cfg.duckdb.temp_directory, 'dv-app-check-'));
      try {
        for (const [name, content] of Object.entries(files)) {
          if (!name.endsWith('.py')) continue;
          const target = path.join(dir, name);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, content);
          const r = await new Promise<{ code: number | null; out: string }>((resolve) => {
            const c = spawn(py, ['-m', 'py_compile', target], { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1' } });
            let out = '';
            c.stdout?.on('data', (d) => (out += d));
            c.stderr?.on('data', (d) => (out += d));
            c.on('error', (e) => resolve({ code: -1, out: e.message }));
            c.on('exit', (code) => resolve({ code, out }));
            setTimeout(() => c.kill('SIGKILL'), 10_000);
          });
          if (r.code === -1) warnings.push(`Could not run ${path.basename(py)} to compile ${name}: ${r.out}`);
          else if (r.code !== 0) errors.push(`${name} does not compile: ${r.out.replace(dir + '/', '').trim().split('\n').slice(-3).join(' ').slice(0, 500)}`);
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
    return { ok: errors.length === 0, errors, warnings };
  }

  /**
   * A headless screenshot of the running app for agents (Chrome via CDP, when a browser is installed; the
   * proxy's own cookie signs the visitor in). Returns null without a browser.
   */
  async screenshot(app: DataApp, userId: string, baseUrl: string, opts: { width?: number; height?: number; wait_ms?: number } = {}): Promise<{ png: Buffer; text: string } | null> {
    const chrome = findChrome(this.cfg.apps.chrome_path);
    if (!chrome || !this.signSession) return null;
    const { default: WebSocket } = await import('ws');
    const os = await import('node:os');
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dv-shot-'));
    const port = 9400 + Math.floor(Math.random() * 400);
    const flags = [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', '--disable-dev-shm-usage', '--disable-extensions', `--window-size=${opts.width ?? 1280},${opts.height ?? 900}`, 'about:blank'];
    if (process.getuid?.() === 0) flags.unshift('--no-sandbox'); // containers running as root cannot use Chrome's sandbox
    const child = spawn(chrome, flags, { stdio: 'ignore' });
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const budget = (opts.wait_ms ?? 25_000) + 20_000; // the whole session, whatever Chrome does
    const deadlineAll = Date.now() + budget;
    const handle: { ws: { close(): void } | null } = { ws: null }; // assigned inside run(); narrowing across the closure
    try {
      const run = async (): Promise<{ png: Buffer; text: string }> => {
        let target: { webSocketDebuggerUrl: string } | undefined;
        for (let i = 0; i < 50 && !target; i++) {
          if (child.exitCode !== null) throw new Error(`Chrome exited with ${child.exitCode}`);
          try {
            const list = (await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(1000) })).json()) as { type: string; webSocketDebuggerUrl: string }[];
            target = list.find((t) => t.type === 'page');
          } catch {
            await sleep(200);
          }
        }
        if (!target) throw new Error('Chrome did not start');
        const socket = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false });
        handle.ws = socket;
        await new Promise<void>((resolve, reject) => { socket.on('open', () => resolve()); socket.on('error', reject); });
        let id = 0;
        const pending = new Map<number, { resolve: (m: { result?: Record<string, unknown> }) => void; reject: (e: Error) => void }>();
        socket.on('message', (raw) => { const m = JSON.parse(String(raw)) as { id?: number; result?: Record<string, unknown> }; if (m.id && pending.has(m.id)) { pending.get(m.id)!.resolve(m); pending.delete(m.id); } });
        socket.on('close', () => { for (const p of pending.values()) p.reject(new Error('Chrome closed the connection')); pending.clear(); });
        // Every command has its own timeout: a crashed or wedged browser must never hang the caller.
        const send = (method: string, params: Record<string, unknown> = {}) => new Promise<Record<string, unknown>>((resolve, reject) => {
          const i = ++id;
          const t = setTimeout(() => { pending.delete(i); reject(new Error(`Chrome did not answer ${method}`)); }, 10_000);
          pending.set(i, { resolve: (m) => { clearTimeout(t); resolve(m.result ?? {}); }, reject: (e) => { clearTimeout(t); reject(e); } });
          socket.send(JSON.stringify({ id: i, method, params }));
        });
        const evaluate = async (expression: string) => ((await send('Runtime.evaluate', { expression, returnByValue: true })) as { result?: { value?: unknown } }).result?.value;
        await send('Page.enable');
        await send('Runtime.enable');
        const u = new URL(baseUrl);
        await send('Network.setCookie', { name: 'dv_app', value: this.signSession!(userId), domain: u.hostname, path: '/apps', httpOnly: true });
        await send('Page.navigate', { url: `${baseUrl.replace(/\/+$/, '')}/apps/${app.id}/` });
        const deadline = Date.now() + (opts.wait_ms ?? 25_000);
        let text = '';
        while (Date.now() < deadline) {
          await sleep(500);
          const state = (await evaluate(`(() => { const running = !!document.querySelector('[data-testid="stStatusWidget"]'); const ready = !!document.querySelector('[data-testid="stAppViewContainer"]'); return { running, ready, text: document.body.innerText.slice(0, 4000) }; })()`)) as { running: boolean; ready: boolean; text: string } | undefined;
          if (state) text = state.text;
          if (state?.ready && !state.running) {
            await sleep(1200); // charts settle after the status widget disappears
            text = String((await evaluate('document.body.innerText.slice(0, 4000)')) ?? text);
            break;
          }
        }
        const shot = (await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })) as { data?: string };
        if (!shot.data) throw new Error('no screenshot');
        return { png: Buffer.from(shot.data, 'base64'), text };
      };
      return await Promise.race([run(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`preview took longer than ${Math.round(budget / 1000)} s`)), Math.max(1000, deadlineAll - Date.now())))]);
    } finally {
      try {
        handle.ws?.close();
      } catch {
        /* closed */
      }
      // Chrome keeps writing to its profile until it is gone: wait for the exit, then clean up (best effort).
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 3000);
        child.once('exit', () => { clearTimeout(t); resolve(); });
        child.kill('SIGKILL');
      });
      for (let i = 0; i < 5; i++) {
        try {
          fs.rmSync(profile, { recursive: true, force: true });
          break;
        } catch {
          await sleep(200);
        }
      }
    }
  }

  // ------------------------------------------------------------------ registry

  toPublic(a: DataApp): PublicApp {
    const { pid: _p, ...rest } = a;
    const proc = this.procs.get(a.id);
    return { ...rest, url: `/apps/${a.id}/`, source_bytes: Object.values(a.files).reduce((n, f) => n + Buffer.byteLength(f), 0), running: proc?.healthy === true, runtime_ref: proc?.inst?.ref ?? null };
  }

  templates(): AppTemplate[] {
    return APP_TEMPLATES;
  }

  private validateFiles(files: AppFiles, entry: string): AppFiles {
    const out: AppFiles = {};
    let total = 0;
    for (const [name, content] of Object.entries(files)) {
      if (!SAFE_FILE.test(name) || name.includes('..')) throw badRequest(`Invalid file name "${name}" (relative paths of letters, digits, dot, dash, underscore)`);
      if (typeof content !== 'string') throw badRequest(`File "${name}" must be text`);
      total += Buffer.byteLength(content);
      out[name] = content;
    }
    if (total > this.cfg.apps.max_source_bytes) throw badRequest(`App source is ${total} bytes; the limit is ${this.cfg.apps.max_source_bytes}`);
    if (!out[entry]) throw badRequest(`The entry file "${entry}" is missing`);
    if (/\bdv_[A-Za-z0-9]{16,}\b/.test(out[entry]!) || /\b(sk|rk|pat|ntn|xox[bp])-[A-Za-z0-9_-]{12,}\b/.test(Object.values(out).join('\n'))) throw badRequest('The source contains what looks like an API token — apps get their DuckView token from the environment (duckview.connect()), other secrets belong in a connection');
    return out;
  }

  async create(p: Principal, workspaceId: string, input: AppInput): Promise<PublicApp> {
    requireWrite(p);
    await this.workspaces.get(p, workspaceId, 'EDITOR');
    const name = (input.name ?? '').trim().slice(0, 120);
    if (!name) throw badRequest('name is required');
    const entry = (input.entry ?? 'app.py').trim();
    if (!SAFE_FILE.test(entry) || !entry.endsWith('.py')) throw badRequest('entry must be a .py file');
    const files = this.validateFiles(input.files ?? APP_TEMPLATES[0]!.files, entry);
    if (input.visibility && !APP_VISIBILITIES.includes(input.visibility)) throw badRequest(`visibility must be ${APP_VISIBILITIES.join(' or ')}`);
    const now = new Date();
    const row: DataApp = { id: newId(), workspace_id: workspaceId, user_id: p.userId, name, description: input.description?.trim() || null, kind: 'streamlit', entry, files, spec: input.spec ?? null, visibility: 'workspace', status: 'stopped', port: null, pid: null, last_error: null, last_started_at: null, last_used_at: null, always_on: false, runtime: null, publish_status: 'none', publish_requested_by: null, publish_requested_at: null, publish_reviewed_by: null, publish_reviewed_at: null, publish_note: null, created_at: now, updated_at: now };
    if (input.visibility === 'org') Object.assign(row, this.publishFields(p, 'org', null, now));
    await this.db.insert(this.s.dataApps).values(row);
    this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'app.create', resource: `app:${row.id}`, ip: p.ip });
    return this.toPublic(row);
  }

  /** Members of the app's workspace see it (viewers included); `org` apps are visible to everyone signed in. */
  async get(p: Principal, id: string, minRole: 'VIEWER' | 'EDITOR' = 'VIEWER'): Promise<DataApp> {
    const rows = await this.db.select().from(this.s.dataApps).where(eq(this.s.dataApps.id, id)).limit(1);
    const app = rows[0];
    if (!app) throw notFound('App');
    try {
      await this.workspaces.get(p, app.workspace_id, minRole);
    } catch (err) {
      if (minRole === 'VIEWER' && app.visibility === 'org' && p.actorType === 'USER') return app;
      throw err;
    }
    return app;
  }

  async list(p: Principal, workspaceId: string): Promise<PublicApp[]> {
    await this.workspaces.get(p, workspaceId);
    const rows = await this.db.select().from(this.s.dataApps).where(eq(this.s.dataApps.workspace_id, workspaceId));
    return rows.sort((a, b) => b.updated_at.getTime() - a.updated_at.getTime()).map((r) => this.toPublic(r));
  }

  async update(p: Principal, id: string, patch: Partial<AppInput>): Promise<PublicApp> {
    requireWrite(p);
    const app = await this.get(p, id, 'EDITOR');
    const set: Partial<DataApp> = { updated_at: new Date() };
    if (patch.name !== undefined) set.name = patch.name.trim().slice(0, 120) || app.name;
    if (patch.description !== undefined) set.description = patch.description?.trim() || null;
    if (patch.entry !== undefined) {
      if (!SAFE_FILE.test(patch.entry) || !patch.entry.endsWith('.py')) throw badRequest('entry must be a .py file');
      set.entry = patch.entry;
    }
    if (patch.files !== undefined) set.files = this.validateFiles(patch.files, set.entry ?? app.entry);
    else if (set.entry && !app.files[set.entry]) throw badRequest(`The entry file "${set.entry}" is missing`);
    if (patch.spec !== undefined) set.spec = patch.spec;
    if (patch.visibility !== undefined && patch.visibility !== app.visibility) {
      if (!APP_VISIBILITIES.includes(patch.visibility)) throw badRequest(`visibility must be ${APP_VISIBILITIES.join(' or ')}`);
      Object.assign(set, this.publishFields(p, patch.visibility, null, set.updated_at!));
      this.audit.log({ userId: p.userId, actorType: p.actorType, action: `app.publish.${set.publish_status === 'pending' ? 'request' : patch.visibility}`, resource: `app:${id}`, ip: p.ip });
    }
    // Reviewed code changed: everyone else stops seeing it until an administrator looks again.
    const codeChanged = (patch.files !== undefined && JSON.stringify(set.files) !== JSON.stringify(app.files)) || (patch.entry !== undefined && patch.entry !== app.entry);
    if (codeChanged && (set.visibility ?? app.visibility) === 'org' && this.cfg.apps.publish_requires_approval && !isPlatformAdmin(p)) {
      Object.assign(set, { visibility: 'workspace', publish_status: 'pending', publish_requested_by: p.userId, publish_requested_at: set.updated_at, publish_reviewed_by: null, publish_reviewed_at: null, publish_note: 'The code changed after it was approved' } satisfies Partial<DataApp>);
      this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'app.publish.rereview', resource: `app:${id}`, ip: p.ip });
    }
    await this.db.update(this.s.dataApps).set(set).where(eq(this.s.dataApps.id, id));
    const next = { ...app, ...set };
    // Code changed while running: restart so the next visit runs the new version (the caller waits for it).
    if ((patch.files !== undefined || patch.entry !== undefined) && this.procs.has(id)) {
      await this.stop(p, id, 'restart');
      try {
        return await this.start(p, id);
      } catch (err) {
        logger().warn({ app: id, err: (err as Error).message }, 'App restart failed');
        return this.toPublic({ ...next, status: 'error', last_error: (err as Error).message });
      }
    }
    return this.toPublic(next);
  }

  async remove(p: Principal, id: string): Promise<void> {
    requireWrite(p);
    await this.get(p, id, 'EDITOR');
    this.clearRestarts(id);
    this.removing.add(id);
    try {
      await this.stop(p, id, 'delete').catch(() => undefined);
      await this.db.delete(this.s.dataApps).where(eq(this.s.dataApps.id, id));
    } finally {
      this.removing.delete(id);
    }
    fs.rmSync(this.runDir(id), { recursive: true, force: true });
    this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'app.delete', resource: `app:${id}`, ip: p.ip });
  }

  // ------------------------------------------------------------------ runtime

  private runDir(id: string): string {
    return path.join(this.cfg.security.data_jail_directory, '.duckview', 'apps', 'run', id);
  }
  /** The SDK source directory (monorepo checkout or the container image). */
  static sdkDir(): string | null {
    const here = path.dirname(fileURLToPath(import.meta.url));
    for (const c of [process.env.DUCKVIEW_SDK_DIR, path.resolve(here, '../../../sdk-python'), path.resolve(here, '../../sdk-python'), '/app/sdk-python']) {
      if (c && fs.existsSync(path.join(c, 'duckview', '__init__.py'))) return c;
    }
    return null;
  }

  logs(id: string): string[] {
    return this.procs.get(id)?.logs ?? this.lastLogs.get(id) ?? [];
  }
  private lastLogs = new Map<string, string[]>();
  private log(id: string, line: string) {
    const proc = this.procs.get(id);
    const buf = proc?.logs ?? this.lastLogs.get(id) ?? [];
    for (const l of line.split(/\r?\n/)) {
      if (!l.trim()) continue;
      buf.push(`${new Date().toISOString().slice(11, 19)} ${l}`);
      if (buf.length > LOG_LINES) buf.splice(0, buf.length - LOG_LINES);
    }
    if (!proc) this.lastLogs.set(id, buf);
  }

  private async setStatus(id: string, status: AppStatus, extra: Partial<DataApp> = {}): Promise<void> {
    await this.db.update(this.s.dataApps).set({ status, ...extra }).where(eq(this.s.dataApps.id, id));
    const row = (await this.db.select({ workspace_id: this.s.dataApps.workspace_id }).from(this.s.dataApps).where(eq(this.s.dataApps.id, id)).limit(1))[0];
    if (row) liveEvents.publish({ type: 'app', at: new Date().toISOString(), workspace_id: row.workspace_id, app_id: id, status, error: extra.last_error ?? null });
  }

  /** Where the proxy reaches the app, when it is up. */
  target(id: string): { host: string; port: number } | null {
    const proc = this.procs.get(id);
    return proc?.healthy && proc.inst ? { host: proc.inst.host, port: proc.inst.port } : null;
  }
  touch(id: string): void {
    const proc = this.procs.get(id);
    if (proc) proc.lastUsed = Date.now();
  }
  status(id: string): AppStatus | null {
    const proc = this.procs.get(id);
    if (!proc) return null;
    return proc.healthy ? 'running' : 'starting';
  }

  /** Stops the least recently used idle app (never an always-on one) to make room, or refuses. */
  private async makeRoom(): Promise<void> {
    const now = Date.now();
    const idleFor = this.cfg.apps.evict_idle_seconds * 1000;
    const victim = [...this.procs.entries()].filter(([, p]) => p.healthy && !p.alwaysOn && now - p.lastUsed >= idleFor).sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
    if (!victim) throw badRequest(`${this.cfg.apps.max_running} apps are already running (apps.max_running) and none has been idle for ${this.cfg.apps.evict_idle_seconds} s — stop one first`);
    logger().info({ app: victim[0], idle_s: Math.round((now - victim[1].lastUsed) / 1000) }, 'Evicting the least recently used app to make room');
    await this.stop(null, victim[0], 'evicted');
  }

  /** Starts the app (viewers may: the code belongs to the workspace). Resolves once Streamlit answers its health check. */
  async start(p: Principal, id: string): Promise<PublicApp> {
    if (!this.enabled) throw forbidden('Data apps are disabled on this server (apps.enabled)');
    if (this.removing.has(id)) throw notFound('App');
    const app = await this.get(p, id);
    if (this.procs.has(id)) return this.toPublic({ ...app, status: this.status(id) ?? 'starting' });
    if (this.procs.size >= this.cfg.apps.max_running) await this.makeRoom();
    if (this.procs.has(id)) return this.toPublic({ ...app, status: this.status(id) ?? 'starting' });
    const owner = await this.auth.findById(app.user_id);
    if (!owner) throw badRequest('The app\'s creator no longer exists');
    // Registered before the (possibly slow) launch so a second visit waits instead of starting a twin.
    const proc: Proc = { inst: null, tokenId: null, ownerId: owner.id, logs: [], startedAt: Date.now(), lastUsed: Date.now(), healthy: false, alwaysOn: app.always_on, stopping: false };
    this.procs.set(id, proc);
    this.lastLogs.delete(id);
    try {
      await this.setStatus(id, 'starting', { last_started_at: new Date(), last_error: null, runtime: this.runtime.name, port: null, pid: null });
      const minted = await this.auth.createToken(owner, { name: `app:${app.name}`, scopes: ['read'], workspaceId: app.workspace_id, expiresAt: new Date(Date.now() + this.cfg.apps.token_ttl_hours * 3_600_000) });
      proc.tokenId = minted.record.id;
      const inst = await this.runtime.launch({
        id,
        name: app.name,
        files: app.files,
        entry: app.entry,
        env: { DUCKVIEW_APP_ID: id, DUCKVIEW_URL: this.internalUrl, DUCKVIEW_TOKEN: minted.token, DUCKVIEW_WORKSPACE: app.workspace_id },
        baseUrlPath: `/apps/${id}`,
        log: (line) => this.log(id, line),
        installing: () => this.setStatus(id, 'installing'),
      });
      proc.inst = inst;
      void inst.exited.then((e) => this.onExit(id, proc, e));
      if (proc.stopping) throw new Error('stopped while starting');
      await this.setStatus(id, 'starting', { port: inst.port, pid: inst.pid });
      await this.waitHealthy(id, proc);
      proc.healthy = true;
      await this.setStatus(id, 'running', { last_used_at: new Date() });
      this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'app.start', resource: `app:${id}`, ip: p.ip });
      return this.toPublic({ ...app, status: 'running', port: inst.port, last_started_at: new Date(), runtime: this.runtime.name });
    } catch (err) {
      const message = ((err as Error).message ?? String(err)).split('\n')[0]!.slice(0, 500);
      this.log(id, `start failed: ${message}`);
      if (this.procs.get(id) === proc) {
        this.procs.delete(id);
        this.lastLogs.set(id, proc.logs);
      }
      proc.stopping = true;
      await proc.inst?.stop().catch(() => undefined);
      if (proc.tokenId) await this.auth.revokeToken(proc.ownerId, proc.tokenId).catch(() => undefined);
      if (message === 'stopped while starting') {
        await this.setStatus(id, 'stopped', { port: null, pid: null });
        throw badRequest('The app was stopped while it was starting');
      }
      await this.setStatus(id, 'error', { port: null, pid: null, last_error: message });
      throw err instanceof Error && 'statusCode' in err ? err : badRequest(message);
    }
  }

  /** The instance went away on its own (a stop removes it from `procs` first). */
  private onExit(id: string, proc: Proc, e: Exit): void {
    this.log(id, `process exited (${e.code ?? e.signal})`);
    if (this.procs.get(id) !== proc || proc.stopping) return;
    this.procs.delete(id);
    this.lastLogs.set(id, proc.logs);
    if (proc.tokenId) void this.auth.revokeToken(proc.ownerId, proc.tokenId).catch(() => undefined);
    // Our own stops never get here: anything else — a non-zero code, a signal, a pod deleted under us — is a crash.
    const clean = e.code === 0;
    void this.setStatus(id, clean ? 'stopped' : 'error', { port: null, pid: null, last_error: clean ? null : `exited with ${e.code ?? e.signal}: ${proc.logs.slice(-3).join(' · ').slice(0, 500)}` });
    if (!clean && proc.alwaysOn) {
      // An app that ran for a while before crashing starts a fresh series of retries.
      if (proc.healthy && Date.now() - proc.startedAt > 600_000) this.restarts.delete(id);
      this.scheduleRestart(id);
    }
  }

  private async waitHealthy(id: string, proc: Proc): Promise<void> {
    const inst = proc.inst!;
    const host = inst.host.includes(':') ? `[${inst.host}]` : inst.host;
    const deadline = Date.now() + this.cfg.apps.start_timeout_seconds * 1000;
    while (Date.now() < deadline) {
      if (inst.exit) throw new Error(`the app exited before it was ready: ${proc.logs.slice(-3).join(' · ')}`);
      if (proc.stopping) throw new Error('stopped while starting');
      try {
        const res = await fetch(`http://${host}:${inst.port}/apps/${id}/_stcore/health`, { signal: AbortSignal.timeout(2000) });
        if (res.ok) return;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    throw new Error(`the app did not answer its health check within ${this.cfg.apps.start_timeout_seconds} s`);
  }

  async stop(p: Principal | null, id: string, reason: StopReason = 'manual'): Promise<void> {
    if (reason !== 'restart' && reason !== 'evicted' && reason !== 'idle') this.clearRestarts(id);
    const proc = this.procs.get(id);
    if (!proc) {
      if (p) await this.get(p, id);
      await this.setStatus(id, 'stopped', { port: null, pid: null });
      return;
    }
    this.procs.delete(id);
    this.lastLogs.set(id, proc.logs);
    proc.stopping = true;
    this.log(id, `stopping (${reason})`);
    // Still launching: start() sees `stopping`, stops what it launched and revokes the token.
    if (!proc.inst) return;
    await proc.inst.stop().catch((err) => this.log(id, `stop: ${(err as Error).message}`));
    if (proc.tokenId) await this.auth.revokeToken(proc.ownerId, proc.tokenId).catch(() => undefined);
    await this.setStatus(id, 'stopped', { port: null, pid: null });
    if (p) this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'app.stop', resource: `app:${id}`, ip: p.ip });
  }

  /** Scale to zero: stops apps nobody used for apps.idle_stop_minutes (always-on apps stay). */
  async reapIdle(now = Date.now()): Promise<string[]> {
    const stopped: string[] = [];
    for (const [id, proc] of this.procs) {
      if (proc.alwaysOn || !proc.healthy) continue;
      if (now - proc.lastUsed > this.cfg.apps.idle_stop_minutes * 60_000) {
        await this.stop(null, id, 'idle');
        stopped.push(id);
      }
    }
    return stopped;
  }

  /** Keeps an app running (administrators: it holds resources for good). Starts it when switched on. */
  async setAlwaysOn(p: Principal, id: string, on: boolean): Promise<PublicApp> {
    if (!isPlatformAdmin(p)) throw forbidden('Only an administrator signed in to DuckView can keep apps always on');
    const app = await this.get(p, id);
    await this.db.update(this.s.dataApps).set({ always_on: on }).where(eq(this.s.dataApps.id, id));
    const proc = this.procs.get(id);
    if (proc) proc.alwaysOn = on;
    this.clearRestarts(id);
    this.audit.log({ userId: p.userId, actorType: p.actorType, action: on ? 'app.always_on' : 'app.always_on.off', resource: `app:${id}`, ip: p.ip });
    if (on && !proc && this.enabled) void this.startAsOwner(id);
    return this.toPublic({ ...app, always_on: on });
  }

  // ------------------------------------------------------------------ publishing

  /** The publish columns for a change of audience by `p` (administrators and servers without review publish at once). */
  private publishFields(p: Principal, audience: AppVisibility, note: string | null, now: Date): Partial<DataApp> {
    if (audience === 'workspace') return { visibility: 'workspace', publish_status: 'none', publish_requested_by: null, publish_requested_at: null, publish_reviewed_by: null, publish_reviewed_at: null, publish_note: null };
    if (!this.cfg.apps.publish_requires_approval || isPlatformAdmin(p)) return { visibility: 'org', publish_status: 'approved', publish_requested_by: p.userId, publish_requested_at: now, publish_reviewed_by: p.userId, publish_reviewed_at: now, publish_note: note };
    return { publish_status: 'pending', publish_requested_by: p.userId, publish_requested_at: now, publish_reviewed_by: null, publish_reviewed_at: null, publish_note: note };
  }

  /** Changes who sees the app; "org" becomes a request for review unless the caller may publish outright. */
  async publish(p: Principal, id: string, audience: AppVisibility, note?: string | null): Promise<{ app: PublicApp; outcome: 'published' | 'pending' | 'unpublished' }> {
    requireWrite(p);
    if (!APP_VISIBILITIES.includes(audience)) throw badRequest(`audience must be ${APP_VISIBILITIES.join(' or ')}`);
    const app = await this.get(p, id, 'EDITOR');
    const now = new Date();
    const set = { ...this.publishFields(p, audience, note?.trim().slice(0, 1000) || null, now), updated_at: now };
    await this.db.update(this.s.dataApps).set(set).where(eq(this.s.dataApps.id, id));
    const outcome = audience === 'workspace' ? 'unpublished' : set.publish_status === 'pending' ? 'pending' : 'published';
    this.audit.log({ userId: p.userId, actorType: p.actorType, action: outcome === 'pending' ? 'app.publish.request' : `app.publish.${audience}`, resource: `app:${id}`, ip: p.ip });
    liveEvents.publish({ type: 'app', at: now.toISOString(), workspace_id: app.workspace_id, app_id: id, status: this.status(id) ?? app.status, error: null });
    return { app: this.toPublic({ ...app, ...set }), outcome };
  }

  /** An administrator approves (the app becomes visible to everyone signed in) or rejects a pending request. */
  async review(p: Principal, id: string, decision: 'approve' | 'reject', note?: string | null): Promise<PublicApp> {
    if (!isPlatformAdmin(p)) throw forbidden('Only an administrator signed in to DuckView can review publish requests');
    const app = (await this.db.select().from(this.s.dataApps).where(eq(this.s.dataApps.id, id)).limit(1))[0];
    if (!app) throw notFound('App');
    if (app.publish_status !== 'pending') throw badRequest(`Nothing to review: the app is ${app.publish_status === 'approved' ? 'already published' : 'not waiting for review'}`);
    const now = new Date();
    const set: Partial<DataApp> = { publish_status: decision === 'approve' ? 'approved' : 'rejected', publish_reviewed_by: p.userId, publish_reviewed_at: now, publish_note: note?.trim().slice(0, 1000) || (decision === 'approve' ? null : app.publish_note), updated_at: now };
    if (decision === 'approve') set.visibility = 'org';
    await this.db.update(this.s.dataApps).set(set).where(eq(this.s.dataApps.id, id));
    this.audit.log({ userId: p.userId, actorType: p.actorType, action: `app.publish.${decision}`, resource: `app:${id}`, ip: p.ip });
    liveEvents.publish({ type: 'app', at: now.toISOString(), workspace_id: app.workspace_id, app_id: id, status: this.status(id) ?? app.status, error: null });
    return this.toPublic({ ...app, ...set });
  }

  /** Every app on the server, without sources, with owners and workspaces (administrators). */
  async adminList(p: Principal, filter: { publish_status?: AppPublishStatus } = {}): Promise<AdminApp[]> {
    if (!isPlatformAdmin(p)) throw forbidden('Administrator role required');
    const rows = filter.publish_status ? await this.db.select().from(this.s.dataApps).where(eq(this.s.dataApps.publish_status, filter.publish_status)) : await this.db.select().from(this.s.dataApps);
    const users = new Map((await this.db.select({ id: this.s.users.id, email: this.s.users.email }).from(this.s.users)).map((u) => [u.id, u.email]));
    const spaces = new Map((await this.db.select({ id: this.s.workspaces.id, name: this.s.workspaces.name }).from(this.s.workspaces)).map((w) => [w.id, w.name]));
    return rows
      .map((r) => {
        const { files: _f, ...pub } = this.toPublic(r);
        const proc = this.procs.get(r.id);
        return { ...pub, status: proc ? (proc.healthy ? 'running' : 'starting') : r.status, owner_email: users.get(r.user_id) ?? null, workspace_name: spaces.get(r.workspace_id) ?? null, requested_by_email: r.publish_requested_by ? users.get(r.publish_requested_by) ?? null : null, last_used_ms: proc ? Date.now() - proc.lastUsed : null } as AdminApp;
      })
      .sort((a, b) => Number(b.running) - Number(a.running) || (b.publish_requested_at?.getTime() ?? 0) - (a.publish_requested_at?.getTime() ?? 0) || b.updated_at.getTime() - a.updated_at.getTime());
  }

  runtimeInfo(): Record<string, unknown> {
    return { ...this.runtime.describe(), enabled: this.enabled, running: this.procs.size, max_running: this.cfg.apps.max_running, idle_stop_minutes: this.cfg.apps.idle_stop_minutes, evict_idle_seconds: this.cfg.apps.evict_idle_seconds, publish_requires_approval: this.cfg.apps.publish_requires_approval };
  }

  runningCount(): number {
    return this.procs.size;
  }

  async shutdown(): Promise<void> {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
    for (const id of [...this.restarts.keys()]) this.clearRestarts(id);
    await Promise.all([...this.procs.keys()].map((id) => this.stop(null, id, 'shutdown').catch(() => undefined)));
  }

  /** Apps of every workspace the caller can see (the gallery's "all" view). */
  async listAll(p: Principal): Promise<PublicApp[]> {
    const rows = await this.db.select().from(this.s.dataApps);
    const out: PublicApp[] = [];
    for (const r of rows) {
      try {
        await this.workspaces.get(p, r.workspace_id);
        out.push(this.toPublic(r));
      } catch {
        if (r.visibility === 'org' && p.actorType === 'USER') out.push(this.toPublic(r));
      }
    }
    return out.sort((a, b) => b.updated_at.getTime() - a.updated_at.getTime());
  }

  async byWorkspaceAndName(workspaceId: string, name: string): Promise<DataApp | null> {
    const rows = await this.db.select().from(this.s.dataApps).where(and(eq(this.s.dataApps.workspace_id, workspaceId), eq(this.s.dataApps.name, name))).limit(1);
    return rows[0] ?? null;
  }
}

/**
 * A Chrome / Chromium binary for headless previews. An explicit `apps.chrome_path` is authoritative (missing →
 * no browser); otherwise CHROME_PATH and the usual install locations are tried.
 */
export function findChrome(configured?: string): string | null {
  if (configured) return fs.existsSync(configured) ? configured : null;
  const candidates = [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'];
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  return null;
}
