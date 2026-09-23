/**
 * dbt projects, compiled by dbt Core and run in the workspace's own engine.
 *
 * A workspace's DuckDB file is held by DuckView's engine, so dbt cannot open it. Instead every run:
 *   1. writes the project to <data dir>/.duckview/dbt/projects/<id>/project (dbt_packages and partial-parse state
 *      are kept between runs) and a profiles.yml pointing dbt-duckdb at a *shadow* database: empty tables with the
 *      workspace's schemas, tables and columns — so is_incremental(), adapter.get_columns_in_relation(),
 *      dbt_utils.star() and friends see the real structure — with external access off and the configuration locked;
 *   2. runs `dbt deps` (when the project has packages) and `dbt compile` with the selection in a scrubbed
 *      environment (no server secrets for env_var() to read);
 *   3. reads target/manifest.json and run_results.json (what the selection compiled to), swaps the shadow's
 *      database name for the workspace's, and executes the nodes in dependency order through the QueryService as
 *      the person running it — the SQL guard, access policies, audit log and data epoch all apply:
 *      seeds (read_csv of the CSV), models (view · table · incremental with or without unique_key · ephemeral
 *      inlined by dbt) and data tests (dbt's compiled test query, severity, warn_if / error_if, fail_calc).
 *      A failure skips everything downstream, as dbt does.
 * Descriptions and tags from the project's YAML become catalog notes, so Copilot reads them.
 * Not run: snapshots, Python models, hooks with Jinja (hooks without Jinja run), unit tests.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { and, desc, eq, lte } from 'drizzle-orm';
import type { MetadataStore } from '../db/index.js';
import { DBT_COMMANDS, type DbtCommand, type DbtLastRun, type DbtNodeResult, type DbtProject, type DbtRun, type DbtSchedule, type DbtScheduledCommand } from '../db/schema/sqlite.js';
import type { DuckViewConfig } from '../config/index.js';
import type { WorkspaceService } from './workspaces.js';
import type { QueryService } from './query.js';
import type { AuthService } from './auth.js';
import type { AuditService } from './audit.js';
import type { LineageService } from './lineage.js';
import type { SemanticService } from './semantic.js';
import type { Principal } from './principal.js';
import { requireWrite } from './principal.js';
import { badRequest, conflict, notFound } from './errors.js';
import { nextRunAt } from './syncs.js';
import { newId } from '../security/crypto.js';
import { HitlBlocked, type ApprovalChallenge } from './query.js';
import { liveEvents } from '../observability/events.js';
import { logger } from '../observability/logger.js';

const SHADOW = 'dv_dbt_shadow';
const MAX_LOG = 200_000;
const MAX_SQL = 20_000;
const FILE_RE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[\w@.\- /]+\.(sql|ya?ml|csv|md|txt|jinja|json)$/i;
/** Directories dbt writes into; project files never live there. */
const GENERATED = ['target', 'dbt_packages', 'logs', 'dbt_modules'];

const qi = (s: string) => `"${s.replace(/"/g, '""')}"`;
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

/** The Python side: build the shadow database, then dbt deps + dbt compile. */
const BOOTSTRAP = `
import json, os, sys
spec = json.load(open(sys.argv[1]))
import duckdb
def qi(s): return '"' + s.replace('"', '""') + '"'
if os.path.exists(spec["shadow"]): os.remove(spec["shadow"])
con = duckdb.connect(spec["shadow"])
for s in spec["schemas"]:
    con.execute("CREATE SCHEMA IF NOT EXISTS " + qi(s))
for t in spec["tables"]:
    name = qi(t["schema"]) + "." + qi(t["name"])
    try:
        con.execute("CREATE TABLE " + name + " (" + ", ".join(qi(c["name"]) + " " + c["type"] for c in t["columns"]) + ")")
    except Exception:
        con.execute("CREATE TABLE " + name + " (" + ", ".join(qi(c["name"]) + " VARCHAR" for c in t["columns"]) + ")")
con.close()
from dbt.cli.main import dbtRunner
runner = dbtRunner()
if spec["deps"]:
    res = runner.invoke(["deps", "--project-dir", spec["project_dir"], "--profiles-dir", spec["profiles_dir"], "--no-use-colors"])
    if not res.success:
        print("dbt deps failed", file=sys.stderr)
        sys.exit(3)
res = runner.invoke(spec["args"])
sys.exit(0 if res.success else 2)
`;

interface ManifestNode {
  unique_id: string;
  name: string;
  resource_type: string;
  database: string | null;
  schema: string;
  alias?: string | null;
  identifier?: string;
  relation_name: string | null;
  compiled_code?: string | null;
  original_file_path: string;
  root_path?: string;
  language?: string;
  description?: string;
  tags?: string[];
  columns?: Record<string, { name: string; description?: string; tags?: string[] }>;
  config: Record<string, unknown> & { materialized?: string; severity?: string; unique_key?: string | string[] | null; enabled?: boolean };
  depends_on?: { nodes?: string[] };
}

export interface DbtStatus {
  enabled: boolean;
  installed: boolean;
  version: string | null;
  adapter_version: string | null;
  venv: string;
  package: string;
  auto_install: boolean;
  installing: boolean;
  error: string | null;
}

/** A small starter: a staging model, a table on top, a seed, descriptions and tests. */
export function starterProject(name: string): Record<string, string> {
  const slug = name.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, '_$1') || 'project';
  return {
    'dbt_project.yml': `name: ${slug}\nversion: '1.0'\nprofile: duckview\n\nmodel-paths: [models]\nseed-paths: [seeds]\nmacro-paths: [macros]\ntest-paths: [tests]\n\nmodels:\n  ${slug}:\n    +materialized: view\n    marts:\n      +materialized: table\n`,
    'seeds/regions.csv': 'region_code,region_name\nEU,Europe\nUS,United States\nAPAC,Asia Pacific\n',
    'models/staging/stg_numbers.sql': `{# A staging model: rename and type the raw data. Replace range() with a table of this workspace, or with a\n   source declared in models/staging/sources.yml: select * from source('raw', 'orders') inside double braces. #}\nselect\n    range as id,\n    case range % 3 when 0 then 'EU' when 1 then 'US' else 'APAC' end as region_code,\n    round(range * 12.5, 2) as amount\nfrom range(1, 31)\n`,
    'models/marts/region_totals.sql': `select\n    r.region_name,\n    count(*) as orders,\n    sum(n.amount) as revenue\nfrom {{ ref('stg_numbers') }} n\njoin {{ ref('regions') }} r using (region_code)\ngroup by 1\n`,
    'models/schema.yml': `version: 2\n\nmodels:\n  - name: stg_numbers\n    description: Example staging model — one row per order.\n    columns:\n      - name: id\n        description: Order id\n        data_tests: [unique, not_null]\n  - name: region_totals\n    description: Orders and revenue per region.\n    config:\n      tags: [finance]\n    columns:\n      - name: region_name\n        description: Region name, from the regions seed\n        data_tests:\n          - not_null\n          - accepted_values:\n              arguments:\n                values: ['Europe', 'United States', 'Asia Pacific']\n\nseeds:\n  - name: regions\n    description: Region codes and names.\n`,
    'macros/.gitkeep': '',
    'tests/.gitkeep': '',
  };
}

export class DbtService {
  /** Version history (set by the context). */
  revisions: { record(userId: string | null, workspaceId: string, type: 'notebook' | 'dashboard' | 'query' | 'semantic' | 'dbt', id: string, opts?: { message?: string | null }): Promise<unknown>; forget(type: 'notebook' | 'dashboard' | 'query' | 'semantic' | 'dbt', id: string): Promise<void> } | null = null;
  private running = new Set<string>();
  /** Set by the context: dbt semantic models and metrics are imported into the semantic layer. */
  semantic: SemanticService | null = null;
  /** Runs an agent started with a person's approval (their SQL runs with dry_run=false). */
  private approved = new Set<string>();
  private installing: Promise<void> | null = null;
  private installError: string | null = null;
  private versions: { dbt: string | null; adapter: string | null } | null = null;
  private ticker: NodeJS.Timeout | null = null;
  /** Overridable in tests: runs a command and resolves with its exit code and output. */
  exec = (cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs: number }): Promise<{ code: number | null; output: string }> =>
    new Promise((resolve, reject) => {
      const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      const add = (d: Buffer) => {
        if (output.length < MAX_LOG) output += d.toString();
      };
      child.stdout.on('data', add);
      child.stderr.on('data', add);
      const timer = setTimeout(() => {
        output += `\nStopped after ${Math.round(opts.timeoutMs / 1000)} s`;
        child.kill('SIGKILL');
      }, opts.timeoutMs);
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, output: stripAnsi(output) });
      });
    });

  constructor(
    private readonly store: MetadataStore,
    private readonly cfg: DuckViewConfig,
    private readonly workspaces: WorkspaceService,
    private readonly queries: QueryService,
    private readonly auth: AuthService,
    private readonly audit: AuditService,
    private readonly lineage: LineageService,
    private readonly baseDir: string,
  ) {}
  private get db() {
    return this.store.db;
  }
  private get s() {
    return this.store.schema;
  }
  private get dcfg() {
    return this.cfg.transform.dbt;
  }
  private get python(): string {
    return path.join(this.dcfg.venv_dir, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  }

  // ------------------------------------------------------------------ runtime

  async status(): Promise<DbtStatus> {
    const installed = fs.existsSync(this.python) && (await this.probe());
    return { enabled: this.dcfg.enabled, installed, version: this.versions?.dbt ?? null, adapter_version: this.versions?.adapter ?? null, venv: this.dcfg.venv_dir, package: this.dcfg.package, auto_install: this.dcfg.auto_install, installing: !!this.installing, error: this.installError };
  }

  private async probe(): Promise<boolean> {
    if (this.versions) return true;
    const r = await this.exec(this.python, ['-c', 'import importlib.metadata as m; print(m.version("dbt-core")); print(m.version("dbt-duckdb"))'], { env: this.env(), timeoutMs: 30_000 }).catch(() => null);
    if (!r || r.code !== 0) return false;
    const [dbt, adapter] = r.output.trim().split('\n').map((l) => l.trim());
    this.versions = { dbt: dbt ?? null, adapter: adapter ?? null };
    return true;
  }

  /** Creates the virtualenv and installs dbt-duckdb (once; concurrent callers wait for the same install). */
  async install(): Promise<void> {
    if (this.installing) return this.installing;
    this.installing = (async () => {
      this.installError = null;
      try {
        fs.mkdirSync(path.dirname(this.dcfg.venv_dir), { recursive: true });
        if (!fs.existsSync(this.python)) {
          const v = await this.exec(this.dcfg.python, ['-m', 'venv', this.dcfg.venv_dir], { timeoutMs: 120_000 });
          if (v.code !== 0) throw new Error(`Could not create the dbt virtualenv: ${v.output.slice(-500)}`);
        }
        logger().info({ venv: this.dcfg.venv_dir, package: this.dcfg.package }, 'Installing dbt');
        const p = await this.exec(this.python, ['-m', 'pip', 'install', '--disable-pip-version-check', '--quiet', this.dcfg.package], { env: { ...this.env(), HOME: path.dirname(this.dcfg.venv_dir) }, timeoutMs: 900_000 });
        if (p.code !== 0) throw new Error(`pip install ${this.dcfg.package} failed: ${p.output.slice(-800)}`);
        this.versions = null;
        if (!(await this.probe())) throw new Error('dbt was installed but cannot be imported');
      } catch (err) {
        this.installError = (err as Error).message;
        throw err;
      } finally {
        this.installing = null;
      }
    })();
    return this.installing;
  }

  private async ensureInstalled(): Promise<void> {
    if (!this.dcfg.enabled) throw badRequest('dbt is disabled on this server (transform.dbt.enabled)');
    if (fs.existsSync(this.python) && (await this.probe())) return;
    if (!this.dcfg.auto_install) throw badRequest(`dbt is not installed in ${this.dcfg.venv_dir}; install ${this.dcfg.package} there or set transform.dbt.auto_install`);
    await this.install();
  }

  /** A scrubbed environment: nothing of the server's (secrets included) reaches env_var(). */
  private env(home?: string): NodeJS.ProcessEnv {
    return {
      PATH: `${path.dirname(this.python)}${path.delimiter}${process.env.PATH ?? ''}`,
      HOME: home ?? path.dirname(this.dcfg.venv_dir),
      LANG: 'C.UTF-8',
      PYTHONNOUSERSITE: '1',
      PYTHONDONTWRITEBYTECODE: '1',
      DBT_SEND_ANONYMOUS_USAGE_STATS: 'False',
      DO_NOT_TRACK: '1',
      ...(process.env.SSL_CERT_FILE ? { SSL_CERT_FILE: process.env.SSL_CERT_FILE } : {}),
      ...(process.env.HTTPS_PROXY ? { HTTPS_PROXY: process.env.HTTPS_PROXY } : {}),
    };
  }

  // ------------------------------------------------------------------ projects

  private validateFiles(files: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    let total = 0;
    for (const [rawName, content] of Object.entries(files)) {
      const name = rawName.replace(/\\/g, '/').replace(/^\.\//, '');
      if (name.endsWith('.gitkeep')) {
        out[name] = '';
        continue;
      }
      if (!FILE_RE.test(name)) throw badRequest(`Unsupported file ${rawName}: dbt projects hold .sql, .yml, .csv, .md and .jinja files`);
      if (GENERATED.includes(name.split('/')[0]!)) continue;
      if (/(^|\/)profiles\.ya?ml$/i.test(name)) throw badRequest('profiles.yml is written by DuckView; leave it out of the project');
      if (typeof content !== 'string') throw badRequest(`${rawName} must be text`);
      total += Buffer.byteLength(content);
      out[name] = content;
    }
    if (total > this.dcfg.max_project_bytes) throw badRequest(`The project is larger than ${Math.round(this.dcfg.max_project_bytes / 1024 / 1024)} MB`);
    if (!out['dbt_project.yml']) throw badRequest('A dbt project needs a dbt_project.yml at its root');
    return out;
  }

  private validateSchedule(schedule: DbtSchedule): DbtSchedule {
    if (schedule.kind === 'interval' && !(schedule.minutes >= 5)) throw badRequest('An interval must be at least 5 minutes');
    if (schedule.kind === 'cron') nextRunAt(schedule);
    return schedule;
  }

  async list(p: Principal, workspaceId: string): Promise<Omit<DbtProject, 'files'>[]> {
    await this.workspaces.get(p, workspaceId);
    const rows = await this.db.select().from(this.s.dbtProjects).where(eq(this.s.dbtProjects.workspace_id, workspaceId)).orderBy(desc(this.s.dbtProjects.updated_at));
    return rows.map(({ files: _f, ...rest }) => rest);
  }

  async get(p: Principal, id: string): Promise<DbtProject> {
    const row = (await this.db.select().from(this.s.dbtProjects).where(eq(this.s.dbtProjects.id, id)).limit(1))[0];
    if (!row) throw notFound('dbt project');
    await this.workspaces.get(p, row.workspace_id);
    return row;
  }

  async create(p: Principal, workspaceId: string, input: { name: string; files?: Record<string, string>; vars?: Record<string, unknown>; target_schema?: string; schedule?: DbtSchedule; scheduled?: DbtScheduledCommand }): Promise<DbtProject> {
    requireWrite(p);
    await this.workspaces.get(p, workspaceId, 'EDITOR');
    const name = input.name.trim().slice(0, 120);
    if (!name) throw badRequest('name is required');
    const now = new Date();
    const schedule = this.validateSchedule(input.schedule ?? { kind: 'manual' });
    const row: DbtProject = {
      id: newId(),
      workspace_id: workspaceId,
      user_id: p.userId,
      name,
      files: this.validateFiles(input.files && Object.keys(input.files).length ? input.files : starterProject(name)),
      vars: input.vars ?? {},
      target_schema: this.schemaName(input.target_schema ?? 'main'),
      schedule,
      scheduled: this.validateScheduled(input.scheduled ?? { command: 'build' }),
      enabled: true,
      next_run_at: schedule.kind === 'manual' ? null : nextRunAt(schedule),
      last_run: null,
      created_at: now,
      updated_at: now,
    };
    await this.db.insert(this.s.dbtProjects).values(row);
    await this.revisions?.record(p.userId, workspaceId, 'dbt', row.id);
    this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'dbt.project_create', resource: `dbt:${row.id}`, ip: p.ip });
    return row;
  }

  async update(p: Principal, id: string, patch: { name?: string; files?: Record<string, string>; vars?: Record<string, unknown>; target_schema?: string; schedule?: DbtSchedule; scheduled?: DbtScheduledCommand; enabled?: boolean }): Promise<DbtProject> {
    requireWrite(p);
    const row = await this.get(p, id);
    await this.workspaces.get(p, row.workspace_id, 'EDITOR');
    const set: Partial<DbtProject> = { updated_at: new Date() };
    if (patch.name !== undefined) set.name = patch.name.trim().slice(0, 120) || row.name;
    if (patch.files !== undefined) set.files = this.validateFiles(patch.files);
    if (patch.vars !== undefined) set.vars = patch.vars;
    if (patch.target_schema !== undefined) set.target_schema = this.schemaName(patch.target_schema);
    if (patch.schedule !== undefined) set.schedule = this.validateSchedule(patch.schedule);
    if (patch.scheduled !== undefined) set.scheduled = this.validateScheduled(patch.scheduled);
    if (patch.enabled !== undefined) set.enabled = patch.enabled;
    const schedule = set.schedule ?? row.schedule;
    const enabled = set.enabled ?? row.enabled;
    if (patch.schedule !== undefined || patch.enabled !== undefined) set.next_run_at = enabled && schedule.kind !== 'manual' ? nextRunAt(schedule) : null;
    await this.db.update(this.s.dbtProjects).set(set).where(eq(this.s.dbtProjects.id, id));
    if (patch.files !== undefined || patch.vars !== undefined || patch.target_schema !== undefined || patch.name !== undefined) await this.revisions?.record(p.userId, row.workspace_id, 'dbt', id);
    this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'dbt.project_update', resource: `dbt:${id}`, ip: p.ip });
    return { ...row, ...set };
  }

  async remove(p: Principal, id: string): Promise<void> {
    requireWrite(p);
    const row = await this.get(p, id);
    await this.workspaces.get(p, row.workspace_id, 'EDITOR');
    await this.db.delete(this.s.dbtProjects).where(eq(this.s.dbtProjects.id, id));
    await this.revisions?.forget('dbt', id);
    await this.semantic?.removeSource(row.workspace_id, `dbt:${id}`);
    fs.rmSync(this.workDir(id), { recursive: true, force: true });
    this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'dbt.project_delete', resource: `dbt:${id}`, ip: p.ip });
  }

  private schemaName(s: string): string {
    const v = s.trim() || 'main';
    if (!/^[A-Za-z_][\w$]{0,62}$/.test(v)) throw badRequest('target_schema must be a plain identifier');
    return v;
  }

  private validateScheduled(c: DbtScheduledCommand): DbtScheduledCommand {
    if (!(DBT_COMMANDS as readonly string[]).includes(c.command)) throw badRequest(`command must be one of ${DBT_COMMANDS.join(', ')}`);
    return { command: c.command, select: c.select?.trim() || null, exclude: c.exclude?.trim() || null, full_refresh: !!c.full_refresh };
  }

  /** Adds, replaces (a string) or deletes (null) files of a project. */
  async writeFiles(p: Principal, projectId: string, changes: Record<string, string | null>): Promise<DbtProject> {
    const project = await this.get(p, projectId);
    const files = { ...project.files };
    for (const [name, content] of Object.entries(changes)) {
      const key = name.replace(/\\/g, '/').replace(/^\.\//, '');
      if (content === null) {
        if (key === 'dbt_project.yml') throw badRequest('dbt_project.yml cannot be deleted');
        delete files[key];
      } else files[key] = content;
    }
    return this.update(p, projectId, { files });
  }

  /** Model and seed names of a project (from its files). */
  private nodeNames(files: Record<string, string>): { models: string[]; seeds: string[] } {
    const models = Object.keys(files).filter((f) => /^models\/.+\.sql$/i.test(f)).map((f) => f.split('/').pop()!.replace(/\.sql$/i, ''));
    const seeds = Object.keys(files).filter((f) => /^seeds\/.+\.csv$/i.test(f)).map((f) => f.split('/').pop()!.replace(/\.csv$/i, ''));
    return { models, seeds };
  }

  /**
   * Turns a SELECT into a model of the project: `models/<folder>/<name>.sql` with a config block, references to the
   * project's own models and seeds rewritten to ref(), and the description in a YAML file next to it.
   */
  async addModel(p: Principal, projectId: string, input: { name: string; sql: string; folder?: string | null; materialized?: 'view' | 'table' | 'incremental'; unique_key?: string | null; description?: string | null; overwrite?: boolean }): Promise<{ project: DbtProject; path: string; sql: string; refs: string[] }> {
    const project = await this.get(p, projectId);
    const name = input.name.trim();
    if (!/^[A-Za-z_][\w]{0,62}$/.test(name)) throw badRequest('A model name is a plain identifier (letters, digits, underscores)');
    const folder = (input.folder ?? '').trim().replace(/^\/+|\/+$/g, '').replace(/^models\/?/, '');
    if (folder && !/^[\w-]+(\/[\w-]+)*$/.test(folder)) throw badRequest('folder is a path like marts or staging/shop');
    const file = `models/${folder ? `${folder}/` : ''}${name}.sql`;
    const { models, seeds } = this.nodeNames(project.files);
    const existingPath = Object.keys(project.files).find((f) => /^models\/.+\.sql$/i.test(f) && f.split('/').pop() === `${name}.sql`);
    if (existingPath && existingPath !== file) throw conflict(`The project already has a model ${name} (${existingPath})`);
    if (existingPath && !input.overwrite) throw conflict(`${file} exists; pass overwrite to replace it`);
    let body = input.sql.trim().replace(/;\s*$/, '');
    if (!body) throw badRequest('sql is required');
    const refs: string[] = [];
    if (!/\{\{|\{%/.test(body)) {
      const known = new Set([...models, ...seeds].filter((m) => m !== name).map((m) => m.toLowerCase()));
      body = body.replace(/(\b(?:from|join)\s+)(?:"?main"?\.)?("?)([A-Za-z_]\w*)\2(?![\w.(])/gi, (all, kw: string, _q: string, ident: string) => {
        if (!known.has(ident.toLowerCase())) return all;
        refs.push(ident);
        return `${kw}{{ ref('${ident}') }}`;
      });
    }
    const m = input.materialized ?? 'view';
    const config = /\{\{\s*config\(/.test(body) ? '' : `{{ config(materialized='${m}'${m === 'incremental' && input.unique_key ? `, unique_key='${input.unique_key.replace(/'/g, '')}'` : ''}) }}\n\n`;
    const changes: Record<string, string> = { [file]: `${config}${body}\n` };
    const describedElsewhere = Object.entries(project.files).some(([f, c]) => /\.ya?ml$/i.test(f) && new RegExp(`-\\s*name:\\s*['"]?${name}['"]?\\s*$`, 'm').test(c));
    if (input.description?.trim() && !describedElsewhere) changes[`models/${folder ? `${folder}/` : ''}${name}.yml`] = `version: 2\n\nmodels:\n  - name: ${name}\n    description: ${JSON.stringify(input.description.trim())}\n`;
    const updated = await this.writeFiles(p, projectId, changes);
    return { project: updated, path: file, sql: changes[file]!, refs: [...new Set(refs)] };
  }

  /** What a build / run / seed would create or replace, as an approval challenge (a compile of the selection). */
  private async challenge(p: Principal, project: DbtProject, cmd: DbtScheduledCommand): Promise<ApprovalChallenge> {
    if (this.running.has(project.id)) throw conflict('This project is already running');
    this.running.add(project.id);
    try {
      await this.ensureInstalled();
      const pseudo = { command: cmd.command, select: cmd.select ?? null, exclude: cmd.exclude ?? null, full_refresh: !!cmd.full_refresh } as DbtRun;
      const compiled = await this.compile(p, project, pseudo);
      const types = cmd.command === 'seed' ? ['seed'] : cmd.command === 'run' ? ['model'] : ['seed', 'model'];
      const nodes = compiled.selected.map((id) => compiled.nodes.get(id)).filter((n): n is ManifestNode => !!n && types.includes(n.resource_type) && n.config.materialized !== 'ephemeral');
      const verb = (n: ManifestNode) => (n.resource_type === 'seed' ? 'CREATE TABLE' : n.config.materialized === 'view' || !n.config.materialized ? 'CREATE VIEW' : n.config.materialized === 'incremental' && !cmd.full_refresh ? 'INSERT' : 'CREATE TABLE');
      return {
        status: 'approval_required',
        reason: `dbt ${cmd.command}${cmd.select ? ` --select ${cmd.select}` : ''} on "${project.name}" would create or replace ${nodes.length} relation${nodes.length === 1 ? '' : 's'} in the workspace: ${nodes.slice(0, 20).map((n) => this.display(n)).join(', ')}${nodes.length > 20 ? ', …' : ''}.`,
        statement_classes: ['write'],
        mutating_verbs: [...new Set(nodes.map(verb))],
        statements: nodes.slice(0, 100).map((n, index) => ({ index, verb: verb(n), class: 'write', preview: `${verb(n)} ${this.display(n)}${n.resource_type === 'model' ? ` (${n.config.materialized ?? 'view'})` : ' (seed)'}` })),
        how_to_proceed: 'Show the plan to the human operator. If they approve, call run_dbt again with the same arguments and dry_run: false.',
      };
    } finally {
      this.running.delete(project.id);
    }
  }

  /** The workspace's dbt projects for Copilot: models, how they are built, the last run and what failed. */
  async promptSummary(workspaceId: string): Promise<string> {
    const projects = await this.db.select().from(this.s.dbtProjects).where(eq(this.s.dbtProjects.workspace_id, workspaceId));
    if (!projects.length) return '';
    const out: string[] = [];
    for (const project of projects.slice(0, 10)) {
      const { models, seeds } = this.nodeNames(project.files);
      const recent = await this.db.select().from(this.s.dbtRuns).where(eq(this.s.dbtRuns.project_id, project.id)).orderBy(desc(this.s.dbtRuns.started_at)).limit(25);
      const last = recent[0];
      const built = new Map<string, DbtNodeResult>();
      for (const run of recent) for (const r of run.results) if (r.resource_type === 'model' && r.materialized && !built.has(r.name)) built.set(r.name, r);
      out.push(`- **${project.name}** (id ${project.id}, target schema ${project.target_schema}): models ${models.map((m) => `${m}${built.get(m)?.materialized ? ` [${built.get(m)!.materialized}]` : ''}`).join(', ') || 'none'}${seeds.length ? `; seeds ${seeds.join(', ')}` : ''}`);
      if (last) {
        out.push(`  last run: dbt ${last.command}${last.select ? ` --select ${last.select}` : ''} → ${last.status}${last.summary ? ` (${last.summary})` : ''}`);
        if (last.error) out.push(`  error: ${last.error.slice(0, 400)}`);
        for (const r of last.results.filter((x) => x.status === 'error' || x.status === 'fail').slice(0, 5)) out.push(`  ${r.status}: ${r.name} — ${(r.message ?? '').slice(0, 300)}`);
      }
    }
    return out.join('\n');
  }

  // ------------------------------------------------------------------ runs

  async runs(p: Principal, projectId: string, limit = 30): Promise<Omit<DbtRun, 'log' | 'results'>[]> {
    await this.get(p, projectId);
    const rows = await this.db.select().from(this.s.dbtRuns).where(eq(this.s.dbtRuns.project_id, projectId)).orderBy(desc(this.s.dbtRuns.started_at)).limit(Math.min(limit, 200));
    return rows.map(({ log: _l, results: _r, ...rest }) => rest);
  }

  async getRun(p: Principal, runId: string): Promise<DbtRun> {
    const run = (await this.db.select().from(this.s.dbtRuns).where(eq(this.s.dbtRuns.id, runId)).limit(1))[0];
    if (!run) throw notFound('dbt run');
    await this.workspaces.get(p, run.workspace_id);
    return run;
  }

  /**
   * Starts a run as `p` (an editor of the workspace) and returns it at once; `done` settles when it finishes.
   * One run per project at a time.
   */
  async start(p: Principal, projectId: string, input: { command: DbtCommand; select?: string | null; exclude?: string | null; full_refresh?: boolean }, triggeredBy: 'manual' | 'schedule' | 'agent' = 'manual', opts: { approved?: boolean } = {}): Promise<{ run: DbtRun; done: Promise<DbtRun> }> {
    requireWrite(p);
    const project = await this.get(p, projectId);
    await this.workspaces.get(p, project.workspace_id, input.command === 'compile' ? 'VIEWER' : 'EDITOR');
    const cmd = this.validateScheduled(input);
    if (this.running.has(projectId)) throw conflict('This project is already running');
    // Agents build tables only after a person approved (the same human-in-the-loop rule as mutating SQL): the
    // challenge lists what the run would create or replace, from a compile of the same selection.
    const writes = cmd.command === 'build' || cmd.command === 'run' || cmd.command === 'seed';
    if (writes && p.actorType === 'AGENT' && this.cfg.mcp.require_confirmation_for_mutations && !opts.approved) throw new HitlBlocked(await this.challenge(p, project, cmd));
    this.running.add(projectId);
    const run: DbtRun = { id: newId(), project_id: projectId, workspace_id: project.workspace_id, user_id: p.userId, command: cmd.command, select: cmd.select ?? null, exclude: cmd.exclude ?? null, full_refresh: !!cmd.full_refresh, triggered_by: triggeredBy, status: 'running', summary: null, error: null, log: null, results: [], duration_ms: null, started_at: new Date(), finished_at: null };
    try {
      await this.db.insert(this.s.dbtRuns).values(run);
      await this.db.update(this.s.dbtProjects).set({ last_run: this.last(run) }).where(eq(this.s.dbtProjects.id, projectId));
    } catch (err) {
      this.running.delete(projectId);
      throw err;
    }
    this.publish(run);
    if (opts.approved) this.approved.add(run.id);
    const done = this.execute(p, project, run).finally(() => {
      this.running.delete(projectId);
      this.approved.delete(run.id);
    });
    return { run, done };
  }

  private last(run: DbtRun): DbtLastRun {
    return { run_id: run.id, status: run.status, command: run.command, started_at: run.started_at.toISOString(), finished_at: run.finished_at?.toISOString() ?? null, summary: run.summary };
  }

  private publish(run: DbtRun) {
    liveEvents.publish({ type: 'dbt', at: new Date().toISOString(), workspace_id: run.workspace_id, project_id: run.project_id, run_id: run.id, status: run.status, summary: run.summary });
  }

  private workDir(projectId: string) {
    return path.join(this.baseDir, '.duckview', 'dbt', 'projects', projectId);
  }

  private async execute(p: Principal, project: DbtProject, run: DbtRun): Promise<DbtRun> {
    const t0 = performance.now();
    let log = '';
    let results: DbtNodeResult[] = [];
    let error: string | null = null;
    try {
      await this.ensureInstalled();
      const compiled = await this.compile(p, project, run);
      log = compiled.log;
      // The project's semantic models and metrics join the workspace's semantic layer (or leave it when removed).
      if (this.semantic) await this.semantic.importDbt(project.workspace_id, project.id, compiled.semantic, (r) => this.rebind(r, compiled.catalog), p.userId).catch((err) => logger().warn({ err: (err as Error).message }, 'dbt semantic import failed'));
      results = await this.executeNodes(p, project, run, compiled.nodes, compiled.selected, compiled.catalog);
      if (run.command !== 'compile' && results.some((r) => r.status === 'success' && r.resource_type !== 'test')) await this.importDocs(p, project, compiled.nodes, results);
    } catch (err) {
      error = ((err as Error).message ?? String(err)).slice(0, 4000);
      if ((err as { log?: string }).log) log = (err as { log: string }).log;
    }
    const count = (s: DbtNodeResult['status']) => results.filter((r) => r.status === s).length;
    const failed = count('error') + count('fail');
    const summary = error ? error.split('\n')[0]!.slice(0, 200) : run.command === 'compile' ? `${results.length} compiled` : [`${count('success')} ok`, count('pass') && `${count('pass')} tests passed`, count('warn') && `${count('warn')} warn`, count('fail') && `${count('fail')} failed`, count('error') && `${count('error')} errors`, count('skipped') && `${count('skipped')} skipped`].filter(Boolean).join(' · ');
    const finished: DbtRun = { ...run, status: error || failed ? 'error' : 'ok', summary, error, log: log.slice(-MAX_LOG), results, duration_ms: Math.round(performance.now() - t0), finished_at: new Date() };
    await this.db.update(this.s.dbtRuns).set({ status: finished.status, summary, error, log: finished.log, results, duration_ms: finished.duration_ms, finished_at: finished.finished_at }).where(eq(this.s.dbtRuns.id, run.id));
    const nextRun = project.enabled && project.schedule.kind !== 'manual' ? nextRunAt(project.schedule) : null;
    await this.db.update(this.s.dbtProjects).set({ last_run: this.last(finished), ...(run.triggered_by === 'schedule' ? { next_run_at: nextRun } : {}) }).where(eq(this.s.dbtProjects.id, project.id));
    this.publish(finished);
    this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'dbt.run', resource: `dbt:${project.id}`, queryText: `${run.command}${run.select ? ` --select ${run.select}` : ''}${run.exclude ? ` --exclude ${run.exclude}` : ''}${run.full_refresh ? ' --full-refresh' : ''}`, durationMs: finished.duration_ms ?? 0, status: finished.status === 'ok' ? 'ok' : 'error', error: finished.status === 'ok' ? undefined : summary, ip: p.ip });
    // Keep history bounded.
    const old = await this.db.select({ id: this.s.dbtRuns.id }).from(this.s.dbtRuns).where(eq(this.s.dbtRuns.project_id, project.id)).orderBy(desc(this.s.dbtRuns.started_at)).limit(1000).offset(100);
    for (const r of old) await this.db.delete(this.s.dbtRuns).where(eq(this.s.dbtRuns.id, r.id));
    return finished;
  }

  /** Writes the project, builds the shadow and runs dbt compile; returns the manifest nodes and the selection. */
  private async compile(p: Principal, project: DbtProject, run: DbtRun): Promise<{ nodes: Map<string, ManifestNode>; selected: string[]; catalog: string; log: string; semantic: Parameters<SemanticService['importDbt']>[2] }> {
    const exec = (sql: string) => this.queries.run(p, project.workspace_id, sql, { cache: false, countTotal: false, maxRows: 100_000 });
    const catalog = String((await exec('SELECT current_database()')).rows[0]?.[0] ?? 'memory');
    const cols = await exec(`SELECT table_schema, table_name, column_name, data_type FROM information_schema.columns WHERE table_catalog = current_database() AND table_schema NOT IN ('information_schema', 'pg_catalog') AND table_schema <> ${lit(this.cfg.mosaic.schema)} ORDER BY table_schema, table_name, ordinal_position`);
    const schemas = (await exec(`SELECT schema_name FROM information_schema.schemata WHERE catalog_name = current_database() AND schema_name NOT IN ('information_schema', 'pg_catalog')`)).rows.map((r) => String(r[0]));
    const tables = new Map<string, { schema: string; name: string; columns: { name: string; type: string }[] }>();
    for (const [schema, table, column, type] of cols.rows as string[][]) {
      const k = `${schema}.${table}`;
      if (!tables.has(k)) tables.set(k, { schema: schema!, name: table!, columns: [] });
      tables.get(k)!.columns.push({ name: column!, type: type! });
    }

    const work = this.workDir(project.id);
    const projectDir = path.join(work, 'project');
    const profilesDir = path.join(work, 'profiles');
    const targetDir = path.join(projectDir, 'target');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(profilesDir, { recursive: true });
    for (const entry of fs.readdirSync(projectDir)) if (!GENERATED.includes(entry)) fs.rmSync(path.join(projectDir, entry), { recursive: true, force: true });
    fs.rmSync(path.join(targetDir, 'run_results.json'), { force: true });
    for (const [name, content] of Object.entries(project.files)) {
      const abs = path.join(projectDir, name);
      if (!abs.startsWith(projectDir + path.sep)) throw badRequest(`Invalid file name ${name}`);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }
    const profileName = /^\s*profile:\s*['"]?([\w-]+)['"]?\s*$/m.exec(project.files['dbt_project.yml'] ?? '')?.[1] ?? 'duckview';
    const shadow = path.join(work, `${SHADOW}.duckdb`);
    fs.writeFileSync(
      path.join(profilesDir, 'profiles.yml'),
      `${profileName}:\n  target: duckview\n  outputs:\n    duckview:\n      type: duckdb\n      path: ${JSON.stringify(shadow)}\n      schema: ${JSON.stringify(project.target_schema)}\n      threads: 1\n      settings:\n        enable_external_access: false\n        lock_configuration: true\n`,
    );
    const hasPackages = ['packages.yml', 'dependencies.yml'].some((f) => /\bpackages\s*:\s*\n\s*-/m.test(project.files[f] ?? ''));
    if (hasPackages && !this.dcfg.allow_packages) throw badRequest('dbt packages are disabled on this server (transform.dbt.allow_packages)');
    const args = ['compile', '--project-dir', projectDir, '--profiles-dir', profilesDir, '--target-path', targetDir, '--no-use-colors', '--vars', JSON.stringify(project.vars ?? {})];
    if (run.select) args.push('--select', ...run.select.split(/\s+/).filter(Boolean));
    if (run.exclude) args.push('--exclude', ...run.exclude.split(/\s+/).filter(Boolean));
    if (run.full_refresh) args.push('--full-refresh');
    const specPath = path.join(work, 'spec.json');
    fs.writeFileSync(specPath, JSON.stringify({ shadow, schemas: [...new Set([...schemas, project.target_schema])], tables: [...tables.values()], deps: hasPackages, project_dir: projectDir, profiles_dir: profilesDir, args }));
    const bootstrap = path.join(work, 'compile.py');
    fs.writeFileSync(bootstrap, BOOTSTRAP);
    const r = await this.exec(this.python, [bootstrap, specPath], { cwd: projectDir, env: this.env(work), timeoutMs: this.dcfg.timeout_seconds * 1000 });
    const log = r.output;
    if (r.code !== 0) {
      throw Object.assign(new Error(`${r.code === 3 ? 'dbt deps' : 'dbt compile'} failed: ${dbtError(log)}`), { log });
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(targetDir, 'manifest.json'), 'utf8')) as { nodes: Record<string, ManifestNode>; sources: Record<string, ManifestNode> };
    const runResults = JSON.parse(fs.readFileSync(path.join(targetDir, 'run_results.json'), 'utf8')) as { results: { unique_id: string }[] };
    const nodes = new Map<string, ManifestNode>([...Object.entries(manifest.nodes), ...Object.entries(manifest.sources ?? {})]);
    const semanticPath = path.join(targetDir, 'semantic_manifest.json');
    const semantic = fs.existsSync(semanticPath) ? (JSON.parse(fs.readFileSync(semanticPath, 'utf8')) as Parameters<SemanticService['importDbt']>[2]) : null;
    return { nodes, selected: runResults.results.map((x) => x.unique_id), catalog, log, semantic };
  }

  /** The shadow database name → the workspace's catalog, in compiled SQL and relation names. */
  private rebind(sql: string, catalog: string): string {
    return sql.split(`${qi(SHADOW)}.`).join(`${qi(catalog)}.`);
  }

  private display(node: ManifestNode): string {
    const name = node.alias || node.identifier || node.name;
    return node.schema === 'main' ? name : `${node.schema}.${name}`;
  }

  private async executeNodes(p: Principal, project: DbtProject, run: DbtRun, nodes: Map<string, ManifestNode>, selectedIds: string[], catalog: string): Promise<DbtNodeResult[]> {
    const wanted: Record<DbtCommand, string[]> = { build: ['seed', 'model', 'test', 'snapshot'], run: ['model'], test: ['test'], seed: ['seed'], compile: ['model', 'test', 'seed', 'snapshot', 'analysis'] };
    const selected = selectedIds.map((id) => nodes.get(id)).filter((n): n is ManifestNode => !!n && wanted[run.command].includes(n.resource_type) && n.config.materialized !== 'ephemeral');
    const inRun = new Set(selected.map((n) => n.unique_id));
    const direct = (n: ManifestNode) => (n.depends_on?.nodes ?? []).filter((d) => inRun.has(d));
    // As in dbt build: a node waits for the tests of what it reads (tests whose models are all upstream of it), and
    // is skipped when one of them fails.
    const tests = selected.filter((n) => n.resource_type === 'test');
    const ancestors = new Map<string, Set<string>>();
    const ancestorsOf = (n: ManifestNode): Set<string> => {
      const hit = ancestors.get(n.unique_id);
      if (hit) return hit;
      const out = new Set<string>();
      ancestors.set(n.unique_id, out);
      for (const d of n.depends_on?.nodes ?? []) {
        out.add(d);
        const dn = nodes.get(d);
        if (dn) for (const a of ancestorsOf(dn)) out.add(a);
      }
      return out;
    };
    const deps = (n: ManifestNode) => {
      if (n.resource_type === 'test') return direct(n);
      const up = ancestorsOf(n);
      const guards = tests.filter((t) => (t.depends_on?.nodes ?? []).length > 0 && (t.depends_on?.nodes ?? []).every((d) => up.has(d))).map((t) => t.unique_id);
      return [...new Set([...direct(n), ...guards])];
    };
    const upstream = (n: ManifestNode) => (n.depends_on?.nodes ?? []).map((d) => nodes.get(d)).filter((d): d is ManifestNode => !!d && d.resource_type !== 'test' && d.config?.materialized !== 'ephemeral').map((d) => this.display(d));
    const base = (n: ManifestNode): DbtNodeResult => ({ unique_id: n.unique_id, name: n.name, resource_type: n.resource_type as DbtNodeResult['resource_type'], status: 'compiled', materialized: n.resource_type === 'model' ? (n.config.materialized ?? 'view') : null, relation: n.relation_name ? this.display(n) : null, rows: null, failures: null, duration_ms: 0, message: null, sql: n.compiled_code ? this.rebind(n.compiled_code, catalog).trim().slice(0, MAX_SQL) : null, depends_on: upstream(n) });

    // Topological order (dbt's DAG); tests right after what they test.
    const order: ManifestNode[] = [];
    const state = new Map<string, 0 | 1 | 2>();
    const visit = (n: ManifestNode) => {
      if (state.get(n.unique_id) === 2) return;
      if (state.get(n.unique_id) === 1) throw badRequest(`dbt graph has a cycle at ${n.unique_id}`);
      state.set(n.unique_id, 1);
      for (const d of deps(n)) visit(nodes.get(d)!);
      state.set(n.unique_id, 2);
      order.push(n);
    };
    const rank = (n: ManifestNode) => (n.resource_type === 'seed' ? 0 : n.resource_type === 'test' ? 2 : 1);
    for (const n of [...selected].sort((a, b) => rank(a) - rank(b))) visit(n);

    if (run.command === 'compile') return order.map(base);

    const dryRun = this.approved.has(run.id) ? false : undefined;
    const exec = (sql: string) => this.queries.run(p, project.workspace_id, sql, { cache: false, countTotal: false, maxRows: 1, dryRun });
    const scalar = async (sql: string) => Number((await exec(sql)).rows[0]?.[0] ?? 0);
    const existing = new Map<string, string>();
    for (const r of (await this.queries.run(p, project.workspace_id, 'SELECT table_schema, table_name, table_type FROM information_schema.tables WHERE table_catalog = current_database()', { cache: false, countTotal: false, maxRows: 100_000 })).rows as string[][]) existing.set(`${r[0]}.${r[1]}`.toLowerCase(), r[2]!);
    const results = new Map<string, DbtNodeResult>();
    const blocked = (n: ManifestNode) => deps(n).some((d) => ['error', 'fail', 'skipped'].includes(results.get(d)?.status ?? ''));

    for (const n of order) {
      const r = base(n);
      const t0 = performance.now();
      if (blocked(n)) {
        r.status = 'skipped';
        r.message = 'Skipped: an upstream node failed';
        results.set(n.unique_id, r);
        continue;
      }
      try {
        const relation = n.relation_name ? this.rebind(n.relation_name, catalog) : null;
        const key = `${n.schema}.${n.alias || n.identifier || n.name}`.toLowerCase();
        const ensureSchema = () => exec(`CREATE SCHEMA IF NOT EXISTS ${qi(catalog)}.${qi(n.schema)}`);
        const dropIfKind = async (kind: 'VIEW' | 'BASE TABLE') => {
          const was = existing.get(key);
          if (was && was !== kind) await exec(`DROP ${was === 'VIEW' ? 'VIEW' : 'TABLE'} IF EXISTS ${relation}`);
        };
        if (n.resource_type === 'snapshot') {
          r.status = 'skipped';
          r.message = 'Snapshots are not supported yet';
        } else if (n.resource_type === 'seed') {
          await ensureSchema();
          await dropIfKind('BASE TABLE');
          const file = path.join(n.root_path ?? path.join(this.workDir(project.id), 'project'), n.original_file_path);
          const types = n.config.column_types as Record<string, string> | undefined;
          const delim = typeof n.config.delimiter === 'string' ? `, delim = ${lit(n.config.delimiter)}` : '';
          const typed = types && Object.keys(types).length ? `, types = {${Object.entries(types).map(([c, t]) => `${lit(c)}: ${lit(t)}`).join(', ')}}` : '';
          await exec(`CREATE OR REPLACE TABLE ${relation} AS SELECT * FROM read_csv(${lit(file)}, header = true${delim}${typed})`);
          existing.set(key, 'BASE TABLE');
          r.rows = await scalar(`SELECT count(*) FROM ${relation}`);
          r.status = 'success';
        } else if (n.resource_type === 'model') {
          if (n.language === 'python') throw new Error('Python models are not supported');
          const sql = this.rebind(n.compiled_code ?? '', catalog).trim().replace(/;\s*$/, '');
          if (!sql) throw new Error('The model compiled to nothing');
          await ensureSchema();
          const skippedHooks = await this.hooks(n, 'pre-hook', exec);
          const m = n.config.materialized ?? 'view';
          if (m === 'view') {
            await dropIfKind('VIEW');
            await exec(`CREATE OR REPLACE VIEW ${relation} AS ${sql}`);
            existing.set(key, 'VIEW');
          } else if (m === 'table') {
            await dropIfKind('BASE TABLE');
            await exec(`CREATE OR REPLACE TABLE ${relation} AS ${sql}`);
            existing.set(key, 'BASE TABLE');
            r.rows = await scalar(`SELECT count(*) FROM ${relation}`);
          } else if (m === 'incremental') {
            const exists = existing.get(key) === 'BASE TABLE';
            if (!exists || run.full_refresh) {
              await dropIfKind('BASE TABLE');
              await exec(`CREATE OR REPLACE TABLE ${relation} AS ${sql}`);
              existing.set(key, 'BASE TABLE');
              r.rows = await scalar(`SELECT count(*) FROM ${relation}`);
            } else {
              const staging = `${qi(catalog)}.${qi(n.schema)}.${qi(`${n.alias || n.name}__dbt_new`)}`;
              await exec(`CREATE OR REPLACE TABLE ${staging} AS ${sql}`);
              try {
                const keys = n.config.unique_key ? (Array.isArray(n.config.unique_key) ? n.config.unique_key : [n.config.unique_key]) : [];
                if (keys.length) await exec(`DELETE FROM ${relation} AS t WHERE EXISTS (SELECT 1 FROM ${staging} AS s WHERE ${keys.map((k) => `t.${qi(k)} IS NOT DISTINCT FROM s.${qi(k)}`).join(' AND ')})`);
                r.rows = await scalar(`SELECT count(*) FROM ${staging}`);
                await exec(`INSERT INTO ${relation} BY NAME SELECT * FROM ${staging}`);
              } finally {
                await exec(`DROP TABLE IF EXISTS ${staging}`);
              }
            }
          } else {
            throw new Error(`The ${m} materialization is not supported`);
          }
          const skippedPost = await this.hooks(n, 'post-hook', exec);
          if (skippedHooks + skippedPost) r.message = `${skippedHooks + skippedPost} hook(s) with Jinja were not run`;
          r.status = 'success';
        } else if (n.resource_type === 'test') {
          const sql = this.rebind(n.compiled_code ?? '', catalog).trim().replace(/;\s*$/, '');
          const failCalc = typeof n.config.fail_calc === 'string' ? n.config.fail_calc : 'count(*)';
          const failures = await scalar(`SELECT ${failCalc} FROM (${sql}) AS dbt_internal_test`);
          r.failures = failures;
          const severity = String(n.config.severity ?? 'ERROR').toUpperCase();
          const hit = (cond: unknown) => evalCondition(typeof cond === 'string' ? cond : '!=0', failures);
          r.status = severity === 'ERROR' && hit(n.config.error_if) ? 'fail' : hit(n.config.warn_if) ? 'warn' : 'pass';
          if (r.status !== 'pass') r.message = `${failures} failing row${failures === 1 ? '' : 's'}`;
        }
      } catch (err) {
        r.status = 'error';
        r.message = ((err as Error).message ?? String(err)).split('\n').slice(0, 4).join(' ').slice(0, 1500);
      }
      r.duration_ms = Math.round(performance.now() - t0);
      results.set(n.unique_id, r);
    }
    return order.map((n) => results.get(n.unique_id)!);
  }

  /** Runs a model's hooks that carry no Jinja (dbt did not render them); returns how many were left out. */
  private async hooks(n: ManifestNode, key: 'pre-hook' | 'post-hook', exec: (sql: string) => Promise<unknown>): Promise<number> {
    const list = (n.config[key] as { sql: string }[] | undefined) ?? [];
    let skipped = 0;
    for (const h of list) {
      if (/\{\{|\{%/.test(h.sql)) skipped++;
      else if (h.sql.trim()) await exec(h.sql);
    }
    return skipped;
  }

  /** Descriptions and tags from the project's YAML become catalog notes (Copilot reads them). */
  private async importDocs(p: Principal, project: DbtProject, nodes: Map<string, ManifestNode>, results: DbtNodeResult[]): Promise<void> {
    const docs: { object_name: string; column_name: string | null; description: string | null; tags: string[] }[] = [];
    for (const r of results) {
      if (r.status !== 'success' || !r.relation) continue;
      const n = nodes.get(r.unique_id);
      if (!n) continue;
      const tags = [...new Set([...(n.tags ?? []), ...((n.config.tags as string[] | undefined) ?? [])])];
      if (n.description?.trim() || tags.length) docs.push({ object_name: r.relation, column_name: null, description: n.description?.trim() || null, tags });
      for (const c of Object.values(n.columns ?? {})) if (c.description?.trim() || c.tags?.length) docs.push({ object_name: r.relation, column_name: c.name, description: c.description?.trim() || null, tags: c.tags ?? [] });
    }
    if (docs.length) await this.lineage.importNotes(p, project.workspace_id, docs, `dbt:${project.id}`).catch((err) => logger().warn({ err: (err as Error).message }, 'dbt docs import failed'));
  }

  /** What the last runs of the workspace's projects built, for the lineage graph. */
  async lineageOf(workspaceId: string): Promise<{ project: DbtProject; built: { relation: string; materialized: string | null; upstream: string[] }[] }[]> {
    const projects = await this.db.select().from(this.s.dbtProjects).where(eq(this.s.dbtProjects.workspace_id, workspaceId));
    const out = [];
    for (const project of projects) {
      // Runs often build a selection: what the project builds is the union of recent runs, the latest run winning.
      const recent = await this.db.select().from(this.s.dbtRuns).where(eq(this.s.dbtRuns.project_id, project.id)).orderBy(desc(this.s.dbtRuns.started_at)).limit(25);
      const built = new Map<string, { relation: string; materialized: string | null; upstream: string[] }>();
      for (const run of recent) {
        if (run.command === 'compile' || run.command === 'test') continue;
        for (const r of run.results) {
          if (!r.relation || (r.resource_type !== 'model' && r.resource_type !== 'seed') || r.status !== 'success' || built.has(r.relation)) continue;
          built.set(r.relation, { relation: r.relation, materialized: r.resource_type === 'seed' ? 'seed' : r.materialized, upstream: r.depends_on });
        }
      }
      out.push({ project, built: [...built.values()] });
    }
    return out;
  }

  // ------------------------------------------------------------------ scheduler

  async tick(now = new Date()): Promise<string[]> {
    const due = await this.db.select().from(this.s.dbtProjects).where(and(eq(this.s.dbtProjects.enabled, true), lte(this.s.dbtProjects.next_run_at, now)));
    const started: string[] = [];
    for (const project of due) {
      if (this.running.has(project.id) || project.schedule.kind === 'manual') continue;
      await this.db.update(this.s.dbtProjects).set({ next_run_at: nextRunAt(project.schedule, now) }).where(eq(this.s.dbtProjects.id, project.id));
      const author = await this.auth.findActive(project.user_id);
      if (!author) {
        logger().warn({ project: project.id }, 'Scheduled dbt run skipped: the author no longer exists or has been deactivated');
        continue;
      }
      try {
        const { done } = await this.start(this.auth.principalFromUser(author, 'jwt', 'scheduler'), project.id, project.scheduled, 'schedule');
        started.push(project.id);
        void done.catch((err) => logger().warn({ project: project.id, err: (err as Error).message }, 'Scheduled dbt run failed'));
      } catch (err) {
        logger().warn({ project: project.id, err: (err as Error).message }, 'Scheduled dbt run could not start');
      }
    }
    return started;
  }

  startScheduler(intervalMs = 30_000): void {
    if (this.ticker) return;
    this.ticker = setInterval(() => void this.tick().catch((err) => logger().warn({ err: (err as Error).message }, 'dbt scheduler tick failed')), intervalMs);
    this.ticker.unref();
  }
  stop(): void {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
  }
}

/** The message of dbt's first error in a log: the "[ERROR]" / "... Error" line and the indented lines after it. */
export function dbtError(log: string): string {
  const lines = log.split('\n').map((l) => l.replace(/^\d\d:\d\d:\d\d\s+/, ''));
  const i = lines.findIndex((l) => /\[ERROR\]|^\s*(Compilation|Runtime|Parsing|Database|Dependency) Error\b|^\s*Encountered an error/.test(l));
  if (i < 0) return lines.map((l) => l.trim()).filter(Boolean).at(-1) ?? 'unknown error';
  const out: string[] = [];
  for (const l of lines.slice(i, i + 12)) {
    const t = l.trim();
    if (!t || /^\[WARNING\]/.test(t)) {
      if (out.length > 1) break;
      continue;
    }
    if (/^\[ERROR\]: Encountered an error:?$|^Encountered an error:?$/.test(t)) continue;
    out.push(t);
  }
  return out.join(' ').replace(/\s+/g, ' ').slice(0, 1500) || 'unknown error';
}

/** How DuckView runs dbt — for agents (MCP resource duckdb://guides/dbt) and Copilot. */
export const DBT_GUIDE = `# dbt in DuckView

A workspace keeps dbt projects (Transform → dbt). dbt Core with dbt-duckdb compiles them; DuckView runs the compiled SQL in the
workspace's own DuckDB engine, as the person (or agent) who started the run, under the same SQL guard, access policies and audit.

## Files
- \`dbt_project.yml\` at the root (name, profile, model-paths, +materialized per folder). DuckView writes profiles.yml — never add one.
- \`models/**.sql\`: one SELECT per model with Jinja — \`{{ ref('model_or_seed') }}\`, \`{{ source('src', 'table') }}\`,
  \`{{ config(materialized='view'|'table'|'incremental', unique_key='id') }}\`, \`{% if is_incremental() %} … {{ this }} … {% endif %}\`.
  Tables of the workspace that are not models can be read by name (\`from orders\`) or declared as sources in YAML:
  \`sources: [{name: raw, schema: main, tables: [{name: orders}]}]\`.
- \`models/**.yml\`: descriptions (they become catalog notes Copilot reads), column docs, data tests:
  \`data_tests: [unique, not_null]\`, \`accepted_values\` / \`relationships\` with \`arguments: {values: [...]}\` / \`{to: ref('x'), field: id}\`.
  Describe each model once across all YAML files.
- \`tests/*.sql\`: singular tests — a SELECT returning failing rows; \`{{ config(severity='warn') }}\` to warn instead of fail.
- \`semantic_models\` and \`metrics\` in YAML (dbt's MetricFlow spec) join the workspace's semantic layer after each run;
  query them with \`list_metrics\` / \`query_metrics\`.
- \`seeds/*.csv\`: small reference tables (loaded by seed / build). \`macros/*.sql\`, \`packages.yml\` (dbt_utils etc.) work.
- SQL is DuckDB SQL. Comments do not stop Jinja: never write \`{{ … }}\` in a comment; use \`{# … #}\`.

## Running
- \`compile\` (safe, shows compiled SQL) → \`build\` (seeds, models, tests in dependency order; a failing test skips everything
  downstream) · \`run\` (models) · \`test\` · \`seed\`. \`select\` / \`exclude\` take dbt syntax: \`orders+\`, \`+orders\`, \`tag:finance\`,
  \`path:models/marts\`. \`full_refresh\` rebuilds incremental models.
- Materializations: view, table, incremental (append, or delete + insert on unique_key), ephemeral.
- Not supported: snapshots, Python models, hooks with Jinja, unit tests, custom materializations, on-run-start/end.

## Workflow for agents
1. \`list_dbt_projects\` / \`get_dbt_project\` to read what exists; \`list_accessible_data\` for the workspace's tables.
2. Prove a model's SELECT with \`execute_query\`, then \`create_dbt_model\` (or \`write_dbt_files\` for YAML, tests, several files).
3. \`run_dbt\` with \`compile\` to check, then \`build\` with a selection. build / run / seed return an approval challenge first:
   show the plan to a person and repeat with \`dry_run: false\` once they approve.
4. On failures read the node messages (\`get_dbt_run\` with include_log for dbt's log), fix the files, run again.
`;

/** dbt's warn_if / error_if: "!=0", ">10", ">= 5", "=0", "<3". */
export function evalCondition(cond: string, n: number): boolean {
  const m = /^\s*(!=|<>|>=|<=|=|==|>|<)\s*(-?\d+(?:\.\d+)?)\s*$/.exec(cond);
  if (!m) return n !== 0;
  const v = Number(m[2]);
  switch (m[1]) {
    case '!=':
    case '<>':
      return n !== v;
    case '>=':
      return n >= v;
    case '<=':
      return n <= v;
    case '>':
      return n > v;
    case '<':
      return n < v;
    default:
      return n === v;
  }
}
