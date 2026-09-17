import { cn } from './ui';

/** Semi-circular arc gauge. `value` is 0–100. */
export function Gauge({ value, label, primary, secondary, tone }: { value: number; label: string; primary: string; secondary?: string; tone?: 'auto' | 'accent' }) {
  const pct = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
  const r = 54;
  const c = Math.PI * r; // half circumference
  const dash = (pct / 100) * c;
  const color = tone === 'accent' ? 'var(--series-1)' : pct >= 90 ? 'var(--status-critical)' : pct >= 75 ? 'var(--status-warning)' : 'var(--series-1)';
  return (
    <div className="flex flex-col items-center rounded-xl border border-zinc-800 bg-zinc-900/60 px-4 pb-3 pt-4">
      <svg viewBox="0 0 140 80" className="w-full max-w-[200px]">
        <path d="M 16 70 A 54 54 0 0 1 124 70" fill="none" stroke="#27272a" strokeWidth="10" strokeLinecap="round" />
        <path d="M 16 70 A 54 54 0 0 1 124 70" fill="none" stroke={color} strokeWidth="10" strokeLinecap="round" strokeDasharray={`${dash} ${c}`} style={{ transition: 'stroke-dasharray 400ms ease, stroke 400ms ease' }} />
        <text x="70" y="62" textAnchor="middle" fill="#fafafa" fontSize="20" fontWeight="600" fontFamily="Inter, system-ui, sans-serif">
          {pct.toFixed(0)}%
        </text>
      </svg>
      <div className="-mt-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">{label}</div>
      <div className={cn('mt-1 text-sm font-medium text-zinc-100')}>{primary}</div>
      {secondary && <div className="text-[11px] text-zinc-500">{secondary}</div>}
    </div>
  );
}
