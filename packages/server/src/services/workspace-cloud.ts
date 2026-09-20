/**
 * Cloud-backed workspace databases.
 *
 * DuckDB can only open a database file for writing on a local filesystem, so a workspace whose database lives in
 * object storage (`s3://bucket/team/analytics.duckdb`, also gs:// r2:// az://) works on a **local working copy**
 * under `<data dir>/.duckview/cloud/<workspace id>.duckdb` and is synchronised with the object:
 *   - pull: before the engine starts, the object is downloaded when there is no local copy or the object changed
 *     since the last sync (another instance pushed) and nothing local is unsynced;
 *   - push: after mutating SQL (debounced, `duckdb.cloud_sync_delay_seconds`), on demand ("Sync now"), when a
 *     workspace is persisted into the cloud, and at shutdown. A push is a transactionally consistent snapshot
 *     (ATTACH a temp file + COPY FROM DATABASE, so the engine keeps running) uploaded with a multipart upload.
 * The cloud connection is one of the owner's (credentials stay encrypted in the metadata store). One DuckView
 * instance writes a given workspace at a time; a remote change that arrives while local changes are unsynced is
 * reported in `cloud_sync.last_error` and never overwritten silently by a pull.
 */
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import type { MetadataStore } from '../db/index.js';
import type { CloudConnection, CloudSyncState, Workspace } from '../db/schema/sqlite.js';
import type { EngineManager, WorkspaceEngine } from '../engine/duckdb.js';
import type { CloudConnectionService } from './cloud.js';
import { badRequest } from './errors.js';
import { logger } from '../observability/logger.js';
import { liveEvents } from '../observability/events.js';

export interface CloudUri {
  scheme: 's3' | 'gs' | 'r2' | 'az';
  bucket: string;
  key: string;
}

const SCHEME_PROVIDER: Record<CloudUri['scheme'], CloudConnection['provider'][]> = { s3: ['S3'], r2: ['R2'], gs: ['GCS'], az: ['AZURE'] };

/** `s3://bucket/dir/file.duckdb` → parts; null for anything that is not a cloud database URI. */
export function parseCloudUri(uri: string): CloudUri | null {
  const m = /^(s3|gs|r2|az|azure):\/\/([^/]+)\/(.+)$/i.exec(uri.trim());
  if (!m) return null;
  const scheme = (m[1]!.toLowerCase() === 'azure' ? 'az' : m[1]!.toLowerCase()) as CloudUri['scheme'];
  return { scheme, bucket: m[2]!, key: m[3]! };
}
export const isCloudDbUri = (p: string) => parseCloudUri(p) !== null;

export class WorkspaceCloudSync {
  private timers = new Map<string, NodeJS.Timeout>();
  private inflight = new Map<string, Promise<CloudSyncState>>();

  constructor(private readonly store: MetadataStore, private readonly engines: EngineManager, private readonly cloud: CloudConnectionService, private readonly delaySeconds: number) {}
  private get db() {
    return this.store.db;
  }
  private get s() {
    return this.store.schema;
  }

  /** Local working copy of a cloud-backed workspace (inside the data directory, in a hidden folder). */
  localPath(workspaceId: string): string {
    const dir = path.join(this.engines.jail.baseDir, '.duckview', 'cloud');
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, `${workspaceId}.duckdb`);
  }

  /**
   * The owner's connection for a cloud URI: the one named on the workspace, or the one whose provider and bucket
   * match. Throws a clear 400 when none does.
   */
  async connectionFor(ownerId: string, uri: CloudUri, connectionId?: string | null): Promise<CloudConnection> {
    if (connectionId) {
      const c = await this.cloud.getOwned(ownerId, connectionId);
      if (!SCHEME_PROVIDER[uri.scheme].includes(c.provider)) throw badRequest(`Connection "${c.name}" is ${c.provider}, but the database URI is ${uri.scheme}://`);
      return c;
    }
    const all = await this.cloud.listOwned(ownerId);
    const match = all.find((c) => SCHEME_PROVIDER[uri.scheme].includes(c.provider) && (!c.bucket || c.bucket === uri.bucket)) ?? null;
    if (!match) throw badRequest(`No ${uri.scheme}:// cloud connection for bucket "${uri.bucket}" — add one under Settings → Storage → Cloud connections first`);
    return match;
  }

  private async saveState(workspaceId: string, state: CloudSyncState): Promise<CloudSyncState> {
    await this.db.update(this.s.workspaces).set({ cloud_sync: state }).where(eq(this.s.workspaces.id, workspaceId));
    liveEvents.publish({ type: 'workspace', at: new Date().toISOString(), user_id: null, workspace_id: workspaceId, data_version: -1, reason: 'cloud_sync' });
    return state;
  }

  /** Downloads the object into the working copy when it is newer than what we last synced. Returns the state. */
  async pull(w: Workspace): Promise<CloudSyncState> {
    const uri = parseCloudUri(w.active_db_path)!;
    const state: CloudSyncState = w.cloud_sync ?? { etag: null, synced_at: null, size_bytes: null, dirty: false, last_error: null };
    const local = this.localPath(w.id);
    const conn = await this.connectionFor(w.user_id, uri, w.cloud_connection_id);
    const remote = await this.cloud.headObject(conn, uri.bucket, uri.key);
    if (!remote) return fs.existsSync(local) ? state : this.saveState(w.id, { ...state, dirty: fs.existsSync(local) }); // brand new: the first push creates the object
    const localExists = fs.existsSync(local);
    if (localExists && remote.etag === state.etag) return state; // in sync
    if (localExists && state.dirty) {
      // Someone else pushed while we hold unsynced changes: keep ours, say so, never clobber silently.
      return this.saveState(w.id, { ...state, last_error: `The object changed in the cloud (${remote.modified_at ?? 'unknown time'}) while this instance has unsynced changes; local changes kept — sync now to overwrite, or make a copy first` });
    }
    // Any open engine must let go of the file before it is replaced.
    this.engines.evict(w.id);
    const t0 = Date.now();
    const got = await this.cloud.downloadObject(conn, uri.bucket, uri.key, local);
    fs.rmSync(`${local}.wal`, { force: true });
    logger().info({ workspace: w.id, uri: w.active_db_path, bytes: got.size_bytes, ms: Date.now() - t0 }, 'Cloud workspace pulled');
    return this.saveState(w.id, { etag: got.etag ?? remote.etag, synced_at: new Date().toISOString(), size_bytes: got.size_bytes, dirty: false, last_error: null });
  }

  /** Marks the workspace changed and schedules a push after the quiet period. */
  markDirty(w: Workspace): void {
    const state: CloudSyncState = { ...(w.cloud_sync ?? { etag: null, synced_at: null, size_bytes: null, last_error: null }), dirty: true };
    void this.saveState(w.id, state).catch(() => undefined);
    const existing = this.timers.get(w.id);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      this.timers.delete(w.id);
      void this.push(w.id, 'scheduled').catch((err) => logger().warn({ workspace: w.id, err: (err as Error).message }, 'Cloud workspace push failed'));
    }, this.delaySeconds * 1000);
    t.unref();
    this.timers.set(w.id, t);
  }

  /** Snapshot + upload. Coalesces concurrent calls for the same workspace. */
  push(workspaceId: string, reason: string): Promise<CloudSyncState> {
    const running = this.inflight.get(workspaceId);
    if (running) return running;
    const p = this.doPush(workspaceId, reason).finally(() => this.inflight.delete(workspaceId));
    this.inflight.set(workspaceId, p);
    return p;
  }

  private async doPush(workspaceId: string, reason: string): Promise<CloudSyncState> {
    const rows = await this.db.select().from(this.s.workspaces).where(eq(this.s.workspaces.id, workspaceId)).limit(1);
    const w = rows[0];
    if (!w) throw badRequest('Workspace not found');
    const uri = parseCloudUri(w.active_db_path);
    if (!uri) throw badRequest('This workspace is not stored in the cloud');
    const state: CloudSyncState = w.cloud_sync ?? { etag: null, synced_at: null, size_bytes: null, dirty: false, last_error: null };
    const local = this.localPath(w.id);
    if (!fs.existsSync(local)) return this.saveState(w.id, { ...state, dirty: false }); // never started: nothing to push
    const t0 = Date.now();
    const snapshot = `${local}.snapshot-${process.pid}-${Date.now()}`;
    try {
      const conn = await this.connectionFor(w.user_id, uri, w.cloud_connection_id);
      const engine = this.engines.peek(w.id);
      if (engine) await snapshotThroughEngine(engine, path.basename(local, '.duckdb'), snapshot);
      else {
        // No engine holds the file: a plain copy is consistent (DuckDB merged the WAL on last close).
        fs.copyFileSync(local, snapshot);
        if (fs.existsSync(`${local}.wal`)) fs.copyFileSync(`${local}.wal`, `${snapshot}.wal`);
      }
      const up = await this.cloud.uploadObject(conn, uri.bucket, uri.key, snapshot);
      const next: CloudSyncState = { etag: up.etag, synced_at: new Date().toISOString(), size_bytes: up.size_bytes, dirty: false, last_error: null, last_push_ms: Date.now() - t0 };
      logger().info({ workspace: w.id, uri: w.active_db_path, bytes: up.size_bytes, ms: next.last_push_ms, reason }, 'Cloud workspace pushed');
      return this.saveState(w.id, next);
    } catch (err) {
      const message = (err as Error).message;
      await this.saveState(w.id, { ...state, dirty: true, last_error: message }).catch(() => undefined);
      throw err;
    } finally {
      fs.rmSync(snapshot, { force: true });
      fs.rmSync(`${snapshot}.wal`, { force: true });
    }
  }

  /** Pushes every workspace with unsynced changes (shutdown), each within a bounded time. */
  async flush(timeoutMs = 120_000): Promise<void> {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    const rows = await this.db.select().from(this.s.workspaces);
    const dirty = rows.filter((w) => isCloudDbUri(w.active_db_path) && w.cloud_sync?.dirty);
    await Promise.allSettled(dirty.map((w) => Promise.race([this.push(w.id, 'shutdown'), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs))])));
  }
}

/** Consistent copy of a running engine's main database into a fresh file (the engine keeps serving queries). */
async function snapshotThroughEngine(engine: WorkspaceEngine, dbName: string, target: string): Promise<void> {
  const lit = target.replace(/'/g, "''");
  const ident = `"${dbName.replace(/"/g, '""')}"`;
  await engine.runInternal(`ATTACH '${lit}' AS __dv_snapshot`, 60_000);
  try {
    await engine.runInternal(`COPY FROM DATABASE ${ident} TO __dv_snapshot`, 30 * 60_000);
  } finally {
    await engine.runInternal('DETACH __dv_snapshot', 60_000).catch(() => undefined);
  }
}
