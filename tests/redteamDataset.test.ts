/**
 * PRD 06: Dataset-driven red-team evaluation — test suite for dataset
 * loading, selection, and validation.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attackRegistry } from '../src/redteam/attackRegistry.js';
import {
  loadRedTeamManifest,
  loadRedTeamScenarios,
  selectRedTeamAttacks,
  resolveRedTeamAttacks,
  validateRedTeamDataset,
  computeRedTeamContentHash,
} from '../src/redteam/datasetLoader.js';
import type { RedTeamDatasetManifest, RedTeamScenarioFile } from '../src/redteam/datasetLoader.js';

// ---------------------------------------------------------------------------
// Setup: create a temporary red-team dataset for testing
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'redteam-dataset-test-'));
  const datasetDir = join(tmpDir, 'datasets', 'redteam');
  const scenariosDir = join(datasetDir, 'scenarios');
  await mkdir(scenariosDir, { recursive: true });

  // Write manifest
  const manifest: RedTeamDatasetManifest = {
    id: 'redteam',
    version: '1.0.0',
    description: 'Test red-team dataset',
    splits: {
      smoke: ['direct-prompt-override', 'excessive-tool-calls'],
      release: ['direct-prompt-override', 'excessive-tool-calls', 'fabricated-confidence'],
    },
    provenance: {
      owner: 'qa',
      createdFrom: 'manual',
      generator: 'test',
      generatorVersion: '1.0',
      lastReviewDate: '2026-06-20',
    },
    contentHash: 'placeholder',
  };
  await writeFile(join(datasetDir, 'dataset.yaml'), JSON.stringify(manifest));

  // Write scenario files
  const scenarios: RedTeamScenarioFile[] = [
    {
      id: 'direct-prompt-override',
      attackId: 'direct-prompt-override',
      tags: ['prompt-injection', 'smoke'],
      environments: ['fixture'],
      safeForProduction: true,
      requiresFixture: false,
      reviewStatus: 'approved',
      trials: 3,
    },
    {
      id: 'excessive-tool-calls',
      attackId: 'excessive-tool-calls',
      tags: ['tool-exhaustion', 'smoke'],
      environments: ['fixture'],
      safeForProduction: true,
      requiresFixture: false,
      reviewStatus: 'approved',
      trials: 3,
    },
    {
      id: 'fabricated-confidence',
      attackId: 'fabricated-confidence',
      tags: ['trust', 'release'],
      environments: ['fixture', 'staging'],
      safeForProduction: true,
      requiresFixture: false,
      reviewStatus: 'unreviewed',
      trials: 2,
    },
    {
      id: 'unknown-attack',
      attackId: 'does-not-exist-in-registry',
      tags: ['unknown'],
      environments: ['fixture'],
      safeForProduction: true,
      requiresFixture: false,
      reviewStatus: 'unreviewed',
    },
  ];

  for (const scenario of scenarios) {
    await writeFile(
      join(scenariosDir, `${scenario.id}.yaml`),
      JSON.stringify(scenario),
    );
  }
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RedTeamDatasetLoader - Manifest', () => {
  it('loads dataset manifest', async () => {
    const manifest = await loadRedTeamManifest(tmpDir, 'redteam');
    expect(manifest).not.toBeNull();
    expect(manifest!.id).toBe('redteam');
    expect(manifest!.version).toBe('1.0.0');
    expect(manifest!.splits.smoke).toHaveLength(2);
    expect(manifest!.splits.release).toHaveLength(3);
  });

  it('returns null for missing dataset', async () => {
    const manifest = await loadRedTeamManifest(tmpDir, 'nonexistent');
    expect(manifest).toBeNull();
  });
});

describe('RedTeamDatasetLoader - Scenarios', () => {
  it('loads all scenario files', async () => {
    const scenarios = await loadRedTeamScenarios(tmpDir, 'redteam');
    expect(scenarios.length).toBeGreaterThanOrEqual(4);
    const ids = scenarios.map((s) => s.id);
    expect(ids).toContain('direct-prompt-override');
    expect(ids).toContain('excessive-tool-calls');
    expect(ids).toContain('fabricated-confidence');
  });

  it('resolves scenario attack IDs to registry attacks', async () => {
    const scenarios = await loadRedTeamScenarios(tmpDir, 'redteam');
    const { attacks } = resolveRedTeamAttacks(scenarios);

    // Known attacks should resolve
    const resolvedIds = attacks.map((a) => a.id);
    expect(resolvedIds).toContain('direct-prompt-override');
    expect(resolvedIds).toContain('excessive-tool-calls');
    expect(resolvedIds).toContain('fabricated-confidence');

    // Unknown attack should not resolve
    expect(resolvedIds).not.toContain('does-not-exist-in-registry');
  });

  it('filters by review status', async () => {
    const scenarios = await loadRedTeamScenarios(tmpDir, 'redteam');
    const { attacks } = resolveRedTeamAttacks(scenarios, { reviewStatus: 'approved' });

    // Only approved scenarios should resolve
    expect(attacks.length).toBeGreaterThanOrEqual(1);
    const ids = attacks.map((a) => a.id);
    expect(ids).toContain('direct-prompt-override');
    expect(ids).not.toContain('fabricated-confidence'); // unreviewed
  });

  it('selects by split from manifest', async () => {
    const { attacks, scenarios, manifest } = await selectRedTeamAttacks(
      tmpDir,
      'redteam',
      'smoke',
    );
    expect(attacks.length).toBeGreaterThanOrEqual(1);
    expect(manifest).not.toBeNull();

    // Smoke split has direct-prompt-override and excessive-tool-calls
    const ids = attacks.map((a) => a.id);
    expect(ids).toContain('direct-prompt-override');
    expect(ids).toContain('excessive-tool-calls');
  });
});

describe('RedTeamDatasetLoader - Validation', () => {
  it('validates a correct dataset', async () => {
    const manifest = await loadRedTeamManifest(tmpDir, 'redteam');
    const scenarios = await loadRedTeamScenarios(tmpDir, 'redteam');
    expect(manifest).not.toBeNull();

    const errors = validateRedTeamDataset(manifest!, scenarios);
    // The unknown-attack scenario references a non-existent registry attack
    const unknownErrors = errors.filter((e) => e.includes('unknown-attack'));
    expect(unknownErrors.length).toBeGreaterThan(0);
  });
});

describe('RedTeamDatasetLoader - Content Hash', () => {
  it('computes a deterministic content hash', async () => {
    const scenarios = await loadRedTeamScenarios(tmpDir, 'redteam');
    const { attacks } = resolveRedTeamAttacks(scenarios);
    const hash1 = computeRedTeamContentHash(attacks);
    const hash2 = computeRedTeamContentHash(attacks);
    expect(hash1).toEqual(hash2);
    expect(hash1.length).toBe(16);
  });

  it('produces different hashes for different attack selections', async () => {
    const { attacks: attacks1 } = await selectRedTeamAttacks(tmpDir, 'redteam', 'smoke');
    const { attacks: attacks2 } = await selectRedTeamAttacks(tmpDir, 'redteam', 'release');

    const hash1 = computeRedTeamContentHash(attacks1);
    const hash2 = computeRedTeamContentHash(attacks2);

    // Smoke and release splits should produce different hashes
    if (attacks1.length !== attacks2.length) {
      expect(hash1).not.toEqual(hash2);
    }
  });
});
