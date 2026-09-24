import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Download, PackagePlus, Search, Trash2, Upload, X } from 'lucide-react';
import { api, authedBlobUrl, timeAgo } from '../../api/client';
import { Badge, Button, Drawer, Input, Label, Modal, Select, cn, InlineError } from '../../components/ui';
import { useAuth } from '../../store/auth';
import { useWorkspace, useWorkspaceAccess } from '../../store/workspace';

interface Contents { tables: string[]; queries: number; dashboards: number; notebooks: number; metrics: number; quality: number; sample_data: boolean }
interface Template { id: string; name: string; description: string | null; category: string; tags: string[]; source: 'builtin' | 'organisation'; status: 'private' | 'pending' | 'published'; author: string | null; author_id: string | null; installs: number; contents: Contents; updated_at: string | null }
interface Body {
  tables: { name: string; description?: string | null; columns: { name: string; type: string }[]; sample_sql?: string | null }[];
  queries: { key: string; name: string }[];
  dashboards: { name: string; widgets: { title: string }[] }[];
  notebooks: { title: string }[];
  semantic?: string | null;
  quality: { name: string; checks: unknown[] }[];
}
interface TableCheck { name: string; target: string; exists: boolean; missing_columns: string[]; has_sample: boolean }
interface Install { id: string; template_id: string; template_name: string; created_at: string; objects: { queries: string[]; dashboards: string[]; notebooks: string[]; quality: string[]; tables: string[]; semantic: boolean } }

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
function summary(c: Contents): string {
  return [c.dashboards && plural(c.dashboards, 'dashboard'), c.queries && plural(c.queries, 'query').replace('querys', 'queries'), c.notebooks && plural(c.notebooks, 'notebook'), c.metrics && plural(c.metrics, 'metric'), c.quality && plural(c.quality, 'quality suite')].filter(Boolean).join(', ');
}

/** Templates: ready-made dashboards, queries, notebooks, metrics and checks, installed into the workspace. */
export function TemplatesPage() {
  const ws = useWorkspace();
  const access = useWorkspaceAccess();
  const isAdmin = useAuth((a) => a.user?.role === 'ADMIN');
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [installs, setInstalls] = useState<Install[]>([]);
  const [q, setQ] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = () => {
    void api.get<{ templates: Template[] }>('/api/templates').then((r) => setTemplates(r.templates)).catch(() => setTemplates([]));
    if (ws.activeId) void api.get<{ installs: Install[] }>(`/api/workspaces/${ws.activeId}/template-installs`).then((r) => setInstalls(r.installs)).catch(() => setInstalls([]));
  };
  useEffect(load, [ws.activeId]); // eslint-disable-line react-hooks/exhaustive-deps

  const categories = useMemo(() => [...new Set((templates ?? []).map((t) => t.category))].sort(), [templates]);
  const shown = (templates ?? []).filter((t) => (!category || t.category === category) && (!q.trim() || q.toLowerCase().split(/\s+/).every((w) => `${t.name} ${t.description ?? ''} ${t.category} ${t.tags.join(' ')}`.toLowerCase().includes(w))));
  const waiting = shown.filter((t) => t.status === 'pending');

  const importFile = async (file: File) => {
    try {
      const r = await api.post<{ template: Template }>('/api/templates/import', JSON.parse(await file.text()));
      setMessage(`Imported "${r.template.name}" as a private template.`);
      load();
    } catch (e) {
      setMessage(`Could not import: ${(e as Error).message}`);
    }
  };

  return (
    <div className="h-full overflow-auto" data-testid="templates-page">
      <div className="mx-auto max-w-6xl space-y-5 px-6 py-5">
        <div className="flex flex-wrap items-end gap-3">
          <div className="mr-auto">
            <h1 className="text-page font-semibold text-zinc-50">Templates</h1>
            <p className="text-xs text-zinc-500">Dashboards, queries, notebooks, metrics and quality checks for a subject, installed into {ws.workspaces.find((w) => w.id === ws.activeId)?.name ?? 'this workspace'} in one step.</p>
          </div>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
            <Input uiSize="sm" className="w-56 pl-7" placeholder="Search templates" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search templates" />
          </div>
          <input ref={fileRef} type="file" accept=".json,application/json" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) void importFile(f); e.target.value = ''; }} />
          <Button size="sm" onClick={() => fileRef.current?.click()}><Upload className="h-3.5 w-3.5" /> Import</Button>
          <Button size="sm" variant="primary" disabled={!access.canEdit} onClick={() => setPublishing(true)}><PackagePlus className="h-3.5 w-3.5" /> Publish from this workspace</Button>
        </div>
        {message && <p className="flex items-center gap-2 text-xs text-zinc-300">{message}<button aria-label="Dismiss" onClick={() => setMessage(null)}><X className="h-3 w-3 text-zinc-500" /></button></p>}

        <div className="flex flex-wrap gap-1.5 text-xs">
          {[null, ...categories].map((c) => (
            <button key={c ?? 'all'} onClick={() => setCategory(c)} className={cn('rounded-full border px-2.5 py-0.5', category === c ? 'border-zinc-500 bg-zinc-800 text-zinc-50' : 'border-zinc-800 text-zinc-400 hover:text-zinc-200')}>{c ?? 'All'}</button>
          ))}
        </div>

        {isAdmin && waiting.length > 0 && <p className="text-xs text-amber-300">{plural(waiting.length, 'template')} waiting for your review.</p>}

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" data-testid="template-grid">
          {shown.map((t) => (
            <button key={t.id} data-template={t.name} onClick={() => setOpen(t.id)} className="flex flex-col rounded-lg border border-zinc-800 p-4 text-left transition-colors hover:border-zinc-600 hover:bg-zinc-900/60">
              <div className="flex items-start gap-2">
                <span className="text-body font-medium text-zinc-100">{t.name}</span>
                {t.status !== 'published' && <Badge tone={t.status === 'pending' ? 'amber' : 'zinc'} className="ml-auto">{t.status === 'pending' ? 'In review' : 'Private'}</Badge>}
              </div>
              <div className="mt-0.5 text-2xs text-zinc-500">{t.category} · {t.source === 'builtin' ? 'DuckView' : t.author ?? 'someone'}{t.installs ? ` · ${plural(t.installs, 'install')}` : ''}</div>
              <p className="mt-2 line-clamp-3 flex-1 text-xs text-zinc-400">{t.description}</p>
              <div className="mt-3 text-2xs text-zinc-500">{summary(t.contents)}</div>
              <div className="mt-1 flex flex-wrap gap-1">
                {t.contents.tables.map((x) => <code key={x} className="rounded bg-zinc-900 px-1 py-px font-mono text-2xs text-zinc-400">{x}</code>)}
              </div>
            </button>
          ))}
          {templates && shown.length === 0 && <p className="text-xs text-zinc-500">No templates match.</p>}
        </div>

        {installs.length > 0 && (
          <section data-testid="template-installs">
            <h2 className="mb-1.5 text-body font-semibold text-zinc-100">Installed in this workspace</h2>
            <ul className="divide-y divide-zinc-800/70 border-y border-zinc-800 text-xs">
              {installs.map((i) => (
                <li key={i.id} className="flex items-center gap-3 py-2">
                  <span className="text-zinc-200">{i.template_name}</span>
                  <span className="text-zinc-500">{[plural(i.objects.dashboards.length, 'dashboard'), plural(i.objects.queries.length, 'query').replace('querys', 'queries'), i.objects.tables.length ? `sample tables ${i.objects.tables.join(', ')}` : null].filter(Boolean).join(' · ')} · {timeAgo(i.created_at)}</span>
                  {access.canEdit && (
                    <Button size="sm" className="ml-auto" onClick={async () => {
                      await api.del(`/api/template-installs/${i.id}${i.objects.tables.length ? '?drop_tables=1' : ''}`);
                      setMessage(`Removed ${i.template_name}${i.objects.tables.length ? ' and its sample tables' : ''}.`);
                      load();
                      void ws.loadCatalog();
                    }}><Trash2 className="h-3.5 w-3.5" /> Remove</Button>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
      {open && <TemplateDrawer id={open} onClose={() => setOpen(null)} onChanged={(msg) => { if (msg) setMessage(msg); load(); }} />}
      {publishing && ws.activeId && <PublishModal workspaceId={ws.activeId} onClose={() => setPublishing(false)} onDone={(t) => { setPublishing(false); setMessage(t.status === 'pending' ? `"${t.name}" is waiting for an administrator's review.` : `Published "${t.name}".`); load(); }} />}
    </div>
  );
}

function TemplateDrawer({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: (message?: string) => void }) {
  const ws = useWorkspace();
  const access = useWorkspaceAccess();
  const auth = useAuth();
  const isAdmin = auth.user?.role === 'ADMIN';
  const [t, setT] = useState<(Template & { body: Body }) | null>(null);
  const [map, setMap] = useState<Record<string, string>>({});
  const [checks, setChecks] = useState<TableCheck[]>([]);
  const [sample, setSample] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ dashboards: string[] } | null>(null);
  const tables = (ws.catalog?.objects ?? []).map((o) => (o.schema === 'main' ? o.name : `${o.schema}.${o.name}`));

  useEffect(() => {
    void api.get<{ template: Template & { body: Body } }>(`/api/templates/${encodeURIComponent(id)}`).then((r) => setT(r.template));
    if (!ws.catalog) void ws.loadCatalog();
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!t || !ws.activeId) return;
    const h = setTimeout(() => void api.post<{ tables: TableCheck[] }>(`/api/templates/${encodeURIComponent(id)}/check`, { workspace_id: ws.activeId, table_map: map }).then((r) => setChecks(r.tables)).catch(() => setChecks([])), 250);
    return () => clearTimeout(h);
  }, [t, map, ws.activeId, id]);

  const blocked = checks.some((c) => (c.exists ? c.missing_columns.length > 0 : !(sample && c.has_sample)));
  const install = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ created: { dashboards: string[]; tables: string[] } }>(`/api/templates/${encodeURIComponent(id)}/install`, { workspace_id: ws.activeId, table_map: map, sample_data: sample });
      setDone(r.created);
      onChanged();
      if (r.created.tables.length) void ws.loadCatalog();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const exportFile = async () => {
    const url = await authedBlobUrl(`/api/templates/${encodeURIComponent(id)}/export`);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${t!.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.duckview-template.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Drawer open onClose={onClose} title={t?.name ?? 'Template'} width="w-[520px]">
      {!t ? null : (
        <div className="space-y-5 text-xs" data-testid="template-drawer">
          <div>
            <div className="text-zinc-500">{t.category} · {t.source === 'builtin' ? 'Built into DuckView' : `Published by ${t.author ?? 'someone'}`}</div>
            <p className="mt-2 text-zinc-300">{t.description}</p>
          </div>

          <section>
            <h3 className="mb-1 font-medium text-zinc-100">What it adds</h3>
            <ul className="space-y-0.5 text-zinc-400">
              {t.body.dashboards.map((d) => <li key={d.name}>Dashboard <span className="text-zinc-200">{d.name}</span> · {plural(d.widgets.length, 'widget')}</li>)}
              {t.body.queries.length > 0 && <li>{plural(t.body.queries.length, 'saved query').replace('querys', 'queries')}: {t.body.queries.map((x) => x.name).join(', ')}</li>}
              {t.body.notebooks.map((n) => <li key={n.title}>Notebook <span className="text-zinc-200">{n.title}</span></li>)}
              {t.contents.metrics > 0 && <li>{plural(t.contents.metrics, 'metric')} in the semantic layer</li>}
              {t.body.quality.map((s) => <li key={s.name}>Quality suite <span className="text-zinc-200">{s.name}</span> · {plural(s.checks.length, 'check')}</li>)}
            </ul>
          </section>

          {done ? (
            <section className="space-y-2" data-testid="template-installed">
              <p className="flex items-center gap-1.5 text-emerald-300"><Check className="h-3.5 w-3.5" /> Installed.</p>
              {done.dashboards[0] && <Button size="sm" variant="primary" onClick={() => { location.hash = `#/dashboards/${done.dashboards[0]}`; onClose(); }}>Open the dashboard</Button>}
            </section>
          ) : (
            <section>
              <h3 className="mb-1 font-medium text-zinc-100">Your tables</h3>
              <p className="mb-2 text-zinc-500">Choose the table of this workspace each one reads. Tables it needs but can't find are created with sample data.</p>
              <div className="space-y-2">
                {t.body.tables.map((tbl) => {
                  const c = checks.find((x) => x.name === tbl.name);
                  return (
                    <div key={tbl.name} data-table={tbl.name}>
                      <div className="flex items-center gap-2">
                        <code className="w-28 shrink-0 truncate font-mono text-zinc-300">{tbl.name}</code>
                        <Select uiSize="sm" value={map[tbl.name] ?? ''} onChange={(e) => setMap((m) => ({ ...m, [tbl.name]: e.target.value }))} aria-label={`Table for ${tbl.name}`}>
                          <option value="">{tables.includes(tbl.name) ? tbl.name : `${tbl.name} (new, sample data)`}</option>
                          {tables.filter((x) => x !== tbl.name).map((x) => <option key={x} value={x}>{x}</option>)}
                        </Select>
                      </div>
                      <div className={cn('mt-0.5 pl-[7.5rem]', !c ? 'text-zinc-600' : c.exists && !c.missing_columns.length ? 'text-emerald-300' : c.exists ? 'text-red-300' : sample && c.has_sample ? 'text-zinc-400' : 'text-red-300')}>
                        {!c ? 'Checking…' : c.exists ? (c.missing_columns.length ? `Missing ${c.missing_columns.join(', ')}` : 'Has every column it uses') : c.has_sample ? (sample ? `Will be created with sample data` : 'Not in this workspace') : 'Not in this workspace'}
                      </div>
                      <div className="pl-[7.5rem] text-2xs text-zinc-600">{tbl.columns.map((x) => x.name).join(', ')}</div>
                    </div>
                  );
                })}
              </div>
              {t.contents.sample_data && <label className="mt-3 flex items-center gap-2 text-zinc-300"><input type="checkbox" checked={sample} onChange={(e) => setSample(e.target.checked)} /> Create sample data for tables that aren't there</label>}
              <InlineError error={error} className="mt-2" />
              <div className="mt-3">
                <Button variant="primary" loading={busy} disabled={!access.canEdit || blocked || !checks.length} onClick={() => void install()}>Install into {ws.workspaces.find((w) => w.id === ws.activeId)?.name ?? 'this workspace'}</Button>
                {!access.canEdit && <p className="mt-1 text-zinc-500">Viewers can't install templates.</p>}
              </div>
            </section>
          )}

          <div className="flex flex-wrap gap-2 border-t border-zinc-800 pt-3">
            <Button size="sm" onClick={() => void exportFile()}><Download className="h-3.5 w-3.5" /> Export</Button>
            {isAdmin && t.status === 'pending' && (
              <>
                <Button size="sm" variant="primary" onClick={async () => { await api.post(`/api/templates/${t.id}/review`, { approve: true }); onChanged(`Published "${t.name}" for everyone.`); onClose(); }}>Approve</Button>
                <Button size="sm" onClick={async () => { await api.post(`/api/templates/${t.id}/review`, { approve: false }); onChanged(`Sent "${t.name}" back to its author.`); onClose(); }}>Send back</Button>
              </>
            )}
            {t.source === 'organisation' && (t.author_id === auth.user?.id || isAdmin) && (
              <Button size="sm" className="ml-auto" onClick={async () => { await api.del(`/api/templates/${t.id}`); onChanged(`Deleted "${t.name}".`); onClose(); }}><Trash2 className="h-3.5 w-3.5" /> Delete</Button>
            )}
          </div>
        </div>
      )}
    </Drawer>
  );
}

function PublishModal({ workspaceId, onClose, onDone }: { workspaceId: string; onClose: () => void; onDone: (t: Template) => void }) {
  const isAdmin = useAuth((a) => a.user?.role === 'ADMIN');
  const [items, setItems] = useState<{ dashboards: { id: string; name: string; kind: string }[]; queries: { id: string; name: string }[]; notebooks: { id: string; title: string }[]; suites: { id: string; name: string }[]; metrics: number }>({ dashboards: [], queries: [], notebooks: [], suites: [], metrics: 0 });
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [semantic, setSemantic] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('');
  const [rows, setRows] = useState('100');
  const [visibility, setVisibility] = useState<'private' | 'org'>('org');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const get = <T,>(url: string, fallback: T) => api.get<T>(url).catch(() => fallback);
    void Promise.all([
      get<{ dashboards: { id: string; name: string; kind: string }[] }>(`/api/workspaces/${workspaceId}/dashboards`, { dashboards: [] }),
      get<{ queries: { id: string; name: string }[] }>(`/api/workspaces/${workspaceId}/queries`, { queries: [] }),
      get<{ notebooks: { id: string; title: string }[] }>(`/api/workspaces/${workspaceId}/notebooks`, { notebooks: [] }),
      get<{ suites: { id: string; name: string }[] }>(`/api/workspaces/${workspaceId}/quality/suites`, { suites: [] }),
      get<{ metrics: unknown[] }>(`/api/workspaces/${workspaceId}/semantic`, { metrics: [] }),
    ]).then(([d, q, n, s, m]) => setItems({ dashboards: d.dashboards.filter((x) => x.kind === 'grid'), queries: q.queries, notebooks: n.notebooks, suites: s.suites, metrics: m.metrics?.length ?? 0 }));
  }, [workspaceId]);

  const ids = (prefix: string) => Object.keys(picked).filter((k) => picked[k] && k.startsWith(prefix)).map((k) => k.slice(prefix.length));
  const count = Object.values(picked).filter(Boolean).length + (semantic ? 1 : 0);
  const publish = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ template: Template }>('/api/templates', { workspace_id: workspaceId, name, description: description || null, category: category || null, dashboard_ids: ids('d:'), query_ids: ids('q:'), notebook_ids: ids('n:'), quality_ids: ids('s:'), semantic, sample_rows: Number(rows) || 0, visibility });
      onDone(r.template);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const Group = ({ title, prefix, list }: { title: string; prefix: string; list: { id: string; label: string }[] }) =>
    list.length === 0 ? null : (
      <div>
        <div className="mb-0.5 text-zinc-500">{title}</div>
        {list.map((x) => (
          <label key={x.id} className="flex items-center gap-2 py-0.5 text-zinc-300">
            <input type="checkbox" checked={!!picked[prefix + x.id]} onChange={(e) => setPicked((p) => ({ ...p, [prefix + x.id]: e.target.checked }))} /> {x.label}
          </label>
        ))}
      </div>
    );

  return (
    <Modal open onClose={onClose} title="Publish a template" width="max-w-xl">
      <div className="space-y-3 text-xs" data-testid="publish-template">
        <p className="text-zinc-400">Package what you built here so others can install it on their own tables. The tables it reads become ones each installer chooses.</p>
        <div className="grid max-h-56 grid-cols-2 gap-3 overflow-auto rounded-md border border-zinc-800 p-3">
          <Group title="Dashboards" prefix="d:" list={items.dashboards.map((x) => ({ id: x.id, label: x.name }))} />
          <Group title="Saved queries" prefix="q:" list={items.queries.map((x) => ({ id: x.id, label: x.name }))} />
          <Group title="Notebooks" prefix="n:" list={items.notebooks.map((x) => ({ id: x.id, label: x.title }))} />
          <Group title="Quality suites" prefix="s:" list={items.suites.map((x) => ({ id: x.id, label: x.name }))} />
          {items.metrics > 0 && <label className="flex items-center gap-2 text-zinc-300"><input type="checkbox" checked={semantic} onChange={(e) => setSemantic(e.target.checked)} /> Metrics ({items.metrics})</label>}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div><Label>Name</Label><Input name="template-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Incident tracking" /></div>
          <div><Label>Category</Label><Input name="template-category" value={category} onChange={(e) => setCategory(e.target.value)} placeholder="Operations" /></div>
        </div>
        <div><Label>Description</Label><Input name="template-description" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What it shows, and for whom" /></div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label>Sample rows per table</Label>
            <Input name="template-rows" type="number" min="0" max="500" value={rows} onChange={(e) => setRows(e.target.value)} />
          </div>
          <div>
            <Label>Who can install it</Label>
            <Select value={visibility} onChange={(e) => setVisibility(e.target.value as 'private' | 'org')}>
              <option value="org">Everyone{isAdmin ? '' : ' (after review)'}</option>
              <option value="private">Only me</option>
            </Select>
          </div>
        </div>
        <InlineError error={error} />
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!name.trim() || count === 0} onClick={() => void publish()}>Publish</Button>
        </div>
      </div>
    </Modal>
  );
}
