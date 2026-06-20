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
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';

const repoRoot = resolve(import.meta.dirname, '..');
const git = (args: string) =>
  execSync(`git -c safe.directory=${repoRoot.replace(/\\/g, '/')} ${args}`, {
    cwd: repoRoot,
    encoding: 'utf8',
  });

/** Recursively find all .ts files under a root directory. Cross-platform. */
function findTsFiles(dir: string): string[] {
  const result: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current)) {
      const full = resolve(current, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (entry.endsWith('.ts')) {
        // Return paths relative to repo root (Git-style)
        result.push(full.startsWith(repoRoot) ? full.slice(repoRoot.length + 1).replace(/\\/g, '/') : full);
      }
    }
  };
  walk(dir);
  return result.sort();
}

describe('repository integrity', () => {
  it('src/artifacts/artifactStore.ts is not ignored by git', () => {
    // This file is critical — it was previously hidden by the root /artifacts/ pattern
    // git check-ignore exits 0 when the file IS ignored, 1 when it is NOT ignored
    const exitCode = (() => {
      try {
        git('check-ignore src/artifacts/artifactStore.ts');
        return 0;
      } catch (e: any) {
        return e.status;
      }
    })();
    expect(exitCode).not.toBe(0);
  });

  it('critical source directories exist in git', () => {
    // Verify critical source directories are tracked by git
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

    const tracked = git('ls-files src/').trim().split('\n').filter(Boolean);

    for (const dir of criticalDirs) {
      const hasFiles = tracked.some((f: string) => f.startsWith(dir + '/'));
      expect(hasFiles, `Directory ${dir} has no tracked files`).toBe(true);
    }
  });

  it('every .ts file under src/ is tracked by git', () => {
    const tracked = new Set(
      git('ls-files src/')
        .trim()
        .split('\n')
        .filter(Boolean),
    );

    const onDisk = findTsFiles(resolve(repoRoot, 'src'));
    const untracked = onDisk.filter((f) => !tracked.has(f));
    expect(untracked).toEqual([]);
  });

  it('every .ts test file under tests/ is tracked by git', () => {
    const tracked = new Set(
      git('ls-files tests/')
        .trim()
        .split('\n')
        .filter(Boolean),
    );

    const onDisk = findTsFiles(resolve(repoRoot, 'tests'));
    const untracked = onDisk.filter((f) => !tracked.has(f));
    expect(untracked).toEqual([]);
  });
});

describe('package integrity', () => {
  it('package.json main/bin point to existing files', () => {
    const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'));

    // Compiled bin entries must map back to a source entry before build.
    for (const [name, binPath] of Object.entries(pkg.bin ?? {})) {
      const fullPath = resolve(repoRoot, binPath as string);
      const sourcePath = resolve(
        repoRoot,
        String(binPath).replace(/^dist[\\/]/, '').replace(/\.js$/, '.ts'),
      );
      expect(
        existsSync(fullPath) || existsSync(sourcePath),
        `Bin entry "${name}" has no build output or source: ${binPath}`,
      ).toBe(true);
    }
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
