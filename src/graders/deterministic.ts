import type { Grader, Grade, GradingInput } from './grader.js';

/**
 * Deterministic grader: exact state, status, visible control,
 * schema, or latency threshold checks.
 */
export class DeterministicGrader implements Grader {
  id = 'deterministic';
  version = '1.0.0';

  async grade(input: GradingInput): Promise<Grade> {
    if (!input.expected) {
      return {
        graderId: this.id,
        graderVersion: this.version,
        status: 'error',
        explanation: 'Deterministic grader requires expected output',
        evidence: [],
      };
    }

    const passed = input.response.trim() === input.expected.trim();

    return {
      graderId: this.id,
      graderVersion: this.version,
      status: passed ? 'passed' : 'failed',
      score: passed ? 1 : 0,
      explanation: passed
        ? 'Exact match'
        : `Expected "${input.expected.slice(0, 100)}", got "${input.response.slice(0, 100)}"`,
      evidence: [{ description: `response=${input.response.length}chars, expected=${input.expected.length}chars` }],
    };
  }
}
