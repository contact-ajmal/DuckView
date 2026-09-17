import { useEffect, useMemo, useRef, useState } from 'react';
import type { ColumnSchema } from '../../api/client';
import { cn } from '../../components/ui';

const ROW_H = 26;

function cell(v: unknown): { text: string; cls: string } {
  if (v === null || v === undefined) return { text: 'NULL', cls: 'text-zinc-600 italic' };
  if (typeof v === 'number') return { text: Number.isInteger(v) ? v.toLocaleString() : String(v), cls: 'text-right tabular-nums text-sky-200' };
  if (typeof v === 'boolean') return { text: v ? 'true' : 'false', cls: 'text-amber-300' };
  if (typeof v === 'object') return { text: JSON.stringify(v), cls: 'text-emerald-200' };
  return { text: String(v), cls: 'text-zinc-200' };
}

export function ResultsGrid({ columns, rows }: { columns: ColumnSchema[]; rows: unknown[][] }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(400);
  const [widths, setWidths] = useState<number[]>([]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    setHeight(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    // Estimate column widths from the first 200 rows.
    const sample = rows.slice(0, 200);
    setWidths(
      columns.map((c, i) => {
        let max = c.name.length + c.type.length * 0.6;
        for (const r of sample) max = Math.max(max, Math.min(60, cell(r[i]).text.length));
        return Math.max(80, Math.min(480, Math.round(max * 7.2 + 24)));
      }),
    );
  }, [columns, rows.length > 0 ? rows[0] : null]); // eslint-disable-line react-hooks/exhaustive-deps

  const total = rows.length;
  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - 5);
  const end = Math.min(total, Math.ceil((scrollTop + height) / ROW_H) + 5);
  const visible = useMemo(() => rows.slice(start, end), [rows, start, end]);
  const totalWidth = widths.reduce((a, b) => a + b, 0) + 48;

  return (
    <div ref={scroller} className="h-full overflow-auto font-mono text-xs" onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}>
      <div style={{ minWidth: totalWidth }}>
        <div className="sticky top-0 z-10 flex border-b border-zinc-800 bg-zinc-900" style={{ height: ROW_H + 8 }}>
          <div className="w-12 shrink-0 border-r border-zinc-800 px-2 py-1 text-right text-zinc-600">#</div>
          {columns.map((c, i) => (
            <div key={i} className="shrink-0 truncate border-r border-zinc-800 px-2 py-1" style={{ width: widths[i] ?? 120 }} title={`${c.name} · ${c.type}`}>
              <div className="truncate font-semibold text-zinc-200">{c.name}</div>
              <div className="truncate text-[10px] leading-3 text-zinc-500">{c.type}</div>
            </div>
          ))}
        </div>
        <div style={{ height: total * ROW_H, position: 'relative' }}>
          {visible.map((r, vi) => {
            const idx = start + vi;
            return (
              <div key={idx} className={cn('absolute left-0 right-0 flex border-b border-zinc-900 hover:bg-zinc-800/60', idx % 2 ? 'bg-zinc-950' : 'bg-zinc-950/60')} style={{ top: idx * ROW_H, height: ROW_H }}>
                <div className="w-12 shrink-0 border-r border-zinc-900 px-2 text-right leading-[26px] text-zinc-600">{idx + 1}</div>
                {columns.map((_c, i) => {
                  const { text, cls } = cell(r[i]);
                  return (
                    <div key={i} className={cn('shrink-0 truncate border-r border-zinc-900 px-2 leading-[26px]', cls)} style={{ width: widths[i] ?? 120 }} title={text}>
                      {text}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
