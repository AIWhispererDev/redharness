import { describe, expect, it } from 'vitest';
import { renderSecuritySmokeReport, securitySeverityRank } from '../src/securitySmoke.js';

describe('security smoke report', () => {
  it('renders categories, severities, and artifacts', () => {
    const report = renderSecuritySmokeReport('Pocket Socrates', {
      ok: false,
      skipped: false,
      checks: [
        { name: 'Content-Security-Policy header present', ok: false, severity: 'medium', category: 'headers', details: ['missing'] },
        { name: 'Unauthenticated dashboard gated', ok: true, severity: 'medium', category: 'auth', details: ['redirected'] },
      ],
      artifacts: ['security.json'],
    });
    expect(report).toContain('# Pocket Socrates security smoke report');
    expect(report).toContain('Status: failed');
    expect(report).toContain('Potential security findings: 1');
    expect(report).toContain('[medium/headers]');
    expect(report).toContain('security.json');
  });

  it('ranks high above medium', () => {
    expect(securitySeverityRank('high')).toBeGreaterThan(securitySeverityRank('medium'));
  });
});
