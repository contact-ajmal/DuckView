import { useState } from 'react';
import { Button, Empty, Spinner } from '../../components/ui';
import { GitBranch } from 'lucide-react';

export interface PlanNode { name: string; extra_info?: Record<string, unknown>; children?: PlanNode[] }
export interface PlanResult { format: 'json' | 'text'; plan: PlanNode[] | PlanNode | null; text: string }

function Node({ n, depth }: { n: PlanNode; depth: number }) {
  const [open, setOpen] = useState(depth < 6);
  const info = n.extra_info ?? {};
  const card = info['Estimated Cardinality'] ?? info['estimated_cardinality'];
  const timing = info['Timing'] ?? info['timing'];
  const keys = Object.keys(info).filter((k) => !['Estimated Cardinality', 'estimated_cardinality', 'Timing', 'timing'].includes(k));
  return (
    <div className={depth > 0 ? 'plan-node ml-6' : ''}>
      <button className="my-1 flex w-full items-start gap-2 rounded-md border border-zinc-800 bg-zinc-900/70 px-3 py-2 text-left hover:border-zinc-700" onClick={() => setOpen(!open)}>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs font-semibold text-accent-300">{n.name}</span>
            {card != null && <span className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-2xs text-zinc-300">~{Number(card).toLocaleString()} rows</span>}
            {timing != null && <span className="rounded bg-emerald-900/40 px-1.5 py-0.5 font-mono text-2xs text-emerald-300">{Number(timing).toFixed(4)}s</span>}
          </div>
          {open && keys.length > 0 && (
            <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono text-2xs text-zinc-400">
              {keys.map((k) => (
                <div key={k} className="contents">
                  <dt className="text-zinc-500">{k}</dt>
                  <dd className="truncate text-zinc-300" title={String(info[k])}>
                    {String(info[k]).replace(/\n/g, ' ')}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      </button>
      {open && (n.children ?? []).map((c, i) => <Node key={i} n={c} depth={depth + 1} />)}
    </div>
  );
}

export function PlanView({ plan, loading, onExplain, onAnalyze }: { plan: PlanResult | null; loading: boolean; onExplain: () => void; onAnalyze: () => void }) {
  const [mode, setMode] = useState<'tree' | 'text'>('tree');
  const roots = plan?.plan ? (Array.isArray(plan.plan) ? plan.plan : [plan.plan]) : [];
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2">
        <Button size="sm" variant="primary" onClick={onExplain} loading={loading}>
          Explain
        </Button>
        <Button size="sm" onClick={onAnalyze} loading={loading} title="Executes the query to capture real operator timings">
          Explain analyze
        </Button>
        <div className="ml-auto flex rounded-md border border-zinc-800 p-0.5 text-xs">
          {(['tree', 'text'] as const).map((m) => (
            <button key={m} onClick={() => setMode(m)} className={`rounded px-2 py-0.5 ${mode === m ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500'}`}>
              {m}
            </button>
          ))}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {loading && !plan ? (
          <div className="flex h-full items-center justify-center">
            <Spinner />
          </div>
        ) : !plan ? (
          <Empty icon={<GitBranch className="h-8 w-8" />} title="No plan yet" hint="Explain the current tab's SQL to see the physical operator tree with cardinality estimates." />
        ) : mode === 'text' || !roots.length ? (
          <pre className="font-mono text-2xs leading-4 text-zinc-300">{plan.text}</pre>
        ) : (
          roots.map((r, i) => <Node key={i} n={r} depth={0} />)
        )}
      </div>
    </div>
  );
}
