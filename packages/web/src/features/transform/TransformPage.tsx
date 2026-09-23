import { useEffect, useState } from 'react';
import { useWorkspace } from '../../store/workspace';
import { DbtPanel } from './DbtPanel';
import { MetricsPanel } from './MetricsPanel';

type Tab = 'dbt' | 'metrics';

/** Data › Models (dbt projects) and Data › Metrics (the semantic layer); the section tabs are in the shell. */
export function TransformPage() {
  const ws = useWorkspace();
  const parse = (): Tab => ((/^#\/transform\/([a-z]+)/.exec(location.hash)?.[1] as Tab | undefined) === 'metrics' ? 'metrics' : 'dbt');
  const [tab, setTab] = useState<Tab>(parse);
  useEffect(() => {
    const on = () => setTab(parse());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return (
    <div className="h-full min-h-0 overflow-auto">
      <div className="mx-auto max-w-[1400px] px-6 py-5">
        {ws.activeId && tab === 'dbt' && <DbtPanel key={ws.activeId} workspaceId={ws.activeId} />}
        {ws.activeId && tab === 'metrics' && <MetricsPanel key={ws.activeId} workspaceId={ws.activeId} />}
      </div>
    </div>
  );
}
