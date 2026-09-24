import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Plug, Database, Cloud, Layers, Globe, Warehouse, Boxes, Plus, RefreshCw, Play, Pause, Trash2, Pencil, CheckCircle2, AlertTriangle, Clock, ExternalLink, Search, Sparkles } from 'lucide-react';
import { api, timeAgo, type SourceType, type SourceFamily, type CloudConnection, type LakehouseConnection, type DatabaseConnection, type PublicConnection, type DataSync, type DataSyncRun, type ConnectorConnection, type ConnectorSummary } from '../../api/client';
import { useWorkspace, useWorkspaceAccess } from '../../store/workspace';
import { useAuth } from '../../store/auth';
import { useCopilot } from '../../store/copilot';
import { subscribeLiveEvents } from '../../lib/liveEvents';
import { PageHeader } from '../../components/layout';
import { Badge, Button, Empty, Input, Tabs, cn } from '../../components/ui';
import { CloudWizard } from '../explorer/CloudWizard';
import { LakehouseWizard } from '../explorer/LakehouseWizard';
import { DatabaseWizard } from './DatabaseWizard';
import { SyncEditor } from './SyncEditor';
import { ReversePanel } from './ReversePanel';
import { StreamsPanel } from './StreamsPanel';
import { ConnectorWizard } from './ConnectorWizard';
import { HttpWizard } from './HttpWizard';

const FAMILY_ICON: Record<SourceFamily, ReactNode> = { storage: <Cloud className="h-4 w-4" />, lakehouse: <Layers className="h-4 w-4" />, database: <Database className="h-4 w-4" />, web: <Globe className="h-4 w-4" />, warehouse: <Warehouse className="h-4 w-4" />, saas: <Boxes className="h-4 w-4" /> };

type Tab = 'sources' | 'catalog' | 'syncs' | 'streams' | 'reverse';

/**
 * Connections: the catalog of source types, everything configured (storage, lakehouse, databases, HTTP), and the
 * scheduled syncs of the active workspace — the same objects agents reach through list_data_sources and the sync tools.
 */
export function ConnectionsPage() {
  const ws = useWorkspace();
  const wsId = ws.activeId;
  const { canEdit } = useWorkspaceAccess();
  const cp = useCopilot();
  const isAdmin = useAuth((s) => s.user?.role === 'ADMIN');
  const [tab, setTab] = useState<Tab>((/^#\/connections\/(\w+)/.exec(location.hash)?.[1] as Tab) || 'sources');
  const [catalog, setCatalog] = useState<{ families: Record<SourceFamily, { label: string; blurb: string }>; sources: SourceType[] } | null>(null);
  const [configured, setConfigured] = useState<{ cloud: CloudConnection[]; lakehouse: LakehouseConnection[]; databases: DatabaseConnection[]; http: PublicConnection[]; connectors: ConnectorConnection[]; google_configured: boolean; mode: string; external_access: boolean } | null>(null);
  const [connectorCatalog, setConnectorCatalog] = useState<ConnectorSummary[]>([]);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [syncs, setSyncs] = useState<DataSync[]>([]);
  const [runs, setRuns] = useState<Record<string, DataSyncRun[]>>({});
  const [filter, setFilter] = useState('');
  const [wizard, setWizard] = useState<{ kind: 'cloud'; provider: CloudConnection['provider'] | null; edit: CloudConnection | null } | { kind: 'http' } | { kind: 'lakehouse'; provider: LakehouseConnection['provider'] | null; edit: LakehouseConnection | null } | { kind: 'database'; source: SourceType | null; edit: DatabaseConnection | null } | { kind: 'connector'; source: SourceType | null; connector: ConnectorSummary; edit: ConnectorConnection | null } | { kind: 'sync'; edit: DataSync | null; connectorId?: string; sourceKind?: 'table' | 'connector' | 'url' | 'sheet' | 'sql'; resource?: Record<string, unknown>; name?: string } | null>(null);
  const [testing, setTesting] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  // A wizard that saved something lands on Configured when it closes; a cancelled one stays where it was.
  const savedRef = useRef(false);
  const closeWizard = () => { setWizard(null); if (savedRef.current) { savedRef.current = false; void load(); go('sources'); } };
  const markSaved = () => { savedRef.current = true; void load(); };

  const load = useCallback(async () => {
    const [c, s, k] = await Promise.all([api.get<typeof catalog>('/api/sources/catalog'), api.get<typeof configured>('/api/sources'), api.get<{ connectors: ConnectorSummary[] }>('/api/connectors')]);
    setCatalog(c);
    setConfigured(s);
    setConnectorCatalog(k.connectors);
    if (wsId) setSyncs((await api.get<{ syncs: DataSync[] }>(`/api/workspaces/${wsId}/syncs`)).syncs);
  }, [wsId]);
  useEffect(() => void load().catch(() => undefined), [load, tab]); // every tab switch refreshes (agents add connections too)
  useEffect(() => {
    const on = () => setTab((/^#\/connections\/(\w+)/.exec(location.hash)?.[1] as Tab) || 'sources');
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  // The Overview's data source bar hands over a connector resource to import: #/connections/syncs?new=1 + a draft.
  useEffect(() => {
    const q = new URLSearchParams(location.hash.split('?')[1] ?? '');
    if (q.get('new') !== '1' || !wsId) return;
    try {
      const draft = JSON.parse(sessionStorage.getItem('duckview.syncDraft') ?? 'null') as { connection_id: string; resource: Record<string, unknown>; name: string } | null;
      sessionStorage.removeItem('duckview.syncDraft');
      history.replaceState(null, '', '#/connections/syncs');
      setTab('syncs');
      setWizard(draft ? { kind: 'sync', edit: null, connectorId: draft.connection_id, resource: draft.resource, name: draft.name } : { kind: 'sync', edit: null });
    } catch {
      /* no draft */
    }
  }, [wsId]);
  // Back from Google's consent screen: #/connections?connected=<id> or ?google_error=<message>.
  useEffect(() => {
    const q = new URLSearchParams(location.hash.split('?')[1] ?? '');
    if (q.get('connected')) setNotice({ tone: 'ok', text: 'Google account connected. Schedule a sync from it under Syncs → New sync → Connector.' });
    else if (q.get('google_error')) setNotice({ tone: 'error', text: `Google sign-in failed: ${q.get('google_error')}` });
    else return;
    history.replaceState(null, '', '#/connections');
  }, []);
  // Live: sync runs update the list as they happen.
  useEffect(() => subscribeLiveEvents((e) => { if (e.type === 'sync' && e.workspace_id === wsId) void api.get<{ syncs: DataSync[] }>(`/api/workspaces/${wsId}/syncs`).then((r) => setSyncs(r.syncs)).catch(() => undefined); }), [wsId]);

  const go = (t: Tab) => { location.hash = `#/connections/${t}`; setTab(t); };
  // Every catalog card opens the form of that source — no second "pick a provider" step.
  const openWizard = (s: SourceType) => {
    if (s.backend.family === 'cloud') setWizard({ kind: 'cloud', provider: s.backend.provider, edit: null });
    else if (s.backend.family === 'lakehouse') setWizard({ kind: 'lakehouse', provider: s.backend.provider, edit: null });
    else if (s.backend.family === 'database') setWizard({ kind: 'database', source: s, edit: null });
    else if (s.backend.family === 'connector') { const c = connectorCatalog.find((k) => k.id === (s.backend as { connector: string }).connector); if (c) setWizard({ kind: 'connector', source: s, connector: c, edit: null }); }
    else if (s.backend.family === 'http') { if (s.id === 'google_sheets_link') { if (wsId) setWizard({ kind: 'sync', edit: null, sourceKind: 'sheet' }); } else setWizard({ kind: 'http' }); }
  };
  const testConnector = async (c: ConnectorConnection) => {
    setTesting((t) => ({ ...t, [c.id]: 'testing…' }));
    try {
      const r = await api.post<{ ok: boolean; message: string }>(`/api/connector-connections/${c.id}/test`, {});
      setTesting((t) => ({ ...t, [c.id]: r.message }));
    } catch (e) {
      setTesting((t) => ({ ...t, [c.id]: (e as Error).message }));
    }
    await load();
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
  const configuredCount = configured ? configured.cloud.length + configured.lakehouse.length + configured.databases.length + configured.http.length + configured.connectors.length : 0;
  const scheduleLabel = (s: DataSync) => (s.schedule.kind === 'manual' ? 'manual' : s.schedule.kind === 'interval' ? `every ${s.schedule.minutes} min` : `cron ${s.schedule.expression}`);

  return (
    <div className="h-full min-h-0 overflow-auto">
    <div className="mx-auto max-w-[1180px] space-y-4 px-6 py-5 pb-16">
      <PageHeader
        title="Connections"
        description="Storage, databases, warehouses, SaaS apps and lakehouse catalogs — connected once, used by every workspace."
        actions={canEdit ? <Button variant="primary" onClick={() => go('catalog')}><Plus className="h-3.5 w-3.5" /> Add a source</Button> : undefined}
      />
      <Tabs<Tab> value={tab} onChange={go} tabs={[{ id: 'sources', label: 'Configured', count: configuredCount }, { id: 'catalog', label: 'Add a source' }, { id: 'syncs', label: 'Syncs', count: syncs.length }, { id: 'streams', label: 'Streams' }, { id: 'reverse', label: 'Reverse ETL' }]} />

      {notice && <div className={cn('flex items-start gap-2 rounded-lg border px-3 py-2 text-xs', notice.tone === 'ok' ? 'border-emerald-900/60 bg-emerald-950/30 text-emerald-200' : 'border-red-900/60 bg-red-950/30 text-red-200')}>{notice.tone === 'ok' ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />}<span>{notice.text}</span><button className="ml-auto text-zinc-500 hover:text-zinc-200" onClick={() => setNotice(null)}>×</button></div>}

      {tab === 'sources' && configured && (
        <div className="space-y-4">
          {configuredCount === 0 && <div className="border-y border-zinc-800 py-14"><Empty icon={<Plug />} title="No connections yet" hint="Connect object storage, a lakehouse catalog, a database, a warehouse or a SaaS app." action={<Button size="sm" onClick={() => go('catalog')}><Plus className="h-3.5 w-3.5" /> Add a source</Button>} /></div>}
          {configured.databases.length > 0 && (
            <Section title="Databases" icon={FAMILY_ICON.database} hint="Attached to every workspace engine as alias.schema.table.">
              {configured.databases.map((c) => (
                <Row key={c.id} title={c.name} badge={<Badge>{c.engine}</Badge>} status={c.status} onOpen={() => setWizard({ kind: 'database', source: sources.find((s) => s.backend.family === 'database' && s.backend.engine === c.engine) ?? null, edit: c })} sub={<><code className="font-mono">{c.alias}</code> · {c.engine === 'sqlite' || c.engine === 'duckdb' ? c.config.path : `${c.config.user}@${c.config.host}:${c.config.port ?? (c.engine === 'postgres' ? 5432 : 3306)}/${c.config.database}`}{c.config.read_only === false ? ' · read-write' : ' · read-only'}{c.last_tested_at ? ` · tested ${timeAgo(c.last_tested_at)}` : ''}{c.last_error ? <span className="text-red-300"> · {c.last_error}</span> : null}{testing[c.id] ? <span className="text-zinc-400"> · {testing[c.id]}</span> : null}{c.needs_external_access && !configured.external_access ? <span className="text-amber-300"> · needs security.enable_external_access</span> : null}</>}
                  actions={<>
                    <Button size="sm" variant="ghost" onClick={() => void testDb(c)} title="Test the connection"><RefreshCw className="h-3.5 w-3.5" /> Test</Button>
                    <Button size="sm" variant="ghost" onClick={() => setWizard({ kind: 'sync', edit: null })} disabled={!wsId || !canEdit} title="Schedule a load from this database"><Clock className="h-3.5 w-3.5" /> Sync</Button>
                    <Button size="sm" variant="ghost" onClick={() => setWizard({ kind: 'database', source: sources.find((s) => s.backend.family === 'database' && s.backend.engine === c.engine) ?? null, edit: c })} title="Settings"><Pencil className="h-3.5 w-3.5" /></Button>
                    <Button size="sm" variant="ghost" className="text-red-300" onClick={async () => { if (confirm(`Remove "${c.name}"? Syncs reading from it will fail.`)) { await api.del(`/api/database-connections/${c.id}`); await load(); } }} title="Remove"><Trash2 className="h-3.5 w-3.5" /></Button>
                  </>} />
              ))}
            </Section>
          )}
          {configured.connectors.length > 0 && (
            <Section title="Warehouses & SaaS" icon={FAMILY_ICON.saas} hint="Loaded into DuckDB by syncs; browsable by agents.">
              {configured.connectors.map((c) => (
                <Row key={c.id} title={c.name} badge={<Badge>{c.connector_label}</Badge>} status={c.status} onOpen={() => { const k = connectorCatalog.find((x) => x.id === c.connector); if (k) setWizard({ kind: 'connector', source: sources.find((s) => s.backend.family === 'connector' && s.backend.connector === c.connector) ?? null, connector: k, edit: c }); }} sub={<>{c.account_label ? <><span className="text-zinc-300">{c.account_label}</span> · </> : null}{c.auth_kind === 'google' ? (c.credential_fields.includes('refresh_token') ? 'Google account' : c.credential_fields.includes('service_account_key') ? 'service account' : 'not signed in') : `${c.credential_fields.length} credential${c.credential_fields.length === 1 ? '' : 's'} on file`}{c.remote_sql ? ' · remote SQL' : ''}{c.last_tested_at ? ` · tested ${timeAgo(c.last_tested_at)}` : ''}{c.last_error ? <span className={c.status === 'error' ? 'text-red-300' : 'text-amber-300'}> · {c.last_error}</span> : null}{testing[c.id] ? <span className="text-zinc-400"> · {testing[c.id]}</span> : null}{!configured.external_access ? <span className="text-amber-300"> · needs security.enable_external_access</span> : null}</>}
                  actions={<>
                    <Button size="sm" variant="ghost" onClick={() => void testConnector(c)} title="Test the connection"><RefreshCw className="h-3.5 w-3.5" /> Test</Button>
                    <Button size="sm" variant="ghost" onClick={() => setWizard({ kind: 'sync', edit: null, connectorId: c.id })} disabled={!wsId || !canEdit} title="Schedule a load from this connection"><Clock className="h-3.5 w-3.5" /> Sync</Button>
                    <Button size="sm" variant="ghost" onClick={() => { const k = connectorCatalog.find((x) => x.id === c.connector); if (k) setWizard({ kind: 'connector', source: sources.find((s) => s.backend.family === 'connector' && s.backend.connector === c.connector) ?? null, connector: k, edit: c }); }} title="Settings"><Pencil className="h-3.5 w-3.5" /></Button>
                    <Button size="sm" variant="ghost" className="text-red-300" onClick={async () => { if (confirm(`Remove "${c.name}"? Syncs reading from it will fail.`)) { await api.del(`/api/connector-connections/${c.id}`); await load(); } }} title="Remove"><Trash2 className="h-3.5 w-3.5" /></Button>
                  </>} />
              ))}
            </Section>
          )}
          {configured.lakehouse.length > 0 && (
            <Section title="Lakehouse" icon={FAMILY_ICON.lakehouse} hint="Iceberg and Unity catalogs, attached as alias.schema.table.">
              {configured.lakehouse.map((c) => (
                <Row key={c.id} title={c.name} badge={<Badge>{c.provider.toLowerCase().replace('_', ' ')}</Badge>} status={c.status} onOpen={() => setWizard({ kind: 'lakehouse', provider: c.provider, edit: c })} sub={<><code className="font-mono">{c.alias}</code> · {c.example_sql}{c.last_tested_at ? ` · tested ${timeAgo(c.last_tested_at)}` : ''}{c.last_error ? <span className="text-red-300"> · {c.last_error}</span> : null}{testing[c.id] ? <span className="text-zinc-400"> · {testing[c.id]}</span> : null}</>}
                  actions={<>
                    <Button size="sm" variant="ghost" onClick={() => void testLake(c)}><RefreshCw className="h-3.5 w-3.5" /> Test</Button>
                    <Button size="sm" variant="ghost" onClick={() => setWizard({ kind: 'lakehouse', provider: c.provider, edit: c })} title="Settings"><Pencil className="h-3.5 w-3.5" /></Button>
                    <Button size="sm" variant="ghost" className="text-red-300" onClick={async () => { if (confirm(`Remove "${c.name}"?`)) { await api.del(`/api/lakehouse/${c.id}`); await load(); } }}><Trash2 className="h-3.5 w-3.5" /></Button>
                  </>} />
              ))}
            </Section>
          )}
          {configured.cloud.length > 0 && (
            <Section title="Storage" icon={FAMILY_ICON.storage} hint="Buckets queried by URI; also where cloud workspaces live.">
              {configured.cloud.map((c) => (
                <Row key={c.id} title={c.name} badge={<Badge>{c.provider}</Badge>} status="ok" onOpen={() => setWizard({ kind: 'cloud', provider: c.provider, edit: c })} sub={<>{c.uri_scheme}://{c.bucket ?? '<bucket>'}/… · {c.fields.join(', ')}{c.region ? ` · ${c.region}` : ''}{c.endpoint_url ? ` · ${c.endpoint_url}` : ''}</>}
                  actions={<>
                    <Button size="sm" variant="ghost" onClick={() => setWizard({ kind: 'cloud', provider: c.provider, edit: c })} title="Settings"><Pencil className="h-3.5 w-3.5" /></Button>
                    <Button size="sm" variant="ghost" className="text-red-300" onClick={async () => { if (confirm(`Remove "${c.name}"?`)) { await api.del(`/api/cloud-connections/${c.id}`); await load(); } }} title="Remove"><Trash2 className="h-3.5 w-3.5" /></Button>
                  </>} />
              ))}
            </Section>
          )}
          {configured.http.length > 0 && (
            <Section title="HTTP credentials" icon={FAMILY_ICON.web} hint="Tokens applied to https:// reads and URL syncs.">
              {configured.http.map((c) => <Row key={c.id} title={c.name} badge={<Badge>HTTP</Badge>} status="ok" sub={<>{c.fields.join(', ')}</>} actions={<Button size="sm" variant="ghost" className="text-red-300" onClick={async () => { if (confirm(`Remove "${c.name}"?`)) { await api.del(`/api/connections/${c.id}`); await load(); } }} title="Remove"><Trash2 className="h-3.5 w-3.5" /></Button>} />)}
            </Section>
          )}
        </div>
      )}

      {tab === 'catalog' && catalog && (
        <div className="space-y-5">
          <div className="relative max-w-md"><Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" /><Input autoFocus value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search sources — postgres, sheets, iceberg…" className="pl-8" /></div>
          {(Object.keys(catalog.families) as SourceFamily[]).map((fam) => {
            const items = sources.filter((s) => s.family === fam && matches(s));
            if (!items.length) return null;
            return (
              <div key={fam}>
                <div className="mb-2 flex items-baseline gap-2"><span className="text-zinc-500">{FAMILY_ICON[fam]}</span><h3 className="text-[13px] font-semibold text-zinc-100">{catalog.families[fam].label}</h3><span className="truncate text-xs text-zinc-500">{catalog.families[fam].blurb}</span></div>
                <div className="grid gap-x-6 border-t border-zinc-800 md:grid-cols-2 xl:grid-cols-3">
                  {items.map((s) => (
                    <button key={s.id} type="button" disabled={s.status === 'planned' || !canEdit} onClick={() => openWizard(s)} className={cn('group flex items-start gap-3 border-b border-zinc-800/70 px-1 py-2.5 text-left', s.status === 'planned' ? 'cursor-default opacity-50' : 'hover:bg-zinc-900')} title={s.status === 'planned' ? 'Planned — not available yet' : `Connect ${s.label}`}>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-[13px] font-medium text-zinc-100">{s.label}</span>
                          {s.status === 'planned' && <Badge>planned</Badge>}
                        </div>
                        <div className="truncate text-xs text-zinc-500">{s.blurb}</div>
                        <div className="mt-0.5 truncate text-[11px] text-zinc-600">{[s.capabilities.attach && 'attach', s.capabilities.browse && 'browse', s.capabilities.remote_sql && 'remote SQL', s.capabilities.sync && 'sync'].filter(Boolean).join(' · ')}{' · '}{s.auth === 'keys' ? 'access keys' : s.auth === 'token' ? 'token' : s.auth === 'password' ? 'password' : s.auth === 'file' ? 'file' : s.auth === 'connection_string' ? 'connection string' : s.auth === 'oauth' ? (s.backend.family === 'connector' && connectorCatalog.find((k) => k.id === (s.backend as { connector: string }).connector)?.auth.kind === 'google' ? 'Google account' : 'OAuth') : 'no auth'}</div>
                      </div>
                      {s.status !== 'planned' && <Plus className="mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-600 group-hover:text-zinc-200" />}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
          <p className="text-[11px] text-zinc-500">Missing a source? Anything that speaks Postgres wire, S3 or an Iceberg REST catalog works through those entries; warehouses and applications go through their own APIs. Ask for a connector at <a className="text-accent-300 hover:underline" href="https://github.com/contact-ajmal/DuckView/issues" target="_blank" rel="noreferrer">github.com/contact-ajmal/DuckView/issues <ExternalLink className="inline h-3 w-3" /></a>.</p>
        </div>
      )}

      {tab === 'syncs' && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-xs text-zinc-500">Scheduled loads into {ws.workspaces.find((w) => w.id === wsId)?.name ?? 'this workspace'}: a source, a target table, a schedule and an optional transformation.</p>
            <div className="ml-auto flex gap-2">
              <Button size="sm" variant="ghost" onClick={() => cp.toggle(true)} title="Ask AI to design a pipeline"><Sparkles className="h-3.5 w-3.5" /> Ask AI</Button>
              <Button size="sm" variant="primary" disabled={!wsId || !canEdit} onClick={() => setWizard({ kind: 'sync', edit: null })}><Plus className="h-3.5 w-3.5" /> New sync</Button>
            </div>
          </div>
          {syncs.length === 0 ? (
            <div className="border-y border-zinc-800 py-14"><Empty icon={<Clock />} title="No syncs yet" hint="Load a table from a database or warehouse, a SaaS object, a Google Sheet, a CSV/JSON endpoint or any SELECT into this workspace on a schedule." /></div>
          ) : (
            <div className="divide-y divide-zinc-800 border-y border-zinc-800">
              {syncs.map((s) => (
                <div key={s.id} className="px-1 py-3">
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
                  <div className="mt-1 font-mono text-[10.5px] text-zinc-500">{describeSource(s, configured?.databases ?? [], configured?.connectors ?? [])}</div>
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

      {tab === 'streams' && wsId && configured && <StreamsPanel key={wsId} workspaceId={wsId} clouds={configured.cloud} databases={configured.databases} />}
      {tab === 'reverse' && wsId && configured && <ReversePanel key={wsId} workspaceId={wsId} databases={configured.databases} clouds={configured.cloud} />}

      <CloudWizard open={wizard?.kind === 'cloud'} initialProvider={wizard?.kind === 'cloud' ? wizard.provider : null} initial={wizard?.kind === 'cloud' ? wizard.edit : null} onClose={closeWizard} onCreated={markSaved} />
      <HttpWizard open={wizard?.kind === 'http'} onClose={closeWizard} onSaved={markSaved} />
      <LakehouseWizard open={wizard?.kind === 'lakehouse'} initialProvider={wizard?.kind === 'lakehouse' ? wizard.provider : null} initial={wizard?.kind === 'lakehouse' ? wizard.edit : null} onClose={closeWizard} onCreated={markSaved} />
      <DatabaseWizard open={wizard?.kind === 'database'} source={wizard?.kind === 'database' ? wizard.source : null} initial={wizard?.kind === 'database' ? wizard.edit : null} onClose={closeWizard} onSaved={markSaved} />
      <ConnectorWizard open={wizard?.kind === 'connector'} source={wizard?.kind === 'connector' ? wizard.source : null} connector={wizard?.kind === 'connector' ? wizard.connector : null} initial={wizard?.kind === 'connector' ? wizard.edit : null} googleConfigured={!!configured?.google_configured} isAdmin={!!isAdmin} onClose={closeWizard} onSaved={markSaved} onGoogleConfigured={() => void load()} />
      {wsId && <SyncEditor open={wizard?.kind === 'sync'} workspaceId={wsId} initial={wizard?.kind === 'sync' ? wizard.edit : null} initialConnectorId={wizard?.kind === 'sync' ? wizard.connectorId : undefined} initialResource={wizard?.kind === 'sync' ? wizard.resource : undefined} initialName={wizard?.kind === 'sync' ? wizard.name : undefined} initialKind={wizard?.kind === 'sync' ? wizard.sourceKind : undefined} databases={configured?.databases ?? []} lakehouses={configured?.lakehouse ?? []} connectors={configured?.connectors ?? []} onClose={() => setWizard(null)} onSaved={() => { void load(); go('syncs'); }} />}
    </div>
    </div>
  );
}

function describeSource(s: DataSync, databases: DatabaseConnection[], connectors: ConnectorConnection[]): string {
  const src = s.source;
  if (src.kind === 'table') return `${src.catalog ?? databases.find((d) => d.id === src.database_connection_id)?.alias ?? 'db'}.${src.schema}.${src.table}`;
  if (src.kind === 'url') return src.url;
  if (src.kind === 'connector') { const c = connectors.find((x) => x.id === src.connection_id); return `${c ? `${c.connector_label} · ${c.name}` : 'connector'} → ${describeResource(src.resource)}`; }
  return src.sql.slice(0, 140);
}
/** One line for a connector resource — mirrors the server's describeResource without needing the connector. */
export function describeResource(r: Record<string, unknown>): string {
  if (typeof r.sql === 'string') return `SQL: ${r.sql.slice(0, 80)}`;
  const parts = [r.database, r.dataset, r.schema, r.table_name ?? r.table, r.object, r.resource, r.name, r.spreadsheet, r.sheet, r.item, r.database_id].filter((v) => typeof v === 'string' && v) as string[];
  if (Array.isArray(r.dimensions)) return `${(r.dimensions as string[]).join(', ')} × ${((r.metrics as string[]) ?? []).join(', ')}`;
  return parts.join(' · ') || JSON.stringify(r).slice(0, 80);
}

const ROW_GRID = 'grid grid-cols-[minmax(0,1.1fr)_120px_96px_minmax(0,2fr)_auto] items-center gap-4';
function Section({ title, icon, hint, children }: { title: string; icon: ReactNode; hint: string; children: ReactNode }) {
  return (
    <section>
      <header className="mb-1 flex items-baseline gap-2"><span className="self-center text-zinc-500">{icon}</span><h3 className="text-[13px] font-semibold text-zinc-100">{title}</h3><span className="truncate text-xs text-zinc-500">{hint}</span></header>
      <div className={cn(ROW_GRID, 'border-b border-zinc-800 px-1 py-1.5 text-xs text-zinc-500')}><span>Name</span><span>Type</span><span>Status</span><span>Details</span><span className="sr-only">Actions</span></div>
      <div className="divide-y divide-zinc-800/70 border-b border-zinc-800">{children}</div>
    </section>
  );
}
function Row({ title, badge, status, sub, actions, onOpen }: { title: string; badge: ReactNode; status: 'ok' | 'error' | 'unknown'; sub: ReactNode; actions: ReactNode; onOpen?: () => void }) {
  return (
    <div className={cn(ROW_GRID, 'group px-1 py-2', onOpen && 'cursor-pointer hover:bg-zinc-900')} onClick={onOpen} title={onOpen ? 'Open settings' : undefined}>
      <span className="truncate text-[13px] font-medium text-zinc-100">{title}</span>
      <span className="min-w-0 truncate text-xs text-zinc-400 [&>span]:bg-transparent [&>span]:p-0 [&>span]:text-xs [&>span]:font-normal [&>span]:text-zinc-400">{badge}</span>
      <span className="text-xs text-zinc-400"><span className="inline-flex items-center gap-1.5"><StatusDot status={status} />{status === 'ok' ? 'connected' : status === 'error' ? 'failing' : 'untested'}</span></span>
      <span className="min-w-0 truncate text-xs text-zinc-500">{sub}</span>
      <div className="flex items-center gap-0.5" onClick={(e) => e.stopPropagation()}>{actions}</div>
    </div>
  );
}
function StatusDot({ status }: { status: string }) {
  if (status === 'running') return <RefreshCw className="h-3 w-3 shrink-0 animate-spin text-sky-500" />;
  return <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', status === 'ok' ? 'bg-emerald-500' : status === 'error' ? 'bg-red-500' : 'bg-zinc-600')} title={status === 'ok' ? 'ok' : status === 'error' ? 'failing' : 'not tested yet'} />;
}
