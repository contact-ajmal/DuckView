![DuckView — SQL workbench querying an Iceberg lakehouse table with DuckDB](https://raw.githubusercontent.com/contact-ajmal/DuckView/main/docs/screenshots/hero.png)

# DuckView

**The analytics workspace where DuckDB, your lakehouse and your AI agents meet.**
Query files, warehouses and Iceberg catalogs from one SQL workbench. Build dashboards. Let agents do the same — safely.

Source, docs and issues: https://github.com/contact-ajmal/DuckView

## Quick start

```bash
docker run -d --name duckview -p 4200:4200 \
  -v duckview-data:/data -v duckview-meta:/app/meta \
  -e DUCKVIEW_ADMIN_EMAIL=admin@example.com -e DUCKVIEW_ADMIN_PASSWORD='change-me' \
  -e JWT_SECRET=$(openssl rand -hex 32) -e ENCRYPTION_KEY=$(openssl rand -hex 32) \
  anbproject/duckview:latest
```

Open http://localhost:4200 and sign in with the admin email/password you set. Drop a Parquet/CSV/JSON file on the Overview page — or mount a folder into `/data` — and it is profiled and queryable immediately.

## What's inside

- ⚡ **Native DuckDB engine per workspace** — Parquet, CSV, JSON, Excel, DuckDB files, S3 / R2 / GCS / Azure objects. No Python sidecars, no JDBC.
- 🧊 **Lakehouse connectors** — AWS Glue / SageMaker Lakehouse, Amazon S3 Tables, any Iceberg REST catalog (Polaris, Lakekeeper, Nessie, Snowflake Open Catalog), and Databricks (Unity Catalog browsing, SQL warehouse execution, materialise-into-DuckDB; works with Free Edition).
- 📊 **Overview profiler, IDE-style SQL workbench, BI dashboards** — KPIs, null ratios, distributions; tabs, charts, plans, profiles; drag-and-drop dashboards with auto-refresh.
- 🤖 **Built for AI agents** — MCP server (stdio · SSE · Streamable HTTP), a REST façade and generated OpenAPI 3.0 for Claude Desktop, Cursor, Claude Code, Strands, LangGraph, LangChain, CrewAI, Bedrock AgentCore and Bedrock Agents. Every mutation waits for human approval.
- 🧠 **DuckCopilot** — schema-aware assistant on Anthropic, OpenAI, Ollama, Amazon Bedrock, or your own agent on AgentCore.
- 🔒 **Enterprise hardening** — filesystem jail + DuckDB `lock_configuration`, AES-256-GCM credential vault, scoped API tokens, audit log, OIDC, Prometheus + OpenTelemetry.
- 🎨 **Six themes** (dark and light, including a corporate *Professional* look), resizable panes, hide/restore any component.

![Agent & MCP hub](https://raw.githubusercontent.com/contact-ajmal/DuckView/main/docs/screenshots/agents.png)

## Tags

| Tag | Platforms |
|---|---|
| `latest`, `1`, `1.1`, `1.1.0` (also `1.0`, `1.0.0`) | `linux/amd64`, `linux/arm64` |

Images are built by GitHub Actions from tagged releases, with SBOM and provenance attestations, and smoke-tested after the push.

## Volumes

| Path | Purpose |
|---|---|
| `/data` | The data directory (filesystem jail): uploads, exports, and any files you mount to query |
| `/app/meta` | SQLite metadata (users, workspaces, dashboards, connections) when no `DATABASE_URL` is set |

## Environment variables

| Variable | Description |
|---|---|
| `DUCKVIEW_ADMIN_EMAIL`, `DUCKVIEW_ADMIN_PASSWORD` | Bootstrap admin account (first start only) |
| `JWT_SECRET`, `ENCRYPTION_KEY` | Session signing and credential-vault keys — set them so logins and stored credentials survive restarts |
| `DATABASE_URL` | `postgres://…` to use PostgreSQL instead of SQLite for metadata |
| `DUCKVIEW_FILESYSTEM_MODE` | `full` (default; add any folder) or `sandboxed` (multi-tenant: only `/data`) |
| `DUCKDB_MEMORY_LIMIT`, `DUCKDB_THREADS`, `DUCKDB_QUERY_TIMEOUT_SECONDS` | Per-workspace engine limits |
| `COPILOT_PROVIDER`, `COPILOT_MODEL`, `COPILOT_API_KEY`, `COPILOT_BASE_URL` | Server-managed DuckCopilot provider (`anthropic`, `openai`, `ollama`, `bedrock`, `bedrock_agent`, `agentcore`) |
| `COPILOT_AWS_REGION`, `COPILOT_BEDROCK_AGENT_ID`, `COPILOT_BEDROCK_AGENT_ALIAS_ID`, `COPILOT_AGENTCORE_RUNTIME_ARN` | AWS providers (credentials from the default AWS credential chain) |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_REDIRECT_URI` | Single sign-on |
| `DUCKVIEW_PUBLIC_URL` | External URL used in MCP/agent snippets behind a proxy |

The full configuration reference (YAML config file, every key and endpoint) is in the repository: https://github.com/contact-ajmal/DuckView/blob/main/docs/REFERENCE.md

## Docker Compose

```yaml
services:
  duckview:
    image: anbproject/duckview:latest
    ports: ["4200:4200"]
    volumes:
      - duckview-data:/data
      - duckview-meta:/app/meta
    environment:
      DUCKVIEW_ADMIN_EMAIL: admin@example.com
      DUCKVIEW_ADMIN_PASSWORD: change-me
      JWT_SECRET: replace-with-openssl-rand-hex-32
      ENCRYPTION_KEY: replace-with-openssl-rand-hex-32
volumes:
  duckview-data:
  duckview-meta:
```

The repository ships a fuller `docker-compose.yml` with optional PostgreSQL, Ollama and Prometheus/Grafana profiles, plus Kubernetes manifests.

## Health & probes

`GET /healthz` (liveness), `GET /readyz` (readiness), `GET /metrics` (Prometheus). The image runs as an unprivileged user and includes a Docker `HEALTHCHECK` on `/readyz`.

## Connect an AI agent in 30 seconds

Create a token in the **Agent & MCP hub** (`/#/mcp`), then:

```bash
claude mcp add --transport http duckview http://localhost:4200/mcp --header "Authorization: Bearer dv_…"
```

Strands, LangGraph, LangChain, CrewAI, AgentCore and Bedrock snippets are generated for you on the same page.
