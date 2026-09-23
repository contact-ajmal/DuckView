import { create } from 'zustand';
import { api, copilotChat, type CopilotConfig, type ChatMsg, type CopilotSpecBlock, type CopilotProvider } from '../api/client';

export interface CopilotSettings { provider: CopilotProvider | ''; model: string; apiKey: string; baseUrl: string; region?: string; agentId?: string; agentAliasId?: string; runtimeArn?: string }
export interface LiveMessage { id: string; role: 'user' | 'assistant'; content: string; streaming?: boolean; error?: string; sqlBlocks?: string[]; specBlocks?: CopilotSpecBlock[]; meta?: { model?: string; provider?: string; tables?: number; files?: number; targets?: string[]; duration_ms?: number; input_tokens?: number; output_tokens?: number } }

const SETTINGS_KEY = 'duckview.copilot.settings';
function loadSettings(): CopilotSettings {
  try {
    return { provider: '', model: '', apiKey: '', baseUrl: '', ...(JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') as Partial<CopilotSettings>) };
  } catch {
    return { provider: '', model: '', apiKey: '', baseUrl: '' };
  }
}

interface CopilotState {
  open: boolean;
  width: number;
  config: CopilotConfig | null;
  settings: CopilotSettings;
  conversationId: string | null;
  /** Tokens spent in the open conversation (from the server's usage rows, plus turns streamed in this session). */
  usage: { input_tokens: number; output_tokens: number; requests: number };
  conversations: { id: string; title: string; last_at: string; messages: number }[];
  messages: LiveMessage[];
  streaming: boolean;
  targets: string[];
  abort: AbortController | null;
  toggle(open?: boolean): void;
  setWidth(w: number): void;
  loadConfig(): Promise<void>;
  setSettings(s: Partial<CopilotSettings>): void;
  loadConversations(workspaceId: string): Promise<void>;
  openConversation(workspaceId: string, id: string | null): Promise<void>;
  setTargets(t: string[]): void;
  send(input: { workspaceId: string; message: string; action?: 'chat' | 'fix' | 'suggest' | 'explain' | 'dashboard'; activeSql?: string | null; errorMessage?: string | null; resultPreview?: { columns: { name: string; type: string }[]; rows: unknown[][]; rowCount?: number } | null; targets?: string[] }): Promise<void>;
  cancel(): void;
  clear(workspaceId: string): Promise<void>;
}

export const useCopilot = create<CopilotState>((set, get) => ({
  open: false,
  width: 420,
  config: null,
  settings: loadSettings(),
  conversationId: null,
  usage: { input_tokens: 0, output_tokens: 0, requests: 0 },
  conversations: [],
  messages: [],
  streaming: false,
  targets: [],
  abort: null,
  toggle(open) {
    set({ open: open ?? !get().open });
  },
  setWidth(w) {
    set({ width: Math.max(320, Math.min(720, w)) });
  },
  async loadConfig() {
    try {
      set({ config: await api.get<CopilotConfig>('/api/copilot/config') });
    } catch {
      set({ config: null });
    }
  },
  setSettings(s) {
    const settings = { ...get().settings, ...s };
    set({ settings });
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      /* ignore */
    }
  },
  async loadConversations(workspaceId) {
    try {
      const r = await api.get<{ conversations: CopilotState['conversations'] }>(`/api/copilot/conversations?workspace_id=${workspaceId}`);
      set({ conversations: r.conversations });
    } catch {
      set({ conversations: [] });
    }
  },
  async openConversation(workspaceId, id) {
    if (!id) return set({ conversationId: null, messages: [], usage: { input_tokens: 0, output_tokens: 0, requests: 0 } });
    api.get<{ conversation: { input_tokens: number; output_tokens: number; requests: number } }>(`/api/copilot/usage?conversation_id=${id}`).then((u) => get().conversationId === id && set({ usage: u.conversation })).catch(() => undefined);
    const r = await api.get<{ messages: ChatMsg[] }>(`/api/copilot/messages?workspace_id=${workspaceId}&conversation_id=${id}`);
    set({
      conversationId: id,
      messages: r.messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({ id: m.id, role: m.role as 'user' | 'assistant', content: m.content, sqlBlocks: m.role === 'assistant' ? extractSql(m.content) : undefined, meta: m.context ? { model: m.context.model, provider: m.context.provider, tables: m.context.tables, files: m.context.files, targets: m.context.targets } : undefined })),
    });
  },
  setTargets(t) {
    set({ targets: t.slice(0, 3) });
  },
  async send(input) {
    if (get().streaming) return;
    const { settings, config } = get();
    const userId = `u-${Date.now()}`;
    const asstId = `a-${Date.now()}`;
    const shown = input.message || (input.action === 'fix' ? 'Fix my query' : input.action === 'suggest' ? `Suggest questions for ${(input.targets ?? get().targets).join(', ') || 'this workspace'}` : input.action === 'explain' ? 'Run & inspect' : input.action === 'dashboard' ? `Build a dashboard for ${(input.targets ?? get().targets).join(', ') || 'this workspace'}` : '');
    const abort = new AbortController();
    set({ streaming: true, abort, messages: [...get().messages, { id: userId, role: 'user', content: shown }, { id: asstId, role: 'assistant', content: '', streaming: true }] });
    const upd = (patch: Partial<LiveMessage>) => set({ messages: get().messages.map((m) => (m.id === asstId ? { ...m, ...patch } : m)) });
    const byok = config?.allow_byok && settings.provider ? { provider: settings.provider, model: settings.model || undefined, api_key: settings.apiKey || undefined, base_url: settings.baseUrl || undefined, region: settings.region || undefined, agent_id: settings.agentId || undefined, agent_alias_id: settings.agentAliasId || undefined, runtime_arn: settings.runtimeArn || undefined } : {};
    try {
      for await (const ev of copilotChat({ workspace_id: input.workspaceId, conversation_id: get().conversationId ?? undefined, message: input.message, action: input.action, active_sql: input.activeSql ?? null, error_message: input.errorMessage ?? null, result_preview: input.resultPreview ?? null, targets: input.targets ?? get().targets, notebook_id: /^#\/notebooks\/([\w-]+)/.exec(location.hash)?.[1] ?? null, ...byok }, abort.signal)) {
        if (ev.type === 'context') {
          set({ conversationId: ev.conversation_id });
          upd({ meta: { model: ev.model, provider: ev.provider, tables: ev.tables, files: ev.files, targets: ev.targets } });
        } else if (ev.type === 'delta') {
          const cur = get().messages.find((m) => m.id === asstId)?.content ?? '';
          upd({ content: cur + ev.text });
        } else if (ev.type === 'done') {
          const cur = get().messages.find((m) => m.id === asstId);
          upd({ streaming: false, sqlBlocks: ev.sql_blocks, specBlocks: ev.spec_blocks, meta: { ...cur?.meta, duration_ms: ev.duration_ms, input_tokens: ev.usage.input_tokens ?? undefined, output_tokens: ev.usage.output_tokens ?? undefined } });
          const u = get().usage;
          set({ usage: { input_tokens: u.input_tokens + (ev.usage.input_tokens ?? 0), output_tokens: u.output_tokens + (ev.usage.output_tokens ?? 0), requests: u.requests + 1 } });
        } else if (ev.type === 'error') {
          upd({ streaming: false, error: ev.message });
        }
      }
    } catch (e) {
      upd({ streaming: false, error: (e as Error).name === 'AbortError' ? 'Cancelled' : (e as Error).message });
    } finally {
      set({ streaming: false, abort: null });
      void get().loadConversations(input.workspaceId);
    }
  },
  cancel() {
    get().abort?.abort();
  },
  async clear(workspaceId) {
    const id = get().conversationId;
    if (id) await api.del(`/api/copilot/conversations/${id}?workspace_id=${workspaceId}`).catch(() => undefined);
    set({ conversationId: null, messages: [], usage: { input_tokens: 0, output_tokens: 0, requests: 0 } });
    void get().loadConversations(workspaceId);
  },
}));

function extractSql(text: string): string[] {
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
        if (body && (lang === 'sql' || (lang === '' && /^\s*(select|with|from|summarize|describe|pivot)\b/i.test(body)))) out.push(body);
        inBlock = false;
      }
      continue;
    }
    if (inBlock) buf.push(line);
  }
  return out;
}
