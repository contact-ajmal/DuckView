import { useEffect, useMemo, useState } from 'react';
import { Download, Plus, Trash2, TriangleAlert } from 'lucide-react';
import { api, authedBlobUrl, formatBytes } from '../../api/client';
import { Button, Input, Label, Menu, MenuItem, Modal, Select, Tabs, cn, InlineError } from '../../components/ui';
import { useAuth } from '../../store/auth';
import { useWorkspace } from '../../store/workspace';
import { DataTable } from '../../components/data';

interface Cost { compute: number; ai: number; storage: number; total: number }
interface UsageReport {
  scope: 'org' | 'self';
  range: { from: string; to: string; days: number };
  currency: string;
  rates: { compute_per_hour: number; storage_per_gb_month: number };
  totals: { queries: number; errors: number; query_seconds: number; pipeline_runs: number; pipeline_seconds: number; ai_turns: number; ai_input_tokens: number; ai_output_tokens: number; storage_bytes: number; byok_ai_cost: number; unpriced_models: string[]; cost: Cost };
  daily: { date: string; queries: number; compute_seconds: number; ai_tokens: number; cost: Cost }[];
  workspaces: { id: string; name: string; queries: number; compute_seconds: number; ai_tokens: number; storage_bytes: number; cost: Cost }[];
  users: { id: string; email: string; queries: number; compute_seconds: number; ai_tokens: number; cost: Cost }[];
  sources: { source: 'people' | 'agents' | 'pipelines'; runs: number; seconds: number; cost: number }[];
  models: { model: string; provider: string; turns: number; input_tokens: number; output_tokens: number; cost: number; byok_turns: number; priced: boolean }[];
  top_queries: { sql: string; workspace_id: string | null; runs: number; total_seconds: number; avg_ms: number; cost: number }[];
}
interface Budget { id: string; name: string; workspace_id: string | null; amount: number; thresholds: number[]; forecast: boolean; channel_ids: string[]; spent: number; forecast_spend: number; percent: number; period: string }
interface Channel { id: string; name: string; type: string }

/** The three parts of a cost, in the order and colours used everywhere on this page. */
const PARTS = [
  { key: 'compute', label: 'Compute', color: 'bg-[color:var(--series-1)]', fill: 'fill-[color:var(--series-1)]' },
  { key: 'ai', label: 'AI', color: 'bg-[color:var(--series-2)]', fill: 'fill-[color:var(--series-2)]' },
  { key: 'storage', label: 'Storage', color: 'bg-[color:var(--series-3)]', fill: 'fill-[color:var(--series-3)]' },
] as const;

const hours = (s: number) => (s >= 3600 ? `${(s / 3600).toFixed(1)} h` : s >= 60 ? `${(s / 60).toFixed(1)} min` : `${s.toFixed(1)} s`);
const compact = (n: number) => new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n);

/** Settings → Usage & cost: what was used, what it cost at the configured rates, and monthly budgets. */
export function UsagePanel() {
  const isAdmin = useAuth((a) => a.user?.role === 'ADMIN');
  const ws = useWorkspace();
  const [days, setDays] = useState<'7' | '30' | '90'>('30');
  const [mine, setMine] = useState(false);
  const [report, setReport] = useState<UsageReport | null>(null);
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const query = `days=${days}${mine ? '&mine=1' : ''}`;
  const load = () => {
    void api.get<UsageReport>(`/api/usage?${query}`).then((r) => { setReport(r); setError(null); }).catch((e: Error) => setError(e.message));
    void api.get<{ budgets: Budget[] }>('/api/usage/budgets').then((r) => setBudgets(r.budgets)).catch(() => setBudgets([]));
  };
  useEffect(load, [query]); // eslint-disable-line react-hooks/exhaustive-deps

  const money = useMemo(() => {
    const f = new Intl.NumberFormat(undefined, { style: 'currency', currency: report?.currency ?? 'USD', maximumFractionDigits: 2 });
    return (n: number) => (n > 0 && n < 0.01 ? `< ${f.format(0.01)}` : f.format(n));
  }, [report?.currency]);

  const download = async (by: 'day' | 'workspace' | 'user') => {
    const url = await authedBlobUrl(`/api/usage/export.csv?by=${by}&${query}`);
    const a = document.createElement('a');
    a.href = url;
    a.download = `duckview-usage-by-${by}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (error) return <p className="text-xs text-red-300">{error}</p>;
  if (!report) return null;
  const t = report.totals;

  return (
    <div className="space-y-6 text-xs" data-testid="usage-panel">
      <div className="flex flex-wrap items-center gap-3">
        <Tabs size="sm" value={days} onChange={setDays} tabs={[{ id: '7', label: '7 days' }, { id: '30', label: '30 days' }, { id: '90', label: '90 days' }]} />
        {isAdmin && (
          <label className="flex items-center gap-1.5 text-zinc-400">
            <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> Only my usage
          </label>
        )}
        <div className="ml-auto">
          <Menu width="w-40" trigger={(_open, toggle) => <Button size="sm" onClick={toggle}><Download className="h-3.5 w-3.5" /> Export CSV</Button>}>
            {(close) => (['day', 'workspace', 'user'] as const).map((by) => <MenuItem key={by} onClick={() => { close(); void download(by); }}>{by === 'day' ? 'By day' : by === 'workspace' ? 'By workspace' : 'By person'}</MenuItem>)}
          </Menu>
        </div>
      </div>

      {/* The total, and what it is made of. */}
      <div className="grid grid-cols-2 gap-x-8 gap-y-4 border-y border-zinc-800 py-4 md:grid-cols-[1.4fr_1fr_1fr_1fr]">
        <div>
          <div className="text-zinc-500">{report.scope === 'org' ? 'Organisation' : 'Your'} cost, last {days} days</div>
          <div className="mt-1 text-page font-semibold tabular-nums text-zinc-50" data-testid="usage-total">{money(t.cost.total)}</div>
          <div className="mt-1 flex h-1.5 w-full max-w-60 overflow-hidden rounded-full bg-zinc-800">
            {PARTS.map((p) => <div key={p.key} className={p.color} style={{ width: `${t.cost.total ? (t.cost[p.key] / t.cost.total) * 100 : 0}%` }} />)}
          </div>
        </div>
        <Figure label="Compute" swatch={PARTS[0].color} value={money(t.cost.compute)} sub={`${compact(t.queries)} queries · ${hours(t.query_seconds + t.pipeline_seconds)}`} />
        <Figure label="AI" swatch={PARTS[1].color} value={money(t.cost.ai)} sub={`${compact(t.ai_turns)} turns · ${compact(t.ai_input_tokens + t.ai_output_tokens)} tokens`} />
        <Figure label="Storage" swatch={PARTS[2].color} value={money(t.cost.storage)} sub={formatBytes(t.storage_bytes)} />
      </div>

      <DailyChart daily={report.daily} money={money} />

      {(t.unpriced_models.length > 0 || t.byok_ai_cost > 0) && (
        <div className="space-y-1 text-zinc-400">
          {t.byok_ai_cost > 0 && <p>People's own AI keys paid {money(t.byok_ai_cost)} more; that is not counted above.</p>}
          {t.unpriced_models.length > 0 && <p className="flex items-center gap-1.5 text-amber-300"><TriangleAlert className="h-3.5 w-3.5" /> No price for {t.unpriced_models.join(', ')}: add it under usage.model_prices to count its tokens.</p>}
        </div>
      )}

      <Budgets budgets={budgets} money={money} isAdmin={isAdmin} onAdd={() => setAdding(true)} onRemove={async (id) => { await api.del(`/api/usage/budgets/${id}`); load(); }} workspaceName={(id) => ws.workspaces.find((w) => w.id === id)?.name ?? 'a workspace'} />

      <div className="grid gap-6 xl:grid-cols-2">
        <Table title="Workspaces" testid="usage-workspaces" head={['Workspace', 'Queries', 'Compute', 'AI tokens', 'Storage', 'Cost']} rows={report.workspaces.map((w) => [w.name, compact(w.queries), hours(w.compute_seconds), compact(w.ai_tokens), formatBytes(w.storage_bytes), money(w.cost.total)])} />
        <Table title={report.scope === 'org' ? 'People' : 'You'} head={['Person', 'Queries', 'Compute', 'AI tokens', 'Cost']} rows={report.users.map((u) => [u.email, compact(u.queries), hours(u.compute_seconds), compact(u.ai_tokens), money(u.cost.total)])} />
        <Table title="Who ran the work" head={['Source', 'Runs', 'Time', 'Compute cost']} rows={report.sources.map((s) => [s.source === 'people' ? 'People (workbench, dashboards, BI tools)' : s.source === 'agents' ? 'Agents (MCP, API tokens)' : 'Pipelines (syncs, reverse syncs, dbt)', compact(s.runs), hours(s.seconds), money(s.cost)])} />
        <Table title="AI models" head={['Model', 'Turns', 'Input', 'Output', 'Cost']} rows={report.models.map((m) => [`${m.model}${m.byok_turns ? ` (${m.byok_turns} on own key)` : ''}`, compact(m.turns), compact(m.input_tokens), compact(m.output_tokens), m.priced ? money(m.cost) : 'no price'])} />
      </div>

      <Table title="Most expensive queries" head={['Query', 'Runs', 'Total time', 'Average', 'Cost']} wide rows={report.top_queries.map((q) => [<code key="q" className="block truncate font-mono text-2xs text-zinc-300" title={q.sql}>{q.sql.replace(/\s+/g, ' ')}</code>, compact(q.runs), hours(q.total_seconds), `${q.avg_ms} ms`, money(q.cost)])} />

      <p className="text-zinc-500">
        Priced at {money(report.rates.compute_per_hour)} per hour of query time and {money(report.rates.storage_per_gb_month)} per GB-month of storage, with list prices for AI models. Administrators set the rates in the <code className="font-mono">usage</code> section of the configuration.
      </p>

      {adding && <BudgetForm isAdmin={isAdmin} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); load(); }} currency={report.currency} />}
    </div>
  );
}

function Figure({ label, swatch, value, sub }: { label: string; swatch: string; value: string; sub: string }) {
  return (
    <div>
      <div className="flex items-center gap-1.5 text-zinc-500"><span className={cn('h-2 w-2 rounded-sm', swatch)} />{label}</div>
      <div className="mt-1 text-title font-medium tabular-nums text-zinc-100">{value}</div>
      <div className="text-zinc-500">{sub}</div>
    </div>
  );
}

/** Cost per day, stacked by part. */
function DailyChart({ daily, money }: { daily: UsageReport['daily']; money: (n: number) => string }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(...daily.map((d) => d.cost.total), 0);
  const h = 120;
  if (!daily.length) return null;
  const barW = 100 / daily.length;
  const d = hover !== null ? daily[hover] : null;
  return (
    <div data-testid="usage-chart">
      <div className="mb-1 flex h-4 items-center gap-3 text-zinc-500">
        {d ? (
          <span className="tabular-nums text-zinc-300">{new Date(`${d.date}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })}: {money(d.cost.total)} · {d.queries} queries</span>
        ) : (
          PARTS.map((p) => <span key={p.key} className="flex items-center gap-1"><span className={cn('h-2 w-2 rounded-sm', p.color)} />{p.label}</span>)
        )}
      </div>
      <svg viewBox={`0 0 100 ${h}`} preserveAspectRatio="none" className="h-32 w-full" onMouseLeave={() => setHover(null)} role="img" aria-label="Cost per day">
        {daily.map((day, i) => {
          let y = h;
          return (
            <g key={day.date} onMouseEnter={() => setHover(i)} className={cn(hover !== null && hover !== i && 'opacity-50')}>
              <rect x={i * barW} y={0} width={barW} height={h} className="fill-transparent" />
              {PARTS.map((p) => {
                const v = max ? (day.cost[p.key] / max) * (h - 4) : 0;
                y -= v;
                return v > 0 ? <rect key={p.key} x={i * barW + barW * 0.15} y={y} width={barW * 0.7} height={v} className={p.fill} /> : null;
              })}
            </g>
          );
        })}
        <line x1="0" x2="100" y1={h - 0.25} y2={h - 0.25} className="stroke-zinc-700" strokeWidth="0.5" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="mt-1 flex justify-between text-2xs text-zinc-600">
        <span>{daily[0]!.date}</span>
        <span>highest day {money(max)}</span>
        <span>{daily.at(-1)!.date}</span>
      </div>
    </div>
  );
}

function Budgets({ budgets, money, isAdmin, onAdd, onRemove, workspaceName }: { budgets: Budget[]; money: (n: number) => string; isAdmin: boolean; onAdd: () => void; onRemove: (id: string) => Promise<void>; workspaceName: (id: string) => string }) {
  return (
    <section data-testid="usage-budgets">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-body font-medium text-zinc-100">Monthly budgets</h3>
        <Button size="sm" onClick={onAdd}><Plus className="h-3.5 w-3.5" /> Add budget</Button>
      </div>
      {budgets.length === 0 ? (
        <p className="text-zinc-500">No budgets. A budget tells a channel when this month's spend {isAdmin ? 'for the organisation or a workspace' : 'for one of your workspaces'} passes a share of the amount.</p>
      ) : (
        <ul className="space-y-3">
          {budgets.map((b) => {
            const pct = Math.min(b.percent, 100);
            const fc = b.amount ? Math.min((b.forecast_spend / b.amount) * 100, 100) : 0;
            const over = b.spent >= b.amount;
            return (
              <li key={b.id} data-budget={b.name}>
                <div className="flex items-baseline gap-2">
                  <span className="font-medium text-zinc-200">{b.name}</span>
                  <span className="text-zinc-500">{b.workspace_id ? workspaceName(b.workspace_id) : 'Organisation'} · notifies at {b.thresholds.join(', ')}%{b.forecast ? ' of the forecast' : ''}</span>
                  <span className={cn('ml-auto tabular-nums', over ? 'text-red-300' : 'text-zinc-300')}>{money(b.spent)} of {money(b.amount)}</span>
                  <button className="text-zinc-600 hover:text-zinc-300" aria-label={`Remove ${b.name}`} onClick={() => void onRemove(b.id)}><Trash2 className="h-3.5 w-3.5" /></button>
                </div>
                <div className="relative mt-1.5 h-1.5 rounded-full bg-zinc-800" title={`Forecast for the month: ${money(b.forecast_spend)}`}>
                  <div className={cn('h-full rounded-full', over ? 'bg-red-500' : pct >= Math.min(...b.thresholds) ? 'bg-amber-400' : 'bg-emerald-500')} style={{ width: `${pct}%` }} />
                  {fc > pct && <div className="absolute top-[-3px] h-3 w-px bg-zinc-400" style={{ left: `${fc}%` }} />}
                </div>
                <div className="mt-1 text-zinc-500">{b.percent}% used · month-end forecast {money(b.forecast_spend)}</div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function BudgetForm({ isAdmin, onClose, onSaved, currency }: { isAdmin: boolean; onClose: () => void; onSaved: () => void; currency: string }) {
  const ws = useWorkspace();
  const owned = ws.workspaces.filter((w) => w.role === 'OWNER');
  const [scope, setScope] = useState<string>(isAdmin ? '' : owned[0]?.id ?? '');
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('100');
  const [thresholds, setThresholds] = useState('80, 100');
  const [forecast, setForecast] = useState(false);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setPicked([]);
    void api.get<{ channels: Channel[] }>(scope ? `/api/workspaces/${scope}/channels` : '/api/channels').then((r) => setChannels(r.channels)).catch(() => setChannels([]));
  }, [scope]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.post('/api/usage/budgets', { name: name || undefined, workspace_id: scope || null, amount: Number(amount), thresholds: thresholds.split(/[,\s]+/).filter(Boolean).map(Number), forecast, channel_ids: picked });
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open onClose={onClose} title="Add a monthly budget">
      <div className="space-y-3 text-xs" data-testid="budget-form">
        <div>
          <Label>For</Label>
          <Select value={scope} onChange={(e) => setScope(e.target.value)} name="budget-scope">
            {isAdmin && <option value="">The organisation</option>}
            {owned.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </Select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Amount per month ({currency})</Label>
            <Input name="budget-amount" type="number" min="1" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
          <div>
            <Label>Notify at (% of the amount)</Label>
            <Input name="budget-thresholds" value={thresholds} onChange={(e) => setThresholds(e.target.value)} />
          </div>
        </div>
        <div>
          <Label>Name (optional)</Label>
          <Input name="budget-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={scope ? 'Workspace monthly budget' : 'Organisation monthly budget'} />
        </div>
        <label className="flex items-center gap-2 text-zinc-300"><input type="checkbox" checked={forecast} onChange={(e) => setForecast(e.target.checked)} /> Notify early, when the month-end forecast passes a threshold</label>
        <div>
          <Label>Notify</Label>
          {channels.length === 0 ? <p className="text-zinc-500">No channels here yet. Add one under Dashboards → Channels; the budget still shows on this page.</p> : (
            <div className="max-h-32 space-y-1 overflow-auto">
              {channels.map((c) => (
                <label key={c.id} className="flex items-center gap-2 text-zinc-300">
                  <input type="checkbox" checked={picked.includes(c.id)} onChange={(e) => setPicked((p) => (e.target.checked ? [...p, c.id] : p.filter((x) => x !== c.id)))} /> {c.name} <span className="text-zinc-600">{c.type}</span>
                </label>
              ))}
            </div>
          )}
        </div>
        <InlineError error={error} />
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={saving} onClick={() => void save()}>Add budget</Button>
        </div>
      </div>
    </Modal>
  );
}

function Table({ title, head, rows, wide, testid }: { title: string; head: string[]; rows: React.ReactNode[][]; wide?: boolean; testid?: string }) {
  return (
    <section className="min-w-0">
      <h3 className="mb-1.5 text-body font-medium text-zinc-100">{title}</h3>
      <DataTable
        label={title}
        testid={testid}
        pageSize={10}
        rows={rows.map((cells, i) => ({ i, cells }))}
        rowKey={(r) => String(r.i)}
        empty={<p className="py-2 text-zinc-500">Nothing in this period.</p>}
        columns={head.map((h, j) => ({
          key: String(j),
          header: h,
          align: j > 0 ? 'right' : 'left',
          numeric: j > 0,
          truncate: j === 0,
          width: wide && j > 0 ? 'w-24' : undefined,
          cell: (r: { cells: React.ReactNode[] }) => <span className={j === 0 ? 'text-zinc-200' : 'text-zinc-400'}>{r.cells[j]}</span>,
        }))}
      />
    </section>
  );
}
