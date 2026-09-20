---
title: Connections & syncs
order: 7
group: Guide
description: One page for every data source — object storage, lakehouse catalogs, PostgreSQL / MySQL / SQLite / DuckDB files, Snowflake / BigQuery / Redshift / ClickHouse / Fabric, Salesforce / HubSpot / Stripe / GA4 / Airtable / Notion, HTTP endpoints and Google Drive / Sheets with your Google account — with health checks, scheduled syncs into a workspace, transformations drafted by Copilot or set by agents, and a run history.
---

**Connections** is where an analyst plugs a source in once and the whole team — and every agent — uses it: *Configured* lists everything with its health and last test (click a connection to open its settings), *Add a source* is the catalog (each card opens the form for that source), *Syncs* are the scheduled loads into the active workspace.

## The catalog

| Family | Sources |
|---|---|
| Object storage | Amazon S3, Cloudflare R2, Google Cloud Storage, Azure Blob |
| Lakehouse catalogs | AWS Glue / SageMaker Lakehouse, Amazon S3 Tables, any Iceberg REST catalog (Polaris, Nessie, Tabular, Lakekeeper, Snowflake Open Catalog), Databricks |
| Databases | PostgreSQL, MySQL / MariaDB, SQLite files, DuckDB files |
| Web, Drive & Sheets | HTTP / REST endpoints (CSV, JSON, Parquet, Excel; bearer token or headers), Google Drive, Google Sheets (with your Google account), Google Sheets shared links |
| Warehouses | Snowflake, Google BigQuery, Amazon Redshift, ClickHouse, Microsoft Fabric / OneLake |
| SaaS applications | Salesforce, HubSpot, Stripe, Google Analytics 4, Airtable, Notion |

Every card says what the source can do — **browse** it, **attach** it as `alias.schema.table`, run **remote SQL** on it, **sync** from it — and how it authenticates. Missing one? Ask on GitHub.

## Databases

A PostgreSQL, MySQL, SQLite or DuckDB-file connection is attached **read-only** to every engine of your workspaces through DuckDB's extensions, so `SELECT * FROM pg.public.orders` works in the workbench, in dashboards, in Copilot and for agents alike. The password is encrypted at rest; the page tests the connection, browses schemas and tables, and shows what to type. Network databases need `security.enable_external_access` (or full filesystem mode).

## Warehouses, applications and Google

Snowflake, BigQuery, Redshift, ClickHouse and Fabric, the SaaS applications, and Google Drive / Sheets are **connectors**: a wizard collects the credentials (a token, a key, a connected app, a service principal — or *Connect with Google*), tests the connection, and from then on the sync editor and agents **browse** it level by level — databases → schemas → tables, bases → tables, objects, folders → files, spreadsheets → tabs — and pick what to load. Warehouses also answer SQL: type a query in the editor's *SQL* mode, or let an agent run `connector_query`, and the result lands in DuckDB.

Rows are pulled through the vendor's API by the server (paging, throttling and retries handled), staged to a temporary file and loaded into the target table; a Fabric Delta table is read straight from OneLake. Credentials are encrypted at rest, reported only by name, never logged and never handed to the workspace engine.

**Google account sign-in.** *Sign in with Google* in the Drive, Sheets, BigQuery and Analytics wizards opens Google's own sign-in page — you enter your Google e-mail and password there (2-step verification included), Google hands DuckView a read-only token, and you come back with the account connected. Google requires the app to be registered once: an administrator pastes an OAuth client id and secret (two minutes in Google Cloud; the exact redirect URI is shown) either inline in the first Google wizard or under *Settings → Integrations*. The secret is write-only; refresh tokens are stored encrypted per connection and renewed automatically. Prefer server-to-server? Paste a service-account key in the wizard instead.

## Syncs

A sync loads a **source** — a table of a connected database or lakehouse, a connector resource (a warehouse table or query, an application object, a Drive file, a Sheets tab), a URL (CSV, JSON, Parquet, Excel over HTTPS, or a Google Sheet shared by link), or any read-only SELECT — into a **target table** of the workspace, on a **schedule** (every N minutes, or a cron expression) or on demand, in *replace* or *append* mode.

An optional **transformation** — one SELECT over `{{raw}}`, the freshly loaded rows — shapes the target: rename and cast columns, drop junk, derive fields, aggregate. It is validated against the live source before it is saved; **Preview** shows the resulting columns and rows, and **Draft with Copilot** writes a first version from the previewed columns and your goal.

Runs happen on the server as the workspace owner with the same guards as a typed query (roles, sandbox, audit trail, data epoch), are recorded one by one (rows, duration, error, who triggered it) and appear live on the page; a failing load never touches the target.

## For agents

Everything above is reachable over MCP: `list_data_sources` (connections with health, syncs, the catalog), `browse_connector` (walk a warehouse, application or Google connection to the resource to sync), `connector_query` (read-only SQL on a warehouse), `create_data_sync`, `update_data_sync` (attach a transformation — validated first), `run_data_sync`, and the `build_data_pipeline` prompt that walks an agent from browsing a source to a verified, scheduled, transformed table.
