import type { TokenScope, UserRole, WorkspaceRole } from '../db/schema/sqlite.js';
import { forbidden } from './errors.js';

export interface Principal {
  userId: string;
  email: string;
  role: UserRole;
  via: 'jwt' | 'token' | 'local';
  scopes: TokenScope[];
  tokenId?: string;
  /** When an API token is scoped to a single workspace. */
  workspaceScope?: string | null;
  actorType: 'USER' | 'AGENT' | 'SYSTEM';
  ip?: string;
}

export const isAdmin = (p: Principal) => p.role === 'ADMIN' && p.scopes.includes('admin');
export const canWrite = (p: Principal) => p.role !== 'READ_ONLY' && p.scopes.includes('write');
export const canRead = (p: Principal) => p.scopes.includes('read');

export function requireScope(p: Principal, scope: TokenScope) {
  if (!p.scopes.includes(scope)) throw forbidden(`Missing required scope: ${scope}`);
}
export function requireAdmin(p: Principal) {
  if (!isAdmin(p)) throw forbidden('Administrator role required');
}
export function requireWrite(p: Principal) {
  if (!canWrite(p)) throw forbidden(p.role === 'READ_ONLY' ? 'Your role is read-only' : 'Missing required scope: write');
}
export function assertWorkspaceScope(p: Principal, workspaceId: string) {
  if (p.workspaceScope && p.workspaceScope !== workspaceId) throw forbidden('Token is scoped to a different workspace');
}

// ---------- Workspace roles (sharing) ----------

const WORKSPACE_ROLE_RANK: Record<WorkspaceRole, number> = { VIEWER: 0, EDITOR: 1, OWNER: 2 };

export const roleAtLeast = (have: WorkspaceRole, need: WorkspaceRole) => WORKSPACE_ROLE_RANK[have] >= WORKSPACE_ROLE_RANK[need];
export const maxWorkspaceRole = (roles: WorkspaceRole[]): WorkspaceRole | null => roles.reduce<WorkspaceRole | null>((best, r) => (best === null || WORKSPACE_ROLE_RANK[r] > WORKSPACE_ROLE_RANK[best] ? r : best), null);

/** Admins signed in through the UI act as OWNER on every workspace (tokens never inherit that). */
export const isPlatformAdmin = (p: Principal) => isAdmin(p) && p.via !== 'token';

const ROLE_LABEL: Record<WorkspaceRole, string> = { VIEWER: 'view', EDITOR: 'edit', OWNER: 'owner' };
export function requireWorkspaceRole(have: WorkspaceRole, need: WorkspaceRole) {
  if (roleAtLeast(have, need)) return;
  if (need === 'OWNER') throw forbidden(`Only workspace owners can manage settings and sharing (you have ${ROLE_LABEL[have]} access)`);
  throw forbidden(`This needs edit access to the workspace (you have ${ROLE_LABEL[have]} access)`);
}
