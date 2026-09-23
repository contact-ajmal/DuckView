/**
 * DuckView's primitives. One control height (30px, `sm` 26px), one radius per level (controls 4px, panels 6px,
 * dialogs 8px), neutral surfaces, and the accent reserved for "what to do" (primary actions, the active item, focus).
 */
import { type ReactNode, type ButtonHTMLAttributes, type InputHTMLAttributes, type SelectHTMLAttributes, useEffect, useRef, useState } from 'react';
import { X, Loader2, Check, Copy } from 'lucide-react';

export function cn(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(' ');
}

/** Callers that pass their own height (`h-7`) or text size keep it; the defaults only apply otherwise. */
const hasH = (c?: string) => /(^|\s)h-/.test(c ?? '');
const hasText = (c?: string) => /(^|\s)text-(\[|xs|sm|base)/.test(c ?? '');

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
export function Button({ variant = 'secondary', size = 'md', className, children, loading, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md'; loading?: boolean }) {
  const base = 'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-colors duration-[var(--dur-fast)] disabled:cursor-not-allowed disabled:opacity-45';
  const sizes = cn(size === 'sm' ? 'px-2' : 'px-3', !hasH(className) && (size === 'sm' ? 'h-[26px]' : 'h-[var(--control-h)]'), !hasText(className) && (size === 'sm' ? 'text-xs' : 'text-[13px]'));
  const variants: Record<Variant, string> = {
    primary: 'bg-accent-500 text-[color:var(--accent-ink)] hover:bg-accent-600',
    secondary: 'border border-zinc-800 bg-zinc-950 text-zinc-200 hover:border-zinc-700 hover:bg-zinc-900',
    ghost: 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100',
    danger: 'border border-red-900/70 text-red-300 hover:bg-red-950/60',
  };
  return (
    <button className={cn(base, sizes, variants[variant], className)} disabled={loading || rest.disabled} {...rest}>
      {loading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
      {children}
    </button>
  );
}

/** A square icon-only button; `label` is required and becomes the accessible name and tooltip. */
export function IconButton({ label, active, className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean }) {
  return (
    <button aria-label={label} title={label} className={cn('inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors duration-[var(--dur-fast)] disabled:opacity-40', active ? 'bg-zinc-800 text-zinc-50' : 'text-zinc-500 hover:bg-zinc-900 hover:text-zinc-100', className)} {...rest}>
      {children}
    </button>
  );
}

export function Input({ className, uiSize = 'md', ...rest }: InputHTMLAttributes<HTMLInputElement> & { uiSize?: 'sm' | 'md' }) {
  return <input className={cn('w-full rounded-md border border-zinc-800 bg-zinc-950 text-zinc-100 placeholder:text-zinc-600 focus:border-accent-500 focus:outline-none focus:ring-1 focus:ring-accent-500/40', uiSize === 'sm' ? 'px-2' : 'px-2.5', !hasH(className) && (uiSize === 'sm' ? 'h-[26px]' : 'h-[var(--control-h)]'), !hasText(className) && (uiSize === 'sm' ? 'text-xs' : 'text-[13px]'), className)} {...rest} />;
}

export function Select({ className, children, uiSize = 'md', ...rest }: SelectHTMLAttributes<HTMLSelectElement> & { uiSize?: 'sm' | 'md' }) {
  return (
    <select className={cn('rounded-md border border-zinc-800 bg-zinc-950 text-zinc-100 focus:border-accent-500 focus:outline-none focus:ring-1 focus:ring-accent-500/40', uiSize === 'sm' ? 'px-1.5' : 'px-2', !hasH(className) && (uiSize === 'sm' ? 'h-[26px]' : 'h-[var(--control-h)]'), !hasText(className) && (uiSize === 'sm' ? 'text-xs' : 'text-[13px]'), className)} {...rest}>
      {children}
    </select>
  );
}

export function Label({ children, className }: { children: ReactNode; className?: string }) {
  return <label className={cn('mb-1 block text-xs font-medium text-zinc-400', className)}>{children}</label>;
}

export function Badge({ children, tone = 'zinc', className }: { children: ReactNode; tone?: 'zinc' | 'violet' | 'green' | 'amber' | 'red' | 'blue'; className?: string }) {
  const tones = {
    zinc: 'bg-zinc-900 text-zinc-400',
    violet: 'bg-accent-500/15 text-accent-300',
    green: 'bg-emerald-500/12 text-emerald-400',
    amber: 'bg-amber-500/12 text-amber-400',
    red: 'bg-red-500/12 text-red-400',
    blue: 'bg-sky-500/12 text-sky-400',
  };
  return <span className={cn('inline-flex items-center rounded px-1.5 py-[3px] text-[11px] font-medium leading-none', tones[tone], className)}>{children}</span>;
}

/** A status dot with its word: status is never colour alone. */
export function StatusDot({ tone, children, pulse, className }: { tone: 'ok' | 'warn' | 'error' | 'idle' | 'busy'; children?: ReactNode; pulse?: boolean; className?: string }) {
  const color = { ok: 'bg-emerald-500', warn: 'bg-amber-500', error: 'bg-red-500', idle: 'bg-zinc-600', busy: 'bg-sky-500' }[tone];
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-xs text-zinc-400', className)}>
      <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', color, pulse && 'animate-pulse')} />
      {children}
    </span>
  );
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return <kbd className={cn('inline-flex h-[18px] min-w-[18px] items-center justify-center rounded border border-zinc-800 bg-zinc-900 px-1 font-mono text-[10px] text-zinc-500', className)}>{children}</kbd>;
}

/** Underlined tabs for switching views inside a workspace. */
export function Tabs<T extends string>({ tabs, value, onChange, className, size = 'md' }: { tabs: { id: T; label: ReactNode; count?: number; hidden?: boolean }[]; value: T; onChange: (id: T) => void; className?: string; size?: 'sm' | 'md' }) {
  return (
    <div role="tablist" className={cn('flex min-w-0 items-center gap-4 overflow-x-auto border-b border-zinc-800', className)}>
      {tabs.filter((t) => !t.hidden).map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={value === t.id}
          onClick={() => onChange(t.id)}
          className={cn('-mb-px inline-flex shrink-0 items-center gap-1.5 border-b-2 font-medium transition-colors duration-[var(--dur-fast)]', size === 'sm' ? 'py-1.5 text-xs' : 'py-2 text-[13px]', value === t.id ? 'border-accent-500 text-zinc-50' : 'border-transparent text-zinc-500 hover:text-zinc-200')}
        >
          {t.label}
          {t.count != null && <span className="text-[11px] tabular-nums text-zinc-600">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** A dropdown menu anchored to its trigger; closes on outside click and Escape. */
export function Menu({ trigger, children, align = 'right', width = 'w-56', className }: { trigger: (open: boolean, toggle: () => void) => ReactNode; children: (close: () => void) => ReactNode; align?: 'left' | 'right'; width?: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div ref={ref} className={cn('relative', className)}>
      {trigger(open, () => setOpen((o) => !o))}
      {open && (
        <div role="menu" className={cn('dv-pop absolute top-full z-50 mt-1 rounded-lg border border-zinc-800 bg-zinc-950 p-1 shadow-xl', align === 'right' ? 'right-0' : 'left-0', width)}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function MenuItem({ icon, children, onClick, hint, danger, active }: { icon?: ReactNode; children: ReactNode; onClick?: () => void; hint?: ReactNode; danger?: boolean; active?: boolean }) {
  return (
    <button role="menuitem" onClick={onClick} className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors', danger ? 'text-red-400 hover:bg-red-500/10' : 'text-zinc-300 hover:bg-zinc-900 hover:text-zinc-50', active && 'bg-zinc-900 text-zinc-50')}>
      {icon && <span className="flex w-4 shrink-0 justify-center text-zinc-500">{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint && <span className="shrink-0 text-[11px] text-zinc-600">{hint}</span>}
    </button>
  );
}

export function MenuDivider() {
  return <div className="my-1 h-px bg-zinc-800" />;
}

export function Modal({ open, onClose, title, children, width = 'max-w-lg' }: { open: boolean; onClose: () => void; title: string; children: ReactNode; width?: string }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 pt-[10vh]" onMouseDown={onClose}>
      <div role="dialog" aria-modal="true" aria-label={title} className={cn('dv-pop w-full rounded-xl border border-zinc-800 bg-zinc-950 shadow-2xl', width)} onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 pb-1 pt-4">
          <h2 className="text-[15px] font-semibold text-zinc-50">{title}</h2>
          <IconButton label="Close" onClick={onClose}>
            <X className="h-4 w-4" />
          </IconButton>
        </div>
        <div className="px-5 pb-5 pt-2">{children}</div>
      </div>
    </div>
  );
}

/** A panel that slides in from the right edge, over the workspace. */
export function Drawer({ open, onClose, title, children, width = 'w-[420px]', actions }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; width?: string; actions?: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/20" onMouseDown={onClose}>
      <aside className={cn('dv-drawer flex h-full max-w-[92vw] flex-col border-l border-zinc-800 bg-zinc-950 shadow-2xl', width)} onMouseDown={(e) => e.stopPropagation()}>
        <header className="flex h-[var(--topbar-h)] shrink-0 items-center gap-2 border-b border-zinc-800 px-4">
          <h2 className="min-w-0 flex-1 truncate text-[13px] font-semibold text-zinc-50">{title}</h2>
          {actions}
          <IconButton label="Close" onClick={onClose}>
            <X className="h-4 w-4" />
          </IconButton>
        </header>
        <div className="min-h-0 flex-1 overflow-auto">{children}</div>
      </aside>
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('h-4 w-4 animate-spin text-zinc-500', className)} />;
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      size="sm"
      variant="ghost"
      onClick={() => {
        navigator.clipboard.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        });
      }}
    >
      {done ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
      {done ? 'Copied' : label}
    </Button>
  );
}

/** Nothing here yet: say what goes here and offer the way to add it. */
export function Empty({ title, hint, icon, action }: { title: string; hint?: string; icon?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
      {icon && <div className="text-zinc-600 [&_svg]:h-6 [&_svg]:w-6">{icon}</div>}
      <div className="text-[13px] font-medium text-zinc-200">{title}</div>
      {hint && <div className="max-w-sm text-xs leading-relaxed text-zinc-500">{hint}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/** A titled group. Flat: a heading and a hairline, not a box. */
export function Card({ title, children, className, actions }: { title?: ReactNode; children: ReactNode; className?: string; actions?: ReactNode }) {
  return (
    <section className={cn('rounded-lg border border-zinc-800', className)}>
      {(title || actions) && (
        <header className="flex min-h-10 items-center justify-between gap-2 border-b border-zinc-800 px-4 py-2">
          <h3 className="text-[13px] font-semibold text-zinc-100">{title}</h3>
          {actions}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-zinc-500">{label}</div>
      <div className="mt-0.5 text-[18px] font-semibold tabular-nums text-zinc-50">{value}</div>
      {sub && <div className="truncate text-xs text-zinc-500">{sub}</div>}
    </div>
  );
}
