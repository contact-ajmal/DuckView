/**
 * The information architecture: eight sections in the sidebar, each with its pages. Every hash DuckView has ever
 * used still resolves (links in docs, notifications, agents and snapshots keep working); pages that used to be
 * top-level now live inside the section they belong to.
 */
import { House, Database, SquareTerminal, LayoutDashboard, AppWindow, Sparkles, Plug, Settings, type LucideIcon } from 'lucide-react';

export type Section = 'home' | 'data' | 'sql' | 'dashboards' | 'apps' | 'ai' | 'connections' | 'settings';
/** Which component renders the page. */
export type Page = 'home' | 'data' | 'query' | 'notebooks' | 'transform' | 'governance' | 'dashboards' | 'alerts' | 'apps' | 'mcp' | 'connections' | 'settings';

export const SECTIONS: { id: Section; label: string; hash: string; icon: LucideIcon; hint: string }[] = [
  { id: 'home', label: 'Home', hash: '#/', icon: House, hint: 'Recent work and workspace status' },
  { id: 'data', label: 'Data', hash: '#/data', icon: Database, hint: 'Datasets, models, metrics, quality, catalog and lineage' },
  { id: 'sql', label: 'SQL', hash: '#/query', icon: SquareTerminal, hint: 'The SQL workbench and notebooks' },
  { id: 'dashboards', label: 'Dashboards', hash: '#/dashboards', icon: LayoutDashboard, hint: 'Dashboards, alerts and scheduled snapshots' },
  { id: 'apps', label: 'Apps', hash: '#/apps', icon: AppWindow, hint: 'Data apps (Streamlit, Dash, Gradio)' },
  { id: 'ai', label: 'AI', hash: '#/mcp', icon: Sparkles, hint: 'Agents, MCP, activity and approvals' },
  { id: 'connections', label: 'Connections', hash: '#/connections', icon: Plug, hint: 'Storage, databases, warehouses, SaaS and lakehouses' },
  { id: 'settings', label: 'Settings', hash: '#/settings', icon: Settings, hint: 'Workspace, appearance, security and more' },
];

/** Secondary navigation inside a section (shown as tabs under the top bar). */
export const SUBPAGES: Partial<Record<Section, { id: string; label: string; hash: string }[]>> = {
  data: [
    { id: 'explorer', label: 'Explorer', hash: '#/data' },
    { id: 'dbt', label: 'Models', hash: '#/transform/dbt' },
    { id: 'metrics', label: 'Metrics', hash: '#/transform/metrics' },
    { id: 'quality', label: 'Quality', hash: '#/transform/quality' },
    { id: 'catalog', label: 'Catalog', hash: '#/governance/catalog' },
    { id: 'lineage', label: 'Lineage', hash: '#/governance/lineage' },
    { id: 'policies', label: 'Access policies', hash: '#/governance/policies' },
  ],
  sql: [
    { id: 'query', label: 'Workbench', hash: '#/query' },
    { id: 'notebooks', label: 'Notebooks', hash: '#/notebooks' },
  ],
  dashboards: [
    { id: 'dashboards', label: 'Dashboards', hash: '#/dashboards' },
    { id: 'alerts', label: 'Alerts', hash: '#/alerts/alerts' },
    { id: 'snapshots', label: 'Snapshots', hash: '#/alerts/snapshots' },
    { id: 'channels', label: 'Channels', hash: '#/alerts/channels' },
  ],
};

export interface Route {
  section: Section;
  page: Page;
  /** The active sub-page id when the section has sub navigation. */
  sub: string | null;
  /** Breadcrumb after the section, e.g. "Models". */
  crumb: string | null;
}

export function parseRoute(hash = location.hash): Route {
  const h = hash.replace(/^#\/?/, '');
  const seg = h.split(/[/?]/);
  const first = seg[0] ?? '';
  const second = seg[1] ?? '';
  const sub = (section: Section, id: string): Pick<Route, 'sub' | 'crumb'> => {
    const s = SUBPAGES[section]?.find((x) => x.id === id);
    return { sub: s?.id ?? null, crumb: s && s.id !== SUBPAGES[section]![0]!.id ? s.label : null };
  };
  if (first === 'data' || first === 'overview') return { section: 'data', page: 'data', ...sub('data', 'explorer') };
  if (first === 'query') return { section: 'sql', page: 'query', ...sub('sql', 'query') };
  if (first === 'notebooks') return { section: 'sql', page: 'notebooks', ...sub('sql', 'notebooks') };
  if (first === 'transform') return { section: 'data', page: 'transform', ...sub('data', second === 'metrics' || second === 'quality' ? second : 'dbt') };
  if (first === 'governance') {
    if (second === 'audit' || second === 'provisioning') return { section: 'settings', page: 'governance', sub: second, crumb: second === 'audit' ? 'Audit log' : 'Provisioning' };
    return { section: 'data', page: 'governance', ...sub('data', second || 'catalog') };
  }
  if (first === 'dashboards') return { section: 'dashboards', page: 'dashboards', ...sub('dashboards', 'dashboards') };
  if (first === 'alerts') return { section: 'dashboards', page: 'alerts', ...sub('dashboards', second || 'alerts') };
  if (first === 'apps') return { section: 'apps', page: 'apps', sub: null, crumb: null };
  if (first === 'mcp' || first === 'agents') return { section: 'ai', page: 'mcp', sub: null, crumb: null };
  if (first === 'connections') return { section: 'connections', page: 'connections', sub: null, crumb: null };
  if (first === 'settings') return { section: 'settings', page: 'settings', sub: null, crumb: null };
  return { section: 'home', page: 'home', sub: null, crumb: null };
}

export const sectionOf = (id: Section) => SECTIONS.find((s) => s.id === id)!;
