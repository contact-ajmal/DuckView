import { useEffect, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Bot, X, Send, Square, Settings2, Sparkles, Wrench, PlayCircle, FilePlus2, ArrowDownToLine, Trash2, History, ChevronDown, KeyRound, Loader2, LayoutDashboard, CheckCircle2, AlertTriangle, Workflow } from 'lucide-react';
import { SaveDbtModelDialog, looksLikeDbtModel } from '../transform/SaveDbtModelDialog';
import { useCopilot } from '../../store/copilot';
import { useWorkspace } from '../../store/workspace';
import { api, type AgentRecord, type CopilotBuildBlock, type CopilotMetricBlock, type CopilotSpecBlock, type Dashboard } from '../../api/client';
import { ChartWidget, type WidgetData } from '../dashboards/widgets';
import { Button, Input, Label, Select, cn, toast } from '../../components/ui';

export interface CopilotHost {
  /** What "insert" means here (the workbench: into the tab; a notebook: a new cell). */
  insertLabel?: string;
  /** Inserts SQL at the cursor of the active tab (falls back to a new tab). */
  insertSql(sql: string): void;
  /** Opens a fresh tab with the SQL. */
  newTabWithSql(sql: string, title?: string): void;
  /** Runs SQL in the active tab and resolves with a preview of the result. */
  runSql(sql: string): Promise<{ columns: { name: string; type: string }[]; rows: unknown[][]; rowCount: number; error?: string }>;
  activeSql(): string;
  activeError(): string | null;
}

let host: CopilotHost | null = null;
export function registerCopilotHost(h: CopilotHost | null) {
  host = h;
}

/** A ```yaml / ```json block that is a Mosaic spec — validated by the server when the reply completed. */
const looksLikeSpec = (text: string) => /^\s*(plot|vconcat|hconcat|input|mark|legend)\s*:/m.test(text) || /"(plot|vconcat|hconcat|input|mark|legend)"\s*:/.test(text);

/** Opens a metric query in Data › Metrics (the explorer reads ?q=). */
export const metricsLink = (q: unknown) => `#/transform/metrics?q=${btoa(unescape(encodeURIComponent(JSON.stringify(q)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;

/** A ```duckview-metric answer: computed through the semantic layer, shown as numbers and a chart. */
function MetricCard({ block, workspaceId }: { block: CopilotMetricBlock | undefined; workspaceId: string | null }) {
  const [sql, setSql] = useState(false);
  const [dashboards, setDashboards] = useState<Dashboard[] | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  if (!block) return <div className="my-2 rounded-md border border-zinc-800 px-2 py-1.5 text-2xs text-zinc-500"><Loader2 className="mr-1 inline h-3 w-3 animate-spin" /> computing from the metrics…</div>;
  if (!block.ok) return <div className="my-2 rounded-md border border-amber-900/60 bg-amber-950/20 px-2 py-1.5 text-2xs text-amber-200" data-testid="metric-card">Could not compute this from the metrics: {block.error}</div>;
  const q = block.query!;
  const dims = q.group_by ?? [];
  const numeric = (t: string) => /INT|DOUBLE|DECIMAL|FLOAT|REAL|NUMERIC/i.test(t);
  const data: WidgetData = { columns: block.columns.map((c) => ({ name: c.name, type: c.type, kind: numeric(c.type) ? 'number' : /DATE|TIME/i.test(c.type) ? 'temporal' : 'string' })) as never, rows: block.rows, rowCount: block.row_count ?? block.rows.length, totalRows: null, durationMs: 0 };
  const time = dims.some((d) => /metric_time|__(day|week|month|quarter|year)$/.test(d));
  const fmt = (v: unknown) => (v == null ? '—' : typeof v === 'number' ? v.toLocaleString(undefined, { maximumFractionDigits: 2 }) : String(v).replace(/T00:00:00(\.000)?Z?$/, ''));
  const pin = async (d: Dashboard) => {
    await api.post(`/api/dashboards/${d.id}/widgets`, { title: block.title ?? q.metrics.join(', '), widget_type: dims.length ? 'CHART' : 'KPI', custom_sql: block.sql, chart_config: dims.length ? { chart: time ? 'line' : 'bar', x: dims[0], y: q.metrics.slice(0, 3) } : { value: q.metrics[0] } });
    setPinned(d.name);
    setDashboards(null);
  };
  return (
    <div className="my-2 overflow-hidden rounded-md border border-zinc-800 bg-zinc-950" data-testid="metric-card">
      <div className="flex items-center gap-1.5 border-b border-zinc-800 bg-zinc-900/60 px-2 py-1 text-2xs text-zinc-400">
        <CheckCircle2 className="h-3 w-3 shrink-0 text-emerald-400" /> <span className="truncate text-zinc-200">{block.title ?? q.metrics.join(', ')}</span>
        <span className="ml-auto shrink-0">from metrics · {block.row_count} row{block.row_count === 1 ? '' : 's'}</span>
      </div>
      {dims.length === 0 && block.rows[0] ? (
        <div className="flex flex-wrap gap-x-6 gap-y-1 px-3 py-2">{block.columns.map((c, i) => <div key={c.name}><div className="text-2xs text-zinc-500">{c.name}</div><div className="text-title font-semibold text-zinc-50" data-metric-value={c.name}>{fmt(block.rows[0]![i])}</div></div>)}</div>
      ) : (
        <>
          {block.rows.length > 1 && <div className="h-40 px-1 pt-1"><ChartWidget data={data} config={{ chart: time ? 'line' : 'bar', x: dims[0], y: q.metrics.slice(0, 3) }} /></div>}
          <div className="max-h-48 overflow-auto">
            <table className="w-full font-mono text-2xs">
              <thead className="sticky top-0 bg-zinc-900 text-left text-zinc-500"><tr>{block.columns.map((c) => <th key={c.name} className="px-2 py-1 font-normal">{c.name}</th>)}</tr></thead>
              <tbody>{block.rows.slice(0, 50).map((r, i) => <tr key={i} className="border-t border-zinc-800/60">{r.map((v, j) => <td key={j} className={cn('px-2 py-0.5 text-zinc-300', typeof v === 'number' && 'text-right')}>{fmt(v)}</td>)}</tr>)}</tbody>
            </table>
          </div>
        </>
      )}
      {sql && <pre className="max-h-48 overflow-auto border-t border-zinc-800 p-2 font-mono text-2xs text-zinc-400">{block.sql}</pre>}
      {pinned && <div className="border-t border-zinc-800 px-2 py-1 text-2xs text-emerald-300">Added to “{pinned}”.</div>}
      {dashboards && (
        <div className="max-h-40 overflow-auto border-t border-zinc-800 py-1">
          {dashboards.length === 0 ? <p className="px-2 py-1 text-2xs text-zinc-500">No grid dashboards yet.</p> : dashboards.map((d) => <button key={d.id} onClick={() => void pin(d)} className="block w-full truncate px-2 py-1 text-left text-2xs text-zinc-300 hover:bg-zinc-800">{d.name}</button>)}
        </div>
      )}
      <div className="flex flex-wrap gap-1 border-t border-zinc-800 bg-zinc-900/60 px-1.5 py-1">
        <a href={metricsLink(q)} className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-2xs text-accent-200 hover:bg-accent-600/20" data-testid="metric-open">Open in Metrics</a>
        <button disabled={!workspaceId} onClick={() => void (dashboards ? setDashboards(null) : api.get<{ dashboards: Dashboard[] }>(`/api/workspaces/${workspaceId}/dashboards`).then((r) => setDashboards(r.dashboards.filter((d) => d.kind !== 'mosaic'))))} className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-2xs text-zinc-300 hover:bg-zinc-800"><LayoutDashboard className="h-3 w-3" /> Add to dashboard</button>
        <button onClick={() => setSql((v) => !v)} className="ml-auto rounded px-1.5 py-0.5 text-2xs text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200">{sql ? 'Hide SQL' : 'SQL'}</button>
      </div>
    </div>
  );
}

/** A ```duckview-build plan: what DuckView AI proposes to build, each item already run against the workspace. */
function BuildCard({ text, block, workspaceId, onFix }: { text: string; block: CopilotBuildBlock | undefined; workspaceId: string | null; onFix: (problems: string[]) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<{ url: string; name: string; skipped: { title: string }[] } | null>(null);
  const [showPlan, setShowPlan] = useState(false);
  const check = block?.check ?? null;
  const failed = check?.items.filter((i) => !i.ok) ?? [];
  const create = async () => {
    if (!workspaceId) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ url: string; name: string; skipped: { title: string }[] }>(`/api/workspaces/${workspaceId}/build`, { plan: text });
      setMade(r);
      location.hash = r.url.replace(/^#?/, '#');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const kind = check?.build === 'app' ? 'data app' : 'dashboard';
  return (
    <div className="my-2 overflow-hidden rounded-md border border-zinc-800 bg-zinc-950" data-testid="build-card">
      <div className="flex items-center gap-1.5 border-b border-zinc-800 bg-zinc-900/60 px-2 py-1 text-2xs text-zinc-400">
        <LayoutDashboard className="h-3 w-3 shrink-0 text-accent-300" /> {kind}{check ? <span className="truncate text-zinc-200">· {check.name}</span> : null}
        <span className="ml-auto shrink-0">{check ? (failed.length ? <span className="text-amber-300">{check.items.length - failed.length} of {check.items.length} work</span> : <span className="inline-flex items-center gap-1 text-emerald-300"><CheckCircle2 className="h-3 w-3" /> all {check.items.length} work</span>) : block?.error ? <span className="text-red-300">not a valid plan</span> : <span>checking…</span>}</span>
      </div>
      {check && (
        <ul className="divide-y divide-zinc-800/60 text-xs">
          {check.items.map((i) => (
            <li key={i.title} className="flex items-start gap-2 px-2 py-1" data-build-item={i.title}>
              {i.ok ? <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-emerald-400" /> : <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-amber-300" />}
              <span className="min-w-0 flex-1"><span className="text-zinc-200">{i.title}</span> <span className="text-zinc-500">{i.kind}{i.ok && i.row_count != null ? ` · ${i.row_count} row${i.row_count === 1 ? '' : 's'}` : ''}</span>{!i.ok && <span className="block break-words font-mono text-2xs text-amber-200">{i.error}</span>}</span>
            </li>
          ))}
        </ul>
      )}
      {block?.error && <div className="px-2 py-1.5 font-mono text-2xs text-red-200">{block.error}</div>}
      {showPlan && <pre className="max-h-60 overflow-auto border-t border-zinc-800 p-2 font-mono text-2xs text-zinc-300">{text}</pre>}
      {error && <div className="border-t border-zinc-800 px-2 py-1.5 font-mono text-2xs text-red-200">{error}</div>}
      {made && <div className="border-t border-zinc-800 px-2 py-1.5 text-2xs text-emerald-300">Created “{made.name}”{made.skipped.length ? ` without ${made.skipped.length} item${made.skipped.length === 1 ? '' : 's'} that did not work` : ''}. <a className="underline" href={made.url.replace(/^#?/, '#')}>Open it</a></div>}
      <div className="flex flex-wrap gap-1 border-t border-zinc-800 bg-zinc-900/60 px-1.5 py-1">
        <button onClick={() => void create()} disabled={busy || !workspaceId || !check || check.items.every((i) => !i.ok || i.kind === 'text')} className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-2xs font-medium text-accent-200 hover:bg-accent-600/20 disabled:opacity-40" data-testid="build-create">
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <LayoutDashboard className="h-3 w-3" />} Create {kind}{failed.length ? ` (${check!.items.length - failed.length} items)` : ''}
        </button>
        {failed.length > 0 && <button onClick={() => onFix(failed.map((f) => `${f.title}: ${f.error}`))} className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-2xs text-zinc-300 hover:bg-zinc-800 hover:text-zinc-50" data-testid="build-fix"><Wrench className="h-3 w-3 text-amber-300" /> Fix with AI</button>}
        <button onClick={() => setShowPlan((v) => !v)} className="ml-auto rounded px-1.5 py-0.5 text-2xs text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200">{showPlan ? 'Hide plan' : 'Show plan'}</button>
      </div>
    </div>
  );
}

function SpecBlock({ text, verdict, workspaceId, onFix }: { text: string; verdict: CopilotSpecBlock | undefined; workspaceId: string | null; onFix: (errors: string[]) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const create = async () => {
    if (!workspaceId) return;
    setBusy(true);
    setError(null);
    try {
      // The YAML parser rides with the Mosaic dashboard chunk; load it only when a spec is actually created.
      const { parseSpecText, prepareSpec } = await import('../../lib/mosaic/spec');
      const spec = parseSpecText(text);
      const prepared = await prepareSpec(workspaceId, spec);
      if (!prepared.ok) throw new Error(prepared.errors.join('\n'));
      const title = (spec.meta as { title?: string } | undefined)?.title;
      const r = await api.post<{ dashboard: Dashboard }>(`/api/workspaces/${workspaceId}/dashboards`, { name: title || 'Copilot dashboard', description: 'Drafted by DuckCopilot', kind: 'mosaic', spec });
      location.hash = `#/dashboards/${r.dashboard.id}`;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const errors = verdict?.errors ?? [];
  return (
    <div className="my-2 overflow-hidden rounded-md border border-zinc-800 bg-zinc-950">
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 border-b border-zinc-800 bg-zinc-900/60 px-2 py-1 text-2xs text-zinc-400">
        <Sparkles className="h-3 w-3 shrink-0 text-accent-300" /> Mosaic dashboard spec{verdict?.title ? <span className="truncate text-zinc-200">· {verdict.title}</span> : null}
        <span className="ml-auto shrink-0">
          {verdict?.ok === true && <span className="inline-flex items-center gap-1 text-emerald-300"><CheckCircle2 className="h-3 w-3" /> valid for this workspace</span>}
          {verdict?.ok === false && <span className="inline-flex items-center gap-1 text-amber-300"><AlertTriangle className="h-3 w-3" /> {errors.length} error{errors.length === 1 ? '' : 's'}</span>}
        </span>
      </div>
      <pre className="max-h-72 overflow-auto p-2.5 font-mono text-2xs leading-relaxed text-zinc-200">{text}</pre>
      {errors.length > 0 && <ul className="border-t border-zinc-800 px-3 py-1.5 font-mono text-2xs text-amber-200">{errors.slice(0, 6).map((e) => <li key={e}>• {e}</li>)}</ul>}
      {error && <div className="border-t border-zinc-800 px-3 py-1.5 font-mono text-2xs text-red-200">{error}</div>}
      <div className="flex flex-wrap gap-1 border-t border-zinc-800 bg-zinc-900/60 px-1.5 py-1">
        <button onClick={() => void create()} disabled={busy || !workspaceId} className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-2xs text-accent-200 hover:bg-accent-600/20 disabled:opacity-40" title="Validate the spec, save it as a Mosaic dashboard and open it">
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <LayoutDashboard className="h-3 w-3" />} Create dashboard
        </button>
        {errors.length > 0 && (
          <button onClick={() => onFix(errors)} className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-2xs text-zinc-300 hover:bg-zinc-800 hover:text-zinc-50" title="Send the validation errors back to Copilot">
            <Wrench className="h-3 w-3 text-amber-300" /> Fix with Copilot
          </button>
        )}
      </div>
    </div>
  );
}

const AWS = new Set(['bedrock', 'bedrock_agent', 'agentcore']);
const fmtTokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));

function SqlBlock({ sql, onInsert, onNewTab, onRun, onDbt, busy }: { sql: string; onInsert: () => void; onNewTab: () => void; onRun: () => void; onDbt: () => void; busy: boolean }) {
  const dbt = looksLikeDbtModel(sql);
  return (
    <div className="my-2 overflow-hidden rounded-md border border-zinc-800 bg-zinc-950">
      <pre className="overflow-auto p-2.5 font-mono text-2xs leading-relaxed text-zinc-200">{sql}</pre>
      <div className="flex flex-wrap gap-1 border-t border-zinc-800 bg-zinc-900/60 px-1.5 py-1">
        <button onClick={onInsert} className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-2xs text-zinc-300 hover:bg-zinc-800 hover:text-zinc-50" title="Insert at cursor in the active tab">
          <ArrowDownToLine className="h-3 w-3" /> {host?.insertLabel ?? 'Insert into tab'}
        </button>
        <button onClick={onNewTab} className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-2xs text-zinc-300 hover:bg-zinc-800 hover:text-zinc-50" title="Open in a fresh tab">
          <FilePlus2 className="h-3 w-3" /> New tab
        </button>
        <button onClick={onDbt} className={cn('inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-2xs hover:bg-zinc-800', dbt ? 'text-accent-200' : 'text-zinc-300 hover:text-zinc-50')} title="Add to a dbt project as a model (Transform → dbt)" data-testid="copilot-dbt-model">
          <Workflow className="h-3 w-3" /> {dbt ? 'Add to dbt project' : 'dbt model'}
        </button>
        {!dbt && <button onClick={onRun} disabled={busy} className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-2xs text-accent-200 hover:bg-accent-600/20 disabled:opacity-40" title="Run the query, then explain the result">
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <PlayCircle className="h-3 w-3" />} Run & inspect
        </button>}
      </div>
    </div>
  );
}

export function CopilotDrawer() {
  const cp = useCopilot();
  const ws = useWorkspace();
  const wsId = ws.activeId;
  const [dbtSql, setDbtSql] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [showConvs, setShowConvs] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [modelsBusy, setModelsBusy] = useState(false);
  const [running, setRunning] = useState<string | null>(null);
  const [invokable, setInvokable] = useState<AgentRecord[]>([]);
  const scroller = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  useEffect(() => {
    void cp.loadConfig();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!showSettings) return;
    api
      .get<{ agents: AgentRecord[] }>('/api/agents')
      .then((r) => setInvokable(r.agents.filter((a) => a.can_invoke)))
      .catch(() => setInvokable([]));
  }, [showSettings]);
  useEffect(() => {
    if (wsId && cp.open) void cp.loadConversations(wsId);
  }, [wsId, cp.open]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [cp.messages]);

  if (!cp.open) return null;
  const cfg = cp.config;
  const labelOf = (id: string | null | undefined) => (id ? cfg?.providers.find((p) => p.id === id)?.label ?? id : '');
  const usingByok = !!(cfg?.allow_byok && cp.settings.provider);
  const effectiveProvider = usingByok ? cp.settings.provider : cfg?.server_provider ?? null;
  const effectiveModel = usingByok
    ? cp.settings.provider === 'agentcore'
      ? cp.settings.runtimeArn?.split('/').pop() || 'runtime'
      : cp.settings.provider === 'bedrock_agent'
        ? cp.settings.agentId || 'agent'
        : cp.settings.model || cfg?.default_models[cp.settings.provider]
    : cfg?.server_provider === 'agentcore'
      ? cfg.server_aws?.runtime_arn?.split('/').pop() ?? cfg.server_model
      : cfg?.server_provider === 'bedrock_agent'
        ? cfg.server_aws?.agent_id ?? cfg.server_model
        : cfg?.server_model;
  const ready = !!cfg?.enabled && !!effectiveProvider;

  const submit = (action?: 'chat' | 'fix' | 'suggest' | 'explain' | 'dashboard') => {
    if (!wsId || cp.streaming) return;
    const text = input.trim();
    if (action === 'fix') {
      void cp.send({ workspaceId: wsId, message: text, action: 'fix', activeSql: host?.activeSql() ?? '', errorMessage: host?.activeError() ?? null });
    } else if (action === 'suggest') {
      void cp.send({ workspaceId: wsId, message: text, action: 'suggest', targets: cp.targets });
    } else if (action === 'dashboard') {
      void cp.send({ workspaceId: wsId, message: text, action: 'dashboard', targets: cp.targets, activeSql: host?.activeSql() ?? null });
    } else {
      if (!text) return;
      void cp.send({ workspaceId: wsId, message: text, activeSql: host?.activeSql() ?? null });
    }
    setInput('');
  };

  const runAndInspect = async (sql: string) => {
    if (!wsId || !host || cp.streaming) return;
    setRunning(sql);
    try {
      const r = await host.runSql(sql);
      if (r.error) {
        void cp.send({ workspaceId: wsId, message: '', action: 'fix', activeSql: sql, errorMessage: r.error });
      } else {
        void cp.send({ workspaceId: wsId, message: 'Explain this result', action: 'explain', activeSql: sql, resultPreview: { columns: r.columns, rows: r.rows.slice(0, 30), rowCount: r.rowCount } });
      }
    } finally {
      setRunning(null);
    }
  };

  const fetchModels = async () => {
    if (!cp.settings.provider) return;
    setModelsBusy(true);
    try {
      const r = await api.post<{ models: string[] }>('/api/copilot/models', { provider: cp.settings.provider, api_key: cp.settings.apiKey || undefined, base_url: cp.settings.baseUrl || undefined, region: cp.settings.region || undefined, agent_id: cp.settings.agentId || undefined, agent_alias_id: cp.settings.agentAliasId || undefined, runtime_arn: cp.settings.runtimeArn || undefined });
      setModels(r.models);
    } catch (e) {
      toast.error(e);
    } finally {
      setModelsBusy(false);
    }
  };

  const fixSpec = (errors: string[]) => {
    if (!wsId || cp.streaming) return;
    void cp.send({ workspaceId: wsId, message: `The dashboard spec failed validation in this workspace. Fix it and return the complete corrected spec:\n${errors.map((e) => `- ${e}`).join('\n')}`, action: 'dashboard', targets: cp.targets });
  };
  const fixBuild = (problems: string[]) => {
    if (!wsId || cp.streaming) return;
    void cp.send({ workspaceId: wsId, message: `Some items of the build plan do not work in this workspace. Fix them and return the complete corrected plan:\n${problems.map((e) => `- ${e}`).join('\n')}`, action: 'build', targets: cp.targets });
  };
  const mdComponentsFor = (m: { specBlocks?: CopilotSpecBlock[]; buildBlocks?: CopilotBuildBlock[]; metricBlocks?: CopilotMetricBlock[] }) => ({
    ...mdComponents,
    code(props: { className?: string; children?: ReactNode; inline?: boolean }) {
      const lang = /language-([\w-]+)/.exec(props.className ?? '')?.[1];
      const text = String(props.children ?? '').replace(/\n$/, '');
      if (lang === 'duckview-metric') return <MetricCard block={m.metricBlocks?.find((b) => b.text.trim() === text.trim())} workspaceId={wsId} />;
      if (lang === 'duckview-build') return <BuildCard text={text} block={m.buildBlocks?.find((b) => b.text.trim() === text.trim())} workspaceId={wsId} onFix={fixBuild} />;
      if ((lang === 'yaml' || lang === 'yml' || lang === 'json') && looksLikeSpec(text)) return <SpecBlock text={text} verdict={m.specBlocks?.find((b) => b.text.trim() === text.trim())} workspaceId={wsId} onFix={fixSpec} />;
      return mdComponents.code(props);
    },
  });
  const mdComponents = {
    code({ className, children, ...props }: { className?: string; children?: ReactNode; inline?: boolean }) {
      const lang = /language-(\w+)/.exec(className ?? '')?.[1];
      const text = String(children ?? '').replace(/\n$/, '');
      const isSql = lang === 'sql' || (!lang && text.includes('\n') && /^\s*(select|with|from|summarize|describe|pivot)\b/i.test(text));
      if (isSql) return <SqlBlock sql={text} onInsert={() => host?.insertSql(text)} onNewTab={() => host?.newTabWithSql(text, 'Copilot')} onRun={() => void runAndInspect(text)} onDbt={() => setDbtSql(text)} busy={running === text} />;
      if (props.inline || !text.includes('\n')) return <code className="rounded bg-zinc-800 px-1 py-0.5 font-mono text-2xs text-accent-200">{text}</code>;
      return <pre className="my-2 overflow-auto rounded-md border border-zinc-800 bg-zinc-950 p-2.5 font-mono text-2xs text-zinc-200">{text}</pre>;
    },
    p: ({ children }: { children?: ReactNode }) => <p className="my-1.5 leading-relaxed">{children}</p>,
    ul: ({ children }: { children?: ReactNode }) => <ul className="my-1.5 list-disc space-y-0.5 pl-5">{children}</ul>,
    ol: ({ children }: { children?: ReactNode }) => <ol className="my-1.5 list-decimal space-y-0.5 pl-5">{children}</ol>,
    h1: ({ children }: { children?: ReactNode }) => <h3 className="mt-3 mb-1 text-body font-semibold text-zinc-50">{children}</h3>,
    h2: ({ children }: { children?: ReactNode }) => <h3 className="mt-3 mb-1 text-body font-semibold text-zinc-50">{children}</h3>,
    h3: ({ children }: { children?: ReactNode }) => <h4 className="mt-2 mb-1 text-body font-semibold text-zinc-100">{children}</h4>,
    table: ({ children }: { children?: ReactNode }) => <table className="my-2 w-full border-collapse font-mono text-2xs">{children}</table>,
    th: ({ children }: { children?: ReactNode }) => <th className="border border-zinc-800 bg-zinc-900 px-2 py-1 text-left">{children}</th>,
    td: ({ children }: { children?: ReactNode }) => <td className="border border-zinc-800 px-2 py-1">{children}</td>,
    a: ({ children, href }: { children?: ReactNode; href?: string }) => <a href={href} className="text-accent-300 underline" target="_blank" rel="noreferrer">{children}</a>,
  };

  // What the assistant is looking at: picked datasets, else the dataset or query or dashboard on screen.
  const activeTab = ws.tabs.find((t) => t.id === ws.activeTabId);
  const onScreen = location.hash.startsWith('#/data') || location.hash === '' || location.hash === '#/'
    ? (wsId ? ws.overviewTarget[wsId] : null)
    : location.hash.startsWith('#/query')
      ? activeTab ? `${activeTab.title} (SQL)` : null
      : location.hash.startsWith('#/dashboards/') ? 'this dashboard' : null;
  const contextChips = cp.targets.length ? cp.targets : [...(onScreen ? [onScreen] : []), ws.workspaces.find((w) => w.id === wsId)?.name ?? 'workspace'];

  return (
    <aside className="relative flex h-full shrink-0 flex-col border-l border-zinc-800 bg-zinc-950" style={{ width: cp.width, maxWidth: '38vw', minWidth: 320 }} aria-label="DuckView AI">
      <div
        className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize hover:bg-accent-700/40"
        onMouseDown={(e) => {
          dragging.current = true;
          const startX = e.clientX;
          const startW = cp.width;
          const move = (ev: MouseEvent) => dragging.current && cp.setWidth(startW - (ev.clientX - startX));
          const up = () => {
            dragging.current = false;
            window.removeEventListener('mousemove', move);
            window.removeEventListener('mouseup', up);
          };
          window.addEventListener('mousemove', move);
          window.addEventListener('mouseup', up);
        }}
      />
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-zinc-800 px-3">
        <Sparkles className="h-4 w-4 text-accent-500" />
        <span className="shrink-0 whitespace-nowrap text-body font-semibold text-zinc-50">DuckView AI</span>
        <span className="min-w-0 truncate text-2xs text-zinc-500" title={effectiveModel ?? ''}>
          {effectiveProvider ? `${labelOf(effectiveProvider)} · ${effectiveModel}` : 'not configured'}
        </span>
        {(cp.usage.requests > 0 || cp.streaming) && (
          <span className="shrink-0 rounded border border-zinc-800 px-1.5 py-0.5 font-mono text-2xs text-zinc-400" title={`This conversation: ${cp.usage.input_tokens.toLocaleString()} input + ${cp.usage.output_tokens.toLocaleString()} output tokens over ${cp.usage.requests} turn${cp.usage.requests === 1 ? '' : 's'}`}>
            {cp.streaming && <Loader2 className="mr-1 inline h-3 w-3 animate-spin text-accent-300" />}{fmtTokens(cp.usage.input_tokens + cp.usage.output_tokens)} tok
          </span>
        )}
        <div className="ml-auto flex items-center gap-0.5">
          <button onClick={() => setShowConvs(!showConvs)} className="rounded p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100" title="Conversations">
            <History className="h-4 w-4" />
          </button>
          <button onClick={() => setShowSettings(!showSettings)} className={cn('rounded p-1.5 hover:bg-zinc-800 hover:text-zinc-100', showSettings ? 'text-accent-300' : 'text-zinc-400')} title="Provider settings">
            <Settings2 className="h-4 w-4" />
          </button>
          <button onClick={() => cp.toggle(false)} className="rounded p-1.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100" title="Close">
            <X className="h-4 w-4" />
          </button>
        </div>
      </header>

      {/* What the assistant is looking at */}
      <div className="flex min-h-8 shrink-0 flex-wrap items-center gap-1.5 border-b border-zinc-800 px-3 py-1.5 text-xs" data-testid="ai-context">
        <span className="text-zinc-500">Context</span>
        {contextChips.map((c) => (
          <span key={c} className="inline-flex max-w-[14rem] items-center truncate rounded bg-zinc-900 px-1.5 py-0.5 font-mono text-2xs text-zinc-300" title={c}>{c}</span>
        ))}
        {cp.targets.length > 0 && <button className="text-2xs text-zinc-500 hover:text-zinc-200" onClick={() => cp.setTargets([])}>clear</button>}
      </div>

      {showConvs && (
        <div className="border-b border-zinc-800 bg-zinc-900/60 p-2 text-xs">
          <div className="mb-1 flex items-center justify-between px-1 text-2xs font-semibold text-zinc-500">
            <span>Conversations</span>
            <button className="text-accent-300 hover:underline" onClick={() => wsId && void cp.openConversation(wsId, null)}>
              + new
            </button>
          </div>
          <div className="max-h-40 overflow-auto">
            {cp.conversations.length === 0 && <div className="px-1 py-1 text-zinc-600">No conversations yet.</div>}
            {cp.conversations.map((c) => (
              <button key={c.id} onClick={() => wsId && void cp.openConversation(wsId, c.id).then(() => setShowConvs(false))} className={cn('flex w-full items-center justify-between rounded px-2 py-1 text-left hover:bg-zinc-800', c.id === cp.conversationId && 'bg-zinc-800')}>
                <span className="truncate text-zinc-200">{c.title || 'Untitled'}</span>
                <span className="ml-2 shrink-0 font-mono text-2xs text-zinc-500">{c.messages}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {showSettings && cfg && (
        <div className="space-y-2 border-b border-zinc-800 bg-zinc-900/60 p-3 text-xs">
          <div className="flex items-center gap-1.5 text-2xs font-semibold text-zinc-500">
            <KeyRound className="h-3 w-3" /> Provider
          </div>
          <Select value={cp.settings.provider} onChange={(e) => { cp.setSettings({ provider: e.target.value as typeof cp.settings.provider, model: '', apiKey: '', baseUrl: '' }); setModels([]); }} className="h-8 w-full text-xs" disabled={!cfg.allow_byok}>
            <option value="">{cfg.server_provider ? `Server-managed: ${labelOf(cfg.server_provider)} (${cfg.server_model})` : 'Server-managed: none configured'}</option>
            {cfg.allow_byok && cfg.providers.map((p) => (
              <option key={p.id} value={p.id}>
                Bring your own: {p.label}{p.vendor !== 'Any' && p.vendor !== 'Local' ? ` (${p.vendor})` : ''}
              </option>
            ))}
          </Select>
          <a href="#/settings/copilot" onClick={() => cp.toggle(false)} className="inline-flex items-center gap-1 text-2xs text-accent-300 hover:underline"><Settings2 className="h-3 w-3" /> Manage providers, keys and usage in Settings</a>
          {cp.settings.provider && AWS.has(cp.settings.provider) && (
            <div className="space-y-2">
              <p className="text-2xs text-zinc-500">Uses the DuckView server's AWS credentials (default credential chain). {cp.settings.provider === 'bedrock_agent' && 'Bedrock Agents Classic is closed to new customers — prefer AgentCore for new agents.'}</p>
              {invokable.length > 0 && (
                <div>
                  <Label>Registered agents</Label>
                  <Select
                    value=""
                    onChange={(e) => {
                      const a = invokable.find((x) => x.id === e.target.value);
                      if (!a) return;
                      if (a.framework === 'bedrock_agent') cp.setSettings({ provider: 'bedrock_agent', region: a.config.region ?? '', agentId: a.config.agent_id ?? '', agentAliasId: a.config.agent_alias_id ?? '', model: '' });
                      else cp.setSettings({ provider: 'agentcore', region: a.config.region ?? '', runtimeArn: a.config.runtime_arn ?? '', model: '' });
                    }}
                    className="h-8 w-full text-xs"
                  >
                    <option value="">Pick from the Agent hub…</option>
                    {invokable.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name} · {a.framework === 'bedrock_agent' ? 'Bedrock Agent' : 'AgentCore'}
                      </option>
                    ))}
                  </Select>
                </div>
              )}
              <div>
                <Label>AWS region</Label>
                <Input value={cp.settings.region ?? ''} onChange={(e) => cp.setSettings({ region: e.target.value })} className="h-8 font-mono text-xs" placeholder={cfg.server_aws?.region ?? 'us-east-1'} />
              </div>
              {cp.settings.provider === 'bedrock_agent' && (
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <Label>Agent id</Label>
                    <Input value={cp.settings.agentId ?? ''} onChange={(e) => cp.setSettings({ agentId: e.target.value })} className="h-8 font-mono text-xs" />
                  </div>
                  <div>
                    <Label>Alias id</Label>
                    <Input value={cp.settings.agentAliasId ?? ''} onChange={(e) => cp.setSettings({ agentAliasId: e.target.value })} className="h-8 font-mono text-xs" />
                  </div>
                </div>
              )}
              {cp.settings.provider === 'agentcore' && (
                <div>
                  <Label>Runtime ARN</Label>
                  <Input value={cp.settings.runtimeArn ?? ''} onChange={(e) => cp.setSettings({ runtimeArn: e.target.value })} className="h-8 font-mono text-xs" placeholder="arn:aws:bedrock-agentcore:…:runtime/…" />
                </div>
              )}
              {cp.settings.provider === 'bedrock' && (
                <div>
                  <Label>Model / inference profile</Label>
                  <div className="flex gap-1">
                    <Input list="copilot-models" value={cp.settings.model} onChange={(e) => cp.setSettings({ model: e.target.value })} className="h-8 font-mono text-xs" placeholder={cfg.default_models.bedrock} />
                    <datalist id="copilot-models">{[...new Set([...(cfg.suggested_models.bedrock ?? []), ...models])].map((m) => <option key={m} value={m} />)}</datalist>
                    <Button size="sm" onClick={fetchModels} loading={modelsBusy} title="List Anthropic models and inference profiles in the region">
                      Fetch
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
          {cp.settings.provider && !AWS.has(cp.settings.provider) && (
            <>
              {cfg.providers.find((p) => p.id === cp.settings.provider)?.keyRequired && (
                <div>
                  <Label>
                    API key <span className="normal-case text-zinc-600">(kept in this browser only)</span>
                    {cfg.providers.find((p) => p.id === cp.settings.provider)?.keyUrl && <a href={cfg.providers.find((p) => p.id === cp.settings.provider)!.keyUrl!} target="_blank" rel="noreferrer" className="ml-1 normal-case text-accent-300 hover:underline">get one ↗</a>}
                  </Label>
                  <Input type="password" value={cp.settings.apiKey} onChange={(e) => cp.setSettings({ apiKey: e.target.value })} className="h-8 font-mono text-xs" autoComplete="off" placeholder={`${cfg.providers.find((p) => p.id === cp.settings.provider)?.keyPrefix ?? ''}…`} />
                </div>
              )}
              {cp.settings.provider !== 'anthropic' && (
                <div>
                  <Label>Base URL {cfg.providers.find((p) => p.id === cp.settings.provider)?.baseUrl ? <span className="normal-case text-zinc-600">(optional override)</span> : ''}</Label>
                  <Input value={cp.settings.baseUrl} onChange={(e) => cp.setSettings({ baseUrl: e.target.value })} className="h-8 font-mono text-xs" placeholder={cfg.providers.find((p) => p.id === cp.settings.provider)?.baseUrl ?? 'https://api.example.com/v1'} />
                </div>
              )}
              <div>
                <Label>Model</Label>
                <div className="flex gap-1">
                  <Input list="copilot-models" value={cp.settings.model} onChange={(e) => cp.setSettings({ model: e.target.value })} className="h-8 font-mono text-xs" placeholder={cfg.default_models[cp.settings.provider]} />
                  <datalist id="copilot-models">{[...new Set([...(cfg.suggested_models[cp.settings.provider] ?? []), ...models])].map((m) => <option key={m} value={m} />)}</datalist>
                  <Button size="sm" onClick={fetchModels} loading={modelsBusy} title="List models from the provider">
                    Fetch
                  </Button>
                </div>
              </div>
            </>
          )}
          {!cfg.allow_byok && <p className="text-2xs text-zinc-500">Keys are managed by the server administrator.</p>}
        </div>
      )}

      <div ref={scroller} className="min-h-0 flex-1 overflow-auto px-3 py-3 text-body text-zinc-200">
        {!ready && (
          <div className="rounded-md border border-amber-900 bg-amber-950/40 p-3 text-xs text-amber-200">
            {cfg?.enabled === false ? 'DuckView AI is turned off on this server.' : <>No model is set up yet. <a href="#/settings/copilot" onClick={() => cp.toggle(false)} className="text-accent-300 hover:underline">Open Settings → AI assistant</a> to pick Claude, ChatGPT, Gemini, DeepSeek, OpenRouter, Kimi, Groq, Mistral, Grok, a local Ollama or any OpenAI-compatible endpoint and paste a key{cfg?.can_manage ? ' for everyone' : ' for yourself'}.</>}
          </div>
        )}
        {ready && cp.messages.length === 0 && (
          <div className="space-y-3">
            <p className="text-xs text-zinc-500">Ask about your data in plain words. DuckView AI sees this workspace's tables, files, metrics and dbt models, and the SQL you are editing.</p>
            <div className="text-2xs font-medium text-zinc-500">Suggested questions</div>
            <div className="grid gap-1">
              {[
                ['Which regions had the highest revenue growth month over month?', 'Trend + window functions'],
                ['Find duplicate customers by normalised email', 'Data quality'],
                ['Pivot orders by product into monthly columns', 'PIVOT'],
                ['Build a dashboard of the key numbers in this workspace', 'Dashboard, checked before it is created'],
                ['Build a data app to explore the biggest table by its categories', 'Streamlit data app'],
                ['Build a cross-filtered dashboard of trips by hour, distance and fare', 'Mosaic dashboard'],
              ].map(([q, hint]) => (
                <button key={q} onClick={() => setInput(q ?? "")} className="rounded-md px-2 py-1.5 text-left text-xs text-zinc-300 hover:bg-zinc-900" title={hint}>
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}
        {cp.messages.map((m) => (
          <div key={m.id} className={cn('mb-3', m.role === 'user' ? 'flex justify-end' : '')}>
            {m.role === 'user' ? (
              <div className="max-w-[90%] whitespace-pre-wrap rounded-lg bg-zinc-800 px-3 py-2 text-body text-zinc-100">{m.content}</div>
            ) : (
              <div className="max-w-full">
                {m.meta && (m.meta.tables != null || m.meta.model) && (
                  <div className="mb-1 flex flex-wrap gap-x-2 font-mono text-2xs text-zinc-500">
                    {m.meta.model && <span>{m.meta.model}</span>}
                    {m.meta.tables != null && <span>· {m.meta.tables} tables · {m.meta.files} files{m.meta.targets?.length ? ` · profiled ${m.meta.targets.join(', ')}` : ''}</span>}
                    {m.meta.duration_ms != null && <span>· {(m.meta.duration_ms / 1000).toFixed(1)}s</span>}
                    {m.meta.input_tokens != null && <span title="input + output tokens for this turn">· {fmtTokens(m.meta.input_tokens)} in / {fmtTokens(m.meta.output_tokens ?? 0)} out</span>}
                  </div>
                )}
                <div className="prose-sm">
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponentsFor(m) as never}>{m.content || (m.streaming ? '…' : '')}</ReactMarkdown>
                </div>
                {m.streaming && <span className="inline-block h-3 w-1.5 animate-pulse bg-accent-400" />}
                {m.error && <div className="mt-1 rounded-md border border-red-900 bg-red-950/40 px-2 py-1 text-2xs text-red-200">{m.error}</div>}
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="shrink-0 border-t border-zinc-800 p-2">
        <div className="mb-1.5 flex flex-wrap gap-1">
          <button onClick={() => submit('suggest')} disabled={!ready || cp.streaming} className="inline-flex items-center gap-1 rounded-md border border-zinc-800 px-2 py-1 text-2xs text-zinc-300 hover:border-zinc-600 disabled:opacity-40" title={cp.targets.length ? `Suggest questions for ${cp.targets.join(', ')}` : 'Suggest questions for this workspace'}>
            <Sparkles className="h-3 w-3 text-zinc-500" /> Suggest questions{cp.targets.length ? ` (${cp.targets.length})` : ''}
          </button>
          <button onClick={() => submit('fix')} disabled={!ready || cp.streaming || !host?.activeSql()} className="inline-flex items-center gap-1 rounded-md border border-zinc-800 px-2 py-1 text-2xs text-zinc-300 hover:border-zinc-600 disabled:opacity-40" title="Send the active tab's SQL and its last error">
            <Wrench className="h-3 w-3 text-zinc-500" /> Fix my query{host?.activeError() ? ' (error)' : ''}
          </button>
          <button onClick={() => submit('dashboard')} disabled={!ready || cp.streaming} className="inline-flex items-center gap-1 rounded-md border border-zinc-800 px-2 py-1 text-2xs text-zinc-300 hover:border-zinc-600 disabled:opacity-40" title={cp.targets.length ? `Draft an interactive Mosaic dashboard for ${cp.targets.join(', ')} (type a goal above to steer it)` : 'Draft an interactive Mosaic dashboard — select a dataset or describe what you want above'}>
            <LayoutDashboard className="h-3 w-3 text-zinc-500" /> Build dashboard{cp.targets.length ? ` (${cp.targets.length})` : ''}
          </button>
          {cp.messages.length > 0 && (
            <button onClick={() => wsId && void cp.clear(wsId)} className="ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1 text-2xs text-zinc-500 hover:text-red-300" title="Delete this conversation">
              <Trash2 className="h-3 w-3" />
            </button>
          )}
        </div>
        <div className="flex items-end gap-1.5">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            rows={2}
            placeholder={ready ? 'Ask about your data… (Enter to send, Shift+Enter for a new line)' : 'Configure a provider first'}
            disabled={!ready}
            className="min-h-[40px] flex-1 resize-none rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-accent-500 focus:outline-none disabled:opacity-50"
          />
          {cp.streaming ? (
            <Button variant="danger" size="sm" onClick={cp.cancel} title="Stop">
              <Square className="h-3.5 w-3.5" />
            </Button>
          ) : (
            <Button variant="primary" size="sm" onClick={() => submit()} disabled={!ready || !input.trim()} title="Send">
              <Send className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
        <div className="mt-1 flex items-center gap-1 text-2xs text-zinc-600">
          <ChevronDown className="h-3 w-3" /> context: schema of all tables, data files, buckets{cp.targets.length ? `, SUMMARIZE of ${cp.targets.join(', ')}` : ''}, active SQL
        </div>
      </div>
      {dbtSql !== null && wsId && <SaveDbtModelDialog workspaceId={wsId} sql={dbtSql} onClose={() => setDbtSql(null)} />}
    </aside>
  );
}
