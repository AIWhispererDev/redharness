/**
 * PRD 04: Policy engine — orchestrates tool call evaluation through
 * the full pipeline: schema validation, capability/risk lookup, intent
 * validation, budget check, approval policy, execution, and tracing.
 */

import type {
  AgentPolicy,
  AgentDefinition,
  IntentCapsule,
  AgentBudgets,
  ToolDefinition,
  ToolExecutionContext,
  ToolResult,
  BudgetConsumption,
} from './agentTypes.js';
import type { ToolRegistry } from './toolRegistry.js';
import { ApprovalEngine, type ApprovalDecision } from './approval.js';
import { BudgetTracker } from './budgets.js';
import { validateActionAgainstIntent } from './intent.js';

export type PolicyPipelineResult = {
  allowed: boolean;
  approvalDecision?: ApprovalDecision;
  toolResult?: ToolResult;
  error?: string;
  budgetCheck?: ReturnType<BudgetTracker['check']>;
};

/**
 * Policy engine — wraps the approval engine, budget tracker, and tool
 * registry into a single pipeline for tool call evaluation.
 */
export class PolicyEngine {
  private registry: ToolRegistry;
  private approval: ApprovalEngine;
  private budgets: BudgetTracker;
  private policy: AgentPolicy;
  private intent: IntentCapsule;
  private isCi: boolean;

  constructor(params: {
    registry: ToolRegistry;
    approval: ApprovalEngine;
    budgets: BudgetTracker;
    policy: AgentPolicy;
    intent: IntentCapsule;
    /** Whether execution is in a CI environment (fail-closed for human-required tools). */
    isCiEnvironment?: boolean;
  }) {
    this.registry = params.registry;
    this.approval = params.approval;
    this.budgets = params.budgets;
    this.policy = params.policy;
    this.intent = params.intent;
    this.isCi = params.isCiEnvironment ?? false;
  }

  /**
   * Run the full policy pipeline for a proposed tool call.
   * This is a non-execution evaluation — use executeWithPolicy for execution.
   */
  evaluate(toolName: string, args: Record<string, unknown>): PolicyPipelineResult {
    // 1. Budget check
    const budgetCheck = this.budgets.check();
    if (budgetCheck.exceeded) {
      return {
        allowed: false,
        error: `Budget exceeded: ${budgetCheck.reason}`,
        budgetCheck,
      };
    }

    // 2. Schema validation (through registry)
    const validationError = this.registry.validateArgs(toolName, args);
    if (validationError) {
      return {
        allowed: false,
        error: validationError,
        budgetCheck,
      };
    }

    // 3. Approval policy check — forward CI context so human-required tools
    //    fail closed in CI instead of producing interactive approval requests
    const approvalDecision = this.approval.evaluate(toolName, args, this.intent, this.isCi);
    if (!approvalDecision.allowed) {
      return {
        allowed: false,
        approvalDecision,
        budgetCheck,
      };
    }

    return {
      allowed: true,
      approvalDecision,
      budgetCheck,
    };
  }

  /**
   * Execute a tool call through the full pipeline.
   * Validates, checks policy, executes, and records budgets.
   */
  async executeWithPolicy(
    toolName: string,
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<PolicyPipelineResult & { toolResult?: ToolResult }> {
    // Evaluate policy first
    const evaluation = this.evaluate(toolName, args);
    if (!evaluation.allowed) {
      return evaluation;
    }

    // Execute
    const toolResult = await this.registry.execute(toolName, args, context);

    // Record budget consumption
    this.budgets.recordToolCall(toolName);
    if (
      this.registry.hasCapability(toolName, 'http') ||
      this.registry.hasCapability(toolName, 'network')
    ) {
      this.budgets.recordNetworkRequest();
    }

    return {
      allowed: toolResult.success,
      toolResult,
    };
  }

  /** Get the budget tracker for status checks. */
  getBudgetTracker(): BudgetTracker {
    return this.budgets;
  }

  /** Get the approval engine. */
  getApprovalEngine(): ApprovalEngine {
    return this.approval;
  }
}
