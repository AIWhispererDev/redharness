import { describe, expect, it } from 'vitest';
import { renderMobileAuthSmokeReport } from '../src/mobileAuthSmoke.js';

describe('mobile authenticated smoke checks', () => {
  it('renders mobile checks and artifacts', () => {
    const markdown = renderMobileAuthSmokeReport('Pocket Socrates', {
      ok: false,
      skipped: false,
      checks: [
        { name: 'Mobile dashboard renders', ok: true, details: ['viewport 390x844'] },
        { name: 'Mobile drawer opens', ok: false, details: ['menu button missing'] },
      ],
      artifacts: ['artifacts/pocket-socrates/mobile/dashboard.png'],
    });

    expect(markdown).toContain('# Pocket Socrates mobile authenticated smoke report');
    expect(markdown).toContain('Status: failed');
    expect(markdown).toContain('✅ Mobile dashboard renders');
    expect(markdown).toContain('❌ Mobile drawer opens');
    expect(markdown).toContain('dashboard.png');
  });
});
