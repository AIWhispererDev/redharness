import type { Grader, Grade, GradingInput } from './grader.js';
import type { TrajectoryConstraint } from '../scenarios/schema.js';

/**
 * Trajectory grader: checks expected/forbidden tools, ordering constraints,
 * and tool call counts against the actual trace spans.
 *
 * Uses the trace span list to match tool names from the trajectory constraint.
 */
export class TrajectoryGrader implements Grader {
  id = 'trajectory';
  version = '1.0.0';

  private constraint: TrajectoryConstraint;

  constructor(constraint: TrajectoryConstraint) {
    this.constraint = constraint;
  }

  async grade(input: GradingInput): Promise<Grade> {
    const evidence: Array<{ description: string }> = [];
    let allPassed = true;

    // Parse tool names from the context (provided by the runner)
    const toolCalls: string[] = (input.context?.toolCalls as string[]) ?? [];
    const toolSet = new Set(toolCalls);

    // Check required tools
    for (const req of this.constraint.required ?? []) {
      const found = toolSet.has(req.tool);
      evidence.push({
        description: `Required tool "${req.tool}": ${found ? 'found' : 'MISSING'}`,
      });
      if (!found) allPassed = false;
    }

    // Check forbidden tools
    for (const forbid of this.constraint.forbidden ?? []) {
      const used = toolSet.has(forbid.tool);
      evidence.push({
        description: `Forbidden tool "${forbid.tool}": ${used ? 'USED (violation)' : 'not used'}`,
      });
      if (used) allPassed = false;
    }

    // Check ordering constraints
    for (const ord of this.constraint.ordering ?? []) {
      const beforeIdx = toolCalls.indexOf(ord.before);
      const afterIdx = toolCalls.indexOf(ord.after);
      const ok = beforeIdx >= 0 && afterIdx >= 0 && beforeIdx < afterIdx;
      evidence.push({
        description: `Order "${ord.before}" before "${ord.after}": ${ok ? 'ok' : 'violated'}`,
      });
      if (!ok) allPassed = false;
    }

    // Check max tool calls
    if (this.constraint.maxToolCalls !== undefined) {
      const within = toolCalls.length <= this.constraint.maxToolCalls;
      evidence.push({
        description: `Max ${this.constraint.maxToolCalls} tool calls: ${toolCalls.length} used (${within ? 'ok' : 'exceeded'})`,
      });
      if (!within) allPassed = false;
    }

    return {
      graderId: this.id,
      graderVersion: this.version,
      status: allPassed ? 'passed' : 'failed',
      score: allPassed ? 1 : 0,
      explanation: allPassed ? 'Trajectory constraints satisfied' : 'Trajectory constraints violated',
      evidence,
    };
  }
}
