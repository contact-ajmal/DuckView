/**
 * Apps that run in the viewer's browser: the apps origin serves a page that mounts stlite (Streamlit on Pyodide)
 * with the app's files and the DuckView SDK. Nothing runs on the server. The page's environment carries a
 * credential for the viewer — a JWT with purpose "app-browser": read scope, the app's workspace only, a few hours —
 * so the app sees exactly what the viewer may read, and the SDK reaches the API cross-origin (CORS) through
 * stlite's patched urllib.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { DataApp } from '../db/schema/sqlite.js';

let sdkCache: { dir: string; files: Record<string, string> } | null = null;

/** The SDK's Python sources, mounted next to the app so `import duckview` works without PyPI. */
export function sdkFiles(sdkDir: string | null): Record<string, string> {
  if (!sdkDir) return {};
  if (sdkCache?.dir === sdkDir) return sdkCache.files;
  const files: Record<string, string> = {};
  const pkg = path.join(sdkDir, 'duckview');
  for (const name of fs.readdirSync(pkg)) if (name.endsWith('.py')) files[`duckview/${name}`] = fs.readFileSync(path.join(pkg, name), 'utf8');
  sdkCache = { dir: sdkDir, files };
  return files;
}

/** requirements.txt → micropip requirement strings (comments, options and blank lines dropped). */
export function browserRequirements(text: string | undefined): string[] {
  return (text ?? '')
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*$/, '').trim())
    .filter((l) => l && !l.startsWith('-'));
}

export interface StlitePageInput {
  app: Pick<DataApp, 'id' | 'name' | 'entry' | 'files'>;
  sdk: Record<string, string>;
  env: Record<string, string>;
  stliteUrl: string;
  pyodideUrl?: string;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
/** JSON that is safe inside a <script> element. */
const scriptJson = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c').replaceAll(String.fromCharCode(0x2028), '\\u2028').replaceAll(String.fromCharCode(0x2029), '\\u2029');

export function stlitePage(input: StlitePageInput): string {
  const base = input.stliteUrl.replace(/\/+$/, '');
  const { 'requirements.txt': reqs, ...appFiles } = input.app.files;
  const options = {
    entrypoint: input.app.entry,
    files: { ...input.sdk, ...appFiles },
    requirements: browserRequirements(reqs),
    env: input.env,
    streamlitConfig: { 'client.toolbarMode': 'minimal', 'browser.gatherUsageStats': false },
    ...(input.pyodideUrl ? { pyodideUrl: input.pyodideUrl } : {}),
  };
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${esc(input.app.name)}</title>
<link rel="stylesheet" href="${esc(base)}/stlite.css">
<style>#dv-boot{font-family:system-ui,sans-serif;color:#71717a;font-size:13px;position:fixed;inset:0;display:flex;align-items:center;justify-content:center}</style>
</head>
<body>
<div id="dv-boot">Loading Python in your browser…</div>
<div id="root"></div>
<script id="dv-app" type="application/json">${scriptJson(options)}</script>
<script type="module">
import { mount } from ${JSON.stringify(`${base}/stlite.js`)};
const options = JSON.parse(document.getElementById('dv-app').textContent);
document.getElementById('dv-boot').remove();
mount(options, document.getElementById('root'));
</script>
</body>
</html>`;
}
