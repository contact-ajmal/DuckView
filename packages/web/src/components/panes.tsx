/**
 * IDE-style resizable layout primitives.
 *  - SplitPane: two regions with a draggable gutter (horizontal or vertical); size persisted per storageKey.
 *  - StackedPanes: N vertically stacked sections with gutters between them; collapsible headers; last one fills.
 * Double-click any gutter to reset it to its default size.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { cn } from './ui';

export function usePersisted<T>(key: string, initial: T): [T, (v: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw == null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (v: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const next = typeof v === 'function' ? (v as (p: T) => T)(prev) : v;
        try {
          localStorage.setItem(key, JSON.stringify(next));
        } catch {
          /* quota / private mode */
        }
        return next;
      });
    },
    [key],
  );
  return [value, set];
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

export function Gutter({ direction, onDrag, onReset, className }: { direction: 'horizontal' | 'vertical'; onDrag: (delta: number, phase: 'start' | 'move' | 'end') => void; onReset?: () => void; className?: string }) {
  const horizontal = direction === 'horizontal';
  return (
    <div
      role="separator"
      aria-orientation={horizontal ? 'vertical' : 'horizontal'}
      onDoubleClick={onReset}
      onMouseDown={(e) => {
        e.preventDefault();
        const start = horizontal ? e.clientX : e.clientY;
        onDrag(0, 'start');
        document.body.style.cursor = horizontal ? 'col-resize' : 'row-resize';
        document.body.style.userSelect = 'none';
        const move = (ev: MouseEvent) => onDrag((horizontal ? ev.clientX : ev.clientY) - start, 'move');
        const up = (ev: MouseEvent) => {
          onDrag((horizontal ? ev.clientX : ev.clientY) - start, 'end');
          document.body.style.cursor = '';
          document.body.style.userSelect = '';
          window.removeEventListener('mousemove', move);
          window.removeEventListener('mouseup', up);
        };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
      }}
      className={cn('group relative z-10 shrink-0 select-none', horizontal ? 'w-1.5 cursor-col-resize' : 'h-1.5 cursor-row-resize', className)}
      title="Drag to resize · double-click to reset"
    >
      <div className={cn('absolute rounded-full bg-transparent transition-colors group-hover:bg-accent-500/70 group-active:bg-accent-400', horizontal ? 'inset-y-0 left-0.5 w-0.5' : 'inset-x-0 top-0.5 h-0.5')} />
    </div>
  );
}

export interface SplitPaneProps {
  direction: 'horizontal' | 'vertical';
  storageKey: string;
  defaultSize: number;
  min?: number;
  max?: number;
  /** Minimum size the secondary (flexible) region keeps. */
  minSecondary?: number;
  /** When true the primary region is hidden (size 0); the gutter remains so it can be dragged open. */
  collapsed?: boolean;
  onExpand?: () => void;
  primary: ReactNode;
  secondary: ReactNode;
  className?: string;
  primaryClassName?: string;
  secondaryClassName?: string;
}

export function SplitPane({ direction, storageKey, defaultSize, min = 120, max = 4000, minSecondary = 200, collapsed = false, onExpand, primary, secondary, className, primaryClassName, secondaryClassName }: SplitPaneProps) {
  const [size, setSize] = usePersisted<number>(`duckview.pane.${storageKey}`, defaultSize);
  const ref = useRef<HTMLDivElement>(null);
  const startSize = useRef(size);
  const horizontal = direction === 'horizontal';
  const onDrag = (delta: number, phase: 'start' | 'move' | 'end') => {
    if (phase === 'start') {
      startSize.current = collapsed ? 0 : size;
      return;
    }
    const total = ref.current ? (horizontal ? ref.current.clientWidth : ref.current.clientHeight) : 10_000;
    const next = clamp(startSize.current + delta, min, Math.min(max, total - minSecondary - 6));
    if (collapsed && delta > 24) onExpand?.();
    setSize(next);
  };
  const effective = collapsed ? 0 : size;
  return (
    <div ref={ref} className={cn('flex min-h-0 min-w-0', horizontal ? 'flex-row' : 'flex-col', className)}>
      <div className={cn('min-h-0 min-w-0 shrink-0 overflow-hidden', primaryClassName)} style={horizontal ? { width: effective } : { height: effective }}>
        {!collapsed && primary}
      </div>
      <Gutter direction={direction} onDrag={onDrag} onReset={() => setSize(defaultSize)} />
      <div className={cn('min-h-0 min-w-0 flex-1', secondaryClassName)}>{secondary}</div>
    </div>
  );
}

export interface StackSection {
  key: string;
  title: ReactNode;
  meta?: ReactNode;
  content: ReactNode;
  defaultHeight?: number;
  minHeight?: number;
}

/** Vertically stacked, individually resizable and collapsible sections (like an IDE side bar). */
export function StackedPanes({ storageKey, sections, className }: { storageKey: string; sections: StackSection[]; className?: string }) {
  const [heights, setHeights] = usePersisted<Record<string, number>>(`duckview.stack.${storageKey}.heights`, {});
  const [collapsed, setCollapsed] = usePersisted<Record<string, boolean>>(`duckview.stack.${storageKey}.collapsed`, {});
  const ref = useRef<HTMLDivElement>(null);
  const start = useRef<Record<string, number>>({});
  const HEADER = 34;
  // The last non-collapsed section is flexible; everything above has an explicit height.
  const flexibleKey = [...sections].reverse().find((s) => !collapsed[s.key])?.key;

  useEffect(() => {
    // drop stored heights for sections that no longer exist
    const known = new Set(sections.map((s) => s.key));
    if (Object.keys(heights).some((k) => !known.has(k))) setHeights((h) => Object.fromEntries(Object.entries(h).filter(([k]) => known.has(k))));
  }, [sections, heights, setHeights]);

  const heightOf = (s: StackSection) => heights[s.key] ?? s.defaultHeight ?? 220;

  return (
    <div ref={ref} className={cn('flex h-full min-h-0 flex-col', className)}>
      {sections.map((s, i) => {
        const isCollapsed = !!collapsed[s.key];
        const isFlex = s.key === flexibleKey;
        const next = sections[i + 1];
        return (
          <div key={s.key} className={cn('flex min-h-0 flex-col', isFlex && !isCollapsed ? 'flex-1' : 'shrink-0')} style={isCollapsed ? { height: HEADER } : isFlex ? undefined : { height: heightOf(s) }}>
            <header
              className="flex h-[34px] shrink-0 cursor-pointer select-none items-center justify-between gap-2 border-b border-zinc-800 bg-zinc-900/60 px-3"
              onClick={() => setCollapsed((c) => ({ ...c, [s.key]: !c[s.key] }))}
              title={isCollapsed ? 'Expand section' : 'Collapse section'}
            >
              <span className="flex min-w-0 items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-300">
                {isCollapsed ? <ChevronRight className="h-3 w-3 text-zinc-500" /> : <ChevronDown className="h-3 w-3 text-zinc-500" />}
                <span className="truncate">{s.title}</span>
              </span>
              {s.meta && (
                <span className="flex shrink-0 items-center text-[11px] text-zinc-500" onClick={(e) => e.stopPropagation()}>
                  {s.meta}
                </span>
              )}
            </header>
            {!isCollapsed && <div className="min-h-0 flex-1 overflow-auto">{s.content}</div>}
            {next && !isCollapsed && !isFlex && (
              <Gutter
                direction="vertical"
                onDrag={(delta, phase) => {
                  if (phase === 'start') {
                    start.current[s.key] = heightOf(s);
                    return;
                  }
                  setHeights((h) => ({ ...h, [s.key]: clamp((start.current[s.key] ?? heightOf(s)) + delta, s.minHeight ?? 80, 2000) }));
                }}
                onReset={() => setHeights((h) => ({ ...h, [s.key]: s.defaultHeight ?? 220 }))}
                className="border-b border-zinc-800"
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
