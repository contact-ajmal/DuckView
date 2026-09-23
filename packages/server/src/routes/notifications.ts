/**
 * Notification channels (Slack, Teams, email, PagerDuty, webhooks) of a workspace or of the whole server, their
 * test messages and delivery history, and the server's outgoing mail settings (administrators).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { CHANNEL_TYPES, ALERT_SEVERITIES } from '../db/schema/sqlite.js';

const Secret = z.object({ url: z.string().max(2000).optional(), routing_key: z.string().max(100).optional(), signing_secret: z.string().max(200).optional() });
const Condition = z.union([z.object({ kind: z.literal('rows') }), z.object({ kind: z.literal('no_rows') }), z.object({ kind: z.literal('threshold'), column: z.string().max(200), op: z.enum(['>', '>=', '<', '<=', '=', '!=']), value: z.number() })]);
const Schedule = z.union([z.object({ kind: z.literal('manual') }), z.object({ kind: z.literal('interval'), minutes: z.number().int().min(1).max(525_600) }), z.object({ kind: z.literal('cron'), expression: z.string().max(200), timezone: z.string().max(64).optional() })]);
const AlertBody = z.object({ name: z.string().max(120), description: z.string().max(2000).nullable().optional(), sql: z.string().max(100_000), condition: Condition, schedule: Schedule.optional(), channel_ids: z.array(z.string().max(64)).max(20).optional(), severity: z.enum(ALERT_SEVERITIES).optional(), notify: z.enum(['change', 'always']).optional(), notify_resolved: z.boolean().optional(), enabled: z.boolean().optional() });
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

  // ---------------------------------------------------------------- alerts
  const al = ctx.alerts;
  app.get('/api/workspaces/:id/alerts', async (req) => ({ alerts: await al.list(req.principal!, (req.params as { id: string }).id) }));
  app.post('/api/workspaces/:id/alerts', async (req) => ({ alert: await al.create(req.principal!, (req.params as { id: string }).id, AlertBody.parse(req.body ?? {})) }));
  /** Tries a query and condition as the caller, without saving or notifying (the editor's "Test"). */
  app.post('/api/workspaces/:id/alerts/preview', async (req) => {
    const body = z.object({ sql: z.string().max(100_000), condition: Condition }).parse(req.body ?? {});
    return { evaluation: await al.preview(req.principal!, (req.params as { id: string }).id, body.sql, body.condition) };
  });
  app.get('/api/alerts/:id', async (req) => ({ alert: await al.get(req.principal!, (req.params as { id: string }).id) }));
  app.patch('/api/alerts/:id', async (req) => ({ alert: await al.update(req.principal!, (req.params as { id: string }).id, AlertBody.partial().parse(req.body ?? {})) }));
  app.delete('/api/alerts/:id', async (req) => {
    await al.remove(req.principal!, (req.params as { id: string }).id);
    return { ok: true };
  });
  /** Checks the alert now and delivers what changed (editors). */
  app.post('/api/alerts/:id/run', async (req) => {
    const { id } = req.params as { id: string };
    await al.get(req.principal!, id, 'EDITOR');
    return al.run(id, `manual:${req.principal!.email}`, req.principal!);
  });
  app.get('/api/alerts/:id/events', async (req) => ({ events: await al.events(req.principal!, (req.params as { id: string }).id) }));
}
