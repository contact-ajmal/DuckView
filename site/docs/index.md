---
title: Getting started
order: 1
group: Guide
description: From zero to your first profiled dataset, saved query and dashboard in a few minutes.
---

## Run DuckView

The quickest path is the multi-arch image on [Docker Hub]({{hub}}):

```bash
docker run -d --name duckview -p 4200:4200 \
  -v duckview-data:/data -v duckview-meta:/app/meta \
  -e JWT_SECRET=$(openssl rand -hex 32) \
  -e ENCRYPTION_KEY=$(openssl rand -hex 32) \
  -e DUCKVIEW_ADMIN_EMAIL=admin@example.com \
  -e DUCKVIEW_ADMIN_PASSWORD='change-me-now' \
  {{image}}:latest
```

Open **http://localhost:4200** and sign in with the admin credentials you passed. Compose, Kubernetes and from-source installs are covered in [Deployment](deployment.html).

> Without `JWT_SECRET` and `ENCRYPTION_KEY` the server starts with ephemeral secrets and warns you: sessions and stored cloud / lakehouse credentials will not survive a restart. Set them for anything beyond a first look.

## First workspace

Every user gets a **Scratchpad** workspace (an in-memory DuckDB database) on first sign-in. Create more from the workspace switcher in the top bar — choose `:memory:`, a persistent `warehouse.duckdb` file inside the data directory, or a MotherDuck `md:` database.

Each workspace is one native DuckDB engine with its own memory, thread and timeout settings (Settings → Engine).

## Ingest data

Three ways, all ending in the same place — a file the engine can read:

1. **Drop files** onto the Overview page (Parquet, CSV/TSV, JSON/NDJSON, Excel, Arrow, `.duckdb`). They land in the workspace data directory.
2. **Add a folder** from your machine (VS Code-style workspace folders). Files stay where they are; the explorer lists them and SQL can read them by path.
3. **Connect storage** — S3, Cloudflare R2, GCS or Azure buckets, or a lakehouse catalog (AWS Glue, S3 Tables, Iceberg REST, Databricks). See [Lakehouse connectors](lakehouse.html).

The Overview page profiles whichever dataset is selected: row and column counts, type mix, null ratios, duplicate rows, min / max / avg per column and distributions — all computed by DuckDB.

## Query

Open the **Query** page. Files are addressed by path relative to the data directory:

```sql
SELECT region, sum(revenue) FROM 'sales.parquet' GROUP BY 1;
SELECT * FROM read_csv('events/*.csv');
CREATE TABLE top AS SELECT * FROM 'sales.parquet' ORDER BY revenue DESC LIMIT 100;
```

Results stream in over WebSocket; press **Stop** on the tab to interrupt. Switch the results pane between the grid, a chart, the plan (`EXPLAIN`) and a `SUMMARIZE` profile. Save a query into the library (folders and tags) with **Save**.

## Dashboards

**Dashboards → New dashboard**, then add widgets bound to saved queries or ad-hoc SQL: KPI cards, bar / line / area / scatter / pie charts, tables and Markdown notes on a drag-and-drop grid. Each widget can auto-refresh; thanks to the [result cache](cache.html) a refresh costs nothing when the underlying data has not changed.

## Share with your team

Open the workspace switcher → **Share …** to grant people or teams *viewer*, *editor* or *owner* access. Teams are managed under **Settings → Teams**, or mirrored automatically from your identity provider's group claim over OIDC. Details in [Sharing & teams](sharing.html).

## Connect an AI agent

**Settings → MCP** (or the MCP page) registers agents and mints workspace-scoped tokens. The fastest test is Claude Code:

```bash
claude mcp add --transport http duckview http://localhost:4200/mcp \
  --header "Authorization: Bearer dv_…"
```

Ask it to profile a dataset — it will call `list_accessible_data`, `profile_dataset` and `execute_query`, and any mutating statement comes back to you as an approval challenge first. See [Agents & MCP](agents.html).

## Where things live

| Path | What |
|---|---|
| `/data` (image) · `./data` (source) | The data directory — the filesystem jail for every file DuckDB reads or writes, uploads and exports |
| `/app/meta/duckview_meta.db` | SQLite metadata (users, workspaces, tabs, dashboards, connections, audit) unless `DATABASE_URL` points at PostgreSQL |
| `/tmp/duckview_spill` | DuckDB temp directory for spilling; a tmpfs in Compose, an `emptyDir` in Kubernetes |
| `duckview.config.yaml` | Configuration with `${VAR:-default}` placeholders; see [Configuration](configuration.html) |
