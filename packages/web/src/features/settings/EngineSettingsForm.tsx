import { useEffect, useState } from 'react';
import { HardDrive, Zap, CheckCircle2 } from 'lucide-react';
import { api, formatBytes, type LiveStats, type SystemInfo, type PublicConnection, type Workspace, type EngineSettings } from '../../api/client';
import { Panel, Tag } from '../../components/layout';
import { Button, Input, Label, Select } from '../../components/ui';
import { useWorkspace } from '../../store/workspace';

export function EngineSettingsForm({ workspace, sys, live, connections, onSaved }: { workspace: Workspace; sys: SystemInfo | null; live: LiveStats | null; connections: PublicConnection[]; onSaved: () => void }) {
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
  const [persistPath, setPersistPath] = useState('');
  const [persisting, setPersisting] = useState(false);
  const [persisted, setPersisted] = useState<{ path: string; tables: number; views: number; copied: boolean } | null>(null);
  const inMemory = workspace.active_db_path === ':memory:';
  useEffect(() => {
    if (!inMemory) return;
    api.get<{ path: string }>(`/api/workspaces/suggest-db-path?name=${encodeURIComponent(workspace.name)}`).then((r) => setPersistPath(r.path)).catch(() => undefined);
  }, [workspace.id, workspace.name, inMemory]);
  const makePersistent = async () => {
    if (!confirm(`Store this workspace in ${persistPath || 'a .duckdb file'}? Every table, view and macro is copied into the file, then the engine restarts on it. Members keep working; open queries finish first.`)) return;
    setPersisting(true);
    setMsg(null);
    try {
      const r = await api.post<{ path: string; tables: number; views: number; copied: boolean }>(`/api/workspaces/${workspace.id}/persist`, { path: persistPath || undefined });
      setPersisted(r);
      await ws.loadWorkspaces();
      onSaved();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setPersisting(false);
    }
  };
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

      <Panel title="Storage" meta={inMemory ? 'in-memory scratch' : workspace.active_db_path}>
        {persisted ? (
          <div className="flex items-start gap-2 rounded-lg border border-emerald-900/60 bg-emerald-950/30 px-3 py-2 text-xs text-emerald-200">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
            <span>Now stored in <code className="font-mono">{persisted.path}</code>{persisted.copied ? ` — ${persisted.tables} table${persisted.tables === 1 ? '' : 's'} and ${persisted.views} view${persisted.views === 1 ? '' : 's'} carried over.` : '.'} Tables, views and macros survive restarts from here on.</span>
          </div>
        ) : inMemory ? (
          <div className="space-y-3">
            <div className="flex items-start gap-2 text-sm text-zinc-200">
              <Zap className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
              <span>This workspace is an <b>in-memory scratch database</b>: every table is lost when the engine restarts (idle eviction, settings changes, server restarts). Make it persistent to keep the analysts' work in a DuckDB file.</span>
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-[240px] flex-1">
                <Label>File name (inside the data directory)</Label>
                <Input value={persistPath} onChange={(e) => setPersistPath(e.target.value)} className="font-mono" placeholder="workspace.duckdb" />
              </div>
              <Button variant="primary" onClick={() => void makePersistent()} loading={persisting} disabled={workspace.role !== 'OWNER'}><HardDrive className="h-4 w-4" /> Make persistent</Button>
            </div>
            <p className="text-[11px] text-zinc-500">Copies every schema, table, view, sequence and macro into the file while the engine is running, then restarts the engine on it. Owners only.</p>
          </div>
        ) : (
          <div className="flex items-start gap-2 text-sm text-zinc-200">
            <HardDrive className="mt-0.5 h-4 w-4 shrink-0 text-emerald-300" />
            <span>Stored in <code className="font-mono">{workspace.active_db_path}</code> inside the data directory — tables, views and macros survive restarts. Back up the data directory to back up the workspace.</span>
          </div>
        )}
      </Panel>

      <Panel title="Workspace">
        <div className="grid gap-4 md:grid-cols-3">
          <div>
            <Label>Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <Label>Database <span className="normal-case text-zinc-600">(advanced — switching files does not move tables)</span></Label>
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

export function parseBytes(spec: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB|KIB|MIB|GIB|TIB)?$/i.exec(spec.trim());
  if (!m) return 0;
  const mult: Record<string, number> = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12, KIB: 1024, MIB: 1024 ** 2, GIB: 1024 ** 3, TIB: 1024 ** 4 };
  return Number(m[1]) * (mult[(m[2] ?? 'B').toUpperCase()] ?? 1);
}

