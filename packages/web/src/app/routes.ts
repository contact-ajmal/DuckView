/**
 * The information architecture (docs/design/information-architecture.md): five primary destinations — Agent,
 * Workspaces, Data, Build, Connect — and Settings at the foot of the rail. Every hash DuckView has ever used still
 * resolves (links in docs, notifications, agents and snapshots keep working); only the section a page belongs to and
 * its tabs changed. What the person can never use in the active workspace is hidden (`visibleSections`).
 */
import { Sparkles, Boxes, Database, Hammer, Plug, Settings, type LucideIcon } from 'lucide-react';

export type Section = 'agent' | 'workspaces' | 'data' | 'build' | 'connect' | 'settings';
/** Which component renders the page. */
export type Page = 'agent' | 'home' | 'data' | 'query' | 'notebooks' | 'transform' | 'governance' | 'dashboards' | 'alerts' | 'apps' | 'mcp' | 'connections' | 'settings' | 'templates' | 'workspace' | 'compare';

export interface SectionDef { id: Section; label: string; hash: string; icon: LucideIcon; hint: string }
export interface SubPage {
  id: string;
  label: string;
  hash: string;
  /** Hidden for people who can only read in the active workspace (viewers, read-only accounts). */
  write?: boolean;
  /** Tabs with a different group are set apart by a divider (Build: making things ┆ modelling data). */
  group?: number;
}

export const SECTIONS: SectionDef[] = [
  { id: 'agent', label: 'Agent', hash: '#/', icon: Sparkles, hint: 'Ask the agent, and pick up your missions' },
  { id: 'workspaces', label: 'Workspaces', hash: '#/home', icon: Boxes, hint: 'The workspace at a glance, and templates to start from' },
  { id: 'data', label: 'Data', hash: '#/data', icon: Database, hint: 'Explore, catalog, quality, lineage and access to your data' },
  { id: 'build', label: 'Build', hash: '#/query', icon: Hammer, hint: 'SQL, notebooks, dashboards, apps and alerts; models and metrics' },
  { id: 'connect', label: 'Connect', hash: '#/connections', icon: Plug, hint: 'Data sources, and the agents and tools that reach DuckView' },
  { id: 'settings', label: 'Settings', hash: '#/settings', icon: Settings, hint: 'Workspace, appearance, security and more' },
];

/** Secondary navigation inside a section (tabs under the top bar). */
export const SUBPAGES: Partial<Record<Section, SubPage[]>> = {
  workspaces: [
    { id: 'overview', label: 'Overview', hash: '#/home' },
    { id: 'templates', label: 'Templates', hash: '#/templates', write: true },
  ],
  data: [
    { id: 'explorer', label: 'Explorer', hash: '#/data' },
    { id: 'catalog', label: 'Catalog', hash: '#/governance/catalog' },
    { id: 'quality', label: 'Quality', hash: '#/transform/quality' },
    { id: 'lineage', label: 'Lineage', hash: '#/governance/lineage' },
    { id: 'compare', label: 'Compare', hash: '#/compare' },
    { id: 'policies', label: 'Access policies', hash: '#/governance/policies' },
  ],
  build: [
    { id: 'query', label: 'SQL', hash: '#/query' },
    { id: 'notebooks', label: 'Notebooks', hash: '#/notebooks' },
    { id: 'dashboards', label: 'Dashboards', hash: '#/dashboards' },
    { id: 'apps', label: 'Apps', hash: '#/apps' },
    { id: 'alerts', label: 'Alerts', hash: '#/alerts/alerts' },
    { id: 'prepare', label: 'Prepare', hash: '#/transform/prepare', write: true, group: 1 },
    { id: 'dbt', label: 'Models', hash: '#/transform/dbt', write: true, group: 1 },
    { id: 'metrics', label: 'Metrics', hash: '#/transform/metrics', group: 1 },
  ],
  connect: [
    { id: 'connections', label: 'Connections', hash: '#/connections', write: true },
    { id: 'agents', label: 'Agents & MCP', hash: '#/agents' },
  ],
};

/** What the navigation may show: `write` is false for viewers of the active workspace and read-only accounts. */
export interface NavAccess { write: boolean }

export const visibleSubpages = (section: Section, access: NavAccess): SubPage[] => (SUBPAGES[section] ?? []).filter((p) => access.write || !p.write);

/** The sections this person can use, each linking to its first tab they can open. */
export function visibleSections(access: NavAccess): SectionDef[] {
  return SECTIONS.flatMap((s) => {
    if (!SUBPAGES[s.id]) return [s];
    const pages = visibleSubpages(s.id, access);
    return pages.length ? [{ ...s, hash: pages[0]!.hash }] : [];
  });
}

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
  // The Agent Home is where DuckView opens; the workspace overview it replaced lives at #/home.
  if (first === 'home') return { section: 'workspaces', page: 'home', ...sub('workspaces', 'overview') };
  if (first === 'templates') return { section: 'workspaces', page: 'templates', ...sub('workspaces', 'templates') };
  if (first === 'workspaces') return { section: 'workspaces', page: 'workspace', sub: null, crumb: 'Manage' };
  if (first === 'agent') return { section: 'agent', page: 'agent', sub: null, crumb: null };
  if (first === 'data' || first === 'overview') return { section: 'data', page: 'data', ...sub('data', 'explorer') };
  if (first === 'compare') return { section: 'data', page: 'compare', ...sub('data', 'compare') };
  if (first === 'query') return { section: 'build', page: 'query', ...sub('build', 'query') };
  if (first === 'notebooks') return { section: 'build', page: 'notebooks', ...sub('build', 'notebooks') };
  if (first === 'transform') {
    if (second === 'quality') return { section: 'data', page: 'transform', ...sub('data', 'quality') };
    return { section: 'build', page: 'transform', ...sub('build', second === 'metrics' || second === 'prepare' ? second : 'dbt') };
  }
  if (first === 'governance') {
    if (second === 'audit' || second === 'provisioning') return { section: 'settings', page: 'governance', sub: second, crumb: second === 'audit' ? 'Audit log' : 'Provisioning' };
    return { section: 'data', page: 'governance', ...sub('data', second || 'catalog') };
  }
  if (first === 'dashboards') return { section: 'build', page: 'dashboards', ...sub('build', 'dashboards') };
  if (first === 'alerts') return { section: 'build', page: 'alerts', ...sub('build', 'alerts') };
  if (first === 'apps') return { section: 'build', page: 'apps', ...sub('build', 'apps') };
  if (first === 'mcp' || first === 'agents') return { section: 'connect', page: 'mcp', ...sub('connect', 'agents') };
  if (first === 'connections') return { section: 'connect', page: 'connections', ...sub('connect', 'connections') };
  if (first === 'settings') return { section: 'settings', page: 'settings', sub: null, crumb: null };
  return { section: 'agent', page: 'agent', sub: null, crumb: null };
}

export const sectionOf = (id: Section) => SECTIONS.find((s) => s.id === id)!;
