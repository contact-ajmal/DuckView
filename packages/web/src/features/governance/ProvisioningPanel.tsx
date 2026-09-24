import { useCallback, useEffect, useState } from 'react';
import { Copy, KeyRound, RefreshCw, Trash2, Users } from 'lucide-react';
import { api, timeAgo, type Group, type ScimStatus } from '../../api/client';
import { Badge, Button, confirmAction } from '../../components/ui';
import { DataTable } from '../../components/data';

/** Governance → Provisioning (administrators): the SCIM 2.0 endpoint and token, and the teams linked to IdP groups. */
export function ProvisioningPanel() {
  const [status, setStatus] = useState<ScimStatus | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    setStatus(await api.get<ScimStatus>('/api/admin/scim'));
    setGroups((await api.get<{ groups: Group[] }>('/api/groups')).groups.filter((g) => g.external_id));
  }, []);
  useEffect(() => void load().catch((e) => setError((e as Error).message)), [load]);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const copy = (text: string) => void navigator.clipboard?.writeText(text).catch(() => undefined);

  return (
    <div className="space-y-4 text-xs">
      {error && <div className="rounded-md border border-red-900 bg-red-950/50 px-3 py-2 font-mono text-red-200">{error}</div>}
      <section className="space-y-2">
        <div className="flex items-center gap-2">
          <h2 className="text-body font-semibold text-zinc-100">SCIM provisioning</h2>
          {status && (status.enabled ? status.source ? <Badge tone="ok">Active</Badge> : <Badge>No token</Badge> : <Badge tone="warn">Disabled in config</Badge>)}
        </div>
        <p className="max-w-3xl text-zinc-500">
          Let Okta, Entra ID, OneLogin or JumpCloud create, update and deactivate DuckView users and keep teams in step with IdP groups. Provisioned users sign in with SSO. Deactivating a user blocks sign-in and stops their sessions, API tokens and scheduled work at once;
          a SCIM delete {status?.on_delete === 'delete' ? 'removes the user for good' : 'deactivates the user and keeps their workspaces'} (<span className="font-mono">auth.scim.on_delete</span>).
        </p>
        {status && (
          <div className="space-y-2 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="w-24 text-zinc-500">Base URL</span>
              <code className="rounded bg-zinc-950 px-2 py-1 font-mono text-zinc-200" data-testid="scim-endpoint">{status.endpoint}</code>
              <button className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200" title="Copy" onClick={() => copy(status.endpoint)}><Copy className="h-3.5 w-3.5" /></button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="w-24 text-zinc-500">Bearer token</span>
              {status.source === 'config' ? (
                <span className="text-zinc-300">Set in configuration (<span className="font-mono">auth.scim.token</span>)</span>
              ) : status.source === 'console' ? (
                <span className="text-zinc-300" data-testid="scim-token-status"><span className="font-mono">{status.prefix}…</span> · generated {status.created_at ? timeAgo(status.created_at) : ''}</span>
              ) : (
                <span className="text-zinc-500" data-testid="scim-token-status">None yet</span>
              )}
              {status.source !== 'config' && (
                <>
                  <Button size="sm" disabled={busy || !status.enabled} onClick={async () => void act(async () => { if (status.source && !(await confirmAction('Generate a new token? The current one stops working immediately.'))) return; setToken((await api.post<{ token: string }>('/api/admin/scim/token', {})).token); })}>
                    {status.source ? <RefreshCw className="h-3.5 w-3.5" /> : <KeyRound className="h-3.5 w-3.5" />} {status.source ? 'Rotate' : 'Generate token'}
                  </Button>
                  {status.source && (
                    <Button size="sm" variant="ghost" disabled={busy} onClick={async () => void act(async () => { if (!(await confirmAction('Revoke the SCIM token? Provisioning stops until you generate a new one.'))) return; await api.del('/api/admin/scim/token'); setToken(null); })}>
                      <Trash2 className="h-3.5 w-3.5" /> Revoke
                    </Button>
                  )}
                </>
              )}
            </div>
            {token && (
              <div className="space-y-1 rounded-md border border-amber-900/60 bg-amber-950/30 p-2.5 text-amber-100">
                <div>Copy the token into your IdP's provisioning settings now — it is not shown again.</div>
                <div className="flex items-center gap-2">
                  <code className="break-all rounded bg-zinc-950 px-2 py-1 font-mono text-zinc-100" data-testid="scim-token">{token}</code>
                  <button className="rounded p-1 text-amber-300 hover:bg-amber-900/40" title="Copy" onClick={() => copy(token)}><Copy className="h-3.5 w-3.5" /></button>
                </div>
              </div>
            )}
          </div>
        )}
        <ul className="max-w-3xl list-disc space-y-0.5 pl-5 text-zinc-500">
          <li><b className="text-zinc-300">Okta:</b> app → Provisioning → Integration: SCIM connector base URL as above, unique identifier <span className="font-mono">userName</span>, authentication “HTTP Header” with the token; enable Push New Users, Push Profile Updates, Push Groups and Deactivate Users.</li>
          <li><b className="text-zinc-300">Entra ID:</b> enterprise app → Provisioning → Automatic: Tenant URL as above, Secret Token the token. Map <span className="font-mono">userPrincipalName</span> or <span className="font-mono">mail</span> to <span className="font-mono">userName</span> — it must be the user's email.</li>
        </ul>
      </section>

      <section className="space-y-2">
        <h2 className="flex items-center gap-2 text-body font-semibold text-zinc-100"><Users className="h-4 w-4 text-zinc-400" /> Teams linked to IdP groups</h2>
        <p className="max-w-3xl text-zinc-500">
          A team linked to an IdP group takes its members from SSO sign-in and SCIM. Link one in <a className="text-accent-300 hover:underline" href="#/settings/teams">Settings → Teams</a> before anyone signs in, share workspaces with it, and access follows the IdP from then on.
        </p>
        {groups.length === 0 ? (
          <div className="border-y border-zinc-800 p-4 text-center text-zinc-500">No linked teams yet.</div>
        ) : (
          <DataTable
            label="Provisioned users"
            rows={groups}
            rowKey={(g) => g.id}
            rowProps={(g) => ({ 'data-team': g.name })}
            columns={[
              { key: 'team', header: 'Team', sortValue: (g) => g.name, cell: (g) => <span className="text-zinc-200">{g.name}</span> },
              { key: 'idp_group', header: 'IdP group', sortValue: (g) => g.external_id, cell: (g) => <span className="font-mono text-zinc-400">{g.external_id}</span> },
              { key: 'members', header: 'Members', sortValue: (g) => g.member_count, cell: (g) => <span className="text-zinc-400">{g.member_count}</span> },
              { key: 'updated', header: 'Updated', cell: (g) => <span className="text-zinc-500">{timeAgo(g.updated_at)}</span> },
            ]}
          />
        )}
      </section>
    </div>
  );
}
