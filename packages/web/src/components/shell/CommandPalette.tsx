import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Search, CornerDownLeft, Table2, FileText, LayoutDashboard, Plus, Sparkles, Moon, Sun, Briefcase, ArrowRight, Upload, FileCode2, LayoutTemplate, ReceiptText, Columns3, NotebookPen, Sigma, AppWindow } from 'lucide-react';
import { SECTIONS, SUBPAGES } from '../../app/routes';
import { useWorkspace } from '../../store/workspace';
import { useCopilot } from '../../store/copilot';
import { useTheme } from '../../store/theme';
import { api, type Dashboard, type SavedQuery } from '../../api/client';
import { usePalette } from './palette';
import { metricsLink } from '../../features/copilot/CopilotDrawer';
import { Kbd, cn } from '../ui';

interface Command {
  id: string;
  group: 'Go to' | 'Actions' | 'Datasets' | 'Columns' | 'Saved queries' | 'Dashboards' | 'Notebooks' | 'Metrics' | 'Apps' | 'Workspaces' | 'Theme';
  label: string;
  hint?: string;
  icon: ReactNode;
  keywords?: string;
  run: () => void;
}

const GROUP_ORDER: Command['group'][] = ['Datasets', 'Columns', 'Metrics', 'Saved queries', 'Dashboards', 'Notebooks', 'Apps', 'Actions', 'Go to', 'Workspaces', 'Theme'];

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

  const close = () => palette.setOpen(false);
  const go = (hash: string) => () => {
    location.hash = hash;
    close();
  };

  const commands = useMemo<Command[]>(() => {
    const out: Command[] = [
      { id: 'new-sql', group: 'Actions', label: 'New SQL tab', icon: <Plus className="h-4 w-4" />, keywords: 'query editor', run: () => { void ws.addTab(); location.hash = '#/query'; close(); } },
      { id: 'ask-ai', group: 'Actions', label: cp.open ? 'Hide AI panel' : 'Ask AI about this data', icon: <Sparkles className="h-4 w-4" />, keywords: 'copilot assistant', run: () => { cp.toggle(); close(); } },
      { id: 'new-notebook', group: 'Actions', label: 'New notebook', icon: <Plus className="h-4 w-4" />, keywords: 'analysis cells markdown', run: go('#/notebooks?new=1') },
      { id: 'new-dashboard', group: 'Actions', label: 'New dashboard', icon: <LayoutDashboard className="h-4 w-4" />, run: go('#/dashboards?new=1') },
      { id: 'upload', group: 'Actions', label: 'Add data files', icon: <Upload className="h-4 w-4" />, keywords: 'upload import csv parquet', run: go('#/data') },
      { id: 'templates', group: 'Actions', label: 'Install a template', icon: <LayoutTemplate className="h-4 w-4" />, keywords: 'template marketplace gallery starter ecommerce saas', run: go('#/templates') },
      { id: 'usage', group: 'Go to', label: 'Usage & cost', icon: <ReceiptText className="h-4 w-4" />, keywords: 'billing spend budget tokens', run: go('#/settings/usage') },
      { id: 'new-connection', group: 'Actions', label: 'Connect a source', icon: <Plus className="h-4 w-4" />, keywords: 'connection database warehouse s3', run: go('#/connections') },
    ];
    for (const s of SECTIONS) {
      out.push({ id: `go-${s.id}`, group: 'Go to', label: s.label, hint: s.hint, icon: <s.icon className="h-4 w-4" />, run: go(s.hash) });
      for (const p of SUBPAGES[s.id] ?? []) if (p.hash !== s.hash) out.push({ id: `go-${s.id}-${p.id}`, group: 'Go to', label: `${s.label} › ${p.label}`, icon: <ArrowRight className="h-4 w-4" />, run: go(p.hash) });
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
  }, [ws.catalog, ws.workspaces, ws.activeId, dashboards, saved, th.themeId, cp.open]); // eslint-disable-line react-hooks/exhaustive-deps

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
    // Server results replace the client's own lists of datasets, queries and dashboards once they arrive.
    const replaced = new Set<Command['group']>(serverCommands ? ['Datasets', 'Saved queries', 'Dashboards'] : []);
    const local = commands.filter((c) => !replaced.has(c.group)).map((c) => ({ c, s: score(c) })).filter((x) => x.s >= 0);
    const hits = [...local, ...(serverCommands ?? []).map((c, i) => ({ c, s: 100 - i }))];
    // Without a query, show actions and navigation only; datasets and the rest appear as you type.
    const base = terms.length ? hits : hits.filter((x) => x.c.group === 'Actions' || x.c.group === 'Go to');
    const found = GROUP_ORDER.flatMap((g) => base.filter((x) => x.c.group === g).sort((a, b) => b.s - a.s).slice(0, terms.length ? 8 : 20).map((x) => x.c));
    // Anything typed can also go to the AI, with what is on screen as context.
    if (q.trim().length > 2 && ws.activeId) {
      const question = q.trim();
      const ask: Command = { id: 'ask-ai-q', group: 'Actions', label: `Ask AI: ${question}`, icon: <Sparkles className="h-4 w-4" />, run: () => { cp.toggle(true); void cp.send({ workspaceId: ws.activeId!, message: question }); close(); } };
      return found.length ? [...found, ask] : [ask];
    }
    return found;
  }, [commands, serverCommands, q]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${sel}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  if (!palette.open) return null;
  let lastGroup = '';
  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center bg-black/30 p-4 pt-[12vh]" onMouseDown={close}>
      <div role="dialog" aria-modal="true" aria-label="Command palette" className="dv-pop w-full max-w-xl overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950 shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 border-b border-zinc-800 px-3">
          <Search className="h-4 w-4 shrink-0 text-zinc-500" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(filtered.length - 1, s + 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
              else if (e.key === 'Enter') { e.preventDefault(); filtered[sel]?.run(); }
              else if (e.key === 'Escape') close();
            }}
            placeholder="Search data, queries, dashboards, commands…"
            aria-label="Search"
            className="h-11 min-w-0 flex-1 bg-transparent text-body text-zinc-100 placeholder:text-zinc-600 focus:outline-none"
          />
          <Kbd>Esc</Kbd>
        </div>
        <div ref={listRef} role="listbox" className="max-h-[52vh] overflow-y-auto p-1.5">
          {filtered.length === 0 && <div className="px-3 py-6 text-center text-body text-zinc-500">Nothing matches “{q}”.</div>}
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
