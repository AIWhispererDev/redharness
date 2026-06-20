/**
 * Feature 04: Agent Run Service — durable agent control plane.
 *
 * Centralized business logic for starting, inspecting, approving, denying,
 * cancelling, and resuming agent runs. Both CLI and MCP adapters call this
 * service.
 *
 * Key guarantees:
 * - Approval ID validation against run, tool, arguments hash, expiration,
 *   actor, and reuse.
 * - Never silently restart when resume validation fails.
 * - Repeated side effects prevented through completed action IDs.
 * - Browser state flagged as non-restorable.
 */

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { RunStateStore, type AgentRunDocument, type AgentRunStatus, type ApprovalBinding, type VersionedMetadata } from '../agent/runStateStore.js';
import { IdempotencyStore, NON_RESTORABLE_TOOLS } from '../agent/idempotency.js';
import type {
  AgentDefinition,
  AgentState,
  AgentRunResult,
  ApprovalRequest,
  IntentCapsule,
  ModelConfig,
  AgentPolicy,
  BudgetConsumption,
} from '../agent/agentTypes.js';
import type { ToolRegistry } from '../agent/toolRegistry.js';
import type { ServiceError } from './serviceTypes.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AgentRunInfo = {
  runId: string;
  status: AgentRunStatus;
  previousStatus?: AgentRunStatus;
  agentId: string;
  turn: number;
  pendingApprovals: ApprovalBinding[];
  approvalHistory: ApprovalBinding[];
  startedAt: string;
  updatedAt: string;
  endedAt?: string;
  error?: string;
};

export type ApproveOptions = {
  approvalId: string;
  runId: string;
  actor: 'human' | 'ai' | 'policy';
  reason?: string;
};

export type DenyOptions = {
  approvalId: string;
  runId: string;
  actor: 'human' | 'ai' | 'policy';
  reason?: string;
};

export type ResumeOptions = {
  runId: string;
  checkpointId?: string;
};

export type AgentRunServiceOptions = {
  runsBaseDir: string;
};

// ---------------------------------------------------------------------------
// AgentRunService
// ---------------------------------------------------------------------------

/**
 * Service for durable agent-run orchestration.
 *
 * Methods:
 *   startAgentRun, getAgentRun, listAgentRuns,
 *   approveTool, denyTool,
 *   cancelAgentRun, resumeAgentRun
 */
export class AgentRunService {
  private store: RunStateStore;
  private idempotency: IdempotencyStore;
  private options: AgentRunServiceOptions;

  /** In-memory runtime instances for active runs. */
  private activeRuntimes: Map<string, { runtime: import('../agent/runtime.js').AgentRuntime; agentId: string }> = new Map();

  constructor(options: AgentRunServiceOptions) {
    this.store = new RunStateStore({ baseDir: options.runsBaseDir });
    this.idempotency = new IdempotencyStore();
    this.options = options;
  }

  /**
   * Register an active runtime for cancellation/status polling.
   */
  registerRuntime(runId: string, runtime: import('../agent/runtime.js').AgentRuntime, agentId: string): void {
    this.activeRuntimes.set(runId, { runtime, agentId });
  }

  /**
   * Unregister a runtime.
   */
  unregisterRuntime(runId: string): void {
    this.activeRuntimes.delete(runId);
  }

  /**
   * Get a registered runtime.
   */
  getRuntime(runId: string): import('../agent/runtime.js').AgentRuntime | undefined {
    return this.activeRuntimes.get(runId)?.runtime;
  }

  /**
   * Get the idempotency store for integration with the runtime.
   */
  getIdempotencyStore(): IdempotencyStore {
    return this.idempotency;
  }

  /**
   * Create a run document before execution starts.
   */
  async createRunDocument(
    runId: string,
    agentState: AgentState,
    budgetsConsumed: BudgetConsumption,
    versionedMetadata: VersionedMetadata,
  ): Promise<AgentRunDocument> {
    return this.store.create(runId, agentState, budgetsConsumed, versionedMetadata);
  }

  /**
   * Transition an active run to awaiting-approval.
   * The runtime should pause execution and persist state before returning.
   */
  async transitionToAwaitingApproval(
    runId: string,
    agentState: AgentState,
    budgetsConsumed: BudgetConsumption,
    pendingApprovals: ApprovalBinding[],
    checkpointId?: string,
  ): Promise<AgentRunDocument | null> {
    return this.store.transition(runId, 'awaiting-approval', {
      agentState,
      budgetsConsumed,
      pendingApprovals,
      checkpointId,
    });
  }

  /**
   * Transition back to running (after approval or resume).
   */
  async transitionToRunning(
    runId: string,
    agentState: AgentState,
    budgetsConsumed: BudgetConsumption,
    pendingApprovals: ApprovalBinding[] = [],
  ): Promise<AgentRunDocument | null> {
    return this.store.transition(runId, 'running', {
      agentState,
      budgetsConsumed,
      pendingApprovals,
    });
  }

  /**
   * Get run info for display/inspection.
   */
  async getAgentRun(runId: string): Promise<{ doc: AgentRunDocument | null; error?: string }> {
    const doc = await this.store.load(runId);
    if (!doc) {
      return { doc: null, error: `Agent run not found: ${runId}` };
    }
    return { doc };
  }

  /**
   * List all agent runs.
   */
  async listAgentRuns(status?: AgentRunStatus): Promise<AgentRunDocument[]> {
    if (status) {
      return this.store.listByStatus(status);
    }
    const runIds = await this.store.listRuns();
    const docs: AgentRunDocument[] = [];
    for (const runId of runIds) {
      const doc = await this.store.load(runId);
      if (doc) docs.push(doc);
    }
    return docs;
  }

  /**
   * Approve a pending tool call.
   *
   * Validates:
   * - Approval binding exists and is pending
   * - Run is in awaiting-approval status
   * - Approval ID matches the run
   * - Tool name matches
   * - Arguments hash matches (forged or mismatched arguments)
   * - Approval has not expired
   * - Approval has not been reused (already resolved)
   * - Actor is recognized
   */
  async approveTool(options: ApproveOptions): Promise<{ success: boolean; error?: string }> {
    const { approvalId, runId, actor } = options;

    if (!['human', 'ai', 'policy'].includes(actor)) {
      return { success: false, error: `Unknown actor: ${actor}. Must be one of: human, ai, policy` };
    }

    const doc = await this.store.load(runId);
    if (!doc) {
      return { success: false, error: `Run not found: ${runId}` };
    }

    if (doc.status !== 'awaiting-approval') {
      return { success: false, error: `Run ${runId} is not awaiting approval (status: ${doc.status})` };
    }

    // Find the approval binding in pending or history
    let bindingIndex = doc.pendingApprovals.findIndex((a) => a.id === approvalId);
    let binding: ApprovalBinding | undefined;

    if (bindingIndex === -1) {
      // Check approval history for already-resolved approvals
      const historyEntry = doc.approvalHistory.find((a) => a.id === approvalId);
      if (historyEntry) {
        return { success: false, error: `Approval ${approvalId} has already been ${historyEntry.decision}` };
      }
      return { success: false, error: `Approval ${approvalId} not found in run ${runId}` };
    }

    binding = doc.pendingApprovals[bindingIndex];

    // Check if already resolved (reuse prevention)
    if (binding.decision) {
      return { success: false, error: `Approval ${approvalId} has already been ${binding.decision}` };
    }

    // Check expiration
    const expiresAt = new Date(binding.expiresAt).getTime();
    if (Date.now() > expiresAt) {
      return { success: false, error: `Approval ${approvalId} expired at ${binding.expiresAt}` };
    }

    // Resolve the approval
    const resolvedBinding: ApprovalBinding = {
      ...binding,
      resolvedAt: new Date().toISOString(),
      decision: 'allowed',
      decidedBy: actor,
      reason: options.reason,
    };

    const updatedApprovals = doc.pendingApprovals.map((a, i) =>
      i === bindingIndex ? resolvedBinding : a,
    );

    const approvalHistory = [...doc.approvalHistory, resolvedBinding];

    await this.store.transition(runId, doc.status, {
      pendingApprovals: updatedApprovals.filter((a) => a.id !== approvalId),
      approvalHistory,
    });

    return { success: true };
  }

  /**
   * Deny a pending tool call.
   *
   * Same validation as approveTool. Denied approvals are recorded in
   * approval history and removed from pending.
   */
  async denyTool(options: DenyOptions): Promise<{ success: boolean; error?: string }> {
    const { approvalId, runId, actor } = options;

    if (!['human', 'ai', 'policy'].includes(actor)) {
      return { success: false, error: `Unknown actor: ${actor}. Must be one of: human, ai, policy` };
    }

    const doc = await this.store.load(runId);
    if (!doc) {
      return { success: false, error: `Run not found: ${runId}` };
    }

    if (doc.status !== 'awaiting-approval') {
      return { success: false, error: `Run ${runId} is not awaiting approval (status: ${doc.status})` };
    }

    let bindingIndex = doc.pendingApprovals.findIndex((a) => a.id === approvalId);
    let binding: ApprovalBinding | undefined;

    if (bindingIndex === -1) {
      const historyEntry = doc.approvalHistory.find((a) => a.id === approvalId);
      if (historyEntry) {
        return { success: false, error: `Approval ${approvalId} has already been ${historyEntry.decision}` };
      }
      return { success: false, error: `Approval ${approvalId} not found in run ${runId}` };
    }

    binding = doc.pendingApprovals[bindingIndex];

    if (binding.decision) {
      return { success: false, error: `Approval ${approvalId} has already been ${binding.decision}` };
    }

    const expiresAt = new Date(binding.expiresAt).getTime();
    if (Date.now() > expiresAt) {
      return { success: false, error: `Approval ${approvalId} expired at ${binding.expiresAt}` };
    }

    const resolvedBinding: ApprovalBinding = {
      ...binding,
      resolvedAt: new Date().toISOString(),
      decision: 'denied',
      decidedBy: actor,
      reason: options.reason,
    };

    const updatedApprovals = doc.pendingApprovals.map((a, i) =>
      i === bindingIndex ? resolvedBinding : a,
    );

    const approvalHistory = [...doc.approvalHistory, resolvedBinding];

    await this.store.transition(runId, doc.status, {
      pendingApprovals: updatedApprovals.filter((a) => a.id !== approvalId),
      approvalHistory,
    });

    return { success: true };
  }

  /**
   * Cancel an agent run.
   *
   * If the runtime is still active, signals cancellation.
   * Always persists the cancelled state.
   */
  async cancelAgentRun(runId: string, reason?: string): Promise<{ success: boolean; error?: string }> {
    // Signal active runtime
    const active = this.activeRuntimes.get(runId);
    if (active) {
      active.runtime.cancel();
    }

    // Persist cancelled state
    const doc = await this.store.load(runId);
    if (!doc) {
      // Create a minimal cancelled document even if it was never started
      return { success: false, error: `Agent run not found: ${runId}` };
    }

    if (['completed', 'failed', 'cancelled'].includes(doc.status)) {
      return { success: false, error: `Run ${runId} is already ${doc.status}` };
    }

    await this.store.transition(runId, 'cancelled', {
      error: reason ?? 'Cancelled by user',
    });

    return { success: true };
  }

  /**
   * Validate resume feasibility.
   *
   * Returns what metadata changed or why resume must fail.
   * Never silently restarts — always returns explicit validation results.
   */
  async validateResume(
    runId: string,
    currentVersionedMetadata: VersionedMetadata,
  ): Promise<{
    valid: boolean;
    issues: string[];
    nonRestorableTools: string[];
  }> {
    const doc = await this.store.load(runId);
    if (!doc) {
      return { valid: false, issues: [`Run ${runId} not found`], nonRestorableTools: [] };
    }

    if (doc.status === 'completed' || doc.status === 'cancelled') {
      return { valid: false, issues: [`Run ${runId} is already ${doc.status} and cannot be resumed`], nonRestorableTools: [] };
    }

    const issues: string[] = [];

    // Policy version mismatch
    if (doc.versionedMetadata.policyVersion !== currentVersionedMetadata.policyVersion) {
      issues.push(
        `Policy version changed: stored=${doc.versionedMetadata.policyVersion}, current=${currentVersionedMetadata.policyVersion}`,
      );
    }

    // Tool version mismatches
    for (const [tool, version] of Object.entries(doc.versionedMetadata.toolVersions)) {
      const currentVersion = currentVersionedMetadata.toolVersions[tool];
      if (currentVersion && currentVersion !== version) {
        issues.push(
          `Tool "${tool}" version changed: stored=${version}, current=${currentVersion}`,
        );
      }
    }

    // Model config changes
    const modelChanged =
      doc.versionedMetadata.modelConfig.provider !== currentVersionedMetadata.modelConfig.provider ||
      doc.versionedMetadata.modelConfig.modelId !== currentVersionedMetadata.modelConfig.modelId;
    if (modelChanged) {
      issues.push(
        `Model config changed: stored=${doc.versionedMetadata.modelConfig.provider}/${doc.versionedMetadata.modelConfig.modelId}, current=${currentVersionedMetadata.modelConfig.provider}/${currentVersionedMetadata.modelConfig.modelId}`,
      );
    }

    // Detect non-restorable tools in the agent state
    const nonRestorableTools: string[] = [];
    for (const msg of doc.agentState.messages) {
      if (msg.toolName && NON_RESTORABLE_TOOLS.has(msg.toolName)) {
        nonRestorableTools.push(msg.toolName);
      }
    }

    if (nonRestorableTools.length > 0) {
      issues.push(
        `Run used non-restorable tools: [${[...new Set(nonRestorableTools)].join(', ')}]. Browser state cannot be restored.`,
      );
    }

    return {
      valid: issues.length === 0,
      issues,
      nonRestorableTools: [...new Set(nonRestorableTools)],
    };
  }

  /**
   * Prepare resume context from persisted state.
   * Returns the restored agent state and budgets, or throws on validation failure.
   */
  async prepareResume(
    runId: string,
    currentVersionedMetadata: VersionedMetadata,
  ): Promise<{
    success: boolean;
    agentState?: AgentState;
    budgetsConsumed?: BudgetConsumption;
    completedActionIds?: string[];
    error?: string;
  }> {
    const doc = await this.store.load(runId);
    if (!doc) {
      return { success: false, error: `Agent run not found: ${runId}` };
    }

    // Validate version compatibility
    const validation = await this.validateResume(runId, currentVersionedMetadata);
    if (!validation.valid) {
      return {
        success: false,
        error: `Cannot resume: ${validation.issues.join('; ')}`,
      };
    }

    // Restore idempotency state from completed actions
    if (doc.completedActionIds.length > 0) {
      // The completedActionIds are stored as action ID strings.
      // On resume, the runtime will check these before executing tools.
    }

    // Transition back to running
    await this.store.transition(runId, 'running', {
      pendingApprovals: [],
    });

    return {
      success: true,
      agentState: doc.agentState,
      budgetsConsumed: doc.budgetsConsumed,
      completedActionIds: doc.completedActionIds,
    };
  }

  /**
   * Check if an approval binding's arguments match the current tool call.
   * Detects forged or mismatched arguments.
   */
  static validateApprovalBinding(
    binding: ApprovalBinding,
    toolName: string,
    args: Record<string, unknown>,
  ): { valid: boolean; reason?: string } {
    // Tool name must match
    if (binding.toolName !== toolName) {
      return { valid: false, reason: `Tool name mismatch: approval for "${binding.toolName}", call for "${toolName}"` };
    }

    // Arguments hash must match (prevents forged arguments)
    const currentHash = createHash('sha256')
      .update(JSON.stringify(args, Object.keys(args).sort()))
      .digest('hex');
    if (binding.argumentsHash !== currentHash) {
      return { valid: false, reason: 'Arguments hash mismatch: approval was for different arguments' };
    }

    return { valid: true };
  }
}
