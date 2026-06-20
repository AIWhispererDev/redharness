import type { Grader, Grade, GradingInput } from './grader.js';
import type { TextRule } from '../types.js';
import { scanText } from '../scanner.js';

/**
 * Rule-set grader: uses existing pack text rules to grade AI responses.
 * Avoids duplication by reusing the existing scanText function.
 */
export class RulesGrader implements Grader {
  id = 'rule-set';
  version = '1.0.0';

  private rules: TextRule[];

  constructor(rules: TextRule[]) {
    this.rules = rules;
  }

  async grade(input: GradingInput): Promise<Grade> {
    const findings = scanText(
      { rules: this.rules } as any,
      input.target,
      input.response,
    );

    if (findings.length === 0) {
      return {
        graderId: this.id,
        graderVersion: this.version,
        status: 'passed',
        score: 1,
        explanation: 'No rule violations found',
        evidence: [],
      };
    }

    const blockers = findings.filter((f) => f.severity === 'Blocker' || f.severity === 'Major');
    const status = blockers.length > 0 ? 'failed' : 'passed';

    return {
      graderId: this.id,
      graderVersion: this.version,
      status,
      score: Math.max(0, 1 - findings.length * 0.1),
      explanation: `${findings.length} rule violation(s): ${blockers.map((f) => f.ruleId).join(', ')}`,
      evidence: findings.slice(0, 10).map((f) => ({
        description: `[${f.severity}] ${f.ruleId}: ${f.match.slice(0, 80)}`,
      })),
    };
  }
}
