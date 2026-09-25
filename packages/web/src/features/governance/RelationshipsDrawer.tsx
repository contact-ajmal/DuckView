/**
 * How the workspace's tables join: declared foreign keys and relationships inferred from column names, confirmed on
 * the data. A diagram (the many side on the left, the tables it points at to the right) and the list, where each
 * join opens in the SQL workbench.
 */
import { useEffect, useMemo, useState } from 'react';
import { Network, SquareTerminal } from 'lucide-react';
import { api } from '../../api/client';
import { DataTable } from '../../components/data';
import { Badge, Drawer, IconButton, StatusDot } from '../../components/ui';
import { useWorkspace } from '../../store/workspace';

interface Rel { from_table: string; from_column: string; to_table: string; to_column: string; source: 'declared' | 'inferred'; cardinality: 'many-to-one' | 'one-to-one' | 'many-to-many'; coverage: number; orphans: number; confidence: 'high' | 'medium'; sql: string }
interface JoinMap { tables: { name: string; type: string; rows: number | null; columns: string[] }[]; relationships: Rel[]; checked: number }
const relId = (r: Rel) => `${r.from_table}.${r.from_column}>${r.to_table}.${r.to_column}`;

const W = 184;
const HEAD = 26;
const ROW = 20;
const GAP_X = 96;
const GAP_Y = 20;

/** Tables that point at nothing sit on the right; each table sits one step left of the furthest table it points at. */
function layout(map: JoinMap) {
  const out = new Map<string, string[]>();
  for (const r of map.relationships) out.set(r.from_table, [...(out.get(r.from_table) ?? []), r.to_table]);
  const level = new Map<string, number>();
  const depth = (t: string, seen: Set<string>): number => {
    if (level.has(t)) return level.get(t)!;
    if (seen.has(t)) return 0;
    seen.add(t);
    const d = Math.max(-1, ...(out.get(t) ?? []).filter((x) => x !== t).map((x) => depth(x, seen))) + 1;
    level.set(t, d);
    return d;
  };
  for (const t of map.tables) depth(t.name, new Set());
  const maxLevel = Math.max(0, ...level.values());
  const cols: string[][] = Array.from({ length: maxLevel + 1 }, () => []);
  for (const t of map.tables) cols[maxLevel - (level.get(t.name) ?? 0)]!.push(t.name);
  const pos = new Map<string, { x: number; y: number; h: number }>();
  let height = 0;
  cols.forEach((names, ci) => {
    let y = 12;
    for (const n of names) {
      const t = map.tables.find((x) => x.name === n)!;
      const h = HEAD + t.columns.length * ROW + 6;
      pos.set(n, { x: 12 + ci * (W + GAP_X), y, h });
      y += h + GAP_Y;
    }
    height = Math.max(height, y);
  });
  return { pos, width: 24 + cols.length * (W + GAP_X) - GAP_X, height: height + 4 };
}

export function RelationshipsDrawer({ open, onClose, workspaceId }: { open: boolean; onClose: () => void; workspaceId: string }) {
  const ws = useWorkspace();
  const [map, setMap] = useState<JoinMap | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [hover, setHover] = useState<string | null>(null);

  const load = async () => {
    setMap(null);
    setError(null);
    try {
      setMap(await api.get<JoinMap>(`/api/workspaces/${workspaceId}/joins`));
    } catch (e) {
      setError(e);
    }
  };
  useEffect(() => {
    if (open) void load();
  }, [open, workspaceId]); // eslint-disable-line react-hooks/exhaustive-deps

  const drawn = useMemo(() => (map && map.tables.length ? layout(map) : null), [map]);
  const colY = (table: string, column: string) => {
    const p = drawn!.pos.get(table)!;
    const t = map!.tables.find((x) => x.name === table)!;
    return p.y + HEAD + Math.max(0, t.columns.indexOf(column)) * ROW + ROW / 2;
  };
  const openSql = (r: Rel) => {
    void ws.addTab({ title: `${r.from_table} ⋈ ${r.to_table}`, sql: r.sql });
    location.hash = '#/query';
    onClose();
  };

  return (
    <Drawer open={open} onClose={onClose} title={<span className="flex items-center gap-2"><Network className="h-4 w-4 text-zinc-500" /> Relationships</span>} width="w-[min(1040px,100vw)]">
      <div className="space-y-4 p-4" data-testid="joins-drawer">
        <p className="text-xs text-zinc-500">Declared foreign keys, and joins found from column names and confirmed on the data. Arrows point at the table each row looks up.</p>
        {drawn && map && (
          <div className="overflow-auto rounded-md border border-zinc-800 bg-zinc-900/40" data-testid="joins-diagram">
            <svg width={drawn.width} height={drawn.height} role="img" aria-label={`Diagram of ${map.tables.length} tables and ${map.relationships.length} relationships`}>
              <defs>
                <marker id="dv-join-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M0,0 L8,4 L0,8 z" className="fill-zinc-500" />
                </marker>
              </defs>
              {map.relationships.map((r) => {
                const a = drawn.pos.get(r.from_table)!;
                const b = drawn.pos.get(r.to_table)!;
                const y1 = colY(r.from_table, r.from_column);
                const y2 = colY(r.to_table, r.to_column);
                // Left to right normally; tables in one column (a cycle) loop out on the right.
                const d = a.x === b.x
                  ? `M${a.x + W},${y1} C${a.x + W + 48},${y1} ${b.x + W + 48},${y2} ${b.x + W},${y2}`
                  : a.x < b.x
                    ? `M${a.x + W},${y1} C${(a.x + W + b.x) / 2},${y1} ${(a.x + W + b.x) / 2},${y2} ${b.x},${y2}`
                    : `M${a.x},${y1} C${(a.x + b.x + W) / 2},${y1} ${(a.x + b.x + W) / 2},${y2} ${b.x + W},${y2}`;
                const on = hover === relId(r);
                return <path key={relId(r)} d={d} fill="none" strokeWidth={on ? 2 : 1.25} strokeDasharray={r.confidence === 'high' ? undefined : '4 3'} markerEnd="url(#dv-join-arrow)" className={on ? 'stroke-accent-500' : 'stroke-zinc-500'} data-rel={relId(r)} />;
              })}
              {map.tables.map((t) => {
                const p = drawn.pos.get(t.name)!;
                return (
                  <g key={t.name} data-table={t.name}>
                    <rect x={p.x} y={p.y} width={W} height={p.h} rx={4} className="fill-zinc-950 stroke-zinc-700" />
                    <text x={p.x + 8} y={p.y + 17} className="fill-zinc-100 font-mono text-xs">{t.name.length > 22 ? `${t.name.slice(0, 21)}…` : t.name}<title>{t.name}{t.rows != null ? ` · ${t.rows.toLocaleString()} rows` : ''}</title></text>
                    <line x1={p.x} x2={p.x + W} y1={p.y + HEAD - 4} y2={p.y + HEAD - 4} className="stroke-zinc-800" />
                    {t.columns.map((c, i) => <text key={c} x={p.x + 8} y={p.y + HEAD + i * ROW + 14} className="fill-zinc-400 font-mono text-2xs">{c}</text>)}
                  </g>
                );
              })}
            </svg>
          </div>
        )}
        {/* Hovering a row highlights its line in the diagram. */}
        <div onMouseOver={(e) => setHover((e.target as HTMLElement).closest('tr')?.getAttribute('data-rel') ?? null)} onMouseLeave={() => setHover(null)}>
          <DataTable
            label="Relationships"
            testid="joins-list"
            rows={map?.relationships ?? (error ? [] : null)}
            error={error}
            onRetry={() => void load()}
            rowKey={relId}
            rowProps={(r) => ({ 'data-rel': relId(r) })}
            empty="No relationships found. Tables join here when a column such as customer_id matches the id of a customers table, or a foreign key is declared."
            columns={[
              { key: 'from', header: 'From', sortValue: (r) => `${r.from_table}.${r.from_column}`, cell: (r) => <span className="font-mono">{r.from_table}.<span className="text-zinc-100">{r.from_column}</span></span> },
              { key: 'to', header: 'Looks up', sortValue: (r) => `${r.to_table}.${r.to_column}`, cell: (r) => <span className="font-mono">{r.to_table}.<span className="text-zinc-100">{r.to_column}</span></span> },
              { key: 'card', header: 'Cardinality', cell: (r) => <span className="whitespace-nowrap">{r.cardinality}</span> },
              { key: 'match', header: 'Values found', align: 'right', numeric: true, sortValue: (r) => r.coverage, cell: (r) => (r.source === 'declared' ? <span className="text-zinc-500">declared</span> : `${Math.round(r.coverage * 100)}%`) },
              { key: 'orph', header: 'Unmatched', align: 'right', numeric: true, sortValue: (r) => r.orphans, cell: (r) => (r.orphans ? <span title="Distinct values with no match: their rows drop out of an inner join">{r.orphans.toLocaleString()}</span> : '—') },
              { key: 'conf', header: 'Confidence', cell: (r) => (r.source === 'declared' ? <Badge tone="blue" className="whitespace-nowrap">foreign key</Badge> : <StatusDot tone={r.confidence === 'high' ? 'ok' : 'warn'}>{r.confidence}</StatusDot>) },
              { key: 'x', header: '', align: 'right', cell: (r) => <IconButton label={`Open ${r.from_table} joined to ${r.to_table} in SQL`} onClick={() => openSql(r)} data-testid="join-open"><SquareTerminal className="h-3.5 w-3.5" /></IconButton> },
            ]}
          />
        </div>
        {map && <p className="text-2xs text-zinc-500">{map.checked.toLocaleString()} candidate join{map.checked === 1 ? '' : 's'} checked on the data.</p>}
      </div>
    </Drawer>
  );
}
