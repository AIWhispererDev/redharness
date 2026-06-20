/**
 * Agent Evidence Manifest — correlates every decision and effect with
 * the harness trace and artifact system.
 *
 * Produces an evidence manifest per agent run that links:
 * - run / suite / scenario / trial / attempt IDs
 * - trace and span IDs for every model generation, tool call, policy decision
 * - artifact references for persisted state snapshots, recordings, findings
 * - redaction summary
 *
 * The manifest is designed so an operator can reconstruct why the agent acted,
 * what policy allowed it, what effect occurred, and why execution stopped
 * using only the persisted trace and evidence.
 */

import type {
  AgentRunResult,
  AgentMessage,
  BudgetConsumption,
} from './agentTypes.js';
import type {
  EvidenceManifest,
  ArtifactRef,
  RedactionEntry,
} from '../trace/traceTypes.js';
import { redactDeep, redactText } from '../trace/redaction.js';

// ---------------------------------------------------------------------------
// Agent run evidence manifest
// ---------------------------------------------------------------------------

export type AgentEvidenceManifest = EvidenceManifest & {
  /** Trace helper span IDs for quick navigation. */
  spanReferences: {
    invokeSpanId?: string;
    planSpanIds: string[];
    modelGenerateSpanIds: string[];
    toolExecuteSpanIds: string[];
    policyCheckSpanIds: string[];
    checkpointSpanIds: string[];
    graderSpanIds: string[];
  };
  /** Turn-level summaries for replay traceability. */
  turnSummaries: TurnEvidenceSummary[];
  /** Run metadata. */
  runMetadata: {
    agentId: string;
    budgetsConsumed: BudgetConsumption;
    messagesRedacted: number;
    toolCallsRedacted: number;
    totalTokens: number;
    costUsd?: number;
  };
};

export type TurnEvidenceSummary = {
  turn: number;
  modelSpanId: string;
  planSpanId: string;
  finishReason: string;
  toolCallCount: number;
  toolSpanIds: string[];
  policySpanIds: string[];
  /** Redacted assistant message content (first 500 chars). */
  messagePreview: string;
  /** Normalized tool calls for this turn. */
  toolCalls: Array<{
    name: string;
    spanId: string;
    policySpanId: string;
    success: boolean;
    durationMs: number;
  }>;
  /** Whether this turn was the last one (stop reason). */
  stopReason?: string;
};

// ---------------------------------------------------------------------------
// Evidence builder
// ---------------------------------------------------------------------------

export type EvidenceBuilderOptions = {
  runId: string;
  attemptId: string;
  traceId: string;
  agentId: string;
};

/**
 * Builds evidence manifests for agent runs, correlating trace spans,
 * artifacts, messages, and decisions.
 */
export class AgentEvidenceBuilder {
  private runId: string;
  private attemptId: string;
  private traceId: string;
  private agentId: string;
  private artifacts: ArtifactRef[] = [];
  private redactions: RedactionEntry[] = [];
  private spanReferences: AgentEvidenceManifest['spanReferences'] = {
    invokeSpanId: undefined,
    planSpanIds: [],
    modelGenerateSpanIds: [],
    toolExecuteSpanIds: [],
    policyCheckSpanIds: [],
    checkpointSpanIds: [],
    graderSpanIds: [],
  };
  private turnSummaries: TurnEvidenceSummary[] = [];
  private budgetsConsumed: BudgetConsumption = {
    wallTimeMs: 0,
    turns: 0,
    messages: 0,
    toolCalls: 0,
    networkRequests: 0,
  };
  private totalTokens = 0;
  private costUsd?: number;

  constructor(options: EvidenceBuilderOptions) {
    this.runId = options.runId;
    this.attemptId = options.attemptId;
    this.traceId = options.traceId;
    this.agentId = options.agentId;
  }

  // -----------------------------------------------------------------------
  // Span reference tracking
  // -----------------------------------------------------------------------

  setInvokeSpanId(spanId: string): void {
    this.spanReferences.invokeSpanId = spanId;
  }

  addPlanSpanId(spanId: string): void {
    this.spanReferences.planSpanIds.push(spanId);
  }

  addModelGenerateSpanId(spanId: string): void {
    this.spanReferences.modelGenerateSpanIds.push(spanId);
  }

  addToolExecuteSpanId(spanId: string): void {
    this.spanReferences.toolExecuteSpanIds.push(spanId);
  }

  addPolicyCheckSpanId(spanId: string): void {
    this.spanReferences.policyCheckSpanIds.push(spanId);
  }

  addCheckpointSpanId(spanId: string): void {
    this.spanReferences.checkpointSpanIds.push(spanId);
  }

  addGraderSpanId(spanId: string): void {
    this.spanReferences.graderSpanIds.push(spanId);
  }

  // -----------------------------------------------------------------------
  // Turn summary recording
  // -----------------------------------------------------------------------

  recordTurnSummary(summary: TurnEvidenceSummary): void {
    this.turnSummaries.push(summary);
  }

  // -----------------------------------------------------------------------
  // Budgets
  // -----------------------------------------------------------------------

  setBudgets(consumption: BudgetConsumption): void {
    this.budgetsConsumed = consumption;
  }

  setTokenUsage(input: number, output: number): void {
    this.totalTokens += input + output;
  }

  setCost(usd: number): void {
    this.costUsd = (this.costUsd ?? 0) + usd;
  }

  // -----------------------------------------------------------------------
  // Artifacts
  // -----------------------------------------------------------------------

  addArtifact(ref: ArtifactRef): void {
    this.artifacts.push(ref);
  }

  addArtifacts(refs: ArtifactRef[]): void {
    this.artifacts.push(...refs);
  }

  // -----------------------------------------------------------------------
  // Redaction
  // -----------------------------------------------------------------------

  addRedaction(entry: RedactionEntry): void {
    this.redactions.push(entry);
  }

  addRedactions(entries: RedactionEntry[]): void {
    this.redactions.push(...entries);
  }

  // -----------------------------------------------------------------------
  // Build
  // -----------------------------------------------------------------------

  /**
   * Build the final evidence manifest for this agent run.
   */
  build(): AgentEvidenceManifest {
    return {
      runId: this.runId,
      attemptId: this.attemptId,
      traceId: this.traceId,
      artifacts: [...this.artifacts],
      redactionSummary: [...this.redactions],
      spanReferences: { ...this.spanReferences },
      turnSummaries: [...this.turnSummaries],
      runMetadata: {
        agentId: this.agentId,
        budgetsConsumed: { ...this.budgetsConsumed },
        messagesRedacted: this.redactions.filter((r) => r.fieldPath.includes('messages')).length,
        toolCallsRedacted: this.redactions.filter((r) => r.fieldPath.includes('toolCall')).length,
        totalTokens: this.totalTokens,
        costUsd: this.costUsd,
      },
    };
  }

  // -----------------------------------------------------------------------
  // Static helpers
  // -----------------------------------------------------------------------

  /**
   * Redact an agent message for persistent storage.
   * Returns content with sensitive patterns removed.
   */
  static redactMessage(message: AgentMessage): AgentMessage {
    const redacted = redactDeep(message).result as AgentMessage;
    return redacted;
  }

  /**
   * Redact tool arguments for persistent storage.
   */
  static redactToolArgs(args: Record<string, unknown>): Record<string, unknown> {
    return redactDeep(args).result as Record<string, unknown>;
  }

  /**
   * Extract a safe preview of assistant message content.
   */
  static previewContent(content: string, maxLength = 500): string {
    const cleaned = content.replace(/\s+/g, ' ').trim();
    if (cleaned.length <= maxLength) return cleaned;
    return cleaned.slice(0, maxLength) + '...';
  }

  /**
   * Count how many tool calls in a set of messages were denied vs allowed.
   */
  static countDeniedTools(messages: AgentMessage[]): { denied: number; allowed: number } {
    let denied = 0;
    let allowed = 0;
    for (const msg of messages) {
      if (msg.role === 'tool' && msg.toolResult) {
        const result = msg.toolResult as { success?: boolean };
        if (result.success === false) denied++;
        else allowed++;
      }
    }
    return { denied, allowed };
  }
}
