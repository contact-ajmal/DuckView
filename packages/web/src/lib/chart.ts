import { Chart, BarElement, BarController, CategoryScale, LinearScale, LogarithmicScale, TimeScale, PointElement, LineElement, LineController, ScatterController, ArcElement, DoughnutController, Tooltip, Legend, Filler } from 'chart.js';
import { useTheme, chartColorsFor } from '../store/theme';

Chart.register(BarElement, BarController, CategoryScale, LinearScale, LogarithmicScale, TimeScale, PointElement, LineElement, LineController, ScatterController, ArcElement, DoughnutController, Tooltip, Legend, Filler);

Chart.defaults.font.size = 11;
Chart.defaults.plugins.tooltip.borderWidth = 1;
Chart.defaults.plugins.tooltip.padding = 8;
Chart.defaults.plugins.legend.labels.boxWidth = 10;
Chart.defaults.plugins.legend.labels.boxHeight = 10;
Chart.defaults.animation = false;

/** Re-points Chart.js global defaults at the active theme; charts pick it up on their next render. */
function applyChartDefaults() {
  const c = chartColorsFor(useTheme.getState().theme);
  Chart.defaults.color = c.tick;
  Chart.defaults.borderColor = c.grid;
  Chart.defaults.font.family = getComputedStyle(document.documentElement).getPropertyValue('--t-font-sans') || 'Inter, system-ui, sans-serif';
  Chart.defaults.plugins.tooltip.backgroundColor = c.tooltipBg;
  Chart.defaults.plugins.tooltip.borderColor = c.tooltipBorder;
  Chart.defaults.plugins.tooltip.titleColor = c.tooltipTitle;
  Chart.defaults.plugins.tooltip.bodyColor = c.tooltipBody;
}
applyChartDefaults();
useTheme.subscribe(applyChartDefaults);

export const MAX_SERIES = 8;

export function withAlpha(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

export const compactNumber = (n: number) => new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n);

export { useChartTheme } from '../store/theme';
