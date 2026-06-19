import { describe, expect, it } from 'vitest';
import { renderRecordExportSmokeReport } from '../src/recordExportSmoke.js';

describe('Record/export smoke checks', () => {
  it('renders record and export checks with artifacts', () => {
    const markdown = renderRecordExportSmokeReport('Pocket Socrates', {
      ok: false,
      skipped: false,
      checks: [
        { name: 'Document/Records route opens', ok: true, details: ['url /document'] },
        { name: 'Export control is graceful', ok: false, details: ['button missing and no empty-state text'] },
      ],
      artifacts: ['artifacts/pocket-socrates/record-export/document.png'],
    });

    expect(markdown).toContain('# Pocket Socrates Record/export smoke report');
    expect(markdown).toContain('Status: failed');
    expect(markdown).toContain('✅ Document/Records route opens');
    expect(markdown).toContain('❌ Export control is graceful');
    expect(markdown).toContain('document.png');
  });
});
