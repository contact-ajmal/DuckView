import { useMemo, useState } from 'react';
import { Table2, Eye, FileSpreadsheet, FileJson, Database, Folder, ChevronRight, ChevronDown, Box, Search, Plus } from 'lucide-react';
import type { CatalogObject, JailEntry } from '../../api/client';
import { formatBytes } from '../../api/client';
import { Spinner, cn } from '../../components/ui';
import { typeTone } from '../../components/layout';

const fileIcon = (kind: string) => {
  switch (kind) {
    case 'parquet':
    case 'arrow':
      return <Box className="h-3.5 w-3.5 text-accent-300" />;
    case 'csv':
    case 'excel':
      return <FileSpreadsheet className="h-3.5 w-3.5 text-emerald-300" />;
    case 'json':
      return <FileJson className="h-3.5 w-3.5 text-amber-300" />;
    case 'duckdb':
      return <Database className="h-3.5 w-3.5 text-sky-300" />;
    default:
      return <Folder className="h-3.5 w-3.5 text-zinc-400" />;
  }
};

export const quoteIdent = (s: string) => (/^[a-z_][a-z0-9_]*$/.test(s) ? s : `"${s.replace(/"/g, '""')}"`);

export function fileSelectSql(f: JailEntry): string {
  if (f.kind === 'delta') return `SELECT * FROM delta_scan('${f.path}') LIMIT 100;`;
  if (f.kind === 'iceberg') return `SELECT * FROM iceberg_scan('${f.path}') LIMIT 100;`;
  if (f.kind === 'duckdb') return `ATTACH '${f.path}' AS attached_db (READ_ONLY);\nSHOW ALL TABLES;`;
  if (f.kind === 'excel') return `SELECT * FROM read_xlsx('${f.path}') LIMIT 100;`;
  return `SELECT * FROM '${f.path}' LIMIT 100;`;
}

/** Type text coloured like the reference (amber numerics, green temporals, blue booleans). */
const typeText = (type: string) => typeTone(type).split(' ').find((c) => c.startsWith('text-')) ?? 'text-zinc-400';

function ObjectNode({ o, defaultOpen, onInsert, onSnippet }: { o: CatalogObject; defaultOpen: boolean; onInsert: (ident: string) => void; onSnippet: (sql: string) => void }) {
  const [open, setOpen] = useState(defaultOpen);
  const fq = o.schema === 'main' ? quoteIdent(o.name) : `${quoteIdent(o.schema)}.${quoteIdent(o.name)}`;
  return (
    <div className="mb-1">
      <div className="group flex items-center gap-1.5 rounded px-1 py-1 hover:bg-zinc-800/60">
        <button onClick={() => setOpen(!open)} className="text-zinc-500" aria-label="Toggle columns">
          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </button>
        {o.type === 'VIEW' ? <Eye className="h-3.5 w-3.5 shrink-0 text-sky-300" /> : <Table2 className="h-3.5 w-3.5 shrink-0 text-accent-300" />}
        <button className="min-w-0 flex-1 truncate text-left font-mono text-xs text-zinc-100 hover:text-accent-300" onClick={() => onInsert(fq)} title={`Insert ${fq} at cursor`}>
          {fq}
        </button>
        <span className="font-mono text-[10px] text-zinc-500">{o.type === 'VIEW' ? 'view' : 'table'}</span>
        <span className="font-mono text-[10px] text-zinc-500">{o.column_count} cols</span>
        <button className="rounded p-0.5 text-zinc-500 opacity-0 hover:text-accent-300 group-hover:opacity-100" onClick={() => onSnippet(`SELECT * FROM ${fq} LIMIT 100;`)} title="Insert SELECT snippet">
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>
      {open && (
        <div className="ml-4 border-l border-zinc-800 pl-2">
          {o.columns.map((c) => (
            <button key={c.name} onClick={() => onInsert(quoteIdent(c.name))} className="flex w-full items-center justify-between rounded px-2 py-[3px] font-mono text-[11px] hover:bg-zinc-800/60" title={`Insert ${c.name}`}>
              <span className="truncate text-zinc-300">{c.name}</span>
              <span className={cn('ml-2 shrink-0', typeText(c.type))}>{c.type}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function SchemaTree({ catalog, loading, onInsert, onSnippet }: { catalog: { objects: CatalogObject[]; files: JailEntry[] } | null; loading: boolean; onInsert: (ident: string) => void; onSnippet: (sql: string) => void }) {
  const [filter, setFilter] = useState('');
  const q = filter.toLowerCase();
  const objects = useMemo(() => (catalog?.objects ?? []).filter((o) => !q || o.name.toLowerCase().includes(q) || o.columns.some((c) => c.name.toLowerCase().includes(q))), [catalog, q]);
  const files = useMemo(() => (catalog?.files ?? []).filter((f) => !q || f.path.toLowerCase().includes(q)), [catalog, q]);
  if (!catalog) {
    return (
      <div className="flex h-20 items-center justify-center">
        <Spinner />
      </div>
    );
  }
  return (
    <div>
      {(objects.length + files.length > 8 || q) && (
        <div className="mb-2 flex items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-950 px-2">
          <Search className="h-3 w-3 text-zinc-500" />
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter…" className="h-6 min-w-0 flex-1 bg-transparent text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none" />
          {loading && <Spinner className="h-3 w-3" />}
        </div>
      )}
      {objects.map((o) => (
        <ObjectNode key={`${o.database}.${o.schema}.${o.name}`} o={o} defaultOpen={objects.length <= 4} onInsert={onInsert} onSnippet={onSnippet} />
      ))}
      {files.length > 0 && <div className={cn('mb-1 px-1 font-mono text-[10px] text-zinc-500', objects.length > 0 && 'mt-2')}>files</div>}
      {files.map((f) => (
        <div key={f.path} className="group flex items-center gap-2 rounded px-1 py-1 hover:bg-zinc-800/60">
          {fileIcon(f.kind)}
          <button className="min-w-0 flex-1 truncate text-left font-mono text-xs text-zinc-100 hover:text-accent-300" onClick={() => onInsert(`'${f.path}'`)} title={`Insert '${f.path}' · ${formatBytes(f.size_bytes)}`}>
            {f.path}
          </button>
          <span className="font-mono text-[10px] text-zinc-500">{formatBytes(f.size_bytes)}</span>
          <button className="rounded p-0.5 text-zinc-500 opacity-0 hover:text-accent-300 group-hover:opacity-100" onClick={() => onSnippet(fileSelectSql(f))} title="Insert SELECT snippet">
            <Plus className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
      {objects.length === 0 && files.length === 0 && <div className="px-1 py-2 text-[11px] text-zinc-600">Nothing yet — drop a file on the Overview page or CREATE TABLE here.</div>}
    </div>
  );
}
