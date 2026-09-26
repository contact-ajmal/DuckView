import { describe, it, expect } from 'vitest';
import { loadConfig } from '../config/index.js';
import { toolRegistry } from '../agent/registry.js';
import { DefaultDecisionEngine } from '../agent/decision/default.js';
import { DecisionEngineEvaluator, formatReport } from '../agent/decision/evaluator.js';
import { DECISION_FIXTURES } from '../agent/decision/fixtures.js';
import type { DecisionEngine } from '../agent/decision/types.js';

const cfg = loadConfig({ configPath: null, env: { DUCKVIEW_DATA_DIR: '/tmp/dv-eval', LOG_LEVEL: 'silent' } });
const tools = toolRegistry(cfg).descriptors();

describe('decision engine evaluation', () => {
  it('scores the default engine on realistic DuckView tasks', async () => {
    const r = await new DecisionEngineEvaluator(new DefaultDecisionEngine(), tools).run();
    expect(r.fixtures).toBe(DECISION_FIXTURES.length);
    expect(r.toolRecall).toBeGreaterThanOrEqual(0.95);
    expect(r.contextRecall).toBeGreaterThanOrEqual(0.9);
    expect(r.intentAccuracy).toBeGreaterThanOrEqual(0.9);
    expect(r.mrr).toBeGreaterThan(0.6);
    expect(r.avgToolsOffered).toBeLessThanOrEqual(12);
    expect(formatReport(r)).toMatch(/^Decision engine: default \(\d+ fixtures\)\n  tool recall \d+%/);
  });

  it('scores another engine the same way, without touching the runtime', async () => {
    const lazy: DecisionEngine = {
      name: 'lazy',
      selectContext: async (i) => ({ selected: [], considered: i.candidates.length, dropped: i.candidates.length, tokens: 0 }),
      selectTools: async (i) => ({ tools: [], scores: {}, considered: i.tools.length }),
      rankCandidates: async (i) => ({ ranked: i.candidates.map((c) => ({ id: c.id, score: 0 })) }),
      classify: async () => ({ intent: 'ask', confidence: 0, entities: [] }),
      route: async () => ({ route: 'agent', reason: '' }),
    };
    const r = await new DecisionEngineEvaluator(lazy, tools).run();
    expect(r).toMatchObject({ engine: 'lazy', toolRecall: 0, contextRecall: 0, mrr: 0 });
  });
});
