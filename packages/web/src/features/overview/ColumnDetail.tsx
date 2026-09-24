/**
 * One column of a dataset, in depth: what it holds (type, completeness, distinct values, range), how its values are
 * distributed, and what to do next (query it, ask about it). Opened from the column lists on the dataset overview.
 */
import { MessageSquareText, SquareTerminal } from 'lucide-react';
import type { OverviewColumn } from '../../api/client';
import { Button, Drawer } from '../../components/ui';
import { TypePill } from '../../components/layout';

const quote = (name: string) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `"${name.replace(/"/g, '""')}"`);

function Distribution({ d }: { d: NonNullable<OverviewColumn['distribution']> }) {
  const bins = d.bins as { label: string; count: number }[];
  const max = Math.max(...bins.map((b) => b.count), 1);
  const vertical = d.kind !== 'categories';
  if (!vertical) {
    return (
      <ul className="space-y-1" aria-label="Most common values">
        {bins.map((b) => (
          <li key={b.label} className="grid grid-cols-[minmax(0,1fr)_7rem_4rem] items-center gap-2 text-xs">
            <span className="truncate font-mono text-zinc-300" title={b.label}>{b.label === '' ? <em className="text-zinc-500">empty</em> : b.label}</span>
            <span className="h-1.5 rounded-full bg-zinc-800"><span className="block h-full rounded-full bg-[color:var(--series-1)]" style={{ width: `${(b.count / max) * 100}%` }} /></span>
            <span className="text-right tabular-nums text-zinc-400">{b.count.toLocaleString()}</span>
          </li>
        ))}
        {d.kind === 'categories' && d.other > 0 && <li className="text-2xs text-zinc-500">and {d.other.toLocaleString()} rows with other values</li>}
      </ul>
    );
  }
  return (
    <div>
      <div className="flex h-28 items-end gap-px" role="img" aria-label={`${d.kind === 'timeline' ? 'Rows over time' : 'Histogram'}: ${bins.length} bins`}>
        {bins.map((b) => (
          <div key={b.label} className="group relative flex-1 rounded-t-sm bg-[color:var(--series-1)] opacity-80 hover:opacity-100" style={{ height: `${Math.max(2, (b.count / max) * 100)}%` }} title={`${b.label}: ${b.count.toLocaleString()}`} />
        ))}
      </div>
      <div className="mt-1 flex justify-between font-mono text-2xs text-zinc-500">
        <span>{bins[0]?.label}</span>
        <span>{bins.at(-1)?.label}</span>
      </div>
    </div>
  );
}

export function ColumnDetail({ column, rowCount, relation, onClose, onQuery, onAsk }: { column: OverviewColumn | null; rowCount: number; relation: string; onClose: () => void; onQuery: (sql: string) => void; onAsk: (column: string) => void }) {
  const c = column;
  const stats: [string, string][] = c
    ? [
        ['Missing', `${c.null_percentage.toFixed(c.null_percentage < 1 && c.null_percentage > 0 ? 2 : 1)}% (${Math.round((c.null_percentage / 100) * rowCount).toLocaleString()} rows)`],
        ['Distinct values', c.approx_unique == null ? '—' : `≈${c.approx_unique.toLocaleString()}`],
        ['Minimum', c.min ?? '—'],
        ['Median', c.q50 ?? '—'],
        ['Maximum', c.max ?? '—'],
        ...(c.avg != null ? [['Mean', Number(c.avg).toLocaleString(undefined, { maximumFractionDigits: 4 })] as [string, string]] : []),
      ]
    : [];
  const col = c ? quote(c.name) : '';
  return (
    <Drawer open={!!c} onClose={onClose} title={c ? <span className="font-mono">{c.name}</span> : ''} width="w-[440px]">
      {c && (
        <div className="space-y-6 p-4" data-testid="column-detail">
          <div className="flex items-center gap-2 text-xs text-zinc-500">
            <TypePill type={c.type} />
            <span>in <code className="font-mono text-zinc-300">{relation}</code></span>
          </div>
          <dl className="grid grid-cols-[8rem_1fr] gap-x-4 gap-y-1.5 text-body">
            {stats.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-zinc-500">{k}</dt>
                <dd className="truncate font-mono text-zinc-200" title={v}>{v}</dd>
              </div>
            ))}
          </dl>
          {c.distribution && c.distribution.bins.length > 0 && (
            <section>
              <h3 className="mb-2 text-xs font-medium text-zinc-400">{c.distribution.kind === 'categories' ? 'Most common values' : c.distribution.kind === 'timeline' ? `Rows per ${c.distribution.unit}` : 'Distribution'}</h3>
              <Distribution d={c.distribution} />
            </section>
          )}
          <div className="flex flex-wrap gap-2 border-t border-zinc-800 pt-4">
            <Button size="sm" onClick={() => onQuery(c.distribution?.kind === 'histogram' ? `SELECT min(${col}), max(${col}), avg(${col}), count(*) FILTER (WHERE ${col} IS NULL) AS missing\nFROM ${relation};` : `SELECT ${col}, count(*) AS rows\nFROM ${relation}\nGROUP BY 1\nORDER BY 2 DESC\nLIMIT 50;`)}>
              <SquareTerminal className="h-3.5 w-3.5" /> Query this column
            </Button>
            <Button size="sm" variant="ghost" onClick={() => onAsk(c.name)}><MessageSquareText className="h-3.5 w-3.5" /> Ask about it</Button>
          </div>
        </div>
      )}
    </Drawer>
  );
}
