# DuckView — agent-native target state

DuckView becomes a workspace that people operate through an agent, while every existing surface (SQL, explorer,
dashboards, notebooks, apps, catalog, semantic layer) stays and becomes something the agent can drive. The agent is
not a privileged path: it acts as the person who asked, through the same tools, services, policies, HITL and audit.

## Layers

```
 UI (agent dock, activity, artifacts)   REST /api/agent/*   Agent MCP /mcp/agent   Low-level MCP /mcp   A2A
                     \                         |                   |                    |              |
                      +------------------ Agent Runtime -----------+                    |              |
                      |   sessions · tasks · plan · steps · approvals · events · memory |              |
                      |                                                                  |              |
        Context Engine ── Decision Engine (DefaultDecisionEngine | future providers)     |              |
                      |                                                                  |              |
                 Reasoning Model (adapter over the existing LlmProvider)                |              |
                      |                                                                  |              |
                 Tool Registry (agent/tools.ts, one source of truth) <-------------------+--------------+
                      |
                 Services → QueryService → sql-guard → HITL → policies (guarded engine) → audit → DuckDB
```

Rules:

1. **Decision is not reasoning.** The Decision Engine picks candidate context and tools with cheap, deterministic
   scoring; the reasoning model decides what to do with them. Neither calls the other's job.
2. **No tool dump.** A model call sees only the tools the Decision Engine selected (plus the always-on core), within
   a budget.
3. **No context dump.** Context is a ranked, budgeted `ContextPack` of structured objects, never the whole catalog.
4. **One registry.** MCP, REST, OpenAPI, the runtime, the Decision Engine, the UI and the docs all read tool
   metadata from `agent/tools.ts`.
5. **No bypass.** The runtime executes tools with `runTool` under the requesting principal marked `actorType:
   'AGENT'`; HITL, policies and audit apply unchanged. A human approval is a separate, recorded act by a USER.
6. **Provider independence.** `agent.decision.provider` and the Copilot/server model settings choose
   implementations; nothing outside `agent/decision/providers` knows a provider's name.

## Server modules (`packages/server/src/agent/`)

| Module | Contents |
|---|---|
| `tools.ts` | The registry. `ToolDef` gains `semantics` (category, capabilities, requires, produces, action class, mutation); defaults are derived from name and annotations so every tool has them, and explicit entries refine them. |
| `registry.ts` | `ToolRegistry`: descriptors (`ToolDescriptor`), lookup, filtering by principal (scopes, read-only roles), JSON schema. Used by MCP `_meta`, REST `/api/agent/tools`, OpenAPI `x-duckview` and the Decision Engine. |
| `decision/` | `DecisionEngine` interface, `DefaultDecisionEngine` (lexical ranking with field weights, synonyms, intent rules, permission filtering), provider registry keyed by config, the evaluator and fixtures. |
| `context/` | `ContextObject`, `ContextPack`, `ContextBudget`, `ContextEngine` (discovery from catalog, semantic layer, dbt, dashboards, notebooks, saved queries, quality, memory and the page on screen; ranking through the Decision Engine; packing within budget; invalidation on the workspace data epoch). |
| `reasoning/` | `ReasoningModel` (`generate(input) → AsyncIterable<ReasoningEvent>`: text, tool call, plan, usage), the adapter over `LlmProvider` using the fenced tool protocol, prompt assembly. |
| `runtime/` | `AgentRuntime`: sessions, tasks, the loop (plan → decide → reason → act → observe → replan), retries and repair, cancellation, approvals (pause and resume), budgets, workspace actions and artifacts. |
| `memory/` | Structured memory: session memory, task observations, workspace memory (discoveries, successful and failed actions); permission-aware reads. |
| `events.ts` | `AgentEventBus`: typed `agent.*` events, published on the existing `LiveBus` (so `WS /api/ws/events` carries them) and streamed per task over SSE. |
| `mcp-agent.ts` | The Agent MCP server: high-level tools (`ask_data_agent`, `analyse_dataset`, `investigate_data`, `build_dashboard`, `create_data_app`, `explain_data`, `get_agent_task`, `approve…` is not exposed) mounted at `/mcp/agent` over the existing Streamable HTTP plumbing. |

## Domain model

```
AgentSession   id, user, workspace, title, status, page context (dataset, dashboard, notebook, query, SQL), created/updated
 └─ AgentTask  id, session, request, mode, status (planning|running|waiting_approval|completed|failed|cancelled),
               plan (steps with status), answer, artifacts, telemetry (context, decision, reasoning, tools, tokens, cost)
     ├─ AgentStep         kind (context|decision|tool|observation|approval|action|answer), tool, args, status, timing
     ├─ AgentObservation  structured facts from a tool result (tables seen, columns, row counts, metrics used, errors)
     ├─ AgentApproval     the HITL challenge, the pending tool call, decided_by/at, decision
     └─ AgentArtifact     answer | table | chart | sql | notebook | dashboard | metric | quality_suite | dbt_model | app,
                          with a link into the workspace
AgentMemory    workspace-scoped facts (discoveries, preferences, outcomes) with source task and visibility
```

Persisted in the metadata database (new tables `agent_sessions`, `agent_tasks`, `agent_observations`,
`agent_memories`; approvals and steps live in the task row as JSON). Revisions gain `actor_type` so history reads
"Agent" for agent changes.

## Interfaces (abridged)

```ts
interface DecisionEngine {
  readonly name: string;
  selectContext(i: ContextSelectionInput): Promise<ContextSelectionResult>;
  selectTools(i: ToolSelectionInput): Promise<ToolSelectionResult>;
  rankCandidates(i: RankingInput): Promise<RankingResult>;
  classify(i: ClassificationInput): Promise<ClassificationResult>;   // intent + mode
  route(i: RoutingInput): Promise<RoutingResult>;                     // answer directly, tools, workspace action, clarify
}

interface ReasoningModel {
  readonly provider: string; readonly model: string;
  generate(i: ReasoningInput): AsyncIterable<ReasoningEvent>;
}

type ContextBudget = { maxObjects; maxTokens; maxToolDefinitions; maxObservations; maxResultRows };
type ContextPack = { request; objects: ContextObject[]; tools: ToolDescriptor[]; semanticContext; budget; stats };
```

Configuration (`duckview.config.yaml`):

```yaml
agent:
  enabled: true
  decision: { provider: default }        # future: laya, jev, local, custom — registered adapters
  budget: { max_objects: 24, max_tokens: 6000, max_tool_definitions: 12, max_observations: 12, max_result_rows: 50 }
  max_steps: 12
  mcp: { enabled: true }                  # /mcp/agent
```

The reasoning model is the existing server model (Settings → DuckView AI) or the person's own key.

## Action classes (HITL)

| Class | Examples | Agent behaviour |
|---|---|---|
| READ | inspect_schema, execute_query (SELECT), profile_dataset, find_joins | runs |
| LOW_RISK_WRITE | save_query, create_dashboard_widget, create_notebook, annotate_table | runs; recorded as agent-made (revisions, audit) |
| HIGH_RISK_WRITE | mutating SQL, remove_widget, define_metric, prepare_data save, run_dbt build | pauses for approval |
| EXTERNAL_SIDE_EFFECT | run_reverse_sync, create_alert with channels, git_commit | pauses for approval |
| PUBLISH | publish_app, publish_endpoint | pauses for approval |
| DATA_EXPORT | exports, snapshot delivery | pauses for approval |

The class is part of each tool's semantics. Enforcement still comes from the services (`HitlBlocked`); the class lets
the runtime and the UI explain, pre-empt and group approvals.

## Events

`agent.started · agent.plan.created · agent.plan.updated · agent.context.selected · agent.tool.selected ·
agent.tool.started · agent.tool.completed · agent.tool.failed · agent.observation.created · agent.approval.required ·
agent.approval.granted · agent.approval.denied · agent.workspace.changed · agent.artifact.created · agent.answer.delta ·
agent.completed · agent.failed · agent.cancelled` — each with task, session, workspace and trace ids. No hidden
reasoning is ever emitted: events carry decisions, calls, observations and results.

## UI

The agent lives in the workspace, not on a chat page:

- **Agent dock** at the bottom of every work surface: the command bar ("Ask anything about this workspace…", ⌘J),
  context chips (workspace, dataset, dashboard, metric, selection; removable), suggested commands for the current
  selection, and the running task's activity (steps as sentences, expandable to safe detail).
- **Artifacts** as native cards (answer, table, chart, SQL, notebook, dashboard, metric, quality suite, dbt model,
  app) with Open / Insert actions; workspace actions (open dataset, open query, open dashboard, create chart) move
  the workspace itself.
- **Approvals** inline (`ApprovalCard`) and in the inbox; **session history** grouped by day, restoring the session's
  context and artifacts; **agent status** in the top bar.
- **Settings → Agents**: the Agent MCP endpoint, scoped tokens (shown once), generated client configuration, the
  decision provider, the reasoning model.
- The Copilot drawer remains for conversation and backward compatibility; its context now comes from the Context
  Engine.

## Future decision providers

A provider implements `DecisionEngineProvider` (the `DecisionEngine` interface plus `name`) and registers itself in
`agent/decision/providers.ts`. Nothing else changes: the runtime, UI, MCP, workspace and semantic layer only see the
interface. The evaluator (`agent/decision/eval.ts`, fixtures in `agent/decision/fixtures.ts`, `duckview agent-eval`)
compares providers on the same tasks.
