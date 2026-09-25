/**
 * Agent integrations:
 *   /api/agents/*            registered agents (CRUD, token rotation, snippets, self-test, invoke, AWS discovery)
 *   /api/agent/openapi.json  OpenAPI 3.0 for the REST façade (Bedrock action groups, AgentCore Gateway)
 *   /api/agent/v1/tools[/x]  REST façade over the shared tool registry (bearer token with the mcp scope)
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { AGENT_FRAMEWORKS } from '../db/schema/sqlite.js';
import { snippetsFor, renderSnippet } from '../agent/snippets.js';
import { runTool } from '../agent/tools.js';
import { toolRegistry } from '../agent/registry.js';
import { semanticsOf } from '../agent/semantics.js';
import { buildOpenApi, toolInputJsonSchema } from '../agent/openapi.js';
import { forbidden, notFound } from '../services/errors.js';
import type { Principal } from '../services/principal.js';
import { serializeError } from './query.js';

const AgentConfigSchema = z.object({ region: z.string().optional(), agent_id: z.string().optional(), agent_alias_id: z.string().optional(), runtime_arn: z.string().optional(), qualifier: z.string().optional(), gateway_url: z.string().optional(), notes: z.string().optional() }).strict();

export async function agentRoutes(app: FastifyInstance, ctx: AppContext) {
  app.addHook('preHandler', app.authenticate);
  const tools = toolRegistry(ctx.cfg).all();
  const baseUrl = (req: { protocol: string; host: string }) => (ctx.cfg.server.public_url ?? `${req.protocol}://${req.host}`).replace(/\/+$/, '');

  // ------------------------------------------------------------------ registered agents
  app.get('/api/agents/frameworks', async () => ({ frameworks: ctx.agents.frameworks() }));

  /** Generic snippets (no registered agent): placeholders stay for <TOKEN>; the UI substitutes a token it holds. */
  app.get('/api/agents/snippets', async (req) => {
    const q = z.object({ framework: z.enum(AGENT_FRAMEWORKS), workspace_id: z.string().optional() }).parse(req.query);
    const b = baseUrl(req);
    const subs = { MCP_URL: `${b}/mcp`, BASE_URL: b, WORKSPACE_ID: q.workspace_id ?? null };
    return { snippets: snippetsFor(q.framework).map((sn) => ({ ...sn, code: renderSnippet(sn.code, subs), notes: sn.notes ? renderSnippet(sn.notes, subs) : undefined })), mcp_url: `${b}/mcp`, openapi_url: `${b}/api/agent/openapi.json` };
  });
  app.get('/api/agents', async (req) => ({ agents: await ctx.agents.list(req.principal!.userId) }));

  app.post('/api/agents', async (req) => {
    const body = z
      .object({
        name: z.string().min(1).max(120),
        framework: z.enum(AGENT_FRAMEWORKS),
        description: z.string().max(2000).nullable().optional(),
        workspace_id: z.string().nullable().optional(),
        allow_mutations: z.boolean().optional(),
        config: AgentConfigSchema.optional(),
        expires_in_days: z.number().int().min(1).max(3650).nullable().optional(),
      })
      .parse(req.body);
    return ctx.agents.create(req.principal!, body);
  });

  app.get('/api/agents/discover', async (req) => {
    const q = z.object({ kind: z.enum(['bedrock_agents', 'agentcore_runtimes', 'bedrock_models']), region: z.string().min(1) }).parse(req.query);
    return ctx.agents.discover(q.kind, q.region);
  });

  app.get('/api/agents/:id', async (req) => {
    const { id } = req.params as { id: string };
    return { agent: await ctx.agents.get(req.principal!.userId, id) };
  });

  app.patch('/api/agents/:id', async (req) => {
    const { id } = req.params as { id: string };
    const body = z.object({ name: z.string().min(1).max(120).optional(), description: z.string().max(2000).nullable().optional(), workspace_id: z.string().nullable().optional(), allow_mutations: z.boolean().optional(), config: AgentConfigSchema.optional() }).parse(req.body ?? {});
    return { agent: await ctx.agents.update(req.principal!, id, body) };
  });

  app.delete('/api/agents/:id', async (req) => {
    const { id } = req.params as { id: string };
    await ctx.agents.remove(req.principal!, id);
    return { ok: true };
  });

  app.post('/api/agents/:id/rotate-token', async (req) => {
    const { id } = req.params as { id: string };
    const body = z.object({ expires_in_days: z.number().int().min(1).max(3650).nullable().optional() }).parse(req.body ?? {});
    return ctx.agents.rotateToken(req.principal!, id, body.expires_in_days);
  });

  app.get('/api/agents/:id/snippets', async (req) => {
    const { id } = req.params as { id: string };
    const agent = await ctx.agents.getOwned(req.principal!.userId, id);
    return { snippets: ctx.agents.snippets(agent, { baseUrl: baseUrl(req) }), mcp_url: `${baseUrl(req)}/mcp`, openapi_url: `${baseUrl(req)}/api/agent/openapi.json` };
  });

  app.post('/api/agents/:id/test', async (req) => {
    const { id } = req.params as { id: string };
    return ctx.agents.selfTest(req.principal!, id);
  });

  /** SSE: delta* → done | error. */
  app.post('/api/agents/:id/invoke', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ prompt: z.string().min(1).max(50_000), session_id: z.string().max(200).optional(), workspace_id: z.string().optional(), include_context: z.boolean().optional() }).parse(req.body);
    let context: string | undefined;
    if (body.include_context && body.workspace_id) {
      const snap = await ctx.copilot.buildContext(req.principal!, body.workspace_id);
      context = ctx.copilot.renderContextText(snap);
    }
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    const ac = new AbortController();
    req.raw.on('close', () => ac.abort());
    const send = (event: string, data: unknown) => {
      if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const started = performance.now();
    try {
      const gen = ctx.agents.invoke(req.principal!, id, { prompt: body.prompt, context, sessionId: body.session_id, signal: ac.signal });
      let next = await gen.next();
      while (!next.done) {
        send('delta', { text: next.value });
        next = await gen.next();
      }
      send('done', { session_id: next.value.session_id, duration_ms: Math.round(performance.now() - started) });
    } catch (err) {
      const ser = serializeError(err);
      send('error', { code: ser.code, message: ser.message });
    } finally {
      res.end();
    }
  });

  // ------------------------------------------------------------------ REST façade + OpenAPI
  app.get('/api/agent/openapi.json', async (req) => buildOpenApi(tools, { serverUrl: baseUrl(req) }));

  const requireAgentScope = (p: Principal) => {
    if (!p.scopes.includes('mcp')) throw forbidden('Token lacks the "mcp" scope required for agent tool access');
  };

  app.get('/api/agent/v1/tools', async (req) => {
    requireAgentScope(req.principal!);
    return { tools: tools.map((t) => ({ name: t.name, title: t.title, description: t.description, annotations: t.annotations, semantics: semanticsOf(t), input_schema: toolInputJsonSchema(t) })), mcp_url: `${baseUrl(req)}/mcp` };
  });

  app.post('/api/agent/v1/tools/:name', async (req, reply) => {
    requireAgentScope(req.principal!);
    const { name } = req.params as { name: string };
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw notFound(`Tool ${name}`);
    const args = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const env = await ctx.agents.envFor(req.principal!, 'rest');
    const r = await runTool(env, tool, args);
    // Argument errors are the caller's fault; everything else is 200 with is_error so agents see the message.
    if (r.isError && (r.structuredContent as { code?: string } | undefined)?.code === 'BAD_REQUEST') reply.code(400);
    const images = r.content.filter((c): c is { type: 'image'; data: string; mimeType: string } => c.type === 'image').map((c) => ({ mime_type: c.mimeType, data_base64: c.data }));
    return { text: r.content.map((c) => (c.type === 'text' ? c.text : `[image ${c.mimeType}]`)).join('\n'), structured: r.structuredContent ?? null, is_error: !!r.isError, ...(images.length ? { images } : {}) };
  });
}
