import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildScenarioFromFinding,
  promoteFindingToDataset,
  type FindingPromotionInput,
} from '../src/datasets/findingPromotion.js';
import { computeDatasetHash } from '../src/datasets/manifest.js';
import { loadScenariosFromDir } from '../src/scenarios/loader.js';

const cleanup: string[] = [];

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('finding promotion', () => {
  it('converts confirmed browser replay evidence into a reviewed scenario', () => {
    const scenario = buildScenarioFromFinding(
      finding(),
      'login-regression',
      'reviewer@example.com',
      'Confirmed against staging',
    );

    expect(scenario.target.route).toBe('/login');
    expect(scenario.steps).toEqual([
      { action: 'click', role: 'button', name: 'Sign in', selector: undefined },
    ]);
    expect(scenario.expected).toEqual([
      { assertion: 'url_matches', pattern: '/dashboard' },
    ]);
    expect(scenario.provenance).toMatchObject({
      source: 'finding',
      findingId: 'finding-1',
      reviewerId: 'reviewer@example.com',
    });
  });

  it('writes the scenario, updates the split and pins the new content hash', async () => {
    const datasetDir = await createDataset();
    const result = await promoteFindingToDataset({
      datasetDir,
      finding: finding(),
      reviewerId: 'reviewer@example.com',
      split: 'release',
      scenarioId: 'login-regression',
    });

    const manifest = YAML.parse(
      await readFile(path.join(datasetDir, 'dataset.yaml'), 'utf8'),
    );
    const scenarios = await loadScenariosFromDir(datasetDir);

    expect(result.scenarioId).toBe('login-regression');
    expect(manifest.splits.release).toContain('login-regression');
    expect(manifest.reviewMetadata.reviewerId).toBe('reviewer@example.com');
    expect(manifest.contentHash).toBe(computeDatasetHash(scenarios));
  });

  it('rejects unconfirmed findings and unresolved secret-bearing fills', async () => {
    const datasetDir = await createDataset();
    await expect(promoteFindingToDataset({
      datasetDir,
      finding: { ...finding(), lifecycleState: 'observed' },
      reviewerId: 'reviewer@example.com',
    })).rejects.toThrow('must be confirmed');

    expect(() => buildScenarioFromFinding({
      ...finding(),
      replaySpec: {
        ...finding().replaySpec,
        actions: [{
          type: 'fill',
          locator: { css: '#password' },
          valueRef: 'secret:password',
        }],
      },
    }, 'secret-regression', 'reviewer@example.com')).toThrow('resolve the value');
  });

  it('rejects unknown dataset splits', async () => {
    const datasetDir = await createDataset();
    await expect(promoteFindingToDataset({
      datasetDir,
      finding: finding(),
      reviewerId: 'reviewer@example.com',
      split: 'custom' as never,
    })).rejects.toThrow('Unknown dataset split');
  });
});

function finding(): FindingPromotionInput {
  return {
    findingId: 'finding-1',
    runId: 'run-1',
    title: 'Login redirects incorrectly',
    lifecycleState: 'confirmed-evidence',
    originatingSuiteId: 'auth-smoke',
    expectedState: 'Successful login reaches the dashboard',
    traceId: 'trace-1',
    replaySpec: {
      mode: 'browser',
      setup: [{ type: 'goto', url: 'https://example.test/login' }],
      actions: [{ type: 'click', locator: { role: 'button', name: 'Sign in' } }],
      assertion: { type: 'url', pattern: '/dashboard' },
      linkedArtifactIds: ['screenshot-1'],
    },
  };
}

async function createDataset(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'finding-promotion-'));
  cleanup.push(root);
  const datasetDir = path.join(root, 'dataset');
  await mkdir(path.join(datasetDir, 'scenarios'), { recursive: true });
  await writeFile(path.join(datasetDir, 'dataset.yaml'), YAML.stringify({
    id: 'core',
    version: '1.0.0',
    description: 'Fixture dataset',
    splits: { release: [] },
    provenance: {
      owner: 'qa',
      createdFrom: 'manual',
    },
    contentHash: computeDatasetHash([]),
  }));
  return datasetDir;
}
