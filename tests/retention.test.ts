import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, rm, stat, utimes } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { applyRetention } from '../src/operations/retention.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true })));
});

describe('operational retention', () => {
  it('previews and deletes only old directories below the approved root', async () => {
    const root = path.join(os.tmpdir(), `retention-${Date.now()}`);
    roots.push(root);
    const oldRun = path.join(root, 'old-run');
    const freshRun = path.join(root, 'fresh-run');
    await mkdir(oldRun, { recursive: true });
    await mkdir(freshRun, { recursive: true });
    const old = new Date(Date.now() - 40 * 86_400_000);
    await utimes(oldRun, old, old);

    const preview = await applyRetention({
      root,
      olderThanDays: 30,
      dryRun: true,
    });
    expect(preview.candidates.map((candidate) => candidate.path)).toEqual([oldRun]);
    expect(await stat(oldRun)).toBeTruthy();

    const applied = await applyRetention({
      root,
      olderThanDays: 30,
      dryRun: false,
    });
    expect(applied.deleted).toEqual([oldRun]);
    await expect(stat(oldRun)).rejects.toThrow();
    expect(await stat(freshRun)).toBeTruthy();
  });
});
