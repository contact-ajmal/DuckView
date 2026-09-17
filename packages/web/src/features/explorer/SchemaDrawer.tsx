import { useEffect, useState } from 'react';
import { X, Play, ScanSearch, Bot, Loader2, Table2 } from 'lucide-react';
import { api, formatBytes, type InspectResult } from '../../api/client';
import { TypePill } from '../../components/layout';
import { Button, cn } from '../../components/ui';

export function SchemaDrawer({ workspaceId, target, onClose, onQuery, onProfile, onAskCopilot }: { workspaceId: string; target: string | null; onClose: () => void; onQuery: (sql: string) => void; onProfile?: (target: string) => void; onAskCopilot?: (target: string) => void }) {
  const [result, setResult] = useState<InspectResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [activeTable, setActiveTable] = useState(0);

  useEffect(() => {
    if (!target) return;
    let alive = true;
    setLoading(true);
    setError(null);
    setResult(null);
    setActiveTable(0);
    api
      .post<InspectResult>('/api/storage/inspect', { workspace_id: workspaceId, target })
      .then((r) => alive && setResult(r))
      .catch((e) => alive && setError((e as Error).message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [workspaceId, target]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!target) return null;
  const columns = result?.tables?.length ? result.tables[activeTable]?.columns ?? [] : result?.columns ?? [];
  const suggested = result
    ? result.tables?.length && result.tables[activeTable]
      ? `ATTACH '${result.target}' AS attached_db (READ_ONLY);\nSELECT * FROM attached_db.${result.tables[activeTable]!.schema === 'main' ? result.tables[activeTable]!.name : `${result.tables[activeTable]!.schema}.${result.tables[activeTable]!.name}`} LIMIT 100;`
      : result.suggested_sql
    : '';

  return (
    <div className="fixed inset-y-0 right-0 z-40 flex w-full max-w-md flex-col border-l border-zinc-800 bg-zinc-950 shadow-2xl">
      <header className="flex items-start justify-between gap-3 border-b border-zinc-800 px-4 py-3">
        <div className="min-w-0">
          <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-accent-400">Schema preview</div>
          <div className="truncate font-mono text-sm text-zinc-100" title={target}>
            {target}
          </div>
          {result && (
            <div className="mt-1 flex flex-wrap gap-x-3 font-mono text-[11px] text-zinc-500">
              <span>{result.kind}</span>
              {result.row_count != null && <span>{result.row_count.toLocaleString()} rows · {result.row_count_source === 'parquet_metadata' ? 'from footer' : result.row_count_source}</span>}
              {result.size_bytes != null && <span>{formatBytes(result.size_bytes)}</span>}
              <span>{columns.length} columns</span>
            </div>
          )}
        </div>
        <button onClick={onClose} className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100" aria-label="Close">
          <X className="h-4 w-4" />
        </button>
      </header>

      {result?.tables && result.tables.length > 0 && (
        <div className="flex gap-1 overflow-x-auto border-b border-zinc-800 px-3 py-2">
          {result.tables.map((t, i) => (
            <button key={`${t.schema}.${t.name}`} onClick={() => setActiveTable(i)} className={cn('flex shrink-0 items-center gap-1 rounded-md px-2 py-1 font-mono text-[11px]', i === activeTable ? 'bg-zinc-800 text-zinc-50' : 'text-zinc-400 hover:text-zinc-200')}>
              <Table2 className="h-3 w-3" /> {t.name}
            </button>
          ))}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {loading && (
          <div className="flex h-40 items-center justify-center gap-2 text-xs text-zinc-400">
            <Loader2 className="h-4 w-4 animate-spin" /> DESCRIBE … LIMIT 0
          </div>
        )}
        {error && <div className="m-4 rounded-md border border-red-900 bg-red-950/40 p-3 font-mono text-xs text-red-200">{error}</div>}
        {result && (
          <table className="w-full font-mono text-xs">
            <thead className="sticky top-0 bg-zinc-950 text-left text-[10px] uppercase tracking-wide text-zinc-500">
              <tr className="border-b border-zinc-800">
                <th className="px-4 py-2 font-normal">#</th>
                <th className="px-2 py-2 font-normal">column</th>
                <th className="px-2 py-2 font-normal">type</th>
                <th className="px-4 py-2 text-right font-normal">nullable</th>
              </tr>
            </thead>
            <tbody>
              {columns.map((c, i) => (
                <tr key={c.name} className="border-b border-zinc-800/60 hover:bg-zinc-800/40">
                  <td className="px-4 py-1.5 text-zinc-600">{i + 1}</td>
                  <td className="px-2 py-1.5 text-zinc-100">{c.name}</td>
                  <td className="px-2 py-1.5">
                    <TypePill type={c.type} />
                  </td>
                  <td className="px-4 py-1.5 text-right text-zinc-400">{c.nullable ? 'yes' : 'no'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {result && (
        <footer className="space-y-2 border-t border-zinc-800 p-3">
          <pre className="max-h-24 overflow-auto rounded-md border border-zinc-800 bg-zinc-900 p-2 font-mono text-[11px] text-zinc-300">{suggested}</pre>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" size="sm" onClick={() => onQuery(suggested)}>
              <Play className="h-3.5 w-3.5" /> Query this file
            </Button>
            {onProfile && result.kind !== 'database' && (
              <Button size="sm" onClick={() => onProfile(result.target)}>
                <ScanSearch className="h-3.5 w-3.5" /> Profile
              </Button>
            )}
            {onAskCopilot && result.kind !== 'database' && (
              <Button size="sm" onClick={() => onAskCopilot(result.target)}>
                <Bot className="h-3.5 w-3.5" /> Ask DuckCopilot
              </Button>
            )}
          </div>
        </footer>
      )}
    </div>
  );
}
