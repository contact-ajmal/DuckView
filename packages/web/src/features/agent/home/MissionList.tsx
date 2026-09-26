/**
 * Missions as a list: active ones with their progress and what they are doing, recent ones with what they made.
 * A row opens the mission's workspace (#/agent/missions/<id>).
 */
import { timeAgo } from '../../../api/client';
import { StatusDot, cn } from '../../../components/ui';
import type { MissionStatus, MissionSummary } from '../api';

export const MISSION_STATUS: Record<MissionStatus, [tone: 'busy' | 'idle' | 'warn' | 'ok' | 'error', word: string]> = {
  new: ['idle', 'Not started'],
  planning: ['busy', 'Planning'],
  running: ['busy', 'Working'],
  waiting_approval: ['warn', 'Needs approval'],
  completed: ['ok', 'Done'],
  failed: ['error', 'Failed'],
  cancelled: ['idle', 'Cancelled'],
};

const KIND: Record<string, string> = { table: 'result', dashboard: 'dashboard', notebook: 'notebook', app: 'app', quality_suite: 'checks', dbt_model: 'model', metric: 'metrics', saved_query: 'query', chart: 'chart', dataset: 'dataset', file: 'file' };

/** The mission's progress, as a thin bar with its value for assistive tech. */
export function ProgressBar({ value, status, className }: { value: number; status: MissionStatus; className?: string }) {
  return (
    <div className={cn('h-1 w-full overflow-hidden rounded-full bg-zinc-800', className)} role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={100} aria-label="Progress">
      <div className={cn('h-full rounded-full transition-[width] duration-200', status === 'waiting_approval' ? 'bg-amber-500' : status === 'failed' ? 'bg-red-500' : status === 'completed' ? 'bg-emerald-500' : 'bg-zinc-300')} style={{ width: `${value}%` }} />
    </div>
  );
}

export function MissionList({ title, missions, empty, testid }: { title: string; missions: MissionSummary[]; empty: string; testid: string }) {
  return (
    <section aria-label={title} data-testid={testid}>
      <h2 className="mb-2 text-body font-semibold text-zinc-100">{title}</h2>
      {missions.length === 0 ? (
        <p className="text-xs text-zinc-500">{empty}</p>
      ) : (
        <ul className="-mx-2 space-y-0.5">
          {missions.slice(0, 8).map((m) => {
            const [tone, word] = MISSION_STATUS[m.status];
            const running = m.status === 'running' || m.status === 'planning' || m.status === 'waiting_approval';
            const made = m.artifacts.kinds.filter((k) => k !== 'dataset').map((k) => KIND[k] ?? k);
            return (
              <li key={m.id}>
                <a href={`#/agent/missions/${m.id}`} className="block rounded-md px-2 py-2 hover:bg-zinc-900 focus-visible:bg-zinc-900 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-500" data-testid="agent-mission-row" data-status={m.status}>
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-xs font-medium text-zinc-100">{m.title}</span>
                    {!m.owner.mine && <span className="shrink-0 text-2xs text-zinc-500">shared</span>}
                    {running ? <StatusDot tone={tone} pulse={tone === 'busy'} className="shrink-0">{word}</StatusDot> : <span className="shrink-0 text-2xs text-zinc-500">{timeAgo(m.updated_at)}</span>}
                  </div>
                  {running && <ProgressBar value={m.progress} status={m.status} className="mt-1.5" />}
                  <div className="mt-1 truncate text-2xs text-zinc-500">
                    {running ? m.activity : [m.status !== 'completed' ? word : null, made.length ? made.join(', ') : null, m.datasets.length ? `${m.datasets.length} dataset${m.datasets.length === 1 ? '' : 's'}` : null].filter(Boolean).join(' · ') || m.activity}
                  </div>
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
