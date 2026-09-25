/**
 * Data → Prepare: clean and reshape a table step by step without writing SQL. Each step (filter, keep or remove
 * columns, rename, change type, fill empty values, clean text, find and replace, add a column, split, read dates,
 * remove duplicates, sort) becomes one CTE of a readable SELECT; the preview shows the result and the rows each
 * step leaves. The result is saved as a view, a table or a dbt model, or opened in the SQL workbench.
 * Deep link: #/transform/prepare?source=<table or file>
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Plus, Save, SquareTerminal, Trash2, Wand2, Workflow } from 'lucide-react';
import { api, type ColumnSchema } from '../../api/client';
import { PageHeader } from '../../components/layout';
import { ResultPreview } from '../../components/data';
import { Button, Checkbox, Empty, Field, IconButton, InlineError, Input, Menu, MenuItem, Select, Skeleton, toast, errorText, cn } from '../../components/ui';
import { useWorkspace } from '../../store/workspace';
import { SaveDbtModelDialog } from './SaveDbtModelDialog';

type Op = 'filter' | 'keep' | 'drop' | 'rename' | 'cast' | 'fill' | 'text' | 'replace' | 'derive' | 'split' | 'parse_date' | 'dedupe' | 'sort';
/** A step as edited: every field a string, turned into the API's shape when sent. */
interface Draft { id: number; op: Op; column: string; columns: string; value: string; value2: string; desc: boolean }
interface Preview { sql: string; columns: ColumnSchema[]; rows: unknown[][]; source_rows: number; step_rows: number[]; steps: string[] }

const OPS: { op: Op; label: string; hint: string }[] = [
  { op: 'filter', label: 'Filter rows', hint: 'Keep the rows that match a condition' },
  { op: 'keep', label: 'Keep columns', hint: 'Only these columns, in this order' },
  { op: 'drop', label: 'Remove columns', hint: '' },
  { op: 'rename', label: 'Rename a column', hint: '' },
  { op: 'cast', label: 'Change a type', hint: 'Values that do not convert become NULL' },
  { op: 'fill', label: 'Fill empty values', hint: '' },
  { op: 'text', label: 'Clean text', hint: 'Trim, change case, collapse spaces' },
  { op: 'replace', label: 'Find and replace', hint: '' },
  { op: 'derive', label: 'Add a column', hint: 'From a SQL expression' },
  { op: 'split', label: 'Split a column', hint: 'On a separator, into new columns' },
  { op: 'parse_date', label: 'Read dates', hint: 'Text such as 31/12/2025 to a timestamp' },
  { op: 'dedupe', label: 'Remove duplicates', hint: '' },
  { op: 'sort', label: 'Sort', hint: '' },
];
const TEXT_FNS = [['trim', 'Trim spaces'], ['lower', 'lowercase'], ['upper', 'UPPERCASE'], ['collapse_spaces', 'Collapse repeated spaces'], ['digits_only', 'Keep only digits']] as const;
const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

/** The API's step, or the reason it is not ready. */
function toStep(d: Draft): Record<string, unknown> | string {
  const need = (v: string, what: string) => (v.trim() ? null : what);
  const miss = (() => {
    switch (d.op) {
      case 'filter': return need(d.value, 'Write the condition');
      case 'keep': case 'drop': return list(d.columns).length ? null : 'Name the columns';
      case 'rename': return need(d.column, 'Choose the column') ?? need(d.value, 'Give the new name');
      case 'cast': return need(d.column, 'Choose the column') ?? need(d.value, 'Choose the type');
      case 'fill': case 'text': return need(d.column, 'Choose the column');
      case 'replace': return need(d.column, 'Choose the column') ?? need(d.value, 'What to find');
      case 'derive': return need(d.value, 'Name the column') ?? need(d.value2, 'Write the expression');
      case 'split': return need(d.column, 'Choose the column') ?? (d.value ? null : 'Give the separator') ?? (list(d.value2).length ? null : 'Name the new columns');
      case 'parse_date': return need(d.column, 'Choose the column') ?? need(d.value, 'Give the format');
      case 'sort': return need(d.column, 'Choose the column');
      case 'dedupe': return null;
    }
  })();
  if (miss) return miss;
  switch (d.op) {
    case 'filter': return { op: 'filter', condition: d.value };
    case 'keep': case 'drop': return { op: d.op, columns: list(d.columns) };
    case 'rename': return { op: 'rename', column: d.column, to: d.value.trim() };
    case 'cast': return { op: 'cast', column: d.column, type: d.value.trim() };
    case 'fill': return { op: 'fill', column: d.column, value: d.value.trim() !== '' && !Number.isNaN(Number(d.value)) ? Number(d.value) : d.value };
    case 'text': return { op: 'text', column: d.column, fn: d.value || 'trim' };
    case 'replace': return { op: 'replace', column: d.column, find: d.value, with: d.value2 };
    case 'derive': return { op: 'derive', name: d.value.trim(), expression: d.value2 };
    case 'split': return { op: 'split', column: d.column, separator: d.value, into: list(d.value2) };
    case 'parse_date': return { op: 'parse_date', column: d.column, format: d.value.trim() };
    case 'dedupe': return list(d.columns).length ? { op: 'dedupe', columns: list(d.columns) } : { op: 'dedupe' };
    case 'sort': return { op: 'sort', by: [{ column: d.column, desc: d.desc }] };
  }
}

export function PreparePage({ workspaceId }: { workspaceId: string }) {
  const ws = useWorkspace();
  const [source, setSource] = useState(() => new URLSearchParams(location.hash.split('?')[1] ?? '').get('source') ?? '');
  const [steps, setSteps] = useState<Draft[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [name, setName] = useState('');
  const [as, setAs] = useState<'view' | 'table'>('view');
  const [replace, setReplace] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dbtSql, setDbtSql] = useState<string | null>(null);
  const nextId = useRef(1);

  const datasets = useMemo(() => [...(ws.catalog?.objects ?? []).filter((o) => !o.name.startsWith('duckview_')).map((o) => (o.schema === 'main' ? o.name : `${o.schema}.${o.name}`)), ...(ws.catalog?.files ?? []).map((f) => `'${f.path}'`)], [ws.catalog]);
  const built = steps.map(toStep);
  const firstIncomplete = built.findIndex((s) => typeof s === 'string');
  const ready = built.slice(0, firstIncomplete === -1 ? built.length : firstIncomplete) as Record<string, unknown>[];
  const key = JSON.stringify([source, ready]);
  // The source's columns, for the column pickers (the preview's columns once there is one).
  const sourceColumns = useMemo(() => {
    const o = (ws.catalog?.objects ?? []).find((x) => (x.schema === 'main' ? x.name : `${x.schema}.${x.name}`) === source.trim());
    return o?.columns.map((c) => c.name) ?? [];
  }, [ws.catalog, source]);
  const columnNames = [...new Set([...sourceColumns, ...(preview?.columns.map((c) => c.name) ?? [])])];

  useEffect(() => {
    if (!source.trim()) {
      setPreview(null);
      return;
    }
    let live = true;
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const r = await api.post<Preview>(`/api/workspaces/${workspaceId}/prep/preview`, { source: source.trim(), steps: ready, limit: 200 });
        if (!live) return;
        setPreview(r);
        setError(null);
      } catch (e) {
        if (live) setError(e);
      } finally {
        if (live) setLoading(false);
      }
    }, 350);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [key, workspaceId]); // eslint-disable-line react-hooks/exhaustive-deps

  const add = (op: Op) => {
    const id = nextId.current++;
    setSteps([...steps, { id, op, column: '', columns: '', value: op === 'text' ? 'trim' : op === 'parse_date' ? '%d/%m/%Y' : op === 'cast' ? 'INTEGER' : '', value2: '', desc: false }]);
    setOpen(id);
  };
  const patch = (id: number, p: Partial<Draft>) => setSteps(steps.map((s) => (s.id === id ? { ...s, ...p } : s)));
  const move = (i: number, by: number) => {
    const next = [...steps];
    const [s] = next.splice(i, 1);
    next.splice(i + by, 0, s!);
    setSteps(next);
  };
  const save = async () => {
    setSaving(true);
    try {
      await api.post(`/api/workspaces/${workspaceId}/prep/save`, { source: source.trim(), steps: ready, name: name.trim(), as, replace });
      toast.success(`Saved ${as === 'view' ? 'the view' : 'the table'} ${name.trim()}`);
      void ws.loadCatalog(true);
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setSaving(false);
    }
  };
  const openSql = () => {
    if (!preview) return;
    void ws.addTab({ title: `Prepared ${source.trim()}`, sql: preview.sql });
    location.hash = '#/query';
  };

  const colPicker = (d: Draft, label = 'Column') => (
    <Field label={label} htmlFor={`prep-col-${d.id}`}>
      <Input id={`prep-col-${d.id}`} list="prep-columns" value={d.column} onChange={(e) => patch(d.id, { column: e.target.value })} className="font-mono" uiSize="sm" data-testid="prep-column" />
    </Field>
  );
  const editor = (d: Draft) => {
    switch (d.op) {
      case 'filter': return <Field label="Keep rows where" hint="A SQL condition, such as amount > 0 AND country = 'PT'" htmlFor={`prep-v-${d.id}`}><Input id={`prep-v-${d.id}`} value={d.value} onChange={(e) => patch(d.id, { value: e.target.value })} className="font-mono" uiSize="sm" data-testid="prep-value" /></Field>;
      case 'keep': case 'drop': return <Field label="Columns" hint="Separated by commas" htmlFor={`prep-cols-${d.id}`}><Input id={`prep-cols-${d.id}`} list="prep-columns" value={d.columns} onChange={(e) => patch(d.id, { columns: e.target.value })} className="font-mono" uiSize="sm" data-testid="prep-columns" /></Field>;
      case 'rename': return <div className="grid grid-cols-2 gap-2">{colPicker(d)}<Field label="New name" htmlFor={`prep-v-${d.id}`}><Input id={`prep-v-${d.id}`} value={d.value} onChange={(e) => patch(d.id, { value: e.target.value })} className="font-mono" uiSize="sm" data-testid="prep-value" /></Field></div>;
      case 'cast': return <div className="grid grid-cols-2 gap-2">{colPicker(d)}<Field label="Type" htmlFor={`prep-v-${d.id}`}><Input id={`prep-v-${d.id}`} list="prep-types" value={d.value} onChange={(e) => patch(d.id, { value: e.target.value })} className="font-mono" uiSize="sm" data-testid="prep-value" /></Field></div>;
      case 'fill': return <div className="grid grid-cols-2 gap-2">{colPicker(d)}<Field label="With" htmlFor={`prep-v-${d.id}`}><Input id={`prep-v-${d.id}`} value={d.value} onChange={(e) => patch(d.id, { value: e.target.value })} uiSize="sm" data-testid="prep-value" /></Field></div>;
      case 'text': return <div className="grid grid-cols-2 gap-2">{colPicker(d)}<Field label="Change" htmlFor={`prep-v-${d.id}`}><Select id={`prep-v-${d.id}`} uiSize="sm" value={d.value} onChange={(e) => patch(d.id, { value: e.target.value })} data-testid="prep-fn">{TEXT_FNS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Field></div>;
      case 'replace': return <div className="grid grid-cols-3 gap-2">{colPicker(d)}<Field label="Find" htmlFor={`prep-v-${d.id}`}><Input id={`prep-v-${d.id}`} value={d.value} onChange={(e) => patch(d.id, { value: e.target.value })} uiSize="sm" data-testid="prep-value" /></Field><Field label="Replace with" htmlFor={`prep-w-${d.id}`}><Input id={`prep-w-${d.id}`} value={d.value2} onChange={(e) => patch(d.id, { value2: e.target.value })} uiSize="sm" /></Field></div>;
      case 'derive': return <div className="grid grid-cols-[1fr_2fr] gap-2"><Field label="Name" htmlFor={`prep-v-${d.id}`}><Input id={`prep-v-${d.id}`} value={d.value} onChange={(e) => patch(d.id, { value: e.target.value })} className="font-mono" uiSize="sm" data-testid="prep-value" /></Field><Field label="Expression" htmlFor={`prep-w-${d.id}`}><Input id={`prep-w-${d.id}`} value={d.value2} onChange={(e) => patch(d.id, { value2: e.target.value })} className="font-mono" uiSize="sm" placeholder="amount * 1.23" data-testid="prep-expression" /></Field></div>;
      case 'split': return <div className="grid grid-cols-3 gap-2">{colPicker(d)}<Field label="On" htmlFor={`prep-v-${d.id}`}><Input id={`prep-v-${d.id}`} value={d.value} onChange={(e) => patch(d.id, { value: e.target.value })} className="font-mono" uiSize="sm" placeholder=", " data-testid="prep-value" /></Field><Field label="Into" hint="New names, by commas" htmlFor={`prep-w-${d.id}`}><Input id={`prep-w-${d.id}`} value={d.value2} onChange={(e) => patch(d.id, { value2: e.target.value })} className="font-mono" uiSize="sm" data-testid="prep-into" /></Field></div>;
      case 'parse_date': return <div className="grid grid-cols-2 gap-2">{colPicker(d)}<Field label="Format" hint="%d day, %m month, %Y year, %H:%M time" htmlFor={`prep-v-${d.id}`}><Input id={`prep-v-${d.id}`} value={d.value} onChange={(e) => patch(d.id, { value: e.target.value })} className="font-mono" uiSize="sm" data-testid="prep-value" /></Field></div>;
      case 'dedupe': return <Field label="Rows are duplicates when these match" hint="Leave empty to compare whole rows; the first row of each is kept" htmlFor={`prep-cols-${d.id}`}><Input id={`prep-cols-${d.id}`} list="prep-columns" value={d.columns} onChange={(e) => patch(d.id, { columns: e.target.value })} className="font-mono" uiSize="sm" data-testid="prep-columns" /></Field>;
      case 'sort': return <div className="flex items-end gap-3"><div className="flex-1">{colPicker(d)}</div><Checkbox label="Largest first" checked={d.desc} onChange={(e) => patch(d.id, { desc: e.target.checked })} className="pb-1.5" /></div>;
    }
  };

  const rowsAfter = (i: number) => preview?.step_rows[i];
  const rowsBefore = (i: number) => (i === 0 ? preview?.source_rows : preview?.step_rows[i - 1]);
  const nameOk = /^[A-Za-z_][\w]*(\.[A-Za-z_][\w]*)?$/.test(name.trim());

  return (
    <div className="space-y-5" data-testid="prepare-page">
      <PageHeader title="Prepare" description="Clean and reshape a table step by step, then save the result as a view, a table or a dbt model." />
      <datalist id="prep-columns">{columnNames.map((c) => <option key={c} value={c} />)}</datalist>
      <datalist id="prep-types">{['INTEGER', 'BIGINT', 'DOUBLE', 'DECIMAL(18, 2)', 'VARCHAR', 'DATE', 'TIMESTAMP', 'BOOLEAN'].map((t) => <option key={t} value={t} />)}</datalist>
      <datalist id="prep-datasets">{datasets.map((d) => <option key={d} value={d} />)}</datalist>
      <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
        <section className="w-full shrink-0 space-y-4 lg:w-[400px]" aria-label="Recipe">
          <Field label="Start from" hint="A table, a view, or a file path in quotes" htmlFor="prep-source">
            <Input id="prep-source" list="prep-datasets" value={source} onChange={(e) => setSource(e.target.value)} placeholder="orders" className="font-mono" data-testid="prep-source" />
          </Field>
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <h2 className="text-body font-semibold text-zinc-100">Steps</h2>
              {preview && <span className="text-2xs tabular-nums text-zinc-500">{preview.source_rows.toLocaleString()} rows to start</span>}
            </div>
            {steps.length === 0 ? (
              <p className="border-y border-zinc-800 py-4 text-xs text-zinc-500">No steps yet. Add one to filter rows, fix types, clean text or remove duplicates.</p>
            ) : (
              <ol className="divide-y divide-zinc-800/70 border-y border-zinc-800" data-testid="prep-steps">
                {steps.map((d, i) => {
                  const b = built[i];
                  const blocked = firstIncomplete !== -1 && i > firstIncomplete;
                  const after = rowsAfter(i);
                  const before = rowsBefore(i);
                  const sentence = typeof b === 'string' ? OPS.find((o) => o.op === d.op)!.label : (preview?.steps[i] ?? OPS.find((o) => o.op === d.op)!.label);
                  return (
                    <li key={d.id} className="py-2" data-testid="prep-step" data-op={d.op}>
                      <div className="flex items-center gap-2">
                        <span className="w-5 shrink-0 text-right text-2xs tabular-nums text-zinc-500">{i + 1}</span>
                        <button className={cn('min-w-0 flex-1 truncate text-left text-xs', open === d.id ? 'text-zinc-50' : 'text-zinc-300 hover:text-zinc-100')} onClick={() => setOpen(open === d.id ? null : d.id)} aria-expanded={open === d.id} title={sentence}>{sentence}</button>
                        <span className="shrink-0 text-2xs tabular-nums text-zinc-500" data-testid="prep-step-rows">
                          {typeof b === 'string' ? <span className="text-amber-400">{b}</span> : blocked ? 'waiting' : after != null ? <>{after.toLocaleString()} rows{before != null && after !== before ? <span className="text-zinc-400"> ({after - before > 0 ? '+' : '−'}{Math.abs(after - before).toLocaleString()})</span> : null}</> : ''}
                        </span>
                        <IconButton label={`Move step ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp className="h-3.5 w-3.5" /></IconButton>
                        <IconButton label={`Move step ${i + 1} down`} disabled={i === steps.length - 1} onClick={() => move(i, 1)}><ArrowDown className="h-3.5 w-3.5" /></IconButton>
                        <IconButton label={`Remove step ${i + 1}`} onClick={() => setSteps(steps.filter((s) => s.id !== d.id))}><Trash2 className="h-3.5 w-3.5" /></IconButton>
                      </div>
                      {open === d.id && <div className="ml-7 mt-2 space-y-2">{editor(d)}</div>}
                    </li>
                  );
                })}
              </ol>
            )}
            <Menu align="left" width="w-64" trigger={(_, toggle) => <Button size="sm" variant="ghost" className="mt-2" onClick={toggle} disabled={!source.trim()} data-testid="prep-add"><Plus className="h-3.5 w-3.5" /> Add a step</Button>}>
              {(close) => OPS.map((o) => <MenuItem key={o.op} onClick={() => { close(); add(o.op); }} hint={o.hint || undefined}>{o.label}</MenuItem>)}
            </Menu>
          </div>
          <div className="space-y-2 border-t border-zinc-800 pt-4">
            <h2 className="text-body font-semibold text-zinc-100">Save the result</h2>
            <div className="flex gap-2">
              <Input aria-label="Name of the result" value={name} onChange={(e) => setName(e.target.value)} placeholder="orders_clean" className="min-w-0 flex-1 font-mono" data-testid="prep-name" />
              <Select aria-label="Save as" value={as} onChange={(e) => setAs(e.target.value as 'view' | 'table')} data-testid="prep-as"><option value="view">as a view</option><option value="table">as a table</option></Select>
            </div>
            <Checkbox label="Replace it if it exists" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
            <p className="text-2xs text-zinc-500">{as === 'view' ? 'A view runs the recipe each time it is read, so it follows the source.' : 'A table is a copy of the result now; save again to refresh it.'}</p>
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" onClick={() => void save()} loading={saving} disabled={!preview || !nameOk || firstIncomplete !== -1} title={!nameOk ? 'Name it with letters, digits and underscores' : firstIncomplete !== -1 ? 'Finish or remove the incomplete step' : undefined} data-testid="prep-save"><Save className="h-3.5 w-3.5" /> Save</Button>
              <Button onClick={() => preview && setDbtSql(`-- dbt model: models/staging/${nameOk ? name.trim() : 'prepared'}.sql\n${preview.sql}`)} disabled={!preview || firstIncomplete !== -1}><Workflow className="h-3.5 w-3.5" /> Save as dbt model…</Button>
              <Button variant="ghost" onClick={openSql} disabled={!preview} data-testid="prep-open-sql"><SquareTerminal className="h-3.5 w-3.5" /> Open in SQL</Button>
            </div>
          </div>
        </section>
        <section className="min-w-0 flex-1 space-y-3" aria-label="Preview">
          {!source.trim() ? (
            <div className="border-y border-zinc-800 py-12"><Empty icon={<Wand2 className="h-10 w-10" />} title="Choose a table to prepare" hint="Pick a table, a view or a file. Each step you add shows its effect here straight away." /></div>
          ) : error ? (
            <InlineError error={error} title="The recipe could not run" />
          ) : !preview ? (
            <Skeleton className="h-64 w-full" />
          ) : (
            <>
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-body font-semibold text-zinc-100">Result</h2>
                <span className={cn('text-2xs tabular-nums text-zinc-500', loading && 'opacity-60')} data-testid="prep-result-count">{(preview.step_rows.at(-1) ?? preview.source_rows).toLocaleString()} rows · {preview.columns.length} columns{preview.rows.length < (preview.step_rows.at(-1) ?? preview.source_rows) ? ` · first ${preview.rows.length} shown` : ''}</span>
              </div>
              <ResultPreview columns={preview.columns.map((c) => ({ name: c.name, type: c.type }))} rows={preview.rows} showTypes maxHeight="max-h-[60vh]" testid="prep-preview" label="Prepared rows" />
              <details className="text-xs">
                <summary className="cursor-pointer text-zinc-400 hover:text-zinc-200">The SQL</summary>
                <pre className="mt-2 overflow-auto rounded-md border border-zinc-800 bg-zinc-900/60 p-3 font-mono text-2xs text-zinc-300" data-testid="prep-sql">{preview.sql}</pre>
              </details>
            </>
          )}
        </section>
      </div>
      {dbtSql !== null && <SaveDbtModelDialog workspaceId={workspaceId} sql={dbtSql} suggestedName={name} onClose={() => setDbtSql(null)} />}
    </div>
  );
}
