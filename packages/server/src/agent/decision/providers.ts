/**
 * Decision Engine providers, chosen by `agent.decision.provider`. The built-in "default" is always there; an adapter
 * for another engine registers a factory under its name — nothing else in DuckView changes.
 *
 *   registerDecisionProvider('acme', (cfg) => new AcmeDecisionEngine(cfg));
 */
import type { DuckViewConfig } from '../../config/index.js';
import { logger } from '../../observability/logger.js';
import { DefaultDecisionEngine } from './default.js';
import type { DecisionEngineProvider } from './types.js';

export type DecisionProviderFactory = (cfg: DuckViewConfig) => DecisionEngineProvider;

const factories = new Map<string, DecisionProviderFactory>([['default', () => new DefaultDecisionEngine()]]);

export function registerDecisionProvider(name: string, factory: DecisionProviderFactory): void {
  factories.set(name, factory);
}

export function decisionProviders(): string[] {
  return [...factories.keys()];
}

/** The configured engine; an unknown name falls back to the default, with a warning. */
export function createDecisionEngine(cfg: DuckViewConfig): DecisionEngineProvider {
  const name = cfg.agent.decision.provider;
  const factory = factories.get(name);
  if (!factory) {
    logger().warn({ provider: name, available: decisionProviders() }, 'Unknown agent.decision.provider; using the default Decision Engine');
    return new DefaultDecisionEngine();
  }
  return factory(cfg);
}
