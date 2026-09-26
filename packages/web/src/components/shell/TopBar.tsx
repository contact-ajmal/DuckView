import { useEffect, useState } from 'react';
import { ChevronDown, Search, Users, Plus, Check, SlidersHorizontal, Eye, Keyboard, MessageSquareText, Cloud, HardDrive, Zap, FolderOpen, AlertTriangle, AppWindow, Bot, Boxes, FileCode2, LayoutDashboard, NotebookPen, Table2, Menu as MenuIcon } from 'lucide-react';
import { sectionOf, visibleSections, type Route } from '../../app/routes';
import { Logo } from '../Logo';
import { useNavAccess } from './nav';
import { ProfileMenu, openShortcuts } from './AccountMenu';
import { useAuth } from '../../store/auth';
import { useWorkspace } from '../../store/workspace';
import { useCopilot } from '../../store/copilot';
import { storageKindOf, type Workspace } from '../../api/client';
import { subscribeLiveEvents } from '../../lib/liveEvents';
import { usePalette } from './palette';
import { InboxBell } from './InboxBell';
import { Kbd, Menu, MenuDivider, MenuItem, StatusDot, cn, IconButton, Drawer } from '../ui';
import { usePageContext, type PageObjectKind } from '../../store/context';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

function storageLabel(w: Workspace): { icon: typeof Cloud; text: string; title: string; tone?: 'warn' | 'error' } {
  const kind = storageKindOf(w.active_db_path);
  if (kind === 'memory') return { icon: Zap, text: 'in memory', title: 'In-memory scratch database: tables are cleared when the engine restarts. Settings → Data → Make persistent keeps them.', tone: 'warn' };
  if (kind === 'cloud') {
    const s = w.cloud_sync;
    if (s?.last_error) return { icon: AlertTriangle, text: 'sync error', title: `Cloud sync problem: ${s.last_error}`, tone: 'error' };
    return { icon: Cloud, text: s?.dirty ? 'pending sync' : 'cloud', title: s?.dirty ? 'Changes not yet pushed to the cloud' : `Synced with ${w.active_db_path}`, tone: s?.dirty ? 'warn' : undefined };
  }
  if (kind === 'motherduck') return { icon: Cloud, text: 'MotherDuck', title: w.active_db_path };
  return { icon: kind === 'folder' ? FolderOpen : HardDrive, text: w.active_db_path.split('/').pop() ?? w.active_db_path, title: kind === 'folder' ? `Stored in a folder on the server: ${w.active_db_path}` : `DuckDB file in the data directory: ${w.active_db_path}` };
}

const OBJECT_ICON: Record<PageObjectKind, typeof Table2> = { dataset: Table2, dashboard: LayoutDashboard, notebook: NotebookPen, query: FileCode2, app: AppWindow, model: Boxes, agent: Bot, workspace: SlidersHorizontal };
const OBJECT_NOUN: Record<PageObjectKind, string> = { dataset: 'Dataset', dashboard: 'Dashboard', notebook: 'Notebook', query: 'Query tab', app: 'App', model: 'Model', agent: 'Agent', workspace: 'Workspace' };

/** Compact application header: where you are, the command bar, and three quiet icons (inbox, ask about this screen, and — on a phone — the profile). Status appears only when something is off. */
export function TopBar({ route, onNewWorkspace, onShare }: { route: Route; onNewWorkspace: () => void; onShare: () => void }) {
  const auth = useAuth();
  const ws = useWorkspace();
  const cp = useCopilot();
  const palette = usePalette();
  const [live, setLive] = useState<'connecting' | 'live' | 'offline'>('connecting');
  useEffect(() => subscribeLiveEvents(() => undefined, setLive), []);
  const active = ws.workspaces.find((w) => w.id === ws.activeId);
  const section = sectionOf(route.section);
  const object = usePageContext((c) => c.object);
  const [navOpen, setNavOpen] = useState(false);
  const sections = visibleSections(useNavAccess());
  // ⌘J opens and closes the AI panel from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        useCopilot.getState().toggle();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const storage = active ? storageLabel(active) : null;

  return (
    <header className="flex h-[var(--topbar-h)] shrink-0 items-center gap-3 border-b border-zinc-800 bg-zinc-950 pl-3 pr-2">
      {/* Narrow screens: the rail is hidden; its sections open from here. */}
      <IconButton label="Open navigation" className="sm:hidden" onClick={() => setNavOpen(true)}><MenuIcon className="h-4 w-4" /></IconButton>
      <Drawer open={navOpen} onClose={() => setNavOpen(false)} title={<Logo variant="full" className="h-6" />} width="w-72">
        <nav aria-label="Sections" className="p-2">
          {sections.map((s) => (
            <a key={s.id} href={s.hash} onClick={() => setNavOpen(false)} aria-current={route.section === s.id ? 'page' : undefined} data-section={s.id} className={cn('flex items-center gap-3 rounded-md px-3 py-2.5 text-body', route.section === s.id ? 'bg-zinc-800/80 text-zinc-50' : 'text-zinc-300 hover:bg-zinc-900')}>
              <s.icon className={cn('h-4 w-4', route.section === s.id ? 'text-accent-400' : 'text-zinc-500')} />
              <span className="min-w-0 flex-1 truncate">{s.label}</span>
            </a>
          ))}
          <div className="mx-3 my-2 border-t border-zinc-800" />
          <button type="button" onClick={() => { setNavOpen(false); openShortcuts(); }} className="flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left text-body text-zinc-300 hover:bg-zinc-900">
            <Keyboard className="h-4 w-4 text-zinc-500" /> Keyboard shortcuts
          </button>
        </nav>
      </Drawer>
      {/* Workspace › section › page */}
      <div className="flex min-w-0 flex-1 items-center gap-1 text-body">
        <Menu
          align="left"
          width="w-80"
          trigger={(open, toggle) => (
            <button onClick={toggle} aria-expanded={open} data-testid="workspace-switcher" className="flex min-w-0 max-w-[9rem] items-center gap-1.5 rounded-md px-2 py-1 font-medium text-zinc-100 hover:bg-zinc-900 xl:max-w-[16rem]">
              <span className="truncate">{active?.name ?? 'Workspace'}</span>
              {active?.shared && (active.role === 'VIEWER' ? <Eye className="h-3.5 w-3.5 shrink-0 text-zinc-500" /> : <Users className="h-3.5 w-3.5 shrink-0 text-zinc-500" />)}
              <ChevronDown className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
            </button>
          )}
        >
          {(close) => (
            <>
              {(
                [
                  ['Your workspaces', ws.workspaces.filter((w) => !w.shared)],
                  ['Shared with you', ws.workspaces.filter((w) => w.shared)],
                ] as const
              ).map(([label, items]) =>
                items.length === 0 ? null : (
                  <div key={label} className="mb-1">
                    <div className="px-2 pb-1 pt-1.5 text-2xs font-medium text-zinc-500">{label}</div>
                    {items.map((w) => (
                      <button
                        key={w.id}
                        onClick={() => {
                          close();
                          void ws.selectWorkspace(w.id);
                        }}
                        className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-zinc-900', w.id === ws.activeId && 'bg-zinc-900')}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-body text-zinc-100">{w.name}</span>
                          <span className="block truncate font-mono text-2xs text-zinc-500">{w.shared ? `${w.owner.display_name ?? w.owner.email} · ${w.role.toLowerCase()}` : w.active_db_path}</span>
                        </span>
                        {w.id === ws.activeId && <Check className="h-3.5 w-3.5 shrink-0 text-accent-400" />}
                      </button>
                    ))}
                  </div>
                ),
              )}
              <MenuDivider />
              {active && (
                <MenuItem icon={<Users className="h-3.5 w-3.5" />} onClick={() => { close(); onShare(); }}>
                  {active.role === 'OWNER' && auth.user?.role !== 'READ_ONLY' ? `Share ${active.name}…` : `Who has access`}
                </MenuItem>
              )}
              {auth.user?.role !== 'READ_ONLY' && (
                <MenuItem icon={<Plus className="h-3.5 w-3.5" />} onClick={() => { close(); onNewWorkspace(); }}>
                  New workspace
                </MenuItem>
              )}
              {active && active.role === 'OWNER' && (
                <MenuItem icon={<SlidersHorizontal className="h-3.5 w-3.5" />} onClick={() => { close(); location.hash = `#/workspaces/${active.id}`; }}>
                  Manage {active.name}
                </MenuItem>
              )}
              {auth.user?.role === 'ADMIN' && (
                <MenuItem icon={<Boxes className="h-3.5 w-3.5" />} onClick={() => { close(); location.hash = '#/settings/workspaces'; }}>
                  Manage workspaces
                </MenuItem>
              )}
            </>
          )}
        </Menu>
        <span className="text-zinc-700">/</span>
        <a href={section.hash} className="shrink-0 whitespace-nowrap rounded-md px-1.5 py-1 text-zinc-400 hover:text-zinc-100">{section.label}</a>
        {route.crumb && (
          <>
            <span className="text-zinc-700">/</span>
            <span className="truncate px-1.5 text-zinc-400">{route.crumb}</span>
          </>
        )}
        {object && (
          <>
            <span className="text-zinc-700">/</span>
            <span className="flex min-w-0 items-center gap-1.5 px-1.5 text-zinc-100" data-testid="page-object" title={`${OBJECT_NOUN[object.kind]}: ${object.label}`}>
              {(() => { const I = OBJECT_ICON[object.kind]; return <I className="h-3.5 w-3.5 shrink-0 text-zinc-500" />; })()}
              <span className="truncate">{object.label}</span>
            </span>
          </>
        )}
      </div>

      {/* Command bar */}
      <button onClick={() => palette.setOpen(true)} className="hidden h-7 w-[min(360px,30vw)] items-center gap-2 rounded-md border border-zinc-800 bg-zinc-900 px-2.5 text-left text-body text-zinc-500 hover:border-zinc-700 hover:text-zinc-300 md:flex" aria-label="Search or run a command">
        <Search className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">Ask, search or run a command…</span>
        <Kbd>{isMac ? '⌘' : 'Ctrl'}</Kbd>
        <Kbd className="-ml-1">K</Kbd>
      </button>

      <div className="flex flex-1 items-center justify-end gap-1">
        {storage && (
          <span title={storage.title} data-testid="storage-label" className={cn('hidden max-w-[12rem] items-center gap-1 truncate px-1.5 font-mono text-2xs lg:inline-flex', storage.tone === 'error' ? 'text-red-300' : storage.tone === 'warn' ? 'text-amber-500' : 'text-zinc-500')}>
            <storage.icon className="h-3 w-3 shrink-0" /> <span className={cn('truncate', !storage.tone && 'hidden xl:inline')}>{storage.text}</span>
          </span>
        )}
        {/* The live feed is only worth a word when it is not live. */}
        {live !== 'live' && (
          <span title={live === 'connecting' ? 'Connecting to the live feed…' : 'Offline: reconnecting to the live feed'} className="px-1.5" data-testid="live-status">
            <StatusDot tone={live === 'connecting' ? 'busy' : 'error'}>{live === 'connecting' ? 'Connecting' : 'Offline'}</StatusDot>
          </span>
        )}
        <InboxBell />
        <IconButton
          label={`Ask about this screen (${isMac ? '⌘' : 'Ctrl+'}J)`}
          onClick={() => cp.toggle()}
          aria-pressed={cp.open}
          active={cp.open}
          data-testid="ai-toggle"
        >
          <MessageSquareText className="h-4 w-4" />
        </IconButton>
        <ProfileMenu className="ml-1 sm:hidden" />
      </div>
    </header>
  );
}
