import { useCallback, useEffect, useState } from 'react';
import { BookOpen, ChevronDown, ChevronRight, Tag } from 'lucide-react';
import { api, type AnnotatedObject } from '../../api/client';
import { useWorkspaceAccess } from '../../store/workspace';
import { Badge, Button, Empty, Input, cn } from '../../components/ui';

/** Governance → Catalog: what tables and columns mean — Copilot and agents read these notes. */
export function CatalogPanel({ workspaceId }: { workspaceId: string }) {
  const { canEdit } = useWorkspaceAccess();
  const [objects, setObjects] = useState<AnnotatedObject[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [edit, setEdit] = useState<{ object: string; column: string | null; description: string; tags: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => setObjects((await api.get<{ objects: AnnotatedObject[] }>(`/api/workspaces/${workspaceId}/catalog/annotated`)).objects.filter((o) => !o.name.startsWith('duckview_mosaic'))), [workspaceId]);
  useEffect(() => void load().catch((e) => setError((e as Error).message)), [load]);
  const nameOf = (o: AnnotatedObject) => (o.schema === 'main' ? o.name : `${o.schema}.${o.name}`);
  const save = async () => {
    if (!edit) return;
    try {
      await api.put(`/api/workspaces/${workspaceId}/catalog/annotations`, { object_name: edit.object, column_name: edit.column, description: edit.description, tags: edit.tags.split(/[,\s]+/).filter(Boolean) });
      setEdit(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const editor = (object: string, column: string | null, description: string | null, tags: string[]) =>
    edit && edit.object === object && edit.column === column ? (
      <div className="mt-1 flex flex-wrap items-center gap-1.5">
        <Input autoFocus className="h-7 min-w-64 flex-1 text-xs" value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} placeholder={column ? 'What this column holds (units, meaning)' : 'What this table is, where it comes from, what one row means'} onKeyDown={(e) => { if (e.key === 'Enter') void save(); }} />
        <Input className="h-7 w-44 text-xs" value={edit.tags} onChange={(e) => setEdit({ ...edit, tags: e.target.value })} placeholder="tags: pii, finance" />
        <Button size="sm" variant="primary" onClick={() => void save()}>Save</Button>
        <Button size="sm" variant="ghost" onClick={() => setEdit(null)}>Cancel</Button>
      </div>
    ) : (
      <button disabled={!canEdit} onClick={() => setEdit({ object, column, description: description ?? '', tags: tags.join(', ') })} className={cn('text-left text-[11px]', description ? 'text-zinc-300' : 'italic text-zinc-600', canEdit && 'hover:text-zinc-100')}>
        {description || (canEdit ? 'Add a description…' : 'No description')}
        {tags.map((t) => <Badge key={t} tone={t === 'pii' ? 'red' : 'blue'} className="ml-1.5">{t}</Badge>)}
      </button>
    );
  const shown = objects.filter((o) => !filter || nameOf(o).toLowerCase().includes(filter.toLowerCase()) || (o.description ?? '').toLowerCase().includes(filter.toLowerCase()) || o.tags.some((t) => t.includes(filter.toLowerCase())));
  return (
    <div className="space-y-3 text-xs">
      <div className="flex items-center justify-between gap-2">
        <p className="text-zinc-500">What the tables and columns mean. Copilot and agents are given these notes, so write what a newcomer would need; tag sensitive columns (<code>pii</code>).</p>
        <Input className="h-7 w-56" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter by name, text or tag" />
      </div>
      {error && <div className="rounded-md border border-red-900 bg-red-950/50 px-3 py-2 font-mono text-red-200">{error}</div>}
      {shown.length === 0 ? <div className="rounded-xl border border-dashed border-zinc-800 py-12"><Empty icon={<BookOpen className="h-10 w-10" />} title="No tables" hint="Tables and views of the workspace appear here." /></div> : (
        <div className="divide-y divide-zinc-800/70 rounded-lg border border-zinc-800">
          {shown.map((o) => {
            const name = nameOf(o);
            const expanded = open === name;
            const described = o.columns.filter((c) => c.description || c.tags.length).length;
            return (
              <div key={name} className="p-2.5">
                <div className="flex items-start gap-2">
                  <button onClick={() => setOpen(expanded ? null : name)} className="mt-0.5 text-zinc-500 hover:text-zinc-200">{expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}</button>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2"><span className="font-mono text-zinc-100">{name}</span><span className="text-[10.5px] text-zinc-600">{o.type.toLowerCase()} · {o.column_count} columns{o.estimated_rows !== null ? ` · ${o.estimated_rows.toLocaleString()} rows` : ''}{described ? ` · ${described} described` : ''}</span></div>
                    {editor(name, null, o.description, o.tags)}
                  </div>
                </div>
                {expanded && (
                  <div className="ml-6 mt-2 space-y-1 border-l border-zinc-800 pl-3">
                    {o.columns.map((c) => (
                      <div key={c.name} className="flex items-start gap-2">
                        <Tag className="mt-0.5 h-3 w-3 shrink-0 text-zinc-600" />
                        <span className="w-40 shrink-0 truncate font-mono text-zinc-300" title={c.type}>{c.name} <span className="text-zinc-600">{c.type.toLowerCase()}</span></span>
                        <div className="min-w-0 flex-1">{editor(name, c.name, c.description, c.tags)}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
