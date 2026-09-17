/**
 * In-process live event bus. Audit writes and MCP tool invocations are published here and fanned out to
 * WebSocket subscribers (/api/ws/events) so the MCP hub can show agent activity in real time.
 */
import { EventEmitter } from 'node:events';
import type { AuditLog } from '../db/schema/sqlite.js';

export type LiveEvent =
  | { type: 'audit'; event: AuditLog }
  | { type: 'mcp_tool'; at: string; user_id: string; user: string; tool: string; status: 'ok' | 'error' | 'approval_required'; duration_ms: number; workspace_id: string | null; args: Record<string, unknown>; summary: string; via?: 'mcp' | 'rest'; agent?: { id: string; name: string; framework: string } | null }
  | { type: 'mcp_session'; at: string; user_id: string; user: string; action: 'connect' | 'disconnect'; transport: string; session_id: string }
  | { type: 'query'; at: string; user_id: string; actor: 'USER' | 'AGENT' | 'SYSTEM'; workspace_id: string; status: 'started' | 'done' | 'error'; sql: string; duration_ms?: number };

class LiveBus extends EventEmitter {
  publish(e: LiveEvent) {
    this.emit('event', e);
  }
  subscribe(fn: (e: LiveEvent) => void): () => void {
    this.on('event', fn);
    return () => this.off('event', fn);
  }
}

export const liveEvents = new LiveBus();
liveEvents.setMaxListeners(1000);

/** Shortens SQL/args for the inspector without leaking huge payloads. */
export function summarizeArgs(args: Record<string, unknown>, max = 240): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined) continue;
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    parts.push(`${k}=${s.length > max ? s.slice(0, max) + '…' : s}`);
  }
  return parts.join('  ');
}
