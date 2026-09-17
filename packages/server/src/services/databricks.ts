/**
 * Databricks workspace client: Unity Catalog metadata (catalogs → schemas → tables → columns) and the SQL
 * Statement Execution API against a SQL warehouse. Plain fetch so a mock server can stand in for tests.
 *
 * Auth: personal access token, or OAuth M2M (service principal) via {host}/oidc/v1/token (client_credentials, all-apis).
 */
import { HttpError } from './errors.js';
import type { ColumnSchema } from '../engine/results.js';
import { kindOf } from '../engine/results.js';

export interface DatabricksAuth {
  token?: string;
  client_id?: string;
  client_secret?: string;
}

export interface UcCatalog {
  name: string;
  comment?: string;
  catalog_type?: string;
}
export interface UcSchema {
  name: string;
  full_name?: string;
  comment?: string;
}
export interface UcTable {
  name: string;
  full_name?: string;
  table_type?: string; // MANAGED | EXTERNAL | VIEW | …
  data_source_format?: string; // DELTA | ICEBERG | PARQUET | …
  properties?: Record<string, string>;
  comment?: string;
  columns?: UcColumn[];
}
export interface UcColumn {
  name: string;
  type_text: string;
  type_name: string;
  nullable?: boolean;
  position?: number;
  comment?: string;
}

export interface StatementResult {
  columns: ColumnSchema[];
  rows: unknown[][];
  rowCount: number;
  totalRows: number | null;
  truncated: boolean;
  statementId: string;
  durationMs: number;
  /** Databricks type names (type_text) per column, for materialisation. */
  duckTypes: string[];
}

interface StatementResponse {
  statement_id: string;
  status: { state: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELED' | 'CLOSED'; error?: { error_code?: string; message?: string } };
  manifest?: { schema: { column_count: number; columns: UcColumn[] }; total_row_count?: number; truncated?: boolean; total_chunk_count?: number; chunks?: { chunk_index: number; row_offset: number; row_count: number }[] };
  result?: { chunk_index: number; row_offset: number; row_count: number; data_array?: (string | null)[][]; next_chunk_index?: number; next_chunk_internal_link?: string };
}

/** UniForm / Iceberg tables are readable by DuckDB through the Unity Catalog Iceberg REST endpoint. */
export function isIcebergReadable(t: UcTable): boolean {
  const fmt = (t.data_source_format ?? '').toUpperCase();
  if (fmt === 'ICEBERG') return true;
  const p = t.properties ?? {};
  return /iceberg/i.test(p['delta.universalFormat.enabledFormats'] ?? '') || p['delta.enableIcebergCompatV2'] === 'true';
}

/** Databricks type_name/type_text → DuckDB type for CREATE TABLE / read_json columns. */
export function databricksTypeToDuck(typeName: string, typeText?: string): string {
  const n = typeName.toUpperCase();
  const t = (typeText ?? '').toUpperCase();
  switch (n) {
    case 'BOOLEAN':
      return 'BOOLEAN';
    case 'BYTE':
      return 'TINYINT';
    case 'SHORT':
      return 'SMALLINT';
    case 'INT':
      return 'INTEGER';
    case 'LONG':
      return 'BIGINT';
    case 'FLOAT':
      return 'FLOAT';
    case 'DOUBLE':
      return 'DOUBLE';
    case 'DECIMAL': {
      const m = /DECIMAL\((\d+),\s*(\d+)\)/.exec(t);
      return m ? `DECIMAL(${m[1]},${m[2]})` : 'DECIMAL(38,18)';
    }
    case 'DATE':
      return 'DATE';
    case 'TIMESTAMP':
    case 'TIMESTAMP_NTZ':
      return 'TIMESTAMP';
    case 'INTERVAL':
      return 'INTERVAL';
    case 'BINARY':
      return 'BLOB';
    case 'ARRAY':
    case 'MAP':
    case 'STRUCT':
    case 'VARIANT':
      return 'JSON';
    default:
      return 'VARCHAR';
  }
}

function coerceCell(v: string | null, duckType: string): unknown {
  if (v === null || v === undefined) return null;
  const k = kindOf(duckType);
  if (k === 'number') {
    if (/^(BIGINT|HUGEINT|DECIMAL)/i.test(duckType) && v.replace(/[^0-9]/g, '').length > 15) return v; // beyond double precision: keep as text
    const n = Number(v);
    return Number.isFinite(n) ? n : v;
  }
  if (k === 'boolean') return v === 'true';
  if (k === 'json') {
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }
  return v;
}

export class DatabricksClient {
  private readonly host: string;
  private tokenCache: { value: string; expires: number } | null = null;

  constructor(host: string, private readonly auth: DatabricksAuth, private readonly opts: { timeoutMs?: number; pollIntervalMs?: number; fetchImpl?: typeof fetch } = {}) {
    const h = host.trim().replace(/\/+$/, '');
    this.host = /^https?:\/\//i.test(h) ? h : `https://${h}`;
  }

  private get fetch() {
    return this.opts.fetchImpl ?? fetch;
  }

  async bearer(): Promise<string> {
    if (this.auth.token) return this.auth.token;
    if (!this.auth.client_id || !this.auth.client_secret) throw new HttpError(400, 'Databricks credentials required (personal access token or OAuth client id + secret)', 'LAKEHOUSE_AUTH_REQUIRED');
    if (this.tokenCache && this.tokenCache.expires > Date.now() + 30_000) return this.tokenCache.value;
    const res = await this.fetch(`${this.host}/oidc/v1/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${Buffer.from(`${this.auth.client_id}:${this.auth.client_secret}`).toString('base64')}` },
      body: 'grant_type=client_credentials&scope=all-apis',
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000),
    });
    if (!res.ok) throw new HttpError(res.status === 401 || res.status === 400 ? 403 : 502, `Databricks OAuth token request failed (${res.status})`, 'LAKEHOUSE_AUTH_FAILED');
    const j = (await res.json()) as { access_token: string; expires_in?: number };
    this.tokenCache = { value: j.access_token, expires: Date.now() + (j.expires_in ?? 3600) * 1000 };
    return j.access_token;
  }

  private async request<T>(method: string, path: string, body?: unknown, timeoutMs?: number): Promise<T> {
    const token = await this.bearer();
    let res: Response;
    try {
      res = await this.fetch(`${this.host}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs ?? this.opts.timeoutMs ?? 60_000),
      });
    } catch (err) {
      throw new HttpError(502, `Cannot reach Databricks at ${this.host}: ${(err as Error).message}`, 'LAKEHOUSE_UNREACHABLE');
    }
    if (!res.ok) {
      let msg = `${res.status} ${res.statusText}`;
      try {
        const j = (await res.json()) as { message?: string; error_code?: string; error?: string };
        msg = j.message ?? j.error ?? msg;
        if (j.error_code) msg = `${j.error_code}: ${msg}`;
      } catch {
        /* non-JSON error body */
      }
      const auth = res.status === 401 || res.status === 403;
      throw new HttpError(auth ? 403 : res.status === 404 ? 404 : 502, `Databricks: ${msg}`, auth ? 'LAKEHOUSE_AUTH_FAILED' : res.status === 404 ? 'LAKEHOUSE_NOT_FOUND' : 'LAKEHOUSE_ERROR');
    }
    return (await res.json()) as T;
  }

  // ---------------------------------------------------------------- Unity Catalog

  async listCatalogs(): Promise<UcCatalog[]> {
    const r = await this.request<{ catalogs?: UcCatalog[] }>('GET', '/api/2.1/unity-catalog/catalogs');
    return (r.catalogs ?? []).sort((a, b) => a.name.localeCompare(b.name));
  }

  async listSchemas(catalog: string): Promise<UcSchema[]> {
    const r = await this.request<{ schemas?: UcSchema[] }>('GET', `/api/2.1/unity-catalog/schemas?catalog_name=${encodeURIComponent(catalog)}`);
    return (r.schemas ?? []).filter((s) => s.name !== 'information_schema').sort((a, b) => a.name.localeCompare(b.name));
  }

  async listTables(catalog: string, schema: string): Promise<UcTable[]> {
    const out: UcTable[] = [];
    let pageToken: string | undefined;
    do {
      const r = await this.request<{ tables?: UcTable[]; next_page_token?: string }>('GET', `/api/2.1/unity-catalog/tables?catalog_name=${encodeURIComponent(catalog)}&schema_name=${encodeURIComponent(schema)}&omit_columns=true${pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : ''}`);
      out.push(...(r.tables ?? []));
      pageToken = r.next_page_token || undefined;
    } while (pageToken && out.length < 5000);
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async getTable(fullName: string): Promise<UcTable> {
    return this.request<UcTable>('GET', `/api/2.1/unity-catalog/tables/${encodeURIComponent(fullName)}`);
  }

  async warehouse(id: string): Promise<{ id: string; name?: string; state?: string }> {
    try {
      return await this.request('GET', `/api/2.0/sql/warehouses/${encodeURIComponent(id)}`);
    } catch (err) {
      if (err instanceof HttpError && /not a valid endpoint id|does not exist|RESOURCE_DOES_NOT_EXIST/i.test(err.message)) {
        throw new HttpError(404, `SQL warehouse "${id}" not found. Use the 16-character hex id from the warehouse's Connection details (the last segment of /sql/1.0/warehouses/<id>) — the numeric ?o=… value in Databricks URLs is the workspace id, not a warehouse.`, 'LAKEHOUSE_WAREHOUSE_NOT_FOUND');
      }
      throw err;
    }
  }

  async listWarehouses(): Promise<{ id: string; name: string; state?: string; size?: string; type?: string }[]> {
    const r = await this.request<{ warehouses?: { id: string; name: string; state?: string; cluster_size?: string; warehouse_type?: string; enable_serverless_compute?: boolean }[] }>('GET', '/api/2.0/sql/warehouses');
    return (r.warehouses ?? []).map((w) => ({ id: w.id, name: w.name, state: w.state, size: w.cluster_size, type: w.enable_serverless_compute ? 'serverless' : w.warehouse_type?.toLowerCase() }));
  }

  // ---------------------------------------------------------------- Statement Execution API

  async execute(sql: string, opts: { warehouseId: string; rowLimit: number; timeoutMs?: number; signal?: AbortSignal; catalog?: string; schema?: string }): Promise<StatementResult> {
    const started = performance.now();
    const deadline = Date.now() + (opts.timeoutMs ?? this.opts.timeoutMs ?? 120_000);
    let r = await this.request<StatementResponse>('POST', '/api/2.0/sql/statements', {
      statement: sql,
      warehouse_id: opts.warehouseId,
      wait_timeout: '30s',
      on_wait_timeout: 'CONTINUE',
      disposition: 'INLINE',
      format: 'JSON_ARRAY',
      row_limit: opts.rowLimit,
      ...(opts.catalog ? { catalog: opts.catalog } : {}),
      ...(opts.schema ? { schema: opts.schema } : {}),
    }, 45_000);
    const id = r.statement_id;
    while (r.status.state === 'PENDING' || r.status.state === 'RUNNING') {
      if (opts.signal?.aborted || Date.now() > deadline) {
        await this.cancel(id).catch(() => undefined);
        throw new HttpError(opts.signal?.aborted ? 499 : 504, opts.signal?.aborted ? 'Statement cancelled' : `Databricks statement timed out after ${Math.round((opts.timeoutMs ?? 120_000) / 1000)} s and was cancelled`, opts.signal?.aborted ? 'LAKEHOUSE_CANCELLED' : 'LAKEHOUSE_TIMEOUT');
      }
      await new Promise((res) => setTimeout(res, this.opts.pollIntervalMs ?? 1000));
      r = await this.request<StatementResponse>('GET', `/api/2.0/sql/statements/${encodeURIComponent(id)}`);
    }
    if (r.status.state !== 'SUCCEEDED') {
      const e = r.status.error;
      throw new HttpError(422, `Databricks statement ${r.status.state.toLowerCase()}${e?.message ? `: ${e.message}` : ''}`, 'LAKEHOUSE_STATEMENT_FAILED');
    }
    const cols = r.manifest?.schema.columns ?? [];
    const duckTypes = cols.map((c) => databricksTypeToDuck(c.type_name, c.type_text));
    const columns: ColumnSchema[] = cols.map((c, i) => ({ name: c.name, type: duckTypes[i]!, kind: kindOf(duckTypes[i]!) }));
    const raw: (string | null)[][] = [...(r.result?.data_array ?? [])];
    // Further chunks (INLINE disposition still pages large results).
    let next = r.result?.next_chunk_index;
    const total = r.manifest?.total_chunk_count ?? 1;
    for (let guard = 0; next !== undefined && next !== null && guard < total + 1; guard++) {
      const chunk = await this.request<NonNullable<StatementResponse['result']>>('GET', `/api/2.0/sql/statements/${encodeURIComponent(id)}/result/chunks/${next}`);
      raw.push(...(chunk.data_array ?? []));
      next = chunk.next_chunk_index;
    }
    const rows = raw.map((row) => row.map((v, i) => coerceCell(v, duckTypes[i] ?? 'VARCHAR')));
    return { columns, rows, rowCount: rows.length, totalRows: r.manifest?.total_row_count ?? rows.length, truncated: !!r.manifest?.truncated, statementId: id, durationMs: Math.round(performance.now() - started), duckTypes };
  }

  async cancel(statementId: string): Promise<void> {
    await this.request('POST', `/api/2.0/sql/statements/${encodeURIComponent(statementId)}/cancel`);
  }
}
