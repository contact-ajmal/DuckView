/**
 * ToolRegistry — the one place every surface reads tools from: the MCP server, the REST façade, the OpenAPI document,
 * the agent runtime, the Decision Engine and the UI (GET /api/agent/tools). It wraps the definitions of tools.ts
 * with their semantics (semantics.ts) and a JSON schema, and says which tools a principal may be offered.
 */
import type { DuckViewConfig } from '../config/index.js';
import type { Principal } from '../services/principal.js';
import { canWrite } from '../services/principal.js';
import { buildTools, type ToolAnnotations, type ToolDef } from './tools.js';
import { semanticsOf, type ToolSemantics } from './semantics.js';
import { toolInputJsonSchema } from './openapi.js';

export interface ToolDescriptor {
  name: string;
  title: string;
  /** The first sentence of the description: what a model or a person needs to pick the tool. */
  summary: string;
  description: string;
  annotations: ToolAnnotations;
  semantics: ToolSemantics;
  inputSchema: Record<string, unknown>;
}

function firstSentence(text: string): string {
  const line = text.split('\n')[0]!.trim();
  const m = /^(.{20,}?[.!?])(\s|$)/.exec(line);
  return (m ? m[1]! : line).slice(0, 300);
}

export class ToolRegistry {
  private readonly defs: ToolDef[];
  private readonly byName: Map<string, ToolDef>;
  private readonly descriptorCache = new Map<string, ToolDescriptor>();

  constructor(cfg: DuckViewConfig) {
    this.defs = buildTools(cfg);
    this.byName = new Map(this.defs.map((t) => [t.name, t]));
  }

  all(): ToolDef[] {
    return this.defs;
  }

  get(name: string): ToolDef | undefined {
    return this.byName.get(name);
  }

  names(): string[] {
    return this.defs.map((t) => t.name);
  }

  semantics(name: string): ToolSemantics | undefined {
    const t = this.byName.get(name);
    return t ? semanticsOf(t) : undefined;
  }

  descriptor(name: string): ToolDescriptor | undefined {
    const cached = this.descriptorCache.get(name);
    if (cached) return cached;
    const t = this.byName.get(name);
    if (!t) return undefined;
    const d: ToolDescriptor = { name: t.name, title: t.title, summary: firstSentence(t.description), description: t.description, annotations: t.annotations, semantics: semanticsOf(t), inputSchema: toolInputJsonSchema(t) };
    this.descriptorCache.set(name, d);
    return d;
  }

  descriptors(): ToolDescriptor[] {
    return this.defs.map((t) => this.descriptor(t.name)!);
  }

  /**
   * The tools a principal may be offered. Someone who cannot write (read-only role, or a token without the write
   * scope) is offered reading tools only — SQL stays, as it runs read-only for them. Offering is not authorising:
   * the services still check every call.
   */
  availableTo(p: Principal): ToolDef[] {
    if (canWrite(p)) return this.defs;
    return this.defs.filter((t) => {
      const s = semanticsOf(t);
      return s.action === 'READ' || s.mutation === 'conditional';
    });
  }
}

const registries = new WeakMap<DuckViewConfig, ToolRegistry>();

/** The registry for a configuration (built once). */
export function toolRegistry(cfg: DuckViewConfig): ToolRegistry {
  let r = registries.get(cfg);
  if (!r) {
    r = new ToolRegistry(cfg);
    registries.set(cfg, r);
  }
  return r;
}
