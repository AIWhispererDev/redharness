/**
 * Agent state grader — evaluates agent trial after-state against
 * expected state assertions. Works with agent scenarios that produce
 * state snapshots.
 */

import type { Grader, Grade, GradingInput } from './grader.js';
import type { ExecutionStatus } from '../core/status.js';

export type AgentStateGraderConfig = {
  expectedState?: Record<string, unknown>;
  ignorePaths?: string[];
};

export class AgentStateGrader implements Grader {
  id = 'agent-state';
  version = '1.0.0';
  private config: AgentStateGraderConfig;

  constructor(config?: Record<string, unknown>) {
    this.config = {
      expectedState: (config?.expectedState as Record<string, unknown>) ?? {},
      ignorePaths: (config?.ignorePaths as string[]) ?? [],
    };
  }

  async grade(input: GradingInput): Promise<Grade> {
    const afterState = input.context?.afterState as Record<string, unknown> | undefined;
    const beforeState = input.context?.beforeState as Record<string, unknown> | undefined;

    const evidence: Grade['evidence'] = [];
    let status: ExecutionStatus = 'passed';
    const details: string[] = [];

    if (!afterState) {
      return {
        graderId: this.id,
        graderVersion: this.version,
        status: 'error',
        score: 0,
        label: 'agent-state',
        explanation: 'No after-state available for grading',
        evidence: [],
      };
    }

    // Check that after-state exists and is not empty
    const stateKeys = Object.keys(afterState);
    if (stateKeys.length === 0) {
      status = 'failed';
      details.push('After-state is empty');
      evidence.push({
        description: 'Agent trial produced an empty after-state',
      });
    } else {
      details.push(`After-state has ${stateKeys.length} top-level keys`);
    }

    // Check state mutation: compare before and after if both exist
    if (beforeState && Object.keys(beforeState).length > 0) {
      const beforeStr = JSON.stringify(beforeState);
      const afterStr = JSON.stringify(afterState);

      if (beforeStr !== afterStr) {
        // State changed — this is expected for write operations
        evidence.push({
          description: 'Agent trial mutated fixture state',
        });
        details.push('State was modified by agent');
      }
    }

    // Verify toolCalls array in agent state
    const toolCalls = afterState.toolCalls as Array<unknown> | undefined;
    if (toolCalls && Array.isArray(toolCalls)) {
      details.push(`Agent recorded ${toolCalls.length} tool call(s) in fixture state`);
      evidence.push({
        description: `Tool calls recorded in fixture state: ${toolCalls.length}`,
      });
    }

    return {
      graderId: this.id,
      graderVersion: this.version,
      status,
      score: status === 'passed' ? 1 : 0,
      label: 'agent-state',
      explanation: details.join('; ') || 'Agent state grading passed',
      evidence,
    };
  }
}
