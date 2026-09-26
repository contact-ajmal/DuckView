/**
 * The agent dock: the workspace's command bar and the agent's activity, at the bottom of every work surface.
 *
 * Collapsed, it is one line: "Ask anything about this workspace…", what the agent will look at (the page on screen,
 * the workspace), and whether it is working. Expanded (it opens by itself when a task starts), it shows the session:
 * each request with its plan, its steps in words, approvals, the answer and what was made. The workspace moves
 * around it: the agent opens dashboards, tables and SQL tabs where the person works, rather than in a chat.
 *
 * ⌘I focuses the bar; Esc collapses the panel.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, History, Plus, Sparkles, Square, Trash2 } from 'lucide-react';
import { ContextChip } from '../../components/ai';
import { Button, IconButton, Input, StatusDot, cn, confirmAction } from '../../components/ui';
import { usePageContext } from '../../store/context';
import { useWorkspace } from '../../store/workspace';
import { pageKey, useAgent } from './store';
import { AgentTaskView } from './AgentTaskView';
import { suggestionsFor } from './suggestions';
import type { AgentSession } from './api';

function dayOf(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const y = new Date(today);
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

export function AgentDock() {
  const agent = useAgent();
  const ws = useWorkspace();
  const page = usePageContext((s) => s.object);
  const [input, setInput] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const wsId = ws.activeId;
  const wsName = ws.workspaces.find((w) => w.id === wsId)?.name ?? 'workspace';
  const pageOn = page && agent.pageOff !== pageKey(page) ? page : null;
  const running = agent.tasks.find((t) => t.status === 'running' || t.status === 'planning');
  const waiting = agent.tasks.find((t) => t.status === 'waiting_approval');
  const suggestions = useMemo(() => suggestionsFor(pageOn), [pageOn]);

  // A new workspace starts a new session; the page chip comes back when the page changes.
  useEffect(() => {
    agent.reset();
    if (wsId) void agent.loadSessions(wsId);
  }, [wsId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (agent.pageOff && page && agent.pageOff !== pageKey(page)) agent.setPageOff(null);
  }, [page]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'i') {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    if (agent.focusToken) inputRef.current?.focus();
  }, [agent.focusToken]);
  // #/…?agent_task=<id> (from an approval link an external agent handed over): open that task's session.
  useEffect(() => {
    const open = () => {
      const id = new URLSearchParams(location.hash.split('?')[1] ?? '').get('agent_task');
      if (id) void agent.openTask(id);
    };
    open();
    window.addEventListener('hashchange', open);
    return () => window.removeEventListener('hashchange', open);
  }, [wsId]); // eslint-disable-line react-hooks/exhaustive-deps
  // Follow the newest output.
  const last = agent.tasks.at(-1);
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [agent.tasks.length, last?.steps.length, last?.draft?.length, last?.status, last?.artifacts.length]);

  if (!wsId) return null;

  const submit = (text = input) => {
    const request = text.trim();
    if (!request || running) return;
    setInput('');
    void agent.ask(wsId, request);
  };
  const dragStart = (e: React.MouseEvent) => {
    const startY = e.clientY;
    const startH = agent.height;
    const move = (ev: MouseEvent) => agent.setHeight(startH - (ev.clientY - startY));
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  return (
    <section className="relative shrink-0 border-t border-zinc-800 bg-zinc-950" aria-label="DuckView agent" data-testid="agent-dock" data-expanded={agent.expanded}>
      {agent.expanded && (
        <>
          <div className="absolute inset-x-0 -top-1 z-10 h-2 cursor-row-resize hover:bg-accent-700/40" onMouseDown={dragStart} role="separator" aria-orientation="horizontal" aria-label="Resize the agent panel" />
          <div className="flex h-9 items-center gap-2 border-b border-zinc-800 px-4">
            <Sparkles className="h-3.5 w-3.5 shrink-0 text-accent-400" />
            <h2 className="min-w-0 flex-1 truncate text-xs font-semibold text-zinc-100" data-testid="agent-session-title">{agent.sessionTitle ?? 'New session'}</h2>
            <Button size="sm" variant="ghost" onClick={() => agent.newSession()} disabled={!!running} data-testid="agent-new-session"><Plus className="h-3.5 w-3.5" /> New session</Button>
            <IconButton label="Session history" active={agent.historyOpen} onClick={() => agent.setHistoryOpen(!agent.historyOpen)} data-testid="agent-history-toggle"><History className="h-3.5 w-3.5" /></IconButton>
            <IconButton label="Collapse the agent" onClick={() => agent.setExpanded(false)}><ChevronDown className="h-3.5 w-3.5" /></IconButton>
          </div>
          <div className="flex min-h-0" style={{ height: agent.height }}>
            <div ref={scroller} className="@container min-w-0 flex-1 overflow-auto px-4" data-testid="agent-tasks">
              {agent.tasks.length === 0 ? (
                <div className="flex h-full flex-col justify-center gap-3 py-6">
                  <p className="text-xs text-zinc-400">Ask about the data, or ask the agent to build, check or change something. It works in this workspace as you, with your access, and asks before it changes anything that matters.</p>
                  <div className="flex flex-wrap gap-1.5" data-testid="agent-suggestions">
                    {suggestions.map((s) => <Button key={s} size="sm" onClick={() => submit(s)}>{s}</Button>)}
                  </div>
                </div>
              ) : (
                <div className="divide-y divide-zinc-800/70">{agent.tasks.map((t) => <AgentTaskView key={t.id} task={t} />)}</div>
              )}
            </div>
            {agent.historyOpen && <SessionHistory sessions={agent.sessions} current={agent.sessionId} onOpen={(id) => void agent.openSession(id)} onDelete={async (s) => { if (await confirmAction(`Delete the session “${s.title}”?`, { confirmLabel: 'Delete' })) await agent.deleteSession(s.id); }} />}
          </div>
        </>
      )}
      <form
        className="flex min-h-11 items-center gap-2 px-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Sparkles className="h-4 w-4 shrink-0 text-accent-400" aria-hidden />
        <Input
          ref={inputRef}
          variant="bare"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onFocus={() => agent.tasks.length === 0 && !agent.expanded && agent.setExpanded(true)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              agent.setExpanded(false);
              inputRef.current?.blur();
            }
          }}
          placeholder={pageOn ? `Ask about ${pageOn.label}, or anything in this workspace…` : 'Ask anything about this workspace…'}
          aria-label="Ask the agent"
          className="h-8 min-w-0 flex-1"
          data-testid="agent-input"
        />
        <div className="hidden min-w-0 items-center gap-1.5 md:flex" data-testid="agent-context">
          {pageOn && <ContextChip label={pageOn.label} kind={pageOn.kind} onRemove={() => agent.setPageOff(pageKey(pageOn))} testid="agent-context-page" />}
          <span className="max-w-[10rem] truncate text-2xs text-zinc-500" title="The workspace the agent works in">{wsName}</span>
        </div>
        {running && <StatusDot tone="busy" pulse className="shrink-0" data-testid="agent-status">{running.live ? 'Working' : 'Thinking'}</StatusDot>}
        {!running && waiting && <button type="button" className="shrink-0" onClick={() => agent.setExpanded(true)}><StatusDot tone="warn">Needs approval</StatusDot></button>}
        {running || waiting ? (
          <IconButton label="Stop the task" onClick={() => void agent.cancel()} data-testid="agent-stop"><Square className="h-3.5 w-3.5" /></IconButton>
        ) : (
          <Button type="submit" size="sm" variant="primary" disabled={!input.trim()} data-testid="agent-send">Ask</Button>
        )}
        <IconButton label={agent.expanded ? 'Collapse the agent' : 'Show the agent'} onClick={() => agent.setExpanded(!agent.expanded)} data-testid="agent-toggle">{agent.expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronUp className="h-3.5 w-3.5" />}</IconButton>
      </form>
    </section>
  );
}

function SessionHistory({ sessions, current, onOpen, onDelete }: { sessions: AgentSession[]; current: string | null; onOpen: (id: string) => void; onDelete: (s: AgentSession) => void }) {
  const groups = new Map<string, AgentSession[]>();
  for (const s of sessions) groups.set(dayOf(s.updated_at), [...(groups.get(dayOf(s.updated_at)) ?? []), s]);
  return (
    <aside className="w-72 shrink-0 overflow-auto border-l border-zinc-800 py-2" aria-label="Session history" data-testid="agent-history">
      {sessions.length === 0 && <p className="px-3 text-2xs text-zinc-500">No earlier sessions in this workspace.</p>}
      {[...groups].map(([day, list]) => (
        <div key={day} className="mb-2">
          <div className="px-3 pb-1 text-2xs text-zinc-500">{day}</div>
          <ul>
            {list.map((s) => (
              <li key={s.id} className={cn('group flex items-center gap-1 px-1.5', s.id === current && 'bg-zinc-800/80')}>
                <button className="min-w-0 flex-1 truncate rounded px-1.5 py-1 text-left text-xs text-zinc-300 hover:text-zinc-50" onClick={() => onOpen(s.id)} title={s.title} data-testid="agent-history-item">
                  {s.title}
                </button>
                {s.last_status === 'waiting_approval' && <StatusDot tone="warn"><span className="sr-only">Needs approval</span></StatusDot>}
                <IconButton label={`Delete ${s.title}`} className="opacity-0 group-hover:opacity-100 focus:opacity-100" onClick={() => onDelete(s)}><Trash2 className="h-3 w-3" /></IconButton>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </aside>
  );
}

