import { useEffect, useState } from 'react';
import { LogOut, Plus, ChevronDown, Users, Eye, HardDrive, Zap, Cloud, FolderOpen, AlertTriangle, Loader2 } from 'lucide-react';
import { storageKindOf } from './api/client';
import { StorageChooser, toDbPath, loadStorageOptions, type StorageChoice } from './features/workspace/StorageChooser';
import { useAuth } from './store/auth';
import { useWorkspace } from './store/workspace';
import { LoginPage } from './features/auth/LoginPage';
import { OverviewPage } from './features/overview/OverviewPage';
import { WorkspacePage } from './features/workspace/WorkspacePage';
import { SettingsPage } from './features/settings/SettingsPage';
import { McpPage } from './features/mcp/McpPage';
import { DashboardsPage } from './features/dashboards/DashboardsPage';
import { ConnectionsPage } from './features/connections/ConnectionsPage';
import { AppsPage } from './features/apps/AppsPage';
import { CopilotDrawer } from './features/copilot/CopilotDrawer';
import { ShareDialog } from './features/workspace/ShareDialog';
import { useCopilot } from './store/copilot';
import { Bot } from 'lucide-react';
import { LayoutMenu } from './components/LayoutMenu';
import { ThemeMenu } from './components/ThemeMenu';
import { Logo } from './components/Logo';
import { Tag } from './components/layout';
import { Button, Input, Label, Modal, Spinner, cn } from './components/ui';

type Route = 'overview' | 'query' | 'dashboards' | 'apps' | 'connections' | 'settings' | 'mcp';
const ROUTES: { id: Route; hash: string; label: string }[] = [
  { id: 'overview', hash: '#/', label: 'Overview' },
  { id: 'query', hash: '#/query', label: 'Query' },
  { id: 'dashboards', hash: '#/dashboards', label: 'Dashboards' },
  { id: 'apps', hash: '#/apps', label: 'Apps' },
  { id: 'connections', hash: '#/connections', label: 'Connections' },
  { id: 'settings', hash: '#/settings', label: 'Settings' },
  { id: 'mcp', hash: '#/mcp', label: 'MCP' },
];

function parseRoute(): Route {
  const h = location.hash.replace(/^#\/?/, '');
  if (h.startsWith('query')) return 'query';
  if (h.startsWith('dashboards')) return 'dashboards';
  if (h.startsWith('apps')) return 'apps';
  if (h.startsWith('connections')) return 'connections';
  if (h.startsWith('settings')) return 'settings';
  if (h.startsWith('mcp') || h.startsWith('agents')) return 'mcp';
  return 'overview';
}

/** Header chip: where the active workspace's database lives, and for cloud databases how the sync stands. */
function StorageBadge({ path, sync }: { path: string; sync: { dirty: boolean; last_error: string | null; synced_at: string | null } | null }) {
  const kind = storageKindOf(path);
  if (kind === 'memory') {
    return (
      <span className="inline-flex items-center gap-1 rounded border border-amber-900/60 bg-amber-950/40 px-1 py-0.5 text-[10px] uppercase tracking-wide text-amber-300" title="In-memory scratch database: tables are cleared when the engine restarts. Settings → Engine → Make persistent keeps them.">
        <Zap className="h-3 w-3" /> memory
      </span>
    );
  }
  if (kind === 'cloud') {
    const tone = sync?.last_error ? 'border-red-900/60 bg-red-950/40 text-red-300' : sync?.dirty ? 'border-amber-900/60 bg-amber-950/40 text-amber-300' : 'border-emerald-900/60 bg-emerald-950/30 text-emerald-300';
    const title = sync?.last_error ? `Cloud sync problem: ${sync.last_error}` : sync?.dirty ? 'Changes not yet pushed to the cloud (pushed after a quiet minute, or Settings → Engine → Sync now)' : `Synced with ${path}${sync?.synced_at ? ` at ${new Date(sync.synced_at).toLocaleTimeString()}` : ''}`;
    return (
      <span className={cn('inline-flex items-center gap-1 rounded border px-1 py-0.5 text-[10px] uppercase tracking-wide', tone)} title={title}>
        {sync?.last_error ? <AlertTriangle className="h-3 w-3" /> : sync?.dirty ? <Loader2 className="h-3 w-3" /> : <Cloud className="h-3 w-3" />} {sync?.last_error ? 'sync error' : sync?.dirty ? 'pending sync' : 'cloud'}
      </span>
    );
  }
  return (
    <span className="hidden items-center gap-1 font-mono text-[11px] text-zinc-500 xl:inline-flex" title={kind === 'folder' ? 'Stored in a folder on the server' : kind === 'motherduck' ? 'MotherDuck database' : 'Stored as a DuckDB file in the data directory — tables survive restarts'}>
      {kind === 'folder' ? <FolderOpen className="h-3 w-3" /> : <HardDrive className="h-3 w-3" />} {path.length > 40 ? `…${path.slice(-38)}` : path}
    </span>
  );
}

export default function App() {
  const auth = useAuth();
  const ws = useWorkspace();
  const cp = useCopilot();
  const [route, setRoute] = useState<Route>(parseRoute);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newStorage, setNewStorage] = useState<StorageChoice>({ kind: 'data', path: '' });
  const [wsMenu, setWsMenu] = useState(false);
  const [sharing, setSharing] = useState(false);

  useEffect(() => {
    const on = () => setRoute(parseRoute());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);

  useEffect(() => {
    const m = /^#\/auth\/callback\?token=(.+)$/.exec(location.hash);
    if (m) {
      history.replaceState(null, '', location.pathname + '#/');
      void auth.acceptToken(decodeURIComponent(m[1]!));
    } else void auth.init();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!auth.user) return;
    void ws.loadWorkspaces();
    // Epoch events from teammates (and our own mutations elsewhere) keep cached views honest.
    const stop = ws.startLiveInvalidation();
    return stop;
  }, [auth.user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (auth.loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="h-6 w-6" />
      </div>
    );
  }
  if (!auth.user) return <LoginPage />;

  const active = ws.workspaces.find((w) => w.id === ws.activeId);

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-14 shrink-0 items-center gap-5 border-b border-zinc-800 bg-zinc-950 px-5">
        <a href="#/" className="flex items-center gap-2.5">
          <Logo className="h-7 w-7" />
          <span className="text-[15px] font-semibold tracking-tight text-zinc-50">DuckView</span>
          <Tag>v1.2.0</Tag>
        </a>
        <nav className="flex items-center gap-1">
          {ROUTES.map((r) => (
            <a key={r.id} href={r.hash} className={cn('rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors', route === r.id ? 'bg-zinc-800 text-zinc-50' : 'text-zinc-400 hover:text-zinc-100')}>
              {r.label}
            </a>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-3">
          <ThemeMenu />
          <LayoutMenu currentPage={route === 'dashboards' || route === 'connections' || route === 'apps' ? null : route} />
          <button onClick={() => cp.toggle()} className={cn('inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs', cp.open ? 'border-accent-600/60 bg-accent-600/20 text-accent-100' : 'border-zinc-800 bg-zinc-900/70 text-zinc-300 hover:text-zinc-100')} title="DuckCopilot — context-aware AI assistant">
            <Bot className="h-3.5 w-3.5" /> Copilot
          </button>
          <div className="relative">
            <button onClick={() => setWsMenu(!wsMenu)} className="flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-900/70 px-2.5 py-1 text-xs hover:bg-zinc-800">
              <span className={cn('h-1.5 w-1.5 rounded-full', active?.shared ? 'bg-sky-400' : 'bg-accent-400')} />
              <span className="font-medium text-zinc-100">{active?.name ?? 'Workspace'}</span>
              {active?.shared && (
                <span className="inline-flex items-center gap-1 rounded border border-zinc-700 px-1 py-0.5 text-[10px] uppercase tracking-wide text-zinc-400" title={`Shared by ${active.owner.display_name ?? active.owner.email} — you are ${active.role.toLowerCase()}`}>
                  {active.role === 'VIEWER' ? <Eye className="h-3 w-3" /> : <Users className="h-3 w-3" />} {active.role.toLowerCase()}
                </span>
              )}
              {active && <StorageBadge path={active.active_db_path} sync={active.cloud_sync} />}
              <ChevronDown className="h-3.5 w-3.5 text-zinc-500" />
            </button>
            {wsMenu && (
              <div className="absolute right-0 top-full z-40 mt-1 w-80 rounded-lg border border-zinc-800 bg-zinc-900 p-1 shadow-xl" onMouseLeave={() => setWsMenu(false)}>
                {(
                  [
                    ['Your workspaces', ws.workspaces.filter((w) => !w.shared)],
                    ['Shared with you', ws.workspaces.filter((w) => w.shared)],
                  ] as const
                ).map(([label, items]) =>
                  items.length === 0 ? null : (
                    <div key={label}>
                      <div className="px-2 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">{label}</div>
                      {items.map((w) => (
                        <button
                          key={w.id}
                          onClick={() => {
                            setWsMenu(false);
                            void ws.selectWorkspace(w.id);
                          }}
                          className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-zinc-800', w.id === ws.activeId && 'bg-zinc-800/70')}
                        >
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm text-zinc-100">{w.name}</span>
                            <span className="block truncate font-mono text-[10px] text-zinc-500">{w.shared ? `${w.owner.display_name ?? w.owner.email} · ${w.role.toLowerCase()}` : w.member_count > 0 ? `${w.active_db_path} · shared with ${w.member_count}` : w.active_db_path}</span>
                          </span>
                          {w.shared ? <Users className="h-3.5 w-3.5 shrink-0 text-sky-400" /> : w.member_count > 0 ? <Users className="h-3.5 w-3.5 shrink-0 text-zinc-500" /> : null}
                        </button>
                      ))}
                    </div>
                  ),
                )}
                {active && (
                  <button
                    onClick={() => {
                      setWsMenu(false);
                      setSharing(true);
                    }}
                    className="mt-1 flex w-full items-center gap-2 rounded-md border-t border-zinc-800 px-2 py-2 text-left text-xs text-zinc-300 hover:bg-zinc-800"
                  >
                    <Users className="h-3.5 w-3.5" /> {active.role === 'OWNER' && auth.user.role !== 'READ_ONLY' ? `Share “${active.name}”…` : `Who has access to “${active.name}”`}
                  </button>
                )}
                {auth.user.role !== 'READ_ONLY' && (
                  <button
                    onClick={() => {
                      setWsMenu(false);
                      setCreating(true);
                    }}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-xs text-accent-300 hover:bg-zinc-800"
                  >
                    <Plus className="h-3.5 w-3.5" /> New workspace
                  </button>
                )}
              </div>
            )}
          </div>
          <button onClick={auth.logout} title={`Sign out ${auth.user.email}`} className="rounded-md p-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200">
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <main className="min-h-0 min-w-0 flex-1 overflow-hidden">
          {route === 'overview' && <OverviewPage />}
          {route === 'query' && <WorkspacePage />}
          {route === 'dashboards' && <DashboardsPage />}
          {route === 'connections' && <ConnectionsPage />}
          {route === 'apps' && <AppsPage />}
          {route === 'settings' && <SettingsPage />}
          {route === 'mcp' && (
            <div className="h-full overflow-auto">
              <McpPage />
            </div>
          )}
        </main>
        <CopilotDrawer />
      </div>

      <ShareDialog open={sharing} onClose={() => setSharing(false)} workspace={active ?? null} />

      <Modal open={creating} onClose={() => setCreating(false)} title="New workspace" width="max-w-3xl">
        <div className="space-y-3">
          <div>
            <Label>Name</Label>
            <Input autoFocus value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Marketing analytics" />
          </div>
          <div>
            <Label>Storage</Label>
            <StorageChooser value={newStorage} onChange={setNewStorage} suggestedName={newName} compact />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={async () => {
                try {
                  await ws.createWorkspace({ name: newName, ...toDbPath(newStorage, await loadStorageOptions().catch(() => null)) });
                  setCreating(false);
                  setNewName('');
                  setNewStorage({ kind: 'data', path: '' });
                } catch (e) {
                  alert((e as Error).message);
                }
              }}
            >
              Create
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
