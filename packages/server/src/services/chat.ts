/**
 * DuckCopilot conversation persistence (the LLM bridge itself lands in Phase 3).
 */
import { eq, and, asc, desc } from 'drizzle-orm';
import type { MetadataStore } from '../db/index.js';
import type { ChatMessage, ChatRole, ChatContextSnapshot } from '../db/schema/sqlite.js';
import { newId } from '../security/crypto.js';
import type { WorkspaceService } from './workspaces.js';
import type { Principal } from './principal.js';

export class ChatHistoryService {
  constructor(private readonly store: MetadataStore, private readonly workspaces: WorkspaceService) {}
  private get db() {
    return this.store.db;
  }
  private get s() {
    return this.store.schema;
  }

  async append(p: Principal, workspaceId: string, conversationId: string, role: ChatRole, content: string, context: ChatContextSnapshot | null = null): Promise<ChatMessage> {
    await this.workspaces.get(p, workspaceId);
    const m: ChatMessage = { id: newId(), workspace_id: workspaceId, user_id: p.userId, conversation_id: conversationId, role, content: content.slice(0, 200_000), context_snapshot: context, timestamp: new Date() };
    await this.db.insert(this.s.chatHistory).values(m);
    return m;
  }

  async messages(p: Principal, workspaceId: string, conversationId: string, limit = 200): Promise<ChatMessage[]> {
    await this.workspaces.get(p, workspaceId);
    return this.db
      .select()
      .from(this.s.chatHistory)
      .where(and(eq(this.s.chatHistory.workspace_id, workspaceId), eq(this.s.chatHistory.conversation_id, conversationId), eq(this.s.chatHistory.user_id, p.userId)))
      .orderBy(asc(this.s.chatHistory.timestamp))
      .limit(limit);
  }

  /** Conversations for a workspace: id, first user message as title, last activity. */
  async conversations(p: Principal, workspaceId: string): Promise<{ id: string; title: string; last_at: string; messages: number }[]> {
    await this.workspaces.get(p, workspaceId);
    const rows = await this.db
      .select()
      .from(this.s.chatHistory)
      .where(and(eq(this.s.chatHistory.workspace_id, workspaceId), eq(this.s.chatHistory.user_id, p.userId)))
      .orderBy(desc(this.s.chatHistory.timestamp));
    const out = new Map<string, { id: string; title: string; last_at: string; messages: number }>();
    for (const r of rows) {
      const c = out.get(r.conversation_id) ?? { id: r.conversation_id, title: '', last_at: r.timestamp.toISOString(), messages: 0 };
      c.messages++;
      if (r.role === 'user') c.title = r.content.slice(0, 80); // rows are newest-first, so the earliest user message wins
      out.set(r.conversation_id, c);
    }
    return [...out.values()];
  }

  async clear(p: Principal, workspaceId: string, conversationId: string): Promise<void> {
    await this.workspaces.get(p, workspaceId);
    await this.db.delete(this.s.chatHistory).where(and(eq(this.s.chatHistory.workspace_id, workspaceId), eq(this.s.chatHistory.conversation_id, conversationId), eq(this.s.chatHistory.user_id, p.userId)));
  }
}
