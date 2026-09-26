/**
 * Agent Home — where DuckView opens. The prompt is the centre: one field, and under it a compact context line (the
 * workspace · the chosen data · + Context) and five quiet intents (a hint for the same agent, not a different one).
 * Below: missions still running, with their progress, then recent work as a compact list — all from persisted
 * missions.
 *
 * The first paint needs one request (/api/agent/home: workspaces, capabilities, missions); datasets load when their
 * picker opens. Submitting starts a mission and moves to its workspace (#/agent/missions/<id>), where the request
 * stays as the heading (docs/design/agent-ui-principles.md: one continuous flow).
 */
import { useEffect, useRef, useState } from 'react';
import { ArrowUp, Compass, FlaskConical, Hammer, Lightbulb, Search, Workflow } from 'lucide-react';
import { Button, ErrorState, Kbd, Segmented, Skeleton, Textarea } from '../../../components/ui';
import { ContextChip } from '../../../components/ai';
import { useWorkspace } from '../../../store/workspace';
import { useMissions } from '../missions';
import type { MissionMode } from '../api';
import { DatasetSelector, WorkspaceSelector } from './ContextSelectors';
import { ActiveMissions, RecentMissions } from './MissionList';
import { consoleHref } from '../surface';

export const INTENTS: { mode: MissionMode; label: string; icon: typeof Search; example: string; hint: string; quick?: boolean }[] = [
  { mode: 'analyse', label: 'Analyse', icon: FlaskConical, example: 'Analyse this data for anomalies and important trends', hint: 'Find what stands out, what changed and what is off', quick: true },
  { mode: 'build', label: 'Build', icon: Hammer, example: 'Build a dashboard of revenue, conversion and retention', hint: 'Dashboards, notebooks and apps from checked queries', quick: true },
  { mode: 'investigate', label: 'Investigate', icon: Search, example: 'Why did revenue fall last month?', hint: 'Why a number moved, broken down by what drove it', quick: true },
  { mode: 'automate', label: 'Automate', icon: Workflow, example: 'Create a daily quality check for this data', hint: 'Quality checks, alerts and schedules', quick: true },
  { mode: 'explore', label: 'Explore', icon: Compass, example: 'Help me understand this data', hint: 'Its columns, its shape, how it joins to the rest', quick: true },
  { mode: 'explain', label: 'Explain', icon: Lightbulb, example: 'Explain this metric and how it is calculated', hint: 'How a metric, model or query works' },
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
  // ⌘I, ⌘K "Ask the agent" and Help "Ask how to…" land here with the composer focused (and maybe prefilled).
  useEffect(() => {
    const onFocus = (e: Event) => {
      const d = (e as CustomEvent<{ text?: string; mode?: MissionMode } | undefined>).detail;
      if (d?.mode) useMissions.getState().setMode(d.mode);
      if (d?.text) setText(d.text);
      input.current?.focus();
    };
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
  // Explain is not one of the five quick intents; it shows while chosen (from Help, or a carried metric).
  const intents = INTENTS.filter((i) => i.quick || i.mode === m.mode);

  return (
    <div className="h-full overflow-auto" data-testid="agent-home">
      <div className="mx-auto flex max-w-2xl flex-col px-6 pb-16 pt-[max(2.5rem,12vh)] max-sm:px-4 max-sm:pt-6">
        <h1 className="text-page font-semibold tracking-tight text-fg-strong">What are we working on?</h1>

        {/* The composer: the request, and — in one line under it — where the agent will work. */}
        <form
          className="mt-4 rounded-lg border border-line bg-raised transition-colors duration-[var(--dur-fast)] focus-within:border-line-strong"
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
            className="block px-4 pb-2 pt-3.5 text-body"
            data-testid="agent-prompt"
          />
          <div className="flex flex-wrap items-center gap-x-1 gap-y-1 px-2 pb-2" data-testid="agent-context-bar">
            {home ? <WorkspaceSelector workspaces={home.workspaces} /> : <Skeleton className="h-5 w-32" />}
            <span className="text-fg-faint max-sm:hidden" aria-hidden>·</span>
            <DatasetSelector selected={m.datasets} onChange={m.setDatasets} />
            {m.carried && <ContextChip kind="On screen" label={m.carried.label} onRemove={() => m.setCarried(null)} testid="agent-carried" />}
            <div className="ml-auto flex items-center gap-2">
              <span className="hidden items-center gap-0.5 text-2xs text-fg-muted sm:inline-flex" aria-hidden><Kbd>⌘</Kbd><Kbd>↵</Kbd></span>
              <Button type="submit" variant="primary" size="sm" disabled={!text.trim() || !ws.activeId} loading={busy} data-testid="agent-submit" aria-label="Start the mission">
                <ArrowUp className="h-3.5 w-3.5" /> Start
              </Button>
            </div>
          </div>
        </form>

        {/* The intent: a hint for the same agent. */}
        <Segmented<MissionMode>
          label="Intent"
          className="mt-2.5 -ml-0.5"
          value={m.mode}
          onChange={(mode) => {
            m.setMode(mode);
            input.current?.focus();
          }}
          options={intents.map((i) => ({ id: i.mode, label: i.label, title: i.hint, icon: <i.icon className="h-3.5 w-3.5" /> }))}
          testid="agent-intents"
        />

        {m.homeError ? (
          <div className="mt-12"><ErrorState error={m.homeError} onRetry={() => void m.loadHome()} /></div>
        ) : !home ? (
          <div className="mt-12 space-y-2"><Skeleton className="h-16" /><Skeleton className="h-8" /><Skeleton className="h-8" /></div>
        ) : newcomer ? (
          <section className="mt-12" aria-label="Start with your data" data-testid="agent-start">
            <h2 className="text-body font-medium text-fg">Start with your data</h2>
            <p className="mt-0.5 text-xs text-fg-muted">Nothing has run here yet. Choose data above if you like, then pick a starting point — or just ask.</p>
            <ul className="mt-3 divide-y divide-line-subtle border-y border-line-subtle">
              {INTENTS.filter((i) => i.quick).map((i) => (
                <li key={i.mode}>
                  <button
                    type="button"
                    onClick={() => {
                      m.setMode(i.mode);
                      setText(i.example);
                      input.current?.focus();
                    }}
                    className="group flex w-full items-center gap-3 px-1 py-2.5 text-left transition-colors duration-[var(--dur-fast)] hover:bg-hover"
                    data-testid="agent-start-option"
                  >
                    <i.icon className="h-4 w-4 shrink-0 text-fg-muted group-hover:text-accent-400" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-body text-fg">{i.example}</span>
                      <span className="block text-2xs text-fg-muted">{i.hint}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : (
          <div className="mt-12 space-y-8">
            {home.active.length > 0 && <ActiveMissions missions={home.active} />}
            <RecentMissions missions={home.recent} onChanged={() => void m.loadHome()} />
          </div>
        )}

        <nav className="mt-12 flex flex-wrap gap-x-4 gap-y-1 text-2xs text-fg-muted" aria-label="More">
          <a href={consoleHref('#/home')} className="hover:text-fg">Workspace overview</a>
          <a href={consoleHref('#/agents')} className="hover:text-fg">Agents & approvals{home?.approvals ? ` (${home.approvals})` : ''}</a>
        </nav>
      </div>
    </div>
  );
}
