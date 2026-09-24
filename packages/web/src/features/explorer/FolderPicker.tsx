import { useEffect, useState } from 'react';
import { Folder, ChevronUp, Loader2, FolderPlus, Home } from 'lucide-react';
import { api } from '../../api/client';
import { Button, Input, Modal, cn } from '../../components/ui';

interface Browse { mode: 'sandboxed' | 'full'; path: string; parent: string | null; entries: { name: string; path: string; data_files: number }[] }

/** Server-side folder browser — the web equivalent of VS Code's "Add Folder to Workspace…" dialog. */
export function FolderPicker({ open, workspaceId, onClose, onPick }: { open: boolean; workspaceId: string; onClose: () => void; onPick: (path: string) => Promise<void> }) {
  const [state, setState] = useState<Browse | null>(null);
  const [manual, setManual] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async (p?: string) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.get<Browse>(`/api/storage/browse?workspace_id=${workspaceId}${p ? `&path=${encodeURIComponent(p)}` : ''}`);
      setState(r);
      setManual(r.path);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (open) void load();
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = async (p: string) => {
    setBusy(true);
    setError(null);
    try {
      await onPick(p);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Add folder to workspace" width="max-w-xl">
      <div className="space-y-3">
        <div className="flex items-center gap-1.5">
          <Button size="sm" variant="ghost" onClick={() => void load()} title="Home"><Home className="h-3.5 w-3.5" /></Button>
          <Button size="sm" variant="ghost" disabled={!state?.parent} onClick={() => state?.parent && void load(state.parent)} title="Up one level"><ChevronUp className="h-3.5 w-3.5" /></Button>
          <form className="flex min-w-0 flex-1 gap-1.5" onSubmit={(e) => { e.preventDefault(); void load(manual); }}>
            <Input value={manual} onChange={(e) => setManual(e.target.value)} className="h-8 font-mono text-xs" placeholder="/absolute/path" />
            <Button size="sm" type="submit">Go</Button>
          </form>
        </div>
        {state?.mode === 'sandboxed' && <p className="text-2xs text-amber-300">This server runs in sandboxed mode: only folders inside the data directory can be added.</p>}
        <div className="h-72 overflow-auto rounded-md border border-zinc-800 bg-zinc-950">
          {busy && !state && <div className="flex h-full items-center justify-center"><Loader2 className="h-4 w-4 animate-spin text-zinc-500" /></div>}
          {state?.entries.length === 0 && <div className="p-4 text-center text-xs text-zinc-500">No sub-folders here.</div>}
          {state?.entries.map((e) => (
            <div key={e.path} className="group flex items-center gap-2 border-b border-zinc-800/60 px-3 py-1.5 text-xs hover:bg-zinc-800/60">
              <Folder className="h-3.5 w-3.5 text-amber-300/80" />
              <button className="min-w-0 flex-1 truncate text-left text-zinc-200" onClick={() => void load(e.path)} onDoubleClick={() => void pick(e.path)} title={e.path}>{e.name}</button>
              {e.data_files > 0 && <span className="font-mono text-2xs text-zinc-500">{e.data_files} data file{e.data_files === 1 ? '' : 's'}</span>}
              <button className={cn('rounded px-1.5 py-0.5 text-2xs text-accent-300 opacity-0 hover:bg-accent-600/20 group-hover:opacity-100')} onClick={() => void pick(e.path)}>add</button>
            </div>
          ))}
        </div>
        {error && <div className="rounded-md border border-red-900 bg-red-950/50 px-3 py-2 text-xs text-red-200">{error}</div>}
        <div className="flex items-center justify-between">
          <span className="truncate font-mono text-2xs text-zinc-500" title={state?.path}>{state?.path}</span>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button variant="primary" loading={busy} disabled={!state} onClick={() => state && void pick(state.path)}><FolderPlus className="h-3.5 w-3.5" /> Add this folder</Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
