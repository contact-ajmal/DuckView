/**
 * DefaultDecisionEngine — DuckView's built-in Decision Engine: deterministic, local and fast. No model call.
 *
 *  - rankCandidates: a BM25-style lexical score over weighted fields (a name counts more than a description), with
 *    stemming and data-work synonyms, a bonus when the candidate's whole name appears in the request, times a boost.
 *  - classify: intent from the verbs and nouns of the request (investigate, build, quality, navigate…) plus the names
 *    it mentions.
 *  - route: plain moves ("open the revenue dashboard") go straight to a workspace action; everything else to the agent.
 *  - selectTools: the core tools, then the best-scoring tools for the request and its intent, within the budget.
 *  - selectContext: pinned objects first, then the best-ranked, packed within the object, token and observation budgets.
 */
import type { ContextObject } from '../context/types.js';
import { estimateTokens } from '../context/types.js';
import type { ToolDescriptor } from '../registry.js';
import type { ToolCategory } from '../semantics.js';
import type { ClassificationInput, ClassificationResult, ContextSelectionInput, ContextSelectionResult, DecisionEngine, Intent, RankingInput, RankingResult, RoutingInput, RoutingResult, ToolSelectionInput, ToolSelectionResult } from './types.js';
import { entityHints, terms, tokens } from './text.js';

const DEFAULT_WEIGHTS: Record<string, number> = { name: 3, title: 2.5, keywords: 2, capabilities: 1.5, category: 1.2, type: 1, text: 1, summary: 1 };
const K1 = 1.2;
const B = 0.75;

/** Intents and the tool categories that do that kind of work. */
const INTENT_CATEGORIES: Record<Intent, ToolCategory[]> = {
  ask: ['query', 'semantic', 'catalog'],
  analyse: ['query', 'semantic', 'profile', 'catalog', 'insight'],
  investigate: ['insight', 'semantic', 'query', 'catalog'],
  explain: ['query', 'catalog', 'semantic', 'governance'],
  create: ['dashboard', 'notebook', 'semantic', 'quality', 'query'],
  build: ['dashboard', 'app', 'notebook'],
  modify: ['dashboard', 'query', 'notebook'],
  navigate: ['dashboard', 'notebook', 'query', 'catalog'],
  quality: ['quality', 'profile', 'catalog'],
  transform: ['dbt', 'prep', 'query'],
  discover: ['catalog', 'governance', 'connector'],
};

/** First match wins; order matters (a "why did revenue drop" is an investigation before an analysis). */
const INTENT_RULES: [Intent, RegExp][] = [
  ['navigate', /^\s*(open|go to|show me the|take me to|switch to|jump to)\b/i],
  ['investigate', /\b(why|root cause|what caused|investigat\w*|drivers?|drop(ped)?|declin\w*|spike\w*|anomal\w*|unusual|outliers?|fell|went down|went up)\b/i],
  ['quality', /\b(quality|null|nulls|missing values|duplicates?|validat\w*|checks?|expectations?|freshness|stale)\b/i],
  ['transform', /\b(dbt|model|staging|mart|clean|dedupe|reshape|prepare|wrangle|transform\w*)\b/i],
  ['build', /\b(build|dashboard|data app|streamlit|app\b|executive (summary|view)|report)\b/i],
  ['modify', /^\s*(change|turn (this|it) into|make (this|it)|filter (this|it)|rename|update|add .* to (this|the)|remove|switch (this|it))\b/i],
  ['explain', /^\s*(explain|what does|what is|what's|what are|describe|define|how is .* (calculated|defined))\b/i],
  ['create', /^\s*(create|make|add|save|define|write|generate|set up|schedule)\b/i],
  ['discover', /\b(find|search|which tables?|where (is|are)|look for|related to|tables? (with|containing|about)|what data)\b/i],
  ['analyse', /\b(analy[sz]e|analysis|compare|comparison|trend|breakdown|break down|by (region|month|week|day|year|country|product|segment|customer)|distribution|profile|top \d+|over time)\b/i],
];

/** "open the revenue dashboard" → open_dashboard "revenue". */
const NAVIGATION: [RegExp, string][] = [
  [/^\s*(?:open|go to|show me|take me to|switch to|jump to)\s+(?:the\s+)?(.+?)\s+dashboard\s*\.?$/i, 'open_dashboard'],
  [/^\s*(?:open|go to|show me|take me to|switch to|jump to)\s+(?:the\s+)?dashboard\s+["']?(.+?)["']?\s*\.?$/i, 'open_dashboard'],
  [/^\s*(?:open|go to|show me|take me to|switch to|jump to)\s+(?:the\s+)?(.+?)\s+notebook\s*\.?$/i, 'open_notebook'],
  [/^\s*(?:open|go to|take me to|switch to|jump to)\s+(?:the\s+)?(?:table|dataset)\s+["'`]?([\w.]+)["'`]?\s*\.?$/i, 'open_dataset'],
  [/^\s*(?:open|go to|take me to|switch to|jump to)\s+(?:the\s+)?["'`]?([\w.]+)["'`]?\s+(?:table|dataset)\s*\.?$/i, 'open_dataset'],
  [/^\s*(?:open|go to|take me to|jump to)\s+(?:the\s+)?(sql|workbench|query editor|catalog|lineage|metrics|quality|models|explorer|compare|prepare|settings|home)\s*\.?$/i, 'open_page'],
];

export class DefaultDecisionEngine implements DecisionEngine {
  readonly name = 'default';

  async rankCandidates(input: RankingInput): Promise<RankingResult> {
    return { ranked: rank(input) };
  }

  async classify(input: ClassificationInput): Promise<ClassificationResult> {
    const req = input.request.trim();
    const hit = INTENT_RULES.find(([, re]) => re.test(req));
    // With a page on screen and a short, deictic request ("profile this"), the request is about the page.
    const intent: Intent = hit?.[0] ?? (/\b(this|these|it)\b/i.test(req) && input.page ? 'analyse' : 'ask');
    return { intent, confidence: hit ? 0.8 : 0.4, entities: entityHints(req) };
  }

  async route(input: RoutingInput): Promise<RoutingResult> {
    if (input.classification.intent === 'navigate') {
      for (const [re, action] of NAVIGATION) {
        const m = re.exec(input.request);
        if (m) return { route: 'workspace_action', action: { action, target: m[1]!.trim() }, reason: `A move in the workspace (${action.replace('_', ' ')}).` };
      }
    }
    return { route: 'agent', reason: `A ${input.classification.intent} request for the agent.` };
  }

  async selectTools(input: ToolSelectionInput): Promise<ToolSelectionResult> {
    const intent = input.intent;
    const wanted = new Set(intent ? INTENT_CATEGORIES[intent] : []);
    // What the context holds shapes the tools: defined metrics → the semantic tools; a dashboard on screen → its tools.
    const contextTerms = (input.context ?? []).filter((o) => o.pinned || (o.relevance ?? 0) > 0.5).map((o) => o.type).join(' ');
    const ranked = rank({
      query: `${input.request} ${intent ?? ''}`,
      candidates: input.tools.map((t) => ({
        id: t.name,
        fields: { name: t.name.replace(/_/g, ' '), title: t.title, keywords: t.semantics.keywords.join(' '), capabilities: t.semantics.capabilities.join(' '), category: t.semantics.category, summary: t.summary },
        boost: (wanted.has(t.semantics.category) ? 1.6 : 1) * (contextTerms.includes('metric') && t.semantics.category === 'semantic' ? 1.4 : 1) * (contextTerms.includes('dashboard') && t.semantics.category === 'dashboard' ? 1.3 : 1) * (input.used?.includes(t.name) ? 1.2 : 1),
      })),
    });
    const scores = Object.fromEntries(ranked.map((r) => [r.id, r.score]));
    const byName = new Map(input.tools.map((t) => [t.name, t]));
    const chosen: ToolDescriptor[] = [];
    const take = (t: ToolDescriptor | undefined) => {
      if (t && !chosen.includes(t) && chosen.length < input.max) chosen.push(t);
    };
    for (const t of input.tools) if (t.semantics.core) take(t);
    for (const n of input.used ?? []) take(byName.get(n));
    for (const r of ranked) if (r.score > 0) take(byName.get(r.id));
    return { tools: chosen, scores, considered: input.tools.length };
  }

  async selectContext(input: ContextSelectionInput): Promise<ContextSelectionResult> {
    const { budget } = input;
    const pinned = new Set([...(input.pinned ?? []), ...input.candidates.filter((c) => c.pinned).map((c) => c.id)]);
    const ranked = rank({
      query: input.request,
      candidates: input.candidates.map((c) => ({
        id: c.id,
        fields: { title: c.title, type: c.type.replace('_', ' '), text: c.text.slice(0, 2000) },
        // Recent observations and memory of this task matter more; columns count less than their table.
        boost: (c.type === 'observation' ? 1.3 : c.type === 'column' ? 0.8 : c.type === 'metric' ? 1.2 : 1) * (typeof c.metadata.boost === 'number' ? c.metadata.boost : 1),
      })),
    });
    const max = Math.max(...ranked.map((r) => r.score), 1e-9);
    const score = new Map(ranked.map((r) => [r.id, r.score / max]));
    const byId = new Map(input.candidates.map((c) => [c.id, c]));
    const order = [...[...pinned].filter((id) => byId.has(id)), ...ranked.filter((r) => r.score > 0 && !pinned.has(r.id)).map((r) => r.id)];
    const selected: ContextObject[] = [];
    let used = 0;
    let observations = 0;
    for (const id of order) {
      if (selected.length >= budget.maxObjects) break;
      const c = byId.get(id)!;
      if (c.type === 'observation' && observations >= budget.maxObservations) continue;
      const t = c.tokens ?? estimateTokens(c.text);
      if (used + t > budget.maxTokens) continue;
      used += t;
      if (c.type === 'observation') observations++;
      selected.push({ ...c, tokens: t, relevance: pinned.has(id) ? 1 : Math.round((score.get(id) ?? 0) * 1000) / 1000 });
    }
    return { selected, considered: input.candidates.length, dropped: input.candidates.length - selected.length, tokens: used };
  }
}

/** BM25 over weighted fields, with a whole-name bonus. Candidates with no matching term score 0. */
function rank(input: RankingInput): { id: string; score: number }[] {
  const weights = { ...DEFAULT_WEIGHTS, ...(input.weights ?? {}) };
  const q = [...new Set(terms(input.query))];
  if (!q.length) return input.candidates.map((c) => ({ id: c.id, score: 0 }));
  const requestLower = input.query.toLowerCase();
  const requestTokens = ` ${tokens(input.query).join(' ')} `;
  const docs = input.candidates.map((c) => {
    const fieldTerms: Record<string, string[]> = {};
    for (const [f, text] of Object.entries(c.fields)) fieldTerms[f] = terms(text ?? '');
    return { c, fieldTerms };
  });
  const n = docs.length || 1;
  const df = new Map<string, number>();
  for (const d of docs) {
    const seen = new Set(Object.values(d.fieldTerms).flat());
    for (const t of q) if (seen.has(t)) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const avgLen: Record<string, number> = {};
  for (const f of Object.keys(weights)) avgLen[f] = docs.reduce((s, d) => s + (d.fieldTerms[f]?.length ?? 0), 0) / n || 1;
  const out = docs.map(({ c, fieldTerms }) => {
    let score = 0;
    for (const t of q) {
      const idf = Math.log(1 + (n - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));
      for (const [f, ts] of Object.entries(fieldTerms)) {
        const tf = ts.filter((x) => x === t).length;
        if (!tf) continue;
        const w = weights[f] ?? 1;
        score += w * idf * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * ts.length) / (avgLen[f] || 1))));
      }
    }
    // The candidate's own name, written out in the request ("orders", "customer_orders", "Revenue overview").
    const title = (c.fields.title ?? c.fields.name ?? '').toLowerCase().trim();
    if (title.length >= 3 && (requestLower.includes(title) || requestTokens.includes(` ${tokens(title).join(' ')} `))) score += 3;
    return { id: c.id, score: score * (c.boost ?? 1) };
  });
  out.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return input.limit ? out.slice(0, input.limit) : out;
}
