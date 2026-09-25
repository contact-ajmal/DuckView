/**
 * Workspace actions: moves in the person's workspace, not operations on data. "Open the revenue dashboard", "show me
 * the orders table", "open this SQL in a tab". The runtime resolves the target to a real object the person can see
 * and emits it (agent.workspace.changed); the UI performs it. External callers get the same action back, with a link.
 *
 * The model reaches them through one runtime tool, open_in_workspace; plain navigation requests never reach the
 * model at all (the Decision Engine routes them straight here).
 */
import type { AppContext } from '../../context.js';
import type { Principal } from '../../services/principal.js';
import type { AgentWorkspaceAction } from '../../db/schema/sqlite.js';
import type { DecisionEngine } from '../decision/types.js';
import type { ToolDescriptor } from '../registry.js';

export const WORKSPACE_ACTIONS = ['open_dataset', 'open_dashboard', 'open_notebook', 'open_app', 'open_query', 'open_page'] as const;
export type WorkspaceActionName = (typeof WORKSPACE_ACTIONS)[number];

const PAGES: Record<string, { href: string; label: string }> = {
  home: { href: '#/', label: 'Home' },
  sql: { href: '#/query', label: 'SQL workbench' },
  workbench: { href: '#/query', label: 'SQL workbench' },
  'query editor': { href: '#/query', label: 'SQL workbench' },
  explorer: { href: '#/data', label: 'Data explorer' },
  catalog: { href: '#/governance/catalog', label: 'Catalog' },
  lineage: { href: '#/governance/lineage', label: 'Lineage' },
  metrics: { href: '#/transform/metrics', label: 'Metrics' },
  quality: { href: '#/transform/quality', label: 'Data quality' },
  models: { href: '#/transform/dbt', label: 'Models' },
  compare: { href: '#/compare', label: 'Compare' },
  prepare: { href: '#/transform/prepare', label: 'Prepare' },
  settings: { href: '#/settings', label: 'Settings' },
  dashboards: { href: '#/dashboards', label: 'Dashboards' },
  notebooks: { href: '#/notebooks', label: 'Notebooks' },
};

/** The runtime tool the model moves the workspace with (not in the MCP registry: it only means something here). */
export const OPEN_IN_WORKSPACE: ToolDescriptor = {
  name: 'open_in_workspace',
  title: 'Open in the workspace',
  summary: 'Opens something in the person\'s workspace: a dataset, a dashboard, a notebook, a data app, a SQL query in a new tab, or a page.',
  description: 'Opens something in the person\'s workspace so they see it: action open_dataset (target: table name), open_dashboard / open_notebook / open_app (target: name or id), open_query (sql, title: a new SQL tab), open_page (target: sql, catalog, lineage, metrics, quality, models, explorer, compare, prepare, dashboards, notebooks, settings, home). It changes no data.',
  annotations: { readOnlyHint: true },
  semantics: { category: 'workspace', action: 'READ', mutation: 'none', capabilities: ['navigate', 'workspace'], requires: ['workspace'], produces: ['workspace_action'], keywords: ['open', 'show', 'go to', 'navigate', 'tab'], core: false },
  inputSchema: { type: 'object', properties: { action: { type: 'string', enum: [...WORKSPACE_ACTIONS] }, target: { type: 'string' }, sql: { type: 'string' }, title: { type: 'string' } }, required: ['action'] },
};

export interface ResolvedAction {
  action: AgentWorkspaceAction;
  /** "Opened the dashboard Revenue overview." */
  message: string;
}

/**
 * Finds what an action points at, among what the person can see. Returns null (with a reason) when there is nothing
 * of that name — the caller tells the model or the person.
 */
export async function resolveAction(ctx: AppContext, decision: DecisionEngine, p: Principal, workspaceId: string, req: { action: string; target?: string | null; args?: Record<string, unknown> }): Promise<ResolvedAction | { error: string }> {
  const target = (req.target ?? '').trim();
  const best = async (items: { id: string; name: string }[]) => {
    const exact = items.find((i) => i.id === target || i.name.toLowerCase() === target.toLowerCase());
    if (exact) return exact;
    if (!target) return null;
    const { ranked } = await decision.rankCandidates({ query: target, candidates: items.map((i) => ({ id: i.id, fields: { title: i.name } })) });
    return ranked[0] && ranked[0].score > 0 ? items.find((i) => i.id === ranked[0]!.id)! : null;
  };
  switch (req.action) {
    case 'open_dashboard': {
      const d = await best((await ctx.dashboards.list(p, workspaceId)).map((x) => ({ id: x.id, name: x.name })));
      return d ? { action: { action: 'open_dashboard', target: d.id, href: `#/dashboards/${d.id}`, args: { name: d.name } }, message: `Opened the dashboard ${d.name}.` } : { error: `No dashboard called "${target}" in this workspace.` };
    }
    case 'open_notebook': {
      const n = await best((await ctx.notebooks.list(p, workspaceId)).map((x) => ({ id: x.id, name: x.title })));
      return n ? { action: { action: 'open_notebook', target: n.id, href: `#/notebooks/${n.id}`, args: { name: n.name } }, message: `Opened the notebook ${n.name}.` } : { error: `No notebook called "${target}" in this workspace.` };
    }
    case 'open_app': {
      const a = await best((await ctx.apps.list(p, workspaceId)).map((x) => ({ id: x.id, name: x.name })));
      return a ? { action: { action: 'open_app', target: a.id, href: `#/apps/${a.id}`, args: { name: a.name } }, message: `Opened the data app ${a.name}.` } : { error: `No data app called "${target}" in this workspace.` };
    }
    case 'open_dataset': {
      const objs = (await ctx.lineage.catalog(p, workspaceId)).map((o) => (o.schema === 'main' ? o.name : `${o.schema}.${o.name}`));
      const t = await best(objs.map((n) => ({ id: n, name: n })));
      return t ? { action: { action: 'open_dataset', target: t.id, href: `#/data?table=${encodeURIComponent(t.id)}`, args: { name: t.name } }, message: `Opened ${t.name} in the data explorer.` } : { error: `No table or view called "${target}" in this workspace.` };
    }
    case 'open_query': {
      const sql = String(req.args?.sql ?? '').trim();
      if (!sql) return { error: 'open_query needs the sql to put in the tab.' };
      const title = String(req.args?.title ?? 'Agent query').slice(0, 80);
      return { action: { action: 'open_query', target: null, href: '#/query', args: { sql, title } }, message: `Opened the SQL in a new tab "${title}".` };
    }
    case 'open_page': {
      const page = PAGES[target.toLowerCase()] ?? PAGES[target.toLowerCase().replace(/^the\s+/, '')];
      return page ? { action: { action: 'open_page', target: target.toLowerCase(), href: page.href, args: { label: page.label } }, message: `Opened ${page.label}.` } : { error: `There is no page called "${target}". Pages: ${Object.keys(PAGES).join(', ')}.` };
    }
    default:
      return { error: `Unknown workspace action ${req.action}. Use one of ${WORKSPACE_ACTIONS.join(', ')}.` };
  }
}
