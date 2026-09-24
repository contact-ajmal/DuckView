import { useCallback, useEffect, useState } from 'react';
import { ArrowDownToLine, ArrowUpFromLine, GitBranch, RefreshCw } from 'lucide-react';
import { api, timeAgo } from '../../api/client';
import { useWorkspaceAccess } from '../../store/workspace';
import { Button, Input, Label, Spinner, StatusDot, cn, confirmAction } from '../../components/ui';

interface GitSync { id: string; repo_url: string; branch: string; path: string; has_token: boolean; last_push_sha: string | null; last_push_at: string | null; last_pull_sha: string | null; last_pull_at: string | null; last_error: string | null }
interface Status { remote_sha: string | null; needs_pull: boolean; changes: { status: string; path: string }[] }
interface PullResult { sha: string | null; created: string[]; updated: string[]; unchanged: number; conflicts: string[]; deleted_upstream: string[]; only_in_workspace: string[]; errors: string[] }

/** Settings › Git: this workspace's notebooks, queries, dashboards, metrics and dbt projects in a Git repository. */
export function GitPanel({ workspaceId }: { workspaceId: string }) {
  const { canEdit, canManage } = useWorkspaceAccess();
  const [git, setGit] = useState<GitSync | null | undefined>(undefined);
  const [form, setForm] = useState({ repo_url: '', branch: 'main', path: '', token: '' });
  const [editing, setEditing] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [message, setMessage] = useState('');
  const [pull, setPull] = useState<PullResult | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await api.get<{ git: GitSync | null }>(`/api/workspaces/${workspaceId}/git`);
    setGit(r.git);
    if (r.git) setForm({ repo_url: r.git.repo_url, branch: r.git.branch, path: r.git.path, token: '' });
  }, [workspaceId]);
  const refreshStatus = useCallback(async () => {
    setStatus(await api.get<Status>(`/api/workspaces/${workspaceId}/git/status`));
  }, [workspaceId]);
  useEffect(() => void load().catch((e) => setError((e as Error).message)), [load]);
  useEffect(() => {
    if (git && canEdit) void refreshStatus().catch((e) => setError((e as Error).message));
  }, [git?.id, canEdit, refreshStatus]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
      void load().catch(() => undefined);
    }
  };

  if (git === undefined) return <Spinner />;
  const showForm = !git || editing;
  const short = (s: string | null) => (s ? s.slice(0, 7) : '—');

  return (
    <div className="space-y-5 text-xs" data-testid="git-panel">
      <p className="max-w-3xl text-zinc-500">Keep this workspace's notebooks, saved queries, dashboards, metric definitions and dbt projects in a Git repository as readable YAML and SQL — review changes in pull requests, and bring changes made in Git back in. Pulls are recorded in each object's version history.</p>
      {error && <div className="rounded-md border border-red-900 bg-red-950/50 px-3 py-2 font-mono text-red-200" data-testid="git-error">{error}</div>}
      {notice && <div className="rounded-md border border-emerald-900/60 bg-emerald-950/30 px-3 py-2 text-emerald-200" data-testid="git-notice">{notice}</div>}

      {showForm ? (
        <form className="grid max-w-3xl gap-3 md:grid-cols-[minmax(0,1fr)_140px]" onSubmit={(e) => { e.preventDefault(); void act('save', async () => { await api.put(`/api/workspaces/${workspaceId}/git`, { repo_url: form.repo_url, branch: form.branch, path: form.path, ...(form.token || !git ? { token: form.token || null } : {}) }); setEditing(false); }); }}>
          <div><Label>Repository (HTTPS)</Label><Input className="font-mono" value={form.repo_url} onChange={(e) => setForm({ ...form, repo_url: e.target.value })} placeholder="https://github.com/acme/analytics.git" disabled={!canManage} data-testid="git-url" /></div>
          <div><Label>Branch</Label><Input className="font-mono" value={form.branch} onChange={(e) => setForm({ ...form, branch: e.target.value })} disabled={!canManage} /></div>
          <div><Label>Folder in the repository <span className="text-zinc-500">(optional)</span></Label><Input className="font-mono" value={form.path} onChange={(e) => setForm({ ...form, path: e.target.value })} placeholder="duckview" disabled={!canManage} data-testid="git-path" /></div>
          <div><Label>Access token</Label><Input type="password" className="font-mono" value={form.token} onChange={(e) => setForm({ ...form, token: e.target.value })} placeholder={git?.has_token ? 'kept (type to replace)' : 'ghp_… / glpat-…'} disabled={!canManage} /></div>
          <div className="flex items-center gap-2 md:col-span-2">
            <Button type="submit" variant="primary" disabled={!canManage || !form.repo_url.trim()} loading={busy === 'save'} data-testid="git-save"><GitBranch className="h-3.5 w-3.5" /> {git ? 'Save' : 'Connect'}</Button>
            {git && <Button type="button" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>}
            <span className="text-zinc-500">A token with read and write access to the repository's contents. It is stored encrypted and sent only to the repository.</span>
          </div>
        </form>
      ) : (
        <div className="flex max-w-4xl flex-wrap items-center gap-x-4 gap-y-1 border-y border-zinc-800 py-2.5">
          <StatusDot tone={git!.last_error ? 'error' : 'ok'}><span className="font-mono text-zinc-200">{git!.repo_url}</span></StatusDot>
          <span className="text-zinc-500">branch <span className="font-mono text-zinc-300">{git!.branch}</span>{git!.path ? <> · folder <span className="font-mono text-zinc-300">{git!.path}/</span></> : null}</span>
          <span className="text-zinc-500">pushed {git!.last_push_at ? `${short(git!.last_push_sha)} ${timeAgo(git!.last_push_at)}` : 'never'} · pulled {git!.last_pull_at ? `${short(git!.last_pull_sha)} ${timeAgo(git!.last_pull_at)}` : 'never'}</span>
          {canManage && <span className="ml-auto flex gap-1"><Button size="sm" variant="ghost" onClick={() => setEditing(true)}>Edit</Button><Button size="sm" variant="ghost" className="text-red-300" onClick={async () => { if ((await confirmAction('Disconnect this repository? Nothing in the repository or the workspace is deleted.'))) void act('disconnect', () => api.del(`/api/workspaces/${workspaceId}/git`)); }}>Disconnect</Button></span>}
        </div>
      )}

      {git && !editing && canEdit && (
        <div className="grid max-w-5xl gap-5 lg:grid-cols-2">
          <section className="space-y-2">
            <div className="flex items-center gap-2"><h2 className="text-body font-semibold text-zinc-100">Push</h2><Button size="sm" variant="ghost" className="ml-auto" onClick={() => void act('status', refreshStatus)} loading={busy === 'status'} title="Check again" aria-label="Check again"><RefreshCw className="h-3.5 w-3.5" /></Button></div>
            {!status ? <Spinner /> : (
              <>
                {status.needs_pull && <p className="rounded-md border border-amber-900/60 bg-amber-950/30 px-2.5 py-1.5 text-amber-200">The repository has commits this workspace has not pulled ({short(status.remote_sha)}). Pull first, then push.</p>}
                {status.changes.length === 0 ? <p className="text-zinc-500">Nothing to push — the repository has everything in this workspace.</p> : (
                  <ul className="max-h-60 divide-y divide-zinc-800/70 overflow-auto border-y border-zinc-800 font-mono text-xs" data-testid="git-changes">
                    {status.changes.map((c) => <li key={c.path} className="flex gap-2 py-1"><span className={cn('w-16 shrink-0', c.status === 'added' ? 'text-emerald-400' : c.status === 'deleted' ? 'text-red-400' : 'text-amber-400')}>{c.status}</span><span className="truncate text-zinc-300">{c.path}</span></li>)}
                  </ul>
                )}
                <div className="flex gap-2">
                  <Input value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Commit message (optional)" aria-label="Commit message" data-testid="git-message" />
                  <Button variant="primary" disabled={status.needs_pull || status.changes.length === 0} loading={busy === 'push'} onClick={() => void act('push', async () => { const r = await api.post<{ pushed: boolean; sha: string | null; files: number }>(`/api/workspaces/${workspaceId}/git/push`, { message: message || null }); setMessage(''); setNotice(r.pushed ? `Pushed ${short(r.sha)} — ${r.files} files.` : 'Nothing to push.'); await refreshStatus(); })} data-testid="git-push"><ArrowUpFromLine className="h-3.5 w-3.5" /> Push</Button>
                </div>
              </>
            )}
          </section>
          <section className="space-y-2">
            <h2 className="text-body font-semibold text-zinc-100">Pull</h2>
            <p className="text-zinc-500">Brings in what changed in the repository since the last push or pull. Objects changed here and there take the repository's version; yours stays in their history.</p>
            <Button loading={busy === 'pull'} onClick={() => void act('pull', async () => { setPull(await api.post<PullResult>(`/api/workspaces/${workspaceId}/git/pull`, {})); await refreshStatus(); })} data-testid="git-pull"><ArrowDownToLine className="h-3.5 w-3.5" /> Pull</Button>
            {pull && (
              <div className="space-y-1.5 border-y border-zinc-800 py-2" data-testid="git-pull-result">
                <p className="text-zinc-300">{pull.sha ? `At ${short(pull.sha)}: ${pull.created.length} created, ${pull.updated.length} updated, ${pull.unchanged} unchanged.` : 'The repository is empty.'}</p>
                {[['Created', pull.created, 'text-emerald-300'], ['Updated', pull.updated, 'text-zinc-300'], ['Changed on both sides (the repository won; your version is in the history)', pull.conflicts, 'text-amber-300'], ['Deleted in the repository (kept here)', pull.deleted_upstream, 'text-zinc-400'], ['Only in this workspace (a push adds them)', pull.only_in_workspace, 'text-zinc-400'], ['Could not be applied', pull.errors, 'text-red-300']].filter(([, list]) => (list as string[]).length).map(([label, list, tone]) => (
                  <div key={label as string}><div className="text-zinc-500">{label as string}</div><ul className={cn('font-mono text-xs', tone as string)}>{(list as string[]).map((x) => <li key={x}>{x}</li>)}</ul></div>
                ))}
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
