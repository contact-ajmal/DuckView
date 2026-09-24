import { SECTIONS, type Section } from '../../app/routes';
import { Logo } from '../Logo';
import { cn } from '../ui';

/** The primary navigation: a narrow rail of eight destinations, settings pinned to the bottom. */
export function Sidebar({ active }: { active: Section }) {
  const main = SECTIONS.filter((s) => s.id !== 'settings');
  const settings = SECTIONS.find((s) => s.id === 'settings')!;
  const item = (s: (typeof SECTIONS)[number]) => {
    const on = s.id === active;
    const Icon = s.icon;
    return (
      <a
        key={s.id}
        href={s.hash}
        title={s.hint}
        aria-current={on ? 'page' : undefined}
        data-section={s.id}
        className={cn('group relative flex w-full flex-col items-center gap-1 rounded-md py-2 transition-colors duration-[var(--dur-fast)]', on ? 'text-zinc-50' : 'text-zinc-500 hover:text-zinc-200')}
      >
        <span className={cn('absolute -left-1 top-2 bottom-2 w-[3px] rounded-r bg-accent-500 transition-opacity', on ? 'opacity-100' : 'opacity-0')} />
        <span className={cn('flex h-8 w-9 items-center justify-center rounded-md transition-colors', on ? 'bg-zinc-800/80' : 'group-hover:bg-zinc-900')}>
          <Icon className="h-[18px] w-[18px]" strokeWidth={on ? 2 : 1.75} />
        </span>
        <span className="whitespace-nowrap text-2xs font-medium leading-none tracking-[-0.01em]">{s.label}</span>
      </a>
    );
  };
  return (
    <nav aria-label="Primary" className="hidden w-[var(--rail-w)] sm:flex shrink-0 flex-col items-center border-r border-zinc-800 bg-zinc-900 px-1 pb-2">
      <a href="#/" className="flex h-[var(--topbar-h)] shrink-0 items-center justify-center" title="DuckView — home">
        <Logo className="h-7 w-7" />
      </a>
      <div className="mt-1 flex w-full flex-1 flex-col gap-0.5">{main.map(item)}</div>
      <div className="w-full">{item(settings)}</div>
    </nav>
  );
}
