/**
 * Deterministic Streamlit app generation — no model involved, always runs:
 *   - from a Mosaic dashboard spec: datasets → SQL relations, inputs (menu / slider / search) → sidebar filters,
 *     KPI text marks → st.metric, bar / area / line / dot / cell marks → aggregating SQL + Altair, table marks →
 *     st.dataframe; hconcat rows → st.columns;
 *   - from saved queries: one section per query with a grid and an automatic chart.
 * The produced app.py reads through the DuckView SDK (query() → pandas) and is meant to be edited further.
 */
import type { Spec } from './mosaic-spec.js';

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const AGG = ['count', 'sum', 'avg', 'mean', 'min', 'max', 'median', 'mode', 'first', 'last', 'countDistinct'] as const;
const TRANSFORMS: Record<string, (c: string) => string> = { bin: (c) => c, dateMonth: (c) => `date_trunc('month', ${c})`, dateDay: (c) => `date_trunc('day', ${c})`, dateHour: (c) => `date_trunc('hour', ${c})`, dateMonthDay: (c) => `date_trunc('day', ${c})`, hour: (c) => `hour(${c})`, dayOfWeek: (c) => `dayofweek(${c})`, month: (c) => `month(${c})`, year: (c) => `year(${c})` };

const ident = (c: string) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(c) ? c : `"${c.replace(/"/g, '""')}"`);
const pyStr = (s: string) => JSON.stringify(s);
/** Single-quoted Python literal — safe inside double-quoted f-strings on every Python ≥ 3.9. */
const py1 = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const isColor = (v: string) => /^#|^(rgb|hsl)a?\(|^(red|blue|green|black|white|gray|grey|orange|purple|steelblue|currentColor|none)$/i.test(v);

/** A channel value → { sql, label, kind } or null for constants. */
interface Channel {
  sql: string;
  label: string;
  agg: boolean;
  bin?: string;
}
function channel(v: unknown, constantsAreColors = false): Channel | null {
  if (typeof v === 'string') {
    if (constantsAreColors && isColor(v)) return null;
    if (v.startsWith('$')) return null;
    return { sql: ident(v), label: v, agg: false };
  }
  if (!isObject(v)) return null;
  const [k, arg] = Object.entries(v)[0] ?? [];
  if (!k) return null;
  if ((AGG as readonly string[]).includes(k)) {
    const col = typeof arg === 'string' ? ident(arg) : null;
    const fn = k === 'mean' ? 'avg' : k === 'countDistinct' ? 'count(DISTINCT' : k;
    const sql = k === 'count' && !col ? 'count(*)' : k === 'countDistinct' ? `count(DISTINCT ${col ?? '*'})` : `${fn}(${col ?? '*'})`;
    return { sql, label: col ? `${k} ${typeof arg === 'string' ? arg : ''}`.trim() : 'count', agg: true };
  }
  if (k === 'bin' && typeof arg === 'string') return { sql: ident(arg), label: arg, agg: false, bin: arg };
  if (TRANSFORMS[k] && typeof arg === 'string') return { sql: TRANSFORMS[k]!(ident(arg)), label: `${k} ${arg}`, agg: false };
  return null;
}

interface Filter {
  dataset: string | null;
  kind: 'menu' | 'slider' | 'search';
  column: string;
  label: string;
  options?: unknown[];
  min?: number;
  max?: number;
  step?: number;
  value?: unknown;
  interval: boolean;
}
type Block = { kind: 'row'; items: Block[] } | { kind: 'kpis'; items: { dataset: string; value: Channel; label: string }[] } | { kind: 'chart'; dataset: string; mark: string; x: Channel | null; y: Channel | null; color: Channel | null; title: string | null; xLabel: string | null; yLabel: string | null } | { kind: 'table'; dataset: string; columns: string[] | null } | { kind: 'title'; text: string };

interface Analysis {
  title: string;
  description: string;
  sources: { name: string; relation: string }[];
  filters: Filter[];
  blocks: Block[];
}

function sourceRelation(name: string, def: unknown): string {
  if (typeof def === 'string') return `(${def.trim().replace(/;\s*$/, '')})`;
  if (!isObject(def)) return ident(name);
  if (typeof def.query === 'string') return `(${def.query.trim().replace(/;\s*$/, '')})`;
  if (typeof def.file === 'string') return `'${def.file.replace(/'/g, "''")}'`;
  return ident(name);
}

/** Walks a spec into filters and layout blocks. */
export function analyzeSpec(spec: Spec): Analysis {
  const meta = isObject(spec.meta) ? spec.meta : {};
  const data = isObject(spec.data) ? spec.data : {};
  const sources = Object.entries(data).map(([name, def]) => ({ name, relation: sourceRelation(name, def) }));
  const defaultDataset = sources[0]?.name ?? null;
  const filters: Filter[] = [];
  const blocks: Block[] = [];

  const plotBlock = (marks: unknown[], plot: Record<string, unknown>): Block | null => {
    const dataMarks = marks.filter((m): m is Record<string, unknown> => isObject(m) && typeof m.mark === 'string');
    const withData = dataMarks.filter((m) => isObject(m.data) && typeof m.data.from === 'string' && !String(m.data.from).startsWith('$'));
    if (!withData.length) return null;
    const texts = dataMarks.filter((m) => m.mark === 'text');
    if (texts.length && withData.every((m) => m.mark === 'text')) {
      const items: { dataset: string; value: Channel; label: string }[] = [];
      for (const m of withData) {
        const value = channel(m.text);
        if (!value?.agg) continue;
        const labelMark = texts.find((t) => Array.isArray(t.text) && typeof t.text[0] === 'string');
        items.push({ dataset: String((m.data as Record<string, unknown>).from), value, label: labelMark ? String((labelMark.text as unknown[])[0]) : value.label });
      }
      return items.length ? { kind: 'kpis', items } : null;
    }
    const m = withData.find((x) => x.mark !== 'text') ?? withData[0]!;
    const dataset = String((m.data as Record<string, unknown>).from);
    const mark = String(m.mark);
    if (mark === 'table') return { kind: 'table', dataset, columns: Array.isArray(m.columns) ? (m.columns as string[]) : null };
    const x = channel(m.x);
    const y = channel(m.y);
    const color = channel(m.fill, true) ?? channel(m.stroke, true) ?? channel(m.z, true);
    const title = typeof plot.title === 'string' ? plot.title : null;
    return { kind: 'chart', dataset, mark, x, y, color, title, xLabel: typeof plot.xLabel === 'string' ? plot.xLabel : null, yLabel: typeof plot.yLabel === 'string' ? plot.yLabel : null };
  };

  const walk = (node: unknown): Block[] => {
    if (Array.isArray(node)) return node.flatMap(walk);
    if (!isObject(node)) return [];
    if (Array.isArray(node.hconcat)) {
      const items = walk(node.hconcat);
      return items.length > 1 ? [{ kind: 'row', items }] : items;
    }
    if (Array.isArray(node.vconcat)) return walk(node.vconcat);
    if (typeof node.input === 'string') {
      const column = typeof node.column === 'string' ? node.column : null;
      if (column && ['menu', 'slider', 'search'].includes(node.input)) {
        filters.push({ dataset: typeof node.from === 'string' ? node.from : defaultDataset, kind: node.input as Filter['kind'], column, label: typeof node.label === 'string' ? node.label : column, options: Array.isArray(node.options) ? node.options : undefined, min: typeof node.min === 'number' ? node.min : undefined, max: typeof node.max === 'number' ? node.max : undefined, step: typeof node.step === 'number' ? node.step : undefined, value: node.value, interval: node.select === 'interval' });
      } else if (node.input === 'table' && typeof node.from === 'string') return [{ kind: 'table', dataset: node.from, columns: Array.isArray(node.columns) ? (node.columns as string[]) : null }];
      return [];
    }
    if (Array.isArray(node.plot)) {
      const b = plotBlock(node.plot, node);
      return b ? [b] : [];
    }
    if (typeof node.mark === 'string') {
      const b = plotBlock([node], node);
      return b ? [b] : [];
    }
    return [];
  };
  const { data: _d, meta: _m, params: _p, plotDefaults: _pd, ...rest } = spec;
  blocks.push(...walk(rest));
  return { title: typeof meta.title === 'string' ? meta.title : 'Dashboard', description: typeof meta.description === 'string' ? meta.description : '', sources, filters, blocks };
}

/** Python for one chart block. */
function chartCode(b: Extract<Block, { kind: 'chart' }>, indent: string): string[] {
  const rel = `rel(${py1(b.dataset)})`;
  const where = `where(${py1(b.dataset)})`;
  const yName = b.yLabel ?? (b.y?.agg ? b.y.label : b.y ? `sum ${b.y.label}` : 'count');
  const xName = b.xLabel ?? b.x?.label ?? '?';
  const title = b.title ?? (b.y?.agg || !b.y ? `${yName} by ${xName}` : b.x && b.y && !/^(bar|rect|area|line)/.test(b.mark) ? `${b.y.label} vs ${b.x.label}` : `${yName} by ${xName}`);
  const lines: string[] = [`${indent}st.subheader(${pyStr(title)})`];
  const horizontal = /X$/.test(b.mark) && !/^(line|area|dot)/.test(b.mark);
  const alt = (m: string) => (m.startsWith('area') ? 'mark_area(opacity=0.6)' : m.startsWith('line') ? 'mark_line()' : m === 'cell' || m === 'raster' || m === 'hexbin' || m === 'density' ? 'mark_rect()' : m === 'dot' || m === 'circle' || m === 'hexagon' ? 'mark_circle(opacity=0.5)' : 'mark_bar()');
  const xl = b.xLabel ?? b.x?.label ?? '';
  const yl = b.yLabel ?? b.y?.label ?? '';
  if (b.mark === 'cell' || b.mark === 'raster' || b.mark === 'hexbin' || b.mark === 'density') {
    if (!b.x || !b.y) return [];
    const fill = b.color?.agg ? b.color.sql : 'count(*)';
    const xs = b.x.bin ? `{bins(${rel}, ${py1(b.x.bin)}, ${where})}` : b.x.sql.replace(/"/g, '\\"');
    const ys = b.y.bin ? `{bins(${rel}, ${py1(b.y.bin)}, ${where})}` : b.y.sql.replace(/"/g, '\\"');
    lines.push(`${indent}df = q(f"SELECT ${xs} AS x, ${ys} AS y, ${fill.replace(/"/g, '\\"')} AS v FROM {${rel}}{${where}} GROUP BY 1, 2 ORDER BY 1, 2 LIMIT 20000")`);
    lines.push(`${indent}st.altair_chart(alt.Chart(df).${alt(b.mark)}.encode(x=alt.X("x:" + alt_type(df["x"]), title=${pyStr(xl)}), y=alt.Y("y:" + alt_type(df["y"]), title=${pyStr(yl)}), color=alt.Color("v:Q", title=${pyStr(b.color?.label ?? 'count')}), tooltip=["x", "y", "v"]), width="stretch")`);
    return lines;
  }
  if (b.mark === 'dot' || b.mark === 'circle' || b.mark === 'hexagon') {
    if (!b.x || !b.y) return [];
    const colorSel = b.color && !b.color.agg ? `, ${b.color.sql} AS c` : '';
    lines.push(`${indent}df = q(f"SELECT ${b.x.sql.replace(/"/g, '\\"')} AS x, ${b.y.sql.replace(/"/g, '\\"')} AS y${colorSel.replace(/"/g, '\\"')} FROM {${rel}}{${where}} USING SAMPLE 5000 ROWS")`);
    lines.push(`${indent}st.altair_chart(alt.Chart(df).${alt(b.mark)}.encode(x=alt.X("x:" + alt_type(df["x"]), title=${pyStr(xl)}), y=alt.Y("y:" + alt_type(df["y"]), title=${pyStr(yl)})${colorSel ? `, color=alt.Color("c:N", title=${pyStr(b.color!.label)})` : ''}, tooltip=list(df.columns)), width="stretch")`);
    return lines;
  }
  // Aggregating marks: bars, areas, lines. The dimension is x (or y for horizontal bars), the measure the other.
  const dim = horizontal ? b.y : b.x;
  const measure = horizontal ? b.x : b.y;
  if (!dim) return [];
  const measureSql = measure?.agg ? measure.sql : measure ? `sum(${measure.sql})` : 'count(*)';
  const measureLabel = measure?.agg ? measure.label : measure ? `sum ${measure.label}` : 'count';
  const dimSql = dim.bin ? `{bins(${rel}, ${py1(dim.bin)}, ${where})}` : dim.sql.replace(/"/g, '\\"');
  const colorSel = b.color && !b.color.agg ? `, ${b.color.sql.replace(/"/g, '\\"')} AS c` : '';
  lines.push(`${indent}df = q(f"SELECT ${dimSql} AS x, ${measureSql.replace(/"/g, '\\"')} AS y${colorSel} FROM {${rel}}{${where}} GROUP BY ${colorSel ? '1, 3' : '1'} ORDER BY 1 LIMIT 5000")`);
  const xEnc = `alt.X("${horizontal ? 'y:Q' : 'x:" + alt_type(df["x"]) + "'}", title=${pyStr(horizontal ? measureLabel : xl || dim.label)}${dim.bin && !horizontal ? ', bin=alt.Bin(binned=True)' : ''})`;
  const yEnc = `alt.Y("${horizontal ? 'x:" + alt_type(df["x"]) + "' : 'y:Q'}", title=${pyStr(horizontal ? xl || dim.label : yl || measureLabel)}${horizontal ? ', sort="-x"' : ''})`;
  lines.push(`${indent}st.altair_chart(alt.Chart(df).${alt(b.mark)}.encode(x=${xEnc}, y=${yEnc}${colorSel ? `, color=alt.Color("c:N", title=${pyStr(b.color!.label)})` : ''}, tooltip=list(df.columns)), width="stretch")`);
  return lines;
}

function blockCode(b: Block, indent = ''): string[] {
  switch (b.kind) {
    case 'row': {
      // A row of KPI cards becomes one st.columns() of metrics.
      if (b.items.every((i) => i.kind === 'kpis')) return blockCode({ kind: 'kpis', items: b.items.flatMap((i) => (i.kind === 'kpis' ? i.items : [])) }, indent);
      const lines = [`${indent}cols = st.columns(${b.items.length})`];
      b.items.forEach((item, i) => {
        lines.push(`${indent}with cols[${i}]:`);
        const inner = blockCode(item, indent + '    ');
        lines.push(...(inner.length ? inner : [`${indent}    pass`]));
      });
      return lines;
    }
    case 'kpis': {
      const lines = [`${indent}kpi = st.columns(${b.items.length})`];
      b.items.forEach((k, i) => {
        lines.push(`${indent}kpi[${i}].metric(${pyStr(k.label)}, fmt(scalar(f"SELECT ${k.value.sql.replace(/"/g, '\\"')} FROM {rel(${py1(k.dataset)})}{where(${py1(k.dataset)})}")))`);
      });
      return lines;
    }
    case 'chart':
      return chartCode(b, indent);
    case 'table': {
      const cols = b.columns?.length ? b.columns.map(ident).join(', ') : '*';
      return [`${indent}st.dataframe(q(f"SELECT ${cols.replace(/"/g, '\\"')} FROM {rel(${py1(b.dataset)})}{where(${py1(b.dataset)})} LIMIT 1000"), width="stretch", hide_index=True)`];
    }
    case 'title':
      return [`${indent}st.subheader(${pyStr(b.text)})`];
  }
}

const HELPERS = `
def esc(v):
    return str(v).replace("'", "''")


def rel(name):
    """The SQL relation of a dashboard dataset (a subquery, a file or a table)."""
    return SOURCES[name]


def where(name):
    """WHERE clause for a dataset from the sidebar filters (empty when nothing is filtered)."""
    parts = FILTERS.get(name, [])
    return (" WHERE " + " AND ".join(parts)) if parts else ""


def q(sql):
    return query(sql)


def scalar(sql):
    df = q(sql)
    return None if df.empty else df.iloc[0, 0]


def fmt(v):
    if v is None or (isinstance(v, float) and v != v):
        return "–"
    if isinstance(v, (int,)) or (isinstance(v, float) and float(v).is_integer() and abs(v) >= 1000):
        return f"{int(v):,}"
    if isinstance(v, float):
        return f"{v:,.2f}"
    return str(v)


def alt_type(series):
    dtype = str(series.dtype)
    if "datetime" in dtype:
        return "T"
    if dtype.startswith(("int", "float", "uint", "Int", "Float")):
        return "Q"
    return "N"


def bins(relation, column, where_sql, n=30):
    """SQL expression bucketing a numeric column into ~n equal-width bins over the filtered range."""
    lo, hi = q(f"SELECT min({column}), max({column}) FROM {relation}{where_sql}").iloc[0]
    if lo is None or hi is None or hi <= lo:
        return column
    raw = (float(hi) - float(lo)) / n
    mag = 10 ** math.floor(math.log10(raw)) if raw > 0 else 1
    w = next(m * mag for m in (1, 2, 2.5, 5, 10) if m * mag >= raw)
    return f"floor({column} / {w}) * {w}"
`;

/** A full Streamlit app for a Mosaic dashboard spec. */
export function appFromDashboard(spec: Spec, opts: { name?: string; description?: string | null } = {}): { files: Record<string, string>; summary: string } {
  const a = analyzeSpec(spec);
  const title = opts.name ?? a.title;
  const description = opts.description ?? a.description;
  const out: string[] = [];
  out.push('import math', 'import streamlit as st', 'import altair as alt', 'from duckview.streamlit import connect, query, viewer', '');
  out.push(`st.set_page_config(page_title=${pyStr(title)}, layout="wide")`);
  out.push(`st.title(${pyStr(title)})`);
  if (description) out.push(`st.caption(${pyStr(description)})`);
  out.push('dv = connect()', '');
  out.push('# ---- datasets of the dashboard (SQL relations; edit freely)');
  out.push('SOURCES = {');
  for (const s of a.sources) out.push(`    ${pyStr(s.name)}: ${s.relation.includes('\n') ? `"""${s.relation.replace(/\\/g, '\\\\').replace(/"""/g, "'''")}"""` : pyStr(s.relation)},`);
  out.push('}', 'FILTERS = {}', HELPERS.trimEnd(), '');
  if (a.filters.length) {
    out.push('# ---- filters (the dashboard\'s inputs, applied to every query of their dataset)');
    out.push('with st.sidebar:', '    st.header("Filters")');
    a.filters.forEach((f, i) => {
      const ds = f.dataset ?? a.sources[0]?.name ?? '';
      const add = `FILTERS.setdefault(${pyStr(ds)}, [])`;
      const col = ident(f.column);
      if (f.kind === 'menu') {
        const opts = f.options ? `[${f.options.map((o) => pyStr(String(o))).join(', ')}]` : `q(f"SELECT DISTINCT ${col.replace(/"/g, '\\"')} AS v FROM {rel(${py1(ds)})} ORDER BY 1 LIMIT 500")["v"].dropna().astype(str).tolist()`;
        out.push(`    v${i} = st.selectbox(${pyStr(f.label)}, ["All"] + ${opts}, key=${pyStr(`f${i}`)})`);
        out.push(`    if v${i} != "All":`, `        ${add}.append(f"CAST(${col.replace(/"/g, '\\"')} AS VARCHAR) = '{esc(v${i})}'")`);
      } else if (f.kind === 'slider') {
        const lo = f.min ?? 0;
        const hi = f.max ?? 100;
        const step = f.step ?? (Number.isInteger(lo) && Number.isInteger(hi) ? 1 : (hi - lo) / 100);
        if (f.interval) {
          const init = typeof f.value === 'number' ? `(${lo}, ${f.value})` : `(${lo}, ${hi})`;
          out.push(`    lo${i}, hi${i} = st.slider(${pyStr(f.label)}, ${lo}, ${hi}, ${init}, step=${step}, key=${pyStr(`f${i}`)})`);
          out.push(`    if (lo${i}, hi${i}) != (${lo}, ${hi}):`, `        ${add}.append(f"${col.replace(/"/g, '\\"')} BETWEEN {lo${i}} AND {hi${i}}")`);
        } else {
          out.push(`    v${i} = st.slider(${pyStr(f.label)}, ${lo}, ${hi}, ${typeof f.value === 'number' ? f.value : lo}, step=${step}, key=${pyStr(`f${i}`)})`);
          out.push(`    ${add}.append(f"${col.replace(/"/g, '\\"')} <= {v${i}}")`);
        }
      } else {
        out.push(`    v${i} = st.text_input(${pyStr(f.label)}, key=${pyStr(`f${i}`)})`);
        out.push(`    if v${i}.strip():`, `        ${add}.append(f"CAST(${col.replace(/"/g, '\\"')} AS VARCHAR) ILIKE '%{esc(v${i}.strip())}%'")`);
      }
    });
    out.push('');
  }
  out.push('# ---- the dashboard, section by section');
  let charts = 0;
  let kpis = 0;
  let tables = 0;
  const count = (b: Block) => { if (b.kind === 'row') b.items.forEach(count); else if (b.kind === 'chart') charts++; else if (b.kind === 'kpis') kpis += b.items.length; else if (b.kind === 'table') tables++; };
  for (const b of a.blocks) {
    count(b);
    const code = blockCode(b);
    if (code.length) out.push(...code, '');
  }
  if (!a.blocks.length) out.push(`st.dataframe(q(f"SELECT * FROM {rel(${py1(a.sources[0]?.name ?? 'data')})} LIMIT 1000"), width="stretch")`, '');
  out.push(`st.caption(f"Generated from the DuckView dashboard · viewing as {viewer()['email'] or 'anonymous'}")`);
  return { files: { 'app.py': out.join('\n') + '\n', 'requirements.txt': '' }, summary: `${a.sources.length} dataset${a.sources.length === 1 ? '' : 's'}, ${a.filters.length} filter${a.filters.length === 1 ? '' : 's'}, ${kpis} KPI${kpis === 1 ? '' : 's'}, ${charts} chart${charts === 1 ? '' : 's'}, ${tables} table${tables === 1 ? '' : 's'}` };
}

/** A Streamlit app that shows a set of queries: grid + automatic chart each. */
export function appFromQueries(queries: { name: string; sql: string }[], opts: { name?: string; description?: string | null } = {}): { files: Record<string, string>; summary: string } {
  const title = opts.name ?? (queries.length === 1 ? queries[0]!.name : 'Saved queries');
  const out: string[] = ['import streamlit as st', 'import altair as alt', 'from duckview.streamlit import connect, query, viewer', ''];
  out.push(`st.set_page_config(page_title=${pyStr(title)}, layout="wide")`, `st.title(${pyStr(title)})`);
  if (opts.description) out.push(`st.caption(${pyStr(opts.description)})`);
  out.push('dv = connect()', '');
  out.push('QUERIES = {');
  for (const q of queries) out.push(`    ${pyStr(q.name)}: ${pyStr(q.sql.trim().replace(/;\s*$/, ''))},`);
  out.push('}', '');
  out.push(`
def alt_type(series):
    dtype = str(series.dtype)
    return "T" if "datetime" in dtype else ("Q" if dtype.startswith(("int", "float", "uint", "Int", "Float")) else "N")


limit = st.sidebar.slider("Rows per query", 100, 10_000, 1_000, step=100)
for name, sql in QUERIES.items():
    st.subheader(name)
    df = query(f"SELECT * FROM ({sql}) AS t LIMIT {limit}")
    st.dataframe(df, width="stretch", hide_index=True)
    numeric = [c for c in df.columns if alt_type(df[c]) == "Q"]
    dims = [c for c in df.columns if alt_type(df[c]) != "Q"]
    if numeric and dims and len(df) <= 5000:
        x, y = dims[0], numeric[0]
        mark = alt.Chart(df).mark_line() if alt_type(df[x]) == "T" else alt.Chart(df).mark_bar()
        st.altair_chart(mark.encode(x=alt.X(f"{x}:{alt_type(df[x])}"), y=alt.Y(f"{y}:Q"), tooltip=list(df.columns)), width="stretch")
    with st.expander("SQL"):
        st.code(sql, language="sql")

st.caption(f"Viewing as {viewer()['email'] or 'anonymous'}")
`.trim(), '');
  return { files: { 'app.py': out.join('\n'), 'requirements.txt': '' }, summary: `${queries.length} quer${queries.length === 1 ? 'y' : 'ies'}` };
}

/** What agents and Copilot need to write a DuckView data app by hand. */
export const DATA_APP_GUIDE = `# Writing a DuckView data app (Streamlit)

A data app is a Streamlit script that reads a DuckView workspace through the \`duckview\` SDK. DuckView runs it
(\`streamlit run app.py\`), serves it at /apps/<id>/ to the workspace's members, and sets three environment variables
the SDK reads: DUCKVIEW_URL, DUCKVIEW_TOKEN (read-only, scoped to the workspace) and DUCKVIEW_WORKSPACE. Never put
tokens or credentials in the code; never open .duckdb files directly (the engine holds the lock).

Streamlit is the default; Dash and Gradio apps (create_app with kind, or the dash-explorer / gradio-query templates)
use the same SDK (\`dv = duckview.connect(); dv.query(sql)\`) — a Dash app calls \`app.run()\` with no arguments and a
Gradio app \`demo.launch()\` with no server arguments (DuckView sets host, port and base path); the viewer is
\`duckview.viewer_from_headers(request.headers)\`.

Apps run on the server by default. With execution "browser" (create_app) the same script runs in each viewer's
browser instead (stlite on Pyodide): nothing runs on the server, the SDK reads as the viewer (read-only, the app's
workspace), \`viewer()\` still works, and requirements.txt may only list pure-Python packages (or ones Pyodide ships).
Keep queries aggregated there — results travel to the browser.

## Skeleton

\`\`\`python
import streamlit as st
import altair as alt
from duckview.streamlit import connect, query, table_picker, viewer

st.set_page_config(page_title="Sales", layout="wide")
st.title("Sales")
dv = connect()                                   # cached client

region = st.sidebar.selectbox("Region", ["All"] + query("SELECT DISTINCT region FROM sales ORDER BY 1")["region"].tolist())
where = "" if region == "All" else f" WHERE region = '{region.replace(\\"'\\", \\"''\\")}'"
df = query(f"SELECT day, sum(amount) AS revenue FROM sales{where} GROUP BY 1 ORDER BY 1")   # DuckDB SQL → pandas, cached 5 min
st.altair_chart(alt.Chart(df).mark_line().encode(x="day:T", y="revenue:Q"), width="stretch")
st.dataframe(df, width="stretch", hide_index=True)
st.caption(f"Viewing as {viewer()['email']}")
\`\`\`

## SDK

- \`connect()\` → client (\`st.cache_resource\`); \`dv.query(sql, max_rows=None, format="pandas"|"records"|"polars"|"result")\`;
  \`dv.query_arrow(sql)\` → pyarrow Table (large results); \`dv.tables()\` / \`dv.files()\` / \`dv.catalog()\`;
  \`dv.table("trips").where("fare > 10").order_by("fare DESC").limit(100).to_df()\`.
- \`query(sql)\` (module level) is \`st.cache_data\`-backed for five minutes — use it for everything interactive.
- \`datasets()\` lists tables, views and data files with the SQL relation to read them; \`table_picker(dv)\` is a selectbox
  over them returning that relation (a quoted table name or a quoted file path — put it straight after FROM).
- \`viewer()\` → {"id", "email", "role"} of the DuckView user viewing the app (forwarded by the proxy).

## Rules

- Do the heavy lifting in SQL (aggregate, filter, sample with \`USING SAMPLE 5000 ROWS\`); keep DataFrames small.
- Escape user input in SQL (\`'\` → \`''\`), or use \`CAST(col AS VARCHAR) = '…'\`.
- Files are read by path: \`SELECT * FROM 'sales.parquet'\`; \`read_csv\`, \`read_parquet\`, \`read_json_auto\` work as in DuckDB.
- Streamlit ≥ 1.46: use \`width="stretch"\` (not \`use_container_width\`). Altair and pandas are installed; other
  packages go in requirements.txt (installed before the app starts).
- The app must import streamlit; the entry file is app.py. Keep secrets out of the code.
`;
