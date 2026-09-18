/**
 * ResultCache — server-side cache for expensive read operations (overview profiles, SUMMARIZE, schema inspection,
 * EXPLAIN plans, dashboard widget data, read-only SQL results).
 *
 * Correctness comes from the key, not from timers:
 *   - every local file the operation touches contributes `absolute path + size + mtime`;
 *   - anything that can read in-database tables also embeds the workspace **data epoch** (`workspaces.data_version`),
 *     which every mutation, upload, folder change and :memory: engine (re)start bumps — see WorkspaceService.bumpVersion;
 *   - operations that touch remote objects (s3://…), MotherDuck or attached lakehouse catalogs have no version signal
 *     and fall back to a short TTL (`cache.remote_ttl_seconds`; 0 = never cached);
 *   - SQL using non-deterministic functions (random(), now(), …) is never cached.
 *
 * The key doubles as the HTTP ETag: a client presenting `If-None-Match: <key>` whose key still matches the freshly
 * computed one holds current data, whether or not the server still has the entry.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DuckViewConfig } from '../config/index.js';
import { DataJail, isRemoteUri, looksLikePath } from '../engine/sandbox.js';
import { extractPathLiterals, tokenize } from '../engine/sql-guard.js';
import type { Principal } from './principal.js';
import type { WorkspaceService, WorkspaceAccess } from './workspaces.js';
import { metrics } from '../observability/metrics.js';
import { logger } from '../observability/logger.js';

export type CacheKind = 'overview' | 'profile' | 'inspect' | 'explain' | 'query' | 'widget';

interface Entry {
  value: unknown;
  bytes: number;
  computedAt: string;
  expiresAt: number;
  workspaceId: string;
  /** Entries whose key embeds the data epoch; dropped eagerly when the epoch moves. Pure-file entries survive. */
  versioned: boolean;
}

export interface CachePlan {
  /** null → do not cache (disabled, non-deterministic, or remote with TTL 0). */
  key: string | null;
  ttlMs: number;
  versioned: boolean;
  workspace: WorkspaceAccess;
}

export type CacheOutcome<T> = { status: 'not_modified'; etag: string } | { status: 'hit' | 'miss' | 'bypass'; etag: string | null; value: T; cached: boolean; computed_at: string };

/** Cache provenance attached to every cacheable result. `etag` is null when the operation was not cacheable. */
export interface CacheMeta {
  etag: string | null;
  cached: boolean;
  computed_at: string;
}

/** Raised (only when the caller supplied `ifNoneMatch`) so the HTTP layer can answer 304 without a body. */
export class NotModified extends Error {
  readonly code = 'NOT_MODIFIED';
  readonly statusCode = 304;
  constructor(readonly etag: string) {
    super('Not modified');
    this.name = 'NotModified';
  }
}

/** Flattens an outcome into `value + meta`, turning `not_modified` into a NotModified error. */
export function unwrap<T extends object>(o: CacheOutcome<T>): T & CacheMeta {
  if (o.status === 'not_modified') throw new NotModified(o.etag);
  return { ...o.value, etag: o.etag, cached: o.cached, computed_at: o.computed_at };
}

/** DuckDB functions whose output depends on more than their inputs — results of SQL using them are never cached. */
const NONDETERMINISTIC = new Set(['RANDOM', 'SETSEED', 'NOW', 'CURRENT_TIMESTAMP', 'CURRENT_DATE', 'CURRENT_TIME', 'LOCALTIME', 'LOCALTIMESTAMP', 'GET_CURRENT_TIMESTAMP', 'GET_CURRENT_TIME', 'TODAY', 'UUID', 'GEN_RANDOM_UUID', 'UUIDV4', 'UUIDV7', 'CURRENT_QUERY', 'TRANSACTION_TIMESTAMP', 'PG_BACKEND_PID', 'CURRENT_SETTING']);

export function isDeterministicSql(sql: string): boolean {
  return !tokenize(sql).some((t) => t.type === 'word' && NONDETERMINISTIC.has(t.value));
}

/** Path literals an operation will read: a bare file target, or the string literals inside SQL. */
function pathLiteralsOf(text: string): string[] {
  const t = text.trim();
  if (!t) return [];
  if (/^(select|with|from|pivot|unpivot|values|table|describe|summarize|explain|show)\b/i.test(t)) return extractPathLiterals(t).map((l) => l.value);
  if (looksLikePath(t) || isRemoteUri(t)) return [t];
  return extractPathLiterals(t).map((l) => l.value);
}

export class ResultCache {
  private entries = new Map<string, Entry>();
  private bytes = 0;
  private hits = 0;
  private misses = 0;

  constructor(private readonly cfg: DuckViewConfig, private readonly workspaces: WorkspaceService, private readonly jail: DataJail) {}

  get enabled() {
    return this.cfg.cache.enabled && this.cfg.cache.max_bytes > 0;
  }

  // ---------- key construction ----------

  /** Fingerprints the local files a text refers to and flags remote references. Never throws (a bad path → 'invalid'). */
  private fingerprint(text: string): { parts: string[]; remote: boolean } {
    const parts: string[] = [];
    let remote = false;
    for (const lit of pathLiteralsOf(text)) {
      if (isRemoteUri(lit)) {
        remote = true;
        continue;
      }
      try {
        const r = this.jail.resolve(lit, { allowGlob: true });
        if (/[*?\[\]{}]/.test(r.absolute)) {
          // Glob: the directory's mtime moves when files are added/removed; individual edits are caught only when
          // the epoch moves. Good enough for the common "dropped a new partition" case.
          const dir = path.dirname(r.absolute);
          const st = fs.statSync(dir, { throwIfNoEntry: false });
          parts.push(`${r.absolute}|dir:${st ? st.mtimeMs : 'missing'}`);
        } else {
          const st = fs.statSync(r.absolute, { throwIfNoEntry: false });
          parts.push(`${r.absolute}|${st ? (st.isDirectory() ? `dir:${st.mtimeMs}` : `${st.size}:${st.mtimeMs}`) : 'missing'}`);
        }
      } catch {
        parts.push(`${lit}|invalid`);
      }
    }
    return { parts, remote };
  }

  /**
   * Decides whether and how an operation is cacheable and computes its key. Resolves workspace access on the way
   * (404/403 propagate exactly as they would from the operation itself), so callers can rely on it as an authz step.
   */
  async plan(p: Principal, workspaceId: string, kind: CacheKind, text: string, options: unknown = null): Promise<CachePlan> {
    const workspace = await this.workspaces.get(p, workspaceId);
    const none: CachePlan = { key: null, ttlMs: 0, versioned: false, workspace };
    if (!this.enabled) return none;
    if (!isDeterministicSql(text)) return none;
    const fp = this.fingerprint(text);
    const words = new Set(tokenize(text).filter((t) => t.type === 'word' || t.type === 'ident').map((t) => t.value.toLowerCase()));
    // Not memoised on purpose: a deleted connection must stop matching immediately (one indexed read).
    const aliases = await this.workspaces.lakehouseAliases(workspace.user_id);
    const touchesRemote = fp.remote || workspace.active_db_path.toLowerCase().startsWith('md:') || aliases.some((a) => words.has(a.toLowerCase()));
    // A bare file target depends on nothing but the file bytes; everything else may read in-database tables.
    // (looksLikePath wins over the identifier shape, exactly as resolveRelation does: 'nums.parquet' is a file.)
    const pureFile = (kind === 'overview' || kind === 'profile' || kind === 'inspect') && fp.parts.length === 1 && looksLikePath(text.trim()) && !/^(select|with|from|pivot|unpivot)\b/i.test(text.trim());
    const versioned = !pureFile;
    let ttlMs = this.cfg.cache.ttl_seconds * 1000;
    if (touchesRemote) {
      if (this.cfg.cache.remote_ttl_seconds <= 0) return none;
      ttlMs = this.cfg.cache.remote_ttl_seconds * 1000;
    }
    const material = [kind, workspaceId, text.trim(), options ?? null, fp.parts, versioned ? workspace.data_version : null, touchesRemote ? 'remote' : 'local'];
    const key = crypto.createHash('sha256').update(JSON.stringify(material)).digest('hex').slice(0, 40);
    return { key, ttlMs, versioned, workspace };
  }

  // ---------- store ----------

  get<T>(key: string): { value: T; computedAt: string } | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (e.expiresAt < Date.now()) {
      this.drop(key);
      return undefined;
    }
    // Map preserves insertion order — re-inserting makes this the most recently used entry.
    this.entries.delete(key);
    this.entries.set(key, e);
    return { value: e.value as T, computedAt: e.computedAt };
  }

  set(key: string, value: unknown, opts: { ttlMs: number; workspaceId: string; versioned: boolean }): boolean {
    if (!this.enabled) return false;
    let bytes: number;
    try {
      bytes = Buffer.byteLength(JSON.stringify(value));
    } catch {
      return false;
    }
    if (bytes > this.cfg.cache.max_entry_bytes || bytes > this.cfg.cache.max_bytes) return false;
    this.drop(key);
    this.entries.set(key, { value, bytes, computedAt: new Date().toISOString(), expiresAt: Date.now() + opts.ttlMs, workspaceId: opts.workspaceId, versioned: opts.versioned });
    this.bytes += bytes;
    while (this.bytes > this.cfg.cache.max_bytes && this.entries.size > 1) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined || oldest === key) break;
      this.drop(oldest);
    }
    metrics.cacheBytes.set(this.bytes);
    metrics.cacheEntries.set(this.entries.size);
    return true;
  }

  private drop(key: string) {
    const e = this.entries.get(key);
    if (!e) return;
    this.entries.delete(key);
    this.bytes -= e.bytes;
  }

  /** Called when a workspace's data epoch moves: versioned entries are unreachable now, so free them. */
  invalidateWorkspace(workspaceId: string, opts: { all?: boolean } = {}): number {
    let n = 0;
    for (const [k, e] of this.entries) {
      if (e.workspaceId === workspaceId && (opts.all || e.versioned)) {
        this.drop(k);
        n++;
      }
    }
    metrics.cacheBytes.set(this.bytes);
    metrics.cacheEntries.set(this.entries.size);
    return n;
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
    metrics.cacheBytes.set(0);
    metrics.cacheEntries.set(0);
  }

  stats() {
    return { enabled: this.enabled, entries: this.entries.size, bytes: this.bytes, max_bytes: this.cfg.cache.max_bytes, hits: this.hits, misses: this.misses };
  }

  // ---------- the one helper every cached operation goes through ----------

  /**
   * Serves `kind(text)` from cache when possible, otherwise runs `compute` and stores the result.
   *   - `ifNoneMatch` equal to the current key short-circuits to `not_modified` (HTTP 304) without touching DuckDB;
   *   - `refresh` bypasses the lookup but still stores the fresh result;
   *   - when the compute itself moved the epoch (a :memory: engine started), the result is stored under the new key.
   */
  async through<T>(p: Principal, workspaceId: string, kind: CacheKind, text: string, options: unknown, opts: { ifNoneMatch?: string | null; refresh?: boolean }, compute: () => Promise<T>): Promise<CacheOutcome<T>> {
    let plan = await this.plan(p, workspaceId, kind, text, options);
    // An explicit refresh outranks a matching ETag: the caller wants a recomputation, not a 304.
    if (plan.key && opts.ifNoneMatch && !opts.refresh && opts.ifNoneMatch.replace(/^W\//, '').replace(/"/g, '') === plan.key) {
      metrics.cacheLookups.inc({ kind, result: 'not_modified' });
      this.hits++;
      return { status: 'not_modified', etag: plan.key };
    }
    if (plan.key && !opts.refresh) {
      const hit = this.get<T>(plan.key);
      if (hit) {
        this.hits++;
        metrics.cacheLookups.inc({ kind, result: 'hit' });
        return { status: 'hit', etag: plan.key, value: hit.value, cached: true, computed_at: hit.computedAt };
      }
      this.misses++;
      metrics.cacheLookups.inc({ kind, result: 'miss' });
    } else if (plan.key) metrics.cacheLookups.inc({ kind, result: 'bypass' });
    const value = await compute();
    const computed_at = new Date().toISOString();
    if (plan.key) {
      if (plan.versioned) {
        const now = await this.workspaces.versionOf(workspaceId);
        if (now !== plan.workspace.data_version) {
          plan = await this.plan(p, workspaceId, kind, text, options);
          logger().debug({ workspaceId, kind }, 'Data epoch moved during compute; storing under the new key');
        }
      }
      if (plan.key) this.set(plan.key, value, { ttlMs: plan.ttlMs, workspaceId, versioned: plan.versioned });
    }
    return { status: opts.refresh ? 'bypass' : 'miss', etag: plan.key, value, cached: false, computed_at };
  }
}
