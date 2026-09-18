import { useCallback, useEffect, useRef, useState } from 'react';
import { postConditional, type CacheMeta } from '../api/client';
import { resultCache, cacheId, type CacheKind } from './resultCache';
import { useAuth } from '../store/auth';

/**
 * Stale-while-revalidate for one cacheable server call.
 *
 *   restoring   → reading IndexedDB (nothing to show yet)
 *   revalidating→ a cached copy is on screen, the server is being asked whether it is still current
 *   fresh       → the server confirmed (304) or replaced (200) the data
 *   stale       → the revalidation failed; the cached copy stays on screen with the error attached
 *   loading     → no cached copy, waiting for the server
 *   error       → nothing to show
 */
export type CachedState = 'idle' | 'restoring' | 'loading' | 'revalidating' | 'fresh' | 'stale' | 'error';

export interface CachedResult<T> {
  data: (T & Partial<CacheMeta>) | null;
  state: CachedState;
  /** When the data on screen was computed (server time), whatever its provenance. */
  computedAt: string | null;
  /** True while the data shown came from this browser's cache and has not yet been confirmed. */
  fromCache: boolean;
  /** True when the server itself answered from its cache (shared with other members). */
  serverCached: boolean;
  error: string | null;
  refresh(): void;
}

export interface CachedSpec {
  workspaceId: string | null | undefined;
  kind: CacheKind;
  /** Identifies the entry inside the workspace (target path, SQL, widget id…). */
  target: string | null | undefined;
  url: string;
  body: Record<string, unknown>;
  /** Server data epoch — a change triggers revalidation. */
  version?: number;
  enabled?: boolean;
}

interface Fetched<T> {
  data: T & CacheMeta;
  etag: string | null;
  computedAt: string;
}

/**
 * Last known value per entry for this page session. A component that remounts (navigating to another tab and
 * back) starts from here synchronously — no spinner, no IndexedDB round-trip — and only revalidates quietly.
 */
const memo = new Map<string, { payload: unknown; etag: string | null; computedAt: string; serverCached: boolean; confirmed: boolean }>();

/** One revalidation round: read IDB, then ask the server conditionally. Shared by the hook and the imperative helper. */
async function revalidate<T>(spec: CachedSpec, userId: string, opts: { refresh?: boolean; signal?: AbortSignal }, onRestored: (data: T & Partial<CacheMeta>, computedAt: string) => void): Promise<{ result: 'fresh' | 'not_modified'; data: (T & Partial<CacheMeta>) | null; computedAt: string; serverCached: boolean }> {
  const id = cacheId(userId, spec.workspaceId!, spec.kind, spec.target!);
  const m = opts.refresh ? undefined : memo.get(id);
  // Synchronous (before any await): a remount gets its previous value in the same tick.
  if (m) onRestored(m.payload as T & Partial<CacheMeta>, m.computedAt);
  const cached = m ? { payload: m.payload as T & Partial<CacheMeta>, etag: m.etag, computed_at: m.computedAt } : opts.refresh ? undefined : await resultCache.get<T & Partial<CacheMeta>>(id);
  if (!m && cached && !opts.signal?.aborted) onRestored(cached.payload, cached.computed_at);
  const r = await postConditional<T>(spec.url, spec.body, { etag: cached?.etag ?? null, refresh: opts.refresh, signal: opts.signal });
  if (r.status === 304) {
    // Confirmed current — keep what we showed; bump its LRU timestamp.
    if (cached) memo.set(id, { payload: cached.payload, etag: cached.etag, computedAt: cached.computed_at, serverCached: m?.serverCached ?? false, confirmed: true });
    return { result: 'not_modified', data: cached?.payload ?? null, computedAt: cached?.computed_at ?? new Date().toISOString(), serverCached: false };
  }
  const f: Fetched<T> = { data: r.data, etag: r.etag ?? r.data.etag ?? null, computedAt: r.data.computed_at ?? new Date().toISOString() };
  memo.set(id, { payload: f.data, etag: f.etag, computedAt: f.computedAt, serverCached: !!f.data.cached, confirmed: true });
  if (f.etag) void resultCache.set({ id, user_id: userId, workspace_id: spec.workspaceId!, kind: spec.kind, etag: f.etag, computed_at: f.computedAt, payload: f.data });
  return { result: 'fresh', data: f.data, computedAt: f.computedAt, serverCached: !!f.data.cached };
}

export function useCached<T>(spec: CachedSpec): CachedResult<T> {
  const userId = useAuth((s) => s.user?.id ?? null);
  const initial = userId && spec.workspaceId && spec.target ? memo.get(cacheId(userId, spec.workspaceId, spec.kind, spec.target)) : undefined;
  const [data, setData] = useState<(T & Partial<CacheMeta>) | null>((initial?.payload as T & Partial<CacheMeta>) ?? null);
  const [state, setState] = useState<CachedState>(initial ? 'revalidating' : 'idle');
  const [computedAt, setComputedAt] = useState<string | null>(initial?.computedAt ?? null);
  const [fromCache, setFromCache] = useState(!!initial && !initial.confirmed);
  const [serverCached, setServerCached] = useState(initial?.serverCached ?? false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const refreshRef = useRef(false);
  const enabled = spec.enabled !== false && !!spec.workspaceId && !!spec.target && !!userId;
  const bodyKey = JSON.stringify(spec.body);

  useEffect(() => {
    if (!enabled) {
      setData(null);
      setState('idle');
      setComputedAt(null);
      setFromCache(false);
      setServerCached(false);
      setError(null);
      return;
    }
    const ac = new AbortController();
    const refresh = refreshRef.current;
    refreshRef.current = false;
    let restored = false;
    setError(null);
    setState(refresh ? 'loading' : 'restoring');
    if (refresh) {
      setFromCache(false);
    }
    revalidate<T>(
      spec,
      userId!,
      { refresh, signal: ac.signal },
      (payload, at) => {
        restored = true;
        setData(payload);
        setComputedAt(at);
        // Restored from IndexedDB → "cached" until the server confirms; from this session's memo → already confirmed.
        const known = userId && spec.workspaceId && spec.target ? memo.get(cacheId(userId, spec.workspaceId, spec.kind, spec.target)) : undefined;
        setFromCache(!(known && known.confirmed));
        setServerCached(known?.serverCached ?? false);
        setState('revalidating');
      },
    )
      .then((r) => {
        if (ac.signal.aborted) return;
        if (r.result === 'fresh') {
          setData(r.data);
          setServerCached(r.serverCached);
        }
        setComputedAt(r.computedAt);
        setFromCache(false);
        setState('fresh');
      })
      .catch((e) => {
        if (ac.signal.aborted) return;
        setError((e as Error).message);
        setState(restored ? 'stale' : 'error');
      });
    // Not restored from IDB within the first tick → we are waiting on the server with an empty screen.
    queueMicrotask(() => {
      if (!ac.signal.aborted && !restored) setState((s) => (s === 'restoring' ? 'loading' : s));
    });
    return () => ac.abort();
  }, [enabled, userId, spec.workspaceId, spec.kind, spec.target, spec.url, bodyKey, spec.version, nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = useCallback(() => {
    refreshRef.current = true;
    setNonce((n) => n + 1);
  }, []);

  return { data, state, computedAt, fromCache, serverCached, error, refresh };
}

/**
 * Imperative counterpart for flows that are not a render (a "Profile" button, a plan request): calls `onData` with
 * the cached copy first (if any), then again with the server's answer when it differs. Resolves when the server
 * has spoken.
 */
export async function fetchCached<T>(spec: CachedSpec & { userId: string }, onData: (data: T & Partial<CacheMeta>, meta: { fromCache: boolean; computedAt: string; serverCached: boolean }) => void, opts: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<void> {
  const r = await revalidate<T>(spec, spec.userId, opts, (payload, at) => onData(payload, { fromCache: true, computedAt: at, serverCached: false }));
  if (r.result === 'fresh' && r.data) onData(r.data, { fromCache: false, computedAt: r.computedAt, serverCached: r.serverCached });
  else if (r.result === 'not_modified' && r.data) onData(r.data, { fromCache: false, computedAt: r.computedAt, serverCached: false });
}

/** Forgets this page session's in-memory copies (called alongside a browser-cache wipe). */
export function clearCachedMemo() {
  memo.clear();
}
