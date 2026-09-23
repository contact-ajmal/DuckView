import { useEffect, useMemo, useState } from 'react';
import { Workflow } from 'lucide-react';
import { api, type DbtProject, type DbtRun } from '../../api/client';
import { Button, Input, Label, Modal, Select } from '../../components/ui';

/** `-- dbt model: models/marts/revenue.sql` on the first line (how Copilot labels a model) → folder and name. */
export function parseDbtModelHeader(sql: string): { sql: string; name: string | null; folder: string | null } {
  const m = /^\s*--\s*dbt model:\s*(?:models\/)?((?:[\w-]+\/)*)([A-Za-z_]\w*)(?:\.sql)?\s*\n/i.exec(sql);
  if (!m) return { sql, name: null, folder: null };
  return { sql: sql.slice(m[0].length), name: m[2]!, folder: m[1]!.replace(/\/$/, '') || null };
}

export function looksLikeDbtModel(sql: string): boolean {
  return /^\s*--\s*dbt model:/i.test(sql) || /\{\{\s*(ref|source|config)\s*\(/.test(sql);
}

const MINIMAL_PROJECT = (name: string) => {
  const slug = name.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, '_$1') || 'project';
  return { 'dbt_project.yml': `name: ${slug}\nversion: '1.0'\nprofile: duckview\n\nmodel-paths: [models]\nseed-paths: [seeds]\nmacro-paths: [macros]\ntest-paths: [tests]\n\nmodels:\n  ${slug}:\n    +materialized: view\n` };
};

/**
 * Save a SELECT as a model of a dbt project (from the Query workbench or a Copilot answer): pick or create the
 * project, name it, choose how it is materialised, optionally build it straight away.
 */
export function SaveDbtModelDialog({ workspaceId, sql: rawSql, suggestedName, onClose }: { workspaceId: string; sql: string; suggestedName?: string; onClose: () => void }) {
  const parsed = useMemo(() => parseDbtModelHeader(rawSql), [rawSql]);
  const hasConfig = /\{\{\s*config\s*\(/.test(parsed.sql);
  const [projects, setProjects] = useState<DbtProject[] | null>(null);
  const [projectId, setProjectId] = useState('');
  const [newProject, setNewProject] = useState('Analytics models');
  const [name, setName] = useState(parsed.name ?? (suggestedName ?? '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'm_$1'));
  const [folder, setFolder] = useState(parsed.folder ?? 'marts');
  const [materialized, setMaterialized] = useState<'view' | 'table' | 'incremental'>('table');
  const [uniqueKey, setUniqueKey] = useState('');
  const [description, setDescription] = useState('');
  const [build, setBuild] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void api.get<{ projects: DbtProject[] }>(`/api/workspaces/${workspaceId}/dbt/projects`).then((r) => {
      setProjects(r.projects);
      setProjectId(r.projects[0]?.id ?? 'new');
    }).catch((e) => setError((e as Error).message));
  }, [workspaceId]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      let id = projectId;
      if (id === 'new') id = (await api.post<{ project: DbtProject }>(`/api/workspaces/${workspaceId}/dbt/projects`, { name: newProject.trim() || 'Analytics models', files: MINIMAL_PROJECT(newProject) })).project.id;
      await api.post(`/api/dbt/projects/${id}/models`, { name, sql: parsed.sql, folder: folder || null, materialized, unique_key: materialized === 'incremental' ? uniqueKey || null : null, description: description || null });
      if (build) await api.post<{ run: DbtRun }>(`/api/dbt/projects/${id}/runs`, { command: 'build', select: name });
      onClose();
      location.hash = `#/transform/dbt/${id}`;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} title="Save as dbt model" width="max-w-xl">
      <div className="space-y-3 text-xs">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <Label>Project</Label>
            <Select value={projectId} onChange={(e) => setProjectId(e.target.value)} data-testid="dbt-model-project">
              {(projects ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              <option value="new">New project…</option>
            </Select>
          </div>
          {projectId === 'new' && <div><Label>New project name</Label><Input value={newProject} onChange={(e) => setNewProject(e.target.value)} /></div>}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div><Label>Model name</Label><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="daily_revenue" className="font-mono" data-testid="dbt-model-name" /></div>
          <div><Label>Folder under models/</Label><Input value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="marts" className="font-mono" /></div>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <Label>Materialized as</Label>
            <Select value={materialized} onChange={(e) => setMaterialized(e.target.value as typeof materialized)} disabled={hasConfig} title={hasConfig ? 'The SQL has its own config() block' : undefined}>
              <option value="view">view</option>
              <option value="table">table</option>
              <option value="incremental">incremental</option>
            </Select>
          </div>
          {materialized === 'incremental' && !hasConfig && <div><Label>Unique key</Label><Input value={uniqueKey} onChange={(e) => setUniqueKey(e.target.value)} placeholder="id" className="font-mono" /></div>}
        </div>
        <div><Label>Description</Label><Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What one row is — becomes a catalog note" /></div>
        <pre className="max-h-40 overflow-auto rounded-md border border-zinc-800 bg-zinc-950 p-2 font-mono text-[11px] text-zinc-300">{parsed.sql.trim()}</pre>
        <p className="text-zinc-500">References to the project's own models and seeds become <span className="font-mono">{"{{ ref('…') }}"}</span>; other tables stay as they are.</p>
        <label className="flex items-center gap-1.5 text-zinc-400"><input type="checkbox" checked={build} onChange={(e) => setBuild(e.target.checked)} /> Build it now (dbt build --select {name || 'model'})</label>
        {error && <div className="rounded-md border border-red-900 bg-red-950/50 px-3 py-2 font-mono text-red-200">{error}</div>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy || !name.trim() || projects === null || !projectId} onClick={() => void save()}><Workflow className="h-3.5 w-3.5" /> Save model</Button>
        </div>
      </div>
    </Modal>
  );
}
