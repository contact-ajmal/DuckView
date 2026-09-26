/**
 * Agent Home — where DuckView opens. One question, one composer, and always in view where the agent will work: the
 * workspace and the datasets. Under it, the intent (a hint to the same agent, not a different one), the missions
 * still running and the recent work, all from persisted missions.
 *
 * The first paint needs one request (/api/agent/home: workspaces, capabilities, missions); datasets load when their
 * picker opens. Submitting starts a mission and moves to its workspace (#/agent/missions/<id>).
 */
import { useEffect, useRef, useState } from 'react';
import { ArrowUp, BookOpen, Compass, FlaskConical, Hammer, Lightbulb, Search, Workflow } from 'lucide-react';
import { Button, ErrorState, Kbd, Skeleton, Textarea, cn } from '../../../components/ui';
import { useWorkspace } from '../../../store/workspace';
import { useMissions } from '../missions';
import type { MissionMode } from '../api';
import { DatasetSelector, WorkspaceSelector } from './ContextSelectors';
import { MissionList } from './MissionList';
import { consoleHref } from '../surface';

export const INTENTS: { mode: MissionMode; label: string; icon: typeof Search; example: string }[] = [
  { mode: 'analyse', label: 'Analyse', icon: FlaskConical, example: 'Analyse this data for anomalies and important trends' },
  { mode: 'build', label: 'Build', icon: Hammer, example: 'Build a dashboard of revenue, conversion and retention' },
  { mode: 'investigate', label: 'Investigate', icon: Search, example: 'Why did revenue fall last month?' },
  { mode: 'automate', label: 'Automate', icon: Workflow, example: 'Create a daily quality check for this data' },
  { mode: 'explore', label: 'Explore', icon: Compass, example: 'Help me understand this data' },
  { mode: 'explain', label: 'Explain', icon: Lightbulb, example: 'Explain this metric and how it is calculated' },
];

export function AgentHome() {
  const m = useMissions();
  const ws = useWorkspace();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    void m.loadHome();
    input.current?.focus();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // ⌘I from anywhere lands here with the composer focused.
  useEffect(() => {
    const onFocus = () => input.current?.focus();
    window.addEventListener('duckview:agent-focus', onFocus);
    return () => window.removeEventListener('duckview:agent-focus', onFocus);
  }, []);
  // A server with the agent turned off (agent.enabled: false) keeps the workspace overview as its home.
  useEffect(() => {
    if (m.home && !m.home.features.agentHome) location.replace('#/home');
  }, [m.home]);
  const intent = INTENTS.find((i) => i.mode === m.mode) ?? INTENTS[0]!;
  const home = m.home;
  const submit = async (request = text) => {
    const r = request.trim();
    if (!r || busy || !ws.activeId) return;
    setBusy(true);
    try {
      await m.start(r);
      setText('');
    } finally {
      setBusy(false);
    }
  };
  const newcomer = home && home.active.length === 0 && home.recent.length === 0;

  return (
    <div className="h-full overflow-auto" data-testid="agent-home">
      <div className="mx-auto flex max-w-3xl flex-col px-6 pb-16 pt-[max(3rem,11vh)] max-sm:px-4 max-sm:pt-8">
        <h1 className="text-display font-semibold tracking-tight text-zinc-50 max-sm:text-page">What are we working on?</h1>
        <p className="mt-1.5 text-body text-zinc-400">Ask about your data, or give the agent something to build, check or investigate. It works as you, with your access.</p>

        {/* The composer: the request, and where the agent will work. */}
        <form
          className="mt-6 rounded-lg border border-zinc-800 bg-zinc-900/60 transition-colors focus-within:border-zinc-700"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          data-testid="agent-composer"
        >
          <Textarea
            ref={input}
            variant="bare"
            rows={3}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void submit();
              }
            }}
            placeholder={`${intent.example}…`}
            aria-label="Ask the agent"
            className="block px-4 pb-2 pt-3.5"
            data-testid="agent-prompt"
          />
          {m.carried && (
            <div className="px-4 pb-1 text-2xs text-zinc-500">
              From your screen: <span className="font-mono text-zinc-300">{m.carried.label}</span>
              <button type="button" className="ml-1.5 text-zinc-500 underline hover:text-zinc-200" onClick={() => m.setCarried(null)}>leave out</button>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-x-1 gap-y-1 border-t border-zinc-800/70 px-2.5 py-1.5" data-testid="agent-context-bar">
            {home ? <WorkspaceSelector workspaces={home.workspaces} /> : <Skeleton className="h-5 w-40" />}
            <span className="h-4 w-px bg-zinc-800 max-sm:hidden" aria-hidden />
            <DatasetSelector selected={m.datasets} onChange={m.setDatasets} />
            <div className="ml-auto flex items-center gap-2">
              <span className="hidden text-2xs text-zinc-500 sm:inline"><Kbd>⌘</Kbd> <Kbd>↵</Kbd></span>
              <Button type="submit" variant="primary" size="sm" disabled={!text.trim() || !ws.activeId} loading={busy} data-testid="agent-submit" aria-label="Start the mission">
                <ArrowUp className="h-3.5 w-3.5" /> Start
              </Button>
            </div>
          </div>
        </form>

        {/* The intent: a hint for the same agent. */}
        <div className="mt-3 flex flex-wrap gap-1.5" role="radiogroup" aria-label="Intent" data-testid="agent-intents">
          {INTENTS.map((i) => (
            <button
              key={i.mode}
              type="button"
              role="radio"
              aria-checked={m.mode === i.mode}
              onClick={() => {
                m.setMode(i.mode);
                input.current?.focus();
              }}
              className={cn('inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-500', m.mode === i.mode ? 'border-zinc-600 bg-zinc-800/80 text-zinc-50' : 'border-zinc-800 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200')}
              data-testid="agent-intent"
              data-mode={i.mode}
            >
              <i.icon className={cn('h-3.5 w-3.5', m.mode === i.mode ? 'text-accent-400' : 'text-zinc-500')} /> {i.label}
            </button>
          ))}
        </div>

        {m.homeError ? (
          <div className="mt-10"><ErrorState error={m.homeError} onRetry={() => void m.loadHome()} /></div>
        ) : !home ? (
          <div className="mt-12 grid gap-8 sm:grid-cols-2"><Skeleton className="h-40" /><Skeleton className="h-40" /></div>
        ) : newcomer ? (
          <section className="mt-12 border-t border-zinc-800 pt-6" aria-label="Start with your data" data-testid="agent-start">
            <h2 className="text-body font-semibold text-zinc-100">Start with your data</h2>
            <p className="mt-0.5 text-xs text-zinc-500">Choose a workspace and a dataset above, then pick a starting point.</p>
            <ul className="mt-3 grid gap-1 sm:grid-cols-2">
              {[
                ['analyse', 'Analyse your data', 'Find what stands out, what changed and what is off'],
                ['build', 'Build a dashboard', 'From checked queries and your defined metrics'],
                ['investigate', 'Investigate a problem', 'Why a number moved, broken down by what drove it'],
                ['automate', 'Create a data quality check', 'Nulls, duplicates, freshness — checked on a schedule'],
                ['explore', 'Explore a dataset', 'Its columns, its shape, how it joins to the rest'],
              ].map(([mode, title, hint]) => (
                <li key={mode}>
                  <button type="button" onClick={() => { m.setMode(mode as MissionMode); setText(INTENTS.find((i) => i.mode === mode)!.example); input.current?.focus(); }} className="flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left hover:bg-zinc-900 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-500">
                    <BookOpen className="mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-500" />
                    <span><span className="block text-xs font-medium text-zinc-100">{title}</span><span className="block text-2xs text-zinc-500">{hint}</span></span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : (
          <div className="mt-12 grid gap-8 border-t border-zinc-800 pt-6 sm:grid-cols-2">
            <MissionList title="Active missions" missions={home.active} empty="Nothing running. Missions you start keep working here while you do other things." testid="agent-active" />
            <MissionList title="Recent work" missions={home.recent} empty="Finished missions appear here, with what they made." testid="agent-recent" />
          </div>
        )}

        <nav className="mt-10 flex flex-wrap gap-x-4 gap-y-1 text-2xs text-zinc-500" aria-label="More">
          <a href={consoleHref('#/home')} className="hover:text-zinc-200">Workspace overview</a>
          <a href={consoleHref('#/agents')} className="hover:text-zinc-200">Agents and approvals</a>
          <a href={consoleHref('#/settings/agents')} className="hover:text-zinc-200">Connect other agents (MCP)</a>
        </nav>
      </div>
    </div>
  );
}
