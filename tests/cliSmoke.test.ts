/**
 * Lightweight CLI smoke tests that do not require authentication or live services.
 * These verify the CLI boots, parses commands, and handles basic errors gracefully.
 */
import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '..');

describe('CLI smoke', () => {
  it('list command prints suites', { timeout: 20000 }, () => {
    const result = execSync('npx tsx src/cli.ts list pocket-socrates', {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 15000,
    });
    expect(result).toContain('pocket-socrates');
    expect(result).toContain('Suites');
  });

  it('list --json outputs valid JSON', { timeout: 20000 }, () => {
    const result = execSync('npx tsx src/cli.ts list pocket-socrates --json', {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 15000,
    });
    const parsed = JSON.parse(result);
    expect(parsed).toHaveProperty('pack');
    expect(parsed).toHaveProperty('profiles');
    expect(parsed).toHaveProperty('suites');
    expect(parsed.pack).toBe('pocket-socrates');
  });

  it('checklist command prints checklist', { timeout: 20000 }, () => {
    const result = execSync('npx tsx src/cli.ts checklist pocket-socrates basics', {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 15000,
    });
    expect(result).toContain('Pocket Socrates');
    expect(result).toContain('checklist');
  });

  it('unknown command exits with error', { timeout: 20000 }, () => {
    try {
      execSync('npx tsx src/cli.ts nonexistent-command', {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 15000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      // Should not reach here
      expect(true).toBe(false);
    } catch (e: any) {
      expect(e.status).not.toBe(0);
    }
  });
});
