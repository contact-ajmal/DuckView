/**
 * `duckview mcp` — stdio transport. stdout is reserved for JSON-RPC; all logging goes to stderr.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { AppContext } from '../context.js';
import type { Principal } from '../services/principal.js';
import { buildMcpServer } from './server.js';
import { metrics } from '../observability/metrics.js';
import { logger } from '../observability/logger.js';

export interface StdioOptions {
  /** API token (dv_...) — preferred; scopes and workspace binding come from the token. */
  token?: string;
  /** Trusted local identity by email (no password) — only for local CLI use. */
  userEmail?: string;
  workspaceId?: string;
}

export async function resolveStdioPrincipal(ctx: AppContext, opts: StdioOptions): Promise<Principal> {
  if (opts.token) {
    const p = await ctx.auth.verifyToken(opts.token, 'stdio');
    if (!p) throw new Error('Invalid or expired API token');
    if (!p.scopes.includes('mcp')) throw new Error('Token lacks the "mcp" scope');
    return p;
  }
  if (opts.userEmail) {
    const u = await ctx.auth.findByEmail(opts.userEmail);
    if (!u) throw new Error(`No user with email ${opts.userEmail}`);
    const p = ctx.auth.principalFromUser(u, 'local', 'stdio');
    return { ...p, actorType: 'AGENT' };
  }
  // Fallback: the first ADMIN (local, trusted process). Refuse in production.
  if (process.env.NODE_ENV === 'production') throw new Error('In production, `duckview mcp` requires --token or --user');
  const users = await ctx.auth.listUsers();
  const admin = users.find((u) => u.role === 'ADMIN') ?? users[0];
  if (!admin) throw new Error('No users exist yet. Create one via the UI, DUCKVIEW_ADMIN_EMAIL/PASSWORD, or `duckview create-user`.');
  const full = await ctx.auth.findById(admin.id);
  return { ...ctx.auth.principalFromUser(full!, 'local', 'stdio'), actorType: 'AGENT' };
}

export async function runStdio(ctx: AppContext, opts: StdioOptions): Promise<void> {
  const principal = await resolveStdioPrincipal(ctx, opts);
  let workspaceId = opts.workspaceId ?? principal.workspaceScope ?? null;
  if (!workspaceId) {
    const ws = await ctx.workspaces.ensureDefault(principal);
    workspaceId = ws.id;
  }
  const server = buildMcpServer(ctx, principal, { defaultWorkspaceId: workspaceId });
  const transport = new StdioServerTransport();
  metrics.mcpConnections.inc({ transport: 'stdio' });
  ctx.audit.log({ userId: principal.userId, actorType: 'AGENT', action: 'mcp.connect', resource: 'transport:stdio', ip: 'stdio' });
  await server.connect(transport);
  logger().info({ user: principal.email, workspaceId }, 'MCP stdio server connected');
  await new Promise<void>((resolve) => {
    transport.onclose = () => resolve();
    process.stdin.on('end', () => resolve());
  });
  metrics.mcpConnections.dec({ transport: 'stdio' });
}
