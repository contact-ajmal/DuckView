/**
 * Data apps: Streamlit applications built on a workspace's data, registered next to dashboards and run by DuckView.
 *
 * The source lives in the metadata store and is materialised under <data>/.duckview/apps/run/<id>/ when the app
 * starts. The subprocess runtime spawns `streamlit run` from a shared virtualenv that DuckView creates on first use
 * (streamlit, pandas, pyarrow + the DuckView SDK), with a minimal environment: no server secrets, only
 * DUCKVIEW_URL / DUCKVIEW_TOKEN / DUCKVIEW_WORKSPACE, where the token is read-only, scoped to the app's workspace,
 * minted for the app's creator on every start and revoked when it stops. Health is polled on Streamlit's
 * /_stcore/health, logs are kept in a ring buffer, idle apps are stopped by a ticker, and every row is reset to
 * `stopped` when the server boots (processes do not survive it).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import type { MetadataStore } from '../db/index.js';
import type { DataApp, AppFiles, AppStatus, AppVisibility } from '../db/schema/sqlite.js';
import { APP_VISIBILITIES } from '../db/schema/sqlite.js';
import type { DuckViewConfig } from '../config/index.js';
import { newId } from '../security/crypto.js';
import type { Principal } from './principal.js';
import { requireWrite } from './principal.js';
import type { WorkspaceService } from './workspaces.js';
import type { AuthService } from './auth.js';
import type { AuditService } from './audit.js';
import { badRequest, notFound, forbidden } from './errors.js';
import type { DashboardService, SavedQueryService } from './bi.js';
import { appFromDashboard, appFromQueries } from './app-generator.js';
import { logger } from '../observability/logger.js';
import { liveEvents } from '../observability/events.js';

export type PublicApp = Omit<DataApp, 'pid'> & { url: string; source_bytes: number; running: boolean };
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
  child: ChildProcess;
  port: number;
  tokenId: string;
  ownerId: string;
  logs: string[];
  startedAt: number;
  lastUsed: number;
  healthy: boolean;
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
  private installing: Promise<void> | null = null;
  private ticker: NodeJS.Timeout | null = null;
  /** Where apps reach this server; set after listen (tests bind port 0). */
  internalUrl: string;
  /** Overridable for tests (a fake "streamlit"). */
  command: string[] | null;
  /** Signs the /apps session cookie for a user (set by the routes; used for headless previews). */
  signSession: ((userId: string) => string) | null = null;
  private bi: { dashboards: DashboardService; savedQueries: SavedQueryService } | null = null;

  constructor(private readonly store: MetadataStore, private readonly cfg: DuckViewConfig, private readonly workspaces: WorkspaceService, private readonly auth: AuthService, private readonly audit: AuditService) {
    this.internalUrl = `http://127.0.0.1:${cfg.server.port}`;
    this.command = cfg.apps.command ?? null;
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
    if (!this.ticker) {
      this.ticker = setInterval(() => void this.reapIdle().catch(() => undefined), 60_000);
      this.ticker.unref();
    }
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
    const py = fs.existsSync(this.venvPython) ? this.venvPython : this.cfg.apps.python;
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
    return { ...rest, url: `/apps/${a.id}/`, source_bytes: Object.values(a.files).reduce((n, f) => n + Buffer.byteLength(f), 0), running: this.procs.get(a.id)?.healthy === true };
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
    const row: DataApp = { id: newId(), workspace_id: workspaceId, user_id: p.userId, name, description: input.description?.trim() || null, kind: 'streamlit', entry, files, spec: input.spec ?? null, visibility: input.visibility ?? 'workspace', status: 'stopped', port: null, pid: null, last_error: null, last_started_at: null, last_used_at: null, created_at: now, updated_at: now };
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
    if (patch.visibility !== undefined) {
      if (!APP_VISIBILITIES.includes(patch.visibility)) throw badRequest(`visibility must be ${APP_VISIBILITIES.join(' or ')}`);
      set.visibility = patch.visibility;
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
    await this.stop(p, id, 'delete').catch(() => undefined);
    await this.db.delete(this.s.dataApps).where(eq(this.s.dataApps.id, id));
    fs.rmSync(this.runDir(id), { recursive: true, force: true });
    this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'app.delete', resource: `app:${id}`, ip: p.ip });
  }

  // ------------------------------------------------------------------ runtime

  private runDir(id: string): string {
    return path.join(this.cfg.security.data_jail_directory, '.duckview', 'apps', 'run', id);
  }
  private get venvPython(): string {
    return path.join(this.cfg.apps.venv_dir, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
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

  /** Reachable port for the proxy, when the app is up. */
  target(id: string): { port: number } | null {
    const proc = this.procs.get(id);
    return proc?.healthy ? { port: proc.port } : null;
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

  /** Makes sure a Python with streamlit exists (creates the virtualenv and installs on first use). */
  private async ensureRuntime(id: string): Promise<string[]> {
    if (this.command) return this.command;
    const py = this.venvPython;
    const has = (interp: string) => new Promise<boolean>((resolve) => { const c = spawn(interp, ['-c', 'import streamlit, pandas'], { stdio: 'ignore' }); c.on('error', () => resolve(false)); c.on('exit', (code) => resolve(code === 0)); });
    if (!(await has(py))) {
      if (!this.cfg.apps.auto_install) throw badRequest(`No Python with streamlit at ${py}; set apps.auto_install or create the virtualenv yourself`);
      if (!this.installing) {
        this.installing = (async () => {
          await this.setStatus(id, 'installing');
          this.log(id, `Creating the apps virtualenv at ${this.cfg.apps.venv_dir} (first run: installs streamlit, pandas, pyarrow and the DuckView SDK)`);
          fs.mkdirSync(path.dirname(this.cfg.apps.venv_dir), { recursive: true });
          if (!fs.existsSync(py)) await this.exec(id, this.cfg.apps.python, ['-m', 'venv', this.cfg.apps.venv_dir]);
          const sdk = DataAppService.sdkDir();
          await this.exec(id, py, ['-m', 'pip', 'install', '--disable-pip-version-check', '--quiet', 'streamlit>=1.46', 'pandas', 'pyarrow', ...(sdk ? [sdk] : [])]);
          if (!(await has(py))) throw new Error('streamlit is still not importable after the install — see the app log');
        })().finally(() => { this.installing = null; });
      } else this.log(id, 'Waiting for the apps virtualenv being prepared by another app…');
      await this.installing;
    }
    return [py, '-m', 'streamlit', 'run'];
  }

  private exec(id: string, cmd: string, args: string[], cwd?: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.log(id, `$ ${path.basename(cmd)} ${args.join(' ')}`);
      const c = spawn(cmd, args, { cwd, env: this.childEnv(id, null, null), stdio: ['ignore', 'pipe', 'pipe'] });
      c.stdout?.on('data', (d) => this.log(id, String(d)));
      c.stderr?.on('data', (d) => this.log(id, String(d)));
      c.on('error', (err) => reject(new Error(`${cmd}: ${err.message}`)));
      c.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(cmd)} ${args[0] ?? ''} exited with ${code}`))));
    });
  }

  /** The app's environment: no server secrets, only what the SDK needs. */
  private childEnv(id: string, token: string | null, workspaceId: string | null): NodeJS.ProcessEnv {
    const sdk = DataAppService.sdkDir();
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: this.runDir(id), LANG: process.env.LANG ?? 'C.UTF-8', PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1', DUCKVIEW_APP_ID: id, STREAMLIT_BROWSER_GATHER_USAGE_STATS: 'false', STREAMLIT_SERVER_HEADLESS: 'true' };
    if (sdk) env.PYTHONPATH = sdk;
    if (process.env.SYSTEMROOT) env.SYSTEMROOT = process.env.SYSTEMROOT;
    if (token) env.DUCKVIEW_TOKEN = token;
    if (workspaceId) env.DUCKVIEW_WORKSPACE = workspaceId;
    env.DUCKVIEW_URL = this.internalUrl;
    return env;
  }

  private async freePort(): Promise<number> {
    const [lo, hi] = this.cfg.apps.port_range;
    const used = new Set([...this.procs.values()].map((p) => p.port));
    for (let port = lo; port <= hi; port++) {
      if (used.has(port)) continue;
      const free = await new Promise<boolean>((resolve) => { const srv = net.createServer(); srv.once('error', () => resolve(false)); srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true))); });
      if (free) return port;
    }
    throw badRequest(`No free port in apps.port_range ${lo}-${hi}`);
  }

  /** Starts the app (viewers may: the code belongs to the workspace). Resolves once Streamlit answers its health check. */
  async start(p: Principal, id: string): Promise<PublicApp> {
    if (!this.enabled) throw forbidden('Data apps are disabled on this server (apps.enabled)');
    const app = await this.get(p, id);
    if (this.procs.has(id)) return this.toPublic({ ...app, status: this.status(id) ?? 'starting' });
    if (this.procs.size >= this.cfg.apps.max_running) throw badRequest(`${this.cfg.apps.max_running} apps are already running (apps.max_running) — stop one first`);
    const owner = await this.auth.findById(app.user_id);
    if (!owner) throw badRequest('The app\'s creator no longer exists');
    this.lastLogs.set(id, []);
    try {
      const command = await this.ensureRuntime(id);
      const dir = this.runDir(id);
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      for (const [name, content] of Object.entries(app.files)) {
        const target = path.join(dir, name);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
      }
      fs.mkdirSync(path.join(dir, '.streamlit'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.streamlit', 'config.toml'), '[browser]\ngatherUsageStats = false\n[server]\nheadless = true\n[client]\ntoolbarMode = "minimal"\n');
      if (app.files['requirements.txt']?.trim() && !this.command) {
        if (!this.cfg.apps.allow_requirements) throw badRequest('requirements.txt is not allowed on this server (apps.allow_requirements)');
        await this.setStatus(id, 'installing');
        await this.exec(id, this.venvPython, ['-m', 'pip', 'install', '--disable-pip-version-check', '--quiet', '-r', 'requirements.txt'], dir);
      }
      const port = await this.freePort();
      const minted = await this.auth.createToken(owner, { name: `app:${app.name}`, scopes: ['read'], workspaceId: app.workspace_id, expiresAt: new Date(Date.now() + this.cfg.apps.token_ttl_hours * 3_600_000) });
      const args = [...command.slice(1), app.entry, '--server.headless=true', `--server.port=${port}`, '--server.address=127.0.0.1', `--server.baseUrlPath=/apps/${id}`, '--browser.gatherUsageStats=false', '--server.enableXsrfProtection=false', '--server.enableCORS=false', '--server.fileWatcherType=none', '--client.toolbarMode=minimal'];
      this.log(id, `$ ${path.basename(command[0]!)} ${args.join(' ')}`);
      const child = spawn(command[0]!, args, { cwd: dir, env: this.childEnv(id, minted.token, app.workspace_id), stdio: ['ignore', 'pipe', 'pipe'] });
      const proc: Proc = { child, port, tokenId: minted.record.id, ownerId: owner.id, logs: this.lastLogs.get(id) ?? [], startedAt: Date.now(), lastUsed: Date.now(), healthy: false };
      this.procs.set(id, proc);
      this.lastLogs.delete(id);
      child.stdout?.on('data', (d) => this.log(id, String(d)));
      child.stderr?.on('data', (d) => this.log(id, String(d)));
      child.on('error', (err) => this.log(id, `process error: ${err.message}`));
      child.on('exit', (code, signal) => {
        this.log(id, `process exited (${code ?? signal})`);
        const current = this.procs.get(id);
        if (current === proc) {
          this.procs.delete(id);
          this.lastLogs.set(id, proc.logs);
          void this.auth.revokeToken(owner.id, minted.record.id).catch(() => undefined);
          void this.setStatus(id, code === 0 || signal ? 'stopped' : 'error', { port: null, pid: null, last_error: code === 0 || signal ? null : `exited with ${code}: ${proc.logs.slice(-3).join(' · ').slice(0, 500)}` });
        }
      });
      await this.setStatus(id, 'starting', { port, pid: child.pid ?? null, last_started_at: new Date(), last_error: null });
      await this.waitHealthy(id, proc);
      proc.healthy = true;
      await this.setStatus(id, 'running', { last_used_at: new Date() });
      this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'app.start', resource: `app:${id}`, ip: p.ip });
      return this.toPublic({ ...app, status: 'running', port, last_started_at: new Date() });
    } catch (err) {
      const message = ((err as Error).message ?? String(err)).split('\n')[0]!.slice(0, 500);
      this.log(id, `start failed: ${message}`);
      const proc = this.procs.get(id);
      if (proc) {
        proc.child.kill('SIGTERM');
        this.procs.delete(id);
        this.lastLogs.set(id, proc.logs);
        await this.auth.revokeToken(proc.ownerId, proc.tokenId).catch(() => undefined);
      }
      await this.setStatus(id, 'error', { port: null, pid: null, last_error: message });
      throw err instanceof Error && 'statusCode' in err ? err : badRequest(message);
    }
  }

  private async waitHealthy(id: string, proc: Proc): Promise<void> {
    const deadline = Date.now() + this.cfg.apps.start_timeout_seconds * 1000;
    while (Date.now() < deadline) {
      if (proc.child.exitCode !== null) throw new Error(`the app exited before it was ready: ${proc.logs.slice(-3).join(' · ')}`);
      try {
        const res = await fetch(`http://127.0.0.1:${proc.port}/apps/${id}/_stcore/health`, { signal: AbortSignal.timeout(2000) });
        if (res.ok) return;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    throw new Error(`the app did not answer its health check within ${this.cfg.apps.start_timeout_seconds} s`);
  }

  async stop(p: Principal | null, id: string, reason: 'manual' | 'idle' | 'restart' | 'delete' | 'shutdown' = 'manual'): Promise<void> {
    const proc = this.procs.get(id);
    if (!proc) {
      if (p) await this.get(p, id);
      await this.setStatus(id, 'stopped', { port: null, pid: null });
      return;
    }
    this.procs.delete(id);
    this.lastLogs.set(id, proc.logs);
    this.log(id, `stopping (${reason})`);
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => { proc.child.kill('SIGKILL'); resolve(); }, 5000);
      proc.child.once('exit', () => { clearTimeout(t); resolve(); });
      proc.child.kill('SIGTERM');
    });
    await this.auth.revokeToken(proc.ownerId, proc.tokenId).catch(() => undefined);
    await this.setStatus(id, 'stopped', { port: null, pid: null });
    if (p) this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'app.stop', resource: `app:${id}`, ip: p.ip });
  }

  async reapIdle(now = Date.now()): Promise<string[]> {
    const stopped: string[] = [];
    for (const [id, proc] of this.procs) {
      if (now - proc.lastUsed > this.cfg.apps.idle_stop_minutes * 60_000) {
        await this.stop(null, id, 'idle');
        stopped.push(id);
      }
    }
    return stopped;
  }

  runningCount(): number {
    return this.procs.size;
  }

  async shutdown(): Promise<void> {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
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
