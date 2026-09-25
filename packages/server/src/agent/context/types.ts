/**
 * Structured context: what the reasoning model may be shown about a workspace, as typed objects that can be ranked,
 * budgeted, packed and invalidated — never one giant prompt.
 */
import type { ToolDescriptor } from '../registry.js';

export const CONTEXT_OBJECT_TYPES = [
  'workspace', 'table', 'view', 'file', 'column', 'metric', 'semantic_model', 'dimension', 'dbt_model', 'notebook',
  'dashboard', 'saved_query', 'app', 'quality_suite', 'insight', 'relationship', 'observation', 'memory', 'page',
  'selection', 'query_result', 'instruction',
] as const;
export type ContextObjectType = (typeof CONTEXT_OBJECT_TYPES)[number];

export interface ContextObject {
  /** Stable within a workspace: `<type>:<name or id>`. */
  id: string;
  type: ContextObjectType;
  workspaceId: string;
  /** Where it came from: catalog, semantic, dbt, bi, notebooks, memory, page, task… */
  source: string;
  /** A short name for people and ranking (table name, metric label, dashboard name). */
  title: string;
  /** The compact text the model sees for this object. */
  text: string;
  /** The structured payload (columns, metric definition, widget list…), for tools and the UI. */
  content: unknown;
  metadata: Record<string, unknown>;
  /** 0..1 once ranked. */
  relevance?: number;
  /** Estimated tokens of `text`. */
  tokens?: number;
  /** Always included when it fits (the page on screen, what the person selected, the request's own instructions). */
  pinned?: boolean;
  timestamp: string;
}

export interface ContextBudget {
  maxObjects: number;
  maxTokens: number;
  maxToolDefinitions: number;
  maxObservations: number;
  maxResultRows: number;
}

export const DEFAULT_BUDGET: ContextBudget = { maxObjects: 24, maxTokens: 6000, maxToolDefinitions: 12, maxObservations: 12, maxResultRows: 50 };

/** The semantic layer as the agent sees it: canonical metrics to prefer over hand-written SQL. */
export interface SemanticContext {
  metrics: { name: string; label: string | null; description: string | null; type: string; dimensions: string[]; synonyms: string[] }[];
  /** True when a defined metric plausibly answers the request: the model is told to query it, not re-derive it. */
  preferMetrics: boolean;
  matched: string[];
}

export interface ContextStats {
  considered: number;
  selected: number;
  tokens: number;
  dropped: number;
  durationMs: number;
}

export interface ContextPack {
  request: string;
  objects: ContextObject[];
  tools: ToolDescriptor[];
  semanticContext: SemanticContext;
  budget: ContextBudget;
  stats: ContextStats;
}

/** A rough, provider-independent token estimate (about four characters a token). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
