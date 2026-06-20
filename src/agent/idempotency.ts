/**
 * Feature 04: Action idempotency — prevents repeated side effects.
 *
 * Every completed mutation is tracked by a composite action ID derived
 * from the tool call, arguments hash, and run turn. After checkpoint
 * resume, completed actions are preserved and must not be re-executed.
 */

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CompletedAction = {
  actionId: string;
  toolName: string;
  argumentsHash: string;
  turn: number;
  completedAt: string;
  result: 'success' | 'failure';
  /** Mutation intent — 'read', 'write', 'high-impact'. */
  mutationIntent: string;
};

export type IdempotencyStoreOptions = {
  /** Maximum number of completed actions to retain in memory. */
  maxActions?: number;
};

// ---------------------------------------------------------------------------
// IdempotencyStore
// ---------------------------------------------------------------------------

/**
 * Tracks completed actions to prevent repeated side effects.
 *
 * An action ID is a SHA-256 hash of `toolName || argumentsHash || runId`.
 * After checkpoint resume, the store is populated from the persisted state.
 * Tools marked as non-idempotent (e.g., browser state) will not block
 * re-execution but will be flagged.
 */
export class IdempotencyStore {
  private completedActions: Map<string, CompletedAction> = new Map();
  private maxActions: number;

  /** Action IDs that should NEVER be re-executed. */
  private immutableActionIds: Set<string> = new Set();

  constructor(options: IdempotencyStoreOptions = {}) {
    this.maxActions = options.maxActions ?? 1000;
  }

  /**
   * Compute a deterministic action ID from a tool call.
   */
  static computeActionId(
    toolName: string,
    args: Record<string, unknown>,
    runId: string,
  ): string {
    const hash = createHash('sha256');
    hash.update(toolName);
    hash.update(JSON.stringify(args, Object.keys(args).sort()));
    hash.update(runId);
    return hash.digest('hex');
  }

  /**
   * Record a completed action.
   */
  record(
    toolName: string,
    args: Record<string, unknown>,
    runId: string,
    turn: number,
    result: 'success' | 'failure',
    mutationIntent: string = 'write',
  ): CompletedAction {
    const actionId = IdempotencyStore.computeActionId(toolName, args, runId);
    const action: CompletedAction = {
      actionId,
      toolName,
      argumentsHash: createHash('sha256')
        .update(JSON.stringify(args, Object.keys(args).sort()))
        .digest('hex'),
      turn,
      completedAt: new Date().toISOString(),
      result,
      mutationIntent,
    };

    this.completedActions.set(actionId, action);

    // Immutable if it was a successful mutation
    if (result === 'success' && mutationIntent !== 'read') {
      this.immutableActionIds.add(actionId);
    }

    // Evict oldest if over limit
    if (this.completedActions.size > this.maxActions) {
      const oldest = this.completedActions.keys().next().value;
      if (oldest) this.completedActions.delete(oldest);
    }

    return action;
  }

  /**
   * Check if an action has already been completed.
   */
  isCompleted(toolName: string, args: Record<string, unknown>, runId: string): boolean {
    const actionId = IdempotencyStore.computeActionId(toolName, args, runId);
    return this.immutableActionIds.has(actionId);
  }

  /**
   * Check if an action is immutable (must not repeat).
   */
  isImmutable(toolName: string, args: Record<string, unknown>, runId: string): boolean {
    const actionId = IdempotencyStore.computeActionId(toolName, args, runId);
    return this.immutableActionIds.has(actionId);
  }

  /**
   * Get a completed action by its ID.
   */
  getByActionId(actionId: string): CompletedAction | undefined {
    return this.completedActions.get(actionId);
  }

  /**
   * Restore from a list of completed actions (e.g., from checkpoint resume).
   */
  restore(actions: CompletedAction[]): void {
    for (const action of actions) {
      this.completedActions.set(action.actionId, action);
      if (action.result === 'success' && action.mutationIntent !== 'read') {
        this.immutableActionIds.add(action.actionId);
      }
    }
  }

  /**
   * Get all completed action IDs.
   */
  getAllActionIds(): string[] {
    return Array.from(this.completedActions.keys());
  }

  /**
   * Get all immutable action IDs.
   */
  getImmutableActionIds(): string[] {
    return Array.from(this.immutableActionIds);
  }

  /**
   * Get all completed actions for serialization.
   */
  getAllCompletedActions(): CompletedAction[] {
    return Array.from(this.completedActions.values());
  }

  /**
   * Clear all state (test cleanup).
   */
  clear(): void {
    this.completedActions.clear();
    this.immutableActionIds.clear();
  }
}

/**
 * Tools that manage external state that cannot be restored.
 * These are always flagged, never blocked by idempotency.
 */
export const NON_RESTORABLE_TOOLS = new Set([
  'browser_navigate',
  'browser_click',
  'browser_fill',
  'browser_screenshot',
  'browser_observe',
]);
