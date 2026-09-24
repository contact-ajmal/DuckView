import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, FileCode2, FlaskConical, MoreHorizontal, Pencil, Play, Plus, ShieldCheck, Sparkles, Trash2, X } from 'lucide-react';
import { api, timeAgo, type DbtTestSummary, type NotificationChannel, type QualityCheck, type QualityCheckResult, type QualityCheckType, type QualityOutcome, type QualityRun, type QualityStatus, type QualitySuite, type SyncSchedule } from '../../api/client';
import { useWorkspace, useWorkspaceAccess } from '../../store/workspace';
import { subscribeLiveEvents } from '../../lib/liveEvents';
import { Button, Empty, IconButton, Input, Label, Menu, MenuDivider, MenuItem, Modal, Select, StatusDot, cn, confirmAction } from '../../components/ui';
import { PageHeader } from '../../components/layout';
import { CHANNEL_META } from '../alerts/ChannelsPanel';

const TONE: Record<QualityStatus, 'ok' | 'warn' | 'error' | 'idle'> = { unknown: 'idle', pass: 'ok', warn: 'warn', fail: 'error', error: 'error' };
const STATUS_TEXT: Record<QualityStatus, string> = { unknown: 'Not run', pass: 'Passing', warn: 'Warning', fail: 'Failing', error: 'Could not run' };
const DBT_TONE = (s: string) => (s === 'pass' ? 'ok' : s === 'warn' ? 'warn' : s === 'skipped' ? 'idle' : 'error');

const TYPES: { id: QualityCheckType; label: string; hint: string }[] = [
  { id: 'not_null', label: 'Not null', hint: 'The column has no nulls' },
  { id: 'unique', label: 'Unique', hint: 'No value appears twice' },
  { id: 'accepted_values', label: 'Accepted values', hint: 'Only these values appear' },
  { id: 'range', label: 'Range', hint: 'Values stay between a minimum and a maximum' },
  { id: 'relationships', label: 'Exists in', hint: 'Every value exists in another table' },
  { id: 'expression', label: 'Condition', hint: 'Every row satisfies a SQL condition' },
  { id: 'row_count', label: 'Row count', hint: 'The table has between min and max rows' },
  { id: 'freshness', label: 'Freshness', hint: 'The newest value is recent enough' },
  { id: 'custom_sql', label: 'Custom SQL', hint: 'A SELECT that returns the failing rows' },
];
const typeLabel = (t: QualityCheckType) => TYPES.find((x) => x.id === t)?.label ?? t;
const every = (s: SyncSchedule) => (s.kind === 'interval' ? (s.minutes % 60 === 0 ? `Every ${s.minutes / 60} h` : `Every ${s.minutes} min`) : s.kind === 'cron' ? `Cron ${s.expression}` : 'Run by hand');

/** A check being edited: numbers and lists as text until saved. */
interface DraftCheck { id: string; type: QualityCheckType; column: string; values: string; min: string; max: string; to: string; to_column: string; expression: string; sql: string; max_age_hours: string; where: string; severity: 'warn' | 'error'; tolerance: string; description: string; open: boolean }
interface Draft { id: string | null; name: string; relation: string; description: string; checks: DraftCheck[]; scheduleKind: 'manual' | 'interval' | 'cron'; minutes: string; cron: string; channel_ids: string[] }

const toDraftCheck = (c: Partial<QualityCheck> & { type: QualityCheckType }): DraftCheck => ({ id: c.id ?? Math.random().toString(36).slice(2, 10), type: c.type, column: c.column ?? '', values: (c.values ?? []).map(String).join(', '), min: c.min == null ? '' : String(c.min), max: c.max == null ? '' : String(c.max), to: c.to ?? '', to_column: c.to_column ?? '', expression: c.expression ?? '', sql: c.sql ?? '', max_age_hours: c.max_age_hours == null ? '24' : String(c.max_age_hours), where: c.where ?? '', severity: c.severity ?? 'error', tolerance: c.tolerance ? String(c.tolerance) : '', description: c.description ?? '', open: false });
const fromDraftCheck = (d: DraftCheck, numericValues: boolean): Partial<QualityCheck> => {
  const num = (v: string) => (v.trim() === '' ? null : Number(v));
  const values = d.values.split(',').map((v) => v.trim()).filter(Boolean);
  return {
    id: d.id, type: d.type, severity: d.severity, where: d.where.trim() || null, tolerance: Number(d.tolerance) || 0, description: d.description.trim() || null,
    ...(['not_null', 'unique', 'accepted_values', 'range', 'relationships', 'freshness'].includes(d.type) ? { column: d.column.trim() } : {}),
    ...(d.type === 'accepted_values' ? { values: numericValues && values.every((v) => Number.isFinite(Number(v))) ? values.map(Number) : values } : {}),
    ...(d.type === 'range' || d.type === 'row_count' ? { min: num(d.min), max: num(d.max) } : {}),
    ...(d.type === 'relationships' ? { to: d.to.trim(), to_column: d.to_column.trim() } : {}),
    ...(d.type === 'expression' ? { expression: d.expression } : {}),
    ...(d.type === 'custom_sql' ? { sql: d.sql } : {}),
    ...(d.type === 'freshness' ? { max_age_hours: Number(d.max_age_hours) } : {}),
  };
};
const blank = (relation = ''): Draft => ({ id: null, name: '', relation, description: '', checks: [], scheduleKind: 'manual', minutes: '60', cron: '0 7 * * *', channel_ids: [] });
const fromSuite = (s: QualitySuite): Draft => ({ id: s.id, name: s.name, relation: s.relation, description: s.description ?? '', checks: s.checks.map(toDraftCheck), scheduleKind: s.schedule.kind, minutes: s.schedule.kind === 'interval' ? String(s.schedule.minutes) : '60', cron: s.schedule.kind === 'cron' ? s.schedule.expression : '0 7 * * *', channel_ids: s.channel_ids });
const scheduleOf = (d: Draft): SyncSchedule => (d.scheduleKind === 'interval' ? { kind: 'interval', minutes: Math.max(5, Number(d.minutes) || 60) } : d.scheduleKind === 'cron' ? { kind: 'cron', expression: d.cron.trim(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone } : { kind: 'manual' });

/** Data › Quality: suites of checks on tables, their latest results with the failing rows, and dbt tests alongside. */
export function QualityPanel({ workspaceId }: { workspaceId: string }) {
  const { canEdit } = useWorkspaceAccess();
  const ws = useWorkspace();
  const [suites, setSuites] = useState<QualitySuite[] | null>(null);
  const [dbtTests, setDbtTests] = useState<DbtTestSummary[]>([]);
  const [channels, setChannels] = useState<NotificationChannel[]>([]);
  const [selected, setSelected] = useState<string | null>(() => /[?&]suite=([\w-]+)/.exec(location.hash)?.[1] ?? null);
  const [latest, setLatest] = useState<QualityRun | null>(null);
  const [runs, setRuns] = useState<QualityRun[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await api.get<{ suites: QualitySuite[]; dbt_tests: DbtTestSummary[] }>(`/api/workspaces/${workspaceId}/quality/suites`);
    setSuites(r.suites);
    setDbtTests(r.dbt_tests);
    setSelected((cur) => cur ?? r.suites[0]?.id ?? (r.dbt_tests[0] ? `dbt:${r.dbt_tests[0].project_id}` : null));
  }, [workspaceId]);
  useEffect(() => void load().catch((e) => setError((e as Error).message)), [load]);
  useEffect(() => void api.get<{ channels: NotificationChannel[] }>(`/api/workspaces/${workspaceId}/channels`).then((r) => setChannels(r.channels)).catch(() => undefined), [workspaceId]);
  useEffect(() => {
    if (!ws.catalog) void ws.loadCatalog();
  }, [ws.catalog]); // eslint-disable-line react-hooks/exhaustive-deps

  const suite = suites?.find((s) => s.id === selected) ?? null;
  const loadDetail = useCallback(async (id: string) => {
    const [d, h] = await Promise.all([api.get<{ suite: QualitySuite; latest: QualityRun | null }>(`/api/quality/suites/${id}`), api.get<{ runs: QualityRun[] }>(`/api/quality/suites/${id}/runs?limit=30`)]);
    setLatest(d.latest);
    setRuns(h.runs);
  }, []);
  useEffect(() => {
    setLatest(null);
    setRuns([]);
    if (suite) void loadDetail(suite.id).catch(() => undefined);
  }, [suite?.id, loadDetail]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => subscribeLiveEvents((e) => {
    if (e.type === 'quality' && e.workspace_id === workspaceId) {
      void load().catch(() => undefined);
      if (e.suite_id === selected) void loadDetail(e.suite_id).catch(() => undefined);
    }
  }), [workspaceId, load, loadDetail, selected]);
  const select = (id: string) => {
    setSelected(id);
    history.replaceState(null, '', id.startsWith('dbt:') ? '#/transform/quality' : `#/transform/quality?suite=${id}`);
  };

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const runNow = (id: string) => act(`run:${id}`, async () => {
    await api.post(`/api/quality/suites/${id}/run`, {});
    await loadDetail(id);
  });

  const dbtSelected = selected?.startsWith('dbt:') ? dbtTests.find((d) => `dbt:${d.project_id}` === selected) ?? null : null;
  const empty = suites !== null && suites.length === 0 && dbtTests.length === 0;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Quality"
        description="Checks on your tables — nulls, duplicates, categories, ranges, joins and freshness — with the failing rows one click away."
        actions={<Button variant="primary" size="sm" disabled={!canEdit} onClick={() => setDraft(blank())} data-testid="new-quality-suite"><Plus className="h-3.5 w-3.5" /> New checks</Button>}
      />
      {error && !draft && <div className="rounded-md border border-red-900 bg-red-950/50 px-3 py-2 font-mono text-xs text-red-200">{error}</div>}
      {empty ? (
        <div className="border-y border-zinc-800 py-10">
          <Empty icon={<ShieldCheck />} title="No quality checks yet" hint="Pick a table and DuckView suggests the checks it passes today — then tells you when that changes." action={canEdit ? <Button size="sm" onClick={() => setDraft(blank())}><Sparkles className="h-3.5 w-3.5" /> Check a table</Button> : undefined} />
        </div>
      ) : (
        <div className="grid min-h-[480px] gap-0 border-t border-zinc-800 @3xl:grid-cols-[280px_minmax(0,1fr)]">
          <nav aria-label="Quality suites" className="border-zinc-800 py-2 @3xl:border-r @3xl:pr-2" data-testid="quality-suites">
            {(suites ?? []).map((s) => (
              <button key={s.id} onClick={() => select(s.id)} data-suite={s.name} className={cn('flex w-full flex-col items-start gap-0.5 rounded-md px-2.5 py-2 text-left transition-colors', s.id === selected ? 'bg-zinc-900' : 'hover:bg-zinc-900/60', !s.enabled && 'opacity-60')}>
                <span className="flex w-full items-center gap-2"><StatusDot tone={TONE[s.status]} /><span className="min-w-0 flex-1 truncate text-body text-zinc-100">{s.name}</span><span className="text-2xs text-zinc-500">{s.checks.length}</span></span>
                <span className="w-full truncate pl-4 font-mono text-2xs text-zinc-500">{s.relation}</span>
              </button>
            ))}
            {dbtTests.length > 0 && <div className="mt-3 px-2.5 pb-1 text-2xs text-zinc-500">dbt tests</div>}
            {dbtTests.map((d) => {
              const bad = d.tests.filter((t) => t.status !== 'pass').length;
              return (
                <button key={d.project_id} onClick={() => select(`dbt:${d.project_id}`)} className={cn('flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left transition-colors', `dbt:${d.project_id}` === selected ? 'bg-zinc-900' : 'hover:bg-zinc-900/60')}>
                  <StatusDot tone={bad ? 'error' : 'ok'} /><span className="min-w-0 flex-1 truncate text-body text-zinc-100">{d.project_name}</span><span className="text-2xs text-zinc-500">{d.tests.length - bad}/{d.tests.length}</span>
                </button>
              );
            })}
          </nav>

          <section className="min-w-0 py-3 @3xl:pl-5">
            {suite && (
              <div className="space-y-4" data-testid="quality-suite">
                <div className="flex flex-wrap items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2"><h2 className="truncate text-title font-semibold text-zinc-50">{suite.name}</h2><StatusDot tone={TONE[suite.status]}><span data-testid="quality-status">{STATUS_TEXT[suite.status]}</span></StatusDot></div>
                    <p className="mt-0.5 text-xs text-zinc-500"><span className="font-mono text-zinc-400">{suite.relation}</span> · {suite.checks.length} checks · {every(suite.schedule)}{suite.enabled ? '' : ' (paused)'}{suite.last_run ? ` · ran ${timeAgo(suite.last_run.finished_at)}` : ''}{suite.channel_ids.length ? ` · notifies ${suite.channel_ids.length} channel${suite.channel_ids.length === 1 ? '' : 's'}` : ''}</p>
                    {suite.description && <p className="mt-1 text-xs text-zinc-400">{suite.description}</p>}
                  </div>
                  <Button size="sm" variant="primary" disabled={!canEdit} loading={busy === `run:${suite.id}`} onClick={() => void runNow(suite.id)} data-testid="run-quality"><Play className="h-3.5 w-3.5" /> Run checks</Button>
                  <Button size="sm" disabled={!canEdit} onClick={() => setDraft(fromSuite(suite))}><Pencil className="h-3.5 w-3.5" /> Edit</Button>
                  <Menu trigger={(_, toggle) => <IconButton label="More suite actions" onClick={toggle}><MoreHorizontal className="h-4 w-4" /></IconButton>}>
                    {(close) => (
                      <>
                        <MenuItem onClick={() => { close(); void act('toggle', () => api.patch(`/api/quality/suites/${suite.id}`, { enabled: !suite.enabled })); }}>{suite.enabled ? 'Pause schedule' : 'Resume schedule'}</MenuItem>
                        <MenuDivider />
                        <MenuItem danger icon={<Trash2 className="h-3.5 w-3.5" />} onClick={async () => { close(); if ((await confirmAction(`Delete "${suite.name}" and its history?`))) void act('delete', async () => { await api.del(`/api/quality/suites/${suite.id}`); setSelected(null); }); }}>Delete</MenuItem>
                      </>
                    )}
                  </Menu>
                </div>
                {latest ? <Results results={latest.results ?? []} summary={latest.summary} onOpen={(r) => void ws.addTab({ title: `Failing: ${r.label}`.slice(0, 60), sql: r.sql }).then(() => (location.hash = '#/query'))} /> : <p className="border-y border-zinc-800 py-8 text-center text-xs text-zinc-500">Not run yet. {canEdit ? 'Run the checks to see what passes.' : ''}</p>}
                {runs.length > 1 && (
                  <div>
                    <h3 className="mb-1.5 text-xs font-medium text-zinc-400">History</h3>
                    <div className="flex flex-wrap items-end gap-[3px]" aria-label="Recent runs, oldest first">
                      {[...runs].reverse().map((r) => <span key={r.id} title={`${STATUS_TEXT[r.status]} · ${r.summary} · ${new Date(r.started_at).toLocaleString()} · ${r.triggered_by}`} className={cn('h-5 w-2 rounded-[2px]', r.status === 'pass' ? 'bg-emerald-500/70' : r.status === 'warn' ? 'bg-amber-500/80' : 'bg-red-500/80')} />)}
                    </div>
                  </div>
                )}
              </div>
            )}
            {dbtSelected && (
              <div className="space-y-3">
                <div><h2 className="text-title font-semibold text-zinc-50">{dbtSelected.project_name}</h2><p className="mt-0.5 text-xs text-zinc-500">dbt tests from the run {timeAgo(dbtSelected.started_at)} · <a className="text-accent-300 hover:underline" href="#/transform/dbt">Open project</a></p></div>
                <div className="divide-y divide-zinc-800 border-y border-zinc-800 text-xs">
                  {dbtSelected.tests.map((t) => (
                    <div key={t.name} className="flex items-center gap-3 py-2"><StatusDot tone={DBT_TONE(t.status)} /><span className="min-w-0 flex-1 truncate font-mono text-zinc-200">{t.name}</span><span className="text-zinc-500">{t.failures ? `${t.failures} failing` : t.status}</span></div>
                  ))}
                </div>
              </div>
            )}
            {!suite && !dbtSelected && suites !== null && <p className="py-8 text-center text-xs text-zinc-500">Select a suite.</p>}
          </section>
        </div>
      )}

      {draft && <SuiteEditor workspaceId={workspaceId} draft={draft} setDraft={setDraft} channels={channels} tables={(ws.catalog?.objects ?? []).map((o) => ({ name: o.schema === 'main' ? o.name : `${o.schema}.${o.name}`, columns: o.columns }))} onSaved={(id) => { setDraft(null); setSelected(id); void load().then(() => loadDetail(id)); }} />}
    </div>
  );
}

function Results({ results, summary, onOpen }: { results: QualityCheckResult[]; summary: string; onOpen?: (r: QualityCheckResult) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const sorted = useMemo(() => [...results].sort((a, b) => ({ error: 0, fail: 1, warn: 2, pass: 3 }[a.status] - { error: 0, fail: 1, warn: 2, pass: 3 }[b.status])), [results]);
  return (
    <div>
      <p className="mb-1.5 text-xs text-zinc-400" data-testid="quality-summary">{summary}</p>
      <div className="divide-y divide-zinc-800 border-y border-zinc-800 text-xs" role="table" aria-label="Check results">
        {sorted.map((r) => {
          const expanded = open === r.check_id;
          const canExpand = r.status !== 'pass' && (r.sample || r.sql);
          return (
            <div key={r.check_id} role="row" data-check={r.check_id} data-status={r.status}>
              <button className={cn('grid w-full grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-x-3 py-2 text-left @2xl:grid-cols-[16px_minmax(0,1.3fr)_110px_minmax(0,1fr)]', canExpand ? 'hover:bg-zinc-900/50' : 'cursor-default')} onClick={() => canExpand && setOpen(expanded ? null : r.check_id)} aria-expanded={canExpand ? expanded : undefined}>
                <StatusDot tone={r.status === 'pass' ? 'ok' : r.status === 'warn' ? 'warn' : 'error'} />
                <span className="flex min-w-0 items-center gap-1.5 text-zinc-100">{canExpand ? (expanded ? <ChevronDown className="h-3 w-3 shrink-0 text-zinc-500" /> : <ChevronRight className="h-3 w-3 shrink-0 text-zinc-500" />) : <span className="w-3" />}<span className="truncate">{r.label}</span></span>
                <span className="hidden text-zinc-500 @2xl:block">{typeLabel(r.type)}</span>
                <span className={cn('truncate text-right @2xl:text-left', r.status === 'pass' ? 'text-zinc-500' : r.status === 'warn' ? 'text-amber-300' : 'text-red-300')}>{r.message}</span>
              </button>
              {expanded && (
                <div className="space-y-2 pb-3 pl-7">
                  {r.sample && r.sample.rows.length > 0 && (
                    <div className="overflow-x-auto rounded-md border border-zinc-800">
                      <table className="w-full font-mono text-2xs">
                        <thead className="bg-zinc-900/60 text-left text-zinc-500"><tr>{r.sample.columns.map((c) => <th key={c} className="whitespace-nowrap px-2 py-1 font-normal">{c}</th>)}</tr></thead>
                        <tbody>{r.sample.rows.map((row, i) => <tr key={i} className="border-t border-zinc-800/70">{row.map((v, j) => <td key={j} className="max-w-[240px] truncate whitespace-nowrap px-2 py-1 text-zinc-300">{v === null ? <span className="text-zinc-600">null</span> : typeof v === 'object' ? JSON.stringify(v) : String(v)}</td>)}</tr>)}</tbody>
                      </table>
                    </div>
                  )}
                  {r.sql && <pre className="overflow-x-auto whitespace-pre-wrap rounded-md bg-zinc-950 px-2 py-1.5 font-mono text-2xs text-zinc-400">{r.sql}</pre>}
                  {onOpen && r.sql && <Button size="sm" variant="ghost" onClick={() => onOpen(r)}><FileCode2 className="h-3.5 w-3.5" /> Open failing rows in SQL</Button>}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SuiteEditor({ workspaceId, draft, setDraft, channels, tables, onSaved }: { workspaceId: string; draft: Draft; setDraft: (d: Draft | null) => void; channels: NotificationChannel[]; tables: { name: string; columns: { name: string; type: string }[] }[]; onSaved: (id: string) => void }) {
  const [busy, setBusy] = useState<'suggest' | 'test' | 'save' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<QualityOutcome | null>(null);
  const columns = tables.find((t) => t.name === draft.relation.trim())?.columns ?? [];
  const numericCol = (c: string) => /INT|DOUBLE|FLOAT|DECIMAL|REAL|NUMERIC/i.test(columns.find((x) => x.name === c)?.type ?? '');
  const patch = (i: number, p: Partial<DraftCheck>) => setDraft({ ...draft, checks: draft.checks.map((c, j) => (j === i ? { ...c, ...p } : c)) });
  const body = () => draft.checks.map((c) => fromDraftCheck(c, numericCol(c.column)));
  const run = async (key: 'suggest' | 'test' | 'save', fn: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  const suggest = () => run('suggest', async () => {
    const r = await api.post<{ checks: QualityCheck[] }>(`/api/workspaces/${workspaceId}/quality/suggest`, { relation: draft.relation.trim() });
    const have = new Set(draft.checks.map((c) => `${c.type}:${c.column}`));
    setDraft({ ...draft, name: draft.name || `${draft.relation.trim()} quality`, checks: [...draft.checks, ...r.checks.filter((c) => !have.has(`${c.type}:${c.column ?? ''}`)).map(toDraftCheck)] });
    setPreview(null);
  });
  const test = () => run('test', async () => setPreview(await api.post<QualityOutcome>(`/api/workspaces/${workspaceId}/quality/preview`, { relation: draft.relation.trim(), checks: body() })));
  const save = () => run('save', async () => {
    const payload = { name: draft.name.trim() || `${draft.relation.trim()} quality`, relation: draft.relation.trim(), description: draft.description.trim() || null, checks: body(), schedule: scheduleOf(draft), channel_ids: draft.channel_ids };
    const r = draft.id ? await api.patch<{ suite: QualitySuite }>(`/api/quality/suites/${draft.id}`, payload) : await api.post<{ suite: QualitySuite }>(`/api/workspaces/${workspaceId}/quality/suites`, payload);
    if (!draft.id) await api.post(`/api/quality/suites/${r.suite.id}/run`, {}).catch(() => undefined);
    onSaved(r.suite.id);
  });
  const resultOf = (id: string) => preview?.results.find((r) => r.check_id === id);

  return (
    <Modal open onClose={() => setDraft(null)} title={draft.id ? 'Edit checks' : 'New checks'} width="max-w-3xl">
      <div className="space-y-4 text-xs" data-testid="quality-editor">
        <div className="grid gap-3 @container md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div>
            <Label>Table</Label>
            <div className="flex gap-2">
              <Input autoFocus={!draft.id} list="dv-quality-tables" value={draft.relation} onChange={(e) => setDraft({ ...draft, relation: e.target.value })} placeholder="orders or schema.table" className="font-mono" data-testid="quality-table" />
              <Button onClick={() => void suggest()} loading={busy === 'suggest'} disabled={!draft.relation.trim()} title="Profile the table and add the checks it passes today" data-testid="suggest-checks"><Sparkles className="h-3.5 w-3.5" /> Suggest</Button>
            </div>
            <datalist id="dv-quality-tables">{tables.map((t) => <option key={t.name} value={t.name} />)}</datalist>
          </div>
          <div><Label>Name</Label><Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder={draft.relation ? `${draft.relation} quality` : 'Orders quality'} /></div>
        </div>
        <datalist id="dv-quality-columns">{columns.map((c) => <option key={c.name} value={c.name}>{c.type}</option>)}</datalist>

        <div>
          <div className="mb-1.5 flex items-center justify-between"><Label className="mb-0">Checks</Label><span className="text-zinc-500">{draft.checks.length ? `${draft.checks.length} check${draft.checks.length === 1 ? '' : 's'}` : ''}</span></div>
          {draft.checks.length === 0 ? (
            <p className="border-y border-zinc-800 py-5 text-center text-zinc-500">Choose a table and press Suggest, or add checks one by one.</p>
          ) : (
            <div className="divide-y divide-zinc-800 border-y border-zinc-800">
              {draft.checks.map((c, i) => {
                const res = resultOf(c.id);
                return (
                  <div key={c.id} className="py-2" data-check-row={c.type}>
                    <div className="flex flex-wrap items-center gap-2">
                      <Select uiSize="sm" value={c.type} onChange={(e) => patch(i, { type: e.target.value as QualityCheckType })} aria-label="Check type" title={TYPES.find((t) => t.id === c.type)?.hint}>{TYPES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}</Select>
                      {['not_null', 'unique', 'accepted_values', 'range', 'relationships', 'freshness'].includes(c.type) && <Input uiSize="sm" list="dv-quality-columns" className="w-36 font-mono" value={c.column} onChange={(e) => patch(i, { column: e.target.value })} placeholder="column" aria-label="Column" />}
                      {c.type === 'accepted_values' && <Input uiSize="sm" className="min-w-40 flex-1 font-mono" value={c.values} onChange={(e) => patch(i, { values: e.target.value })} placeholder="a, b, c" aria-label="Accepted values" />}
                      {(c.type === 'range' || c.type === 'row_count') && <><Input uiSize="sm" className="w-24 font-mono" value={c.min} onChange={(e) => patch(i, { min: e.target.value })} placeholder="min" aria-label="Minimum" /><Input uiSize="sm" className="w-24 font-mono" value={c.max} onChange={(e) => patch(i, { max: e.target.value })} placeholder="max" aria-label="Maximum" /></>}
                      {c.type === 'relationships' && <><span className="text-zinc-500">in</span><Input uiSize="sm" list="dv-quality-tables" className="w-36 font-mono" value={c.to} onChange={(e) => patch(i, { to: e.target.value })} placeholder="table" aria-label="Parent table" /><Input uiSize="sm" className="w-32 font-mono" value={c.to_column} onChange={(e) => patch(i, { to_column: e.target.value })} placeholder="column" aria-label="Parent column" /></>}
                      {c.type === 'expression' && <Input uiSize="sm" className="min-w-48 flex-1 font-mono" value={c.expression} onChange={(e) => patch(i, { expression: e.target.value })} placeholder="amount >= 0" aria-label="Condition" />}
                      {c.type === 'freshness' && <><span className="text-zinc-500">within</span><Input uiSize="sm" className="w-16 font-mono" value={c.max_age_hours} onChange={(e) => patch(i, { max_age_hours: e.target.value })} aria-label="Maximum age in hours" /><span className="text-zinc-500">hours</span></>}
                      <span className="ml-auto flex items-center gap-1">
                        {res && <StatusDot tone={res.status === 'pass' ? 'ok' : res.status === 'warn' ? 'warn' : 'error'}><span className="max-w-[180px] truncate" title={res.message}>{res.message}</span></StatusDot>}
                        <Select uiSize="sm" value={c.severity} onChange={(e) => patch(i, { severity: e.target.value as 'warn' | 'error' })} aria-label="Severity"><option value="error">Fail</option><option value="warn">Warn</option></Select>
                        <IconButton label={c.open ? 'Hide options' : 'More options'} active={c.open} onClick={() => patch(i, { open: !c.open })}><ChevronDown className={cn('h-3.5 w-3.5 transition-transform', c.open && 'rotate-180')} /></IconButton>
                        <IconButton label="Remove check" onClick={() => setDraft({ ...draft, checks: draft.checks.filter((_, j) => j !== i) })}><X className="h-3.5 w-3.5" /></IconButton>
                      </span>
                    </div>
                    {c.type === 'custom_sql' && <textarea value={c.sql} onChange={(e) => patch(i, { sql: e.target.value })} spellCheck={false} rows={3} placeholder={'SELECT * FROM {{ table }} WHERE …  -- the failing rows'} aria-label="Custom SQL" className="mt-2 w-full rounded-md border border-zinc-800 bg-zinc-950 p-2 font-mono text-xs text-zinc-200 focus:border-accent-500 focus:outline-none" />}
                    {c.open && (
                      <div className="mt-2 grid gap-2 pl-1 md:grid-cols-[minmax(0,2fr)_90px_minmax(0,2fr)]">
                        <div><Label>Only rows where</Label><Input uiSize="sm" className="font-mono" value={c.where} onChange={(e) => patch(i, { where: e.target.value })} placeholder="status = 'complete'" /></div>
                        <div><Label>Tolerance</Label><Input uiSize="sm" className="font-mono" value={c.tolerance} onChange={(e) => patch(i, { tolerance: e.target.value })} placeholder="0" title="Failing rows allowed" /></div>
                        <div><Label>Label</Label><Input uiSize="sm" value={c.description} onChange={(e) => patch(i, { description: e.target.value })} placeholder="Shown in results and messages" /></div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          <Button size="sm" variant="ghost" className="mt-1.5" onClick={() => setDraft({ ...draft, checks: [...draft.checks, toDraftCheck({ type: 'not_null' })] })}><Plus className="h-3.5 w-3.5" /> Add check</Button>
        </div>

        {preview && <p className={cn('text-xs', preview.status === 'pass' ? 'text-emerald-300' : preview.status === 'warn' ? 'text-amber-300' : 'text-red-300')} data-testid="quality-preview">{preview.summary} <span className="text-zinc-500">({preview.duration_ms} ms, nothing saved)</span></p>}

        <div className="flex flex-wrap items-end gap-2 border-t border-zinc-800 pt-3">
          <div><Label>Run</Label><Select value={draft.scheduleKind} onChange={(e) => setDraft({ ...draft, scheduleKind: e.target.value as Draft['scheduleKind'] })}><option value="manual">By hand</option><option value="interval">Every …</option><option value="cron">On a cron schedule</option></Select></div>
          {draft.scheduleKind === 'interval' && <div><Label>Minutes</Label><Input className="w-24 font-mono" value={draft.minutes} onChange={(e) => setDraft({ ...draft, minutes: e.target.value })} /></div>}
          {draft.scheduleKind === 'cron' && <div><Label>Cron</Label><Input className="w-40 font-mono" value={draft.cron} onChange={(e) => setDraft({ ...draft, cron: e.target.value })} /></div>}
          <div className="min-w-0 flex-1">
            <Label>Tell when the status changes</Label>
            {channels.filter((c) => c.enabled).length === 0 ? <p className="py-1.5 text-zinc-500">No channels yet — add one under Dashboards › Channels.</p> : (
              <div className="flex flex-wrap gap-1.5">
                {channels.filter((c) => c.enabled).map((c) => (
                  <label key={c.id} className={cn('flex h-[var(--control-h)] cursor-pointer items-center gap-1.5 rounded-md border px-2', draft.channel_ids.includes(c.id) ? 'border-accent-500 text-zinc-100' : 'border-zinc-800 text-zinc-400')}>
                    <input type="checkbox" className="accent-accent-500" checked={draft.channel_ids.includes(c.id)} onChange={(e) => setDraft({ ...draft, channel_ids: e.target.checked ? [...draft.channel_ids, c.id] : draft.channel_ids.filter((x) => x !== c.id) })} />{CHANNEL_META[c.type].icon}{c.name}
                  </label>
                ))}
              </div>
            )}
          </div>
        </div>

        {error && <div className="rounded-md border border-red-900 bg-red-950/50 px-3 py-2 font-mono text-red-200">{error}</div>}
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" className="mr-auto" loading={busy === 'test'} disabled={!draft.relation.trim() || !draft.checks.length} onClick={() => void test()} title="Run the checks once as you — nothing is saved or sent" data-testid="test-checks"><FlaskConical className="h-3.5 w-3.5" /> Test</Button>
          <Button variant="ghost" onClick={() => setDraft(null)}>Cancel</Button>
          <Button variant="primary" loading={busy === 'save'} disabled={!draft.relation.trim() || !draft.checks.length} onClick={() => void save()} data-testid="save-checks">{draft.id ? 'Save' : 'Save and run'}</Button>
        </div>
      </div>
    </Modal>
  );
}
