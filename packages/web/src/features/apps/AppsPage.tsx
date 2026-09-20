import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { EditorView, keymap } from '@codemirror/view';
import { Prec } from '@codemirror/state';
import { python } from '@codemirror/lang-python';
import { oneDark } from '@codemirror/theme-one-dark';
import { AppWindow, Plus, Play, Square, RotateCw, ExternalLink, Save, Trash2, ScrollText, Loader2, ChevronLeft, Bot } from 'lucide-react';
import { api, timeAgo, type DataApp, type AppTemplate, type AppStatus } from '../../api/client';
import { useWorkspace, useWorkspaceAccess } from '../../store/workspace';
import { useTheme } from '../../store/theme';
import { useCopilot } from '../../store/copilot';
import { subscribeLiveEvents } from '../../lib/liveEvents';
import { Eyebrow, PageTitle } from '../../components/layout';
import { Badge, Button, Empty, Input, Label, Modal, Select, cn } from '../../components/ui';

/** #/apps — the gallery of a workspace's Streamlit apps; #/apps/<id> — the editor with a live preview. */
export function AppsPage() {
  const [appId, setAppId] = useState<string | null>(/^#\/apps\/([^/?]+)/.exec(location.hash)?.[1] ?? null);
  useEffect(() => {
    const on = () => setAppId(/^#\/apps\/([^/?]+)/.exec(location.hash)?.[1] ?? null);
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return appId ? <AppEditor id={appId} /> : <Gallery />;
}

const STATUS_TONE: Record<AppStatus, 'zinc' | 'green' | 'amber' | 'red' | 'blue'> = { stopped: 'zinc', installing: 'amber', starting: 'amber', running: 'green', error: 'red' };

function Gallery() {
  const ws = useWorkspace();
  const wsId = ws.activeId;
  const { canEdit } = useWorkspaceAccess();
  const [apps, setApps] = useState<DataApp[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [templates, setTemplates] = useState<AppTemplate[]>([]);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: '', description: '', template: 'explorer' });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (!wsId) return;
    const r = await api.get<{ apps: DataApp[]; enabled: boolean }>(`/api/workspaces/${wsId}/apps`);
    setApps(r.apps);
    setEnabled(r.enabled);
  }, [wsId]);
  useEffect(() => void load().catch((e) => setError((e as Error).message)), [load]);
  useEffect(() => void api.get<{ templates: AppTemplate[] }>('/api/apps/templates').then((r) => setTemplates(r.templates)).catch(() => undefined), []);
  useEffect(() => subscribeLiveEvents((e) => { if (e.type === 'app' && e.workspace_id === wsId) void load().catch(() => undefined); }), [wsId, load]);

  const create = async () => {
    if (!wsId) return;
    setBusy('create');
    setError(null);
    try {
      const t = templates.find((x) => x.id === form.template);
      const r = await api.post<{ app: DataApp }>(`/api/workspaces/${wsId}/apps`, { name: form.name.trim() || t?.label || 'My app', description: form.description.trim() || null, files: t?.files, spec: { template: form.template } });
      setCreating(false);
      location.hash = `#/apps/${r.app.id}`;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const openInTab = async (a: DataApp) => {
    await api.post(`/api/apps/${a.id}/session`, {});
    window.open(a.url, '_blank', 'noopener');
  };

  return (
    <div className="h-full min-h-0 overflow-auto">
      <div className="mx-auto max-w-7xl space-y-5 p-5 pb-16">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <Eyebrow>Build</Eyebrow>
            <PageTitle>Data apps</PageTitle>
            <p className="mt-1 text-xs text-zinc-500">Streamlit apps written on <b className="text-zinc-300">{ws.workspaces.find((w) => w.id === wsId)?.name ?? 'the active workspace'}</b>'s tables and files — run by DuckView next to the engine, reached through <code className="font-mono">duckview.connect()</code> with a read-only token, shared with the workspace's members.</p>
          </div>
          <Button variant="primary" disabled={!wsId || !canEdit || !enabled} onClick={() => { setForm({ name: '', description: '', template: 'explorer' }); setCreating(true); }}><Plus className="h-4 w-4" /> New app</Button>
        </div>
        {!enabled && <div className="rounded-lg border border-amber-900/60 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">Data apps are disabled on this server (<code className="font-mono">apps.enabled</code>). Apps run Python next to DuckView; an administrator turns them on in the configuration.</div>}
        {error && <div className="rounded-md border border-red-900 bg-red-950/50 px-3 py-2 font-mono text-xs text-red-200">{error}</div>}
        {apps.length === 0 ? (
          <div className="rounded-xl border border-dashed border-zinc-800 py-14"><Empty icon={<AppWindow className="h-10 w-10" />} title="No apps yet" hint="Start from the table explorer template, or a blank app: pick tables, filters and charts in Python; DuckView runs it and serves it to the workspace." />{canEdit && enabled && <div className="mt-3 flex justify-center"><Button variant="primary" onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> New app</Button></div>}</div>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {apps.map((a) => (
              <div key={a.id} className="group flex flex-col rounded-xl border border-zinc-800 p-4 hover:border-zinc-700">
                <div className="flex items-center gap-2">
                  <AppWindow className="h-4 w-4 text-accent-300" />
                  <a href={`#/apps/${a.id}`} className="truncate text-sm font-semibold text-zinc-100 hover:underline">{a.name}</a>
                  <Badge tone={STATUS_TONE[a.status]} className="ml-auto">{a.status}</Badge>
                </div>
                <p className="mt-1 line-clamp-2 min-h-[2rem] text-[11px] text-zinc-500">{a.description || `${a.entry} · ${(a.source_bytes / 1024).toFixed(1)} KB`}</p>
                <div className="mt-2 text-[10.5px] text-zinc-600">{a.last_started_at ? `started ${timeAgo(a.last_started_at)}` : 'never started'}{a.visibility === 'org' ? ' · everyone' : ' · workspace'}{a.last_error ? <span className="text-red-300"> · {a.last_error}</span> : null}</div>
                <div className="mt-3 flex items-center gap-1">
                  <Button size="sm" variant="secondary" onClick={() => void openInTab(a)} title="Open the app in a new tab"><ExternalLink className="h-3.5 w-3.5" /> Open</Button>
                  <Button size="sm" variant="ghost" onClick={() => (location.hash = `#/apps/${a.id}`)} title="Edit and preview">Edit</Button>
                  {a.status === 'running' || a.status === 'starting' ? (
                    <Button size="sm" variant="ghost" loading={busy === a.id} onClick={async () => { setBusy(a.id); try { await api.post(`/api/apps/${a.id}/stop`, {}); } finally { setBusy(null); await load(); } }} title="Stop"><Square className="h-3.5 w-3.5" /></Button>
                  ) : (
                    <Button size="sm" variant="ghost" loading={busy === a.id} disabled={!enabled} onClick={async () => { setBusy(a.id); setError(null); try { await api.post(`/api/apps/${a.id}/start`, {}); } catch (e) { setError((e as Error).message); } finally { setBusy(null); await load(); } }} title="Start"><Play className="h-3.5 w-3.5" /></Button>
                  )}
                  <Button size="sm" variant="ghost" className="ml-auto text-red-300" disabled={!canEdit} onClick={async () => { if (confirm(`Delete "${a.name}"?`)) { await api.del(`/api/apps/${a.id}`); await load(); } }} title="Delete"><Trash2 className="h-3.5 w-3.5" /></Button>
                </div>
              </div>
            ))}
          </div>
        )}
        <Modal open={creating} onClose={() => setCreating(false)} title="New data app" width="max-w-lg">
          <div className="space-y-3">
            <div><Label>Name</Label><Input autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Sales explorer" /></div>
            <div><Label>Description <span className="normal-case text-zinc-600">(optional)</span></Label><Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="What the app shows and for whom" /></div>
            <div>
              <Label>Start from</Label>
              <div className="grid gap-2 md:grid-cols-2">
                {templates.map((t) => (
                  <button key={t.id} type="button" onClick={() => setForm({ ...form, template: t.id })} className={cn('rounded-lg border p-3 text-left', form.template === t.id ? 'border-accent-500 bg-accent-600/10' : 'border-zinc-800 hover:border-zinc-600')}>
                    <div className="text-sm text-zinc-100">{t.label}</div>
                    <div className="mt-1 text-[11px] text-zinc-500">{t.blurb}</div>
                  </button>
                ))}
              </div>
            </div>
            <p className="text-[11px] text-zinc-500">The first start creates a Python environment with Streamlit, pandas, pyarrow and the DuckView SDK next to the data directory — it takes a minute once.</p>
            {error && <div className="rounded-md border border-red-900 bg-red-950/50 px-3 py-2 font-mono text-xs text-red-200">{error}</div>}
            <div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => setCreating(false)}>Cancel</Button><Button variant="primary" loading={busy === 'create'} onClick={() => void create()}><Plus className="h-4 w-4" /> Create & open</Button></div>
          </div>
        </Modal>
      </div>
    </div>
  );
}

function AppEditor({ id }: { id: string }) {
  const kind = useTheme((t) => t.theme.kind);
  const cp = useCopilot();
  const { canEdit } = useWorkspaceAccess();
  const [app, setApp] = useState<DataApp | null>(null);
  const [files, setFiles] = useState<Record<string, string>>({});
  const [active, setActive] = useState('app.py');
  const [logs, setLogs] = useState<string[]>([]);
  const [showLogs, setShowLogs] = useState(false);
  const [busy, setBusy] = useState<'save' | 'start' | 'stop' | 'restart' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewKey, setPreviewKey] = useState(0);
  const dirty = useMemo(() => !!app && JSON.stringify(files) !== JSON.stringify(app.files), [files, app]);
  const filesRef = useRef(files);
  filesRef.current = files;

  const load = useCallback(async () => {
    const r = await api.get<{ app: DataApp; logs: string[] }>(`/api/apps/${id}`);
    setApp(r.app);
    setLogs(r.logs);
    return r.app;
  }, [id]);
  useEffect(() => {
    void load().then((a) => { setFiles(a.files); setActive(a.entry); }).catch((e) => setError((e as Error).message));
    // The preview iframe needs the /apps cookie.
    void api.post<{ url: string }>(`/api/apps/${id}/session`, {}).then((r) => setPreviewUrl(r.url)).catch(() => undefined);
  }, [id, load]);
  useEffect(() => subscribeLiveEvents((e) => { if (e.type === 'app' && e.app_id === id) void load().then((a) => { if (a.status === 'running') setPreviewKey((k) => k + 1); }).catch(() => undefined); }), [id, load]);
  // Logs refresh while something is happening.
  useEffect(() => {
    if (!app || !['installing', 'starting'].includes(app.status) && !showLogs) return;
    const t = setInterval(() => void api.get<{ logs: string[] }>(`/api/apps/${id}/logs`).then((r) => setLogs(r.logs)).catch(() => undefined), 2000);
    return () => clearInterval(t);
  }, [app?.status, showLogs, id]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = useCallback(async () => {
    setBusy('save');
    setError(null);
    try {
      const r = await api.patch<{ app: DataApp }>(`/api/apps/${id}`, { files: filesRef.current });
      setApp(r.app);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, [id]);
  const action = async (what: 'start' | 'stop' | 'restart') => {
    setBusy(what);
    setError(null);
    try {
      if (dirty && what !== 'stop') await save();
      await api.post(`/api/apps/${id}/${what}`, {});
      if (what !== 'stop') setPreviewKey((k) => k + 1);
    } catch (e) {
      setError((e as Error).message);
      setShowLogs(true);
    } finally {
      setBusy(null);
      await load().catch(() => undefined);
    }
  };
  const extensions = useMemo(() => [python(), EditorView.lineWrapping, Prec.highest(keymap.of([{ key: 'Mod-s', run: () => (void save(), true) }]))], [save]);
  const askCopilot = () => {
    if (!app) return;
    cp.toggle(true);
    void cp.send({ workspaceId: app.workspace_id, message: `I'm writing a Streamlit data app in DuckView (file ${active}). The app reads this workspace through the duckview SDK: \`from duckview.streamlit import connect, query, table_picker\` — \`query(sql)\` runs DuckDB SQL and returns a pandas DataFrame, \`table_picker(dv)\` is a selectbox over the tables. Suggest concrete improvements and give the full updated file in one \`\`\`python block.\n\n\`\`\`python\n${files[active] ?? ''}\n\`\`\`` });
  };

  if (!app) return <div className="p-5 text-xs text-zinc-500">{error ?? 'Loading…'}</div>;
  const status = app.status;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800 px-4 py-2">
        <a href="#/apps" className="text-zinc-500 hover:text-zinc-200" title="Back to the gallery"><ChevronLeft className="h-4 w-4" /></a>
        <AppWindow className="h-4 w-4 text-accent-300" />
        <span className="text-sm font-semibold text-zinc-100">{app.name}</span>
        <Badge tone={STATUS_TONE[status]}>{status}</Badge>
        {dirty && <Badge tone="amber">unsaved</Badge>}
        <span className="text-[11px] text-zinc-500">{app.last_started_at ? `started ${timeAgo(app.last_started_at)}` : 'never started'}{app.last_error ? <span className="text-red-300"> · {app.last_error}</span> : null}</span>
        <div className="ml-auto flex items-center gap-1">
          <Button size="sm" variant="ghost" onClick={askCopilot} title="Ask Copilot about this app"><Bot className="h-3.5 w-3.5" /></Button>
          <Button size="sm" variant="secondary" onClick={() => void save()} loading={busy === 'save'} disabled={!canEdit || !dirty} title="Save (⌘S) — a running app restarts"><Save className="h-3.5 w-3.5" /> Save</Button>
          {status === 'running' || status === 'starting' || status === 'installing' ? (
            <>
              <Button size="sm" variant="ghost" onClick={() => void action('restart')} loading={busy === 'restart'} title="Restart"><RotateCw className="h-3.5 w-3.5" /></Button>
              <Button size="sm" variant="ghost" onClick={() => void action('stop')} loading={busy === 'stop'} title="Stop"><Square className="h-3.5 w-3.5" /> Stop</Button>
            </>
          ) : (
            <Button size="sm" variant="primary" onClick={() => void action('start')} loading={busy === 'start'} title="Start"><Play className="h-3.5 w-3.5" /> Run</Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => { void api.post(`/api/apps/${id}/session`, {}).then(() => window.open(app.url, '_blank', 'noopener')); }} title="Open in a new tab"><ExternalLink className="h-3.5 w-3.5" /></Button>
          <Button size="sm" variant="ghost" onClick={() => setShowLogs((v) => !v)} title="Logs" className={showLogs ? 'text-accent-300' : ''}><ScrollText className="h-3.5 w-3.5" /></Button>
        </div>
      </div>
      {error && <div className="border-b border-red-900/60 bg-red-950/40 px-4 py-1.5 font-mono text-[11px] text-red-200">{error}</div>}
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <div className="flex min-h-0 flex-col border-r border-zinc-800">
          <div className="flex items-center gap-1 border-b border-zinc-800 px-2 py-1 text-[11px]">
            {Object.keys(files).map((f) => <button key={f} onClick={() => setActive(f)} className={cn('rounded px-2 py-0.5 font-mono', active === f ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200')}>{f}</button>)}
            <span className="ml-auto text-zinc-600">Python · ⌘S saves and restarts</span>
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            <CodeMirror value={files[active] ?? ''} height="100%" theme={kind === 'dark' ? oneDark : 'light'} extensions={extensions} onChange={(v) => setFiles((f) => ({ ...f, [active]: v }))} editable={canEdit} basicSetup={{ lineNumbers: true, foldGutter: true, highlightActiveLine: true, autocompletion: false }} className="h-full text-[12.5px]" />
          </div>
        </div>
        <div className="flex min-h-0 flex-col">
          <div className="relative min-h-0 flex-1 bg-zinc-950">
            {previewUrl && (status === 'running' || status === 'starting' || status === 'installing') ? (
              <iframe key={previewKey} src={previewUrl} title={app.name} className="h-full w-full border-0 bg-white" allow="clipboard-write" />
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-xs text-zinc-500">
                <AppWindow className="h-10 w-10 text-zinc-700" />
                <div>{status === 'error' ? 'The app failed to start — see the logs.' : 'The app is not running.'}</div>
                <Button variant="primary" size="sm" onClick={() => void action('start')} loading={busy === 'start'}><Play className="h-3.5 w-3.5" /> Run the app</Button>
              </div>
            )}
            {(status === 'starting' || status === 'installing') && <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-center gap-2 bg-zinc-900/80 py-1 text-[11px] text-zinc-300"><Loader2 className="h-3 w-3 animate-spin" /> {status === 'installing' ? 'Preparing the Python environment (first run takes a minute)…' : 'Starting…'}</div>}
          </div>
          {showLogs && (
            <pre className="max-h-56 overflow-auto border-t border-zinc-800 bg-zinc-950 p-2 font-mono text-[10.5px] leading-snug text-zinc-400">{logs.length ? logs.join('\n') : 'No log lines yet.'}</pre>
          )}
        </div>
      </div>
    </div>
  );
}
