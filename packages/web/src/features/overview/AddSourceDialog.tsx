/**
 * Add source: one dialog for everything that brings data into a workspace.
 *
 * - Local: add a folder (read in place), upload files (with where they land), or open one file in place.
 * - Remote: the connections this person already has (reusable, no retyping keys) and every source type, whose
 *   form tests the connection before it saves.
 */
import { useRef, useState } from 'react';
import { Cloud, Database, FileSearch, FolderPlus, Layers, Plug, UploadCloud, Boxes } from 'lucide-react';
import type { CloudConnection, ConnectorConnection, DatabaseConnection, LakehouseConnection, SourceType } from '../../api/client';
import { Button, Modal, Select, Tabs, cn } from '../../components/ui';
import { SourceCatalog, useSourceCatalog } from '../connections/SourceCatalog';

export type AddSourceTab = 'local' | 'remote';
export interface ExistingSources {
  cloud: CloudConnection[];
  lakehouse: LakehouseConnection[];
  databases: DatabaseConnection[];
  connectors: ConnectorConnection[];
}

export function AddSourceDialog({
  open,
  onClose,
  tab,
  onTab,
  canWrite,
  sources,
  folders,
  onAddFolder,
  onOpenFile,
  onFiles,
  onUploadDir,
  onUseConnection,
  onChooseSource,
}: {
  open: boolean;
  onClose: () => void;
  tab: AddSourceTab;
  onTab: (t: AddSourceTab) => void;
  canWrite: boolean;
  sources: ExistingSources | null;
  folders: { folders: { path: string; name: string }[]; data_directory: string; upload_dir: string } | null;
  onAddFolder: () => void;
  onOpenFile: () => void;
  onFiles: (files: File[]) => void;
  onUploadDir: (path: string | null) => void;
  /** An existing connection: browse it (buckets) or show it in the sidebar. */
  onUseConnection: (id: string) => void;
  onChooseSource: (s: SourceType) => void;
}) {
  const { catalog, connectors } = useSourceCatalog();
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const existing = sources
    ? [
        ...sources.cloud.map((c) => ({ id: `cloud:${c.id}`, name: c.name, hint: c.provider, icon: <Cloud className="h-3.5 w-3.5" /> })),
        ...sources.databases.map((d) => ({ id: `db:${d.id}`, name: d.name, hint: d.engine, icon: <Database className="h-3.5 w-3.5" /> })),
        ...sources.lakehouse.map((l) => ({ id: `lake:${l.id}`, name: l.name, hint: l.provider.toLowerCase().replace('_', ' '), icon: <Layers className="h-3.5 w-3.5" /> })),
        ...sources.connectors.map((c) => ({ id: `conn:${c.id}`, name: c.name, hint: c.connector_label, icon: <Boxes className="h-3.5 w-3.5" /> })),
      ]
    : [];

  return (
    <Modal open={open} onClose={onClose} title="Add source" width="max-w-3xl">
      <div data-testid="add-source-dialog">
        <Tabs<AddSourceTab> value={tab} onChange={onTab} tabs={[{ id: 'local', label: 'Local' }, { id: 'remote', label: 'Remote' }]} />
        {tab === 'local' && (
          <div className="divide-y divide-zinc-800/70">
            <section className="flex items-start gap-3 py-4">
              <FolderPlus className="mt-0.5 h-4 w-4 shrink-0 text-zinc-500" />
              <div className="min-w-0 flex-1">
                <h3 className="text-body font-medium text-zinc-100">Add a folder</h3>
                <p className="text-xs text-zinc-500">Read a folder on the server in place. Nothing is copied, and new files show up as they arrive.</p>
              </div>
              <Button size="sm" onClick={onAddFolder} disabled={!canWrite} data-testid="add-source-folder">Choose a folder…</Button>
            </section>
            <section className="py-4">
              <div className="flex items-start gap-3">
                <UploadCloud className="mt-0.5 h-4 w-4 shrink-0 text-zinc-500" />
                <div className="min-w-0 flex-1">
                  <h3 className="text-body font-medium text-zinc-100">Upload files</h3>
                  <p className="text-xs text-zinc-500">Parquet, CSV, JSON, DuckDB or Excel, from this computer.</p>
                </div>
                {folders && canWrite && (
                  <label className="flex items-center gap-2 text-xs text-zinc-500">
                    Upload to
                    <Select uiSize="sm" value={folders.upload_dir === folders.data_directory ? '' : folders.upload_dir} onChange={(e) => onUploadDir(e.target.value || null)} aria-label="Where uploads go" className="max-w-48" data-testid="upload-destination">
                      <option value="">Data directory</option>
                      {folders.folders.map((f) => <option key={f.path} value={f.path}>{f.name}</option>)}
                    </Select>
                  </label>
                )}
              </div>
              <button
                type="button"
                disabled={!canWrite}
                className={cn('mt-3 flex w-full flex-col items-center gap-1 rounded-md border border-dashed px-4 py-6 text-xs transition-colors', dragging ? 'border-accent-500 bg-accent-500/10 text-zinc-200' : 'border-zinc-700 text-zinc-400 hover:border-zinc-500', !canWrite && 'cursor-not-allowed opacity-50')}
                onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => { e.preventDefault(); setDragging(false); onFiles([...e.dataTransfer.files]); onClose(); }}
                onClick={() => fileInput.current?.click()}
                data-testid="upload-drop"
              >
                <UploadCloud className="h-5 w-5 text-zinc-500" />
                <span><span className="font-medium text-zinc-200">Drop files here</span> or click to choose them</span>
              </button>
              <input ref={fileInput} type="file" multiple className="hidden" onChange={(e) => { const f = [...(e.target.files ?? [])]; e.target.value = ''; if (f.length) { onFiles(f); onClose(); } }} />
            </section>
            <section className="flex items-start gap-3 py-4">
              <FileSearch className="mt-0.5 h-4 w-4 shrink-0 text-zinc-500" />
              <div className="min-w-0 flex-1">
                <h3 className="text-body font-medium text-zinc-100">Open one file</h3>
                <p className="text-xs text-zinc-500">Profile a single file on the server or in a bucket without adding its folder.</p>
              </div>
              <Button size="sm" variant="ghost" onClick={onOpenFile} data-testid="add-source-file">Browse…</Button>
            </section>
          </div>
        )}
        {tab === 'remote' && (
          <div className="space-y-5 pt-4">
            {existing.length > 0 && (
              <section>
                <h3 className="mb-2 text-xs font-medium text-zinc-400">Your connections</h3>
                <div className="flex flex-wrap gap-1.5" data-testid="existing-connections">
                  {existing.map((c) => (
                    <button key={c.id} type="button" onClick={() => onUseConnection(c.id)} className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-zinc-800 px-2 py-1 text-xs text-zinc-200 hover:border-zinc-600 hover:bg-zinc-900" title={`Open ${c.name}`}>
                      <span className="text-zinc-500">{c.icon}</span>
                      <span className="truncate">{c.name}</span>
                      <span className="text-2xs text-zinc-500">{c.hint}</span>
                    </button>
                  ))}
                </div>
              </section>
            )}
            {catalog ? (
              <div className="max-h-[50vh] overflow-y-auto pr-1">
                <SourceCatalog catalog={catalog} connectors={connectors} canEdit={canWrite} onChoose={onChooseSource} compact autoFocus={false} />
              </div>
            ) : (
              <p className="flex items-center gap-2 text-xs text-zinc-500"><Plug className="h-3.5 w-3.5" /> Loading source types…</p>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
