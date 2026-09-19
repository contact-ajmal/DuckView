export const TOKEN_KEY = 'duckview.session';

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly challenge?: ApprovalChallenge, readonly details?: unknown) {
    super(message);
  }
}

export interface ApprovalChallenge {
  status: 'approval_required';
  reason: string;
  mutating_verbs: string[];
  statements: { index: number; verb: string; class: string; preview: string }[];
  how_to_proceed: string;
}

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}
export function setToken(t: string | null) {
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

async function request<T>(method: string, url: string, body?: unknown, opts: { signal?: AbortSignal } = {}): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: opts.signal });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { message: text };
  }
  if (!res.ok) {
    if (res.status === 401 && getToken()) {
      setToken(null);
      window.dispatchEvent(new Event('duckview:unauthorized'));
    }
    throw new ApiError(res.status, String(json.error ?? 'ERROR'), String(json.message ?? res.statusText), json.challenge as ApprovalChallenge | undefined, json.details);
  }
  return json as T;
}

/** Cache provenance the server attaches to cacheable results. */
export interface CacheMeta { etag: string | null; cached: boolean; computed_at: string }

export type ConditionalResult<T> = { status: 304; etag: string } | { status: 200; data: T & CacheMeta; etag: string | null };

/**
 * POST with `If-None-Match` support for cacheable endpoints (overview, profile, explain, inspect, widget data, query).
 * A 304 means the caller's copy is current; `refresh` recomputes on the server even when it would match.
 */
export async function postConditional<T>(url: string, body: Record<string, unknown>, opts: { etag?: string | null; refresh?: boolean; signal?: AbortSignal } = {}): Promise<ConditionalResult<T>> {
  const headers: Record<string, string> = { accept: 'application/json', 'content-type': 'application/json' };
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  if (opts.etag && !opts.refresh) headers['if-none-match'] = opts.etag.startsWith('"') ? opts.etag : `"${opts.etag}"`;
  if (opts.refresh) headers['x-duckview-refresh'] = '1';
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(opts.refresh ? { ...body, refresh: true } : body), signal: opts.signal });
  const etag = (res.headers.get('etag') ?? '').replace(/^W\//, '').replace(/"/g, '') || null;
  if (res.status === 304) return { status: 304, etag: etag ?? opts.etag ?? '' };
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { message: text };
  }
  if (!res.ok) {
    if (res.status === 401 && getToken()) {
      setToken(null);
      window.dispatchEvent(new Event('duckview:unauthorized'));
    }
    throw new ApiError(res.status, String(json.error ?? 'ERROR'), String(json.message ?? res.statusText), json.challenge as ApprovalChallenge | undefined, json.details);
  }
  return { status: 200, data: json as T & CacheMeta, etag };
}

export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, body?: unknown, opts?: { signal?: AbortSignal }) => request<T>('POST', url, body ?? {}, opts),
  patch: <T>(url: string, body?: unknown) => request<T>('PATCH', url, body ?? {}),
  put: <T>(url: string, body?: unknown) => request<T>('PUT', url, body ?? {}),
  del: <T>(url: string) => request<T>('DELETE', url),
};

// ------------------------------------------------------------------ types
export interface User { id: string; email: string; role: 'ADMIN' | 'USER' | 'READ_ONLY'; auth_provider: string; display_name: string | null; created_at: string }
export interface EngineSettings { memory_limit?: string; threads?: number | 'auto'; query_timeout_seconds?: number; temp_directory?: string; extensions?: string[]; connection_ids?: string[] }
export type WorkspaceRole = 'OWNER' | 'EDITOR' | 'VIEWER';
export interface Workspace {
  id: string; user_id: string; name: string; active_db_path: string; engine_settings: EngineSettings; created_at: string; updated_at: string;
  /** The caller's effective role (primary owner, direct grant or team grant — highest wins; admins are OWNER everywhere). */
  role: WorkspaceRole;
  owner: { id: string; email: string; display_name: string | null };
  /** true when the workspace belongs to someone else and reached the caller through sharing. */
  shared: boolean;
  member_count: number;
  /** Data epoch — moves on every mutation; cached results keyed on an older epoch are stale. */
  data_version: number;
}
export interface WorkspaceMember { id: string; workspace_id: string; subject_type: 'user' | 'group'; subject_id: string; role: WorkspaceRole; added_by: string | null; created_at: string; name: string; email: string | null; external: boolean }
export interface Group { id: string; name: string; description: string | null; external_id: string | null; created_by: string | null; created_at: string; updated_at: string; member_count: number; my_role: 'MANAGER' | 'MEMBER' | null }
export interface GroupMember { group_id: string; user_id: string; role: 'MANAGER' | 'MEMBER'; added_at: string; email: string; display_name: string | null }
export interface DirectoryUser { id: string; email: string; display_name: string | null; role: User['role'] }
export interface ChartConfig { type: 'bar' | 'line' | 'area' | 'scatter' | 'pie' | 'none'; x?: string; y?: string[]; stacked?: boolean }
export interface SessionTab { id: string; workspace_id: string; title: string; sql_content: string; chart_config: ChartConfig; order_index: number; cursor_position: number; engine?: string | null; updated_at: string }
export interface ColumnSchema { name: string; type: string; kind: 'number' | 'string' | 'boolean' | 'temporal' | 'json' | 'binary' | 'null' }
export interface QueryResult { columns: ColumnSchema[]; rows: unknown[][]; rowCount: number; totalRows: number | null; truncated: boolean; rowsChanged: number | null; durationMs: number; statementCount: number; statementClass: string; statements?: { verb: string; class: string }[] }
export interface CatalogObject { database: string; schema: string; name: string; type: 'TABLE' | 'VIEW'; estimated_rows: number | null; column_count: number; sql: string | null; columns: { name: string; type: string; nullable: boolean }[] }
export interface JailEntry { path: string; kind: string; size_bytes: number; modified_at: string; root?: string }
export interface ApiToken { id: string; name: string; token_prefix: string; scopes: string[]; workspace_id: string | null; expires_at: string | null; last_used_at: string | null; created_at: string }
export interface McpSession { id: string; transport: string; user: string; workspace_id: string | null; started_at: string; last_activity: string; ip: string }
export interface AuditEvent { id: string; user_id: string | null; actor_type: string; action: string; resource: string | null; query_text: string | null; duration_ms: number | null; ip_address: string | null; status: string; error: string | null; timestamp: string }
export interface SystemInfo {
  host: { cpus: number; total_memory_bytes: number; free_memory_bytes: number; platform: string; load_average: number[] };
  duckdb: { version: string; memory_limit: string; memory_limit_bytes: number; threads: number; temp_directory: string; external_access: boolean; configuration_locked: boolean };
  temp_disk: { path: string; free_bytes: number | null; total_bytes: number | null };
  data_jail: { path: string; free_bytes: number | null; total_bytes: number | null };
  engines_active: number;
  server: { version: string; node: string; started_at: string; uptime_s: number; metadata_dialect: string; auth_strategy: string; max_result_rows: number; query_timeout_seconds: number };
}
export interface PublicConnection { id: string; name: string; type: string; created_at: string; fields: string[] }
export interface OverviewColumn {
  name: string; type: string; kind: ColumnSchema['kind']; null_percentage: number; approx_unique: number | null; min: string | null; max: string | null; avg: number | null; q50: string | null;
  distribution: { kind: 'histogram'; bins: { lo: number; hi: number; label: string; count: number }[] } | { kind: 'categories'; bins: { label: string; count: number }[]; other: number } | { kind: 'timeline'; unit: string; bins: { label: string; count: number }[] } | null;
}
export interface OverviewResult { target: string; kind: string; row_count: number; column_count: number; size_bytes: number | null; null_cell_ratio: number; duplicate_rows: number | null; columns: OverviewColumn[]; sample: { columns: ColumnSchema[]; rows: unknown[][] }; duration_ms: number }
export interface LiveStats {
  at: string;
  host: { cpus: number; cpu_percent: number; load_average: number[]; memory_total_bytes: number; memory_used_bytes: number; memory_free_bytes: number };
  process: { cpu_percent: number; rss_bytes: number; heap_used_bytes: number; uptime_s: number };
  duckdb: { memory_limit_bytes: number; memory_usage_bytes: number; temp_bytes: number; threads: number; engines: { workspaceId: string; dbPath: string; memory_limit_bytes: number; memory_usage_bytes: number; temporary_storage_bytes: number; active_queries: number; threads: number }[] };
  scratch: { path: string; used_bytes: number; free_bytes: number | null; total_bytes: number | null };
  data: { path: string; used_bytes: number; free_bytes: number | null; total_bytes: number | null };
  cache?: { enabled: boolean; entries: number; bytes: number; max_bytes: number; hits: number; misses: number };
}

/** Upload with progress (XHR — fetch has no upload progress events). */
export function uploadFiles(workspaceId: string, files: File[], opts: { dir?: string; overwrite?: boolean; onProgress?: (pct: number) => void } = {}): Promise<{ files: JailEntry[] }> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    for (const f of files) form.append('file', f, f.name);
    const q = new URLSearchParams();
    if (opts.dir) q.set('dir', opts.dir);
    if (opts.overwrite) q.set('overwrite', 'true');
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/workspaces/${workspaceId}/files?${q.toString()}`);
    const token = getToken();
    if (token) xhr.setRequestHeader('authorization', `Bearer ${token}`);
    xhr.upload.onprogress = (e) => e.lengthComputable && opts.onProgress?.(Math.round((e.loaded / e.total) * 100));
    xhr.onload = () => {
      let json: Record<string, unknown> = {};
      try {
        json = JSON.parse(xhr.responseText);
      } catch {
        /* ignore */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(json as { files: JailEntry[] });
      else reject(new ApiError(xhr.status, String(json.error ?? 'ERROR'), String(json.message ?? xhr.statusText)));
    };
    xhr.onerror = () => reject(new ApiError(0, 'NETWORK', 'Upload failed'));
    xhr.send(form);
  });
}

// ------------------------------------------------------------------ WebSocket query stream
type StreamHandlers = {
  onSchema: (columns: ColumnSchema[]) => void;
  onRows: (rows: unknown[][]) => void;
  onDone: (info: { row_count: number; duration_ms: number; truncated: boolean; statements: { verb: string; class: string }[]; data_version?: number }) => void;
  onError: (err: ApiError) => void;
};

class QueryStreamClient {
  private ws: WebSocket | null = null;
  private ready: Promise<void> | null = null;
  private handlers = new Map<string, StreamHandlers>();
  private seq = 0;

  private connect(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.ready) return this.ready;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/api/ws/query`);
    this.ws = ws;
    this.ready = new Promise<void>((resolve, reject) => {
      ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token: getToken() }));
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data as string) as { type: string; id?: string; [k: string]: unknown };
        if (m.type === 'ready') return resolve();
        const h = m.id ? this.handlers.get(m.id) : undefined;
        if (m.type === 'error' && !m.id) return reject(new ApiError(401, String(m.code), String(m.message)));
        if (!h) return;
        if (m.type === 'schema') h.onSchema(m.columns as ColumnSchema[]);
        else if (m.type === 'rows') h.onRows(m.rows as unknown[][]);
        else if (m.type === 'done') {
          h.onDone(m as unknown as Parameters<StreamHandlers['onDone']>[0]);
          this.handlers.delete(m.id!);
        } else if (m.type === 'error') {
          h.onError(new ApiError(Number(m.status ?? 500), String(m.code), String(m.message), m.challenge as ApprovalChallenge | undefined));
          this.handlers.delete(m.id!);
        }
      };
      ws.onclose = () => {
        this.ws = null;
        this.ready = null;
        for (const h of this.handlers.values()) h.onError(new ApiError(0, 'DISCONNECTED', 'Connection closed'));
        this.handlers.clear();
      };
      ws.onerror = () => reject(new ApiError(0, 'WS_ERROR', 'WebSocket connection failed'));
    });
    return this.ready;
  }

  async run(params: { workspaceId: string; sql: string; maxRows?: number; dryRun?: boolean }, handlers: StreamHandlers): Promise<{ id: string; cancel: () => void }> {
    await this.connect();
    const id = `q${++this.seq}-${Date.now()}`;
    this.handlers.set(id, handlers);
    this.ws!.send(JSON.stringify({ type: 'run', id, workspace_id: params.workspaceId, sql: params.sql, max_rows: params.maxRows, dry_run: params.dryRun }));
    return { id, cancel: () => this.ws?.send(JSON.stringify({ type: 'cancel', id })) };
  }

  close() {
    this.ws?.close();
  }
}

export const queryStream = new QueryStreamClient();

export function formatBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatNumber(n: number): string {
  return new Intl.NumberFormat().format(n);
}

export function timeAgo(iso: string | null): string {
  if (!iso) return 'never';
  const d = Date.now() - new Date(iso).getTime();
  const s = Math.round(d / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

// ------------------------------------------------------------------ Phase 2–4 types
export interface TreeEntry { name: string; path: string; type: 'dir' | 'file' | 'table_dir'; kind: string; size_bytes: number | null; modified_at: string; queryable: boolean }
export interface LocalListing { mode: 'sandboxed' | 'full'; root: string; path: string; absolute: string; entries: TreeEntry[] }
export interface CloudEntry { name: string; path: string; uri: string; type: 'dir' | 'file'; kind: string; size_bytes: number | null; modified_at: string | null; queryable: boolean }
export interface CloudConnection { id: string; name: string; provider: 'S3' | 'R2' | 'GCS' | 'AZURE'; endpoint_url: string | null; region: string | null; bucket: string | null; fields: string[]; uri_scheme: string; created_at: string }
export interface InspectResult { target: string; kind: 'table' | 'file' | 'remote' | 'query' | 'database'; columns: { name: string; type: string; nullable: boolean }[]; row_count: number | null; row_count_source: string | null; size_bytes: number | null; tables?: { name: string; schema: string; columns: { name: string; type: string; nullable: boolean }[] }[]; suggested_sql: string }
export interface SavedQuery { id: string; workspace_id: string; user_id: string; name: string; folder: string; description: string | null; sql_text: string; tags: string[]; created_at: string; updated_at: string }
export interface LayoutItem { i: string; x: number; y: number; w: number; h: number; minW?: number; minH?: number }
export interface WidgetChartConfig { chart?: 'bar' | 'line' | 'area' | 'scatter' | 'pie'; x?: string; y?: string[]; group_by?: string; aggregate?: 'sum' | 'avg' | 'min' | 'max' | 'count' | 'none'; stacked?: boolean; value?: string; compare?: string; format?: 'number' | 'currency' | 'percent' | 'compact'; page_size?: number; markdown?: string; colors?: string[] }
export interface DashboardWidget { id: string; dashboard_id: string; title: string; widget_type: 'KPI' | 'CHART' | 'TABLE' | 'MARKDOWN'; saved_query_id: string | null; custom_sql: string | null; chart_config: WidgetChartConfig; refresh_interval_sec: number; order_index: number; created_at: string; updated_at: string }
export type DashboardKind = 'grid' | 'mosaic';
export interface Dashboard { id: string; workspace_id: string; user_id: string; name: string; description: string | null; layout: LayoutItem[]; kind: DashboardKind; spec: Record<string, unknown> | null; created_at: string; updated_at: string; widgets?: DashboardWidget[] }
export interface ExportRecord { id: string; name: string; format: 'parquet' | 'csv' | 'json' | 'arrow'; content_type: string; rows: number; size_bytes: number; engine: string; duration_ms: number; created_at: string; expires_at: string; download_url: string }
export type CopilotProvider = 'anthropic' | 'openai' | 'ollama' | 'bedrock' | 'bedrock_agent' | 'agentcore';
export interface CopilotConfig { enabled: boolean; allow_byok: boolean; server_provider: CopilotProvider | null; server_model: string | null; has_server_key: boolean; server_base_url: string | null; server_aws: { region: string | null; agent_id: string | null; agent_alias_id: string | null; runtime_arn: string | null } | null; aws_providers: CopilotProvider[]; default_models: Record<string, string>; suggested_models: Record<string, string[]>; can_use: boolean }

// ---- lakehouse
export type LakehouseProvider = 'AWS_GLUE' | 'AWS_S3_TABLES' | 'ICEBERG_REST' | 'DATABRICKS';
export interface LakehouseConfig { region?: string; account_id?: string; catalog?: string; table_bucket_arn?: string; aws_auth?: 'keys' | 'credential_chain'; endpoint?: string; warehouse?: string; auth?: 'bearer' | 'oauth2' | 'none'; oauth2_server_uri?: string; oauth2_scope?: string; nested_namespaces?: boolean; host?: string; warehouse_id?: string; unity_catalog?: string; databricks_auth?: 'pat' | 'oauth_m2m'; attach_iceberg?: boolean }
export interface LakehouseConnection { id: string; name: string; provider: LakehouseProvider; alias: string; config: LakehouseConfig; status: 'unknown' | 'ok' | 'error'; last_error: string | null; last_tested_at: string | null; credential_fields: string[]; attached: boolean; remote_sql: boolean; example_sql: string; created_at: string; updated_at: string }
export interface LakehouseProviderMeta { title: string; blurb: string; docs: string; attachable: boolean; remote_sql: boolean }
export interface LakehouseEntry { name: string; type: 'catalog' | 'schema' | 'table' | 'view'; qualified?: string; engine?: 'duckdb' | 'remote'; format?: string | null; comment?: string | null }
export interface LakehouseBrowse { connection: { id: string; name: string; provider: LakehouseProvider; alias: string }; level: 'catalogs' | 'schemas' | 'tables'; catalog: string | null; schema: string | null; entries: LakehouseEntry[]; attach_error: string | null }
export interface RemoteInspect { target: string; kind: 'remote'; engine: 'remote'; format: string | null; table_type: string | null; iceberg_readable: boolean; columns: { name: string; type: string; nullable: boolean }[]; row_count: null; suggested_sql: string }

// ---- agents
export type AgentFramework = 'strands' | 'langgraph' | 'langchain' | 'crewai' | 'agentcore_runtime' | 'agentcore_gateway' | 'bedrock_agent' | 'custom';
export interface AgentConfig { region?: string; agent_id?: string; agent_alias_id?: string; runtime_arn?: string; qualifier?: string; gateway_url?: string; notes?: string }
export interface AgentRecord { id: string; name: string; framework: AgentFramework; framework_title: string; description: string | null; workspace_id: string | null; token_id: string | null; token_prefix: string | null; token_scopes: string[]; token_revoked: boolean; allow_mutations: boolean; config: AgentConfig; call_count: number; error_count: number; last_seen_at: string | null; can_invoke: boolean; created_at: string; updated_at: string }
export interface FrameworkMeta { title: string; blurb: string; transport: 'mcp' | 'rest' | 'both'; docs: string }
export interface Snippet { id: string; label: string; file: string; language: 'python' | 'bash' | 'json'; code: string; notes?: string }
export type AgentInvokeEvent = { type: 'delta'; text: string } | { type: 'done'; session_id: string; duration_ms: number } | { type: 'error'; code: string; message: string };

/** Streams an agent reply (Bedrock Agent / AgentCore runtime) as SSE events. */
export async function* agentInvoke(agentId: string, body: Record<string, unknown>, signal?: AbortSignal): AsyncGenerator<AgentInvokeEvent> {
  const res = await fetch(`/api/agents/${agentId}/invoke`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${getToken()}` }, body: JSON.stringify(body), signal });
  if (!res.ok || !res.body) {
    let msg = res.statusText;
    try {
      msg = ((await res.json()) as { message?: string }).message ?? msg;
    } catch {
      /* ignore */
    }
    yield { type: 'error', code: `HTTP_${res.status}`, message: msg };
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const ev = /^event: (.*)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (ev && data) {
        try {
          yield { type: ev, ...(JSON.parse(data) as Record<string, unknown>) } as AgentInvokeEvent;
        } catch {
          /* ignore malformed frame */
        }
      }
    }
  }
}
export interface ChatMsg { id: string; role: 'user' | 'assistant' | 'system'; content: string; timestamp: string; context: { tables: number; files: number; model?: string; provider?: string; targets: string[] } | null }

/** A Mosaic spec the assistant wrote, validated against the workspace by the server. */
export interface CopilotSpecBlock { text: string; title: string | null; ok: boolean | null; errors: string[]; warnings: string[] }
export type CopilotEvent =
  | { type: 'context'; conversation_id: string; message_id: string; provider: string; model: string; tables: number; files: number; buckets: number; targets: string[] }
  | { type: 'delta'; text: string }
  | { type: 'done'; message_id: string; usage: { input_tokens: number | null; output_tokens: number | null }; sql_blocks: string[]; spec_blocks: CopilotSpecBlock[]; duration_ms: number }
  | { type: 'error'; code: string; message: string };

/** POSTs a copilot turn and yields SSE events as they arrive. */
export async function* copilotChat(body: Record<string, unknown>, signal?: AbortSignal): AsyncGenerator<CopilotEvent> {
  const res = await fetch('/api/copilot/chat', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${getToken()}` }, body: JSON.stringify(body), signal });
  if (!res.ok || !res.body) {
    let msg = res.statusText;
    try {
      msg = ((await res.json()) as { message?: string }).message ?? msg;
    } catch {
      /* ignore */
    }
    yield { type: 'error', code: `HTTP_${res.status}`, message: msg };
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (data) {
        try {
          yield JSON.parse(data) as CopilotEvent;
        } catch {
          /* ignore malformed frame */
        }
      }
    }
  }
}

/** Server-side export → browser download (no result buffering in the page). */
export async function exportAndDownload(workspaceId: string, sql: string, format: ExportRecord['format'], filename?: string): Promise<ExportRecord> {
  const r = await api.post<{ export: ExportRecord }>(`/api/workspaces/${workspaceId}/export`, { sql, format, filename });
  const res = await fetch(r.export.download_url, { headers: { authorization: `Bearer ${getToken()}` } });
  if (!res.ok) throw new ApiError(res.status, 'EXPORT_DOWNLOAD', await res.text());
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = r.export.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  return r.export;
}

export const TAB_MARKER = '-- @duckview-tab:';

/** Serialises tabs into one .sql file demarcated by `-- @duckview-tab: <name>`. */
export function tabsToSql(tabs: { title: string; sql: string }[]): string {
  return tabs.map((t) => `${TAB_MARKER} ${t.title}\n${t.sql.trim()}\n`).join('\n');
}

/** Parses a .sql file: marker-demarcated sections become tabs; otherwise one tab named after the file. */
export function sqlToTabs(text: string, fallbackName: string): { title: string; sql: string }[] {
  if (!text.includes(TAB_MARKER)) return [{ title: fallbackName, sql: text.trim() }];
  const out: { title: string; sql: string }[] = [];
  let current: { title: string; lines: string[] } | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith(TAB_MARKER)) {
      if (current) out.push({ title: current.title, sql: current.lines.join('\n').trim() });
      current = { title: line.slice(TAB_MARKER.length).trim() || fallbackName, lines: [] };
    } else if (current) current.lines.push(line);
  }
  if (current) out.push({ title: current.title, sql: current.lines.join('\n').trim() });
  return out.filter((t) => t.sql);
}
