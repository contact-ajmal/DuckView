import { eq, desc, and } from 'drizzle-orm';
import type { MetadataStore } from '../db/index.js';
import type { User, UserRole, TokenScope, ApiToken } from '../db/schema/sqlite.js';
import { TOKEN_SCOPES } from '../db/schema/sqlite.js';
import { hashPassword, verifyPassword, generateApiToken, hashToken, newId } from '../security/crypto.js';
import type { DuckViewConfig } from '../config/index.js';
import { badRequest, conflict, notFound, unauthorized } from './errors.js';
import type { Principal } from './principal.js';
import { logger } from '../observability/logger.js';

export type PublicUser = Omit<User, 'password_hash'>;
export const toPublicUser = (u: User): PublicUser => {
  const { password_hash: _ph, ...rest } = u;
  return rest;
};

const ALL_SCOPES: TokenScope[] = [...TOKEN_SCOPES];

export class AuthService {
  constructor(private readonly store: MetadataStore, private readonly cfg: DuckViewConfig) {}

  private get db() {
    return this.store.db;
  }
  private get s() {
    return this.store.schema;
  }

  async findById(id: string): Promise<User | null> {
    const rows = await this.db.select().from(this.s.users).where(eq(this.s.users.id, id)).limit(1);
    return rows[0] ?? null;
  }

  async findByEmail(email: string): Promise<User | null> {
    const rows = await this.db.select().from(this.s.users).where(eq(this.s.users.email, email.toLowerCase().trim())).limit(1);
    return rows[0] ?? null;
  }

  async countUsers(): Promise<number> {
    const rows = await this.db.select({ id: this.s.users.id }).from(this.s.users);
    return rows.length;
  }

  async listUsers(): Promise<PublicUser[]> {
    const rows = await this.db.select().from(this.s.users).orderBy(desc(this.s.users.created_at));
    return rows.map(toPublicUser);
  }

  async createLocalUser(input: { email: string; password: string; role?: UserRole; displayName?: string }): Promise<User> {
    const email = input.email.toLowerCase().trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw badRequest('Invalid email address');
    if (input.password.length < this.cfg.security.password_min_length) throw badRequest(`Password must be at least ${this.cfg.security.password_min_length} characters`);
    if (await this.findByEmail(email)) throw conflict('A user with that email already exists');
    const user: User = {
      id: newId(),
      email,
      password_hash: await hashPassword(input.password),
      auth_provider: 'local',
      role: input.role ?? 'USER',
      display_name: input.displayName ?? null,
      external_id: null,
      created_at: new Date(),
    };
    await this.db.insert(this.s.users).values(user);
    return user;
  }

  /**
   * Creates or refreshes an SSO user. `groups` is the IdP group claim: membership of any `auth.oidc.admin_groups`
   * entry (or an `admin_emails` match) promotes to ADMIN. Promotion is one-way — nothing here demotes.
   */
  async upsertOidcUser(input: { email: string; externalId: string; displayName?: string | null; groups?: string[] }): Promise<User> {
    const email = input.email.toLowerCase().trim();
    const existing = await this.findByEmail(email);
    const adminEmails = this.cfg.auth.oidc.admin_emails.map((e) => e.toLowerCase());
    const adminGroups = new Set(this.cfg.auth.oidc.admin_groups);
    const promoted = adminEmails.includes(email) || (input.groups ?? []).some((g) => adminGroups.has(g));
    if (existing) {
      const role: UserRole = promoted ? 'ADMIN' : existing.role;
      await this.db.update(this.s.users).set({ external_id: input.externalId, display_name: input.displayName ?? existing.display_name, auth_provider: 'oidc', role }).where(eq(this.s.users.id, existing.id));
      return { ...existing, external_id: input.externalId, auth_provider: 'oidc', role };
    }
    const isFirst = (await this.countUsers()) === 0;
    const user: User = {
      id: newId(),
      email,
      password_hash: null,
      auth_provider: 'oidc',
      role: isFirst || promoted ? 'ADMIN' : 'USER',
      display_name: input.displayName ?? null,
      external_id: input.externalId,
      created_at: new Date(),
    };
    await this.db.insert(this.s.users).values(user);
    return user;
  }

  async login(email: string, password: string): Promise<User> {
    const user = await this.findByEmail(email);
    // Always run the hash comparison to avoid user-enumeration timing differences.
    const ok = await verifyPassword(password, user?.password_hash ?? 'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
    if (!user || !ok || user.auth_provider !== 'local') throw unauthorized('Invalid email or password');
    return user;
  }

  async updateRole(userId: string, role: UserRole): Promise<void> {
    const r = await this.db.update(this.s.users).set({ role }).where(eq(this.s.users.id, userId)).returning({ id: this.s.users.id });
    if (r.length === 0) throw notFound('User');
  }

  async changePassword(userId: string, newPassword: string): Promise<void> {
    if (newPassword.length < this.cfg.security.password_min_length) throw badRequest(`Password must be at least ${this.cfg.security.password_min_length} characters`);
    await this.db.update(this.s.users).set({ password_hash: await hashPassword(newPassword) }).where(eq(this.s.users.id, userId));
  }

  async deleteUser(userId: string): Promise<void> {
    await this.db.delete(this.s.users).where(eq(this.s.users.id, userId));
  }

  /** Creates the bootstrap admin from config when no users exist. */
  async bootstrapAdmin(): Promise<User | null> {
    if ((await this.countUsers()) > 0) return null;
    const { email, password } = this.cfg.auth.bootstrap_admin;
    if (!email || !password) return null;
    const u = await this.createLocalUser({ email, password, role: 'ADMIN', displayName: 'Administrator' });
    logger().warn({ email }, 'Bootstrap ADMIN user created from configuration');
    return u;
  }

  principalFromUser(user: User, via: Principal['via'], ip?: string): Principal {
    const scopes: TokenScope[] = user.role === 'ADMIN' ? ALL_SCOPES : user.role === 'USER' ? ['read', 'write', 'mcp'] : ['read', 'mcp'];
    return { userId: user.id, email: user.email, role: user.role, via, scopes, actorType: via === 'token' ? 'AGENT' : 'USER', ip };
  }

  // ---------- API tokens ----------

  async createToken(user: User, input: { name: string; scopes: TokenScope[]; workspaceId?: string | null; expiresAt?: Date | null }): Promise<{ token: string; record: ApiToken }> {
    const scopes = [...new Set(input.scopes)].filter((s): s is TokenScope => (TOKEN_SCOPES as readonly string[]).includes(s));
    if (scopes.length === 0) throw badRequest('At least one scope is required');
    if (scopes.includes('admin') && user.role !== 'ADMIN') throw badRequest('Only administrators can mint admin-scoped tokens');
    if (scopes.includes('write') && user.role === 'READ_ONLY') throw badRequest('Read-only users cannot mint write-scoped tokens');
    const gen = generateApiToken();
    const record: ApiToken = {
      id: newId(),
      user_id: user.id,
      workspace_id: input.workspaceId ?? null,
      token_hash: gen.hash,
      token_prefix: gen.prefix,
      name: input.name.trim() || 'token',
      scopes,
      expires_at: input.expiresAt ?? null,
      last_used_at: null,
      created_at: new Date(),
    };
    await this.db.insert(this.s.apiTokens).values(record);
    return { token: gen.token, record };
  }

  async listTokens(userId: string): Promise<Omit<ApiToken, 'token_hash'>[]> {
    const rows = await this.db.select().from(this.s.apiTokens).where(eq(this.s.apiTokens.user_id, userId)).orderBy(desc(this.s.apiTokens.created_at));
    return rows.map(({ token_hash: _h, ...rest }) => rest);
  }

  async revokeToken(userId: string, tokenId: string, admin = false): Promise<void> {
    const where = admin ? eq(this.s.apiTokens.id, tokenId) : and(eq(this.s.apiTokens.id, tokenId), eq(this.s.apiTokens.user_id, userId));
    const r = await this.db.delete(this.s.apiTokens).where(where).returning({ id: this.s.apiTokens.id });
    if (r.length === 0) throw notFound('Token');
  }

  /** Verifies a bearer API token; returns the principal or null. */
  async verifyToken(token: string, ip?: string): Promise<Principal | null> {
    if (!token || !token.startsWith('dv_')) return null;
    const hash = hashToken(token);
    const rows = await this.db.select().from(this.s.apiTokens).where(eq(this.s.apiTokens.token_hash, hash)).limit(1);
    const rec = rows[0];
    if (!rec) return null;
    if (rec.expires_at && rec.expires_at.getTime() < Date.now()) return null;
    this.db
      .update(this.s.apiTokens)
      .set({ last_used_at: new Date() })
      .where(eq(this.s.apiTokens.id, rec.id))
      .then(() => undefined)
      .catch(() => undefined);
    return this.principalFromTokenRecord(rec, ip);
  }

  async getTokenRecord(tokenId: string): Promise<ApiToken | null> {
    const rows = await this.db.select().from(this.s.apiTokens).where(eq(this.s.apiTokens.id, tokenId)).limit(1);
    return rows[0] ?? null;
  }

  /** Principal for a stored token (effective scopes = token scopes ∩ role capabilities). */
  async principalFromTokenRecord(rec: ApiToken, ip?: string): Promise<Principal | null> {
    const user = await this.findById(rec.user_id);
    if (!user) return null;
    const roleScopes = this.principalFromUser(user, 'token').scopes;
    const scopes = rec.scopes.filter((s) => roleScopes.includes(s));
    return { userId: user.id, email: user.email, role: user.role, via: 'token', scopes, tokenId: rec.id, workspaceScope: rec.workspace_id, actorType: 'AGENT', ip };
  }

  async setTokenScopes(tokenId: string, scopes: TokenScope[]): Promise<void> {
    await this.db.update(this.s.apiTokens).set({ scopes }).where(eq(this.s.apiTokens.id, tokenId));
  }
}
