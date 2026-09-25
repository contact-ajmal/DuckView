/**
 * Find personal data: scans the workspace's tables (a sample of each) for columns whose names or values look like
 * personal data, then tags the chosen ones in the catalog and masks them for everyone but the owners with an
 * access policy per table. Examples are masked before they leave the server.
 */
import { useEffect, useState } from 'react';
import { ScanSearch, ShieldCheck, Tag } from 'lucide-react';
import { api } from '../../api/client';
import { DataTable } from '../../components/data';
import { Badge, Button, Drawer, Select, toast, errorText } from '../../components/ui';

type MaskKind = 'null' | 'redact' | 'hash' | 'partial';
interface Finding { object: string; column: string; type: string; kind: string; confidence: 'high' | 'medium'; evidence: 'name' | 'values' | 'both'; match_rate: number | null; examples: string[]; suggested_mask: MaskKind; tagged: boolean }
const LABEL: Record<string, string> = { email: 'Email address', phone: 'Phone number', card: 'Payment card', iban: 'Bank account (IBAN)', national_id: 'National ID', ip: 'IP address', birth_date: 'Date of birth', address: 'Postal address', person_name: "Person's name" };
const MASK: Record<MaskKind, string> = { partial: 'Show the shape', hash: 'Hash (joins still work)', redact: 'Redact', null: 'Hide (NULL)' };
const idOf = (f: Finding) => `${f.object}.${f.column}`;

export function PiiDrawer({ open, onClose, workspaceId, canTag, canMask, onChanged }: { open: boolean; onClose: () => void; workspaceId: string; canTag: boolean; canMask: boolean; onChanged: () => void }) {
  const [findings, setFindings] = useState<Finding[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [masks, setMasks] = useState<Record<string, MaskKind>>({});
  const [busy, setBusy] = useState<'tag' | 'mask' | null>(null);

  const scan = async () => {
    setFindings(null);
    setError(null);
    try {
      const f = (await api.post<{ findings: Finding[] }>(`/api/workspaces/${workspaceId}/pii/scan`, {})).findings;
      setFindings(f);
      setSelected(f.filter((x) => x.confidence === 'high').map(idOf));
      setMasks(Object.fromEntries(f.map((x) => [idOf(x), x.suggested_mask])));
    } catch (e) {
      setError(e);
    }
  };
  useEffect(() => {
    if (open) void scan();
  }, [open, workspaceId]); // eslint-disable-line react-hooks/exhaustive-deps

  const chosen = (findings ?? []).filter((f) => selected.includes(idOf(f)));
  const tag = async () => {
    setBusy('tag');
    try {
      const r = await api.post<{ tagged: number }>(`/api/workspaces/${workspaceId}/pii/tag`, { items: chosen.map((f) => ({ object: f.object, column: f.column, kind: f.kind })) });
      toast.success(`Tagged ${r.tagged} column${r.tagged === 1 ? '' : 's'} as personal data`);
      onChanged();
      await scan();
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(null);
    }
  };
  const mask = async () => {
    setBusy('mask');
    try {
      const byTable = new Map<string, Record<string, MaskKind>>();
      for (const f of chosen) byTable.set(f.object, { ...(byTable.get(f.object) ?? {}), [f.column]: masks[idOf(f)] ?? f.suggested_mask });
      for (const [table, columns] of byTable) await api.post(`/api/workspaces/${workspaceId}/pii/protect`, { table, columns });
      toast.success(`Masked ${chosen.length} column${chosen.length === 1 ? '' : 's'} in ${byTable.size} table${byTable.size === 1 ? '' : 's'} for everyone but the owners`);
      onChanged();
    } catch (e) {
      toast.error(errorText(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Drawer open={open} onClose={onClose} title={<span className="flex items-center gap-2"><ScanSearch className="h-4 w-4 text-zinc-500" /> Personal data</span>} width="w-[min(1040px,100vw)]">
      <div className="space-y-3 p-4" data-testid="pii-drawer">
        <p className="text-xs text-zinc-500">Columns whose names or values look like personal data, from a sample of each table. The high-confidence ones are selected. Examples are masked.</p>
        <DataTable
          label="Personal data found"
          testid="pii-findings"
          rows={findings}
          error={error}
          onRetry={() => void scan()}
          rowKey={idOf}
          selected={selected}
          onSelectedChange={setSelected}
          empty="No personal data found in the tables' samples."
          rowProps={(f) => ({ 'data-column': idOf(f) })}
          toolbar={
            selected.length > 0 ? (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-xs text-zinc-400">{selected.length} selected</span>
                {canTag && <Button size="sm" variant="ghost" onClick={() => void tag()} loading={busy === 'tag'} data-testid="pii-tag"><Tag className="h-3.5 w-3.5" /> Tag as personal data</Button>}
                {canMask && <Button size="sm" onClick={() => void mask()} loading={busy === 'mask'} data-testid="pii-mask"><ShieldCheck className="h-3.5 w-3.5" /> Mask for everyone but owners</Button>}
              </div>
            ) : undefined
          }
          columns={[
            { key: 'col', header: 'Column', sortValue: idOf, cell: (f) => <span className="font-mono">{f.object}.<span className="text-zinc-100">{f.column}</span></span> },
            { key: 'kind', header: 'Looks like', sortValue: (f) => f.kind, cell: (f) => LABEL[f.kind] ?? f.kind },
            { key: 'conf', header: 'Confidence', sortValue: (f) => (f.confidence === 'high' ? 0 : 1), cell: (f) => <Badge tone={f.confidence === 'high' ? 'error' : 'warn'}>{f.confidence}</Badge> },
            { key: 'why', header: 'Because', cell: (f) => (f.evidence === 'name' ? 'its name' : `${f.evidence === 'both' ? 'its name and ' : ''}${Math.round((f.match_rate ?? 0) * 100)}% of values`) },
            { key: 'ex', header: 'Examples', truncate: true, cell: (f) => <span className="font-mono text-2xs text-zinc-400">{f.examples.join('  ')}</span> },
            { key: 'mask', header: 'Mask', cell: (f) => <Select uiSize="sm" aria-label={`Mask for ${idOf(f)}`} value={masks[idOf(f)] ?? f.suggested_mask} onChange={(e) => setMasks({ ...masks, [idOf(f)]: e.target.value as MaskKind })} disabled={!canMask}>{(Object.keys(MASK) as MaskKind[]).map((m) => <option key={m} value={m}>{MASK[m]}</option>)}</Select> },
            { key: 'tag', header: 'Tagged', cell: (f) => (f.tagged ? <Badge tone="error">pii</Badge> : <span className="text-zinc-500">No</span>) },
          ]}
        />
        {!canMask && <p className="text-2xs text-zinc-500">Owners of the workspace can mask these columns.</p>}
      </div>
    </Drawer>
  );
}
