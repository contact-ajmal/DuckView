import { create } from 'zustand';
import { THEMES, DEFAULT_THEME_ID, FONT_STACKS, themeById, type Theme, type Step, type AccentStep, type ToneName } from '../theme/themes';

const KEY = 'duckview.theme';
export interface ThemePrefs {
  themeId: string;
  /** Font overrides; null = the theme's own fonts. */
  sans: keyof typeof FONT_STACKS | null;
  mono: keyof typeof FONT_STACKS | null;
  /** UI scale in percent (root font-size). */
  scale: number;
}
const DEFAULTS: ThemePrefs = { themeId: DEFAULT_THEME_ID, sans: null, mono: null, scale: 100 };

/** First visit follows the OS colour scheme (Midnight / Daylight); any saved choice wins after that. */
function systemDefault(): string {
  try {
    return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'daylight' : DEFAULT_THEME_ID;
  } catch {
    return DEFAULT_THEME_ID;
  }
}

function load(): ThemePrefs {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<ThemePrefs> | null;
    if (!saved) return { ...DEFAULTS, themeId: systemDefault() };
    return { ...DEFAULTS, ...saved };
  } catch {
    return DEFAULTS;
  }
}

const STEPS: Step[] = ['50', '100', '200', '300', '400', '500', '600', '700', '800', '900', '950'];
const ACCENT_STEPS: AccentStep[] = ['50', '100', '200', '300', '400', '500', '600', '700'];
const TONES: ToneName[] = ['emerald', 'amber', 'red', 'sky', 'fuchsia'];

/** Writes every theme token onto <html>. Tailwind utilities reference these through @theme (see index.css). */
export function applyTheme(prefs: ThemePrefs) {
  const t = themeById(prefs.themeId);
  const root = document.documentElement;
  const set = (k: string, v: string) => root.style.setProperty(k, v);
  for (const s of STEPS) set(`--t-zinc-${s}`, t.zinc[s]);
  for (const s of ACCENT_STEPS) set(`--t-accent-${s}`, t.accent[s]);
  for (const tone of TONES) for (const s of STEPS) set(`--t-${tone}-${s}`, t.tones[tone][s]);
  t.series.forEach((c, i) => set(`--series-${i + 1}`, c));
  set('--status-good', t.status.good);
  set('--status-warning', t.status.warning);
  set('--status-serious', t.status.serious);
  set('--status-critical', t.status.critical);
  set('--t-font-sans', prefs.sans ? FONT_STACKS[prefs.sans] : t.fonts.sans);
  set('--t-font-mono', prefs.mono ? FONT_STACKS[prefs.mono] : t.fonts.mono);
  root.style.fontSize = `${prefs.scale}%`;
  root.dataset.theme = t.id;
  root.dataset.themeKind = t.kind;
  root.style.colorScheme = t.kind;
  root.classList.toggle('dark', t.kind === 'dark');
}

interface ThemeState extends ThemePrefs {
  theme: Theme;
  themes: Theme[];
  setTheme(id: string): void;
  setFonts(p: { sans?: keyof typeof FONT_STACKS | null; mono?: keyof typeof FONT_STACKS | null }): void;
  setScale(pct: number): void;
  reset(): void;
}

const initial = load();
applyTheme(initial);

export const useTheme = create<ThemeState>((set, get) => {
  const commit = (prefs: ThemePrefs) => {
    applyTheme(prefs);
    try {
      localStorage.setItem(KEY, JSON.stringify(prefs));
    } catch {
      /* ignore */
    }
    set({ ...prefs, theme: themeById(prefs.themeId) });
  };
  return {
    ...initial,
    theme: themeById(initial.themeId),
    themes: THEMES,
    setTheme: (id) => commit({ ...get(), themeId: id }),
    setFonts: (p) => commit({ ...get(), sans: p.sans === undefined ? get().sans : p.sans, mono: p.mono === undefined ? get().mono : p.mono }),
    setScale: (pct) => commit({ ...get(), scale: Math.max(80, Math.min(130, Math.round(pct))) }),
    reset: () => commit({ ...DEFAULTS, themeId: systemDefault() }),
  };
});

/** Chart colors derived from the active theme (grid/ticks/tooltip follow the neutral ramp). */
export function useChartTheme() {
  const t = useTheme((s) => s.theme);
  return chartColorsFor(t);
}
export function chartColorsFor(t: Theme) {
  return {
    series: t.series,
    accent: t.series[0]!,
    grid: t.zinc['800'],
    tick: t.zinc['400'],
    border: t.zinc['900'],
    surface: t.zinc['900'],
    tooltipBg: t.zinc['900'],
    tooltipBorder: t.zinc['700'],
    tooltipTitle: t.zinc['100'],
    tooltipBody: t.zinc['200'],
    text: t.zinc['300'],
    muted: t.zinc['500'],
    kind: t.kind,
  };
}
