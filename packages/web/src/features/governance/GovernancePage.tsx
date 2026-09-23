import { useEffect, useState } from 'react';
import { useWorkspace } from '../../store/workspace';
import { PoliciesPanel } from './PoliciesPanel';
import { CatalogPanel } from './CatalogPanel';
import { LineagePanel } from './LineagePanel';
import { AuditPanel } from './AuditPanel';
import { ProvisioningPanel } from './ProvisioningPanel';
import { useAuth } from '../../store/auth';
import { PageHeader } from '../../components/layout';

type Tab = 'catalog' | 'lineage' | 'policies' | 'audit' | 'provisioning';

/**
 * Catalog, lineage and access policies live under Data; the audit log and SCIM provisioning under Settings. The
 * section tabs (or the settings list) are in the shell, so this renders only the page itself.
 */
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
  const settingsPage = tab === 'audit' || tab === 'provisioning';
  return (
    <div className="h-full min-h-0 overflow-auto">
      <div className="mx-auto max-w-[1400px] space-y-4 px-6 py-5">
        {settingsPage && <PageHeader title={tab === 'audit' ? 'Audit log' : 'Provisioning'} description={tab === 'audit' ? 'Who did what, and where the log is streamed.' : 'SCIM 2.0: users and teams from your identity provider.'} actions={<a href="#/settings" className="text-xs text-zinc-500 hover:text-zinc-200">All settings</a>} />}
        {ws.activeId && tab === 'catalog' && <CatalogPanel key={ws.activeId} workspaceId={ws.activeId} />}
        {ws.activeId && tab === 'lineage' && <LineagePanel key={ws.activeId} workspaceId={ws.activeId} />}
        {tab === 'audit' && <AuditPanel isAdmin={isAdmin} />}
        {tab === 'provisioning' && isAdmin && <ProvisioningPanel />}
        {ws.activeId && tab === 'policies' && <PoliciesPanel key={ws.activeId} workspaceId={ws.activeId} isOwner={active?.role === 'OWNER'} />}
      </div>
    </div>
  );
}
