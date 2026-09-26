/**
 * The DuckView agent over HTTP, for the UI and any client with a session or a token (`read` scope; a token bound
 * to a workspace works there only):
 *   GET    /api/agent/config                       how the agent is set up: Agent MCP endpoint and tools, decision engine, budget
 *   GET    /api/agent/tools                        the tools this principal may be offered, with their semantics
 *   GET    /api/agent/sessions?workspace_id=       the person's sessions (newest first)
 *   POST   /api/agent/sessions                     {workspace_id, title?, page?}
 *   GET    /api/agent/sessions/:id                 a session with its tasks
 *   PATCH  /api/agent/sessions/:id                 {title?, archived?}
 *   DELETE /api/agent/sessions/:id
 *   GET    /api/agent/sessions/:id/observations    what its tasks found
 *   POST   /api/agent/tasks                        {workspace_id, request, session_id?, mode?, page?, wait?, provider?, model?, api_key?, base_url?, region?}
 *   GET    /api/agent/tasks/:id
 *   GET    /api/agent/tasks/:id/events?after=      Server-Sent Events: agent.* events, replayed then live
 *   POST   /api/agent/tasks/:id/cancel
 *   POST   /api/agent/tasks/:id/approval           {decision: approve | deny, note?}  (the person, signed in)
 *   GET    /api/agent/approvals?workspace_id=      the person's tasks waiting for approval
 *   GET    /api/agent/telemetry?days=&workspace_id=&all=  tasks, latency, tokens, cost and context size by decision engine and model
 *   GET    /api/agent/memory?workspace_id=         what the agent remembers there (the workspace's, and yours)
 *   DELETE /api/agent/memory/:id                   forget it (yours, or as a workspace owner)
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { toolRegistry } from '../agent/registry.js';
import { TERMINAL } from '../agent/events.js';
import { PROVIDER_IDS } from '../services/llm.js';
import { requireAdmin } from '../services/principal.js';
import { AGENT_MCP_TOOLS } from '../agent/mcp-agent.js';
import { decisionProviders } from '../agent/decision/providers.js';
import type { ProviderId } from '../services/llm.js';

const Page = z.object({ kind: z.string().min(1).max(40), id: z.string().max(400).nullable().optional(), label: z.string().max(400) }).nullable().optional();
const Mode = z.enum(['auto', 'analysis', 'investigate', 'build', 'explain']).optional();

export async function agentRuntimeRoutes(app: FastifyInstance, ctx: AppContext) {
  app.addHook('preHandler', app.authenticate);
  const registry = toolRegistry(ctx.cfg);
  const rt = () => ctx.agentRuntime;

  app.get('/api/agent/config', async (req) => {
    const base = (ctx.cfg.server.public_url ?? `${req.protocol}://${req.host}`).replace(/\/+$/, '');
    const a = ctx.cfg.agent;
    return {
      enabled: a.enabled,
      mcp: { enabled: a.enabled && a.mcp.enabled, url: `${base}/mcp/agent`, low_level_url: `${base}/mcp`, tools: AGENT_MCP_TOOLS },
      decision: { provider: ctx.decision.name, available: decisionProviders() },
      budget: a.budget,
      max_steps: a.max_steps,
      max_retries: a.max_retries,
    };
  });

  app.get('/api/agent/tools', async (req) => {
    const offered = new Set(registry.availableTo(req.principal!).map((t) => t.name));
    return { tools: registry.descriptors().filter((d) => offered.has(d.name)).map(({ description: _full, ...d }) => d) };
  });

  // ---- sessions
  app.get('/api/agent/sessions', async (req) => {
    const q = z.object({ workspace_id: z.string().min(1), archived: z.coerce.boolean().optional(), limit: z.coerce.number().int().min(1).max(500).optional() }).parse(req.query ?? {});
    return { sessions: await rt().listSessions(req.principal!, q.workspace_id, { archived: q.archived, limit: q.limit }) };
  });
  app.post('/api/agent/sessions', async (req) => {
    const b = z.object({ workspace_id: z.string().min(1), title: z.string().max(200).optional(), page: Page }).parse(req.body ?? {});
    return { session: await rt().createSession(req.principal!, b.workspace_id, { title: b.title, page: b.page ?? null, via: 'ui' }) };
  });
  app.get('/api/agent/sessions/:id', async (req) => ({ session: await rt().getSession(req.principal!, (req.params as { id: string }).id) }));
  app.patch('/api/agent/sessions/:id', async (req) => {
    const b = z.object({ title: z.string().max(200).optional(), archived: z.boolean().optional() }).parse(req.body ?? {});
    return { session: await rt().updateSession(req.principal!, (req.params as { id: string }).id, b) };
  });
  app.delete('/api/agent/sessions/:id', async (req) => {
    await rt().deleteSession(req.principal!, (req.params as { id: string }).id);
    return { ok: true };
  });
  app.get('/api/agent/sessions/:id/observations', async (req) => ({ observations: await rt().observations(req.principal!, (req.params as { id: string }).id) }));

  // ---- tasks
  app.post('/api/agent/tasks', async (req) => {
    const b = z
      .object({
        workspace_id: z.string().min(1),
        request: z.string().min(1).max(8000),
        session_id: z.string().optional(),
        mode: Mode,
        page: Page,
        wait: z.boolean().optional(),
        provider: z.enum(PROVIDER_IDS as [string, ...string[]]).optional(),
        model: z.string().max(200).optional(),
        api_key: z.string().max(1000).optional(),
        base_url: z.string().max(500).optional(),
        region: z.string().max(40).optional(),
      })
      .parse(req.body ?? {});
    const byok = b.provider || b.api_key || b.base_url ? { provider: b.provider as ProviderId | undefined, model: b.model, apiKey: b.api_key, baseUrl: b.base_url, region: b.region } : null;
    const input = { workspaceId: b.workspace_id, request: b.request, sessionId: b.session_id ?? null, mode: b.mode, page: b.page ?? null, via: (req.principal!.via === 'token' ? 'rest' : 'ui') as 'rest' | 'ui', byok };
    return { task: b.wait ? await rt().run(req.principal!, input) : await rt().start(req.principal!, input) };
  });
  app.get('/api/agent/tasks/:id', async (req) => ({ task: await rt().getTask(req.principal!, (req.params as { id: string }).id) }));
  app.post('/api/agent/tasks/:id/cancel', async (req) => ({ task: await rt().cancel(req.principal!, (req.params as { id: string }).id) }));
  app.post('/api/agent/tasks/:id/approval', async (req) => {
    const b = z.object({ decision: z.enum(['approve', 'deny']), note: z.string().max(500).optional() }).parse(req.body ?? {});
    return { task: await rt().decide(req.principal!, (req.params as { id: string }).id, b.decision, b.note ?? null) };
  });
  app.get('/api/agent/memory', async (req) => {
    const q = z.object({ workspace_id: z.string().min(1) }).parse(req.query ?? {});
    return { memories: await rt().memory.visible(req.principal!, q.workspace_id) };
  });
  app.delete('/api/agent/memory/:id', async (req) => {
    await rt().memory.forget(req.principal!, (req.params as { id: string }).id);
    return { ok: true };
  });

  app.get('/api/agent/telemetry', async (req) => {
    const q = z.object({ days: z.coerce.number().int().min(1).max(365).optional(), workspace_id: z.string().optional(), all: z.coerce.boolean().optional() }).parse(req.query ?? {});
    if (q.all) requireAdmin(req.principal!);
    if (q.workspace_id) await ctx.workspaces.get(req.principal!, q.workspace_id);
    return rt().telemetry(req.principal!, { days: q.days, workspaceId: q.workspace_id ?? null, all: q.all });
  });

  app.get('/api/agent/approvals', async (req) => {
    const q = z.object({ workspace_id: z.string().optional() }).parse(req.query ?? {});
    return { tasks: await rt().pendingApprovals(req.principal!, q.workspace_id ?? null) };
  });

  // Server-Sent Events: what has happened so far (after `after`), then live, until the task ends.
  app.get('/api/agent/tasks/:id/events', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const after = z.object({ after: z.coerce.number().int().min(0).optional() }).parse(req.query ?? {}).after ?? 0;
    const task = await rt().getTask(req.principal!, id);
    const res = reply.raw;
    reply.hijack();
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    let off: (() => void) | null = null;
    const end = () => {
      off?.();
      clearInterval(ping);
      if (!res.writableEnded) res.end();
    };
    const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
    req.raw.on('close', end);
    if (TERMINAL_STATUSES.has(task.status) && !rt().events.history(id).length) {
      // Finished long ago: the row is the record.
      send('task', task);
      return end();
    }
    send('task', task);
    off = rt().events.subscribe(id, (e) => {
      send(e.type, e);
      if (TERMINAL.has(e.type) || e.type === 'agent.approval.required') setTimeout(end, 50);
    }, after);
  });
}

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
