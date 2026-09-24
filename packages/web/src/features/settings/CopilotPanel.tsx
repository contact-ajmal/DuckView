import { useCallback, useEffect, useMemo, useState } from 'react';
import { Bot, CheckCircle2, ExternalLink, Eye, EyeOff, KeyRound, Loader2, PlugZap, RefreshCw, Save, Trash2, Activity, Gauge, Users, Sparkles, ShieldCheck, AlertTriangle, Lock } from 'lucide-react';
import { api, type CopilotConfig, type CopilotProvider, type CopilotProviderPreset, type CopilotServerSettings, type CopilotUsageReport, type CopilotUsageTotals } from '../../api/client';
import { useCopilot } from '../../store/copilot';
import { Badge, Button, Input, Label, Select, cn, confirmAction, InlineError } from '../../components/ui';
import { DataTable } from '../../components/data';

/** Compact number for token counts: 1.2k, 3.4M. */
export const fmtTokens = (n: number | null | undefined) => (n == null ? '—' : n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k` : String(n));
const fmtMs = (ms: number) => (ms >= 60_000 ? `${(ms / 60_000).toFixed(1)} min` : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);

interface Draft {
  provider: CopilotProvider;
  api_key: string;
  model: string;
  base_url: string;
  aws_region: string;
  bedrock_agent_id: string;
  bedrock_agent_alias_id: string;
  agentcore_runtime_arn: string;
}
const emptyDraft = (provider: CopilotProvider): Draft => ({ provider, api_key: '', model: '', base_url: '', aws_region: '', bedrock_agent_id: '', bedrock_agent_alias_id: '', agentcore_runtime_arn: '' });

/** The vendor grid: pick who answers. */
function ProviderPicker({ presets, value, onPick, compact }: { presets: CopilotProviderPreset[]; value: CopilotProvider | ''; onPick: (id: CopilotProvider) => void; compact?: boolean }) {
  return (
    <div className={cn('grid gap-2', compact ? 'grid-cols-2 md:grid-cols-4' : 'grid-cols-2 md:grid-cols-3 xl:grid-cols-4')}>
      {presets.map((p) => (
        <button key={p.id} type="button" onClick={() => onPick(p.id)} className={cn('rounded-lg border p-2.5 text-left transition', value === p.id ? 'border-accent-500 bg-accent-500/10' : 'border-zinc-800 hover:border-zinc-600')} title={p.blurb}>
          <div className="flex items-center justify-between gap-1">
            <span className="truncate text-body font-semibold text-zinc-100">{p.label}</span>
            <span className="shrink-0 font-mono text-2xs text-zinc-500">{p.vendor}</span>
          </div>
          {!compact && <div className="mt-1 line-clamp-2 text-2xs leading-snug text-zinc-500">{p.blurb}</div>}
        </button>
      ))}
    </div>
  );
}

/**
 * The form for one provider: key (with the vendor's console link), model with suggestions and live fetch, endpoint
 * for the vendors that need one, AWS fields for the AWS entries.
 */
function ProviderForm({ preset, draft, onChange, keyOnFile, fetchModels }: { preset: CopilotProviderPreset; draft: Draft; onChange: (d: Partial<Draft>) => void; keyOnFile: string | null; fetchModels: () => Promise<string[]> }) {
  const [show, setShow] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const suggestions = useMemo(() => [...new Set([...preset.models, ...models])], [preset.models, models]);
  const list = `copilot-models-${preset.id}-${keyOnFile ? 's' : 'b'}`;
  const aws = preset.kind === 'aws';
  return (
    <div className="space-y-3">
      {preset.keyRequired && (
        <div>
          <Label>
            API key{' '}
            {preset.keyUrl && (
              <a href={preset.keyUrl} target="_blank" rel="noreferrer" className="ml-1 inline-flex items-center gap-0.5 normal-case text-accent-300 hover:underline">
                get one from {preset.vendor} <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </Label>
          <div className="flex gap-1">
            <Input type={show ? 'text' : 'password'} value={draft.api_key} onChange={(e) => onChange({ api_key: e.target.value })} autoComplete="off" spellCheck={false} className="h-9 flex-1 font-mono text-xs" placeholder={keyOnFile ? `key on file ····${keyOnFile} — paste a new one to replace it` : preset.keyPrefix ? `${preset.keyPrefix}…` : 'paste your API key'} />
            <Button size="sm" variant="ghost" onClick={() => setShow(!show)} title={show ? 'Hide' : 'Show'}>{show ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}</Button>
          </div>
          {preset.keyPrefix && draft.api_key && !draft.api_key.startsWith(preset.keyPrefix) && <p className="mt-1 text-2xs text-amber-300">A {preset.label} key usually starts with <code className="font-mono">{preset.keyPrefix}</code>.</p>}
        </div>
      )}
      {preset.kind === 'openai' && (preset.baseUrl === null || preset.id === 'ollama') && (
        <div>
          <Label>Base URL</Label>
          <Input value={draft.base_url} onChange={(e) => onChange({ base_url: e.target.value })} className="h-9 font-mono text-xs" placeholder={preset.baseUrl ?? 'https://api.example.com/v1'} spellCheck={false} />
        </div>
      )}
      {!aws && (preset.kind === 'anthropic' || (preset.baseUrl !== null && preset.id !== 'ollama')) && (
        <details className="text-2xs text-zinc-500">
          <summary className="cursor-pointer select-none">Advanced: endpoint override</summary>
          <Input value={draft.base_url} onChange={(e) => onChange({ base_url: e.target.value })} className="mt-1 h-8 font-mono text-xs" placeholder={preset.baseUrl ?? 'https://api.anthropic.com'} spellCheck={false} />
        </details>
      )}
      {aws && (
        <div className="grid gap-2 md:grid-cols-2">
          <div><Label>AWS region</Label><Input value={draft.aws_region} onChange={(e) => onChange({ aws_region: e.target.value })} className="h-9 font-mono text-xs" placeholder="us-east-1" /></div>
          {preset.id === 'bedrock_agent' && (
            <>
              <div><Label>Agent id</Label><Input value={draft.bedrock_agent_id} onChange={(e) => onChange({ bedrock_agent_id: e.target.value })} className="h-9 font-mono text-xs" /></div>
              <div><Label>Alias id</Label><Input value={draft.bedrock_agent_alias_id} onChange={(e) => onChange({ bedrock_agent_alias_id: e.target.value })} className="h-9 font-mono text-xs" /></div>
            </>
          )}
          {preset.id === 'agentcore' && <div className="md:col-span-2"><Label>Runtime ARN</Label><Input value={draft.agentcore_runtime_arn} onChange={(e) => onChange({ agentcore_runtime_arn: e.target.value })} className="h-9 font-mono text-xs" placeholder="arn:aws:bedrock-agentcore:…:runtime/…" /></div>}
        </div>
      )}
      {preset.id !== 'bedrock_agent' && preset.id !== 'agentcore' && (
        <div>
          <Label>Model</Label>
          <div className="flex gap-1">
            <Input list={list} value={draft.model} onChange={(e) => onChange({ model: e.target.value })} className="h-9 flex-1 font-mono text-xs" placeholder={preset.defaultModel || 'model id'} spellCheck={false} />
            <datalist id={list}>{suggestions.map((m) => <option key={m} value={m} />)}</datalist>
            <Button size="sm" variant="secondary" loading={busy} onClick={async () => { setBusy(true); setErr(null); try { setModels(await fetchModels()); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } }} title="List the models this key can use">
              <RefreshCw className="h-3.5 w-3.5" /> Fetch models
            </Button>
          </div>
          {models.length > 0 && <p className="mt-1 text-2xs text-zinc-500">{models.length} model{models.length === 1 ? '' : 's'} available — start typing to filter.</p>}
          <InlineError error={err} className="mt-1" />
        </div>
      )}
      {preset.note && <p className="text-2xs text-zinc-500">{preset.note}</p>}
    </div>
  );
}

/** Server-managed provider: administrators pick a vendor, paste a key, test, save. Stored encrypted on the server. */
function ServerProviderCard({ cfg, reload }: { cfg: CopilotConfig; reload: () => void }) {
  const [settings, setSettings] = useState<CopilotServerSettings | null>(null);
  const [source, setSource] = useState<'settings' | 'config' | null>(cfg.server_source);
  const [draft, setDraft] = useState<Draft>(() => emptyDraft(cfg.server_provider ?? 'anthropic'));
  const [test, setTest] = useState<{ state: 'idle' | 'busy' | 'ok' | 'error'; message?: string }>({ state: 'idle' });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const preset = cfg.providers.find((p) => p.id === draft.provider)!;

  const load = useCallback(async () => {
    const r = await api.get<{ settings: CopilotServerSettings | null; source: 'settings' | 'config' | null }>('/api/copilot/settings');
    setSettings(r.settings);
    setSource(r.source);
    const p = r.settings?.provider ?? cfg.server_provider ?? 'anthropic';
    setDraft({ ...emptyDraft(p), model: r.settings?.model ?? (r.source === 'config' ? cfg.server_model ?? '' : ''), base_url: r.settings?.base_url ?? '', aws_region: r.settings?.aws_region ?? cfg.server_aws?.region ?? '', bedrock_agent_id: r.settings?.bedrock_agent_id ?? '', bedrock_agent_alias_id: r.settings?.bedrock_agent_alias_id ?? '', agentcore_runtime_arn: r.settings?.agentcore_runtime_arn ?? '' });
  }, [cfg]);
  useEffect(() => void load(), [load]);

  const keyOnFile = settings?.provider === draft.provider && settings.has_key ? settings.key_hint : source === 'config' && cfg.server_provider === draft.provider && cfg.has_server_key ? cfg.server_key_hint : null;
  const undecryptable = settings?.provider === draft.provider && settings.key_status === 'undecryptable';
  const body = () => ({ provider: draft.provider, model: draft.model || null, base_url: draft.base_url || null, ...(draft.api_key ? { api_key: draft.api_key } : {}), aws_region: draft.aws_region || null, bedrock_agent_id: draft.bedrock_agent_id || null, bedrock_agent_alias_id: draft.bedrock_agent_alias_id || null, agentcore_runtime_arn: draft.agentcore_runtime_arn || null });
  const runTest = async () => {
    setTest({ state: 'busy' });
    try {
      const r = await api.post<{ ok: true; models: string[]; model: string; latency_ms: number; via: 'models' | 'completion' }>('/api/copilot/settings/test', body());
      setTest({ state: 'ok', message: `Connected in ${r.latency_ms} ms${r.via === 'models' ? ` · ${r.models.length} model${r.models.length === 1 ? '' : 's'} visible` : ' · completion succeeded'}${r.model ? ` · using ${r.model}` : ''}` });
    } catch (e) {
      setTest({ state: 'error', message: (e as Error).message });
    }
  };
  const save = async () => {
    setSaving(true);
    setSaved(null);
    try {
      await api.put('/api/copilot/settings', body());
      setSaved(`Saved · everyone now uses ${preset.label}`);
      setDraft((d) => ({ ...d, api_key: '' }));
      await load();
      reload();
    } catch (e) {
      setSaved(null);
      setTest({ state: 'error', message: (e as Error).message });
    } finally {
      setSaving(false);
    }
  };
  const remove = async () => {
    if (!(await confirmAction('Remove the server-managed provider? Copilot falls back to duckview.config.yaml, or to each person\'s own key.'))) return;
    await api.del('/api/copilot/settings');
    setTest({ state: 'idle' });
    setSaved(null);
    await load();
    reload();
  };
  const canSave = !!draft.provider && (!preset.keyRequired || !!draft.api_key || !!keyOnFile);

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/60">
      <header className="flex flex-wrap items-center gap-2 border-b border-zinc-800 px-4 py-2.5">
        <h3 className="text-xs font-semibold text-zinc-400">Server provider · for everyone</h3>
        {cfg.server_provider ? (
          <Badge tone={cfg.has_server_key ? 'green' : 'amber'}>{cfg.providers.find((p) => p.id === cfg.server_provider)?.label ?? cfg.server_provider} · {cfg.server_model}{cfg.server_key_hint ? ` · key ····${cfg.server_key_hint}` : ''}{source === 'config' ? ' · from config file' : ''}</Badge>
        ) : (
          <Badge tone="warn">not configured</Badge>
        )}
        <span className="ml-auto text-2xs text-zinc-500">{settings?.updated_by_email ? `set by ${settings.updated_by_email}` : source === 'config' ? 'copilot.* in duckview.config.yaml' : 'pick a vendor, paste a key, save'}</span>
      </header>
      <div className="space-y-4 p-4">
        {cfg.ephemeral_encryption_key && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-900/60 bg-amber-950/30 px-3 py-2 text-2xs text-amber-200">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>This server is running without <code className="font-mono">ENCRYPTION_KEY</code>: the key you save here is encrypted with a random key that changes on every restart, so it will have to be pasted again after each restart. Set <code className="font-mono">ENCRYPTION_KEY</code> (and <code className="font-mono">JWT_SECRET</code>) in the environment to keep it.</span>
          </div>
        )}
        {undecryptable && (
          <div className="flex items-start gap-2 rounded-lg border border-red-900/60 bg-red-950/30 px-3 py-2 text-2xs text-red-200">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>The stored key cannot be decrypted any more — the server's encryption key changed since it was saved. Copilot is not working for anyone until you paste the key again.</span>
          </div>
        )}
        <ProviderPicker presets={cfg.providers} value={draft.provider} onPick={(id) => { setDraft({ ...emptyDraft(id), model: settings?.provider === id ? settings.model ?? '' : '', base_url: settings?.provider === id ? settings.base_url ?? '' : '', aws_region: draft.aws_region }); setTest({ state: 'idle' }); setSaved(null); }} />
        <ProviderForm preset={preset} draft={draft} onChange={(d) => { setDraft((x) => ({ ...x, ...d })); setTest({ state: 'idle' }); }} keyOnFile={keyOnFile} fetchModels={async () => (await api.post<{ ok: true; models: string[] }>('/api/copilot/settings/test', body())).models} />
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="secondary" onClick={() => void runTest()} loading={test.state === 'busy'} disabled={!canSave}><PlugZap className="h-3.5 w-3.5" /> Test connection</Button>
          <Button size="sm" variant="primary" onClick={() => void save()} loading={saving} disabled={!canSave}><Save className="h-3.5 w-3.5" /> Save for everyone</Button>
          {source === 'settings' && <Button size="sm" variant="danger" onClick={() => void remove()} title="Remove the stored provider and key" aria-label="Remove the stored provider and key"><Trash2 className="h-3.5 w-3.5" /></Button>}
          {test.state === 'ok' && <span className="inline-flex items-center gap-1 text-2xs text-emerald-300"><CheckCircle2 className="h-3.5 w-3.5" /> {test.message}</span>}
          {test.state === 'error' && <span className="text-2xs text-red-300">{test.message}</span>}
          {saved && test.state !== 'error' && <span className="inline-flex items-center gap-1 text-2xs text-emerald-300"><CheckCircle2 className="h-3.5 w-3.5" /> {saved}</span>}
        </div>
        <div className="flex items-start gap-2 rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-2 text-2xs text-zinc-400">
          <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" />
          <span>Once saved, the key is <b className="text-zinc-300">write-only</b>: it is encrypted at rest (AES-256-GCM with the server's encryption key), never returned by any API or page — administrators see only its last four characters — never written to logs or the audit trail, scrubbed from provider error messages, and only ever sent to {preset.vendor === 'Any' ? 'the endpoint you configure' : preset.vendor}. Saving here overrides <code className="font-mono">copilot.*</code> in duckview.config.yaml, so no key needs to live in a file or the environment.</span>
        </div>
        <label className="flex cursor-pointer items-start gap-2 text-2xs text-zinc-400">
          <input type="checkbox" className="mt-0.5 accent-accent-500" checked={cfg.allow_byok} disabled={source !== 'settings'} onChange={async (e) => { await api.put('/api/copilot/settings/byok', { allow: e.target.checked === cfg.allow_byok_config ? null : e.target.checked }); reload(); }} />
          <span><Lock className="mr-1 inline h-3 w-3" />Allow people to use their own keys (bring-your-own). Off = everyone uses this server provider and cannot pick another vendor, key or model.{source !== 'settings' ? ' Save a server provider first to change this.' : cfg.allow_byok !== cfg.allow_byok_config ? ' (overriding the config file)' : ''}</span>
        </label>
      </div>
    </section>
  );
}

/** Bring-your-own key: stays in this browser, sent with each request. */
function OwnKeyCard({ cfg }: { cfg: CopilotConfig }) {
  const cp = useCopilot();
  const own = cp.settings.provider !== '';
  const preset = cfg.providers.find((p) => p.id === cp.settings.provider);
  const [test, setTest] = useState<{ state: 'idle' | 'busy' | 'ok' | 'error'; message?: string }>({ state: 'idle' });
  const draft: Draft = { provider: (cp.settings.provider || 'anthropic') as CopilotProvider, api_key: cp.settings.apiKey, model: cp.settings.model, base_url: cp.settings.baseUrl, aws_region: cp.settings.region ?? '', bedrock_agent_id: cp.settings.agentId ?? '', bedrock_agent_alias_id: cp.settings.agentAliasId ?? '', agentcore_runtime_arn: cp.settings.runtimeArn ?? '' };
  const fetchModels = async () => (await api.post<{ models: string[] }>('/api/copilot/models', { provider: draft.provider, api_key: draft.api_key || undefined, base_url: draft.base_url || undefined, region: draft.aws_region || undefined, agent_id: draft.bedrock_agent_id || undefined, agent_alias_id: draft.bedrock_agent_alias_id || undefined, runtime_arn: draft.agentcore_runtime_arn || undefined })).models;
  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/60">
      <header className="flex flex-wrap items-center gap-2 border-b border-zinc-800 px-4 py-2.5">
        <h3 className="text-xs font-semibold text-zinc-400">Your own key · this browser only</h3>
        {own ? <Badge tone="accent">{preset?.label ?? cp.settings.provider} · {cp.settings.model || preset?.defaultModel}</Badge> : <Badge>using the server provider</Badge>}
        {own && <button onClick={() => { cp.setSettings({ provider: '', model: '', apiKey: '', baseUrl: '' }); setTest({ state: 'idle' }); }} className="ml-auto text-2xs text-zinc-400 hover:text-zinc-100">Use the server provider instead</button>}
      </header>
      <div className="space-y-4 p-4">
        <ProviderPicker compact presets={cfg.providers} value={cp.settings.provider} onPick={(id) => { cp.setSettings({ provider: id, model: '', apiKey: '', baseUrl: '' }); setTest({ state: 'idle' }); }} />
        {own && preset && (
          <>
            <ProviderForm preset={preset} draft={draft} onChange={(d) => { cp.setSettings({ ...(d.api_key !== undefined ? { apiKey: d.api_key } : {}), ...(d.model !== undefined ? { model: d.model } : {}), ...(d.base_url !== undefined ? { baseUrl: d.base_url } : {}), ...(d.aws_region !== undefined ? { region: d.aws_region } : {}), ...(d.bedrock_agent_id !== undefined ? { agentId: d.bedrock_agent_id } : {}), ...(d.bedrock_agent_alias_id !== undefined ? { agentAliasId: d.bedrock_agent_alias_id } : {}), ...(d.agentcore_runtime_arn !== undefined ? { runtimeArn: d.agentcore_runtime_arn } : {}) }); setTest({ state: 'idle' }); }} keyOnFile={null} fetchModels={fetchModels} />
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="secondary" loading={test.state === 'busy'} onClick={async () => { setTest({ state: 'busy' }); try { const m = await fetchModels(); setTest({ state: 'ok', message: `Connected · ${m.length} model${m.length === 1 ? '' : 's'} visible` }); } catch (e) { setTest({ state: 'error', message: (e as Error).message }); } }}><PlugZap className="h-3.5 w-3.5" /> Test</Button>
              {test.state === 'ok' && <span className="inline-flex items-center gap-1 text-2xs text-emerald-300"><CheckCircle2 className="h-3.5 w-3.5" /> {test.message}</span>}
              {test.state === 'error' && <span className="text-2xs text-red-300">{test.message}</span>}
              <span className="text-2xs text-zinc-500">Saved automatically in this browser; sent with each request, never stored on the server.</span>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

function Tile({ label, totals, sub }: { label: string; totals: CopilotUsageTotals | { requests: number; input_tokens: number; output_tokens: number; errors?: number }; sub?: string }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3">
      <div className="text-2xs font-semibold text-zinc-500">{label}</div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="text-title font-semibold text-zinc-50">{fmtTokens(totals.input_tokens + totals.output_tokens)}</span>
        <span className="text-2xs text-zinc-500">tokens</span>
      </div>
      <div className="mt-0.5 font-mono text-2xs text-zinc-500">{fmtTokens(totals.input_tokens)} in · {fmtTokens(totals.output_tokens)} out · {totals.requests} request{totals.requests === 1 ? '' : 's'}{totals.errors ? ` · ${totals.errors} failed` : ''}{sub ? ` · ${sub}` : ''}</div>
    </div>
  );
}

/** Live streams and token totals; polls while the page is open. */
function UsageCard({ cfg }: { cfg: CopilotConfig }) {
  const [report, setReport] = useState<CopilotUsageReport | null>(null);
  const [days, setDays] = useState(30);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const load = () => api.get<CopilotUsageReport>(`/api/copilot/usage?days=${days}`).then((r) => !cancelled && setReport(r)).catch(() => undefined);
    void load();
    const t = window.setInterval(() => { void load(); setTick((x) => x + 1); }, 5000);
    return () => { cancelled = true; window.clearInterval(t); };
  }, [days]);
  const label = (p: CopilotProvider) => cfg.providers.find((x) => x.id === p)?.label ?? p;
  if (!report) return <section className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 text-xs text-zinc-500">Loading usage…</section>;
  const maxDay = Math.max(1, ...report.by_day.map((d) => d.input_tokens + d.output_tokens));
  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/60">
      <header className="flex flex-wrap items-center gap-2 border-b border-zinc-800 px-4 py-2.5">
        <h3 className="text-xs font-semibold text-zinc-400">Usage {report.scope === 'all' ? '· everyone' : '· you'}</h3>
        <span className="inline-flex items-center gap-1 text-2xs text-zinc-500"><Activity className={cn('h-3 w-3', report.active.length ? 'text-emerald-400' : 'text-zinc-500')} /> {report.active.length} active</span>
        <Select value={days} onChange={(e) => setDays(Number(e.target.value))} className="ml-auto h-7 text-2xs">
          <option value={7}>last 7 days</option>
          <option value={30}>last 30 days</option>
          <option value={90}>last 90 days</option>
        </Select>
      </header>
      <div className="space-y-4 p-4">
        <div>
          <div className="mb-1.5 text-2xs font-semibold text-zinc-500">Sessions running now</div>
          {report.active.length === 0 ? (
            <p className="text-2xs text-zinc-500">No Copilot request is in flight.</p>
          ) : (
            <ul className="divide-y divide-zinc-800 rounded-lg border border-zinc-800">
              {report.active.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center gap-2 px-3 py-1.5 text-2xs">
                  <Loader2 className="h-3 w-3 animate-spin text-accent-300" />
                  <span className="font-medium text-zinc-100">{a.user_email}</span>
                  <span className="font-mono text-zinc-400">{label(a.provider)} · {a.model}</span>
                  <Badge>{a.action}</Badge>
                  {a.byok && <Badge tone="accent">own key</Badge>}
                  <span className="ml-auto font-mono text-zinc-500">{fmtMs(Date.now() - a.started_at)} · {a.chars.toLocaleString()} chars{tick ? '' : ''}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="grid gap-2 md:grid-cols-3">
          <Tile label="Today" totals={report.today} />
          <Tile label={`Last ${report.days} days`} totals={report.window} sub={report.window.duration_ms ? `${fmtMs(report.window.duration_ms / Math.max(1, report.window.requests))} avg` : undefined} />
          <Tile label="All time" totals={report.all_time} />
        </div>
        {report.by_day.length > 1 && (
          <div>
            <div className="mb-1.5 text-2xs font-semibold text-zinc-500">Tokens per day</div>
            <div className="flex h-16 items-end gap-0.5">
              {report.by_day.map((d) => (
                <div key={d.day} className="flex-1 rounded-t bg-accent-500/70" style={{ height: `${Math.max(4, (100 * (d.input_tokens + d.output_tokens)) / maxDay)}%` }} title={`${d.day}: ${fmtTokens(d.input_tokens + d.output_tokens)} tokens · ${d.requests} requests`} />
              ))}
            </div>
            <div className="mt-0.5 flex justify-between font-mono text-2xs text-zinc-500"><span>{report.by_day[0]!.day}</span><span>{report.by_day.at(-1)!.day}</span></div>
          </div>
        )}
        <div className={cn('grid gap-4', report.scope === 'all' ? 'lg:grid-cols-2' : '')}>
          <div>
            <div className="mb-1.5 flex items-center gap-1 text-2xs font-semibold text-zinc-500"><Gauge className="h-3 w-3" /> By model</div>
            {report.by_model.length === 0 ? <p className="text-2xs text-zinc-500">Nothing yet.</p> : (
              <DataTable
                label="Usage by model"
                rows={report.by_model}
                rowKey={(m) => `${m.provider}/${m.model}/${m.byok}`}
                columns={[
                  { key: 'model', header: 'Model', cell: (m) => <span className="font-mono text-zinc-200">{label(m.provider)} · {m.model}{m.byok ? <span className="ml-1 text-2xs text-accent-300">own key</span> : null}</span> },
                  { key: 'requests', header: 'Requests', align: 'right', cell: (m) => <span className="font-mono text-zinc-400">{m.requests}{m.errors ? <span className="text-red-300"> ({m.errors}✗)</span> : null}</span> },
                  { key: 'in', header: 'In', align: 'right', cell: (m) => <span className="font-mono text-zinc-400">{fmtTokens(m.input_tokens)}</span> },
                  { key: 'out', header: 'Out', align: 'right', cell: (m) => <span className="font-mono text-zinc-400">{fmtTokens(m.output_tokens)}</span> },
                ]}
              />
            )}
          </div>
          {report.scope === 'all' && (
            <div>
              <div className="mb-1.5 flex items-center gap-1 text-2xs font-semibold text-zinc-500"><Users className="h-3 w-3" /> By person</div>
              {report.by_user.length === 0 ? <p className="text-2xs text-zinc-500">Nothing yet.</p> : (
                <DataTable
                  label="Usage by person"
                  rows={report.by_user}
                  rowKey={(u) => u.user_id}
                  columns={[
                    { key: 'person', header: 'Person', sortValue: (u) => u.email, cell: (u) => <span className="text-zinc-200">{u.email}</span> },
                    { key: 'requests', header: 'Requests', align: 'right', sortValue: (u) => u.requests, cell: (u) => <span className="font-mono text-zinc-400">{u.requests}</span> },
                    { key: 'in', header: 'In', align: 'right', cell: (u) => <span className="font-mono text-zinc-400">{fmtTokens(u.input_tokens)}</span> },
                    { key: 'out', header: 'Out', align: 'right', cell: (u) => <span className="font-mono text-zinc-400">{fmtTokens(u.output_tokens)}</span> },
                  ]}
                />
              )}
            </div>
          )}
        </div>
        {report.recent.length > 0 && (
          <details className="text-2xs">
            <summary className="cursor-pointer select-none text-2xs font-semibold text-zinc-500">Recent turns ({report.recent.length})</summary>
            <ul className="mt-1.5 max-h-64 divide-y divide-zinc-800/60 overflow-auto rounded-lg border border-zinc-800">
              {report.recent.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-2 px-2.5 py-1 font-mono text-2xs">
                  <span className="text-zinc-500">{new Date(r.created_at).toLocaleString()}</span>
                  <span className="text-zinc-300">{label(r.provider)} · {r.model}</span>
                  <Badge>{r.action}</Badge>
                  <span className={cn('ml-auto', r.status === 'ok' ? 'text-zinc-400' : 'text-red-300')}>{r.status === 'ok' ? `${fmtTokens(r.input_tokens)} in · ${fmtTokens(r.output_tokens)} out` : r.status} · {fmtMs(r.duration_ms)}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </section>
  );
}

/** Settings → Copilot: who answers (server-wide and per person), and what it costs in tokens. */
export function CopilotPanel({ cfg, isAdmin, reload }: { cfg: CopilotConfig; isAdmin: boolean; reload: () => void }) {
  const cp = useCopilot();
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900/60 px-4 py-3 text-xs">
        <Bot className="h-4 w-4 text-accent-300" />
        {cfg.can_use ? (
          <span className="text-zinc-200">DuckCopilot is ready — {cp.settings.provider ? `you are using your own ${cfg.providers.find((p) => p.id === cp.settings.provider)?.label ?? cp.settings.provider} key` : cfg.server_provider ? `everyone uses ${cfg.providers.find((p) => p.id === cfg.server_provider)?.label ?? cfg.server_provider} (${cfg.server_model})` : 'bring your own key below'}.</span>
        ) : (
          <span className="text-amber-200">{cfg.enabled ? 'No provider yet — pick a vendor below and paste an API key to get started.' : 'DuckCopilot is disabled in the server configuration (copilot.enabled).'}</span>
        )}
        <Button size="sm" variant="ghost" className="ml-auto" onClick={() => cp.toggle(true)}><Sparkles className="h-3.5 w-3.5" /> Open Copilot</Button>
      </div>
      {isAdmin ? <ServerProviderCard cfg={cfg} reload={reload} /> : cfg.server_provider ? null : <p className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4 text-xs text-zinc-500"><KeyRound className="mr-1 inline h-3.5 w-3.5" /> No server-wide provider is configured; an administrator can add one here, or use your own key below.</p>}
      {cfg.allow_byok && <OwnKeyCard cfg={cfg} />}
      <UsageCard cfg={cfg} />
    </div>
  );
}
