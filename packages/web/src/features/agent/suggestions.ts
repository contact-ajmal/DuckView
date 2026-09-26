/** Commands that fit what is on screen, offered before the person types. */
export function suggestionsFor(page: { kind: string; label: string } | null): string[] {
  switch (page?.kind) {
    case 'dataset':
      return ['Profile this', 'Find anomalies', 'Explain these columns', 'Create quality checks', 'Build a dashboard'];
    case 'dashboard':
      return ['Explain this dashboard', 'What changed recently?', 'Add a chart of revenue by month', 'Create a notebook explaining this'];
    case 'query':
      return ['Explain this query', 'Why is this slow?', 'Chart this result', 'Save this query'];
    case 'notebook':
      return ['Summarise this notebook', 'Check the numbers', 'Add a chart'];
    case 'app':
      return ['Explain this app', 'What data does it use?'];
    default:
      return ['What data do we have?', 'Find the tables related to customers', 'Analyse revenue by region', 'Find data quality problems'];
  }
}
