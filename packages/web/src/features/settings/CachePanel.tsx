import { useEffect, useState } from 'react';
import { Zap, Trash2 } from 'lucide-react';
import { api, formatBytes, type LiveStats } from '../../api/client';
import { Button, Card } from '../../components/ui';
import { resultCache, BUDGET_BYTES } from '../../lib/resultCache';
import { useAuth } from '../../store/auth';
import { useWorkspace } from '../../store/workspace';

/**
 * Result caches: the server's shared LRU (every member benefits) and this browser's IndexedDB copy (instant paint).
 * Clearing the workspace cache also moves its data epoch so every browser drops its copies, not just this one.
 */
export function CachePanel({ live }: { live: LiveStats | null }) {
  const auth = useAuth();
  const ws = useWorkspace();
  const [local, setLocal] = useState<{ entries: number; bytes: number } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const refreshLocal = () => resultCache.stats().then(setLocal).catch(() => setLocal(null));
  useEffect(() => {
    void refreshLocal();
  }, [live?.at]);
  const server = live?.cache;
  const hitRate = server && server.hits + server.misses > 0 ? Math.round((server.hits / (server.hits + server.misses)) * 100) : null;
  const active = ws.workspaces.find((w) => w.id === ws.activeId);
  return (
    <Card title="Result cache" actions={<span className="text-[11px] text-zinc-500">profiles · schemas · plans · widgets · read-only SQL</span>}>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-lg border border-zinc-800 bg-zinc-950/50 p-3">
          <div className="flex items-center gap-2 text-xs font-medium text-zinc-200">
            <Zap className="h-3.5 w-3.5 text-accent-300" /> Server (shared)
          </div>
          <div className="mt-2 grid grid-cols-3 gap-2 text-center">
            <Stat label="entries" value={server ? server.entries.toLocaleString() : '—'} />
            <Stat label="in memory" value={server ? `${formatBytes(server.bytes)} / ${formatBytes(server.max_bytes)}` : '—'} />
            <Stat label="hit rate" value={hitRate == null ? '—' : `${hitRate}%`} sub={server ? `${server.hits.toLocaleString()} hits · ${server.misses.toLocaleString()} misses` : undefined} />
          </div>
          <p className="mt-2 text-[11px] text-zinc-500">
            Keys embed each file's size and modification time plus the workspace data epoch, so a hit is exact: any mutation, upload or folder change invalidates. Remote and lakehouse sources use a short TTL instead.
            {server && !server.enabled && <span className="text-amber-300"> Disabled by configuration (cache.enabled).</span>}
          </p>
        </div>
        <div className="rounded-lg border border-zinc-800 bg-zinc-950/50 p-3">
          <div className="text-xs font-medium text-zinc-200">This browser</div>
          <div className="mt-2 grid grid-cols-2 gap-2 text-center">
            <Stat label="entries" value={local ? local.entries.toLocaleString() : '—'} />
            <Stat label="stored" value={local ? `${formatBytes(local.bytes)} / ${formatBytes(BUDGET_BYTES)}` : '—'} />
          </div>
          <p className="mt-2 text-[11px] text-zinc-500">Restored instantly on the next visit, then confirmed with the server (a 304 costs no DuckDB work). Wiped on sign-out.</p>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {active && (
          <Button
            size="sm"
            onClick={async () => {
              try {
                const r = await api.del<{ dropped: number }>(`/api/workspaces/${active.id}/cache`);
                await resultCache.clearWorkspace(active.id);
                await ws.loadWorkspaces();
                await refreshLocal();
                setMsg(`Cleared “${active.name}”: ${r.dropped} server entr${r.dropped === 1 ? 'y' : 'ies'} dropped; every member's browser will recompute.`);
              } catch (e) {
                setMsg((e as Error).message);
              }
            }}
          >
            <Trash2 className="h-3.5 w-3.5" /> Clear cache for “{active.name}”
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          onClick={async () => {
            await resultCache.clearAll();
            await refreshLocal();
            setMsg('Cleared this browser’s cache.');
          }}
        >
          Clear browser cache
        </Button>
        {auth.user?.role === 'ADMIN' && (
          <Button
            size="sm"
            variant="ghost"
            onClick={async () => {
              const r = await api.post<{ dropped: number; bytes: number }>('/api/admin/cache/clear');
              setMsg(`Server cache cleared: ${r.dropped} entries (${formatBytes(r.bytes)}).`);
            }}
          >
            Clear server cache (all workspaces)
          </Button>
        )}
        {msg && <span className="text-[11px] text-zinc-400">{msg}</span>}
      </div>
    </Card>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <div className="font-mono text-sm text-zinc-100">{value}</div>
      <div className="text-[10px] text-zinc-500">{label}</div>
      {sub && <div className="text-[10px] text-zinc-600">{sub}</div>}
    </div>
  );
}
