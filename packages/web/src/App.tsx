import { useEffect, useState } from 'react';
import { LogOut, Plus, ChevronDown } from 'lucide-react';
import { useAuth } from './store/auth';
import { useWorkspace } from './store/workspace';
import { api, formatBytes, type SystemInfo, type LiveStats } from './api/client';
import { LoginPage } from './features/auth/LoginPage';
import { OverviewPage } from './features/overview/OverviewPage';
import { WorkspacePage } from './features/workspace/WorkspacePage';
import { SettingsPage } from './features/settings/SettingsPage';
import { McpPage } from './features/mcp/McpPage';
import { DashboardsPage } from './features/dashboards/DashboardsPage';
import { CopilotDrawer } from './features/copilot/CopilotDrawer';
import { useCopilot } from './store/copilot';
import { Bot } from 'lucide-react';
import { Logo } from './components/Logo';
import { StatusPill, Tag } from './components/layout';
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

function HeaderStatus() {
  const [sys, setSys] = useState<SystemInfo | null>(null);
  const [live, setLive] = useState<LiveStats | null>(null);
  useEffect(() => {
    api.get<SystemInfo>('/api/system').then(setSys).catch(() => undefined);
    const tick = () => api.get<LiveStats>('/api/system/live').then(setLive).catch(() => undefined);
    void tick();
    const t = setInterval(tick, 5000);
    return () => clearInterval(t);
  }, []);
  const safe = !!sys && !sys.duckdb.external_access && sys.duckdb.configuration_locked;
  const headroom = live ? Math.max(0, live.duckdb.memory_limit_bytes - live.duckdb.memory_usage_bytes) : null;
  return (
    <div className="hidden items-center gap-1.5 lg:flex">
      <StatusPill dot tone="green" title="Native DuckDB engine">
        DuckDB {sys?.duckdb.version ?? '…'}
      </StatusPill>
      <StatusPill title="Logical cores available to DuckDB">{sys ? `${sys.host.cpus} cores` : '…'}</StatusPill>
      <StatusPill title="DuckDB memory ceiling minus current allocation">{headroom != null ? `${formatBytes(headroom)} headroom` : '…'}</StatusPill>
      <StatusPill dot tone={safe ? 'green' : 'amber'} title={safe ? 'Filesystem jail + external access off + configuration locked' : 'External access enabled or configuration unlocked'}>
        {safe ? 'Safe' : 'Open'}
      </StatusPill>
    </div>
  );
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
          <HeaderStatus />
          <button onClick={() => cp.toggle()} className={cn('inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs', cp.open ? 'border-accent-600/60 bg-accent-600/20 text-accent-100' : 'border-zinc-800 bg-zinc-900/70 text-zinc-300 hover:text-zinc-100')} title="DuckCopilot — context-aware AI assistant">
            <Bot className="h-3.5 w-3.5" /> Copilot
          </button>
          <div className="relative">
            <button onClick={() => setWsMenu(!wsMenu)} className="flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-900/70 px-2.5 py-1 text-xs hover:bg-zinc-800">
              <span className="h-1.5 w-1.5 rounded-full bg-accent-400" />
              <span className="font-medium text-zinc-100">{active?.name ?? 'Workspace'}</span>
              <span className="hidden font-mono text-[11px] text-zinc-500 xl:inline">{active?.active_db_path}</span>
              <ChevronDown className="h-3.5 w-3.5 text-zinc-500" />
            </button>
            {wsMenu && (
              <div className="absolute right-0 top-full z-40 mt-1 w-72 rounded-lg border border-zinc-800 bg-zinc-900 p-1 shadow-xl" onMouseLeave={() => setWsMenu(false)}>
                {ws.workspaces.map((w) => (
                  <button
                    key={w.id}
                    onClick={() => {
                      setWsMenu(false);
                      void ws.selectWorkspace(w.id);
                    }}
                    className={cn('flex w-full flex-col rounded-md px-2 py-1.5 text-left hover:bg-zinc-800', w.id === ws.activeId && 'bg-zinc-800/70')}
                  >
                    <span className="text-sm text-zinc-100">{w.name}</span>
                    <span className="font-mono text-[10px] text-zinc-500">{w.active_db_path}</span>
                  </button>
                ))}
                {auth.user.role !== 'READ_ONLY' && (
                  <button
                    onClick={() => {
                      setWsMenu(false);
                      setCreating(true);
                    }}
                    className="mt-1 flex w-full items-center gap-2 rounded-md border-t border-zinc-800 px-2 py-2 text-left text-xs text-accent-300 hover:bg-zinc-800"
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
