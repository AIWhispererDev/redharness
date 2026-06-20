/**
 * PRD 04: Bounded Agent Runtime — orchestrates model interaction, tool
 * execution, policy enforcement, budget tracking, checkpoints, and
 * stop conditions for a single agent run.
 *
 * This runtime is provider-neutral, bounded, cancellable, and resumable.
 */

import { randomUUID, createHash } from 'node:crypto';
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
import { BrowserSessionManager } from './browser/sessionManager.js';
import type { ExecutionStatus } from '../core/status.js';
import type { BudgetConsumption } from './agentTypes.js';
import { AgentTraceHelper } from './runtimeTrace.js';
import { AgentEvidenceBuilder } from './agentEvidence.js';
import type { ApprovalBinding, VersionedMetadata } from './runStateStore.js';
import type { IdempotencyStore } from './idempotency.js';
import type { AgentRunService } from '../service/agentRunService.js';
import type { ArtifactStore } from '../artifacts/artifactStore.js';
import type { TraceWriter } from '../trace/traceWriter.js';

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
  /** Controlled fixture origin passed to fixture-only tools. */
  fixtureBaseUrl?: string;
  /** Agent run service for durable control-plane integration. */
  agentRunService?: AgentRunService;
  /** Idempotency store for preventing repeated side effects. */
  idempotencyStore?: IdempotencyStore;
  /** Versioned metadata for checkpoint/run-state persistence. */
  versionedMetadata?: VersionedMetadata;
  /** Callback when runtime transitions to awaiting-approval (for service integration). */
  onAwaitingApproval?: (approvalBindings: ApprovalBinding[], checkpointId?: string) => Promise<void>;
  /** Trace writer for evidence persistence (injected by coordinator). */
  traceWriter?: TraceWriter;
  /** Artifact store for evidence persistence. */
  artifactStore?: ArtifactStore;
  /** Parent span ID for trace correlation. */
  parentSpanId?: string;
  /** Attempt ID for trace correlation. */
  attemptId?: string;
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
  private fixtureBaseUrl?: string;
  private traceHelper: AgentTraceHelper;
  private evidenceBuilder: AgentEvidenceBuilder;
  private artifactStore?: ArtifactStore;
  private agentRunService?: AgentRunService;
  private idempotencyStore?: IdempotencyStore;
  private versionedMetadata?: VersionedMetadata;
  private onAwaitingApproval?: (approvalBindings: ApprovalBinding[], checkpointId?: string) => Promise<void>;

  constructor(options: RuntimeOptions) {
    this.agent = options.agent;
    this.intent = options.intent;
    this.model = options.modelAdapter;
    this.registry = options.registry ?? toolRegistry;
    this.isCi = options.isCiEnvironment ?? false;
    this.fixtureBaseUrl = options.fixtureBaseUrl;
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

    // Initialize trace helper and evidence builder
    const attemptId = options.attemptId ?? `agent-${this.runId}`;
    this.traceHelper = new AgentTraceHelper({
      traceWriter: (options.traceWriter ?? this.createNullTraceWriter()) as import('../trace/traceWriter.js').TraceWriter,
      runId: this.runId,
      attemptId,
      agentId: this.agent.id,
      scenarioId: options.scenarioId,
      trialId: options.trialId,
    });
    this.evidenceBuilder = new AgentEvidenceBuilder({
      runId: this.runId,
      attemptId,
      traceId: this.traceHelper.getTraceId(),
      agentId: this.agent.id,
    });
    this.artifactStore = options.artifactStore;
    this.agentRunService = options.agentRunService;
    this.idempotencyStore = options.idempotencyStore;
    this.versionedMetadata = options.versionedMetadata;
    this.onAwaitingApproval = options.onAwaitingApproval;

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
    // Trigger browser cleanup asynchronously
    BrowserSessionManager.getInstance().closeSession(this.runId).catch(() => {});
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

    // Ensure browser cleanup on all exit paths
    const cleanupBrowser = async () => {
      await BrowserSessionManager.getInstance().closeSession(this.runId).catch(() => {});
    };

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

          // Check idempotency — if this exact mutation was already completed, skip it
          if (this.idempotencyStore?.isImmutable(toolCall.name, toolCall.arguments, this.runId)) {
            const skippedResult = {
              success: true,
              output: { skipped: true, reason: `Action already completed (idempotency key).` },
              durationMs: 0,
            };
            this.state.messages.push({
              role: 'tool',
              content: JSON.stringify(skippedResult),
              toolCallId: toolCall.id,
              toolName: toolCall.name,
              toolArguments: toolCall.arguments,
              toolResult: skippedResult,
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
            ...(this.fixtureBaseUrl
              ? { fixtureBaseUrl: this.fixtureBaseUrl }
              : {}),
          };

          const result = await this.policy.executeWithPolicy(toolCall.name, toolCall.arguments, context);

          // If tool requires human approval, pause execution and persist state
          if (result.approvalDecision?.approvalRequest && result.approvalDecision.requiresHuman) {
            // Create durable approval binding with hashed arguments
            const risk = result.approvalDecision.approvalRequest?.risk ?? 'write';
            const approvalBinding = this.approval.createApprovalBinding(
              toolCall.name,
              toolCall.arguments,
              risk as import('./agentTypes.js').ToolRiskLevel,
              this.runId,
              300_000, // 5 minute expiration
            );

            // Take checkpoint before pausing
            let checkpointId: string | undefined;
            if (this.checkpoints) {
              const ckpt = await this.checkpoints.save(this.state, this.budgets.getConsumption());
              checkpointId = ckpt.id;
              this.state.checkpointId = ckpt.id;
            }

            this.state.pendingApprovals.push(
              result.approvalDecision.approvalRequest,
            );

            // Notify via callback (used by service integration)
            if (this.onAwaitingApproval) {
              await this.onAwaitingApproval([approvalBinding], checkpointId);
            }

            // Return paused state — caller will re-enter via resume after approval
            return this.buildResult(startedAt, startMs, 'cancelled', `Awaiting approval for tool called. Status saved to checkpoint.`);
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

          // Record idempotency for successful mutations
          if (result.allowed && result.toolResult?.success && this.idempotencyStore) {
            const toolDef = this.registry.get(toolCall.name);
            const mutationIntent = toolDef?.risk ?? 'write';
            this.idempotencyStore.record(
              toolCall.name,
              toolCall.arguments,
              this.runId,
              this.state.turn,
              'success',
              mutationIntent,
            );
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
      await cleanupBrowser();
      return this.buildResult(
        startedAt,
        startMs,
        'error',
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      await cleanupBrowser();
    }
  }

  /**
   * Resume from a saved checkpoint.
   */
  async resume(checkpointId: string): Promise<AgentRunResult> {
    if (!this.checkpoints) {
      throw new Error('Checkpoint manager not configured — cannot resume');
    }

    const loadSpanId = this.traceHelper.startCheckpointLoad(checkpointId);

    const checkpoint = await this.checkpoints.load(checkpointId);
    if (!checkpoint) {
      this.traceHelper.endCheckpointLoad(loadSpanId, 'error', `Checkpoint not found: ${checkpointId}`);
      throw new Error(`Checkpoint not found: ${checkpointId}`);
    }

    // Validate version compatibility
    const versionCheck = this.checkpoints.validateVersions(checkpoint);
    if (!versionCheck.valid) {
      this.traceHelper.endCheckpointLoad(loadSpanId, 'error', `Version mismatch: ${versionCheck.issues.join('; ')}`);
      throw new Error(`Checkpoint version mismatch: ${versionCheck.issues.join('; ')}`);
    }

    // Record trace cursor for parentage
    this.traceHelper.getTraceWriter().addEvent(loadSpanId, 'checkpoint.restore', {
      checkpointId,
      previousTurn: checkpoint.agentState.turn,
    });

    this.traceHelper.endCheckpointLoad(loadSpanId, 'ok');

    // Restore state
    this.state = checkpoint.agentState;
    this.budgets.reset(checkpoint.budgetsConsumed);

    // Reset stop condition detectors for fresh state after resume
    this.repeatedActionDetector.reset();
    this.loopDetector.reset();
    this.stallDetector.reset();

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

  /** Build versioned metadata from current runtime configuration. */
  getVersionedMetadata(policyVersion: string = '1.0'): VersionedMetadata {
    return {
      policyVersion,
      toolVersions: Object.fromEntries(
        this.registry.getAll().map((t) => [t.name, t.version]),
      ),
      modelConfig: this.agent.model,
      toolDefinitions: this.registry.getAll().map((t) => ({
        name: t.name,
        version: t.version,
        inputSchema: t.inputSchema,
        risk: t.risk,
        capabilities: t.capabilities,
      })),
      policy: this.agent.policy,
      intent: this.intent,
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

    // Start model generation span
    const modelSpanId = this.traceHelper.startModelGenerate(request);
    this.evidenceBuilder.addModelGenerateSpanId(modelSpanId);

    let response: ModelResponse;
    try {
      response = await this.model.generate(request, this.abortController.signal);
    } catch (error) {
      this.traceHelper.endModelGenerateError(modelSpanId, error instanceof Error ? error : new Error(String(error)));
      throw error;
    }

    // Track token usage
    if (response.usage) {
      this.budgets.setTokenUsage(response.usage.inputTokens, response.usage.outputTokens);
      if (response.usage.costUsd) {
        this.budgets.addCost(response.usage.costUsd);
      }
    }

    // End model generation span with usage and finish reason
    this.traceHelper.endModelGenerate(modelSpanId, response);

    return response;
  }

  /** Create a null trace writer for safe fallback when none is injected. */
  private createNullTraceWriter(): {
    getTraceId(): string;
    getSpans(): Array<Record<string, unknown>>;
    startSpan(p: { name: string; kind: string; parentSpanId?: string; attemptId?: string; attributes?: Record<string, unknown> }): string;
    endSpan(spanId: string, status?: string, attributes?: Record<string, unknown>): void;
    addEvent(spanId: string, name: string, attributes?: Record<string, unknown>): void;
    setAttribute(spanId: string, key: string, value: unknown): void;
    flush(): Promise<void>;
    getRedactionSummary(): Array<{ fieldPath: string; ruleId: string }>;
    buildCorrelation(overrides: Record<string, string>): { runId: string; attemptId: string; traceId: string };
  } {
    const traceId = `null-${this.runId}`;
    const spans: Array<Record<string, unknown>> = [];
    const redactions: Array<{ fieldPath: string; ruleId: string }> = [];

    return {
      getTraceId: () => traceId,
      getSpans: () => [...spans],
      getRedactionSummary: () => [...redactions],
      startSpan: (p) => {
        const spanId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        spans.push({
          traceId, spanId,
          parentSpanId: p.parentSpanId,
          attemptId: p.attemptId,
          name: p.name,
          kind: p.kind,
          startedAt: new Date().toISOString(),
          status: 'ok',
          attributes: p.attributes ?? {},
          events: [],
        });
        return spanId;
      },
      endSpan: (spanId, status, attributes) => {
        const s = spans.find((sp) => sp.spanId === spanId);
        if (!s) return;
        s.endedAt = new Date().toISOString();
        if (status) s.status = status;
        if (attributes) Object.assign(s.attributes as Record<string, unknown>, attributes);
      },
      addEvent: (spanId, name, attributes) => {
        const s = spans.find((sp) => sp.spanId === spanId);
        if (!s) return;
        (s.events as Array<unknown>).push({ name, timestamp: new Date().toISOString(), attributes: attributes ?? {} });
      },
      setAttribute: (spanId, key, value) => {
        const s = spans.find((sp) => sp.spanId === spanId);
        if (!s) return;
        (s.attributes as Record<string, unknown>)[key] = value;
      },
      flush: async () => {},
      buildCorrelation: (overrides) => ({ runId: '', attemptId: '0', traceId, ...overrides }),
    };
  }

  /** Flush trace spans and persist evidence manifest. */
  private async flushEvidence(): Promise<void> {
    try {
      await this.traceHelper.flush();
      if (this.artifactStore) {
        const evidence = this.evidenceBuilder.build();
        const manifestRef = await this.artifactStore.writeJson(
          'agent-evidence-manifest',
          evidence,
          `agent-evidence-${this.runId}.json`,
          { subDir: 'evidence' },
        );
        this.evidenceBuilder.addArtifact(manifestRef);
        await this.artifactStore.saveManifest(
          this.evidenceBuilder.build().attemptId,
          this.traceHelper.getTraceId(),
        );
      }
      await this.traceHelper.flush();
    } catch {
      // Best-effort flush — never throw from cleanup
    }
  }
}
