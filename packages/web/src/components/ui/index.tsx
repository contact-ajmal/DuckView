import { type ReactNode, type ButtonHTMLAttributes, type InputHTMLAttributes, type SelectHTMLAttributes, useEffect, useState } from 'react';
import { X, Loader2, Check, Copy } from 'lucide-react';

export function cn(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(' ');
}

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
export function Button({ variant = 'secondary', size = 'md', className, children, loading, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md'; loading?: boolean }) {
  const base = 'inline-flex items-center gap-1.5 rounded-md font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 disabled:opacity-50 disabled:cursor-not-allowed';
  const sizes = size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-9 px-3.5 text-sm';
  const variants: Record<Variant, string> = {
    primary: 'bg-accent-600 hover:bg-accent-500 text-white shadow-sm shadow-accent-900/40',
    secondary: 'bg-zinc-800 hover:bg-zinc-700 text-zinc-100 border border-zinc-700',
    ghost: 'hover:bg-zinc-800 text-zinc-300 hover:text-zinc-100',
    danger: 'bg-red-900/40 hover:bg-red-900/70 text-red-200 border border-red-900',
  };
  return (
    <button className={cn(base, sizes, variants[variant], className)} disabled={loading || rest.disabled} {...rest}>
      {loading && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
      {children}
    </button>
  );
}

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn('h-9 w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 text-sm text-zinc-100 placeholder:text-zinc-500 focus:border-accent-500 focus:outline-none focus:ring-1 focus:ring-accent-500', className)} {...rest} />;
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cn('h-9 rounded-md border border-zinc-700 bg-zinc-900 px-2 text-sm text-zinc-100 focus:border-accent-500 focus:outline-none focus:ring-1 focus:ring-accent-500', className)} {...rest}>
      {children}
    </select>
  );
}

export function Label({ children, className }: { children: ReactNode; className?: string }) {
  return <label className={cn('mb-1 block text-xs font-medium uppercase tracking-wide text-zinc-400', className)}>{children}</label>;
}

export function Badge({ children, tone = 'zinc', className }: { children: ReactNode; tone?: 'zinc' | 'violet' | 'green' | 'amber' | 'red' | 'blue'; className?: string }) {
  const tones = {
    zinc: 'bg-zinc-800 text-zinc-300 border-zinc-700',
    violet: 'bg-accent-600/20 text-accent-300 border-accent-600/40',
    green: 'bg-emerald-900/40 text-emerald-300 border-emerald-800',
    amber: 'bg-amber-900/40 text-amber-300 border-amber-800',
    red: 'bg-red-900/40 text-red-300 border-red-800',
    blue: 'bg-sky-900/40 text-sky-300 border-sky-800',
  };
  return <span className={cn('inline-flex items-center rounded border px-1.5 py-0.5 text-[11px] font-medium leading-none', tones[tone], className)}>{children}</span>;
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" onMouseDown={onClose}>
      <div className={cn('w-full rounded-xl border border-zinc-800 bg-zinc-900 shadow-2xl', width)} onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-3">
          <h2 className="text-sm font-semibold text-zinc-100">{title}</h2>
          <button className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100" onClick={onClose} aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('h-4 w-4 animate-spin text-accent-400', className)} />;
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

export function Empty({ title, hint, icon }: { title: string; hint?: string; icon?: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
      {icon && <div className="text-zinc-600">{icon}</div>}
      <div className="text-sm font-medium text-zinc-300">{title}</div>
      {hint && <div className="max-w-sm text-xs text-zinc-500">{hint}</div>}
    </div>
  );
}

export function Card({ title, children, className, actions }: { title?: ReactNode; children: ReactNode; className?: string; actions?: ReactNode }) {
  return (
    <section className={cn('rounded-xl border border-zinc-800 bg-zinc-900/60', className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between border-b border-zinc-800 px-4 py-2.5">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">{title}</h3>
          {actions}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/80 p-3">
      <div className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="mt-1 text-lg font-semibold text-zinc-100">{value}</div>
      {sub && <div className="text-xs text-zinc-500">{sub}</div>}
    </div>
  );
}
