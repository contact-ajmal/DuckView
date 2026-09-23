import { useEffect, useState } from 'react';
import { Play, ScanSearch, Bot, Loader2, Table2, FileSearch } from 'lucide-react';
import { api, formatBytes, type InspectResult, type RemoteInspect } from '../../api/client';
import { TypePill } from '../../components/layout';
import { Button, Empty, cn } from '../../components/ui';
import { fetchCached } from '../../lib/useCached';
import { useAuth } from '../../store/auth';
import { useWorkspace } from '../../store/workspace';

/** Inline schema preview for the results pane (bottom) — DESCRIBE … LIMIT 0, no data scan. */
export function SchemaPanel({ workspaceId, target, remoteConnectionId, onQuery, onProfile, onAskCopilot }: { workspaceId: string; target: string | null; /** Lakehouse connection id when the target is a remote (non-attached) table — metadata comes from the catalog API. */ remoteConnectionId?: string | null; onQuery: (sql: string, title: string) => void; onProfile?: (target: string) => void; onAskCopilot?: (target: string) => void }) {
  const [result, setResult] = useState<InspectResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [activeTable, setActiveTable] = useState(0);

  const userId = useAuth((s) => s.user?.id ?? '');
  const version = useWorkspace((s) => s.workspaces.find((w) => w.id === workspaceId)?.data_version);
  useEffect(() => {
    if (!target) return;
    let alive = true;
    setLoading(true);
    setError(null);
    setResult(null);
    setActiveTable(0);
    // Local targets: browser copy first, then a conditional request (DESCRIBE never re-runs for an unchanged file).
    const req = remoteConnectionId
      ? api.get<RemoteInspect>(`/api/lakehouse/${remoteConnectionId}/inspect?table=${encodeURIComponent(target)}`).then((r): void => {
          if (alive) setResult({ target: r.target, kind: 'remote', columns: r.columns, row_count: null, row_count_source: null, size_bytes: null, suggested_sql: r.suggested_sql });
        })
      : fetchCached<InspectResult>({ userId, workspaceId, kind: 'inspect', target, url: '/api/storage/inspect', body: { workspace_id: workspaceId, target }, version }, (r) => alive && setResult(r));
    req.catch((e) => alive && setError((e as Error).message)).finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [workspaceId, target, remoteConnectionId, userId, version]);

  if (!target) return <Empty icon={<FileSearch className="h-8 w-8" />} title="Select a file to preview its schema" hint="Click any file or table in the Explorer. The preview reads only headers/footers — no data is scanned." />;
  const columns = result?.tables?.length ? result.tables[activeTable]?.columns ?? [] : result?.columns ?? [];
  const suggested = result
    ? result.tables?.length && result.tables[activeTable]
      ? `ATTACH '${result.target}' AS attached_db (READ_ONLY);\nSELECT * FROM attached_db.${result.tables[activeTable]!.schema === 'main' ? result.tables[activeTable]!.name : `${result.tables[activeTable]!.schema}.${result.tables[activeTable]!.name}`} LIMIT 100;`
      : result.suggested_sql
    : '';
  const title = target.split('/').pop() ?? target;

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-zinc-800 px-4 py-2">
          <span className="truncate font-mono text-sm text-zinc-100" title={target}>{target}</span>
          {result && (
            <span className="font-mono text-[11px] text-zinc-500">
              {result.kind}
              {result.row_count != null && ` · ${result.row_count.toLocaleString()} rows${result.row_count_source === 'parquet_metadata' ? ' (footer)' : ''}`}
              {result.size_bytes != null && ` · ${formatBytes(result.size_bytes)}`}
              {` · ${columns.length} columns`}
            </span>
          )}
          {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-500" />}
          {result?.tables && result.tables.length > 0 && (
            <div className="ml-auto flex gap-1 overflow-x-auto">
              {result.tables.map((t, i) => (
                <button key={`${t.schema}.${t.name}`} onClick={() => setActiveTable(i)} className={cn('flex shrink-0 items-center gap-1 rounded-md px-2 py-0.5 font-mono text-[11px]', i === activeTable ? 'bg-zinc-800 text-zinc-50' : 'text-zinc-400 hover:text-zinc-200')}>
                  <Table2 className="h-3 w-3" /> {t.name}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {error && <div className="m-4 rounded-md border border-red-900 bg-red-950/40 p-3 font-mono text-xs text-red-200">{error}</div>}
          {result && (
            <table className="w-full font-mono text-xs">
              <thead className="sticky top-0 bg-zinc-950 text-left text-[10px] text-zinc-500">
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
                    <td className="px-2 py-1.5"><TypePill type={c.type} /></td>
                    <td className="px-4 py-1.5 text-right text-zinc-400">{c.nullable ? 'yes' : 'no'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
      {result && (
        <aside className="flex w-80 shrink-0 flex-col gap-2 border-l border-zinc-800 p-3">
          <div className="text-[10px] font-semibold text-zinc-500">{remoteConnectionId ? 'Query on the SQL warehouse' : 'Query this file'}</div>
          <pre className="min-h-0 flex-1 overflow-auto rounded-md border border-zinc-800 bg-zinc-900 p-2 font-mono text-[11px] text-zinc-300">{suggested}</pre>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" size="sm" onClick={() => onQuery(suggested, title)}><Play className="h-3.5 w-3.5" /> {remoteConnectionId ? 'Run on warehouse' : 'Query this file'}</Button>
            {onProfile && result.kind !== 'database' && !remoteConnectionId && <Button size="sm" onClick={() => onProfile(result.target)}><ScanSearch className="h-3.5 w-3.5" /> Profile</Button>}
            {onAskCopilot && result.kind !== 'database' && !remoteConnectionId && <Button size="sm" onClick={() => onAskCopilot(result.target)}><Bot className="h-3.5 w-3.5" /> Ask Copilot</Button>}
          </div>
        </aside>
      )}
    </div>
  );
}
