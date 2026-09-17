/**
 * LLM provider bridge for DuckCopilot. Three providers, one streaming contract:
 *   - anthropic : official @anthropic-ai/sdk, Messages API streaming (default model claude-opus-5)
 *   - openai    : official openai SDK, chat completions streaming (default model gpt-4o)
 *   - ollama    : openai SDK against Ollama's OpenAI-compatible endpoint (<base_url>/v1), model list via /api/tags
 */
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { HttpError } from './errors.js';

export type ProviderId = 'anthropic' | 'openai' | 'ollama';

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
}

export const DEFAULT_MODELS: Record<ProviderId, string> = {
  anthropic: 'claude-opus-5',
  openai: 'gpt-4o',
  ollama: 'llama3.1',
};

export const SUGGESTED_MODELS: Record<ProviderId, string[]> = {
  anthropic: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'],
  openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'o3-mini'],
  ollama: ['llama3.1', 'qwen2.5-coder', 'mistral', 'deepseek-r1'],
};

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
