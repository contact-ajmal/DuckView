import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowDown, ArrowLeft, ArrowUp, BarChart3, BookOpenText, Braces, Download, FileCode2, Loader2, MoreHorizontal, Play, Plus, Sparkles, Table2, Trash2, Type, Variable } from 'lucide-react';
import { api, getToken, timeAgo, type ChartConfig, type Notebook, type NotebookCell, type NotebookOutput, type NotebookSummary } from '../../api/client';
import { useWorkspace, useWorkspaceAccess } from '../../store/workspace';
import { useCopilot } from '../../store/copilot';
import { Button, Empty, IconButton, Input, Menu, MenuDivider, MenuItem, Select, Spinner, cn } from '../../components/ui';
import { PageHeader } from '../../components/layout';
import { SqlEditor } from '../workspace/SqlEditor';
import { ResultsGrid } from '../workspace/ResultsGrid';
import { ChartPanel } from '../workspace/ChartPanel';
import { registerCopilotHost } from '../copilot/CopilotDrawer';

const idOf = () => /^#\/notebooks\/([\w-]+)/.exec(location.hash)?.[1] ?? null;

/** SQL › Notebooks: the list, or one notebook (#/notebooks/<id>). */
export function NotebooksPage() {
  const ws = useWorkspace();
  const [id, setId] = useState<string | null>(idOf);
  useEffect(() => {
    const on = () => setId(idOf());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  if (!ws.activeId) return null;
  return id ? <NotebookView key={id} id={id} workspaceId={ws.activeId} /> : <NotebookList key={ws.activeId} workspaceId={ws.activeId} />;
}

function NotebookList({ workspaceId }: { workspaceId: string }) {
  const { canEdit } = useWorkspaceAccess();
  const [list, setList] = useState<NotebookSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const create = useCallback(async () => {
    try {
      const r = await api.post<{ notebook: Notebook }>(`/api/workspaces/${workspaceId}/notebooks`, { title: 'Untitled notebook' });
      location.hash = `#/notebooks/${r.notebook.id}`;
    } catch (e) {
      setError((e as Error).message);
    }
  }, [workspaceId]);
  useEffect(() => {
    void api.get<{ notebooks: NotebookSummary[] }>(`/api/workspaces/${workspaceId}/notebooks`).then((r) => setList(r.notebooks)).catch((e) => setError((e as Error).message));
    if (/[?&]new=1/.test(location.hash) && canEdit) {
      history.replaceState(null, '', '#/notebooks');
      void create();
    }
  }, [workspaceId, canEdit, create]);
  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-[1100px] space-y-4 px-6 py-5">
        <PageHeader title="Notebooks" description="Analyses as a sequence of SQL, text and inputs — each query can build on the one above it." actions={<Button variant="primary" size="sm" disabled={!canEdit} onClick={() => void create()} data-testid="new-notebook"><Plus className="h-3.5 w-3.5" /> New notebook</Button>} />
        {error && <div className="rounded-md border border-red-900 bg-red-950/50 px-3 py-2 font-mono text-xs text-red-200">{error}</div>}
        {list === null ? <Spinner /> : list.length === 0 ? (
          <div className="border-y border-zinc-800 py-12"><Empty icon={<BookOpenText />} title="No notebooks yet" hint="Write the question in text, answer it step by step in SQL, and let each step query the one before it. Inputs make it re-runnable for another region or month." action={canEdit ? <Button size="sm" onClick={() => void create()}><Plus className="h-3.5 w-3.5" /> New notebook</Button> : undefined} /></div>
        ) : (
          <div className="border-y border-zinc-800" data-testid="notebook-list">
            <div className="grid grid-cols-[minmax(0,1fr)_120px_140px] gap-3 border-b border-zinc-800 px-1 py-1.5 text-xs text-zinc-500"><span>Title</span><span>Cells</span><span>Saved</span></div>
            {list.map((n) => (
              <a key={n.id} href={`#/notebooks/${n.id}`} className="grid grid-cols-[minmax(0,1fr)_120px_140px] items-center gap-3 border-b border-zinc-800/70 px-1 py-2 last:border-0 hover:bg-zinc-900/60">
                <span className="flex min-w-0 items-center gap-2 text-[13px] text-zinc-100"><BookOpenText className="h-4 w-4 shrink-0 text-zinc-500" /><span className="truncate">{n.title}</span></span>
                <span className="text-xs text-zinc-500">{n.cell_count} · {n.sql_cells} SQL</span>
                <span className="text-xs text-zinc-500">{timeAgo(n.updated_at)}</span>
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

type Save = 'saved' | 'dirty' | 'saving' | 'conflict' | 'error';
const newCell = (type: NotebookCell['type'], cells: NotebookCell[], source = ''): NotebookCell => {
  const used = new Set(cells.map((c) => c.name?.toLowerCase()).filter(Boolean));
  let n = cells.filter((c) => c.type === type).length + 1;
  const base = type === 'sql' ? 'df' : 'param';
  while (used.has(`${base}${n}`)) n++;
  const id = Math.random().toString(36).slice(2, 12);
  if (type === 'sql') return { id, type, name: `${base}${n}`, source, view: 'table', chart: null, output: null };
  if (type === 'input') return { id, type, name: `${base}${n}`, source: '', input: { kind: 'text', label: null, value: '' } };
  return { id, type, source: source || 'Write here — **Markdown** works.' };
};
/** What is sent when saving: everything but outputs (the server keeps its own). */
const forSave = (cells: NotebookCell[]) => cells.map(({ output, ...c }) => (output === null ? { ...c, output: null } : c));

function NotebookView({ id, workspaceId }: { id: string; workspaceId: string }) {
  const { canEdit } = useWorkspaceAccess();
  const ws = useWorkspace();
  const cp = useCopilot();
  const [nb, setNb] = useState<Notebook | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [save, setSave] = useState<Save>('saved');
  const [conflict, setConflict] = useState<string | null>(null);
  const [running, setRunning] = useState<Set<string>>(new Set());
  const [focused, setFocused] = useState<string | null>(null);
  const ref = useRef<Notebook | null>(null);
  ref.current = nb;
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saving = useRef<Promise<void> | null>(null);

  useEffect(() => {
    void api.get<{ notebook: Notebook }>(`/api/notebooks/${id}`).then((r) => setNb(r.notebook)).catch((e) => setError((e as Error).message));
    if (!ws.catalog) void ws.loadCatalog();
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const flush = useCallback(async () => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    if (saving.current) await saving.current;
    const cur = ref.current;
    if (!cur || !canEdit) return;
    const doSave = async () => {
      setSave('saving');
      try {
        const r = await api.patch<{ notebook: Notebook }>(`/api/notebooks/${id}`, { title: cur.title, cells: forSave(cur.cells), version: cur.version });
        // Keep what was typed meanwhile; take the new version (and new server ids for nothing: ids are ours).
        setNb((n) => (n ? { ...n, version: r.notebook.version, updated_at: r.notebook.updated_at } : n));
        setSave((s) => (s === 'saving' ? 'saved' : s));
      } catch (e) {
        const msg = (e as Error).message;
        if (/saved this notebook after you opened it/.test(msg)) {
          setConflict(msg);
          setSave('conflict');
        } else {
          setError(msg);
          setSave('error');
        }
      }
    };
    saving.current = doSave();
    await saving.current;
    saving.current = null;
  }, [id, canEdit]);

  const change = useCallback((fn: (n: Notebook) => Notebook) => {
    setNb((n) => (n ? fn(n) : n));
    if (!canEdit) return;
    setSave((s) => (s === 'conflict' ? s : 'dirty'));
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void flush(), 800);
  }, [canEdit, flush]);
  const setCell = useCallback((cellId: string, p: Partial<NotebookCell>) => change((n) => ({ ...n, cells: n.cells.map((c) => (c.id === cellId ? { ...c, ...p } : c)) })), [change]);

  const runCell = useCallback(async (cellId: string): Promise<NotebookOutput | null> => {
    setRunning((r) => new Set(r).add(cellId));
    try {
      // Editors save first, so the run uses (and stores its output with) what is on screen; viewers send their cells.
      if (canEdit && save !== 'conflict') await flush();
      const cur = ref.current!;
      const r = await api.post<{ output: NotebookOutput }>(`/api/notebooks/${id}/cells/${cellId}/run`, canEdit && save !== 'conflict' ? {} : { cells: forSave(cur.cells) });
      setNb((n) => (n ? { ...n, cells: n.cells.map((c) => (c.id === cellId ? { ...c, output: r.output } : c)) } : n));
      return r.output;
    } catch (e) {
      const output: NotebookOutput = { columns: [], rows: [], row_count: 0, truncated: false, duration_ms: 0, ran_at: new Date().toISOString(), ran_by: null, rows_changed: null, error: (e as Error).message };
      setNb((n) => (n ? { ...n, cells: n.cells.map((c) => (c.id === cellId ? { ...c, output } : c)) } : n));
      return output;
    } finally {
      setRunning((r) => {
        const next = new Set(r);
        next.delete(cellId);
        return next;
      });
    }
  }, [id, canEdit, flush, save]);

  const runAll = useCallback(async () => {
    for (const c of (ref.current?.cells ?? []).filter((x) => x.type === 'sql')) {
      const o = await runCell(c.id);
      if (o?.error) break;
    }
  }, [runCell]);

  const addCell = useCallback((type: NotebookCell['type'], after: string | null, source = '') => {
    let added: NotebookCell | null = null;
    change((n) => {
      added = newCell(type, n.cells, source);
      const i = after ? n.cells.findIndex((c) => c.id === after) : n.cells.length - 1;
      const cells = [...n.cells];
      cells.splice(i + 1, 0, added);
      return { ...n, cells };
    });
    setTimeout(() => added && setFocused(added.id), 0);
    return () => added;
  }, [change]);

  // DuckView AI acts on this notebook: SQL becomes a new cell below the focused one.
  useEffect(() => {
    registerCopilotHost({
      insertLabel: 'Add as cell',
      insertSql: (s) => void addCell('sql', focused, s),
      newTabWithSql: (s) => void addCell('sql', focused, s),
      runSql: async (s) => {
        const get = addCell('sql', focused, s);
        await new Promise((r) => setTimeout(r, 50));
        const cell = get();
        const o = cell ? await runCell((cell as NotebookCell).id) : null;
        return o ? { columns: o.columns, rows: o.rows.slice(0, 50), rowCount: o.row_count, error: o.error ?? undefined } : { columns: [], rows: [], rowCount: 0, error: 'not run' };
      },
      activeSql: () => ref.current?.cells.find((c) => c.id === focused)?.source ?? '',
      activeError: () => ref.current?.cells.find((c) => c.id === focused)?.output?.error ?? null,
    });
    return () => registerCopilotHost(null);
  }, [addCell, runCell, focused]);

  const move = (cellId: string, d: -1 | 1) => change((n) => {
    const i = n.cells.findIndex((c) => c.id === cellId);
    const j = i + d;
    if (i < 0 || j < 0 || j >= n.cells.length) return n;
    const cells = [...n.cells];
    [cells[i], cells[j]] = [cells[j]!, cells[i]!];
    return { ...n, cells };
  });

  const exportMd = async () => {
    const res = await fetch(`/api/notebooks/${id}/export.md`, { headers: { authorization: `Bearer ${getToken() ?? ''}` } });
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(nb?.title ?? 'notebook').replace(/[^\w.\- ]+/g, '_')}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  // Autocomplete: the workspace's tables, and the names of the cells above with their output columns.
  const schema = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const o of ws.catalog?.objects ?? []) out[o.schema === 'main' ? o.name : `${o.schema}.${o.name}`] = o.columns.map((c) => c.name);
    for (const c of nb?.cells ?? []) if (c.type === 'sql' && c.name) out[c.name] = c.output?.columns.map((x) => x.name) ?? [];
    return out;
  }, [ws.catalog, nb?.cells]);

  if (error && !nb) return <div className="p-6 font-mono text-xs text-red-300">{error}</div>;
  if (!nb) return <div className="p-6"><Spinner /></div>;
  const names = new Set(nb.cells.filter((c) => c.type === 'sql').map((c) => c.name?.toLowerCase()));

  return (
    <div className="h-full overflow-auto" data-testid="notebook">
      <div className="sticky top-0 z-10 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur">
        <div className="mx-auto flex h-11 max-w-[1040px] items-center gap-2 px-6">
          <a href="#/notebooks" className="text-zinc-500 hover:text-zinc-200" aria-label="All notebooks"><ArrowLeft className="h-4 w-4" /></a>
          <input value={nb.title} readOnly={!canEdit} onChange={(e) => change((n) => ({ ...n, title: e.target.value }))} aria-label="Title" data-testid="notebook-title" className="min-w-0 flex-1 truncate rounded bg-transparent px-1 py-0.5 text-[15px] font-semibold text-zinc-50 outline-none hover:bg-zinc-900 focus:bg-zinc-900" />
          <span className={cn('shrink-0 text-xs', save === 'conflict' || save === 'error' ? 'text-red-300' : 'text-zinc-500')} data-testid="save-state">{!canEdit ? 'View only' : save === 'saved' ? 'Saved' : save === 'saving' ? 'Saving…' : save === 'dirty' ? 'Unsaved' : save === 'conflict' ? 'Not saved — changed elsewhere' : 'Not saved'}</span>
          <Button size="sm" variant="ghost" onClick={() => cp.toggle(true)} title="DuckView AI sees this notebook"><Sparkles className="h-3.5 w-3.5" /> Ask AI</Button>
          <Button size="sm" variant="primary" onClick={() => void runAll()} disabled={running.size > 0} data-testid="run-all"><Play className="h-3.5 w-3.5" /> Run all</Button>
          <Menu trigger={(_, toggle) => <IconButton label="More notebook actions" onClick={toggle}><MoreHorizontal className="h-4 w-4" /></IconButton>}>
            {(close) => (
              <>
                <MenuItem icon={<Download className="h-3.5 w-3.5" />} onClick={() => { close(); void exportMd(); }}>Export as Markdown</MenuItem>
                <MenuDivider />
                <MenuItem danger icon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => { close(); if (canEdit && confirm(`Delete "${nb.title}"?`)) void api.del(`/api/notebooks/${id}`).then(() => (location.hash = '#/notebooks')); }}>Delete notebook</MenuItem>
              </>
            )}
          </Menu>
        </div>
      </div>
      {conflict && (
        <div className="mx-auto mt-3 flex max-w-[1040px] items-center gap-3 rounded-md border border-amber-900/60 bg-amber-950/30 px-3 py-2 text-xs text-amber-100" role="alert">
          <span className="flex-1">{conflict}</span>
          <Button size="sm" onClick={() => location.reload()}>Reload their version</Button>
        </div>
      )}
      <div className="mx-auto max-w-[1040px] px-6 pb-24 pt-4">
        {nb.cells.map((c, i) => (
          <div key={c.id}>
            <CellView
              cell={c}
              focused={focused === c.id}
              canEdit={canEdit}
              running={running.has(c.id)}
              schema={schema}
              duplicateName={c.type === 'sql' && !!c.name && [...nb.cells.slice(0, i)].some((x) => x.type === 'sql' && x.name?.toLowerCase() === c.name!.toLowerCase())}
              onFocus={() => setFocused(c.id)}
              onChange={(p) => setCell(c.id, p)}
              onRun={() => void runCell(c.id)}
              onMove={(d) => move(c.id, d)}
              onDelete={() => change((n) => ({ ...n, cells: n.cells.filter((x) => x.id !== c.id) }))}
            />
            {canEdit && <AddBar onAdd={(t) => addCell(t, c.id)} />}
          </div>
        ))}
        {nb.cells.length === 0 && canEdit && <AddBar always onAdd={(t) => addCell(t, null)} />}
        <p className="mt-6 text-center text-xs text-zinc-600">{names.size ? `Query a cell above by its name — ${[...names].slice(0, 3).map((n) => `SELECT * FROM ${n}`).join(', ')} · {{ name }} uses an input.` : ''}</p>
      </div>
    </div>
  );
}

function AddBar({ onAdd, always }: { onAdd: (t: NotebookCell['type']) => void; always?: boolean }) {
  return (
    <div className={cn('group flex h-6 items-center justify-center gap-1', !always && 'opacity-0 transition-opacity hover:opacity-100 focus-within:opacity-100')}>
      <span className="h-px flex-1 bg-zinc-800" />
      <button className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100" onClick={() => onAdd('sql')} data-add="sql"><Plus className="h-3 w-3" /> SQL</button>
      <button className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100" onClick={() => onAdd('markdown')} data-add="markdown"><Type className="h-3 w-3" /> Text</button>
      <button className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100" onClick={() => onAdd('input')} data-add="input"><Variable className="h-3 w-3" /> Input</button>
      <span className="h-px flex-1 bg-zinc-800" />
    </div>
  );
}

const MD = 'text-[13.5px] leading-relaxed text-zinc-300 [&_a]:text-accent-300 [&_a]:underline [&_code]:rounded [&_code]:bg-zinc-900 [&_code]:px-1 [&_code]:font-mono [&_code]:text-[12px] [&_h1]:mb-2 [&_h1]:text-xl [&_h1]:font-semibold [&_h1]:text-zinc-50 [&_h2]:mb-1.5 [&_h2]:mt-3 [&_h2]:text-base [&_h2]:font-semibold [&_h2]:text-zinc-100 [&_h3]:mt-2 [&_h3]:font-semibold [&_h3]:text-zinc-100 [&_li]:ml-5 [&_ol]:list-decimal [&_p]:my-1.5 [&_strong]:text-zinc-100 [&_table]:my-2 [&_td]:border [&_td]:border-zinc-800 [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-zinc-800 [&_th]:px-2 [&_th]:py-1 [&_ul]:list-disc';

function CellView({ cell, focused, canEdit, running, schema, duplicateName, onFocus, onChange, onRun, onMove, onDelete }: { cell: NotebookCell; focused: boolean; canEdit: boolean; running: boolean; schema: Record<string, string[]>; duplicateName: boolean; onFocus: () => void; onChange: (p: Partial<NotebookCell>) => void; onRun: () => void; onMove: (d: -1 | 1) => void; onDelete: () => void }) {
  const [editing, setEditing] = useState(false);
  const icon = cell.type === 'sql' ? <FileCode2 className="h-3.5 w-3.5" /> : cell.type === 'input' ? <Braces className="h-3.5 w-3.5" /> : <Type className="h-3.5 w-3.5" />;
  const onRunRef = useRef(onRun);
  onRunRef.current = onRun;
  const stableRun = useCallback(() => onRunRef.current(), []);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const stableChange = useCallback((v: string) => onChangeRef.current({ source: v }), []);
  return (
    <section className={cn('group/cell relative rounded-lg border px-3 py-2 transition-colors', focused ? 'border-zinc-700 bg-zinc-900/30' : 'border-transparent hover:border-zinc-800')} onFocusCapture={onFocus} onMouseDown={onFocus} data-cell={cell.name ?? cell.id} data-cell-type={cell.type}>
      <div className="mb-1 flex h-6 items-center gap-2 text-xs text-zinc-500">
        <span className="text-zinc-600">{icon}</span>
        {cell.type !== 'markdown' ? (
          <input value={cell.name ?? ''} readOnly={!canEdit} onChange={(e) => onChange({ name: e.target.value.replace(/[^\w]/g, '_') })} aria-label="Cell name" className={cn('w-40 rounded bg-transparent px-1 font-mono text-[12px] outline-none hover:bg-zinc-900 focus:bg-zinc-900', duplicateName ? 'text-red-300' : 'text-zinc-300')} title={cell.type === 'sql' ? 'Later cells query this result by its name' : 'Use it in SQL as {{ name }}'} />
        ) : <span>Text</span>}
        {cell.type === 'sql' && cell.output && !cell.output.error && <span className="truncate">{cell.output.rows_changed != null && !cell.output.columns.length ? `${cell.output.rows_changed} rows changed` : `${cell.output.row_count.toLocaleString()} row${cell.output.row_count === 1 ? '' : 's'}`} · {cell.output.duration_ms} ms{cell.output.ran_by ? ` · ${cell.output.ran_by}` : ''} · {timeAgo(cell.output.ran_at)}</span>}
        <span className="ml-auto flex items-center gap-0.5 opacity-0 transition-opacity group-hover/cell:opacity-100 group-focus-within/cell:opacity-100">
          {canEdit && <IconButton label="Move up" onClick={() => onMove(-1)}><ArrowUp className="h-3.5 w-3.5" /></IconButton>}
          {canEdit && <IconButton label="Move down" onClick={() => onMove(1)}><ArrowDown className="h-3.5 w-3.5" /></IconButton>}
          {canEdit && <IconButton label="Delete cell" onClick={onDelete}><Trash2 className="h-3.5 w-3.5" /></IconButton>}
        </span>
        {cell.type === 'sql' && <Button size="sm" variant={focused ? 'primary' : 'secondary'} onClick={onRun} disabled={running} aria-label={`Run ${cell.name}`} data-testid="run-cell">{running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />} Run</Button>}
      </div>

      {cell.type === 'markdown' && (editing && canEdit ? (
        <textarea autoFocus value={cell.source} onChange={(e) => onChange({ source: e.target.value })} onBlur={() => setEditing(false)} onKeyDown={(e) => { if (e.key === 'Escape' || ((e.metaKey || e.ctrlKey) && e.key === 'Enter')) setEditing(false); }} rows={Math.max(3, cell.source.split('\n').length + 1)} aria-label="Text" className="w-full resize-y rounded-md border border-zinc-800 bg-zinc-950 p-2 font-mono text-[12.5px] text-zinc-200 focus:border-accent-500 focus:outline-none" />
      ) : (
        <div className={cn(MD, canEdit && 'cursor-text')} onDoubleClick={() => setEditing(true)} onClick={() => !cell.source.trim() && setEditing(true)} title={canEdit ? 'Double-click to edit' : undefined}>
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{cell.source || '*Empty text cell*'}</ReactMarkdown>
        </div>
      ))}

      {cell.type === 'input' && cell.input && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Input uiSize="sm" className="w-44" value={cell.input.label ?? ''} readOnly={!canEdit} onChange={(e) => onChange({ input: { ...cell.input!, label: e.target.value } })} placeholder="Label" aria-label="Label" />
          {cell.input.kind === 'select' ? (
            <Select uiSize="sm" value={cell.input.value} onChange={(e) => onChange({ input: { ...cell.input!, value: e.target.value } })} aria-label="Value" data-testid="input-value">{(cell.input.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}</Select>
          ) : (
            <Input uiSize="sm" type={cell.input.kind === 'number' ? 'number' : cell.input.kind === 'date' ? 'date' : 'text'} className="w-48 font-mono" value={cell.input.value} onChange={(e) => onChange({ input: { ...cell.input!, value: e.target.value } })} placeholder="value" aria-label="Value" data-testid="input-value" />
          )}
          {canEdit && <Select uiSize="sm" value={cell.input.kind} onChange={(e) => onChange({ input: { ...cell.input!, kind: e.target.value as 'text' } })} aria-label="Input kind"><option value="text">Text</option><option value="number">Number</option><option value="date">Date</option><option value="select">List</option></Select>}
          {canEdit && cell.input.kind === 'select' && <Input uiSize="sm" className="min-w-40 flex-1 font-mono" value={(cell.input.options ?? []).join(', ')} onChange={(e) => onChange({ input: { ...cell.input!, options: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) } })} placeholder="options, comma separated" aria-label="Options" />}
          <span className="text-zinc-600">Use as <code className="font-mono text-zinc-400">{`{{ ${cell.name} }}`}</code></span>
        </div>
      )}

      {cell.type === 'sql' && (
        <>
          <div className="overflow-hidden rounded-md border border-zinc-800" data-testid="cell-editor">
            {canEdit ? <SqlEditor autoHeight value={cell.source} onChange={stableChange} onRun={stableRun} schema={schema} placeholder="SELECT … — ⌘/Ctrl+Enter runs this cell" /> : <pre className="overflow-auto bg-zinc-950 p-2.5 font-mono text-[12.5px] text-zinc-200">{cell.source}</pre>}
          </div>
          {duplicateName && <p className="mt-1 text-xs text-red-300">Another cell above already has this name.</p>}
          {cell.output && <Output cell={cell} canEdit={canEdit} onChange={onChange} />}
        </>
      )}
    </section>
  );
}

function Output({ cell, onChange }: { cell: NotebookCell; canEdit: boolean; onChange: (p: Partial<NotebookCell>) => void }) {
  const o = cell.output!;
  if (o.error) return <pre className="mt-2 whitespace-pre-wrap rounded-md border border-red-900/60 bg-red-950/30 px-2.5 py-2 font-mono text-[12px] text-red-200" data-testid="cell-error">{o.error}</pre>;
  if (!o.columns.length) return <p className="mt-2 text-xs text-zinc-500">{o.rows_changed != null ? `${o.rows_changed} rows changed.` : 'Done.'}</p>;
  const view = cell.view ?? 'table';
  const chart: ChartConfig = cell.chart ?? { type: 'bar', x: o.columns[0]?.name, y: o.columns.filter((c) => c.kind === 'number').slice(0, 1).map((c) => c.name) };
  return (
    <div className="mt-2" data-testid="cell-output">
      <div className="mb-1 flex items-center gap-1 text-xs">
        <button onClick={() => onChange({ view: 'table' })} className={cn('inline-flex items-center gap-1 rounded px-1.5 py-0.5', view === 'table' ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-200')}><Table2 className="h-3 w-3" /> Table</button>
        <button onClick={() => onChange({ view: 'chart', chart })} className={cn('inline-flex items-center gap-1 rounded px-1.5 py-0.5', view === 'chart' ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-200')} data-testid="view-chart"><BarChart3 className="h-3 w-3" /> Chart</button>
        {o.truncated && <span className="ml-2 text-zinc-600">First {o.rows.length.toLocaleString()} of {o.row_count.toLocaleString()} rows kept</span>}
      </div>
      {view === 'table' ? (
        <div className="max-h-[360px] overflow-hidden rounded-md border border-zinc-800" style={{ height: Math.min(360, 34 + o.rows.length * 28) }}>
          <ResultsGrid columns={o.columns as never} rows={o.rows} />
        </div>
      ) : (
        <div className="h-[340px] overflow-hidden rounded-md border border-zinc-800">
          <ChartPanel columns={o.columns as never} rows={o.rows} config={chart} onChange={(c) => onChange({ chart: c })} />
        </div>
      )}
    </div>
  );
}
