import { useState } from 'react';
import { Button, Input, Empty, Spinner, Badge } from '../../components/ui';
import { formatBytes } from '../../api/client';
import { ScanSearch } from 'lucide-react';

export interface ProfileResult { summary: Record<string, unknown>[]; rowCount: number | null; columnCount: number; sizeBytes: number | null; sql: string }

export function ProfilePanel({ profile, loading, onProfile, defaultTarget, provenance }: { profile: ProfileResult | null; loading: boolean; onProfile: (target: string, refresh?: boolean) => void; defaultTarget: string; provenance?: React.ReactNode }) {
  const [target, setTarget] = useState(defaultTarget);
  const rows = profile?.summary ?? [];
  return (
    <div className="flex h-full flex-col">
      <form
        className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2"
        onSubmit={(e) => {
          e.preventDefault();
          onProfile(target);
        }}
      >
        <Input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="table name, 'file.parquet', or SELECT …" className="font-mono text-xs" />
        <Button size="sm" variant="primary" type="submit" loading={loading}>
          Profile
        </Button>
      </form>
      {profile && (
        <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800 px-3 py-2 text-xs text-zinc-400">
          <Badge tone="violet">{profile.rowCount?.toLocaleString() ?? '?'} rows</Badge>
          <Badge>{profile.columnCount} columns</Badge>
          {profile.sizeBytes != null && <Badge>{formatBytes(profile.sizeBytes)} on disk</Badge>}
          {provenance && <span className="ml-auto">{provenance}</span>}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        {loading && !profile ? (
          <div className="flex h-full items-center justify-center">
            <Spinner />
          </div>
        ) : !profile ? (
          <Empty icon={<ScanSearch className="h-8 w-8" />} title="Profile a dataset" hint="Runs DuckDB SUMMARIZE: types, min/max, approx distinct, null %, quartiles — for any table, file or query." />
        ) : (
          <table className="w-full border-collapse font-mono text-[11px]">
            <thead className="sticky top-0 bg-zinc-900 text-zinc-400">
              <tr>
                {['column', 'type', 'nulls', 'distinct', 'min', 'q25', 'q50', 'q75', 'max', 'avg', 'std'].map((h) => (
                  <th key={h} className="border-b border-zinc-800 px-2 py-1.5 text-left font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const nullPct = Number(r.null_percentage ?? 0);
                return (
                  <tr key={i} className="border-b border-zinc-900 hover:bg-zinc-800/50">
                    <td className="px-2 py-1 font-semibold text-zinc-100">{String(r.column_name)}</td>
                    <td className="px-2 py-1 text-accent-300">{String(r.column_type)}</td>
                    <td className="px-2 py-1">
                      <div className="flex items-center gap-1.5">
                        <div className="h-1.5 w-12 overflow-hidden rounded bg-zinc-800">
                          <div className="h-full rounded" style={{ width: `${Math.min(100, nullPct)}%`, background: nullPct > 20 ? 'var(--status-serious)' : nullPct > 0 ? 'var(--status-warning)' : 'var(--status-good)' }} />
                        </div>
                        <span className="text-zinc-400">{nullPct.toFixed(1)}%</span>
                      </div>
                    </td>
                    {['approx_unique', 'min', 'q25', 'q50', 'q75', 'max', 'avg', 'std'].map((k) => (
                      <td key={k} className="max-w-[160px] truncate px-2 py-1 text-zinc-300" title={r[k] == null ? '' : String(r[k])}>
                        {r[k] == null ? <span className="text-zinc-600">—</span> : String(r[k])}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
