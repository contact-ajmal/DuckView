import { useMemo, useState } from 'react';
import { Folder, FolderOpen, FileCode2, Trash2, Play, ChevronRight, ChevronDown, Tag } from 'lucide-react';
import type { SavedQuery } from '../../api/client';
import { cn } from '../../components/ui';

export function SavedQueriesTree({ queries, onOpen, onRun, onDelete }: { queries: SavedQuery[]; onOpen: (q: SavedQuery) => void; onRun: (q: SavedQuery) => void; onDelete: (q: SavedQuery) => void }) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const folders = useMemo(() => {
    const map = new Map<string, SavedQuery[]>();
    for (const q of queries) {
      const f = q.folder || '';
      if (!map.has(f)) map.set(f, []);
      map.get(f)!.push(q);
    }
    return [...map.entries()].sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)));
  }, [queries]);
  if (queries.length === 0) return <p className="px-2 py-2 text-[11px] text-zinc-500">Save the current tab to build a library. Folders come from the folder field (e.g. finance/daily).</p>;
  return (
    <div className="text-xs">
      {folders.map(([folder, items]) => {
        const open = !collapsed.has(folder);
        return (
          <div key={folder || '__root'}>
            {folder && (
              <button
                onClick={() => {
                  const next = new Set(collapsed);
                  if (next.has(folder)) next.delete(folder);
                  else next.add(folder);
                  setCollapsed(next);
                }}
                className="flex w-full items-center gap-1 rounded px-1 py-1 text-left text-zinc-300 hover:bg-zinc-800/60"
              >
                {open ? <ChevronDown className="h-3 w-3 text-zinc-500" /> : <ChevronRight className="h-3 w-3 text-zinc-500" />}
                {open ? <FolderOpen className="h-3.5 w-3.5 text-amber-300/80" /> : <Folder className="h-3.5 w-3.5 text-amber-300/80" />}
                <span className="truncate font-mono">{folder}</span>
                <span className="ml-auto font-mono text-[10px] text-zinc-600">{items.length}</span>
              </button>
            )}
            {open &&
              items.map((q) => (
                <div key={q.id} className={cn('group flex items-center gap-1 rounded py-1 pr-1 hover:bg-zinc-800/60', folder ? 'pl-5' : 'pl-1')}>
                  <FileCode2 className="h-3.5 w-3.5 shrink-0 text-accent-300" />
                  <button className="min-w-0 flex-1 truncate text-left text-zinc-200" onClick={() => onOpen(q)} title={q.description ?? q.sql_text.slice(0, 200)}>
                    {q.name}
                  </button>
                  {q.tags.length > 0 && (
                    <span className="hidden items-center gap-0.5 font-mono text-[9px] text-zinc-500 group-hover:hidden xl:flex">
                      <Tag className="h-2.5 w-2.5" /> {q.tags.slice(0, 2).join(',')}
                    </span>
                  )}
                  <button className="rounded p-0.5 text-zinc-500 opacity-0 hover:text-accent-300 group-hover:opacity-100" onClick={() => onRun(q)} title="Run in a new tab">
                    <Play className="h-3 w-3" />
                  </button>
                  <button className="rounded p-0.5 text-zinc-500 opacity-0 hover:text-red-300 group-hover:opacity-100" onClick={() => onDelete(q)} title="Delete">
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              ))}
          </div>
        );
      })}
    </div>
  );
}
