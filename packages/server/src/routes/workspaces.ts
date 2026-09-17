import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { requireWrite } from '../services/principal.js';

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
    const list = await ctx.workspaces.list(req.principal!);
    if (list.length === 0 && req.principal!.via !== 'token') list.push(await ctx.workspaces.ensureDefault(req.principal!));
    return { workspaces: list };
  });

  app.post('/api/workspaces', async (req) => {
    requireWrite(req.principal!);
    const body = z.object({ name: z.string().max(120), active_db_path: z.string().optional(), engine_settings: EngineSettings.optional() }).parse(req.body);
    const w = await ctx.workspaces.create(req.principal!, body);
    ctx.audit.log({ userId: req.principal!.userId, actorType: req.principal!.actorType, action: 'workspace.create', resource: `workspace:${w.id}`, ip: req.ip });
    return { workspace: w };
  });

  app.get('/api/workspaces/:id', async (req) => {
    const { id } = req.params as { id: string };
    const workspace = await ctx.workspaces.get(req.principal!, id);
    const engine = ctx.engines.peek(id);
    return { workspace, engine: engine ? { memory_limit: engine.memoryLimit.display, threads: engine.threads, active_queries: engine.activeQueryCount, external_access: engine.externalAccess } : null };
  });

  app.patch('/api/workspaces/:id', async (req) => {
    requireWrite(req.principal!);
    const { id } = req.params as { id: string };
    const body = z.object({ name: z.string().max(120).optional(), active_db_path: z.string().optional(), engine_settings: EngineSettings.optional() }).parse(req.body);
    const w = await ctx.workspaces.update(req.principal!, id, body);
    ctx.audit.log({ userId: req.principal!.userId, actorType: req.principal!.actorType, action: 'workspace.update', resource: `workspace:${id}`, ip: req.ip });
    return { workspace: w };
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
    await ctx.workspaces.get(req.principal!, id);
    ctx.engines.evict(id);
    ctx.audit.log({ userId: req.principal!.userId, actorType: req.principal!.actorType, action: 'workspace.restart_engine', resource: `workspace:${id}`, ip: req.ip });
    return { ok: true };
  });

  // ---- tabs ----
  app.get('/api/workspaces/:id/tabs', async (req) => {
    const { id } = req.params as { id: string };
    return { tabs: await ctx.workspaces.listTabs(req.principal!, id) };
  });

  app.post('/api/workspaces/:id/tabs', async (req) => {
    requireWrite(req.principal!);
    const { id } = req.params as { id: string };
    const body = z.object({ title: z.string().max(120).optional(), sql_content: z.string().optional(), chart_config: ChartConfig.optional() }).parse(req.body ?? {});
    return { tab: await ctx.workspaces.createTab(req.principal!, id, body) };
  });

  app.patch('/api/workspaces/:id/tabs/:tabId', async (req) => {
    requireWrite(req.principal!);
    const { id, tabId } = req.params as { id: string; tabId: string };
    const body = z.object({ title: z.string().max(120).optional(), sql_content: z.string().optional(), chart_config: ChartConfig.optional(), order_index: z.number().int().optional(), cursor_position: z.number().int().min(0).optional() }).parse(req.body ?? {});
    return { tab: await ctx.workspaces.updateTab(req.principal!, id, tabId, body) };
  });

  app.delete('/api/workspaces/:id/tabs/:tabId', async (req) => {
    requireWrite(req.principal!);
    const { id, tabId } = req.params as { id: string; tabId: string };
    await ctx.workspaces.deleteTab(req.principal!, id, tabId);
    return { ok: true };
  });
}
