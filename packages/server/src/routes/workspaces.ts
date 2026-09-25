import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { requireAdmin, requireWrite } from '../services/principal.js';
import { HttpError } from '../services/errors.js';
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
    const q = z.object({ archived: z.enum(['0', '1']).optional() }).parse(req.query ?? {});
    let list = await ctx.workspaces.list(req.principal!, { archived: q.archived === '1' });
    if (list.length === 0 && req.principal!.via !== 'token' && req.principal!.role !== 'READ_ONLY') {
      await ctx.workspaces.ensureDefault(req.principal!);
      list = await ctx.workspaces.list(req.principal!);
    }
    return { workspaces: list };
  });

  const reply400 = (message: string) => {
    throw new HttpError(400, message, 'BAD_REQUEST');
  };

  // Create: storage, engine, description and tags, a starting point (empty, a template, a clone) and people.
  app.post('/api/workspaces', async (req) => {
    requireWrite(req.principal!);
    const body = z
      .object({
        name: z.string().max(120),
        description: z.string().max(500).nullable().optional(),
        tags: z.array(z.string().max(40)).max(12).optional(),
        color: z.string().max(2).nullable().optional(),
        active_db_path: z.string().max(500).optional(),
        engine_settings: EngineSettings.optional(),
        cloud_connection_id: z.string().nullable().optional(),
        start_from: z.discriminatedUnion('kind', [z.object({ kind: z.literal('empty') }), z.object({ kind: z.literal('template'), template_id: z.string().min(1) }), z.object({ kind: z.literal('clone'), workspace_id: z.string().min(1) })]).optional(),
        members: z.array(z.object({ subject_type: z.enum(MEMBER_SUBJECT_TYPES), subject_id: z.string().min(1), role: z.enum(WORKSPACE_ROLES) })).max(200).optional(),
      })
      .parse(req.body);
    const { workspace, started } = await ctx.workspaceAdmin.create(req.principal!, body);
    return { workspace: await ctx.workspaces.describe(req.principal!, workspace.id), started };
  });

  // ---- administration: every workspace, and bulk actions
  app.get('/api/admin/workspaces', async (req) => ({ workspaces: await ctx.workspaceAdmin.list(req.principal!) }));
  app.post('/api/admin/workspaces/bulk', async (req) => {
    const body = z
      .object({
        ids: z.array(z.string().min(1)).min(1).max(500),
        action: z.enum(['archive', 'restore', 'delete', 'transfer', 'tag', 'untag']),
        user_id: z.string().optional(),
        tags: z.array(z.string().max(40)).max(12).optional(),
      })
      .parse(req.body);
    if (body.action === 'transfer' && !body.user_id) return reply400('Choose who receives the workspaces');
    if ((body.action === 'tag' || body.action === 'untag') && !body.tags?.length) return reply400('Name at least one tag');
    const action = body.action === 'transfer' ? { action: 'transfer' as const, user_id: body.user_id! } : body.action === 'tag' || body.action === 'untag' ? { action: body.action, tags: body.tags! } : { action: body.action };
    return { results: await ctx.workspaceAdmin.bulk(req.principal!, body.ids, action) };
  });
  // The detail page: counts, health, engine, connections; and what happened lately.
  app.get('/api/workspaces/:id/summary', async (req) => ctx.workspaceAdmin.summary(req.principal!, (req.params as { id: string }).id));
  app.get('/api/workspaces/:id/activity', async (req) => {
    const q = z.object({ limit: z.coerce.number().int().min(1).max(500).optional(), offset: z.coerce.number().int().min(0).optional() }).parse(req.query ?? {});
    return { events: await ctx.workspaceAdmin.activity(req.principal!, (req.params as { id: string }).id, q) };
  });
  // ---- the organisation's workspace policy: quotas, the idle policy, creation rules (administrators)
  const Policy = z.object({
    quotas: z.object({ storage_bytes: z.number().int().positive().nullable(), memory_limit: z.string().max(20).nullable(), query_seconds_per_day: z.number().int().positive().nullable() }),
    idle: z.object({ warn_days: z.number().int().min(1).max(3650).nullable(), archive_days: z.number().int().min(1).max(3650).nullable(), channel_ids: z.array(z.string().max(64)).max(20) }),
    creation: z.object({ admins_only: z.boolean(), name_pattern: z.string().max(200).nullable(), name_hint: z.string().max(200).nullable(), memory_limit: z.string().max(20).nullable(), threads: z.number().int().min(1).max(1024).nullable(), query_timeout_seconds: z.number().int().min(1).max(86_400).nullable() }),
  });
  app.get('/api/admin/workspace-policy', async (req) => {
    requireAdmin(req.principal!);
    return { policy: await ctx.lifecycle.policy() };
  });
  app.put('/api/admin/workspace-policy', async (req) => ({ policy: await ctx.lifecycle.setPolicy(req.principal!, Policy.parse(req.body ?? {})) }));
  app.post('/api/admin/workspace-policy/run', async (req) => {
    requireAdmin(req.principal!);
    return ctx.lifecycle.tick();
  });
  app.get('/api/workspaces/:id/quota', async (req) => ctx.lifecycle.quotaStatus(req.principal!, (req.params as { id: string }).id));

  // ---- backups: list, take now, schedule, restore, download, delete (owners)
  app.get('/api/workspaces/:id/backups', async (req) => {
    const { id } = req.params as { id: string };
    const w = await ctx.workspaces.get(req.principal!, id, 'OWNER');
    return { backups: await ctx.lifecycle.listBackups(req.principal!, id), policy: w.backup_policy ?? null, last_backup_at: w.last_backup_at ?? null };
  });
  app.post('/api/workspaces/:id/backups', async (req) => {
    requireWrite(req.principal!);
    const body = z.object({ note: z.string().max(200).nullable().optional() }).parse(req.body ?? {});
    return { backup: await ctx.lifecycle.backup(req.principal!, (req.params as { id: string }).id, 'manual', body.note ?? null) };
  });
  app.put('/api/workspaces/:id/backup-policy', async (req) => {
    requireWrite(req.principal!);
    const body = z.object({ policy: z.object({ every_hours: z.number().int(), keep: z.number().int() }).nullable() }).parse(req.body ?? {});
    await ctx.lifecycle.setBackupPolicy(req.principal!, (req.params as { id: string }).id, body.policy);
    return { ok: true };
  });
  app.post('/api/workspaces/:id/backups/:backupId/restore', async (req) => {
    requireWrite(req.principal!);
    const { id, backupId } = req.params as { id: string; backupId: string };
    const body = z.object({ objects: z.boolean().optional() }).parse(req.body ?? {});
    return ctx.lifecycle.restore(req.principal!, id, backupId, body);
  });
  app.delete('/api/workspaces/:id/backups/:backupId', async (req) => {
    requireWrite(req.principal!);
    const { id, backupId } = req.params as { id: string; backupId: string };
    await ctx.lifecycle.deleteBackup(req.principal!, id, backupId);
    return { ok: true };
  });
  app.get('/api/workspaces/:id/backups/:backupId/download', async (req, reply) => {
    const { id, backupId } = req.params as { id: string; backupId: string };
    const b = (await ctx.lifecycle.listBackups(req.principal!, id)).find((x) => x.id === backupId);
    if (!b || !b.exists) return reply400('That backup file is gone');
    reply.header('content-type', 'application/octet-stream');
    reply.header('content-disposition', `attachment; filename="${path.basename(b.file)}"`);
    reply.header('content-length', String(fs.statSync(b.file).size));
    return reply.send(fs.createReadStream(b.file));
  });

  // ---- bundles: a workspace as one .duckview file (data and objects), and back
  app.get('/api/workspaces/:id/bundle', async (req, reply) => {
    const r = await ctx.lifecycle.exportBundle(req.principal!, (req.params as { id: string }).id);
    reply.header('content-type', 'application/octet-stream');
    reply.header('content-disposition', `attachment; filename="${r.name.replace(/"/g, '')}"`);
    reply.header('content-length', String(fs.statSync(r.file).size));
    const stream = fs.createReadStream(r.file);
    stream.on('close', () => fs.rmSync(r.file, { force: true }));
    return reply.send(stream);
  });
  app.post('/api/workspaces/import', async (req) => {
    if (req.isMultipart()) {
      const dir = path.join(ctx.workspaces.jail.baseDir, '.duckview', 'imports');
      fs.mkdirSync(dir, { recursive: true });
      let tmp: string | null = null;
      const fields: Record<string, string> = {};
      for await (const part of req.parts()) {
        if (part.type === 'file') {
          tmp = path.join(dir, `${Date.now()}-${Math.random().toString(36).slice(2)}.duckview`);
          await pipeline(part.file, fs.createWriteStream(tmp));
          if (part.file.truncated) {
            fs.rmSync(tmp, { force: true });
            return reply400(`The bundle exceeds the upload limit of ${ctx.cfg.security.max_upload_bytes} bytes; copy it to the server and import it by path`);
          }
        } else fields[part.fieldname] = String(part.value ?? '');
      }
      if (!tmp) return reply400('Attach a .duckview file');
      try {
        const w = await ctx.lifecycle.importBundle(req.principal!, tmp, { name: fields.name, active_db_path: fields.active_db_path });
        return { workspace: await ctx.workspaces.describe(req.principal!, w.id) };
      } finally {
        fs.rmSync(tmp, { force: true });
      }
    }
    const body = z.object({ path: z.string().min(1).max(1000), name: z.string().max(120).optional(), active_db_path: z.string().max(500).optional() }).parse(req.body ?? {});
    const w = await ctx.lifecycle.importBundle(req.principal!, body.path, body);
    return { workspace: await ctx.workspaces.describe(req.principal!, w.id) };
  });

  // Archive or restore one workspace (owners).
  app.post('/api/workspaces/:id/archive', async (req) => {
    const { id } = req.params as { id: string };
    const body = z.object({ archived: z.boolean() }).parse(req.body ?? {});
    await ctx.workspaces.setArchived(req.principal!, id, body.archived);
    ctx.audit.log({ userId: req.principal!.userId, actorType: req.principal!.actorType, action: body.archived ? 'workspace.archive' : 'workspace.restore', resource: `workspace:${id}`, ip: req.ip });
    return { workspace: await ctx.workspaces.describe(req.principal!, id) };
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
    const body = z.object({ name: z.string().max(120).optional(), description: z.string().max(500).nullable().optional(), tags: z.array(z.string().max(40)).max(12).optional(), color: z.string().max(2).nullable().optional(), active_db_path: z.string().max(500).optional(), engine_settings: EngineSettings.optional(), cloud_connection_id: z.string().nullable().optional() }).parse(req.body);
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

  // In-memory → file, keeping every table: Mosaic's derived objects go first (they reference an attached in-memory
  // database the file cannot carry), then COPY FROM DATABASE into the new file, then the engine restarts on it.
  app.post('/api/workspaces/:id/persist', async (req) => {
    requireWrite(req.principal!);
    const { id } = req.params as { id: string };
    const body = z.object({ path: z.string().max(500).optional(), cloud_connection_id: z.string().nullable().optional() }).parse(req.body ?? {});
    await ctx.workspaces.get(req.principal!, id, 'OWNER');
    await ctx.mosaic.dropSchema(id);
    const r = await ctx.workspaces.persist(req.principal!, id, body.path, body.cloud_connection_id);
    ctx.audit.log({ userId: req.principal!.userId, actorType: req.principal!.actorType, action: 'workspace.persist', resource: `workspace:${id}`, ip: req.ip, queryText: r.path });
    return { ok: true, path: r.path, tables: r.tables, views: r.views, copied: r.copied, cloud_sync: r.cloud_sync, workspace: await ctx.workspaces.describe(req.principal!, id) };
  });
  // Cloud-backed workspaces: push the working copy to the object now (editors), and report where things stand.
  app.post('/api/workspaces/:id/sync', async (req) => {
    requireWrite(req.principal!);
    const { id } = req.params as { id: string };
    const w = await ctx.workspaces.get(req.principal!, id, 'EDITOR');
    if (ctx.workspaces.storageOf(w) !== 'cloud') return reply400('This workspace is not stored in the cloud');
    const state = await ctx.cloudSync.push(id, 'manual');
    ctx.audit.log({ userId: req.principal!.userId, actorType: req.principal!.actorType, action: 'workspace.cloud_sync', resource: `workspace:${id}`, ip: req.ip });
    return { ok: true, cloud_sync: state };
  });
  // Storage choices for the New-workspace dialog and the Storage panel.
  app.get('/api/workspaces/storage-options', async (req) => ({
    mode: ctx.cfg.security.filesystem_mode,
    engine_defaults: await ctx.workspaceAdmin.engineDefaults(),
    default_database: ctx.engines.defaultDatabase,
    data_directory: ctx.workspaces.jail.baseDir,
    cloud_connections: (await ctx.cloud.list(req.principal!.userId)).map((c) => ({ id: c.id, name: c.name, provider: c.provider, bucket: c.bucket, uri_scheme: c.uri_scheme })),
  }));
  // A file name for a new or to-be-persisted workspace, unique in the data directory.
  app.get('/api/workspaces/suggest-db-path', async (req) => {
    const q = z.object({ name: z.string().max(200).default('') }).parse(req.query ?? {});
    return { path: await ctx.workspaces.suggestDbPath(q.name), default_database: ctx.engines.defaultDatabase };
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
