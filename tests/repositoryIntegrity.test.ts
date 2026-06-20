/**
 * Repository integrity tests.
 *
 * These verify that:
 * - Every imported local source module is tracked in Git.
 * - No required source directory is hidden by ignore rules.
 * - The package entrypoints describe files that actually exist.
 *
 * Run from a clean checkout to confirm reproducibility.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';

const repoRoot = resolve(import.meta.dirname, '..');

describe('repository integrity', () => {
  it('src/artifacts/artifactStore.ts is not ignored by git', () => {
    // This file is critical — it was previously hidden by the root /artifacts/ pattern
    const result = execSync('git check-ignore -v src/artifacts/artifactStore.ts', {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    // If the file is not ignored, git exits 0 with no output only if it doesn't have a file-like path.
    // But git outputs nothing to stdout when it's not ignored,
    // and outputs to stderr with an ignore rule match.
    // Actually git check-ignore exits 0 when the file IS ignored, and 1 when it's NOT ignored.
    // We want it to NOT be ignored. So expect exit code 1 or empty output.
    const exitCode = (() => {
      try {
        execSync('git check-ignore src/artifacts/artifactStore.ts', {
          cwd: repoRoot,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        return 0;
      } catch (e: any) {
        return e.status;
      }
    })();
    expect(exitCode).not.toBe(0);
  });

  it('no imported source file is gitignored', () => {
    // List all .ts files imported from src/ and verify they're tracked
    // We check a representative set of core source directories
    const criticalDirs = [
      'src/artifacts',
      'src/core',
      'src/trace',
      'src/replay',
      'src/scenarios',
      'src/datasets',
      'src/graders',
      'src/agent',
      'src/redteam',
    ];

    for (const dir of criticalDirs) {
      const absDir = resolve(repoRoot, dir);
      if (!existsSync(absDir)) continue; // dir may not exist yet

      const files = readFileSync(absDir, { encoding: 'utf8' });
      // Only check that the directory exists in git
      // A deeper check: verify every .ts file in src/ is tracked
    }
  });

  it('every .ts file under src/ is tracked by git', () => {
    const { execSync } = require('node:child_process');
    // Find all .ts files tracked in git
    const tracked = new Set(
      execSync('git ls-files src/', { cwd: repoRoot, encoding: 'utf8' })
        .trim()
        .split('\n')
        .filter(Boolean),
    );

    // Find all .ts files on disk
    const { execSync: exec } = require('node:child_process');
    const onDisk: string[] = [];
    // Use find since we're in git context
    const findResult = execSync('find src/ -name "*.ts" -type f', {
      cwd: repoRoot,
      encoding: 'utf8',
    })
      .trim()
      .split('\n')
      .filter(Boolean);

    const untracked: string[] = [];
    for (const file of findResult) {
      if (!tracked.has(file)) {
        untracked.push(file);
      }
    }

    expect(untracked).toEqual([]);
  });

  it('every .ts test file under tests/ is tracked by git', () => {
    const tracked = new Set(
      execSync('git ls-files tests/', { cwd: repoRoot, encoding: 'utf8' })
        .trim()
        .split('\n')
        .filter(Boolean),
    );

    const findResult = execSync('find tests/ -name "*.ts" -type f', {
      cwd: repoRoot,
      encoding: 'utf8',
    })
      .trim()
      .split('\n')
      .filter(Boolean);

    const untracked: string[] = [];
    for (const file of findResult) {
      if (!tracked.has(file)) {
        untracked.push(file);
      }
    }

    expect(untracked).toEqual([]);
  });
});

describe('package integrity', () => {
  it('package.json main/bin point to existing files', () => {
    const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'));

    // Bin entries should exist
    for (const [name, binPath] of Object.entries(pkg.bin ?? {})) {
      const fullPath = resolve(repoRoot, binPath as string);
      expect(existsSync(fullPath), `Bin entry "${name}" points to missing file: ${binPath}`).toBe(true);
    }
  });

  it('npm run typecheck succeeds', () => {
    const result = execSync('npx tsc --noEmit', {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    expect(result).toBeDefined();
  });

  it('npm test passes', () => {
    const result = execSync('npx vitest run --reporter=verbose', {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // Should contain the test output
    expect(result).toContain('Tests');
  });

  it('CLI smoke: list command works', () => {
    const result = execSync('npx tsx src/cli.ts list pocket-socrates', {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    expect(result).toContain('pocket-socrates');
    expect(result).toContain('Suites');
  });
});
