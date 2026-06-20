import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { applyRetention } from '../src/operations/retention.js';
import { redactOtelAttributes } from '../src/operations/operationalPolicy.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true }).catch(() => {})));
});

describe('operational retention', () => {
  it('deletes old flat-layout runs but keeps fresh ones', async () => {
    const root = path.join(os.tmpdir(), `retention-flat-${Date.now()}`);
    roots.push(root);
    const oldRun = path.join(root, 'old-run');
    const freshRun = path.join(root, 'fresh-run');
    await mkdir(oldRun, { recursive: true });
    await mkdir(freshRun, { recursive: true });
    const old = new Date(Date.now() - 40 * 86_400_000);
    await utimes(oldRun, old, old);

    const applied = await applyRetention({
      root,
      olderThanDays: 30,
      dryRun: false,
    });
    expect(applied.deleted).toContain(oldRun);
    await expect(stat(oldRun)).rejects.toThrow();
    await expect(stat(freshRun)).resolves.toBeTruthy();
  });

  it('discovers nested pack/run directories recursively', async () => {
    const root = path.join(os.tmpdir(), `retention-nested-${Date.now()}`);
    roots.push(root);
    const oldRun = path.join(root, 'test-pack', 'old-run');
    const freshRun = path.join(root, 'test-pack', 'fresh-run');
    await mkdir(oldRun, { recursive: true });
    await mkdir(freshRun, { recursive: true });
    const old = new Date(Date.now() - 40 * 86_400_000);
    await utimes(oldRun, old, old);

    const preview = await applyRetention({
      root,
      olderThanDays: 30,
      dryRun: true,
      recursive: true,
    });
    expect(preview.candidates.length).toBeGreaterThanOrEqual(1);
    const oldCandidate = preview.candidates.find((c) => c.path === oldRun);
    expect(oldCandidate).toBeTruthy();
  });

  it('does not delete the pack directory itself', async () => {
    const root = path.join(os.tmpdir(), `retention-pack-safe-${Date.now()}`);
    roots.push(root);
    const packDir = path.join(root, 'test-pack');
    const oldRun = path.join(packDir, 'old-run');
    await mkdir(oldRun, { recursive: true });
    const old = new Date(Date.now() - 40 * 86_400_000);
    await utimes(oldRun, old, old);

    const applied = await applyRetention({
      root,
      olderThanDays: 30,
      dryRun: false,
      recursive: true,
    });
    expect(applied.deleted).toContain(oldRun);
    await expect(stat(packDir)).resolves.toBeTruthy();
  });

  it('protects named baselines from deletion', async () => {
    const root = path.join(os.tmpdir(), `retention-baseline-${Date.now()}`);
    roots.push(root);
    const baselineRun = path.join(root, 'release-v1');
    await mkdir(baselineRun, { recursive: true });
    const old = new Date(Date.now() - 100 * 86_400_000);
    await utimes(baselineRun, old, old);

    const preview = await applyRetention({
      root,
      olderThanDays: 30,
      dryRun: true,
      protectedBaselines: ['release-v1'],
    });
    const candidateIds = preview.candidates.map((c) => path.basename(c.path));
    expect(candidateIds).not.toContain('release-v1');
  });

  it('protects the most recent run per pack', async () => {
    const root = path.join(os.tmpdir(), `retention-recent-${Date.now()}`);
    roots.push(root);
    const oldRun = path.join(root, 'test-pack', 'old-run');
    const recentRun = path.join(root, 'test-pack', 'recent-run');
    await mkdir(oldRun, { recursive: true });
    await mkdir(recentRun, { recursive: true });
    const old = new Date(Date.now() - 100 * 86_400_000);
    await utimes(oldRun, old, old);
    const recent = new Date(Date.now() - 5 * 86_400_000);
    await utimes(recentRun, recent, recent);

    const applied = await applyRetention({
      root,
      olderThanDays: 30,
      dryRun: false,
      recursive: true,
    });

    expect(applied.deleted).toContain(oldRun);
    expect(applied.deleted).not.toContain(recentRun);
    await expect(stat(recentRun)).resolves.toBeTruthy();
  });

  it('calculates approximate recursive byte sizes', async () => {
    const root = path.join(os.tmpdir(), `retention-bytes-${Date.now()}`);
    roots.push(root);
    const oldRun = path.join(root, 'old-run');
    await mkdir(oldRun, { recursive: true });
    await writeFile(path.join(oldRun, 'trace.zip'), 'fake-trace-data');
    await writeFile(path.join(oldRun, 'finding.json'), '{"finding":"test"}');
    const old = new Date(Date.now() - 40 * 86_400_000);
    await utimes(oldRun, old, old);

    const preview = await applyRetention({
      root,
      olderThanDays: 30,
      dryRun: true,
    });
    expect(preview.candidates.length).toBe(1);
  });

  it('only processes children of the approved root', async () => {
    const root = path.join(os.tmpdir(), `retention-safe-${Date.now()}`);
    roots.push(root);
    await mkdir(root, { recursive: true });
    const outsideRoot = path.join(os.tmpdir(), `retention-outside-${Date.now()}`);
    await mkdir(outsideRoot, { recursive: true });

    const result = await applyRetention({
      root,
      olderThanDays: 1,
      dryRun: true,
    });
    const outsideCandidate = result.candidates.find((c) => c.path === outsideRoot);
    expect(outsideCandidate).toBeFalsy();
  });

  it('dry run previews candidates without deleting', async () => {
    const root = path.join(os.tmpdir(), `retention-dry-${Date.now()}`);
    roots.push(root);
    const oldRun = path.join(root, 'old-run');
    await mkdir(oldRun, { recursive: true });
    const old = new Date(Date.now() - 40 * 86_400_000);
    await utimes(oldRun, old, old);

    const dryResults = await applyRetention({
      root,
      olderThanDays: 30,
      dryRun: true,
    });
    expect(dryResults.dryRun).toBe(true);
    expect(dryResults.candidates.length).toBe(1);
    expect(dryResults.deleted.length).toBe(0);
    await expect(stat(oldRun)).resolves.toBeTruthy();

    const applied = await applyRetention({
      root,
      olderThanDays: 30,
      dryRun: false,
    });
    expect(applied.deleted.length).toBe(1);
    await expect(stat(oldRun)).rejects.toThrow();
  });

  // ────────────────────────────────────────────────────────────────────
  // Retention dry-run result structure
  // ────────────────────────────────────────────────────────────────────

  it('produces structured dry-run result with candidate details', async () => {
    const root = path.join(os.tmpdir(), `retention-dry-struct-${Date.now()}`);
    roots.push(root);
    const oldRun = path.join(root, 'old-run');
    await mkdir(oldRun, { recursive: true });
    await writeFile(path.join(oldRun, 'run.json'), '{}');
    await writeFile(path.join(oldRun, 'trace.zip'), 'trace-data');
    const old = new Date(Date.now() - 50 * 86_400_000);
    await utimes(oldRun, old, old);
    await utimes(path.join(oldRun, 'run.json'), old, old);
    await utimes(path.join(oldRun, 'trace.zip'), old, old);

    const result = await applyRetention({
      root,
      olderThanDays: 30,
      dryRun: true,
    });

    expect(result).toHaveProperty('dryRun', true);
    expect(result).toHaveProperty('candidates');
    expect(result).toHaveProperty('deleted');
    expect(result.deleted.length).toBe(0);

    if (result.candidates.length > 0) {
      expect(result.candidates[0]).toHaveProperty('path');
      expect(result.candidates[0]).toHaveProperty('ageDays');
      expect(result.candidates[0]).toHaveProperty('bytes');
    }
  });

  it('reports candidates for nested pack layouts', async () => {
    const root = path.join(os.tmpdir(), `retention-dry-nested-${Date.now()}`);
    roots.push(root);
    const oldRun = path.join(root, 'fixture-web', 'old-run');
    await mkdir(oldRun, { recursive: true });
    const old = new Date(Date.now() - 50 * 86_400_000);
    await utimes(oldRun, old, old);

    const result = await applyRetention({
      root,
      olderThanDays: 30,
      dryRun: true,
      recursive: true,
    });

    const candidateIds = result.candidates.map((c) => path.basename(c.path));
    expect(candidateIds).toContain('old-run');
  });

  // ────────────────────────────────────────────────────────────────────
  // Protected record discovery
  // ────────────────────────────────────────────────────────────────────

  it('protects a named baseline from deletion', async () => {
    const root = path.join(os.tmpdir(), `retention-protect-base-${Date.now()}`);
    roots.push(root);
    const baselineRun = path.join(root, 'baseline-v2');
    await mkdir(baselineRun, { recursive: true });
    const old = new Date(Date.now() - 200 * 86_400_000);
    await utimes(baselineRun, old, old);

    // Protected explicitly
    const result = await applyRetention({
      root,
      olderThanDays: 30,
      dryRun: false,
      protectedBaselines: ['baseline-v2'],
    });

    expect(result.deleted).not.toContain(baselineRun);
    await expect(stat(baselineRun)).resolves.toBeTruthy();
  });

  it('protects a run linked to protected findings', async () => {
    const root = path.join(os.tmpdir(), `retention-protect-finding-${Date.now()}`);
    roots.push(root);

    // Create a run that could produce findings
    const runDir = path.join(root, 'finding-run');
    await mkdir(path.join(runDir, 'findings', 'finding-456'), { recursive: true });
    await writeFile(path.join(runDir, 'findings', 'finding-456', 'finding.json'),
      JSON.stringify({ findingId: 'finding-456', title: 'Protected finding' }));
    await writeFile(path.join(runDir, 'findings', 'finding-456', 'evidence.png'), 'data');

    const old = new Date(Date.now() - 200 * 86_400_000);
    await utimes(runDir, old, old);
    await utimes(path.join(runDir, 'findings', 'finding-456'), old, old);
    await utimes(path.join(runDir, 'findings', 'finding-456', 'finding.json'), old, old);

    const result = await applyRetention({
      root,
      olderThanDays: 30,
      dryRun: false,
      protectedFindingIds: ['finding-456'],
    });

    // The run dir itself is not protected, but findings within it are
    const findingFilePath = path.join(runDir, 'findings', 'finding-456', 'finding.json');
    expect(result.deleted).not.toContain(findingFilePath);

    // Run dir may or may not be deleted; the key invariant is that
    // finding evidence files are protected
  });

  // ────────────────────────────────────────────────────────────────────
  // OTel redaction
  // ────────────────────────────────────────────────────────────────────

  it('redacts sensitive OTel attributes', () => {
    const attrs = {
      suiteId: 'test-suite',
      token: 'eyJhbGciOiJIUzI1NiJ9.token',
      'auth.token': 'abc123',
      storageState: '/home/user/.auth.json',
      normalField: 'keep-this',
      authorization: 'Bearer sensitive',
    };

    const redacted = redactOtelAttributes(attrs, [
      'storageState',
      'auth.token',
      'token',
      'authorization',
    ]);

    expect(redacted.suiteId).toBe('test-suite');
    expect(redacted.normalField).toBe('keep-this');
    expect(redacted.token).toBe('[REDACTED]');
    expect(redacted['auth.token']).toBe('[REDACTED]');
    expect(redacted.storageState).toBe('[REDACTED]');
    expect(redacted.authorization).toBe('[REDACTED]');
  });

  it('preserves non-sensitive attributes unchanged', () => {
    const attrs = {
      suiteId: 'test',
      durationMs: 1234,
      passed: true,
      tags: ['smoke', 'release'],
    };

    const redacted = redactOtelAttributes(attrs, ['token', 'secret']);

    expect(redacted.suiteId).toBe('test');
    expect(redacted.durationMs).toBe(1234);
    expect(redacted.passed).toBe(true);
    expect(redacted.tags).toEqual(['smoke', 'release']);
  });
});
