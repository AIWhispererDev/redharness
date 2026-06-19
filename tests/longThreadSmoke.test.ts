import { describe, expect, it } from 'vitest';
import { extractStageSnapshot, renderLongThreadSmokeReport } from '../src/longThreadSmoke.js';

describe('long-thread smoke checks', () => {
  it('extracts visible Crucible stage state', () => {
    const text = 'ARIADNE’S THREAD\nSURFACE\nWhat you brought in\nBENEATH\nROOT\nLANDING\n3 EXCHANGES';
    expect(extractStageSnapshot(text)).toEqual({ stage: 'SURFACE', exchanges: 3 });
  });

  it('renders timing, stage snapshots, and artifacts', () => {
    const markdown = renderLongThreadSmokeReport('Pocket Socrates', {
      ok: false,
      skipped: false,
      checks: [
        { name: 'Turn 1 response', ok: true, details: ['first token 1200ms', 'response 80 chars'] },
        { name: 'No HTTP 5xx responses', ok: false, details: ['1 HTTP 5xx response(s) captured'] },
      ],
      turns: [
        { index: 1, prompt: 'hello', response: 'What are you avoiding?', responseMs: 1200, stage: 'SURFACE', exchanges: 1 },
      ],
      artifacts: ['artifacts/pocket-socrates/long-thread/turns.json'],
    });

    expect(markdown).toContain('# Pocket Socrates long-thread smoke report');
    expect(markdown).toContain('Status: failed');
    expect(markdown).toContain('Turn 1');
    expect(markdown).toContain('SURFACE');
    expect(markdown).toContain('turns.json');
  });
});
