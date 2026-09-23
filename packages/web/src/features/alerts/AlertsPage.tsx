import { useEffect, useState } from 'react';
import { Bell } from 'lucide-react';
import { useWorkspace } from '../../store/workspace';
import { Eyebrow, PageTitle } from '../../components/layout';
import { cn } from '../../components/ui';
import { ChannelsPanel } from './ChannelsPanel';

type Tab = 'channels';
const TABS: { id: Tab; label: string }[] = [{ id: 'channels', label: 'Channels' }];

/** #/alerts — alerts, scheduled snapshots and the channels they are delivered to. */
export function AlertsPage() {
  const ws = useWorkspace();
  const parse = (): Tab => (/^#\/alerts\/([a-z]+)/.exec(location.hash)?.[1] as Tab | undefined) ?? 'channels';
  const [tab, setTab] = useState<Tab>(parse);
  useEffect(() => {
    const on = () => setTab(parse());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return (
    <div className="h-full min-h-0 overflow-auto">
      <div className="mx-auto max-w-6xl space-y-4 p-5 pb-16">
        <div>
          <Eyebrow>Deliver</Eyebrow>
          <PageTitle><span className="inline-flex items-center gap-2"><Bell className="h-5 w-5 text-accent-300" /> Alerts</span></PageTitle>
          <p className="mt-1 text-xs text-zinc-500">Tell people when the data says so — in Slack, Teams, email, PagerDuty or your own webhook — for <b className="text-zinc-300">{ws.workspaces.find((w) => w.id === ws.activeId)?.name ?? 'the active workspace'}</b>.</p>
        </div>
        <div className="flex gap-1 border-b border-zinc-800 text-xs">
          {TABS.map((t) => <button key={t.id} onClick={() => (location.hash = `#/alerts/${t.id}`)} className={cn('-mb-px border-b-2 px-3 py-1.5', tab === t.id ? 'border-accent-500 text-zinc-100' : 'border-transparent text-zinc-500 hover:text-zinc-200')}>{t.label}</button>)}
        </div>
        {ws.activeId && tab === 'channels' && <ChannelsPanel workspaceId={ws.activeId} />}
      </div>
    </div>
  );
}
