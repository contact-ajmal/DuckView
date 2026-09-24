/**
 * Hosted agents and the agent marketplace.
 *   GET  /api/agent-templates                                   the marketplace (with each template's tools)
 *   GET  /api/hosted-agent-tools                                tools a hosted agent may be given
 *   GET/POST /api/workspaces/:id/hosted-agents                  list · create (editors); {template, ...} installs one
 *   GET/PATCH/DELETE /api/hosted-agents/:id                     one agent with its latest runs · edit · delete
 *   POST /api/hosted-agents/:id/run {input?, wait?, provider?…}  start a run (editors); wait: true answers with the result;
 *                                                               a personal key (when allowed) is used for this run only
 *   GET  /api/hosted-agent-runs/:id                             one run: status, steps, output
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { hostedToolCatalog } from '../services/hosted-agents.js';

const Schedule = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('manual') }),
  z.object({ kind: z.literal('interval'), minutes: z.number().int().min(15).max(60 * 24 * 7) }),
  z.object({ kind: z.literal('cron'), expression: z.string().min(1).max(120), timezone: z.string().max(64).optional() }),
]);
const Agent = z.object({
  name: z.string().max(120).optional(),
  description: z.string().max(2000).nullable().optional(),
  instructions: z.string().max(20_000).optional(),
  task: z.string().max(4000).optional(),
  tools: z.array(z.string().max(80)).max(60).optional(),
  max_steps: z.number().int().min(1).max(20).optional(),
  schedule: Schedule.optional(),
  channel_ids: z.array(z.string().max(64)).max(20).optional(),
  published: z.boolean().optional(),
  enabled: z.boolean().optional(),
});

export async function hostedAgentRoutes(app: FastifyInstance, ctx: AppContext) {
  app.addHook('preHandler', app.authenticate);

  app.get('/api/agent-templates', async () => ({ templates: ctx.hostedAgents.templates() }));
  app.get('/api/hosted-agent-tools', async () => ({ tools: hostedToolCatalog(ctx.cfg).map((t) => ({ name: t.name, title: t.title, description: t.description.split('\n')[0] })) }));

  app.get('/api/workspaces/:id/hosted-agents', async (req) => ({ agents: await ctx.hostedAgents.list(req.principal!, (req.params as { id: string }).id) }));
  app.post('/api/workspaces/:id/hosted-agents', async (req) => {
    const { id } = req.params as { id: string };
    const body = Agent.extend({ template: z.string().max(80).optional() }).parse(req.body ?? {});
    const { template, ...rest } = body;
    return { agent: template ? await ctx.hostedAgents.install(req.principal!, id, template, Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined))) : await ctx.hostedAgents.create(req.principal!, id, rest) };
  });

  app.get('/api/hosted-agents/:id', async (req) => {
    const { id } = req.params as { id: string };
    return { agent: await ctx.hostedAgents.get(req.principal!, id), runs: await ctx.hostedAgents.runs(req.principal!, id) };
  });
  app.patch('/api/hosted-agents/:id', async (req) => ({ agent: await ctx.hostedAgents.update(req.principal!, (req.params as { id: string }).id, Agent.parse(req.body ?? {})) }));
  app.delete('/api/hosted-agents/:id', async (req) => {
    await ctx.hostedAgents.remove(req.principal!, (req.params as { id: string }).id);
    return { ok: true };
  });
  app.post('/api/hosted-agents/:id/run', async (req) => {
    const { id } = req.params as { id: string };
    const body = z.object({ input: z.string().max(8000).optional(), wait: z.boolean().optional(), provider: z.string().max(40).optional(), model: z.string().max(200).optional(), api_key: z.string().max(500).optional(), base_url: z.string().max(500).optional(), region: z.string().max(40).optional() }).parse(req.body ?? {});
    await ctx.hostedAgents.get(req.principal!, id, 'EDITOR');
    const byok = body.provider || body.api_key || body.base_url ? { provider: body.provider as never, model: body.model, apiKey: body.api_key, baseUrl: body.base_url, region: body.region } : null;
    return { run: await ctx.hostedAgents.run(id, { p: req.principal!, input: body.input, wait: body.wait, triggeredBy: 'manual', byok }) };
  });
  app.get('/api/hosted-agent-runs/:id', async (req) => ({ run: await ctx.hostedAgents.getRun(req.principal!, (req.params as { id: string }).id) }));
}
