/**
 * Cluster mode: two nodes sharing one metadata store and one data directory. The node holding a workspace opens its
 * DuckDB file; the other forwards queries and streams to it (access policies and sandbox errors survive the hop),
 * scheduled work runs once, live events reach both, node-to-node routes need the secret, and when a node stops (or
 * goes silent) the other takes its workspaces over.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { Kafka, logLevel } from 'kafkajs';
import { loadConfig } from '../config/index.js';
import { initLogger } from '../observability/logger.js';
import { liveEvents, type LiveEvent } from '../observability/events.js';
import { createContext, type AppContext } from '../context.js';
import { buildApp } from '../app.js';
import type { Principal } from '../services/principal.js';

const KAFKA = process.env.DUCKVIEW_TEST_KAFKA_BROKERS;
const SECRET = 'cluster-secret-0123456789abcdef-0123456789';

interface Node {
  ctx: AppContext;
  app: Awaited<ReturnType<typeof buildApp>>['app'];
  base: string;
  admin: Principal;
}

let dir: string;
let a: Node;
let b: Node;
let wsId: string;
let viewerJwtB: string;
let adminJwtB: string;

const until = async (check: () => Promise<boolean>, ms = 20_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('timed out');
};

async function node(id: string): Promise<Node> {
  const cfg = loadConfig({
    configPath: null,
    env: {
      DUCKVIEW_DATA_DIR: path.join(dir, 'data'),
      DUCKVIEW_FILESYSTEM_MODE: 'sandboxed',
      DUCKDB_TEMP_DIRECTORY: path.join(dir, `spill-${id}`),
      DATABASE_URL: `sqlite://${path.join(dir, 'meta.db')}`,
      JWT_SECRET: 'jwt-secret-shared-by-both-nodes',
      ENCRYPTION_KEY: 'ab'.repeat(32),
      DUCKDB_MEMORY_LIMIT: '512MB',
      DUCKVIEW_ADMIN_EMAIL: 'admin@test.local',
      DUCKVIEW_ADMIN_PASSWORD: 'super-secret-pw',
      DUCKVIEW__duckdb__sync_scheduler_enabled: 'false',
      DUCKVIEW__notifications__scheduler_enabled: 'false',
      DUCKVIEW__transform__scheduler_enabled: 'false',
      DUCKVIEW__apps__enabled: 'false',
      DUCKVIEW__cluster__enabled: 'true',
      DUCKVIEW__cluster__node_id: id,
      DUCKVIEW__cluster__secret: SECRET,
      DUCKVIEW__cluster__heartbeat_seconds: '1',
      DUCKVIEW__cluster__lease_seconds: '3',
      LOG_LEVEL: 'silent',
    },
  });
  const ctx = await createContext(cfg);
  const { app } = await buildApp(ctx);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${(app.server.address() as net.AddressInfo).port}`;
  await ctx.startCluster(base);
  const admin = ctx.auth.principalFromUser((await ctx.auth.findByEmail('admin@test.local'))!, 'jwt', '127.0.0.1');
  return { ctx, app, base, admin };
}

const api = async (n: Node, method: string, url: string, token: string, body?: unknown, headers: Record<string, string> = {}) => {
  const r = await fetch(`${n.base}${url}`, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: (await r.json().catch(() => ({}))) as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
};
const login = async (n: Node, email: string, password: string) => (await api(n, 'POST', '/api/auth/login', '', { email, password })).json.token as string;

beforeAll(async () => {
  initLogger({ level: 'silent', stderr: true, pretty: false });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dv-cluster-'));
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  a = await node('node-a');
  b = await node('node-b');
  wsId = (await a.ctx.workspaces.create(a.admin, { name: 'Shared', active_db_path: 'shared.duckdb' })).id;
  await a.ctx.queries.run(a.admin, wsId, "CREATE TABLE orders AS SELECT * FROM (VALUES (1, 'EU', 10.0), (2, 'US', 20.0), (3, 'EU', 30.0)) t(id, region, amount)", { cache: false });
  const viewer = await a.ctx.auth.createLocalUser({ email: 'viewer@test.local', password: 'viewer-secret-pw', role: 'USER' });
  await a.ctx.workspaces.setMember(a.admin, wsId, { subject_type: 'user', subject_id: viewer.id, role: 'VIEWER' });
  adminJwtB = await login(b, 'admin@test.local', 'super-secret-pw');
  viewerJwtB = await login(b, 'viewer@test.local', 'viewer-secret-pw');
}, 120_000);

afterAll(async () => {
  for (const n of [b, a]) {
    await n?.app.close().catch(() => undefined);
    await n?.ctx.shutdown().catch(() => undefined);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('cluster mode', () => {
  it('forwards queries and streams to the node holding the workspace', async () => {
    expect(a.ctx.engines.peek(wsId)).toBeTruthy();
    const r = await b.ctx.queries.run(b.admin, wsId, 'SELECT region, sum(amount) FROM orders GROUP BY region ORDER BY region', { cache: false });
    expect(r.rows).toEqual([['EU', 40], ['US', 20]]);
    // Node B never opened the file.
    expect(b.ctx.engines.peek(wsId)).toBeFalsy();
    // Writes land in the one file too.
    await b.ctx.queries.run(b.admin, wsId, "INSERT INTO orders VALUES (4, 'US', 5.0)", { cache: false });
    expect((await a.ctx.queries.run(a.admin, wsId, 'SELECT count(*) FROM orders', { cache: false })).rows).toEqual([[4]]);
    const { engine } = await b.ctx.workspaces.engine(b.admin, wsId);
    const got: unknown[][] = [];
    let columns: string[] = [];
    const done = await engine.stream('SELECT id FROM orders ORDER BY id', { onSchema: (c) => (columns = c.map((x) => x.name)), onRows: (rows) => void got.push(...rows) });
    expect(columns).toEqual(['id']);
    expect(got).toEqual([[1], [2], [3], [4]]);
    expect(done).toBeTruthy();
    // The engine's errors keep their meaning across the hop.
    await expect(b.ctx.queries.run(b.admin, wsId, 'SELECT * FROM missing_table', { cache: false })).rejects.toThrow(/missing_table/);
    await expect(b.ctx.queries.run(b.admin, wsId, "SELECT * FROM read_csv('/etc/passwd')", { cache: false })).rejects.toThrow(/escapes the data directory/);
  });

  it('applies access policies on the forwarding node', async () => {
    const created = await api(b, 'POST', `/api/workspaces/${wsId}/policies`, adminJwtB, { table_name: 'orders', row_filter: "region = 'EU'", applies_to: { roles: ['VIEWER'] } });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    const q = async (token: string) => (await api(b, 'POST', `/api/workspaces/${wsId}/query`, token, { sql: 'SELECT count(*) AS n FROM orders' })).json;
    expect((await q(viewerJwtB)).rows).toEqual([[2]]);
    expect((await q(adminJwtB)).rows).toEqual([[4]]);
  });

  it('runs a due job on one node only', async () => {
    const sync = await a.ctx.syncs.create(a.admin, wsId, { name: 'EU orders', source: { kind: 'sql', sql: "SELECT * FROM orders WHERE region = 'EU'" }, target_table: 'eu_orders' });
    const s = a.ctx.store.schema;
    await a.ctx.store.db.update(s.dataSyncs).set({ schedule: { kind: 'interval', minutes: 60 } as never, next_run_at: new Date(Date.now() - 1000) }).where(eq(s.dataSyncs.id, sync.id));
    const [ranA, ranB] = await Promise.all([a.ctx.syncs.tick(), b.ctx.syncs.tick()]);
    expect([...ranA, ...ranB]).toEqual([sync.id]);
  });

  it('fans live events out to the other nodes', async () => {
    const seen: LiveEvent[] = [];
    const off = liveEvents.subscribe((e) => {
      if ((e as { __peer?: boolean }).__peer) seen.push(e);
    });
    liveEvents.publish({ type: 'mcp_session', at: new Date().toISOString(), user_id: 'u', user: 'fan-out', action: 'connect', transport: 'http', session_id: 'fan-out-1' });
    await until(async () => seen.some((e) => e.type === 'mcp_session' && e.session_id === 'fan-out-1'), 5000);
    off();
  });

  it('keeps node-to-node routes to nodes that know the secret; admins see the nodes', async () => {
    const call = (secret?: string) => api(a, 'POST', '/internal/cluster/engine', '', { workspace_id: wsId, method: 'execute', args: ['SELECT 1'] }, secret ? { 'x-duckview-cluster': secret } : {});
    expect((await call()).status).toBe(404);
    expect((await call('not-the-secret-not-the-secret-not-the-secret')).status).toBe(404);
    const ok = await call(SECRET);
    expect(ok.json.result.rows).toEqual([[1]]);
    expect((await api(a, 'POST', '/internal/cluster/engine', '', { workspace_id: wsId, method: 'close', args: [] }, { 'x-duckview-cluster': SECRET })).json.error.message).toMatch(/cannot be called remotely/);
    const status = await api(b, 'GET', '/api/admin/cluster', adminJwtB);
    expect(status.json).toMatchObject({ enabled: true, node_id: 'node-b' });
    const nodes = status.json.nodes as { id: string; self: boolean; alive: boolean; leases: string[] }[];
    expect(nodes.map((n) => n.id).sort()).toEqual(['node-a', 'node-b']);
    expect(nodes.find((n) => n.id === 'node-a')!.leases).toContain(`workspace:${wsId}`);
    expect(nodes.every((n) => n.alive)).toBe(true);
    expect((await api(b, 'GET', '/api/admin/cluster', viewerJwtB)).status).toBe(403);
  });

  it.skipIf(!KAFKA)('runs each stream consumer on one node, and moves it when changed elsewhere', async () => {
    const topic = `dv-cluster-${Date.now()}`;
    const kafka = new Kafka({ clientId: 'dv-test', brokers: KAFKA!.split(','), logLevel: logLevel.NOTHING });
    const admin_ = kafka.admin();
    await admin_.connect();
    await admin_.createTopics({ topics: [{ topic, numPartitions: 1 }], waitForLeaders: true });
    await admin_.disconnect();
    const producer = kafka.producer();
    await producer.connect();
    await producer.send({ topic, messages: [{ value: JSON.stringify({ n: 1 }) }] });
    const { stream } = await a.ctx.streams.create(a.admin, wsId, { name: 'Events', config: { kind: 'kafka', brokers: KAFKA!.split(','), topic, from_beginning: true }, target_table: 'events', batch_seconds: 1 });
    expect(a.ctx.streams.isRunning(stream.id)).toBe(true);
    // Node B's periodic takeover leaves it alone: node A holds its lease.
    await b.ctx.streams.startAll();
    expect(b.ctx.streams.isRunning(stream.id)).toBe(false);
    const count = async () => Number((await b.ctx.queries.run(b.admin, wsId, 'SELECT count(*) FROM events', { cache: false })).rows[0]![0]);
    await until(async () => (await count()) === 1, 30_000);
    // Changed on node B: node A stops it, node B runs it.
    await b.ctx.streams.update(b.admin, stream.id, { batch_seconds: 2 });
    expect(a.ctx.streams.isRunning(stream.id)).toBe(false);
    expect(b.ctx.streams.isRunning(stream.id)).toBe(true);
    await producer.send({ topic, messages: [{ value: JSON.stringify({ n: 2 }) }] });
    await producer.disconnect();
    await until(async () => (await count()) === 2, 30_000);
    await b.ctx.streams.remove(b.admin, stream.id);
    expect(b.ctx.streams.isRunning(stream.id)).toBe(false);
  }, 90_000);

  it('takes over a silent node\'s workspace once its lease expires', async () => {
    const other = (await b.ctx.workspaces.create(b.admin, { name: 'Orphaned', active_db_path: 'orphaned.duckdb' })).id;
    const s = b.ctx.store.schema;
    const past = new Date(Date.now() - 60_000);
    await b.ctx.store.db.insert(s.clusterNodes).values({ id: 'node-gone', url: 'http://127.0.0.1:9', version: 'x', started_at: past, heartbeat_at: past });
    await b.ctx.store.db.insert(s.clusterLeases).values({ key: `workspace:${other}`, node_id: 'node-gone', acquired_at: past, expires_at: new Date(Date.now() + 60_000) });
    // The lease has not expired, but its node stopped heartbeating: node B takes the workspace.
    expect((await b.ctx.queries.run(b.admin, other, 'SELECT 42', { cache: false })).rows).toEqual([[42]]);
    expect(b.ctx.engines.peek(other)).toBeTruthy();
  });

  it('moves workspaces to the remaining node when one shuts down', async () => {
    await a.app.close();
    await a.ctx.shutdown();
    const r = await b.ctx.queries.run(b.admin, wsId, 'SELECT count(*) FROM orders', { cache: false });
    expect(r.rows).toEqual([[4]]);
    expect(b.ctx.engines.peek(wsId)).toBeTruthy();
    const status = await b.ctx.cluster.status();
    expect(status.nodes.map((n) => n.id)).not.toContain('node-a');
    a = undefined as unknown as Node;
  });
});
