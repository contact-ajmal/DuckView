/**
 * Which surface the agent's pages run in: the Console (the full DuckView UI) or the Analyst WebUI (analyst.html, the
 * agent alone). The pages are the same; only how they reach the console differs — in the Analyst WebUI a console
 * link leaves for the console, which checks the person's access again when it opens.
 */
let surface: 'console' | 'analyst' = 'console';
const OPEN_KEY = 'duckview.console.open';

export const setSurface = (s: 'console' | 'analyst') => {
  surface = s;
};
export const isAnalystSurface = () => surface === 'analyst';

/** A console hash (#/dashboards/x) as a link from the current surface. */
export function consoleHref(hash: string): string {
  return surface === 'analyst' ? `/${hash}` : hash;
}

/** Opens a hash in the console; SQL for a new tab travels through session storage when the console is another page. */
export function goToConsole(hash: string, sql?: { sql: string; title: string }): boolean {
  if (surface !== 'analyst') return false;
  if (sql) {
    try {
      sessionStorage.setItem(OPEN_KEY, JSON.stringify(sql));
    } catch {
      /* storage unavailable: the console opens without the tab */
    }
  }
  location.href = `/${hash}`;
  return true;
}

/** In the console: a SQL tab the Analyst WebUI asked to open. */
export function takePendingConsoleSql(): { sql: string; title: string } | null {
  try {
    const raw = sessionStorage.getItem(OPEN_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(OPEN_KEY);
    return JSON.parse(raw) as { sql: string; title: string };
  } catch {
    return null;
  }
}
