/**
 * A map on a bundled world outline (no tiles, nothing fetched from a map service): points from latitude and
 * longitude columns, sized by a value, or countries coloured by a value (ISO alpha-2, alpha-3, numeric codes or
 * English names). The map fits the points, or the whole world for countries.
 */
import { useMemo, useRef, useState, useEffect } from 'react';
import { geoNaturalEarth1, geoPath, type GeoPermissibleObjects } from 'd3-geo';
import { feature } from 'topojson-client';
import type { Topology, GeometryCollection } from 'topojson-specification';
import type { FeatureCollection, Geometry } from 'geojson';
import world from 'world-atlas/countries-110m.json';
import countries from 'i18n-iso-countries';
import en from 'i18n-iso-countries/langs/en.json';
import type { ColumnSchema, WidgetChartConfig } from '../../api/client';
import { compactNumber } from '../../lib/chart';

countries.registerLocale(en);

export interface MapConfig { lat?: string; lon?: string; region?: string; value?: string; label?: string }
interface Props { columns: ColumnSchema[]; rows: unknown[][]; config: WidgetChartConfig & MapConfig }

const land = feature(world as unknown as Topology, (world as unknown as Topology).objects.countries as GeometryCollection) as unknown as FeatureCollection<Geometry, { name?: string }>;
const find = (cols: ColumnSchema[], re: RegExp) => cols.find((c) => re.test(c.name))?.name;
/** The numeric ISO code (the outline's id) for a code or an English name. */
function isoNumeric(v: unknown): string | null {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (/^\d{1,3}$/.test(s)) return s.padStart(3, '0');
  const n = s.length === 2 ? countries.alpha2ToNumeric(s.toUpperCase()) : s.length === 3 ? countries.alpha3ToNumeric(s.toUpperCase()) : countries.alpha2ToNumeric(countries.getAlpha2Code(s, 'en') ?? '');
  return n ? String(n).padStart(3, '0') : null;
}

/** Which columns to use: the configured ones, else guessed from the names. */
export function mapColumns(cols: ColumnSchema[], cfg: MapConfig) {
  const lat = cfg.lat ?? find(cols, /^(lat|latitude|y)$/i);
  const lon = cfg.lon ?? find(cols, /^(lon|lng|long|longitude|x)$/i);
  const region = cfg.region ?? find(cols, /^(country|country_code|iso|iso2|iso3|iso_code|nation)$/i);
  const value = cfg.value ?? cols.find((c) => c.kind === 'number' && c.name !== lat && c.name !== lon)?.name;
  const label = cfg.label ?? cols.find((c) => c.kind !== 'number' && c.name !== region)?.name;
  return { mode: lat && lon ? ('points' as const) : region ? ('regions' as const) : null, lat, lon, region, value, label };
}

export function MapWidget({ columns, rows, config }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 600, h: 320 });
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => e && setSize({ w: Math.max(200, e.contentRect.width), h: Math.max(160, e.contentRect.height) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const m = mapColumns(columns, config);
  const idx = (name?: string) => (name ? columns.findIndex((c) => c.name === name) : -1);

  const drawn = useMemo(() => {
    const vIdx = idx(m.value);
    const lIdx = idx(m.label);
    if (m.mode === 'points') {
      const la = idx(m.lat);
      const lo = idx(m.lon);
      const pts = rows.map((r) => ({ lat: Number(r[la]), lon: Number(r[lo]), v: vIdx >= 0 ? Number(r[vIdx]) : 1, label: lIdx >= 0 ? String(r[lIdx] ?? '') : '' })).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180);
      const target: GeoPermissibleObjects = pts.length ? { type: 'MultiPoint', coordinates: pts.map((p) => [p.lon, p.lat]) } : { type: 'Sphere' };
      const pad = Math.max(28, Math.min(size.w, size.h) * 0.15);
      const proj = geoNaturalEarth1().fitExtent([[pad, pad], [size.w - pad, size.h - pad]], target);
      // A single point, or points close together, would zoom in too far: keep at least a region in view, centred.
      if (proj.scale() > 1200) {
        const [[x0, y0], [x1, y1]] = geoPath(proj).bounds(target);
        const [cx, cy] = proj.invert?.([(x0 + x1) / 2, (y0 + y1) / 2]) ?? [0, 0];
        proj.scale(1200);
        const [px, py] = proj([cx, cy]) ?? [size.w / 2, size.h / 2];
        const [tx, ty] = proj.translate();
        proj.translate([tx + size.w / 2 - px, ty + size.h / 2 - py]);
      }
      const maxV = Math.max(...pts.map((p) => Math.abs(p.v)), 1);
      return { proj, pts: pts.map((p) => ({ ...p, xy: proj([p.lon, p.lat]), r: 3 + 9 * Math.sqrt(Math.abs(p.v) / maxV) })), values: new Map<string, number>(), missing: rows.length - pts.length };
    }
    const rIdx = idx(m.region);
    const values = new Map<string, number>();
    let missing = 0;
    for (const r of rows) {
      const id = isoNumeric(r[rIdx]);
      if (!id) {
        missing++;
        continue;
      }
      values.set(id, (values.get(id) ?? 0) + (vIdx >= 0 ? Number(r[vIdx]) || 0 : 1));
    }
    const proj = geoNaturalEarth1().fitExtent([[8, 8], [size.w - 8, size.h - 8]], { type: 'Sphere' });
    return { proj, pts: [], values, missing };
  }, [rows, columns, config, size.w, size.h]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!m.mode) return <p className="p-3 text-xs text-zinc-500">A map needs latitude and longitude columns, or a column of country codes or names. Choose them in the widget's settings.</p>;
  const path = geoPath(drawn.proj);
  const vals = [...drawn.values.values()];
  const max = Math.max(...vals, 0);
  const min = Math.min(...vals, 0);
  const shade = (v: number) => 0.18 + 0.82 * (max === min ? 1 : (v - min) / (max - min));
  const fmt = (v: number) => compactNumber(v);
  return (
    <div ref={box} className="relative h-full min-h-40 w-full overflow-hidden" data-testid="map-widget" data-mode={m.mode}>
      <svg className="absolute inset-0" width={size.w} height={size.h} role="img" aria-label={m.mode === 'points' ? `Map of ${drawn.pts.length} points` : `Map of ${drawn.values.size} countries by ${m.value ?? 'count'}`}>
        <path d={path({ type: 'Sphere' }) ?? ''} className="fill-zinc-950" />
        {land.features.map((f) => {
          const v = drawn.values.get(String(f.id).padStart(3, '0'));
          return (
            <path key={String(f.id)} d={path(f) ?? ''} className={v == null ? 'fill-zinc-800 stroke-zinc-700' : 'stroke-zinc-700'} strokeWidth={0.5} style={v != null ? { fill: 'var(--series-1)', fillOpacity: shade(v) } : undefined} data-country={v != null ? String(f.id) : undefined}>
              <title>{`${f.properties?.name ?? ''}${v != null ? `: ${fmt(v)}` : ''}`}</title>
            </path>
          );
        })}
        {drawn.pts.map((p, i) => p.xy && (
          <circle key={i} cx={p.xy[0]} cy={p.xy[1]} r={p.r} style={{ fill: 'var(--series-1)', fillOpacity: 0.6, stroke: 'var(--series-1)' }} data-point>
            <title>{`${p.label ? `${p.label} · ` : ''}${m.value ? `${m.value} ${fmt(p.v)} · ` : ''}${p.lat.toFixed(3)}, ${p.lon.toFixed(3)}`}</title>
          </circle>
        ))}
      </svg>
      {m.mode === 'regions' && vals.length > 0 && (
        <div className="absolute bottom-2 left-2 flex items-center gap-1.5 rounded bg-zinc-950/80 px-2 py-1 text-2xs text-zinc-400">
          <span className="tabular-nums">{fmt(min)}</span>
          <span className="flex" aria-hidden>{[0.18, 0.38, 0.59, 0.8, 1].map((o) => <span key={o} className="h-2 w-3" style={{ background: 'var(--series-1)', opacity: o }} />)}</span>
          <span className="tabular-nums">{fmt(max)}</span>
        </div>
      )}
      {drawn.missing > 0 && <div className="absolute bottom-2 right-2 rounded bg-zinc-950/80 px-2 py-1 text-2xs text-zinc-500">{drawn.missing.toLocaleString()} row{drawn.missing === 1 ? '' : 's'} not placed</div>}
    </div>
  );
}
