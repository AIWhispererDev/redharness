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

// Rules grader — supports 'rule-set' type for text-rule grading
import { RulesGrader } from './rules.js';
graderRegistry.register('rule-set', (config) => {
  const rules = (config?.rules as any[]) ?? [];
  return new RulesGrader(rules);
});

// Re-export for explicit dynamic registration (e.g. CLI loading from pack)
export function registerRulesGrader(rules: any[]): void {
  graderRegistry.register('rule-set', () => new RulesGrader(rules));
}

// Rubric grader — model-assisted scoring against declarative rubrics
import { RubricGrader } from './rubric.js';
import type { ModelAdapter } from '../model/adapter.js';
graderRegistry.register('rubric', (config) => {
  const judge = (config?.judge as ModelAdapter) ?? undefined;
  const grader = new RubricGrader(judge);
  return grader;
});

// Pairwise grader — candidate versus baseline comparison
import { PairwiseGrader } from './pairwise.js';
graderRegistry.register('pairwise', (config) => {
  const baselineResponse = (config?.baselineResponse as string) ?? '';
  const judge = (config?.judge as ModelAdapter) ?? undefined;
  return new PairwiseGrader({ baselineResponse, ...(config as any) }, judge);
});

// Human review grader — serialises to review queue (no auto-grade)
import { HumanGrader } from './human.js';
graderRegistry.register('human', () => new HumanGrader());

// Calibration is not a grader — it is a suite runner. Import only for tooling.
import { calibrateGrader, formatCalibrationReport } from './calibration.js';
export { calibrateGrader, formatCalibrationReport };
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

// Agent-tool-sequence grader — checks tool call sequence from agent trials
import { AgentToolGrader } from './agentTool.js';
graderRegistry.register('agent-tool', (config) => new AgentToolGrader(config as any));

// Agent-state grader — checks agent trial after-state against assertions
import { AgentStateGrader } from './agentState.js';
graderRegistry.register('agent-state', (config) => new AgentStateGrader(config as any));
