/**
 * ToolStep — one tool call of an agent or a task: what it did, in words, whether it read or changed data, how long
 * it took, and what came back; the tool's name and arguments behind a disclosure.
 */
import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { Badge, StatusDot, cn } from '../ui';
import { describeTool } from './describe';

export type StepStatus = 'running' | 'ok' | 'error' | 'approval_required';

export interface ToolStepData {
  tool: string;
  title?: string | null;
  args?: Record<string, unknown>;
  status: StepStatus;
  summary?: string | null;
  durationMs?: number | null;
  effect?: 'read' | 'write' | null;
}

const TONE: Record<StepStatus, 'busy' | 'ok' | 'error' | 'warn'> = { running: 'busy', ok: 'ok', error: 'error', approval_required: 'warn' };
const WORD: Record<StepStatus, string> = { running: 'running', ok: 'done', error: 'failed', approval_required: 'needs approval' };

export function ToolStep({ step, className }: { step: ToolStepData; className?: string }) {
  const [open, setOpen] = useState(false);
  const sentence = describeTool(step.tool, step.args ?? {}, step.title);
  return (
    <li className={cn('min-w-0', className)} data-tool={step.tool} data-status={step.status}>
      <button className="group flex w-full min-w-0 items-center gap-2 py-0.5 text-left" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <ChevronRight className={cn('h-3 w-3 shrink-0 text-zinc-600 transition-transform duration-[var(--dur-fast)]', open && 'rotate-90')} />
        <StatusDot tone={TONE[step.status]} pulse={step.status === 'running'} className="shrink-0"><span className="sr-only">{WORD[step.status]}</span></StatusDot>
        <span className={cn('min-w-0 flex-1 truncate text-xs', step.status === 'error' ? 'text-red-300' : 'text-zinc-200')} data-testid="tool-sentence">{sentence}</span>
        {step.effect === 'write' && <Badge tone="warn">changes data</Badge>}
        {step.status === 'approval_required' && <Badge tone="warn">needs approval</Badge>}
        {step.durationMs != null && <span className="shrink-0 text-2xs tabular-nums text-zinc-600">{step.durationMs < 1000 ? `${Math.round(step.durationMs)} ms` : `${(step.durationMs / 1000).toFixed(1)} s`}</span>}
      </button>
      {!open && step.summary && <div className="truncate pl-[2.1rem] text-2xs text-zinc-500">{step.summary}</div>}
      {open && (
        <div className="ml-[2.1rem] mt-1 space-y-1 rounded-md border border-zinc-800 bg-zinc-900/60 p-2 font-mono text-2xs text-zinc-400">
          <div><span className="text-zinc-600">tool</span> {step.tool}</div>
          {step.args && Object.keys(step.args).length > 0 && <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words text-zinc-300">{JSON.stringify(step.args, null, 2)}</pre>}
          {step.summary && <div className="whitespace-pre-wrap break-words text-zinc-300">{step.summary}</div>}
        </div>
      )}
    </li>
  );
}
