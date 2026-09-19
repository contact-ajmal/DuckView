/**
 * DuckCopilot administration: the server-managed provider (set from Settings by an administrator, stored encrypted,
 * overriding copilot.* in the config file) and usage accounting (one row per turn, plus the streams in flight).
 */
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import type { MetadataStore } from '../db/index.js';
import type { CopilotSettingsRow, CopilotUsageRow } from '../db/schema/sqlite.js';
import type { CredentialCipher } from '../security/crypto.js';
import { newId } from '../security/crypto.js';
import type { Principal } from './principal.js';
import { isAdmin, requireAdmin } from './principal.js';
import { badRequest } from './errors.js';
import { AWS_PROVIDERS, PROVIDER_IDS, presetFor, type ProviderId } from './llm-catalog.js';

const ROW_ID = 'default';

/** What the settings page may set. */
export interface ServerProviderInput {
  provider: ProviderId;
  model?: string | null;
  base_url?: string | null;
  /** Omitted → keep the key on file; empty string → remove it. */
  api_key?: string | null;
  aws_region?: string | null;
  bedrock_agent_id?: string | null;
  bedrock_agent_alias_id?: string | null;
  agentcore_runtime_arn?: string | null;
}

/** The server-managed provider as the rest of the app sees it (key decrypted, never leaves the process). */
export interface ServerProvider {
  provider: ProviderId;
  model: string | null;
  base_url: string | null;
  api_key: string | null;
  key_hint: string | null;
  aws_region: string | null;
  bedrock_agent_id: string | null;
  bedrock_agent_alias_id: string | null;
  agentcore_runtime_arn: string | null;
  updated_by: string | null;
  updated_at: Date;
}

export interface ActiveStream {
  id: string;
  user_id: string;
  user_email: string;
  workspace_id: string;
  conversation_id: string;
  provider: ProviderId;
  model: string;
  action: string;
  byok: boolean;
  started_at: number;
  /** Characters streamed so far (tokens are only known at the end). */
  chars: number;
}

export interface UsageTotals {
  requests: number;
  errors: number;
  input_tokens: number;
  output_tokens: number;
  duration_ms: number;
}

export class CopilotAdminService {
  private cached: ServerProvider | null | undefined;
  private readonly active = new Map<string, ActiveStream>();

  constructor(private readonly store: MetadataStore, private readonly cipher: CredentialCipher) {}
  private get db() {
    return this.store.db;
  }
  private get s() {
    return this.store.schema;
  }

  // ------------------------------------------------------------------ server-managed provider

  /** The provider configured from Settings, or null when the config file (or nothing) applies. Cached. */
  async serverProvider(): Promise<ServerProvider | null> {
    if (this.cached !== undefined) return this.cached;
    const rows = await this.db.select().from(this.s.copilotSettings).where(eq(this.s.copilotSettings.id, ROW_ID)).limit(1);
    this.cached = rows[0] ? this.toProvider(rows[0]) : null;
    return this.cached;
  }

  private toProvider(r: CopilotSettingsRow): ServerProvider {
    let api_key: string | null = null;
    if (r.encrypted_api_key && r.iv && r.tag) {
      try {
        api_key = this.cipher.decrypt({ ciphertext: r.encrypted_api_key, iv: r.iv, tag: r.tag }, ROW_ID);
      } catch {
        api_key = null; // encryption key rotated: the settings page shows the key as missing
      }
    }
    return { provider: r.provider as ProviderId, model: r.model, base_url: r.base_url, api_key, key_hint: api_key ? r.key_hint : null, aws_region: r.aws_region, bedrock_agent_id: r.bedrock_agent_id, bedrock_agent_alias_id: r.bedrock_agent_alias_id, agentcore_runtime_arn: r.agentcore_runtime_arn, updated_by: r.updated_by, updated_at: r.updated_at };
  }

  /** Public view (no key) for the settings page. */
  async describe(p: Principal): Promise<(Omit<ServerProvider, 'api_key'> & { has_key: boolean; updated_by_email: string | null }) | null> {
    requireAdmin(p);
    const sp = await this.serverProvider();
    if (!sp) return null;
    const { api_key, ...rest } = sp;
    let updated_by_email: string | null = null;
    if (sp.updated_by) {
      const u = await this.db.select({ email: this.s.users.email }).from(this.s.users).where(eq(this.s.users.id, sp.updated_by)).limit(1);
      updated_by_email = u[0]?.email ?? null;
    }
    return { ...rest, has_key: !!api_key, updated_by_email };
  }

  /** Validates and stores the server-managed provider; a key given here replaces the one on file. */
  async setServerProvider(p: Principal, input: ServerProviderInput): Promise<ServerProvider> {
    requireAdmin(p);
    if (!PROVIDER_IDS.includes(input.provider)) throw badRequest(`Unknown provider: ${input.provider}`);
    const preset = presetFor(input.provider);
    const existing = await this.serverProvider();
    const given = input.api_key;
    const apiKey = given === undefined || given === null ? (existing?.provider === input.provider ? existing.api_key : null) : given.trim() || null;
    if (preset.keyRequired && !apiKey) throw badRequest(`${preset.label} needs an API key`);
    if (preset.keyPrefix && apiKey && !apiKey.startsWith(preset.keyPrefix)) throw badRequest(`That does not look like a ${preset.label} key (expected it to start with "${preset.keyPrefix}")`);
    const baseUrl = input.base_url?.trim() || null;
    if (preset.kind === 'openai' && !preset.baseUrl && !baseUrl) throw badRequest(`${preset.label} needs a base URL`);
    if (baseUrl && !/^https?:\/\//.test(baseUrl)) throw badRequest('Base URL must start with http:// or https://');
    const model = input.model?.trim() || null;
    if (preset.kind === 'openai' && !preset.defaultModel && !model) throw badRequest(`${preset.label} needs a model id`);
    if (AWS_PROVIDERS.includes(input.provider)) {
      if (input.provider === 'bedrock' && !input.aws_region?.trim()) throw badRequest('Bedrock needs an AWS region');
      if (input.provider === 'bedrock_agent' && !(input.aws_region?.trim() && input.bedrock_agent_id?.trim() && input.bedrock_agent_alias_id?.trim())) throw badRequest('Bedrock Agent needs region, agent id and alias id');
      if (input.provider === 'agentcore' && !input.agentcore_runtime_arn?.trim()) throw badRequest('AgentCore needs the runtime ARN');
    }
    const enc = apiKey ? this.cipher.encrypt(apiKey, ROW_ID) : null;
    const row: CopilotSettingsRow = {
      id: ROW_ID,
      provider: input.provider,
      model,
      base_url: baseUrl,
      encrypted_api_key: enc?.ciphertext ?? null,
      iv: enc?.iv ?? null,
      tag: enc?.tag ?? null,
      key_hint: apiKey ? apiKey.slice(-4) : null,
      aws_region: input.aws_region?.trim() || null,
      bedrock_agent_id: input.bedrock_agent_id?.trim() || null,
      bedrock_agent_alias_id: input.bedrock_agent_alias_id?.trim() || null,
      agentcore_runtime_arn: input.agentcore_runtime_arn?.trim() || null,
      updated_by: p.userId,
      updated_at: new Date(),
    };
    if (existing) await this.db.update(this.s.copilotSettings).set(row).where(eq(this.s.copilotSettings.id, ROW_ID));
    else await this.db.insert(this.s.copilotSettings).values(row);
    this.cached = undefined;
    return (await this.serverProvider())!;
  }

  /** Removes the Settings-managed provider; the config file (or nothing) applies again. */
  async clearServerProvider(p: Principal): Promise<void> {
    requireAdmin(p);
    await this.db.delete(this.s.copilotSettings).where(eq(this.s.copilotSettings.id, ROW_ID));
    this.cached = undefined;
  }

  // ------------------------------------------------------------------ usage

  streamStarted(entry: Omit<ActiveStream, 'started_at' | 'chars'>): ActiveStream {
    const a: ActiveStream = { ...entry, started_at: Date.now(), chars: 0 };
    this.active.set(a.id, a);
    return a;
  }
  streamProgress(id: string, chars: number) {
    const a = this.active.get(id);
    if (a) a.chars += chars;
  }
  streamEnded(id: string) {
    this.active.delete(id);
  }

  /** Streams in flight — every user's for administrators, their own for everyone else. */
  activeStreams(p: Principal): ActiveStream[] {
    const all = [...this.active.values()].sort((a, b) => a.started_at - b.started_at);
    return isAdmin(p) ? all : all.filter((a) => a.user_id === p.userId);
  }

  async record(row: Omit<CopilotUsageRow, 'id' | 'created_at'>): Promise<void> {
    await this.db.insert(this.s.copilotUsage).values({ ...row, id: newId(), created_at: new Date() });
  }

  /** Token totals for one conversation (the drawer's counter). */
  async conversationTotals(p: Principal, conversationId: string): Promise<UsageTotals> {
    const rows = await this.db.select().from(this.s.copilotUsage).where(and(eq(this.s.copilotUsage.conversation_id, conversationId), eq(this.s.copilotUsage.user_id, p.userId)));
    return sum(rows);
  }

  /**
   * Usage report over the last `days`: totals for today / the window, by day, by provider+model, by user (admins).
   * Regular users only ever see their own rows.
   */
  async report(p: Principal, days = 30) {
    const since = new Date(Date.now() - days * 86_400_000);
    const own = !isAdmin(p);
    const where = own ? and(gte(this.s.copilotUsage.created_at, since), eq(this.s.copilotUsage.user_id, p.userId)) : gte(this.s.copilotUsage.created_at, since);
    const rows = await this.db.select().from(this.s.copilotUsage).where(where).orderBy(desc(this.s.copilotUsage.created_at));
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const byKey = <K extends string>(key: (r: CopilotUsageRow) => K) => {
      const m = new Map<K, CopilotUsageRow[]>();
      for (const r of rows) m.set(key(r), [...(m.get(key(r)) ?? []), r]);
      return m;
    };
    const days_ = [...byKey((r) => r.created_at.toISOString().slice(0, 10)).entries()].map(([day, rs]) => ({ day, ...sum(rs) })).sort((a, b) => a.day.localeCompare(b.day));
    const models = [...byKey((r) => `${r.provider}\u0000${r.model}`).entries()].map(([k, rs]) => ({ provider: k.split('\u0000')[0]!, model: k.split('\u0000')[1]!, byok: rs.every((r) => r.byok), ...sum(rs) })).sort((a, b) => b.input_tokens + b.output_tokens - (a.input_tokens + a.output_tokens));
    let users: ({ user_id: string; email: string } & UsageTotals)[] = [];
    if (!own) {
      const ids = [...new Set(rows.map((r) => r.user_id))];
      const emails = new Map<string, string>();
      for (const id of ids) {
        const u = await this.db.select({ email: this.s.users.email }).from(this.s.users).where(eq(this.s.users.id, id)).limit(1);
        emails.set(id, u[0]?.email ?? id);
      }
      users = [...byKey((r) => r.user_id).entries()].map(([id, rs]) => ({ user_id: id, email: emails.get(id) ?? id, ...sum(rs) })).sort((a, b) => b.input_tokens + b.output_tokens - (a.input_tokens + a.output_tokens));
    }
    const allTime = own
      ? await this.db.select({ n: sql<number>`count(*)`, i: sql<number>`coalesce(sum(${this.s.copilotUsage.input_tokens}), 0)`, o: sql<number>`coalesce(sum(${this.s.copilotUsage.output_tokens}), 0)` }).from(this.s.copilotUsage).where(eq(this.s.copilotUsage.user_id, p.userId))
      : await this.db.select({ n: sql<number>`count(*)`, i: sql<number>`coalesce(sum(${this.s.copilotUsage.input_tokens}), 0)`, o: sql<number>`coalesce(sum(${this.s.copilotUsage.output_tokens}), 0)` }).from(this.s.copilotUsage);
    return {
      scope: own ? ('self' as const) : ('all' as const),
      days,
      today: sum(rows.filter((r) => r.created_at >= startOfToday)),
      window: sum(rows),
      all_time: { requests: Number(allTime[0]?.n ?? 0), input_tokens: Number(allTime[0]?.i ?? 0), output_tokens: Number(allTime[0]?.o ?? 0) },
      by_day: days_,
      by_model: models,
      by_user: users,
      recent: rows.slice(0, 50).map((r) => ({ id: r.id, created_at: r.created_at, user_id: r.user_id, workspace_id: r.workspace_id, conversation_id: r.conversation_id, provider: r.provider, model: r.model, action: r.action, byok: r.byok, input_tokens: r.input_tokens, output_tokens: r.output_tokens, duration_ms: r.duration_ms, status: r.status })),
      active: this.activeStreams(p),
    };
  }
}

function sum(rows: CopilotUsageRow[]): UsageTotals {
  return rows.reduce(
    (acc, r) => ({ requests: acc.requests + 1, errors: acc.errors + (r.status === 'ok' ? 0 : 1), input_tokens: acc.input_tokens + (r.input_tokens ?? 0), output_tokens: acc.output_tokens + (r.output_tokens ?? 0), duration_ms: acc.duration_ms + r.duration_ms }),
    { requests: 0, errors: 0, input_tokens: 0, output_tokens: 0, duration_ms: 0 },
  );
}
