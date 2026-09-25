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

  return (
    <div className="flex h-full">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-[70] focus:rounded focus:bg-zinc-950 focus:px-3 focus:py-2">Skip to content</a>
      <Sidebar active={route.section} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar route={route} onNewWorkspace={() => setCreating(true)} onShare={() => setSharing(true)} />
        <SectionNav route={route} />
        <div className="flex min-h-0 flex-1">
          <main id="main" className="@container min-h-0 min-w-0 flex-1 overflow-hidden bg-zinc-950">
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
