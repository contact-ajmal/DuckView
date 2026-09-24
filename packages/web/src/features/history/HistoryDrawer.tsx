import { useCallback, useEffect, useMemo, useState } from 'react';
import { Bookmark, History, RotateCcw } from 'lucide-react';
import { api, timeAgo } from '../../api/client';
import { useWorkspaceAccess } from '../../store/workspace';
import { Button, Drawer, Empty, Input, Spinner, cn, confirmAction } from '../../components/ui';

export type RevisionType = 'notebook' | 'dashboard' | 'query' | 'semantic' | 'dbt';
interface RevisionRow { id: string; number: number; message: string | null; named: boolean; author: string | null; created_at: string; updated_at: string }

type DiffLine = { kind: 'same' | 'add' | 'del'; text: string };

/** A line diff (longest common subsequence), with unchanged runs folded to a few lines of context. */
export function lineDiff(a: string, b: string): DiffLine[] {
  const x = a.split('\n');
  const y = b.split('\n');
  if (x.length * y.length > 4_000_000) return [...x.map((t) => ({ kind: 'del' as const, text: t })), ...y.map((t) => ({ kind: 'add' as const, text: t }))];
  const n = x.length;
  const m = y.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i]![j] = x[i] === y[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) (out.push({ kind: 'same', text: x[i]! }), i++, j++);
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) out.push({ kind: 'del', text: x[i++]! });
    else out.push({ kind: 'add', text: y[j++]! });
  }
  while (i < n) out.push({ kind: 'del', text: x[i++]! });
  while (j < m) out.push({ kind: 'add', text: y[j++]! });
  return out;
}

function Diff({ from, to }: { from: string; to: string }) {
  const lines = useMemo(() => lineDiff(from, to), [from, to]);
  const changed = lines.some((l) => l.kind !== 'same');
  if (!changed) return <p className="px-1 py-3 text-xs text-zinc-500">Same as now.</p>;
  // Fold long unchanged runs, keeping 2 lines of context around changes.
  const keep = lines.map((l, i) => l.kind !== 'same' || lines.slice(Math.max(0, i - 2), i + 3).some((x) => x.kind !== 'same'));
  const rows: (DiffLine | { kind: 'fold'; n: number })[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (keep[i]) rows.push(lines[i]!);
    else {
      let k = i;
      while (k < lines.length && !keep[k]) k++;
      rows.push({ kind: 'fold', n: k - i });
      i = k - 1;
    }
  }
  return (
    <pre className="overflow-x-auto rounded-md border border-zinc-800 bg-zinc-950 py-1 font-mono text-xs leading-[1.55]" data-testid="revision-diff">
      {rows.map((r, i) => r.kind === 'fold' ? (
        <div key={i} className="px-2 text-zinc-500">⋯ {r.n} unchanged line{r.n === 1 ? '' : 's'}</div>
      ) : (
        <div key={i} className={cn('whitespace-pre px-2', r.kind === 'add' && 'bg-emerald-500/10 text-emerald-300', r.kind === 'del' && 'bg-red-500/10 text-red-300', r.kind === 'same' && 'text-zinc-400')}>{r.kind === 'add' ? '+ ' : r.kind === 'del' ? '- ' : '  '}{r.text || ' '}</div>
      ))}
    </pre>
  );
}

/**
 * Version history of one object: its revisions (newest first), a diff of any of them against now, restore, and
 * naming the current state. The diff reads "what restoring would change": red is what goes, green what comes back.
 */
export function HistoryDrawer({ open, onClose, workspaceId, objectType, objectId, title, onRestored }: { open: boolean; onClose: () => void; workspaceId: string; objectType: RevisionType; objectId: string; title: string; onRestored?: () => void }) {
  const { canEdit } = useWorkspaceAccess();
  const [rows, setRows] = useState<RevisionRow[] | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [detail, setDetail] = useState<{ text: string; current: string | null } | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    const r = await api.get<{ revisions: RevisionRow[] }>(`/api/workspaces/${workspaceId}/revisions?object_type=${objectType}&object_id=${encodeURIComponent(objectId)}`);
    setRows(r.revisions);
    setPicked((cur) => cur ?? r.revisions[1]?.id ?? r.revisions[0]?.id ?? null);
  }, [workspaceId, objectType, objectId]);
  useEffect(() => {
    if (open) void load().catch((e) => setError((e as Error).message));
  }, [open, load]);
  useEffect(() => {
    setDetail(null);
    if (picked) void api.get<{ text: string; current: string | null }>(`/api/revisions/${picked}`).then(setDetail).catch((e) => setError((e as Error).message));
  }, [picked]);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const pickedRow = rows?.find((r) => r.id === picked);
  return (
    <Drawer open={open} onClose={onClose} title={<span>Version history <span className="font-normal text-zinc-500">· {title}</span></span>} width="w-[640px]">
      <div className="grid h-full min-h-0 grid-cols-[200px_minmax(0,1fr)]" data-testid="history">
        <div className="min-h-0 overflow-auto border-r border-zinc-800 py-2">
          {canEdit && (
            <form className="mb-2 flex gap-1 px-2" onSubmit={(e) => { e.preventDefault(); void act(async () => { await api.post(`/api/workspaces/${workspaceId}/revisions`, { object_type: objectType, object_id: objectId, message: name }); setName(''); await load(); }); }}>
              <Input uiSize="sm" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name this version" aria-label="Name this version" />
              <Button size="sm" type="submit" disabled={!name.trim() || busy} title="Save the current state as a named version" aria-label="Save the current state as a named version"><Bookmark className="h-3.5 w-3.5" /></Button>
            </form>
          )}
          {rows === null ? <div className="p-3"><Spinner /></div> : rows.length === 0 ? <p className="px-3 py-4 text-xs text-zinc-500">No versions yet — they are kept from the next save.</p> : rows.map((r, i) => (
            <button key={r.id} onClick={() => setPicked(r.id)} data-revision={r.number} className={cn('flex w-full flex-col items-start gap-0.5 border-l-2 px-3 py-1.5 text-left', r.id === picked ? 'border-accent-500 bg-zinc-900' : 'border-transparent hover:bg-zinc-900/60')}>
              <span className="flex w-full items-center gap-1.5 text-xs text-zinc-100">
                {r.named && <Bookmark className="h-3 w-3 shrink-0 text-accent-400" />}
                <span className="truncate">{r.message ?? (i === 0 ? 'Current version' : `Version ${r.number}`)}</span>
              </span>
              <span className="text-2xs text-zinc-500" title={new Date(r.updated_at).toLocaleString()}>{r.author ?? 'someone'} · {timeAgo(r.updated_at)}</span>
            </button>
          ))}
        </div>
        <div className="min-h-0 overflow-auto p-3">
          {error && <div className="mb-2 rounded-md border border-red-900 bg-red-950/50 px-3 py-2 font-mono text-xs text-red-200">{error}</div>}
          {!pickedRow ? <Empty icon={<History />} title="Pick a version" hint="See what changed since, and bring it back." /> : (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-body font-semibold text-zinc-100">Version {pickedRow.number}{pickedRow.message ? ` — ${pickedRow.message}` : ''}</div>
                  <div className="text-2xs text-zinc-500">{pickedRow.author ?? 'someone'} · {new Date(pickedRow.updated_at).toLocaleString()}</div>
                </div>
                {canEdit && rows![0]?.id !== pickedRow.id && (
                  <Button size="sm" variant="primary" loading={busy} data-testid="restore-revision" onClick={async () => { if ((await confirmAction(`Restore version ${pickedRow.number}? The current state stays in the history.`))) void act(async () => { await api.post(`/api/revisions/${pickedRow.id}/restore`, {}); setPicked(null); await load(); onRestored?.(); }); }}><RotateCcw className="h-3.5 w-3.5" /> Restore</Button>
                )}
              </div>
              <p className="text-2xs text-zinc-500">Restoring would change: <span className="text-red-300">− now</span> <span className="text-emerald-300">+ this version</span></p>
              {detail ? <Diff from={detail.current ?? ''} to={detail.text} /> : <Spinner />}
            </div>
          )}
        </div>
      </div>
    </Drawer>
  );
}

/** A "Version history" button with the drawer behind it. */
export function HistoryButton(props: { workspaceId: string; objectType: RevisionType; objectId: string; title: string; onRestored?: () => void; label?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)} title="Version history" aria-label="Version history" data-testid="history-button"><History className="h-3.5 w-3.5" />{props.label ? ' History' : null}</Button>
      {open && <HistoryDrawer open onClose={() => setOpen(false)} {...props} />}
    </>
  );
}
