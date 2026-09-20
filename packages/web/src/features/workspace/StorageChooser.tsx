import { useEffect, useState, type ReactNode } from 'react';
import { HardDrive, Zap, Cloud, FolderOpen, Database } from 'lucide-react';
import { api, type StorageOptions } from '../../api/client';
import { Input, Label, Select, cn } from '../../components/ui';

export type StorageChoice = { kind: 'data'; path: string } | { kind: 'folder'; path: string } | { kind: 'cloud'; connectionId: string; key: string } | { kind: 'memory' } | { kind: 'motherduck'; path: string };

/** The `active_db_path` (and connection) a choice resolves to; empty path = let the server name it. */
export function toDbPath(choice: StorageChoice, options: StorageOptions | null): { active_db_path?: string; cloud_connection_id?: string } {
  switch (choice.kind) {
    case 'memory':
      return { active_db_path: ':memory:' };
    case 'data':
      return choice.path.trim() ? { active_db_path: choice.path.trim() } : {};
    case 'folder':
      return { active_db_path: choice.path.trim() };
    case 'motherduck':
      return { active_db_path: choice.path.trim() || 'md:' };
    case 'cloud': {
      const c = options?.cloud_connections.find((x) => x.id === choice.connectionId);
      const bucket = c?.bucket ?? '';
      return { active_db_path: `${c?.uri_scheme ?? 's3'}://${bucket}/${choice.key.replace(/^\/+/, '')}`, cloud_connection_id: choice.connectionId };
    }
  }
}

let cached: Promise<StorageOptions> | null = null;
export function loadStorageOptions(force = false): Promise<StorageOptions> {
  if (!cached || force) cached = api.get<StorageOptions>('/api/workspaces/storage-options').catch((e) => { cached = null; throw e; });
  return cached;
}

/**
 * Where a workspace's database should live: the data directory (default), any folder on the host (full filesystem
 * mode), an object in cloud storage through one of the person's cloud connections, in-memory, or MotherDuck.
 */
export function StorageChooser({ value, onChange, suggestedName, allowMemory = true, allowMotherduck = true, compact }: { value: StorageChoice; onChange: (c: StorageChoice) => void; suggestedName: string; allowMemory?: boolean; allowMotherduck?: boolean; compact?: boolean }) {
  const [options, setOptions] = useState<StorageOptions | null>(null);
  const [suggested, setSuggested] = useState('');
  useEffect(() => {
    loadStorageOptions().then(setOptions).catch(() => undefined);
  }, []);
  useEffect(() => {
    let cancelled = false;
    api.get<{ path: string }>(`/api/workspaces/suggest-db-path?name=${encodeURIComponent(suggestedName)}`).then((r) => !cancelled && setSuggested(r.path)).catch(() => undefined);
    return () => { cancelled = true; };
  }, [suggestedName]);
  const full = options?.mode === 'full';
  const clouds = options?.cloud_connections ?? [];
  const cards: { kind: StorageChoice['kind']; label: string; hint: string; icon: ReactNode; disabled?: string }[] = [
    { kind: 'data', label: 'Data directory', hint: 'A .duckdb file in DuckView\'s data directory. Survives restarts; backed up with the data directory.', icon: <HardDrive className="h-4 w-4" /> },
    { kind: 'folder', label: 'Folder on the server', hint: full ? 'Any writable folder on the host — a mounted volume, a network share.' : 'Needs security.filesystem_mode: full.', icon: <FolderOpen className="h-4 w-4" />, disabled: full ? undefined : 'Only in full filesystem mode' },
    { kind: 'cloud', label: 'Cloud storage', hint: clouds.length ? 'An object in S3, R2, GCS or Azure through one of your cloud connections; worked on locally and synced automatically.' : 'Add a cloud connection under Settings → Storage first.', icon: <Cloud className="h-4 w-4" />, disabled: clouds.length ? undefined : 'No cloud connection yet' },
    ...(allowMemory ? [{ kind: 'memory' as const, label: 'In-memory scratch', hint: 'Fastest; cleared when the engine restarts. Can be made persistent later without losing tables.', icon: <Zap className="h-4 w-4" /> }] : []),
    ...(allowMotherduck ? [{ kind: 'motherduck' as const, label: 'MotherDuck', hint: 'A cloud DuckDB database (md:name) through your MotherDuck token.', icon: <Database className="h-4 w-4" /> }] : []),
  ];
  const pick = (kind: StorageChoice['kind']) => {
    if (kind === value.kind) return;
    if (kind === 'data') onChange({ kind, path: '' });
    else if (kind === 'folder') onChange({ kind, path: '' });
    else if (kind === 'cloud') onChange({ kind, connectionId: clouds[0]?.id ?? '', key: suggested || 'workspace.duckdb' });
    else if (kind === 'memory') onChange({ kind });
    else onChange({ kind: 'motherduck', path: 'md:' });
  };
  const conn = value.kind === 'cloud' ? clouds.find((c) => c.id === value.connectionId) : null;
  return (
    <div className="space-y-3">
      <div className={cn('grid gap-2', compact ? 'grid-cols-2 md:grid-cols-3' : 'grid-cols-2 md:grid-cols-3 xl:grid-cols-5')}>
        {cards.map((c) => (
          <button key={c.kind} type="button" disabled={!!c.disabled} title={c.disabled ?? c.hint} onClick={() => pick(c.kind)} className={cn('rounded-lg border p-2.5 text-left', value.kind === c.kind ? 'border-accent-500 bg-accent-500/10' : 'border-zinc-800 hover:border-zinc-600', c.disabled && 'cursor-not-allowed opacity-50')}>
            <div className="flex items-center gap-1.5 text-sm font-semibold text-zinc-100">{c.icon} {c.label}</div>
            <div className="mt-1 text-[11px] leading-snug text-zinc-500">{c.hint}</div>
          </button>
        ))}
      </div>
      {value.kind === 'data' && (
        <div>
          <Label>File name</Label>
          <Input value={value.path} onChange={(e) => onChange({ kind: 'data', path: e.target.value })} className="font-mono" placeholder={suggested || 'chosen from the name'} spellCheck={false} />
          <p className="mt-1 text-[11px] text-zinc-500">Leave empty to use <code className="font-mono">{suggested || '<name>.duckdb'}</code>{options ? ` in ${options.data_directory}` : ''}. Never listed as a data file.</p>
        </div>
      )}
      {value.kind === 'folder' && (
        <div>
          <Label>Absolute path of the database file</Label>
          <Input value={value.path} onChange={(e) => onChange({ kind: 'folder', path: e.target.value })} className="font-mono" placeholder={`/mnt/analytics/${suggested || 'workspace.duckdb'}`} spellCheck={false} />
          <p className="mt-1 text-[11px] text-zinc-500">The folder is created if needed and must be writable for the DuckView process. Only one DuckView instance may open the file.</p>
        </div>
      )}
      {value.kind === 'cloud' && (
        <div className="grid gap-2 md:grid-cols-2">
          <div>
            <Label>Cloud connection</Label>
            <Select value={value.connectionId} onChange={(e) => onChange({ ...value, connectionId: e.target.value })} className="w-full">
              {clouds.map((c) => <option key={c.id} value={c.id}>{c.name} · {c.provider}{c.bucket ? ` · ${c.bucket}` : ''}</option>)}
            </Select>
          </div>
          <div>
            <Label>Object key</Label>
            <Input value={value.key} onChange={(e) => onChange({ ...value, key: e.target.value })} className="font-mono" placeholder={`workspaces/${suggested || 'workspace.duckdb'}`} spellCheck={false} />
          </div>
          <p className="text-[11px] text-zinc-500 md:col-span-2">
            Stored as <code className="font-mono">{conn ? `${conn.uri_scheme}://${conn.bucket ?? '<bucket>'}/${value.key.replace(/^\/+/, '') || '…'}` : '…'}</code>. DuckDB works on a local copy; every change is pushed to the object after a quiet minute, on <i>Sync now</i>, and at shutdown, and a new instance pulls it before the first query. One DuckView instance at a time.
            {conn && !conn.bucket && <span className="text-amber-300"> This connection has no default bucket — set one on the connection first.</span>}
          </p>
        </div>
      )}
      {value.kind === 'motherduck' && (
        <div>
          <Label>Database</Label>
          <Input value={value.path} onChange={(e) => onChange({ kind: 'motherduck', path: e.target.value })} className="font-mono" placeholder="md:my_database" spellCheck={false} />
        </div>
      )}
    </div>
  );
}
