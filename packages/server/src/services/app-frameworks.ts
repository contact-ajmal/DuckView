/**
 * The Python web frameworks a data app can be written in, and what each needs to run behind DuckView's proxy at
 * /apps/<id>/ — the same runtimes (subprocess, Docker, Kubernetes) start all of them:
 *
 * - Streamlit: `streamlit run <entry>` with --server.* flags; serves under the base path; health /_stcore/health.
 * - Dash: `python <entry>` whose `app.run()` reads HOST / PORT, and DASH_URL_BASE_PATHNAME makes Dash serve and
 *   link under the base path.
 * - Gradio: `python <entry>` whose `launch()` reads GRADIO_SERVER_NAME / GRADIO_SERVER_PORT; Gradio serves at the
 *   root, so the proxy strips the prefix and GRADIO_ROOT_PATH makes its links carry it.
 */
import type { AppKind } from '../db/schema/sqlite.js';

export interface Framework {
  id: AppKind;
  label: string;
  /** The packages a runtime installs for it (the shared virtualenv; the container image has them all). */
  packages: string[];
  /** argv after the interpreter / container command prefix, and the environment, for a server on host:port under base. */
  launch(entry: string, host: string, port: number, base: string): { args: string[]; env: Record<string, string> };
  /** Path (as the app server sees it) that answers once the app is up. */
  healthPath(base: string): string;
  /** Gradio serves at "/": the proxy removes /apps/<id> before forwarding. */
  stripPrefix: boolean;
  /** Static checks of the entry file beyond "it compiles". */
  check(code: string): { errors: string[]; warnings: string[] };
}

export function streamlitFlags(port: number, address: string, base: string): string[] {
  return ['--server.headless=true', `--server.port=${port}`, `--server.address=${address}`, `--server.baseUrlPath=${base}`, '--browser.gatherUsageStats=false', '--server.enableXsrfProtection=false', '--server.enableCORS=false', '--server.fileWatcherType=none', '--client.toolbarMode=minimal'];
}

const imports = (code: string, mod: string) => new RegExp(`^\\s*(import|from)\\s+${mod}\\b`, 'm').test(code);

export const FRAMEWORKS: Record<AppKind, Framework> = {
  streamlit: {
    id: 'streamlit',
    label: 'Streamlit',
    packages: ['streamlit>=1.46'],
    launch: (entry, host, port, base) => ({ args: [entry, ...streamlitFlags(port, host, base)], env: { STREAMLIT_SERVER_HEADLESS: 'true', STREAMLIT_BROWSER_GATHER_USAGE_STATS: 'false' } }),
    healthPath: (base) => `${base}/_stcore/health`,
    stripPrefix: false,
    check(code) {
      const errors: string[] = [];
      const warnings: string[] = [];
      if (!imports(code, 'streamlit')) errors.push('the entry file does not import streamlit');
      if (/use_container_width/.test(code)) warnings.push('use_container_width is deprecated in Streamlit ≥ 1.46 — use width="stretch"');
      return { errors, warnings };
    },
  },
  dash: {
    id: 'dash',
    label: 'Dash',
    packages: ['dash>=2.17'],
    launch: (entry, host, port, base) => ({ args: [entry], env: { HOST: host, PORT: String(port), DASH_URL_BASE_PATHNAME: `${base}/`, DASH_DEBUG: 'false' } }),
    healthPath: (base) => `${base}/`,
    stripPrefix: false,
    check(code) {
      const errors: string[] = [];
      if (!imports(code, 'dash')) errors.push('the entry file does not import dash');
      if (!/\.run(_server)?\s*\(/.test(code)) errors.push('a Dash app must call app.run() (under if __name__ == "__main__") — DuckView sets HOST, PORT and DASH_URL_BASE_PATHNAME');
      const warnings = /\.run(_server)?\s*\([^)]*\b(port|host)\s*=/.test(code) ? ['app.run() is given a host or port: leave them out so DuckView\'s HOST / PORT apply'] : [];
      return { errors, warnings };
    },
  },
  gradio: {
    id: 'gradio',
    label: 'Gradio',
    packages: ['gradio>=4.44'],
    launch: (entry, host, port, base) => ({ args: [entry], env: { GRADIO_SERVER_NAME: host, GRADIO_SERVER_PORT: String(port), GRADIO_ROOT_PATH: base, GRADIO_ANALYTICS_ENABLED: 'False' } }),
    healthPath: () => '/',
    stripPrefix: true,
    check(code) {
      const errors: string[] = [];
      if (!imports(code, 'gradio')) errors.push('the entry file does not import gradio');
      if (!/\.launch\s*\(/.test(code)) errors.push('a Gradio app must call demo.launch() — DuckView sets GRADIO_SERVER_NAME, GRADIO_SERVER_PORT and GRADIO_ROOT_PATH');
      const warnings = /\.launch\s*\([^)]*\b(share\s*=\s*True|server_port|server_name|root_path)\b/.test(code) ? ['launch() is given share / server_port / server_name / root_path: leave them out so DuckView\'s settings apply (and never share=True)'] : [];
      return { errors, warnings };
    },
  },
};

export const framework = (kind: AppKind | null | undefined): Framework => FRAMEWORKS[kind ?? 'streamlit'] ?? FRAMEWORKS.streamlit;
