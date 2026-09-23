import { useEffect, useState } from 'react';
import { Landmark } from 'lucide-react';
import { useWorkspace } from '../../store/workspace';
import { Eyebrow, PageTitle } from '../../components/layout';
import { cn } from '../../components/ui';
import { PoliciesPanel } from './PoliciesPanel';
import { CatalogPanel } from './CatalogPanel';
import { LineagePanel } from './LineagePanel';
import { AuditPanel } from './AuditPanel';
import { ProvisioningPanel } from './ProvisioningPanel';
import { useAuth } from '../../store/auth';

type Tab = 'catalog' | 'lineage' | 'policies' | 'audit' | 'provisioning';
const TABS: { id: Tab; label: string }[] = [{ id: 'catalog', label: 'Catalog' }, { id: 'lineage', label: 'Lineage' }, { id: 'policies', label: 'Access policies' }, { id: 'audit', label: 'Audit' }, { id: 'provisioning', label: 'Provisioning' }];

/** #/governance — who may see what, and (later) where data comes from and who touched it. */
export function GovernancePage() {
  const ws = useWorkspace();
  const isAdmin = useAuth((a) => a.user?.role === 'ADMIN');
  const active = ws.workspaces.find((w) => w.id === ws.activeId);
  const parse = (): Tab => (/^#\/governance\/([a-z]+)/.exec(location.hash)?.[1] as Tab | undefined) ?? 'catalog';
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
          <Eyebrow>Govern</Eyebrow>
          <PageTitle><span className="inline-flex items-center gap-2"><Landmark className="h-5 w-5 text-accent-300" /> Governance</span></PageTitle>
          <p className="mt-1 text-xs text-zinc-500">What the data means, where it comes from, and who may see it in <b className="text-zinc-300">{active?.name ?? 'the active workspace'}</b>.</p>
        </div>
        <div className="flex gap-1 border-b border-zinc-800 text-xs">
          {TABS.filter((t) => t.id !== 'provisioning' || isAdmin).map((t) => <button key={t.id} onClick={() => (location.hash = `#/governance/${t.id}`)} className={cn('-mb-px border-b-2 px-3 py-1.5', tab === t.id ? 'border-accent-500 text-zinc-100' : 'border-transparent text-zinc-500 hover:text-zinc-200')}>{t.label}</button>)}
        </div>
        {ws.activeId && tab === 'catalog' && <CatalogPanel key={ws.activeId} workspaceId={ws.activeId} />}
        {ws.activeId && tab === 'lineage' && <LineagePanel key={ws.activeId} workspaceId={ws.activeId} />}
        {tab === 'audit' && <AuditPanel isAdmin={isAdmin} />}
        {tab === 'provisioning' && isAdmin && <ProvisioningPanel />}
        {ws.activeId && tab === 'policies' && <PoliciesPanel key={ws.activeId} workspaceId={ws.activeId} isOwner={active?.role === 'OWNER'} />}
      </div>
    </div>
  );
}
