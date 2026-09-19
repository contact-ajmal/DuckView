---
title: Interactive exploration & Mosaic dashboards
order: 7
group: Guide
description: Cross-filtered charts over millions of rows — the Explore view and spec-driven Mosaic dashboards, computed in the workspace engine through Mosaic's pre-aggregation, never in the browser.
---

DuckView embeds [Mosaic](https://idl.uw.edu/mosaic/) (`@uwdata/vgplot`, BSD-3) with the **workspace engine as its data connector**. Mosaic turns every interaction into SQL and, for repeated filtering, builds pixel-binned pre-aggregated tables, so brushing stays interactive on datasets far larger than a browser could hold. DuckDB-WASM is never loaded.

## Explore view

On the Overview page (*Explore* button) and as a results view in the workbench: every numeric or temporal column becomes a histogram, every low-cardinality text column a bar chart, with a lazily paged table underneath. Brush one chart to cross-filter all the others; click a bar to toggle it; double-click to clear. The view rebuilds whenever the workspace data epoch moves.

## Mosaic dashboards

Dashboards come in two kinds. **Grid** dashboards are widgets on a drag-and-drop layout; **Mosaic** dashboards are a [Mosaic declarative spec](https://idl.uw.edu/mosaic/spec/) — YAML or JSON — rendered live against the workspace and stored with the dashboard, so every member sees the same interactive view.

- **Generate** drafts a complete, cross-filtered spec from any table, data file or SELECT in one click. The draft is ordinary spec text.
- **Edit** opens a YAML/JSON editor next to a live preview that re-renders as you type (⌘S saves). Viewers see the rendered dashboard only.
- Any workspace table can be referenced with `from: table_name`. Files, queries and inline rows are declared under `data:` exactly as in the Mosaic docs; DuckView turns them into hidden source views inside the workspace jail.
- Params, selections, inputs (`menu`, `search`, `slider`, `table`), every mark, interactor and attribute, legends and `hconcat` / `vconcat` layouts are Mosaic's own.

```yaml
meta: { title: Trips by hour }
data:
  trips: { file: green_tripdata.parquet }
params:
  brush: { select: crossfilter }
vconcat:
  - plot:
      - mark: rectY
        data: { from: trips, filterBy: $brush }
        x: { bin: lpep_pickup_datetime }
        y: { count: null }
      - select: intervalX
        as: $brush
    xDomain: Fixed
    width: 640
  - input: table
    from: trips
    filterBy: $brush
    height: 300
```

## How it stays safe

The browser talks to `POST /api/workspaces/:id/mosaic`. Chart queries (`arrow` / `json`) run through the normal query pipeline — role, sandbox, audit, result cache with `ETag` — with their own row ceiling (`mosaic.max_rows`). Mosaic's plumbing (`exec`) is admitted only in its exact shapes: creating the `duckview_mosaic` schema, `preagg_<hash>` tables inside it, DuckView's `duckview_mosaic_src_<hash>` source views, and dropping them again; every wrapped SELECT must be a single read-only statement. Anything else is rejected. Pre-aggregates and source views are derived data: viewers can create them, they never move the data epoch, and they are dropped — and rebuilt lazily — whenever the epoch moves. They are hidden from the catalog, the explorer and agents.

Configuration: `mosaic.enabled`, `mosaic.schema`, `mosaic.max_rows`. Metrics: `duckview_mosaic_exec_total{kind}`.
