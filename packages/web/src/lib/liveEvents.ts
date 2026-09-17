import { getToken } from '../api/client';

export type LiveEvent =
  | { type: 'audit'; event: { id: string; user_id: string | null; actor_type: string; action: string; resource: string | null; query_text: string | null; duration_ms: number | null; ip_address: string | null; status: string; error: string | null; timestamp: string } }
  | { type: 'mcp_tool'; at: string; user_id: string; user: string; tool: string; status: 'ok' | 'error' | 'approval_required'; duration_ms: number; workspace_id: string | null; args: Record<string, unknown>; summary: string; via?: 'mcp' | 'rest'; agent?: { id: string; name: string; framework: string } | null }
  | { type: 'mcp_session'; at: string; user_id: string; user: string; action: 'connect' | 'disconnect'; transport: string; session_id: string }
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
