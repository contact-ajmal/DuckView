/**
 * ChartFrame — the frame every chart, KPI and table widget sits in: a title (and metadata), actions that appear on
 * hover or keyboard focus, and one treatment for loading, failure and "nothing to show".
 */
import type { ReactNode } from 'react';
import { InlineError, Skeleton, cn } from '../ui';

export type ChartShape = 'kpi' | 'chart' | 'table' | 'text';

/** A placeholder in the shape of the chart that is loading. */
export function ChartSkeleton({ shape }: { shape: ChartShape }) {
  if (shape === 'kpi') return <div className="flex h-full flex-col justify-center gap-2 px-4" aria-busy="true"><Skeleton className="h-7 w-32" /><Skeleton className="h-3 w-20" /></div>;
  if (shape === 'table') return <div className="p-3" aria-busy="true"><Skeleton lines={6} /></div>;
  if (shape === 'text') return <div className="p-3" aria-busy="true"><Skeleton lines={3} /></div>;
  return (
    <div className="flex h-full items-end gap-1.5 px-4 pb-4 pt-2" aria-busy="true">
      {[40, 65, 50, 80, 58, 72, 45, 88].map((h, i) => <div key={i} className="shimmer flex-1 rounded-t-sm" style={{ height: `${h}%` }} />)}
    </div>
  );
}

export function ChartFrame({ title, meta, actions, leading, children, shape = 'chart', loading, error, onRetry, empty, className, bodyClassName, testid, actionsVisible }: { actionsVisible?: boolean; title?: ReactNode; meta?: ReactNode; actions?: ReactNode; leading?: ReactNode; children?: ReactNode; shape?: ChartShape; loading?: boolean; error?: unknown; onRetry?: () => void; empty?: ReactNode; className?: string; bodyClassName?: string; testid?: string }) {
  return (
    <section className={cn('group/frame flex min-h-0 flex-col', className)} data-testid={testid} aria-label={typeof title === 'string' ? title : undefined}>
      {(title || actions || leading) && (
        <header className="flex h-8 shrink-0 items-center gap-1.5 px-3">
          {leading}
          {title && <h3 className="truncate text-xs font-semibold text-zinc-200">{title}</h3>}
          {meta && <span className="shrink-0 text-2xs text-zinc-500">{meta}</span>}
          {actions && <div className={cn('ml-auto flex items-center gap-0.5 transition-opacity duration-[var(--dur-fast)]', !actionsVisible && 'opacity-0 focus-within:opacity-100 group-hover/frame:opacity-100')}>{actions}</div>}
        </header>
      )}
      <div className={cn('relative min-h-0 flex-1', bodyClassName)}>
        {error ? <div className="p-3"><InlineError error={error} onRetry={onRetry} /></div> : loading ? <ChartSkeleton shape={shape} /> : empty ?? children}
      </div>
    </section>
  );
}
