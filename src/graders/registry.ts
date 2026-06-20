import type { Grader, Grade, GradingInput } from './grader.js';
import { DeterministicGrader } from './deterministic.js';
import { TrajectoryGrader } from './trajectory.js';

/**
 * Grader registry: discoverable graders that can be instantiated from
 * scenario/pack configuration.
 */
class GraderRegistry {
  private graders = new Map<string, GraderFactory>();

  /** Register a grader factory. */
  register(id: string, factory: GraderFactory): void {
    this.graders.set(id, factory);
  }

  /** Create a grader instance by ID with optional config. */
  create(id: string, config?: Record<string, unknown>): Grader {
    const factory = this.graders.get(id);
    if (!factory) {
      throw new Error(`Unknown grader "${id}". Available: ${[...this.graders.keys()].join(', ')}`);
    }
    return factory(config);
  }

  /** Check if a grader is registered. */
  has(id: string): boolean {
    return this.graders.has(id);
  }

  /** List all registered grader IDs. */
  list(): string[] {
    return [...this.graders.keys()];
  }
}

export type GraderFactory = (config?: Record<string, unknown>) => Grader;

/** Singleton grader registry. */
export const graderRegistry = new GraderRegistry();

// Register built-in graders
graderRegistry.register('deterministic', () => new DeterministicGrader());
graderRegistry.register('trajectory', (config) => {
  // Accept trajectory constraint from config
  return new TrajectoryGrader((config?.constraint ?? {}) as any);
});

// Rules grader is registered dynamically once rules are loaded
export function registerRulesGrader(rules: any[]): void {
  graderRegistry.register('rule-set', () => {
    const { RulesGrader } = require('./rules.js');
    return new RulesGrader(rules);
  });
}

// State-diff grader is registered lazily
import { StateDiffGrader } from './stateDiff.js';
graderRegistry.register('state-diff', (config) => new StateDiffGrader(config as any));

// Composite grader
import { CompositeGrader } from './composite.js';
graderRegistry.register('composite', (config) => {
  const subGraders: Grader[] = [];
  if (config?.graders && Array.isArray(config.graders)) {
    for (const g of config.graders as any[]) {
      subGraders.push(graderRegistry.create(g.id, g.config));
    }
  }
  return new CompositeGrader(subGraders);
});
