import { visibleSections, type Section, type SectionDef } from '../../app/routes';
import { Logo } from '../Logo';
import { cn } from '../ui';
import { useNavAccess } from './nav';
import { HelpMenu, ProfileMenu } from './AccountMenu';

/**
 * The primary navigation: a narrow rail of five destinations (Agent, Workspaces, Data, Build, Connect) — only those
 * the person can use — and, at its foot, Help, Settings and the profile.
 */
export function Sidebar({ active }: { active: Section }) {
  const sections = visibleSections(useNavAccess());
  const main = sections.filter((s) => s.id !== 'settings');
  const settings = sections.find((s) => s.id === 'settings')!;
  const item = (s: SectionDef, compact = false) => {
    const on = s.id === active;
    const Icon = s.icon;
    return (
      <a
        key={s.id}
        href={s.hash}
        title={s.hint}
        aria-current={on ? 'page' : undefined}
        aria-label={compact ? s.label : undefined}
        data-section={s.id}
        className={cn('group relative flex w-full flex-col items-center gap-1 rounded-md py-1.5 transition-colors duration-[var(--dur-fast)]', on ? 'text-zinc-50' : 'text-zinc-400 hover:text-zinc-100')}
      >
        <span className={cn('absolute -left-1 top-2 h-5 w-[3px] rounded-r bg-accent-500 transition-opacity duration-[var(--dur-fast)]', on ? 'opacity-100' : 'opacity-0')} />
        <span className={cn('flex h-8 w-9 items-center justify-center rounded-md transition-colors duration-[var(--dur-fast)]', on ? 'bg-zinc-800/80' : 'group-hover:bg-zinc-800/60')}>
          <Icon className="h-[18px] w-[18px]" strokeWidth={on ? 2 : 1.75} />
        </span>
        {!compact && <span className="whitespace-nowrap text-2xs font-medium leading-none tracking-[-0.01em]">{s.label}</span>}
      </a>
    );
  };
  return (
    <nav aria-label="Primary" className="hidden w-[var(--rail-w)] shrink-0 flex-col items-center border-r border-zinc-800 bg-zinc-900 px-1 pb-2 sm:flex">
      <a href="#/" className="flex h-[var(--topbar-h)] shrink-0 items-center justify-center" title="DuckView — the agent">
        <Logo className="h-7 w-7" label="DuckView" />
      </a>
      <div className="mt-2 flex w-full flex-1 flex-col gap-1">{main.map((s) => item(s))}</div>
      <div className="flex w-full flex-col items-center gap-1 border-t border-zinc-800 pt-2" data-testid="rail-secondary">
        <HelpMenu />
        {item(settings, true)}
        <ProfileMenu placement="beside" className="mt-1" />
      </div>
    </nav>
  );
}
