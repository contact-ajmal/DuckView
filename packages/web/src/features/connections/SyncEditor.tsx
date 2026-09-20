import { useEffect, useMemo, useState } from 'react';
import { Play, Save, Loader2, Eye, Wand2, ChevronRight, Folder, FileText, Table2 } from 'lucide-react';
import { api, copilotChat, type DataSync, type DatabaseConnection, type DatabaseEntry, type LakehouseConnection, type SyncSource, type SyncSchedule, type ConnectorConnection, type BrowseEntry } from '../../api/client';
import { describeResource } from './ConnectionsPage';
import { useCopilot } from '../../store/copilot';
import { Button, Input, Label, Modal, Select, cn } from '../../components/ui';

type SourceKind = 'table' | 'connector' | 'url' | 'sheet' | 'sql';

/** Create or edit a scheduled sync: source → target, schedule, transformation (with a Copilot drafter), preview. */
export function SyncEditor({ open, workspaceId, initial, initialConnectorId, initialResource, initialName, initialKind, databases, lakehouses, connectors, onClose, onSaved }: { open: boolean; workspaceId: string; initial?: DataSync | null; initialConnectorId?: string; initialResource?: Record<string, unknown>; initialName?: string; initialKind?: SourceKind; databases: DatabaseConnection[]; lakehouses: LakehouseConnection[]; connectors: ConnectorConnection[]; onClose: () => void; onSaved: (s: DataSync, ran?: boolean) => void }) {
  const cp = useCopilot();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<SourceKind>('table');
  // Connector sources: a connection, a browse path, the picked leaf (or SQL for warehouses).
  const [connId, setConnId] = useState('');
  const [connPath, setConnPath] = useState<string[]>([]);
  const [connEntries, setConnEntries] = useState<BrowseEntry[] | null>(null);
  const [connBusy, setConnBusy] = useState(false);
  const [resource, setResource] = useState<Record<string, unknown> | null>(null);
  const [remoteSql, setRemoteSql] = useState('');
  const [connMode, setConnMode] = useState<'browse' | 'sql'>('browse');
  const [dbId, setDbId] = useState('');
  const [catalog, setCatalog] = useState('');
  const [schema, setSchema] = useState('');
  const [table, setTable] = useState('');
  const [schemas, setSchemas] = useState<DatabaseEntry[]>([]);
  const [tables, setTables] = useState<DatabaseEntry[]>([]);
  const [url, setUrl] = useState('');
  const [format, setFormat] = useState<'auto' | 'csv' | 'json' | 'parquet' | 'excel'>('auto');
  const [sheetId, setSheetId] = useState('');
  const [gid, setGid] = useState('');
  const [sql, setSql] = useState('');
  const [target, setTarget] = useState('');
  const [targetSchema, setTargetSchema] = useState('main');
  const [mode, setMode] = useState<'replace' | 'append'>('replace');
  const [schedKind, setSchedKind] = useState<SyncSchedule['kind']>('interval');
  const [minutes, setMinutes] = useState(60);
  const [cron, setCron] = useState('0 6 * * *');
  const [transform, setTransform] = useState('');
  const [preview, setPreview] = useState<{ columns: { name: string; type: string }[]; rows: unknown[][]; sql: string } | null>(null);
  const [busy, setBusy] = useState<'preview' | 'save' | 'run' | 'draft' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setPreview(null);
    if (initial) {
      setName(initial.name);
      setTarget(initial.target_table);
      setTargetSchema(initial.target_schema);
      setMode(initial.mode);
      setTransform(initial.transform_sql ?? '');
      setSchedKind(initial.schedule.kind);
      if (initial.schedule.kind === 'interval') setMinutes(initial.schedule.minutes);
      if (initial.schedule.kind === 'cron') setCron(initial.schedule.expression);
      const s = initial.source;
      if (s.kind === 'table') { setKind('table'); setDbId(s.database_connection_id ?? ''); setCatalog(s.catalog ?? ''); setSchema(s.schema); setTable(s.table); }
      else if (s.kind === 'connector') { setKind('connector'); setConnId(s.connection_id); setConnPath([]); if (typeof s.resource.sql === 'string') { setConnMode('sql'); setRemoteSql(s.resource.sql); setResource(null); } else { setConnMode('browse'); setResource(s.resource); setRemoteSql(''); } }
      else if (s.kind === 'url') { const m = /docs\.google\.com\/spreadsheets\/d\/([^/]+)\/export\?format=csv(?:&gid=([^&]+))?/.exec(s.url); if (m) { setKind('sheet'); setSheetId(decodeURIComponent(m[1]!)); setGid(m[2] ? decodeURIComponent(m[2]) : ''); } else { setKind('url'); setUrl(s.url); setFormat(s.format); } }
      else { setKind('sql'); setSql(s.sql); }
    } else {
      setName(initialName ?? ''); setKind(initialKind ?? (initialConnectorId ? 'connector' : databases.length || lakehouses.length ? 'table' : connectors.length ? 'connector' : 'url')); setConnId(initialConnectorId ?? connectors[0]?.id ?? ''); setConnPath([]); setResource(initialResource ?? null); setRemoteSql(typeof initialResource?.sql === 'string' ? initialResource.sql : ''); setConnMode(typeof initialResource?.sql === 'string' ? 'sql' : 'browse'); setDbId(databases[0]?.id ?? ''); setCatalog(lakehouses[0]?.alias ?? ''); setSchema(''); setTable(''); setUrl(''); setFormat('auto'); setSheetId(''); setGid(''); setSql(''); setTarget(''); setTargetSchema('main'); setMode('replace'); setSchedKind('interval'); setMinutes(60); setCron('0 6 * * *'); setTransform('');
    }
  }, [open, initial]); // eslint-disable-line react-hooks/exhaustive-deps

  // Browse the chosen connector connection one level at a time.
  useEffect(() => {
    if (!open || kind !== 'connector' || !connId || connMode !== 'browse') return setConnEntries(null);
    setConnBusy(true);
    api.get<{ entries: BrowseEntry[] }>(`/api/connector-connections/${connId}/browse${connPath.length ? `?path=${connPath.map(encodeURIComponent).join('/')}` : ''}`).then((r) => setConnEntries(r.entries)).catch((e) => { setConnEntries([]); setError((e as Error).message); }).finally(() => setConnBusy(false));
  }, [open, kind, connId, connPath, connMode]);
  const conn = connectors.find((c) => c.id === connId) ?? null;

  // Browse the chosen database connection.
  useEffect(() => {
    if (!open || kind !== 'table' || !dbId) return setSchemas([]);
    api.get<{ entries: DatabaseEntry[] }>(`/api/database-connections/${dbId}/browse`).then((r) => setSchemas(r.entries)).catch(() => setSchemas([]));
  }, [open, kind, dbId]);
  useEffect(() => {
    if (!open || kind !== 'table' || !dbId || !schema) return setTables([]);
    api.get<{ entries: DatabaseEntry[] }>(`/api/database-connections/${dbId}/browse?schema=${encodeURIComponent(schema)}`).then((r) => setTables(r.entries)).catch(() => setTables([]));
  }, [open, kind, dbId, schema]);

  const source = useMemo<SyncSource | null>(() => {
    if (kind === 'table') return schema && table ? { kind: 'table', database_connection_id: dbId || null, catalog: dbId ? null : catalog || null, schema, table } : null;
    if (kind === 'connector') { if (!connId) return null; if (connMode === 'sql') return remoteSql.trim() ? { kind: 'connector', connection_id: connId, resource: { sql: remoteSql.trim() } } : null; return resource ? { kind: 'connector', connection_id: connId, resource } : null; }
    if (kind === 'url') return url.trim() ? { kind: 'url', url: url.trim(), format } : null;
    if (kind === 'sheet') return sheetId.trim() ? { kind: 'url', url: `https://docs.google.com/spreadsheets/d/${encodeURIComponent(sheetId.trim())}/export?format=csv${gid.trim() ? `&gid=${encodeURIComponent(gid.trim())}` : ''}`, format: 'csv' } : null;
    return sql.trim() ? { kind: 'sql', sql: sql.trim() } : null;
  }, [kind, dbId, catalog, schema, table, url, format, sheetId, gid, sql, connId, connMode, resource, remoteSql]);
  const schedule: SyncSchedule = schedKind === 'manual' ? { kind: 'manual' } : schedKind === 'interval' ? { kind: 'interval', minutes } : { kind: 'cron', expression: cron };
  useEffect(() => {
    if (!target && kind === 'table' && table) setTarget(table);
  }, [table]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (target || kind !== 'connector' || !resource) return;
    const guess = [resource.table_name, resource.table, resource.object, resource.resource, resource.sheet, resource.name].find((v) => typeof v === 'string' && v) as string | undefined;
    if (guess) setTarget(guess.replace(/\.[a-z0-9]+$/i, '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 63));
  }, [resource]); // eslint-disable-line react-hooks/exhaustive-deps

  const doPreview = async () => {
    if (!source) return;
    setBusy('preview');
    setError(null);
    try {
      setPreview(await api.post(`/api/workspaces/${workspaceId}/syncs/preview`, { source, transform_sql: transform || null, limit: 20 }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const save = async (run: boolean) => {
    if (!source) return;
    setBusy(run ? 'run' : 'save');
    setError(null);
    try {
      const body = { name, source, target_table: target, target_schema: targetSchema || 'main', mode, transform_sql: transform || null, schedule };
      const r = initial ? await api.patch<{ sync: DataSync }>(`/api/syncs/${initial.id}`, body) : await api.post<{ sync: DataSync }>(`/api/workspaces/${workspaceId}/syncs`, body);
      if (run) await api.post(`/api/syncs/${r.sync.id}/run`, {});
      onSaved(r.sync, run);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  /** Ask Copilot for a transformation over {{raw}} given the previewed columns; keep only the SQL. */
  const draft = async () => {
    if (!preview) await doPreview();
    setBusy('draft');
    setError(null);
    try {
      const cols = (preview?.columns ?? []).map((c) => `${c.name} ${c.type}`).join(', ');
      const goal = window.prompt('What should the transformed table contain? (e.g. "one row per customer with total revenue and last order date")', '');
      if (goal === null) return;
      let text = '';
      for await (const ev of copilotChat({ workspace_id: workspaceId, message: `Write one DuckDB SELECT that transforms the freshly loaded rows of a data sync into the target table. Read from the relation {{raw}} exactly (keep the double braces), which has these columns: ${cols || 'unknown — inspect'}. Goal: ${goal || 'clean column names, cast types sensibly, drop obviously invalid rows'}. Return only a single \`\`\`sql block, no prose.` })) {
        if (ev.type === 'delta') text += ev.text;
        if (ev.type === 'error') throw new Error(ev.message);
      }
      const m = /```sql\s*([\s\S]*?)```/i.exec(text) ?? /```\s*([\s\S]*?)```/.exec(text);
      const body = (m ? m[1]! : text).trim().replace(/;\s*$/, '');
      if (!/\{\{\s*raw\s*\}\}/.test(body)) throw new Error('Copilot did not read from {{raw}}; adjust the draft below.');
      setTransform(body);
      setPreview(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const kinds: { id: SourceKind; label: string; hint: string }[] = [
    { id: 'table', label: 'Table', hint: 'from a database or lakehouse connection' },
    { id: 'connector', label: 'Connector', hint: 'a warehouse, an application, Google Drive or Sheets' },
    { id: 'url', label: 'URL / API', hint: 'CSV, JSON, Parquet or Excel over HTTPS' },
    { id: 'sheet', label: 'Google Sheet', hint: 'shared with anyone with the link' },
    { id: 'sql', label: 'SQL', hint: 'any read-only SELECT in this workspace' },
  ];
  return (
    <Modal open={open} onClose={onClose} title={initial ? `Edit sync · ${initial.name}` : 'New sync'} width="max-w-4xl">
      <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
        <div className="space-y-3">
          <div><Label>Name</Label><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Orders from production" /></div>
          <div>
            <Label>Source</Label>
            <div className="grid grid-cols-5 gap-1 rounded-md border border-zinc-800 p-0.5">
              {kinds.map((k) => <button key={k.id} onClick={() => { setKind(k.id); setPreview(null); }} className={cn('rounded px-2 py-1 text-xs', kind === k.id ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200')} title={k.hint}>{k.label}</button>)}
            </div>
          </div>
          {kind === 'table' && (
            <div className="space-y-2">
              <div>
                <Label>Connection</Label>
                <Select value={dbId || (catalog ? `lh:${catalog}` : '')} onChange={(e) => { const v = e.target.value; if (v.startsWith('lh:')) { setDbId(''); setCatalog(v.slice(3)); } else { setDbId(v); setCatalog(''); } setSchema(''); setTable(''); }} className="w-full">
                  {databases.length === 0 && lakehouses.length === 0 && <option value="">No database or lakehouse connection yet</option>}
                  {databases.map((d) => <option key={d.id} value={d.id}>{d.name} · {d.engine} · {d.alias}</option>)}
                  {lakehouses.map((l) => <option key={l.id} value={`lh:${l.alias}`}>{l.name} · lakehouse · {l.alias}</option>)}
                </Select>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label>Schema</Label>
                  {dbId && schemas.length ? <Select value={schema} onChange={(e) => { setSchema(e.target.value); setTable(''); }} className="w-full"><option value="">pick…</option>{schemas.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}</Select> : <Input value={schema} onChange={(e) => setSchema(e.target.value)} className="font-mono" placeholder="public" />}
                </div>
                <div>
                  <Label>Table</Label>
                  {dbId && tables.length ? <Select value={table} onChange={(e) => setTable(e.target.value)} className="w-full"><option value="">pick…</option>{tables.map((t) => <option key={t.name} value={t.name}>{t.name}{t.type === 'view' ? ' (view)' : ''}{t.rows != null ? ` · ~${t.rows.toLocaleString()} rows` : ''}</option>)}</Select> : <Input value={table} onChange={(e) => setTable(e.target.value)} className="font-mono" placeholder="orders" />}
                </div>
              </div>
            </div>
          )}
          {kind === 'connector' && (
            <div className="space-y-2">
              <div className="grid grid-cols-[1fr_auto] gap-2">
                <div>
                  <Label>Connection</Label>
                  <Select value={connId} onChange={(e) => { setConnId(e.target.value); setConnPath([]); setResource(null); setPreview(null); setConnMode('browse'); }} className="w-full">
                    {connectors.length === 0 && <option value="">No warehouse, application or Google connection yet</option>}
                    {connectors.map((c) => <option key={c.id} value={c.id}>{c.name} · {c.connector_label}{c.account_label ? ` · ${c.account_label}` : ''}</option>)}
                  </Select>
                </div>
                {conn?.remote_sql && (
                  <div>
                    <Label>Read</Label>
                    <div className="flex rounded-md border border-zinc-800 p-0.5">
                      {(['browse', 'sql'] as const).map((m) => <button key={m} onClick={() => { setConnMode(m); setPreview(null); }} className={cn('rounded px-2 py-1 text-xs', connMode === m ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:text-zinc-200')}>{m === 'browse' ? 'a table' : 'SQL'}</button>)}
                    </div>
                  </div>
                )}
              </div>
              {connMode === 'sql' ? (
                <div><Label>Remote SQL <span className="normal-case text-zinc-600">(runs on {conn?.connector_label})</span></Label><textarea value={remoteSql} onChange={(e) => setRemoteSql(e.target.value)} rows={4} spellCheck={false} className="w-full rounded-md border border-zinc-700 bg-zinc-900 p-2 font-mono text-xs text-zinc-100 focus:border-accent-500 focus:outline-none" placeholder="SELECT * FROM ANALYTICS.PUBLIC.ORDERS WHERE order_date >= dateadd(day, -30, current_date)" /></div>
              ) : (
                <div className="rounded-md border border-zinc-800">
                  <div className="flex flex-wrap items-center gap-1 border-b border-zinc-800 px-2 py-1 text-[11px]">
                    <button className={cn('hover:text-zinc-100', connPath.length ? 'text-accent-300' : 'text-zinc-400')} onClick={() => { setConnPath([]); }}>{conn?.connector_label ?? 'root'}</button>
                    {connPath.map((p, i) => <span key={i} className="flex items-center gap-1"><ChevronRight className="h-3 w-3 text-zinc-600" /><button className={cn('hover:text-zinc-100', i < connPath.length - 1 ? 'text-accent-300' : 'text-zinc-300')} onClick={() => setConnPath(connPath.slice(0, i + 1))}>{p}</button></span>)}
                    {connBusy && <Loader2 className="ml-auto h-3 w-3 animate-spin text-zinc-500" />}
                    {resource && !connBusy && <span className="ml-auto truncate font-mono text-accent-300" title={JSON.stringify(resource)}>✓ {describeResource(resource)}</span>}
                  </div>
                  <ul className="max-h-44 overflow-auto text-xs">
                    {connEntries?.length === 0 && !connBusy && <li className="px-2 py-2 text-zinc-500">Nothing here{conn?.status === 'error' ? ' — the connection reports an error; test it from the Configured tab' : ''}.</li>}
                    {(connEntries ?? []).map((e, i) => (
                      <li key={i}>
                        <button type="button" onClick={() => { if (e.path) { setConnPath(e.path); } else if (e.resource) { setResource(e.resource); setPreview(null); } }} className={cn('flex w-full items-center gap-2 px-2 py-1 text-left hover:bg-zinc-800/60', resource && e.resource && JSON.stringify(resource) === JSON.stringify(e.resource) ? 'bg-accent-500/10 text-accent-200' : 'text-zinc-300')}>
                          {e.path ? <Folder className="h-3.5 w-3.5 shrink-0 text-zinc-500" /> : /file|sheet|report/.test(e.type) ? <FileText className="h-3.5 w-3.5 shrink-0 text-zinc-500" /> : <Table2 className="h-3.5 w-3.5 shrink-0 text-zinc-500" />}
                          <span className="truncate">{e.name}</span>
                          <span className="text-[10px] text-zinc-600">{e.type}</span>
                          {e.hint && <span className="ml-auto truncate text-[10px] text-zinc-500">{e.hint}</span>}
                          {e.path && <ChevronRight className="h-3 w-3 shrink-0 text-zinc-600" />}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {conn && conn.connector === 'ga4' && resource && <p className="text-[11px] text-zinc-500">Edit the preset's dimensions, metrics and dates by hand in the resource JSON below.</p>}
              {conn && resource && connMode === 'browse' && <details className="text-[11px] text-zinc-500"><summary className="cursor-pointer">Resource JSON</summary><textarea value={JSON.stringify(resource, null, 1)} onChange={(e) => { try { setResource(JSON.parse(e.target.value)); } catch { /* keep typing */ } }} rows={4} spellCheck={false} className="mt-1 w-full rounded-md border border-zinc-700 bg-zinc-900 p-2 font-mono text-[10.5px] text-zinc-300" /></details>}
            </div>
          )}
          {kind === 'url' && (
            <div className="grid grid-cols-[1fr_120px] gap-2">
              <div><Label>URL</Label><Input value={url} onChange={(e) => setUrl(e.target.value)} className="font-mono" placeholder="https://api.example.com/export.csv" spellCheck={false} /></div>
              <div><Label>Format</Label><Select value={format} onChange={(e) => setFormat(e.target.value as typeof format)} className="w-full"><option value="auto">auto</option><option value="csv">CSV</option><option value="json">JSON</option><option value="parquet">Parquet</option><option value="excel">Excel</option></Select></div>
              <p className="col-span-2 text-[11px] text-zinc-500">Needs external access on the server. A bearer token or header can be stored as an HTTP connection under Settings → Storage → Data connections.</p>
            </div>
          )}
          {kind === 'sheet' && (
            <div className="grid grid-cols-[1fr_120px] gap-2">
              <div><Label>Spreadsheet id</Label><Input value={sheetId} onChange={(e) => setSheetId(e.target.value)} className="font-mono" placeholder="1AbC…xYz" spellCheck={false} /></div>
              <div><Label>Sheet gid</Label><Input value={gid} onChange={(e) => setGid(e.target.value)} className="font-mono" placeholder="0" /></div>
              <p className="col-span-2 text-[11px] text-zinc-500">The sheet must be shared with "anyone with the link" (or published to the web). The id is the long part of the sheet's URL; the gid is the tab's id from the URL.</p>
            </div>
          )}
          {kind === 'sql' && (
            <div><Label>SELECT</Label><textarea value={sql} onChange={(e) => setSql(e.target.value)} rows={5} spellCheck={false} className="w-full rounded-md border border-zinc-700 bg-zinc-900 p-2 font-mono text-xs text-zinc-100 focus:border-accent-500 focus:outline-none" placeholder="SELECT * FROM wh.sales.orders WHERE day >= current_date - 30" /></div>
          )}
          <div className="grid grid-cols-[1fr_1fr_120px] gap-2">
            <div><Label>Target table</Label><Input value={target} onChange={(e) => setTarget(e.target.value)} className="font-mono" placeholder="orders" spellCheck={false} /></div>
            <div><Label>Schema</Label><Input value={targetSchema} onChange={(e) => setTargetSchema(e.target.value)} className="font-mono" placeholder="main" spellCheck={false} /></div>
            <div><Label>Mode</Label><Select value={mode} onChange={(e) => setMode(e.target.value as 'replace' | 'append')} className="w-full"><option value="replace">replace</option><option value="append">append</option></Select></div>
          </div>
          <div className="grid grid-cols-[140px_1fr] gap-2">
            <div><Label>Schedule</Label><Select value={schedKind} onChange={(e) => setSchedKind(e.target.value as SyncSchedule['kind'])} className="w-full"><option value="manual">manual</option><option value="interval">every N minutes</option><option value="cron">cron</option></Select></div>
            <div>
              <Label>{schedKind === 'interval' ? 'Minutes' : schedKind === 'cron' ? 'Cron expression (UTC)' : ' '}</Label>
              {schedKind === 'interval' && <Input type="number" min={1} value={minutes} onChange={(e) => setMinutes(Math.max(1, Number(e.target.value)))} />}
              {schedKind === 'cron' && <Input value={cron} onChange={(e) => setCron(e.target.value)} className="font-mono" placeholder="0 6 * * 1-5" />}
              {schedKind === 'manual' && <p className="pt-2 text-[11px] text-zinc-500">Run from the list, the API or an agent.</p>}
            </div>
          </div>
        </div>
        <div className="space-y-3">
          <div>
            <div className="flex items-center justify-between">
              <Label>Transformation <span className="normal-case text-zinc-600">(optional · SELECT over {'{{raw}}'})</span></Label>
              <button onClick={() => void draft()} disabled={!source || busy !== null || !cp.config?.can_use} className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-[11px] text-accent-300 hover:underline disabled:opacity-40" title={cp.config?.can_use ? 'Let Copilot draft the transformation from the previewed columns' : 'Configure Copilot under Settings → Copilot first'}>
                {busy === 'draft' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Wand2 className="h-3 w-3" />} Draft with Copilot
              </button>
            </div>
            <textarea value={transform} onChange={(e) => setTransform(e.target.value)} rows={8} spellCheck={false} className="w-full rounded-md border border-zinc-700 bg-zinc-900 p-2 font-mono text-xs text-zinc-100 focus:border-accent-500 focus:outline-none" placeholder={'SELECT\n  lower(email) AS email,\n  amount::DECIMAL(12,2) AS amount,\n  day::DATE AS day\nFROM {{raw}}\nWHERE amount > 0'} />
            <p className="mt-1 text-[11px] text-zinc-500">The loaded rows are {'{{raw}}'}; the SELECT's result becomes the target table. Leave empty to load as is. Validated before saving; agents can set it through <code className="font-mono">update_data_sync</code>.</p>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="secondary" onClick={() => void doPreview()} loading={busy === 'preview'} disabled={!source}><Eye className="h-3.5 w-3.5" /> Preview</Button>
            {preview && <span className="text-[11px] text-zinc-500">{preview.columns.length} column{preview.columns.length === 1 ? '' : 's'} · first {preview.rows.length} row{preview.rows.length === 1 ? '' : 's'}</span>}
          </div>
          {preview && (
            <div className="max-h-56 overflow-auto rounded-md border border-zinc-800">
              <table className="w-full text-[11px]">
                <thead className="sticky top-0 bg-zinc-900 text-left text-[10px] uppercase text-zinc-500"><tr>{preview.columns.map((c) => <th key={c.name} className="px-2 py-1 font-mono">{c.name}<span className="ml-1 text-zinc-600">{c.type}</span></th>)}</tr></thead>
                <tbody>{preview.rows.map((r, i) => <tr key={i} className="border-t border-zinc-800/60">{r.map((v, j) => <td key={j} className="px-2 py-0.5 font-mono text-zinc-300">{v == null ? <span className="text-zinc-600">null</span> : String(v)}</td>)}</tr>)}</tbody>
              </table>
            </div>
          )}
          {error && <div className="rounded-md border border-red-900 bg-red-950/50 px-3 py-2 font-mono text-xs text-red-200">{error}</div>}
        </div>
      </div>
      <div className="mt-4 flex items-center justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="secondary" onClick={() => void save(false)} loading={busy === 'save'} disabled={!source || !name.trim() || !target.trim()}><Save className="h-4 w-4" /> Save</Button>
        <Button variant="primary" onClick={() => void save(true)} loading={busy === 'run'} disabled={!source || !name.trim() || !target.trim()}><Play className="h-4 w-4" /> Save & run now</Button>
      </div>
    </Modal>
  );
}
