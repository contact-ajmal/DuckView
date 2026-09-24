/** Form controls beyond Input and Select: a labelled field with hint and error, text areas, checkboxes, switches. */
import { useId, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react';
import { cn } from './index';

/** A label, the control, then a hint or the error that explains what to change. */
export function Field({ label, hint, error, children, className, htmlFor }: { label: ReactNode; hint?: ReactNode; error?: ReactNode; children: ReactNode; className?: string; htmlFor?: string }) {
  return (
    <div className={cn('min-w-0', className)}>
      <label htmlFor={htmlFor} className="mb-1 block text-xs font-medium text-zinc-400">{label}</label>
      {children}
      {error ? <p role="alert" className="mt-1 text-2xs text-red-300">{error}</p> : hint ? <p className="mt-1 text-2xs text-zinc-500">{hint}</p> : null}
    </div>
  );
}

export function Textarea({ className, mono, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { mono?: boolean }) {
  return <textarea className={cn('w-full rounded-md border border-zinc-800 bg-zinc-950 px-2.5 py-1.5 text-body text-zinc-100 placeholder:text-zinc-600 focus:border-accent-500 focus:outline-none focus:ring-1 focus:ring-accent-500/40', mono && 'font-mono text-xs', className)} {...rest} />;
}

/** A checkbox with its label on the right; the whole row is clickable. */
export function Checkbox({ label, hint, className, ...rest }: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { label: ReactNode; hint?: ReactNode }) {
  const id = useId();
  return (
    <label htmlFor={rest.id ?? id} className={cn('flex cursor-pointer items-start gap-2 text-body text-zinc-300', rest.disabled && 'cursor-not-allowed opacity-50', className)}>
      <input id={rest.id ?? id} type="checkbox" className="mt-[3px] h-3.5 w-3.5 shrink-0 cursor-pointer accent-[var(--color-accent-500)]" {...rest} />
      <span className="min-w-0">
        {label}
        {hint && <span className="block text-2xs text-zinc-500">{hint}</span>}
      </span>
    </label>
  );
}

/** An on/off setting that takes effect at once. */
export function Switch({ checked, onChange, label, disabled, className }: { checked: boolean; onChange: (on: boolean) => void; label: ReactNode; disabled?: boolean; className?: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)} className={cn('inline-flex items-center gap-2 text-body text-zinc-300 disabled:opacity-50', className)}>
      <span className={cn('relative h-4 w-7 shrink-0 rounded-full transition-colors duration-[var(--dur-fast)]', checked ? 'bg-accent-500' : 'bg-zinc-700')}>
        <span className={cn('absolute top-0.5 h-3 w-3 rounded-full bg-white shadow-sm transition-transform duration-[var(--dur-fast)]', checked ? 'translate-x-3.5' : 'translate-x-0.5')} />
      </span>
      {label}
    </button>
  );
}
