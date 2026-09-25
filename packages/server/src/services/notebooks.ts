/**
 * SQL notebooks: an ordered list of SQL, Markdown and input cells in a workspace.
 *
 *  - A SQL cell has a name (df1, orders_by_month); a later cell that mentions that name reads its result — the
 *    earlier cell is added as a CTE, recursively, so nothing is materialised and every run goes through the
 *    QueryService as the caller (SQL guard, access policies, cache, audit, and approval for agents that write).
 *  - An input cell is a variable: {{ region }} in a SQL cell becomes its value as a SQL literal (numbers as numbers,
 *    everything else quoted), never as raw SQL.
 *  - Outputs (the first notebooks.max_output_rows rows) are saved with the notebook when an editor runs a cell, so
 *    viewers and agents see results without re-running. Saves carry the version they started from; an older version
 *    is refused so two people editing never silently overwrite each other.
 */
import { desc, eq } from 'drizzle-orm';
import type { MetadataStore } from '../db/index.js';
import { NOTEBOOK_CELL_TYPES, type Notebook, type NotebookCell, type NotebookOutput } from '../db/schema/sqlite.js';
import { newId } from '../security/crypto.js';
import { analyzeSql } from '../engine/sql-guard.js';
import type { Principal } from './principal.js';
import { requireWrite } from './principal.js';
import type { WorkspaceService } from './workspaces.js';
import type { QueryService } from './query.js';
import type { AuditService } from './audit.js';
import { HitlBlocked } from './query.js';
import { HttpError, badRequest, notFound } from './errors.js';

export const MAX_OUTPUT_ROWS = 500;
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const qi = (s: string) => `"${s.replace(/"/g, '""')}"`;

export type NotebookSummary = Omit<Notebook, 'cells'> & { cell_count: number; sql_cells: number };

/** SQL with string literals, quoted identifiers and comments blanked out (same length), for finding names. */
function codeOnly(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"|--[^\n]*|\/\*[\s\S]*?\*\//g, (m) => ' '.repeat(m.length));
}

/** The names of other cells a SQL cell mentions (not as `x.name`, not inside strings or comments). */
export function referencedNames(sql: string, names: string[]): string[] {
  const code = codeOnly(sql);
  return names.filter((n) => new RegExp(`(^|[^.\\w"])${n}(?![\\w"])`, 'i').test(code));
}

/** {{ name }} → the input's value as a literal. */
export function substituteInputs(sql: string, inputs: Map<string, NonNullable<NotebookCell['input']>>): string {
  return sql.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (_m, name: string) => {
    const input = inputs.get(name.toLowerCase());
    if (!input) throw badRequest(`No input named ${name} — add an input cell called ${name}`);
    const v = input.value ?? '';
    if (input.kind === 'number') {
      if (v.trim() === '' || !Number.isFinite(Number(v))) throw badRequest(`Input ${name} is not a number (${JSON.stringify(v)})`);
      return String(Number(v));
    }
    if (input.kind === 'date') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw badRequest(`Input ${name} is not a date (YYYY-MM-DD)`);
      return `DATE '${v}'`;
    }
    return `'${v.replace(/'/g, "''")}'`;
  });
}

/**
 * The SQL a cell runs: its inputs substituted and the earlier SQL cells it mentions added as CTEs (in dependency
 * order). Only cells above it can be referenced, so there are no cycles.
 */
export function compileCell(cells: NotebookCell[], cellId: string): { sql: string; refs: string[] } {
  const index = cells.findIndex((c) => c.id === cellId);
  if (index < 0) throw notFound('Cell');
  const cell = cells[index]!;
  if (cell.type !== 'sql') throw badRequest('Only SQL cells run');
  const inputs = new Map(cells.filter((c) => c.type === 'input' && c.name && c.input).map((c) => [c.name!.toLowerCase(), c.input!]));
  const own = substituteInputs(cell.source, inputs).trim().replace(/;\s*$/, '');
  if (!own) throw badRequest('The cell is empty');
  const order: NotebookCell[] = [];
  const visit = (c: NotebookCell, at: number, sql: string) => {
    const above = cells.slice(0, at).filter((x) => x.type === 'sql' && x.name && NAME.test(x.name));
    for (const name of referencedNames(sql, above.map((x) => x.name!))) {
      const dep = [...above].reverse().find((x) => x.name!.toLowerCase() === name.toLowerCase())!;
      if (order.includes(dep)) continue;
      const depSql = substituteInputs(dep.source, inputs).trim().replace(/;\s*$/, '');
      const a = analyzeSql(depSql);
      if (a.statements.length !== 1 || a.isMutating) throw badRequest(`${dep.name} is not one read-only query, so other cells cannot read it`);
      visit(dep, cells.indexOf(dep), depSql);
      order.push(dep);
    }
  };
  visit(cell, index, own);
  if (!order.length) return { sql: own, refs: [] };
  const a = analyzeSql(own);
  if (a.statements.length !== 1 || a.isMutating) throw badRequest('A cell that reads other cells\' results must be one read-only query');
  const ctes = order.map((d) => {
    const s = substituteInputs(d.source, inputs).trim().replace(/;\s*$/, '');
    return `${qi(d.name!)} AS (\n${s}\n)`;
  });
  // A cell that starts with its own WITH gets the notebook's CTEs in front of its own.
  const w = stripWith(own);
  const sql = w.ctes ? `WITH ${ctes.join(',\n')},\n${w.body}` : `WITH ${ctes.join(',\n')}\n${own}`;
  return { sql, refs: order.map((d) => d.name!) };
}

/** `WITH a AS (…) SELECT …` → { ctes: true, body: `a AS (…) SELECT …` } (WITH RECURSIVE is left alone). */
function stripWith(sql: string): { ctes: boolean; body: string } {
  const m = /^\s*WITH\s+(?!RECURSIVE\b)/i.exec(sql);
  return m ? { ctes: true, body: sql.slice(m[0].length) } : { ctes: false, body: sql };
}

export class NotebookService {
  /** Version history (set by the context). */
  revisions: { record(actor: string | null | { userId: string; actorType: 'USER' | 'AGENT' | 'SYSTEM' }, workspaceId: string, type: 'notebook' | 'dashboard' | 'query' | 'semantic' | 'dbt', id: string, opts?: { message?: string | null }): Promise<unknown>; forget(type: 'notebook' | 'dashboard' | 'query' | 'semantic' | 'dbt', id: string): Promise<void> } | null = null;
  constructor(private readonly store: MetadataStore, private readonly workspaces: WorkspaceService, private readonly queries: QueryService, private readonly audit: AuditService) {}
  private get db() {
    return this.store.db;
  }
  private get s() {
    return this.store.schema;
  }

  /** Validates cells: types, unique names, inputs. Outputs are kept only when they come from the server. */
  private checkCells(input: Partial<NotebookCell>[], previous: NotebookCell[] = []): NotebookCell[] {
    if (input.length > 500) throw badRequest('A notebook holds at most 500 cells');
    const prev = new Map(previous.map((c) => [c.id, c]));
    const names = new Set<string>();
    const ids = new Set<string>();
    return input.map((c, i) => {
      const where = `Cell ${i + 1}`;
      if (!NOTEBOOK_CELL_TYPES.includes(c.type as NotebookCell['type'])) throw badRequest(`${where}: type must be sql, markdown or input`);
      let id = c.id && /^[\w-]{1,40}$/.test(c.id) ? c.id : newId().slice(0, 12);
      while (ids.has(id)) id = newId().slice(0, 12);
      ids.add(id);
      const source = String(c.source ?? '');
      if (source.length > 200_000) throw badRequest(`${where}: too long`);
      const out: NotebookCell = { id, type: c.type!, source };
      if (c.type === 'sql' || c.type === 'input') {
        const name = c.name?.trim() || (c.type === 'sql' ? `df${i + 1}` : '');
        if (!NAME.test(name)) throw badRequest(`${where}: the name "${name}" must be a plain identifier (letters, digits, _)`);
        if (names.has(name.toLowerCase())) throw badRequest(`${where}: another cell is already called ${name}`);
        names.add(name.toLowerCase());
        out.name = name;
      }
      if (c.type === 'input') {
        const kind = c.input?.kind ?? 'text';
        if (!['text', 'number', 'date', 'select'].includes(kind)) throw badRequest(`${where}: input kind must be text, number, date or select`);
        out.input = { kind, label: c.input?.label?.trim() || null, value: String(c.input?.value ?? ''), ...(kind === 'select' ? { options: (c.input?.options ?? []).map(String).slice(0, 200) } : {}) };
      }
      if (c.type === 'sql') {
        out.view = c.view === 'chart' ? 'chart' : 'table';
        out.chart = c.chart ?? null;
        // Outputs are the server's: the client may keep one (unchanged) but not invent one.
        const kept = prev.get(id)?.output ?? null;
        out.output = c.output === null ? null : kept;
      }
      return out;
    });
  }

  async list(p: Principal, workspaceId: string): Promise<NotebookSummary[]> {
    await this.workspaces.get(p, workspaceId);
    const rows = await this.db.select().from(this.s.notebooks).where(eq(this.s.notebooks.workspace_id, workspaceId)).orderBy(desc(this.s.notebooks.updated_at));
    return rows.map(({ cells, ...rest }) => ({ ...rest, cell_count: cells.length, sql_cells: cells.filter((c) => c.type === 'sql').length }));
  }

  async get(p: Principal, id: string, minRole: 'VIEWER' | 'EDITOR' = 'VIEWER'): Promise<Notebook> {
    const nb = (await this.db.select().from(this.s.notebooks).where(eq(this.s.notebooks.id, id)).limit(1))[0];
    if (!nb) throw notFound('Notebook');
    await this.workspaces.get(p, nb.workspace_id, minRole);
    return nb;
  }

  async create(p: Principal, workspaceId: string, input: { title?: string; cells?: Partial<NotebookCell>[] }): Promise<Notebook> {
    requireWrite(p);
    await this.workspaces.get(p, workspaceId, 'EDITOR');
    const now = new Date();
    const cells = this.checkCells(input.cells?.length ? input.cells : [{ type: 'markdown', source: '# Untitled notebook\n\nWhat is this analysis about?' }, { type: 'sql', name: 'df1', source: 'SELECT 42 AS answer' }]);
    const nb: Notebook = { id: newId(), workspace_id: workspaceId, user_id: p.userId, title: (input.title ?? '').trim().slice(0, 200) || 'Untitled notebook', cells, version: 1, updated_by: p.userId, created_at: now, updated_at: now };
    await this.db.insert(this.s.notebooks).values(nb);
    await this.revisions?.record(p, workspaceId, 'notebook', nb.id);
    this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'notebook.create', resource: `notebook:${nb.id}`, ip: p.ip });
    return nb;
  }

  /** Saves title and/or cells; `version` must be the one the editor started from. */
  async update(p: Principal, id: string, patch: { title?: string; cells?: Partial<NotebookCell>[]; version?: number }): Promise<Notebook> {
    requireWrite(p);
    const nb = await this.get(p, id, 'EDITOR');
    if (patch.version !== undefined && patch.version !== nb.version) {
      const who = nb.updated_by ? (await this.db.select({ email: this.s.users.email }).from(this.s.users).where(eq(this.s.users.id, nb.updated_by)).limit(1))[0]?.email : null;
      throw new HttpError(409, `${who ?? 'Someone'} saved this notebook after you opened it (version ${nb.version}, yours ${patch.version}). Reload to get their changes.`, 'CONFLICT', { version: nb.version, updated_by: who ?? null });
    }
    const set: Partial<Notebook> = { version: nb.version + 1, updated_by: p.userId, updated_at: new Date() };
    if (patch.title !== undefined) set.title = patch.title.trim().slice(0, 200) || nb.title;
    if (patch.cells !== undefined) set.cells = this.checkCells(patch.cells, nb.cells);
    await this.db.update(this.s.notebooks).set(set).where(eq(this.s.notebooks.id, id));
    await this.revisions?.record(p, nb.workspace_id, 'notebook', id);
    return { ...nb, ...set };
  }

  async remove(p: Principal, id: string): Promise<void> {
    requireWrite(p);
    await this.get(p, id, 'EDITOR');
    await this.db.delete(this.s.notebooks).where(eq(this.s.notebooks.id, id));
    await this.revisions?.forget('notebook', id);
    this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'notebook.delete', resource: `notebook:${id}`, ip: p.ip });
  }

  /** The SQL a cell would run (for "show compiled SQL" and agents). */
  async compile(p: Principal, id: string, cellId: string, cells?: Partial<NotebookCell>[]) {
    const nb = await this.get(p, id);
    return compileCell(cells ? this.checkCells(cells, nb.cells) : nb.cells, cellId);
  }

  /**
   * Runs one SQL cell (with the cells on screen when given) as the caller. Editors' outputs are saved with the
   * notebook (only that cell's output; the rest of the notebook is untouched). Errors become the cell's output.
   */
  async runCell(p: Principal, id: string, cellId: string, opts: { cells?: Partial<NotebookCell>[]; dryRun?: boolean } = {}): Promise<{ output: NotebookOutput; sql: string; refs: string[]; saved: boolean }> {
    const nb = await this.get(p, id);
    const cells = opts.cells ? this.checkCells(opts.cells, nb.cells) : nb.cells;
    let sql = '';
    let refs: string[] = [];
    let output: NotebookOutput;
    const t0 = Date.now();
    try {
      ({ sql, refs } = compileCell(cells, cellId));
      const r = await this.queries.run(p, nb.workspace_id, sql, { maxRows: MAX_OUTPUT_ROWS, countTotal: true, dryRun: opts.dryRun, cache: true });
      output = { columns: r.columns.map((c) => ({ name: c.name, type: c.type, kind: c.kind })), rows: r.rows.slice(0, MAX_OUTPUT_ROWS), row_count: r.totalRows ?? r.rowCount, truncated: r.truncated || (r.totalRows ?? r.rowCount) > MAX_OUTPUT_ROWS, duration_ms: r.durationMs, ran_at: new Date().toISOString(), ran_by: p.email, rows_changed: r.rowsChanged, error: null };
    } catch (err) {
      if (err instanceof HitlBlocked) throw err;
      output = { columns: [], rows: [], row_count: 0, truncated: false, duration_ms: Date.now() - t0, ran_at: new Date().toISOString(), ran_by: p.email, rows_changed: null, error: ((err as Error).message ?? String(err)).split('\n').slice(0, 3).join('\n').slice(0, 2000) };
    }
    const saved = await this.saveOutput(p, nb, cellId, output);
    return { output, sql, refs, saved };
  }

  private async saveOutput(p: Principal, nb: Notebook, cellId: string, output: NotebookOutput): Promise<boolean> {
    try {
      await this.workspaces.get(p, nb.workspace_id, 'EDITOR');
      if (!p.scopes.includes('write')) return false;
    } catch {
      return false;
    }
    // Re-read: another save may have happened while the query ran. Outputs do not bump the version.
    const cur = (await this.db.select().from(this.s.notebooks).where(eq(this.s.notebooks.id, nb.id)).limit(1))[0];
    if (!cur) return false;
    const cells = cur.cells.map((c) => (c.id === cellId ? { ...c, output } : c));
    if (!cells.some((c) => c.id === cellId)) return false;
    await this.db.update(this.s.notebooks).set({ cells }).where(eq(this.s.notebooks.id, nb.id));
    return true;
  }

  /** Runs every SQL cell top to bottom; stops at the first error. */
  async runAll(p: Principal, id: string, opts: { dryRun?: boolean } = {}): Promise<{ ran: number; failed: string | null; outputs: Record<string, NotebookOutput> }> {
    const nb = await this.get(p, id);
    const outputs: Record<string, NotebookOutput> = {};
    let ran = 0;
    for (const c of nb.cells.filter((x) => x.type === 'sql')) {
      const r = await this.runCell(p, id, c.id, { dryRun: opts.dryRun });
      outputs[c.id] = r.output;
      ran++;
      if (r.output.error) return { ran, failed: c.name ?? c.id, outputs };
    }
    this.audit.log({ userId: p.userId, actorType: p.actorType, action: 'notebook.run', resource: `notebook:${id}`, ip: p.ip });
    return { ran, failed: null, outputs };
  }

  /** The notebook as Markdown: text cells as they are, SQL in fences, outputs as tables (first rows). */
  async toMarkdown(p: Principal, id: string, maxRows = 20): Promise<string> {
    const nb = await this.get(p, id);
    const cell = (v: unknown) => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)).replace(/\|/g, '\\|').replace(/\n/g, ' ');
    const parts: string[] = [`<!-- DuckView notebook "${nb.title}" · exported ${new Date().toISOString()} -->`];
    const inputs = nb.cells.filter((c) => c.type === 'input');
    if (inputs.length) parts.push(inputs.map((c) => `- **${c.input?.label || c.name}** (\`{{ ${c.name} }}\`): ${c.input?.value || '—'}`).join('\n'));
    for (const c of nb.cells) {
      if (c.type === 'markdown') parts.push(c.source.trim());
      if (c.type !== 'sql') continue;
      parts.push(`\`\`\`sql\n-- ${c.name}\n${c.source.trim()}\n\`\`\``);
      const o = c.output;
      if (!o) continue;
      if (o.error) parts.push(`> Error: ${o.error.split('\n')[0]}`);
      else if (o.columns.length) {
        const head = `| ${o.columns.map((x) => cell(x.name)).join(' | ')} |\n|${o.columns.map(() => ' --- ').join('|')}|`;
        const body = o.rows.slice(0, maxRows).map((r) => `| ${r.map(cell).join(' | ')} |`).join('\n');
        parts.push(`${head}\n${body}${o.row_count > maxRows ? `\n\n_${o.row_count.toLocaleString('en-US')} rows; first ${maxRows} shown._` : ''}`);
      } else if (o.rows_changed != null) parts.push(`_${o.rows_changed} rows changed._`);
    }
    return parts.join('\n\n') + '\n';
  }

  /** For Copilot: the open notebook's cells, names, inputs and output columns. */
  async promptSummary(p: Principal, id: string): Promise<string> {
    const nb = await this.get(p, id);
    const lines = [`Notebook "${nb.title}" (later SQL cells can query an earlier cell's result by its name, e.g. SELECT * FROM df1; inputs are used as {{ name }}):`];
    for (const c of nb.cells) {
      if (c.type === 'markdown') lines.push(`- markdown: ${c.source.replace(/\s+/g, ' ').slice(0, 160)}`);
      else if (c.type === 'input') lines.push(`- input {{ ${c.name} }} (${c.input?.kind}) = ${JSON.stringify(c.input?.value ?? '')}`);
      else lines.push(`- sql cell ${c.name}: ${c.source.replace(/\s+/g, ' ').slice(0, 400)}${c.output ? c.output.error ? ` → ERROR ${c.output.error.split('\n')[0]}` : ` → ${c.output.row_count} rows (${c.output.columns.map((x) => `${x.name} ${x.type}`).join(', ')})` : ' (not run)'}`);
    }
    return lines.join('\n').slice(0, 8000);
  }
}
