/**
 * Agent tool sequence grader — evaluates the tool call trajectory
 * from an agent trial against required/forbidden tool constraints.
 */

import type { Grader, Grade, GradingInput } from './grader.js';
import type { ExecutionStatus } from '../core/status.js';

export type AgentToolGraderConfig = {
  requiredTools?: string[];
  forbiddenTools?: string[];
  maxCalls?: number;
};

export class AgentToolGrader implements Grader {
  id = 'agent-tool';
  version = '1.0.0';
  private config: AgentToolGraderConfig;

  constructor(config?: Record<string, unknown>) {
    this.config = {
      requiredTools: (config?.requiredTools as string[]) ?? [],
      forbiddenTools: (config?.forbiddenTools as string[]) ?? [],
      maxCalls: (config?.maxCalls as number) ?? undefined,
    };
  }

  async grade(input: GradingInput): Promise<Grade> {
    const toolSequence = (input.context?.agentToolSequence ?? []) as
      Array<{ turn: number; tool: string; success: boolean; durationMs: number }>;

    const toolNames = toolSequence.map((t) => t.tool);
    const evidence: Grade['evidence'] = [];
    let status: ExecutionStatus = 'passed';
    const details: string[] = [];

    // Check required tools
    for (const required of this.config.requiredTools ?? []) {
      if (!toolNames.includes(required)) {
        status = 'failed';
        details.push(`Required tool "${required}" was not used`);
        evidence.push({
          description: `Missing required tool in agent sequence: ${required}`,
        });
      } else {
        details.push(`Required tool "${required}" was used`);
      }
    }

    // Check forbidden tools
    for (const forbidden of this.config.forbiddenTools ?? []) {
      if (toolNames.includes(forbidden)) {
        status = 'failed';
        details.push(`Forbidden tool "${forbidden}" was used`);
        evidence.push({
          description: `Forbidden tool found in agent sequence: ${forbidden}`,
        });
      } else {
        details.push(`Forbidden tool "${forbidden}" was not used`);
      }
    }

    // Check max calls
    if (this.config.maxCalls !== undefined && toolNames.length > this.config.maxCalls) {
      status = 'failed';
      details.push(`Tool calls (${toolNames.length}) exceeded max (${this.config.maxCalls})`);
      evidence.push({
        description: `Agent made ${toolNames.length} tool calls, max allowed is ${this.config.maxCalls}`,
      });
    }

    return {
      graderId: this.id,
      graderVersion: this.version,
      status,
      score: status === 'passed' ? 1 : 0,
      label: 'agent-tool-sequence',
      explanation: details.join('; ') || 'All tool constraints satisfied',
      evidence,
    };
  }
}
