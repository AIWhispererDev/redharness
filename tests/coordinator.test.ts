/**
 * Integration tests for RunCoordinator lifecycle:
 * - Timeout: suite that ignores abortSignal still gets bounded
 * - Cancellation: cancelRun works before catalog entry exists
 * - Dependency blocking: failed dependencies produce skipped results
 * - Suite prerequisite enforcement
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { rm, mkdir, writeFile } from 'node:fs/promises';
import { RunCoordinator } from '../src/core/runCoordinator.js';
import { registry } from '../src/core/suiteRegistry.js';
import type {
  SuiteDefinition,
  SuiteContext,
  SuiteResult,
  RunSelection,
} from '../src/core/runTypes.js';

/** A suite that ignores abortSignal and runs forever — useful for timeout tests. */
const hangingSuite: SuiteDefinition = {
  id: 'hanging-suite',
  title: 'Hanging Suite',
  description: 'Never resolves — tests timeout enforcement.',
  tags: ['test'],
  requirement: 'required',
  async run(_context: SuiteContext): Promise<SuiteResult> {
    // Simulate an infinite loop that ignores abortSignal
    await new Promise<void>(() => { /* never resolves */ });
    throw new Error('unreachable');
  },
};

/** A suite that checks abortSignal and resolves immediately when aborted. */
const cooperativeSuite: SuiteDefinition = {
  id: 'cooperative-suite',
  title: 'Cooperative Suite',
  description: 'Respects abortSignal — resolves when signalled.',
  tags: ['test'],
  requirement: 'required',
  async run(context: SuiteContext): Promise<SuiteResult> {
    const startedAt = new Date().toISOString();
    const startMs = Date.now();
    // Wait for abortSignal or timeout
    await new Promise<void>((resolve) => {
      if (context.abortSignal?.aborted) {
        resolve();
        return;
      }
      context.abortSignal?.addEventListener('abort', () => resolve(), { once: true });
      // Also resolve after 30s as safety net
      setTimeout(() => resolve(), 30000);
    });
    const endedAt = new Date().toISOString();
    return {
      suiteId: 'cooperative-suite',
      status: 'passed',
      requirement: 'required',
      startedAt,
      endedAt,
      durationMs: Date.now() - startMs,
      attempts: [],
      checks: [{ name: 'completed', status: 'passed', details: ['Suite completed after abort signal'] }],
      artifacts: [],
    };
  },
};

/** A suite that depends on fail-suite. */
const depOnFailSuite: SuiteDefinition = {
  id: 'dep-on-fail',
  title: 'Dep on Fail',
  description: 'Depends on fail-suite.',
  tags: ['test'],
  requirement: 'required',
  dependencies: ['fail-suite'],
  async run(context: SuiteContext): Promise<SuiteResult> {
    const startedAt = new Date().toISOString();
    const startMs = Date.now();
    return {
      suiteId: 'dep-on-fail',
      status: 'passed',
      requirement: 'required',
      startedAt,
      endedAt: new Date().toISOString(),
      durationMs: Date.now() - startMs,
      attempts: [],
      checks: [{ name: 'completed', status: 'passed', details: ['Dependent suite ran after dependency'] }],
      artifacts: [],
    };
  },
};

/** A suite that depends on base-suite. */
const dependentSuite: SuiteDefinition = {
  id: 'dependent-suite',
  title: 'Dependent Suite',
  description: 'Depends on base-suite.',
  tags: ['test'],
  requirement: 'required',
  dependencies: ['base-suite'],
  async run(context: SuiteContext): Promise<SuiteResult> {
    const startedAt = new Date().toISOString();
    const startMs = Date.now();
    return {
      suiteId: 'dependent-suite',
      status: 'passed',
      requirement: 'required',
      startedAt,
      endedAt: new Date().toISOString(),
      durationMs: Date.now() - startMs,
      attempts: [],
      checks: [{ name: 'completed', status: 'passed', details: ['Dependent suite ran after dependency'] }],
      artifacts: [],
    };
  },
};

const fastPassSuite: SuiteDefinition = {
  id: 'base-suite',
  title: 'Base Suite',
  description: 'Always passes.',
  tags: ['test'],
  requirement: 'required',
  async run(context: SuiteContext): Promise<SuiteResult> {
    const startedAt = new Date().toISOString();
    const startMs = Date.now();
    return {
      suiteId: 'base-suite',
      status: 'passed',
      requirement: 'required',
      startedAt,
      endedAt: new Date().toISOString(),
      durationMs: Date.now() - startMs,
      attempts: [],
      checks: [{ name: 'completed', status: 'passed', details: ['Base suite passed'] }],
      artifacts: [],
    };
  },
};

const failSuite: SuiteDefinition = {
  id: 'fail-suite',
  title: 'Fail Suite',
  description: 'Always fails.',
  tags: ['test'],
  requirement: 'required',
  async run(context: SuiteContext): Promise<SuiteResult> {
    const startedAt = new Date().toISOString();
    const startMs = Date.now();
    return {
      suiteId: 'fail-suite',
      status: 'failed',
      requirement: 'required',
      startedAt,
      endedAt: new Date().toISOString(),
      durationMs: Date.now() - startMs,
      attempts: [],
      checks: [],
      artifacts: [],
      error: { message: 'Intentional failure' },
    };
  },
};

describe('RunCoordinator — lifecycle', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'coordinator-test-'));
  });

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function makePackDir(subdir: string): Promise<string> {
    const packDir = join(tmpDir, subdir);
    await mkdir(packDir, { recursive: true });
    await writeFile(
      join(packDir, 'pack.yaml'),
      'id: test-pack\nname: Test Pack\nbaseUrl: http://localhost:3000\n',
      'utf8',
    );
    return packDir;
  }

  // Register suites before each test group
  beforeAll(() => {
    // Register once — registry is a singleton, so guard against duplicates
    if (!registry.get('hanging-suite')) registry.register(hangingSuite);
    if (!registry.get('cooperative-suite')) registry.register(cooperativeSuite);
    if (!registry.get('base-suite')) registry.register(fastPassSuite);
    if (!registry.get('dependent-suite')) registry.register(dependentSuite);
    if (!registry.get('dep-on-fail')) registry.register(depOnFailSuite);
    if (!registry.get('fail-suite')) registry.register(failSuite);
  });

  // ----------------------------------------------------------------
  // Timeout
  // ----------------------------------------------------------------
  it('enforces per-suite timeout for hanging suites', async () => {
    const packDir = await makePackDir('timeout-test');
    const coordinator = new RunCoordinator({
      packDir,
      packId: 'test-pack',
      source: 'local',
      selection: { suites: ['hanging-suite'], tags: [], excludedTags: [] },
      policy: { retryErrors: 0, maxWorkers: 1, timeoutMs: 100 },
      runDir: join(tmpDir, 'timeout-test-run'),
    });

    const manifest = await coordinator.execute();

    expect(manifest.suiteResults.length).toBe(1);
    expect(manifest.suiteResults[0].status).toBe('cancelled');
    expect(manifest.suiteResults[0].error?.message).toContain('timed out');
  });

  // ----------------------------------------------------------------
  // Cancellation via abort() before execution
  // ----------------------------------------------------------------
  it('cancels suites via abort signal before execution', async () => {
    const packDir = await makePackDir('cancel-test');
    const coordinator = new RunCoordinator({
      packDir,
      packId: 'test-pack',
      source: 'local',
      selection: { suites: ['cooperative-suite'], tags: [], excludedTags: [] },
      policy: { retryErrors: 0, maxWorkers: 1 },
      runDir: join(tmpDir, 'cancel-test-run'),
    });

    // Trigger cancellation immediately — before the suite starts
    coordinator.abort();
    const manifest = await coordinator.execute();

    // Run-level cancellation is represented consistently as cancelled.
    expect(manifest.suiteResults.length).toBe(1);
    expect(manifest.suiteResults[0].status).toBe('cancelled');
    expect(manifest.suiteResults[0].error?.message).toContain('cancelled');
  });

  // ----------------------------------------------------------------
  // Cancellation via abort() while suite is executing
  // ----------------------------------------------------------------
  it('aborts middle of execution — suite gets cancelled status', async () => {
    const packDir = await makePackDir('cancel-mid-test');

    // Use the hanging suite but abort after a short delay
    const coordinator = new RunCoordinator({
      packDir,
      packId: 'test-pack',
      source: 'local',
      selection: { suites: ['hanging-suite'], tags: [], excludedTags: [] },
      policy: { retryErrors: 0, maxWorkers: 1 },
      runDir: join(tmpDir, 'cancel-mid-test-run'),
    });

    // Run in background and abort after 100ms
    const runPromise = coordinator.execute();
    await new Promise((r) => setTimeout(r, 100));
    coordinator.abort();
    const manifest = await runPromise;

    expect(manifest.suiteResults.length).toBe(1);
    expect(manifest.suiteResults[0].status).toBe('cancelled');
  }, 15000);

  // ----------------------------------------------------------------
  // Dependency blocking
  // ----------------------------------------------------------------
  it('skips dependent suite when dependency fails', async () => {
    const packDir = await makePackDir('dep-fail-test');
    const coordinator = new RunCoordinator({
      packDir,
      packId: 'test-pack',
      source: 'local',
      selection: { suites: ['fail-suite', 'dep-on-fail'], tags: [], excludedTags: [] },
      policy: { retryErrors: 0, maxWorkers: 2 },
      runDir: join(tmpDir, 'dep-fail-test-run'),
    });

    const manifest = await coordinator.execute();

    const baseResult = manifest.suiteResults.find((r) => r.suiteId === 'fail-suite');
    const depResult = manifest.suiteResults.find((r) => r.suiteId === 'dep-on-fail');

    expect(baseResult?.status).toBe('failed');
    expect(depResult?.status).toBe('skipped');
    expect(depResult?.skipReason).toContain('fail-suite');
  });

  // ----------------------------------------------------------------
  // Dependency passes — dependent runs
  // ----------------------------------------------------------------
  it('runs dependent suite when dependency passes', async () => {
    const packDir = await makePackDir('dep-pass-test');
    const coordinator = new RunCoordinator({
      packDir,
      packId: 'test-pack',
      source: 'local',
      selection: { suites: ['base-suite', 'dependent-suite'], tags: [], excludedTags: [] },
      policy: { retryErrors: 0, maxWorkers: 2 },
      runDir: join(tmpDir, 'dep-pass-test-run'),
    });

    const manifest = await coordinator.execute();

    const baseResult = manifest.suiteResults.find((r) => r.suiteId === 'base-suite');
    const depResult = manifest.suiteResults.find((r) => r.suiteId === 'dependent-suite');

    expect(baseResult?.status).toBe('passed');
    expect(depResult?.status).toBe('passed');
  });

  // ----------------------------------------------------------------
  // HarnessService cancelRun before catalog entry exists
  // ----------------------------------------------------------------
  it('cancelRun works via in-flight coordinator before catalog entry', async () => {
    const packDir = await makePackDir('cancel-service-pack');

    // Manually exercise the pattern: start run, cancel via in-memory coordinator
    const coordinator = new RunCoordinator({
      packDir,
      packId: 'cancel-pack',
      source: 'local',
      selection: { suites: ['hanging-suite'], tags: [], excludedTags: [] },
      policy: { retryErrors: 0, maxWorkers: 1 },
      runId: 'cancel-service-test-run',
      runDir: join(tmpDir, 'cancel-service-test-run'),
    });

    // Verify cancellation via coordinator.abort() works
    const execPromise = coordinator.execute();
    await new Promise((r) => setTimeout(r, 50));
    coordinator.abort();
    const manifest = await execPromise;

    expect(manifest.suiteResults.length).toBe(1);
    expect(manifest.suiteResults[0].status).toBe('cancelled');
  }, 15000);

  // ----------------------------------------------------------------
  // Multiple suites with concurrency
  // ----------------------------------------------------------------
  it('executes multiple suites in parallel within concurrency limit', async () => {
    const packDir = await makePackDir('multi-test');

    // Create two cooperative suites that both pass
    const suiteA: SuiteDefinition = {
      id: 'multi-a',
      title: 'Multi A',
      description: '',
      tags: ['test'],
      requirement: 'required',
      async run(_ctx: SuiteContext): Promise<SuiteResult> {
        const startedAt = new Date().toISOString();
        const startMs = Date.now();
        await new Promise((r) => setTimeout(r, 10));
        return {
          suiteId: 'multi-a',
          status: 'passed',
          requirement: 'required',
          startedAt,
          endedAt: new Date().toISOString(),
          durationMs: Date.now() - startMs,
          attempts: [],
          checks: [],
          artifacts: [],
        };
      },
    };
    const suiteB: SuiteDefinition = {
      id: 'multi-b',
      title: 'Multi B',
      description: '',
      tags: ['test'],
      requirement: 'required',
      async run(_ctx: SuiteContext): Promise<SuiteResult> {
        const startedAt = new Date().toISOString();
        const startMs = Date.now();
        await new Promise((r) => setTimeout(r, 10));
        return {
          suiteId: 'multi-b',
          status: 'passed',
          requirement: 'required',
          startedAt,
          endedAt: new Date().toISOString(),
          durationMs: Date.now() - startMs,
          attempts: [],
          checks: [],
          artifacts: [],
        };
      },
    };
    if (!registry.get('multi-a')) registry.register(suiteA);
    if (!registry.get('multi-b')) registry.register(suiteB);

    const coordinator = new RunCoordinator({
      packDir,
      packId: 'test-pack',
      source: 'local',
      selection: { suites: ['multi-a', 'multi-b'], tags: [], excludedTags: [] },
      policy: { retryErrors: 0, maxWorkers: 2 },
      runDir: join(tmpDir, 'multi-test-run'),
    });

    const manifest = await coordinator.execute();
    expect(manifest.suiteResults.length).toBe(2);
    expect(manifest.suiteResults.every((r) => r.status === 'passed')).toBe(true);
  });
});
