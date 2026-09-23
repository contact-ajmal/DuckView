/** The DuckView mark: a "D" whose bowl is a duck's head, in duckbill yellow with dark ink. */
export function Logo({ className = 'h-8 w-8' }: { className?: string }) {
  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden>
      <rect width="100" height="100" rx="20" fill="var(--color-accent-500)" />
      <path d="M28 28h24a22 22 0 0 1 0 44H28z" fill="none" stroke="var(--accent-ink)" strokeWidth="9" strokeLinejoin="round" />
      <circle cx="58" cy="44" r="5" fill="var(--accent-ink)" />
      <path d="M74 50h10" stroke="var(--accent-ink)" strokeWidth="8" strokeLinecap="round" />
    </svg>
  );
}
