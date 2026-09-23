/**
 * Notification channels: Slack, Teams, PagerDuty and webhook payloads against a local receiver, email through a
 * minimal SMTP server, signing, retries, the egress guard, secrets never returned, and who may do what.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../config/index.js';
import { initLogger } from '../observability/logger.js';
import { createContext, type AppContext } from '../context.js';
import { buildApp } from '../app.js';
import { isPrivateAddress } from '../security/egress.js';
import { buildTools, runTool, type ToolEnv } from '../agent/tools.js';
import { findChrome } from '../services/headless.js';

let dir: string;
let ctx: AppContext;
let app: Awaited<ReturnType<typeof buildApp>>['app'];
let base: string;
let jwt: string;
let userJwt: string;
let wsId: string;
let otherWsId: string;
let hook: string;
let smtpPort: number;
const received: { path: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
const mails: { from: string; to: string[]; data: string }[] = [];
let flaky = 0;
const servers: (http.Server | net.Server)[] = [];

const api = async (method: string, url: string, body?: unknown, token = jwt) => {
  const res = await fetch(base + url, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
};
const last = (p: string) => [...received].reverse().find((r) => r.path === p)!;

/** Just enough SMTP for nodemailer: EHLO, MAIL, RCPT, DATA, QUIT. */
function fakeSmtp(): net.Server {
  return net.createServer((sock) => {
    let buf = '';
    let inData = false;
    let mail = { from: '', to: [] as string[], data: '' };
    sock.write('220 fake ESMTP\r\n');
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      for (;;) {
        if (inData) {
          const end = buf.indexOf('\r\n.\r\n');
          if (end < 0) return;
          mail.data = buf.slice(0, end);
          buf = buf.slice(end + 5);
          inData = false;
          mails.push(mail);
          mail = { from: '', to: [], data: '' };
          sock.write('250 queued\r\n');
          continue;
        }
        const i = buf.indexOf('\r\n');
        if (i < 0) return;
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO' || cmd === 'HELO') sock.write('250-fake\r\n250 8BITMIME\r\n');
        else if (cmd === 'MAIL') { mail.from = line; sock.write('250 OK\r\n'); }
        else if (cmd === 'RCPT') { mail.to.push(line); sock.write('250 OK\r\n'); }
        else if (cmd === 'DATA') { inData = true; sock.write('354 go ahead\r\n'); }
        else if (cmd === 'QUIT') { sock.end('221 bye\r\n'); return; }
        else sock.write('250 OK\r\n');
      }
    });
  });
}

beforeAll(async () => {
  initLogger({ level: 'silent', stderr: true, pretty: false });
  const receiver = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      received.push({ path: req.url!, headers: req.headers, body });
      if (req.url === '/pd') { res.writeHead(202, { 'content-type': 'application/json' }); return res.end('{"status":"success"}'); }
      if (req.url === '/flaky' && flaky++ === 0) { res.writeHead(503); return res.end('try later'); }
      if (req.url === '/bad') { res.writeHead(400); return res.end('invalid_payload'); }
      res.writeHead(200);
      res.end('ok');
    });
  });
  const smtp = fakeSmtp();
  servers.push(receiver, smtp);
  await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
  await new Promise<void>((r) => smtp.listen(0, '127.0.0.1', r));
  hook = `http://127.0.0.1:${(receiver.address() as net.AddressInfo).port}`;
  smtpPort = (smtp.address() as net.AddressInfo).port;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dv-notify-'));
  const cfg = loadConfig({
    configPath: null,
    env: { DUCKVIEW_DATA_DIR: path.join(dir, 'data'), DUCKVIEW_FILESYSTEM_MODE: 'full', DUCKDB_TEMP_DIRECTORY: path.join(dir, 'spill'), DATABASE_URL: ':memory:', DUCKDB_MEMORY_LIMIT: '512MB', DUCKVIEW_ADMIN_EMAIL: 'admin@test.local', DUCKVIEW_ADMIN_PASSWORD: 'super-secret-pw', DUCKVIEW__duckdb__sync_scheduler_enabled: 'false', DUCKVIEW__apps__enabled: 'false', DUCKVIEW__notifications__allow_private_targets: 'true', DUCKVIEW__notifications__scheduler_enabled: 'false', DUCKVIEW__notifications__pagerduty_url: `${hook}/pd`, DUCKVIEW_PUBLIC_URL: 'https://duckview.example.com', LOG_LEVEL: 'silent' },
  });
  ctx = await createContext(cfg);
  const admin = ctx.auth.principalFromUser((await ctx.auth.findByEmail('admin@test.local'))!, 'jwt', '127.0.0.1');
  const user = await ctx.auth.createLocalUser({ email: 'user@test.local', password: 'user-secret-pw', role: 'USER' });
  wsId = (await ctx.workspaces.create(admin, { name: 'Sales', active_db_path: 'sales.duckdb' })).id;
  otherWsId = (await ctx.workspaces.create(admin, { name: 'Private', active_db_path: 'private.duckdb' })).id;
  await ctx.workspaces.setMember(admin, wsId, { subject_type: 'user', subject_id: user.id, role: 'VIEWER' });
  ({ app } = await buildApp(ctx));
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as net.AddressInfo).port}`;
  jwt = (await api('POST', '/api/auth/login', { email: 'admin@test.local', password: 'super-secret-pw' }, '')).json.token;
  userJwt = (await api('POST', '/api/auth/login', { email: 'user@test.local', password: 'user-secret-pw' }, '')).json.token;
});

afterAll(async () => {
  await app.close();
  await ctx.shutdown();
  for (const s of servers) s.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('egress guard', () => {
  it('knows private, loopback, link-local and mapped addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', '224.0.0.1']) expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700::1111']) expect(isPrivateAddress(ip), ip).toBe(false);
  });
});

describe('channels', () => {
  it('validates each type, keeps secrets write-only, and renders each target\'s format', async () => {
    // Validation with the guard on (the production default).
    ctx.cfg.notifications.allow_private_targets = false;
    expect((await api('POST', `/api/workspaces/${wsId}/channels`, { name: 's', type: 'slack', secret: { url: 'https://evil.example.com/hook' } })).json.message).toMatch(/not a Slack webhook host/);
    expect((await api('POST', `/api/workspaces/${wsId}/channels`, { name: 't', type: 'teams', secret: { url: 'http://x.webhook.office.com/a' } })).json.message).toMatch(/must be https/);
    expect((await api('POST', `/api/workspaces/${wsId}/channels`, { name: 'p', type: 'pagerduty', secret: { routing_key: 'short' } })).status).toBe(400);
    expect((await api('POST', `/api/workspaces/${wsId}/channels`, { name: 'e', type: 'email', config: { to: ['ops@example.com', 'nope'] } })).json.message).toMatch(/"nope" is not an address/);
    // A webhook that resolves to a private address is refused at delivery.
    const priv = await api('POST', `/api/workspaces/${wsId}/channels`, { name: 'internal', type: 'webhook', secret: { url: 'https://127.0.0.1:9/x' } });
    expect(priv.status).toBe(200);
    const blocked = await api('POST', `/api/channels/${priv.json.channel.id}/test`, {});
    expect(blocked.json.delivery).toMatchObject({ status: 'error', attempts: 1 });
    expect(blocked.json.delivery.error).toMatch(/private address/);
    await api('DELETE', `/api/channels/${priv.json.channel.id}`);
    ctx.cfg.notifications.allow_private_targets = true;

    const make = async (body: Record<string, unknown>) => {
      const r = await api('POST', `/api/workspaces/${wsId}/channels`, body);
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      return r.json as { channel: Record<string, any>; signing_secret: string | null };
    };
    const slack = await make({ name: 'Ops Slack', type: 'slack', secret: { url: `${hook}/slack` } });
    expect(slack.channel).toMatchObject({ scope: 'workspace', secret_set: true, hint: expect.stringMatching(/…lack$/) });
    expect(JSON.stringify(slack)).not.toContain('/slack"');
    const teams = await make({ name: 'Teams', type: 'teams', secret: { url: `${hook}/teams` } });
    const pd = await make({ name: 'On call', type: 'pagerduty', secret: { routing_key: 'R0UTINGKEY0123456789abcd' } });
    const wh = await make({ name: 'Hook', type: 'webhook', secret: { url: `${hook}/hook` } });
    expect(wh.signing_secret).toMatch(/^whsec_/);
    const email = await make({ name: 'Ops mail', type: 'email', config: { to: 'ops@example.com; lead@example.com' } });
    expect(email.channel.config).toMatchObject({ to: ['ops@example.com', 'lead@example.com'], hint: 'ops@example.com +1' });
    // The secrets never come back.
    const listed = await api('GET', `/api/workspaces/${wsId}/channels`);
    expect(JSON.stringify(listed.json)).not.toMatch(/R0UTINGKEY|whsec_|\/hook"/);
    expect(listed.json.channels.map((c: { name: string }) => c.name)).toEqual(['Hook', 'On call', 'Ops mail', 'Ops Slack', 'Teams']);

    // Slack: Block Kit.
    expect((await api('POST', `/api/channels/${slack.channel.id}/test`, {})).json.delivery).toMatchObject({ status: 'ok', attempts: 1 });
    const sb = JSON.parse(last('/slack').body);
    expect(sb.text).toBe('ℹ️ Test from DuckView: Ops Slack');
    expect(sb.blocks.map((b: { type: string }) => b.type)).toEqual(['header', 'section', 'section', 'actions', 'context']);
    expect(sb.blocks[3].elements[0].url).toBe('https://duckview.example.com/#/alerts');
    expect(sb.blocks[4].elements[0].text).toBe('DuckView · Sales · info');
    // Teams: an Adaptive Card.
    await api('POST', `/api/channels/${teams.channel.id}/test`, {});
    const tb = JSON.parse(last('/teams').body);
    expect(tb.attachments[0].contentType).toBe('application/vnd.microsoft.card.adaptive');
    expect(tb.attachments[0].content.body[0]).toMatchObject({ type: 'TextBlock', text: 'Test from DuckView: Teams' });
    // PagerDuty: Events API v2.
    expect((await api('POST', `/api/channels/${pd.channel.id}/test`, {})).json.delivery.status).toBe('ok');
    const pb = JSON.parse(last('/pd').body);
    expect(pb).toMatchObject({ routing_key: 'R0UTINGKEY0123456789abcd', event_action: 'trigger', payload: { summary: 'Test from DuckView: On call', severity: 'info', component: 'Sales' } });
    // Webhook: JSON, signed with HMAC-SHA256 over "<timestamp>.<body>".
    await api('POST', `/api/channels/${wh.channel.id}/test`, {});
    const w = last('/hook');
    const body = JSON.parse(w.body);
    expect(body).toMatchObject({ event: 'channel.test', title: 'Test from DuckView: Hook', severity: 'info', workspace: { id: wsId, name: 'Sales' } });
    expect(w.headers['x-duckview-event']).toBe('channel.test');
    const expected = crypto.createHmac('sha256', wh.signing_secret!).update(`${w.headers['x-duckview-timestamp']}.${w.body}`).digest('hex');
    expect(w.headers['x-duckview-signature']).toBe(`sha256=${expected}`);
    // Email: nothing without a mail server, then through the fake SMTP server.
    const noMail = await api('POST', `/api/channels/${email.channel.id}/test`, {});
    expect(noMail.json.delivery).toMatchObject({ status: 'error', attempts: 1 });
    expect(noMail.json.delivery.error).toMatch(/No mail server/);
    const smtp = await api('PUT', '/api/admin/integrations/smtp', { host: '127.0.0.1', port: smtpPort, secure: false, from: 'DuckView <duckview@example.com>', password: 'mail-secret' });
    expect(smtp.json).toMatchObject({ configured: true, source: 'console', host: '127.0.0.1', password_set: true });
    expect(JSON.stringify(smtp.json)).not.toContain('mail-secret');
    // (A password without a user is ignored by nodemailer; the fake server does not ask for AUTH.)
    expect((await api('POST', `/api/channels/${email.channel.id}/test`, {})).json.delivery, JSON.stringify(mails)).toMatchObject({ status: 'ok' });
    const m = mails.at(-1)!;
    expect(m.to).toEqual(['RCPT TO:<ops@example.com>', 'RCPT TO:<lead@example.com>']);
    expect(m.data).toMatch(/Subject: Test from DuckView: Ops mail/);
    expect(m.data).toMatch(/Open in DuckView/);
    expect((await api('POST', '/api/admin/integrations/smtp/test', { to: 'admin@example.com' })).json).toEqual({ ok: true });
    expect(mails.at(-1)!.data).toMatch(/Subject: DuckView email works/);

    // History and status on the channel.
    const hist = await api('GET', `/api/channels/${email.channel.id}/deliveries`);
    expect(hist.json.deliveries.map((d: { status: string }) => d.status)).toEqual(['ok', 'error']);
    expect((await api('GET', `/api/channels/${email.channel.id}`)).json.channel).toMatchObject({ last_status: 'ok', last_error: null });
  });

  it('retries transient failures, not permanent ones; updates keep secrets; disabled channels are skipped', async () => {
    const flakyCh = (await api('POST', `/api/workspaces/${wsId}/channels`, { name: 'Flaky', type: 'webhook', secret: { url: `${hook}/flaky` } })).json.channel;
    expect((await api('POST', `/api/channels/${flakyCh.id}/test`, {})).json.delivery).toMatchObject({ status: 'ok', attempts: 2 });
    const bad = (await api('POST', `/api/workspaces/${wsId}/channels`, { name: 'Bad', type: 'slack', secret: { url: `${hook}/bad` } })).json.channel;
    const d = (await api('POST', `/api/channels/${bad.id}/test`, {})).json.delivery;
    expect(d).toMatchObject({ status: 'error', attempts: 1 });
    expect(d.error).toMatch(/Slack answered 400: invalid_payload/);
    // Renaming leaves the secret alone; a new URL replaces it.
    await api('PATCH', `/api/channels/${bad.id}`, { name: 'Fixed' });
    expect((await api('POST', `/api/channels/${bad.id}/test`, {})).json.delivery.status).toBe('error');
    await api('PATCH', `/api/channels/${bad.id}`, { secret: { url: `${hook}/slack` } });
    expect((await api('POST', `/api/channels/${bad.id}/test`, {})).json.delivery.status).toBe('ok');
    expect((await api('PATCH', `/api/channels/${bad.id}`, { type: 'teams' })).status).toBe(400);
    // send(): only enabled channels of the producer's workspace, or org-wide ones.
    const before = received.length;
    await api('PATCH', `/api/channels/${flakyCh.id}`, { enabled: false });
    const org = (await api('POST', '/api/channels', { name: 'Org hook', type: 'webhook', secret: { url: `${hook}/org` } })).json.channel;
    expect(org.scope).toBe('org');
    const out = await ctx.notifications.send([flakyCh.id, bad.id, org.id], { title: 'x', text: 'y', severity: 'warning' }, 'test', wsId);
    expect(out.map((o) => o.status)).toEqual(['ok', 'ok']);
    expect(received.slice(before).map((r) => r.path).sort()).toEqual(['/org', '/slack']);
    const elsewhere = await ctx.notifications.send([bad.id], { title: 'x', text: 'y', severity: 'info' }, 'test', otherWsId);
    expect(elsewhere).toEqual([]);
    for (const id of [flakyCh.id, bad.id, org.id]) await api('DELETE', `/api/channels/${id}`);
  });

  it('lets viewers see channels, editors manage them, administrators own org-wide ones', async () => {
    const ch = (await api('POST', `/api/workspaces/${wsId}/channels`, { name: 'Team hook', type: 'webhook', secret: { url: `${hook}/hook` } })).json.channel;
    expect((await api('GET', `/api/workspaces/${wsId}/channels`, undefined, userJwt)).json.channels.some((c: { id: string }) => c.id === ch.id)).toBe(true);
    expect((await api('POST', `/api/channels/${ch.id}/test`, {}, userJwt)).status).toBe(403);
    expect((await api('PATCH', `/api/channels/${ch.id}`, { name: 'x' }, userJwt)).status).toBe(403);
    expect((await api('POST', `/api/workspaces/${wsId}/channels`, { name: 'x', type: 'webhook', secret: { url: `${hook}/hook` } }, userJwt)).status).toBe(403);
    expect((await api('POST', '/api/channels', { name: 'x', type: 'webhook', secret: { url: `${hook}/hook` } }, userJwt)).status).toBe(403);
    expect((await api('GET', `/api/workspaces/${otherWsId}/channels`, undefined, userJwt)).status).toBe(404);
    expect((await api('GET', '/api/admin/integrations/smtp', undefined, userJwt)).status).toBe(403);
    await api('DELETE', `/api/channels/${ch.id}`);
  });
});

describe('alerts', () => {
  it('checks a threshold on a schedule, notifies on change, resolves, reports failures, stays read-only', async () => {
    const admin = ctx.auth.principalFromUser((await ctx.auth.findByEmail('admin@test.local'))!, 'jwt', '127.0.0.1');
    await ctx.queries.run(admin, wsId, 'CREATE TABLE orders AS SELECT * FROM (VALUES (1, 20.0), (2, 40.0)) t(id, amount)', { cache: false });
    const ch = (await api('POST', `/api/workspaces/${wsId}/channels`, { name: 'Alert hook', type: 'webhook', secret: { url: `${hook}/alert-hook` } })).json.channel;
    const pd = (await api('POST', `/api/workspaces/${wsId}/channels`, { name: 'Pager', type: 'pagerduty', secret: { routing_key: 'R0UTINGKEY0123456789abcd' } })).json.channel;
    const hooks = () => received.filter((r) => r.path === '/alert-hook').map((r) => JSON.parse(r.body));
    // Refused: writes, several statements, channels of another workspace.
    const bad = (body: Record<string, unknown>) => api('POST', `/api/workspaces/${wsId}/alerts`, { name: 'x', condition: { kind: 'rows' }, ...body });
    expect((await bad({ sql: 'DELETE FROM orders' })).json.message).toMatch(/only reads: DELETE/);
    expect((await bad({ sql: 'SELECT 1; SELECT 2' })).json.message).toMatch(/one statement/);
    const foreign = (await api('POST', `/api/workspaces/${otherWsId}/channels`, { name: 'Other', type: 'webhook', secret: { url: `${hook}/x` } })).json.channel;
    expect((await bad({ sql: 'SELECT 1', channel_ids: [foreign.id] })).json.message).toMatch(/not a channel of this workspace/);
    // Preview: evaluates without saving.
    const pre = await api('POST', `/api/workspaces/${wsId}/alerts/preview`, { sql: 'SELECT sum(amount) AS total FROM orders', condition: { kind: 'threshold', column: 'total', op: '>', value: 100 } });
    expect(pre.json.evaluation).toMatchObject({ state: 'ok', value: '60', summary: 'total is 60 — not > 100.' });

    const created = await api('POST', `/api/workspaces/${wsId}/alerts`, { name: 'Revenue spike', description: 'Orders above plan', sql: 'SELECT sum(amount) AS total FROM orders', condition: { kind: 'threshold', column: 'total', op: '>', value: 100 }, schedule: { kind: 'interval', minutes: 5 }, channel_ids: [ch.id, pd.id], severity: 'critical' });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    const id = created.json.alert.id;
    expect(created.json.alert).toMatchObject({ state: 'unknown', enabled: true });
    expect(new Date(created.json.alert.next_run_at).getTime()).toBeGreaterThan(Date.now() + 4 * 60_000);
    const run = () => api('POST', `/api/alerts/${id}/run`, {});
    // ok: nothing delivered.
    expect((await run()).json).toMatchObject({ changed: true, notified: 0, alert: { state: 'ok', last_value: '60' } });
    expect(hooks()).toHaveLength(0);
    // Triggered: delivered once, with the severity, fields and a dedup key; not again while it stays triggered.
    await ctx.queries.run(admin, wsId, 'INSERT INTO orders VALUES (3, 90.0)', { cache: false });
    expect((await run()).json).toMatchObject({ changed: true, notified: 2, alert: { state: 'triggered', last_value: '150' } });
    const t = hooks().at(-1);
    expect(t).toMatchObject({ event: 'alert.triggered', title: 'Revenue spike', severity: 'critical', dedup_key: `duckview-alert-${id}`, url: `https://duckview.example.com/#/alerts/alerts?alert=${id}` });
    expect(t.text).toMatch(/Orders above plan\n\ntotal is 150 — > 100\./);
    expect(t.fields).toEqual(expect.arrayContaining([{ label: 'Condition', value: 'total > 100' }, { label: 'Value', value: '150' }, { label: 'Workspace', value: 'Sales' }]));
    expect(JSON.parse(last('/pd').body)).toMatchObject({ event_action: 'trigger', dedup_key: `duckview-alert-${id}`, payload: { severity: 'critical' } });
    expect((await run()).json).toMatchObject({ changed: false, notified: 0 });
    // notify: always → every triggered check.
    await api('PATCH', `/api/alerts/${id}`, { notify: 'always' });
    expect((await run()).json.notified).toBe(2);
    // Resolved: a "resolved" message, and PagerDuty resolves the same incident.
    await ctx.queries.run(admin, wsId, 'DELETE FROM orders WHERE id = 3', { cache: false });
    expect((await run()).json).toMatchObject({ changed: true, notified: 2, alert: { state: 'ok' } });
    expect(hooks().at(-1)).toMatchObject({ event: 'alert.resolved', title: 'Resolved: Revenue spike', severity: 'resolved' });
    expect(JSON.parse(last('/pd').body)).toEqual({ routing_key: 'R0UTINGKEY0123456789abcd', event_action: 'resolve', dedup_key: `duckview-alert-${id}`, client: 'DuckView' });
    // A broken query: reported once, as failing.
    await api('PATCH', `/api/alerts/${id}`, { sql: 'SELECT sum(nope) AS total FROM orders' });
    expect((await api('GET', `/api/alerts/${id}`)).json.alert.state).toBe('unknown');
    const failed = (await run()).json;
    expect(failed.alert.state).toBe('error');
    expect(failed.evaluation.error).toMatch(/nope/);
    expect(hooks().at(-1)).toMatchObject({ event: 'alert.error', title: 'Alert failing: Revenue spike', severity: 'warning' });
    expect((await run()).json.notified).toBe(0);
    // History: newest first.
    const events = (await api('GET', `/api/alerts/${id}/events`)).json.events as { state: string; notified: number; triggered_by: string }[];
    expect(events.slice(0, 3).map((e) => e.state)).toEqual(['error', 'error', 'ok']);
    expect(events[0]!.triggered_by).toBe('manual:admin@test.local');
    // The scheduler: due alerts run and move their next check forward.
    await api('PATCH', `/api/alerts/${id}`, { sql: 'SELECT sum(amount) AS total FROM orders' });
    const later = new Date(Date.now() + 10 * 60_000);
    expect(await ctx.alerts.tick(later)).toEqual([id]);
    const after = (await api('GET', `/api/alerts/${id}`)).json.alert;
    expect(after.state).toBe('ok');
    expect(new Date(after.next_run_at).getTime()).toBeGreaterThan(later.getTime());
    expect(await ctx.alerts.tick(later)).toEqual([]);
    // Disabled alerts are not scheduled.
    await api('PATCH', `/api/alerts/${id}`, { enabled: false });
    expect((await api('GET', `/api/alerts/${id}`)).json.alert.next_run_at).toBeNull();
    // A "no rows" freshness alert, and "rows" quoting a sample of what it found.
    const fresh = (await api('POST', `/api/workspaces/${wsId}/alerts`, { name: 'Nothing today', sql: 'SELECT * FROM orders WHERE id > 100', condition: { kind: 'no_rows' }, channel_ids: [ch.id] })).json.alert;
    expect((await api('POST', `/api/alerts/${fresh.id}/run`, {})).json.alert.state).toBe('triggered');
    const rows = (await api('POST', `/api/workspaces/${wsId}/alerts`, { name: 'Big orders', sql: 'SELECT id, amount FROM orders ORDER BY id', condition: { kind: 'rows' }, channel_ids: [ch.id] })).json.alert;
    await api('POST', `/api/alerts/${rows.id}/run`, {});
    expect(hooks().at(-1).text).toMatch(/The query returned 2 rows\.\n\nid  amount\n──  ──────\n1   20(\.0)?\n2   40(\.0)?/);
    // Viewers see alerts, cannot run or change them.
    expect((await api('GET', `/api/workspaces/${wsId}/alerts`, undefined, userJwt)).json.alerts.length).toBe(3);
    expect((await api('POST', `/api/alerts/${id}/run`, {}, userJwt)).status).toBe(403);
    expect((await api('PATCH', `/api/alerts/${id}`, { name: 'x' }, userJwt)).status).toBe(403);
    // Agents: create_alert tries the query first and checks it once.
    const env: ToolEnv = { ctx, principal: admin, via: 'rest', defaultWorkspaceId: wsId, agent: null };
    const tools = buildTools(ctx.cfg);
    const tool = (n: string) => tools.find((x) => x.name === n)!;
    const broken = await runTool(env, tool('create_alert'), { name: 'Broken', sql: 'SELECT * FROM missing_table', condition: { kind: 'rows' } });
    expect(broken.isError).toBe(true);
    expect((await api('GET', `/api/workspaces/${wsId}/alerts`)).json.alerts).toHaveLength(3);
    const made = await runTool(env, tool('create_alert'), { name: 'Agent watch', sql: 'SELECT count(*) AS n FROM orders', condition: { kind: 'threshold', column: 'n', op: '>=', value: 2 }, every_minutes: 15, channel_ids: [ch.id] });
    expect(made.structuredContent).toMatchObject({ status: 'ok', state: 'triggered', value: '2', notified: 1 });
    const listed = await runTool(env, tool('list_alerts'), {});
    expect((listed.structuredContent as { alerts: unknown[]; channels: unknown[] }).alerts).toHaveLength(4);
    expect(((await runTool(env, tool('run_alert'), { alert_id: (made.structuredContent as { alert_id: string }).alert_id })).structuredContent as { changed: boolean }).changed).toBe(false);
    for (const a of (await api('GET', `/api/workspaces/${wsId}/alerts`)).json.alerts) await api('DELETE', `/api/alerts/${a.id}`);
  });
});

const canRender = !process.env.CI && !!findChrome() && fs.existsSync(path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../web/dist/index.html'));

describe('scheduled snapshots', () => {
  it('validates targets and schedules, reports a render failure to the channels, signs links', async () => {
    const admin = ctx.auth.principalFromUser((await ctx.auth.findByEmail('admin@test.local'))!, 'jwt', '127.0.0.1');
    const dash = await ctx.dashboards.create(admin, wsId, { name: 'Sales board', description: 'daily numbers', kind: 'grid' });
    const otherDash = await ctx.dashboards.create(admin, otherWsId, { name: 'Elsewhere', kind: 'grid' });
    const ch = (await api('POST', `/api/workspaces/${wsId}/channels`, { name: 'Snap hook', type: 'webhook', secret: { url: `${hook}/snap-hook` } })).json.channel;
    const post = (body: Record<string, unknown>) => api('POST', `/api/workspaces/${wsId}/snapshots`, body);
    expect((await post({ target: { kind: 'dashboard', dashboard_id: otherDash.id } })).json.message).toMatch(/another workspace/);
    expect((await post({ target: { kind: 'dashboard', dashboard_id: dash.id }, schedule: { kind: 'interval', minutes: 5 } })).json.message).toMatch(/every 15 minutes/);
    const created = await post({ target: { kind: 'dashboard', dashboard_id: dash.id }, channel_ids: [ch.id] });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    const snap = created.json.snapshot;
    expect(snap).toMatchObject({ name: 'Sales board', format: 'png', width: 1280, schedule: { kind: 'cron', expression: '0 8 * * 1-5' }, enabled: true });
    // No browser: the run fails, and the channel hears why.
    const saved = ctx.cfg.apps.chrome_path;
    ctx.cfg.apps.chrome_path = '/nonexistent/chrome';
    const failed = (await api('POST', `/api/snapshots/${snap.id}/run`, {})).json;
    expect(failed.run).toMatchObject({ status: 'error', delivered: 1, file: null });
    expect(failed.run.error).toMatch(/No Chrome/);
    const msg = JSON.parse(last('/snap-hook').body);
    expect(msg).toMatchObject({ event: 'snapshot.failed', title: 'Snapshot failed: Sales board', severity: 'warning' });
    ctx.cfg.apps.chrome_path = saved;
    expect((await api('GET', `/api/snapshots/${snap.id}`)).json.snapshot).toMatchObject({ last_status: 'error' });
    // Signed links: forged, expired and unknown ones are refused.
    expect((await fetch(`${base}/api/snapshot-files/${failed.run.id}/png?exp=${Math.floor(Date.now() / 1000) + 60}&sig=forged`)).status).toBe(404);
    expect((await fetch(`${base}/api/snapshot-files/${failed.run.id}/png?exp=1&sig=x`)).status).toBe(404);
    // Viewers see snapshots, cannot run them.
    expect((await api('GET', `/api/workspaces/${wsId}/snapshots`, undefined, userJwt)).json.snapshots).toHaveLength(1);
    expect((await api('POST', `/api/snapshots/${snap.id}/run`, {}, userJwt)).status).toBe(403);
    // Retention removes old runs.
    expect(await ctx.snapshots.cleanup(new Date(Date.now() + 40 * 86_400_000))).toBe(1);
    expect((await api('GET', `/api/snapshots/${snap.id}/runs`)).json.runs).toEqual([]);
    await api('DELETE', `/api/snapshots/${snap.id}`);
    await api('DELETE', `/api/channels/${ch.id}`);
  });

  it.skipIf(!canRender)('renders a dashboard as its owner (PNG and PDF), delivers it with a signed link, and to agents', async () => {
    const admin = ctx.auth.principalFromUser((await ctx.auth.findByEmail('admin@test.local'))!, 'jwt', '127.0.0.1');
    ctx.cfg.server.public_url = base; // the signed link must be fetchable here
    await api('PUT', '/api/admin/integrations/smtp', { host: '127.0.0.1', port: smtpPort, secure: false, from: 'DuckView <duckview@example.com>' });
    const dash = await ctx.dashboards.create(admin, wsId, { name: 'KPI board', kind: 'grid' });
    await ctx.dashboards.addWidget(admin, dash.id, { title: 'Answer', widget_type: 'KPI', custom_sql: 'SELECT 4242 AS answer', chart_config: {} });
    const ch = (await api('POST', `/api/workspaces/${wsId}/channels`, { name: 'Render hook', type: 'webhook', secret: { url: `${hook}/render-hook` } })).json.channel;
    const email = (await api('POST', `/api/workspaces/${wsId}/channels`, { name: 'Render mail', type: 'email', config: { to: ['board@example.com'] } })).json.channel;
    const snap = (await api('POST', `/api/workspaces/${wsId}/snapshots`, { target: { kind: 'dashboard', dashboard_id: dash.id }, format: 'pdf', channel_ids: [ch.id, email.id] })).json.snapshot;
    const r = (await api('POST', `/api/snapshots/${snap.id}/run`, {})).json;
    expect(r.run, JSON.stringify(r.run)).toMatchObject({ status: 'ok', format: 'pdf', delivered: 2 });
    // The files: a PNG (always) and the PDF.
    const png = await fetch(`${base}/api/snapshots/${snap.id}/runs/${r.run.id}/file`, { headers: { authorization: `Bearer ${jwt}` } });
    expect(png.headers.get('content-type')).toBe('application/pdf');
    expect(Buffer.from(await png.arrayBuffer()).subarray(0, 4).toString()).toBe('%PDF');
    // The webhook got the picture (base64 + a signed link that works without signing in) and the PDF.
    const w = JSON.parse(last('/render-hook').body);
    expect(w).toMatchObject({ event: 'snapshot.delivered', title: 'KPI board' });
    const img = Buffer.from(w.image.base64, 'base64');
    expect(img.subarray(1, 4).toString()).toBe('PNG');
    expect(img.readUInt32BE(16)).toBe(1280); // width from the IHDR chunk
    expect(w.attachments[0]).toMatchObject({ filename: expect.stringMatching(/^KPI_board-\d{4}-\d\d-\d\d\.pdf$/), content_type: 'application/pdf' });
    const linked = await fetch(w.image.url);
    expect(linked.status).toBe(200);
    expect(linked.headers.get('content-type')).toBe('image/png');
    expect((await fetch(w.image.url.replace(/sig=[^&]+/, 'sig=AAAA'))).status).toBe(404);
    // What the picture shows: the KPI's value (the text of the rendered page is not in the PNG; check the webhook
    // image is not a login screen by its size, and the email carries both files).
    expect(img.length).toBeGreaterThan(8000);
    const m = mails.at(-1)!;
    expect(m.data).toMatch(/Content-Type: image\/png/);
    expect(m.data).toMatch(/Content-Type: application\/pdf/);
    // Agents see the dashboard as a picture.
    const env: ToolEnv = { ctx, principal: admin, via: 'rest', defaultWorkspaceId: wsId, agent: null };
    const tool = buildTools(ctx.cfg).find((t) => t.name === 'snapshot_dashboard')!;
    const shot = await runTool(env, tool, { dashboard_id: dash.id });
    expect(shot.isError, JSON.stringify(shot.content)).toBeFalsy();
    expect(shot.content.some((c) => c.type === 'image' && c.mimeType === 'image/png')).toBe(true);
    ctx.cfg.server.public_url = 'https://duckview.example.com';
    await api('DELETE', `/api/snapshots/${snap.id}`);
    for (const c of [ch, email]) await api('DELETE', `/api/channels/${c.id}`);
  }, 180_000);
});
