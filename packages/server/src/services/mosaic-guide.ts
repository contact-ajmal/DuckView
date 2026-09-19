/**
 * The Mosaic spec authoring guide handed to agents (MCP resource `duckdb://guides/mosaic-spec`) and to DuckCopilot
 * when a dashboard is requested. Kept compact on purpose: it is prompt material, not documentation.
 */
export const MOSAIC_SPEC_GUIDE = `# Writing a DuckView Mosaic dashboard spec

A Mosaic dashboard is a declarative spec (YAML or JSON) rendered against the workspace's DuckDB engine. Reference:
https://idl.uw.edu/mosaic/spec/ — everything there works, with these DuckView rules for data:

- Tables/views in the workspace: reference directly with \`from: table_name\` (no \`data\` entry needed).
- Files and queries go under \`data:\` and are turned into hidden views inside the workspace:
    data:
      trips: { file: green_tripdata.parquet }        # parquet / csv / json by extension; read_* options allowed
      byhour: { query: "SELECT date_trunc('hour', ts) AS h, count(*) AS n FROM 'x.parquet' GROUP BY 1" }
      notes: [{ label: a, v: 1 }, { label: b, v: 3 }] # inline rows
  Schema-qualified or lakehouse tables (\`lake.sales.orders\`) go through a \`query\` dataset too.
- Read-only SQL only. Paths are relative to the workspace data directory. No \`spatial\` data.

Shape:
    meta: { title: …, description: … }
    data: { … }
    params:
      brush: { select: crossfilter }     # crossfilter | intersect | single | union, or a value param: { value: 5 }
    vconcat:                             # or hconcat / a single plot / input
      - hconcat: [ { input: menu, label: Vendor, as: $vendor, from: trips, column: vendor }, { input: slider, as: $min, min: 0, max: 100 } ]
      - plot:
          - mark: rectY
            data: { from: trips, filterBy: $brush }
            x: { bin: trip_distance }
            y: { count: null }
            fill: '#8b5cf6'
          - select: intervalX
            as: $brush
        xDomain: Fixed
        width: 640
        height: 200
      - input: table
        from: trips
        filterBy: $brush
        height: 300

Rules of thumb:
- Marks: rectY/rectX (binned histograms with x: {bin: col}), barX/barY (categories), lineY/areaY (time series; x: {dateMonth: col} or a query that pre-aggregates), dot (scatter; raster/heatmap for large data), text, ruleX/ruleY, frame.
- Aggregates: { count: null }, { sum: col }, { avg: col }, { min: col }, { max: col }, { median: col }; { bin: col } for histograms; { sql: "expr" } for anything else.
- Interactors: intervalX / intervalXY (brush), toggleY / toggleX (click bars), nearestX (hover), panZoom. Give every one an \`as: $selection\`; use the same selection in \`filterBy\` of every mark that should react. Never combine \`highlight\` with an aggregated mark.
- Keep counts readable: yTickFormat: s; use xDomain: Fixed on brushed histograms so the axis does not jump.
- One idea per plot; 2–3 plots per hconcat row; ≤ 12 plots total. Width 320–640, height 170–260.
- Use \`filterBy: $sel\` on inputs' target marks, and \`sort: { y: '-x', limit: 20 }\` on category bars.

Agents create or update a dashboard with the \`create_mosaic_dashboard\` tool (spec or spec_text); call it with
\`validate_only: true\` first — it binds every dataset and table in the workspace and lists what to fix.
`;
