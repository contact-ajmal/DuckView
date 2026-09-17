import { desc, eq, and, type SQL } from 'drizzle-orm';
import type { MetadataStore } from '../db/index.js';
import type { ActorType } from '../db/schema/sqlite.js';
import { newId } from '../security/crypto.js';
import { metrics } from '../observability/metrics.js';
import { logger } from '../observability/logger.js';
import { liveEvents } from '../observability/events.js';

export interface AuditEvent {
  userId?: string | null;
  actorType: ActorType;
  action: string;
  resource?: string | null;
  queryText?: string | null;
  durationMs?: number | null;
  ip?: string | null;
  status?: 'ok' | 'error' | 'blocked' | 'timeout';
  error?: string | null;
}

export class AuditService {
  constructor(private readonly store: MetadataStore) {}

  /** Fire-and-forget; never throws into the request path. */
  log(ev: AuditEvent): void {
    metrics.auditEvents.inc({ action: ev.action, actor: ev.actorType });
    const { db, schema } = this.store;
    const row = {
      id: newId(),
      user_id: ev.userId ?? null,
      actor_type: ev.actorType,
      action: ev.action,
      resource: ev.resource ?? null,
      query_text: ev.queryText ? ev.queryText.slice(0, 20_000) : null,
      duration_ms: ev.durationMs == null ? null : Math.round(ev.durationMs),
      ip_address: ev.ip ?? null,
      status: ev.status ?? 'ok',
      error: ev.error ? ev.error.slice(0, 4000) : null,
      timestamp: new Date(),
    };
    Promise.resolve(db.insert(schema.auditLogs).values(row))
      .then(() => liveEvents.publish({ type: 'audit', event: row }))
      .catch((err) => logger().error({ err }, 'Failed to write audit log'));
  }

  async list(filter: { userId?: string; actorType?: ActorType; action?: string; limit?: number; offset?: number }) {
    const { db, schema } = this.store;
    const conds: SQL[] = [];
    if (filter.userId) conds.push(eq(schema.auditLogs.user_id, filter.userId));
    if (filter.actorType) conds.push(eq(schema.auditLogs.actor_type, filter.actorType));
    if (filter.action) conds.push(eq(schema.auditLogs.action, filter.action));
    const q = db
      .select()
      .from(schema.auditLogs)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(schema.auditLogs.timestamp))
      .limit(Math.min(filter.limit ?? 100, 1000))
      .offset(filter.offset ?? 0);
    return q;
  }
}
