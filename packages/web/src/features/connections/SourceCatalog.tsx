/**
 * The catalog of source types (grouped by family, searchable) and the connection forms each one opens. Shared by
 * Connections → Add a source and the Sources sidebar's Add source dialog, so both connect the same way.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Boxes, Cloud, Database, Globe, Layers, Plus, Search, Warehouse } from 'lucide-react';
import { api, type CloudConnection, type ConnectorConnection, type ConnectorSummary, type DatabaseConnection, type LakehouseConnection, type SourceFamily, type SourceType } from '../../api/client';
import { Badge, Input, cn } from '../../components/ui';
import { CloudWizard } from '../explorer/CloudWizard';
import { LakehouseWizard } from '../explorer/LakehouseWizard';
import { DatabaseWizard } from './DatabaseWizard';
import { ConnectorWizard } from './ConnectorWizard';
import { HttpWizard } from './HttpWizard';

export const FAMILY_ICON: Record<SourceFamily, ReactNode> = { storage: <Cloud className="h-4 w-4" />, lakehouse: <Layers className="h-4 w-4" />, database: <Database className="h-4 w-4" />, web: <Globe className="h-4 w-4" />, warehouse: <Warehouse className="h-4 w-4" />, saas: <Boxes className="h-4 w-4" /> };

export interface SourceCatalogData {
  families: Record<SourceFamily, { label: string; blurb: string }>;
  sources: SourceType[];
}

/** A connection form to open: new (from a catalog entry) or editing an existing connection. */
export type ConnectionWizard =
  | { kind: 'cloud'; provider: CloudConnection['provider'] | null; edit: CloudConnection | null }
  | { kind: 'http' }
  | { kind: 'lakehouse'; provider: LakehouseConnection['provider'] | null; edit: LakehouseConnection | null }
  | { kind: 'database'; source: SourceType | null; edit: DatabaseConnection | null }
  | { kind: 'connector'; source: SourceType | null; connector: ConnectorSummary; edit: ConnectorConnection | null };

/** The form a catalog entry opens; 'sheet' is a Google Sheets link (a sync, not a connection). */
export function wizardFor(s: SourceType, connectors: ConnectorSummary[]): ConnectionWizard | 'sheet' | null {
  const b = s.backend;
  if (b.family === 'cloud') return { kind: 'cloud', provider: b.provider, edit: null };
  if (b.family === 'lakehouse') return { kind: 'lakehouse', provider: b.provider, edit: null };
  if (b.family === 'database') return { kind: 'database', source: s, edit: null };
  if (b.family === 'connector') {
    const c = connectors.find((k) => k.id === b.connector);
    return c ? { kind: 'connector', source: s, connector: c, edit: null } : null;
  }
  if (b.family === 'http') return s.id === 'google_sheets_link' ? 'sheet' : { kind: 'http' };
  return null;
}

const authLabel = (s: SourceType, connectors: ConnectorSummary[]) =>
  s.auth === 'keys' ? 'access keys' : s.auth === 'token' ? 'token' : s.auth === 'password' ? 'password' : s.auth === 'file' ? 'file' : s.auth === 'connection_string' ? 'connection string' : s.auth === 'oauth' ? (s.backend.family === 'connector' && connectors.find((k) => k.id === (s.backend as { connector: string }).connector)?.auth.kind === 'google' ? 'Google account' : 'OAuth') : 'no auth';

/** Loads the catalog and the connector list once. */
export function useSourceCatalog() {
  const [catalog, setCatalog] = useState<SourceCatalogData | null>(null);
  const [connectors, setConnectors] = useState<ConnectorSummary[]>([]);
  useEffect(() => {
    void Promise.all([api.get<SourceCatalogData>('/api/sources/catalog'), api.get<{ connectors: ConnectorSummary[] }>('/api/connectors')]).then(([c, k]) => {
      setCatalog(c);
      setConnectors(k.connectors);
    }, () => undefined);
  }, []);
  return { catalog, connectors };
}

/** Every source type as a searchable list grouped by family; choosing one calls `onChoose`. */
export function SourceCatalog({ catalog, connectors, canEdit, onChoose, compact = false, autoFocus = true }: { catalog: SourceCatalogData; connectors: ConnectorSummary[]; canEdit: boolean; onChoose: (s: SourceType) => void; compact?: boolean; autoFocus?: boolean }) {
  const [filter, setFilter] = useState('');
  const q = filter.trim().toLowerCase();
  const matches = (s: SourceType) => !q || `${s.label} ${s.vendor} ${s.blurb} ${s.family}`.toLowerCase().includes(q);
  return (
    <div className={compact ? 'space-y-4' : 'space-y-5'}>
      <div className="relative max-w-md">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" />
        <Input autoFocus={autoFocus} value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search sources — postgres, sheets, iceberg…" aria-label="Search sources" className="pl-8" />
      </div>
      {(Object.keys(catalog.families) as SourceFamily[]).map((fam) => {
        const items = catalog.sources.filter((s) => s.family === fam && matches(s) && !(compact && s.status === 'planned'));
        if (!items.length) return null;
        return (
          <section key={fam}>
            <div className="mb-2 flex items-baseline gap-2">
              <span className="text-zinc-500">{FAMILY_ICON[fam]}</span>
              <h3 className="text-body font-semibold text-zinc-100">{catalog.families[fam].label}</h3>
              {!compact && <span className="truncate text-xs text-zinc-500">{catalog.families[fam].blurb}</span>}
            </div>
            <div className={cn('grid gap-x-6 border-t border-zinc-800', compact ? 'sm:grid-cols-2' : 'md:grid-cols-2 xl:grid-cols-3')}>
              {items.map((s) => (
                <button key={s.id} type="button" data-source={s.id} disabled={s.status === 'planned' || !canEdit} onClick={() => onChoose(s)} className={cn('group flex items-start gap-3 border-b border-zinc-800/70 px-1 py-2.5 text-left', s.status === 'planned' ? 'cursor-default opacity-50' : 'hover:bg-zinc-900')} title={s.status === 'planned' ? 'Planned — not available yet' : `Connect ${s.label}`}>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-body font-medium text-zinc-100">{s.label}</span>
                      {s.status === 'planned' && <Badge>planned</Badge>}
                    </div>
                    <div className="truncate text-xs text-zinc-500">{s.blurb}</div>
                    {!compact && (
                      <div className="mt-0.5 truncate text-2xs text-zinc-500">
                        {[s.capabilities.attach && 'attach', s.capabilities.browse && 'browse', s.capabilities.remote_sql && 'remote SQL', s.capabilities.sync && 'sync'].filter(Boolean).join(' · ')}
                        {' · '}
                        {authLabel(s, connectors)}
                      </div>
                    )}
                  </div>
                  {s.status !== 'planned' && <Plus className="mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-500 group-hover:text-zinc-200" />}
                </button>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

/** Mounts the connection form for `wizard`; each form tests the connection before saving. */
export function ConnectionWizards({ wizard, onClose, onSaved, googleConfigured = false, isAdmin = false, onGoogleConfigured }: { wizard: ConnectionWizard | null; onClose: () => void; onSaved: () => void; googleConfigured?: boolean; isAdmin?: boolean; onGoogleConfigured?: () => void }) {
  return (
    <>
      <CloudWizard open={wizard?.kind === 'cloud'} initialProvider={wizard?.kind === 'cloud' ? wizard.provider : null} initial={wizard?.kind === 'cloud' ? wizard.edit : null} onClose={onClose} onCreated={onSaved} />
      <HttpWizard open={wizard?.kind === 'http'} onClose={onClose} onSaved={onSaved} />
      <LakehouseWizard open={wizard?.kind === 'lakehouse'} initialProvider={wizard?.kind === 'lakehouse' ? wizard.provider : null} initial={wizard?.kind === 'lakehouse' ? wizard.edit : null} onClose={onClose} onCreated={onSaved} />
      <DatabaseWizard open={wizard?.kind === 'database'} source={wizard?.kind === 'database' ? wizard.source : null} initial={wizard?.kind === 'database' ? wizard.edit : null} onClose={onClose} onSaved={onSaved} />
      <ConnectorWizard open={wizard?.kind === 'connector'} source={wizard?.kind === 'connector' ? wizard.source : null} connector={wizard?.kind === 'connector' ? wizard.connector : null} initial={wizard?.kind === 'connector' ? wizard.edit : null} googleConfigured={googleConfigured} isAdmin={isAdmin} onClose={onClose} onSaved={onSaved} onGoogleConfigured={onGoogleConfigured} />
    </>
  );
}
