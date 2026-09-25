import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../config/index.js';
import { initLogger } from '../observability/logger.js';
import { createContext, type AppContext } from '../context.js';
import { buildApp } from '../app.js';
import { NativePicker } from '../services/native-picker.js';
import type { Runner } from '../services/native-picker.js';

let dir: string;
let ctx: AppContext;
let wsId: string;
let app: Awaited<ReturnType<typeof buildApp>>['app'];
let base: string;
let jwt: string;

const api = async (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
  const res = await fetch(base + url, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), authorization: `Bearer ${jwt}`, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, json: (text ? JSON.parse(text) : {}) as Record<string, any> };
};

beforeAll(async () => {
  initLogger({ level: 'silent', stderr: true, pretty: false });
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dv-loc-')));
  const cfg = loadConfig({
    configPath: null,
    env: { DUCKVIEW_DATA_DIR: path.join(dir, 'data'), DUCKVIEW_FILESYSTEM_MODE: 'full', DUCKDB_TEMP_DIRECTORY: path.join(dir, 'spill'), DATABASE_URL: ':memory:', DUCKDB_MEMORY_LIMIT: '1GB', DUCKVIEW_ADMIN_EMAIL: 'admin@test.local', DUCKVIEW_ADMIN_PASSWORD: 'super-secret-pw', LOG_LEVEL: 'silent' },
  });
  ctx = await createContext(cfg);
  const user = await ctx.auth.findByEmail('admin@test.local');
  wsId = (await ctx.workspaces.ensureDefault(ctx.auth.principalFromUser(user!, 'jwt', '127.0.0.1'))).id;
  const lake = path.join(dir, 'lake');
  fs.mkdirSync(path.join(lake, 'raw'), { recursive: true });
  fs.mkdirSync(path.join(lake, 'orders', '_delta_log'), { recursive: true });
  fs.writeFileSync(path.join(lake, 'sales.parquet'), 'x');
  fs.writeFileSync(path.join(lake, 'notes.txt'), 'hello');
  fs.writeFileSync(path.join(lake, '.secret'), 'x');
  ({ app } = await buildApp(ctx));
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@test.local', password: 'super-secret-pw' }) });
  jwt = ((await login.json()) as { token: string }).token;
});

afterAll(async () => {
  await app?.close();
  await ctx?.close?.();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('location browser', () => {
  it('lists folders first, then files, with kinds and absolute paths', async () => {
    const r = await api('GET', `/api/storage/locate?workspace_id=${wsId}&path=${encodeURIComponent(path.join(dir, 'lake'))}`);
    expect(r.status).toBe(200);
    expect(r.json.path).toBe(path.join(dir, 'lake'));
    expect(r.json.parent).toBe(dir);
    expect(r.json.writable).toBe(true);
    expect(r.json.entries.map((e: { name: string }) => e.name)).toEqual(['orders', 'raw', 'notes.txt', 'sales.parquet']);
    const orders = r.json.entries.find((e: { name: string }) => e.name === 'orders');
    expect(orders).toMatchObject({ type: 'table_dir', kind: 'delta', queryable: true, path: path.join(dir, 'lake', 'orders') });
    expect(r.json.entries.find((e: { name: string }) => e.name === 'sales.parquet')).toMatchObject({ type: 'file', kind: 'parquet', size_bytes: 1 });
    const hidden = await api('GET', `/api/storage/locate?workspace_id=${wsId}&hidden=1&path=${encodeURIComponent(path.join(dir, 'lake'))}`);
    expect(hidden.json.entries.find((e: { name: string }) => e.name === '.secret')).toMatchObject({ hidden: true });
  });

  it('starts at the home directory and explains a missing folder', async () => {
    const r = await api('GET', `/api/storage/locate?workspace_id=${wsId}`);
    expect(r.json.path).toBe(fs.realpathSync(os.homedir()));
    const missing = await api('GET', `/api/storage/locate?workspace_id=${wsId}&path=${encodeURIComponent(path.join(dir, 'nope'))}`);
    expect(missing.status).toBeGreaterThanOrEqual(400);
    expect(String(missing.json.message ?? missing.json.error)).toMatch(/No such folder/);
  });

  it('lists places: the data directory, home, and the workspace folders', async () => {
    await api('POST', `/api/workspaces/${wsId}/folders`, { path: path.join(dir, 'lake'), name: 'Lake' });
    const r = await api('GET', `/api/storage/places?workspace_id=${wsId}`);
    expect(r.json.mode).toBe('full');
    expect(r.json.places[0]).toMatchObject({ kind: 'data', name: 'Data directory' });
    expect(r.json.places.some((p: { kind: string }) => p.kind === 'home')).toBe(true);
    expect(r.json.workspace_folders).toEqual([{ name: 'Lake', path: path.join(dir, 'lake') }]);
    expect(r.json.native_dialog).toHaveProperty('available');
  });

  it('makes a new folder and refuses bad names and duplicates', async () => {
    const parent = path.join(dir, 'lake');
    const ok = await api('POST', '/api/storage/mkdir', { workspace_id: wsId, parent, name: 'exports' });
    expect(ok.status).toBe(200);
    expect(fs.statSync(path.join(parent, 'exports')).isDirectory()).toBe(true);
    expect((await api('POST', '/api/storage/mkdir', { workspace_id: wsId, parent, name: 'exports' })).status).toBeGreaterThanOrEqual(400);
    expect((await api('POST', '/api/storage/mkdir', { workspace_id: wsId, parent, name: '../escape' })).status).toBeGreaterThanOrEqual(400);
    expect((await api('POST', '/api/storage/mkdir', { workspace_id: wsId, parent, name: '..' })).status).toBeGreaterThanOrEqual(400);
  });

  it('opens the system dialog through the injected runner, and reports cancel', async () => {
    const calls: string[][] = [];
    ctx.nativePicker.platform = 'darwin';
    ctx.nativePicker.runner = (async (cmd, args) => {
      calls.push([cmd, ...args]);
      return { code: 0, stdout: `${path.join(dir, 'lake')}/\n`, stderr: '' };
    }) as Runner;
    const r = await api('POST', '/api/storage/native-pick', { kind: 'folder' });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ paths: [path.join(dir, 'lake')], cancelled: false });
    expect(calls[0][0]).toBe('osascript');
    expect(calls[0].join(' ')).toContain('choose folder');
    ctx.nativePicker.runner = (async () => ({ code: 1, stdout: '', stderr: 'execution error: User canceled. (-128)' })) as Runner;
    expect((await api('POST', '/api/storage/native-pick', { kind: 'files', multiple: true })).json).toEqual({ paths: [], cancelled: true });
  });

  it('refuses the system dialog when the request is not from this computer', async () => {
    // fetch cannot set Host, so inject the request.
    const r = await app.inject({ method: 'POST', url: '/api/storage/native-pick', headers: { host: 'duckview.example.com', authorization: `Bearer ${jwt}` }, payload: { kind: 'folder' }, remoteAddress: '127.0.0.1' });
    expect(r.statusCode).toBe(403);
    expect(r.json().message ?? r.json().error).toMatch(/runs on this computer/);
  });
});

describe('native picker availability and commands', () => {
  const cfg = (mode: 'full' | 'sandboxed', cluster = false) => ({ security: { filesystem_mode: mode }, cluster: { enabled: cluster } }) as never;
  it('is offered only for local requests in full mode, outside a cluster', () => {
    const p = new NativePicker(cfg('full'));
    p.platform = 'darwin';
    expect(p.availability({ ip: '127.0.0.1', host: 'localhost:4200' }).available).toBe(true);
    expect(p.availability({ ip: '::1', host: '[::1]:4200' }).available).toBe(true);
    expect(p.availability({ ip: '10.0.0.5', host: 'localhost:4200' }).available).toBe(false);
    expect(p.availability({ ip: '127.0.0.1', host: 'evil.example' }).available).toBe(false);
    expect(new NativePicker(cfg('sandboxed')).availability({ ip: '127.0.0.1', host: 'localhost' }).reason).toMatch(/sandboxed/);
    expect(new NativePicker(cfg('full', true)).availability({ ip: '127.0.0.1', host: 'localhost' }).reason).toMatch(/cluster/);
  });
  it('builds a command per platform', () => {
    const p = new NativePicker(cfg('full'));
    p.platform = 'win32';
    expect(p.command({ kind: 'files', multiple: true })).toMatchObject({ cmd: 'powershell.exe' });
    expect(p.command({ kind: 'files', multiple: true }).args.join(' ')).toContain('Multiselect = $true');
    p.platform = 'linux';
    p.linuxDialog = () => 'zenity';
    expect(p.command({ kind: 'folder' }).args).toContain('--directory');
    p.linuxDialog = () => 'kdialog';
    expect(p.command({ kind: 'folder' }).args).toContain('--getexistingdirectory');
  });
  it('splits several chosen files and turns a failed run into an error', async () => {
    const p = new NativePicker(cfg('full'));
    p.platform = 'darwin';
    p.runner = async () => ({ code: 0, stdout: '/a/one.csv\n/a/two.csv\n', stderr: '' });
    expect(await p.pick({ kind: 'files', multiple: true })).toEqual(['/a/one.csv', '/a/two.csv']);
    p.runner = async () => ({ code: -1, stdout: '', stderr: 'spawn osascript ENOENT' });
    await expect(p.pick({ kind: 'folder' })).rejects.toThrow(/system dialog failed/);
  });
});

describe('sources: renaming files and folder health', () => {
  it('renames a file in the data directory and refuses clashes and bad names', async () => {
    fs.writeFileSync(path.join(dir, 'data', 'old.csv'), 'a\n1\n');
    fs.writeFileSync(path.join(dir, 'data', 'taken.csv'), 'a\n1\n');
    const ok = await api('PATCH', `/api/workspaces/${wsId}/files`, { path: 'old.csv', name: 'new.csv' });
    expect(ok.status).toBe(200);
    expect(ok.json.path).toBe('new.csv');
    expect(fs.existsSync(path.join(dir, 'data', 'new.csv'))).toBe(true);
    expect((await api('PATCH', `/api/workspaces/${wsId}/files`, { path: 'new.csv', name: 'taken.csv' })).status).toBe(400);
    expect((await api('PATCH', `/api/workspaces/${wsId}/files`, { path: 'new.csv', name: '../x.csv' })).status).toBe(400);
    // Outside the data directory and the workspace folders: refused even in full mode.
    fs.writeFileSync(path.join(dir, 'stray.csv'), 'a\n');
    expect((await api('PATCH', `/api/workspaces/${wsId}/files`, { path: path.join(dir, 'stray.csv'), name: 'moved.csv' })).status).toBe(400);
  });

  it('flags a workspace folder that no longer exists', async () => {
    const gone = path.join(dir, 'gone');
    fs.mkdirSync(gone);
    await api('POST', `/api/workspaces/${wsId}/folders`, { path: gone });
    fs.rmSync(gone, { recursive: true });
    const r = await api('GET', `/api/workspaces/${wsId}/folders`);
    expect(r.json.folders.find((f: { path: string }) => f.path === gone)).toMatchObject({ missing: true });
    expect(r.json.folders.find((f: { path: string }) => f.path === path.join(dir, 'lake'))).toMatchObject({ missing: false });
  });
});
