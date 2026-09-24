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
  | { type: 'query'; at: string; user_id: string; actor: 'USER' | 'AGENT' | 'SYSTEM'; workspace_id: string; status: 'started' | 'done' | 'error'; sql: string; duration_ms?: number }
  /** The workspace's data epoch moved (mutation, upload, folder change, engine restart): clients drop cached results for it. */
  | { type: 'workspace'; at: string; user_id: string | null; workspace_id: string; data_version: number; reason: string }
  /** A scheduled sync started or finished. */
  | { type: 'sync'; at: string; workspace_id: string; sync_id: string; run_id: string; status: 'running' | 'ok' | 'error'; rows: number | null; duration_ms: number | null; error: string | null }
  | { type: 'app'; at: string; workspace_id: string; app_id: string; status: 'stopped' | 'installing' | 'starting' | 'running' | 'error'; error: string | null }
  /** An alert was checked (its state may have changed). */
  | { type: 'alert'; at: string; workspace_id: string; alert_id: string; state: 'unknown' | 'ok' | 'triggered' | 'error'; changed: boolean }
  /** A comment was added, edited, resolved or deleted on something in a workspace. */
  | { type: 'comment'; at: string; workspace_id: string; target_type: string; target_id: string; comment_id: string }
  /** Something arrived in a person's inbox (a mention or a reply). */
  | { type: 'inbox'; at: string; user_id: string; workspace_id: string; kind: 'mention' | 'reply' }
  /** A reverse sync started or finished. */
  | { type: 'reverse_sync'; at: string; workspace_id: string; sync_id: string; run_id: string; status: 'running' | 'ok' | 'error'; summary: string | null }
  /** A data quality suite ran. */
  | { type: 'quality'; at: string; workspace_id: string; suite_id: string; status: 'pass' | 'warn' | 'fail' | 'error'; changed: boolean }
  | { type: 'insight'; at: string; workspace_id: string; monitor_id: string; count: number }
  | { type: 'stream'; at: string; workspace_id: string; stream_id: string; rows: number; rows_total: number; duration_ms: number; error: string | null }
  | { type: 'hosted_agent'; at: string; workspace_id: string; agent_id: string; run_id: string; status: 'running' | 'completed' | 'failed'; step: number }
  /** A dbt run started or finished. */
  | { type: 'dbt'; at: string; workspace_id: string; project_id: string; run_id: string; status: 'running' | 'ok' | 'error'; summary: string | null }
  /** A user was deactivated or reactivated: their open event streams close. */
  | { type: 'account'; at: string; user_id: string; disabled: boolean };

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
