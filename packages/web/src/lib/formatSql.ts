/**
 * SQL formatting for the editors: DuckDB's dialect, upper-case keywords, two-space indents. Notebook parameters
 * ({{ name }}) and DuckView's tab markers are kept exactly as written.
 */
import { format } from 'sql-formatter';

export function formatSql(sql: string): string {
  const out = format(sql, {
    language: 'duckdb',
    keywordCase: 'upper',
    tabWidth: 2,
    linesBetweenQueries: 1,
    paramTypes: { custom: [{ regex: String.raw`\{\{[^{}]*\}\}` }] },
  });
  return sql.endsWith('\n') ? `${out}\n` : out;
}
