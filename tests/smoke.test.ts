import { describe, expect, it } from 'vitest';
import { loadPackFromDir } from '../src/pack.js';
import { fileURLToPath } from 'node:url';
import { renderSmokeReport, summarizeSmokeResults } from '../src/smoke.js';

const packDir = fileURLToPath(new URL('../packs/pocket-socrates', import.meta.url));

describe('Pocket Socrates public smoke checks', () => {
  it('loads public smoke route expectations from the pack', async () => {
    const pack = await loadPackFromDir(packDir);

    expect(pack.smoke?.publicRoutes.map((route) => route.path)).toEqual(
      expect.arrayContaining(['/landing', '/how-it-works', '/privacy-architecture', '/early-access']),
    );
  });

  it('summarizes pass/fail smoke results', () => {
    const summary = summarizeSmokeResults([
      { name: '/landing', ok: true, details: ['HTTP 200'] },
      { name: '/early-access', ok: false, details: ['Missing text: Enter your invite code'] },
    ]);

    expect(summary.total).toBe(2);
    expect(summary.passed).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.ok).toBe(false);
  });

  it('renders a markdown smoke report with failures visible', () => {
    const markdown = renderSmokeReport('Pocket Socrates', [
      { name: '/landing', ok: true, details: ['HTTP 200', 'title includes Pocket Socrates'] },
      { name: '/early-access', ok: false, details: ['Missing text: Enter your invite code'] },
    ]);

    expect(markdown).toContain('# Pocket Socrates smoke report');
    expect(markdown).toContain('Summary: 1/2 passed');
    expect(markdown).toContain('❌ /early-access');
    expect(markdown).toContain('Missing text: Enter your invite code');
  });
});
