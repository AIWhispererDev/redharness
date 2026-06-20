import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { registry } from '../src/core/suiteRegistry.js';
import { RunCoordinator } from '../src/core/runCoordinator.js';
import { TraceWriter } from '../src/trace/traceWriter.js';
import type {
  SuiteDefinition,
  SuiteResult,
  SuiteContext,
} from '../src/core/runTypes.js';

function passingResult(suiteId: string): SuiteResult {
  const now = new Date().toISOString();
  return {
    suiteId,
    status: 'passed',
    requirement: 'required',
    startedAt: now,
    endedAt: now,
    durationMs: 0,
    attempts: [],
    checks: [],
    artifacts: [],
  };
}

function register(definition: SuiteDefinition): void {
  if (!registry.get(definition.id)) registry.register(definition);
}

async function coordinator(
  suiteIds: string[],
  options: { timeoutMs?: number; baseUrl?: string } = {},
): Promise<RunCoordinator> {
  const runDir = await mkdtemp(path.join(tmpdir(), 'qa-coordinator-'));
  return new RunCoordinator({
    packDir: process.cwd(),
    packId: 'test-pack',
    source: 'local',
    selection: { suites: suiteIds, tags: [], excludedTags: [] },
    policy: {
      retryErrors: 0,
      maxWorkers: 2,
      timeoutMs: options.timeoutMs,
    },
    baseUrl: options.baseUrl,
    runDir,
  });
}

describe('RunCoordinator lifecycle', () => {
  it('returns promptly when a non-cooperative suite times out', async () => {
    const id = 'coordinator-timeout-probe';
    register({
      id,
      title: 'Timeout probe',
      description: 'Ignores cancellation to verify coordinator bounds',
      tags: ['test'],
      requirement: 'required',
      async run() {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        return passingResult(id);
      },
    });

    const instance = await coordinator([id], { timeoutMs: 20 });
    const started = Date.now();
    const manifest = await instance.execute();

    expect(Date.now() - started).toBeLessThan(500);
    expect(manifest.suiteResults).toHaveLength(1);
    expect(manifest.suiteResults[0].status).toBe('cancelled');

    await new Promise((resolve) => setTimeout(resolve, 1_020));
    expect(manifest.suiteResults).toHaveLength(1);
  });

  it('propagates run cancellation to an active suite', async () => {
    const id = 'coordinator-cancel-probe';
    register({
      id,
      title: 'Cancellation probe',
      description: 'Waits for cancellation',
      tags: ['test'],
      requirement: 'required',
      async run(context: SuiteContext) {
        await new Promise<void>((resolve) => {
          context.abortSignal?.addEventListener('abort', () => resolve(), {
            once: true,
          });
        });
        return passingResult(id);
      },
    });

    const instance = await coordinator([id]);
    const execution = instance.execute();
    setTimeout(() => instance.abort(), 20);
    const manifest = await execution;

    expect(manifest.suiteResults).toHaveLength(1);
    expect(manifest.suiteResults[0].status).toBe('cancelled');
  });

  it('records dependency-blocked suites as skipped', async () => {
    const dependency = 'coordinator-failed-dependency';
    const dependent = 'coordinator-blocked-dependent';
    register({
      id: dependency,
      title: 'Failed dependency',
      description: 'Fails',
      tags: ['test'],
      requirement: 'required',
      async run() {
        return { ...passingResult(dependency), status: 'failed' };
      },
    });
    register({
      id: dependent,
      title: 'Blocked dependent',
      description: 'Must not execute',
      tags: ['test'],
      requirement: 'required',
      dependencies: [dependency],
      async run() {
        throw new Error('Blocked suite executed');
      },
    });

    const instance = await coordinator([dependency, dependent]);
    const manifest = await instance.execute();
    const blocked = manifest.suiteResults.find((r) => r.suiteId === dependent);

    expect(blocked?.status).toBe('skipped');
    expect(blocked?.skipReason).toContain(dependency);
  });

  it('enforces declared suite prerequisites centrally', async () => {
    const id = 'coordinator-prerequisite-probe';
    let executed = false;
    register({
      id,
      title: 'Prerequisite probe',
      description: 'Requires a base URL',
      tags: ['test'],
      requirement: 'required',
      requires: ['baseUrl'],
      async run() {
        executed = true;
        return passingResult(id);
      },
    });

    const instance = await coordinator([id]);
    const manifest = await instance.execute();

    expect(executed).toBe(false);
    expect(manifest.suiteResults[0].status).toBe('skipped');
    expect(manifest.suiteResults[0].skipReason).toContain('baseUrl');
  });

  it('writes correlated run and suite traces', async () => {
    const id = 'coordinator-trace-probe';
    register({
      id,
      title: 'Trace probe',
      description: 'Passes with trace correlation',
      tags: ['test'],
      requirement: 'required',
      async run(context) {
        expect(context.traceId).toBeTruthy();
        expect(context.spanId).toBeTruthy();
        return passingResult(id);
      },
    });

    const instance = await coordinator([id]);
    await instance.execute();
    const spans = await TraceWriter.load(instance.getRunDir());

    expect(spans.some((span) => span.kind === 'run')).toBe(true);
    expect(spans.some((span) =>
      span.kind === 'suite' && span.attributes.suiteId === id)).toBe(true);
  });
});
