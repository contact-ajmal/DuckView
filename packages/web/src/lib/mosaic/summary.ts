/** Dependency-free helpers over stored Mosaic specs (used by lists and cards without loading the Mosaic stack). */
export type Spec = Record<string, unknown>;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** A short, human summary of what a spec contains (for cards and lists). */
export function describeSpec(spec: Spec | null | undefined): { title: string | null; datasets: number; plots: number; inputs: number } {
  let plots = 0;
  let inputs = 0;
  const walk = (n: unknown) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (!isObject(n)) return;
    if ('plot' in n) plots++;
    if ('input' in n) inputs++;
    for (const v of Object.values(n)) walk(v);
  };
  if (spec) {
    const { data, meta, ...rest } = spec;
    walk(rest);
    return { title: isObject(meta) && typeof meta.title === 'string' ? meta.title : null, datasets: isObject(data) ? Object.keys(data).length : 0, plots, inputs };
  }
  return { title: null, datasets: 0, plots: 0, inputs: 0 };
}
