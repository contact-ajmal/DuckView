/**
 * Git sync: a workspace's definitions kept in a Git repository, as files people can read and review.
 *
 *   <path>/notebooks/<name>.yml      title and cells (SQL and text as block scalars)
 *   <path>/queries/<folder>/<name>.sql   the SQL, with id / name / description / tags in a header comment
 *   <path>/dashboards/<name>.yml     layout, widgets (with their SQL) or the Mosaic spec
 *   <path>/metrics/semantic.yml      the semantic layer's hand-written YAML
 *   <path>/dbt/<project>/…           the project's files, and duckview.yml (id, vars, target schema)
 *
 * Push writes those folders from the workspace (other files in the repository are left alone), commits as the
 * person pushing and pushes the branch. It refuses while the repository has commits this workspace has not pulled,
 * so nobody's work is overwritten. Pull brings the branch in: every object whose file differs is updated through its
 * service (validation, permissions, audit) and recorded as a revision "Pulled from Git <sha>"; files without a known
 * id become new objects. Objects that are in the workspace but not in the repository are listed, never deleted.
 *
 * git runs with a throwaway HOME, no prompts and no system config; an HTTPS token is sent as a header for that one
 * command, never written to disk, and scrubbed from errors.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import YAML from 'yaml';
import type { MetadataStore } from '../db/index.js';
import type { GitSync, LayoutItem, NotebookCell } from '../db/schema/sqlite.js';
import type { DuckViewConfig } from '../config/index.js';
import { CredentialCipher, newId } from '../security/crypto.js';
import type { Principal } from './principal.js';
import { requireWrite } from './principal.js';
import type { WorkspaceService } from './workspaces.js';
import type { AuditService } from './audit.js';
import type { RevisionService } from './revisions.js';
import type { NotebookService } from './notebooks.js';
import type { SavedQueryService, DashboardService } from './bi.js';
import type { SemanticService } from './semantic.js';
import type { DbtService } from './dbt.js';
import { badRequest, conflict, notFound } from './errors.js';

export type PublicGitSync = Omit<GitSync, 'encrypted_secret' | 'iv' | 'tag'> & { has_token: boolean };
export interface GitChange { status: string; path: string }
export interface PullResult { sha: string | null; created: string[]; updated: string[]; unchanged: number; conflicts: string[]; deleted_upstream: string[]; only_in_workspace: string[]; errors: string[] }

const MANAGED = ['notebooks', 'queries', 'dashboards', 'metrics', 'dbt'];
const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_-]+/g, '-').slice(0, 60) || 'untitled';

export class GitSyncService {
  private busy = new Set<string>();

  constructor(private readonly store: MetadataStore, private readonly cfg: DuckViewConfig, private readonly cipher: CredentialCipher, private readonly baseDir: string, private readonly workspaces: WorkspaceService, private readonly audit: AuditService, private readonly deps: { revisions: RevisionService; notebooks: NotebookService; savedQueries: SavedQueryService; dashboards: DashboardService; semantic: SemanticService; dbt: DbtService }) {}
  private get db() {
    return this.store.db;
  }
  private get s() {
    return this.store.schema;
  }

  // ------------------------------------------------------------------------------------------ settings

  private toPublic(g: GitSync): PublicGitSync {
    const { encrypted_secret, iv: _i, tag: _t, ...rest } = g;
    return { ...rest, has_token: !!encrypted_secret };
  }
  private token(g: GitSync): string | null {
    if (!g.encrypted_secret || !g.iv || !g.tag) return null;
    try {
      return this.cipher.decryptJson<{ token: string }>({ ciphertext: g.encrypted_secret, iv: g.iv, tag: g.tag }, g.id).token || null;
    } catch {
      return null;
    }
  }

  private checkUrl(url: string): string {
    const u = url.trim();
    if (/^https:\/\//i.test(u)) {
      const parsed = new URL(u);
      if (parsed.username || parsed.password) throw badRequest('Put the token in the token field, not in the URL');
      return u;
    }
    if (this.cfg.git.allow_local_repos && (/^file:\/\//i.test(u) || path.isAbsolute(u))) return u;
    throw badRequest(this.cfg.git.allow_local_repos ? 'repo_url must be https://… or a local path' : 'repo_url must be an https:// repository URL');
  }

  async get(p: Principal, workspaceId: string): Promise<PublicGitSync | null> {
    await this.workspaces.get(p, workspaceId);
    const g = (await this.db.select().from(this.s.gitSyncs).where(eq(this.s.gitSyncs.workspace_id, workspaceId)).limit(1))[0];
    return g ? this.toPublic(g) : null;
  }

  private async load(workspaceId: string): Promise<GitSync> {
    const g = (await this.db.select().from(this.s.gitSyncs).where(eq(this.s.gitSyncs.workspace_id, workspaceId)).limit(1))[0];
    if (!g) throw notFound('Git connection for this workspace');
    return g;
  }

  async configure(p: Principal, workspaceId: string, input: { repo_url: string; branch?: string; path?: string; token?: string | null }): Promise<PublicGitSync> {
    requireWrite(p);
    if (!this.cfg.git.enabled) throw badRequest('Git sync is turned off on this server (git.enabled)');
    await this.workspaces.get(p, workspaceId, 'OWNER');
    const repo_url = this.checkUrl(input.repo_url);
    const branch = (input.branch ?? 'main').trim() || 'main';
    if (!/^[\w./-]{1,100}$/.test(branch) || branch.includes('..')) throw badRequest('branch is not a valid branch name');
    const sub = (input.path ?? '').trim().replace(/^\/+|\/+$/g, '');
    if (sub.split('/').some((x) => x === '..' || x === '.git')) throw badRequest('path must stay inside the repository');
    const existing = (await this.db.select().from(this.s.gitSyncs).where(eq(this.s.gitSyncs.workspace_id, workspaceId)).limit(1))[0];
    const id = existing?.id ?? newId();
    const enc = input.token === undefined ? null : input.token ? this.cipher.encryptJson({ token: input.token }, id) : null;
    const secret = input.token === undefined ? {} : { encrypted_secret: enc?.ciphertext ?? null, iv: enc?.iv ?? null, tag: enc?.tag ?? null };
    const now = new Date();
    // A different repository or branch starts over (nothing pulled from it yet).
    const moved = existing && (existing.repo_url !== repo_url || existing.branch !== branch || existing.path !== sub);
    if (existing) {
      await this.db.update(this.s.gitSyncs).set({ repo_url, branch, path: sub, ...secret, ...(moved ? { last_pull_sha: null, last_push_sha: null, last_pull_at: null, last_push_at: null, mapping: {} } : {}), last_error: null, updated_at: now }).where(eq(this.s.gitSyncs.id, id));
      if (moved) fs.rmSync(this.workdir(workspaceId), { recursive: true, force: true });
    } else {
      await this.db.insert(this.s.gitSyncs).values({ id, workspace_id: workspaceId, repo_url, branch, path: sub, encrypted_secret: enc?.ciphertext ?? null, iv: enc?.iv ?? null, tag: enc?.tag ?? null, created_by: p.userId, mapping: {}, last_push_sha: null, last_push_at: null, last_pull_sha: null, last_pull_at: null, last_error: null, created_at: now, updated_at: now });
    }
    this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'git.configure', resource: `workspace:${workspaceId}`, queryText: `${repo_url} ${branch}${sub ? ` /${sub}` : ''}`, ip: p.ip });
    return this.toPublic(await this.load(workspaceId));
  }

  async disconnect(p: Principal, workspaceId: string): Promise<void> {
    requireWrite(p);
    await this.workspaces.get(p, workspaceId, 'OWNER');
    await this.db.delete(this.s.gitSyncs).where(eq(this.s.gitSyncs.workspace_id, workspaceId));
    fs.rmSync(this.workdir(workspaceId), { recursive: true, force: true });
    this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'git.disconnect', resource: `workspace:${workspaceId}`, ip: p.ip });
  }

  // ------------------------------------------------------------------------------------------ git

  private workdir(workspaceId: string) {
    return path.join(this.baseDir, '.duckview', 'git', workspaceId);
  }

  /** Runs git in the working copy; output on success, a readable error (token scrubbed) otherwise. */
  private git(g: GitSync, args: string[], opts: { author?: { name: string; email: string }; allowFail?: boolean } = {}): Promise<{ ok: boolean; out: string }> {
    const token = this.token(g);
    const auth = token && /^https:/i.test(g.repo_url) ? ['-c', `http.extraHeader=Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`] : [];
    const home = path.join(this.workdir(g.workspace_id), 'home');
    fs.mkdirSync(home, { recursive: true });
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: home, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_ASKPASS: 'echo', LANG: 'C', ...(opts.author ? { GIT_AUTHOR_NAME: opts.author.name, GIT_AUTHOR_EMAIL: opts.author.email, GIT_COMMITTER_NAME: opts.author.name, GIT_COMMITTER_EMAIL: opts.author.email } : {}) };
    return new Promise((resolve, reject) => {
      execFile(this.cfg.git.binary, [...auth, '-c', 'core.hooksPath=/dev/null', '-c', 'protocol.file.allow=always', ...args], { cwd: path.join(this.workdir(g.workspace_id), 'repo'), env, timeout: this.cfg.git.timeout_seconds * 1000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (!err) return resolve({ ok: true, out: stdout });
        if (opts.allowFail) return resolve({ ok: false, out: `${stdout}${stderr}` });
        const msg = `${stderr || err.message}`.replace(token ? new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g') : /$^/, '***').replace(/Basic [A-Za-z0-9+/=]+/g, 'Basic ***').trim().split('\n').filter((l) => !/^hint:/.test(l)).slice(-3).join(' ');
        reject(badRequest(`git ${args[0]}: ${msg}`));
      });
    });
  }

  /** A working copy on the branch as it is on the remote (or an empty branch when the remote has none). */
  private async sync(g: GitSync): Promise<string | null> {
    const repo = path.join(this.workdir(g.workspace_id), 'repo');
    if (!fs.existsSync(path.join(repo, '.git'))) {
      fs.mkdirSync(repo, { recursive: true });
      await this.git(g, ['init', '-q']);
      await this.git(g, ['remote', 'add', 'origin', g.repo_url]);
    } else await this.git(g, ['remote', 'set-url', 'origin', g.repo_url]);
    await this.git(g, ['fetch', '-q', '--prune', 'origin']);
    const remote = (await this.git(g, ['rev-parse', '--verify', '-q', `refs/remotes/origin/${g.branch}`], { allowFail: true })).out.trim() || null;
    if (remote) await this.git(g, ['checkout', '-q', '-f', '-B', g.branch, `refs/remotes/origin/${g.branch}`]);
    else {
      await this.git(g, ['checkout', '-q', '-f', '--orphan', g.branch], { allowFail: true });
      await this.git(g, ['rm', '-rq', '--cached', '--ignore-unmatch', '.'], { allowFail: true });
    }
    await this.git(g, ['clean', '-fdq']);
    return remote;
  }

  private root(g: GitSync) {
    return path.join(this.workdir(g.workspace_id), 'repo', g.path);
  }

  // ------------------------------------------------------------------------------------------ files

  /** The workspace as files (relative to the sync's folder). */
  async exportFiles(workspaceId: string): Promise<{ files: Map<string, string>; ids: Record<string, string> }> {
    const files = new Map<string, string>();
    /** path (a dbt project's folder) → object id */
    const ids: Record<string, string> = {};
    const { revisions } = this.deps;
    const unique = (dir: string, name: string, ext: string) => {
      let base = `${dir}/${slug(name)}`;
      for (let n = 2; files.has(`${base}${ext}`); n++) base = `${dir}/${slug(name)}-${n}`;
      return `${base}${ext}`;
    };
    const byCreated = <T extends { created_at: Date }>(rows: T[]) => rows.sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
    for (const nb of byCreated(await this.db.select().from(this.s.notebooks).where(eq(this.s.notebooks.workspace_id, workspaceId)))) {
      const snap = await revisions.snapshot(workspaceId, 'notebook', nb.id);
      const f = unique('notebooks', nb.title, '.yml');
      files.set(f, YAML.stringify({ duckview: 'notebook', id: nb.id, ...snap }, { lineWidth: 0 }));
      ids[f] = nb.id;
    }
    for (const q of byCreated(await this.db.select().from(this.s.savedQueries).where(eq(this.s.savedQueries.workspace_id, workspaceId)))) {
      const folder = q.folder ? `queries/${q.folder.split('/').map(slug).join('/')}` : 'queries';
      const header = [`-- duckview: query`, `-- id: ${q.id}`, `-- name: ${q.name.replace(/\n/g, ' ')}`, ...(q.folder ? [`-- folder: ${q.folder}`] : []), ...(q.description ? [`-- description: ${q.description.replace(/\n/g, ' ')}`] : []), ...(q.tags.length ? [`-- tags: ${q.tags.join(', ')}`] : [])];
      const f = unique(folder, q.name, '.sql');
      files.set(f, `${header.join('\n')}\n\n${q.sql_text.trim()}\n`);
      ids[f] = q.id;
    }
    for (const d of byCreated(await this.db.select().from(this.s.dashboards).where(eq(this.s.dashboards.workspace_id, workspaceId)))) {
      const snap = await revisions.snapshot(workspaceId, 'dashboard', d.id);
      const f = unique('dashboards', d.name, '.yml');
      files.set(f, YAML.stringify({ duckview: 'dashboard', id: d.id, ...snap }, { lineWidth: 0 }));
      ids[f] = d.id;
    }
    const sem = await revisions.snapshot(workspaceId, 'semantic', 'workspace');
    if (sem && String(sem.yaml ?? '').trim()) files.set('metrics/semantic.yml', String(sem.yaml));
    for (const pr of byCreated(await this.db.select().from(this.s.dbtProjects).where(eq(this.s.dbtProjects.workspace_id, workspaceId)))) {
      let dir = `dbt/${slug(pr.name)}`;
      for (let n = 2; [...files.keys()].some((k) => k.startsWith(`${dir}/`)); n++) dir = `dbt/${slug(pr.name)}-${n}`;
      for (const [f, content] of Object.entries(pr.files)) files.set(`${dir}/${f}`, content);
      files.set(`${dir}/duckview.yml`, YAML.stringify({ duckview: 'dbt', id: pr.id, name: pr.name, vars: pr.vars, target_schema: pr.target_schema }));
      ids[dir] = pr.id;
    }
    return { files, ids };
  }

  private writeTree(g: GitSync, files: Map<string, string>) {
    const root = this.root(g);
    for (const d of MANAGED) fs.rmSync(path.join(root, d), { recursive: true, force: true });
    for (const [rel, content] of files) {
      const abs = path.join(root, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }
  }

  private readTree(g: GitSync): Map<string, string> {
    const root = this.root(g);
    const out = new Map<string, string>();
    const walk = (dir: string) => {
      if (!fs.existsSync(dir)) return;
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) walk(abs);
        else if (e.isFile() && fs.statSync(abs).size <= 20 * 1024 * 1024) out.set(path.relative(root, abs).split(path.sep).join('/'), fs.readFileSync(abs, 'utf8'));
      }
    };
    for (const d of MANAGED) walk(path.join(root, d));
    return out;
  }

  // ------------------------------------------------------------------------------------------ status / push / pull

  private async locked<T>(workspaceId: string, fn: () => Promise<T>): Promise<T> {
    if (this.busy.has(workspaceId)) throw conflict('A Git push or pull is running for this workspace');
    this.busy.add(workspaceId);
    try {
      return await fn();
    } finally {
      this.busy.delete(workspaceId);
    }
  }

  private async fail<T>(g: GitSync, fn: () => Promise<T>): Promise<T> {
    try {
      const r = await fn();
      await this.db.update(this.s.gitSyncs).set({ last_error: null }).where(eq(this.s.gitSyncs.id, g.id));
      return r;
    } catch (err) {
      await this.db.update(this.s.gitSyncs).set({ last_error: (err as Error).message.slice(0, 500), updated_at: new Date() }).where(eq(this.s.gitSyncs.id, g.id));
      throw err;
    }
  }

  /** What a push would change, and whether the repository has commits to pull first. */
  async status(p: Principal, workspaceId: string): Promise<{ remote_sha: string | null; needs_pull: boolean; changes: GitChange[] }> {
    await this.workspaces.get(p, workspaceId, 'EDITOR');
    const g = await this.load(workspaceId);
    return this.locked(workspaceId, () => this.fail(g, async () => {
      const remote = await this.sync(g);
      this.writeTree(g, (await this.exportFiles(workspaceId)).files);
      const porcelain = (await this.git(g, ['status', '--porcelain', '-uall', '--', g.path || '.'])).out;
      await this.git(g, ['checkout', '-q', '-f', 'HEAD'], { allowFail: true });
      await this.git(g, ['clean', '-fdq']);
      const changes = porcelain.split('\n').filter(Boolean).map((l) => ({ status: l.slice(0, 2).trim() === '??' ? 'added' : l[1] === 'D' || l[0] === 'D' ? 'deleted' : 'modified', path: l.slice(3).replace(/^"|"$/g, '') }));
      return { remote_sha: remote, needs_pull: !!remote && remote !== g.last_pull_sha && remote !== g.last_push_sha, changes };
    }));
  }

  async push(p: Principal, workspaceId: string, message?: string | null): Promise<{ pushed: boolean; sha: string | null; files: number }> {
    requireWrite(p);
    await this.workspaces.get(p, workspaceId, 'EDITOR');
    const g = await this.load(workspaceId);
    return this.locked(workspaceId, () => this.fail(g, async () => {
      const remote = await this.sync(g);
      if (remote && remote !== g.last_pull_sha && remote !== g.last_push_sha) throw conflict(`The repository has commits this workspace has not pulled (${remote.slice(0, 7)}) — pull first, then push`);
      const { files, ids } = await this.exportFiles(workspaceId);
      this.writeTree(g, files);
      await this.git(g, ['add', '-A', '--', g.path || '.']);
      const changed = !(await this.git(g, ['diff', '--cached', '--quiet'], { allowFail: true })).ok;
      if (!changed) {
        await this.db.update(this.s.gitSyncs).set({ mapping: ids }).where(eq(this.s.gitSyncs.id, g.id));
        return { pushed: false, sha: remote, files: files.size };
      }
      const user = (await this.db.select({ email: this.s.users.email, display_name: this.s.users.display_name }).from(this.s.users).where(eq(this.s.users.id, p.userId)).limit(1))[0];
      const author = { name: user?.display_name ?? user?.email ?? 'DuckView', email: user?.email ?? 'duckview@localhost' };
      await this.git(g, ['commit', '-q', '-m', message?.trim() || `DuckView: update from ${author.name}`], { author });
      await this.git(g, ['push', '-q', 'origin', `HEAD:refs/heads/${g.branch}`]);
      const sha = (await this.git(g, ['rev-parse', 'HEAD'])).out.trim();
      await this.db.update(this.s.gitSyncs).set({ last_push_sha: sha, last_push_at: new Date(), mapping: ids, updated_at: new Date() }).where(eq(this.s.gitSyncs.id, g.id));
      this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'git.push', resource: `workspace:${workspaceId}`, queryText: sha, ip: p.ip });
      return { pushed: true, sha, files: files.size };
    }));
  }

  /**
   * Brings in what changed in the repository since this workspace last pushed or pulled. A changed file updates its
   * object (or creates one); files nobody changed upstream are left alone, so local edits that were not pushed yet
   * survive. When an object changed on both sides, the repository wins and the local version stays in its history
   * (reported as a conflict). Objects are matched by the id in the file, else by the file's path in this workspace.
   */
  async pull(p: Principal, workspaceId: string): Promise<PullResult> {
    requireWrite(p);
    await this.workspaces.get(p, workspaceId, 'EDITOR');
    const g = await this.load(workspaceId);
    return this.locked(workspaceId, () => this.fail(g, async () => {
      const sha = await this.sync(g);
      const result: PullResult = { sha, created: [], updated: [], unchanged: 0, conflicts: [], deleted_upstream: [], only_in_workspace: [], errors: [] };
      if (!sha) return result;
      const message = `Pulled from Git ${sha.slice(0, 7)}`;
      const files = this.readTree(g);
      const { revisions, notebooks, savedQueries, dashboards, semantic, dbt } = this.deps;
      const rel = (f: string) => (g.path ? f.slice(g.path.length + 1) : f);

      // What changed upstream since the last push or pull (null: never synced — everything counts).
      const pulledLast = (g.last_pull_at?.getTime() ?? 0) >= (g.last_push_at?.getTime() ?? 0);
      const baseSha = pulledLast ? g.last_pull_sha ?? g.last_push_sha : g.last_push_sha ?? g.last_pull_sha;
      const since = [g.last_pull_at, g.last_push_at].filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
      let changed: Set<string> | null = null;
      if (baseSha) {
        const diff = await this.git(g, ['diff', '--name-only', baseSha, sha, '--', g.path || '.'], { allowFail: true });
        if (diff.ok) changed = new Set(diff.out.split('\n').filter(Boolean).map(rel));
        const gone = await this.git(g, ['diff', '--name-only', '--diff-filter=D', baseSha, sha, '--', g.path || '.'], { allowFail: true });
        if (gone.ok) result.deleted_upstream = gone.out.split('\n').filter(Boolean).map(rel).filter((f) => MANAGED.includes(f.split('/')[0]!));
      }
      const isChanged = (f: string) => !changed || changed.has(f) || [...changed].some((c) => c.startsWith(`${f}/`));
      const mapping: Record<string, string> = {};
      const table = { notebook: this.s.notebooks, dashboard: this.s.dashboards, query: this.s.savedQueries, dbt: this.s.dbtProjects } as const;
      const mine = async (type: keyof typeof table, id: unknown) => typeof id === 'string' && (await this.db.select({ w: table[type].workspace_id }).from(table[type]).where(eq(table[type].id, id)).limit(1))[0]?.w === workspaceId;
      const resolve = async (type: keyof typeof table, fileId: unknown, f: string): Promise<string | null> => ((await mine(type, fileId)) ? (fileId as string) : (await mine(type, g.mapping[f])) ? g.mapping[f]! : null);
      const editedHere = async (type: 'notebook' | 'dashboard' | 'query' | 'semantic' | 'dbt', id: string) => {
        if (!since) return false;
        const latest = (await revisions.list(p, workspaceId, type, id))[0];
        return !!latest && latest.updated_at.getTime() > since.getTime() && !(latest.message ?? '').startsWith('Pulled from Git');
      };
      const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
      const tryIt = async (label: string, fn: () => Promise<void>) => {
        try {
          await fn();
        } catch (err) {
          result.errors.push(`${label}: ${(err as Error).message.split('\n')[0]}`);
        }
      };
      /** Update an existing object from its file, or create one; a file untouched upstream only maps. */
      const apply = async (type: keyof typeof table, f: string, fileId: unknown, snap: Record<string, unknown>, create: () => Promise<string>, update: (id: string) => Promise<unknown>) => {
        const id = await resolve(type, fileId, f);
        if (id) {
          mapping[f] = id;
          if (!isChanged(f) || same(await revisions.snapshot(workspaceId, type, id), snap)) return void result.unchanged++;
          if (await editedHere(type, id)) result.conflicts.push(f);
          await revisions.as(p.userId, workspaceId, type, id, message, () => update(id));
          result.updated.push(f);
        } else if (isChanged(f)) {
          // (A file nobody changed whose object is gone here was deleted here: it is not brought back.)
          const nid = await create();
          mapping[f] = nid;
          await revisions.record(p.userId, workspaceId, type, nid, { message });
          result.created.push(f);
        }
      };

      for (const [f, text] of files) {
        if (!/^(notebooks|dashboards)\/[^/]+\.ya?ml$/.test(f)) continue;
        await tryIt(f, async () => {
          const doc = YAML.parse(text) as Record<string, unknown>;
          const { duckview: _k, id, ...snap } = doc;
          if (f.startsWith('notebooks/')) {
            await apply('notebook', f, id, snap, async () => (await notebooks.create(p, workspaceId, { title: String(snap.title ?? 'Untitled notebook'), cells: (snap.cells as NotebookCell[]) ?? [] })).id, (nid) => revisions.restorers.notebook!(p, workspaceId, nid, snap));
            return;
          }
          // A widget may name a saved query of another workspace: it keeps its SQL, not the link.
          const queries = new Set((await this.db.select({ id: this.s.savedQueries.id }).from(this.s.savedQueries).where(eq(this.s.savedQueries.workspace_id, workspaceId))).map((q) => q.id));
          snap.widgets = ((snap.widgets as Record<string, unknown>[]) ?? []).map((w) => (w.saved_query_id && !queries.has(String(w.saved_query_id)) ? { ...w, saved_query_id: null } : w));
          await apply('dashboard', f, id, snap, async () => {
            const d = await dashboards.create(p, workspaceId, { name: String(snap.name ?? 'Untitled dashboard'), description: (snap.description as string) ?? null, kind: snap.kind === 'mosaic' ? 'mosaic' : 'grid', spec: snap.spec ?? undefined });
            // New widget ids (the file's may belong to another workspace); the layout follows them.
            const idMap = new Map<string, string>();
            const widgets = (snap.widgets as Record<string, unknown>[]).map((w) => { const nid = newId(); idMap.set(String(w.id), nid); return { ...w, id: nid }; });
            const layout = ((snap.layout as LayoutItem[]) ?? []).filter((l) => idMap.has(l.i)).map((l) => ({ ...l, i: idMap.get(l.i)! }));
            await revisions.as(p.userId, workspaceId, 'dashboard', d.id, message, () => revisions.restorers.dashboard!(p, workspaceId, d.id, { ...snap, widgets, layout }));
            return d.id;
          }, async (did) => {
            // Widget ids of another workspace are replaced by this dashboard's own where titles match.
            const current = await revisions.snapshot(workspaceId, 'dashboard', did);
            const theirs = (snap.widgets as Record<string, unknown>[]);
            const ours = ((current?.widgets as Record<string, unknown>[]) ?? []);
            const ownIds = new Set(ours.map((w) => String(w.id)));
            const idMap = new Map<string, string>();
            for (const w of theirs) if (!ownIds.has(String(w.id))) idMap.set(String(w.id), String(ours.find((o) => o.title === w.title && ![...idMap.values()].includes(String(o.id)))?.id ?? newId()));
            const widgets = theirs.map((w) => (idMap.has(String(w.id)) ? { ...w, id: idMap.get(String(w.id)) } : w));
            const layout = ((snap.layout as LayoutItem[]) ?? []).map((l) => (idMap.has(l.i) ? { ...l, i: idMap.get(l.i)! } : l));
            await revisions.restorers.dashboard!(p, workspaceId, did, { ...snap, widgets, layout });
          });
        });
      }

      for (const [f, text] of files) {
        if (!/^queries\/.+\.sql$/.test(f)) continue;
        await tryIt(f, async () => {
          const head: Record<string, string> = {};
          const lines = text.split('\n');
          let i = 0;
          for (; i < lines.length && /^--\s*\w+\s*:/.test(lines[i]!); i++) {
            const m = /^--\s*(\w+)\s*:\s*(.*)$/.exec(lines[i]!)!;
            head[m[1]!] = m[2]!.trim();
          }
          const input = { name: head.name || path.basename(f, '.sql'), folder: head.folder ?? f.split('/').slice(1, -1).join('/'), description: head.description || null, sql_text: lines.slice(i).join('\n').trim(), tags: head.tags ? head.tags.split(',').map((t) => t.trim()).filter(Boolean) : [] };
          await apply('query', f, head.id, input, async () => (await savedQueries.create(p, workspaceId, input)).id, (qid) => savedQueries.update(p, workspaceId, qid, input));
        });
      }

      if (files.has('metrics/semantic.yml') && isChanged('metrics/semantic.yml')) {
        await tryIt('metrics/semantic.yml', async () => {
          const yaml = files.get('metrics/semantic.yml')!;
          const cur = await revisions.snapshot(workspaceId, 'semantic', 'workspace');
          if (cur && cur.yaml === yaml) return void result.unchanged++;
          if (cur && (await editedHere('semantic', 'workspace'))) result.conflicts.push('metrics/semantic.yml');
          await revisions.as(p.userId, workspaceId, 'semantic', 'workspace', message, () => semantic.save(p, workspaceId, yaml, { force: true }));
          result.updated.push('metrics/semantic.yml');
        });
      } else if (files.has('metrics/semantic.yml')) result.unchanged++;

      // dbt projects: a folder with duckview.yml (or dbt_project.yml).
      const projectDirs = new Set([...files.keys()].filter((f) => /^dbt\/[^/]+\/(duckview\.yml|dbt_project\.yml)$/.test(f)).map((f) => f.split('/').slice(0, 2).join('/')));
      for (const dir of projectDirs) {
        await tryIt(dir, async () => {
          const meta = files.has(`${dir}/duckview.yml`) ? (YAML.parse(files.get(`${dir}/duckview.yml`)!) as Record<string, unknown>) : {};
          const projectFiles = Object.fromEntries([...files].filter(([f]) => f.startsWith(`${dir}/`) && f !== `${dir}/duckview.yml`).map(([f, c]) => [f.slice(dir.length + 1), c]));
          const snap = { name: String(meta.name ?? dir.split('/')[1]), files: projectFiles, vars: (meta.vars as Record<string, unknown>) ?? {}, target_schema: String(meta.target_schema ?? 'main') };
          await apply('dbt', dir, meta.id, snap, async () => (await dbt.create(p, workspaceId, snap)).id, (pid) => dbt.update(p, pid, snap));
        });
      }

      // What this workspace has that the repository does not (a push adds it).
      const mapped = new Set(Object.values(mapping));
      for (const [type, label, rows] of [
        ['notebook', 'notebook', await this.db.select({ id: this.s.notebooks.id, t: this.s.notebooks.title }).from(this.s.notebooks).where(eq(this.s.notebooks.workspace_id, workspaceId))],
        ['query', 'query', await this.db.select({ id: this.s.savedQueries.id, t: this.s.savedQueries.name }).from(this.s.savedQueries).where(eq(this.s.savedQueries.workspace_id, workspaceId))],
        ['dashboard', 'dashboard', await this.db.select({ id: this.s.dashboards.id, t: this.s.dashboards.name }).from(this.s.dashboards).where(eq(this.s.dashboards.workspace_id, workspaceId))],
        ['dbt', 'dbt project', await this.db.select({ id: this.s.dbtProjects.id, t: this.s.dbtProjects.name }).from(this.s.dbtProjects).where(eq(this.s.dbtProjects.workspace_id, workspaceId))],
      ] as const) for (const r of rows) if (!mapped.has(r.id)) result.only_in_workspace.push(`${label} “${r.t}”`) || void type;
      await this.db.update(this.s.gitSyncs).set({ last_pull_sha: sha, last_pull_at: new Date(), mapping, updated_at: new Date() }).where(eq(this.s.gitSyncs.id, g.id));
      this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'git.pull', resource: `workspace:${workspaceId}`, queryText: `${sha} · ${result.created.length} created, ${result.updated.length} updated, ${result.conflicts.length} conflicts`, ip: p.ip });
      return result;
    }));
  }
}
