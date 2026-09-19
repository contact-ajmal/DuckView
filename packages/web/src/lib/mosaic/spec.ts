/**
 * Mosaic declarative specs (https://idl.uw.edu/mosaic/spec/) in the browser: text ⇄ object. Preparation — turning
 * `data` definitions into the source views DuckView admits and rewriting `from:` references — and validation live
 * on the server (`POST /api/workspaces/:id/mosaic/prepare`), so the editor, agents and Copilot all get the same
 * answer. Both JSON and YAML are accepted as text; specs are stored as JSON objects.
 */
import YAML from 'yaml';
import { api } from '../../api/client';
import type { Spec } from './summary';

export type { Spec } from './summary';

export class SpecError extends Error {}

/** Parses spec text — JSON when it starts with `{`, YAML otherwise. */
export function parseSpecText(text: string): Spec {
  const t = text.trim();
  if (!t) throw new SpecError('The spec is empty');
  let value: unknown;
  if (t.startsWith('{')) {
    try {
      value = JSON.parse(t);
    } catch (e) {
      throw new SpecError(`Invalid JSON: ${(e as Error).message}`);
    }
  } else {
    try {
      value = YAML.parse(t, { prettyErrors: true });
    } catch (e) {
      throw new SpecError(`Invalid YAML: ${(e as Error).message}`);
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SpecError('A spec must be a mapping/object at the top level');
  return value as Spec;
}

export function specToText(spec: Spec, format: 'yaml' | 'json'): string {
  return format === 'json' ? JSON.stringify(spec, null, 2) : YAML.stringify(spec, { lineWidth: 0, aliasDuplicateObjects: false });
}

export interface PreparedSpec {
  ok: boolean;
  errors: string[];
  warnings: string[];
  /** The spec with `data` removed and every `from:` pointing at a source view. */
  spec: Spec;
  /** `CREATE OR REPLACE VIEW` statements to run through the coordinator before rendering. */
  statements: string[];
  sources: { name: string; view: string; kind: string }[];
  tables: string[];
}

/** Validates a spec against a workspace and returns the render-ready form (see the server's MosaicService.prepare). */
export function prepareSpec(workspaceId: string, spec: Spec, opts: { bind?: boolean } = {}): Promise<PreparedSpec> {
  return api.post<PreparedSpec>(`/api/workspaces/${workspaceId}/mosaic/prepare`, { spec, bind: opts.bind });
}
