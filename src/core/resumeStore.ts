import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { RunManifest, SuiteResult, RunConfigHash, SuiteResultSummary } from './runTypes.js';
import type { ExecutionStatus } from './status.js';
import { redactDeep } from '../trace/redaction.js';

/**
 * Resume store manages persistent run manifests and supports resuming
 * incomplete or retryable runs.
 */

/** Compute a deterministic config hash for resume compatibility checks. */
export function computeConfigHash(config: RunConfigHash): string {
  const hash = createHash('sha256');
  // Stable serialization: sort all keys recursively
  const stable = JSON.stringify(config, (_, value) =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
      : value,
  );
  hash.update(stable);
  return hash.digest('hex').slice(0, 16);
}

/** Load a run manifest from a run directory. */
export async function loadManifest(runDir: string): Promise<RunManifest | null> {
  try {
    const raw = await readFile(path.join(runDir, 'run.json'), 'utf8');
    return JSON.parse(raw) as RunManifest;
  } catch {
    return null;
  }
}

/** Save a run manifest to a run directory. */
export async function saveManifest(runDir: string, manifest: RunManifest): Promise<void> {
  await mkdir(runDir, { recursive: true });
  const { result } = redactDeep(manifest);
  await writeFile(
    path.join(runDir, 'run.json'),
    JSON.stringify(result, null, 2),
    'utf8',
  );
}

/** Determine which suites need to run in a resumed run. */
export function getResumeTargets(
  manifest: RunManifest,
  currentConfigHash: string,
): { runId: string; pendingSuiteIds: string[]; skippedFromRetry: string[] } {
  // Config hash mismatch: do not resume
  if (manifest.configHash && manifest.configHash !== currentConfigHash) {
    throw new Error(
      `Config hash mismatch: cannot resume with different configuration. ` +
      `Stored ${manifest.configHash}, current ${currentConfigHash}.`,
    );
  }

  const pendingSuiteIds: string[] = [];
  const skippedFromRetry: string[] = [];
  const completedIds = new Set(
    manifest.suiteResults
      .filter((sr) => sr.status === 'passed' || sr.status === 'failed')
      .map((sr) => sr.suiteId),
  );
  const retryableIds = new Set(
    manifest.suiteResults
      .filter((sr) => sr.status === 'error' || sr.status === 'cancelled')
      .map((sr) => sr.suiteId),
  );

  for (const sr of manifest.suiteResults) {
    if (completedIds.has(sr.suiteId)) {
      skippedFromRetry.push(sr.suiteId);
    } else if (retryableIds.has(sr.suiteId)) {
      pendingSuiteIds.push(sr.suiteId);
    } else {
      // skipped suites: re-evaluate
      pendingSuiteIds.push(sr.suiteId);
    }
  }

  // Also include suites that were in the selection but have no result yet
  const allSelected = new Set(manifest.selection.suites);
  for (const sr of manifest.suiteResults) {
    allSelected.delete(sr.suiteId);
  }
  pendingSuiteIds.push(...allSelected);

  return { runId: manifest.runId, pendingSuiteIds, skippedFromRetry };
}

/** Merge new suite results into an existing manifest in-place. */
export function mergeResultsIntoManifest(
  manifest: RunManifest,
  newResults: SuiteResultSummary[],
  overwrite: boolean = false,
): void {
  const existing = new Map(
    manifest.suiteResults.map((sr) => [sr.suiteId, sr]),
  );

  for (const result of newResults) {
    if (overwrite || !existing.has(result.suiteId)) {
      existing.set(result.suiteId, result);
    }
  }

  manifest.suiteResults = Array.from(existing.values());
}

/** Apply the given status as the run-level aggregate. */
export function updateRunStatus(
  manifest: RunManifest,
  status: ExecutionStatus,
  endedAt?: string,
  durationMs?: number,
): void {
  manifest.status = status;
  if (endedAt) manifest.endedAt = endedAt;
  if (durationMs !== undefined) manifest.durationMs = durationMs;
}
