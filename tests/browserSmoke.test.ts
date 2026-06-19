import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadPackFromDir } from '../src/pack.js';
import { renderBrowserSmokeReport } from '../src/browserSmoke.js';

const packDir = fileURLToPath(new URL('../packs/pocket-socrates', import.meta.url));

describe('Pocket Socrates browser smoke checks', () => {
  it('loads browser smoke expectations from the pack', async () => {
    const pack = await loadPackFromDir(packDir);

    expect(pack.browserSmoke?.earlyAccess.path).toBe('/early-access');
    expect(pack.browserSmoke?.earlyAccess.requiredModalTexts).toEqual(
      expect.arrayContaining(['Before you continue', 'Accept & Continue']),
    );
    expect(pack.browserSmoke?.earlyAccess.requiredCheckboxCount).toBe(3);
  });

  it('renders browser smoke findings with artifact paths', () => {
    const markdown = renderBrowserSmokeReport('Pocket Socrates', {
      ok: false,
      checks: [
        { name: 'TOS modal appears', ok: true, details: ['Found modal text'] },
        { name: 'Blank invite validation', ok: false, details: ['No visible validation after blank submit'] },
      ],
      artifacts: ['artifacts/pocket-socrates/blank-submit.png'],
    });

    expect(markdown).toContain('# Pocket Socrates browser smoke report');
    expect(markdown).toContain('Summary: 1/2 passed');
    expect(markdown).toContain('❌ Blank invite validation');
    expect(markdown).toContain('artifacts/pocket-socrates/blank-submit.png');
  });
});
