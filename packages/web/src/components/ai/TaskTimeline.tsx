/**
 * TaskTimeline — a task as it runs: the goal, each tool call in order (ToolStep), and where it stands. The same
 * view shows a DuckView agent's run, a scheduled task and an orchestrated one.
 */
import type { ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { StatusDot } from '../ui';
import { ToolStep, type ToolStepData } from './ToolStep';

export type TaskState = 'planning' | 'running' | 'waiting' | 'approval' | 'done' | 'failed' | 'cancelled';

const STATE: Record<TaskState, { word: string; tone: 'busy' | 'idle' | 'warn' | 'ok' | 'error' }> = {
  planning: { word: 'Planning', tone: 'busy' },
  running: { word: 'Running', tone: 'busy' },
  waiting: { word: 'Waiting for data', tone: 'idle' },
  approval: { word: 'Needs approval', tone: 'warn' },
  done: { word: 'Done', tone: 'ok' },
  failed: { word: 'Failed', tone: 'error' },
  cancelled: { word: 'Cancelled', tone: 'idle' },
};

export function TaskTimeline({ goal, steps, state, error, children, testid }: { goal?: ReactNode; steps: ToolStepData[]; state: TaskState; error?: string | null; children?: ReactNode; testid?: string }) {
  const s = STATE[state];
  return (
    <section className="min-w-0 space-y-2" data-testid={testid} data-state={state}>
      <div className="flex min-w-0 items-center gap-2">
        {goal && <div className="min-w-0 flex-1 truncate text-xs text-zinc-300">{goal}</div>}
        <StatusDot tone={s.tone} pulse={s.tone === 'busy'} className="shrink-0">{s.word}{steps.length ? ` · ${steps.length} step${steps.length === 1 ? '' : 's'}` : ''}</StatusDot>
      </div>
      {steps.length > 0 && (
        <ol className="space-y-0.5 border-l border-zinc-800 pl-2" aria-label="Steps">
          {steps.map((st, i) => <ToolStep key={i} step={st} />)}
          {(state === 'running' || state === 'planning') && (
            <li className="flex items-center gap-2 py-0.5 pl-5 text-xs text-zinc-500"><Loader2 className="h-3 w-3 animate-spin" /> {state === 'planning' ? 'Deciding what to do…' : 'Working…'}</li>
          )}
        </ol>
      )}
      {state === 'failed' && error && <p className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-200">{error}</p>}
      {children}
    </section>
  );
}
