import { describe, expect, it } from 'vitest';
import { draftSmokeFailureReports } from '../src/genericDrafts.js';
import type { BrowserSmokeCheck } from '../src/types.js';

describe('generic smoke failure drafts', () => {
  it('creates draft-only reports for failed smoke checks', () => {
    const checks: BrowserSmokeCheck[] = [
      { name: 'Public nav link broken', ok: false, details: ['before: /landing', 'after: /missing'] },
      { name: 'Console errors', ok: true, details: ['0 console error(s) captured'] },
    ];

    const drafts = draftSmokeFailureReports({
      packName: 'Pocket Socrates',
      suiteName: 'public nav',
      checks,
      artifacts: ['artifacts/pocket-socrates/public-nav/mobile-menu.png'],
    });

    expect(drafts).toHaveLength(1);
    expect(drafts[0].slug).toBe('public-nav-public-nav-link-broken');
    expect(drafts[0].markdown).toContain('DRAFT ONLY');
    expect(drafts[0].markdown).toContain('Public nav link broken');
    expect(drafts[0].markdown).toContain('before: /landing');
    expect(drafts[0].markdown).toContain('mobile-menu.png');
    expect(drafts[0].yaml).toContain('suite: public nav');
  });
});
