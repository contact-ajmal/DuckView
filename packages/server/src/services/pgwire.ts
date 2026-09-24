/**
 * The PostgreSQL wire protocol (v3): BI tools, notebooks and drivers — psql, Tableau, Power BI, Metabase, Superset,
 * DBeaver, Excel, JDBC/ODBC, psycopg, node-postgres — connect to DuckView as if it were Postgres.
 *
 *   user      the DuckView account's email (any user name works with an API token)
 *   password  the account's password, or an API token (dvk_…) — its scopes and workspace scope apply
 *   database  a workspace (its name or id); omitted or "duckview": the first workspace the person can open
 *
 * Every statement runs through the same path as the SQL workbench (queries.run): the workspace engine, the SQL
 * guard, access policies, the audit log. Session statements (SET, BEGIN, COMMIT, DISCARD …) are acknowledged
 * without effect — each statement runs on its own. `version()` answers like Postgres so drivers that parse it are
 * happy; SHOW of the usual settings answers from a table; pg_catalog queries go to DuckDB's own pg_catalog.
 *
 * Simple and extended query protocols are both supported (Parse/Bind/Describe/Execute/Close/Sync/Flush); parameters
 * are substituted as SQL literals, results are sent in text format (binary for the common numeric types when a
 * driver asks). TLS when a certificate is configured (SSLRequest); passwords are otherwise sent in clear text, so
 * keep the listener on localhost or a private network without TLS.
 */
import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';
import crypto from 'node:crypto';
import type { DuckViewConfig } from '../config/index.js';
import type { AuthService } from './auth.js';
import type { WorkspaceService } from './workspaces.js';
import type { QueryService } from './query.js';
import type { AuditService } from './audit.js';
import type { Principal } from './principal.js';
import { DuckDBInstance } from '@duckdb/node-api';
import { logger } from '../observability/logger.js';

// ------------------------------------------------------------------------------------------ types

/** Postgres type OIDs and lengths for DuckDB types. */
export function pgTypeOf(duckType: string): { oid: number; len: number } {
  const t = duckType.toUpperCase();
  if (t === 'BOOLEAN') return { oid: 16, len: 1 };
  if (t === 'TINYINT' || t === 'SMALLINT' || t === 'UTINYINT') return { oid: 21, len: 2 };
  if (t === 'INTEGER' || t === 'USMALLINT') return { oid: 23, len: 4 };
  if (t === 'BIGINT' || t === 'UINTEGER') return { oid: 20, len: 8 };
  if (t === 'HUGEINT' || t === 'UBIGINT' || t === 'UHUGEINT' || t.startsWith('DECIMAL')) return { oid: 1700, len: -1 };
  if (t === 'FLOAT' || t === 'REAL') return { oid: 700, len: 4 };
  if (t === 'DOUBLE') return { oid: 701, len: 8 };
  if (t === 'DATE') return { oid: 1082, len: 4 };
  if (t === 'TIME') return { oid: 1083, len: 8 };
  if (t === 'TIMESTAMP WITH TIME ZONE') return { oid: 1184, len: 8 };
  if (t.startsWith('TIMESTAMP')) return { oid: 1114, len: 8 };
  if (t === 'INTERVAL') return { oid: 1186, len: 16 };
  if (t === 'BLOB') return { oid: 17, len: -1 };
  if (t === 'UUID') return { oid: 2950, len: 16 };
  if (t === 'JSON') return { oid: 114, len: -1 };
  if (t === 'VARCHAR[]') return { oid: 1009, len: -1 };
  if (t === 'INTEGER[]') return { oid: 1007, len: -1 };
  if (t === 'BIGINT[]') return { oid: 1016, len: -1 };
  return { oid: 25, len: -1 };
}

/** A value in Postgres text format. */
export function pgText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return v ? 't' : 'f';
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return `{${v.map((x) => (x === null || x === undefined ? 'NULL' : typeof x === 'string' ? `"${x.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : typeof x === 'object' ? `"${JSON.stringify(x).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : String(x))).join(',')}}`;
  return JSON.stringify(v);
}

/** Replaces $1…$n outside string literals, quoted identifiers, comments and dollar quotes. */
export function bindParams(sql: string, literal: (index: number) => string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    const rest = sql.slice(i);
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === c) {
          if (sql[j + 1] === c) j += 2;
          else break;
        } else j++;
      }
      out += sql.slice(i, j + 1);
      i = j + 1;
    } else if (rest.startsWith('--')) {
      const j = sql.indexOf('\n', i);
      const end = j < 0 ? sql.length : j;
      out += sql.slice(i, end);
      i = end;
    } else if (rest.startsWith('/*')) {
      const j = sql.indexOf('*/', i + 2);
      const end = j < 0 ? sql.length : j + 2;
      out += sql.slice(i, end);
      i = end;
    } else if (c === '$') {
      const num = /^\$(\d+)/.exec(rest);
      const tag = /^\$([A-Za-z_]\w*)?\$/.exec(rest);
      if (num) {
        out += literal(Number(num[1]));
        i += num[0].length;
      } else if (tag) {
        const close = sql.indexOf(tag[0], i + tag[0].length);
        const end = close < 0 ? sql.length : close + tag[0].length;
        out += sql.slice(i, end);
        i = end;
      } else {
        out += c;
        i++;
      }
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

const NUMERIC_OIDS = new Set([20, 21, 23, 26, 700, 701, 1700]);
/** A parameter value as a SQL literal (typed when the driver said what it is). */
export function paramLiteral(value: string | null, oid: number): string {
  if (value === null) return 'NULL';
  if (NUMERIC_OIDS.has(oid) && /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(value.trim())) return value.trim();
  if (oid === 16) return /^(t|true|1|y|yes|on)$/i.test(value.trim()) ? 'TRUE' : 'FALSE';
  const quoted = `'${value.replace(/'/g, "''")}'`;
  const cast: Record<number, string> = { 1082: 'DATE', 1114: 'TIMESTAMP', 1184: 'TIMESTAMPTZ', 1083: 'TIME', 2950: 'UUID', 114: 'JSON', 3802: 'JSON' };
  return cast[oid] ? `${quoted}::${cast[oid]}` : quoted;
}

/** A binary-format parameter as text (the common scalar types). */
function binaryParam(buf: Buffer, oid: number): string {
  switch (oid) {
    case 16: return buf[0] ? 't' : 'f';
    case 21: return String(buf.readInt16BE(0));
    case 23: return String(buf.readInt32BE(0));
    case 20: return String(buf.readBigInt64BE(0));
    case 700: return String(buf.readFloatBE(0));
    case 701: return String(buf.readDoubleBE(0));
    default: return buf.toString('utf8');
  }
}

/** A value in binary format where the driver asked for it, for the types that have a simple encoding. */
function binaryValue(text: string, oid: number): Buffer {
  const b = (n: number) => Buffer.alloc(n);
  switch (oid) {
    case 16: return Buffer.from([text === 't' ? 1 : 0]);
    case 21: { const x = b(2); x.writeInt16BE(Number(text)); return x; }
    case 23: { const x = b(4); x.writeInt32BE(Number(text)); return x; }
    case 20: { const x = b(8); x.writeBigInt64BE(BigInt(text)); return x; }
    case 700: { const x = b(4); x.writeFloatBE(Number(text)); return x; }
    case 701: { const x = b(8); x.writeDoubleBE(Number(text)); return x; }
    default: return Buffer.from(text, 'utf8');
  }
}

/** What a statement is when it should not reach DuckDB: session settings and transaction control. */
export function sessionTag(sql: string): string | null {
  const m = /^\s*(SET|RESET|BEGIN|START\s+TRANSACTION|COMMIT|END|ROLLBACK|ABORT|DISCARD|DEALLOCATE|LISTEN|UNLISTEN|SAVEPOINT|RELEASE|CLOSE)\b/i.exec(sql);
  if (!m) return null;
  const k = m[1]!.toUpperCase().replace(/\s+/g, ' ');
  if (k === 'START TRANSACTION') return 'START TRANSACTION';
  if (k === 'END') return 'COMMIT';
  if (k === 'ABORT') return 'ROLLBACK';
  if (k === 'DISCARD') return `DISCARD ${/^\s*DISCARD\s+(\w+)/i.exec(sql)?.[1]?.toUpperCase() ?? 'ALL'}`;
  if (k === 'DEALLOCATE') return 'DEALLOCATE';
  return k;
}

const SETTINGS: Record<string, string> = {
  server_version: '15.0',
  server_version_num: '150000',
  server_encoding: 'UTF8',
  client_encoding: 'UTF8',
  datestyle: 'ISO, MDY',
  timezone: 'UTC',
  integer_datetimes: 'on',
  standard_conforming_strings: 'on',
  transaction_isolation: 'read committed',
  default_transaction_isolation: 'read committed',
  transaction_read_only: 'off',
  search_path: '"$user", public, main',
  max_identifier_length: '63',
  lc_collate: 'C',
  lc_ctype: 'C',
  is_superuser: 'off',
  application_name: '',
  intervalstyle: 'postgres',
};

/** Rewrites what Postgres clients ask that DuckDB answers differently. */
export function rewriteForDuckDB(sql: string, duckdbVersion: string): { sql: string } | { answer: { column: string; value: string } } {
  const show = /^\s*SHOW\s+("?)([\w.]+)\1\s*;?\s*$/i.exec(sql);
  if (show) {
    const key = show[2]!.toLowerCase();
    if (key in SETTINGS) return { answer: { column: key, value: SETTINGS[key]! } };
  }
  return { sql: sql.replace(/\b(?:pg_catalog\.)?version\s*\(\s*\)/gi, `'PostgreSQL 15.0 (DuckView, DuckDB ${duckdbVersion.replace(/'/g, '')})'`) };
}

// ------------------------------------------------------------------------------------------ messages

class Writer {
  private chunks: Buffer[] = [];
  msg(type: string, body: Buffer = Buffer.alloc(0)): this {
    const head = Buffer.alloc(5);
    head.write(type, 0, 'ascii');
    head.writeInt32BE(body.length + 4, 1);
    this.chunks.push(head, body);
    return this;
  }
  take(): Buffer {
    const b = Buffer.concat(this.chunks);
    this.chunks = [];
    return b;
  }
}
const cstr = (s: string) => Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0])]);
const i16 = (n: number) => { const b = Buffer.alloc(2); b.writeInt16BE(n); return b; };
const i32 = (n: number) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };

interface Column { name: string; oid: number; len: number }
interface Prepared { sql: string; paramOids: number[] }
interface Portal { sql: string; resultFormats: number[]; result: { columns: Column[]; rows: (string | null)[][]; tag: string } | null; sent: number }

/** An error with a SQLSTATE for the ErrorResponse. */
class PgError extends Error {
  constructor(readonly code: string, message: string, readonly severity = 'ERROR') {
    super(message);
  }
}
function sqlStateOf(err: unknown): string {
  const m = (err as Error).message ?? '';
  const status = (err as { statusCode?: number }).statusCode;
  if (/Parser Error|syntax error/i.test(m)) return '42601';
  if (/Table with name .* does not exist|Catalog Error: Table/i.test(m)) return '42P01';
  if (/column .* not found|Referenced column/i.test(m)) return '42703';
  if (/Binder Error/i.test(m)) return '42P18';
  if (status === 403 || /not allowed|permission|read-only|read scope/i.test(m)) return '42501';
  if (/timeout|timed out/i.test(m)) return '57014';
  return 'XX000';
}

// ------------------------------------------------------------------------------------------ server

export class PgWireServer {
  private server: net.Server | null = null;
  private sockets = new Set<net.Socket>();
  private secureContext: tls.SecureContext | null = null;
  duckdbVersion = 'v1.5';

  constructor(private readonly cfg: DuckViewConfig, private readonly auth: AuthService, private readonly workspaces: WorkspaceService, private readonly queries: QueryService, readonly audit: AuditService) {}

  /** Refuse connections that did not upgrade to TLS. */
  get cfgRequireTls(): boolean {
    return this.cfg.pgwire.require_tls && !!this.secureContext;
  }

  get address(): { host: string; port: number } | null {
    const a = this.server?.address();
    return a && typeof a === 'object' ? { host: a.address, port: a.port } : null;
  }

  get tls(): boolean {
    return !!this.secureContext;
  }

  async start(): Promise<void> {
    const c = this.cfg.pgwire;
    if (!c.enabled || this.server) return;
    // version() answers with the DuckDB version too.
    try {
      const inst = await DuckDBInstance.create(':memory:');
      const conn = await inst.connect();
      this.duckdbVersion = String((await conn.runAndReadAll('SELECT version()')).getRowsJson()[0]?.[0] ?? this.duckdbVersion);
      conn.closeSync();
      inst.closeSync();
    } catch {
      /* keep the default */
    }
    if (c.tls_cert && c.tls_key) this.secureContext = tls.createSecureContext({ cert: fs.readFileSync(c.tls_cert), key: fs.readFileSync(c.tls_key) });
    this.server = net.createServer((socket) => {
      if (this.sockets.size >= c.max_connections) {
        socket.end(new Writer().msg('E', Buffer.concat([cstr('SFATAL'), cstr('C53300'), cstr('Mtoo many connections'), Buffer.from([0])])).take());
        return;
      }
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
      new Session(this, socket).start();
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(c.port, c.host, () => resolve());
    });
    logger().info({ host: c.host, port: this.address?.port, tls: this.tls }, 'Postgres protocol listening');
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
    this.server = null;
  }

  upgrade(socket: net.Socket): tls.TLSSocket | null {
    if (!this.secureContext) return null;
    return new tls.TLSSocket(socket, { isServer: true, secureContext: this.secureContext });
  }

  /** Password: an API token, or the account's own password. */
  async authenticate(user: string, password: string, ip: string): Promise<Principal> {
    if (/^dv[a-z]?_/.test(password) || password.length > 40) {
      const p = await this.auth.verifyToken(password, ip).catch(() => null);
      if (p) return p;
    }
    try {
      const u = await this.auth.login(user, password);
      return this.auth.principalFromUser(u, 'jwt', ip);
    } catch {
      throw new PgError('28P01', `password authentication failed for user "${user}"`, 'FATAL');
    }
  }

  /** The workspace a connection opens: by id or name; the default when none is named (clients send the user name then). */
  async workspaceFor(p: Principal, database: string | undefined, user?: string): Promise<{ id: string; name: string }> {
    const list = await this.workspaces.list(p);
    const usable = p.workspaceScope ? list.filter((w) => w.id === p.workspaceScope) : list;
    let want = (database ?? '').trim();
    const named = (x: string) => usable.some((w) => w.id === x || w.name.toLowerCase() === x.toLowerCase());
    if (want && user && want === user && !named(want)) want = '';
    const pick = !want || want === 'duckview' || want === 'postgres' ? usable[0] : usable.find((w) => w.id === want) ?? usable.find((w) => w.name.toLowerCase() === want.toLowerCase()) ?? usable.find((w) => w.name.toLowerCase().replace(/[^a-z0-9]+/g, '_') === want.toLowerCase());
    if (!pick) throw new PgError('3D000', `database "${want || 'duckview'}" does not exist (use a workspace name or id you can open)`, 'FATAL');
    return { id: pick.id, name: pick.name };
  }

  async execute(p: Principal, workspaceId: string, sql: string): Promise<{ columns: Column[]; rows: (string | null)[][]; tag: string }> {
    const session = sessionTag(sql);
    if (session) return { columns: [], rows: [], tag: session };
    const r = rewriteForDuckDB(sql, this.duckdbVersion);
    if ('answer' in r) return { columns: [{ name: r.answer.column, oid: 25, len: -1 }], rows: [[r.answer.value]], tag: 'SHOW' };
    const res = await this.queries.run(p, workspaceId, r.sql, { cache: false, countTotal: false, maxRows: this.cfg.pgwire.max_rows });
    const columns = res.columns.map((c) => ({ name: c.name, ...pgTypeOf(c.type) }));
    const verb = (/^\s*(\w+)/.exec(r.sql)?.[1] ?? 'SELECT').toUpperCase();
    const changed = res.rowsChanged ?? 0;
    const tag = verb === 'INSERT' ? `INSERT 0 ${changed}` : ['UPDATE', 'DELETE', 'MERGE'].includes(verb) ? `${verb} ${changed}` : ['CREATE', 'DROP', 'ALTER', 'ATTACH', 'DETACH', 'INSTALL', 'LOAD', 'COPY', 'PRAGMA', 'USE'].includes(verb) ? verb === 'COPY' ? `COPY ${changed}` : verb : `SELECT ${res.rows.length}`;
    // Decimals keep their scale (100.50, not 100.5), as Postgres prints them.
    const scales = res.columns.map((c) => Number(/^DECIMAL\(\d+,\s*(\d+)\)$/i.exec(c.type)?.[1] ?? -1));
    const text = (v: unknown, i: number) => (typeof v === 'number' && scales[i]! >= 0 && Number.isFinite(v) ? v.toFixed(scales[i]) : pgText(v));
    return { columns: ['SELECT', 'WITH', 'VALUES', 'TABLE', 'SHOW', 'DESCRIBE', 'SUMMARIZE', 'EXPLAIN', 'FROM', 'PIVOT', 'UNPIVOT'].includes(verb) || columns.length ? columns : [], rows: res.rows.map((row) => row.map(text)), tag };
  }
}

class Session {
  private buf = Buffer.alloc(0);
  private socket: net.Socket;
  private phase: 'startup' | 'password' | 'ready' = 'startup';
  private params: Record<string, string> = {};
  private principal: Principal | null = null;
  private workspace: { id: string; name: string } | null = null;
  private prepared = new Map<string, Prepared>();
  private portals = new Map<string, Portal>();
  /** After an error in the extended protocol, messages are skipped until Sync. */
  private skipping = false;
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly server: PgWireServer, socket: net.Socket) {
    this.socket = socket;
  }

  start(): void {
    this.listen(this.socket);
  }

  private listen(sock: net.Socket): void {
    sock.on('data', (d: Buffer) => {
      this.buf = Buffer.concat([this.buf, d]);
      // Messages are handled in order, one at a time.
      this.chain = this.chain.then(() => this.drain()).catch((err) => {
        logger().debug({ err: (err as Error).message }, 'pgwire session error');
        sock.destroy();
      });
    });
    sock.on('error', () => undefined);
  }

  private send(b: Buffer): void {
    if (!this.socket.destroyed) this.socket.write(b);
  }

  private error(err: unknown): Buffer {
    const e = err instanceof PgError ? err : new PgError(sqlStateOf(err), ((err as Error).message ?? String(err)).split('\n')[0]!.slice(0, 2000));
    return new Writer().msg('E', Buffer.concat([cstr(`S${e.severity}`), cstr(`V${e.severity}`), cstr(`C${e.code}`), cstr(`M${e.message}`), Buffer.from([0])])).take();
  }

  private async drain(): Promise<void> {
    for (;;) {
      if (this.phase === 'startup') {
        if (this.buf.length < 8) return;
        const len = this.buf.readInt32BE(0);
        if (this.buf.length < len) return;
        const code = this.buf.readInt32BE(4);
        const body = this.buf.subarray(8, len);
        this.buf = this.buf.subarray(len);
        if (code === 80877103) {
          // SSLRequest: upgrade when a certificate is configured.
          const upgraded = this.server.upgrade(this.socket);
          this.socket.write(upgraded ? 'S' : 'N');
          if (upgraded) {
            this.socket.removeAllListeners('data');
            this.socket = upgraded;
            this.listen(upgraded);
            return;
          }
          continue;
        }
        if (code === 80877104) {
          this.socket.write('N');
          continue;
        }
        if (code === 80877102) {
          this.socket.end();
          return;
        }
        if (code !== 196608) {
          this.socket.end(this.error(new PgError('08P01', `unsupported protocol ${code >> 16}.${code & 0xffff}`, 'FATAL')));
          return;
        }
        const parts = body.toString('utf8').split('\0');
        for (let i = 0; i + 1 < parts.length; i += 2) if (parts[i]) this.params[parts[i]!] = parts[i + 1]!;
        if (this.server.cfgRequireTls && !(this.socket instanceof tls.TLSSocket)) {
          this.socket.end(this.error(new PgError('28000', 'this server requires TLS (sslmode=require)', 'FATAL')));
          return;
        }
        this.phase = 'password';
        this.send(new Writer().msg('R', i32(3)).take());
        continue;
      }
      if (this.buf.length < 5) return;
      const type = String.fromCharCode(this.buf[0]!);
      const len = this.buf.readInt32BE(1);
      if (this.buf.length < len + 1) return;
      const body = this.buf.subarray(5, len + 1);
      this.buf = this.buf.subarray(len + 1);
      await this.handle(type, body);
      if (this.socket.destroyed) return;
    }
  }

  private async handle(type: string, body: Buffer): Promise<void> {
    if (this.phase === 'password') {
      if (type !== 'p') return void this.socket.end(this.error(new PgError('08P01', 'expected a password message', 'FATAL')));
      const password = body.subarray(0, body.indexOf(0)).toString('utf8');
      const ip = this.socket.remoteAddress ?? 'pgwire';
      try {
        this.principal = await this.server.authenticate(this.params.user ?? '', password, ip);
        this.workspace = await this.server.workspaceFor(this.principal, this.params.database, this.params.user);
      } catch (err) {
        // Slow down guessing.
        await new Promise((r) => setTimeout(r, 400));
        this.server.audit.log({ userId: null, actorType: 'USER', action: 'pgwire.login', resource: `database:${this.params.database ?? ''}`, ip, status: 'error', error: (err as Error).message });
        return void this.socket.end(this.error(err));
      }
      this.phase = 'ready';
      this.server.audit.log({ userId: this.principal.userId, actorType: this.principal.actorType, action: 'pgwire.login', resource: `workspace:${this.workspace.id}`, ip });
      const w = new Writer().msg('R', i32(0));
      const status: Record<string, string> = { server_version: '15.0', server_encoding: 'UTF8', client_encoding: 'UTF8', DateStyle: 'ISO, MDY', TimeZone: 'UTC', integer_datetimes: 'on', standard_conforming_strings: 'on', IntervalStyle: 'postgres', is_superuser: 'off', session_authorization: this.principal.email, application_name: this.params.application_name ?? '' };
      for (const [k, v] of Object.entries(status)) w.msg('S', Buffer.concat([cstr(k), cstr(v)]));
      w.msg('K', Buffer.concat([i32(process.pid), i32(crypto.randomInt(1, 2 ** 31 - 1))]));
      w.msg('Z', Buffer.from('I'));
      return this.send(w.take());
    }
    if (this.skipping && type !== 'S') return;
    switch (type) {
      case 'Q': return this.simpleQuery(body.subarray(0, body.indexOf(0)).toString('utf8'));
      case 'P': return this.parse(body);
      case 'B': return this.bind(body);
      case 'D': return this.describe(body);
      case 'E': return this.executePortal(body);
      case 'C': {
        const kind = String.fromCharCode(body[0]!);
        const name = body.subarray(1, body.indexOf(0, 1)).toString('utf8');
        (kind === 'S' ? this.prepared : this.portals).delete(name);
        return this.send(new Writer().msg('3').take());
      }
      case 'S':
        this.skipping = false;
        return this.send(new Writer().msg('Z', Buffer.from('I')).take());
      case 'H': return;
      case 'X': return void this.socket.end();
      default:
        this.skipping = true;
        return this.send(this.error(new PgError('08P01', `unsupported message "${type}"`)));
    }
  }

  private rowDescription(w: Writer, columns: Column[], formats: number[] = []): void {
    w.msg('T', Buffer.concat([i16(columns.length), ...columns.map((c, i) => Buffer.concat([cstr(c.name), i32(0), i16(0), i32(c.oid), i16(c.len), i32(-1), i16(formats.length === 1 ? formats[0]! : formats[i] ?? 0)]))]));
  }

  private dataRows(w: Writer, columns: Column[], rows: (string | null)[][], formats: number[] = []): void {
    for (const row of rows) {
      w.msg('D', Buffer.concat([i16(row.length), ...row.map((v, i) => {
        if (v === null) return i32(-1);
        const fmt = formats.length === 1 ? formats[0]! : formats[i] ?? 0;
        const bytes = fmt === 1 ? binaryValue(v, columns[i]!.oid) : Buffer.from(v, 'utf8');
        return Buffer.concat([i32(bytes.length), bytes]);
      })]));
    }
  }

  private async simpleQuery(sql: string): Promise<void> {
    const w = new Writer();
    if (!sql.trim().replace(/;+\s*$/, '')) {
      w.msg('I').msg('Z', Buffer.from('I'));
      return this.send(w.take());
    }
    try {
      const r = await this.server.execute(this.principal!, this.workspace!.id, sql);
      if (r.columns.length) {
        this.rowDescription(w, r.columns);
        this.dataRows(w, r.columns, r.rows);
      }
      w.msg('C', cstr(r.tag));
    } catch (err) {
      this.send(w.take());
      this.send(this.error(err));
    }
    w.msg('Z', Buffer.from('I'));
    this.send(w.take());
  }

  private parse(body: Buffer): void {
    let o = 0;
    const read = () => {
      const end = body.indexOf(0, o);
      const s = body.subarray(o, end).toString('utf8');
      o = end + 1;
      return s;
    };
    const name = read();
    const sql = read();
    const n = body.readInt16BE(o);
    o += 2;
    const paramOids: number[] = [];
    for (let i = 0; i < n; i++, o += 4) paramOids.push(body.readInt32BE(o));
    this.prepared.set(name, { sql, paramOids });
    this.send(new Writer().msg('1').take());
  }

  private bind(body: Buffer): void {
    let o = 0;
    const read = () => {
      const end = body.indexOf(0, o);
      const s = body.subarray(o, end).toString('utf8');
      o = end + 1;
      return s;
    };
    const portal = read();
    const stmt = read();
    const prep = this.prepared.get(stmt);
    if (!prep) {
      this.skipping = true;
      return this.send(this.error(new PgError('26000', `prepared statement "${stmt}" does not exist`)));
    }
    const nf = body.readInt16BE(o);
    o += 2;
    const pformats: number[] = [];
    for (let i = 0; i < nf; i++, o += 2) pformats.push(body.readInt16BE(o));
    const np = body.readInt16BE(o);
    o += 2;
    const values: (string | null)[] = [];
    for (let i = 0; i < np; i++) {
      const len = body.readInt32BE(o);
      o += 4;
      if (len < 0) values.push(null);
      else {
        const raw = body.subarray(o, o + len);
        o += len;
        const fmt = pformats.length === 1 ? pformats[0]! : pformats[i] ?? 0;
        values.push(fmt === 1 ? binaryParam(raw, prep.paramOids[i] ?? 0) : raw.toString('utf8'));
      }
    }
    const nr = body.readInt16BE(o);
    o += 2;
    const resultFormats: number[] = [];
    for (let i = 0; i < nr; i++, o += 2) resultFormats.push(body.readInt16BE(o));
    const sql = bindParams(prep.sql, (n) => (n >= 1 && n <= values.length ? paramLiteral(values[n - 1]!, prep.paramOids[n - 1] ?? 0) : 'NULL'));
    this.portals.set(portal, { sql, resultFormats, result: null, sent: 0 });
    this.send(new Writer().msg('2').take());
  }

  private async run(portal: Portal): Promise<void> {
    if (!portal.result) portal.result = await this.server.execute(this.principal!, this.workspace!.id, portal.sql);
  }

  private async describe(body: Buffer): Promise<void> {
    const kind = String.fromCharCode(body[0]!);
    const name = body.subarray(1, body.indexOf(0, 1)).toString('utf8');
    const w = new Writer();
    try {
      if (kind === 'S') {
        const prep = this.prepared.get(name);
        if (!prep) throw new PgError('26000', `prepared statement "${name}" does not exist`);
        const count = Math.max(prep.paramOids.length, ...[...prep.sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])), 0);
        w.msg('t', Buffer.concat([i16(count), ...Array.from({ length: count }, (_, i) => i32(prep.paramOids[i] || 25))]));
        // The row shape without the parameters' values: run it with NULLs when it reads.
        if (/^\s*(SELECT|WITH|VALUES|TABLE|SHOW|FROM)\b/i.test(prep.sql)) {
          const r = await this.server.execute(this.principal!, this.workspace!.id, `SELECT * FROM (${bindParams(prep.sql.replace(/;\s*$/, ''), () => 'NULL')}) AS __shape LIMIT 0`).catch(() => null);
          if (r?.columns.length) this.rowDescription(w, r.columns);
          else w.msg('n');
        } else w.msg('n');
      } else {
        const portal = this.portals.get(name);
        if (!portal) throw new PgError('34000', `portal "${name}" does not exist`);
        await this.run(portal);
        if (portal.result!.columns.length) this.rowDescription(w, portal.result!.columns, portal.resultFormats);
        else w.msg('n');
      }
      this.send(w.take());
    } catch (err) {
      this.skipping = true;
      this.send(w.take());
      this.send(this.error(err));
    }
  }

  private async executePortal(body: Buffer): Promise<void> {
    const end = body.indexOf(0);
    const name = body.subarray(0, end).toString('utf8');
    const max = body.readInt32BE(end + 1);
    const portal = this.portals.get(name);
    const w = new Writer();
    try {
      if (!portal) throw new PgError('34000', `portal "${name}" does not exist`);
      if (!portal.sql.trim()) {
        w.msg('I');
        return this.send(w.take());
      }
      await this.run(portal);
      const r = portal.result!;
      const rows = max > 0 ? r.rows.slice(portal.sent, portal.sent + max) : r.rows.slice(portal.sent);
      this.dataRows(w, r.columns, rows, portal.resultFormats);
      portal.sent += rows.length;
      if (max > 0 && portal.sent < r.rows.length) w.msg('s');
      else w.msg('C', cstr(r.tag));
      this.send(w.take());
    } catch (err) {
      this.skipping = true;
      this.send(w.take());
      this.send(this.error(err));
    }
  }
}
