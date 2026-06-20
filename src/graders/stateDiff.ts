import type { Grader, Grade, GradingInput } from './grader.js';

/**
 * State-diff grader: compares expected vs actual state changes.
 *
 * Uses the context to receive before/after state snapshots and
 * reports which changes were allowed, required, prohibited, or unexpected.
 */

export type StateDiffConfig = {
  allowed?: string[];
  required?: string[];
  prohibited?: string[];
  statePaths?: string[];
};

export type StateSnapshot = {
  [path: string]: unknown;
};

export type StateDiffEntry = {
  path: string;
  before: unknown;
  after: unknown;
  classification: 'allowed' | 'required' | 'prohibited' | 'unexpected' | 'unchanged';
};

export class StateDiffGrader implements Grader {
  id = 'state-diff';
  version = '1.0.0';

  private config: StateDiffConfig;

  constructor(config?: StateDiffConfig) {
    this.config = config ?? {};
  }

  async grade(input: GradingInput): Promise<Grade> {
    const beforeState = (input.context?.beforeState ?? {}) as StateSnapshot;
    const afterState = (input.context?.afterState ?? {}) as StateSnapshot;
    const allPaths = [...new Set([...Object.keys(beforeState), ...Object.keys(afterState)])];

    const diffs: StateDiffEntry[] = [];
    let allPassed = true;
    const violations: string[] = [];
    const allowed = new Set(this.config.allowed ?? []);
    const required = new Set(this.config.required ?? []);
    const prohibited = new Set(this.config.prohibited ?? []);

    for (const path of allPaths) {
      const before = beforeState[path];
      const after = afterState[path];
      const changed = JSON.stringify(before) !== JSON.stringify(after);

      if (!changed) {
        diffs.push({ path, before, after, classification: 'unchanged' });
        continue;
      }

      // Determine classification
      let classification: StateDiffEntry['classification'];
      if (prohibited.has(path)) {
        classification = 'prohibited';
        allPassed = false;
        violations.push(`Prohibited state change: ${path} (${JSON.stringify(before)} → ${JSON.stringify(after)})`);
      } else if (required.has(path)) {
        classification = 'required';
        // Required change must actually happen
      } else if (allowed.has(path) || this.config.statePaths?.includes(path)) {
        classification = 'allowed';
      } else {
        classification = 'unexpected';
        allPassed = false;
        violations.push(`Unexpected state change: ${path} (${JSON.stringify(before)} → ${JSON.stringify(after)})`);
      }

      diffs.push({ path, before, after, classification });
    }

    // Check required changes were actually made
    for (const reqPath of required) {
      const diff = diffs.find((d) => d.path === reqPath);
      if (!diff || diff.classification === 'unchanged') {
        allPassed = false;
        violations.push(`Required change not made: ${reqPath}`);
      }
    }

    return {
      graderId: this.id,
      graderVersion: this.version,
      status: allPassed ? 'passed' : 'failed',
      score: allPassed ? 1 : 0,
      explanation: allPassed
        ? 'All state changes conform to policy'
        : violations.join('; '),
      evidence: diffs
        .filter((d) => d.classification !== 'unchanged')
        .map((d) => ({
          description: `[${d.classification}] ${d.path}: ${JSON.stringify(d.before)} → ${JSON.stringify(d.after)}`,
        })),
    };
  }
}
