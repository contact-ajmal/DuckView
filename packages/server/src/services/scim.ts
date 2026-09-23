/**
 * SCIM 2.0 provisioning (RFC 7643 / 7644) for identity providers — Okta, Entra ID, OneLogin, JumpCloud.
 *
 *   Users   ↔ DuckView users: userName (an email) is the email, active=false deactivates, externalId is kept.
 *             Users created here sign in with SSO; they have no password.
 *   Groups  ↔ DuckView teams: the team's external_id is the group's externalId, or its displayName when the IdP
 *             sends none — the same value an OIDC `groups` claim carries, so SSO sign-in and SCIM agree on
 *             membership. A team an admin pre-linked to that IdP group is adopted rather than duplicated, so
 *             workspaces can be shared with a group before anyone in it has signed in.
 *
 * The IdP authenticates with one bearer token (config `auth.scim.token`, or generated from the console and stored
 * as a SHA-256 hash). Everything here acts as the platform, not as a user.
 */
import crypto from 'node:crypto';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { MetadataStore } from '../db/index.js';
import type { Group, User } from '../db/schema/sqlite.js';
import type { DuckViewConfig } from '../config/index.js';
import { constantTimeEqual, hashToken, newId } from '../security/crypto.js';
import { HttpError } from './errors.js';
import type { AuthService } from './auth.js';
import type { WorkspaceService } from './workspaces.js';
import { logger } from '../observability/logger.js';

export const SCIM_USER = 'urn:ietf:params:scim:schemas:core:2.0:User';
export const SCIM_GROUP = 'urn:ietf:params:scim:schemas:core:2.0:Group';
export const SCIM_LIST = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
export const SCIM_PATCH = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
export const SCIM_ERROR = 'urn:ietf:params:scim:api:messages:2.0:Error';

const TOKEN_KEY = 'scim';
const TOKEN_PREFIX = 'dvscim_';
const MAX_PAGE = 200;

/** A SCIM error: HTTP status plus the RFC 7644 §3.12 scimType. */
export const scimError = (status: number, detail: string, scimType?: string) => new HttpError(status, detail, scimType ?? 'SCIM', { scimType });

type Json = Record<string, unknown>;
type Filter = { attr: string; value: string }[];
export interface ListParams {
  filter?: string;
  startIndex?: number;
  count?: number;
  excludeMembers?: boolean;
}

const normaliseName = (name: string) => name.trim().replace(/\s+/g, ' ').slice(0, 80);
const isEmail = (v: unknown): v is string => typeof v === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.trim());
/** Entra sends booleans as "True"/"False". */
const bool = (v: unknown): boolean => (typeof v === 'string' ? v.trim().toLowerCase() === 'true' : !!v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** `attr eq "value"` clauses joined by `and` — the subset every mainstream IdP uses. */
export function parseFilter(filter: string | undefined, allowed: string[]): Filter {
  if (!filter?.trim()) return [];
  const clauses = filter.trim().split(/\s+and\s+/i);
  return clauses.map((c) => {
    const m = /^([A-Za-z][\w.]*)\s+eq\s+"((?:[^"\\]|\\.)*)"$/i.exec(c.trim());
    if (!m) throw scimError(400, `Unsupported filter: ${c}. Only attr eq "value" (joined by and) is supported.`, 'invalidFilter');
    const attr = allowed.find((a) => a.toLowerCase() === m[1]!.toLowerCase());
    if (!attr) throw scimError(400, `Filtering on ${m[1]} is not supported`, 'invalidFilter');
    return { attr, value: m[2]!.replace(/\\(.)/g, '$1') };
  });
}

function page<T>(items: T[], p: ListParams): { schemas: string[]; totalResults: number; startIndex: number; itemsPerPage: number; Resources: T[] } {
  const start = Math.max(1, p.startIndex ?? 1);
  const count = Math.min(MAX_PAGE, Math.max(0, p.count ?? MAX_PAGE));
  const slice = items.slice(start - 1, start - 1 + count);
  return { schemas: [SCIM_LIST], totalResults: items.length, startIndex: start, itemsPerPage: slice.length, Resources: slice };
}

/** The fields a SCIM User body or PATCH can set, flattened. `undefined` = not mentioned. */
interface UserFields {
  userName?: string | null;
  email?: string | null;
  displayName?: string | null;
  givenName?: string | null;
  familyName?: string | null;
  formatted?: string | null;
  externalId?: string | null;
  active?: boolean;
}

function fieldsFromResource(body: Json): UserFields {
  const f: UserFields = {};
  if ('userName' in body) f.userName = str(body.userName);
  if ('displayName' in body) f.displayName = str(body.displayName);
  if ('externalId' in body) f.externalId = str(body.externalId);
  if ('active' in body) f.active = bool(body.active);
  const name = body.name as Json | undefined;
  if (name && typeof name === 'object') {
    if ('givenName' in name) f.givenName = str(name.givenName);
    if ('familyName' in name) f.familyName = str(name.familyName);
    if ('formatted' in name) f.formatted = str(name.formatted);
  }
  if (Array.isArray(body.emails)) {
    const emails = body.emails as Json[];
    const primary = emails.find((e) => bool(e.primary)) ?? emails.find((e) => e.type === 'work') ?? emails[0];
    f.email = str(primary?.value);
  }
  // Entra flattens attributes into a PATCH value object: { "name.givenName": "Ada", "emails[type eq \"work\"].value": "…" }.
  for (const [k, v] of Object.entries(body)) {
    if (!k.includes('.') && !k.includes('[')) continue;
    applyPath(f, k, v);
  }
  return f;
}

function applyPath(f: UserFields, path: string, value: unknown): void {
  const p = path.replace(/^urn:ietf:params:scim:schemas:core:2\.0:User:/i, '').toLowerCase();
  if (p === 'active') f.active = bool(value);
  else if (p === 'username') f.userName = str(value);
  else if (p === 'displayname') f.displayName = str(value);
  else if (p === 'externalid') f.externalId = str(value);
  else if (p === 'name.givenname') f.givenName = str(value);
  else if (p === 'name.familyname') f.familyName = str(value);
  else if (p === 'name.formatted') f.formatted = str(value);
  else if (p === 'name' && value && typeof value === 'object') Object.assign(f, fieldsFromResource({ name: value }));
  else if (p === 'emails' && Array.isArray(value)) f.email = fieldsFromResource({ emails: value }).email;
  else if (p.startsWith('emails[') && p.endsWith('].value')) f.email = str(value);
  // Anything else (title, enterprise extension, phone numbers…) DuckView does not keep.
}

export class ScimService {
  constructor(
    private readonly store: MetadataStore,
    private readonly cfg: DuckViewConfig,
    private readonly auth: AuthService,
    private readonly workspaces: WorkspaceService,
  ) {}
  private get db() {
    return this.store.db;
  }
  private get s() {
    return this.store.schema;
  }

  // ---------- token ----------

  async tokenStatus(): Promise<{ enabled: boolean; source: 'config' | 'console' | null; prefix: string | null; created_at: string | null; on_delete: 'deactivate' | 'delete' }> {
    const base = { enabled: this.cfg.auth.scim.enabled, on_delete: this.cfg.auth.scim.on_delete };
    if (this.cfg.auth.scim.token) return { ...base, source: 'config', prefix: null, created_at: null };
    const row = await this.stored();
    return { ...base, source: row ? 'console' : null, prefix: row ? String(row.prefix) : null, created_at: row ? String(row.created_at) : null };
  }

  /** A new console token (replacing any earlier one), shown once. */
  async rotateToken(userId: string): Promise<string> {
    const token = TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
    const value = { hash: hashToken(token), prefix: token.slice(0, TOKEN_PREFIX.length + 4), created_at: new Date().toISOString() };
    const row = { key: TOKEN_KEY, value, encrypted_value: null, iv: null, tag: null, updated_by: userId, updated_at: new Date() };
    if (await this.stored()) await this.db.update(this.s.appSettings).set(row).where(eq(this.s.appSettings.key, TOKEN_KEY));
    else await this.db.insert(this.s.appSettings).values(row);
    return token;
  }

  async revokeToken(): Promise<void> {
    await this.db.delete(this.s.appSettings).where(eq(this.s.appSettings.key, TOKEN_KEY));
  }

  async verify(raw: string): Promise<boolean> {
    if (!this.cfg.auth.scim.enabled || !raw) return false;
    if (this.cfg.auth.scim.token) return constantTimeEqual(hashToken(raw), hashToken(this.cfg.auth.scim.token));
    const row = await this.stored();
    return !!row && constantTimeEqual(hashToken(raw), String(row.hash));
  }

  private async stored(): Promise<Record<string, unknown> | null> {
    const r = (await this.db.select().from(this.s.appSettings).where(eq(this.s.appSettings.key, TOKEN_KEY)).limit(1))[0];
    return r?.value ?? null;
  }

  // ---------- users ----------

  private async groupsOf(userIds: string[]): Promise<Map<string, { value: string; display: string }[]>> {
    const out = new Map<string, { value: string; display: string }[]>();
    if (userIds.length === 0) return out;
    const rows = await this.db
      .select({ user_id: this.s.groupMembers.user_id, id: this.s.groups.id, name: this.s.groups.name })
      .from(this.s.groupMembers)
      .innerJoin(this.s.groups, eq(this.s.groups.id, this.s.groupMembers.group_id))
      .where(inArray(this.s.groupMembers.user_id, userIds));
    for (const r of rows) out.set(r.user_id, [...(out.get(r.user_id) ?? []), { value: r.id, display: r.name }]);
    return out;
  }

  userResource(u: User, base: string, groups: { value: string; display: string }[] = []): Json {
    return {
      schemas: [SCIM_USER],
      id: u.id,
      ...(u.external_id ? { externalId: u.external_id } : {}),
      userName: u.email,
      name: { formatted: u.display_name ?? u.email },
      displayName: u.display_name ?? u.email,
      active: !u.disabled,
      emails: [{ value: u.email, type: 'work', primary: true }],
      groups: groups.map((g) => ({ ...g, $ref: `${base}/Groups/${g.value}` })),
      meta: { resourceType: 'User', created: u.created_at.toISOString(), lastModified: u.created_at.toISOString(), location: `${base}/Users/${u.id}` },
    };
  }

  async listUsers(base: string, p: ListParams): Promise<Json> {
    const filter = parseFilter(p.filter, ['userName', 'externalId', 'id', 'emails.value', 'emails', 'displayName']);
    let users = await this.db.select().from(this.s.users).orderBy(asc(this.s.users.created_at));
    for (const { attr, value } of filter) {
      const v = value.toLowerCase();
      users = users.filter((u) => {
        if (attr === 'userName' || attr === 'emails.value' || attr === 'emails') return u.email === v;
        if (attr === 'externalId') return u.external_id === value;
        if (attr === 'id') return u.id === value;
        return (u.display_name ?? '').toLowerCase() === v;
      });
    }
    const out = page(users, p);
    const groups = await this.groupsOf(out.Resources.map((u) => u.id));
    return { ...out, Resources: out.Resources.map((u) => this.userResource(u, base, groups.get(u.id))) };
  }

  async getUser(base: string, id: string): Promise<Json> {
    const u = await this.auth.findById(id);
    if (!u) throw scimError(404, `User ${id} not found`);
    return this.userResource(u, base, (await this.groupsOf([u.id])).get(u.id));
  }

  /** The email a SCIM user signs in with: userName when it is an address (so `userName eq` filters match), else the primary email. */
  private emailOf(f: UserFields, current?: string): string {
    const candidate = isEmail(f.userName) ? f.userName : isEmail(f.email) ? f.email : undefined;
    if (candidate) return candidate.toLowerCase().trim();
    if (current && f.userName === undefined && f.email === undefined) return current;
    throw scimError(400, 'userName or a primary email must be an email address', 'invalidValue');
  }

  private displayOf(f: UserFields): string | null | undefined {
    if (f.displayName !== undefined) return f.displayName;
    if (f.formatted !== undefined) return f.formatted;
    if (f.givenName !== undefined || f.familyName !== undefined) return [f.givenName, f.familyName].filter(Boolean).join(' ') || null;
    return undefined;
  }

  async createUser(base: string, body: Json): Promise<Json> {
    const f = fieldsFromResource(body);
    const email = this.emailOf(f);
    if (await this.auth.findByEmail(email)) throw scimError(409, `A user with userName ${email} already exists`, 'uniqueness');
    const user: User = { id: newId(), email, password_hash: null, auth_provider: 'oidc', role: 'USER', display_name: this.displayOf(f) ?? null, external_id: f.externalId ?? null, disabled: f.active === false, created_at: new Date() };
    await this.db.insert(this.s.users).values(user);
    logger().info({ email }, 'SCIM: user provisioned');
    return this.userResource(user, base);
  }

  /** PUT replaces the attributes DuckView keeps; PATCH applies operations. Both end in the same update. */
  async replaceUser(base: string, id: string, body: Json): Promise<Json> {
    return this.applyUser(base, id, fieldsFromResource(body));
  }

  async patchUser(base: string, id: string, body: Json): Promise<Json> {
    const f: UserFields = {};
    for (const op of this.operations(body)) {
      if (op.path) {
        if (op.op === 'remove') applyPath(f, op.path, null);
        else applyPath(f, op.path, op.value);
      } else if (op.value && typeof op.value === 'object') Object.assign(f, fieldsFromResource(op.value as Json));
    }
    return this.applyUser(base, id, f);
  }

  private async applyUser(base: string, id: string, f: UserFields): Promise<Json> {
    const u = await this.auth.findById(id);
    if (!u) throw scimError(404, `User ${id} not found`);
    const set: Partial<User> = {};
    if (f.userName !== undefined || f.email !== undefined) {
      const email = this.emailOf(f, u.email);
      if (email !== u.email) {
        const clash = await this.auth.findByEmail(email);
        if (clash && clash.id !== u.id) throw scimError(409, `A user with userName ${email} already exists`, 'uniqueness');
        set.email = email;
      }
    }
    const display = this.displayOf(f);
    if (display !== undefined) set.display_name = display;
    if (f.externalId !== undefined) set.external_id = f.externalId;
    if (Object.keys(set).length) await this.db.update(this.s.users).set(set).where(eq(this.s.users.id, id));
    if (f.active !== undefined && f.active === u.disabled) {
      try {
        await this.auth.setDisabled(id, !f.active);
      } catch (err) {
        throw scimError(400, (err as Error).message, 'mutability');
      }
      logger().info({ email: u.email, active: f.active }, 'SCIM: user active changed');
    }
    return this.getUser(base, id);
  }

  async deleteUser(id: string): Promise<void> {
    const u = await this.auth.findById(id);
    if (!u) throw scimError(404, `User ${id} not found`);
    try {
      if (!u.disabled) await this.auth.setDisabled(id, true);
    } catch (err) {
      throw scimError(400, (err as Error).message, 'mutability');
    }
    if (this.cfg.auth.scim.on_delete === 'delete') {
      await this.auth.deleteUser(id);
      await this.workspaces.purgeUserGrants(id);
    }
    logger().info({ email: u.email, mode: this.cfg.auth.scim.on_delete }, 'SCIM: user deprovisioned');
  }

  // ---------- groups ----------

  private async membersOf(groupIds: string[]): Promise<Map<string, { value: string; display: string }[]>> {
    const out = new Map<string, { value: string; display: string }[]>();
    if (groupIds.length === 0) return out;
    const rows = await this.db
      .select({ group_id: this.s.groupMembers.group_id, id: this.s.users.id, email: this.s.users.email })
      .from(this.s.groupMembers)
      .innerJoin(this.s.users, eq(this.s.users.id, this.s.groupMembers.user_id))
      .where(inArray(this.s.groupMembers.group_id, groupIds));
    for (const r of rows) out.set(r.group_id, [...(out.get(r.group_id) ?? []), { value: r.id, display: r.email }]);
    return out;
  }

  groupResource(g: Group, base: string, members?: { value: string; display: string }[]): Json {
    return {
      schemas: [SCIM_GROUP],
      id: g.id,
      displayName: g.name,
      ...(g.external_id ? { externalId: g.external_id } : {}),
      ...(members ? { members: members.map((m) => ({ ...m, $ref: `${base}/Users/${m.value}` })) } : {}),
      meta: { resourceType: 'Group', created: g.created_at.toISOString(), lastModified: g.updated_at.toISOString(), location: `${base}/Groups/${g.id}` },
    };
  }

  /** Only IdP-linked teams are SCIM groups; teams made by hand in DuckView stay out of the IdP's view. */
  async listGroups(base: string, p: ListParams): Promise<Json> {
    const filter = parseFilter(p.filter, ['displayName', 'externalId', 'id', 'members', 'members.value']);
    let groups = (await this.db.select().from(this.s.groups).orderBy(asc(this.s.groups.name))).filter((g) => g.external_id !== null);
    const members = await this.membersOf(groups.map((g) => g.id));
    for (const { attr, value } of filter) {
      groups = groups.filter((g) => {
        if (attr === 'displayName') return g.name.toLowerCase() === value.toLowerCase() || g.external_id === value;
        if (attr === 'externalId') return g.external_id === value;
        if (attr === 'id') return g.id === value;
        return (members.get(g.id) ?? []).some((m) => m.value === value);
      });
    }
    const out = page(groups, p);
    return { ...out, Resources: out.Resources.map((g) => this.groupResource(g, base, p.excludeMembers ? undefined : members.get(g.id) ?? [])) };
  }

  private async group(id: string): Promise<Group> {
    const g = (await this.db.select().from(this.s.groups).where(eq(this.s.groups.id, id)).limit(1))[0];
    if (!g || g.external_id === null) throw scimError(404, `Group ${id} not found`);
    return g;
  }

  async getGroup(base: string, id: string, excludeMembers = false): Promise<Json> {
    const g = await this.group(id);
    return this.groupResource(g, base, excludeMembers ? undefined : (await this.membersOf([id])).get(id) ?? []);
  }

  private async uniqueName(name: string, exceptId?: string): Promise<string> {
    const base = normaliseName(name) || 'Team';
    for (let i = 0; i < 50; i++) {
      const candidate = i === 0 ? base : i === 1 ? `${base} (SSO)` : `${base} (SSO ${i})`;
      const clash = (await this.db.select({ id: this.s.groups.id }).from(this.s.groups).where(eq(this.s.groups.name, candidate)).limit(1))[0];
      if (!clash || clash.id === exceptId) return candidate;
    }
    throw scimError(409, `A team named ${base} already exists`, 'uniqueness');
  }

  /**
   * A new group — or the team already linked to it (pre-linked by an admin, or created when a member signed in
   * with SSO), which is adopted: its name follows the IdP and its members are set from the request.
   */
  async createGroup(base: string, body: Json): Promise<Json> {
    const displayName = str(body.displayName);
    if (!displayName) throw scimError(400, 'displayName is required', 'invalidValue');
    const externalId = str(body.externalId) ?? displayName;
    const existing = (await this.db.select().from(this.s.groups).where(eq(this.s.groups.external_id, externalId)).limit(1))[0];
    let id: string;
    if (existing) {
      id = existing.id;
      await this.db.update(this.s.groups).set({ name: await this.uniqueName(displayName, id), updated_at: new Date() }).where(eq(this.s.groups.id, id));
    } else {
      const now = new Date();
      id = newId();
      await this.db.insert(this.s.groups).values({ id, name: await this.uniqueName(displayName), description: 'Provisioned by the identity provider (SCIM)', external_id: externalId, created_by: null, created_at: now, updated_at: now });
    }
    if (Array.isArray(body.members)) await this.setMembers(id, this.memberIds(body.members));
    logger().info({ group: displayName, external_id: externalId, adopted: !!existing }, 'SCIM: group provisioned');
    return this.getGroup(base, id);
  }

  async replaceGroup(base: string, id: string, body: Json): Promise<Json> {
    const g = await this.group(id);
    const set: Partial<Group> = { updated_at: new Date() };
    const displayName = str(body.displayName);
    if (displayName) set.name = await this.uniqueName(displayName, id);
    const externalId = str(body.externalId);
    if (externalId && externalId !== g.external_id) set.external_id = await this.freeExternalId(externalId, id);
    await this.db.update(this.s.groups).set(set).where(eq(this.s.groups.id, id));
    await this.setMembers(id, Array.isArray(body.members) ? this.memberIds(body.members) : []);
    return this.getGroup(base, id);
  }

  async patchGroup(base: string, id: string, body: Json): Promise<Json | null> {
    const g = await this.group(id);
    const ops = this.operations(body);
    let add: string[] = [];
    let remove: string[] = [];
    let replace: string[] | null = null;
    const set: Partial<Group> = {};
    for (const op of ops) {
      const path = op.path?.toLowerCase() ?? '';
      const filtered = /^members\[value eq "([^"]+)"\]$/i.exec(op.path ?? '');
      if (filtered && op.op === 'remove') remove.push(filtered[1]!);
      else if (path === 'members') {
        const ids = Array.isArray(op.value) ? this.memberIds(op.value) : [];
        if (op.op === 'add') add.push(...ids);
        else if (op.op === 'remove' && ids.length) remove.push(...ids);
        else {
          // replace, or remove without a value (= remove everyone)
          replace = op.op === 'replace' ? ids : [];
          add = [];
          remove = [];
        }
      } else if (path === 'displayname' && op.op !== 'remove' && str(op.value)) set.name = await this.uniqueName(str(op.value)!, id);
      else if (path === 'externalid' && op.op !== 'remove' && str(op.value)) set.external_id = await this.freeExternalId(str(op.value)!, id);
      else if (!op.path && op.value && typeof op.value === 'object') {
        const v = op.value as Json;
        if (str(v.displayName)) set.name = await this.uniqueName(str(v.displayName)!, id);
        if (str(v.externalId) && str(v.externalId) !== g.external_id) set.external_id = await this.freeExternalId(str(v.externalId)!, id);
        if (Array.isArray(v.members)) {
          const ids = this.memberIds(v.members);
          if (op.op === 'add') add.push(...ids);
          else {
            replace = ids;
            add = [];
            remove = [];
          }
        }
      }
    }
    if (Object.keys(set).length) await this.db.update(this.s.groups).set({ ...set, updated_at: new Date() }).where(eq(this.s.groups.id, id));
    const current = new Set(((await this.membersOf([id])).get(id) ?? []).map((m) => m.value));
    const next = replace ? new Set(replace) : new Set(current);
    for (const u of add) next.add(u);
    for (const u of remove) next.delete(u);
    await this.setMembers(id, [...next]);
    // Entra asks for 204 on PATCH; returning the resource (200) is also allowed — the route decides.
    return this.getGroup(base, id);
  }

  async deleteGroup(id: string): Promise<void> {
    await this.group(id);
    await this.db.delete(this.s.groups).where(eq(this.s.groups.id, id));
    await this.db.delete(this.s.workspaceMembers).where(and(eq(this.s.workspaceMembers.subject_type, 'group'), eq(this.s.workspaceMembers.subject_id, id)));
    logger().info({ group: id }, 'SCIM: group deprovisioned');
  }

  private async freeExternalId(externalId: string, id: string): Promise<string> {
    const clash = (await this.db.select({ id: this.s.groups.id }).from(this.s.groups).where(eq(this.s.groups.external_id, externalId)).limit(1))[0];
    if (clash && clash.id !== id) throw scimError(409, `Another team is already linked to ${externalId}`, 'uniqueness');
    return externalId;
  }

  private memberIds(members: unknown[]): string[] {
    return members.map((m) => str((m as Json)?.value)).filter((v): v is string => !!v);
  }

  /**
   * Makes the group's membership exactly `userIds` (unknown users are skipped). Members of a group listed in
   * `auth.oidc.admin_groups` become administrators — the same one-way promotion SSO sign-in applies.
   */
  private async setMembers(groupId: string, userIds: string[]): Promise<void> {
    const wanted = [...new Set(userIds)];
    const known = wanted.length ? (await this.db.select({ id: this.s.users.id }).from(this.s.users).where(inArray(this.s.users.id, wanted))).map((u) => u.id) : [];
    const skipped = wanted.filter((u) => !known.includes(u));
    if (skipped.length) logger().warn({ group: groupId, skipped }, 'SCIM: unknown members skipped');
    const current = (await this.db.select({ user_id: this.s.groupMembers.user_id }).from(this.s.groupMembers).where(eq(this.s.groupMembers.group_id, groupId))).map((r) => r.user_id);
    const add = known.filter((u) => !current.includes(u));
    const drop = current.filter((u) => !known.includes(u));
    const now = new Date();
    if (add.length) await this.db.insert(this.s.groupMembers).values(add.map((user_id) => ({ group_id: groupId, user_id, role: 'MEMBER' as const, added_at: now })));
    if (drop.length) await this.db.delete(this.s.groupMembers).where(and(eq(this.s.groupMembers.group_id, groupId), inArray(this.s.groupMembers.user_id, drop)));
    if (add.length || drop.length) await this.db.update(this.s.groups).set({ updated_at: now }).where(eq(this.s.groups.id, groupId));
    const g = (await this.db.select().from(this.s.groups).where(eq(this.s.groups.id, groupId)).limit(1))[0];
    const adminGroups = new Set(this.cfg.auth.oidc.admin_groups);
    if (g && add.length && (adminGroups.has(g.name) || (g.external_id && adminGroups.has(g.external_id)))) {
      for (const u of add) await this.auth.updateRole(u, 'ADMIN');
    }
  }

  // ---------- shared ----------

  private operations(body: Json): { op: 'add' | 'replace' | 'remove'; path?: string; value?: unknown }[] {
    const ops = Array.isArray(body.Operations) ? (body.Operations as Json[]) : null;
    if (!ops) throw scimError(400, 'A PatchOp body needs an Operations array', 'invalidSyntax');
    return ops.map((o) => {
      const op = String(o.op ?? '').toLowerCase();
      if (op !== 'add' && op !== 'replace' && op !== 'remove') throw scimError(400, `Unsupported op ${String(o.op)}`, 'invalidSyntax');
      return { op, path: str(o.path) ?? undefined, value: o.value };
    });
  }
}

