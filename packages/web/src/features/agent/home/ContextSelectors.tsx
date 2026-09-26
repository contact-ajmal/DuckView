/**
 * Where the agent works, always in view: the workspace (the console's active workspace — one source) and the datasets
 * chosen for it. Only what the person can reach is listed: the server returns their workspaces and, per workspace,
 * the datasets their access shows. Datasets load when the picker opens, never on the first paint.
 */
import { useEffect, useMemo, useState } from 'react';
import { Check, ChevronDown, Database, FileText, Layers, Search, Sigma, X } from 'lucide-react';
import { Badge, Button, Input, Menu, Spinner, cn } from '../../../components/ui';
import { timeAgo } from '../../../api/client';
import { useWorkspace } from '../../../store/workspace';
import { missionApi, type AgentWorkspace, type DatasetOption } from '../api';

const ROLE: Record<AgentWorkspace['role'], string> = { OWNER: 'Owner', EDITOR: 'Editor', VIEWER: 'Viewer' };

export function WorkspaceSelector({ workspaces }: { workspaces: AgentWorkspace[] }) {
  const ws = useWorkspace();
  const current = workspaces.find((w) => w.id === ws.activeId) ?? null;
  return (
    <Menu
      align="left"
      width="w-80"
      trigger={(open, toggle) => (
        <button type="button" onClick={toggle} aria-expanded={open} aria-haspopup="menu" className="group flex min-w-0 max-w-[16rem] items-center gap-1.5 rounded px-1.5 py-1 text-left hover:bg-zinc-900 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-500" data-testid="agent-workspace">
          <span className="text-2xs text-zinc-500">Workspace</span>
          <span className="min-w-0 truncate text-xs font-medium text-zinc-100">{current?.name ?? 'Choose a workspace'}</span>
          {current?.environment && <Badge tone="zinc" className="shrink-0">{current.environment}</Badge>}
          <ChevronDown className="h-3 w-3 shrink-0 text-zinc-500 group-hover:text-zinc-300" />
        </button>
      )}
    >
      {(close) => (
        <div className="max-h-[360px] overflow-auto py-1" data-testid="agent-workspace-menu">
          {workspaces.length === 0 && <p className="px-3 py-2 text-xs text-zinc-500">You have no workspace yet.</p>}
          {workspaces.map((w) => (
            <button
              key={w.id}
              role="menuitem"
              type="button"
              onClick={() => {
                close();
                if (w.id !== ws.activeId) void ws.selectWorkspace(w.id);
              }}
              className={cn('flex w-full items-start gap-2 rounded px-3 py-2 text-left hover:bg-zinc-900 focus-visible:bg-zinc-900 focus-visible:outline-none', w.id === ws.activeId && 'bg-zinc-800/80')}
              data-testid="agent-workspace-option"
            >
              <Check className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', w.id === ws.activeId ? 'text-accent-400' : 'text-transparent')} />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-xs font-medium text-zinc-100">{w.name}</span>
                  {w.environment && <Badge tone="zinc">{w.environment}</Badge>}
                </span>
                {w.description && <span className="mt-0.5 block truncate text-2xs text-zinc-500">{w.description}</span>}
                <span className="mt-0.5 block text-2xs text-zinc-500">{ROLE[w.role]}{w.members > 1 ? ` · ${w.members} people` : ''}{w.last_agent_activity ? ` · agent ${timeAgo(w.last_agent_activity)}` : ''}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </Menu>
  );
}

const KIND_ICON = { table: Database, view: Layers, file: FileText, semantic_model: Sigma } as const;

export function DatasetSelector({ selected, onChange }: { selected: string[]; onChange: (d: string[]) => void }) {
  const wsId = useWorkspace((s) => s.activeId);
  const [data, setData] = useState<{ datasets: DatasetOption[]; recent: string[]; recommended: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  useEffect(() => {
    setData(null);
  }, [wsId]);
  useEffect(() => {
    if (!open || data || !wsId) return;
    missionApi.datasets(wsId).then(setData).catch((e) => setError((e as Error).message));
  }, [open, data, wsId]);
  const toggle = (name: string) => onChange(selected.includes(name) ? selected.filter((x) => x !== name) : [...selected, name]);
  const shown = useMemo(() => (data?.datasets ?? []).filter((d) => !q || d.name.toLowerCase().includes(q.toLowerCase()) || (d.description ?? '').toLowerCase().includes(q.toLowerCase())), [data, q]);
  const byName = new Map((data?.datasets ?? []).map((d) => [d.name, d]));
  const row = (d: DatasetOption) => {
    const Icon = KIND_ICON[d.kind];
    const on = selected.includes(d.name);
    return (
      <button
        key={`${d.kind}:${d.name}`}
        type="button"
        role="menuitemcheckbox"
        aria-checked={on}
        disabled={!d.selectable}
        onClick={() => d.selectable && toggle(d.name)}
        className={cn('flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-zinc-900 focus-visible:bg-zinc-900 focus-visible:outline-none disabled:cursor-default disabled:hover:bg-transparent', on && 'bg-zinc-800/80')}
        title={d.selectable ? d.description ?? d.name : `Semantic model on ${d.relation}: choose ${d.relation} to work on it`}
        data-testid="agent-dataset-option"
        data-name={d.name}
      >
        <span className={cn('flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border', on ? 'border-accent-500 bg-accent-500 text-[color:var(--accent-ink)]' : 'border-zinc-700')}>{on && <Check className="h-3 w-3" />}</span>
        <Icon className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-200">{d.name}</span>
        <span className="shrink-0 text-2xs tabular-nums text-zinc-500">{d.kind === 'semantic_model' ? 'semantic' : d.rows != null ? `${compact(d.rows)} rows` : d.kind}</span>
      </button>
    );
  };
  const label = selected.length === 0 ? 'Any data' : selected.length === 1 ? selected[0]! : `${selected[0]} +${selected.length - 1}`;
  return (
    <div className="flex min-w-0 items-center gap-0.5">
      <Menu
        align="left"
        width="w-96"
        trigger={(isOpen, t) => (
          <button
            type="button"
            onClick={() => {
              t();
              setOpen(!isOpen);
            }}
            aria-expanded={isOpen}
            aria-haspopup="menu"
            className="group flex min-w-0 max-w-[18rem] items-center gap-1.5 rounded px-1.5 py-1 text-left hover:bg-zinc-900 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-500"
            data-testid="agent-dataset"
          >
            <span className="text-2xs text-zinc-500">Dataset</span>
            <span className={cn('min-w-0 truncate text-xs', selected.length ? 'font-mono text-zinc-100' : 'text-zinc-400')}>{label}</span>
            <ChevronDown className="h-3 w-3 shrink-0 text-zinc-500 group-hover:text-zinc-300" />
          </button>
        )}
      >
        {() => (
          <div className="flex max-h-[420px] flex-col" data-testid="agent-dataset-menu">
            <div className="relative border-b border-zinc-800 p-2">
              <Search className="pointer-events-none absolute left-4 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
              <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search tables, views and files" aria-label="Search datasets" className="pl-7" uiSize="sm" data-testid="agent-dataset-search" />
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-1">
              {error && <p className="px-2 py-3 text-xs text-red-300">{error}</p>}
              {!data && !error && <div className="flex items-center gap-2 px-2 py-3 text-xs text-zinc-500"><Spinner className="h-3.5 w-3.5" /> Reading the catalog…</div>}
              {data && !q && data.recent.length > 0 && <Group title="Recent">{data.recent.map((n) => byName.get(n)).filter((d): d is DatasetOption => !!d).map(row)}</Group>}
              {data && !q && data.recommended.length > 0 && <Group title="Recommended (the semantic layer builds on these)">{data.recommended.map((n) => byName.get(n)).filter((d): d is DatasetOption => !!d).map(row)}</Group>}
              {data && <Group title={q ? `${shown.length} match${shown.length === 1 ? '' : 'es'}` : 'All data'}>{shown.slice(0, 200).map(row)}</Group>}
              {data && shown.length === 0 && <p className="px-2 py-3 text-xs text-zinc-500">Nothing here matches “{q}”.</p>}
            </div>
            <div className="flex items-center justify-between border-t border-zinc-800 px-3 py-1.5 text-2xs text-zinc-500">
              <span>{selected.length ? `${selected.length} chosen · the agent may find more` : 'None chosen · the agent finds what fits'}</span>
              {selected.length > 0 && <Button size="sm" variant="ghost" onClick={() => onChange([])}>Clear</Button>}
            </div>
          </div>
        )}
      </Menu>
      {selected.length > 0 && (
        <button type="button" onClick={() => onChange([])} aria-label="Clear the chosen datasets" className="rounded p-0.5 text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200"><X className="h-3 w-3" /></button>
      )}
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-1">
      <div className="px-2 pb-0.5 pt-1.5 text-2xs text-zinc-500">{title}</div>
      {children}
    </div>
  );
}

function compact(n: number): string {
  return n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n);
}
