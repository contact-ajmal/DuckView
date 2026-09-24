import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { EditorView, keymap } from '@codemirror/view';
import { Prec } from '@codemirror/state';
import { python } from '@codemirror/lang-python';
import { oneDark } from '@codemirror/theme-one-dark';
import { AppWindow, Plus, Play, Square, RotateCw, ExternalLink, Save, Trash2, ScrollText, Loader2, ChevronLeft, Bot, Wand2, CheckCircle2, LayoutDashboard, FileCode2, Globe, Users, Pin, Monitor, Server } from 'lucide-react';
import { api, appLaunchUrl, openAppInTab, copilotChat, timeAgo, APP_KIND_LABEL, type DataApp, type AppTemplate, type AppStatus, type Dashboard, type SavedQuery } from '../../api/client';
import { useAuth } from '../../store/auth';
import { useWorkspace, useWorkspaceAccess } from '../../store/workspace';
import { useTheme } from '../../store/theme';
import { useCopilot } from '../../store/copilot';
import { subscribeLiveEvents } from '../../lib/liveEvents';
import { PageHeader } from '../../components/layout';
import { Badge, Button, Empty, IconButton, Input, Label, Modal, Select, StatusDot, cn, confirmAction, InlineError } from '../../components/ui';
import { DataTable } from '../../components/data';
import { usePageObject } from '../../store/context';

/** #/apps — the gallery of a workspace's Streamlit apps; #/apps/<id> — the editor with a live preview. */
export function AppsPage() {
  const [appId, setAppId] = useState<string | null>(/^#\/apps\/([^/?]+)/.exec(location.hash)?.[1] ?? null);
  useEffect(() => {
    const on = () => setAppId(/^#\/apps\/([^/?]+)/.exec(location.hash)?.[1] ?? null);
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  // #/apps/<id>?launch=1: where the apps origin sends a visitor without its cookie — hand over and go back.
  const [launchError, setLaunchError] = useState<string | null>(null);
  const launching = !!appId && /[?&]launch=1\b/.test(location.hash);
  useEffect(() => {
    if (!launching || !appId) return;
    void appLaunchUrl(appId).then((url) => location.replace(url)).catch((e) => setLaunchError((e as Error).message));
  }, [launching, appId]);
  if (launching) return <div className="flex h-full items-center justify-center gap-2 text-xs text-zinc-400">{launchError ? <span className="text-red-300">{launchError}</span> : <><Loader2 className="h-4 w-4 animate-spin" /> Opening the app…</>}</div>;
  return appId ? <AppEditor id={appId} /> : <Gallery />;
}

const STATUS_TONE: Record<AppStatus, 'zinc' | 'green' | 'amber' | 'red' | 'blue'> = { stopped: 'zinc', installing: 'amber', starting: 'amber', running: 'green', error: 'red' };
const RUNTIME_LABEL = { subprocess: 'next to the server', docker: 'in its own container', kubernetes: 'in its own pod' } as const;

/** Who sees the app, with a pending or rejected request to publish it. */
function Audience({ app }: { app: DataApp }) {
  if (app.publish_status === 'pending') return <Badge tone="warn" className="gap-1"><Globe className="h-3 w-3" /> awaiting review</Badge>;
  if (app.visibility === 'org') return <span className="inline-flex items-center gap-1 text-zinc-400"><Globe className="h-3 w-3 text-zinc-500" /> everyone</span>;
  if (app.publish_status === 'rejected') return <Badge tone="error" className="gap-1"><Users className="h-3 w-3" /> not approved</Badge>;
  return <span className="inline-flex items-center gap-1 text-zinc-400"><Users className="h-3 w-3 text-zinc-500" /> workspace</span>;
}

function Gallery() {
  const ws = useWorkspace();
  const wsId = ws.activeId;
  const { canEdit } = useWorkspaceAccess();
  const [apps, setApps] = useState<DataApp[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [templates, setTemplates] = useState<AppTemplate[]>([]);
  const [runtime, setRuntime] = useState<keyof typeof RUNTIME_LABEL>('subprocess');
  const [browserOk, setBrowserOk] = useState(false);
  const [dashboards, setDashboards] = useState<Dashboard[]>([]);
  const [queries, setQueries] = useState<SavedQuery[]>([]);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<{ name: string; description: string; from: 'template' | 'dashboard' | 'queries'; template: string; dashboard: string; queryIds: string[]; execution: 'server' | 'browser' }>({ name: '', description: '', from: 'template', template: 'explorer', dashboard: '', queryIds: [], execution: 'server' });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (!wsId) return;
    const r = await api.get<{ apps: DataApp[]; enabled: boolean }>(`/api/workspaces/${wsId}/apps`);
    setApps(r.apps);
    setEnabled(r.enabled);
  }, [wsId]);
  useEffect(() => void load().catch((e) => setError((e as Error).message)), [load]);
  useEffect(() => void api.get<{ templates: AppTemplate[]; runtime: keyof typeof RUNTIME_LABEL; browser: boolean }>('/api/apps/templates').then((r) => { setTemplates(r.templates); setRuntime(r.runtime); setBrowserOk(r.browser); }).catch(() => undefined), []);
  useEffect(() => {
    if (!wsId || !creating) return;
    void api.get<{ dashboards: Dashboard[] }>(`/api/workspaces/${wsId}/dashboards`).then((r) => setDashboards(r.dashboards)).catch(() => setDashboards([]));
    void api.get<{ queries: SavedQuery[] }>(`/api/workspaces/${wsId}/queries`).then((r) => setQueries(r.queries)).catch(() => setQueries([]));
  }, [wsId, creating]);
  useEffect(() => subscribeLiveEvents((e) => { if (e.type === 'app' && e.workspace_id === wsId) void load().catch(() => undefined); }), [wsId, load]);

  const create = async () => {
    if (!wsId) return;
    setBusy('create');
    setError(null);
    try {
      const source = form.from === 'dashboard' ? { dashboard_id: form.dashboard } : form.from === 'queries' ? { saved_query_ids: form.queryIds } : { template: form.template };
      const r = await api.post<{ app: DataApp }>(`/api/workspaces/${wsId}/apps`, { name: form.name.trim(), description: form.description.trim() || null, source, execution: form.from === 'template' && templates.find((t) => t.id === form.template)?.kind !== 'streamlit' ? 'server' : form.execution });
      setCreating(false);
      location.hash = `#/apps/${r.app.id}`;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const openInTab = (a: DataApp) => openAppInTab(a.id).catch((e) => setError((e as Error).message));

  return (
    <div className="h-full min-h-0 overflow-auto">
      <div className="mx-auto max-w-[1180px] space-y-4 px-6 py-5 pb-16">
        <PageHeader
          title="Apps"
          description={`Streamlit, Dash and Gradio apps on ${ws.workspaces.find((w) => w.id === wsId)?.name ?? 'this workspace'}'s data, run ${RUNTIME_LABEL[runtime]} and shared with the workspace.`}
          actions={<Button variant="primary" disabled={!wsId || !canEdit || !enabled} onClick={() => { setForm({ name: '', description: '', from: 'template', template: 'explorer', dashboard: '', queryIds: [], execution: 'server' }); setCreating(true); }}><Plus className="h-3.5 w-3.5" /> New app</Button>}
        />
        {!enabled && <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-zinc-300">Data apps are turned off on this server (<code className="font-mono">apps.enabled</code>). They run Python next to DuckView; an administrator can turn them on.</div>}
        <InlineError error={error} />
        {apps.length === 0 ? (
          <div className="border-y border-zinc-800 py-14"><Empty icon={<AppWindow />} title="No apps yet" hint="Start from a template, a dashboard or saved queries; DuckView runs the app and serves it to the workspace." action={canEdit && enabled ? <Button size="sm" onClick={() => setCreating(true)}><Plus className="h-3.5 w-3.5" /> New app</Button> : undefined} /></div>
        ) : (
          <DataTable
            label="Data apps"
            testid="app-list"
            rows={apps}
            rowKey={(a) => a.id}
            rowProps={(a) => ({ 'data-app': a.name })}
            rowClassName={() => 'group hover:bg-zinc-900'}
            search={(a) => `${a.name} ${a.description ?? ''} ${a.kind} ${a.status}`}
            searchPlaceholder="Filter apps"
            columns={[
              { key: 'app', header: 'App', truncate: true, sortValue: (a) => a.name, cell: (a) => (
                <><a href={`#/apps/${a.id}`} className="block truncate font-medium text-zinc-100 hover:underline">{a.name}</a>
                      <div className="truncate text-xs text-zinc-500" title={a.last_error ?? a.description ?? ''}>{a.last_error ? <span className="text-red-400">{a.last_error}</span> : a.description || `${a.entry} · ${(a.source_bytes / 1024).toFixed(1)} KB`}</div></>
              ) },
              { key: 'status', header: 'Status', width: 'w-28', sortValue: (a) => a.status, cell: (a) => {
                const status = a.execution === 'browser' && a.status === 'running' ? 'ready' : a.status;
                const tone = a.status === 'running' ? 'ok' : a.status === 'error' ? 'error' : a.status === 'starting' || a.status === 'installing' ? 'busy' : 'idle';
                return <StatusDot tone={tone} pulse={tone === 'busy'}>{status}</StatusDot>;
              } },
              { key: 'runs', header: 'Runs', width: 'w-40', responsive: '@max-3xl:hidden', cell: (a) => (
                <div className="text-xs text-zinc-400"><span className="inline-flex items-center gap-1.5">
                        {a.execution === 'browser' ? <Monitor className="h-3.5 w-3.5 text-zinc-500" /> : <Server className="h-3.5 w-3.5 text-zinc-500" />}
                        {APP_KIND_LABEL[a.kind]} · {a.execution === 'browser' ? 'browser' : 'server'}
                        {a.always_on && <Pin className="h-3 w-3 text-zinc-500" aria-label="always on" />}
                      </span></div>
              ) },
              { key: 'audience', header: 'Shared with', width: 'w-28', responsive: '@max-4xl:hidden', cell: (a) => <div className="text-xs"><Audience app={a} /></div> },
              { key: 'started', header: 'Last started', width: 'w-28', responsive: '@max-2xl:hidden', sortValue: (a) => a.last_started_at ?? '', cell: (a) => <span className="text-xs text-zinc-500">{a.execution === 'browser' ? '—' : a.last_started_at ? timeAgo(a.last_started_at) : 'never'}</span> },
              { key: 'actions', header: <span className="sr-only">Actions</span>, width: 'w-44', cell: (a) => (
                <div className="flex items-center justify-end gap-0.5">
                        <Button size="sm" variant="ghost" onClick={() => void openInTab(a)} title="Open the app in a new tab"><ExternalLink className="h-3.5 w-3.5" /> Open</Button>
                        <Button size="sm" variant="ghost" onClick={() => (location.hash = `#/apps/${a.id}`)} title="Edit and preview">Edit</Button>
                        {a.execution === 'browser' ? null : a.status === 'running' || a.status === 'starting' ? (
                          <IconButton label="Stop" disabled={busy === a.id} onClick={async () => { setBusy(a.id); try { await api.post(`/api/apps/${a.id}/stop`, {}); } finally { setBusy(null); await load(); } }}><Square className="h-3.5 w-3.5" /></IconButton>
                        ) : (
                          <IconButton label="Start" disabled={busy === a.id || !enabled} onClick={async () => { setBusy(a.id); setError(null); try { await api.post(`/api/apps/${a.id}/start`, {}); } catch (e) { setError((e as Error).message); } finally { setBusy(null); await load(); } }}><Play className="h-3.5 w-3.5" /></IconButton>
                        )}
                        <IconButton label="Delete" className="opacity-0 hover:text-red-400 group-hover:opacity-100" disabled={!canEdit} onClick={async () => { if ((await confirmAction(`Delete "${a.name}"?`))) { await api.del(`/api/apps/${a.id}`); await load(); } }}><Trash2 className="h-3.5 w-3.5" /></IconButton>
                      </div>
              ) },
            ]}
          />
        )}
        <Modal open={creating} onClose={() => setCreating(false)} title="New data app" width="max-w-lg">
          <div className="space-y-3">
            <div><Label>Name</Label><Input autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Sales explorer" /></div>
            <div><Label>Description <span className="normal-case text-zinc-500">(optional)</span></Label><Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="What the app shows and for whom" /></div>
            <div>
              <Label>Start from</Label>
              <div className="mb-2 grid grid-cols-3 gap-1 rounded-md border border-zinc-800 p-0.5 text-xs">
                {([['template', 'A template', <FileCode2 key="t" className="h-3.5 w-3.5" />], ['dashboard', 'A dashboard', <LayoutDashboard key="d" className="h-3.5 w-3.5" />], ['queries', 'Saved queries', <FileCode2 key="q" className="h-3.5 w-3.5" />]] as const).map(([id, label, icon]) => (
                  <button key={id} type="button" onClick={() => setForm({ ...form, from: id })} className={cn('flex items-center justify-center gap-1 rounded px-2 py-1', form.from === id ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200')}>{icon} {label}</button>
                ))}
              </div>
              {form.from === 'template' && (
                <div className="grid gap-2 md:grid-cols-2">
                  {templates.map((t) => (
                    <button key={t.id} type="button" onClick={() => setForm({ ...form, template: t.id })} className={cn('rounded-lg border p-3 text-left', form.template === t.id ? 'border-accent-500 bg-accent-600/10' : 'border-zinc-800 hover:border-zinc-600')}>
                      <div className="flex items-center gap-1.5 text-body text-zinc-100">{t.label}<Badge className="ml-auto">{APP_KIND_LABEL[t.kind]}</Badge></div>
                      <div className="mt-1 text-2xs text-zinc-500">{t.blurb}</div>
                    </button>
                  ))}
                </div>
              )}
              {form.from === 'dashboard' && (
                <div>
                  <Select value={form.dashboard} onChange={(e) => setForm({ ...form, dashboard: e.target.value })} className="w-full">
                    <option value="">{dashboards.length ? 'Pick a dashboard…' : 'No dashboards in this workspace yet'}</option>
                    {dashboards.map((d) => <option key={d.id} value={d.id}>{d.name} · {d.kind === 'mosaic' ? 'Mosaic' : 'grid'}</option>)}
                  </Select>
                  <p className="mt-1 text-2xs text-zinc-500">A Mosaic dashboard becomes filters, KPIs, charts and tables computed in SQL; a grid dashboard becomes one section per widget. No model involved — the code is yours to edit.</p>
                </div>
              )}
              {form.from === 'queries' && (
                <div className="max-h-40 space-y-1 overflow-auto rounded-md border border-zinc-800 p-2 text-xs">
                  {queries.length === 0 && <div className="text-zinc-500">No saved queries in this workspace yet.</div>}
                  {queries.map((q) => (
                    <label key={q.id} className="flex cursor-pointer items-center gap-2 text-zinc-300"><input type="checkbox" className="accent-accent-500" checked={form.queryIds.includes(q.id)} onChange={(e) => setForm({ ...form, queryIds: e.target.checked ? [...form.queryIds, q.id] : form.queryIds.filter((x) => x !== q.id) })} /> <span className="font-medium">{q.name}</span><span className="truncate font-mono text-2xs text-zinc-500">{q.sql_text.slice(0, 80)}</span></label>
                  ))}
                </div>
              )}
            </div>
            {browserOk && (form.from !== 'template' || templates.find((t) => t.id === form.template)?.kind === 'streamlit') && (
              <div>
                <Label>Runs</Label>
                <div className="grid grid-cols-2 gap-2">
                  {([['server', <Server key="s" className="h-4 w-4" />, 'On the server', `A Python process ${RUNTIME_LABEL[runtime]}; any package, reads with the app's own token.`], ['browser', <Monitor key="b" className="h-4 w-4" />, "In the viewer's browser", 'stlite (Pyodide): nothing runs on the server; reads with each viewer\'s own access. Pure-Python packages only.']] as const).map(([id, icon, label, hint]) => (
                    <button key={id} type="button" onClick={() => setForm({ ...form, execution: id })} className={cn('rounded-lg border p-2.5 text-left', form.execution === id ? 'border-accent-500 bg-accent-600/10' : 'border-zinc-800 hover:border-zinc-600')}>
                      <span className="flex items-center gap-1.5 text-xs text-zinc-100"><span className="text-accent-300">{icon}</span>{label}</span>
                      <span className="mt-1 block text-2xs text-zinc-500">{hint}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {form.execution === 'server' && <p className="text-2xs text-zinc-500">{runtime === 'subprocess' ? 'The first start creates a Python environment with Streamlit, pandas, pyarrow and the DuckView SDK next to the data directory — it takes a minute once.' : `Each app runs ${RUNTIME_LABEL[runtime]} from the DuckView app-runtime image (Streamlit, pandas, pyarrow and the SDK); the first start may pull the image.`}</p>}
            {error && <div className="rounded-md border border-red-900 bg-red-950/50 px-3 py-2 font-mono text-xs text-red-200">{error}</div>}
            <div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => setCreating(false)}>Cancel</Button><Button variant="primary" loading={busy === 'create'} disabled={(form.from === 'dashboard' && !form.dashboard) || (form.from === 'queries' && !form.queryIds.length)} onClick={() => void create()}><Plus className="h-4 w-4" /> Create & open</Button></div>
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
  const isAdmin = useAuth((a) => a.user?.role === 'ADMIN');
  const [app, setApp] = useState<DataApp | null>(null);
  usePageObject(app ? { kind: 'app', id: app.id, label: app.name } : null);
  const [publishing, setPublishing] = useState(false);
  const [files, setFiles] = useState<Record<string, string>>({});
  const [active, setActive] = useState('app.py');
  const [logs, setLogs] = useState<string[]>([]);
  const [showLogs, setShowLogs] = useState(false);
  const [busy, setBusy] = useState<'save' | 'start' | 'stop' | 'restart' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewKey, setPreviewKey] = useState(0);
  const [check, setCheck] = useState<{ ok: boolean; errors: string[]; warnings: string[] } | null>(null);
  const [drafting, setDrafting] = useState(false);
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
  }, [id, load]);
  // The preview iframe opens through a fresh one-time link whenever it (re)mounts: apps live on their own origin.
  const previewing = app?.status === 'running' || app?.status === 'starting' || app?.status === 'installing';
  useEffect(() => {
    if (!previewing) return;
    let cancelled = false;
    void appLaunchUrl(id).then((url) => { if (!cancelled) setPreviewUrl(url); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [id, previewKey, previewing]);
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
      if (r.app.execution === 'browser') setPreviewKey((k) => k + 1); // no server restart: the preview reloads the new code
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
    void cp.send({ workspaceId: app.workspace_id, message: app.kind === 'streamlit' ? `I'm writing a Streamlit data app in DuckView (file ${active}). The app reads this workspace through the duckview SDK: \`from duckview.streamlit import connect, query, table_picker\` — \`query(sql)\` runs DuckDB SQL and returns a pandas DataFrame, \`table_picker(dv)\` is a selectbox over the tables. Suggest concrete improvements and give the full updated file in one \`\`\`python block.\n\n\`\`\`python\n${files[active] ?? ''}\n\`\`\`` : `I'm writing a ${APP_KIND_LABEL[app.kind]} data app in DuckView (file ${active}). It reads this workspace through the duckview SDK: \`dv = duckview.connect()\`, \`dv.query(sql)\` runs DuckDB SQL and returns a pandas DataFrame, \`duckview.viewer_from_headers(headers)\` names the viewer. DuckView sets the host, port and base path (${app.kind === 'dash' ? 'call app.run() without arguments' : 'call demo.launch() without server arguments'}). Suggest concrete improvements and give the full updated file in one \`\`\`python block.\n\n\`\`\`python\n${files[active] ?? ''}\n\`\`\`` });
  };
  /** Copilot writes (or rewrites) app.py for a goal, with the SDK guide as the contract; the result lands in the editor after a static check. */
  const draft = async () => {
    if (!app) return;
    const goal = window.prompt(files['app.py']?.trim() ? 'What should the app do? (Copilot rewrites app.py — the current code is sent as the starting point)' : 'What should the app do? (e.g. "explore trips by zone and hour with fare KPIs and a filterable table")', '');
    if (goal === null || !goal.trim()) return;
    setDrafting(true);
    setError(null);
    try {
      const guide = (await api.get<{ guide: string }>('/api/apps/guide')).guide;
      let out = '';
      for await (const ev of copilotChat({ workspace_id: app.workspace_id, message: `Write a complete Streamlit data app (app.py) for this goal: ${goal.trim()}.\n\nFollow this guide exactly:\n\n${guide}\n\nUse the workspace's tables and files you know about (the schema is in your context). ${files['app.py']?.trim() ? `Start from the current file and keep what still applies:\n\n\`\`\`python\n${files['app.py']}\n\`\`\`\n\n` : ''}Return only one \`\`\`python block with the full file, no prose.` })) {
        if (ev.type === 'delta') out += ev.text;
        if (ev.type === 'error') throw new Error(ev.message);
      }
      const m = /```python\s*([\s\S]*?)```/i.exec(out) ?? /```\s*([\s\S]*?)```/.exec(out);
      const code = (m ? m[1]! : out).trim() + '\n';
      const v = await api.post<{ ok: boolean; errors: string[]; warnings: string[] }>('/api/apps/validate', { files: { ...files, 'app.py': code }, entry: app.entry, kind: app.kind });
      setCheck(v);
      if (!v.ok) throw new Error(`Copilot's draft did not pass the check: ${v.errors.join('; ')} — it is in the editor to fix.`);
      setFiles((f) => ({ ...f, 'app.py': code }));
      setActive('app.py');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDrafting(false);
    }
  };
  const runCheck = async () => {
    try {
      setCheck(await api.post('/api/apps/validate', { files, entry: app?.entry ?? 'app.py', kind: app?.kind }));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (!app) return <div className="p-5 text-xs text-zinc-500">{error ?? 'Loading…'}</div>;
  const status = app.status;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800 px-4 py-2">
        <a href="#/apps" className="text-zinc-500 hover:text-zinc-200" title="Back to the gallery"><ChevronLeft className="h-4 w-4" /></a>
        <AppWindow className="h-4 w-4 text-accent-300" />
        <span className="text-body font-semibold text-zinc-100">{app.name}</span>
        <Badge tone={STATUS_TONE[status]}>{app.execution === 'browser' && status === 'running' ? 'ready' : status}</Badge>
        {dirty && <Badge tone="warn">unsaved</Badge>}
        <button type="button" onClick={() => setPublishing(true)} title="Who sees this app" className="disabled:opacity-50" disabled={!canEdit}><Audience app={app} /></button>
        {app.always_on && <Badge tone="accent" className="gap-1"><Pin className="h-3 w-3" /> always on</Badge>}
        <Badge tone={app.kind === 'streamlit' ? 'zinc' : 'blue'}>{APP_KIND_LABEL[app.kind]}</Badge>
        {canEdit && app.kind === 'streamlit' && (
          <Select value={app.execution} title="Where the app's Python runs" className="h-6 py-0 text-2xs" onChange={async (e) => { try { setApp((await api.patch<{ app: DataApp }>(`/api/apps/${id}`, { execution: e.target.value })).app); setPreviewKey((k) => k + 1); } catch (err) { setError((err as Error).message); } }}>
            <option value="server">runs on the server</option>
            <option value="browser">runs in the viewer's browser</option>
          </Select>
        )}
        <span className="text-2xs text-zinc-500">{app.execution === 'browser' ? 'Python runs in each viewer\'s browser' : app.last_started_at ? `started ${timeAgo(app.last_started_at)}` : 'never started'}{app.last_error ? <span className="text-red-300"> · {app.last_error}</span> : null}</span>
        <div className="ml-auto flex items-center gap-1">
          <Button size="sm" variant="ghost" onClick={() => void draft()} loading={drafting} disabled={!canEdit || !cp.config?.can_use || app.kind !== 'streamlit'} title={app.kind !== 'streamlit' ? 'Draft writes Streamlit apps; ask Copilot (next button) about Dash or Gradio code' : cp.config?.can_use ? 'Let Copilot write app.py for a goal (checked before it lands in the editor)' : 'Configure Copilot under Settings → Copilot first'}><Wand2 className="h-3.5 w-3.5" /> Draft</Button>
          <Button size="sm" variant="ghost" onClick={askCopilot} title="Ask Copilot about this app" aria-label="Ask Copilot about this app"><Bot className="h-3.5 w-3.5" /></Button>
          <Button size="sm" variant="ghost" onClick={() => void runCheck()} title="Static check: compiles, imports streamlit, no tokens"><CheckCircle2 className={cn('h-3.5 w-3.5', check?.ok ? 'text-emerald-400' : check ? 'text-red-300' : '')} /> Check</Button>
          <Button size="sm" variant="secondary" onClick={() => void save()} loading={busy === 'save'} disabled={!canEdit || !dirty} title="Save (⌘S) — a running app restarts"><Save className="h-3.5 w-3.5" /> Save</Button>
          {app.execution === 'browser' ? (
            <Button size="sm" variant="ghost" onClick={() => setPreviewKey((k) => k + 1)} title="Reload the preview (the app runs in your browser)" aria-label="Reload the preview (the app runs in your browser)"><RotateCw className="h-3.5 w-3.5" /></Button>
          ) : status === 'running' || status === 'starting' || status === 'installing' ? (
            <>
              <Button size="sm" variant="ghost" onClick={() => void action('restart')} loading={busy === 'restart'} title="Restart" aria-label="Restart"><RotateCw className="h-3.5 w-3.5" /></Button>
              <Button size="sm" variant="ghost" onClick={() => void action('stop')} loading={busy === 'stop'} title="Stop"><Square className="h-3.5 w-3.5" /> Stop</Button>
            </>
          ) : (
            <Button size="sm" variant="primary" onClick={() => void action('start')} loading={busy === 'start'} title="Start"><Play className="h-3.5 w-3.5" /> Run</Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => void openAppInTab(id).catch((e) => setError((e as Error).message))} title="Open in a new tab" aria-label="Open in a new tab"><ExternalLink className="h-3.5 w-3.5" /></Button>
          <Button size="sm" variant="ghost" onClick={() => setShowLogs((v) => !v)} title="Logs" className={showLogs ? 'text-accent-300' : ''} aria-label="Logs"><ScrollText className="h-3.5 w-3.5" /></Button>
          {isAdmin && app.execution !== 'browser' && <Button size="sm" variant="ghost" className={app.always_on ? 'text-accent-300' : ''} onClick={async () => { try { setApp((await api.post<{ app: DataApp }>(`/api/apps/${id}/always-on`, { on: !app.always_on })).app); } catch (e) { setError((e as Error).message); } }} title={app.always_on ? 'Always on: starts with the server, never stopped for idleness, restarted after a crash — click to let it scale to zero' : 'Keep always on (administrators): starts with the server, never idles out, restarts after a crash'} aria-label={app.always_on ? 'Always on: starts with the server, never stopped for idleness, restarted after a crash — click to let it scale to zero' : 'Keep always on (administrators): starts with the server, never idles out, restarts after a crash'}><Pin className="h-3.5 w-3.5" /></Button>}
          <Button size="sm" variant="secondary" disabled={!canEdit} onClick={() => setPublishing(true)} title="Share beyond the workspace"><Globe className="h-3.5 w-3.5" /> Publish</Button>
        </div>
      </div>
      <PublishDialog open={publishing} app={app} isAdmin={isAdmin} onClose={() => setPublishing(false)} onChanged={(a) => setApp(a)} />
      {error && <div className="border-b border-red-900/60 bg-red-950/40 px-4 py-1.5 font-mono text-2xs text-red-200">{error}</div>}
      {check && (check.errors.length || check.warnings.length) ? <div className={cn('border-b px-4 py-1.5 font-mono text-2xs', check.ok ? 'border-amber-900/60 bg-amber-950/30 text-amber-200' : 'border-red-900/60 bg-red-950/40 text-red-200')}>{[...check.errors, ...check.warnings.map((w) => `warning: ${w}`)].join(' · ')}<button className="ml-2 text-zinc-500 hover:text-zinc-200" onClick={() => setCheck(null)}>×</button></div> : null}
      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <div className="flex min-h-0 flex-col border-r border-zinc-800">
          <div className="flex items-center gap-1 border-b border-zinc-800 px-2 py-1 text-2xs">
            {Object.keys(files).map((f) => <button key={f} onClick={() => setActive(f)} className={cn('rounded px-2 py-0.5 font-mono', active === f ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200')}>{f}</button>)}
            <span className="ml-auto text-zinc-500">Python · ⌘S saves and {app.execution === 'browser' ? 'reloads' : 'restarts'}</span>
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            <CodeMirror value={files[active] ?? ''} height="100%" theme={kind === 'dark' ? oneDark : 'light'} extensions={extensions} onChange={(v) => setFiles((f) => ({ ...f, [active]: v }))} editable={canEdit} basicSetup={{ lineNumbers: true, foldGutter: true, highlightActiveLine: true, autocompletion: false }} className="h-full text-xs" />
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
            {(status === 'starting' || status === 'installing') && <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-center gap-2 bg-zinc-900/80 py-1 text-2xs text-zinc-300"><Loader2 className="h-3 w-3 animate-spin" /> {status === 'installing' ? 'Preparing the Python environment (first run takes a minute)…' : 'Starting…'}</div>}
          </div>
          {showLogs && (
            <pre className="max-h-56 overflow-auto border-t border-zinc-800 bg-zinc-950 p-2 font-mono text-2xs leading-snug text-zinc-400">{logs.length ? logs.join('\n') : 'No log lines yet.'}</pre>
          )}
        </div>
      </div>
    </div>
  );
}

/** Workspace members only, or everyone signed in — the latter reviewed by an administrator when the server asks for it. */
function PublishDialog({ open, app, isAdmin, onClose, onChanged }: { open: boolean; app: DataApp; isAdmin: boolean; onClose: () => void; onChanged: (a: DataApp) => void }) {
  const [audience, setAudience] = useState<'workspace' | 'org'>(app.visibility);
  const [note, setNote] = useState('');
  const [review, setReview] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    if (!open) return;
    setAudience(app.publish_status === 'pending' ? 'org' : app.visibility);
    setNote('');
    setMsg(null);
    void api.get<{ publish_requires_approval: boolean }>('/api/apps/templates').then((r) => setReview(r.publish_requires_approval)).catch(() => undefined);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const needsReview = audience === 'org' && review && !isAdmin;
  const unchanged = audience === 'org' ? app.visibility === 'org' : app.visibility === 'workspace' && app.publish_status === 'none';
  const submit = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.post<{ app: DataApp; outcome: 'published' | 'pending' | 'unpublished' }>(`/api/apps/${app.id}/publish`, { audience, note: note.trim() || null });
      onChanged(r.app);
      if (r.outcome === 'pending') setMsg({ ok: true, text: 'Request sent. An administrator reviews it under Settings → Data apps; until then only the workspace sees the app.' });
      else onClose();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title={`Share “${app.name}”`} width="max-w-md">
      <div className="space-y-3 text-xs">
        {app.publish_status === 'pending' && <div className="rounded-md border border-amber-900/60 bg-amber-950/30 px-3 py-2 text-amber-200">Waiting for an administrator{app.publish_requested_at ? ` since ${timeAgo(app.publish_requested_at)}` : ''}{app.publish_note ? ` — “${app.publish_note}”` : ''}.</div>}
        {app.publish_status === 'rejected' && <div className="rounded-md border border-red-900/60 bg-red-950/30 px-3 py-2 text-red-200">Not approved{app.publish_note ? `: “${app.publish_note}”` : ''}. Change the app and ask again.</div>}
        {([['workspace', <Users key="w" className="h-4 w-4" />, 'Workspace members', 'Everyone the workspace is shared with — viewers included.'], ['org', <Globe key="o" className="h-4 w-4" />, 'Everyone signed in', review ? (isAdmin ? 'Published at once (you are an administrator). A later code change by an editor sends it back to review.' : 'An administrator reviews the request first. Changing the code later sends it back to review.') : 'Anyone with a DuckView account can open it (read-only).']] as const).map(([id, icon, label, hint]) => (
          <button key={id} type="button" onClick={() => setAudience(id)} className={cn('flex w-full items-start gap-3 rounded-lg border p-3 text-left', audience === id ? 'border-accent-500 bg-accent-600/10' : 'border-zinc-800 hover:border-zinc-600')}>
            <span className="mt-0.5 text-accent-300">{icon}</span>
            <span><span className="block text-body text-zinc-100">{label}</span><span className="text-2xs text-zinc-500">{hint}</span></span>
          </button>
        ))}
        {needsReview && <div><Label>Note for the reviewer <span className="normal-case text-zinc-500">(optional)</span></Label><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Who it is for, what data it shows" /></div>}
        {msg && <div className={cn('rounded-md border px-3 py-2', msg.ok ? 'border-emerald-900/60 bg-emerald-950/30 text-emerald-200' : 'border-red-900 bg-red-950/50 text-red-200')}>{msg.text}</div>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>{msg?.ok ? 'Close' : 'Cancel'}</Button>
          <Button variant="primary" loading={busy} disabled={!!msg?.ok || unchanged} onClick={() => void submit()}>{needsReview ? (app.publish_status === 'pending' ? 'Update request' : 'Request review') : audience === 'org' ? 'Publish' : app.publish_status === 'pending' ? 'Withdraw request' : 'Keep to the workspace'}</Button>
        </div>
      </div>
    </Modal>
  );
}
