/**
 * PRD 09: Dataset comparison — end-to-end test of running the same dataset
 * against fixture v1 and v2, producing a machine-readable comparison that
 * detects the deliberate v2 regression with trace-linked evidence.
 *
 * Tests:
 * - Dataset manifest loading and content hash validation
 * - Running scenarios from a dataset against v1 and v2 fixtures
 * - Grader version/config persistence in comparison output
 * - Dataset compatibility validation before comparison
 * - Machine-readable comparison detecting the v2 regression
 * - allowEquivalentPaths support in trajectory grader
 * - Text-rule grader integration
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createFixtureApp, resetState, getState } from './fixtures/web-app/index.js';
import { startFixtureWithHealthCheck, type FixtureHandle } from './fixtures/fixtureLifecycle.js';
import { compareRuns, formatComparisonSummary, validateDatasetCompatibility } from '../src/experiments/comparison.js';
import { runScenario } from '../src/scenarios/runner.js';
import { graderRegistry } from '../src/graders/registry.js';
import { DeterministicGrader } from '../src/graders/deterministic.js';
import { StateDiffGrader } from '../src/graders/stateDiff.js';
import { TrajectoryGrader } from '../src/graders/trajectory.js';
import { computeDatasetHash, validateDatasetContent } from '../src/datasets/manifest.js';
import type { ScenarioDefinition, TrajectoryConstraint } from '../src/scenarios/schema.js';
import type { CandidateRunResult, RunComparison } from '../src/experiments/experimentTypes.js';

// ─────────────────────────────────────────────────────────────────────────────
// Setup
// ─────────────────────────────────────────────────────────────────────────────

let v1Fixture: FixtureHandle;
let v2Fixture: FixtureHandle;
let tmpDir: string;

// Register the deterministic grader if not already registered
if (!graderRegistry.has('deterministic')) {
  graderRegistry.register('deterministic', () => new DeterministicGrader());
}
if (!graderRegistry.has('state-diff')) {
  graderRegistry.register('state-diff', (config) => new StateDiffGrader(config as any));
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'dataset-compare-'));
  v1Fixture = await startFixtureWithHealthCheck(() => createFixtureApp(false));
  v2Fixture = await startFixtureWithHealthCheck(() => createFixtureApp(true));
}, 15000);

afterAll(async () => {
  await v1Fixture.stop();
  await v2Fixture.stop();
  await rm(tmpDir, { recursive: true, force: true });
}, 10000);

// ─────────────────────────────────────────────────────────────────────────────
// Dataset scenarios (declarative, same as pack/dataset format)
// ─────────────────────────────────────────────────────────────────────────────

const v1DatasetScenarios: ScenarioDefinition[] = [
  {
    id: 'health-check',
    version: 1,
    title: 'Health endpoint returns ok',
    tags: ['smoke', 'release'],
    target: { kind: 'fixture' },
    setup: [],
    actor: { kind: 'fixture' },
    steps: [{ action: 'capture', as: 'health', selector: '/health' }],
    expected: [{ assertion: 'text_present', text: 'ok' }],
    trials: 2,
  },
  {
    id: 'dashboard-auth-required',
    version: 1,
    title: 'Unauthenticated dashboard returns 401 Sign In Required',
    tags: ['smoke', 'release', 'security'],
    target: { kind: 'fixture' },
    setup: [],
    actor: { kind: 'fixture' },
    steps: [{ action: 'capture', as: 'dashboard', selector: '/dashboard' }],
    expected: [
      { assertion: 'text_present', text: 'Sign In Required' },
    ],
    graders: [
      { id: 'deterministic', type: 'deterministic' },
    ],
    trials: 2,
  },
  {
    id: 'state-counter-increment',
    version: 1,
    title: 'Counter increments on POST /api/increment',
    tags: ['release'],
    target: { kind: 'fixture' },
    setup: [],
    actor: { kind: 'fixture' },
    steps: [
      { action: 'goto', url: '/api/increment' },
      { action: 'capture', as: 'counter', selector: '/api/counter' },
    ],
    expected: [
      { assertion: 'text_present', text: '"counter":1' },
    ],
    graders: [
      { id: 'state-diff', type: 'state-diff', config: { required: ['counter'] } },
    ],
    cleanup: { strategy: 'reset-session' },
    trials: 1,
  },
  {
    id: 'about-page',
    version: 1,
    title: 'About page shows correct version',
    tags: ['smoke'],
    target: { kind: 'fixture' },
    setup: [],
    actor: { kind: 'fixture' },
    steps: [{ action: 'capture', as: 'about', selector: '/about' }],
    expected: [{ assertion: 'text_present', text: 'Fixture Web' }],
    trials: 1,
  },
  {
    id: 'user-profile-v1',
    version: 1,
    title: 'User API returns Alice profile on v1',
    tags: ['release', 'api'],
    target: { kind: 'fixture' },
    setup: [],
    actor: { kind: 'fixture' },
    steps: [
      { action: 'capture', as: 'user', selector: '/api/users/user-1' },
    ],
    expected: [
      { assertion: 'text_present', text: 'Alice' },
      { assertion: 'text_present', text: 'admin' },
    ],
    trajectory: {
      required: [{ tool: 'http_get' }],
      maxToolCalls: 5,
      allowEquivalentPaths: true,
    },
    graders: [
      { id: 'deterministic', type: 'deterministic' },
    ],
    trials: 1,
  },
];

const v1DatasetScenariosWithTraces: ScenarioDefinition[] = v1DatasetScenarios.map((s) => ({
  ...s,
  // Add evidence/trace support — output dir is set per run
}));

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('Dataset manifest', () => {
  it('computes deterministic content hash from scenarios', () => {
    const hash1 = computeDatasetHash(v1DatasetScenarios);
    const hash2 = computeDatasetHash(v1DatasetScenarios);
    expect(hash1).toBe(hash2);
    expect(hash1.length).toBe(32);

    // Changing a scenario changes the hash
    const modified = [...v1DatasetScenarios];
    modified[0] = { ...modified[0], id: 'health-check-modified' };
    const hash3 = computeDatasetHash(modified);
    expect(hash3).not.toBe(hash1);
  });

  it('validates dataset content against manifest', () => {
    const hash = computeDatasetHash(v1DatasetScenarios);
    const errors = validateDatasetContent({ id: 'test', version: '1', description: '', splits: {}, provenance: { owner: 'test', createdFrom: 'manual' }, contentHash: hash }, v1DatasetScenarios);
    expect(errors).toEqual([]);

    const errors2 = validateDatasetContent({ id: 'test', version: '1', description: '', splits: {}, provenance: { owner: 'test', createdFrom: 'manual' }, contentHash: 'wrong-hash' }, v1DatasetScenarios);
    expect(errors2.length).toBe(1);
    expect(errors2[0]).toContain('contentHash mismatch');
  });
});

describe('Dataset compatibility validation', () => {
  it('passes for same dataset ID and content hash', () => {
    const base = createCandidateResult('baseline', { datasetId: 'test-ds', contentHash: 'abc' });
    const cand = createCandidateResult('candidate', { datasetId: 'test-ds', contentHash: 'abc' });
    expect(validateDatasetCompatibility(base, cand)).toEqual([]);
  });

  it('reports mismatch errors', () => {
    const base = createCandidateResult('baseline', { datasetId: 'ds-v1', contentHash: 'abc' });
    const cand = createCandidateResult('candidate', { datasetId: 'ds-v2', contentHash: 'def' });
    const errors = validateDatasetCompatibility(base, cand);
    expect(errors.length).toBeGreaterThanOrEqual(2);
    expect(errors.some((e) => e.includes('Dataset ID'))).toBe(true);
    expect(errors.some((e) => e.includes('contentHash'))).toBe(true);
  });
});

describe('Trajectory grader allowEquivalentPaths', () => {
  it('allows reordered tools when allowEquivalentPaths is true', async () => {
    const constraint: TrajectoryConstraint = {
      ordering: [{ before: 'http_get', after: 'wait' }],
      allowEquivalentPaths: true,
    };
    const grader = new TrajectoryGrader(constraint);

    // Tool calls in reverse order — should still pass since allowEquivalentPaths is true
    const grade = await grader.grade({
      response: '',
      target: 'trajectory',
      context: { toolCalls: ['wait', 'http_get'] },
    });
    expect(grade.status).toBe('passed');
  });

  it('fails reordered tools when allowEquivalentPaths is false', async () => {
    const constraint: TrajectoryConstraint = {
      ordering: [{ before: 'http_get', after: 'wait' }],
      allowEquivalentPaths: false,
    };
    const grader = new TrajectoryGrader(constraint);

    const grade = await grader.grade({
      response: '',
      target: 'trajectory',
      context: { toolCalls: ['wait', 'http_get'] },
    });
    // 'wait' appears after 'http_get' in the list, so beforeIdx > afterIdx
    expect(grade.status).toBe('failed');
  });
});

describe('Text-rule grader integration', () => {
  it('resolves rule-set grader from registry', async () => {
    const grader = graderRegistry.create('deterministic');
    expect(grader.id).toBe('deterministic');
    expect(grader.version).toBeTruthy();
  });

  it('resolves state-diff grader from registry', async () => {
    const grader = graderRegistry.create('state-diff');
    expect(grader.id).toBe('state-diff');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// End-to-end: run dataset against v1 and v2, produce comparison
// ─────────────────────────────────────────────────────────────────────────────

describe('Dataset comparison v1 vs v2', () => {
  let v1Result: CandidateRunResult;
  let v2Result: CandidateRunResult;

  it('runs the v1 dataset and produces passing results', async () => {
    const outputDir = join(tmpDir, 'v1-run');
    await mkdir(outputDir, { recursive: true });
    const suiteResults: CandidateRunResult['suiteResults'] = [];

    for (const scenario of v1DatasetScenarios) {
      const graders = (scenario.graders ?? []).map((def) =>
        graderRegistry.create(def.type, def.config),
      );

      const result = await runScenario(scenario, {
        packDir: tmpDir,
        baseUrl: v1Fixture.baseUrl,
        headless: true,
        outputDir,
        graders,
      });

      suiteResults.push({
        suiteId: scenario.id,
        scenarioId: scenario.id,
        status: result.status,
        metrics: result.graderVersions.map((gv) => ({
          name: `grader_${gv.id}`,
          value: result.status === 'passed' ? 1 : 0,
          sampleSize: result.trials.length,
        })),
        graderVersions: result.graderVersions,
      });
    }

    v1Result = {
      label: 'v1',
      config: {
        label: 'v1',
        metadata: { datasetId: 'fixture-web-ds', datasetVersion: '1', contentHash: computeDatasetHash(v1DatasetScenarios) },
      },
      runId: `v1-run-${Date.now()}`,
      status: suiteResults.every((r) => r.status === 'passed') ? 'passed' : 'failed',
      graderVersions: suiteResults.flatMap((r) => r.graderVersions ?? []),
      suiteResults,
    };

    // Track failures — dashboard-auth-required passes on v1 (it checks for "Sign In Required")
    const failures = suiteResults.filter((r) => r.status !== 'passed');
    expect(failures).toEqual([]);
  }, 60000);

  it('runs the same dataset against v2 and detects the dashboard regression', async () => {
    const outputDir = join(tmpDir, 'v2-run');
    await mkdir(outputDir, { recursive: true });
    const suiteResults: CandidateRunResult['suiteResults'] = [];

    for (const scenario of v1DatasetScenarios) {
      const graders = (scenario.graders ?? []).map((def) =>
        graderRegistry.create(def.type, def.config),
      );

      const result = await runScenario(scenario, {
        packDir: tmpDir,
        baseUrl: v2Fixture.baseUrl,
        headless: true,
        outputDir,
        graders,
      });

      suiteResults.push({
        suiteId: scenario.id,
        scenarioId: scenario.id,
        status: result.status,
        metrics: result.graderVersions.map((gv) => ({
          name: `grader_${gv.id}`,
          value: result.status === 'passed' ? 1 : 0,
          sampleSize: result.trials.length,
        })),
        graderVersions: result.graderVersions,
      });
    }

    v2Result = {
      label: 'v2',
      config: {
        label: 'v2',
        metadata: { datasetId: 'fixture-web-ds', datasetVersion: '1', contentHash: computeDatasetHash(v1DatasetScenarios) },
      },
      runId: `v2-run-${Date.now()}`,
      status: suiteResults.every((r) => r.status === 'passed') ? 'passed' : 'failed',
      graderVersions: suiteResults.flatMap((r) => r.graderVersions ?? []),
      suiteResults,
    };

    // The dashboard-auth-required scenario should FAIL on v2 because v2
    // returns 403 "Access Denied" instead of 401 "Sign In Required"
    const dashboardScenario = suiteResults.find((r) => r.scenarioId === 'dashboard-auth-required');
    expect(dashboardScenario).toBeTruthy();
    expect(dashboardScenario!.status).toBe('failed');

    // Other scenarios should still pass
    const healthCheck = suiteResults.find((r) => r.scenarioId === 'health-check');
    expect(healthCheck!.status).toBe('passed');

    // Overall v2 run is marked as failed
    expect(v2Result.status).toBe('failed');
  }, 60000);

  it('produces a machine-readable comparison detecting the v2 regression with grader versions', async () => {
    expect(v1Result).toBeTruthy();
    expect(v2Result).toBeTruthy();

    const comparison = compareRuns(v1Result, v2Result, {
      baselineLabel: 'v1',
      candidateLabel: 'v2',
    });

    // Verify structure
    expect(comparison.baselineRunId).toBe(v1Result.runId);
    expect(comparison.candidateRunId).toBe(v2Result.runId);
    expect(comparison.datasetId).toBe('fixture-web-ds');
    expect(comparison.datasetVersion).toBe('1');

    // Verify regression detection
    expect(comparison.overallRegressed).toBe(true);
    expect(comparison.scenarioComparisons.length).toBeGreaterThanOrEqual(5);

    // The dashboard-auth-required scenario must be marked as regressed
    const dashboardComp = comparison.scenarioComparisons.find((s) => s.scenarioId === 'dashboard-auth-required');
    expect(dashboardComp).toBeTruthy();
    expect(dashboardComp!.regressed).toBe(true);
    expect(dashboardComp!.baselineStatus).toBe('passed');
    expect(dashboardComp!.candidateStatus).toBe('failed');
    expect(dashboardComp!.statusChanged).toBe(true);

    // Should have a new finding for the regression
    expect(dashboardComp!.newFindings.length).toBeGreaterThanOrEqual(1);
    expect(dashboardComp!.newFindings[0].severity).toBe('high');

    // Other scenarios should not be regressed
    const healthComp = comparison.scenarioComparisons.find((s) => s.scenarioId === 'health-check');
    expect(healthComp!.regressed).toBe(false);

    // Verify grader versions are in the comparison
    expect(comparison.graderVersions).toBeTruthy();
    expect(comparison.graderVersions!.length).toBeGreaterThanOrEqual(1);

    // Verify scenario-level grader versions
    const dashboardCompWithGrader = comparison.scenarioComparisons.find(
      (s) => s.scenarioId === 'dashboard-auth-required',
    );
    expect(dashboardCompWithGrader!.graderVersions).toBeTruthy();
    expect(dashboardCompWithGrader!.graderVersions!.length).toBeGreaterThanOrEqual(1);
    expect(dashboardCompWithGrader!.graderVersions![0].id).toBe('deterministic');

    // Produce a readable summary
    const summary = formatComparisonSummary(comparison);
    expect(summary).toContain('REGRESSION DETECTED');
    expect(summary).toContain('dashboard-auth-required');

    // Persist comparison JSON
    const comparisonPath = join(tmpDir, 'v1-v2-comparison.json');
    await writeFile(comparisonPath, JSON.stringify(comparison, null, 2), 'utf8');
    const persisted = JSON.parse(readFileSync(comparisonPath, 'utf8')) as RunComparison;
    expect(persisted.overallRegressed).toBe(true);
    expect(persisted.graderVersions).toBeTruthy();
  });

  it('validates dataset compatibility before comparison', async () => {
    expect(v1Result).toBeTruthy();
    expect(v2Result).toBeTruthy();

    // Both use the same dataset — should pass
    const errors = validateDatasetCompatibility(v1Result, v2Result);
    expect(errors).toEqual([]);

    // Mismatched datasets — should fail
    const mismatchedBase = { ...v1Result, config: { ...v1Result.config, metadata: { datasetId: 'different-ds', contentHash: 'xxx' } } };
    const mismatchedCand = { ...v2Result, config: { ...v2Result.config, metadata: { datasetId: 'other-ds', contentHash: 'yyy' } } };
    const errors2 = validateDatasetCompatibility(mismatchedBase, mismatchedCand);
    expect(errors2.length).toBeGreaterThanOrEqual(2);
  });

  it('verifies trace evidence files exist on failure scenarios', async () => {
    // The scenario runner writes failure evidence to outputDir
    const outputDir = join(tmpDir, 'v2-run');
    expect(outputDir).toBeTruthy();

    // Check that failure evidence was produced for the dashboard regression
    const dashboardEvidenceDir = join(outputDir, 'dashboard-auth-required');
    // The runner creates trial-N/failure.png and trial-N/failure.json
    const trialDirs = readdirSync(dashboardEvidenceDir).filter((d) => d.startsWith('trial-'));
    expect(trialDirs.length).toBeGreaterThanOrEqual(1);

    for (const trialDir of trialDirs) {
      const trialPath = join(dashboardEvidenceDir, trialDir);
      const files = readdirSync(trialPath);
      // At minimum, failure.json should exist
      expect(files).toContain('failure.json');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function createCandidateResult(
  label: string,
  metadata: Record<string, unknown>,
): CandidateRunResult {
  return {
    label,
    config: { label, metadata: metadata as Record<string, unknown> },
    runId: `run-${label}-${Date.now()}`,
    status: 'passed',
    suiteResults: [],
  };
}
