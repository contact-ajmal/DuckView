import type { ReactNode } from 'react';
import { cn } from './ui';

/** Small violet uppercase label above a page title (e.g. "OVERVIEW · AUTO-GENERATED ON LOAD"). */
export function Eyebrow({ children }: { children: ReactNode }) {
  return <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-accent-400">{children}</div>;
}

export function PageTitle({ children, className, title }: { children: ReactNode; className?: string; title?: string }) {
  return <h1 className={cn('text-2xl font-semibold tracking-tight text-zinc-50', className)} title={title}>{children}</h1>;
}

/** Sidebar card: uppercase header with an optional right-aligned meta slot. */
export function SideCard({ title, meta, children, className, bodyClassName }: { title: ReactNode; meta?: ReactNode; children: ReactNode; className?: string; bodyClassName?: string }) {
  return (
    <section className={cn('rounded-xl border border-zinc-800 bg-zinc-900/40', className)}>
      <header className="flex items-center justify-between border-b border-zinc-800 px-4 py-2.5">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-300">{title}</h3>
        {meta && <div className="text-[11px] text-zinc-500">{meta}</div>}
      </header>
      <div className={cn('p-3', bodyClassName)}>{children}</div>
    </section>
  );
}

/** Main-area card with a title row (e.g. "Schema  profiled with SUMMARIZE in 205 ms"). */
export function Panel({ title, meta, actions, children, className, bodyClassName }: { title?: ReactNode; meta?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; bodyClassName?: string }) {
  return (
    <section className={cn('rounded-xl border border-zinc-800 bg-zinc-900/40', className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-zinc-800 px-4 py-2.5">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {title && <h3 className="text-sm font-semibold text-zinc-100">{title}</h3>}
            {meta && <span className="font-mono text-[11px] text-zinc-500">{meta}</span>}
          </div>
          {actions}
        </header>
      )}
      <div className={bodyClassName ?? 'p-4'}>{children}</div>
    </section>
  );
}

/** Key/value rows in monospace, as in the reference "SYSTEM" / "LIVE RESOURCES" cards. */
export function KvRows({ rows }: { rows: { k: string; v: ReactNode; sub?: ReactNode }[] }) {
  return (
    <dl className="space-y-1.5 font-mono text-[11px]">
      {rows.map((r) => (
        <div key={r.k} className="grid grid-cols-[88px_1fr] gap-2">
          <dt className="truncate text-zinc-500">{r.k}</dt>
          <dd className="truncate text-zinc-200">
            {r.v}
            {r.sub && <span className="text-zinc-500"> {r.sub}</span>}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function typeTone(type: string): string {
  const t = type.toUpperCase();
  if (/INT|DOUBLE|FLOAT|DECIMAL|REAL|HUGEINT|NUMERIC/.test(t)) return 'border-amber-800/70 bg-amber-950/40 text-amber-300';
  if (/DATE|TIME|INTERVAL/.test(t)) return 'border-emerald-800/70 bg-emerald-950/40 text-emerald-300';
  if (t === 'BOOLEAN') return 'border-sky-800/70 bg-sky-950/40 text-sky-300';
  if (/STRUCT|MAP|LIST|\[\]|JSON|UNION/.test(t)) return 'border-fuchsia-800/70 bg-fuchsia-950/40 text-fuchsia-300';
  return 'border-zinc-700 bg-zinc-800/70 text-zinc-300';
}

export function TypePill({ type, className }: { type: string; className?: string }) {
  return <span className={cn('inline-flex rounded border px-1.5 py-0.5 font-mono text-[10px] leading-none', typeTone(type), className)}>{type}</span>;
}

/** Pill row for the header: DuckDB version · cores · headroom · Safe. */
export function StatusPill({ dot, children, tone = 'zinc', title }: { dot?: boolean; children: ReactNode; tone?: 'zinc' | 'green' | 'amber'; title?: string }) {
  const dotColor = tone === 'green' ? 'bg-emerald-400' : tone === 'amber' ? 'bg-amber-400' : 'bg-zinc-500';
  const text = tone === 'green' ? 'text-emerald-300' : tone === 'amber' ? 'text-amber-300' : 'text-zinc-400';
  return (
    <span title={title} className={cn('inline-flex items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-900/70 px-2 py-1 font-mono text-[11px]', text)}>
      {dot && <span className={cn('h-1.5 w-1.5 rounded-full', dotColor)} />}
      {children}
    </span>
  );
}

export function Tag({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn('inline-flex items-center rounded border border-zinc-800 bg-zinc-900 px-1.5 py-0.5 font-mono text-[10px] text-zinc-400', className)}>{children}</span>;
}
