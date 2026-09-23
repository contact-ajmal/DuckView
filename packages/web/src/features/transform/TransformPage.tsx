import { useEffect, useState } from 'react';
import { useWorkspace } from '../../store/workspace';
import { DbtPanel } from './DbtPanel';
import { MetricsPanel } from './MetricsPanel';
import { QualityPanel } from './QualityPanel';

type Tab = 'dbt' | 'metrics' | 'quality';

/** Data › Models (dbt projects), Data › Metrics (the semantic layer) and Data › Quality; the section tabs are in the shell. */
export function TransformPage() {
  const ws = useWorkspace();
  const parse = (): Tab => {
    const t = /^#\/transform\/([a-z]+)/.exec(location.hash)?.[1];
    return t === 'metrics' || t === 'quality' ? t : 'dbt';
  };
  const [tab, setTab] = useState<Tab>(parse);
  useEffect(() => {
    const on = () => setTab(parse());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return (
    <div className="@container h-full min-h-0 overflow-auto">
      <div className="mx-auto max-w-[1400px] px-6 py-5">
        {ws.activeId && tab === 'dbt' && <DbtPanel key={ws.activeId} workspaceId={ws.activeId} />}
        {ws.activeId && tab === 'metrics' && <MetricsPanel key={ws.activeId} workspaceId={ws.activeId} />}
        {ws.activeId && tab === 'quality' && <QualityPanel key={ws.activeId} workspaceId={ws.activeId} />}
      </div>
    </div>
  );
}
