import { describe, it, expect } from 'vitest';
import { loadConfig } from '../config/index.js';
import { toolRegistry } from '../agent/registry.js';
import { DefaultDecisionEngine } from '../agent/decision/default.js';
import { createDecisionEngine, registerDecisionProvider, decisionProviders } from '../agent/decision/providers.js';
import { stem, terms, entityHints } from '../agent/decision/text.js';
import type { ContextObject } from '../agent/context/types.js';
import { DEFAULT_BUDGET } from '../agent/context/types.js';
import type { Principal } from '../services/principal.js';

const cfg = loadConfig({ configPath: null, env: { DUCKVIEW_DATA_DIR: '/tmp/dv-decision', LOG_LEVEL: 'silent' } });
const registry = toolRegistry(cfg);
const engine = new DefaultDecisionEngine();
const all = registry.descriptors();

async function toolsFor(request: string, max = 8) {
  const { intent } = await engine.classify({ request });
  return (await engine.selectTools({ request, tools: all, intent, max })).tools.map((t) => t.name);
}

const obj = (id: string, type: ContextObject['type'], title: string, text: string, extra: Partial<ContextObject> = {}): ContextObject => ({ id, type, workspaceId: 'w', source: 'test', title, text, content: null, metadata: {}, timestamp: new Date(0).toISOString(), ...extra });

describe('text', () => {
  it('stems, folds synonyms and finds names', () => {
    expect(['orders', 'categories', 'ordered', 'running', 'class'].map(stem)).toEqual(['order', 'category', 'order', 'runn', 'class']);
    expect(terms('Show me the sales graph for customers')).toEqual(['revenue', 'chart', 'customer']);
    expect(entityHints('Compare "Revenue overview" with customer_orders and main.orders')).toEqual(['Revenue overview', 'customer_orders', 'main.orders']);
  });
});

describe('classify and route', () => {
  it('reads the intent of typical requests', async () => {
    const cases: [string, string][] = [
      ['Why did revenue drop last month?', 'investigate'],
      ['Find anomalies in daily orders', 'investigate'],
      ['Create a quality check for null customer IDs', 'quality'],
      ['Build me an executive dashboard for churn', 'build'],
      ['Create a dbt model from this', 'transform'],
      ['Find the tables related to customer churn', 'discover'],
      ['Compare revenue by region', 'analyse'],
      ['Explain these columns', 'explain'],
      ['Turn this into a bar chart', 'modify'],
      ['Open the revenue dashboard', 'navigate'],
      ['Save this query', 'create'],
      ['How many orders do we have?', 'ask'],
    ];
    for (const [request, intent] of cases) expect([request, (await engine.classify({ request })).intent]).toEqual([request, intent]);
    expect((await engine.classify({ request: 'Profile this', page: { kind: 'dataset', id: 'orders', label: 'orders' } })).intent).toBe('analyse');
  });

  it('routes plain moves to a workspace action and the rest to the agent', async () => {
    const r = async (request: string) => engine.route({ request, classification: await engine.classify({ request }) });
    expect(await r('Open the revenue dashboard')).toMatchObject({ route: 'workspace_action', action: { action: 'open_dashboard', target: 'revenue' } });
    expect(await r('open table customer_orders')).toMatchObject({ route: 'workspace_action', action: { action: 'open_dataset', target: 'customer_orders' } });
    expect(await r('Go to the lineage')).toMatchObject({ route: 'workspace_action', action: { action: 'open_page', target: 'lineage' } });
    expect((await r('Open the revenue dashboard and add ARR to it')).route).toBe('agent');
    expect((await r('Why did revenue drop?')).route).toBe('agent');
  });
});

describe('tool selection', () => {
  it('offers the core tools and the right specialists, within the budget', async () => {
    const core = all.filter((t) => t.semantics.core).map((t) => t.name);
    expect(core.sort()).toEqual(['execute_query', 'inspect_schema', 'list_accessible_data', 'list_metrics', 'search_catalog', 'search_workspace']);
    const expectations: [string, string[]][] = [
      ['Create a quality check for null customer IDs', ['suggest_quality_checks', 'create_quality_suite']],
      ['Why did revenue drop last month?', ['detect_anomalies', 'query_metrics']],
      ['Build me an executive dashboard for churn', ['build_dashboard']],
      ['Find the tables related to customer churn', ['find_joins']],
      ['Create a dbt model from this', ['create_dbt_model']],
      ['Build a small data app for the sales team', ['create_app']],
      ['Create a notebook explaining this analysis', ['create_notebook']],
      ['Turn this into a bar chart', ['update_widget']],
      ['Export the result as parquet', ['save_dataset']],
      ['Use the semantic definition for ARR rather than calculating it yourself', ['query_metrics']],
      ['Find personal data in the customers table', ['scan_pii']],
    ];
    for (const [request, want] of expectations) {
      const got = await toolsFor(request, 12);
      expect(got.length).toBeLessThanOrEqual(12);
      for (const w of want) expect([request, got.includes(w)]).toEqual([request, true]);
      for (const c of core) expect(got).toContain(c);
    }
  });

  it('never offers a tool it was not given (permission filtering happens before), and keeps tools already used', async () => {
    const admin: Principal = { userId: 'u', email: 'u@x', role: 'USER', via: 'token', scopes: ['read'], actorType: 'AGENT' };
    const offered = registry.availableTo(admin).map((t) => registry.descriptor(t.name)!);
    const r = await engine.selectTools({ request: 'Build me a dashboard and publish the app', tools: offered, intent: 'build', max: 12, used: ['profile_dataset'] });
    expect(r.tools.map((t) => t.name)).not.toContain('build_dashboard');
    expect(r.tools.map((t) => t.name)).not.toContain('publish_app');
    expect(r.tools.map((t) => t.name)).toContain('profile_dataset');
    expect(r.considered).toBe(offered.length);
  });
});

describe('ranking and context selection', () => {
  it('ranks by the request, a whole name first', async () => {
    const r = await engine.rankCandidates({ query: 'player tracking data from the match', candidates: [
      { id: 'orders', fields: { title: 'orders', text: 'order_id customer_id amount region' } },
      { id: 'player_tracking', fields: { title: 'player_tracking', text: 'player_id x y speed timestamp match_id' } },
      { id: 'matches', fields: { title: 'matches', text: 'match_id venue date' } },
    ] });
    expect(r.ranked.map((x) => x.id)).toEqual(['player_tracking', 'matches', 'orders']);
    expect(r.ranked.at(-1)!.score).toBe(0);
  });

  it('keeps pinned objects, respects the object, token and observation budgets, and scores relevance', async () => {
    const candidates = [
      obj('page:dash', 'page', 'Churn overview', 'Dashboard on screen', { pinned: true }),
      obj('table:customer_orders', 'table', 'customer_orders', 'customer_orders: customer_id, order_date, revenue, region'),
      obj('table:inventory', 'table', 'inventory', 'inventory: sku, warehouse, stock'),
      obj('metric:revenue', 'metric', 'revenue', 'Metric revenue: sum(revenue) from customer_orders'),
      obj('table:huge', 'table', 'revenue_everything', `revenue ${'x '.repeat(20_000)}`),
      obj('obs:1', 'observation', 'seen', 'revenue by region was queried'),
      obj('obs:2', 'observation', 'seen', 'revenue metric exists'),
    ];
    const r = await engine.selectContext({ request: 'Revenue by region', candidates, budget: { ...DEFAULT_BUDGET, maxObjects: 5, maxTokens: 400, maxObservations: 1 } });
    const ids = r.selected.map((c) => c.id);
    expect(ids[0]).toBe('page:dash');
    expect(ids).toContain('metric:revenue');
    expect(ids).toContain('table:customer_orders');
    expect(ids).not.toContain('table:huge');
    expect(ids).not.toContain('table:inventory');
    expect(ids.filter((i) => i.startsWith('obs:')).length).toBe(1);
    expect(r.tokens).toBeLessThanOrEqual(400);
    expect(r.selected[0]!.relevance).toBe(1);
    expect(r.considered).toBe(7);
  });
});

describe('providers', () => {
  it('builds the configured engine, registers others, and falls back to the default for an unknown name', () => {
    expect(createDecisionEngine(cfg).name).toBe('default');
    registerDecisionProvider('test-engine', () => Object.assign(new DefaultDecisionEngine(), { name: 'test-engine' }));
    expect(decisionProviders()).toContain('test-engine');
    expect(createDecisionEngine({ ...cfg, agent: { ...cfg.agent, decision: { provider: 'test-engine' } } }).name).toBe('test-engine');
    expect(createDecisionEngine({ ...cfg, agent: { ...cfg.agent, decision: { provider: 'nope' } } }).name).toBe('default');
  });
});
