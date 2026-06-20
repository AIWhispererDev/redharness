import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { applyRetention } from '../src/operations/retention.js';

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
});
