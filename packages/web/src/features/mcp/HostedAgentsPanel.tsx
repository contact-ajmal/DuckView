import { useCallback, useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Bot, CheckCircle2, CircleAlert, Loader2, Pencil, Play, Plus, Trash2, Wrench } from 'lucide-react';
import { api, timeAgo, type AgentTemplate, type HostedAgent, type HostedAgentRun, type NotificationChannel, type SyncSchedule } from '../../api/client';
import { useWorkspace, useWorkspaceAccess } from '../../store/workspace';
import { byokBody } from '../../store/copilot';
import { Badge, Button, Input, Label, Select, cn } from '../../components/ui';
import { CHANNEL_META } from '../alerts/ChannelsPanel';

const tz = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const SCHEDULES: { id: string; label: string; make: () => SyncSchedule }[] = [
  { id: 'manual', label: 'Only when asked', make: () => ({ kind: 'manual' }) },
  { id: 'daily', label: 'Every morning (7:00)', make: () => ({ kind: 'cron', expression: '0 7 * * *', timezone: tz() }) },
  { id: 'weekdays', label: 'Weekday mornings (7:00)', make: () => ({ kind: 'cron', expression: '0 7 * * 1-5', timezone: tz() }) },
  { id: 'weekly', label: 'Mondays (8:00)', make: () => ({ kind: 'cron', expression: '0 8 * * 1', timezone: tz() }) },
  { id: 'hourly', label: 'Every hour', make: () => ({ kind: 'interval', minutes: 60 }) },
];
const scheduleId = (s: SyncSchedule) => (s.kind === 'manual' ? 'manual' : s.kind === 'interval' ? 'hourly' : s.expression === '0 7 * * 1-5' ? 'weekdays' : s.expression.endsWith('* * 1') ? 'weekly' : 'daily');
const every = (s: SyncSchedule) => (s.kind === 'interval' ? `every ${s.minutes / 60} h` : s.kind === 'cron' ? SCHEDULES.find((x) => x.id === scheduleId(s))?.label.toLowerCase() ?? `cron ${s.expression}` : 'when asked');

const MD = 'text-[13px] leading-relaxed text-zinc-300 [&_h1]:mb-1 [&_h1]:text-sm [&_h1]:font-semibold [&_h1]:text-zinc-100 [&_h2]:mb-1 [&_h2]:mt-3 [&_h2]:text-[13px] [&_h2]:font-semibold [&_h2]:text-zinc-100 [&_h3]:mt-2 [&_h3]:font-semibold [&_li]:ml-4 [&_li]:list-disc [&_ol_li]:list-decimal [&_p]:my-1.5 [&_code]:rounded [&_code]:bg-zinc-800 [&_code]:px-1 [&_code]:font-mono [&_code]:text-[11px] [&_table]:my-2 [&_td]:border [&_td]:border-zinc-800 [&_td]:px-2 [&_td]:py-0.5 [&_th]:border [&_th]:border-zinc-800 [&_th]:px-2 [&_th]:text-left';

type Draft = { id: string | null; name: string; description: string; instructions: string; task: string; tools: string[]; max_steps: number; schedule: string; channel_ids: string[] };
const draftOf = (a: HostedAgent): Draft => ({ id: a.id, name: a.name, description: a.description ?? '', instructions: a.instructions, task: a.task, tools: a.tools, max_steps: a.max_steps, schedule: scheduleId(a.schedule), channel_ids: a.channel_ids });

/** AI → DuckView agents: the marketplace, the workspace's hosted agents, and what each run did. */
export function HostedAgentsPanel() {
  const workspaceId = useWorkspace((s) => s.activeId);
  const { canEdit } = useWorkspaceAccess();
  const [templates, setTemplates] = useState<AgentTemplate[]>([]);
  const [tools, setTools] = useState<{ name: string; title: string; description: string }[]>([]);
  const [agents, setAgents] = useState<HostedAgent[]>([]);
  const [channels, setChannels] = useState<NotificationChannel[]>([]);
  const [selected, setSelected] = useState<string | null>(() => new URLSearchParams(location.hash.split('?')[1] ?? '').get('agent'));
  const [runs, setRuns] = useState<HostedAgentRun[]>([]);
  const [runId, setRunId] = useState<string | null>(() => new URLSearchParams(location.hash.split('?')[1] ?? '').get('run'));
  const [input, setInput] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!workspaceId) return;
    const r = await api.get<{ agents: HostedAgent[] }>(`/api/workspaces/${workspaceId}/hosted-agents`);
    setAgents(r.agents);
    setSelected((cur) => (cur && r.agents.some((a) => a.id === cur) ? cur : r.agents[0]?.id ?? null));
  }, [workspaceId]);
  useEffect(() => {
    void api.get<{ templates: AgentTemplate[] }>('/api/agent-templates').then((r) => setTemplates(r.templates));
    void api.get<{ tools: { name: string; title: string; description: string }[] }>('/api/hosted-agent-tools').then((r) => setTools(r.tools));
  }, []);
  useEffect(() => {
    void load().catch((e) => setError((e as Error).message));
    if (workspaceId) void api.get<{ channels: NotificationChannel[] }>(`/api/workspaces/${workspaceId}/channels`).then((r) => setChannels(r.channels)).catch(() => undefined);
  }, [load, workspaceId]);

  const loadRuns = useCallback(async (id: string) => {
    const r = await api.get<{ agent: HostedAgent; runs: HostedAgentRun[] }>(`/api/hosted-agents/${id}`);
    setRuns(r.runs);
    setAgents((as) => as.map((a) => (a.id === id ? r.agent : a)));
    setRunId((cur) => (cur && r.runs.some((x) => x.id === cur) ? cur : r.runs[0]?.id ?? null));
  }, []);
  useEffect(() => {
    if (selected) void loadRuns(selected).catch(() => undefined);
    else setRuns([]);
  }, [selected, loadRuns]);
  // While a run is going, follow it.
  const running = runs.some((r) => r.status === 'running');
  useEffect(() => {
    if (!running || !selected) return;
    const t = setInterval(() => void loadRuns(selected).catch(() => undefined), 1200);
    return () => clearInterval(t);
  }, [running, selected, loadRuns]);

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const agent = agents.find((a) => a.id === selected) ?? null;
  const run = runs.find((r) => r.id === runId) ?? null;
  const installed = useMemo(() => new Set(agents.map((a) => a.template).filter(Boolean)), [agents]);

  const install = (t: AgentTemplate) =>
    act(`install:${t.id}`, async () => {
      const r = await api.post<{ agent: HostedAgent }>(`/api/workspaces/${workspaceId}/hosted-agents`, { template: t.id, schedule: t.schedule.kind === 'cron' ? { ...t.schedule, timezone: tz() } : t.schedule });
      await load();
      setSelected(r.agent.id);
    });
  const start = (a: HostedAgent) =>
    act(`run:${a.id}`, async () => {
      const r = await api.post<{ run: HostedAgentRun }>(`/api/hosted-agents/${a.id}/run`, { input: input.trim() || undefined, ...byokBody() });
      setInput('');
      setRunId(r.run.id);
      await loadRuns(a.id);
    });
  const save = (d: Draft) =>
    act('save', async () => {
      const body = { name: d.name, description: d.description || null, instructions: d.instructions, task: d.task, tools: d.tools, max_steps: d.max_steps, schedule: SCHEDULES.find((s) => s.id === d.schedule)!.make(), channel_ids: d.channel_ids };
      const r = d.id ? await api.patch<{ agent: HostedAgent }>(`/api/hosted-agents/${d.id}`, body) : await api.post<{ agent: HostedAgent }>(`/api/workspaces/${workspaceId}/hosted-agents`, body);
      setDraft(null);
      await load();
      setSelected(r.agent.id);
    });

  if (!workspaceId) return <p className="text-sm text-zinc-500">Open a workspace first.</p>;

  return (
    <div className="space-y-8 text-xs" data-testid="hosted-agents">
      {error && <div className="rounded-md border border-red-900 bg-red-950/50 px-3 py-2 font-mono text-red-200">{error}</div>}

      <section className="space-y-2">
        <div className="flex items-center gap-2">
          <h2 className="text-[13px] font-semibold text-zinc-100">Your agents</h2>
          <span className="text-zinc-500">DuckView runs them with read-only access to this workspace, on a schedule or when you ask</span>
          {canEdit && !draft && <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setDraft({ id: null, name: '', description: '', instructions: '', task: '', tools: ['list_accessible_data', 'inspect_schema', 'execute_query'], max_steps: 8, schedule: 'manual', channel_ids: [] })}><Plus className="h-3.5 w-3.5" /> Write your own</Button>}
        </div>

        {draft && <AgentEditor draft={draft} setDraft={setDraft} tools={tools} channels={channels} busy={busy === 'save'} onSave={() => void save(draft)} />}

        {agents.length === 0 && !draft ? (
          <p className="rounded-md border border-dashed border-zinc-800 px-3 py-4 text-zinc-400">No agents in this workspace yet. Install one from the marketplace below, or write your own.</p>
        ) : agents.length > 0 && (
          <div className="grid min-h-[320px] gap-3 lg:grid-cols-[260px_minmax(0,1fr)]">
            <ul className="space-y-0.5" data-testid="hosted-list">
              {agents.map((a) => (
                <li key={a.id}>
                  <button onClick={() => setSelected(a.id)} className={cn('flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left', a.id === selected ? 'bg-zinc-800/80' : 'hover:bg-zinc-800/40')} data-agent={a.name}>
                    <Bot className="mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-500" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] text-zinc-100">{a.name}</span>
                      <span className="block truncate text-[11px] text-zinc-500">{every(a.schedule)}{a.last_run ? ` · ${a.last_run.status === 'failed' ? 'failed' : 'ran'} ${timeAgo(a.last_run.finished_at)}` : ''}</span>
                    </span>
                    {a.last_run?.status === 'failed' && <CircleAlert className="mt-0.5 h-3.5 w-3.5 text-red-400" />}
                  </button>
                </li>
              ))}
            </ul>

            {agent && (
              <div className="min-w-0 space-y-3 rounded-md border border-zinc-800 p-3" data-testid="hosted-detail">
                <div className="flex flex-wrap items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <h3 className="text-sm font-semibold text-zinc-100">{agent.name}</h3>
                    {agent.description && <p className="text-zinc-400">{agent.description}</p>}
                    <p className="mt-1 flex flex-wrap gap-1">{agent.tools.map((t) => <Badge key={t}>{t}</Badge>)}</p>
                  </div>
                  {canEdit && <Button size="sm" variant="ghost" onClick={() => setDraft(draftOf(agent))}><Pencil className="h-3.5 w-3.5" /> Edit</Button>}
                  {canEdit && <Button size="sm" variant="ghost" onClick={() => void act('delete', async () => { await api.del(`/api/hosted-agents/${agent.id}`); setSelected(null); await load(); })} title="Delete the agent and its runs"><Trash2 className="h-3.5 w-3.5" /></Button>}
                </div>
                {canEdit && (
                  <div className="flex gap-2">
                    <Input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && !running && void start(agent)} placeholder={agent.task} className="min-w-0 flex-1" data-testid="hosted-input" />
                    <Button variant="primary" loading={busy === `run:${agent.id}`} disabled={running} onClick={() => void start(agent)} data-testid="hosted-run"><Play className="h-3.5 w-3.5" /> Run</Button>
                  </div>
                )}
                {runs.length > 0 && (
                  <div className="grid gap-3 xl:grid-cols-[200px_minmax(0,1fr)]">
                    <ul className="space-y-0.5">
                      {runs.map((r) => (
                        <li key={r.id}>
                          <button onClick={() => setRunId(r.id)} className={cn('flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left', r.id === runId ? 'bg-zinc-800/80 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-800/40')}>
                            {r.status === 'running' ? <Loader2 className="h-3 w-3 animate-spin" /> : r.status === 'completed' ? <CheckCircle2 className="h-3 w-3 text-emerald-400" /> : <CircleAlert className="h-3 w-3 text-red-400" />}
                            <span className="min-w-0 flex-1 truncate">{r.input}</span>
                            <span className="shrink-0 text-[10px] text-zinc-500">{timeAgo(r.started_at)}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                    {run && (
                      <div className="min-w-0 space-y-2" data-testid="hosted-run-view" data-status={run.status}>
                        {run.steps.length > 0 && (
                          <ol className="space-y-1 border-l border-zinc-800 pl-3" data-testid="hosted-steps">
                            {run.steps.map((s, i) => (
                              <li key={i} className="text-zinc-400">
                                <span className={cn('inline-flex items-center gap-1 font-mono', s.ok ? 'text-zinc-200' : 'text-red-300')}><Wrench className="h-3 w-3" />{s.tool}</span>
                                <span className="ml-1.5 font-mono text-[11px] text-zinc-500">{JSON.stringify(s.arguments).slice(0, 140)}</span>
                                <span className="block truncate text-[11px]">{s.summary}</span>
                              </li>
                            ))}
                          </ol>
                        )}
                        {run.status === 'running' && <p className="flex items-center gap-1.5 text-zinc-400"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Working… {run.steps.length ? `${run.steps.length} tool${run.steps.length === 1 ? '' : 's'} used` : ''}</p>}
                        {run.status === 'failed' && <p className="rounded-md border border-red-900/60 bg-red-950/30 px-3 py-2 text-red-200">{run.error}</p>}
                        {run.output && <div className={MD} data-testid="hosted-output"><ReactMarkdown remarkPlugins={[remarkGfm]}>{run.output}</ReactMarkdown></div>}
                        {run.finished_at && <p className="text-[11px] text-zinc-500">{run.model ?? ''} · {run.input_tokens + run.output_tokens} tokens · {Math.round((Date.parse(run.finished_at) - Date.parse(run.started_at)) / 100) / 10} s{run.notified ? ` · sent to ${run.notified} channel${run.notified === 1 ? '' : 's'}` : ''}</p>}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </section>

      <section className="space-y-2">
        <div className="flex items-center gap-2">
          <h2 className="text-[13px] font-semibold text-zinc-100">Marketplace</h2>
          <span className="text-zinc-500">ready-made agents; everything stays editable after you install one</span>
        </div>
        <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3" data-testid="marketplace">
          {templates.map((t) => (
            <div key={t.id} className="flex flex-col rounded-md border border-zinc-800 p-3" data-template={t.id}>
              <div className="flex items-center gap-2">
                <span className="text-[13px] font-medium text-zinc-100">{t.name}</span>
                <span className="text-[11px] text-zinc-500">{t.category}</span>
              </div>
              <p className="mt-1 flex-1 text-zinc-400">{t.description}</p>
              <p className="mt-2 text-[11px] text-zinc-500">{every(t.schedule)} · {t.tools.length} tools{t.needs.length ? ` · needs ${t.needs.join(', ')}` : ''}</p>
              {canEdit && (
                <div className="mt-2">
                  <Button size="sm" loading={busy === `install:${t.id}`} onClick={() => void install(t)} data-testid="template-install">{installed.has(t.id) ? 'Install another' : 'Install'}</Button>
                </div>
              )}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function AgentEditor({ draft, setDraft, tools, channels, busy, onSave }: { draft: Draft; setDraft: (d: Draft | null) => void; tools: { name: string; title: string; description: string }[]; channels: NotificationChannel[]; busy: boolean; onSave: () => void }) {
  return (
    <div className="space-y-3 rounded-md border border-zinc-800 p-3" data-testid="hosted-editor">
      <div className="flex flex-wrap gap-3">
        <div className="min-w-[14rem] flex-1"><Label>Name</Label><Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} data-testid="hosted-name" /></div>
        <div><Label>Runs</Label><Select value={draft.schedule} onChange={(e) => setDraft({ ...draft, schedule: e.target.value })}>{SCHEDULES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</Select></div>
        <div><Label>Tool calls per run</Label><Input type="number" min={1} max={20} className="w-20" value={draft.max_steps} onChange={(e) => setDraft({ ...draft, max_steps: Number(e.target.value) || 1 })} /></div>
      </div>
      <div><Label>What it does (shown in the list)</Label><Input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} /></div>
      <div>
        <Label>Instructions</Label>
        <textarea value={draft.instructions} onChange={(e) => setDraft({ ...draft, instructions: e.target.value })} rows={7} className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-2 py-1.5 font-mono text-[12px] text-zinc-100 focus:border-accent-500 focus:outline-none" placeholder="Who the agent is, the steps it takes, and what its answer looks like." data-testid="hosted-instructions" />
      </div>
      <div><Label>Task for scheduled runs</Label><Input value={draft.task} onChange={(e) => setDraft({ ...draft, task: e.target.value })} placeholder="e.g. What changed yesterday, and why?" /></div>
      <div>
        <Label>Tools (read-only)</Label>
        <div className="flex max-h-40 flex-wrap gap-1.5 overflow-auto">
          {tools.map((t) => (
            <label key={t.name} title={t.description} className={cn('flex cursor-pointer items-center gap-1.5 rounded border px-1.5 py-0.5 font-mono text-[11px]', draft.tools.includes(t.name) ? 'border-accent-500 text-zinc-100' : 'border-zinc-800 text-zinc-500')}>
              <input type="checkbox" className="accent-accent-500" checked={draft.tools.includes(t.name)} onChange={(e) => setDraft({ ...draft, tools: e.target.checked ? [...draft.tools, t.name] : draft.tools.filter((x) => x !== t.name) })} />{t.name}
            </label>
          ))}
        </div>
      </div>
      <div>
        <Label>Send each report to</Label>
        {channels.filter((c) => c.enabled).length === 0 ? <p className="py-1 text-zinc-500">No channels yet — add one under Dashboards › Channels. Reports still appear here.</p> : (
          <div className="flex flex-wrap gap-1.5">
            {channels.filter((c) => c.enabled).map((c) => (
              <label key={c.id} className={cn('flex h-[var(--control-h)] cursor-pointer items-center gap-1.5 rounded-md border px-2', draft.channel_ids.includes(c.id) ? 'border-accent-500 text-zinc-100' : 'border-zinc-800 text-zinc-400')}>
                <input type="checkbox" className="accent-accent-500" checked={draft.channel_ids.includes(c.id)} onChange={(e) => setDraft({ ...draft, channel_ids: e.target.checked ? [...draft.channel_ids, c.id] : draft.channel_ids.filter((x) => x !== c.id) })} />{CHANNEL_META[c.type].icon}{c.name}
              </label>
            ))}
          </div>
        )}
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={() => setDraft(null)}>Cancel</Button>
        <Button variant="primary" loading={busy} disabled={!draft.name.trim() || !draft.instructions.trim() || !draft.tools.length} onClick={onSave} data-testid="hosted-save">{draft.id ? 'Save' : 'Create agent'}</Button>
      </div>
    </div>
  );
}
