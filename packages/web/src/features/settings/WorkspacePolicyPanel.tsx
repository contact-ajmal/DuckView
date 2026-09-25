/**
 * Administration → Workspaces → Policies: the organisation's rules for workspaces. Quotas (storage, memory, query
 * time per day), the idle policy (warn, then archive, with notification channels), and creation rules (who may
 * create workspaces, a naming rule, engine defaults).
 */
import { useEffect, useState } from 'react';
import { Play } from 'lucide-react';
import { api } from '../../api/client';
import { Button, Checkbox, Field, Input, Skeleton, Switch, toast, errorText, ErrorState } from '../../components/ui';

interface Policy {
  quotas: { storage_bytes: number | null; memory_limit: string | null; query_seconds_per_day: number | null };
  idle: { warn_days: number | null; archive_days: number | null; channel_ids: string[] };
  creation: { admins_only: boolean; name_pattern: string | null; name_hint: string | null; memory_limit: string | null; threads: number | null; query_timeout_seconds: number | null };
}
interface Channel { id: string; name: string; type: string }

/** Empty text is "no limit". */
const num = (s: string) => (s.trim() === '' ? null : Number(s));
const txt = (s: string) => (s.trim() === '' ? null : s.trim());

export function WorkspacePolicyPanel() {
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [f, setF] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    void api.get<{ policy: Policy }>('/api/admin/workspace-policy').then((r) => {
      setPolicy(r.policy);
      const p = r.policy;
      setF({
        storage_gb: p.quotas.storage_bytes != null ? String(p.quotas.storage_bytes / 1e9) : '',
        memory_cap: p.quotas.memory_limit ?? '',
        query_minutes: p.quotas.query_seconds_per_day != null ? String(p.quotas.query_seconds_per_day / 60) : '',
        warn_days: p.idle.warn_days != null ? String(p.idle.warn_days) : '',
        archive_days: p.idle.archive_days != null ? String(p.idle.archive_days) : '',
        name_pattern: p.creation.name_pattern ?? '',
        name_hint: p.creation.name_hint ?? '',
        memory_default: p.creation.memory_limit ?? '',
        threads: p.creation.threads != null ? String(p.creation.threads) : '',
        timeout: p.creation.query_timeout_seconds != null ? String(p.creation.query_timeout_seconds) : '',
      });
    }, setError);
    void api.get<{ channels: Channel[] }>('/api/channels').then((r) => setChannels(r.channels)).catch(() => setChannels([]));
  }, []);

  if (error) return <ErrorState error={error} />;
  if (!policy) return <Skeleton lines={8} />;
  const set = (k: string) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const bad = (k: string, v: number | null) => v != null && (!Number.isFinite(v) || v <= 0) ? `${k} must be a positive number` : null;
  const problem =
    bad('Storage', num(f.storage_gb ?? '')) ?? bad('Query time', num(f.query_minutes ?? '')) ?? bad('Warn after', num(f.warn_days ?? '')) ?? bad('Archive after', num(f.archive_days ?? '')) ?? bad('Threads', num(f.threads ?? '')) ?? bad('Timeout', num(f.timeout ?? '')) ??
    (num(f.warn_days ?? '') && num(f.archive_days ?? '') && num(f.warn_days!)! >= num(f.archive_days!)! ? 'Warn in fewer days than the archive' : null);

  const save = async () => {
    setSaving(true);
    try {
      const body: Policy = {
        quotas: { storage_bytes: num(f.storage_gb ?? '') != null ? Math.round(num(f.storage_gb!)! * 1e9) : null, memory_limit: txt(f.memory_cap ?? ''), query_seconds_per_day: num(f.query_minutes ?? '') != null ? Math.round(num(f.query_minutes!)! * 60) : null },
        idle: { warn_days: num(f.warn_days ?? ''), archive_days: num(f.archive_days ?? ''), channel_ids: policy.idle.channel_ids },
        creation: { admins_only: policy.creation.admins_only, name_pattern: txt(f.name_pattern ?? ''), name_hint: txt(f.name_hint ?? ''), memory_limit: txt(f.memory_default ?? ''), threads: num(f.threads ?? ''), query_timeout_seconds: num(f.timeout ?? '') },
      };
      setPolicy((await api.put<{ policy: Policy }>('/api/admin/workspace-policy', body)).policy);
      toast.success('Saved the workspace policy');
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setSaving(false);
    }
  };
  const runNow = async () => {
    setRunning(true);
    try {
      const r = await api.post<{ backups: string[]; warned: string[]; archived: string[] }>('/api/admin/workspace-policy/run');
      toast.success(`Checked every workspace: ${r.backups.length} backed up, ${r.warned.length} warned, ${r.archived.length} archived`);
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setRunning(false);
    }
  };

  const section = (title: string, hint: string, children: React.ReactNode) => (
    <section className="grid gap-4 border-b border-zinc-800/70 py-5 first:pt-0 md:grid-cols-[16rem_1fr]">
      <div><h3 className="text-body font-semibold text-zinc-100">{title}</h3><p className="mt-1 text-xs text-zinc-500">{hint}</p></div>
      <div className="space-y-3">{children}</div>
    </section>
  );
  return (
    <div data-testid="workspace-policy">
      {section('Quotas', 'Limits for every workspace. Leave a field empty for no limit.', (
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Storage per workspace" hint="GB. Over it, reads work but writes are refused." htmlFor="wp-storage"><Input id="wp-storage" inputMode="decimal" value={f.storage_gb ?? ''} onChange={set('storage_gb')} placeholder="No limit" data-testid="wp-storage" /></Field>
          <Field label="Engine memory, at most" hint="e.g. 8GB or 50%. Caps each engine." htmlFor="wp-mem"><Input id="wp-mem" value={f.memory_cap ?? ''} onChange={set('memory_cap')} placeholder="No limit" className="font-mono" /></Field>
          <Field label="Query time per day" hint="Minutes per workspace; resets at midnight UTC." htmlFor="wp-query"><Input id="wp-query" inputMode="decimal" value={f.query_minutes ?? ''} onChange={set('query_minutes')} placeholder="No limit" data-testid="wp-query" /></Field>
        </div>
      ))}
      {section('Idle workspaces', 'Warn the owner, then archive workspaces nobody used. Archived workspaces can be restored any time.', (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Warn after" hint="Days without use" htmlFor="wp-warn"><Input id="wp-warn" inputMode="numeric" value={f.warn_days ?? ''} onChange={set('warn_days')} placeholder="Never" /></Field>
            <Field label="Archive after" hint="Days without use" htmlFor="wp-archive"><Input id="wp-archive" inputMode="numeric" value={f.archive_days ?? ''} onChange={set('archive_days')} placeholder="Never" /></Field>
          </div>
          <div>
            <div className="mb-1 text-xs font-medium text-zinc-400">Notify</div>
            {channels.length === 0 ? <p className="text-xs text-zinc-500">No organisation channels. Add one under Dashboards → Channels to be told about idle workspaces.</p> : (
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {channels.map((c) => <Checkbox key={c.id} label={`${c.name} · ${c.type.toLowerCase()}`} checked={policy.idle.channel_ids.includes(c.id)} onChange={(e) => setPolicy({ ...policy, idle: { ...policy.idle, channel_ids: e.target.checked ? [...policy.idle.channel_ids, c.id] : policy.idle.channel_ids.filter((x) => x !== c.id) } })} />)}
              </div>
            )}
          </div>
        </>
      ))}
      {section('Creating workspaces', 'Who may create them, how they are named, and the engine they start with.', (
        <>
          <Switch checked={policy.creation.admins_only} onChange={(on) => setPolicy({ ...policy, creation: { ...policy.creation, admins_only: on } })} label="Only administrators create workspaces" />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Naming rule" hint="A regular expression names must match" htmlFor="wp-pattern"><Input id="wp-pattern" value={f.name_pattern ?? ''} onChange={set('name_pattern')} placeholder="^[a-z][a-z0-9-]*$" className="font-mono" /></Field>
            <Field label="The rule, in words" hint="Shown when a name does not match" htmlFor="wp-hint"><Input id="wp-hint" value={f.name_hint ?? ''} onChange={set('name_hint')} placeholder="lower case, digits and dashes" /></Field>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Default memory" htmlFor="wp-dmem"><Input id="wp-dmem" value={f.memory_default ?? ''} onChange={set('memory_default')} placeholder="Server default" className="font-mono" /></Field>
            <Field label="Default threads" htmlFor="wp-threads"><Input id="wp-threads" inputMode="numeric" value={f.threads ?? ''} onChange={set('threads')} placeholder="Automatic" /></Field>
            <Field label="Default query timeout" hint="Seconds" htmlFor="wp-timeout"><Input id="wp-timeout" inputMode="numeric" value={f.timeout ?? ''} onChange={set('timeout')} placeholder="Server default" /></Field>
          </div>
        </>
      ))}
      <div className="flex items-center gap-2 pt-4">
        <span className="min-w-0 flex-1 text-xs text-red-300">{problem}</span>
        <Button variant="ghost" onClick={() => void runNow()} loading={running} title="Scheduled backups and the idle policy run every 10 minutes; run them now"><Play className="h-3.5 w-3.5" /> Run checks now</Button>
        <Button variant="primary" onClick={() => void save()} loading={saving} disabled={!!problem} data-testid="wp-save">Save policy</Button>
      </div>
    </div>
  );
}
