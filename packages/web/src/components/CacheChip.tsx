import { RefreshCw, Zap, Database } from 'lucide-react';
import { timeAgo } from '../api/client';
import { cn } from './ui';
import type { CachedState } from '../lib/useCached';

/**
 * Provenance of a cacheable result: where the numbers on screen came from and how old they are, with a one-click
 * recompute. Quiet by design — a small mono chip, not a banner.
 */
export function CacheChip({ state, computedAt, fromCache, serverCached, onRefresh, verb = 'computed', className }: { state: CachedState; computedAt: string | null; fromCache: boolean; serverCached: boolean; onRefresh?: () => void; verb?: string; className?: string }) {
  if (state === 'idle' || state === 'loading' || state === 'restoring' || (!computedAt && state !== 'error')) return null;
  const busy = state === 'revalidating';
  const label = state === 'stale' ? `offline · ${verb} ${timeAgo(computedAt!)}` : fromCache ? `cached · ${verb} ${timeAgo(computedAt!)}` : serverCached ? `${verb} ${timeAgo(computedAt!)} · shared cache` : `${verb} ${timeAgo(computedAt!)}`;
  const title = state === 'stale' ? 'Could not reach the server; showing the last cached copy.' : fromCache ? 'Restored from this browser; checking with the server…' : serverCached ? 'Served from the server cache — computed once for everyone with access to this workspace.' : 'Computed just now.';
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-[11px]', state === 'stale' ? 'text-amber-500' : 'text-zinc-500', className)} title={title}>
      {fromCache || serverCached ? <Zap className="h-3 w-3" /> : <Database className="h-3 w-3" />}
      {label}
      {onRefresh && (
        <button onClick={onRefresh} disabled={busy} className={cn('ml-0.5 rounded p-0.5 hover:text-zinc-100 disabled:opacity-60', busy && 'animate-spin')} title="Recompute now (bypasses every cache)">
          <RefreshCw className="h-3 w-3" />
        </button>
      )}
    </span>
  );
}
