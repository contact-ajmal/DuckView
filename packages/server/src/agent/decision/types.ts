/**
 * The Decision Engine contract. A Decision Engine answers the cheap questions around a request — which context
 * objects, which tools, what kind of request, which route — so the reasoning model only sees what matters. It never
 * does the deep reasoning itself.
 *
 * Implementations: DefaultDecisionEngine (deterministic, local). Future providers implement this interface and
 * register in providers.ts; nothing else in DuckView depends on which one runs.
 */
import type { ContextBudget, ContextObject } from '../context/types.js';
import type { ToolDescriptor } from '../registry.js';

export const INTENTS = ['ask', 'analyse', 'investigate', 'explain', 'create', 'build', 'modify', 'navigate', 'quality', 'transform', 'discover'] as const;
export type Intent = (typeof INTENTS)[number];

/** What the person is looking at, from the UI (store/context.ts), or what an external caller named. */
export interface PageRef {
  kind: string;
  id?: string | null;
  label: string;
}

export interface ContextSelectionInput {
  request: string;
  candidates: ContextObject[];
  budget: ContextBudget;
  intent?: Intent;
  /** Ids to keep whatever their score (the page on screen, explicit selections). */
  pinned?: string[];
}
export interface ContextSelectionResult {
  selected: ContextObject[];
  considered: number;
  dropped: number;
  tokens: number;
}

export interface ToolSelectionInput {
  request: string;
  tools: ToolDescriptor[];
  intent?: Intent;
  context?: ContextObject[];
  max: number;
  /** Names already used in the task (kept available so the model can repeat them). */
  used?: string[];
}
export interface ToolSelectionResult {
  tools: ToolDescriptor[];
  scores: Record<string, number>;
  considered: number;
}

export interface RankingCandidate {
  id: string;
  /** Field name → text; fields are weighted (name > title > keywords > description). */
  fields: Record<string, string>;
  /** Multiplies the score (recency, popularity, a boost for the page on screen). */
  boost?: number;
}
export interface RankingInput {
  query: string;
  candidates: RankingCandidate[];
  weights?: Record<string, number>;
  limit?: number;
}
export interface RankingResult {
  ranked: { id: string; score: number }[];
}

export interface ClassificationInput {
  request: string;
  page?: PageRef | null;
}
export interface ClassificationResult {
  intent: Intent;
  confidence: number;
  /** Words of the request that look like names (tables, metrics, dashboards) — handed to discovery. */
  entities: string[];
}

export interface WorkspaceActionRequest {
  action: string;
  target?: string | null;
  args?: Record<string, unknown>;
}
export interface RoutingInput {
  request: string;
  classification: ClassificationResult;
  page?: PageRef | null;
}
export interface RoutingResult {
  /** workspace_action: a UI move with no reasoning (open the revenue dashboard); agent: the reasoning loop. */
  route: 'workspace_action' | 'agent';
  action?: WorkspaceActionRequest;
  reason: string;
}

export interface DecisionEngine {
  readonly name: string;
  selectContext(input: ContextSelectionInput): Promise<ContextSelectionResult>;
  selectTools(input: ToolSelectionInput): Promise<ToolSelectionResult>;
  rankCandidates(input: RankingInput): Promise<RankingResult>;
  classify(input: ClassificationInput): Promise<ClassificationResult>;
  route(input: RoutingInput): Promise<RoutingResult>;
}

/** What a future provider (an external ranking service, a local model…) implements. Same contract, plus a name. */
export type DecisionEngineProvider = DecisionEngine;
