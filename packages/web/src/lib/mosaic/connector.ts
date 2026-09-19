import { decodeIPC } from '@uwdata/mosaic-core';
import { getToken, setToken, ApiError } from '../../api/client';

/** The subset of Mosaic's Connector contract we implement (mosaic-core `Connector`). */
export interface MosaicQueryRequest {
  type: 'arrow' | 'json' | 'exec';
  sql: string;
}

/**
 * Mosaic connector backed by the workspace engine: `POST /api/workspaces/:id/mosaic`.
 *   arrow → a decoded flechette Table (mosaic-core 0.31 expects the connector to decode the IPC bytes)
 *   json  → array of row objects
 *   exec  → resolves when the pre-aggregation plumbing has been applied
 * Authentication, roles, the sandbox and the server result cache all apply on the other side.
 */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MAX_RETRIES = 3;

/** A throttled (429) or momentarily unavailable (503) request is retried after the server's Retry-After, capped. */
async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, init);
    if ((res.status !== 429 && res.status !== 503) || attempt >= MAX_RETRIES) return res;
    const after = Number(res.headers.get('retry-after'));
    await sleep(Math.min(Number.isFinite(after) && after > 0 ? after * 1000 : 1000 * (attempt + 1), 8000));
  }
}

export function duckviewConnector(workspaceId: string) {
  const url = `/api/workspaces/${workspaceId}/mosaic`;
  return {
    async query(req: MosaicQueryRequest): Promise<unknown> {
      const headers: Record<string, string> = { 'content-type': 'application/json', accept: req.type === 'arrow' ? 'application/vnd.apache.arrow.stream' : 'application/json' };
      const token = getToken();
      if (token) headers.authorization = `Bearer ${token}`;
      const res = await fetchWithRetry(url, { method: 'POST', headers, body: JSON.stringify({ type: req.type, sql: req.sql }) });
      if (!res.ok) {
        let json: Record<string, unknown> = {};
        try {
          json = (await res.json()) as Record<string, unknown>;
        } catch {
          /* non-JSON error body */
        }
        if (res.status === 401 && getToken()) {
          setToken(null);
          window.dispatchEvent(new Event('duckview:unauthorized'));
        }
        throw new ApiError(res.status, String(json.error ?? 'ERROR'), String(json.message ?? res.statusText));
      }
      if (req.type === 'exec') return undefined;
      if (req.type === 'json') {
        const j = (await res.json()) as { columns: { name: string }[]; rows: unknown[][] };
        return j.rows.map((r) => Object.fromEntries(j.columns.map((c, i) => [c.name, r[i]])));
      }
      return decodeIPC(new Uint8Array(await res.arrayBuffer()), { useDate: true });
    },
  };
}
