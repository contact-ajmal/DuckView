/**
 * What an agent task made or found, as native objects: a result table (with its SQL), a dashboard, a notebook, a
 * data app, checks, a model, metrics, a saved query. Each opens in the workspace; SQL opens in a new tab.
 */
import type { ReactNode } from 'react';
import { AppWindow, BookOpenText, Boxes, FileDown, LayoutDashboard, LineChart, ListChecks, Save, Sigma, SquareTerminal, Table2 } from 'lucide-react';
import { ResultPreview } from '../../components/data';
import { Button } from '../../components/ui';
import type { Artifact } from './api';
import { performAction } from './store';

const ICON: Record<string, ReactNode> = {
  table: <Table2 className="h-3.5 w-3.5" />,
  dashboard: <LayoutDashboard className="h-3.5 w-3.5" />,
  chart: <LineChart className="h-3.5 w-3.5" />,
  notebook: <BookOpenText className="h-3.5 w-3.5" />,
  app: <AppWindow className="h-3.5 w-3.5" />,
  quality_suite: <ListChecks className="h-3.5 w-3.5" />,
  dbt_model: <Boxes className="h-3.5 w-3.5" />,
  metric: <Sigma className="h-3.5 w-3.5" />,
  saved_query: <Save className="h-3.5 w-3.5" />,
  file: <FileDown className="h-3.5 w-3.5" />,
  sql: <SquareTerminal className="h-3.5 w-3.5" />,
};
const KIND: Record<string, string> = { dashboard: 'Dashboard', chart: 'Chart', notebook: 'Notebook', app: 'Data app', quality_suite: 'Quality checks', dbt_model: 'dbt model', metric: 'Metrics', saved_query: 'Saved query', file: 'File', sql: 'SQL' };

const openSql = (sql: string, title: string) => performAction({ action: 'open_query', args: { sql, title } });

export function AgentArtifacts({ artifacts }: { artifacts: Artifact[] }) {
  if (!artifacts.length) return null;
  return (
    <div className="space-y-2" data-testid="agent-artifacts">
      {artifacts.map((a) => (a.type === 'table' ? <TableArtifact key={a.id} a={a} /> : <ObjectArtifact key={a.id} a={a} />))}
    </div>
  );
}

function TableArtifact({ a }: { a: Artifact }) {
  const d = (a.data ?? {}) as { sql?: string; columns?: { name: string; type?: string }[]; rows?: unknown[][]; row_count?: number; truncated?: boolean };
  const columns = (d.columns ?? []).map((c) => (typeof c === 'string' ? { name: c } : c));
  return (
    <section className="min-w-0 rounded-md border border-zinc-800" data-testid="agent-artifact" data-type="table">
      <div className="flex items-center gap-2 border-b border-zinc-800 px-2.5 py-1.5">
        <span className="text-zinc-500">{ICON.table}</span>
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-zinc-100">{a.title}</span>
        <span className="shrink-0 text-2xs tabular-nums text-zinc-500">{(d.row_count ?? d.rows?.length ?? 0).toLocaleString()} rows{d.truncated ? ` · first ${d.rows?.length}` : ''}</span>
        {d.sql && <Button size="sm" variant="ghost" onClick={() => openSql(d.sql!, a.title)} data-testid="artifact-open-sql"><SquareTerminal className="h-3.5 w-3.5" /> Open in SQL</Button>}
      </div>
      <ResultPreview columns={columns} rows={d.rows ?? []} maxHeight="max-h-48" label={a.title} className="border-0" />
    </section>
  );
}

function ObjectArtifact({ a }: { a: Artifact }) {
  const sql = typeof a.data?.sql === 'string' ? (a.data.sql as string) : null;
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-md border border-zinc-800 px-2.5 py-1.5" data-testid="agent-artifact" data-type={a.type}>
      <span className="text-accent-400">{ICON[a.type] ?? ICON.sql}</span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-medium text-zinc-100">{a.title}</div>
        <div className="text-2xs text-zinc-500">{KIND[a.type] ?? a.type} · made by the agent</div>
      </div>
      {a.href && <Button size="sm" onClick={() => performAction({ action: 'open', href: a.href })} data-testid="artifact-open">Open</Button>}
      {!a.href && sql && <Button size="sm" variant="ghost" onClick={() => openSql(sql, a.title)}><SquareTerminal className="h-3.5 w-3.5" /> Open in SQL</Button>}
    </div>
  );
}
