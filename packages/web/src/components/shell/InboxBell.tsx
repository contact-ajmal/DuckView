import { useCallback, useEffect, useState } from 'react';
import { AtSign, Bell, MessageSquare } from 'lucide-react';
import { api, timeAgo, type InboxItem } from '../../api/client';
import { useWorkspace } from '../../store/workspace';
import { subscribeLiveEvents } from '../../lib/liveEvents';
import { Menu, cn } from '../ui';

/** The inbox: mentions and replies, newest first; opening one switches workspace if needed and marks it read. */
export function InboxBell() {
  const [items, setItems] = useState<InboxItem[]>([]);
  const [unread, setUnread] = useState(0);
  const load = useCallback(() => void api.get<{ items: InboxItem[]; unread: number }>('/api/inbox?limit=30').then((r) => { setItems(r.items); setUnread(r.unread); }).catch(() => undefined), []);
  useEffect(() => {
    load();
    return subscribeLiveEvents((e) => { if (e.type === 'inbox') load(); });
  }, [load]);
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
        <button onClick={toggle} aria-expanded={isOpen} aria-label={unread ? `Inbox: ${unread} unread` : 'Inbox'} data-testid="inbox-bell" className="relative flex h-7 w-7 items-center justify-center rounded-md text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100">
          <Bell className="h-4 w-4" />
          {unread > 0 && <span className="absolute -right-0.5 -top-0.5 min-w-[15px] rounded-full bg-accent-500 px-1 text-center text-[9.5px] font-bold leading-[15px] text-[var(--accent-ink)]" data-testid="inbox-unread">{unread > 99 ? '99+' : unread}</span>}
        </button>
      )}
    >
      {(close) => (
        <div data-testid="inbox">
          <div className="flex items-center justify-between px-2 pb-1.5 pt-1 text-xs">
            <span className="font-semibold text-zinc-200">Inbox</span>
            {unread > 0 && <button className="text-zinc-500 hover:text-zinc-200" onClick={() => void api.post('/api/inbox/read', { all: true }).then(load)}>Mark all read</button>}
          </div>
          {items.length === 0 ? <p className="px-2 py-6 text-center text-xs text-zinc-500">Mentions and replies to your comments show up here.</p> : (
            <div className="max-h-[420px] overflow-auto">
              {items.map((i) => (
                <button key={i.id} role="menuitem" onClick={() => { close(); void open(i); }} className={cn('flex w-full gap-2.5 rounded-md px-2 py-2 text-left hover:bg-zinc-900', !i.read && 'bg-accent-500/5')} data-inbox={i.kind}>
                  <span className={cn('mt-0.5 shrink-0', i.read ? 'text-zinc-600' : 'text-accent-400')}>{i.kind === 'mention' ? <AtSign className="h-4 w-4" /> : <MessageSquare className="h-4 w-4" />}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-xs text-zinc-300"><b className="font-semibold text-zinc-100">{i.actor?.name ?? 'Someone'}</b> {i.kind === 'mention' ? 'mentioned you' : 'replied'} on <b className="font-medium text-zinc-100">{i.target_label}</b>{i.comment.anchor && i.comment.target_type === 'table' ? ` · ${i.comment.anchor}` : ''}</span>
                    <span className="mt-0.5 line-clamp-2 block text-xs text-zinc-500">{i.comment.body}</span>
                    <span className="mt-0.5 block text-[11px] text-zinc-600">{i.workspace} · {timeAgo(i.created_at)}</span>
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
