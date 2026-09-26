/**
 * DecisionEngineEvaluator — scores any Decision Engine on the same fixtures, so engines can be compared (and a new
 * one checked) without touching the runtime:
 *   tool selection     recall (every required group satisfied), precision of the non-core picks, tools offered
 *   context selection  recall of the required objects within the budget
 *   ranking            mean reciprocal rank of the first required object
 *   classification     intent accuracy, where a fixture states one
 * plus the engine's own latency. `duckview agent-eval` prints the report.
 */
import type { ContextBudget } from '../context/types.js';
import { DEFAULT_BUDGET } from '../context/types.js';
import type { ToolDescriptor } from '../registry.js';
import type { DecisionEngine } from './types.js';
import { DECISION_FIXTURES, EVAL_CATALOG, type DecisionFixture } from './fixtures.js';

export interface FixtureScore {
  request: string;
  toolsOk: boolean;
  missingTools: string[][];
  toolsOffered: number;
  contextOk: boolean | null;
  missingContext: string[][];
  reciprocalRank: number | null;
  intent: string;
  intentOk: boolean | null;
  ms: number;
}

export interface EvaluationReport {
  engine: string;
  fixtures: number;
  toolRecall: number;
  toolPrecision: number;
  avgToolsOffered: number;
  contextRecall: number;
  mrr: number;
  intentAccuracy: number;
  avgDecisionMs: number;
  scores: FixtureScore[];
}

const round = (n: number) => Math.round(n * 1000) / 1000;

export class DecisionEngineEvaluator {
  constructor(private readonly engine: DecisionEngine, private readonly tools: ToolDescriptor[], private readonly opts: { maxTools?: number; budget?: ContextBudget } = {}) {}

  async evaluateToolSelection(f: DecisionFixture) {
    const { intent } = await this.engine.classify({ request: f.request, page: f.page });
    const r = await this.engine.selectTools({ request: f.request, tools: this.tools, intent: f.intent ?? intent, max: this.opts.maxTools ?? DEFAULT_BUDGET.maxToolDefinitions });
    const names = new Set(r.tools.map((t) => t.name));
    const missing = f.tools.filter((group) => !group.some((n) => names.has(n)));
    const wanted = new Set(f.tools.flat());
    const specialists = r.tools.filter((t) => !t.semantics.core);
    const precision = specialists.length ? specialists.filter((t) => wanted.has(t.name)).length / specialists.length : 0;
    return { ok: missing.length === 0, missing, offered: r.tools.length, precision, intent };
  }

  async evaluateContextSelection(f: DecisionFixture) {
    if (!f.context?.length) return null;
    const r = await this.engine.selectContext({ request: f.request, candidates: EVAL_CATALOG, budget: this.opts.budget ?? { ...DEFAULT_BUDGET, maxObjects: 8 } });
    const ids = new Set(r.selected.map((o) => o.id));
    const missing = f.context.filter((group) => !group.some((id) => ids.has(id)));
    return { ok: missing.length === 0, missing };
  }

  async evaluateRanking(f: DecisionFixture) {
    if (!f.context?.length) return null;
    const { ranked } = await this.engine.rankCandidates({ query: f.request, candidates: EVAL_CATALOG.map((o) => ({ id: o.id, fields: { title: o.title, type: o.type, text: o.text } })) });
    const wanted = new Set(f.context.flat());
    const i = ranked.findIndex((r) => wanted.has(r.id) && r.score > 0);
    return i < 0 ? 0 : 1 / (i + 1);
  }

  async run(fixtures: DecisionFixture[] = DECISION_FIXTURES): Promise<EvaluationReport> {
    const scores: FixtureScore[] = [];
    let precision = 0;
    for (const f of fixtures) {
      const t0 = performance.now();
      const tools = await this.evaluateToolSelection(f);
      const context = await this.evaluateContextSelection(f);
      const rr = await this.evaluateRanking(f);
      precision += tools.precision;
      scores.push({ request: f.request, toolsOk: tools.ok, missingTools: tools.missing, toolsOffered: tools.offered, contextOk: context ? context.ok : null, missingContext: context?.missing ?? [], reciprocalRank: rr, intent: tools.intent, intentOk: f.intent ? f.intent === tools.intent : null, ms: Math.round((performance.now() - t0) * 100) / 100 });
    }
    const withContext = scores.filter((s) => s.contextOk !== null);
    const withIntent = scores.filter((s) => s.intentOk !== null);
    return {
      engine: this.engine.name,
      fixtures: scores.length,
      toolRecall: round(scores.filter((s) => s.toolsOk).length / scores.length),
      toolPrecision: round(precision / scores.length),
      avgToolsOffered: round(scores.reduce((a, s) => a + s.toolsOffered, 0) / scores.length),
      contextRecall: round(withContext.filter((s) => s.contextOk).length / (withContext.length || 1)),
      mrr: round(withContext.reduce((a, s) => a + (s.reciprocalRank ?? 0), 0) / (withContext.length || 1)),
      intentAccuracy: round(withIntent.filter((s) => s.intentOk).length / (withIntent.length || 1)),
      avgDecisionMs: round(scores.reduce((a, s) => a + s.ms, 0) / scores.length),
      scores,
    };
  }
}

/** The report as a few lines, for the CLI. */
export function formatReport(r: EvaluationReport): string {
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  const lines = [
    `Decision engine: ${r.engine} (${r.fixtures} fixtures)`,
    `  tool recall ${pct(r.toolRecall)} · precision ${pct(r.toolPrecision)} · ${r.avgToolsOffered} tools offered`,
    `  context recall ${pct(r.contextRecall)} · MRR ${r.mrr} · intent accuracy ${pct(r.intentAccuracy)} · ${r.avgDecisionMs} ms a decision`,
  ];
  for (const s of r.scores.filter((x) => !x.toolsOk || x.contextOk === false || x.intentOk === false)) lines.push(`  ✗ ${s.request}${s.missingTools.length ? ` — missing tools ${s.missingTools.map((g) => g.join('|')).join(', ')}` : ''}${s.missingContext.length ? ` — missing context ${s.missingContext.map((g) => g.join('|')).join(', ')}` : ''}${s.intentOk === false ? ` — intent ${s.intent}` : ''}`);
  return lines.join('\n');
}
