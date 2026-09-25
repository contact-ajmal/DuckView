/**
 * ReasoningModel over DuckView's LLM providers (services/llm.ts): Anthropic, every OpenAI-compatible vendor, Bedrock,
 * Bedrock Agents and AgentCore, local models. The provider streams text; this adapter turns it into reasoning events
 * with the fenced protocol (protocol.ts): visible text as it arrives, then the plan and the tool call, then usage.
 */
import type { LlmProvider } from '../../services/llm.js';
import type { ReasoningEvent, ReasoningInput, ReasoningModel } from './types.js';
import { parsePlan, parseToolCall, safePrefixLength, stripBlocks } from './protocol.js';

export class LlmReasoningModel implements ReasoningModel {
  constructor(private readonly llm: LlmProvider) {}

  get provider(): string {
    return this.llm.id;
  }
  get model(): string {
    return this.llm.model;
  }

  async *generate(input: ReasoningInput): AsyncIterable<ReasoningEvent> {
    const gen = this.llm.stream({ system: input.system, messages: input.messages, model: this.llm.model, maxTokens: input.maxTokens, temperature: input.temperature ?? 0, signal: input.signal, conversationId: input.sessionId });
    let text = '';
    let shown = 0;
    let n = await gen.next();
    for (; !n.done; n = await gen.next()) {
      text += n.value;
      const safe = safePrefixLength(text);
      if (safe > shown) {
        yield { type: 'text', delta: text.slice(shown, safe) };
        shown = safe;
      }
    }
    const plan = parsePlan(text);
    const call = parseToolCall(text);
    if (!call) {
      // An answer: whatever was held back, less any plan block.
      const rest = stripBlocks(text.slice(shown)).trimEnd();
      if (rest.trim()) yield { type: 'text', delta: rest };
    }
    if (plan) yield { type: 'plan', steps: plan };
    if (call && 'error' in call) yield { type: 'invalid_call', message: call.error };
    else if (call) yield { type: 'tool_call', name: call.name, arguments: call.arguments };
    yield { type: 'usage', inputTokens: n.value?.input_tokens ?? null, outputTokens: n.value?.output_tokens ?? null };
  }
}
