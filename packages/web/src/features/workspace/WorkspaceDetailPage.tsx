/**
 * One workspace, managed in depth (#/workspaces/<id>/<tab>): overview and health, members and access, storage,
 * engine, sources and connections, integrations, usage and budget, audit, and lifecycle. Owners and
 * administrators change things; other members read.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Archive, ArchiveRestore, Copy, RefreshCw, Trash2, UserRoundCog, Users } from 'lucide-react';
import { api, formatBytes, timeAgo, type DirectoryUser, type LiveStats, type PublicConnection, type SystemInfo, type Workspace, type WorkspaceMember } from '../../api/client';
import { PageHeader, Tag } from '../../components/layout';
import { DataTable } from '../../components/data';
import { Button, Field, Select, StatusDot, Tabs, confirmAction, promptAction, toast, errorText, ErrorState, Skeleton } from '../../components/ui';
import { useWorkspace } from '../../store/workspace';
import { useAuth } from '../../store/auth';
import { usePageObject } from '../../store/context';
import { EngineSettingsForm } from '../settings/EngineSettingsForm';
import { GitPanel } from '../settings/GitPanel';
import { EmbedPanel } from '../settings/EmbedPanel';
import { OrchestrationPanel } from '../settings/OrchestrationPanel';
import { PgWirePanel } from '../settings/PgWirePanel';
import { ShareDialog } from './ShareDialog';
import { CreateWorkspaceWizard } from './CreateWorkspaceWizard';
import { WorkspaceBackups } from './WorkspaceBackups';

type Tab = 'overview' | 'members' | 'storage' | 'engine' | 'sources' | 'integrations' | 'usage' | 'audit' | 'lifecycle';
const TABS: { id: Tab; label: string; owner?: boolean }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'members', label: 'Members & access' },
  { id: 'storage', label: 'Storage' },
  { id: 'engine', label: 'Engine' },
  { id: 'sources', label: 'Sources & connections' },
  { id: 'integrations', label: 'Integrations' },
  { id: 'usage', label: 'Usage & budget' },
  { id: 'audit', label: 'Audit', owner: true },
  { id: 'lifecycle', label: 'Lifecycle', owner: true },
];

type Check = { id: string; label: string; status: 'ok' | 'warn' | 'error'; detail: string };
interface Summary {
  workspace: Workspace;
  size_bytes: number | null;
  counts: { tables: number | null; views: number | null; queries: number; dashboards: number; notebooks: number; apps: number; agents: number; quality_suites: number; syncs: number; folders: number };
  engine: { state: 'running' | 'idle' | 'archived'; memory_bytes: number | null; memory_limit_bytes: number | null; threads: number | null; active_queries: number; node: { id: string; url: string } | null; cluster: boolean };
  checks: Check[];
  connections: { cloud: Conn[]; databases: Conn[]; lakehouses: Conn[]; connectors: Conn[]; attached: string[] };
  folders: { path: string; name: string; missing: boolean; upload_default?: boolean }[];
  disk: { total_bytes: number; files: number; largest: { path: string; root: string | null; kind: string; size_bytes: number; modified_at: string }[] } | null;
}
interface Conn { id: string; name: string; kind: string; status?: 'ok' | 'error' | 'unknown'; alias?: string }
interface Event { id: string; timestamp: string; action: string; who: string; query_text: string | null; status: string }

const parse = (): { id: string; tab: Tab } => {
  const [, id = '', tab = 'overview'] = /^#\/workspaces\/([^/?]+)\/?([a-z]*)/.exec(location.hash) ?? [];
  return { id, tab: (TABS.some((t) => t.id === tab) ? tab : 'overview') as Tab };
};
const tone = (s: Check['status']) => (s === 'error' ? 'error' : s === 'warn' ? 'warn' : 'ok');
const STORAGE_LABEL: Record<string, string> = { memory: 'In memory', data: 'Data directory', folder: 'Folder on the server', cloud: 'Cloud storage', motherduck: 'MotherDuck' };
const storageKind = (p: string) => (p === ':memory:' ? 'memory' : /^md:/i.test(p) ? 'motherduck' : /^[a-z0-9]+:\/\//i.test(p) ? 'cloud' : p.startsWith('/') ? 'folder' : 'data');

function Section({ title, meta, children, actions }: { title: string; meta?: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="flex items-baseline gap-2 border-b border-zinc-800 pb-1.5">
        <h2 className="text-title font-semibold text-zinc-100">{title}</h2>
        {meta && <span className="text-xs text-zinc-500">{meta}</span>}
        <span className="flex-1" />
        {actions}
      </div>
      {children}
    </section>
  );
}

export function WorkspaceDetailPage() {
  const ws = useWorkspace();
  const auth = useAuth();
  const [{ id, tab }, setLoc] = useState(parse);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [sharing, setSharing] = useState(false);
  const [cloning, setCloning] = useState(false);

  useEffect(() => {
    const on = () => setLoc(parse());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const load = useCallback(async () => {
    if (!id) return;
    setError(null);
    try {
      setSummary(await api.get<Summary>(`/api/workspaces/${id}/summary`));
    } catch (e) {
      setError(e);
    }
  }, [id]);
  useEffect(() => {
    setSummary(null);
    void load();
  }, [load]);
  const w = summary?.workspace;
  usePageObject(w ? { kind: 'workspace', id: w.id, label: w.name } : null);

  const isOwner = w?.role === 'OWNER';
  const go = (t: Tab) => { location.hash = `#/workspaces/${id}/${t}`; };

  if (error) return <div className="p-6"><ErrorState error={error} onRetry={() => void load()} title="This workspace could not be loaded" /></div>;
  if (!w || !summary) return <div className="mx-auto max-w-6xl space-y-4 px-6 py-5"><Skeleton className="h-8 w-64" /><Skeleton lines={8} /></div>;

  return (
    <div className="h-full min-h-0 overflow-auto">
      <div className="mx-auto max-w-6xl space-y-4 px-6 py-5 pb-16" data-testid="workspace-detail">
        <PageHeader
          title={<span className="flex items-center gap-2">{w.color && <span className="h-2.5 w-2.5 rounded-full" style={{ background: `var(--series-${w.color})` }} aria-hidden />}{w.name}{w.archived_at && <span className="text-body font-normal text-amber-300">Archived</span>}</span>}
          description={w.description || `${STORAGE_LABEL[storageKind(w.active_db_path)]} · owned by ${w.owner.display_name ?? w.owner.email}`}
          actions={
            <>
              {isOwner && <Button onClick={() => setSharing(true)}><Users className="h-3.5 w-3.5" /> Share</Button>}
              {w.id !== ws.activeId && !w.archived_at && <Button variant="primary" onClick={() => void ws.selectWorkspace(w.id).then(() => { location.hash = '#/'; })}>Open workspace</Button>}
            </>
          }
        />
        {(w.tags ?? []).length > 0 && <div className="flex flex-wrap gap-1">{w.tags!.map((t) => <Tag key={t}>{t}</Tag>)}</div>}
        <Tabs<Tab> value={tab} onChange={go} tabs={TABS.map((t) => ({ id: t.id, label: t.label, hidden: t.owner && !isOwner }))} />

        {tab === 'overview' && <Overview s={summary} isOwner={isOwner} />}
        {tab === 'members' && <Members w={w} isOwner={isOwner} onShare={() => setSharing(true)} />}
        {tab === 'storage' && <Storage s={summary} onChanged={() => void load()} />}
        {tab === 'engine' && <Engine s={summary} isOwner={isOwner} onChanged={() => void load()} />}
        {tab === 'sources' && <Sources s={summary} />}
        {tab === 'integrations' && (
          <div className="space-y-6">
            <Section title="Git"><GitPanel workspaceId={w.id} /></Section>
            <Section title="Embedding"><EmbedPanel workspaceId={w.id} /></Section>
            <Section title="SQL clients & BI tools" meta="The Postgres protocol is server-wide; this workspace is one of its databases."><PgWirePanel /></Section>
            <Section title="Orchestration"><OrchestrationPanel workspaceId={w.id} /></Section>
          </div>
        )}
        {tab === 'usage' && <Usage id={w.id} isOwner={isOwner} />}
        {tab === 'audit' && isOwner && <Audit id={w.id} />}
        {tab === 'lifecycle' && isOwner && <Lifecycle w={w} isAdmin={auth.user?.role === 'ADMIN'} onClone={() => setCloning(true)} onChanged={() => void load()} />}
      </div>
      <ShareDialog open={sharing} onClose={() => setSharing(false)} workspace={w} />
      <CreateWorkspaceWizard open={cloning} onClose={() => setCloning(false)} initial={{ name: `${w.name} (copy)`, start: { kind: 'clone', workspace_id: w.id } }} />
    </div>
  );
}

function Overview({ s, isOwner }: { s: Summary; isOwner: boolean }) {
  const [events, setEvents] = useState<Event[] | null>(null);
  useEffect(() => {
    if (isOwner) void api.get<{ events: Event[] }>(`/api/workspaces/${s.workspace.id}/activity?limit=8`).then((r) => setEvents(r.events)).catch(() => setEvents([]));
  }, [s.workspace.id, isOwner]);
  const c = s.counts;
  const facts: [string, ReactNode][] = [
    ['Size', s.size_bytes != null ? formatBytes(s.size_bytes) : s.workspace.active_db_path === ':memory:' ? 'In memory' : '—'],
    ['Tables', c.tables != null ? `${c.tables}${c.views ? ` and ${c.views} views` : ''}` : <span className="text-zinc-500" title="Counted while the engine is running">Engine stopped</span>],
    ['Dashboards', c.dashboards],
    ['Saved queries', c.queries],
    ['Notebooks', c.notebooks],
    ['Apps', c.apps],
    ['Agents', c.agents],
    ['Quality suites', c.quality_suites],
    ['Syncs', c.syncs],
    ['Members', s.workspace.member_count + 1],
  ];
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
      <div className="space-y-6">
        <Section title="Health">
          <ul className="divide-y divide-zinc-800/70" data-testid="ws-health">
            {s.checks.map((ch) => (
              <li key={ch.id} className="flex items-center gap-3 py-2 text-body" data-check={ch.id} data-status={ch.status}>
                <StatusDot tone={tone(ch.status)} />
                <span className="w-32 shrink-0 text-zinc-300">{ch.label}</span>
                <span className="min-w-0 flex-1 truncate text-zinc-400" title={ch.detail}>{ch.detail}</span>
              </li>
            ))}
          </ul>
        </Section>
        {isOwner && (
          <Section title="Recent activity" actions={<a href={`#/workspaces/${s.workspace.id}/audit`} className="text-xs text-zinc-500 hover:text-zinc-200">All activity</a>}>
            {!events ? <Skeleton lines={4} /> : events.length === 0 ? <p className="text-xs text-zinc-500">Nothing recorded yet.</p> : (
              <ul className="space-y-1.5 text-xs">
                {events.map((e) => (
                  <li key={e.id} className="flex gap-2"><span className="w-20 shrink-0 text-zinc-500" title={new Date(e.timestamp).toLocaleString()}>{timeAgo(e.timestamp)}</span><span className="text-zinc-300">{e.who}</span><span className="truncate text-zinc-500">{e.action.replace(/^workspace\./, '').replace(/_/g, ' ')}{e.query_text ? ` · ${e.query_text}` : ''}</span></li>
                ))}
              </ul>
            )}
          </Section>
        )}
      </div>
      <Section title="Contents">
        <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1.5 text-body" data-testid="ws-counts">
          {facts.map(([k, v]) => (
            <div key={k} className="contents"><dt className="text-zinc-500">{k}</dt><dd className="tabular-nums text-zinc-200">{v}</dd></div>
          ))}
        </dl>
      </Section>
    </div>
  );
}

function Members({ w, isOwner, onShare }: { w: Workspace; isOwner: boolean; onShare: () => void }) {
  const [members, setMembers] = useState<WorkspaceMember[] | null>(null);
  const [tokens, setTokens] = useState<{ id: string; name: string; scopes: string[]; workspace_id: string | null; last_used_at: string | null }[] | null>(null);
  const [policies, setPolicies] = useState<number | null>(null);
  const load = useCallback(() => {
    void api.get<{ members: WorkspaceMember[] }>(`/api/workspaces/${w.id}/members`).then((r) => setMembers(r.members)).catch(() => setMembers([]));
    void api.get<{ tokens: { id: string; name: string; scopes: string[]; workspace_id: string | null; last_used_at: string | null }[] }>('/api/tokens').then((r) => setTokens(r.tokens.filter((t) => t.workspace_id === w.id))).catch(() => setTokens([]));
    void api.get<{ policies: unknown[] }>(`/api/workspaces/${w.id}/policies`).then((r) => setPolicies(r.policies.length)).catch(() => setPolicies(null));
  }, [w.id]);
  useEffect(load, [load]);
  const setRole = async (m: WorkspaceMember, role: string) => {
    try {
      await api.put(`/api/workspaces/${w.id}/members`, { subject_type: m.subject_type, subject_id: m.subject_id, role });
      load();
      toast.success(`${m.name} is now ${role.toLowerCase()}`);
    } catch (e) {
      toast.error(errorText(e));
    }
  };
  const remove = async (m: WorkspaceMember) => {
    if (!(await confirmAction(`Remove ${m.name} from ${w.name}?`, { confirmLabel: 'Remove' }))) return;
    await api.del(`/api/workspaces/${w.id}/members/${m.id}`);
    load();
  };
  return (
    <div className="space-y-6">
      <Section title="Members" meta={`${(members?.length ?? 0) + 1} with access`} actions={isOwner ? <Button size="sm" onClick={onShare}>Add people or teams</Button> : undefined}>
        <DataTable
          label="Members"
          rows={members ? [{ id: 'owner', subject_type: 'user', subject_id: w.owner.id, role: 'OWNER', name: w.owner.display_name ?? w.owner.email, email: w.owner.email, external: false } as unknown as WorkspaceMember, ...members] : null}
          rowKey={(m) => m.id}
          columns={[
            { key: 'name', header: 'Name', cell: (m) => <span>{m.name}{m.id === 'owner' && <span className="text-zinc-500"> · primary owner</span>}</span> },
            { key: 'kind', header: 'Kind', cell: (m) => (m.subject_type === 'group' ? (m.external ? 'Team (identity provider)' : 'Team') : 'Person') },
            { key: 'email', header: 'Email', truncate: true, cell: (m) => m.email ?? '—' },
            { key: 'role', header: 'Role', cell: (m) => (isOwner && m.id !== 'owner' ? <Select uiSize="sm" aria-label={`Role of ${m.name}`} value={m.role} onChange={(e) => void setRole(m, e.target.value)}><option value="VIEWER">Viewer</option><option value="EDITOR">Editor</option><option value="OWNER">Owner</option></Select> : m.role.charAt(0) + m.role.slice(1).toLowerCase()) },
            { key: 'x', header: '', align: 'right', cell: (m) => (isOwner && m.id !== 'owner' ? <Button size="sm" variant="ghost" onClick={() => void remove(m)}>Remove</Button> : null) },
          ]}
        />
      </Section>
      <Section title="Access policies" meta="Row and column security for the people who use this workspace">
        <p className="text-body text-zinc-300">{policies == null ? '—' : policies === 0 ? 'No policies: everyone with access sees every row and column.' : `${policies} polic${policies === 1 ? 'y' : 'ies'} in force.`} <a className="text-accent-300 hover:underline" href="#/governance/policies">Manage policies</a></p>
      </Section>
      <Section title="API tokens" meta="Your tokens limited to this workspace">
        {!tokens ? <Skeleton lines={2} /> : tokens.length === 0 ? <p className="text-xs text-zinc-500">None. Create one under Settings → Account, limited to this workspace.</p> : (
          <ul className="divide-y divide-zinc-800/70 text-body">{tokens.map((t) => <li key={t.id} className="flex gap-3 py-1.5"><span className="flex-1 text-zinc-200">{t.name}</span><span className="text-zinc-500">{t.scopes.join(', ')}</span><span className="text-zinc-500">{t.last_used_at ? `used ${timeAgo(t.last_used_at)}` : 'never used'}</span></li>)}</ul>
        )}
      </Section>
    </div>
  );
}

function Storage({ s, onChanged }: { s: Summary; onChanged: () => void }) {
  const w = s.workspace;
  const kind = storageKind(w.active_db_path);
  const [syncing, setSyncing] = useState(false);
  const sync = async () => {
    setSyncing(true);
    try {
      await api.post(`/api/workspaces/${w.id}/sync`);
      toast.success('Synced to the cloud');
      onChanged();
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setSyncing(false);
    }
  };
  return (
    <div className="space-y-6">
      <Section title="Database">
        <dl className="grid grid-cols-[9rem_1fr] gap-x-3 gap-y-1.5 text-body">
          <dt className="text-zinc-500">Kind</dt><dd className="text-zinc-200">{STORAGE_LABEL[kind]}</dd>
          <dt className="text-zinc-500">Location</dt><dd className="break-all font-mono text-xs text-zinc-200">{w.active_db_path}</dd>
          <dt className="text-zinc-500">Size</dt><dd className="tabular-nums text-zinc-200">{s.size_bytes != null ? formatBytes(s.size_bytes) : '—'}</dd>
          {w.cloud_sync && (<><dt className="text-zinc-500">Cloud sync</dt><dd className="text-zinc-200">{w.cloud_sync.last_error ? <span className="text-red-300">{w.cloud_sync.last_error}</span> : w.cloud_sync.dirty ? 'Changes waiting to be pushed' : w.cloud_sync.synced_at ? `Synced ${timeAgo(w.cloud_sync.synced_at)}` : 'Not synced yet'} {w.role !== 'VIEWER' && <Button size="sm" variant="ghost" loading={syncing} onClick={() => void sync()}><RefreshCw className="h-3 w-3" /> Sync now</Button>}</dd></>)}
        </dl>
        {kind === 'memory' && <p className="text-xs text-zinc-500">Tables live in memory and are lost when the engine restarts. <a className="text-accent-300 hover:underline" href={`#/workspaces/${w.id}/engine`}>Make it persistent</a> without losing them.</p>}
      </Section>
      <Section title="Folders" meta="Read in place from the server's disk">
        {s.folders.length === 0 ? <p className="text-xs text-zinc-500">No folders. Add one from Data → Sources.</p> : (
          <ul className="divide-y divide-zinc-800/70 text-body">
            {s.folders.map((f) => <li key={f.path} className="flex items-center gap-2 py-1.5"><StatusDot tone={f.missing ? 'error' : 'ok'} /><span className="text-zinc-200">{f.name}</span><span className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-500" title={f.path}>{f.path}</span>{f.missing && <span className="text-xs text-red-300">Not found</span>}{f.upload_default && <span className="text-xs text-zinc-500">uploads</span>}</li>)}
          </ul>
        )}
      </Section>
      <Section title="Disk usage" meta={s.disk ? `${formatBytes(s.disk.total_bytes)} in ${s.disk.files.toLocaleString()} data files this workspace can read` : undefined}>
        {!s.disk ? <p className="text-xs text-zinc-500">Not available.</p> : (
          <DataTable
            label="Largest files"
            density="compact"
            rows={s.disk.largest}
            rowKey={(f) => f.path}
            columns={[
              { key: 'path', header: 'File', truncate: true, cell: (f) => <span className="font-mono" title={f.path}>{f.root ? f.path.slice(f.root.length + 1) : f.path}</span> },
              { key: 'kind', header: 'Kind', cell: (f) => f.kind },
              { key: 'modified', header: 'Modified', cell: (f) => timeAgo(f.modified_at) },
              { key: 'size', header: 'Size', align: 'right', numeric: true, cell: (f) => formatBytes(f.size_bytes) },
            ]}
          />
        )}
      </Section>
    </div>
  );
}

function Engine({ s, isOwner, onChanged }: { s: Summary; isOwner: boolean; onChanged: () => void }) {
  const [sys, setSys] = useState<SystemInfo | null>(null);
  const [live, setLive] = useState<LiveStats | null>(null);
  const [connections, setConnections] = useState<PublicConnection[]>([]);
  useEffect(() => {
    void api.get<SystemInfo>('/api/system').then(setSys).catch(() => undefined);
    void api.get<LiveStats>('/api/system/live').then(setLive).catch(() => undefined);
    void api.get<{ connections: PublicConnection[] }>('/api/connections').then((r) => setConnections(r.connections)).catch(() => undefined);
  }, []);
  const e = s.engine;
  const restart = async () => {
    if (!(await confirmAction(`Restart the engine of ${s.workspace.name}? Running queries stop and in-memory tables are lost.`, { confirmLabel: 'Restart' }))) return;
    try {
      await api.post(`/api/workspaces/${s.workspace.id}/restart`);
      toast.success('Restarted');
      onChanged();
    } catch (err) {
      toast.error(errorText(err));
    }
  };
  return (
    <div className="space-y-6">
      <Section title="State" actions={isOwner && e.state === 'running' ? <Button size="sm" variant="ghost" onClick={() => void restart()}><RefreshCw className="h-3.5 w-3.5" /> Restart</Button> : undefined}>
        <dl className="grid grid-cols-[9rem_1fr] gap-x-3 gap-y-1.5 text-body" data-testid="ws-engine">
          <dt className="text-zinc-500">State</dt><dd><StatusDot tone={e.state === 'running' ? 'ok' : e.state === 'archived' ? 'warn' : 'idle'}>{e.state === 'running' ? 'Warm' : e.state === 'archived' ? 'Archived' : 'Stopped; starts on the next query'}</StatusDot></dd>
          {e.state === 'running' && (<><dt className="text-zinc-500">Memory</dt><dd className="tabular-nums text-zinc-200">{e.memory_bytes != null ? formatBytes(e.memory_bytes) : '—'}{e.memory_limit_bytes ? ` of ${formatBytes(e.memory_limit_bytes)}` : ''}</dd><dt className="text-zinc-500">Threads</dt><dd className="tabular-nums text-zinc-200">{e.threads ?? '—'}</dd><dt className="text-zinc-500">Running queries</dt><dd className="tabular-nums text-zinc-200">{e.active_queries}</dd></>)}
          {e.cluster && (<><dt className="text-zinc-500">Cluster node</dt><dd className="font-mono text-xs text-zinc-200">{e.node ? `${e.node.id} · ${e.node.url}` : 'Not held by any node'}</dd></>)}
        </dl>
      </Section>
      {isOwner ? <EngineSettingsForm key={s.workspace.id} workspace={s.workspace} sys={sys} live={live} connections={connections} onSaved={onChanged} /> : <p className="text-xs text-zinc-500">Owners change the engine's limits.</p>}
    </div>
  );
}

function Sources({ s }: { s: Summary }) {
  const c = s.connections;
  const groups: [string, Conn[]][] = [['Cloud storage', c.cloud], ['Databases', c.databases], ['Lakehouse catalogs', c.lakehouses], ['Applications & warehouses', c.connectors]];
  return (
    <div className="space-y-6">
      <p className="text-xs text-zinc-500">A workspace reads through its owner's connections ({s.workspace.owner.email}): their credentials are used, and databases are attached under their aliases. <a className="text-accent-300 hover:underline" href="#/connections">Manage connections</a></p>
      {groups.map(([title, list]) => (
        <Section key={title} title={title} meta={`${list.length}`}>
          {list.length === 0 ? <p className="text-xs text-zinc-500">None.</p> : (
            <ul className="divide-y divide-zinc-800/70 text-body">
              {list.map((x) => <li key={x.id} className="flex items-center gap-2 py-1.5"><StatusDot tone={x.status === 'error' ? 'error' : x.status === 'ok' ? 'ok' : 'idle'} /><span className="text-zinc-200">{x.name}</span><span className="text-xs text-zinc-500">{x.kind.toLowerCase().replace(/_/g, ' ')}</span>{x.alias && <code className="font-mono text-xs text-zinc-500">{x.alias}</code>}</li>)}
            </ul>
          )}
        </Section>
      ))}
      <Section title="Folders" meta={`${s.folders.length}`}>
        {s.folders.length === 0 ? <p className="text-xs text-zinc-500">None.</p> : <ul className="space-y-1 text-body">{s.folders.map((f) => <li key={f.path} className="flex items-center gap-2"><StatusDot tone={f.missing ? 'error' : 'ok'} /><span className="text-zinc-200">{f.name}</span><span className="truncate font-mono text-xs text-zinc-500">{f.path}</span></li>)}</ul>}
      </Section>
    </div>
  );
}

interface UsageReport { totals: { queries: number; query_seconds: number; cost: { total: number } }; daily: { date: string; cost: { total: number } }[]; top_queries: { sql: string; runs: number; total_seconds: number; avg_ms: number; cost: number }[] }
interface Budget { id: string; name: string; amount: number; spent: number; percent: number; period: string }
const money = (n: number) => n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
interface Quota { storage: { used_bytes: number | null; limit_bytes: number | null }; query_seconds: { used: number; limit: number | null }; memory: { limit: string | null } }

function QuotaBar({ label, used, limit, format, hint }: { label: string; used: number; limit: number; format: (n: number) => string; hint: string }) {
  const pct = Math.min(100, (used / limit) * 100);
  return (
    <li className="space-y-1 text-body">
      <div className="flex justify-between"><span className="text-zinc-200">{label}</span><span className={pct >= 100 ? 'text-red-300' : pct >= 80 ? 'text-amber-300' : 'text-zinc-400'}>{format(used)} of {format(limit)}</span></div>
      <div className="h-1.5 rounded-full bg-zinc-800" role="progressbar" aria-label={label} aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}><div className={pct >= 100 ? 'h-full rounded-full bg-red-500' : pct >= 80 ? 'h-full rounded-full bg-amber-500' : 'h-full rounded-full bg-emerald-500'} style={{ width: `${pct}%` }} /></div>
      <p className="text-2xs text-zinc-500">{hint}</p>
    </li>
  );
}

function Usage({ id, isOwner }: { id: string; isOwner: boolean }) {
  const [r, setR] = useState<UsageReport | null>(null);
  const [budgets, setBudgets] = useState<Budget[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [quota, setQuota] = useState<Quota | null>(null);
  useEffect(() => {
    void api.get<Quota>(`/api/workspaces/${id}/quota`).then(setQuota).catch(() => undefined);
    void api.get<UsageReport>(`/api/usage?workspace_id=${id}&days=30`).then(setR, setError);
    void api.get<{ budgets: Budget[] }>(`/api/usage/budgets?workspace_id=${id}`).then((b) => setBudgets(b.budgets), () => setBudgets([]));
  }, [id]);
  if (error) return <ErrorState error={error} />;
  if (!r) return <Skeleton lines={6} />;
  const max = Math.max(...r.daily.map((d) => d.cost.total), 0.0001);
  return (
    <div className="space-y-6">
      <Section title="Last 30 days" meta={`${r.totals.queries.toLocaleString()} queries · ${Math.round(r.totals.query_seconds).toLocaleString()} s of compute · ${money(r.totals.cost.total)}`}>
        <div className="flex h-24 items-end gap-px" role="img" aria-label={`Cost per day over 30 days, ${money(r.totals.cost.total)} in total`}>
          {r.daily.map((d) => <div key={d.date} className="flex-1 rounded-t-sm bg-[color:var(--series-1)] opacity-80 hover:opacity-100" style={{ height: `${Math.max(1, (d.cost.total / max) * 100)}%` }} title={`${d.date}: ${money(d.cost.total)}`} />)}
        </div>
      </Section>
      {quota && (quota.storage.limit_bytes || quota.query_seconds.limit || quota.memory.limit) && (
        <Section title="Quotas" meta="Set by your administrators">
          <ul className="space-y-3" data-testid="ws-quotas">
            {quota.storage.limit_bytes != null && <QuotaBar label="Storage" used={quota.storage.used_bytes ?? 0} limit={quota.storage.limit_bytes} format={formatBytes} hint="Over the quota, reads work but writes are refused." />}
            {quota.query_seconds.limit != null && <QuotaBar label="Query time today" used={quota.query_seconds.used} limit={quota.query_seconds.limit} format={(n) => `${Math.round(n / 60).toLocaleString()} min`} hint="Resets at midnight UTC." />}
            {quota.memory.limit && <li className="text-body text-zinc-300">Engine memory is capped at <span className="font-mono">{quota.memory.limit}</span>.</li>}
          </ul>
        </Section>
      )}
      <Section title="Budget" actions={isOwner ? <a className="text-xs text-accent-300 hover:underline" href="#/settings/usage">Set a budget</a> : undefined}>
        {!budgets ? <Skeleton lines={1} /> : budgets.length === 0 ? <p className="text-xs text-zinc-500">No budget for this workspace.</p> : (
          <ul className="space-y-2">{budgets.map((b) => (
            <li key={b.id} className="space-y-1 text-body">
              <div className="flex justify-between"><span className="text-zinc-200">{b.name || 'Monthly budget'}</span><span className={b.percent >= 100 ? 'text-red-300' : b.percent >= 80 ? 'text-amber-300' : 'text-zinc-400'}>{money(b.spent)} of {money(b.amount)} · {Math.round(b.percent)}%</span></div>
              <div className="h-1.5 rounded-full bg-zinc-800"><div className={b.percent >= 100 ? 'h-full rounded-full bg-red-500' : b.percent >= 80 ? 'h-full rounded-full bg-amber-500' : 'h-full rounded-full bg-emerald-500'} style={{ width: `${Math.min(100, b.percent)}%` }} /></div>
            </li>
          ))}</ul>
        )}
      </Section>
      <Section title="Heaviest queries">
        <DataTable
          label="Heaviest queries"
          density="compact"
          rows={r.top_queries}
          rowKey={(q) => q.sql}
          empty="No queries in this period."
          columns={[
            { key: 'sql', header: 'Query', truncate: true, cell: (q) => <code className="font-mono" title={q.sql}>{q.sql.replace(/\s+/g, ' ')}</code> },
            { key: 'runs', header: 'Runs', align: 'right', numeric: true, cell: (q) => q.runs.toLocaleString() },
            { key: 'avg', header: 'Average', align: 'right', numeric: true, cell: (q) => `${Math.round(q.avg_ms).toLocaleString()} ms` },
            { key: 'cost', header: 'Cost', align: 'right', numeric: true, cell: (q) => money(q.cost) },
          ]}
        />
      </Section>
    </div>
  );
}

function Audit({ id }: { id: string }) {
  const [events, setEvents] = useState<Event[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => void api.get<{ events: Event[] }>(`/api/workspaces/${id}/activity?limit=500`).then((r) => setEvents(r.events), setError), [id]);
  return (
    <DataTable
      label="Workspace activity"
      testid="ws-audit"
      rows={events}
      error={error}
      rowKey={(e) => e.id}
      search={(e) => `${e.action} ${e.who} ${e.query_text ?? ''}`}
      searchPlaceholder="Filter activity"
      empty="Nothing recorded yet."
      columns={[
        { key: 'when', header: 'When', cell: (e) => <span title={new Date(e.timestamp).toLocaleString()}>{timeAgo(e.timestamp)}</span> },
        { key: 'who', header: 'Who', truncate: true, cell: (e) => e.who },
        { key: 'what', header: 'What', cell: (e) => e.action.replace(/_/g, ' ') },
        { key: 'detail', header: 'Detail', truncate: true, cell: (e) => <span className="font-mono text-xs" title={e.query_text ?? ''}>{e.query_text ?? ''}</span> },
        { key: 'status', header: 'Result', cell: (e) => <StatusDot tone={e.status === 'error' ? 'error' : 'ok'}>{e.status === 'error' ? 'Failed' : 'Done'}</StatusDot> },
      ]}
    />
  );
}

function Lifecycle({ w, isAdmin, onClone, onChanged }: { w: Workspace; isAdmin: boolean; onClone: () => void; onChanged: () => void }) {
  const ws = useWorkspace();
  const me = useAuth((s) => s.user);
  const [users, setUsers] = useState<DirectoryUser[]>([]);
  const [to, setTo] = useState('');
  const canTransfer = w.user_id === me?.id || isAdmin;
  useEffect(() => void api.get<{ users: DirectoryUser[] }>('/api/users/directory').then((r) => setUsers(r.users.filter((u) => u.id !== w.user_id && u.role !== 'READ_ONLY'))).catch(() => undefined), [w.user_id]);
  const archive = async (archived: boolean) => {
    if (archived && !(await confirmAction(`Archive ${w.name}? It leaves the workspace switcher and stops running queries until it is restored. Nothing is deleted.`, { confirmLabel: 'Archive' }))) return;
    try {
      await api.post(`/api/workspaces/${w.id}/archive`, { archived });
      await ws.loadWorkspaces();
      toast.success(archived ? 'Archived' : 'Restored');
      onChanged();
    } catch (e) {
      toast.error(errorText(e));
    }
  };
  const transfer = async () => {
    const u = users.find((x) => x.id === to);
    if (!u || !(await confirmAction(`Transfer ${w.name} to ${u.email}? They become its owner; you keep owner access.`, { confirmLabel: 'Transfer' }))) return;
    try {
      await api.post(`/api/workspaces/${w.id}/transfer`, { user_id: to });
      toast.success(`Transferred to ${u.email}`);
      setTo('');
      onChanged();
    } catch (e) {
      toast.error(errorText(e));
    }
  };
  const remove = async () => {
    const typed = await promptAction(`Delete ${w.name}?`, { body: 'Its queries, dashboards, notebooks, apps and settings are removed for everyone. The database file stays on disk.', label: 'Type the workspace name to confirm', confirmLabel: 'Delete' });
    if (typed === null) return;
    if (typed !== w.name) return void toast.error('The name did not match; nothing was deleted');
    try {
      await ws.deleteWorkspace(w.id);
      toast.success(`Deleted ${w.name}`);
      location.hash = isAdmin ? '#/settings/workspaces' : '#/';
    } catch (e) {
      toast.error(errorText(e));
    }
  };
  const row = (title: string, hint: string, action: ReactNode, testid?: string) => (
    <div className="flex flex-wrap items-center gap-3 py-3" data-testid={testid}>
      <div className="min-w-0 flex-1"><div className="text-body font-medium text-zinc-100">{title}</div><div className="text-xs text-zinc-500">{hint}</div></div>
      {action}
    </div>
  );
  return (
    <div className="space-y-6">
    <Section title="Backups" meta="Point-in-time copies of the data and objects, kept on the server"><WorkspaceBackups w={w} onChanged={onChanged} /></Section>
    <Section title="Lifecycle">
    <div className="divide-y divide-zinc-800/70 border-b border-zinc-800/70">
      {w.archived_at
        ? row('Restore', `Archived ${timeAgo(w.archived_at)}. Restoring brings it back to the switcher and lets it run queries.`, <Button onClick={() => void archive(false)}><ArchiveRestore className="h-3.5 w-3.5" /> Restore</Button>, 'ws-restore')
        : row('Archive', 'Hide it from the switcher and stop its engine. Nothing is deleted; restore it any time.', <Button onClick={() => void archive(true)}><Archive className="h-3.5 w-3.5" /> Archive</Button>, 'ws-archive')}
      {row('Clone', 'A new workspace with a copy of its tables, folders, queries, dashboards and notebooks.', <Button onClick={onClone}><Copy className="h-3.5 w-3.5" /> Clone…</Button>)}
      {canTransfer && row('Transfer ownership', 'Give the workspace to someone else. You keep owner access.', (
        <div className="flex items-end gap-2">
          <Field label="New owner" htmlFor="lc-to"><Select id="lc-to" uiSize="sm" value={to} onChange={(e) => setTo(e.target.value)}><option value="">Choose…</option>{users.map((u) => <option key={u.id} value={u.id}>{u.email}</option>)}</Select></Field>
          <Button size="sm" disabled={!to} onClick={() => void transfer()}><UserRoundCog className="h-3.5 w-3.5" /> Transfer</Button>
        </div>
      ))}
      {row('Delete', 'Remove the workspace and everything in it for everyone. The database file stays on disk.', <Button variant="danger" onClick={() => void remove()} data-testid="ws-delete"><Trash2 className="h-3.5 w-3.5" /> Delete…</Button>)}
    </div>
    </Section>
    </div>
  );
}
