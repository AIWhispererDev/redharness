import { createHash } from 'node:crypto';
import type { ScenarioDefinition } from '../scenarios/schema.js';

/**
 * PRD 03: Dataset manifest and versioning.
 *
 * A dataset is a versioned collection of scenarios with defined splits
 * (smoke, release, exploratory, etc.) and provenance metadata.
 */

export type DatasetSplit = 'smoke' | 'release' | 'exploratory' | 'security' | 'adversarial' | 'holdout';

export type DatasetManifest = {
  id: string;
  version: string;
  description: string;
  splits: Partial<Record<DatasetSplit, string[]>>;
  provenance: {
    owner: string;
    createdFrom: 'manual' | 'generated' | 'imported';
    generator?: string;
    generatorVersion?: string;
    lastReviewDate?: string;
  };
  /** Content hash identifies the exact dataset version used by a run. */
  contentHash: string;
};

/** Compute a deterministic content hash from scenario definitions. */
export function computeDatasetHash(scenarios: ScenarioDefinition[]): string {
  const hash = createHash('sha256');
  // Stable serialization: sort by scenario id, then recursively sort all keys
  const stable = (v: unknown): unknown => {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, val]) => [k, stable(val)]),
      );
    }
    if (Array.isArray(v)) return v.map(stable);
    return v;
  };
  const sorted = [...scenarios]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((s) => JSON.stringify(stable(s)));
  hash.update(sorted.join('\n'));
  return hash.digest('hex').slice(0, 32);
}

/** Validate that all scenario IDs referenced in splits exist. */
export function validateSplitRefs(manifest: DatasetManifest, scenarioIds: Set<string>): string[] {
  const errors: string[] = [];
  for (const [split, ids] of Object.entries(manifest.splits)) {
    if (!ids) continue;
    for (const id of ids) {
      if (!scenarioIds.has(id)) {
        errors.push(`Split "${split}" references unknown scenario "${id}"`);
      }
    }
  }
  return errors;
}

/** Validate that the manifest pins the exact current scenario content. */
export function validateDatasetContent(
  manifest: DatasetManifest,
  scenarios: ScenarioDefinition[],
): string[] {
  const actual = computeDatasetHash(scenarios);
  if (!manifest.contentHash) {
    return [`Dataset manifest is missing contentHash; expected ${actual}`];
  }
  return manifest.contentHash === actual
    ? []
    : [`Dataset contentHash mismatch: manifest=${manifest.contentHash}, actual=${actual}`];
}

/** Get the scenario IDs for a given split. */
export function getSplitScenarios(manifest: DatasetManifest, split: DatasetSplit): string[] {
  return manifest.splits[split] ?? [];
}
