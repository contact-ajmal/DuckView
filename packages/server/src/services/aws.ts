/**
 * AWS bridge for DuckCopilot providers and registered-agent invocation:
 *   - Bedrock Converse (streaming)         → Claude and other Bedrock models as a Copilot provider
 *   - Bedrock Agents (Classic) InvokeAgent → chat with an existing Bedrock agent
 *   - AgentCore Runtime InvokeAgentRuntime → chat with a Strands / LangGraph / CrewAI agent deployed on AgentCore
 *   - control-plane listings (models, inference profiles, agents, aliases, runtimes) for the pickers
 *
 * Credentials come from the default AWS credential chain (env, shared config/SSO, instance/task roles).
 * The SDK clients are imported lazily so DuckView starts even where the packages are pruned, and the whole
 * module is injectable (AwsBridge) so tests can run without AWS.
 */
import { randomUUID } from 'node:crypto';
import { HttpError } from './errors.js';

export interface AwsChatRequest {
  region: string;
  system: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  model: string;
  maxTokens: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface AwsBridge {
  converseStream(req: AwsChatRequest): AsyncGenerator<string, { input_tokens: number | null; output_tokens: number | null }, void>;
  invokeBedrockAgent(opts: { region: string; agentId: string; agentAliasId: string; sessionId: string; inputText: string; signal?: AbortSignal }): AsyncGenerator<string, void, void>;
  invokeAgentCore(opts: { region: string; runtimeArn: string; qualifier?: string; sessionId: string; payload: Record<string, unknown>; signal?: AbortSignal }): AsyncGenerator<string, void, void>;
  listModels(region: string): Promise<string[]>;
  listBedrockAgents(region: string): Promise<{ id: string; name: string; status?: string; aliases: { id: string; name: string }[] }[]>;
  listAgentRuntimes(region: string): Promise<{ arn: string; id: string; name: string; status?: string }[]>;
}

/** Session ids for AgentCore must be 33+ characters; Bedrock Agents accept any string. */
export function newSessionId(): string {
  return `duckview-${randomUUID()}`;
}

const TEXT_KEYS = ['text', 'result', 'output', 'response', 'answer', 'message', 'content', 'data', 'delta', 'completion', 'event'];

/** Best-effort text extraction from an AgentCore runtime payload (Strands / LangGraph / CrewAI conventions). */
export function extractAgentText(v: unknown, depth = 0): string {
  if (v == null || depth > 8) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map((x) => extractAgentText(x, depth + 1)).filter(Boolean).join('');
  if (typeof v !== 'object') return '';
  const o = v as Record<string, unknown>;
  for (const k of TEXT_KEYS) {
    if (o[k] !== undefined) {
      const t = extractAgentText(o[k], depth + 1);
      if (t) return t;
    }
  }
  // Framework-specific envelopes (e.g. Strands stream events): look one level deeper into nested objects only.
  for (const [k, val] of Object.entries(o)) {
    if (TEXT_KEYS.includes(k) || !val || typeof val !== 'object') continue;
    const t = extractAgentText(val, depth + 1);
    if (t) return t;
  }
  return '';
}

function mapAwsError(err: unknown, what: string): HttpError {
  if (err instanceof HttpError) return err;
  const e = err as Error & { name?: string; $metadata?: { httpStatusCode?: number } };
  const name = e.name ?? '';
  const status = e.$metadata?.httpStatusCode;
  if (/CredentialsProviderError|Could not load credentials/i.test(name + e.message)) return new HttpError(401, `AWS credentials not found for ${what}. Configure the default credential chain (AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY, AWS_PROFILE or an IAM role).`, 'AWS_NO_CREDENTIALS');
  if (/AccessDenied|UnauthorizedOperation|ExpiredToken|InvalidSignature|UnrecognizedClient/i.test(name) || status === 403) return new HttpError(403, `AWS denied ${what}: ${e.message}`, 'AWS_ACCESS_DENIED');
  if (/ResourceNotFound|ValidationException/i.test(name) || status === 404) return new HttpError(404, `AWS ${what}: ${e.message}`, 'AWS_NOT_FOUND');
  if (/Throttling|TooManyRequests/i.test(name) || status === 429) return new HttpError(429, `AWS is throttling ${what} — retry shortly.`, 'AWS_THROTTLED');
  if (e.name === 'AbortError') return new HttpError(499, 'Request cancelled', 'COPILOT_CANCELLED');
  return new HttpError(502, `AWS ${what} failed: ${e.message}`, 'AWS_ERROR');
}

export class SdkAwsBridge implements AwsBridge {
  async *converseStream(req: AwsChatRequest) {
    const { BedrockRuntimeClient, ConverseStreamCommand } = await import('@aws-sdk/client-bedrock-runtime');
    const client = new BedrockRuntimeClient({ region: req.region });
    let usage = { input_tokens: null as number | null, output_tokens: null as number | null };
    try {
      const res = await client.send(
        new ConverseStreamCommand({
          modelId: req.model,
          system: [{ text: req.system }],
          messages: req.messages.map((m) => ({ role: m.role, content: [{ text: m.content }] })),
          inferenceConfig: { maxTokens: req.maxTokens, ...(req.temperature !== undefined ? { temperature: req.temperature } : {}) },
        }),
        { abortSignal: req.signal },
      );
      for await (const ev of res.stream ?? []) {
        const delta = ev.contentBlockDelta?.delta?.text;
        if (delta) yield delta;
        if (ev.metadata?.usage) usage = { input_tokens: ev.metadata.usage.inputTokens ?? null, output_tokens: ev.metadata.usage.outputTokens ?? null };
        if (ev.messageStop?.stopReason === 'guardrail_intervened') throw new HttpError(422, 'A Bedrock guardrail intervened.', 'COPILOT_REFUSAL');
      }
    } catch (err) {
      throw mapAwsError(err, 'Bedrock ConverseStream');
    } finally {
      client.destroy();
    }
    return usage;
  }

  async *invokeBedrockAgent(opts: { region: string; agentId: string; agentAliasId: string; sessionId: string; inputText: string; signal?: AbortSignal }) {
    const { BedrockAgentRuntimeClient, InvokeAgentCommand } = await import('@aws-sdk/client-bedrock-agent-runtime');
    const client = new BedrockAgentRuntimeClient({ region: opts.region });
    const dec = new TextDecoder();
    try {
      const res = await client.send(new InvokeAgentCommand({ agentId: opts.agentId, agentAliasId: opts.agentAliasId, sessionId: opts.sessionId, inputText: opts.inputText, enableTrace: false, streamingConfigurations: { streamFinalResponse: true } }), { abortSignal: opts.signal });
      for await (const ev of res.completion ?? []) {
        if (ev.chunk?.bytes) yield dec.decode(ev.chunk.bytes);
        if (ev.returnControl) yield `\n\n_(agent requested return-of-control: ${JSON.stringify(ev.returnControl.invocationInputs ?? []).slice(0, 2000)})_`;
      }
    } catch (err) {
      throw mapAwsError(err, 'Bedrock InvokeAgent');
    } finally {
      client.destroy();
    }
  }

  async *invokeAgentCore(opts: { region: string; runtimeArn: string; qualifier?: string; sessionId: string; payload: Record<string, unknown>; signal?: AbortSignal }) {
    const { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } = await import('@aws-sdk/client-bedrock-agentcore');
    const client = new BedrockAgentCoreClient({ region: opts.region });
    try {
      const res = await client.send(
        new InvokeAgentRuntimeCommand({ agentRuntimeArn: opts.runtimeArn, ...(opts.qualifier ? { qualifier: opts.qualifier } : {}), runtimeSessionId: opts.sessionId, contentType: 'application/json', accept: 'text/event-stream, application/json', payload: new TextEncoder().encode(JSON.stringify(opts.payload)) }),
        { abortSignal: opts.signal },
      );
      const body = res.response;
      if (!body) return;
      const isSse = (res.contentType ?? '').includes('text/event-stream');
      if (!isSse) {
        const textBody = await body.transformToString();
        try {
          yield extractAgentText(JSON.parse(textBody)) || textBody;
        } catch {
          yield textBody;
        }
        return;
      }
      // SSE: each "data:" line is a JSON value (string chunk or event object) or raw text.
      const reader = body.transformToWebStream().getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).replace(/\r$/, '');
          buf = buf.slice(idx + 1);
          if (!line.startsWith('data:')) continue;
          const raw = line.slice(5).trim();
          if (!raw || raw === '[DONE]') continue;
          try {
            const parsed = JSON.parse(raw);
            const t = extractAgentText(parsed);
            if (t) yield t;
          } catch {
            yield raw;
          }
        }
      }
    } catch (err) {
      throw mapAwsError(err, 'AgentCore InvokeAgentRuntime');
    } finally {
      client.destroy();
    }
  }

  async listModels(region: string): Promise<string[]> {
    const { BedrockClient, ListFoundationModelsCommand, ListInferenceProfilesCommand } = await import('@aws-sdk/client-bedrock');
    const client = new BedrockClient({ region });
    try {
      const out = new Set<string>();
      const profiles = await client.send(new ListInferenceProfilesCommand({ typeEquals: 'SYSTEM_DEFINED', maxResults: 200 })).catch(() => ({ inferenceProfileSummaries: [] }));
      for (const p of profiles.inferenceProfileSummaries ?? []) if (p.inferenceProfileId && /anthropic|claude/i.test(p.inferenceProfileId)) out.add(p.inferenceProfileId);
      const models = await client.send(new ListFoundationModelsCommand({ byProvider: 'Anthropic', byOutputModality: 'TEXT' }));
      for (const m of models.modelSummaries ?? []) if (m.modelId && m.responseStreamingSupported !== false) out.add(m.modelId);
      return [...out].sort();
    } catch (err) {
      throw mapAwsError(err, 'Bedrock ListFoundationModels');
    } finally {
      client.destroy();
    }
  }

  async listBedrockAgents(region: string) {
    const { BedrockAgentClient, ListAgentsCommand, ListAgentAliasesCommand } = await import('@aws-sdk/client-bedrock-agent');
    const client = new BedrockAgentClient({ region });
    try {
      const r = await client.send(new ListAgentsCommand({ maxResults: 100 }));
      const out: { id: string; name: string; status?: string; aliases: { id: string; name: string }[] }[] = [];
      for (const a of r.agentSummaries ?? []) {
        if (!a.agentId) continue;
        const al = await client.send(new ListAgentAliasesCommand({ agentId: a.agentId, maxResults: 50 })).catch(() => ({ agentAliasSummaries: [] }));
        out.push({ id: a.agentId, name: a.agentName ?? a.agentId, status: a.agentStatus, aliases: (al.agentAliasSummaries ?? []).filter((x) => x.agentAliasId).map((x) => ({ id: x.agentAliasId!, name: x.agentAliasName ?? x.agentAliasId! })) });
      }
      return out;
    } catch (err) {
      throw mapAwsError(err, 'Bedrock ListAgents');
    } finally {
      client.destroy();
    }
  }

  async listAgentRuntimes(region: string) {
    const { BedrockAgentCoreControlClient, ListAgentRuntimesCommand } = await import('@aws-sdk/client-bedrock-agentcore-control');
    const client = new BedrockAgentCoreControlClient({ region });
    try {
      const r = await client.send(new ListAgentRuntimesCommand({ maxResults: 100 }));
      return (r.agentRuntimes ?? []).filter((x) => x.agentRuntimeArn).map((x) => ({ arn: x.agentRuntimeArn!, id: x.agentRuntimeId ?? '', name: x.agentRuntimeName ?? x.agentRuntimeId ?? '', status: x.status }));
    } catch (err) {
      throw mapAwsError(err, 'AgentCore ListAgentRuntimes');
    } finally {
      client.destroy();
    }
  }
}

export const defaultAwsBridge: AwsBridge = new SdkAwsBridge();
