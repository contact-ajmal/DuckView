/**
 * File ingestion into the data jail (drag-and-drop uploads) and deletion.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import type { DuckViewConfig } from '../config/index.js';
import type { WorkspaceService } from './workspaces.js';
import type { AuditService } from './audit.js';
import type { Principal } from './principal.js';
import { requireWrite } from './principal.js';
import { SandboxViolation, type JailEntry } from '../engine/sandbox.js';
import { badRequest, notFound } from './errors.js';

export class FileService {
  constructor(private readonly cfg: DuckViewConfig, private readonly workspaces: WorkspaceService, private readonly audit: AuditService) {}

  private checkExtension(name: string) {
    const lower = name.toLowerCase();
    const parts = lower.split('.').slice(1);
    const ok = parts.some((ext) => this.cfg.security.allowed_upload_extensions.includes(ext));
    if (!ok) throw badRequest(`File type not allowed. Accepted: ${this.cfg.security.allowed_upload_extensions.join(', ')}`);
  }

  /** Streams an upload to `<jail>/<dir>/<filename>`. Writes to a temp file first, then renames atomically. */
  async upload(p: Principal, workspaceId: string, input: { filename: string; dir?: string; stream: Readable; overwrite?: boolean }): Promise<JailEntry> {
    requireWrite(p);
    await this.workspaces.get(p, workspaceId, 'EDITOR');
    const base = path.posix.basename(input.filename.replace(/\\/g, '/')).replace(/[^\w.\-+@ ]/g, '_').trim();
    if (!base || base.startsWith('.')) throw badRequest('Invalid filename');
    this.checkExtension(base);
    const rel = path.posix.join((input.dir ?? '').replace(/\\/g, '/').replace(/^\/+/, ''), base);
    const target = this.workspaces.jail.resolve(rel); // SandboxViolation on escape
    if (target.exists && !input.overwrite) throw badRequest(`${target.relative} already exists`);
    fs.mkdirSync(path.dirname(target.absolute), { recursive: true });
    const tmp = `${target.absolute}.upload-${process.pid}-${Date.now()}`;
    try {
      await pipeline(input.stream, fs.createWriteStream(tmp, { flags: 'wx' }));
      fs.renameSync(tmp, target.absolute);
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      throw err;
    }
    const stat = fs.statSync(target.absolute);
    this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'file.upload', resource: `file:${target.relative}`, ip: p.ip, durationMs: null });
    return { path: target.relative, kind: kindOf(base), size_bytes: stat.size, modified_at: stat.mtime.toISOString() };
  }

  async remove(p: Principal, workspaceId: string, relPath: string): Promise<void> {
    requireWrite(p);
    await this.workspaces.get(p, workspaceId, 'EDITOR');
    const target = this.workspaces.jail.resolve(relPath);
    if (!target.exists) throw notFound('File');
    const stat = fs.statSync(target.absolute);
    if (stat.isDirectory()) {
      // Only Delta/Iceberg table directories (as listed by the catalog) may be removed.
      const isTable = fs.existsSync(path.join(target.absolute, '_delta_log')) || fs.existsSync(path.join(target.absolute, 'metadata'));
      if (!isTable) throw new SandboxViolation('Only files or table directories can be deleted', relPath);
      fs.rmSync(target.absolute, { recursive: true, force: true });
    } else {
      fs.unlinkSync(target.absolute);
    }
    this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'file.delete', resource: `file:${target.relative}`, ip: p.ip });
  }
}

function kindOf(name: string): JailEntry['kind'] {
  const l = name.toLowerCase().replace(/\.(gz|zst|bz2)$/, '');
  if (l.endsWith('.parquet') || l.endsWith('.pq')) return 'parquet';
  if (l.endsWith('.csv') || l.endsWith('.tsv') || l.endsWith('.txt')) return 'csv';
  if (l.endsWith('.json') || l.endsWith('.jsonl') || l.endsWith('.ndjson')) return 'json';
  if (l.endsWith('.duckdb') || l.endsWith('.ddb') || l.endsWith('.db')) return 'duckdb';
  if (l.endsWith('.arrow') || l.endsWith('.feather')) return 'arrow';
  if (l.endsWith('.xlsx') || l.endsWith('.xls')) return 'excel';
  return 'other';
}
