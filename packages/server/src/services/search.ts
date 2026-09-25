/**
 * One search across a workspace: tables and views (by name, description or tag), their columns, data files,
 * saved queries (their SQL too), dashboards (and their widgets' SQL), notebooks (and their cells), metrics and
 * apps. Every word must appear; a match in the name ranks above one in a description, which ranks above one in
 * the content. Used by ⌘K and the search_workspace agent tool.
 */
import { eq, inArray } from 'drizzle-orm';
import type { MetadataStore } from '../db/index.js';
import type { AppContext } from '../context.js';
import type { Principal } from './principal.js';
import { logger } from '../observability/logger.js';

export type SearchKind = 'table' | 'column' | 'file' | 'query' | 'dashboard' | 'notebook' | 'metric' | 'app';
export interface SearchHit {
  kind: SearchKind;
  id: string;
  title: string;
  /** Where it lives or what it is: "orders · BIGINT", "in Sales", "3 widgets". */
  subtitle: string | null;
  /** Which part matched. */
  match: 'name' | 'description' | 'content';
  /** A few words around the match in descriptions or content. */
  snippet: string | null;
  score: number;
}

const WEIGHT = { name: 3, description: 2, content: 1 } as const;

function snippetOf(text: string, word: string): string {
  const flat = text.replace(/\s+/g, ' ');
  const i = flat.toLowerCase().indexOf(word);
  if (i < 0) return flat.slice(0, 80);
  const start = Math.max(0, i - 30);
  return `${start > 0 ? '…' : ''}${flat.slice(start, i + word.length + 50)}${i + word.length + 50 < flat.length ? '…' : ''}`;
}

export class SearchService {
  private ctx!: AppContext;
  constructor(private readonly store: MetadataStore) {}
  bind(ctx: AppContext) {
    this.ctx = ctx;
  }

  async search(p: Principal, workspaceId: string, query: string, opts: { limit?: number; kinds?: SearchKind[] } = {}): Promise<SearchHit[]> {
    const c = this.ctx;
    await c.workspaces.get(p, workspaceId);
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    const want = (k: SearchKind) => !opts.kinds?.length || opts.kinds.includes(k);
    const hits: SearchHit[] = [];
    /** Scores one object: every word must appear somewhere; the best field that holds the first word wins. */
    const add = (kind: SearchKind, id: string, title: string, subtitle: string | null, fields: { name: string; description?: string | null; content?: string | null }) => {
      const name = fields.name.toLowerCase();
      const desc = (fields.description ?? '').toLowerCase();
      const content = (fields.content ?? '').toLowerCase();
      if (!words.every((w) => name.includes(w) || desc.includes(w) || content.includes(w))) return;
      const w0 = words[0]!;
      const match: SearchHit['match'] = words.every((w) => name.includes(w)) ? 'name' : desc.includes(w0) || words.every((w) => name.includes(w) || desc.includes(w)) ? 'description' : 'content';
      let score = WEIGHT[match] * 10;
      if (name === query.toLowerCase()) score += 20;
      else if (name.startsWith(w0)) score += 5;
      if (kind === 'table' || kind === 'metric') score += 2; // the things people search for most
      const snippet = match === 'name' ? null : snippetOf(match === 'description' ? fields.description ?? '' : fields.content ?? '', words.find((w) => (match === 'description' ? desc : content).includes(w)) ?? w0);
      hits.push({ kind, id, title, subtitle, match, snippet, score });
    };
    const safely = async (label: string, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (err) {
        logger().debug({ err: (err as Error).message, part: label }, 'Search: part skipped');
      }
    };

    await Promise.all([
      safely('catalog', async () => {
        if (!want('table') && !want('column')) return;
        for (const o of await c.lineage.catalog(p, workspaceId)) {
          if (o.schema === 'information_schema' || o.schema === 'pg_catalog') continue;
          const full = o.schema === 'main' ? o.name : `${o.schema}.${o.name}`;
          if (want('table')) add('table', full, full, `${o.type === 'VIEW' ? 'view' : 'table'} · ${o.columns.length} columns${o.estimated_rows != null ? ` · ~${o.estimated_rows.toLocaleString()} rows` : ''}`, { name: full, description: [o.description, ...o.tags].filter(Boolean).join(' ') });
          if (want('column')) for (const col of o.columns) add('column', `${full}.${col.name}`, col.name, `${full} · ${col.type.toLowerCase()}`, { name: col.name, description: [col.description, ...col.tags].filter(Boolean).join(' ') });
        }
      }),
      safely('files', async () => {
        if (!want('file')) return;
        for (const f of (await c.workspaces.listAllFiles(p, workspaceId)).files) {
          const display = f.root ? f.path.slice(f.root.length + 1) : f.path;
          add('file', f.path, display, f.kind, { name: display });
        }
      }),
      safely('queries', async () => {
        if (!want('query')) return;
        for (const q of await c.savedQueries.list(p, workspaceId)) add('query', q.id, q.name, q.folder || null, { name: q.name, description: [q.description, ...q.tags].filter(Boolean).join(' '), content: q.sql_text });
      }),
      safely('dashboards', async () => {
        if (!want('dashboard')) return;
        const list = await c.dashboards.list(p, workspaceId);
        const s = this.store.schema;
        const widgets = list.length ? await this.store.db.select({ dashboard_id: s.dashboardWidgets.dashboard_id, title: s.dashboardWidgets.title, sql: s.dashboardWidgets.custom_sql }).from(s.dashboardWidgets).where(inArray(s.dashboardWidgets.dashboard_id, list.map((d) => d.id))) : [];
        for (const d of list) {
          const mine = widgets.filter((w) => w.dashboard_id === d.id);
          add('dashboard', d.id, d.name, d.kind === 'mosaic' ? 'Mosaic dashboard' : `${mine.length} widget${mine.length === 1 ? '' : 's'}`, { name: d.name, description: [d.description, ...mine.map((w) => w.title)].filter(Boolean).join(' · '), content: [...mine.map((w) => w.sql ?? ''), d.spec ? JSON.stringify(d.spec) : ''].join('\n') });
        }
      }),
      safely('notebooks', async () => {
        if (!want('notebook')) return;
        await c.workspaces.get(p, workspaceId);
        const s = this.store.schema;
        const rows = await this.store.db.select({ id: s.notebooks.id, title: s.notebooks.title, cells: s.notebooks.cells }).from(s.notebooks).where(eq(s.notebooks.workspace_id, workspaceId));
        for (const n of rows) {
          const cells = (n.cells ?? []) as { source?: string }[];
          add('notebook', n.id, n.title, `${cells.length} cell${cells.length === 1 ? '' : 's'}`, { name: n.title, content: cells.map((cell) => cell.source ?? '').join('\n') });
        }
      }),
      safely('metrics', async () => {
        if (!want('metric')) return;
        const def = await c.semantic.definition(workspaceId);
        for (const m of def.metrics) add('metric', m.name, m.label || m.name, `metric · ${m.type}`, { name: `${m.name} ${m.label ?? ''}`, description: m.description ?? '' });
      }),
      safely('apps', async () => {
        if (!want('app')) return;
        for (const a of await c.apps.list(p, workspaceId)) add('app', a.id, a.name, `${a.kind} app`, { name: a.name, description: a.description ?? '' });
      }),
    ]);
    hits.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
    return hits.slice(0, opts.limit ?? 50);
  }
}
