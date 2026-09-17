import { Chart, BarElement, BarController, CategoryScale, LinearScale, LogarithmicScale, TimeScale, PointElement, LineElement, LineController, ScatterController, ArcElement, DoughnutController, Tooltip, Legend, Filler } from 'chart.js';

Chart.register(BarElement, BarController, CategoryScale, LinearScale, LogarithmicScale, TimeScale, PointElement, LineElement, LineController, ScatterController, ArcElement, DoughnutController, Tooltip, Legend, Filler);

Chart.defaults.color = '#a1a1aa';
Chart.defaults.borderColor = '#27272a';
Chart.defaults.font.family = 'Inter, ui-sans-serif, system-ui, sans-serif';
Chart.defaults.font.size = 11;
Chart.defaults.plugins.tooltip.backgroundColor = '#18181b';
Chart.defaults.plugins.tooltip.borderColor = '#3f3f46';
Chart.defaults.plugins.tooltip.borderWidth = 1;
Chart.defaults.plugins.tooltip.titleColor = '#e4e4e7';
Chart.defaults.plugins.tooltip.bodyColor = '#d4d4d8';
Chart.defaults.plugins.tooltip.padding = 8;
Chart.defaults.plugins.legend.labels.boxWidth = 10;
Chart.defaults.plugins.legend.labels.boxHeight = 10;
Chart.defaults.animation = false;

/** Validated categorical palette (violet-first, fixed order, never cycled — >8 series fold into "Other"). */
export const SERIES = ['#9085e9', '#d95926', '#199e70', '#c98500', '#d55181', '#3987e5', '#008300', '#e66767'];
export const MAX_SERIES = SERIES.length;
export const ACCENT = '#9085e9';
export const GRID = '#27272a';

export function withAlpha(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

export const compactNumber = (n: number) => new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n);
