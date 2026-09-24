import { useState } from 'react';
import { Button, Input, Empty, Spinner, Badge } from '../../components/ui';
import { formatBytes } from '../../api/client';
import { ScanSearch } from 'lucide-react';
import { DataTable } from '../../components/data';
import { TypePill } from '../../components/layout';

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
          <Badge tone="accent">{profile.rowCount?.toLocaleString() ?? '?'} rows</Badge>
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
          <DataTable
            label="Column profile"
            density="compact"
            className="px-2"
            rows={rows}
            rowKey={(r) => String(r.column_name)}
            columns={[
              { key: 'column', header: 'Column', sortValue: (r) => String(r.column_name), cell: (r) => <span className="font-mono font-medium text-zinc-100">{String(r.column_name)}</span> },
              { key: 'type', header: 'Type', sortValue: (r) => String(r.column_type), cell: (r) => <TypePill type={String(r.column_type)} /> },
              { key: 'nulls', header: 'Nulls', sortValue: (r) => Number(r.null_percentage ?? 0), cell: (r) => {
                const nullPct = Number(r.null_percentage ?? 0);
                return (
                  <div className="flex items-center gap-1.5">
                    <div className="h-1.5 w-12 overflow-hidden rounded bg-zinc-800">
                      <div className="h-full rounded" style={{ width: `${Math.min(100, nullPct)}%`, background: nullPct > 20 ? 'var(--status-serious)' : nullPct > 0 ? 'var(--status-warning)' : 'var(--status-good)' }} />
                    </div>
                    <span className="font-mono tabular-nums text-zinc-400">{nullPct.toFixed(1)}%</span>
                  </div>
                );
              } },
              ...(['approx_unique', 'min', 'q25', 'q50', 'q75', 'max', 'avg', 'std'] as const).map((k) => ({
                key: k,
                header: k === 'approx_unique' ? 'Distinct' : k === 'avg' ? 'Mean' : k === 'std' ? 'Std dev' : k.toUpperCase().startsWith('Q') ? k.toUpperCase() : k[0]!.toUpperCase() + k.slice(1),
                truncate: true,
                sortValue: (r: Record<string, unknown>) => (r[k] == null ? null : Number.isFinite(Number(r[k])) ? Number(r[k]) : String(r[k])),
                cell: (r: Record<string, unknown>) => (r[k] == null ? <span className="text-zinc-600">—</span> : <span className="font-mono text-zinc-300" title={String(r[k])}>{String(r[k])}</span>),
              })),
            ]}
          />
        )}
      </div>
    </div>
  );
}
