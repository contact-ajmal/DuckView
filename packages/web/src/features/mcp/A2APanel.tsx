import { useCallback, useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Globe, Plus, RefreshCw, Send, Trash2 } from 'lucide-react';
import { api, type A2AInfo, type A2ARemote } from '../../api/client';
import { Badge, Button, CopyButton, Input, Label, cn } from '../../components/ui';

const MD = 'text-body leading-relaxed text-zinc-300 [&_h2]:mt-2 [&_h2]:font-semibold [&_li]:ml-4 [&_li]:list-disc [&_p]:my-1.5 [&_code]:rounded [&_code]:bg-zinc-800 [&_code]:px-1 [&_code]:font-mono [&_code]:text-2xs [&_td]:border [&_td]:border-zinc-800 [&_td]:px-2 [&_th]:border [&_th]:border-zinc-800 [&_th]:px-2';

/** AI → DuckView agents: talking to other agents over A2A — this server's card, and remote agents to ask. */
export function A2APanel({ refreshKey }: { refreshKey?: number }) {
  const [info, setInfo] = useState<A2AInfo | null>(null);
  const [remotes, setRemotes] = useState<A2ARemote[]>([]);
  const [adding, setAdding] = useState<{ url: string; header: string; value: string } | null>(null);
  const [asks, setAsks] = useState<Record<string, { text: string; answer: string | null; state: string | null; context_id: string | null }>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [i, r] = await Promise.all([api.get<A2AInfo>('/api/a2a'), api.get<{ remotes: A2ARemote[] }>('/api/a2a/remotes')]);
    setInfo(i);
    setRemotes(r.remotes);
  }, []);
  useEffect(() => void load().catch((e) => setError((e as Error).message)), [load, refreshKey]);

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
  const ask = (r: A2ARemote) =>
    act(`ask:${r.id}`, async () => {
      const cur = asks[r.id]!;
      const res = await api.post<{ text: string; state: string; context_id: string | null }>(`/api/a2a/remotes/${r.id}/ask`, { message: cur.text, context_id: cur.context_id });
      setAsks((a) => ({ ...a, [r.id]: { ...cur, answer: res.text, state: res.state, context_id: res.context_id } }));
    });

  if (!info) return error ? <p className="text-red-300">{error}</p> : null;
  if (!info.enabled) return <p className="text-xs text-zinc-500">Agent-to-agent (A2A) is turned off on this server (a2a.enabled).</p>;

  return (
    <div className="space-y-6 text-xs" data-testid="a2a">
      {error && <div className="rounded-md border border-red-900 bg-red-950/50 px-3 py-2 font-mono text-red-200">{error}</div>}
      <section className="space-y-2">
        <div className="flex items-center gap-2">
          <h2 className="text-body font-semibold text-zinc-100">Other agents can call yours</h2>
          <span className="text-zinc-500">over A2A, with a DuckView API token; each call runs as the token's owner, read-only</span>
        </div>
        <div className="flex items-center gap-2 rounded-md border border-zinc-800 px-3 py-2">
          <Globe className="h-3.5 w-3.5 text-zinc-500" />
          <span className="text-zinc-400">DuckView's agent card</span>
          <code className="min-w-0 flex-1 truncate font-mono text-zinc-200" data-testid="a2a-card-url">{info.card_url}</code>
          <CopyButton text={info.card_url} />
        </div>
        {info.agents.length === 0 ? <p className="text-zinc-500">No published agents you can reach yet — turn on "Other agents can call it" on an agent above.</p> : (
          <ul className="divide-y divide-zinc-800/70 rounded-md border border-zinc-800" data-testid="a2a-published">
            {info.agents.map((a) => (
              <li key={a.id} className="flex items-center gap-2 px-3 py-1.5">
                <span className="w-44 shrink-0 truncate text-zinc-200">{a.name}</span>
                <code className="min-w-0 flex-1 truncate font-mono text-zinc-400">{a.endpoint}</code>
                <CopyButton text={a.card_url} label="Card URL" />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-2">
        <div className="flex items-center gap-2">
          <h2 className="text-body font-semibold text-zinc-100">Agents you can ask</h2>
          <span className="text-zinc-500">remote A2A agents, added by the URL of their agent card</span>
          {!adding && <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setAdding({ url: '', header: 'Authorization', value: '' })} data-testid="a2a-add"><Plus className="h-3.5 w-3.5" /> Add an agent</Button>}
        </div>
        {adding && (
          <div className="space-y-2 rounded-md border border-zinc-800 p-3">
            <div><Label>Agent URL or agent card URL</Label><Input value={adding.url} onChange={(e) => setAdding({ ...adding, url: e.target.value })} placeholder="https://agent.example.com  (…/.well-known/agent-card.json)" data-testid="a2a-url" /></div>
            <div className="flex gap-2">
              <div className="w-44"><Label>Auth header (optional)</Label><Input value={adding.header} onChange={(e) => setAdding({ ...adding, header: e.target.value })} /></div>
              <div className="flex-1"><Label>Value — stored encrypted</Label><Input type="password" value={adding.value} onChange={(e) => setAdding({ ...adding, value: e.target.value })} placeholder="Bearer …" data-testid="a2a-header" /></div>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setAdding(null)}>Cancel</Button>
              <Button variant="primary" loading={busy === 'add'} disabled={!adding.url.trim()} onClick={() => void act('add', async () => { await api.post('/api/a2a/remotes', { url: adding.url, headers: adding.value.trim() ? { [adding.header.trim() || 'Authorization']: adding.value.trim() } : null }); setAdding(null); await load(); })} data-testid="a2a-save">Read the card and add</Button>
            </div>
          </div>
        )}
        {remotes.length === 0 && !adding ? <p className="text-zinc-500">No remote agents yet.</p> : (
          <div className="space-y-2" data-testid="a2a-remotes">
            {remotes.map((r) => {
              const cur = asks[r.id] ?? { text: '', answer: null, state: null, context_id: null };
              return (
                <div key={r.id} className="space-y-2 rounded-md border border-zinc-800 p-3" data-remote={r.name}>
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="text-body font-medium text-zinc-100">{r.name}</div>
                      <p className="text-zinc-400">{String(r.card.description ?? '')}</p>
                      <p className="mt-1 flex flex-wrap gap-1">{(r.card.skills ?? []).slice(0, 8).map((s) => <Badge key={s.id}>{s.name}</Badge>)}</p>
                    </div>
                    <Button size="sm" variant="ghost" loading={busy === `refresh:${r.id}`} onClick={() => void act(`refresh:${r.id}`, async () => { await api.post(`/api/a2a/remotes/${r.id}/refresh`, {}); await load(); })} title="Read the agent card again" aria-label="Read the agent card again"><RefreshCw className="h-3.5 w-3.5" /></Button>
                    <Button size="sm" variant="ghost" onClick={() => void act(`del:${r.id}`, async () => { await api.del(`/api/a2a/remotes/${r.id}`); await load(); })} title="Remove" aria-label="Remove"><Trash2 className="h-3.5 w-3.5" /></Button>
                  </div>
                  <div className="flex gap-2">
                    <Input value={cur.text} onChange={(e) => setAsks((a) => ({ ...a, [r.id]: { ...cur, text: e.target.value } }))} onKeyDown={(e) => e.key === 'Enter' && cur.text.trim() && void ask(r)} placeholder={r.card.skills?.[0]?.examples?.[0] ?? `Ask ${r.name}…`} className="min-w-0 flex-1" data-testid="a2a-ask-input" />
                    <Button loading={busy === `ask:${r.id}`} disabled={!cur.text.trim()} onClick={() => void ask(r)} data-testid="a2a-ask"><Send className="h-3.5 w-3.5" /> Ask</Button>
                  </div>
                  {cur.answer !== null && (
                    <div className={cn('rounded-md bg-zinc-900/60 px-3 py-2', cur.state !== 'completed' && 'border border-amber-900/60')} data-testid="a2a-answer">
                      <div className={MD}><ReactMarkdown remarkPlugins={[remarkGfm]}>{cur.answer}</ReactMarkdown></div>
                      {cur.state !== 'completed' && <p className="mt-1 text-amber-300">The task is {cur.state}.</p>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
