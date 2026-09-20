import { useEffect, useMemo, useState } from 'react';
import { Play, Save, Loader2, Eye, Wand2 } from 'lucide-react';
import { api, copilotChat, type DataSync, type DatabaseConnection, type DatabaseEntry, type LakehouseConnection, type SyncSource, type SyncSchedule } from '../../api/client';
import { useCopilot } from '../../store/copilot';
import { Button, Input, Label, Modal, Select, cn } from '../../components/ui';

type SourceKind = 'table' | 'url' | 'sheet' | 'sql';

/** Create or edit a scheduled sync: source → target, schedule, transformation (with a Copilot drafter), preview. */
export function SyncEditor({ open, workspaceId, initial, databases, lakehouses, onClose, onSaved }: { open: boolean; workspaceId: string; initial?: DataSync | null; databases: DatabaseConnection[]; lakehouses: LakehouseConnection[]; onClose: () => void; onSaved: (s: DataSync, ran?: boolean) => void }) {
  const cp = useCopilot();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<SourceKind>('table');
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
      else if (s.kind === 'url') { const m = /docs\.google\.com\/spreadsheets\/d\/([^/]+)\/export\?format=csv(?:&gid=([^&]+))?/.exec(s.url); if (m) { setKind('sheet'); setSheetId(decodeURIComponent(m[1]!)); setGid(m[2] ? decodeURIComponent(m[2]) : ''); } else { setKind('url'); setUrl(s.url); setFormat(s.format); } }
      else { setKind('sql'); setSql(s.sql); }
    } else {
      setName(''); setKind(databases.length || lakehouses.length ? 'table' : 'url'); setDbId(databases[0]?.id ?? ''); setCatalog(lakehouses[0]?.alias ?? ''); setSchema(''); setTable(''); setUrl(''); setFormat('auto'); setSheetId(''); setGid(''); setSql(''); setTarget(''); setTargetSchema('main'); setMode('replace'); setSchedKind('interval'); setMinutes(60); setCron('0 6 * * *'); setTransform('');
    }
  }, [open, initial]); // eslint-disable-line react-hooks/exhaustive-deps

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
    if (kind === 'url') return url.trim() ? { kind: 'url', url: url.trim(), format } : null;
    if (kind === 'sheet') return sheetId.trim() ? { kind: 'url', url: `https://docs.google.com/spreadsheets/d/${encodeURIComponent(sheetId.trim())}/export?format=csv${gid.trim() ? `&gid=${encodeURIComponent(gid.trim())}` : ''}`, format: 'csv' } : null;
    return sql.trim() ? { kind: 'sql', sql: sql.trim() } : null;
  }, [kind, dbId, catalog, schema, table, url, format, sheetId, gid, sql]);
  const schedule: SyncSchedule = schedKind === 'manual' ? { kind: 'manual' } : schedKind === 'interval' ? { kind: 'interval', minutes } : { kind: 'cron', expression: cron };
  useEffect(() => {
    if (!target && kind === 'table' && table) setTarget(table);
  }, [table]); // eslint-disable-line react-hooks/exhaustive-deps

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
            <div className="grid grid-cols-4 gap-1 rounded-md border border-zinc-800 p-0.5">
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
