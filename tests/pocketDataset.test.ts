import { describe, expect, it, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

import { computeDatasetHash, validateSplitRefs, validateSplitGovernance, isReviewDue, recordReview } from '../src/datasets/manifest.js';
import type { DatasetManifest } from '../src/datasets/manifest.js';
import type { ScenarioDefinition } from '../src/scenarios/schema.js';
import { loadPackFromDir } from '../src/pack.js';

const packDir = fileURLToPath(new URL('../packs/pocket-socrates', import.meta.url));
const datasetDir = join(packDir, 'datasets', 'core');

let manifest: DatasetManifest;
let scenarios: ScenarioDefinition[];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadDataset(): { manifest: DatasetManifest; scenarios: ScenarioDefinition[] } {
  const manifestPath = join(datasetDir, 'dataset.yaml');
  const manifestRaw = readFileSync(manifestPath, 'utf-8');
  const manifest = parse(manifestRaw) as DatasetManifest;

  const scenariosDir = join(datasetDir, 'scenarios');
  const scenarioFiles = readdirSync(scenariosDir).filter(
    (f) => f.endsWith('.yaml') || f.endsWith('.yml'),
  );
  const scenarios = scenarioFiles.map((f) => {
    const raw = readFileSync(join(scenariosDir, f), 'utf-8');
    return parse(raw) as ScenarioDefinition;
  });

  return { manifest, scenarios };
}

// ---------------------------------------------------------------------------
// Dataset structure tests
// ---------------------------------------------------------------------------

describe('Pocket Socrates core dataset', () => {
  beforeAll(() => {
    const loaded = loadDataset();
    manifest = loaded.manifest;
    scenarios = loaded.scenarios;
  });

  describe('manifest integrity', () => {
    it('has a valid dataset manifest', () => {
      expect(manifest.id).toBe('core');
      expect(manifest.version).toBeDefined();
      expect(manifest.contentHash).toBeDefined();
      expect(manifest.provenance.owner).toBe('qa');
    });

    it('has scenario files that parse correctly', () => {
      expect(scenarios.length).toBeGreaterThanOrEqual(5);
      for (const s of scenarios) {
        expect(s.id).toBeDefined();
        expect(s.title).toBeDefined();
        expect(Array.isArray(s.tags)).toBe(true);
        expect(s.target).toBeDefined();
        expect(s.actor).toBeDefined();
      }
    });

    it('all scenario IDs referenced in splits exist', () => {
      const ids = new Set(scenarios.map((s) => s.id));
      const errors = validateSplitRefs(manifest, ids);
      expect(errors).toHaveLength(0);
    });

    it('computes correct content hash', () => {
      const actualHash = computeDatasetHash(scenarios);
      expect(actualHash).toBe(manifest.contentHash);
    });
  });

  describe('split governance', () => {
    it('has a holdout split for live-only scenarios', () => {
      expect(manifest.splits.holdout).toBeDefined();
      expect(manifest.splits.holdout!.length).toBeGreaterThan(0);
    });

    it('has a release split for CI scenarios', () => {
      expect(manifest.splits.release).toBeDefined();
      expect(manifest.splits.release!.length).toBeGreaterThanOrEqual(3);
    });

    it('validates holdout does not leak into release', () => {
      if (manifest.splitGovernance) {
        const ids = new Set(scenarios.map((s) => s.id));
        const errors = validateSplitGovernance(manifest, ids);
        expect(errors).toHaveLength(0);
      }
    });

    it('records review metadata', () => {
      expect(manifest.reviewMetadata).toBeDefined();
      expect(manifest.reviewMetadata?.reviewerId).toBeDefined();
      expect(manifest.reviewMetadata?.nextReviewDue).toBeDefined();
    });

    it('detects when dataset is due for review', () => {
      // The current date is 2026-06-20 and nextReviewDue is 2026-07-20
      // so it should not be due
      expect(isReviewDue(manifest)).toBe(false);
    });

    it('recordReview updates the manifest', () => {
      const updated = recordReview(manifest, 'tester-1', 'Reviewed all scenarios', '2026-08-01T00:00:00.000Z');
      expect(updated.reviewMetadata?.reviewerId).toBe('tester-1');
      expect(updated.reviewMetadata?.reviewNotes).toBe('Reviewed all scenarios');
      expect(updated.reviewMetadata?.nextReviewDue).toBe('2026-08-01T00:00:00.000Z');
    });
  });

  describe('scenario tags and splits', () => {
    it('has scenarios tagged for smoke', () => {
      const smokeTagged = scenarios.filter((s) => s.tags.includes('smoke'));
      expect(smokeTagged.length).toBeGreaterThanOrEqual(3);
    });

    it('has scenarios tagged for release', () => {
      const releaseTagged = scenarios.filter((s) => s.tags.includes('release'));
      expect(releaseTagged.length).toBeGreaterThanOrEqual(3);
    });

    it('has live-only scenarios in holdout', () => {
      const holdoutScenarios = manifest.splits.holdout ?? [];
      expect(holdoutScenarios.length).toBeGreaterThan(0);
    });

    it('live-only scenarios are excluded from default CI splits', () => {
      const holdoutIds = new Set(manifest.splits.holdout ?? []);
      const smokeIds = new Set(manifest.splits.smoke ?? []);
      const releaseIds = new Set(manifest.splits.release ?? []);

      for (const id of holdoutIds) {
        expect(smokeIds.has(id)).toBe(false);
        if (manifest.splitGovernance) {
          expect(releaseIds.has(id)).toBe(false);
        }
      }
    });

    it('AI quality scenario is in holdout split', () => {
      const holdoutIds = manifest.splits.holdout ?? [];
      expect(holdoutIds).toContain('ai-response-style');
    });

    it('public-landing is in smoke split', () => {
      const smokeIds = manifest.splits.smoke ?? [];
      expect(smokeIds).toContain('public-landing');
    });
  });

  describe('rubric definitions', () => {
    it('has rubric files in the dataset', () => {
      const rubricsDir = join(datasetDir, 'rubrics');
      const rubricFiles = readdirSync(rubricsDir).filter((f) => f.endsWith('.md'));
      expect(rubricFiles.length).toBeGreaterThanOrEqual(1);
    });

    it('ai-quality rubric exists and has expected dimensions', () => {
      const rubricPath = join(datasetDir, 'rubrics', 'ai-quality.md');
      const content = readFileSync(rubricPath, 'utf-8');
      expect(content).toContain('empathy');
      expect(content).toContain('helpfulness');
      expect(content).toContain('safety');
      expect(content).toContain('clarity');
      expect(content).toContain('Critical Failure Conditions');
    });
  });

  describe('provenance', () => {
    it('records provenance metadata', () => {
      expect(manifest.provenance.createdFrom).toBe('manual');
    });
  });
});

// ---------------------------------------------------------------------------
// Determinstic vs live requirements
// ---------------------------------------------------------------------------

describe('Dataset scenario requirements', () => {
  let manifest: DatasetManifest;
  let scenarios: ScenarioDefinition[];

  beforeAll(() => {
    const loaded = loadDataset();
    manifest = loaded.manifest;
    scenarios = loaded.scenarios;
  });

  it('segregates scenarios requiring live model access', () => {
    // Scenarios tagged "live-only" require model access and should be in holdout
    const liveOnly = scenarios.filter((s) => s.tags.includes('live-only'));
    const holdoutIds = new Set(manifest.splits.holdout ?? []);

    for (const s of liveOnly) {
      expect(holdoutIds.has(s.id)).toBe(true);
    }
  });

  it('documents deterministic scenarios that do not require live access', () => {
    // Scenarios in the release split should not have live-only tag
    const releaseIds = new Set(manifest.splits.release ?? []);
    const releaseScenarios = scenarios.filter((s) => releaseIds.has(s.id));

    for (const s of releaseScenarios) {
      expect(s.tags.includes('live-only')).toBe(false);
    }
  });
});
