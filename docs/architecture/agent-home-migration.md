# Agent Home — migration

Built as one vertical slice first (home → workspace and dataset → request → mission → streaming → artifact → Open in
Console), then widened.

| Phase | What | Status |
|---|---|---|
| 1 | Architecture audit: [current state](agent-home-current-state.md), [target state](agent-home-target-state.md) | Done |
| 2 | Runtime foundations: explicit datasets, discovered datasets, findings, chart hints; missions on sessions (migration 0046) | Done |
| 3 | Agent Home at `#/` (workspace overview moved to `#/home`) | Done |
| 4 | Workspace and dataset selectors (server-listed, lazy datasets) | Done |
| 5 | Missions: status, progress, resume, cancel, duplicate, share, archive | Done |
| 6 | Mission workspace (charts, tables, findings, objects, context, activity, approvals) | Done |
| 7 | Permission-aware Analyst WebUI (`/analyst`) and Open in Console | Done |
| 8 | Agent MCP mission tools | Done |
| 9 | Polish: phone layout, empty states, visual QA | Done |

## Compatibility

- Every earlier hash still resolves. `#/` now opens the Agent Home; the old home is `#/home` (its insights scenario
  moved there).
- `/api/agent/sessions` and `/api/agent/tasks` are unchanged; missions are sessions, so older clients see them.
- Existing sessions get `mode: auto`, `datasets: []`, `visibility: private` from the migration defaults.
- The bottom dock is gone. Its entry points moved: ⌘I opens the Agent Home; approval links (`#/?agent_task=`) open the
  mission; the inbox lists pending approvals as before.
- Low-level MCP (`/mcp`), REST and OpenAPI are untouched.

## Feature flags

`GET /api/agent/home` returns `features` (`agentHome`, `missions`, `analystWebUI`, `agentMcp`). With
`agent.enabled: false` the Agent Home sends people to the workspace overview, the Agent API refuses to start tasks,
and `/mcp/agent` is not mounted; `agent.mcp.enabled: false` turns off only the Agent MCP server.

## Verification

Server tests (missions, sharing and redaction, capabilities, datasets, MCP mission tools), the browser scenarios
`agent-home`, `analyst-webui`, `agent-settings` and `visual-qa`, and the full end-to-end run.
