/**
 * Comments and mentions. A thread is a first comment on something in a workspace — a notebook (or one of its
 * cells), a dashboard (or a widget), a saved query, a data app, a table (or a column) — and its replies.
 *
 *  - Anyone who can see the workspace can comment (viewers included); people edit and delete their own comments,
 *    owners delete any; editors and the thread's author resolve and reopen threads.
 *  - @someone@example.com mentions a person with access to the workspace (directly, through a team, or as its
 *    owner). They get an inbox item and, when a mail server is set up, an email; people already in a thread get an
 *    inbox item for each reply. Mentions of people without access are left as plain text.
 */
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { MetadataStore } from '../db/index.js';
import { COMMENT_TARGETS, type Comment, type CommentTarget } from '../db/schema/sqlite.js';
import { newId } from '../security/crypto.js';
import type { Principal } from './principal.js';
import { requireWrite, roleAtLeast } from './principal.js';
import type { WorkspaceService } from './workspaces.js';
import type { NotificationService } from './notifications.js';
import type { AuditService } from './audit.js';
import { badRequest, forbidden, notFound } from './errors.js';
import { liveEvents } from '../observability/events.js';

export interface Person { id: string; email: string; name: string }
export type CommentView = Comment & { author: Person | null; mentioned: Person[]; replies?: CommentView[] };
export interface InboxView { id: string; kind: 'mention' | 'reply'; read: boolean; created_at: Date; workspace_id: string; workspace: string | null; actor: Person | null; comment: { id: string; body: string; target_type: CommentTarget; target_id: string; anchor: string | null; thread_id: string }; target_label: string; url: string }

const MENTION = /(^|[^\w@.])@([\w.+-]+@[\w-]+(?:\.[\w-]+)+)/g;
export const mentionedEmails = (body: string) => [...new Set([...body.matchAll(MENTION)].map((m) => m[2]!.toLowerCase().replace(/\.$/, '')))];

export class CommentService {
  constructor(private readonly store: MetadataStore, private readonly workspaces: WorkspaceService, private readonly notifications: NotificationService, private readonly audit: AuditService) {}
  private get db() {
    return this.store.db;
  }
  private get s() {
    return this.store.schema;
  }

  /** Everyone with access to the workspace: its owner, members, and members of teams it is shared with. */
  async people(p: Principal, workspaceId: string): Promise<Person[]> {
    const w = await this.workspaces.get(p, workspaceId);
    const grants = await this.db.select().from(this.s.workspaceMembers).where(eq(this.s.workspaceMembers.workspace_id, workspaceId));
    const ids = new Set<string>([w.user_id, ...grants.filter((g) => g.subject_type === 'user').map((g) => g.subject_id)]);
    const groupIds = grants.filter((g) => g.subject_type === 'group').map((g) => g.subject_id);
    if (groupIds.length) for (const m of await this.db.select({ user_id: this.s.groupMembers.user_id }).from(this.s.groupMembers).where(inArray(this.s.groupMembers.group_id, groupIds))) ids.add(m.user_id);
    const users = ids.size ? await this.db.select({ id: this.s.users.id, email: this.s.users.email, display_name: this.s.users.display_name, disabled: this.s.users.disabled }).from(this.s.users).where(inArray(this.s.users.id, [...ids])) : [];
    return users.filter((u) => !u.disabled).map((u) => ({ id: u.id, email: u.email, name: u.display_name ?? u.email })).sort((a, b) => a.name.localeCompare(b.name));
  }

  private async checkTarget(workspaceId: string, type: CommentTarget, id: string): Promise<string> {
    const where = <T extends { id: unknown; workspace_id: unknown }>(t: T) => and(eq(t.id as never, id), eq(t.workspace_id as never, workspaceId));
    const found = async (rows: { name: string }[]) => {
      if (!rows[0]) throw notFound(type === 'query' ? 'Saved query' : type[0]!.toUpperCase() + type.slice(1));
      return rows[0].name;
    };
    switch (type) {
      case 'notebook':
        return found(await this.db.select({ name: this.s.notebooks.title }).from(this.s.notebooks).where(where(this.s.notebooks)).limit(1));
      case 'dashboard':
        return found(await this.db.select({ name: this.s.dashboards.name }).from(this.s.dashboards).where(where(this.s.dashboards)).limit(1));
      case 'query':
        return found(await this.db.select({ name: this.s.savedQueries.name }).from(this.s.savedQueries).where(where(this.s.savedQueries)).limit(1));
      case 'app':
        return found(await this.db.select({ name: this.s.dataApps.name }).from(this.s.dataApps).where(where(this.s.dataApps)).limit(1));
      case 'table':
        if (!/^[\w$." -]{1,200}$/.test(id)) throw badRequest('target_id must be a table name');
        return id;
    }
  }

  private url(c: Pick<Comment, 'target_type' | 'target_id' | 'id' | 'parent_id'>): string {
    const thread = c.parent_id ?? c.id;
    switch (c.target_type) {
      case 'notebook':
        return `/#/notebooks/${c.target_id}?comment=${thread}`;
      case 'dashboard':
        return `/#/dashboards/${c.target_id}?comment=${thread}`;
      case 'app':
        return `/#/apps?app=${c.target_id}&comment=${thread}`;
      case 'query':
        return `/#/query?saved=${c.target_id}&comment=${thread}`;
      case 'table':
        return `/#/data?table=${encodeURIComponent(c.target_id)}&comment=${thread}`;
    }
  }

  private async decorate(rows: Comment[]): Promise<CommentView[]> {
    const ids = [...new Set(rows.flatMap((r) => [r.user_id, ...r.mentions]))];
    const users = ids.length ? await this.db.select({ id: this.s.users.id, email: this.s.users.email, display_name: this.s.users.display_name }).from(this.s.users).where(inArray(this.s.users.id, ids)) : [];
    const by = new Map(users.map((u) => [u.id, { id: u.id, email: u.email, name: u.display_name ?? u.email }]));
    return rows.map((r) => ({ ...r, author: by.get(r.user_id) ?? null, mentioned: r.mentions.map((m) => by.get(m)).filter((x): x is Person => !!x) }));
  }

  /** Threads on a target (optionally one anchor), oldest first, with their replies, and open counts per anchor. */
  async list(p: Principal, workspaceId: string, targetType: CommentTarget, targetId: string, opts: { anchor?: string | null } = {}): Promise<{ threads: CommentView[]; open: number; by_anchor: Record<string, number> }> {
    await this.workspaces.get(p, workspaceId);
    if (!COMMENT_TARGETS.includes(targetType)) throw badRequest(`target_type must be ${COMMENT_TARGETS.join(', ')}`);
    const rows = await this.db.select().from(this.s.comments).where(and(eq(this.s.comments.workspace_id, workspaceId), eq(this.s.comments.target_type, targetType), eq(this.s.comments.target_id, targetId))).orderBy(asc(this.s.comments.created_at));
    const all = await this.decorate(rows);
    const roots = all.filter((c) => !c.parent_id);
    const by_anchor: Record<string, number> = {};
    for (const r of roots) if (!r.resolved_at) by_anchor[r.anchor ?? ''] = (by_anchor[r.anchor ?? ''] ?? 0) + 1;
    const threads = roots.filter((r) => opts.anchor === undefined || (r.anchor ?? null) === (opts.anchor ?? null)).map((r) => ({ ...r, replies: all.filter((c) => c.parent_id === r.id) }));
    return { threads, open: roots.filter((r) => !r.resolved_at).length, by_anchor };
  }

  async add(p: Principal, workspaceId: string, input: { target_type?: CommentTarget; target_id?: string; anchor?: string | null; parent_id?: string | null; body: string }): Promise<CommentView> {
    requireWrite(p);
    const ws = await this.workspaces.get(p, workspaceId);
    const body = (input.body ?? '').trim();
    if (!body) throw badRequest('body is required');
    if (body.length > 10_000) throw badRequest('A comment is at most 10,000 characters');
    if (!input.parent_id && (!input.target_type || !input.target_id)) throw badRequest('target_type and target_id are required (or parent_id to reply)');
    let target = { type: input.target_type as CommentTarget, id: input.target_id as string, anchor: input.anchor?.trim() || null };
    let parent: Comment | null = null;
    if (input.parent_id) {
      parent = (await this.db.select().from(this.s.comments).where(and(eq(this.s.comments.id, input.parent_id), eq(this.s.comments.workspace_id, workspaceId))).limit(1))[0] ?? null;
      if (!parent) throw notFound('Thread');
      if (parent.parent_id) parent = (await this.db.select().from(this.s.comments).where(eq(this.s.comments.id, parent.parent_id)).limit(1))[0]!;
      target = { type: parent.target_type, id: parent.target_id, anchor: parent.anchor };
    }
    if (!COMMENT_TARGETS.includes(target.type)) throw badRequest(`target_type must be ${COMMENT_TARGETS.join(', ')}`);
    const label = await this.checkTarget(workspaceId, target.type, target.id);
    const people = await this.people(p, workspaceId);
    const byEmail = new Map(people.map((x) => [x.email.toLowerCase(), x]));
    const mentioned = mentionedEmails(body).map((e) => byEmail.get(e)).filter((x): x is Person => !!x);
    const now = new Date();
    const row: Comment = { id: newId(), workspace_id: workspaceId, target_type: target.type, target_id: target.id, anchor: target.anchor, parent_id: parent?.id ?? null, user_id: p.userId, body, mentions: mentioned.map((m) => m.id), resolved_at: null, resolved_by: null, edited_at: null, created_at: now };
    await this.db.insert(this.s.comments).values(row);
    // A reply reopens a resolved thread.
    if (parent?.resolved_at) await this.db.update(this.s.comments).set({ resolved_at: null, resolved_by: null }).where(eq(this.s.comments.id, parent.id));
    this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'comment.create', resource: `${target.type}:${target.id}`, ip: p.ip });

    // Inbox: mentioned people; for replies, everyone else already in the thread.
    const recipients = new Map<string, 'mention' | 'reply'>();
    for (const m of mentioned) if (m.id !== p.userId) recipients.set(m.id, 'mention');
    if (parent) {
      const inThread = await this.db.select({ user_id: this.s.comments.user_id }).from(this.s.comments).where(eq(this.s.comments.parent_id, parent.id));
      for (const u of [parent.user_id, ...inThread.map((x) => x.user_id)]) if (u !== p.userId && !recipients.has(u) && people.some((x) => x.id === u)) recipients.set(u, 'reply');
    }
    for (const [userId, kind] of recipients) {
      await this.db.insert(this.s.inbox).values({ id: newId(), user_id: userId, workspace_id: workspaceId, kind, comment_id: row.id, actor_id: p.userId, read_at: null, created_at: now });
      liveEvents.publish({ type: 'inbox', at: now.toISOString(), user_id: userId, workspace_id: workspaceId, kind });
    }
    const emails = mentioned.filter((m) => m.id !== p.userId).map((m) => m.email);
    if (emails.length) {
      const what = `${target.type === 'query' ? 'saved query' : target.type} “${label}”${target.anchor ? ` (${target.anchor})` : ''}`;
      void this.notifications.emailPeople(emails, { title: `${p.email} mentioned you in ${what}`, text: body, severity: 'info', url: this.notifications.link(this.url(row)), fields: [{ label: 'Workspace', value: ws.name }], event: 'comment.mention' });
    }
    liveEvents.publish({ type: 'comment', at: now.toISOString(), workspace_id: workspaceId, target_type: target.type, target_id: target.id, comment_id: row.id });
    return (await this.decorate([row]))[0]!;
  }

  private async load(p: Principal, id: string): Promise<{ c: Comment; role: string }> {
    const c = (await this.db.select().from(this.s.comments).where(eq(this.s.comments.id, id)).limit(1))[0];
    if (!c) throw notFound('Comment');
    const w = await this.workspaces.get(p, c.workspace_id);
    return { c, role: w.role };
  }

  async edit(p: Principal, id: string, body: string): Promise<CommentView> {
    requireWrite(p);
    const { c } = await this.load(p, id);
    if (c.user_id !== p.userId) throw forbidden('Only its author edits a comment');
    const text = body.trim();
    if (!text) throw badRequest('body is required');
    const people = await this.people(p, c.workspace_id);
    const byEmail = new Map(people.map((x) => [x.email.toLowerCase(), x]));
    const mentions = mentionedEmails(text).map((e) => byEmail.get(e)?.id).filter((x): x is string => !!x);
    const set = { body: text, mentions, edited_at: new Date() };
    await this.db.update(this.s.comments).set(set).where(eq(this.s.comments.id, id));
    // Newly mentioned people are told too.
    for (const u of mentions.filter((m) => !c.mentions.includes(m) && m !== p.userId)) {
      await this.db.insert(this.s.inbox).values({ id: newId(), user_id: u, workspace_id: c.workspace_id, kind: 'mention', comment_id: id, actor_id: p.userId, read_at: null, created_at: new Date() });
      liveEvents.publish({ type: 'inbox', at: new Date().toISOString(), user_id: u, workspace_id: c.workspace_id, kind: 'mention' });
    }
    liveEvents.publish({ type: 'comment', at: new Date().toISOString(), workspace_id: c.workspace_id, target_type: c.target_type, target_id: c.target_id, comment_id: id });
    return (await this.decorate([{ ...c, ...set }]))[0]!;
  }

  async resolve(p: Principal, id: string, resolved: boolean): Promise<CommentView> {
    requireWrite(p);
    const { c, role } = await this.load(p, id);
    if (c.parent_id) throw badRequest('Resolve the thread (its first comment)');
    if (c.user_id !== p.userId && !roleAtLeast(role as never, 'EDITOR')) throw forbidden('Editors and the thread\'s author resolve threads');
    const set = resolved ? { resolved_at: new Date(), resolved_by: p.userId } : { resolved_at: null, resolved_by: null };
    await this.db.update(this.s.comments).set(set).where(eq(this.s.comments.id, id));
    liveEvents.publish({ type: 'comment', at: new Date().toISOString(), workspace_id: c.workspace_id, target_type: c.target_type, target_id: c.target_id, comment_id: id });
    return (await this.decorate([{ ...c, ...set }]))[0]!;
  }

  async remove(p: Principal, id: string): Promise<void> {
    requireWrite(p);
    const { c, role } = await this.load(p, id);
    if (c.user_id !== p.userId && role !== 'OWNER') throw forbidden('Only its author (or the workspace owner) deletes a comment');
    // A thread goes with its replies.
    if (!c.parent_id) await this.db.delete(this.s.comments).where(eq(this.s.comments.parent_id, id));
    await this.db.delete(this.s.comments).where(eq(this.s.comments.id, id));
    this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'comment.delete', resource: `${c.target_type}:${c.target_id}`, ip: p.ip });
    liveEvents.publish({ type: 'comment', at: new Date().toISOString(), workspace_id: c.workspace_id, target_type: c.target_type, target_id: c.target_id, comment_id: id });
  }

  // ------------------------------------------------------------------------------------------ inbox

  async inboxFor(p: Principal, opts: { unread?: boolean; limit?: number } = {}): Promise<{ items: InboxView[]; unread: number }> {
    const where = opts.unread ? and(eq(this.s.inbox.user_id, p.userId), isNull(this.s.inbox.read_at)) : eq(this.s.inbox.user_id, p.userId);
    const rows = await this.db.select().from(this.s.inbox).where(where).orderBy(desc(this.s.inbox.created_at)).limit(Math.min(opts.limit ?? 50, 200));
    const unread = (await this.db.select({ id: this.s.inbox.id }).from(this.s.inbox).where(and(eq(this.s.inbox.user_id, p.userId), isNull(this.s.inbox.read_at)))).length;
    const commentRows = rows.length ? await this.db.select().from(this.s.comments).where(inArray(this.s.comments.id, rows.map((r) => r.comment_id))) : [];
    const cs = new Map(commentRows.map((c) => [c.id, c]));
    const actorIds = [...new Set(rows.map((r) => r.actor_id).filter((x): x is string => !!x))];
    const actors = actorIds.length ? await this.db.select({ id: this.s.users.id, email: this.s.users.email, display_name: this.s.users.display_name }).from(this.s.users).where(inArray(this.s.users.id, actorIds)) : [];
    const wsIds = [...new Set(rows.map((r) => r.workspace_id))];
    const wss = wsIds.length ? await this.db.select({ id: this.s.workspaces.id, name: this.s.workspaces.name }).from(this.s.workspaces).where(inArray(this.s.workspaces.id, wsIds)) : [];
    const items: InboxView[] = [];
    for (const r of rows) {
      const c = cs.get(r.comment_id);
      if (!c) continue;
      // Access may have been removed since.
      try {
        await this.workspaces.get(p, r.workspace_id);
      } catch {
        continue;
      }
      const a = actors.find((x) => x.id === r.actor_id);
      items.push({ id: r.id, kind: r.kind, read: !!r.read_at, created_at: r.created_at, workspace_id: r.workspace_id, workspace: wss.find((w) => w.id === r.workspace_id)?.name ?? null, actor: a ? { id: a.id, email: a.email, name: a.display_name ?? a.email } : null, comment: { id: c.id, body: c.body.slice(0, 400), target_type: c.target_type, target_id: c.target_id, anchor: c.anchor, thread_id: c.parent_id ?? c.id }, target_label: await this.checkTarget(c.workspace_id, c.target_type, c.target_id).catch(() => c.target_id), url: this.url(c) });
    }
    return { items, unread };
  }

  async markRead(p: Principal, ids: string[] | 'all'): Promise<number> {
    const now = new Date();
    const where = ids === 'all' ? and(eq(this.s.inbox.user_id, p.userId), isNull(this.s.inbox.read_at)) : and(eq(this.s.inbox.user_id, p.userId), inArray(this.s.inbox.id, ids.length ? ids : ['-']));
    const rows = await this.db.select({ id: this.s.inbox.id }).from(this.s.inbox).where(where);
    if (rows.length) await this.db.update(this.s.inbox).set({ read_at: now }).where(inArray(this.s.inbox.id, rows.map((r) => r.id)));
    return rows.length;
  }

  /** For Copilot: open threads on a notebook, by cell. */
  async promptSummary(workspaceId: string, targetType: CommentTarget, targetId: string): Promise<string> {
    const rows = await this.db.select().from(this.s.comments).where(and(eq(this.s.comments.workspace_id, workspaceId), eq(this.s.comments.target_type, targetType), eq(this.s.comments.target_id, targetId))).orderBy(asc(this.s.comments.created_at));
    const all = await this.decorate(rows);
    const open = all.filter((c) => !c.parent_id && !c.resolved_at);
    return open.slice(0, 20).map((t) => `- ${t.anchor ? `on ${t.anchor}: ` : ''}${t.author?.name ?? 'someone'}: ${t.body.replace(/\s+/g, ' ').slice(0, 300)}${all.filter((r) => r.parent_id === t.id).map((r) => `\n  - ${r.author?.name ?? 'someone'}: ${r.body.replace(/\s+/g, ' ').slice(0, 200)}`).join('')}`).join('\n');
  }
}
