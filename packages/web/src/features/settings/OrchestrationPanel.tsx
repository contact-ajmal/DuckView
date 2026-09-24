import { useEffect, useState } from 'react';
import { CheckCircle2, CircleAlert, Loader2 } from 'lucide-react';
import { api, timeAgo } from '../../api/client';
import { CopyButton, Tabs, cn } from '../../components/ui';

interface OrchestrationRun { id: string; kind: string; target_id: string | null; label: string; status: 'running' | 'succeeded' | 'failed'; summary: string | null; source: string; external_run_id: string | null; started_at: string; finished_at: string | null }
interface Target { kind: string; id: string; name: string }

const SOURCE: Record<string, string> = { airflow: 'Airflow', dagster: 'Dagster', prefect: 'Prefect', api: 'API' };

/** Settings → Orchestration: run syncs, dbt, quality checks … from Airflow, Dagster, Prefect or any HTTP client. */
export function OrchestrationPanel({ workspaceId }: { workspaceId: string }) {
  const [runs, setRuns] = useState<OrchestrationRun[] | null>(null);
  const [targets, setTargets] = useState<Target[]>([]);
  const [tool, setTool] = useState<'airflow' | 'dagster' | 'prefect' | 'http'>('airflow');

  useEffect(() => {
    const load = () => void api.get<{ runs: OrchestrationRun[] }>('/api/orchestrate/runs?limit=30').then((r) => setRuns(r.runs)).catch(() => setRuns([]));
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    const get = <T,>(url: string, pick: (r: T) => Target[]) => api.get<T>(url).then(pick).catch(() => [] as Target[]);
    void Promise.all([
      get<{ syncs: { id: string; name: string }[] }>(`/api/workspaces/${workspaceId}/syncs`, (r) => r.syncs.map((s) => ({ kind: 'sync', id: s.id, name: s.name }))),
      get<{ projects: { id: string; name: string }[] }>(`/api/workspaces/${workspaceId}/dbt/projects`, (r) => (r.projects ?? []).map((s) => ({ kind: 'dbt', id: s.id, name: s.name }))),
      get<{ suites: { id: string; name: string }[] }>(`/api/workspaces/${workspaceId}/quality/suites`, (r) => r.suites.map((s) => ({ kind: 'quality', id: s.id, name: s.name }))),
      get<{ syncs: { id: string; name: string }[] }>(`/api/workspaces/${workspaceId}/reverse-syncs`, (r) => r.syncs.map((s) => ({ kind: 'reverse_sync', id: s.id, name: s.name }))),
    ]).then((all) => setTargets(all.flat()));
  }, [workspaceId]);

  const sync = targets.find((t) => t.kind === 'sync')?.id ?? '<sync id>';
  const dbt = targets.find((t) => t.kind === 'dbt')?.id ?? '<dbt project id>';
  const suite = targets.find((t) => t.kind === 'quality')?.id ?? '<quality suite id>';
  const snippets = {
    airflow: `# pip install "duckview[airflow]" — connection "duckview_default": Host = ${location.origin}, Password = an API token (write scope)
from duckview.airflow import DuckViewSyncOperator, DuckViewDbtOperator, DuckViewQualityCheckOperator

load = DuckViewSyncOperator(task_id="load", sync_id="${sync}")
build = DuckViewDbtOperator(task_id="dbt_build", project_id="${dbt}", command="build")
checks = DuckViewQualityCheckOperator(task_id="checks", suite_id="${suite}")
load >> build >> checks`,
    dagster: `# pip install "duckview[dagster]"
from dagster import Definitions, EnvVar, job
from duckview.dagster import DuckViewResource, duckview_op

load = duckview_op("sync", "${sync}", name="load")
build = duckview_op("dbt", "${dbt}", name="dbt_build", command="build")

@job
def nightly():
    build(start_after=load())

defs = Definitions(jobs=[nightly], resources={"duckview": DuckViewResource(url="${location.origin}", token=EnvVar("DUCKVIEW_TOKEN"))})`,
    prefect: `# pip install "duckview[prefect]" — DUCKVIEW_URL=${location.origin}, DUCKVIEW_TOKEN=<API token>
from prefect import flow
from duckview.prefect import run_sync, run_dbt, run_quality_suite

@flow
def nightly():
    run_sync("${sync}")
    run_dbt("${dbt}", command="build")
    run_quality_suite("${suite}")`,
    http: `# Start (202) and poll; or add "wait": true to answer when done
curl -X POST ${location.origin}/api/orchestrate/runs \\
  -H "Authorization: Bearer $DUCKVIEW_TOKEN" -H "Content-Type: application/json" \\
  -d '{"kind": "sync", "id": "${sync}"}'
curl "${location.origin}/api/orchestrate/runs/<run id>?wait=30" -H "Authorization: Bearer $DUCKVIEW_TOKEN"
# status: running | succeeded | failed`,
  };

  return (
    <div className="space-y-5 text-xs" data-testid="orchestration-panel">
      <p className="text-zinc-400">Run syncs, dbt projects, quality checks, reverse syncs, notebooks, agents and SQL checks from Airflow, Dagster, Prefect or any scheduler, and wait for one status. A failed check fails the task. Use an API token with the write scope (AI → New API token); runs act as its owner.</p>
      <div>
        <Tabs size="sm" value={tool} onChange={setTool} tabs={[{ id: 'airflow', label: 'Airflow' }, { id: 'dagster', label: 'Dagster' }, { id: 'prefect', label: 'Prefect' }, { id: 'http', label: 'HTTP' }]} />
        <div className="relative mt-2">
          <pre className="overflow-auto rounded-md bg-zinc-900 p-3 pr-20 font-mono text-[11.5px] text-zinc-200" data-testid="orchestration-snippet">{snippets[tool]}</pre>
          <div className="absolute right-2 top-2"><CopyButton text={snippets[tool]} /></div>
        </div>
      </div>
      {targets.length > 0 && (
        <div>
          <h3 className="mb-1 text-[13px] font-medium text-zinc-100">What this workspace can run</h3>
          <ul className="divide-y divide-zinc-800/70 rounded-md border border-zinc-800">
            {targets.map((t) => (
              <li key={`${t.kind}:${t.id}`} className="flex items-center gap-2 px-3 py-1.5">
                <span className="w-24 shrink-0 text-zinc-500">{t.kind.replace('_', ' ')}</span>
                <span className="min-w-0 flex-1 truncate text-zinc-200">{t.name}</span>
                <code className="font-mono text-[11px] text-zinc-500">{t.id}</code>
                <CopyButton text={t.id} label="ID" />
              </li>
            ))}
          </ul>
        </div>
      )}
      <div>
        <h3 className="mb-1 text-[13px] font-medium text-zinc-100">Recent runs</h3>
        {runs && runs.length === 0 ? <p className="text-zinc-500">No runs yet.</p> : (
          <table className="w-full table-fixed text-left" data-testid="orchestration-runs">
            <thead className="text-zinc-500"><tr><th className="w-6" /><th className="w-24 py-1 font-normal">From</th><th className="w-24 font-normal">Kind</th><th className="font-normal">What</th><th className="font-normal">Result</th><th className="w-24 text-right font-normal">When</th></tr></thead>
            <tbody>
              {(runs ?? []).map((r) => (
                <tr key={r.id} className="border-t border-zinc-800/70" data-run-status={r.status}>
                  <td className="py-1.5">{r.status === 'running' ? <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-400" /> : r.status === 'succeeded' ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" /> : <CircleAlert className="h-3.5 w-3.5 text-red-400" />}</td>
                  <td className="text-zinc-300" title={r.external_run_id ?? undefined}>{SOURCE[r.source] ?? r.source}</td>
                  <td className="text-zinc-400">{r.kind.replace('_', ' ')}</td>
                  <td className="truncate text-zinc-200" title={r.label}>{r.label}</td>
                  <td className={cn('truncate', r.status === 'failed' ? 'text-red-300' : 'text-zinc-400')} title={r.summary ?? undefined}>{r.summary ?? '…'}</td>
                  <td className="text-right text-zinc-500">{timeAgo(r.started_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
