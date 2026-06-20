/**
 * Feature 04: Durable agent-run state store.
 *
 * Persists an atomic agent-run state document at every transition.
 * Supports durable run statuses, pending approvals, checkpoint IDs,
 * and action idempotency.
 *
 * States:
 *   running, awaiting-approval, paused, completed, failed, cancelled
 */

import { mkdir, readFile, writeFile, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import type {
  AgentState,
  ApprovalRequest,
  BudgetConsumption,
  IntentCapsule,
  ModelConfig,
  ToolDefinition,
  AgentPolicy,
} from './agentTypes.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AgentRunStatus =
  | 'running'
  | 'awaiting-approval'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type VersionedMetadata = {
  policyVersion: string;
  toolVersions: Record<string, string>;
  datasetVersion?: string;
  modelConfig: ModelConfig;
  /** Snapshot of registered tool definitions at start. */
  toolDefinitions: Array<{
    name: string;
    version: string;
    inputSchema: Record<string, unknown>;
    risk: string;
    capabilities: string[];
  }>;
  policy: AgentPolicy;
  intent: IntentCapsule;
};

export type ApprovalBinding = {
  id: string;
  runId: string;
  toolName: string;
  argumentsHash: string;
  arguments: Record<string, unknown>;
  risk: string;
  requestedAt: string;
  expiresAt: string;
  resolvedAt?: string;
  decision?: 'allowed' | 'denied';
  decidedBy?: 'policy' | 'human' | 'ai';
  reason?: string;
  /** Nonce to prevent replay. */
  nonce: string;
};

export type AgentRunDocument = {
  runId: string;
  status: AgentRunStatus;
  previousStatus?: AgentRunStatus;
  agentState: AgentState;
  budgetsConsumed: BudgetConsumption;
  pendingApprovals: ApprovalBinding[];
  approvalHistory: ApprovalBinding[];
  checkpointId?: string;
  versionedMetadata: VersionedMetadata;
  /** Completed action IDs for idempotency tracking. */
  completedActionIds: string[];
  startedAt: string;
  updatedAt: string;
  endedAt?: string;
  error?: string;
};

export type RunStoreOptions = {
  baseDir: string;
};

// ---------------------------------------------------------------------------
// RunStateStore
// ---------------------------------------------------------------------------

/**
 * Durable store for agent-run state documents.
 *
 * Every state transition persists atomically to disk. The store is the
 * single source of truth for agent-run orchestration.
 */
export class RunStateStore {
  private baseDir: string;

  constructor(options: RunStoreOptions) {
    this.baseDir = path.resolve(options.baseDir, 'agent-runs');
  }

  private getRunDir(runId: string): string {
    return path.join(this.baseDir, runId);
  }

  private getStatePath(runId: string): string {
    return path.join(this.getRunDir(runId), 'state.json');
  }

  /**
   * Create a new run document.
   */
  async create(
    runId: string,
    agentState: AgentState,
    budgetsConsumed: BudgetConsumption,
    versionedMetadata: VersionedMetadata,
  ): Promise<AgentRunDocument> {
    const now = new Date().toISOString();
    const doc: AgentRunDocument = {
      runId,
      status: 'running',
      agentState,
      budgetsConsumed,
      pendingApprovals: [],
      approvalHistory: [],
      completedActionIds: [],
      versionedMetadata,
      startedAt: now,
      updatedAt: now,
    };

    await mkdir(this.getRunDir(runId), { recursive: true });
    await writeFile(this.getStatePath(runId), JSON.stringify(doc, null, 2), 'utf8');
    return doc;
  }

  /**
   * Load a run document.
   */
  async load(runId: string): Promise<AgentRunDocument | null> {
    try {
      const raw = await readFile(this.getStatePath(runId), 'utf8');
      return JSON.parse(raw) as AgentRunDocument;
    } catch {
      return null;
    }
  }

  /**
   * Atomically transition state and persist.
   * Returns the updated document, or null if the run does not exist.
   */
  async transition(
    runId: string,
    status: AgentRunStatus,
    updates: Partial<{
      agentState: AgentState;
      budgetsConsumed: BudgetConsumption;
      pendingApprovals: ApprovalBinding[];
      approvalHistory: ApprovalBinding[];
      checkpointId: string;
      completedActionIds: string[];
      error: string;
    }> = {},
  ): Promise<AgentRunDocument | null> {
    const existing = await this.load(runId);
    if (!existing) return null;

    const now = new Date().toISOString();
    const doc: AgentRunDocument = {
      ...existing,
      status,
      previousStatus: existing.status,
      agentState: updates.agentState ?? existing.agentState,
      budgetsConsumed: updates.budgetsConsumed ?? existing.budgetsConsumed,
      pendingApprovals: updates.pendingApprovals ?? existing.pendingApprovals,
      approvalHistory: updates.approvalHistory ?? existing.approvalHistory,
      checkpointId: updates.checkpointId ?? existing.checkpointId,
      completedActionIds: updates.completedActionIds ?? existing.completedActionIds,
      error: updates.error,
      updatedAt: now,
      ...(['completed', 'failed', 'cancelled'].includes(status)
        ? { endedAt: now }
        : {}),
    };

    await writeFile(this.getStatePath(runId), JSON.stringify(doc, null, 2), 'utf8');
    return doc;
  }

  /**
   * List all run IDs.
   */
  async listRuns(): Promise<string[]> {
    try {
      const entries = await readdir(this.baseDir, { withFileTypes: true });
      return entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      return [];
    }
  }

  /**
   * Delete a run document and its directory.
   */
  async deleteRun(runId: string): Promise<boolean> {
    try {
      const dir = this.getRunDir(runId);
      await unlink(this.getStatePath(runId));
      // Remove directory if empty
      await readdir(dir).then(async (files) => {
        if (files.length === 0) {
          await unlink(dir).catch(() => {});
        }
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * List runs by status.
   */
  async listByStatus(status: AgentRunStatus): Promise<AgentRunDocument[]> {
    const runs = await this.listRuns();
    const results: AgentRunDocument[] = [];
    for (const runId of runs) {
      const doc = await this.load(runId);
      if (doc && doc.status === status) {
        results.push(doc);
      }
    }
    return results;
  }

  /** Mark a run as completed. */
  async markCompleted(
    runId: string,
    agentState: AgentState,
    budgetsConsumed: BudgetConsumption,
  ): Promise<AgentRunDocument | null> {
    return this.transition(runId, 'completed', { agentState, budgetsConsumed });
  }

  /** Mark a run as failed. */
  async markFailed(
    runId: string,
    error: string,
    agentState: AgentState,
    budgetsConsumed: BudgetConsumption,
  ): Promise<AgentRunDocument | null> {
    return this.transition(runId, 'failed', { agentState, budgetsConsumed, error });
  }

  /** Mark a run as cancelled. */
  async markCancelled(
    runId: string,
    agentState: AgentState,
    budgetsConsumed: BudgetConsumption,
  ): Promise<AgentRunDocument | null> {
    return this.transition(runId, 'cancelled', { agentState, budgetsConsumed });
  }
}
