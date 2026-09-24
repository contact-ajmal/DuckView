import { Check, Moon, Sun, RotateCcw } from 'lucide-react';
import { useTheme } from '../../store/theme';
import { SANS_FONTS, MONO_FONTS, FONT_STACKS, type Theme } from '../../theme/themes';
import { Label, Select, cn } from '../../components/ui';

/** Miniature window rendered from the theme's own colors. */
function ThemePreview({ t }: { t: Theme }) {
  const [page, card, border, text, accent] = t.swatches as [string, string, string, string, string];
  return (
    <div className="h-24 w-full overflow-hidden rounded-md border" style={{ background: page, borderColor: border, fontFamily: t.fonts.sans }}>
      <div className="flex h-5 items-center gap-1 border-b px-2" style={{ borderColor: border, background: card }}>
        <span className="h-2 w-2 rounded-sm" style={{ background: accent }} />
        <span className="h-1.5 w-10 rounded" style={{ background: text, opacity: 0.8 }} />
        <span className="ml-auto h-1.5 w-6 rounded" style={{ background: text, opacity: 0.3 }} />
      </div>
      <div className="flex gap-1.5 p-2">
        <div className="w-1/3 space-y-1 rounded border p-1.5" style={{ borderColor: border, background: card }}>
          <span className="block h-1 w-3/4 rounded" style={{ background: text, opacity: 0.7 }} />
          <span className="block h-1 w-1/2 rounded" style={{ background: text, opacity: 0.35 }} />
          <span className="block h-1 w-2/3 rounded" style={{ background: text, opacity: 0.35 }} />
        </div>
        <div className="flex-1 rounded border p-1.5" style={{ borderColor: border, background: card }}>
          <div className="flex h-full items-end gap-1">
            {t.series.slice(0, 6).map((c, i) => (
              <span key={c} className="flex-1 rounded-sm" style={{ background: c, height: `${35 + ((i * 37) % 55)}%` }} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export function AppearanceSettings() {
  const th = useTheme();
  const groups: { kind: Theme['kind']; label: string; icon: React.ReactNode }[] = [
    { kind: 'dark', label: 'Dark themes', icon: <Moon className="h-3.5 w-3.5" /> },
    { kind: 'light', label: 'Light themes', icon: <Sun className="h-3.5 w-3.5" /> },
  ];
  return (
    <div className="space-y-6">
      {groups.map((g) => (
        <section key={g.kind}>
          <div className="mb-2 flex items-center gap-1.5 text-2xs font-semibold text-zinc-500">
            {g.icon} {g.label}
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            {th.themes
              .filter((t) => t.kind === g.kind)
              .map((t) => {
                const active = t.id === th.themeId;
                return (
                  <button key={t.id} onClick={() => th.setTheme(t.id)} className={cn('rounded-xl border p-3 text-left transition-colors', active ? 'border-accent-500 bg-accent-600/10' : 'border-zinc-800 hover:border-zinc-600')}>
                    <ThemePreview t={t} />
                    <div className="mt-2 flex items-center justify-between">
                      <span className="text-body font-semibold text-zinc-100">{t.name}</span>
                      {active && <span className="inline-flex items-center gap-1 rounded-full bg-accent-600/20 px-1.5 py-0.5 text-2xs text-accent-100"><Check className="h-3 w-3" /> active</span>}
                    </div>
                    <p className="mt-0.5 text-2xs text-zinc-500">{t.description}</p>
                    <p className="mt-1 font-mono text-2xs text-zinc-600">{t.fonts.sans.split(',')[0]!.replace(/"/g, '')} · {t.fonts.mono.split(',')[0]!.replace(/"/g, '')}</p>
                  </button>
                );
              })}
          </div>
        </section>
      ))}

      <section className="grid gap-4 md:grid-cols-3">
        <div>
          <Label>Interface font</Label>
          <Select value={th.sans ?? ''} onChange={(e) => th.setFonts({ sans: (e.target.value || null) as typeof th.sans })} className="w-full">
            <option value="">Theme default</option>
            {SANS_FONTS.map((f) => (
              <option key={f.id} value={f.id}>{f.label}</option>
            ))}
          </Select>
          <p className="mt-1 text-2xs text-zinc-500" style={{ fontFamily: th.sans ? FONT_STACKS[th.sans] : th.theme.fonts.sans }}>The quick brown fox jumps over the lazy dog.</p>
        </div>
        <div>
          <Label>Code font</Label>
          <Select value={th.mono ?? ''} onChange={(e) => th.setFonts({ mono: (e.target.value || null) as typeof th.mono })} className="w-full">
            <option value="">Theme default</option>
            {MONO_FONTS.map((f) => (
              <option key={f.id} value={f.id}>{f.label}</option>
            ))}
          </Select>
          <p className="mt-1 text-2xs text-zinc-500" style={{ fontFamily: th.mono ? FONT_STACKS[th.mono] : th.theme.fonts.mono }}>SELECT region, sum(revenue) FROM 'sales.parquet';</p>
        </div>
        <div>
          <Label>Interface size · {th.scale}%</Label>
          <input type="range" min={80} max={130} step={5} value={th.scale} onChange={(e) => th.setScale(Number(e.target.value))} className="mt-2 w-full accent-accent-500" />
          <div className="flex justify-between font-mono text-2xs text-zinc-500"><span>80%</span><span>100%</span><span>130%</span></div>
        </div>
      </section>
      <div className="flex items-center justify-between border-t border-zinc-800 pt-3">
        <p className="text-2xs text-zinc-500">Theme, fonts and size are stored in this browser. Charts use a colour-blind-checked palette per theme.</p>
        <button onClick={th.reset} className="inline-flex items-center gap-1 rounded-md border border-zinc-800 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"><RotateCcw className="h-3 w-3" /> Reset appearance</button>
      </div>
    </div>
  );
}
