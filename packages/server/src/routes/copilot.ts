import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { PROVIDER_CATALOG, PROVIDER_IDS } from '../services/llm.js';
import { requireAdmin } from '../services/principal.js';
import { serializeError } from './query.js';

const Provider = z.enum(PROVIDER_IDS as [string, ...string[]]).transform((v) => v as (typeof PROVIDER_IDS)[number]);
const AwsFields = { region: z.string().max(40).optional(), agent_id: z.string().max(120).optional(), agent_alias_id: z.string().max(120).optional(), runtime_arn: z.string().max(400).optional() };
const ServerProviderBody = z.object({
  provider: Provider,
  model: z.string().max(200).nullable().optional(),
  base_url: z.string().max(500).nullable().optional(),
  api_key: z.string().max(1000).nullable().optional(),
  aws_region: z.string().max(40).nullable().optional(),
  bedrock_agent_id: z.string().max(120).nullable().optional(),
  bedrock_agent_alias_id: z.string().max(120).nullable().optional(),
  agentcore_runtime_arn: z.string().max(400).nullable().optional(),
});

export async function copilotRoutes(app: FastifyInstance, ctx: AppContext) {
  app.addHook('preHandler', app.authenticate);

  app.get('/api/copilot/config', async (req) => ctx.copilot.config(req.principal!));
  app.get('/api/copilot/providers', async () => ({ providers: PROVIDER_CATALOG }));

  // ---- server-managed provider (administrators): stored encrypted, overrides copilot.* in the config file
  app.get('/api/copilot/settings', async (req) => ({ settings: await ctx.copilotAdmin.describe(req.principal!), source: (await ctx.copilot.serverProvider())?.source ?? null }));
  app.put('/api/copilot/settings', async (req) => {
    const body = ServerProviderBody.parse(req.body ?? {});
    const saved = await ctx.copilotAdmin.setServerProvider(req.principal!, body);
    ctx.audit.log({ userId: req.principal!.userId, actorType: req.principal!.actorType, action: 'copilot.settings.update', resource: `provider:${saved.provider}`, ip: req.ip });
    return { settings: await ctx.copilotAdmin.describe(req.principal!), source: 'settings' };
  });
  // Personal-key policy for the deployment (null = as configured in copilot.allow_byok).
  app.put('/api/copilot/settings/byok', async (req) => {
    const body = z.object({ allow: z.boolean().nullable() }).parse(req.body ?? {});
    await ctx.copilotAdmin.setAllowByok(req.principal!, body.allow);
    ctx.audit.log({ userId: req.principal!.userId, actorType: req.principal!.actorType, action: 'copilot.settings.byok', resource: `allow:${String(body.allow)}`, ip: req.ip });
    return { allow_byok: await ctx.copilot.allowByok() };
  });
  app.delete('/api/copilot/settings', async (req) => {
    await ctx.copilotAdmin.clearServerProvider(req.principal!);
    ctx.audit.log({ userId: req.principal!.userId, actorType: req.principal!.actorType, action: 'copilot.settings.clear', resource: 'provider', ip: req.ip });
    return { ok: true, source: (await ctx.copilot.serverProvider())?.source ?? null };
  });
  // Proves a provider configuration works (lists models, or a one-token completion). Admins only: it can use the
  // key on file.
  app.post('/api/copilot/settings/test', async (req) => {
    const body = ServerProviderBody.parse(req.body ?? {});
    requireAdmin(req.principal!);
    return ctx.copilot.testProvider(req.principal!, body);
  });

  // ---- usage: streams in flight and token totals (administrators see everyone, others themselves)
  app.get('/api/copilot/usage', async (req) => {
    const q = z.object({ days: z.coerce.number().int().min(1).max(365).default(30), conversation_id: z.string().optional() }).parse(req.query ?? {});
    if (q.conversation_id) return { conversation: await ctx.copilotAdmin.conversationTotals(req.principal!, q.conversation_id), active: ctx.copilotAdmin.activeStreams(req.principal!) };
    return ctx.copilotAdmin.report(req.principal!, q.days);
  });

  // Model discovery for the settings panel (BYOK keys are used for this call only and never stored).
  app.post('/api/copilot/models', async (req) => {
    const body = z.object({ provider: Provider, api_key: z.string().optional(), base_url: z.string().optional(), ...AwsFields }).parse(req.body ?? {});
    return { models: await ctx.copilot.listModels({ provider: body.provider, apiKey: body.api_key, baseUrl: body.base_url, region: body.region, agentId: body.agent_id, agentAliasId: body.agent_alias_id, runtimeArn: body.runtime_arn }) };
  });

  app.get('/api/copilot/conversations', async (req) => {
    const q = z.object({ workspace_id: z.string().min(1) }).parse(req.query ?? {});
    return { conversations: await ctx.chat.conversations(req.principal!, q.workspace_id) };
  });

  app.get('/api/copilot/messages', async (req) => {
    const q = z.object({ workspace_id: z.string().min(1), conversation_id: z.string().min(1) }).parse(req.query ?? {});
    const messages = await ctx.chat.messages(req.principal!, q.workspace_id, q.conversation_id);
    return { messages: messages.map((m) => ({ id: m.id, role: m.role, content: m.content, timestamp: m.timestamp, context: m.context_snapshot ? { tables: m.context_snapshot.tables.length, files: m.context_snapshot.files.length, model: m.context_snapshot.model, provider: m.context_snapshot.provider, targets: Object.keys(m.context_snapshot.summaries ?? {}) } : null })) };
  });

  app.delete('/api/copilot/conversations/:id', async (req) => {
    const { id } = req.params as { id: string };
    const q = z.object({ workspace_id: z.string().min(1) }).parse(req.query ?? {});
    await ctx.chat.clear(req.principal!, q.workspace_id, id);
    return { ok: true };
  });

  // Streaming chat over Server-Sent Events: context → delta* → done | error
  app.post('/api/copilot/chat', async (req, reply) => {
    const body = z
      .object({
        workspace_id: z.string().min(1),
        conversation_id: z.string().optional(),
        message: z.string().max(50_000).default(''),
        action: z.enum(['chat', 'fix', 'suggest', 'explain', 'dashboard']).optional(),
        active_sql: z.string().max(200_000).nullable().optional(),
        error_message: z.string().max(20_000).nullable().optional(),
        targets: z.array(z.string()).max(5).optional(),
        result_preview: z.object({ columns: z.array(z.object({ name: z.string(), type: z.string() })), rows: z.array(z.array(z.unknown())).max(50), rowCount: z.number().optional() }).nullable().optional(),
        provider: Provider.optional(),
        model: z.string().max(120).optional(),
        api_key: z.string().max(400).optional(),
        base_url: z.string().max(500).optional(),
        ...AwsFields,
      })
      .parse(req.body);

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    const ac = new AbortController();
    req.raw.on('close', () => ac.abort());
    const send = (event: string, data: unknown) => {
      if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    try {
      for await (const ev of ctx.copilot.stream(req.principal!, {
        workspaceId: body.workspace_id,
        conversationId: body.conversation_id,
        message: body.message,
        action: body.action,
        activeSql: body.active_sql,
        errorMessage: body.error_message,
        targets: body.targets,
        resultPreview: body.result_preview,
        provider: body.provider,
        model: body.model,
        apiKey: body.api_key,
        baseUrl: body.base_url,
        region: body.region,
        agentId: body.agent_id,
        agentAliasId: body.agent_alias_id,
        runtimeArn: body.runtime_arn,
        signal: ac.signal,
      })) {
        send(ev.type, ev);
      }
    } catch (err) {
      const e = serializeError(err);
      send('error', { type: 'error', code: e.code, message: e.message });
    } finally {
      res.end();
    }
  });
}
