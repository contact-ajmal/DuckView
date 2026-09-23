import { useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { api, type QualitySuite } from '../../api/client';
import { subscribeLiveEvents } from '../../lib/liveEvents';
import { cn } from '../../components/ui';

/** "trips", "main.trips", "\"main\".\"trips\"" → main.trips */
const norm = (r: string) => {
  const parts = r.split('.').map((p) => p.trim().replace(/^"|"$/g, '').replace(/""/g, '"').toLowerCase());
  return (parts.length === 1 ? ['main', ...parts] : parts.slice(-2)).join('.');
};
const TEXT = { unknown: 'Checks not run', pass: 'Checks passing', warn: 'Checks warning', fail: 'Checks failing', error: 'Checks could not run' } as const;

/** The quality status of a table, linking to its checks (nothing when the table has none). */
export function QualityChip({ workspaceId, relation }: { workspaceId: string; relation: string }) {
  const [suites, setSuites] = useState<QualitySuite[]>([]);
  useEffect(() => {
    const load = () => void api.get<{ suites: QualitySuite[] }>(`/api/workspaces/${workspaceId}/quality/suites`).then((r) => setSuites(r.suites)).catch(() => undefined);
    load();
    return subscribeLiveEvents((e) => e.type === 'quality' && e.workspace_id === workspaceId && load());
  }, [workspaceId]);
  const mine = suites.filter((s) => norm(s.relation) === norm(relation));
  if (!mine.length) return null;
  const rank = { unknown: 0, pass: 1, warn: 2, error: 3, fail: 4 } as const;
  const top = mine.reduce((a, b) => (rank[b.status] > rank[a.status] ? b : a));
  return (
    <a href={`#/transform/quality?suite=${top.id}`} data-testid="quality-chip" title={top.last_run?.summary ?? top.name} className={cn('inline-flex h-[26px] items-center gap-1.5 rounded-md px-2 text-xs hover:bg-zinc-900', top.status === 'pass' ? 'text-emerald-400' : top.status === 'warn' ? 'text-amber-400' : top.status === 'unknown' ? 'text-zinc-400' : 'text-red-400')}>
      <ShieldCheck className="h-3.5 w-3.5" /> {TEXT[top.status]}
    </a>
  );
}
