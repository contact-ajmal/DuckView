/**
 * The DuckView agent over HTTP, for the UI and any client with a session or token:
 *   GET /api/agent/tools   the tools this principal may be offered, with their semantics (from the registry)
 */
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { toolRegistry } from '../agent/registry.js';

export async function agentRuntimeRoutes(app: FastifyInstance, ctx: AppContext) {
  app.addHook('preHandler', app.authenticate);
  const registry = toolRegistry(ctx.cfg);

  app.get('/api/agent/tools', async (req) => {
    const offered = new Set(registry.availableTo(req.principal!).map((t) => t.name));
    return { tools: registry.descriptors().filter((d) => offered.has(d.name)).map(({ description: _full, ...d }) => d) };
  });
}
