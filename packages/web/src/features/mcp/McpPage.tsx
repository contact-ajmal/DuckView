import { useEffect, useRef, useState } from 'react';
import { Bot, KeyRound, Radio, Trash2, ShieldCheck, Terminal, Wrench, Activity, Pause, Play } from 'lucide-react';
import { api, timeAgo, type ApiToken, type McpSession, type AuditEvent, type Workspace } from '../../api/client';
import { subscribeLiveEvents, type LiveEvent } from '../../lib/liveEvents';
import { Button, Badge, Card, CopyButton, Input, Label, Modal, Select, Stat, cn } from '../../components/ui';
import { useAuth } from '../../store/auth';
import { Eyebrow, PageTitle } from '../../components/layout';
import { useLayout } from '../../store/layout';
import { HideButton } from '../../components/LayoutMenu';

interface McpInfo { transports: { sse: string; streamable_http: string; stdio: string }; tools: string[]; resources: string[]; prompts: string[]; limits: { default_page_size: number; max_page_size: number; max_cell_chars: number }; hitl_enabled: boolean; snippets: Record<string, string> }

type Feed = { id: string; at: string; kind: 'tool' | 'query' | 'audit' | 'session'; title: string; detail?: string; status: string; user?: string; ms?: number };

const SNIPPETS: { id: string; label: string; file: string }[] = [
  { id: 'claude_desktop', label: 'Claude Desktop', file: 'claude_desktop_config.json' },
  { id: 'cursor', label: 'Cursor', file: '.cursor/mcp.json' },
  { id: 'claude_code', label: 'Claude Code', file: 'terminal' },
  { id: 'claude_desktop_stdio', label: 'stdio (local)', file: 'claude_desktop_config.json' },
];

function toFeed(e: LiveEvent): Feed | null {
  if (e.type === 'mcp_tool') return { id: `${e.at}-${Math.random()}`, at: e.at, kind: 'tool', title: e.tool, detail: e.summary, status: e.status, user: e.user, ms: e.duration_ms };
  if (e.type === 'mcp_session') return { id: `${e.at}-${e.session_id}`, at: e.at, kind: 'session', title: `${e.action} · ${e.transport}`, status: e.action === 'connect' ? 'ok' : 'info', user: e.user };
  if (e.type === 'audit') {
    const a = e.event;
    if (a.action.startsWith('mcp.')) return null; // sessions already shown
    const isQuery = a.action.startsWith('query.') || a.action.startsWith('dataset.');
    return { id: a.id, at: a.timestamp, kind: isQuery ? 'query' : 'audit', title: `${a.actor_type === 'AGENT' ? 'agent' : a.actor_type.toLowerCase()} · ${a.action}`, detail: a.query_text ?? a.resource ?? undefined, status: a.status, ms: a.duration_ms ?? undefined };
  }
  return null;
}

export function McpPage() {
  const auth = useAuth();
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
  const hidden = useLayout((l) => l.hidden);

  const refresh = async () => {
    const [t, s] = await Promise.all([api.get<{ tokens: ApiToken[] }>('/api/tokens'), api.get<{ sessions: McpSession[] }>('/api/mcp/sessions')]);
    setTokens(t.tokens);
    setSessions(s.sessions);
  };

  useEffect(() => {
    api.get<McpInfo>('/api/mcp/info').then(setInfo).catch(() => undefined);
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

  return (
    <div className="mx-auto max-w-[1400px] space-y-5 p-5">
      <div className="flex items-center justify-between">
        <div>
          <Eyebrow>AI agents · Model Context Protocol</Eyebrow>
          <PageTitle className="flex items-center gap-2">
            <Bot className="h-6 w-6 text-accent-400" /> Agent & MCP hub
          </PageTitle>
          <p className="mt-1 text-xs text-zinc-500">Connect Claude Desktop, Cursor or Claude Code to your sandboxed DuckDB workspaces and watch what they do in real time.</p>
        </div>
        <Button variant="primary" onClick={() => setCreating(true)}>
          <KeyRound className="h-4 w-4" /> New API token
        </Button>
      </div>

      {!hidden['mcp.stats'] && <div className="group/st relative grid grid-cols-2 gap-3 md:grid-cols-4">
        <HideButton id="mcp.stats" className="absolute -top-5 right-0 opacity-0 group-hover/st:opacity-100" />
        <Stat label="Live sessions" value={sessions.length} sub="SSE + streamable HTTP" />
        <Stat label="Tokens" value={tokens.length} sub={`${tokens.filter((t) => t.expires_at && new Date(t.expires_at) < new Date()).length} expired`} />
        <Stat label="Agent activity (feed)" value={feed.filter((f) => f.kind === 'tool' || f.title.startsWith('agent')).length} sub={`${feed.filter((f) => f.status === 'approval_required' || f.status === 'blocked').length} awaiting approval / blocked`} />
        <Stat label="Safety" value={info?.hitl_enabled ? 'HITL on' : 'HITL off'} sub={`${info?.limits.default_page_size ?? 50}/${info?.limits.max_page_size ?? 200} rows per call`} />
      </div>}

      <div className="grid gap-6 lg:grid-cols-5">
        {!hidden['mcp.connect'] && <Card
          title="Connect a client"
          className="lg:col-span-2"
          actions={<span className="flex items-center gap-1"><CopyButton text={snippetText} label={lastToken ? 'Copy with token' : 'Copy'} /><HideButton id="mcp.connect" /></span>}
        >
          <div className="mb-3 flex flex-wrap gap-1">
            {SNIPPETS.map((s) => (
              <button key={s.id} onClick={() => setSnippet(s.id)} className={cn('rounded-md px-2.5 py-1 text-xs', snippet === s.id ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200')}>
                {s.label}
              </button>
            ))}
          </div>
          <div className="mb-1 font-mono text-[10px] text-zinc-500">{SNIPPETS.find((s) => s.id === snippet)?.file}</div>
          <pre className="overflow-auto rounded-md border border-zinc-800 bg-zinc-950 p-3 font-mono text-[11px] leading-relaxed text-zinc-300">{snippetText}</pre>
          <p className="mt-2 text-[11px] text-zinc-500">{lastToken ? 'The token you just created is substituted into the snippet.' : 'Create a token to have it substituted for <TOKEN> automatically.'}</p>
          {info && (
            <div className="mt-3 grid grid-cols-3 gap-2 text-[11px] text-zinc-400">
              <div>
                <div className="mb-1 font-semibold uppercase tracking-wide text-zinc-500">Tools</div>
                {info.tools.map((t) => (
                  <div key={t} className="font-mono">{t}</div>
                ))}
              </div>
              <div>
                <div className="mb-1 font-semibold uppercase tracking-wide text-zinc-500">Resources</div>
                {info.resources.map((t) => (
                  <div key={t} className="break-all font-mono">{t}</div>
                ))}
              </div>
              <div>
                <div className="mb-1 font-semibold uppercase tracking-wide text-zinc-500">Prompts</div>
                {info.prompts.map((t) => (
                  <div key={t} className="font-mono">{t}</div>
                ))}
                <div className="mt-2 flex items-center gap-1 text-emerald-300">
                  <ShieldCheck className="h-3.5 w-3.5" /> mutations need approval
                </div>
              </div>
            </div>
          )}
        </Card>}

        {!hidden['mcp.inspector'] && <Card
          title={
            <span className="flex items-center gap-2">
              Live inspector
              <span className={cn('inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] normal-case tracking-normal', status === 'live' ? 'bg-emerald-900/40 text-emerald-300' : status === 'connecting' ? 'bg-zinc-800 text-zinc-400' : 'bg-red-900/40 text-red-300')}>
                <span className={cn('h-1.5 w-1.5 rounded-full', status === 'live' ? 'animate-pulse bg-emerald-400' : status === 'connecting' ? 'bg-zinc-500' : 'bg-red-400')} /> {status}
              </span>
            </span>
          }
          className="lg:col-span-3"
          actions={
            <div className="flex items-center gap-1">
              {(['all', 'tool', 'query', 'audit'] as const).map((f) => (
                <button key={f} onClick={() => setFilter(f)} className={cn('rounded px-2 py-0.5 text-[11px]', filter === f ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-200')}>
                  {f}
                </button>
              ))}
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  pausedRef.current = !paused;
                  setPaused(!paused);
                }}
                title={paused ? 'Resume' : 'Pause'}
              >
                {paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
              </Button>
              <HideButton id="mcp.inspector" />
            </div>
          }
        >
          <div className="max-h-[520px] space-y-1 overflow-auto">
            {visible.length === 0 && <p className="text-xs text-zinc-500">Waiting for activity… tool invocations, queries and audit events stream here in real time.</p>}
            {visible.map((f) => (
              <div key={f.id} className="rounded-md border border-zinc-800/80 bg-zinc-950 px-3 py-2 text-xs">
                <div className="flex items-center gap-2">
                  {f.kind === 'tool' ? <Wrench className="h-3.5 w-3.5 text-accent-300" /> : f.kind === 'session' ? <Radio className="h-3.5 w-3.5 text-sky-300" /> : <Activity className="h-3.5 w-3.5 text-zinc-500" />}
                  <span className="font-mono text-zinc-200">{f.title}</span>
                  <Badge tone={f.status === 'ok' ? 'green' : f.status === 'approval_required' || f.status === 'blocked' ? 'amber' : f.status === 'info' ? 'blue' : 'red'}>{f.status}</Badge>
                  {f.user && <span className="truncate text-[10px] text-zinc-500">{f.user}</span>}
                  <span className="ml-auto shrink-0 text-[10px] text-zinc-500">
                    {f.ms != null && `${Math.round(f.ms)} ms · `}
                    {timeAgo(f.at)}
                  </span>
                </div>
                {f.detail && <pre className="mt-1 max-h-16 overflow-hidden whitespace-pre-wrap break-all font-mono text-[10px] text-zinc-500">{f.detail}</pre>}
              </div>
            ))}
          </div>
        </Card>}

        {!hidden['mcp.tokens'] && <Card title="API tokens" className="lg:col-span-3" actions={<HideButton id="mcp.tokens" />}>
          {tokens.length === 0 ? (
            <p className="text-xs text-zinc-500">No tokens yet. Tokens are shown once at creation and stored as SHA-256 hashes.</p>
          ) : (
            <table className="w-full text-xs">
              <thead className="text-left text-[10px] uppercase tracking-wide text-zinc-500">
                <tr>
                  <th className="pb-2">Name</th>
                  <th className="pb-2">Scopes</th>
                  <th className="pb-2">Workspace</th>
                  <th className="pb-2">Last used</th>
                  <th className="pb-2">Expires</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {tokens.map((t) => (
                  <tr key={t.id} className="border-t border-zinc-800">
                    <td className="py-2">
                      <div className="font-medium text-zinc-200">{t.name}</div>
                      <div className="font-mono text-[10px] text-zinc-500">{t.token_prefix}…</div>
                    </td>
                    <td className="py-2">
                      <div className="flex flex-wrap gap-1">
                        {t.scopes.map((s) => (
                          <Badge key={s} tone={s === 'admin' ? 'red' : s === 'write' ? 'amber' : s === 'mcp' ? 'violet' : 'zinc'}>
                            {s}
                          </Badge>
                        ))}
                      </div>
                    </td>
                    <td className="py-2 text-zinc-400">{t.workspace_id ? (workspaces.find((w) => w.id === t.workspace_id)?.name ?? t.workspace_id.slice(0, 8)) : 'all'}</td>
                    <td className="py-2 text-zinc-400">{timeAgo(t.last_used_at)}</td>
                    <td className="py-2 text-zinc-400">{t.expires_at ? new Date(t.expires_at).toLocaleDateString() : 'never'}</td>
                    <td className="py-2 text-right">
                      <button
                        className="rounded p-1 text-zinc-500 hover:bg-red-950 hover:text-red-300"
                        onClick={async () => {
                          if (confirm(`Revoke token "${t.name}"?`)) {
                            await api.del(`/api/tokens/${t.id}`);
                            await refresh();
                          }
                        }}
                        title="Revoke"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>}

        {!hidden['mcp.sessions'] && <Card title="Live MCP sessions" className="lg:col-span-2" actions={<HideButton id="mcp.sessions" />}>
          {sessions.length === 0 ? (
            <div className="flex items-center gap-2 text-xs text-zinc-500">
              <Radio className="h-4 w-4" /> No agents connected right now.
            </div>
          ) : (
            <div className="space-y-2">
              {sessions.map((s) => (
                <div key={s.id} className="flex items-center gap-3 rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs">
                  <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-400" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-zinc-200">
                      {s.user} <Badge tone="violet">{s.transport}</Badge>
                    </div>
                    <div className="text-[10px] text-zinc-500">
                      {s.ip} · started {timeAgo(s.started_at)} · active {timeAgo(s.last_activity)} · ws {s.workspace_id ? (workspaces.find((w) => w.id === s.workspace_id)?.name ?? s.workspace_id.slice(0, 8)) : 'any'}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>}
      </div>

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
            <p className="mt-1 text-[11px] text-zinc-500">`mcp` is required for MCP transports. `write` allows mutating SQL (still approval-gated). `admin` allows SET/PRAGMA/ATTACH.</p>
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
  );
}
