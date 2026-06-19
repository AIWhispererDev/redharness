import { describe, expect, it } from 'vitest';
import { classifyChaosFinding, renderChaosSmokeReport } from '../src/chaosSmoke.js';

describe('chaos smoke', () => {
  it('classifies failed probes into submit-worthy findings', () => {
    expect(classifyChaosFinding({ name: 'Double send empty prompt', ok: false, details: ['no validation visible'] })).toBe('potential-bug');
    expect(classifyChaosFinding({ name: 'Console errors', ok: true, details: ['none'] })).toBe('pass');
  });

  it('renders a bug-hunting report', () => {
    const report = renderChaosSmokeReport('Pocket Socrates', {
      ok: false,
      skipped: false,
      checks: [
        { name: 'Double send empty prompt', ok: false, details: ['no validation visible'] },
        { name: 'Rapid tab switching', ok: true, details: ['stable'] },
      ],
      artifacts: ['chaos.png'],
    });

    expect(report).toContain('# Pocket Socrates chaos smoke report');
    expect(report).toContain('Potential findings: 1');
    expect(report).toContain('❌ Double send empty prompt');
    expect(report).toContain('chaos.png');
  });
});
