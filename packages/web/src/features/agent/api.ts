/**
 * The DuckView agent's HTTP API (server: routes/agent-runtime.ts): sessions, tasks, approvals, and a task's events
 * as Server-Sent Events.
 */
import { api, getToken } from '../../api/client';

export type TaskStatus = 'planning' | 'running' | 'waiting_approval' | 'completed' | 'failed' | 'cancelled';
export interface PlanStep { text: string; status: 'pending' | 'active' | 'done' | 'skipped' }
export interface StepRecord { n: number; kind: 'route' | 'context' | 'decision' | 'tool' | 'approval' | 'action' | 'answer'; at: string; tool?: string; arguments?: Record<string, unknown>; status: 'ok' | 'error' | 'approval_required' | 'denied' | 'skipped'; summary: string; duration_ms?: number; retry?: number }
export type ArtifactType = 'answer' | 'table' | 'chart' | 'sql' | 'notebook' | 'dashboard' | 'metric' | 'quality_suite' | 'dbt_model' | 'app' | 'saved_query' | 'file';
export interface Artifact { id: string; type: ArtifactType; title: string; href?: string | null; data?: Record<string, unknown>; tool?: string | null; created_at: string }
export interface Approval { id: string; tool: string; arguments: Record<string, unknown>; action_class: string; reason: string; verb?: string | null; preview: string | null; requested_at: string; decision?: 'approved' | 'denied'; decided_by?: string | null; note?: string | null }
export interface WorkspaceAction { action: string; target?: string | null; href?: string | null; args?: Record<string, unknown> }
export interface Telemetry { decision_engine: string; context_objects_considered: number; context_objects_selected: number; context_tokens: number; decision_ms: number; reasoning_ms: number; tool_calls: number; tool_failures: number; tool_ms: number; llm_calls: number; input_tokens: number; output_tokens: number; estimated_cost_usd: number | null; duration_ms: number }
export interface AgentTask {
  id: string;
  session_id: string;
  workspace_id: string;
  request: string;
  mode: string;
  intent: string | null;
  status: TaskStatus;
  plan: PlanStep[];
  steps: StepRecord[];
  artifacts: Artifact[];
  actions: WorkspaceAction[];
  approval: Approval | null;
  answer: string | null;
  error: string | null;
  provider: string | null;
  model: string | null;
  telemetry: Telemetry | null;
  created_at: string;
  finished_at: string | null;
}
export interface AgentSession { id: string; workspace_id: string; title: string; via: string; page: { kind: string; id?: string | null; label: string } | null; archived: boolean; created_at: string; updated_at: string; tasks?: number | AgentTask[]; last_status?: TaskStatus | null }
export interface AgentEvent { type: string; seq: number; at: string; taskId: string; sessionId: string; data: Record<string, any> }

export const agentApi = {
  sessions: (workspaceId: string) => api.get<{ sessions: AgentSession[] }>(`/api/agent/sessions?workspace_id=${encodeURIComponent(workspaceId)}`).then((r) => r.sessions),
  session: (id: string) => api.get<{ session: AgentSession & { tasks: AgentTask[] } }>(`/api/agent/sessions/${id}`).then((r) => r.session),
  renameSession: (id: string, title: string) => api.patch<{ session: AgentSession }>(`/api/agent/sessions/${id}`, { title }),
  deleteSession: (id: string) => api.del(`/api/agent/sessions/${id}`),
  start: (body: Record<string, unknown>) => api.post<{ task: AgentTask }>('/api/agent/tasks', body).then((r) => r.task),
  task: (id: string) => api.get<{ task: AgentTask }>(`/api/agent/tasks/${id}`).then((r) => r.task),
  cancel: (id: string) => api.post<{ task: AgentTask }>(`/api/agent/tasks/${id}/cancel`).then((r) => r.task),
  decide: (id: string, decision: 'approve' | 'deny', note?: string) => api.post<{ task: AgentTask }>(`/api/agent/tasks/${id}/approval`, { decision, note }).then((r) => r.task),
  approvals: (workspaceId?: string) => api.get<{ tasks: AgentTask[] }>(`/api/agent/approvals${workspaceId ? `?workspace_id=${encodeURIComponent(workspaceId)}` : ''}`).then((r) => r.tasks),
};

/** A task's events: what happened so far (after `after`), then live, until it ends or pauses. */
export async function* taskEvents(taskId: string, after: number, signal?: AbortSignal): AsyncGenerator<{ event: string; data: any }> {
  const res = await fetch(`/api/agent/tasks/${taskId}/events?after=${after}`, { headers: { authorization: `Bearer ${getToken()}` }, signal });
  if (!res.ok || !res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const event = /^event: (.*)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1];
      if (event && data) {
        try {
          yield { event, data: JSON.parse(data) };
        } catch {
          /* a malformed frame */
        }
      }
    }
  }
}
