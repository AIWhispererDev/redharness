import { describe, it, expect } from 'vitest';
import { compareRuns, formatComparisonSummary } from '../src/experiments/comparison.js';
import { evaluateGates } from '../src/experiments/gates.js';
import { RunCatalog } from '../src/store/catalog.js';
import { generateJUnitXml } from '../src/reporters/junit.js';
import { generateSarifReport } from '../src/reporters/sarif.js';
import { generateGitHubStepSummary, generateGitHubAnnotations } from '../src/reporters/github.js';
import type { CandidateRunResult, RegressionGate, RunComparison } from '../src/experiments/experimentTypes.js';
import type { RunManifest } from '../src/core/runTypes.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';

describe('RunComparison', () => {
  const baseline: CandidateRunResult = {
    label: 'v1',
    config: { label: 'v1' },
    runId: 'baseline-001',
    status: 'passed',
    suiteResults: [
      {
        suiteId: 's1',
        scenarioId: 's1',
        status: 'passed',
        metrics: [{ name: 'success_rate', value: 1.0, sampleSize: 5 }],
      },
      {
        suiteId: 's2',
        scenarioId: 's2',
        status: 'passed',
        metrics: [{ name: 'latency_p95', value: 200, sampleSize: 5 }],
      },
    ],
  };

  const candidate: CandidateRunResult = {
    label: 'v2',
    config: { label: 'v2' },
    runId: 'candidate-001',
    status: 'passed',
    suiteResults: [
      {
        suiteId: 's1',
        scenarioId: 's1',
        status: 'passed',
        metrics: [{ name: 'success_rate', value: 0.95, sampleSize: 5 }],
      },
      {
        suiteId: 's2',
        scenarioId: 's2',
        status: 'passed',
        metrics: [{ name: 'latency_p95', value: 250, sampleSize: 5 }],
      },
    ],
  };

  it('computes per-scenario metrics deltas', () => {
    const comparison = compareRuns(baseline, candidate, {
      baselineLabel: 'v1',
      candidateLabel: 'v2',
    });

    expect(comparison.scenarioComparisons.length).toBe(2);

    const s1 = comparison.scenarioComparisons.find((s) => s.scenarioId === 's1')!;
    expect(s1.metrics[0].delta).toBeCloseTo(-0.05);
    expect(s1.metrics[0].regressed).toBe(true);
  });

  it('detects overall regression', () => {
    const comparison = compareRuns(baseline, candidate, {
      baselineLabel: 'v1',
      candidateLabel: 'v2',
    });
    expect(comparison.overallRegressed).toBe(true);
  });

  it('generates readable summary', () => {
    const comparison = compareRuns(baseline, candidate, {
      baselineLabel: 'v1',
      candidateLabel: 'v2',
    });
    const summary = formatComparisonSummary(comparison);
    expect(summary).toContain('baseline');
    expect(summary).toContain('candidate');
  });
});

describe('RegressionGates', () => {
  const gate: RegressionGate = {
    requiredScenarioFailures: 0,
    maxNewHighFindings: 0,
    maxNewMediumFindings: 1,
    minSuccessRateDelta: -0.02,
    maxP95LatencyDelta: 0.15,
  };

  const candidate: CandidateRunResult = {
    label: 'test',
    config: { label: 'test' },
    runId: 'test-001',
    status: 'passed',
    suiteResults: [
      { suiteId: 's1', scenarioId: 's1', status: 'passed', metrics: [] },
      { suiteId: 's2', scenarioId: 's2', status: 'passed', metrics: [] },
    ],
  };
  it('evaluates all gates', () => {
    const comparison: RunComparison = {
      baselineRunId: 'base',
      candidateRunId: 'cand',
      datasetId: 'test',
      datasetVersion: '1.0',
      baselineLabel: 'base',
      candidateLabel: 'cand',
      scenarioComparisons: [],
      aggregateDeltas: {},
      overallRegressed: false,
      overallImproved: false,
      createdAt: new Date().toISOString(),
    };

    const result = evaluateGates(comparison, gate, candidate);
    expect(result.passed).toBe(true);
    expect(result.gates.length).toBeGreaterThanOrEqual(4);
  });

  it('counts individual findings by severity', () => {
    const comparison: RunComparison = {
      baselineRunId: 'base',
      candidateRunId: 'cand',
      datasetId: 'test',
      datasetVersion: '1.0',
      baselineLabel: 'base',
      candidateLabel: 'cand',
      scenarioComparisons: [{
        scenarioId: 's1',
        scenarioTitle: 's1',
        baselineStatus: 'passed',
        candidateStatus: 'failed',
        statusChanged: true,
        metrics: [],
        newFindings: [
          { id: 'h1', severity: 'high' },
          { id: 'h2', severity: 'high' },
          { id: 'm1', severity: 'medium' },
        ],
        resolvedFindings: [],
        regressed: true,
        improved: false,
      }],
      aggregateDeltas: {},
      overallRegressed: true,
      overallImproved: false,
      createdAt: new Date().toISOString(),
    };

    const result = evaluateGates(comparison, {
      ...gate,
      requiredScenarioFailures: 1,
      maxNewHighFindings: 1,
    }, candidate);
    const findingGate = result.gates.find((g) => g.gateName === 'new-findings');

    expect(findingGate?.passed).toBe(false);
    expect(findingGate?.actual).toBe('High: 2, Medium: 1');
  });

  it('compares explicit finding identities', () => {
    const withFindings: CandidateRunResult = {
      label: 'base',
      config: { label: 'base' },
      runId: 'base',
      status: 'failed',
      suiteResults: [{
        suiteId: 's1',
        scenarioId: 's1',
        status: 'failed',
        metrics: [],
        findings: [{ id: 'resolved', severity: 'medium' as const }],
      }],
    };
    const candidateWithFindings: CandidateRunResult = {
      label: 'candidate',
      config: { label: 'candidate' },
      runId: 'candidate',
      status: 'failed',
      suiteResults: [{
        suiteId: 's1',
        scenarioId: 's1',
        status: 'failed',
        metrics: [],
        findings: [{ id: 'new', severity: 'high' as const }],
      }],
    };

    const comparison = compareRuns(withFindings, candidateWithFindings, {
      baselineLabel: 'base',
      candidateLabel: 'candidate',
    });

    expect(comparison.scenarioComparisons[0].newFindings)
      .toEqual([{ id: 'new', severity: 'high' }]);
    expect(comparison.scenarioComparisons[0].resolvedFindings)
      .toEqual([{ id: 'resolved', severity: 'medium' }]);
  });
});

describe('RunCatalog', () => {
  it('indexes and queries runs', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'qa-catalog-test-'));
    const catalog = new RunCatalog(tmpDir);

    try {
      const manifest: RunManifest = {
        schemaVersion: '1',
        runId: 'test-run-001',
        packId: 'test-pack',
        status: 'passed',
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        durationMs: 1000,
        source: 'local',
        environment: { nodeVersion: '20', platform: 'linux', ci: false },
        selection: { suites: [], tags: [], excludedTags: [] },
        policy: { retryErrors: 0, maxWorkers: 3 },
        suiteResults: [
          { suiteId: 's1', title: 'Suite 1', status: 'passed', requirement: 'required', startedAt: '', endedAt: '', durationMs: 500, attemptCount: 1 },
        ],
      };

      await catalog.indexRun(manifest, '/tmp/runs/test-run-001');

      const entries = await catalog.getAll();
      expect(entries.length).toBe(1);
      expect(entries[0].runId).toBe('test-run-001');

      const queried = await catalog.query({ packId: 'test-pack' });
      expect(queried.length).toBe(1);

      const specific = await catalog.getRun('test-run-001');
      expect(specific).not.toBeNull();
      expect(specific!.status).toBe('passed');

      const notFound = await catalog.getRun('nonexistent');
      expect(notFound).toBeNull();
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('JUnit Reporter', () => {
  it('generates valid JUnit XML for passed suites', () => {
    const manifest: RunManifest = {
      schemaVersion: '1',
      runId: 'test-run',
      packId: 'test-pack',
      status: 'passed',
      startedAt: '2026-01-01T00:00:00Z',
      endedAt: '2026-01-01T00:01:00Z',
      durationMs: 60000,
      source: 'local',
      environment: { nodeVersion: '20', platform: 'linux', ci: false },
      selection: { suites: [], tags: [], excludedTags: [] },
      policy: { retryErrors: 0, maxWorkers: 3 },
      suiteResults: [
        { suiteId: 's1', title: 'Suite 1', status: 'passed', requirement: 'required', startedAt: '', endedAt: '', durationMs: 500, attemptCount: 1 },
      ],
    };

    const xml = generateJUnitXml(manifest);
    expect(xml).toContain('<?xml version="1.0"');
    expect(xml).toContain('testsuites');
    expect(xml).toContain('testcase');
    expect(xml).not.toContain('<failure');
  });

  it('includes failure elements for failed suites', () => {
    const manifest: RunManifest = {
      schemaVersion: '1',
      runId: 'test-run',
      packId: 'test-pack',
      status: 'failed',
      startedAt: '2026-01-01T00:00:00Z',
      endedAt: '2026-01-01T00:01:00Z',
      durationMs: 60000,
      source: 'local',
      environment: { nodeVersion: '20', platform: 'linux', ci: false },
      selection: { suites: [], tags: [], excludedTags: [] },
      policy: { retryErrors: 0, maxWorkers: 3 },
      suiteResults: [
        { suiteId: 's1', title: 'Suite 1', status: 'failed', requirement: 'required', startedAt: '', endedAt: '', durationMs: 500, attemptCount: 1, error: { message: 'Assertion failed' } },
      ],
    };

    const xml = generateJUnitXml(manifest);
    expect(xml).toContain('<failure');
    expect(xml).toContain('Assertion failed');
  });

  it('includes skipped elements', () => {
    const manifest: RunManifest = {
      schemaVersion: '1',
      runId: 'test-run',
      packId: 'test-pack',
      status: 'passed',
      startedAt: '2026-01-01T00:00:00Z',
      endedAt: '2026-01-01T00:01:00Z',
      durationMs: 60000,
      source: 'local',
      environment: { nodeVersion: '20', platform: 'linux', ci: false },
      selection: { suites: [], tags: [], excludedTags: [] },
      policy: { retryErrors: 0, maxWorkers: 3 },
      suiteResults: [
        { suiteId: 's1', title: 'Suite 1', status: 'skipped', requirement: 'optional', startedAt: '', endedAt: '', durationMs: 0, attemptCount: 0, skipReason: 'No auth state' },
      ],
    };

    const xml = generateJUnitXml(manifest);
    expect(xml).toContain('<skipped');
  });
});

describe('SARIF Reporter', () => {
  it('generates valid SARIF structure', () => {
    const manifest: RunManifest = {
      schemaVersion: '1',
      runId: 'test-run',
      packId: 'test-pack',
      status: 'failed',
      startedAt: '2026-01-01T00:00:00Z',
      endedAt: '2026-01-01T00:01:00Z',
      durationMs: 60000,
      source: 'local',
      environment: { nodeVersion: '20', platform: 'linux', ci: false },
      selection: { suites: [], tags: [], excludedTags: [] },
      policy: { retryErrors: 0, maxWorkers: 3 },
      suiteResults: [
        { suiteId: 's1', title: 'Security Check', status: 'failed', requirement: 'required', startedAt: '', endedAt: '', durationMs: 500, attemptCount: 1, error: { message: 'CSP header missing' } },
      ],
    };

    const report = generateSarifReport(manifest, '/tmp/runs/test');
    expect(report.$schema).toContain('sarif-schema-2.1.0');
    expect(report.version).toBe('2.1.0');
    expect(report.runs.length).toBe(1);
    expect(report.runs[0].results.length).toBe(1);
    expect(report.runs[0].results[0].ruleId).toContain('s1');
  });

  it('includes findings when provided', () => {
    const manifest: RunManifest = {
      schemaVersion: '1',
      runId: 'test-run',
      packId: 'test-pack',
      status: 'passed',
      startedAt: '2026-01-01T00:00:00Z',
      endedAt: '2026-01-01T00:01:00Z',
      durationMs: 60000,
      source: 'local',
      environment: { nodeVersion: '20', platform: 'linux', ci: false },
      selection: { suites: [], tags: [], excludedTags: [] },
      policy: { retryErrors: 0, maxWorkers: 3 },
      suiteResults: [],
    };

    const findings = [
      { ruleId: 'SEC001', label: 'Missing CSP', severity: 'high', description: 'Content Security Policy header not found' },
    ];

    const report = generateSarifReport(manifest, undefined, findings);
    expect(report.runs[0].tool.driver.rules.length).toBe(1);
    expect(report.runs[0].tool.driver.rules[0].id).toBe('SEC001');
  });
});

describe('GitHub Reporter', () => {
  it('generates step summary markdown', () => {
    const manifest: RunManifest = {
      schemaVersion: '1',
      runId: 'test-run',
      packId: 'test-pack',
      status: 'passed',
      startedAt: '2026-01-01T00:00:00Z',
      endedAt: '2026-01-01T00:01:00Z',
      durationMs: 60000,
      source: 'ci',
      environment: { nodeVersion: '20', platform: 'linux', ci: true },
      selection: { suites: [], tags: [], excludedTags: [] },
      policy: { retryErrors: 0, maxWorkers: 3 },
      suiteResults: [
        { suiteId: 's1', title: 'Suite 1', status: 'passed', requirement: 'required', startedAt: '', endedAt: '', durationMs: 500, attemptCount: 1 },
      ],
    };

    const summary = generateGitHubStepSummary(manifest);
    expect(summary).toContain('QA Harness Run');
    expect(summary).toContain('test-pack');
    expect(summary).toContain('Suite 1');
  });

  it('generates annotations for failures', () => {
    const manifest: RunManifest = {
      schemaVersion: '1',
      runId: 'test-run',
      packId: 'test-pack',
      status: 'failed',
      startedAt: '2026-01-01T00:00:00Z',
      endedAt: '2026-01-01T00:01:00Z',
      durationMs: 60000,
      source: 'ci',
      environment: { nodeVersion: '20', platform: 'linux', ci: true },
      selection: { suites: [], tags: [], excludedTags: [] },
      policy: { retryErrors: 0, maxWorkers: 3 },
      suiteResults: [
        { suiteId: 's1', title: 'Suite 1', status: 'failed', requirement: 'required', startedAt: '', endedAt: '', durationMs: 500, attemptCount: 1, error: { message: 'Assertion failed' } },
      ],
    };

    const annotations = generateGitHubAnnotations(manifest);
    expect(annotations.length).toBe(1);
    expect(annotations[0]).toContain('::warning title=QA Harness');
    expect(annotations[0]).toContain('Assertion failed');
  });
});
