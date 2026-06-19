import { describe, expect, it } from 'vitest';
import { renderProRegressionSmokeReport, extractLatestSocResponse } from '../src/proRegressionSmoke.js';

describe('Pro regression smoke checks', () => {
  it('extracts the latest Soc response before the next user turn', () => {
    const text = 'YOU\nhello\nSOC\nFirst reply\nYOU\nnext\nSOC\nLatest reply\n↑\n↓\nSTART NEW SESSION';
    expect(extractLatestSocResponse(text)).toContain('Latest reply');
    expect(extractLatestSocResponse(text)).not.toContain('START NEW SESSION');
  });

  it('renders checks, responses, and artifacts', () => {
    const markdown = renderProRegressionSmokeReport('Pocket Socrates', {
      ok: false,
      skipped: false,
      checks: [
        { name: 'Solo Pro access', ok: true, details: ['no Pro paywall visible'] },
        { name: 'Soc replies persist after refresh', ok: false, details: ['response text missing after refresh'] },
      ],
      socResponses: ['What is the shape of the problem?'],
      artifacts: ['artifacts/pocket-socrates/pro/session.png'],
      styleFindings: [],
    });

    expect(markdown).toContain('# Pocket Socrates Pro regression smoke report');
    expect(markdown).toContain('Status: failed');
    expect(markdown).toContain('✅ Solo Pro access');
    expect(markdown).toContain('❌ Soc replies persist after refresh');
    expect(markdown).toContain('What is the shape');
    expect(markdown).toContain('session.png');
  });
});
