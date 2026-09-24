/**
 * Cluster mode: several DuckView nodes behind one load balancer, sharing the metadata store and the data directory.
 *
 *  - Membership: every node registers in cluster_nodes and heartbeats; a node that stops is gone after lease_seconds.
 *  - Leases (cluster_leases): a key — workspace:<id> for a workspace's DuckDB file, stream:<id> for a consumer — is
 *    held by one node until it expires; the holder renews its leases with each heartbeat and releases them when it
 *    closes the engine or stops. Acquiring is one atomic upsert that only takes an expired lease (or one this node
 *    already holds), so two nodes never both open a DuckDB file.
 *  - A node that does not hold a workspace forwards engine work to the holder (engine/remote.ts) over internal
 *    HTTP, authenticated with the shared cluster secret; live events are fanned out to every other node.
 */
import crypto from 'node:crypto';
import { and, eq, inArray, lt, or, ne } from 'drizzle-orm';
import type { MetadataStore } from '../db/index.js';
import type { ClusterNode } from '../db/schema/sqlite.js';
import type { DuckViewConfig } from '../config/index.js';
import { newId } from '../security/crypto.js';
import type { LiveEvent } from '../observability/events.js';
import { liveEvents } from '../observability/events.js';
import { logger } from '../observability/logger.js';
import { HttpError } from './errors.js';

export type LeaseHolder = { self: true } | { self: false; node: ClusterNode };

export const CLUSTER_HEADER = 'x-duckview-cluster';

export class ClusterService {
  readonly enabled: boolean;
  readonly nodeId: string;
  advertiseUrl: string;
  private held = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private outbox: LiveEvent[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private unsubscribe: (() => void) | null = null;
  /** Called when this node lost a lease it thought it held (another node took it over). */
  onLost: ((key: string) => void) | null = null;

  constructor(readonly cfg: DuckViewConfig, private readonly store: MetadataStore, private readonly version: string) {
    this.enabled = cfg.cluster.enabled;
    this.nodeId = cfg.cluster.node_id || `node-${newId().slice(0, 8)}`;
    this.advertiseUrl = cfg.cluster.advertise_url.replace(/\/+$/, '');
    if (this.enabled && cfg.cluster.secret.length < 32) throw new Error('cluster.secret must be set (at least 32 characters, the same on every node)');
  }
  private get db() {
    return this.store.db;
  }
  private get s() {
    return this.store.schema;
  }
  private get leaseMs() {
    return this.cfg.cluster.lease_seconds * 1000;
  }

  /** Registers this node and starts heartbeating (before any lease is taken, so other nodes see the holder alive). */
  private async register(): Promise<void> {
    const now = new Date();
    await this.db.insert(this.s.clusterNodes).values({ id: this.nodeId, url: this.advertiseUrl, version: this.version, started_at: now, heartbeat_at: now }).onConflictDoUpdate({ target: this.s.clusterNodes.id, set: { url: this.advertiseUrl, version: this.version, heartbeat_at: now } });
    if (this.timer) return;
    this.timer = setInterval(() => void this.heartbeat().catch((err) => logger().warn({ err: (err as Error).message }, 'Cluster heartbeat failed')), this.cfg.cluster.heartbeat_seconds * 1000);
    this.timer.unref();
  }

  /** Publishes this node's URL and joins the cluster. The advertised URL may be set once the server listens. */
  async start(advertiseUrl?: string): Promise<void> {
    if (!this.enabled || this.unsubscribe) return;
    if (advertiseUrl && !this.cfg.cluster.advertise_url) this.advertiseUrl = advertiseUrl.replace(/\/+$/, '');
    if (!this.advertiseUrl) throw new Error('cluster.advertise_url must be set: the URL the other nodes reach this one at');
    await this.register();
    // Live events published here reach the other nodes.
    this.unsubscribe = liveEvents.subscribe((e) => {
      if ((e as { __peer?: boolean }).__peer) return;
      this.outbox.push(e);
      if (!this.flushTimer) this.flushTimer = setTimeout(() => void this.flushEvents(), 100);
    });
    logger().info({ node: this.nodeId, url: this.advertiseUrl }, 'Cluster node started');
  }

  async stop(): Promise<void> {
    if (!this.enabled) return;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    await this.flushEvents().catch(() => undefined);
    await this.db.delete(this.s.clusterLeases).where(eq(this.s.clusterLeases.node_id, this.nodeId)).catch(() => undefined);
    await this.db.delete(this.s.clusterNodes).where(eq(this.s.clusterNodes.id, this.nodeId)).catch(() => undefined);
    this.held.clear();
  }

  async heartbeat(): Promise<void> {
    const now = new Date();
    await this.db.update(this.s.clusterNodes).set({ heartbeat_at: now }).where(eq(this.s.clusterNodes.id, this.nodeId));
    if (this.held.size) {
      const keys = [...this.held];
      await this.db.update(this.s.clusterLeases).set({ expires_at: new Date(now.getTime() + this.leaseMs) }).where(and(eq(this.s.clusterLeases.node_id, this.nodeId), inArray(this.s.clusterLeases.key, keys)));
      // A lease another node took over (this node was unreachable for a while) is gone for good.
      const still = new Set((await this.db.select({ key: this.s.clusterLeases.key }).from(this.s.clusterLeases).where(and(eq(this.s.clusterLeases.node_id, this.nodeId), inArray(this.s.clusterLeases.key, keys)))).map((r) => r.key));
      for (const k of keys) {
        if (still.has(k)) continue;
        this.held.delete(k);
        this.onLost?.(k);
      }
    }
    // Forget nodes long gone.
    await this.db.delete(this.s.clusterNodes).where(lt(this.s.clusterNodes.heartbeat_at, new Date(now.getTime() - this.leaseMs * 10))).catch(() => undefined);
  }

  holds(key: string): boolean {
    return !this.enabled || this.held.has(key);
  }

  /** Takes the lease when it is free or expired (or already ours); otherwise says which node holds it. */
  async acquire(key: string): Promise<LeaseHolder> {
    if (!this.enabled) return { self: true };
    if (!this.timer) await this.register();
    const now = new Date();
    const expires = new Date(now.getTime() + this.leaseMs);
    await this.db
      .insert(this.s.clusterLeases)
      .values({ key, node_id: this.nodeId, acquired_at: now, expires_at: expires })
      .onConflictDoUpdate({ target: this.s.clusterLeases.key, set: { node_id: this.nodeId, acquired_at: now, expires_at: expires }, setWhere: or(lt(this.s.clusterLeases.expires_at, now), eq(this.s.clusterLeases.node_id, this.nodeId)) });
    const lease = (await this.db.select().from(this.s.clusterLeases).where(eq(this.s.clusterLeases.key, key)).limit(1))[0];
    if (!lease || lease.node_id === this.nodeId) {
      this.held.add(key);
      return { self: true };
    }
    this.held.delete(key);
    const node = (await this.db.select().from(this.s.clusterNodes).where(eq(this.s.clusterNodes.id, lease.node_id)).limit(1))[0];
    // The holder is gone (no heartbeat for a lease period): take over.
    if (!node || node.heartbeat_at.getTime() < now.getTime() - this.leaseMs) {
      const taken = await this.db.update(this.s.clusterLeases).set({ node_id: this.nodeId, acquired_at: now, expires_at: expires }).where(and(eq(this.s.clusterLeases.key, key), eq(this.s.clusterLeases.node_id, lease.node_id))).returning({ key: this.s.clusterLeases.key });
      if (taken.length) {
        this.held.add(key);
        return { self: true };
      }
      return this.acquire(key);
    }
    return { self: false, node };
  }

  /** The other live node holding a lease, if one does. */
  async holder(key: string): Promise<ClusterNode | null> {
    if (!this.enabled) return null;
    const lease = (await this.db.select().from(this.s.clusterLeases).where(eq(this.s.clusterLeases.key, key)).limit(1))[0];
    if (!lease || lease.node_id === this.nodeId || lease.expires_at.getTime() < Date.now()) return null;
    return (await this.peers()).find((n) => n.id === lease.node_id) ?? null;
  }

  /** Gives a lease this node holds to another node (which is taking the work over). */
  async handover(key: string, to: string): Promise<void> {
    if (!this.enabled) return;
    this.held.delete(key);
    await this.db.update(this.s.clusterLeases).set({ node_id: to, acquired_at: new Date(), expires_at: new Date(Date.now() + this.leaseMs) }).where(and(eq(this.s.clusterLeases.key, key), eq(this.s.clusterLeases.node_id, this.nodeId)));
  }

  async release(key: string): Promise<void> {
    if (!this.enabled || !this.held.has(key)) return;
    this.held.delete(key);
    await this.db.delete(this.s.clusterLeases).where(and(eq(this.s.clusterLeases.key, key), eq(this.s.clusterLeases.node_id, this.nodeId))).catch(() => undefined);
  }

  /** The other live nodes. */
  async peers(): Promise<ClusterNode[]> {
    if (!this.enabled) return [];
    const since = new Date(Date.now() - this.leaseMs);
    return (await this.db.select().from(this.s.clusterNodes).where(ne(this.s.clusterNodes.id, this.nodeId))).filter((n) => n.heartbeat_at >= since);
  }

  async status(): Promise<{ enabled: boolean; node_id: string; nodes: (ClusterNode & { self: boolean; alive: boolean; leases: string[] })[] }> {
    if (!this.enabled) return { enabled: false, node_id: this.nodeId, nodes: [] };
    const nodes = await this.db.select().from(this.s.clusterNodes);
    const leases = await this.db.select().from(this.s.clusterLeases);
    const since = Date.now() - this.leaseMs;
    return { enabled: true, node_id: this.nodeId, nodes: nodes.map((n) => ({ ...n, self: n.id === this.nodeId, alive: n.heartbeat_at.getTime() >= since, leases: leases.filter((l) => l.node_id === n.id && l.expires_at.getTime() > Date.now()).map((l) => l.key) })) };
  }

  // ------------------------------------------------------------------------------------------ node-to-node

  /** True when a request carries the cluster secret. */
  authorized(header: string | string[] | undefined): boolean {
    if (!this.enabled || typeof header !== 'string') return false;
    const a = crypto.createHash('sha256').update(header).digest();
    const b = crypto.createHash('sha256').update(this.cfg.cluster.secret).digest();
    return crypto.timingSafeEqual(a, b);
  }

  /** POSTs JSON to another node. */
  async call(url: string, path: string, body: unknown, opts: { signal?: AbortSignal; stream?: boolean } = {}): Promise<Response> {
    return fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', [CLUSTER_HEADER]: this.cfg.cluster.secret }, body: JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)), signal: opts.signal });
  }

  /** Tells every other node something (evict an engine …); failures are logged, not thrown. */
  async broadcast(path: string, body: unknown): Promise<void> {
    for (const n of await this.peers()) await this.call(n.url, path, body).catch((err) => logger().warn({ node: n.id, err: (err as Error).message }, 'Cluster broadcast failed'));
  }

  private async flushEvents(): Promise<void> {
    this.flushTimer = null;
    if (!this.outbox.length) return;
    const events = this.outbox.splice(0, this.outbox.length);
    for (const n of await this.peers()) {
      await this.call(n.url, '/internal/cluster/events', { from: this.nodeId, events }).catch(() => undefined);
    }
  }

  /** Events from another node, published here without sending them on again. */
  receive(events: LiveEvent[]): void {
    for (const e of events) liveEvents.publish({ ...e, __peer: true } as unknown as LiveEvent);
  }
}

/** An error from the node that holds a workspace, rebuilt so status codes and messages survive the hop. */
export function peerError(e: { name?: string; message: string; statusCode?: number; code?: string }): Error {
  if (e.statusCode) return new HttpError(e.statusCode, e.message, e.code ?? 'ERROR');
  const err = new Error(e.message);
  if (e.name) err.name = e.name;
  return err;
}
