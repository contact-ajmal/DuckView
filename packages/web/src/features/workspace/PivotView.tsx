/**
 * Pivot the tab's result: rows grouped by one or two columns, one column spread across the top, and a value
 * aggregated in each cell — DuckDB's PIVOT over the tab's SQL. At most 40 column headings (the most frequent
 * values). "Open as SQL" puts the PIVOT statement in a new tab.
 */
import { useEffect, useState } from 'react';
import { Grid3X3, SquareTerminal } from 'lucide-react';
import { api, type QueryResult } from '../../api/client';
import { ResultPreview } from '../../components/data';
import { Button, Empty, Field, InlineError, Select, Skeleton } from '../../components/ui';

const MAX_HEADINGS = 40;
const AGGS = ['sum', 'count', 'avg', 'min', 'max'] as const;
type Agg = (typeof AGGS)[number];
const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;
const lit = (v: unknown) => (v == null ? 'NULL' : typeof v === 'number' || typeof v === 'boolean' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const stripSemi = (sql: string) => sql.trim().replace(/;+\s*$/, '');

export function PivotView({ workspaceId, sql, columns, onOpenSql }: { workspaceId: string; sql: string; columns: { name: string; type: string }[]; onOpenSql: (sql: string) => void }) {
  const numeric = columns.filter((c) => /INT|DOUBLE|FLOAT|DECIMAL|NUMERIC|REAL|HUGEINT/i.test(c.type));
  const text = columns.filter((c) => !numeric.includes(c));
  const [rows1, setRows1] = useState(text[0]?.name ?? columns[0]?.name ?? '');
  const [rows2, setRows2] = useState('');
  const [on, setOn] = useState(text[1]?.name ?? '');
  const [value, setValue] = useState(numeric[0]?.name ?? '');
  const [agg, setAgg] = useState<Agg>(numeric.length ? 'sum' : 'count');
  const [result, setResult] = useState<QueryResult | null>(null);
  const [pivotSql, setPivotSql] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const ready = !!sql.trim() && !!rows1 && !!on && on !== rows1 && on !== rows2 && (agg === 'count' || !!value);

  const build = async () => {
    const src = `(${stripSemi(sql)})`;
    // Too many distinct headings make an unreadable table: keep the most frequent ones.
    const top = await api.post<QueryResult>(`/api/workspaces/${workspaceId}/query`, { sql: `SELECT ${ident(on)} AS v, count(*) AS n FROM ${src} AS _src GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT ${MAX_HEADINGS + 1}`, max_rows: MAX_HEADINGS + 1 });
    const values = top.rows.map((r) => r[0]);
    const capped = values.length > MAX_HEADINGS;
    const inList = capped ? ` IN (${values.slice(0, MAX_HEADINGS).map(lit).join(', ')})` : '';
    const measure = agg === 'count' ? (value ? `count(${ident(value)})` : 'count(*)') : `${agg}(${ident(value)})`;
    const groupBy = [rows1, rows2].filter(Boolean).map(ident).join(', ');
    return { text: `PIVOT (${stripSemi(sql)})\nON ${ident(on)}${inList}\nUSING ${measure}\nGROUP BY ${groupBy}\nORDER BY ${groupBy}`, capped };
  };
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const p = await build();
      setPivotSql(p.text);
      setNote(p.capped ? `Showing the ${MAX_HEADINGS} most frequent values of ${on} as columns.` : null);
      setResult(await api.post<QueryResult>(`/api/workspaces/${workspaceId}/query`, { sql: p.text, max_rows: 2000 }));
    } catch (e) {
      setError(e);
      setResult(null);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    setResult(null);
  }, [sql]);

  if (!columns.length) return <Empty icon={<Grid3X3 className="h-8 w-8" />} title="Run a query to pivot it" hint="Pivot spreads one column's values across the top and aggregates another in each cell." />;
  const pick = (id: string, label: string, v: string, set: (x: string) => void, opts: { name: string }[], optional = false) => (
    <Field label={label} htmlFor={id}>
      <Select id={id} uiSize="sm" value={v} onChange={(e) => set(e.target.value)} data-testid={id}>
        {optional && <option value="">None</option>}
        {opts.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
      </Select>
    </Field>
  );
  return (
    <div className="flex h-full flex-col" data-testid="pivot-view">
      <div className="flex flex-wrap items-end gap-2 border-b border-zinc-800 px-3 py-2">
        {pick('pivot-rows', 'Rows', rows1, setRows1, columns)}
        {pick('pivot-rows2', 'Then by', rows2, setRows2, columns.filter((c) => c.name !== rows1), true)}
        {pick('pivot-on', 'Columns', on, setOn, columns.filter((c) => c.name !== rows1 && c.name !== rows2))}
        <Field label="Value" htmlFor="pivot-agg">
          <span className="flex gap-1">
            <Select id="pivot-agg" uiSize="sm" value={agg} onChange={(e) => setAgg(e.target.value as Agg)} data-testid="pivot-agg">
              {AGGS.map((a) => <option key={a} value={a}>{a}</option>)}
            </Select>
            <Select uiSize="sm" aria-label="Value column" value={value} onChange={(e) => setValue(e.target.value)} data-testid="pivot-value">
              {agg === 'count' && <option value="">rows</option>}
              {(agg === 'count' ? columns : numeric).map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
            </Select>
          </span>
        </Field>
        <Button size="sm" variant="primary" onClick={() => void run()} loading={busy} disabled={!ready} data-testid="pivot-run">Pivot</Button>
        {pivotSql && <Button size="sm" variant="ghost" onClick={() => onOpenSql(pivotSql)} title="Open the PIVOT statement in a new tab"><SquareTerminal className="h-3.5 w-3.5" /> Open as SQL</Button>}
        {!ready && columns.length > 1 && <span className="pb-1 text-2xs text-zinc-500">Choose different columns for rows and headings.</span>}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {error != null && <InlineError error={error} onRetry={() => void run()} />}
        {busy && !result && <Skeleton lines={6} />}
        {!busy && !result && !error && <p className="text-xs text-zinc-500">Choose the rows, the column to spread across the top and the value, then Pivot.</p>}
        {result && (
          <>
            {note && <p className="mb-2 text-2xs text-zinc-500">{note}</p>}
            <ResultPreview columns={result.columns.map((c) => ({ name: c.name, type: c.type }))} rows={result.rows} limit={2000} maxHeight="max-h-none" testid="pivot-result" label="Pivot table" />
            {result.truncated && <p className="mt-2 text-2xs text-zinc-500">Showing the first {result.rows.length.toLocaleString()} rows.</p>}
          </>
        )}
      </div>
    </div>
  );
}
