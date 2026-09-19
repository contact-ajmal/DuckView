/**
 * Mosaic (uwdata/mosaic) bound to a DuckView workspace.
 *
 * `createMosaic` loads vgplot lazily (it is a sizeable chunk — Observable Plot and d3 come with it), creates a
 * Coordinator whose connector is the workspace engine, and returns an API context whose functions (`plot`, `from`,
 * `table`, `Selection`, …) are bound to that coordinator. One coordinator per view keeps caches and pre-aggregation
 * bookkeeping isolated, so disposing a view never disturbs another.
 */
import { api } from '../../api/client';
import { duckviewConnector } from './connector';

export interface MosaicInfo {
  enabled: boolean;
  schema: string;
  max_rows: number;
}

let infoPromise: Promise<MosaicInfo> | null = null;
export function mosaicInfo(): Promise<MosaicInfo> {
  if (!infoPromise) infoPromise = api.get<MosaicInfo>('/api/mosaic/info').catch((e) => {
    infoPromise = null;
    throw e;
  });
  return infoPromise;
}

export type VgPlot = typeof import('@uwdata/vgplot');

export interface MosaicHandle {
  /** The vgplot module (for types/utilities such as Selection, count, sql). */
  vg: VgPlot;
  /** API context bound to this view's coordinator: api.plot(), api.from(), api.table(), api.Selection … */
  api: VgPlot;
  coordinator: InstanceType<VgPlot['Coordinator']>;
  info: MosaicInfo;
  /** Disconnects every client and drops the caches. */
  dispose(): void;
}

/** FNV-1a over a string → lowercase hex; used for source-view names so they are stable across reloads. */
export function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export async function createMosaic(workspaceId: string): Promise<MosaicHandle> {
  const [vg, info] = await Promise.all([import('@uwdata/vgplot'), mosaicInfo()]);
  if (!info.enabled) throw new Error('Mosaic is disabled on this server (mosaic.enabled)');
  const coordinator = new vg.Coordinator(duckviewConnector(workspaceId) as never, { preagg: { schema: info.schema }, logger: null });
  const ctx = vg.createAPIContext({ coordinator }) as VgPlot;
  return {
    vg,
    api: ctx,
    coordinator,
    info,
    dispose() {
      coordinator.clear({ clients: true, cache: true });
    },
  };
}

/** SQL-quotes an identifier the way Mosaic does. */
export const quoteIdent = (id: string) => `"${id.replace(/"/g, '""')}"`;
