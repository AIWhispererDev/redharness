/**
 * PRD 04: Checkpoint and resume — durable agent state snapshots.
 *
 * Checkpoints are taken at:
 * - turn boundaries
 * - before approved high-impact actions
 * - after successful state-changing tools
 * - configurable intervals
 */

import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { Checkpoint, AgentState, BudgetConsumption } from './agentTypes.js';

export type CheckpointManagerOptions = {
  baseDir: string;
  policyVersion: string;
  toolVersions: Record<string, string>;
  datasetVersion?: string;
};

/**
 * Manages checkpoint persistence for agent runs.
 */
export class CheckpointManager {
  private baseDir: string;
  private policyVersion: string;
  private toolVersions: Record<string, string>;
  private datasetVersion?: string;
  private checkpoints: Map<string, Checkpoint> = new Map();

  constructor(options: CheckpointManagerOptions) {
    this.baseDir = path.resolve(options.baseDir, 'checkpoints');
    this.policyVersion = options.policyVersion;
    this.toolVersions = options.toolVersions;
    this.datasetVersion = options.datasetVersion;
  }

  /** Save a checkpoint for the given agent state. */
  async save(
    agentState: AgentState,
    budgetsConsumed: BudgetConsumption,
  ): Promise<Checkpoint> {
    const id = `ckpt-${agentState.runId}-${agentState.turn}-${Date.now().toString(36)}`;
    const checkpoint: Checkpoint = {
      id,
      runId: agentState.runId,
      agentState,
      budgetsConsumed,
      policyVersion: this.policyVersion,
      toolVersions: this.toolVersions,
      datasetVersion: this.datasetVersion,
      createdAt: new Date().toISOString(),
    };

    this.checkpoints.set(id, checkpoint);

    // Persist to disk
    await mkdir(this.baseDir, { recursive: true });
    await writeFile(
      path.join(this.baseDir, `${id}.json`),
      JSON.stringify(checkpoint, null, 2),
      'utf8',
    );

    return checkpoint;
  }

  /** Load a checkpoint by ID. */
  async load(checkpointId: string): Promise<Checkpoint | null> {
    // Check in-memory first
    const cached = this.checkpoints.get(checkpointId);
    if (cached) return cached;

    // Try disk
    try {
      const raw = await readFile(path.join(this.baseDir, `${checkpointId}.json`), 'utf8');
      const cp = JSON.parse(raw) as Checkpoint;
      this.checkpoints.set(checkpointId, cp);
      return cp;
    } catch {
      return null;
    }
  }

  /** Load the latest checkpoint for a run. */
  async loadLatest(runId: string): Promise<Checkpoint | null> {
    try {
      const files = await readdir(this.baseDir);
      const runCheckpoints = files
        .filter((f) => f.startsWith(`ckpt-${runId}-`))
        .sort()
        .reverse();

      if (runCheckpoints.length === 0) return null;

      const latest = runCheckpoints[0];
      const raw = await readFile(path.join(this.baseDir, latest), 'utf8');
      const cp = JSON.parse(raw) as Checkpoint;
      this.checkpoints.set(cp.id, cp);
      return cp;
    } catch {
      return null;
    }
  }

  /** Validate that a checkpoint's versions match current config. */
  validateVersions(checkpoint: Checkpoint): { valid: boolean; issues: string[] } {
    const issues: string[] = [];

    if (checkpoint.policyVersion !== this.policyVersion) {
      issues.push(
        `Policy version mismatch: checkpoint=${checkpoint.policyVersion}, current=${this.policyVersion}`,
      );
    }

    for (const [tool, version] of Object.entries(checkpoint.toolVersions)) {
      const currentVersion = this.toolVersions[tool];
      if (currentVersion && currentVersion !== version) {
        issues.push(
          `Tool "${tool}" version mismatch: checkpoint=${version}, current=${currentVersion}`,
        );
      }
    }

    return { valid: issues.length === 0, issues };
  }

  /** List checkpoint IDs for a run. */
  async listRunCheckpoints(runId: string): Promise<string[]> {
    try {
      const files = await readdir(this.baseDir);
      return files
        .filter((f) => f.startsWith(`ckpt-${runId}-`))
        .sort();
    } catch {
      return [];
    }
  }

  /** Delete checkpoints for a run (cleanup). */
  async deleteRunCheckpoints(runId: string): Promise<number> {
    const toDelete = await this.listRunCheckpoints(runId);
    const { unlink } = await import('node:fs/promises');
    for (const file of toDelete) {
      try {
        await unlink(path.join(this.baseDir, file));
      } catch {
        // Ignore cleanup errors
      }
      this.checkpoints.delete(file.replace('.json', ''));
    }
    return toDelete.length;
  }
}
