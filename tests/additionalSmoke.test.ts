import { describe, expect, it } from 'vitest';
import { renderSimpleSmokeReport } from '../src/additionalSmoke.js';

describe('additional smoke report', () => {
  it('renders checks and artifacts', () => {
    const report = renderSimpleSmokeReport('Pocket Socrates', 'Billing smoke', {
      ok: false,
      skipped: false,
      checks: [
        { name: 'Account page opens', ok: true, details: ['ok'] },
        { name: 'Billing portal graceful', ok: false, details: ['missing'] },
      ],
      artifacts: ['billing.png'],
    });
    expect(report).toContain('# Pocket Socrates Billing smoke report');
    expect(report).toContain('Status: failed');
    expect(report).toContain('✅ Account page opens');
    expect(report).toContain('❌ Billing portal graceful');
    expect(report).toContain('billing.png');
  });
});
