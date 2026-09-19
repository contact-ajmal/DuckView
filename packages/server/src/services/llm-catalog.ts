/**
 * The DuckCopilot provider catalog: every LLM vendor the UI can offer, with what the settings page needs to get a
 * person from "no key" to a working assistant — where to get a key, what it looks like, the endpoint, suggested
 * models. Most vendors speak the OpenAI chat-completions dialect and share one implementation; Anthropic has its
 * own SDK; the AWS entries use the server's credential chain.
 */
export type ProviderId = 'anthropic' | 'openai' | 'gemini' | 'deepseek' | 'openrouter' | 'kimi' | 'groq' | 'mistral' | 'xai' | 'ollama' | 'custom' | 'bedrock' | 'bedrock_agent' | 'agentcore';

export type ProviderKind = 'anthropic' | 'openai' | 'aws';

export interface ProviderPreset {
  id: ProviderId;
  /** Product name people know ("ChatGPT / OpenAI"). */
  label: string;
  vendor: string;
  blurb: string;
  kind: ProviderKind;
  /** OpenAI-compatible endpoint (kind = openai). `null` means the person must supply one. */
  baseUrl: string | null;
  /** Whether an API key is needed at all (Ollama and the AWS entries do not take one). */
  keyRequired: boolean;
  /** Where to create a key. */
  keyUrl: string | null;
  /** Prefix of a valid key, for a placeholder and a sanity check ("sk-ant-"). */
  keyPrefix: string | null;
  defaultModel: string;
  models: string[];
  /** Name of the token-limit parameter the endpoint accepts. */
  tokenParam: 'max_tokens' | 'max_completion_tokens';
  /** Extra request headers the vendor wants (OpenRouter attribution). */
  headers?: Record<string, string>;
  /** Shown as a tip under the form. */
  note?: string;
}

const openaiLike = (p: Omit<ProviderPreset, 'kind' | 'keyRequired' | 'tokenParam'> & Partial<Pick<ProviderPreset, 'keyRequired' | 'tokenParam'>>): ProviderPreset => ({ kind: 'openai', keyRequired: true, tokenParam: 'max_tokens', ...p });

export const PROVIDER_CATALOG: ProviderPreset[] = [
  {
    id: 'anthropic', label: 'Claude', vendor: 'Anthropic', blurb: 'Claude Opus, Sonnet and Haiku through the Anthropic API.', kind: 'anthropic', baseUrl: null, keyRequired: true,
    keyUrl: 'https://console.anthropic.com/settings/keys', keyPrefix: 'sk-ant-', defaultModel: 'claude-opus-5', models: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'], tokenParam: 'max_tokens',
  },
  openaiLike({
    id: 'openai', label: 'ChatGPT / OpenAI', vendor: 'OpenAI', blurb: 'GPT models through the OpenAI API.', baseUrl: 'https://api.openai.com/v1',
    keyUrl: 'https://platform.openai.com/api-keys', keyPrefix: 'sk-', defaultModel: 'gpt-4o', models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'o3-mini'], tokenParam: 'max_completion_tokens',
  }),
  openaiLike({
    id: 'gemini', label: 'Gemini', vendor: 'Google', blurb: 'Gemini models through Google AI Studio (OpenAI-compatible endpoint).', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyUrl: 'https://aistudio.google.com/app/apikey', keyPrefix: 'AIza', defaultModel: 'gemini-2.5-flash', models: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash'],
  }),
  openaiLike({
    id: 'deepseek', label: 'DeepSeek', vendor: 'DeepSeek', blurb: 'DeepSeek-V3 chat and the R1 reasoner.', baseUrl: 'https://api.deepseek.com/v1',
    keyUrl: 'https://platform.deepseek.com/api_keys', keyPrefix: 'sk-', defaultModel: 'deepseek-chat', models: ['deepseek-chat', 'deepseek-reasoner'],
  }),
  openaiLike({
    id: 'openrouter', label: 'OpenRouter', vendor: 'OpenRouter', blurb: 'One key for hundreds of models from every vendor — pick any model id from openrouter.ai/models.', baseUrl: 'https://openrouter.ai/api/v1',
    keyUrl: 'https://openrouter.ai/settings/keys', keyPrefix: 'sk-or-', defaultModel: 'deepseek/deepseek-v4-flash-0731:free',
    models: ['deepseek/deepseek-v4-flash-0731:free', 'nvidia/nemotron-3-super-120b-a12b:free', 'qwen/qwen3.8-27b:free', 'google/gemma-4-31b-it:free', 'openrouter/free', 'anthropic/claude-sonnet-4.5', 'anthropic/claude-opus-4.1', 'openai/gpt-4.1', 'google/gemini-2.5-pro', 'deepseek/deepseek-chat-v3.1', 'moonshotai/kimi-k2', 'x-ai/grok-4', 'qwen/qwen3-coder'],
    headers: { 'HTTP-Referer': 'https://contact-ajmal.github.io/DuckView/', 'X-Title': 'DuckView' },
    note: 'Models ending in :free cost nothing (rate-limited: ~20 requests/min, 50/day — 1 000/day once $10 of credits are on the account; some require allowing prompt logging under openrouter.ai/settings/privacy). Fetch models lists everything your key can reach, free ones first; the id is vendor/name.',
  }),
  openaiLike({
    id: 'kimi', label: 'Kimi', vendor: 'Moonshot AI', blurb: 'Kimi K2 and the Moonshot models.', baseUrl: 'https://api.moonshot.ai/v1',
    keyUrl: 'https://platform.moonshot.ai/console/api-keys', keyPrefix: 'sk-', defaultModel: 'kimi-k2-0905-preview', models: ['kimi-k2-0905-preview', 'kimi-k2-turbo-preview', 'moonshot-v1-128k', 'moonshot-v1-32k'],
    note: 'Accounts on platform.moonshot.cn use https://api.moonshot.cn/v1 — set it as the base URL.',
  }),
  openaiLike({
    id: 'groq', label: 'Groq', vendor: 'Groq', blurb: 'Very fast open-weight models (Llama, GPT-OSS, Qwen) on Groq hardware.', baseUrl: 'https://api.groq.com/openai/v1',
    keyUrl: 'https://console.groq.com/keys', keyPrefix: 'gsk_', defaultModel: 'llama-3.3-70b-versatile', models: ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b', 'qwen/qwen3-32b', 'meta-llama/llama-4-maverick-17b-128e-instruct'], tokenParam: 'max_completion_tokens',
  }),
  openaiLike({
    id: 'mistral', label: 'Mistral', vendor: 'Mistral AI', blurb: 'Mistral Large, Medium and Codestral.', baseUrl: 'https://api.mistral.ai/v1',
    keyUrl: 'https://console.mistral.ai/api-keys', keyPrefix: null, defaultModel: 'mistral-large-latest', models: ['mistral-large-latest', 'mistral-medium-latest', 'codestral-latest', 'magistral-medium-latest'],
  }),
  openaiLike({
    id: 'xai', label: 'Grok', vendor: 'xAI', blurb: 'Grok models through the xAI API.', baseUrl: 'https://api.x.ai/v1',
    keyUrl: 'https://console.x.ai/', keyPrefix: 'xai-', defaultModel: 'grok-4', models: ['grok-4', 'grok-4-fast', 'grok-3', 'grok-3-mini'],
  }),
  openaiLike({
    id: 'ollama', label: 'Ollama', vendor: 'Local', blurb: 'Models running on your own machine or network — no key, no data leaves your network.', baseUrl: 'http://localhost:11434', keyRequired: false,
    keyUrl: 'https://ollama.com/download', keyPrefix: null, defaultModel: 'llama3.1', models: ['llama3.1', 'qwen2.5-coder', 'mistral', 'deepseek-r1', 'gpt-oss'],
    note: 'Base URL is the Ollama server (the /v1 suffix is added). Fetch models lists what is pulled.',
  }),
  openaiLike({
    id: 'custom', label: 'Other (OpenAI-compatible)', vendor: 'Any', blurb: 'Together, Fireworks, Perplexity, Azure OpenAI, vLLM, LM Studio — anything that speaks /v1/chat/completions.', baseUrl: null,
    keyUrl: null, keyPrefix: null, defaultModel: '', models: [], note: 'Base URL must include the version path, e.g. https://api.together.xyz/v1.',
  }),
  {
    id: 'bedrock', label: 'Amazon Bedrock', vendor: 'AWS', blurb: 'Claude on Bedrock through the Converse API, using the server\'s AWS credentials.', kind: 'aws', baseUrl: null, keyRequired: false,
    keyUrl: 'https://console.aws.amazon.com/bedrock/home#/modelaccess', keyPrefix: null, defaultModel: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0',
    models: ['us.anthropic.claude-sonnet-4-5-20250929-v1:0', 'us.anthropic.claude-opus-4-1-20250805-v1:0', 'us.anthropic.claude-haiku-4-5-20251001-v1:0', 'global.anthropic.claude-sonnet-4-5-20250929-v1:0'], tokenParam: 'max_tokens',
    note: 'Needs an AWS region and model access enabled in that region.',
  },
  { id: 'bedrock_agent', label: 'Bedrock Agent', vendor: 'AWS', blurb: 'An existing Amazon Bedrock Agent (Classic), one session per conversation.', kind: 'aws', baseUrl: null, keyRequired: false, keyUrl: null, keyPrefix: null, defaultModel: 'bedrock-agent', models: [], tokenParam: 'max_tokens' },
  { id: 'agentcore', label: 'AgentCore runtime', vendor: 'AWS', blurb: 'Your own agent on Amazon Bedrock AgentCore Runtime; the workspace context is passed as payload.context.', kind: 'aws', baseUrl: null, keyRequired: false, keyUrl: null, keyPrefix: null, defaultModel: 'agentcore-runtime', models: [], tokenParam: 'max_tokens' },
];

export const PROVIDER_IDS = PROVIDER_CATALOG.map((p) => p.id) as ProviderId[];
export const AWS_PROVIDERS: ProviderId[] = PROVIDER_CATALOG.filter((p) => p.kind === 'aws').map((p) => p.id);
const byId = new Map(PROVIDER_CATALOG.map((p) => [p.id, p]));
export const presetFor = (id: ProviderId): ProviderPreset => byId.get(id)!;
export const DEFAULT_MODELS = Object.fromEntries(PROVIDER_CATALOG.map((p) => [p.id, p.defaultModel])) as Record<ProviderId, string>;
export const SUGGESTED_MODELS = Object.fromEntries(PROVIDER_CATALOG.map((p) => [p.id, p.models])) as Record<ProviderId, string[]>;
