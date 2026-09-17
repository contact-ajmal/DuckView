import { useEffect, useState } from 'react';
import { Cloud, CheckCircle2, AlertTriangle, Loader2 } from 'lucide-react';
import { api, type CloudConnection } from '../../api/client';
import { Button, Input, Label, Modal, cn } from '../../components/ui';

type Provider = 'S3' | 'R2' | 'GCS' | 'AZURE';
interface ProviderSpec { required: string[]; optional: string[]; uri: string; hint: string }

const LABELS: Record<string, string> = { access_key_id: 'Access key ID', secret_access_key: 'Secret access key', session_token: 'Session token', account_id: 'Account ID', connection_string: 'Connection string' };
const PROVIDER_META: Record<Provider, { title: string; blurb: string }> = {
  S3: { title: 'Amazon S3 / S3-compatible', blurb: 'AWS, MinIO, Wasabi, Ceph — set an endpoint URL for non-AWS.' },
  R2: { title: 'Cloudflare R2', blurb: 'R2 API token (Object Read) + account id.' },
  GCS: { title: 'Google Cloud Storage', blurb: 'HMAC interoperability keys.' },
  AZURE: { title: 'Azure Blob Storage', blurb: 'Connection string with account key or SAS.' },
};

export function CloudWizard({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (c: CloudConnection) => void }) {
  const [specs, setSpecs] = useState<Record<Provider, ProviderSpec> | null>(null);
  const [externalAccess, setExternalAccess] = useState(true);
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [provider, setProvider] = useState<Provider>('S3');
  const [name, setName] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [region, setRegion] = useState('');
  const [bucket, setBucket] = useState('');
  const [creds, setCreds] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CloudConnection | null>(null);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string; uri_example?: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    setStep(1);
    setError(null);
    setCreated(null);
    setTestResult(null);
    setCreds({});
    setName('');
    setEndpoint('');
    setRegion('');
    setBucket('');
    api.get<{ providers: Record<Provider, ProviderSpec>; external_access_enabled: boolean }>('/api/cloud-connections/providers').then((r) => {
      setSpecs(r.providers);
      setExternalAccess(r.external_access_enabled);
    });
  }, [open]);

  const spec = specs?.[provider];
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ connection: CloudConnection }>('/api/cloud-connections', { name: name || `${provider} storage`, provider, endpoint_url: endpoint || null, region: region || null, bucket: bucket || null, credentials: creds });
      setCreated(r.connection);
      setStep(3);
      try {
        const t = await api.post<{ ok: boolean; message: string; uri_example: string }>(`/api/cloud-connections/${r.connection.id}/test`);
        setTestResult(t);
      } catch (e) {
        setTestResult({ ok: false, message: (e as Error).message });
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Connect cloud storage" width="max-w-xl">
      <div className="mb-4 flex items-center gap-2 text-[11px] text-zinc-500">
        {[1, 2, 3].map((s) => (
          <span key={s} className={cn('flex items-center gap-1', step === s && 'text-accent-300')}>
            <span className={cn('flex h-4 w-4 items-center justify-center rounded-full border text-[9px]', step >= s ? 'border-accent-500 bg-accent-600/30 text-accent-100' : 'border-zinc-700')}>{s}</span>
            {s === 1 ? 'Provider' : s === 2 ? 'Credentials' : 'Verify'}
            {s < 3 && <span className="mx-1 h-px w-6 bg-zinc-800" />}
          </span>
        ))}
      </div>
      {!externalAccess && (
        <div className="mb-3 flex items-start gap-2 rounded-md border border-amber-900 bg-amber-950/40 px-3 py-2 text-[11px] text-amber-200">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>External access is disabled on this server, so buckets can be browsed but not queried. Set <code className="font-mono">DUCKVIEW_ENABLE_EXTERNAL_ACCESS=true</code> and restart to query remote files.</span>
        </div>
      )}

      {step === 1 && (
        <div className="grid grid-cols-2 gap-2">
          {(Object.keys(PROVIDER_META) as Provider[]).map((p) => (
            <button key={p} onClick={() => setProvider(p)} className={cn('rounded-lg border p-3 text-left', provider === p ? 'border-accent-500 bg-accent-600/10' : 'border-zinc-800 hover:border-zinc-600')}>
              <div className="flex items-center gap-2 text-sm text-zinc-100">
                <Cloud className="h-4 w-4 text-sky-300" /> {PROVIDER_META[p].title}
              </div>
              <div className="mt-1 text-[11px] text-zinc-500">{PROVIDER_META[p].blurb}</div>
              <div className="mt-1 font-mono text-[10px] text-zinc-600">{specs?.[p].uri ?? ''}://bucket/path</div>
            </button>
          ))}
          <div className="col-span-2 flex justify-end">
            <Button variant="primary" onClick={() => setStep(2)}>
              Continue
            </Button>
          </div>
        </div>
      )}

      {step === 2 && spec && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Connection name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={`${provider.toLowerCase()}-prod`} />
            </div>
            <div>
              <Label>Default bucket {provider === 'AZURE' ? '(container)' : ''} <span className="normal-case text-zinc-600">(optional)</span></Label>
              <Input value={bucket} onChange={(e) => setBucket(e.target.value)} placeholder="my-data-lake" className="font-mono" />
            </div>
            {provider === 'S3' && (
              <>
                <div>
                  <Label>Region</Label>
                  <Input value={region} onChange={(e) => setRegion(e.target.value)} placeholder="us-east-1" className="font-mono" />
                </div>
                <div>
                  <Label>Endpoint URL <span className="normal-case text-zinc-600">(MinIO / R2-via-S3 / Ceph)</span></Label>
                  <Input value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="https://minio.internal:9000" className="font-mono" />
                </div>
              </>
            )}
          </div>
          {[...spec.required, ...spec.optional].map((f) => (
            <div key={f}>
              <Label>
                {LABELS[f] ?? f} {spec.optional.includes(f) && <span className="normal-case text-zinc-600">(optional)</span>}
              </Label>
              <Input type={/secret|token|connection_string/.test(f) ? 'password' : 'text'} value={creds[f] ?? ''} onChange={(e) => setCreds({ ...creds, [f]: e.target.value })} className="font-mono" autoComplete="off" />
            </div>
          ))}
          <p className="text-[11px] text-zinc-500">{spec.hint} Credentials are encrypted with AES-256-GCM and applied to DuckDB as a scoped <code className="font-mono">CREATE SECRET</code>; the API never returns them.</p>
          {error && <div className="rounded-md border border-red-900 bg-red-950/50 px-3 py-2 text-xs text-red-200">{error}</div>}
          <div className="flex justify-between">
            <Button variant="ghost" onClick={() => setStep(1)}>
              Back
            </Button>
            <Button variant="primary" onClick={save} loading={busy}>
              Save & test
            </Button>
          </div>
        </div>
      )}

      {step === 3 && created && (
        <div className="space-y-3">
          <div className={cn('flex items-start gap-2 rounded-md border px-3 py-2 text-xs', testResult?.ok ? 'border-emerald-900 bg-emerald-950/40 text-emerald-200' : 'border-amber-900 bg-amber-950/40 text-amber-200')}>
            {testResult ? testResult.ok ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5" /> : <AlertTriangle className="mt-0.5 h-3.5 w-3.5" /> : <Loader2 className="mt-0.5 h-3.5 w-3.5 animate-spin" />}
            <div>
              <div>{testResult ? testResult.message : 'Testing credentials…'}</div>
              {!testResult?.ok && testResult && <div className="mt-1 text-[10px] opacity-80">The connection is saved; you can fix the credentials from Settings → Cloud connections.</div>}
            </div>
          </div>
          <div className="rounded-md border border-zinc-800 bg-zinc-900 p-3 font-mono text-[11px] text-zinc-300">
            SELECT * FROM '{testResult?.uri_example ?? `${created.uri_scheme}://${created.bucket ?? 'bucket'}/path/file.parquet`}' LIMIT 100;
          </div>
          <div className="flex justify-end">
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
