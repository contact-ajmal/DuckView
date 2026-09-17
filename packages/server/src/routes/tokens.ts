import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { TOKEN_SCOPES } from '../db/schema/sqlite.js';
import { forbidden } from '../services/errors.js';
import type { McpSessionRegistry } from '../mcp/http.js';
import { isAdmin } from '../services/principal.js';

export async function tokenRoutes(app: FastifyInstance, ctx: AppContext, registry: McpSessionRegistry) {
  app.addHook('preHandler', app.authenticate);

  app.get('/api/tokens', async (req) => ({ tokens: await ctx.auth.listTokens(req.principal!.userId) }));

  app.post('/api/tokens', async (req) => {
    const p = req.principal!;
    if (p.via === 'token' && !p.scopes.includes('admin')) throw forbidden('API tokens cannot mint other tokens');
    const body = z
      .object({
        name: z.string().min(1).max(120),
        scopes: z.array(z.enum(TOKEN_SCOPES)).min(1),
        workspace_id: z.string().nullable().optional(),
        expires_in_days: z.number().int().min(1).max(3650).nullable().optional(),
      })
      .parse(req.body);
    const user = await ctx.auth.findById(p.userId);
    if (!user) throw forbidden('User not found');
    if (body.workspace_id) await ctx.workspaces.get(p, body.workspace_id);
    const expiresAt = body.expires_in_days ? new Date(Date.now() + body.expires_in_days * 86_400_000) : null;
    const { token, record } = await ctx.auth.createToken(user, { name: body.name, scopes: body.scopes, workspaceId: body.workspace_id ?? null, expiresAt });
    ctx.audit.log({ userId: p.userId, actorType: p.actorType, action: 'token.create', resource: `token:${record.id}`, ip: req.ip });
    const { token_hash: _h, ...pub } = record;
    return { token, record: pub };
  });

  app.delete('/api/tokens/:id', async (req) => {
    const { id } = req.params as { id: string };
    await ctx.auth.revokeToken(req.principal!.userId, id, isAdmin(req.principal!));
    ctx.audit.log({ userId: req.principal!.userId, actorType: req.principal!.actorType, action: 'token.revoke', resource: `token:${id}`, ip: req.ip });
    return { ok: true };
  });

  app.get('/api/mcp/sessions', async (req) => ({ sessions: registry.list(isAdmin(req.principal!) ? undefined : req.principal!.userId) }));

  app.get('/api/mcp/info', async (req) => {
    const base = (ctx.cfg.server.public_url ?? `${req.protocol}://${req.host}`).replace(/\/+$/, '');
    return {
      server_name: 'duckview',
      transports: {
        sse: `${base}/mcp/sse`,
        streamable_http: `${base}/mcp`,
        stdio: 'duckview mcp --token <token> [--workspace <id>]',
      },
      tools: ['execute_query', 'profile_dataset', 'explain_query', 'list_accessible_data', 'save_dataset', 'browse_storage', 'inspect_schema', 'list_dashboards', 'create_dashboard_widget'],
      resources: ['duckdb://workspaces', 'duckdb://schemas/{workspace_id}', 'duckdb://system/resources'],
      prompts: ['data_quality_audit', 'sql_optimization'],
      limits: { default_page_size: ctx.cfg.mcp.default_page_size, max_page_size: ctx.cfg.mcp.max_page_size, max_cell_chars: ctx.cfg.mcp.max_cell_chars },
      hitl_enabled: ctx.cfg.mcp.require_confirmation_for_mutations,
      snippets: {
        claude_code: `claude mcp add --transport http duckview ${base}/mcp --header "Authorization: Bearer <TOKEN>"`,
        claude_desktop: JSON.stringify({ mcpServers: { duckview: { command: 'npx', args: ['-y', 'mcp-remote', `${base}/mcp`, '--header', 'Authorization: Bearer <TOKEN>'] } } }, null, 2),
        claude_desktop_stdio: JSON.stringify({ mcpServers: { duckview: { command: 'duckview', args: ['mcp', '--token', '<TOKEN>'], env: { DUCKVIEW_CONFIG: '/path/to/duckview.config.yaml' } } } }, null, 2),
        cursor: JSON.stringify({ mcpServers: { duckview: { url: `${base}/mcp`, headers: { Authorization: 'Bearer <TOKEN>' } } } }, null, 2),
        curl_sse: `curl -N -H "Authorization: Bearer <TOKEN>" ${base}/mcp/sse`,
      },
    };
  });
}
