import type { TokenScope, UserRole } from '../db/schema/sqlite.js';
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
