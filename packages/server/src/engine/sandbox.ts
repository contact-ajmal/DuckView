/**
 * Filesystem jail for DuckDB file access.
 *
 * Every path DuckDB may touch (read_parquet, read_csv, COPY ... TO, ATTACH, .duckdb workspace files)
 * must resolve INSIDE `root`. This is enforced twice:
 *   1. Here, in Node, before SQL reaches DuckDB (clear error messages, audit-able).
 *   2. In DuckDB itself via `allowed_directories` + `enable_external_access=false` + `lock_configuration=true`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export class SandboxViolation extends Error {
  readonly code = 'SANDBOX_VIOLATION';
  constructor(message: string, readonly attempted: string) {
    super(message);
    this.name = 'SandboxViolation';
  }
}

export const DATA_FILE_EXTENSIONS = [
  '.parquet', '.pq', '.csv', '.tsv', '.txt', '.json', '.jsonl', '.ndjson', '.duckdb', '.db', '.ddb',
  '.arrow', '.feather', '.xlsx', '.xls', '.avro', '.orc', '.gz', '.zst', '.bz2', '.sql',
];

const REMOTE_SCHEME = /^(s3|s3a|s3n|gcs|gs|az|azure|abfs|abfss|hf|http|https|ftp|r2|md|motherduck):/i;

export function isRemoteUri(p: string): boolean {
  return REMOTE_SCHEME.test(p.trim());
}

/** True if a string literal in SQL plausibly refers to a file path (vs. ordinary data). */
export function looksLikePath(literal: string): boolean {
  const s = literal.trim();
  if (!s) return false;
  if (isRemoteUri(s)) return true;
  if (s.startsWith('/') || s.startsWith('./') || s.startsWith('../') || s.startsWith('~') || s.startsWith('\\\\') || /^[a-zA-Z]:[\\/]/.test(s)) return true;
  if (/(^|[\\/])\.\.([\\/]|$)/.test(s)) return true;
  const lower = s.toLowerCase().replace(/[*?\[\]{}]/g, '');
  return DATA_FILE_EXTENSIONS.some((ext) => lower.endsWith(ext) || lower.includes(ext + '.'));
}

export interface ResolvedPath {
  /** Absolute, canonical path inside the jail. */
  absolute: string;
  /** Path relative to the jail root (POSIX separators). */
  relative: string;
  exists: boolean;
}

export class DataJail {
  /** Enforcement boundary: every resolved path must live under here ('/' in single-user full-filesystem mode). */
  readonly root: string;
  /** Directory that relative paths, uploads and exports resolve against (the workspace data directory). */
  readonly baseDir: string;

  constructor(root: string, baseDir?: string) {
    fs.mkdirSync(root, { recursive: true });
    this.root = fs.realpathSync(root);
    if (baseDir) {
      fs.mkdirSync(baseDir, { recursive: true });
      this.baseDir = fs.realpathSync(baseDir);
      if (!this.isInside(this.baseDir)) throw new Error(`baseDir ${baseDir} must be inside the jail root ${this.root}`);
    } else this.baseDir = this.root;
  }

  get isFullFilesystem(): boolean {
    return this.root === path.parse(this.root).root;
  }

  /**
   * Resolve a user-supplied path against the jail. Throws SandboxViolation if it escapes.
   * Rules:
   *   - null bytes rejected
   *   - any `..` segment rejected outright (even if it would normalise inside)
   *   - `~` rejected
   *   - remote URIs rejected here (caller decides via allowRemote)
   *   - symlinks resolved; the real path must live under root
   */
  resolve(userPath: string, opts: { allowGlob?: boolean } = {}): ResolvedPath {
    const raw = String(userPath ?? '');
    if (raw.includes('\0')) throw new SandboxViolation('Path contains a null byte', raw);
    if (isRemoteUri(raw)) throw new SandboxViolation(`Remote URIs are not permitted inside the data jail: ${raw}`, raw);
    if (raw.startsWith('~')) throw new SandboxViolation('Home-relative paths are not permitted', raw);
    const normalisedSep = raw.replace(/\\/g, '/');
    if (normalisedSep.split('/').some((seg) => seg === '..')) {
      throw new SandboxViolation(`Path traversal ("..") is not permitted: ${raw}`, raw);
    }
    if (/^[a-zA-Z]:\//.test(normalisedSep)) throw new SandboxViolation('Drive-letter paths are not permitted', raw);

    // Globs: validate the static prefix (everything before the first glob char).
    let candidate = normalisedSep;
    let globSuffix = '';
    const globIdx = candidate.search(/[*?\[\]{}]/);
    if (globIdx >= 0) {
      if (!opts.allowGlob) throw new SandboxViolation('Glob patterns are not permitted here', raw);
      globSuffix = candidate.slice(globIdx);
      candidate = candidate.slice(0, globIdx);
      // keep only the directory part of the static prefix
      const lastSlash = candidate.lastIndexOf('/');
      globSuffix = candidate.slice(lastSlash + 1) + globSuffix;
      candidate = lastSlash >= 0 ? candidate.slice(0, lastSlash + 1) : '';
    }

    const abs = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(this.baseDir, candidate);
    const real = this.realpathNearest(abs);
    if (!this.isInside(real)) {
      throw new SandboxViolation(`Path escapes the data directory: ${raw}`, raw);
    }
    const finalAbs = globSuffix ? path.join(real, globSuffix) : real;
    const exists = !globSuffix && fs.existsSync(real);
    return { absolute: finalAbs, relative: this.relativeTo(finalAbs), exists };
  }

  /** Path relative to baseDir when inside it (POSIX separators); otherwise the absolute path. */
  relativeTo(abs: string): string {
    const rel = path.relative(this.baseDir, abs);
    if (rel === '' ) return '.';
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).join('/');
    return abs;
  }

  /** Resolves symlinks for the deepest existing ancestor, then re-joins the missing tail. */
  private realpathNearest(abs: string): string {
    let cur = abs;
    const tail: string[] = [];
    while (!fs.existsSync(cur)) {
      const parent = path.dirname(cur);
      if (parent === cur) break;
      tail.unshift(path.basename(cur));
      cur = parent;
    }
    let real: string;
    try {
      real = fs.realpathSync(cur);
    } catch {
      real = cur;
    }
    return tail.length ? path.join(real, ...tail) : real;
  }

  isInside(absReal: string): boolean {
    const rel = path.relative(this.root, absReal);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  }

  /**
   * Recursively lists data files under an added workspace folder. Paths are absolute (the folder is outside the
   * data directory). Bounded so that mounting a large folder stays cheap.
   */
  listFilesIn(folder: string, opts: { maxEntries?: number; maxDepth?: number } = {}): JailEntry[] {
    const start = this.resolve(folder).absolute;
    const maxEntries = opts.maxEntries ?? 500;
    const maxDepth = opts.maxDepth ?? 4;
    const out: JailEntry[] = [];
    const walk = (dir: string, depth: number) => {
      if (out.length >= maxEntries || depth > maxDepth) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (out.length >= maxEntries) return;
        if (e.name.startsWith('.') || e.name === 'node_modules') continue;
        const full = path.join(dir, e.name);
        let stat: fs.Stats;
        try {
          stat = fs.statSync(full);
        } catch {
          continue;
        }
        if (stat.isDirectory()) {
          const kind = this.detectTableDir(full);
          if (kind) out.push({ path: full, kind, size_bytes: dirSize(full), modified_at: stat.mtime.toISOString(), root: start });
          else walk(full, depth + 1);
        } else if (stat.isFile()) {
          const kind = fileKind(e.name);
          if (kind) out.push({ path: full, kind, size_bytes: stat.size, modified_at: stat.mtime.toISOString(), root: start });
        }
      }
    };
    walk(start, 0);
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  /**
   * Directory browser for the "add folder" picker: directories only (plus a data-file count per directory),
   * starting at the home directory (full mode) or the data directory (sandboxed).
   */
  browseDirs(dirPath?: string): { path: string; parent: string | null; entries: { name: string; path: string; data_files: number }[] } {
    const start = dirPath && dirPath.trim() ? this.resolve(dirPath).absolute : this.isFullFilesystem ? os.homedir() : this.baseDir;
    const abs = this.resolve(start).absolute;
    let dirents: fs.Dirent[] = [];
    try {
      dirents = fs.readdirSync(abs, { withFileTypes: true });
    } catch (err) {
      throw new SandboxViolation(`Cannot read directory: ${(err as Error).message}`, abs);
    }
    const entries: { name: string; path: string; data_files: number }[] = [];
    for (const d of dirents) {
      if (d.name.startsWith('.') || !d.isDirectory()) continue;
      const full = path.join(abs, d.name);
      let count = 0;
      try {
        for (const f of fs.readdirSync(full)) if (fileKind(f)) count++;
      } catch {
        /* unreadable */
      }
      entries.push({ name: d.name, path: full, data_files: count });
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const parentAbs = path.dirname(abs);
    const parent = parentAbs !== abs && this.isInside(parentAbs) ? parentAbs : null;
    return { path: abs, parent, entries };
  }

  /** Recursively list data files (and directories that look like Delta/Iceberg tables) inside the jail. */
  listFiles(subdir = '', maxEntries = 2000): JailEntry[] {
    const start = this.resolve(subdir || '.').absolute;
    const base = this.baseDir;
    const out: JailEntry[] = [];
    const walk = (dir: string, depth: number) => {
      if (out.length >= maxEntries || depth > 12) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (out.length >= maxEntries) return;
        if (e.name.startsWith('.')) continue;
        const full = path.join(dir, e.name);
        let stat: fs.Stats;
        try {
          stat = fs.statSync(full);
        } catch {
          continue;
        }
        const rel = path.relative(base, full).split(path.sep).join('/');
        if (stat.isDirectory()) {
          const kind = this.detectTableDir(full);
          if (kind) {
            out.push({ path: rel, kind, size_bytes: dirSize(full), modified_at: stat.mtime.toISOString() });
          } else {
            walk(full, depth + 1);
          }
        } else if (stat.isFile()) {
          const kind = fileKind(e.name);
          if (kind) out.push({ path: rel, kind, size_bytes: stat.size, modified_at: stat.mtime.toISOString() });
        }
      }
    };
    walk(start, 0);
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  /** One directory level for the explorer tree: folders first, then files (all files, with data kinds flagged). */
  listDir(dirPath = '.', opts: { showHidden?: boolean } = {}): { path: string; absolute: string; entries: TreeEntry[] } {
    const target = this.resolve(dirPath || '.');
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(target.absolute, { withFileTypes: true });
    } catch (err) {
      throw new SandboxViolation(`Cannot read directory: ${(err as Error).message}`, dirPath);
    }
    const entries: TreeEntry[] = [];
    for (const d of dirents) {
      if (!opts.showHidden && d.name.startsWith('.')) continue;
      const full = path.join(target.absolute, d.name);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        const table = this.detectTableDir(full);
        entries.push({ name: d.name, path: this.relativeTo(full), type: table ? 'table_dir' : 'dir', kind: table ?? 'other', size_bytes: null, modified_at: stat.mtime.toISOString(), queryable: !!table });
      } else if (stat.isFile()) {
        const kind = fileKind(d.name) ?? 'other';
        entries.push({ name: d.name, path: this.relativeTo(full), type: 'file', kind, size_bytes: stat.size, modified_at: stat.mtime.toISOString(), queryable: kind !== 'other' || /\.(sql|txt)$/i.test(d.name) });
      }
    }
    entries.sort((a, b) => (a.type === 'file') === (b.type === 'file') ? a.name.localeCompare(b.name, undefined, { numeric: true }) : a.type === 'file' ? 1 : -1);
    return { path: target.relative, absolute: target.absolute, entries };
  }

  private detectTableDir(dir: string): JailEntry['kind'] | null {
    if (fs.existsSync(path.join(dir, '_delta_log'))) return 'delta';
    if (fs.existsSync(path.join(dir, 'metadata')) && fs.existsSync(path.join(dir, 'data'))) return 'iceberg';
    return null;
  }
}

export interface JailEntry {
  /** Relative to the data directory, or absolute when the file lives in an added workspace folder. */
  path: string;
  kind: 'parquet' | 'csv' | 'json' | 'duckdb' | 'arrow' | 'excel' | 'delta' | 'iceberg' | 'other';
  size_bytes: number;
  modified_at: string;
  /** Absolute path of the workspace folder this entry came from (absent for the data directory). */
  root?: string;
}

export interface TreeEntry {
  name: string;
  path: string;
  type: 'dir' | 'file' | 'table_dir';
  kind: JailEntry['kind'];
  size_bytes: number | null;
  modified_at: string;
  queryable: boolean;
}

function fileKind(name: string): JailEntry['kind'] | null {
  const lower = name.toLowerCase();
  const strip = lower.replace(/\.(gz|zst|bz2)$/, '');
  if (strip.endsWith('.parquet') || strip.endsWith('.pq')) return 'parquet';
  if (strip.endsWith('.csv') || strip.endsWith('.tsv')) return 'csv';
  if (strip.endsWith('.json') || strip.endsWith('.jsonl') || strip.endsWith('.ndjson')) return 'json';
  if (strip.endsWith('.duckdb') || strip.endsWith('.ddb')) return 'duckdb';
  if (strip.endsWith('.arrow') || strip.endsWith('.feather')) return 'arrow';
  if (strip.endsWith('.xlsx') || strip.endsWith('.xls')) return 'excel';
  return null;
}

function dirSize(dir: string, budget = { n: 0 }): number {
  let total = 0;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (budget.n++ > 5000) break;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) total += dirSize(full, budget);
      else if (e.isFile()) total += fs.statSync(full).size;
    }
  } catch {
    /* ignore */
  }
  return total;
}
