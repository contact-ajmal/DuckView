/**
 * DuckCopilot: context hydration + streaming chat over the LLM bridge, persisted to chat_history.
 */
import type { DuckViewConfig } from '../config/index.js';
import type { WorkspaceService } from './workspaces.js';
import type { QueryService } from './query.js';
import type { CloudConnectionService } from './cloud.js';
import type { ChatHistoryService } from './chat.js';
import type { AuditService } from './audit.js';
import type { Principal } from './principal.js';
import { requireScope } from './principal.js';
import type { ChatContextSnapshot } from '../db/schema/sqlite.js';
import { defaultProviderFactory, mapProviderError, DEFAULT_MODELS, SUGGESTED_MODELS, AWS_PROVIDERS, type ProviderFactory, type ProviderId, type LlmMessage, type LlmUsage } from './llm.js';
import type { AwsBridge } from './aws.js';
import { HttpError, badRequest } from './errors.js';
import { MOSAIC_SPEC_GUIDE } from './mosaic-guide.js';
import { describeSpec, parseSpecText, type Spec } from './mosaic-spec.js';
import type { MosaicService } from './mosaic.js';
import { newId } from '../security/crypto.js';
import { metrics } from '../observability/metrics.js';
import { tracer } from '../observability/tracing.js';
import { SpanStatusCode } from '@opentelemetry/api';

export type CopilotAction = 'chat' | 'fix' | 'suggest' | 'explain' | 'dashboard';

export interface CopilotRequest {
  workspaceId: string;
  conversationId?: string;
  message: string;
  action?: CopilotAction;
  activeSql?: string | null;
  errorMessage?: string | null;
  /** Files/tables to include in depth (schema + SUMMARIZE). */
  targets?: string[];
  resultPreview?: { columns: { name: string; type: string }[]; rows: unknown[][]; rowCount?: number } | null;
  provider?: ProviderId;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  /** AWS providers, bring-your-own */
  region?: string;
  agentId?: string;
  agentAliasId?: string;
  runtimeArn?: string;
  signal?: AbortSignal;
}

/** A Mosaic spec the assistant wrote (a ```yaml / ```json block), validated against the workspace. */
export interface SpecBlock {
  text: string;
  title: string | null;
  /** null when validation could not run (Mosaic disabled). */
  ok: boolean | null;
  errors: string[];
  warnings: string[];
}

export type CopilotEvent =
  | { type: 'context'; conversation_id: string; message_id: string; provider: ProviderId; model: string; tables: number; files: number; buckets: number; targets: string[] }
  | { type: 'delta'; text: string }
  | { type: 'done'; message_id: string; usage: LlmUsage; sql_blocks: string[]; spec_blocks: SpecBlock[]; duration_ms: number }
  | { type: 'error'; code: string; message: string };

const SYSTEM_PROMPT = `You are DuckCopilot, the in-app data assistant inside DuckView — a native DuckDB analytics workspace.
You help analysts explore data with DuckDB SQL. Be precise and concise; prefer showing SQL over prose.

DuckDB dialect rules:
- Query files directly: SELECT * FROM 'sales.parquet'; read_csv('dir/*.csv'); read_json_auto('x.jsonl'). Paths are relative to the workspace data directory unless they are s3://, r2://, gs:// or az:// URIs from the listed buckets.
- Use DuckDB features when they help: window functions, QUALIFY, PIVOT/UNPIVOT, ASOF JOIN, list/struct functions, UNNEST for JSON, date_trunc, time_bucket, regexp_extract, SUMMARIZE, DESCRIBE.
- Quote identifiers with double quotes only when needed; string literals use single quotes.
- Never write mutating SQL (DROP/DELETE/UPDATE/INSERT/CREATE/COPY) unless the user explicitly asks for it, and say so clearly when you do.
- Results in DuckView are capped for display; aggregate rather than dumping whole tables.

Formatting:
- Put every SQL statement in a \`\`\`sql fenced block, one statement per block, ending with a semicolon.
- Keep explanations short; use bullet points for findings.
- If the request is ambiguous, state your assumption in one line and proceed.`;

const ACTION_PROMPTS: Record<CopilotAction, string> = {
  chat: '',
  fix: 'The user\'s query failed. Diagnose the DuckDB error, then return the corrected SQL in a single ```sql block followed by a one-sentence explanation of what changed.',
  suggest: 'Propose the 5 most insightful analytical questions for the selected dataset(s). For each: a one-line question as a heading, then a ```sql block that answers it. Prefer aggregations, trends over time, distributions and comparisons.',
  explain: 'Explain the query result below in plain business language for a non-technical stakeholder: what the query did, the key numbers, notable patterns or anomalies, and one suggested follow-up question with its SQL.',
  dashboard: 'Design an interactive Mosaic dashboard for the request below (or, if none, for the selected dataset(s)). Return exactly one ```yaml block with the complete spec — meta.title, data (only for files/queries), params, and the layout — followed by two or three bullets on how to read it. Use only columns that exist in the context, write read-only SQL, and follow the Mosaic spec guide in the system prompt.',
};

const WANTS_CHART = /\b(dashboard|chart|visuali[sz]e|visualization|plot|histogram|graph|scatter|heatmap)\b/i;

function renderContext(c: ChatContextSnapshot, cfg: DuckViewConfig): string {
  const parts: string[] = ['## Workspace context (live)'];
  if (c.tables.length) {
    parts.push(`### Tables & views (${c.tables.length})`);
    for (const t of c.tables.slice(0, cfg.copilot.max_context_tables)) parts.push(`- ${t.type.toLowerCase()} ${t.name}(${t.columns.map((col) => `${col.name} ${col.type}`).join(', ')})`);
    if (c.tables.length > cfg.copilot.max_context_tables) parts.push(`- … ${c.tables.length - cfg.copilot.max_context_tables} more`);
  } else parts.push('### Tables & views\n- (none in this workspace yet)');
  if (c.files.length) parts.push(`### Data files in the data directory (${c.files.length})\n${c.files.slice(0, 200).map((f) => `- '${f}'`).join('\n')}`);
  if (c.buckets.length) parts.push(`### Cloud storage buckets\n${c.buckets.map((b) => `- ${b}`).join('\n')}`);
  if (c.summaries && Object.keys(c.summaries).length) {
    parts.push('### Selected dataset schemas & statistics');
    for (const [target, cols] of Object.entries(c.summaries)) {
      parts.push(`#### ${target}`);
      for (const col of cols) parts.push(`- ${col.column} ${col.type} · nulls ${col.null_percentage.toFixed(1)}%${col.approx_unique != null ? ` · ≈${col.approx_unique} distinct` : ''}${col.min != null ? ` · min ${trunc(col.min)}` : ''}${col.max != null ? ` · max ${trunc(col.max)}` : ''}`);
    }
  }
  if (c.active_sql?.trim()) parts.push('### SQL in the active editor tab\n```sql\n' + c.active_sql.trim().slice(0, 6000) + '\n```');
  return parts.join('\n');
}

const trunc = (s: string, n = 40) => (s.length > n ? s.slice(0, n) + '…' : s);

/** Line-based fence parser: returns the bodies of ```sql blocks (and unlabelled blocks that look like SQL). */
export function extractSqlBlocks(text: string): string[] {
  const out: string[] = [];
  let inBlock = false;
  let lang = '';
  let buf: string[] = [];
  // Tolerate fences that start mid-line ("Here you go: ```sql") by moving them to their own line.
  for (const line of text.replace(/([^\n])```/g, '$1\n```').split(/\r?\n/)) {
    const fence = /^\s*```(\w*)\s*$/.exec(line);
    if (fence) {
      if (!inBlock) {
        inBlock = true;
        lang = (fence[1] ?? '').toLowerCase();
        buf = [];
      } else {
        const body = buf.join('\n').trim();
        if (body && (lang === 'sql' || (lang === '' && /^\s*(select|with|from|summarize|describe|pivot|unpivot|show|explain)\b/i.test(body)))) out.push(body);
        inBlock = false;
      }
      continue;
    }
    if (inBlock) buf.push(line);
  }
  return out;
}

export class CopilotService {
  constructor(
    private readonly cfg: DuckViewConfig,
    private readonly workspaces: WorkspaceService,
    private readonly queries: QueryService,
    private readonly cloud: CloudConnectionService,
    private readonly chat: ChatHistoryService,
    private readonly audit: AuditService,
    private readonly providers: ProviderFactory = defaultProviderFactory,
    private readonly aws?: AwsBridge,
  ) {}

  /** Set once the Mosaic service exists (it is built after Copilot); enables spec validation of replies. */
  mosaic: MosaicService | null = null;

  /** Workspace context as text (tables, files, buckets, active SQL) — for external agents and the "ask my agent" flow. */
  renderContextText(snapshot: ChatContextSnapshot): string {
    return renderContext(snapshot, this.cfg);
  }

  config(p?: Principal) {
    const c = this.cfg.copilot;
    return {
      enabled: c.enabled,
      allow_byok: c.allow_byok,
      server_provider: c.provider === 'none' ? null : c.provider,
      server_model: c.provider === 'none' ? null : (c.model ?? DEFAULT_MODELS[c.provider]),
      has_server_key: !!c.api_key || c.provider === 'ollama' || AWS_PROVIDERS.includes(c.provider as ProviderId),
      server_base_url: c.provider === 'ollama' ? (c.base_url ?? 'http://localhost:11434') : null,
      server_aws: AWS_PROVIDERS.includes(c.provider as ProviderId) ? { region: c.aws_region ?? null, agent_id: c.bedrock_agent_id ?? null, agent_alias_id: c.bedrock_agent_alias_id ?? null, runtime_arn: c.agentcore_runtime_arn ?? null } : null,
      aws_providers: AWS_PROVIDERS,
      default_models: DEFAULT_MODELS,
      suggested_models: SUGGESTED_MODELS,
      include_summaries: c.include_summaries,
      can_use: c.enabled && (c.provider !== 'none' || c.allow_byok) && (!p || p.scopes.includes('read')),
    };
  }

  /** Resolves provider/model/key: BYOK (if allowed) overrides server-managed settings. */
  private resolveProvider(req: CopilotRequest) {
    const c = this.cfg.copilot;
    if (!c.enabled) throw new HttpError(403, 'DuckCopilot is disabled in the server configuration', 'COPILOT_DISABLED');
    const byok = c.allow_byok && (req.apiKey || req.baseUrl || req.region || req.agentId || req.runtimeArn || (req.provider && req.provider !== c.provider));
    const provider: ProviderId | 'none' = byok && req.provider ? req.provider : req.provider ?? c.provider;
    if (provider === 'none') throw new HttpError(409, 'No LLM provider configured. Set copilot.provider on the server or bring your own key.', 'COPILOT_NOT_CONFIGURED');
    const serverManaged = provider === c.provider;
    const apiKey = byok && req.apiKey ? req.apiKey : serverManaged ? c.api_key : undefined;
    const baseUrl = byok && req.baseUrl ? req.baseUrl : serverManaged ? c.base_url : undefined;
    const model = req.model || (serverManaged ? c.model : undefined) || DEFAULT_MODELS[provider];
    const region = (byok && req.region) || (serverManaged ? c.aws_region : undefined) || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION;
    const agentId = (byok && req.agentId) || (serverManaged ? c.bedrock_agent_id : undefined);
    const agentAliasId = (byok && req.agentAliasId) || (serverManaged ? c.bedrock_agent_alias_id : undefined);
    const runtimeArn = (byok && req.runtimeArn) || (serverManaged ? c.agentcore_runtime_arn : undefined);
    return { provider, instance: this.providers(provider, { apiKey, baseUrl, model, region, agentId, agentAliasId, runtimeArn, aws: this.aws }) };
  }

  async listModels(req: { provider: ProviderId; apiKey?: string; baseUrl?: string; region?: string; agentId?: string; agentAliasId?: string; runtimeArn?: string }): Promise<string[]> {
    const { instance } = this.resolveProvider({ workspaceId: '', message: '', ...req });
    try {
      return await instance.listModels();
    } catch (err) {
      throw mapProviderError(err);
    }
  }

  async buildContext(p: Principal, workspaceId: string, opts: { activeSql?: string | null; targets?: string[] } = {}): Promise<ChatContextSnapshot> {
    const { objects, files } = await this.queries.catalog(p, workspaceId);
    const conns = await this.cloud.list(p.userId);
    const snapshot: ChatContextSnapshot = {
      workspace_id: workspaceId,
      tables: objects.map((o) => ({ name: o.schema === 'main' ? o.name : `${o.schema}.${o.name}`, type: o.type, columns: o.columns.map((c) => ({ name: c.name, type: c.type })) })),
      files: files.map((f) => f.path),
      buckets: conns.map((c) => `${c.uri_scheme}://${c.bucket ?? '<bucket>'} (${c.provider} · ${c.name})`),
      active_sql: opts.activeSql ?? null,
    };
    const targets = (opts.targets ?? []).filter(Boolean).slice(0, 3);
    if (targets.length) {
      snapshot.summaries = {};
      for (const t of targets) {
        try {
          if (this.cfg.copilot.include_summaries) {
            const s = await this.queries.profile(p, workspaceId, t);
            snapshot.summaries[t] = s.summary.slice(0, 40).map((r) => ({ column: String(r.column_name), type: String(r.column_type), min: r.min == null ? null : String(r.min), max: r.max == null ? null : String(r.max), approx_unique: r.approx_unique == null ? null : Number(r.approx_unique), null_percentage: Number(r.null_percentage ?? 0) }));
          } else {
            const { engine } = await this.workspaces.engine(p, workspaceId);
            const ins = await engine.inspect(t);
            snapshot.summaries[t] = ins.columns.slice(0, 60).map((c) => ({ column: c.name, type: c.type, min: null, max: null, approx_unique: null, null_percentage: 0 }));
          }
        } catch (err) {
          snapshot.summaries[t] = [{ column: `(could not inspect: ${(err as Error).message.split('\n')[0]})`, type: '', min: null, max: null, approx_unique: null, null_percentage: 0 }];
        }
      }
    }
    return snapshot;
  }

  /** Streams a copilot turn as events. The user turn is persisted first, the assistant turn on completion. */
  async *stream(p: Principal, req: CopilotRequest): AsyncGenerator<CopilotEvent, void, void> {
    requireScope(p, 'read');
    const action: CopilotAction = req.action ?? 'chat';
    if (!req.message?.trim() && action === 'chat') throw badRequest('message is required');
    if (action === 'fix' && !req.activeSql?.trim()) throw badRequest('fix requires active_sql');
    await this.workspaces.get(p, req.workspaceId);
    const { provider, instance } = this.resolveProvider(req);
    const conversationId = req.conversationId ?? newId();
    const started = performance.now();

    const snapshot = await this.buildContext(p, req.workspaceId, { activeSql: req.activeSql, targets: req.targets });
    snapshot.provider = provider;
    snapshot.model = instance.model;

    // Compose the user turn from the action, the message and any attachments (error, result preview).
    const userParts: string[] = [];
    if (ACTION_PROMPTS[action]) userParts.push(ACTION_PROMPTS[action]);
    if (req.message?.trim()) userParts.push(req.message.trim());
    if (action === 'fix' && req.errorMessage) userParts.push(`DuckDB error:\n\`\`\`\n${req.errorMessage.slice(0, 4000)}\n\`\`\``);
    if (action === 'fix' && req.activeSql && !req.message?.includes(req.activeSql)) userParts.push('Failing SQL:\n```sql\n' + req.activeSql.slice(0, 6000) + '\n```');
    if (action === 'explain' && req.resultPreview) {
      const cols = req.resultPreview.columns.map((c) => c.name);
      const rows = req.resultPreview.rows.slice(0, 30).map((r) => r.map((v) => (v == null ? 'NULL' : typeof v === 'object' ? JSON.stringify(v) : String(v))).join(' | '));
      userParts.push(`Result preview (${req.resultPreview.rowCount ?? req.resultPreview.rows.length} rows${req.resultPreview.rows.length < (req.resultPreview.rowCount ?? 0) ? ', first 30 shown' : ''}):\n${cols.join(' | ')}\n${rows.join('\n')}`);
      if (req.activeSql) userParts.push('Query:\n```sql\n' + req.activeSql.slice(0, 6000) + '\n```');
    }
    if ((action === 'suggest' || action === 'dashboard') && req.targets?.length) userParts.push(`Datasets: ${req.targets.join(', ')}`);
    const userContent = userParts.join('\n\n');

    const history = req.conversationId ? await this.chat.messages(p, req.workspaceId, req.conversationId, this.cfg.copilot.history_limit) : [];
    await this.chat.append(p, req.workspaceId, conversationId, 'user', userContent, snapshot);
    const messageId = newId();
    yield { type: 'context', conversation_id: conversationId, message_id: messageId, provider, model: instance.model, tables: snapshot.tables.length, files: snapshot.files.length, buckets: snapshot.buckets.length, targets: Object.keys(snapshot.summaries ?? {}) };

    const llmMessages: LlmMessage[] = [...history.filter((m) => m.role === 'user' || m.role === 'assistant').map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })), { role: 'user', content: userContent }];
    // Consecutive same-role turns are fine for Anthropic; OpenAI-compatible servers also accept them.
    // The spec guide is prompt material only when a chart or dashboard is in play.
    const wantsChart = action === 'dashboard' || WANTS_CHART.test(req.message ?? '');
    const system = `${SYSTEM_PROMPT}${wantsChart ? `\n\n${MOSAIC_SPEC_GUIDE}\n\nWhen you produce a dashboard spec, put it in a single \`\`\`yaml block; the user can create it with one click.` : ''}\n\n${renderContext(snapshot, this.cfg)}`;

    let text = '';
    let usage: LlmUsage = { input_tokens: null, output_tokens: null };
    const stop = metrics.copilotDuration.startTimer({ provider });
    const span = tracer().startSpan('copilot.chat', { attributes: { 'duckview.provider': provider, 'duckview.model': instance.model, 'duckview.action': action, 'duckview.workspace_id': req.workspaceId } });
    try {
      const gen = instance.stream({ system, messages: llmMessages, model: instance.model, maxTokens: this.cfg.copilot.max_output_tokens, temperature: this.cfg.copilot.temperature, signal: req.signal, context: renderContext(snapshot, this.cfg), conversationId });
      let next = await gen.next();
      while (!next.done) {
        text += next.value;
        yield { type: 'delta', text: next.value };
        next = await gen.next();
      }
      usage = next.value;
      span.setStatus({ code: SpanStatusCode.OK });
    } catch (err) {
      const e = mapProviderError(err);
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: e.message });
      metrics.copilotRequests.inc({ provider, status: 'error' });
      this.audit.log({ userId: p.userId, actorType: p.actorType, action: `copilot.${action}`, resource: `conversation:${conversationId}`, durationMs: performance.now() - started, ip: p.ip, status: 'error', error: e.message });
      if (text) await this.chat.append(p, req.workspaceId, conversationId, 'assistant', `${text}\n\n_(interrupted: ${e.message})_`);
      yield { type: 'error', code: e.code, message: e.message };
      return;
    } finally {
      stop();
      span.end();
    }
    const sqlBlocks = extractSqlBlocks(text);
    const specBlocks = await this.validateSpecBlocks(p, req.workspaceId, text);
    await this.chat.append(p, req.workspaceId, conversationId, 'assistant', text, null);
    metrics.copilotRequests.inc({ provider, status: 'ok' });
    if (usage.input_tokens != null) metrics.copilotTokens.inc({ provider, direction: 'input' }, usage.input_tokens);
    if (usage.output_tokens != null) metrics.copilotTokens.inc({ provider, direction: 'output' }, usage.output_tokens);
    const durationMs = Math.round(performance.now() - started);
    this.audit.log({ userId: p.userId, actorType: p.actorType, action: `copilot.${action}`, resource: `conversation:${conversationId}`, queryText: req.message.slice(0, 2000), durationMs, ip: p.ip });
    yield { type: 'done', message_id: messageId, usage, sql_blocks: sqlBlocks, spec_blocks: specBlocks, duration_ms: durationMs };
  }

  /** Every ```yaml / ```json block that is a Mosaic spec, validated and bound in the workspace (EXPLAIN only). */
  async validateSpecBlocks(p: Principal, workspaceId: string, text: string): Promise<SpecBlock[]> {
    const out: SpecBlock[] = [];
    for (const body of extractFencedBlocks(text, ['yaml', 'yml', 'json'])) {
      let spec: Spec;
      try {
        spec = parseSpecText(body);
      } catch {
        continue;
      }
      if (!looksLikeSpec(spec)) continue;
      const title = describeSpec(spec).title;
      if (!this.mosaic) {
        out.push({ text: body, title, ok: null, errors: [], warnings: [] });
        continue;
      }
      try {
        const r = await this.mosaic.prepare(p, workspaceId, spec);
        out.push({ text: body, title, ok: r.ok, errors: r.errors, warnings: r.warnings });
      } catch (err) {
        out.push({ text: body, title, ok: null, errors: [(err as Error).message], warnings: [] });
      }
    }
    return out;
  }
}

const SPEC_KEYS = ['plot', 'mark', 'input', 'legend', 'hconcat', 'vconcat'];
export const looksLikeSpec = (spec: Spec) => SPEC_KEYS.some((k) => k in spec);

/** Bodies of fenced blocks whose language tag is one of `langs`. */
export function extractFencedBlocks(text: string, langs: string[]): string[] {
  const out: string[] = [];
  let inBlock = false;
  let lang = '';
  let buf: string[] = [];
  for (const line of text.replace(/([^\n])```/g, '$1\n```').split(/\r?\n/)) {
    const fence = /^\s*```(\w*)\s*$/.exec(line);
    if (fence) {
      if (!inBlock) {
        inBlock = true;
        lang = (fence[1] ?? '').toLowerCase();
        buf = [];
      } else {
        const body = buf.join('\n').trim();
        if (body && langs.includes(lang)) out.push(body);
        inBlock = false;
      }
      continue;
    }
    if (inBlock) buf.push(line);
  }
  return out;
}

