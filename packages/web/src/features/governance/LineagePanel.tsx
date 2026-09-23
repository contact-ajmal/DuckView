import { useEffect, useMemo, useState } from 'react';
import { api, type LineageEdge, type LineageKind, type LineageNode } from '../../api/client';
import { Badge, Select, cn } from '../../components/ui';

const KIND: Record<LineageKind, { label: string; color: string; col: number }> = {
  source: { label: 'source', color: '#0ea5e9', col: 0 },
  file: { label: 'file', color: '#14b8a6', col: 0 },
  sync: { label: 'sync', color: '#8b5cf6', col: 1 },
  dbt: { label: 'dbt', color: '#f97316', col: 1 },
  table: { label: 'table', color: '#22c55e', col: 2 },
  view: { label: 'view', color: '#84cc16', col: 3 },
  saved_query: { label: 'query', color: '#f59e0b', col: 4 },
  dashboard: { label: 'dashboard', color: '#ec4899', col: 5 },
  alert: { label: 'alert', color: '#ef4444', col: 5 },
  app: { label: 'app', color: '#6366f1', col: 5 },
  snapshot: { label: 'snapshot', color: '#a855f7', col: 6 },
};
const W = 170;
const H = 34;
const GAP_X = 70;
const GAP_Y = 12;

/** Governance → Lineage: where every table comes from and what reads it. Pick a node to trace it both ways. */
export function LineagePanel({ workspaceId }: { workspaceId: string }) {
  const [graph, setGraph] = useState<{ nodes: LineageNode[]; edges: LineageEdge[] } | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setGraph(null);
    api.get<{ nodes: LineageNode[]; edges: LineageEdge[] }>(`/api/workspaces/${workspaceId}/lineage`).then(setGraph).catch((e) => setError((e as Error).message));
  }, [workspaceId]);

  // Everything upstream and downstream of the focused node.
  const related = useMemo(() => {
    if (!graph || !focus) return null;
    const set = new Set([focus]);
    const walk = (id: string, dir: 'up' | 'down') => {
      for (const e of graph.edges) {
        const next = dir === 'up' ? (e.to === id ? e.from : null) : e.from === id ? e.to : null;
        if (next && !set.has(next)) { set.add(next); walk(next, dir); }
      }
    };
    walk(focus, 'up');
    walk(focus, 'down');
    return set;
  }, [graph, focus]);
  // Traced: only the connected subgraph is drawn.
  const shown = useMemo(() => (graph ? (related ? { nodes: graph.nodes.filter((n) => related.has(n.id)), edges: graph.edges.filter((e) => related.has(e.from) && related.has(e.to)) } : graph) : null), [graph, related]);

  // Columns: by kind, then pushed right so every edge points forward (views over views, queries over views…).
  const layout = useMemo(() => {
    if (!shown) return null;
    const col = new Map(shown.nodes.map((n) => [n.id, KIND[n.kind].col]));
    for (let i = 0; i < shown.nodes.length; i++) {
      let moved = false;
      for (const e of shown.edges) if ((col.get(e.to) ?? 0) <= (col.get(e.from) ?? 0)) { col.set(e.to, (col.get(e.from) ?? 0) + 1); moved = true; }
      if (!moved) break;
    }
    const byCol = new Map<number, LineageNode[]>();
    for (const n of shown.nodes) byCol.set(col.get(n.id)!, [...(byCol.get(col.get(n.id)!) ?? []), n]);
    const cols = [...byCol.keys()].sort((x, y) => x - y);
    const pos = new Map<string, { x: number; y: number }>();
    cols.forEach((c, i) => byCol.get(c)!.sort((x, y) => x.kind.localeCompare(y.kind) || x.label.localeCompare(y.label)).forEach((n, j) => pos.set(n.id, { x: 12 + i * (W + GAP_X), y: 12 + j * (H + GAP_Y) })));
    const height = Math.max(1, ...[...byCol.values()].map((l) => l.length)) * (H + GAP_Y) + 24;
    return { pos, width: cols.length * (W + GAP_X) + 24, height };
  }, [shown]);

  if (error) return <div className="rounded-md border border-red-900 bg-red-950/50 px-3 py-2 font-mono text-xs text-red-200">{error}</div>;
  if (!graph || !layout || !shown) return <p className="text-xs text-zinc-500">Tracing…</p>;
  const node = focus ? graph.nodes.find((n) => n.id === focus) : null;
  return (
    <div className="space-y-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-zinc-500">Built from the SQL of syncs, views, queries, dashboards and alerts (DuckDB's parser), and table names in app code.</p>
        <Select className="ml-auto h-7 text-[11px]" value={focus ?? ''} onChange={(e) => setFocus(e.target.value || null)}><option value="">{focus ? 'Show everything' : 'Trace a table…'}</option>{graph.nodes.filter((n) => n.kind === 'table' || n.kind === 'view').map((n) => <option key={n.id} value={n.id}>{n.label}</option>)}</Select>
      </div>
      <div className="flex flex-wrap gap-1.5">{(Object.keys(KIND) as LineageKind[]).filter((k) => graph.nodes.some((n) => n.kind === k)).map((k) => <span key={k} className="inline-flex items-center gap-1 text-[10.5px] text-zinc-400"><span className="h-2 w-2 rounded-sm" style={{ background: KIND[k].color }} />{KIND[k].label}</span>)}</div>
      {graph.nodes.length === 0 ? <p className="text-zinc-500">Nothing to trace yet.</p> : (
        <div className="overflow-auto rounded-lg border border-zinc-800 bg-zinc-950/40">
          <svg width={layout.width} height={layout.height} role="img" aria-label="Lineage graph">
            {shown.edges.map((e, i) => {
              const a = layout.pos.get(e.from);
              const b = layout.pos.get(e.to);
              if (!a || !b) return null;
              const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x, y2 = b.y + H / 2;
              return <path key={i} d={`M${x1},${y1} C${x1 + GAP_X / 2},${y1} ${x2 - GAP_X / 2},${y2} ${x2},${y2}`} fill="none" className="stroke-zinc-600" strokeWidth={related ? 1.6 : 1} strokeDasharray={e.kind === 'mentions' ? '3 3' : undefined} />;
            })}
            {shown.nodes.map((n) => {
              const p = layout.pos.get(n.id)!;
              return (
                <g key={n.id} data-node={n.id} transform={`translate(${p.x},${p.y})`} className="cursor-pointer" onClick={() => setFocus(focus === n.id ? null : n.id)}>
                  <rect width={W} height={H} rx={6} className={focus === n.id ? 'fill-zinc-800' : 'fill-zinc-900'} stroke={KIND[n.kind].color} strokeWidth={focus === n.id ? 2 : 1} />
                  <rect width={4} height={H} rx={2} fill={KIND[n.kind].color} />
                  <text x={10} y={14} fontSize={11} className="fill-zinc-100">{n.label.length > 24 ? `${n.label.slice(0, 23)}…` : n.label}</text>
                  <text x={10} y={27} fontSize={9} className="fill-zinc-500">{KIND[n.kind].label}{n.detail ? ` · ${n.detail.slice(0, 26)}` : ''}</text>
                  <title>{`${n.label}${n.description ? `\n${n.description}` : ''}`}</title>
                </g>
              );
            })}
          </svg>
        </div>
      )}
      {node && (
        <div className={cn('rounded-lg border border-zinc-800 p-3')}>
          <div className="flex items-center gap-2"><Badge>{KIND[node.kind].label}</Badge><span className="font-semibold text-zinc-100">{node.label}</span>{node.href && <a href={node.href} className="ml-auto text-accent-300 hover:underline">Open</a>}</div>
          {node.description && <p className="mt-1 text-zinc-400">{node.description}</p>}
          <p className="mt-1 text-zinc-500">{related!.size - 1} connected: {graph.edges.filter((e) => e.to === node.id).length} upstream edge(s), {graph.edges.filter((e) => e.from === node.id).length} downstream.</p>
        </div>
      )}
    </div>
  );
}
