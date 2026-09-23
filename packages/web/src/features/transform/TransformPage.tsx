import { useEffect, useState } from 'react';
import { Workflow } from 'lucide-react';
import { useWorkspace } from '../../store/workspace';
import { Eyebrow, PageTitle } from '../../components/layout';
import { cn } from '../../components/ui';
import { DbtPanel } from './DbtPanel';
import { MetricsPanel } from './MetricsPanel';

type Tab = 'dbt' | 'metrics';
const TABS: { id: Tab; label: string }[] = [{ id: 'dbt', label: 'dbt projects' }, { id: 'metrics', label: 'Metrics' }];

/** #/transform — turning raw tables into modelled ones (dbt projects) and metrics defined once (the semantic layer). */
export function TransformPage() {
  const ws = useWorkspace();
  const parse = (): Tab => (/^#\/transform\/([a-z]+)/.exec(location.hash)?.[1] as Tab | undefined) ?? 'dbt';
  const [tab, setTab] = useState<Tab>(parse);
  useEffect(() => {
    const on = () => setTab(parse());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return (
    <div className="h-full min-h-0 overflow-auto">
      <div className="mx-auto max-w-7xl space-y-4 p-5 pb-16">
        <div>
          <Eyebrow>Model</Eyebrow>
          <PageTitle><span className="inline-flex items-center gap-2"><Workflow className="h-5 w-5 text-accent-300" /> Transform</span></PageTitle>
          <p className="mt-1 text-xs text-zinc-500">Raw tables into tested, documented models — and metrics everyone computes the same way — in <b className="text-zinc-300">{ws.workspaces.find((w) => w.id === ws.activeId)?.name ?? 'the active workspace'}</b>.</p>
        </div>
        <div className="flex gap-1 border-b border-zinc-800 text-xs">
          {TABS.map((t) => <button key={t.id} onClick={() => (location.hash = `#/transform/${t.id}`)} className={cn('-mb-px border-b-2 px-3 py-1.5', tab === t.id ? 'border-accent-500 text-zinc-100' : 'border-transparent text-zinc-500 hover:text-zinc-200')}>{t.label}</button>)}
        </div>
        {ws.activeId && tab === 'dbt' && <DbtPanel key={ws.activeId} workspaceId={ws.activeId} />}
        {ws.activeId && tab === 'metrics' && <MetricsPanel key={ws.activeId} workspaceId={ws.activeId} />}
      </div>
    </div>
  );
}
