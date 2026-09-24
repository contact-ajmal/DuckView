import { SUBPAGES, type Route } from '../../app/routes';
import { cn } from '../ui';

/** The pages of the current section, as tabs directly under the top bar. Absent for single-page sections. */
export function SectionNav({ route }: { route: Route }) {
  const pages = SUBPAGES[route.section];
  if (!pages || !route.sub) return null;
  return (
    <nav aria-label="Section" className="flex h-10 shrink-0 items-end gap-5 overflow-x-auto border-b border-zinc-800 px-5">
      {pages.map((p) => (
        <a
          key={p.id}
          href={p.hash}
          aria-current={route.sub === p.id ? 'page' : undefined}
          className={cn('-mb-px shrink-0 border-b-2 pb-2 text-body font-medium transition-colors duration-[var(--dur-fast)]', route.sub === p.id ? 'border-accent-500 text-zinc-50' : 'border-transparent text-zinc-500 hover:text-zinc-200')}
        >
          {p.label}
        </a>
      ))}
    </nav>
  );
}
