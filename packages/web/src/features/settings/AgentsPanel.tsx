/**
 * Settings → This workspace → Agents: DuckView's agent for other agents. Any MCP client (Claude, Cursor, Claude
 * Code, a custom agent) connects to the Agent MCP endpoint with a token bound to this workspace and asks for whole
 * tasks — analyse, investigate, build — instead of calling low-level tools. The agent acts as the token's owner;
 * changes that need approval wait for them in DuckView.
 *
 * Tokens are shown once, when created; the configuration below is generated for the server this page is served by.
 */
import { useCallback, useEffect, useState } from 'react';
import { Check, KeyRound, Plus, Trash2 } from 'lucide-react';
import { api, timeAgo, type ApiToken } from '../../api/client';
import { DataTable } from '../../components/data';
import { Button, Checkbox, CopyButton, Field, IconButton, Input, InlineError, Modal, StatusDot, confirmAction, errorText, toast } from '../../components/ui';

interface Memory { id: string; scope: 'workspace' | 'user'; kind: string; subject: string | null; text: string; uses: number; updated_at: string }
const MEMORY_KIND: Record<string, string> = { discovery: 'Found', outcome: 'Made', failure: 'Failed', suggestion: 'Suggests', preference: 'Prefers' };

interface TelemetryGroup { decision_engine: string; provider: string; model: string; tasks: number; completed: number; avg_duration_ms: number; avg_decision_ms: number; avg_tool_calls: number; tool_failures: number; avg_context_selected: number; avg_context_considered: number; input_tokens: number; output_tokens: number; estimated_cost_usd: number | null }

interface AgentConfig {
  enabled: boolean;
  mcp: { enabled: boolean; url: string; low_level_url: string; tools: { name: string; title: string; description: string }[] };
  decision: { provider: string; available: string[] };
  budget: { max_objects: number; max_tokens: number; max_tool_definitions: number; max_observations: number; max_result_rows: number };
  max_steps: number;
}

/** A generic MCP client configuration: most clients read this shape (mcpServers → url + headers). */
export function mcpConfig(url: string, token: string): string {
  return JSON.stringify({ mcpServers: { 'duckview-agent': { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2);
}

export function AgentsPanel({ workspaceId, workspaceName, canEdit }: { workspaceId: string; workspaceName: string; canEdit: boolean }) {
  const [config, setConfig] = useState<AgentConfig | null>(null);
  const [tokens, setTokens] = useState<ApiToken[] | null>(null);
  const [memories, setMemories] = useState<Memory[] | null>(null);
  const [usage, setUsage] = useState<TelemetryGroup[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [draft, setDraft] = useState<{ name: string; write: boolean } | null>(null);
  const [issued, setIssued] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [c, t, m] = await Promise.all([api.get<AgentConfig>('/api/agent/config'), api.get<{ tokens: ApiToken[] }>('/api/tokens'), api.get<{ memories: Memory[] }>(`/api/agent/memory?workspace_id=${encodeURIComponent(workspaceId)}`)]);
      setConfig(c);
      setMemories(m.memories);
      void api.get<{ groups: TelemetryGroup[] }>(`/api/agent/telemetry?days=30&workspace_id=${encodeURIComponent(workspaceId)}`).then((u) => setUsage(u.groups)).catch(() => setUsage([]));
      setTokens(t.tokens.filter((x) => x.workspace_id === workspaceId && x.scopes.includes('mcp')));
    } catch (e) {
      setError(e);
    }
  }, [workspaceId]);
  useEffect(() => void load(), [load]);

  const create = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      const r = await api.post<{ token: string }>('/api/tokens', { name: draft.name.trim() || 'Agent MCP', scopes: draft.write ? ['read', 'write', 'mcp'] : ['read', 'mcp'], workspace_id: workspaceId });
      setDraft(null);
      setIssued(r.token);
      await load();
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  if (error) return <InlineError error={error} onRetry={() => void load()} />;
  const url = config?.mcp.url ?? `${location.origin}/mcp/agent`;
  return (
    <div className="space-y-6" data-testid="agents-panel">
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <h2 className="min-w-0 flex-1 text-title font-semibold text-zinc-100">Agent MCP</h2>
          {config && <StatusDot tone={config.mcp.enabled ? 'ok' : 'idle'} data-testid="agent-mcp-status">{config.mcp.enabled ? 'Enabled' : 'Disabled on this server'}</StatusDot>}
        </div>
        <p className="text-xs text-zinc-400">Other agents ask DuckView's agent for whole tasks in {workspaceName}: it finds the data and metrics, works as the token's owner, and returns answers, tables, SQL and what it built. Changes that need approval wait for you here.</p>
        <Field label="Endpoint" hint="Streamable HTTP. Low-level tools (SQL, schemas, files) stay at /mcp." htmlFor="agent-mcp-url">
          <div className="flex gap-2">
            <Input id="agent-mcp-url" readOnly value={url} className="font-mono" data-testid="agent-mcp-url" />
            <CopyButton text={url} label="Copy the endpoint" />
          </div>
        </Field>
        {config && (
          <div>
            <div className="mb-1 text-xs font-medium text-zinc-400">What other agents can ask</div>
            <ul className="grid gap-x-6 gap-y-1 sm:grid-cols-2" data-testid="agent-mcp-tools">
              {config.mcp.tools.map((t) => (
                <li key={t.name} className="flex items-start gap-1.5 text-xs text-zinc-300" title={t.description}>
                  <Check className="mt-0.5 h-3 w-3 shrink-0 text-emerald-400" />
                  <span>{t.title} <span className="font-mono text-2xs text-zinc-500">{t.name}</span></span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section className="space-y-3 border-t border-zinc-800 pt-5">
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <h2 className="text-title font-semibold text-zinc-100">Tokens for this workspace</h2>
            <p className="text-xs text-zinc-500">A token acts as you, in this workspace only. Give one to each client, and revoke it when the client goes.</p>
          </div>
          {canEdit && <Button size="sm" variant="primary" onClick={() => setDraft({ name: '', write: false })} data-testid="agent-token-new"><Plus className="h-3.5 w-3.5" /> Create token</Button>}
        </div>
        <DataTable
          label="Agent tokens"
          testid="agent-tokens"
          rows={tokens}
          rowKey={(t) => t.id}
          empty="No token yet. Create one for each MCP client that should reach this workspace."
          columns={[
            { key: 'name', header: 'Name', cell: (t) => <span className="text-zinc-100">{t.name}</span> },
            { key: 'token', header: 'Token', cell: (t) => <span className="font-mono text-xs text-zinc-400">{t.token_prefix}••••••••</span> },
            { key: 'scopes', header: 'Can', cell: (t) => (t.scopes.includes('write') ? 'read and make changes (with your approval)' : 'read') },
            { key: 'used', header: 'Last used', cell: (t) => (t.last_used_at ? timeAgo(t.last_used_at) : 'never') },
            { key: 'x', header: '', align: 'right', cell: (t) => <IconButton label={`Revoke ${t.name}`} onClick={() => void confirmAction(`Revoke ${t.name}? Clients using it stop working at once.`, { confirmLabel: 'Revoke' }).then(async (ok) => { if (ok) { await api.del(`/api/tokens/${t.id}`); await load(); } })}><Trash2 className="h-3.5 w-3.5" /></IconButton> },
          ]}
        />
      </section>

      <section className="space-y-2 border-t border-zinc-800 pt-5">
        <h2 className="text-title font-semibold text-zinc-100">Client configuration</h2>
        <p className="text-xs text-zinc-500">Most MCP clients read this shape. Put your token in place of &lt;TOKEN&gt;.</p>
        <div className="relative">
          <pre className="overflow-auto rounded-md border border-zinc-800 bg-zinc-900/60 p-3 font-mono text-2xs text-zinc-300" data-testid="agent-mcp-config">{mcpConfig(url, '<TOKEN>')}</pre>
          <div className="absolute right-2 top-2"><CopyButton text={mcpConfig(url, '<TOKEN>')} label="Copy the configuration" /></div>
        </div>
      </section>

      <section className="space-y-3 border-t border-zinc-800 pt-5">
        <div>
          <h2 className="text-title font-semibold text-zinc-100">What the agent remembers</h2>
          <p className="text-xs text-zinc-500">Facts earlier tasks found, used as context later. Shared ones hold only what every member can see in the catalog; the rest are yours alone. Forget anything that is wrong or out of date.</p>
        </div>
        <DataTable
          label="Agent memory"
          testid="agent-memory"
          rows={memories}
          rowKey={(m) => m.id}
          rowProps={(m) => ({ 'data-kind': m.kind, 'data-scope': m.scope })}
          empty="Nothing yet. The agent keeps what it learns about this workspace as it works."
          columns={[
            { key: 'kind', header: 'What', cell: (m) => MEMORY_KIND[m.kind] ?? m.kind },
            { key: 'text', header: 'Memory', truncate: true, cell: (m) => <span className="text-zinc-300" title={m.text}>{m.text}</span> },
            { key: 'scope', header: 'Seen by', cell: (m) => (m.scope === 'workspace' ? 'Everyone here' : 'You') },
            { key: 'uses', header: 'Used', align: 'right', numeric: true, cell: (m) => m.uses.toLocaleString() },
            { key: 'x', header: '', align: 'right', cell: (m) => <IconButton label={`Forget: ${m.text.slice(0, 60)}`} onClick={() => void api.del(`/api/agent/memory/${m.id}`).then(load).catch((e) => toast.error(errorText(e)))}><Trash2 className="h-3.5 w-3.5" /></IconButton> },
          ]}
        />
      </section>

      {config && (
        <section className="space-y-1 border-t border-zinc-800 pt-5 text-xs text-zinc-400" data-testid="agent-decision">
          <h2 className="text-title font-semibold text-zinc-100">How the agent decides</h2>
          <p>Decision engine: <span className="font-mono text-zinc-200">{config.decision.provider}</span>{config.decision.available.length > 1 ? ` (available: ${config.decision.available.join(', ')})` : ''}. It picks at most {config.budget.max_tool_definitions} tools and {config.budget.max_objects} things from the workspace for each step, within {config.budget.max_tokens.toLocaleString()} tokens of context, and up to {config.max_steps} tool calls a task.</p>
          {usage && usage.length > 0 && (
            <DataTable
              label="Your agent tasks in the last 30 days"
              testid="agent-usage"
              rows={usage}
              rowKey={(g) => `${g.decision_engine}|${g.provider}|${g.model}`}
              density="compact"
              columns={[
                { key: 'm', header: 'Engine · model', cell: (g) => <span className="font-mono">{g.decision_engine} · {g.model}</span> },
                { key: 't', header: 'Tasks', align: 'right', numeric: true, cell: (g) => `${g.completed}/${g.tasks}` },
                { key: 'd', header: 'Avg time', align: 'right', numeric: true, cell: (g) => `${(g.avg_duration_ms / 1000).toFixed(1)} s` },
                { key: 'c', header: 'Context', align: 'right', numeric: true, cell: (g) => `${Math.round(g.avg_context_selected)} of ${Math.round(g.avg_context_considered)}` },
                { key: 'k', header: 'Tool calls', align: 'right', numeric: true, cell: (g) => `${g.avg_tool_calls}${g.tool_failures ? ` · ${g.tool_failures} failed` : ''}` },
                { key: 'o', header: 'Tokens', align: 'right', numeric: true, cell: (g) => (g.input_tokens + g.output_tokens).toLocaleString() },
                { key: '$', header: 'Est. cost', align: 'right', numeric: true, cell: (g) => (g.estimated_cost_usd == null ? '—' : `$${g.estimated_cost_usd.toFixed(4)}`) },
              ]}
            />
          )}
          <p>The model is the one set under AI assistant. The engine and budget are set in the server configuration (agent.decision, agent.budget).</p>
        </section>
      )}

      <Modal open={draft !== null} onClose={() => setDraft(null)} title="Create a token for an MCP client">
        {draft && (
          <div className="space-y-4">
            <Field label="Name" hint="The client it is for, so you know what to revoke" htmlFor="agent-token-name">
              <Input id="agent-token-name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Claude Desktop" data-testid="agent-token-name" />
            </Field>
            <Checkbox label="Let it make changes" hint="Dashboards, checks, models… Changes to data still wait for your approval." checked={draft.write} onChange={(e) => setDraft({ ...draft, write: e.target.checked })} />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setDraft(null)}>Cancel</Button>
              <Button variant="primary" loading={busy} onClick={() => void create()} data-testid="agent-token-create"><KeyRound className="h-3.5 w-3.5" /> Create token</Button>
            </div>
          </div>
        )}
      </Modal>
      <Modal open={issued !== null} onClose={() => setIssued(null)} title="Copy the token now" width="max-w-2xl">
        {issued && (
          <div className="space-y-3" data-testid="agent-token-issued">
            <p className="text-xs text-zinc-400">This is the only time the token is shown. The configuration below already contains it.</p>
            <div className="flex gap-2">
              <Input readOnly value={issued} className="font-mono" aria-label="Token" data-testid="agent-token-value" />
              <CopyButton text={issued} label="Copy the token" />
            </div>
            <div className="relative">
              <pre className="overflow-auto rounded-md border border-zinc-800 bg-zinc-900/60 p-3 font-mono text-2xs text-zinc-300">{mcpConfig(url, issued)}</pre>
              <div className="absolute right-2 top-2"><CopyButton text={mcpConfig(url, issued)} label="Copy the configuration" /></div>
            </div>
            <div className="flex justify-end"><Button variant="primary" onClick={() => setIssued(null)}>Done</Button></div>
          </div>
        )}
      </Modal>
    </div>
  );
}
