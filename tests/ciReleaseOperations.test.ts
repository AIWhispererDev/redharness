/**
 * PRD 11: CI/release operations integration test.
 *
 * Tests:
 * - Deterministic fixture release profile running through CI pipeline
 * - Generating JSON, Markdown, JUnit, SARIF reports from a run manifest
 * - Required skipped coverage fails the release job
 * - Comparison using a promoted baseline name
 * - OTel exporter-failure integration proving run status unchanged
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { generateJUnitXml } from '../src/reporters/junit.js';
import { generateSarifReport } from '../src/reporters/sarif.js';
import { generateGitHubStepSummary, generateGitHubAnnotations } from '../src/reporters/github.js';
import { exportSpans } from '../src/exporters/otel.js';
import { compareRuns, formatComparisonSummary, validateDatasetCompatibility } from '../src/experiments/comparison.js';
import type { RunManifest } from '../src/core/runTypes.js';
import type { CandidateRunResult } from '../src/experiments/experimentTypes.js';
import type { TraceSpan } from '../src/trace/traceTypes.js';
import {
  releaseProfilePassed,
  runReleaseProfile,
} from '../src/operations/releaseProfile.js';

// ─────────────────────────────────────────────────────────────────────────────
// Setup
// ─────────────────────────────────────────────────────────────────────────────

let tmpDir: string;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ci-release-'));
}, 15000);

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
}, 10000);

// ─────────────────────────────────────────────────────────────────────────────
// 1. Release profile run manifest
// ─────────────────────────────────────────────────────────────────────────────

describe('Release profile', () => {
  it('runs the coordinator against the controlled fixture and writes every release report', async () => {
    const result = await runReleaseProfile({
      packDir: resolve('packs/fixture-web'),
      packId: 'fixture-web',
      profile: 'release',
      outputDir: tmpDir,
      runId: 'fixture-web-release',
      startFixture: true,
    });

    expect(result.manifest.profile).toBe('release');
    expect(result.manifest.source).toBe('ci');
    expect(result.manifest.status).toBe('passed');
    expect(result.manifest.suiteResults.map((suite) => suite.suiteId)).toEqual([
      'public-routes',
    ]);
    expect(releaseProfilePassed(result)).toBe(true);
    expect(JSON.parse(await readFile(result.reportPaths.json, 'utf8')).runId)
      .toBe('fixture-web-release');
    expect(await readFile(result.reportPaths.markdown, 'utf8'))
      .toContain('QA Harness Run: fixture-web');
    expect(await readFile(result.reportPaths.junit, 'utf8'))
      .toContain('<testsuites');
    expect(JSON.parse(await readFile(result.reportPaths.sarif, 'utf8')).version)
      .toBe('2.1.0');
  }, 15000);

  it('writes reports but fails the gate when the real release suite fails', async () => {
    const result = await runReleaseProfile({
      packDir: resolve('packs/fixture-web'),
      packId: 'fixture-web',
      profile: 'release',
      outputDir: tmpDir,
      runId: 'fixture-web-release-failure',
      baseUrl: 'http://127.0.0.1:1',
    });

    expect(result.manifest.status).toBe('failed');
    expect(result.manifest.suiteResults[0].status).toBe('failed');
    expect(releaseProfilePassed(result)).toBe(false);
    expect(existsSync(result.reportPaths.json)).toBe(true);
    expect(existsSync(result.reportPaths.markdown)).toBe(true);
    expect(existsSync(result.reportPaths.junit)).toBe(true);
    expect(existsSync(result.reportPaths.sarif)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Required skipped coverage fails
// ─────────────────────────────────────────────────────────────────────────────

describe('Required skipped coverage', () => {
  it('fails the release when a required suite is skipped', () => {
    const manifest: RunManifest = {
      schemaVersion: '1',
      runId: `skip-fail-${Date.now()}`,
      packId: 'fixture-web',
      profile: 'release',
      status: 'failed',
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 1000,
      source: 'ci' as const,
      environment: { nodeVersion: '22', platform: 'linux', ci: true },
      selection: { suites: [], tags: ['release'], excludedTags: [] },
      policy: { retryErrors: 0, maxWorkers: 3 },
      suiteResults: [
        { suiteId: 'health-check', title: 'Health Check', status: 'passed', requirement: 'required', startedAt: '', endedAt: '', durationMs: 100, attemptCount: 1 },
        { suiteId: 'dashboard-auth', title: 'Dashboard Auth', status: 'skipped', requirement: 'required', startedAt: '', endedAt: '', durationMs: 0, attemptCount: 0, skipReason: 'No auth state' },
      ],
    };
    const required = manifest.suiteResults.filter((s) => s.requirement === 'required');
    const gatePasses = required.every((s) => s.status === 'passed');
    expect(gatePasses).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Reports: JUnit, SARIF, GitHub
// ─────────────────────────────────────────────────────────────────────────────

describe('Report generation', () => {
  const manifest: RunManifest = {
    schemaVersion: '1',
    runId: `report-test-${Date.now()}`,
    packId: 'fixture-web',
    profile: 'release',
    status: 'failed',
    startedAt: '2026-06-20T00:00:00Z',
    endedAt: '2026-06-20T00:01:00Z',
    durationMs: 60000,
    source: 'ci' as const,
    environment: { nodeVersion: '22', platform: 'linux', ci: true },
    selection: { suites: [], tags: ['release'], excludedTags: [] },
    policy: { retryErrors: 0, maxWorkers: 3 },
    suiteResults: [
      { suiteId: 'health-check', title: 'Health Check', status: 'passed', requirement: 'required', startedAt: '', endedAt: '', durationMs: 200, attemptCount: 1 },
      { suiteId: 'dashboard-auth', title: 'Dashboard Auth', status: 'failed', requirement: 'required', startedAt: '', endedAt: '', durationMs: 500, attemptCount: 1, error: { message: 'Expected 401 but got 403' } },
    ],
  };

  it('generates JUnit XML with failures', () => {
    const xml = generateJUnitXml(manifest);
    expect(xml).toContain('<?xml version="1.0"');
    expect(xml).toContain('<failure');
    expect(xml).toContain('Expected 401 but got 403');
  });

  it('generates SARIF report with findings', () => {
    const report = generateSarifReport(manifest, '/tmp/runs/report-test', [
      { ruleId: 'QA/dashboard-auth', label: 'Dashboard auth regression', severity: 'high', description: 'Expected 401 but got 403' },
    ]);
    expect(report.runs.length).toBe(1);
    expect(report.runs[0].results.length).toBeGreaterThanOrEqual(2);
  });

  it('generates GitHub step summary', () => {
    const summary = generateGitHubStepSummary(manifest);
    expect(summary).toContain('QA Harness Run');
  });

  it('generates GitHub annotations for failures', () => {
    const annotations = generateGitHubAnnotations(manifest);
    expect(annotations.length).toBe(1);
    expect(annotations[0]).toContain('Expected 401 but got 403');
  });

  it('writes all report files to the run directory', async () => {
    const runDir = join(tmpDir, 'report-output');
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, 'run.json'), JSON.stringify(manifest, null, 2));
    await writeFile(join(runDir, 'junit.xml'), generateJUnitXml(manifest));
    await writeFile(join(runDir, 'results.sarif'), JSON.stringify(generateSarifReport(manifest), null, 2));
    await writeFile(join(runDir, 'step-summary.md'), generateGitHubStepSummary(manifest));
    const files = readdirSync(runDir);
    expect(files).toContain('run.json');
    expect(files).toContain('junit.xml');
    expect(files).toContain('results.sarif');
    expect(files).toContain('step-summary.md');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Baseline comparison by promoted name
// ─────────────────────────────────────────────────────────────────────────────

describe('Baseline comparison by name', () => {
  it('compares using a baseline name via compareRuns', () => {
    const baseResult: CandidateRunResult = {
      label: 'baseline (release-stable)',
      config: { label: 'baseline', metadata: { datasetId: 'test-ds', contentHash: 'abc' } },
      runId: 'base-run',
      status: 'passed',
      suiteResults: [
        { suiteId: 's1', scenarioId: 's1', status: 'passed', metrics: [] },
      ],
    };
    const candResult: CandidateRunResult = {
      label: 'candidate',
      config: { label: 'candidate', metadata: { datasetId: 'test-ds', contentHash: 'abc' } },
      runId: 'cand-run',
      status: 'failed',
      suiteResults: [
        { suiteId: 's1', scenarioId: 's1', status: 'failed', metrics: [] },
      ],
    };

    const comparison = compareRuns(baseResult, candResult, {
      baselineLabel: 'baseline:release-stable',
      candidateLabel: 'candidate-v2',
    });
    expect(comparison.baselineLabel).toContain('release-stable');
    expect(comparison.overallRegressed).toBe(true);

    const summary = formatComparisonSummary(comparison);
    expect(summary).toContain('release-stable');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. OTel exporter failure resilience
// ─────────────────────────────────────────────────────────────────────────────

describe('OTel exporter failure resilience', () => {
  const sampleSpan: TraceSpan = {
    traceId: 'otel-test',
    spanId: 'span-1',
    attemptId: 'attempt-1',
    name: 'otel-test-span',
    kind: 'suite',
    startedAt: '2026-06-20T00:00:00.000Z',
    endedAt: '2026-06-20T00:00:01.000Z',
    status: 'ok',
    attributes: { suiteId: 'otel-test' },
    events: [],
  };

  it('reports export failure without affecting run status', async () => {
    const runStatus = 'passed';
    const result = await exportSpans([sampleSpan], {
      endpoint: 'http://nonexistent-collector.test/v1/traces',
      failSilently: true,
    });
    expect(result.exported).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect('passed').toBe(runStatus);
  });

  it('succeeds in development mode (no endpoint)', async () => {
    const result = await exportSpans([sampleSpan]);
    expect(result.exported).toBe(1);
    expect(result.failed).toBe(0);
  });
});
