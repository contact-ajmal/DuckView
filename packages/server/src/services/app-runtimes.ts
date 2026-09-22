/**
 * Where data apps run. Every runtime turns the same launch spec (files, entry, the app's environment, the proxy's
 * base path) into an instance DuckView can reach over HTTP, watch for its exit, and stop:
 *
 * - `subprocess`: `streamlit run` from a shared virtualenv next to the server (created on first use).
 * - `docker`: one container per app from the app-runtime image, hardened (read-only root, no capabilities, no new
 *   privileges, pid / memory / CPU limits, non-root). The source is streamed in as a tar on stdin, the token is
 *   passed by name (`-e DUCKVIEW_TOKEN`) so it never appears in a process list.
 * - `kubernetes`: one Pod per app through the API server; the source is a ConfigMap, the token a Secret, both
 *   labelled and deleted with the pod. DuckView reaches the pod on its IP (see k8s/apps-rbac.yaml for the role and
 *   the NetworkPolicy).
 *
 * Nothing here knows about users or tokens beyond the environment it is handed.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import type { DuckViewConfig } from '../config/index.js';
import type { AppFiles, AppKind } from '../db/schema/sqlite.js';
import { framework } from './app-frameworks.js';
export { streamlitFlags } from './app-frameworks.js';
import { badRequest } from './errors.js';

export type RuntimeName = DuckViewConfig['apps']['runtime'];

export interface LaunchSpec {
  id: string;
  name: string;
  /** The framework (streamlit, dash, gradio): how the app is started and where it answers. */
  kind: AppKind;
  files: AppFiles;
  entry: string;
  /** What the SDK needs (DUCKVIEW_URL is rewritten per runtime, DUCKVIEW_TOKEN is kept out of argv and pod specs). */
  env: Record<string, string>;
  /** The proxy's prefix, /apps/<id>. */
  baseUrlPath: string;
  log(line: string): void;
  /** Called before a long install step (first virtualenv, requirements). */
  installing(): Promise<void>;
}

export interface Exit {
  code: number | null;
  signal: string | null;
}

export interface Instance {
  host: string;
  port: number;
  /** OS pid for subprocesses; null for containers and pods. */
  pid: number | null;
  /** Container or pod name, or the pid — for logs and the admin view. */
  ref: string;
  exited: Promise<Exit>;
  /** Set once the instance is gone. */
  exit: Exit | null;
  stop(): Promise<void>;
}

export interface AppRuntime {
  readonly name: RuntimeName;
  launch(spec: LaunchSpec): Promise<Instance>;
  /** Removes what a previous server process left behind (containers, pods). */
  cleanup(): Promise<number>;
  /** Shown to admins and in /api/apps/templates. */
  describe(): Record<string, unknown>;
}

/**
 * The container entry: materialise the source (a ConfigMap mounted at /app-src, or a tar on stdin), install
 * requirements.txt into the user site when allowed, then exec the app command.
 */
export const CONTAINER_LAUNCH = [
  'set -e',
  'if [ -d /app-src ]; then cd /app-src; else mkdir -p /tmp/app && tar -xf - -C /tmp/app && cd /tmp/app; fi',
  'if [ -s requirements.txt ]; then if [ "$DV_REQUIREMENTS" = 1 ]; then echo "Installing requirements.txt"; python -m pip install --user --quiet --disable-pip-version-check --no-warn-script-location -r requirements.txt; else echo "requirements.txt ignored (not allowed on this server)"; fi; fi',
  'exec "$@"',
].join('\n');

/** A free TCP port on 127.0.0.1 within the configured range. */
export async function freePort(range: [number, number], used: Set<number>): Promise<number> {
  const [lo, hi] = range;
  for (let port = lo; port <= hi; port++) {
    if (used.has(port)) continue;
    const free = await new Promise<boolean>((resolve) => {
      const srv = net.createServer();
      srv.once('error', () => resolve(false));
      srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
    });
    if (free) return port;
  }
  throw badRequest(`No free port in apps.port_range ${lo}-${hi}`);
}

/** A minimal ustar archive of text files (the Docker runtime streams it to the container). */
export function tarFiles(files: AppFiles): Buffer {
  const blocks: Buffer[] = [];
  const dirs = new Set<string>();
  const header = (name: string, size: number, type: '0' | '5') => {
    const h = Buffer.alloc(512);
    let prefix = '';
    let short = name;
    if (Buffer.byteLength(name) > 100) {
      const cut = name.lastIndexOf('/', 154);
      if (cut <= 0 || Buffer.byteLength(name.slice(cut + 1)) > 100) throw badRequest(`File name too long for the container: ${name}`);
      prefix = name.slice(0, cut);
      short = name.slice(cut + 1);
    }
    h.write(short, 0, 100);
    h.write(type === '5' ? '0000755\0' : '0000644\0', 100);
    h.write('0001751\0', 108); // uid 1001
    h.write('0001751\0', 116); // gid 1001
    h.write(size.toString(8).padStart(11, '0') + '\0', 124);
    h.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136);
    h.write('        ', 148);
    h.write(type, 156);
    h.write('ustar\0', 257);
    h.write('00', 263);
    h.write(prefix, 345, 155);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    return h;
  };
  for (const [name, content] of Object.entries(files)) {
    const parts = name.split('/');
    for (let i = 1; i < parts.length; i++) {
      const d = parts.slice(0, i).join('/') + '/';
      if (!dirs.has(d)) {
        dirs.add(d);
        blocks.push(header(d, 0, '5'));
      }
    }
    const body = Buffer.from(content, 'utf8');
    blocks.push(header(name, body.length, '0'), body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

/** "1Gi" / "512Mi" (Kubernetes) → "1g" / "512m" (Docker). */
export function dockerMemory(v: string): string {
  const m = /^(\d+(?:\.\d+)?)\s*(Ki|Mi|Gi|Ti|K|M|G|T|k|m|g|t)?i?$/.exec(v.trim());
  if (!m) return v;
  const unit = (m[2] ?? '').replace('i', '').toLowerCase();
  return `${m[1]}${unit === '' ? 'b' : unit}`;
}

/** Labels that tie containers and pods to this server (so a restart cleans up its own leftovers only). */
export function serverLabel(cfg: DuckViewConfig): string {
  return crypto.createHash('sha1').update(`${cfg.security.data_jail_directory}:${cfg.server.port}`).digest('hex').slice(0, 16);
}

function watchChild(child: ChildProcess): { exited: Promise<Exit>; state: { exit: Exit | null } } {
  const state: { exit: Exit | null } = { exit: null };
  const exited = new Promise<Exit>((resolve) => {
    child.once('exit', (code, signal) => {
      state.exit = { code, signal };
      resolve(state.exit);
    });
    child.once('error', () => {
      if (!state.exit) {
        state.exit = { code: -1, signal: null };
        resolve(state.exit);
      }
    });
  });
  return { exited, state };
}

function pipeLines(child: ChildProcess, log: (l: string) => void) {
  child.stdout?.on('data', (d) => log(String(d)));
  child.stderr?.on('data', (d) => log(String(d)));
}

// ============================================================================ subprocess

export class SubprocessRuntime implements AppRuntime {
  readonly name = 'subprocess' as const;
  private installingVenv: Promise<void> | null = null;

  constructor(private readonly cfg: DuckViewConfig, private readonly opts: { command: () => string[] | null; sdkDir: () => string | null; usedPorts: () => Set<number>; runDir: (id: string) => string }) {}

  static venvPython(cfg: DuckViewConfig): string {
    return path.join(cfg.apps.venv_dir, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  }

  describe() {
    return { runtime: this.name, venv: this.cfg.apps.venv_dir, python: this.cfg.apps.python };
  }

  async cleanup(): Promise<number> {
    return 0; // children die with the server
  }

  private env(spec: LaunchSpec | { id: string; env: Record<string, string> }): NodeJS.ProcessEnv {
    const sdk = this.opts.sdkDir();
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: this.opts.runDir(spec.id), LANG: process.env.LANG ?? 'C.UTF-8', PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1', STREAMLIT_BROWSER_GATHER_USAGE_STATS: 'false', STREAMLIT_SERVER_HEADLESS: 'true', ...spec.env };
    if (sdk) env.PYTHONPATH = sdk;
    if (process.env.SYSTEMROOT) env.SYSTEMROOT = process.env.SYSTEMROOT;
    return env;
  }

  private exec(spec: LaunchSpec, cmd: string, args: string[], cwd?: string): Promise<void> {
    return new Promise((resolve, reject) => {
      spec.log(`$ ${path.basename(cmd)} ${args.join(' ')}`);
      const c = spawn(cmd, args, { cwd, env: this.env({ id: spec.id, env: {} }), stdio: ['ignore', 'pipe', 'pipe'] });
      pipeLines(c, spec.log);
      c.on('error', (err) => reject(new Error(`${cmd}: ${err.message}`)));
      c.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(cmd)} ${args[0] ?? ''} exited with ${code}`))));
    });
  }

  /** Makes sure a Python with streamlit exists (creates the virtualenv and installs on first use), plus the app's framework. */
  private async ensureVenv(spec: LaunchSpec): Promise<string[]> {
    const override = this.opts.command();
    if (override) return override;
    const py = SubprocessRuntime.venvPython(this.cfg);
    await this.ensureStreamlit(spec, py);
    const fw = framework(spec.kind);
    if (fw.id !== 'streamlit') {
      const mod = fw.id;
      const has = await new Promise<boolean>((resolve) => { const c = spawn(py, ['-c', `import ${mod}`], { stdio: 'ignore' }); c.on('error', () => resolve(false)); c.on('exit', (code) => resolve(code === 0)); });
      if (!has) {
        if (!this.cfg.apps.auto_install) throw badRequest(`${fw.label} is not installed in ${this.cfg.apps.venv_dir}; set apps.auto_install or install ${fw.packages.join(' ')} yourself`);
        await spec.installing();
        spec.log(`First ${fw.label} app: installing ${fw.packages.join(' ')} into the apps virtualenv`);
        await this.exec(spec, py, ['-m', 'pip', 'install', '--disable-pip-version-check', '--quiet', ...fw.packages]);
      }
      return [py];
    }
    return [py, '-m', 'streamlit', 'run'];
  }

  private async ensureStreamlit(spec: LaunchSpec, py: string): Promise<void> {
    const has = (interp: string) => new Promise<boolean>((resolve) => { const c = spawn(interp, ['-c', 'import streamlit, pandas'], { stdio: 'ignore' }); c.on('error', () => resolve(false)); c.on('exit', (code) => resolve(code === 0)); });
    if (!(await has(py))) {
      if (!this.cfg.apps.auto_install) throw badRequest(`No Python with streamlit at ${py}; set apps.auto_install or create the virtualenv yourself`);
      if (!this.installingVenv) {
        this.installingVenv = (async () => {
          await spec.installing();
          spec.log(`Creating the apps virtualenv at ${this.cfg.apps.venv_dir} (first run: installs streamlit, pandas, pyarrow and the DuckView SDK)`);
          fs.mkdirSync(path.dirname(this.cfg.apps.venv_dir), { recursive: true });
          if (!fs.existsSync(py)) await this.exec(spec, this.cfg.apps.python, ['-m', 'venv', this.cfg.apps.venv_dir]);
          const sdk = this.opts.sdkDir();
          await this.exec(spec, py, ['-m', 'pip', 'install', '--disable-pip-version-check', '--quiet', 'streamlit>=1.46', 'pandas', 'pyarrow', ...(sdk ? [sdk] : [])]);
          if (!(await has(py))) throw new Error('streamlit is still not importable after the install — see the app log');
        })().finally(() => { this.installingVenv = null; });
      } else spec.log('Waiting for the apps virtualenv being prepared by another app…');
      await this.installingVenv;
    }
  }

  async launch(spec: LaunchSpec): Promise<Instance> {
    const command = await this.ensureVenv(spec);
    const dir = this.opts.runDir(spec.id);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(spec.files)) {
      const target = path.join(dir, name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    }
    fs.mkdirSync(path.join(dir, '.streamlit'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.streamlit', 'config.toml'), '[browser]\ngatherUsageStats = false\n[server]\nheadless = true\n[client]\ntoolbarMode = "minimal"\n');
    if (spec.files['requirements.txt']?.trim() && !this.opts.command()) {
      if (!this.cfg.apps.allow_requirements) throw badRequest('requirements.txt is not allowed on this server (apps.allow_requirements)');
      await spec.installing();
      await this.exec(spec, SubprocessRuntime.venvPython(this.cfg), ['-m', 'pip', 'install', '--disable-pip-version-check', '--quiet', '-r', 'requirements.txt'], dir);
    }
    const port = await freePort(this.cfg.apps.port_range, this.opts.usedPorts());
    const run = framework(spec.kind).launch(spec.entry, '127.0.0.1', port, spec.baseUrlPath);
    const args = [...command.slice(1), ...run.args];
    spec.log(`$ ${path.basename(command[0]!)} ${args.join(' ')}`);
    const child = spawn(command[0]!, args, { cwd: dir, env: { ...this.env(spec), ...run.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    pipeLines(child, spec.log);
    child.on('error', (err) => spec.log(`process error: ${err.message}`));
    const { exited, state } = watchChild(child);
    return {
      host: '127.0.0.1',
      port,
      pid: child.pid ?? null,
      ref: `pid ${child.pid ?? '?'}`,
      exited,
      get exit() {
        return state.exit;
      },
      async stop() {
        if (state.exit) return;
        child.kill('SIGTERM');
        await Promise.race([exited, new Promise<void>((r) => setTimeout(() => { child.kill('SIGKILL'); r(); }, 5000))]);
      },
    };
  }
}

// ============================================================================ docker

export class DockerRuntime implements AppRuntime {
  readonly name = 'docker' as const;
  private readonly label: string;

  constructor(private readonly cfg: DuckViewConfig, private readonly opts: { usedPorts: () => Set<number>; internalPort: () => number }) {
    this.label = serverLabel(cfg);
  }

  private get d() {
    return this.cfg.apps.docker;
  }

  describe() {
    return { runtime: this.name, image: this.d.image, network: this.d.network ?? null, duckview_url: this.duckviewUrl(), cpu: this.cfg.apps.resources.cpu, memory: this.cfg.apps.resources.memory };
  }

  duckviewUrl(): string {
    return this.d.duckview_url ?? (this.d.network ? `http://duckview:${this.cfg.server.port}` : `http://host.docker.internal:${this.opts.internalPort()}`);
  }

  /** Runs the docker CLI to completion. */
  private cli(args: string[], timeoutMs = 30_000): Promise<{ code: number | null; out: string }> {
    return new Promise((resolve) => {
      const c = spawn(this.d.binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      c.stdout?.on('data', (d) => (out += d));
      c.stderr?.on('data', (d) => (out += d));
      const t = setTimeout(() => c.kill('SIGKILL'), timeoutMs);
      c.on('error', (e) => { clearTimeout(t); resolve({ code: -1, out: e.message }); });
      c.on('exit', (code) => { clearTimeout(t); resolve({ code, out }); });
    });
  }

  async cleanup(): Promise<number> {
    const r = await this.cli(['ps', '-aq', '--filter', `label=duckview.server=${this.label}`]);
    const ids = r.code === 0 ? r.out.split(/\s+/).filter(Boolean) : [];
    if (ids.length) await this.cli(['rm', '-f', ...ids]);
    return ids.length;
  }

  async launch(spec: LaunchSpec): Promise<Instance> {
    const name = `dv-app-${spec.id}`;
    await this.cli(['rm', '-f', name]); // a leftover with the same name
    const containerPort = 8501;
    const hostPort = this.d.network ? null : await freePort(this.cfg.apps.port_range, this.opts.usedPorts());
    const run = framework(spec.kind).launch(spec.entry, '0.0.0.0', containerPort, spec.baseUrlPath);
    const env: Record<string, string> = { ...spec.env, ...run.env, DUCKVIEW_URL: this.duckviewUrl(), HOME: '/tmp', PYTHONUSERBASE: '/tmp/.local', PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1', STREAMLIT_BROWSER_GATHER_USAGE_STATS: 'false', DV_REQUIREMENTS: this.d.allow_requirements ? '1' : '0' };
    const args = ['run', '--rm', '-i', '--name', name, '--label', `duckview.app=${spec.id}`, '--label', `duckview.server=${this.label}`, '--read-only', '--tmpfs', '/tmp:rw,exec,size=1g,uid=1001,gid=1001', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', String(this.d.pids_limit), '--memory', dockerMemory(this.cfg.apps.resources.memory), '--cpus', this.cfg.apps.resources.cpu, '--user', '1001:1001'];
    if (this.d.network) args.push('--network', this.d.network);
    else args.push('-p', `127.0.0.1:${hostPort}:${containerPort}`, '--add-host', 'host.docker.internal:host-gateway');
    // Values travel in the CLI's environment, only names on the command line.
    for (const k of Object.keys(env)) args.push('-e', k);
    const argv = [...(spec.kind === 'streamlit' ? this.d.command : ['python']), ...run.args];
    args.push('--entrypoint', 'sh', this.d.image, '-c', CONTAINER_LAUNCH, 'sh', ...argv);
    spec.log(`$ docker run … --name ${name} ${this.d.image} ${argv.slice(0, spec.kind === 'streamlit' ? this.d.command.length + 1 : 2).join(' ')}${hostPort ? ` (127.0.0.1:${hostPort} → ${containerPort})` : ` (network ${this.d.network})`}`);
    const child = spawn(this.d.binary, args, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    pipeLines(child, spec.log);
    child.on('error', (err) => spec.log(`docker: ${err.message}`));
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(tarFiles(spec.files));
    const { exited, state } = watchChild(child);
    const cli = this.cli.bind(this);
    return {
      host: this.d.network ? name : '127.0.0.1',
      port: hostPort ?? containerPort,
      pid: null,
      ref: name,
      exited,
      get exit() {
        return state.exit;
      },
      async stop() {
        if (state.exit) return;
        await cli(['stop', '-t', '5', name], 20_000);
        await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
        if (!state.exit) child.kill('SIGKILL');
        await cli(['rm', '-f', name]);
      },
    };
  }
}

// ============================================================================ kubernetes

interface KubeResponse {
  status: number;
  json: Record<string, unknown> & { message?: string };
}

export class KubernetesRuntime implements AppRuntime {
  readonly name = 'kubernetes' as const;
  private readonly label: string;
  readonly namespace: string;
  private readonly apiUrl: URL;
  private ca: Buffer | undefined;

  constructor(private readonly cfg: DuckViewConfig) {
    this.label = serverLabel(cfg);
    const k = cfg.apps.kubernetes;
    const nsFile = path.join(path.dirname(k.token_file), 'namespace');
    this.namespace = k.namespace ?? (fs.existsSync(nsFile) ? fs.readFileSync(nsFile, 'utf8').trim() : 'duckview');
    const envHost = process.env.KUBERNETES_SERVICE_HOST;
    this.apiUrl = new URL(k.api_url ?? (envHost ? `https://${envHost.includes(':') ? `[${envHost}]` : envHost}:${process.env.KUBERNETES_SERVICE_PORT ?? 443}` : 'https://kubernetes.default.svc'));
    if (fs.existsSync(k.ca_file)) this.ca = fs.readFileSync(k.ca_file);
  }

  private get k() {
    return this.cfg.apps.kubernetes;
  }

  describe() {
    return { runtime: this.name, api_url: this.apiUrl.origin, namespace: this.namespace, image: this.k.image, duckview_url: this.duckviewUrl(), cpu: this.cfg.apps.resources.cpu, memory: this.cfg.apps.resources.memory };
  }

  duckviewUrl(): string {
    return this.k.duckview_url ?? `http://duckview.${this.namespace}.svc`; // the k8s/service.yaml Service (port 80)
  }

  private headers(contentType?: string): Record<string, string> {
    const h: Record<string, string> = { accept: 'application/json' };
    if (contentType) h['content-type'] = contentType;
    // Bound service-account tokens rotate: read the file on every call.
    if (fs.existsSync(this.k.token_file)) h.authorization = `Bearer ${fs.readFileSync(this.k.token_file, 'utf8').trim()}`;
    return h;
  }

  private raw(method: string, p: string, body?: unknown, contentType = 'application/json'): Promise<http.IncomingMessage> {
    const url = new URL(p, this.apiUrl);
    const lib = url.protocol === 'https:' ? https : http;
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const req = lib.request(url, { method, headers: { ...this.headers(payload ? contentType : undefined), ...(payload ? { 'content-length': String(payload.length) } : {}) }, ...(this.ca ? { ca: this.ca } : {}), timeout: 15_000 }, resolve);
      req.on('timeout', () => req.destroy(new Error(`Kubernetes API ${method} ${url.pathname} timed out`)));
      req.on('error', reject);
      req.end(payload);
    });
  }

  async request(method: string, p: string, body?: unknown, contentType?: string): Promise<KubeResponse> {
    const res = await this.raw(method, p, body, contentType);
    const chunks: Buffer[] = [];
    for await (const c of res) chunks.push(c as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    let json: KubeResponse['json'] = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { message: text.slice(0, 300) };
    }
    return { status: res.statusCode ?? 0, json };
  }

  private async must(method: string, p: string, body?: unknown, contentType?: string): Promise<KubeResponse['json']> {
    const r = await this.request(method, p, body, contentType);
    if (r.status >= 300) throw new Error(`Kubernetes ${method} ${p.split('?')[0]} → ${r.status}: ${r.json.message ?? 'error'}${r.status === 403 ? ' (does the DuckView service account have the apps role? see k8s/apps-rbac.yaml)' : ''}`);
    return r.json;
  }

  private ns(kind: 'pods' | 'configmaps' | 'secrets', name?: string): string {
    return `/api/v1/namespaces/${encodeURIComponent(this.namespace)}/${kind}${name ? `/${encodeURIComponent(name)}` : ''}`;
  }

  async cleanup(): Promise<number> {
    const selector = encodeURIComponent(`duckview.io/server=${this.label}`);
    let n = 0;
    for (const kind of ['pods', 'configmaps', 'secrets'] as const) {
      const r = await this.request('GET', `${this.ns(kind)}?labelSelector=${selector}`).catch(() => null);
      const items = (r?.json.items as { metadata: { name: string } }[] | undefined) ?? [];
      for (const it of items) {
        await this.request('DELETE', this.ns(kind, it.metadata.name)).catch(() => undefined);
        if (kind === 'pods') n++;
      }
    }
    return n;
  }

  private async removeAll(name: string): Promise<void> {
    for (const kind of ['pods', 'configmaps', 'secrets'] as const) await this.request('DELETE', `${this.ns(kind, name)}${kind === 'pods' ? '?gracePeriodSeconds=5' : ''}`).catch(() => undefined);
  }

  async launch(spec: LaunchSpec): Promise<Instance> {
    const name = `dv-app-${spec.id}`.toLowerCase().slice(0, 63);
    const labels = { 'app.kubernetes.io/name': 'duckview-app', 'app.kubernetes.io/managed-by': 'duckview', 'duckview.io/app': spec.id, 'duckview.io/server': this.label, ...(this.k.labels ?? {}) };
    const port = this.k.container_port;
    // A previous pod of the same app must be gone before its name can be reused.
    await this.removeAll(name);
    for (let i = 0; i < 60; i++) {
      const r = await this.request('GET', this.ns('pods', name));
      if (r.status === 404) break;
      await new Promise((res) => setTimeout(res, 500));
    }
    const { DUCKVIEW_TOKEN: token, ...plain } = spec.env;
    const run = framework(spec.kind).launch(spec.entry, '0.0.0.0', port, spec.baseUrlPath);
    const env = { ...plain, ...run.env, DUCKVIEW_URL: this.duckviewUrl(), HOME: '/tmp', PYTHONUSERBASE: '/tmp/.local', PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1', STREAMLIT_BROWSER_GATHER_USAGE_STATS: 'false', DV_REQUIREMENTS: this.k.allow_requirements ? '1' : '0' };
    const entries = Object.entries(spec.files);
    const meta = { name, namespace: this.namespace, labels };
    await this.must('POST', this.ns('secrets'), { apiVersion: 'v1', kind: 'Secret', metadata: meta, type: 'Opaque', stringData: token ? { DUCKVIEW_TOKEN: token } : {} });
    await this.must('POST', this.ns('configmaps'), { apiVersion: 'v1', kind: 'ConfigMap', metadata: meta, data: Object.fromEntries(entries.map(([, content], i) => [`f${i}`, content])) });
    const pod = {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: { ...meta, annotations: { 'duckview.io/app-name': spec.name.slice(0, 200) } },
      spec: {
        restartPolicy: 'Never',
        automountServiceAccountToken: false,
        enableServiceLinks: false,
        terminationGracePeriodSeconds: 5,
        securityContext: { runAsNonRoot: true, runAsUser: 1001, runAsGroup: 1001, fsGroup: 1001, seccompProfile: { type: 'RuntimeDefault' } },
        ...(this.k.node_selector ? { nodeSelector: this.k.node_selector } : {}),
        containers: [
          {
            name: 'app',
            image: this.k.image,
            imagePullPolicy: this.k.image_pull_policy,
            command: ['sh', '-c', CONTAINER_LAUNCH, 'sh'],
            args: [...(spec.kind === 'streamlit' ? this.k.command : ['python']), ...run.args],
            ports: [{ name: 'http', containerPort: port }],
            env: Object.entries(env).map(([k, value]) => ({ name: k, value })),
            envFrom: [{ secretRef: { name } }],
            resources: { requests: { cpu: '100m', memory: '256Mi' }, limits: { cpu: this.cfg.apps.resources.cpu, memory: this.cfg.apps.resources.memory } },
            securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } },
            volumeMounts: [{ name: 'src', mountPath: '/app-src', readOnly: true }, { name: 'tmp', mountPath: '/tmp' }],
          },
        ],
        volumes: [{ name: 'src', configMap: { name, items: entries.map(([file], i) => ({ key: `f${i}`, path: file })) } }, { name: 'tmp', emptyDir: { sizeLimit: '1Gi' } }],
      },
    };
    spec.log(`Creating pod ${this.namespace}/${name} (${this.k.image})`);
    let created: { metadata?: { uid?: string } };
    try {
      created = (await this.must('POST', this.ns('pods'), pod)) as typeof created;
    } catch (err) {
      await this.removeAll(name);
      throw err;
    }
    // The ConfigMap and Secret belong to the pod: deleting it (by anyone) takes them along.
    const owner = { ownerReferences: [{ apiVersion: 'v1', kind: 'Pod', name, uid: created.metadata?.uid, blockOwnerDeletion: false }] };
    if (created.metadata?.uid) for (const kind of ['configmaps', 'secrets'] as const) await this.request('PATCH', this.ns(kind, name), { metadata: owner }, 'application/merge-patch+json').catch(() => undefined);

    const state: { exit: Exit | null } = { exit: null };
    let resolveExit!: (e: Exit) => void;
    const exited = new Promise<Exit>((r) => (resolveExit = r));
    const finish = (e: Exit) => {
      if (state.exit) return;
      state.exit = e;
      clearInterval(poll);
      resolveExit(e);
    };
    type PodStatus = { phase?: string; podIP?: string; containerStatuses?: { state?: { running?: object; waiting?: { reason?: string; message?: string }; terminated?: { exitCode?: number; reason?: string } } }[] };
    const read = async (): Promise<PodStatus | null> => {
      const r = await this.request('GET', this.ns('pods', name));
      if (r.status === 404) return null;
      return (r.json.status as PodStatus | undefined) ?? {};
    };
    let lastPhase = '';
    const poll = setInterval(() => {
      void read().then((s) => {
        if (!s) return finish({ code: null, signal: 'deleted' });
        const t = s.containerStatuses?.[0]?.state?.terminated;
        if (t || s.phase === 'Failed' || s.phase === 'Succeeded') finish({ code: t?.exitCode ?? (s.phase === 'Succeeded' ? 0 : 1), signal: null });
      }).catch(() => undefined);
    }, 2000);
    poll.unref();

    // Wait until the container runs and the pod has an address.
    let ip: string | null = null;
    const deadline = Date.now() + this.cfg.apps.start_timeout_seconds * 1000;
    try {
      while (Date.now() < deadline && !state.exit) {
        const s = await read();
        if (!s) throw new Error('the pod was deleted while starting');
        if (s.phase && s.phase !== lastPhase) {
          lastPhase = s.phase;
          spec.log(`pod ${name}: ${s.phase}`);
        }
        const cs = s.containerStatuses?.[0]?.state;
        const bad = cs?.waiting?.reason && /ErrImagePull|ImagePullBackOff|InvalidImageName|CreateContainerConfigError|CreateContainerError/.test(cs.waiting.reason) ? cs.waiting : null;
        if (bad) throw new Error(`${bad.reason}: ${bad.message ?? ''}`.trim());
        if (cs?.terminated) throw new Error(`the container exited (${cs.terminated.reason ?? cs.terminated.exitCode})`);
        if (cs?.running && s.podIP) {
          ip = s.podIP;
          break;
        }
        await new Promise((r) => setTimeout(r, 700));
      }
      if (!ip) throw new Error(state.exit ? 'the pod exited while starting' : `the pod was not running within ${this.cfg.apps.start_timeout_seconds} s`);
    } catch (err) {
      clearInterval(poll);
      await this.removeAll(name);
      throw err;
    }

    // Follow the container's log until the pod goes away.
    void (async () => {
      try {
        const res = await this.raw('GET', `${this.ns('pods', name)}/log?container=app&follow=true`);
        let buf = '';
        for await (const chunk of res) {
          buf += String(chunk);
          const lines = buf.split('\n');
          buf = lines.pop() ?? '';
          for (const l of lines) spec.log(l);
        }
        if (buf) spec.log(buf);
      } catch {
        /* the log stream ends with the pod */
      }
    })();

    const self = this;
    return {
      host: ip,
      port,
      pid: null,
      ref: `${this.namespace}/${name}`,
      exited,
      get exit() {
        return state.exit;
      },
      async stop() {
        await self.removeAll(name);
        for (let i = 0; i < 30 && !state.exit; i++) {
          if (!(await read().catch(() => null))) finish({ code: null, signal: 'SIGTERM' });
          else await new Promise((r) => setTimeout(r, 500));
        }
        finish({ code: null, signal: 'SIGTERM' });
      },
    };
  }
}

export function createRuntime(cfg: DuckViewConfig, opts: { command: () => string[] | null; sdkDir: () => string | null; usedPorts: () => Set<number>; runDir: (id: string) => string; internalPort: () => number }): AppRuntime {
  switch (cfg.apps.runtime) {
    case 'docker':
      return new DockerRuntime(cfg, opts);
    case 'kubernetes':
      return new KubernetesRuntime(cfg);
    default:
      return new SubprocessRuntime(cfg, opts);
  }
}
