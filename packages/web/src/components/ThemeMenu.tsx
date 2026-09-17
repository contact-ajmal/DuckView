import { useEffect, useRef, useState } from 'react';
import { Palette, Moon, Sun, Check, SlidersHorizontal } from 'lucide-react';
import { useTheme } from '../store/theme';
import { cn } from './ui';

/** Header quick switcher; full options live under Settings → Appearance. */
export function ThemeMenu() {
  const th = useTheme();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen(!open)} className="inline-flex items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-900/70 px-2 py-1 text-xs text-zinc-300 hover:text-zinc-100" title="Theme">
        {th.theme.kind === 'dark' ? <Moon className="h-3.5 w-3.5" /> : <Sun className="h-3.5 w-3.5" />} {th.theme.name}
      </button>
      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-64 rounded-lg border border-zinc-800 bg-zinc-900 p-1 shadow-xl">
          {(['dark', 'light'] as const).map((kind) => (
            <div key={kind} className="mb-1">
              <div className="px-2 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">{kind} themes</div>
              {th.themes
                .filter((t) => t.kind === kind)
                .map((t) => (
                  <button key={t.id} onClick={() => { th.setTheme(t.id); setOpen(false); }} className={cn('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-zinc-800', t.id === th.themeId && 'bg-zinc-800')}>
                    <span className="flex gap-0.5">{t.swatches.map((c, i) => <span key={i} className="h-3 w-2 rounded-sm border border-black/20" style={{ background: c }} />)}</span>
                    <span className="flex-1 text-zinc-100">{t.name}</span>
                    {t.id === th.themeId && <Check className="h-3.5 w-3.5 text-accent-300" />}
                  </button>
                ))}
            </div>
          ))}
          <a href="#/settings/appearance" onClick={() => setOpen(false)} className="mt-1 flex items-center gap-1.5 rounded-md border-t border-zinc-800 px-2 py-2 text-xs text-accent-300 hover:bg-zinc-800">
            <SlidersHorizontal className="h-3.5 w-3.5" /> Fonts, size & all options…
          </a>
          <div className="px-2 pb-1 text-[10px] text-zinc-600"><Palette className="mr-1 inline h-3 w-3" />Settings → Appearance</div>
        </div>
      )}
    </div>
  );
}
