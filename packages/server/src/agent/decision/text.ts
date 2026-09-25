/**
 * Text handling for the Default Decision Engine: tokens, a light stemmer, stop words and the data-work synonyms
 * people use interchangeably ("sales" for revenue, "graph" for chart). Deterministic and local.
 */

const STOP = new Set('a an and are as at be by can could do does for from give have how i in into is it its let me my of on or our please show tell than that the their them then there these this those to up us want was we what when where which who why will with would you your can\'t it\'s i\'d i\'m just some any all get make'.split(' '));

/** Groups of words that mean the same thing for finding tools and data. Each word maps to its group's first word. */
const SYNONYM_GROUPS: string[][] = [
  ['revenue', 'sales', 'income', 'turnover', 'arr', 'mrr', 'bookings'],
  ['customer', 'client', 'account', 'user', 'buyer'],
  ['order', 'purchase', 'transaction'],
  ['chart', 'graph', 'plot', 'visualisation', 'visualization', 'visualise', 'visualize', 'viz'],
  ['dashboard', 'report', 'board'],
  ['analyse', 'analyze', 'analysis', 'explore', 'understand', 'examine', 'study'],
  ['anomaly', 'anomalies', 'unusual', 'outlier', 'spike', 'drop', 'dip', 'decline', 'fell', 'fall', 'surge'],
  ['investigate', 'why', 'cause', 'driver', 'root'],
  ['quality', 'validate', 'validation', 'check', 'test', 'expectation'],
  ['null', 'missing', 'empty', 'blank'],
  ['duplicate', 'dedupe', 'dupe', 'duplicated'],
  ['table', 'dataset', 'data', 'file'],
  ['column', 'field', 'attribute'],
  ['metric', 'kpi', 'measure', 'indicator'],
  ['create', 'make', 'build', 'add', 'new', 'generate'],
  ['find', 'search', 'locate', 'discover', 'look', 'which'],
  ['join', 'relationship', 'relate', 'related', 'link', 'connect'],
  ['app', 'application', 'streamlit', 'tool'],
  ['notebook', 'writeup', 'narrative', 'document'],
  ['model', 'dbt', 'transformation', 'transform'],
  ['compare', 'versus', 'vs', 'difference', 'diff'],
  ['trend', 'over time', 'monthly', 'weekly', 'daily', 'timeseries'],
  ['export', 'download', 'save as'],
  ['clean', 'tidy', 'prepare', 'wrangle', 'fix'],
  ['churn', 'retention', 'attrition'],
  ['region', 'country', 'geography', 'market', 'territory'],
];

const CANON = new Map<string, string>();
for (const g of SYNONYM_GROUPS) for (const w of g) if (!w.includes(' ')) CANON.set(stem(w), stem(g[0]!));

/** Plural and verb endings off, so "orders", "ordered" and "order" meet. Conservative on short words. */
export function stem(w: string): string {
  if (w.length <= 3) return w;
  if (w.endsWith('ies') && w.length > 4) return `${w.slice(0, -3)}y`;
  if (w.endsWith('ing') && w.length > 5) return w.slice(0, -3);
  if (w.endsWith('ed') && w.length > 4) return w.slice(0, -2);
  if (w.endsWith('es') && /(ses|xes|ches|shes)$/.test(w)) return w.slice(0, -2);
  if (w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

/** Words of a text: lower case, split on non-letters and on snake_case / camelCase / dots. */
export function tokens(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Terms for matching: tokens without stop words, stemmed, with synonyms folded to one term. */
export function terms(text: string): string[] {
  return tokens(text)
    .filter((t) => !STOP.has(t))
    .map((t) => {
      const s = stem(t);
      return CANON.get(s) ?? s;
    });
}

/** Words of the request that look like names: quoted, snake_case, dotted, or `backticked`. */
export function entityHints(request: string): string[] {
  const out = new Set<string>();
  for (const m of request.matchAll(/["'`]([^"'`]{2,80})["'`]/g)) out.add(m[1]!.trim());
  for (const m of request.matchAll(/\b([A-Za-z][A-Za-z0-9]*(?:[_.][A-Za-z0-9]+)+)\b/g)) out.add(m[1]!);
  return [...out];
}
