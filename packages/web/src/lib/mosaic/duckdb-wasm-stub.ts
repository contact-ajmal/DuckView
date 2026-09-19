// DuckView never runs DuckDB in the browser: every Mosaic query goes to the workspace engine on the server.
// mosaic-core imports @duckdb/duckdb-wasm statically for its wasmConnector; this stub keeps the (large) package
// out of the bundle. Calling wasmConnector() would throw, which is the intended behaviour here.
export const AsyncDuckDB = undefined;
export default {} as Record<string, never>;
