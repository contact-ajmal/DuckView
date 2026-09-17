import { create } from 'zustand';

export type LayoutPage = 'query' | 'overview' | 'settings' | 'mcp';

export interface LayoutComponent {
  id: string;
  label: string;
  page: LayoutPage;
  description: string;
}

/** Every hideable region in the UI. Hidden ids are persisted; the Layout menu and Settings restore them. */
export const LAYOUT_COMPONENTS: LayoutComponent[] = [
  { id: 'query.header', page: 'query', label: 'Page header', description: 'Title row with Import/Export and the Copilot toggle' },
  { id: 'query.sidebar', page: 'query', label: 'Side bar', description: 'Explorer, tables, saved queries and history' },
  { id: 'query.explorer', page: 'query', label: 'Explorer section', description: 'Local folders and cloud storage tree' },
  { id: 'query.tables', page: 'query', label: 'Tables & views section', description: 'Click-to-insert schema tree' },
  { id: 'query.saved', page: 'query', label: 'Saved queries section', description: 'Your saved query library' },
  { id: 'query.history', page: 'query', label: 'History section', description: 'Recently executed queries' },
  { id: 'query.results', page: 'query', label: 'Results pane', description: 'Table, schema, chart, plan and profile views' },
  { id: 'query.toolbar', page: 'query', label: 'Editor toolbar', description: 'Run / Save / row limit / copy row under the editor' },
  { id: 'query.columns', page: 'query', label: 'Column type strip', description: 'Column names and types under the results' },
  { id: 'overview.sidebar', page: 'overview', label: 'Datasets side bar', description: 'Drop zone, folders and the dataset list' },
  { id: 'overview.kpis', page: 'overview', label: 'KPI cards', description: 'Rows, columns, data quality' },
  { id: 'overview.schema', page: 'overview', label: 'Schema table', description: 'Column types, null ratios, min/max' },
  { id: 'overview.distributions', page: 'overview', label: 'Distributions', description: 'Histograms and top values per column' },
  { id: 'overview.sample', page: 'overview', label: 'Sample rows', description: 'First rows of the dataset' },
  { id: 'settings.resources', page: 'settings', label: 'Resource cards', description: 'Live resources and detected hardware (Hardware)' },
  { id: 'settings.gauges', page: 'settings', label: 'Hardware gauges', description: 'RAM, DuckDB memory, CPU and scratch meters' },
  { id: 'settings.machine', page: 'settings', label: 'Machine summary', description: 'This machine · engine ceiling · bigger than RAM' },
  { id: 'settings.engines', page: 'settings', label: 'Warm engines', description: 'Per-workspace DuckDB instances' },
  { id: 'mcp.stats', page: 'mcp', label: 'Stats row', description: 'Sessions, tokens, activity, safety' },
  { id: 'mcp.connect', page: 'mcp', label: 'Connect a client', description: 'Claude Desktop / Cursor / Claude Code snippets' },
  { id: 'mcp.inspector', page: 'mcp', label: 'Live inspector', description: 'Real-time agent activity' },
  { id: 'mcp.tokens', page: 'mcp', label: 'API tokens', description: 'Token list' },
  { id: 'mcp.sessions', page: 'mcp', label: 'Live MCP sessions', description: 'Connected agents' },
];

export const PAGE_LABELS: Record<LayoutPage, string> = { query: 'Query', overview: 'Overview', settings: 'Settings', mcp: 'MCP hub' };

const KEY = 'duckview.layout.hidden';
function load(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, boolean>;
  } catch {
    return {};
  }
}
function save(h: Record<string, boolean>) {
  try {
    localStorage.setItem(KEY, JSON.stringify(h));
  } catch {
    /* ignore */
  }
}

interface LayoutState {
  hidden: Record<string, boolean>;
  isHidden(id: string): boolean;
  hide(id: string): void;
  show(id: string): void;
  toggle(id: string): void;
  reset(page?: LayoutPage): void;
  hiddenCount(page?: LayoutPage): number;
}

export const useLayout = create<LayoutState>((set, get) => ({
  hidden: load(),
  isHidden: (id) => !!get().hidden[id],
  hide: (id) => {
    const hidden = { ...get().hidden, [id]: true };
    save(hidden);
    set({ hidden });
  },
  show: (id) => {
    const hidden = { ...get().hidden };
    delete hidden[id];
    save(hidden);
    set({ hidden });
  },
  toggle: (id) => (get().hidden[id] ? get().show(id) : get().hide(id)),
  reset: (page) => {
    const hidden = page ? Object.fromEntries(Object.entries(get().hidden).filter(([id]) => !id.startsWith(`${page}.`))) : {};
    save(hidden);
    set({ hidden });
  },
  hiddenCount: (page) => LAYOUT_COMPONENTS.filter((c) => (!page || c.page === page) && get().hidden[c.id]).length,
}));
