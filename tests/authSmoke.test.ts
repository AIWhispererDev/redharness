import { describe, expect, it } from 'vitest';
import { renderAuthSmokeReport, skippedAuthSmokeResult } from '../src/authSmoke.js';

describe('authenticated smoke checks', () => {
  it('returns a skipped result when no storage state is provided', () => {
    const result = skippedAuthSmokeResult('No --storage-state provided.');

    expect(result.ok).toBe(true);
    expect(result.skipped).toBe(true);
    expect(result.checks[0].name).toBe('Authenticated smoke skipped');
    expect(result.checks[0].details).toContain('No --storage-state provided.');
  });

  it('renders skipped authenticated smoke report clearly', () => {
    const markdown = renderAuthSmokeReport('Pocket Socrates', skippedAuthSmokeResult('Missing auth state.'));

    expect(markdown).toContain('# Pocket Socrates authenticated smoke report');
    expect(markdown).toContain('Status: skipped');
    expect(markdown).toContain('Missing auth state.');
  });

  it('renders failing authenticated smoke report clearly', () => {
    const markdown = renderAuthSmokeReport('Pocket Socrates', {
      ok: false,
      skipped: false,
      checks: [
        { name: 'Dashboard requires authenticated session', ok: false, details: ['redirected to /sign-in'] },
      ],
      artifacts: ['artifacts/pocket-socrates/auth/dashboard.png'],
    });

    expect(markdown).toContain('Status: failed');
    expect(markdown).toContain('❌ Dashboard requires authenticated session');
    expect(markdown).toContain('redirected to /sign-in');
    expect(markdown).toContain('artifacts/pocket-socrates/auth/dashboard.png');
  });

  it('renders richer dashboard checks and evidence artifacts', () => {
    const markdown = renderAuthSmokeReport('Pocket Socrates', {
      ok: true,
      skipped: false,
      checks: [
        { name: 'Dashboard nav loaded', ok: true, details: ['found: THE CRUCIBLE, SOLO, PEER, JOURNEY, DOCUMENT'] },
        { name: 'No sign-in UI visible', ok: true, details: ['sign-in text absent'] },
        { name: 'Console errors', ok: true, details: ['0 console error(s) captured'] },
        { name: 'Network failures', ok: true, details: ['0 failed request(s) captured'] },
      ],
      artifacts: [
        'artifacts/pocket-socrates/auth/dashboard.png',
        'artifacts/pocket-socrates/auth/console.json',
        'artifacts/pocket-socrates/auth/network-failures.json',
      ],
    });

    expect(markdown).toContain('✅ Dashboard nav loaded');
    expect(markdown).toContain('✅ No sign-in UI visible');
    expect(markdown).toContain('console.json');
    expect(markdown).toContain('network-failures.json');
  });
});
