/**
 * Audit export: Splunk HEC, Datadog, Elasticsearch _bulk, signed NDJSON webhooks and gzipped NDJSON in a bucket;
 * in order, from a cursor, at least once through failures, SQL optional, administrators only.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { loadConfig } from '../config/index.js';
import { initLogger } from '../observability/logger.js';
import { createContext, type AppContext } from '../context.js';
import { buildApp } from '../app.js';
import type { Principal } from '../services/principal.js';

let dir: string;
let ctx: AppContext;
let app: Awaited<ReturnType<typeof buildApp>>['app'];
let base: string;
let jwt: string;
let userJwt: string;
let hook: string;
let admin: Principal;
let wsId: string;
const got: { path: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
let failing = false;
let receiver: http.Server;

const api = async (method: string, url: string, body?: unknown, token = jwt) => {
  const res = await fetch(base + url, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
};
const at = (p: string) => got.filter((g) => g.path.startsWith(p));
const later = () => new Date(Date.now() + 5000);

beforeAll(async () => {
  initLogger({ level: 'silent', stderr: true, pretty: false });
  receiver = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => {
      got.push({ path: req.url!, headers: req.headers, body: b });
      if (failing) { res.writeHead(503); return res.end('down'); }
      if (req.url === '/api/v2/logs') { res.writeHead(202); return res.end('{}'); }
      if (req.url === '/es/_bulk') {
        const docs = b.trim().split('\n').filter((_, i) => i % 2 === 0);
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ errors: false, items: docs.map(() => ({ create: { status: 201 } })) }));
      }
      if (req.url === '/es-bad/_bulk') { res.writeHead(200); return res.end(JSON.stringify({ errors: true, items: [{ create: { status: 400, error: { type: 'mapper_parsing_exception', reason: 'bad field' } } }] })); }
      res.writeHead(200);
      res.end('{"text":"Success","code":0}');
    });
  });
  await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
  hook = `http://127.0.0.1:${(receiver.address() as net.AddressInfo).port}`;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dv-auditx-'));
  const cfg = loadConfig({ configPath: null, env: { DUCKVIEW_DATA_DIR: path.join(dir, 'data'), DUCKVIEW_FILESYSTEM_MODE: 'full', DUCKDB_TEMP_DIRECTORY: path.join(dir, 'spill'), DATABASE_URL: ':memory:', DUCKDB_MEMORY_LIMIT: '512MB', DUCKVIEW_ADMIN_EMAIL: 'admin@test.local', DUCKVIEW_ADMIN_PASSWORD: 'super-secret-pw', DUCKVIEW__duckdb__sync_scheduler_enabled: 'false', DUCKVIEW__notifications__scheduler_enabled: 'false', DUCKVIEW__apps__enabled: 'false', DUCKVIEW__audit_export__datadog_url: hook, DUCKVIEW__audit_export__batch_size: '3', DUCKVIEW_PUBLIC_URL: 'https://duckview.example.com', LOG_LEVEL: 'silent' } });
  ctx = await createContext(cfg);
  admin = ctx.auth.principalFromUser((await ctx.auth.findByEmail('admin@test.local'))!, 'jwt', '127.0.0.1');
  await ctx.auth.createLocalUser({ email: 'user@test.local', password: 'user-secret-pw', role: 'USER' });
  wsId = (await ctx.workspaces.create(admin, { name: 'W', active_db_path: 'w.duckdb' })).id;
  ({ app } = await buildApp(ctx));
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as net.AddressInfo).port}`;
  jwt = (await api('POST', '/api/auth/login', { email: 'admin@test.local', password: 'super-secret-pw' }, '')).json.token;
  userJwt = (await api('POST', '/api/auth/login', { email: 'user@test.local', password: 'user-secret-pw' }, '')).json.token;
});

afterAll(async () => {
  await app.close();
  await ctx.shutdown();
  receiver.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('audit export', () => {
  it('streams events to every kind of sink, in order, from a cursor', async () => {
    const make = async (body: Record<string, unknown>) => {
      const r = await api('POST', '/api/admin/audit-sinks', body);
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      return r.json as { sink: Record<string, any>; signing_secret: string | null };
    };
    expect((await api('POST', '/api/admin/audit-sinks', { name: 'x', type: 'splunk', config: { url: hook } }, userJwt)).status).toBe(403);
    expect((await api('POST', '/api/admin/audit-sinks', { name: 'x', type: 'splunk', config: { url: hook } })).json.message).toMatch(/Event Collector token/);
    const splunk = await make({ name: 'Splunk', type: 'splunk', config: { url: `${hook}/splunk`, index: 'security', sourcetype: 'duckview:audit' }, secret: { token: 'hec-token-1' } });
    const dd = await make({ name: 'Datadog', type: 'datadog', config: { site: 'datadoghq.eu', tags: 'env:test' }, secret: { api_key: 'dd-key' } });
    const es = await make({ name: 'Elastic', type: 'elastic', config: { url: `${hook}/es`, index: 'duckview-audit' }, secret: { api_key: 'es-key' } });
    const wh = await make({ name: 'Webhook', type: 'webhook', config: { url: `${hook}/wh`, include_sql: false } });
    expect(wh.signing_secret).toMatch(/^whsec_/);
    const uploads: { key: string; body: string; bucket: string }[] = [];
    ctx.auditExport.upload = async (_u, _c, bucket, key, file) => { uploads.push({ bucket, key, body: zlib.gunzipSync(fs.readFileSync(file)).toString() }); };
    const s3 = await make({ name: 'Bucket', type: 's3', config: { connection_id: 'conn-1', bucket: 'audit-bucket', prefix: '/dv/audit/' } });
    expect(JSON.stringify((await api('GET', '/api/admin/audit-sinks')).json)).not.toMatch(/hec-token-1|dd-key|es-key|whsec_/);

    // Events after the sinks were made (4 queries → 4 audit rows, plus the sink changes of other tests).
    await new Promise((r) => setTimeout(r, 20));
    for (const n of [1, 2, 3, 4]) await ctx.queries.run(admin, wsId, `SELECT ${n} AS n`, { cache: false });
    await new Promise((r) => setTimeout(r, 50));
    const out = await ctx.auditExport.tick(later());
    // The first sink also sees the other four being created (audited too), then the 4 queries: 8 at least.
    expect(out[splunk.sink.id]).toBeGreaterThanOrEqual(8);
    // Splunk: HEC events with the token, index and sourcetype; batches of 3.
    const sp = at('/splunk/services/collector/event');
    expect(sp.every((r) => r.body.split('\n').length <= 3)).toBe(true);
    expect(sp[0]!.headers.authorization).toBe('Splunk hec-token-1');
    const events = sp.flatMap((r) => r.body.split('\n').map((l) => JSON.parse(l)));
    expect(events.map((e) => e.event.query_text).filter(Boolean)).toEqual(['SELECT 1 AS n', 'SELECT 2 AS n', 'SELECT 3 AS n', 'SELECT 4 AS n']);
    expect(events.map((e) => e.event.timestamp)).toEqual([...events.map((e) => e.event.timestamp)].sort());
    expect(events.find((e) => e.event.action === 'query.execute')).toMatchObject({ index: 'security', sourcetype: 'duckview:audit', host: 'duckview.example.com', event: { action: 'query.execute', user_email: 'admin@test.local', source: 'duckview' } });
    // Datadog: the logs intake, the API key, tags.
    const d = at('/api/v2/logs');
    expect(d[0]!.headers['dd-api-key']).toBe('dd-key');
    expect(JSON.parse(d[0]!.body)[0]).toMatchObject({ ddsource: 'duckview', service: 'duckview', ddtags: expect.stringContaining('env:test'), duckview: { source: 'duckview' } });
    // Elastic: _bulk create with the event id (a resend is idempotent), @timestamp.
    const e = at('/es/_bulk');
    expect(e[0]!.headers.authorization).toBe('ApiKey es-key');
    const lines = e[0]!.body.trim().split('\n').map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({ create: { _index: 'duckview-audit', _id: lines[1].id } });
    expect(lines[1]).toMatchObject({ '@timestamp': expect.any(String), action: expect.any(String) });
    // Webhook: NDJSON, signed, without SQL (include_sql: false).
    const w = at('/wh');
    const whBody = w.map((x) => x.body).join('');
    expect(whBody).not.toMatch(/SELECT/);
    expect(w[0]!.headers['x-duckview-signature']).toBe(`sha256=${crypto.createHmac('sha256', wh.signing_secret!).update(`${w[0]!.headers['x-duckview-timestamp']}.${w[0]!.body}`).digest('hex')}`);
    // S3: gzipped NDJSON under the prefix, partitioned by day.
    expect(uploads[0]!.bucket).toBe('audit-bucket');
    expect(uploads[0]!.key).toMatch(/^dv\/audit\/dt=\d{4}-\d\d-\d\d\/.+\.ndjson\.gz$/);
    expect(uploads.flatMap((u) => u.body.trim().split('\n')).map((l) => JSON.parse(l).query_text).filter(Boolean)).toEqual(['SELECT 1 AS n', 'SELECT 2 AS n', 'SELECT 3 AS n', 'SELECT 4 AS n']);
    // The cursor moved: nothing is sent twice.
    const before = got.length;
    expect(Object.values(await ctx.auditExport.tick(later())).every((n) => n === 0)).toBe(true);
    expect(got.length).toBe(before);
    expect((await api('GET', '/api/admin/audit-sinks')).json.sinks.find((s: { id: string }) => s.id === splunk.sink.id)).toMatchObject({ exported: out[splunk.sink.id], last_status: 'ok' });
    for (const s of [splunk, dd, es, wh, s3]) await api('DELETE', `/api/admin/audit-sinks/${s.sink.id}`);
  });

  it('backs off through failures and sends again (at least once); backfills; tests; reports rejected documents', async () => {
    const sink = (await api('POST', '/api/admin/audit-sinks', { name: 'Flaky', type: 'splunk', config: { url: `${hook}/flaky` }, secret: { token: 't' } })).json.sink;
    await new Promise((r) => setTimeout(r, 20));
    await ctx.queries.run(admin, wsId, 'SELECT 42 AS answer', { cache: false });
    await new Promise((r) => setTimeout(r, 50));
    failing = true;
    await ctx.auditExport.tick(later());
    let s = (await api('GET', '/api/admin/audit-sinks')).json.sinks.find((x: { id: string }) => x.id === sink.id);
    expect(s).toMatchObject({ last_status: 'error', failures: 1, exported: 0 });
    expect(s.last_error).toMatch(/Splunk answered 503/);
    expect(new Date(s.retry_after).getTime()).toBeGreaterThan(Date.now());
    // While backing off, nothing is attempted.
    const tries = at('/flaky').length;
    await ctx.auditExport.tick(later());
    expect(at('/flaky').length).toBe(tries);
    // Back up: the same events arrive once the wait is over.
    failing = false;
    await ctx.auditExport.tick(new Date(Date.now() + 60_000));
    s = (await api('GET', '/api/admin/audit-sinks')).json.sinks.find((x: { id: string }) => x.id === sink.id);
    expect(s).toMatchObject({ last_status: 'ok', failures: 0 });
    expect(at('/flaky').at(-1)!.body).toMatch(/SELECT 42 AS answer/);
    // Backfill: a new sink can start from the beginning of the log.
    const all = (await api('POST', '/api/admin/audit-sinks', { name: 'Everything', type: 'splunk', config: { url: `${hook}/all` }, secret: { token: 't' }, backfill: true })).json.sink;
    const n = (await ctx.auditExport.tick(later()))[all.id]!;
    expect(n).toBeGreaterThan(8);
    expect(at('/all')[0]!.body).toMatch(/"action":"user\.login"|"action":"auth/);
    // Test button: one synthetic event, cursor untouched.
    expect((await api('POST', `/api/admin/audit-sinks/${all.id}/test`, {})).json).toEqual({ ok: true, error: null });
    expect(at('/all').at(-1)!.body).toMatch(/audit_sink\.test/);
    // Elasticsearch per-item errors are failures.
    const bad = (await api('POST', '/api/admin/audit-sinks', { name: 'Bad ES', type: 'elastic', config: { url: `${hook}/es-bad` }, secret: { username: 'u', password: 'p' } })).json.sink;
    expect((await api('POST', `/api/admin/audit-sinks/${bad.id}/test`, {})).json.error).toMatch(/mapper_parsing_exception bad field/);
    for (const x of [sink, all, bad]) await api('DELETE', `/api/admin/audit-sinks/${x.id}`);
  });
});
