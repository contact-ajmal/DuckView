/**
 * One agent task in the dock: what was asked; the plan and each step in words (tools, workspace moves, approvals),
 * expandable to their safe details; then the answer, what needs the person's approval, and what was made.
 * The model's hidden reasoning is never shown — only decisions, calls, observations and results.
 */
import { useState } from 'react';
import { CheckCircle2, Circle, CircleDot, CornerDownRight } from 'lucide-react';
import { ApprovalCard, Markdown, ToolStep, type ToolStepData } from '../../components/ai';
import { StatusDot, cn } from '../../components/ui';
import type { StepRecord, TaskStatus } from './api';
import { AgentArtifacts } from './AgentArtifacts';
import { performAction, useAgent, type TaskView } from './store';

const STATUS: Record<TaskStatus, [tone: 'busy' | 'idle' | 'warn' | 'ok' | 'error', word: string]> = {
  planning: ['busy', 'Planning'],
  running: ['busy', 'Working'],
  waiting_approval: ['warn', 'Needs approval'],
  completed: ['ok', 'Done'],
  failed: ['error', 'Failed'],
  cancelled: ['idle', 'Cancelled'],
};

function toStep(s: StepRecord): ToolStepData | null {
  if (s.kind !== 'tool' && s.kind !== 'approval' && s.kind !== 'action') return null;
  if (!s.tool) return null;
  return { tool: s.tool, args: s.arguments, status: s.status === 'ok' ? 'ok' : s.status === 'approval_required' ? 'approval_required' : 'error', summary: s.summary, durationMs: s.duration_ms ?? null };
}

export function AgentTaskView({ task }: { task: TaskView }) {
  const agent = useAgent();
  const [deciding, setDeciding] = useState(false);
  const [tone, word] = STATUS[task.status];
  const steps = task.steps.map(toStep).filter((s): s is ToolStepData => !!s);
  if (task.live) steps.push({ tool: task.live.tool, args: task.live.arguments, status: 'running', title: task.live.title });
  const answer = task.answer ?? task.draft ?? '';
  const working = task.status === 'running' || task.status === 'planning';
  const decide = async (d: 'approve' | 'deny') => {
    setDeciding(true);
    try {
      await agent.decide(task.id, d);
    } finally {
      setDeciding(false);
    }
  };
  return (
    <article className="min-w-0 space-y-3 py-3" data-testid="agent-task" data-status={task.status}>
      <header className="flex min-w-0 items-start gap-2">
        <CornerDownRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-500" />
        <p className="min-w-0 flex-1 text-body text-zinc-100" data-testid="agent-request">{task.request}</p>
        <StatusDot tone={tone} pulse={tone === 'busy'} className="shrink-0">{word}</StatusDot>
      </header>
      <div className="grid min-w-0 gap-4 pl-5 @4xl:grid-cols-[minmax(15rem,21rem)_minmax(0,1fr)]">
        <section className="min-w-0 space-y-2" aria-label="What the agent did" data-testid="agent-activity">
          {task.plan.length > 0 && (
            <ol className="space-y-0.5" aria-label="Plan" data-testid="agent-plan">
              {task.plan.map((p, i) => (
                <li key={i} className={cn('flex items-start gap-1.5 text-xs', p.status === 'done' ? 'text-zinc-400' : p.status === 'active' ? 'text-zinc-100' : 'text-zinc-500')} data-status={p.status}>
                  {p.status === 'done' ? <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-emerald-400" /> : p.status === 'active' && working ? <CircleDot className="mt-0.5 h-3 w-3 shrink-0 text-accent-400" /> : <Circle className="mt-0.5 h-3 w-3 shrink-0" />}
                  <span className="min-w-0">{p.text}</span>
                </li>
              ))}
            </ol>
          )}
          {task.context && task.context.selected > 0 && (
            <p className="text-2xs text-zinc-500" data-testid="agent-context-used" title={task.context.objects.map((o) => `${o.type}: ${o.title}`).join('\n')}>
              Looked at {task.context.selected} of {task.context.considered} things in the workspace{task.context.metrics.length ? ` · metric ${task.context.metrics.join(', ')}` : ''}
            </p>
          )}
          {steps.length > 0 && (
            <ol className="space-y-0.5 border-l border-zinc-800 pl-2" aria-label="Steps" data-testid="agent-steps">
              {steps.map((st, i) => <ToolStep key={i} step={st} />)}
            </ol>
          )}
          {working && !task.live && <p className="text-2xs text-zinc-500">{task.status === 'planning' ? 'Deciding what to do…' : 'Thinking…'}</p>}
        </section>
        <section className="min-w-0 space-y-3" aria-label="Result">
          {task.status === 'waiting_approval' && task.approval && !task.approval.decision && (
            <ApprovalCard
              title="The agent wants to make a change"
              reason={task.approval.reason}
              statements={task.approval.preview ? [{ verb: task.approval.verb || task.approval.tool, preview: task.approval.preview, destructive: /DROP|DELETE|TRUNCATE|ALTER/.test(task.approval.verb ?? '') || task.approval.action_class === 'HIGH_RISK_WRITE' }] : []}
              requester="Asked by the agent in this task. Nothing has changed yet."
              onApprove={() => void decide('approve')}
              onDeny={() => void decide('deny')}
              approveLabel="Approve"
              busy={deciding}
            />
          )}
          {answer && (
            <div className="min-w-0 text-body text-zinc-200" data-testid="agent-answer">
              <Markdown onOpenSql={(sql) => performAction({ action: 'open_query', args: { sql, title: 'Agent query' } })}>{answer}</Markdown>
            </div>
          )}
          {task.status === 'failed' && task.error && <p className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-300" data-testid="agent-error">{task.error}</p>}
          {task.actions.length > 0 && (
            <ul className="space-y-0.5 text-2xs text-zinc-500" data-testid="agent-actions">
              {task.actions.map((a, i) => (
                <li key={i}>
                  Moved the workspace: {a.href ? <button className="text-accent-300 hover:underline" onClick={() => performAction(a)}>{String(a.args?.name ?? a.args?.label ?? a.args?.title ?? a.target ?? a.action)}</button> : a.action}
                </li>
              ))}
            </ul>
          )}
          <AgentArtifacts artifacts={task.artifacts} />
          {task.status === 'completed' && task.telemetry && (
            <p className="text-2xs tabular-nums text-zinc-500" data-testid="agent-telemetry">
              {task.telemetry.tool_calls} tool call{task.telemetry.tool_calls === 1 ? '' : 's'} · {(task.telemetry.duration_ms / 1000).toFixed(1)} s{task.telemetry.input_tokens ? ` · ${(task.telemetry.input_tokens + task.telemetry.output_tokens).toLocaleString()} tokens` : ''}{task.model ? ` · ${task.model}` : ''}
            </p>
          )}
        </section>
      </div>
    </article>
  );
}
