/**
 * Notification channels (Slack, Teams, email, PagerDuty, webhooks) of a workspace or of the whole server, their
 * test messages and delivery history, and the server's outgoing mail settings (administrators).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { CHANNEL_TYPES } from '../db/schema/sqlite.js';

const Secret = z.object({ url: z.string().max(2000).optional(), routing_key: z.string().max(100).optional(), signing_secret: z.string().max(200).optional() });
const ChannelBody = z.object({ name: z.string().max(120), type: z.enum(CHANNEL_TYPES), enabled: z.boolean().optional(), config: z.record(z.string(), z.unknown()).optional(), secret: Secret.optional() });

export async function notificationRoutes(app: FastifyInstance, ctx: AppContext) {
  app.addHook('preHandler', app.authenticate);
  const n = ctx.notifications;

  app.get('/api/workspaces/:id/channels', async (req) => ({ channels: await n.list(req.principal!, (req.params as { id: string }).id) }));
  app.post('/api/workspaces/:id/channels', async (req) => n.create(req.principal!, (req.params as { id: string }).id, ChannelBody.parse(req.body ?? {})));
  app.get('/api/channels', async (req) => ({ channels: await n.listOrg(req.principal!) }));
  app.post('/api/channels', async (req) => n.create(req.principal!, null, ChannelBody.parse(req.body ?? {})));
  app.get('/api/channels/:id', async (req) => ({ channel: n.toPublic(await n.get(req.principal!, (req.params as { id: string }).id)) }));
  app.patch('/api/channels/:id', async (req) => ({ channel: await n.update(req.principal!, (req.params as { id: string }).id, ChannelBody.partial().parse(req.body ?? {})) }));
  app.delete('/api/channels/:id', async (req) => {
    await n.remove(req.principal!, (req.params as { id: string }).id);
    return { ok: true };
  });
  app.post('/api/channels/:id/test', async (req) => ({ delivery: await n.test(req.principal!, (req.params as { id: string }).id) }));
  app.get('/api/channels/:id/deliveries', async (req) => ({ deliveries: await n.deliveries(req.principal!, (req.params as { id: string }).id) }));

  app.get('/api/admin/integrations/smtp', async (req) => n.describeSmtp(req.principal!));
  app.put('/api/admin/integrations/smtp', async (req) => {
    const body = z.object({ host: z.string().max(255), port: z.number().int().min(1).max(65535).optional(), secure: z.boolean().optional(), user: z.string().max(255).nullable().optional(), password: z.string().max(500).nullable().optional(), from: z.string().max(320) }).parse(req.body ?? {});
    await n.setSmtp(req.principal!, body);
    return n.describeSmtp(req.principal!);
  });
  app.delete('/api/admin/integrations/smtp', async (req) => {
    await n.clearSmtp(req.principal!);
    return n.describeSmtp(req.principal!);
  });
  app.post('/api/admin/integrations/smtp/test', async (req) => {
    const body = z.object({ to: z.string().max(320) }).parse(req.body ?? {});
    await n.testSmtp(req.principal!, body.to);
    return { ok: true };
  });
}
