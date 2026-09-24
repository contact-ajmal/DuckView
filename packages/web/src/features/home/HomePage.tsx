import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { SquareTerminal, Database, LayoutDashboard, LayoutTemplate, Sparkles, FileText, Table2, ArrowUpRight } from 'lucide-react';
import { api, formatBytes, timeAgo, storageKindOf, type Dashboard, type Insight, type SavedQuery, type SystemInfo } from '../../api/client';
import { InsightCard } from '../transform/MonitorsPanel';
import { useWorkspace } from '../../store/workspace';
import { useCopilot } from '../../store/copilot';
import { useAuth } from '../../store/auth';
import { Button, StatusDot, cn } from '../../components/ui';

/** The first table or file a statement reads, for the "dataset" column. */
function datasetOf(sql: string): string | null {
  const m = /\bfrom\s+('([^']+)'|"([^"]+)"|([\w.]+))/i.exec(sql);
  return m ? (m[2] ?? m[3] ?? m[4] ?? null) : null;
}

function Section({ title, action, children, className }: { title: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn('min-w-0', className)}>
      <div className="mb-1.5 flex h-7 items-center justify-between">
        <h2 className="text-body font-semibold text-zinc-100">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function SeeAll({ href, children = 'View all' }: { href: string; children?: ReactNode }) {
  return <a href={href} className="inline-flex items-center gap-0.5 text-xs text-zinc-500 hover:text-zinc-200">{children} <ArrowUpRight className="h-3 w-3" /></a>;
}

function Quiet({ children }: { children: ReactNode }) {
  return <div className="border-y border-zinc-800 py-6 text-center text-xs text-zinc-500">{children}</div>;
}

/** Home: what you have been working on, and whether the workspace is healthy. */
export function HomePage({ onNewWorkspace }: { onNewWorkspace: () => void }) {
  const ws = useWorkspace();
  const cp = useCopilot();
  const user = useAuth((a) => a.user);
  const active = ws.workspaces.find((w) => w.id === ws.activeId);
  const [dashboards, setDashboards] = useState<Dashboard[] | null>(null);
  const [saved, setSaved] = useState<SavedQuery[]>([]);
  const [sys, setSys] = useState<SystemInfo | null>(null);
  const [sources, setSources] = useState<{ total: number; failing: number } | null>(null);
  const [insights, setInsights] = useState<Insight[]>([]);

  useEffect(() => {
    if (!ws.activeId) return;
    void api.get<{ dashboards: Dashboard[] }>(`/api/workspaces/${ws.activeId}/dashboards`).then((r) => setDashboards(r.dashboards)).catch(() => setDashboards([]));
    void api.get<{ queries: SavedQuery[] }>(`/api/workspaces/${ws.activeId}/queries`).then((r) => setSaved(r.queries)).catch(() => setSaved([]));
    void api.get<{ insights: Insight[] }>(`/api/workspaces/${ws.activeId}/insights?status=new&limit=4`).then((r) => setInsights(r.insights)).catch(() => setInsights([]));
    if (!ws.catalog) void ws.loadCatalog();
  }, [ws.activeId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    void api.get<SystemInfo>('/api/system').then(setSys).catch(() => undefined);
    void api
      .get<{ cloud: { last_test_ok?: boolean | null }[]; lakehouse: { status?: string }[]; databases: { last_test_ok?: boolean | null; status?: string }[]; http: unknown[]; connectors: { status?: string }[] }>('/api/sources')
      .then((s) => {
        const all = [...s.cloud, ...s.lakehouse, ...s.databases, ...s.http, ...s.connectors] as { status?: string; last_test_ok?: boolean | null }[];
        setSources({ total: all.length, failing: all.filter((c) => c.status === 'error' || c.last_test_ok === false).length });
      })
      .catch(() => setSources(null));
  }, []);

  // Recent queries: what ran in this browser, newest first, then saved queries not run lately.
  const recentQueries = useMemo(() => {
    const seen = new Set<string>();
    const rows: { key: string; name: string; sql: string; dataset: string | null; when: string; status: 'ok' | 'error' | 'saved'; open: () => void }[] = [];
    for (const h of ws.history) {
      const key = h.sql.trim();
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ key: h.id, name: h.tabTitle || 'Query', sql: h.sql, dataset: datasetOf(h.sql), when: h.at, status: h.status, open: () => { void ws.addTab({ title: h.tabTitle || 'Query', sql: h.sql }); location.hash = '#/query'; } });
    }
    for (const q of [...saved].sort((a, b) => b.updated_at.localeCompare(a.updated_at))) {
      if (seen.has(q.sql_text.trim())) continue;
      rows.push({ key: q.id, name: q.name, sql: q.sql_text, dataset: datasetOf(q.sql_text), when: q.updated_at, status: 'saved', open: () => { void ws.addTab({ title: q.name, sql: q.sql_text }); location.hash = '#/query'; } });
    }
    return rows.slice(0, 7);
  }, [ws.history, saved]); // eslint-disable-line react-hooks/exhaustive-deps

  const datasets = useMemo(() => {
    const files = (ws.catalog?.files ?? []).map((f) => ({ key: `f:${f.path}`, name: f.path, kind: 'file' as const, source: f.kind, rows: null as number | null, size: f.size_bytes, updated: f.modified_at }));
    const tables = (ws.catalog?.objects ?? []).map((o) => ({ key: `t:${o.schema}.${o.name}`, name: o.schema === 'main' ? o.name : `${o.schema}.${o.name}`, kind: 'table' as const, source: o.type === 'VIEW' ? 'view' : 'table', rows: o.estimated_rows, size: null as number | null, updated: null as string | null }));
    return [...files.sort((a, b) => (b.updated ?? '').localeCompare(a.updated ?? '')), ...tables].slice(0, 8);
  }, [ws.catalog]);

  const openDataset = (name: string) => {
    if (ws.activeId) ws.setOverviewTarget(ws.activeId, name);
    location.hash = '#/data';
  };
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const firstName = (user?.display_name ?? user?.email ?? '').split(/[\s@.]/)[0];

  if (!active) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <div className="text-title font-semibold text-zinc-100">No workspace yet</div>
          <p className="mt-1 text-xs text-zinc-500">A workspace holds a DuckDB database, its files, queries and dashboards.</p>
          <Button variant="primary" className="mt-3" onClick={onNewWorkspace}>Create a workspace</Button>
        </div>
      </div>
    );
  }

  const kind = storageKindOf(active.active_db_path);
  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-[1180px] px-6 pb-12 pt-6">
        <div className="flex flex-wrap items-end justify-between gap-4 border-b border-zinc-800 pb-5">
          <div className="min-w-0">
            <h1 className="text-page font-semibold tracking-tight text-zinc-50">{greeting}{firstName ? `, ${firstName[0]!.toUpperCase()}${firstName.slice(1)}` : ''}</h1>
            <p className="mt-0.5 text-xs text-zinc-500">
              {active.name} · {(ws.catalog?.files.length ?? 0) + (ws.catalog?.objects.length ?? 0)} datasets · {dashboards?.length ?? 0} dashboards
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2" data-testid="home-actions">
            <Button variant="primary" onClick={() => { void ws.addTab(); location.hash = '#/query'; }}><SquareTerminal className="h-3.5 w-3.5" /> New SQL</Button>
            <Button onClick={() => (location.hash = '#/data')}><Database className="h-3.5 w-3.5" /> Open data</Button>
            <Button onClick={() => (location.hash = '#/dashboards?new=1')}><LayoutDashboard className="h-3.5 w-3.5" /> Create dashboard</Button>
            <Button onClick={() => cp.toggle(true)}><Sparkles className="h-3.5 w-3.5" /> Ask AI</Button>
            <Button onClick={() => (location.hash = '#/templates')}><LayoutTemplate className="h-3.5 w-3.5" /> Templates</Button>
          </div>
        </div>

        <div className="mt-6 grid gap-x-10 gap-y-8 @4xl:grid-cols-[minmax(0,1fr)_300px]">
          <div className="min-w-0 space-y-8">
            {insights.length > 0 && ws.activeId && (
              <Section title="What changed" action={<SeeAll href="#/transform/metrics?view=monitors">All insights</SeeAll>}>
                <div className="grid gap-2 @2xl:grid-cols-2" data-testid="home-insights">
                  {insights.slice(0, 4).map((i) => <InsightCard key={i.id} workspaceId={ws.activeId!} item={i} />)}
                </div>
              </Section>
            )}
            <Section title="Recent queries" action={<SeeAll href="#/query">Open SQL</SeeAll>}>
              {recentQueries.length === 0 ? (
                <Quiet>Queries you run and save appear here.</Quiet>
              ) : (
                <table className="w-full table-fixed text-body">
                  <thead>
                    <tr className="border-b border-zinc-800 text-left text-xs text-zinc-500">
                      <th className="py-1.5 pr-3 font-normal">Query</th>
                      <th className="w-[26%] py-1.5 pr-3 font-normal @max-3xl:hidden">Dataset</th>
                      <th className="w-24 py-1.5 pr-3 font-normal">Last used</th>
                      <th className="w-20 py-1.5 font-normal">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentQueries.map((q) => (
                      <tr key={q.key} onClick={q.open} className="cursor-pointer border-b border-zinc-800/70 hover:bg-zinc-900" title="Open in a SQL tab">
                        <td className="py-2 pr-3">
                          <div className="truncate text-zinc-100">{q.name}</div>
                          <div className="truncate font-mono text-2xs text-zinc-500">{q.sql.replace(/\s+/g, ' ').slice(0, 120)}</div>
                        </td>
                        <td className="truncate py-2 pr-3 font-mono text-xs text-zinc-400 @max-3xl:hidden">{q.dataset ?? '—'}</td>
                        <td className="py-2 pr-3 text-xs text-zinc-500">{timeAgo(q.when)}</td>
                        <td className="py-2"><StatusDot tone={q.status === 'ok' ? 'ok' : q.status === 'error' ? 'error' : 'idle'}>{q.status === 'saved' ? 'saved' : q.status === 'ok' ? 'ran' : 'failed'}</StatusDot></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Section>

            <Section title="Recent datasets" action={<SeeAll href="#/data">Open data</SeeAll>}>
              {datasets.length === 0 ? (
                <Quiet>
                  Drop a CSV, Parquet or JSON file in <a className="text-accent-300 hover:underline" href="#/data">Data</a>, or <a className="text-accent-300 hover:underline" href="#/connections">connect a source</a>.
                </Quiet>
              ) : (
                <table className="w-full table-fixed text-body">
                  <thead>
                    <tr className="border-b border-zinc-800 text-left text-xs text-zinc-500">
                      <th className="py-1.5 pr-3 font-normal">Dataset</th>
                      <th className="w-24 py-1.5 pr-3 font-normal">Source</th>
                      <th className="w-28 py-1.5 pr-3 text-right font-normal">Rows / size</th>
                      <th className="w-24 py-1.5 font-normal">Updated</th>
                    </tr>
                  </thead>
                  <tbody>
                    {datasets.map((d) => (
                      <tr key={d.key} onClick={() => openDataset(d.name)} className="cursor-pointer border-b border-zinc-800/70 hover:bg-zinc-900" title="Open in Data">
                        <td className="py-2 pr-3">
                          <span className="flex min-w-0 items-center gap-2">
                            {d.kind === 'file' ? <FileText className="h-3.5 w-3.5 shrink-0 text-zinc-500" /> : <Table2 className="h-3.5 w-3.5 shrink-0 text-zinc-500" />}
                            <span className="truncate font-mono text-xs text-zinc-100">{d.name}</span>
                          </span>
                        </td>
                        <td className="truncate py-2 pr-3 text-xs text-zinc-400">{d.source}</td>
                        <td className="py-2 pr-3 text-right font-mono text-xs tabular-nums text-zinc-400">{d.rows != null ? d.rows.toLocaleString() : d.size != null ? formatBytes(d.size) : '—'}</td>
                        <td className="py-2 text-xs text-zinc-500">{d.updated ? timeAgo(d.updated) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Section>
          </div>

          <div className="space-y-8">
            <Section title="Workspace status">
              <dl className="divide-y divide-zinc-800/70 border-y border-zinc-800 text-body">
                {[
                  { k: 'DuckDB', v: sys ? `v${sys.duckdb.version.replace(/^v/, '')} · ${sys.duckdb.threads} threads` : '…', tone: sys ? 'ok' : 'idle' },
                  { k: 'Storage', v: kind === 'memory' ? 'in memory (not saved)' : kind === 'cloud' ? (active.cloud_sync?.last_error ? 'cloud · sync error' : active.cloud_sync?.dirty ? 'cloud · pending sync' : 'cloud · synced') : active.active_db_path.split('/').pop()!, tone: kind === 'memory' || active.cloud_sync?.dirty ? 'warn' : active.cloud_sync?.last_error ? 'error' : 'ok' },
                  { k: 'Connections', v: sources == null ? '…' : sources.total === 0 ? 'none yet' : sources.failing ? `${sources.failing} of ${sources.total} failing` : `${sources.total} connected`, tone: sources == null || sources.total === 0 ? 'idle' : sources.failing ? 'error' : 'ok' },
                  { k: 'Server', v: sys ? `DuckView ${sys.server.version} · up ${Math.round(sys.server.uptime_s / 3600)} h` : '…', tone: sys ? 'ok' : 'idle' },
                ].map((r) => (
                  <div key={r.k} className="flex items-center justify-between gap-3 py-2">
                    <dt className="text-zinc-500">{r.k}</dt>
                    <dd className="min-w-0"><StatusDot tone={r.tone as 'ok'} className="max-w-full truncate text-body text-zinc-200">{r.v}</StatusDot></dd>
                  </div>
                ))}
              </dl>
            </Section>

            <Section title="Recent dashboards" action={<SeeAll href="#/dashboards" />}>
              {dashboards === null ? null : dashboards.length === 0 ? (
                <Quiet>No dashboards yet.</Quiet>
              ) : (
                <ul className="divide-y divide-zinc-800/70 border-y border-zinc-800">
                  {[...dashboards].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 6).map((d) => (
                    <li key={d.id}>
                      <a href={`#/dashboards/${d.id}`} className="flex items-center gap-2 py-2 hover:bg-zinc-900">
                        <LayoutDashboard className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
                        <span className="min-w-0 flex-1 truncate text-body text-zinc-100">{d.name.replace(/^\p{Extended_Pictographic}\s*/u, '')}</span>
                        <span className="shrink-0 text-xs text-zinc-500">{timeAgo(d.updated_at)}</span>
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          </div>
        </div>
      </div>
    </div>
  );
}
