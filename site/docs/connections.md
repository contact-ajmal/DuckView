---
title: Connections & syncs
order: 7
group: Guide
description: One page for every data source — object storage, lakehouse catalogs, PostgreSQL / MySQL / SQLite / DuckDB files, HTTP endpoints and Google Sheets — with health checks, scheduled syncs into a workspace, transformations drafted by Copilot or set by agents, and a run history.
---

**Connections** is where an analyst plugs a source in once and the whole team — and every agent — uses it: *Configured* lists everything with its health and last test, *Add a source* is the catalog, *Syncs* are the scheduled loads into the active workspace.

## The catalog

| Family | Available | Planned |
|---|---|---|
| Object storage | Amazon S3, Cloudflare R2, Google Cloud Storage, Azure Blob | |
| Lakehouse catalogs | AWS Glue / SageMaker Lakehouse, Amazon S3 Tables, any Iceberg REST catalog (Polaris, Nessie, Tabular, Lakekeeper, Snowflake Open Catalog), Databricks | |
| Databases | PostgreSQL, MySQL / MariaDB, SQLite files, DuckDB files | Amazon Redshift |
| Web & APIs | HTTP / REST endpoints (CSV, JSON, Parquet, Excel; bearer token or headers), Google Sheets | |
| Warehouses | | Snowflake, BigQuery, ClickHouse, Microsoft Fabric / Synapse |
| SaaS | | Salesforce, HubSpot, Stripe, Google Analytics 4, Airtable, Notion |

Every card says what the source can do — **browse** it, **attach** it as `alias.schema.table`, run **remote SQL** on it, **sync** from it — and how it authenticates. Planned sources are listed as such rather than hidden; ask for one on GitHub.

## Databases

A PostgreSQL, MySQL, SQLite or DuckDB-file connection is attached **read-only** to every engine of your workspaces through DuckDB's extensions, so `SELECT * FROM pg.public.orders` works in the workbench, in dashboards, in Copilot and for agents alike. The password is encrypted at rest; the page tests the connection, browses schemas and tables, and shows what to type. Network databases need `security.enable_external_access` (or full filesystem mode).

## Syncs

A sync loads a **source** — a table of a connected database or lakehouse, a URL (CSV, JSON, Parquet, Excel over HTTPS, or a Google Sheet shared by link), or any read-only SELECT — into a **target table** of the workspace, on a **schedule** (every N minutes, or a cron expression) or on demand, in *replace* or *append* mode.

An optional **transformation** — one SELECT over `{{raw}}`, the freshly loaded rows — shapes the target: rename and cast columns, drop junk, derive fields, aggregate. It is validated against the live source before it is saved; **Preview** shows the resulting columns and rows, and **Draft with Copilot** writes a first version from the previewed columns and your goal.

Runs happen on the server as the workspace owner with the same guards as a typed query (roles, sandbox, audit trail, data epoch), are recorded one by one (rows, duration, error, who triggered it) and appear live on the page; a failing load never touches the target.

## For agents

Everything above is reachable over MCP: `list_data_sources` (connections with health, syncs, the catalog), `create_data_sync`, `update_data_sync` (attach a transformation — validated first), `run_data_sync`, and the `build_data_pipeline` prompt that walks an agent from inspecting a source to a verified, scheduled, transformed table.
