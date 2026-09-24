import type { ReactNode } from 'react';
import { cn } from './ui';
import { HideButton } from './LayoutMenu';

/**
 * Page-level eyebrow labels were template chrome; the top bar's breadcrumb now says where you are. Kept as a no-op so
 * existing pages compile, and so nothing is shown twice.
 */
export function Eyebrow(_props: { children: ReactNode }) {
  return null;
}

export function PageTitle({ children, className, title }: { children: ReactNode; className?: string; title?: string }) {
  return <h1 className={cn('text-page font-semibold tracking-tight text-zinc-50', className)} title={title}>{children}</h1>;
}

/** The compact header of a workspace page: title (and a one-line description), actions on the right. */
export function PageHeader({ title, description, actions, children, className }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-wrap items-center gap-x-4 gap-y-2', className)}>
      <div className="min-w-0 flex-1">
        <PageTitle>{title}</PageTitle>
        {description && <p className="mt-0.5 max-w-3xl truncate text-xs text-zinc-500">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      {children}
    </div>
  );
}

/** A labelled group in a side column: a small heading, then its content — no box around it. */
export function SideCard({ title, meta, children, className, bodyClassName, hideId }: { title: ReactNode; meta?: ReactNode; children: ReactNode; className?: string; bodyClassName?: string; hideId?: string }) {
  return (
    <section className={cn('border-b border-zinc-800 last:border-0', className)}>
      <header className="group/hdr flex h-9 items-center justify-between gap-2 px-3">
        <h3 className="text-xs font-semibold text-zinc-300">{title}</h3>
        <div className="flex items-center gap-1.5">
          {meta && <div className="text-2xs text-zinc-500">{meta}</div>}
          {hideId && <HideButton id={hideId} className="opacity-0 group-hover/hdr:opacity-100" />}
        </div>
      </header>
      <div className={cn('px-3 pb-3', bodyClassName)}>{children}</div>
    </section>
  );
}

/** A section of a page: a heading row with meta and actions, then the content. */
export function Panel({ title, meta, actions, children, className, bodyClassName, hideId }: { title?: ReactNode; meta?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; bodyClassName?: string; hideId?: string }) {
  return (
    <section className={cn('relative rounded-lg border border-zinc-800', className)}>
      {(title || actions || hideId) && (
        <header className="group/hdr flex min-h-10 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-zinc-800 px-4 py-1.5">
          <div className="flex min-w-0 flex-wrap items-baseline gap-2">
            {title && <h3 className="text-body font-semibold text-zinc-100">{title}</h3>}
            {meta && <span className="text-2xs text-zinc-500">{meta}</span>}
          </div>
          <div className="flex items-center gap-2">
            {actions}
            {hideId && <HideButton id={hideId} className="opacity-0 group-hover/hdr:opacity-100" />}
          </div>
        </header>
      )}
      <div className={bodyClassName ?? 'p-4'}>{children}</div>
    </section>
  );
}

/** Key/value rows in monospace, as in the reference "SYSTEM" / "LIVE RESOURCES" cards. */
export function KvRows({ rows }: { rows: { k: string; v: ReactNode; sub?: ReactNode }[] }) {
  return (
    <dl className="space-y-1.5 font-mono text-2xs">
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

/** Column types read as quiet monospace text; only the family is hinted by colour. */
export function typeTone(type: string): string {
  const t = type.toUpperCase();
  if (/INT|DOUBLE|FLOAT|DECIMAL|REAL|HUGEINT|NUMERIC/.test(t)) return 'text-sky-300';
  if (/DATE|TIME|INTERVAL/.test(t)) return 'text-emerald-300';
  if (t === 'BOOLEAN') return 'text-fuchsia-300';
  if (/STRUCT|MAP|LIST|\[\]|JSON|UNION/.test(t)) return 'text-fuchsia-300';
  return 'text-zinc-500';
}

export function TypePill({ type, className }: { type: string; className?: string }) {
  return <span className={cn('inline-flex font-mono text-2xs leading-none', typeTone(type), className)}>{type.toLowerCase()}</span>;
}

/** Pill row for the header: DuckDB version · cores · headroom · Safe. */
export function StatusPill({ dot, children, tone = 'zinc', title }: { dot?: boolean; children: ReactNode; tone?: 'zinc' | 'green' | 'amber'; title?: string }) {
  const dotColor = tone === 'green' ? 'bg-emerald-500' : tone === 'amber' ? 'bg-amber-500' : 'bg-zinc-500';
  const text = 'text-zinc-400';
  return (
    <span title={title} className={cn('inline-flex items-center gap-1.5 text-2xs', text)}>
      {dot && <span className={cn('h-1.5 w-1.5 rounded-full', dotColor)} />}
      {children}
    </span>
  );
}

export function Tag({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn('inline-flex items-center rounded bg-zinc-900 px-1.5 py-0.5 font-mono text-2xs text-zinc-400', className)}>{children}</span>;
}
