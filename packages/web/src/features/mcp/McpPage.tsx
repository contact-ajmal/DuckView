import { useEffect, useRef, useState } from 'react';
import { KeyRound, Radio, Trash2, Terminal, Wrench, Activity, Pause, Play } from 'lucide-react';
import { DataTable, type Column } from '../../components/data';
import { api, timeAgo, type ApiToken, type McpSession, type AuditEvent, type Workspace, type AgentRecord, type AgentFramework, type FrameworkMeta } from '../../api/client';
import { AgentsCard, FrameworksCard } from './AgentsPanel';
import { subscribeLiveEvents, type LiveEvent } from '../../lib/liveEvents';
import { Button, CopyButton, Input, Label, Modal, Select, StatusDot, Tabs, cn, confirmAction, Empty, Badge } from '../../components/ui';
import { HostedAgentsPanel } from './HostedAgentsPanel';
import { useAuth } from '../../store/auth';
import { PageHeader } from '../../components/layout';
import { useLayout } from '../../store/layout';
import { ApprovalCard, describeIntent, describeTool, sqlOf } from '../../components/ai';
import { useWorkspace } from '../../store/workspace';

interface McpInfo { transports: { sse: string; streamable_http: string; stdio: string }; tools: string[]; resources: string[]; prompts: string[]; limits: { default_page_size: number; max_page_size: number; max_cell_chars: number }; hitl_enabled: boolean; snippets: Record<string, string> }

type Feed = { id: string; at: string; kind: 'tool' | 'query' | 'audit' | 'session'; title: string; detail?: string; status: string; user?: string; ms?: number; agent?: string; via?: string; tool?: string; args?: Record<string, unknown>; effect?: 'read' | 'write'; reason?: string; workspaceId?: string | null };

const SNIPPETS: { id: string; label: string; file: string }[] = [
  { id: 'claude_desktop', label: 'Claude Desktop', file: 'claude_desktop_config.json' },
  { id: 'cursor', label: 'Cursor', file: '.cursor/mcp.json' },
  { id: 'claude_code', label: 'Claude Code', file: 'terminal' },
  { id: 'claude_desktop_stdio', label: 'stdio (local)', file: 'claude_desktop_config.json' },
];

function toFeed(e: LiveEvent): Feed | null {
  if (e.type === 'mcp_tool') return { id: `${e.at}-${Math.random()}`, at: e.at, kind: 'tool', title: describeTool(e.tool, e.args, e.title), detail: `${e.tool}${e.summary ? ` · ${e.summary}` : ''}`, status: e.status, user: e.user, ms: e.duration_ms, agent: e.agent?.name, via: e.via, tool: e.tool, args: e.args, effect: e.effect, reason: e.reason, workspaceId: e.workspace_id };
  if (e.type === 'mcp_session') return { id: `${e.at}-${e.session_id}`, at: e.at, kind: 'session', title: `${e.action} · ${e.transport}`, status: e.action === 'connect' ? 'ok' : 'info', user: e.user };
  if (e.type === 'audit') {
    const a = e.event;
    if (a.action.startsWith('mcp.')) return null; // sessions already shown
    const isQuery = a.action.startsWith('query.') || a.action.startsWith('dataset.');
    // A statement an agent ran (or tried to): in words, with its SQL, like a tool call.
    if (isQuery && a.query_text) {
      const args = { sql: a.query_text };
      return { id: a.id, at: a.timestamp, kind: 'query', title: describeTool('execute_query', args), detail: a.query_text, status: a.status, ms: a.duration_ms ?? undefined, agent: a.actor_type === 'AGENT' ? 'An agent' : undefined, user: a.actor_type === 'AGENT' ? undefined : a.actor_type.toLowerCase(), tool: 'execute_query', args, effect: /^\s*(insert|update|delete|create|drop|alter|copy|merge)/i.test(a.query_text) ? 'write' : 'read', reason: a.error ?? undefined };
    }
    return { id: a.id, at: a.timestamp, kind: isQuery ? 'query' : 'audit', title: `${a.actor_type === 'AGENT' ? 'agent' : a.actor_type.toLowerCase()} · ${a.action}`, detail: a.query_text ?? a.resource ?? undefined, status: a.status, ms: a.duration_ms ?? undefined };
  }
  return null;
}

type AiTab = 'hosted' | 'agents' | 'tools' | 'mcp' | 'activity' | 'approvals';

export function McpPage() {
  const auth = useAuth();
  const [aiTab, setAiTab] = useState<AiTab>(() => {
    const t = (location.hash.split('/')[2] ?? '').split('?')[0]!;
    return ['hosted', 'agents', 'tools', 'mcp', 'activity', 'approvals'].includes(t) ? (t as AiTab) : 'activity';
  });
  const [info, setInfo] = useState<McpInfo | null>(null);
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [sessions, setSessions] = useState<McpSession[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [feed, setFeed] = useState<Feed[]>([]);
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState<'all' | 'tool' | 'query' | 'audit'>('all');
  const [status, setStatus] = useState<'connecting' | 'live' | 'offline'>('connecting');
  const pausedRef = useRef(false);
  const [creating, setCreating] = useState(false);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [lastToken, setLastToken] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', scopes: ['read', 'mcp'] as string[], workspace_id: '', expires_in_days: 90 });
  const [snippet, setSnippet] = useState('claude_desktop');
  const [error, setError] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentRecord[]>([]);
  const [frameworks, setFrameworks] = useState<Record<AgentFramework, FrameworkMeta> | null>(null);
  const hidden = useLayout((l) => l.hidden);

  const refresh = async () => {
    const [t, s, a] = await Promise.all([api.get<{ tokens: ApiToken[] }>('/api/tokens'), api.get<{ sessions: McpSession[] }>('/api/mcp/sessions'), api.get<{ agents: AgentRecord[] }>('/api/agents')]);
    setTokens(t.tokens);
    setSessions(s.sessions);
    setAgents(a.agents);
  };

  useEffect(() => {
    api.get<McpInfo>('/api/mcp/info').then(setInfo).catch(() => undefined);
    api.get<{ frameworks: Record<AgentFramework, FrameworkMeta> }>('/api/agents/frameworks').then((r) => setFrameworks(r.frameworks)).catch(() => undefined);
    api.get<{ workspaces: Workspace[] }>('/api/workspaces').then((r) => setWorkspaces(r.workspaces)).catch(() => undefined);
    api
      .get<{ events: AuditEvent[] }>('/api/audit?limit=60')
      .then((r) => setFeed(r.events.map((a) => toFeed({ type: 'audit', event: a })).filter((x): x is Feed => !!x)))
      .catch(() => undefined);
    void refresh();
    const t = setInterval(() => void refresh(), 5000);
    const unsub = subscribeLiveEvents((e) => {
      if (e.type === 'mcp_session') void refresh();
      if (pausedRef.current) return;
      const f = toFeed(e);
      if (f) setFeed((prev) => [f, ...prev].slice(0, 300));
    }, setStatus);
    return () => {
      clearInterval(t);
      unsub();
    };
  }, []);

  const create = async () => {
    setError(null);
    try {
      const r = await api.post<{ token: string }>('/api/tokens', { name: form.name || 'agent', scopes: form.scopes, workspace_id: form.workspace_id || null, expires_in_days: form.expires_in_days || null });
      setNewToken(r.token);
      setLastToken(r.token);
      setCreating(false);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const toggleScope = (s: string) => setForm((f) => ({ ...f, scopes: f.scopes.includes(s) ? f.scopes.filter((x) => x !== s) : [...f.scopes, s] }));
  const snippetText = info ? (info.snippets[snippet] ?? '').replace(/<TOKEN>/g, lastToken ?? '<TOKEN>') : '';
  const visible = feed.filter((f) => filter === 'all' || f.kind === filter || (filter === 'audit' && f.kind === 'session'));

  const approvals = feed
    .filter((f) => f.status === 'approval_required' || f.status === 'blocked')
    .filter((f, i, all) => all.findIndex((g) => (g.args?.sql ?? g.title) === (f.args?.sql ?? f.title) && Math.abs(Date.parse(g.at) - Date.parse(f.at)) < 10_000) === i);
  const feedColumns: Column<Feed>[] = [
    { key: 'agent', header: 'Agent', width: 'w-36', truncate: true, sortValue: (f) => f.agent ?? f.user ?? '', cell: (f) => (
      <>
        <div className="truncate text-zinc-200">{f.agent ?? f.user ?? '—'}</div>
        {f.via === 'rest' && <div className="text-2xs text-zinc-500">REST</div>}
      </>
    ) },
    { key: 'action', header: 'Action', truncate: true, cell: (f) => (
      <>
        <div className="flex items-center gap-1.5">
          {f.kind === 'tool' ? <Wrench className="h-3.5 w-3.5 shrink-0 text-zinc-500" /> : f.kind === 'session' ? <Radio className="h-3.5 w-3.5 shrink-0 text-zinc-500" /> : <Activity className="h-3.5 w-3.5 shrink-0 text-zinc-500" />}
          <span className={cn('truncate text-xs text-zinc-100', (f.kind === 'audit' || f.kind === 'session') && 'font-mono')}>{f.title}</span>
          {f.effect === 'write' && <Badge tone="warn">changes data</Badge>}
        </div>
        {f.detail && <div className="mt-0.5 truncate font-mono text-2xs text-zinc-500" title={f.detail}>{f.detail}</div>}
      </>
    ) },
    { key: 'status', header: 'Status', width: 'w-32', sortValue: (f) => f.status, cell: (f) => <StatusDot tone={f.status === 'ok' ? 'ok' : f.status === 'approval_required' || f.status === 'blocked' ? 'warn' : f.status === 'info' ? 'busy' : 'error'}>{f.status === 'approval_required' ? 'needs approval' : f.status}</StatusDot> },
    { key: 'ms', header: 'Duration', width: 'w-20', align: 'right', numeric: true, sortValue: (f) => f.ms ?? null, cell: (f) => <span className="text-xs text-zinc-500">{f.ms != null ? `${Math.round(f.ms)} ms` : ''}</span> },
    { key: 'at', header: 'When', width: 'w-24', sortValue: (f) => f.at, cell: (f) => <span className="text-xs text-zinc-500">{timeAgo(f.at)}</span> },
  ];
  const feedTable = (items: Feed[], empty: string) => <DataTable label="Agent activity" testid="activity-feed" rows={items} columns={feedColumns} rowKey={(f) => f.id} search={(f) => `${f.agent ?? ''} ${f.user ?? ''} ${f.title} ${f.detail ?? ''} ${f.status}`} searchPlaceholder="Filter activity" empty={<Empty title={empty} />} />;

  return (
    <div className="h-full overflow-auto">
    <div className="mx-auto max-w-[1280px] space-y-4 px-6 py-5">
      <PageHeader
        title="Agents"
        description="Agents and MCP clients working with this server, what they do, and what waits for your approval."
        actions={<Button onClick={() => setCreating(true)}><KeyRound className="h-3.5 w-3.5" /> New API token</Button>}
      />
      {!hidden['mcp.stats'] && (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-xs text-zinc-500">
          <span><b className="font-semibold text-zinc-200">{agents.length}</b> agents</span>
          <span><b className="font-semibold text-zinc-200">{sessions.length}</b> live sessions</span>
          <span><b className="font-semibold text-zinc-200">{tokens.length}</b> tokens</span>
          <span><b className={cn('font-semibold', approvals.length ? 'text-amber-500' : 'text-zinc-200')}>{approvals.length}</b> awaiting approval</span>
          <StatusDot tone={info?.hitl_enabled ? 'ok' : 'warn'}>{info?.hitl_enabled ? 'Changes to data need human approval' : 'Human approval is off'}</StatusDot>
          <StatusDot tone={status === 'live' ? 'ok' : status === 'connecting' ? 'busy' : 'error'}>feed {status}</StatusDot>
        </div>
      )}
      <Tabs<AiTab>
        value={aiTab}
        onChange={(t) => { setAiTab(t); history.replaceState(null, '', `#/agents/${t}`); }}
        tabs={[
          { id: 'activity', label: 'Activity' },
          { id: 'approvals', label: 'Approvals', count: approvals.length },
          { id: 'hosted', label: 'DuckView agents' },
          { id: 'agents', label: 'Connected agents', count: agents.length },
          { id: 'mcp', label: 'MCP clients', count: sessions.length },
          { id: 'tools', label: 'Tools', count: info?.tools.length },
        ]}
      />

      {aiTab === 'hosted' && <HostedAgentsPanel />}

      {aiTab === 'agents' && (
        <div className="space-y-6">
          {!hidden['mcp.agents'] && <AgentsCard agents={agents} workspaces={workspaces} frameworks={frameworks} onChanged={refresh} onToken={(t) => setLastToken(t)} hideId="mcp.agents" />}
          {!hidden['mcp.frameworks'] && <FrameworksCard frameworks={frameworks} workspaceId={workspaces[0]?.id ?? null} token={lastToken} hideId="mcp.frameworks" />}
        </div>
      )}

      {aiTab === 'tools' && info && (
        <div className="grid gap-8 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
          <section>
            <h2 className="mb-2 text-body font-semibold text-zinc-100">Tools <span className="font-normal text-zinc-500">· {info.tools.length}, over MCP and the REST/OpenAPI façade</span></h2>
            <ul className="grid grid-cols-1 gap-x-6 border-y border-zinc-800 py-1 sm:grid-cols-2">
              {info.tools.map((t) => <li key={t} className="truncate py-1 font-mono text-xs text-zinc-300">{t}</li>)}
            </ul>
          </section>
          <section className="space-y-6">
            <div>
              <h2 className="mb-2 text-body font-semibold text-zinc-100">Resources</h2>
              <ul className="border-y border-zinc-800 py-1">{info.resources.map((t) => <li key={t} className="break-all py-1 font-mono text-xs text-zinc-300">{t}</li>)}</ul>
            </div>
            <div>
              <h2 className="mb-2 text-body font-semibold text-zinc-100">Guided prompts</h2>
              <ul className="border-y border-zinc-800 py-1">{info.prompts.map((t) => <li key={t} className="py-1 font-mono text-xs text-zinc-300">{t}</li>)}</ul>
            </div>
            <div className="text-xs text-zinc-500">
              <StatusDot tone="ok"><span className="text-zinc-300">Changes to data are held for approval</span></StatusDot>
              <p className="mt-1">Results are paged {info.limits.default_page_size} rows by default ({info.limits.max_page_size} at most) and cells are cut at {info.limits.max_cell_chars} characters.</p>
            </div>
          </section>
        </div>
      )}

      {aiTab === 'mcp' && (
        <div className="space-y-8">
          {!hidden['mcp.connect'] && (
            <section>
              <div className="mb-2 flex items-center justify-between gap-2">
                <h2 className="text-body font-semibold text-zinc-100">Connect a client</h2>
                <CopyButton text={snippetText} label={lastToken ? 'Copy with token' : 'Copy'} />
              </div>
              <Tabs size="sm" value={snippet} onChange={setSnippet} tabs={SNIPPETS.map((x) => ({ id: x.id, label: x.label }))} />
              <div className="mb-1 mt-2 font-mono text-2xs text-zinc-500">{SNIPPETS.find((x) => x.id === snippet)?.file}</div>
              <pre className="overflow-auto rounded-md border border-zinc-800 bg-zinc-900 p-3 font-mono text-xs leading-relaxed text-zinc-300">{snippetText}</pre>
              <p className="mt-1.5 text-xs text-zinc-500">{lastToken ? 'Your new token is filled in.' : 'Create an API token and it is filled in for <TOKEN>.'}</p>
            </section>
          )}
          {!hidden['mcp.sessions'] && (
            <section>
              <h2 className="mb-2 text-body font-semibold text-zinc-100">Live sessions</h2>
              {sessions.length === 0 ? (
                <p className="border-y border-zinc-800 py-4 text-xs text-zinc-500">No clients connected right now.</p>
              ) : (
                <ul className="divide-y divide-zinc-800/70 border-y border-zinc-800">
                  {sessions.map((x) => (
                    <li key={x.id} className="flex items-center gap-3 py-2 text-xs">
                      <StatusDot tone="ok" pulse />
                      <span className="min-w-0 flex-1 truncate text-zinc-200">{x.user} <span className="text-zinc-500">· {x.transport} · {x.ip}</span></span>
                      <span className="text-zinc-500">workspace {x.workspace_id ? (workspaces.find((w) => w.id === x.workspace_id)?.name ?? x.workspace_id.slice(0, 8)) : 'any'} · active {timeAgo(x.last_activity)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
          {!hidden['mcp.tokens'] && (
            <section>
              <h2 className="mb-2 text-body font-semibold text-zinc-100">API tokens</h2>
              {tokens.length === 0 ? (
                <p className="border-y border-zinc-800 py-4 text-xs text-zinc-500">No tokens yet. A token is shown once, when it is created.</p>
              ) : (
                <DataTable
                  label="API tokens"
                  rows={tokens}
                  rowKey={(t) => t.id}
                  columns={[
                    { key: 'name', header: 'Name', sortValue: (t) => t.name, cell: (t) => <><div className="text-zinc-200">{t.name}</div><div className="font-mono text-2xs text-zinc-500">{t.token_prefix}…</div></> },
                    { key: 'scopes', header: 'Scopes', cell: (t) => <span className="text-xs text-zinc-400">{t.scopes.join(', ')}</span> },
                    { key: 'workspace', header: 'Workspace', cell: (t) => <span className="text-xs text-zinc-400">{t.workspace_id ? (workspaces.find((w) => w.id === t.workspace_id)?.name ?? t.workspace_id.slice(0, 8)) : 'all'}</span> },
                    { key: 'last_used', header: 'Last used', cell: (t) => <span className="text-xs text-zinc-500">{timeAgo(t.last_used_at)}</span> },
                    { key: 'expires', header: 'Expires', cell: (t) => <span className="text-xs text-zinc-500">{t.expires_at ? (new Date(t.expires_at) < new Date() ? <span className="text-red-400">expired</span> : new Date(t.expires_at).toLocaleDateString()) : 'never'}</span> },
                    { key: 'c5', header: '', align: 'right', sortValue: (t) => t.name, cell: (t) => <><button className="rounded p-1 text-zinc-500 opacity-0 hover:text-red-400 group-hover:opacity-100" onClick={async () => { if ((await confirmAction(`Revoke token "${t.name}"?`))) { await api.del(`/api/tokens/${t.id}`); await refresh(); } }} title="Revoke" aria-label={`Revoke ${t.name}`}>
                            <Trash2 className="h-3.5 w-3.5" />
                          </button></> },
                  ]}
                />
              )}
            </section>
          )}
        </div>
      )}

      {aiTab === 'activity' && !hidden['mcp.inspector'] && (
        <section>
          <div className="mb-2 flex items-center gap-2">
            <Tabs size="sm" className="border-b-0" value={filter} onChange={setFilter} tabs={[{ id: 'all', label: 'All' }, { id: 'tool', label: 'Tool calls' }, { id: 'query', label: 'Queries' }, { id: 'audit', label: 'Other' }]} />
            <Button size="sm" variant="ghost" className="ml-auto" onClick={() => { pausedRef.current = !paused; setPaused(!paused); }}>
              {paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />} {paused ? 'Resume' : 'Pause'}
            </Button>
          </div>
          {feedTable(visible, 'Waiting for activity. Tool calls, queries and audit events appear here as they happen.')}
        </section>
      )}

      {aiTab === 'approvals' && (
        <section className="space-y-3">
          <p className="max-w-3xl text-xs text-zinc-500">When an agent tries to change data (SQL that writes, dbt builds, publishing an app), the change is held until a person agrees in the agent's own client (Claude Desktop, Cursor …), which then repeats the call. You can also run a held statement yourself: it opens in a SQL tab and runs after you approve it there.</p>
          {approvals.length === 0 ? (
            <Empty title="Nothing is waiting for approval" hint="When an agent tries to change data, the change is held here until a person agrees in the agent's own client." />
          ) : (
            <div className="space-y-3" data-testid="approvals">
              {approvals.map((f) => {
                const sql = f.args ? sqlOf(f.args) : null;
                return (
                  <ApprovalCard
                    key={f.id}
                    title={`${f.agent ?? f.user ?? 'An agent'} wants to ${f.tool ? describeIntent(f.tool, f.args ?? {}) : f.title.charAt(0).toLowerCase() + f.title.slice(1)}`}
                    requester={`${f.via === 'rest' ? 'REST' : 'MCP'} · ${timeAgo(f.at)}`}
                    reason={f.reason ?? 'The change was held until a person approves it.'}
                    statements={sql ? [{ verb: (/^\s*(\w+)/.exec(sql)?.[1] ?? 'SQL').toUpperCase(), preview: sql.replace(/\s+/g, ' ').slice(0, 300), destructive: true }] : undefined}
                  >
                    {sql && <Button size="sm" className="mt-2" onClick={() => { void useWorkspace.getState().addTab({ title: f.agent && f.agent !== 'An agent' ? `From ${f.agent}` : 'From an agent', sql }); location.hash = '#/query'; }}>Run it myself in SQL</Button>}
                  </ApprovalCard>
                );
              })}
            </div>
          )}
        </section>
      )}
      <Modal open={creating} onClose={() => setCreating(false)} title="Create API token">
        <div className="space-y-4">
          <div>
            <Label>Name</Label>
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="claude-desktop" />
          </div>
          <div>
            <Label>Scopes</Label>
            <div className="flex flex-wrap gap-2">
              {['read', 'write', 'mcp', 'admin'].map((s) => (
                <button key={s} onClick={() => toggleScope(s)} disabled={s === 'admin' && auth.user?.role !== 'ADMIN'} className={cn('rounded-md border px-3 py-1.5 text-xs disabled:opacity-40', form.scopes.includes(s) ? 'border-accent-500 bg-accent-600/20 text-accent-200' : 'border-zinc-700 text-zinc-400')}>
                  {s}
                </button>
              ))}
            </div>
            <p className="mt-1 text-2xs text-zinc-500">`mcp` is required for MCP transports. `write` allows mutating SQL (still approval-gated). `admin` allows SET/PRAGMA/ATTACH.</p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Workspace scope</Label>
              <Select value={form.workspace_id} onChange={(e) => setForm({ ...form, workspace_id: e.target.value })} className="w-full">
                <option value="">All my workspaces</option>
                {workspaces.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label>Expires in (days)</Label>
              <Input type="number" min={0} value={form.expires_in_days} onChange={(e) => setForm({ ...form, expires_in_days: Number(e.target.value) })} />
            </div>
          </div>
          {error && <div className="rounded-md border border-red-900 bg-red-950/50 px-3 py-2 text-xs text-red-200">{error}</div>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={create}>
              Create
            </Button>
          </div>
        </div>
      </Modal>

      <Modal open={!!newToken} onClose={() => setNewToken(null)} title="Token created — copy it now">
        <p className="mb-3 text-xs text-zinc-400">This is the only time the token is shown. It is stored as a SHA-256 hash. The client snippets on this page now include it.</p>
        <div className="flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-950 p-3 font-mono text-xs text-accent-200">
          <Terminal className="h-4 w-4 shrink-0 text-zinc-500" />
          <span className="break-all">{newToken}</span>
        </div>
        <div className="mt-3 flex justify-end">
          <CopyButton text={newToken ?? ''} label="Copy token" />
        </div>
      </Modal>
    </div>
    </div>
  );
}
