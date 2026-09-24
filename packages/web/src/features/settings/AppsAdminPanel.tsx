import { useCallback, useEffect, useState } from 'react';
import { AppWindow, Check, ExternalLink, Globe, Pin, Square, X } from 'lucide-react';
import { api, openAppInTab, timeAgo, type AdminApp, type AppRuntimeInfo, type DataApp } from '../../api/client';
import { subscribeLiveEvents } from '../../lib/liveEvents';
import { Badge, Button, Card, Input, cn } from '../../components/ui';
import { KvRows } from '../../components/layout';
import { DataTable } from '../../components/data';

const RUNTIME_TITLE = { subprocess: 'Subprocess — a shared virtualenv next to the server', docker: 'Docker — one hardened container per app', kubernetes: 'Kubernetes — one pod per app' } as const;

/**
 * Settings → Data apps (administrators): where apps run, what is running now, which apps stay always on, and the
 * requests to publish an app to everyone signed in.
 */
export function AppsAdminPanel() {
  const [apps, setApps] = useState<AdminApp[]>([]);
  const [runtime, setRuntime] = useState<AppRuntimeInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const load = useCallback(async () => {
    const r = await api.get<{ apps: AdminApp[]; runtime: AppRuntimeInfo }>('/api/admin/apps');
    setApps(r.apps);
    setRuntime(r.runtime);
  }, []);
  useEffect(() => void load().catch((e) => setError((e as Error).message)), [load]);
  useEffect(() => subscribeLiveEvents((e) => { if (e.type === 'app') void load().catch(() => undefined); }), [load]);
  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const review = (a: AdminApp, decision: 'approve' | 'reject') => act(`${decision}:${a.id}`, () => api.post(`/api/admin/apps/${a.id}/review`, { decision, note: notes[a.id]?.trim() || null }));
  const open = (a: AdminApp) => openAppInTab(a.id).catch((e) => setError((e as Error).message));
  const pending = apps.filter((a) => a.publish_status === 'pending');
  const running = apps.filter((a) => a.status === 'running' || a.status === 'starting' || a.status === 'installing');

  return (
    <div className="space-y-4">
      {error && <div className="rounded-md border border-red-900 bg-red-950/50 px-3 py-2 font-mono text-xs text-red-200">{error}</div>}
      <Card title="Runtime">
        {runtime ? (
          <>
            <p className="mb-3 text-xs text-zinc-400">{RUNTIME_TITLE[runtime.runtime]}{runtime.enabled ? '' : ' · data apps are disabled on this server (apps.enabled)'}. Apps scale to zero: idle ones stop after {runtime.idle_stop_minutes} min and start again on the next visit; when {runtime.max_running} are running the least recently used one idle for {runtime.evict_idle_seconds} s makes room. Always-on apps are exempt.</p>
            <KvRows rows={([
              ['Running', `${runtime.running} of ${runtime.max_running}`],
              ['Image', runtime.image],
              ['Namespace', runtime.namespace],
              ['Network', runtime.runtime === 'docker' ? runtime.network ?? 'host ports on 127.0.0.1' : undefined],
              ['DuckView URL', runtime.duckview_url],
              ['Per app', runtime.cpu ? `${runtime.cpu} CPU · ${runtime.memory}` : undefined],
              ['Virtualenv', runtime.venv],
              ['Publishing', runtime.publish_requires_approval ? 'to everyone: reviewed by an administrator' : 'to everyone: immediate (apps.publish_requires_approval is off)'],
            ] as [string, string | undefined][]).filter(([, v]) => v).map(([k, v]) => ({ k, v }))} />
          </>
        ) : <p className="text-xs text-zinc-500">Loading…</p>}
      </Card>

      <Card title={<span className="flex items-center gap-2">Publish requests {pending.length > 0 && <Badge tone="warn">{pending.length}</Badge>}</span>}>
        {pending.length === 0 ? <p className="text-xs text-zinc-500">Nothing waiting. When an editor (or an agent through publish_app) asks to make an app visible to everyone signed in, it shows up here.</p> : (
          <div className="space-y-3">
            {pending.map((a) => (
              <div key={a.id} className="rounded-lg border border-zinc-800 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <AppWindow className="h-4 w-4 text-accent-300" />
                  <span className="text-body font-semibold text-zinc-100">{a.name}</span>
                  <span className="text-2xs text-zinc-500">{a.workspace_name ?? a.workspace_id} · by {a.requested_by_email ?? 'unknown'}{a.publish_requested_at ? ` · ${timeAgo(a.publish_requested_at)}` : ''}</span>
                  <Button size="sm" variant="ghost" className="ml-auto" onClick={() => void open(a)} title="Open the app to review it"><ExternalLink className="h-3.5 w-3.5" /> Open</Button>
                  <a href={`#/apps/${a.id}`} className="text-2xs text-accent-300 hover:underline">Code</a>
                </div>
                {a.description && <p className="mt-1 text-2xs text-zinc-400">{a.description}</p>}
                {a.publish_note && <p className="mt-1 text-2xs text-zinc-300">“{a.publish_note}”</p>}
                <div className="mt-2 flex items-center gap-2">
                  <Input className="h-7 flex-1 text-xs" placeholder="Note for the requester (optional; shown if you reject)" value={notes[a.id] ?? ''} onChange={(e) => setNotes({ ...notes, [a.id]: e.target.value })} />
                  <Button size="sm" variant="ghost" className="text-red-300" loading={busy === `reject:${a.id}`} onClick={() => void review(a, 'reject')}><X className="h-3.5 w-3.5" /> Reject</Button>
                  <Button size="sm" variant="primary" loading={busy === `approve:${a.id}`} onClick={() => void review(a, 'approve')}><Check className="h-3.5 w-3.5" /> Approve</Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title={`All apps (${apps.length}) · ${running.length} running`}>
        {apps.length === 0 ? <p className="text-xs text-zinc-500">No data apps on this server yet.</p> : (
          <div className="overflow-x-auto">
            <DataTable
              label="Data apps"
              rows={apps}
              rowKey={(a) => a.id}
              columns={[
                { key: 'app', header: 'App', sortValue: (a) => a.name, cell: (a) => <><a href={`#/apps/${a.id}`} className="font-medium text-zinc-100 hover:underline">{a.name}</a></> },
                { key: 'workspace_owner', header: 'Workspace · owner', cell: (a) => <span className="text-zinc-400">{a.workspace_name ?? '—'} · {a.owner_email ?? '—'}</span> },
                { key: 'status', header: 'Status', sortValue: (a) => a.status, cell: (a) => <><Badge tone={a.status === 'running' ? 'green' : a.status === 'error' ? 'red' : a.status === 'stopped' ? 'zinc' : 'amber'}>{a.status}</Badge>{a.last_used_ms !== null && <span className="ml-1.5 text-2xs text-zinc-500">used {Math.round(a.last_used_ms / 60_000)} min ago</span>}</> },
                { key: 'audience', header: 'Audience', cell: (a) => <>{a.visibility === 'org' ? <Badge tone="info" className="gap-1"><Globe className="h-3 w-3" /> everyone</Badge> : <span className="text-zinc-500">workspace{a.publish_status === 'pending' ? ' · pending' : a.publish_status === 'rejected' ? ' · rejected' : ''}</span>}</> },
                { key: 'instance', header: 'Instance', cell: (a) => <span className="font-mono text-2xs text-zinc-500">{a.runtime_ref ?? (a.runtime ? `${a.runtime}` : '—')}</span> },
                { key: 'c5', header: '', align: 'right', sortValue: (a) => a.status, cell: (a) => <div className="whitespace-nowrap"><Button size="sm" variant="ghost" className={cn(a.always_on && 'text-accent-300')} loading={busy === `pin:${a.id}`} onClick={() => void act(`pin:${a.id}`, () => api.post<{ app: DataApp }>(`/api/apps/${a.id}/always-on`, { on: !a.always_on }))} title={a.always_on ? 'Always on — click to let it scale to zero' : 'Keep always on'}><Pin className="h-3.5 w-3.5" /></Button>
                      <Button size="sm" variant="ghost" disabled={a.status === 'stopped' || a.status === 'error'} loading={busy === `stop:${a.id}`} onClick={() => void act(`stop:${a.id}`, () => api.post(`/api/admin/apps/${a.id}/stop`, {}))} title="Stop"><Square className="h-3.5 w-3.5" /></Button></div> },
              ]}
            />
          </div>
        )}
      </Card>
    </div>
  );
}
