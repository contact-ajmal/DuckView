/**
 * Streams: decoding (JSON objects, other values, text that is not JSON, metadata columns), HTTP pushes with a key
 * (JSON, NDJSON, columns that appear later, values that do not fit), Kinesis with checkpoints that a restart
 * resumes from (a fake client), lineage, and — with DUCKVIEW_TEST_KAFKA_BROKERS set (e.g. a Redpanda container on
 * localhost:19092) — a real Kafka topic whose committed offsets survive a restart.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Kafka, logLevel } from 'kafkajs';
import { loadConfig } from '../config/index.js';
import { initLogger } from '../observability/logger.js';
import { createContext, type AppContext } from '../context.js';
import { buildApp } from '../app.js';
import { rowsOf, recordsOfPush, type KinesisLike } from '../services/streams.js';
import type { Principal } from '../services/principal.js';

let dir: string;
let ctx: AppContext;
let app: Awaited<ReturnType<typeof buildApp>>['app'];
let base: string;
let wsId: string;
let admin: Principal;
const KAFKA = process.env.DUCKVIEW_TEST_KAFKA_BROKERS;

const q = async (sql: string) => (await ctx.queries.run(admin, wsId, sql, { cache: false })).rows;
const until = async (check: () => Promise<boolean>, ms = 20_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('timed out');
};

beforeAll(async () => {
  initLogger({ level: 'silent', stderr: true, pretty: false });
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dv-streams-'));
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  const cfg = loadConfig({ configPath: null, env: { DUCKVIEW_DATA_DIR: path.join(dir, 'data'), DUCKDB_TEMP_DIRECTORY: path.join(dir, 'spill'), DATABASE_URL: ':memory:', DUCKDB_MEMORY_LIMIT: '512MB', DUCKVIEW_ADMIN_EMAIL: 'admin@test.local', DUCKVIEW_ADMIN_PASSWORD: 'super-secret-pw', DUCKVIEW__duckdb__sync_scheduler_enabled: 'false', DUCKVIEW__notifications__scheduler_enabled: 'false', DUCKVIEW__transform__scheduler_enabled: 'false', DUCKVIEW__apps__enabled: 'false', LOG_LEVEL: 'silent' } });
  ctx = await createContext(cfg);
  admin = ctx.auth.principalFromUser((await ctx.auth.findByEmail('admin@test.local'))!, 'jwt', '127.0.0.1');
  wsId = (await ctx.workspaces.create(admin, { name: 'Events', active_db_path: 'events.duckdb' })).id;
  ({ app } = await buildApp(ctx));
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(app.server.address() as net.AddressInfo).port}`;
}, 120_000);

afterAll(async () => {
  await app?.close();
  await ctx?.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('decoding', () => {
  it('turns messages into rows', () => {
    const now = new Date('2026-09-24T10:00:00Z');
    expect(rowsOf([{ value: '{"a": 1}', key: 'k', partition: 0, offset: '7', timestamp: '2026-09-24T09:59:00.000Z' }, { value: '42' }, { value: 'not json' }], 'json', true, now)).toEqual([
      { a: 1, _key: 'k', _partition: '0', _offset: '7', _timestamp: '2026-09-24T09:59:00.000Z', _ingested_at: '2026-09-24T10:00:00.000Z' },
      { value: 42, _key: null, _partition: null, _offset: null, _timestamp: null, _ingested_at: '2026-09-24T10:00:00.000Z' },
      { _raw: 'not json', _key: null, _partition: null, _offset: null, _timestamp: null, _ingested_at: '2026-09-24T10:00:00.000Z' },
    ]);
    expect(rowsOf([{ value: '{"a": 1}' }], 'text', false)).toEqual([{ value: '{"a": 1}' }]);
    expect(recordsOfPush([{ a: 1 }, { a: 2 }])).toHaveLength(2);
    expect(recordsOfPush('{"a": 1}\n{"a": 2}\n')).toEqual([{ value: '{"a": 1}' }, { value: '{"a": 2}' }]);
    expect(recordsOfPush({ a: 1 })).toEqual([{ value: { a: 1 } }]);
  });
});

describe('HTTP pushes', () => {
  it('appends pushed events, grows the table and keeps going when a value does not fit', async () => {
    const { stream, push_key } = await ctx.streams.create(admin, wsId, { name: 'Clicks', config: { kind: 'http' }, target_table: 'clicks' });
    expect(stream).toMatchObject({ kind: 'http', status: 'running', push_url: `/api/streams/${stream.id}/push` });
    expect(push_key).toMatch(/^dvs_/);
    const push = (body: string, key: string | null, type = 'application/json') => fetch(`${base}/api/streams/${stream.id}/push`, { method: 'POST', headers: { 'content-type': type, ...(key ? { authorization: `Bearer ${key}` } : {}) }, body });
    const r1 = await push(JSON.stringify([{ page: '/home', ms: 120 }, { page: '/pricing', ms: 340 }]), push_key);
    expect(r1.status).toBe(202);
    expect(await r1.json()).toEqual({ accepted: 2 });
    // NDJSON with a new column and a value that is not a number.
    const r2 = await push('{"page": "/docs", "ms": "slow", "country": "PT"}\n{"page": "/home", "ms": 90}\n', push_key, 'application/x-ndjson');
    expect(r2.status).toBe(202);
    expect(await q('SELECT page, ms, country FROM clicks ORDER BY _ingested_at, ms NULLS FIRST')).toEqual([['/home', 120, null], ['/pricing', 340, null], ['/docs', null, 'PT'], ['/home', 90, null]]);
    expect((await push('[{"page": "x"}]', 'dvs_wrong')).status).toBe(401);
    expect((await push('[{"page": "x"}]', null)).status).toBe(401);
    const s = (await ctx.streams.list(admin, wsId)).find((x) => x.id === stream.id)!;
    expect(s.stats).toMatchObject({ rows_total: 4, batches: 2, last_batch_rows: 2, last_error: null });
    // A new key replaces the old one.
    const fresh = await ctx.streams.rotateKey(admin, stream.id);
    expect((await push('[{"page": "x"}]', push_key)).status).toBe(401);
    expect((await push('[{"page": "/new"}]', fresh, 'text/plain')).status).toBe(202);
    const jwt = (await (await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@test.local', password: 'super-secret-pw' }) })).json()).token;
    const detail = await (await fetch(`${base}/api/streams/${stream.id}`, { headers: { authorization: `Bearer ${jwt}` } })).json();
    expect(detail.latest.rows[0][detail.latest.columns.findIndex((c: { name: string }) => c.name === 'page')]).toBe('/new');
    expect(JSON.stringify(detail.stream)).not.toMatch(/key_hash|encrypted_secret/);
    // Another stream cannot write to the same table.
    await expect(ctx.streams.create(admin, wsId, { config: { kind: 'http' }, target_table: 'clicks' })).rejects.toThrow(/already writes to main.clicks/);
  });
});

describe('Kinesis', () => {
  it('reads every shard, saves checkpoints after writing, and resumes from them', async () => {
    const records = [0, 1, 2, 3].map((i) => ({ SequenceNumber: String(100 + i), PartitionKey: `user-${i}`, Data: Buffer.from(JSON.stringify({ event: 'signup', n: i })), ApproximateArrivalTimestamp: new Date('2026-09-24T09:00:00Z') }));
    const iteratorRequests: Record<string, unknown>[] = [];
    let served = 2;
    const fake: KinesisLike = {
      async send(cmd) {
        const input = (cmd as { input: Record<string, any> }).input; // eslint-disable-line @typescript-eslint/no-explicit-any
        const name = cmd.constructor.name;
        if (name === 'ListShardsCommand') return { Shards: [{ ShardId: 'shardId-000' }] };
        if (name === 'GetShardIteratorCommand') {
          iteratorRequests.push(input);
          const after = input.StartingSequenceNumber ? records.findIndex((r) => r.SequenceNumber === input.StartingSequenceNumber) + 1 : 0;
          return { ShardIterator: `it-${after}` };
        }
        if (name === 'GetRecordsCommand') {
          const from = Number(String(input.ShardIterator).slice(3));
          const to = Math.min(served, records.length);
          return { Records: records.slice(from, to), NextShardIterator: `it-${Math.max(from, to)}`, MillisBehindLatest: 0 };
        }
        if (name === 'DescribeStreamSummaryCommand') return { StreamDescriptionSummary: { StreamStatus: 'ACTIVE', OpenShardCount: 1 } };
        throw new Error(`unexpected ${name}`);
      },
    };
    ctx.streams.kinesisClient = () => fake;
    ctx.streams.kinesisIdleMs = 20;
    const config = { kind: 'kinesis' as const, stream: 'signups', region: 'eu-west-1' };
    expect(await ctx.streams.test(admin, { config })).toEqual({ ok: true, detail: 'Stream signups: ACTIVE, 1 open shard(s)' });
    const { stream } = await ctx.streams.create(admin, wsId, { name: 'Signups', config, target_table: 'signups', batch_seconds: 1 });
    await until(async () => Number((await q('SELECT count(*) FROM signups').catch(() => [[0]]))[0]![0]) === 2);
    await until(async () => (await ctx.streams.list(admin, wsId)).find((x) => x.id === stream.id)!.checkpoints['shardId-000'] === '101');
    expect(iteratorRequests[0]).toMatchObject({ ShardIteratorType: 'TRIM_HORIZON' });
    // Stop, let more arrive, start again: reading resumes after the checkpoint (nothing twice).
    await ctx.streams.update(admin, stream.id, { enabled: false });
    served = 4;
    await ctx.streams.update(admin, stream.id, { enabled: true });
    await until(async () => Number((await q('SELECT count(*) FROM signups'))[0]![0]) === 4);
    expect(iteratorRequests.at(-1)).toMatchObject({ ShardIteratorType: 'AFTER_SEQUENCE_NUMBER', StartingSequenceNumber: '101' });
    expect(await q('SELECT n, _key, _partition, _offset FROM signups ORDER BY n')).toEqual([[0, 'user-0', 'shardId-000', '100'], [1, 'user-1', 'shardId-000', '101'], [2, 'user-2', 'shardId-000', '102'], [3, 'user-3', 'shardId-000', '103']]);
    expect((await ctx.streams.list(admin, wsId)).find((x) => x.id === stream.id)!.status).toBe('running');
    await ctx.streams.remove(admin, stream.id);
    expect(ctx.streams.isRunning(stream.id)).toBe(false);
  });

  it('shows streams in lineage', async () => {
    const g = await ctx.lineage.graph(admin, wsId);
    expect(g.edges).toEqual(expect.arrayContaining([expect.objectContaining({ to: 'table:clicks', kind: 'loads' })]));
    expect(g.nodes.find((n) => n.label === 'Clicks')).toMatchObject({ kind: 'sync', detail: 'streaming · HTTP pushes' });
  });
});

describe.skipIf(!KAFKA)('Kafka', () => {
  it('consumes a topic, commits after writing, and resumes where it stopped', async () => {
    const topic = `dv-test-${Date.now()}`;
    const kafka = new Kafka({ clientId: 'dv-test', brokers: KAFKA!.split(','), logLevel: logLevel.NOTHING });
    const admin_ = kafka.admin();
    await admin_.connect();
    await admin_.createTopics({ topics: [{ topic, numPartitions: 2 }], waitForLeaders: true });
    await admin_.disconnect();
    const producer = kafka.producer();
    await producer.connect();
    await producer.send({ topic, messages: [0, 1, 2].map((i) => ({ key: `k${i}`, value: JSON.stringify({ order: i, amount: 10 * i }) })) });
    const config = { kind: 'kafka' as const, brokers: KAFKA!.split(','), topic, from_beginning: true };
    expect((await ctx.streams.test(admin, { config })).detail).toBe(`Topic ${topic}: 2 partitions`);
    const { stream } = await ctx.streams.create(admin, wsId, { name: 'Orders', config, target_table: 'kafka_orders', batch_seconds: 1 });
    await until(async () => Number((await q('SELECT count(*) FROM kafka_orders').catch(() => [[0]]))[0]![0]) === 3, 30_000);
    await until(async () => (await ctx.streams.list(admin, wsId)).find((x) => x.id === stream.id)!.status === 'running', 10_000);
    await ctx.streams.update(admin, stream.id, { enabled: false });
    await producer.send({ topic, messages: [3, 4].map((i) => ({ key: `k${i}`, value: JSON.stringify({ order: i, amount: 10 * i }) })) });
    await producer.disconnect();
    await ctx.streams.update(admin, stream.id, { enabled: true });
    await until(async () => Number((await q('SELECT count(*) FROM kafka_orders'))[0]![0]) === 5, 30_000);
    await new Promise((r) => setTimeout(r, 1500));
    expect(await q('SELECT "order", amount FROM kafka_orders ORDER BY "order"')).toEqual([0, 1, 2, 3, 4].map((i) => [i, 10 * i]));
    await ctx.streams.remove(admin, stream.id);
  }, 90_000);
});
