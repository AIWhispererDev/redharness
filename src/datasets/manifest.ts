import { createHash } from 'node:crypto';
import type { ScenarioDefinition } from '../scenarios/schema.js';

/**
 * PRD 03: Dataset manifest and versioning.
 *
 * A dataset is a versioned collection of scenarios with defined splits
 * (smoke, release, exploratory, etc.) and provenance metadata.
 */

export type DatasetSplit = 'smoke' | 'release' | 'exploratory' | 'security' | 'adversarial' | 'holdout';

export type HoldoutReleasePolicy = {
  /** Split name for holdout scenarios that are never used in training/validation. */
  holdoutSplit: 'holdout';
  /** Release scenarios that are available for CI/nightly but excluded from training. */
  releaseSplit: 'release';
  /** Whether separate governance approval is required before holdout scenarios are included. */
  requiresGovernanceApproval: boolean;
};

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
  /** Optional holdout/release governance policy. */
  splitGovernance?: HoldoutReleasePolicy;
  /** Optional review metadata — tracks when the dataset was last reviewed and by whom. */
  reviewMetadata?: {
    lastReviewDate: string;
    reviewerId: string;
    reviewNotes?: string;
    nextReviewDue?: string;
  };
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

/**
 * Validate holdout/release split governance: holdout scenarios must not
 * appear in the release split, and the content hash must differ when
 * holdout scenarios are added or removed.
 */
export function validateSplitGovernance(
  manifest: DatasetManifest,
  allScenarioIds: Set<string>,
): string[] {
  const errors: string[] = [];

  if (!manifest.splitGovernance) {
    return errors; // No governance policy defined
  }

  const holdoutIds = manifest.splits[manifest.splitGovernance.holdoutSplit];
  const releaseIds = manifest.splits[manifest.splitGovernance.releaseSplit];

  // Holdout scenarios must not appear in the release split
  if (holdoutIds && releaseIds) {
    const holdoutSet = new Set(holdoutIds);
    for (const id of releaseIds) {
      if (holdoutSet.has(id)) {
        errors.push(`Scenario "${id}" appears in both holdout and release splits`);
      }
    }
  }

  // Holdout scenarios must exist in the dataset
  if (holdoutIds) {
    for (const id of holdoutIds) {
      if (!allScenarioIds.has(id)) {
        errors.push(`Holdout split references unknown scenario "${id}"`);
      }
    }
  }

  // Release scenarios must exist in the dataset
  if (releaseIds) {
    for (const id of releaseIds) {
      if (!allScenarioIds.has(id)) {
        errors.push(`Release split references unknown scenario "${id}"`);
      }
    }
  }

  return errors;
}

/**
 * Check whether the review metadata indicates the dataset is due for review.
 */
export function isReviewDue(manifest: DatasetManifest): boolean {
  if (!manifest.reviewMetadata?.nextReviewDue) return false;
  return new Date(manifest.reviewMetadata.nextReviewDue) <= new Date();
}

/**
 * Track the latest review in the manifest metadata.
 */
export function recordReview(
  manifest: DatasetManifest,
  reviewerId: string,
  notes?: string,
  nextReviewDue?: string,
): DatasetManifest {
  return {
    ...manifest,
    reviewMetadata: {
      lastReviewDate: new Date().toISOString(),
      reviewerId,
      reviewNotes: notes,
      nextReviewDue,
    },
  };
}
