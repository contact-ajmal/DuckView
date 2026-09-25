import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { conditional } from './conditional.js';
import { badRequest } from '../services/errors.js';
import type { JailEntry } from '../engine/sandbox.js';
import fs from 'node:fs';
import path from 'node:path';
import { notFound } from '../services/errors.js';

export async function fileRoutes(app: FastifyInstance, ctx: AppContext) {
  app.addHook('preHandler', app.authenticate);

  // multipart/form-data: one or more `file` parts; optional `dir` field (relative sub-directory in the jail).
  app.post('/api/workspaces/:id/files', async (req) => {
    const { id } = req.params as { id: string };
    if (!req.isMultipart()) throw badRequest('Expected multipart/form-data');
    const q = z.object({ dir: z.string().optional(), overwrite: z.coerce.boolean().optional() }).parse(req.query ?? {});
    const uploaded: JailEntry[] = [];
    for await (const part of req.parts()) {
      if (part.type !== 'file') continue;
      const entry = await ctx.files.upload(req.principal!, id, { filename: part.filename, dir: q.dir, stream: part.file, overwrite: q.overwrite });
      if (part.file.truncated) throw badRequest(`${part.filename} exceeds the upload limit of ${ctx.cfg.security.max_upload_bytes} bytes`);
      uploaded.push(entry);
    }
    if (uploaded.length === 0) throw badRequest('No file parts found');
    return { files: uploaded };
  });

  app.delete('/api/workspaces/:id/files', async (req) => {
    const { id } = req.params as { id: string };
    const q = z.object({ path: z.string().min(1) }).parse(req.query ?? {});
    await ctx.files.remove(req.principal!, id, q.path);
    return { ok: true };
  });

  app.patch('/api/workspaces/:id/files', async (req) => {
    const { id } = req.params as { id: string };
    const body = z.object({ path: z.string().min(1), name: z.string().min(1).max(255) }).parse(req.body);
    return ctx.files.rename(req.principal!, id, body.path, body.name);
  });

  // Streams a file from the jail (exports, uploads). Path is validated by the jail; directories are refused.
  app.get('/api/workspaces/:id/files/download', async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = z.object({ path: z.string().min(1) }).parse(req.query ?? {});
    await ctx.workspaces.get(req.principal!, id);
    const target = ctx.workspaces.jail.resolve(q.path);
    if (!target.exists || !fs.statSync(target.absolute).isFile()) throw notFound('File');
    ctx.audit.log({ userId: req.principal!.userId, actorType: req.principal!.actorType, action: 'file.download', resource: `file:${target.relative}`, ip: req.ip });
    const name = path.basename(target.absolute);
    const types: Record<string, string> = { '.csv': 'text/csv', '.json': 'application/json', '.jsonl': 'application/x-ndjson', '.parquet': 'application/vnd.apache.parquet' };
    reply.header('content-type', types[path.extname(name).toLowerCase()] ?? 'application/octet-stream');
    reply.header('content-disposition', `attachment; filename="${name.replace(/"/g, '')}"`);
    reply.header('content-length', String(fs.statSync(target.absolute).size));
    return reply.send(fs.createReadStream(target.absolute));
  });

  app.post('/api/workspaces/:id/overview', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ target: z.string().min(1), sample_rows: z.number().int().min(1).max(500).optional(), refresh: z.boolean().optional() }).parse(req.body);
    return conditional(req, reply, (c) => ctx.queries.overview(req.principal!, id, body.target, c));
  });
}
