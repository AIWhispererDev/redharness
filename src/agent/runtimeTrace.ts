/**
 * Trace-Integrated Agent Runtime — span wrappers for the agent turn loop.
 *
 * Every model generation, tool lifecycle, policy check, approval event,
 * checkpoint, and grader decision is emitted through a TraceWriter span.
 *
 * Spans are structured so an operator can reconstruct why the agent acted,
 * what policy allowed it, what effect occurred, and why execution stopped
 * using only the persisted trace and evidence.
 */

import type { TraceWriter } from '../trace/traceWriter.js';
import type { TraceSpan, JsonValue } from '../trace/traceTypes.js';
import type { AgentState, AgentRunResult, BudgetConsumption } from './agentTypes.js';
import type { ModelResponse, ModelUsage, ModelRequest } from './modelAdapter.js';
import { redactDeep } from '../trace/redaction.js';

// ---------------------------------------------------------------------------
// Span names and kinds
// ---------------------------------------------------------------------------

const SPAN_NAMES = {
  AGENT_INVOKE: 'agent.invoke',
  MODEL_GENERATE: 'model.generate',
  TURN_PLAN: 'agent.plan',
  TOOL_EXECUTE: 'tool.execute',
  POLICY_CHECK: 'policy.check',
  APPROVAL_EVENT: 'policy.approval',
  CHECKPOINT_SAVE: 'checkpoint.save',
  CHECKPOINT_LOAD: 'checkpoint.load',
  GRADER_SCORE: 'grader.score',
  CLEANUP: 'agent.cleanup',
} as const;

// ---------------------------------------------------------------------------
// AgentTraceHelper — manages span lifecycle for a single agent run
// ---------------------------------------------------------------------------

export type AgentTraceOptions = {
  traceWriter: TraceWriter;
  runId: string;
  attemptId: string;
  agentId: string;
  scenarioId?: string;
  trialId?: string;
};

export class AgentTraceHelper {
  private traceWriter: TraceWriter;
  private runId: string;
  private attemptId: string;
  private agentId: string;
  private scenarioId: string;
  private trialId: string;

  /** The top-level agent invocation span ID. */
  private invokeSpanId?: string;

  /** The current plan/turn span ID (one per turn). */
  private planSpanId?: string;

  /** Track open child spans for error propagation. */
  private openSpanStack: string[] = [];

  constructor(options: AgentTraceOptions) {
    this.traceWriter = options.traceWriter;
    this.runId = options.runId;
    this.attemptId = options.attemptId;
    this.agentId = options.agentId;
    this.scenarioId = options.scenarioId ?? '';
    this.trialId = options.trialId ?? '';
  }

  /** Get the trace writer for flush operations. */
  getTraceWriter(): TraceWriter {
    return this.traceWriter;
  }

  /** Get the trace ID. */
  getTraceId(): string {
    return this.traceWriter.getTraceId();
  }

  /** Get the invocation span ID (set after startInvoke). */
  getInvokeSpanId(): string | undefined {
    return this.invokeSpanId;
  }

  // -----------------------------------------------------------------------
  // Top-level lifecycle
  // -----------------------------------------------------------------------

  /** Start the agent invocation span. */
  startInvoke(attributes?: Record<string, JsonValue>): string {
    this.invokeSpanId = this.traceWriter.startSpan({
      name: SPAN_NAMES.AGENT_INVOKE,
      kind: 'agent.invoke',
      attemptId: this.attemptId,
      attributes: {
        runId: this.runId,
        agentId: this.agentId,
        scenarioId: this.scenarioId,
        trialId: this.trialId,
        ...attributes,
      },
    });
    this.openSpanStack.push(this.invokeSpanId);
    return this.invokeSpanId;
  }

  /** End the agent invocation span with final status. */
  endInvoke(result: AgentRunResult): void {
    if (!this.invokeSpanId) return;
    this.traceWriter.endSpan(this.invokeSpanId, result.status === 'passed' ? 'ok' : 'error', {
      turn: result.turn,
      status: result.status,
      stopReason: result.reason ?? '',
      durationMs: result.durationMs,
      budgetsConsumed: JSON.stringify({
        wallTimeMs: result.budgetsConsumed.wallTimeMs,
        turns: result.budgetsConsumed.turns,
        messages: result.budgetsConsumed.messages,
        toolCalls: result.budgetsConsumed.toolCalls,
        tokens: result.budgetsConsumed.tokens,
        costUsd: result.budgetsConsumed.costUsd,
        networkRequests: result.budgetsConsumed.networkRequests,
      } as JsonValue),
    });
    this.popSpan(this.invokeSpanId);
  }

  // -----------------------------------------------------------------------
  // Model generation spans
  // -----------------------------------------------------------------------

  /** Start a model generation span for a turn. */
  startModelGenerate(
    request: ModelRequest,
    parentSpanId?: string,
  ): string {
    const spanId = this.traceWriter.startSpan({
      name: SPAN_NAMES.MODEL_GENERATE,
      kind: 'model.generate',
      parentSpanId: parentSpanId ?? this.planSpanId ?? this.invokeSpanId,
      attemptId: this.attemptId,
      attributes: {
        model: `${request.model?.provider ?? 'unknown'}/${request.model?.modelId ?? 'unknown'}`,
        toolCount: request.tools?.length ?? 0,
        messageCount: request.messages.length,
        // Redact system prompt and message content — attributes only get schema info
        hasSystemPrompt: !!request.systemPrompt,
        toolChoice: request.toolChoice ?? 'auto',
      },
    });
    this.openSpanStack.push(spanId);
    return spanId;
  }

  /** End a model generation span with usage and finish reason. */
  endModelGenerate(spanId: string, response: ModelResponse): void {
    const attributes: Record<string, JsonValue> = {
      finishReason: response.finishReason,
      toolCallCount: response.toolCalls.length,
      outputLength: response.content.length,
    };

    if (response.usage) {
      attributes.inputTokens = response.usage.inputTokens;
      attributes.outputTokens = response.usage.outputTokens;
      attributes.totalTokens = response.usage.totalTokens;
      if (response.usage.costUsd !== undefined) {
        attributes.costUsd = response.usage.costUsd;
      }
    }

    const status = response.finishReason === 'error' || response.finishReason === 'cancelled'
      ? 'error'
      : 'ok';

    this.traceWriter.endSpan(spanId, status, attributes);
    this.popSpan(spanId);
  }

  /** Record a model error as a span event and close the span. */
  endModelGenerateError(spanId: string, error: Error): void {
    this.traceWriter.addEvent(spanId, 'model.error', {
      error: error.message,
      name: error.name,
    });
    this.traceWriter.endSpan(spanId, 'error', { finishReason: 'error' });
    this.popSpan(spanId);
  }

  // -----------------------------------------------------------------------
  // Turn / plan span
  // -----------------------------------------------------------------------

  /** Start a turn-level plan span. */
  startTurn(turn: number): string {
    this.planSpanId = this.traceWriter.startSpan({
      name: `${SPAN_NAMES.TURN_PLAN}.turn-${turn}`,
      kind: 'agent.plan',
      parentSpanId: this.invokeSpanId,
      attemptId: this.attemptId,
      attributes: { turn },
    });
    this.openSpanStack.push(this.planSpanId);
    return this.planSpanId;
  }

  /** End the turn plan span. */
  endTurn(turn: number, stopReason?: string): void {
    if (!this.planSpanId) return;
    this.traceWriter.endSpan(this.planSpanId, 'ok', {
      turn,
      stopReason: stopReason ?? '',
    });
    this.popSpan(this.planSpanId);
    this.planSpanId = undefined;
  }

  // -----------------------------------------------------------------------
  // Tool execution spans
  // -----------------------------------------------------------------------

  /** Start a tool execution span. */
  startToolExecute(
    toolName: string,
    args: Record<string, unknown>,
    parentSpanId?: string,
  ): string {
    // Redact tool arguments before recording
    const redactedArgs = redactDeep(args).result as Record<string, unknown>;

    const spanId = this.traceWriter.startSpan({
      name: `${SPAN_NAMES.TOOL_EXECUTE}.${toolName}`,
      kind: 'tool.execute',
      parentSpanId: parentSpanId ?? this.planSpanId ?? this.invokeSpanId,
      attemptId: this.attemptId,
      attributes: {
        toolName,
        arguments: JSON.stringify(redactedArgs),
        argCount: Object.keys(args).length,
      },
    });
    this.openSpanStack.push(spanId);
    return spanId;
  }

  /** End a tool execution span with result. */
  endToolExecute(
    spanId: string,
    result: { success: boolean; durationMs: number; error?: string; output?: unknown },
  ): void {
    const attributes: Record<string, JsonValue> = {
      success: result.success,
      durationMs: result.durationMs,
    };
    if (result.error) {
      attributes.error = result.error;
    }
    if (result.output !== undefined) {
      // Redact output for sensitive content
      attributes.outputPreview = JSON.stringify(redactDeep(result.output).result).slice(0, 1000);
    }

    const status = result.success ? 'ok' : 'error';
    this.traceWriter.endSpan(spanId, status, attributes);
    this.popSpan(spanId);
  }

  // -----------------------------------------------------------------------
  // Policy check spans
  // -----------------------------------------------------------------------

  /** Start a policy evaluation span. */
  startPolicyCheck(
    toolName: string,
    args: Record<string, unknown>,
    parentSpanId?: string,
  ): string {
    const spanId = this.traceWriter.startSpan({
      name: `${SPAN_NAMES.POLICY_CHECK}.${toolName}`,
      kind: 'policy.check',
      parentSpanId: parentSpanId ?? this.invokeSpanId,
      attemptId: this.attemptId,
      attributes: {
        toolName,
        // Record argument keys and types only, not values (secrets)
        argShape: JSON.stringify(
          Object.entries(args).map(([k, v]) => [k, typeof v]),
        ),
      },
    });
    this.openSpanStack.push(spanId);
    return spanId;
  }

  /** End a policy check span with decision. */
  endPolicyCheck(
    spanId: string,
    decision: { allowed: boolean; policy: string; reason: string; requiresHuman?: boolean },
  ): void {
    this.traceWriter.endSpan(spanId, decision.allowed ? 'ok' : 'error', {
      allowed: decision.allowed,
      policy: decision.policy,
      reason: decision.reason,
      requiresHuman: decision.requiresHuman ?? false,
    });
    this.popSpan(spanId);
  }

  // -----------------------------------------------------------------------
  // Approval event — emitted alongside policy check for audit
  // -----------------------------------------------------------------------

  /** Record an approval event on the policy check span or agent span. */
  recordApprovalEvent(
    parentSpanId: string | undefined,
    approval: {
      id: string;
      toolName: string;
      risk: string;
      decision: string;
      decidedBy: string;
      reason?: string;
    },
  ): void {
    this.traceWriter.addEvent(parentSpanId ?? this.invokeSpanId ?? '', SPAN_NAMES.APPROVAL_EVENT, {
      approvalId: approval.id,
      toolName: approval.toolName,
      risk: approval.risk,
      decision: approval.decision,
      decidedBy: approval.decidedBy,
      reason: approval.reason ?? '',
    });
  }

  // -----------------------------------------------------------------------
  // Checkpoint spans
  // -----------------------------------------------------------------------

  /** Start a checkpoint save span. */
  startCheckpointSave(turn: number, parentSpanId?: string): string {
    const spanId = this.traceWriter.startSpan({
      name: `${SPAN_NAMES.CHECKPOINT_SAVE}.turn-${turn}`,
      kind: 'checkpoint.save',
      parentSpanId: parentSpanId ?? this.invokeSpanId,
      attemptId: this.attemptId,
      attributes: { turn },
    });
    this.openSpanStack.push(spanId);
    return spanId;
  }

  /** End a checkpoint save span. */
  endCheckpointSave(spanId: string, checkpointId: string, result: 'ok' | 'error'): void {
    this.traceWriter.endSpan(spanId, result, { checkpointId });
    this.popSpan(spanId);
  }

  /** Start a checkpoint load span. */
  startCheckpointLoad(checkpointId: string): string {
    const spanId = this.traceWriter.startSpan({
      name: `${SPAN_NAMES.CHECKPOINT_LOAD}.${checkpointId}`,
      kind: 'checkpoint.load',
      parentSpanId: this.invokeSpanId,
      attemptId: this.attemptId,
      attributes: { checkpointId },
    });
    this.openSpanStack.push(spanId);
    return spanId;
  }

  /** End a checkpoint load span. */
  endCheckpointLoad(spanId: string, result: 'ok' | 'error', error?: string): void {
    const attrs: Record<string, JsonValue> = {};
    if (error) attrs.error = error;
    this.traceWriter.endSpan(spanId, result, attrs);
    this.popSpan(spanId);
  }

  // -----------------------------------------------------------------------
  // Grader spans
  // -----------------------------------------------------------------------

  /** Start a grader span. */
  startGrader(name: string, parentSpanId?: string, attributes?: Record<string, JsonValue>): string {
    const spanId = this.traceWriter.startSpan({
      name: `${SPAN_NAMES.GRADER_SCORE}.${name}`,
      kind: 'grader.score',
      parentSpanId: parentSpanId ?? this.invokeSpanId,
      attemptId: this.attemptId,
      attributes: { graderName: name, ...attributes },
    });
    this.openSpanStack.push(spanId);
    return spanId;
  }

  /** End a grader span. */
  endGrader(
    spanId: string,
    score: number | boolean,
    threshold?: number,
    passed?: boolean,
    details?: string,
  ): void {
    const attrs: Record<string, JsonValue> = {
      score: typeof score === 'boolean' ? (score ? 1 : 0) : score,
    };
    if (threshold !== undefined) attrs.threshold = threshold;
    if (passed !== undefined) attrs.passed = passed;
    if (details !== undefined) attrs.details = details.slice(0, 2000);
    this.traceWriter.endSpan(spanId, 'ok', attrs);
    this.popSpan(spanId);
  }

  // -----------------------------------------------------------------------
  // Cleanup spans
  // -----------------------------------------------------------------------

  /** Start the cleanup span. */
  startCleanup(): string {
    const spanId = this.traceWriter.startSpan({
      name: SPAN_NAMES.CLEANUP,
      kind: 'cleanup',
      parentSpanId: this.invokeSpanId,
      attemptId: this.attemptId,
      attributes: {},
    });
    this.openSpanStack.push(spanId);
    return spanId;
  }

  /** End the cleanup span. */
  endCleanup(spanId: string, result: 'ok' | 'error', error?: string): void {
    const attrs: Record<string, JsonValue> = {};
    if (error) attrs.error = error;
    this.traceWriter.endSpan(spanId, result, attrs);
    this.popSpan(spanId);
  }

  // -----------------------------------------------------------------------
  // Error / cancellation — close all open spans
  // -----------------------------------------------------------------------

  /**
   * Close all open spans with error status.
   * Used on cancellation, timeout, or unhandled exceptions.
   */
  closeAllOnError(error?: string): void {
    const reason = error ?? 'unexpected error';
    while (this.openSpanStack.length > 0) {
      const spanId = this.openSpanStack.pop();
      if (!spanId) continue;
      this.traceWriter.addEvent(spanId, 'aborted', { reason });
      this.traceWriter.endSpan(spanId, 'cancelled', { error: reason });
    }
    this.invokeSpanId = undefined;
    this.planSpanId = undefined;
  }

  /** Flush all pending spans to disk. */
  async flush(): Promise<void> {
    try {
      await this.traceWriter.flush();
    } catch {
      // Best-effort flush — never throw from trace helper
    }
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private popSpan(spanId: string): void {
    const idx = this.openSpanStack.lastIndexOf(spanId);
    if (idx >= 0) {
      this.openSpanStack.splice(idx, 1);
    }
  }
}
