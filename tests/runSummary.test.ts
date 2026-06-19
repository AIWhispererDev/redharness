import { describe, expect, it } from 'vitest';
import { renderRunSummary } from '../src/runSummary.js';

describe('run summary', () => {
  it('renders multiple smoke sections into one markdown summary', () => {
    const markdown = renderRunSummary('Pocket Socrates', [
      { name: 'public routes', ok: true, markdown: '# Public\npassed' },
      { name: 'crucible', ok: false, markdown: '# Crucible\nfailed' },
    ]);

    expect(markdown).toContain('# Pocket Socrates QA run summary');
    expect(markdown).toContain('Overall: failed');
    expect(markdown).toContain('✅ public routes');
    expect(markdown).toContain('❌ crucible');
    expect(markdown).toContain('# Public');
    expect(markdown).toContain('# Crucible');
  });
});
