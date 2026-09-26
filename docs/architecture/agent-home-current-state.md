# Agent Home — current state (before this change)

Audit of the repository at `9570164`, after the agent-native migration ([current-state.md](current-state.md),
[agentic-target-state.md](agentic-target-state.md)). It records what the Agent Home builds on.

## What already existed

| Area | Where | State |
|---|---|---|
| Agent Runtime | `packages/server/src/agent/runtime/runtime.ts` | Sessions, tasks, plan, steps, observations, artifacts, approvals (pause/approve/deny/resume), cancellation, retries, telemetry. Persisted in `agent_sessions`, `agent_tasks`, `agent_observations`, `agent_memories`. |
| Context Engine | `agent/context/engine.ts` | Discovers catalog, files, semantic layer, dbt, dashboards, notebooks, queries, quality, apps, insights, the page; ranks and packs within `agent.budget`. |
| Decision Engine | `agent/decision/*` | `DecisionEngine` interface, `DefaultDecisionEngine`, provider registry (`agent.decision.provider`), evaluator and fixtures. |
| Reasoning | `agent/reasoning/*` | `ReasoningModel` over every configured LLM provider; fenced tool protocol. |
| Tool registry | `agent/tools.ts`, `agent/registry.ts`, `agent/semantics.ts` | One registry, with semantics (category, action class, mutation, produces…), served to MCP, REST, OpenAPI and the UI. |
| Events | `agent/events.ts` | `agent.*` events on the live bus and per-task SSE. |
| Agent MCP | `agent/mcp-agent.ts` at `/mcp/agent` | High-level tools over Streamable HTTP; low-level `/mcp` unchanged. |
| Memory | `agent/memory/store.ts` | Workspace (catalog-level) and personal memories. |
| Security | services, `QueryService`, policies | The agent acts as the person (actorType AGENT); approvals only by the person signed in. |

## The web UI before

- `#/` rendered `features/home/HomePage.tsx`: a workspace overview (recent queries, insights, quick actions).
- The agent lived in `features/agent/AgentDock.tsx`: a panel at the bottom of every page (⌘I), showing the session's
  tasks, steps, answers, artifacts and approvals.
- Settings → Agents (`features/settings/AgentsPanel.tsx`): Agent MCP endpoint, tokens, memory, usage.
- Shell: rail of 8 sections (Home first), top bar, section sub-tabs; hash routing (`src/app/routes.ts`); zustand
  stores (`store/workspace.ts` owns the active workspace); design rules in `.claude/skills/duckview-ui`.
- Workspace choice existed only in the top bar's switcher; datasets were never chosen explicitly for the agent.

## Gaps against the Agent Home brief

1. No agent-first landing page; the agent was a bottom panel on every page.
2. No explicit dataset selection; context was always discovered.
3. Sessions had no intent (mode), status or progress summary — not a "mission".
4. No capabilities API: the UI had no server-provided view of what a person may open in the console.
5. Sessions were private only; no safe sharing.
6. No artifact-first result view (charts, findings), and no single-call home bootstrap.
7. No separately deployable agent surface.
8. Agent MCP had no mission-level tools.

## Tests before

Server: 64 files, 504 tests. Browser: 61 scenarios (`scripts/e2e-mosaic.mjs`), including `agent-dock` and
`agent-settings`.
