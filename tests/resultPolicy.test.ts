/**
 * Tests for result policy evaluation, especially the empty-run case.
 */
import { describe, it, expect } from 'vitest';
import {
  evaluateRunPolicy,
  evaluateSuitePolicy,
} from '../src/core/resultPolicy.js';
import type { SuiteResultSummary } from '../src/core/runTypes.js';

describe('evaluateRunPolicy', () => {
  it('empty results produce error status — cannot pass with zero suites', () => {
    const result = evaluateRunPolicy([]);
    expect(result.status).toBe('error');
    expect(result.isPassing).toBe(false);
  });

  it('all passed suites produce passed status', () => {
    const results: SuiteResultSummary[] = [
      {
        suiteId: 'suite-a',
        title: 'Suite A',
        status: 'passed',
        requirement: 'required',
        startedAt: '',
        endedAt: '',
        durationMs: 10,
        attemptCount: 1,
      },
      {
        suiteId: 'suite-b',
        title: 'Suite B',
        status: 'passed',
        requirement: 'optional',
        startedAt: '',
        endedAt: '',
        durationMs: 10,
        attemptCount: 1,
      },
    ];
    const result = evaluateRunPolicy(results);
    expect(result.status).toBe('passed');
    expect(result.isPassing).toBe(true);
  });

  it('one failed required suite makes the run fail', () => {
    const results: SuiteResultSummary[] = [
      {
        suiteId: 'suite-a',
        title: 'Suite A',
        status: 'passed',
        requirement: 'required',
        startedAt: '',
        endedAt: '',
        durationMs: 10,
        attemptCount: 1,
      },
      {
        suiteId: 'suite-b',
        title: 'Suite B',
        status: 'failed',
        requirement: 'required',
        startedAt: '',
        endedAt: '',
        durationMs: 10,
        attemptCount: 1,
        error: { message: 'Something failed' },
      },
    ];
    const result = evaluateRunPolicy(results);
    expect(result.status).toBe('failed');
    expect(result.isPassing).toBe(false);
  });

  it('only informational suites never gate', () => {
    const results: SuiteResultSummary[] = [
      {
        suiteId: 'info-a',
        title: 'Info A',
        status: 'failed',
        requirement: 'informational',
        startedAt: '',
        endedAt: '',
        durationMs: 10,
        attemptCount: 1,
        error: { message: 'Info failure' },
      },
    ];
    const result = evaluateRunPolicy(results);
    expect(result.status).toBe('passed');
    expect(result.isPassing).toBe(true);
  });

  it('skipped required suite causes failure', () => {
    const results: SuiteResultSummary[] = [
      {
        suiteId: 'req-skipped',
        title: 'Required Skipped',
        status: 'skipped',
        requirement: 'required',
        startedAt: '',
        endedAt: '',
        durationMs: 0,
        attemptCount: 0,
        skipReason: 'Missing context',
      },
    ];
    const result = evaluateRunPolicy(results);
    expect(result.status).toBe('failed');
    expect(result.isPassing).toBe(false);
  });
});

describe('evaluateSuitePolicy', () => {
  it('required + passed = passing', () => {
    const result = evaluateSuitePolicy('passed', 'required');
    expect(result.isPassing).toBe(true);
    expect(result.gatesRun).toBe(true);
  });

  it('required + failed = not passing', () => {
    const result = evaluateSuitePolicy('failed', 'required');
    expect(result.isPassing).toBe(false);
    expect(result.gatesRun).toBe(true);
  });

  it('optional + skipped = passing (non-gating)', () => {
    const result = evaluateSuitePolicy('skipped', 'optional');
    expect(result.isPassing).toBe(true);
    expect(result.gatesRun).toBe(false);
  });

  it('informational + error = passing (non-gating)', () => {
    const result = evaluateSuitePolicy('error', 'informational');
    expect(result.isPassing).toBe(true);
    expect(result.gatesRun).toBe(false);
  });
});
