/**
 * LLM provider bridge for DuckCopilot. Six providers, one streaming contract:
 *   - anthropic     : official @anthropic-ai/sdk, Messages API streaming (default model claude-opus-5)
 *   - openai        : official openai SDK, chat completions streaming (default model gpt-4o)
 *   - ollama        : openai SDK against Ollama's OpenAI-compatible endpoint (<base_url>/v1), model list via /api/tags
 *   - bedrock       : Amazon Bedrock Converse streaming (Claude on Bedrock; default credential chain, region required)
 *   - bedrock_agent : an existing Amazon Bedrock Agent (Classic) — InvokeAgent with a per-conversation session
 *   - agentcore     : an agent deployed on Amazon Bedrock AgentCore Runtime — InvokeAgentRuntime (SSE or JSON)
 * The agent providers receive the workspace context separately (they keep their own instructions and memory).
 */
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { HttpError } from './errors.js';
import { defaultAwsBridge, type AwsBridge } from './aws.js';

export type ProviderId = 'anthropic' | 'openai' | 'ollama' | 'bedrock' | 'bedrock_agent' | 'agentcore';
export const PROVIDER_IDS: ProviderId[] = ['anthropic', 'openai', 'ollama', 'bedrock', 'bedrock_agent', 'agentcore'];
export const AWS_PROVIDERS: ProviderId[] = ['bedrock', 'bedrock_agent', 'agentcore'];

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface LlmRequest {
  system: string;
  messages: LlmMessage[];
  model: string;
  maxTokens: number;
  temperature?: number;
  signal?: AbortSignal;
  /** Rendered workspace context alone (no persona) — handed to external agents that have their own instructions. */
  context?: string;
  /** Conversation id → stable agent session id. */
  conversationId?: string;
}

export interface LlmUsage {
  input_tokens: number | null;
  output_tokens: number | null;
}

export interface LlmProvider {
  readonly id: ProviderId;
  readonly model: string;
  /** Streams text deltas; resolves usage when the stream ends. */
  stream(req: LlmRequest): AsyncGenerator<string, LlmUsage, void>;
  listModels(): Promise<string[]>;
}

export interface ProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  /** AWS providers */
  region?: string;
  agentId?: string;
  agentAliasId?: string;
  runtimeArn?: string;
  aws?: AwsBridge;
}

export const DEFAULT_MODELS: Record<ProviderId, string> = {
  anthropic: 'claude-opus-5',
  openai: 'gpt-4o',
  ollama: 'llama3.1',
  bedrock: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
  bedrock_agent: 'bedrock-agent',
  agentcore: 'agentcore-runtime',
};

export const SUGGESTED_MODELS: Record<ProviderId, string[]> = {
  anthropic: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'],
  openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'o3-mini'],
  ollama: ['llama3.1', 'qwen2.5-coder', 'mistral', 'deepseek-r1'],
  bedrock: ['us.anthropic.claude-sonnet-4-5-20250929-v1:0', 'us.anthropic.claude-opus-4-1-20250805-v1:0', 'us.anthropic.claude-haiku-4-5-20251001-v1:0', 'global.anthropic.claude-sonnet-4-5-20250929-v1:0'],
  bedrock_agent: [],
  agentcore: [],
};

/** AgentCore needs 33+ character session ids; keep one session per DuckView conversation. */
function sessionIdFor(conversationId?: string): string {
  return `duckview-conversation-${conversationId ?? 'adhoc'}`.padEnd(40, '0');
}

class BedrockProvider implements LlmProvider {
  readonly id = 'bedrock' as const;
  readonly model: string;
  private readonly region: string;
  private readonly aws: AwsBridge;
  constructor(opts: ProviderOptions) {
    if (!opts.region) throw new HttpError(400, 'AWS region required for Bedrock (copilot.aws_region or bring your own)', 'COPILOT_REGION_REQUIRED');
    this.region = opts.region;
    this.model = opts.model || DEFAULT_MODELS.bedrock;
    this.aws = opts.aws ?? defaultAwsBridge;
  }
  async *stream(req: LlmRequest): AsyncGenerator<string, LlmUsage, void> {
    // Consecutive same-role turns are rejected by Converse; merge them.
    const merged: LlmMessage[] = [];
    for (const m of req.messages) {
      const last = merged[merged.length - 1];
      if (last && last.role === m.role) last.content += `\n\n${m.content}`;
      else merged.push({ ...m });
    }
    return yield* this.aws.converseStream({ region: this.region, system: req.system, messages: merged, model: this.model, maxTokens: req.maxTokens, temperature: req.temperature, signal: req.signal });
  }
  listModels(): Promise<string[]> {
    return this.aws.listModels(this.region);
  }
}

class BedrockAgentProvider implements LlmProvider {
  readonly id = 'bedrock_agent' as const;
  readonly model: string;
  private readonly aws: AwsBridge;
  constructor(private readonly opts: ProviderOptions) {
    if (!opts.region || !opts.agentId || !opts.agentAliasId) throw new HttpError(400, 'Bedrock Agent needs region, agent id and alias id (copilot.bedrock_agent_* or bring your own)', 'COPILOT_AGENT_REQUIRED');
    this.model = `${opts.agentId}/${opts.agentAliasId}`;
    this.aws = opts.aws ?? defaultAwsBridge;
  }
  async *stream(req: LlmRequest): AsyncGenerator<string, LlmUsage, void> {
    const last = [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const inputText = req.context ? `${last}\n\n<duckview_context>\n${req.context}\n</duckview_context>` : last;
    yield* this.aws.invokeBedrockAgent({ region: this.opts.region!, agentId: this.opts.agentId!, agentAliasId: this.opts.agentAliasId!, sessionId: sessionIdFor(req.conversationId), inputText, signal: req.signal });
    return { input_tokens: null, output_tokens: null };
  }
  async listModels(): Promise<string[]> {
    const agents = await this.aws.listBedrockAgents(this.opts.region!);
    return agents.flatMap((a) => a.aliases.map((al) => `${a.id}/${al.id}`));
  }
}

class AgentCoreProvider implements LlmProvider {
  readonly id = 'agentcore' as const;
  readonly model: string;
  private readonly aws: AwsBridge;
  constructor(private readonly opts: ProviderOptions) {
    if (!opts.runtimeArn) throw new HttpError(400, 'AgentCore runtime ARN required (copilot.agentcore_runtime_arn or bring your own)', 'COPILOT_AGENT_REQUIRED');
    this.model = opts.runtimeArn.split('/').pop() ?? opts.runtimeArn;
    this.aws = opts.aws ?? defaultAwsBridge;
  }
  private get region() {
    return this.opts.region || this.opts.runtimeArn!.split(':')[3] || 'us-east-1';
  }
  async *stream(req: LlmRequest): AsyncGenerator<string, LlmUsage, void> {
    const last = [...req.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    yield* this.aws.invokeAgentCore({ region: this.region, runtimeArn: this.opts.runtimeArn!, sessionId: sessionIdFor(req.conversationId), payload: { prompt: last, ...(req.context ? { context: req.context } : {}) }, signal: req.signal });
    return { input_tokens: null, output_tokens: null };
  }
  async listModels(): Promise<string[]> {
    return (await this.aws.listAgentRuntimes(this.region)).map((r) => r.arn);
  }
}

class AnthropicProvider implements LlmProvider {
  readonly id = 'anthropic' as const;
  readonly model: string;
  private client: Anthropic;
  constructor(opts: ProviderOptions) {
    if (!opts.apiKey) throw new HttpError(400, 'Anthropic API key required (server-managed or bring-your-own)', 'COPILOT_KEY_REQUIRED');
    this.client = new Anthropic({ apiKey: opts.apiKey, ...(opts.baseUrl ? { baseURL: opts.baseUrl } : {}), maxRetries: 1 });
    this.model = opts.model || DEFAULT_MODELS.anthropic;
  }
  async *stream(req: LlmRequest): AsyncGenerator<string, LlmUsage, void> {
    // Adaptive thinking is the default on current models; sampling parameters are rejected there, so none are sent.
    const stream = this.client.messages.stream(
      { model: this.model, max_tokens: req.maxTokens, system: req.system, messages: req.messages.map((m) => ({ role: m.role, content: m.content })) },
      { signal: req.signal },
    );
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') yield event.delta.text;
    }
    const final = await stream.finalMessage();
    if (final.stop_reason === 'refusal') throw new HttpError(422, 'The model declined this request.', 'COPILOT_REFUSAL');
    return { input_tokens: final.usage.input_tokens, output_tokens: final.usage.output_tokens };
  }
  async listModels(): Promise<string[]> {
    const out: string[] = [];
    for await (const m of this.client.models.list({ limit: 50 })) out.push(m.id);
    return out;
  }
}

class OpenAICompatibleProvider implements LlmProvider {
  readonly id: ProviderId;
  readonly model: string;
  private client: OpenAI;
  private readonly baseUrl: string | undefined;
  constructor(id: 'openai' | 'ollama', opts: ProviderOptions) {
    this.id = id;
    if (id === 'openai' && !opts.apiKey) throw new HttpError(400, 'OpenAI API key required (server-managed or bring-your-own)', 'COPILOT_KEY_REQUIRED');
    const base = id === 'ollama' ? (opts.baseUrl || 'http://localhost:11434').replace(/\/+$/, '') : opts.baseUrl?.replace(/\/+$/, '');
    this.baseUrl = base;
    this.client = new OpenAI({ apiKey: opts.apiKey || (id === 'ollama' ? 'ollama' : ''), baseURL: id === 'ollama' ? `${base}/v1` : base, maxRetries: 1 });
    this.model = opts.model || DEFAULT_MODELS[id];
  }
  async *stream(req: LlmRequest): AsyncGenerator<string, LlmUsage, void> {
    const stream = await this.client.chat.completions.create(
      {
        model: this.model,
        stream: true,
        stream_options: { include_usage: true },
        max_completion_tokens: req.maxTokens,
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        messages: [{ role: 'system', content: req.system }, ...req.messages.map((m) => ({ role: m.role, content: m.content }))],
      },
      { signal: req.signal },
    );
    let usage: LlmUsage = { input_tokens: null, output_tokens: null };
    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) yield delta;
      if (chunk.usage) usage = { input_tokens: chunk.usage.prompt_tokens ?? null, output_tokens: chunk.usage.completion_tokens ?? null };
    }
    return usage;
  }
  async listModels(): Promise<string[]> {
    if (this.id === 'ollama') {
      const res = await fetch(`${this.baseUrl}/api/tags`);
      if (!res.ok) throw new HttpError(502, `Ollama /api/tags returned ${res.status}`, 'COPILOT_PROVIDER_ERROR');
      const j = (await res.json()) as { models?: { name: string }[] };
      return (j.models ?? []).map((m) => m.name);
    }
    const out: string[] = [];
    for await (const m of this.client.models.list()) if (/gpt|o[134]/.test(m.id)) out.push(m.id);
    return out.sort();
  }
}

export type ProviderFactory = (id: ProviderId, opts: ProviderOptions) => LlmProvider;

export const defaultProviderFactory: ProviderFactory = (id, opts) => {
  switch (id) {
    case 'anthropic':
      return new AnthropicProvider(opts);
    case 'openai':
    case 'ollama':
      return new OpenAICompatibleProvider(id, opts);
    case 'bedrock':
      return new BedrockProvider(opts);
    case 'bedrock_agent':
      return new BedrockAgentProvider(opts);
    case 'agentcore':
      return new AgentCoreProvider(opts);
    default:
      throw new HttpError(400, `Unknown provider: ${String(id)}`, 'COPILOT_PROVIDER_INVALID');
  }
};

/** Maps SDK errors to HttpErrors with stable codes (never leaks keys). */
export function mapProviderError(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  if (err instanceof Anthropic.AuthenticationError || err instanceof OpenAI.AuthenticationError) return new HttpError(401, 'The LLM provider rejected the API key.', 'COPILOT_AUTH_FAILED');
  if (err instanceof Anthropic.RateLimitError || err instanceof OpenAI.RateLimitError) return new HttpError(429, 'The LLM provider is rate limiting requests — try again shortly.', 'COPILOT_RATE_LIMITED');
  if (err instanceof Anthropic.NotFoundError || err instanceof OpenAI.NotFoundError) return new HttpError(404, 'Model not found at the provider.', 'COPILOT_MODEL_NOT_FOUND');
  if (err instanceof Anthropic.APIError || err instanceof OpenAI.APIError) return new HttpError(502, `LLM provider error: ${err.message}`, 'COPILOT_PROVIDER_ERROR');
  const e = err as Error & { name?: string; code?: string };
  if (e?.name === 'AbortError') return new HttpError(499, 'Request cancelled', 'COPILOT_CANCELLED');
  if (e?.code === 'ECONNREFUSED' || /fetch failed|ECONNREFUSED|ENOTFOUND/.test(e?.message ?? '')) return new HttpError(502, `Cannot reach the LLM provider: ${e.message}`, 'COPILOT_PROVIDER_UNREACHABLE');
  return new HttpError(502, e?.message ?? 'LLM provider error', 'COPILOT_PROVIDER_ERROR');
}
