import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { requireWrite } from '../services/principal.js';
import { WORKSPACE_ROLES, MEMBER_SUBJECT_TYPES } from '../db/schema/sqlite.js';

const EngineSettings = z.object({
  memory_limit: z.string().optional(),
  threads: z.union([z.literal('auto'), z.number().int()]).optional(),
  query_timeout_seconds: z.number().optional(),
  temp_directory: z.string().optional(),
  extensions: z.array(z.string()).optional(),
  connection_ids: z.array(z.string()).optional(),
});
const ChartConfig = z.object({ type: z.enum(['bar', 'line', 'area', 'scatter', 'pie', 'none']), x: z.string().optional(), y: z.array(z.string()).optional(), stacked: z.boolean().optional() });

export async function workspaceRoutes(app: FastifyInstance, ctx: AppContext) {
  app.addHook('preHandler', app.authenticate);

  app.get('/api/workspaces', async (req) => {
    let list = await ctx.workspaces.list(req.principal!);
    if (list.length === 0 && req.principal!.via !== 'token' && req.principal!.role !== 'READ_ONLY') {
      await ctx.workspaces.ensureDefault(req.principal!);
      list = await ctx.workspaces.list(req.principal!);
    }
    return { workspaces: list };
  });

  app.post('/api/workspaces', async (req) => {
    requireWrite(req.principal!);
    const body = z.object({ name: z.string().max(120), active_db_path: z.string().optional(), engine_settings: EngineSettings.optional() }).parse(req.body);
    const w = await ctx.workspaces.create(req.principal!, body);
    ctx.audit.log({ userId: req.principal!.userId, actorType: req.principal!.actorType, action: 'workspace.create', resource: `workspace:${w.id}`, ip: req.ip });
    return { workspace: await ctx.workspaces.describe(req.principal!, w.id) };
  });

  app.get('/api/workspaces/:id', async (req) => {
    const { id } = req.params as { id: string };
    const workspace = await ctx.workspaces.describe(req.principal!, id);
    const engine = ctx.engines.peek(id);
    return { workspace, engine: engine ? { memory_limit: engine.memoryLimit.display, threads: engine.threads, active_queries: engine.activeQueryCount, external_access: engine.externalAccess } : null };
  });

  app.patch('/api/workspaces/:id', async (req) => {
    requireWrite(req.principal!);
    const { id } = req.params as { id: string };
    const body = z.object({ name: z.string().max(120).optional(), active_db_path: z.string().optional(), engine_settings: EngineSettings.optional() }).parse(req.body);
    await ctx.workspaces.update(req.principal!, id, body);
    ctx.audit.log({ userId: req.principal!.userId, actorType: req.principal!.actorType, action: 'workspace.update', resource: `workspace:${id}`, ip: req.ip });
    return { workspace: await ctx.workspaces.describe(req.principal!, id) };
  });

  app.delete('/api/workspaces/:id', async (req) => {
    requireWrite(req.principal!);
    const { id } = req.params as { id: string };
    await ctx.workspaces.remove(req.principal!, id);
    ctx.audit.log({ userId: req.principal!.userId, actorType: req.principal!.actorType, action: 'workspace.delete', resource: `workspace:${id}`, ip: req.ip });
    return { ok: true };
  });

  app.post('/api/workspaces/:id/restart', async (req) => {
    requireWrite(req.principal!);
    const { id } = req.params as { id: string };
    await ctx.workspaces.get(req.principal!, id, 'OWNER'); // drops every member's in-memory tables
    ctx.engines.evict(id);
    await ctx.workspaces.bumpVersion(id, 'engine_restart', req.principal!.userId);
    ctx.audit.log({ userId: req.principal!.userId, actorType: req.principal!.actorType, action: 'workspace.restart_engine', resource: `workspace:${id}`, ip: req.ip });
    return { ok: true };
  });

  /** Drops every cached result for the workspace (server side) and moves the epoch so browsers drop theirs too. */
  app.delete('/api/workspaces/:id/cache', async (req) => {
    const { id } = req.params as { id: string };
    await ctx.workspaces.get(req.principal!, id, 'EDITOR');
    const dropped = ctx.cache.invalidateWorkspace(id, { all: true });
    const data_version = await ctx.workspaces.bumpVersion(id, 'cache_cleared', req.principal!.userId);
    ctx.audit.log({ userId: req.principal!.userId, actorType: req.principal!.actorType, action: 'workspace.cache_clear', resource: `workspace:${id}`, ip: req.ip });
    return { dropped, data_version };
  });

  // ---- sharing ----
  app.get('/api/workspaces/:id/members', async (req) => {
    const { id } = req.params as { id: string };
    return { members: await ctx.workspaces.listMembers(req.principal!, id) };
  });

  app.put('/api/workspaces/:id/members', async (req) => {
    const { id } = req.params as { id: string };
    const body = z.object({ subject_type: z.enum(MEMBER_SUBJECT_TYPES), subject_id: z.string().min(1), role: z.enum(WORKSPACE_ROLES) }).parse(req.body);
    const members = await ctx.workspaces.setMember(req.principal!, id, body);
    ctx.audit.log({ userId: req.principal!.userId, actorType: req.principal!.actorType, action: 'workspace.share', resource: `workspace:${id}`, queryText: `${body.subject_type}:${body.subject_id} → ${body.role}`, ip: req.ip });
    return { members };
  });

  app.delete('/api/workspaces/:id/members/:memberId', async (req) => {
    const { id, memberId } = req.params as { id: string; memberId: string };
    const members = await ctx.workspaces.removeMember(req.principal!, id, memberId);
    ctx.audit.log({ userId: req.principal!.userId, actorType: req.principal!.actorType, action: 'workspace.unshare', resource: `workspace:${id}`, queryText: memberId, ip: req.ip });
    return { members };
  });

  app.post('/api/workspaces/:id/leave', async (req) => {
    const { id } = req.params as { id: string };
    await ctx.workspaces.leave(req.principal!, id);
    ctx.audit.log({ userId: req.principal!.userId, actorType: req.principal!.actorType, action: 'workspace.leave', resource: `workspace:${id}`, ip: req.ip });
    return { ok: true };
  });

  app.post('/api/workspaces/:id/transfer', async (req) => {
    const { id } = req.params as { id: string };
    const body = z.object({ user_id: z.string().min(1) }).parse(req.body);
    const workspace = await ctx.workspaces.transfer(req.principal!, id, body.user_id);
    ctx.audit.log({ userId: req.principal!.userId, actorType: req.principal!.actorType, action: 'workspace.transfer', resource: `workspace:${id}`, queryText: `→ user:${body.user_id}`, ip: req.ip });
    return { workspace };
  });

  // ---- tabs (per user; viewers get their own scratch tabs too, so no write scope needed) ----
  app.get('/api/workspaces/:id/tabs', async (req) => {
    const { id } = req.params as { id: string };
    return { tabs: await ctx.workspaces.listTabs(req.principal!, id) };
  });

  app.post('/api/workspaces/:id/tabs', async (req) => {
    const { id } = req.params as { id: string };
    const body = z.object({ title: z.string().max(120).optional(), sql_content: z.string().optional(), chart_config: ChartConfig.optional(), engine: z.string().max(120).nullable().optional() }).parse(req.body ?? {});
    return { tab: await ctx.workspaces.createTab(req.principal!, id, body) };
  });

  app.patch('/api/workspaces/:id/tabs/:tabId', async (req) => {
    const { id, tabId } = req.params as { id: string; tabId: string };
    const body = z.object({ title: z.string().max(120).optional(), sql_content: z.string().optional(), chart_config: ChartConfig.optional(), order_index: z.number().int().optional(), cursor_position: z.number().int().min(0).optional(), engine: z.string().max(120).nullable().optional() }).parse(req.body ?? {});
    return { tab: await ctx.workspaces.updateTab(req.principal!, id, tabId, body) };
  });

  app.delete('/api/workspaces/:id/tabs/:tabId', async (req) => {
    const { id, tabId } = req.params as { id: string; tabId: string };
    await ctx.workspaces.deleteTab(req.principal!, id, tabId);
    return { ok: true };
  });
}
