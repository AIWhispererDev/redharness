import { describe, expect, it } from 'vitest';
import { chooseCompletionPrompt, renderCompletionSmokeReport } from '../src/completionSmoke.js';

describe('completion smoke checks', () => {
  it('chooses stage-aware prompts', () => {
    expect(chooseCompletionPrompt('SURFACE', 1)).toContain('pattern');
    expect(chooseCompletionPrompt('ROOT', 8)).toContain('root');
    expect(chooseCompletionPrompt('LANDING', 12)).toContain('next step');
  });

  it('renders stage timeline and artifacts', () => {
    const markdown = renderCompletionSmokeReport('Pocket Socrates', {
      ok: false,
      skipped: false,
      reachedLanding: false,
      checks: [
        { name: 'Reached Landing or max turns gracefully', ok: false, details: ['ended at ROOT'] },
      ],
      turns: [
        { index: 1, prompt: 'x', response: 'question', responseMs: 1000, stage: 'SURFACE', exchanges: 1 },
      ],
      artifacts: ['artifacts/completion/timeline.json'],
    });

    expect(markdown).toContain('# Pocket Socrates completion smoke report');
    expect(markdown).toContain('Status: failed');
    expect(markdown).toContain('Reached Landing: no');
    expect(markdown).toContain('SURFACE');
    expect(markdown).toContain('timeline.json');
  });
});
