/**
 * SQL guard: lightweight lexical analysis of DuckDB SQL for
 *   - statement classification (read / write / destructive / admin) → HITL for agents
 *   - path-literal extraction & rewriting (relative → absolute jail path)
 *   - extension INSTALL/LOAD gating
 *
 * We deliberately do not depend on a full SQL parser: DuckDB's grammar (FROM-first, SUMMARIZE,
 * read_parquet(...), PIVOT, list comprehensions) is not covered by generic parsers, and a lexer
 * that understands strings/comments/parentheses is sufficient for these safety decisions.
 */
import { DataJail, SandboxViolation, isRemoteUri, looksLikePath } from './sandbox.js';

export type StatementClass = 'read' | 'write' | 'destructive' | 'admin' | 'unknown';

export interface StatementInfo {
  index: number;
  sql: string;
  verb: string;
  class: StatementClass;
}

export interface SqlAnalysis {
  statements: StatementInfo[];
  /** Highest-risk class across all statements. */
  overall: StatementClass;
  isMutating: boolean;
  mutatingVerbs: string[];
}

const DESTRUCTIVE = new Set(['DROP', 'DELETE', 'ALTER', 'UPDATE', 'TRUNCATE', 'MERGE']);
const WRITE = new Set(['INSERT', 'CREATE', 'COPY', 'IMPORT', 'EXPORT', 'UPSERT', 'REPLACE', 'CHECKPOINT', 'VACUUM', 'ANALYZE']);
const ADMIN = new Set(['SET', 'RESET', 'PRAGMA', 'INSTALL', 'LOAD', 'ATTACH', 'DETACH', 'CALL', 'USE', 'FORCE', 'BEGIN', 'COMMIT', 'ROLLBACK', 'ABORT', 'START']);
const READ = new Set(['SELECT', 'WITH', 'FROM', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'SUMMARIZE', 'VALUES', 'TABLE', 'PIVOT', 'UNPIVOT', 'PREPARE', 'EXECUTE', 'DEALLOCATE']);

const RANK: Record<StatementClass, number> = { read: 0, unknown: 1, write: 2, admin: 3, destructive: 4 };

interface Token {
  type: 'word' | 'string' | 'punct' | 'ident';
  value: string;
  start: number;
  end: number; // exclusive
  depth: number;
}

/** Tokenises SQL, skipping comments. Strings keep their raw content (without quotes). */
export function tokenize(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let depth = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i]!;
    // whitespace
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    // line comment
    if (c === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      i = nl < 0 ? n : nl + 1;
      continue;
    }
    // block comment (nested allowed in DuckDB)
    if (c === '/' && sql[i + 1] === '*') {
      let d = 1;
      i += 2;
      while (i < n && d > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          d++;
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          d--;
          i += 2;
        } else i++;
      }
      continue;
    }
    // dollar-quoted string $$...$$ or $tag$...$tag$
    if (c === '$') {
      const m = /^\$([A-Za-z_]*)\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const close = sql.indexOf(tag, i + tag.length);
        const end = close < 0 ? n : close + tag.length;
        tokens.push({ type: 'string', value: sql.slice(i + tag.length, close < 0 ? n : close), start: i, end, depth });
        i = end;
        continue;
      }
    }
    // single-quoted string (with '' escape); E'...' / B'...' prefixes handled as word + string
    if (c === "'") {
      let j = i + 1;
      let val = '';
      while (j < n) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            val += "'";
            j += 2;
            continue;
          }
          break;
        }
        val += sql[j];
        j++;
      }
      tokens.push({ type: 'string', value: val, start: i, end: Math.min(j + 1, n), depth });
      i = j + 1;
      continue;
    }
    // double-quoted identifier
    if (c === '"') {
      let j = i + 1;
      while (j < n && !(sql[j] === '"' && sql[j + 1] !== '"')) j += sql[j] === '"' ? 2 : 1;
      tokens.push({ type: 'ident', value: sql.slice(i + 1, j), start: i, end: Math.min(j + 1, n), depth });
      i = j + 1;
      continue;
    }
    if (c === '(') {
      tokens.push({ type: 'punct', value: '(', start: i, end: i + 1, depth });
      depth++;
      i++;
      continue;
    }
    if (c === ')') {
      depth = Math.max(0, depth - 1);
      tokens.push({ type: 'punct', value: ')', start: i, end: i + 1, depth });
      i++;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$]/.test(sql[j]!)) j++;
      tokens.push({ type: 'word', value: sql.slice(i, j).toUpperCase(), start: i, end: j, depth });
      i = j;
      continue;
    }
    tokens.push({ type: 'punct', value: c, start: i, end: i + 1, depth });
    i++;
  }
  return tokens;
}

/** Splits SQL into statements on top-level semicolons (quotes/comments aware). */
export function splitStatements(sql: string): string[] {
  const tokens = tokenize(sql);
  const out: string[] = [];
  let start = 0;
  for (const t of tokens) {
    if (t.type === 'punct' && t.value === ';' && t.depth === 0) {
      const piece = sql.slice(start, t.start).trim();
      if (piece) out.push(piece);
      start = t.end;
    }
  }
  const last = sql.slice(start).trim();
  if (last) out.push(last);
  return out;
}

/** Finds the governing verb of a statement, skipping a leading WITH ... CTE block. */
function statementVerb(tokens: Token[]): string {
  const words = tokens.filter((t) => t.type === 'word' || t.type === 'punct');
  if (words.length === 0) return '';
  const first = words[0]!;
  if (first.type !== 'word') return '';
  if (first.value !== 'WITH') return first.value;
  // WITH [RECURSIVE] name [(cols)] AS [MATERIALIZED] ( ... ) [, ...] <VERB>
  // Find first depth-0 verb token after the CTE list that is not part of CTE syntax.
  const cteSyntax = new Set(['WITH', 'RECURSIVE', 'AS', 'MATERIALIZED', 'NOT']);
  let i = 1;
  let sawParen = false;
  while (i < words.length) {
    const w = words[i]!;
    if (w.depth === 0 && w.type === 'word') {
      if (sawParen && !cteSyntax.has(w.value) && (READ.has(w.value) || WRITE.has(w.value) || DESTRUCTIVE.has(w.value) || ADMIN.has(w.value))) {
        return w.value;
      }
    }
    if (w.type === 'punct' && w.value === ')' && w.depth === 0) sawParen = true;
    if (w.type === 'punct' && w.value === ',' && w.depth === 0) sawParen = false;
    i++;
  }
  return 'WITH';
}

function classify(verb: string, tokens: Token[]): StatementClass {
  if (DESTRUCTIVE.has(verb)) return 'destructive';
  if (verb === 'CREATE') {
    // CREATE OR REPLACE overwrites existing objects → destructive
    const w = tokens.filter((t) => t.type === 'word').slice(0, 4).map((t) => t.value);
    if (w[1] === 'OR' && w[2] === 'REPLACE') return 'destructive';
    return 'write';
  }
  if (verb === 'COPY') {
    // COPY ... TO = write to disk; COPY x FROM = write into table. Both are writes.
    return 'write';
  }
  if (WRITE.has(verb)) return 'write';
  if (ADMIN.has(verb)) return 'admin';
  if (READ.has(verb)) return 'read';
  return 'unknown';
}

export function analyzeSql(sql: string): SqlAnalysis {
  const pieces = splitStatements(sql);
  const statements: StatementInfo[] = pieces.map((piece, index) => {
    const toks = tokenize(piece);
    const verb = statementVerb(toks);
    return { index, sql: piece, verb, class: classify(verb, toks) };
  });
  let overall: StatementClass = statements.length ? 'read' : 'unknown';
  for (const s of statements) if (RANK[s.class] > RANK[overall]) overall = s.class;
  const mutatingVerbs = statements.filter((s) => s.class !== 'read').map((s) => s.verb);
  return { statements, overall, isMutating: overall !== 'read', mutatingVerbs: [...new Set(mutatingVerbs)] };
}

// ---------- Path literals ----------

export interface PathLiteral {
  value: string;
  start: number; // index of opening quote
  end: number; // exclusive, after closing quote
  remote: boolean;
}

export function extractPathLiterals(sql: string): PathLiteral[] {
  return tokenize(sql)
    .filter((t) => t.type === 'string' && looksLikePath(t.value))
    .map((t) => ({ value: t.value, start: t.start, end: t.end, remote: isRemoteUri(t.value) }));
}

export interface GuardOptions {
  jail: DataJail;
  /** Permit s3://, https://, md: etc. Only meaningful when DuckDB external access is on. */
  allowRemote: boolean;
  /** Extension names allowed for INSTALL/LOAD. `null` = any. */
  allowedExtensions: string[] | null;
  blockedExtensions: string[];
  /** Settings the user may never change (defense in depth; DuckDB lock_configuration also applies). */
  blockedSettings?: string[];
}

export interface GuardResult {
  /** SQL with relative path literals rewritten to absolute jail paths. */
  sql: string;
  analysis: SqlAnalysis;
  paths: { original: string; resolved: string; remote: boolean }[];
}

const DEFAULT_BLOCKED_SETTINGS = [
  'enable_external_access', 'allowed_directories', 'allowed_paths', 'lock_configuration', 'allow_unsigned_extensions',
  'autoinstall_known_extensions', 'autoload_known_extensions', 'extension_directory', 'custom_extension_repository',
  'temp_directory', 'memory_limit', 'max_memory', 'threads', 'worker_threads', 'secret_directory', 'file_search_path',
];

/**
 * Validates and rewrites SQL. Throws SandboxViolation for any disallowed path, extension, or setting.
 */
export function guardSql(sql: string, opts: GuardOptions): GuardResult {
  const analysis = analyzeSql(sql);
  const blockedSettings = new Set((opts.blockedSettings ?? DEFAULT_BLOCKED_SETTINGS).map((s) => s.toLowerCase()));

  // Extension + setting checks
  for (const st of analysis.statements) {
    const words = tokenize(st.sql).filter((t) => t.type === 'word' || t.type === 'ident' || t.type === 'string');
    const verb = st.verb;
    if (verb === 'INSTALL' || verb === 'LOAD' || (verb === 'FORCE' && words[1]?.value === 'INSTALL')) {
      const nameTok = words[verb === 'FORCE' ? 2 : 1];
      const name = (nameTok?.value ?? '').toLowerCase().replace(/^.*\//, '').replace(/\.duckdb_extension.*$/, '');
      if (!name) throw new SandboxViolation('Malformed INSTALL/LOAD statement', st.sql);
      if (opts.blockedExtensions.map((e) => e.toLowerCase()).includes(name)) throw new SandboxViolation(`Extension "${name}" is blocked by policy`, name);
      if (opts.allowedExtensions && !opts.allowedExtensions.map((e) => e.toLowerCase()).includes(name)) {
        throw new SandboxViolation(`Extension "${name}" is not in the allowed extension list`, name);
      }
    }
    if (verb === 'SET' || verb === 'RESET' || verb === 'PRAGMA') {
      const candidates = words.slice(1, 4).map((t) => t.value.toLowerCase());
      for (const c of candidates) {
        if (blockedSettings.has(c)) throw new SandboxViolation(`Changing "${c}" is not permitted`, c);
      }
    }
  }

  // Path checks and rewriting (rewrite from the end so offsets stay valid)
  const literals = extractPathLiterals(sql);
  const paths: GuardResult['paths'] = [];
  let out = sql;
  for (const lit of [...literals].reverse()) {
    if (lit.remote) {
      if (!opts.allowRemote) throw new SandboxViolation(`Remote data sources are disabled by policy: ${lit.value}`, lit.value);
      paths.unshift({ original: lit.value, resolved: lit.value, remote: true });
      continue;
    }
    const resolved = opts.jail.resolve(lit.value, { allowGlob: true });
    paths.unshift({ original: lit.value, resolved: resolved.absolute, remote: false });
    if (resolved.absolute !== lit.value) {
      const escaped = resolved.absolute.replace(/'/g, "''");
      out = out.slice(0, lit.start) + `'${escaped}'` + out.slice(lit.end);
    }
  }
  return { sql: out, analysis, paths };
}

/** Strips a trailing semicolon and whitespace; useful before wrapping a query in a subselect. */
export function stripTrailingSemicolon(sql: string): string {
  return sql.replace(/;\s*$/g, '').trim();
}

/** True if the (single) statement is a row-returning read query we can wrap in `SELECT count(*) FROM (...)`. */
export function isWrappableSelect(sql: string): boolean {
  const a = analyzeSql(sql);
  if (a.statements.length !== 1) return false;
  const v = a.statements[0]!.verb;
  return v === 'SELECT' || v === 'WITH' || v === 'FROM' || v === 'VALUES' || v === 'PIVOT' || v === 'UNPIVOT' || v === 'TABLE';
}
