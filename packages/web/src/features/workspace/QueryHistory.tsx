/**
 * Query history from the server: every statement run in the workspace, on any device, by the workbench,
 * notebooks, dashboards or agents. The SQL page's sidebar shows your latest runs; the drawer searches everything
 * (yours, everyone's or agents' for owners), keeps failures, sorts by duration and groups identical statements.
 */
import { useCallback, useEffect, useState } from 'react';
import { History, Play } from 'lucide-react';
import { api, timeAgo } from '../../api/client';
import { DataTable } from '../../components/data';
import { Button, Drawer, Input, Select, StatusDot, Switch } from '../../components/ui';

interface Run { id: string; sql: string; at: string; duration_ms: number | null; status: string; error: string | null; who: string; actor_type: string }
interface Group { sql: string; runs: number; errors: number; last_at: string; avg_ms: number; total_ms: number }
type Who = 'me' | 'everyone' | 'agents';

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
const ms = (n: number | null) => (n == null ? '—' : n < 1000 ? `${Math.round(n)} ms` : `${(n / 1000).toFixed(n < 10_000 ? 2 : 1)} s`);

/** The sidebar list: your latest runs, filtered as you type. */
export function HistoryList({ workspaceId, refreshKey, onOpen }: { workspaceId: string; refreshKey: number; onOpen: (sql: string) => void }) {
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [q, setQ] = useState('');
  useEffect(() => {
    const t = setTimeout(() => {
      void api.get<{ runs: Run[] }>(`/api/workspaces/${workspaceId}/history?limit=40${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ''}`).then((r) => setRuns(r.runs), () => setRuns([]));
    }, q ? 250 : 400); // after a run, the audit row lands a moment later
    return () => clearTimeout(t);
  }, [workspaceId, refreshKey, q]);
  return (
    <div data-testid="history-list">
      <div className="px-3 pb-1 pt-2">
        <Input uiSize="sm" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search your queries" aria-label="Search your query history" />
      </div>
      {runs && runs.length === 0 && <p className="px-4 py-3 text-2xs text-zinc-500">{q ? 'Nothing you ran matches.' : 'Queries you run appear here, on every device.'}</p>}
      {runs?.map((h) => (
        <button key={h.id} onClick={() => onOpen(h.sql)} className="block w-full border-b border-zinc-800/70 px-4 py-2 text-left last:border-0 hover:bg-zinc-800/50" title={h.sql} data-testid="history-item">
          <div className="truncate font-mono text-2xs text-zinc-200">{oneLine(h.sql)}</div>
          <div className="mt-0.5 font-mono text-2xs text-zinc-500">
            {timeAgo(h.at)} · {h.status === 'ok' ? ms(h.duration_ms) : <span className="text-red-300">{h.status === 'blocked' ? 'blocked' : h.status === 'timeout' ? 'timed out' : 'failed'}</span>}
          </div>
        </button>
      ))}
    </div>
  );
}

/** Everything, with filters. */
export function QueryHistoryDrawer({ open, onClose, workspaceId, isOwner, onOpen, onRun }: { open: boolean; onClose: () => void; workspaceId: string; isOwner: boolean; onOpen: (sql: string) => void; onRun: (sql: string) => void }) {
  const [who, setWho] = useState<Who>('me');
  const [status, setStatus] = useState<'all' | 'error'>('all');
  const [sort, setSort] = useState<'recent' | 'slowest'>('recent');
  const [grouped, setGrouped] = useState(false);
  const [q, setQ] = useState('');
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const qs = new URLSearchParams({ who, status, sort, limit: '300', ...(grouped ? { group: '1' } : {}), ...(q.trim() ? { q: q.trim() } : {}) });
      const r = await api.get<{ runs?: Run[]; groups?: Group[] }>(`/api/workspaces/${workspaceId}/history?${qs}`);
      setRuns(r.runs ?? null);
      setGroups(r.groups ?? null);
    } catch (e) {
      setError(e);
    }
  }, [workspaceId, who, status, sort, grouped, q]);
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => void load(), 200);
    return () => clearTimeout(t);
  }, [open, load]);

  const actions = (sql: string) => (
    <span className="inline-flex gap-1">
      <Button size="sm" variant="ghost" onClick={() => { onOpen(sql); onClose(); }}>Open</Button>
      <Button size="sm" variant="ghost" onClick={() => { onRun(sql); onClose(); }} title="Open in a new tab and run"><Play className="h-3 w-3" /> Run</Button>
    </span>
  );
  return (
    <Drawer open={open} onClose={onClose} title={<span className="flex items-center gap-2"><History className="h-4 w-4 text-zinc-500" /> Query history</span>} width="w-[min(960px,100vw)]">
      <div className="space-y-3 p-4" data-testid="history-drawer">
        <div className="flex flex-wrap items-center gap-2">
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the SQL" aria-label="Search the SQL" className="max-w-xs" data-testid="history-search" />
          {isOwner && (
            <Select uiSize="sm" value={who} onChange={(e) => setWho(e.target.value as Who)} aria-label="Whose queries" data-testid="history-who">
              <option value="me">Mine</option>
              <option value="everyone">Everyone's</option>
              <option value="agents">Agents'</option>
            </Select>
          )}
          <Select uiSize="sm" value={status} onChange={(e) => setStatus(e.target.value as 'all' | 'error')} aria-label="Status" data-testid="history-status">
            <option value="all">All runs</option>
            <option value="error">Failures only</option>
          </Select>
          <Select uiSize="sm" value={sort} onChange={(e) => setSort(e.target.value as 'recent' | 'slowest')} aria-label="Sort" data-testid="history-sort">
            <option value="recent">Newest first</option>
            <option value="slowest">Slowest first</option>
          </Select>
          <Switch checked={grouped} onChange={setGrouped} label="Group identical queries" className="ml-1" />
        </div>
        {grouped ? (
          <DataTable
            label="Grouped query history"
            testid="history-groups"
            rows={groups}
            error={error}
            onRetry={() => void load()}
            rowKey={(g) => g.sql}
            empty="No queries match."
            columns={[
              { key: 'sql', header: 'Query', truncate: true, cell: (g) => <code className="font-mono text-xs" title={g.sql}>{oneLine(g.sql)}</code> },
              { key: 'runs', header: 'Runs', align: 'right', numeric: true, cell: (g) => g.runs.toLocaleString() },
              { key: 'errors', header: 'Failed', align: 'right', numeric: true, cell: (g) => (g.errors ? <span className="text-red-300">{g.errors}</span> : '0') },
              { key: 'avg', header: 'Average', align: 'right', numeric: true, cell: (g) => ms(g.avg_ms) },
              { key: 'total', header: 'Total', align: 'right', numeric: true, cell: (g) => ms(g.total_ms) },
              { key: 'last', header: 'Last run', cell: (g) => timeAgo(g.last_at) },
              { key: 'x', header: '', align: 'right', cell: (g) => actions(g.sql) },
            ]}
          />
        ) : (
          <DataTable
            label="Query history"
            testid="history-runs"
            rows={runs}
            error={error}
            onRetry={() => void load()}
            rowKey={(r) => r.id}
            empty="No queries match."
            expanded={(r) => (r.error ? <p className="font-mono text-xs text-red-300">{r.error.split('\n')[0]}</p> : null)}
            columns={[
              { key: 'sql', header: 'Query', truncate: true, cell: (r) => <code className="font-mono text-xs" title={r.sql}>{oneLine(r.sql)}</code> },
              { key: 'who', header: 'Who', truncate: true, cell: (r) => (r.actor_type === 'AGENT' ? `${r.who} (agent)` : r.who) },
              { key: 'when', header: 'When', cell: (r) => <span title={new Date(r.at).toLocaleString()}>{timeAgo(r.at)}</span> },
              { key: 'time', header: 'Time', align: 'right', numeric: true, cell: (r) => ms(r.duration_ms) },
              { key: 'status', header: 'Result', cell: (r) => <StatusDot tone={r.status === 'ok' ? 'ok' : r.status === 'blocked' ? 'warn' : 'error'}>{r.status === 'ok' ? 'Done' : r.status === 'blocked' ? 'Blocked' : r.status === 'timeout' ? 'Timed out' : 'Failed'}</StatusDot> },
              { key: 'x', header: '', align: 'right', cell: (r) => actions(r.sql) },
            ]}
          />
        )}
      </div>
    </Drawer>
  );
}
