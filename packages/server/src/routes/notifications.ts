/**
 * Notification channels (Slack, Teams, email, PagerDuty, webhooks) of a workspace or of the whole server, their
 * test messages and delivery history, and the server's outgoing mail settings (administrators).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import fs from 'node:fs';
import { CHANNEL_TYPES, ALERT_SEVERITIES, SNAPSHOT_FORMATS } from '../db/schema/sqlite.js';

const Secret = z.object({ url: z.string().max(2000).optional(), routing_key: z.string().max(100).optional(), signing_secret: z.string().max(200).optional() });
const Condition = z.union([z.object({ kind: z.literal('rows') }), z.object({ kind: z.literal('no_rows') }), z.object({ kind: z.literal('threshold'), column: z.string().max(200), op: z.enum(['>', '>=', '<', '<=', '=', '!=']), value: z.number() })]);
const Schedule = z.union([z.object({ kind: z.literal('manual') }), z.object({ kind: z.literal('interval'), minutes: z.number().int().min(1).max(525_600) }), z.object({ kind: z.literal('cron'), expression: z.string().max(200), timezone: z.string().max(64).optional() })]);
const AlertBody = z.object({ name: z.string().max(120), description: z.string().max(2000).nullable().optional(), sql: z.string().max(100_000), condition: Condition, schedule: Schedule.optional(), channel_ids: z.array(z.string().max(64)).max(20).optional(), severity: z.enum(ALERT_SEVERITIES).optional(), notify: z.enum(['change', 'always']).optional(), notify_resolved: z.boolean().optional(), enabled: z.boolean().optional() });
const ChannelBody = z.object({ name: z.string().max(120), type: z.enum(CHANNEL_TYPES), enabled: z.boolean().optional(), config: z.record(z.string(), z.unknown()).optional(), secret: Secret.optional() });

const Target = z.union([z.object({ kind: z.literal('dashboard'), dashboard_id: z.string().max(64) }), z.object({ kind: z.literal('app'), app_id: z.string().max(64) })]);

/** Signed links to snapshot files, for chat channels that fetch the image — the signature is the credential. */
export async function snapshotFileRoutes(app: FastifyInstance, ctx: AppContext) {
  app.get('/api/snapshot-files/:run/:kind', async (req, reply) => {
    const { run, kind } = req.params as { run: string; kind: string };
    const q = req.query as { exp?: string; sig?: string };
    const f = await ctx.snapshots.signedFile(run, kind, Number(q.exp), String(q.sig ?? ''));
    if (!f) return reply.code(404).send({ error: 'NOT_FOUND', message: 'This link expired or is not valid' });
    reply.header('cache-control', 'private, max-age=3600').header('content-disposition', `inline; filename="${f.filename}"`).header('x-content-type-options', 'nosniff');
    return reply.type(f.contentType).send(fs.createReadStream(f.path));
  });
}

export async function notificationRoutes(app: FastifyInstance, ctx: AppContext) {
  app.addHook('preHandler', app.authenticate);
  // The UI renders dashboards for snapshots signed in as their owner, with a five-minute session.
  ctx.snapshots.signUserSession = (u) => app.jwt.sign({ sub: u.id, email: u.email, role: u.role }, { expiresIn: '5m' });
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

  // ---------------------------------------------------------------- scheduled snapshots
  const sn = ctx.snapshots;
  const SnapshotBody = z.object({ name: z.string().max(120).optional(), target: Target, format: z.enum(SNAPSHOT_FORMATS).optional(), width: z.number().int().min(640).max(2400).optional(), schedule: Schedule.optional(), channel_ids: z.array(z.string().max(64)).max(20).optional(), enabled: z.boolean().optional() });
  app.get('/api/workspaces/:id/snapshots', async (req) => ({ snapshots: await sn.list(req.principal!, (req.params as { id: string }).id) }));
  app.post('/api/workspaces/:id/snapshots', async (req) => ({ snapshot: await sn.create(req.principal!, (req.params as { id: string }).id, SnapshotBody.parse(req.body ?? {})) }));
  app.get('/api/snapshots/:id', async (req) => ({ snapshot: await sn.get(req.principal!, (req.params as { id: string }).id) }));
  app.patch('/api/snapshots/:id', async (req) => ({ snapshot: await sn.update(req.principal!, (req.params as { id: string }).id, SnapshotBody.partial().parse(req.body ?? {})) }));
  app.delete('/api/snapshots/:id', async (req) => {
    await sn.remove(req.principal!, (req.params as { id: string }).id);
    return { ok: true };
  });
  /** Renders and delivers now (editors); returns the run. */
  app.post('/api/snapshots/:id/run', async (req) => {
    const { id } = req.params as { id: string };
    await sn.get(req.principal!, id, 'EDITOR');
    return sn.run(id, `manual:${req.principal!.email}`, req.principal!);
  });
  app.get('/api/snapshots/:id/runs', async (req) => ({ runs: await sn.runs(req.principal!, (req.params as { id: string }).id) }));
  app.get('/api/snapshots/:id/runs/:run/file', async (req, reply) => {
    const { id, run } = req.params as { id: string; run: string };
    const f = await sn.file(req.principal!, id, run);
    reply.header('content-disposition', `inline; filename="${f.filename}"`).header('x-content-type-options', 'nosniff');
    return reply.type(f.contentType).send(fs.createReadStream(f.path));
  });
}
