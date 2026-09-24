import { useEffect, useState } from 'react';
import { Database, ShieldAlert, ShieldCheck } from 'lucide-react';
import { api } from '../../api/client';
import { useWorkspace } from '../../store/workspace';
import { CopyButton, Tabs, cn } from '../../components/ui';

interface PgWireInfo { enabled: boolean; host: string; port: number; localhost_only: boolean; tls: boolean; require_tls: boolean; user: string; databases: string[] }

/** Settings → SQL clients: connect Tableau, Power BI, Metabase, DBeaver, psql, JDBC and Python to a workspace. */
export function PgWirePanel() {
  const [info, setInfo] = useState<PgWireInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tool, setTool] = useState<'psql' | 'jdbc' | 'python' | 'bi'>('bi');
  const workspace = useWorkspace((s) => s.workspaces.find((w) => w.id === s.activeId)?.name ?? '');
  useEffect(() => void api.get<PgWireInfo>('/api/pgwire').then(setInfo).catch((e) => setError((e as Error).message)), []);
  if (error) return <p className="text-xs text-red-300">{error}</p>;
  if (!info) return null;
  const host = info.localhost_only ? 'localhost' : location.hostname;
  const db = workspace || info.databases[0] || 'duckview';
  const ssl = info.tls ? 'require' : 'disable';
  const snippets = {
    psql: `PGPASSWORD='<your password or an API token>' psql "host=${host} port=${info.port} dbname='${db}' user=${info.user} sslmode=${ssl}"`,
    jdbc: `jdbc:postgresql://${host}:${info.port}/${encodeURIComponent(db)}?sslmode=${ssl}&preferQueryMode=simple\n# user: ${info.user}\n# password: your DuckView password, or an API token (dvk_…)`,
    python: `import os\nimport psycopg\n\nwith psycopg.connect(host="${host}", port=${info.port}, dbname="${db}", user="${info.user}", password=os.environ["DUCKVIEW_TOKEN"], sslmode="${ssl}") as conn:\n    rows = conn.execute("SELECT region, sum(amount) FROM orders GROUP BY 1").fetchall()`,
    bi: `Choose the PostgreSQL connector, then:\n  Server    ${host}\n  Port      ${info.port}\n  Database  ${db}\n  User      ${info.user}\n  Password  your DuckView password, or an API token (AI → New API token)\n  SSL       ${info.tls ? 'required' : 'off'}`,
  };
  return (
    <div className="space-y-4 text-xs" data-testid="pgwire-panel">
      <div className="flex items-start gap-3 rounded-md border border-zinc-800 p-3">
        <Database className="mt-0.5 h-4 w-4 shrink-0 text-zinc-400" />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-body text-zinc-100">
            {info.enabled ? <>Tools that speak PostgreSQL connect to <b>{info.localhost_only ? 'this machine only' : host}</b>, port <b className="font-mono">{info.port}</b>.</> : 'The Postgres protocol listener is off.'}
          </p>
          <p className="text-zinc-400">Every query runs as the person who connects, through the same checks as the SQL workbench: their workspaces and access policies apply, and an API token's scopes too, so a read-only token can only read. Each workspace is a database.</p>
          {!info.enabled && <p className="text-zinc-400">Turn it on with <code className="font-mono text-zinc-200">DUCKVIEW__pgwire__enabled=true</code> (and <code className="font-mono text-zinc-200">DUCKVIEW__pgwire__host=0.0.0.0</code> for other machines, with a TLS certificate).</p>}
        </div>
        {info.enabled && (info.tls ? <span className="flex items-center gap-1 text-emerald-300"><ShieldCheck className="h-3.5 w-3.5" /> TLS{info.require_tls ? ' required' : ''}</span> : <span className={cn('flex items-center gap-1', info.localhost_only ? 'text-zinc-400' : 'text-amber-300')} title="Passwords travel in clear text without TLS"><ShieldAlert className="h-3.5 w-3.5" /> no TLS</span>)}
      </div>
      {info.enabled && (
        <>
          <dl className="grid max-w-xl grid-cols-[8rem_minmax(0,1fr)] gap-y-1.5" data-testid="pgwire-fields">
            {[['Host', host], ['Port', String(info.port)], ['Database', db], ['User', info.user], ['Password', 'your password, or an API token']].map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-zinc-500">{k}</dt>
                <dd className="flex items-center gap-2 font-mono text-zinc-200">{v}{k !== 'Password' && <CopyButton text={v!} />}</dd>
              </div>
            ))}
          </dl>
          <div>
            <Tabs size="sm" value={tool} onChange={setTool} tabs={[{ id: 'bi', label: 'Tableau · Power BI · Metabase' }, { id: 'psql', label: 'psql' }, { id: 'jdbc', label: 'JDBC / DBeaver' }, { id: 'python', label: 'Python' }]} />
            <div className="relative mt-2">
              <pre className="overflow-auto rounded-md bg-zinc-900 p-3 pr-20 font-mono text-xs text-zinc-200" data-testid="pgwire-snippet">{snippets[tool]}</pre>
              <div className="absolute right-2 top-2"><CopyButton text={snippets[tool]} /></div>
            </div>
          </div>
          <p className="text-zinc-500">Databases you can open: {info.databases.join(', ') || 'none'}. SET and BEGIN/COMMIT are accepted but each statement runs on its own.</p>
        </>
      )}
    </div>
  );
}
