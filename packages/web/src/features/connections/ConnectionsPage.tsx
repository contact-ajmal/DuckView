import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Plug, Database, Cloud, Layers, Globe, Warehouse, Boxes, Plus, RefreshCw, Play, Pause, Trash2, Pencil, CheckCircle2, AlertTriangle, Clock, Bot, ExternalLink, Search } from 'lucide-react';
import { api, timeAgo, type SourceType, type SourceFamily, type CloudConnection, type LakehouseConnection, type DatabaseConnection, type PublicConnection, type DataSync, type DataSyncRun } from '../../api/client';
import { useWorkspace, useWorkspaceAccess } from '../../store/workspace';
import { useCopilot } from '../../store/copilot';
import { subscribeLiveEvents } from '../../lib/liveEvents';
import { Eyebrow, PageTitle } from '../../components/layout';
import { Badge, Button, Empty, Input, cn } from '../../components/ui';
import { CloudWizard } from '../explorer/CloudWizard';
import { LakehouseWizard } from '../explorer/LakehouseWizard';
import { DatabaseWizard } from './DatabaseWizard';
import { SyncEditor } from './SyncEditor';

const FAMILY_ICON: Record<SourceFamily, ReactNode> = { storage: <Cloud className="h-4 w-4" />, lakehouse: <Layers className="h-4 w-4" />, database: <Database className="h-4 w-4" />, web: <Globe className="h-4 w-4" />, warehouse: <Warehouse className="h-4 w-4" />, saas: <Boxes className="h-4 w-4" /> };

type Tab = 'sources' | 'catalog' | 'syncs';

/**
 * Connections: the catalog of source types, everything configured (storage, lakehouse, databases, HTTP), and the
 * scheduled syncs of the active workspace — the same objects agents reach through list_data_sources and the sync tools.
 */
export function ConnectionsPage() {
  const ws = useWorkspace();
  const wsId = ws.activeId;
  const { canEdit } = useWorkspaceAccess();
  const cp = useCopilot();
  const [tab, setTab] = useState<Tab>((/^#\/connections\/(\w+)/.exec(location.hash)?.[1] as Tab) || 'sources');
  const [catalog, setCatalog] = useState<{ families: Record<SourceFamily, { label: string; blurb: string }>; sources: SourceType[] } | null>(null);
  const [configured, setConfigured] = useState<{ cloud: CloudConnection[]; lakehouse: LakehouseConnection[]; databases: DatabaseConnection[]; http: PublicConnection[]; mode: string; external_access: boolean } | null>(null);
  const [syncs, setSyncs] = useState<DataSync[]>([]);
  const [runs, setRuns] = useState<Record<string, DataSyncRun[]>>({});
  const [filter, setFilter] = useState('');
  const [wizard, setWizard] = useState<{ kind: 'cloud' } | { kind: 'lakehouse'; edit: LakehouseConnection | null } | { kind: 'database'; source: SourceType | null; edit: DatabaseConnection | null } | { kind: 'sync'; edit: DataSync | null } | null>(null);
  const [testing, setTesting] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [c, s] = await Promise.all([api.get<typeof catalog>('/api/sources/catalog'), api.get<typeof configured>('/api/sources')]);
    setCatalog(c);
    setConfigured(s);
    if (wsId) setSyncs((await api.get<{ syncs: DataSync[] }>(`/api/workspaces/${wsId}/syncs`)).syncs);
  }, [wsId]);
  useEffect(() => void load().catch(() => undefined), [load]);
  useEffect(() => {
    const on = () => setTab((/^#\/connections\/(\w+)/.exec(location.hash)?.[1] as Tab) || 'sources');
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  // Live: sync runs update the list as they happen.
  useEffect(() => subscribeLiveEvents((e) => { if (e.type === 'sync' && e.workspace_id === wsId) void api.get<{ syncs: DataSync[] }>(`/api/workspaces/${wsId}/syncs`).then((r) => setSyncs(r.syncs)).catch(() => undefined); }), [wsId]);

  const go = (t: Tab) => { location.hash = `#/connections/${t}`; setTab(t); };
  const openWizard = (s: SourceType) => {
    if (s.backend.family === 'cloud') setWizard({ kind: 'cloud' });
    else if (s.backend.family === 'lakehouse') setWizard({ kind: 'lakehouse', edit: null });
    else if (s.backend.family === 'database') setWizard({ kind: 'database', source: s, edit: null });
    else if (s.backend.family === 'http') { if (wsId) setWizard({ kind: 'sync', edit: null }); }
  };
  const testDb = async (c: DatabaseConnection) => {
    setTesting((t) => ({ ...t, [c.id]: 'testing…' }));
    try {
      const r = await api.post<{ ok: boolean; message: string }>(`/api/database-connections/${c.id}/test`, {});
      setTesting((t) => ({ ...t, [c.id]: r.message }));
    } catch (e) {
      setTesting((t) => ({ ...t, [c.id]: (e as Error).message }));
    }
    await load();
  };
  const testLake = async (c: LakehouseConnection) => {
    setTesting((t) => ({ ...t, [c.id]: 'testing…' }));
    try {
      const r = await api.post<{ ok: boolean; message: string }>(`/api/lakehouse/${c.id}/test`, {});
      setTesting((t) => ({ ...t, [c.id]: r.message }));
    } catch (e) {
      setTesting((t) => ({ ...t, [c.id]: (e as Error).message }));
    }
    await load();
  };
  const runSync = async (s: DataSync) => {
    setBusy(s.id);
    try {
      await api.post(`/api/syncs/${s.id}/run`, {});
    } finally {
      setBusy(null);
      await load();
    }
  };
  const toggleRuns = async (s: DataSync) => {
    if (runs[s.id]) return setRuns((r) => { const n = { ...r }; delete n[s.id]; return n; });
    const r = await api.get<{ runs: DataSyncRun[] }>(`/api/syncs/${s.id}/runs`);
    setRuns((x) => ({ ...x, [s.id]: r.runs }));
  };

  const sources = catalog?.sources ?? [];
  const q = filter.trim().toLowerCase();
  const matches = (s: SourceType) => !q || `${s.label} ${s.vendor} ${s.blurb} ${s.family}`.toLowerCase().includes(q);
  const configuredCount = configured ? configured.cloud.length + configured.lakehouse.length + configured.databases.length + configured.http.length : 0;
  const scheduleLabel = (s: DataSync) => (s.schedule.kind === 'manual' ? 'manual' : s.schedule.kind === 'interval' ? `every ${s.schedule.minutes} min` : `cron ${s.schedule.expression}`);

  return (
    <div className="mx-auto max-w-7xl space-y-5 p-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Eyebrow>Data</Eyebrow>
          <PageTitle>Connections</PageTitle>
          <p className="mt-1 text-xs text-zinc-500">Object storage, lakehouse catalogs, databases and web sources — connected once, queried from every workspace, loaded on a schedule, and reachable by agents through <code className="font-mono">list_data_sources</code> and the sync tools.</p>
        </div>
        <div className="flex items-center gap-1 rounded-lg border border-zinc-800 p-0.5">
          {([['sources', `Configured (${configuredCount})`], ['catalog', 'Add a source'], ['syncs', `Syncs (${syncs.length})`]] as [Tab, string][]).map(([t, label]) => (
            <button key={t} onClick={() => go(t)} className={cn('rounded-md px-3 py-1.5 text-xs', tab === t ? 'bg-zinc-800 text-zinc-50' : 'text-zinc-400 hover:text-zinc-100')}>{label}</button>
          ))}
        </div>
      </div>

      {tab === 'sources' && configured && (
        <div className="space-y-4">
          {configuredCount === 0 && <div className="rounded-xl border border-dashed border-zinc-800 py-14"><Empty icon={<Plug className="h-10 w-10" />} title="No connections yet" hint="Pick a source type under Add a source — object storage, a lakehouse catalog, a database, a web endpoint or a shared sheet." /><div className="mt-3 flex justify-center"><Button variant="primary" onClick={() => go('catalog')}><Plus className="h-4 w-4" /> Add a source</Button></div></div>}
          {configured.databases.length > 0 && (
            <Section title="Databases" icon={FAMILY_ICON.database} hint="Attached read-only to every engine of your workspaces; query as alias.schema.table.">
              {configured.databases.map((c) => (
                <Row key={c.id} title={c.name} badge={<Badge>{c.engine}</Badge>} status={c.status} sub={<><code className="font-mono">{c.alias}</code> · {c.engine === 'sqlite' || c.engine === 'duckdb' ? c.config.path : `${c.config.user}@${c.config.host}:${c.config.port ?? (c.engine === 'postgres' ? 5432 : 3306)}/${c.config.database}`}{c.config.read_only === false ? ' · read-write' : ' · read-only'}{c.last_tested_at ? ` · tested ${timeAgo(c.last_tested_at)}` : ''}{c.last_error ? <span className="text-red-300"> · {c.last_error}</span> : null}{testing[c.id] ? <span className="text-zinc-400"> · {testing[c.id]}</span> : null}{c.needs_external_access && !configured.external_access ? <span className="text-amber-300"> · needs security.enable_external_access</span> : null}</>}
                  actions={<>
                    <Button size="sm" variant="ghost" onClick={() => void testDb(c)} title="Test the connection"><RefreshCw className="h-3.5 w-3.5" /> Test</Button>
                    <Button size="sm" variant="ghost" onClick={() => setWizard({ kind: 'sync', edit: null })} disabled={!wsId || !canEdit} title="Schedule a load from this database"><Clock className="h-3.5 w-3.5" /> Sync</Button>
                    <Button size="sm" variant="ghost" onClick={() => setWizard({ kind: 'database', source: sources.find((s) => s.backend.family === 'database' && s.backend.engine === c.engine) ?? null, edit: c })} title="Edit"><Pencil className="h-3.5 w-3.5" /></Button>
                    <Button size="sm" variant="ghost" className="text-red-300" onClick={async () => { if (confirm(`Remove "${c.name}"? Syncs reading from it will fail.`)) { await api.del(`/api/database-connections/${c.id}`); await load(); } }} title="Remove"><Trash2 className="h-3.5 w-3.5" /></Button>
                  </>} />
              ))}
            </Section>
          )}
          {configured.lakehouse.length > 0 && (
            <Section title="Lakehouse catalogs" icon={FAMILY_ICON.lakehouse} hint="Iceberg / Unity catalogs attached as alias.schema.table; browse them in the explorer.">
              {configured.lakehouse.map((c) => (
                <Row key={c.id} title={c.name} badge={<Badge>{c.provider.toLowerCase().replace('_', ' ')}</Badge>} status={c.status} sub={<><code className="font-mono">{c.alias}</code> · {c.example_sql}{c.last_tested_at ? ` · tested ${timeAgo(c.last_tested_at)}` : ''}{c.last_error ? <span className="text-red-300"> · {c.last_error}</span> : null}{testing[c.id] ? <span className="text-zinc-400"> · {testing[c.id]}</span> : null}</>}
                  actions={<>
                    <Button size="sm" variant="ghost" onClick={() => void testLake(c)}><RefreshCw className="h-3.5 w-3.5" /> Test</Button>
                    <Button size="sm" variant="ghost" onClick={() => setWizard({ kind: 'lakehouse', edit: c })}><Pencil className="h-3.5 w-3.5" /></Button>
                    <Button size="sm" variant="ghost" className="text-red-300" onClick={async () => { if (confirm(`Remove "${c.name}"?`)) { await api.del(`/api/lakehouse/${c.id}`); await load(); } }}><Trash2 className="h-3.5 w-3.5" /></Button>
                  </>} />
              ))}
            </Section>
          )}
          {configured.cloud.length > 0 && (
            <Section title="Object storage" icon={FAMILY_ICON.storage} hint="Buckets browsed in the explorer and queried by URI; also where cloud-backed workspaces live.">
              {configured.cloud.map((c) => (
                <Row key={c.id} title={c.name} badge={<Badge>{c.provider}</Badge>} status="ok" sub={<>{c.uri_scheme}://{c.bucket ?? '<bucket>'}/… · {c.fields.join(', ')}{c.region ? ` · ${c.region}` : ''}{c.endpoint_url ? ` · ${c.endpoint_url}` : ''}</>}
                  actions={<Button size="sm" variant="ghost" className="text-red-300" onClick={async () => { if (confirm(`Remove "${c.name}"?`)) { await api.del(`/api/cloud-connections/${c.id}`); await load(); } }}><Trash2 className="h-3.5 w-3.5" /></Button>} />
              ))}
            </Section>
          )}
          {configured.http.length > 0 && (
            <Section title="HTTP credentials" icon={FAMILY_ICON.web} hint="Bearer tokens and headers applied to https:// reads (Settings → Storage → Data connections).">
              {configured.http.map((c) => <Row key={c.id} title={c.name} badge={<Badge>HTTP</Badge>} status="ok" sub={<>{c.fields.join(', ')}</>} actions={null} />)}
            </Section>
          )}
        </div>
      )}

      {tab === 'catalog' && catalog && (
        <div className="space-y-5">
          <div className="relative max-w-md"><Search className="absolute left-2.5 top-2.5 h-4 w-4 text-zinc-500" /><Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search sources… postgres, sheets, iceberg" className="pl-8" /></div>
          {(Object.keys(catalog.families) as SourceFamily[]).map((fam) => {
            const items = sources.filter((s) => s.family === fam && matches(s));
            if (!items.length) return null;
            return (
              <div key={fam}>
                <div className="mb-2 flex items-baseline gap-2"><span className="text-zinc-400">{FAMILY_ICON[fam]}</span><h3 className="text-sm font-semibold text-zinc-100">{catalog.families[fam].label}</h3><span className="text-[11px] text-zinc-500">{catalog.families[fam].blurb}</span></div>
                <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
                  {items.map((s) => (
                    <button key={s.id} type="button" disabled={s.status === 'planned' || !canEdit} onClick={() => openWizard(s)} className={cn('group rounded-lg border p-3 text-left', s.status === 'planned' ? 'cursor-default border-zinc-800/60 opacity-60' : 'border-zinc-800 hover:border-accent-500/60 hover:bg-accent-500/5')} title={s.status === 'planned' ? 'Planned — not available yet' : `Connect ${s.label}`}>
                      <div className="flex items-center justify-between gap-1">
                        <span className="truncate text-[13px] font-semibold text-zinc-100">{s.label}</span>
                        {s.status === 'planned' ? <Badge tone="zinc">planned</Badge> : <span className="font-mono text-[9px] uppercase tracking-wide text-zinc-500">{s.vendor}</span>}
                      </div>
                      <div className="mt-1 line-clamp-2 text-[11px] leading-snug text-zinc-500">{s.blurb}</div>
                      <div className="mt-2 flex flex-wrap gap-1">
                        {s.capabilities.attach && <Badge tone="violet">attach</Badge>}
                        {s.capabilities.browse && <Badge>browse</Badge>}
                        {s.capabilities.remote_sql && <Badge tone="blue">remote SQL</Badge>}
                        {s.capabilities.sync && <Badge tone="green">sync</Badge>}
                        <Badge>{s.auth === 'keys' ? 'access keys' : s.auth === 'token' ? 'token' : s.auth === 'password' ? 'password' : s.auth === 'file' ? 'file' : s.auth === 'connection_string' ? 'connection string' : s.auth === 'oauth' ? 'OAuth' : 'no auth'}</Badge>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
          <p className="text-[11px] text-zinc-500">Missing a source? Planned ones are listed honestly; anything that speaks Postgres wire, S3 or an Iceberg REST catalog works today through those entries. Ask for a connector at <a className="text-accent-300 hover:underline" href="https://github.com/contact-ajmal/DuckView/issues" target="_blank" rel="noreferrer">github.com/contact-ajmal/DuckView/issues <ExternalLink className="inline h-3 w-3" /></a>.</p>
        </div>
      )}

      {tab === 'syncs' && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-xs text-zinc-500">Scheduled loads into <b className="text-zinc-300">{ws.workspaces.find((w) => w.id === wsId)?.name ?? 'the active workspace'}</b>: a source, a target table, a schedule, an optional transformation — run by the server, recorded per run, driven by agents through <code className="font-mono">create_data_sync</code> / <code className="font-mono">run_data_sync</code>.</p>
            <div className="ml-auto flex gap-2">
              <Button size="sm" variant="ghost" onClick={() => cp.toggle(true)} title="Ask Copilot to design a pipeline"><Bot className="h-3.5 w-3.5" /> Copilot</Button>
              <Button size="sm" variant="primary" disabled={!wsId || !canEdit} onClick={() => setWizard({ kind: 'sync', edit: null })}><Plus className="h-3.5 w-3.5" /> New sync</Button>
            </div>
          </div>
          {syncs.length === 0 ? (
            <div className="rounded-xl border border-dashed border-zinc-800 py-14"><Empty icon={<Clock className="h-10 w-10" />} title="No syncs yet" hint="Load a table from a connected database, a CSV/JSON endpoint, a shared Google Sheet or any SELECT into this workspace on a schedule." /></div>
          ) : (
            <div className="divide-y divide-zinc-800 rounded-xl border border-zinc-800">
              {syncs.map((s) => (
                <div key={s.id} className="p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusDot status={s.last_run?.status ?? 'unknown'} />
                    <span className="text-sm font-semibold text-zinc-100">{s.name}</span>
                    <span className="font-mono text-[11px] text-zinc-500">→ {s.target_schema}.{s.target_table}</span>
                    <Badge>{s.mode}</Badge>
                    <Badge tone={s.enabled ? 'green' : 'amber'}>{s.enabled ? scheduleLabel(s) : 'paused'}</Badge>
                    {s.transform_sql && <Badge tone="violet">transform</Badge>}
                    <span className="ml-auto text-[11px] text-zinc-500">
                      {s.last_run ? <>last {s.last_run.status}{s.last_run.rows != null ? ` · ${s.last_run.rows.toLocaleString()} rows` : ''}{s.last_run.duration_ms != null ? ` · ${(s.last_run.duration_ms / 1000).toFixed(1)} s` : ''} · {timeAgo(s.last_run.started_at)}</> : 'never run'}
                      {s.next_run_at && s.enabled ? ` · next ${new Date(s.next_run_at).toLocaleString()}` : ''}
                    </span>
                    <div className="flex items-center gap-1">
                      <Button size="sm" variant="secondary" onClick={() => void runSync(s)} loading={busy === s.id} disabled={!canEdit} title="Run now"><Play className="h-3.5 w-3.5" /> Run</Button>
                      <Button size="sm" variant="ghost" onClick={async () => { await api.patch(`/api/syncs/${s.id}`, { enabled: !s.enabled }); await load(); }} disabled={!canEdit} title={s.enabled ? 'Pause' : 'Resume'}>{s.enabled ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}</Button>
                      <Button size="sm" variant="ghost" onClick={() => setWizard({ kind: 'sync', edit: s })} disabled={!canEdit} title="Edit"><Pencil className="h-3.5 w-3.5" /></Button>
                      <Button size="sm" variant="ghost" onClick={() => void toggleRuns(s)} title="Run history"><Clock className="h-3.5 w-3.5" /></Button>
                      <Button size="sm" variant="ghost" className="text-red-300" onClick={async () => { if (confirm(`Delete sync "${s.name}"? The target table stays.`)) { await api.del(`/api/syncs/${s.id}`); await load(); } }} disabled={!canEdit} title="Delete"><Trash2 className="h-3.5 w-3.5" /></Button>
                    </div>
                  </div>
                  <div className="mt-1 font-mono text-[10.5px] text-zinc-500">{describeSource(s, configured?.databases ?? [])}</div>
                  {s.last_run?.error && <div className="mt-1 rounded-md border border-red-900/60 bg-red-950/30 px-2 py-1 font-mono text-[10.5px] text-red-200">{s.last_run.error}</div>}
                  {runs[s.id] && (
                    <ul className="mt-2 divide-y divide-zinc-800/60 rounded-md border border-zinc-800 text-[10.5px]">
                      {runs[s.id]!.length === 0 && <li className="px-2 py-1 text-zinc-600">No runs yet.</li>}
                      {runs[s.id]!.map((r) => <li key={r.id} className="flex flex-wrap items-center gap-2 px-2 py-1 font-mono"><StatusDot status={r.status} /><span className="text-zinc-400">{new Date(r.started_at).toLocaleString()}</span><Badge>{r.triggered_by}</Badge><span className={r.status === 'error' ? 'text-red-300' : 'text-zinc-300'}>{r.status === 'ok' ? `${(r.rows ?? 0).toLocaleString()} rows · ${((r.duration_ms ?? 0) / 1000).toFixed(1)} s` : r.status === 'running' ? 'running…' : r.error}</span></li>)}
                    </ul>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <CloudWizard open={wizard?.kind === 'cloud'} onClose={() => setWizard(null)} onCreated={() => { void load(); go('sources'); }} />
      <LakehouseWizard open={wizard?.kind === 'lakehouse'} initial={wizard?.kind === 'lakehouse' ? wizard.edit : null} onClose={() => setWizard(null)} onCreated={() => { void load(); go('sources'); }} />
      <DatabaseWizard open={wizard?.kind === 'database'} source={wizard?.kind === 'database' ? wizard.source : null} initial={wizard?.kind === 'database' ? wizard.edit : null} onClose={() => { setWizard(null); void load(); go('sources'); }} onSaved={() => void load()} />
      {wsId && <SyncEditor open={wizard?.kind === 'sync'} workspaceId={wsId} initial={wizard?.kind === 'sync' ? wizard.edit : null} databases={configured?.databases ?? []} lakehouses={configured?.lakehouse ?? []} onClose={() => setWizard(null)} onSaved={() => { void load(); go('syncs'); }} />}
    </div>
  );
}

function describeSource(s: DataSync, databases: DatabaseConnection[]): string {
  const src = s.source;
  if (src.kind === 'table') return `${src.catalog ?? databases.find((d) => d.id === src.database_connection_id)?.alias ?? 'db'}.${src.schema}.${src.table}`;
  if (src.kind === 'url') return src.url;
  return src.sql.slice(0, 140);
}

function Section({ title, icon, hint, children }: { title: string; icon: ReactNode; hint: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/40">
      <header className="flex items-baseline gap-2 border-b border-zinc-800 px-4 py-2"><span className="text-zinc-400">{icon}</span><h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-300">{title}</h3><span className="text-[11px] text-zinc-500">{hint}</span></header>
      <div className="divide-y divide-zinc-800/60">{children}</div>
    </section>
  );
}
function Row({ title, badge, status, sub, actions }: { title: string; badge: ReactNode; status: 'ok' | 'error' | 'unknown'; sub: ReactNode; actions: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2 px-4 py-2.5">
      <StatusDot status={status} />
      <span className="text-sm font-medium text-zinc-100">{title}</span>
      {badge}
      <span className="min-w-0 flex-1 truncate text-[11px] text-zinc-500">{sub}</span>
      <div className="flex items-center gap-1">{actions}</div>
    </div>
  );
}
function StatusDot({ status }: { status: string }) {
  if (status === 'ok') return <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-400" />;
  if (status === 'error') return <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-red-400" />;
  if (status === 'running') return <RefreshCw className="h-3.5 w-3.5 shrink-0 animate-spin text-accent-300" />;
  return <span className="h-2 w-2 shrink-0 rounded-full bg-zinc-600" title="not tested yet" />;
}
