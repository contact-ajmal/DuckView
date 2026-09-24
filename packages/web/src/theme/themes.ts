/**
 * Theme definitions. Each theme decides:
 *   - the neutral ramp (`zinc` in the code base: 950 = page background … 50 = strongest text)
 *   - the accent ramp, the tone ramps used by badges (emerald/amber/red/sky/fuchsia)
 *   - fonts, the code-editor variant, and the categorical chart palette (validated per surface)
 * Light themes mirror the ramps so every existing `bg-zinc-950 / text-zinc-100` usage flips correctly.
 */
export type Step = '50' | '100' | '200' | '300' | '400' | '500' | '600' | '700' | '800' | '900' | '950';
export type Ramp = Record<Step, string>;
export type AccentStep = '50' | '100' | '200' | '300' | '400' | '500' | '600' | '700';
export type AccentRamp = Record<AccentStep, string>;
export type ToneName = 'emerald' | 'amber' | 'red' | 'sky' | 'fuchsia';

export interface Theme {
  id: string;
  name: string;
  kind: 'dark' | 'light';
  description: string;
  fonts: { sans: string; mono: string };
  zinc: Ramp;
  accent: AccentRamp;
  tones: Record<ToneName, Ramp>;
  /** Categorical chart palette in fixed order (never cycled). */
  series: string[];
  status: { good: string; warning: string; serious: string; critical: string };
  /** Preview swatches for the picker: [page, card, border, text, accent]. */
  swatches: string[];
}

const STEPS: Step[] = ['50', '100', '200', '300', '400', '500', '600', '700', '800', '900', '950'];
const ramp = (values: string[]): Ramp => Object.fromEntries(STEPS.map((s, i) => [s, values[i]!])) as Ramp;
/** Light themes: 50↔950, 100↔900 … so tints stay light and text stays dark. */
const mirror = (r: Ramp): Ramp => Object.fromEntries(STEPS.map((s, i) => [s, r[STEPS[STEPS.length - 1 - i]!]])) as Ramp;

// Tailwind default ramps (hex) used as the base for tones.
const TW = {
  emerald: ramp(['#ecfdf5', '#d1fae5', '#a7f3d0', '#6ee7b7', '#34d399', '#10b981', '#059669', '#047857', '#065f46', '#064e3b', '#022c22']),
  amber: ramp(['#fffbeb', '#fef3c7', '#fde68a', '#fcd34d', '#fbbf24', '#f59e0b', '#d97706', '#b45309', '#92400e', '#78350f', '#451a03']),
  red: ramp(['#fef2f2', '#fee2e2', '#fecaca', '#fca5a5', '#f87171', '#ef4444', '#dc2626', '#b91c1c', '#991b1b', '#7f1d1d', '#450a0a']),
  sky: ramp(['#f0f9ff', '#e0f2fe', '#bae6fd', '#7dd3fc', '#38bdf8', '#0ea5e9', '#0284c7', '#0369a1', '#075985', '#0c4a6e', '#082f49']),
  fuchsia: ramp(['#fdf4ff', '#fae8ff', '#f5d0fe', '#f0abfc', '#e879f9', '#d946ef', '#c026d3', '#a21caf', '#86198f', '#701a75', '#4a044e']),
  zinc: ramp(['#fafafa', '#f4f4f5', '#e4e4e7', '#d4d4d8', '#a1a1aa', '#71717a', '#52525b', '#3f3f46', '#27272a', '#18181b', '#09090b']),
  neutral: ramp(['#fafafa', '#f5f5f5', '#e5e5e5', '#d4d4d4', '#a3a3a3', '#737373', '#525252', '#404040', '#262626', '#171717', '#0a0a0a']),
  gray: ramp(['#f9fafb', '#f3f4f6', '#e5e7eb', '#d1d5db', '#9ca3af', '#6b7280', '#4b5563', '#374151', '#1f2937', '#111827', '#030712']),
};
const DARK_TONES: Record<ToneName, Ramp> = { emerald: TW.emerald, amber: TW.amber, red: TW.red, sky: TW.sky, fuchsia: TW.fuchsia };
/** With the yellow accent, warnings move to orange so they never read as "active". */
const TW_ORANGE = ramp(['#fff7ed', '#ffedd5', '#fed7aa', '#fdba74', '#fb923c', '#f97316', '#ea580c', '#c2410c', '#9a3412', '#7c2d12', '#431407']);
const LIGHT_TONES: Record<ToneName, Ramp> = { emerald: mirror(TW.emerald), amber: mirror(TW.amber), red: mirror(TW.red), sky: mirror(TW.sky), fuchsia: mirror(TW.fuchsia) };
const DUCK_DARK_TONES: Record<ToneName, Ramp> = { ...DARK_TONES, amber: TW_ORANGE };
const DUCK_LIGHT_TONES: Record<ToneName, Ramp> = { ...LIGHT_TONES, amber: mirror(TW_ORANGE) };

/**
 * Accent ramps. 500–700 stay saturated (solid buttons, sliders); on light themes 50–400 are re-pointed at darker
 * steps because they are used for link text and chip text over pale tints.
 */
const accentDark = (v: string[]): AccentRamp => ({ '50': v[0]!, '100': v[1]!, '200': v[2]!, '300': v[3]!, '400': v[4]!, '500': v[5]!, '600': v[6]!, '700': v[7]! });
const accentLight = (v: string[]): AccentRamp => ({ '50': v[8] ?? v[7]!, '100': v[7]!, '200': v[7]!, '300': v[6]!, '400': v[5]!, '500': v[5]!, '600': v[6]!, '700': v[7]! });
const VIOLET = ['#f5f3ff', '#ede9fe', '#ddd6fe', '#c4b5fd', '#a78bfa', '#8b5cf6', '#7c3aed', '#6d28d9', '#5b21b6'];
const BLUE = ['#eff6ff', '#dbeafe', '#bfdbfe', '#93c5fd', '#60a5fa', '#3b82f6', '#2563eb', '#1d4ed8', '#1e3a8a'];
const TEAL = ['#e8f6fa', '#cfeaf3', '#b3dde9', '#9bcfdd', '#88c0d0', '#6faabc', '#5591a3', '#45788a', '#365f6e'];
const NAVY = ['#eef2ff', '#e0e7ff', '#c7d2fe', '#a5b4fc', '#6366f1', '#4f46e5', '#3730a3', '#312e81', '#1e1b4b'];
/** DuckView's accent: duckbill yellow. Fills carry dark ink text (see --accent-ink); text uses the deeper steps. */
const DUCK_DARK: AccentRamp = { '50': '#fff8e1', '100': '#ffefb8', '200': '#fde58a', '300': '#f5d06a', '400': '#f2c94c', '500': '#f0b429', '600': '#e8a70f', '700': '#b8860b' };
const DUCK_LIGHT: AccentRamp = { '50': '#5c3d00', '100': '#664400', '200': '#6b4700', '300': '#7a5200', '400': '#8a5d00', '500': '#f0b429', '600': '#e8a70f', '700': '#c78a00' };
const ORANGE = ['#fff7ed', '#ffedd5', '#fed7aa', '#fdba74', '#fb923c', '#f97316', '#ea580c', '#c2410c', '#9a3412'];

// Chart palettes validated with the dataviz validator on each theme's card surface.
const SERIES_DARK_VIOLET = ['#9085e9', '#d95926', '#199e70', '#c98500', '#d55181', '#3987e5', '#008300', '#e66767'];
const SERIES_DARK_BLUE = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#9085e9', '#008300', '#e66767'];
const SERIES_DARK_TEAL = ['#199e70', '#d95926', '#3987e5', '#c98500', '#d55181', '#9085e9', '#008300', '#e66767'];
const SERIES_LIGHT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];

const STATUS_DARK = { good: '#22c55e', warning: '#f59e0b', serious: '#f97316', critical: '#ef4444' };
const STATUS_LIGHT = { good: '#15803d', warning: '#b45309', serious: '#c2410c', critical: '#b91c1c' };

export const FONT_STACKS = {
  inter: '"Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  plexSans: '"IBM Plex Sans", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  manrope: '"Manrope", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  nunito: '"Nunito Sans", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  system: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  jetbrains: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  plexMono: '"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  fira: '"Fira Code", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  systemMono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
} as const;

export const SANS_FONTS: { id: keyof typeof FONT_STACKS; label: string }[] = [
  { id: 'inter', label: 'Inter' },
  { id: 'plexSans', label: 'IBM Plex Sans' },
  { id: 'manrope', label: 'Manrope' },
  { id: 'nunito', label: 'Nunito Sans' },
  { id: 'system', label: 'System default' },
];
export const MONO_FONTS: { id: keyof typeof FONT_STACKS; label: string }[] = [
  { id: 'jetbrains', label: 'JetBrains Mono' },
  { id: 'plexMono', label: 'IBM Plex Mono' },
  { id: 'fira', label: 'Fira Code' },
  { id: 'systemMono', label: 'System monospace' },
];

const light = (values: string[]): Ramp => ramp(values); // values already ordered 50 → 950 for the *page* semantics (950 = lightest)

export const THEMES: Theme[] = [
  {
    id: 'midnight',
    name: 'Midnight',
    kind: 'dark',
    description: 'Graphite surfaces with the duckbill-yellow accent — the default dark look.',
    fonts: { sans: FONT_STACKS.plexSans, mono: FONT_STACKS.jetbrains },
    zinc: ramp(['#f1f3f5', '#e3e6ea', '#c9ced5', '#a9b0b8', '#8a929b', '#7c848d', '#4c535b', '#363c43', '#272c32', '#181b1f', '#0f1113']),
    accent: DUCK_DARK,
    tones: DUCK_DARK_TONES,
    series: SERIES_DARK_BLUE,
    status: { ...STATUS_DARK, warning: '#f97316' },
    swatches: ['#0f1113', '#181b1f', '#272c32', '#e3e6ea', '#f0b429'],
  },
  {
    id: 'graphite',
    name: 'Graphite',
    kind: 'dark',
    description: 'True neutral grays with a blue accent; IBM Plex type.',
    fonts: { sans: FONT_STACKS.plexSans, mono: FONT_STACKS.plexMono },
    // Tailwind's neutral, with 500 lifted so secondary text reads at 4.5:1 on raised surfaces.
    zinc: { ...TW.neutral, '500': '#818181' },
    accent: accentDark(BLUE),
    tones: DARK_TONES,
    series: SERIES_DARK_BLUE,
    status: STATUS_DARK,
    swatches: ['#0a0a0a', '#171717', '#262626', '#f5f5f5', '#2563eb'],
  },
  {
    id: 'fjord',
    name: 'Fjord',
    kind: 'dark',
    description: 'Cool blue-gray surfaces with a teal accent (Nord-inspired).',
    fonts: { sans: FONT_STACKS.manrope, mono: FONT_STACKS.fira },
    zinc: ramp(['#eceff4', '#e5e9f0', '#d8dee9', '#c5cbd8', '#a3adc2', '#8690a4', '#4c566a', '#3b4252', '#2e3440', '#232834', '#1b1f27']),
    accent: accentDark(TEAL),
    tones: DARK_TONES,
    series: SERIES_DARK_TEAL,
    status: STATUS_DARK,
    swatches: ['#1b1f27', '#232834', '#2e3440', '#e5e9f0', '#5591a3'],
  },
  {
    id: 'daylight',
    name: 'Daylight',
    kind: 'light',
    description: 'White workspace, cool gray chrome and the duckbill-yellow accent — the default light look.',
    fonts: { sans: FONT_STACKS.plexSans, mono: FONT_STACKS.jetbrains },
    zinc: light(['#0f1115', '#1b1e24', '#2b2f36', '#3e434b', '#565c66', '#646b76', '#9aa1ab', '#d5d9de', '#e7e9ec', '#f5f6f8', '#ffffff']),
    accent: DUCK_LIGHT,
    tones: DUCK_LIGHT_TONES,
    series: SERIES_LIGHT,
    status: { ...STATUS_LIGHT, warning: '#c2410c' },
    swatches: ['#ffffff', '#f5f6f8', '#e7e9ec', '#1b1e24', '#f0b429'],
  },
  {
    id: 'professional',
    name: 'Professional',
    kind: 'light',
    description: 'Cool gray workspace, navy accent, IBM Plex type — for corporate dashboards.',
    fonts: { sans: FONT_STACKS.plexSans, mono: FONT_STACKS.plexMono },
    zinc: light(['#030712', '#111827', '#1f2937', '#374151', '#4b5563', '#6b7280', '#9ca3af', '#d1d5db', '#e5e7eb', '#ffffff', '#f3f4f6']),
    accent: accentLight(NAVY),
    tones: LIGHT_TONES,
    series: SERIES_LIGHT,
    status: STATUS_LIGHT,
    swatches: ['#f3f4f6', '#ffffff', '#e5e7eb', '#111827', '#3730a3'],
  },
  {
    id: 'paper',
    name: 'Paper',
    kind: 'light',
    description: 'Warm off-white with an orange accent; easy on the eyes in daylight.',
    fonts: { sans: FONT_STACKS.nunito, mono: FONT_STACKS.fira },
    zinc: light(['#1c1917', '#292524', '#44403c', '#57534e', '#6b6560', '#756f69', '#b5ada4', '#d9d2c7', '#ebe5da', '#fffdf8', '#fbf8f2']),
    accent: accentLight(ORANGE),
    tones: LIGHT_TONES,
    series: ['#eb6834', '#2a78d6', '#1baf7a', '#4a3aa7', '#e87ba4', '#eda100', '#008300', '#e34948'],
    status: STATUS_LIGHT,
    swatches: ['#fbf8f2', '#fffdf8', '#ebe5da', '#292524', '#ea580c'],
  },
];

export const DEFAULT_THEME_ID = 'midnight';
export const themeById = (id: string): Theme => THEMES.find((t) => t.id === id) ?? THEMES[0]!;
