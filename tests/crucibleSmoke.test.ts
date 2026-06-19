import { describe, expect, it } from 'vitest';
import { renderCrucibleSmokeReport, summarizeStyleFindings } from '../src/crucibleSmoke.js';
import type { Finding } from '../src/types.js';

describe('Crucible smoke checks', () => {
  it('summarizes Soc style findings from scanner output', () => {
    const findings: Finding[] = [
      { ruleId: 'no-em-dash', label: 'Soc must not use em dash', severity: 'Major', match: '—' },
    ];

    expect(summarizeStyleFindings(findings)).toEqual({ ok: false, count: 1, detail: '1 style finding(s): no-em-dash' });
    expect(summarizeStyleFindings([])).toEqual({ ok: true, count: 0, detail: '0 style finding(s)' });
  });

  it('renders response, style findings, and artifacts', () => {
    const markdown = renderCrucibleSmokeReport('Pocket Socrates', {
      ok: false,
      skipped: false,
      checks: [
        { name: 'Crucible input usable', ok: true, details: ['submitted prompt'] },
        { name: 'Soc response style scan', ok: false, details: ['1 style finding(s): no-em-dash'] },
      ],
      socResponse: 'That is interesting — what happens next?',
      styleFindings: [
        { ruleId: 'no-em-dash', label: 'Soc must not use em dash', severity: 'Major', match: '—' },
      ],
      artifacts: ['artifacts/pocket-socrates/crucible/soc-response.txt'],
    });

    expect(markdown).toContain('# Pocket Socrates Crucible smoke report');
    expect(markdown).toContain('Status: failed');
    expect(markdown).toContain('❌ Soc response style scan');
    expect(markdown).toContain('That is interesting');
    expect(markdown).toContain('no-em-dash');
    expect(markdown).toContain('soc-response.txt');
  });
});
