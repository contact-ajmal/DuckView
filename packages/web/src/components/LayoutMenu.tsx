import { useEffect, useRef, useState } from 'react';
import { LayoutTemplate, Eye, RotateCcw, X } from 'lucide-react';
import { useLayout, LAYOUT_COMPONENTS, PAGE_LABELS, type LayoutPage } from '../store/layout';
import { cn } from './ui';

/** Small "hide this" affordance for panel headers. */
export function HideButton({ id, className }: { id: string; className?: string }) {
  const hide = useLayout((s) => s.hide);
  const label = LAYOUT_COMPONENTS.find((c) => c.id === id)?.label ?? 'panel';
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        hide(id);
      }}
      className={cn('rounded p-0.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200', className)}
      title={`Hide ${label} (restore from Layout in the header or Settings)`}
      aria-label={`Hide ${label}`}
    >
      <X className="h-3.5 w-3.5" />
    </button>
  );
}

/** Header dropdown: what is hidden on each page, with one-click restore. */
export function LayoutMenu({ currentPage }: { currentPage: LayoutPage | null }) {
  const { hidden, show, reset } = useLayout();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const hiddenItems = LAYOUT_COMPONENTS.filter((c) => hidden[c.id]);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  const pages = [...new Set(hiddenItems.map((c) => c.page))].sort((a, b) => (a === currentPage ? -1 : b === currentPage ? 1 : 0));
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen(!open)} className={cn('inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs', hiddenItems.length ? 'border-amber-800/60 bg-amber-950/30 text-amber-200' : 'border-zinc-800 bg-zinc-900/70 text-zinc-300 hover:text-zinc-100')} title="Layout — show hidden components">
        <LayoutTemplate className="h-3.5 w-3.5" /> Layout{hiddenItems.length ? <span className="rounded-full bg-amber-500/20 px-1.5 font-mono text-2xs">{hiddenItems.length}</span> : null}
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-80 rounded-lg border border-zinc-800 bg-zinc-900 p-2 shadow-xl">
          {hiddenItems.length === 0 ? (
            <p className="px-2 py-2 text-xs text-zinc-500">Nothing is hidden. Use the × on any panel header to remove it from the page; it will be listed here.</p>
          ) : (
            <>
              {pages.map((page) => (
                <div key={page} className="mb-2">
                  <div className="flex items-center justify-between px-2 pb-1 text-2xs font-semibold text-zinc-500">
                    <span>{PAGE_LABELS[page]}</span>
                    <button onClick={() => reset(page)} className="inline-flex items-center gap-1 normal-case tracking-normal text-accent-300 hover:underline">
                      <RotateCcw className="h-3 w-3" /> show all
                    </button>
                  </div>
                  {hiddenItems
                    .filter((c) => c.page === page)
                    .map((c) => (
                      <button key={c.id} onClick={() => show(c.id)} className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-zinc-800">
                        <Eye className="mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-500" />
                        <span>
                          <span className="text-zinc-100">{c.label}</span>
                          <span className="block text-2xs text-zinc-500">{c.description}</span>
                        </span>
                      </button>
                    ))}
                </div>
              ))}
              <button onClick={() => reset()} className="mt-1 flex w-full items-center justify-center gap-1 rounded-md border border-zinc-800 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800">
                <RotateCcw className="h-3 w-3" /> Show everything
              </button>
            </>
          )}
          <p className="mt-2 border-t border-zinc-800 px-2 pt-2 text-2xs text-zinc-500">Full list under Settings → Layout.</p>
        </div>
      )}
    </div>
  );
}

/** Settings card: checklist of every component, grouped by page. */
export function LayoutSettings() {
  const { hidden, toggle, reset } = useLayout();
  const pages: LayoutPage[] = ['query', 'overview', 'settings', 'mcp'];
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-zinc-500">Untick a component to remove it from its page; tick it to bring it back. Panel sizes and hidden components are remembered in this browser.</p>
        <button onClick={() => reset()} className="inline-flex shrink-0 items-center gap-1 rounded-md border border-zinc-800 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"><RotateCcw className="h-3 w-3" /> Show everything</button>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {pages.map((page) => (
          <div key={page} className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-2xs font-semibold text-zinc-400">{PAGE_LABELS[page]}</span>
              <button onClick={() => reset(page)} className="text-2xs text-accent-300 hover:underline">show all</button>
            </div>
            <div className="space-y-1">
              {LAYOUT_COMPONENTS.filter((c) => c.page === page).map((c) => (
                <label key={c.id} className="flex cursor-pointer items-start gap-2 rounded px-1 py-1 text-xs hover:bg-zinc-800/60">
                  <input type="checkbox" checked={!hidden[c.id]} onChange={() => toggle(c.id)} className="mt-0.5 accent-accent-500" />
                  <span>
                    <span className={cn(hidden[c.id] ? 'text-zinc-500 line-through' : 'text-zinc-100')}>{c.label}</span>
                    <span className="block text-2xs text-zinc-500">{c.description}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
