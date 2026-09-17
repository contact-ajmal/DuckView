/**
 * Streaming result exports. DuckDB writes the full result to a server-side temp file (COPY … TO, or the
 * Arrow IPC writer), then the file is streamed to the browser with a Content-Length — nothing is
 * materialised in Node or browser memory. Files expire after `duckdb.export_ttl_seconds`.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { DuckViewConfig } from '../config/index.js';
import type { WorkspaceService } from './workspaces.js';
import type { AuditService } from './audit.js';
import type { Principal } from './principal.js';
import { requireScope } from './principal.js';
import { EXPORT_EXTENSIONS, type ExportFormat } from '../engine/duckdb.js';
import { analyzeSql } from '../engine/sql-guard.js';
import { newId } from '../security/crypto.js';
import { badRequest, notFound } from './errors.js';
import { logger } from '../observability/logger.js';

export interface ExportRecord {
  id: string;
  user_id: string;
  workspace_id: string;
  name: string;
  format: ExportFormat;
  content_type: string;
  path: string;
  rows: number;
  size_bytes: number;
  engine: 'duckdb' | 'node-arrow';
  duration_ms: number;
  created_at: string;
  expires_at: string;
  downloads: number;
}

const CONTENT_TYPES: Record<ExportFormat, string> = {
  parquet: 'application/vnd.apache.parquet',
  csv: 'text/csv; charset=utf-8',
  json: 'application/x-ndjson',
  arrow: 'application/vnd.apache.arrow.stream',
};

export class ExportService {
  private records = new Map<string, ExportRecord>();
  private readonly dir: string;
  private sweeper: NodeJS.Timeout;

  constructor(private readonly cfg: DuckViewConfig, private readonly workspaces: WorkspaceService, private readonly audit: AuditService) {
    this.dir = path.join(cfg.duckdb.temp_directory, 'exports');
    fs.mkdirSync(this.dir, { recursive: true });
    // Orphans from a previous process are removed on start.
    for (const f of fs.readdirSync(this.dir)) fs.rmSync(path.join(this.dir, f), { force: true, recursive: true });
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref();
  }

  async create(p: Principal, workspaceId: string, input: { sql: string; format: ExportFormat; filename?: string }): Promise<ExportRecord> {
    requireScope(p, 'read');
    if (!input.sql?.trim()) throw badRequest('sql is required');
    if (!(input.format in EXPORT_EXTENSIONS)) throw badRequest('format must be parquet, csv, json or arrow');
    const a = analyzeSql(input.sql);
    if (a.statements.length !== 1 || a.isMutating) throw badRequest('Exports accept exactly one read-only statement');
    const { engine } = await this.workspaces.engine(p, workspaceId);
    const id = newId();
    const ext = EXPORT_EXTENSIONS[input.format];
    const safeName = (input.filename?.trim().replace(/\.[A-Za-z0-9]+$/, '') || 'result').replace(/[^\w.\- ]+/g, '_').slice(0, 80);
    const filePath = path.join(this.dir, p.userId, `${id}.${ext}`);
    const start = performance.now();
    try {
      const out = await engine.exportTo(input.sql, input.format, filePath);
      if (out.rows > this.cfg.duckdb.export_max_rows) {
        fs.rmSync(filePath, { force: true });
        throw badRequest(`Export exceeds duckdb.export_max_rows (${this.cfg.duckdb.export_max_rows})`);
      }
      const now = Date.now();
      const rec: ExportRecord = {
        id,
        user_id: p.userId,
        workspace_id: workspaceId,
        name: `${safeName}.${ext}`,
        format: input.format,
        content_type: CONTENT_TYPES[input.format],
        path: filePath,
        rows: out.rows,
        size_bytes: out.bytes,
        engine: out.engine,
        duration_ms: Math.round(performance.now() - start),
        created_at: new Date(now).toISOString(),
        expires_at: new Date(now + this.cfg.duckdb.export_ttl_seconds * 1000).toISOString(),
        downloads: 0,
      };
      this.records.set(id, rec);
      this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'export.create', resource: `export:${id}`, queryText: input.sql, durationMs: rec.duration_ms, ip: p.ip });
      return rec;
    } catch (err) {
      fs.rmSync(filePath, { force: true });
      this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'export.create', resource: `workspace:${workspaceId}`, queryText: input.sql, durationMs: performance.now() - start, ip: p.ip, status: 'error', error: (err as Error).message });
      throw err;
    }
  }

  list(p: Principal): ExportRecord[] {
    return [...this.records.values()].filter((r) => r.user_id === p.userId).sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  get(p: Principal, id: string): ExportRecord {
    const r = this.records.get(id);
    if (!r || r.user_id !== p.userId) throw notFound('Export');
    if (!fs.existsSync(r.path)) {
      this.records.delete(id);
      throw notFound('Export (expired)');
    }
    return r;
  }

  /** Opens a read stream; the caller sets headers from the record. */
  open(p: Principal, id: string): { record: ExportRecord; stream: fs.ReadStream } {
    const record = this.get(p, id);
    record.downloads++;
    this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'export.download', resource: `export:${id}`, ip: p.ip });
    return { record, stream: fs.createReadStream(record.path) };
  }

  remove(p: Principal, id: string): void {
    const r = this.get(p, id);
    fs.rmSync(r.path, { force: true });
    this.records.delete(id);
  }

  private sweep() {
    const now = Date.now();
    for (const [id, r] of this.records) {
      if (new Date(r.expires_at).getTime() < now) {
        fs.rmSync(r.path, { force: true });
        this.records.delete(id);
        logger().debug({ id }, 'Expired export removed');
      }
    }
  }

  close() {
    clearInterval(this.sweeper);
  }
}
