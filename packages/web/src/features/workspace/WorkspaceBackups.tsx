/**
 * A workspace's backups and bundle: back up now, a schedule with retention, restore to a point (data, and
 * optionally queries, dashboards and notebooks), download, delete; and export the workspace as a .duckview bundle.
 */
import { useCallback, useEffect, useState } from 'react';
import { ArchiveRestore, DatabaseBackup, Download, GitCompareArrows, PackageOpen, Trash2 } from 'lucide-react';
import { useWorkspace } from '../../store/workspace';
import { api, downloadAuthed, formatBytes, timeAgo, type Workspace } from '../../api/client';
import { DataTable } from '../../components/data';
import { Button, Checkbox, Field, IconButton, Modal, Select, confirmAction, toast, errorText } from '../../components/ui';

interface Backup { id: string; kind: 'manual' | 'scheduled' | 'pre_restore'; size_bytes: number; tables: number; objects: { queries: number; dashboards: number; notebooks: number; quality: number }; note: string | null; created_at: string; exists: boolean }
const n = (count: number, one: string, many = `${one}s`) => `${count.toLocaleString()} ${count === 1 ? one : many}`;
const KIND: Record<Backup['kind'], string> = { manual: 'Manual', scheduled: 'Scheduled', pre_restore: 'Before a restore' };
const SCHEDULES: { label: string; hours: number | null }[] = [
  { label: 'Off', hours: null },
  { label: 'Every 6 hours', hours: 6 },
  { label: 'Every day', hours: 24 },
  { label: 'Every week', hours: 168 },
];

export function WorkspaceBackups({ w, onChanged }: { w: Workspace; onChanged: () => void }) {
  const ws = useWorkspace();
  const [backups, setBackups] = useState<Backup[] | null>(null);
  const [policy, setPolicy] = useState<{ every_hours: number; keep: number } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<Backup | null>(null);
  const [withObjects, setWithObjects] = useState(false);
  const local = w.active_db_path !== ':memory:' && !/^[a-z0-9]+:/i.test(w.active_db_path);

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ backups: Backup[]; policy: { every_hours: number; keep: number } | null }>(`/api/workspaces/${w.id}/backups`);
      setBackups(r.backups);
      setPolicy(r.policy);
    } catch (e) {
      setError(e);
    }
  }, [w.id]);
  useEffect(() => void load(), [load]);

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    try {
      await fn();
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(null);
    }
  };
  const backupNow = () => run('backup', async () => {
    const r = await api.post<{ backup: Backup }>(`/api/workspaces/${w.id}/backups`, {});
    toast.success(`Backed up ${n(r.backup.tables, 'table')} (${formatBytes(r.backup.size_bytes)})`);
    await load();
  });
  const setSchedule = (hours: number | null, keep = policy?.keep ?? 7) => run('schedule', async () => {
    const next = hours ? { every_hours: hours, keep } : null;
    await api.put(`/api/workspaces/${w.id}/backup-policy`, { policy: next });
    setPolicy(next);
    toast.success(next ? `Backing up ${SCHEDULES.find((s) => s.hours === hours)?.label.toLowerCase() ?? `every ${hours} hours`}, keeping ${keep}` : 'Scheduled backups are off');
  });
  const restore = () => run('restore', async () => {
    const b = restoring!;
    const r = await api.post<{ tables: number }>(`/api/workspaces/${w.id}/backups/${b.id}/restore`, { objects: withObjects });
    setRestoring(null);
    toast.success(`Restored to ${new Date(b.created_at).toLocaleString()}: ${n(r.tables, 'table')}${withObjects ? ', with its queries, dashboards and notebooks' : ''}. The state before is kept as a backup`);
    await load();
    onChanged();
  });
  const remove = (b: Backup) => run(`del:${b.id}`, async () => {
    if (!(await confirmAction(`Delete the backup from ${new Date(b.created_at).toLocaleString()}?`, { confirmLabel: 'Delete' }))) return;
    await api.del(`/api/workspaces/${w.id}/backups/${b.id}`);
    await load();
  });
  const exportBundle = () => run('export', async () => {
    await downloadAuthed(`/api/workspaces/${w.id}/bundle`, `${w.name}.duckview`);
    toast.success('Exported. Import the file on any DuckView server to get this workspace back');
  });

  return (
    <div className="space-y-4" data-testid="ws-backups">
      <div className="flex flex-wrap items-end gap-2">
        <Button onClick={() => void backupNow()} loading={busy === 'backup'} disabled={!!w.archived_at} data-testid="ws-backup-now"><DatabaseBackup className="h-3.5 w-3.5" /> Back up now</Button>
        <Field label="Schedule" htmlFor="bk-schedule">
          <Select id="bk-schedule" uiSize="sm" value={String(policy?.every_hours ?? '')} onChange={(e) => void setSchedule(e.target.value ? Number(e.target.value) : null)} disabled={busy === 'schedule'} data-testid="ws-backup-schedule">
            {SCHEDULES.map((s) => <option key={s.label} value={s.hours ?? ''}>{s.label}</option>)}
            {policy && !SCHEDULES.some((s) => s.hours === policy.every_hours) && <option value={policy.every_hours}>Every {policy.every_hours} hours</option>}
          </Select>
        </Field>
        {policy && (
          <Field label="Keep" htmlFor="bk-keep">
            <Select id="bk-keep" uiSize="sm" value={policy.keep} onChange={(e) => void setSchedule(policy.every_hours, Number(e.target.value))}>
              {[3, 7, 14, 30, 90].map((n) => <option key={n} value={n}>{n} copies</option>)}
            </Select>
          </Field>
        )}
        <span className="flex-1" />
        <Button variant="ghost" onClick={() => void exportBundle()} loading={busy === 'export'} disabled={!!w.archived_at} title="The data, queries, dashboards, notebooks, metrics and settings in one .duckview file" data-testid="ws-export"><PackageOpen className="h-3.5 w-3.5" /> Export bundle</Button>
      </div>
      <DataTable
        label="Backups"
        testid="ws-backup-list"
        rows={backups}
        error={error}
        onRetry={() => void load()}
        rowKey={(b) => b.id}
        empty="No backups yet. Back up now, or choose a schedule."
        columns={[
          { key: 'when', header: 'Taken', cell: (b) => <span title={new Date(b.created_at).toLocaleString()}>{timeAgo(b.created_at)}</span> },
          { key: 'kind', header: 'Kind', cell: (b) => KIND[b.kind] },
          { key: 'contents', header: 'Contents', cell: (b) => [n(b.tables, 'table'), n(b.objects.dashboards, 'dashboard'), n(b.objects.queries, 'query', 'queries'), n(b.objects.notebooks, 'notebook')].join(' · ') },
          { key: 'note', header: 'Note', truncate: true, cell: (b) => b.note ?? '' },
          { key: 'size', header: 'Size', align: 'right', numeric: true, cell: (b) => (b.exists ? formatBytes(b.size_bytes) : <span className="text-red-300">File missing</span>) },
          {
            key: 'actions',
            header: '',
            align: 'right',
            cell: (b) => (
              <span className="inline-flex gap-1">
                <Button size="sm" variant="ghost" disabled={!b.exists || !local || !!busy} title={local ? 'Put the workspace back to this point' : 'Restoring needs a database file on the server'} onClick={() => { setWithObjects(false); setRestoring(b); }} data-testid="ws-restore-backup"><ArchiveRestore className="h-3.5 w-3.5" /> Restore</Button>
                <IconButton label="Compare this backup with now" disabled={!b.exists} onClick={() => void ws.selectWorkspace(w.id).then(() => { location.hash = `#/compare?backup=${b.id}`; })} data-testid="ws-compare-backup"><GitCompareArrows className="h-3.5 w-3.5" /></IconButton>
                <IconButton label="Download this backup" disabled={!b.exists} onClick={() => void run(`dl:${b.id}`, () => downloadAuthed(`/api/workspaces/${w.id}/backups/${b.id}/download`, 'backup.duckview'))}><Download className="h-3.5 w-3.5" /></IconButton>
                <IconButton label="Delete this backup" onClick={() => void remove(b)}><Trash2 className="h-3.5 w-3.5" /></IconButton>
              </span>
            ),
          },
        ]}
      />
      <Modal open={restoring !== null} onClose={() => setRestoring(null)} title="Restore this backup?" width="max-w-md">
        {restoring && (
          <div className="space-y-4">
            <p className="text-body text-zinc-300">The data goes back to {new Date(restoring.created_at).toLocaleString()}. The engine restarts, and the current state is kept as a backup first, so this can be undone.</p>
            <Checkbox label="Also restore queries, dashboards, notebooks, metrics and quality suites" hint="They replace the current ones. Leave this off to keep today's work and only restore the data." checked={withObjects} onChange={(e) => setWithObjects(e.target.checked)} />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setRestoring(null)}>Cancel</Button>
              <Button variant="primary" loading={busy === 'restore'} onClick={() => void restore()} data-testid="ws-restore-confirm">Restore</Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
