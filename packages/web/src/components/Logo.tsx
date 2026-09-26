/**
 * DuckView's mark: a D drawn as a viewport, holding a 2×2 data grid — one cell lit, the one you are looking at.
 * Geometric, no mascot; it stays legible at 16px (the favicon is the same drawing, see index.html).
 *
 * Variants:
 * - `mark` (default): accent tile with ink drawing — the app icon, the rail, the sign-in page.
 * - `mono`: the drawing alone in currentColor — on photos, print, embeds, snapshots.
 * - `full`: the mark with the wordmark beside it.
 * - `compact`: the mark with a tighter tile, for 20px and below.
 */
import { cn } from './ui';

type Variant = 'mark' | 'mono' | 'full' | 'compact';

function Drawing({ ink, tile, radius }: { ink: string; tile: string | null; radius: number }) {
  return (
    <>
      {tile && <rect width="100" height="100" rx={radius} fill={tile} />}
      <path d="M24 22h28a28 28 0 0 1 0 56H24z" fill="none" stroke={ink} strokeWidth="8.5" strokeLinejoin="round" />
      <rect x="34" y="37" width="11" height="11" rx="1.5" fill={ink} />
      <rect x="49" y="37" width="11" height="11" rx="1.5" fill={ink} opacity="0.42" />
      <rect x="34" y="52" width="11" height="11" rx="1.5" fill={ink} opacity="0.42" />
      <rect x="49" y="52" width="11" height="11" rx="1.5" fill={ink} opacity="0.42" />
    </>
  );
}

export function Logo({ className, variant = 'mark', label }: { className?: string; variant?: Variant; label?: string }) {
  const svg = (cls?: string) => (
    <svg viewBox="0 0 100 100" className={cls} role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true} data-logo={variant}>
      {variant === 'mono' ? <Drawing ink="currentColor" tile={null} radius={0} /> : <Drawing ink="var(--accent-ink)" tile="var(--color-accent-500)" radius={variant === 'compact' ? 18 : 22} />}
    </svg>
  );
  if (variant !== 'full') return svg(className);
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      {svg('h-full w-auto shrink-0')}
      <span className="text-body font-semibold tracking-tight text-fg-strong">DuckView</span>
    </span>
  );
}
