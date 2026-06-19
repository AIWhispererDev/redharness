import { describe, expect, it } from 'vitest';
import { draftCoreReportsFromBrowserSmoke } from '../src/draftReports.js';

const failedBrowserSmoke = {
  ok: false,
  checks: [
    { name: 'TOS modal appears', ok: true, details: ['found text: Before you continue'] },
    { name: 'Blank invite submit gives visible validation', ok: false, details: ['no visible validation appeared after blank submit'] },
  ],
  artifacts: ['artifacts/pocket-socrates/latest-browser-smoke/blank-invite-submit.png'],
};

describe('draft report generation', () => {
  it('creates a draft-only Core QA report for blank invite validation failure', () => {
    const drafts = draftCoreReportsFromBrowserSmoke(failedBrowserSmoke);

    expect(drafts).toHaveLength(1);
    expect(drafts[0].data.Task).toBe('0. TOS Gate');
    expect(drafts[0].data.Component).toBe('Invite code form');
    expect(drafts[0].data['Problem Type']).toBe('Copy/UX');
    expect(drafts[0].data.Severity).toBe('Minor');
    expect(drafts[0].data.Attachments).toContain('blank-invite-submit.png');
    expect(drafts[0].markdown).toContain('DRAFT ONLY');
    expect(drafts[0].markdown).toContain('Do not submit automatically');
  });

  it('does not create drafts when browser smoke passes', () => {
    const drafts = draftCoreReportsFromBrowserSmoke({
      ok: true,
      checks: [{ name: 'Blank invite submit gives visible validation', ok: true, details: ['validation shown'] }],
      artifacts: [],
    });

    expect(drafts).toEqual([]);
  });
});
