/**
 * PRD 04: Bounded Agent Runtime — orchestrates model interaction, tool
 * execution, policy enforcement, budget tracking, checkpoints, and
 * stop conditions for a single agent run.
 *
 * This runtime is provider-neutral, bounded, cancellable, and resumable.
 */

import { randomUUID } from 'node:crypto';
import type {
  AgentDefinition,
  AgentState,
  AgentRunResult,
  AgentMessage,
  IntentCapsule,
  ToolExecutionContext,
  ToolResult,
} from './agentTypes.js';
import type { ModelAdapter, ModelRequest, ModelResponse } from './modelAdapter.js';
import { ToolRegistry, toolRegistry } from './toolRegistry.js';
import { ApprovalEngine } from './approval.js';
import { BudgetTracker } from './budgets.js';
import { PolicyEngine } from './policyEngine.js';
import { CheckpointManager } from './checkpoints.js';
import { RepeatedActionDetector, LoopDetector, StallDetector, type StopConditionCheck } from './stopConditions.js';
import type { ExecutionStatus } from '../core/status.js';
import type { BudgetConsumption } from './agentTypes.js';

export type RuntimeOptions = {
  agent: AgentDefinition;
  intent: IntentCapsule;
  modelAdapter: ModelAdapter;
  registry?: ToolRegistry;
  runId?: string;
  scenarioId?: string;
  trialId?: string;
  checkpointDir?: string;
  policyVersion?: string;
  isCiEnvironment?: boolean;
};

export type RunTurnResult = {
  messages: AgentMessage[];
  observations: ToolResult[];
  shouldStop: boolean;
  stopReason?: string;
};

/**
 * The main agent runtime — drives the turn loop with policy enforcement.
 */
export class AgentRuntime {
  private agent: AgentDefinition;
  private intent: IntentCapsule;
  private model: ModelAdapter;
  private registry: ToolRegistry;
  private policy: PolicyEngine;
  private budgets: BudgetTracker;
  private approval: ApprovalEngine;
  private checkpoints?: CheckpointManager;
  private state: AgentState;
  private repeatedActionDetector: RepeatedActionDetector;
  private loopDetector: LoopDetector;
  private stallDetector: StallDetector;
  private lastRepeatCheck: StopConditionCheck = { shouldStop: false };
  private lastLoopCheck: StopConditionCheck = { shouldStop: false };
  private abortController: AbortController;
  private isCi: boolean;
  private runId: string;

  constructor(options: RuntimeOptions) {
    this.agent = options.agent;
    this.intent = options.intent;
    this.model = options.modelAdapter;
    this.registry = options.registry ?? toolRegistry;
    this.isCi = options.isCiEnvironment ?? false;
    this.runId = options.runId ?? `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    this.budgets = new BudgetTracker(this.agent.budgets);
    this.approval = new ApprovalEngine({
      registry: this.registry,
      policy: this.agent.policy,
    });
    this.policy = new PolicyEngine({
      registry: this.registry,
      approval: this.approval,
      budgets: this.budgets,
      policy: this.agent.policy,
      intent: this.intent,
      isCiEnvironment: this.isCi,
    });

    if (options.checkpointDir) {
      this.checkpoints = new CheckpointManager({
        baseDir: options.checkpointDir,
        policyVersion: options.policyVersion ?? '1.0',
        toolVersions: Object.fromEntries(
          this.registry.getAll().map((t) => [t.name, t.version]),
        ),
      });
    }

    this.repeatedActionDetector = new RepeatedActionDetector();
    this.loopDetector = new LoopDetector();
    this.stallDetector = new StallDetector();
    this.abortController = new AbortController();

    this.state = {
      runId: this.runId,
      scenarioId: options.scenarioId ?? '',
      trialId: options.trialId ?? '',
      turn: 0,
      goal: this.intent,
      messages: [{
        role: 'user',
        content: this.intent.userGoal,
        timestamp: new Date().toISOString(),
      }],
      observations: [],
      pendingApprovals: [],
      startedAt: new Date().toISOString(),
    };
    this.budgets.recordMessage();
  }

  /** Get the abort signal for cancellation. */
  getAbortSignal(): AbortSignal {
    return this.abortController.signal;
  }

  /** Cancel the run. */
  cancel(): void {
    this.abortController.abort();
  }

  /** Get current agent state. */
  getState(): AgentState {
    return this.state;
  }

  /**
   * Run the agent to completion or until a stop condition is met.
   */
  async run(): Promise<AgentRunResult> {
    const startedAt = new Date().toISOString();
    const startMs = Date.now();

    try {
      // Main turn loop
      while (!this.abortController.signal.aborted) {
        // Check stop conditions
        const stopCheck = this.checkStopConditions();
        if (stopCheck.shouldStop) {
          return this.buildResult(startedAt, startMs, 'cancelled', stopCheck.stopReason);
        }

        // Check budgets
        const budgetCheck = this.budgets.check();
        if (budgetCheck.exceeded) {
          return this.buildResult(startedAt, startMs, 'cancelled', `Budget exceeded: ${budgetCheck.reason}`);
        }

        // Generate next action from model
        const modelResponse = await this.generateModelResponse();
        if (this.abortController.signal.aborted) {
          return this.buildResult(startedAt, startMs, 'cancelled', 'Cancelled');
        }

        // Record the assistant message
        this.state.messages.push({
          role: 'assistant',
          content: modelResponse.content,
          timestamp: new Date().toISOString(),
        });
        this.budgets.recordMessage();

        // If model finished (no tool calls), we're done
        if (modelResponse.finishReason === 'stop' && modelResponse.toolCalls.length === 0) {
          return this.buildResult(startedAt, startMs, 'passed');
        }

        // Process tool calls
        for (const toolCall of modelResponse.toolCalls) {
          if (this.abortController.signal.aborted) {
            return this.buildResult(startedAt, startMs, 'cancelled', 'Cancelled during tool execution');
          }

          // Check stop conditions before each tool
          const preToolStop = this.checkStopConditions();
          if (preToolStop.shouldStop) {
            return this.buildResult(startedAt, startMs, 'cancelled', preToolStop.stopReason);
          }

          // Enforce agent tool allowlist
          // Empty allowlist means no tools are allowed (explicit opt-in required)
          if (this.agent.tools.length === 0 || !this.agent.tools.includes(toolCall.name)) {
            const deniedResult = {
              allowed: false,
              toolResult: {
                success: false,
                error: `Tool "${toolCall.name}" is not in the agent's tool allowlist. Allowed: [${this.agent.tools.join(', ')}]`,
                durationMs: 0,
              },
              error: `Tool "${toolCall.name}" is not allowed for this agent`,
            };
            this.state.messages.push({
              role: 'tool',
              content: JSON.stringify(deniedResult.toolResult),
              toolCallId: toolCall.id,
              toolName: toolCall.name,
              toolArguments: toolCall.arguments,
              toolResult: deniedResult.toolResult,
              timestamp: new Date().toISOString(),
            });
            continue;
          }

          // Execute through policy engine
          const context: ToolExecutionContext = {
            agentId: this.agent.id,
            runId: this.runId,
            intent: this.intent,
            traceId: `trace-${this.runId}`,
            spanId: `span-${toolCall.id}`,
            abortSignal: this.abortController.signal,
          };

          const result = await this.policy.executeWithPolicy(toolCall.name, toolCall.arguments, context);

          if (result.approvalDecision?.approvalRequest) {
            this.state.pendingApprovals.push(
              result.approvalDecision.approvalRequest,
            );
          }

          // Record the tool result message
          this.state.messages.push({
            role: 'tool',
            content: result.toolResult?.output ? JSON.stringify(result.toolResult.output) : (result.error ?? 'No output'),
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            toolArguments: toolCall.arguments,
            toolResult: result.toolResult,
            timestamp: new Date().toISOString(),
          });
          if (result.toolResult) {
            this.state.observations.push({
              type: 'tool_output',
              data: {
                success: result.toolResult.success,
                output: result.toolResult.output,
                error: result.toolResult.error,
                durationMs: result.toolResult.durationMs,
              },
              timestamp: new Date().toISOString(),
              sourceTool: toolCall.name,
            });
          }

          // Track for loop/repeat detection
          if (result.allowed && result.toolResult?.success) {
            this.lastRepeatCheck = this.repeatedActionDetector.recordAndCheck(toolCall.name, toolCall.arguments);
            this.lastLoopCheck = this.loopDetector.recordAndCheck(toolCall.name);
            this.stallDetector.recordDistinctAction();
          }

          // Check if tool result indicates failure
          if (!result.allowed && result.error) {
            // Policy denied the action — this is not a fatal error for the run
            // The model should learn from the denial message
          }
        }

        // Increment turn counter
        this.state.turn++;
        this.budgets.recordTurn();
        this.stallDetector.recordTurn();

        // Take checkpoint at turn boundary
        if (this.checkpoints && this.state.turn % 5 === 0) {
          await this.checkpoints.save(this.state, this.budgets.getConsumption());
        }
      }

      // Cancelled via abort signal
      return this.buildResult(startedAt, startMs, 'cancelled', 'Cancelled');
    } catch (error) {
      return this.buildResult(
        startedAt,
        startMs,
        'error',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /**
   * Resume from a saved checkpoint.
   */
  async resume(checkpointId: string): Promise<AgentRunResult> {
    if (!this.checkpoints) {
      throw new Error('Checkpoint manager not configured — cannot resume');
    }

    const checkpoint = await this.checkpoints.load(checkpointId);
    if (!checkpoint) {
      throw new Error(`Checkpoint not found: ${checkpointId}`);
    }

    // Validate version compatibility
    const versionCheck = this.checkpoints.validateVersions(checkpoint);
    if (!versionCheck.valid) {
      throw new Error(`Checkpoint version mismatch: ${versionCheck.issues.join('; ')}`);
    }

    // Restore state
    this.state = checkpoint.agentState;
    this.budgets.reset(checkpoint.budgetsConsumed);

    // Continue the run loop
    return this.run();
  }

  /** Build a run result from current state. */
  private buildResult(
    startedAt: string,
    startMs: number,
    status: ExecutionStatus,
    reason?: string,
  ): AgentRunResult {
    return {
      runId: this.runId,
      status,
      reason,
      turn: this.state.turn,
      messages: this.state.messages,
      observations: this.state.observations,
      budgetsConsumed: this.budgets.getConsumption(),
      startedAt,
      endedAt: new Date().toISOString(),
      durationMs: Date.now() - startMs,
      checkpointId: this.state.checkpointId,
    };
  }

  /** Check all stop conditions. */
  private checkStopConditions(): { shouldStop: boolean; stopReason?: string } {
    // Repeated action check — uses the last recorded result
    if (this.lastRepeatCheck.shouldStop) {
      return this.lastRepeatCheck;
    }

    // Loop detection — uses the last recorded result
    if (this.lastLoopCheck.shouldStop) {
      return this.lastLoopCheck;
    }

    // Stall detection
    return this.stallDetector.check();
  }

  /** Generate the next model response from current conversation. */
  private async generateModelResponse(): Promise<ModelResponse> {
    // Only expose tools that are in the agent's allowlist
    // Empty allowlist means no tools are allowed
    const agentTools = this.agent.tools.length > 0
      ? this.registry.getAll().filter((t) => this.agent.tools.includes(t.name))
      : [];

    const request: ModelRequest = {
      messages: this.state.messages,
      systemPrompt: this.agent.instructions,
      tools: agentTools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
      model: this.agent.model,
    };

    const response = await this.model.generate(request, this.abortController.signal);

    // Track token usage
    if (response.usage) {
      this.budgets.setTokenUsage(response.usage.inputTokens, response.usage.outputTokens);
      if (response.usage.costUsd) {
        this.budgets.addCost(response.usage.costUsd);
      }
    }

    return response;
  }
}
