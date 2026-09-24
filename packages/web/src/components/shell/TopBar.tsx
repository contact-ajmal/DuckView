import { useEffect, useState } from 'react';
import { ChevronDown, Search, Sparkles, Users, Plus, LogOut, Moon, Sun, Check, SlidersHorizontal, LayoutPanelLeft, Eye, Cloud, HardDrive, Zap, FolderOpen, AlertTriangle, AppWindow, Bot, Boxes, FileCode2, LayoutDashboard, NotebookPen, Table2, Menu as MenuIcon } from 'lucide-react';
import { SECTIONS, sectionOf, type Route } from '../../app/routes';
import { useAuth } from '../../store/auth';
import { useWorkspace } from '../../store/workspace';
import { useCopilot } from '../../store/copilot';
import { useTheme } from '../../store/theme';
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

const OBJECT_ICON: Record<PageObjectKind, typeof Table2> = { dataset: Table2, dashboard: LayoutDashboard, notebook: NotebookPen, query: FileCode2, app: AppWindow, model: Boxes, agent: Bot };
const OBJECT_NOUN: Record<PageObjectKind, string> = { dataset: 'Dataset', dashboard: 'Dashboard', notebook: 'Notebook', query: 'Query tab', app: 'App', model: 'Model', agent: 'Agent' };

/** Compact application header: where you are, the command bar, status, AI and your account. */
export function TopBar({ route, onNewWorkspace, onShare }: { route: Route; onNewWorkspace: () => void; onShare: () => void }) {
  const auth = useAuth();
  const ws = useWorkspace();
  const cp = useCopilot();
  const th = useTheme();
  const palette = usePalette();
  const [live, setLive] = useState<'connecting' | 'live' | 'offline'>('connecting');
  useEffect(() => subscribeLiveEvents(() => undefined, setLive), []);
  const active = ws.workspaces.find((w) => w.id === ws.activeId);
  const section = sectionOf(route.section);
  const object = usePageContext((c) => c.object);
  const [navOpen, setNavOpen] = useState(false);
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
      <Drawer open={navOpen} onClose={() => setNavOpen(false)} title="DuckView" width="w-72">
        <nav aria-label="Sections" className="p-2">
          {SECTIONS.map((s) => (
            <a key={s.id} href={s.hash} onClick={() => setNavOpen(false)} aria-current={route.section === s.id ? 'page' : undefined} className={cn('flex items-center gap-3 rounded-md px-3 py-2 text-body', route.section === s.id ? 'bg-zinc-800/80 text-zinc-50' : 'text-zinc-300 hover:bg-zinc-900')}>
              <s.icon className="h-4 w-4 text-zinc-500" />
              <span className="min-w-0 flex-1">
                <span className="block">{s.label}</span>
                <span className="block truncate text-2xs text-zinc-500">{s.hint}</span>
              </span>
            </a>
          ))}
        </nav>
      </Drawer>
      {/* Workspace › section › page */}
      <div className="flex min-w-0 flex-1 items-center gap-1 text-body">
        <Menu
          align="left"
          width="w-80"
          trigger={(open, toggle) => (
            <button onClick={toggle} aria-expanded={open} data-testid="workspace-switcher" className="flex min-w-0 max-w-[16rem] items-center gap-1.5 rounded-md px-2 py-1 font-medium text-zinc-100 hover:bg-zinc-900">
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
            </>
          )}
        </Menu>
        <span className="text-zinc-700">/</span>
        <a href={section.hash} className="truncate rounded-md px-1.5 py-1 text-zinc-400 hover:text-zinc-100">{section.label}</a>
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
        <span className="min-w-0 flex-1 truncate">Search data, queries, commands…</span>
        <Kbd>{isMac ? '⌘' : 'Ctrl'}</Kbd>
        <Kbd className="-ml-1">K</Kbd>
      </button>

      <div className="flex flex-1 items-center justify-end gap-1.5">
        {storage && (
          <span title={storage.title} className={cn('hidden max-w-[12rem] items-center gap-1 truncate px-1.5 font-mono text-2xs lg:inline-flex', storage.tone === 'error' ? 'text-red-400' : storage.tone === 'warn' ? 'text-amber-500' : 'text-zinc-500')}>
            <storage.icon className="h-3 w-3 shrink-0" /> <span className="truncate">{storage.text}</span>
          </span>
        )}
        <span title={live === 'live' ? 'Connected: results, runs and activity update live' : live === 'connecting' ? 'Connecting to the live feed…' : 'Offline: reconnecting to the live feed'} className="px-1.5">
          <StatusDot tone={live === 'live' ? 'ok' : live === 'connecting' ? 'busy' : 'error'}>
            <span className="hidden xl:inline">{live === 'live' ? 'Live' : live === 'connecting' ? 'Connecting' : 'Offline'}</span>
          </StatusDot>
        </span>
        <InboxBell />
        <button
          onClick={() => cp.toggle()}
          aria-pressed={cp.open}
          data-testid="ai-toggle"
          title="DuckView AI — ask about what is on screen (⌘J)"
          className={cn('inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-body font-medium transition-colors', cp.open ? 'bg-accent-500 text-[color:var(--accent-ink)]' : 'text-zinc-300 hover:bg-zinc-900 hover:text-zinc-50')}
        >
          <Sparkles className="h-3.5 w-3.5" /> AI
        </button>
        <Menu
          width="w-64"
          trigger={(open, toggle) => (
            <button onClick={toggle} aria-expanded={open} aria-label={`Account: ${auth.user?.email}`} className="ml-0.5 flex h-7 w-7 items-center justify-center rounded-full bg-zinc-800 text-2xs font-semibold uppercase text-zinc-200 hover:bg-zinc-700">
              {(auth.user?.display_name ?? auth.user?.email ?? '?').slice(0, 1)}
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
              <MenuDivider />
              <MenuItem icon={<SlidersHorizontal className="h-3.5 w-3.5" />} onClick={() => { close(); location.hash = '#/settings/appearance'; }}>Appearance & fonts</MenuItem>
              <MenuItem icon={<LayoutPanelLeft className="h-3.5 w-3.5" />} onClick={() => { close(); location.hash = '#/settings/layout'; }}>Customize layout</MenuItem>
              <MenuDivider />
              <MenuItem icon={<LogOut className="h-3.5 w-3.5" />} onClick={() => { close(); auth.logout(); }}>Sign out</MenuItem>
            </>
          )}
        </Menu>
      </div>
    </header>
  );
}
