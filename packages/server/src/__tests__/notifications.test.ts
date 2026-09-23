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
    env: { DUCKVIEW_DATA_DIR: path.join(dir, 'data'), DUCKVIEW_FILESYSTEM_MODE: 'full', DUCKDB_TEMP_DIRECTORY: path.join(dir, 'spill'), DATABASE_URL: ':memory:', DUCKDB_MEMORY_LIMIT: '512MB', DUCKVIEW_ADMIN_EMAIL: 'admin@test.local', DUCKVIEW_ADMIN_PASSWORD: 'super-secret-pw', DUCKVIEW__duckdb__sync_scheduler_enabled: 'false', DUCKVIEW__apps__enabled: 'false', DUCKVIEW__notifications__allow_private_targets: 'true', DUCKVIEW__notifications__pagerduty_url: `${hook}/pd`, DUCKVIEW_PUBLIC_URL: 'https://duckview.example.com', LOG_LEVEL: 'silent' },
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
