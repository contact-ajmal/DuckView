/**
 * ResultPreview — a few rows of a query result, inline (a sync preview, a stream's latest rows, a check's failing
 * rows, an agent's answer). Compact and read-only; the SQL workbench's ResultsGrid is the full-size version.
 */
import { cn } from '../ui';

type Col = string | { name: string; type?: string };
type Row = unknown[] | Record<string, unknown>;

/** One value as text: NULL is shown (never blank), objects as JSON. */
export function formatValue(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isInteger(v) ? v.toLocaleString() : String(v);
  if (typeof v === 'bigint') return v.toLocaleString();
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export function ResultPreview({ columns, rows, limit = 200, className, maxHeight = 'max-h-64', showTypes, format, testid, label = 'Result preview' }: { columns: Col[]; rows: Row[]; limit?: number; className?: string; maxHeight?: string; showTypes?: boolean; format?: (v: unknown) => string; testid?: string; label?: string }) {
  const cols = columns.map((c) => (typeof c === 'string' ? { name: c } : c));
  const cellsOf = (r: Row): unknown[] => (Array.isArray(r) ? r : cols.map((c) => (r as Record<string, unknown>)[c.name]));
  const fmt = format ?? formatValue;
  return (
    <div className={cn('overflow-auto rounded-md border border-zinc-800', maxHeight, className)} data-testid={testid}>
      <table className="w-full text-left font-mono text-2xs" aria-label={label}>
        <thead className="sticky top-0 bg-zinc-900">
          <tr>
            {cols.map((c) => (
              <th key={c.name} scope="col" className="whitespace-nowrap px-2 py-1 font-normal text-zinc-400">
                {c.name}
                {showTypes && c.type && <span className="ml-1 text-zinc-500">{c.type.toLowerCase()}</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, limit).map((r, i) => (
            <tr key={i} className="border-t border-zinc-800/70">
              {cellsOf(r).map((v, j) => (
                <td key={j} title={typeof v === 'string' && v.length > 40 ? v : undefined} className={cn('max-w-[16rem] truncate whitespace-nowrap px-2 py-1', v == null ? 'italic text-zinc-500' : typeof v === 'number' || typeof v === 'bigint' ? 'text-right tabular-nums text-zinc-200' : 'text-zinc-300')}>
                  {fmt(v)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > limit && <div className="border-t border-zinc-800/70 px-2 py-1 text-2xs text-zinc-500">{rows.length - limit} more rows not shown</div>}
    </div>
  );
}
