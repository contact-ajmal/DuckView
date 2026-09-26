import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Search, CornerDownLeft, Table2, FileText, LayoutDashboard, Plus, Sparkles, Moon, Sun, Briefcase, ArrowRight, Upload, FileCode2, LayoutTemplate, ReceiptText, Columns3, NotebookPen, Sigma, AppWindow, MessageSquareText, Rocket, Database, Wrench, Plug, Settings, BookMarked, SquareTerminal, X } from 'lucide-react';
import { visibleSections, visibleSubpages } from '../../app/routes';
import { useNavAccess } from './nav';
import { useMissions } from '../../features/agent/missions';
import { useWorkspace } from '../../store/workspace';
import { useCopilot } from '../../store/copilot';
import { useTheme } from '../../store/theme';
import { api, type Dashboard, type SavedQuery } from '../../api/client';
import { usePalette } from './palette';
import { metricsLink } from '../../features/copilot/CopilotDrawer';
import { Kbd, cn } from '../ui';

interface Command {
  id: string;
  group: 'Agent' | 'Go to' | 'Actions' | 'Tools' | 'Datasets' | 'Columns' | 'Saved queries' | 'Dashboards' | 'Notebooks' | 'Metrics' | 'Apps' | 'Workspaces' | 'Theme';
  label: string;
  hint?: string;
  icon: ReactNode;
  keywords?: string;
  run: () => void;
}

const GROUP_ORDER: Command['group'][] = ['Agent', 'Datasets', 'Columns', 'Metrics', 'Saved queries', 'Dashboards', 'Notebooks', 'Apps', 'Tools', 'Actions', 'Go to', 'Workspaces', 'Theme'];

/** A command can narrow the palette to one kind of thing: "Switch workspace…", "Select a dataset…". */
type Scope = 'workspace' | 'dataset' | 'data' | 'dashboard' | 'tools';
const SCOPE: Record<Scope, { label: string; placeholder: string }> = {
  workspace: { label: 'Switch workspace', placeholder: 'Find a workspace…' },
  dataset: { label: 'Select a dataset for the agent', placeholder: 'Find a table, view or file…' },
  data: { label: 'Search data', placeholder: 'Search tables, columns, descriptions and values…' },
  dashboard: { label: 'Open a dashboard', placeholder: 'Find a dashboard…' },
  tools: { label: 'Search agent tools', placeholder: 'Find a tool the agent can use…' },
};
interface ToolInfo { name: string; title: string; summary: string }

/** Go to the Agent Home with the composer focused; `detail` can prefill it or leave what is on screen out. */
export function focusAgent(detail?: { text?: string; mode?: string; fresh?: boolean }) {
  location.hash = '#/';
  setTimeout(() => window.dispatchEvent(new CustomEvent('duckview:agent-focus', { detail })), 50);
}

interface SearchHit { kind: 'table' | 'column' | 'file' | 'query' | 'dashboard' | 'notebook' | 'metric' | 'app'; id: string; title: string; subtitle: string | null; match: 'name' | 'description' | 'content'; snippet: string | null; score: number }

/** ⌘K: go anywhere, open any dataset, query or dashboard, and run the common actions. */
export function CommandPalette() {
  const palette = usePalette();
  const ws = useWorkspace();
  const cp = useCopilot();
  const th = useTheme();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const [dashboards, setDashboards] = useState<Dashboard[]>([]);
  const [saved, setSaved] = useState<SavedQuery[]>([]);
  const [hits, setHits] = useState<{ q: string; hits: SearchHit[] } | null>(null);
  const [scope, setScope] = useState<Scope | null>(null);
  const [tools, setTools] = useState<ToolInfo[] | null>(null);
  const access = useNavAccess();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // ⌘K / Ctrl+K anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        palette.setOpen(!usePalette.getState().open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!palette.open) return;
    setQ('');
    setSel(0);
    setScope(null);
    setTimeout(() => inputRef.current?.focus(), 0);
    if (ws.activeId) {
      void api.get<{ dashboards: Dashboard[] }>(`/api/workspaces/${ws.activeId}/dashboards`).then((r) => setDashboards(r.dashboards)).catch(() => setDashboards([]));
      void api.get<{ queries: SavedQuery[] }>(`/api/workspaces/${ws.activeId}/queries`).then((r) => setSaved(r.queries)).catch(() => setSaved([]));
    }
  }, [palette.open, ws.activeId]);

  // As you type, the server searches everything in the workspace: descriptions, tags, columns, SQL, cells.
  useEffect(() => {
    const term = q.trim();
    if (!palette.open || !ws.activeId || term.length < 2) return setHits(null);
    const t = setTimeout(() => {
      void api.get<{ hits: SearchHit[] }>(`/api/workspaces/${ws.activeId}/search?q=${encodeURIComponent(term)}&limit=40`).then((r) => setHits({ q: term, hits: r.hits }), () => setHits(null));
    }, 150);
    return () => clearTimeout(t);
  }, [q, palette.open, ws.activeId]);

  useEffect(() => {
    if (scope === 'tools' && !tools) void api.get<{ tools: ToolInfo[] }>('/api/agent/tools').then((r) => setTools(r.tools), () => setTools([]));
  }, [scope, tools]);
  const narrow = (to: Scope) => () => {
    setScope(to);
    setQ('');
    setSel(0);
    inputRef.current?.focus();
  };

  const close = () => palette.setOpen(false);
  const go = (hash: string) => () => {
    location.hash = hash;
    close();
  };

  const commands = useMemo<Command[]>(() => {
    const out: Command[] = [
      { id: 'ask-agent', group: 'Agent', label: 'Ask the agent', hint: 'with what is on screen · ⌘I', icon: <Sparkles className="h-4 w-4" />, keywords: 'ai assistant question mission', run: () => { close(); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'i', metaKey: true })); } },
      { id: 'start-mission', group: 'Agent', label: 'Start a mission', hint: 'a fresh request', icon: <Rocket className="h-4 w-4" />, keywords: 'agent task analyse build investigate automate', run: () => { close(); useMissions.getState().setCarried(null); focusAgent({ fresh: true }); } },
      { id: 'switch-workspace', group: 'Agent', label: 'Switch workspace…', icon: <Briefcase className="h-4 w-4" />, keywords: 'change workspace', run: narrow('workspace') },
      { id: 'select-dataset', group: 'Agent', label: 'Select a dataset…', hint: 'for the agent', icon: <Database className="h-4 w-4" />, keywords: 'choose table context', run: narrow('dataset') },
      { id: 'search-data', group: 'Agent', label: 'Search data…', icon: <Search className="h-4 w-4" />, keywords: 'find table column value', run: narrow('data') },
      { id: 'search-tools', group: 'Agent', label: 'Search agent tools…', icon: <Wrench className="h-4 w-4" />, keywords: 'tools mcp capabilities', run: narrow('tools') },
      { id: 'open-sql', group: 'Actions', label: 'Open SQL', icon: <SquareTerminal className="h-4 w-4" />, keywords: 'workbench query editor', run: go('#/query') },
      { id: 'open-dashboard', group: 'Actions', label: 'Open a dashboard…', icon: <LayoutDashboard className="h-4 w-4" />, run: narrow('dashboard') },
      { id: 'open-catalog', group: 'Actions', label: 'Open catalog', icon: <BookMarked className="h-4 w-4" />, keywords: 'glossary tags owners', run: go('#/governance/catalog') },
      { id: 'open-mcp', group: 'Actions', label: 'Open Agents & MCP', icon: <Plug className="h-4 w-4" />, keywords: 'mcp approvals activity tokens', run: go('#/agents') },
      { id: 'open-settings', group: 'Actions', label: 'Settings', icon: <Settings className="h-4 w-4" />, keywords: 'preferences configuration', run: go('#/settings') },
      { id: 'new-sql', group: 'Actions', label: 'New SQL tab', icon: <Plus className="h-4 w-4" />, keywords: 'query editor', run: () => { void ws.addTab(); location.hash = '#/query'; close(); } },
      { id: 'ask-ai', group: 'Actions', label: cp.open ? 'Hide the question panel' : 'Ask about this screen', hint: '⌘J', icon: <MessageSquareText className="h-4 w-4" />, keywords: 'copilot assistant ai', run: () => { cp.toggle(); close(); } },
      { id: 'new-notebook', group: 'Actions', label: 'New notebook', icon: <Plus className="h-4 w-4" />, keywords: 'analysis cells markdown', run: go('#/notebooks?new=1') },
      { id: 'new-dashboard', group: 'Actions', label: 'New dashboard', icon: <LayoutDashboard className="h-4 w-4" />, run: go('#/dashboards?new=1') },
      { id: 'upload', group: 'Actions', label: 'Add data files', icon: <Upload className="h-4 w-4" />, keywords: 'upload import csv parquet', run: go('#/data') },
      { id: 'templates', group: 'Actions', label: 'Install a template', icon: <LayoutTemplate className="h-4 w-4" />, keywords: 'template marketplace gallery starter ecommerce saas', run: go('#/templates') },
      { id: 'usage', group: 'Go to', label: 'Usage & cost', icon: <ReceiptText className="h-4 w-4" />, keywords: 'billing spend budget tokens', run: go('#/settings/usage') },
      { id: 'new-connection', group: 'Actions', label: 'Connect a source', icon: <Plus className="h-4 w-4" />, keywords: 'connection database warehouse s3', run: go('#/connections') },
    ];
    // What a viewer can never do is not offered.
    if (!access.write) for (const id of ['templates', 'new-connection', 'new-dashboard', 'new-notebook', 'upload']) out.splice(out.findIndex((c) => c.id === id), 1);
    for (const s of visibleSections(access)) {
      out.push({ id: `go-${s.id}`, group: 'Go to', label: s.label, hint: s.hint, icon: <s.icon className="h-4 w-4" />, run: go(s.hash) });
      for (const p of visibleSubpages(s.id, access)) if (p.hash !== s.hash) out.push({ id: `go-${s.id}-${p.id}`, group: 'Go to', label: `${s.label} › ${p.label}`, icon: <ArrowRight className="h-4 w-4" />, run: go(p.hash) });
    }
    for (const f of ws.catalog?.files ?? []) out.push({ id: `f-${f.path}`, group: 'Datasets', label: f.path, hint: f.kind, icon: <FileText className="h-4 w-4" />, run: () => { if (ws.activeId) ws.setOverviewTarget(ws.activeId, f.path); location.hash = '#/data'; close(); } });
    for (const o of ws.catalog?.objects ?? []) {
      const name = o.schema === 'main' ? o.name : `${o.schema}.${o.name}`;
      out.push({ id: `t-${name}`, group: 'Datasets', label: name, hint: o.type.toLowerCase(), icon: <Table2 className="h-4 w-4" />, run: () => { if (ws.activeId) ws.setOverviewTarget(ws.activeId, name); location.hash = '#/data'; close(); } });
    }
    for (const sq of saved) out.push({ id: `q-${sq.id}`, group: 'Saved queries', label: sq.name, hint: sq.folder || undefined, icon: <FileCode2 className="h-4 w-4" />, keywords: sq.sql_text.slice(0, 200), run: () => { void ws.addTab({ title: sq.name, sql: sq.sql_text }); location.hash = '#/query'; close(); } });
    for (const d of dashboards) out.push({ id: `d-${d.id}`, group: 'Dashboards', label: d.name, hint: d.kind === 'mosaic' ? 'Mosaic' : 'grid', icon: <LayoutDashboard className="h-4 w-4" />, run: go(`#/dashboards/${d.id}`) });
    for (const w of ws.workspaces) if (w.id !== ws.activeId) out.push({ id: `w-${w.id}`, group: 'Workspaces', label: `Switch to ${w.name}`, icon: <Briefcase className="h-4 w-4" />, run: () => { void ws.selectWorkspace(w.id); close(); } });
    for (const t of th.themes) if (t.id !== th.themeId) out.push({ id: `th-${t.id}`, group: 'Theme', label: `Theme: ${t.name}`, icon: t.kind === 'dark' ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />, run: () => { th.setTheme(t.id); close(); } });
    return out;
  }, [ws.catalog, ws.workspaces, ws.activeId, dashboards, saved, th.themeId, cp.open, access.write]); // eslint-disable-line react-hooks/exhaustive-deps

  /** The items of a narrowed palette. */
  const scoped = useMemo<Command[] | null>(() => {
    if (!scope) return null;
    const pick = (name: string) => () => {
      const m = useMissions.getState();
      if (!m.datasets.includes(name)) m.setDatasets([...m.datasets, name]);
      close();
      focusAgent();
    };
    const datasets = [
      ...(ws.catalog?.objects ?? []).map((o) => ({ name: o.schema === 'main' ? o.name : `${o.schema}.${o.name}`, hint: o.type.toLowerCase(), file: false })),
      ...(ws.catalog?.files ?? []).map((f) => ({ name: f.path, hint: f.kind, file: true })),
    ];
    switch (scope) {
      case 'workspace':
        return ws.workspaces.map((w) => ({ id: `sw-${w.id}`, group: 'Workspaces', label: w.name, hint: w.id === ws.activeId ? 'current' : w.shared ? w.role.toLowerCase() : undefined, icon: <Briefcase className="h-4 w-4" />, run: () => { if (w.id !== ws.activeId) void ws.selectWorkspace(w.id); close(); } }));
      case 'dataset':
        return datasets.map((d) => ({ id: `sd-${d.name}`, group: 'Datasets', label: d.name, hint: d.hint, icon: d.file ? <FileText className="h-4 w-4" /> : <Table2 className="h-4 w-4" />, run: pick(d.name) }));
      case 'dashboard':
        return dashboards.map((d) => ({ id: `sdb-${d.id}`, group: 'Dashboards', label: d.name, hint: d.kind === 'mosaic' ? 'Mosaic' : 'grid', icon: <LayoutDashboard className="h-4 w-4" />, run: go(`#/dashboards/${d.id}`) }));
      case 'tools':
        return (tools ?? []).map((t) => ({ id: `tool-${t.name}`, group: 'Tools', label: t.title || t.name, hint: t.summary, keywords: t.name, icon: <Wrench className="h-4 w-4" />, run: go('#/agents/tools') }));
      case 'data':
        return datasets.map((d) => ({ id: `sdd-${d.name}`, group: 'Datasets', label: d.name, hint: d.hint, icon: d.file ? <FileText className="h-4 w-4" /> : <Table2 className="h-4 w-4" />, run: () => { if (ws.activeId) ws.setOverviewTarget(ws.activeId, d.name); location.hash = '#/data'; close(); } }));
    }
  }, [scope, ws.workspaces, ws.activeId, ws.catalog, dashboards, tools]); // eslint-disable-line react-hooks/exhaustive-deps

  const serverCommands = useMemo<Command[] | null>(() => {
    if (!hits || hits.q !== q.trim()) return null;
    const openDataset = (name: string) => () => { if (ws.activeId) ws.setOverviewTarget(ws.activeId, name); location.hash = '#/data'; close(); };
    const why = (h: SearchHit) => (h.snippet ? `${h.subtitle ? `${h.subtitle} · ` : ''}“${h.snippet}”` : h.subtitle ?? undefined);
    return hits.hits.map((h): Command => {
      const base = { id: `s-${h.kind}-${h.id}`, label: h.title, hint: why(h), keywords: `${h.title} ${h.snippet ?? ''} ${h.subtitle ?? ''}` };
      switch (h.kind) {
        case 'table': return { ...base, group: 'Datasets', icon: <Table2 className="h-4 w-4" />, run: openDataset(h.id) };
        case 'file': return { ...base, group: 'Datasets', icon: <FileText className="h-4 w-4" />, run: openDataset(h.id) };
        case 'column': return { ...base, group: 'Columns', icon: <Columns3 className="h-4 w-4" />, run: openDataset(h.id.slice(0, h.id.lastIndexOf('.'))) };
        case 'query': return { ...base, group: 'Saved queries', icon: <FileCode2 className="h-4 w-4" />, run: () => { const sq = saved.find((x) => x.id === h.id); if (sq) void ws.addTab({ title: sq.name, sql: sq.sql_text }); location.hash = '#/query'; close(); } };
        case 'dashboard': return { ...base, group: 'Dashboards', icon: <LayoutDashboard className="h-4 w-4" />, run: go(`#/dashboards/${h.id}`) };
        case 'notebook': return { ...base, group: 'Notebooks', icon: <NotebookPen className="h-4 w-4" />, run: go(`#/notebooks/${h.id}`) };
        case 'metric': return { ...base, group: 'Metrics', icon: <Sigma className="h-4 w-4" />, run: go(metricsLink({ metrics: [h.id] })) };
        default: return { ...base, group: 'Apps', icon: <AppWindow className="h-4 w-4" />, run: go(`#/apps/${h.id}`) };
      }
    });
  }, [hits, q, saved, ws.activeId]); // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = useMemo(() => {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    const score = (c: Command) => {
      const hay = `${c.label} ${c.hint ?? ''} ${c.keywords ?? ''} ${c.group}`.toLowerCase();
      if (!terms.every((t) => hay.includes(t))) return -1;
      return c.label.toLowerCase().startsWith(terms[0] ?? '') ? 2 : 1;
    };
    if (scoped) {
      const local = scoped.map((c) => ({ c, s: score(c) })).filter((x) => x.s >= 0).sort((a, b) => b.s - a.s).map((x) => x.c);
      // Searching data also reaches columns, descriptions and values through the server's search.
      const extra = scope === 'data' && serverCommands ? serverCommands.filter((c) => c.group === 'Columns' || !local.some((l) => l.label === c.label)) : [];
      return [...local, ...extra].slice(0, 60);
    }
    // Server results replace the client's own lists of datasets, queries and dashboards once they arrive.
    const replaced = new Set<Command['group']>(serverCommands ? ['Datasets', 'Saved queries', 'Dashboards'] : []);
    const local = commands.filter((c) => !replaced.has(c.group)).map((c) => ({ c, s: score(c) })).filter((x) => x.s >= 0);
    const hits = [...local, ...(serverCommands ?? []).map((c, i) => ({ c, s: 100 - i }))];
    // Without a query, show actions and navigation only; datasets and the rest appear as you type.
    const base = terms.length ? hits : hits.filter((x) => x.c.group === 'Agent' || x.c.group === 'Actions' || x.c.group === 'Go to');
    const found = GROUP_ORDER.flatMap((g) => base.filter((x) => x.c.group === g).sort((a, b) => b.s - a.s).slice(0, terms.length ? 8 : 20).map((x) => x.c));
    // Anything typed can go to the agent (a mission) or be asked about what is on screen.
    if (q.trim().length > 2 && ws.activeId) {
      const question = q.trim();
      const mission: Command = { id: 'ask-agent-q', group: 'Agent', label: `Ask the agent: ${question}`, icon: <Sparkles className="h-4 w-4" />, run: () => { close(); void useMissions.getState().start(question); } };
      const ask: Command = { id: 'ask-ai-q', group: 'Actions', label: `Ask about this screen: ${question}`, icon: <MessageSquareText className="h-4 w-4" />, run: () => { cp.toggle(true); void cp.send({ workspaceId: ws.activeId!, message: question }); close(); } };
      return [...found, mission, ask];
    }
    return found;
  }, [commands, serverCommands, scoped, q]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${sel}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  if (!palette.open) return null;
  let lastGroup = '';
  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center bg-black/30 p-4 pt-[12vh]" onMouseDown={close}>
      <div role="dialog" aria-modal="true" aria-label="Command palette" className="dv-pop w-full max-w-xl overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950 shadow-xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b border-zinc-800 px-3">
          <Search className="h-4 w-4 shrink-0 text-zinc-500" />
          {scope && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-zinc-800/80 py-0.5 pl-2 pr-0.5 text-xs text-zinc-200" data-testid="palette-scope">
              {SCOPE[scope].label}
              <button type="button" aria-label="Back to all commands" onClick={() => { setScope(null); inputRef.current?.focus(); }} className="rounded p-0.5 text-zinc-500 hover:bg-zinc-700 hover:text-zinc-100"><X className="h-3 w-3" /></button>
            </span>
          )}
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(filtered.length - 1, s + 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
              else if (e.key === 'Enter') { e.preventDefault(); filtered[sel]?.run(); }
              else if (e.key === 'Escape') { if (scope) { e.preventDefault(); setScope(null); } else close(); }
              else if (e.key === 'Backspace' && !q && scope) setScope(null);
            }}
            placeholder={scope ? SCOPE[scope].placeholder : 'Ask, search data, or run a command…'}
            aria-label="Search"
            className="h-11 min-w-0 flex-1 bg-transparent text-body text-zinc-100 placeholder:text-zinc-600 focus:outline-none"
          />
          <Kbd>Esc</Kbd>
        </div>
        <div ref={listRef} role="listbox" className="max-h-[52vh] overflow-y-auto p-1.5">
          {filtered.length === 0 && <div className="px-3 py-6 text-center text-body text-zinc-500">{scope === 'tools' && !tools ? 'Loading the agent\'s tools…' : q ? `Nothing matches “${q}”.` : 'Nothing here yet.'}</div>}
          {filtered.map((c, i) => {
            const header = c.group !== lastGroup ? c.group : null;
            lastGroup = c.group;
            return (
              <div key={c.id}>
                {header && <div className="px-2 pb-1 pt-2 text-2xs font-medium text-zinc-500">{header}</div>}
                <button
                  data-index={i}
                  role="option"
                  aria-selected={i === sel}
                  onMouseMove={() => setSel(i)}
                  onClick={c.run}
                  className={cn('flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-body', i === sel ? 'bg-zinc-900 text-zinc-50' : 'text-zinc-300')}
                >
                  <span className="shrink-0 text-zinc-500">{c.icon}</span>
                  <span className="min-w-0 flex-1 truncate">{c.label}</span>
                  {c.hint && <span className="max-w-[40%] shrink-0 truncate text-2xs text-zinc-500">{c.hint}</span>}
                  {i === sel && <CornerDownLeft className="h-3.5 w-3.5 shrink-0 text-zinc-500" />}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
