import { useCallback, useEffect, useMemo, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { EditorView } from '@codemirror/view';
import { yaml as yamlLang } from '@codemirror/lang-yaml';
import { oneDark } from '@codemirror/theme-one-dark';
import { Play, Plus, X, Save, CheckCircle2, Code2, Sigma, Wand2, FileCode2, Copy, Workflow, Sparkles } from 'lucide-react';
import { api, type ChartConfig, type MetricQueryBody, type MetricQueryResult, type SemanticDimension, type SemanticLayer, type SemanticMetric } from '../../api/client';
import { useWorkspace, useWorkspaceAccess } from '../../store/workspace';
import { useTheme } from '../../store/theme';
import { byokBody } from '../../store/copilot';
import { Badge, Button, Empty, Input, Label, Select, cn } from '../../components/ui';
import { ChartPanel } from '../workspace/ChartPanel';
import { ResultsGrid } from '../workspace/ResultsGrid';
import { HistoryButton } from '../history/HistoryDrawer';
import { MonitorsPanel } from './MonitorsPanel';

const GRAINS = ['day', 'week', 'month', 'quarter', 'year'] as const;
const OPS = ['=', '!=', '>', '>=', '<', '<=', 'in', 'not in', 'like', 'is null', 'is not null'] as const;
type Filter = { dimension: string; op: (typeof OPS)[number]; value: string };

const EXAMPLE = `# Metrics defined once, queried the same way everywhere (explorer, agents, Copilot).
# Same shape as dbt's semantic layer (MetricFlow): semantic models with entities, dimensions and measures;
# metrics that are simple, ratio or derived. "Scaffold from table" writes a first draft for a table.
semantic_models:
  - name: orders
    table: orders
    default_time_dimension: order_date
    entities:
      - { name: order, type: primary, expr: order_id }
      - { name: customer, type: foreign, expr: customer_id }
    dimensions:
      - { name: order_date, type: time }
      - { name: region, type: categorical }
    measures:
      - { name: revenue, agg: sum, expr: amount }
      - { name: order_count, agg: count }
metrics:
  - { name: revenue, label: Revenue, type: simple, measure: revenue }
  - { name: orders, label: Orders, type: simple, measure: order_count }
  - { name: aov, label: Average order value, type: ratio, numerator: revenue, denominator: orders }
`;

/** Transform → Metrics: explore the semantic layer's metrics, and edit the workspace's definitions. */
export function MetricsPanel({ workspaceId }: { workspaceId: string }) {
  const [layer, setLayer] = useState<SemanticLayer | null>(null);
  const [view, setView] = useState<'explore' | 'define' | 'monitors'>(() => (new URLSearchParams(location.hash.split('?')[1] ?? '').get('view') === 'monitors' ? 'monitors' : 'explore'));
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setLayer(await api.get<SemanticLayer>(`/api/workspaces/${workspaceId}/semantic`));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [workspaceId]);
  useEffect(() => void load(), [load]);
  if (!layer) return <div className="text-xs text-zinc-500">{error ?? 'Loading…'}</div>;
  return (
    <div className="space-y-3 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-md border border-zinc-800 p-0.5">
          {(['explore', 'monitors', 'define'] as const).map((v) => (
            <button key={v} onClick={() => setView(v)} className={cn('rounded px-2.5 py-1', view === v ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-200')} data-testid={`metrics-${v}`}>
              {v === 'explore' ? 'Explore' : v === 'monitors' ? 'Monitors' : 'Definitions'}
            </button>
          ))}
        </div>
        <span className="text-zinc-500">
          {layer.metrics.length} metric{layer.metrics.length === 1 ? '' : 's'} · {layer.semantic_models.length} semantic model{layer.semantic_models.length === 1 ? '' : 's'}
          {layer.sources.filter((s) => s.source.startsWith('dbt:')).length ? ` · ${layer.sources.filter((s) => s.source.startsWith('dbt:')).length} from dbt` : ''}
        </span>
      </div>
      {layer.warnings.length > 0 && <div className="rounded-md border border-amber-900/60 bg-amber-950/30 px-3 py-2 text-amber-200">{layer.warnings.slice(0, 5).join(' · ')}</div>}
      {view === 'explore' ? <Explorer workspaceId={workspaceId} layer={layer} onDefine={() => setView('define')} /> : view === 'monitors' ? <MonitorsPanel workspaceId={workspaceId} layer={layer} /> : <Definitions workspaceId={workspaceId} layer={layer} onSaved={(l) => setLayer(l)} />}
    </div>
  );
}

function sourceBadge(source: string) {
  return source === 'workspace' ? null : <Badge tone="accent"><Workflow className="mr-0.5 inline h-2.5 w-2.5" />dbt</Badge>;
}

function Explorer({ workspaceId, layer, onDefine }: { workspaceId: string; layer: SemanticLayer; onDefine: () => void }) {
  const ws = useWorkspace();
  const [picked, setPicked] = useState<string[]>(() => (layer.metrics[0] ? [layer.metrics[0].name] : []));
  const [dims, setDims] = useState<SemanticDimension[]>([]);
  const [groupBy, setGroupBy] = useState<string[]>([]);
  const [grain, setGrain] = useState<(typeof GRAINS)[number]>('month');
  const [filters, setFilters] = useState<Filter[]>([]);
  const [result, setResult] = useState<MetricQueryResult | null>(null);
  const [chart, setChart] = useState<ChartConfig>({ type: 'bar' });
  const [showSql, setShowSql] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const byName = useMemo(() => new Map(layer.metrics.map((m) => [m.name, m])), [layer]);

  useEffect(() => {
    if (!picked.length) {
      setDims([]);
      return;
    }
    void api.get<{ dimensions: SemanticDimension[] }>(`/api/workspaces/${workspaceId}/semantic/dimensions?metrics=${encodeURIComponent(picked.join(','))}`).then((r) => {
      setDims(r.dimensions);
      setGroupBy((g) => g.filter((x) => r.dimensions.some((d) => d.name === x.replace(/__(day|week|month|quarter|year)$/, ''))));
    }).catch((e) => setError((e as Error).message));
  }, [picked, workspaceId]);

  const typeOf = (name: string) => dims.find((d) => d.name === name.replace(/__(day|week|month|quarter|year)$/, ''))?.type;
  const runQuery = async (body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<MetricQueryResult>(`/api/workspaces/${workspaceId}/semantic/query`, { limit: 1000, ...body });
      setResult(r);
      const time = r.group_by.find((g) => /metric_time|__(day|week|month|quarter|year)$/.test(g));
      setChart({ type: time ? 'line' : 'bar', x: r.group_by[0], y: (body.metrics as string[]).slice(0, 4) });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const run = () =>
    runQuery({
      metrics: picked,
      group_by: groupBy.map((g) => (typeOf(g) === 'time' && !/__(day|week|month|quarter|year)$/.test(g) ? `${g}__${grain}` : g)),
      where: filters.filter((f) => f.dimension).map((f) => ({ dimension: f.dimension, op: f.op, value: f.op === 'in' || f.op === 'not in' ? f.value.split(',').map((v) => v.trim()).filter(Boolean) : f.op.startsWith('is ') ? undefined : /^-?\d+(\.\d+)?$/.test(f.value.trim()) ? Number(f.value) : f.value })),
    });
  /** Shows a query (from a question, or a link from DuckView AI) in the controls and runs it as it is. */
  const apply = (q: MetricQueryBody) => {
    setPicked(q.metrics);
    const grainOf = (q.group_by ?? []).map((g) => /__(day|week|month|quarter|year)$/.exec(g)?.[1]).find(Boolean) as (typeof GRAINS)[number] | undefined;
    if (grainOf) setGrain(grainOf);
    setGroupBy((q.group_by ?? []).map((g) => g.replace(/__(day|week|month|quarter|year)$/, '')));
    setFilters((q.where ?? []).map((w) => ({ dimension: w.dimension, op: w.op as Filter['op'], value: Array.isArray(w.value) ? w.value.join(', ') : w.value == null ? '' : String(w.value) })));
    void runQuery(q as unknown as Record<string, unknown>);
  };
  // #/transform/metrics?q=… (DuckView AI's "Open in Metrics").
  useEffect(() => {
    const raw = new URLSearchParams(location.hash.split('?')[1] ?? '').get('q');
    if (!raw) return;
    try {
      apply(JSON.parse(decodeURIComponent(escape(atob(raw.replace(/-/g, '+').replace(/_/g, '/'))))) as MetricQueryBody);
    } catch {
      /* not a query */
    }
    history.replaceState(null, '', '#/transform/metrics');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<{ title: string | null; explanation: string | null; unanswerable: string | null } | null>(null);
  const [asking, setAsking] = useState(false);
  const askQuestion = async () => {
    if (!question.trim()) return;
    setAsking(true);
    setAnswer(null);
    setError(null);
    try {
      const r = await api.post<{ query: MetricQueryBody | null; title: string | null; explanation: string | null; unanswerable: string | null }>(`/api/workspaces/${workspaceId}/semantic/ask`, { question, ...byokBody() });
      setAnswer(r);
      if (r.query) apply(r.query);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setAsking(false);
    }
  };

  if (!layer.metrics.length) {
    return (
      <Empty
        title="No metrics yet"
        hint="Define semantic models and metrics in Definitions (or scaffold them from a table), or add semantic_models and metrics to a dbt project — they appear here after its next run."
        icon={<Sigma className="h-6 w-6" />}
      />
    );
  }

  return (
    <div className="space-y-3">
    <form className="flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); void askQuestion(); }}>
      <Sparkles className="h-4 w-4 shrink-0 text-accent-400" />
      <Input value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Ask a question — “revenue by region last quarter”, “orders per month in the EU”" aria-label="Ask a question" data-testid="metrics-ask" />
      <Button type="submit" variant="primary" loading={asking} disabled={!question.trim()} data-testid="metrics-ask-go">Ask</Button>
    </form>
    {answer && <p className={cn('text-xs', answer.unanswerable ? 'text-amber-300' : 'text-zinc-400')} data-testid="metrics-answer">{answer.unanswerable ?? `${answer.title ?? ''}${answer.explanation ? ` — ${answer.explanation}` : ''}`}</p>}
    <div className="grid gap-3 lg:grid-cols-[260px_1fr]">
      <div className="space-y-3">
        <div>
          <div className="mb-1 flex items-center justify-between text-2xs text-zinc-500">Metrics <button className="normal-case text-accent-300 hover:underline" onClick={onDefine}>edit definitions</button></div>
          <div className="space-y-0.5">
            {layer.metrics.map((m) => (
              <label key={m.name} className={cn('flex cursor-pointer items-start gap-2 rounded px-1.5 py-1', picked.includes(m.name) ? 'bg-zinc-800/80' : 'hover:bg-zinc-800/40')} title={m.error ?? m.description ?? ''} data-metric={m.name}>
                <input type="checkbox" className="mt-0.5" checked={picked.includes(m.name)} onChange={(e) => setPicked((p) => (e.target.checked ? [...p, m.name] : p.filter((x) => x !== m.name)))} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1 text-zinc-200">{m.label ?? m.name} {sourceBadge(m.source)}{m.error && <Badge tone="error">error</Badge>}</span>
                  <span className="block truncate font-mono text-2xs text-zinc-400">{m.name} · {m.type === 'simple' ? m.measure : m.type === 'ratio' ? `${m.numerator} / ${m.denominator}` : m.expr}</span>
                </span>
              </label>
            ))}
          </div>
        </div>
        <div>
          <div className="mb-1 text-2xs text-zinc-500">Group by</div>
          <div className="flex flex-wrap gap-1">
            {groupBy.map((g) => (
              <span key={g} className="inline-flex items-center gap-1 rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-2xs text-zinc-200">
                {g}
                <button onClick={() => setGroupBy((x) => x.filter((y) => y !== g))}><X className="h-3 w-3" /></button>
              </span>
            ))}
          </div>
          <Select aria-label="Add a dimension to group by" value="" onChange={(e) => e.target.value && setGroupBy((g) => [...g, e.target.value])} className="mt-1 h-7 text-xs" data-testid="metrics-groupby">
            <option value="">Add a dimension…</option>
            {dims.filter((d) => !groupBy.includes(d.name)).map((d) => <option key={d.name} value={d.name}>{d.name}{d.type === 'time' ? ' (time)' : ''}</option>)}
          </Select>
          {groupBy.some((g) => typeOf(g) === 'time') && (
            <div className="mt-1 flex items-center gap-1.5 text-zinc-500">
              grain
              <Select aria-label="Time grain" value={grain} onChange={(e) => setGrain(e.target.value as (typeof GRAINS)[number])} className="h-7 w-28 text-xs" data-testid="metrics-grain">
                {GRAINS.map((g) => <option key={g} value={g}>{g}</option>)}
              </Select>
            </div>
          )}
        </div>
        <div>
          <div className="mb-1 flex items-center justify-between text-2xs text-zinc-500">
            Filters
            <button className="rounded p-0.5 hover:bg-zinc-800 hover:text-zinc-200" onClick={() => setFilters((f) => [...f, { dimension: dims[0]?.name ?? '', op: '=', value: '' }])} title="Add a filter"><Plus className="h-3.5 w-3.5" /></button>
          </div>
          {filters.map((f, i) => (
            <div key={i} className="mb-1 flex items-center gap-1">
              <Select aria-label="Filter on" value={f.dimension} onChange={(e) => setFilters((all) => all.map((x, k) => (k === i ? { ...x, dimension: e.target.value } : x)))} className="h-7 min-w-0 flex-1 text-xs">
                {dims.map((d) => <option key={d.name} value={d.name}>{d.name}</option>)}
              </Select>
              <Select value={f.op} onChange={(e) => setFilters((all) => all.map((x, k) => (k === i ? { ...x, op: e.target.value as Filter['op'] } : x)))} className="h-7 w-20 text-xs">
                {OPS.map((o) => <option key={o} value={o}>{o}</option>)}
              </Select>
              {!f.op.startsWith('is ') && <Input value={f.value} onChange={(e) => setFilters((all) => all.map((x, k) => (k === i ? { ...x, value: e.target.value } : x)))} className="h-7 w-24 text-xs" placeholder={f.op.includes('in') ? 'a, b' : 'value'} />}
              <button onClick={() => setFilters((all) => all.filter((_x, k) => k !== i))} className="text-zinc-500 hover:text-red-300"><X className="h-3.5 w-3.5" /></button>
            </div>
          ))}
        </div>
        <Button variant="primary" size="sm" className="w-full justify-center" disabled={!picked.length || busy} onClick={() => void run()} data-testid="metrics-run"><Play className="h-3.5 w-3.5" /> Compute</Button>
      </div>
      <div className="min-w-0 space-y-2">
        {error && <div className="rounded-md border border-red-900 bg-red-950/50 px-3 py-2 font-mono text-red-200">{error}</div>}
        {!result && !error && <div className="border-y border-zinc-800 p-8 text-center text-zinc-500">Pick metrics and dimensions, then Compute. The same definitions answer agents (query_metrics) and Copilot.</div>}
        {result && (
          <>
            <div className="flex flex-wrap items-center gap-2" data-testid="metrics-result">
              <span className="text-zinc-300">{result.metrics.map((m) => m.label ?? m.name).join(', ')}{result.group_by.length ? ` by ${result.group_by.join(', ')}` : ''}</span>
              <span className="text-zinc-500">{result.row_count} rows · {result.duration_ms} ms</span>
              <div className="ml-auto flex gap-1">
                <Button size="sm" variant="ghost" onClick={() => setShowSql((s) => !s)}><Code2 className="h-3.5 w-3.5" /> SQL</Button>
                <Button size="sm" variant="ghost" onClick={() => void ws.addTab({ title: `Metrics: ${picked.join(', ')}`.slice(0, 60), sql: result.sql }).then(() => (location.hash = '#/query'))} title="Open the compiled SQL in a Query tab"><FileCode2 className="h-3.5 w-3.5" /> Open in Query</Button>
              </div>
            </div>
            {showSql && (
              <div className="relative">
                <pre className="max-h-64 overflow-auto rounded-md border border-zinc-800 bg-zinc-950 p-2 font-mono text-2xs text-zinc-300">{result.sql}</pre>
                <button className="absolute right-2 top-2 rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200" onClick={() => void navigator.clipboard?.writeText(result.sql)} title="Copy"><Copy className="h-3.5 w-3.5" /></button>
              </div>
            )}
            {result.group_by.length > 0 && <div className="h-72 rounded-lg border border-zinc-800 p-2"><ChartPanel columns={result.columns} rows={result.rows} config={chart} onChange={setChart} /></div>}
            <div className="max-h-80 overflow-auto rounded-lg border border-zinc-800"><ResultsGrid columns={result.columns} rows={result.rows} /></div>
          </>
        )}
      </div>
    </div>
    </div>
  );
}

function Definitions({ workspaceId, layer, onSaved }: { workspaceId: string; layer: SemanticLayer; onSaved: (l: SemanticLayer) => void }) {
  const { canEdit } = useWorkspaceAccess();
  const theme = useTheme((t) => t.theme.kind);
  const [text, setText] = useState(layer.yaml || EXAMPLE);
  const [check, setCheck] = useState<{ ok: boolean; problems: string[] } | null>(null);
  const [tables, setTables] = useState<string[]>([]);
  const [table, setTable] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void api.get<{ objects: { name: string; schema: string }[] }>(`/api/workspaces/${workspaceId}/catalog/annotated`).then((r) => setTables(r.objects.map((o) => (o.schema === 'main' ? o.name : `${o.schema}.${o.name}`)))).catch(() => undefined);
  }, [workspaceId]);
  const dirty = text !== (layer.yaml || EXAMPLE) || !layer.yaml;
  const validate = async () => setCheck(await api.post<{ ok: boolean; problems: string[] }>(`/api/workspaces/${workspaceId}/semantic/validate`, { yaml: text }));
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      onSaved(await api.put<SemanticLayer>(`/api/workspaces/${workspaceId}/semantic`, { yaml: text }));
      setCheck({ ok: true, problems: [] });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const scaffold = async () => {
    if (!table) return;
    const r = await api.post<{ yaml: string }>(`/api/workspaces/${workspaceId}/semantic/scaffold`, { table });
    // A fresh draft replaces the example; otherwise the table's model and metrics are appended as a new document section.
    setText((t) => (t === EXAMPLE || !t.trim() ? r.yaml : mergeYaml(t, r.yaml)));
  };
  const imported = layer.sources.filter((s) => s.source.startsWith('dbt:'));
  return (
    <div className="grid gap-3 lg:grid-cols-[1fr_300px]">
      <div className="min-w-0 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-zinc-300">semantic layer · this workspace</span>
          {check && (check.ok ? <Badge tone="ok"><CheckCircle2 className="mr-0.5 inline h-3 w-3" />valid</Badge> : <Badge tone="error">{check.problems.length} problem{check.problems.length === 1 ? '' : 's'}</Badge>)}
          <div className="ml-auto flex gap-2">
            <HistoryButton label workspaceId={workspaceId} objectType="semantic" objectId="workspace" title="Semantic layer" onRestored={() => void api.get<SemanticLayer>(`/api/workspaces/${workspaceId}/semantic`).then((l) => { onSaved(l); setText(l.yaml); })} />
            <Button size="sm" variant="ghost" onClick={() => void validate()} data-testid="metrics-validate">Validate</Button>
            {canEdit && <Button size="sm" variant="primary" disabled={busy || !dirty} onClick={() => void save()} data-testid="metrics-save"><Save className="h-3.5 w-3.5" /> Save</Button>}
          </div>
        </div>
        <div className="h-[460px] overflow-hidden rounded-lg border border-zinc-800">
          <CodeMirror value={text} height="460px" theme={theme === 'dark' ? oneDark : 'light'} extensions={[yamlLang(), EditorView.lineWrapping]} editable={canEdit} onChange={setText} basicSetup={{ lineNumbers: true, foldGutter: true, autocompletion: false }} className="h-full text-xs" />
        </div>
        {(error || (check && !check.ok)) && <div className="whitespace-pre-wrap rounded-md border border-red-900 bg-red-950/50 px-3 py-2 font-mono text-2xs text-red-200">{error ?? check!.problems.join('\n')}</div>}
      </div>
      <div className="space-y-3">
        {canEdit && (
          <div className="space-y-1.5 rounded-lg border border-zinc-800 bg-zinc-900/40 p-2.5">
            <Label>Scaffold from table</Label>
            <div className="flex gap-1.5">
              <Select value={table} onChange={(e) => setTable(e.target.value)} className="h-7 min-w-0 flex-1 text-xs" data-testid="metrics-scaffold-table">
                <option value="">Pick a table…</option>
                {tables.map((t) => <option key={t} value={t}>{t}</option>)}
              </Select>
              <Button size="sm" disabled={!table} onClick={() => void scaffold()} data-testid="metrics-scaffold" aria-label="Generate metrics from the table" title="Generate metrics from the table"><Wand2 className="h-3.5 w-3.5" /></Button>
            </div>
            <p className="text-2xs text-zinc-500">Entities from id columns, time and categorical dimensions, a count and a sum per number. Review, then Save.</p>
          </div>
        )}
        <div className="space-y-1 rounded-lg border border-zinc-800 bg-zinc-900/40 p-2.5 text-2xs text-zinc-400">
          <div className="text-2xs text-zinc-500">How it reads</div>
          <p><b className="text-zinc-300">semantic_models</b>: a table (or sql), <span className="font-mono">entities</span> (keys; a foreign entity joins to the model where it is primary), <span className="font-mono">dimensions</span> (categorical or time) and <span className="font-mono">measures</span> (sum · count · count_distinct · avg · min · max · median).</p>
          <p><b className="text-zinc-300">metrics</b>: <span className="font-mono">simple</span> (a measure, optional filter), <span className="font-mono">ratio</span> (numerator / denominator), <span className="font-mono">derived</span> (an expression over metrics).</p>
          <p>Group by <span className="font-mono">metric_time__month</span>, a dimension, or <span className="font-mono">customer__tier</span> across a join. Filters may use <span className="font-mono">{"{{ Dimension('order__status') }}"}</span>.</p>
        </div>
        {imported.length > 0 && (
          <div className="space-y-1 rounded-lg border border-zinc-800 bg-zinc-900/40 p-2.5 text-2xs text-zinc-400">
            <div className="text-2xs text-zinc-500">From dbt projects</div>
            {imported.map((s) => (
              <div key={s.source} className="flex items-center justify-between">
                <a className="text-accent-300 hover:underline" href={`#/transform/dbt/${s.source.slice(4)}`}>{s.source}</a>
                <span>{s.models} models · {s.metrics} metrics</span>
              </div>
            ))}
            <p>Read from each project's semantic models and metrics after every run; edit them in the project.</p>
          </div>
        )}
      </div>
    </div>
  );
}

/** Appends a scaffolded document's semantic_models and metrics to the existing YAML text. */
function mergeYaml(current: string, extra: string): string {
  const pick = (doc: string, key: string) => {
    const m = new RegExp(`^${key}:\\n((?:[ \\t-].*\\n?)*)`, 'm').exec(doc.endsWith('\n') ? doc : `${doc}\n`);
    return m ? m[1]!.replace(/\n$/, '') : '';
  };
  let out = current.endsWith('\n') ? current : `${current}\n`;
  for (const key of ['semantic_models', 'metrics']) {
    const add = pick(extra, key);
    if (!add) continue;
    const re = new RegExp(`^${key}:\\n((?:[ \\t-].*\\n?)*)`, 'm');
    out = re.test(out) ? out.replace(re, (all) => `${all.replace(/\n?$/, '\n')}${add}\n`) : `${out}${key}:\n${add}\n`;
  }
  return out;
}
