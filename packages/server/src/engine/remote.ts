/**
 * A workspace engine held by another cluster node: the same methods as WorkspaceEngine, forwarded over internal
 * HTTP to the node that holds the workspace's lease (routes/cluster.ts), which runs them on its DuckDB instance.
 *
 * SQL arrives already rewritten by access policies (the policy guard wraps this object like a local engine), and
 * checked by the sandbox here first (guard / resolveRelation run locally: they only depend on the configuration
 * and the data directory, which every node shares). Streams come back as newline-delimited JSON; an aborted
 * request interrupts the query on the other node. Errors keep their kind (sandbox, timeout, HTTP status).
 */
import type { DuckViewConfig } from '../config/index.js';
import type { ClusterService } from '../services/cluster.js';
import { WorkspaceEngine, QueryTimeoutError, type ExecuteOptions } from './duckdb.js';
import { SandboxViolation, type DataJail } from './sandbox.js';
import type { ColumnSchema } from './results.js';
import { HttpError } from '../services/errors.js';

/** The engine's error, rebuilt from its JSON form. */
export function engineError(e: { name?: string; message?: string; statusCode?: number; code?: string; attempted?: string; timeoutMs?: number }): Error {
  if (e.name === 'SandboxViolation') return new SandboxViolation(e.message ?? 'Sandbox violation', e.attempted ?? '');
  if (e.name === 'QueryTimeoutError') return new QueryTimeoutError(e.timeoutMs ?? 0);
  if (e.statusCode) return new HttpError(e.statusCode, e.message ?? 'Error', e.code ?? 'ERROR');
  const err = new Error(e.message ?? 'Error');
  if (e.name) err.name = e.name;
  return err;
}

/** The JSON form of an engine error (the other side of engineError). */
export function errorJson(err: unknown): Record<string, unknown> {
  const e = err as Error & { statusCode?: number; code?: string; attempted?: string; timeoutMs?: number };
  return { name: e.name, message: e.message ?? String(err), statusCode: e.statusCode, code: e.code, attempted: e.attempted, timeoutMs: e.timeoutMs };
}

export class RemoteEngine {
  readonly externalAccess: boolean;
  readonly attachErrors = new Map<string, string>();
  readonly createdAt = Date.now();
  lastUsed = Date.now();
  readonly remote = true;

  constructor(
    private readonly cluster: ClusterService,
    /** The holder's internal URL and node id. */
    readonly node: { id: string; url: string },
    readonly workspaceId: string,
    private readonly cfg: DuckViewConfig,
    readonly jail: DataJail,
  ) {
    this.externalAccess = cfg.security.enable_external_access || cfg.security.filesystem_mode === 'full';
  }

  get activeQueryCount() {
    return 0;
  }
  get fingerprint() {
    return `remote:${this.node.id}`;
  }
  get memoryLimit() {
    return { display: 'on another node', bytes: 0 };
  }
  get threads() {
    return 0;
  }
  get tempDirectory() {
    return this.cfg.duckdb.temp_directory;
  }

  guard(sql: string) {
    return WorkspaceEngine.prototype.guard.call(this as unknown as WorkspaceEngine, sql);
  }

  resolveRelation(target: string) {
    return WorkspaceEngine.prototype.resolveRelation.call(this as unknown as WorkspaceEngine, target);
  }

  private async rpc<T>(method: string, args: unknown[], signal?: AbortSignal): Promise<T> {
    const res = await this.cluster.call(this.node.url, '/internal/cluster/engine', { workspace_id: this.workspaceId, method, args }, { signal });
    const body = (await res.json().catch(() => ({ error: { message: `The node holding this workspace answered ${res.status}` } }))) as { result?: T; error?: Record<string, unknown> };
    if (body.error) throw engineError(body.error);
    return body.result as T;
  }

  /** Options without what cannot travel (the abort signal travels as the request's own). */
  private opts<T extends { signal?: AbortSignal }>(o: T | undefined): Omit<T, 'signal'> | undefined {
    if (!o) return o;
    const { signal: _s, ...rest } = o;
    return rest;
  }

  execute(sql: string, opts: ExecuteOptions = {}) {
    return this.rpc<Awaited<ReturnType<WorkspaceEngine['execute']>>>('execute', [sql, this.opts(opts)], opts.signal);
  }

  async stream(sql: string, handlers: { onSchema: (columns: ColumnSchema[]) => void; onRows: (rows: unknown[][]) => void | Promise<void> }, opts: ExecuteOptions = {}) {
    const res = await this.cluster.call(this.node.url, '/internal/cluster/stream', { workspace_id: this.workspaceId, sql, opts: this.opts(opts) }, { signal: opts.signal });
    if (!res.body) throw new Error('No stream from the node holding this workspace');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let done: Awaited<ReturnType<WorkspaceEngine['stream']>> | null = null;
    for (;;) {
      const { value, done: end } = await reader.read();
      if (value) buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line) as { schema?: ColumnSchema[]; rows?: unknown[][]; done?: typeof done; error?: Record<string, unknown> };
        if (msg.error) throw engineError(msg.error);
        if (msg.schema) handlers.onSchema(msg.schema);
        if (msg.rows) await handlers.onRows(msg.rows);
        if (msg.done) done = msg.done;
      }
      if (end) break;
    }
    if (!done) throw new Error('The stream from the node holding this workspace ended early');
    return done;
  }

  explain(sql: string, opts: { analyze?: boolean; timeoutMs?: number } = {}) {
    return this.rpc<Awaited<ReturnType<WorkspaceEngine['explain']>>>('explain', [sql, opts]);
  }
  summarize(target: string, opts: { timeoutMs?: number } = {}) {
    return this.rpc<Awaited<ReturnType<WorkspaceEngine['summarize']>>>('summarize', [target, opts]);
  }
  overview(target: string, opts: Parameters<WorkspaceEngine['overview']>[1] = {}) {
    return this.rpc<Awaited<ReturnType<WorkspaceEngine['overview']>>>('overview', [target, opts]);
  }
  inspect(target: string, opts: { timeoutMs?: number } = {}) {
    return this.rpc<Awaited<ReturnType<WorkspaceEngine['inspect']>>>('inspect', [target, opts]);
  }
  exportTo(sql: string, format: Parameters<WorkspaceEngine['exportTo']>[1], outPath: string, opts: { timeoutMs?: number; signal?: AbortSignal } = {}) {
    // The data directory is shared, so the path means the same file on the other node.
    return this.rpc<Awaited<ReturnType<WorkspaceEngine['exportTo']>>>('exportTo', [sql, format, outPath, this.opts(opts)], opts.signal);
  }
  catalog() {
    return this.rpc<Awaited<ReturnType<WorkspaceEngine['catalog']>>>('catalog', []);
  }
  lakehouseTree(alias: string, schema?: string) {
    return this.rpc<Awaited<ReturnType<WorkspaceEngine['lakehouseTree']>>>('lakehouseTree', [alias, schema]);
  }
  memoryStats() {
    return this.rpc<Awaited<ReturnType<WorkspaceEngine['memoryStats']>>>('memoryStats', []);
  }
  hasExtension(name: string) {
    return this.rpc<boolean>('hasExtension', [name]);
  }
  version() {
    return this.rpc<string>('version', []);
  }
  runInternal(sql: string, timeoutMs = 60_000) {
    return this.rpc<Record<string, unknown>[]>('runInternal', [sql, timeoutMs]);
  }
  retryAttachment(alias: string) {
    return this.rpc<string | null>('retryAttachment', [alias]);
  }
  /** Secrets and attachments are applied by the node that opens the engine. */
  async applySecrets(): Promise<boolean> {
    return true;
  }
  async applyAttachments(): Promise<boolean> {
    return true;
  }
  close(): void {
    /* nothing held here */
  }
}

/** Engine methods a remote node may call (and nothing else). */
export const REMOTE_METHODS = new Set(['execute', 'explain', 'summarize', 'overview', 'inspect', 'exportTo', 'catalog', 'lakehouseTree', 'memoryStats', 'hasExtension', 'version', 'runInternal', 'retryAttachment']);
