import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Check, MessageSquare, MoreHorizontal, RotateCcw } from 'lucide-react';
import { api, timeAgo, type CommentTarget, type CommentView, type Person } from '../../api/client';
import { useAuth } from '../../store/auth';
import { useWorkspaceAccess } from '../../store/workspace';
import { subscribeLiveEvents } from '../../lib/liveEvents';
import { Button, Drawer, Empty, IconButton, Menu, MenuItem, cn, confirmAction, InlineError } from '../../components/ui';

/** Open-thread counts for a target, per anchor ('' = the whole thing), kept live. */
export function useCommentCounts(workspaceId: string | null, targetType: CommentTarget, targetId: string | null) {
  const [counts, setCounts] = useState<{ open: number; by_anchor: Record<string, number> }>({ open: 0, by_anchor: {} });
  const load = useCallback(() => {
    if (!workspaceId || !targetId) return;
    void api.get<{ open: number; by_anchor: Record<string, number> }>(`/api/workspaces/${workspaceId}/comments?target_type=${targetType}&target_id=${encodeURIComponent(targetId)}`).then((r) => setCounts({ open: r.open, by_anchor: r.by_anchor })).catch(() => undefined);
  }, [workspaceId, targetType, targetId]);
  useEffect(() => {
    load();
    return subscribeLiveEvents((e) => {
      if (e.type === 'comment' && e.workspace_id === workspaceId && e.target_type === targetType && e.target_id === targetId) load();
    });
  }, [load, workspaceId, targetType, targetId]);
  return { ...counts, reload: load };
}

/** The comment button for a page header: "Comments 3". */
export function CommentsButton({ count, onClick }: { count: number; onClick: () => void }) {
  return (
    <Button size="sm" variant="ghost" onClick={onClick} data-testid="comments-button" title="Comments">
      <MessageSquare className="h-3.5 w-3.5" /> Comments{count ? <span className="rounded bg-accent-500 px-1 text-2xs font-semibold text-[var(--accent-ink)]">{count}</span> : null}
    </Button>
  );
}

/** A comment body: @mentions of people shown as names. */
function Body({ text, people }: { text: string; people: Person[] }) {
  const parts: ReactNode[] = [];
  const re = /@([\w.+-]+@[\w-]+(?:\.[\w-]+)+)/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    const p = people.find((x) => x.email.toLowerCase() === m[1]!.toLowerCase());
    parts.push(text.slice(last, m.index));
    parts.push(p ? <span key={m.index} className="rounded bg-accent-500/15 px-0.5 font-medium text-accent-300" title={p.email}>@{p.name}</span> : m[0]);
    last = m.index! + m[0].length;
  }
  parts.push(text.slice(last));
  return <p className="whitespace-pre-wrap break-words text-body leading-relaxed text-zinc-200">{parts}</p>;
}

/** A textarea that suggests people after "@" and inserts @their@email. */
function Composer({ people, placeholder, onSubmit, autoFocus, initial = '', submitLabel = 'Comment', onCancel }: { people: Person[]; placeholder: string; onSubmit: (body: string) => Promise<void>; autoFocus?: boolean; initial?: string; submitLabel?: string; onCancel?: () => void }) {
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState<string | null>(null);
  const [pick, setPick] = useState(0);
  const ta = useRef<HTMLTextAreaElement>(null);
  const matches = useMemo(() => (query === null ? [] : people.filter((p) => `${p.name} ${p.email}`.toLowerCase().includes(query.toLowerCase())).slice(0, 6)), [people, query]);
  const onInput = (v: string, caret: number) => {
    setText(v);
    const m = /(^|\s)@([\w.+-]*)$/.exec(v.slice(0, caret));
    setQuery(m ? m[2]! : null);
    setPick(0);
  };
  const insert = (p: Person) => {
    const el = ta.current!;
    const caret = el.selectionStart;
    const before = text.slice(0, caret).replace(/@([\w.+-]*)$/, `@${p.email} `);
    const next = before + text.slice(caret);
    setText(next);
    setQuery(null);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(before.length, before.length);
    });
  };
  const submit = async () => {
    if (!text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(text.trim());
      setText('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="relative">
      <textarea
        ref={ta}
        autoFocus={autoFocus}
        value={text}
        rows={Math.min(8, Math.max(2, text.split('\n').length))}
        placeholder={placeholder}
        aria-label={placeholder}
        data-testid="comment-input"
        onChange={(e) => onInput(e.target.value, e.target.selectionStart)}
        onKeyDown={(e) => {
          if (matches.length && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault();
            setPick((i) => (i + (e.key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length);
          } else if (matches.length && (e.key === 'Enter' || e.key === 'Tab')) {
            e.preventDefault();
            insert(matches[pick]!);
          } else if (e.key === 'Escape' && query !== null) {
            e.stopPropagation();
            setQuery(null);
          } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void submit();
          }
        }}
        className="w-full resize-none rounded-md border border-zinc-800 bg-zinc-950 px-2.5 py-2 text-body text-zinc-100 placeholder:text-zinc-600 focus:border-accent-500 focus:outline-none"
      />
      {matches.length > 0 && (
        <div role="listbox" className="absolute left-0 right-0 top-full z-10 mt-1 rounded-md border border-zinc-800 bg-zinc-950 p-1 shadow-lg" data-testid="mention-list">
          {matches.map((p, i) => (
            <button key={p.id} role="option" aria-selected={i === pick} onMouseDown={(e) => { e.preventDefault(); insert(p); }} className={cn('flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs', i === pick ? 'bg-zinc-800 text-zinc-50' : 'text-zinc-300 hover:bg-zinc-900')}>
              <span className="font-medium">{p.name}</span><span className="truncate text-zinc-500">{p.email}</span>
            </button>
          ))}
        </div>
      )}
      <InlineError error={error} className="mt-1" />
      <div className="mt-1.5 flex items-center justify-end gap-2">
        <span className="mr-auto text-2xs text-zinc-600">@ to mention · ⌘/Ctrl+Enter to send</span>
        {onCancel && <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>}
        <Button size="sm" variant="primary" loading={busy} disabled={!text.trim()} onClick={() => void submit()} data-testid="comment-submit">{submitLabel}</Button>
      </div>
    </div>
  );
}

/**
 * The comments drawer for one target — all its threads, or those on one anchor (a notebook cell, a column) — with
 * new threads, replies, @mentions, resolve / reopen, edit and delete.
 */
export function CommentsPanel({ open, onClose, workspaceId, targetType, targetId, targetLabel, anchor, anchorLabel, focusThread }: { open: boolean; onClose: () => void; workspaceId: string; targetType: CommentTarget; targetId: string; targetLabel: string; anchor?: string | null; anchorLabel?: (a: string) => string; focusThread?: string | null }) {
  const me = useAuth((s) => s.user);
  const { canEdit, canManage: isOwner } = useWorkspaceAccess();
  const [threads, setThreads] = useState<CommentView[] | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [showResolved, setShowResolved] = useState(false);
  const [replying, setReplying] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const load = useCallback(async () => {
    const q = `target_type=${targetType}&target_id=${encodeURIComponent(targetId)}${anchor !== undefined ? `&anchor=${encodeURIComponent(anchor ?? '')}` : ''}`;
    setThreads((await api.get<{ threads: CommentView[] }>(`/api/workspaces/${workspaceId}/comments?${q}`)).threads);
  }, [workspaceId, targetType, targetId, anchor]);
  useEffect(() => {
    if (!open) return;
    void load().catch(() => setThreads([]));
    void api.get<{ people: Person[] }>(`/api/workspaces/${workspaceId}/people`).then((r) => setPeople(r.people)).catch(() => undefined);
    return subscribeLiveEvents((e) => {
      if (e.type === 'comment' && e.workspace_id === workspaceId && e.target_type === targetType && e.target_id === targetId) void load().catch(() => undefined);
    });
  }, [open, load, workspaceId, targetType, targetId]);
  useEffect(() => {
    if (open && focusThread && threads) document.querySelector(`[data-thread="${focusThread}"]`)?.scrollIntoView({ block: 'center' });
  }, [open, focusThread, threads]);

  const post = async (body: string, parent_id?: string) => {
    await api.post(`/api/workspaces/${workspaceId}/comments`, parent_id ? { parent_id, body } : { target_type: targetType, target_id: targetId, anchor: anchor ?? null, body });
    setReplying(null);
    await load();
  };
  const visible = (threads ?? []).filter((t) => showResolved || !t.resolved_at);
  const resolvedCount = (threads ?? []).filter((t) => t.resolved_at).length;
  const where = anchor ? `${targetLabel} · ${anchorLabel ? anchorLabel(anchor) : anchor}` : targetLabel;

  // A render function (not a component) so an open edit box survives re-renders.
  const item = (c: CommentView, root?: CommentView) => (
    <div className="group/c" data-comment={c.id}>
      <div className="flex items-baseline gap-2 text-xs">
        <span className="font-semibold text-zinc-100">{c.author?.name ?? 'Someone'}</span>
        <span className="text-zinc-500" title={new Date(c.created_at).toLocaleString()}>{timeAgo(c.created_at)}{c.edited_at ? ' · edited' : ''}</span>
        {(c.user_id === me?.id || isOwner) && (
          <span className="ml-auto opacity-0 transition-opacity group-hover/c:opacity-100 focus-within:opacity-100">
            <Menu width="w-36" trigger={(_, toggle) => <IconButton label="Comment actions" onClick={toggle} className="h-5 w-5"><MoreHorizontal className="h-3.5 w-3.5" /></IconButton>}>
              {(close) => (
                <>
                  {c.user_id === me?.id && <MenuItem onClick={() => { close(); setEditing(c.id); }}>Edit</MenuItem>}
                  <MenuItem danger onClick={async () => { close(); if ((await confirmAction(root ? 'Delete this reply?' : 'Delete this thread and its replies?'))) void api.del(`/api/comments/${c.id}`).then(load); }}>Delete</MenuItem>
                </>
              )}
            </Menu>
          </span>
        )}
      </div>
      {editing === c.id ? (
        <div className="mt-1"><Composer people={people} placeholder="Edit comment" initial={c.body} autoFocus submitLabel="Save" onCancel={() => setEditing(null)} onSubmit={async (body) => { await api.patch(`/api/comments/${c.id}`, { body }); setEditing(null); await load(); }} /></div>
      ) : <div className="mt-0.5"><Body text={c.body} people={people} /></div>}
    </div>
  );

  return (
    <Drawer open={open} onClose={onClose} title={<span>Comments <span className="font-normal text-zinc-500">· {where}</span></span>} width="w-[400px]">
      <div className="space-y-4 p-4" data-testid="comments-panel">
        <Composer people={people} placeholder={anchor ? `Comment on ${anchorLabel ? anchorLabel(anchor) : anchor}…` : `Comment on ${targetLabel}…`} onSubmit={(b) => post(b)} autoFocus={!focusThread} />
        {threads === null ? null : visible.length === 0 ? (
          <Empty icon={<MessageSquare />} title={resolvedCount ? 'No open threads' : 'No comments yet'} hint="Ask a question, flag a number that looks wrong, or @mention someone to bring them in." />
        ) : (
          <div className="space-y-3">
            {visible.map((t) => (
              <article key={t.id} data-thread={t.id} className={cn('space-y-3 rounded-lg border p-3', t.id === focusThread ? 'border-accent-500' : 'border-zinc-800', t.resolved_at && 'opacity-60')}>
                {!anchor && t.anchor && <div className="text-2xs text-zinc-500">on <span className="font-mono text-zinc-400">{anchorLabel ? anchorLabel(t.anchor) : t.anchor}</span></div>}
                {item(t)}
                {(t.replies ?? []).map((r) => <div key={r.id} className="border-l border-zinc-800 pl-3">{item(r, t)}</div>)}
                {replying === t.id ? (
                  <Composer people={people} placeholder="Reply…" autoFocus submitLabel="Reply" onCancel={() => setReplying(null)} onSubmit={(b) => post(b, t.id)} />
                ) : (
                  <div className="flex items-center gap-1">
                    <Button size="sm" variant="ghost" onClick={() => setReplying(t.id)} data-testid="reply">Reply</Button>
                    {(canEdit || t.user_id === me?.id) && (t.resolved_at ? (
                      <Button size="sm" variant="ghost" onClick={() => void api.post(`/api/comments/${t.id}/resolve`, { resolved: false }).then(load)}><RotateCcw className="h-3.5 w-3.5" /> Reopen</Button>
                    ) : (
                      <Button size="sm" variant="ghost" onClick={() => void api.post(`/api/comments/${t.id}/resolve`, { resolved: true }).then(load)} data-testid="resolve"><Check className="h-3.5 w-3.5" /> Resolve</Button>
                    ))}
                  </div>
                )}
              </article>
            ))}
          </div>
        )}
        {resolvedCount > 0 && <button className="text-xs text-zinc-500 hover:text-zinc-200" onClick={() => setShowResolved((v) => !v)}>{showResolved ? 'Hide' : 'Show'} {resolvedCount} resolved</button>}
      </div>
    </Drawer>
  );
}

/** A header button with the open count and the drawer behind it; a ?comment=<thread> link opens it on that thread. */
export function CommentsControl({ workspaceId, targetType, targetId, targetLabel }: { workspaceId: string; targetType: CommentTarget; targetId: string; targetLabel: string }) {
  const counts = useCommentCounts(workspaceId, targetType, targetId);
  const [open, setOpen] = useState<{ focus?: string | null } | null>(() => {
    const t = /[?&]comment=([\w-]+)/.exec(location.hash)?.[1];
    return t ? { focus: t } : null;
  });
  return (
    <>
      <CommentsButton count={counts.open} onClick={() => setOpen({})} />
      {open && <CommentsPanel open onClose={() => setOpen(null)} workspaceId={workspaceId} targetType={targetType} targetId={targetId} targetLabel={targetLabel} focusThread={open.focus} />}
    </>
  );
}
