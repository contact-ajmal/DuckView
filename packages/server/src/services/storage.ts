/**
 * File & cloud explorer backend: local tree (jailed), cloud listings, and instant schema inspection.
 */
import type { DuckViewConfig } from '../config/index.js';
import type { WorkspaceService } from './workspaces.js';
import type { AuditService } from './audit.js';
import type { CloudConnectionService } from './cloud.js';
import type { Principal } from './principal.js';
import { requireScope, requireWrite } from './principal.js';
import { isRemoteUri, type TreeEntry } from '../engine/sandbox.js';
import type { InspectResult } from '../engine/duckdb.js';
import { HttpError } from './errors.js';
import { unwrap, type ResultCache, type CacheMeta } from './cache.js';

export class StorageService {
  constructor(private readonly cfg: DuckViewConfig, private readonly workspaces: WorkspaceService, private readonly cloud: CloudConnectionService, private readonly audit: AuditService, private readonly cache: ResultCache) {}

  get externalAccess(): boolean {
    return this.cfg.security.enable_external_access || this.cfg.security.filesystem_mode === 'full';
  }

  /** One level of the local tree. In sandboxed mode paths are relative to the data directory; in full mode absolute paths are allowed. */
  async local(p: Principal, workspaceId: string, dirPath = '.'): Promise<{ mode: 'sandboxed' | 'full'; root: string; path: string; absolute: string; entries: TreeEntry[] }> {
    requireScope(p, 'read');
    await this.workspaces.get(p, workspaceId);
    const jail = this.workspaces.jail;
    const listing = jail.listDir(dirPath || '.', { showHidden: false, exclude: await this.workspaces.activeDatabaseFiles() });
    // Entries under an added folder are reported with absolute paths (relativeTo() returns absolute outside the data dir).
    return { mode: this.cfg.security.filesystem_mode, root: jail.isFullFilesystem ? jail.baseDir : jail.root, ...listing };
  }

  /** Folder picker: directories under `dirPath` (home directory by default in full mode). */
  async browse(p: Principal, workspaceId: string, dirPath?: string) {
    requireScope(p, 'read');
    await this.workspaces.get(p, workspaceId);
    return { mode: this.cfg.security.filesystem_mode, ...this.workspaces.jail.browseDirs(dirPath) };
  }

  /** Location browser: one folder's folders and files, with absolute paths. */
  async locate(p: Principal, workspaceId: string, dirPath?: string, showHidden = false) {
    requireScope(p, 'read');
    await this.workspaces.get(p, workspaceId);
    return { mode: this.cfg.security.filesystem_mode, ...this.workspaces.jail.locate(dirPath, { showHidden }) };
  }

  /** The browser's sidebar: the data directory, home folders and volumes (full mode), and this workspace's folders. */
  async places(p: Principal, workspaceId: string) {
    requireScope(p, 'read');
    const w = await this.workspaces.get(p, workspaceId);
    return { mode: this.cfg.security.filesystem_mode, places: this.workspaces.jail.places(), workspace_folders: w.folders.map((f) => ({ name: f.name, path: f.path })) };
  }

  async mkdir(p: Principal, workspaceId: string, parent: string, name: string) {
    requireWrite(p);
    await this.workspaces.get(p, workspaceId);
    const created = this.workspaces.jail.mkdir(parent, name);
    this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'storage.mkdir', resource: `folder:${created}`, ip: p.ip });
    return { path: created };
  }

  async cloudBuckets(p: Principal, connectionId: string) {
    requireScope(p, 'read');
    const c = await this.cloud.getOwned(p.userId, connectionId);
    const buckets = await this.cloud.listBuckets(c);
    return { connection: { id: c.id, name: c.name, provider: c.provider, bucket: c.bucket }, buckets, queryable: this.externalAccess };
  }

  async cloudObjects(p: Principal, connectionId: string, bucket: string, prefix = '', continuationToken?: string) {
    requireScope(p, 'read');
    const c = await this.cloud.getOwned(p.userId, connectionId);
    const out = await this.cloud.listObjects(c, bucket, prefix, { continuationToken });
    this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'storage.browse', resource: `${c.provider.toLowerCase()}:${bucket}/${out.prefix}`, ip: p.ip });
    return { connection: { id: c.id, name: c.name, provider: c.provider }, queryable: this.externalAccess, ...out };
  }

  /** DESCRIBE-based schema preview for a local file, remote object, table/view, .duckdb file, or SELECT. */
  async inspect(p: Principal, workspaceId: string, target: string, opts: { refresh?: boolean; ifNoneMatch?: string | null } = {}): Promise<InspectResult & CacheMeta> {
    requireScope(p, 'read');
    if (isRemoteUri(target) && !this.externalAccess) {
      throw new HttpError(409, 'Remote objects require security.enable_external_access=true (set DUCKVIEW_ENABLE_EXTERNAL_ACCESS=true and restart).', 'EXTERNAL_ACCESS_DISABLED');
    }
    const start = performance.now();
    try {
      const out = await this.cache.through(p, workspaceId, 'inspect', target, null, opts, async () => {
        const { engine } = await this.workspaces.engine(p, workspaceId);
        return engine.inspect(target);
      });
      this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'storage.inspect', resource: target.slice(0, 500), durationMs: performance.now() - start, ip: p.ip });
      return unwrap(out);
    } catch (err) {
      this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'storage.inspect', resource: target.slice(0, 500), durationMs: performance.now() - start, ip: p.ip, status: 'error', error: (err as Error).message });
      throw err;
    }
  }
}
