import { useCallback, useEffect, useState } from 'react';
import { AtSign, Bell, MessageSquare, ShieldAlert } from 'lucide-react';
import { api, timeAgo, type InboxItem } from '../../api/client';
import { useWorkspace } from '../../store/workspace';
import { subscribeLiveEvents } from '../../lib/liveEvents';
import { Menu, cn } from '../ui';
import { describeIntent } from '../ai';
import { useAuth } from '../../store/auth';
import { agentApi, type AgentTask } from '../../features/agent/api';

/**
 * The inbox: changes your agents are waiting for you to approve (this session), then mentions and replies, newest
 * first; opening one switches workspace if needed and marks it read.
 */
export function InboxBell() {
  const [items, setItems] = useState<InboxItem[]>([]);
  const [unread, setUnread] = useState(0);
  const me = useAuth((a) => a.user?.id);
  const [held, setHeld] = useState<{ id: string; at: string; text: string; agent: string }[]>([]);
  const [heldSeen, setHeldSeen] = useState(0);
  /** Tasks of the DuckView agent paused for your approval (in any workspace): durable, unlike the held calls above. */
  const [agentWaiting, setAgentWaiting] = useState<AgentTask[]>([]);
  const loadAgent = useCallback(() => void agentApi.approvals().then(setAgentWaiting).catch(() => undefined), []);
  const load = useCallback(() => void api.get<{ items: InboxItem[]; unread: number }>('/api/inbox?limit=30').then((r) => { setItems(r.items); setUnread(r.unread); }).catch(() => undefined), []);
  useEffect(() => {
    load();
    loadAgent();
    return subscribeLiveEvents((e) => {
      if (e.type === 'inbox') load();
      if (e.type === 'agent' && /^agent\.(approval|completed|failed|cancelled)/.test(e.event)) loadAgent();
      // An agent acting as you tried to change data: it waits for your approval in its client.
      if (e.type === 'mcp_tool' && e.status === 'approval_required' && e.user_id === me) {
        setHeld((h) => [{ id: `${e.at}-${e.tool}`, at: e.at, text: describeIntent(e.tool, e.args, e.title), agent: e.agent?.name ?? 'An agent' }, ...h].slice(0, 10));
      }
    });
  }, [load, loadAgent, me]);
  const heldNew = held.length - heldSeen + agentWaiting.length;
  const open = async (i: InboxItem) => {
    if (!i.read) await api.post('/api/inbox/read', { ids: [i.id] }).catch(() => undefined);
    const ws = useWorkspace.getState();
    if (ws.activeId !== i.workspace_id) await ws.selectWorkspace(i.workspace_id);
    location.hash = i.url.replace(/^\/#/, '#');
    load();
  };
  return (
    <Menu
      width="w-[360px]"
      trigger={(isOpen, toggle) => (
        <button onClick={() => { toggle(); setHeldSeen(held.length); }} aria-expanded={isOpen} aria-label={unread + heldNew ? `Inbox: ${unread + heldNew} unread` : 'Inbox'} data-testid="inbox-bell" className="relative flex h-7 w-7 items-center justify-center rounded-md text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100">
          <Bell className="h-4 w-4" />
          {unread + heldNew > 0 && <span className="absolute -right-0.5 -top-0.5 min-w-[15px] rounded-full bg-accent-500 px-1 text-center text-[9.5px] font-bold leading-[15px] text-[var(--accent-ink)]" data-testid="inbox-unread">{unread + heldNew > 99 ? '99+' : unread + heldNew}</span>} {/* ui-lint-ignore: counter inside a 15px bubble */}
        </button>
      )}
    >
      {(close) => (
        <div data-testid="inbox">
          <div className="flex items-center justify-between px-2 pb-1.5 pt-1 text-xs">
            <span className="font-semibold text-zinc-200">Inbox</span>
            {unread > 0 && <button className="text-zinc-500 hover:text-zinc-200" onClick={() => void api.post('/api/inbox/read', { all: true }).then(load)}>Mark all read</button>}
          </div>
          {(held.length > 0 || agentWaiting.length > 0) && (
            <div className="mb-1 border-b border-zinc-800 pb-1" data-testid="inbox-approvals">
              <div className="px-2 pb-1 text-2xs font-medium text-zinc-500">Waiting for your approval</div>
              {agentWaiting.map((t) => (
                <button key={t.id} role="menuitem" onClick={() => { close(); location.hash = `#/?agent_task=${t.id}`; }} className="flex w-full gap-2.5 rounded-md px-2 py-2 text-left hover:bg-zinc-900" data-inbox="agent-approval">
                  <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-xs text-zinc-300"><b className="font-semibold text-zinc-100">DuckView agent</b> wants to {t.approval ? describeIntent(t.approval.tool, t.approval.arguments) : 'make a change'}</span>
                    <span className="mt-0.5 line-clamp-2 block text-2xs text-zinc-500">{t.request} · {timeAgo(t.approval?.requested_at ?? t.created_at)}</span>
                  </span>
                </button>
              ))}
              {held.map((h) => (
                <button key={h.id} role="menuitem" onClick={() => { close(); location.hash = '#/agents/approvals'; }} className="flex w-full gap-2.5 rounded-md px-2 py-2 text-left hover:bg-zinc-900" data-inbox="approval">
                  <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-xs text-zinc-300"><b className="font-semibold text-zinc-100">{h.agent}</b> wants to {h.text}</span>
                    <span className="mt-0.5 block text-2xs text-zinc-500">{timeAgo(h.at)}</span>
                  </span>
                </button>
              ))}
            </div>
          )}
          {items.length === 0 ? <p className="px-2 py-6 text-center text-xs text-zinc-500">Mentions and replies to your comments show up here.</p> : (
            <div className="max-h-[420px] overflow-auto">
              {items.map((i) => (
                <button key={i.id} role="menuitem" onClick={() => { close(); void open(i); }} className={cn('flex w-full gap-2.5 rounded-md px-2 py-2 text-left hover:bg-zinc-900', !i.read && 'bg-accent-500/5')} data-inbox={i.kind}>
                  <span className={cn('mt-0.5 shrink-0', i.read ? 'text-zinc-500' : 'text-accent-400')}>{i.kind === 'mention' ? <AtSign className="h-4 w-4" /> : <MessageSquare className="h-4 w-4" />}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-xs text-zinc-300"><b className="font-semibold text-zinc-100">{i.actor?.name ?? 'Someone'}</b> {i.kind === 'mention' ? 'mentioned you' : 'replied'} on <b className="font-medium text-zinc-100">{i.target_label}</b>{i.comment.anchor && i.comment.target_type === 'table' ? ` · ${i.comment.anchor}` : ''}</span>
                    <span className="mt-0.5 line-clamp-2 block text-xs text-zinc-500">{i.comment.body}</span>
                    <span className="mt-0.5 block text-2xs text-zinc-500">{i.workspace} · {timeAgo(i.created_at)}</span>
                  </span>
                  {!i.read && <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent-500" aria-label="unread" />}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </Menu>
  );
}
