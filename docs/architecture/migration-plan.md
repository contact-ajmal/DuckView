# Agent-native migration plan

Status (September 2026): phases 0–10 done — 8785ec0 (0–1), 6a04dde (2), c914d65 (3), 6ab943a (4), a133202 (5–7), then memory, observability and evaluation, and polish.

Small vertical slices, each one commit. Before each commit: web typecheck and `ui-lint`, the full server suite, the
build, and the full browser end-to-end run (plus the phase's new scenarios). No existing test is removed or weakened.

| Phase | Slice | Main files | Done when |
|---|---|---|---|
| 0 | Audit and target | `docs/architecture/*` | These three documents exist. |
| 1 | Domain interfaces | `agent/tools.ts` (semantics), `agent/registry.ts`, `agent/decision/types.ts`, `agent/context/types.ts`, `agent/reasoning/*`, `agent/events.ts`; MCP `_meta`, REST `/api/agent/tools` and OpenAPI `x-duckview` from the registry | Every tool has semantics; the registry is the one source; behaviour unchanged. |
| 2 | Default Decision Engine | `agent/decision/default.ts`, `providers.ts`, config `agent.decision` | Tool and context selection, ranking, classification and routing tested; permission filtering tested. |
| 3 | Context Engine | `agent/context/engine.ts`, Copilot context through it | Budgets enforced; ranked context; Copilot uses selected context on large catalogs; invalidation on the data epoch. |
| 4 | Agent Runtime | `agent/runtime/*`, `agent/memory/store.ts`, migration 0045 (sessions, tasks, observations, memories, revisions.actor_type), `routes/agent-runtime.ts` (REST + SSE) | Planning, execution, observations, retries and repair, cancellation, approvals (pause/approve/deny/resume), artifacts, telemetry; tests with a scripted reasoning model. |
| 5 | Agent workspace UI | `web/src/features/agent/*`, shell integration | Dock, command bar, context chips, activity, artifacts, workspace actions, approvals; e2e scenario. |
| 6–7 | Agent MCP and external clients | `agent/mcp-agent.ts`, `mcp/http.ts` (mount `/mcp/agent`), Settings → Agents | High-level tools over Streamable HTTP with scoped tokens; SDK client test; generated configuration; e2e. |
| 8 | Memory and history | memory reads in context, session history UI, restore, "by Agent" in revisions | Sessions restore; memory is permission-aware. |
| 9 | Observability and evaluation | Prometheus metrics, spans, audit, telemetry per task, `agent/decision/eval.ts`, fixtures, `duckview agent-eval` | Metrics and eval report produced; tests. |
| 10 | Polish | Copy, states, docs (REFERENCE, README), the duckview-ui skill | Visual QA in dark and light, 1440 and 1024. |

## Risks

- **Tool-call reliability across providers.** The fenced ```` ```tool ```` protocol already works with every
  provider in hosted agents; the runtime reuses it and repairs malformed calls by feeding the error back.
- **Prompt growth.** Budgets and tool selection cap it; telemetry records context size per task.
- **Approval semantics.** The runtime never sets `dry_run: false` by itself; only an approval recorded by a USER
  principal with write access resumes a paused call.
- **Behaviour drift in Copilot.** Context selection only engages above a catalog size threshold; smaller workspaces
  keep today's context.
- **Scope.** The Copilot drawer stays; hosted agents, A2A and MCP stay; nothing is removed.

## Test strategy

Unit tests for the Decision Engine (selection, ranking, permission filtering), the Context Engine (budgets,
prioritisation, invalidation), and the runtime with a scripted `ReasoningModel` (planning, execution, retry,
cancellation, approval, failure). Integration tests through REST and the Agent MCP endpoint with the official MCP SDK
client (authentication, workspace scope, streaming). Security tests: an agent task cannot read past row policies or
column masks, cannot act outside its token's workspace or scopes, cannot write without approval, cannot leave the
file jail. Browser scenarios for the dock, activity, artifacts, approvals, context chips and session restore, against
a mock OpenAI-compatible model.
