/**
 * The Analyst WebUI's shell: sign in, a thin header (DuckView, the way into the console for those whose access
 * allows more than the agent, the account), and two pages — the Agent Home (#/) and a mission (#/agent/missions/<id>).
 */
import { useEffect, useState } from 'react';
import { SquareTerminal } from 'lucide-react';
import { useAuth } from '../store/auth';
import { useWorkspace } from '../store/workspace';
import { LoginPage } from '../features/auth/LoginPage';
import { AgentHome } from '../features/agent/home/AgentHome';
import { MissionView } from '../features/agent/mission/MissionView';
import { useMissions } from '../features/agent/missions';
import { agentApi } from '../features/agent/api';
import { Logo } from '../components/Logo';
import { Spinner } from '../components/ui';
import { ProfileMenu } from '../components/shell/AccountMenu';

const missionOf = (hash: string) => /^#\/agent\/missions\/([\w-]+)/.exec(hash)?.[1] ?? null;

export function AnalystApp() {
  const auth = useAuth();
  const ws = useWorkspace();
  const caps = useMissions((s) => s.home?.capabilities ?? null);
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const on = () => setHash(location.hash);
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  useEffect(() => void auth.init(), []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (auth.user) void ws.loadWorkspaces();
  }, [auth.user?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  // An approval link: open its mission.
  useEffect(() => {
    const m = /[?&]agent_task=([\w-]+)/.exec(hash);
    if (m && auth.user) void agentApi.task(m[1]!).then((t) => (location.hash = `#/agent/missions/${t.session_id}`)).catch(() => undefined);
  }, [hash, auth.user?.id]);

  if (auth.loading) return <div className="flex h-full items-center justify-center"><Spinner className="h-6 w-6" /></div>;
  if (!auth.user) return <LoginPage />;
  const mission = missionOf(hash);
  return (
    <div className="flex h-full flex-col bg-canvas" data-testid="analyst-app">
      <header className="flex h-[var(--topbar-h)] shrink-0 items-center gap-3 border-b border-line bg-canvas px-4 max-sm:px-3">
        <a href="#/" className="flex h-6 items-center" aria-label="DuckView agent home"><Logo variant="full" className="h-6" /></a>
        <div className="flex-1" />
        {caps && (
          <a href="/#/" className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-fg-secondary transition-colors duration-[var(--dur-fast)] hover:bg-hover hover:text-fg" title={caps.persona === 'viewer' ? 'The console, with your view-only access' : 'The full DuckView console'} data-testid="analyst-console">
            <SquareTerminal className="h-3.5 w-3.5" /> {caps.persona === 'viewer' ? 'Console (view only)' : 'Open the console'}
          </a>
        )}
        <ProfileMenu console={false} />
      </header>
      <main className="min-h-0 flex-1">{mission ? <MissionView key={mission} id={mission} /> : <AgentHome />}</main>
    </div>
  );
}
