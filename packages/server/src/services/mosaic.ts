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
 *     the catalogs). These are derived data, not workspace mutations: they are
 *     admitted only in exactly those shapes (validated statement by statement), run for any member with read access,
 *     never move the data epoch and are never held for agent approval. Everything else is rejected.
 *
 * Invalidation reuses the data epoch: whenever it moves the schema is dropped, so pre-aggregates over changed data
 * cannot be served; the browser hears the same event and clears its coordinator.
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
import { prepareSpec, validateSpecStructure, type PreparedSpec, type Spec } from './mosaic-spec.js';
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
  classifyExec(statement: string): 'create_schema' | 'create_preagg' | 'create_view' | 'drop_schema' | 'drop_preagg' | 'drop_view' {
    const s = stripTrailingSemicolon(statement).trim();
    const schema = this.schema;
    const q = (id: string) => `"${id}"`;
    if (new RegExp(`^CREATE\\s+SCHEMA\\s+IF\\s+NOT\\s+EXISTS\\s+${q(schema)}$`, 'i').test(s)) return 'create_schema';
    if (new RegExp(`^DROP\\s+SCHEMA\\s+IF\\s+EXISTS\\s+${q(schema)}\\s+CASCADE$`, 'i').test(s)) return 'drop_schema';
    if (new RegExp(`^DROP\\s+TABLE\\s+IF\\s+EXISTS\\s+${q(schema)}\\.${q(`preagg_${HEX}`)}$`, 'i').test(s)) return 'drop_preagg';
    if (new RegExp(`^DROP\\s+VIEW\\s+IF\\s+EXISTS\\s+${q(`${this.viewPrefix}${HEX}`)}$`, 'i').test(s)) return 'drop_view';
    const preagg = new RegExp(`^CREATE\\s+TABLE\\s+IF\\s+NOT\\s+EXISTS\\s+${q(schema)}\\.${q(`preagg_${HEX}`)}\\s+AS\\s+([\\s\\S]+)$`, 'i').exec(s);
    const view = new RegExp(`^CREATE\\s+(?:OR\\s+REPLACE\\s+)?VIEW\\s+${q(`${this.viewPrefix}${HEX}`)}\\s+AS\\s+([\\s\\S]+)$`, 'i').exec(s);
    const m = preagg ?? view;
    if (!m) throw forbidden(`Statement is not part of the Mosaic protocol and was rejected: ${s.slice(0, 120)}`);
    const body = analyzeSql(m[1]!);
    if (body.statements.length !== 1 || body.isMutating) throw forbidden('Mosaic CREATE statements may only wrap a single read-only SELECT');
    return preagg ? 'create_preagg' : 'create_view';
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
    try {
      const { engine } = await this.workspaces.engine(p, workspaceId);
      const actor = p.actorType === 'AGENT' ? 'agent' : 'user';
      // A pre-aggregate needs the schema; Mosaic itself only creates it alongside its first pre-aggregate.
      if (kinds.includes('create_preagg') && !kinds.includes('create_schema')) await engine.execute(`CREATE SCHEMA IF NOT EXISTS "${this.schema}"`, { maxRows: 1, actor });
      // Statement by statement: `execute` returns the last result only, and a clear per-statement failure beats a
      // partially applied batch that leaves the coordinator guessing.
      for (const st of statements) await engine.execute(st, { maxRows: 1, actor });
      const duration_ms = Math.round(performance.now() - start);
      metrics.mosaicExec.inc({ kind: kinds.includes('create_preagg') ? 'preagg' : kinds.includes('create_view') ? 'view' : kinds.includes('drop_schema') ? 'drop' : 'schema' });
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
    let prepared: PreparedSpec = { spec, statements: [], sources: [], tables: [] };
    try {
      prepared = prepareSpec(spec, this.viewPrefix);
    } catch (err) {
      errors.push((err as Error).message);
    }
    if (opts.bind !== false && errors.length === 0) {
      for (const [i, src] of prepared.sources.entries()) {
        try {
          this.classifyExec(prepared.statements[i]!);
          await this.queries.explain(p, workspaceId, src.body);
        } catch (err) {
          errors.push(`data.${src.name}: ${(err as Error).message}`);
        }
      }
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
   * Drops the Mosaic schema (pre-aggregates) and DuckView's source views of a running engine — called when the
   * workspace data epoch moves. Both are rebuilt lazily by the next interaction; the browser is told through the
   * same live event.
   */
  async dropSchema(workspaceId: string): Promise<boolean> {
    const engine = this.engines.peek(workspaceId);
    if (!engine) return false;
    try {
      await engine.runInternal(`DROP SCHEMA IF EXISTS "${this.schema}" CASCADE`, 30_000);
      const views = await engine.runInternal(`SELECT view_name FROM duckdb_views() WHERE NOT internal AND schema_name = 'main' AND view_name LIKE '${this.viewPrefix}%'`, 15_000);
      for (const v of views) await engine.runInternal(`DROP VIEW IF EXISTS "${String(v.view_name).replace(/"/g, '""')}"`, 15_000);
      return true;
    } catch (err) {
      logger().warn({ workspaceId, err: (err as Error).message }, 'Could not drop the Mosaic schema after an epoch change');
      return false;
    }
  }
}
