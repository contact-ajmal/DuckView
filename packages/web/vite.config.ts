import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const here = path.dirname(fileURLToPath(import.meta.url));

const backend = process.env.DUCKVIEW_BACKEND ?? 'http://localhost:4200';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // Mosaic's wasm connector imports DuckDB-WASM statically; DuckView never runs DuckDB in the browser.
    alias: { '@duckdb/duckdb-wasm': path.resolve(here, 'src/lib/mosaic/duckdb-wasm-stub.ts') },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: backend, changeOrigin: true, ws: true },
      '/mcp': { target: backend, changeOrigin: true },
      '/healthz': backend,
      '/readyz': backend,
      '/metrics': backend,
    },
  },
  // Two entries: the Console (index.html) and the Analyst WebUI (analyst.html), sharing the agent's components and API.
  build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 1500, rollupOptions: { input: { main: path.resolve(here, 'index.html'), analyst: path.resolve(here, 'analyst.html') } } },
});
