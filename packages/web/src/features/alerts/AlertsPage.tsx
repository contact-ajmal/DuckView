import { useEffect, useState } from 'react';
import { useWorkspace } from '../../store/workspace';
import { ChannelsPanel } from './ChannelsPanel';
import { AlertsPanel } from './AlertsPanel';
import { SnapshotsPanel } from './SnapshotsPanel';

type Tab = 'alerts' | 'snapshots' | 'channels';

/** Dashboards › Alerts, Snapshots and Channels; the section tabs are in the shell. */
export function AlertsPage() {
  const ws = useWorkspace();
  const parse = (): Tab => (/^#\/alerts\/([a-z]+)/.exec(location.hash)?.[1] as Tab | undefined) ?? 'alerts';
  const [tab, setTab] = useState<Tab>(parse);
  useEffect(() => {
    const on = () => setTab(parse());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return (
    <div className="h-full min-h-0 overflow-auto">
      <div className="mx-auto max-w-[1400px] px-6 py-5">
        {ws.activeId && tab === 'alerts' && <AlertsPanel workspaceId={ws.activeId} />}
        {ws.activeId && tab === 'snapshots' && <SnapshotsPanel workspaceId={ws.activeId} />}
        {ws.activeId && tab === 'channels' && <ChannelsPanel workspaceId={ws.activeId} />}
      </div>
    </div>
  );
}
