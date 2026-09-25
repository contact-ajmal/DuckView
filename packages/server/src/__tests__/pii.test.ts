import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../config/index.js';
import { initLogger } from '../observability/logger.js';
import { createContext, type AppContext } from '../context.js';
import type { Principal } from '../services/principal.js';
import { maskExample } from '../services/pii.js';

let dir: string;
let ctx: AppContext;
let admin: Principal;
let viewer: Principal;
let ws: string;

beforeAll(async () => {
  initLogger({ level: 'silent', stderr: true, pretty: false });
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dv-pii-')));
  const cfg = loadConfig({ configPath: null, env: { DUCKVIEW_DATA_DIR: path.join(dir, 'data'), DUCKVIEW_FILESYSTEM_MODE: 'sandboxed', DUCKDB_TEMP_DIRECTORY: path.join(dir, 'spill'), DATABASE_URL: ':memory:', DUCKDB_MEMORY_LIMIT: '1GB', DUCKVIEW_ADMIN_EMAIL: 'admin@test.local', DUCKVIEW_ADMIN_PASSWORD: 'super-secret-pw', LOG_LEVEL: 'silent' } });
  ctx = await createContext(cfg);
  admin = ctx.auth.principalFromUser((await ctx.auth.findByEmail('admin@test.local'))!, 'jwt', '127.0.0.1');
  const u = await ctx.auth.createLocalUser({ email: 'viewer@test.local', password: 'viewer-pass-123', role: 'USER' });
  viewer = ctx.auth.principalFromUser(u, 'jwt', '127.0.0.1');
  ws = (await ctx.workspaces.create(admin, { name: 'PII', active_db_path: 'pii.duckdb' })).id;
  await ctx.workspaces.setMember(admin, ws, { subject_type: 'user', subject_id: u.id, role: 'VIEWER' });
  // Values that give themselves away, names that do, and a column that is neither.
  await ctx.queries.run(admin, ws, `CREATE TABLE people AS SELECT * FROM (VALUES
    (1, 'ann@example.com', '+44 20 7946 0958', '4111 1111 1111 1111', 'GB82WEST12345698765432', '10.0.0.1', 'Ann', DATE '1990-01-02', 'red'),
    (2, 'bob@example.org', '+44 20 7946 0959', '5500 0000 0000 0004', 'DE89370400440532013000', '10.0.0.2', 'Bob', DATE '1985-03-04', 'blue'),
    (3, 'cy@example.net', '+1 415 555 0101', '4012 8888 8888 1881', 'FR1420041010050500013M02606', '192.168.1.9', 'Cy', DATE '1979-05-06', 'green'),
    (4, 'dee@example.com', '+1 415 555 0102', '3782 822463 10005', 'GB33BUKB20201555555555', '172.16.0.3', 'Dee', DATE '2001-07-08', 'red'),
    (5, 'eve@example.com', '+49 30 901820', '6011 1111 1111 1117', 'NL91ABNA0417164300', '8.8.8.8', 'Eve', DATE '1995-09-10', 'blue')
  ) t(id, contact, tel_raw, card_col, acct, seen_from, first_name, dob, colour)`);
});

afterAll(async () => {
  await ctx?.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('personal data', () => {
  it('finds it by values and by names, with masked examples', async () => {
    const f = await ctx.pii.scan(admin, ws);
    const by = Object.fromEntries(f.map((x) => [x.column, x]));
    expect(by.contact).toMatchObject({ kind: 'email', evidence: 'values', confidence: 'high', match_rate: 1 });
    expect(by.tel_raw).toMatchObject({ kind: 'phone', evidence: 'both', confidence: 'high' }); // "tel" in the name too
    expect(by.card_col).toMatchObject({ kind: 'card', evidence: 'both' });
    expect(by.acct).toMatchObject({ kind: 'iban', evidence: 'values' });
    expect(by.seen_from).toMatchObject({ kind: 'ip' });
    expect(by.first_name).toMatchObject({ kind: 'person_name', evidence: 'name', confidence: 'medium' });
    expect(by.dob).toMatchObject({ kind: 'birth_date', evidence: 'name', suggested_mask: 'null' });
    expect(by.colour).toBeUndefined();
    expect(by.id).toBeUndefined();
    expect(by.contact!.examples[0]).toBe('a••@e••••••.com');
    expect(JSON.stringify(f)).not.toContain('ann@example.com');
  });

  it('masks examples without revealing them', () => {
    expect(maskExample('4111 1111 1111 1111')).toBe('41•• •••• •••• ••11');
  });

  it('tags findings in the catalog and masks them for everyone but owners', async () => {
    await ctx.pii.tag(admin, ws, [{ object: 'people', column: 'contact', kind: 'email' }]);
    const cat = await ctx.lineage.catalog(admin, ws);
    expect(cat.find((o) => o.name === 'people')!.columns.find((c) => c.name === 'contact')!.tags).toEqual(['pii', 'pii:email']);
    expect((await ctx.pii.scan(admin, ws)).find((x) => x.column === 'contact')!.tagged).toBe(true);
    const policy = await ctx.pii.protect(admin, ws, 'people', { contact: 'redact', card_col: 'partial' });
    expect(policy.name).toBe('Personal data in people');
    const seenByViewer = await ctx.queries.run(viewer, ws, 'SELECT contact, card_col FROM people ORDER BY id LIMIT 1');
    expect(seenByViewer.rows[0]![0]).not.toBe('ann@example.com');
    expect(String(seenByViewer.rows[0]![1])).not.toBe('4111 1111 1111 1111');
    const seenByOwner = await ctx.queries.run(admin, ws, 'SELECT contact FROM people ORDER BY id LIMIT 1');
    expect(seenByOwner.rows[0]![0]).toBe('ann@example.com');
    // Protecting again updates the same policy.
    await ctx.pii.protect(admin, ws, 'people', { dob: 'null' });
    expect((await ctx.policies.list(admin, ws)).filter((x) => x.name === 'Personal data in people')).toHaveLength(1);
  });
});
