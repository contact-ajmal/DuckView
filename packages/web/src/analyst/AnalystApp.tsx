/**
 * The Analyst WebUI's shell: sign in, a thin header (DuckView, the way into the console for those whose access
 * allows more than the agent, the account), and two pages — the Agent Home (#/) and a mission (#/agent/missions/<id>).
 */
import { useEffect, useState } from 'react';
import { LogOut, SquareTerminal } from 'lucide-react';
import { useAuth } from '../store/auth';
import { useWorkspace } from '../store/workspace';
import { LoginPage } from '../features/auth/LoginPage';
import { AgentHome } from '../features/agent/home/AgentHome';
import { MissionView } from '../features/agent/mission/MissionView';
import { useMissions } from '../features/agent/missions';
import { agentApi } from '../features/agent/api';
import { Logo } from '../components/Logo';
import { IconButton, Spinner } from '../components/ui';

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
    <div className="flex h-full flex-col bg-zinc-950" data-testid="analyst-app">
      <header className="flex h-11 shrink-0 items-center gap-3 border-b border-zinc-800 px-4">
        <a href="#/" className="flex items-center gap-2 text-body font-semibold text-zinc-100" aria-label="DuckView agent home"><Logo className="h-6 w-6" /> DuckView</a>
        <div className="flex-1" />
        {caps && (
          <a href="/#/" className="inline-flex items-center gap-1.5 rounded px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-900 hover:text-zinc-50" title={caps.persona === 'viewer' ? 'The console, with your view-only access' : 'The full DuckView console'} data-testid="analyst-console">
            <SquareTerminal className="h-3.5 w-3.5" /> {caps.persona === 'viewer' ? 'Console (view only)' : 'Open the console'}
          </a>
        )}
        <span className="hidden text-2xs text-zinc-500 sm:inline">{auth.user.email}</span>
        <IconButton label="Sign out" onClick={() => auth.logout()}><LogOut className="h-3.5 w-3.5" /></IconButton>
      </header>
      <main className="min-h-0 flex-1">{mission ? <MissionView key={mission} id={mission} /> : <AgentHome />}</main>
    </div>
  );
}
