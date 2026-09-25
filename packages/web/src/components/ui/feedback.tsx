/**
 * Feedback: toasts for the outcome of an action, a confirmation dialog in place of window.confirm, inline errors
 * with a way forward, and skeletons for content that is on its way.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import { AlertTriangle, CheckCircle2, Info, RotateCcw, X, XCircle } from 'lucide-react';
import { Button, IconButton, cn } from './index';
import { useFocusTrap } from './focus';

// ------------------------------------------------------------------------------------------ toasts

type ToastTone = 'success' | 'error' | 'info';
interface ToastItem { id: number; tone: ToastTone; title: string; detail?: string; action?: { label: string; run: () => void } }

const useToasts = create<{ items: ToastItem[]; push(t: Omit<ToastItem, 'id'>): void; dismiss(id: number): void }>((set) => ({
  items: [],
  push: (t) => {
    const id = Date.now() + Math.random();
    set((s) => ({ items: [...s.items.slice(-3), { ...t, id }] }));
    // Errors stay until read or replaced; the rest go by themselves.
    if (t.tone !== 'error') setTimeout(() => set((s) => ({ items: s.items.filter((x) => x.id !== id) })), 4500);
  },
  dismiss: (id) => set((s) => ({ items: s.items.filter((x) => x.id !== id) })),
}));

/** The first line of an error's message: what the server said, without a stack or SQL dump. */
export function errorText(e: unknown): string {
  const m = e instanceof Error ? e.message : typeof e === 'string' ? e : 'Something went wrong';
  return m.split('\n')[0]!.slice(0, 300);
}

/** Say how an action ended: `toast.success('Installed')`, `toast.error(err, 'Could not install')`. */
export const toast = {
  success: (title: string, detail?: string) => useToasts.getState().push({ tone: 'success', title, detail }),
  info: (title: string, detail?: string, action?: ToastItem['action']) => useToasts.getState().push({ tone: 'info', title, detail, action }),
  error: (e: unknown, title?: string) => useToasts.getState().push({ tone: 'error', title: title ?? errorText(e), detail: title ? errorText(e) : undefined }),
};

export function Toaster() {
  const { items, dismiss } = useToasts();
  const icon = { success: <CheckCircle2 className="h-4 w-4 text-emerald-400" />, error: <XCircle className="h-4 w-4 text-red-400" />, info: <Info className="h-4 w-4 text-sky-400" /> };
  return createPortal(
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[360px] max-w-[calc(100vw-2rem)] flex-col gap-2" aria-live="polite" aria-relevant="additions" data-testid="toaster">
      {items.map((t) => (
        <div key={t.id} role={t.tone === 'error' ? 'alert' : 'status'} data-toast={t.tone} className="dv-pop pointer-events-auto flex items-start gap-2.5 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2.5 shadow-xl">
          <span className="mt-0.5 shrink-0">{icon[t.tone]}</span>
          <div className="min-w-0 flex-1">
            <div className="text-body font-medium text-zinc-100">{t.title}</div>
            {t.detail && <div className="mt-0.5 break-words text-xs text-zinc-400">{t.detail}</div>}
            {t.action && <button className="mt-1 text-xs font-medium text-accent-300 hover:underline" onClick={() => { t.action!.run(); dismiss(t.id); }}>{t.action.label}</button>}
          </div>
          <IconButton label="Dismiss" className="-mr-1 -mt-0.5 h-6 w-6" onClick={() => dismiss(t.id)}><X className="h-3.5 w-3.5" /></IconButton>
        </div>
      ))}
    </div>,
    document.body,
  );
}

// ------------------------------------------------------------------------------------------ confirmation

interface ConfirmRequest { title: string; body?: string; confirmLabel: string; danger: boolean; input?: { label: string; value: string; placeholder?: string }; resolve: (ok: boolean, value?: string) => void }
const useConfirm = create<{ current: ConfirmRequest | null; set(c: ConfirmRequest | null): void }>((set) => ({ current: null, set: (current) => set({ current }) }));

const DESTRUCTIVE = /^(delete|remove|revoke|leave|stop|discard|drop|uninstall|reset)\b/i;

/**
 * Asks before doing something that is hard to undo; resolves true when confirmed. `confirmAction("Delete X? Its
 * history goes too.")` splits the question (the title) from the explanation, and names the button after the verb.
 */
export function confirmAction(message: string, opts: { title?: string; confirmLabel?: string; danger?: boolean } = {}): Promise<boolean> {
  const q = message.indexOf('?');
  const title = opts.title ?? (q > 0 ? message.slice(0, q + 1) : message);
  const body = opts.title ? message : q > 0 ? message.slice(q + 1).trim() || undefined : undefined;
  const verb = /^\s*(\w+)/.exec(title)?.[1] ?? 'Confirm';
  return new Promise((resolve) => useConfirm.getState().set({ title, body, confirmLabel: opts.confirmLabel ?? (verb.length <= 12 ? verb[0]!.toUpperCase() + verb.slice(1) : 'Confirm'), danger: opts.danger ?? DESTRUCTIVE.test(title.trim()), resolve }));
}

/** Asks for one line of text (a name, a path); resolves null when cancelled. */
export function promptAction(title: string, opts: { label?: string; defaultValue?: string; placeholder?: string; confirmLabel?: string; body?: string } = {}): Promise<string | null> {
  return new Promise((resolve) =>
    useConfirm.getState().set({ title, body: opts.body, confirmLabel: opts.confirmLabel ?? 'OK', danger: false, input: { label: opts.label ?? title, value: opts.defaultValue ?? '', placeholder: opts.placeholder }, resolve: (ok, value) => resolve(ok ? (value ?? '').trim() || null : null) }),
  );
}

export function ConfirmHost() {
  const { current, set } = useConfirm();
  const ref = useRef<HTMLDivElement>(null);
  const [value, setValue] = useState('');
  useFocusTrap(ref, !!current);
  useEffect(() => setValue(current?.input?.value ?? ''), [current]);
  const close = (ok: boolean) => {
    current?.resolve(ok, value);
    set(null);
  };
  useEffect(() => {
    if (!current) return;
    // Capture, and stop it there: Escape answers this question, not the dialog underneath it.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      close(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }); // eslint-disable-line react-hooks/exhaustive-deps
  if (!current) return null;
  return createPortal(
    <div className="fixed inset-0 z-[55] flex items-start justify-center bg-black/40 p-4 pt-[18vh]" onMouseDown={() => close(false)}>
      <div ref={ref} role="alertdialog" aria-modal="true" aria-labelledby="dv-confirm-title" aria-describedby={current.body ? 'dv-confirm-body' : undefined} data-testid="confirm-dialog" className="dv-pop w-full max-w-md rounded-xl border border-zinc-800 bg-zinc-950 p-5 shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex gap-3">
          {current.danger && <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />}
          <div className="min-w-0">
            <h2 id="dv-confirm-title" className="text-title font-semibold text-zinc-50">{current.title}</h2>
            {current.body && <p id="dv-confirm-body" className="mt-1.5 text-body text-zinc-400">{current.body}</p>}
          </div>
        </div>
        {current.input && (
          <form className="mt-3" onSubmit={(e) => { e.preventDefault(); close(true); }}>
            <input aria-label={current.input.label} data-autofocus value={value} placeholder={current.input.placeholder} onChange={(e) => setValue(e.target.value)} className="h-[var(--control-h)] w-full rounded-md border border-zinc-800 bg-zinc-950 px-2.5 text-body text-zinc-100 placeholder:text-zinc-600 focus:border-accent-500 focus:outline-none focus:ring-1 focus:ring-accent-500/40" />
          </form>
        )}
        <div className="mt-5 flex justify-end gap-2">
          {/* Destructive: Cancel has focus, so Enter does not destroy by accident. */}
          <Button onClick={() => close(false)} {...(current.danger ? { 'data-autofocus': true } : {})}>Cancel</Button>
          <Button variant={current.danger ? 'danger' : 'primary'} onClick={() => close(true)} data-testid="confirm-ok" disabled={!!current.input && !value.trim()} {...(current.danger || current.input ? {} : { 'data-autofocus': true })}>{current.confirmLabel}</Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ------------------------------------------------------------------------------------------ inline states

/** What went wrong, in place: the message, and a retry or another way forward. */
export function InlineError({ error, onRetry, action, className, title }: { error: unknown; onRetry?: () => void; action?: ReactNode; className?: string; title?: string }) {
  if (!error) return null;
  return (
    <div role="alert" className={cn('flex items-start gap-2 rounded-md border border-red-500/25 bg-red-500/8 px-3 py-2 text-xs', className)} data-testid="inline-error">
      <XCircle className="mt-px h-3.5 w-3.5 shrink-0 text-red-400" />
      <div className="min-w-0 flex-1">
        {title && <div className="font-medium text-red-200">{title}</div>}
        <div className="break-words text-red-300">{errorText(error)}</div>
      </div>
      {(onRetry || action) && (
        <div className="-my-0.5 flex shrink-0 items-center gap-1">
          {action}
          {onRetry && <Button size="sm" variant="ghost" className="h-6 text-red-200" onClick={onRetry}><RotateCcw className="h-3 w-3" /> Retry</Button>}
        </div>
      )}
    </div>
  );
}

/** A whole area that failed to load. */
export function ErrorState({ error, onRetry, title = 'This could not be loaded' }: { error: unknown; onRetry?: () => void; title?: string }) {
  return (
    <div role="alert" className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center" data-testid="error-state">
      <XCircle className="h-6 w-6 text-red-400" />
      <div className="text-body font-medium text-zinc-200">{title}</div>
      <div className="max-w-md break-words text-xs text-zinc-500">{errorText(error)}</div>
      {onRetry && <Button size="sm" className="mt-2" onClick={onRetry}><RotateCcw className="h-3.5 w-3.5" /> Try again</Button>}
    </div>
  );
}

/** A placeholder in the shape of what is loading. */
export function Skeleton({ className, lines }: { className?: string; lines?: number }) {
  if (lines) return <div className={cn('space-y-2', className)} aria-hidden>{Array.from({ length: lines }, (_, i) => <div key={i} className="shimmer h-3 rounded" style={{ width: `${100 - ((i * 17) % 40)}%` }} />)}</div>;
  return <div className={cn('shimmer rounded', className)} aria-hidden />;
}

/** Runs an async action with a pending flag, a success toast and an error toast. */
export function useAction() {
  const [pending, setPending] = useState<string | null>(null);
  const run = async <T,>(key: string, fn: () => Promise<T>, done?: string): Promise<T | undefined> => {
    setPending(key);
    try {
      const r = await fn();
      if (done) toast.success(done);
      return r;
    } catch (e) {
      toast.error(e);
      return undefined;
    } finally {
      setPending(null);
    }
  };
  return { pending, run };
}
