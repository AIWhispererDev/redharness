import { describe, expect, it } from 'vitest';
import { renderTargetedChangelogSmokeReport } from '../src/targetedChangelogSmoke.js';

describe('targeted changelog smoke report', () => {
  it('renders skipped and failed targeted checks', () => {
    const report = renderTargetedChangelogSmokeReport('Pocket Socrates', {
      ok: false,
      skipped: false,
      checks: [
        { name: 'Pro bypass exploit attempt', ok: true, details: ['skipped: needs non-Pro state'] },
        { name: '+ New Context confirms first', ok: false, details: ['no confirmation visible'] },
      ],
      artifacts: ['targeted.png'],
    });
    expect(report).toContain('# Pocket Socrates targeted changelog smoke report');
    expect(report).toContain('Status: failed');
    expect(report).toContain('Pro bypass exploit attempt');
    expect(report).toContain('targeted.png');
  });
});
