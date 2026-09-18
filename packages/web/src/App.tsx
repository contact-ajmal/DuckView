import { useEffect, useState } from 'react';
import { LogOut, Plus, ChevronDown, Users, Eye } from 'lucide-react';
import { useAuth } from './store/auth';
import { useWorkspace } from './store/workspace';
import { LoginPage } from './features/auth/LoginPage';
import { OverviewPage } from './features/overview/OverviewPage';
import { WorkspacePage } from './features/workspace/WorkspacePage';
import { SettingsPage } from './features/settings/SettingsPage';
import { McpPage } from './features/mcp/McpPage';
import { DashboardsPage } from './features/dashboards/DashboardsPage';
import { CopilotDrawer } from './features/copilot/CopilotDrawer';
import { ShareDialog } from './features/workspace/ShareDialog';
import { useCopilot } from './store/copilot';
import { Bot } from 'lucide-react';
import { LayoutMenu } from './components/LayoutMenu';
import { ThemeMenu } from './components/ThemeMenu';
import { Logo } from './components/Logo';
import { Tag } from './components/layout';
import { Button, Input, Label, Modal, Spinner, cn } from './components/ui';

type Route = 'overview' | 'query' | 'dashboards' | 'settings' | 'mcp';
const ROUTES: { id: Route; hash: string; label: string }[] = [
  { id: 'overview', hash: '#/', label: 'Overview' },
  { id: 'query', hash: '#/query', label: 'Query' },
  { id: 'dashboards', hash: '#/dashboards', label: 'Dashboards' },
  { id: 'settings', hash: '#/settings', label: 'Settings' },
  { id: 'mcp', hash: '#/mcp', label: 'MCP' },
];

function parseRoute(): Route {
  const h = location.hash.replace(/^#\/?/, '');
  if (h.startsWith('query')) return 'query';
  if (h.startsWith('dashboards')) return 'dashboards';
  if (h.startsWith('settings')) return 'settings';
  if (h.startsWith('mcp') || h.startsWith('agents')) return 'mcp';
  return 'overview';
}

export default function App() {
  const auth = useAuth();
  const ws = useWorkspace();
  const cp = useCopilot();
  const [route, setRoute] = useState<Route>(parseRoute);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPath, setNewPath] = useState(':memory:');
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
    if (auth.user) void ws.loadWorkspaces();
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
          <Tag>v1.0.0</Tag>
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
          <LayoutMenu currentPage={route === 'dashboards' ? null : route} />
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
              <span className="hidden font-mono text-[11px] text-zinc-500 xl:inline">{active?.active_db_path}</span>
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

      <Modal open={creating} onClose={() => setCreating(false)} title="New workspace">
        <div className="space-y-3">
          <div>
            <Label>Name</Label>
            <Input autoFocus value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Marketing analytics" />
          </div>
          <div>
            <Label>Database</Label>
            <Input value={newPath} onChange={(e) => setNewPath(e.target.value)} className="font-mono" placeholder=":memory: | warehouse.duckdb | md:db" />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={async () => {
                try {
                  await ws.createWorkspace({ name: newName, active_db_path: newPath });
                  setCreating(false);
                  setNewName('');
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
