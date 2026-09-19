import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Bot, Check, Pencil, RefreshCw, Save, Sparkles, Trash2, Wand2, X, PanelLeftClose, PanelLeft } from 'lucide-react';
import { api, type CatalogObject, type Dashboard, type JailEntry } from '../../api/client';
import { useWorkspace, useWorkspaceAccess } from '../../store/workspace';
import { useCopilot } from '../../store/copilot';
import { createMosaic } from '../../lib/mosaic';
import { analyzeColumns, resolveSource, templateSpec, type DataSource } from '../../lib/mosaic/analyze';
import { parseSpecText, specToText, type Spec } from '../../lib/mosaic/spec';
import { describeSpec } from '../../lib/mosaic/summary';
import { PageTitle } from '../../components/layout';
import { Badge, Button, Empty, Input, Label, Modal, Select, cn } from '../../components/ui';
import { MosaicSpecView, type SpecRenderStatus } from './MosaicSpecView';
import { SpecEditor } from './SpecEditor';

const STARTER = `# Mosaic dashboard — https://idl.uw.edu/mosaic/spec/
# Reference workspace tables directly (from: my_table) or define datasets below.
meta:
  title: My dashboard
data:
  trips:
    query: SELECT * FROM my_table
params:
  brush: { select: crossfilter }
vconcat:
  - plot:
      - mark: rectY
        data: { from: trips, filterBy: $brush }
        x: { bin: some_column }
        y: { count: null }
        fill: '#8b5cf6'
      - select: intervalX
        as: $brush
    xDomain: Fixed
    width: 640
    height: 200
  - input: table
    from: trips
    filterBy: $brush
    height: 300
`;

/**
 * A Mosaic dashboard: a declarative spec (YAML/JSON) rendered live against the workspace, with an editor for
 * members who can write, a generator that drafts a cross-filtered spec from any table or file, and plain viewing
 * for everyone else.
 */
export function MosaicDashboard({ id }: { id: string }) {
  const cp = useCopilot();
  const ws = useWorkspace();
  const { canEdit: canWrite } = useWorkspaceAccess();
  const [dash, setDash] = useState<Dashboard | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [edit, setEdit] = useState(false);
  const [format, setFormat] = useState<'yaml' | 'json'>('yaml');
  const [text, setText] = useState('');
  const [draft, setDraft] = useState<Spec | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [render, setRender] = useState<SpecRenderStatus>({ state: 'idle', error: null, sources: 0 });
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState('');
  const [nonce, setNonce] = useState(0);
  const [generator, setGenerator] = useState(false);
  const debounce = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ dashboard: Dashboard }>(`/api/dashboards/${id}`);
      setDash(r.dashboard);
      setName(r.dashboard.name);
      const spec = r.dashboard.spec && Object.keys(r.dashboard.spec).length ? r.dashboard.spec : null;
      setDraft(spec);
      setText(spec ? specToText(spec, 'yaml') : STARTER);
      setParseError(null);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, [id]);
  useEffect(() => void load(), [load]);

  // Editing: parse on a short delay; a valid draft re-renders the preview, an invalid one keeps the last good render.
  const onText = (v: string) => {
    setText(v);
    if (debounce.current) window.clearTimeout(debounce.current);
    debounce.current = window.setTimeout(() => {
      try {
        setDraft(parseSpecText(v));
        setParseError(null);
      } catch (e) {
        setParseError((e as Error).message);
      }
    }, 600);
  };

  const dirty = useMemo(() => !!dash && JSON.stringify(draft ?? {}) !== JSON.stringify(dash.spec ?? {}), [dash, draft]);

  const save = useCallback(async () => {
    if (!dash) return;
    let spec: Spec;
    try {
      spec = parseSpecText(text);
      setParseError(null);
    } catch (e) {
      setParseError((e as Error).message);
      return;
    }
    setSaving(true);
    try {
      const r = await api.patch<{ dashboard: Dashboard }>(`/api/dashboards/${dash.id}`, { spec });
      setDash(r.dashboard);
      setDraft(spec);
      setSavedAt(Date.now());
    } catch (e) {
      setParseError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }, [dash, text]);

  const switchFormat = (f: 'yaml' | 'json') => {
    if (f === format) return;
    try {
      const spec = parseSpecText(text);
      setText(specToText(spec, f));
      setParseError(null);
    } catch (e) {
      setParseError((e as Error).message);
      return;
    }
    setFormat(f);
  };

  const applyGenerated = (spec: Spec) => {
    setText(specToText(spec, format));
    setDraft(spec);
    setParseError(null);
    setGenerator(false);
    setEdit(true);
  };

  if (loadError) return <div className="m-6 rounded-lg border border-red-900 bg-red-950/40 p-4 text-xs text-red-200">{loadError}</div>;
  if (!dash) return <div className="p-6 text-xs text-zinc-500">Loading…</div>;
  const info = describeSpec(draft);
  const empty = !draft || Object.keys(draft).length === 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-end justify-between gap-3 px-5 pt-5 pb-3">
        <div className="min-w-0">
          <a href="#/dashboards" className="mb-1 inline-flex items-center gap-1 text-[11px] text-zinc-500 hover:text-zinc-200"><ArrowLeft className="h-3 w-3" /> All dashboards</a>
          {renaming ? (
            <form className="flex items-center gap-2" onSubmit={async (e) => { e.preventDefault(); await api.patch(`/api/dashboards/${id}`, { name }); setRenaming(false); await load(); }}>
              <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} className="h-9 w-72 text-lg font-semibold" />
              <Button size="sm" variant="primary" type="submit"><Check className="h-3.5 w-3.5" /></Button>
            </form>
          ) : (
            <PageTitle className="flex items-center gap-2">
              {dash.name}
              <Badge tone="violet" className="gap-1"><Sparkles className="h-3 w-3" /> Mosaic</Badge>
              {canWrite && <button onClick={() => setRenaming(true)} className="text-zinc-500 hover:text-zinc-200" title="Rename"><Pencil className="h-4 w-4" /></button>}
            </PageTitle>
          )}
          <p className="mt-0.5 text-xs text-zinc-500">
            {dash.description || info.title || 'Interactive, cross-filtered charts from a declarative spec.'}
            {!empty && <span className="text-zinc-600"> · {info.plots} plot{info.plots === 1 ? '' : 's'}{info.inputs ? ` · ${info.inputs} input${info.inputs === 1 ? '' : 's'}` : ''}{info.datasets ? ` · ${info.datasets} dataset${info.datasets === 1 ? '' : 's'}` : ''}</span>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={() => setNonce((n) => n + 1)} title="Re-render"><RefreshCw className="h-3.5 w-3.5" /> Refresh</Button>
          <Button size="sm" variant="ghost" onClick={() => cp.toggle()} title="DuckCopilot"><Bot className="h-3.5 w-3.5" /></Button>
          {canWrite && (
            <>
              <Button size="sm" variant="secondary" onClick={() => setGenerator(true)} title="Draft a spec from a table or file"><Wand2 className="h-3.5 w-3.5" /> Generate</Button>
              <Button size="sm" variant={edit ? 'primary' : 'secondary'} onClick={() => setEdit(!edit)} title={edit ? 'Hide the editor' : 'Edit the spec'}>{edit ? <PanelLeftClose className="h-3.5 w-3.5" /> : <PanelLeft className="h-3.5 w-3.5" />} {edit ? 'Editing' : 'Edit'}</Button>
              <Button size="sm" variant="primary" disabled={!dirty || saving} loading={saving} onClick={() => void save()} title="Save the spec (⌘S)"><Save className="h-3.5 w-3.5" /> Save</Button>
              <Button size="sm" variant="danger" onClick={async () => { if (confirm(`Delete dashboard "${dash.name}"?`)) { await api.del(`/api/dashboards/${id}`); location.hash = '#/dashboards'; } }} title="Delete dashboard"><Trash2 className="h-3.5 w-3.5" /></Button>
            </>
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 gap-0 border-t border-zinc-800">
        {edit && canWrite && (
          <div className="flex w-[42%] min-w-[320px] max-w-[720px] shrink-0 flex-col border-r border-zinc-800">
            <div className="flex h-8 shrink-0 items-center gap-2 border-b border-zinc-800 px-2 text-[11px] text-zinc-400">
              <span className="font-semibold text-zinc-300">Spec</span>
              <div className="ml-1 flex overflow-hidden rounded border border-zinc-800">
                {(['yaml', 'json'] as const).map((f) => (
                  <button key={f} onClick={() => switchFormat(f)} className={cn('px-2 py-0.5 font-mono uppercase', format === f ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-200')}>{f}</button>
                ))}
              </div>
              <a href="https://idl.uw.edu/mosaic/spec/" target="_blank" rel="noreferrer" className="text-zinc-500 hover:text-accent-300">spec reference ↗</a>
              <span className="ml-auto">
                {parseError ? <span className="text-red-300">✗ {parseError.split('\n')[0]}</span> : render.state === 'error' ? <span className="text-amber-300">render failed</span> : dirty ? <span className="text-amber-300">unsaved changes</span> : savedAt ? <span className="text-emerald-300">saved</span> : null}
              </span>
            </div>
            <div className="min-h-0 flex-1 overflow-hidden">
              <SpecEditor value={text} format={format} onChange={onText} onSave={save} />
            </div>
          </div>
        )}
        <div className="min-h-0 min-w-0 flex-1 overflow-auto">
          {empty ? (
            <div className="p-8">
              <Empty icon={<Sparkles className="h-10 w-10" />} title="No spec yet" hint={canWrite ? 'Generate a starting point from a table or file, or write a Mosaic spec in the editor.' : 'This dashboard has no content yet.'} />
              {canWrite && <div className="mt-4 flex justify-center gap-2"><Button variant="primary" onClick={() => setGenerator(true)}><Wand2 className="h-4 w-4" /> Generate from dataset</Button><Button variant="secondary" onClick={() => { setEdit(true); }}><Pencil className="h-4 w-4" /> Write a spec</Button></div>}
            </div>
          ) : (
            <MosaicSpecView workspaceId={dash.workspace_id} spec={draft} nonce={nonce} onStatus={setRender} className="min-h-full" />
          )}
        </div>
      </div>

      <GeneratorModal open={generator} onClose={() => setGenerator(false)} workspaceId={dash.workspace_id} activeCatalog={ws.activeId === dash.workspace_id ? ws.catalog : null} onGenerate={applyGenerated} title={dash.name} />
    </div>
  );
}

/** Picks a table, file or SQL and drafts a cross-filtered spec from its columns. */
function GeneratorModal({ open, onClose, workspaceId, activeCatalog, onGenerate, title }: { open: boolean; onClose: () => void; workspaceId: string; activeCatalog: { objects: CatalogObject[]; files: JailEntry[] } | null; onGenerate: (spec: Spec) => void; title: string }) {
  const [catalog, setCatalog] = useState<{ objects: CatalogObject[]; files: JailEntry[] } | null>(activeCatalog);
  const [kind, setKind] = useState<DataSource['kind']>('table');
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    if (activeCatalog) setCatalog(activeCatalog);
    else api.get<{ objects: CatalogObject[]; files: JailEntry[] }>(`/api/workspaces/${workspaceId}/catalog`).then(setCatalog).catch((e) => setError((e as Error).message));
  }, [open, workspaceId, activeCatalog]);

  const tables = useMemo(() => (catalog?.objects ?? []).map((o) => (o.schema && o.schema !== 'main' ? `${o.schema}.${o.name}` : o.name)), [catalog]);
  const files = catalog?.files ?? [];
  useEffect(() => {
    if (!open) return;
    if (kind === 'table' && !tables.includes(target)) setTarget(tables[0] ?? '');
    if (kind === 'file' && !files.some((f) => f.path === target)) setTarget(files[0]?.path ?? '');
    if (kind === 'query' && (tables.includes(target) || files.some((f) => f.path === target))) setTarget('');
  }, [open, kind, tables, files]); // eslint-disable-line react-hooks/exhaustive-deps

  const generate = async () => {
    if (!target.trim()) return;
    setBusy(true);
    setError(null);
    const source: DataSource = { kind, target: target.trim(), label: kind === 'query' ? title : target.trim() };
    let handle: Awaited<ReturnType<typeof createMosaic>> | null = null;
    try {
      handle = await createMosaic(workspaceId);
      const ref = await resolveSource(handle, source);
      const columns = await analyzeColumns(handle, ref);
      const charted = columns.filter((c) => c.role !== 'skip');
      if (!charted.length) throw new Error('No numeric, temporal or low-cardinality text columns to chart.');
      onGenerate(templateSpec(source, columns, { title }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      handle?.dispose();
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Generate a dashboard from a dataset" width="max-w-xl">
      <div className="space-y-3">
        <p className="text-xs text-zinc-500">Every numeric or temporal column becomes a histogram, every low-cardinality text column a bar chart, all cross-filtered, with the filtered rows underneath. The result is a plain spec you can edit.</p>
        <div className="flex gap-1 rounded-md border border-zinc-800 p-0.5">
          {([['table', 'Table'], ['file', 'File'], ['query', 'SQL']] as const).map(([k, label]) => (
            <button key={k} onClick={() => setKind(k)} className={cn('flex-1 rounded px-2 py-1 text-xs', kind === k ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200')}>{label}</button>
          ))}
        </div>
        {kind === 'table' && (
          <div><Label>Table or view</Label>{tables.length ? <Select value={target} onChange={(e) => setTarget(e.target.value)} className="w-full">{tables.map((t) => <option key={t} value={t}>{t}</option>)}</Select> : <p className="text-xs text-zinc-500">No tables in this workspace yet.</p>}</div>
        )}
        {kind === 'file' && (
          <div><Label>Data file</Label>{files.length ? <Select value={target} onChange={(e) => setTarget(e.target.value)} className="w-full">{files.map((f) => <option key={f.path} value={f.path}>{f.path}</option>)}</Select> : <p className="text-xs text-zinc-500">No data files in this workspace yet.</p>}</div>
        )}
        {kind === 'query' && (
          <div><Label>SELECT</Label><textarea value={target} onChange={(e) => setTarget(e.target.value)} rows={5} spellCheck={false} placeholder="SELECT * FROM trips WHERE fare > 0" className="w-full rounded-md border border-zinc-700 bg-zinc-900 p-2 font-mono text-xs text-zinc-100 focus:border-accent-500 focus:outline-none" /></div>
        )}
        {error && <div className="rounded-md border border-red-900 bg-red-950/50 px-3 py-2 font-mono text-xs text-red-200">{error}</div>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}><X className="h-3.5 w-3.5" /> Cancel</Button>
          <Button variant="primary" disabled={!target.trim() || busy} loading={busy} onClick={() => void generate()}><Wand2 className="h-3.5 w-3.5" /> Generate</Button>
        </div>
      </div>
    </Modal>
  );
}
