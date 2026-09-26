/**
 * A mission's artifacts, drawn natively: results as charts (the dashboards' own chart) with their table and SQL,
 * findings, and the objects the agent made or found — each with a permission-aware "Open in console". A result
 * computed under someone else's access arrives without its rows; "Run as me" runs its SQL under yours.
 */
import { useState, type ReactNode } from 'react';
import { AppWindow, BookOpenText, Boxes, FileDown, LayoutDashboard, LineChart, ListChecks, Lock, Play, Save, Sigma, SquareTerminal, Table2 } from 'lucide-react';
import { ChartFrame, ResultPreview } from '../../../components/data';
import { Button, InlineError, Tabs, cn } from '../../../components/ui';
import type { ColumnSchema, WidgetChartConfig } from '../../../api/client';
import { ChartWidget } from '../../dashboards/widgets';
import { missionApi, type MissionArtifact } from '../api';
import { openInConsole } from '../missions';

const ICON: Record<string, ReactNode> = {
  dashboard: <LayoutDashboard className="h-4 w-4" />,
  chart: <LineChart className="h-4 w-4" />,
  notebook: <BookOpenText className="h-4 w-4" />,
  app: <AppWindow className="h-4 w-4" />,
  quality_suite: <ListChecks className="h-4 w-4" />,
  dbt_model: <Boxes className="h-4 w-4" />,
  metric: <Sigma className="h-4 w-4" />,
  saved_query: <Save className="h-4 w-4" />,
  file: <FileDown className="h-4 w-4" />,
};
const KIND: Record<string, string> = { dashboard: 'Dashboard', chart: 'Chart', notebook: 'Notebook', app: 'Data app', quality_suite: 'Quality checks', dbt_model: 'dbt model', metric: 'Metrics', saved_query: 'Saved query', file: 'File' };
const CONSOLE_LABEL: Record<string, string> = { dashboard: 'Open dashboard', chart: 'Open dashboard', notebook: 'Open notebook', app: 'Open data app', quality_suite: 'Open quality', dbt_model: 'Open dbt model', metric: 'Open metrics', saved_query: 'Open SQL', file: 'Open', table: 'Open SQL' };

const kindOf = (type = ''): ColumnSchema['kind'] => (/INT|DECIMAL|NUMERIC|DOUBLE|FLOAT|REAL|HUGEINT/i.test(type) ? 'number' : /DATE|TIME/i.test(type) ? 'temporal' : /BOOL/i.test(type) ? 'boolean' : 'string');
const columnsOf = (cols: unknown): ColumnSchema[] => ((cols as { name: string; type?: string; kind?: ColumnSchema['kind'] }[] | undefined) ?? []).map((c) => (typeof c === 'string' ? { name: c, type: 'VARCHAR', kind: 'string' } : { name: c.name, type: c.type ?? '', kind: c.kind ?? kindOf(c.type) }));

/** "Open in console", or why not — the server decides (artifact.open), and the console checks again. */
export function ConsoleButton({ artifact, onOpen }: { artifact: MissionArtifact; onOpen: () => void }) {
  const open = artifact.open ?? { allowed: true, reason: null };
  const label = CONSOLE_LABEL[artifact.type] ?? 'Open in console';
  if (!open.allowed) {
    return (
      <span className="inline-flex items-center gap-1 text-2xs text-zinc-500" title={open.reason ?? undefined} data-testid="console-denied">
        <Lock className="h-3 w-3" /> {open.reason ?? 'You cannot open this in the console'}
      </span>
    );
  }
  return (
    <Button size="sm" variant="ghost" onClick={onOpen} title={open.reason ?? undefined} data-testid="console-open">
      <SquareTerminal className="h-3.5 w-3.5" /> {label}
    </Button>
  );
}

export function ResultArtifact({ a, onAsk }: { a: MissionArtifact; onAsk?: (text: string) => void }) {
  const d = (a.data ?? {}) as { sql?: string; columns?: unknown; rows?: unknown[][]; row_count?: number; truncated?: boolean; chart?: { kind: 'bar' | 'line'; x: string; y: string[] } | null; redacted?: boolean };
  const [view, setView] = useState<'chart' | 'table' | 'sql'>(d.chart ? 'chart' : 'table');
  const [rerun, setRerun] = useState<{ columns: ColumnSchema[]; rows: unknown[][] } | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const columns = rerun?.columns ?? columnsOf(d.columns);
  const rows = rerun?.rows ?? d.rows ?? [];
  const runAsMe = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await missionApi.runArtifact(a.id);
      setRerun({ columns: columnsOf(r.columns), rows: r.rows });
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  const hidden = d.redacted && !rerun;
  const chart: WidgetChartConfig | null = d.chart ? { chart: d.chart.kind, x: d.chart.x, y: d.chart.y } : null;
  return (
    <ChartFrame
      title={a.title}
      meta={hidden ? 'hidden' : `${(rerun ? rows.length : d.row_count ?? rows.length).toLocaleString()} row${(d.row_count ?? rows.length) === 1 ? '' : 's'}${d.truncated && !rerun ? ` · first ${rows.length}` : ''}`}
      leading={<Table2 className="h-3.5 w-3.5 text-zinc-500" />}
      actionsVisible
      actions={
        <span className="flex items-center gap-1">
          {!hidden && <Tabs<'chart' | 'table' | 'sql'> size="sm" className="border-b-0" value={view} onChange={setView} tabs={[{ id: 'chart', label: 'Chart', hidden: !chart }, { id: 'table', label: 'Table' }, { id: 'sql', label: 'SQL', hidden: !d.sql }]} />}
          {d.sql && <ConsoleButton artifact={a} onOpen={() => openInConsole({ action: 'open_query', args: { sql: d.sql, title: a.title } })} />}
        </span>
      }
      className="rounded-md border border-zinc-800"
      testid="artifact-result"
    >
      <div className="min-h-0 px-3 pb-3" data-view={view}>
        {hidden ? (
          <div className="flex flex-col items-start gap-2 py-4" data-testid="artifact-redacted">
            <p className="text-xs text-zinc-400">This result was computed under the access of the person who ran it. Run it as yourself to see it under yours.</p>
            <Button size="sm" onClick={() => void runAsMe()} loading={busy} data-testid="artifact-run-as-me"><Play className="h-3.5 w-3.5" /> Run as me</Button>
            {err ? <InlineError error={err} /> : null}
          </div>
        ) : view === 'chart' && chart ? (
          <div className="h-56" data-testid="artifact-chart"><ChartWidget data={{ columns, rows, rowCount: rows.length, totalRows: rows.length, durationMs: 0 }} config={chart} /></div>
        ) : view === 'sql' ? (
          <pre className="max-h-56 overflow-auto rounded-md border border-zinc-800 bg-zinc-950 p-2.5 font-mono text-2xs text-zinc-300">{d.sql}</pre>
        ) : (
          <ResultPreview columns={columns.map((c) => ({ name: c.name, type: c.type }))} rows={rows} maxHeight="max-h-56" label={a.title} testid="artifact-table" />
        )}
        {onAsk && !hidden && <button type="button" className="mt-2 text-2xs text-zinc-500 hover:text-zinc-200" onClick={() => onAsk(`About "${a.title}": `)}>Ask about this result</button>}
      </div>
    </ChartFrame>
  );
}

export function ObjectArtifact({ a }: { a: MissionArtifact }) {
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-md border border-zinc-800 px-3 py-2.5" data-testid="artifact-object" data-type={a.type}>
      <span className="text-accent-400">{ICON[a.type] ?? <Table2 className="h-4 w-4" />}</span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-medium text-zinc-100">{a.title}</div>
        <div className="text-2xs text-zinc-500">{KIND[a.type] ?? a.type} · made by the agent</div>
      </div>
      {(a.href || typeof a.data?.sql === 'string') && <ConsoleButton artifact={a} onOpen={() => (a.href ? openInConsole({ action: 'open', href: a.href }) : openInConsole({ action: 'open_query', args: { sql: a.data!.sql, title: a.title } }))} />}
    </div>
  );
}

export function Findings({ items, className }: { items: string[]; className?: string }) {
  if (!items.length) return null;
  return (
    <section className={cn('rounded-md border border-zinc-800 px-4 py-3', className)} aria-label="Key findings" data-testid="artifact-findings">
      <h3 className="mb-1.5 text-xs font-semibold text-zinc-200">Key findings</h3>
      <ul className="space-y-1">
        {items.map((f, i) => (
          <li key={i} className="flex gap-2 text-body text-zinc-200"><span className="mt-2 h-1 w-1 shrink-0 rounded-full bg-zinc-500" aria-hidden /><span className="min-w-0">{f.replace(/\*\*/g, '')}</span></li>
        ))}
      </ul>
    </section>
  );
}
