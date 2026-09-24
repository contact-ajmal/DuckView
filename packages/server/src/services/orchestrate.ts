/**
 * Orchestration: one API for Airflow, Dagster, Prefect, cron jobs and CI to run what DuckView runs — a sync, a dbt
 * command, a data quality suite, a reverse sync, a notebook, an alert, a snapshot, a hosted agent, a metric monitor,
 * or a SQL check — and to wait for one status: running, succeeded or failed.
 *
 * A run starts in the background and is recorded (orchestration_runs), so a task can start it and poll, and a
 * failure is a failure for the orchestrator: a quality suite that fails (or warns, with fail_on_warn), an alert that
 * triggers (with fail_on_trigger), a monitor that finds something unusual (with fail_on_anomaly), a SQL check whose
 * rows say something is wrong (fail_if: rows | no_rows), a dbt command, sync, notebook or agent that errors.
 *
 * Starting runs needs the write scope: an orchestrator runs a pipeline a person set up, as that person (their
 * permissions and access policies), so the approval asked of agents that decide on their own is not asked here.
 */
import { and, desc, eq } from 'drizzle-orm';
import type { MetadataStore } from '../db/index.js';
import type { OrchestrationKind, OrchestrationRun } from '../db/schema/sqlite.js';
import { ORCHESTRATION_KINDS } from '../db/schema/sqlite.js';
import { newId } from '../security/crypto.js';
import type { Principal } from './principal.js';
import { requireWrite } from './principal.js';
import type { AppContext } from '../context.js';
import { badRequest, notFound } from './errors.js';
import { logger } from '../observability/logger.js';

export interface OrchestrateInput {
  kind: OrchestrationKind;
  /** The object to run (sync, project, suite …); for query, the workspace. */
  id: string;
  /** dbt: command (build by default), select, exclude, full_refresh. */
  command?: 'build' | 'run' | 'test' | 'seed' | 'compile' | null;
  select?: string | null;
  exclude?: string | null;
  full_refresh?: boolean;
  /** query: the SQL, and when it fails. */
  sql?: string | null;
  fail_if?: 'rows' | 'no_rows' | null;
  /** agent: the task (its default task when empty). */
  input?: string | null;
  fail_on_warn?: boolean;
  fail_on_trigger?: boolean;
  fail_on_anomaly?: boolean;
  source?: string | null;
  external_run_id?: string | null;
}

interface Outcome {
  ok: boolean;
  summary: string;
  workspace_id?: string | null;
  label?: string;
  detail?: Record<string, unknown>;
}

export class OrchestrationService {
  private ctx!: AppContext;
  private pending = new Map<string, Promise<OrchestrationRun>>();

  constructor(private readonly store: MetadataStore) {}
  bind(ctx: AppContext) {
    this.ctx = ctx;
  }
  private get db() {
    return this.store.db;
  }
  private get s() {
    return this.store.schema;
  }

  /** Checks the target exists and can be run by `p`; returns its name and workspace. */
  private async resolve(p: Principal, input: OrchestrateInput): Promise<{ label: string; workspace_id: string | null }> {
    const c = this.ctx;
    switch (input.kind) {
      case 'sync': {
        const x = await c.syncs.get(p, input.id, 'EDITOR');
        return { label: x.name, workspace_id: x.workspace_id };
      }
      case 'dbt': {
        const x = await c.dbt.get(p, input.id);
        return { label: `${x.name} · dbt ${input.command ?? 'build'}${input.select ? ` -s ${input.select}` : ''}`, workspace_id: x.workspace_id };
      }
      case 'quality': {
        const x = await c.quality.get(p, input.id, 'EDITOR');
        return { label: x.name, workspace_id: x.workspace_id };
      }
      case 'reverse_sync': {
        const x = await c.reverse.get(p, input.id);
        return { label: x.name, workspace_id: x.workspace_id };
      }
      case 'notebook': {
        const x = await c.notebooks.get(p, input.id, 'EDITOR');
        return { label: x.title, workspace_id: x.workspace_id };
      }
      case 'alert': {
        const x = await c.alerts.get(p, input.id, 'EDITOR');
        return { label: x.name, workspace_id: x.workspace_id };
      }
      case 'snapshot': {
        const x = await c.snapshots.get(p, input.id, 'EDITOR');
        return { label: x.name, workspace_id: x.workspace_id };
      }
      case 'agent': {
        const x = await c.hostedAgents.get(p, input.id, 'EDITOR');
        return { label: x.name, workspace_id: x.workspace_id };
      }
      case 'monitor': {
        const x = await c.insights.get(p, input.id, 'EDITOR');
        return { label: x.name, workspace_id: x.workspace_id };
      }
      case 'query': {
        await c.workspaces.get(p, input.id);
        if (!input.sql?.trim()) throw badRequest('sql is required for a query run');
        return { label: input.sql.trim().split('\n')[0]!.slice(0, 120), workspace_id: input.id };
      }
    }
  }

  private async execute(p: Principal, input: OrchestrateInput): Promise<Outcome> {
    const c = this.ctx;
    switch (input.kind) {
      case 'sync': {
        const r = await c.syncs.run(input.id, 'manual', p.userId);
        return { ok: r.status === 'ok', summary: r.status === 'ok' ? `${r.rows ?? 0} rows loaded` : r.error ?? 'failed', detail: { run_id: r.id, rows: r.rows } };
      }
      case 'dbt': {
        const { done } = await c.dbt.start(p, input.id, { command: input.command ?? 'build', select: input.select ?? null, exclude: input.exclude ?? null, full_refresh: !!input.full_refresh }, 'manual', { approved: true });
        const r = await done;
        const failed = (r.results ?? []).filter((n) => n.status !== 'success' && n.status !== 'pass' && n.status !== 'skipped');
        return { ok: r.status === 'ok', summary: r.status === 'ok' ? `dbt ${input.command ?? 'build'}: ${(r.results ?? []).length} nodes` : `dbt ${input.command ?? 'build'} failed${failed.length ? `: ${failed.slice(0, 5).map((n) => n.name).join(', ')}` : ''}`, detail: { run_id: r.id, failed: failed.map((n) => ({ name: n.name, status: n.status, message: n.message })) } };
      }
      case 'quality': {
        const { run } = await c.quality.run(input.id, 'agent', p);
        const ok = run.status === 'pass' || (run.status === 'warn' && !input.fail_on_warn);
        return { ok, summary: `${run.status}: ${run.summary}`, detail: { run_id: run.id, status: run.status, failing: run.results.filter((x) => x.status !== 'pass').map((x) => ({ check: x.label, status: x.status, message: x.message })) } };
      }
      case 'reverse_sync': {
        const r = await c.reverse.run(input.id, 'manual', p, { approved: true });
        return { ok: r.status === 'ok', summary: r.summary ?? r.error ?? r.status, detail: { run_id: r.id, rows_sent: r.rows_sent, rows_deleted: r.rows_deleted } };
      }
      case 'notebook': {
        const r = await c.notebooks.runAll(p, input.id);
        return { ok: !r.failed, summary: r.failed ? `cell ${r.failed} failed: ${String((r.outputs[r.failed] as { error?: string } | undefined)?.error ?? '').split('\n')[0]}` : `${r.ran} cells ran`, detail: { ran: r.ran, failed: r.failed } };
      }
      case 'alert': {
        const r = await c.alerts.run(input.id, 'manual', p);
        const e = r.evaluation;
        const ok = e.state === 'ok' || (e.state === 'triggered' && !input.fail_on_trigger);
        return { ok, summary: `${e.state}: ${e.summary}`, detail: { state: e.state, value: e.value, notified: r.notified } };
      }
      case 'snapshot': {
        const r = await c.snapshots.run(input.id, 'manual', p);
        return { ok: r.run.status === 'ok', summary: r.run.status === 'ok' ? 'rendered and delivered' : String((r.run as { error?: string | null }).error ?? 'failed'), detail: { run_id: r.run.id } };
      }
      case 'agent': {
        const r = await c.hostedAgents.run(input.id, { p, input: input.input ?? null, triggeredBy: 'orchestrator', wait: true });
        return { ok: r.status === 'completed', summary: r.status === 'completed' ? (r.output ?? '').replace(/\s+/g, ' ').slice(0, 300) : r.error ?? 'failed', detail: { run_id: r.id, output: r.output, steps: r.steps.length } };
      }
      case 'monitor': {
        const r = await c.insights.run(input.id, p);
        const status = r.monitor.status;
        return { ok: status !== 'error' && !(status === 'anomaly' && input.fail_on_anomaly), summary: r.monitor.last_run?.summary ?? status, detail: { status, new_insights: r.created.length } };
      }
      case 'query': {
        const r = await c.queries.run(p, input.id, input.sql!, { cache: false, countTotal: false, maxRows: 100 });
        const n = r.rows.length;
        const ok = input.fail_if === 'rows' ? n === 0 : input.fail_if === 'no_rows' ? n > 0 : true;
        return { ok, summary: `${n}${r.truncated ? '+' : ''} row${n === 1 ? '' : 's'}${ok ? '' : input.fail_if === 'rows' ? ' (expected none)' : ' (expected some)'}`, detail: { columns: r.columns.map((x) => x.name), rows: r.rows.slice(0, 20) } };
      }
    }
  }

  /** Starts a run; with wait, resolves when it has finished. */
  async start(p: Principal, input: OrchestrateInput, opts: { wait?: boolean } = {}): Promise<OrchestrationRun> {
    requireWrite(p);
    if (!ORCHESTRATION_KINDS.includes(input.kind)) throw badRequest(`kind must be one of ${ORCHESTRATION_KINDS.join(', ')}`);
    const target = await this.resolve(p, input);
    const row: OrchestrationRun = { id: newId(), user_id: p.userId, workspace_id: target.workspace_id, kind: input.kind, target_id: input.kind === 'query' ? null : input.id, label: target.label, status: 'running', summary: null, detail: {}, source: (input.source ?? 'api').slice(0, 40), external_run_id: input.external_run_id?.slice(0, 250) ?? null, started_at: new Date(), finished_at: null };
    await this.db.insert(this.s.orchestrationRuns).values(row);
    this.ctx.audit.log({ userId: p.userId, actorType: p.actorType, action: `orchestrate.${input.kind}`, resource: `${input.kind}:${input.id}`, ip: p.ip });
    const done = (async () => {
      let out: Outcome;
      try {
        out = await this.execute(p, input);
      } catch (err) {
        out = { ok: false, summary: ((err as Error).message ?? String(err)).split('\n')[0]!.slice(0, 500) };
      }
      const finished: OrchestrationRun = { ...row, status: out.ok ? 'succeeded' : 'failed', summary: out.summary.slice(0, 1000), detail: out.detail ?? {}, finished_at: new Date() };
      await this.db.update(this.s.orchestrationRuns).set({ status: finished.status, summary: finished.summary, detail: finished.detail, finished_at: finished.finished_at }).where(eq(this.s.orchestrationRuns.id, row.id));
      return finished;
    })().finally(() => this.pending.delete(row.id));
    this.pending.set(row.id, done);
    if (opts.wait) return done;
    done.catch((err) => logger().warn({ run: row.id, err: (err as Error).message }, 'Orchestrated run failed to record'));
    return row;
  }

  async get(p: Principal, id: string): Promise<OrchestrationRun> {
    const r = (await this.db.select().from(this.s.orchestrationRuns).where(and(eq(this.s.orchestrationRuns.id, id), eq(this.s.orchestrationRuns.user_id, p.userId))).limit(1))[0];
    if (!r) throw notFound('Run');
    return r;
  }

  /** Waits up to `seconds` for a run to finish (long polling), then returns it as it is. */
  async wait(p: Principal, id: string, seconds: number): Promise<OrchestrationRun> {
    const r = await this.get(p, id);
    const pending = this.pending.get(id);
    if (r.status !== 'running' || !pending) return r;
    await Promise.race([pending.catch(() => undefined), new Promise((res) => setTimeout(res, Math.min(Math.max(seconds, 0), 60) * 1000))]);
    return this.get(p, id);
  }

  async list(p: Principal, limit = 50): Promise<OrchestrationRun[]> {
    return this.db.select().from(this.s.orchestrationRuns).where(eq(this.s.orchestrationRuns.user_id, p.userId)).orderBy(desc(this.s.orchestrationRuns.started_at)).limit(Math.min(limit, 500));
  }
}
