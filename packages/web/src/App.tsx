import { useEffect, useState } from 'react';
import { useAuth } from './store/auth';
import { useWorkspace } from './store/workspace';
import { LoginPage } from './features/auth/LoginPage';
import { HomePage } from './features/home/HomePage';
import { OverviewPage } from './features/overview/OverviewPage';
import { NotebooksPage } from './features/notebooks/NotebooksPage';
import { WorkspacePage } from './features/workspace/WorkspacePage';
import { SettingsPage } from './features/settings/SettingsPage';
import { McpPage } from './features/mcp/McpPage';
import { DashboardsPage } from './features/dashboards/DashboardsPage';
import { ConnectionsPage } from './features/connections/ConnectionsPage';
import { AppsPage } from './features/apps/AppsPage';
import { TemplatesPage } from './features/templates/TemplatesPage';
import { AlertsPage } from './features/alerts/AlertsPage';
import { GovernancePage } from './features/governance/GovernancePage';
import { TransformPage } from './features/transform/TransformPage';
import { SnapshotView } from './features/dashboards/SnapshotView';
import { CopilotDrawer } from './features/copilot/CopilotDrawer';
import { AgentHome } from './features/agent/home/AgentHome';
import { MissionView } from './features/agent/mission/MissionView';
import { useMissions } from './features/agent/missions';
import { agentApi } from './features/agent/api';
import { usePageContext } from './store/context';
import { takePendingConsoleSql } from './features/agent/surface';
import { ShareDialog } from './features/workspace/ShareDialog';
import { CreateWorkspaceWizard } from './features/workspace/CreateWorkspaceWizard';
import { WorkspaceDetailPage } from './features/workspace/WorkspaceDetailPage';
import { ComparePage } from './features/overview/ComparePage';
import { Sidebar } from './components/shell/Sidebar';
import { TopBar } from './components/shell/TopBar';
import { SectionNav } from './components/shell/SectionNav';
import { CommandPalette } from './components/shell/CommandPalette';
import { parseRoute, type Route } from './app/routes';
import { Spinner } from './components/ui';

export default function App() {
  const auth = useAuth();
  const ws = useWorkspace();
  const [route, setRoute] = useState<Route>(() => parseRoute());
  const [creating, setCreating] = useState(false);
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

  // A SQL tab the Analyst WebUI asked the console to open.
  useEffect(() => {
    if (!ws.activeId) return;
    const pending = takePendingConsoleSql();
    if (pending) void ws.addTab({ title: pending.title, sql: pending.sql });
  }, [ws.activeId]); // eslint-disable-line react-hooks/exhaustive-deps
  // ⌘I from anywhere: to the agent, with what is on screen offered as context.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'i') return;
      e.preventDefault();
      const o = usePageContext.getState().object;
      if (o && o.kind !== 'agent') useMissions.getState().setCarried({ kind: o.kind, id: o.id ?? null, label: o.label });
      location.hash = '#/';
      setTimeout(() => window.dispatchEvent(new Event('duckview:agent-focus')), 50);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  // #/?agent_task=<id> (an approval link from the inbox or another agent): open that task's mission.
  useEffect(() => {
    const m = /[?&]agent_task=([\w-]+)/.exec(location.hash);
    if (!m || !auth.user) return;
    void agentApi.task(m[1]!).then((t) => {
      location.hash = `#/agent/missions/${t.session_id}`;
    }).catch(() => undefined);
  }, [route, auth.user?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (auth.loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="h-6 w-6" />
      </div>
    );
  }
  if (!auth.user) return <LoginPage />;
  // A dashboard alone, for scheduled snapshots (a headless browser captures it).
  if (location.hash.startsWith('#/snapshot/')) return <SnapshotView />;

  const active = ws.workspaces.find((w) => w.id === ws.activeId);
  const page = route.page;
  const missionId = page === 'agent' ? /^#\/agent\/missions\/([\w-]+)/.exec(location.hash)?.[1] ?? null : null;

  return (
    <div className="flex h-full">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-[70] focus:rounded focus:bg-zinc-950 focus:px-3 focus:py-2">Skip to content</a>
      <Sidebar active={route.section} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar route={route} onNewWorkspace={() => setCreating(true)} onShare={() => setSharing(true)} />
        <SectionNav route={route} />
        <div className="flex min-h-0 flex-1">
          <main id="main" className="@container min-h-0 min-w-0 flex-1 overflow-hidden bg-zinc-950">
            {page === 'agent' && (missionId ? <MissionView key={missionId} id={missionId} /> : <AgentHome />)}
            {page === 'home' && <HomePage onNewWorkspace={() => setCreating(true)} />}
            {page === 'data' && <OverviewPage />}
            {page === 'query' && <WorkspacePage />}
            {page === 'notebooks' && <NotebooksPage />}
            {page === 'dashboards' && <DashboardsPage />}
            {page === 'connections' && <ConnectionsPage />}
            {page === 'apps' && <AppsPage />}
            {page === 'alerts' && <AlertsPage />}
            {page === 'governance' && <GovernancePage />}
            {page === 'transform' && <TransformPage />}
            {page === 'settings' && <SettingsPage />}
            {page === 'mcp' && <McpPage />}
            {page === 'templates' && <TemplatesPage />}
            {page === 'workspace' && <WorkspaceDetailPage />}
            {page === 'compare' && <ComparePage />}
          </main>
          <CopilotDrawer />
        </div>
      </div>
      <CommandPalette />

      <ShareDialog open={sharing} onClose={() => setSharing(false)} workspace={active ?? null} />

      <CreateWorkspaceWizard open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}
