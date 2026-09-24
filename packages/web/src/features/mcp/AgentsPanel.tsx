import { useEffect, useMemo, useRef, useState } from 'react';
import { Bot, Trash2, RefreshCw, Play, MessageSquare, Code2, ShieldCheck, ShieldAlert, Search, Download, ExternalLink, Send, Square, KeyRound } from 'lucide-react';
import { api, agentInvoke, getToken, timeAgo, type AgentRecord, type AgentFramework, type AgentConfig, type FrameworkMeta, type Snippet, type Workspace } from '../../api/client';
import { Button, Badge, Card, CopyButton, Input, Label, Modal, Select, cn, confirmAction, toast } from '../../components/ui';
import { HideButton } from '../../components/LayoutMenu';
import { DataTable } from '../../components/data';

export const FRAMEWORK_ORDER: AgentFramework[] = ['strands', 'langgraph', 'langchain', 'crewai', 'agentcore_runtime', 'agentcore_gateway', 'bedrock_agent', 'custom'];
const SHORT: Record<AgentFramework, string> = { strands: 'Strands', langgraph: 'LangGraph', langchain: 'LangChain', crewai: 'CrewAI', agentcore_runtime: 'AgentCore Runtime', agentcore_gateway: 'AgentCore Gateway', bedrock_agent: 'Bedrock Agents', custom: 'HTTP / custom' };
const TONE: Record<AgentFramework, 'zinc' | 'violet' | 'green' | 'amber' | 'red' | 'blue'> = { strands: 'amber', langgraph: 'green', langchain: 'green', crewai: 'red', agentcore_runtime: 'amber', agentcore_gateway: 'amber', bedrock_agent: 'amber', custom: 'zinc' };

export function frameworkLabel(f: AgentFramework) {
  return SHORT[f];
}

/** Downloads the generated OpenAPI document with the session token (the endpoint needs auth). */
export async function downloadOpenApi() {
  const res = await fetch('/api/agent/openapi.json', { headers: { authorization: `Bearer ${getToken()}` } });
  if (!res.ok) return void toast.error(await res.text());
  const a = document.createElement('a');
  a.href = URL.createObjectURL(await res.blob());
  a.download = 'duckview-openapi.json';
  a.click();
}

// ------------------------------------------------------------------ snippets
export function SnippetViewer({ snippets, token }: { snippets: Snippet[]; token?: string | null }) {
  const [idx, setIdx] = useState(0);
  useEffect(() => setIdx(0), [snippets]);
  const sn = snippets[Math.min(idx, Math.max(0, snippets.length - 1))];
  if (!sn) return <p className="text-xs text-zinc-500">No snippet.</p>;
  const code = token ? sn.code.split('<TOKEN>').join(token) : sn.code;
  return (
    <div>
      {snippets.length > 1 && (
        <div className="mb-2 flex flex-wrap gap-1">
          {snippets.map((s, i) => (
            <button key={s.id} onClick={() => setIdx(i)} className={cn('rounded-md px-2 py-0.5 text-2xs', i === idx ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200')}>
              {s.label}
            </button>
          ))}
        </div>
      )}
      <div className="mb-1 flex items-center justify-between">
        <span className="font-mono text-2xs text-zinc-500">{sn.file}</span>
        <CopyButton text={code} label={token ? 'Copy with token' : 'Copy'} />
      </div>
      <pre className="max-h-[360px] overflow-auto rounded-md border border-zinc-800 bg-zinc-950 p-3 font-mono text-2xs leading-relaxed text-zinc-300">{code}</pre>
      {sn.notes && <p className="mt-2 text-2xs text-zinc-500">{token ? sn.notes.split('<TOKEN>').join(token) : sn.notes}</p>}
    </div>
  );
}

export function FrameworksCard({ frameworks, workspaceId, token, hideId }: { frameworks: Record<AgentFramework, FrameworkMeta> | null; workspaceId?: string | null; token?: string | null; hideId: string }) {
  const [fw, setFw] = useState<AgentFramework>('strands');
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  useEffect(() => {
    api
      .get<{ snippets: Snippet[] }>(`/api/agents/snippets?framework=${fw}${workspaceId ? `&workspace_id=${workspaceId}` : ''}`)
      .then((r) => setSnippets(r.snippets))
      .catch(() => setSnippets([]));
  }, [fw, workspaceId]);
  const meta = frameworks?.[fw];
  return (
    <Card
      title="Agent frameworks"
      className="lg:col-span-2"
      actions={
        <span className="flex items-center gap-2">
          <button onClick={() => void downloadOpenApi()} className="inline-flex items-center gap-1 text-2xs text-zinc-400 hover:text-zinc-100" title="OpenAPI 3.0 schema of the REST tool façade (Bedrock action groups, AgentCore Gateway)">
            <Download className="h-3.5 w-3.5" /> OpenAPI
          </button>
          <HideButton id={hideId} />
        </span>
      }
    >
      <div className="mb-3 flex flex-wrap gap-1">
        {FRAMEWORK_ORDER.map((f) => (
          <button key={f} onClick={() => setFw(f)} className={cn('rounded-md px-2.5 py-1 text-xs', fw === f ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200')}>
            {SHORT[f]}
          </button>
        ))}
      </div>
      {meta && (
        <p className="mb-3 text-2xs text-zinc-500">
          {meta.blurb}{' '}
          <Badge tone="neutral" className="ml-1">{meta.transport === 'both' ? 'MCP + REST' : meta.transport.toUpperCase()}</Badge>
          {meta.docs && (
            <a href={meta.docs} target="_blank" rel="noreferrer" className="ml-2 inline-flex items-center gap-0.5 text-accent-300 hover:underline">
              docs <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </p>
      )}
      <SnippetViewer snippets={snippets} token={token} />
      <p className="mt-2 text-2xs text-zinc-500">{token ? 'The token you just created is substituted into the snippet.' : 'Register an agent (or create a token) to have its token substituted for <TOKEN>.'}</p>
    </Card>
  );
}

// ------------------------------------------------------------------ registered agents
export function AgentsCard({ agents, workspaces, frameworks, onChanged, onToken, hideId }: { agents: AgentRecord[]; workspaces: Workspace[]; frameworks: Record<AgentFramework, FrameworkMeta> | null; onChanged: () => Promise<void>; onToken: (token: string, agent: AgentRecord) => void; hideId: string }) {
  const [creating, setCreating] = useState(false);
  const [setup, setSetup] = useState<{ agent: AgentRecord; snippets: Snippet[] } | null>(null);
  const [chat, setChat] = useState<AgentRecord | null>(null);
  const [testing, setTesting] = useState<Record<string, string>>({});
  const [lastToken, setLastToken] = useState<{ agentId: string; token: string } | null>(null);

  const openSetup = async (a: AgentRecord) => {
    const r = await api.get<{ snippets: Snippet[] }>(`/api/agents/${a.id}/snippets`);
    setSetup({ agent: a, snippets: r.snippets });
  };
  const test = async (a: AgentRecord) => {
    setTesting({ ...testing, [a.id]: 'testing…' });
    try {
      const r = await api.post<{ ok: boolean; text: string }>(`/api/agents/${a.id}/test`);
      setTesting({ ...testing, [a.id]: r.ok ? `OK · ${r.text.split('\n')[0]?.replace(/\*\*/g, '').slice(0, 140)}` : `Failed · ${r.text.slice(0, 160)}` });
    } catch (e) {
      setTesting({ ...testing, [a.id]: (e as Error).message });
    }
    await onChanged();
  };
  const rotate = async (a: AgentRecord) => {
    if (!(await confirmAction(`Rotate the token of "${a.name}"? The current token stops working immediately.`))) return;
    const r = await api.post<{ token: string; agent: AgentRecord }>(`/api/agents/${a.id}/rotate-token`);
    setLastToken({ agentId: a.id, token: r.token });
    onToken(r.token, r.agent);
    await onChanged();
  };
  const remove = async (a: AgentRecord) => {
    if (!(await confirmAction(`Delete agent "${a.name}" and revoke its token?`))) return;
    await api.del(`/api/agents/${a.id}`);
    await onChanged();
  };

  return (
    <Card
      title="Registered agents"
      className="lg:col-span-3"
      actions={
        <span className="flex items-center gap-2">
          <Button size="sm" variant="primary" onClick={() => setCreating(true)}>
            <Bot className="h-3.5 w-3.5" /> New agent
          </Button>
          <HideButton id={hideId} />
        </span>
      }
    >
      {agents.length === 0 ? (
        <p className="py-2 text-xs text-zinc-500">No agents yet. Register one (Strands, LangGraph, LangChain, CrewAI, AgentCore, Bedrock or any HTTP client) to give it its own token and see its calls under Activity.</p>
      ) : (
        <DataTable
          label="Connected agents"
          rows={agents}
          rowKey={(a) => a.id}
          columns={[
            { key: 'agent', header: 'Agent', sortValue: (a) => a.name, cell: (a) => <><div className="font-medium text-zinc-200">{a.name}</div>
                  <div className="font-mono text-2xs text-zinc-500">
                    {a.token_revoked ? <span className="text-red-300">token revoked</span> : `${a.token_prefix}…`}
                    {a.config.runtime_arn && <span title={a.config.runtime_arn}> · {a.config.runtime_arn.split('/').pop()}</span>}
                    {a.config.agent_id && <span> · {a.config.agent_id}/{a.config.agent_alias_id}</span>}
                  </div>
                  {a.description && <div className="text-2xs text-zinc-500">{a.description}</div>}
                  {testing[a.id] && <div className="mt-0.5 max-w-md truncate font-mono text-2xs text-amber-200" title={testing[a.id]}>{testing[a.id]}</div>}</> },
            { key: 'framework', header: 'Framework', cell: (a) => <><Badge tone={TONE[a.framework]}>{SHORT[a.framework]}</Badge></> },
            { key: 'workspace', header: 'Workspace', cell: (a) => <span className="text-zinc-400">{a.workspace_id ? (workspaces.find((w) => w.id === a.workspace_id)?.name ?? a.workspace_id.slice(0, 8)) : 'all'}</span> },
            { key: 'access', header: 'Access', cell: (a) => <>{a.allow_mutations ? (
                    <span className="inline-flex items-center gap-1 text-amber-200" title="write scope — mutations still need human approval"><ShieldAlert className="h-3.5 w-3.5" /> read + write</span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-emerald-300"><ShieldCheck className="h-3.5 w-3.5" /> read-only</span>
                  )}</> },
            { key: 'calls', header: 'Calls', align: 'right', cell: (a) => <span className="whitespace-nowrap font-mono text-zinc-300">{a.call_count.toLocaleString()}
                  {a.error_count > 0 && <span className="text-red-300"> · {a.error_count} err</span>}</span> },
            { key: 'last_seen', header: 'Last seen', cell: (a) => <span className="whitespace-nowrap text-zinc-400">{a.last_seen_at ? timeAgo(a.last_seen_at) : 'never'}</span> },
            { key: 'c6', header: '', align: 'right', cell: (a) => <><div className="flex justify-end gap-0.5">
                    <button className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-100" title="Setup snippet" onClick={() => void openSetup(a)}><Code2 className="h-3.5 w-3.5" /></button>
                    <button className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-100" title="Self-test: call list_accessible_data as this agent" onClick={() => void test(a)}><Play className="h-3.5 w-3.5" /></button>
                    {a.can_invoke && <button className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-accent-300" title="Chat with this agent" onClick={() => setChat(a)}><MessageSquare className="h-3.5 w-3.5" /></button>}
                    <button className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-100" title="Rotate token" onClick={() => void rotate(a)}><RefreshCw className="h-3.5 w-3.5" /></button>
                    <button className="rounded p-1 text-zinc-500 hover:bg-red-950 hover:text-red-300" title="Delete" onClick={() => void remove(a)}><Trash2 className="h-3.5 w-3.5" /></button>
                  </div></> },
          ]}
        />
      )}

      <NewAgentModal
        open={creating}
        onClose={() => setCreating(false)}
        workspaces={workspaces}
        frameworks={frameworks}
        onCreated={async (r) => {
          setCreating(false);
          setLastToken({ agentId: r.agent.id, token: r.token });
          onToken(r.token, r.agent);
          await onChanged();
          await openSetup(r.agent);
        }}
      />

      <Modal open={!!setup} onClose={() => setSetup(null)} title={setup ? `${setup.agent.name} · ${SHORT[setup.agent.framework]}` : ''} width="max-w-3xl">
        {setup && (
          <div className="space-y-3">
            <p className="text-2xs text-zinc-500">
              {frameworks?.[setup.agent.framework]?.blurb}{' '}
              {lastToken?.agentId === setup.agent.id ? 'The new token is substituted below — it is shown only once.' : 'Tokens are shown once at creation; rotate the token to get a new one.'}
            </p>
            <SnippetViewer snippets={setup.snippets} token={lastToken?.agentId === setup.agent.id ? lastToken.token : null} />
            {(setup.agent.framework === 'bedrock_agent' || setup.agent.framework === 'agentcore_gateway') && (
              <Button size="sm" onClick={() => void downloadOpenApi()}><Download className="h-3.5 w-3.5" /> Download OpenAPI schema</Button>
            )}
          </div>
        )}
      </Modal>

      {chat && <AgentChatModal agent={chat} workspaces={workspaces} onClose={() => setChat(null)} />}
    </Card>
  );
}

function NewAgentModal({ open, onClose, workspaces, frameworks, onCreated }: { open: boolean; onClose: () => void; workspaces: Workspace[]; frameworks: Record<AgentFramework, FrameworkMeta> | null; onCreated: (r: { agent: AgentRecord; token: string }) => Promise<void> }) {
  const [form, setForm] = useState<{ name: string; framework: AgentFramework; description: string; workspace_id: string; allow_mutations: boolean; expires_in_days: number; config: AgentConfig }>({ name: '', framework: 'strands', description: '', workspace_id: workspaces[0]?.id ?? '', allow_mutations: false, expires_in_days: 365, config: { region: 'us-east-1' } });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discovered, setDiscovered] = useState<{ agents?: { id: string; name: string; aliases: { id: string; name: string }[] }[]; runtimes?: { arn: string; name: string; status?: string }[] } | null>(null);
  const [discovering, setDiscovering] = useState(false);
  useEffect(() => {
    if (open) {
      setError(null);
      setDiscovered(null);
      setForm((f) => ({ ...f, name: '', description: '', workspace_id: workspaces[0]?.id ?? '' }));
    }
  }, [open, workspaces]);
  const cfg = (patch: Partial<AgentConfig>) => setForm((f) => ({ ...f, config: { ...f.config, ...patch } }));
  const discover = async () => {
    setDiscovering(true);
    setError(null);
    try {
      const kind = form.framework === 'bedrock_agent' ? 'bedrock_agents' : 'agentcore_runtimes';
      setDiscovered(await api.get(`/api/agents/discover?kind=${kind}&region=${encodeURIComponent(form.config.region ?? '')}`));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDiscovering(false);
    }
  };
  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ agent: AgentRecord; token: string }>('/api/agents', { name: form.name, framework: form.framework, description: form.description || null, workspace_id: form.workspace_id || null, allow_mutations: form.allow_mutations, expires_in_days: form.expires_in_days || null, config: form.config });
      await onCreated(r);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const isAws = form.framework === 'bedrock_agent' || form.framework === 'agentcore_runtime' || form.framework === 'agentcore_gateway';
  return (
    <Modal open={open} onClose={onClose} title="Register an agent" width="max-w-2xl">
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Name</Label>
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="sales-analyst" />
          </div>
          <div>
            <Label>Framework</Label>
            <Select value={form.framework} onChange={(e) => setForm({ ...form, framework: e.target.value as AgentFramework })} className="w-full">
              {FRAMEWORK_ORDER.map((f) => (
                <option key={f} value={f}>
                  {frameworks?.[f]?.title ?? SHORT[f]}
                </option>
              ))}
            </Select>
          </div>
        </div>
        <p className="text-2xs text-zinc-500">{frameworks?.[form.framework]?.blurb}</p>
        <div>
          <Label>Description <span className="normal-case text-zinc-600">(optional)</span></Label>
          <Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="What this agent is for" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Workspace</Label>
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
            <Label>Token expires in (days)</Label>
            <Input type="number" min={0} value={form.expires_in_days} onChange={(e) => setForm({ ...form, expires_in_days: Number(e.target.value) })} />
          </div>
        </div>
        <label className="flex items-start gap-2 text-xs text-zinc-300">
          <input type="checkbox" className="mt-0.5" checked={form.allow_mutations} onChange={(e) => setForm({ ...form, allow_mutations: e.target.checked })} />
          <span>
            Allow mutating SQL and dataset writes <span className="text-zinc-500">— still held for human approval (dry_run=false) on every call.</span>
          </span>
        </label>

        {isAws && (
          <div className="space-y-3 rounded-md border border-zinc-800 bg-zinc-950 p-3">
            <div className="text-2xs font-semibold text-zinc-500">AWS {form.framework === 'agentcore_gateway' ? '(informational)' : '— lets DuckView invoke this agent'}</div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Region</Label>
                <Input value={form.config.region ?? ''} onChange={(e) => cfg({ region: e.target.value })} placeholder="us-east-1" className="font-mono" />
              </div>
              {form.framework === 'bedrock_agent' && (
                <>
                  <div>
                    <Label>Agent id</Label>
                    <Input value={form.config.agent_id ?? ''} onChange={(e) => cfg({ agent_id: e.target.value })} className="font-mono" />
                  </div>
                  <div>
                    <Label>Alias id</Label>
                    <Input value={form.config.agent_alias_id ?? ''} onChange={(e) => cfg({ agent_alias_id: e.target.value })} className="font-mono" />
                  </div>
                </>
              )}
              {form.framework === 'agentcore_runtime' && (
                <>
                  <div>
                    <Label>Runtime ARN</Label>
                    <Input value={form.config.runtime_arn ?? ''} onChange={(e) => cfg({ runtime_arn: e.target.value })} placeholder="arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/my_agent-abc123" className="font-mono" />
                  </div>
                  <div>
                    <Label>Endpoint qualifier <span className="normal-case text-zinc-600">(optional)</span></Label>
                    <Input value={form.config.qualifier ?? ''} onChange={(e) => cfg({ qualifier: e.target.value })} placeholder="DEFAULT" className="font-mono" />
                  </div>
                </>
              )}
              {form.framework === 'agentcore_gateway' && (
                <div>
                  <Label>Gateway URL <span className="normal-case text-zinc-600">(optional)</span></Label>
                  <Input value={form.config.gateway_url ?? ''} onChange={(e) => cfg({ gateway_url: e.target.value })} placeholder="https://<gateway-id>.gateway.bedrock-agentcore.us-east-1.amazonaws.com/mcp" className="font-mono" />
                </div>
              )}
            </div>
            {form.framework !== 'agentcore_gateway' && (
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" onClick={() => void discover()} loading={discovering}>
                  <Search className="h-3.5 w-3.5" /> Discover in {form.config.region || 'region'}
                </Button>
                {discovered?.agents?.map((a) => (
                  <button key={a.id} className="rounded border border-zinc-700 px-2 py-0.5 font-mono text-2xs text-zinc-300 hover:border-accent-500" onClick={() => cfg({ agent_id: a.id, agent_alias_id: a.aliases[0]?.id ?? '' })} title={`aliases: ${a.aliases.map((x) => `${x.name} (${x.id})`).join(', ') || 'none'}`}>
                    {a.name} · {a.id}
                  </button>
                ))}
                {discovered?.runtimes?.map((r) => (
                  <button key={r.arn} className="rounded border border-zinc-700 px-2 py-0.5 font-mono text-2xs text-zinc-300 hover:border-accent-500" onClick={() => cfg({ runtime_arn: r.arn })} title={r.arn}>
                    {r.name} {r.status ? `· ${r.status}` : ''}
                  </button>
                ))}
                {discovered && !(discovered.agents?.length || discovered.runtimes?.length) && <span className="text-2xs text-zinc-500">nothing found</span>}
                <span className="text-2xs text-zinc-500">Uses the DuckView server's AWS credentials.</span>
              </div>
            )}
          </div>
        )}
        {error && <div className="rounded-md border border-red-900 bg-red-950/50 px-3 py-2 text-xs text-red-200">{error}</div>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={create} loading={busy} disabled={!form.name.trim()}>
            <KeyRound className="h-4 w-4" /> Register & mint token
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function AgentChatModal({ agent, workspaces, onClose }: { agent: AgentRecord; workspaces: Workspace[]; onClose: () => void }) {
  const [prompt, setPrompt] = useState('');
  const [includeContext, setIncludeContext] = useState(true);
  const [workspaceId, setWorkspaceId] = useState(agent.workspace_id ?? workspaces[0]?.id ?? '');
  const [messages, setMessages] = useState<{ role: 'user' | 'agent'; text: string; error?: boolean }[]>([]);
  const [busy, setBusy] = useState(false);
  const sessionId = useRef<string | undefined>(undefined);
  const abort = useRef<AbortController | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => bottom.current?.scrollIntoView({ behavior: 'smooth' }), [messages]);
  const send = async () => {
    const text = prompt.trim();
    if (!text || busy) return;
    setPrompt('');
    setMessages((m) => [...m, { role: 'user', text }, { role: 'agent', text: '' }]);
    setBusy(true);
    abort.current = new AbortController();
    try {
      for await (const ev of agentInvoke(agent.id, { prompt: text, session_id: sessionId.current, workspace_id: workspaceId || undefined, include_context: includeContext && !!workspaceId }, abort.current.signal)) {
        if (ev.type === 'delta') setMessages((m) => m.map((x, i) => (i === m.length - 1 ? { ...x, text: x.text + ev.text } : x)));
        else if (ev.type === 'done') sessionId.current = ev.session_id;
        else if (ev.type === 'error') setMessages((m) => m.map((x, i) => (i === m.length - 1 ? { ...x, text: x.text || ev.message, error: true } : x)));
      }
    } catch (e) {
      setMessages((m) => m.map((x, i) => (i === m.length - 1 ? { ...x, text: (e as Error).message, error: true } : x)));
    } finally {
      setBusy(false);
      abort.current = null;
    }
  };
  const label = useMemo(() => (agent.framework === 'bedrock_agent' ? `Bedrock agent ${agent.config.agent_id}` : `AgentCore ${agent.config.runtime_arn?.split('/').pop() ?? ''}`), [agent]);
  return (
    <Modal open onClose={onClose} title={`Chat · ${agent.name}`} width="max-w-2xl">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-3 text-2xs text-zinc-500">
          <span>{label} · {agent.config.region}</span>
          <label className="ml-auto flex items-center gap-1.5">
            <input type="checkbox" checked={includeContext} onChange={(e) => setIncludeContext(e.target.checked)} /> send workspace context
          </label>
          <Select value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)} className="h-7 text-2xs">
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="max-h-[360px] min-h-[160px] space-y-2 overflow-auto rounded-md border border-zinc-800 bg-zinc-950 p-3 text-xs">
          {messages.length === 0 && <p className="text-zinc-500">Ask the agent something. Replies stream from AWS; the session id is kept for follow-ups.</p>}
          {messages.map((m, i) => (
            <div key={i} className={cn('whitespace-pre-wrap rounded-md px-3 py-2', m.role === 'user' ? 'ml-8 bg-accent-600/15 text-zinc-100' : m.error ? 'mr-8 border border-red-900 bg-red-950/40 text-red-200' : 'mr-8 bg-zinc-900 text-zinc-200')}>
              {m.text || (busy && i === messages.length - 1 ? '…' : '')}
            </div>
          ))}
          <div ref={bottom} />
        </div>
        <div className="flex gap-2">
          <Input value={prompt} onChange={(e) => setPrompt(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void send()} placeholder="Message the agent…" disabled={busy} />
          {busy ? (
            <Button onClick={() => abort.current?.abort()}><Square className="h-3.5 w-3.5" /> Stop</Button>
          ) : (
            <Button variant="primary" onClick={() => void send()} disabled={!prompt.trim()}><Send className="h-3.5 w-3.5" /> Send</Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
