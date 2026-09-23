/**
 * Mosaic (uwdata/mosaic) backend: the workspace engine as a Mosaic data connector.
 *
 * A Mosaic coordinator sends two kinds of requests:
 *   - `arrow` / `json` — read-only SQL for charts, inputs and tables. These go through QueryService like any other
 *     query (role, guard, audit, result cache with ETag), with a higher row ceiling because pixel-binned rasters
 *     legitimately exceed the grid cap.
 *   - `exec` — Mosaic's pre-aggregation plumbing: `CREATE SCHEMA IF NOT EXISTS "mosaic"`,
 *     `CREATE TABLE IF NOT EXISTS "mosaic"."preagg_<hex>" AS SELECT …` and `DROP SCHEMA IF EXISTS "mosaic" CASCADE`,
 *     plus DuckView's own source views `CREATE OR REPLACE VIEW "<schema>_src_<hex>" AS SELECT …` that turn a file
 *     path or an ad-hoc query into a plain table name Mosaic can `FROM` (they live in the main schema because every
 *     Mosaic code path — marks, field info, consolidation — expects a single identifier; the prefix keeps them out of
 *     the catalogs), and materialised datasets `CREATE TABLE IF NOT EXISTS "<schema>_mem"."src_<hex>" AS SELECT …`
 *     in an attached in-memory database (attached on first use; never written to the workspace file) so that every
 *     interaction reads columnar memory instead of re-parsing a file. These are derived data, not workspace
 *     mutations: they are admitted only in exactly those shapes (validated statement by statement), run for any
 *     member with read access, never move the data epoch and are never held for agent approval. Everything else is
 *     rejected.
 *
 * Invalidation reuses the data epoch: whenever it moves the schema is dropped, the source views removed and the
 * in-memory database detached, so pre-aggregates and materialised datasets over changed data cannot be served; the
 * browser hears the same event and clears its coordinator.
 */
import type { DuckViewConfig } from '../config/index.js';
import type { EngineManager } from '../engine/duckdb.js';
import { resultToArrowIPC } from '../engine/arrow-export.js';
import { analyzeSql, splitStatements, stripTrailingSemicolon } from '../engine/sql-guard.js';
import type { QueryResult } from '../engine/results.js';
import type { WorkspaceService } from './workspaces.js';
import type { QueryService } from './query.js';
import type { AuditService } from './audit.js';
import type { Principal } from './principal.js';
import { requireScope } from './principal.js';
import { badRequest, forbidden } from './errors.js';
import type { CacheMeta } from './cache.js';
import { prepareSpec, sourceStatements, validateSpecStructure, type PreparedSpec, type Spec } from './mosaic-spec.js';
import { PolicyService, type Restriction } from './policies.js';
import { logger } from '../observability/logger.js';
import { metrics } from '../observability/metrics.js';

export type MosaicRequestType = 'arrow' | 'json' | 'exec';

export interface MosaicExecOutcome {
  statements: number;
  duration_ms: number;
}

export interface PrepareOutcome extends PreparedSpec {
  /** True when the spec is structurally valid and every dataset and table binds in the workspace. */
  ok: boolean;
  errors: string[];
  warnings: string[];
}

const HEX = '[0-9a-f]+';

export class MosaicService {
  constructor(private readonly cfg: DuckViewConfig, private readonly workspaces: WorkspaceService, private readonly queries: QueryService, private readonly engines: EngineManager, private readonly audit: AuditService) {}

  get enabled() {
    return this.cfg.mosaic.enabled;
  }
  get schema() {
    return this.cfg.mosaic.schema;
  }
  /** Name prefix of DuckView source views (main schema). */
  get viewPrefix() {
    return `${this.cfg.mosaic.schema}_src_`;
  }
  /** Attached in-memory database holding materialised datasets. */
  get memDb() {
    return `${this.cfg.mosaic.schema}_mem`;
  }

  /** Row- and column-level security (set by the context): restricted callers get their own, rewritten objects. */
  policies: PolicyService | null = null;

  /** The caller's restriction in a workspace, if any. */
  async restriction(p: Principal, workspaceId: string): Promise<Restriction | null> {
    if (!this.policies) return null;
    const w = await this.workspaces.get(p, workspaceId);
    return this.policies.restrictionFor(p, workspaceId, w.role);
  }

  /** What the browser needs: the schema, limits, and — per workspace — whether pre-aggregation is off for the caller. */
  async info(p: Principal | null, workspaceId?: string): Promise<{ enabled: boolean; schema: string; max_rows: number; restricted: boolean; suffix: string }> {
    const r = p && workspaceId ? await this.restriction(p, workspaceId).catch(() => null) : null;
    return { enabled: this.enabled, schema: this.schema, max_rows: this.cfg.mosaic.max_rows, restricted: !!r, suffix: r ? PolicyService.suffix(r.scope) : '' };
  }

  private assertEnabled() {
    if (!this.enabled) throw forbidden('Mosaic is disabled by configuration (mosaic.enabled)');
  }

  /** Read-only query for charts/tables; returns the cached QueryResult plus cache metadata. */
  async query(p: Principal, workspaceId: string, sql: string, opts: { ifNoneMatch?: string | null; refresh?: boolean } = {}): Promise<QueryResult & CacheMeta> {
    this.assertEnabled();
    requireScope(p, 'read');
    const analysis = analyzeSql(sql);
    if (analysis.statements.length !== 1) throw badRequest('Mosaic queries must be a single statement');
    if (analysis.isMutating) throw badRequest('Mosaic queries must be read-only (use exec for pre-aggregation plumbing)');
    const r = await this.queries.run(p, workspaceId, sql, { maxRows: this.cfg.mosaic.max_rows, rowCap: this.cfg.mosaic.max_rows, countTotal: false, ifNoneMatch: opts.ifNoneMatch, refresh: opts.refresh });
    const { analysis: _a, guardedSql: _g, ...rest } = r as typeof r & { guardedSql?: string };
    return rest;
  }

  /** Arrow IPC stream bytes for a read-only query. */
  async queryArrow(p: Principal, workspaceId: string, sql: string, opts: { ifNoneMatch?: string | null; refresh?: boolean } = {}): Promise<{ bytes: Uint8Array; meta: CacheMeta; rowCount: number; truncated: boolean }> {
    const r = await this.query(p, workspaceId, sql, opts);
    return { bytes: resultToArrowIPC(r.columns, r.rows), meta: { etag: r.etag, cached: r.cached, computed_at: r.computed_at }, rowCount: r.rowCount, truncated: r.truncated };
  }

  /**
   * Classifies one statement against the admitted exec shapes. Returns a label for the audit log or throws.
   * Identifiers are matched exactly as Mosaic's SQL generator quotes them (always double-quoted).
   */
  classifyExec(statement: string): 'create_schema' | 'create_preagg' | 'create_view' | 'create_table' | 'drop_schema' | 'drop_preagg' | 'drop_view' | 'drop_table' {
    const s = stripTrailingSemicolon(statement).trim();
    const schema = this.schema;
    const q = (id: string) => `"${id}"`;
    if (new RegExp(`^CREATE\\s+SCHEMA\\s+IF\\s+NOT\\s+EXISTS\\s+${q(schema)}$`, 'i').test(s)) return 'create_schema';
    if (new RegExp(`^DROP\\s+SCHEMA\\s+IF\\s+EXISTS\\s+${q(schema)}\\s+CASCADE$`, 'i').test(s)) return 'drop_schema';
    if (new RegExp(`^DROP\\s+TABLE\\s+IF\\s+EXISTS\\s+${q(schema)}\\.${q(`preagg_${HEX}`)}$`, 'i').test(s)) return 'drop_preagg';
    if (new RegExp(`^DROP\\s+TABLE\\s+IF\\s+EXISTS\\s+${q(this.memDb)}\\.${q(`src_${HEX}`)}$`, 'i').test(s)) return 'drop_table';
    if (new RegExp(`^DROP\\s+VIEW\\s+IF\\s+EXISTS\\s+${q(`${this.viewPrefix}${HEX}`)}$`, 'i').test(s)) return 'drop_view';
    const preagg = new RegExp(`^CREATE\\s+TABLE\\s+IF\\s+NOT\\s+EXISTS\\s+${q(schema)}\\.${q(`preagg_${HEX}`)}\\s+AS\\s+([\\s\\S]+)$`, 'i').exec(s);
    const table = new RegExp(`^CREATE\\s+TABLE\\s+IF\\s+NOT\\s+EXISTS\\s+${q(this.memDb)}\\.${q(`src_${HEX}`)}\\s+AS\\s+([\\s\\S]+)$`, 'i').exec(s);
    const view = new RegExp(`^CREATE\\s+(?:OR\\s+REPLACE\\s+)?VIEW\\s+${q(`${this.viewPrefix}${HEX}`)}\\s+AS\\s+([\\s\\S]+)$`, 'i').exec(s);
    const m = preagg ?? table ?? view;
    if (!m) throw forbidden(`Statement is not part of the Mosaic protocol and was rejected: ${s.slice(0, 120)}`);
    const body = analyzeSql(m[1]!);
    if (body.statements.length !== 1 || body.isMutating) throw forbidden('Mosaic CREATE statements may only wrap a single read-only SELECT');
    return preagg ? 'create_preagg' : table ? 'create_table' : 'create_view';
  }

  /** Attaches the in-memory database for materialised datasets if this engine does not have it yet. */
  private async ensureMemDb(engine: { runInternal(sql: string, timeoutMs?: number): Promise<Record<string, unknown>[]> }) {
    const rows = await engine.runInternal(`SELECT count(*) AS n FROM duckdb_databases() WHERE database_name = '${this.memDb}'`, 15_000);
    if (Number(rows[0]?.n ?? 0) === 0) await engine.runInternal(`ATTACH ':memory:' AS "${this.memDb}"`, 15_000);
  }

  /**
   * Runs Mosaic plumbing statements on the workspace engine. Any member with read access may do this — the
   * statements only ever create derived objects inside the Mosaic schema — and the data epoch does not move.
   */
  async exec(p: Principal, workspaceId: string, sql: string): Promise<MosaicExecOutcome> {
    this.assertEnabled();
    requireScope(p, 'read');
    await this.workspaces.get(p, workspaceId); // VIEWER suffices; 404 for non-members
    const statements = splitStatements(sql);
    if (statements.length === 0) throw badRequest('sql is required');
    const kinds = statements.map((st) => this.classifyExec(st));
    const start = performance.now();
    const restriction = await this.restriction(p, workspaceId);
    if (restriction) return this.execRestricted(p, workspaceId, statements, restriction, start, sql);
    try {
      const { engine } = await this.workspaces.engine(p, workspaceId);
      const actor = p.actorType === 'AGENT' ? 'agent' : 'user';
      // A pre-aggregate needs the schema; Mosaic itself only creates it alongside its first pre-aggregate.
      if (kinds.includes('create_preagg') && !kinds.includes('create_schema')) await engine.execute(`CREATE SCHEMA IF NOT EXISTS "${this.schema}"`, { maxRows: 1, actor });
      // A materialised dataset needs the in-memory database (attached lazily, once per engine lifetime).
      if (kinds.includes('create_table')) await this.ensureMemDb(engine);
      // Statement by statement: `execute` returns the last result only, and a clear per-statement failure beats a
      // partially applied batch that leaves the coordinator guessing.
      for (const st of statements) await engine.execute(st, { maxRows: 1, actor, timeoutMs: this.cfg.duckdb.query_timeout_seconds * 1000 });
      const duration_ms = Math.round(performance.now() - start);
      metrics.mosaicExec.inc({ kind: kinds.includes('create_preagg') ? 'preagg' : kinds.includes('create_table') ? 'table' : kinds.includes('create_view') ? 'view' : kinds.includes('drop_schema') ? 'drop' : 'schema' });
      this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'mosaic.exec', resource: `workspace:${workspaceId}`, queryText: sql.slice(0, 4000), durationMs: duration_ms, ip: p.ip });
      return { statements: statements.length, duration_ms };
    } catch (err) {
      this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'mosaic.exec', resource: `workspace:${workspaceId}`, queryText: sql.slice(0, 4000), durationMs: performance.now() - start, ip: p.ip, status: 'error', error: (err as Error).message });
      throw err;
    }
  }

  /**
   * Mosaic plumbing for someone under an access policy: dataset views and tables are created from the rewritten
   * query (their rows, their masks) under names salted with their scope, and recorded as theirs; pre-aggregates —
   * shared by design — are not available (the browser turns them off for such callers).
   */
  private async execRestricted(p: Principal, workspaceId: string, statements: string[], r: Restriction, start: number, sql: string): Promise<MosaicExecOutcome> {
    const { engine } = await this.workspaces.engine(p, workspaceId);
    const policies = this.policies!;
    try {
      for (const raw of statements) {
        const st = stripTrailingSemicolon(raw).trim();
        const view = new RegExp(`^CREATE\\s+(?:OR\\s+REPLACE\\s+)?VIEW\\s+"(${this.viewPrefix}${HEX})"\\s+AS\\s+([\\s\\S]+)$`, 'i').exec(st);
        const table = new RegExp(`^CREATE\\s+TABLE\\s+IF\\s+NOT\\s+EXISTS\\s+"${this.memDb}"\\."(src_${HEX})"\\s+AS\\s+([\\s\\S]+)$`, 'i').exec(st);
        const drop = new RegExp(`^DROP\\s+(VIEW|TABLE)\\s+IF\\s+EXISTS\\s+(?:"${this.memDb}"\\.)?"(${this.viewPrefix}${HEX}|src_${HEX})"$`, 'i').exec(st);
        if (/^CREATE\s+SCHEMA\s+IF\s+NOT\s+EXISTS/i.test(st)) continue;
        if (view || table) {
          const [, name, body] = (view ?? table)!;
          const catalog = table ? this.memDb : '';
          const owner = policies.scopeOf(catalog, name!);
          if (owner !== undefined && owner !== r.scope) throw forbidden(`${name} belongs to someone else`);
          const rewritten = await policies.rewrite(engine, body!, r);
          if (table) {
            await this.ensureMemDb(engine);
            await engine.runInternal(`CREATE ${owner === r.scope ? 'TABLE IF NOT EXISTS' : 'OR REPLACE TABLE'} "${this.memDb}"."${name}" AS ${rewritten}`, this.cfg.duckdb.query_timeout_seconds * 1000);
          } else await engine.runInternal(`CREATE OR REPLACE VIEW "${name}" AS ${rewritten}`, this.cfg.duckdb.query_timeout_seconds * 1000);
          policies.registerScoped(catalog, name!, r.scope);
          continue;
        }
        if (drop) {
          const catalog = drop[1]!.toUpperCase() === 'TABLE' ? this.memDb : '';
          if (policies.scopeOf(catalog, drop[2]!) === r.scope) await engine.runInternal(st, 30_000);
          continue;
        }
        throw forbidden('Access policies apply to you in this workspace: Mosaic pre-aggregation is not available');
      }
      const duration_ms = Math.round(performance.now() - start);
      this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'mosaic.exec', resource: `workspace:${workspaceId}`, queryText: sql.slice(0, 4000), durationMs: duration_ms, ip: p.ip });
      return { statements: statements.length, duration_ms };
    } catch (err) {
      this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'mosaic.exec', resource: `workspace:${workspaceId}`, queryText: sql.slice(0, 4000), durationMs: performance.now() - start, ip: p.ip, status: 'error', error: (err as Error).message });
      throw err;
    }
  }

  /**
   * Validates and prepares a spec for a workspace: structure in Mosaic's terms, then — unless `bind` is off — every
   * dataset's SELECT and every plain `from:` table is bound with EXPLAIN (no data is read), so a missing file,
   * table or column is reported before anything renders or is saved. Statements are checked against the exec
   * policy exactly as the browser would submit them.
   */
  async prepare(p: Principal, workspaceId: string, spec: Spec, opts: { bind?: boolean } = {}): Promise<PrepareOutcome> {
    this.assertEnabled();
    requireScope(p, 'read');
    await this.workspaces.get(p, workspaceId);
    const structure = validateSpecStructure(spec);
    const errors = [...structure.errors];
    const warnings = [...structure.warnings];
    const cap = this.cfg.mosaic.materialize_max_rows;
    let prepared: PreparedSpec = { spec, statements: [], sources: [], tables: [] };
    try {
      const r = await this.restriction(p, workspaceId);
      prepared = prepareSpec(spec, { viewPrefix: this.viewPrefix, memDb: this.memDb, materialize: cap > 0, salt: r ? PolicyService.suffix(r.scope) : '' });
    } catch (err) {
      errors.push((err as Error).message);
    }
    if (opts.bind !== false && errors.length === 0) {
      for (const src of prepared.sources) {
        try {
          for (const st of sourceStatements(src)) this.classifyExec(st);
          await this.queries.explain(p, workspaceId, src.body);
          // Materialisation is bounded: a dataset above the cap stays a view (the count is cached like any query).
          if (src.materialize && cap > 0) {
            const r = await this.queries.run(p, workspaceId, `SELECT count(*) AS n FROM (${src.body}) AS _dv`, { maxRows: 1, countTotal: false });
            const n = Number(r.rows[0]?.[0] ?? 0);
            if (n > cap) {
              src.materialize = false;
              warnings.push(`data.${src.name}: ${n.toLocaleString()} rows exceed mosaic.materialize_max_rows (${cap.toLocaleString()}); served as a view — interactions will re-read the source`);
            }
          } else if (src.materialize && cap === 0) src.materialize = false;
        } catch (err) {
          errors.push(`data.${src.name}: ${(err as Error).message}`);
        }
      }
      prepared.statements = prepared.sources.flatMap(sourceStatements);
      for (const table of prepared.tables) {
        if (table.startsWith(this.viewPrefix)) continue;
        try {
          await this.queries.explain(p, workspaceId, `SELECT * FROM "${table.replace(/"/g, '""')}"`);
        } catch (err) {
          errors.push(`from: ${table}: ${(err as Error).message}${spec.data && typeof spec.data === 'object' ? '' : ' — declare files and queries under `data`, or use a table that exists in the workspace'}`);
        }
      }
    }
    return { ...prepared, ok: errors.length === 0, errors, warnings };
  }

  /**
   * Drops the Mosaic schema (pre-aggregates), DuckView's source views and the in-memory database of materialised
   * datasets of a running engine — called when the workspace data epoch moves. All are rebuilt lazily by the next
   * interaction; the browser is told through the same live event.
   */
  async dropSchema(workspaceId: string): Promise<boolean> {
    const engine = this.engines.peek(workspaceId);
    if (!engine) return false;
    try {
      await engine.runInternal(`DROP SCHEMA IF EXISTS "${this.schema}" CASCADE`, 30_000);
      const views = await engine.runInternal(`SELECT view_name FROM duckdb_views() WHERE NOT internal AND schema_name = 'main' AND view_name LIKE '${this.viewPrefix}%'`, 15_000);
      for (const v of views) await engine.runInternal(`DROP VIEW IF EXISTS "${String(v.view_name).replace(/"/g, '""')}"`, 15_000);
      await engine.runInternal(`DETACH DATABASE IF EXISTS "${this.memDb}"`, 30_000);
      return true;
    } catch (err) {
      logger().warn({ workspaceId, err: (err as Error).message }, 'Could not drop the Mosaic schema after an epoch change');
      return false;
    }
  }
}
