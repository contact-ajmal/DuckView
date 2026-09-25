# DuckView — current state (before the agent-native migration)

Audit of the repository at commit `db92d49` (September 2026). It records what exists, where, and what the agent
work must reuse rather than duplicate. Paths are relative to the repository root.

## 1. Frontend

- `packages/web`: React 19, Vite 7, Tailwind v4 (`src/index.css` `@theme` tokens, six themes in `src/theme/themes.ts`),
  zustand stores, lucide icons, CodeMirror 6, Chart.js and Mosaic/vgplot. No component library: primitives live in
  `src/components/ui` (Button, Menu, Modal, Drawer, Field, Checkbox, toasts, confirmations), data components in
  `src/components/data` (DataTable, ResultPreview, skeletons), layout in `src/components/layout.tsx`.
- Shell (`src/App.tsx`, `src/components/shell`): a 72px rail of 8 sections, a top bar (workspace switcher, breadcrumb,
  storage, live status, AI button, inbox), section sub-tabs from `SUBPAGES` in `src/app/routes.ts`, and the ⌘K
  command palette (`CommandPalette.tsx`, also asks the AI and searches the workspace server-side).
- Routing is hash-based (`parseRoute` in `src/app/routes.ts`); every object view is deep-linkable.
- Stores: `store/workspace.ts` (active workspace, catalog, query tabs, history, `addTab`), `store/context.ts`
  (`usePageObject`: the object on screen), `store/copilot.ts` (the AI drawer: conversations, streaming, BYOK settings,
  context chips via `pageForAi`), `store/layout.ts`, `store/theme.ts`, `store/auth.ts`.
- AI UI: `features/copilot/CopilotDrawer.tsx` (a right-hand drawer: chat, SQL/spec/build/metric blocks rendered as
  actionable cards, context chips) and `components/ai` (`TaskTimeline`, `ToolStep`, `ApprovalCard`, `describe.ts`,
  which turns a tool call into a sentence). The Agents section (`features/mcp`) holds hosted agents, registered
  external agents, the tool list, MCP sessions, the live activity feed and pending approvals.
- The design rules are the `duckview-ui` skill (`.claude/skills/duckview-ui/SKILL.md`), enforced in part by
  `packages/web/scripts/ui-lint.mjs` (part of the build).

## 2. Backend

- `packages/server`: Fastify 5 + TypeScript + zod. `src/context.ts` builds one `AppContext` holding every service
  (plain classes, `bind(ctx)` for cross-references, started and stopped by the context). `src/app.ts` registers route
  plugins from `src/routes/*` (one file per area, all behind `app.authenticate`).
- Metadata: Drizzle over SQLite (default) or Postgres, one schema per dialect (`src/db/schema/sqlite.ts`, `pg.ts`),
  generated migrations in `packages/server/drizzle/{sqlite,pg}` (latest 0044).
- Cluster mode: nodes share Postgres; leases and atomic claims coordinate schedulers (`services/cluster.ts`).
- Deployment: `Dockerfile`, `docker-compose.yml`, `k8s/`, Prometheus config in `deploy/`.

## 3. Data

- One DuckDB engine per workspace (`src/engine/duckdb.ts`), files jailed to the workspace data directory
  (`engine/sandbox.ts`), SQL classified before it runs (`engine/sql-guard.ts`: read / change / destructive / admin).
- `services/query.ts` (`QueryService.run`) is the single execution path: guard, HITL for agents, result cache,
  audit, live events, history.
- Connectors: cloud storage, lakehouse catalogs (Glue, S3 Tables, Iceberg REST, Databricks), databases, warehouses,
  SaaS and Google sources, syncs, CDC, streams, reverse ETL, write-back to Delta/Iceberg.
- Modelling: semantic layer (`services/semantic.ts`: YAML models, metrics, dimensions, `query`, `compile`,
  `promptSummary`), dbt projects (`services/dbt.ts`), quality suites, metric monitors and insights, lineage and
  catalog annotations (`services/lineage.ts`), search (`services/search.ts`), joins, data prep, diff, PII.
- Presentation: dashboards (grid and Mosaic), notebooks, data apps (Streamlit, Dash, Gradio, stlite), snapshots,
  embeds, alerts and channels.

## 4. MCP

- Tool registry: `src/agent/tools.ts` — `buildTools(cfg)` returns 90 `ToolDef`s (name, title, description, zod input
  schema, MCP annotations, handler). `runTool(env, tool, args)` validates, traces (`mcp.tool.<name>` span), counts
  (Prometheus), publishes a live `mcp_tool` event and shapes errors (`HitlBlocked` → an approval challenge).
- The same registry backs three surfaces: the MCP server (`src/mcp/server.ts`, one `McpServer` per session bound to
  its principal, plus resources and prompts), the REST façade (`POST /api/agent/tools/:name`, `routes/agent.ts`) and
  the generated OpenAPI document (`src/agent/openapi.ts`).
- Transports (`src/mcp/http.ts`): Streamable HTTP at `/mcp` (2025-03-26), legacy SSE at `/mcp/sse` +
  `/mcp/messages`, and stdio (`duckview mcp`). A token needs the `mcp` scope; a token may be bound to one workspace.
- Registered agents (`services/agents.ts`) give external frameworks their own tokens and snippets
  (`agent/snippets.ts`).

## 5. AI

- Providers: `services/llm.ts` — one streaming contract (`LlmProvider.stream(req) → text deltas, usage`) over
  Anthropic, every OpenAI-compatible vendor (OpenAI, Gemini, DeepSeek, OpenRouter, Groq, Mistral, xAI, Ollama, custom)
  and AWS (Bedrock Converse, Bedrock Agents, AgentCore). Catalog in `services/llm-catalog.ts`. Server provider set
  by admins (`services/copilot-admin.ts`, encrypted) or bring-your-own per request.
- Copilot (`services/copilot.ts`, `routes/copilot.ts`): a streaming chat over SSE (`POST /api/copilot/chat`).
  `buildContext` assembles a `ChatContextSnapshot` (every table and column, files, buckets, catalog notes, dbt,
  metrics, quality, reverse ETL, insights, the notebook and page on screen, profiles of up to 3 targets) and
  `renderContext` puts all of it in the system prompt. Replies are text; SQL, Mosaic spec, build-plan and metric
  blocks are extracted and checked afterwards. There is no tool calling in Copilot. History: `chat_messages`.
- Hosted agents (`services/hosted-agents.ts`): the one existing agent loop. The model asks for one tool at a time
  with a fenced ```` ```tool ```` JSON block (works with every provider), the result goes back as a message, up to
  `max_steps`. Tools come from the registry (read-only ones and read-only SQL). Runs are persisted
  (`hosted_agent_runs.steps`), scheduled, delivered to channels, and exposed over A2A (`services/a2a.ts`).
- Builder (`services/builder.ts`): "build me a dashboard/app" plans checked and created in one click.

## 6. Workspace model

Workspaces own a DuckDB database (memory, file or cloud), a data directory, members with roles (VIEWER, EDITOR,
OWNER), engine settings, quotas and backups. Objects inside: saved queries, dashboards, notebooks, apps, metrics,
dbt projects, quality suites, syncs, streams, alerts, watches, endpoints, comments, revisions. The UI's "current
object" is `store/context.ts`; query tabs are per user (`tabs` table).

## 7. Authorization

- Identity: local accounts, OIDC, SCIM; JWT sessions; API tokens (`api_tokens`: scopes `read`, `write`, `admin`,
  `mcp`, optional workspace binding, expiry, hashed).
- `Principal` (`services/principal.ts`): user, role, scopes, workspace scope, `actorType` USER | AGENT | SYSTEM.
  Workspace roles checked in the services (`requireWorkspaceRole`).
- Row and column security (`services/policies.ts`): `WorkspaceService.engine(principal)` returns a guarded engine
  that rewrites every statement; nothing reaches DuckDB around it.
- HITL: `QueryService` refuses mutating SQL from an AGENT principal unless `dry_run: false` (`HitlBlocked` with an
  approval challenge); tools that change objects call `needsApproval` the same way. Approvals are stateless: the
  challenge goes back to the caller and the Agents → Approvals list is built from live events.
- Audit: `services/audit.ts` (`audit_logs`, actor type on every row), exported to sinks; revisions record `user_id`
  but not whether an agent made the change.

## 8. Events and streaming

- `observability/events.ts`: an in-process `LiveBus` of typed `LiveEvent`s (audit, mcp_tool, query, workspace
  epoch, sync, app, alert, quality, insight, stream, hosted_agent, dbt, comment, inbox…), fanned out over
  `WS /api/ws/events` with per-workspace membership checks.
- SSE is used for Copilot streaming, A2A `message/stream` and the legacy MCP transport.
- Metrics: prom-client (`observability/metrics.ts`); traces: OpenTelemetry (`observability/tracing.ts`).

## 9. Tests

- Server: Vitest, 58 files / 466 tests (`packages/server/src/__tests__`), each spinning up a real app on a temp data
  dir; optional Kafka, Postgres CDC and Iceberg fixtures.
- Web: `tsc` + `ui-lint` in the build.
- Browser end-to-end: `scripts/e2e-mosaic.mjs`, about 60 CDP scenarios against a running server (copy to
  `scripts/.e2e-frozen.mjs` for a full run). LLM flows use a mock OpenAI-compatible server through BYOK.

## 10. Reuse

- The tool registry and `runTool` — the only way agents touch the platform.
- `QueryService`, `WorkspaceService.engine`, policies, sql-guard and HITL — the security path, unchanged.
- `LlmProvider` implementations and the provider catalog, server and BYOK settings.
- The ```` ```tool ```` protocol and loop of hosted agents (provider-agnostic tool calling).
- `LiveBus` + `WS /api/ws/events` for events; SSE conventions from Copilot.
- `SearchService`, `LineageService.catalog`, `SemanticService` for context discovery.
- MCP transports in `mcp/http.ts` (Streamable HTTP, sessions, auth).
- Revisions, audit, inbox, channels; `TaskTimeline`, `ToolStep`, `ApprovalCard`, `describe.ts` in the UI.

## 11. Refactor

- Tool definitions carry no semantic metadata (category, capabilities, produces, risk); risk is implied by
  annotations. Add it to the registry so every surface derives from one place.
- Copilot dumps the whole catalog into the prompt. Context selection with a budget is needed.
- Approvals are stateless challenges; an agent task that pauses needs a durable pending approval.
- Revisions do not record that an agent made a change.
- The hosted agent loop is private to that service; its tool protocol becomes the runtime's.

## 12. Do not duplicate

A second tool registry, MCP implementation, auth or token system, metadata database, event transport (Kafka, Redis),
query path, LLM client, or chat store. No vector database or workflow engine at this stage.
