/**
 * The secondary destinations at the foot of the rail: Help and Profile (Settings is a plain link beside them). On a
 * phone the rail is hidden, so the top bar shows the profile menu instead.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Check, Command, HelpCircle, Keyboard, LayoutPanelLeft, LogOut, MessageCircleQuestion, Moon, SlidersHorizontal, Sun } from 'lucide-react';
import { useAuth } from '../../store/auth';
import { useTheme } from '../../store/theme';
import { usePalette } from './palette';
import { Kbd, Menu, MenuDivider, MenuItem, Modal, cn } from '../ui';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const mod = isMac ? '⌘' : 'Ctrl';

/** `console={false}` (the Analyst WebUI) leaves out the Console's own settings pages. */
export function ProfileMenu({ placement = 'below', className, console = true }: { placement?: 'below' | 'beside'; className?: string; console?: boolean }) {
  const auth = useAuth();
  const th = useTheme();
  const initial = (auth.user?.display_name ?? auth.user?.email ?? '?').slice(0, 1);
  return (
    <Menu
      width="w-64"
      placement={placement}
      className={className}
      trigger={(open, toggle) => (
        <button onClick={toggle} aria-expanded={open} aria-label={`Account: ${auth.user?.email}`} data-testid="account-menu" className="flex h-7 w-7 items-center justify-center rounded-full bg-zinc-800 text-2xs font-semibold uppercase text-zinc-200 transition-colors duration-[var(--dur-fast)] hover:bg-zinc-700">
          {initial}
        </button>
      )}
    >
      {(close) => (
        <>
          <div className="px-2 pb-2 pt-1.5">
            <div className="truncate text-body font-medium text-zinc-100">{auth.user?.display_name ?? auth.user?.email}</div>
            <div className="truncate text-2xs text-zinc-500">{auth.user?.email} · {auth.user?.role.toLowerCase().replace('_', ' ')}</div>
          </div>
          <MenuDivider />
          <div className="px-2 pb-1 pt-1 text-2xs font-medium text-zinc-500">Theme</div>
          {th.themes.map((t) => (
            <MenuItem key={t.id} active={t.id === th.themeId} icon={t.kind === 'dark' ? <Moon className="h-3.5 w-3.5" /> : <Sun className="h-3.5 w-3.5" />} onClick={() => th.setTheme(t.id)} hint={t.id === th.themeId ? <Check className="h-3.5 w-3.5 text-accent-400" /> : undefined}>
              {t.name}
            </MenuItem>
          ))}
          {console && (
            <>
              <MenuDivider />
              <MenuItem icon={<SlidersHorizontal className="h-3.5 w-3.5" />} onClick={() => { close(); location.hash = '#/settings/appearance'; }}>Appearance & fonts</MenuItem>
              <MenuItem icon={<LayoutPanelLeft className="h-3.5 w-3.5" />} onClick={() => { close(); location.hash = '#/settings/layout'; }}>Customize layout</MenuItem>
            </>
          )}
          <MenuDivider />
          <MenuItem icon={<LogOut className="h-3.5 w-3.5" />} onClick={() => { close(); auth.logout(); }}>Sign out</MenuItem>
        </>
      )}
    </Menu>
  );
}

/** Open the shortcuts sheet from anywhere (Help menu, the palette, "?"). */
export const openShortcuts = () => window.dispatchEvent(new Event('duckview:shortcuts'));

const SHORTCUTS: [keys: ReactNode, what: string][] = [
  [<><Kbd>{mod}</Kbd><Kbd>K</Kbd></>, 'Search and run any command'],
  [<><Kbd>{mod}</Kbd><Kbd>I</Kbd></>, 'Ask the agent, with what is on screen'],
  [<><Kbd>{mod}</Kbd><Kbd>J</Kbd></>, 'Ask about this screen'],
  [<><Kbd>{mod}</Kbd><Kbd>↵</Kbd></>, 'Run the query, or start the mission'],
  [<><Kbd>{mod}</Kbd><Kbd>S</Kbd></>, 'Save the query'],
  [<Kbd>Esc</Kbd>, 'Close, or stop a running query'],
  [<Kbd>?</Kbd>, 'These shortcuts'],
];

/** The app-wide shortcuts sheet (the workbench keeps its own, with the editor's keys). */
export function ShortcutsSheet() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const show = () => setOpen(true);
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key !== '?' || e.metaKey || e.ctrlKey || t?.closest('input, textarea, select, [contenteditable="true"], .cm-editor')) return;
      e.preventDefault();
      setOpen(true);
    };
    window.addEventListener('duckview:shortcuts', show);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('duckview:shortcuts', show);
      window.removeEventListener('keydown', onKey);
    };
  }, []);
  return (
    <Modal open={open} onClose={() => setOpen(false)} title="Keyboard shortcuts" width="max-w-md">
      <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 text-body" data-testid="app-shortcuts">
        {SHORTCUTS.map(([k, what]) => (
          <div key={what} className="contents">
            <dt className="flex items-center gap-1">{k}</dt>
            <dd className="text-zinc-300">{what}</dd>
          </div>
        ))}
      </dl>
    </Modal>
  );
}

export function HelpMenu({ placement = 'beside', className }: { placement?: 'below' | 'beside'; className?: string }) {
  const palette = usePalette();
  return (
    <Menu
      width="w-60"
      placement={placement}
      className={className}
      trigger={(open, toggle) => (
        <button onClick={toggle} aria-expanded={open} aria-label="Help" title="Help" data-testid="help-menu" className={cn('flex h-8 w-9 items-center justify-center rounded-md text-zinc-400 transition-colors duration-[var(--dur-fast)] hover:bg-zinc-800/60 hover:text-zinc-100', open && 'bg-zinc-800/80 text-zinc-50')}>
          <HelpCircle className="h-[18px] w-[18px]" strokeWidth={1.75} />
        </button>
      )}
    >
      {(close) => (
        <>
          <MenuItem icon={<Command className="h-3.5 w-3.5" />} hint={<span className="text-2xs text-zinc-500">{mod} K</span>} onClick={() => { close(); palette.setOpen(true); }}>Command palette</MenuItem>
          <MenuItem icon={<Keyboard className="h-3.5 w-3.5" />} hint={<span className="text-2xs text-zinc-500">?</span>} onClick={() => { close(); openShortcuts(); }}>Keyboard shortcuts</MenuItem>
          <MenuDivider />
          <MenuItem
            icon={<MessageCircleQuestion className="h-3.5 w-3.5" />}
            onClick={() => {
              close();
              location.hash = '#/';
              setTimeout(() => window.dispatchEvent(new CustomEvent('duckview:agent-focus', { detail: { mode: 'explain', text: 'How do I ' } })), 50);
            }}
          >
            Ask the agent how to…
          </MenuItem>
        </>
      )}
    </Menu>
  );
}
