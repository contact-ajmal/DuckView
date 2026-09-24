import { useEffect, useMemo, useState } from 'react';
import { Layers, CheckCircle2, AlertTriangle, Loader2, ExternalLink, Search } from 'lucide-react';
import { api, type LakehouseConnection, type LakehouseProvider, type LakehouseProviderMeta, type LakehouseConfig } from '../../api/client';
import { Button, Input, Label, Modal, Select, cn } from '../../components/ui';

const ORDER: LakehouseProvider[] = ['AWS_GLUE', 'AWS_S3_TABLES', 'DATABRICKS', 'ICEBERG_REST'];
const GLYPH: Record<LakehouseProvider, string> = { AWS_GLUE: 'AWS', AWS_S3_TABLES: 'S3T', DATABRICKS: 'DBX', ICEBERG_REST: 'IRC' };

const aliasOf = (name: string) => {
  const a = name.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  return /^[a-z_]/.test(a) ? a : a ? `lh_${a}` : '';
};

export function LakehouseWizard({ open, onClose, onCreated, initial, initialProvider }: { open: boolean; onClose: () => void; onCreated: (c: LakehouseConnection) => void; initial?: LakehouseConnection | null; initialProvider?: LakehouseProvider | null }) {
  const [meta, setMeta] = useState<Record<LakehouseProvider, LakehouseProviderMeta> | null>(null);
  const [externalAccess, setExternalAccess] = useState(true);
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [provider, setProvider] = useState<LakehouseProvider>('AWS_GLUE');
  const [name, setName] = useState('');
  const [alias, setAlias] = useState('');
  const [aliasTouched, setAliasTouched] = useState(false);
  const [cfg, setCfg] = useState<LakehouseConfig>({});
  const [creds, setCreds] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<LakehouseConnection | null>(null);
  const [test, setTest] = useState<{ ok: boolean; message: string; example_sql?: string } | null>(null);
  const [warehouses, setWarehouses] = useState<{ id: string; name: string; state?: string; type?: string }[] | null>(null);
  const [findingWh, setFindingWh] = useState(false);
  const [whError, setWhError] = useState<string | null>(null);

  const findWarehouses = async () => {
    setFindingWh(true);
    setWhError(null);
    try {
      const body = initial && !creds.token && !creds.client_id ? { connection_id: initial.id } : { host: cfg.host, databricks_auth: cfg.databricks_auth ?? 'pat', credentials: creds };
      const r = await api.post<{ warehouses: { id: string; name: string; state?: string; type?: string }[] }>('/api/lakehouse/databricks/warehouses', body);
      setWarehouses(r.warehouses);
      if (r.warehouses.length === 1 && !cfg.warehouse_id) set({ warehouse_id: r.warehouses[0]!.id });
      if (r.warehouses.length === 0) setWhError('No SQL warehouses visible with these credentials.');
    } catch (e) {
      setWhError((e as Error).message);
    } finally {
      setFindingWh(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    setStep(initial || initialProvider ? 2 : 1);
    setError(null);
    setCreated(null);
    setTest(null);
    setCreds({});
    setWarehouses(null);
    setWhError(null);
    setProvider(initial?.provider ?? initialProvider ?? 'AWS_GLUE');
    setName(initial?.name ?? '');
    setAlias(initial?.alias ?? '');
    setAliasTouched(!!initial);
    setCfg(initial?.config ?? {});
    api.get<{ providers: Record<LakehouseProvider, LakehouseProviderMeta>; external_access_enabled: boolean }>('/api/lakehouse/providers').then((r) => {
      setMeta(r.providers);
      setExternalAccess(r.external_access_enabled);
    });
  }, [open, initial, initialProvider]);

  useEffect(() => {
    if (!aliasTouched) setAlias(aliasOf(name));
  }, [name, aliasTouched]);

  const set = (patch: Partial<LakehouseConfig>) => setCfg((c) => ({ ...c, ...patch }));
  const credentialFields = useMemo<{ key: string; label: string; secret?: boolean; optional?: boolean }[]>(() => {
    if (provider === 'AWS_GLUE' || provider === 'AWS_S3_TABLES') {
      if (cfg.aws_auth === 'credential_chain') return [];
      return [
        { key: 'access_key_id', label: 'Access key ID' },
        { key: 'secret_access_key', label: 'Secret access key', secret: true },
        { key: 'session_token', label: 'Session token', secret: true, optional: true },
      ];
    }
    if (provider === 'ICEBERG_REST') {
      if (cfg.auth === 'none') return [];
      if (cfg.auth === 'oauth2') return [{ key: 'client_id', label: 'Client ID' }, { key: 'client_secret', label: 'Client secret', secret: true }];
      return [{ key: 'token', label: 'Bearer token', secret: true }];
    }
    if (cfg.databricks_auth === 'oauth_m2m') return [{ key: 'client_id', label: 'Service principal client ID' }, { key: 'client_secret', label: 'OAuth secret', secret: true }];
    return [{ key: 'token', label: 'Personal access token', secret: true }];
  }, [provider, cfg.aws_auth, cfg.auth, cfg.databricks_auth]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const body = { name: name || meta?.[provider].title || provider, provider, alias: alias || null, config: cfg, credentials: creds };
      const r = initial ? await api.patch<{ connection: LakehouseConnection }>(`/api/lakehouse-connections/${initial.id}`, { name: body.name, alias: alias || undefined, config: cfg, credentials: creds }) : await api.post<{ connection: LakehouseConnection }>('/api/lakehouse-connections', body);
      setCreated(r.connection);
      setStep(3);
      try {
        setTest(await api.post<{ ok: boolean; message: string; example_sql: string }>(`/api/lakehouse-connections/${r.connection.id}/test`));
      } catch (e) {
        setTest({ ok: false, message: (e as Error).message });
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const field = (label: string, node: React.ReactNode, hint?: string) => (
    <div>
      <Label>{label}</Label>
      {node}
      {hint && <p className="mt-1 text-2xs text-zinc-500">{hint}</p>}
    </div>
  );

  return (
    <Modal open={open} onClose={onClose} title={initial ? `Edit ${initial.name}` : initialProvider ? `Connect ${meta?.[initialProvider]?.title ?? initialProvider}` : 'Connect a lakehouse'} width="max-w-2xl">
      <div className="mb-4 flex items-center gap-2 text-2xs text-zinc-500">
        {(initial || initialProvider ? [2, 3] : [1, 2, 3]).map((s) => (
          <span key={s} className={cn('flex items-center gap-1', step === s && 'text-accent-300')}>
            <span className={cn('flex h-4 w-4 items-center justify-center rounded-full border text-2xs', step >= s ? 'border-accent-500 bg-accent-600/30 text-accent-100' : 'border-zinc-700')}>{s}</span>
            {s === 1 ? 'Platform' : s === 2 ? 'Connection' : 'Verify'}
            {s < 3 && <span className="mx-1 h-px w-6 bg-zinc-800" />}
          </span>
        ))}
      </div>
      {!externalAccess && (
        <div className="mb-3 flex items-start gap-2 rounded-md border border-amber-900 bg-amber-950/40 px-3 py-2 text-2xs text-amber-200">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>External access is disabled on this server (sandboxed mode), so catalogs can be configured but DuckDB cannot attach them. Databricks SQL warehouses still work through the Statement Execution API.</span>
        </div>
      )}

      {step === 1 && (
        <div className="grid grid-cols-2 gap-2">
          {ORDER.map((p) => (
            <button key={p} onClick={() => setProvider(p)} className={cn('rounded-lg border p-3 text-left', provider === p ? 'border-accent-500 bg-accent-600/10' : 'border-zinc-800 hover:border-zinc-600')}>
              <div className="flex items-center gap-2 text-body text-zinc-100">
                <span className="flex h-6 w-9 items-center justify-center rounded border border-fuchsia-900 bg-fuchsia-950/40 font-mono text-2xs font-semibold text-fuchsia-300">{GLYPH[p]}</span>
                {meta?.[p].title ?? p}
              </div>
              <div className="mt-1 text-2xs text-zinc-500">{meta?.[p].blurb ?? ''}</div>
              <div className="mt-1 flex gap-1">
                {meta?.[p].attachable && <span className="rounded border border-zinc-700 px-1 font-mono text-2xs text-zinc-400">DuckDB ATTACH</span>}
                {meta?.[p].remote_sql && <span className="rounded border border-zinc-700 px-1 font-mono text-2xs text-zinc-400">remote SQL</span>}
              </div>
            </button>
          ))}
          <div className="col-span-2 flex justify-end">
            <Button variant="primary" onClick={() => setStep(2)}>
              Continue
            </Button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            {field('Connection name', <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={provider === 'DATABRICKS' ? 'databricks-prod' : 'lakehouse-prod'} />)}
            {field(
              'DuckDB catalog alias',
              <Input value={alias} onChange={(e) => { setAlias(e.target.value); setAliasTouched(true); }} placeholder="lake" className="font-mono" />,
              `Tables are queried as ${alias || 'alias'}.schema.table`,
            )}
          </div>

          {provider === 'AWS_GLUE' && (
            <>
              <div className="grid grid-cols-2 gap-3">
                {field('AWS region', <Input value={cfg.region ?? ''} onChange={(e) => set({ region: e.target.value })} placeholder="us-east-1" className="font-mono" />)}
                {field('AWS account id', <Input value={cfg.account_id ?? ''} onChange={(e) => set({ account_id: e.target.value })} placeholder="123456789012" className="font-mono" />)}
              </div>
              {field(
                'Catalog (optional)',
                <Input value={cfg.catalog ?? ''} onChange={(e) => set({ catalog: e.target.value })} placeholder="s3tablescatalog/my-table-bucket" className="font-mono" />,
                'Leave empty for the account\'s default Glue catalog. For SageMaker Lakehouse / S3 Tables catalogs federated in Glue use "s3tablescatalog/<bucket>" or the catalog id.',
              )}
            </>
          )}
          {provider === 'AWS_S3_TABLES' && (
            <div className="grid grid-cols-2 gap-3">
              {field('Table bucket ARN', <Input value={cfg.table_bucket_arn ?? ''} onChange={(e) => set({ table_bucket_arn: e.target.value })} placeholder="arn:aws:s3tables:us-east-1:123456789012:bucket/analytics" className="font-mono" />)}
              {field('AWS region', <Input value={cfg.region ?? ''} onChange={(e) => set({ region: e.target.value })} placeholder="(from the ARN)" className="font-mono" />)}
            </div>
          )}
          {(provider === 'AWS_GLUE' || provider === 'AWS_S3_TABLES') &&
            field(
              'AWS credentials',
              <Select value={cfg.aws_auth ?? 'keys'} onChange={(e) => set({ aws_auth: e.target.value as 'keys' | 'credential_chain' })} className="w-full">
                <option value="keys">Access keys (stored encrypted)</option>
                <option value="credential_chain">Default credential chain of the DuckView server (IAM role, SSO profile, env vars)</option>
              </Select>,
              'Requests are SigV4-signed against the Glue / S3 Tables Iceberg REST endpoints; the same credentials read the table data from S3.',
            )}

          {provider === 'ICEBERG_REST' && (
            <>
              <div className="grid grid-cols-2 gap-3">
                {field('Catalog endpoint', <Input value={cfg.endpoint ?? ''} onChange={(e) => set({ endpoint: e.target.value })} placeholder="https://polaris.example.com/api/catalog" className="font-mono" />)}
                {field('Warehouse', <Input value={cfg.warehouse ?? ''} onChange={(e) => set({ warehouse: e.target.value })} placeholder="my_warehouse" className="font-mono" />, 'Sent as ?warehouse= to /v1/config; some catalogs accept an empty value.')}
              </div>
              <div className="grid grid-cols-2 gap-3">
                {field(
                  'Authentication',
                  <Select value={cfg.auth ?? 'bearer'} onChange={(e) => set({ auth: e.target.value as LakehouseConfig['auth'] })} className="w-full">
                    <option value="bearer">Bearer token</option>
                    <option value="oauth2">OAuth2 client credentials</option>
                    <option value="none">None</option>
                  </Select>,
                )}
                {field('Default S3 region (optional)', <Input value={cfg.region ?? ''} onChange={(e) => set({ region: e.target.value })} placeholder="us-east-1" className="font-mono" />)}
              </div>
              {cfg.auth === 'oauth2' && (
                <div className="grid grid-cols-2 gap-3">
                  {field('OAuth2 token endpoint', <Input value={cfg.oauth2_server_uri ?? ''} onChange={(e) => set({ oauth2_server_uri: e.target.value })} placeholder="(default: <endpoint>/v1/oauth/tokens)" className="font-mono" />)}
                  {field('Scope', <Input value={cfg.oauth2_scope ?? ''} onChange={(e) => set({ oauth2_scope: e.target.value })} placeholder="PRINCIPAL_ROLE:ALL" className="font-mono" />)}
                </div>
              )}
              <label className="flex items-center gap-2 text-xs text-zinc-300">
                <input type="checkbox" checked={!!cfg.nested_namespaces} onChange={(e) => set({ nested_namespaces: e.target.checked })} /> Catalog uses nested namespaces (a.b.c)
              </label>
            </>
          )}

          {provider === 'DATABRICKS' && (
            <>
              <div className="grid grid-cols-2 gap-3">
                {field('Workspace URL', <Input value={cfg.host ?? ''} onChange={(e) => set({ host: e.target.value })} placeholder="https://dbc-1234-abcd.cloud.databricks.com" className="font-mono" />, 'The address in your browser bar, without the path or ?o= parameter.')}
                {field(
                  'SQL warehouse id',
                  <div className="flex gap-1">
                    {warehouses && warehouses.length > 0 ? (
                      <Select value={cfg.warehouse_id ?? ''} onChange={(e) => set({ warehouse_id: e.target.value })} className="min-w-0 flex-1 font-mono">
                        <option value="">— none (browse only) —</option>
                        {warehouses.map((w) => (
                          <option key={w.id} value={w.id}>
                            {w.name} · {w.id}{w.state ? ` · ${w.state.toLowerCase()}` : ''}{w.type ? ` · ${w.type}` : ''}
                          </option>
                        ))}
                      </Select>
                    ) : (
                      <Input value={cfg.warehouse_id ?? ''} onChange={(e) => set({ warehouse_id: e.target.value })} placeholder="1234abcd5678efgh" className="min-w-0 flex-1 font-mono" />
                    )}
                    <Button onClick={() => void findWarehouses()} loading={findingWh} disabled={!cfg.host || (!initial && !creds.token && !creds.client_secret)} title="List the SQL warehouses this token can see" className="shrink-0">
                      <Search className="h-3.5 w-3.5" /> Find
                    </Button>
                  </div>,
                  whError ?? 'Enter the URL and token below, then Find — or paste the 16-character hex id from the warehouse\'s Connection details (the numeric ?o=… in URLs is the workspace id, not a warehouse). Needed to run SQL remotely and to materialise tables.',
                )}
              </div>
              <div className="grid grid-cols-2 gap-3">
                {field('Unity Catalog (optional)', <Input value={cfg.unity_catalog ?? ''} onChange={(e) => set({ unity_catalog: e.target.value })} placeholder="main" className="font-mono" />, 'Pins the explorer to one catalog; required for attaching UniForm tables.')}
                {field(
                  'Authentication',
                  <Select value={cfg.databricks_auth ?? 'pat'} onChange={(e) => set({ databricks_auth: e.target.value as 'pat' | 'oauth_m2m' })} className="w-full">
                    <option value="pat">Personal access token</option>
                    <option value="oauth_m2m">OAuth M2M (service principal)</option>
                  </Select>,
                )}
              </div>
              <label className="flex items-start gap-2 text-xs text-zinc-300">
                <input type="checkbox" className="mt-0.5" checked={!!cfg.attach_iceberg} disabled={!cfg.unity_catalog} onChange={(e) => set({ attach_iceberg: e.target.checked })} />
                <span>
                  Also attach the catalog in DuckDB through the Unity Catalog Iceberg REST endpoint <span className="text-zinc-500">— UniForm/Iceberg tables become queryable natively and joinable with local data; Delta-only tables still run on the warehouse.</span>
                </span>
              </label>
            </>
          )}

          {credentialFields.length > 0 && (
            <div className="grid grid-cols-2 gap-3">
              {credentialFields.map((f) => (
                <div key={f.key} className={cn(f.key === 'token' && 'col-span-2')}>
                  <Label>
                    {f.label} {f.optional && <span className="normal-case text-zinc-600">(optional)</span>}
                  </Label>
                  <Input type={f.secret ? 'password' : 'text'} value={creds[f.key] ?? ''} onChange={(e) => setCreds({ ...creds, [f.key]: e.target.value })} className="font-mono" autoComplete="off" placeholder={initial ? '(unchanged)' : ''} />
                </div>
              ))}
            </div>
          )}
          <p className="text-2xs text-zinc-500">
            Credentials are encrypted with AES-256-GCM and never returned by the API. {meta?.[provider].attachable && 'Attached catalogs are applied to your running engines without a restart.'}{' '}
            {meta?.[provider].docs && (
              <a href={meta[provider].docs} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-accent-300 hover:underline">
                docs <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </p>
          {error && <div className="rounded-md border border-red-900 bg-red-950/50 px-3 py-2 text-xs text-red-200">{error}</div>}
          <div className="flex justify-between">
            <Button variant="ghost" onClick={() => (initial || initialProvider ? onClose() : setStep(1))}>
              {initial || initialProvider ? 'Cancel' : 'Back'}
            </Button>
            <Button variant="primary" onClick={save} loading={busy}>
              Save & test
            </Button>
          </div>
        </div>
      )}

      {step === 3 && created && (
        <div className="space-y-3">
          <div className={cn('flex items-start gap-2 rounded-md border px-3 py-2 text-xs', test?.ok ? 'border-emerald-900 bg-emerald-950/40 text-emerald-200' : 'border-amber-900 bg-amber-950/40 text-amber-200')}>
            {test ? test.ok ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5" /> : <AlertTriangle className="mt-0.5 h-3.5 w-3.5" /> : <Loader2 className="mt-0.5 h-3.5 w-3.5 animate-spin" />}
            <div>
              <div>{test ? test.message : 'Attaching the catalog and listing schemas…'}</div>
              {test && !test.ok && <div className="mt-1 text-2xs opacity-80">The connection is saved; fix it from Settings → Storage → Lakehouse connections.</div>}
            </div>
          </div>
          <div className="rounded-md border border-zinc-800 bg-zinc-900 p-3 font-mono text-2xs text-zinc-300 whitespace-pre-wrap">{test?.example_sql ?? created.example_sql}</div>
          <div className="flex items-center justify-between text-2xs text-zinc-500">
            <span className="flex items-center gap-1">
              <Layers className="h-3.5 w-3.5 text-fuchsia-300" /> The catalog appears under <b className="text-zinc-300">Lakehouse</b> in the explorer.
            </span>
            <Button
              variant="primary"
              onClick={() => {
                onCreated(created);
                onClose();
              }}
            >
              Done
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
