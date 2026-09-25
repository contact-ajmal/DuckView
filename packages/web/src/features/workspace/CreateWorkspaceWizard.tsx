/**
 * New workspace, in five steps: basics (name, description, tags, colour), storage (memory, a new file, an existing
 * database, a folder, cloud), engine (memory, threads, timeout — defaults from the server), a starting point (empty,
 * a template, or a clone of another workspace) and people (users and teams with a role).
 */
import { useEffect, useMemo, useState } from 'react';
import { Check, Copy, LayoutTemplate, Square, Trash2, UserPlus } from 'lucide-react';
import { api, type CreateWorkspaceInput, type DirectoryUser, type Group, type StorageOptions, type WorkspaceRole } from '../../api/client';
import { Button, Field, IconButton, Input, Modal, Select, Textarea, cn, toast, errorText } from '../../components/ui';
import { useWorkspace } from '../../store/workspace';
import { useAuth } from '../../store/auth';
import { StorageChooser, toDbPath, loadStorageOptions, type StorageChoice } from './StorageChooser';

const STEPS = ['Basics', 'Storage', 'Engine', 'Start from', 'People'] as const;
type Step = (typeof STEPS)[number];
interface TemplateSummary { id: string; name: string; description: string | null; category: string; contents: { dashboards: number; queries: number; notebooks: number } }
type Start = { kind: 'empty' } | { kind: 'template'; template_id: string } | { kind: 'clone'; workspace_id: string };
type Member = { subject_type: 'user' | 'group'; subject_id: string; role: WorkspaceRole; label: string };

export function CreateWorkspaceWizard({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ws = useWorkspace();
  const me = useAuth((s) => s.user);
  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState('');
  const [color, setColor] = useState<string | null>(null);
  const [storage, setStorage] = useState<StorageChoice>({ kind: 'data', path: '' });
  const [options, setOptions] = useState<StorageOptions | null>(null);
  const [memory, setMemory] = useState('');
  const [threads, setThreads] = useState('');
  const [timeout, setTimeoutS] = useState('');
  const [start, setStart] = useState<Start>({ kind: 'empty' });
  const [templates, setTemplates] = useState<TemplateSummary[] | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [users, setUsers] = useState<DirectoryUser[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [pick, setPick] = useState('');
  const [pickRole, setPickRole] = useState<WorkspaceRole>('EDITOR');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setStep(0);
    setError(null);
    void loadStorageOptions(true).then(setOptions).catch(() => undefined);
    void api.get<{ templates: TemplateSummary[] }>('/api/templates').then((r) => setTemplates(r.templates)).catch(() => setTemplates([]));
    void api.get<{ users: DirectoryUser[] }>('/api/users/directory').then((r) => setUsers(r.users)).catch(() => setUsers([]));
    void api.get<{ groups: Group[] }>('/api/groups').then((r) => setGroups(r.groups)).catch(() => setGroups([]));
  }, [open]);

  const reset = () => {
    setName('');
    setDescription('');
    setTags('');
    setColor(null);
    setStorage({ kind: 'data', path: '' });
    setMemory('');
    setThreads('');
    setTimeoutS('');
    setStart({ kind: 'empty' });
    setMembers([]);
  };
  const close = () => {
    onClose();
    setStep(0);
  };
  // A clone is copied into a file of its own.
  const cloneNeedsFile = start.kind === 'clone' && !(storage.kind === 'data' || storage.kind === 'folder');
  const cloneable = ws.workspaces.filter((w) => w.role === 'OWNER' || w.role === 'EDITOR');
  const d = options?.engine_defaults;
  const problem = useMemo(() => {
    if (step === 0 && !name.trim()) return 'Give the workspace a name';
    if (step === 1 && (storage.kind === 'folder' || storage.kind === 'existing') && !storage.path.trim()) return storage.kind === 'existing' ? 'Choose the database file' : 'Choose where the file goes';
    if (step === 2 && threads && !/^\d+$/.test(threads)) return 'Threads is a whole number, or empty for automatic';
    if (step === 2 && timeout && !/^\d+$/.test(timeout)) return 'The timeout is a whole number of seconds';
    if (step === 3 && start.kind === 'template' && !start.template_id) return 'Choose a template';
    if (step === 3 && start.kind === 'clone' && !start.workspace_id) return 'Choose the workspace to clone';
    return null;
  }, [step, name, storage, threads, timeout, start]);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const engine_settings: CreateWorkspaceInput['engine_settings'] = {};
      if (memory.trim()) engine_settings.memory_limit = memory.trim();
      if (threads.trim()) engine_settings.threads = Number(threads);
      if (timeout.trim()) engine_settings.query_timeout_seconds = Number(timeout);
      const input: CreateWorkspaceInput = {
        name: name.trim(),
        description: description.trim() || null,
        tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
        color,
        ...toDbPath(storage, options),
        engine_settings,
        start_from: start,
        members: members.map(({ label: _l, ...m }) => m),
      };
      // A clone into the data directory needs a file name even when the person left it to the server.
      if (start.kind === 'clone' && !input.active_db_path) input.active_db_path = (await api.get<{ path: string }>(`/api/workspaces/suggest-db-path?name=${encodeURIComponent(name)}`)).path;
      const w = await ws.createWorkspace(input);
      toast.success(w.started && w.started.kind !== 'empty' ? `Created ${w.name}. ${w.started.detail}` : `Created ${w.name}`);
      reset();
      close();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const addMember = () => {
    const [kind, id] = pick.split(':') as ['user' | 'group', string];
    if (!id || members.some((m) => m.subject_id === id)) return;
    const label = kind === 'user' ? users.find((u) => u.id === id)?.display_name ?? users.find((u) => u.id === id)?.email ?? id : groups.find((g) => g.id === id)?.name ?? id;
    setMembers([...members, { subject_type: kind, subject_id: id, role: pickRole, label }]);
    setPick('');
  };

  const current: Step = STEPS[step]!;
  return (
    <Modal open={open} onClose={close} title="New workspace" width="max-w-3xl">
      <div className="space-y-4" data-testid="create-workspace">
        {/* The steps are a sequence, so they are numbered. */}
        <ol className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs" aria-label="Steps">
          {STEPS.map((s, i) => (
            <li key={s}>
              <button type="button" disabled={i > step && !!problem} onClick={() => (i <= step || !problem) && setStep(i)} aria-current={i === step ? 'step' : undefined} className={cn('flex items-center gap-1.5', i === step ? 'text-zinc-50' : i < step ? 'text-zinc-300 hover:text-zinc-100' : 'text-zinc-500')}>
                <span className={cn('flex h-5 w-5 items-center justify-center rounded-full border text-2xs tabular-nums', i === step ? 'border-accent-500 bg-accent-500 text-[color:var(--accent-ink)]' : i < step ? 'border-zinc-600' : 'border-zinc-800')}>{i < step ? <Check className="h-3 w-3" /> : i + 1}</span>
                {s}
              </button>
            </li>
          ))}
        </ol>

        <div className="min-h-72 border-t border-zinc-800 pt-4">
          {current === 'Basics' && (
            <div className="space-y-3">
              <Field label="Name" htmlFor="ws-name">
                <Input id="ws-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Marketing analytics" data-testid="ws-name" />
              </Field>
              <Field label="Description" hint="One line on what this workspace is for." htmlFor="ws-desc">
                <Textarea id="ws-desc" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Campaign performance and attribution for the growth team" />
              </Field>
              <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
                <Field label="Tags" hint="Separated by commas, e.g. finance, eu" htmlFor="ws-tags">
                  <Input id="ws-tags" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="marketing, q3" data-testid="ws-tags" />
                </Field>
                <Field label="Colour">
                  <div className="flex h-[var(--control-h)] items-center gap-1.5" role="radiogroup" aria-label="Colour">
                    <button type="button" role="radio" aria-checked={color === null} aria-label="No colour" onClick={() => setColor(null)} className={cn('h-5 w-5 rounded-full border border-zinc-700', color === null && 'ring-2 ring-accent-500 ring-offset-1 ring-offset-zinc-950')} />
                    {['1', '2', '3', '4', '5', '6', '7', '8'].map((c) => (
                      <button key={c} type="button" role="radio" aria-checked={color === c} aria-label={`Colour ${c}`} onClick={() => setColor(c)} className={cn('h-5 w-5 rounded-full', color === c && 'ring-2 ring-accent-500 ring-offset-1 ring-offset-zinc-950')} style={{ background: `var(--series-${c})` }} />
                    ))}
                  </div>
                </Field>
              </div>
            </div>
          )}

          {current === 'Storage' && (
            <div className="space-y-2">
              <p className="text-xs text-zinc-500">Where the workspace's database lives. Folders with data files are added later, from Sources.</p>
              <StorageChooser value={storage} onChange={setStorage} suggestedName={name} allowExisting compact />
            </div>
          )}

          {current === 'Engine' && (
            <div className="space-y-3">
              <p className="text-xs text-zinc-500">Leave a field empty to use the server's default. You can change these later in Settings → Engine.</p>
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Memory limit" hint={`Default ${d?.memory_limit ?? '80%'}; e.g. 4GB or 50%`} htmlFor="ws-mem">
                  <Input id="ws-mem" value={memory} onChange={(e) => setMemory(e.target.value)} placeholder={d?.memory_limit ?? '80%'} className="font-mono" />
                </Field>
                <Field label="Threads" hint={`Default ${d?.threads ?? 'auto'}`} htmlFor="ws-threads">
                  <Input id="ws-threads" value={threads} onChange={(e) => setThreads(e.target.value)} placeholder={String(d?.threads ?? 'auto')} inputMode="numeric" className="font-mono" />
                </Field>
                <Field label="Query timeout" hint={`Seconds; default ${d?.query_timeout_seconds ?? 60}`} htmlFor="ws-timeout">
                  <Input id="ws-timeout" value={timeout} onChange={(e) => setTimeoutS(e.target.value)} placeholder={String(d?.query_timeout_seconds ?? 60)} inputMode="numeric" className="font-mono" />
                </Field>
              </div>
            </div>
          )}

          {current === 'Start from' && (
            <div className="space-y-3">
              <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Start from">
                {([
                  { kind: 'empty', label: 'Empty', hint: 'A blank workspace with one query tab.', icon: <Square className="h-4 w-4" /> },
                  { kind: 'template', label: 'A template', hint: 'Dashboards, queries and notebooks, with sample data.', icon: <LayoutTemplate className="h-4 w-4" /> },
                  { kind: 'clone', label: 'A copy of a workspace', hint: 'Its tables, folders, dashboards, queries and notebooks.', icon: <Copy className="h-4 w-4" /> },
                ] as const).map((o) => (
                  <button key={o.kind} type="button" role="radio" aria-checked={start.kind === o.kind} data-start={o.kind} onClick={() => setStart(o.kind === 'empty' ? { kind: 'empty' } : o.kind === 'template' ? { kind: 'template', template_id: '' } : { kind: 'clone', workspace_id: ws.activeId ?? '' })} className={cn('rounded-md border p-2.5 text-left', start.kind === o.kind ? 'border-accent-500 bg-accent-500/10' : 'border-zinc-800 hover:border-zinc-600')}>
                    <div className="flex items-center gap-1.5 text-body font-medium text-zinc-100">{o.icon} {o.label}</div>
                    <div className="mt-1 text-2xs text-zinc-500">{o.hint}</div>
                  </button>
                ))}
              </div>
              {start.kind === 'template' && (
                <Field label="Template" htmlFor="ws-template">
                  <Select id="ws-template" value={start.template_id} onChange={(e) => setStart({ kind: 'template', template_id: e.target.value })} className="w-full" data-testid="ws-template">
                    <option value="">Choose a template…</option>
                    {(templates ?? []).map((t) => <option key={t.id} value={t.id}>{t.name} · {t.category} · {t.contents.dashboards} dashboards</option>)}
                  </Select>
                </Field>
              )}
              {start.kind === 'clone' && (
                <>
                  <Field label="Workspace to copy" htmlFor="ws-clone">
                    <Select id="ws-clone" value={start.workspace_id} onChange={(e) => setStart({ kind: 'clone', workspace_id: e.target.value })} className="w-full" data-testid="ws-clone">
                      <option value="">Choose a workspace…</option>
                      {cloneable.map((w) => <option key={w.id} value={w.id}>{w.name}{w.shared ? ` · ${w.owner.email}` : ''}</option>)}
                    </Select>
                  </Field>
                  {cloneNeedsFile && (
                    <p className="text-xs text-amber-300">A copy needs its own database file. <button type="button" className="underline" onClick={() => setStorage({ kind: 'data', path: '' })}>Store it in the data directory</button>, or go back to Storage and choose a folder.</p>
                  )}
                </>
              )}
            </div>
          )}

          {current === 'People' && (
            <div className="space-y-3">
              <p className="text-xs text-zinc-500">You ({me?.email}) own the workspace. Add people or teams now, or share it later. Teams provisioned from your identity provider keep their membership in sync.</p>
              <div className="flex flex-wrap items-end gap-2">
                <Field label="Person or team" htmlFor="ws-member" className="min-w-56 flex-1">
                  <Select id="ws-member" value={pick} onChange={(e) => setPick(e.target.value)} className="w-full" data-testid="ws-member">
                    <option value="">Choose…</option>
                    {groups.length > 0 && <optgroup label="Teams">{groups.map((g) => <option key={g.id} value={`group:${g.id}`}>{g.name}{g.external_id ? ' (from your identity provider)' : ''}</option>)}</optgroup>}
                    <optgroup label="People">{users.filter((u) => u.id !== me?.id).map((u) => <option key={u.id} value={`user:${u.id}`}>{u.display_name ? `${u.display_name} · ${u.email}` : u.email}</option>)}</optgroup>
                  </Select>
                </Field>
                <Field label="Role" htmlFor="ws-role">
                  <Select id="ws-role" value={pickRole} onChange={(e) => setPickRole(e.target.value as WorkspaceRole)}>
                    <option value="VIEWER">Viewer</option>
                    <option value="EDITOR">Editor</option>
                    <option value="OWNER">Owner</option>
                  </Select>
                </Field>
                <Button onClick={addMember} disabled={!pick} data-testid="ws-add-member"><UserPlus className="h-3.5 w-3.5" /> Add</Button>
              </div>
              {members.length > 0 && (
                <ul className="divide-y divide-zinc-800/70 border-y border-zinc-800/70" data-testid="ws-members">
                  {members.map((m) => (
                    <li key={m.subject_id} className="flex items-center gap-2 py-1.5 text-body">
                      <span className="min-w-0 flex-1 truncate text-zinc-200">{m.label}{m.subject_type === 'group' && <span className="text-zinc-500"> · team</span>}</span>
                      <Select uiSize="sm" aria-label={`Role of ${m.label}`} value={m.role} onChange={(e) => setMembers(members.map((x) => (x.subject_id === m.subject_id ? { ...x, role: e.target.value as WorkspaceRole } : x)))}>
                        <option value="VIEWER">Viewer</option>
                        <option value="EDITOR">Editor</option>
                        <option value="OWNER">Owner</option>
                      </Select>
                      <IconButton label={`Remove ${m.label}`} onClick={() => setMembers(members.filter((x) => x.subject_id !== m.subject_id))}><Trash2 className="h-3.5 w-3.5" /></IconButton>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        {error && <p className="text-xs text-red-400" role="alert">{error.split('\n')[0]}</p>}
        <div className="flex items-center gap-2 border-t border-zinc-800 pt-3">
          <span className="min-w-0 flex-1 truncate text-xs text-zinc-500">{problem ?? (cloneNeedsFile && step >= 3 ? 'A copy needs its own database file' : '')}</span>
          <Button variant="ghost" onClick={close}>Cancel</Button>
          {step > 0 && <Button onClick={() => setStep(step - 1)}>Back</Button>}
          {step < STEPS.length - 1 ? (
            <Button variant="primary" onClick={() => setStep(step + 1)} disabled={!!problem} data-testid="ws-next">Next</Button>
          ) : null}
          {(step === STEPS.length - 1 || step >= 1) && (
            <Button variant={step === STEPS.length - 1 ? 'primary' : 'secondary'} onClick={() => void create()} loading={busy} disabled={!!problem || !name.trim() || cloneNeedsFile || (start.kind === 'template' && !start.template_id) || (start.kind === 'clone' && !start.workspace_id)} data-testid="ws-create">
              Create workspace
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
