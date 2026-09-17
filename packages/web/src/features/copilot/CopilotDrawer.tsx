import { useEffect, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Bot, X, Send, Square, Settings2, Sparkles, Wrench, PlayCircle, FilePlus2, ArrowDownToLine, Trash2, History, ChevronDown, KeyRound, Loader2 } from 'lucide-react';
import { useCopilot } from '../../store/copilot';
import { useWorkspace } from '../../store/workspace';
import { api, type AgentRecord } from '../../api/client';
import { Button, Input, Label, Select, cn } from '../../components/ui';

export interface CopilotHost {
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

const PROVIDER_LABEL: Record<string, string> = { anthropic: 'Anthropic (Claude)', openai: 'OpenAI', ollama: 'Ollama (local)', bedrock: 'Amazon Bedrock (Claude)', bedrock_agent: 'Amazon Bedrock Agent', agentcore: 'Bedrock AgentCore runtime' };
const AWS = new Set(['bedrock', 'bedrock_agent', 'agentcore']);

function SqlBlock({ sql, onInsert, onNewTab, onRun, busy }: { sql: string; onInsert: () => void; onNewTab: () => void; onRun: () => void; busy: boolean }) {
  return (
    <div className="my-2 overflow-hidden rounded-md border border-zinc-800 bg-zinc-950">
      <pre className="overflow-auto p-2.5 font-mono text-[11px] leading-relaxed text-zinc-200">{sql}</pre>
      <div className="flex flex-wrap gap-1 border-t border-zinc-800 bg-zinc-900/60 px-1.5 py-1">
        <button onClick={onInsert} className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-zinc-300 hover:bg-zinc-800 hover:text-zinc-50" title="Insert at cursor in the active tab">
          <ArrowDownToLine className="h-3 w-3" /> Insert into tab
        </button>
        <button onClick={onNewTab} className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-zinc-300 hover:bg-zinc-800 hover:text-zinc-50" title="Open in a fresh tab">
          <FilePlus2 className="h-3 w-3" /> New tab
        </button>
        <button onClick={onRun} disabled={busy} className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-accent-200 hover:bg-accent-600/20 disabled:opacity-40" title="Run the query, then explain the result">
          {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <PlayCircle className="h-3 w-3" />} Run & inspect
        </button>
      </div>
    </div>
  );
}

export function CopilotDrawer() {
  const cp = useCopilot();
  const ws = useWorkspace();
  const wsId = ws.activeId;
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

  const submit = (action?: 'chat' | 'fix' | 'suggest' | 'explain') => {
    if (!wsId || cp.streaming) return;
    const text = input.trim();
    if (action === 'fix') {
      void cp.send({ workspaceId: wsId, message: text, action: 'fix', activeSql: host?.activeSql() ?? '', errorMessage: host?.activeError() ?? null });
    } else if (action === 'suggest') {
      void cp.send({ workspaceId: wsId, message: text, action: 'suggest', targets: cp.targets });
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
      alert((e as Error).message);
    } finally {
      setModelsBusy(false);
    }
  };

  const mdComponents = {
    code({ className, children, ...props }: { className?: string; children?: ReactNode; inline?: boolean }) {
      const lang = /language-(\w+)/.exec(className ?? '')?.[1];
      const text = String(children ?? '').replace(/\n$/, '');
      const isSql = lang === 'sql' || (!lang && text.includes('\n') && /^\s*(select|with|from|summarize|describe|pivot)\b/i.test(text));
      if (isSql) return <SqlBlock sql={text} onInsert={() => host?.insertSql(text)} onNewTab={() => host?.newTabWithSql(text, 'Copilot')} onRun={() => void runAndInspect(text)} busy={running === text} />;
      if (props.inline || !text.includes('\n')) return <code className="rounded bg-zinc-800 px-1 py-0.5 font-mono text-[11px] text-accent-200">{text}</code>;
      return <pre className="my-2 overflow-auto rounded-md border border-zinc-800 bg-zinc-950 p-2.5 font-mono text-[11px] text-zinc-200">{text}</pre>;
    },
    p: ({ children }: { children?: ReactNode }) => <p className="my-1.5 leading-relaxed">{children}</p>,
    ul: ({ children }: { children?: ReactNode }) => <ul className="my-1.5 list-disc space-y-0.5 pl-5">{children}</ul>,
    ol: ({ children }: { children?: ReactNode }) => <ol className="my-1.5 list-decimal space-y-0.5 pl-5">{children}</ol>,
    h1: ({ children }: { children?: ReactNode }) => <h3 className="mt-3 mb-1 text-sm font-semibold text-zinc-50">{children}</h3>,
    h2: ({ children }: { children?: ReactNode }) => <h3 className="mt-3 mb-1 text-sm font-semibold text-zinc-50">{children}</h3>,
    h3: ({ children }: { children?: ReactNode }) => <h4 className="mt-2 mb-1 text-[13px] font-semibold text-zinc-100">{children}</h4>,
    table: ({ children }: { children?: ReactNode }) => <table className="my-2 w-full border-collapse font-mono text-[11px]">{children}</table>,
    th: ({ children }: { children?: ReactNode }) => <th className="border border-zinc-800 bg-zinc-900 px-2 py-1 text-left">{children}</th>,
    td: ({ children }: { children?: ReactNode }) => <td className="border border-zinc-800 px-2 py-1">{children}</td>,
    a: ({ children, href }: { children?: ReactNode; href?: string }) => <a href={href} className="text-accent-300 underline" target="_blank" rel="noreferrer">{children}</a>,
  };

  return (
    <aside className="relative flex h-full shrink-0 flex-col border-l border-zinc-800 bg-zinc-950" style={{ width: cp.width }}>
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
        <Bot className="h-4 w-4 text-accent-400" />
        <span className="text-sm font-semibold">DuckCopilot</span>
        <span className="truncate font-mono text-[10px] text-zinc-500" title={effectiveModel ?? ''}>
          {effectiveProvider ? `${effectiveProvider} · ${effectiveModel}` : 'not configured'}
        </span>
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

      {showConvs && (
        <div className="border-b border-zinc-800 bg-zinc-900/60 p-2 text-xs">
          <div className="mb-1 flex items-center justify-between px-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
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
                <span className="ml-2 shrink-0 font-mono text-[10px] text-zinc-500">{c.messages}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {showSettings && cfg && (
        <div className="space-y-2 border-b border-zinc-800 bg-zinc-900/60 p-3 text-xs">
          <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
            <KeyRound className="h-3 w-3" /> Provider
          </div>
          <Select value={cp.settings.provider} onChange={(e) => { cp.setSettings({ provider: e.target.value as typeof cp.settings.provider, model: '' }); setModels([]); }} className="h-8 w-full text-xs" disabled={!cfg.allow_byok}>
            <option value="">{cfg.server_provider ? `Server-managed: ${PROVIDER_LABEL[cfg.server_provider]} (${cfg.server_model})` : 'Server-managed: none configured'}</option>
            {cfg.allow_byok && (['anthropic', 'openai', 'ollama', 'bedrock', 'bedrock_agent', 'agentcore'] as const).map((p) => (
              <option key={p} value={p}>
                Bring your own: {PROVIDER_LABEL[p]}
              </option>
            ))}
          </Select>
          {cp.settings.provider && AWS.has(cp.settings.provider) && (
            <div className="space-y-2">
              <p className="text-[11px] text-zinc-500">Uses the DuckView server's AWS credentials (default credential chain). {cp.settings.provider === 'bedrock_agent' && 'Bedrock Agents Classic is closed to new customers — prefer AgentCore for new agents.'}</p>
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
              {cp.settings.provider !== 'ollama' && (
                <div>
                  <Label>API key <span className="normal-case text-zinc-600">(kept in this browser only)</span></Label>
                  <Input type="password" value={cp.settings.apiKey} onChange={(e) => cp.setSettings({ apiKey: e.target.value })} className="h-8 font-mono text-xs" autoComplete="off" placeholder={cp.settings.provider === 'anthropic' ? 'sk-ant-…' : 'sk-…'} />
                </div>
              )}
              {cp.settings.provider !== 'anthropic' && (
                <div>
                  <Label>Base URL {cp.settings.provider === 'ollama' ? '' : <span className="normal-case text-zinc-600">(optional, OpenAI-compatible)</span>}</Label>
                  <Input value={cp.settings.baseUrl} onChange={(e) => cp.setSettings({ baseUrl: e.target.value })} className="h-8 font-mono text-xs" placeholder={cp.settings.provider === 'ollama' ? 'http://localhost:11434' : 'https://api.openai.com/v1'} />
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
          {!cfg.allow_byok && <p className="text-[11px] text-zinc-500">Keys are managed by the server administrator.</p>}
        </div>
      )}

      <div ref={scroller} className="min-h-0 flex-1 overflow-auto px-3 py-3 text-[13px] text-zinc-200">
        {!ready && (
          <div className="rounded-md border border-amber-900 bg-amber-950/40 p-3 text-xs text-amber-200">
            {cfg?.enabled === false ? 'DuckCopilot is disabled on this server.' : 'No LLM provider configured. Open settings to bring your own key (Anthropic, OpenAI, a local Ollama) or point at Amazon Bedrock / a Bedrock Agent / an AgentCore runtime, or ask your administrator to set copilot.provider.'}
          </div>
        )}
        {ready && cp.messages.length === 0 && (
          <div className="space-y-3">
            <p className="text-xs text-zinc-400">I can see your tables, files, buckets and the SQL in your active tab. Ask in plain English, or start from an action:</p>
            <div className="grid gap-1.5">
              {[
                ['Which regions had the highest revenue growth month over month?', 'Trend + window functions'],
                ['Find duplicate customers by normalised email', 'Data quality'],
                ['Pivot orders by product into monthly columns', 'PIVOT'],
              ].map(([q, hint]) => (
                <button key={q} onClick={() => setInput(q ?? "")} className="rounded-md border border-zinc-800 px-2.5 py-1.5 text-left text-xs text-zinc-300 hover:border-zinc-600">
                  {q} <span className="text-[10px] text-zinc-600">· {hint}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {cp.messages.map((m) => (
          <div key={m.id} className={cn('mb-3', m.role === 'user' ? 'flex justify-end' : '')}>
            {m.role === 'user' ? (
              <div className="max-w-[90%] whitespace-pre-wrap rounded-lg bg-accent-600/25 px-3 py-2 text-[13px] text-accent-50">{m.content}</div>
            ) : (
              <div className="max-w-full">
                {m.meta && (m.meta.tables != null || m.meta.model) && (
                  <div className="mb-1 flex flex-wrap gap-x-2 font-mono text-[10px] text-zinc-500">
                    {m.meta.model && <span>{m.meta.model}</span>}
                    {m.meta.tables != null && <span>· {m.meta.tables} tables · {m.meta.files} files{m.meta.targets?.length ? ` · profiled ${m.meta.targets.join(', ')}` : ''}</span>}
                    {m.meta.duration_ms != null && <span>· {(m.meta.duration_ms / 1000).toFixed(1)}s</span>}
                  </div>
                )}
                <div className="prose-sm">
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents as never}>{m.content || (m.streaming ? '…' : '')}</ReactMarkdown>
                </div>
                {m.streaming && <span className="inline-block h-3 w-1.5 animate-pulse bg-accent-400" />}
                {m.error && <div className="mt-1 rounded-md border border-red-900 bg-red-950/40 px-2 py-1 text-[11px] text-red-200">{m.error}</div>}
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="shrink-0 border-t border-zinc-800 p-2">
        <div className="mb-1.5 flex flex-wrap gap-1">
          <button onClick={() => submit('suggest')} disabled={!ready || cp.streaming} className="inline-flex items-center gap-1 rounded-md border border-zinc-800 px-2 py-1 text-[11px] text-zinc-300 hover:border-zinc-600 disabled:opacity-40" title={cp.targets.length ? `Suggest questions for ${cp.targets.join(', ')}` : 'Suggest questions for this workspace'}>
            <Sparkles className="h-3 w-3 text-accent-300" /> Suggest questions{cp.targets.length ? ` (${cp.targets.length})` : ''}
          </button>
          <button onClick={() => submit('fix')} disabled={!ready || cp.streaming || !host?.activeSql()} className="inline-flex items-center gap-1 rounded-md border border-zinc-800 px-2 py-1 text-[11px] text-zinc-300 hover:border-zinc-600 disabled:opacity-40" title="Send the active tab's SQL and its last error">
            <Wrench className="h-3 w-3 text-amber-300" /> Fix my query{host?.activeError() ? ' (error)' : ''}
          </button>
          {cp.messages.length > 0 && (
            <button onClick={() => wsId && void cp.clear(wsId)} className="ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-zinc-500 hover:text-red-300" title="Delete this conversation">
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
        <div className="mt-1 flex items-center gap-1 text-[10px] text-zinc-600">
          <ChevronDown className="h-3 w-3" /> context: schema of all tables, data files, buckets{cp.targets.length ? `, SUMMARIZE of ${cp.targets.join(', ')}` : ''}, active SQL
        </div>
      </div>
    </aside>
  );
}
