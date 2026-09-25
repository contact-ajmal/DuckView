/**
 * Data → Compare: what changed between two datasets. Either side is a table or file, a SELECT, or a table in one
 * of the workspace's backups. With key columns, rows are matched: added, removed, changed (and which columns
 * changed, with the value before and after); without keys, whole rows found on one side only.
 * Deep link: #/compare?left=…&right=…&key=a,b (or ?backup=<id> to start from a backup).
 */
import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, GitCompareArrows, SquareTerminal } from 'lucide-react';
import { api, timeAgo } from '../../api/client';
import { PageHeader } from '../../components/layout';
import { DataTable, ResultPreview, formatValue } from '../../components/data';
import { Button, Empty, Field, InlineError, Input, Select, Skeleton, Tabs, Textarea, cn } from '../../components/ui';
import { useWorkspace } from '../../store/workspace';

type Kind = 'dataset' | 'sql' | 'backup';
interface Side { kind: Kind; target: string; sql: string; backup: string; table: string }
interface Backup { id: string; kind: string; created_at: string; note: string | null; exists: boolean }
interface Diff {
  left: { target: string; rows: number };
  right: { target: string; rows: number };
  schema: { added: { name: string; type: string }[]; removed: { name: string; type: string }[]; retyped: { name: string; from: string; to: string }[]; compared: string[] };
  key: string[];
  added: number | null;
  removed: number | null;
  changed: number | null;
  unchanged: number | null;
  columns: { name: string; changed: number }[];
  only_left: number | null;
  only_right: number | null;
  samples: { added: Record<string, unknown>[]; removed: Record<string, unknown>[]; changed: { key: Record<string, unknown>; changes: { column: string; before: unknown; after: unknown }[] }[] };
  duplicate_keys: { left: number; right: number };
  sql: { summary: string };
}

const params = () => new URLSearchParams(location.hash.split('?')[1] ?? '');
const sideFrom = (v: string | null): Side => {
  const bk = v ? /^backup:([^:]+):(.*)$/.exec(v) : null;
  if (bk) return { kind: 'backup', target: '', sql: '', backup: bk[1]!, table: bk[2]! };
  if (v && /^\s*(select|with|from)\b/i.test(v)) return { kind: 'sql', target: '', sql: v, backup: '', table: '' };
  return { kind: 'dataset', target: v ?? '', sql: '', backup: '', table: '' };
};
const valueOf = (s: Side) => (s.kind === 'sql' ? s.sql.trim() : s.kind === 'backup' ? (s.backup && s.table ? `backup:${s.backup}:${s.table}` : '') : s.target.trim());
const n = (x: number | null | undefined) => (x == null ? '—' : x.toLocaleString());

function SidePicker({ label, side, onChange, datasets, backups, workspaceId, testid }: { label: string; side: Side; onChange: (s: Side) => void; datasets: string[]; backups: Backup[] | null; workspaceId: string; testid: string }) {
  const [tables, setTables] = useState<string[] | null>(null);
  useEffect(() => {
    if (side.kind !== 'backup' || !side.backup) return setTables(null);
    let live = true;
    void api.get<{ tables: string[] }>(`/api/workspaces/${workspaceId}/backups/${side.backup}/tables`).then((r) => live && setTables(r.tables), () => live && setTables([]));
    return () => {
      live = false;
    };
  }, [side.kind, side.backup, workspaceId]);
  return (
    <section className="min-w-0 flex-1 space-y-2" data-testid={testid}>
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-body font-semibold text-zinc-100">{label}</h2>
        <Tabs<Kind> size="sm" className="border-b-0" value={side.kind} onChange={(kind) => onChange({ ...side, kind })} tabs={[{ id: 'dataset', label: 'Table or file' }, { id: 'sql', label: 'SQL' }, { id: 'backup', label: 'Backup', hidden: !backups }]} />
      </div>
      {side.kind === 'dataset' && (
        <>
          <Input list={`${testid}-datasets`} value={side.target} onChange={(e) => onChange({ ...side, target: e.target.value })} placeholder="orders, exports/sales.parquet…" aria-label={`${label}: table or file`} className="font-mono" data-testid={`${testid}-target`} />
          <datalist id={`${testid}-datasets`}>{datasets.map((d) => <option key={d} value={d} />)}</datalist>
        </>
      )}
      {side.kind === 'sql' && <Textarea mono rows={3} value={side.sql} onChange={(e) => onChange({ ...side, sql: e.target.value })} placeholder="SELECT * FROM orders WHERE …" aria-label={`${label}: SQL`} />}
      {side.kind === 'backup' && (
        <div className="grid gap-2 sm:grid-cols-2">
          <Select value={side.backup} onChange={(e) => onChange({ ...side, backup: e.target.value, table: '' })} aria-label={`${label}: backup`} data-testid={`${testid}-backup`}>
            <option value="">Choose a backup…</option>
            {(backups ?? []).filter((b) => b.exists).map((b) => <option key={b.id} value={b.id}>{new Date(b.created_at).toLocaleString()} · {b.kind.replace('_', ' ')}{b.note ? ` · ${b.note}` : ''}</option>)}
          </Select>
          <Select value={side.table} onChange={(e) => onChange({ ...side, table: e.target.value })} disabled={!tables} aria-label={`${label}: table in the backup`} data-testid={`${testid}-table`}>
            <option value="">{tables ? 'Choose a table…' : 'Choose a backup first'}</option>
            {(tables ?? []).map((t) => <option key={t} value={t}>{t}</option>)}
          </Select>
        </div>
      )}
    </section>
  );
}

export function ComparePage() {
  const ws = useWorkspace();
  const wsId = ws.activeId;
  const initial = useMemo(params, []);
  const [left, setLeft] = useState<Side>(() => (initial.get('backup') ? { kind: 'backup', target: '', sql: '', backup: initial.get('backup')!, table: '' } : sideFrom(initial.get('left'))));
  const [right, setRight] = useState<Side>(() => sideFrom(initial.get('right')));
  const [key, setKey] = useState(initial.get('key') ?? '');
  const [backups, setBackups] = useState<Backup[] | null>(null);
  const [result, setResult] = useState<Diff | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [tab, setTab] = useState<'changed' | 'added' | 'removed'>('changed');

  useEffect(() => {
    if (!wsId) return;
    const active = ws.workspaces.find((w) => w.id === wsId);
    if (active?.role === 'OWNER') void api.get<{ backups: Backup[] }>(`/api/workspaces/${wsId}/backups`).then((r) => setBackups(r.backups), () => setBackups(null));
    else setBackups(null);
  }, [wsId, ws.workspaces]);

  const datasets = useMemo(() => [...(ws.catalog?.objects ?? []).map((o) => (o.schema === 'main' ? o.name : `${o.schema}.${o.name}`)), ...(ws.catalog?.files ?? []).map((f) => f.path)], [ws.catalog]);
  const l = valueOf(left);
  const r = valueOf(right);
  const keys = key.split(',').map((k) => k.trim()).filter(Boolean);

  const compare = async () => {
    if (!wsId) return;
    setBusy(true);
    setError(null);
    try {
      const d = await api.post<Diff>(`/api/workspaces/${wsId}/diff`, { left: l, right: r, key: keys, sample: 50 });
      setResult(d);
      setTab(d.key.length ? 'changed' : 'added');
      history.replaceState(null, '', `#/compare?${new URLSearchParams({ left: l, right: r, ...(keys.length ? { key: keys.join(',') } : {}) })}`);
    } catch (e) {
      setError(e);
      setResult(null);
    } finally {
      setBusy(false);
    }
  };
  if (!wsId) return <Empty title="No workspace" hint="Choose a workspace to compare its data." />;

  const d = result;
  const schemaChanges = d ? [...d.schema.added.map((c) => ({ what: 'Added', column: c.name, detail: c.type })), ...d.schema.removed.map((c) => ({ what: 'Removed', column: c.name, detail: c.type })), ...d.schema.retyped.map((c) => ({ what: 'Retyped', column: c.name, detail: `${c.from} → ${c.to}` }))] : [];
  const maxCol = Math.max(1, ...(d?.columns ?? []).map((c) => c.changed));
  return (
    <div className="h-full min-h-0 overflow-auto">
      <div className="mx-auto max-w-6xl space-y-5 px-6 py-5 pb-16" data-testid="compare-page">
        <PageHeader title="Compare" description="What changed between two tables, files, queries or a backup and now." />
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
          <SidePicker label="Before" side={left} onChange={setLeft} datasets={datasets} backups={backups} workspaceId={wsId} testid="compare-left" />
          <ArrowRight className="mt-9 hidden h-4 w-4 shrink-0 text-zinc-500 lg:block" aria-hidden />
          <SidePicker label="After" side={right} onChange={setRight} datasets={datasets} backups={backups} workspaceId={wsId} testid="compare-right" />
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Key columns" hint="Columns that identify a row, separated by commas. Leave empty to compare whole rows." htmlFor="compare-key" className="min-w-64 flex-1">
            <Input id="compare-key" value={key} onChange={(e) => setKey(e.target.value)} placeholder="id" className="font-mono" data-testid="compare-key" />
          </Field>
          <Button variant="primary" onClick={() => void compare()} loading={busy} disabled={!l || !r} data-testid="compare-run"><GitCompareArrows className="h-3.5 w-3.5" /> Compare</Button>
        </div>
        {error != null && <InlineError error={error} onRetry={() => void compare()} />}
        {busy && !d && <Skeleton lines={6} />}
        {d && (
          <div className="space-y-6" data-testid="compare-result">
            <dl className="flex flex-wrap gap-x-8 gap-y-3 border-y border-zinc-800 py-3" data-testid="compare-summary">
              {([
                ['Rows before', n(d.left.rows), ''],
                ['Rows after', n(d.right.rows), ''],
                [d.key.length ? 'Added' : 'Only after', n(d.added), 'text-emerald-300'],
                [d.key.length ? 'Removed' : 'Only before', n(d.removed), 'text-red-300'],
                ...(d.key.length ? [['Changed', n(d.changed), 'text-amber-300'], ['Unchanged', n(d.unchanged), '']] : []),
              ] as [string, string, string][]).map(([k, v, tone]) => (
                <div key={k}>
                  <dt className="text-xs text-zinc-500">{k}</dt>
                  <dd className={cn('text-title font-semibold tabular-nums text-zinc-100', tone)}>{v}</dd>
                </div>
              ))}
            </dl>
            {(d.duplicate_keys.left > 0 || d.duplicate_keys.right > 0) && <p className="text-xs text-amber-300">The key repeats ({d.duplicate_keys.left.toLocaleString()} keys before, {d.duplicate_keys.right.toLocaleString()} after), so some rows match more than one row. Add a column to the key.</p>}
            <div className="grid gap-6 lg:grid-cols-2">
              <section>
                <h3 className="mb-2 text-body font-semibold text-zinc-100">Columns</h3>
                {schemaChanges.length === 0 ? <p className="text-xs text-zinc-500">The same {d.schema.compared.length} columns on both sides.</p> : (
                  <DataTable label="Schema changes" density="compact" rows={schemaChanges} rowKey={(x) => `${x.what}:${x.column}`} columns={[{ key: 'what', header: 'Change', cell: (x) => <span className={x.what === 'Added' ? 'text-emerald-300' : x.what === 'Removed' ? 'text-red-300' : 'text-amber-300'}>{x.what}</span> }, { key: 'col', header: 'Column', cell: (x) => <span className="font-mono">{x.column}</span> }, { key: 'd', header: 'Type', cell: (x) => <span className="font-mono">{x.detail}</span> }]} />
                )}
              </section>
              {d.key.length > 0 && (
                <section>
                  <h3 className="mb-2 text-body font-semibold text-zinc-100">Values that changed</h3>
                  {d.columns.length === 0 ? <p className="text-xs text-zinc-500">No values changed in matching rows.</p> : (
                    <ul className="space-y-1.5" data-testid="compare-columns">
                      {d.columns.map((c) => (
                        <li key={c.name} className="grid grid-cols-[minmax(0,10rem)_1fr_4rem] items-center gap-2 text-xs">
                          <span className="truncate font-mono text-zinc-300">{c.name}</span>
                          <span className="h-1.5 rounded-full bg-zinc-800"><span className="block h-full rounded-full bg-amber-500" style={{ width: `${(c.changed / maxCol) * 100}%` }} /></span>
                          <span className="text-right tabular-nums text-zinc-400">{c.changed.toLocaleString()}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              )}
            </div>
            <section>
              <Tabs<'changed' | 'added' | 'removed'> size="sm" value={tab} onChange={setTab} tabs={[{ id: 'changed', label: 'Changed rows', count: d.samples.changed.length, hidden: !d.key.length }, { id: 'added', label: d.key.length ? 'Added rows' : 'Only after', count: d.samples.added.length }, { id: 'removed', label: d.key.length ? 'Removed rows' : 'Only before', count: d.samples.removed.length }]} />
              <div className="pt-3">
                {tab === 'changed' && (
                  <DataTable
                    label="Changed rows"
                    testid="compare-changed"
                    rows={d.samples.changed.flatMap((c) => c.changes.map((x, i) => ({ id: `${JSON.stringify(c.key)}:${x.column}`, key: i === 0 ? Object.values(c.key).map((v) => formatValue(v)).join(', ') : '', ...x })))}
                    rowKey={(x) => x.id}
                    empty="No changed rows."
                    columns={[
                      { key: 'k', header: d.key.join(', '), cell: (x) => <span className="font-mono">{x.key}</span> },
                      { key: 'c', header: 'Column', cell: (x) => <span className="font-mono">{x.column}</span> },
                      { key: 'b', header: 'Before', cell: (x) => <span className="font-mono text-red-300">{formatValue(x.before)}</span> },
                      { key: 'a', header: 'After', cell: (x) => <span className="font-mono text-emerald-300">{formatValue(x.after)}</span> },
                    ]}
                  />
                )}
                {tab !== 'changed' && (d.samples[tab].length ? <ResultPreview columns={Object.keys(d.samples[tab][0]!)} rows={d.samples[tab]} testid={`compare-${tab}`} label={tab === 'added' ? 'Added rows' : 'Removed rows'} /> : <p className="text-xs text-zinc-500">None.</p>)}
                <p className="mt-2 text-2xs text-zinc-500">Showing up to 50 examples.</p>
              </div>
            </section>
            <Button size="sm" variant="ghost" onClick={() => void ws.addTab({ title: 'Compare', sql: d.sql.summary }).then(() => { location.hash = '#/query'; })}><SquareTerminal className="h-3.5 w-3.5" /> Open the counts as SQL</Button>
          </div>
        )}
        {!d && !busy && !error && backups && backups.length > 0 && left.kind !== 'backup' && (
          <p className="text-xs text-zinc-500">Tip: compare a table with its copy in a backup, the latest from {timeAgo(backups[0]!.created_at)}, to see what changed since.</p>
        )}
      </div>
    </div>
  );
}
