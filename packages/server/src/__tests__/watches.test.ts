import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { eq } from 'drizzle-orm';
import { loadConfig } from '../config/index.js';
import { initLogger } from '../observability/logger.js';
import { createContext, type AppContext } from '../context.js';
import type { Principal } from '../services/principal.js';

let dir: string;
let ctx: AppContext;
let admin: Principal;
let ws: string;
let hook: http.Server;
const received: { title: string; severity: string }[] = [];
const sql = (s: string) => ctx.queries.run(admin, ws, s);

beforeAll(async () => {
  initLogger({ level: 'silent', stderr: true, pretty: false });
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dv-watch-')));
  const cfg = loadConfig({ configPath: null, env: { DUCKVIEW_DATA_DIR: path.join(dir, 'data'), DUCKVIEW_FILESYSTEM_MODE: 'sandboxed', DUCKDB_TEMP_DIRECTORY: path.join(dir, 'spill'), DATABASE_URL: ':memory:', DUCKDB_MEMORY_LIMIT: '1GB', DUCKVIEW_ADMIN_EMAIL: 'admin@test.local', DUCKVIEW_ADMIN_PASSWORD: 'super-secret-pw', LOG_LEVEL: 'silent', DUCKVIEW__notifications__allow_private_targets: 'true' } });
  cfg.notifications.allow_private_targets = true;
  ctx = await createContext(cfg);
  admin = ctx.auth.principalFromUser((await ctx.auth.findByEmail('admin@test.local'))!, 'jwt', '127.0.0.1');
  ws = (await ctx.workspaces.create(admin, { name: 'Watch', active_db_path: 'watch.duckdb' })).id;
  hook = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      try {
        const j = JSON.parse(body);
        received.push({ title: j.title, severity: j.severity });
      } catch {
        /* not JSON */
      }
      res.end('ok');
    });
  });
  await new Promise<void>((r) => hook.listen(0, '127.0.0.1', () => r()));
});

afterAll(async () => {
  hook?.close();
  await ctx?.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('watches', () => {
  it('takes the schema as a baseline, reports drift, and accepts it', async () => {
    await sql('CREATE TABLE orders AS SELECT 1 AS id, 10.0 AS amount');
    const port = (hook.address() as { port: number }).port;
    const { channel: ch } = await ctx.notifications.create(admin, ws, { name: 'Hook', type: 'webhook', secret: { url: `http://127.0.0.1:${port}/w` } } as never);
    const w = await ctx.watches.create(admin, ws, { target: 'orders', channel_ids: [ch.id] });
    expect(w.status).toBe('ok');
    expect(w.baseline).toEqual([{ name: 'id', type: 'INTEGER' }, { name: 'amount', type: 'DECIMAL(3,1)' }]);
    await sql('ALTER TABLE orders ADD COLUMN region VARCHAR');
    await sql('ALTER TABLE orders DROP COLUMN amount');
    const d = await ctx.watches.check(admin, w.id);
    expect(d.status).toBe('drift');
    expect(d.detail).toBe('The schema changed: region (VARCHAR) was added; amount was removed');
    await new Promise((r) => setTimeout(r, 300));
    expect(received.at(-1)).toMatchObject({ title: 'The schema of orders changed', severity: 'warning' });
    const ok = await ctx.watches.accept(admin, w.id);
    expect(ok.status).toBe('ok');
    await new Promise((r) => setTimeout(r, 300));
    expect(received.at(-1)).toMatchObject({ title: 'orders is back to normal', severity: 'resolved' });
  });

  it('reports stale data by a time column and by a file, and says when it cannot tell', async () => {
    await sql("CREATE TABLE events AS SELECT TIMESTAMP '2020-01-01 00:00:00' AS at");
    const byColumn = await ctx.watches.create(admin, ws, { target: 'events', watch_schema: false, max_age_hours: 24, time_column: 'at' });
    expect(byColumn.status).toBe('stale');
    expect(byColumn.detail).toMatch(/Last updated \d+ days ago by the newest at; expected within 24 hours/);
    await sql('INSERT INTO events VALUES (now()::TIMESTAMP)');
    expect((await ctx.watches.check(admin, byColumn.id)).status).toBe('ok');

    fs.writeFileSync(path.join(dir, 'data', 'feed.csv'), 'a\n1\n');
    const byFile = await ctx.watches.create(admin, ws, { target: 'feed.csv', max_age_hours: 1 });
    expect(byFile.status).toBe('ok');
    const old = new Date(Date.now() - 3 * 3_600_000);
    fs.utimesSync(path.join(dir, 'data', 'feed.csv'), old, old);
    const stale = await ctx.watches.check(admin, byFile.id);
    expect(stale.status).toBe('stale');
    expect(stale.detail).toMatch(/feed\.csv was modified/);

    const unknown = await ctx.watches.create(admin, ws, { target: 'orders', watch_schema: false, max_age_hours: 5 });
    expect(unknown.status).toBe('error');
    expect(unknown.detail).toMatch(/choose a time column/);
  });

  it('checks due watches on schedule', async () => {
    const all = await ctx.watches.list(admin, ws);
    await ctx.store.db.update(ctx.store.schema.dataWatches).set({ last_checked_at: new Date(Date.now() - 2 * 3_600_000) }).where(eq(ctx.store.schema.dataWatches.id, all[0]!.id));
    expect(await ctx.watches.tick()).toContain(all[0]!.id);
    expect(await ctx.watches.tick()).not.toContain(all[0]!.id);
  });
});
