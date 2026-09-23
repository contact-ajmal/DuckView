/**
 * Comments and mentions: threads on a notebook cell and a table, replies, @mentions of people with access (directly,
 * through a team, the owner) — inbox items and an email — but not of outsiders; resolving, editing, deleting and who
 * may; the inbox (unread, mark read, access removed); agent tools; Copilot's view of a notebook's open threads.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../config/index.js';
import { initLogger } from '../observability/logger.js';
import { createContext, type AppContext } from '../context.js';
import { buildApp } from '../app.js';
import { buildTools, runTool, type ToolEnv } from '../agent/tools.js';
import { mentionedEmails } from '../services/comments.js';
import type { Principal } from '../services/principal.js';

let dir: string;
let ctx: AppContext;
let app: Awaited<ReturnType<typeof buildApp>>['app'];
let smtp: net.Server;
const mails: { to: string[]; data: string }[] = [];
let base: string;
const tokens: Record<string, string> = {};
const ids: Record<string, string> = {};
let wsId: string;
let nbId: string;
let admin: Principal;

const api = async (method: string, url: string, body?: unknown, who = 'admin') => {
  const res = await fetch(base + url, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), authorization: `Bearer ${tokens[who]}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
};
const comment = (body: Record<string, unknown>, who = 'admin') => api('POST', `/api/workspaces/${wsId}/comments`, body, who);

function fakeSmtp(): net.Server {
  return net.createServer((sock) => {
    let buf = '';
    let inData = false;
    let mail = { to: [] as string[], data: '' };
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
          mail = { to: [], data: '' };
          sock.write('250 queued\r\n');
          continue;
        }
        const i = buf.indexOf('\r\n');
        if (i < 0) return;
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO' || cmd === 'HELO') sock.write('250-fake\r\n250 8BITMIME\r\n');
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
  smtp = fakeSmtp();
  await new Promise<void>((r) => smtp.listen(0, '127.0.0.1', r));
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dv-comments-'));
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  const cfg = loadConfig({ configPath: null, env: { DUCKVIEW_DATA_DIR: path.join(dir, 'data'), DUCKDB_TEMP_DIRECTORY: path.join(dir, 'spill'), DATABASE_URL: ':memory:', DUCKDB_MEMORY_LIMIT: '512MB', DUCKVIEW_ADMIN_EMAIL: 'admin@test.local', DUCKVIEW_ADMIN_PASSWORD: 'super-secret-pw', DUCKVIEW__duckdb__sync_scheduler_enabled: 'false', DUCKVIEW__notifications__scheduler_enabled: 'false', DUCKVIEW__notifications__allow_private_targets: 'true', DUCKVIEW__transform__scheduler_enabled: 'false', DUCKVIEW__apps__enabled: 'false', DUCKVIEW_PUBLIC_URL: 'https://duckview.example.com', LOG_LEVEL: 'silent' } });
  ctx = await createContext(cfg);
  admin = ctx.auth.principalFromUser((await ctx.auth.findByEmail('admin@test.local'))!, 'jwt', '127.0.0.1');
  for (const who of ['editor', 'viewer', 'teammate', 'outsider']) ids[who] = (await ctx.auth.createLocalUser({ email: `${who}@test.local`, password: `${who}-secret-pw`, role: 'USER' })).id;
  ids.admin = admin.userId;
  wsId = (await ctx.workspaces.create(admin, { name: 'Shop', active_db_path: 'shop.duckdb' })).id;
  await ctx.workspaces.setMember(admin, wsId, { subject_type: 'user', subject_id: ids.editor!, role: 'EDITOR' });
  await ctx.workspaces.setMember(admin, wsId, { subject_type: 'user', subject_id: ids.viewer!, role: 'VIEWER' });
  const team = await ctx.groups.create(admin, { name: 'Analysts' });
  await ctx.groups.addMember(admin, team.id, ids.teammate!);
  await ctx.workspaces.setMember(admin, wsId, { subject_type: 'group', subject_id: team.id, role: 'VIEWER' });
  nbId = (await ctx.notebooks.create(admin, wsId, { title: 'Revenue', cells: [{ id: 'c1', type: 'sql', name: 'monthly', source: 'SELECT 1 AS x' }] })).id;
  ({ app } = await buildApp(ctx));
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as net.AddressInfo).port}`;
  tokens.admin = (await (await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@test.local', password: 'super-secret-pw' }) })).json()).token;
  for (const who of ['editor', 'viewer', 'teammate', 'outsider']) tokens[who] = (await (await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: `${who}@test.local`, password: `${who}-secret-pw` }) })).json()).token;
  await api('PUT', '/api/admin/integrations/smtp', { host: '127.0.0.1', port: (smtp.address() as net.AddressInfo).port, secure: false, from: 'DuckView <duckview@example.com>' });
}, 120_000);

afterAll(async () => {
  await app?.close();
  await ctx?.shutdown();
  smtp?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('comments', () => {
  it('finds mentions and who can be mentioned', async () => {
    expect(mentionedEmails('Hi @ada@example.com and @Bob.Smith@corp.example.org. not me@example.com, @nobody')).toEqual(['ada@example.com', 'bob.smith@corp.example.org']);
    const people = (await api('GET', `/api/workspaces/${wsId}/people`, undefined, 'viewer')).json.people.map((p: { email: string }) => p.email);
    expect(people.sort()).toEqual(['admin@test.local', 'editor@test.local', 'teammate@test.local', 'viewer@test.local']);
    expect((await api('GET', `/api/workspaces/${wsId}/people`, undefined, 'outsider')).status).toBe(404);
  });

  it('threads on a notebook cell: mentions reach the inbox and email; outsiders are plain text', async () => {
    const first = await comment({ target_type: 'notebook', target_id: nbId, anchor: 'c1', body: 'Why does @editor@test.local filter out refunds here? cc @teammate@test.local @outsider@test.local' }, 'viewer');
    expect(first.status).toBe(200);
    expect(first.json.comment.mentioned.map((m: { email: string }) => m.email)).toEqual(['editor@test.local', 'teammate@test.local']);
    await new Promise((r) => setTimeout(r, 300));
    expect(mails).toHaveLength(1);
    expect(mails[0]!.to.join(' ')).toMatch(/editor@test\.local[\s\S]*teammate@test\.local/);
    expect(mails[0]!.data).toMatch(/Subject: =\?UTF-8\?Q\?viewer=40test=2Elocal_mentioned_you_in_n\?=\s+=\?UTF-8\?Q\?otebook_=E2=80=9CRevenue=E2=80=9D/);
    expect(mails[0]!.data).toMatch(/Why does @editor@test\.local filter out refunds here\?/);
    expect(mails[0]!.data).toMatch(/duckview\.example\.com\/#\/notebooks\//);
    const inbox = (await api('GET', '/api/inbox', undefined, 'editor')).json;
    expect(inbox.unread).toBe(1);
    expect(inbox.items[0]).toMatchObject({ kind: 'mention', read: false, workspace: 'Shop', actor: { email: 'viewer@test.local' }, target_label: 'Revenue', comment: { target_type: 'notebook', anchor: 'c1' } });
    expect(inbox.items[0].url).toBe(`/#/notebooks/${nbId}?comment=${first.json.comment.id}`);
    expect((await api('GET', '/api/inbox', undefined, 'outsider')).json.unread).toBe(0);
    // A reply tells the others in the thread (not its author); a reply to a reply joins the same thread.
    const reply = await comment({ parent_id: first.json.comment.id, body: 'Refunds are booked in March — see the next cell.' }, 'editor');
    expect(reply.json.comment).toMatchObject({ parent_id: first.json.comment.id, anchor: 'c1' });
    await comment({ parent_id: reply.json.comment.id, body: 'Thanks!' }, 'viewer');
    expect((await api('GET', '/api/inbox?unread=1', undefined, 'viewer')).json.items.map((i: { kind: string }) => i.kind)).toEqual(['reply']);
    expect((await api('GET', '/api/inbox?unread=1', undefined, 'editor')).json.items.map((i: { kind: string }) => i.kind)).toEqual(['reply', 'mention']);
    const list = (await api('GET', `/api/workspaces/${wsId}/comments?target_type=notebook&target_id=${nbId}`)).json;
    expect(list).toMatchObject({ open: 1, by_anchor: { c1: 1 } });
    expect(list.threads[0].replies.map((r: { body: string }) => r.body)).toEqual(['Refunds are booked in March — see the next cell.', 'Thanks!']);
    // Marking read.
    expect((await api('POST', '/api/inbox/read', { all: true }, 'editor')).json.marked).toBe(2);
    expect((await api('GET', '/api/inbox', undefined, 'editor')).json.unread).toBe(0);
  });

  it('resolves, edits and deletes — each by the right people', async () => {
    const thread = (await api('GET', `/api/workspaces/${wsId}/comments?target_type=notebook&target_id=${nbId}`)).json.threads[0];
    // The teammate (a viewer, not the author) cannot resolve; the editor can; a reply reopens it.
    expect((await api('POST', `/api/comments/${thread.id}/resolve`, { resolved: true }, 'teammate')).status).toBe(403);
    expect((await api('POST', `/api/comments/${thread.id}/resolve`, { resolved: true }, 'editor')).json.comment.resolved_at).toBeTruthy();
    expect((await api('GET', `/api/workspaces/${wsId}/comments?target_type=notebook&target_id=${nbId}`)).json.open).toBe(0);
    await comment({ parent_id: thread.id, body: 'One more thing' }, 'teammate');
    expect((await api('GET', `/api/workspaces/${wsId}/comments?target_type=notebook&target_id=${nbId}`)).json.open).toBe(1);
    // Only authors edit; an edit that mentions someone new tells them.
    expect((await api('PATCH', `/api/comments/${thread.id}`, { body: 'x' }, 'editor')).status).toBe(403);
    const edited = (await api('PATCH', `/api/comments/${thread.id}`, { body: 'Why does @editor@test.local filter out refunds? @admin@test.local too' }, 'viewer')).json.comment;
    expect(edited.edited_at).toBeTruthy();
    expect((await api('GET', '/api/inbox?unread=1')).json.items.map((i: { kind: string }) => i.kind)).toEqual(['mention']);
    // The owner deletes anyone's thread; the thread goes with its replies.
    const other = (await comment({ target_type: 'table', target_id: 'orders', anchor: 'amount', body: 'Amounts are in cents?' }, 'editor')).json.comment;
    expect((await api('DELETE', `/api/comments/${other.id}`, undefined, 'viewer')).status).toBe(403);
    expect((await api('DELETE', `/api/comments/${other.id}`)).status).toBe(200);
    expect((await api('DELETE', `/api/comments/${thread.id}`)).status).toBe(200);
    expect((await api('GET', `/api/workspaces/${wsId}/comments?target_type=notebook&target_id=${nbId}`)).json.threads).toEqual([]);
    // Unknown targets and people without access are refused.
    expect((await comment({ target_type: 'notebook', target_id: 'nope', body: 'x' })).status).toBe(404);
    expect((await comment({ target_type: 'notebook', target_id: nbId, body: 'x' }, 'outsider')).status).toBe(404);
  });

  it('keeps the inbox to workspaces people can still see', async () => {
    await comment({ target_type: 'notebook', target_id: nbId, body: 'Ping @viewer@test.local' }, 'editor');
    expect((await api('GET', '/api/inbox?unread=1', undefined, 'viewer')).json.items.some((i: { comment: { body: string } }) => i.comment.body === 'Ping @viewer@test.local')).toBe(true);
    const members = await ctx.workspaces.listMembers(admin, wsId);
    await ctx.workspaces.removeMember(admin, wsId, members.find((m) => m.subject_id === ids.viewer)!.id);
    expect((await api('GET', '/api/inbox', undefined, 'viewer')).json.items).toEqual([]);
  });

  it('serves comments to agents and to Copilot', async () => {
    const env: ToolEnv = { ctx, principal: ctx.auth.principalFromUser((await ctx.auth.findByEmail('admin@test.local'))!, 'token'), via: 'mcp', defaultWorkspaceId: wsId, agent: null };
    const tools = buildTools(ctx.cfg);
    const call = (name: string, args: Record<string, unknown>) => runTool(env, tools.find((t) => t.name === name)!, args);
    const added = await call('add_comment', { target_type: 'notebook', target_id: nbId, anchor: 'c1', body: 'monthly double-counts March — @editor@test.local can you check?' });
    expect(added.structuredContent).toMatchObject({ status: 'ok', mentioned: ['editor@test.local'] });
    const listed = await call('list_comments', { target_type: 'notebook', target_id: nbId });
    expect((listed.content[0] as { text: string }).text).toMatch(/on c1 \*\*[^*]+\*\*: monthly double-counts March/);
    const snap = await ctx.copilot.buildContext(admin, wsId, { notebookId: nbId });
    expect(snap.notebook).toMatch(/Open comments on it[\s\S]*- on c1: [^:\n]+: monthly double-counts March/);
  });
});
