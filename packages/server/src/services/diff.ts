/**
 * Compare two datasets: tables, views, files or SELECTs of a workspace — or a table against its copy in one of the
 * workspace's backups (`backup:<backup id>:<table>`).
 *
 * The comparison reports schema changes (columns added, removed or retyped) and row counts, then either
 *  - with key columns: rows added, removed and changed (with how many rows changed in each column, and samples
 *    showing the value before and after), or
 *  - without keys: rows found only on one side (as whole rows, duplicates counted).
 * Everything runs as read-only SQL through the query service, so access policies apply.
 */
import fs from 'node:fs';
import type { AppContext } from '../context.js';
import type { Principal } from './principal.js';
import { badRequest } from './errors.js';

export interface DiffInput {
  left: string;
  right: string;
  key?: string[];
  sample?: number;
}
export interface DiffResult {
  left: { target: string; rows: number };
  right: { target: string; rows: number };
  schema: { added: { name: string; type: string }[]; removed: { name: string; type: string }[]; retyped: { name: string; from: string; to: string }[]; compared: string[] };
  key: string[];
  /** With keys. */
  added: number | null;
  removed: number | null;
  changed: number | null;
  unchanged: number | null;
  columns: { name: string; changed: number }[];
  /** Without keys: whole rows found on one side only. */
  only_left: number | null;
  only_right: number | null;
  samples: { added: Record<string, unknown>[]; removed: Record<string, unknown>[]; changed: { key: Record<string, unknown>; changes: { column: string; before: unknown; after: unknown }[] }[] };
  /** Keys that repeat on a side make matching by key ambiguous. */
  duplicate_keys: { left: number; right: number };
  sql: { summary: string };
}

const q = (s: string) => `"${s.replace(/"/g, '""')}"`;

export class DiffService {
  private ctx!: AppContext;
  bind(ctx: AppContext) {
    this.ctx = ctx;
  }

  async compare(p: Principal, workspaceId: string, input: DiffInput): Promise<DiffResult> {
    const c = this.ctx;
    const attached: string[] = [];
    const { engine } = await c.workspaces.engine(p, workspaceId);
    const rel = async (target: string): Promise<string> => {
      const bk = /^backup:([^:]+):(.+)$/.exec(target.trim());
      if (!bk) return `(${engine.resolveRelation(target).select})`;
      const backup = (await c.lifecycle.listBackups(p, workspaceId)).find((b) => b.id === bk[1]);
      if (!backup || !fs.existsSync(backup.file)) throw badRequest('That backup is not available');
      const alias = `__dv_bk_${attached.length}_${Date.now().toString(36)}`;
      await engine.runInternal(`ATTACH '${backup.file.replace(/'/g, "''")}' AS ${alias} (READ_ONLY)`, 60_000);
      attached.push(alias);
      const table = bk[2]!.split('.').map((part) => q(part.replace(/^"|"$/g, ''))).join('.');
      return `(SELECT * FROM ${alias}.${table.includes('.') ? table : `main.${table}`})`;
    };
    const run = async (sql: string, maxRows = 1000) => c.queries.run(p, workspaceId, sql, { maxRows, cache: false });
    const rowsOf = (r: { columns: { name: string }[]; rows: unknown[][] }) => r.rows.map((row) => Object.fromEntries(r.columns.map((col, i) => [col.name, row[i]])));
    try {
      const L = await rel(input.left);
      const R = await rel(input.right);
      const describe = async (x: string) => (await run(`DESCRIBE SELECT * FROM ${x} AS _d`)).rows.map((r) => ({ name: String(r[0]), type: String(r[1]) }));
      const [lc, rc] = await Promise.all([describe(L), describe(R)]);
      const rmap = new Map(rc.map((x) => [x.name, x.type]));
      const lmap = new Map(lc.map((x) => [x.name, x.type]));
      const schema = {
        added: rc.filter((x) => !lmap.has(x.name)),
        removed: lc.filter((x) => !rmap.has(x.name)),
        retyped: lc.filter((x) => rmap.has(x.name) && rmap.get(x.name) !== x.type).map((x) => ({ name: x.name, from: x.type, to: rmap.get(x.name)! })),
        compared: lc.filter((x) => rmap.has(x.name)).map((x) => x.name),
      };
      if (!schema.compared.length) throw badRequest('The two datasets have no column in common to compare');
      const key = (input.key ?? []).filter(Boolean);
      for (const k of key) if (!lmap.has(k) || !rmap.has(k)) throw badRequest(`Key column ${k} is not on both sides`);
      const sample = Math.min(Math.max(input.sample ?? 20, 1), 200);
      const counts = (await run(`SELECT (SELECT count(*) FROM ${L} AS _l), (SELECT count(*) FROM ${R} AS _r)`)).rows[0]!;
      const out: DiffResult = {
        left: { target: input.left, rows: Number(counts[0]) },
        right: { target: input.right, rows: Number(counts[1]) },
        schema,
        key,
        added: null,
        removed: null,
        changed: null,
        unchanged: null,
        columns: [],
        only_left: null,
        only_right: null,
        samples: { added: [], removed: [], changed: [] },
        duplicate_keys: { left: 0, right: 0 },
        sql: { summary: '' },
      };
      const cols = schema.compared.map(q).join(', ');

      if (!key.length) {
        const summary = `SELECT (SELECT count(*) FROM (SELECT ${cols} FROM ${L} AS _l EXCEPT ALL SELECT ${cols} FROM ${R} AS _r)), (SELECT count(*) FROM (SELECT ${cols} FROM ${R} AS _r EXCEPT ALL SELECT ${cols} FROM ${L} AS _l))`;
        const s = (await run(summary)).rows[0]!;
        out.only_left = Number(s[0]);
        out.only_right = Number(s[1]);
        out.removed = out.only_left;
        out.added = out.only_right;
        out.samples.removed = rowsOf(await run(`SELECT ${cols} FROM ${L} AS _l EXCEPT ALL SELECT ${cols} FROM ${R} AS _r LIMIT ${sample}`, sample));
        out.samples.added = rowsOf(await run(`SELECT ${cols} FROM ${R} AS _r EXCEPT ALL SELECT ${cols} FROM ${L} AS _l LIMIT ${sample}`, sample));
        out.sql.summary = summary;
        return out;
      }

      const keyCols = key.map(q).join(', ');
      const on = key.map((k) => `l.${q(k)} IS NOT DISTINCT FROM r.${q(k)}`).join(' AND ');
      const valueCols = schema.compared.filter((x) => !key.includes(x));
      const diffCond = valueCols.length ? valueCols.map((x) => `l.${q(x)} IS DISTINCT FROM r.${q(x)}`).join(' OR ') : 'false';
      const dup = (await run(`SELECT (SELECT count(*) FROM (SELECT ${keyCols} FROM ${L} AS _l GROUP BY ALL HAVING count(*) > 1)), (SELECT count(*) FROM (SELECT ${keyCols} FROM ${R} AS _r GROUP BY ALL HAVING count(*) > 1))`)).rows[0]!;
      out.duplicate_keys = { left: Number(dup[0]), right: Number(dup[1]) };
      const perCol = valueCols.map((x) => `count(*) FILTER (WHERE l.${q(x)} IS DISTINCT FROM r.${q(x)})`).join(', ');
      const summary = [
        `SELECT`,
        `  (SELECT count(*) FROM ${R} AS r WHERE NOT EXISTS (SELECT 1 FROM ${L} AS l WHERE ${on})) AS added,`,
        `  (SELECT count(*) FROM ${L} AS l WHERE NOT EXISTS (SELECT 1 FROM ${R} AS r WHERE ${on})) AS removed,`,
        `  (SELECT count(*) FROM ${L} AS l JOIN ${R} AS r ON ${on} WHERE ${diffCond}) AS changed,`,
        `  (SELECT count(*) FROM ${L} AS l JOIN ${R} AS r ON ${on} WHERE NOT (${diffCond})) AS unchanged`,
      ].join('\n');
      const s = (await run(summary)).rows[0]!;
      out.added = Number(s[0]);
      out.removed = Number(s[1]);
      out.changed = Number(s[2]);
      out.unchanged = Number(s[3]);
      if (valueCols.length) {
        const pc = (await run(`SELECT ${perCol} FROM ${L} AS l JOIN ${R} AS r ON ${on}`)).rows[0]!;
        out.columns = valueCols.map((name, i) => ({ name, changed: Number(pc[i]) })).filter((x) => x.changed > 0).sort((a, b) => b.changed - a.changed);
      }
      out.samples.added = rowsOf(await run(`SELECT ${cols} FROM ${R} AS r WHERE NOT EXISTS (SELECT 1 FROM ${L} AS l WHERE ${on}) ORDER BY ${keyCols} LIMIT ${sample}`, sample));
      out.samples.removed = rowsOf(await run(`SELECT ${cols} FROM ${L} AS l WHERE NOT EXISTS (SELECT 1 FROM ${R} AS r WHERE ${on}) ORDER BY ${keyCols} LIMIT ${sample}`, sample));
      if (valueCols.length && out.changed) {
        const sel = [...key.map((k) => `l.${q(k)} AS ${q(`k:${k}`)}`), ...valueCols.flatMap((x) => [`l.${q(x)} AS ${q(`l:${x}`)}`, `r.${q(x)} AS ${q(`r:${x}`)}`])].join(', ');
        const rows = rowsOf(await run(`SELECT ${sel} FROM ${L} AS l JOIN ${R} AS r ON ${on} WHERE ${diffCond} ORDER BY ${key.map((k) => `l.${q(k)}`).join(', ')} LIMIT ${sample}`, sample));
        out.samples.changed = rows.map((r) => ({
          key: Object.fromEntries(key.map((k) => [k, r[`k:${k}`]])),
          changes: valueCols.filter((x) => JSON.stringify(r[`l:${x}`]) !== JSON.stringify(r[`r:${x}`])).map((x) => ({ column: x, before: r[`l:${x}`], after: r[`r:${x}`] })),
        }));
      }
      out.sql.summary = summary;
      return out;
    } finally {
      for (const a of attached) await engine.runInternal(`DETACH ${a}`, 60_000).catch(() => undefined);
    }
  }

  /** The tables inside a backup, to compare one of them. */
  async backupTables(p: Principal, workspaceId: string, backupId: string): Promise<string[]> {
    const backup = (await this.ctx.lifecycle.listBackups(p, workspaceId)).find((b) => b.id === backupId);
    if (!backup || !fs.existsSync(backup.file)) throw badRequest('That backup is not available');
    const { engine } = await this.ctx.workspaces.engine(p, workspaceId);
    const alias = `__dv_bkl_${Date.now().toString(36)}`;
    await engine.runInternal(`ATTACH '${backup.file.replace(/'/g, "''")}' AS ${alias} (READ_ONLY)`, 60_000);
    try {
      const rows = await engine.runInternal(`SELECT schema_name, table_name FROM duckdb_tables() WHERE database_name = '${alias}' AND schema_name <> '__duckview' ORDER BY 1, 2`, 15_000);
      return rows.map((r) => (r.schema_name === 'main' ? String(r.table_name) : `${r.schema_name}.${r.table_name}`));
    } finally {
      await engine.runInternal(`DETACH ${alias}`, 60_000).catch(() => undefined);
    }
  }
}
