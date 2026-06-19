import { describe, expect, it } from 'vitest';
import { resolveRunDir, renderCompactRunSummary } from '../src/runDir.js';
import type { RunSection } from '../src/runSummary.js';

describe('run directory and CI output', () => {
  it('creates deterministic timestamped run dirs for auto mode', () => {
    const dir = resolveRunDir({
      packId: 'pocket-socrates',
      outputDir: 'artifacts/pocket-socrates/all-smoke',
      runDir: 'auto',
      now: new Date('2026-06-14T12:20:00.000Z'),
      cwd: '/workspace/qa-harness',
    });

    expect(dir.replaceAll('\\', '/')).toBe('/workspace/qa-harness/runs/pocket-socrates/2026-06-14T12-20-00-000Z');
  });

  it('keeps legacy output dir when no run-dir is supplied', () => {
    const dir = resolveRunDir({
      packId: 'pocket-socrates',
      outputDir: 'artifacts/pocket-socrates/all-smoke',
      cwd: '/workspace/qa-harness',
    });

    expect(dir.replaceAll('\\', '/')).toBe('/workspace/qa-harness/artifacts/pocket-socrates/all-smoke');
  });

  it('renders compact CI summary', () => {
    const sections: RunSection[] = [
      { name: 'public routes', ok: true, markdown: 'ok' },
      { name: 'early access/TOS', ok: false, markdown: 'fail' },
    ];

    const summary = renderCompactRunSummary('Pocket Socrates', sections, 'C:/runs/one');

    expect(summary).toContain('Pocket Socrates: failed');
    expect(summary).toContain('1/2 sections passed');
    expect(summary).toContain('✅ public routes');
    expect(summary).toContain('❌ early access/TOS');
    expect(summary).toContain('C:/runs/one');
  });
});
