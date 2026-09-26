/**
 * ContextChip — one thing the AI will look at (the page on screen, a dataset, a metric), with a way to leave it out.
 * Shared by the Copilot drawer and the agent dock.
 */
import { X } from 'lucide-react';

/** One thing the AI will look at, with a way to leave it out. */
export function ContextChip({ label, kind, onRemove, testid }: { label: string; kind: string; onRemove: () => void; testid?: string }) {
  return (
    <span className="inline-flex max-w-[16rem] items-center gap-1 rounded bg-zinc-900 py-0.5 pl-1.5 pr-0.5 text-2xs text-zinc-300" title={`${kind}: ${label}`} data-testid={testid}>
      <span className="text-zinc-500">{kind}</span>
      <span className="truncate font-mono">{label}</span>
      <button aria-label={`Leave ${label} out`} className="rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200" onClick={onRemove}><X className="h-3 w-3" /></button>
    </span>
  );
}
