import { visibleSubpages, type Route } from '../../app/routes';
import { cn } from '../ui';
import { useNavAccess } from './nav';

/**
 * The pages of the current section, as tabs directly under the top bar — only those the person can open. A change of
 * `group` (Build: making things ┆ modelling data) is set apart by a hairline. Absent for single-page sections.
 */
export function SectionNav({ route }: { route: Route }) {
  const pages = visibleSubpages(route.section, useNavAccess());
  if (pages.length < 2 || !route.sub) return null;
  return (
    <nav aria-label="Section" className="flex h-10 shrink-0 items-end gap-5 overflow-x-auto border-b border-zinc-800 px-5 max-sm:px-3">
      {pages.map((p, i) => (
        <span key={p.id} className="flex shrink-0 items-end gap-5">
          {i > 0 && (p.group ?? 0) !== (pages[i - 1]!.group ?? 0) && <span className="mb-2.5 h-4 w-px bg-zinc-800" aria-hidden />}
          <a
            href={p.hash}
            aria-current={route.sub === p.id ? 'page' : undefined}
            className={cn('-mb-px shrink-0 border-b-2 pb-2 text-body font-medium transition-colors duration-[var(--dur-fast)]', route.sub === p.id ? 'border-accent-500 text-zinc-50' : 'border-transparent text-zinc-400 hover:text-zinc-100')}
          >
            {p.label}
          </a>
        </span>
      ))}
    </nav>
  );
}
