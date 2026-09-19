import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { createMosaic, type MosaicHandle } from '../../lib/mosaic';
import { prepareSpec, type Spec } from '../../lib/mosaic/spec';
import { useWorkspace } from '../../store/workspace';
import { cn } from '../../components/ui';

export interface SpecRenderStatus {
  state: 'idle' | 'loading' | 'ready' | 'error';
  error: string | null;
  /** Source views created for the spec's `data` block. */
  sources: number;
}

/**
 * Renders a Mosaic declarative spec against a workspace: dataset definitions become hidden source views, the spec
 * is parsed by @uwdata/mosaic-spec and instantiated with an API context bound to a coordinator that speaks to the
 * workspace engine. Re-renders when the spec changes or the workspace data epoch moves (which drops the
 * pre-aggregates and source views server-side).
 */
export function MosaicSpecView({ workspaceId, spec, onStatus, className, nonce = 0 }: { workspaceId: string; spec: Spec | null; onStatus?: (s: SpecRenderStatus) => void; className?: string; nonce?: number }) {
  const host = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<SpecRenderStatus['state']>('idle');
  const [error, setError] = useState<string | null>(null);
  const dataVersion = useWorkspace((s) => s.workspaces.find((w) => w.id === workspaceId)?.data_version);
  const specKey = spec ? JSON.stringify(spec) : '';
  const status = useRef(onStatus);
  status.current = onStatus;

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    el.replaceChildren();
    if (!spec || Object.keys(spec).length === 0) {
      setState('idle');
      status.current?.({ state: 'idle', error: null, sources: 0 });
      return;
    }
    let handle: MosaicHandle | null = null;
    let cancelled = false;
    setState('loading');
    setError(null);
    status.current?.({ state: 'loading', error: null, sources: 0 });
    let sources = 0;
    (async () => {
      handle = await createMosaic(workspaceId);
      if (cancelled) return;
      const prepared = prepareSpec(spec, `${handle.info.schema}_src_`);
      sources = prepared.sources.length;
      if (prepared.statements.length) await handle.coordinator.exec(prepared.statements);
      if (cancelled) return;
      const { parseSpec, astToDOM } = await import('@uwdata/mosaic-spec');
      const ast = parseSpec(prepared.spec as never);
      const { element } = await astToDOM(ast, { api: handle.api as never });
      if (cancelled) return;
      el.replaceChildren(element);
      setState('ready');
      status.current?.({ state: 'ready', error: null, sources });
    })().catch((e) => {
      if (cancelled) return;
      const message = (e as Error).message ?? String(e);
      setError(message);
      setState('error');
      status.current?.({ state: 'error', error: message, sources });
    });
    return () => {
      cancelled = true;
      handle?.dispose();
      el.replaceChildren();
    };
  }, [workspaceId, specKey, dataVersion, nonce]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className={cn('mosaic-dashboard relative min-h-0', className)}>
      {state === 'loading' && <div className="absolute right-3 top-3 z-10 flex items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-900/90 px-2 py-1 text-[11px] text-zinc-400"><Loader2 className="h-3.5 w-3.5 animate-spin text-accent-300" /> Rendering…</div>}
      {state === 'error' && <div className="m-3 whitespace-pre-wrap rounded-md border border-red-900 bg-red-950/50 px-3 py-2 font-mono text-xs text-red-200">{error}</div>}
      <div ref={host} className="mosaic-explore p-3" />
    </div>
  );
}
