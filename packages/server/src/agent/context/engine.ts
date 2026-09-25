/**
 * ContextEngine — decides what a model call is shown about a workspace.
 *
 *  discover  structured objects from the services the person can already read (as that person): tables and views
 *            with their columns and catalog notes, data files, semantic models and metrics, dbt projects, dashboards,
 *            notebooks, saved queries, quality suites, apps, recent insights, and the object on screen;
 *  select    ranking and packing through the Decision Engine, within the budget (objects, tokens, observations);
 *  render    the pack as compact prompt sections;
 *  refresh   discovery is cached per workspace and person, and dropped when the workspace's data changes (the data
 *            epoch on the live bus), when the agent itself changes something, or after a short time.
 *
 * Nothing here reads data around the services: every source goes through the same permission checks as the UI.
 */
import type { AppContext } from '../../context.js';
import type { Principal } from '../../services/principal.js';
import { liveEvents } from '../../observability/events.js';
import { logger } from '../../observability/logger.js';
import type { DecisionEngine, Intent, PageRef } from '../decision/types.js';
import type { ToolDescriptor } from '../registry.js';
import { estimateTokens, type ContextBudget, type ContextObject, type ContextPack, type SemanticContext } from './types.js';
import { terms } from '../decision/text.js';

const TTL_MS = 30_000;

export interface PackInput {
  request: string;
  intent?: Intent;
  page?: PageRef | null;
  /** Objects the caller brings: task observations, memory, a result on screen. */
  extra?: ContextObject[];
  /** Tools already chosen for this step (carried in the pack for telemetry and rendering). */
  tools?: ToolDescriptor[];
  budget?: Partial<ContextBudget>;
}

export function budgetFromConfig(cfg: AppContext['cfg']): ContextBudget {
  const b = cfg.agent.budget;
  return { maxObjects: b.max_objects, maxTokens: b.max_tokens, maxToolDefinitions: b.max_tool_definitions, maxObservations: b.max_observations, maxResultRows: b.max_result_rows };
}

export class ContextEngine {
  private readonly cache = new Map<string, { at: number; objects: ContextObject[] }>();
  private readonly unsubscribe: () => void;

  constructor(private readonly ctx: AppContext, private readonly decision: DecisionEngine) {
    this.unsubscribe = liveEvents.subscribe((e) => {
      if (e.type === 'workspace') this.invalidate(e.workspace_id);
    });
  }

  stop(): void {
    this.unsubscribe();
    this.cache.clear();
  }

  /** Drops what is known about a workspace (for everyone), so the next pack reads it again. */
  invalidate(workspaceId: string): void {
    for (const k of this.cache.keys()) if (k.startsWith(`${workspaceId}|`)) this.cache.delete(k);
  }

  /** Every object the person could be shown for this workspace (cached briefly). */
  async discover(p: Principal, workspaceId: string): Promise<ContextObject[]> {
    const key = `${workspaceId}|${p.userId}|${p.workspaceScope ?? ''}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.objects;
    // Membership first: the summaries below (dbt, insights) are per workspace, so access is checked here.
    await this.ctx.workspaces.get(p, workspaceId);
    const now = new Date().toISOString();
    const objects: ContextObject[] = [];
    const add = (o: Omit<ContextObject, 'workspaceId' | 'timestamp' | 'tokens'>) => objects.push({ ...o, workspaceId, timestamp: now, tokens: estimateTokens(o.text) });
    const c = this.ctx;
    const source = async (name: string, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (err) {
        logger().debug({ source: name, err: (err as Error).message }, 'Context source skipped');
      }
    };
    await Promise.all([
      source('catalog', async () => {
        for (const o of await c.lineage.catalog(p, workspaceId)) {
          if (o.schema === 'information_schema' || o.schema === 'pg_catalog' || o.name.startsWith('duckview_')) continue;
          const name = o.schema === 'main' ? o.name : `${o.schema}.${o.name}`;
          const columns = o.columns as { name: string; type: string; description: string | null; tags: string[] }[];
          const cols = columns.slice(0, 80).map((col) => `${col.name} ${col.type}${col.description ? ` — ${col.description}` : ''}${col.tags.length ? ` [${col.tags.join(', ')}]` : ''}`);
          const text = `${o.type === 'VIEW' ? 'view' : 'table'} ${name}${o.estimated_rows != null ? ` (~${o.estimated_rows.toLocaleString('en')} rows)` : ''}${o.description ? ` — ${o.description}` : ''}${o.tags.length ? ` [${o.tags.join(', ')}]` : ''}\n  columns: ${cols.join('; ')}${o.columns.length > 80 ? `; … ${o.columns.length - 80} more` : ''}`;
          add({ id: `table:${name}`, type: o.type === 'VIEW' ? 'view' : 'table', source: 'catalog', title: name, text, content: { name, columns: o.columns.map((col) => ({ name: col.name, type: col.type })) }, metadata: { rows: o.estimated_rows, tags: o.tags } });
        }
      }),
      source('files', async () => {
        const { files } = await c.queries.catalog(p, workspaceId);
        for (const f of files.slice(0, 300)) add({ id: `file:${f.path}`, type: 'file', source: 'storage', title: f.path, text: `file '${f.path}'`, content: { path: f.path }, metadata: {} });
      }),
      source('semantic', async () => {
        const s = await c.semantic.get(p, workspaceId);
        for (const m of s.metrics) {
          const how = m.type === 'simple' ? `measure ${m.measure}` : m.type === 'ratio' ? `${m.numerator} / ${m.denominator}` : `derived: ${m.expr}`;
          add({ id: `metric:${m.name}`, type: 'metric', source: 'semantic', title: m.label ?? m.name, text: `metric ${m.name}${m.label ? ` ("${m.label}")` : ''} — ${m.description ?? 'no description'}; ${m.type} (${how})${m.filter ? `, filter ${m.filter}` : ''}; group by: ${m.dimensions.slice(0, 25).join(', ') || 'none'}`, content: { name: m.name, label: m.label ?? null, description: m.description ?? null, type: m.type, dimensions: m.dimensions }, metadata: { boost: 1.2 } });
        }
        for (const sm of s.semantic_models) add({ id: `semantic_model:${sm.name}`, type: 'semantic_model', source: 'semantic', title: sm.label || sm.name, text: `semantic model ${sm.name} on ${sm.relation}${sm.description ? ` — ${sm.description}` : ''}; dimensions ${sm.dimensions.map((d) => d.name).join(', ')}; measures ${sm.measures.map((x) => x.name).join(', ')}`, content: { name: sm.name, relation: sm.relation }, metadata: {} });
      }),
      source('dbt', async () => {
        const summary = await c.dbt.promptSummary(workspaceId);
        for (const line of summary.split('\n').filter((l) => l.startsWith('- **'))) {
          const name = /\*\*(.+?)\*\*/.exec(line)?.[1] ?? 'dbt project';
          add({ id: `dbt_model:${name}`, type: 'dbt_model', source: 'dbt', title: name, text: `dbt project ${line.slice(2)}`, content: null, metadata: {} });
        }
      }),
      source('dashboards', async () => {
        for (const d of await c.dashboards.list(p, workspaceId)) add({ id: `dashboard:${d.id}`, type: 'dashboard', source: 'bi', title: d.name, text: `${d.kind === 'mosaic' ? 'Mosaic ' : ''}dashboard "${d.name}" (id ${d.id})${d.description ? ` — ${d.description}` : ''}`, content: { id: d.id, name: d.name, kind: d.kind }, metadata: {} });
      }),
      source('notebooks', async () => {
        for (const n of await c.notebooks.list(p, workspaceId)) add({ id: `notebook:${n.id}`, type: 'notebook', source: 'notebooks', title: n.title, text: `notebook "${n.title}" (id ${n.id}, ${n.cell_count} cells)`, content: { id: n.id, title: n.title }, metadata: {} });
      }),
      source('queries', async () => {
        for (const q of (await c.savedQueries.list(p, workspaceId)).slice(0, 200)) add({ id: `saved_query:${q.id}`, type: 'saved_query', source: 'bi', title: q.name, text: `saved query "${q.name}"${q.description ? ` — ${q.description}` : ''}: ${q.sql_text.replace(/\s+/g, ' ').slice(0, 300)}`, content: { id: q.id, name: q.name, sql: q.sql_text }, metadata: { tags: q.tags } });
      }),
      source('quality', async () => {
        for (const s of await c.quality.list(p, workspaceId)) add({ id: `quality_suite:${s.id}`, type: 'quality_suite', source: 'quality', title: s.name, text: `quality suite "${s.name}" on ${s.relation}: ${s.checks.length} checks, status ${s.status}`, content: { id: s.id, relation: s.relation, status: s.status }, metadata: { boost: s.status === 'fail' || s.status === 'warn' ? 1.3 : 1 } });
      }),
      source('apps', async () => {
        for (const a of await c.apps.list(p, workspaceId)) add({ id: `app:${a.id}`, type: 'app', source: 'apps', title: a.name, text: `data app "${a.name}" (${a.kind})${a.description ? ` — ${a.description}` : ''}`, content: { id: a.id, name: a.name }, metadata: {} });
      }),
      source('insights', async () => {
        const text = await c.insights.promptSummary(workspaceId);
        if (text) add({ id: 'insight:recent', type: 'insight', source: 'insights', title: 'recent unusual changes', text: `recent unusual metric changes:\n${text.slice(0, 1500)}`, content: null, metadata: {} });
      }),
    ]);
    this.cache.set(key, { at: Date.now(), objects });
    return objects;
  }

  /** The object on screen, described the way Copilot describes it. */
  async pageObject(p: Principal, workspaceId: string, page: PageRef): Promise<ContextObject> {
    const text = (await this.ctx.copilot.describePage?.(p, workspaceId, { kind: page.kind, id: page.id ?? null, label: page.label }).catch(() => null)) ?? `${page.kind} "${page.label}"`;
    return { id: `page:${page.kind}:${page.id ?? page.label}`, type: 'page', workspaceId, source: 'page', title: page.label, text: `on screen now: ${text}`.slice(0, 5000), content: page, metadata: {}, pinned: true, timestamp: new Date().toISOString(), tokens: estimateTokens(text) };
  }

  /** Ranked, budgeted context for one request. */
  async pack(p: Principal, workspaceId: string, input: PackInput): Promise<ContextPack> {
    const started = performance.now();
    const budget: ContextBudget = { ...budgetFromConfig(this.ctx.cfg), ...(input.budget ?? {}) };
    const discovered = await this.discover(p, workspaceId);
    const candidates = [...discovered, ...(input.extra ?? [])];
    const pinned: string[] = [];
    if (input.page) {
      const page = await this.pageObject(p, workspaceId, input.page);
      candidates.unshift(page);
      pinned.push(page.id);
      // The dataset on screen is the table of the same name.
      if (input.page.kind === 'dataset' && input.page.id) pinned.push(`table:${input.page.id}`);
      if (input.page.kind === 'dashboard' && input.page.id) pinned.push(`dashboard:${input.page.id}`);
    }
    const sel = await this.decision.selectContext({ request: input.request, candidates, budget, intent: input.intent, pinned });
    const semanticContext = semanticOf(input.request, discovered, sel.selected);
    return { request: input.request, objects: sel.selected, tools: (input.tools ?? []).slice(0, budget.maxToolDefinitions), semanticContext, budget, stats: { considered: sel.considered, selected: sel.selected.length, tokens: sel.tokens, dropped: sel.dropped, durationMs: Math.round(performance.now() - started) } };
  }
}

/** Metrics of the workspace, and whether one plausibly answers the request (then it must be preferred). */
function semanticOf(request: string, discovered: ContextObject[], selected: ContextObject[]): SemanticContext {
  const metricObjs = discovered.filter((o) => o.type === 'metric');
  const want = new Set(terms(request));
  const matched = metricObjs.filter((o) => {
    const m = o.content as { name: string; label: string | null };
    return [m.name, m.label ?? ''].some((n) => n && (terms(n).some((t) => want.has(t)) || request.toLowerCase().includes(n.toLowerCase())));
  });
  const selectedMetric = selected.some((o) => o.type === 'metric' && (o.relevance ?? 0) >= 0.3);
  return {
    metrics: metricObjs.map((o) => {
      const m = o.content as { name: string; label: string | null; description: string | null; type: string; dimensions: string[] };
      return { name: m.name, label: m.label, description: m.description, type: m.type, dimensions: m.dimensions, synonyms: [] };
    }),
    preferMetrics: matched.length > 0 || selectedMetric,
    matched: matched.map((o) => (o.content as { name: string }).name),
  };
}

const SECTION: Partial<Record<ContextObject['type'], string>> = {
  page: 'On screen now (what "this" and "it" mean)',
  selection: 'Selected by the person',
  metric: 'Metrics of the semantic layer (canonical definitions: query these, never re-derive them)',
  semantic_model: 'Semantic models',
  table: 'Tables and views',
  view: 'Tables and views',
  file: 'Data files',
  dbt_model: 'dbt projects',
  dashboard: 'Dashboards',
  notebook: 'Notebooks',
  saved_query: 'Saved queries',
  quality_suite: 'Data quality suites',
  app: 'Data apps',
  insight: 'Recent unusual changes',
  observation: 'What this task has found so far',
  memory: 'What earlier work in this workspace found',
  query_result: 'Result on screen',
  instruction: 'Instructions',
};

/** The pack as prompt sections, grouped by kind in a stable order. */
export function renderPack(pack: ContextPack): string {
  const groups = new Map<string, string[]>();
  for (const o of pack.objects) {
    const h = SECTION[o.type] ?? o.type;
    groups.set(h, [...(groups.get(h) ?? []), `- ${o.text}`]);
  }
  const order = Object.values(SECTION);
  const parts = ['## Workspace context (selected for this request)'];
  for (const h of [...new Set(order)].filter((x) => groups.has(x!)) as string[]) parts.push(`### ${h}\n${groups.get(h)!.join('\n')}`);
  for (const [h, lines] of groups) if (!order.includes(h)) parts.push(`### ${h}\n${lines.join('\n')}`);
  if (pack.semanticContext.preferMetrics) parts.push(`Metrics matching this request: ${pack.semanticContext.matched.join(', ') || 'see above'}. Answer with query_metrics on the defined metric rather than writing your own formula.`);
  if (pack.stats.dropped > 0) parts.push(`(${pack.stats.dropped} other objects of this workspace are not shown; search_catalog, search_workspace and list_accessible_data find them.)`);
  return parts.join('\n');
}
