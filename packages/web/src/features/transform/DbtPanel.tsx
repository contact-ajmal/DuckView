import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { EditorView } from '@codemirror/view';
import { sql as sqlLang } from '@codemirror/lang-sql';
import { yaml } from '@codemirror/lang-yaml';
import { oneDark } from '@codemirror/theme-one-dark';
import { ChevronLeft, FilePlus2, FolderUp, Play, Save, Trash2, CalendarClock, FileCode2, Loader2, ScrollText, Workflow, Download, Bot } from 'lucide-react';
import { api, timeAgo, type DbtCommand, type DbtNodeResult, type DbtProject, type DbtRun, type DbtSchedule, type DbtStatus } from '../../api/client';
import { useAuth } from '../../store/auth';
import { useWorkspaceAccess } from '../../store/workspace';
import { useTheme } from '../../store/theme';
import { subscribeLiveEvents } from '../../lib/liveEvents';
import { useCopilot } from '../../store/copilot';
import { Badge, Button, Empty, Input, Label, Modal, Select, cn } from '../../components/ui';
import { HistoryButton } from '../history/HistoryDrawer';

const COMMANDS: { id: DbtCommand; label: string; hint: string }[] = [
  { id: 'build', label: 'Build', hint: 'Seeds, models and tests in dependency order; a failing test skips what is downstream' },
  { id: 'run', label: 'Run', hint: 'Models only' },
  { id: 'test', label: 'Test', hint: 'Data tests only' },
  { id: 'seed', label: 'Seed', hint: 'Load the CSV seeds' },
  { id: 'compile', label: 'Compile', hint: 'Compile without running (see the SQL)' },
];
const STATUS_TONE: Record<DbtNodeResult['status'], 'green' | 'red' | 'amber' | 'zinc' | 'blue'> = { success: 'green', pass: 'green', error: 'red', fail: 'red', warn: 'amber', skipped: 'zinc', compiled: 'blue' };
const scheduleLabel = (s: DbtSchedule) => (s.kind === 'cron' ? `cron ${s.expression}` : s.kind === 'interval' ? `every ${s.minutes} min` : 'manual');

/** Transform → dbt: the workspace's dbt projects, their files, runs and schedules. */
export function DbtPanel({ workspaceId }: { workspaceId: string }) {
  const parseId = () => /^#\/transform\/dbt\/([\w-]+)/.exec(location.hash)?.[1] ?? null;
  const [openId, setOpenId] = useState<string | null>(parseId);
  useEffect(() => {
    const on = () => setOpenId(parseId());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return openId ? <ProjectView key={openId} id={openId} /> : <ProjectList workspaceId={workspaceId} />;
}

function RuntimeBanner({ status, onInstall }: { status: DbtStatus | null; onInstall: () => void }) {
  const isAdmin = useAuth((a) => a.user?.role === 'ADMIN');
  if (!status) return null;
  if (!status.enabled) return <div className="rounded-md border border-amber-900/60 bg-amber-950/30 px-3 py-2 text-xs text-amber-200">dbt is disabled on this server (<span className="font-mono">transform.dbt.enabled</span>).</div>;
  if (status.installed) return <div className="text-[11px] text-zinc-500" data-testid="dbt-version">dbt Core {status.version} · dbt-duckdb {status.adapter_version}</div>;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-zinc-800 bg-zinc-900/50 px-3 py-2 text-xs text-zinc-400">
      {status.installing ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Installing {status.package}…</> : status.error ? <span className="text-red-300">dbt install failed: {status.error}</span> : status.auto_install ? <>dbt ({status.package}) is installed into <span className="font-mono">{status.venv}</span> on the first run — it takes a minute.</> : <>dbt is not installed; an administrator can install {status.package} into <span className="font-mono">{status.venv}</span>.</>}
      {isAdmin && !status.installing && <Button size="sm" onClick={onInstall}><Download className="h-3.5 w-3.5" /> Install now</Button>}
    </div>
  );
}

function useDbtStatus() {
  const [status, setStatus] = useState<DbtStatus | null>(null);
  const load = useCallback(() => void api.get<DbtStatus>('/api/dbt/status').then(setStatus).catch(() => undefined), []);
  useEffect(() => {
    load();
    if (!status?.installing) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [load, status?.installing]);
  return { status, reload: load, install: () => void api.post<DbtStatus>('/api/admin/dbt/install').then(setStatus) };
}

function ProjectList({ workspaceId }: { workspaceId: string }) {
  const { canEdit } = useWorkspaceAccess();
  const { status, install } = useDbtStatus();
  const [projects, setProjects] = useState<DbtProject[]>([]);
  const [creating, setCreating] = useState<{ name: string; files: Record<string, string> | null; source: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => void api.get<{ projects: DbtProject[] }>(`/api/workspaces/${workspaceId}/dbt/projects`).then((r) => setProjects(r.projects)).catch((e) => setError((e as Error).message)), [workspaceId]);
  useEffect(() => {
    load();
    return subscribeLiveEvents((e) => e.type === 'dbt' && e.workspace_id === workspaceId && load());
  }, [load, workspaceId]);

  const pickFolder = async (list: FileList | null) => {
    if (!list?.length) return;
    const files: Record<string, string> = {};
    let root = '';
    for (const f of Array.from(list)) {
      const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
      if (rel.endsWith('/dbt_project.yml') && (!root || rel.length < root.length + 16)) root = rel.slice(0, -'dbt_project.yml'.length);
    }
    for (const f of Array.from(list)) {
      const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
      if (!rel.startsWith(root)) continue;
      const name = rel.slice(root.length);
      if (/^(target|dbt_packages|logs|\.git|venv|\.venv)\//.test(name) || /(^|\/)\./.test(name) || !/\.(sql|ya?ml|csv|md|jinja)$/i.test(name) || /(^|\/)profiles\.ya?ml$/i.test(name)) continue;
      files[name] = await f.text();
    }
    if (!files['dbt_project.yml']) {
      setError('That folder has no dbt_project.yml');
      return;
    }
    const projectName = /^\s*name:\s*['"]?([\w-]+)/m.exec(files['dbt_project.yml'])?.[1] ?? 'dbt project';
    setCreating({ name: projectName, files, source: `${Object.keys(files).length} files from ${root.replace(/\/$/, '') || 'the folder'}` });
  };

  return (
    <div className="space-y-3 text-xs">
      <RuntimeBanner status={status} onInstall={install} />
      {error && <div className="rounded-md border border-red-900 bg-red-950/50 px-3 py-2 font-mono text-red-200">{error}</div>}
      <div className="flex items-center justify-between">
        <p className="max-w-3xl text-zinc-500">dbt projects compiled by dbt Core and run in this workspace's engine: models, seeds and tests, incremental models, packages, schedules. Descriptions in the YAML become catalog notes.</p>
        {canEdit && (
          <div className="flex gap-2">
            <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-zinc-700 px-2.5 py-1 text-zinc-300 hover:bg-zinc-800" title="Import an existing dbt project folder (target/, dbt_packages/ and profiles.yml are left out)">
              <FolderUp className="h-3.5 w-3.5" /> Import folder
              <input type="file" className="hidden" data-testid="dbt-import" {...({ webkitdirectory: '', directory: '' } as Record<string, string>)} multiple onChange={(e) => void pickFolder(e.target.files)} />
            </label>
            <Button size="sm" variant="primary" onClick={() => setCreating({ name: '', files: null, source: 'starter' })}><Workflow className="h-3.5 w-3.5" /> New project</Button>
          </div>
        )}
      </div>
      {projects.length === 0 ? (
        <Empty title="No dbt projects yet" hint="Start from the starter project (a seed, a staging view, a table and tests) or import a project folder." icon={<Workflow className="h-6 w-6" />} />
      ) : (
        <div className="divide-y divide-zinc-800/70 border-y border-zinc-800">
          {projects.map((p) => (
            <button key={p.id} data-project={p.name} onClick={() => (location.hash = `#/transform/dbt/${p.id}`)} className="block w-full px-1 py-2.5 text-left hover:bg-zinc-900">
              <div className="flex items-center gap-2">
                <Workflow className="h-4 w-4 text-accent-300" />
                <span className="font-medium text-zinc-100">{p.name}</span>
                {p.last_run && <Badge tone={p.last_run.status === 'ok' ? 'green' : p.last_run.status === 'error' ? 'red' : 'blue'}>{p.last_run.status === 'running' ? 'running' : p.last_run.command}</Badge>}
                {canEdit && p.last_run?.status !== 'running' && (
                  <span
                    role="button"
                    className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-accent-200 hover:bg-accent-600/20"
                    title="dbt build (seeds, models, tests)"
                    onClick={(e) => {
                      e.stopPropagation();
                      void api.post(`/api/dbt/projects/${p.id}/runs`, { command: 'build' }).then(load).catch((err) => setError((err as Error).message));
                    }}
                  >
                    <Play className="h-3 w-3" /> Build
                  </span>
                )}
              </div>
              <div className="mt-1 text-zinc-500">{p.last_run ? `${p.last_run.summary ?? ''} · ${timeAgo(p.last_run.started_at)}` : 'Never run'} · {scheduleLabel(p.schedule)}{p.schedule.kind !== 'manual' && !p.enabled ? ' (paused)' : ''}</div>
            </button>
          ))}
        </div>
      )}
      <Modal open={!!creating} onClose={() => setCreating(null)} title="New dbt project">
        {creating && (
          <div className="space-y-3 text-xs">
            <div>
              <Label>Name</Label>
              <Input autoFocus value={creating.name} onChange={(e) => setCreating({ ...creating, name: e.target.value })} placeholder="Sales models" />
            </div>
            <p className="text-zinc-500">{creating.files ? `Imported: ${creating.source}.` : 'Starts from a small example: a seed, a staging view, a table on top, descriptions and tests. Edit it into your models.'}</p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setCreating(null)}>Cancel</Button>
              <Button
                variant="primary"
                disabled={!creating.name.trim()}
                onClick={() =>
                  void api
                    .post<{ project: DbtProject }>(`/api/workspaces/${workspaceId}/dbt/projects`, { name: creating.name, ...(creating.files ? { files: creating.files } : {}) })
                    .then((r) => {
                      setCreating(null);
                      location.hash = `#/transform/dbt/${r.project.id}`;
                    })
                    .catch((e) => setError((e as Error).message))
                }
              >
                Create
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

function ProjectView({ id }: { id: string }) {
  const { canEdit } = useWorkspaceAccess();
  const theme = useTheme((t) => t.theme.kind);
  const { status, install } = useDbtStatus();
  const [project, setProject] = useState<DbtProject | null>(null);
  const [files, setFiles] = useState<Record<string, string>>({});
  const [active, setActive] = useState('');
  const [dirty, setDirty] = useState(false);
  const [runs, setRuns] = useState<DbtRun[]>([]);
  const [run, setRun] = useState<DbtRun | null>(null);
  const [command, setCommand] = useState<DbtCommand>('build');
  const [select, setSelect] = useState('');
  const [fullRefresh, setFullRefresh] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [openSql, setOpenSql] = useState<string | null>(null);
  const [scheduling, setScheduling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const selectedRun = useRef<string | null>(null);
  const cp = useCopilot();

  const loadRuns = useCallback(async () => {
    const r = await api.get<{ runs: DbtRun[] }>(`/api/dbt/projects/${id}/runs`);
    setRuns(r.runs);
    const want = selectedRun.current ?? r.runs[0]?.id;
    if (want) setRun((await api.get<{ run: DbtRun }>(`/api/dbt/runs/${want}`)).run);
  }, [id]);
  const load = useCallback(async () => {
    const p = (await api.get<{ project: DbtProject }>(`/api/dbt/projects/${id}`)).project;
    setProject(p);
    setFiles(p.files ?? {});
    setActive((a) => a || (Object.keys(p.files ?? {}).find((f) => f.endsWith('.sql')) ?? 'dbt_project.yml'));
    setDirty(false);
    await loadRuns();
  }, [id, loadRuns]);
  useEffect(() => {
    void load().catch((e) => setError((e as Error).message));
    return subscribeLiveEvents((e) => {
      if (e.type !== 'dbt' || e.project_id !== id) return;
      void api.get<{ project: DbtProject }>(`/api/dbt/projects/${id}`).then((r) => setProject((p) => (p ? { ...p, last_run: r.project.last_run } : r.project)));
      if (e.status !== 'running') selectedRun.current = e.run_id;
      void loadRuns();
    });
  }, [id, load, loadRuns]);

  const tree = useMemo(() => Object.keys(files).filter((f) => !f.endsWith('.gitkeep')).sort((a, b) => (a === 'dbt_project.yml' ? -1 : b === 'dbt_project.yml' ? 1 : a.localeCompare(b))), [files]);
  const extensions = useMemo(() => [active.endsWith('.sql') ? sqlLang() : /\.ya?ml$/.test(active) ? yaml() : [], EditorView.lineWrapping].flat(), [active]);

  const save = async () => {
    setError(null);
    try {
      const p = (await api.patch<{ project: DbtProject }>(`/api/dbt/projects/${id}`, { files })).project;
      setProject((old) => ({ ...(old ?? p), ...p }));
      setDirty(false);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      if (dirty) await save();
      const r = (await api.post<{ run: DbtRun }>(`/api/dbt/projects/${id}/runs`, { command, select: select.trim() || null, full_refresh: fullRefresh })).run;
      selectedRun.current = r.id;
      setRun({ ...r, results: [] });
      await loadRuns();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const askCopilot = (r: DbtRun) => {
    const failed = (r.results ?? []).filter((x) => x.status === 'error' || x.status === 'fail');
    const fileOf = (name: string) => Object.keys(files).find((f) => f.split('/').pop() === `${name}.sql`);
    const involved = [...new Set(failed.flatMap((x) => [fileOf(x.name), ...x.depends_on.map((d) => fileOf(d.split('.').pop()!))]).filter((f): f is string => !!f))].slice(0, 6);
    const names = [...new Set(failed.flatMap((x) => [x.name, ...x.depends_on.map((d) => d.split('.').pop()!)]))];
    const yamls = Object.keys(files).filter((f) => /\.ya?ml$/.test(f) && f !== 'dbt_project.yml' && names.some((n) => new RegExp(`name:\\s*['"]?${n}\\b`).test(files[f]!))).slice(0, 3);
    const message = [
      `My dbt run in project "${project?.name}" failed: dbt ${r.command}${r.select ? ` --select ${r.select}` : ''} → ${r.summary ?? r.status}.`,
      r.error ? `Error:\n\`\`\`\n${r.error}\n\`\`\`` : '',
      failed.length ? `Failing nodes:\n${failed.map((x) => `- ${x.status} ${x.resource_type} ${x.name}: ${x.message ?? ''}`).join('\n')}` : '',
      ...[...involved, ...yamls].map((f) => `${f}:\n\`\`\`${f.endsWith('.sql') ? 'sql' : 'yaml'}\n${files[f]}\n\`\`\``),
      'Explain what went wrong and give the corrected file(s): for a model, a ```sql block whose first line is `-- dbt model: <path>`; for YAML a ```yaml block with the path in a comment.',
    ].filter(Boolean).join('\n\n');
    cp.toggle(true);
    void cp.send({ workspaceId: project!.workspace_id, message });
  };
  const addFile = () => {
    const name = prompt('New file (path inside the project)', 'models/my_model.sql');
    if (!name) return;
    setFiles((f) => ({ ...f, [name]: name.endsWith('.sql') ? 'select 1 as id\n' : '' }));
    setActive(name);
    setDirty(true);
  };
  const removeFile = (name: string) => {
    if (name === 'dbt_project.yml' || !confirm(`Delete ${name}?`)) return;
    setFiles(({ [name]: _gone, ...rest }) => rest);
    setActive('dbt_project.yml');
    setDirty(true);
  };

  if (!project) return <div className="text-xs text-zinc-500">{error ?? 'Loading…'}</div>;
  const running = project.last_run?.status === 'running';
  const results = run?.results ?? [];
  const counts = results.reduce<Record<string, number>>((m, r) => ({ ...m, [r.status]: (m[r.status] ?? 0) + 1 }), {});

  return (
    <div className="space-y-3 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <button className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200" onClick={() => (location.hash = '#/transform/dbt')} title="All projects"><ChevronLeft className="h-4 w-4" /></button>
        <Workflow className="h-4 w-4 text-accent-300" />
        <span className="text-sm font-semibold text-zinc-100" data-testid="dbt-project-name">{project.name}</span>
        <span className="text-zinc-500">· target schema <span className="font-mono">{project.target_schema}</span> · {scheduleLabel(project.schedule)}{project.schedule.kind !== 'manual' && !project.enabled ? ' (paused)' : ''}</span>
        <div className="ml-auto flex items-center gap-2">
          <HistoryButton label workspaceId={project.workspace_id} objectType="dbt" objectId={project.id} title={project.name} onRestored={() => void load()} />
          {canEdit && <Button size="sm" variant="ghost" onClick={() => setScheduling(true)}><CalendarClock className="h-3.5 w-3.5" /> Schedule</Button>}
          {canEdit && (
            <Button size="sm" variant="ghost" onClick={() => { if (confirm(`Delete the dbt project "${project.name}"? The tables it built stay.`)) void api.del(`/api/dbt/projects/${id}`).then(() => (location.hash = '#/transform/dbt')); }}>
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>
      <RuntimeBanner status={status} onInstall={install} />
      {error && <div className="rounded-md border border-red-900 bg-red-950/50 px-3 py-2 font-mono text-red-200">{error}</div>}

      <div className="grid gap-3 lg:grid-cols-[220px_1fr]">
        <div className="space-y-1 rounded-lg border border-zinc-800 bg-zinc-900/40 p-2">
          <div className="flex items-center justify-between px-1 pb-1 text-[10px] text-zinc-500">
            Files
            {canEdit && <button className="rounded p-0.5 hover:bg-zinc-800 hover:text-zinc-200" title="New file" onClick={addFile}><FilePlus2 className="h-3.5 w-3.5" /></button>}
          </div>
          {tree.map((f) => (
            <div key={f} className={cn('group flex items-center gap-1 rounded px-1.5 py-1', f === active ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-800/60')}>
              <button className="min-w-0 flex-1 truncate text-left font-mono text-[11px]" onClick={() => setActive(f)} title={f} data-file={f}>
                <FileCode2 className="mr-1 inline h-3 w-3 opacity-60" />
                {f}
              </button>
              {canEdit && f !== 'dbt_project.yml' && <button className="hidden rounded p-0.5 text-zinc-500 hover:text-red-300 group-hover:block" onClick={() => removeFile(f)} title="Delete"><Trash2 className="h-3 w-3" /></button>}
            </div>
          ))}
        </div>
        <div className="min-w-0 space-y-2">
          <div className="flex items-center gap-2">
            <span className="font-mono text-zinc-300">{active}</span>
            {dirty && <Badge tone="amber">unsaved</Badge>}
            {canEdit && <Button size="sm" className="ml-auto" disabled={!dirty} onClick={() => void save()}><Save className="h-3.5 w-3.5" /> Save</Button>}
          </div>
          <div className="h-[340px] overflow-hidden rounded-lg border border-zinc-800">
            <CodeMirror
              value={files[active] ?? ''}
              height="340px"
              theme={theme === 'dark' ? oneDark : 'light'}
              extensions={extensions}
              editable={canEdit}
              onChange={(v) => {
                setFiles((f) => ({ ...f, [active]: v }));
                setDirty(true);
              }}
              basicSetup={{ lineNumbers: true, foldGutter: true, highlightActiveLine: true, autocompletion: false }}
              className="h-full text-[12.5px]"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/40 p-2">
            <Select value={command} onChange={(e) => setCommand(e.target.value as DbtCommand)} className="h-7 w-28 text-xs" title={COMMANDS.find((c) => c.id === command)?.hint} data-testid="dbt-command">
              {COMMANDS.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </Select>
            <Input value={select} onChange={(e) => setSelect(e.target.value)} placeholder="--select (e.g. region_totals+  tag:finance)" className="h-7 min-w-[16rem] flex-1 font-mono text-xs" />
            <label className="flex items-center gap-1 text-zinc-400"><input type="checkbox" checked={fullRefresh} onChange={(e) => setFullRefresh(e.target.checked)} /> full refresh</label>
            <Button size="sm" variant="primary" disabled={busy || running || (!canEdit && command !== 'compile')} onClick={() => void start()}>
              {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />} {running ? 'Running…' : dirty ? 'Save & run' : 'Run'}
            </Button>
          </div>
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-[220px_1fr]">
        <div className="space-y-1">
          <div className="px-1 text-[10px] text-zinc-500">Runs</div>
          {runs.length === 0 && <div className="px-1 text-zinc-500">No runs yet.</div>}
          {runs.map((r) => (
            <button key={r.id} onClick={() => { selectedRun.current = r.id; void api.get<{ run: DbtRun }>(`/api/dbt/runs/${r.id}`).then((x) => setRun(x.run)); }} className={cn('block w-full rounded px-2 py-1.5 text-left', run?.id === r.id ? 'bg-zinc-800' : 'hover:bg-zinc-800/60')}>
              <div className="flex items-center gap-1.5">
                <span className={cn('h-2 w-2 rounded-full', r.status === 'ok' ? 'bg-emerald-400' : r.status === 'error' ? 'bg-red-400' : 'animate-pulse bg-sky-400')} />
                <span className="text-zinc-200">{r.command}</span>
                {r.select && <span className="truncate font-mono text-[10px] text-zinc-500">{r.select}</span>}
                <span className="ml-auto text-[10px] text-zinc-500">{timeAgo(r.started_at)}</span>
              </div>
              <div className="truncate text-[10px] text-zinc-500">{r.triggered_by === 'schedule' ? 'scheduled · ' : ''}{r.summary ?? 'running…'}</div>
            </button>
          ))}
        </div>
        <div className="min-w-0 space-y-2" data-testid="dbt-run">
          {run && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={run.status === 'ok' ? 'green' : run.status === 'error' ? 'red' : 'blue'}>{run.status}</Badge>
                <span className="text-zinc-300">dbt {run.command}{run.select ? ` --select ${run.select}` : ''}{run.full_refresh ? ' --full-refresh' : ''}</span>
                <span className="text-zinc-500">{run.duration_ms !== null ? `${(run.duration_ms / 1000).toFixed(1)} s` : ''}</span>
                {Object.entries(counts).map(([k, v]) => <Badge key={k} tone={STATUS_TONE[k as DbtNodeResult['status']]}>{v} {k}</Badge>)}
                <span className="ml-auto" />
                {run.status === 'error' && <Button size="sm" variant="ghost" onClick={() => askCopilot(run)} title="Explain the failure and propose fixed files" data-testid="dbt-ask-copilot"><Bot className="h-3.5 w-3.5" /> Ask Copilot</Button>}
                {run.log && <Button size="sm" variant="ghost" onClick={() => setShowLog((s) => !s)}><ScrollText className="h-3.5 w-3.5" /> {showLog ? 'Hide log' : 'dbt log'}</Button>}
              </div>
              {run.error && <div className="whitespace-pre-wrap rounded-md border border-red-900 bg-red-950/40 px-3 py-2 font-mono text-[11px] text-red-200" data-testid="dbt-run-error">{run.error}</div>}
              {showLog && run.log && <pre className="max-h-72 overflow-auto rounded-md border border-zinc-800 bg-zinc-950 p-2 font-mono text-[11px] text-zinc-400">{run.log}</pre>}
              {results.length > 0 && (
                <table className="w-full">
                  <thead className="text-left text-[10px] text-zinc-500">
                    <tr><th className="pb-1">Node</th><th className="pb-1">Type</th><th className="pb-1">Status</th><th className="pb-1 text-right">Rows</th><th className="pb-1 text-right">Time</th><th className="pb-1 pl-3">Message</th></tr>
                  </thead>
                  <tbody>
                    {results.map((r) => (
                      <Fragment key={r.unique_id}>
                        <tr className="cursor-pointer border-t border-zinc-800 hover:bg-zinc-900/60" onClick={() => setOpenSql(openSql === r.unique_id ? null : r.unique_id)} data-node={r.name}>
                          <td className="py-1 font-mono text-zinc-200">{r.relation ?? r.name}</td>
                          <td className="py-1 text-zinc-500">{r.resource_type}{r.materialized ? ` · ${r.materialized}` : ''}</td>
                          <td className="py-1"><Badge tone={STATUS_TONE[r.status]}>{r.status}</Badge></td>
                          <td className="py-1 text-right text-zinc-400">{r.rows ?? (r.failures !== null ? `${r.failures} failing` : '')}</td>
                          <td className="py-1 text-right text-zinc-500">{r.duration_ms} ms</td>
                          <td className="max-w-[28rem] truncate py-1 pl-3 text-zinc-400" title={r.message ?? ''}>{r.message}</td>
                        </tr>
                        {openSql === r.unique_id && r.sql && (
                          <tr><td colSpan={6}><pre className="max-h-64 overflow-auto rounded bg-zinc-950 p-2 font-mono text-[11px] text-zinc-300">{r.sql}</pre></td></tr>
                        )}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}
        </div>
      </div>
      {scheduling && <ScheduleDialog project={project} onClose={() => setScheduling(false)} onSaved={(p) => setProject((old) => ({ ...(old ?? p), ...p, files: old?.files }))} />}
    </div>
  );
}

function ScheduleDialog({ project, onClose, onSaved }: { project: DbtProject; onClose: () => void; onSaved: (p: DbtProject) => void }) {
  const [kind, setKind] = useState<DbtSchedule['kind']>(project.schedule.kind);
  const [minutes, setMinutes] = useState(project.schedule.kind === 'interval' ? project.schedule.minutes : 60);
  const [expression, setExpression] = useState(project.schedule.kind === 'cron' ? project.schedule.expression : '0 6 * * *');
  const [command, setCommand] = useState<DbtCommand>(project.scheduled.command);
  const [select, setSelect] = useState(project.scheduled.select ?? '');
  const [enabled, setEnabled] = useState(project.enabled);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal open onClose={onClose} title="Schedule">
      <div className="space-y-3 text-xs">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <Label>When</Label>
            <Select value={kind} onChange={(e) => setKind(e.target.value as DbtSchedule['kind'])}>
              <option value="manual">Manually</option>
              <option value="interval">Every N minutes</option>
              <option value="cron">Cron</option>
            </Select>
          </div>
          {kind === 'interval' && <div><Label>Minutes</Label><Input type="number" min={5} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} /></div>}
          {kind === 'cron' && <div><Label>Cron (UTC)</Label><Input value={expression} onChange={(e) => setExpression(e.target.value)} className="font-mono" /></div>}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <Label>Command</Label>
            <Select value={command} onChange={(e) => setCommand(e.target.value as DbtCommand)}>{COMMANDS.filter((c) => c.id !== 'compile').map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</Select>
          </div>
          <div><Label>Select</Label><Input value={select} onChange={(e) => setSelect(e.target.value)} placeholder="everything" className="font-mono" /></div>
        </div>
        <label className="flex items-center gap-1.5 text-zinc-400"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Enabled</label>
        <p className="text-zinc-500">Scheduled runs run as the project's creator ({project.user_id === useAuth.getState().user?.id ? 'you' : 'its author'}).</p>
        {error && <div className="rounded-md border border-red-900 bg-red-950/50 px-3 py-2 font-mono text-red-200">{error}</div>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={() =>
              void api
                .patch<{ project: DbtProject }>(`/api/dbt/projects/${project.id}`, { schedule: kind === 'interval' ? { kind, minutes } : kind === 'cron' ? { kind, expression } : { kind }, scheduled: { command, select: select.trim() || null }, enabled })
                .then((r) => {
                  onSaved(r.project);
                  onClose();
                })
                .catch((e) => setError((e as Error).message))
            }
          >
            Save
          </Button>
        </div>
      </div>
    </Modal>
  );
}
