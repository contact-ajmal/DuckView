import { getToken } from '../api/client';

export type LiveEvent =
  | { type: 'audit'; event: { id: string; user_id: string | null; actor_type: string; action: string; resource: string | null; query_text: string | null; duration_ms: number | null; ip_address: string | null; status: string; error: string | null; timestamp: string } }
  | { type: 'mcp_tool'; at: string; user_id: string; user: string; tool: string; title?: string; effect?: 'read' | 'write'; reason?: string; status: 'ok' | 'error' | 'approval_required'; duration_ms: number; workspace_id: string | null; args: Record<string, unknown>; summary: string; via?: 'mcp' | 'rest'; agent?: { id: string; name: string; framework: string } | null }
  | { type: 'mcp_session'; at: string; user_id: string; user: string; action: 'connect' | 'disconnect'; transport: string; session_id: string }
  | { type: 'workspace'; at: string; user_id: string | null; workspace_id: string; data_version: number; reason: string }
  | { type: 'sync'; at: string; workspace_id: string; sync_id: string; run_id: string; status: 'running' | 'ok' | 'error'; rows: number | null; duration_ms: number | null; error: string | null }
  | { type: 'app'; at: string; workspace_id: string; app_id: string; status: 'stopped' | 'installing' | 'starting' | 'running' | 'error'; error: string | null }
  | { type: 'alert'; at: string; workspace_id: string; alert_id: string; state: 'unknown' | 'ok' | 'triggered' | 'error'; changed: boolean }
  | { type: 'comment'; at: string; workspace_id: string; target_type: string; target_id: string; comment_id: string }
  | { type: 'inbox'; at: string; user_id: string; workspace_id: string; kind: 'mention' | 'reply' }
  | { type: 'reverse_sync'; at: string; workspace_id: string; sync_id: string; run_id: string; status: 'running' | 'ok' | 'error'; summary: string | null }
  | { type: 'quality'; at: string; workspace_id: string; suite_id: string; status: 'pass' | 'warn' | 'fail' | 'error'; changed: boolean }
  | { type: 'dbt'; at: string; workspace_id: string; project_id: string; run_id: string; status: 'running' | 'ok' | 'error'; summary: string | null }
  | { type: 'stream'; at: string; workspace_id: string; stream_id: string; rows: number; rows_total: number; duration_ms: number; error: string | null }
  /** A DuckView agent task moved (its milestones; the person's own tasks only). */
  | { type: 'agent'; at: string; workspace_id: string; user_id: string; task_id: string; session_id: string; event: string; data: Record<string, unknown> }
  | { type: 'ready'; scope: string };

/** Subscribes to /api/ws/events; reconnects with backoff. Returns an unsubscribe function. */
export function subscribeLiveEvents(onEvent: (e: LiveEvent) => void, onStatus?: (s: 'connecting' | 'live' | 'offline') => void): () => void {
  let ws: WebSocket | null = null;
  let closed = false;
  let attempt = 0;
  const connect = () => {
    if (closed) return;
    onStatus?.('connecting');
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/api/ws/events`);
    ws.onopen = () => ws?.send(JSON.stringify({ type: 'auth', token: getToken() }));
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data as string) as LiveEvent;
      if (m.type === 'ready') {
        attempt = 0;
        onStatus?.('live');
      }
      onEvent(m);
    };
    ws.onclose = () => {
      onStatus?.('offline');
      if (!closed) setTimeout(connect, Math.min(15_000, 1000 * 2 ** attempt++));
    };
    ws.onerror = () => ws?.close();
  };
  connect();
  return () => {
    closed = true;
    ws?.close();
  };
}
