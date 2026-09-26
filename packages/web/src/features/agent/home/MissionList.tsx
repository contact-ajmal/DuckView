/**
 * Missions on the Agent Home. Active ones carry weight — a raised row with the status, the progress and what the
 * agent is doing now. Recent ones are a compact list (title, what they made, when) with Duplicate and Archive on
 * hover or focus (always visible on touch). A row opens the mission's workspace (#/agent/missions/<id>).
 */
import { useState } from 'react';
import { Archive, Copy } from 'lucide-react';
import { timeAgo } from '../../../api/client';
import { IconButton, ProgressBar as Bar, StatusDot, cn, toast } from '../../../components/ui';
import { missionApi, type MissionStatus, type MissionSummary } from '../api';

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

/** A mission's progress; the bar's tone follows its state. */
export function ProgressBar({ value, status, className }: { value: number; status: MissionStatus; className?: string }) {
  return <Bar value={value} className={className} tone={status === 'waiting_approval' ? 'warn' : status === 'failed' ? 'error' : status === 'completed' ? 'ok' : 'busy'} />;
}

export function ActiveMissions({ missions }: { missions: MissionSummary[] }) {
  return (
    <section aria-label="Active missions" data-testid="agent-active">
      <h2 className="mb-2 flex items-baseline gap-2 text-body font-medium text-fg">Running now <span className="text-2xs tabular-nums text-fg-muted">{missions.length}</span></h2>
      <ul className="space-y-1.5">
        {missions.slice(0, 6).map((m) => {
          const [tone, word] = MISSION_STATUS[m.status];
          return (
            <li key={m.id}>
              <a href={`#/agent/missions/${m.id}`} className="block rounded-lg border border-line bg-raised px-3.5 py-3 transition-colors duration-[var(--dur-fast)] hover:border-line-strong" data-testid="agent-mission-row" data-status={m.status}>
                <div className="flex items-center gap-3">
                  <span className="min-w-0 flex-1 truncate text-body font-medium text-fg-strong">{m.title}</span>
                  {!m.owner.mine && <span className="shrink-0 text-2xs text-fg-muted">shared</span>}
                  <StatusDot tone={tone} pulse={tone === 'busy'} className="shrink-0">{word}</StatusDot>
                </div>
                <ProgressBar value={m.progress} status={m.status} className="mt-2.5" />
                <div className="mt-1.5 truncate text-xs text-fg-secondary">{m.activity ?? 'Starting…'}</div>
              </a>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function RecentMissions({ missions, onChanged }: { missions: MissionSummary[]; onChanged: () => void }) {
  const [pending, setPending] = useState<string | null>(null);
  const act = async (id: string, fn: () => Promise<unknown>, done: string) => {
    setPending(id);
    try {
      await fn();
      toast.success(done);
      onChanged();
    } catch (e) {
      toast.error(e);
    } finally {
      setPending(null);
    }
  };
  return (
    <section aria-label="Recent work" data-testid="agent-recent">
      <h2 className="mb-1 text-body font-medium text-fg">Recent</h2>
      {missions.length === 0 ? (
        <p className="py-2 text-xs text-fg-muted">Finished missions appear here, with what they made.</p>
      ) : (
        <ul className="-mx-2">
          {missions.slice(0, 10).map((m) => {
            const [tone, word] = MISSION_STATUS[m.status];
            const made = m.artifacts.kinds.filter((k) => k !== 'dataset').map((k) => KIND[k] ?? k);
            const meta = [m.status !== 'completed' ? word : null, made.length ? made.join(', ') : null].filter(Boolean).join(' · ');
            return (
              <li key={m.id} className="group relative flex items-center rounded-md transition-colors duration-[var(--dur-fast)] hover:bg-hover focus-within:bg-hover">
                <a href={`#/agent/missions/${m.id}`} className="flex min-w-0 flex-1 items-center gap-2.5 px-2 py-1.5" data-testid="agent-mission-row" data-status={m.status}>
                  <StatusDot tone={tone} className="shrink-0" />
                  <span className="min-w-0 flex-1 truncate text-body text-fg">{m.title}</span>
                  {meta && <span className="hidden max-w-[40%] shrink-0 truncate text-2xs text-fg-muted sm:inline">{meta}</span>}
                  {!m.owner.mine && <span className="shrink-0 text-2xs text-fg-muted">shared</span>}
                  <span className="w-14 shrink-0 text-right text-2xs tabular-nums text-fg-muted group-hover:invisible group-focus-within:invisible max-sm:hidden">{timeAgo(m.updated_at)}</span>
                </a>
                {/* Hover or keyboard focus reveals the row's actions; touch screens always show them. */}
                <span className={cn('flex shrink-0 items-center pr-1 sm:absolute sm:right-1 sm:opacity-0 sm:transition-opacity sm:duration-[var(--dur-fast)] sm:group-hover:opacity-100 sm:group-focus-within:opacity-100', pending === m.id && 'sm:opacity-100')}>
                  <IconButton label={`Duplicate "${m.title}"`} disabled={pending === m.id} onClick={() => void act(m.id, () => missionApi.duplicate(m.id), 'Duplicated')} data-testid="mission-row-duplicate"><Copy className="h-3.5 w-3.5" /></IconButton>
                  {m.owner.mine && <IconButton label={`Archive "${m.title}"`} disabled={pending === m.id} onClick={() => void act(m.id, () => missionApi.update(m.id, { archived: true }), 'Archived')} data-testid="mission-row-archive"><Archive className="h-3.5 w-3.5" /></IconButton>}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
