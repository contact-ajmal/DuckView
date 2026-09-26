/**
 * A mission's workspace (#/agent/missions/<id>). While the agent works and has made nothing yet, the page is the
 * request and its progress: the plan, and what is happening in words. As results arrive it becomes a workspace: the
 * summary and findings, charts and tables, the objects made — with the mission's progress, its context (what the
 * person chose, what the agent found) and its activity alongside. The composer at the bottom continues the mission.
 *
 * Never shown: the model's reasoning. Shown: decisions, calls, observations and results.
 */
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowUp, Archive, CheckCircle2, Circle, CircleDot, Copy, Database, Plus, Share2, Square } from 'lucide-react';
import { ApprovalCard, Markdown, ToolStep, type ToolStepData } from '../../../components/ai';
import { Button, ErrorState, IconButton, Skeleton, StatusDot, Textarea, cn } from '../../../components/ui';
import { usePageObject } from '../../../store/context';
import { useWorkspace } from '../../../store/workspace';
import type { Mission, MissionArtifact, PlanStep, StepRecord } from '../api';
import { useMissions, openInConsole } from '../missions';
import { MISSION_STATUS, ProgressBar } from '../home/MissionList';
import { Findings, ObjectArtifact, ResultArtifact } from './Artifacts';
import { consoleHref } from '../surface';

function toStep(s: StepRecord): ToolStepData | null {
  if ((s.kind !== 'tool' && s.kind !== 'approval' && s.kind !== 'action') || !s.tool) return null;
  return { tool: s.tool, args: s.arguments, status: s.status === 'ok' ? 'ok' : s.status === 'approval_required' ? 'approval_required' : 'error', summary: s.summary, durationMs: s.duration_ms ?? null };
}

function Plan({ plan, working }: { plan: PlanStep[]; working: boolean }) {
  if (!plan.length) return null;
  return (
    <ol className="space-y-1" aria-label="Plan" data-testid="mission-plan">
      {plan.map((p, i) => (
        <li key={i} className={cn('flex items-start gap-2 text-xs', p.status === 'done' ? 'text-zinc-400' : p.status === 'active' ? 'text-zinc-100' : 'text-zinc-500')} data-status={p.status}>
          {p.status === 'done' ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" /> : p.status === 'active' && working ? <CircleDot className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-pulse text-accent-400 motion-reduce:animate-none" /> : <Circle className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
          <span className="min-w-0">{p.text}</span>
        </li>
      ))}
    </ol>
  );
}

export function MissionView({ id }: { id: string }) {
  const s = useMissions();
  const ws = useWorkspace();
  const [text, setText] = useState('');
  const input = useRef<HTMLTextAreaElement>(null);
  const m = s.mission?.id === id ? s.mission : null;
  usePageObject(m ? { kind: 'agent', id: m.id, label: m.title } : null);
  useEffect(() => {
    void s.open(id);
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  // The mission's workspace becomes the console's, so "Open in console" lands there.
  useEffect(() => {
    if (m && ws.activeId !== m.workspace_id && ws.workspaces.some((w) => w.id === m.workspace_id)) void ws.selectWorkspace(m.workspace_id);
  }, [m?.workspace_id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (s.missionError) return <div className="p-6"><ErrorState error={s.missionError} onRetry={() => void s.open(id)} title="This mission could not be opened" /></div>;
  if (!m) return <div className="mx-auto max-w-5xl space-y-4 p-6"><Skeleton className="h-8 w-80" /><Skeleton className="h-64" /></div>;

  const last = m.tasks.at(-1);
  const working = m.status === 'running' || m.status === 'planning';
  const [tone, word] = MISSION_STATUS[m.status];
  const all: MissionArtifact[] = m.tasks.flatMap((t) => t.artifacts);
  const results = all.filter((a) => a.type === 'table');
  const objects = all.filter((a) => a.type !== 'table' && a.type !== 'finding' && a.type !== 'dataset');
  const findings = m.tasks.flatMap((t) => t.artifacts.filter((a) => a.type === 'finding').flatMap((a) => (a.data?.items as string[] | undefined) ?? []));
  const lastFindings = last?.artifacts.filter((a) => a.type === 'finding').flatMap((a) => (a.data?.items as string[] | undefined) ?? []) ?? [];
  const summary = last?.answer ?? (working ? s.draft : null);
  const showWorkspace = results.length > 0 || objects.length > 0 || findings.length > 0 || (!!summary && !working);
  const mine = m.owner.mine;
  const steps = m.tasks.flatMap((t) => t.steps.map(toStep).filter((x): x is ToolStepData => !!x));
  const waiting = last?.status === 'waiting_approval' && last.approval && !last.approval.decision ? last : null;
  const send = async () => {
    const r = text.trim();
    if (!r || working) return;
    setText('');
    await s.send(r);
  };

  const approval = waiting && (
    <ApprovalCard
      title="The agent wants to make a change"
      reason={waiting.approval!.reason}
      statements={waiting.approval!.preview ? [{ verb: waiting.approval!.verb || waiting.approval!.tool, preview: waiting.approval!.preview, destructive: /DROP|DELETE|TRUNCATE|ALTER/.test(waiting.approval!.verb ?? '') }] : []}
      requester={mine ? 'Nothing has changed yet. Approving runs exactly this, as you.' : 'Waiting for the person who started this mission.'}
      onApprove={mine && m.capabilities.agent.approve ? () => void s.decide(waiting.id, 'approve') : undefined}
      onDeny={mine ? () => void s.decide(waiting.id, 'deny') : undefined}
      approveLabel="Approve"
    >
      {mine && !m.capabilities.agent.approve && <p className="mt-2 text-2xs text-zinc-500">Your access here is read-only: you can decline, not approve.</p>}
    </ApprovalCard>
  );

  const activity = (
    <div className="space-y-1" data-testid="mission-activity">
      {s.live.length > 0 && working
        ? s.live.map((l) => (
            <div key={l.id} className={cn('flex items-start gap-2 text-xs', l.state === 'error' ? 'text-red-300' : l.state === 'warn' ? 'text-amber-400' : l.state === 'active' ? 'text-zinc-100' : 'text-zinc-400')} data-testid="mission-live">
              {l.state === 'active' ? <CircleDot className="mt-0.5 h-3 w-3 shrink-0 animate-pulse text-accent-400 motion-reduce:animate-none" /> : l.state === 'done' ? <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-emerald-400" /> : <Circle className="mt-0.5 h-3 w-3 shrink-0" />}
              <span className="min-w-0">{l.text}</span>
            </div>
          ))
        : steps.length > 0 && <ol className="space-y-0.5" aria-label="Steps">{steps.map((st, i) => <ToolStep key={i} step={st} />)}</ol>}
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="mission-view" data-status={m.status}>
      {/* Header: back to the agent, the mission, where it works, and what can be done with it. */}
      <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-zinc-800 px-5 py-2.5">
        <a href="#/" className="inline-flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-100" data-testid="mission-back"><ArrowLeft className="h-3.5 w-3.5" /> Agent</a>
        <span className="h-4 w-px bg-zinc-800" aria-hidden />
        <h1 className="min-w-0 flex-1 truncate text-title font-semibold text-zinc-50" data-testid="mission-title">{m.title}</h1>
        <span className="hidden text-2xs text-zinc-500 md:inline">{ws.workspaces.find((w) => w.id === m.workspace_id)?.name}</span>
        <StatusDot tone={tone} pulse={tone === 'busy'} data-testid="mission-status">{word}</StatusDot>
        <div className="flex items-center gap-0.5">
          {working && mine && <Button size="sm" variant="ghost" onClick={() => void s.cancel()} data-testid="mission-stop"><Square className="h-3.5 w-3.5" /> Stop</Button>}
          {mine && <IconButton label={m.visibility === 'workspace' ? 'Shared with the workspace: make private' : 'Share with the workspace'} active={m.visibility === 'workspace'} onClick={() => void s.update({ visibility: m.visibility === 'workspace' ? 'private' : 'workspace' })} data-testid="mission-share"><Share2 className="h-3.5 w-3.5" /></IconButton>}
          <IconButton label="Duplicate" onClick={() => void s.duplicate()}><Copy className="h-3.5 w-3.5" /></IconButton>
          {mine && <IconButton label={m.archived ? 'Restore' : 'Archive'} onClick={() => void s.update({ archived: !m.archived })}><Archive className="h-3.5 w-3.5" /></IconButton>}
          <IconButton label="New mission" onClick={() => (location.hash = '#/')}><Plus className="h-3.5 w-3.5" /></IconButton>
        </div>
        <ProgressBar value={m.progress} status={m.status} className="basis-full" />
      </header>

      <div className="min-h-0 flex-1 overflow-auto">
        {!showWorkspace ? (
          /* State 2: working — the request and its progress, nothing else competing. */
          <div className="mx-auto max-w-2xl px-6 py-10 max-sm:px-4" data-testid="mission-working">
            <p className="text-title font-semibold text-zinc-100" data-testid="mission-request">{last?.request ?? m.title}</p>
            <div className="mt-5 rounded-lg border border-zinc-800 p-4">
              <div className="mb-3 flex items-center gap-2 text-xs text-zinc-400"><span className="font-semibold text-zinc-200">Agent</span>{last?.status === 'failed' && <span className="text-red-300">{last.error}</span>}</div>
              <Plan plan={last?.plan ?? []} working={working} />
              <div className="mt-4 border-t border-zinc-800/70 pt-3">{activity}</div>
            </div>
            {approval && <div className="mt-4">{approval}</div>}
            {m.status === 'new' && mine && <Button className="mt-4" variant="primary" onClick={() => void s.send(m.title)}>Start this mission</Button>}
          </div>
        ) : (
          /* State 3: the mission's workspace. */
          <div className="grid gap-6 px-5 py-5 max-sm:px-3 lg:grid-cols-[minmax(0,1fr)_18rem]">
            <main className="min-w-0 space-y-4" aria-label="Results" data-testid="mission-results">
              {approval}
              {m.restricted && <p className="rounded-md border border-zinc-800 px-3 py-2 text-xs text-zinc-400" data-testid="mission-restricted">You see this shared mission under your own access: its answers and results are hidden until you run them as yourself.</p>}
              {summary && (
                <section className="min-w-0 text-body text-zinc-200" aria-label="Summary" data-testid="mission-summary">
                  {lastFindings.length ? <p className="text-zinc-300">{summary.split('\n').find((l) => l.trim() && !/^\s*([-*•]|\d+[.)])\s/.test(l))?.replace(/\*\*/g, '') ?? ''}</p> : <Markdown onOpenSql={(sql) => openInConsole({ action: 'open_query', args: { sql, title: m.title } })}>{summary}</Markdown>}
                </section>
              )}
              <Findings items={lastFindings.length ? lastFindings : findings.slice(-8)} />
              <div className="grid gap-4 xl:grid-cols-2" data-testid="artifact-grid">
                {results.map((a) => <ResultArtifact key={a.id} a={a} onAsk={(t) => { setText(t); input.current?.focus(); }} />)}
              </div>
              {objects.length > 0 && <div className="grid gap-2 md:grid-cols-2">{objects.map((a) => <ObjectArtifact key={a.id} a={a} />)}</div>}
            </main>
            <aside className="min-w-0 space-y-5 text-xs" aria-label="Mission">
              <section>
                <h2 className="mb-2 text-xs font-semibold text-zinc-200">Progress</h2>
                <Plan plan={last?.plan ?? []} working={working} />
              </section>
              <Context mission={m} />
              <section>
                <h2 className="mb-2 text-xs font-semibold text-zinc-200">Activity</h2>
                {activity}
              </section>
              {m.tasks.length > 1 && (
                <section>
                  <h2 className="mb-2 text-xs font-semibold text-zinc-200">Requests</h2>
                  <ol className="space-y-1 text-zinc-400">{m.tasks.map((t) => <li key={t.id} className="truncate" title={t.request}>{t.request}</li>)}</ol>
                </section>
              )}
            </aside>
          </div>
        )}
      </div>

      {/* Continue the mission. */}
      {mine ? (
        <form className="shrink-0 border-t border-zinc-800 px-5 py-2.5 max-sm:px-3" onSubmit={(e) => { e.preventDefault(); void send(); }}>
          <div className="mx-auto flex max-w-4xl items-end gap-2 rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-1.5 focus-within:border-zinc-700">
            <Textarea
              ref={input}
              variant="bare"
              rows={1}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              placeholder={working ? 'The agent is working…' : waiting ? 'Waiting for your approval above…' : 'Continue the mission: "Build a dashboard from this", "Break it down by month"…'}
              disabled={working || !!waiting}
              aria-label="Continue the mission"
              className="max-h-32 py-1"
              data-testid="mission-prompt"
            />
            <Button type="submit" variant="primary" size="sm" disabled={!text.trim() || working || !!waiting} aria-label="Send" data-testid="mission-send"><ArrowUp className="h-3.5 w-3.5" /></Button>
          </div>
        </form>
      ) : (
        <p className="shrink-0 border-t border-zinc-800 px-5 py-2.5 text-center text-2xs text-zinc-500">Shared with you. Only the person who started it can continue it; duplicate it to make your own.</p>
      )}
    </div>
  );
}

/** What the agent works on: chosen by the person, and found by the agent — kept apart. */
function Context({ mission }: { mission: Mission }) {
  const { explicit, discovered } = mission.context;
  return (
    <section data-testid="mission-context">
      <h2 className="mb-2 text-xs font-semibold text-zinc-200">Context</h2>
      {explicit.length === 0 && discovered.length === 0 && <p className="text-zinc-500">No dataset chosen; the agent looked for what fits.</p>}
      {explicit.length > 0 && (
        <div className="mb-2">
          <div className="mb-0.5 text-2xs text-zinc-500">You chose</div>
          <ul>{explicit.map((d) => <li key={d} className="flex items-center gap-1.5 py-0.5 font-mono text-zinc-200" data-testid="context-explicit"><CheckCircle2 className="h-3 w-3 shrink-0 text-emerald-400" /><a href={consoleHref(`#/data?table=${encodeURIComponent(d)}`)} className="truncate hover:underline">{d}</a></li>)}</ul>
        </div>
      )}
      {discovered.length > 0 && (
        <div>
          <div className="mb-0.5 text-2xs text-zinc-500">The agent found</div>
          <ul>{discovered.map((d) => <li key={d} className="flex items-center gap-1.5 py-0.5 font-mono text-zinc-300" data-testid="context-discovered"><Database className="h-3 w-3 shrink-0 text-zinc-500" /><a href={consoleHref(`#/data?table=${encodeURIComponent(d)}`)} className="truncate hover:underline">{d}</a></li>)}</ul>
        </div>
      )}
    </section>
  );
}
