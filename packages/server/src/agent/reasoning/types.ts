/**
 * The reasoning model contract: given a prompt, the conversation and the tools on offer, stream what the model does —
 * text, a tool call, a plan — and what it cost. The runtime never knows which provider is behind it.
 */
import type { ToolDescriptor } from '../registry.js';

export interface ReasoningMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ReasoningInput {
  system: string;
  messages: ReasoningMessage[];
  /** The tools on offer for this step (already selected); the model may call only these. */
  tools: ToolDescriptor[];
  maxTokens: number;
  temperature?: number;
  signal?: AbortSignal;
  /** A stable id for providers that keep their own session (AgentCore, Bedrock Agents). */
  sessionId?: string;
}

export type ReasoningEvent =
  /** Visible answer text (never the tool or plan blocks). */
  | { type: 'text'; delta: string }
  | { type: 'plan'; steps: string[] }
  | { type: 'tool_call'; name: string; arguments: Record<string, unknown> }
  /** The model tried to call a tool but the call could not be read; the message goes back to it. */
  | { type: 'invalid_call'; message: string }
  | { type: 'usage'; inputTokens: number | null; outputTokens: number | null };

export interface ReasoningModel {
  readonly provider: string;
  readonly model: string;
  generate(input: ReasoningInput): AsyncIterable<ReasoningEvent>;
}
