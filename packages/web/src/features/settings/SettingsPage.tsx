import { useEffect, useState } from 'react';
import { Users, Trash2, Plug, KeyRound, Activity } from 'lucide-react';
import { api, formatBytes, timeAgo, type LiveStats, type SystemInfo, type User, type PublicConnection, type Workspace, type EngineSettings } from '../../api/client';
import { Gauge } from '../../components/Gauge';
import { Eyebrow, PageTitle, SideCard, Panel, KvRows, Tag } from '../../components/layout';
import { Button, Badge, Card, Input, Label, Modal, Select } from '../../components/ui';
import { useAuth } from '../../store/auth';
import { CloudWizard } from '../explorer/CloudWizard';
import type { CloudConnection } from '../../api/client';
import { Cloud } from 'lucide-react';
import { useWorkspace } from '../../store/workspace';

function EngineSettingsForm({ workspace, sys, live, connections, onSaved }: { workspace: Workspace; sys: SystemInfo | null; live: LiveStats | null; connections: PublicConnection[]; onSaved: () => void }) {
  const ws = useWorkspace();
  const s = workspace.engine_settings;
  const [name, setName] = useState(workspace.name);
  const [dbPath, setDbPath] = useState(workspace.active_db_path);
  const initialMem = s.memory_limit ?? sys?.duckdb.memory_limit ?? '80%';
  const [memMode, setMemMode] = useState<'percent' | 'absolute'>(initialMem.endsWith('%') ? 'percent' : 'absolute');
  const [memPct, setMemPct] = useState(initialMem.endsWith('%') ? Number(initialMem.slice(0, -1)) : 80);
  const [memAbs, setMemAbs] = useState(initialMem.endsWith('%') ? '8GB' : initialMem);
  const [threads, setThreads] = useState<number | 'auto'>(s.threads ?? 'auto');
  const [timeout, setTimeoutS] = useState(s.query_timeout_seconds ?? 60);
  const [extensions, setExtensions] = useState((s.extensions ?? []).join(', '));
  const [connectionIds, setConnectionIds] = useState<string[]>(s.connection_ids ?? []);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const cpus = sys?.host.cpus ?? 8;
  const total = sys?.host.total_memory_bytes ?? 0;

  useEffect(() => {
    setName(workspace.name);
    setDbPath(workspace.active_db_path);
  }, [workspace.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    // Once the server default arrives, reflect it for workspaces without an override.
    if (s.memory_limit || !sys) return;
    const m = sys.duckdb.memory_limit;
    if (m.endsWith('%')) {
      setMemMode('percent');
      setMemPct(Number(m.slice(0, -1)));
    } else {
      setMemMode('absolute');
      setMemAbs(m);
    }
  }, [sys?.duckdb.memory_limit]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      const engine_settings: EngineSettings = { memory_limit: memMode === 'percent' ? `${memPct}%` : memAbs, threads, query_timeout_seconds: timeout, extensions: extensions.split(',').map((x) => x.trim()).filter(Boolean), connection_ids: connectionIds };
      await ws.updateWorkspace(workspace.id, { name, active_db_path: dbPath, engine_settings });
      setMsg({ ok: true, text: 'Saved. The engine restarts with the new limits on the next query.' });
      onSaved();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setSaving(false);
    }
  };

  const defaultLimit = sys?.duckdb.memory_limit ?? '80%';
  const pctOf = (spec: string) => (spec.endsWith('%') ? Number(spec.slice(0, -1)) : total ? Math.round((parseBytes(spec) / total) * 100) : 80);
  const presets: { label: string; pct: number }[] = [
    { label: 'Conservative', pct: 25 },
    { label: 'Auto', pct: pctOf(defaultLimit) },
    { label: 'Maximum', pct: 90 },
  ];
  const limitBytes = memMode === 'percent' ? (total * memPct) / 100 : parseBytes(memAbs);
  const inUse = live?.duckdb.engines.find((e) => e.workspaceId === workspace.id)?.memory_usage_bytes ?? 0;

  return (
    <div className="space-y-4">
      <Panel title="Engine memory" meta={`${memMode === 'percent' ? `${memPct}%` : memAbs} · ${formatBytes(limitBytes)}`}>
        <div className="flex items-center justify-between">
          <div className="text-sm text-zinc-100">
            DuckDB memory limit <Tag>memory_limit</Tag>
          </div>
          <div className="font-mono text-2xl font-semibold text-zinc-50">{formatBytes(limitBytes)}</div>
        </div>
        <input type="range" min={5} max={95} step={5} value={memMode === 'percent' ? memPct : Math.min(95, Math.max(5, Math.round((limitBytes / (total || 1)) * 100)))} onChange={(e) => { setMemMode('percent'); setMemPct(Number(e.target.value)); }} className="mt-3 w-full accent-accent-500" />
        <div className="mt-1 flex justify-between font-mono text-[10px] text-zinc-500">
          <span>5%</span>
          <span>{total ? `safe up to ${formatBytes(total * 0.8)} · above 90% starves the OS page cache` : ''}</span>
          <span>{total ? formatBytes(total) : '100%'}</span>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {presets.map((p) => {
            const active = memMode === 'percent' && memPct === p.pct;
            return (
              <button key={p.label} onClick={() => { setMemMode('percent'); setMemPct(p.pct); }} className={`rounded-md border px-3 py-1.5 text-xs ${active ? 'border-accent-500 bg-accent-600/20 text-accent-100' : 'border-zinc-700 text-zinc-300 hover:bg-zinc-800'}`}>
                {p.label} <span className="font-mono text-[10px] text-zinc-500">{total ? formatBytes((total * p.pct) / 100) : `${p.pct}%`}</span>
              </button>
            );
          })}
          <div className="ml-auto flex items-center gap-2">
            <span className="font-mono text-[10px] text-zinc-500">or absolute</span>
            <Input value={memAbs} onChange={(e) => { setMemMode('absolute'); setMemAbs(e.target.value); }} className="h-7 w-24 font-mono text-xs" placeholder="8GB" />
          </div>
        </div>
        <div className="mt-4 font-mono text-[11px] text-zinc-500">in use now {formatBytes(inUse)}</div>
        <div className="mt-1 h-1 w-full overflow-hidden rounded bg-zinc-800">
          <div className="h-full bg-accent-500" style={{ width: `${limitBytes ? Math.min(100, (inUse / limitBytes) * 100) : 0}%` }} />
        </div>
        <p className="mt-3 text-[11px] leading-relaxed text-zinc-500">The limit is the most this workspace's engine holds in RAM before it spills to the scratch directory or fails a query with out-of-memory. Larger lets big aggregations and sorts finish in one pass; smaller leaves room for other workspaces on the same host. Changes restart the engine on the next query.</p>
      </Panel>

      <Panel title="Compute">
        <div className="grid gap-6 md:grid-cols-2">
          <div>
            <div className="flex items-center justify-between">
              <div className="text-sm text-zinc-100">
                DuckDB threads <Tag>threads</Tag>
              </div>
              <div className="font-mono text-2xl font-semibold text-zinc-50">{threads === 'auto' ? cpus : threads}</div>
            </div>
            <input type="range" min={0} max={cpus} step={1} value={threads === 'auto' ? 0 : threads} onChange={(e) => setThreads(Number(e.target.value) === 0 ? 'auto' : Number(e.target.value))} className="mt-3 w-full accent-accent-500" />
            <div className="mt-1 flex justify-between font-mono text-[10px] text-zinc-500">
              <span>auto</span>
              <span>{cpus} cores detected</span>
            </div>
            <p className="mt-2 text-[11px] text-zinc-500">{threads === 'auto' ? `Auto uses every logical core (${cpus}). Lower it to keep headroom for other workspaces or the web UI.` : `Fixed at ${threads}. Tabs still run concurrently — each query gets its own connection.`}</p>
          </div>
          <div className="space-y-4">
            <div>
              <div className="text-sm text-zinc-100">
                Query timeout <Tag>seconds</Tag>
              </div>
              <Input type="number" min={1} max={86400} value={timeout} onChange={(e) => setTimeoutS(Number(e.target.value))} className="mt-2 w-40 font-mono" />
              <p className="mt-1 text-[11px] text-zinc-500">Queries past this are interrupted server-side; the tab shows QUERY_TIMEOUT.</p>
            </div>
            <div>
              <div className="text-sm text-zinc-100">
                Extensions to preload <Tag>LOAD</Tag>
              </div>
              <Input value={extensions} onChange={(e) => setExtensions(e.target.value)} className="mt-2 font-mono" placeholder="httpfs, iceberg, delta" />
              <p className="mt-1 text-[11px] text-zinc-500">Only allow-listed extensions load before the configuration is locked.</p>
            </div>
          </div>
        </div>
      </Panel>

      <Panel title="Workspace">
        <div className="grid gap-4 md:grid-cols-3">
          <div>
            <Label>Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <Label>Database</Label>
            <Input value={dbPath} onChange={(e) => setDbPath(e.target.value)} className="font-mono" placeholder=":memory: | warehouse.duckdb | md:my_db" />
          </div>
          <div>
            <Label>Connections applied at engine start</Label>
            {connections.length === 0 ? (
              <p className="text-xs text-zinc-500">None yet — add one below.</p>
            ) : (
              <Select multiple value={connectionIds} onChange={(e) => setConnectionIds([...e.target.selectedOptions].map((o) => o.value))} className="h-auto w-full">
                {connections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.type})
                  </option>
                ))}
              </Select>
            )}
          </div>
        </div>
        {msg && <div className={`mt-4 rounded-md border px-3 py-2 text-xs ${msg.ok ? 'border-emerald-900 bg-emerald-950/40 text-emerald-200' : 'border-red-900 bg-red-950/50 text-red-200'}`}>{msg.text}</div>}
        <div className="mt-4 flex items-center justify-between">
          <Button
            variant="danger"
            size="sm"
            onClick={async () => {
              if (confirm(`Delete workspace "${workspace.name}" and all its tabs?`)) await ws.deleteWorkspace(workspace.id);
            }}
          >
            Delete workspace
          </Button>
          <Button variant="primary" onClick={save} loading={saving}>
            Save & restart engine
          </Button>
        </div>
      </Panel>
    </div>
  );
}

function parseBytes(spec: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB|KIB|MIB|GIB|TIB)?$/i.exec(spec.trim());
  if (!m) return 0;
  const mult: Record<string, number> = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12, KIB: 1024, MIB: 1024 ** 2, GIB: 1024 ** 3, TIB: 1024 ** 4 };
  return Number(m[1]) * (mult[(m[2] ?? 'B').toUpperCase()] ?? 1);
}

export function SettingsPage() {
  const auth = useAuth();
  const ws = useWorkspace();
  const isAdmin = auth.user?.role === 'ADMIN';
  const workspace = ws.workspaces.find((w) => w.id === ws.activeId) ?? null;
  const [live, setLive] = useState<LiveStats | null>(null);
  const [sys, setSys] = useState<SystemInfo | null>(null);
  const [connections, setConnections] = useState<PublicConnection[]>([]);
  const [cloud, setCloud] = useState<CloudConnection[]>([]);
  const [wizard, setWizard] = useState(false);
  const [testing, setTesting] = useState<Record<string, string>>({});
  const [connTypes, setConnTypes] = useState<Record<string, { required: string[]; optional: string[] }>>({});
  const [externalAccess, setExternalAccess] = useState(false);
  const [users, setUsers] = useState<User[]>([]);
  const [newUser, setNewUser] = useState<{ open: boolean; email: string; password: string; role: User['role'] }>({ open: false, email: '', password: '', role: 'USER' });
  const [newConn, setNewConn] = useState<{ open: boolean; name: string; type: string; creds: Record<string, string> }>({ open: false, name: '', type: 'S3', creds: {} });
  const [pw, setPw] = useState({ current: '', next: '', msg: '' });

  const refresh = async () => {
    const [c, ct] = await Promise.all([api.get<{ connections: PublicConnection[] }>('/api/connections'), api.get<{ types: Record<string, { required: string[]; optional: string[] }>; external_access_enabled: boolean }>('/api/connections/types')]);
    setConnections(c.connections);
    setCloud((await api.get<{ connections: CloudConnection[] }>('/api/cloud-connections')).connections);
    setConnTypes(ct.types);
    setExternalAccess(ct.external_access_enabled);
    if (isAdmin) setUsers((await api.get<{ users: User[] }>('/api/admin/users')).users);
  };

  useEffect(() => {
    api.get<SystemInfo>('/api/system').then(setSys).catch(() => undefined);
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

  return (
    <div className="flex h-full min-h-0 gap-5 overflow-auto p-5">
      <aside className="flex w-[270px] shrink-0 flex-col gap-4">
        <SideCard title="Live resources" meta={<span className={`h-1.5 w-1.5 rounded-full ${live ? 'bg-emerald-400' : 'bg-zinc-600'}`} />}>
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
      </aside>

      <main className="min-w-0 flex-1 space-y-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <Eyebrow>Settings</Eyebrow>
            <PageTitle>Resources & behaviour</PageTitle>
            <p className="mt-1 text-xs text-zinc-500">Engine settings apply to the selected workspace and are re-applied on every engine start. Gauges refresh every 2 s.</p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
          <Gauge value={hostMemPct} label="Host RAM" primary={live ? `${formatBytes(live.host.memory_used_bytes)} used` : '—'} secondary={live ? `of ${formatBytes(live.host.memory_total_bytes)} · OS-reported (includes cache)` : undefined} />
          <Gauge value={duckPct} label="DuckDB memory" primary={live ? `${formatBytes(live.duckdb.memory_usage_bytes)} allocated` : '—'} secondary={live ? `ceiling ${formatBytes(live.duckdb.memory_limit_bytes)} · ${live.duckdb.engines.length} engine${live.duckdb.engines.length === 1 ? '' : 's'}` : undefined} tone="accent" />
          <Gauge value={live?.host.cpu_percent ?? 0} label="CPU load" primary={live ? `${live.host.cpus} cores · load ${live.host.load_average[0]?.toFixed(2)}` : '—'} secondary={live ? `duckview process ${live.process.cpu_percent.toFixed(1)}%` : undefined} />
          <Gauge value={scratchPct} label="Scratch storage" primary={live ? `${formatBytes(live.scratch.used_bytes)} spilled` : '—'} secondary={live ? `${formatBytes(live.scratch.free_bytes)} free on ${live.scratch.path.split('/').slice(-1)[0]}` : undefined} />
        </div>

        <Panel bodyClassName="p-0">
          <div className="grid gap-px bg-zinc-800 md:grid-cols-3">
            <div className="bg-zinc-900/60 p-4">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">This machine</div>
              <div className="mt-1 text-lg font-semibold text-zinc-50">{sys ? `${formatBytes(sys.host.total_memory_bytes)} RAM · ${sys.host.cpus} cores` : '…'}</div>
              <p className="mt-1 text-[11px] text-zinc-500">Native DuckDB addresses all host memory and cores; per-workspace limits keep tenants from starving each other.</p>
            </div>
            <div className="bg-zinc-900/60 p-4">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Engine ceiling</div>
              <div className="mt-1 text-lg font-semibold text-zinc-50">{live ? `${formatBytes(live.duckdb.memory_limit_bytes)} · ${live.duckdb.threads} threads` : '…'}</div>
              <p className="mt-1 text-[11px] text-zinc-500">The largest working set one query can hold before spilling to <span className="font-mono">{sys?.duckdb.temp_directory ?? 'scratch'}</span>.</p>
            </div>
            <div className="bg-zinc-900/60 p-4">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Bigger than RAM?</div>
              <p className="mt-1 text-[11px] leading-relaxed text-zinc-400">Parquet is read column-by-column with predicate push-down, so files far larger than RAM still query fine — the limit is the <em>working set</em> of one query, not the file. Filter early, aggregate, avoid <Tag>SELECT *</Tag>.</p>
            </div>
          </div>
        </Panel>

        {live && live.duckdb.engines.length > 0 && (
          <Panel title="Warm engines" meta={`${live.duckdb.engines.length} cached`} bodyClassName="p-0">
            <table className="w-full font-mono text-xs">
              <thead className="text-left text-[10px] uppercase tracking-wide text-zinc-500">
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
                    <td className="px-2 py-2">
                      <Activity className={`h-3.5 w-3.5 ${e.active_queries ? 'text-emerald-400' : 'text-zinc-600'}`} />
                    </td>
                    {isAdmin && (
                      <td className="px-2 py-2 text-right">
                        <Button size="sm" variant="ghost" onClick={() => api.post(`/api/admin/engines/${e.workspaceId}/evict`)}>
                          Evict
                        </Button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        )}

        {workspace && <EngineSettingsForm key={workspace.id} workspace={workspace} sys={sys} live={live} connections={connections} onSaved={() => void ws.loadCatalog(true)} />}

        <div className="grid gap-5 lg:grid-cols-2">
          <Card
            title="Cloud storage"
            className="lg:col-span-2"
            actions={
              <Button size="sm" onClick={() => setWizard(true)}>
                <Cloud className="h-3.5 w-3.5" /> Connect
              </Button>
            }
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
            actions={
              <Button size="sm" onClick={() => setNewConn({ open: true, name: '', type: 'S3', creds: {} })}>
                <Plug className="h-3.5 w-3.5" /> Add
              </Button>
            }
          >
            {!externalAccess && <div className="mb-3 rounded-md border border-amber-900 bg-amber-950/40 px-3 py-2 text-[11px] text-amber-200">External access is disabled (security.enable_external_access=false). Credentials are stored encrypted but remote sources stay unreachable until it is enabled.</div>}
            {connections.length === 0 ? (
              <p className="text-xs text-zinc-500">Credentials are AES-256-GCM encrypted at rest and never returned by the API.</p>
            ) : (
              <div className="space-y-2">
                {connections.map((c) => (
                  <div key={c.id} className="flex items-center gap-3 rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs">
                    <Badge tone="violet">{c.type}</Badge>
                    <div className="min-w-0 flex-1">
                      <div className="text-zinc-200">{c.name}</div>
                      <div className="font-mono text-[10px] text-zinc-500">{c.fields.join(', ')}</div>
                    </div>
                    <button
                      className="rounded p-1 text-zinc-500 hover:bg-red-950 hover:text-red-300"
                      onClick={async () => {
                        if (confirm(`Delete connection "${c.name}"?`)) {
                          await api.del(`/api/connections/${c.id}`);
                          await refresh();
                        }
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card title="Account">
            <div className="mb-3 text-xs text-zinc-400">
              Signed in as <span className="text-zinc-200">{auth.user?.email}</span> · role <Badge tone="violet">{auth.user?.role}</Badge> · provider {auth.user?.auth_provider}
            </div>
            {auth.user?.auth_provider === 'local' && (
              <form
                className="space-y-2"
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
                  <Button size="sm" type="submit">
                    <KeyRound className="h-3.5 w-3.5" /> Update
                  </Button>
                </div>
              </form>
            )}
          </Card>

          {isAdmin && (
            <Card
              title="Users"
              className="lg:col-span-2"
              actions={
                <Button size="sm" onClick={() => setNewUser({ open: true, email: '', password: '', role: 'USER' })}>
                  <Users className="h-3.5 w-3.5" /> Add
                </Button>
              }
            >
              <table className="w-full text-xs">
                <thead className="text-left text-[10px] uppercase tracking-wide text-zinc-500">
                  <tr>
                    <th className="pb-2">User</th>
                    <th className="pb-2">Provider</th>
                    <th className="pb-2">Created</th>
                    <th className="pb-2">Role</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u.id} className="border-t border-zinc-800">
                      <td className="py-2">
                        <div className="text-zinc-200">{u.display_name ?? u.email}</div>
                        <div className="text-[10px] text-zinc-500">{u.email}</div>
                      </td>
                      <td className="py-2 text-zinc-400">{u.auth_provider}</td>
                      <td className="py-2 text-zinc-400">{timeAgo(u.created_at)}</td>
                      <td className="py-2">
                        <Select
                          value={u.role}
                          disabled={u.id === auth.user?.id}
                          className="h-7 text-xs"
                          onChange={async (e) => {
                            await api.patch(`/api/admin/users/${u.id}`, { role: e.target.value });
                            await refresh();
                          }}
                        >
                          {['ADMIN', 'USER', 'READ_ONLY'].map((r) => (
                            <option key={r} value={r}>
                              {r}
                            </option>
                          ))}
                        </Select>
                      </td>
                      <td className="py-2 text-right">
                        {u.id !== auth.user?.id && (
                          <button
                            className="rounded p-1 text-zinc-500 hover:bg-red-950 hover:text-red-300"
                            onClick={async () => {
                              if (confirm(`Delete ${u.email}? Their workspaces and tokens are removed.`)) {
                                await api.del(`/api/admin/users/${u.id}`);
                                await refresh();
                              }
                            }}
                          >
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
    </div>
  );
}
