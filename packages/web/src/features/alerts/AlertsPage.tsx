import { useEffect, useState } from 'react';
import { useWorkspace } from '../../store/workspace';
import { Segmented } from '../../components/ui';
import { ChannelsPanel } from './ChannelsPanel';
import { AlertsPanel } from './AlertsPanel';
import { SnapshotsPanel } from './SnapshotsPanel';

type Tab = 'alerts' | 'snapshots' | 'channels';

/** Build › Alerts: alerts, scheduled snapshots and the channels both deliver to — one tab in the shell, three views here. */
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
      <div className="mx-auto max-w-[1400px] px-6 py-5 max-sm:px-4">
        <Segmented<Tab>
          label="Alerts and delivery"
          className="mb-4"
          value={tab}
          onChange={(t) => (location.hash = `#/alerts/${t}`)}
          options={[{ id: 'alerts', label: 'Alerts' }, { id: 'snapshots', label: 'Snapshots' }, { id: 'channels', label: 'Channels' }]}
          testid="alerts-views"
        />
        {ws.activeId && tab === 'alerts' && <AlertsPanel workspaceId={ws.activeId} />}
        {ws.activeId && tab === 'snapshots' && <SnapshotsPanel workspaceId={ws.activeId} />}
        {ws.activeId && tab === 'channels' && <ChannelsPanel workspaceId={ws.activeId} />}
      </div>
    </div>
  );
}
