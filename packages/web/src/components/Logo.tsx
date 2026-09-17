export function Logo({ className = 'h-8 w-8' }: { className?: string }) {
  return (
    <svg viewBox="0 0 100 100" className={className} aria-hidden>
      <rect width="100" height="100" rx="22" fill="#7c3aed" />
      <path d="M28 30h26a20 20 0 0 1 0 40H28z" fill="none" stroke="white" strokeWidth="9" strokeLinejoin="round" />
      <circle cx="68" cy="50" r="6" fill="white" />
    </svg>
  );
}
