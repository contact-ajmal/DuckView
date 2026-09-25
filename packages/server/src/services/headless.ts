/**
 * Headless Chrome over the DevTools protocol, for the pictures DuckView takes of itself: data-app previews (agents'
 * preview_app) and scheduled snapshots of dashboards and apps. One throw-away browser per session, every command
 * with its own timeout, the whole session under a budget, and the profile removed afterwards — a wedged or crashed
 * browser never hangs the caller.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * A Chrome / Chromium binary. An explicit path is authoritative (missing → no browser); otherwise CHROME_PATH and
 * the usual install locations are tried.
 */
export function findChrome(configured?: string): string | null {
  if (configured) return fs.existsSync(configured) ? configured : null;
  const candidates = [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'];
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  return null;
}

export interface HeadlessPage {
  send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  evaluate<T = unknown>(expression: string): Promise<T | undefined>;
  navigate(url: string): Promise<void>;
  setCookie(cookie: { name: string; value: string; url: string; path?: string; httpOnly?: boolean }): Promise<void>;
  /** Resolves when `expression` is truthy (polling), or rejects after `timeoutMs`. */
  waitFor(expression: string, timeoutMs: number, what: string): Promise<void>;
  /** Resolves once no request has been in flight for `idleMs` (after at least one ran), or after `timeoutMs`. */
  waitNetworkIdle(idleMs: number, timeoutMs: number): Promise<void>;
  /** The whole page (up to maxHeight px), as PNG. */
  screenshot(opts?: { fullPage?: boolean; maxHeight?: number }): Promise<Buffer>;
  pdf(opts?: { landscape?: boolean }): Promise<Buffer>;
}

export interface HeadlessOptions {
  chromePath: string;
  width: number;
  height: number;
  /** The whole session, whatever the browser does. */
  budgetMs: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function withHeadless<T>(opts: HeadlessOptions, fn: (page: HeadlessPage) => Promise<T>): Promise<T> {
  const { default: WebSocket } = await import('ws');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dv-headless-'));
  // Port 0: Chrome picks a free port and writes it to DevToolsActivePort, so parallel renders never collide.
  const flags = ['--remote-debugging-port=0', `--user-data-dir=${profile}`, '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', '--disable-dev-shm-usage', '--disable-extensions', '--font-render-hinting=none', `--window-size=${opts.width},${opts.height}`, 'about:blank'];
  // Containers (root, or an unprivileged user without user namespaces) cannot use Chrome's sandbox.
  if (process.getuid?.() === 0 || process.env.CHROME_NO_SANDBOX === '1') flags.unshift('--no-sandbox');
  const child = spawn(opts.chromePath, flags, { stdio: 'ignore' });
  const deadline = Date.now() + opts.budgetMs;
  const handle: { ws: { close(): void } | null } = { ws: null };
  try {
    const run = async (): Promise<T> => {
      let target: { webSocketDebuggerUrl: string } | undefined;
      let port = 0;
      for (let i = 0; i < 50 && !target; i++) {
        if (child.exitCode !== null) throw new Error(`Chrome exited with ${child.exitCode}`);
        try {
          if (!port) port = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]) || 0;
          if (!port) throw new Error('not yet');
          const list = (await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(1000) })).json()) as { type: string; webSocketDebuggerUrl: string }[];
          target = list.find((t) => t.type === 'page');
        } catch {
          await sleep(200);
        }
      }
      if (!target) throw new Error('Chrome did not start');
      const socket = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
      handle.ws = socket;
      await new Promise<void>((resolve, reject) => { socket.on('open', () => resolve()); socket.on('error', reject); });
      let id = 0;
      const pending = new Map<number, { resolve: (m: { result?: Record<string, unknown>; error?: { message: string } }) => void; reject: (e: Error) => void }>();
      let inFlight = 0;
      let lastActivity = Date.now();
      let requests = 0;
      const tracked = new Set<string>();
      socket.on('message', (raw) => {
        const m = JSON.parse(String(raw)) as { id?: number; method?: string; result?: Record<string, unknown>; error?: { message: string } };
        if (m.id && pending.has(m.id)) {
          pending.get(m.id)!.resolve(m);
          pending.delete(m.id);
        } else if (m.method === 'Network.requestWillBeSent') {
          // Streams that stay open by design (live events, sockets) never finish, and fonts from a CDN can hang on a
          // slow network: neither may hold "idle" off (fonts get their own short wait before the screenshot).
          const params = (m as { params?: { requestId?: string; type?: string; request?: { url?: string } } }).params ?? {};
          if (params.type === 'EventSource' || params.type === 'WebSocket' || params.type === 'Font' || /\/api\/events\b/.test(params.request?.url ?? '')) return;
          if (params.requestId) tracked.add(params.requestId);
          inFlight++;
          requests++;
          lastActivity = Date.now();
        } else if (m.method === 'Network.loadingFinished' || m.method === 'Network.loadingFailed') {
          const requestId = (m as { params?: { requestId?: string } }).params?.requestId;
          if (requestId && !tracked.delete(requestId)) return;
          inFlight = Math.max(0, inFlight - 1);
          lastActivity = Date.now();
        }
      });
      socket.on('close', () => { for (const p of pending.values()) p.reject(new Error('Chrome closed the connection')); pending.clear(); });
      const send = (method: string, params: Record<string, unknown> = {}) => new Promise<Record<string, unknown>>((resolve, reject) => {
        const i = ++id;
        const t = setTimeout(() => { pending.delete(i); reject(new Error(`Chrome did not answer ${method}`)); }, method === 'Page.printToPDF' || method === 'Page.captureScreenshot' ? 60_000 : 15_000);
        pending.set(i, { resolve: (m) => { clearTimeout(t); if (m.error) reject(new Error(`${method}: ${m.error.message}`)); else resolve(m.result ?? {}); }, reject: (e) => { clearTimeout(t); reject(e); } });
        socket.send(JSON.stringify({ id: i, method, params }));
      });
      const evaluate = async <V>(expression: string) => ((await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })) as { result?: { value?: V } }).result?.value;
      await send('Page.enable');
      await send('Runtime.enable');
      await send('Network.enable');
      const page: HeadlessPage = {
        send,
        evaluate,
        async navigate(url) {
          await send('Page.navigate', { url });
        },
        async setCookie(c) {
          await send('Network.setCookie', { name: c.name, value: c.value, url: c.url, path: c.path ?? '/', httpOnly: c.httpOnly ?? false });
        },
        async waitFor(expression, timeoutMs, what) {
          const end = Math.min(Date.now() + timeoutMs, deadline);
          while (Date.now() < end) {
            if (await evaluate<boolean>(`!!(${expression})`).catch(() => false)) return;
            await sleep(300);
          }
          throw new Error(`timed out waiting for ${what}`);
        },
        async waitNetworkIdle(idleMs, timeoutMs) {
          const end = Math.min(Date.now() + timeoutMs, deadline);
          while (Date.now() < end) {
            if (requests > 0 && inFlight === 0 && Date.now() - lastActivity >= idleMs) return;
            await sleep(150);
          }
        },
        async screenshot(o = {}) {
          if (o.fullPage) {
            const h = Math.min(Number(await evaluate<number>('Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)')) || opts.height, o.maxHeight ?? 8000);
            await send('Emulation.setDeviceMetricsOverride', { width: opts.width, height: Math.max(opts.height, h), deviceScaleFactor: 1, mobile: false });
            await sleep(400);
          }
          const shot = (await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: !!o.fullPage })) as { data?: string };
          if (!shot.data) throw new Error('no screenshot');
          return Buffer.from(shot.data, 'base64');
        },
        async pdf(o = {}) {
          const r = (await send('Page.printToPDF', { printBackground: true, landscape: o.landscape ?? true, paperWidth: 11.69, paperHeight: 8.27, marginTop: 0.3, marginBottom: 0.3, marginLeft: 0.3, marginRight: 0.3 })) as { data?: string };
          if (!r.data) throw new Error('no PDF');
          return Buffer.from(r.data, 'base64');
        },
      };
      return fn(page);
    };
    return await Promise.race([run(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`the headless browser took longer than ${Math.round(opts.budgetMs / 1000)} s`)), Math.max(1000, deadline - Date.now())))]);
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
