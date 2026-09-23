import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';
import type { ColumnSchema } from '../../api/client';
import { cn } from '../../components/ui';

const ROW_H = 26;

function cell(v: unknown): { text: string; cls: string } {
  if (v === null || v === undefined) return { text: 'NULL', cls: 'text-zinc-600 italic' };
  if (typeof v === 'number') return { text: Number.isInteger(v) ? v.toLocaleString() : String(v), cls: 'text-right tabular-nums text-zinc-100' };
  if (typeof v === 'bigint') return { text: v.toLocaleString(), cls: 'text-right tabular-nums text-zinc-100' };
  if (typeof v === 'boolean') return { text: v ? 'true' : 'false', cls: 'text-zinc-300' };
  if (typeof v === 'object') return { text: JSON.stringify(v), cls: 'text-zinc-300' };
  return { text: String(v), cls: 'text-zinc-200' };
}

/** Rows as tab-separated text (with a header), for pasting into a spreadsheet. */
export function rowsToTsv(columns: ColumnSchema[], rows: unknown[][]): string {
  const esc = (s: string) => s.replace(/[\t\n\r]/g, ' ');
  return [columns.map((c) => esc(c.name)).join('\t'), ...rows.map((r) => r.map((v) => esc(v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v))).join('\t'))].join('\n');
}

const compare = (a: unknown, b: unknown): number => {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'bigint' && typeof b === 'bigint') return a < b ? -1 : a > b ? 1 : 0;
  return String(typeof a === 'object' ? JSON.stringify(a) : a).localeCompare(String(typeof b === 'object' ? JSON.stringify(b) : b), undefined, { numeric: true });
};

/**
 * A virtualised result grid. Click a header to sort (asc → desc → off); drag a header's right edge to resize;
 * `filter` keeps rows where any cell contains the text. Sorting and filtering apply to the rows in the browser.
 */
export function ResultsGrid({ columns, rows, filter = '', onVisibleRows }: { columns: ColumnSchema[]; rows: unknown[][]; filter?: string; onVisibleRows?: (rows: unknown[][]) => void }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(400);
  const [widths, setWidths] = useState<number[]>([]);
  const [sort, setSort] = useState<{ col: number; dir: 1 | -1 } | null>(null);

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
        let max = Math.max(c.name.length, c.type.length * 0.8);
        for (const r of sample) max = Math.max(max, Math.min(60, cell(r[i]).text.length));
        return Math.max(72, Math.min(480, Math.round(max * 7.2 + 28)));
      }),
    );
    setSort(null);
  }, [columns, rows.length > 0 ? rows[0] : null]); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    let out = q ? rows.filter((r) => r.some((v) => v != null && String(typeof v === 'object' ? JSON.stringify(v) : v).toLowerCase().includes(q))) : rows;
    if (sort) out = [...out].sort((a, b) => compare(a[sort.col], b[sort.col]) * sort.dir);
    return out;
  }, [rows, filter, sort]);
  useEffect(() => onVisibleRows?.(shown), [shown]); // eslint-disable-line react-hooks/exhaustive-deps

  const total = shown.length;
  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - 5);
  const end = Math.min(total, Math.ceil((scrollTop + height) / ROW_H) + 5);
  const visible = useMemo(() => shown.slice(start, end), [shown, start, end]);
  const gutter = Math.max(40, String(total).length * 8 + 16);
  const totalWidth = widths.reduce((a, b) => a + b, 0) + gutter;

  const startResize = (i: number, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const x0 = e.clientX;
    const w0 = widths[i] ?? 120;
    const move = (ev: MouseEvent) => setWidths((w) => w.map((v, k) => (k === i ? Math.max(48, w0 + ev.clientX - x0) : v)));
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.style.cursor = '';
    };
    document.body.style.cursor = 'col-resize';
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  return (
    <div ref={scroller} className="h-full overflow-auto font-mono text-xs" onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)} role="grid" aria-rowcount={total} aria-colcount={columns.length}>
      <div style={{ minWidth: totalWidth }}>
        <div className="sticky top-0 z-10 flex border-b border-zinc-800 bg-zinc-900" style={{ height: ROW_H + 10 }} role="row">
          <div className="shrink-0 border-r border-zinc-800/70 px-2 py-1.5 text-right text-zinc-600" style={{ width: gutter }}>#</div>
          {columns.map((c, i) => (
            <div
              key={i}
              role="columnheader"
              aria-sort={sort?.col === i ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}
              className="group/h relative shrink-0 cursor-pointer select-none border-r border-zinc-800/70 px-2 py-1 hover:bg-zinc-800/40"
              style={{ width: widths[i] ?? 120 }}
              title={`${c.name} · ${c.type} — click to sort`}
              onClick={() => setSort((s) => (s?.col !== i ? { col: i, dir: 1 } : s.dir === 1 ? { col: i, dir: -1 } : null))}
            >
              <div className="flex items-center gap-1">
                <span className="min-w-0 flex-1 truncate font-sans text-[12px] font-semibold text-zinc-100">{c.name}</span>
                {sort?.col === i && (sort.dir === 1 ? <ArrowUp className="h-3 w-3 shrink-0 text-accent-400" /> : <ArrowDown className="h-3 w-3 shrink-0 text-accent-400" />)}
              </div>
              <div className="truncate text-[10px] leading-3 text-zinc-500">{c.type.toLowerCase()}</div>
              <span onMouseDown={(e) => startResize(i, e)} onClick={(e) => e.stopPropagation()} className="absolute -right-1 top-0 z-10 h-full w-2 cursor-col-resize" aria-hidden />
            </div>
          ))}
        </div>
        <div style={{ height: total * ROW_H, position: 'relative' }}>
          {visible.map((r, vi) => {
            const idx = start + vi;
            return (
              <div key={idx} role="row" className="absolute left-0 right-0 flex border-b border-zinc-800/50 hover:bg-zinc-900" style={{ top: idx * ROW_H, height: ROW_H }}>
                <div className="shrink-0 border-r border-zinc-800/50 px-2 text-right leading-[26px] text-zinc-600" style={{ width: gutter }}>{idx + 1}</div>
                {columns.map((_c, i) => {
                  const { text, cls } = cell(r[i]);
                  return (
                    <div key={i} role="gridcell" className={cn('shrink-0 truncate border-r border-zinc-800/40 px-2 leading-[26px]', cls)} style={{ width: widths[i] ?? 120 }} title={text}>
                      {text}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
        {total === 0 && rows.length > 0 && <div className="px-4 py-6 font-sans text-xs text-zinc-500">No rows match the filter.</div>}
      </div>
    </div>
  );
}
