import { useEffect, useState } from 'react';
import { Code2, GitBranch, Workflow, Users, Trash2, Plug, KeyRound, Activity, Palette, LayoutTemplate, Cpu, Database, Cloud, Bot, UserRound, ShieldCheck, Layers, Pencil, AppWindow, ScrollText, Server, ReceiptText } from 'lucide-react';
import { api, formatBytes, timeAgo, type LiveStats, type SystemInfo, type User, type PublicConnection, type CloudConnection, type CopilotConfig, type LakehouseConnection } from '../../api/client';
import { Gauge } from '../../components/Gauge';
import { PageHeader, SideCard, Panel, KvRows, Tag } from '../../components/layout';
import { Button, Badge, Card, Input, Label, Modal, Select, cn } from '../../components/ui';
import { useAuth } from '../../store/auth';
import { useWorkspace } from '../../store/workspace';
import { useLayout } from '../../store/layout';
import { useCopilot } from '../../store/copilot';
import { CopilotPanel } from './CopilotPanel';
import { HideButton, LayoutSettings } from '../../components/LayoutMenu';
import { CloudWizard } from '../explorer/CloudWizard';
import { LakehouseWizard } from '../explorer/LakehouseWizard';
import { EngineSettingsForm } from './EngineSettingsForm';
import { AppearanceSettings } from './Appearance';
import { TeamsPanel } from './TeamsPanel';
import { CachePanel } from './CachePanel';
import { IntegrationsPanel } from './IntegrationsPanel';
import { AppsAdminPanel } from './AppsAdminPanel';
import { AuditPanel } from '../governance/AuditPanel';
import { ProvisioningPanel } from '../governance/ProvisioningPanel';
import { GitPanel } from './GitPanel';
import { EmbedPanel } from './EmbedPanel';
import { PgWirePanel } from './PgWirePanel';
import { OrchestrationPanel } from './OrchestrationPanel';
import { ClusterPanel } from './ClusterPanel';
import { UsagePanel } from './UsagePanel';

type Category = 'appearance' | 'layout' | 'hardware' | 'engine' | 'storage' | 'copilot' | 'integrations' | 'account' | 'teams' | 'apps' | 'users' | 'audit' | 'provisioning' | 'git' | 'embedding' | 'sql-clients' | 'orchestration' | 'cluster' | 'usage';
const CATEGORIES: { id: Category; label: string; blurb: string; icon: React.ReactNode; group: string; admin?: boolean }[] = [
  { id: 'account', group: 'General', label: 'Account', blurb: 'Your password and identity', icon: <UserRound className="h-4 w-4" /> },
  { id: 'usage', group: 'General', label: 'Usage & cost', blurb: 'Queries, AI and storage, what they cost, and monthly budgets', icon: <ReceiptText className="h-4 w-4" /> },
  { id: 'teams', group: 'General', label: 'Teams', blurb: 'Groups for sharing workspaces', icon: <Users className="h-4 w-4" /> },
  { id: 'appearance', group: 'Appearance', label: 'Theme & fonts', blurb: 'Themes, fonts and interface size', icon: <Palette className="h-4 w-4" /> },
  { id: 'layout', group: 'Appearance', label: 'Layout', blurb: 'Show or hide parts of the interface', icon: <LayoutTemplate className="h-4 w-4" /> },
  { id: 'storage', group: 'Connections', label: 'Storage & credentials', blurb: 'Cloud storage, lakehouse catalogs and stored credentials', icon: <Cloud className="h-4 w-4" /> },
  { id: 'integrations', group: 'Connections', label: 'Integrations', blurb: 'Google sign-in for Drive, Sheets and BigQuery', icon: <Plug className="h-4 w-4" /> },
  { id: 'users', group: 'Security', label: 'Users', blurb: 'Roles, access and deactivation', icon: <ShieldCheck className="h-4 w-4" />, admin: true },
  { id: 'audit', group: 'Security', label: 'Audit log', blurb: 'Who did what, and where the log is streamed', icon: <ScrollText className="h-4 w-4" /> },
  { id: 'provisioning', group: 'Security', label: 'Provisioning', blurb: 'SCIM 2.0 users and teams from your identity provider', icon: <KeyRound className="h-4 w-4" />, admin: true },
  { id: 'embedding', group: 'Security', label: 'Embedding', blurb: 'Show dashboards and notebooks inside your own application', icon: <Code2 className="h-4 w-4" /> },
  { id: 'copilot', group: 'AI', label: 'AI assistant', blurb: 'The model DuckView AI uses, keys and usage', icon: <Bot className="h-4 w-4" /> },
  { id: 'engine', group: 'Data', label: 'Engine', blurb: 'Memory, threads, timeouts and storage of this workspace', icon: <Database className="h-4 w-4" /> },
  { id: 'sql-clients', group: 'Data', label: 'SQL clients & BI tools', blurb: 'Tableau, Power BI, Metabase, psql and drivers over the Postgres protocol', icon: <Database className="h-4 w-4" /> },
  { id: 'orchestration', group: 'Data', label: 'Orchestration', blurb: 'Run syncs, dbt and checks from Airflow, Dagster, Prefect or any scheduler', icon: <Workflow className="h-4 w-4" /> },
  { id: 'git', group: 'Data', label: 'Git', blurb: 'Notebooks, queries, dashboards and models in a Git repository', icon: <GitBranch className="h-4 w-4" /> },
  { id: 'hardware', group: 'Data', label: 'Resources', blurb: 'Live memory, CPU, disk and warm engines', icon: <Cpu className="h-4 w-4" /> },
  { id: 'cluster', group: 'Advanced', label: 'Cluster', blurb: 'The nodes serving DuckView and the workspaces each one runs', icon: <Server className="h-4 w-4" />, admin: true },
  { id: 'apps', group: 'Advanced', label: 'Data apps', blurb: 'App runtime, running apps and publish requests', icon: <AppWindow className="h-4 w-4" />, admin: true },
];
const GROUPS = ['General', 'Appearance', 'Connections', 'Security', 'AI', 'Data', 'Advanced'];

function useCategory(): [Category, (c: Category) => void] {
  const parse = (): Category => {
    const m = /^#\/settings\/?([a-z-]*)/.exec(location.hash)?.[1] as Category | undefined;
    return m && CATEGORIES.some((c) => c.id === m) ? m : 'account';
  };
  const [cat, setCat] = useState<Category>(parse);
  useEffect(() => {
    const on = () => setCat(parse());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return [cat, (c) => (location.hash = `#/settings/${c}`)];
}

export function SettingsPage() {
  const auth = useAuth();
  const ws = useWorkspace();
  const cp = useCopilot();
  const isAdmin = auth.user?.role === 'ADMIN';
  const workspace = ws.workspaces.find((w) => w.id === ws.activeId) ?? null;
  const [cat, setCat] = useCategory();
  const [live, setLive] = useState<LiveStats | null>(null);
  const [sys, setSys] = useState<SystemInfo | null>(null);
  const [connections, setConnections] = useState<PublicConnection[]>([]);
  const [cloud, setCloud] = useState<CloudConnection[]>([]);
  const [lakehouses, setLakehouses] = useState<LakehouseConnection[]>([]);
  const [wizard, setWizard] = useState(false);
  const [lakeWizard, setLakeWizard] = useState<{ open: boolean; edit: LakehouseConnection | null }>({ open: false, edit: null });
  const [testing, setTesting] = useState<Record<string, string>>({});
  const [connTypes, setConnTypes] = useState<Record<string, { required: string[]; optional: string[] }>>({});
  const [externalAccess, setExternalAccess] = useState(false);
  const [users, setUsers] = useState<User[]>([]);
  const [copilotCfg, setCopilotCfg] = useState<CopilotConfig | null>(null);
  const [newUser, setNewUser] = useState<{ open: boolean; email: string; password: string; role: User['role'] }>({ open: false, email: '', password: '', role: 'USER' });
  const [newConn, setNewConn] = useState<{ open: boolean; name: string; type: string; creds: Record<string, string> }>({ open: false, name: '', type: 'S3', creds: {} });
  const [pw, setPw] = useState({ current: '', next: '', msg: '' });
  const hidden = useLayout((l) => l.hidden);

  const refresh = async () => {
    const [c, ct] = await Promise.all([api.get<{ connections: PublicConnection[] }>('/api/connections'), api.get<{ types: Record<string, { required: string[]; optional: string[] }>; external_access_enabled: boolean }>('/api/connections/types')]);
    setConnections(c.connections);
    setCloud((await api.get<{ connections: CloudConnection[] }>('/api/cloud-connections')).connections);
    setLakehouses((await api.get<{ connections: LakehouseConnection[] }>('/api/lakehouse-connections')).connections);
    setConnTypes(ct.types);
    setExternalAccess(ct.external_access_enabled);
    if (isAdmin) setUsers((await api.get<{ users: User[] }>('/api/admin/users')).users);
  };

  useEffect(() => {
    api.get<SystemInfo>('/api/system').then(setSys).catch(() => undefined);
    api.get<CopilotConfig>('/api/copilot/config').then(setCopilotCfg).catch(() => undefined);
    void refresh().catch(() => undefined);
    let alive = true;
    const tick = async () => {
      try {
        const l = await api.get<LiveStats>('/api/system/live');
        if (alive) setLive(l);
      } catch {
        /* ignore */
      }
    };
    void tick();
    const t = setInterval(tick, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [isAdmin]); // eslint-disable-line react-hooks/exhaustive-deps

  const hostMemPct = live ? (live.host.memory_used_bytes / live.host.memory_total_bytes) * 100 : 0;
  const duckPct = live && live.duckdb.memory_limit_bytes ? (live.duckdb.memory_usage_bytes / live.duckdb.memory_limit_bytes) * 100 : 0;
  const scratchPct = live && live.scratch.total_bytes ? ((live.scratch.total_bytes - (live.scratch.free_bytes ?? 0)) / live.scratch.total_bytes) * 100 : 0;
  const running = live?.duckdb.engines.reduce((a, e) => a + e.active_queries, 0) ?? 0;
  const datasets = ws.catalog ? ws.catalog.files.length + ws.catalog.objects.length : 0;
  const current = CATEGORIES.find((c) => c.id === cat)!;

  return (
    <>
    <div className="flex h-full min-h-0">
      {/* Category navigation */}
      <nav aria-label="Settings" className="flex w-56 shrink-0 flex-col overflow-y-auto border-r border-zinc-800 bg-zinc-900 px-2 py-3">
        {GROUPS.map((g) => {
          const items = CATEGORIES.filter((c) => c.group === g && (!c.admin || isAdmin));
          if (!items.length) return null;
          return (
            <div key={g} className="mb-3">
              <div className="px-2 pb-1 text-[11px] font-medium text-zinc-500">{g}</div>
              {items.map((c) => (
                <button key={c.id} onClick={() => setCat(c.id)} aria-current={cat === c.id ? 'page' : undefined} className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px]', cat === c.id ? 'bg-zinc-800 text-zinc-50' : 'text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-100')}>
                  <span className={cn('shrink-0', cat === c.id ? 'text-zinc-200' : 'text-zinc-500')}>{c.icon}</span>
                  <span className="truncate">{c.label}</span>
                </button>
              ))}
            </div>
          );
        })}
        {sys && (
          <div className="mt-auto px-2 pt-3 text-[11px] leading-relaxed text-zinc-600">
            DuckDB {sys.duckdb.version} · {sys.server.metadata_dialect}
            <br />
            DuckView {sys.server.version} · up {Math.round(sys.server.uptime_s / 60)} min
          </div>
        )}
      </nav>

      {/* Category content */}
      <main className="min-w-0 flex-1 overflow-auto">
        <div className="mx-auto max-w-5xl space-y-5 px-6 py-5">
          <PageHeader title={current.label} description={current.blurb} />

          {cat === 'appearance' && <AppearanceSettings />}

          {cat === 'layout' && <LayoutSettings />}

          {cat === 'git' && ws.activeId && <GitPanel key={ws.activeId} workspaceId={ws.activeId} />}

          {cat === 'embedding' && ws.activeId && <EmbedPanel key={ws.activeId} workspaceId={ws.activeId} />}
          {cat === 'sql-clients' && <PgWirePanel />}
          {cat === 'cluster' && isAdmin && <ClusterPanel />}
          {cat === 'usage' && <UsagePanel />}
          {cat === 'orchestration' && ws.activeId && <OrchestrationPanel key={ws.activeId} workspaceId={ws.activeId} />}

          {cat === 'hardware' && (
            <div className="space-y-5">
              {!hidden['settings.gauges'] && (
                <div className="group/g relative grid grid-cols-2 gap-4 xl:grid-cols-4">
                  <HideButton id="settings.gauges" className="absolute -top-5 right-0 opacity-0 group-hover/g:opacity-100" />
                  <Gauge value={hostMemPct} label="Host RAM" primary={live ? `${formatBytes(live.host.memory_used_bytes)} used` : '—'} secondary={live ? `of ${formatBytes(live.host.memory_total_bytes)} · OS-reported (includes cache)` : undefined} />
                  <Gauge value={duckPct} label="DuckDB memory" primary={live ? `${formatBytes(live.duckdb.memory_usage_bytes)} allocated` : '—'} secondary={live ? `ceiling ${formatBytes(live.duckdb.memory_limit_bytes)} · ${live.duckdb.engines.length} engine${live.duckdb.engines.length === 1 ? '' : 's'}` : undefined} tone="accent" />
                  <Gauge value={live?.host.cpu_percent ?? 0} label="CPU load" primary={live ? `${live.host.cpus} cores · load ${live.host.load_average[0]?.toFixed(2)}` : '—'} secondary={live ? `duckview process ${live.process.cpu_percent.toFixed(1)}%` : undefined} />
                  <Gauge value={scratchPct} label="Scratch storage" primary={live ? `${formatBytes(live.scratch.used_bytes)} spilled` : '—'} secondary={live ? `${formatBytes(live.scratch.free_bytes)} free on ${live.scratch.path.split('/').slice(-1)[0]}` : undefined} />
                </div>
              )}
              <CachePanel live={live} />
              {!hidden['settings.resources'] && (
                <div className="grid gap-4 md:grid-cols-2">
                  <SideCard title="Live resources" hideId="settings.resources" meta={<span className={`h-1.5 w-1.5 rounded-full ${live ? 'bg-emerald-400' : 'bg-zinc-600'}`} />}>
                    <KvRows
                      rows={[
                        { k: 'engine mem', v: live ? formatBytes(live.duckdb.memory_usage_bytes) : '…', sub: live ? `/ ${formatBytes(live.duckdb.memory_limit_bytes)}` : undefined },
                        { k: 'process', v: live ? formatBytes(live.process.rss_bytes) : '…', sub: live ? `rss · ${live.process.cpu_percent.toFixed(1)}% cpu` : undefined },
                        { k: 'datasets', v: `${datasets} loaded`, sub: ws.catalog ? `· ${formatBytes(ws.catalog.files.reduce((a, f) => a + f.size_bytes, 0))}` : undefined },
                        { k: 'queries', v: `${running} running`, sub: `· ${ws.tabs.length} tabs` },
                        { k: 'engines', v: live ? `${live.duckdb.engines.length} warm` : '…', sub: live ? `· ${formatBytes(live.duckdb.temp_bytes)} spilled` : undefined },
                      ]}
                    />
                  </SideCard>
                  <SideCard title="Detected on this machine">
                    <KvRows
                      rows={[
                        { k: 'cores', v: sys ? `${sys.host.cpus} logical` : '…' },
                        { k: 'memory', v: sys ? formatBytes(sys.host.total_memory_bytes) : '…' },
                        { k: 'auto limit', v: sys?.duckdb.memory_limit ?? '…' },
                        { k: 'scratch', v: live ? `${formatBytes(live.scratch.free_bytes)} free` : '…' },
                        { k: 'platform', v: sys?.host.platform ?? '…' },
                        { k: 'sandbox', v: sys ? (sys.duckdb.external_access ? 'external on' : 'jailed') : '…', sub: sys?.duckdb.configuration_locked ? '· locked' : undefined },
                        { k: 'engine', v: sys ? `DuckDB ${sys.duckdb.version}` : '…', sub: sys ? `· ${sys.server.metadata_dialect}` : undefined },
                      ]}
                    />
                  </SideCard>
                </div>
              )}
              {!hidden['settings.machine'] && (
                <Panel title="Capacity" meta="host vs engine ceiling" bodyClassName="p-0" hideId="settings.machine">
                  <div className="grid gap-px bg-zinc-800 md:grid-cols-3">
                    <div className="bg-zinc-900/60 p-4">
                      <div className="text-[10px] font-semibold text-zinc-500">This machine</div>
                      <div className="mt-1 text-lg font-semibold text-zinc-50">{sys ? `${formatBytes(sys.host.total_memory_bytes)} RAM · ${sys.host.cpus} cores` : '…'}</div>
                      <p className="mt-1 text-[11px] text-zinc-500">Native DuckDB addresses all host memory and cores; per-workspace limits keep tenants from starving each other.</p>
                    </div>
                    <div className="bg-zinc-900/60 p-4">
                      <div className="text-[10px] font-semibold text-zinc-500">Engine ceiling</div>
                      <div className="mt-1 text-lg font-semibold text-zinc-50">{live ? `${formatBytes(live.duckdb.memory_limit_bytes)} · ${live.duckdb.threads} threads` : '…'}</div>
                      <p className="mt-1 text-[11px] text-zinc-500">The largest working set one query can hold before spilling to <span className="font-mono">{sys?.duckdb.temp_directory ?? 'scratch'}</span>.</p>
                    </div>
                    <div className="bg-zinc-900/60 p-4">
                      <div className="text-[10px] font-semibold text-zinc-500">Bigger than RAM?</div>
                      <p className="mt-1 text-[11px] leading-relaxed text-zinc-400">Parquet is read column-by-column with predicate push-down, so files far larger than RAM still query fine — the limit is the <em>working set</em> of one query, not the file. Filter early, aggregate, avoid <Tag>SELECT *</Tag>.</p>
                    </div>
                  </div>
                </Panel>
              )}
              {live && live.duckdb.engines.length > 0 && !hidden['settings.engines'] && (
                <Panel hideId="settings.engines" title="Warm engines" meta={`${live.duckdb.engines.length} cached`} bodyClassName="p-0">
                  <table className="w-full font-mono text-xs">
                    <thead className="text-left text-[10px] text-zinc-500">
                      <tr className="border-b border-zinc-800">
                        <th className="px-4 py-2 font-normal">workspace</th>
                        <th className="px-2 py-2 font-normal">database</th>
                        <th className="px-2 py-2 font-normal">allocated</th>
                        <th className="px-2 py-2 font-normal">ceiling</th>
                        <th className="px-2 py-2 font-normal">spill</th>
                        <th className="px-2 py-2 font-normal">threads</th>
                        <th className="px-2 py-2 font-normal">active</th>
                        {isAdmin && <th />}
                      </tr>
                    </thead>
                    <tbody>
                      {live.duckdb.engines.map((e) => (
                        <tr key={e.workspaceId} className="border-b border-zinc-800/60 last:border-0">
                          <td className="px-4 py-2 text-zinc-200">{ws.workspaces.find((w) => w.id === e.workspaceId)?.name ?? e.workspaceId.slice(0, 8)}</td>
                          <td className="px-2 py-2 text-zinc-400">{e.dbPath}</td>
                          <td className="px-2 py-2 text-zinc-200">{formatBytes(e.memory_usage_bytes)}</td>
                          <td className="px-2 py-2 text-zinc-400">{formatBytes(e.memory_limit_bytes)}</td>
                          <td className="px-2 py-2 text-zinc-400">{formatBytes(e.temporary_storage_bytes)}</td>
                          <td className="px-2 py-2 text-zinc-400">{e.threads}</td>
                          <td className="px-2 py-2"><Activity className={`h-3.5 w-3.5 ${e.active_queries ? 'text-emerald-400' : 'text-zinc-600'}`} /></td>
                          {isAdmin && (
                            <td className="px-2 py-2 text-right">
                              <Button size="sm" variant="ghost" onClick={() => api.post(`/api/admin/engines/${e.workspaceId}/evict`)}>Evict</Button>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Panel>
              )}
            </div>
          )}

          {cat === 'engine' &&
            (!workspace ? (
              <p className="text-xs text-zinc-500">Select a workspace first.</p>
            ) : workspace.role !== 'OWNER' ? (
              <Card title="Engine">
                <p className="text-xs text-zinc-500">
                  <span className="text-zinc-200">{workspace.name}</span> is shared with you by {workspace.owner.display_name ?? workspace.owner.email} — only its owner can change memory, threads, timeout or the database path.
                </p>
              </Card>
            ) : (
              <EngineSettingsForm key={workspace.id} workspace={workspace} sys={sys} live={live} connections={connections} onSaved={() => void ws.loadCatalog(true)} />
            ))}

          {cat === 'storage' && (
            <div className="space-y-5">
              <p className="rounded-xl border border-zinc-800 bg-zinc-900/60 px-4 py-2.5 text-xs text-zinc-400">Every source — object storage, lakehouse catalogs, databases, web endpoints — plus scheduled syncs now lives on the <a href="#/connections" className="text-accent-300 hover:underline">Connections page</a>. The lists below stay for credentials that engines apply at start.</p>
              <Card
                title="Lakehouse connections"
                actions={<Button size="sm" onClick={() => setLakeWizard({ open: true, edit: null })}><Layers className="h-3.5 w-3.5" /> Connect</Button>}
              >
                {lakehouses.length === 0 ? (
                  <p className="text-xs text-zinc-500">Attach Iceberg catalogs — AWS Glue / SageMaker Lakehouse, Amazon S3 Tables, any Iceberg REST catalog (Polaris, Lakekeeper, Nessie, Snowflake Open Catalog) — so their tables are queryable in DuckDB as <span className="font-mono">alias.schema.table</span>, or connect Databricks to browse Unity Catalog, run SQL on a warehouse and materialise results locally.</p>
                ) : (
                  <div className="grid gap-2 md:grid-cols-2">
                    {lakehouses.map((c) => (
                      <div key={c.id} className="flex items-center gap-3 rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs">
                        <Badge tone="violet">{c.provider === 'AWS_GLUE' ? 'GLUE' : c.provider === 'AWS_S3_TABLES' ? 'S3 TABLES' : c.provider === 'DATABRICKS' ? 'DATABRICKS' : 'ICEBERG REST'}</Badge>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 text-zinc-200">
                            {c.name}
                            <span className={cn('h-1.5 w-1.5 rounded-full', c.status === 'ok' ? 'bg-emerald-400' : c.status === 'error' ? 'bg-red-400' : 'bg-zinc-600')} title={c.status === 'error' ? c.last_error ?? 'error' : c.status} />
                          </div>
                          <div className="truncate font-mono text-[10px] text-zinc-500">
                            {c.attached ? `attached as ${c.alias}` : 'remote SQL only'}
                            {c.remote_sql ? ' · SQL warehouse' : ''}
                            {c.config.region ? ` · ${c.config.region}` : ''}
                            {c.config.host ? ` · ${c.config.host.replace(/^https?:\/\//, '')}` : ''}
                            {c.config.endpoint ? ` · ${c.config.endpoint.replace(/^https?:\/\//, '')}` : ''}
                          </div>
                          {c.status === 'error' && c.last_error && !testing[c.id] && <div className="truncate font-mono text-[10px] text-red-300" title={c.last_error}>{c.last_error}</div>}
                          {testing[c.id] && <div className="truncate font-mono text-[10px] text-amber-200">{testing[c.id]}</div>}
                        </div>
                        <Button size="sm" variant="ghost" onClick={async () => { setTesting({ ...testing, [c.id]: 'testing…' }); try { const r = await api.post<{ message: string }>(`/api/lakehouse-connections/${c.id}/test`); setTesting({ ...testing, [c.id]: r.message }); } catch (e) { setTesting({ ...testing, [c.id]: (e as Error).message }); } await refresh(); }}>Test</Button>
                        <button className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200" title="Edit" onClick={() => setLakeWizard({ open: true, edit: c })}>
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button className="rounded p-1 text-zinc-500 hover:bg-red-950 hover:text-red-300" title="Delete" onClick={async () => { if (confirm(`Delete lakehouse connection "${c.name}"? The catalog is detached from your engines.`)) { await api.del(`/api/lakehouse-connections/${c.id}`); await refresh(); } }}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <LakehouseWizard open={lakeWizard.open} initial={lakeWizard.edit} onClose={() => setLakeWizard({ open: false, edit: null })} onCreated={() => void refresh()} />
              </Card>
              <Card
                title="Cloud storage"
                actions={<Button size="sm" onClick={() => setWizard(true)}><Cloud className="h-3.5 w-3.5" /> Connect</Button>}
              >
                {cloud.length === 0 ? (
                  <p className="text-xs text-zinc-500">No cloud connections. Connect S3, Cloudflare R2, GCS or Azure Blob to browse buckets in the Explorer and query objects with DuckDB's httpfs — credentials are encrypted at rest and applied as scoped DuckDB secrets.</p>
                ) : (
                  <div className="grid gap-2 md:grid-cols-2">
                    {cloud.map((c) => (
                      <div key={c.id} className="flex items-center gap-3 rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs">
                        <Badge tone="blue">{c.provider}</Badge>
                        <div className="min-w-0 flex-1">
                          <div className="text-zinc-200">{c.name}</div>
                          <div className="truncate font-mono text-[10px] text-zinc-500">{c.uri_scheme}://{c.bucket ?? '<any bucket>'}{c.endpoint_url ? ` · ${c.endpoint_url}` : ''}{c.region ? ` · ${c.region}` : ''}</div>
                          {testing[c.id] && <div className="truncate font-mono text-[10px] text-amber-200">{testing[c.id]}</div>}
                        </div>
                        <Button size="sm" variant="ghost" onClick={async () => { setTesting({ ...testing, [c.id]: 'testing…' }); try { const r = await api.post<{ message: string }>(`/api/cloud-connections/${c.id}/test`); setTesting({ ...testing, [c.id]: r.message }); } catch (e) { setTesting({ ...testing, [c.id]: (e as Error).message }); } }}>Test</Button>
                        <button className="rounded p-1 text-zinc-500 hover:bg-red-950 hover:text-red-300" onClick={async () => { if (confirm(`Delete cloud connection "${c.name}"?`)) { await api.del(`/api/cloud-connections/${c.id}`); await refresh(); } }}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <CloudWizard open={wizard} onClose={() => setWizard(false)} onCreated={() => void refresh()} />
              </Card>
              <Card
                title="Data connections"
                actions={<Button size="sm" onClick={() => setNewConn({ open: true, name: '', type: 'S3', creds: {} })}><Plug className="h-3.5 w-3.5" /> Add</Button>}
              >
                {!externalAccess && <div className="mb-3 rounded-md border border-amber-900 bg-amber-950/40 px-3 py-2 text-[11px] text-amber-200">External access is disabled (security.enable_external_access=false). Credentials are stored encrypted but remote sources stay unreachable until it is enabled.</div>}
                {connections.length === 0 ? (
                  <p className="text-xs text-zinc-500">MotherDuck tokens, Postgres and HTTP secrets applied to a workspace engine at start. Credentials are AES-256-GCM encrypted at rest and never returned by the API.</p>
                ) : (
                  <div className="space-y-2">
                    {connections.map((c) => (
                      <div key={c.id} className="flex items-center gap-3 rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs">
                        <Badge tone="violet">{c.type}</Badge>
                        <div className="min-w-0 flex-1">
                          <div className="text-zinc-200">{c.name}</div>
                          <div className="font-mono text-[10px] text-zinc-500">{c.fields.join(', ')}</div>
                        </div>
                        <button className="rounded p-1 text-zinc-500 hover:bg-red-950 hover:text-red-300" onClick={async () => { if (confirm(`Delete connection "${c.name}"?`)) { await api.del(`/api/connections/${c.id}`); await refresh(); } }}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            </div>
          )}

          {cat === 'copilot' && (copilotCfg ? <CopilotPanel cfg={copilotCfg} isAdmin={isAdmin} reload={() => { api.get<CopilotConfig>('/api/copilot/config').then(setCopilotCfg).catch(() => undefined); void cp.loadConfig(); }} /> : <p className="text-xs text-zinc-500">Loading…</p>)}

          {cat === 'integrations' && <IntegrationsPanel isAdmin={!!isAdmin} />}

          {cat === 'account' && (
            <Card title="Account">
              <div className="mb-3 text-xs text-zinc-400">
                Signed in as <span className="text-zinc-200">{auth.user?.email}</span> · role <Badge tone="violet">{auth.user?.role}</Badge> · provider {auth.user?.auth_provider}
              </div>
              {auth.user?.auth_provider === 'local' && (
                <form
                  className="max-w-sm space-y-2"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    try {
                      await api.post('/api/auth/password', { current_password: pw.current, new_password: pw.next });
                      setPw({ current: '', next: '', msg: 'Password updated.' });
                    } catch (err) {
                      setPw({ ...pw, msg: (err as Error).message });
                    }
                  }}
                >
                  <Label>Change password</Label>
                  <Input type="password" placeholder="Current password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} autoComplete="current-password" />
                  <Input type="password" placeholder="New password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} autoComplete="new-password" />
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] text-zinc-500">{pw.msg}</span>
                    <Button size="sm" type="submit"><KeyRound className="h-3.5 w-3.5" /> Update</Button>
                  </div>
                </form>
              )}
            </Card>
          )}

          {cat === 'teams' && <TeamsPanel />}

          {cat === 'audit' && <AuditPanel isAdmin={!!isAdmin} />}

          {cat === 'provisioning' && isAdmin && <ProvisioningPanel />}

          {cat === 'apps' && isAdmin && <AppsAdminPanel />}

          {cat === 'users' && isAdmin && (
            <Card title="Users" actions={<Button size="sm" onClick={() => setNewUser({ open: true, email: '', password: '', role: 'USER' })}><Users className="h-3.5 w-3.5" /> Add</Button>}>
              <table className="w-full text-xs">
                <thead className="text-left text-[10px] text-zinc-500">
                  <tr><th className="pb-2">User</th><th className="pb-2">Provider</th><th className="pb-2">Created</th><th className="pb-2">Role</th><th className="pb-2">Status</th><th /></tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u.id} className={cn('border-t border-zinc-800', u.disabled && 'opacity-60')} data-user={u.email}>
                      <td className="py-2"><div className="text-zinc-200">{u.display_name ?? u.email}</div><div className="text-[10px] text-zinc-500">{u.email}</div></td>
                      <td className="py-2 text-zinc-400">{u.auth_provider}</td>
                      <td className="py-2 text-zinc-400">{timeAgo(u.created_at)}</td>
                      <td className="py-2">
                        <Select value={u.role} disabled={u.id === auth.user?.id} className="h-7 text-xs" onChange={async (e) => { await api.patch(`/api/admin/users/${u.id}`, { role: e.target.value }); await refresh(); }}>
                          {['ADMIN', 'USER', 'READ_ONLY'].map((r) => <option key={r} value={r}>{r}</option>)}
                        </Select>
                      </td>
                      <td className="py-2">
                        {u.id === auth.user?.id ? (
                          <Badge tone="green">Active</Badge>
                        ) : (
                          <button
                            className={cn('rounded px-2 py-0.5 text-[11px]', u.disabled ? 'bg-amber-950/60 text-amber-200 hover:bg-amber-900/60' : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100')}
                            title={u.disabled ? 'Deactivated: cannot sign in; sessions, API tokens and scheduled work stop. Click to reactivate.' : 'Deactivate: blocks sign-in and stops their sessions, tokens and scheduled work, keeping their workspaces'}
                            onClick={async () => {
                              try {
                                await api.patch(`/api/admin/users/${u.id}`, { disabled: !u.disabled });
                              } catch (e) {
                                alert((e as Error).message);
                              }
                              await refresh();
                            }}
                          >
                            {u.disabled ? 'Deactivated · Reactivate' : 'Deactivate'}
                          </button>
                        )}
                      </td>
                      <td className="py-2 text-right">
                        {u.id !== auth.user?.id && (
                          <button className="rounded p-1 text-zinc-500 hover:bg-red-950 hover:text-red-300" onClick={async () => { if (confirm(`Delete ${u.email}? Their workspaces and tokens are removed.`)) { await api.del(`/api/admin/users/${u.id}`); await refresh(); } }}>
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
        </div>
      </main>
    </div>
      <Modal open={newUser.open} onClose={() => setNewUser({ ...newUser, open: false })} title="Create user">
        <div className="space-y-3">
          <div>
            <Label>Email</Label>
            <Input type="email" value={newUser.email} onChange={(e) => setNewUser({ ...newUser, email: e.target.value })} />
          </div>
          <div>
            <Label>Password</Label>
            <Input type="password" value={newUser.password} onChange={(e) => setNewUser({ ...newUser, password: e.target.value })} />
          </div>
          <div>
            <Label>Role</Label>
            <Select value={newUser.role} onChange={(e) => setNewUser({ ...newUser, role: e.target.value as User['role'] })} className="w-full">
              {['ADMIN', 'USER', 'READ_ONLY'].map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setNewUser({ ...newUser, open: false })}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={async () => {
                try {
                  await api.post('/api/admin/users', { email: newUser.email, password: newUser.password, role: newUser.role });
                  setNewUser({ ...newUser, open: false });
                  await refresh();
                } catch (e) {
                  alert((e as Error).message);
                }
              }}
            >
              Create
            </Button>
          </div>
        </div>
      </Modal>

      <Modal open={newConn.open} onClose={() => setNewConn({ ...newConn, open: false })} title="Add data connection">
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Name</Label>
              <Input value={newConn.name} onChange={(e) => setNewConn({ ...newConn, name: e.target.value })} placeholder="prod-lake" />
            </div>
            <div>
              <Label>Type</Label>
              <Select value={newConn.type} onChange={(e) => setNewConn({ ...newConn, type: e.target.value, creds: {} })} className="w-full">
                {Object.keys(connTypes).map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </Select>
            </div>
          </div>
          {[...(connTypes[newConn.type]?.required ?? []), ...(connTypes[newConn.type]?.optional ?? [])].map((f) => (
            <div key={f}>
              <Label>
                {f} {connTypes[newConn.type]?.required.includes(f) ? '' : <span className="normal-case text-zinc-600">(optional)</span>}
              </Label>
              <Input type={/secret|token|password/.test(f) ? 'password' : 'text'} value={newConn.creds[f] ?? ''} onChange={(e) => setNewConn({ ...newConn, creds: { ...newConn.creds, [f]: e.target.value } })} className="font-mono" autoComplete="off" />
            </div>
          ))}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setNewConn({ ...newConn, open: false })}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={async () => {
                try {
                  await api.post('/api/connections', { name: newConn.name, type: newConn.type, credentials: newConn.creds });
                  setNewConn({ ...newConn, open: false });
                  await refresh();
                } catch (e) {
                  alert((e as Error).message);
                }
              }}
            >
              Save encrypted
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
