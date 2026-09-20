/**
 * Connector modules: one file per SaaS application, warehouse or Google product. A connector knows how to prove a
 * connection works (`test`), how to walk what it offers (`browse`: databases → schemas → tables, bases → tables,
 * objects …), how to pull rows for a sync (`read`: an async iterator of row batches, JSON objects that DuckDB
 * turns into a table) and, for warehouses, how to run SQL remotely (`query`). Everything a connector needs at run
 * time comes in a `Session`: the non-secret config, the decrypted credentials (or a fresh OAuth access token) and
 * a fetch bound to that connection.
 */
import type { SourceField } from '../source-catalog.js';
import { HttpError } from '../errors.js';

export interface BrowseEntry {
  name: string;
  /** What kind of thing this is, in the connector's own words (database, schema, table, object, base, sheet …). */
  type: string;
  /** Path to pass back to `browse` to go one level deeper; absent for leaves. */
  path?: string[];
  /** For leaves: the `resource` a sync stores for this entry. */
  resource?: Record<string, unknown>;
  hint?: string;
}

export interface ReadOptions {
  /** Stop after roughly this many rows (previews). */
  limit?: number;
  signal?: AbortSignal;
}

export interface Session {
  /** Non-secret configuration of the connection (config column). */
  config: Record<string, unknown>;
  /** Decrypted credentials; for OAuth connections `access_token` is fresh. */
  credentials: Record<string, string>;
  /** fetch with the connector's default headers/auth applied; retries 429/503 honouring Retry-After. */
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
}

export interface ConnectorAuth {
  /** `fields`: the wizard collects them; `google`: "Connect with Google" (OAuth, scopes below). */
  kind: 'fields' | 'google';
  scopes?: string[];
  fields: SourceField[];
}

export interface Connector {
  id: string;
  label: string;
  auth: ConnectorAuth;
  /** Warehouses answer SQL; the sync editor offers a SQL box for them. */
  remote_sql: boolean;
  /** Headers the session fetch should add (given the credentials). */
  headers(creds: Record<string, string>, config: Record<string, unknown>): Record<string, string>;
  test(s: Session): Promise<{ ok: true; message: string }>;
  browse(s: Session, path: string[]): Promise<BrowseEntry[]>;
  read(s: Session, resource: Record<string, unknown>, opts: ReadOptions): AsyncIterable<Record<string, unknown>[]>;
  query?(s: Session, sql: string, opts: ReadOptions): AsyncIterable<Record<string, unknown>[]>;
  /** One-line description of a resource for lists. */
  describeResource(resource: Record<string, unknown>): string;
}

/** An upstream refusal (status from the vendor, 502 when it did not answer) or a bad resource (400). */
export class ConnectorError extends HttpError {
  constructor(message: string, readonly status = 502) {
    super(status >= 400 && status < 600 ? status : 502, message, 'CONNECTOR_ERROR');
    this.name = 'ConnectorError';
  }
}

/** JSON helper over the session fetch with a clear error when the API says no. */
export async function getJson<T = Record<string, unknown>>(s: Session, url: string, init?: RequestInit): Promise<T> {
  const res = await s.fetch(url, init);
  const text = await res.text();
  if (!res.ok) throw new ConnectorError(`${init?.method ?? 'GET'} ${new URL(url).pathname} → ${res.status}: ${text.slice(0, 300) || res.statusText}`, res.status);
  try {
    return (text ? JSON.parse(text) : {}) as T;
  } catch {
    throw new ConnectorError(`Unexpected non-JSON response from ${new URL(url).host}`);
  }
}

/** Builds a fetch that adds headers and retries throttling with Retry-After (capped), for every connector. */
export function boundFetch(headers: Record<string, string>, base?: string): Session['fetch'] {
  return async (url, init = {}) => {
    const target = base && !/^https?:\/\//i.test(url) ? `${base.replace(/\/+$/, '')}/${url.replace(/^\/+/, '')}` : url;
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(target, { ...init, headers: { ...headers, ...(init.headers as Record<string, string> | undefined) } });
      if ((res.status !== 429 && res.status !== 503) || attempt >= 4) return res;
      const after = Number(res.headers.get('retry-after'));
      await new Promise((r) => setTimeout(r, Math.min(Number.isFinite(after) && after > 0 ? after * 1000 : 500 * 2 ** attempt, 15_000)));
    }
  };
}

/** Flattens nested objects one level with dotted keys so JSON records land as sensible columns. */
export function flatten(row: Record<string, unknown>, depth = 1): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (depth > 0 && v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [k2, v2] of Object.entries(flatten(v as Record<string, unknown>, depth - 1))) out[`${k}.${k2}`] = v2;
    } else out[k] = v;
  }
  return out;
}

/** Turns an API "columns + rows of values" result into row objects. */
export function zipRows(columns: string[], rows: unknown[][]): Record<string, unknown>[] {
  return rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i]])));
}

export const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : v == null ? fallback : String(v));
