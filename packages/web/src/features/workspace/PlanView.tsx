/**
 * The query plan as a tree. Explain shows the operators with their estimated rows; Explain analyze runs the query
 * and adds what each operator really cost: its share of the time (a bar), the rows it produced against the
 * estimate (flagged when they are far apart) and the rows it scanned, with the slowest step called out.
 */
import { useMemo, useState } from 'react';
import { GitBranch, Timer } from 'lucide-react';
import { formatBytes } from '../../api/client';
import { Button, Empty, Spinner, Tabs, cn } from '../../components/ui';

export interface PlanNode { name: string; extra_info?: Record<string, unknown>; children?: PlanNode[] }
export interface PlanResult { format: 'json' | 'text'; plan: PlanNode[] | PlanNode | null; text: string; summary?: { latency_s: number | null; rows_scanned: number | null; peak_memory_bytes: number | null } }

const num = (v: unknown) => (v == null || v === '' ? null : Number(String(v).replace(/[^\d.eE-]/g, '')));
const timingOf = (n: PlanNode) => num(n.extra_info?.Timing ?? n.extra_info?.timing) ?? 0;
const ms = (s: number) => (s * 1000 < 1 ? '<1 ms' : s < 1 ? `${(s * 1000).toFixed(1)} ms` : `${s.toFixed(2)} s`);
const SHOWN = new Set(['Timing', 'timing', 'Estimated Cardinality', 'estimated_cardinality', 'Actual Rows', 'Rows Scanned']);

function walk(nodes: PlanNode[], fn: (n: PlanNode) => void) {
  for (const n of nodes) {
    fn(n);
    walk(n.children ?? [], fn);
  }
}

function Node({ n, depth, total, slowest }: { n: PlanNode; depth: number; total: number; slowest: PlanNode | null }) {
  const [open, setOpen] = useState(depth < 8);
  const info = n.extra_info ?? {};
  const est = num(info['Estimated Cardinality'] ?? info['estimated_cardinality']);
  const actual = num(info['Actual Rows']);
  const scanned = num(info['Rows Scanned']);
  const t = timingOf(n);
  const share = total > 0 ? t / total : 0;
  const off = est != null && actual != null && Math.max(est, actual) >= 1000 && Math.max(est, actual) / Math.max(1, Math.min(est, actual)) >= 10;
  const keys = Object.keys(info).filter((k) => !SHOWN.has(k));
  const isSlowest = slowest === n && share >= 0.2;
  return (
    <div className={depth > 0 ? 'plan-node ml-6' : ''}>
      <button className={cn('my-1 flex w-full items-start gap-2 rounded-md border px-3 py-2 text-left', isSlowest ? 'border-amber-500/70 bg-amber-500/10' : 'border-zinc-800 bg-zinc-900/70 hover:border-zinc-700')} onClick={() => setOpen(!open)} aria-expanded={open} data-testid="plan-node" data-name={n.name}>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-mono text-xs font-semibold text-accent-300">{n.name}</span>
            {total > 0 && <span className="tabular-nums text-2xs text-zinc-300">{ms(t)} · {Math.round(share * 100)}%</span>}
            {actual != null && <span className="font-mono text-2xs text-zinc-300">{actual.toLocaleString()} rows</span>}
            {est != null && <span className="font-mono text-2xs text-zinc-500">{actual != null ? `estimated ${est.toLocaleString()}` : `~${est.toLocaleString()} rows`}</span>}
            {scanned != null && <span className="font-mono text-2xs text-zinc-500">{scanned.toLocaleString()} scanned</span>}
            {isSlowest && <span className="text-2xs font-medium text-amber-300">Slowest step</span>}
            {off && <span className="text-2xs text-amber-300" title="The planner's estimate was more than 10 times off; statistics or a filter it cannot see through may be the cause">Estimate far off</span>}
          </div>
          {total > 0 && (
            <div className="mt-1.5 h-1 rounded-full bg-zinc-800" aria-hidden>
              <div className={cn('h-full rounded-full', isSlowest ? 'bg-amber-500' : 'bg-[color:var(--series-1)]')} style={{ width: `${Math.max(share * 100, share > 0 ? 1 : 0)}%` }} />
            </div>
          )}
          {open && keys.length > 0 && (
            <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono text-2xs text-zinc-400">
              {keys.map((k) => (
                <div key={k} className="contents">
                  <dt className="text-zinc-500">{k}</dt>
                  <dd className="truncate text-zinc-300" title={String(info[k])}>{String(info[k]).replace(/\n/g, ' ')}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      </button>
      {open && (n.children ?? []).map((c, i) => <Node key={i} n={c} depth={depth + 1} total={total} slowest={slowest} />)}
    </div>
  );
}

export function PlanView({ plan, loading, onExplain, onAnalyze }: { plan: PlanResult | null; loading: boolean; onExplain: () => void; onAnalyze: () => void }) {
  const [mode, setMode] = useState<'tree' | 'text'>('tree');
  const roots = useMemo(() => (plan?.plan ? (Array.isArray(plan.plan) ? plan.plan : [plan.plan]) : []), [plan]);
  const { total, slowest } = useMemo(() => {
    let sum = 0;
    let top: PlanNode | null = null;
    walk(roots, (n) => {
      const t = timingOf(n);
      sum += t;
      if (!top || t > timingOf(top)) top = n;
    });
    return { total: sum, slowest: top as PlanNode | null };
  }, [roots]);
  const s = plan?.summary;
  return (
    <div className="flex h-full flex-col" data-testid="plan-view">
      <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2">
        <Button size="sm" variant="primary" onClick={onExplain} loading={loading}>Explain</Button>
        <Button size="sm" onClick={onAnalyze} loading={loading} title="Runs the query to measure what each step costs" data-testid="plan-analyze"><Timer className="h-3.5 w-3.5" /> Explain analyze</Button>
        {s && total > 0 && (
          <span className="ml-2 min-w-0 truncate text-xs text-zinc-400" data-testid="plan-summary">
            {s.latency_s != null && <>Took <span className="tabular-nums text-zinc-200">{ms(s.latency_s)}</span></>}
            {s.rows_scanned != null && <> · <span className="tabular-nums text-zinc-200">{s.rows_scanned.toLocaleString()}</span> rows scanned</>}
            {s.peak_memory_bytes != null && s.peak_memory_bytes > 0 && <> · peak memory <span className="tabular-nums text-zinc-200">{formatBytes(s.peak_memory_bytes)}</span></>}
            {slowest && <> · slowest step <span className="font-mono text-amber-300">{slowest.name}</span> ({Math.round((timingOf(slowest) / total) * 100)}%)</>}
          </span>
        )}
        <Tabs<'tree' | 'text'> size="sm" className="ml-auto border-b-0" value={mode} onChange={setMode} tabs={[{ id: 'tree', label: 'Tree' }, { id: 'text', label: 'Text' }]} />
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {loading && !plan ? (
          <div className="flex h-full items-center justify-center"><Spinner /></div>
        ) : !plan ? (
          <Empty icon={<GitBranch className="h-8 w-8" />} title="No plan yet" hint="Explain the current tab's SQL to see its steps with estimated rows; Explain analyze also measures the time each one takes." />
        ) : mode === 'text' || !roots.length ? (
          <pre className="font-mono text-2xs leading-4 text-zinc-300">{plan.text}</pre>
        ) : (
          roots.map((r, i) => <Node key={i} n={r} depth={0} total={total} slowest={slowest} />)
        )}
      </div>
    </div>
  );
}
