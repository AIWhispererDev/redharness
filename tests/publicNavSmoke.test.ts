import { describe, expect, it } from 'vitest';
import { renderPublicNavSmokeReport } from '../src/publicNavSmoke.js';

describe('public nav smoke checks', () => {
  it('renders clicked-route checks and artifacts', () => {
    const markdown = renderPublicNavSmokeReport('Pocket Socrates', {
      ok: false,
      checks: [
        { name: 'Landing Architecture nav', ok: true, details: ['navigated to /privacy-architecture'] },
        { name: 'Mobile hamburger opens', ok: false, details: ['Launch the App link not visible'] },
      ],
      artifacts: ['artifacts/pocket-socrates/public-nav/mobile-menu.png'],
    });

    expect(markdown).toContain('# Pocket Socrates public nav smoke report');
    expect(markdown).toContain('Status: failed');
    expect(markdown).toContain('✅ Landing Architecture nav');
    expect(markdown).toContain('❌ Mobile hamburger opens');
    expect(markdown).toContain('mobile-menu.png');
  });
});
