import { describe, expect, it } from 'vitest';
import { buildRunSummaryJson } from '../src/runSummary.js';

describe('run summary JSON', () => {
  it('serializes section statuses and artifact paths', () => {
    const json = buildRunSummaryJson('Pocket Socrates', [
      { name: 'public nav', ok: true, markdown: '# ok', artifacts: ['mobile-menu.png'] },
      { name: 'early access/TOS', ok: false, markdown: '# fail', artifacts: ['blank.png'] },
    ]);

    expect(json.packName).toBe('Pocket Socrates');
    expect(json.ok).toBe(false);
    expect(json.status).toBe('failed');
    expect(json.sections).toEqual([
      { name: 'public nav', ok: true, status: 'passed', artifacts: ['mobile-menu.png'], requirement: undefined, skipReason: undefined, durationMs: undefined },
      { name: 'early access/TOS', ok: false, status: 'failed', artifacts: ['blank.png'], requirement: undefined, skipReason: undefined, durationMs: undefined },
    ]);
  });
});
