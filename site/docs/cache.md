---
title: Result cache
order: 6
group: Guide
description: Why the second profile of a 400 MB CSV takes 3 ms — a server LRU keyed on file fingerprints and a workspace data epoch, plus a browser IndexedDB layer with ETag revalidation.
---

Profiles (`overview`, `SUMMARIZE`), schema inspection, `EXPLAIN` plans, dashboard widget data and read-only SQL results are cached in two places:

1. **Server (shared).** An in-process LRU (`cache.max_bytes`, default 256 MB) in front of the engine. Every member of a shared workspace, every dashboard viewer, Copilot's context hydration and the MCP `profile_dataset` / `execute_query` tools all hit the same entries.
2. **Browser (per user).** IndexedDB keeps the last copy of each profile, schema, plan, widget and the final result of every workbench tab. On the next visit the page paints from it immediately (marked *cached · profiled 3 min ago*) and revalidates in the background. Wiped on sign-out and on session loss; capped at 150 MB (LRU); a tab result above 2 MB is not persisted.

## Measured

On a 387 MB CSV (`yellow_tripdata`), the Overview profile — `SUMMARIZE`, counts, a sample, duplicates and a distribution per column:

| | cold | server cache | `304` |
|---|---|---|---|
| Overview profile | 9 938 ms | 3 ms | 2 ms |
| Group-by query | 421 ms | 3 ms | 3 ms |

## Correctness comes from the key, not from timers

The cache key — which is also the HTTP `ETag` — embeds:

- the absolute path, size and mtime of **every local file** the operation reads (extracted from the SQL's string literals or the bare target), so a file rewritten outside DuckView invalidates;
- the workspace **data epoch** (`workspaces.data_version`) for anything that can read in-database tables. The epoch moves on every non-read statement (even a failed script), `save_dataset`, uploads and deletions, folder changes, engine restart / settings change, transfer, lakehouse connection changes, and whenever a `:memory:` engine (re)starts — because that drops every table. Pure file targets do not embed it, so a `CREATE TABLE` never throws away a 10 s profile of a 400 MB CSV;
- the paging / limit options.

SQL that names an attached lakehouse alias, a remote URI (`s3://…`) or runs on a MotherDuck workspace has no version signal and is cached for `cache.remote_ttl_seconds` only. SQL using non-deterministic functions (`random()`, `now()`, `current_timestamp`, `uuid()`, …), mutations and `EXPLAIN ANALYZE` are never cached.

## Protocol

`POST /api/workspaces/:id/overview | /profile | /explain | /query`, `POST /api/storage/inspect` and `POST /api/dashboards/:id/widgets/:wid/data` answer with `ETag: "<key>"` and `cached` / `computed_at` in the body.

- Send `If-None-Match` to get a `304` when the key still matches — one `stat` and a hash, no DuckDB work.
- `refresh: true` in the body (or `X-DuckView-Refresh: 1`) recomputes and re-stores.
- `GET /api/workspaces` carries each workspace's `data_version`; the live feed (`WS /api/ws/events`) pushes `{type: "workspace", workspace_id, data_version, reason}` to every member when it moves, and the query WebSocket's `done` message includes it after a mutation.
- `DELETE /api/workspaces/:id/cache` (editor) drops the workspace's server entries **and** moves the epoch so every browser recomputes; `POST /api/admin/cache/clear` empties the server cache.

Stats: `GET /api/system/live → cache` (also shown in **Settings → Hardware**), Prometheus `duckview_cache_lookups_total{kind,result}`, `duckview_cache_bytes`, `duckview_cache_entries`.

## In the UI

- The Overview page keeps the selected dataset per workspace — navigate away and back and the same profile is on screen instantly; it only changes when you pick a different file or the data actually changed.
- A small chip states provenance: *profiled 2 min ago*, *cached · profiled 2 min ago* (restored, being confirmed), *… · shared cache* (served by the server for everyone) or *offline* (the server could not be reached; the cached copy stays). Its refresh icon recomputes through every layer.
- Dashboard widgets on an interval revalidate with a conditional request — an unchanged workspace costs a `304` per widget instead of a query.
- After a reload, each tab shows its last result marked *result from 14:02, not re-run*.

Single-replica by design (the server cache is per process); with several replicas each keeps its own — still correct, just less warm.
