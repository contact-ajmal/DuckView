/**
 * DataTable — the one table for lists of things (runs, members, connections, budgets, usage rows …). Query results
 * use ResultsGrid (virtualised, column types); everything else uses this.
 *
 *  - Columns declare how to render a cell and, optionally, how to sort it; headers sort on click (aria-sort).
 *  - `search` adds a filter box; `columnPicker` lets people hide columns (remembered per table id).
 *  - `rows === null` is loading (skeleton rows); an error shows inline with Retry; no rows shows `empty`.
 *  - Rows can be clickable (`onRowClick`, keyboard too) and selectable (checkbox column, select all).
 *  - Long lists show `pageSize` rows and a "Show more" button rather than paging controls.
 */
import { Fragment, useMemo, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, Columns3, Search } from 'lucide-react';
import { Button, Checkbox, Empty, InlineError, Input, Menu, Skeleton, cn } from '../ui';

export interface Column<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  /** Makes the column sortable. */
  sortValue?: (row: T) => string | number | boolean | null | undefined;
  align?: 'left' | 'right';
  /** A Tailwind width (`w-24`) for fixed columns; the rest share the space. */
  width?: string;
  /** Hidden until the person turns it on (with `columnPicker`). */
  defaultHidden?: boolean;
  /** Numbers, dates, IDs: tabular figures. */
  numeric?: boolean;
  /** Cut long text with an ellipsis (give the column a width, or it shares the rest). */
  truncate?: boolean;
  /** Classes for both the header and the cells, e.g. container queries that hide the column when narrow. */
  responsive?: string;
  className?: string;
}

interface Props<T> {
  rows: T[] | null;
  columns: Column<T>[];
  rowKey: (row: T) => string;
  /** What to say, and the action, when there are no rows. */
  empty?: ReactNode;
  error?: unknown;
  onRetry?: () => void;
  /** The text a row is found by; enables the filter box. */
  search?: (row: T) => string;
  searchPlaceholder?: string;
  onRowClick?: (row: T) => void;
  selected?: string[];
  onSelectedChange?: (keys: string[]) => void;
  /** Remembers hidden columns under this id. */
  columnPicker?: string;
  pageSize?: number;
  initialSort?: { key: string; desc?: boolean };
  toolbar?: ReactNode;
  /** Spoken name of the table for screen readers. */
  label: string;
  /** compact: 12px, tight rows and a sticky header, for dense data (profiles, stats). */
  density?: 'default' | 'compact';
  className?: string;
  rowClassName?: (row: T) => string | undefined;
  /** Extra attributes for a row (data-* for tests and styling). */
  rowProps?: (row: T) => Record<string, string | number | boolean | undefined>;
  /** Detail shown in a full-width row under a row (return null to show nothing). */
  expanded?: (row: T) => ReactNode;
  testid?: string;
}

const readHidden = (id?: string): string[] | null => {
  if (!id) return null;
  try {
    return JSON.parse(localStorage.getItem(`duckview.table.${id}`) ?? 'null');
  } catch {
    return null;
  }
};

export function DataTable<T>({ rows, columns, rowKey, empty, error, onRetry, search, searchPlaceholder = 'Filter', onRowClick, selected, onSelectedChange, columnPicker, pageSize = 100, initialSort, toolbar, label, density = 'default', className, rowClassName, rowProps, expanded, testid }: Props<T>) {
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<{ key: string; desc: boolean } | null>(initialSort ? { key: initialSort.key, desc: !!initialSort.desc } : null);
  const [limit, setLimit] = useState(pageSize);
  const [hidden, setHidden] = useState<string[]>(() => readHidden(columnPicker) ?? columns.filter((c) => c.defaultHidden).map((c) => c.key));
  const visible = columns.filter((c) => !hidden.includes(c.key));

  const shown = useMemo(() => {
    let out = rows ?? [];
    if (search && q.trim()) {
      const words = q.toLowerCase().split(/\s+/).filter(Boolean);
      out = out.filter((r) => {
        const hay = search(r).toLowerCase();
        return words.every((w) => hay.includes(w));
      });
    }
    const col = sort && columns.find((c) => c.key === sort.key);
    if (col?.sortValue) {
      const v = col.sortValue;
      out = [...out].sort((a, b) => {
        const x = v(a);
        const y = v(b);
        if (x == null && y == null) return 0;
        if (x == null) return 1;
        if (y == null) return -1;
        const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true, sensitivity: 'base' });
        return sort!.desc ? -c : c;
      });
    }
    return out;
  }, [rows, q, sort, columns, search]);

  const toggleSort = (key: string) => setSort((s) => (s?.key !== key ? { key, desc: false } : !s.desc ? { key, desc: true } : null));
  const setHide = (next: string[]) => {
    setHidden(next);
    if (columnPicker) {
      try {
        localStorage.setItem(`duckview.table.${columnPicker}`, JSON.stringify(next));
      } catch {
        /* private mode */
      }
    }
  };
  const keys = shown.map(rowKey);
  const allSelected = !!selected && keys.length > 0 && keys.every((k) => selected.includes(k));
  const hasBar = !!(search || columnPicker || toolbar);
  const compact = density === 'compact';
  const cellY = compact ? 'py-1' : 'py-2';

  return (
    <div className={cn('min-w-0', className)} data-testid={testid}>
      {hasBar && (
        <div className="mb-2 flex flex-wrap items-center gap-2">
          {search && (
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
              <Input uiSize="sm" className="w-56 pl-7" value={q} onChange={(e) => { setQ(e.target.value); setLimit(pageSize); }} placeholder={searchPlaceholder} aria-label={`${searchPlaceholder} ${label}`} />
            </div>
          )}
          {search && q && rows && <span className="text-2xs text-zinc-500">{shown.length} of {rows.length}</span>}
          <div className="ml-auto flex items-center gap-2">
            {toolbar}
            {columnPicker && (
              <Menu width="w-52" trigger={(open, toggle) => <Button size="sm" variant="ghost" onClick={toggle} aria-expanded={open}><Columns3 className="h-3.5 w-3.5" /> Columns</Button>}>
                {() => (
                  <div className="space-y-1 p-1.5" role="group" aria-label="Columns to show">
                    {columns.map((c) => (
                      <Checkbox key={c.key} label={c.header} checked={!hidden.includes(c.key)} onChange={(e) => setHide(e.target.checked ? hidden.filter((h) => h !== c.key) : [...hidden, c.key])} />
                    ))}
                  </div>
                )}
              </Menu>
            )}
          </div>
        </div>
      )}
      {error ? (
        <InlineError error={error} onRetry={onRetry} />
      ) : (
        <div className="overflow-x-auto">
          <table className={cn('w-full text-left', compact ? 'text-xs' : 'text-body')} aria-label={label}>
            <thead className={cn(compact && 'sticky top-0 z-[1] bg-zinc-950')}>
              <tr className="text-xs text-zinc-500">
                {selected && onSelectedChange && (
                  <th scope="col" className="w-7 py-1.5 font-normal">
                    <input type="checkbox" aria-label="Select all" className="accent-[var(--color-accent-500)]" checked={allSelected} onChange={(e) => onSelectedChange(e.target.checked ? [...new Set([...selected, ...keys])] : selected.filter((k) => !keys.includes(k)))} />
                  </th>
                )}
                {visible.map((c) => {
                  const active = sort?.key === c.key;
                  return (
                    <th key={c.key} scope="col" aria-sort={active ? (sort!.desc ? 'descending' : 'ascending') : undefined} className={cn('py-1.5 pr-3 font-normal last:pr-0', c.width, c.align === 'right' && 'text-right', c.responsive)}>
                      {c.sortValue ? (
                        <button className={cn('inline-flex items-center gap-1 hover:text-zinc-200', active && 'text-zinc-200', c.align === 'right' && 'flex-row-reverse')} onClick={() => toggleSort(c.key)}>
                          {c.header}
                          {active && (sort!.desc ? <ArrowDown className="h-3 w-3" /> : <ArrowUp className="h-3 w-3" />)}
                        </button>
                      ) : (
                        c.header
                      )}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {rows === null &&
                Array.from({ length: 4 }, (_, i) => (
                  <tr key={i} className="border-t border-zinc-800/70">
                    {visible.map((c) => <td key={c.key} className="py-2.5 pr-3"><Skeleton className="h-3 w-3/4" /></td>)}
                  </tr>
                ))}
              {shown.slice(0, limit).map((r) => {
                const k = rowKey(r);
                const isSel = selected?.includes(k);
                const detail = expanded?.(r);
                return (
                  <Fragment key={k}>
                  <tr
                    data-row={k}
                    {...rowProps?.(r)}
                    aria-selected={selected ? isSel : undefined}
                    tabIndex={onRowClick ? 0 : undefined}
                    onClick={onRowClick ? () => onRowClick(r) : undefined}
                    onKeyDown={onRowClick ? (e) => { if (e.key === 'Enter' && e.target === e.currentTarget) onRowClick(r); } : undefined}
                    className={cn('border-t border-zinc-800/70 align-middle', onRowClick && 'cursor-pointer hover:bg-zinc-900/60 focus-visible:bg-zinc-900/60', isSel && 'bg-zinc-800/50', rowClassName?.(r))}
                  >
                    {selected && onSelectedChange && (
                      <td className="py-2" onClick={(e) => e.stopPropagation()}>
                        <input type="checkbox" aria-label="Select row" className="accent-[var(--color-accent-500)]" checked={!!isSel} onChange={(e) => onSelectedChange(e.target.checked ? [...selected, k] : selected.filter((x) => x !== k))} />
                      </td>
                    )}
                    {visible.map((c) => (
                      <td key={c.key} className={cn(cellY, 'pr-3 last:pr-0', c.truncate && (c.width ? 'max-w-0 truncate' : 'max-w-[16rem] truncate'), c.width, c.align === 'right' && 'text-right', c.numeric && 'tabular-nums', c.responsive, c.className)}>{c.cell(r)}</td>
                    ))}
                  </tr>
                  {detail != null && detail !== false && (
                    <tr className="border-t border-zinc-800/40">
                      <td colSpan={visible.length + (selected && onSelectedChange ? 1 : 0)} className="pb-2">{detail}</td>
                    </tr>
                  )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          {rows && rows.length === 0 && (empty ?? <Empty title="Nothing to show yet" />)}
          {rows && rows.length > 0 && shown.length === 0 && <p className="py-4 text-center text-xs text-zinc-500">No rows match “{q}”.</p>}
          {shown.length > limit && (
            <div className="border-t border-zinc-800/70 pt-2 text-center">
              <Button size="sm" variant="ghost" onClick={() => setLimit((l) => l + pageSize)}>Show {Math.min(pageSize, shown.length - limit)} more of {shown.length - limit}</Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
